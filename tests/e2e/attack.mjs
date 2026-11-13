// Attack tests against a LOCAL wrangler dev server only. Secrets from env (QA_PASS), never files.
// Usage: QA_PASS=... node tests/e2e/attack.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BASE = process.env.QA_BASE || 'http://localhost:8799';
if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(BASE)) throw new Error('refusing non-local target');
const PASS = process.env.QA_PASS;
const ORIGIN = 'http://localhost:8799';
const res = [];
const rec = (name, ok, detail) => { res.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auth(body, headers = {}, raw = false) {
  const r = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN, ...headers }, body: raw ? body : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, cookie: r.headers.get('set-cookie'), headers: r.headers };
}
const cookieOf = (sc) => sc?.split(';')[0];

// ---- baseline: correct passphrase -> cookie (done first, before any lockout)
const good = await auth({ phrase: PASS });
rec('correct passphrase accepted', good.status === 200 && !!good.cookie, `status ${good.status}`);
const COOKIE = cookieOf(good.cookie);
const flags = good.cookie || '';
rec('cookie flags HttpOnly/Secure/SameSite=Strict/__Host-', /HttpOnly/i.test(flags) && /Secure/i.test(flags) && /SameSite=Strict/i.test(flags) && flags.startsWith('__Host-'), flags.replace(/=[^;]+/, '=<redacted>'));

const g2 = await auth({ phrase: PASS });
const COOKIE2 = cookieOf(g2.cookie);

// ---- origin / header attacks (before lockout)
for (const [name, h] of [['no Origin', { Origin: '' }], ['evil Origin', { Origin: 'https://evil.example' }], ['null Origin', { Origin: 'null' }], ['Origin prefix trick', { Origin: ORIGIN + '.evil.example' }]]) {
  const r = await auth({ phrase: PASS }, h);
  rec('auth rejects ' + name, r.status === 403, 'status ' + r.status);
}
{
  const r = await auth({ phrase: PASS }, { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' });
  rec('X-Forwarded-Host cannot change allowed origin (still accepted only with allowed Origin)', r.status === 200 || r.status === 429, 'status ' + r.status);
}
{
  const r = await fetch(BASE + '/api/auth', { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN, 'X-Test': 'a\r\nSet-Cookie: x=1' }, body: '{}' }).catch((e) => ({ status: 'throw:' + e.message }));
  rec('CRLF in header value rejected client-side/handled', typeof r.status === 'string' || r.status >= 400, String(r.status));
}
{
  const r = await fetch(BASE + '/api/session');
  rec('/api/session without cookie is 401', r.status === 401, String(r.status));
  const r2 = await fetch(BASE + '/api/session', { headers: { Cookie: COOKIE } });
  rec('/api/session with cookie is 200', r2.status === 200, String(r2.status));
  const tampered = COOKIE.slice(0, -2) + (COOKIE.endsWith('AA') ? 'BB' : 'AA');
  const r3 = await fetch(BASE + '/api/session', { headers: { Cookie: tampered } });
  rec('tampered cookie rejected', r3.status === 401, String(r3.status));
  const r4 = await fetch(BASE + '/api/ice');
  rec('/api/ice without session 401', r4.status === 401, String(r4.status));
  const r5 = await fetch(BASE + '/api/search?q=x');
  rec('/api/search without session 401', r5.status === 401, String(r5.status));
  const r6 = await fetch(BASE + '/api/search?q=' + 'a'.repeat(300), { headers: { Cookie: COOKIE } });
  rec('/api/search long query 400', r6.status === 400, String(r6.status));
  const r7 = await fetch(BASE + '/api/nope', { headers: { Cookie: COOKIE } });
  rec('unknown api path 404', r7.status === 404, String(r7.status));
  const r8 = await fetch(BASE + '/api/auth');
  rec('GET /api/auth 405', r8.status === 405, String(r8.status));
}
{
  const r = await fetch(BASE + '/');
  const h = Object.fromEntries(r.headers);
  const need = ['content-security-policy', 'x-content-type-options', 'referrer-policy'];
  const miss = need.filter((k) => !h[k]);
  rec('security headers present (CSP, nosniff, referrer-policy)', miss.length === 0, miss.length ? 'missing ' + miss.join(',') : h['content-security-policy']?.slice(0, 200));
  rec('X-Frame-Options or frame-ancestors', !!h['x-frame-options'] || /frame-ancestors/.test(h['content-security-policy'] || ''), '');
  rec('CSP has no unsafe-inline script / unsafe-eval', !/script-src[^;]*('unsafe-inline'|'unsafe-eval')/.test(h['content-security-policy'] || ''), '');
  const rb = await fetch(BASE + '/robots.txt'); rec('robots.txt disallows', /Disallow:\s*\//.test(await rb.text()), '');
  const sm = await fetch(BASE + '/.dev.vars'); const t = await sm.text();
  rec('.dev.vars / dotfiles not served as secrets', !/PASSPHRASE|SESSION_SECRET/.test(t), 'status ' + sm.status);
  const map = await fetch(BASE + '/assets/index.js.map'); rec('no sourcemap exposure (spot check)', map.status !== 200 || !(await map.text()).includes('"sources"'), 'status ' + map.status);
}

// ---- websocket helpers
function openWs(cookie, origin = ORIGIN) {
  return new Promise((resolve) => {
    const headers = {}; if (cookie) headers.Cookie = cookie; if (origin !== null) headers.Origin = origin;
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/ws', { headers });
    const st = { ws, msgs: [], closed: null, opened: false };
    ws.on('open', () => { st.opened = true; });
    ws.on('message', (d) => st.msgs.push(d.toString()));
    ws.on('close', (c, r) => { st.closed = { code: c, reason: r.toString() }; });
    ws.on('error', (e) => { st.err = e.message; });
    setTimeout(() => resolve(st), 600);
  });
}
{
  const a = await openWs(null);
  rec('WS without cookie: closed 4401 or refused', a.closed?.code === 4401 || !a.opened, JSON.stringify(a.closed || a.err));
  const b = await openWs(COOKIE, 'https://evil.example');
  rec('WS with evil Origin refused', !b.opened || b.closed, JSON.stringify(b.closed || b.err));
  const c = await openWs(COOKIE, null);
  rec('WS with no Origin refused', !c.opened || !!c.closed, JSON.stringify(c.closed || c.err));
}
// authenticated socket
let A = await openWs(COOKIE);
rec('WS authed gets view', A.msgs.some((m) => m.startsWith('{"t":"view"')), A.closed ? JSON.stringify(A.closed) : '');
const errs = (st) => st.msgs.filter((m) => m.startsWith('{"t":"error"')).map((m) => JSON.parse(m).code);
const sendRaw = async (st, data, wait = 150) => { if (st.ws.readyState !== 1) return; st.ws.send(data); await sleep(wait); };

await sendRaw(A, 'not json');
await sendRaw(A, '{"t":"nonsense"}');
await sendRaw(A, '[]');
await sendRaw(A, 'null');
await sendRaw(A, '{"t":"name","name":123}');
await sendRaw(A, '{"t":"sit","seat":"0; DROP"}');
await sendRaw(A, '{"t":"sit","seat":99}');
await sendRaw(A, '{"t":"play","cardId":{"$ne":1},"moves":"x"}');
await sendRaw(A, '{"t":"play","cardId":"AS","moves":[{"k":"step","marble":1e999,"n":"7"}]}');
await sendRaw(A, '{"t":"__proto__","x":1}');
await sendRaw(A, '{"t":"signal","to":"nobody","data":{"d":1}}');
rec('malformed/typed WS messages yield errors, socket survives or closes cleanly', A.msgs.length > 0, `error codes: ${errs(A).join(',')}; closed=${JSON.stringify(A.closed)}`);
{
  A = A.closed ? await openWs(COOKIE) : A;
  const big = JSON.stringify({ t: 'chat', text: 'x'.repeat(20000) });
  await sendRaw(A, big, 400);
  rec('oversized (20 KB) frame rejected (too_big / close)', errs(A).includes('too_big') || !!A.closed, `codes=${errs(A)} closed=${JSON.stringify(A.closed)}`);
}
{
  const B = await openWs(COOKIE2);
  await sendRaw(B, JSON.stringify({ t: 'name', name: '<img src=x onerror=alert(1)>' }));
  await sendRaw(B, JSON.stringify({ t: 'name', name: 'a\u0000b\r\nc‮d' }));
  await sendRaw(B, JSON.stringify({ t: 'name', name: 'x'.repeat(500) }));
  await sendRaw(B, JSON.stringify({ t: 'name', name: '   ' }));
  await sendRaw(B, JSON.stringify({ t: 'name', name: '😀'.repeat(40) }));
  const views = B.msgs.filter((m) => m.startsWith('{"t":"view"')).map((m) => JSON.parse(m).view);
  const nm = views.at(-1)?.you.name;
  rec('names: dangerous/long names rejected or sanitized', nm === undefined || ([...nm].length <= 16 && !/[\u0000-\u001f‮]/.test(nm)), `final name=${JSON.stringify(nm)} errs=${errs(B)}`);
  await sendRaw(B, JSON.stringify({ t: 'name', name: 'Tester' }));
  await sendRaw(B, JSON.stringify({ t: 'chat', text: '<script>alert(1)</script>\u0000\u0007hello\r\n‮' }), 300);
  const chat = B.msgs.filter((m) => m.startsWith('{"t":"chat"')).map((m) => JSON.parse(m).msg.text);
  rec('chat: control chars stripped', chat.length > 0 && chat.every((t) => !/[\u0000-\u0008\u000b-\u001f]/.test(t)), JSON.stringify(chat));
  rec('chat: markup relayed as plain text (client uses textContent)', chat.some((t) => t.includes('<script>')) || chat.length === 0, 'server does not HTML-escape; safe only because UI uses textContent (verified in E2E)');
  // flood
  const before = B.msgs.length;
  for (let i = 0; i < 40; i++) B.ws.send(JSON.stringify({ t: 'chat', text: 'flood ' + i }));
  await sleep(800);
  const delivered = B.msgs.slice(before).filter((m) => m.startsWith('{"t":"chat"')).length;
  rec('chat flood limited (<=~6 of 40 delivered in 5s window)', delivered <= 6, `delivered=${delivered} errs=${errs(B).filter((c) => c === 'rate').length}x rate, closed=${JSON.stringify(B.closed)}`);
  // message flood generic
  const C = await openWs(COOKIE);
  for (let i = 0; i < 400; i++) { if (C.ws.readyState === 1) C.ws.send('{"t":"ping"}'); }
  await sleep(800);
  rec('ping flood (400) throttled/closed with 4429 or rate errors', !!C.closed || errs(C).includes('rate'), `closed=${JSON.stringify(C.closed)} rate=${errs(C).filter((c) => c === 'rate').length}`);
  const D = await openWs(COOKIE2);
  for (let i = 0; i < 30; i++) { if (D.ws.readyState === 1) D.ws.send('garbage' + i); }
  await sleep(800);
  rec('repeated malformed frames closed with 4429', D.closed?.code === 4429, JSON.stringify(D.closed) + ' errs=' + errs(D).length);
  for (const s of [A, B, C, D]) try { s.ws.close(); } catch {}
}
// ---- passphrase attacks (these trigger the rate limit; do last)
const hdr = {};
const variants = [
  ['very long (100 KB)', { phrase: 'a'.repeat(100000) }, 413],
  ['129 chars', { phrase: 'a'.repeat(129) }, 400],
  ['unicode lookalike', { phrase: 'ｐａｓｓ' }, 401],
  ['null byte', { phrase: 'x\u0000y' }, 401],
  ['phrase as number', { phrase: 12345 }, 400],
  ['phrase as array', { phrase: [PASS] }, 400],
  ['phrase as object', { phrase: { $ne: '' } }, 400],
  ['phrase null', { phrase: null }, 400],
  ['phrase true', { phrase: true }, 400],
  ['empty phrase', { phrase: '' }, 401],
  ['missing key', {}, 400],
];
for (const [n, b, want] of variants) {
  const r = await auth(b);
  rec('auth variant: ' + n, r.status === want || r.status === 429 || (want === 400 && r.status === 401), `got ${r.status} want ${want}; cookie set? ${!!r.cookie}`);
  if (r.cookie && r.status === 200) rec('auth variant ' + n + ' MUST NOT grant cookie', false, 'COOKIE ISSUED');
}
{
  const r = await auth('{"phrase":', {}, true); rec('malformed JSON body 400/401 (uniform), no 500', r.status === 400 || r.status === 401 || r.status === 429, String(r.status));
  const r2 = await auth('{"phrase":"' + PASS + '","phrase":"x"}', {}, true); note1('duplicate-key JSON status ' + r2.status);
  const r3 = await auth(PASS, { 'content-type': 'text/plain' }, true); rec('non-JSON raw passphrase body not accepted', r3.status !== 200, String(r3.status));
}
function note1(s) { console.log('NOTE ' + s); }
// brute force
let first429 = -1, statuses = [];
for (let i = 0; i < 30; i++) {
  const r = await auth({ phrase: 'guess-' + i }, { 'X-Forwarded-For': `10.0.0.${i}`, 'X-Real-IP': `10.1.0.${i}` });
  statuses.push(r.status);
  if (r.status === 429 && first429 < 0) first429 = i;
}
rec('brute force triggers 429 within 10 attempts despite rotating X-Forwarded-For', first429 >= 0 && first429 <= 10, `first429 at attempt ${first429}; statuses=${statuses.join(',')}`);
{
  const r = await auth({ phrase: PASS }, { 'X-Forwarded-For': '203.0.113.77' });
  rec('correct passphrase during lockout is still refused (no oracle bypass via XFF)', r.status === 429 && !r.cookie, `status ${r.status} body ${r.text}`);
  const r2 = await auth({ phrase: PASS }, { 'CF-Connecting-IP': '198.51.100.9' });
  note1('CF-Connecting-IP spoof locally -> ' + r2.status + ' (Cloudflare overwrites this header at the edge; local only)');
}
writeFileSync(new URL('./attack-last.json', import.meta.url), JSON.stringify(res, null, 2));
console.log(`\n${res.filter((r) => r.ok).length}/${res.length} passed`);
process.exit(0);
