#!/usr/bin/env node
'use strict';
/**
 * 倍速验证：把当前章节页里的视频以指定倍速播放一段时间，
 * 抓取播放器真实发出的 /multimedia/log 请求，看 playingTime 是否随倍速累积、服务端是否接受。
 *
 *   node tools/vtest.js --port 9223 --rate 4 --seconds 60 [--only 1]
 */
const { CDP } = require('../src/cdp');

function parseArgs(argv) {
  const out = { port: 9223, rate: 4, seconds: 60, only: 1, tab: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--rate') out.rate = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--only') out.only = Number(argv[++i]);
    else if (a === '--tab') out.tab = Number(argv[++i]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DRIVE = (rate, ms, only) => `(async () => {
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /modules\\/video/.test(f.src || ''));
  const idx = ${only - 1};
  const f = frames[idx];
  if (!f) return { error: 'no frame ' + idx, count: frames.length };
  const d = f.contentDocument;
  const v = d.querySelector('video');
  if (!v) return { error: 'no video' };
  v.muted = true;
  v.preload = 'auto';
  if (v.readyState < 1) { v.load(); await new Promise((r) => setTimeout(r, 2000)); }
  const enforce = setInterval(() => {
    try {
      if (v.playbackRate !== ${rate}) v.playbackRate = ${rate};
      if (v.paused) v.play().catch(() => {});
    } catch (e) {}
  }, 3000);
  v.playbackRate = ${rate};
  await v.play().catch(() => {});
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < ${ms}) {
    await new Promise((r) => setTimeout(r, 5000));
    samples.push({ t: Math.round(v.currentTime), rate: v.playbackRate, paused: v.paused });
  }
  clearInterval(enforce);
  v.pause();
  return { duration: Math.round(v.duration || 0), samples, wall: Math.round((Date.now() - t0) / 1000) };
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  if (!target) throw new Error('没有可用标签页');
  console.log('标签：' + target.url.slice(0, 100));

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

  const logs = [];
  const waiters = new Map();
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (!/multimedia\/log/i.test(u)) return;
    const pt = /[?&]playingTime=(\d+)/.exec(u);
    const rec = { playingTime: pt ? Number(pt[1]) : null, ts: Date.now() };
    logs.push(rec);
    waiters.set(p.requestId, rec);
  });
  cdp.on('Network.responseReceived', async (p) => {
    const rec = waiters.get(p.requestId);
    if (!rec) return;
    rec.status = p.response.status;
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
      rec.body = (b.body || '').slice(0, 120);
    } catch (e) {}
  });

  const r = await cdp.eval(sessionId, DRIVE(args.rate, args.seconds * 1000, args.only));
  console.log('\n驱动结果：');
  console.log(JSON.stringify(r, null, 1));

  console.log('\n播放器上报记录：');
  logs.forEach((l) => console.log(`  playingTime=${l.playingTime} status=${l.status || '?'} ${l.body || ''}`));
  if (!logs.length) console.log('  （这段时间内没有上报，可能需要更长观察或先点播放）');

  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
