import type { Net } from '../net/types';

export type MicState = 'muted' | 'live' | 'connecting' | 'denied' | 'unavailable' | 'listen';
export type PeerStatus = 'connecting' | 'connected' | 'failed';
export interface PeerInfo { id: string; status: PeerStatus; speaking: boolean; remoteMuted: boolean; failed: boolean; quality: 'good' | 'fair' | 'poor'; volume: number; localMuted: boolean }

/** ICE servers (TURN credentials live 1 h) are refetched when older than this. */
export const ICE_MAX_AGE_MS = 30 * 60_000;
/** Automatic ICE restarts after 'failed' before the user's retry button is the only way. */
const AUTO_RETRIES = 2;

interface Link { pc: RTCPeerConnection; audio: HTMLAudioElement; polite: boolean; analyser?: AnalyserNode; failed: boolean; makingOffer: boolean; ignoreOffer: boolean }

/** Audio-only full mesh. Signalling goes through the room socket (net.send({t:'signal'})). */
export class VoiceMesh {
  micState: MicState = 'listen';
  readonly peers = new Map<string, PeerInfo>();
  onChange: () => void = () => {};
  onSpeaking: (anyone: boolean) => void = () => {};
  private links = new Map<string, Link>();
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private ice: RTCIceServer[] = [];
  private ctx: AudioContext | null = null;
  private selfId = '';
  private poll = 0;
  private selfAnalyser: AnalyserNode | null = null;
  selfSpeaking = false;

  constructor(private net: Net) {
    net.on('signal', (s) => void this.onSignal(s.from, s.data as Signal));
  }

  async start(selfId: string): Promise<void> {
    this.selfId = selfId;
    this.ice = await this.net.iceServers();
    this.iceAt = Date.now();
    this.poll = window.setInterval(() => this.sample(), 100);
  }
  /** Id this mesh was started with ('' when stopped). */
  get id(): string { return this.selfId; }

  /** TURN credentials expire after 1 h: fetch fresh ICE servers when the cached ones are older than 30 min. */
  private iceAt = 0;
  private iceJob: Promise<void> | null = null;
  refreshIce(now = Date.now()): Promise<void> {
    if (now - this.iceAt < ICE_MAX_AGE_MS) return Promise.resolve();
    this.iceJob ??= this.net.iceServers().then((ice) => {
      this.ice = ice; this.iceAt = Date.now();
      for (const l of this.links.values()) { try { l.pc.setConfiguration({ ...l.pc.getConfiguration(), iceServers: ice }); } catch { /* closed */ } }
    }).catch(() => { /* keep the old list */ }).finally(() => { this.iceJob = null; });
    return this.iceJob;
  }

  /** Last time this mesh sent signalling (server 'rate' errors right after are voice traffic, not the user). */
  lastSignalAt = 0;
  /** Automatic ICE restarts per peer since its last good connection. */
  private autoRetries = new Map<string, number>();

  /** Reconcile links with the people currently in the room. */
  setRoster(ids: string[]): void {
    if (!this.selfId) return;
    const others = ids.filter((i) => i !== this.selfId).slice(0, 7);
    for (const id of others) if (!this.links.has(id)) this.open(id);
    for (const id of [...this.links.keys()]) if (!others.includes(id)) this.close(id);
    this.onChange();
  }

  /** Ask for the mic after a user tap. Never called on load. */
  async enableMic(): Promise<void> {
    if (this.stream) { this.setMuted(false); return; }
    this.micState = 'connecting'; this.onChange();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch { this.micState = 'denied'; this.onChange(); return; }
    this.track = this.stream.getAudioTracks()[0] ?? null;
    if (!this.track) { this.micState = 'unavailable'; this.onChange(); return; }
    try {
      this.ensureCtx();
      this.selfAnalyser = this.ctx!.createAnalyser(); this.selfAnalyser.fftSize = 512;
      this.ctx!.createMediaStreamSource(this.stream).connect(this.selfAnalyser);
    } catch { this.selfAnalyser = null; /* level meter only; the mic still works */ }
    // A throw here must never leave the mic stuck on 'connecting'.
    for (const l of this.links.values()) await this.attach(l.pc);
    this.setMuted(false);
  }

  /** Put the own mic track on the link's audio transceiver (if it has one yet). Never throws. */
  private async attach(pc: RTCPeerConnection): Promise<void> {
    if (!this.track) return;
    try { await pc.getTransceivers()[0]?.sender.replaceTrack(this.track); } catch { /* link closing or not ready: ontrack retries */ }
  }

  setMuted(m: boolean): void {
    if (!this.track) return;
    this.track.enabled = !m;
    this.micState = m ? 'muted' : 'live';
    this.onChange();
  }
  toggle(): void { if (this.micState === 'live') this.setMuted(true); else if (this.micState === 'muted') this.setMuted(false); else void this.enableMic(); }

  setPeerVolume(id: string, v: number): void { const l = this.links.get(id); const p = this.peers.get(id); if (l && p) { p.volume = v; l.audio.volume = p.localMuted ? 0 : v / 100; this.onChange(); } }
  setPeerMuted(id: string, m: boolean): void { const l = this.links.get(id); const p = this.peers.get(id); if (l && p) { p.localMuted = m; l.audio.volume = m ? 0 : p.volume / 100; this.onChange(); } }
  /** Retry a failed link: ICE restart first; if it does not recover in 6 s, rebuild the connection. */
  retry(id: string): void {
    const l = this.links.get(id); const p = this.peers.get(id);
    if (!l || !p) { this.open(id); this.onChange(); return; }
    p.status = 'connecting'; p.failed = false; l.failed = false;
    void this.refreshIce().then(() => {
      if (this.links.get(id) !== l) return;
      try { l.pc.restartIce(); } catch { this.close(id); this.open(id); this.onChange(); }
    });
    window.setTimeout(() => {
      const q = this.peers.get(id);
      if (q && q.status !== 'connected' && this.links.get(id) === l) { this.close(id); this.open(id); this.onChange(); }
    }, 6000);
    this.onChange();
  }
  /** True when at least one other person is in the room but no voice link is connected yet. */
  get noneConnected(): boolean { return this.peers.size > 0 && ![...this.peers.values()].some((p) => p.status === 'connected'); }

  /** Browsers block audio without a recent tap; remember that and retry on the next tap. */
  blocked = false;
  onBlocked: (b: boolean) => void = () => {};
  private playAudio(a: HTMLAudioElement): void {
    a.play().then(() => { if (this.blocked) { this.blocked = [...this.links.values()].some((l) => l.audio.paused && l.audio.srcObject); this.onBlocked(this.blocked); } })
      .catch(() => { this.blocked = true; this.onBlocked(true); });
  }
  /** Call on any user tap: resumes the audio context and plays every remote stream. */
  unlock(): void {
    if (this.ctx) void this.ctx.resume();
    for (const l of this.links.values()) if (l.audio.srcObject && l.audio.paused) this.playAudio(l.audio);
  }

  private ensureCtx(): void { this.ctx ??= new AudioContext(); void this.ctx.resume(); }

  private open(id: string): void {
    void this.refreshIce(); // stale TURN credentials: new list is applied to this link too when it arrives
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const audio = new Audio(); audio.autoplay = true; audio.setAttribute('playsinline', '');
    audio.style.display = 'none'; document.body.append(audio); // iOS plays remote streams more reliably when attached
    const link: Link = { pc, audio, polite: this.selfId > id, failed: false, makingOffer: false, ignoreOffer: false };
    this.links.set(id, link);
    this.peers.set(id, { id, status: 'connecting', speaking: false, remoteMuted: false, failed: false, quality: 'good', volume: 100, localMuted: false });
    // Only the impolite side creates the audio transceiver (and so sends the first offer); both sides adding
    // one caused offer glare. The polite side gets its transceiver from that offer (see ontrack).
    if (!link.polite) {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (this.track) void tr.sender.replaceTrack(this.track).catch(() => {});
    }
    // Opus + DTX
    pc.onicecandidate = (e) => { if (e.candidate) this.sig(id, { c: e.candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try { link.makingOffer = true; await pc.setLocalDescription(); this.sig(id, { d: pc.localDescription!.toJSON() }); }
      catch { /* retried via button */ } finally { link.makingOffer = false; }
    };
    pc.ontrack = (e) => {
      if (link.polite && e.transceiver) {
        try { e.transceiver.direction = 'sendrecv'; } catch { /* closed */ }
        if (this.track) void e.transceiver.sender.replaceTrack(this.track).catch(() => {});
      }
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      this.playAudio(audio);
      this.ensureCtx();
      link.analyser = this.ctx!.createAnalyser(); link.analyser.fftSize = 512;
      this.ctx!.createMediaStreamSource(audio.srcObject as MediaStream).connect(link.analyser);
      e.track.onmute = () => { const p = this.peers.get(id); if (p) { p.remoteMuted = true; this.onChange(); } };
    };
    pc.onconnectionstatechange = () => {
      const p = this.peers.get(id); if (!p) return;
      link.failed = pc.connectionState === 'failed';
      p.failed = link.failed;
      p.status = pc.connectionState === 'connected' ? 'connected' : link.failed ? 'failed' : 'connecting';
      p.quality = pc.connectionState === 'connected' ? 'good' : pc.connectionState === 'failed' ? 'poor' : 'fair';
      if (pc.connectionState === 'connected') this.autoRetries.delete(id);
      // Failed: restart ICE automatically (retry() rebuilds the link if that does not recover). Bounded.
      if (link.failed) {
        const n = this.autoRetries.get(id) ?? 0;
        if (n < AUTO_RETRIES) { this.autoRetries.set(id, n + 1); this.retry(id); return; }
      }
      this.onChange();
    };
  }

  private close(id: string): void {
    const l = this.links.get(id); if (!l) return;
    l.pc.close(); l.audio.srcObject = null; l.audio.remove();
    this.links.delete(id); this.peers.delete(id);
  }

  private sig(to: string, data: Signal): void { this.lastSignalAt = Date.now(); this.net.send({ t: 'signal', to, data }); }

  private async onSignal(from: string, s: Signal): Promise<void> {
    if (!s || typeof s !== 'object') return;
    if (!this.links.has(from)) this.open(from);
    const l = this.links.get(from)!;
    try {
      if (s.d) {
        const collision = s.d.type === 'offer' && (l.makingOffer || l.pc.signalingState !== 'stable');
        l.ignoreOffer = !l.polite && collision;
        if (l.ignoreOffer) return;
        await l.pc.setRemoteDescription(s.d);
        if (s.d.type === 'offer') { await l.pc.setLocalDescription(); this.sig(from, { d: l.pc.localDescription!.toJSON() }); }
      } else if (s.c) {
        try { await l.pc.addIceCandidate(s.c); } catch (e) { if (!l.ignoreOffer) throw e; }
      }
    } catch { l.failed = true; const p = this.peers.get(from); if (p) { p.failed = true; p.status = 'failed'; } this.onChange(); }
  }

  private level(a: AnalyserNode): number {
    const buf = new Float32Array(a.fftSize); a.getFloatTimeDomainData(buf);
    let s = 0; for (const x of buf) s += x * x;
    return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
  }
  private sample(): void {
    let changed = false, any = false;
    for (const [id, l] of this.links) {
      const p = this.peers.get(id); if (!p || !l.analyser) continue;
      const sp = this.level(l.analyser) > -50 && !p.localMuted;
      if (sp !== p.speaking) { p.speaking = sp; changed = true; }
      any ||= sp;
    }
    if (this.selfAnalyser && this.micState === 'live') {
      const sp = this.level(this.selfAnalyser) > -50;
      if (sp !== this.selfSpeaking) { this.selfSpeaking = sp; changed = true; }
      any ||= sp;
    } else if (this.selfSpeaking) { this.selfSpeaking = false; changed = true; }
    this.onSpeaking(any);
    if (changed) this.onChange();
  }

  /** Hang up everything and release the mic (logout). start() can be called again afterwards. */
  stop(): void {
    clearInterval(this.poll); this.poll = 0;
    for (const id of [...this.links.keys()]) this.close(id);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.selfAnalyser = null;
    this.peers.clear(); this.autoRetries.clear();
    this.selfId = ''; this.selfSpeaking = false; this.micState = 'listen';
    this.onSpeaking(false);
    this.onChange();
  }
}

interface Signal { d?: RTCSessionDescriptionInit; c?: RTCIceCandidateInit }
