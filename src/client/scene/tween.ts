export type Ease = (t: number) => number;
export const easeOut: Ease = (t) => 1 - Math.pow(1 - t, 4);
export const easeInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const linear: Ease = (t) => t;

interface T { start: number; dur: number; ease: Ease; update: (t: number) => void; done: () => void }

export class Tweens {
  private list: T[] = [];
  constructor(private onAdd: () => void) {}
  get active(): boolean { return this.list.length > 0; }

  add(dur: number, update: (t: number) => void, o: { delay?: number; ease?: Ease } = {}): Promise<void> {
    return new Promise<void>((resolve) => {
      if (dur <= 0 && !o.delay) { update(1); resolve(); return; }
      this.list.push({ start: performance.now() + (o.delay ?? 0), dur: Math.max(1, dur), ease: o.ease ?? easeOut, update, done: resolve });
      this.onAdd();
    });
  }

  /** Advance; returns true while tweens remain. */
  step(now: number): boolean {
    const cur = this.list;
    this.list = [];
    const keep: T[] = [];
    for (const t of cur) {
      if (now < t.start) { keep.push(t); continue; }
      const k = Math.min(1, (now - t.start) / t.dur);
      t.update(t.ease(k));
      if (k >= 1) t.done(); else keep.push(t);
    }
    // tweens added during update() landed in this.list
    this.list = keep.concat(this.list);
    return this.list.length > 0;
  }

  /** Complete everything instantly (skip). */
  finishAll(): void {
    const cur = this.list.slice().sort((a, b) => a.start - b.start);
    this.list = [];
    for (const t of cur) { t.update(1); t.done(); }
  }
}
