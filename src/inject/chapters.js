/** 解析课程「章节」目录页，找出所有可做的作业/测验及其状态。 */
() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('div.chapter_item')];
  const out = [];
  items.forEach((el) => {
    const onclick = el.getAttribute('onclick') || '';
    const m = /toOld\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?/.exec(onclick);
    if (!m) return;
    const chapterId = m[2];
    const titleEl = el.querySelector('.clicktitle') || el;
    const bar = el.querySelector('.catalog_sbar');
    const name = clean(titleEl.textContent).replace(clean(bar ? bar.textContent : ''), '').trim() || (el.getAttribute('title') || '');
    const stateEl = el.querySelector('.catalog_state');
    const stateCls = stateEl ? stateEl.className : '';
    const stateText = clean(stateEl ? stateEl.textContent : '');
    const done = /icon_yiwanc/.test(stateCls) || /已完成/.test(stateText);
    const isWork = /测试|测验|作业|练习/.test(name) || /作业|测验/.test(el.getAttribute('title') || '');
    out.push({ chapterId, no: clean(bar ? bar.textContent : ''), name, done, isWork, stateText, stateCls });
  });
  // 任务点进度
  const flat = clean(document.body.innerText);
  const tp = /已完成任务点\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/.exec(flat);
  const url = new URL(location.href);
  return {
    ok: true,
    url: location.href,
    courseid: url.searchParams.get('courseid') || '',
    clazzid: url.searchParams.get('clazzid') || '',
    cpi: url.searchParams.get('cpi') || '',
    enc: url.searchParams.get('enc') || '',
    taskPoints: tp ? { done: Number(tp[1]), total: Number(tp[2]) } : null,
    total: out.length,
    items: out,
    works: out.filter((x) => x.isWork),
  };
}
