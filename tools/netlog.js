#!/usr/bin/env node
'use strict';
/**
 * 抓视频播放器的进度上报请求。
 *   node tools/netlog.js --port 9223 --seconds 45 --play
 * 只监听含 multimedia 的请求，打印 method/url/postData 与响应体。
 */
const { CDP } = require('../src/cdp');

function parseArgs(argv) {
  const out = { port: 9223, seconds: 45, play: false, tab: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--play') out.play = true;
    else if (a === '--tab') out.tab = Number(argv[++i]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAY_EXPR = `(() => {
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /modules\\/video/.test(f.src || ''));
  const out = [];
  frames.forEach((f, i) => {
    let d = null;
    try { d = f.contentDocument; } catch (e) { return; }
    const v = d.querySelector('video');
    if (!v) return;
    v.muted = true;
    v.playbackRate = 2;
    v.preload = 'auto';
    try { v.load(); } catch (e) {}
    const p = v.play();
    if (p && p.then) p.then(() => out.push(i + ':playing')).catch((e) => out.push(i + ':err ' + e.message));
    else out.push(i + ':called');
  });
  return out;
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  if (!target) throw new Error('没有可用标签页');
  console.log('标签：' + target.title + ' | ' + target.url.slice(0, 100));

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});

  const hits = [];
  const waiters = new Map();
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (!/multimedia|ananas\/[a-z]+\/log|log\?/i.test(u)) return;
    const rec = {
      method: p.request.method,
      url: u.slice(0, 300),
      postData: (p.request.postData || '').slice(0, 2000),
      ts: Date.now(),
    };
    hits.push(rec);
    waiters.set(p.requestId, rec);
  });
  cdp.on('Network.responseReceived', async (p) => {
    const rec = waiters.get(p.requestId);
    if (!rec) return;
    rec.status = p.response.status;
    rec.respUrl = (p.response.url || '').slice(0, 200);
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
      rec.body = (body.body || '').slice(0, 800);
    } catch (e) { /* 可能已丢弃 */ }
  });

  if (args.play) {
    const r = await cdp.eval(sessionId, PLAY_EXPR).catch((e) => 'ERR ' + e.message);
    console.log('播放：' + JSON.stringify(r));
  }

  console.log(`监听 ${args.seconds}s …`);
  await sleep(args.seconds * 1000);

  console.log(`\n抓到 ${hits.length} 条：`);
  hits.forEach((h, i) => {
    console.log(`\n[${i + 1}] ${h.method} ${h.url}`);
    if (h.postData) console.log('  POST: ' + h.postData);
    if (h.status) console.log('  -> ' + h.status + ' ' + (h.body || '').slice(0, 300));
  });
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
