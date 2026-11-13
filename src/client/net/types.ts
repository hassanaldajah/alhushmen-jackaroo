// Client net types. Wire types come from the single source of truth, src/shared/protocol.ts.
import type { ClientMsg, EventKind, GameEvent, ChatMsg, NoticeCode, Play, RoomView, Scoreboard, SearchResult, Seat } from '../../shared/protocol';

export type {
  ClientMsg, ServerMsg, RoomView, SeatView, Spectator, Card, Team, QueueItem, NowPlaying, SearchResult,
  GameEvent, EventKind, ErrorCode, ChatMsg, NoticeCode, Scoreboard, ScoreRow, GameRecord, GameResult, TeamFinish, PendingRequest, HostVoteView, ClockView, Move, Play, Phase, MarbleView, GameView,
} from '../../shared/protocol';
export type { Seat };

export type SearchReply =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: 'quota' | 'rate' | 'network'; retryAfter?: number };
export type GateReply = { ok: true } | { ok: false; wait?: number; net?: boolean };

export interface ServerEvents {
  view: RoomView;
  status: 'connecting' | 'open' | 'retrying' | 'lost' | 'expired' | 'full' | 'kicked' | 'replaced';
  signal: { from: string; data: unknown };
  error: { code: string; detail?: string };
  event: { kind: EventKind; seat?: Seat; events: GameEvent[] };
  hint: { plays: Play[] };
  joke: { seat: Seat; index: number; dealNo: number };
  scoreboard: { board: Scoreboard };
  chat: { msg: ChatMsg };
  chatHistory: { msgs: ChatMsg[] };
  notice: { code: NoticeCode; name?: string; by?: string };
}

export interface Net {
  on<K extends keyof ServerEvents>(k: K, f: (v: ServerEvents[K]) => void): () => void;
  gate(pass: string): Promise<GateReply>;
  connect(): void;
  send(m: ClientMsg): void;
  search(q: string): Promise<SearchReply>;
  iceServers(): Promise<RTCIceServer[]>;
}
