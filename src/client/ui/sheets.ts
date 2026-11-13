import type { Net, RoomView, SearchResult } from '../net/types';
import type { Quality } from '../scene';
import { autoJokesEnabled, jokesEnabled, setAutoJokesEnabled, setJokesEnabled } from './joke';
import type { VoiceMesh } from '../voice/mesh';
import { sfx } from '../audio/sfx';
import { h, icon, clear, bdi } from './dom';
import { T, HELP } from './ar';
import { openSheet, button, toast, skeletons } from './widgets';

/** Help: explains only. The hint toggle asks the table to highlight; it never selects or plays. */
export function openHelp(hintsOn: () => boolean, setHints: (on: boolean) => void, canHint: boolean): void {
  const s = openSheet(T.helpTitle, { side: true, tall: true });
  let open = 0;
  const acc = h('div', { class: 'list' });
  const draw = () => clear(acc, ...HELP.map((sec, i) => h('div', { class: 'acc' },
    h('button', { type: 'button', 'aria-expanded': String(open === i), onclick: () => { open = open === i ? -1 : i; draw(); } }, sec.title, icon('chevron', open === i ? '' : 'mirror')),
    open === i ? h('ul', null, ...sec.lines.map((l) => h('li', null, l))) : null)));
  draw();
  const cb = h('input', { type: 'checkbox', id: 'hintsw', disabled: !canHint }) as HTMLInputElement;
  cb.checked = hintsOn();
  cb.addEventListener('change', () => setHints(cb.checked));
  s.body.append(acc, h('label', { class: 'switch', for: 'hintsw' }, cb, T.hintToggle));
}

export interface GfxCtl { quality(): Quality; set(q: Quality): void }
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
export function openSettings(root: HTMLElement, gfx?: GfxCtl, onLogout?: () => void, onNewGame?: () => void): void {
  const s = openSheet(T.settings, { side: true });
  const sw = (label: string, on: boolean, f: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = on; i.addEventListener('change', () => f(i.checked));
    return h('label', { class: 'switch' }, i, label);
  };
  const vol = h('input', { type: 'range', min: '0', max: '100', class: 'range', 'aria-label': T.sfx }) as HTMLInputElement;
  vol.value = String(Math.round(sfx.volume * 100));
  vol.addEventListener('input', () => { sfx.setVolume(Number(vol.value) / 100); sfx.play('tick'); });
  const html = document.documentElement;
  s.body.append(
    h('label', { class: 'field' }, T.sfx, vol),
    sw(T.sfxMute, sfx.muted, (v) => sfx.setMuted(v)),
    sw(T.motion, html.dataset.motion === 'reduce', (v) => { html.dataset.motion = v ? 'reduce' : 'full'; save('motion', html.dataset.motion); }),
    ...(gfx ? [sw(T.quality, gfx.quality() === 'high', (v) => gfx.set(v ? 'high' : 'low'))] : []),
    sw(T.jokeSetting, jokesEnabled(), setJokesEnabled),
    sw(T.autoJokes, autoJokesEnabled(), setAutoJokesEnabled),
    sw(T.contrast, html.dataset.hc === '1', (v) => { html.dataset.hc = v ? '1' : '0'; save('hc', html.dataset.hc); }),
    ...(onNewGame ? [h('hr', { class: 'sep' }), button(T.newGameAbort, 'btn-secondary btn-block', () => { s.close(); confirmNewGame(onNewGame); })] : []),
    ...(onLogout ? [h('hr', { class: 'sep' }), button(T.logout, 'btn-danger btn-block', () => { s.close(); confirmLogout(onLogout); }, 'logout')] : []));
  void root;
}

/** "Are you sure?" before leaving: logging out drops the seat and the saved name on this device. */
export function confirmNewGame(onYes: () => void): void {
  const s = openSheet(T.newGameAbort, { center: true });
  s.body.append(h('p', { class: 'muted' }, T.newGameAsk),
    h('div', { class: 'row' }, button(T.yes, 'btn-danger', () => { s.close(); onYes(); }), button(T.cancel, 'btn-secondary', () => s.close())));
}

export function confirmLogout(onYes: () => void): void {
  const s = openSheet(T.logout, { center: true });
  s.body.append(h('p', { class: 'muted' }, T.logoutAsk),
    h('div', { class: 'row' }, button(T.logout, 'btn-danger', () => { s.close(); onYes(); }, 'logout'), button(T.cancel, 'btn-secondary', () => s.close())));
}

export function openVoice(v: RoomView, voice: VoiceMesh): { refresh(v: RoomView): void } {
  const s = openSheet(T.voiceTitle, { side: true });
  const list = h('ul', { class: 'list' });
  const draw = (rv: RoomView) => {
    const others = rv.voiceIds.filter((i) => i !== rv.you.id);
    clear(list, ...(others.length ? others : []).map((id) => {
      const p = voice.peers.get(id);
      const name = rv.names[id] ?? '?';
      const vol = h('input', { type: 'range', min: '0', max: '100', class: 'range', 'aria-label': `${T.volume} ${name}` }) as HTMLInputElement;
      vol.value = String(p?.volume ?? 100);
      vol.addEventListener('input', () => voice.setPeerVolume(id, Number(vol.value)));
      return h('li', { class: 'li' + (p?.speaking ? ' speaking' : ''), 'data-pid': id },
        h('span', { class: 'avatar' }, [...name][0] ?? '?'),
        h('div', { style: { flex: 1, minWidth: 0 } }, bdi(name),
          h('div', { class: 'muted' + (p?.status === 'failed' ? ' err' : '') }, p?.speaking ? '● ' : '', p?.status === 'connected' ? T.voiceOk : p?.status === 'failed' ? T.voiceFail(name) : T.voiceConnecting, p?.remoteMuted ? ' - ' + T.micMuted : ''), vol),
        p?.failed ? button(T.retry, 'btn-secondary', () => voice.retry(id)) : null,
        button(T.localMute, p?.localMuted ? 'btn-primary' : 'btn-secondary', () => { voice.setPeerMuted(id, !p?.localMuted); draw(rv); }));
    }));
    if (!others.length) list.append(h('li', { class: 'muted' }, T.voiceAlone));
    else if (voice.noneConnected) list.append(h('li', { class: 'err', role: 'status' }, icon('warning'), T.voiceHint));
    if (voice.micState === 'denied') list.append(h('li', { class: 'err', role: 'alert' }, icon('warning'), T.micDenied));
  };
  draw(v);
  s.body.append(h('div', { class: 'muted' }, T.voiceSome), list);
  const iv = window.setInterval(() => { if (document.body.contains(s.el)) draw(last); else clearInterval(iv); }, 500);
  let last = v;
  return { refresh: (nv) => { last = nv; draw(nv); } };
}

/** First-entry pre-prompt; the browser permission only appears after the tap. */
export function openVoicePrompt(onYes: () => void, onNo: () => void): void {
  const s = openSheet(T.voicePre, { center: true });
  s.body.append(h('div', { class: 'row' },
    button(T.voiceEnable, 'btn-primary', () => { s.close(); onYes(); }, 'mic'),
    button(T.voiceListen, 'btn-secondary', () => { s.close(); onNo(); })));
}

export function openSongs(net: Net, v: () => RoomView, isPlayer: () => boolean): { refresh(): void } {
  const s = openSheet(T.songs, { side: true, tall: true });
  const input = h('input', { class: 'input', type: 'search', maxlength: '80', placeholder: T.songSearch, 'aria-label': T.songSearch, id: 'sq' }) as HTMLInputElement;
  const results = h('ul', { class: 'list', 'aria-live': 'polite' });
  const queue = h('ul', { class: 'list' });
  let timer = 0, blockUntil = 0, seq = 0;
  const row = (r: SearchResult) => h('li', { class: 'li' },
    r.thumb ? h('img', { src: r.thumb, alt: '', width: '56', height: '56', referrerpolicy: 'no-referrer' }) : h('span', { class: 'thumb' }),
    h('span', { class: 'tt' }, r.title),
    button(T.songAdd, 'btn-primary', () => { net.send({ t: 'qAdd', videoId: r.videoId, title: r.title, thumb: r.thumb }); toast(T.songAdded); }));
  const msg = (t: string) => clear(results, h('li', { class: 'muted', role: 'status' }, t));
  const run = async () => {
    const q = input.value.trim();
    if (!q) { clear(results); return; }
    if (Date.now() < blockUntil) return;
    const my = ++seq;
    clear(results, ...skeletons(5));
    const r = await net.search(q);
    if (my !== seq) return;
    if (!r.ok) {
      if (r.reason === 'rate') { blockUntil = Date.now() + (r.retryAfter ?? 10) * 1000; msg(T.songRate); }
      else msg(r.reason === 'quota' ? T.songQuota : T.songErr);
      return;
    }
    if (!r.results.length) msg(T.songNone); else clear(results, ...r.results.map(row));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => void run(), 400); });
  const drawQ = () => {
    const rv = v();
    clear(queue, ...(rv.queue.length ? rv.queue.map((q) => h('li', { class: 'li' + (rv.nowPlaying?.itemId === q.id ? ' now' : '') },
      q.thumb ? h('img', { src: q.thumb, alt: '', width: '56', height: '56', referrerpolicy: 'no-referrer' }) : h('span', { class: 'thumb' }),
      h('span', { class: 'tt' }, q.title, h('br'), h('span', { class: 'muted' }, T.songBy(q.by))),
      rv.nowPlaying?.itemId === q.id ? null : button(T.songPlayNow, 'btn-secondary', () => net.send({ t: 'qPlay', id: q.id })),
      q.byId === rv.you.id ? button(T.songRemove, 'btn-secondary', () => net.send({ t: 'qRemove', id: q.id })) : null)) : [h('li', { class: 'muted' }, T.songEmpty)]));
  };
  // No-collision rule: anyone (player or spectator) may skip or stop at any time; no approval needed.
  void isPlayer;
  const skip = h('span', { class: 'row' }, button(T.songSkip, 'btn-secondary', () => net.send({ t: 'qSkip', itemId: v().nowPlaying?.itemId }), 'next'),
    button(T.songStop, 'btn-secondary', () => net.send({ t: 'qStop' }), 'close'));
  s.body.append(h('div', { class: 'row' }, input, button(T.songSearchBtn, 'btn-primary', () => void run())), results,
    h('div', { class: 'row' }, h('h2', { style: { flex: 1 } }, T.queue), skip), queue);
  drawQ();
  return { refresh: drawQ };
}


/** Host menu (the crown button in the dock): start the game / new game / shuffle teams. */
export function openHostMenu(v: RoomView, net: Net): void {
  const s = openSheet(T.stHost, { center: true });
  const go = (f: () => void) => () => { s.close(); f(); };
  if (v.phase === 'lobby') {
    const start = button(T.start, 'btn-primary btn-big', go(() => net.send({ t: 'start' })));
    if (!v.canStart) { start.disabled = true; start.setAttribute('aria-disabled', 'true'); }
    s.body.append(start);
    if (!v.canStart) s.body.append(h('p', { class: 'muted' }, T.needTeams + ' - ' + T.needTeamsHow));
    s.body.append(button(T.shuffle, 'btn-secondary btn-block', go(() => confirmShuffle(() => net.send({ t: 'shuffleTeams' })))));
  } else if (v.phase === 'playing') {
    s.body.append(button(T.newGameAbort, 'btn-danger btn-block', go(() => confirmNewGame(() => net.send({ t: 'toLobby' })))));
  } else {
    s.body.append(button(T.newGame, 'btn-primary btn-big', go(() => net.send({ t: 'again' }))));
  }
}

function confirmShuffle(onYes: () => void): void {
  const s = openSheet(T.shuffle, { center: true });
  s.body.append(h('p', { class: 'muted' }, T.shuffleAsk),
    h('div', { class: 'row' }, button(T.yes, 'btn-primary', () => { s.close(); onYes(); }), button(T.no, 'btn-secondary', () => s.close())));
}

export function confirmHostChange(onYes: () => void): void {
  const s = openSheet(T.changeHost, { center: true });
  s.body.append(h('div', { class: 'row' }, button(T.yes, 'btn-primary', () => { s.close(); onYes(); }), button(T.no, 'btn-secondary', () => s.close())));
}
