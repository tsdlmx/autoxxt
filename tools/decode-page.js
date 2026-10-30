#!/usr/bin/env node
'use strict';
/** 调试：抽题 + 破字体 + 解码，打印前 N 题，用于人工核对解码质量。
 *  用法：node tools/decode-page.js [port] [n]
 */
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');
const { decodeDeep } = require('../src/text');

(async () => {
  const port = Number(process.argv[2] || 9222);
  const n = Number(process.argv[3] || 5);
  const a = await CDP.attachPage(port, 'chaoxing');
  const ctx = { cdp: a.cdp, sessionId: a.sessionId, target: a.target };
  const t0 = Date.now();
  const ex = await X.runInject(ctx, 'extract');
  if (!ex || !ex.ok) { console.log('extract 失败', JSON.stringify(ex)); process.exit(1); }
  console.log(`题目 ${ex.questions.length} 道（${Date.now() - t0}ms）`);
  const sample = ex.questions.map((q) => q.stem + q.options.map((o) => o.text).join('')).join('');
  const f = await X.runInject(ctx, 'font', { sampleText: sample });
  if (!f || !f.ok) { console.log('font 失败', JSON.stringify(f && f.error)); }
  else console.log(`字体 ${f.count} 字 hash=${f.hash} avgSim=${f.avgSim} minSim=${f.minSim} 用时 ${Date.now() - t0}ms`);
  const qs = decodeDeep(ex.questions, f && f.ok ? f.map : null);
  for (const q of qs.slice(0, n)) {
    console.log(`\nQ${q.index}【${q.type}】${q.stem}`);
    for (const o of q.options) console.log(`   ${o.letter}. ${o.text}`);
  }
  try { a.cdp.close(); } catch (_) { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
