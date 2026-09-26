// 错题本页面逻辑集成测试（模拟 Page / wx 环境，无需微信开发者工具）
// 运行：node _smoke/wrongpage.test.js
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const routes = [];
let modalConfirm = true;

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { if (o.success) o.success({ confirm: modalConfirm }); },
  navigateTo: (o) => routes.push(o.url),
  redirectTo: (o) => routes.push(o.url),
  switchTab: (o) => routes.push(o.url),
  stopPullDownRefresh: () => {}
};
global.getApp = () => ({ globalData: {} });

const wb = require(path.join(BASE, 'utils/wrongbook.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ---- 造数据：s1 有 3 条错题（其中 1 号错 2 次=易错），s2 有 1 条错题 ----
// 冻结时间：排序次键是「最近答错时间」，若几条记录落在不同毫秒，断言就变成看运气。
// 固定时间后顺序完全确定，测的是排序规则本身而不是运行速度。
const realNow = Date.now;
const FIXED_NOW = 1789000000000;
Date.now = () => FIXED_NOW;

const Q = (no) => ({ no, stem: `题干${no}`, type: 'single', answerKey: 'A', explanation: `解析${no}` });
wb.recordAnswer('s1', Q(1), { correct: false, mode: 'order', title: '题库一' });
wb.recordAnswer('s1', Q(1), { correct: false, mode: 'wrong' });
wb.recordAnswer('s1', Q(2), { correct: false, title: '题库一' });
wb.recordAnswer('s1', Q(3), { correct: false, title: '题库一' });
wb.recordAnswer('s2', Q(5), { correct: false, title: '题库二' });

Date.now = realNow;

// ---- 加载页面 ----
let captured = null;
global.Page = (obj) => { captured = obj; };
require(path.join(BASE, 'pages/wrong/wrong.js'));
const page = Object.assign({}, captured);
page.data = JSON.parse(JSON.stringify(captured.data));
page.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb(); };

page.refresh();
eq('汇总 待攻克', page.data.sum.pending, 4);
eq('汇总 易错', page.data.sum.hard, 1);
eq('汇总 涉及题库', page.data.sum.sets, 2);
eq('默认视图', page.data.tab, 'hard');
eq('易错分组数', page.data.groups.length, 1);
eq('易错分组题目', page.data.groups[0].items.map((i) => i.no), ['1']);
eq('易错项错误次数', page.data.groups[0].items[0].wrongCount, 2);
eq('筛选项数（全部+2库）', page.data.setFilter.length, 3);
eq('tab 计数', page.data.tabs.map((t) => t.count), [1, 4, 0]);

// 未展开时不该抛出（this.expanded 懒初始化）
eq('初始未展开', page.data.groups[0].items[0].expanded, false);

// ---- 切到「全部错题」 ----
page.changeTab({ currentTarget: { dataset: { tab: 'pending' } } });
eq('全部错题分组数', page.data.groups.length, 2);
eq('全部错题总数', page.data.groups.reduce((n, g) => n + g.items.length, 0), 4);
eq('分组内按错误次数降序，次数相同时按题号升序', page.data.groups[0].items.map((i) => i.no), ['1', '2', '3']);

// ---- 展开 / 收起 ----
const key0 = page.data.groups[0].items[0].key;
page.toggleItem({ currentTarget: { dataset: { key: key0 } } });
eq('展开后 expanded', page.data.groups[0].items[0].expanded, true);
page.toggleItem({ currentTarget: { dataset: { key: key0 } } });
eq('再点收起', page.data.groups[0].items[0].expanded, false);

// ---- 按题库筛选 ----
page.switchSet({ currentTarget: { dataset: { id: 's2' } } });
eq('筛选后仅 s2', page.data.groups.map((g) => g.setId), ['s2']);
eq('筛选后范围标题', page.data.scopeTitle, '题库二');

page.switchSet({ currentTarget: { dataset: { id: '' } } });
eq('取消筛选', page.data.groups.length, 2);

// ---- 单题重练 / 整库重练 URL ----
routes.length = 0;
page.retrainItem({ currentTarget: { dataset: { sid: 's1', no: '2' } } });
eq('单题重练 URL', routes[0],
  '/pages/quiz/quiz?setId=s1&mode=wrong&title=%E9%A2%98%E5%BA%93%E4%B8%80&nos=2');

routes.length = 0;
page.changeTab({ currentTarget: { dataset: { tab: 'hard' } } });
page.retrainGroup({ currentTarget: { dataset: { id: 's1' } } });
eq('易错题整库重练用 hard 模式', routes[0],
  '/pages/quiz/quiz?setId=s1&mode=hard&title=%E9%A2%98%E5%BA%93%E4%B8%80');

// ---- 标记掌握 / 移回 ----
page.markMastered({ currentTarget: { dataset: { sid: 's1', no: '1' } } });
eq('标记掌握后 pending', page.data.sum.pending, 3);
eq('标记掌握后 mastered', page.data.sum.mastered, 1);
eq('已掌握视图', page.data.tabs.map((t) => t.count), [0, 3, 1]);

page.unmarkMastered({ currentTarget: { dataset: { sid: 's1', no: '1' } } });
eq('移回待攻克', page.data.sum.pending, 4);

// ---- 移出错题本（确认框确认） ----
modalConfirm = true;
page.removeItem({ currentTarget: { dataset: { sid: 's1', no: '3' } } });
eq('移出后 s1 错题数', wb.stats('s1').total, 2);
eq('移出后总计', page.data.sum.pending, 3);

// ---- 清空该题库错题本 ----
page.switchSet({ currentTarget: { dataset: { id: 's2' } } });
page.clearScope({});
eq('清空 s2 后合计', page.data.sum.pending, 2);
eq('清空后回到全部题库', page.data.setId, '');

// ---- 空态 ----
wb.clearBook('s1');
page.refresh();
eq('全空后 groups', page.data.groups.length, 0);
eq('全空后提示', !!page.data.emptyTip, true);

// ---- globalData 传参进入（从首页/结果页跳转） ----
wb.recordAnswer('s9', Q(1), { correct: false, title: '题库九' });
const app = { globalData: { wrongFilter: 's9' } };
global.getApp = () => app;
page.onShow();
eq('进入时应用筛选题库', page.data.setId, 's9');
eq('筛选后只剩 s9', page.data.groups.map((g) => g.setId), ['s9']);
eq('globalData 已消费', app.globalData.wrongFilter, null);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
