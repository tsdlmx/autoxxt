#!/usr/bin/env node
'use strict';
/**
 * 打开一个「独立」的带调试端口浏览器并停在登录页，用来登录另一个账号。
 * 与已有的 9222 实例完全隔离（不同 --user-data-dir、不同端口）。
 *
 *   node tools/open-login.js                       # 默认端口 9223、配置目录 .profile-b
 *   node tools/open-login.js --port 9224 --profile .profile-c
 *   node tools/open-login.js --port 9223 --url https://i.chaoxing.com/base
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findBrowser, portAlive, waitPort } = require('../src/browser');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { port: 9223, profile: '.profile-b', url: 'https://i.chaoxing.com/base', exe: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--exe') out.exe = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const alive = await portAlive(args.port);
  if (alive) {
    console.log(`端口 ${args.port} 上已经有调试浏览器在跑（复用，不新开）：`);
    console.log('  ' + (alive.Browser || 'unknown'));
    const list = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
    list.filter((t) => t.type === 'page').forEach((t, i) => console.log(`  ${i} | ${t.title} | ${t.url.slice(0, 100)}`));
    return;
  }

  const exe = args.exe || findBrowser(null);
  if (!exe) throw new Error('没找到 Edge/Chrome，可用 --exe 指定可执行文件');

  const profileDir = path.isAbsolute(args.profile) ? args.profile : path.join(ROOT, args.profile);
  fs.mkdirSync(profileDir, { recursive: true });
  console.log('浏览器：' + exe);
  console.log('独立配置目录：' + profileDir);

  const argv = [
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--start-maximized',
    args.url,
  ];
  const child = spawn(exe, argv, { detached: true, stdio: 'ignore' });
  child.unref();
  const v = await waitPort(args.port, 45000);
  console.log(`已启动，调试端口 ${args.port} 就绪（pid ${child.pid}）`);
  const list = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
  list.filter((t) => t.type === 'page').forEach((t, i) => console.log(`  ${i} | ${t.title} | ${t.url.slice(0, 100)}`));
}

main().catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
