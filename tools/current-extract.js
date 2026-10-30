#!/usr/bin/env node
'use strict';
/**
 * 对「当前标签页」抽题：不管页面是怎么打开的（老师消息、作业列表、直达链接）。
 * 只读，不点作答、不提交。
 *
 * 用法：node tools/current-extract.js [--cdp 9222] [--out data/current-questions.json]
 */
const fs = require('fs');
const path = require('path');

const { load } = require('../src/config');
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');
const { getFontMap, status, ensureVisible, learnFromReview } = require('../src/flow');
const { decodeDeep } = require('../src/text');
const { KB } = require('../src/kb');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const TYPE_NAME = { single: '单选', multi: '多选', judge: '判断' };

function parseArgs(argv) {
  const out = { cdp: 9222, out: 'data/current-questions.json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--cdp') out.cdp = Number(argv[++i]);
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = load(ROOT);
  cfg.browser.port = args.cdp;
  const attached = await CDP.attachPage(args.cdp, 'chaoxing');
  const ctx = { cdp: attached.cdp, sessionId: attached.sessionId, target: attached.target };
  const kb = new KB(cfg.paths.kbFile, cfg.kb);

  await ensureVisible(ctx, log);
  const url = await X.currentUrl(ctx);
  const st = await status(ctx);
  log(`当前页面：${url}`);
  if (!st) { log('! 页面状态读不出来（quizstatus 空返回），可能不是作业页'); }
  else log(`状态：题目 ${st.total} 题，已填 ${st.filled}，${st.isReview ? '复核页' : '作答页'}，分数 ${st.score == null ? '无' : st.score}，状态 ${st.status || '未知'}`);

  if (st && st.isReview) {
    const review = await X.runInject(ctx, 'review');
    if (review && review.ok) {
      const n = learnFromReview(kb, review, log);
      kb.save(true);
      log(`· 这是复核页，已抄到正确答案 ${n} 题进题库（总分 ${review.score}）`);
      log('\n复核页题目：');
      review.questions.forEach((q, i) => {
        log(`  Q${i + 1}${q.correct ? ' ✓' : ' ✗'}【${q.typeLabel || ''}】${String(q.stem).split('\n')[0].slice(0, 60)}`);
        log(`      正确答案：${q.correctAnswer}${q.myAnswer ? `   我的作答：${q.myAnswer}` : ''}`);
      });
    }
    attached.cdp.close();
    return;
  }

  const ex = await X.runInject(ctx, 'extract');
  if (!ex || !ex.ok) {
    log(`! 抽题失败：${ex ? ex.error : '空返回'}`);
    log('  页面正文前 400 字：');
    const t = await attached.cdp.eval(attached.sessionId, 'document.body ? document.body.innerText.slice(0,400) : ""').catch(() => '');
    log(t);
    attached.cdp.close();
    return;
  }

  const sampleText = [
    ex.questions.map((q) => q.stem).join(''),
    ex.questions.map((q) => q.options.map((o) => o.text).join('')).join(''),
  ].join('');
  const font = await getFontMap(ctx, cfg, sampleText, log);
  const questions = decodeDeep(ex.questions, font.map);

  const payload = {
    url: ex.url,
    title: ex.title,
    header: ex.header,
    generated: new Date().toISOString(),
    count: questions.length,
    questions: questions.map((q) => ({
      index: q.index,
      qid: q.qid,
      type: q.type,
      typeLabel: q.typeLabel,
      stem: q.stem,
      options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
    })),
  };
  const outFile = path.join(ROOT, args.out);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');

  log(`\n抓到 ${questions.length} 题，已写入 ${outFile}\n`);
  questions.forEach((q) => {
    log(`Q${q.index}【${TYPE_NAME[q.type] || q.type}】${q.stem}`);
    q.options.forEach((o) => log(`     ${o.letter}. ${o.text}`));
  });
  attached.cdp.close();
}

main().catch((e) => { console.error('出错了：' + e.message); process.exit(1); });
