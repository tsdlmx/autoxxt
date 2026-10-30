#!/usr/bin/env node
'use strict';
/** 汇总所有「作业成绩页」上记录的分数：node tools/scores.js [port] */
const { CDP } = require('../src/cdp');

const port = Number(process.argv[2] || 9222);

async function main() {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /work\/(prompt|view)/.test(t.url || ''));
  for (const p of pages) {
    const cdp = await CDP.connect(p.webSocketDebuggerUrl);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: p.id, flatten: true });
    const info = await cdp.eval(sessionId, `(() => {
      const t = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
      const m = /(\\d+(?:\\.\\d+)?)\\s*分/.exec(t);
      const redo = /已重做\\s*(\\d+)\\s*次/.exec(t);
      return { score: m ? m[1] : '?', redo: redo ? redo[1] : '?', url: location.href };
    })()`).catch(() => null);
    const workId = (/workId=(\d+)/.exec(p.url) || [])[1] || '?';
    if (info) console.log(`workId=${workId}  ${info.score}分  (已重做 ${info.redo} 次)`);
    cdp.close();
  }
}

main().catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
