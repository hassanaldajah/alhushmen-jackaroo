# جاكارو الحُشمين (Alhushmen Jackaroo)

لعبة جاكارو أونلاين خاصة بالأصدقاء، تعمل على Cloudflare Workers + Durable Objects، بواجهة three.js عربية RTL للموبايل أولاً.

A private friends-only online Jackaroo game: Cloudflare Worker + SQLite Durable Object (server-authoritative engine), three.js client, Arabic RTL, mobile-first.

## Dev
```
npm install
npm test
npm run build
```
Secrets (passphrase, session secret, API keys) are Worker secrets set with `wrangler secret put`; they are never stored in this repo. Local dev reads `.dev.vars` (gitignored).
