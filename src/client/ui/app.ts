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
import { SceneBridge, preloadScene } from './bridge';
import { Chat } from './chat';
import { confirmHostChange, confirmLogout, openHelp, openHostMenu, openSettings, openSongs, openVoice } from './sheets';
import { openHostVote, openResult, openScoreboard } from './results';
import { anySheetOpen, button, chatToast, closeAllSheets, spinner, toast, toastAction } from './widgets';
import { JokeBag, JokeBubble, autoJokesEnabled } from './joke';
import { jokeAt } from './jokes-ar';
import './round2.css';

/** Silence filler: when nobody talked, chatted or moved for this long, the pirate reads one joke. */
const QUIET_MS = 90_000;
/** Joke button cooldown (anti-spam). */
const JOKE_COOLDOWN_MS = 3_000;
/** A server "rate" error this soon after own voice signalling is treated as signalling traffic (no toast). */
const RATE_SIGNAL_WINDOW_MS = 3_000;
/** The "زوط" gag runs on the 2nd joke-button tap of this device, then again every GAG_EVERY taps. */
const GAG_EVERY = 7;
const GAG_MS = [1300, 1000];

const idle = (f: () => void) => { const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback; if (ric) ric(f, { timeout: 2500 }); else setTimeout(f, 1200); };
const safe = (f: () => void) => { try { f(); } catch { /* storage blocked */ } };

export function startApp(root: HTMLElement, net: Net): void {
  const html = document.documentElement;
  safe(() => { html.dataset.motion = localStorage.getItem('motion') ?? ''; html.dataset.hc = localStorage.getItem('hc') ?? '0'; });
  if (!html.dataset.motion) delete html.dataset.motion;

  let view: RoomView | null = null;
  let table: Table | null = null;
  let bridge: SceneBridge | null = null;
  let music: MusicCard | null = null;
  let voiceStarted = false;
  let voiceHinted = false;
  let songs: { refresh(): void } | null = null;
  let voiceSheet: { refresh(v: RoomView): void } | null = null;
  let hostVote: { refresh(v: RoomView): void; close(): void } | null = null;
  let result: { refresh(v: RoomView): void; close(): void } | null = null;
  let resultShown = false;
  let banner: HTMLElement | null = null;
  let lastMusicAt = 0;
  /** True while a passphrase / end screen is shown: the dock (mic, joke, chat) stays hidden. */
  let gated = true;
  const voice = new VoiceMesh(net);
  const chat = new Chat(net, () => view?.you.id ?? '');
  const dock = createDock(() => micToggle(), () => chat.show(), () => jokeButton(), () => hostButton());
  document.body.append(dock.el);
  dock.setMic('listen', false);
  chat.onUnread = (n) => { table?.setUnread(n); dock.setUnread(n); };
  // Friends' lines pop up as a short bubble (lobby and table), on top of the unread badge.
  chat.onIncoming = (m) => { if (!gated) chatToast(m.name, m.text, () => chat.show()); };
  // The mic/chat/joke dock exists only inside the game: after login, with a display name.
  const syncDock = () => {
    dock.show(!gated && !!view && view.you.named);
    if (view) dock.setHost(view.hostId === null ? 'none' : view.you.host ? 'me' : 'other');
  };
  // Crown button: claim host / open the host menu / ask for a host change (vote).
  const hostButton = () => {
    const v = view; if (!v) return;
    if (v.hostId === null) net.send({ t: 'hostClaim' });
    else if (v.you.host) openHostMenu(v, net);
    else if (!v.hostVote) confirmHostChange(() => net.send({ t: 'hostVoteStart' }));
  };

  // First user tap unlocks audio (autoplay policy).
  const unlock = () => { sfx.unlock(); };
  // Phones: a touch pointerdown is not a user activation; pointerup/touchend/click are.
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) addEventListener(ev, unlock, { once: true });

  // ---- quiet-room tracking (silence filler)
  let lastActivity = Date.now();
  let lastDealAt = 0;
  const touch = () => { lastActivity = Date.now(); };

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
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click']) addEventListener(ev, () => voice.unlock(), { passive: true });
  voice.onSpeaking = (any) => { sfx.duck(any); music?.player.duck(any); if (any) touch(); };
  // Voice may fail on some networks: point people to the chat/fallback once, after a grace period.
  window.setInterval(() => {
    if (!voiceHinted && !gated && voice.noneConnected && [...voice.peers.values()].every((p) => p.status === 'failed')) { voiceHinted = true; toast(T.voiceHint); }
  }, 5000);

  const micToggle = () => {
    voice.unlock();
    // One tap = ask for the mic straight away (the tap itself is the user gesture the browser needs).
    if (voice.micState === 'listen') { void voice.enableMic(); return; }
    if (voice.micState === 'denied') { toast(T.micDenied, true); return; }
    voice.toggle();
  };

  function ensureVoice(v: RoomView): void {
    // A new person id (new session) must not keep signalling with the stale one: restart the mesh.
    if (voiceStarted && voice.id && voice.id !== v.you.id) { voice.stop(); voiceStarted = false; }
    if (!voiceStarted) { voiceStarted = true; void voice.start(v.you.id).then(() => voice.setRoster(view?.voiceIds ?? v.voiceIds)); }
    else voice.setRoster(v.voiceIds);
  }

  // ---- jokes: dock button (any player, this device only) + silence filler; the pirate أيمن reads them
  const bag = new JokeBag();
  const screenJokes = new JokeBubble(root, () => null);
  let jokeTaps = 0, lastJokeTap = 0;
  function tell(lines: string[], ms?: number[]): void {
    if (table) { void table.npcSay(lines, { tag: T.npcName, ms }); return; }
    const next = (i: number) => { const t = lines[i]; if (t) screenJokes.say(t, () => null, { tag: T.npcName, ms: ms?.[i], onDone: () => next(i + 1) }); };
    next(0);
  }
  function jokeButton(): void {
    const now = Date.now();
    if (now - lastJokeTap < JOKE_COOLDOWN_MS) return;
    lastJokeTap = now; touch();
    dock.jokeBusy(true); window.setTimeout(() => dock.jokeBusy(false), JOKE_COOLDOWN_MS);
    const text = jokeAt(bag.next());
    if (!text) return;
    jokeTaps++;
    if (jokeTaps >= 2 && (jokeTaps - 2) % GAG_EVERY === 0) tell([T.gag1, T.gag2, text], GAG_MS);
    else tell([text]);
  }
  window.setInterval(() => {
    if (gated || !view?.you.named || !autoJokesEnabled()) return;
    const now = Date.now();
    if (now - lastActivity < QUIET_MS || now - lastDealAt < 20_000) return;
    if (anySheetOpen() || table?.jokes.visible || screenJokes.visible || document.visibilityState === 'hidden') return;
    touch(); // once per quiet period
    const text = jokeAt(bag.next());
    if (text) tell([text]);
  }, 5000);

  const openScore = () => openScoreboard(net, view?.you.name ?? '');
  const askLogout = () => confirmLogout(() => void logout());
  const openMenu = () => openSettings(root, bridge ? { quality: () => bridge?.quality ?? 'high', set: (q) => bridge?.setQuality(q) } : undefined, () => void logout(),
    view?.you.host && view.phase === 'playing' ? () => net.send({ t: 'toLobby' }) : undefined);

  function dropTable(): void {
    table?.destroy(); bridge?.dispose();
    table = null; bridge = null; music = null;
  }

  function show(v: RoomView): void {
    html.classList.toggle('in-table', v.phase !== 'lobby');
    if (v.phase === 'lobby') {
      if (table) dropTable();
      resultShown = false; result?.close(); result = null; clear(root);
      renderLobby(root, v, net, {
        remembered: (() => { try { return localStorage.getItem('name'); } catch { return null; } })(),
        openScore, openChat: () => chat.show(), joke: () => jokeButton(), openMenu, logout: askLogout,
        setName: (n, spec) => {
          safe(() => localStorage.setItem('name', n));
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
        menu: openMenu,
        micToggle, chat: () => chat.show(), joke: () => jokeButton(), songs: () => { if (view) songs = openSongs(net, () => view!, () => true); },
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

  let lastTurn: number | null = null;
  net.on('view', (v) => {
    if (gated && !view) idle(() => void preloadScene()); // logged in: fetch the 3D chunk while the lobby is up
    gated = false;
    view = v; ensureVoice(v); syncDock();
    if (v.turnSeat !== lastTurn) { lastTurn = v.turnSeat; touch(); }
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
    touch();
    if (k === 'deal' || e.events?.some((x) => x.kind === 'deal')) lastDealAt = Date.now();
    if (k === 'deal') sfx.play('flick');
    else if (k === 'shuffle' || k === 'throw' || k === 'hop' || k === 'capture') sfx.play(k);
    else if (k === 'discard' || k === 'burn') sfx.play('throw');
    else if (k === 'skip' && e.seat !== undefined && view) toast(T.skipped(view.seats[e.seat]?.name ?? ''));
    bridge?.onEvent(k, e.events ?? []);
  });
  net.on('chat', () => touch());
  // Dealer cue from the server: the dealer's avatar reads it (unchanged).
  net.on('joke', (j) => table?.jokes.show(j.seat, j.index));
  net.on('error', (e) => {
    if (e.code === 'name' || e.code === 'name_taken' || (e.code === 'banned' && view && !view.you.named)) { setNameError(e.code); if (view && !view.you.named) show(view); return; }
    // 'rate' right after voice signalling is WebRTC traffic, not something the user did: never toast it.
    if (e.code === 'rate' && Date.now() - voice.lastSignalAt < RATE_SIGNAL_WINDOW_MS) return;
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

  /** Leave every in-game surface: dock hidden, sheets closed, table and voice torn down. */
  function leaveGame(): void {
    gated = true; view = null; lastTurn = null; syncDock();
    html.classList.remove('in-table');
    closeAllSheets(); banner?.remove(); banner = null;
    hostVote = null; result = null; resultShown = false; songs = null; voiceSheet = null;
    screenJokes.hide();
    dropTable();
  }
  const endScreen = (title: string, withLogin = false) => {
    leaveGame();
    clear(root, h('div', { class: 'screen' }, h('div', { class: 'center panel' }, h('h1', null, title),
      withLogin ? button(T.gateCta, 'btn-primary btn-block', () => showGate()) : null)));
  };
  net.on('status', (s) => {
    banner?.remove(); banner = null;
    if (s === 'expired') { leaveGame(); showGate(T.expired); return; }
    if (s === 'full') { endScreen(T.roomFull); return; }
    if (s === 'kicked' || s === 'replaced') { endScreen(T.kicked, true); return; }
    if (s === 'retrying' || s === 'lost') {
      banner = h('div', { class: 'banner', role: 'status' }, s === 'lost' ? T.lost : T.retrying,
        s === 'lost' ? button(T.retry, 'btn-secondary', () => net.connect()) : null);
      document.body.append(banner);
    }
  });

  /** Logout: server clears the cookie (POST /api/logout), socket closed, saved name/role/tab forgotten, back to the gate. */
  async function logout(): Promise<void> {
    leaveGame();
    voice.stop(); voiceStarted = false; voiceHinted = false;
    chat.reset();
    safe(() => { localStorage.removeItem('name'); localStorage.removeItem('role'); });
    safe(() => { sessionStorage.removeItem('tab'); sessionStorage.removeItem('pile'); });
    clear(root, h('div', { class: 'screen' }, h('div', { class: 'center panel', role: 'status' }, h('div', { class: 'row' }, spinner(), T.loggingOut))));
    if (net.logout) await net.logout(); else net.close?.();
    showGate();
  }

  function showGate(notice?: string): void {
    gated = true; syncDock();
    mountGate(root, net, begin, notice);
    idle(() => void preloadScene()); // fetch the 3D chunk while the passphrase is typed
  }
  function begin(): void {
    clear(root, h('div', { class: 'screen' }, h('div', { class: 'center panel', role: 'status' }, h('div', { class: 'row' }, spinner(), T.connecting))));
    net.connect();
  }

  // Everyone enters the passphrase every time the game is opened (also after a refresh): no auto-login.
  playIntro(root, () => showGate());
}
