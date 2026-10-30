#!/usr/bin/env node
'use strict';
/**
 * 在课程门户的任务中心里点开某个作业卡片的「去完成」，并报告新标签页的 dowork 地址。
 *
 *   node tools/click-go.js <作业名base64> [courseId]
 *
 * 用 base64 传中文名，绕开 Windows 命令行编码问题。
 */
const { CDP } = require('../src/cdp');

const port = Number(process.env.CDP_PORT || 9222);
const b64 = process.argv[2];
const courseFilter = process.argv[3] || '';
if (!b64) { console.error('用法：node tools/click-go.js <作业名base64> [courseId]'); process.exit(1); }
const needle = Buffer.from(b64, 'base64').toString('utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const expr = (needle) => `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const needle = ${JSON.stringify(needle)};
  const cands = [...document.querySelectorAll('div,li,section,a,button')]
    .filter((el) => clean(el.innerText).includes(needle) && clean(el.innerText).includes('去完成'));
  if (!cands.length) {
    const seen = [...new Set([...document.querySelectorAll('div,li,section')]
      .filter((el) => clean(el.innerText).includes('去完成'))
      .map((el) => clean(el.innerText).slice(0, 50)))];
    return { ok: false, error: 'card not found', needle, seen: seen.slice(0, 8) };
  }
  cands.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
  const card = cands[0];
  const all = [...card.querySelectorAll('*')].filter((el) => clean(el.textContent) === '去完成');
  const btn = all[all.length - 1];
  if (!btn) return { ok: false, error: 'no button', cardHtml: card.outerHTML.slice(0, 500) };
  btn.scrollIntoView({ block: 'center' });
  const o = { bubbles: true, cancelable: true, view: window };
  btn.dispatchEvent(new MouseEvent('mousedown', o));
  btn.dispatchEvent(new MouseEvent('mouseup', o));
  btn.click();
  return { ok: true, cardText: clean(card.innerText).slice(0, 100) };
})()`;

async function listPages() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
}

async function main() {
  const list = await listPages();
  const portal = list.find((t) => /studentCourse/.test(t.url) && (!courseFilter || t.url.includes(courseFilter)))
    || list.find((t) => /studentCourse/.test(t.url));
  if (!portal) throw new Error('找不到课程门户标签页');
  console.log(`门户：${portal.title} | ${portal.url.slice(0, 100)}`);

  const cdp = await CDP.connect(portal.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: portal.id, flatten: true });
  const r = await cdp.eval(sessionId, expr(needle));
  console.log(JSON.stringify(r));
  cdp.close();
  if (!r || !r.ok) process.exit(1);

  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const now = await listPages();
    const dowork = now.find((t) => /dowork/.test(t.url));
    if (dowork) {
      console.log('\n已打开作答页：');
      console.log(dowork.url);
      const m = /workId=(\d+)/.exec(dowork.url);
      console.log('workId=' + (m ? m[1] : '?'));
      return;
    }
  }
  console.log('\n! 没等到 dowork 标签页');
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
