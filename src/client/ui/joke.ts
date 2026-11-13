import { h } from './dom';
import { T } from './ar';
import { jokeAt } from './jokes-ar';
import { reducedMotion } from './tokens';

export const jokesEnabled = (): boolean => localStorage.getItem('jokes') !== '0';
export const setJokesEnabled = (on: boolean): void => localStorage.setItem('jokes', on ? '1' : '0');

/** Dealer speech bubble (docs/design.md 16.6). Text comes only from the fixed local list, via textContent. */
export class JokeBubble {
  private el: HTMLElement | null = null;
  private timer = 0;
  constructor(private host: HTMLElement, private anchor: (seat: number) => { x: number; y: number } | null) {}

  show(seat: number, index: number): void {
    const text = jokeAt(index);
    if (!text || !jokesEnabled()) return;
    this.hide();
    const live = h('span', { role: 'status', 'aria-live': 'polite' }, text);
    const el = h('div', { class: 'joke' + (reducedMotion() ? ' rm' : ''), onpointerdown: (e: Event) => { e.stopPropagation(); this.hide(); } },
      h('span', { class: 'joke-tag' }, T.joke), live, h('span', { class: 'joke-tail', 'aria-hidden': 'true' }));
    this.host.append(el);
    const a = this.anchor(seat);
    const w = this.host.clientWidth, bw = Math.min(240, w - 16);
    const x = Math.min(Math.max(8 + bw / 2, a?.x ?? w / 2), w - 8 - bw / 2);
    el.style.width = bw + 'px';
    el.style.left = x + 'px';
    el.style.top = Math.max(4, (a?.y ?? 48) - 8) + 'px';
    this.el = el;
    this.timer = window.setTimeout(() => this.hide(), text.length > 90 ? 7000 : 5000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.el?.remove(); this.el = null;
  }
}
