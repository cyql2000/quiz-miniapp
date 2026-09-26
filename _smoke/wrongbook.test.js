// 错题本逻辑冒烟测试（无需微信环境）
// 运行：node _smoke/wrongbook.test.js
// 为 wrongbook.js 提供内存版 wx 存储，验证收录 / 易错判定 / 掌握 / 聚合等规则
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');
const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) })
};

const wb = require(path.join(BASE, 'utils/wrongbook.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const Q = (no, ans) => ({
  no, stem: `第${no}题题干`, type: 'single',
  options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
  answerKey: ans, answer: '', explanation: `解析${no}`
});
const SET = 'set_demo', T = '示例题库';

// 1. 一次答对的题不入错题本
eq('一次答对不入本', wb.recordAnswer(SET, Q(1, 'A'), { correct: true, title: T }), null);
eq('  空本', wb.stats(SET).total, 0);

// 2. 答错 → 收录
const it2 = wb.recordAnswer(SET, Q(2, 'B'), { correct: false, selected: 'A', mode: 'order', title: T });
eq('答错收录 wrongCount', it2.wrongCount, 1);
eq('答错收录 attempts', it2.attempts, 1);
eq('答错后 pending', wb.stats(SET).pending, 1);
eq('错 1 次不算易错', wb.stats(SET).hard, 0);
eq('题干快照', wb.getBook(SET).items['2'].stem, '第2题题干');

// 3. 同一题再错 → 易错
const it3 = wb.recordAnswer(SET, Q(2, 'B'), { correct: false, selected: 'B', mode: 'wrong' });
eq('二次答错 wrongCount', it3.wrongCount, 2);
eq('二次答错 errRate', it3.errRate, 100);
eq('错 2 次判为易错', wb.stats(SET).hard, 1);
eq('易错在 hard 列表', wb.listItems(SET, 'hard').map((i) => i.no), ['2']);

// 4. 连对 2 次 → 掌握
wb.recordAnswer(SET, Q(2, 'B'), { correct: true, selected: 'B' });
eq('对 1 次未掌握', wb.stats(SET).mastered, 0);
const it5 = wb.recordAnswer(SET, Q(2, 'B'), { correct: true, selected: 'B' });
eq('连对 2 次已掌握', it5.mastered, true);
eq('掌握后 pending', wb.stats(SET).pending, 0);
eq('掌握后 hard', wb.stats(SET).hard, 0);
eq('掌握进 mastered 列表', wb.listItems(SET, 'mastered').map((i) => i.no), ['2']);

// 5. 掌握后再答错 → 回落待攻克
const it6 = wb.recordAnswer(SET, Q(2, 'B'), { correct: false, selected: 'A' });
eq('再错回落待攻克', [it6.mastered, it6.streak, it6.wrongCount], [false, 0, 3]);
eq('回落 pending', wb.stats(SET).pending, 1);

// 6. 多题库聚合 + 排序（错得多的排前面）
wb.recordAnswer('set_b', Q(7, 'A'), { correct: false, title: '题库B' });
wb.recordAnswer('set_b', Q(3, 'A'), { correct: false, title: '题库B' });
wb.recordAnswer('set_b', Q(3, 'A'), { correct: false });
wb.recordAnswer('set_b', Q(3, 'A'), { correct: false });
eq('排序按错误次数', wb.listItems('set_b', 'pending').map((i) => i.no), ['3', '7']);
eq('localStorage keys', wb.listBooks().length, 2);

const sum = wb.summary();
eq('summary.sets', sum.sets, 2);
eq('summary.pending', sum.pending, 3);
eq('summary.hard', sum.hard, 2);
eq('summary.mastered', sum.mastered, 0);

// 7. 掌握 / 移出 / 清空
wb.setMastered('set_b', '7', true);
eq('手动标记掌握', wb.stats('set_b').pending, 1);
wb.setMastered('set_b', '7', false);
eq('移回待攻克', wb.stats('set_b').pending, 2);
wb.removeItem('set_b', '3');
eq('移出后', wb.stats('set_b').total, 1);
wb.clearBook('set_b');
eq('清空后', wb.stats('set_b').total, 0);
wb.removeBook(SET);
eq('删除错题本', wb.stats(SET).total, 0);
eq('删除后 book 列表', wb.listBooks().length, 0);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
