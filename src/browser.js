'use strict';
/**
 * 浏览器管理。
 *
 * 设计要点（解决「开始答题前把用户浏览器关掉」的坑）：
 *  - 工具永远不 kill 任何浏览器进程；
 *  - 默认用独立的 user-data-dir 启动一个「工具专用」浏览器实例，和你平时用的浏览器互不干扰，
 *    所以不需要为了加调试端口而关掉你正在用的浏览器；
 *  - 如果配置的端口上已经有带调试口的浏览器（比如你自己启动的），直接复用，不再新开。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { httpJson } = require('./cdp');

const WIN_CANDIDATES = [
  '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
];
const MAC_CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_CANDIDATES = [
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
}

function findBrowser(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.XT_BROWSER && fs.existsSync(process.env.XT_BROWSER)) return process.env.XT_BROWSER;
  const list = process.platform === 'win32' ? WIN_CANDIDATES
    : process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
  for (const c of list) {
    const p = expand(c);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portAlive(port) {
  try {
    const v = await httpJson(port, '/json/version', 1500);
    return v && v.webSocketDebuggerUrl ? v : null;
  } catch (_) { return null; }
}

async function waitPort(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await portAlive(port);
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`浏览器调试端口 ${port} 在 ${timeoutMs / 1000}s 内没有就绪`);
}

/**
 * 确保有一个可用的浏览器。
 * @returns {{port:number, reused:boolean, exe:string|null, version:object}}
 */
async function ensureBrowser(cfg) {
  const port = Number(cfg.port || 9222);
  const alive = await portAlive(port);
  if (alive) return { port, reused: true, exe: null, version: alive };

  const exe = findBrowser(cfg.executablePath);
  if (!exe) {
    throw new Error(
      '没有找到 Edge/Chrome。请安装 Microsoft Edge 或 Google Chrome，' +
      '或在 config.json 里设置 browser.executablePath 指向浏览器可执行文件。'
    );
  }
  const profileDir = path.resolve(cfg.profileDir || path.join(os.homedir(), '.autoxxt', 'profile'));
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    cfg.headless ? '--headless=new' : '--start-maximized',
    'https://i.chaoxing.com/base',
  ];
  if (cfg.channel === 'msedge') args.unshift('--do-not-de-elevate');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const version = await waitPort(port);
  return { port, reused: false, exe, version, pid: child.pid };
}

module.exports = { ensureBrowser, findBrowser, portAlive, waitPort, sleep };
