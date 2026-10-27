#!/usr/bin/env node
'use strict';
/** 调试工具：对当前页面执行 src/inject/<name>.js，打印返回的 JSON。
 *  用法：node tools/run-inject.js 9222 quizstatus
 */
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');

(async () => {
  const port = Number(process.argv[2] || 9222);
  const name = process.argv[3];
  const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  if (!name) { console.error('用法：node tools/run-inject.js <port> <injectName> [jsonArgs]'); process.exit(1); }
  const a = await CDP.attachPage(port, 'chaoxing');
  const ctx = { cdp: a.cdp, sessionId: a.sessionId, target: a.target };
  const r = await X.runInject(ctx, name, args);
  console.log(JSON.stringify(r, null, 1));
  try { a.cdp.close(); } catch (_) { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
