'use strict';
/** 学习通页面导航与信息抓取。 */
const path = require('path');
const fs = require('fs');

const BASE = {
  home: 'https://i.chaoxing.com/base',
  courseList: 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata?courseType=1&courseFolderId=0&baseEducation=0&superstarClass=0',
  studentCourse: (p) => `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${p.courseid}&clazzid=${p.clazzid}&cpi=${p.cpi}&ut=s${p.enc ? '&enc=' + p.enc : ''}`,
};

const INJECT_DIR = path.join(__dirname, 'inject');

function injectSource(name) {
  return fs.readFileSync(path.join(INJECT_DIR, name + '.js'), 'utf8');
}

async function runInject(ctx, name, args) {
  const src = injectSource(name);
  const expr = `(${src.trim()})(${JSON.stringify(args || {})})`;
  return ctx.cdp.eval(ctx.sessionId, expr);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function currentUrl(ctx) {
  try { return await ctx.cdp.eval(ctx.sessionId, 'location.href'); } catch (_) { return ''; }
}

async function navigate(ctx, url, { waitMs = 3000 } = {}) {
  await ctx.cdp.navigate(ctx.sessionId, url);
  await sleep(waitMs);
  return currentUrl(ctx);
}

/** 轮询直到页面里出现某段文字/元素 */
async function waitForText(ctx, needle, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let text = '';
    try {
      text = await ctx.cdp.eval(ctx.sessionId, 'document.body ? document.body.innerText : ""');
    } catch (_) { /* 导航中会失败，忽略 */ }
    if (text && text.includes(needle)) return true;
    await sleep(700);
  }
  return false;
}

/** 打开课程列表页并返回课程数组 */
async function listCourses(ctx, log = () => {}) {
  log('打开「全部课程」…');
  await navigate(ctx, BASE.courseList, { waitMs: 4000 });
  await waitForText(ctx, '课程', 20000);
  const res = await runInject(ctx, 'courses');
  if (!res || !res.ok) throw new Error('解析课程列表失败：' + (res ? res.error : '空返回'));
  return res.courses;
}

/**
 * 打开某门课，进入「章节」目录页。
 * 学习通的章节页必须带 enc 参数，enc 只能靠课程门户跳转拿到，所以先走一次 stucoursemiddle。
 */
async function openCourse(ctx, course, log = () => {}) {
  const middle = `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${course.courseid}&clazzid=${course.clazzid}` +
    (course.cpi ? `&cpi=${course.cpi}` : '') + '&ismooc2=1&v=2';
  log(`进入课程《${course.name}》…`);
  let url = await navigate(ctx, middle, { waitMs: 5000 });
  // 等跳转稳定
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const u = await currentUrl(ctx);
    if (u && u === url && /mycourse/.test(u)) break;
    url = u;
  }
  const params = new URL(url).searchParams;
  const info = {
    courseid: params.get('courseid') || course.courseid,
    clazzid: params.get('clazzid') || course.clazzid,
    cpi: params.get('cpi') || course.cpi,
    enc: params.get('enc') || '',
  };
  log(`  课程参数：courseid=${info.courseid} clazzid=${info.clazzid} cpi=${info.cpi} enc=${info.enc ? info.enc.slice(0, 8) + '…' : '无'}`);
  return info;
}

/** 打开章节目录页，返回章节数据 */
async function listChapters(ctx, info, log = () => {}) {
  const url = BASE.studentCourse(info);
  await navigate(ctx, url, { waitMs: 5000 });
  await waitForText(ctx, '章节', 25000);
  let res = await runInject(ctx, 'chapters');
  if (!res || !res.ok || !res.items || !res.items.length) {
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      res = await runInject(ctx, 'chapters');
      if (res && res.ok && res.items && res.items.length) break;
    }
  }
  if (!res || !res.ok) throw new Error('解析章节失败：' + (res ? res.error : '空返回'));
  return res;
}

/** 在当前章节页点击某个章节（触发 toOld 跳转） */
async function openChapter(ctx, chapterId, timeoutMs = 45000) {
  const expr = `
    (() => {
      const el = document.querySelector('#cur${chapterId}');
      if (el) { el.click(); return 'element-click'; }
      if (typeof toOld === 'function') { toOld(${JSON.stringify(ctx.courseInfo.courseid)}, '${chapterId}', ${JSON.stringify(ctx.courseInfo.clazzid)}, 0); return 'toOld'; }
      return 'not-found';
    })()`;
  const how = await ctx.cdp.eval(ctx.sessionId, expr);
  if (how === 'not-found') throw new Error('章节页上找不到该章节：' + chapterId);
  // 等作业 iframe 起来
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const st = await runInject(ctx, 'quizstatus').catch(() => null);
    if (st && st.total > 0) return st;
  }
  return null;
}

module.exports = { BASE, runInject, navigate, currentUrl, sleep, waitForText, listCourses, openCourse, listChapters, openChapter };
