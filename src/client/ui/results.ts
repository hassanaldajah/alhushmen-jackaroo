import type { Net, RoomView, Scoreboard } from '../net/types';
import { h, icon, clear, bdi } from './dom';
import { T } from './ar';
import { openSheet, button, skeletons } from './widgets';

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const teamColor = (t: 'A' | 'B') => (t === 'A' ? 'var(--team-a)' : 'var(--team-b)');
const teamName = (t: 'A' | 'B') => (t === 'A' ? T.teamA : T.teamB);
const dmy = (at: number) => { const d = new Date(at); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };

/** End-of-game result (docs/design.md 16.5). Opens only when both teams have finished (phase 'ended'). */
export function openResult(v: RoomView, net: Net, onScore: () => void, onClose: () => void): { refresh(v: RoomView): void; close(): void } {
  const s = openSheet(T.results, { center: true, onClose });
  const draw = (rv: RoomView) => {
    const r = rv.result;
    const w = (r?.winner ?? rv.winner) as 'A' | 'B' | null;
    const kids: Array<Node | null> = [];
    if (w) kids.push(h('div', { class: 'win-team', style: { color: teamColor(w) }, role: 'status' }, T.winnerOf(teamName(w))));
    if (r) {
      kids.push(h('div', { class: 'rtable' }, ...r.order.map((f, i) => h('div', { class: 'rcol', style: { borderColor: teamColor(f.team) } },
        h('strong', { style: { color: teamColor(f.team) } }, teamName(f.team)),
        h('div', { class: 'muted' }, ...f.names.flatMap((n, k) => (k ? [T.and, bdi(n)] : [bdi(n)]))),
        h('div', null, i === 0 ? T.first : T.second),
        h('div', null, `${T.finishTime}: ${fmtMs(f.ms)}`),
        h('div', null, `${T.turns}: ${f.turns}`),
        h('div', null, `${T.marblesHome}: 8/8`)))));
      kids.push(h('div', null, T.margin(fmtMs(r.marginMs), r.marginTurns)),
        h('div', { class: 'muted' }, T.total(fmtMs(r.durationMs)), ' - ', T.wasExpected(Math.round(r.expectedMs / 60000))),
        r.saved ? h('div', { class: 'muted', role: 'status' }, icon('check'), T.saved) : h('div', { class: 'err', role: 'alert' }, icon('warning'), T.saveErr));
    } else kids.push(h('div', { class: 'muted', role: 'status' }, T.saving));
    kids.push(h('div', { class: 'row wrap' },
      rv.you.host ? button(T.newGame, 'btn-primary', () => { net.send({ t: 'again' }); s.close(); }) : h('span', { class: 'muted' }, T.waitHost),
      button(T.results, 'btn-secondary', onScore),
      button(T.leaveR, 'btn-secondary', () => s.close())));
    clear(s.body, ...kids);
  };
  draw(v);
  return { refresh: draw, close: s.close };
}

/** Saved scoreboard: teams / players tabs. Requests it from the server and renders the reply. */
export function openScoreboard(net: Net, myName: string): void {
  let board: Scoreboard | null = null, tab: 'teams' | 'players' = 'teams';
  const body = h('div', { class: 'list' });
  let off: () => void = () => {};
  const s = openSheet(T.scoreboard, { tall: true, onClose: () => off() });
  const draw = () => {
    const tabs = h('div', { class: 'row' },
      button(T.teamsTab, tab === 'teams' ? 'btn-primary' : 'btn-secondary', () => { tab = 'teams'; draw(); }),
      button(T.playersTab, tab === 'players' ? 'btn-primary' : 'btn-secondary', () => { tab = 'players'; draw(); }));
    if (!board) { clear(body, tabs, ...skeletons(5)); return; }
    const rows = tab === 'teams' ? board.teams : board.players;
    const last = new Map<string, number>();
    for (const g of [...board.recent].reverse()) for (const n of [...g.teams.A, ...g.teams.B]) last.set(n, g.endedAt);
    clear(body, tabs, ...(rows.length ? rows.map((r, i) => h('div', { class: 'li srow' + (i === 0 ? ' top' : '') + (r.names.includes(myName) ? ' mine' : '') },
      h('span', { class: 'rank' }, String(i + 1)),
      h('span', { class: 'tt' }, ...r.names.flatMap((n, k) => (k ? [T.and, bdi(n)] : [bdi(n)]))),
      h('strong', null, `${r.wins} ${T.wins}`), h('span', { class: 'muted' }, `${r.games} ${T.games}`),
      h('span', { class: 'muted' }, last.has(r.names[0] ?? '') ? dmy(last.get(r.names[0]!)!) : ''))) : [h('div', { class: 'muted' }, T.noGames)]),
    h('div', { class: 'muted' }, T.keep6));
  };
  off = net.on('scoreboard', (m) => { board = m.board; draw(); });
  draw();
  net.send({ t: 'scoreboard' });
  s.body.append(body);
}

/** Change-host vote (docs/design.md 16.3). Choices: any present member or "keep". Own vote can be replaced. */
export function openHostVote(v: RoomView, net: Net, onClose: () => void): { refresh(v: RoomView): void; close(): void } {
  let iv = 0;
  const s = openSheet(T.hostSheet, { side: true, onClose: () => { clearInterval(iv); onClose(); } });
  const list = h('div', { class: 'list', role: 'radiogroup', 'aria-label': T.hostSheet });
  const prog = h('div', { class: 'muted', role: 'status' });
  let cur = v, offset = v.serverNow - Date.now();
  const draw = () => {
    const hv = cur.hostVote;
    if (!hv) { s.close(); return; }
    const choices: Array<[string, string]> = [...cur.voiceIds.map((id): [string, string] => [id, cur.names[id] ?? '?']), ['keep', T.keepHost]];
    clear(list, ...choices.map(([id, name]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(hv.mine === id), class: 'li vote' + (hv.mine === id ? ' sel' : ''),
      onclick: () => net.send({ t: 'hostVote', choice: id }) }, id === 'keep' ? name : bdi(name), h('span', { class: 'badge' }, String(hv.tally[id] ?? 0)))));
    const cast = Object.values(hv.tally).reduce((a, b) => a + b, 0);
    const left = Math.max(0, Math.ceil((hv.endsAt - (Date.now() + offset)) / 1000));
    prog.textContent = `${T.voteOf(cast, hv.voters)} - ${left}s`;
  };
  iv = window.setInterval(draw, 1000);
  s.body.append(list, prog, button(T.cancel, 'btn-secondary', () => s.close()));
  draw();
  return { refresh: (nv) => { cur = nv; offset = nv.serverNow - Date.now(); draw(); }, close: s.close };
}
