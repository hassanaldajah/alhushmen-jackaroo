/**
 * Swipe-to-dismiss. The element follows the finger 1:1 with a transform (no rAF loop, no frame cap, so it
 * runs at the display rate, 120 Hz on ProMotion). Release past 25% of the element size, or a quick flick,
 * dismisses; otherwise it springs back. Animations are CSS transitions (time-based).
 *
 * Start zones: `grips` (pointer events; their CSS sets touch-action: none) and, with `body`, anywhere in the
 * element via touch events, but only when no scrollable ancestor is scrolled away from its start, so content
 * scrolling never fights the gesture.
 */
export interface SwipeOpts {
  axis: () => 'x' | 'y';
  /** +1 = only toward positive (down / right), -1 = only negative, 0 = both directions. */
  sign: () => 1 | -1 | 0;
  onDismiss: () => void;
  onProgress?: (p: number) => void;
  body?: boolean;
}

const SLOP = 8, RATIO = 0.25, FLICK = 0.5; // px, fraction of size, px per ms

export function motionReduced(): boolean {
  const d = document.documentElement.dataset.motion;
  return d === 'reduce' || (d !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function scrolledAway(from: Element | null, stop: HTMLElement, axis: 'x' | 'y'): boolean {
  for (let n = from; n; n = n.parentElement) {
    if (n instanceof HTMLElement) {
      const sc = axis === 'y' ? n.scrollTop : Math.abs(n.scrollLeft);
      const big = axis === 'y' ? n.scrollHeight > n.clientHeight + 1 : n.scrollWidth > n.clientWidth + 1;
      if (big && sc > 0) return true;
    }
    if (n === stop) break;
  }
  return false;
}

export function swipeDismiss(el: HTMLElement, grips: HTMLElement[], o: SwipeOpts): void {
  let st: { x: number; y: number; axis: 'x' | 'y'; sign: 1 | -1 | 0; size: number; locked: boolean; d: number; v: number; lt: number; ld: number } | null = null;
  let busy = false;

  const begin = (x: number, y: number): void => {
    if (busy) return;
    const axis = o.axis();
    st = { x, y, axis, sign: o.sign(), size: Math.max(1, axis === 'y' ? el.offsetHeight : el.offsetWidth), locked: false, d: 0, v: 0, lt: performance.now(), ld: 0 };
  };
  const apply = (d: number): void => {
    if (!st) return;
    el.style.transform = st.axis === 'y' ? `translate3d(0,${d}px,0)` : `translate3d(${d}px,0,0)`;
    const p = Math.min(1, Math.abs(d) / st.size);
    if (st.sign === 0) el.style.opacity = String(1 - p * 0.8);
    o.onProgress?.(p);
  };
  /** Returns true when the gesture is (now) a drag. */
  const move = (x: number, y: number): boolean => {
    if (!st) return false;
    const dx = x - st.x, dy = y - st.y;
    const main = st.axis === 'y' ? dy : dx, cross = st.axis === 'y' ? dx : dy;
    if (!st.locked) {
      if (Math.abs(cross) > SLOP && Math.abs(cross) > Math.abs(main)) { st = null; return false; }
      if (Math.abs(main) < SLOP) return false;
      if (st.sign !== 0 && main * st.sign < 0) { st = null; return false; }
      st.locked = true;
      el.style.transition = 'none'; el.style.willChange = 'transform';
    }
    const d = st.sign !== 0 && main * st.sign < 0 ? 0 : main;
    const now = performance.now();
    if (now - st.lt > 40) { st.v = (d - st.ld) / (now - st.lt); st.lt = now; st.ld = d; }
    st.d = d; apply(d);
    return true;
  };
  const settle = (dismiss: boolean): void => {
    if (!st) return;
    const s = st; st = null; busy = true;
    const calm = motionReduced();
    const dir = s.sign !== 0 ? s.sign : (s.d < 0 ? -1 : 1);
    const fin = (): void => {
      el.style.transition = ''; el.style.willChange = '';
      if (dismiss) { o.onDismiss(); } else { el.style.transform = ''; el.style.opacity = ''; o.onProgress?.(0); }
      busy = false;
    };
    if (calm) { fin(); return; }
    el.style.transition = 'transform var(--t-med) var(--ease-out), opacity var(--t-med) var(--ease-out)';
    const to = dismiss ? dir * s.size : 0;
    el.style.transform = s.axis === 'y' ? `translate3d(0,${to}px,0)` : `translate3d(${to}px,0,0)`;
    if (dismiss) { el.style.opacity = s.sign === 0 ? '0' : ''; o.onProgress?.(1); } else { el.style.opacity = ''; o.onProgress?.(0); }
    let called = false;
    const once = (): void => { if (!called) { called = true; fin(); } };
    el.addEventListener('transitionend', (e) => { if (e.target === el && e.propertyName === 'transform') once(); }, { once: true });
    window.setTimeout(once, 450);
  };
  const end = (cancel: boolean): void => {
    if (!st) return;
    if (!st.locked) { st = null; return; }
    const away = st.d * (st.sign || (st.d < 0 ? -1 : 1));
    const flick = st.v * (st.sign || (st.d < 0 ? -1 : 1)) > FLICK;
    settle(!cancel && (away > st.size * RATIO || (flick && away > 12)));
  };

  // Pointer events on grips (handle, header, toast itself, mouse included).
  for (const g of grips) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || (e.target as HTMLElement).closest('button,input,a')) return;
      begin(e.clientX, e.clientY);
      try { g.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    g.addEventListener('pointermove', (e) => { move(e.clientX, e.clientY); });
    g.addEventListener('pointerup', () => end(false));
    g.addEventListener('pointercancel', () => end(true));
  }

  // Touch events on the body: only when content is at its start.
  if (o.body) {
    const inGrip = (t: EventTarget | null): boolean => grips.some((g) => t instanceof Node && g.contains(t));
    let own = false;
    el.addEventListener('touchstart', (e) => {
      own = false;
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || inGrip(e.target)) return;
      const tg = e.target as HTMLElement;
      if (tg.closest('input[type=range]')) return;
      if (scrolledAway(tg, el, o.axis())) return;
      own = true; begin(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!own || !t) return;
      if (move(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
      else if (!st) own = false;
    }, { passive: false });
    el.addEventListener('touchend', () => { if (own) end(false); own = false; });
    el.addEventListener('touchcancel', () => { if (own) end(true); own = false; });
  }
}
