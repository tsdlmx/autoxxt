#!/usr/bin/env node
'use strict';
/**
 * 老版「章节测验」作答驱动（mooc1 章节内 work 页，顶层 .TiMu）。
 * 复用仓库自带的 font 注入破解混淆字体；extract/answer 用本文件（不钻 iframe）。
 *
 *   node tools/qold.js --port 9223 extract --out data/quiz1.json
 *   node tools/qold.js --port 9223 answer --answers data/quiz1-answers.json
 *   node tools/qold.js --port 9223 submit
 */
const fs = require('fs');
const path = require('path');
const { CDP } = require('../src/cdp');
const X = require('../src/chaoxing');
const { decodeDeep } = require('../src/text');

const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPE_NAME = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };

function parseArgs(argv) {
  const out = { cmd: argv[2], port: 9223, tab: null, out: null, answers: null };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--tab') out.tab = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--answers') out.answers = argv[++i];
  }
  return out;
}

const EXTRACT = `(() => {
  const clean = (s) => (s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const timus = [...document.querySelectorAll('.TiMu')];
  if (!timus.length) return { ok: false, error: 'no .TiMu' };
  const out = timus.map((mu, i) => {
    const typeEl = mu.querySelector('.newZy_TItle');
    const typeText = clean(typeEl ? typeEl.innerText : '');
    let type = 'single';
    if (/多选/.test(typeText)) type = 'multi';
    else if (/判断/.test(typeText)) type = 'judge';
    else if (/填空/.test(typeText)) type = 'fill';
    const titleEl = mu.querySelector('.Zy_TItle');
    let stem = '';
    if (titleEl) {
      const c = titleEl.cloneNode(true);
      c.querySelectorAll('.newZy_TItle').forEach((n) => n.remove());
      c.querySelectorAll('i').forEach((n) => { if (/^\\d+$/.test(clean(n.innerText))) n.remove(); });
      stem = clean(c.textContent);
    }
    const options = [...mu.querySelectorAll('li')].map((li) => {
      const sp = li.querySelector('span[data]');
      const a = li.querySelector('a.after') || li.querySelector('a');
      return { letter: sp ? sp.getAttribute('data') : null, text: clean(a ? a.innerText : li.innerText) };
    }).filter((o) => o.letter != null);
    const inputs = [...mu.querySelectorAll('input, textarea')]
      .filter((el) => el.type !== 'hidden')
      .map((el) => ({ tag: el.tagName, type: el.type, id: el.id, name: el.name, value: el.value }));
    const hid = mu.querySelector('input[name^="answer"]:not([name^="answertype"])');
    return { index: i + 1, qid: hid ? (hid.name || '').replace(/^answer/, '') : '', type, typeLabel: typeText, stem, options, filled: hid ? hid.value : '', inputs };
  });
  return { ok: true, url: location.href, title: document.title, count: out.length, questions: out };
})()`;

const CLICK_ONE = (qIdx, letter) => `(() => {
  const mu = [...document.querySelectorAll('.TiMu')][${qIdx - 1}];
  if (!mu) return { ok: false, error: 'no q' + ${qIdx} };
  const li = [...mu.querySelectorAll('li')].find((el) => {
    const sp = el.querySelector('span[data]');
    return sp && sp.getAttribute('data') === ${JSON.stringify(letter)};
  });
  if (!li) return { ok: false, error: 'no option ' + ${JSON.stringify(letter)} };
  li.scrollIntoView({ block: 'center' });
  const r = li.getBoundingClientRect();
  const cls = li.className || '';
  return {
    ok: true,
    x: Math.round(r.left + Math.min(r.width / 2, 60)),
    y: Math.round(r.top + r.height / 2),
    selected: /check_answer|selected|active/.test(cls) || li.getAttribute('aria-checked') === 'true',
    cls,
  };
})()`;

const VERIFY = `(() => {
  const timus = [...document.querySelectorAll('.TiMu')];
  return timus.map((mu, i) => {
    const hid = mu.querySelector('input[name^="answer"]:not([name^="answertype"])');
    return (i + 1) + '=' + (hid ? String(hid.value || '') : '');
  }).join(';');
})()`;

const FILL = (no, text) => `(() => {
  const mu = [...document.querySelectorAll('.TiMu')][${no} - 1];
  if (!mu) return { ok: false, error: 'no question ' + ${no} };
  const txt = mu.querySelector('textarea');
  if (!txt) return { ok: false, error: 'no textarea' };
  const val = ${JSON.stringify(text)};
  try {
    if (window.UE && typeof UE.getEditor === 'function') {
      const ed = UE.getEditor(txt.id);
      if (ed && ed.setContent) { ed.setContent(val); return { ok: true, via: 'UE', id: txt.id }; }
    }
  } catch (e) {}
  txt.value = val;
  txt.dispatchEvent(new Event('input', { bubbles: true }));
  txt.dispatchEvent(new Event('change', { bubbles: true }));
  txt.dispatchEvent(new Event('keyup', { bubbles: true }));
  return { ok: true, via: 'textarea', id: txt.id };
})()`;

const SUBMIT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
  const cands = [...document.querySelectorAll('a,button,div,span,input[type=button]')]
    .filter((el) => vis(el) && /^(提交|交卷|提交作业|确定提交)$/.test(clean(el.textContent || el.value || '')));
  if (!cands.length) {
    const btn = document.querySelector('#btnSubmit, a[onclick*="submit"], a[onclick*="Submit"], .completeBtn');
    if (btn) { btn.click(); return { ok: true, via: 'selector:' + (btn.className || btn.id) }; }
    return { ok: false, error: '没找到提交按钮' };
  }
  const el = cands[cands.length - 1];
  el.click();
  return { ok: true, via: 'text:' + clean(el.textContent) };
})()`;

const CONFIRM = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none'; };
  for (const sel of ['#popok', '.popok', '.layui-layer-btn0', '.conform', '#confirmBtn']) {
    const el = document.querySelector(sel);
    if (el && vis(el)) { el.click(); return { ok: true, via: sel }; }
  }
  const cands = [...document.querySelectorAll('a,button,span,div,input[type=button]')]
    .filter((el) => vis(el) && /^(确定|确认|是|好的)$/.test(clean(el.textContent || el.value || '')));
  if (!cands.length) return { ok: false, error: '无确认按钮' };
  cands[cands.length - 1].click();
  return { ok: true, via: 'text' };
})()`;

async function main() {
  const args = parseArgs(process.argv);
  const pages = (await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json())
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  const target = args.tab != null ? pages[args.tab] : (pages.find((t) => /doHomeWorkNew/.test(t.url)) || pages[0]);
  if (!target) throw new Error('没有可用标签页');
  log('标签：' + target.title + ' | ' + target.url.slice(0, 100));

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const ctx = { cdp, sessionId, target };

  if (args.cmd === 'extract') {
    const r = await cdp.eval(sessionId, EXTRACT);
    if (!r || !r.ok) throw new Error('抽题失败：' + (r && r.error));
    const sampleText = r.questions.map((q) => q.stem + q.options.map((o) => o.text).join('')).join('');
    let font = { map: null };
    try {
      const f = await X.runInject(ctx, 'font', { sampleText });
      if (f && f.ok) { font = f; log('字体破解：' + f.count + ' 字，平均相似度 ' + f.avgSim + '，哈希 ' + f.hash); }
      else log('字体：' + (f && f.error));
    } catch (e) { log('字体注入失败：' + e.message); }
    const questions = decodeDeep(r.questions, font.map);
    const file = path.join(ROOT, args.out || 'data/quiz.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: r.url, title: r.title, count: r.count, questions }, null, 1), 'utf8');
    log('\n共 ' + questions.length + ' 题 → ' + file + '\n');
    questions.forEach((q) => {
      log('Q' + q.index + '【' + (TYPE_NAME[q.type] || q.type) + '】' + q.stem);
      q.options.forEach((o) => log('    ' + o.letter + '. ' + o.text));
      if (q.inputs && q.inputs.length) log('    输入框：' + JSON.stringify(q.inputs.map((i) => i.tag + '#' + i.id)));
    });
  } else if (args.cmd === 'answer') {
    if (!args.answers) throw new Error('需要 --answers');
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, args.answers), 'utf8'));
    const answers = raw.answers || raw;
    const norm = {};
    for (const [k, v] of Object.entries(answers)) {
      if (!/^\d+$/.test(k)) continue;
      const arr = Array.isArray(v) ? v : String(v).split(/[\s,，、]+/).filter(Boolean);
      norm[k] = arr.map((x) => { const s = String(x).trim(); return /^(true|false)$/i.test(s) ? s.toLowerCase() : s.toUpperCase(); });
    }
    await cdp.bringToFront(sessionId).catch(() => {});

    // 填空优先（UEditor）
    for (const [no, letters] of Object.entries(norm)) {
      const joined = letters.join('');
      if (/[\u4e00-\u9fa5]/.test(joined)) {
        const r = await cdp.eval(sessionId, FILL(Number(no), joined)).catch((e) => ({ ok: false, error: e.message }));
        log('填空 Q' + no + '：' + JSON.stringify(r));
      }
    }

    const plan = await cdp.eval(sessionId, PLAN);
    let clicked = 0;
    for (const q of plan || []) {
      const want = norm[String(q.index)] || [];
      if (!want.length) continue;
      for (const o of q.opts) {
        const should = want.includes(String(o.letter));
        if (should === o.selected) continue;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', clickCount: 1 }, sessionId);
        clicked++;
        await sleep(250);
      }
    }
    log('已点击 ' + clicked + ' 次');

    const verified = await cdp.eval(sessionId, VERIFY);
    const got = {};
    for (const part of String(verified).split(';')) { const i = part.indexOf('='); if (i > 0) got[part.slice(0, i)] = part.slice(i + 1); }
    let bad = 0;
    const checks = Object.keys(norm).filter((no) => !/[\u4e00-\u9fa5]/.test(norm[no].join('')));
    for (const no of checks) {
      const want = norm[no].join('');
      const have = got[no] || '';
      if (want.toLowerCase() !== have.toLowerCase()) { bad++; log('  ! Q' + no + ' want=' + want + ' have=' + have); }
    }
    log(bad ? '! ' + bad + ' 题不一致' : '✓ ' + checks.length + ' 道客观题落库校验通过');
  } else if (args.cmd === 'submit') {
    const r = await cdp.eval(sessionId, SUBMIT);
    log('提交：' + JSON.stringify(r));
    await sleep(1500);
    for (let i = 0; i < 6; i++) {
      const c = await cdp.eval(sessionId, CONFIRM).catch(() => null);
      if (c && c.ok) { log('确认：' + c.via); break; }
      await sleep(1200);
    }
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      const u = await cdp.eval(sessionId, 'location.href').catch(() => '');
      const t = await cdp.eval(sessionId, 'document.body ? document.body.innerText.replace(/\\s+/g," ").slice(0,200) : ""').catch(() => '');
      if (!/doHomeWorkNew/.test(u) || /分数|得分|提交成功|已完成/.test(t)) { log('结果页：' + u.slice(0, 120)); log(t); break; }
    }
  } else {
    throw new Error('未知子命令：' + args.cmd);
  }
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
