// 校对功能集成测试（数据层 + 组件 + 答题页 + 清单页，模拟 wx / Page / Component）
// 运行：node _smoke/errata.test.js
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const routes = [];
const events = [];
const clipboard = [];
const modals = [];
let modalConfirm = true;

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { modals.push(o); if (o.success) o.success({ confirm: modalConfirm }); },
  navigateTo: (o) => routes.push(o.url),
  redirectTo: (o) => routes.push(o.url),
  switchTab: (o) => routes.push(o.url),
  navigateBack: () => {},
  setNavigationBarTitle: () => {},
  stopPullDownRefresh: () => {},
  setClipboardData: (o) => { clipboard.push(o.data); if (o.success) o.success(); }
};
global.getApp = () => ({ globalData: {} });

// 本地化改造后：题库明细从沙箱文件读取（原先桩的是 getSet 云函数）
const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

// 布局测量桩：面板正文区高度靠 createSelectorQuery 量「标题 / 副标题 / 内容自然高」算出来，
// 这里给个按选择器返回预设尺寸的假查询器，够验算高度公式即可（改 rects 就能模拟各种内容高度）。
let rects = {};
const sysInfo = { windowWidth: 375, windowHeight: 800, safeArea: { bottom: 780 } };
global.wx.getSystemInfoSync = () => Object.assign({}, sysInfo);
global.wx.createSelectorQuery = () => {
  const picked = [];
  const q = {
    in: () => q,
    select: (sel) => { picked.push(sel); return q; },
    boundingClientRect: () => q,
    exec: (cb) => {
      cb(picked.map((s) => (s in rects ? Object.assign({ height: 0, top: 0 }, rects[s]) : null)));
    }
  };
  return q;
};

const localdb = require(path.join(BASE, 'utils/localdb.js'));
localdb.saveSetBundle({ setId: 's1', title: '题库一' }, [
  { no: 1, stem: '题干一', type: 'single', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKey: 'B', explanation: '解析一', matched: true },
  { no: 2, stem: '题干二', type: 'single', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKey: 'A', explanation: '解析二', matched: true },
  // 第 12 题：面板保存要把改动写回题库明细，得有一道真题目才验得了
  { no: 12, stem: '题干原文', type: 'single', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKey: 'C', explanation: '原解析', matched: true }
]);

const errata = require(path.join(BASE, 'utils/errata.js'));
const tick = () => new Promise((r) => setTimeout(r, 0));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

function newInstance(cfg, extra) {
  const inst = Object.assign({}, cfg.methods || cfg);
  inst.data = Object.assign({}, cfg.data || {}, extra || {});
  inst.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
    if (cb) cb();
  };
  inst.triggerEvent = function (name, detail) { events.push([name, detail]); };
  return inst;
}

(async () => {
  // ================= 1. 数据层 =================
  const Q = { no: 12, stem: '题干原文', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answerKey: 'C', explanation: '原解析' };
  const rec = errata.upsert('s1', Q, {
    types: ['answer'],
    fix: { answer: 'D', note: '与书末速览不符' },
    title: '题库一'
  });
  eq('原值快照·答案', rec.original.answer, 'C');
  eq('原值快照·选项', rec.original.options, 'A. 甲\nB. 乙');
  eq('修正值', rec.fix.answer, 'D');
  eq('类型标签', rec.typeLabels, ['答案有误']);
  eq('有实际改动', rec.changed, true);
  eq('默认待修', rec.pending, true);

  // 只勾类型不改内容 → 不算改动
  errata.upsert('s1', { no: 15, stem: '题干十五' }, { types: ['image'], fix: {}, title: '题库一' });
  eq('未改内容不计改动', errata.listItems('s1', 'all').find((i) => i.no === '15').changed, false);

  // 题库隔离与聚合
  errata.upsert('s2', { no: 3, stem: '题干三', answerKey: 'A' }, { types: ['stem'], fix: { stem: '题干三（改）' }, title: '题库二' });
  eq('全部待修', errata.summary().open, 3);
  eq('涉及题库数', errata.summary().sets, 2);
  eq('s1 待修', errata.stats('s1').open, 2);
  eq('listBooks 命中', errata.listBooks().length, 2);

  // 导出文本
  const txt = errata.exportText('s1');
  eq('导出含原值', txt.includes('答案 原：C'), true);
  eq('导出含修正', txt.includes('答案 改：D'), true);
  eq('导出含备注', txt.includes('备注：与书末速览不符'), true);
  eq('导出含题号头', txt.includes('【题号 12】答案有误'), true);

  // 状态流转 / 删除
  errata.setStatus('s1', 12, 'fixed');
  eq('标记已修', errata.stats('s1').open, 1);
  eq('已修筛选', errata.listItems('s1', 'fixed').map((i) => i.no), ['12']);
  errata.setStatus('s1', 12, 'open');
  eq('回退待修', errata.stats('s1').open, 2);
  errata.removeItem('s1', 15);
  eq('删除单条', errata.stats('s1').total, 1);
  errata.removeItem('s2', 3);
  eq('清空后 book 自动移除', errata.listBooks().map((b) => b.setId), ['s1']);

  // ================= 2. 校对面板组件 =================
  let compCfg = null;
  global.Component = (c) => { compCfg = c; };
  require(path.join(BASE, 'components/errata-sheet/index.js'));

  const c1 = newInstance(compCfg, { setId: 's1', title: '题库一', question: Q, show: false });
  c1.onShowChange(true);
  eq('组件预填题干', c1.data.stem, '题干原文');
  eq('组件预填选项', c1.data.options, 'A. 甲\nB. 乙');
  // 预填一律以**题库现值**为准（answerKey 是 C），不是"我上次写下的修正值"（D）——
  // 否则写回失败时面板看着像已经改好了，一刷题却是旧的。
  eq('组件预填答案（题库现值优先）', c1.data.answer, 'C');
  eq('组件预填解析', c1.data.explanation, '原解析');
  eq('上次的修正与题库不一致时给提示', c1.data.staleText, '答案＝D');
  eq('已有记录标记', c1.data.existed, true);
  eq('已有记录预填类型', c1.data.active, ['answer']);
  eq('选中答案后显示输入框', c1.data.fields.map((f) => f.key), ['answer']);

  c1.toggleType({ currentTarget: { dataset: { key: 'explanation' } } });
  eq('多选类型', c1.data.active.sort(), ['answer', 'explanation']);
  eq('两个输入框', c1.data.fields.map((f) => f.key).sort(), ['answer', 'explanation']);
  c1.onInput({ currentTarget: { dataset: { field: 'answer' } }, detail: { value: 'D' } });
  c1.onInput({ currentTarget: { dataset: { field: 'explanation' } }, detail: { value: '修正后的解析' } });
  events.length = 0;
  c1.save();
  const saved = errata.getBook('s1').items['12'];
  eq('保存后解析已改', saved.fix.explanation, '修正后的解析');
  eq('保存后原解析未变', saved.original.explanation, '原解析');
  eq('触发 saved 事件', events.map((e) => e[0]), ['saved', 'close']);
  eq('保存后导出含解析改动', errata.exportText('s1').includes('解析 改：修正后的解析'), true);

  // 保存要**写回题库明细**：只记清单不改题库，练习页还是旧内容，等于白记
  const q12 = localdb.loadQuestions('s1').filter((q) => String(q.no) === '12')[0];
  eq('写回题库·答案', q12.answerKey, 'D');
  eq('写回题库·解析', q12.explanation, '修正后的解析');
  eq('写回题库·题干没被顺手改掉', q12.stem, '题干原文');
  eq('写回题库·选项没被顺手改掉', errata.optionsToText(q12.options), 'A. 甲\nB. 乙');
  eq('saved 事件带回新题目', String((events[0][1] || {}).no), '12');
  eq('saved 事件标明写回了几项', events[0][1].applied, 2);
  // 回传的是**盘上那份**（练习页照它刷），面板内存里拼的那份不作数
  eq('saved 事件带回的是落盘后的题目', events[0][1].question.explanation, '修正后的解析');

  // 面板拿不到题库现值（question 只带了题号）时才退回修正值 —— 用户写过的东西不能丢
  const c2 = newInstance(compCfg, { setId: 's1', title: '题库一', question: { no: 12 }, show: false });
  c2.onShowChange(true);
  eq('重开预填修正值', c2.data.answer, 'D');
  eq('重开预填修正解析', c2.data.explanation, '修正后的解析');

  // 无类型无内容 → 拒绝保存
  const c3 = newInstance(compCfg, { setId: 's3', title: '题库三', question: { no: 9, stem: 'x' }, show: false });
  c3.onShowChange(true);
  toasts.length = 0;
  c3.save();
  eq('空内容拒绝保存', toasts, ['请选择问题类型或填写备注']);
  eq('未写入', errata.stats('s3').total, 0);

  // 输入方式：正文（滚动区）里**一个 textarea 都没有**，点「修改」时正文整体切成编辑态，
  // 编辑态里只有这一个输入框、高度就是正文区高度。
  // 原因：textarea 是原生组件，层级最高且**不会被 scroll-view 裁剪**，只要它待在滚动区里，
  // 内容一长（或滚动位置让它越出可视区）就会画到面板底部压住「保存」（真机必现，工具里看不出）。
  const c4 = newInstance(compCfg, { setId: 's1', title: '题库一', question: { no: 12 }, show: false });
  c4.onShowChange(true);
  eq('初始没有正在编辑的字段', c4.data.editing, '');
  eq('只读框按内容算高度（1 行 = padding 36 + 行高 44）', c4.data.fields[0].h, 80);
  eq('一行内容不需要框内滚动', c4.data.fields[0].over, false);
  c4.startEdit({ currentTarget: { dataset: { key: 'answer' } } });
  eq('点一下才进编辑态', c4.data.editing, 'answer');
  eq('编辑态带出该字段当前值', c4.data.editValue, 'D');
  eq('编辑态给标题（给用户看改的是哪一项）', c4.data.editLabel, '答案');
  c4.onInput({ currentTarget: { dataset: { field: 'answer' } }, detail: { value: 'D改' } });
  c4.endEdit();
  eq('完成后退出编辑态', c4.data.editing, '');
  eq('完成后只读行显示新值', c4.data.answer, 'D改');
  eq('只读行展示值同步进 fields', c4.data.fields[0].value, 'D改');

  // 取消编辑：改动丢掉，回到原值
  c4.startEdit({ currentTarget: { dataset: { key: 'answer' } } });
  c4.onInput({ currentTarget: { dataset: { field: 'answer' } }, detail: { value: '又改了一次' } });
  c4.cancelEdit();
  eq('取消编辑不留下改动', c4.data.answer, 'D改');
  eq('取消编辑后退出编辑态', c4.data.editing, '');

  // 长内容：只读框封顶，超出的换成 scroll-view 在框内滚（滚轮），不撑高面板
  c4.onInput({ currentTarget: { dataset: { field: 'explanation' } }, detail: { value: '很长'.repeat(120) } });
  c4.endEdit();
  const bigField = c4.data.fields.filter((f) => f.key === 'explanation')[0];
  eq('长解析封顶 6 行', bigField.h, 36 + 6 * 44);
  eq('长解析标记为需要框内滚动', bigField.over, true);

  c4.toggleType({ currentTarget: { dataset: { key: 'answer' } } });
  eq('取消勾选后退出编辑态', c4.data.editing, '');
  eq('取消勾选后该只读框消失', c4.data.fields.map((f) => f.key), ['explanation']);

  // ================= 2.4 正文区高度：防「内容压住保存按钮」 =================
  // 只读框封顶还不够 —— 正文区自身的高度也得算死。
  // 它是 scroll-view；而编辑态里的 textarea 是原生组件，层级最高、不吃 overflow 裁剪，
  // 只要正文区高度是"撑出来的"，内容一长就会画到面板底部压住「保存」（真机必现，工具里看不出）。
  // 规则：列表态 = min(内容自然高, 可用高)；编辑态 = 可用高。
  // 可用高 = 面板上限(86vh) - 面板里正文以外的高度（192rpx 固定 + 标题实测 + 副标题实测 + 底部安全区）。
  const cLay = newInstance(compCfg, { setId: 's1', title: '题库一', question: { no: 12 }, show: true });
  cLay.onShowChange(true);
  rects = { '.er-head': { height: 40 }, '.er-sub': { height: 60 }, '.er-inner': { height: 300 } };
  cLay.measure();
  // 屏高 800 → 面板上限 86vh = 688；固定部分 = 192rpx(96) + 40 + 60 + 安全区 20 = 216 → 可用 472
  eq('内容装得下：正文区按内容高（面板矮一点）', cLay.data.bodyH, 300);
  rects['.er-inner'] = { height: 900 };
  cLay.measure();
  eq('内容装不下：正文区夹到可用高，超出的在框内滚', cLay.data.bodyH, 472);
  rects['.er-sub'] = { height: 30 };
  cLay.startEdit({ currentTarget: { dataset: { key: 'answer' } } });
  eq('编辑态：正文区撑满可用高', cLay.data.bodyH, 502);   // 688 - (96 + 40 + 30 + 20)
  eq('编辑态下改的是刚点的那个字段', cLay.data.editing, 'answer');
  rects = {};

  // ================= 2.5 补答案 → 校对清单的状态流转 =================
  // 规则：本机改得完的（只差答案/解析）补完就归入「已修」，不再挂待修；
  //       还牵扯题干/选项/图题的继续留待修；原有问题类型不能被覆盖。
  const answers = require(path.join(BASE, 'utils/answers.js'));
  const mkQ = (no, stem) => ({
    no, stem, type: 'single',
    options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }],
    answerKey: '', explanation: '', matched: false
  });
  localdb.saveSetBundle({ setId: 's4', title: '题库四' }, [mkQ(1, '甲题'), mkQ(2, '乙题'), mkQ(3, '丙题'), mkQ(5, '戊题')]);

  errata.upsert('s4', { no: 1, stem: '甲题' }, { types: ['answer'], fix: { answer: 'C' }, title: '题库四' });
  errata.upsert('s4', { no: 2, stem: '乙题' }, { types: ['stem', 'answer'], fix: { stem: '乙题改' }, title: '题库四' });
  errata.upsert('s4', { no: 3, stem: '丙题' }, { types: ['answer'], fix: { answer: 'D' }, title: '题库四' });

  eq('单条读取', (errata.getItem('s4', 2) || {}).no, '2');
  eq('单条读取·不存在返回 null', errata.getItem('s4', 99), null);

  const r1 = answers.saveAnswer('s4', 1, { answerKey: 'B', explanation: '补的解析' });
  eq('补答案返回改前值', r1.before.answerKey, '');
  eq('补答案返回改后值', r1.after.answerKey, 'B');
  eq('只差答案 → 归入已修', errata.getItem('s4', 1).status, 'fixed');
  eq('已修后不再计入待修', errata.listItems('s4', 'open').map((i) => i.no).sort(), ['2', '3']);

  answers.saveAnswer('s4', 2, { answerKey: 'A' });
  eq('还牵扯题干 → 仍留待修', errata.getItem('s4', 2).status, 'open');
  eq('问题类型不被补答案覆盖', errata.getItem('s4', 2).types.sort(), ['answer', 'stem']);

  errata.setStatus('s4', 3, 'fixed');
  answers.saveAnswer('s4', 3, { explanation: '再补一句解析' });
  eq('手动标过已修的不被退回', errata.getItem('s4', 3).status, 'fixed');

  // 纠错面板：**写下了与原文不同的正确内容 = 这题在我这边处理完了 → 归入已修**。
  // 反过来，只勾了类型、还没写内容 → 不动状态（不把已修退回待修）：
  // 之前是「勾了本机改不了的类型就退回待修」，于是修好并写清了内容也还挂在待修里。
  errata.upsert('s4', { no: 5, stem: '戊题' }, { types: ['stem'], title: '题库四' });
  const c5 = newInstance(compCfg, { setId: 's4', title: '题库四', question: { no: 5, stem: '戊题' }, show: false });
  c5.onShowChange(true);
  eq('面板预填已有类型', c5.data.active, ['stem']);
  c5.save();
  eq('只勾类型没写内容 → 仍在待修', errata.getItem('s4', 5).status, 'open');

  c5.onInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '戊题改' } });
  c5.save();
  eq('写了修正内容 → 归入已修', errata.getItem('s4', 5).status, 'fixed');
  const q5 = localdb.loadQuestions('s4').filter((q) => String(q.no) === '5')[0];
  eq('题干修正写回题库明细', q5.stem, '戊题改');

  // 题库里找不到这道题（题库被删 / 重新导入过）：清单照记（用户写的东西不能丢），
  // 但必须明确告诉他题库没更新 —— 不然他以为改好了，还是白用功。
  const c7 = newInstance(compCfg, { setId: 's4', title: '题库四', question: { no: 99, stem: '题库里没有的题' }, show: false });
  c7.onShowChange(true);
  c7.toggleType({ currentTarget: { dataset: { key: 'stem' } } });
  c7.onInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '改一下' } });
  modals.length = 0;
  c7.save();
  eq('写不回题库也要把清单记下', (errata.getItem('s4', 99) || {}).no, '99');
  eq('明确提示没能写回题库', /没能写回题库/.test((modals[0] || {}).title || ''), true);

  // 已有已修记录、这次没改内容 → 状态原样保留（保存不做降级，要退回用清单页的开关）
  errata.upsert('s4', { no: 5, stem: '戊题' }, { types: ['stem'], fix: { stem: '' }, title: '题库四' });
  errata.setStatus('s4', 5, 'fixed');
  const c6 = newInstance(compCfg, { setId: 's4', title: '题库四', question: { no: 5, stem: '戊题' }, show: false });
  c6.onShowChange(true);
  c6.save();
  eq('没改内容也不把已修退回待修', errata.getItem('s4', 5).status, 'fixed');

  // ================= 2.6 补答案后展示「改成了什么」 =================
  let ansCfg = null;
  global.Component = (c) => { ansCfg = c; };
  require(path.join(BASE, 'components/answer-sheet/index.js'));

  const a1 = newInstance(ansCfg, {
    setId: 's4', title: '题库四', show: false,
    question: {
      no: 1, stem: '甲题', type: 'single',
      options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }],
      answerKey: 'B', answer: '', explanation: '补的解析'
    }
  });
  a1.onShowChange(true);
  eq('编辑态没有结果视图', a1.data.result, null);
  eq('解析只读框按内容算高度', a1.data.explH, 36 + 44);
  // 解析：点「修改」进编辑态（正文里只放这一个输入框），改完点「完成」
  a1.startEdit({ currentTarget: { dataset: { key: 'explanation' } } });
  eq('点修改进编辑态', a1.data.editing, 'explanation');
  eq('编辑态带出当前解析', a1.data.editValue, '补的解析');
  a1.onInput({ currentTarget: { dataset: { field: 'explanation' } }, detail: { value: '改后的解析' } });
  a1.endEdit();
  eq('完成后退出编辑态', a1.data.editing, '');
  eq('完成后只读行显示新解析', a1.data.explanation, '改后的解析');
  a1.toggleOption({ currentTarget: { dataset: { key: 'A' } } });   // B → A
  a1.toggleOption({ currentTarget: { dataset: { key: 'B' } } });
  events.length = 0;
  a1.save();
  eq('保存后不立刻关面板', events.map((e) => e[0]), ['saved']);
  eq('生成了结果视图', !!a1.data.result, true);
  eq('结果·题干照最终值', a1.data.result.stem, '甲题');
  eq('结果·答案前后对比', [a1.data.result.answerOld, a1.data.result.answerNew], ['B', 'A']);
  eq('结果·解析前后对比', [a1.data.result.explOld, a1.data.result.explNew], ['补的解析', '改后的解析']);
  eq('结果·选项标出正确项', a1.data.result.options.filter((o) => o.right).map((o) => o.key), ['A']);
  eq('结果·答案标记为已改', a1.data.result.answerChanged, true);
  a1.finish();
  eq('点完成才关闭', events.map((e) => e[0]), ['saved', 'close']);

  // 没改动的字段不给前后对比，只展示最终值
  const a2 = newInstance(ansCfg, {
    setId: 's4', title: '题库四', show: false,
    question: {
      no: 2, stem: '乙题', type: 'single',
      options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }],
      answerKey: 'A', answer: '', explanation: ''
    }
  });
  a2.onShowChange(true);
  a2.save();
  eq('只改答案时答案不算改动', a2.data.result.answerChanged, false);
  eq('只改答案时解析不算改动', a2.data.result.explChanged, false);
  a2.onShowChange(true);
  eq('重新打开时清空结果视图', a2.data.result, null);

  // 收尾：清掉本段造的 s4 校对记录，后面的清单页用例只针对 s1
  errata.clearBook('s4');

  // 只勾类型、没有写下与原文不同的内容 → 题库里根本没有要写回的东西。
  // ① 文案必须说清"只记了清单"，不能含糊地报「已保存」（用户会以为题目已经改好了，2026-09-24 报的就是这个）；
  // ② 也不能把面板带进来的旧快照当"新题目"回传给练习页 —— 那会把页面刷成更旧的版本。
  const cNoWrite = newInstance(compCfg, { setId: 's9', title: '题库九', question: { no: 12 }, show: true });
  cNoWrite.onShowChange(true);
  cNoWrite.toggleType({ currentTarget: { dataset: { key: 'image' } } });
  toasts.length = 0;
  events.length = 0;
  cNoWrite.save();
  eq('只勾类型不改内容：只记清单', toasts, ['已记入校对清单，题库无改动']);
  eq('只勾类型不改内容：applied 为 0', events[0][1].applied, 0);
  eq('只勾类型不改内容：不带题目回传（免得把练习页刷旧）', events[0][1].question, null);
  errata.clearBook('s9');

  // ================= 3. 答题页接入 =================
  let pageCfg = null;
  global.Page = (o) => { pageCfg = o; };
  require(path.join(BASE, 'pages/quiz/quiz.js'));

  const quiz = newInstance(pageCfg);
  quiz.persist = function () { require(path.join(BASE, 'utils/progress.js')).saveState(this.state); };
  quiz.onLoad({ setId: 's1', mode: 'order', title: '题库一' });
  await tick();
  eq('答题页就绪', quiz.data.ready, true);
  eq('未纠错的题', quiz.data.errated, false);

  quiz.openErrata();
  eq('面板打开', quiz.data.er.show, true);
  eq('面板带题库号', quiz.data.er.setId, 's1');
  eq('面板带题号', String(quiz.data.er.question.no), '1');
  eq('面板带选项', quiz.data.er.question.options.length, 2);

  errata.upsert('s1', { no: 1, stem: '题干一', answerKey: 'B' }, { types: ['answer'], fix: { answer: 'C' }, title: '题库一' });
  quiz.onErrataSaved();
  eq('保存后题卡显示已纠错', quiz.data.errated, true);

  // 校对面板保存时已经把这题的修正写回了题库明细 → 答题页内存里那份也要跟着换，
  // 否则题卡上还是改之前的内容，等于白改（用户 2026-09-24 报的就是这个）
  const q1Old = localdb.loadQuestions('s1').filter((q) => String(q.no) === '1')[0];
  const rw = require(path.join(BASE, 'utils/answers.js')).applyFix('s1', 1, {
    stem: '题干一（改）',
    options: 'A. 甲改\nB. 乙改',
    answerKey: 'C',
    explanation: '解析一（改）'
  });
  eq('写回后题库里的题干变了', rw.question.stem, '题干一（改）');
  // 落盘后回读校验：真机上题库明细是大文件，写入被截断/写到别处都出现过，
  // 当场发现比等用户刷题时看到旧内容好（那时已经不知道是哪一步坏的）
  eq('写回后回读校验通过', rw.persisted, true);
  eq('latest 是盘上那份', rw.latest.stem, '题干一（改）');
  eq('latest 与回读到的题库内容一致', rw.latest.stem,
    localdb.loadQuestions('s1').filter((q) => String(q.no) === '1')[0].stem);
  eq('写回后选项按行还原成数组', rw.question.options.map((o) => `${o.key}.${o.text}`), ['A.甲改', 'B.乙改']);
  eq('写回前后对比·答案', [rw.before.answerKey, rw.after.answerKey], ['B', 'C']);
  eq('写回返回 changed', rw.changed, true);
  eq('原题干确实不同（不是空写）', q1Old.stem !== rw.question.stem, true);

  quiz.onErrataSaved({ detail: { no: 1, question: rw.question } });
  eq('答题页内存里的题目换成新的', quiz.byNo['1'].stem, '题干一（改）');
  eq('题卡渲染出新题干', quiz.data.cur.stem, '题干一（改）');
  eq('题卡渲染出新选项', quiz.data.options.map((o) => o.text), ['甲改', '乙改']);

  // 空补丁（什么都没改）不写盘：免得「只是打开看了一眼」也算一次修改
  const before13 = localdb.loadQuestions('s1').filter((q) => String(q.no) === '12')[0].answerFixedAt;
  const rw2 = require(path.join(BASE, 'utils/answers.js')).applyFix('s1', 12, {});
  eq('空补丁不写盘', rw2.changed, false);
  eq('空补丁不动 answerFixedAt', localdb.loadQuestions('s1').filter((q) => String(q.no) === '12')[0].answerFixedAt, before13);

  // ---------- 3.5 人工修好之后，「答案用不上」的提示要跟着撤掉 ----------
  // 场景：引擎装配时发现「答案写的是对/错，题目却有 4 个选项」，转成自评并在题卡上
  // 挂了一段说明。用户随后在「补答案」里填了正确选项 —— 那段说明必须消失，
  // 否则他会一直看到"标准答案对不上选项，请核对"，而他明明已经核对过了。
  const s1Qs = localdb.loadQuestions('s1');
  Object.assign(s1Qs.filter((q) => String(q.no) === '2')[0], {
    answerKey: '', answer: '正确', answerSuspect: true, answerSuspectKind: 'typeConflict'
  });
  localdb.saveSetBundle({ setId: 's1', title: '题库一' }, s1Qs);
  const ansMod = require(path.join(BASE, 'utils/answers.js'));
  eq('模拟的存疑状态已落盘', localdb.loadQuestions('s1').filter((q) => String(q.no) === '2')[0].answerSuspect, true);

  const rw3 = ansMod.applyFix('s1', 2, { answerKey: 'A', answer: 'A' });
  eq('补答案后撤掉存疑标记', rw3.question.answerSuspect, false);
  eq('补答案后清空存疑原因', rw3.question.answerSuspectKind, '');
  eq('补答案后判分键生效', rw3.question.answerKey, 'A');
  eq('落盘那份也撤掉了标记',
    localdb.loadQuestions('s1').filter((q) => String(q.no) === '2')[0].answerSuspect, false);

  // 反向：补的键落在选项之外 → 仍要存疑（不能因为"用户填过"就当好了）
  const rw4 = ansMod.applyFix('s1', 2, { answerKey: 'E', answer: 'E' });
  eq('填了不存在的选项仍标存疑', rw4.question.answerSuspect, true);
  eq('存疑原因记为选项缺失', rw4.question.answerSuspectKind, 'missingOption');

  quiz.next();
  eq('切到下一题恢复未纠错', quiz.data.errated, false);

  // 回到练习页时重读题库明细：题目可能在别处被改过（校对清单页补答案、别的入口写回），
  // 内存里那份若还是旧的，题卡就一直显示旧内容 —— 用户看到的就是"我明明改过了，刷题还是错的"。
  quiz.goto(0);
  require(path.join(BASE, 'utils/answers.js')).applyFix('s1', 1, { options: 'A. 甲外改\nB. 乙外改' });
  quiz.onShow();
  eq('回到练习页会重读题库，题卡跟着换', quiz.data.options.map((o) => o.text), ['甲外改', '乙外改']);
  eq('重读后题序不动', String(quiz.data.cur.srcNo), '1');

  // ================= 4. 校对清单页 =================
  require(path.join(BASE, 'pages/errata/errata.js'));
  let listCfg = null;
  global.Page = (o) => { if (o.data && o.data.setFilter) listCfg = o; };
  delete require.cache[require.resolve(path.join(BASE, 'pages/errata/errata.js'))];
  require(path.join(BASE, 'pages/errata/errata.js'));

  const page = newInstance(listCfg);
  page.refresh();
  // 此时 s1：第 1 题待修（答题页刚记的一笔），第 12 题已修（面板里写下了修正内容）
  eq('汇总待修', page.data.sum.open, 1);
  eq('汇总已修', page.data.sum.fixed, 1);
  eq('题库筛选项（全部+1库）', page.data.setFilter.length, 2);
  eq('默认视图待修', page.data.tab, 'open');
  eq('分组数', page.data.groups.length, 1);
  eq('分组内题目', page.data.groups[0].items.map((i) => i.no), ['1']);

  page.changeTab({ currentTarget: { dataset: { tab: 'fixed' } } });
  eq('已修视图', page.data.tab, 'fixed');
  eq('已修组内题目', page.data.groups[0].items.map((i) => i.no), ['12']);
  page.changeTab({ currentTarget: { dataset: { tab: 'open' } } });
  eq('切回待修视图', page.data.tab, 'open');

  clipboard.length = 0;
  page.copyAll();
  eq('复制成功', clipboard.length, 1);
  eq('复制内容含题号', clipboard[0].includes('【题号 1】'), true);

  clipboard.length = 0;
  page.copyItem({ currentTarget: { dataset: { sid: 's1', no: '1' } } });
  eq('单条复制只含该题', clipboard[0].trim().indexOf('【题号 1】') === 0, true);

  modalConfirm = true;
  page.removeItem({ currentTarget: { dataset: { sid: 's1', no: '12' } } });
  eq('删除已修那条后已修数', page.data.sum.fixed, 0);
  eq('待修数不受影响', page.data.sum.open, 1);

  // 已修为空 → 自动回落到待修（视图里没有内容时不该停在一个空列表上）
  page.changeTab({ currentTarget: { dataset: { tab: 'fixed' } } });
  eq('已修为空 → 回落待修', page.data.tab, 'open');

  page.toggleStatus({ currentTarget: { dataset: { sid: 's1', no: '1', pending: 1 } } });
  eq('标记已修后待修数', page.data.sum.open, 0);
  eq('已修数', page.data.sum.fixed, 1);

  // globalData 传参进入
  const app = { globalData: { errataFilter: 's1' } };
  global.getApp = () => app;
  page.onShow();
  eq('进入时应用筛选题库', page.data.setId, 's1');
  eq('globalData 已消费', app.globalData.errataFilter, null);

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
