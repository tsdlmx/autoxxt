/** 点「提交」，然后报告是否弹出了确认框、确认按钮在哪。 */
() => {
  const allDocs = () => {
    const docs = [];
    const walk = (d, depth) => {
      if (depth > 4 || !d) return;
      docs.push(d);
      for (const f of d.querySelectorAll('iframe')) {
        try { if (f.contentDocument) walk(f.contentDocument, depth + 1); } catch (_) { /* ignore */ }
      }
    };
    walk(document, 0);
    return docs;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };

  const docs = allDocs();
  // 主动把标签页唤醒，不然定时器被节流，提交会卡住
  try { window.focus(); } catch (_) { /* ignore */ }

  let submitBtn = null;
  for (const d of docs) {
    const c = d.querySelector('#btnSubmit, a.btnSubmit, a.Btn_blue_1, a[onclick*="btnBlueSubmit"]');
    if (c) { submitBtn = c; break; }
  }
  if (!submitBtn) return { ok: false, error: '没找到提交按钮' };

  submitBtn.click();

  // 找确认框
  const findConfirm = () => {
    for (const d of docs) {
      const ok = d.querySelector('#popok');
      if (ok) return { doc: d, el: ok, id: 'popok', text: (ok.textContent || '').trim() };
    }
    for (const d of docs) {
      const cands = [...d.querySelectorAll('a, button, span, div')].filter(
        (el) => visible(el) && /^(提交|确定|确认|确定提交)$/.test((el.textContent || '').trim())
      );
      if (cands.length) {
        const el = cands[cands.length - 1];
        return { doc: d, el, id: el.id || el.className || 'text', text: (el.textContent || '').trim() };
      }
    }
    return null;
  };

  const conf = findConfirm();
  return {
    ok: true,
    clickedSubmit: (submitBtn.className || '') + '|' + (submitBtn.id || ''),
    confirm: conf ? { id: conf.id, text: conf.text } : null,
  };
}
