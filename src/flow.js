'use strict';
/** 单套作业的完整自动化流程。 */
const fs = require('fs');
const path = require('path');
const { runInject, sleep } = require('./chaoxing');
const { decodeDeep, normalizeStem } = require('./text');
const { answerQuestions } = require('./llm');

const TYPE_NAME = { single: '单选', multi: '多选', judge: '判断' };

async function status(ctx) {
  return runInject(ctx, 'quizstatus').catch(() => null);
}

async function ensureVisible(ctx, log) {
  try {
    await ctx.cdp.bringToFront(ctx.sessionId);
    const st = await ctx.cdp.eval(ctx.sessionId, 'document.visibilityState + "|" + document.hidden');
    if (String(st).startsWith('hidden')) {
      log('  · 标签页在后台，已切到前台（学习通的提交依赖定时器，后台会被节流）');
      await sleep(500);
      await ctx.cdp.bringToFront(ctx.sessionId);
    }
  } catch (_) { /* ignore */ }
}

/** 取字体映射（带磁盘缓存） */
async function getFontMap(ctx, cfg, sampleText, log) {
  const dir = cfg.paths.fontMapDir;
  fs.mkdirSync(dir, { recursive: true });
  const res = await runInject(ctx, 'font', { sampleText });
  if (!res || !res.ok) {
    log(`  · 未取到混淆字体（${res ? res.error : '空返回'}），按明文处理`);
    return { map: null, cached: false };
  }
  const file = path.join(dir, res.hash + '.json');
  if (fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      log(`  · 字体映射命中缓存 ${res.hash}（${Object.keys(cached.map).length} 字）`);
      return { map: cached.map, cached: true, hash: res.hash };
    } catch (_) { /* 缓存坏了就重建 */ }
  }
  fs.writeFileSync(file, JSON.stringify({ hash: res.hash, family: res.family, refFamily: res.refFamily, map: res.map }), 'utf8');
  log(`  · 字体破解完成：${res.count} 字，平均相似度 ${res.avgSim}（参考字体 ${res.refFamily}，缓存 ${res.hash}）`);
  return { map: res.map, cached: false, hash: res.hash, avgSim: res.avgSim };
}

/** 解析答案：题库优先，剩下的交 LLM */
async function resolveAnswers(cfg, kb, questions, log) {
  const answers = {};
  const hits = { kb: 0, kbFuzzy: 0, llm: 0, none: 0 };
  const need = [];
  for (const q of questions) {
    const hit = kb.find(q.stem, q.type, q.options);
    if (hit) {
      answers[q.index] = hit.answerLetters;
      if (hit.sim === 1) hits.kb++; else hits.kbFuzzy++;
    } else {
      need.push(q);
    }
  }
  log(`  · 题库命中 ${hits.kb} 精确 + ${hits.kbFuzzy} 近似，剩 ${need.length} 题交给 LLM`);
  if (need.length) {
    const payload = need.map((q) => ({
      no: q.index,
      type: q.type,
      stem: q.stem,
      options: q.options.map((o) => ({ letter: o.letter, text: o.text })),
    }));
    const llmAns = await answerQuestions(cfg.llm, payload, log);
    for (const q of need) {
      const letters = llmAns[q.index];
      if (!letters || !letters.length) { hits.none++; continue; }
      // 只保留当前选项里真实存在的字母
      const valid = letters.filter((l) => q.options.some((o) => o.letter === l));
      if (!valid.length) { hits.none++; continue; }
      answers[q.index] = valid;
      hits.llm++;
      kb.upsert({
        stem: q.stem,
        type: q.type,
        options: Object.fromEntries(q.options.map((o) => [o.letter, o.text])),
        answerLetters: valid,
        answerTexts: valid.map((l) => (q.options.find((o) => o.letter === l) || {}).text || ''),
        source: 'llm',
        verified: false,
      });
    }
  }
  return { answers, hits };
}

function sameSet(a, b) {
  if (!a || !b) return false;
  const x = [...new Set(a)].sort().join(',');
  const y = [...new Set(b)].sort().join(',');
  return x === y;
}

function parseVerified(str) {
  const map = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const no = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    let letters = [];
    if (val) {
      if (/^(true|false)$/i.test(val)) letters = [val.toLowerCase()];
      else if (/^[A-Za-z]+$/.test(val)) letters = val.split('');   // 多选在表单里是 "ACD" 这种拼串
      else letters = val.split(/[,，、\s]+/).filter(Boolean);
    }
    map[Number(no)] = letters;
  }
  return map;
}

/** 交卷：点提交 → 等确认框 → 点确认。返回是否成功进入复核页 */
async function submitPaper(ctx, log) {
  await ensureVisible(ctx, log);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await runInject(ctx, 'submit').catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { log(`  ! 点提交失败：${r && r.error}`); return false; }
    await sleep(1500);
    for (let i = 0; i < 6; i++) {
      const c = await runInject(ctx, 'confirm').catch(() => null);
      if (c && c.ok) { log(`  · 已点击确认（${c.via}）`); break; }
      await sleep(1000);
    }
    // 等结果页
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const st = await status(ctx);
      if (st && (st.isReview || st.score != null || /已完成/.test(st.status || ''))) return true;
      if (st && st.total > 0 && /待完成/.test(st.status || '') && st.filled > 0) break; // 还没提交成功
    }
    log(`  ! 第 ${attempt} 次提交没变成复核页，重试…`);
    await ensureVisible(ctx, log);
  }
  return false;
}

/** 从复核页学习正确答案 */
function learnFromReview(kb, review, log) {
  let learned = 0;
  for (const q of review.questions) {
    const ca = String(q.correctAnswer || '').trim();
    if (!ca) continue;
    const opts = q.options || [];
    // 「正确答案」可能是字母串（多选 "ACD"），也可能是选项文本（判断「对」）。
    // 统一折成「答案文本」，因为只有文本在选项重排后仍然有效。
    let picked = ca.replace(/[,\s、]/g, '').split('')
      .map((l) => opts.find((o) => o.letter === l))
      .filter(Boolean);
    if (!picked.length) {
      const byText = opts.find((o) => o.text && (ca === o.text || ca.includes(o.text)));
      if (byText) picked = [byText];
    }
    const type = /多选/.test(q.typeLabel) ? 'multi' : /判断/.test(q.typeLabel) ? 'judge' : 'single';
    // 判断题在复核页没有 A/B 选项，正确答案直接是「对」「错」文本
    if (!picked.length && (type === 'judge' || /^(对|错|正确|错误|√|×|true|false)$/i.test(ca))) {
      const isTrue = /^(对|正确|√|true)$/i.test(ca);
      kb.upsert({
        stem: q.stem,
        type: 'judge',
        options: { true: '对', false: '错' },
        answerLetters: [isTrue ? 'true' : 'false'],
        answerTexts: [isTrue ? '对' : '错'],
        source: 'review',
        verified: true,
      });
      learned++;
      continue;
    }
    if (!picked.length) continue;
    const answerTexts = picked.map((o) => o.text);
    kb.upsert({
      stem: q.stem,
      type,
      options: Object.fromEntries(opts.map((o) => [o.letter, o.text])),
      answerLetters: picked.map((o) => o.letter),
      answerTexts,
      source: 'review',
      verified: true,
    });
    learned++;
  }
  if (learned) log(`  · 已从复核页学习 ${learned} 题的正确答案（题库 ${kb.size} 条）`);
  return learned;
}

/**
 * 跑一套作业。
 * @returns {{skipped?:boolean, score?:number, correct?:number, total?:number, review?:object}}
 */
async function runWork(ctx, cfg, kb, work, log = console.log) {
  log(`\n== ${work.no ? work.no + ' ' : ''}${work.name} (chapterId=${work.chapterId}) ==`);
  const { openChapter } = require('./chaoxing');
  const started = await openChapter(ctx, work.chapterId);
  await ensureVisible(ctx, log);
  let st = started || await status(ctx);
  if (!st) throw new Error('作业页没加载出来');
  if (st.isReview) {
    log('  · 这套已经在复核页（之前做过），先把正确答案学进题库');
    const review = await runInject(ctx, 'review');
    if (review && review.ok) learnFromReview(kb, review, log);
    kb.save();
    if (!cfg.quiz.force) {
      return { skipped: true, score: review && review.ok ? review.score : null };
    }
    log('  · 配置了 force，点「重做」开一次新的作答');
    // 复核页的按钮是异步渲染的，重试几次
    let r = null;
    for (let i = 0; i < 8; i++) {
      r = await runInject(ctx, 'redo').catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) break;
      await sleep(1500);
    }
    if (!r || !r.ok) throw new Error('点重做失败：' + (r && r.error));
    await sleep(1500);
    const rc = await runInject(ctx, 'redoConfirm').catch(() => null);
    log(`  · 确认重做：${rc && rc.ok ? rc.via : '没找到确认按钮（可能不需要确认）'}`);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      st = await status(ctx);
      if (st && st.total > 0 && !st.isReview) break;
    }
  }
  log(`  · 题目 ${st.total} 题，已填 ${st.filled}，状态 ${st.status || '未知'}`);
  if (st.total === 0) throw new Error('没抽到题目');
  if (cfg.quiz.skipDone && !cfg.quiz.force && /已完成/.test(st.status || '') && st.score != null) {
    log(`  · 已完成（${st.score} 分），跳过`);
    return { skipped: true, score: st.score };
  }

  const ex = await runInject(ctx, 'extract');
  if (!ex || !ex.ok) throw new Error('抽题失败：' + (ex ? ex.error : '空返回'));
  const sampleText = [ex.questions.map((q) => q.stem).join(''), ex.questions.map((q) => q.options.map((o) => o.text).join('')).join('')].join('');
  const font = await getFontMap(ctx, cfg, sampleText, log);
  const questions = decodeDeep(ex.questions, font.map);

  // 打印前 3 题，方便人工确认解码质量
  for (const q of questions.slice(0, 3)) {
    log(`  Q${q.index}【${TYPE_NAME[q.type] || q.type}】${q.stem.slice(0, 46)}`);
    log(`      ${q.options.map((o) => `${o.letter}.${o.text.slice(0, 18)}`).join('  ')}`);
  }

  const { answers, hits } = await resolveAnswers(cfg, kb, questions, log);
  const missing = questions.filter((q) => !answers[q.index]).map((q) => q.index);
  if (missing.length) log(`  ! 有 ${missing.length} 题没拿到答案（题号 ${missing.join(',')}），将留空`);

  const applied = await runInject(ctx, 'answer', { answers });
  if (!applied || !applied.ok) throw new Error('作答失败：' + (applied ? applied.error : '空返回'));
  const got = parseVerified(applied.verified);
  let mismatch = 0;
  for (const q of questions) {
    const want = (answers[q.index] || []).slice().sort();
    const have = (got[q.index] || []).slice().sort();
    if (want.length && !sameSet(want, have)) {
      mismatch++;
      if (mismatch <= 5) log(`  ! Q${q.index} want=${want.map((c) => '[' + c + ']').join('')} have=${have.map((c) => '[' + c + ']').join('')}`);
    }
  }
  log(mismatch ? `  ! ${mismatch} 题作答校验不一致` : '  · 全部题目作答校验通过');

  if (!cfg.quiz.autoSubmit) {
    log('  · 配置为不自动提交，已停在作答页');
    kb.save();
    return { answers, pending: true, hits };
  }

  const ok = await submitPaper(ctx, log);
  if (!ok) { log('  ! 提交没成功'); return { error: 'submit-failed', hits }; }

  st = await status(ctx);
  log(`  · 结果：${st && st.score != null ? st.score + ' 分' : '未读到分数'} / ${st && st.status ? st.status : ''}`);

  const review = await runInject(ctx, 'review');
  let correct = null;
  if (review && review.ok) {
    correct = review.questions.filter((q) => q.correct).length;
    learnFromReview(kb, review, log);
    kb.save();
  }
  return { score: st && st.score, correct, total: questions.length, hits, review: review && review.ok ? { score: review.score } : null };
}

module.exports = { runWork, getFontMap, resolveAnswers, submitPaper, learnFromReview, status, ensureVisible, learnFromWork };

/**
 * 只「学习」：打开一套已完成的测验，从复核页把正确答案抄进题库。
 * 不做任何点击，不会消耗重做次数。
 */
async function learnFromWork(ctx, cfg, kb, work, log = console.log) {
  const { openChapter } = require('./chaoxing');
  log(`\n== 学习 ${work.name} ==`);
  await openChapter(ctx, work.chapterId);
  await ensureVisible(ctx, log);
  const st = await status(ctx);
  if (!st || !st.isReview) {
    log('  · 这套不在复核页（可能还没做），跳过');
    return { skipped: true };
  }
  const review = await runInject(ctx, 'review');
  if (!review || !review.ok) { log('  · 复核页解析失败'); return { error: 'review-parse' }; }
  const n = learnFromReview(kb, review, log);
  kb.save();
  log(`  · 总分 ${review.score == null ? '未知' : review.score}，学到 ${n} 题`);
  return { learned: n, score: review.score };
}
