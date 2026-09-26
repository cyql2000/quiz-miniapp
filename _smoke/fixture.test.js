// 自带合成语料的端到端验证（不依赖任何外部/有版权的数据）
// 运行：node _smoke/fixture.test.js
//
// 为什么要有这一组：
//   真实语料（行测等教辅）有版权，不能进仓库。若端到端验证只依赖仓库外的语料，
//   别人 clone 下来就跑不了、CI 也只能跳过 —— 等于没有验证。
//   fixtures/ 下那套语料由 tools/gen-fixture.js 生成，全部为公有领域素材 + 程序合成，
//   可以随仓库分发；它同时刻意覆盖了引擎要处理的每一种形态，兼作回归夹具。
//
// 三条链路各覆盖一种真实用法：
//   A 分卷题本 + 独立解析文件   → 顺序对齐（题号在分卷内重置）
//   B 单卷题本自带文末答案      → 答案区切分 + inline 答案源
//   C 单卷题本 + 聚合/单行多题  → 按题号对齐（题号全局唯一）
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');
const FIX = path.join(__dirname, '../fixtures');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: () => {}, showLoading: () => {}, hideLoading: () => {}, showModal: () => {}
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
const ok = (label, cond) => eq(label, !!cond, true);

// 把语料「喂」进沙箱（模拟用户在小程序里导入文件）
function feed(name) {
  const buf = fs.readFileSync(path.join(FIX, name));
  const tmp = '/tmp/' + name;
  fsx.files.set(tmp, buf);
  return store.importFile(tmp, { name }, name.indexOf('解析') >= 0 ? 'answer' : 'question');
}

const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const volumes = expected.questions;
const noAnswerText = volumes.filter((q) => q.type === 'text').length;   // 简答题按已知限制拿不到答案

// 逐题对照：题号、题型、答案键都要对得上
function compare(label, questions, exp) {
  const bad = [];
  exp.forEach((e, k) => {
    const got = questions[k];
    if (!got) { bad.push(`第${e.no}题缺失`); return; }
    if (String(got.no) !== String(e.no)) bad.push(`第${k + 1}位是第${got.no}题（期望${e.no}）`);
    if (e.answerKey && got.answerKey !== e.answerKey) bad.push(`第${e.no}题答案 ${got.answerKey}≠${e.answerKey}`);
    if (got.type !== e.type) bad.push(`第${e.no}题类型 ${got.type}≠${e.type}`);
  });
  eq(label, bad.slice(0, 4), []);
  return bad.length;
}

console.log('=== A. 分卷题本 + 独立解析文件（顺序对齐）===');
const qa = feed('合成题本.txt');
const aa = feed('合成解析.txt');
const ra = store.buildSet({ questionFileId: qa.id, answerFileId: aa.id, title: '合成语料' });
eq('A 分卷数', ra.parts.length, expected.chapters.length);
eq('A 总题数', ra.totalQuestions, volumes.length);
eq('A 对齐模式', ra.answerPlanMode, 'sequential');
// 简答题（无选项 + 文字答案）在顺序对齐路径下拿不到答案，这是 README 里已列明的限制；
// 除它之外每题都应有答案，否则就是对齐被打坏了。
eq('A 匹配数（总题数 − 简答题）', ra.matchedCount, volumes.length - noAnswerText);

let badTotal = 0;
ra.parts.forEach((p, i) => {
  const b = store.loadSetBundle(p.setId);
  const exp = volumes.filter((e) => e.chapter === i + 1);
  eq(`A 卷${i + 1} 题数`, b.questions.length, exp.length);
  badTotal += compare(`A 卷${i + 1} 逐题对照`, b.questions, exp);
});
eq('A 全部卷逐题无误', badTotal, 0);

// 未匹配的必须全是简答题 —— 若出现别的类型没拿到答案，说明对齐真的坏了
const unmatched = [];
ra.parts.forEach((p) => {
  store.loadSetBundle(p.setId).questions.forEach((q) => { if (!q.matched) unmatched.push(q.type); });
});
eq('A 未匹配的题型只有简答', Array.from(new Set(unmatched)).sort(), ['text']);

console.log('\n=== B. 单卷题本自带文末答案 ===');
const qb = feed('合成题本-文末答案.txt');
const rb = store.buildSet({ questionFileId: qb.id, title: '合成语料(文末)' });
eq('B 单卷', rb.parts.length, 1);
eq('B 题数', rb.totalQuestions, expected.single.length);
eq('B 匹配数', rb.matchedCount, expected.single.length);
const bb = store.loadSetBundle(rb.parts[0].setId);
compare('B 逐题对照', bb.questions, expected.single);
const setB = store.listSets().filter((s) => s.title.indexOf('文末') >= 0)[0];
eq('B 答案来源标为文末自带', setB ? setB.answerSource : '', 'inline');

console.log('\n=== C. 单卷题本 + 聚合/单行多题答案 ===');
const qc = feed('合成题本-单卷.txt');
const ac = feed('合成解析-聚合.txt');
const rc = store.buildSet({ questionFileId: qc.id, answerFileId: ac.id, title: '合成语料(聚合)' });
eq('C 题数', rc.totalQuestions, expected.single.length);
eq('C 匹配数', rc.matchedCount, expected.single.length);
eq('C 对齐模式（题号唯一 → 按题号对齐）', rc.answerPlanMode, 'numbered');
compare('C 逐题对照', store.loadSetBundle(rc.parts[0].setId).questions, expected.single);

console.log('\n=== D. 噪声形态：都不该变成题 ===');
// 语料里刻意插了这些形态，它们识别错了会直接反映为题数变多或题干被污染
const allQuestions = [];
ra.parts.forEach((p) => { store.loadSetBundle(p.setId).questions.forEach((q) => allQuestions.push(q)); });
const allStems = allQuestions.map((q) => String(q.stem)).join('\n');
ok('表格数值行没有变成题目', !/460\.6|8305\.8|2000\./.test(allStems));
ok('水印行没有混进题干', allStems.indexOf('免费公众号') < 0);
// 方法讲解块：块内的 1./2./3. 不能被切成独立题目（否则凭空多出几道「题」）。
// 块内正文当前会被并入上一题题干 —— 那是引擎的既有行为（"按正文处理"），
// 这里只守「不产生伪题」这条底线：第三章题数必须仍是 20。
eq('方法讲解块没有产生伪题（第三章题数）', store.loadSetBundle(ra.parts[2].setId).questions.length, 20);
ok('资料分析的材料块没有变成题目', allStems.indexOf('根据下列资料完成以下各题') < 0);
ok('材料块里的数字串没有变成题目', !/27302 30889/.test(allStems));

// 题干续行：行首是数字但上一行没结束 → 必须并进上一题，不能另起一题
const vol2 = store.loadSetBundle(ra.parts[1].setId).questions;
eq('第二章题数（续行没被当成新题）', vol2.length, 20);
ok('第 6 题把续行并进了题干', String(vol2[5].stem).indexOf('1.5倍') >= 0);
eq('第 6 题答案仍对得上', vol2[5].answerKey, 'B');

// 题号 + 年份开头：真题形态，必须被识别为题目（不算小数、不算表格）
const vol5 = store.loadSetBundle(ra.parts[4].setId).questions;
const yearQ = vol5.filter((q) => String(q.stem).indexOf('2021年') >= 0);
eq('「题号+年份」的真题被识别', yearQ.length, 1);
ok('「题号+年份」的题目拿到了答案', !!yearQ[0].answerKey);

console.log('\n=== D2. 答案配错时不许判错（形态自相矛盾的答案要放弃） ===');
// 场景：把单卷题本配上了另一本书的分章答案（键选错了人都会犯）。
// 顺序对齐仍会硬配 20 条，其中 4 条是判断题答案「对 / 错」——
// 盲信它们会得到「带 4 个选项的判断题」：界面照旧展示 A~D，判分却把 A 当"正确"，
// 考生选 C 永远判错。所以这类答案必须被放弃（转自评），而不是套上去。
const qx = feed('合成题本-单卷.txt');
const ax = feed('合成解析.txt');
const rx = store.buildSet({ questionFileId: qx.id, answerFileId: ax.id, title: '合成语料(错配)' });
const bx = store.loadSetBundle(rx.parts[0].setId);
const conflict = bx.questions.filter((q) => q.answerSuspectKind === 'typeConflict');
ok('错配时确实出现了形态矛盾的答案（否则本用例形同虚设）', conflict.length > 0);
eq('矛盾答案一律不带判分键', conflict.filter((q) => q.answerKey).length, 0);
eq('矛盾答案一律转自评', conflict.filter((q) => !q.answerSuspect).length, 0);
eq('矛盾答案没有被贴上判断题标签', bx.questions.filter((q) => q.type === 'judge').length, 0);

// 题本自带的文末「参考答案」区，在另配了答案解析文件时也必须切掉。
// 只切「没配答案文件」那条分支的话，整段答案速览会被当成题目：
// 一本 20 题的卷子冒出 20 道假题（题干是「1. C」这种），真题的答案还会被挤到假题身上。
const qz = feed('合成题本-文末答案.txt');
const az = feed('合成解析-聚合.txt');
const rz = store.buildSet({ questionFileId: qz.id, answerFileId: az.id, title: '合成语料(文末+外挂答)' });
eq('文末答案区没被当成题目', rz.totalQuestions, expected.single.length);
eq('文末答案区没有标题党题目', store.loadSetBundle(rz.parts[0].setId)
  .questions.filter((q) => /^\d+[.、]\s*(对|错|[A-H])\s*$/.test(String(q.stem).trim())).length, 0);

// 全局不变量：任何题目的判分键都必须落在它自己的选项里。
// （「带 4 个选项的判断题」正是这条不变量被破坏后的产物）
const allSets = [];
[ra, rb, rc, rx].forEach((r) => r.parts.forEach((p) => allSets.push(...store.loadSetBundle(p.setId).questions)));
eq('没有题的判分键落在选项之外', allSets.filter((q) => q.answerKey
  && !q.answerKey.split('').every((c) => (q.options || []).some((o) => o.key === c))).length, 0);
eq('没有「3 个以上选项的判断题」', allSets.filter((q) => q.type === 'judge' && (q.options || []).length > 2).length, 0);

console.log('\n=== E. 语料本身 ===');
const raw = fs.readFileSync(path.join(FIX, '合成题本.txt'));
ok('语料是 CRLF（与真实 OCR 语料一致）', raw.indexOf('\r\n') > 0);
ok('题本不含解析文件里的答案标记', fs.readFileSync(path.join(FIX, '合成题本.txt'), 'utf8').indexOf('【答案】') < 0);
eq('解析文件按章分段', fs.readFileSync(path.join(FIX, '合成解析.txt'), 'utf8').split('# 第').length - 1, expected.chapters.length);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
