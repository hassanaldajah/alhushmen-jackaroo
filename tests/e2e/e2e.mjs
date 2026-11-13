// E2E against a LOCAL wrangler dev server. Secrets come from env only (QA_PASS), never from files.
// Usage: QA_PASS=... QA_PW=<dir with playwright-core> node tests/e2e/e2e.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.QA_PW + '/package.json');
const { chromium } = require('playwright-core');

const BASE = process.env.QA_BASE || 'http://localhost:8799';
const PASS = process.env.QA_PASS;
const SHOTS = new URL('../../docs/shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(SHOTS, { recursive: true });
const report = { errors: [], notes: [], fails: [] };
const note = (s) => { console.log(s); report.notes.push(s); };
const fail = (s) => { console.log('FAIL: ' + s); report.fails.push(s); };
let noDiscard = 0, emptyRetries = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const names = ['سالم', 'ليلى', 'Omar<img src=x onerror=window.__xss=1>', 'نور'];

async function mk(i, vp, tag) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: vp.width < 600, isMobile: vp.width < 600 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`[${tag}] console.error: ${m.text()}`); });
  page.on('pageerror', (e) => report.errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => report.errors.push(`[${tag}] requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.addInitScript(() => {
    window.__msgs = [];
    const NW = window.WebSocket;
    window.WebSocket = class extends NW {
      constructor(...a) { super(...a); window.__ws = this; this.addEventListener('message', (e) => { window.__msgs.push(e.data); if (window.__msgs.length > 4000) window.__msgs.shift(); }); }
    };
  });
  return { ctx, page, tag, i };
}
const shot = (p, n) => p.page.screenshot({ path: `${SHOTS}${n}.png` }).catch((e) => fail('shot ' + n + ' ' + e.message));
const lastView = (p) => p.page.evaluate(() => { for (let i = window.__msgs.length - 1; i >= 0; i--) { if (window.__msgs[i].startsWith('{"t":"view"')) return JSON.parse(window.__msgs[i]).view; } return null; });
const send = (p, m) => p.page.evaluate((s) => window.__ws.send(s), JSON.stringify(m));

const players = [];
// p0 desktop, others phone
players.push(await mk(0, { width: 1280, height: 800 }, 'P0-desktop'));
for (let i = 1; i < 4; i++) players.push(await mk(i, { width: 390, height: 844 }, 'P' + i + '-phone'));
const spec = await mk(4, { width: 390, height: 844 }, 'SPEC-phone');

async function enter(p, name, gateShot, wrongFirst) {
  await p.page.goto(BASE + '/');
  await sleep(700);
  if (gateShot) await shot(p, gateShot + '-1-intro');
  await p.page.mouse.click(50, 50).catch(() => {});
  await p.page.waitForSelector('#ph', { timeout: 8000 }).catch(() => fail(p.tag + ': gate input #ph never appeared'));
  if (gateShot) await shot(p, gateShot + '-2-gate');
  if (wrongFirst) {
    await p.page.fill('#ph', 'definitely-wrong-' + Math.random());
    await p.page.click('button[type=submit]');
    await p.page.waitForSelector('#gerr:not(:empty)', { timeout: 5000 }).catch(() => fail('wrong passphrase shows no error'));
    if (gateShot) await shot(p, gateShot + '-3-gate-wrong');
  }
  await p.page.fill('#ph', PASS);
  await p.page.click('button[type=submit]');
  await p.page.waitForSelector('#nm', { timeout: 8000 }).catch(() => fail(p.tag + ': name screen never appeared after correct passphrase'));
  if (gateShot) await shot(p, gateShot + '-4-name');
  await p.page.fill('#nm', name);
  if (p.tag.startsWith('SPEC')) {
    // pick spectator segment (second segmented button)
    const segs = p.page.locator('.row[role=group] button');
    if (await segs.count() > 1) await segs.nth(1).click();
  }
  await p.page.click('form button[type=submit]');
  await sleep(1200);
}

try {
  for (let i = 0; i < 4; i++) await enter(players[i], names[i], i === 0 ? 'desktop' : i === 1 ? 'phone' : null, i === 0);
  await shot(players[0], 'desktop-5-lobby-first');
  await sleep(500);
  // host claim by UI on p0
  await players[0].page.getByText('أنا المضيف').first().click().catch(() => fail('host claim button not found'));
  await sleep(500);
  for (let i = 0; i < 4; i++) await send(players[i], { t: 'sit', seat: i });
  await sleep(600);
  await shot(players[1], 'phone-6-lobby-seated');
  // partner request: seat0 asks seat2 (pairs opposite); then the other two via host shuffle fallback
  let v = await lastView(players[0]);
  const idOf = (v, s) => v.seats[s].id;
  await send(players[0], { t: 'partnerReq', to: idOf(v, 2) });
  await sleep(400);
  await send(players[2], { t: 'partnerAnswer', from: idOf(v, 0), accept: true });
  await sleep(400);
  await send(players[1], { t: 'partnerReq', to: idOf(v, 3) });
  await sleep(300);
  await send(players[3], { t: 'partnerAnswer', from: idOf(v, 1), accept: true });
  await sleep(600);
  // spectator
  await enter(spec, 'متفرج', 'spectator', false);
  await sleep(500);
  v = await lastView(players[0]);
  note(`after pairing: canStart=${v.canStart} phase=${v.phase} paired=${v.seats.map((s) => s.paired)} spectators=${v.spectators.length}`);
  for (let i = 0; i < 4; i++) await send(players[i], { t: 'ready', value: true });
  await sleep(400);
  await shot(players[0], 'desktop-7-lobby-ready');
  await send(players[0], { t: 'start' });
  await sleep(2500);
  v = await lastView(players[0]);
  if (v.phase !== 'playing') fail('game did not start; phase=' + v.phase + ' canStart=' + v.canStart);
  await shot(players[0], 'desktop-8-deal');
  await shot(players[1], 'phone-8-deal');
  await shot(spec, 'spectator-8-deal');

  // chat via UI on p1, XSS via ws on p3
  await players[1].page.getByLabel('الدردشة').first().click().catch(() => fail('chat button not found'));
  await sleep(300);
  await players[1].page.fill('.sheet input, input[placeholder="اكتب رسالة"]', 'مرحبا <script>window.__xss=2</script>').catch(() => fail('chat input not found'));
  await players[1].page.keyboard.press('Enter');
  await sleep(400);
  await send(players[3], { t: 'chat', text: '<img src=x onerror=window.__xss=3>&lt;b&gt;' });
  await sleep(500);
  await shot(players[1], 'phone-9-chat');
  const xss = await Promise.all([...players, spec].map((p) => p.page.evaluate(() => window.__xss)));
  if (xss.some((x) => x !== undefined)) fail('XSS executed: ' + JSON.stringify(xss)); else note('XSS: none executed in 5 pages (names + chat)');
  const injected = await players[1].page.evaluate(() => document.querySelectorAll('script:not([src]), img[src=x]').length);
  if (injected) fail('injected elements found in DOM: ' + injected);

  // hint -> play loop through each page's own socket
  let turns = 0, stalls = 0, shotMid = false;
  const t0 = Date.now();
  while (turns < 2500 && Date.now() - t0 < 240000) {
    v = await lastView(players[0]);
    if (!v || v.phase !== 'playing') break;
    const seat = v.turnSeat;
    if (seat === null || v.game?.paused) { await sleep(200); if (++stalls > 100) { fail('stalled with turnSeat null/paused'); break; } continue; }
    const p = players[seat];
    const before = v.game.deck + '|' + v.turnSeat + '|' + JSON.stringify(v.game.last?.card);
    await p.page.evaluate(() => { window.__hint = null; window.__ws.send('{"t":"hint"}'); });
    let plays = null;
    for (let k = 0; k < 40 && !plays; k++) { await sleep(25); plays = await p.page.evaluate(() => { for (let i = window.__msgs.length - 1; i >= Math.max(0, window.__msgs.length - 10); i--) { if (window.__msgs[i].startsWith('{"t":"hint"')) { const r = JSON.parse(window.__msgs[i]).plays; window.__msgs.splice(i, 1); return r; } } return null; }); }
    let pick;
    if (!plays || !plays.length) {
      // no legal move: discard any card (protocol: [{k:'discard'}])
      const pv = await lastView(p);
      if (!pv.hand.length) { await sleep(400); if (++emptyRetries > 50) { fail(`seat ${seat} empty hand on its turn (persisting)`); break; } continue; }
      pick = { cardId: pv.hand[0].id, moves: [{ k: 'discard' }] };
      noDiscard++;
    } else pick = plays[Math.floor(Math.random() * plays.length)];
    await send(p, { t: 'play', cardId: pick.cardId, moves: pick.moves });
    await sleep(35);
    turns++;
    if (turns === 12 && !shotMid) { shotMid = true; await sleep(700); await shot(players[0], 'desktop-9-midgame'); await shot(players[2], 'phone-9-midgame'); await shot(spec, 'spectator-9-midgame'); }
  }
  v = await lastView(players[0]);
  note(`discards=${noDiscard} turns played=${turns} phase=${v.phase} finishes=${v.finishes?.length}`);
  await sleep(2500);
  await shot(players[0], 'desktop-10-end');
  await shot(players[1], 'phone-10-end');
  await shot(spec, 'spectator-10-end');
  v = await lastView(players[0]);
  if (v.phase === 'ended') {
    note('result: ' + JSON.stringify({ winner: v.winner, saved: v.result?.saved, durationMs: v.result?.durationMs, marginTurns: v.result?.marginTurns }));
    await send(players[0], { t: 'scoreboard' });
    await send(players[0], { t: 'toLobby' });
    await sleep(1000);
    await players[0].page.getByText('النتائج').first().click().catch(() => note('scoreboard button not clickable in lobby'));
    await sleep(800);
    await shot(players[0], 'desktop-11-scoreboard');
    const sb = await players[0].page.evaluate(() => { for (let i = window.__msgs.length - 1; i >= 0; i--) if (window.__msgs[i].startsWith('{"t":"scoreboard"')) return JSON.parse(window.__msgs[i]).board; return null; });
    note('scoreboard total=' + sb?.total + ' teams=' + JSON.stringify(sb?.teams));
    if (!sb || sb.total < 1) fail('scoreboard total < 1 after finished game');
  } else fail('game did not reach ended within limit; phase=' + v.phase);

  // hidden-hand leak check across all captured messages
  const CARD = /"(?:10|[2-9AJQK])[SHDC]"/g;
  for (const p of [...players, spec]) {
    const msgs = await p.page.evaluate(() => window.__msgs);
    let leaks = 0, views = 0;
    for (const m of msgs) {
      if (!m.startsWith('{"t":"view"')) continue;
      views++;
      const o = JSON.parse(m);
      const view = o.view;
      const copy = JSON.parse(JSON.stringify(view));
      delete copy.hand; if (copy.game) delete copy.game.last; delete copy.result;
      const found = JSON.stringify(copy).match(CARD);
      if (found) leaks++;
      if (view.you.spectator && view.hand.length) leaks++;
      if (view.seats.some((s, i) => i !== view.you.seat && (typeof s.cards !== 'number'))) leaks++;
    }
    note(`${p.tag}: ${views} views scanned, leaks=${leaks}`);
    if (leaks) fail(`${p.tag}: card ids found outside own hand in ${leaks} view(s)`);
  }
} catch (e) {
  fail('script exception: ' + e.stack);
}
const uniq = [...new Set(report.errors)];
note('console/page errors: ' + uniq.length);
uniq.slice(0, 30).forEach((e) => console.log('  ' + e));
writeFileSync(new URL('./e2e-last.json', import.meta.url), JSON.stringify({ notes: report.notes, fails: report.fails, errors: uniq }, null, 2));
await browser.close();
process.exit(0);
