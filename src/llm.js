'use strict';
/**
 * LLM 判题（OpenAI 兼容接口）。
 * 支持 DeepSeek / 通义 / 智谱 / OpenAI / Ollama / vLLM 等任何 chat/completions 端点。
 */

const SYSTEM_PROMPT = [
  '你是一位严谨的高校思政课教师，负责给《毛泽东思想和中国特色社会主义理论体系概论》等课程的章节测验判题。',
  '要求：',
  '1. 依据教材（2023 年版马工程教材）的规范表述作答，不要凭感觉。',
  '2. 单选题只有一个正确项；多选题可能 2-4 个正确项，必须选全，也不多选；判断题只有对/错。',
  '3. 只输出 JSON，不要解释，不要 markdown 代码块。',
].join('\n');

function buildUserPrompt(batch) {
  const lines = [];
  lines.push('请为下面每道题给出正确答案，输出格式为严格的 JSON 数组：');
  lines.push('[{"no":1,"answer":["B"]},{"no":2,"answer":["A","C","D"]},{"no":3,"answer":["true"]}]');
  lines.push('多选题 answer 放多个字母；判断题 answer 只能是 ["true"] 或 ["false"]（true=对，false=错）。');
  lines.push('');
  for (const q of batch) {
    lines.push(`【第 ${q.no} 题】${q.type === 'multi' ? '多选题' : q.type === 'judge' ? '判断题' : '单选题'}`);
    lines.push(q.stem);
    for (const o of q.options) {
      lines.push(`  ${o.letter}. ${o.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function extractJson(text) {
  if (!text) throw new Error('LLM 返回为空');
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error('LLM 返回里没有 JSON');
  // 截取到配对的最后一个括号
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('LLM 返回的 JSON 不完整');
  return JSON.parse(s.slice(start, end));
}

async function chat(cfg, messages, { timeoutMs = 120000 } = {}) {
  const base = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages,
    temperature: cfg.temperature == null ? 0 : cfg.temperature,
    stream: false,
  };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (cfg.apiKey || ''),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('LLM 没有返回内容：' + text.slice(0, 300));
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} cfg { baseUrl, apiKey, model, batch }
 * @param {Array} questions [{ no, type, stem, options:[{letter,text}] }]
 * @returns {Promise<Object>} { 题号: [字母] }
 */
async function answerQuestions(cfg, questions, log = () => {}) {
  const batchSize = Math.max(1, Math.min(25, cfg.batch || 10));
  const out = {};
  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const content = await chat(cfg, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(batch) },
        ]);
        const arr = extractJson(content);
        const list = Array.isArray(arr) ? arr : arr.answers || arr.result || [];
        for (const item of list) {
          const no = Number(item.no != null ? item.no : item.index);
          let ans = item.answer != null ? item.answer : item.answers;
          if (typeof ans === 'string') ans = ans.split(/[\s,，、]+/).filter(Boolean);
          if (!Array.isArray(ans)) continue;
          const letters = ans
            .map((x) => String(x).trim().toUpperCase())
            .map((x) => (x === 'TRUE' || x === 'T' || x === '对' ? 'true' : x === 'FALSE' || x === 'F' || x === '错' ? 'false' : x))
            .filter(Boolean);
          if (letters.length) out[no] = letters;
        }
        log(`  LLM 批次 ${Math.floor(i / batchSize) + 1}：${list.length}/${batch.length} 题返回`);
        break;
      } catch (e) {
        if (attempt >= (cfg.retries == null ? 3 : cfg.retries)) {
          log(`  ! LLM 批次失败（已重试 ${attempt} 次）：${e.message}`);
          break;
        }
        log(`  ! LLM 批次出错，重试中：${e.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return out;
}

module.exports = { answerQuestions, chat };
