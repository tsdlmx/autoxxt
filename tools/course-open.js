#!/usr/bin/env node
'use strict';
/**
 * 打开某门课程的新版门户（fanyav3），自动补全 enc，并打印任务中心概览。
 *   node tools/course-open.js <courseId> <classId> <cpi> [tabIndex]
 */
const { CDP } = require('../src/cdp');

const port = Number(process.env.CDP_PORT || 9222);
const [courseId, classId, cpi] = [process.argv[2], process.argv[3], process.argv[4]];
const tabArg = process.argv[5];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
}

async function main() {
  if (!courseId || !classId) throw new Error('用法：node tools/course-open.js <courseId> <classId> <cpi> [tab]');
  const list = await pages();
  const target = tabArg != null ? list[Number(tabArg)] : (list.find((t) => /提示/.test(t.title)) || list[0]);
  if (!target) throw new Error('没有可用标签页');
  console.log(`使用标签页：${target.title} | ${target.url.slice(0, 80)}`);

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});

  const middle = `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}` +
    (cpi ? `&cpi=${cpi}` : '') + '&ismooc2=1&v=2';
  await cdp.send('Page.navigate', { url: middle }, sessionId);
  await sleep(6000);

  let url = '';
  for (let i = 0; i < 12; i++) {
    url = await cdp.eval(sessionId, 'location.href').catch(() => '');
    if (/mycourse|studentCourse/.test(url)) break;
    await sleep(1500);
  }
  console.log('中间页：' + url.slice(0, 140));
  const q = new URL(url).searchParams;
  const enc = q.get('enc') || '';
  const realCourse = q.get('courseid') || courseId;
  const realClass = q.get('clazzid') || classId;
  const realCpi = q.get('cpi') || cpi || '';
  console.log(`enc=${enc ? enc.slice(0, 10) + '…' : '无'} courseid=${realCourse} clazzid=${realClass} cpi=${realCpi}`);

  const v3 = `https://mooc2-ans.chaoxing.com/mooc2-ans-vue/fanyav3/studentCourse?courseId=${realCourse}` +
    `&clazzId=${realClass}&cpi=${realCpi}${enc ? '&enc=' + enc : ''}&v=6&ut=s`;
  await cdp.send('Page.navigate', { url: v3 }, sessionId);
  await sleep(7000);

  const text = await cdp.eval(sessionId, 'document.body ? document.body.innerText.replace(/\\s+/g, " ") : ""').catch(() => '');
  console.log('\n门户：' + (await cdp.eval(sessionId, 'location.href').catch(() => '')));
  console.log('正文：' + text.slice(0, 900));
  cdp.close();
  console.log('\nV3URL=' + v3);
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
