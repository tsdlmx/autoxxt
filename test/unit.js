'use strict';
/**
 * 离线单元测试（不碰浏览器）：
 *   node test/unit.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { normalizeStem, dice, optionSimilarity } = require('../src/text');
const { KB } = require('../src/kb');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  pass++;
  console.log('✓ ' + name);
}

// ---- text ----
ok('normalizeStem 去空白与标点', normalizeStem(' 毛泽东 在《论新阶段》中指出（） ') === normalizeStem('毛泽东在论新阶段中指出'));
ok('dice 同句为 1', Math.abs(dice('马克思主义中国化', '马克思主义中国化') - 1) < 1e-9);
ok('dice 近似句 > 0.8', dice('马克思主义中国化的科学内涵', '马克思主义中国化的科学内涵是') > 0.8);
ok('dice 无关句 < 0.3', dice('马克思主义中国化', '社会主义市场经济体制') < 0.3);
ok('optionSimilarity 完全相同 = 1', Math.abs(optionSimilarity('实事求是', '实事求是') - 1) < 1e-9);

// ---- kb ----
const tmp = path.join(os.tmpdir(), 'autoxxt-test-kb-' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [] }));
const kb = new KB(tmp, { fuzzyMin: 0.82, optMin: 0.86 });

const judgeOpts = [{ letter: 'true', text: '对' }, { letter: 'false', text: '错' }];
kb.upsert({
  stem: '中国共产党从成立之日起，就明确把马克思列宁主义确立为指导思想。（）',
  type: 'judge',
  options: { true: '对', false: '错' },
  answerLetters: ['true'],
  answerTexts: ['对'],
  source: 'review',
  verified: true,
});
let hit = kb.find('中国共产党从成立之日起就明确把马克思列宁主义确立为指导思想', 'judge', judgeOpts);
ok('判断题：答案文本能跨页重映射到 true/false', hit && hit.answerLetters[0] === 'true');

// 选项顺序被打乱时仍然正确
hit = kb.find('中国共产党从成立之日起，就明确把马克思列宁主义确立为指导思想。（）', 'judge',
  [{ letter: 'false', text: '错' }, { letter: 'true', text: '对' }]);
ok('判断题：选项顺序变化后仍映射正确', hit && hit.answerLetters[0] === 'true');

// 单选：存文本、按文本回映射
kb.upsert({
  stem: '1950年到1956年中国国内的主要矛盾是（）',
  type: 'single',
  options: { A: '工人阶级同资产阶级的矛盾', B: '人民日益增长的物质文化需要同落后的社会生产之间的矛盾' },
  answerLetters: ['A'],
  answerTexts: ['工人阶级同资产阶级的矛盾'],
  source: 'llm',
  verified: false,
});
hit = kb.find('1950年到1956年中国国内的主要矛盾是', 'single',
  [{ letter: 'A', text: '人民日益增长的物质文化需要同落后的社会生产之间的矛盾' },
   { letter: 'B', text: '工人阶级同资产阶级的矛盾' }]);
ok('单选：选项打乱后按文本回映射到 B', hit && hit.answerLetters[0] === 'B');

// 模糊题干也能命中
hit = kb.find('1950 年到 1956 年，中国国内的主要矛盾是', 'single',
  [{ letter: 'A', text: '工人阶级同资产阶级的矛盾' }, { letter: 'B', text: '别的选项' }]);
ok('模糊题干可命中', hit && hit.answerLetters[0] === 'A');

// 老版本写坏的判断题条目（把「错」存成字母）在加载时被自动修正
fs.writeFileSync(tmp, JSON.stringify({
  version: 1,
  entries: [{
    key: KB.key('马克思主义经典作家没有说过的就不能说，这不是马克思主义的态度。（）'),
    stem: '马克思主义经典作家没有说过的就不能说，这不是马克思主义的态度。（）',
    type: 'judge', options: {}, answerLetters: ['错'], answerTexts: [''], verified: true,
  }],
}));
const kb2 = new KB(tmp, {});
hit = kb2.find('马克思主义经典作家没有说过的就不能说这不是马克思主义的态度', 'judge', judgeOpts);
ok('老题库自动迁移：错 -> false', hit && hit.answerLetters[0] === 'false');

fs.unlinkSync(tmp);
console.log(`\n全部通过（${pass} 项）`);
