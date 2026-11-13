import type { Card, Net, RoomView } from '../net/types';
import type { HintSource, PendingMove, SceneHost } from './bridge';
import { h, icon, clear } from './dom';
import { T } from './ar';
import { button, iconButton, announce } from './widgets';
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
  private camBtn: HTMLButtonElement;
  private tip = h('div', { class: 'cardtip', hidden: true, role: 'status', 'aria-live': 'polite' });
  private npcTag = h('div', { class: 'npc-tag', hidden: true, 'aria-hidden': 'true' }, h('b', null, T.npcName), h('span', null, T.npcBadge));
  private v: RoomView | null = null;
  private selected: string | null = null;
  /** Card tapped while it is not your turn: explanation only. */
  private preview: string | null = null;
  private previewTimer = 0;
  private tipFor: string | null = null;
  private pending: PendingMove | null = null;
  private prompt: string | null = null;
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
  private raf = 0;
  readonly jokes: JokeBubble;
  private dealtFor = '';

  constructor(private net: Net, private scene: SceneHost | null, private hints: HintSource | null, private act: TableActions) {
    this.mic.addEventListener('click', () => { navigator.vibrate?.(10); act.micToggle(); });
    this.hintBtn = button(T.hint, 'btn-secondary hint-btn', () => this.hint(true));
    this.camBtn = iconButton('camera', T.resetCam, () => this.scene?.resetCamera(), 'rail-btn cam-btn');
    this.camBtn.hidden = true;
    const speaker = iconButton('speaker', T.music, act.songs, 'rail-btn');
    const helpChip = iconButton('help', T.helpOpen, act.help, 'rail-btn');
    const voiceBtn = iconButton('voice', T.voiceTitle, act.voice, 'rail-btn');
    const rail = h('div', { class: 'rail' }, speaker, voiceBtn, helpChip, this.camBtn);
    const actions = h('div', { class: 'actions' }, this.hintBtn);
    this.el = h('div', { class: 'table' }, this.sceneEl, this.status, this.finEl, rail, actions, this.promptEl, this.confirmEl, this.tip, this.npcTag,
      h('div', { class: 'handbar' }, this.hand));
    this.jokes = new JokeBubble(this.sceneEl, (seat) => this.scene?.seatAnchor(seat) ?? null);
    this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
    if (scene) {
      scene.mount(this.sceneEl);
      // The 3D scene draws the own hand (phone: avatar fan, laptop: cards in front). 2D hand only as WebGL fallback.
      if (scene.active) this.el.classList.add('no2d');
      scene.onFallback(() => { this.el.classList.remove('no2d'); document.documentElement.classList.add('hand2d'); this.renderHand(); });
      if (!scene.active) document.documentElement.classList.add('hand2d');
      scene.onPending((p) => this.setPending(p));
      scene.onPrompt((t) => { this.prompt = t; this.renderPrompt(); });
      scene.onCardPick((id) => { const c = this.v?.hand.find((x) => x.id === id); if (c && this.v) this.pick(c, this.v.turnSeat === this.v.you.seat, true); });
      scene.onFrame(() => this.follow());
      scene.onCamera((moved) => { this.camBtn.hidden = !moved; });
    }
  }

  private renderPrompt(): void {
    const t = this.prompt;
    this.promptEl.hidden = !t || (!!this.pending && !this.pending.alt);
    clear(this.promptEl, t ? h('span', null, t) : null);
  }

  private setPending(p: PendingMove | null): void {
    this.pending = p;
    this.renderConfirm();
  }

  private renderConfirm(): void {
    const p = this.pending;
    this.confirmEl.hidden = !p;
    this.el.classList.toggle('confirming', !!p);
    this.renderPrompt();
    if (!p) { clear(this.confirmEl); return; }
    const go = (o: { moves: PendingMove['options'][number]['moves'] }) => { // only a user tap sends anything
      this.net.send({ t: 'play', cardId: p.cardId, moves: o.moves });
      sfx.play('throw');
      this.reset();
    };
    if (p.alt) {
      // Side options while the player is still choosing a marble (e.g. burn with a 10).
      clear(this.confirmEl, h('span', { class: 'info' }, T.orAlso), ...p.options.map((o) => button(o.summary, 'btn-secondary', () => go(o))));
      return;
    }
    const multi = p.options.length > 1;
    clear(this.confirmEl,
      multi ? h('span', { class: 'info' }, T.pickOption) : h('span', { class: 'info' }, p.options[0]?.summary ?? ''),
      ...(multi ? p.options.map((o) => button(o.summary, 'btn-primary', () => go(o))) : [button(T.confirm, 'btn-primary', () => go(p.options[0]!), 'check')]),
      button(T.cancel, 'btn-secondary', () => { this.scene?.cancelPending(); if (!this.scene) { this.pending = null; this.renderConfirm(); } }));
  }

  private reset(): void {
    this.pending = null; this.selected = null; this.preview = null; this.prompt = null; this.hint(false);
    this.scene?.selectCard(null); this.renderConfirm(); this.renderHand(); this.renderTip();
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
      iconButton('settings', T.menu, this.act.menu, 'menu-btn'),
      h('span', { class: 'pill' + (myTurn ? ' me' : ''), role: 'status' }, v.turnSeat === null ? T.waitingDeal
        : v.seats.some((s) => s.open) ? T.seatOpenWait
          : turnSeat && !turnSeat.connected ? T.waitingFor(turnSeat.name ?? '')
            : myTurn ? T.turnYou : T.turnOther(turnSeat?.name ?? '')),
      h('span', { class: 'spacer' }),
      myTeam ? teamChip(myTeam) : h('span', { class: 'chip' }, T.spectatorLabel),
      h('span', { class: 'score', 'aria-label': `${T.teamA} ${v.scores.A} ${T.teamB} ${v.scores.B}` },
        h('span', { style: { color: 'var(--team-a)' } }, String(v.scores.A)), ':', h('span', { style: { color: 'var(--team-b)' } }, String(v.scores.B))),
      this.clockEl);
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
    if (this.selected && !v.hand.some((c) => c.id === this.selected)) this.reset();
    this.hintBtn.hidden = !myTurn;
    this.renderViewPick();
    this.renderHand();
    this.renderTip();
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
      type: 'button', role: 'option', 'aria-selected': String(this.selected === c.id), 'data-card': c.id,
      class: 'card' + (red ? ' red' : '') + (this.selected === c.id ? ' sel' : '') + (hint ? ' hint' : ''),
      'aria-label': `${c.rank} ${T.suit[c.suit] ?? ''}${hint ? ' - ممكنة' : ''}. ${T.cardTip(c.rank)}`,
      onclick: () => this.pick(c, myTurn),
    }, h('span', null, c.rank), h('span', { class: 'su', 'aria-hidden': 'true' }, SUIT[c.suit] ?? ''));
    return el;
  }

  private pick(c: Card, myTurn: boolean, fromScene = false): void {
    if (!myTurn) {
      // Not your turn: the card only gets its explanation (look, don't play).
      this.preview = this.preview === c.id && !fromScene ? null : c.id;
      clearTimeout(this.previewTimer);
      if (this.preview) this.previewTimer = window.setTimeout(() => { this.preview = null; this.renderTip(); }, 4500);
      this.renderTip();
      return;
    }
    // A second tap on the same card (scene peek) keeps it selected; the confirm bar decides.
    this.preview = null;
    this.selected = this.selected === c.id && !fromScene ? null : c.id;
    sfx.play('flick');
    this.scene?.selectCard(this.selected ? c : null);
    if (!this.selected) { this.pending = null; this.prompt = null; this.renderConfirm(); }
    this.renderHand();
    this.renderTip();
  }

  /** One-line card explanation above the selected card (3D hand or 2D fallback hand); never blocks taps. */
  private renderTip(): void {
    const id = this.selected ?? this.preview;
    const c = id ? this.v?.hand.find((x) => x.id === id) : undefined;
    this.tip.hidden = !c;
    this.tipFor = c?.id ?? null;
    if (!c) { clear(this.tip); return; }
    const label = c.rank === 'J' ? T.rankJ : c.rank === 'Q' ? T.rankQ : c.rank === 'K' ? T.rankK : c.rank === 'A' ? T.rankA : c.rank;
    clear(this.tip, h('b', null, h('bdi', null, label + (SUIT[c.suit] ?? ''))), ' ', T.cardTip(c.rank));
    this.follow();
  }

  /** Keep the tooltip above its card and the pirate's name tag under him while the camera moves. */
  private follow(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const box = this.el.getBoundingClientRect(), sc = this.sceneEl.getBoundingClientRect();
      const ox = sc.left - box.left, oy = sc.top - box.top;
      if (!this.tip.hidden && this.tipFor) {
        let a: { x: number; y: number } | null = null;
        const two = this.el.classList.contains('no2d') ? null : this.hand.querySelector<HTMLElement>(`[data-card="${CSS.escape(this.tipFor)}"]`);
        if (two) { const r = two.getBoundingClientRect(); a = { x: r.left + r.width / 2 - box.left, y: r.top - box.top - 22 }; }
        else { const s = this.scene?.cardAnchor(this.tipFor); if (s) a = { x: s.x + ox, y: s.y + oy - 8 }; }
        const w = this.tip.offsetWidth || 200, hh = this.tip.offsetHeight || 36;
        const x = Math.min(Math.max(8 + w / 2, a?.x ?? box.width / 2), box.width - 8 - w / 2);
        const minY = (this.status.offsetHeight || 56) + 8 + hh;
        const y = Math.max(minY, a?.y ?? box.height * 0.6);
        this.tip.style.left = x + 'px'; this.tip.style.top = y + 'px';
      }
      const n = this.scene?.npcAnchor();
      // HTML name tag only when the 3D badge is too small to read (phones).
      const show = !!n?.badge && n.badge.w < 64;
      this.npcTag.hidden = !show;
      if (show && n?.badge) {
        const w = this.npcTag.offsetWidth || 110;
        const x = Math.min(Math.max(4 + w / 2, n.badge.x + ox), box.width - 4 - w / 2);
        this.npcTag.style.left = x + 'px'; this.npcTag.style.top = (n.badge.y + oy + 10) + 'px';
      }
      this.jokes.reposition();
    });
  }

  /** The pirate reads a line (button joke, silence filler): paper out of the pocket, bubble above his head. */
  async npcSay(lines: string[], o: { tag?: string; ms?: number[] } = {}): Promise<void> {
    const anchor = () => { const a = this.scene?.npcAnchor().head; return a ?? null; };
    if (!this.scene?.active) { this.sayLines(lines, () => null, o); return; }
    const job = ++this.npcJob;
    await this.scene.npcRead();
    if (job !== this.npcJob) return; // a newer joke took over
    this.sayLines(lines, anchor, o);
    // Fold the paper away when he is done, even if another bubble (dealer cue) cut him short.
    const total = lines.reduce((t, l, i) => t + (o.ms?.[i] ?? (l.length > 90 ? 7000 : 5000)), 0);
    clearTimeout(this.npcTimer);
    this.npcTimer = window.setTimeout(() => { if (job === this.npcJob) this.scene?.npcDone(); }, total + 200);
  }
  private npcJob = 0;
  private npcTimer = 0;
  private sayLines(lines: string[], anchor: () => { x: number; y: number } | null, o: { tag?: string; ms?: number[] }): void {
    const next = (i: number) => {
      const text = lines[i];
      if (!text) return;
      this.jokes.say(text, anchor, { tag: i === lines.length - 1 ? o.tag : T.npcName, ms: o.ms?.[i], onDone: () => next(i + 1) });
    };
    next(0);
  }

  /** Unread chat count lives on the dock's chat button; kept here for the accessible label only. */
  setUnread(n: number): void { this.unread = n; }

  private tickClock(): void {
    const v = this.v; if (!v) return;
    const c = v.clock;
    const el = c.startedAt === null ? 0 : c.elapsedMs + (c.paused ? 0 : Date.now() - this.clockAt);
    clear(this.clockEl, fmtMs(el), h('span', { class: 'ex' }, ` / ${fmtMs(c.expectedMs)}`));
    this.clockEl.setAttribute('aria-label', `${T.elapsedL} ${fmtMs(el)}, ${T.expected} ${fmtMs(c.expectedMs)}`);
  }

  private renderViewPick(): void {
    const v = this.v; const old = this.el.querySelector('.viewpick'); old?.remove();
    if (!v || v.you.seat !== null || !this.scene) return;
    const box = h('div', { class: 'viewpick', role: 'group', 'aria-label': T.viewFrom },
      ...v.seats.map((s) => button(s.name ? [...s.name][0]! : String(s.index + 1), this.viewSeat === s.index ? 'btn-primary' : 'btn-secondary',
        () => { this.viewSeat = s.index; this.scene?.setViewSeat(s.index); this.renderViewPick(); })));
    this.el.append(box);
  }

  destroy(): void { clearInterval(this.clockTimer); clearTimeout(this.previewTimer); clearTimeout(this.npcTimer); cancelAnimationFrame(this.raf); this.jokes.hide(); document.documentElement.classList.remove('hand2d'); }

  /** Mark seat tiles / voice participants as speaking (called by the voice layer). */
  speaking(ids: Set<string>): void {
    this.el.querySelectorAll<HTMLElement>('[data-pid]').forEach((e) => e.classList.toggle('speaking', ids.has(e.dataset.pid ?? '')));
  }
}
export { seatTile };
