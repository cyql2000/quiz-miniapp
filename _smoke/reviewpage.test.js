// 整卷回顾页（pages/review）
// 运行：node _smoke/reviewpage.test.js
//
// 覆盖：题源取法、三种筛选、分片渲染（题量大时不能一次 setData）、
//       空维度回退、无会话时退回整本题库、无标准答案题的目标态。
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const urls = [];

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { if (o.success) o.success({ confirm: true }); },
  navigateTo: (o) => urls.push(o.url),
  navigateBack: () => {},
  switchTab: (o) => urls.push(o.url),
  pageScrollTo: () => {},
  setNavigationBarTitle: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const localdb = require(path.join(BASE, 'utils/localdb.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const marks = require(path.join(BASE, 'utils/marks.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ---- 造数据：25 题；1-5 答对、6-10 答错、11-25 未作答；标记 2 与 7 ----
const N = 25;
const LETTERS = ['A', 'B', 'C', 'D'];
const questions = [];
for (let i = 1; i <= N; i++) {
  questions.push({
    no: i,
    stem: '题干' + i,
    type: 'single',
    options: LETTERS.map((k) => ({ key: k, text: k + '选项' + i })),
    answerKey: 'A',
    explanation: '解析' + i,
    matched: true
  });
}
// 一道没有标准答案的主观题，验证不红绿判定
questions.push({ no: 99, stem: '简答题', type: 'text', options: [], answer: '参考答案', explanation: '解析99', matched: false });

localdb.saveSetBundle({ setId: 'sr', title: '回顾库' }, questions);
localdb.saveSetBundle({ setId: 'sblank', title: '空白库' }, questions.slice(0, 3));

const order = questions.filter((q) => q.type !== 'text').map((q) => String(q.no));
const st = progress.createState('sr', '回顾库', 'order', order);
const records = {};
for (let i = 1; i <= 5; i++) records[String(i)] = { selected: ['A'], answered: true, correct: true, reveal: true };
for (let i = 6; i <= 10; i++) records[String(i)] = { selected: ['B'], answered: true, correct: false, reveal: true };
st.records = records;
st.finished = true;
progress.saveState(st);
marks.toggle('sr', 2, '回顾库');
marks.toggle('sr', 7, '回顾库');

// ---- 页面桩 ----
let captured = null;
global.Page = (obj) => { captured = obj; };
require(path.join(BASE, 'pages/review/review.js'));

function newPage() {
  const p = Object.assign({}, captured);
  p.data = JSON.parse(JSON.stringify(captured.data));
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
    if (cb) cb();
  };
  return p;
}

console.log('=== 1. 打开时取本次会话的整卷 ===');
const p1 = newPage();
p1.onLoad({ setId: 'sr', scope: 'all' });
eq('已加载', p1.data.loaded, true);
eq('标题', p1.data.title, '回顾库');
eq('练习模式', p1.data.modeLabel, '顺序练习');
eq('整卷题数（不含主观题，主观题不在 order 里）', p1.data.total, N);
eq('三个筛选维度的计数', p1.data.tabs.map((t) => t.count), [N, 5, 2]);
eq('底部按钮用的错题数', p1.data.wrongN, 5);
eq('底部按钮用的标记数', p1.data.markedN, 2);

console.log('\n=== 2. 分片渲染：一次只给前 20 条，避免上千题一次 setData ===');
eq('首次渲染条数', p1.data.items.length, 20);
eq('已展示计数', p1.data.shown, 20);
eq('还有更多', p1.data.hasMore, true);

p1.loadMore();
eq('加载更多后条数', p1.data.items.length, N);
eq('到底后 hasMore 关闭', p1.data.hasMore, false);
p1.loadMore();
eq('到底后再触发不越界', p1.data.items.length, N);

console.log('\n=== 3. 逐题内容：我的作答 / 正确答案 / 解析 / 选项着色 ===');
const it1 = p1.data.items[0];
eq('答对题的我方作答', it1.myAnswer, 'A');
eq('答对标记', it1.isCorrect, true);
eq('正确答案', it1.correctAnswer, 'A');
eq('解析带出', it1.explanation, '解析1');
eq('选项 A 标为正确项', it1.options[0].cls, 'rv-right');

const it6 = p1.data.items[5];
eq('答错题的我方作答', it6.myAnswer, 'B');
eq('答错标记', it6.isWrong, true);
eq('答错题正确项仍是 A', it6.options[0].cls, 'rv-right');
eq('答错时我选的 B 标红', it6.options[1].cls, 'rv-wrong');
eq('未选中的 C 不着色', it6.options[2].cls, '');

const it11 = p1.data.items[10];
eq('未作答题的提示', it11.myAnswer, '未作答');
eq('未作答不算答错', it11.isWrong, false);

console.log('\n=== 4. 只看错题 ===');
p1.changeScope({ currentTarget: { dataset: { scope: 'wrong' } } });
eq('筛选题号', p1.data.items.map((x) => x.no), ['6', '7', '8', '9', '10']);
eq('筛选后题数', p1.data.total, 5);
eq('筛选后无需分页', p1.data.hasMore, false);
eq('全是答错的', p1.data.items.every((x) => x.isWrong), true);

console.log('\n=== 5. 只看标记 ===');
p1.changeScope({ currentTarget: { dataset: { scope: 'marked' } } });
eq('标记题号', p1.data.items.map((x) => x.no), ['2', '7']);
eq('标记题数', p1.data.total, 2);
eq('切换筛选后回到第一页长度', p1.data.shown, 2);

console.log('\n=== 6. 回到全部 ===');
p1.changeScope({ currentTarget: { dataset: { scope: 'all' } } });
eq('回到全部后重新分页', [p1.data.total, p1.data.shown, p1.data.hasMore], [N, 20, true]);

console.log('\n=== 7. 空维度自动回退到「全部」，不留白页 ===');
const p2 = newPage();
p2.onLoad({ setId: 'sblank', scope: 'marked' });
eq('该库没有标记，回退为全部', p2.data.scope, 'all');
eq('回退后有条目', p2.data.items.length > 0, true);

console.log('\n=== 8. 没有会话时退回整本题库（从首页直接进来）===');
const p3 = newPage();
p3.onLoad({ setId: 'sblank', scope: 'all' });
eq('题数等于整本题库', p3.data.total, 3);
eq('未练习的标记', p3.data.modeLabel, '尚未练习');
eq('全部显示未作答', p3.data.items.map((x) => x.myAnswer), ['未作答', '未作答', '未作答']);

console.log('\n=== 9. 主观题（无标准答案）不参与红绿判定 ===');
localdb.saveSetBundle({ setId: 'stext', title: '主观库' }, [
  { no: 1, stem: '简答', type: 'text', options: [], answer: '参考答案', explanation: '解析', matched: false }
]);
const tst = progress.createState('stext', '主观库', 'order', ['1']);
tst.records = { '1': { answered: true, manual: 'right', correct: true, reveal: true } };
progress.saveState(tst);
const p4 = newPage();
p4.onLoad({ setId: 'stext', scope: 'all' });
const tit = p4.data.items[0];
eq('主观题无选项', tit.hasOptions, false);
eq('主观题展示参考答案', tit.correctAnswer, '参考答案');
eq('自评答对计入', tit.isCorrect, true);
eq('标注为自评', tit.selfJudged, true);

console.log('\n=== 10. 底部入口：无线索时给出提示而不是跳空页 ===');
toasts.length = 0;
p2.goMarked();
eq('无标记题时不跳转', urls.filter((u) => u.indexOf('mode=marked') >= 0).length, 0);
eq('并给出提示', toasts, ['这套题暂无标记题']);

p1.goMarked();
eq('有标记题时跳标记题重练', urls[urls.length - 1], '/pages/quiz/quiz?setId=sr&mode=marked&title=' + encodeURIComponent('回顾库'));
p1.goWrong();
eq('错题重练跳转', urls[urls.length - 1], '/pages/quiz/quiz?setId=sr&mode=wrong&title=' + encodeURIComponent('回顾库'));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
