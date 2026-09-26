// apis/listWrongItems.js —— 查看错题
//
// 逐字复刻主包 pages/wrong/wrong.js:43-113 refresh() 的分组与筛选逻辑，
// 字段集对齐同文件 mapItem()（wrong.js:121-143）。排序沿用
// utils/wrongbook.js:94-102 sortItems()（错误次数降序 → 最近答错降序 → 题号升序）。
const { successResult, errorResult, formatTime } = require('../utils/util');
const wrongbook = require('../utils/wrongbook');

// 与 pages/wrong/wrong.js:5 一致
const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };

// 与 pages/wrong/wrong.js:8-12 的三个视图一致
const TABS = [
  { key: 'hard', label: '易错题' },
  { key: 'pending', label: '全部错题' },
  { key: 'mastered', label: '已掌握' }
];

const MAX_LIMIT = 100;

async function listWrongItems(params = {}) {
  const setId = params.setId || '';
  const filter = params.filter || 'pending';
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 20, 1), MAX_LIMIT);
  console.info('[ai-mode] listWrongItems 入口, setId =', setId, 'filter =', filter, 'limit =', limit);

  try {
    // wrongbook.listBooks() 内部会跳过空错题本并顺手删键（wrongbook.js:46-64）
    const books = wrongbook.listBooks().map((b) => {
      const s = wrongbook.statsOf(b);
      return {
        setId: b.setId,
        title: b.title || '未命名题库',
        total: s.total,
        pending: s.pending,
        hard: s.hard,
        mastered: s.mastered
      };
    }).filter((b) => b.total > 0);

    const sum = wrongbook.summary();

    // 与 wrong.js:60-62 一致：传入的 setId 不在列表里则回退为全部
    let scope = setId;
    if (scope && !books.some((b) => b.setId === scope)) scope = '';
    const scoped = scope ? books.filter((b) => b.setId === scope) : books;

    const counts = { hard: 0, pending: 0, mastered: 0 };
    scoped.forEach((b) => {
      counts.hard += b.hard;
      counts.pending += b.pending;
      counts.mastered += b.mastered;
    });

    // 与 wrong.js:75-81 一致：当前视图为空时自动落到有内容的视图
    let tab = filter;
    if (!counts[tab]) {
      if (counts.hard) tab = 'hard';
      else if (counts.pending) tab = 'pending';
      else if (counts.mastered) tab = 'mastered';
    }

    const groups = [];
    let remain = limit;
    scoped.forEach((b) => {
      if (remain <= 0) return;
      const items = wrongbook.listItems(b.setId, tab);
      if (!items.length) return;
      const taken = items.slice(0, remain);
      remain -= taken.length;
      groups.push({
        setId: b.setId,
        title: b.title,
        count: items.length,
        items: taken.map((it) => ({
          // key 与 pages/wrong/wrong.js:122 一致
          key: `${b.setId}_${it.no}`,
          setId: b.setId,
          setTitle: b.title,
          no: it.no,
          typeLabel: TYPE_LABEL[it.type] || it.type,
          stem: it.stem || '（题干为空）',
          wrongCount: it.wrongCount || 0,
          rightCount: it.rightCount || 0,
          attempts: it.attempts || 0,
          errRate: it.errRate,
          hard: it.hard,
          mastered: !!it.mastered,
          answer: it.answer || '',
          answerKey: it.answerKey || '',
          explanation: it.explanation || '',
          lastSelected: it.lastSelected || '',
          lastWrongText: it.lastWrongAt ? formatTime(it.lastWrongAt) : ''
        }))
      });
    });

    const shown = groups.reduce((a, g) => a + g.items.length, 0);
    const tabLabel = (TABS.filter((t) => t.key === tab)[0] || {}).label || '错题';

    console.info('[ai-mode] listWrongItems 出口, 视图 =', tab, '返回 =', shown);
    if (!shown) {
      const tip = tab === 'hard'
        ? '还没有易错题。错 2 次以上的题会自动归入这里。'
        : tab === 'mastered'
          ? '还没有已掌握的错题。错题连续答对 2 次会自动归入这里。'
          : '错题本是空的，先去刷几道题。';
      return successResult(tip, {
        scopeTitle: scope ? (books.filter((b) => b.setId === scope)[0] || {}).title || '当前题库' : '全部题库',
        tab,
        tabLabel,
        counts,
        sum,
        groups: [],
        total: 0,
        shown: 0
      });
    }

    return successResult(
      `${tabLabel}共 ${counts[tab]} 道，本次列出 ${shown} 道。`,
      {
        scopeTitle: scope ? (books.filter((b) => b.setId === scope)[0] || {}).title || '当前题库' : '全部题库',
        tab,
        tabLabel,
        counts,
        sum,
        groups,
        total: counts[tab],
        shown
      }
    );
  } catch (err) {
    console.error('[ai-mode] listWrongItems 出错:', err.message);
    return errorResult(`查询错题失败: ${err.message}`);
  }
}

module.exports = { listWrongItems };
