# Security checklist

Check -> pass condition. Test locally only.

## Headers, Host, Origin
1. CRLF (`%0d%0a`) in path, query, name -> never reflected into response headers.
2. Spoofed `Host` / `X-Forwarded-Host` -> no URL or redirect built from them.
3. Missing, `null` or foreign `Origin` on POST and WS upgrade -> 403; exact-match compare.

## Passphrase
4. Body cap (~1 KB) and length cap (~128 chars) before normalization -> 413/400.
5. Non-string JSON (array, object, number, null), missing field -> 400, never 500 or a match.
6. Null bytes, control, zero-width chars -> rejected or stripped per documented rule.
7. HMAC both sides + constant-time equal -> wrong and malformed responses identical in body, status, timing.
8. Passphrase never in logs, errors, URLs or client bundle.

## Rate limiting
9. IP from `CF-Connecting-IP` only; forged `X-Forwarded-For` -> no effect.
10. Counter in the DO, incremented before the compare -> parallel requests cannot exceed the limit.
11. Global cap holds under IP rotation; lockout survives DO eviction.
12. Room id fixed server-side -> clients cannot create DO instances.

## Cookie and session
13. `__Host-` prefix, `HttpOnly; Secure; SameSite=Strict; Path=/`, HMAC-signed (separate secret), expiry inside the signed payload.
14. Tampered, expired, unsigned cookie -> 401; new session id per login; rotating the secret invalidates all.
15. State changes are POST with Origin check -> cross-site form fails.
16. Cross-origin WS upgrade with a valid cookie -> 403 (CSWSH).

## WebSocket messages
17. Frame over cap (~4 KB), binary, bad JSON, unknown type, extra fields -> dropped; close on repeat.
18. Per-socket token bucket; flood -> close, room unaffected. Sockets per session and per room capped (4+4).
19. Out-of-turn play, another player's card/marble, spectator play, non-host kick/start/shuffle -> rejected, state unchanged.
20. No view contains another hand (leak test).

## XSS
21. Names, song titles, jokes, chat rendered with `textContent`, never `innerHTML` -> `<img onerror>` and bidi-override payloads inert.
22. Name server-validated (16 chars, no control/bidi/zero-width).
23. Thumbnail URL rebuilt server-side from videoId on `i.ytimg.com`; client-supplied URLs never used.

## YouTube proxy
24. Upstream host hardcoded; input only as encoded `q` -> no SSRF.
25. videoId `^[A-Za-z0-9_-]{11}$`; query cap; auth required; per-user and daily global limit; DO cache -> quota cannot be drained; key never returned.

## Headers
26. CSP: `default-src 'self'`, no inline/eval scripts, `frame-src` youtube-nocookie only, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
27. `X-Robots-Tag: noindex`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS, `Permissions-Policy` microphone self only; on error responses too.

## Voice
28. Signalling relayed only to a same-room peer; `from` set by server; SDP/ICE size and rate capped.
29. TURN credentials short-lived, authenticated, rate-limited.

## DoS and storage
30. Queue, logs, scores, limiter rows bounded with TTL/pruning -> storage plateaus under abuse.
31. Unauthenticated requests never write unbounded rows.

## Secrets and supply chain
32. Secrets via `wrangler secret` only; `.dev.vars` gitignored; secret scan of repo, history and `dist/` clean.
33. Decoy hint is not a control: security holds without it.
34. Lockfile committed, versions pinned, `npm audit` clean, no CDN scripts, `npm ci` in builds.
