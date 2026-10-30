#!/usr/bin/env node
'use strict';
/** 列出账号下所有课程及参数：node tools/courses.js [关键词] */
const path = require('path');
const { load } = require('../src/config');
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');

const ROOT = path.resolve(__dirname, '..');
const needle = process.argv[2] || '';

async function main() {
  const cfg = load(ROOT);
  const port = Number(process.env.CDP_PORT || 9222);
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = pages.find((t) => /chaoxing/.test(t.url)) || pages[0];
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const ctx = { cdp, sessionId, target };

  const courses = await X.listCourses(ctx, () => {});
  courses.forEach((c, i) => {
    const line = `${String(i + 1).padStart(2)}. ${c.name}  courseid=${c.courseid} clazzid=${c.clazzid} cpi=${c.cpi || ''} enc=${(c.enc || '').slice(0, 8)}`;
    if (!needle || (c.name || '').includes(needle)) console.log(line);
  });
  console.log(`\n共 ${courses.length} 门课程`);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
