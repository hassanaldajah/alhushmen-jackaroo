/**
 * Wire protocol between client and server (single source of truth).
 *
 * Transport:
 *   POST /api/auth   body {phrase}           -> 200 {ok:true} + Set-Cookie | 401 {ok:false, wait?} | 429 {ok:false, wait}
 *   GET  /api/session                        -> 200 {ok:true} | 401
 *   POST /api/logout                         -> 200, clears cookie
 *   GET  /api/search?q=...  (max 80 chars)   -> 200 {results: SearchResult[]} | 429 {retryAfter} | 403 {reason:'quota'} | 503 {reason:'disabled'}
 *   GET  /api/ice  (session required)        -> 200 {iceServers: IceServer[], turn: boolean} | 429 {retryAfter}
 *        STUN always; TURN from Cloudflare Realtime TURN and/or generic TURN_URLS secrets when configured.
 *   GET  /api/ws  (WebSocket upgrade)        -> messages below, JSON text frames, max 16 KiB each.
 *   WS close codes: CLOSE_AUTH (4401) session missing/expired, CLOSE_FULL (4409) room full,
 *                   CLOSE_KICKED (4403) removed by host, CLOSE_REPLACED (4408) same session opened elsewhere,
 *                   CLOSE_ABUSE (4429) repeated malformed frames or flooding.
 *
 * Security notes for client code: every string from the server (names, song titles) must be rendered
 * with textContent, never innerHTML. Hands of other seats are never sent; only card counts.
 */

import type { Seat as SeatIndex } from './board';
export * from './board';

export const CLOSE_AUTH = 4401;
export const CLOSE_KICKED = 4403;
export const CLOSE_REPLACED = 4408;
export const CLOSE_FULL = 4409;
/** Repeated malformed frames or flooding. */
export const CLOSE_ABUSE = 4429;

export const MAX_MSG_BYTES = 16 * 1024;
export const MAX_NAME_LEN = 16;
export const MAX_QUERY_LEN = 80;
export const MAX_SPECTATORS = 4;
export const QUEUE_CAP = 20;
export const QUEUE_PER_USER_CAP = 5;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ---------------------------------------------------------------- round 2 constants

/** Number of dealer jokes in src/client/ui/jokes-ar.ts; the server sends an index 0..JOKE_COUNT-1. */
export const JOKE_COUNT = 60;
/** Host change vote window and cooldown after a failed vote. */
export const HOST_VOTE_MS = 30_000;
export const HOST_VOTE_COOLDOWN_MS = 60_000;
/** A disconnected host keeps the crown this long, then the claim reopens. */
export const HOST_GRACE_MS = 15_000;
/** Saved game history retention (about 6 months) and hard row cap. */
export const HISTORY_MS = 183 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX = 2000;
/** Music control actions (add/skip/stop/pause/play) per person per 10 s. */
export const MUSIC_ACTS_PER_10S = 8;
/** Pending partner/seat-swap requests expire after this. */
export const REQUEST_TTL_MS = 5 * 60_000;
/**
 * Reasoned expected duration before any game is saved:
 * a marble needs ~80 steps (76 track + 4 home) at ~6.5 per forward card = ~12 cards, +1 card to come out,
 * x8 marbles per team = ~104 useful team plays; ~45% waste (discards, burns, captures, 4 backward) -> ~150
 * team plays; a team plays every other turn -> ~300 turns to the first finish, +~40 for the second team.
 * (Random-play simulation gives ~420/480 turns: an upper bound.) At ~7 s per turn -> ~40 min.
 */
export const EST_TURNS = 340;
export const EST_SEC_PER_TURN = 7;
export const EST_DEFAULT_MS = EST_TURNS * EST_SEC_PER_TURN * 1000;
/** Saved games needed before the estimate switches to the history average (of the last 20). */
export const EST_MIN_GAMES = 3;

/** Text chat: relayed by the DO, last CHAT_HISTORY kept in memory only (never persisted). */
export const CHAT_MAX_LEN = 300;
export const CHAT_HISTORY = 50;
/** Per person: at most CHAT_PER_WINDOW messages per CHAT_WINDOW_MS. */
export const CHAT_PER_WINDOW = 5;
export const CHAT_WINDOW_MS = 5_000;

/** One chat line. text is plain text: render with textContent only, never innerHTML. */
export interface ChatMsg { id: string; from: string; name: string; text: string; at: number }

export type Team = 'A' | 'B';
/** Card suits: Spades, Hearts, Diamonds, Clubs. */
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

/** id is unique within the deck, e.g. "10H", "AS". */
export interface Card { id: string; rank: Rank; suit: Suit }

/** Marble id = owner seat * 4 + index (0..15). */
export type MarbleId = number;

export type MarblePos =
  | { zone: 'base' }
  /** Absolute track square 0..TRACK_LEN-1 (see board.ts for geometry). */
  | { zone: 'track'; square: number }
  /** Home lane slot 0..3 (0 = first slot after the entry, 3 = deepest). */
  | { zone: 'home'; slot: number };

export interface MarbleView { id: MarbleId; owner: SeatIndex; pos: MarblePos }

// ---------------------------------------------------------------- moves (client intents)

/**
 * One atomic part of a play. A play is a card + an ordered list of moves:
 *  - A:  [{k:'out'}] or [{k:'step', n:1|11}]
 *  - K:  [{k:'out'}]
 *  - 2,3,5,6,8,9,Q(12): [{k:'step', n:<card value>}]
 *  - 4:  [{k:'step', n:4}]  (always backward; engine derives direction from the card)
 *  - 7:  [{k:'step', n:7}] or two steps on two different marbles summing to 7, applied in order
 *  - 10: [{k:'step', n:10}] or [{k:'burn'}]
 *  - J:  [{k:'swap', marble:<mine or partner's when finished>, target:<opponent marble>}]
 *  - no legal move with any card: [{k:'discard'}] with the chosen cardId
 */
export type Move =
  | { k: 'out'; marble: MarbleId }
  | { k: 'step'; marble: MarbleId; n: number }
  | { k: 'swap'; marble: MarbleId; target: MarbleId }
  | { k: 'burn' }
  | { k: 'discard' };

export interface Play { cardId: string; moves: Move[] }

// ---------------------------------------------------------------- music

export interface SearchResult { videoId: string; title: string; thumb: string }
export interface QueueItem { id: string; videoId: string; title: string; thumb: string; by: string; byId: string }
/** startedAt and serverNow are server epoch ms; client offset = Date.now() - serverNow. */
export interface NowPlaying {
  itemId: string; startedAt: number; serverNow: number;
  /** Paused by anyone; position = pausedAt - startedAt while paused. */
  paused?: boolean; pausedAt?: number;
}

export interface IceServer { urls: string | string[]; username?: string; credential?: string }

// ---------------------------------------------------------------- views (per socket)

export interface SeatView {
  index: SeatIndex;
  team: Team;
  /** Public member id of the occupant (also the voice peer id), null when empty. */
  id: string | null;
  name: string | null;
  ready: boolean;
  connected: boolean;
  /** Seat was held for a disconnected player and is now open for anyone. */
  open: boolean;
  /** Number of cards in hand (counts only; cards are never sent for other seats). */
  cards: number;
  /** All 4 own marbles are home; this seat now plays the partner's marbles. */
  finished: boolean;
  /** Occupant has an agreed partner (mutual request or host shuffle); the partner sits opposite. */
  paired: boolean;
  /** Seat's team already brought all 8 marbles home this game (its turns are skipped). */
  teamDone: boolean;
}

/** Pending request that involves the viewer (only those are sent). ids are public member ids. */
export interface PendingRequest { kind: 'partner' | 'swap'; from: string; to: string; at: number }

export interface HostVoteView {
  /** Who opened the vote. */
  by: string;
  /** Server epoch ms when the vote closes (no majority -> current host kept). */
  endsAt: number;
  /** Votes per choice: member id or 'keep'. */
  tally: Record<string, number>;
  /** Number of people present (the denominator; majority = floor(n/2)+1). */
  voters: number;
  /** Viewer's own vote, if cast. */
  mine: string | null;
}

/** Elapsed is server-computed and excludes time paused by a disconnect. */
export interface ClockView {
  /** Server epoch ms of game start, null in lobby. */
  startedAt: number | null;
  elapsedMs: number;
  paused: boolean;
  /** Expected total game duration. */
  expectedMs: number;
  /** 'estimate' = reasoned constant; 'history' = average of saved games. */
  expectedFrom: 'estimate' | 'history';
}

export interface TeamFinish {
  team: Team;
  /** Display names of the team's two players at game start (seat order). */
  names: string[];
  /** Elapsed game time (ms, pauses excluded) when the team got all 8 home. */
  ms: number;
  /** Game turn count when the team finished. */
  turns: number;
}

/** One finished game as saved in Durable Object storage. */
export interface GameRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turns: number;
  teams: { A: string[]; B: string[] };
  winner: Team;
  /** Finishing order, winner first. */
  order: TeamFinish[];
  /** Time and turn difference between first and second team. */
  marginMs: number;
  marginTurns: number;
}

export interface GameResult extends GameRecord {
  expectedMs: number;
  /** Stored successfully (UX: "انحفظت" vs "ما قدرنا نحفظ النتيجة"). */
  saved: boolean;
}

export interface ScoreRow { names: string[]; wins: number; games: number }

export interface Scoreboard {
  /** Per team (pair of names, sorted), most wins first. */
  teams: ScoreRow[];
  /** Per player (names has one entry), most wins first. */
  players: ScoreRow[];
  /** Most recent games first (max 30). */
  recent: GameRecord[];
  total: number;
  /** Oldest kept record time (history window is HISTORY_MS). */
  since: number | null;
}

export type MusicAct = 'add' | 'skip' | 'stop' | 'pause' | 'resume' | 'play';

export interface Spectator { id: string; name: string }

export interface VoicePeer { id: string; muted: boolean }

export interface GameView {
  marbles: MarbleView[];
  dealer: SeatIndex;
  turn: SeatIndex;
  /** Deal number within the game, increases each re-deal. */
  dealNo: number;
  /** Cards left in the draw pile (count only). */
  deck: number;
  /** Last card played or discarded (public), with who played it. */
  last: { seat: SeatIndex; card: Card; burned?: boolean; discarded?: boolean } | null;
  /** Marbles the viewer may move this turn (own, or partner's after finishing). Empty for spectators. */
  controls: MarbleId[];
  paused: boolean;
}

export type Phase = 'lobby' | 'playing' | 'ended';

export interface RoomView {
  phase: Phase;
  /** named = false until the person set a display name (UI shows name entry first). */
  you: { id: string; name: string; named: boolean; seat: SeatIndex | null; spectator: boolean; host: boolean };
  /** Current host member id; null = nobody yet (show the "أنا المضيف" claim to everyone). */
  hostId: string | null;
  hostVote: HostVoteView | null;
  /** Epoch ms until a new host vote may be opened (0 = now). */
  hostVoteCooldownUntil: number;
  /** Partner / seat-swap requests that involve the viewer. */
  requests: PendingRequest[];
  /** True when 2 complete paired teams are seated and the host may start. */
  canStart: boolean;
  clock: ClockView;
  /** Teams finished so far in the current game (winner first). */
  finishes: TeamFinish[];
  /** Set in phase 'ended'. */
  result: GameResult | null;
  /** Last music action (for the "{name} تخطّى الأغنية" toast), null if none yet. */
  musicLast: { by: string; byId: string; act: MusicAct; at: number } | null;
  seats: SeatView[];
  spectators: Spectator[];
  /** Seat whose turn it is, null outside play. */
  turnSeat: SeatIndex | null;
  /** Games won this session per team. */
  scores: { A: number; B: number };
  /** Viewer's own hand only. Empty for spectators and between deals. */
  hand: Card[];
  winner: Team | null;
  game: GameView | null;
  queue: QueueItem[];
  nowPlaying: NowPlaying | null;
  /** Everyone connected (seated + spectators), for the voice mesh. */
  voiceIds: string[];
  voice: VoicePeer[];
  names: Record<string, string>;
  serverNow: number;
}

// ---------------------------------------------------------------- client -> server

export type ClientMsg =
  | { t: 'name'; name: string }
  | { t: 'sit'; seat: number }
  | { t: 'stand' }
  | { t: 'spectate' }
  | { t: 'ready'; value: boolean }
  | { t: 'start' }
  | { t: 'kick'; id: string }
  | { t: 'play'; cardId: string; moves: Move[] }
  /** Ask for legal plays (help highlight). Reply: {t:'hint'}. Never auto-plays. */
  | { t: 'hint' }
  /** Host: new game after a win. */
  | { t: 'again' }
  /** Host: back to lobby (ends current game). */
  | { t: 'toLobby' }
  // ---- host (no pre-assigned host; first processed claim wins)
  | { t: 'hostClaim' }
  /** Open a change-host vote (one at a time, cooldown after a failed one). */
  | { t: 'hostVoteStart' }
  /** Cast/replace own vote: a present member id (self-nomination allowed) or 'keep'. */
  | { t: 'hostVote'; choice: string }
  /** Host hands the crown to a present member. */
  | { t: 'hostGive'; to: string }
  // ---- teams (lobby only; both sides must be seated players)
  | { t: 'partnerReq'; to: string }
  | { t: 'partnerCancel' }
  | { t: 'partnerAnswer'; from: string; accept: boolean }
  | { t: 'partnerBreak' }
  /** Host: random pairing of the 4 seated players. */
  | { t: 'shuffleTeams' }
  // ---- seat swap (lobby / between games only): exchange places with another person (player<->spectator or seats)
  | { t: 'swapReq'; to: string }
  | { t: 'swapCancel' }
  | { t: 'swapAnswer'; from: string; accept: boolean }
  /** Ask for the saved scoreboard. Reply: {t:'scoreboard'}. */
  | { t: 'scoreboard' }
  /** Text chat line (1..CHAT_MAX_LEN chars after cleaning; requires a display name). */
  | { t: 'chat'; text: string }
  /** title/thumb are ignored by the server (it uses its own search cache / videos lookup). */
  | { t: 'qAdd'; videoId: string; title?: string; thumb?: string }
  | { t: 'qRemove'; id: string }
  /** Anyone may skip; with itemId the skip only applies if that item is still the current one. */
  | { t: 'qSkip'; itemId?: string }
  /** Anyone: stop the current song (it is removed; queue stays, nothing plays until qPlay/qAdd). */
  | { t: 'qStop' }
  /** Anyone: pause/resume the current song for everyone. */
  | { t: 'qPause'; paused: boolean }
  /** Anyone: play this queued item now. */
  | { t: 'qPlay'; id: string }
  | { t: 'qEnded'; itemId: string }
  /** Player reports the current video cannot be embedded; server auto-skips it. */
  | { t: 'qError'; itemId: string }
  | { t: 'voice'; muted: boolean }
  /** WebRTC signalling relay. data: {d: RTCSessionDescriptionInit} | {c: RTCIceCandidateInit}. */
  | { t: 'signal'; to: string; data: unknown }
  | { t: 'ping' };

// ---------------------------------------------------------------- server -> client

export type EventKind =
  | 'shuffle' | 'deal' | 'throw' | 'hop' | 'out' | 'capture' | 'swap'
  | 'burn' | 'discard' | 'home' | 'finish' | 'win' | 'pause' | 'resume'
  /** win = first team finished (play continues); teamDone = second team finished; over = game ended. */
  | 'teamDone' | 'over';

export interface GameEvent {
  kind: EventKind;
  seat?: SeatIndex;
  marble?: MarbleId;
  /** Second marble: swap target, or for capture the capturing marble (marble = the captured one). */
  other?: MarbleId;
  from?: MarblePos;
  to?: MarblePos;
  card?: Card;
  /** Signed step count for hops (negative = backward). */
  n?: number;
  team?: Team;
}

export type ErrorCode =
  | 'bad_msg' | 'too_big' | 'rate' | 'not_turn' | 'illegal' | 'no_card' | 'not_player'
  | 'not_host' | 'seat_taken' | 'full' | 'not_lobby' | 'not_ready' | 'paused'
  | 'queue_full' | 'unknown_video' | 'not_allowed' | 'name'
  | 'name_taken' | 'not_named' | 'host_taken' | 'vote_open' | 'vote_cooldown' | 'no_vote'
  | 'not_seated' | 'has_partner' | 'no_request' | 'teams_incomplete' | 'chat'
  /** Kicked recently (30 min): that name cannot be used, and that network may only spectate. */
  | 'banned';

/** Informational toasts (not errors). name/by are display names (render with textContent). */
export type NoticeCode =
  | 'host_claimed' | 'host_left' | 'host_changed' | 'host_kept'
  | 'partner_request' | 'partner_declined' | 'partner_taken' | 'team_formed' | 'team_broken' | 'teams_shuffled'
  | 'swap_request' | 'swap_declined' | 'swapped' | 'game_saved' | 'save_failed';

export type ServerMsg =
  | { t: 'view'; view: RoomView }
  /** Animation cues for the last action; always followed or preceded by a fresh view. */
  | { t: 'event'; kind: EventKind; seat?: SeatIndex; events: GameEvent[] }
  | { t: 'hint'; plays: Play[] }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'error'; code: ErrorCode; detail?: string }
  | { t: 'pong'; serverNow: number }
  /** Dealer joke cue on every deal: index into the client joke list, no repeat until all JOKE_COUNT used. */
  | { t: 'joke'; seat: SeatIndex; index: number; dealNo: number }
  | { t: 'scoreboard'; board: Scoreboard }
  /** New chat line for everyone (also echoed to the sender). */
  | { t: 'chat'; msg: ChatMsg }
  /** Sent once right after connecting: last CHAT_HISTORY lines, oldest first. */
  | { t: 'chatHistory'; msgs: ChatMsg[] }
  | { t: 'notice'; code: NoticeCode; name?: string; by?: string };
