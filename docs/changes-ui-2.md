# UI round 2 changes (client only)

Scope: `src/client/**` (+ new tests in `tests/client/**`). Engine rules, worker and wire protocol are unchanged.

## Load time (phones)

| | before | after |
|---|---|---|
| first-load JS (`index-*.js`) | 699.66 kB (gzip 188.71 kB), three.js included | 97.6 kB (gzip 34.9 kB) |
| 3D chunk (`scene-*.js`, three.js) | - | 634.8 kB (gzip 164.7 kB), loaded lazily |
| CSS | 28.1 kB (gzip 7.1 kB) | 29.7 kB (gzip 7.3 kB) |

- three.js + scene are a dynamic import (`preloadScene()` in `ui/bridge.ts`): fetched in idle time while the passphrase is typed or the lobby is open, so the intro/gate/name/lobby never wait for it.
- Intro: skipped for 7 days after it was seen once (was: every new tab), and 0.25 s shorter.
- The login check (`/api/session`) runs in parallel with the intro instead of after it.
- First paint: a static brass mark in `index.html` (styled from the main CSS; the CSP forbids inline styles) shows before any script.
- Scene build is cheaper on phones: 512 px wood/felt maps (1k on desktop), 128 px environment map, 1k shadow map, fewer felt fibres, and the tea glass no longer uses a transmission material (that cost a full extra render pass per frame).
- The table shows "عم نجهّز الطاولة" while the 3D chunk arrives; the scene is created one frame after the table chrome is painted.

## Checklist (every request in this round)

| # | Request | Status | Where |
|---|---|---|---|
| 1 | Mic (dock) only after login, inside the game | done: dock hidden on intro, gate, name screen, expired/kicked/full and after logout; shown only when a room view arrives for a named player | `ui/app.ts` (`gated`, `syncDock`), `ui/dock.ts` |
| 2 | Fast load on phones | done (see table above) | `ui/bridge.ts`, `ui/app.ts`, `ui/intro.ts`, `index.html`, `scene/scene.ts` |
| 3 | Thrown cards stay in the centre, one per player | done: centre pile keeps the last card of every seat (play, discard, burned card) as a neat cross; survives refresh of the tab; resets each game | `ui/bridge.ts` (`syncPile`), `scene/scene.ts` (`playThrow`), `scene/layout.ts` (`tablePose`) |
| 4 | Each player's 4 marbles in front of him, team colour, glass look | done: brass base tray with 4 cups on the player's edge; marbles = clear glass shell + coloured swirl core, mirror reflection, contact shadow, light spot (high quality); solid glossy glass on low | `scene/layout.ts` (`localBase`), `scene/scene.ts` |
| 5 | Logout button | done: settings sheet (table and lobby) + top-bar icon on the name/lobby screens, with confirm; POST `/api/logout` (same-origin), socket closed, voice/mic released, chat cleared, saved name/role/tab id/pile removed, back to the gate | `ui/app.ts` (`logout`), `ui/sheets.ts`, `ui/lobby.ts`, `net/socket.ts`, `voice/mesh.ts` |
| 6 | Phone responsive, all screens | done for the sizes below; HUD rebuilt: status bar, left rail (top), left dock (bottom, column; row in landscape at the table), hint button bottom-right, prompt/confirm between them, toasts clear of the rail; automated overlap audit passes on all table/lobby/gate/name sizes | `ui/app.css`, `ui/round2.css`, `ui/tokens.css` |
| 7 | Square table + snake track (76 squares, board.ts indices) | done: square walnut table with legs; plus-shaped "snake" path (straight 7-square side runs, tip runs on each player's edge, diagonal inner corners), home lanes straight inward from each entry, base row in front of each seat, brass star inlays; hops follow the path square by square including the home entry | `scene/layout.ts`, `scene/cafe.ts`, `scene/scene.ts`, `tests/client/layout.test.ts` |
| 8 | Orbit camera per player + visible dallah | done: drag rotates around the table, pinch/wheel zoom (0.5-1.6x), double tap on empty space or the rail button resets to the own seat, damped time-based motion, tap vs drag separated (9 px slop), reduced motion = no damping/glide; framing keeps every square, the dallah and the pirate in view on 360-430 px portrait | `scene/scene.ts` (orbit section, `fitDistance`), `scene/cafe.ts` |
| 9 | Player moves his own marbles | done: pick card -> only his legal marbles light up -> tap or drag one -> legal destinations light up -> tap/drop -> ghost marble + confirm bar. 7 split asks for the second marble; Jack destinations are the opponent marbles; partner marbles after finishing come from the server's legal plays; 10 shows the burn as a side option. Nothing is sent without the confirm tap; message format unchanged | `ui/bridge.ts`, `scene/scene.ts` (`setTargets`, drag), `tests/client/bridge-flow.test.ts` |
| 10 | Card tooltip above the selected card | done: one line, Jordanian, from docs/rules-ar.md + engine (`T.cardTip` in `ui/ar.ts`), above the 3D card (follows the camera) or the 2D card, `pointer-events: none`, hides on deselect/throw; when it is not your turn a tap only explains the card | `ui/table.ts`, `ui/ar.ts` |
| 11 | "نكتة" button + silence filler | done: dock button right under the mic, shuffle-bag over the 60 jokes (no repeat until all used), 3 s cooldown; quiet room (no voice, chat, move or turn change) for 90 s -> one joke, not during a deal, not while a sheet is open, setting "نكت تلقائية" (on by default, localStorage) | `ui/app.ts`, `ui/joke.ts`, `ui/dock.ts`, `ui/sheets.ts` |
| 12 | Gag on the 2nd tap ("زوط", "لا أمزح معك", then the joke), repeats every 7 taps | done (`GAG_EVERY`, in-memory counter, button taps only) | `ui/app.ts` |
| 13 | Dealer jokes read by the dealer seat | kept (server cue -> dealer avatar anchor) | `ui/app.ts`, `ui/joke.ts` |
| 14 | Pirate NPC "أيمن" | done: tricorn, eye patch, blond hair + beard, red/gold parrot (high quality only), chest badge "أيمن / معدل التراكم 2.7" (canvas texture, Reem Kufi) + HTML name tag when the badge is too small (phones); idle breathing/head turn; pulls a paper out of his pocket and the joke bubble appears above him; reduced motion / low quality = bubble only | `scene/npc.ts`, `scene/scene.ts`, `ui/table.ts` |
| 15 | Gold + brown, no green | done: board cloth is coffee leather, card backs burgundy + brass, hint rings brass/cream, headscarf plum; team B changed from teal to pearl-silver (teal read as green on the new board) | `scene/colors.ts`, `ui/tokens.css`, `ui/tokens.ts` |
| 16 | Keep swipe-to-close sheets, Reem Kufi, RTL, per-tab identity, 120 Hz, reduced motion | kept (sheets now also close all at once on logout) | `ui/widgets.ts`, `ui/swipe.ts` |

## Screenshots actually taken (headless Chrome, SwiftShader WebGL, local worker, synthetic passphrase from memory only)

Sizes: 375x667, 390x844, 393x852, 430x932, 360x740, 844x390 (landscape), 768x1024, 1280x800.
Screens: intro, gate, name, lobby (top and scrolled), table (3D: board, hands, centre pile, marbles, dallah, pirate), card tooltip, joke bubble + gag, orbit (desktop), settings sheet (phone, landscape, desktop), help sheet, logout confirm + gate after logout. 390x844 also with simulated iPhone insets (47 px top, 34 px bottom).

## Not verified

- Real iOS Safari / Android Chrome on a device (toolbar, notch, real GPU speed). Safe areas were simulated with CSS variables.
- Voice and YouTube music (need real peers / network).
- Frame rate on a real 120 Hz phone (animation code is time-based; checked only by reading).
