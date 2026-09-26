const errata = require('../../utils/errata');
const safe = require('../../utils/safestore');

const TABS = [
  { key: 'open', label: '待修' },
  { key: 'fixed', label: '已修' },
  { key: 'all', label: '全部' }
];

// 参与"原值 → 修正值"对比的字段
const FIELDS = [
  ['stem', '题干'],
  ['options', '选项'],
  ['answer', '答案'],
  ['explanation', '解析']
];

Page({
  data: {
    loading: true,
    tabs: [],
    tab: 'open',
    tabLabel: '待修',
    setId: '',
    setFilter: [],
    scopeTitle: '全部题库',
    groups: [],
    sum: { sets: 0, total: 0, open: 0, fixed: 0 },
    scope: { total: 0, open: 0, fixed: 0 },
    sheet: { show: false, setId: '', title: '', question: null },
    emptyTip: ''
  },

  onShow() {
    const app = getApp();
    if (app && app.globalData && app.globalData.errataFilter != null) {
      const fid = app.globalData.errataFilter;
      app.globalData.errataFilter = null;
      this.setData({ setId: fid || '', tab: 'open' });
    }
    this.refresh();
  },

  refresh() {
    const books = errata.listBooks().map((b) => {
      const s = errata.statsOf(b);
      return { setId: b.setId, title: b.title || '未命名题库', total: s.total, open: s.open, fixed: s.fixed };
    }).filter((b) => b.total > 0);

    const sum = errata.summary();

    let scoped = books;
    let setId = this.data.setId;
    if (setId && !books.some((b) => b.setId === setId)) setId = '';
    if (setId) scoped = books.filter((b) => b.setId === setId);

    const scope = { total: 0, open: 0, fixed: 0 };
    scoped.forEach((b) => {
      scope.total += b.total;
      scope.open += b.open;
      scope.fixed += b.fixed;
    });

    const counts = { open: scope.open, fixed: scope.fixed, all: scope.total };
    let tab = this.data.tab;
    if (!counts[tab]) {
      if (counts.open) tab = 'open';
      else if (counts.fixed) tab = 'fixed';
      else tab = 'all';
    }

    const groups = [];
    scoped.forEach((b) => {
      const items = errata.listItems(b.setId, tab);
      if (!items.length) return;
      groups.push({
        setId: b.setId,
        title: b.title,
        count: items.length,
        items: items.map((it) => this.mapItem(it, b))
      });
    });

    const setFilter = [{ setId: '', title: '全部题库', count: sum.open }].concat(
      books.map((b) => ({ setId: b.setId, title: b.title, count: b.open }))
    );

    this.setData({
      loading: false,
      setId,
      setFilter,
      scope,
      scopeTitle: setId ? ((books.find((b) => b.setId === setId) || {}).title || '当前题库') : '全部题库',
      sum,
      tab,
      tabLabel: (TABS.find((t) => t.key === tab) || {}).label || '待修',
      tabs: TABS.map((t) => ({ ...t, count: counts[t.key] })),
      groups,
      emptyTip: tab === 'fixed' ? '还没有标记为已修的记录。' : '还没有校对记录。刷题时点题卡右上角「纠错」即可记录。'
    });
  },

  mapItem(it, book) {
    const o = it.original || {};
    const f = it.fix || {};
    const diffs = FIELDS
      .filter(([k]) => (f[k] || '').trim() && (f[k] || '').trim() !== (o[k] || '').trim())
      .map(([k, label]) => ({ key: k, label, from: o[k] || '（空）', to: f[k] }));
    return {
      key: `${book.setId}_${it.no}`,
      setId: book.setId,
      setTitle: book.title,
      no: it.no,
      typeLabels: it.typeLabels,
      pending: it.pending,
      note: f.note || '',
      diffs,
      hasDiff: diffs.length > 0,
      originals: FIELDS.filter(([k]) => (o[k] || '').trim()).map(([k, label]) => ({ key: k, label, text: o[k] }))
    };
  },

  changeTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab }, () => this.refresh());
  },

  switchSet(e) {
    const setId = e.currentTarget.dataset.id || '';
    this.setData({ setId }, () => this.refresh());
  },

  toggleItem(e) {
    const key = e.currentTarget.dataset.key;
    const groups = this.data.groups.map((g) => ({
      ...g,
      items: g.items.map((it) => (it.key === key ? { ...it, expanded: !it.expanded } : it))
    }));
    this.setData({ groups });
  },

  // ---------- 操作 ----------
  openEdit(e) {
    const { sid, no } = e.currentTarget.dataset;
    const g = this.data.groups.find((x) => x.setId === sid);
    this.setData({
      sheet: { show: true, setId: sid, title: (g && g.title) || '', question: { no } }
    });
  },

  closeSheet() {
    this.setData({ 'sheet.show': false });
  },

  onSaved() {
    this.surfaceStorageError();
    this.refresh();
  },

  // 校对记录写失败不能静默：否则用户以为改好了，回源头文件时对不上
  surfaceStorageError() {
    const p = safe.take();
    if (!p) return false;
    wx.showModal({ title: '记录未能保存', content: p.message, showCancel: false });
    return true;
  },

  toggleStatus(e) {
    const { sid, no, pending } = e.currentTarget.dataset;
    errata.setStatus(sid, no, pending ? 'fixed' : 'open');
    wx.showToast({ title: pending ? '已标记为已修' : '已回退为待修', icon: 'none' });
    this.surfaceStorageError();
    this.refresh();
  },

  removeItem(e) {
    const { sid, no } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除记录',
      content: `确定删除第 ${no} 题的校对记录吗？`,
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        errata.removeItem(sid, no);
        wx.showToast({ title: '已删除', icon: 'success' });
        that.refresh();
      }
    });
  },

  copyItem(e) {
    const { sid, no } = e.currentTarget.dataset;
    const text = errata.exportText(sid).split(/\n(?=【题号 )/).find((seg) => seg.indexOf(`【题号 ${no}】`) === 0);
    wx.setClipboardData({ data: text || '', success: () => wx.showToast({ title: '已复制', icon: 'success' }) });
  },

  copyAll() {
    let text = '';
    if (this.data.setId) {
      text = errata.exportText(this.data.setId);
    } else {
      text = errata.listBooks().map((b) => errata.exportText(b.setId)).join('\n');
    }
    if (!text.trim()) {
      wx.showToast({ title: '暂无记录', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showModal({
        title: '已复制到剪贴板',
        content: '清单已复制，粘到备忘录或校对表里，就可以对着改源文件了。',
        showCancel: false
      })
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
