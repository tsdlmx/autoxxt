/**
 * 解析成绩复核页：每题「我的答案」「正确答案」+ 选项原文。
 * 这是自学习题库的唯一可信数据源——答完一套就把正确答案沉淀下来。
 */
() => {
  const findDoc = () => {
    const seen = new Set();
    let d = document;
    for (let i = 0; i < 6; i++) {
      if (seen.has(d)) break;
      seen.add(d);
      const f = d.querySelector('iframe');
      if (!f || !f.contentDocument) break;
      d = f.contentDocument;
    }
    return d;
  };
  const doc = findDoc();
  const timus = [...doc.querySelectorAll('.TiMu')];
  if (!timus.length) return { ok: false, error: '不是复核页' };
  const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '').trim();
  const normLetter = (s) => (s || '').replace(/[\s,，、]/g, '').toUpperCase();

  const out = [];
  timus.forEach((mu, idx) => {
    const typeText = clean((mu.querySelector('.newZy_TItle') || {}).textContent);
    const label = mu.querySelector('.Zy_TItle .fontLabel') || mu.querySelector('.Zy_TItle');
    let stem = '';
    if (label) {
      const clone = label.cloneNode(true);
      clone.querySelectorAll('.newZy_TItle').forEach((n) => n.remove());
      stem = clean(clone.textContent);
    }
    const options = [];
    for (const li of mu.querySelectorAll('.Zy_ulTop li')) {
      const iEl = li.querySelector('i');
      const letter = normLetter((iEl ? iEl.textContent : '').replace(/[、.．]/g, ''));
      const clone = li.cloneNode(true);
      clone.querySelectorAll('i').forEach((n) => n.remove());
      options.push({ letter, text: clean(clone.textContent) });
    }
    const my = normLetter((mu.querySelector('.myAnswer .answerCon') || {}).textContent);
    const correct = normLetter((mu.querySelector('.correctAnswer .answerCon') || {}).textContent);
    const dui = !!mu.querySelector('.marking_dui');
    const cuo = !!mu.querySelector('.marking_cuo');
    const num = mu.querySelector('.scoreNum');
    out.push({
      index: idx + 1,
      qid: mu.getAttribute('data') || '',
      typeLabel: typeText,
      stem,
      options,
      myAnswer: my,
      correctAnswer: correct,
      correct: dui || (!cuo && !!correct && my === correct),
      score: num ? Number(clean(num.textContent)) : null,
    });
  });
  const flat = (doc.body.innerText || '').replace(/\s+/g, ' ');
  const scoreM = flat.match(/最终成绩\s*[：:]?\s*([\d.]+)\s*分/);
  return { ok: true, score: scoreM ? Number(scoreM[1]) : null, count: out.length, questions: out };
}
