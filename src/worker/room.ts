/**
 * GameRoom Durable Object (SQLite-backed, WebSocket Hibernation).
 * Holds all game/lobby/music state, auth rate limits and the YouTube cache.
 * Internal endpoints are reachable only via the Worker binding (never routed publicly).
 */

import { DurableObject } from 'cloudflare:workers';
import { cryptoRng } from '../engine/rng';
import {
  globalWait, ipBucket, phraseMatches, randomHex, recordFailure, waitSeconds, RL_GLOBAL_WINDOW_MS, type GlobalRate, type RateRecord,
} from './auth';
import { RoomCore, emptyRoom, type GameStore, type Out, type RoomState } from './core';
import { frameTooBig, parseClientMsg } from './validate';
import { iceServers, type TurnixCache } from './ice';
import { YT_CACHE_MS, YT_DAILY_CAP, YT_PER_USER_PER_MIN, normalizeQuery, ytSearch, ytVideo } from './youtube';
import { HISTORY_MAX, HISTORY_MS, VIDEO_ID_RE, type GameRecord, type SearchResult } from '../shared/protocol';
import type { Env } from './env';

interface Attachment { key: string; sid: string; muted: boolean }

const enc = new TextEncoder();
const ICE_PER_10MIN = 20;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export class GameRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  private core!: RoomCore;
  /** Short-lived Turnix credential reused for a few minutes (memory only). */
  private turnixCache: { v: TurnixCache | null } = { v: null };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_rl (ip TEXT PRIMARY KEY, fails INTEGER, until INTEGER, last INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS yt_cache (q TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS yt_meta (id TEXT PRIMARY KEY, title TEXT, thumb TEXT, at INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS yt_rl (sid TEXT PRIMARY KEY, at INTEGER, n INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS yt_neg (id TEXT PRIMARY KEY, at INTEGER)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ice_rl (sid TEXT PRIMARY KEY, at INTEGER, n INTEGER)`);
      // Finished games (scoreboard): pruned to HISTORY_MS (~6 months) and HISTORY_MAX rows.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, at INTEGER NOT NULL, v TEXT NOT NULL)`);
      const state = this.kvGet<RoomState>('room') ?? emptyRoom();
      this.core = new RoomCore(state, {
        rng: cryptoRng,
        newId: () => randomHex(5),
        videoMeta: (id) => this.meta(id),
        store: this.gameStore(),
      });
      // Rebuild connections after hibernation.
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a) this.core.conns.set(a.key, { key: a.key, sid: a.sid, muted: a.muted });
      }
    });
  }

  // ---------------------------------------------------------------- storage helpers

  private kvGet<T>(k: string): T | null {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }
  private kvSet(k: string, v: unknown): void {
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(v));
  }
  private gameStore(): GameStore {
    let cache: GameRecord[] | null = null;
    const prune = () => {
      this.sql.exec('DELETE FROM games WHERE at < ?', Date.now() - HISTORY_MS);
      this.sql.exec('DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY at DESC LIMIT ?)', HISTORY_MAX);
    };
    return {
      save: (rec) => {
        this.sql.exec('INSERT OR REPLACE INTO games (id, at, v) VALUES (?, ?, ?)', rec.id, rec.endedAt, JSON.stringify(rec));
        prune();
        cache = null;
        return true;
      },
      list: () => {
        if (!cache) {
          prune();
          cache = this.sql.exec<{ v: string }>('SELECT v FROM games ORDER BY at DESC LIMIT ?', HISTORY_MAX)
            .toArray().map((r) => JSON.parse(r.v) as GameRecord);
        }
        // Drop records that aged out since the cache was filled.
        const cut = Date.now() - HISTORY_MS;
        return cache.filter((g) => g.endedAt >= cut);
      },
    };
  }

  private meta(id: string): { title: string; thumb: string } | null {
    const row = this.sql.exec<{ title: string; thumb: string }>('SELECT title, thumb FROM yt_meta WHERE id = ?', id).toArray()[0];
    return row ? { title: row.title, thumb: row.thumb } : null;
  }
  private saveMeta(items: SearchResult[], now: number): void {
    for (const it of items) this.sql.exec('INSERT OR REPLACE INTO yt_meta (id, title, thumb, at) VALUES (?, ?, ?, ?)', it.videoId, it.title, it.thumb, now);
  }

  private async persist(): Promise<void> {
    if (this.core.dirty) {
      this.kvSet('room', this.core.s);
      this.core.dirty = false;
    }
    const next = this.core.nextAlarm();
    if (next !== null) {
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
    }
  }

  private dispatch(outs: Out[]): void {
    for (const o of outs) {
      if ('close' in o) {
        for (const ws of this.ctx.getWebSockets(o.close)) {
          try { ws.close(o.code, o.reason); } catch { /* already closed */ }
        }
        continue;
      }
      const data = JSON.stringify(o.msg);
      for (const ws of this.ctx.getWebSockets(o.to)) {
        try { ws.send(data); } catch { /* socket gone; close handler cleans up */ }
      }
    }
  }

  // ---------------------------------------------------------------- HTTP (internal)

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/internal/ws': return this.acceptWs(req);
      case '/internal/auth': return this.auth(req);
      case '/internal/search': return this.search(req, url);
      case '/internal/ice': return this.ice(req);
      default: return json({ ok: false }, 404);
    }
  }

  private async acceptWs(req: Request): Promise<Response> {
    const sid = req.headers.get('X-Sid');
    if (!sid || !/^[0-9a-f]{32}$/.test(sid) || req.headers.get('Upgrade') !== 'websocket') return json({ ok: false }, 400);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const key = randomHex(8);
    this.ctx.acceptWebSocket(server, [key]);
    server.serializeAttachment({ key, sid, muted: true } satisfies Attachment);
    this.dispatch(this.core.connect(key, sid, Date.now()));
    await this.persist();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async ipKey(ip: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', enc.encode('ip:' + (this.env.SESSION_SECRET ?? '') + ':' + ipBucket(ip)));
    return Array.from(new Uint8Array(d).slice(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
  }

  private async auth(req: Request): Promise<Response> {
    const now = Date.now();
    const { ip, phrase, known } = (await req.json()) as { ip: string; phrase: string; known?: boolean };
    if (!this.env.PASSPHRASE || !this.env.SESSION_SECRET) return json({ ok: false });

    // Await nothing between reading and writing the counters (DO is single-threaded between awaits).
    const k = await this.ipKey(ip);
    const g = this.kvGet<GlobalRate>('auth_global');
    const glob: GlobalRate = !g || now - g.start > RL_GLOBAL_WINDOW_MS ? { start: now, fails: 0, last: now } : { ...g, last: g.last ?? g.start };
    // Global gate slows down (never locks out); browsers that held a session skip it (M3).
    const gw = globalWait(glob, now, !!known);
    if (gw > 0) return json({ ok: false, wait: gw });

    const rec = this.sql.exec<RateRecord>('SELECT fails, until, last FROM auth_rl WHERE ip = ?', k).toArray()[0] ?? null;
    const wait = waitSeconds(rec, now);
    if (wait > 0) return json({ ok: false, wait });

    // Count the attempt BEFORE the (async) compare so parallel requests cannot exceed the limit (checklist 10).
    const next = recordFailure(rec, now);
    this.sql.exec('INSERT OR REPLACE INTO auth_rl (ip, fails, until, last) VALUES (?, ?, ?, ?)', k, next.fails, next.until, next.last);
    this.sql.exec('DELETE FROM auth_rl WHERE last < ?', now - 24 * 60 * 60 * 1000);
    this.kvSet('auth_global', { start: glob.start, fails: glob.fails + 1, last: now } satisfies GlobalRate);
    const ok = await phraseMatches(phrase, this.env.PASSPHRASE, this.env.SESSION_SECRET);
    if (ok) {
      // Success: undo the provisional failure.
      this.sql.exec('DELETE FROM auth_rl WHERE ip = ?', k);
      const g2 = this.kvGet<GlobalRate>('auth_global');
      if (g2 && g2.start === glob.start && g2.fails > 0) this.kvSet('auth_global', { ...g2, fails: g2.fails - 1 });
      return json({ ok: true });
    }
    const w = waitSeconds(next, now);
    return json(w > 0 ? { ok: false, wait: w } : { ok: false });
  }

  /** Per-user YouTube call budget (search + video lookups share it). Returns false when exhausted. */
  private ytUserTake(sid: string, now: number): boolean {
    const rl = this.sql.exec<{ at: number; n: number }>('SELECT at, n FROM yt_rl WHERE sid = ?', sid).toArray()[0];
    const win = !rl || now - rl.at > 60_000 ? { at: now, n: 0 } : rl;
    if (win.n >= YT_PER_USER_PER_MIN) return false;
    this.sql.exec('INSERT OR REPLACE INTO yt_rl (sid, at, n) VALUES (?, ?, ?)', sid, win.at, win.n + 1);
    this.sql.exec('DELETE FROM yt_rl WHERE at < ?', now - 10 * 60_000);
    return true;
  }

  /** Global daily cap on upstream YouTube calls. */
  private ytDayTake(now: number): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    const d = this.kvGet<{ day: string; n: number }>('yt_day');
    const used = d && d.day === day ? d.n : 0;
    if (used >= YT_DAILY_CAP) return false;
    this.kvSet('yt_day', { day, n: used + 1 });
    return true;
  }

  /** TURN credentials: authenticated sessions only (Worker checks), ICE_PER_10MIN per session. */
  private async ice(req: Request): Promise<Response> {
    const now = Date.now();
    const sid = req.headers.get('X-Sid') ?? '';
    if (!/^[0-9a-f]{32}$/.test(sid)) return json({ ok: false }, 400);
    const rl = this.sql.exec<{ at: number; n: number }>('SELECT at, n FROM ice_rl WHERE sid = ?', sid).toArray()[0];
    const win = !rl || now - rl.at > 600_000 ? { at: now, n: 0 } : rl;
    if (win.n >= ICE_PER_10MIN) return json({ ok: false, retryAfter: Math.ceil((win.at + 600_000 - now) / 1000) }, 429);
    this.sql.exec('INSERT OR REPLACE INTO ice_rl (sid, at, n) VALUES (?, ?, ?)', sid, win.at, win.n + 1);
    this.sql.exec('DELETE FROM ice_rl WHERE at < ?', now - 3_600_000);
    return json(await iceServers(this.env, fetch, now, this.turnixCache));
  }

  private async search(req: Request, url: URL): Promise<Response> {
    const now = Date.now();
    const sid = req.headers.get('X-Sid') ?? '';
    if (!/^[0-9a-f]{32}$/.test(sid)) return json({ ok: false }, 400);
    if (!this.env.YT_API_KEY) return json({ ok: false, reason: 'disabled' }, 503);
    const q = normalizeQuery(url.searchParams.get('q'));
    if (!q) return json({ ok: false, reason: 'bad_query' }, 400);

    if (!this.ytUserTake(sid, now)) {
      const rl = this.sql.exec<{ at: number }>('SELECT at FROM yt_rl WHERE sid = ?', sid).toArray()[0];
      return json({ ok: false, reason: 'rate', retryAfter: Math.max(1, Math.ceil(((rl?.at ?? now) + 60_000 - now) / 1000)) }, 429);
    }

    const cached = this.sql.exec<{ v: string; at: number }>('SELECT v, at FROM yt_cache WHERE q = ?', q).toArray()[0];
    if (cached && now - cached.at < YT_CACHE_MS) return json({ results: JSON.parse(cached.v) as SearchResult[] });

    if (!this.ytDayTake(now)) return json({ ok: false, reason: 'quota' }, 403);

    const res = await ytSearch(q, this.env.YT_API_KEY);
    if (!res.ok) return res.reason === 'quota' ? json({ ok: false, reason: 'quota' }, 403) : json({ ok: false, reason: 'network' }, 502);
    this.sql.exec('INSERT OR REPLACE INTO yt_cache (q, v, at) VALUES (?, ?, ?)', q, JSON.stringify(res.results), now);
    this.sql.exec('DELETE FROM yt_cache WHERE q NOT IN (SELECT q FROM yt_cache ORDER BY at DESC LIMIT 500)');
    this.saveMeta(res.results, now);
    this.sql.exec('DELETE FROM yt_meta WHERE at < ?', now - 7 * YT_CACHE_MS);
    return json({ results: res.results });
  }

  // ---------------------------------------------------------------- WebSocket hibernation handlers

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || !this.core.conns.has(a.key)) { try { ws.close(4401, 'unknown'); } catch { /* noop */ } return; }
    const msg = frameTooBig(raw) ? null : parseClientMsg(raw);
    const big = frameTooBig(raw);
    // Unknown video ids (not from our search cache) are looked up via videos.list (1 quota unit), but only
    // after the per-user YouTube limit and the global daily cap pass, and failures are negative-cached (M2).
    if (msg?.t === 'qAdd' && VIDEO_ID_RE.test(msg.videoId) && !this.meta(msg.videoId) && this.env.YT_API_KEY) {
      const now = Date.now();
      const neg = this.sql.exec<{ at: number }>('SELECT at FROM yt_neg WHERE id = ?', msg.videoId).toArray()[0];
      if (!neg && this.ytUserTake(a.sid, now) && this.ytDayTake(now)) {
        const v = await ytVideo(msg.videoId, this.env.YT_API_KEY);
        if (v) this.saveMeta([v], Date.now());
        else {
          this.sql.exec('INSERT OR REPLACE INTO yt_neg (id, at) VALUES (?, ?)', msg.videoId, now);
          this.sql.exec('DELETE FROM yt_neg WHERE at < ? OR id NOT IN (SELECT id FROM yt_neg ORDER BY at DESC LIMIT 2000)', now - YT_CACHE_MS);
        }
      }
    }
    this.dispatch(this.core.message(a.key, big ? 'too_big' : msg, Date.now()));
    const c = this.core.conns.get(a.key);
    if (c && c.muted !== a.muted) ws.serializeAttachment({ ...a, muted: c.muted } satisfies Attachment);
    await this.persist();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropSocket(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropSocket(ws);
  }

  private async dropSocket(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    this.dispatch(this.core.disconnect(a.key, Date.now()));
    await this.persist();
  }

  override async alarm(): Promise<void> {
    this.dispatch(this.core.alarm(Date.now()));
    await this.persist();
  }
}
