/**
 * 抽取当前作业页的题目。
 * 兼容两套 DOM（新老模板）：
 *   A 型：li.before-after + span.num_option[data]         —— data 才是真实字母
 *   C 型：li.font-cxsecret.before-after + input[value]    —— input.value 才是真实字母
 * 页面会把选项随机打乱：屏幕上显示的字母 ≠ 真实字母，作答必须按真实字母点。
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
  if (!timus.length) {
    return { ok: false, error: '当前页面没找到题目（.TiMu）', url: location.href };
  }
  if (doc.querySelector('.newAnswerBx')) {
    return { ok: false, needReview: true, error: '这是成绩/答案复核页，不是作答页', url: location.href };
  }

  const cleanText = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

  const questions = [];
  timus.forEach((mu, idx) => {
    const typeEl = mu.querySelector('.newZy_TItle');
    const typeText = cleanText(typeEl && typeEl.textContent);
    let type = 'single';
    if (/多选/.test(typeText)) type = 'multi';
    else if (/判断/.test(typeText)) type = 'judge';

    const label = mu.querySelector('.Zy_TItle .fontLabel') || mu.querySelector('.Zy_TItle');
    let stem = '';
    if (label) {
      const clone = label.cloneNode(true);
      clone.querySelectorAll('.newZy_TItle').forEach((n) => n.remove());
      stem = cleanText(clone.textContent);
    }

    const lis = [...mu.querySelectorAll('.Zy_ulTop li')];
    const options = lis.map((li) => {
      const span = li.querySelector('span.num_option, span.num_option_dx, span.num_optiondx, span[data]');
      const input = li.querySelector('input[type="radio"], input[type="checkbox"]');
      let letter = null;
      if (span && span.getAttribute('data') != null) letter = span.getAttribute('data');
      else if (input && input.value != null) letter = input.value;
      const display = span ? cleanText(span.textContent) : (li.querySelector('i') ? cleanText(li.querySelector('i').textContent).replace(/[、.]$/, '') : '');
      let text = '';
      const p = li.querySelector('a') || li;
      const clone = p.cloneNode(true);
      clone.querySelectorAll('span.num_option, span.num_option_dx, span.num_optiondx, input').forEach((n) => n.remove());
      text = cleanText(clone.textContent);
      if (letter === 'true' || letter === 'false') {
        type = type === 'judge' ? type : 'judge';
        text = letter === 'true' ? '对' : '错';
      }
      const selected = input ? !!input.checked : /selected|active/.test(li.className);
      return { letter, display, text, selected };
    }).filter((o) => o.letter != null);

    // 隐藏域记录当前作答值，是最可靠的校验依据
    const hid = doc.querySelector(`input[id="answer${mu.getAttribute('data')}"]`) ||
      mu.querySelector('input[type="hidden"][id^="answer"]');
    const filled = hid && hid.value ? String(hid.value) : '';

    questions.push({
      qid: mu.getAttribute('data') || String(idx + 1),
      index: idx + 1,
      type,
      typeLabel: typeText,
      stem,
      options,
      filled,
    });
  });

  const header = cleanText((doc.body.innerText || '').slice(0, 200));
  return {
    ok: true,
    url: location.href,
    title: doc.title || document.title,
    header,
    count: questions.length,
    questions,
  };
}
