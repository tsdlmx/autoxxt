'use strict';
/** 配置读写。首次运行自动生成 config.json。 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  browser: {
    // null = 自动探测 Edge/Chrome
    executablePath: null,
    port: 9222,
    // 工具专用浏览器配置目录（不影响你平时用的浏览器）
    profileDir: null,
    headless: false,
  },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0,
    batch: 10,
  },
  quiz: {
    autoSubmit: true,
    force: false,          // true = 已完成的也重做
    skipDone: true,
    minScoreToLearn: 0,    // 复核页答案总是学，这个值留作以后按分数过滤
    maxRetryPerWork: 1,
  },
  kb: {
    fuzzyMin: 0.82,
    optMin: 0.86,
  },
  paths: {
    kbFile: null,          // 默认 data/kb.json
    fontMapDir: null,      // 默认 data/fontmaps
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  if (typeof extra !== 'object' || extra === null) return base;
  const out = { ...base };
  for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
  return out;
}

function load(rootDir) {
  const file = path.join(rootDir, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error('config.json 不是合法 JSON：' + e.message);
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(rootDir, 'config.example.json'),
      JSON.stringify(DEFAULTS, null, 2),
      'utf8'
    );
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.__file = file;
  cfg.__root = rootDir;
  if (!cfg.paths.kbFile) cfg.paths.kbFile = path.join(rootDir, 'data', 'kb.json');
  if (!cfg.paths.fontMapDir) cfg.paths.fontMapDir = path.join(rootDir, 'data', 'fontmaps');
  if (!cfg.browser.profileDir) cfg.browser.profileDir = path.join(rootDir, '.profile');
  return cfg;
}

module.exports = { load, DEFAULTS };
