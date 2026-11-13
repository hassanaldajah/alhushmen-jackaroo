# Code review: logic / race / state-machine bugs (2026-11-13)

Read-only review, no src/ edits. "Verified" = reproduced with a throwaway vitest script; the rest is by code reading.
Counts: Critical 1, High 4, Medium 6, Low 7. Engine rules (split-7, J, 4 back, home entry, kills, takeover, redeal) match docs/rules-ar.md; no rule bug found in game.ts/board.ts.

## Critical
- **C1 Burn-only hand deadlocks the game** (verified). `src/client/ui/bridge.ts:182-191,208-213` + `src/engine/game.ts:336,395`. Hand has a 10, no A/K, no marble able to step 10 (typical first deal). The engine says the only legal play is burn, so discard is illegal; the UI offers burn only after a marble with a 10-step is tapped, so it can never be sent. No turn timer exists, so the table is stuck. Fix: in `selectCard`, when the candidates contain no marble move, emit them directly (burn/discard); also always show a "burn" option for a 10.

## High
- **H1 Every reload/login mints a new identity.** `src/worker/index.ts:75`, `src/client/ui/app.ts:183`. The client always shows the gate and never calls `/api/session`; `/api/auth` always creates a new sid. iOS tab discard or a refresh mid-game means the seat stays held by the old sid for 5 min (no pause, turn frozen), and the host role is stuck for 5 min. Fix: on boot call `/api/session` and skip the gate; in `/api/auth` reuse the sid from a valid/grace cookie.
- **H2 Seats/host never expire after a DO restart without sockets** (verified). `src/worker/room.ts:54-58`, `src/worker/core.ts:398-400,415-420`. After a deploy/crash the sockets are gone, `conns` is empty, `disconnect()` is a no-op for unknown keys, `leftAt`/`hostLeftAt` stay null, `nextAlarm()` is null. The seat never opens and `hostClaim` returns `host_taken` forever. Fix: after the rebuild, stamp `leftAt = now` for seated sids and the host with no socket, mark dirty and set the alarm.
- **H3 Old sockets keep live handlers, giving a false "kicked" screen.** `src/client/net/socket.ts:39-72`, `src/client/ui/app.ts:174,177`. `connect()` never closes/detaches the previous socket and the Retry button calls `connect()` (not `retryNow`, which is unused), so two sockets can open. The server closes the older one with 4408, its `onclose` emits `replaced`, and the app wipes the root while the newer socket is healthy. Fix: guard every handler with `if (ws !== this.ws) return`, close the old socket and clear the timer in `connect()`.
- **H4 No liveness check.** `src/client/net/socket.ts:77` (protocol `ping` is unused; no `visibilitychange`/`pageshow`/`online` handler). After iOS backgrounding the socket can be a zombie: the view is stale, `send()` goes nowhere, and `table.ts:76-78` resets the selection as if the play was sent. Fix: ping on resume and every ~25 s; no pong in 3 s means force close and reconnect.

## Medium
- **M1** `src/client/ui/app.ts:172-174`: expired/full/kicked screens do not call `dropTable()`. After re-auth mid-game `table` is non-null but detached, so the user stays on the gate; the WebGL scene and intervals leak.
- **M2** `src/client/ui/bridge.ts:141-144`: a hint is requested once per `hintKey`. If the reply is lost (drop, `rate` error), the same key after reconnect means `plays` stays empty and the player cannot move. Fix: clear `hintKey` on socket `open`.
- **M3** `src/client/ui/app.ts:89-90`, `src/client/ui/lobby.ts:75-78`: each view rebuilds the name screen, so typed text is wiped whenever anyone joins/mutes.
- **M4** `src/worker/room.ts:55-58,262`: the rebuild trusts every attachment, including sockets the server already closed (kicked/replaced) but that have not finished closing. After hibernation they count as connected again, and a client ignoring the close frame bypasses the kick (ban is checked only in `connect`). Needs confirming on workerd. Fix: `serializeAttachment(null)` before a server close; skip banned sids on rebuild.
- **M5** `src/client/voice/mesh.ts:36-41`: after a WS reconnect local links are stale (peers closed theirs), so voice needs a manual retry. Fix: rebuild links on `open` after a retry.
- **M6** `src/engine/game.ts:342-345`, `src/client/ui/bridge.ts:65-73`: split-7 options do not name the second marble; a finished seat gets duplicates (verified: 26 plays, 14 unique).

## Low
- **L1** `socket.ts:69-70`: the `lost` timer restarts on every failed retry, so the Retry banner almost never shows.
- **L2** `src/client/audio/music.ts:52,72` vs `core.ts:842`: start offset uses the client clock (drift, ignores pause); the unembeddable-video auto-skip is dropped by the 5 s guard (send `qError`).
- **L3** `src/client/ui/swipe.ts:116-119`: a second finger mid-drag leaves the sheet stuck translated. Fix: `end(true)` first.
- **L4** Leaks: `musicCard.ts:23` resize listener and YT player per table; `core.ts:372,588` rate entries; mic not stopped on kicked.
- **L5** `core.ts:344,415`: request TTL has no alarm; stale requests show until the next change.
- **L6** `core.ts:509-511`: `name_taken` ignores disconnected seated players, giving duplicate names and merged scoreboard rows.
- **L7** `core.ts:622,605`: unnamed connections can vote for host; `hostGive` skips the ban check.
