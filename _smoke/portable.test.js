// 导出 / 导入（备份与迁移）测试
// 运行：node _smoke/portable.test.js
//
// 关键验证点：导出后清空本机数据（模拟换设备），再导入还原；
// 并且重复导入同一份备份必须幂等（跳过已存在的题库，不产生重复）。
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: () => {}, showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  stopPullDownRefresh: () => {}
};
const wxMock = require('./lib/wx-mock.js');
const fsx = wxMock.attach(global.wx);

const db = require(path.join(BASE, 'utils/localdb.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const wrongbook = require(path.join(BASE, 'utils/wrongbook.js'));
const errata = require(path.join(BASE, 'utils/errata.js'));
const portable = require(path.join(BASE, 'utils/portable.js'));
const fsm = require(path.join(BASE, 'utils/localfs.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const Q = (no, ans) => ({
  no, stem: `第${no}题题干`, type: 'single',
  options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
  answerKey: ans, answer: '', explanation: `解析${no}`, matched: true
});

console.log('=== 1. 造两个题库（含进度 / 错题本 / 校对记录） ===');
db.saveSetBundle({
  setId: 's_alpha', title: '甲题库', matchedCount: 2, explCount: 2, createTime: 1000,
  questionFile: { name: '试题.txt' }, answerFile: { name: '解析.txt' }
}, [Q(1, 'A'), Q(2, 'B')]);
db.saveSetBundle({ setId: 's_beta', title: '乙题库', matchedCount: 1, explCount: 1, createTime: 2000 }, [Q(1, 'B')]);

progress.createState('s_alpha', '甲题库', 'order', ['1', '2']);
wrongbook.recordAnswer('s_alpha', Q(2, 'B'), { correct: false, selected: 'A', mode: 'order', title: '甲题库' });
errata.upsert('s_alpha', Q(1, 'A'), { types: ['answer'], fix: { answer: 'B' }, title: '甲题库' });
eq('两个题库已建', db.listSets().length, 2);
eq('甲有进度', !!progress.getState('s_alpha'), true);
eq('甲有错题', wrongbook.stats('s_alpha').total, 1);
eq('甲有校对', errata.stats('s_alpha').total, 1);

console.log('\n=== 2. 导出全部 ===');
const exp = portable.exportToSandbox(null, '全部');
eq('文件名可读', /^轻刷题备份-全部-\d{8}-\d{4}\.json$/.test(exp.name), true);
eq('文件已落沙箱', fsm.exists(exp.rel), true);
eq('统计·题库数', exp.summary.setCount, 2);
eq('统计·题目数', exp.summary.questionCount, 3);
eq('统计·错题数', exp.summary.wrongCount, 1);
eq('统计·校对条数', exp.summary.errataCount, 1);
console.log(`  导出文件：${exp.name}（${exp.sizeText}）`);

const payload = JSON.parse(fsm.readText(exp.rel));
eq('格式标识', payload.format, 'light-quiz-backup');
eq('版本号', payload.version, 1);
eq('含题目数据（自包含）', payload.sets[0].questions.length > 0, true);
eq('记录了源文件名', Array.isArray(payload.sets[0].sourceFiles), true);
eq('题库按创建时间倒序', payload.sets.map((s) => s.setId), ['s_beta', 's_alpha']);
eq('备份不含沙箱路径字段（换设备无意义）', payload.sets.every((s) => s.path === undefined), true);
const alpha = payload.sets.filter((s) => s.setId === 's_alpha')[0];
eq('甲题库在备份里', !!alpha, true);
eq('甲题库带错题本', Object.keys(alpha.wrongbook.items).length, 1);
eq('甲题库带校对记录', Object.keys(alpha.errata.items).length, 1);
eq('乙题库无学习记录则为 null', payload.sets.filter((s) => s.setId === 's_beta')[0].wrongbook, null);

console.log('\n=== 3. 单题库导出 ===');
const exp1 = portable.exportToSandbox(['s_beta']);
eq('只含 1 个题库', JSON.parse(fsm.readText(exp1.rel)).sets.length, 1);
eq('文件名带题库标题', /轻刷题备份-乙题库-/.test(exp1.name), true);

console.log('\n=== 4. 清空本机数据（模拟换手机 / 重装） ===');
db.clearAll();
Object.keys(mem).forEach((k) => { delete mem[k]; });
eq('题库已清空', db.listSets().length, 0);
eq('进度已清空', progress.getState('s_alpha'), null);
eq('错题本已清空', wrongbook.stats('s_alpha').total, 0);
eq('校对已清空', errata.stats('s_alpha').total, 0);
eq('备份文件仍在（不在清理范围）', fsm.exists(exp.rel), true);

console.log('\n=== 5. 读取备份并出计划 ===');
const { payload: p2, plan } = portable.readImportFile(exp.rel);
eq('可导入题库数', plan.add.length, 2);
eq('可导入题目数', plan.addQuestions, 3);
eq('可导入错题数', plan.addWrongs, 1);
eq('可导入校对条数', plan.addErrata, 1);
eq('跳过数 0', plan.skip.length, 0);
console.log('  确认文案：\n    ' + portable.planText(plan).split('\n').join('\n    '));

console.log('\n=== 6. 执行导入，校验完整还原 ===');
const r1 = portable.applyImport(p2, plan);
eq('导入数', r1.imported, 2);
eq('跳过数', r1.skipped, 0);
eq('题库已还原', db.listSets().length, 2);
eq('甲题库题数', db.loadSetBundle('s_alpha').questions.length, 2);
eq('甲题库答案完整', db.loadSetBundle('s_alpha').questions.map((q) => q.answerKey), ['A', 'B']);
eq('甲题库标题', db.getSetMeta('s_alpha').title, '甲题库');
eq('进度已还原', progress.getState('s_alpha').order, ['1', '2']);
eq('错题本已还原', wrongbook.stats('s_alpha').total, 1);
eq('错题次数保留', wrongbook.getBook('s_alpha').items['2'].wrongCount, 1);
eq('校对记录已还原', errata.stats('s_alpha').total, 1);
eq('校对修正值保留', errata.getBook('s_alpha').items['1'].fix.answer, 'B');
eq('源文件名随备份还原', db.getSetMeta('s_alpha').questionFile.name, '试题.txt');
eq('解析文件名随备份还原', db.getSetMeta('s_alpha').answerFile.name, '解析.txt');

console.log('\n=== 7. 幂等：重复导入同一份备份 ===');
const { plan: plan2 } = portable.readImportFile(exp.rel);
eq('全部进入跳过', plan2.skip.length, 2);
eq('可导入 0', plan2.add.length, 0);
const r2 = portable.applyImport(p2, plan2);
eq('实际导入 0', r2.imported, 0);
eq('题库数不变（无重复）', db.listSets().length, 2);
eq('进度未被覆盖', progress.getState('s_alpha').order, ['1', '2']);

console.log('\n=== 8. 异常备份的校验 ===');
const bad = [
  ['非 JSON', 'not json at all', /不是有效的 JSON/],
  ['格式不匹配', JSON.stringify({ format: 'other', version: 1, sets: [] }), /格式不匹配/],
  ['版本过高', JSON.stringify({ format: 'light-quiz-backup', version: 99, sets: [{}] }), /高于当前小程序支持的版本/],
  ['无题库', JSON.stringify({ format: 'light-quiz-backup', version: 1, sets: [] }), /没有题库数据/],
  ['数据不完整', JSON.stringify({ format: 'light-quiz-backup', version: 1, sets: [{ setId: 'x' }] }), /数据不完整/]
];
bad.forEach(([label, text, re]) => {
  let msg = '';
  try { portable.parsePayload(text); } catch (e) { msg = e.message; }
  eq(`${label} → 报错`, re.test(msg), true);
});

console.log('\n=== 9. 空数据导出应明确报错 ===');
db.clearAll();
Object.keys(mem).forEach((k) => { delete mem[k]; });
let emptyMsg = '';
try { portable.exportToSandbox(); } catch (e) { emptyMsg = e.message; }
eq('无题库时导出报错', /没有可导出的题库/.test(emptyMsg), true);

console.log('\n=== 10. 首页「导出/导入」处理器接线 ===');
// 这一节验证 UI 接线（数据路径、调用顺序、桩调用），不是 portable 的内部逻辑
const shared = [];
const toasts10 = [];
const modalTitles = [];
let modalAnswer = true;
const tick = () => new Promise((r) => setTimeout(r, 0));
wx.showActionSheet = (o) => { if (o.success) o.success({ tapIndex: 0 }); };
wx.shareFileMessage = (o) => { shared.push({ path: o.filePath, name: o.fileName }); if (o.success) o.success(); };
wx.saveFileToDisk = undefined; // 模拟手机端：不支持存到电脑
wx.showModal = (o) => { modalTitles.push(o.title); if (o.success) o.success({ confirm: modalAnswer }); };
wx.showToast = (o) => { toasts10.push(o.title); };

db.saveSetBundle({
  setId: 's_ui', title: 'UI题库', matchedCount: 1, explCount: 1,
  questionFile: { name: '题.txt' }, answerFile: { name: '解.txt' }
}, [Q(1, 'A')]);

let capIndex = null;
global.Page = (o) => { capIndex = o; };
global.getApp = () => ({ globalData: {} });
require(path.join(BASE, 'pages/index/index.js'));

const page = Object.assign({}, capIndex);
page.data = JSON.parse(JSON.stringify(capIndex.data));
page.setData = function (patch, cb) {
  Object.keys(patch).forEach((k) => {
    if (k.indexOf('.') < 0) { this.data[k] = patch[k]; return; }
    const seg = k.split('.');
    let o = this.data;
    for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]];
    o[seg[seg.length - 1]] = patch[k];
  });
  if (cb) cb();
};

(async () => {
  page.refresh();
  eq('首页刷新后读到题库', page.data.sets.length, 1);
  // 三块汇总数字（含存储占用）延后一个 tick 回填，为的是不占 onShow 的同步时间
  await tick();
  eq('存储占用延后回填', page.data.storage.sizeText !== '0 B', true);

  // 导出全部
  page.exportAll();
  await tick(); // 转发是 Promise，断言前要等一拍
  eq('触发了一次转发', shared.length, 1);
  eq('导出全部时文件名为「全部」', /^轻刷题备份-全部-\d{8}-\d{4}(-\d+)?\.json$/.test(shared[0].name), true);
  eq('转发路径在沙箱 exports 目录', shared[0].path.indexOf('/q_export/') >= 0, true);
  eq('成功提示带统计', /1 套 \/ 1 题/.test(toasts10[toasts10.length - 1]), true);
  // 记下本次导出的文件（不要用 listDir 猜，那里头有前面几节的旧备份）
  const exportedPath = shared[0].path;

  // 单题库导出：文件名应带题库标题，且先关掉弹层
  page.data.sheet.show = true;
  page.exportOne({ currentTarget: { dataset: { id: 's_ui' } } });
  await tick();
  eq('单库导出关闭了弹层', page.data.sheet.show, false);
  eq('单库导出文件名带标题', /^轻刷题备份-UI题库-\d{8}-\d{4}(-\d+)?\.json$/.test(shared[1].name), true);
  eq('单库与全部导出不同名', shared[0].name !== shared[1].name, true);

  // 导入：本机已存在同一题库 → 应提示「无需导入」且不重复入库
  modalTitles.length = 0;
  page.confirmImport({ path: exportedPath, name: 'backup.json' });
  eq('已存在时弹「无需导入」', modalTitles, ['无需导入']);
  eq('题库数未增加', db.listSets().length, 1);
  eq('中转临时文件已清理', fsm.listDir(fsm.DIR.tmp).length, 0);

  // 导入：清空本机后再导入，应真正入库
  db.clearAll();
  Object.keys(mem).forEach((k) => { delete mem[k]; });
  modalTitles.length = 0;
  modalAnswer = true;
  page.confirmImport({ path: exportedPath, name: 'backup.json' });
  eq('弹「确认导入」', modalTitles, ['确认导入']);
  eq('清空后导入成功', db.listSets().length, 1);
  eq('导入的题库标题正确', db.getSetMeta('s_ui').title, 'UI题库');
  eq('导入的题目答案完整', db.loadSetBundle('s_ui').questions.map((q) => q.answerKey), ['A']);
  eq('导入提示正确', toasts10[toasts10.length - 1], '已导入 1 个题库');

  // 取消导入分支
  db.clearAll();
  Object.keys(mem).forEach((k) => { delete mem[k]; });
  modalAnswer = false;
  page.confirmImport({ path: exportedPath, name: 'backup.json' });
  eq('取消后不落库', db.listSets().length, 0);

  // 非法文件
  modalAnswer = true;
  modalTitles.length = 0;
  const badPath = '/tmp/bad-backup.json';
  fsx.files.set(badPath, Buffer.from('{"format":"nope","version":1,"sets":[{}]}', 'utf8'));
  page.confirmImport({ path: badPath, name: 'bad.json' });
  eq('非法备份被拦下', modalTitles, ['无法导入']);

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
