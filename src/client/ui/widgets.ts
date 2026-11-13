import { h, icon, clear } from './dom';
import { T } from './ar';
import { swipeDismiss } from './swipe';

export function button(label: string, cls: string, onClick: () => void, ic?: string): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn ' + cls, onclick: onClick }, ic ? icon(ic) : null, label);
}
export function iconButton(ic: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn btn-icon ' + cls, 'aria-label': label, title: label, onclick: onClick }, icon(ic));
}

let toastRoot: HTMLElement | null = null;
/** Errors persist until dismissed; others stay 6 s (pausable on hover/focus). */
export function toast(text: string, error = false): void {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const el = h('div', { class: 'toast' + (error ? ' error' : ''), role: error ? 'alert' : 'status' }, h('span', null, text));
  let timer = 0; const rm = () => el.remove();
  const arm = () => { if (!error) timer = window.setTimeout(rm, 6000); };
  el.addEventListener('pointerenter', () => clearTimeout(timer)); el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer)); el.addEventListener('focusout', arm);
  if (error) el.append(iconButton('close', T.close, rm));
  swipeDismiss(el, [el], { axis: () => 'x', sign: () => 0, onDismiss: rm });
  toastRoot.append(el); arm();
}

/** Toast with one action button (e.g. Undo). */
export function toastAction(text: string, label: string, onClick: () => void): void {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const el = h('div', { class: 'toast', role: 'status' }, h('span', null, text));
  el.append(h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => { onClick(); el.remove(); } }, label));
  swipeDismiss(el, [el], { axis: () => 'x', sign: () => 0, onDismiss: () => el.remove() });
  toastRoot.append(el); window.setTimeout(() => el.remove(), 8000);
}

export interface SheetHandle { el: HTMLElement; body: HTMLElement; close(): void }
const openSheets = new Set<SheetHandle>();
/** Close every open sheet (logout, end screens). */
export function closeAllSheets(): void { for (const s of [...openSheets]) s.close(); }
export const anySheetOpen = (): boolean => openSheets.size > 0;
/** Modal sheet: focus trap, Esc, scrim click, returns focus. Background made inert. */
export function openSheet(title: string, opts: { side?: boolean; tall?: boolean; center?: boolean; onClose?: () => void } = {}): SheetHandle {
  const prev = document.activeElement as HTMLElement | null;
  const app = document.getElementById('app');
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' } });
  const titleId = 'sh' + Math.random().toString(36).slice(2, 7);
  const sheet = h('div', { class: 'sheet' + (opts.tall ? ' tall' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }, h('span', { class: 'grab' })),
    h('div', { class: 'sheet-head' }, h('h2', { id: titleId, tabindex: '-1', style: { flex: 1 } }, title), iconButton('close', T.close, () => close())),
    body);
  const scrim = h('div', { class: 'scrim' + (opts.side ? ' side' : '') + (opts.center ? ' modal-c' : '') }, sheet);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  // Swipe to dismiss: down on phones and centered modals, toward the nearest edge for desktop/tablet side sheets.
  const sideNow = () => !!opts.side && matchMedia('(min-width: 768px)').matches;
  swipeDismiss(sheet, [...sheet.querySelectorAll<HTMLElement>('.sheet-grip, .sheet-head')], {
    axis: () => (sideNow() ? 'x' : 'y'),
    sign: () => (sideNow() ? (sheet.getBoundingClientRect().left + sheet.offsetWidth / 2 > innerWidth / 2 ? 1 : -1) : 1),
    onProgress: (p) => scrim.style.setProperty('--drag', String(p)),
    onDismiss: () => close(), body: true });
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  let done = false;
  const handle: SheetHandle = { el: scrim, body, close };
  function close(): void {
    if (done) return; done = true;
    openSheets.delete(handle);
    document.removeEventListener('keydown', key);
    if (!openSheets.size) app?.removeAttribute('inert');
    scrim.remove(); prev?.focus(); opts.onClose?.();
  }
  document.addEventListener('keydown', key);
  app?.setAttribute('inert', '');
  document.body.append(scrim);
  openSheets.add(handle);
  sheet.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  return handle;
}

export function spinner(): HTMLElement { return h('span', { class: 'spin', 'aria-hidden': 'true' }); }
export function skeletons(n: number): HTMLElement[] { return Array.from({ length: n }, () => h('div', { class: 'skel' })); }
export { clear };

let live: HTMLElement | null = null;
export function announce(text: string, assertive = false): void {
  live ??= document.body.appendChild(h('div', { class: 'sr', 'aria-live': 'polite' }));
  live.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  live.textContent = ''; setTimeout(() => { if (live) live.textContent = text; }, 30);
}
