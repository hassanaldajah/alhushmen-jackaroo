# UX: Alhushmen Jackaroo

Arabic RTL, phone-first (360x640 up), portrait. Desktop = same layout, wider side panels. Spec language for UI: Arabic; keys below are for devs.

## Principles
1. Server decides; UI only sends intents. Never auto-select or auto-play.
2. Always visible: whose turn, my team, mic mute, expected vs elapsed time. Nothing blocks input (motion 150-400 ms).
3. Help explains only. Legal-move highlight only on request, never selects.
4. Thumb zone: hand + confirm at the bottom; secondary tools in sheets.
5. The passphrase screen gives no true hint (no length, no "close", no real clue). It shows only the decoy hint in F1, and errors stay generic.
6. Independent channels: music, voice, sounds and game moves never block each other. Last action wins in server order.

## Screens
1. Intro (logo "جاكارو الحُشمين" with damma on ح; skippable)
2. Passphrase gate (with decoy hint)
3. Name entry (display name)
4. Lobby (people list, host claim, partner requests, team board, expected duration, start)
5. Table (3D board + HUD) with: Hand tray, Confirm bar, Turn banner, Team strip, Mic button, Clock chip (elapsed / expected), Dealer joke bubble, Now-playing chip
6. Help sheet (rules cards)
7. Songs sheet (search, results, shared queue, mini-player, controls: change/skip/pause/stop)
8. Voice sheet (participants, per-person volume, mic state)
9. Result screen (modal over table; replaces old win modal)
10. Scoreboard (per team and per player; reachable from lobby and result)
11. Settings sheet (graphics quality toggle, reduced motion note, sound, replay intro)
12. System overlays: reconnecting, room full, kicked/ended, offline, host-vote, host-left

## Flows

### F1 Intro -> passphrase entry
Intro (F10) -> Passphrase gate -> type phrase (password field, show/hide toggle, RTL, autocomplete off) -> "دخول" -> pending -> Name entry -> Lobby.
- Decoy hint under the field, always shown as plain helper text: "كم معدل حسن التراكمي؟". It is misleading by design and has no relation to the real phrase; it never changes, never reacts to input, and is never explained.
- Diacritics difference accepted (server-side; UI says nothing about it).
- Wrong: generic error text only (gate.wrong), field kept, focus returned to field. Repeated: backoff countdown, button disabled until it ends.
- Never reveal length, true hints, or "close". Same message for wrong and rate-limited except the countdown.

### F2 Display name entry
1. Shown once after auth, before the lobby (players and spectators alike). Field label "شو اسمك؟", counter "n/16", required, autofocus allowed here (no trap), Enter submits.
2. Remembered locally (prefilled on return; user can edit). Name is the identity; no accounts.
3. Client trims and blocks empty; server is the authority: max 16 chars, no markup/control chars/zero-width, no all-blank. Server may reply "name_taken" (a present person has the same name) or "name_invalid".
4. Errors inline with the field (`aria-describedby`): "الاسم لازم يكون من حرف لـ 16 حرف بدون رموز غريبة" / "في حدا بنفس الاسم، غيّره شوي". Focus stays in field, text kept.
5. Loading: button spinner "ثواني..."; success -> Lobby. Name shows on seat, scoreboard, voice and spectator lists (wrapped in `<bdi>`).
6. Rename allowed in lobby only (pencil icon), not mid-game.

### F3 Lobby, host, seats, spectators
1. People list (everyone joined, up to 4 players + 4 spectators): name, role chip (لاعب/متفرج), host crown, connection badge. Empty: "ما حدا هون لسا".
2. No pre-assigned host (see F5). Until a host exists, a big "أنا المضيف" button is the main action.
3. Seat diagram with two team slots, partners opposite, you at bottom. Seating is driven by teams (F4); tap a free seat to sit as a player, tap again to stand. Spectator list (max 4); join as spectator by choice or if seats are full. Seats 4/4 + spectators 4/4 -> "room full".
4. Expected duration chip: "المدة المتوقعة ~ {n} دقيقة" (refined from saved games once they exist), shown before start.
5. Start ("ابدأ اللعبة") is host-only and enabled only with 2 complete teams (4 players, partnered). Disabled state shows the reason: "لازم فريقين كاملين".
6. Spectator can take a freed seat only between rounds.
7. Host can kick (confirm dialog "تطرد {name}؟"). Disconnected player keeps seat 60 s with "غير متصل" badge, then the seat opens and the game pauses with a clear banner.

### F4 Partner-request team selection (and host shuffle)
1. Each seated player without a partner sees a "اطلب شريك" button on every other unpartnered player's row. Spectators cannot request.
2. Send: row shows "بانتظار رد {name}" with "إلغاء الطلب". One outgoing request at a time (a new one cancels the old). Target sees a non-blocking card/toast (persistent until answered, also in the log): "{name} بده يكون شريكك" + "قبول" / "رفض". Live region polite.
3. Accept: server pairs them atomically; both are shown as a team (colour + icon + label), seated opposite each other; all other pending requests involving either player are cancelled with "{name} صار إله شريك".
4. Decline / expire: requester sees "{name} ما قبل. جرّب حدا ثاني". No penalty; no auto-retry. Requests expire if either side leaves, stands, or disconnects beyond 60 s.
5. Break team: either partner can tap "فكّ الشراكة" before the game starts (confirm).
6. Race: two requests to one player -> first processed wins, the second gets "{name} صار إله شريك".
7. Host shuffle: host-only "وزّع الفرق عشوائي" for players who can't agree. Confirm dialog "رح نبدّل الفرق عشوائي، تمام؟". Server randomises pairings of all seated players, replaces existing teams, announces "تم توزيع الفرق" (polite live region), seats re-animate (instant under reduced motion). Can be repeated until start.
8. Start is blocked until 2 complete teams exist, whichever route was used.

### F5 Host selection
1. Default claim: all present people see a big "أنا المضيف" button while there is no host. First tap wins. Winner: crown + toast "{name} هو المضيف". Losers: button disappears with toast "{name} سبقك بالمضيف" (no error tone). The server decides by first message processed.
2. Pressing while another claim is processing is harmless (server answers `host_taken`).
3. Optional change-host vote: any person can tap "غيّر المضيف" in the people list menu. Server opens a vote. Voters = everyone currently in the lobby (players and spectators); each has one vote; simple majority of those present decides (ties keep current host). Banner/sheet to everyone: "{name} بده يغيّر المضيف. مين المضيف الجديد؟" with candidates (players) or "أنا" self-nomination, plus "ما بدي تغيير". Vote closes as soon as one option has a majority or after 30 s; one vote open at a time; cooldown 60 s after a failed vote. People who join or leave mid-vote change the denominator live. Result announced to all.
4. Host leaves/disconnects (beyond 15 s grace): banner "المضيف طلع" and the "أنا المضيف" claim reopens to everyone (first tap wins) and anyone can start a vote instead. Game in progress keeps running; host-only actions (new game, shuffle, kick) wait for a new host. Seats and teams are untouched.
5. Host powers shown only to host: start, shuffle, kick. Everyone else sees them hidden, with the host chip explaining who has them.
6. Host can hand over voluntarily: "سلّم المضيف" -> pick a person.

### F6 Dealing and dealer jokes
Round start -> dealer badge on one seat -> 3D deal from dealer to each hand (others face-down) -> my cards flip into tray, sorted by suit/rank -> turn banner appears. Tap anywhere or "تخطي" skips animation (instant state). Reduced motion: no flight, cross-fade cards in. Live region: "وزّعنا الورق. عندك N ورقة".
- Dealer joke (إفيه): a speech bubble at the dealer seat on deal (or every 2 rounds per SPEC). Text from the local list (docs/jokes-ar.md -> src/client/ui/jokes-ar.ts), no repeat until all used. Bubble shows 5 s min, tap to dismiss, never covers the hand or confirm bar; polite live region reads it; a "إخفاء الإفيهات" toggle in Settings. It never delays dealing or input. Reduced motion: fade only.

### F7 A turn
1. Banner: "دورك" (pulse + vibration if allowed + sound optional); others: "دور [name]".
2. Tap a card -> it lifts; card info chip shows short effect (from rules-ar).
3. Tap a marble (own, or partner's after finishing) -> destination preview line/ghost. 7 split: second step "الباقي لحجر ثاني", counter of remaining steps. 10: choice "تحرّك 10" / "احرق دور اللي بعدك". A: choice "1" / "11" / "طلّع حجر". J: pick own marble then opponent marble.
4. Confirm bar: "تأكيد" / "إلغاء". Nothing is sent before confirm. Undo only before confirm.
5. Server accepts -> animation (hop, capture burst) -> next turn. Rejected -> toast with reason, selection cleared, hand intact.
6. "وريني الحركات" button (on request only): highlights legal cards/marbles for 5 s; never selects.
7. No legal move: UI shows "ما في حركة. ارمي ورقة" and the card list for discard (or auto per ruleset), with confirm.
8. Turn timer: none by default; optional nudge "ننتظرك" after 60 s to everyone.
9. Burned turn: banner "انحرق دور [name]".
10. Music, voice and sounds never block a move, and moves never block them.

### F8 Voice
- First entry: pre-prompt sheet "الميكروفون للدردشة الصوتية" + "فعّل الميك" / "بدون ميك (استماع فقط)". Browser permission after tap, never on load.
- Mic button fixed in HUD: states off (default muted), live, denied, connecting. Toggle by tap. Speaking ring on avatar of whoever talks.
- Participants up to 8, spectators can speak. Per-person volume and local mute in Voice sheet.
- Failure: "تعذّر الاتصال الصوتي مع [name]" + retry; if TURN not available: "بعض الشبكات ما بتدعم الصوت" (info). Game continues without voice.
- Music volume is separate from voice volume.

### F9 Songs: search, shared queue, no-collision control
1. Songs button -> sheet. Search field (max 80 chars) + "ابحث".
2. Loading: skeleton rows. Results: thumbnail, title (2 lines), "أضف".
3. Add -> toast "انضافت للدور" -> queue list for the whole room (shows who added). Playing item at top with mini-player (always visible, min 16:9 frame; collapses to compact bar that still shows the player). A now-playing chip with title and "{name} غيّر الأغنية" stays visible on the table.
4. Controls on the mini-player and chip, available to every person (players, host, spectators): "غيّر الأغنية" (play a chosen item now), "تخطّي", "إيقاف مؤقت", "إيقاف". No permission prompt to whoever started the song and no confirm dialog; instant, last action wins (server order).
5. Concurrent actions: if two people act at once, the server applies them in order; every client then shows the final state plus a quiet toast naming the last actor ("{name} تخطّى الأغنية"). A control tapped on stale state is not an error: it applies to whatever is playing now. Optimistic pressed state reconciles to server state; skip targets the current track id, so a skip aimed at an already-skipped track is ignored silently (no double-skip).
6. Remove own queue items; host can remove any. Queue cap e.g. 20 (open: confirm).
7. Errors: quota "وصلنا حد البحث لليوم، جرّب بكرة"; rate-limited "على مهلك، جرّب بعد شوي"; video not embeddable -> auto-skip + toast.
8. Autoplay blocked on iOS: "اضغط للتشغيل" button on mini-player (first play per device).
9. Music state lives outside the game state: changes never pause, delay or reorder a turn.

### F10 Intro -> passphrase -> game
Final order (user decision): Intro/logo -> Passphrase gate -> Name entry -> Lobby -> Table.
- Intro shows the original logo with the game name "جاكارو الحُشمين" (damma on ح) before authentication. About 3 s. Tap anywhere or "تخطي" skips at once; skip button reachable by keyboard and visible from t=0. Played once per session, replayable from Settings.
- `prefers-reduced-motion`: static logo for 1 s then auto-continue (or tap), no movement or flashing.
- Loading: assets preload behind the intro; if not ready when the animation ends, a spinner "ثواني..." appears. Failure to load the logo never blocks entry (text fallback).
- Screen reader: intro is decorative (`aria-hidden`); the live region says "أهلا فيك"; the gate heading is read next.

### F11 Game end, result and new game
1. First team to bring all 8 marbles home is marked "خلّصوا": banner "فريق {names} خلّص أول!" Play continues until the other team finishes too (the finished team's turns are skipped).
2. When the second team finishes the table freezes and the Result screen opens as a modal. Focus moves to the heading; polite live region reads the winner. Esc/back closes to table view, with a "النتيجة" button to reopen.
3. Contents: winner (colour + icon + names), both teams' finish positions (1st/2nd), finish times, turns, margin ("فرق {m}:{ss} و{t} دور"), total duration vs expected. Confetti only when motion is allowed.
4. Saving: a small status "عم نحفظ اللعبة..." -> "انحفظت". On save failure: "ما قدرنا نحفظ النتيجة" + "حاول مرة ثانية"; the result still shows.
5. Actions: "لعبة جديدة" (host only; others see "بانتظار المضيف"), "النتائج" (scoreboard), "رجوع للّوبي". Host left -> host claim reopens (F5).
6. New game: return to Lobby with the same people; teams are kept and shown (break or shuffle allowed); start requires 2 complete teams.
7. Spectators see the same result, minus actions.

### F12 Scoreboard
1. Entry: lobby button "النتائج" and result screen.
2. Two tabs: "الفرق" and "اللاعبين" (tablist semantics, arrows switch). Each row: rank, name(s) in `<bdi>`, wins, games played. Tap a row for last games (date, teams, winner, margin, duration).
3. Totals count wins per team (pair of names) and per player; the display name is the identity, so a rename starts a new row (note under the list: "الاسم هو الهوية").
4. History kept 6 months; footer "بنحتفظ بنتايج آخر 6 شهور".
5. Empty: "ما في ألعاب محفوظة لسا. ابدأوا أول لعبة!". Loading: skeleton rows. Error: "ما قدرنا نحمّل النتائج" + retry. Read-only for everyone.
6. Table must be real text (not canvas), sortable by header buttons, keyboard navigable.

### F13 Expected vs elapsed duration
- Lobby: chip "المدة المتوقعة ~ {n} دقيقة". HUD clock chip: "{elapsed} من ~{n} د" with a thin progress bar (decorative; the text carries the info).
- Estimate comes from the engine's normal 4-player reasoning at first, then from the average of saved games. Label stays "متوقعة" (never a promise); copy "ممكن تطول أو تقصر".
- Past expected: neutral-info "عدّينا المتوقع" (no alarm colour, no blame). Clock pauses while the game is paused by a disconnect; elapsed is server time so all clients match.
- Screen reader: not announced every second; read on focus, and announced once at 50% and 100% of the estimate (polite).

## States

| Screen | Empty | Loading | Error |
|---|---|---|---|
| Intro | n/a | spinner after animation if assets late | logo asset fails: text fallback |
| Gate | empty field, button disabled; decoy hint shown | button spinner "ثواني..." | wrong phrase / backoff / network |
| Name entry | empty field, button disabled | button spinner | invalid / name taken / network |
| Lobby | "ما حدا هون لسا"; seats "اقعد هون"; spectators "ما في متفرجين" | skeleton rows while WS connects | room full, connection lost |
| Host claim | n/a | button pending state | taken ("سبقك") / host left banner |
| Partner request | "ما في طلبات" | row "بانتظار رد..." | declined / expired / partner taken |
| Table | before first deal: "بانتظار التوزيع" | 3D loading: progress bar + "عم نجهّز الطاولة" (target under 300 KB JS first) | WebGL unsupported: fallback 2D board with same controls; context lost: auto restore + "رجّعنا الطاولة" |
| Hand | spectator: no tray, "متفرج" and card counts | cards fade in after deal | illegal play toast |
| Dealer joke | list exhausted -> reshuffle silently; jokes hidden -> no bubble | n/a | n/a (local list, works offline) |
| Help | n/a | n/a | n/a (static, offline) |
| Songs | "ما في أغاني بالدور. دوّر على أغنية" | skeleton results | quota / rate / network / not embeddable |
| Voice | "انت لحالك بالصوت" | "عم نوصّل..." | permission denied: steps; peer failed: retry |
| Connection | n/a | banner "عم نعيد الاتصال..." (auto-retry backoff, inputs disabled) | after 30 s "انقطع الاتصال" + "جرّب مرة ثانية" |
| Result | n/a | "عم نحفظ اللعبة..." | save failed + retry (result still shown) |
| Scoreboard | "ما في ألعاب محفوظة لسا" | skeleton rows | load failed + retry |

Reconnect restores seat, team, hand, queue and music state from server view. Session cookie expiry -> back to Gate with "خلصت الجلسة، ادخل من جديد".

## Layout (phone portrait)
- Top bar: room name, team chip (colour + icon), turn banner, clock chip, help (؟), songs, voice, settings.
- Centre: 3D board; pinch zoom / drag rotate optional, "إعادة ضبط الكاميرا" button. Dealer bubble anchors to the dealer seat, clamped inside the safe area.
- Bottom: hand tray (horizontal scroll, cards min 44x64 px, fan on tap), Confirm bar above it, Mic button (min 48 px) bottom-start, always visible. Now-playing chip sits above the top bar edge, not over the hand.
- Side panels (Help, Songs, Voice, Scoreboard, Settings) = bottom sheets on phone, side drawers on desktop.
- Landscape: board left, hand/HUD right; safe-area insets respected.

## Accessibility (WCAG 2.2 AA target)
- Language `lang="ar" dir="rtl"`; mirrored layout; card ranks legible (Latin A K Q J or Arabic labels per design.md); display names and mixed-direction text wrapped with `<bdi>`.
- Contrast: text 4.5:1, UI components and card suits 3:1 on wood/felt and over the cafe 3D scene (bubbles and chips have opaque backgrounds). Cards use suit shape + rank. Teams use colour + icon + label.
- Touch targets at least 44x44 CSS px (24 px minimum per 2.5.8); spacing between marbles' tap areas; large invisible hit area on 3D marbles. "أنا المضيف" and accept/decline buttons are at least 48 px.
- Canvas is not the only way: every board action possible with an accessible list: "اختر ورقة" -> "اختر حجر" -> "وجهة". Keyboard: Tab order hand -> board list -> confirm; arrows within hand; Enter select; Esc cancel. Visible focus ring 3 px, never hidden by sheets.
- Screen reader: `aria-live=polite` for turn, deal, capture, burn, joke, team formed, host changed, song changed, first-team-finished, result; `assertive` only for "دورك" and errors. Partner request is a card with focusable accept/decline, not a focus steal. Canvas `role="img"` with text summary updated per move.
- Host vote: modal-free banner with radio group of candidates, keyboard operable, timer shown as text; result announced.
- Decoy hint on the gate is ordinary helper text linked by `aria-describedby`; it is not presented as a real clue and errors never reference it.
- Dialogs/sheets: focus trap, return focus, labelled, Esc closes, background inert. Result modal: heading focus.
- `prefers-reduced-motion`: no flights/bursts/confetti/intro movement, instant or cross-fade; flashing never above 3 per second.
- Not colour-only for legal-move highlight (outline + badge); on request only.
- Text resizable to 200% without loss; Help and scoreboard are real text with headings/table semantics.
- Errors: associated with fields (`aria-describedby`), plain Arabic, no blame.
- Voice and music have no audio-only info: speaking = visual ring + list text; song title and last actor always text.
- Timing: no time limits on actions (host vote 30 s is a decision window with default "no change"); toasts persist 6 s minimum, pausable on focus/hover, also in a log.
- Password field: paste allowed, show/hide toggle, no autofocus trap. Name field: autofocus ok, counter announced politely at 16.

## Key microcopy (Arabic)
| Key | Text |
|---|---|
| intro.skip | تخطي |
| intro.title | جاكارو الحُشمين |
| gate.title | ادخل الكلمة السرّية |
| gate.hint (decoy) | كم معدل حسن التراكمي؟ |
| gate.cta | دخول |
| gate.wrong | الكلمة مش صح، جرّب مرة ثانية |
| gate.wait | كثّرت المحاولات. استنى {n} ثانية |
| name.label | شو اسمك؟ |
| name.cta | يلا |
| name.invalid | الاسم لازم يكون من حرف لـ 16 حرف بدون رموز غريبة |
| name.taken | في حدا بنفس الاسم، غيّره شوي |
| lobby.empty | ما حدا هون لسا |
| lobby.sit | اقعد هون |
| lobby.spectate | تفرّج |
| lobby.ready | جاهز |
| lobby.start | ابدأ اللعبة |
| lobby.needTeams | لازم فريقين كاملين |
| lobby.full | الغرفة كاملة |
| team.ask | اطلب شريك |
| team.waiting | بانتظار رد {name} |
| team.incoming | {name} بده يكون شريكك |
| team.accept / team.decline | قبول / رفض |
| team.declined | {name} ما قبل. جرّب حدا ثاني |
| team.taken | {name} صار إله شريك |
| team.break | فكّ الشراكة |
| team.shuffle | وزّع الفرق عشوائي |
| team.shuffled | تم توزيع الفرق |
| host.claim | أنا المضيف |
| host.won | {name} هو المضيف |
| host.lost | {name} سبقك بالمضيف |
| host.change | غيّر المضيف |
| host.vote | {name} بده يغيّر المضيف. مين المضيف الجديد؟ |
| host.keep | ما بدي تغيير |
| host.left | المضيف طلع |
| host.handover | سلّم المضيف |
| joke.hide | إخفاء الإفيهات |
| turn.you | دورك |
| turn.other | دور {name} |
| turn.burned | انحرق دور {name} |
| act.confirm | تأكيد |
| act.cancel | إلغاء |
| act.hint | وريني الحركات |
| act.nomove | ما في حركة ممكنة. ارمي ورقة |
| err.illegal | هاي الحركة مش مسموحة |
| err.notturn | مش دورك |
| conn.retry | عم نعيد الاتصال... |
| conn.lost | انقطع الاتصال |
| mic.on / mic.off | الميك شغّال / الميك مسكّر |
| mic.denied | الميك ممنوع. فعّله من إعدادات المتصفح |
| song.search | دوّر على أغنية |
| song.add | أضف للدور |
| song.empty | ما في أغاني بالدور |
| song.quota | وصلنا حد البحث لليوم |
| song.change | غيّر الأغنية |
| song.skip | تخطّي |
| song.pause | إيقاف مؤقت |
| song.stop | إيقاف |
| song.by | {name} تخطّى الأغنية |
| song.tap | اضغط للتشغيل |
| time.expected | المدة المتوقعة ~ {n} دقيقة |
| time.elapsed | {elapsed} من ~{n} د |
| time.over | عدّينا المتوقع |
| time.hint | ممكن تطول أو تقصر |
| end.firstDone | فريق {names} خلّص أول! |
| win.title | مبروك! فاز فريق {names} |
| win.margin | فرق {m}:{ss} و{t} دور |
| win.saving / win.saved | عم نحفظ اللعبة... / انحفظت |
| win.saveFail | ما قدرنا نحفظ النتيجة |
| win.again | لعبة جديدة |
| win.waitHost | بانتظار المضيف |
| score.title | النتائج |
| score.teams / score.players | الفرق / اللاعبين |
| score.empty | ما في ألعاب محفوظة لسا. ابدأوا أول لعبة! |
| score.keep | بنحتفظ بنتايج آخر 6 شهور |
| help.title | كيف بنلعب؟ |

## Open questions for the user (UX side)
- Dealer joke cadence: every deal or every 2 rounds?
- Queue cap and per-user add cap. Can spectators control music (spec now: yes, everyone)?
- Turn timer: none (default) or optional?
- Rule questions: see docs/rules-ar.md.
- Card rank labels: Latin on cards, Arabic names in help (suggested).
