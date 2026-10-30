#!/usr/bin/env node
'use strict';
/**
 * 閫氱敤鎺㈤拡 / 椤甸潰鏈哄櫒浜恒€? *
 *   node tools/probe.js                          # 姒傝褰撳墠锛堢涓€涓級chaoxing 鏍囩椤? *   node tools/probe.js --tab 1                  # 姒傝绗?1 鍙锋爣绛鹃〉锛?json/list 椤哄簭锛? *   node tools/probe.js --nav "https://..."      # 鍏堝鑸啀姒傝
 *   node tools/probe.js --expr "document.title"  # 鎵ц鑷畾涔夎〃杈惧紡
 *   node tools/probe.js --text                   # 鎵撳嵃鏁撮〉 innerText
 *   node tools/probe.js --click "text=浣滀笟"      # 鐐瑰嚮绗竴涓寘鍚鏂囧瓧鐨勫彲瑙佸厓绱? */
const path = require('path');
const { load } = require('../src/config');
const { CDP } = require('../src/cdp');

const ROOT = path.resolve(__dirname, '..');

const DUMP_EXPR = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clickables = [...document.querySelectorAll('a,button,[role="button"],li,div,span')]
    .filter((el) => vis(el) && clean(el.innerText) && clean(el.innerText).length <= 30)
    .filter((el) => el.children.length <= 3)
    .slice(0, 120)
    .map((el) => clean(el.innerText));
  return {
    url: location.href,
    title: document.title,
    iframes: [...document.querySelectorAll('iframe')].map((f) => f.src || '(no src)'),
    counts: {
      TiMu: document.querySelectorAll('.TiMu').length,
      chapter_item: document.querySelectorAll('.chapter_item').length,
      links: document.querySelectorAll('a').length,
    },
    clickables: [...new Set(clickables)],
    textHead: clean(document.body ? document.body.innerText : '').slice(0, 1500),
  };
})()`;

const CLICK_EXPR = (needle) => `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const needle = ${JSON.stringify(needle)};
  const cands = [...document.querySelectorAll('a,button,[role="button"],li,div,span')]
    .filter((el) => vis(el) && clean(el.innerText).includes(needle));
  // 鍙栨渶鍐呭眰锛堟病鏈夊悓鏍峰懡涓殑瀛愬瓩鍏冪礌锛?  const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
  const el = inner[0] || cands[0];
  if (!el) return { ok: false, error: 'not found: ' + needle, tried: cands.length };
  const r = el.getBoundingClientRect();
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, tag: el.tagName, text: clean(el.innerText).slice(0, 80), rect: [r.x, r.y, r.width, r.height] };
})()`;

function parseArgs(argv) {
  const out = { tab: null, nav: null, expr: null, text: false, click: null, cdp: 9222, file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tab') out.tab = Number(argv[++i]);
    else if (a === '--nav') out.nav = argv[++i];
    else if (a === '--navb64') out.nav = Buffer.from(argv[++i], 'base64').toString('utf8');
    else if (a === '--expr') out.expr = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--text') out.text = true;
    else if (a === '--click') out.click = argv[++i];
    else if (a === '--cdp') out.cdp = Number(argv[++i]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveExpr(args) {
  let expr = DUMP_EXPR;
  if (args.file) expr = require('fs').readFileSync(path.resolve(ROOT, args.file), 'utf8');
  if (args.expr) expr = args.expr;
  if (args.text) expr = 'document.body ? document.body.innerText : ""';
  if (args.click) expr = CLICK_EXPR(args.click);
  return expr;
}

async function main() {
  const args = parseArgs(process.argv);
  load(ROOT);
  const pages = (await (await fetch(`http://127.0.0.1:${args.cdp}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  if (args.tab != null && pages[args.tab]) {
    const target = pages[args.tab];
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    if (args.nav) {
      await cdp.send('Page.navigate', { url: args.nav }, sessionId);
      await sleep(4500);
    }
    const expr = resolveExpr(args);
    const r = await cdp.eval(sessionId, expr);
    console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
    if (args.click) {
      await sleep(3500);
      const after = await cdp.eval(sessionId, 'location.href').catch(() => '');
      console.log('\nAfter click url: ' + after);
      const txt = await cdp.eval(sessionId, 'document.body ? document.body.innerText.replace(/\\s+/g," ").slice(0,800) : ""').catch(() => '');
      console.log('After click text: ' + txt);
    }
    cdp.close();
    return;
  }
  const attached = await CDP.attachPage(args.cdp, 'chaoxing');
  if (args.nav) {
    await attached.cdp.send('Page.navigate', { url: args.nav }, attached.sessionId);
    await sleep(4500);
  }
  const expr = resolveExpr(args);
  const r = await attached.cdp.eval(attached.sessionId, expr);
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  attached.cdp.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
