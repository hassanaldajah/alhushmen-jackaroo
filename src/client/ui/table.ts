import type { Card, Net, RoomView } from '../net/types';
import type { HintSource, PendingMove, SceneHost } from './bridge';
import { h, icon, clear } from './dom';
import { T } from './ar';
import { button, iconButton, toast, announce } from './widgets';
import { teamChip, seatTile, teamLabel } from './lobby';
import { JokeBubble } from './joke';
import { fmtMs } from './results';
import type { MicState } from '../voice/mesh';
import { sfx } from '../audio/sfx';

const SUIT: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export interface TableActions { help(): void; voice(): void; menu(): void; micToggle(): void; songs(): void; chat(): void }

export class Table {
  readonly el: HTMLElement;
  private status = h('div', { class: 'status' });
  private hand = h('div', { class: 'hand', role: 'listbox', 'aria-label': T.pickCard });
  private confirmEl = h('div', { class: 'confirm', hidden: true });
  private sceneEl = h('div', { id: 'scene', role: 'img', 'aria-label': T.room });
  private mic = h('button', { type: 'button', class: 'mic muted', 'aria-pressed': 'false', 'aria-label': T.micOff });
  private hintBtn: HTMLButtonElement;
  private v: RoomView | null = null;
  private selected: string | null = null;
  private pending: PendingMove | null = null;
  private hintOn = false;
  private hintTimer = 0;
  private lastTurn: number | null = null;
  private promptEl = h('div', { class: 'prompt', hidden: true, 'aria-live': 'polite' });
  private finEl = h('div', { class: 'finbar', hidden: true, role: 'status' });
  private clockEl = h('span', { class: 'clock' });
  private clockAt = 0;
  private clockTimer = 0;
  private viewSeat = 0;
  private unread = 0;
  readonly jokes: JokeBubble;
  private dealtFor = '';

  constructor(private net: Net, private scene: SceneHost | null, private hints: HintSource | null, private act: TableActions) {
    this.mic.addEventListener('click', () => { navigator.vibrate?.(10); act.micToggle(); });
    this.hintBtn = button(T.hint, 'btn-secondary', () => this.hint(true));
    const speaker = iconButton('speaker', T.music, act.songs, 'music-btn');
    const helpChip = iconButton('help', T.helpOpen, act.help, 'rail-btn');
    const voiceBtn = iconButton('voice', T.voiceTitle, act.voice, 'rail-btn');
    speaker.className = 'btn btn-icon rail-btn';
    const rail = h('div', { class: 'rail' }, speaker, voiceBtn, helpChip);
    const actions = h('div', { class: 'actions' }, this.hintBtn);
    this.el = h('div', { class: 'table' }, this.sceneEl, this.status, this.finEl, rail, actions, this.promptEl, this.confirmEl,
      h('div', { class: 'handbar' }, this.hand));
    this.jokes = new JokeBubble(this.sceneEl, (seat) => this.scene?.seatAnchor(seat) ?? null);
    this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
    if (scene) {
      scene.mount(this.sceneEl);
      // The 3D scene draws the own hand (phone: avatar fan, laptop: cards in front). 2D hand only as WebGL fallback.
      if (scene.active) this.el.classList.add('no2d');
      scene.onPending((p) => this.setPending(p));
      scene.onPrompt((t) => { this.promptEl.hidden = !t || !!this.pending; clear(this.promptEl, t ? h('span', null, t) : null); });
      scene.onCardPick((id) => { const c = this.v?.hand.find((x) => x.id === id); if (c && this.v) this.pick(c, this.v.turnSeat === this.v.you.seat, true); });
    } else {
      this.sceneEl.append(h('div', { class: 'overlay', style: { position: 'absolute', background: 'transparent' } }, T.loading));
    }
  }

  private setPending(p: PendingMove | null): void {
    this.pending = p;
    this.renderConfirm();
  }

  private renderConfirm(): void {
    const p = this.pending;
    this.confirmEl.hidden = !p;
    this.promptEl.hidden = true;
    if (!p) { clear(this.confirmEl); return; }
    const go = (o: { moves: PendingMove['options'][number]['moves'] }) => { // only a user tap sends anything
      this.net.send({ t: 'play', cardId: p.cardId, moves: o.moves });
      sfx.play('throw');
      this.reset();
    };
    const multi = p.options.length > 1;
    clear(this.confirmEl,
      multi ? h('span', { class: 'info' }, T.pickOption) : h('span', { class: 'info' }, p.options[0]?.summary ?? ''),
      ...(multi ? p.options.map((o) => button(o.summary, 'btn-primary', () => go(o))) : [button(T.confirm, 'btn-primary', () => go(p.options[0]!))]),
      button(T.cancel, 'btn-secondary', () => { this.scene?.cancelPending(); this.renderConfirm(); }));
  }

  private reset(): void {
    this.pending = null; this.selected = null; this.hint(false);
    this.scene?.selectCard(null); this.renderConfirm(); this.renderHand();
  }

  /** Legal-move highlight: only on request, auto-off after 10 s; never selects or plays. */
  hint(on: boolean): void {
    clearTimeout(this.hintTimer);
    this.hintOn = on;
    this.scene?.showHints(on);
    if (on) this.hintTimer = window.setTimeout(() => this.hint(false), 10000);
    this.renderHand();
  }
  get hintsOn(): boolean { return this.hintOn; }

  setMic(state: MicState, speaking: boolean): void {
    const map: Record<MicState, [string, string, string]> = {
      live: ['live', 'mic', T.micLive], muted: ['muted', 'mic-off', T.micMuted], listen: ['muted', 'mic-off', T.micMuted],
      connecting: ['connecting', 'mic', '...'], denied: ['denied', 'mic-off', T.micBlocked], unavailable: ['muted', 'mic-off', T.voiceNo],
    };
    const [cls, ic, lbl] = map[state];
    this.mic.className = 'mic ' + cls + (speaking ? ' speaking' : '');
    this.mic.setAttribute('aria-pressed', String(state === 'live'));
    this.mic.setAttribute('aria-label', `${state === 'live' ? T.micOn : T.micOff} (${lbl})`);
    if (state === 'unavailable') this.mic.setAttribute('aria-disabled', 'true'); else this.mic.removeAttribute('aria-disabled');
    clear(this.mic, icon(ic), h('span', { class: 'sr' }, lbl));
  }

  update(v: RoomView): void {
    const prev = this.v;
    this.v = v;
    this.scene?.setView(v);
    const mySeat = v.you.seat;
    const myTurn = mySeat !== null && v.turnSeat === mySeat;
    const turnSeat = v.turnSeat !== null ? v.seats[v.turnSeat] : null;
    const myTeam = mySeat !== null ? v.seats[mySeat]!.team : null;
    if (v.turnSeat !== this.lastTurn) {
      this.lastTurn = v.turnSeat;
      if (this.pending || this.selected) this.reset();
      if (v.turnSeat !== null) announce(myTurn ? T.turnYou : T.turnOther(turnSeat?.name ?? ''), myTurn);
    }
    clear(this.status,
      h('span', { class: 'pill' + (myTurn ? ' me' : ''), role: 'status' }, v.turnSeat === null ? T.waitingDeal : myTurn ? T.turnYou : T.turnOther(turnSeat?.name ?? '')),
      myTeam ? teamChip(myTeam) : h('span', { class: 'chip' }, T.spectatorLabel),
      h('span', { class: 'score', 'aria-label': `${T.teamA} ${v.scores.A} ${T.teamB} ${v.scores.B}` },
        h('span', { style: { color: 'var(--team-a)' } }, String(v.scores.A)), ':', h('span', { style: { color: 'var(--team-b)' } }, String(v.scores.B))),
      this.clockEl,
      h('span', { class: 'spacer' }), this.mic,
      this.chatBtn(),
      iconButton('settings', T.menu, this.act.menu));
    this.clockAt = Date.now();
    this.tickClock();
    const fin = v.phase === 'playing' && v.finishes.length === 1 ? v.finishes[0]! : null;
    this.finEl.hidden = !fin;
    if (fin) this.finEl.textContent = T.teamDoneWait(teamLabel(fin.team), teamLabel(fin.team === 'A' ? 'B' : 'A'));
    // Deal announcement + sound when a new hand arrives.
    const key = v.hand.map((c) => c.id).join();
    if (v.hand.length && key !== this.dealtFor && (!prev || prev.hand.length === 0)) {
      announce(T.dealt(v.hand.length)); sfx.play('shuffle'); sfx.deal(v.hand.length);
    }
    this.dealtFor = key;
    if (!myTurn && this.selected) this.reset();
    this.hintBtn.hidden = !myTurn;
    this.renderViewPick();
    this.renderHand();
  }

  private renderHand(): void {
    const v = this.v; if (!v) return;
    if (v.you.seat === null) { clear(this.hand, h('div', { class: 'specmsg' }, T.spectatorLabel, ' - ', v.seats.map((s) => `${s.name ?? ''} ${s.cards}`).join(' | '))); this.hand.className = 'hand'; return; }
    const myTurn = v.turnSeat === v.you.seat;
    const legal = this.hintOn && this.hints ? new Set(this.hints.legalCardIds(v)) : null;
    const sorted = [...v.hand].sort((a, b) => a.suit.localeCompare(b.suit) || a.rank.localeCompare(b.rank, 'en', { numeric: true }));
    this.hand.className = 'hand' + (v.hand.length <= 7 ? ' few' : '') + (myTurn ? '' : ' off');
    clear(this.hand, ...sorted.map((c) => this.cardEl(c, myTurn, legal?.has(c.id) ?? false)));
  }

  private cardEl(c: Card, myTurn: boolean, hint: boolean): HTMLElement {
    const red = c.suit === 'H' || c.suit === 'D';
    const el = h('button', {
      type: 'button', role: 'option', 'aria-selected': String(this.selected === c.id),
      class: 'card' + (red ? ' red' : '') + (this.selected === c.id ? ' sel' : '') + (hint ? ' hint' : ''),
      'aria-label': `${c.rank} ${T.suit[c.suit] ?? ''}${hint ? ' - ممكنة' : ''}`,
      onclick: () => this.pick(c, myTurn),
    }, h('span', null, c.rank), h('span', { class: 'su', 'aria-hidden': 'true' }, SUIT[c.suit] ?? ''));
    return el;
  }

  private pick(c: Card, myTurn: boolean, fromScene = false): void {
    if (!myTurn) { toast(T.notTurn); return; }
    // A second tap on the same card (scene peek) keeps it selected; the confirm bar decides.
    this.selected = this.selected === c.id && !fromScene ? null : c.id;
    sfx.play('flick');
    this.scene?.selectCard(this.selected ? c : null);
    if (!this.selected) { this.pending = null; this.renderConfirm(); }
    this.renderHand();
  }

  private chatBtn(): HTMLElement {
    const b = iconButton('chat', this.unread ? `${T.chat} (${this.unread})` : T.chat, this.act.chat);
    if (this.unread) b.append(h('span', { class: 'badge', style: { position: 'absolute', top: '0', insetInlineEnd: '0' } }, String(this.unread)));
    b.style.position = 'relative';
    return b;
  }
  setUnread(n: number): void { this.unread = n; if (this.v) this.update(this.v); }

  private tickClock(): void {
    const v = this.v; if (!v) return;
    const c = v.clock;
    const el = c.startedAt === null ? 0 : c.elapsedMs + (c.paused ? 0 : Date.now() - this.clockAt);
    this.clockEl.textContent = `${fmtMs(el)} / ${fmtMs(c.expectedMs)}`;
    this.clockEl.setAttribute('aria-label', `${T.elapsedL} ${fmtMs(el)}, ${T.expected} ${fmtMs(c.expectedMs)}`);
  }

  private renderViewPick(): void {
    const v = this.v; const old = this.el.querySelector('.viewpick'); old?.remove();
    if (!v || v.you.seat !== null || !this.scene) return;
    const box = h('div', { class: 'viewpick actions', style: { insetInlineStart: 'auto', insetInlineEnd: 'var(--sp-2)', flexDirection: 'row' } },
      ...v.seats.map((s) => button(s.name ? [...s.name][0]! : String(s.index + 1), this.viewSeat === s.index ? 'btn-primary' : 'btn-secondary',
        () => { this.viewSeat = s.index; this.scene?.setViewSeat(s.index); this.renderViewPick(); })));
    box.classList.add('viewpick');
    this.el.append(box);
  }

  destroy(): void { clearInterval(this.clockTimer); this.jokes.hide(); }

  /** Mark seat tiles / voice participants as speaking (called by the voice layer). */
  speaking(ids: Set<string>): void {
    this.el.querySelectorAll<HTMLElement>('[data-pid]').forEach((e) => e.classList.toggle('speaking', ids.has(e.dataset.pid ?? '')));
  }
}
export { seatTile };
