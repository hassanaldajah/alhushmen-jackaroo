# SPEC: Alhushmen Jackaroo

## Architecture
- One Worker (static assets + API) and one SQLite-backed Durable Object `GameRoom` (the only DO class on the free plan), using WebSocket Hibernation.
- `engine/`: pure TypeScript, no I/O, injected RNG, ruleset config `jordan`. The DO holds all state; clients send intents only (`play {cardId, moves[]}`) and receive per-socket views.
- Shuffle: `crypto.getRandomValues` + unbiased Fisher-Yates, server only.
- Voice: WebRTC audio-only full mesh (8 peers = 7 links each, Opus + DTX), signalling through the DO. STUN is free. TURN: Cloudflare Realtime TURN free allowance, short-lived credentials minted by the Worker. **Verify it needs no payment card**; otherwise ship STUN-only and report that some mobile/CGNAT users cannot connect.

## 3D
three.js only (pinned), no physics. Instanced marbles, one card atlas, tweened deal from dealer to each hand (others face-down). Budget: under 100 draw calls, 150k triangles, DPR cap 1.5, render on demand, 30 fps floor, JS under 300 KB gzip. Honour `prefers-reduced-motion`.

## Design and motion
Warm Levantine majlis: wood, brass, green felt. Motion: card flicks, eased marble hops, short capture burst; 150-400 ms, never blocking input.

## UX
Arabic RTL, phone-first: hand at the bottom, tap card then marble, confirm. Turn, team and mic mute always visible. Help panel in Jordanian colloquial (goal, cards, entering, capturing) explains only; legal-move highlight only on request, never selects.

## Per-seat perspective
Each client renders the same board from its own seat: own hand face-up at the bottom, partner opposite (top), opponents left and right with face-down hands. Camera/layout rotate by seat index client-side (server state stays absolute). Spectators get a view picker (any seat's side, no hands revealed) and default to a neutral angle.

## Avatars and hand interaction
Each seat has an original stylized 3D avatar (procedural, no copyrighted character) sitting at the café table. Own hand: on phone, your avatar holds the fan of cards in its hands near the bottom of the screen; tap a card with a finger to lift/zoom and view it, tap again (or confirm bar) to play. On laptop: your cards are laid face-up in front of the screen; click a card to enlarge it and view it, click again/confirm to play; hover preview. Others' avatars hold face-down fans. Only the owner's seat view ever contains card faces.

## Voice privacy (user requirement)
Voice is live only: never recorded, never stored, never uploaded. Audio goes peer-to-peer (WebRTC, encrypted DTLS-SRTP); the Worker/DO only relays signalling (offer/answer/ICE), never audio. A TURN relay, if used, just forwards encrypted packets and keeps nothing. No MediaRecorder, no audio logging, no transcription anywhere. Mic is requested only when the user taps the mic button, with a visible mic-on indicator; leaving the room stops all tracks.

## Text chat (fallback + extra)
Room text chat for everyone (players + spectators), works even if voice fails. Server relays via the DO: max 300 chars, control chars stripped, rendered with textContent only (no HTML), per-user rate limit (e.g. 5 msgs/5s), last 50 messages kept in memory only (not persisted), mute/hide button per user; never blocks game actions (no-collision rule). Voice UI shows per-peer connection state and, if a peer fails, a clear "voice not connected, use chat" hint with a retry (ICE restart).

## Music
Song box: Worker proxies YouTube Data API v3 search (key = Worker secret, cached in DO, per-user rate limit, query length cap), returns title/thumbnail/videoId only. Playback via official YouTube IFrame Player, visible mini-player, no redirect, no audio extraction. UX rule: music never gets in the way of play. Entry point: a small speaker icon button in a corner (always visible, tiny); tap opens the song search panel (type a name, results from YouTube shown in-game, tap to add/play). The 200x200 player card appears only after a song is chosen. Player appears only while a song plays, as a small draggable 200x200 card in a corner (auto-placed away from the board/hand, never over the hand or confirm bar), semi-transparent when idle, collapses to a tiny bar by pausing; on desktop it sits beside the board. Music is off until someone adds a song. Shared room queue synced through the DO; videoId validated by regex; CSP allows only youtube-nocookie frames.

## Sound effects
Card sounds: card thrown/played, shuffle, deal (flick per card), plus marble hop/capture. Procedural Web Audio (noise bursts + filters) or CC0 samples with license in docs/assets.md; no copyrighted audio. Starts after first user tap (autoplay policy), own volume and mute, separate from voice and music, ducked under voice; honours reduced-motion/mute setting. Code: src/client/audio/**.

## No-collision rule (user requirement)
Music, voice, sound and game actions are independent: none blocks or waits on another. Anyone (player or spectator) can play, replace, skip, pause or stop the current song instantly, no approval from whoever started it; last action wins, applied in the order the DO receives it. Music messages never touch game state or the turn, and playing a song never delays a move. Only a small per-user rate limit stops spam.

## Seat swap between games
After a game ends the room returns to the lobby: all present (max 8) re-pick the 4 seats and partners; spectators can become players, repeats allowed. Seat changes only between games, validated server-side; scoreboard keyed by display name.

## Threat model
- Hidden hands: views are built server-side; opponents and spectators receive card counts only. Tested by a leak test.
- Passphrase: Worker secret only. Normalize (NFKC, strip tashkeel and tatweel, trim), compare HMAC digests in constant time. Rate limit per IP with backoff plus a global cap, stored in the DO. Never logged.
- Session: signed HttpOnly SameSite=Strict cookie (separate secret); WebSocket upgrade checks cookie and Origin.
- Validate every message (schema, size, turn, ownership); cap seats at 4+4.
- Strict CSP, noindex header + robots.txt, `.dev.vars` gitignored, secret scan before any push.

## Acceptance
As in the prompt, plus: engine unit tests cover every rule; the leak test passes; an 8-peer voice test; no payment required anywhere.

## Open decisions (ask the user)
Public names must not hint at the passphrase; unlisted rules (5, no-legal-move discard, partner exchange, exact home entry).

## Waves (one owner per file)
- A: design-lead `docs/design.md`; ux-designer `docs/ux.md`, `docs/rules-ar.md`.
- B: alsaqr `src/engine/**`, `src/worker/**`, `wrangler.toml`; three-d-engineer (else ui-builder) `src/client/scene/**`; ui-builder `src/client/ui/**`, `src/client/voice/**`.
- C: security-reviewer `docs/security.md`; qa-tester `tests/**`, `docs/qa.md`.
- D: owners fix, at most 2 rounds; then the Fable final gate.
