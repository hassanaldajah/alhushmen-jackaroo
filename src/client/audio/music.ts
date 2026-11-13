import type { Net, NowPlaying, QueueItem } from '../net/types';

/** Official YouTube IFrame Player (youtube-nocookie). Visible card, only while a song is chosen. */
interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void; pauseVideo(): void; setVolume(v: number): void; destroy(): void;
}
interface YTApi { Player: new (el: HTMLElement, o: unknown) => YTPlayer }
declare global { interface Window { YT?: YTApi; onYouTubeIframeAPIReady?: () => void } }

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
let apiPromise: Promise<YTApi> | null = null;
function loadApi(): Promise<YTApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((res, rej) => {
    window.onYouTubeIframeAPIReady = () => res(window.YT!);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('yt'));
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class MusicPlayer {
  private player: YTPlayer | null = null;
  private current: QueueItem | null = null;
  private slot: HTMLElement;
  private mount: HTMLElement;
  volume = Number(localStorage.getItem('musicVol') ?? 60);
  private ducked = false;
  collapsed = false;
  onState: () => void = () => {};
  needsTap = false;
  /** Paused for everyone by someone (server state). */
  paused = false;
  error = false;

  constructor(private net: Net, private host: HTMLElement) {
    this.slot = host; this.mount = document.createElement('div');
    this.slot.appendChild(this.mount);
  }
  get item(): QueueItem | null { return this.current; }

  /** Called on every view update. */
  sync(queue: QueueItem[], np: NowPlaying | null): void {
    const item = np ? queue.find((q) => q.id === np.itemId) ?? null : null;
    if (!item || !VIDEO_ID_RE.test(item.videoId)) { this.stopAll(); return; }
    this.paused = !!np?.paused;
    if (this.current?.id === item.id) { if (this.paused) this.player?.pauseVideo(); else if (!this.collapsed) this.player?.playVideo(); this.onState(); return; }
    this.current = item; this.error = false; this.collapsed = false;
    const start = Math.max(0, Math.floor((Date.now() - np!.startedAt) / 1000));
    this.onState();
    loadApi().then((YT) => {
      if (this.current?.id !== item.id) return;
      if (this.player) { this.player.loadVideoById({ videoId: item.videoId, startSeconds: start }); return; }
      const div = document.createElement('div'); this.mount.replaceChildren(div);
      this.player = new YT.Player(div, {
        host: 'https://www.youtube-nocookie.com',
        width: 200, height: 200, videoId: item.videoId,
        playerVars: { autoplay: 1, start, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { this.player?.setVolume(this.eff()); if (this.paused) this.player?.pauseVideo(); else this.player?.playVideo(); },
          onStateChange: (e: { data: number }) => {
            if (e.data === 0 && this.current) {
              const id = this.current.id;
              this.net.send({ t: 'qEnded', itemId: id });
              // The server ignores "ended" within 5 s of start (anti-skip guard); a very short video re-reports once (L4).
              setTimeout(() => { if (this.current?.id === id) this.net.send({ t: 'qEnded', itemId: id }); }, 5_500);
            }
            if (e.data === -1 || e.data === 5) { this.needsTap = true; this.onState(); }
            if (e.data === 1) { this.needsTap = false; this.onState(); }
          },
          onError: () => {
            this.error = true; this.onState();
            const id = this.current?.id; // not embeddable: auto-skip after 3 s
            setTimeout(() => { if (id && this.current?.id === id) this.net.send({ t: 'qError', itemId: id }); }, 3000);
          },
        },
      });
    }).catch(() => { this.error = true; this.onState(); });
  }

  private stopAll(): void {
    this.current = null; this.player?.pauseVideo(); this.onState();
  }
  private eff(): number { return Math.round(this.volume * (this.ducked ? 0.35 : 1)); }
  setVolume(v: number): void { this.volume = v; localStorage.setItem('musicVol', String(v)); this.player?.setVolume(this.eff()); }
  duck(on: boolean): void { this.ducked = on; this.player?.setVolume(this.eff()); }
  setCollapsed(c: boolean): void {
    this.collapsed = c;
    if (c) this.player?.pauseVideo(); else this.player?.playVideo(); // collapse = pause
    this.onState();
  }
  play(): void { this.player?.playVideo(); }
}
