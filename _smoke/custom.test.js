// 自定义练习：范围筛选 / 数量联动 / 随机抽取与顺序 / 跨题库作答回写
// 运行：node _smoke/custom.test.js
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const titles = [];
const navs = [];
const modals = [];
let confirmAnswer = true;

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { modals.push(o.title); if (o.success) o.success({ confirm: confirmAnswer }); },
  navigateBack: () => navs.push('back'),
  navigateTo: (o) => navs.push(o.url),
  redirectTo: (o) => navs.push(o.url),
  switchTab: (o) => navs.push(o.url),
  setNavigationBarTitle: (o) => titles.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  pageScrollTo: () => {},
  stopPullDownRefresh: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const localdb = require(path.join(BASE, 'utils/localdb.js'));
const wrongbook = require(path.join(BASE, 'utils/wrongbook.js'));
const marks = require(path.join(BASE, 'utils/marks.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const custom = require(path.join(BASE, 'utils/custom.js'));

const tick = () => new Promise((r) => setTimeout(r, 0));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const uidOf = (it) => `${it.sid}::${it.no}`;
const sorted = (list) => list.slice().sort();
const uniq = (list) => list.filter((v, i) => list.indexOf(v) === i);

const OPT4 = [
  { key: 'A', text: 'a' }, { key: 'B', text: 'b' },
  { key: 'C', text: 'c' }, { key: 'D', text: 'd' }
];

// ---------------- 数据：三本书 / 四个章节 ----------------
// sA、sB 同属「示例题库」的一、二章；sC 属于另一本书
localdb.saveSetBundle({ setId: 'sA', title: '示例题库 · 第一章 常识' }, [
  { no: 1, stem: 'A1 单选', type: 'single', options: OPT4, answerKey: 'A', matched: true },
  { no: 2, stem: 'A2 多选', type: 'multi', options: OPT4, answerKey: 'AB', matched: true },
  { no: 3, stem: 'A3 判断', type: 'judge', answerKey: 'A', matched: true },
  { no: 4, stem: 'A4 问答', type: 'text', options: [], answerKey: '', answer: '参考答案', matched: false }
]);
localdb.saveSetBundle({ setId: 'sB', title: '示例题库 · 第二章 数量' }, [
  { no: 1, stem: 'B1 单选', type: 'single', options: OPT4, answerKey: 'C', matched: true },
  { no: 2, stem: 'B2 单选', type: 'single', options: OPT4, answerKey: 'D', matched: true },
  { no: 3, stem: 'B3 多选', type: 'multi', options: OPT4, answerKey: 'AC', matched: true }
]);
localdb.saveSetBundle({ setId: 'sC', title: '另一本书 · 第一章' }, [
  { no: 1, stem: 'C1 单选', type: 'single', options: OPT4, answerKey: 'B', matched: true },
  { no: 2, stem: 'C2 判断', type: 'judge', answerKey: 'B', matched: true }
]);

// 造状态：sA 第 2 题曾做错；sC 第 1 题已标记
wrongbook.recordAnswer('sA', { no: 2, stem: 'A2 多选', type: 'multi', options: OPT4, answerKey: 'AB' },
  { correct: false, selected: 'A', mode: 'order', title: '示例题库 · 第一章 常识' });
marks.toggle('sC', '1', '另一本书 · 第一章');

(async () => {
  // ---- 1. 章节维度：按书分组，题量可核 ----
  const grouped = custom.groupedChapters();
  const sampleBook = grouped.filter((b) => b.book === '示例题库')[0];
  eq('按书分组', sorted(grouped.map((b) => b.book)), ['另一本书', '示例题库']);
  eq('分组内章节数', sampleBook.chapters.length, 2);
  eq('组内章节保持生成顺序', sampleBook.chapters.map((c) => c.setId), ['sA', 'sB']);
  eq('书的题量合计', sampleBook.count, 7);
  eq('章节短名', custom.chapters().filter((c) => c.setId === 'sA')[0].chapter, '第一章 常识');

  eq('不限范围时全部题目', custom.survey({}).total, 9);
  eq('只选一章', custom.survey({ setIds: ['sA'] }).total, 4);
  eq('选两章', custom.survey({ setIds: ['sA', 'sB'] }).total, 7);

  // ---- 2. 题型 / 状态维度 ----
  eq('题型：多选', sorted(custom.survey({ types: ['multi'] }).pool.map(uidOf)), ['sA::2', 'sB::3']);
  eq('题型：多选 + 判断', custom.survey({ types: ['multi', 'judge'] }).pool.length, 4);
  eq('状态：曾做错过', custom.survey({ state: 'wrong' }).pool.map(uidOf), ['sA::2']);
  eq('状态：已标记', custom.survey({ state: 'marked' }).pool.map(uidOf), ['sC::1']);
  eq('维度可叠加', custom.survey({ setIds: ['sB'], types: ['multi'] }).pool.map(uidOf), ['sB::3']);
  eq('互斥条件给出空池', custom.survey({ setIds: ['sB'], state: 'marked' }).pool.length, 0);

  // 选项旁边的数量：只排除自己那一维，选它才知道会有多少
  const wrongSurvey = custom.survey({ state: 'wrong' });
  eq('题型计数已叠加状态', wrongSurvey.byType, { single: 0, multi: 1, judge: 0, text: 0 });
  eq('状态计数已叠加题型', custom.survey({ types: ['single'] }).byState, { any: 4, wrong: 0, marked: 1 });

  // ---- 3. 随机抽取与顺序 ----
  const pool = custom.survey({}).pool;
  const top = () => 0.999999;
  eq('抽取指定数量', custom.draw(pool, 5, top).length, 5);
  eq('抽取不重复', uniq(custom.draw(pool, 5).map(uidOf)).length, 5);
  // rng 取上界时不动任何元素 → 说明实现确实是「洗牌后取前 N」
  eq('洗牌后取前 N（上界 rng 保持原序）', custom.draw(pool, 3, top).map(uidOf), pool.slice(0, 3).map(uidOf));
  eq('另一个 rng 下顺序被改变', custom.draw(pool, 9, () => 0).map(uidOf).join() !== pool.map(uidOf).join(), true);
  eq('数量超过池子时全取', custom.draw(pool, 99).length, pool.length);

  // 顺序不能固定：同一批题反复抽，次序必须变
  const seen = {};
  for (let i = 0; i < 40; i++) seen[custom.draw(pool, 3).map(uidOf).join()] = 1;
  eq('多次抽取的次序不固定', Object.keys(seen).length > 1, true);

  // 抽 1 题反复跑：每题都有机会被抽到（不会永远只抽前几题）
  const hits = {};
  for (let i = 0; i < 400; i++) custom.draw(pool, 1).forEach((it) => { hits[uidOf(it)] = 1; });
  eq('候选池内每题都可能被抽到', Object.keys(hits).length, pool.length);

  // ---- 4. 计划的生成与传递 ----
  // 该范围里只有 3 道单选题：要 4 题也只能给 3 题，并如实反映在标题上
  const plan = custom.buildPlan({ setIds: ['sA', 'sB'], types: ['single'] }, 4);
  eq('请求超过候选时取全部', plan.items.length, 3);
  eq('计划题都在范围内', plan.items.every((it) => ['sA', 'sB'].indexOf(it.sid) >= 0), true);
  eq('计划自带范围描述', plan.scope, '2/3 个章节 · 单选题 · 全部题目');
  eq('计划标题带题数', plan.title, '自定义练习 · 3 题');

  const planM = custom.buildPlan({ types: ['multi'] }, 99);
  eq('按题型抽题只落在该题型内', sorted(planM.items.map(uidOf)), ['sA::2', 'sB::3']);

  custom.stash(plan);
  eq('计划可取回', custom.takePlan().items.length, 3);
  eq('计划只活一次', custom.takePlan(), null);

  eq('空池无法建计划', (() => {
    try { custom.buildPlan({ setIds: ['sB'], state: 'marked' }, 5); return 'no-throw'; } catch (e) { return 'throw'; }
  })(), 'throw');

  // ---------------- 页面桩 ----------------
  const pages = {};
  let curKey = '';
  global.Page = (obj) => { pages[curKey] = obj; };
  const loadPage = (key, rel) => {
    curKey = key;
    const p = path.join(BASE, rel);
    delete require.cache[require.resolve(p)];
    require(p);
    curKey = '';
  };
  const newPage = (key) => {
    const p = Object.assign({}, pages[key]);
    p.data = JSON.parse(JSON.stringify(pages[key].data));
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
    return p;
  };

  loadPage('custom', 'pages/custom/custom.js');
  loadPage('quiz', 'pages/quiz/quiz.js');
  loadPage('result', 'pages/result/result.js');
  loadPage('review', 'pages/review/review.js');

  // ---- 5. 自定义页：筛选 → 数量 → 界面文案的联动 ----
  const cp = newPage('custom');
  cp.onLoad();
  await tick();
  eq('统计出全部题目', cp.data.poolTotal, 9);
  eq('默认题量被夹到范围内', cp.data.count, 9);
  eq('夹紧时给出说明', cp.data.warn, '当前范围只有 9 题，本次将抽 9 题');
  eq('范围文案', cp.data.scopeText, '全部章节 · 全部题型 · 全部题目');
  eq('题型选项数量', cp.data.typeChips.map((c) => c.count), [4, 2, 2, 1]);
  eq('状态选项数量', cp.data.stateChips.map((c) => c.count), [9, 1, 1]);
  // 界面靠这个标记把「范围内共 0 题」的选项灰掉（数字本身也是提示，别让用户以为没点中）
  eq('题型选项带空态标记', cp.data.typeChips.map((c) => c.empty), [false, false, false, false]);
  eq('状态选项带空态标记', cp.data.stateChips.map((c) => c.empty), [false, false, false]);

  // 题量预设不能「点了没反应」：范围只有 9 题时，10/20/30/50 全都要置灰并可提示
  eq('超出范围的预设被置灰', cp.data.presets.map((p) => p.off), [true, true, true, true]);
  toasts.length = 0;
  cp.pickPreset({ currentTarget: { dataset: { n: 20 } } });
  eq('点置灰预设给出提示', toasts[toasts.length - 1], '当前范围只有 9 题');
  eq('置灰预设不改题量', cp.data.count, 9);
  eq('题型小结', cp.data.typeText, '不限题型');
  eq('状态小结', cp.data.stateText, '全部题目');
  eq('题量小结', cp.data.countText, '抽 9 题');
  // 每块里写明「点了会做什么」——只剩名称的话，用户得自己去猜
  eq('题型块写明作用', cp.data.typeChips.map((c) => c.sub), ['只抽这类题', '只抽这类题', '只抽这类题', '只抽这类题']);
  eq('状态块写明作用', cp.data.stateChips.map((c) => c.sub), ['不筛选，全都要', '只抽做错过的', '只抽我标记的']);
  eq('预设块写明作用', cp.data.presets.map((p) => p.sub),
    ['本次抽 10 道', '本次抽 20 道', '本次抽 30 道', '本次抽 50 道']);

  // 模板绑定断了（data-* 取到空值）时必须原地返回：
  // 之前 wx:for 少了 wx:for-item，data-n 取到空串 → parseInt 得到 NaN → 题量被静默改成 1 题，
  // 界面上表现成「点了没反应、但底下的题量偷偷变了」，很难查。
  toasts.length = 0;
  cp.pickPreset({ currentTarget: { dataset: { n: '' } } });
  eq('预设拿到空值时不动题量', cp.data.count, 9);
  eq('预设拿到空值时不弹提示', toasts.length, 0);
  cp.toggleType({ currentTarget: { dataset: { k: '' } } });
  eq('题型拿到空值时不改筛选', cp.data.types, []);
  cp.toggleState({ currentTarget: { dataset: { k: '' } } });
  eq('状态拿到空值时不改筛选', cp.data.state, 'any');
  // 正常路径仍然可用
  cp.toggleState({ currentTarget: { dataset: { k: 'wrong' } } });
  eq('正常点状态仍然生效', cp.data.state, 'wrong');
  cp.toggleState({ currentTarget: { dataset: { k: 'any' } } });   // 复原，别影响后面的断言

  cp.toggleScopeAll();
  eq('切换手动后默认全勾', cp.data.setIds.length, 3);
  eq('手动模式下章节计数', cp.data.pickedCount, 3);
  cp.toggleSet({ currentTarget: { dataset: { id: 'sB' } } });
  eq('去掉一章后候选变少', cp.data.poolTotal, 6);
  eq('已选章节数随之更新', cp.data.pickedCount, 2);

  cp.toggleType({ currentTarget: { dataset: { k: 'multi' } } });
  eq('叠加题型后候选再变少', cp.data.poolTotal, 1);
  eq('题量自动夹到新上限', cp.data.count, 1);
  eq('范围文案逐步更新', cp.data.scopeText, '2/3 个章节 · 多选题 · 全部题目');

  cp.toggleState({ currentTarget: { dataset: { k: 'marked' } } });
  eq('状态与范围叠加后为空', cp.data.poolTotal, 0);
  eq('空范围时禁止开始', cp.data.canStart, false);
  eq('空范围给出可操作提示', cp.data.warn, '当前范围内没有符合条件的题目，请放宽上面的条件');

  cp.toggleState({ currentTarget: { dataset: { k: 'any' } } });
  cp.toggleType({ currentTarget: { dataset: { k: 'multi' } } });
  cp.toggleScopeAll();
  eq('回到全部章节', cp.data.poolTotal, 9);

  eq('题量不能超过范围上限', (cp.setCount(1000), cp.data.count), 9);
  eq('步进不低于 1', (cp.setCount(6), cp.stepCount({ currentTarget: { dataset: { d: '-5' } } }), cp.data.count), 1);
  cp.setCount(100);
  eq('输入超上限时夹紧并提示', cp.data.warn, '当前范围只有 9 题，已取全部');

  // 开始：抽题计划落库 + 跳答题页
  cp.setCount(3);
  navs.length = 0;
  cp.start();
  eq('跳转到答题页', navs[0], '/pages/quiz/quiz?setId=__custom__&mode=custom');
  eq('计划已暂存', wx.getStorageSync(custom.PLAN_KEY).items.length, 3);

  // ---- 6. 答题页：跨题库取题、作答写回来源题库 ----
  const qp = newPage('quiz');
  qp.onLoad({ setId: progress.CUSTOM_SCOPE, mode: 'custom' });
  await tick();
  eq('自定义练习已就绪', qp.data.ready, true);
  eq('题量与会话一致', qp.data.total, 3);
  eq('会话标记为自定义', qp.state.custom, true);
  eq('会话题序为跨库 uid', qp.state.order.every((u) => u.indexOf('::') > 0), true);
  eq('uid 不重复', uniq(qp.state.order).length, 3);
  eq('模式标签', qp.data.modeTag, '自定义练习');
  eq('展示本次序号而非原题号', qp.data.cur.no, 1);
  eq('题卡带出来源章节', qp.data.cur.from.indexOf('示例题库') >= 0 || qp.data.cur.from.indexOf('另一本书') >= 0, true);
  eq('计划取用后即清空', wx.getStorageSync(custom.PLAN_KEY), '');

  // 逐题作答（全部答错 + 主观题自评记错），检查错题落到了各自的题库
  for (let i = 0; i < qp.data.total; i++) {
    qp.goto(i);
    const q = qp.curQ;
    if (q.type === 'text' || !q.answerKey) {
      qp.judgeSelf({ currentTarget: { dataset: { ok: '0' } } });
      continue;
    }
    const wrongKey = ['A', 'B', 'C', 'D'].filter((k) => q.answerKey.indexOf(k) < 0)[0];
    qp.tapOption({ currentTarget: { dataset: { key: wrongKey } } });
    qp.confirmAnswer();
  }
  // 每道题都要出现在「它自己那个题库」的错题本里 —— 写错库这里就找不到
  const missing = qp.items.filter((it) => !(wrongbook.getBook(it.sid).items || {})[String(it.no)]);
  eq('错题写回各自的来源题库', missing.map(uidOf), []);
  eq('本次会话记录了全部作答', Object.keys(qp.state.records).length, 3);

  // 标记同样写回来源题库（该题可能此前已被标记过，toggle 会取消 —— 所以按翻转判断）
  qp.goto(1);
  const mkSid = qp.curItem.sid;
  const mkNo = qp.curItem.no;
  const wasMarked = marks.has(mkSid, mkNo);
  const mkBefore = { sA: marks.list('sA').join(), sB: marks.list('sB').join(), sC: marks.list('sC').join() };
  qp.toggleMark();
  eq('标记写回来源题库', marks.has(mkSid, mkNo), !wasMarked);
  eq('题卡标记态与持久化一致', qp.data.marked, !wasMarked);
  // 只有来源题库的标记清单发生变化，别的题库一个字节都不该动
  const mkAfter = { sA: marks.list('sA').join(), sB: marks.list('sB').join(), sC: marks.list('sC').join() };
  eq('标记只改动来源题库', Object.keys(mkBefore).filter((s) => mkBefore[s] !== mkAfter[s]), [mkSid]);

  // 答题卡：序号 1..N + uid 作 key（跨库题号会重复）
  qp.openSheet();
  eq('答题卡按序号显示', qp.data.sheet.grid.map((g) => g.num), [1, 2, 3]);
  eq('答题卡 uid 唯一', uniq(qp.data.sheet.grid.map((g) => g.uid)).length, 3);
  qp.closeSheet();

  // ---- 6.1 未完成时还能继续（沿用原题序与作答记录，不重新抽题） ----
  const qp2 = newPage('quiz');
  qp2.onLoad({ setId: progress.CUSTOM_SCOPE, mode: 'continue' });
  await tick();
  eq('继续未完成的自定义练习', qp2.data.ready, true);
  eq('续做沿用原题序', qp2.state.order.join(), qp.state.order.join());
  eq('续做保留作答记录', Object.keys(qp2.state.records).length, 3);
  eq('续做停在上次位置', qp2.data.idx, qp.data.idx);
  eq('续做仍按自定义练习渲染', qp2.data.isCustom, true);

  // 交卷 → 成绩页
  navs.length = 0;
  qp.finish();
  eq('交卷进成绩页', navs[0], '/pages/result/result?setId=__custom__');

  // ---- 7. 成绩页 / 回顾页认这套跨库会话 ----
  const rp = newPage('result');
  rp.onLoad({ setId: progress.CUSTOM_SCOPE });
  eq('成绩页识别自定义练习', rp.data.custom, true);
  eq('成绩页模式标签', rp.data.modeLabel, '自定义练习');
  eq('成绩页已作答数', rp.data.answered, 3);
  eq('成绩页答错数', rp.data.wrongCount, 3);
  eq('成绩页不套用单库错题本统计', rp.data.wbPending, 0);
  rp.redoAll();
  eq('「再抽一组」回到自定义页', navs[navs.length - 1], '/pages/custom/custom');

  const rv = newPage('review');
  rv.onLoad({ setId: progress.CUSTOM_SCOPE, scope: 'all' });
  eq('回顾页识别自定义练习', rv.data.custom, true);
  eq('回顾题数', rv.data.total, 3);
  eq('回顾按序号展示', rv.data.items.map((it) => it.no), [1, 2, 3]);
  eq('回顾带出来源章节', rv.data.items.every((it) => !!it.from), true);
  eq('回顾错题视角', rv.data.tabs.filter((t) => t.key === 'wrong')[0].count, 3);

  // ---- 8. 题库变化后索引自动重建（缓存不能陈旧） ----
  localdb.saveSetBundle({ setId: 'sD', title: '新书 · 第一章' }, [
    { no: 1, stem: 'D1 单选', type: 'single', options: OPT4, answerKey: 'A', matched: true }
  ]);
  eq('新增题库后统计跟着变', custom.survey({}).total, 10);
  eq('新增题库可被抽到', custom.survey({ setIds: ['sD'] }).pool.map(uidOf), ['sD::1']);

  // 自定义页从别的页面（生成 / 文件库）返回时，题库列表也要跟着更新
  const cp2 = newPage('custom');
  cp2.onLoad();
  await tick();
  const beforeTotal = cp2.data.poolTotal;
  eq('返回前统计', beforeTotal, 10);
  localdb.saveSetBundle({ setId: 'sE', title: '后加的书 · 第一章' }, [
    { no: 1, stem: 'E1', type: 'single', options: OPT4, answerKey: 'A', matched: true }
  ]);
  cp2.onShow();
  eq('返回时题库变化会重建', cp2.data.poolTotal, beforeTotal + 1);
  eq('新章节出现在选择器里', cp2.data.books.filter((b) => b.book === '后加的书').length, 1);

  // 章节序号要按数字排：字符串比较会把第 10 章排到第 2 章前面
  localdb.saveSetBundle({ setId: 'local_1_2', title: '排序书 · 第二章' }, [
    { no: 1, stem: 'E1', type: 'single', options: OPT4, answerKey: 'A', matched: true }
  ]);
  localdb.saveSetBundle({ setId: 'local_1_10', title: '排序书 · 第十章' }, [
    { no: 1, stem: 'E2', type: 'single', options: OPT4, answerKey: 'A', matched: true }
  ]);
  const sortBook = custom.groupedChapters().filter((b) => b.book === '排序书')[0];
  eq('组内章节按序号排', sortBook.chapters.map((c) => c.setId), ['local_1_2', 'local_1_10']);

  // ---- 9. 计划失效时不进入空练习 ----
  const qp3 = newPage('quiz');
  toasts.length = 0;
  navs.length = 0;
  qp3.onLoad({ setId: progress.CUSTOM_SCOPE, mode: 'custom' });
  await tick();
  eq('没有计划时给出可操作提示', toasts, ['练习计划已失效，请重新设定范围']);
  eq('没有计划时不进入答题', qp3.data.ready, false);

  // ---- 10. 指定跨库题单：不靠随机，直接验「各回各家」 ----
  custom.stash({
    items: [{ sid: 'sA', no: '4' }, { sid: 'sB', no: '2' }],
    title: '跨库校验 · 2 题',
    scope: '手选两章 · 全部题型 · 全部题目'
  });
  const qx = newPage('quiz');
  qx.onLoad({ setId: progress.CUSTOM_SCOPE, mode: 'custom' });
  await tick();
  eq('按题单跨库取题', qx.items.map((it) => it.uid), ['sA::4', 'sB::2']);
  eq('题单顺序即呈现顺序', qx.state.order, ['sA::4', 'sB::2']);
  eq('题卡标出第一题的来源章节', qx.data.cur.from, '示例题库 · 第一章 常识');

  // 第 1 题是 sA 的主观题：自评测错
  qx.judgeSelf({ currentTarget: { dataset: { ok: '0' } } });
  eq('主观题自评写入 sA 的错题本', !!(wrongbook.getBook('sA').items['4']), true);

  // 第 2 题是 sB 的单选：故意答错
  qx.next();
  eq('翻页后来源章节跟着变', qx.data.cur.from, '示例题库 · 第二章 数量');
  const q2 = qx.curQ;
  qx.tapOption({
    currentTarget: { dataset: { key: ['A', 'B', 'C', 'D'].filter((k) => q2.answerKey.indexOf(k) < 0)[0] } }
  });
  qx.confirmAnswer();
  eq('sB 的题写进 sB 的错题本', !!(wrongbook.getBook('sB').items['2']), true);
  eq('没有把 sA 的题错记到 sB 的错题本', !wrongbook.getBook('sB').items['4'], true);
  qx.goto(0);
  marks.remove('sA', '4');   // 清掉历史标记，让断言只反映这一次操作
  qx.toggleMark();
  eq('标记也写在题目自己的题库上', marks.has('sA', '4'), true);
  eq('没有写到别的题库', marks.has('sB', '4'), false);

  // ---- 11. 首页「继续刷题」认得自定义练习 ----
  loadPage('index', 'pages/index/index.js');
  const ip = newPage('index');
  await ip.refresh();
  eq('首页继续卡片认得自定义练习', !!(ip.data.continueCard && ip.data.continueCard.custom), true);
  eq('继续卡片带上会话标题', ip.data.continueCard.title, '跨库校验 · 2 题');
  eq('继续卡片带出进度', ip.data.continueCard.total, 2);
  navs.length = 0;
  ip.goContinue();
  eq('点继续回到自定义练习', navs[navs.length - 1], '/pages/quiz/quiz?setId=__custom__&mode=continue&title=');

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
