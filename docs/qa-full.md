# Full QA report (2026-11-13)

Scope: engine, room core, worker, validation, auth, client code reading. Run: `npx vitest run` 169 pass + 6 expected-fail (confirmed bugs, see `tests/qa/qa-full.test.ts`), `npm run typecheck` OK, `npm run build` OK (JS 696 KB raw / 188 KB gzip). `tests/e2e/attack.mjs` against local `wrangler dev` (synthetic phrase passed by flags, nothing written to disk): 49/49 pass. `tests/e2e/e2e.mjs` NOT run (needs playwright-core via `QA_PW`, not available). Not tested: real WebRTC, YouTube upstream, TURN, DO hibernation, browsers.

Env note: `wrangler dev --var ALLOWED_ORIGINS:http://localhost:PORT` did not take effect (value containing `:` is not parsed as expected; every Origin got 403). Workaround used: `--var ALLOWED_ORIGINS:xyz` plus new env `QA_ORIGIN=xyz` in `tests/e2e/attack.mjs`. Leftover wrangler dev servers on ports 8799, 8811, 8812, 8821, 8822 could not be stopped by me (process kill was denied); please stop them.

Counts: High 0, Medium 4, Low 9, Info 4.

## Medium

### M1. Prototype-key message type throws an unhandled TypeError (no rate limit, no error reply)
- Repro: send `{"t":"constructor"}` (also `__proto__`, `toString`, `hasOwnProperty`, `valueOf`).
- `src/worker/validate.ts:118`: `KEYS[x.t] ?? []` finds `Object.prototype` members; spreading a function or object into the array throws. `src/worker/room.ts:263` calls `parseClientMsg` with no try/catch, so the exception escapes `webSocketMessage` before `core.message`, i.e. before the msg/bad counters run: unlimited, never closed with 4429, client gets no `bad_msg`. (`attack.mjs` sends `__proto__` and still "passes" because it only checks the socket stays open.)
- Fix: `Object.hasOwn(KEYS, x.t)` or `Object.create(null)`; also wrap parse in try/catch.
- Test: `tests/qa/qa-full.test.ts` "prototype-key message types" (it.fails x5).

### M2. A disconnected player's turn stalls the table for up to 5 min with no pause
- Repro: start a game, seat whose turn it is closes the tab. `core.ts:183` `paused()` is true only for open/empty seats; the seat is held until `leftAt + SEAT_HOLD_MS` (`core.ts:25`, 5 min), so `game.paused=false`, `clock.paused=false`, the match clock keeps counting, and `play` is accepted from nobody. Others only see the "disconnected" tile.
- Impact: 5 min dead time per drop, game duration statistics and "expected time" skewed. Suggest pausing (and the clock) while the seat holder of record is disconnected, or at least showing a "waiting for X (mm:ss)" state.
- Test: "a held (not yet open) disconnected turn does NOT pause" documents today's behaviour.

### M3. Offline seated player's name can be taken by someone else (duplicate names)
- Repro: P1 seated mid-game drops; a new client sends `name` "P1". `core.ts:509-511` only compares against currently connected people, so it succeeds. When P1 returns there are two "P1"; `gameNames`/scoreboard keyed by name merge two different people's stats.
- Fix: also compare with names of seated or held people (`s.seats` sids and `s.people`).
- Test: "a seated player who is offline keeps the name reserved" (it.fails).

### M4. No timed game end exists
- The request lists "timed game end". `grep` finds no time limit anywhere in `src/` (only a clock and an expected duration). A game ends only when both teams bring all 8 marbles home; a stalled table (M2, or an absent host) never ends and the DO keeps the room forever. If a time cap is a requirement it is missing; if not, confirm in SPEC.

## Low

- L1 `src/client/ui/lobby.ts:~78`: `localStorage.getItem('role')` not in try/catch (other call sites are). Throws SecurityError with storage blocked, breaking the name step.
- L2 `src/client/net/socket.ts:61-72`: `CLOSE_ABUSE` (4429) falls into the retry loop, so a flooding client reconnects forever with backoff. Also a second tab with the same cookie gets `replaced` (handled, no loop), fine.
- L3 `src/client/net/socket.ts:77-79`: `send()` silently drops messages when the socket is not OPEN (a `play` pressed during a reconnect disappears with no error).
- L4 `src/worker/core.ts:842`: `qEnded` within 5 s of start is ignored; a video shorter than 5 s (or one where only `ended` fires) stalls the queue until someone skips.
- L5 `src/worker/core.ts:367` vs `:579`: kick is permanent per session id (`s.banned`, 50 entries) but the name ban lasts 30 min; the docs only mention the 30 min. A kicked player who returns with a fresh cookie and another name is not blocked at all (by design: no IP ban).
- L6 `src/worker/room.ts:32-39,147`: chat history, rate maps, `musicRate` live only in memory; DO hibernation/eviction (idle seconds) wipes the chat history (`chatHistory` is empty after a quiet period). Spec says "memory only", but eviction is far more frequent than the code comment implies.
- L7 `src/worker/room.ts:267-278`: `await ytVideo(...)` inside `webSocketMessage` opens the input gate, so later messages from the same socket may be processed before this `qAdd`.
- L8 `src/client/ui/widgets.ts:openSheet`: nested sheets share the `inert` attribute on `#app`; closing the inner sheet removes `inert` while the outer is still open (background clickable). Esc closes every open sheet at once (each registers its own keydown).
- L9 `docs/rules-ar.md` vs engine: (a) 10-burn also discards a random card of the burned player (`game.ts:451`), not mentioned in the rules text; (b) Q6 says a protected marble on its home blocks passing, the engine lets marbles pass over it (`landOn` only blocks stopping). Update the doc or the engine.

## Info

- I1 `ready` is stored but `canStart()` (`core.ts:220`) ignores it; the host can start while players are not ready.
- I2 `/api/logout` only clears the cookie; the signed token stays valid for its 12 h TTL if copied.
- I3 `core.ts:384` `total >= 8` limit and `MAX_SPECTATORS=4` verified: 5th spectator refused, 4 seated + 4 spectators OK.
- I4 Hardening verified OK: seat/turn/ownership checks, atomic failed plays, 7-split/J/4-backward illegal cases, host claim race (one winner), same-seat race, double-click play, rate limit (120/10 s, close at 240), chat limit (5/5 s), host grace and seat hold boundaries exactly at 5 min, reconnect after the seat opened restores the same hand, kicked mid-game seat opens, stale close of a replaced socket does not mark the seat as left, team finish skips seats and empties hands.

## Client code reading (390/430 px, swipe, widgets, no-WebGL)
- `scene.ts:26-45`: `isWebGLAvailable()` plus a renderer constructor try/catch lead to the SVG fallback; no issue found. `swipe.ts`: touch path ignores multi-touch, range inputs and scrolled content; pointer path has `pointercancel`. No width-specific code issue found beyond the earlier phone overflow noted in `docs/qa.md` F3 (not re-verified without a browser).
