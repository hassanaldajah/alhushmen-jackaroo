import { h } from './dom';
import { T } from './ar';
import { JOKE_COUNT } from '../../shared/protocol';
import { jokeAt } from './jokes-ar';
import { reducedMotion } from './tokens';

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const jokesEnabled = (): boolean => store.get('jokes') !== '0';
export const setJokesEnabled = (on: boolean): void => store.set('jokes', on ? '1' : '0');
/** Silence filler ("نكت تلقائية"), on by default. */
export const autoJokesEnabled = (): boolean => store.get('autoJokes') !== '0';
export const setAutoJokesEnabled = (on: boolean): void => store.set('autoJokes', on ? '1' : '0');

/** Shuffle-bag over the JOKE_COUNT jokes: random order, no repeat until all were told. */
export class JokeBag {
  private bag: number[] = [];
  private last = -1;
  constructor(private rnd: () => number = Math.random, private n = JOKE_COUNT) {}
  next(): number {
    if (!this.bag.length) {
      this.bag = Array.from({ length: this.n }, (_, i) => i);
      for (let i = this.bag.length - 1; i > 0; i--) { const j = Math.floor(this.rnd() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j]!, this.bag[i]!]; }
      // never the same joke twice in a row across a refill
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1]!, this.bag[0]!];
    }
    this.last = this.bag.pop()!;
    return this.last;
  }
}

export type Anchor = () => { x: number; y: number } | null;

/** Speech bubble (docs/design.md 16.6). Text comes only from fixed local strings, via textContent. Tap dismisses. */
export class JokeBubble {
  private el: HTMLElement | null = null;
  private timer = 0;
  private place: (() => void) | null = null;
  onHide: () => void = () => {};
  constructor(private host: HTMLElement, private anchor: (seat: number) => { x: number; y: number } | null) {}

  get visible(): boolean { return !!this.el; }

  /** Dealer cue from the server: the dealer's avatar reads it. */
  show(seat: number, index: number): void {
    const text = jokeAt(index);
    if (!text || !jokesEnabled()) return;
    this.say(text, () => this.anchor(seat), { tag: T.joke });
  }

  /** Generic bubble at an anchor (the pirate's head, or the screen top when there is no 3D table). */
  say(text: string, anchor: Anchor, o: { tag?: string; ms?: number; onDone?: () => void } = {}): void {
    this.hide();
    const live = h('span', { role: 'status', 'aria-live': 'polite' }, text);
    const el = h('div', { class: 'joke' + (reducedMotion() ? ' rm' : ''), onpointerdown: (e: Event) => { e.stopPropagation(); this.hide(); } },
      o.tag ? h('span', { class: 'joke-tag' }, o.tag) : null, live, h('span', { class: 'joke-tail', 'aria-hidden': 'true' }));
    this.host.append(el);
    const place = () => {
      const a = anchor();
      const w = this.host.clientWidth, hh = this.host.clientHeight;
      let bw = Math.min(260, w - 24);
      el.style.width = bw + 'px';
      const bh = el.offsetHeight || 60;
      el.classList.remove('below', 'side-l', 'side-r');
      if (a && a.y - 10 - bh < 6) {
        // No room above the speaker (he stands right under the top bar on phones): talk from the side.
        const left = a.x > w / 2, room = left ? a.x - 28 - 8 : w - a.x - 28 - 8;
        if (room >= 150) {
          bw = Math.min(bw, room); el.style.width = bw + 'px';
          el.classList.add(left ? 'side-l' : 'side-r');
          el.style.left = (left ? a.x - 28 : a.x + 28) + 'px';
          el.style.top = Math.min(hh - 8 - (el.offsetHeight || bh) / 2, Math.max(6 + (el.offsetHeight || bh) / 2, a.y + 40)) + 'px';
          return;
        }
        el.classList.add('below'); // last resort: under the anchor, tail on top
        el.style.left = Math.min(Math.max(12 + bw / 2, a.x), w - 12 - bw / 2) + 'px';
        el.style.top = Math.min(hh - 8, a.y + 18 + bh) + 'px';
        return;
      }
      const x = Math.min(Math.max(12 + bw / 2, a?.x ?? w / 2), w - 12 - bw / 2);
      el.style.left = x + 'px';
      el.style.top = Math.max(bh + 6, (a?.y ?? 76 + bh) - 10) + 'px';
    };
    place();
    this.el = el; this.place = place;
    const ms = o.ms ?? (text.length > 90 ? 7000 : 5000);
    this.timer = window.setTimeout(() => { this.hide(); o.onDone?.(); }, ms);
  }

  /** Follow the anchor while the camera moves. */
  reposition(): void { this.place?.(); }

  hide(): void {
    clearTimeout(this.timer);
    if (this.el) { this.el.remove(); this.el = null; this.place = null; this.onHide(); }
  }
}
