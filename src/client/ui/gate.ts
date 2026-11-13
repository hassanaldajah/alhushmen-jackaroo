import type { Net } from '../net/types';
import { h, icon, clear } from './dom';
import { T } from './ar';
import { spinner } from './widgets';

/** Passphrase screen. Generic errors only. The hint line is a decoy (static, unrelated to the secret). Nothing is stored. */
export function mountGate(root: HTMLElement, net: Net, onOk: () => void, notice?: string): void {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', id: 'ph', 'aria-label': T.gateTitle, 'aria-describedby': 'ghint gerr', dir: 'auto' });
  const err = h('div', { id: 'gerr', class: 'err', role: 'alert' });
  const toggle = h('button', { type: 'button', class: 'btn btn-secondary', 'aria-pressed': 'false', onclick: () => {
    const shown = input.type === 'text'; input.type = shown ? 'password' : 'text';
    toggle.setAttribute('aria-pressed', String(!shown)); toggle.textContent = shown ? T.show : T.hide;
  } }, T.show);
  const go = h('button', { type: 'submit', class: 'btn btn-primary', disabled: true }, T.gateCta);
  let timer = 0, busy = false;
  const sync = () => { if (!busy && !timer) go.toggleAttribute('disabled', !input.value); };
  input.addEventListener('input', sync);

  const showErr = (m: string) => { clear(err, icon('warning'), m); input.setAttribute('aria-invalid', 'true'); input.focus(); };
  const countdown = (n: number) => {
    go.setAttribute('disabled', ''); input.setAttribute('aria-invalid', 'true');
    const tick = () => {
      if (n <= 0) { timer = 0; clear(err); sync(); return; }
      clear(err, icon('warning'), T.gateWait(n)); n--; timer = window.setTimeout(tick, 1000);
    };
    tick();
  };
  const form = h('form', { class: 'panel center', autocomplete: 'off', onsubmit: async (e: Event) => {
    e.preventDefault();
    if (busy || timer || !input.value) return;
    busy = true; go.setAttribute('disabled', ''); clear(go, spinner(), T.gateBusy); clear(err);
    const r = await net.gate(input.value);
    busy = false; clear(go, T.gateCta);
    if (r.ok) { input.value = ''; onOk(); return; }
    if (r.wait && r.wait > 0) countdown(r.wait); else { showErr(r.net ? T.gateNet : T.gateWrong); sync(); }
  } },
  h('h1', null, T.gateTitle),
  notice ? h('div', { class: 'muted', role: 'status' }, notice) : null,
  h('div', { class: 'field' }, h('label', { for: 'ph', class: 'sr' }, T.gateTitle), h('div', { class: 'row' }, input, toggle),
    h('div', { id: 'ghint', class: 'muted', style: { fontSize: 'var(--fs-sm)', lineHeight: 'var(--lh-sm)', color: 'var(--cream-200)' } }, T.gateHint), err),
  go);
  clear(root, h('div', { class: 'screen' }, form));
}
