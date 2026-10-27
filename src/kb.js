'use strict';
/**
 * 自学习题库。
 *
 * 只按「题干文本」索引，答案按「选项文本」保存 —— 因为学习通每套题的选项顺序是打乱的，
 * 存字母下次一定错，存文本才能跨套、跨账号、跨学期复用。
 *
 * 数据来源优先级：复核页正确答案（verified=true）> LLM 判断（verified=false）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeStem, dice, optionSimilarity } = require('./text');

class KB {
  constructor(file, opts = {}) {
    this.file = file;
    this.fuzzyMin = opts.fuzzyMin == null ? 0.82 : opts.fuzzyMin;
    this.optMin = opts.optMin == null ? 0.86 : opts.optMin;
    this.entries = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let fixed = 0;
      for (const e of raw.entries || []) {
        if (this._normalize(e)) fixed++;
        this.entries.set(e.key, e);
      }
      if (fixed) this.dirty = true;   // 老版本写坏的条目，顺手修好后回写
    } catch (_) { /* 首次运行没有文件 */ }
  }

  /**
   * 修正老条目：
   *  - 判断题早期把「对/错」当成了字母存（answerTexts 为空），这里补成 texts=对/错、letters=true/false
   *  - 其它题型 answerTexts 缺失时，用存下来的 options 把字母翻回文本
   * @returns {boolean} 是否改动
   */
  _normalize(e) {
    if (!e || !Array.isArray(e.answerLetters)) return false;
    const hasTexts = Array.isArray(e.answerTexts) && e.answerTexts.length && e.answerTexts.every((t) => t);
    if (e.type === 'judge') {
      if (hasTexts && /^(对|错)$/.test(e.answerTexts[0]) && e.answerLetters[0] === (e.answerTexts[0] === '对' ? 'true' : 'false')) return false;
      const raw = String(e.answerTexts && e.answerTexts[0] || e.answerLetters[0] || '');
      const isTrue = /对|正确|true|√|^y$/i.test(raw);
      e.answerTexts = [isTrue ? '对' : '错'];
      e.answerLetters = [isTrue ? 'true' : 'false'];
      if (!e.options || !Object.keys(e.options).length) e.options = { true: '对', false: '错' };
      return true;
    }
    if (hasTexts) return false;
    const opts = e.options || {};
    const texts = e.answerLetters.map((l) => (opts[l] == null ? '' : opts[l]));
    if (!texts.length || texts.some((t) => !t)) return false;
    e.answerTexts = texts;
    return true;
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = { version: 1, updated: new Date().toISOString(), entries: [...this.entries.values()] };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 1), 'utf8');
    this.dirty = false;
  }

  static key(stem) {
    return crypto.createHash('sha1').update(normalizeStem(stem)).digest('hex').slice(0, 16);
  }

  get size() { return this.entries.size; }

  /**
   * 查题。命中返回 { answerTexts, verified, sim, source }，否则 null。
   */
  find(stem, type, options) {
    const norm = normalizeStem(stem);
    if (!norm) return null;
    const exact = this.entries.get(KB.key(stem));
    if (exact && (!type || exact.type === type)) {
      exact.hits = (exact.hits || 0) + 1;
      this.dirty = true;
      // 选项每次都会被重新打乱（判断题还会从 A/B 变成 true/false），
      // 所以优先按「答案文本」回映射到当前选项；失败才退回存下来的字母。
      const remapped = this.mapTextsToLetters(exact.answerTexts, options);
      return {
        answerTexts: exact.answerTexts,
        answerLetters: remapped || exact.answerLetters,
        verified: !!exact.verified,
        sim: 1,
        source: exact.source || 'kb',
      };
    }
    let best = null;
    for (const e of this.entries.values()) {
      if (type && e.type !== type) continue;
      const s = dice(norm, normalizeStem(e.stem));
      if (s >= this.fuzzyMin && (!best || s > best.sim)) best = { e, sim: s };
    }
    if (!best) return null;
    // 选项集合也要能对上，否则可能是「同题干不同选项」的陷阱题
    const hit = this.mapTextsToLetters(best.e.answerTexts, options);
    if (!hit) return null;
    return { answerTexts: best.e.answerTexts, answerLetters: hit, verified: !!best.e.verified, sim: best.sim, source: best.e.source || 'kb' };
  }

  /** 把「答案文本」映射成当前选项的真实字母数组；有任何一个对不上就返回 null */
  mapTextsToLetters(answerTexts, options) {
    if (!Array.isArray(answerTexts) || !answerTexts.length || !options || !options.length) return null;
    const letters = [];
    for (const t of answerTexts) {
      let best = null;
      for (const o of options) {
        const s = optionSimilarity(t, o.text);
        if (!best || s > best.s) best = { o, s };
      }
      if (!best || best.s < this.optMin) return null;
      letters.push(best.o.letter);
    }
    return letters;
  }

  /** 写入/更新一条（按题干 key） */
  upsert(entry) {
    const key = KB.key(entry.stem);
    const prev = this.entries.get(key);
    const next = prev ? { ...prev, ...entry, hits: prev.hits || 0 } : { ...entry, hits: 0 };
    // 已核实的答案不被未核实答案覆盖
    if (prev && prev.verified && !entry.verified && prev.answerTexts.join('|') === (entry.answerTexts || []).join('|')) {
      next.verified = true;
      next.source = prev.source;
    }
    next.key = key;
    next.updated = new Date().toISOString();
    this.entries.set(key, next);
    this.dirty = true;
    return next;
  }

  stats() {
    let verified = 0;
    let llm = 0;
    for (const e of this.entries.values()) { if (e.verified) verified++; else llm++; }
    return { total: this.entries.size, verified, unverified: llm };
  }
}

module.exports = { KB };
