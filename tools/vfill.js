#!/usr/bin/env node
'use strict';
/**
 * 学习通网页版视频任务点进度补报。
 *
 * 播放器每次上报进度就是一个明文 GET：
 *   /mooc-ans/multimedia/log/a/<cpi>/<token>?clazzId=..&playingTime=<秒>&duration=<总秒>
 *     &clipTime=0_<总秒>&objectId=<objectId>&otherInfo=nodeId_..-cpi_..-..
 * 本工具先让每个视频短暂播放一次，采集该 objectId 的真实上报 URL，再按 step 秒递增重放。
 *
 *   node tools/vfill.js --port 9223 --dry      # 只采集，打印每个视频的时长
 *   node tools/vfill.js --port 9223 --probe    # 采集后发一个单请求，打印原始响应
 *   node tools/vfill.js --port 9223            # 采集并补报
 */
const fs = require('fs');
const path = require('path');
const { CDP } = require('../src/cdp');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { port: 9223, step: 45, delay: 700, dry: false, probe: false, ratio: 0.96, tab: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--step') out.step = Number(argv[++i]);
    else if (a === '--delay') out.delay = Number(argv[++i]);
    else if (a === '--ratio') out.ratio = Number(argv[++i]);
    else if (a === '--tab') out.tab = Number(argv[++i]);
    else if (a === '--dry') out.dry = true;
    else if (a === '--probe') out.probe = true;
  }
  return out;
}

const POKE = `(async () => {
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /modules\\/video/.test(f.src || ''));
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    let d = null;
    try { d = frames[i].contentDocument; } catch (e) { out.push({ i, error: 'cross' }); continue; }
    const v = d.querySelector('video');
    if (!v) { out.push({ i, error: 'no video' }); continue; }
    try {
      v.muted = true;
      v.preload = 'auto';
      if (v.readyState < 1) { v.load(); await new Promise((r) => setTimeout(r, 1500)); }
      await v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 2200));
      v.pause();
      out.push({ i, duration: Math.round(v.duration || 0), ok: true });
    } catch (e) { out.push({ i, error: e.message }); }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
})()`;

const FILL = (plan, step, delay) => `(async () => {
  const plan = ${JSON.stringify(plan)};
  const step = ${step};
  const delay = ${delay};
  const results = [];
  for (const item of plan) {
    const target = Math.floor(item.duration * item.ratio);
    let last = null;
    let passed = null;
    for (let t = step; t <= target + step; t += step) {
      const playing = Math.min(t, target);
      const url = item.url.replace(/([?&])playingTime=\\d+/, '$1playingTime=' + playing);
      try {
        const res = await fetch(url, { credentials: 'include' });
        const txt = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) {}
        last = {
          playing,
          status: res.status,
          isJson: !!parsed,
          body: parsed ? JSON.stringify(parsed).slice(0, 160) : txt.replace(/\\s+/g, ' ').slice(0, 160)
        };
        if (parsed && parsed.isPassed) { passed = true; break; }
      } catch (e) {
        last = { playing, error: e.message };
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    results.push({ objectId: item.objectId, duration: item.duration, lastReport: last, isPassed: passed });
  }
  return results;
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  if (!target) throw new Error('没有可用标签页');
  log('标签：' + target.title + ' | ' + target.url.slice(0, 110));

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});

  const byObject = new Map();
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (!/multimedia\/log/i.test(u)) return;
    const m = /[?&]objectId=([0-9a-f]+)/i.exec(u);
    if (m && !byObject.has(m[1])) byObject.set(m[1], u);
  });

  log('先让每个视频短暂播放一次，采集上报 URL…');
  const poked = await cdp.eval(sessionId, POKE).catch((e) => [{ error: e.message }]);
  log('播放结果：' + JSON.stringify(poked));
  await sleep(1500);

  const plan = [];
  for (const [objectId, url] of byObject) {
    const dm = /[?&]duration=(\d+)/.exec(url);
    plan.push({ objectId, url, duration: dm ? Number(dm[1]) : 0, ratio: args.ratio });
  }
  log('\n采集到 ' + plan.length + ' 个视频任务点：');
  plan.forEach((p) => log('  objectId=' + p.objectId + ' duration=' + p.duration + 's (' + (p.duration / 60).toFixed(1) + 'min)'));

  if (!plan.length) { log('! 没采集到上报 URL，页面可能不是章节详情页'); cdp.close(); return; }

  if (args.probe) {
    const one = plan[0];
    const test = await cdp.eval(sessionId, `(async () => {
      const base = ${JSON.stringify(one.url)};
      const variants = [
        { name: 'original', url: base },
        { name: 'playingTime=1', url: base.replace(/([?&])playingTime=\\d+/, '$1playingTime=1') },
        { name: 'playingTime=5', url: base.replace(/([?&])playingTime=\\d+/, '$1playingTime=5') },
        { name: 'playingTime=45', url: base.replace(/([?&])playingTime=\\d+/, '$1playingTime=45') },
      ];
      const out = [];
      for (const v of variants) {
        try {
          const res = await fetch(v.url, { credentials: 'include' });
          const txt = await res.text();
          let json = null;
          try { json = JSON.parse(txt); } catch (e) {}
          const t = /<title>([^<]*)<\\/title>/i.exec(txt);
          out.push({ name: v.name, status: res.status, json, title: t ? t[1] : null, head: json ? null : txt.replace(/\\s+/g, ' ').slice(0, 160) });
        } catch (e) {
          out.push({ name: v.name, error: e.message });
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      return out;
    })()`);
    log('\n多变量探针结果：');
    (test || []).forEach((t) => log('  ' + t.name + ' -> ' + t.status + ' ' + (t.json ? JSON.stringify(t.json) : (t.error || t.head))));
    cdp.close();
    return;
  }

  if (args.dry) { log('\n--dry：只采集不补报'); cdp.close(); return; }

  log('\n开始补报（step=' + args.step + 's, delay=' + args.delay + 'ms）…');
  const res = await cdp.eval(sessionId, FILL(plan, args.step, args.delay), { timeout: 1800000 });
  log('\n结果：');
  (res || []).forEach((r) => {
    log('  ' + r.objectId + '  ' + r.duration + 's  isPassed=' + r.isPassed);
    if (r.lastReport) log('      最后上报：playingTime=' + r.lastReport.playing + ' status=' + r.lastReport.status + ' ' + (r.lastReport.error || r.lastReport.body || ''));
  });

  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'video-report-last.json'), JSON.stringify({ url: target.url, res }, null, 1), 'utf8');
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
