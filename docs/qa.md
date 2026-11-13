# QA report (2026-11-13)

Setup: own `wrangler dev --local --port 8799` (random throwaway secrets via --var, never written), Edge headless via playwright-core (installed outside the repo). Port 8787 untouched. Scripts: `tests/e2e/e2e.mjs` (UI flow), `tests/e2e/attack.mjs` (attacks, local only). Both read the passphrase from env `QA_PASS` only. Screenshots: `docs/shots/` (phone 390x844 and desktop 1280x800).
Note: `prompts/jackaroo-features-2.md` is not in the project; read from `~/prompts/` instead.

## Results
- `npm test`: 104/104 pass. `npm run build`: typecheck + vite OK (JS 693 KB raw / 187 KB gzip; SPEC budget is under 300 KB gzip: OK).
- E2E (after the source hardening landed mid-run): intro -> gate (wrong then right) -> name -> lobby -> host claim -> 4 seats -> mutual partner requests -> spectator -> ready -> start -> 556 random hint-driven turns (21 discards) -> game ended, winner A, saved=true, scoreboard total 1 with correct names. Chat via UI + ws. No XSS executed (names + chat). Hidden-hand check: about 2700 views scanned across 5 sockets, 0 card ids outside own `hand`/`game.last`/`result`. Console errors: only one expected 401 on the pre-auth session probe.
- Attack suite: 48/49 pass (see F1). Covered: wrong/129-char/100 KB/unicode/null-byte/number/array/object/null passphrases (no cookie ever issued; typed junk answered uniformly), cookie flags (`__Host-`, HttpOnly, Secure, SameSite=Strict), tampered cookie, Origin none/evil/null/prefix, X-Forwarded-Host, CRLF header (rejected by the HTTP client itself), brute force (429 with rotating X-Forwarded-For; correct phrase refused during lockout), WS without cookie (4401), WS bad Origin, malformed/typed WS messages, name sanitising (limit 16, control/bidi stripped, `<>` removed), chat control chars stripped, chat flood (4 of 40 delivered), ping flood and garbage frames closed with 4429, security headers/CSP.

## Failures / findings
- F1 (low) `{"t":"chat","text":"x"*20000}` (frame > 16 KiB) returns `bad_msg`, socket stays open. Protocol documents `too_big` and a 16 KiB cap; `validate.ts:107` returns null for oversize so `too_big` is never sent. Likely cause: shared null path. Still counts toward the abuse close, so impact is small.
- F2 (info, fixed during the run) First E2E run showed 4 distinct console errors on every page: `Applying inline style violates CSP style-src 'self'` (inline style attributes in intro/UI). Gone after the later source change; re-verify on deploy.
- F3 (UI, phone 390 px) `docs/shots/phone-9-midgame.png`: top status bar overflows horizontally (chat button clipped on the left, team chip and name cut on the right); the toast overlaps the hint button; the 3D hand fan and the 2D hand duplicate the same cards.
- F4 (info) Local only: `CF-Connecting-IP` is trusted, so it can reset the rate-limit bucket in local dev. Cloudflare overwrites that header at the edge; no prod issue. Locally all clients share the `unknown` bucket, so a brute-force test locks the dev server for up to 15 min (restart it).
- F5 (info) A name like `Omar<img src=x onerror=...>` is stored as `Omarimg src=x o` (sanitised, not rejected). Fine.

## Not tested
Real voice (WebRTC, mic), YouTube search/player (no API key), iPhone 30 fps / quality toggle (headless software GL), prod headers on Cloudflare, TURN, reduced-motion path, DO restart persistence (not exercised).
