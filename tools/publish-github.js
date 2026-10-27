#!/usr/bin/env node
'use strict';
/**
 * 用 GitHub REST API 发布本仓库（不需要安装 git）。
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx            （Windows）
 *   export GITHUB_TOKEN=ghp_xxx         （macOS/Linux）
 *   node tools/publish-github.js [仓库名] [--private]
 *
 * 也可以把 token 放在仓库根目录的 githubpat.txt（会被 .gitignore 忽略）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.profile']);
const SKIP_FILES = new Set(['config.json', 'githubpat.txt']);

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const f = path.join(ROOT, 'githubpat.txt');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  return '';
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else {
      if (SKIP_FILES.has(name)) continue;
      if (/\.(log|zip|png|jpg)$/i.test(name)) continue;
      out.push(rel);
    }
  }
  return out;
}

async function api(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'autoxxt-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.raw)) || res.statusText;
    throw new Error(`${method} ${url} -> ${res.status} ${msg}`);
  }
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const privateRepo = args.includes('--private');
  const name = args.find((a) => !a.startsWith('--')) || 'autoxxt';

  const token = readToken();
  if (!token) {
    console.error('缺少 GitHub token。请设置环境变量 GITHUB_TOKEN，或把 PAT 写进 githubpat.txt。');
    process.exit(2);
  }

  const me = await api(token, 'GET', '/user');
  console.log(`✓ 已认证：${me.login}`);

  let repo = null;
  try {
    repo = await api(token, 'GET', `/repos/${me.login}/${name}`);
    console.log(`✓ 仓库已存在：${repo.full_name}`);
  } catch (_) {
    repo = await api(token, 'POST', '/user/repos', {
      name,
      description: '学习通（超星）章节测验自动答题：零依赖、字体混淆破解、题库自学习 + LLM 兜底',
      private: privateRepo,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    });
    console.log(`✓ 已创建仓库：${repo.full_name}`);
  }

  const files = walk(ROOT);
  console.log(`· 待上传 ${files.length} 个文件`);

  // 用 Contents API 逐文件写入：空仓库也能直接 PUT（Git Data API 在空仓库上会返回
  // 409 "Git Repository is empty"），第一次 PUT 会自动创建默认分支。
  const branch = repo.default_branch && repo.size ? repo.default_branch : 'main';
  let done = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const body = {
      message: 'feat: 同步 ' + rel,
      content: buf.toString('base64'),
      branch,
    };
    try {
      await api(token, 'PUT', `/repos/${me.login}/${name}/contents/${encodeURI(rel)}`, body);
    } catch (e) {
      if (!/-> 422|-> 409/.test(e.message)) throw e;
      // 文件已存在：取 sha 后覆盖
      const cur = await api(token, 'GET', `/repos/${me.login}/${name}/contents/${encodeURI(rel)}?ref=${branch}`);
      body.sha = cur.sha;
      await api(token, 'PUT', `/repos/${me.login}/${name}/contents/${encodeURI(rel)}`, body);
    }
    done++;
    process.stdout.write('.');
  }
  console.log(`\n✓ 已写入 ${done} 个文件`);
  console.log(`\n✓ 发布完成：https://github.com/${me.login}/${name}`);
}

main().catch((e) => {
  console.error('× 发布失败：' + e.message);
  process.exit(1);
});
