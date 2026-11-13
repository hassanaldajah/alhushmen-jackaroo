import { MusicPlayer } from '../audio/music';
import type { Net, RoomView } from '../net/types';
import { h, icon, clear } from './dom';
import { T } from './ar';
import { iconButton, button } from './widgets';

/** Draggable 200x200 player card. Exists only while a song is chosen/playing. */
export class MusicCard {
  private el: HTMLElement;
  private yt = h('div', { class: 'yt' });
  private bar = h('div', { class: 'bar' });
  private extra = h('div', { style: { padding: 'var(--sp-2)' } });
  readonly player: MusicPlayer;
  private pos: { x: number; y: number } | null = null;
  private v: RoomView | null = null;

  constructor(private net: Net, private parent: HTMLElement) {
    this.el = h('div', { class: 'mcard', hidden: true, role: 'region', 'aria-label': T.music }, this.bar, this.yt, this.extra);
    parent.append(this.el);
    this.player = new MusicPlayer(net, this.yt);
    this.player.onState = () => this.draw();
    this.drag();
    addEventListener('resize', () => this.place());
  }

  update(v: RoomView): void {
    this.v = v;
    this.player.sync(v.queue, v.nowPlaying);
    this.draw();
  }

  private draw(): void {
    const it = this.player.item;
    this.el.hidden = !it;           // only after a song is chosen
    if (!it) return;
    this.el.classList.toggle('collapsed', this.player.collapsed);
    clear(this.bar,
      h('span', { class: 'grip', 'aria-hidden': 'true' }),
      h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 't', title: it.title }, this.player.error ? T.songFail : it.title),
      // No-collision rule: anyone (player or spectator) can pause, skip or stop; the server applies the last action.
      iconButton(this.player.paused ? 'play' : 'pause', this.player.paused ? T.songResume : T.songPause, () => this.net.send({ t: 'qPause', paused: !this.player.paused })),
      iconButton('next', T.songSkip, () => this.net.send({ t: 'qSkip', itemId: it.id }), 'mirror'),
      iconButton('close', T.songStop, () => this.net.send({ t: 'qStop' })),
      iconButton('chevron', this.player.collapsed ? T.expand : T.collapse, () => this.player.setCollapsed(!this.player.collapsed), this.player.collapsed ? '' : 'mirror'));
    clear(this.extra);
    if (!this.player.collapsed) {
      const r = h('input', { type: 'range', min: '0', max: '100', class: 'range', 'aria-label': T.volume }) as HTMLInputElement;
      r.value = String(this.player.volume);
      r.addEventListener('input', () => this.player.setVolume(Number(r.value)));
      this.extra.append(r);
      this.yt.querySelector('.tapplay')?.remove();
      if (this.player.needsTap) this.yt.append(h('div', { class: 'tapplay' }, button(T.songTap, 'btn-primary', () => { this.player.play(); }, 'play')));
    }
    this.place();
  }

  /** Auto-place top-right under the status bar (the left side holds the rail and the dock); user drag overrides. */
  private place(): void {
    if (this.el.hidden) return;
    const cs = getComputedStyle(document.documentElement);
    const px = (n: string) => parseFloat(cs.getPropertyValue(n)) || 0;
    const w = this.el.offsetWidth || 200, hh = this.el.offsetHeight || 290;
    const sb = px('--status-h'), hb = px('--hand-h'), gap = px('--sp-2'), bar = px('--tap') + px('--sp-3') * 2; // confirm bar height
    const minY = sb + gap, maxY = Math.max(minY, innerHeight - hb - bar - hh - gap);
    const p = this.pos ?? { x: innerWidth - w - gap, y: minY + gap };
    const x = Math.min(Math.max(0, p.x), innerWidth - w), y = Math.min(Math.max(minY, p.y), maxY);
    this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
  }

  private drag(): void {
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false, lt = 0, ly = 0, vy = 0;
    this.bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      on = true; sx = e.clientX; sy = e.clientY; ox = this.el.offsetLeft; oy = this.el.offsetTop; this.bar.setPointerCapture(e.pointerId);
      lt = performance.now(); ly = e.clientY; vy = 0; this.el.classList.add('dragging');
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!on) return;
      const now = performance.now();
      if (now - lt > 40) { vy = (e.clientY - ly) / (now - lt); lt = now; ly = e.clientY; }
      this.pos = { x: ox + e.clientX - sx, y: oy + e.clientY - sy }; this.place();
    });
    const end = () => { on = false; this.el.classList.remove('dragging'); };
    // A quick downward flick tucks the card away (collapses it, local only); it never stops the room's music.
    this.bar.addEventListener('pointerup', () => { const flick = on && vy > 0.8 && !this.player.collapsed; end(); if (flick) this.player.setCollapsed(true); }); this.bar.addEventListener('pointercancel', end);
    this.bar.addEventListener('keydown', (e) => { // keyboard drag alternative
      const d = 16; const p = this.pos ?? { x: this.el.offsetLeft, y: this.el.offsetTop };
      if (e.key === 'ArrowLeft') p.x -= d; else if (e.key === 'ArrowRight') p.x += d; else if (e.key === 'ArrowUp') p.y -= d; else if (e.key === 'ArrowDown') p.y += d; else return;
      this.pos = p; this.place(); e.preventDefault();
    });
    this.bar.tabIndex = 0;
  }
}
export { icon };
