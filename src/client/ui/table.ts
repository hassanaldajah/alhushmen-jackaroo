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
const cardName = (c: Card): string =>
  (c.rank === 'J' ? T.rankJ : c.rank === 'Q' ? T.rankQ : c.rank === 'K' ? T.rankK : c.rank === 'A' ? T.rankA : c.rank) + (SUIT[c.suit] ?? '');

export interface TableActions { help(): void; voice(): void; menu(): void; micToggle(): void; songs(): void; chat(): void; joke(): void }

export class Table {
  readonly el: HTMLElement;
  private status = h('div', { class: 'status' });
  private hand = h('div', { class: 'hand', role: 'listbox', 'aria-label': T.pickCard });
  private confirmEl = h('div', { class: 'confirm', hidden: true });
  private sceneEl = h('div', { id: 'scene', role: 'img', 'aria-label': T.room });
  private mic = h('button', { type: 'button', class: 'mic muted', 'aria-pressed': 'false', 'aria-label': T.micOff });
  private hintBtn: HTMLButtonElement;
  /** First turn of the game only (server canSkip): pass the turn without throwing a card. */
  private skipBtn: HTMLButtonElement;
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
  /** The throw button was tapped for the current card: a choice that resolves to one play is sent at once. */
  private armed = false;
  private prompt: string | null = null;
  private hintOn = false;
  private hintTimer = 0;
  private lastTurn: number | null = null;
  private promptEl = h('div', { class: 'prompt', hidden: true, 'aria-live': 'polite' });
  private finEl = h('div', { class: 'finbar', hidden: true, role: 'status' });
  private clockEl = h('span', { class: 'clock' });
  private clockTime = h('span', { class: 'clock-t' });
  private clockEx = h('span', { class: 'ex' });
  private minHand: SVGLineElement | null = null;
  private secHand: SVGLineElement | null = null;
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
    this.skipBtn = button(T.skipTurn, 'btn-secondary skip-btn', () => this.skip());
    this.skipBtn.title = T.skipHint;
    this.skipBtn.setAttribute('aria-description', T.skipHint);
    this.skipBtn.hidden = true;
    this.camBtn = iconButton('camera', T.resetCam, () => this.scene?.resetCamera(), 'rail-btn cam-btn');
    this.camBtn.hidden = true;
    const speaker = iconButton('speaker', T.music, act.songs, 'rail-btn');
    const helpChip = iconButton('help', T.helpOpen, act.help, 'rail-btn');
    const voiceBtn = iconButton('voice', T.voiceTitle, act.voice, 'rail-btn');
    const rail = h('div', { class: 'rail' }, speaker, voiceBtn, helpChip, this.camBtn);
    const actions = h('div', { class: 'actions' }, this.hintBtn, button(T.jokeAyman, 'btn-secondary joke-bottom', () => act.joke(), 'joke'));
    this.el = h('div', { class: 'table' }, this.sceneEl, this.status, this.finEl, rail, actions, this.skipBtn, this.promptEl, this.confirmEl, this.tip, this.npcTag,
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
    // While the throw bar is up, the step prompt lives inside it (one place, nothing floating over the board).
    this.promptEl.hidden = !t || !this.confirmEl.hidden;
    clear(this.promptEl, t ? h('span', null, t) : null);
    if (!this.confirmEl.hidden && !(this.pending && !this.pending.alt) && !this.pending?.many) {
      const i = this.confirmEl.querySelector('.info');
      if (i) i.textContent = this.barInfo();
    }
  }

  /** Card name + what to do next, for the throw bar while no move is chosen yet. */
  private barInfo(next?: string): string {
    const c = this.selected ? this.v?.hand.find((x) => x.id === this.selected) : undefined;
    return [c ? cardName(c) : '', next ?? this.prompt ?? T.throwWait].filter(Boolean).join(' - ');
  }

  private setPending(p: PendingMove | null): void {
    // The choice made after the throw button resolved to one play: send it now (never without that tap).
    if (p?.go && this.armed && p.options.length === 1) { this.send(p.cardId, p.options[0]!.moves); return; }
    this.pending = p;
    this.renderConfirm();
  }

  /** Only reached from a user tap on the throw button (or a marble/square chosen after it). */
  private send(cardId: string, moves: PendingMove['options'][number]['moves']): void {
    this.net.send({ t: 'play', cardId, moves });
    sfx.play('throw');
    this.reset();
  }

  /**
   * Throw bar: shown from the moment a card is selected on your turn, fixed at the bottom. "ارمِ" is always
   * visible there and becomes active once a move is chosen. Cancel drops the card (full hand back).
   */
  private renderConfirm(): void {
    const p = this.pending;
    const myTurn = !!this.v && this.v.you.seat !== null && this.v.turnSeat === this.v.you.seat;
    const show = !!p || (!!this.selected && myTurn);
    this.confirmEl.hidden = !show;
    this.el.classList.toggle('confirming', show);
    if (!show) { clear(this.confirmEl); this.renderPrompt(); this.syncStrip(); return; }
    const cardId = p?.cardId ?? this.selected!;
    const go = (o: { moves: PendingMove['options'][number]['moves'] }) => this.send(cardId, o.moves); // user taps only
    const ready = p && !p.alt && !p.many ? p : null;
    const multi = !!ready && ready.options.length > 1;
    let main: HTMLElement[];
    if (ready && multi) main = ready.options.map((o) => button(`${T.throwIt}: ${o.summary}`, 'btn-primary throw-btn', () => go(o)));
    else {
      // One play: send it (the marbles then move by themselves). Several: open the choice on the board.
      const t = button(T.throwIt, 'btn-primary throw-btn', () => {
        if (ready) { go(ready.options[0]!); return; }
        if (p?.many) { this.armed = true; this.scene?.beginChoice(); }
      });
      if (!ready && !p?.many) { t.disabled = true; t.setAttribute('aria-disabled', 'true'); }
      main = [t];
    }
    // Side options while the player is still choosing a marble (e.g. burn with a 10).
    const alt = p?.alt ? [h('span', { class: 'alt' }, T.orAlso, ...p.options.map((o) => button(o.summary, 'btn-secondary', () => go(o))))] : [];
    const info = ready ? (multi ? T.pickOption : ready.options[0]?.summary ?? '') : p?.many ? this.barInfo(T.throwMany) : this.barInfo();
    clear(this.confirmEl, h('span', { class: 'info' }, info), ...alt, ...main, button(T.cancel, 'btn-secondary', () => this.reset()));
    this.renderPrompt();
    this.syncStrip();
  }

  /** Phone 3D hand: thin strip just above the throw bar while a card is selected, normal fan otherwise. */
  private syncStrip(): void {
    if (!this.scene) return;
    if (this.confirmEl.hidden || !this.selected) { this.scene.setHandStrip(null); return; }
    requestAnimationFrame(() => {
      if (this.confirmEl.hidden || !this.selected) return;
      const sc = this.sceneEl.getBoundingClientRect(), cb = this.confirmEl.getBoundingClientRect();
      if (!sc.height || !cb.height) return;
      this.scene?.setHandStrip({ bottom: Math.max(0, sc.bottom - cb.top + 8), left: Math.max(8, cb.left - sc.left), right: Math.max(8, sc.right - cb.right) });
    });
  }

  /** First-turn skip (the server decides; the button only shows while the view says canSkip). */
  private skip(): void {
    if (!this.v?.game?.canSkip) return;
    this.skipBtn.hidden = true;
    this.reset();
    this.net.send({ t: 'skip' });
  }

  private reset(): void {
    this.armed = false; this.pending = null; this.selected = null; this.preview = null; this.prompt = null; this.hint(false);
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
    this.skipBtn.hidden = !(myTurn && v.phase === 'playing' && !!v.game?.canSkip && !v.game.paused);
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
    // A second tap on the same card in the 3D scene keeps the selection AND the chosen marble/destination
    // (re-selecting it used to restart the flow, so the throw button never came up).
    if (fromScene && this.selected === c.id) return;
    this.preview = null;
    this.selected = this.selected === c.id && !fromScene ? null : c.id;
    sfx.play('flick');
    this.pending = null; this.armed = false;
    if (!this.selected) this.prompt = null;
    this.scene?.selectCard(this.selected ? c : null);
    this.renderConfirm();
    this.renderHand();
    this.renderTip();
  }

  /** One-line card explanation above the selected card (3D hand or 2D fallback hand); never blocks taps. */
  private renderTip(): void {
    // On the 3D table a selected card is explained inside the throw bar, so nothing floats over the marbles.
    const id = this.selected && this.scene?.active ? this.preview : this.selected ?? this.preview;
    const c = id ? this.v?.hand.find((x) => x.id === id) : undefined;
    this.tip.hidden = !c;
    this.tipFor = c?.id ?? null;
    if (!c) { clear(this.tip); return; }
    clear(this.tip, h('b', null, h('bdi', null, cardName(c))), ' ', T.cardTip(c.rank));
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

  /** A real-looking clock: round face, 12 ticks, minute and second hands, plus the digital time. */
  private buildClock(): void {
    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag: string, attrs: Record<string, string>, parent: Element) => {
      const e = document.createElementNS(ns, tag);
      for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
      parent.append(e);
      return e;
    };
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40'); svg.setAttribute('class', 'clock-face'); svg.setAttribute('aria-hidden', 'true');
    mk('circle', { cx: '20', cy: '20', r: '18', class: 'cf-rim' }, svg);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6, big = i % 3 === 0;
      mk('line', { x1: String(20 + Math.sin(a) * (big ? 13 : 14.5)), y1: String(20 - Math.cos(a) * (big ? 13 : 14.5)), x2: String(20 + Math.sin(a) * 16), y2: String(20 - Math.cos(a) * 16), class: 'cf-tick' }, svg);
    }
    this.minHand = mk('line', { x1: '20', y1: '20', x2: '20', y2: '9', class: 'cf-min' }, svg) as SVGLineElement;
    this.secHand = mk('line', { x1: '20', y1: '23', x2: '20', y2: '6', class: 'cf-sec' }, svg) as SVGLineElement;
    mk('circle', { cx: '20', cy: '20', r: '1.8', class: 'cf-dot' }, svg);
    clear(this.clockEl, svg, this.clockTime, this.clockEx);
  }

  private tickClock(): void {
    const v = this.v; if (!v) return;
    const c = v.clock;
    const el = c.startedAt === null ? 0 : c.elapsedMs + (c.paused ? 0 : Date.now() - this.clockAt);
    if (!this.minHand) this.buildClock();
    this.minHand!.setAttribute('transform', `rotate(${((el / 60000) % 60) * 6} 20 20)`);
    this.secHand!.setAttribute('transform', `rotate(${((el / 1000) % 60) * 6} 20 20)`);
    this.clockTime.textContent = fmtMs(el);
    this.clockEx.textContent = ` / ${fmtMs(c.expectedMs)}`;
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
