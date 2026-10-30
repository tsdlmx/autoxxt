#!/usr/bin/env node
'use strict';
/**
 * 视频播放诊断 + 倍速验证。
 *   node tools/vtest.js --port 9223 --rate 2 --seconds 40 --only 2
 * 会：开启焦点模拟 → 点击播放按钮 → 持续维持倍速 → 采样画面状态与上报记录。
 */
const { CDP } = require('../src/cdp');

function parseArgs(argv) {
  const out = { port: 9223, rate: 2, seconds: 40, only: 1, tab: null, click: true };
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
  const diag = {
    topHidden: document.hidden,
    topState: document.visibilityState,
    topFocus: document.hasFocus(),
  };
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /modules\\/video/.test(f.src || ''));
  const idx = ${only - 1};
  const f = frames[idx];
  if (!f) return { error: 'no frame', count: frames.length, diag };
  const rect = f.getBoundingClientRect();
  const d = f.contentDocument;
  const v = d.querySelector('video');
  if (!v) return { error: 'no video', diag };
  const vrect = v.getBoundingClientRect();
  const out = {
    diag,
    frameRect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    videoRect: [Math.round(vrect.width), Math.round(vrect.height)],
    frameHidden: d.hidden,
    frameState: d.visibilityState,
    frameFocus: d.hasFocus(),
    duration: Math.round(v.duration || 0),
  };

  // 尝试点击 big play 按钮（更接近真人操作）
  const btn = d.querySelector('.vjs-big-play-button') || d.querySelector('.vjs-play-control');
  if (btn) { try { btn.click(); out.clickedBtn = btn.className; } catch (e) { out.clickErr = e.message; } }

  v.muted = true;
  v.preload = 'auto';
  if (v.readyState < 1) { v.load(); await new Promise((r) => setTimeout(r, 2000)); }
  const playRes = await v.play().then(() => 'ok').catch((e) => 'err:' + e.name + ':' + e.message);
  out.playResult = playRes;
  v.playbackRate = ${rate};

  const enforce = setInterval(() => {
    try {
      if (v.playbackRate !== ${rate}) v.playbackRate = ${rate};
      if (v.paused) v.play().catch(() => {});
    } catch (e) {}
  }, 2000);

  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < ${ms}) {
    await new Promise((r) => setTimeout(r, 4000));
    samples.push({
      ct: Math.round(v.currentTime),
      rate: v.playbackRate,
      paused: v.paused,
      ready: v.readyState,
      hidden: document.hidden,
      focus: document.hasFocus(),
      elHidden: d.hidden,
    });
  }
  clearInterval(enforce);
  v.pause();
  out.samples = samples;
  out.wall = Math.round((Date.now() - t0) / 1000);
  return out;
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  if (!target) throw new Error('没有可用标签页');

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
  // 让页面始终认为自己在前台
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch((e) => console.log('focusEmu: ' + e.message));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

  const logs = [];
  const waiters = new Map();
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (!/multimedia\/log/i.test(u)) return;
    const pt = /[?&]playingTime=(\d+)/.exec(u);
    const rec = { playingTime: pt ? Number(pt[1]) : null };
    logs.push(rec);
    waiters.set(p.requestId, rec);
  });
  cdp.on('Network.responseReceived', async (p) => {
    const rec = waiters.get(p.requestId);
    if (!rec) return;
    rec.status = p.response.status;
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
      rec.body = (b.body || '').slice(0, 100);
    } catch (e) {}
  });

  const r = await cdp.eval(sessionId, DRIVE(args.rate, args.seconds * 1000, args.only));
  console.log(JSON.stringify(r, null, 1));

  console.log('\n上报（前 5 条 / 共 ' + logs.length + ' 条）：');
  logs.slice(0, 5).forEach((l) => console.log(`  playingTime=${l.playingTime} status=${l.status || '?'} ${l.body || ''}`));
  if (logs.length > 5) {
    const last = logs[logs.length - 1];
    console.log(`  …最后一条 playingTime=${last.playingTime} status=${last.status} ${last.body || ''}`);
  }
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
