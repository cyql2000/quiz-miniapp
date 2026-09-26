// 答题页错题接入集成测试（模拟 Page / wx，无需微信开发者工具）
// 运行：node _smoke/quizpage.test.js
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const titles = [];
const navs = [];       // navigateTo / redirectTo 的目标（预览页「进入指定题目」要看它）
const modals = [];     // 弹窗内容（入口冲突弹窗的文案要断言）
const sheets = [];     // 选项表（showActionSheet）：未完成进度那条路用它
let modalAnswer = { confirm: true };
let sheetAnswer = { tapIndex: 0 };   // null = 点遮罩取消（走 fail）
let backs = 0;         // navigateBack 次数

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => {
    modals.push({ title: o.title, content: o.content || '', confirmText: o.confirmText, cancelText: o.cancelText });
    if (o.success) o.success(Object.assign({}, modalAnswer));
  },
  showActionSheet: (o) => {
    sheets.push({ itemList: o.itemList });
    if (sheetAnswer == null) { if (o.fail) o.fail({ errMsg: 'showActionSheet:fail cancel' }); return; }
    if (o.success) o.success(Object.assign({}, sheetAnswer));
  },
  navigateBack: () => { backs += 1; },
  navigateTo: (o) => navs.push(o.url),
  redirectTo: (o) => navs.push(o.url),
  setNavigationBarTitle: (o) => titles.push(o.title)
};
global.getApp = () => ({ globalData: {} });

// 本地化改造后：题库明细从沙箱文件读取（原先桩的是 getSet 云函数）
const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const QUESTIONS = [
  { no: 1, stem: '题干1', type: 'single', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], answerKey: 'A', explanation: '解析1', matched: true },
  { no: 2, stem: '题干2', type: 'single', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], answerKey: 'B', explanation: '解析2', matched: true },
  { no: 3, stem: '题干3', type: 'judge', answerKey: 'A', explanation: '解析3', matched: true }
];
const localdb = require(path.join(BASE, 'utils/localdb.js'));
localdb.saveSetBundle({ setId: 's1', title: '题库一' }, QUESTIONS);
localdb.saveSetBundle({ setId: 's_empty', title: '空库' }, QUESTIONS);
// 专用题库：计时与标记用例（避免与前面的会话互相干扰）
localdb.saveSetBundle({ setId: 's_time', title: '计时库' }, QUESTIONS);

const wb = require(path.join(BASE, 'utils/wrongbook.js'));
const marks = require(path.join(BASE, 'utils/marks.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const tick = () => new Promise((r) => setTimeout(r, 0));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

let captured = null;
global.Page = (obj) => { captured = obj; };
require(path.join(BASE, 'pages/quiz/quiz.js'));

// setData 里混进 undefined，真机会刷 "Setting data field X to undefined is invalid"。
// showSelfJudge 就栽过一次（短路链最后一项是 `rec.answered && …`，新题上返回 undefined）。
// 这里在桩里兜底收集，测试末尾统一断言，别再让这类字段溜出去。
const undefFields = [];

function newPage() {
  const p = Object.assign({}, captured);
  p.data = JSON.parse(JSON.stringify(captured.data));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => {
      if (patch[k] === undefined) undefFields.push(k);
      if (k.indexOf('.') < 0) { this.data[k] = patch[k]; return; }
      const seg = k.split('.');
      let o = this.data;
      for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]];
      o[seg[seg.length - 1]] = patch[k];
    });
    if (cb) cb();
  };
  p.persist = function () { require(path.join(BASE, 'utils/progress.js')).saveState(this.state); };
  return p;
}

(async () => {
  // 造一条历史错题：第 2 题在顺序练习中答错 1 次
  const Q2 = { no: 2, stem: '题干2', type: 'single', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], answerKey: 'B', explanation: '解析2' };
  wb.recordAnswer('s1', Q2, { correct: false, selected: 'A', mode: 'order', title: '题库一' });

  // ---- 1. 错题重练：从错题本取题，而不是上一次会话 ----
  const p1 = newPage();
  p1.onLoad({ setId: 's1', mode: 'wrong', title: '题库一' });
  await tick();
  eq('错题模式下 ready', p1.data.ready, true);
  eq('错题模式题目数', p1.data.total, 1);
  eq('错题模式题目号', p1.state.order, ['2']);
  eq('标题栏', titles[titles.length - 1], '错题重练 · 题库一');
  eq('题卡显示历史错次', p1.data.wb.wrongCount, 1);
  eq('该题暂非易错', p1.data.wb.hard, false);

  // ---- 2. 再答错 → 升级为易错题 ----
  p1.tapOption({ currentTarget: { dataset: { key: 'A' } } });
  p1.confirmAnswer();
  eq('再错后错次', wb.getBook('s1').items['2'].wrongCount, 2);
  eq('再错后判为易错', wb.listItems('s1', 'hard').map((i) => i.no), ['2']);
  eq('再错不触发已掌握', p1.data.justMastered, false);

  // ---- 3. 连对 2 次 → 自动归入已掌握 ----
  const p2 = newPage();
  p2.onLoad({ setId: 's1', mode: 'hard', title: '题库一' });
  await tick();
  eq('易错题重练题目数', p2.data.total, 1);
  eq('易错题重练标题', titles[titles.length - 1], '易错题重练 · 题库一');

  p2.tapOption({ currentTarget: { dataset: { key: 'B' } } });
  p2.confirmAnswer();
  eq('答对 1 次未掌握', p2.data.justMastered, false);
  eq('掌握状态', wb.stats('s1').mastered, 0);

  p2.tapOption({ currentTarget: { dataset: { key: 'B' } } });
  p2.confirmAnswer();
  eq('连对 2 次触发掌握提示', p2.data.justMastered, true);
  eq('已掌握计数', wb.stats('s1').mastered, 1);
  eq('已掌握后待攻克', wb.stats('s1').pending, 0);
  eq('已掌握后易错', wb.stats('s1').hard, 0);

  // ---- 4. 指定题号重练（错题本单题回顾） ----
  const p3 = newPage();
  p3.onLoad({ setId: 's1', mode: 'wrong', nos: '1,3', title: '题库一' });
  await tick();
  eq('指定题号重练', p3.state.order, ['1', '3']);
  eq('指定题号题目数', p3.data.total, 2);

  // ---- 5. 一次就答对不污染错题本 ----
  const before = wb.stats('s1').total;
  p3.tapOption({ currentTarget: { dataset: { key: 'A' } } });
  p3.confirmAnswer();
  eq('顺序作答判定正确', p3.data.isCorrect, true);
  eq('一次答对不入错题本', wb.stats('s1').total, before);
  eq('一次答对无掌握提示', p3.data.justMastered, false);

  // ---- 5.1 作答要真的落进会话记录（否则已答数、正确率、整卷回顾全失真） ----
  // 曾经的写法是 `(s.records[no]) || {}`：新题取到的是个游离对象，
  // 改完没有写回 records，于是记录永远为空。
  eq('作答写回会话记录', Object.keys(p3.state.records), ['1']);
  eq('已答数随之更新', p3.countAnswered(p3.state), 1);
  eq('记录留下我的选择', p3.state.records['1'].selected, ['A']);
  eq('记录留下判定结果', p3.state.records['1'].correct, true);
  eq('落盘后记录仍在', Object.keys(progress.getState('s1').records), ['1']);

  // ---- 6. 无错题时进入错题重练 ----
  toasts.length = 0;
  const p4 = newPage();
  p4.onLoad({ setId: 's_empty', mode: 'wrong', title: '空库' });
  await tick();
  eq('空错题本给出提示', toasts, ['暂无错题，先去练几道吧']);
  eq('空错题本不进入答题', p4.data.ready, false);

  toasts.length = 0;
  const p5 = newPage();
  p5.onLoad({ setId: 's_empty', mode: 'hard', title: '空库' });
  await tick();
  eq('无易错题给出提示', toasts, ['暂无易错题']);

  // ---- 7. 用时统计：只计「页面在前台」的时间 ----
  // 旧实现是 now - startedAt，继续练习沿用旧 state，隔天回来会显示上千分钟。
  const p6 = newPage();
  p6.onLoad({ setId: 's_time', mode: 'order', title: '计时库' });
  await tick();
  // 只要求「不继承历史时长」，不要求恰好 0：onLoad 到这条断言之间真的过了几毫秒，
  // 而这段时间人确实在页面上，本来就该计进去。写成 ===0 会偶发失败（跑全量时见过一次）。
  eq('新会话不继承历史时长', progress.elapsedOf(p6.state) < 1000, true);

  p6.state.lastTickAt = Date.now() - 65000;   // 假装专注了 65 秒
  p6.persist();
  const after65 = progress.elapsedOf(p6.state);
  eq('专注时长被计入（约 65 秒）', after65 >= 60000 && after65 < 70000, true);

  // 中途离开一小时（进程被杀、没触发 onHide 的最坏情况），回来不应把这段时间算进去
  p6.state.lastTickAt = Date.now() - 3600000;
  p6.onShow();
  p6.persist();
  const afterIdle = progress.elapsedOf(p6.state);
  eq('离场一小时不计入用时', afterIdle < 70000, true);
  eq('已经计到的时长不会被清零', afterIdle >= 60000, true);

  // 旧版本会话没有计时字段：不能把历史 startedAt 当成活跃时长
  mem.qz_state_s_legacy = {
    setId: 's_legacy', title: '旧会话', mode: 'order', order: ['1'], idx: 0, total: 1,
    records: {}, wrongs: [], startedAt: Date.now() - 86400000, finished: false
  };
  const legacy = progress.getState('s_legacy');
  eq('旧会话不做假计时', legacy.elapsedMs, 0);

  // ---- 8. 标记闭环：持久化 + 答题卡角标 + 标记题重练 ----
  eq('使用前无标记', marks.list('s_time'), []);
  const p7 = newPage();
  p7.onLoad({ setId: 's_time', mode: 'order', title: '计时库' });
  await tick();
  p7.toggleMark();
  eq('标记写入持久化清单（不再只活在会话里）', marks.list('s_time'), ['1']);
  eq('题卡显示已标记', p7.data.marked, true);

  p7.openSheet();
  eq('答题卡带出标记角标', p7.data.sheet.grid.filter((g) => g.mk).map((g) => g.num), ['1']);
  eq('答题卡标记计数', p7.data.sheet.marked, 1);
  p7.closeSheet();

  p7.next();
  p7.toggleMark();
  eq('第二题也标记', marks.list('s_time'), ['1', '2']);
  p7.toggleMark();
  eq('再点一次取消标记', marks.list('s_time'), ['1']);

  // 标记跨会话保留：新开一个会话仍然读得到
  const p8 = newPage();
  p8.onLoad({ setId: 's_time', mode: 'marked', title: '计时库' });
  await tick();
  eq('标记题重练题数', p8.data.total, 1);
  eq('标记题重练题目号', p8.state.order, ['1']);
  eq('标记题重练标题', titles[titles.length - 1], '标记题重练 · 计时库');

  toasts.length = 0;
  const p9 = newPage();
  p9.onLoad({ setId: 's_empty', mode: 'marked', title: '空库' });
  await tick();
  eq('无标记题时给出可操作的提示', toasts, ['暂无标记题，答题时点右上角「标记」就能收进来']);
  eq('无标记题不进入答题', p9.data.ready, false);

  // ---- 12. 交卷自动判定「已选未确认」的题 ----
  // 需求：一次刷几十道题，不必逐题点「确认答案」；交卷时按已选自动判分。
  // 判分口径必须与 confirmAnswer 完全一致，否则同一题会出现「手动确认」与
  // 「自动判分」两套结果（错题本也会跟着分叉）。
  localdb.saveSetBundle({ setId: 's_auto', title: '自动判分库' }, QUESTIONS);
  const p10 = newPage();
  p10.onLoad({ setId: 's_auto', mode: 'order', title: '自动判分库' });
  await tick();

  const st = p10.state;
  st.records['1'] = { selected: ['A'] };      // 选对（答案 A）
  st.records['2'] = { selected: ['A'] };      // 选错（答案 B）
  eq('只选未确认时不算已答', p10.countAnswered(st), 0);
  eq('待自动判分的题数', p10.pendingCount(st), 2);

  const r1 = p10.autoJudgePending(st);
  eq('自动判分题数', r1.judged, 2);
  eq('自动判对', st.records['1'].correct, true);
  eq('自动判错', st.records['2'].correct, false);
  eq('自动判分后计入已答', p10.countAnswered(st), 2);
  eq('自动判错同样进错题本', wb.getBook('s_auto').items['2'].wrongCount, 1);
  eq('已判过的题不重复判', p10.autoJudgePending(st).judged, 0);
  eq('没选的题不进判分', p10.pendingCount(st), 0);

  // 无标准答案的题不替用户判：转自评（correct = null），与手动确认后的状态一致
  localdb.saveSetBundle({ setId: 's_nokey', title: '无答案库' }, [
    { no: 1, stem: '题干1', type: 'single', options: [{ key: 'A', text: 'a' }], answerKey: '', matched: false }
  ]);
  const p11 = newPage();
  p11.onLoad({ setId: 's_nokey', mode: 'order', title: '无答案库' });
  await tick();
  p11.state.records['1'] = { selected: ['A'] };
  const r2 = p11.autoJudgePending(p11.state);
  eq('无标准答案不进自动判分', r2.judged, 0);
  eq('无标准答案转自评', r2.needSelf, 1);
  eq('自评题不写判定结果', p11.state.records['1'].correct, null);

  // ---- 13. 交卷链路：弹窗确认 → 自动判分 → 落盘 finished ----
  localdb.saveSetBundle({ setId: 's_auto2', title: '交卷库' }, QUESTIONS);
  const p12 = newPage();
  p12.onLoad({ setId: 's_auto2', mode: 'order', title: '交卷库' });
  await tick();
  p12.state.records['1'] = { selected: ['A'] };
  toasts.length = 0;
  p12.finish();
  eq('交卷后标记完成', p12.state.finished, true);
  eq('交卷时自动判了题', p12.state.records['1'].correct, true);
  eq('交卷自动判分有提示', toasts.indexOf('已自动判分 1 题') >= 0, true);
  eq('交卷结果已落盘', progress.getState('s_auto2').finished, true);

  // ---- 14. 预览页：选具体题目进入 ----
  // 预览列表原来只能看，想核对第 37 题得先开始练习再翻过去。
  let capturedPreview = null;
  global.Page = (obj) => { capturedPreview = obj; };
  require(path.join(BASE, 'pages/preview/preview.js'));

  const pv = Object.assign({}, capturedPreview);
  pv.data = { setId: 's_auto', set: { title: '自动判分库', questionCount: 3 } };
  pv.setData = (patch) => Object.assign(pv.data, patch);
  navs.length = 0;
  pv.openQuestion({ currentTarget: { dataset: { seq: 2 } } });
  eq('点列表第 2 条 → 进第 2 题', navs[0].indexOf('start=2') >= 0, true);
  eq('进入走顺序练习', navs[0].indexOf('mode=order') >= 0, true);
  eq('带上题库 id 与标题', navs[0].indexOf('setId=s_auto') >= 0 && navs[0].indexOf('title=') >= 0, true);
  toasts.length = 0;
  pv.enterQuestion(99);
  eq('超出题序给提示', toasts[0], '请输入 1 - 3 之间的题序');
  eq('超出题序不跳转', navs.length, 1);

  // ---- 15. 已有未完成进度：三条路都摆出来 —— 继续 / 从当前题目开始 / 重新开始 ----
  // 三个按钮塞不进系统弹窗（只有确认/取消两个钮），所以用选项表。
  // 「继续」放第一项（默认会被手指先碰到，也是最高频的意图）：不动记录，接着做；
  // 另外两条都会清空整套未完成进度（不可恢复），后果直接写进选项文案。
  localdb.saveSetBundle({ setId: 's_resume', title: '续做库' }, QUESTIONS);
  const stResume = progress.createState('s_resume', '续做库', 'order', ['1', '2', '3']);
  stResume.idx = 1;
  progress.saveState(stResume);

  sheets.length = 0; sheetAnswer = { tapIndex: 0 };
  const p13 = newPage();
  p13.onLoad({ setId: 's_resume', mode: 'order', title: '续做库' });
  await tick();
  eq('未完成时给出三个选项', sheets[0].itemList.length, 3);
  eq('首项是「继续」并标出停在哪一题、已答几题', /^继续（第 2 题 · 已答 0\/3）/.test(sheets[0].itemList[0]), true);
  eq('第二项是从当前题目开始（并写明会清空记录）', sheets[0].itemList[1], '从第 2 题开始（清空记录，从这道题重做）');
  eq('第三项是重新开始', sheets[0].itemList[2], '重新开始（清空记录，从第 1 题重做）');
  eq('点继续后停在原位置', p13.state.idx, 1);
  eq('点继续沿用原会话（没被重置）', p13.state.order.join(','), '1,2,3');

  // 「从当前题目开始」：这次点进来的那道题（预览页/答题卡带过来的 start）
  modals.length = 0; sheets.length = 0; sheetAnswer = { tapIndex: 1 };
  const p14 = newPage();
  p14.onLoad({ setId: 's_resume', mode: 'order', title: '续做库', start: 3 });
  await tick();
  eq('选项里报出本次指定的起始题', sheets[0].itemList[1], '从第 3 题开始（清空记录，从这道题重做）');
  eq('从当前题目开始 → 落在第 3 题', p14.state.idx, 2);
  eq('从当前题目开始 → 旧进度被覆盖', progress.getState('s_resume').idx, 2);

  // 「重新开始」：从第 1 题重做
  progress.saveState(stResume);
  modals.length = 0; sheets.length = 0; sheetAnswer = { tapIndex: 2 };
  const p14b = newPage();
  p14b.onLoad({ setId: 's_resume', mode: 'order', title: '续做库' });
  await tick();
  eq('点重新开始 → 从第 1 题重做', p14b.state.idx, 0);
  eq('点重新开始 → 题序按题库重排', p14b.state.order.join(','), '1,2,3');
  eq('重新开始后的会话长度不变', p14b.state.total, 3);
  eq('旧进度已被覆盖', progress.getState('s_resume').idx, 0);

  // 点遮罩取消 = 退出，不动任何数据
  progress.saveState(stResume);
  sheets.length = 0; sheetAnswer = null; backs = 0;
  const p14c = newPage();
  p14c.onLoad({ setId: 's_resume', mode: 'order', title: '续做库' });
  await tick();
  eq('取消直接退出', backs, 1);
  eq('取消后进度原样保留', progress.getState('s_resume').idx, 1);

  // 随机练习里「第 N 题」没有意义（每轮顺序都不同），这一项不给
  progress.saveState(stResume);
  sheets.length = 0; sheetAnswer = { tapIndex: 0 };
  const p14d = newPage();
  p14d.onLoad({ setId: 's_resume', mode: 'random', title: '续做库' });
  await tick();
  eq('随机模式只有两个选项', sheets[0].itemList.length, 2);
  eq('随机模式没有「从当前题目开始」', /从第 \d+ 题开始/.test(sheets[0].itemList.join('|')), false);

  // 换模式进入同一套进度：标题要跟着会话走，别指错
  const stResume2 = progress.createState('s_resume', '续做库', 'order', ['1', '2', '3']);
  stResume2.idx = 2;
  progress.saveState(stResume2);
  sheets.length = 0; sheetAnswer = { tapIndex: 0 };
  const p15 = newPage();
  p15.onLoad({ setId: 's_resume', mode: 'random', title: '续做库' });
  await tick();
  eq('继续后模式标签跟随原会话', p15.data.modeTag, '顺序练习');

  // 全程没有 undefined 混进 setData（真机会逐条报警告刷屏控制台）
  eq('setData 里没有 undefined 字段', undefFields, []);
  eq('新题的自评入口是 false 不是 undefined', p15.data.showSelfJudge, false);

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
