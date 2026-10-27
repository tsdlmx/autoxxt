/** 在复核页点「重做」。真实结构：.ansbtnBox > a.jb_btn_bg[onclick="redoTest()"] */
() => {
  const docs = [];
  const push = (d) => { if (d && !docs.includes(d)) docs.push(d); };
  push(document);
  const walk = (d) => {
    for (const f of [...d.querySelectorAll('iframe')]) {
      try { push(f.contentDocument); walk(f.contentDocument); } catch (_) { /* 跨域忽略 */ }
    }
  };
  walk(document);

  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  for (const d of docs) {
    // 1) 最可靠：onclick 里带 redoTest
    let el = [...d.querySelectorAll('a[onclick*="redoTest"],a[onclick*="redo"]')].find(visible);
    // 2) 次选：.ansbtnBox 里的按钮
    if (!el) el = [...d.querySelectorAll('.ansbtnBox a, .ansbtnBox span')].find(visible);
    // 3) 退路：文字以「重做」开头的最短元素
    if (!el) {
      const cands = [...d.querySelectorAll('a,button,span,div')]
        .filter((x) => /^重做/.test((x.textContent || '').replace(/\s+/g, '')) && visible(x))
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      el = cands[0];
    }
    if (el) {
      const how = el.getAttribute('onclick') || el.className || el.tagName;
      el.click();
      return { ok: true, clicked: (el.textContent || '').replace(/\s+/g, ' ').trim(), via: how };
    }
  }
  return { ok: false, error: '复核页上没找到「重做」按钮' };
}
