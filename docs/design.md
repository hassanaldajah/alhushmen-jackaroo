# Design System: Alhushmen Jackaroo

Direction: warm Levantine majlis. Wood, brass, green felt. Arabic RTL, phone-first. Implementation: CSS custom properties in `:root` (dark majlis is the single default theme; see Theming).

## 1. Color tokens

| Token | Value | Use |
|---|---|---|
| `--wood-900` | `#1E140D` | page background, deepest |
| `--wood-800` | `#2B1D12` | surfaces, panels |
| `--wood-700` | `#3B2818` | raised surface, board rim |
| `--wood-500` | `#6B4A2B` | borders, dividers |
| `--felt-700` | `#12452F` | felt, dark |
| `--felt-600` | `#1B5E3F` | felt, main table |
| `--felt-500` | `#2A7A55` | felt highlight |
| `--brass-300` | `#E8CF8A` | brass highlight, focus ring |
| `--brass-500` | `#C9A24B` | primary accent, buttons |
| `--brass-700` | `#8F6F2A` | brass pressed/shadow |
| `--cream-50` | `#FAF3E3` | card face, primary text on dark |
| `--cream-200` | `#E6D9BC` | secondary text |
| `--ink-900` | `#1A1410` | text on cream/brass |
| `--ruby-500` | `#B3322E` | hearts/diamonds, danger, mic muted |
| `--ok-500` | `#4CAF7A` | success, mic live |
| `--warn-500` | `#E0A030` | warning |
| `--scrim` | `rgba(15,9,5,.72)` | modal backdrop |

Team colors (never rely on color alone; also show shape icon and Arabic label):
- Team A: `--team-a` `#D9A441` (brass) + circle icon, label "فريق أ".
- Team B: `--team-b` `#3FA7A0` (teal) + diamond icon, label "فريق ب".
- 4 marble colors per team seat, all distinct hue and lightness: A `#D9A441 #F2D27A #A9791C #FFE9A8`; B `#3FA7A0 #7AD1CA #23716C #B5EEE9`.

Contrast (WCAG AA minimum): cream-50 on wood-900 = 14.6:1; ink-900 on brass-500 = 7.4:1; cream-200 on wood-800 = 10:1. Body text must be at least 4.5:1, UI icons at least 3:1.

## 2. Typography

Free Arabic font: **Cairo** (SIL OFL), self-hosted woff2 subset (Arabic + Latin + digits), weights 400, 600, 700 only, `font-display: swap`. Self-host to satisfy CSP (`font-src 'self'`), no Google CDN. Fallback: `"Cairo", "Noto Naskh Arabic", Tahoma, system-ui, sans-serif`. Headings optional display: **Reem Kufi** (OFL) weight 600, titles only, subset to used glyphs.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--fs-xs` | 12px / 16 | 400 | captions |
| `--fs-sm` | 14px / 20 | 400 | secondary |
| `--fs-md` | 16px / 26 | 400 | body (Arabic needs 1.6 line-height) |
| `--fs-lg` | 20px / 30 | 600 | section titles |
| `--fs-xl` | 28px / 38 | 700 | screen titles |
| `--fs-num` | 18px / 20 | 700 | card ranks, counters (tabular figures) |

Rules: `html{direction:rtl;lang:ar}`; use logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align:start`). Digits: Western digits 0-9 for ranks and scores (matches card faces). No letter-spacing on Arabic. Never italic or faux-bold. Latin text (room code, videoId) wrapped in `<bdi>`. Strip nothing from user names; render via `textContent`. Minimum text 12px; tap labels 14px.

## 3. Spacing, radius, elevation, layout

- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48 (`--sp-1..7`).
- Radius: `--r-sm` 6px, `--r-md` 12px, `--r-lg` 20px, `--r-pill` 999px; cards 10px.
- Elevation: `--sh-1` `0 1px 2px rgba(0,0,0,.4)`; `--sh-2` `0 4px 12px rgba(0,0,0,.45)`; `--sh-3` `0 12px 32px rgba(0,0,0,.55)`. Brass inner edge: `inset 0 1px 0 rgba(232,207,138,.35)`.
- Tap target minimum 48x48 CSS px, 8px gap between targets.
- Safe areas: pad with `env(safe-area-inset-*)`.

### Breakpoints (mobile-first, min-width)
| Name | Width | Layout |
|---|---|---|
| base | 0-479 | portrait phone: board fills width, hand bar fixed bottom (height 112px), status bar top (56px) |
| `sm` | 480 | larger phone / landscape: hand cards 64x92 |
| `md` | 768 | tablet: side panel (help/queue/players) 320px docked at inline-end |
| `lg` | 1100 | desktop: board max 760px centered, panel 360px, mini-player docked |

Landscape phone (height < 480): status bar collapses to 44px, hand bar 88px, panels become bottom sheets at 60% height.

## 4. Always-visible HUD (status bar, top, 56px)

Order (RTL, start to end): turn indicator, team chip, scores, mic button, menu button.
- Turn indicator: "دورك" (your turn) pill, brass-500 bg, ink text, soft pulse 1.2s (opacity .85-1; off for reduced motion); other turns: "دور {name}" cream-200 on wood-700.
- Team chip: team icon + label in team color, 8px dot ring.
- Mic button: 48px circle (see section 8). Never hidden behind menus.

## 5. Components and states

State set for every interactive item: default, hover (pointer only), focus-visible, pressed, disabled, loading, error.
Focus ring: 3px solid `--brass-300`, 2px offset, on every focusable element. Disabled: opacity .45, no shadow, `aria-disabled`.

**Button primary**: bg brass-500, text ink-900, 48px h, padding-inline 24, radius pill, 600 weight. Hover brass-300; pressed brass-700 + scale .97 (80ms); loading: spinner 18px replaces label, width fixed.
**Button secondary**: transparent, 2px border brass-500, text cream-50. Hover bg rgba(201,162,75,.15).
**Button danger**: bg ruby-500, text cream-50.
**Input** (passphrase, chat): 48px h, bg wood-900, border 2px wood-500, radius 12; focus border brass-500; error border ruby-500 + message below in ruby text 14px with icon; passphrase input `type=password`, `autocomplete=off`, show/hide toggle. Error text must be generic (no hints).
**Chip/Badge**: 28px h, pill, 12px text.
**Toast**: bottom above hand bar, wood-700, 12px radius, 3s, `role=status`; errors persist until dismissed (`role=alert`).
**Modal/sheet**: scrim; sheet radius-top 20px; focus trapped; Esc and close button; max 90vh.
**Seat/player tile**: avatar 40px circle (initial letter), name (ellipsis at 12ch), card count badge, team ring 3px, active-turn brass glow `0 0 0 3px brass-500`, voice ring (section 8), disconnected state: grayscale + "غير متصل".

### Playing card
Size: hand 56x80 base (64x92 at sm), table 48x68. Radius 10. Face cream-50, rank `--fs-num` top-start, suit glyph center; hearts/diamonds ruby-500, clubs/spades ink-900. Back: felt-700 with brass diamond lattice and 2px brass-500 inner border. Border 1px `#00000033`.
States: default; hover (pointer) translateY -4px; **selected** translateY -16px + 3px brass-300 outline + `--sh-3`; **hint** (legal, on request only) dashed 2px ok-500 outline, never auto-selects; disabled (not your turn) opacity .6; played (flies to table). Hand fan: overlap 40% of width, max rotation 2deg per card, centered, horizontal scroll if more than 7 cards with scroll-snap.

### Marble and board
Marble diameter 28px on screen min (tap area expanded to 48px via hit-slop). Selected marble: brass-300 ring 3px + 1.08 scale. Hint target holes: ok-500 dashed ring, only on request. Confirm bar: appears above hand after card + marble chosen; contains "تأكيد" primary and "إلغاء" secondary; sequence is tap card, tap marble, tap destination if needed, confirm. Nothing executes without confirm.

## 6. Motion language

Easing tokens: `--ease-out` `cubic-bezier(.22,1,.36,1)`; `--ease-in-out` `cubic-bezier(.65,0,.35,1)`; `--ease-spring` `cubic-bezier(.34,1.56,.64,1)`.
Durations: `--t-fast` 150ms, `--t-med` 250ms, `--t-slow` 400ms (max). Motion never blocks input: animations are cancelable, next intent can queue.

| Motion | Duration | Detail |
|---|---|---|
| Card select | 150ms | translateY, ease-out |
| Card flick to table | 300ms | arc: lift 24px, rotate to 6deg random +-, ease-out; lands with 80ms settle |
| Deal | 4 cards per target, 90ms stagger, each 320ms ease-out | from dealer position (center-top of board) to each hand; others face-down; own hand flips face-up 200ms (rotateY 180 to 0) after landing; total deal under 2.2s for 4 players x 4 cards, skippable by tap |
| Marble hop | 60ms per cell, max 400ms total path | per-hole eased arc, height 0.35 cell, ease-in-out; squash 0.9 on land 80ms |
| Capture burst | 300ms | 12 brass/cream sprites (instanced points), radial 0.6 cell, fade; captured marble returns to its start 250ms |
| Panel open | 250ms | translate + opacity |
| Turn change | 200ms | HUD pill crossfade |

3D (three.js) rules: SUPERSEDED by section 14 (café scene, new budget). Still valid: one card atlas, instanced marbles, render on demand.
Reduced motion (`prefers-reduced-motion: reduce`): replace all travel with 100ms opacity/position cut, no deal stagger (cards appear), no hop arcs (marble steps instantly with 100ms highlight), no burst (single 150ms ring flash), no pulse. A visible "تقليل الحركة" toggle in settings overrides the OS default.
Sound is optional and off by default; no autoplay audio except user-started music.

## 7. Help panel

Trigger: "؟" button (48px) in HUD menu and persistent floating chip at inline-start bottom above hand bar. Opens a right-docked panel at md+, bottom sheet (70% height) on mobile. Language: Jordanian colloquial Arabic, 16px/26, sections as accordion (one open at a time): الهدف، الورق، الدخول، الأكل. Each section: title (`--fs-lg`), 3-5 short lines, small card/marble illustration 96px. Footer toggle "أبيّن الحركات المسموحة" (show legal moves): off by default; when on, applies hint style (section 5) to legal cards/marbles/targets only while panel toggle is on, auto-off after 10s or on confirm; never selects or plays. Panel is explanatory only and cannot change game state. Closing returns focus to trigger.

## 8. Voice and mic indicators

- Mic button (HUD, 48px circle): states and non-color cues:
  - Live: ok-500 fill, mic icon, label "مفتوح"
  - Muted: ruby-500 fill, mic-with-slash icon, label "مكتوم" (default state on join)
  - Connecting: wood-700 with brass spinner ring
  - Blocked/denied: warn-500 border, "المايك مش مسموح" toast with help link
  - Unavailable (STUN-only fail): disabled, toast "الصوت مش شغال عندك"
  Tap toggles; `aria-pressed`; haptic 10ms where supported.
- Speaking indicator on seat tile: 3px ok-500 ring, scale 1 to 1.06 driven by audio level (AnalyserNode, 10 Hz sampling, threshold -50 dB), 120ms smoothing. Reduced motion: static ring only.
- Remote muted: small mic-slash badge 16px, ruby-500, at tile inline-end bottom.
- Connection quality: 3-bar icon 16px: good ok-500, fair warn-500, poor ruby-500; plus text on long-press/tooltip.
- Per-peer volume sliders in the players panel (0-100%, default 100).

## 9. Music mini-player and song box

- **Mini-player**: always visible once a track is queued. Mobile: 56px bar above hand bar (bottom 112px + safe area), full width minus 16px margin, wood-700, radius 12, `--sh-2`. Contents (start to end): thumbnail 40x40 radius 6, title (1 line, ellipsis, 14px 600), play/pause 48px, next 48px, expand chevron. Official YouTube IFrame must remain visible per terms: min 200x200 CSS px player area shown in expanded state; in collapsed state the iframe is kept at 200x200 behind a visible 56px bar via a thumbnail preview (never hidden with display:none, never 0x0). Do not offset it off-screen.
- States: empty ("ما في أغاني، ضيف أغنية"), loading (skeleton), playing (animated 3-bar equalizer 16px, static in reduced motion), paused, error ("تعذّر تشغيل الأغنية", auto-skip after 3s), buffering.
- **Song box (search)**: sheet with input (placeholder "دوّر على أغنية", maxlength 80), debounce 400ms, results list rows 64px: thumbnail 56x56, title 2 lines, "أضف" button 48px. States: idle, loading skeleton x5, results, empty ("ما لقينا شي"), rate-limited ("استنى شوي وجرّب مرة ثانية", button disabled for the returned seconds), error. Results show title, thumbnail, videoId only.
- **Queue**: ordered list, current item brass-500 start border 4px; reorder not allowed; remove own items only; shows who added (name). Synced via the DO; sync drift tolerance 2s.
- Volume: slider in expanded state (0-100, default 60).

## 10. Iconography

SVG, 24px grid, 2px stroke, round caps, `currentColor`, inline sprite (no icon font, no CDN). Icons: mic, mic-off, speaker, play, pause, next, queue, help, close, chevron, circle, diamond, check, warning, settings, wifi-bars. Directional icons (chevron, next, back) mirror in RTL via `[dir=rtl]` transform scaleX(-1); play and media icons do not mirror.

## 11. Theming

Single theme (dark wood). No light mode: the felt/wood palette is the identity and a light theme would break contrast tuning. High-contrast option in settings: text `#FFFFFF`, borders brass-300 2px, disables wood texture. Wood grain texture: one tiled 256px WebP under 20 KB at 6% opacity; optional, off in high-contrast and reduced-data mode.

## 12. Accessibility and performance

- All controls labelled in Arabic via `aria-label`; live regions (`aria-live=polite`) announce turn change, captures, and score changes.
- Canvas has a text alternative: a hidden DOM list of hand cards (buttons) mirroring the selection so keyboard and screen readers can play; Tab order: HUD, hand, confirm bar, panels.
- Touch: no hover-only features; no gestures required (swipe is optional shortcut only).
- Assets: fonts under 120 KB total, icons sprite under 8 KB, CSS under 20 KB gzip.
- Pass AA contrast; test at 200% text zoom without horizontal scroll (except hand scroller).

## 13. Token file map (for implementers)

Tokens above map 1:1 to CSS variables, e.g. `--brass-500`, `--sp-3`, `--r-md`, `--t-med`, `--ease-out`. ui-builder owns `src/client/ui/tokens.css`; the three.js scene reads color constants from the same values (`wood-900`, `felt-600`, `brass-500`, team marble colors) via a shared `tokens.ts` exported from the ui layer.

---

# Round 2 additions

## 14. Café 3D art direction (replaces old 3D budget)

Mood: a cozy evening café table seen from a seated, slightly raised viewpoint. Warm, tidy, uncluttered; props sit at the edges, never over the board or the play area.

**Camera (cinematic)**: perspective FOV 32, default pose = 48 degrees down-tilt, distance so the board fills 92% of viewport width in portrait (board center at 55% screen height). Landscape: tilt 40, FOV 30. Intro-to-game dolly: 1.2s ease-in-out from tilt 25 / 1.6x distance to default. Idle "breathing" drift: +-0.4 degree yaw, 8s sine (off in reduced motion and low quality). Depth of field is NOT used (cost); fake it with a cheap vignette (radial, 18% black at corners, CSS overlay) and background fog (`FogExp2` color `#1E140D`, density 0.035). Tween camera on request only (150-400ms) for the Look-at-hand/Look-at-board buttons.

**Lighting** (3 lights + IBL, all warm):
| Light | Type | Color / intensity | Notes |
|---|---|---|---|
| Key (pendant lamp) | SpotLight above table, angle 0.9 rad, penumbra 0.8 | `#FFD9A0`, 180 cd (physical units) | only shadow caster; visible lamp mesh off-screen top |
| Fill | HemisphereLight | sky `#6B4A2B`, ground `#1E140D`, 0.35 | no shadows |
| Rim | DirectionalLight from back-left | `#FFB070`, 0.6 | no shadows; edge gloss on cups/brass |
| IBL | one 256x128 CC0 HDRI (warm interior) via PMREMGenerator, `scene.environment`, intensity 0.5 | | background stays fog color, HDRI not shown |
Renderer: `ACESFilmicToneMapping`, exposure 1.05, `SRGBColorSpace`, `physicallyCorrectLights` default of current three.js.

**Table**: round or rounded-rect wood top, 1.6x board diameter, 6cm thick edge with 8mm bevel; dark walnut. Board sits on a green felt inset (felt-600) with brass rim (brass-500 metal strip, 6mm). Behind the table, a blurred out-of-focus café backdrop: one low-res (1024x512) baked gradient plane with warm bokeh dots (procedural canvas texture, 12 circles, no download).

**Props** (all procedural geometry, no external models unless CC0 listed in docs/assets.md):
| Prop | Build | Triangles | Position |
|---|---|---|---|
| Espresso cup + saucer (x2) | LatheGeometry profile, 48 segments, ceramic white `#F3EEE4` | 3k each | beside seats 1 and 3, off-board |
| Coffee surface | circle, `#3A2314`, roughness .15, animated steam (below) | 100 | inside cups |
| Dallah (Arabic coffee pot) | Lathe body + spout tube + lid knob, brass | 6k | far corner, 12cm tall at scale |
| Date bowl | Lathe, brass, with 14 instanced ellipsoid dates `#4A2A12` | 2k | table corner near seat 2 |
| Small glass of tea (x1) | Lathe, MeshPhysicalMaterial transmission .9, ior 1.45 | 2k | beside seat 4 |
| Napkin holder / sugar | box + cylinder, brass | 1k | optional (high only) |
| Steam | 2 Points sprites per cup, soft-circle alpha texture 64x64 (procedural), rise 0.1 m/s, 3s loop | 4 | high only; off in low |
Props are static except steam; they never intercept raycasts (layer 1, not in picking).

**PBR material list** (all CC0; source for each logged in docs/assets.md with URL, author, license, date, hash; textures at 1k, KTX2/WebP, albedo+normal+ORM packed):
| Surface | Source (CC0) | Resolution (high / low) | Params |
|---|---|---|---|
| Walnut table wood | ambientCG "Wood" set (e.g. Wood049 class) or Poly Haven wood | 1024 / 512 | roughness .55, clearcoat .25 |
| Felt | ambientCG "Fabric" felt-like set | 1024 / 512 | roughness .95, sheen .6 `#2A7A55` |
| Brass | Poly Haven/ambientCG metal, or no texture: MeshStandard metalness 1, roughness .28, color `#C9A24B` | 512 / none | env-map reflection |
| Ceramic | no texture: MeshPhysical color `#F3EEE4`, roughness .12, clearcoat 1 | none | |
| Marbles | no texture: see below | none | |
| Card faces | own atlas (own art), 2048x2048 | 2048 / 1024 | roughness .6 |
Rule: if a candidate is not clearly CC0 (not CC-BY, not "free for personal"), reject it; fall back to procedural.

**Marbles (glass reflections)**: MeshPhysicalMaterial, transmission 0 (cheap), metalness 0, roughness .05, clearcoat 1, clearcoatRoughness .03, ior 1.5, `envMapIntensity` 1.2, per-team color from section 1, a swirl core via one shared 128x128 procedural noise normal map. Reflections come from the PMREM environment (no per-marble cube cameras, no SSR). Board-contact fake reflection: a 28% alpha mirrored copy of the instanced marbles, flipped on the felt Y plane, fading by distance (second InstancedMesh, high only). Marble diameter on board 28px on screen min (unchanged).

**Shadows**: one SpotLight shadow map 2048x2048 (high) / 1024 (low), `PCFSoftShadowMap`, radius 4, bias -0.0004, normalBias .02, frustum fitted to the table (updated once, `shadowMap.autoUpdate = false`; re-render shadow only when a marble or card moves: set `needsUpdate`). Marbles and cups cast and receive; felt receives only. Plus a fake soft contact shadow blob under each marble (radial alpha quad, 0.9 opacity) so low quality still grounds the pieces.

**Performance budget (NEW, replaces old; target: iPhone 13 and newer, A15+, Safari)**:
| Metric | High (default) | Low (toggle) |
|---|---|---|
| Frame rate | 60 target, 30 fps hard floor | 30 fps locked |
| DPR cap | 2.0 | 1.25 |
| Draw calls | at most 180 | at most 80 |
| Triangles | at most 400k | at most 120k |
| Texture memory | at most 160 MB (1k maps) | at most 50 MB (512 maps) |
| Shadow map | 2048 soft | 1024 hard-ish, marbles only |
| Steam, marble mirror, breathing camera, HDRI IBL | on | off (IBL 64x32 flat) |
| Antialias | MSAA 4x | off, DPR gives the smoothing |
| Initial load (3G-fast) | assets at most 6 MB total, scene interactive under 3 s after assets | at most 2.5 MB |
| JS heap | under 250 MB | under 120 MB |
Auto-degrade: if mean frame time over 45 consecutive frames exceeds 33.3 ms, step down in order: steam, marble mirror, DPR 1.5, shadow map 1024, then switch to Low and show toast "خفّضنا الجودة عشان الأداء" (with Undo). Never auto-upgrade within a session. Thermal: if `document.visibilityState` is hidden, stop rendering. Render loop stays on-demand (rAF only during tweens, input, steam, or idle drift; idle drift capped at 30 fps).
**Quality toggle** (Settings sheet): segmented control "جودة الرسوم": عالية | منخفضة (48px high, 2 options, `role=radiogroup`), persisted in `localStorage` key `gfx` (no personal data). Applies live without reload (swap maps, resize shadow map, reset DPR). Low quality still shows wood and felt (512 maps).

## 15. Logo and animated intro

**Text**: exactly `جاكارو الحُشمين` (damma U+064F after ح). The string is stored once in a single constant in the authenticated bundle only. Do not alter spelling or diacritics.
**Placement (user decision, final)**: the intro plays BEFORE the passphrase screen. Flow: intro/logo -> passphrase -> game (lobby). The user accepted that the name is visible pre-auth. The passphrase itself is never written in any file.
**Passphrase screen addition**: under the input, a decoy hint line with the exact text `كم معدل حسن التراكمي؟` (`--fs-sm`, cream-200, plain text via `textContent`). It is a misleading clue unrelated to the real passphrase; it must never change on success or failure and error text stays generic.

**Logo construction (original, all vector, drawn in code as SVG paths, no copied art or font logo)**:
- Mark: a circle (marble) 96px with a ring, placed above the text. Ring: 4px stroke brass-500 `#C9A24B`. Inside: a 4-pointed star made of two overlapping squares rotated 45 degrees (Levantine geometric star), fill felt-600 `#1B5E3F`, 2px brass-300 outline. Center dot: 10px circle cream-50. Four small circles (r=6) orbit at the star's tips in team colors (`#D9A441`, `#3FA7A0`, `#F2D27A`, `#7AD1CA`) as the four marbles.
- Wordmark: the Arabic name set in Reem Kufi 600 (OFL, already approved), 44px (fit to 80% of width, max 56), fill gradient brass-300 `#E8CF8A` to brass-500 `#C9A24B` (top to bottom), 1px `#8F6F2A` shadow-stroke below. Diacritics must render: set `font-feature-settings: "mark" 1`, line-height 1.8 so damma is not clipped. Verify with a rendering test that the damma glyph is visible at 44px.
- Underline: a 2px brass line 64% of text width, with a diamond (8px) in its center.
- Background: wood-900 with radial warm glow (center 40% height, `#3B2818` to `#1E140D`).

**Motion timeline (total 3.2s, ease tokens from section 6)**:
| Time | Event |
|---|---|
| 0.00-0.30 | background glow fades in (opacity 0 to 1) |
| 0.20-0.80 | ring draws (stroke-dashoffset 100% to 0, ease-out) |
| 0.60-1.10 | star scales from 0.6 to 1 with rotation -45 to 0 degrees, ease-spring |
| 0.90-1.50 | four marbles roll in from corners along curved paths to the star tips (ease-in-out, 60ms stagger) and settle with squash 0.9 |
| 1.30-2.10 | wordmark reveals by a left-to-right (RTL: right-to-left) mask wipe, with 12px upward slide, ease-out |
| 2.00-2.40 | underline grows from center, diamond pops |
| 2.40-2.70 | light sweep across the wordmark (white 30% skewed bar) |
| 2.70-3.20 | hold, then crossfade 250ms to the next screen |
Sound: none by default (optional soft "tink" per marble only if sound setting is on, CC0 sound, logged in assets.md).
**Skip**: the whole screen is a tap target; any tap, Enter, Space or Esc jumps to the end state within 150ms and continues to the next screen. A small visible "اضغط للتخطي" caption (`--fs-sm`, cream-200, bottom with safe-area) appears at 0.5s. The intro plays once per session (`sessionStorage` flag); on returning it is skipped automatically. Skipping must not block loading of the lobby.
**Reduced motion**: no ring draw, no marble roll, no rotation, no sweep. Show the final logo with a 150ms opacity fade, hold 1.0s, then continue (still tap-skippable). Settings toggle "تقليل الحركة" overrides OS.
**Performance**: SVG + CSS transforms only (no three.js), under 12 KB, runs at 60 fps on iPhone; low-quality mode drops the sweep and glow animation.
**Accessibility**: `role=img` with `aria-label` equal to the name; the intro is not required to read text; focus goes to the next screen's heading after the transition.

## 16. New UI components (Arabic RTL, tokens from sections 1-3)

All use existing button, input, chip, sheet and seat styles; 48px minimum targets; error text is generic. All user-provided text rendered via `textContent`.

**16.1 Display-name entry** (screen/sheet shown after auth, before lobby): title "اسمك في اللعبة" (`--fs-xl`); input 48px, `maxlength=16`, counter "7/16" (`--fs-xs`, cream-200), placeholder "اكتب اسمك", `autocomplete=off`, `enterkeyhint=done`. Client-side hint only; server is the validator (trim, 2-16 chars, letters/digits/space/Arabic, no markup). States: default, focus (brass-500 border), error ("الاسم مش مقبول، جرّب غيره" ruby, with icon), taken ("في حدا بنفس الاسم"), loading (button spinner), success (check). Primary button "ادخل". Remembered name pre-filled from `localStorage` (name is the identity, no secrets). Role chooser below: segmented "لاعب | متفرج".

**16.2 Lobby and partner-request**: list rows 64px: avatar 40px, name, role chip ("لاعب"/"متفرج"), status chip ("متاح", "عندك طلب", "شريكك", "مضيف"), and an action button 48px. Actions on a row of another player: "اطلب شريك" (secondary). States per row: idle, request-sent (button becomes "ألغِ الطلب", chip "بانتظار الرد" with 3-dot loader), request-received (row highlighted with 2px brass-500 border, two buttons "قبول" primary, "رفض" secondary), partnered (both rows show team icon and "شريكك"). Incoming request also appears as a toast-like banner at top (`role=alert`, 10s, stays in list). Team slots panel above the list: two cards "فريق أ" (circle icon) and "فريق ب" (diamond icon), each with 2 seat slots; empty slot dashed 2px wood-500 "فاضي". Partners shown opposite on a mini table diagram 160x160. Footer: expected duration "المدة المتوقعة: ~X دقيقة" and the "ابدأ" button (host only; disabled with hint "لازم فريقين كاملين" until 2 complete teams). Host-only "خلط عشوائي" secondary button, with confirm sheet.

**16.3 Host button and vote** (lobby): when no host, a full-width button 64px high: "أنا المضيف", brass-500, `--fs-lg`, with crown icon; first tap wins, server decides atomically. Loading state while waiting for the server; loser sees toast "سبقك [name]" and the button disappears. Host shows a crown chip next to the name. Change-host vote: menu item "تغيير المضيف" opens a bottom sheet: candidates list (radio rows 56px), vote count badges, progress "٣ من ٥" (Western digits used: "3 من 5"), countdown 30s ring 32px, buttons "صوّت" and "إلغاء". Majority of present people decides; result toast. If host disconnects: banner "المضيف طلع، مين بدو يصير مضيف؟" with the "أنا المضيف" button again. Host menu: "ابدأ"، "خلط عشوائي"، "طرد" (danger, confirm sheet).

**16.4 Scoreboard** (sheet from menu and in the end screen): tabs "الفرق | اللاعبين" (segmented, 48px). Rows 56px: rank number (`--fs-num`), name, wins (bold), games, last played date (Western digits, `dd/mm`). Top row gets brass-500 start border 4px. Empty: "ما في ألعاب محفوظة". Loading: skeleton x5. Footer note: "نحتفظ بآخر 6 أشهر". Current user's row highlighted (wood-700 bg + "أنت" chip). Team rows show both names joined with " و ". The list scrolls inside the sheet (max 70vh).

**16.5 End-of-game result screen**: full-screen overlay (scrim then wood-800 panel, radius 20, `--sh-3`). Top: winner banner, team color + icon + "فاز فريق أ" (`--fs-xl`), confetti burst 1.2s (12 brass/cream sprites; none in reduced motion/low). Result table: two columns (فريق أ | فريق ب) with rows: finish order (1st/2nd as "الأول"/"الثاني"), finish time (mm:ss), turns (count), marbles home (8/8). Margin line: "الفرق: 02:14 و 9 أدوار". Total duration "مدة اللعبة: 41:20" and "المتوقعة كانت: 45 دقيقة" (cream-200). While the loser team is still playing (after first team finishes): banner "فريق أ خلّص! بانتظار فريق ب" with live elapsed; result screen opens only when both are done. Buttons: "لعبة جديدة" primary (host: starts lobby again; others see "بانتظار المضيف" disabled), "النتائج" secondary (opens scoreboard), "اطلع" text button. States: waiting, saving ("نحفظ النتيجة" loader), saved (check), save-error ("ما انحفظت، حاول مرة ثانية" with retry).

**16.6 Dealer joke speech bubble**: anchored to the dealer's seat tile, above it (inline-center), max width 240px, min 120px. Bubble bg cream-50, text ink-900, `--fs-sm` 14px/22 (up to 3 lines, then ellipsis; jokes are kept short), padding 12 16, radius 16, `--sh-2`, tail 12px triangle pointing to the seat. A small label "إفيه" chip (brass-500, 12px) top-start. Timeline: appears 200ms (scale .9 to 1, opacity, ease-spring), stays 5s (or 7s if more than 90 chars), exits 200ms; tap on bubble dismisses immediately (target expanded to 48px). Does not block cards or board input (`pointer-events: none` except the dismiss). Never overlaps the hand bar (clamp to viewport with safe-area). Reduced motion: opacity only, 100ms. Setting "إفيه الموزّع" on/off. Screen readers: `role=status`, `aria-live=polite`, read once. Text via `textContent`, from the fixed local list only; no markup.

## 17. Asset and license rules (round 2)

Every external asset (textures, HDRI, models, sounds, fonts) must be CC0, OFL or equivalent, and be logged in docs/assets.md: name, URL, author, license, date downloaded, file, SHA-256, size, usage. No attribution-required or non-commercial items. Procedural assets (cups, props, logo, steam, bokeh) are original work and also listed there as "original". No asset under the repo that contains the passphrase. Total asset size must match the budget in section 14.
