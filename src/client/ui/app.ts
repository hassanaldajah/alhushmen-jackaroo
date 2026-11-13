import type { Net, NoticeCode, RoomView } from '../net/types';
import { VoiceMesh } from '../voice/mesh';
import { sfx } from '../audio/sfx';
import { h, clear } from './dom';
import { T } from './ar';
import { mountGate } from './gate';
import { createDock } from './dock';
import { playIntro } from './intro';
import { renderLobby, setNameError } from './lobby';
import { Table } from './table';
import { MusicCard } from './musicCard';
import { SceneBridge } from './bridge';
import { Chat } from './chat';
import { openHelp, openSettings, openSongs, openVoice, openVoicePrompt } from './sheets';
import { openHostVote, openResult, openScoreboard } from './results';
import { button, toast, toastAction } from './widgets';
import './round2.css';

export function startApp(root: HTMLElement, net: Net): void {
  const html = document.documentElement;
  html.dataset.motion = localStorage.getItem('motion') ?? '';
  html.dataset.hc = localStorage.getItem('hc') ?? '0';
  if (!html.dataset.motion) delete html.dataset.motion;

  let view: RoomView | null = null;
  let table: Table | null = null;
  let bridge: SceneBridge | null = null;
  let music: MusicCard | null = null;
  let voiceStarted = false;
  let voicePrompted = false;
  let voiceHinted = false;
  let songs: { refresh(): void } | null = null;
  let voiceSheet: { refresh(v: RoomView): void } | null = null;
  let hostVote: { refresh(v: RoomView): void; close(): void } | null = null;
  let result: { refresh(v: RoomView): void; close(): void } | null = null;
  let resultShown = false;
  let banner: HTMLElement | null = null;
  let lastMusicAt = 0;
  const voice = new VoiceMesh(net);
  const chat = new Chat(net, () => view?.you.id ?? '');
  const dock = createDock(() => micToggle(), () => chat.show());
  document.body.append(dock.el);
  dock.setMic('listen', false);
  chat.onUnread = (n) => { table?.setUnread(n); dock.setUnread(n); };

  // First user tap unlocks audio (autoplay policy).
  const unlock = () => { sfx.unlock(); };
  addEventListener('pointerdown', unlock, { once: true });
  addEventListener('keydown', unlock, { once: true });

  const speakingIds = () => {
    const s = new Set<string>(); voice.peers.forEach((p, id) => { if (p.speaking) s.add(id); });
    if (voice.selfSpeaking && view) s.add(view.you.id);
    return s;
  };
  voice.onChange = () => {
    table?.setMic(voice.micState, voice.selfSpeaking);
    dock.setMic(voice.micState, voice.selfSpeaking);
    table?.speaking(speakingIds());
    document.querySelectorAll<HTMLElement>('[data-pid]').forEach((e) => e.classList.toggle('speaking', speakingIds().has(e.dataset.pid ?? '')));
    if (view) voiceSheet?.refresh(view);
  };
  voice.onBlocked = (b) => { if (b) toast('اضغط على الشاشة لتسمع أصوات اللاعبين'); };
  addEventListener('pointerdown', () => voice.unlock());
  voice.onSpeaking = (any) => { sfx.duck(any); music?.player.duck(any); };
  // Voice may fail on some networks: point people to the chat/fallback once, after a grace period.
  window.setInterval(() => {
    if (!voiceHinted && voice.noneConnected && [...voice.peers.values()].every((p) => p.status === 'failed')) { voiceHinted = true; toast(T.voiceHint); }
  }, 5000);

  const micToggle = () => {
    voice.unlock();
    // One tap = ask for the mic straight away (the tap itself is the user gesture the browser needs).
    if (voice.micState === 'listen') { voicePrompted = true; void voice.enableMic(); return; }
    if (voice.micState === 'denied') { toast(T.micDenied, true); return; }
    voice.toggle();
  };

  function ensureVoice(v: RoomView): void {
    if (!voiceStarted) { voiceStarted = true; void voice.start(v.you.id).then(() => voice.setRoster(v.voiceIds)); }
    else voice.setRoster(v.voiceIds);
  }

  const openScore = () => openScoreboard(net, view?.you.name ?? '');

  function dropTable(): void {
    table?.destroy(); bridge?.dispose();
    table = null; bridge = null; music = null;
  }

  function show(v: RoomView): void {
    if (v.phase === 'lobby') {
      if (table) dropTable();
      resultShown = false; result?.close(); result = null; clear(root);
      renderLobby(root, v, net, {
        remembered: localStorage.getItem('name'),
        openScore, openChat: () => chat.show(),
        setName: (n, spec) => {
          localStorage.setItem('name', n);
          net.send({ t: 'name', name: n });
          if (spec) net.send({ t: 'spectate' });
        },
      });
      speakingMark();
      return;
    }
    if (!table) {
      bridge = new SceneBridge(net);
      bridge.onQuality((q, reason) => {
        if (reason === 'auto' && q === 'low') toastAction(T.qualityAuto, T.undo, () => bridge?.setQuality('high'));
      });
      table = new Table(net, bridge, bridge, {
        help: () => openHelp(() => table?.hintsOn ?? false, (on) => table?.hint(on), !!view && view.you.seat === view.turnSeat),
        voice: () => { if (view) voiceSheet = openVoice(view, voice); },
        menu: () => openSettings(root, { quality: () => bridge?.quality ?? 'high', set: (q) => bridge?.setQuality(q) }),
        micToggle, chat: () => chat.show(), songs: () => { if (view) songs = openSongs(net, () => view!, () => true); },
      });
      clear(root, table.el);
      music = new MusicCard(net, table.el);
      table.setMic(voice.micState, false);
    }
    table.update(v);
    if (v.phase === 'ended') {
      if (!resultShown) { resultShown = true; result = openResult(v, net, openScore, () => { result = null; }); }
      else result?.refresh(v);
    }
  }
  function speakingMark(): void { root.querySelectorAll<HTMLElement>('[data-pid]').forEach((e) => e.classList.toggle('speaking', speakingIds().has(e.dataset.pid ?? ''))); }

  const musicToast = (v: RoomView) => {
    const m = v.musicLast;
    if (!m || m.at === lastMusicAt) return;
    const first = lastMusicAt === 0;
    lastMusicAt = m.at;
    if (first || m.byId === v.you.id) return;
    if (m.act === 'skip') toast(T.musicSkipped(m.by));
    else if (m.act === 'stop') toast(T.musicStopped(m.by));
    else if (m.act === 'pause') toast(T.musicPaused(m.by));
  };

  net.on('view', (v) => {
    view = v; ensureVoice(v); dock.show(true);
    show(v);
    music?.update(v);
    songs?.refresh();
    voiceSheet?.refresh(v);
    musicToast(v);
    // Change-host vote sheet follows the server state.
    if (v.hostVote && !hostVote) hostVote = openHostVote(v, net, () => { hostVote = null; });
    else if (v.hostVote) hostVote?.refresh(v);
    else if (hostVote) { hostVote.close(); hostVote = null; }
  });
  net.on('event', (e) => {
    const k = e.kind;
    if (k === 'deal') sfx.play('flick');
    else if (k === 'shuffle' || k === 'throw' || k === 'hop' || k === 'capture') sfx.play(k);
    else if (k === 'discard' || k === 'burn') sfx.play('throw');
    bridge?.onEvent(k, e.events ?? []);
  });
  net.on('joke', (j) => table?.jokes.show(j.seat, j.index));
  net.on('error', (e) => {
    if (e.code === 'name' || e.code === 'name_taken' || (e.code === 'banned' && view && !view.you.named)) { setNameError(e.code); if (view && !view.you.named) show(view); return; }
    toast(T.errors[e.code] ?? T.illegal, true);
  });
  const notices: Record<NoticeCode, (n: string, by: string) => string> = {
    host_claimed: (n) => T.nHostClaimed(n), host_left: () => T.nHostLeft, host_changed: (n) => T.nHostChanged(n), host_kept: () => T.nHostKept,
    partner_request: (n) => T.nPartnerReq(n), partner_declined: (n) => T.nPartnerNo(n), partner_taken: () => T.nPartnerTaken,
    team_formed: () => T.nTeam, team_broken: () => T.nTeamBroken, teams_shuffled: () => T.nShuffled,
    swap_request: (n) => T.nSwapReq(n), swap_declined: (n) => T.nSwapNo(n), swapped: () => T.nSwapped, game_saved: () => T.nSaved, save_failed: () => T.nSaveFail,
  };
  net.on('notice', (m) => {
    const f = notices[m.code]; if (!f) return;
    toast(f(m.name ?? m.by ?? '', m.by ?? ''), m.code === 'save_failed');
  });
  net.on('status', (s) => {
    banner?.remove(); banner = null;
    if (s === 'expired') { mountGate(root, net, begin, T.expired); return; }
    if (s === 'full') { clear(root, h('div', { class: 'screen' }, h('div', { class: 'center panel' }, h('h1', null, T.roomFull)))); return; }
    if (s === 'kicked' || s === 'replaced') { clear(root, h('div', { class: 'screen' }, h('div', { class: 'center panel' }, h('h1', null, T.kicked)))); return; }
    if (s === 'retrying' || s === 'lost') {
      banner = h('div', { class: 'banner', role: 'status' }, s === 'lost' ? T.lost : T.retrying,
        s === 'lost' ? button(T.retry, 'btn-secondary', () => net.connect()) : null);
      document.body.append(banner);
    }
  });

  function begin(): void { net.connect(); }
  playIntro(root, () => {
    // A valid 12 h login cookie means a refresh goes straight in; otherwise show the passphrase gate.
    void (net.hasSession?.() ?? Promise.resolve(false)).then((ok) => { if (ok) begin(); else mountGate(root, net, begin); });
  });
}
