#!/usr/bin/env node
'use strict';
/**
 * 只读抓题：遍历指定课程第 from~to 章的测验/作业，抽出题干与真实选项字母并解码混淆字体。
 * 不点作答、不提交、不消耗重做次数。
 *
 * 用法：
 *   node tools/dump-chapters.js --course "大学生国家安全教育" --from 1 --to 8
 * 产物：
 *   data/questions.json   每套作业的题目（已解字体）
 *   data/review-seed.json 顺手从已完成测验的复核页抄到的正确答案
 */
const fs = require('fs');
const path = require('path');

const { load } = require('../src/config');
const { ensureBrowser } = require('../src/browser');
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');
const { getFontMap, learnFromReview, status, ensureVisible } = require('../src/flow');
const { decodeDeep } = require('../src/text');
const { KB } = require('../src/kb');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

function parseArgs(argv) {
  const out = { from: 1, to: 8, cdp: null, course: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cdp') out.cdp = Number(argv[++i]);
    else if (a === '--course') out.course = argv[++i];
    else if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i];
  }
  return out;
}

/** 从 works 里挑出第 from~to 章，排除期末/考试类 */
function pickWorks(works, from, to) {
  const EXCLUDE = /期末|考试|补考|模拟考|随堂练习/;
  const picked = [];
  let seq = 0;
  for (const w of works) {
    seq++;
    if (EXCLUDE.test(w.name || '')) continue;
    // 章节号可能来自 no（"3.2"）或名称（"第3章"）
    let ch = null;
    const m1 = /^\s*(\d+)(?:[.\-]\d+)*\s*$/.exec(w.no || '');
    if (m1) ch = Number(m1[1]);
    if (ch == null) {
      const m2 = /第\s*(\d+)\s*章/.exec(w.name || '');
      if (m2) ch = Number(m2[1]);
    }
    if (ch == null) ch = seq; // 兜底：按出现顺序
    if (ch >= from && ch <= to) picked.push({ ...w, chapterNo: ch });
  }
  return picked;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = load(ROOT);
  if (args.cdp) cfg.browser.port = args.cdp;

  const b = await ensureBrowser(cfg.browser);
  log(b.reused ? `复用浏览器（端口 ${b.port}）` : `已启动浏览器（端口 ${b.port}）`);
  const attached = await CDP.attachPage(b.port, 'chaoxing');
  const ctx = { cdp: attached.cdp, sessionId: attached.sessionId, target: attached.target };

  const kb = new KB(cfg.paths.kbFile, cfg.kb);

  const courses = await X.listCourses(ctx, log);
  log(`\n课程 ${courses.length} 门`);
  if (!courses.length) throw new Error('没读到课程列表（可能没登录）');
  let course;
  if (args.course) course = courses.find((c) => (c.name || '').includes(args.course));
  if (!course) {
    courses.forEach((c, i) => log(`  ${i + 1}. ${c.name}`));
    throw new Error(`没找到课程「${args.course}」，请从上面列表里挑`);
  }
  log(`\n目标课程：《${course.name}》`);

  const info = await X.openCourse(ctx, course, log);
  ctx.courseInfo = info;
  const ch = await X.listChapters(ctx, info, log);
  log(`章节 ${ch.total} 个，测验/作业 ${ch.works.length} 个`);
  log('\n全部 works：');
  ch.works.forEach((w, i) => log(`  ${String(i + 1).padStart(2)}. no=${String(w.no || '').padEnd(6)} done=${w.done ? 'Y' : 'N'}  ${w.name}`));

  const works = pickWorks(ch.works, args.from, args.to);
  log(`\n选中第 ${args.from}~${args.to} 章共 ${works.length} 套：`);
  works.forEach((w) => log(`  · [第${w.chapterNo}章] ${w.name}${w.done ? '  [已完成]' : ''}`));

  const out = [];
  const harvested = [];
  for (const w of works) {
    log(`\n──── 抓取：${w.name}（chapterId=${w.chapterId}）────`);
    try {
      // 每次都从章节页进入，保证 toOld 可点
      await X.navigate(ctx, X.BASE.studentCourse(info), { waitMs: 3500 });
      const started = await X.openChapter(ctx, w.chapterId);
      await ensureVisible(ctx, log);
      let st = started || (await status(ctx));
      if (!st) { log('  ! 作业页没起来，跳过'); out.push({ work: w, error: 'page-not-loaded' }); continue; }
      if (st.isReview) {
        const review = await X.runInject(ctx, 'review');
        if (review && review.ok) {
          const n = learnFromReview(kb, review, log);
          harvested.push({ name: w.name, score: review.score, learned: n });
          log(`  · 已在复核页，抄到正确答案 ${n} 题（总分 ${review.score}）`);
        }
        out.push({ work: w, alreadyDone: true, score: review && review.score });
        continue;
      }
      log(`  · 题目 ${st.total} 题，已填 ${st.filled}，状态 ${st.status || '未知'}`);
      if (!st.total) { log('  ! 抽不到题，跳过'); out.push({ work: w, error: 'no-questions' }); continue; }

      const ex = await X.runInject(ctx, 'extract');
      if (!ex || !ex.ok) { log(`  ! 抽题失败：${ex && ex.error}`); out.push({ work: w, error: ex && ex.error }); continue; }
      const sampleText = [
        ex.questions.map((q) => q.stem).join(''),
        ex.questions.map((q) => q.options.map((o) => o.text).join('')).join(''),
      ].join('');
      const font = await getFontMap(ctx, cfg, sampleText, log);
      const questions = decodeDeep(ex.questions, font.map);
      out.push({
        work: { no: w.no, name: w.name, chapterId: w.chapterId, chapterNo: w.chapterNo, done: !!w.done },
        url: ex.url,
        count: questions.length,
        questions: questions.map((q) => ({
          index: q.index,
          qid: q.qid,
          type: q.type,
          typeLabel: q.typeLabel,
          stem: q.stem,
          options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
        })),
      });
      log(`  ✓ 抓到 ${questions.length} 题`);
    } catch (e) {
      log(`  ! 出错：${e.message}`);
      out.push({ work: w, error: e.message });
    }
  }

  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const qFile = path.join(dataDir, 'questions.json');
  fs.writeFileSync(qFile, JSON.stringify({ course: course.name, generated: new Date().toISOString(), works: out }, null, 1), 'utf8');
  kb.save(true);
  log(`\n题目已写入：${qFile}`);
  log(`题库：${kb.size} 条（其中复核页抄来 ${harvested.reduce((s, x) => s + x.learned, 0)} 题）`);
  const totalQ = out.reduce((s, x) => s + (x.count || 0), 0);
  log(`合计抓到 ${totalQ} 题，覆盖 ${out.filter((x) => x.count).length} 套作业`);
  ctx.cdp.close();
}

main().catch((e) => {
  console.error('\n出错了：' + e.message);
  process.exit(1);
});
