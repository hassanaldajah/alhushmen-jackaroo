import './intro.css';
import { h } from './dom';
import { T } from './ar';
import { tokens, reducedMotion } from './tokens';

/** Game name exactly as the user spelled it: damma (U+064F) on the first letter of الحشمين. Single source. */
const GAME_NAME_AR = 'جاكارو الحُشمين';
const SEEN = 'intro-seen';
const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function mark(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 100 100', class: 'intro-mark', 'aria-hidden': 'true' });
  s.append(svg('circle', { class: 'intro-ring', cx: '50', cy: '50', r: '46', pathLength: '100' }));
  s.append(svg('path', { class: 'intro-star', d: 'M50 12 L60 40 L88 50 L60 60 L50 88 L40 60 L12 50 L40 40 Z' }));
  s.append(svg('circle', { class: 'intro-dot', cx: '50', cy: '50', r: '5' }));
  const cols = [tokens.teamA, tokens.teamB, tokens.marblesA[1], tokens.marblesB[1]];
  const tips: Array<[number, number, number, number]> = [[50, 12, -70, -70], [88, 50, 70, -70], [50, 88, 70, 70], [12, 50, -70, 70]];
  tips.forEach(([x, y, sx, sy], i) => {
    const g = svg('g', { class: 'intro-ball' });
    g.style.setProperty('--sx', `${sx}px`); g.style.setProperty('--sy', `${sy}px`); g.style.setProperty('--d', `${900 + i * 60}ms`); // CSSOM, CSP-safe
    g.append(svg('circle', { cx: String(x), cy: String(y), r: '6', fill: cols[i]! }));
    s.append(g);
  });
  return s;
}

/** Repeat visitors skip the logo for a week (it was replaying on every new tab and slowed the start). */
const REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
function seenRecently(): boolean {
  try {
    if (sessionStorage.getItem(SEEN)) return true;
    const t = Number(localStorage.getItem(SEEN) ?? 0);
    return t > 0 && Date.now() - t < REPLAY_MS;
  } catch { return false; }
}

/**
 * Animated logo intro (docs/design.md section 15). Plays on the first visit (then once a week), before the
 * passphrase screen. Tap / Enter / Space / Esc skips. Calls done() exactly once.
 */
export function playIntro(root: HTMLElement, done: () => void): void {
  if (seenRecently()) { done(); return; }
  const rm = reducedMotion();
  const el = h('div', { class: 'intro' + (rm ? ' rm' : ''), role: 'img', 'aria-label': GAME_NAME_AR, tabindex: '0' },
    mark(),
    h('div', { class: 'intro-word', 'aria-hidden': 'true' }, h('span', null, GAME_NAME_AR)),
    h('div', { class: 'intro-line', 'aria-hidden': 'true' }, h('i')),
    h('div', { class: 'intro-skip' }, T.introSkip));
  root.replaceChildren(el);
  el.focus({ preventScroll: true });

  let finished = false;
  let timer = 0;
  const finish = (quick: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    removeEventListener('keydown', onKey);
    try { sessionStorage.setItem(SEEN, '1'); localStorage.setItem(SEEN, String(Date.now())); } catch { /* private mode */ }
    el.classList.add('out');
    if (quick) el.classList.add('quick');
    window.setTimeout(done, rm || quick ? 150 : 250);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); finish(true); } };
  el.addEventListener('pointerdown', () => finish(true));
  addEventListener('keydown', onKey);
  timer = window.setTimeout(() => finish(false), rm ? 900 : 2700);
}
