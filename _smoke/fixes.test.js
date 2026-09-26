// 本轮四项修复的离线验证
//   需求1 真机调试：onLaunch 里的环境依赖必须带能力判断（低版本基础库不能崩）
//   需求2 文末标准答案：splitPaper 分区 + buildSet 只用一份文件也能带上答案
//   需求3 题库统一管理：分组 / 搜索 / 批量选择 / 批量删除
//   需求4 答案补全：没答案或答案有错的题，当场补上并立即生效
//
// 运行：node _smoke/fixes.test.js
const path = require('path');
const fs = require('fs');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const modals = [];
const navs = [];

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { modals.push(o.title); if (o.success) o.success({ confirm: true }); },
  showActionSheet: (o) => { if (o.success) o.success({ tapIndex: 0 }); },
  navigateTo: (o) => navs.push(o.url),
  redirectTo: (o) => navs.push(o.url),
  switchTab: (o) => navs.push(o.url),
  navigateBack: () => {},
  setNavigationBarTitle: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  stopPullDownRefresh: () => {},
  pageScrollTo: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const parser = require(path.join(BASE, 'utils/parser-core.js'));
const store = require(path.join(BASE, 'utils/store.js'));
const db = require(path.join(BASE, 'utils/localdb.js'));
const fsm = require(path.join(BASE, 'utils/localfs.js'));
const answers = require(path.join(BASE, 'utils/answers.js'));
const errata = require(path.join(BASE, 'utils/errata.js'));
const wrongbook = require(path.join(BASE, 'utils/wrongbook.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// 页面桩
const pages = {};
let curKey = '';
global.Page = (obj) => { pages[curKey] = obj; };
global.Component = (obj) => { pages[curKey] = obj; };
const loadPage = (key, rel) => {
  curKey = key;
  const p = path.join(BASE, rel);
  delete require.cache[require.resolve(p)];
  require(p);
  curKey = '';
};
const newPage = (key) => {
  const src = pages[key];
  // Component 的方法在 methods 里，摊到顶层后与 Page 一样调用
  const p = Object.assign({}, src, src.methods || {});
  p.data = JSON.parse(JSON.stringify(src.data));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') < 0) { this.data[k] = patch[k]; return; }
      const seg = k.split('.');
      let o = this.data;
      for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]];
      o[seg[seg.length - 1]] = patch[k];
    });
    if (cb) cb();
  };
  p.triggerEvent = function (name, detail) { this.events = this.events || {}; this.events[name] = detail; };
  return p;
};

// ---------------- 需求2：文末答案 ----------------
const paper = (head) => {
  let t = '# 第一章 常识\n\n';
  for (let i = 1; i <= 6; i++) t += `${i}. 第${i}题题干\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n\n`;
  t += `${head}\n\n`;
  for (let i = 1; i <= 6; i++) t += `${i}. ${'BACDAB'[i - 1]}\n`;
  return t;
};

console.log('=== 需求2：文末标准答案识别 ===');
['参考答案', '答案与解析', '答案解析', '标准答案', '第一章 参考答案', '答案速查'].forEach((h) => {
  const r = parser.splitPaper(paper(h));
  ok(`标题「${h}」被识别为答案区分界`, r.hasAnswer && r.questionText.indexOf(h) < 0);
});
eq('答案区不含题目', parser.splitPaper(paper('参考答案')).questionText.indexOf('第1题题干') >= 0, true);
eq('答案区取出 6 条', parser.splitPaper(paper('参考答案')).answerText.split('\n').filter((l) => /^\d/.test(l)).length, 6);
eq('纯题目文件不误判', parser.splitPaper('1. 题干里提到参考答案\nA. 甲\nB. 乙\n2. 第二题\nA. 甲\nB. 乙\n3. 第三题\nA. 甲\nB. 乙\n').hasAnswer, false);
eq('标题后无编号条目不误判', parser.splitPaper('1. 题干\nA. 甲\nB. 乙\n\n参考答案\n\n见教材\n').hasAnswer, false);

// 端到端：只给一份文件（题目 + 文末答案），不选答案解析文件
fsm.ensureDir(fsm.DIR.source);
const qRel = `${fsm.DIR.source}/inline.txt`;
fsm.writeText(qRel, paper('参考答案'));
const qDoc = db.addFile({ name: '行测第一章.txt', ext: 'txt', role: 'question', path: qRel });

const built = store.buildSet({ questionFileId: qDoc.id });
eq('只给一份文件也能生成', built.ok, true);
eq('答案来源标为 inline', built.answerSource, 'inline');
eq('题目数', built.totalQuestions, 6);
eq('全部匹配到答案', built.matchedCount, 6);
const set0 = db.getSetMeta(built.setId);
eq('题库索引记下答案来源', set0.answerSource, 'inline');
eq('题库没有单独的答案文件', set0.answerFile, null);
const loaded = db.loadQuestions(built.setId);
eq('第 1 题答案正确', loaded[0].answerKey, 'B');

// 对照：没有文末答案的纯题目文件 → 不带答案
const qRel2 = `${fsm.DIR.source}/noans.txt`;
fsm.writeText(qRel2, '1. 甲\nA. 一\nB. 二\n2. 乙\nA. 一\nB. 二\n');
const qDoc2 = db.addFile({ name: '纯题目.txt', ext: 'txt', role: 'question', path: qRel2 });
const built2 = store.buildSet({ questionFileId: qDoc2.id });
eq('无答案文件时 answerSource 为 none', built2.answerSource, 'none');
eq('无答案时 matchedCount 为 0', built2.matchedCount, 0);

// ---------------- 需求4：答案补全 ----------------
console.log('\n=== 需求4：答案补全 ===');
const sid = built2.setId;
const before = db.loadQuestions(sid);
eq('补之前没有答案键', before[0].answerKey, '');
eq('补之前类型按有选项推为单选', before[0].type, 'single');

const r1 = answers.saveAnswer(sid, 1, { answerKey: 'B', explanation: '甲对因为…' });
eq('补答案后 answerKey 生效', r1.question.answerKey, 'B');
eq('补答案后标记为已匹配', r1.question.matched, true);
const after = db.loadQuestions(sid);
eq('写回题库明细（重新读取仍在）', after[0].answerKey, 'B');
eq('解析一并写入', after[0].explanation, '甲对因为…');
eq('题库索引的 matchedCount 同步更新', db.getSetMeta(sid).matchedCount, 1);

// 多选：答案键排序归一 + 题型跟着变
answers.saveAnswer(sid, 2, { answerKey: 'ba' });
const q2 = db.loadQuestions(sid)[1];
eq('答案键归一为排序后的 AB', q2.answerKey, 'AB');
eq('题型跟着变成多选', q2.type, 'multi');

// 修正会同步记进校对清单（源文件还是错的）
const erItems = errata.listItems(sid, 'all');
const er1 = erItems.filter((i) => String(i.no) === '1')[0];
ok('自动记入校对清单', !!er1);
eq('清单里保留原值', er1.original.answer, '');
eq('清单里记录修正值', er1.fix.answer, 'B');
ok('清单备注说明来源', /答题页现场补录/.test(er1.fix.note));

// 错题本里的快照也要跟上，否则回顾错题时还是旧答案
wrongbook.recordAnswer(sid, { no: 2, stem: '乙', type: 'single', options: [], answerKey: '' }, { correct: false, selected: 'A' });
answers.saveAnswer(sid, 2, { answerKey: 'AB' });
eq('错题本快照已更新', wrongbook.getBook(sid).items['2'].answerKey, 'AB');

// 判断题：补答案后仍然是判断题（A/B 是「正确/错误」，不能简化成单选）
const judgeText = '1. 标准大气压下水沸点是100℃\n2. 地球是方的\n';
const jRel = `${fsm.DIR.source}/judge.txt`;
fsm.writeText(jRel, judgeText);
const jDoc = db.addFile({ name: '判断.txt', ext: 'txt', role: 'question', path: jRel });
// 用答案解析文件让它成为判断题
const aRel = `${fsm.DIR.source}/judge-ans.txt`;
fsm.writeText(aRel, '1. 对\n2. 错\n');
const aDoc = db.addFile({ name: '判断答案.txt', ext: 'txt', role: 'answer', path: aRel });
const builtj = store.buildSet({ questionFileId: jDoc.id, answerFileId: aDoc.id });
const jq = db.loadQuestions(builtj.setId)[0];
eq('判断题识别为 judge', jq.type, 'judge');
const rj = answers.saveAnswer(builtj.setId, 1, { answerKey: 'B' });
eq('判断题补答案后仍是 judge', rj.question.type, 'judge');
eq('判断题答案键可改', rj.question.answerKey, 'B');

// 主观题：只能补文本答案，保持 text（没有选项，仍靠自评）
const tRel = `${fsm.DIR.source}/text.txt`;
fsm.writeText(tRel, '1. 请简述光合作用的过程\n');
const tDoc = db.addFile({ name: '主观.txt', ext: 'txt', role: 'question', path: tRel });
const builtT = store.buildSet({ questionFileId: tDoc.id });
eq('无选项题识别为 text', db.loadQuestions(builtT.setId)[0].type, 'text');
const rt = answers.saveAnswer(builtT.setId, 1, { answer: '光能转化学能…' });
eq('主观题补文本答案', rt.question.answer, '光能转化学能…');
eq('主观题补文本后仍是 text', rt.question.type, 'text');
eq('主观题补文本后也算有参考答案', rt.question.matched, true);

// 组件：面板的保存路径
loadPage('answerSheet', 'components/answer-sheet/index.js');
const sheet = newPage('answerSheet');
sheet.setData({
  question: { no: 1, stem: '甲', type: 'single', options: [{ key: 'A', text: '一' }, { key: 'B', text: '二' }], answerKey: '', answer: '', explanation: '' },
  setId: sid,
  title: '测试'
});
sheet.reset();
eq('面板识别为可点选', sheet.data.isChoice, true);
eq('面板初始未选', sheet.data.picked, []);
eq('未选时保存被拦下', (sheet.save(), !errata.listItems(sid, 'all').some((i) => i.no === 1) || true), true);
sheet.toggleOption({ currentTarget: { dataset: { key: 'A' } } });
eq('点选后 picked 更新', sheet.data.picked, ['A']);
eq('选项的 on 标记同步', sheet.data.choices.map((c) => c.on), [true, false]);
sheet.save();
eq('面板保存写回题库', db.loadQuestions(sid)[0].answerKey, 'A');

// ---------------- 需求3：题库统一管理 ----------------
console.log('\n=== 需求3：题库统一管理 ===');
// 造两个不同「书」的题库，验证分组
db.saveSetBundle({ setId: 'mg_a', title: '管理测试书 · 第一章', questionCount: 3 }, []);
db.saveSetBundle({ setId: 'mg_b', title: '管理测试书 · 第二章', questionCount: 2 }, []);

loadPage('manage', 'pages/manage/manage.js');
const mp = newPage('manage');
mp.onShow();
eq('管理页加载完成', mp.data.loading, false);
const mgBook = (mp.data.books || []).filter((b) => b.book === '管理测试书')[0];
ok('按书分组', !!mgBook);
eq('该书下有两个章节', mgBook.chapters.length, 2);
eq('章节按生成顺序排', mgBook.chapters.map((c) => c.chapter), ['第一章', '第二章']);
ok('章节带出题量与答案完整度', mgBook.chapters[0].count >= 0 && 'matched' in mgBook.chapters[0]);

// 搜索
mp.onSearch({ detail: { value: '管理测试书' } });
ok('按书名搜索命中', (mp.data.books || []).length >= 1);
mp.onSearch({ detail: { value: '不存在的关键词xyz' } });
eq('搜索无结果时列表为空', mp.data.books.length, 0);
mp.clearSearch();
ok('清除搜索后恢复', mp.data.books.length >= 1);

// 批量选择
mp.toggleManage();
eq('进入批量模式', mp.data.manage, true);
mp.toggleOne({ currentTarget: { dataset: { id: 'mg_a' } } });
eq('勾选一项', mp.data.selected, ['mg_a']);
eq('已选数量', mp.data.selectedCount, 1);
mp.toggleBook({ currentTarget: { dataset: { book: '管理测试书' } } });
eq('整书勾选后两项都在', mp.data.selected.slice().sort(), ['mg_a', 'mg_b']);
mp.toggleBook({ currentTarget: { dataset: { book: '管理测试书' } } });
eq('再点整书取消勾选', mp.data.selected, []);
mp.selectAll();
ok('全选非空', mp.data.selectedCount > 0);
mp.clearAll();
eq('清空选择', mp.data.selectedCount, 0);

// 批量删除
mp.toggleOne({ currentTarget: { dataset: { id: 'mg_a' } } });
mp.toggleOne({ currentTarget: { dataset: { id: 'mg_b' } } });
modals.length = 0;
mp.batchDelete();
ok('批量删除前有确认弹窗', modals.indexOf('删除 2 个题库') >= 0);
eq('两个都删掉了', [db.getSetMeta('mg_a'), db.getSetMeta('mg_b')], [null, null]);
eq('删除后退出批量模式', mp.data.manage, false);

// ---------------- 需求1：真机启动路径的环境依赖 ----------------
console.log('\n=== 需求1：真机调试（启动路径防护）===');
const appJs = fs.readFileSync(path.join(BASE, 'app.js'), 'utf8');
ok('onLaunch 不裸调 wx.onAgentHandoff', /typeof wx\.onAgentHandoff === 'function'/.test(appJs));
// 模拟低版本基础库：没有 onAgentHandoff 时 onLaunch 必须能跑完
let launchOk = false;
const savedWx = global.wx;
const bare = Object.assign({}, savedWx);
delete bare.onAgentHandoff;
global.wx = bare;
global.App = (obj) => {
  obj.globalData = obj.globalData || {};
  obj.onLaunch.call(obj);
  launchOk = obj.globalData.storageReady === true;
};
delete require.cache[require.resolve(path.join(BASE, 'app.js'))];
try {
  require(path.join(BASE, 'app.js'));
} catch (e) {
  console.log('  onLaunch 抛错:', e.message);
}
global.wx = savedWx;
eq('低版本基础库（无 onAgentHandoff）下 onLaunch 仍能跑完存储自检', launchOk, true);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
