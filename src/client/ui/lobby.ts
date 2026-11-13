import type { Net, RoomView, SeatView } from '../net/types';
import { h, icon, clear, bdi } from './dom';
import { T } from './ar';
import { button, iconButton, openSheet } from './widgets';

export function teamLabel(t: 'A' | 'B'): string { return t === 'A' ? T.teamA : T.teamB; }
export function teamChip(t: 'A' | 'B'): HTMLElement {
  return h('span', { class: 'chip ' + t.toLowerCase() }, icon(t === 'A' ? 'circle' : 'diamond'), teamLabel(t));
}

/** One seat tile; data-pid lets the voice layer add the speaking ring. Names are set with textContent only. */
export function seatTile(s: SeatView, opts: { turn?: boolean; me?: boolean; host?: boolean; onClick?: () => void } = {}): HTMLElement {
  const cls = 'tile team-' + s.team.toLowerCase() + (opts.turn ? ' turn' : '') + (s.name && !s.connected ? ' off' : '');
  const inner = [
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, s.name ? [...s.name][0] ?? '?' : '+'),
    h('span', { class: 'meta' },
      h('bdi', { class: 'nm' }, s.name ?? (s.open ? T.empty : T.sit)),
      h('span', { class: 'muted' }, teamLabel(s.team), s.name && !s.connected ? ` - ${T.disconnected}` : '', s.paired ? ' - ' + T.stPartner : '')),
    opts.host ? icon('crown') : null,
    s.cards > 0 ? h('span', { class: 'badge', 'aria-label': T.cardsCount(s.cards) }, String(s.cards)) : null,
  ];
  return opts.onClick
    ? h('button', { type: 'button', class: cls, onclick: opts.onClick, 'data-pid': s.id ?? '' }, ...inner)
    : h('div', { class: cls, 'data-pid': s.id ?? '' }, ...inner);
}

export function brandCorner(): HTMLElement { return h('div', { class: 'brand-corner', 'aria-hidden': 'true' }, 'جاكارو الحُشمين'); }

/** Top bar of the pre-game screens: brand on the start side, settings + logout on the end side. */
function topBar(ctx: LobbyCtx): HTMLElement {
  return h('div', { class: 'topbar' }, brandCorner(), h('span', { class: 'spacer' }),
    iconButton('settings', T.settings, ctx.openMenu, 'top-btn'),
    iconButton('logout', T.logout, ctx.logout, 'top-btn'));
}

let nameError = '';
let autoTried = false;
/** Called by the app when the server rejects a name. */
export function setNameError(code: string): void { nameError = code === 'name_taken' ? T.nameTaken : code === 'banned' ? T.nameBanned : code === 'name' ? T.nameBad : ''; }

export interface LobbyCtx {
  setName(n: string, asSpectator: boolean): void;
  openScore(): void;
  openChat(): void;
  joke(): void;
  openMenu(): void;
  logout(): void;
  remembered: string | null;
}

function confirmSheet(title: string, onYes: () => void): void {
  const s = openSheet(title, { center: true });
  s.body.append(h('div', { class: 'row' }, button(T.yes, 'btn-primary', () => { s.close(); onYes(); }), button(T.no, 'btn-secondary', () => s.close())));
}

function nameScreen(root: HTMLElement, ctx: LobbyCtx): void {
  const input = h('input', { class: 'input', maxlength: '16', required: true, id: 'nm', autocomplete: 'off', enterkeyhint: 'done', placeholder: T.namePh, }) as HTMLInputElement;
  const counter = h('span', { class: 'muted', 'aria-hidden': 'true' }, `${[...input.value].length}/16`);
  input.addEventListener('input', () => { counter.textContent = `${[...input.value].length}/16`; });
  let spectator = false;
  const seg = (label: string, isSpec: boolean) => {
    const b = h('button', { type: 'button', class: 'btn ' + (spectator === isSpec ? 'btn-primary' : 'btn-secondary'), 'aria-pressed': String(spectator === isSpec),
      onclick: () => { spectator = isSpec; drawSeg(); } }, label);
    return b;
  };
  const segs = h('div', { class: 'row', role: 'group' });
  const drawSeg = () => clear(segs, seg(T.roleP, false), seg(T.roleS, true));
  drawSeg();
  const err = h('div', { class: 'err', role: 'alert' }, ...(nameError ? [icon('warning'), nameError] : []));
  const form = h('form', { class: 'panel center', onsubmit: (e: Event) => {
    e.preventDefault();
    const n = input.value.trim().replace(/\s+/g, ' ');
    if (n) { nameError = ''; try { localStorage.setItem('role', spectator ? 's' : 'p'); } catch { /* private mode */ } ctx.setName(n, spectator); }
  } },
  h('h1', null, T.nameTitle), h('label', { for: 'nm', class: 'sr' }, T.nameTitle),
  h('div', { class: 'field' }, input, counter), err, segs,
  h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, T.nameGo));
  clear(root, h('div', { class: 'screen' }, topBar(ctx), form));
  input.focus({ preventScroll: true });
}

interface Person { id: string; name: string; seat: number | null; connected: boolean }

export function renderLobby(root: HTMLElement, v: RoomView, net: Net, ctx: LobbyCtx): void {
  if (!v.you.named) {
    // Saved name: join straight away once; if the server rejects it the form shows with the reason.
    if (ctx.remembered && !nameError && !autoTried) { autoTried = true; let spec = false; try { spec = localStorage.getItem('role') === 's'; } catch { /* storage blocked */ } ctx.setName(ctx.remembered, spec); return; }
    nameScreen(root, ctx); return;
  }
  const me = v.you.seat !== null ? v.seats[v.you.seat]! : null;
  const people: Person[] = [
    ...v.seats.filter((s) => s.id && s.name).map((s) => ({ id: s.id!, name: s.name!, seat: s.index as number, connected: s.connected })),
    ...v.spectators.map((s) => ({ id: s.id, name: s.name, seat: null, connected: true })),
  ];
  const seatOf = (id: string) => v.seats.find((s) => s.id === id);
  const reqs = v.requests;
  const find = (kind: 'partner' | 'swap', from: string, to: string) => reqs.find((r) => r.kind === kind && r.from === from && r.to === to);

  // ---- host strip
  const hostName = v.hostId ? v.names[v.hostId] ?? '' : '';
  const hostArea = v.hostId === null
    ? button(T.claimHost, 'btn-primary btn-big', () => net.send({ t: 'hostClaim' }), 'crown')
    : h('div', { class: 'row' },
      h('span', { class: 'chip host' }, icon('crown'), T.stHost, ' ', bdi(hostName)),
      h('span', { class: 'spacer' }),
      v.hostVote ? null : v.you.host ? null : button(T.changeHost, 'btn-secondary', () => net.send({ t: 'hostVoteStart' })));

  // ---- seats grid (partners diagonal)
  const order = [0, 1, 3, 2];
  const grid = h('div', { class: 'seats', role: 'group', 'aria-label': T.room },
    ...order.map((i) => {
      const s = v.seats[i]!;
      const mine = v.you.seat === i;
      const free = !s.name;
      return seatTile(s, { me: mine, host: !!s.id && s.id === v.hostId,
        onClick: mine ? () => net.send({ t: 'stand' }) : free ? () => net.send({ t: 'sit', seat: i }) : undefined });
    }));

  // ---- people list with partner / swap requests
  const row = (p: Person): HTMLElement => {
    const isMe = p.id === v.you.id;
    const st = seatOf(p.id);
    const chips: HTMLElement[] = [h('span', { class: 'chip' }, p.seat !== null ? T.roleP : T.roleS)];
    if (p.id === v.hostId) chips.push(h('span', { class: 'chip host' }, icon('crown'), T.stHost));
    if (isMe) chips.push(h('span', { class: 'chip' }, T.you2));
    const acts: Array<HTMLElement | null> = [];
    if (!isMe) {
      const pOut = find('partner', v.you.id, p.id), pIn = find('partner', p.id, v.you.id);
      const sOut = find('swap', v.you.id, p.id), sIn = find('swap', p.id, v.you.id);
      if (pIn) {
        chips.push(h('span', { class: 'chip warn' }, T.stReq));
        acts.push(button(T.accept, 'btn-primary', () => net.send({ t: 'partnerAnswer', from: p.id, accept: true })), button(T.decline, 'btn-secondary', () => net.send({ t: 'partnerAnswer', from: p.id, accept: false })));
      } else if (sIn) {
        chips.push(h('span', { class: 'chip warn' }, T.stReq));
        acts.push(button(T.accept, 'btn-primary', () => net.send({ t: 'swapAnswer', from: p.id, accept: true })), button(T.decline, 'btn-secondary', () => net.send({ t: 'swapAnswer', from: p.id, accept: false })));
      } else if (pOut || sOut) {
        chips.push(h('span', { class: 'chip' }, T.stWaiting));
        acts.push(button(T.cancelReq, 'btn-secondary', () => net.send(pOut ? { t: 'partnerCancel' } : { t: 'swapCancel' })));
      } else {
        if (me && st && !me.paired && !st.paired) acts.push(button(T.askPartner, 'btn-secondary', () => net.send({ t: 'partnerReq', to: p.id })));
        if (me || st) acts.push(button(T.swapSeat, 'btn-secondary', () => net.send({ t: 'swapReq', to: p.id })));
      }
      if (me?.paired && st?.paired && st.team === me.team) chips.push(h('span', { class: 'chip ok' }, T.stPartner));
      if (v.you.host) acts.push(button(T.kick, 'btn-danger', () => confirmSheet(T.kickAsk(p.name), () => net.send({ t: 'kick', id: p.id }))));
    }
    const hasIn = !!find('partner', p.id, v.you.id) || !!find('swap', p.id, v.you.id);
    return h('li', { class: 'li person' + (hasIn ? ' incoming' : ''), 'data-pid': p.id },
      h('span', { class: 'avatar' }, [...p.name][0] ?? '?'),
      h('div', { class: 'pbody' }, h('div', { class: 'row wrap' }, h('span', { class: 'pname' }, bdi(p.name)), ...chips), acts.length ? h('div', { class: 'row wrap' }, ...acts) : null));
  };
  const online = people.filter((p) => p.connected).length;
  const list = h('ul', { class: 'list', 'aria-label': T.people }, ...people.map(row));

  const mins = Math.max(1, Math.round(v.clock.expectedMs / 60000));
  const startBtn = button(T.start, 'btn-primary btn-big', () => net.send({ t: 'start' }));
  if (!v.canStart) { startBtn.disabled = true; startBtn.setAttribute('aria-disabled', 'true'); }
  // Always-visible start bar (sticks to the bottom of the screen): the host sees START; everyone else sees what to do.
  const startBar = h('div', { class: 'startbar' },
    v.you.host ? startBtn
      : v.hostId === null ? button(T.claimHost, 'btn-primary btn-big', () => net.send({ t: 'hostClaim' }), 'crown')
        : h('div', { class: 'muted wait-host' }, T.waitHost),
    v.you.host && !v.canStart ? h('div', { class: 'startbar-note' }, T.needTeams + ' - ' + T.needTeamsHow) : null);

  clear(root, h('div', { class: 'screen scroll lobby' }, topBar(ctx), h('div', { class: 'center' },
    h('h1', null, T.room),
    hostArea,
    grid,
    me?.paired ? button(T.breakPartner, 'btn-secondary', () => net.send({ t: 'partnerBreak' })) : null,
    h('h2', null, `${T.people}: ${people.length}`, h('span', { class: 'cnt' }, ` (المتصلين: ${online})`)), list,
    h('div', { class: 'muted' }, `${T.expected}: ${T.minutes(mins)}`),
    h('div', { class: 'lobby-actions' },
      v.you.host ? button(T.shuffle, 'btn-secondary', () => confirmSheet(T.shuffleAsk, () => net.send({ t: 'shuffleTeams' }))) : null,
      v.you.seat === null && !v.you.spectator ? button(T.spectate, 'btn-secondary', () => net.send({ t: 'spectate' })) : null,
      button(T.jokeAyman, 'btn-secondary', ctx.joke, 'joke'),
      button(T.scoreboard, 'btn-secondary', ctx.openScore, 'bars'))),
    startBar));
}
