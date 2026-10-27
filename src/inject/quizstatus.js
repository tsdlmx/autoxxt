/** 读取当前作业页状态：待完成/已完成、得分、已填题数。 */
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
  const text = (doc.body && doc.body.innerText) || '';
  const flat = text.replace(/\s+/g, ' ');
  const scoreM = flat.match(/最终成绩\s*[：:]?\s*([\d.]+)\s*分/);
  const statusM = flat.match(/(待完成|未完成|已完成|已完成任务点)/);
  const timus = doc.querySelectorAll('.TiMu');
  let filled = 0;
  for (const mu of timus) {
    // 每题的隐藏域 name="answer<qid>"（answertype<qid> 不算）
    const ins = [...mu.querySelectorAll('input')];
    const hid = ins.find((i) => /^answer/.test(i.name || '') && !/^answertype/.test(i.name || ''));
    if (hid && hid.value) filled++;
    else if (mu.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) filled++;
    else if (mu.querySelector('li.check_answer')) filled++;
  }
  return {
    url: location.href,
    readyState: doc.readyState,
    visibility: document.visibilityState,
    hidden: document.hidden,
    status: statusM ? statusM[1] : null,
    score: scoreM ? Number(scoreM[1]) : null,
    total: timus.length,
    filled,
    isReview: !!doc.querySelector('.newAnswerBx'),
    snippet: flat.slice(0, 320),
  };
}
