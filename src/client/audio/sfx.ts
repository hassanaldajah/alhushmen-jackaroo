/** Procedural Web Audio sound effects. No samples, no copyrighted audio. */
export type SfxName = 'shuffle' | 'flick' | 'throw' | 'hop' | 'capture' | 'tick';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = Number(localStorage.getItem('sfxVol') ?? 0.7);
  muted = localStorage.getItem('sfxMute') === '1';
  private ducked = false;

  /** Call from the first user gesture (autoplay policy). */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      const n = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.apply();
    }
    void this.ctx.resume();
  }
  get ready(): boolean { return !!this.ctx; }
  setVolume(v: number): void { this.volume = v; localStorage.setItem('sfxVol', String(v)); this.apply(); }
  setMuted(m: boolean): void { this.muted = m; localStorage.setItem('sfxMute', m ? '1' : '0'); this.apply(); }
  /** Lower effects while someone speaks. */
  duck(on: boolean): void { this.ducked = on; this.apply(); }
  private apply(): void {
    if (!this.ctx || !this.master) return;
    const g = this.muted ? 0 : this.volume * (this.ducked ? 0.35 : 1);
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08);
  }

  private burst(t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number): void {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  private tone(t: number, dur: number, f0: number, f1: number, peak: number, type: OscillatorType = 'sine'): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t); o.stop(t + dur + 0.02);
  }

  play(name: SfxName): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case 'shuffle': // riffle: many short band-passed ticks
        for (let i = 0; i < 18; i++) this.burst(t + i * 0.045 + Math.random() * 0.02, 0.05, 'bandpass', 3000 + Math.random() * 1500, 1800, 1.2, 0.35);
        break;
      case 'flick': this.burst(t, 0.09, 'highpass', 4500, 1500, 0.7, 0.4); break;
      case 'throw': this.burst(t, 0.12, 'bandpass', 2200, 700, 0.9, 0.55); this.tone(t, 0.07, 160, 90, 0.25); break;
      case 'hop': this.tone(t, 0.07, 520, 330, 0.35); this.burst(t, 0.03, 'bandpass', 1800, 1800, 2, 0.15); break;
      case 'capture':
        this.tone(t, 0.18, 700, 180, 0.4, 'triangle');
        this.burst(t, 0.22, 'lowpass', 3500, 400, 0.7, 0.5);
        break;
      case 'tick': this.tone(t, 0.04, 900, 900, 0.15); break;
    }
  }

  /** Deal sequence: one flick per card. */
  deal(cards: number, stagger = 0.09): void {
    for (let i = 0; i < cards; i++) setTimeout(() => this.play('flick'), i * stagger * 1000);
  }
}

export const sfx = new Sfx();
