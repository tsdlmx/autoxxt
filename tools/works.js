#!/usr/bin/env node
'use strict';
/**
 * 列出各章节里的 work（章节测验）iframe 地址。
 *   node tools/works.js --port 9223 --course 265989605 --clazz 152310312 --cpi 493630375 \
 *        --enc 74c2... --chapters 1216968335,...
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

const LIST = `(() => {
  const out = [];
  [...document.querySelectorAll('iframe')].forEach((f) => {
    const src = f.src || '';
    const m = /\\/ananas\\/modules\\/([a-z]+)\\//.exec(src);
    const kind = m ? m[1] : 'other';
    const rec = { kind, src };
    if (kind === 'work') {
      // work 模块里还套一层真正的作答页
      let inner = null;
      try {
        const d = f.contentDocument;
        if (d) {
          const g = d.querySelector('iframe');
          if (g && g.src) inner = g.src;
        }
      } catch (e) { rec.innerErr = e.message; }
      rec.innerUrl = inner;
      const real = inner || src;
      try {
        const q = new URL(real).searchParams;
        rec.workId = q.get('workId');
        rec.workAnswerId = q.get('workAnswerId');
        rec.knowledgeid = q.get('knowledgeid');
        rec.classId = q.get('classId');
      } catch (e) {}
    }
    out.push(rec);
  });
  const title = (document.querySelector('h1, .chapter_title, .prev_title') || {}).innerText || document.title;
  return { title: String(title).replace(/\\s+/g, ' ').slice(0, 60), modules: out };
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const chapters = String(args.chapters || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /knowledge\/cards/.test(t.url)) || pages[0]);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});

  const all = [];
  for (const kid of chapters) {
    const url = `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${args.clazz}&courseid=${args.course}` +
      `&knowledgeid=${kid}&num=0&ut=s&cpi=${args.cpi}&v=2025-0424-1038-3&mooc2=1&enc=${args.enc}`;
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(4200);
    const r = await cdp.eval(sessionId, LIST).catch(() => null);
    if (!r) { console.log(kid + ' -> 读取失败'); continue; }
    const works = r.modules.filter((m) => m.kind === 'work');
    const counts = r.modules.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {});
    console.log(`\n[${kid}] ${r.title}`);
    console.log('  模块：' + Object.entries(counts).map(([k, v]) => k + '×' + v).join(' '));
    works.forEach((w) => {
      console.log('  work: workId=' + w.workId + ' answerId=' + w.workAnswerId);
      all.push({ chapterId: kid, title: r.title, workUrl: w.src, innerUrl: w.innerUrl || null, workId: w.workId });
    });
    if (!works.length) console.log('  （本章无测验）');
  }

  const fs = require('fs');
  const path = require('path');
  const f = path.resolve(__dirname, '..', 'data', 'works.json');
  fs.writeFileSync(f, JSON.stringify(all, null, 1), 'utf8');
  console.log('\n共 ' + all.length + ' 个测验，已写入 ' + f);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
