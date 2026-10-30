#!/usr/bin/env node
'use strict';
/**
 * 统计某课程各章节视频任务点的总时长。
 *   node tools/venum.js --port 9223 --course 265989605 --clazz 152310312 --cpi 493630375 \
 *        --enc 74c2d1c7f370f0df39edbfae7fbbf724 --chapters 1216968335,1216968336,...
 */
const { CDP } = require('../src/cdp');

function parseArgs(argv) {
  const out = { port: 9223, course: '', clazz: '', cpi: '', enc: '', chapters: '', tab: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--course') out.course = argv[++i];
    else if (a === '--clazz') out.clazz = argv[++i];
    else if (a === '--cpi') out.cpi = argv[++i];
    else if (a === '--enc') out.enc = argv[++i];
    else if (a === '--chapters') out.chapters = argv[++i];
    else if (a === '--tab') out.tab = Number(argv[++i]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOAD_ALL = `(async () => {
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /modules\\/video/.test(f.src || ''));
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    let d = null;
    try { d = frames[i].contentDocument; } catch (e) { out.push({ i, error: 'cross' }); continue; }
    const v = d.querySelector('video');
    if (!v) { out.push({ i, error: 'no video' }); continue; }
    v.preload = 'auto';
    if (v.readyState < 1) {
      try { v.load(); } catch (e) {}
      await new Promise((res) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if ((v.readyState >= 1 && isFinite(v.duration) && v.duration > 0) || Date.now() - t0 > 8000) { clearInterval(iv); res(); }
        }, 250);
      });
    }
    out.push({ i, duration: Math.round(v.duration || 0) });
  }
  return out;
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const chapters = String(args.chapters || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chapters.length) throw new Error('需要 --chapters');

  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});

  let total = 0;
  let totalVideos = 0;
  const rows = [];
  for (const kid of chapters) {
    const url = `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${args.clazz}&courseid=${args.course}` +
      `&knowledgeid=${kid}&num=0&ut=s&cpi=${args.cpi}&v=2025-0424-1038-3&mooc2=1&enc=${args.enc}`;
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(4500);
    const res = await cdp.eval(sessionId, LOAD_ALL, { timeout: 120000 }).catch(() => []);
    const vids = (res || []).filter((r) => r.duration > 0);
    const sum = vids.reduce((s, r) => s + r.duration, 0);
    total += sum;
    totalVideos += vids.length;
    rows.push({ kid, videos: vids.length, sum });
    console.log(`  chapter ${kid}: ${vids.length} 个视频, ${(sum / 60).toFixed(1)} 分钟`);
  }
  console.log(`\n合计 ${totalVideos} 个视频，${(total / 60).toFixed(1)} 分钟 (${(total / 3600).toFixed(2)} 小时)`);
  console.log(`1x 需要 ${(total / 3600).toFixed(1)}h，2x 约 ${(total / 7200).toFixed(1)}h，3x 约 ${(total / 10800).toFixed(1)}h，4x 约 ${(total / 14400).toFixed(1)}h`);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
