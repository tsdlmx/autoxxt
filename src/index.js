#!/usr/bin/env node
'use strict';
/**
 * 学习通自动答题（章节测验/作业）
 *   node src/index.js               交互式：选课程 → 选测试 → 自动作答并提交
 *   node src/index.js --all         该课程所有未完成的测试全做
 *   node src/index.js --cdp 9222    复用你已经开着的调试浏览器
 */
const path = require('path');
const readline = require('readline');

const { load } = require('./config');
const { ensureBrowser } = require('./browser');
const { CDP } = require('./cdp');
const X = require('./chaoxing');
const { runWork, learnFromWork } = require('./flow');
const { KB } = require('./kb');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { all: false, force: false, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--cdp') out.port = Number(argv[++i]);
    else if (a === '--learn') out.learn = true;
    else if (a === '--course') out.course = argv[++i];
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--work') out.work = Number(argv[++i]);
    else if (a === '--llm-key') out.llmKey = argv[++i];
    else if (a === '--login') out.login = true;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  log(`
学习通自动答题

用法：
  node src/index.js                 交互式选择课程与测试
  node src/index.js --all           做完该课程所有未完成的测试
  node src/index.js --course 2      直接选第 2 门课
  node src/index.js --cdp 9222      复用已开的调试浏览器（不新开窗口）
  node src/index.js --dry           只作答不提交（人工核对用）
  node src/index.js --force         已完成的也重做
  node src/index.js --learn         只把已完成测验的正确答案抄进题库（不消耗次数）
  node src/index.js --login         只打开浏览器等你登录（登录状态会保存）
  node src/index.js --list          只列出课程与章节，不答题

配置：同目录 config.json（首次运行自动生成）。llm.apiKey 可选，不填就只用题库。
`);
}

async function ensureLogin(ctx) {
  await X.navigate(ctx, X.BASE.home, { waitMs: 4000 });
  let announced = false;
  for (let i = 0; i < 900; i++) {
    let u = '';
    let text = '';
    try {
      u = await ctx.cdp.eval(ctx.sessionId, 'location.href');
      text = await ctx.cdp.eval(ctx.sessionId, 'document.body ? document.body.innerText : ""');
    } catch (_) { /* 导航中 */ }
    const onPassport = /passport|login/i.test(u);
    const needsLogin = onPassport || /扫码登录|手机号登录|请先登录|登录后查看/.test(text);
    if (!needsLogin) {
      if (announced) log('✓ 已登录');
      return true;
    }
    if (!announced) {
      log('\n──────────────────────────────────────────────');
      log('需要登录：请在弹出的浏览器窗口里用手机号/扫码登录学习通。');
      log('登录信息会保存在工具自己的浏览器配置里，下次不用再登。');
      log('我在这里等你，登录好了会自动继续…');
      log('──────────────────────────────────────────────\n');
      announced = true;
    }
    await sleep(2000);
  }
  throw new Error('等待登录超时（30 分钟）');
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function pick(rl, label, items) {
  log(`\n${label}`);
  items.forEach((it, i) => log(`  ${String(i + 1).padStart(2)}. ${it.name}${it.done ? '  [已完成]' : ''}`));
  const ans = await ask(rl, `\n输入序号（回车=全部未完成，q=退出）：`);
  if (ans === 'q') return null;
  if (!ans) return items.filter((x) => !x.done);
  const idx = Number(ans) - 1;
  if (!(idx >= 0 && idx < items.length)) return items.filter((x) => !x.done);
  return [items[idx]];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const cfg = load(ROOT);
  if (args.port) cfg.browser.port = args.port;
  if (args.llmKey) cfg.llm.apiKey = args.llmKey;
  if (args.dry) cfg.quiz.autoSubmit = false;
  if (args.force) { cfg.quiz.force = true; cfg.quiz.skipDone = false; }
  if (!cfg.llm.apiKey) {
    log('! config.json 里还没填 llm.apiKey。');
    log('  题库里已有的题照样能做，没有的题会留空。');
    log(`  配置文件：${cfg.__file}`);
  }

  log('启动浏览器…');
  const b = await ensureBrowser(cfg.browser);
  log(b.reused ? `复用已有的调试实例（端口 ${b.port}）` : `已启动浏览器：${b.exe}（端口 ${b.port}）`);

  const attached = await CDP.attachPage(b.port, 'chaoxing');
  const ctx = { cdp: attached.cdp, sessionId: attached.sessionId, target: attached.target };

  await ensureLogin(ctx);

  if (args.login) {
    log('登录已完成，浏览器保持打开。之后可以直接运行 `node src/index.js` 开始答题。');
    return;
  }

  const courses = await X.listCourses(ctx, log);
  if (!courses.length) throw new Error('账号下没有找到课程');
  let course;
  if (args.course) {
    course = /^\d+$/.test(args.course) ? courses[Number(args.course) - 1] : courses.find((c) => c.name.includes(args.course));
  }
  if (!course) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log('\n课程列表：');
    courses.forEach((c, i) => log(`  ${String(i + 1).padStart(2)}. ${c.name}`));
    const ans = await ask(rl, '\n选择课程序号（回车=1）：');
    course = courses[(Number(ans) || 1) - 1];
    rl.close();
  }
  if (!course) throw new Error('没选到课程');

  const info = await X.openCourse(ctx, course, log);
  ctx.courseInfo = info;
  const ch = await X.listChapters(ctx, info, log);
  log(`\n章节 ${ch.total} 个，其中测试/作业 ${ch.works.length} 个` +
    (ch.taskPoints ? `，任务点 ${ch.taskPoints.done}/${ch.taskPoints.total}` : ''));

  let works = args.learn ? ch.works : ch.works.filter((w) => args.force || !w.done);

  if (args.list) {
    log('\n章节里的测试/作业：');
    ch.works.forEach((w, i) => log(`  ${String(i + 1).padStart(2)}. ${w.name}${w.done ? '  [已完成]' : ''}`));
    log('\n加 --all 或 --work <序号> 开始答题。');
    return;
  }

  if (!works.length) {
    log('这套课里没有未完成的测试了。加 --force 可以重做已完成的。');
    return;
  }
  if (!args.all && !args.learn && !args.max && !args.work) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const picked = await pick(rl, '未完成的测试：', works);
    rl.close();
    if (!picked) return;
    works = picked;
  }
  if (args.max) works = works.slice(0, args.max);
  if (args.work) works = works.slice(args.work - 1, args.work);

  const kb = new KB(cfg.paths.kbFile, cfg.kb);
  log(`题库：${kb.size} 条`);

  const results = [];
  for (const w of works) {
    try {
      const r = args.learn
        ? await learnFromWork(ctx, cfg, kb, w, log)
        : await runWork(ctx, cfg, kb, w, log);
      results.push({ name: w.name, ...r });
    } catch (e) {
      log(`  ! 这一套失败了：${e.message}`);
      results.push({ name: w.name, error: e.message });
    }
    // 每套做完回章节页，保证下一套的 toOld 能点到
    try {
      await X.navigate(ctx, X.BASE.studentCourse(info), { waitMs: 3500 });
    } catch (_) { /* ignore */ }
  }
  kb.save(true);

  log('\n──────────── 汇总 ────────────');
  let sum = 0; let cnt = 0;
  for (const r of results) {
    if (r.error) log(`${r.name}: 失败 — ${r.error}`);
    else if (r.skipped) log(`${r.name}: 已完成，跳过${r.score != null ? `（${r.score} 分）` : ''}`);
    else if (r.pending) log(`${r.name}: 已作答未提交（--dry）`);
    else {
      log(`${r.name}: ${r.score != null ? r.score + ' 分' : '未读到分数'}` +
        (r.correct != null ? `（对 ${r.correct}/${r.total}）` : '') +
        (r.hits ? `  [题库命中 ${r.hits.kb}+${r.hits.kbFuzzy}，LLM ${r.hits.llm}，未答 ${r.hits.none}]` : ''));
      if (r.score != null) { sum += r.score; cnt++; }
    }
  }
  if (cnt) log(`\n平均分：${(sum / cnt).toFixed(1)}（${cnt} 套）`);
  log(`题库累计：${kb.size} 条`);
  ctx.cdp.close();
}

main().catch((e) => {
  console.error('\n出错了：' + e.message);
  process.exit(1);
});
