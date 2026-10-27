/**
 * 按「真实字母」作答并复核。
 * args: { answers: { "1": ["A"], "12": ["A","B","D"], "30": ["true"] }, dryRun?: boolean }
 * 返回每题在表单里的实际值（用于校验，真正落库的就是这些隐藏域）。
 */
(args) => {
  const { answers = {}, dryRun = false } = args || {};
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
  if (!timus.length) return { ok: false, error: '当前不是作答页' };

  const realLetter = (li) => {
    const span = li.querySelector('span[data]');
    if (span && span.getAttribute('data') != null) return span.getAttribute('data');
    const input = li.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input && input.value != null) return input.value;
    return null;
  };
  const isSelected = (li) => {
    const cls = li.className || '';
    if (/\bcheck_answer\b/.test(cls)) return true;
    if (li.getAttribute('aria-checked') === 'true') return true;
    const input = li.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) return !!input.checked;
    return false;
  };
  // 每题表单里的隐藏域：<input name="answer<qid>">（注意别把 answertype<qid> 当成答案）
  const answerInput = (mu) => {
    const ins = [...mu.querySelectorAll('input')];
    return ins.find((i) => /^answer/.test(i.name || '') && !/^answertype/.test(i.name || '')) || null;
  };

  const report = [];
  const log = [];
  timus.forEach((mu, idx) => {
    const no = String(idx + 1);
    const want = (answers[no] || []).map(String);
    const lis = [...mu.querySelectorAll('.Zy_ulTop li')];
    if (want.length && !dryRun) {
      let clicked = 0;
      for (const li of lis) {
        const letter = realLetter(li);
        if (letter == null) continue;
        const should = want.includes(letter);
        if (should === isSelected(li)) continue;
        try { li.click(); } catch (_) { /* ignore */ }
        const input = li.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input && !!input.checked !== should) {
          try { input.click(); } catch (_) { /* ignore */ }
        }
        clicked++;
      }
      if (clicked) log.push(`${no}:${clicked}`);
    }
    const hid = answerInput(mu);
    let val = hid && hid.value ? String(hid.value) : '';
    if (!val) {
      val = lis.map((li) => (isSelected(li) ? realLetter(li) : null)).filter(Boolean).join('');
    }
    report.push(`${no}=${val}`);
  });

  return { ok: true, total: timus.length, clickedSummary: log.join(','), verified: report.join(';') };
}
