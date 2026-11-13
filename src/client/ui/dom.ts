type Kid = Node | string | number | null | false | undefined;
type Props = { [k: string]: unknown } | null;

/** Tiny DOM builder. Text always goes through text nodes (no innerHTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  add(el, kids);
  return el;
}
export function add(el: Element, kids: Kid[]): void {
  for (const c of kids) if (c != null && c !== false) el.append(typeof c === 'object' ? c : String(c));
}
export function clear(el: Element, ...kids: Kid[]): void { el.replaceChildren(); add(el, kids); }
export const bdi = (t: string): HTMLElement => h('bdi', null, t);

/** Inline SVG sprite icons (24px grid, 2px stroke, currentColor). Static trusted strings only. */
const P: Record<string, string> = {
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  'mic-off': '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  play: '<path d="M8 5v14l11-7z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  next: '<path d="M6 5v14l9-7zM18 5v14"/>', queue: '<path d="M4 6h16M4 12h16M4 18h8"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', chevron: '<path d="M9 6l6 6-6 6"/>',
  circle: '<circle cx="12" cy="12" r="7"/>', diamond: '<path d="M12 4l8 8-8 8-8-8z"/>',
  check: '<path d="M5 12l5 5 9-10"/>', warning: '<path d="M12 4l10 17H2zM12 10v5M12 18h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  bars: '<path d="M5 19v-3M11 19v-7M17 19V6"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  voice: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 14c3 0 5 2 5 5"/>',
  camera: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  joke: '<circle cx="12" cy="12" r="9"/><path d="M7.5 13.5h9a4.5 4.5 0 0 1-9 0zM9 9.5h.01M15 9.5h.01"/>',
};
export function icon(name: string, cls = ''): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '24'); s.setAttribute('height', '24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ic ' + cls);
  s.innerHTML = P[name] ?? '';
  return s;
}
