#!/usr/bin/env node
'use strict';
/** 列出浏览器所有标签页：node tools/tabs.js [port] */
const port = Number(process.argv[2] || 9222);
fetch(`http://127.0.0.1:${port}/json/list`)
  .then((r) => r.json())
  .then((l) => {
    const pages = l.filter((t) => t.type === 'page');
    pages.forEach((t, i) => console.log(`${i} | ${t.title} | ${t.url}`));
    console.log(`\n共 ${pages.length} 个标签页`);
  })
  .catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
