// apis/listErrataItems.js —— 查看校对（勘误）清单
//
// 逐字复刻主包 pages/errata/errata.js:44-101 refresh() 的分组/筛选逻辑，
// 字段集对齐同文件 mapItem()（errata.js:103-121），差异对比沿用
// FIELDS 常量与「修正值非空且与原值不同」判定（errata.js:11-16、106-108）。
const { successResult, errorResult } = require('../utils/util');
const errata = require('../utils/errata');

// 与 pages/errata/errata.js:11-16 完全一致
const FIELDS = [
  ['stem', '题干'],
  ['options', '选项'],
  ['answer', '答案'],
  ['explanation', '解析']
];

// 与 pages/errata/errata.js:4-8 一致
const TABS = [
  { key: 'open', label: '待修' },
  { key: 'fixed', label: '已修' },
  { key: 'all', label: '全部' }
];

const MAX_LIMIT = 100;

async function listErrataItems(params = {}) {
  const setId = params.setId || '';
  const filter = params.filter || 'open';
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 20, 1), MAX_LIMIT);
  console.info('[ai-mode] listErrataItems 入口, setId =', setId, 'filter =', filter, 'limit =', limit);

  try {
    const books = errata.listBooks().map((b) => {
      const s = errata.statsOf(b);
      return { setId: b.setId, title: b.title || '未命名题库', total: s.total, open: s.open, fixed: s.fixed };
    }).filter((b) => b.total > 0);

    const sum = errata.summary();

    // 与 errata.js:53-55 一致：传入的 setId 不在列表里则回退为全部
    let scope = setId;
    if (scope && !books.some((b) => b.setId === scope)) scope = '';
    const scoped = scope ? books.filter((b) => b.setId === scope) : books;

    const counts = { total: 0, open: 0, fixed: 0 };
    scoped.forEach((b) => {
      counts.total += b.total;
      counts.open += b.open;
      counts.fixed += b.fixed;
    });
    const tabCounts = { open: counts.open, fixed: counts.fixed, all: counts.total };

    // 与 errata.js:65-70 一致：当前视图为空时依次回退
    let tab = filter;
    if (!tabCounts[tab]) {
      if (tabCounts.open) tab = 'open';
      else if (tabCounts.fixed) tab = 'fixed';
      else tab = 'all';
    }

    const groups = [];
    let remain = limit;
    scoped.forEach((b) => {
      if (remain <= 0) return;
      const items = errata.listItems(b.setId, tab);
      if (!items.length) return;
      const taken = items.slice(0, remain);
      remain -= taken.length;
      groups.push({
        setId: b.setId,
        title: b.title,
        count: items.length,
        items: taken.map((it) => {
          const o = it.original || {};
          const f = it.fix || {};
          // errata.js:106-108 的差异判定
          const diffs = FIELDS
            .filter((pair) => (f[pair[0]] || '').trim() && (f[pair[0]] || '').trim() !== (o[pair[0]] || '').trim())
            .map((pair) => ({ key: pair[0], label: pair[1], from: o[pair[0]] || '（空）', to: f[pair[0]] }));
          return {
            // key 与 pages/errata/errata.js:110 一致
            key: `${b.setId}_${it.no}`,
            setId: b.setId,
            setTitle: b.title,
            no: it.no,
            typeLabels: it.typeLabels,
            status: it.status,
            pending: it.pending,
            note: f.note || '',
            hasDiff: diffs.length > 0,
            diffs,
            // errata.js:119：只列原值非空的字段
            originals: FIELDS
              .filter((pair) => (o[pair[0]] || '').trim())
              .map((pair) => ({ key: pair[0], label: pair[1], text: o[pair[0]] }))
          };
        })
      });
    });

    const shown = groups.reduce((a, g) => a + g.items.length, 0);
    const tabLabel = (TABS.filter((t) => t.key === tab)[0] || {}).label || '待修';
    const scopeTitle = scope
      ? (books.filter((b) => b.setId === scope)[0] || {}).title || '当前题库'
      : '全部题库';

    console.info('[ai-mode] listErrataItems 出口, 视图 =', tab, '返回 =', shown);
    if (!shown) {
      return successResult(
        tab === 'fixed' ? '还没有标记为已修的记录。' : '还没有校对记录。刷题时点题卡右上角「纠错」即可记录。',
        { scopeTitle, tab, tabLabel, counts: tabCounts, sum, groups: [], total: 0, shown: 0 }
      );
    }

    return successResult(
      `${scopeTitle}的${tabLabel}记录共 ${tabCounts[tab]} 条，本次列出 ${shown} 条。`,
      { scopeTitle, tab, tabLabel, counts: tabCounts, sum, groups, total: tabCounts[tab], shown }
    );
  } catch (err) {
    console.error('[ai-mode] listErrataItems 出错:', err.message);
    return errorResult(`查询校对清单失败: ${err.message}`);
  }
}

module.exports = { listErrataItems };
