#!/usr/bin/env node
'use strict';
/**
 * 对「当前作答页」回填答案、逐题校验；(可选) 交卷并从复核页学习。
 *
 * 用法：
 *   node tools/current-solve.js --answers data/current-answers.json          # 只作答 + 校验
 *   node tools/current-solve.js --answers data/current-answers.json --submit # 作答后交卷
 *
 * 答案文件格式（题号 → 真实字母；判断题用 true/false）：
 *   { "1": ["B"], "2": ["A","C","D"], "3": ["true"] }
 * 也接受 { "answers": { ... } } 包装。
 */
const fs = require('fs');
const path = require('path');

const { load } = require('../src/config');
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');
const { status, ensureVisible, submitPaper, learnFromReview } = require('../src/flow');
const { KB } = require('../src/kb');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

function parseArgs(argv) {
  const out = { cdp: 9222, answers: null, submit: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--cdp') out.cdp = Number(argv[++i]);
    else if (argv[i] === '--answers') out.answers = argv[++i];
    else if (argv[i] === '--submit') out.submit = true;
  }
  return out;
}

function parseVerified(str) {
  const map = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const no = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    let letters = [];
    if (val) {
      if (/^(true|false)$/i.test(val)) letters = [val.toLowerCase()];
      else if (/^[A-Za-z]+$/.test(val)) letters = val.split('');
      else letters = val.split(/[,，、\s]+/).filter(Boolean);
    }
    map[Number(no)] = letters;
  }
  return map;
}

const sameSet = (a, b) => {
  if (!a || !b) return false;
  return [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');
};

async function main() {
  const args = parseArgs(process.argv);
  if (!args.answers) throw new Error('缺少 --answers <文件>');
  const file = path.isAbsolute(args.answers) ? args.answers : path.join(ROOT, args.answers);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const answers = raw.answers || raw;
  // 统一成数组 + 大写（判断题保持小写 true/false）
  const norm = {};
  for (const [k, v] of Object.entries(answers)) {
    const arr = Array.isArray(v) ? v : String(v).split(/[\s,，、]+/).filter(Boolean);
    norm[Number(k)] = arr.map((x) => {
      const s = String(x).trim();
      if (/^(true|false)$/i.test(s)) return s.toLowerCase();
      return s.toUpperCase();
    }).filter(Boolean);
  }
  log(`载入答案 ${Object.keys(norm).length} 题：${file}`);

  const cfg = load(ROOT);
  cfg.browser.port = args.cdp;
  const attached = await CDP.attachPage(args.cdp, 'chaoxing');
  const ctx = { cdp: attached.cdp, sessionId: attached.sessionId, target: attached.target };
  const kb = new KB(cfg.paths.kbFile, cfg.kb);

  await ensureVisible(ctx, log);
  let st = await status(ctx);
  if (!st) throw new Error('读不到作业页状态，确认当前标签页是作答页');
  log(`作答页：题目 ${st.total} 题，已填 ${st.filled}，状态 ${st.status || '未知'}`);
  if (st.isReview) throw new Error('当前是复核页，不是作答页');

  const applied = await X.runInject(ctx, 'answer', { answers: norm });
  if (!applied || !applied.ok) throw new Error('作答失败：' + (applied ? applied.error : '空返回'));
  const got = parseVerified(applied.verified);

  const nos = Object.keys(norm).map(Number).sort((a, b) => a - b);
  let mismatch = 0;
  for (const no of nos) {
    const want = norm[no].slice().sort();
    const have = (got[no] || []).slice().sort();
    if (!have.length || !sameSet(want, have)) {
      mismatch++;
      log(`  ! Q${no} want=[${want}] have=[${have}]`);
    }
  }
  log(mismatch ? `\n! ${mismatch} 题校验不一致` : `\n✓ ${nos.length} 题全部作答并校验通过`);

  st = await status(ctx);
  log(`页面回读：题目 ${st.total}，已填 ${st.filled}`);

  if (!args.submit) {
    log('\n未提交（加 --submit 才交卷）。');
    attached.cdp.close();
    return;
  }

  log('\n开始交卷…');
  const ok = await submitPaper(ctx, log);
  if (!ok) { log('! 提交没成功'); attached.cdp.close(); process.exit(1); }
  st = await status(ctx);
  log(`结果：${st && st.score != null ? st.score + ' 分' : '未读到分数'} / ${st && st.status ? st.status : ''}`);

  const review = await X.runInject(ctx, 'review');
  if (review && review.ok) {
    const correct = review.questions.filter((q) => q.correct).length;
    log(`对 ${correct}/${review.questions.length}`);
    const n = learnFromReview(kb, review, log);
    kb.save(true);
    log(`题库：${kb.size} 条（本次学到 ${n} 题）`);
  }
  attached.cdp.close();
}

main().catch((e) => { console.error('出错了：' + e.message); process.exit(1); });
