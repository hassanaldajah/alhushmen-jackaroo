/** Strict schema validation for client messages. Returns null for anything unexpected. */

import {
  CHAT_MAX_LEN, MAX_MSG_BYTES, MAX_NAME_LEN, VIDEO_ID_RE, type ClientMsg, type Move,
} from '../shared/protocol';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const ID_RE = /^[0-9a-f]{8,16}$/;
const CARD_RE = /^(10|[2-9AJQK])[SHDC]$/;

function onlyKeys(o: Obj, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function move(x: unknown): Move | null {
  if (!isObj(x)) return null;
  switch (x.k) {
    case 'out':
      return onlyKeys(x, ['k', 'marble']) && isInt(x.marble, 0, 15) ? { k: 'out', marble: x.marble } : null;
    case 'step':
      return onlyKeys(x, ['k', 'marble', 'n']) && isInt(x.marble, 0, 15) && isInt(x.n, 1, 12) ? { k: 'step', marble: x.marble, n: x.n } : null;
    case 'swap':
      return onlyKeys(x, ['k', 'marble', 'target']) && isInt(x.marble, 0, 15) && isInt(x.target, 0, 15)
        ? { k: 'swap', marble: x.marble, target: x.target } : null;
    case 'burn':
      return onlyKeys(x, ['k']) ? { k: 'burn' } : null;
    case 'discard':
      return onlyKeys(x, ['k']) ? { k: 'discard' } : null;
    default:
      return null;
  }
}

/**
 * Display names (server is the authority): NFKC; control, format (bidi overrides, zero-width), line/paragraph
 * separators and noncharacters removed; markup removed (tags, then any leftover < > ` characters);
 * runs of more than 2 combining marks cut (no "zalgo"); whitespace collapsed; 1..MAX_NAME_LEN code points;
 * must contain at least one letter or digit. Rendered client-side with textContent only.
 */
export function cleanName(x: unknown): string | null {
  if (typeof x !== 'string' || x.length > 64) return null;
  const s = x.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>`]/g, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length < 1 || chars.length > MAX_NAME_LEN || !/[\p{L}\p{N}]/u.test(s)) return null;
  return s;
}

/**
 * Chat text: NFKC; control chars, line breaks and format chars (bidi overrides, zero-width) removed except
 * ZWJ U+200D (emoji sequences); zalgo runs cut; whitespace collapsed; 1..CHAT_MAX_LEN code points.
 * Plain text only: clients render it with textContent, never as HTML.
 */
export function cleanChat(x: unknown): string | null {
  if (typeof x !== 'string' || x.length > CHAT_MAX_LEN * 4) return null;
  const s = x.normalize('NFKC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/(?!\u{200D})\p{Cf}/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  const n = Array.from(s).length;
  return n >= 1 && n <= CHAT_MAX_LEN ? s : null;
}

/** Each message type with its allowed top-level keys; anything extra is rejected (checklist 17). */
const KEYS: Record<string, string[]> = {
  name: ['name'], sit: ['seat'], ready: ['value'], kick: ['id'], play: ['cardId', 'moves'],
  qAdd: ['videoId', 'title', 'thumb'], qRemove: ['id'], qEnded: ['itemId'], qError: ['itemId'], voice: ['muted'],
  signal: ['to', 'data'], hostVote: ['choice'], hostGive: ['to'], partnerReq: ['to'], partnerAnswer: ['from', 'accept'],
  chat: ['text'], swapReq: ['to'], swapAnswer: ['from', 'accept'], qSkip: ['itemId'], qPause: ['paused'], qPlay: ['id'],
};
const BARE = ['stand', 'spectate', 'start', 'hint', 'again', 'toLobby', 'ping', 'hostClaim', 'hostVoteStart',
  'partnerCancel', 'partnerBreak', 'shuffleTeams', 'swapCancel', 'scoreboard', 'qStop'];
const isId = (x: unknown): x is string => isStr(x, 16) && ID_RE.test(x);

/** Signalling payload: {d:{type,sdp}} or {c:{candidate,...}}; size-capped, re-serialized. */
function signalData(x: unknown): unknown | null {
  if (!isObj(x)) return null;
  if (isObj(x.d) && onlyKeys(x, ['d'])) {
    const d = x.d;
    if (!['offer', 'answer', 'pranswer', 'rollback'].includes(d.type as string)) return null;
    if (d.sdp !== undefined && !isStr(d.sdp, 12000)) return null;
    return { d: { type: d.type, ...(d.sdp !== undefined ? { sdp: d.sdp } : {}) } };
  }
  if (isObj(x.c) && onlyKeys(x, ['c'])) {
    const c = x.c;
    if (!isStr(c.candidate, 2000)) return null;
    const out: Obj = { candidate: c.candidate };
    if (c.sdpMid !== undefined && c.sdpMid !== null) { if (!isStr(c.sdpMid, 64)) return null; out.sdpMid = c.sdpMid; }
    if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null) { if (!isInt(c.sdpMLineIndex, 0, 64)) return null; out.sdpMLineIndex = c.sdpMLineIndex; }
    if (c.usernameFragment !== undefined && c.usernameFragment !== null) { if (!isStr(c.usernameFragment, 256)) return null; out.usernameFragment = c.usernameFragment; }
    return { c: out };
  }
  return null;
}

/** Frame over MAX_MSG_BYTES (UTF-8 bytes for text, byteLength for binary). */
export function frameTooBig(raw: string | ArrayBuffer): boolean {
  if (typeof raw !== 'string') return raw.byteLength > MAX_MSG_BYTES;
  if (raw.length > MAX_MSG_BYTES) return true;
  return raw.length * 3 > MAX_MSG_BYTES && new TextEncoder().encode(raw).length > MAX_MSG_BYTES;
}

export function parseClientMsg(raw: string | ArrayBuffer): ClientMsg | null {
  if (typeof raw !== 'string' || frameTooBig(raw)) return null;
  let x: unknown;
  try { x = JSON.parse(raw); } catch { return null; }
  if (!isObj(x) || typeof x.t !== 'string') return null;
  if (!onlyKeys(x, ['t', ...(KEYS[x.t] ?? [])])) return null;
  if (BARE.includes(x.t)) return { t: x.t } as ClientMsg;
  switch (x.t) {
    case 'name': return typeof x.name === 'string' ? { t: 'name', name: x.name } : null;
    case 'sit': return isInt(x.seat, 0, 3) ? { t: 'sit', seat: x.seat } : null;
    case 'qSkip':
      if (x.itemId === undefined) return { t: 'qSkip' };
      return isId(x.itemId) ? { t: 'qSkip', itemId: x.itemId } : null;
    case 'chat': return typeof x.text === 'string' && x.text.length <= CHAT_MAX_LEN * 4 ? { t: 'chat', text: x.text } : null;
    case 'qPause': return typeof x.paused === 'boolean' ? { t: 'qPause', paused: x.paused } : null;
    case 'qPlay': return isId(x.id) ? { t: 'qPlay', id: x.id } : null;
    case 'hostVote': return x.choice === 'keep' || isId(x.choice) ? { t: 'hostVote', choice: x.choice as string } : null;
    case 'hostGive': return isId(x.to) ? { t: 'hostGive', to: x.to } : null;
    case 'partnerReq': return isId(x.to) ? { t: 'partnerReq', to: x.to } : null;
    case 'swapReq': return isId(x.to) ? { t: 'swapReq', to: x.to } : null;
    case 'partnerAnswer': case 'swapAnswer':
      return isId(x.from) && typeof x.accept === 'boolean' ? { t: x.t, from: x.from, accept: x.accept } : null;
    case 'ready': return typeof x.value === 'boolean' ? { t: 'ready', value: x.value } : null;
    case 'kick': return isStr(x.id, 16) && ID_RE.test(x.id) ? { t: 'kick', id: x.id } : null;
    case 'play': {
      if (!isStr(x.cardId, 3) || !CARD_RE.test(x.cardId) || !Array.isArray(x.moves) || x.moves.length < 1 || x.moves.length > 2) return null;
      const moves = x.moves.map(move);
      if (moves.some((m) => m === null)) return null;
      return { t: 'play', cardId: x.cardId, moves: moves as Move[] };
    }
    case 'qAdd': return isStr(x.videoId, 11) && VIDEO_ID_RE.test(x.videoId) ? { t: 'qAdd', videoId: x.videoId } : null;
    case 'qRemove': return isStr(x.id, 16) && ID_RE.test(x.id) ? { t: 'qRemove', id: x.id } : null;
    case 'qEnded': case 'qError':
      return isStr(x.itemId, 16) && ID_RE.test(x.itemId) ? { t: x.t, itemId: x.itemId } : null;
    case 'voice': return typeof x.muted === 'boolean' ? { t: 'voice', muted: x.muted } : null;
    case 'signal': {
      if (!isStr(x.to, 16) || !ID_RE.test(x.to)) return null;
      const data = signalData(x.data);
      return data ? { t: 'signal', to: x.to, data } : null;
    }
    default: return null;
  }
}
