/** 点确认框里的「提交/确定」。 */
() => {
  const docs = [];
  const walk = (d, depth) => {
    if (depth > 4 || !d) return;
    docs.push(d);
    for (const f of d.querySelectorAll('iframe')) {
      try { if (f.contentDocument) walk(f.contentDocument, depth + 1); } catch (_) { /* ignore */ }
    }
  };
  walk(document, 0);

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };

  // 1) 标准确认框
  for (const d of docs) {
    const ok = d.querySelector('#popok');
    if (ok) { ok.click(); return { ok: true, via: 'popok', text: (ok.textContent || '').trim() }; }
  }
  // 2) 弹窗里的确定/提交
  const popupSelectors = ['.popDiv', '.maskDiv', '.popup', '.dialog', '.layer', '[class*="pop"]'];
  for (const d of docs) {
    for (const sel of popupSelectors) {
      for (const box of d.querySelectorAll(sel)) {
        if (!visible(box)) continue;
        const el = [...box.querySelectorAll('a, button, span')].find(
          (e) => visible(e) && /^(确定|提交|确认|是|继续提交)$/.test((e.textContent || '').trim())
        );
        if (el) { el.click(); return { ok: true, via: 'popup:' + sel, text: (el.textContent || '').trim() }; }
      }
    }
  }
  // 3) 兜底：任何可见的「确定」
  for (const d of docs) {
    const el = [...d.querySelectorAll('a, button')].find(
      (e) => visible(e) && /^(确定|提交|确认)$/.test((e.textContent || '').trim())
    );
    if (el) { el.click(); return { ok: true, via: 'fallback', text: (el.textContent || '').trim() }; }
  }
  return { ok: false, error: '没有可见的确认按钮' };
}
