/** 点「重做」后的确认弹窗（#redoWin）里点「确定」。 */
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
  const label = (el) => ((el.innerText || el.textContent || '') + '').replace(/\s+/g, '').trim();

  for (const d of docs) {
    const win = d.querySelector('#redoWin');
    if (win && visible(win)) {
      const btn = [...win.querySelectorAll('a,button,span')].find((el) => /^(确定|确认)$/.test(label(el)) && visible(el));
      if (btn) { btn.click(); return { ok: true, via: '#redoWin' }; }
    }
  }
  // 退路：任意可见的「确定」
  for (const d of docs) {
    const btn = [...d.querySelectorAll('a,button')].find((el) => /^确定$/.test(label(el)) && visible(el));
    if (btn) { btn.click(); return { ok: true, via: 'fallback-确定' }; }
  }
  return { ok: false, error: '没找到确认按钮' };
}
