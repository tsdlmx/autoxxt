/** 解析「全部课程」列表页。 */
() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const list = [];
  const seen = new Set();
  const cards = [...document.querySelectorAll('.course, .courseItem, li.clearfix')];
  for (const card of cards) {
    const a = card.querySelector('a[href*="stucoursemiddle"]');
    if (!a) continue;
    let courseid = '', clazzid = '', cpi = '';
    try {
      const u = new URL(a.href, location.href);
      courseid = u.searchParams.get('courseid') || '';
      clazzid = u.searchParams.get('clazzid') || '';
      cpi = u.searchParams.get('cpi') || '';
    } catch (_) { /* ignore */ }
    if (!courseid || !clazzid) continue;
    const key = courseid + '/' + clazzid;
    if (seen.has(key)) continue;
    seen.add(key);
    // 注意：不能用 querySelector('.course-name, h3, .clearfix a')——选择器列表返回的是
    // 文档顺序上的第一个匹配，会优先命中卡片里更靠前的 <a>，导致课程名变成「移动到」。
    let nameEl = card.querySelector('.course-name') || card.querySelector('.courseName') || card.querySelector('h3');
    let name = clean(nameEl ? nameEl.textContent : '');
    if (!name) {
      // 退路：从卡片文本里挑一行既不是按钮也不是老师/时间的长文本
      const lines = (card.innerText || '').split('\n').map(clean).filter(Boolean);
      const skip = /^(移动到|置顶|退课|取消置顶)$/;
      name = lines.find((l) => !skip.test(l) && l.length >= 4 && !/^开课时间/.test(l) && !/^[\d.\s]+$/.test(l)) || '';
    }
    const teacherEl = card.querySelector('.course-teacher, .teacher, .courseInfo .fl');
    list.push({
      name: name || ('课程' + courseid),
      courseid, clazzid, cpi,
      teacher: clean(teacherEl ? teacherEl.textContent : ''),
      href: a.href,
    });
  }
  return { ok: true, count: list.length, courses: list, url: location.href };
}
