#!/usr/bin/env node
'use strict';
/**
 * 把复核页数据（fanya.js view 的产物）转成可直接 used 的答案文件。
 *   node tools/learn.js data/m02-view.json data/m02-answers-v2.json
 *
 * 规则：
 *   填空题  取 correctAnswers 数组，去掉 "(1) " 前缀；同一空有多种写法时按 ； 取第一个
 *   判断题  "对" → true, "错" → false
 *   选择题  "ACD" → ["A","C","D"]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) { console.error('用法：node tools/learn.js <view.json> <answers.json>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.join(ROOT, src), 'utf8'));
const out = { _note: '由复核页正确答案自动生成：' + src };
const warnings = [];

for (const q of data.questions) {
  const no = String(q.index);
  const caList = (q.correctAnswers && q.correctAnswers.length ? q.correctAnswers : [q.correctAnswer]).filter(Boolean);
  const isParenBlank = caList.some((s) => /^\(\d+\)/.test(String(s).trim()));
  const isBlank = /填空/.test(q.typename || '') || (q.blankCount || 0) > 0 || isParenBlank;
  if (isBlank) {
    const texts = (q.correctAnswers && q.correctAnswers.length ? q.correctAnswers : [q.correctAnswer])
      .map((s) => String(s || '').replace(/^\(\d+\)\s*/, '').trim())
      .filter(Boolean)
      .map((s) => s.split(/[；;]/)[0].trim());   // 多种写法取第一个
    if (!texts.length) { warnings.push(`Q${no} 填空没有答案`); continue; }
    out[no] = texts;
    continue;
  }
  const raw = String(q.correctAnswer || q.correctAnswers && q.correctAnswers[0] || '').trim();
  if (!raw) { warnings.push(`Q${no} 无正确答案`); continue; }
  if (/^(对|错|正确|错误|√|×)$/.test(raw)) {
    out[no] = [/^(对|正确|√)$/.test(raw) ? 'true' : 'false'];
    continue;
  }
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean);
  if (!letters.length) { warnings.push(`Q${no} 无法解析：${raw}`); continue; }
  out[no] = letters;
}

const file = path.join(ROOT, dst);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
console.log(`已写入 ${file}，共 ${Object.keys(out).length - 1} 题`);
if (warnings.length) console.log('注意：\n' + warnings.join('\n'));
