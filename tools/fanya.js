#!/usr/bin/env node
'use strict';
/**
 * 泛雅 fanyaMarking 作业页专用驱动（新版 .questionLi 模板）。
 *
 *   node tools/fanya.js extract  [--out data/chXX.json] [--tab 0]
 *   node tools/fanya.js answer   --answers data/chXX-answers.json [--tab 0]
 *   node tools/fanya.js submit   [--tab 0]
 *   node tools/fanya.js status   [--tab 0]
 *   node tools/fanya.js review   [--tab 0]          # 读复核页，输出正确答案
 *
 * 模板事实（2026-10 实测）：
 *   题容器  div.questionLi[data=qid][typename=单选题|多选题|判断题]
 *   题干    h3.mark_name（去掉 span.colorShallow 的题型标签和前导题号）
 *   选项    div.answerBg > span.num_option|num_option_dx[data=A..] + div.answer_p
 *   落库值  input#answer<qid>（校验以此为准），题型 input#answertype<qid>
 *   提交    a.completeBtn[onclick="submitValidate();"]
 */
const fs = require('fs');
const path = require('path');
const { load } = require('../src/config');
const { CDP } = require('../src/cdp');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPE = { 单选题: 'single', 多选题: 'multi', 判断题: 'judge' };

/* ───────────── 页面内执行的表达式 ───────────── */

const EXTRACT = `(() => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\s*\\n\\s*/g, ' ').trim();
  const qs = [...document.querySelectorAll('div.questionLi')];
  if (!qs.length) return { ok: false, error: '没有 .questionLi' };
  const out = qs.map((q, i) => {
    const qid = q.getAttribute('data') || '';
    const typename = q.getAttribute('typename') || '';
    // 题干
    const h3 = q.querySelector('h3.mark_name');
    let stem = '';
    if (h3) {
      const c = h3.cloneNode(true);
      c.querySelectorAll('span.colorShallow').forEach((n) => n.remove());
      stem = clean(c.textContent).replace(/^\\d+\\s*[.、．]\\s*/, '');
    }
    // 选项
    const options = [...q.querySelectorAll('div.answerBg')].map((bg) => {
      const span = bg.querySelector('span[data]');
      const letter = span ? span.getAttribute('data') : null;
      const p = bg.querySelector('.answer_p') || bg;
      return { letter, text: clean(p.textContent) };
    }).filter((o) => o.letter != null && o.text);
    // 已落库的值
    const hid = q.querySelector('input[id="answer' + qid + '"]');
    return { index: i + 1, qid, typename, type: ${JSON.stringify(TYPE)}[typename] || 'single', stem, options, filled: hid ? hid.value : '' };
  });
  return { ok: true, url: location.href, title: document.title, count: out.length, questions: out };
})()`;

const STATUS = `(() => {
  const qs = [...document.querySelectorAll('div.questionLi')];
  let filled = 0;
  qs.forEach((q) => {
    const qid = q.getAttribute('data');
    const hid = q.querySelector('input[id="answer' + qid + '"]');
    const tas = [...q.querySelectorAll('textarea[id^="answerEditor"]')];
    const byTa = tas.some((t) => String(t.value || '').trim() && String(t.value || '').replace(/<[^>]*>/g, '').trim());
    if ((hid && String(hid.value || '').trim()) || byTa) filled++;
  });
  const t = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
  const m = /(\\d+(?:\\.\\d+)?)\\s*分/.exec(t);
  return {
    ok: true,
    url: location.href,
    total: qs.length,
    filled,
    isReview: /答题详情|正确答案|你的答案/.test(t) && !qs.length,
    scoreText: m ? m[0] : null,
    textHead: t.slice(0, 300),
  };
})()`;

const APPLY = (answers) => `(() => {
  const answers = ${JSON.stringify(answers)};
  const report = [];
  const details = [];
  const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const qs = [...document.querySelectorAll('div.questionLi')];
  qs.forEach((q, i) => {
    const no = String(i + 1);
    const qid = q.getAttribute('data');
    const typename = q.getAttribute('typename') || '';
    const want = (answers[no] || []).map(String);
    const isJudge = /判断/.test(typename);
    const isMulti = /多选/.test(typename);
    const isBlank = /填空/.test(typename);

    if (isBlank) {
      const tas = [...q.querySelectorAll('textarea[id^="answerEditor"]')];
      if (want.length) {
        tas.forEach((ta, bi) => {
          const val = want[bi];
          if (val == null) return;
          const html = '<p>' + String(val) + '</p>';
          try {
            const ed = window.UE && window.UE.getEditor ? window.UE.getEditor(ta.id) : null;
            if (ed) ed.setContent(html);
            else ta.value = html;
          } catch (e) {
            ta.value = html;
          }
        });
      }
      report.push(no + '=' + tas.map((t) => stripTags(t.value)).filter(Boolean).join('|'));
      return;
    }

    const hid = q.querySelector('input[id="answer' + qid + '"]');
    const read = () => (hid ? String(hid.value || '') : '');
    const isSel = (letter) => {
      const cur = read();
      if (isJudge) return cur === letter;
      if (isMulti) return cur.split('').includes(letter);
      return cur === letter;
    };
    if (want.length) {
      for (const bg of [...q.querySelectorAll('div.answerBg')]) {
        const span = bg.querySelector('span[data]');
        const letter = span ? span.getAttribute('data') : null;
        if (letter == null) continue;
        const should = want.includes(letter);
        if (should === isSel(letter)) continue;
        bg.click();
      }
      details.push({ no, want: want.join('') });
    }
    report.push(no + '=' + read());
  });
  return { ok: true, total: qs.length, verified: report.join(';'), details };
})()`;

const SUBMIT = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  try { window.focus(); } catch (e) {}
  const btn = document.querySelector('a.completeBtn, a[onclick*="submitValidate"]');
  if (!btn) return { ok: false, error: '没找到提交按钮' };
  if (!vis(btn)) { btn.scrollIntoView({ block: 'center' }); }
  btn.click();
  return { ok: true, btnClass: btn.className, btnText: (btn.textContent || '').trim() };
})()`;

const CONFIRM = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  // 优先常见弹层按钮
  const ids = ['#popok', '.popok', '.layui-layer-btn0', '#pop_ok'];
  for (const sel of ids) {
    const el = document.querySelector(sel);
    if (el && vis(el)) { el.click(); return { ok: true, via: sel, text: clean(el.textContent) }; }
  }
  const cands = [...document.querySelectorAll('a,button,span,div,input[type=button]')]
    .filter((el) => vis(el) && /^(确定|确认|确定提交|是|提交)$/.test(clean(el.textContent || el.value || '')));
  if (!cands.length) return { ok: false, error: '没看到确认按钮' };
  const el = cands[cands.length - 1];
  el.click();
  return { ok: true, via: 'text:' + clean(el.textContent || el.value), cls: el.className };
})()`;

const REVIEW = `(() => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const qs = [...document.querySelectorAll('div.questionLi')];
  const list = qs.map((q, i) => {
    const h3 = q.querySelector('h3.mark_name');
    let stem = '';
    if (h3) {
      const c = h3.cloneNode(true);
      c.querySelectorAll('span.colorShallow').forEach((n) => n.remove());
      stem = clean(c.textContent).replace(/^\\d+\\s*[.、．]\\s*/, '');
    }
    const opts = [...q.querySelectorAll('div.answerBg')].map((bg) => {
      const span = bg.querySelector('span[data]');
      const p = bg.querySelector('.answer_p') || bg;
      return { letter: span ? span.getAttribute('data') : null, text: clean(p.textContent), cls: bg.className };
    });
    const right = opts.filter((o) => /right_answer|dui|correct/i.test(o.cls)).map((o) => o.letter);
    const mine = opts.filter((o) => /check_answer|my_answer/i.test(o.cls)).map((o) => o.letter);
    return { index: i + 1, typename: q.getAttribute('typename'), stem, options: opts, correctAnswer: right.join(''), myAnswer: mine.join('') };
  });
  const t = clean(document.body ? document.body.innerText : '');
  const m = /(\\d+(?:\\.\\d+)?)\\s*分/.exec(t);
  return { ok: true, url: location.href, scoreText: m ? m[0] : null, textHead: t.slice(0, 200), questions: list };
})()`;

const VIEW = `(() => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const txt = (el) => (el ? clean(el.textContent) : '');
  const qs = [...document.querySelectorAll('div.questionLi')];
  const questions = qs.map((q, i) => {
    const h3 = q.querySelector('h3.mark_name');
    let stem = '';
    if (h3) {
      const c = h3.cloneNode(true);
      c.querySelectorAll('span.colorShallow').forEach((n) => n.remove());
      stem = clean(c.textContent).replace(/^\\d+\\s*[.、．]\\s*/, '');
    }
    const options = [...q.querySelectorAll('div.answerBg')].map((bg) => {
      const sp = bg.querySelector('span[data]');
      const p = bg.querySelector('.answer_p') || bg;
      return { letter: sp ? sp.getAttribute('data') : null, text: clean(p.textContent), cls: bg.className };
    });
    return {
      index: i + 1,
      typename: q.getAttribute('typename') || '',
      stem,
      options,
      myAnswer: txt(q.querySelector('.stuAnswerContent')),
      correctAnswer: txt(q.querySelector('.rightAnswerContent')),
      correctAnswers: [...q.querySelectorAll('.rightAnswerContent')].map((e) => clean(e.textContent)),
      myAnswers: [...q.querySelectorAll('.stuAnswerContent')].map((e) => clean(e.textContent)),
      blankCount: [...q.querySelectorAll('textarea[id^="answerEditor"]')].length,
      rightOptionLetters: options.filter((o) => /rightAnswer|right_answer/i.test(o.cls)).map((o) => o.letter),
    };
  });
  const t = clean(document.body ? document.body.innerText : '');
  const sc = /(\\d+(?:\\.\\d+)?)\\s*分/.exec(t);
  return { ok: true, url: location.href, scoreText: sc ? sc[0] : null, count: questions.length, questions };
})()`;

const REDO = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const cands = [...document.querySelectorAll('a,button,div,span')].filter((el) => {
    const oc = el.getAttribute('onclick') || '';
    const t = (el.textContent || '').trim();
    if (!vis(el)) return false;
    if (/redoWork|reDoWork/.test(oc)) return true;
    return /^重做$/.test(t) && el.children.length === 0;
  });
  if (!cands.length) return { ok: false, error: '没找到重做按钮' };
  const el = cands[cands.length - 1];
  el.click();
  return { ok: true, cls: typeof el.className === 'string' ? el.className : '', text: (el.textContent || '').trim() };
})()`;

/* ───────────── 连接与调度 ───────────── */

async function attach(tabIdx, port = 9222) {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  let target;
  if (tabIdx != null) target = pages[tabIdx];
  if (!target) target = pages.find((t) => /dowork/.test(t.url)) || pages[0];
  if (!target) throw new Error('没有可用标签页');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  return { cdp, sessionId, target, port };
}

function parseArgs(argv) {
  const out = { cmd: argv[2], tab: null, out: null, answers: null, port: 9222, submit: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tab') out.tab = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--answers') out.answers = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--submit') out.submit = true;
  }
  return out;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function main() {
  const args = parseArgs(process.argv);
  if (!args.cmd) throw new Error('用法：node tools/fanya.js extract|answer|submit|status|review');
  load(ROOT);
  const { cdp, sessionId, target } = await attach(args.tab, args.port);
  log(`标签页：${target.title} | ${target.url.slice(0, 120)}`);

  if (args.cmd === 'extract') {
    const r = await cdp.eval(sessionId, EXTRACT);
    if (!r || !r.ok) throw new Error('抽题失败：' + (r && r.error));
    const file = path.join(ROOT, args.out || 'data/questions.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: r.url, title: r.title, generated: new Date().toISOString(), count: r.count, questions: r.questions }, null, 1), 'utf8');
    log(`\n共 ${r.count} 题 → ${file}\n`);
    r.questions.forEach((q) => {
      log(`Q${q.index}【${q.typename}】${q.stem}`);
      q.options.forEach((o) => log(`    ${o.letter}. ${o.text}`));
    });
  } else if (args.cmd === 'status') {
    const r = await cdp.eval(sessionId, STATUS);
    log(JSON.stringify(r, null, 2));
  } else if (args.cmd === 'answer') {
    if (!args.answers) throw new Error('需要 --answers <文件>');
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, args.answers), 'utf8'));
    const answers = raw.answers || raw;
    const norm = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!/^\d+$/.test(String(k).trim())) continue;   // 跳过 _note 之类的注释键
      const arr = Array.isArray(v) ? v : String(v).split(/[\s,，、]+/).filter(Boolean);
      norm[String(k)] = arr.map((x) => {
        const s = String(x).trim();
        return /^(true|false)$/i.test(s) ? s.toLowerCase() : s.toUpperCase();
      });
    }
    log(`载入 ${Object.keys(norm).length} 题答案`);
    const r = await cdp.eval(sessionId, APPLY(norm));
    if (!r || !r.ok) throw new Error('作答失败：' + (r && r.error));
    const got = {};
    for (const part of String(r.verified).split(';')) {
      const i = part.indexOf('=');
      if (i > 0) got[part.slice(0, i)] = part.slice(i + 1);
    }
    let bad = 0;
    const normTxt = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').toLowerCase();
    for (const no of Object.keys(norm)) {
      const want = norm[no].join('');
      const have = got[no] || '';
      const same = normTxt(want) === normTxt(have);
      if (!same) { bad++; log(`  ! Q${no} want=${want} have=${have}`); }
    }
    log(bad ? `\n! ${bad} 题不一致` : `\n✓ ${Object.keys(norm).length} 题全部落库并校验通过`);
    const st = await cdp.eval(sessionId, STATUS);
    log(`页面：${st.total} 题，已填 ${st.filled}`);
  } else if (args.cmd === 'submit') {
    const r = await cdp.eval(sessionId, SUBMIT);
    if (!r || !r.ok) throw new Error('点提交失败：' + (r && r.error));
    log(`已点提交（${r.btnClass}）`);
    await sleep(1800);
    for (let i = 0; i < 8; i++) {
      const c = await cdp.eval(sessionId, CONFIRM).catch(() => null);
      if (c && c.ok) { log(`已确认（${c.via}）`); break; }
      await sleep(1200);
    }
    for (let i = 0; i < 15; i++) {
      await sleep(1800);
      const st = await cdp.eval(sessionId, STATUS).catch(() => null);
      if (st && !/dowork/.test(st.url || '')) { log(`已跳转：${st.url}`); break; }
      if (st && st.isReview) { log(`进入复核页，分数 ${st.scoreText}`); break; }
    }
    const st = await cdp.eval(sessionId, STATUS).catch(() => null);
    log('最终状态：' + JSON.stringify(st));
  } else if (args.cmd === 'redo') {
    const r = await cdp.eval(sessionId, REDO);
    if (!r || !r.ok) throw new Error('点重做失败：' + (r && r.error));
    log(`已点重做（${r.cls || r.text}）`);
    await sleep(1500);
    for (let i = 0; i < 8; i++) {
      const c = await cdp.eval(sessionId, CONFIRM).catch(() => null);
      if (c && c.ok) { log(`已确认（${c.via}）`); break; }
      await sleep(1200);
    }
    for (let i = 0; i < 15; i++) {
      await sleep(1800);
      const st = await cdp.eval(sessionId, STATUS).catch(() => null);
      if (st && /dowork/.test(st.url || '') && st.total > 0) {
        log(`已回到作答页：${st.total} 题，已填 ${st.filled}`);
        break;
      }
    }
  } else if (args.cmd === 'view') {
    // 如果当前是成绩页（只有「查看详情」），先点进去
    let hasDetail = await cdp.eval(sessionId, 'document.querySelectorAll(".rightAnswerContent").length > 0');
    if (!hasDetail) {
      const clicked = await cdp.eval(sessionId, `(() => {
        const b = document.querySelector('.detailBtn');
        if (b) { b.click(); return 'detailBtn'; }
        const t = [...document.querySelectorAll('a,button,div,span')]
          .find((el) => (el.textContent || '').trim() === '查看详情' && el.getBoundingClientRect().width > 0);
        if (t) { t.click(); return 'text'; }
        return null;
      })()`);
      if (clicked) {
        log(`已点「查看详情」（${clicked}），等待加载…`);
        for (let i = 0; i < 12; i++) {
          await sleep(1500);
          hasDetail = await cdp.eval(sessionId, 'document.querySelectorAll(".rightAnswerContent").length > 0').catch(() => false);
          if (hasDetail) break;
        }
      }
    }
    const r = await cdp.eval(sessionId, VIEW);
    if (!r || !r.ok) throw new Error('读详情页失败');
    const file = path.join(ROOT, args.out || 'data/view.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r, null, 1), 'utf8');
    log(`分数：${r.scoreText || '未读到'}，共 ${r.count} 题 → ${file}`);
    let wrong = 0;
    r.questions.forEach((q) => {
      const mine = q.myAnswer;
      const right = q.correctAnswer;
      const okFlag = mine && right && mine === right;
      if (!okFlag) {
        wrong++;
        log(`\nQ${q.index}【${q.typename}】✗`);
        log(`   题干：${clean(q.stem).slice(0, 80)}`);
        q.options.forEach((o) => log(`     ${o.letter}. ${o.text}${/rightAnswer/i.test(o.cls) ? '   ← 正确' : ''}${/check_answer|my_answer/i.test(o.cls) ? '   ← 我选' : ''}`));
        log(`   我的=${mine}  正确答案=${right}`);
      }
    });
    log(`\n错题 ${wrong} 题，满分 ${r.count} 题`);
  } else if (args.cmd === 'review') {
    const r = await cdp.eval(sessionId, REVIEW);
    if (!r || !r.ok) throw new Error('读复核页失败');
    log(`分数：${r.scoreText || '未读到'}`);
    r.questions.forEach((q) => {
      log(`Q${q.index}【${q.typename}】${clean(q.stem).slice(0, 60)}`);
      log(`    正确=${q.correctAnswer || '?'}  我的=${q.myAnswer || '?'}`);
    });
    fs.writeFileSync(path.join(ROOT, 'data/review-last.json'), JSON.stringify(r, null, 1), 'utf8');
    log('\n已写入 data/review-last.json');
  } else {
    throw new Error('未知子命令：' + args.cmd);
  }
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('出错了：' + e.message); process.exit(1); });
