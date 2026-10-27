'use strict';
/** 题目文本处理：字体解码、归一化、相似度。 */

/** 用字体映射把乱码还原成真字；映射里没有的字符原样保留。 */
function decode(text, map) {
  if (!text || !map) return text || '';
  let out = '';
  for (const ch of text) out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
  return out;
}

/** 递归解码对象里所有字符串（题目/选项一起处理） */
function decodeDeep(value, map) {
  if (!map) return value;
  if (typeof value === 'string') return decode(value, map);
  if (Array.isArray(value)) return value.map((v) => decodeDeep(v, map));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = decodeDeep(value[k], map);
    return o;
  }
  return value;
}

const PUNCT = /[\s\u3000，。、；：？！“”‘’（）()《》〈〉【】\[\]{}<>—…·,.;:?!"'`~@#$%^&*_+=|\\/-]/g;

/** 只保留汉字字母数字，用于题库比对（去掉标点空格和题号） */
function normalizeStem(stem) {
  return String(stem || '')
    .replace(/^\s*\d+[.、．]\s*/, '')
    .replace(PUNCT, '')
    .replace(/[（(]\s*[)）]/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Dice 系数，0~1 */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [g, n] of A) { totalA += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const [, n] of B) totalB += n;
  return (2 * inter) / (totalA + totalB);
}

/** 选项文本比对（用于把「答案文本」映射回当前打乱后的字母） */
function optionSimilarity(a, b) {
  const x = normalizeStem(a);
  const y = normalizeStem(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.95;
  return dice(x, y);
}

module.exports = { decode, decodeDeep, normalizeStem, dice, optionSimilarity };
