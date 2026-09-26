// 示例题库自检：确保仓库里 samples/ 那份 demo 数据真的能用
// 运行：node _smoke/sample.test.js
//
// 为什么需要这个测试：示例数据是给别人 clone 后第一眼看到的东西，
// 它一旦失效（比如解析规则改了），整个项目的可信度就没了。
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '../miniprogram');
const SAMPLES = path.join(__dirname, '../samples');

const mem = {};
const toasts = [];
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {}
};
const wxMock = require('./lib/wx-mock.js');
const fsx = wxMock.attach(global.wx);

const store = require(path.join(BASE, 'utils/store.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

function feed(fileName) {
  const full = path.join(SAMPLES, fileName);
  if (!fs.existsSync(full)) throw new Error('示例文件缺失：' + fileName);
  const tmp = '/tmp/' + fileName;
  fsx.files.set(tmp, Buffer.from(fs.readFileSync(full, 'utf8'), 'utf8'));
  return store.importFile(tmp, { name: fileName }, 'question');
}

console.log('=== 1. 导入示例文件 ===');
const qDoc = feed('示例题库.txt');
const aDoc = feed('示例题库-解析.txt');
eq('两个文件已建档', store.listFiles().length, 2);

console.log('\n=== 2. 生成题库（应自动按章拆成 2 个） ===');
const r = store.buildSet({ questionFileId: qDoc.id, answerFileId: aDoc.id });
eq('分卷数', r.parts.length, 2);
eq('总题数', r.totalQuestions, 8);
eq('全部匹配到答案', r.matchedCount, 8);
eq('对齐模式', r.answerPlanMode, 'sequential');
eq('第一章标题', r.parts[0].title, '示例题库 · 第一章 常识判断');
eq('第二章标题', r.parts[1].title, '示例题库 · 第二章 数量关系');

console.log('\n=== 3. 逐题校验答案与题型（题号在两章内重复，必须按位置对位） ===');
const b0 = store.loadSetBundle(r.parts[0].setId);
const b1 = store.loadSetBundle(r.parts[1].setId);

eq('第一章题数', b0.questions.length, 4);
eq('第一章题号', b0.questions.map((q) => q.no), [1, 2, 3, 4]);
eq('第一章答案', b0.questions.map((q) => q.answerKey), ['B', 'B', 'A', 'ABD']);
eq('第一章题型', b0.questions.map((q) => q.type), ['single', 'single', 'judge', 'multi']);
eq('判断题自动补选项', b0.questions[2].options.map((o) => o.text), ['正确', '错误']);

eq('第二章题数', b1.questions.length, 4);
eq('第二章题号', b1.questions.map((q) => q.no), [1, 2, 3, 4]);
eq('第二章答案', b1.questions.map((q) => q.answerKey), ['C', 'A', 'AC', 'C']);
eq('第二章题型', b1.questions.map((q) => q.type), ['single', 'single', 'multi', 'single']);

console.log('\n=== 4. 解析文本已带入 ===');
eq('每题都有解析', [...b0.questions, ...b1.questions].every((q) => (q.explanation || '').length > 8), true);
eq('解析内容正确（第一章第1题）', /化石能源/.test(b0.questions[0].explanation), true);
eq('多选题答案已排序', b0.questions[3].answerKey, 'ABD');

console.log('\n=== 5. 题干与选项完整 ===');
eq('第一章第1题选项数', b0.questions[0].options.length, 4);
eq('第一章第1题题干', b0.questions[0].stem, '（2024 示例卷）下列哪一项属于可再生能源？');
eq('第一章第4题选项数', b0.questions[3].options.length, 4);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
