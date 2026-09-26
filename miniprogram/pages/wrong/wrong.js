const wrongbook = require('../../utils/wrongbook');
const safe = require('../../utils/safestore');
const { formatTime } = require('../../utils/util');

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };

// 三个视图：易错题（高频错）/ 全部错题（待攻克）/ 已掌握
const TABS = [
  { key: 'hard', label: '易错题' },
  { key: 'pending', label: '全部错题' },
  { key: 'mastered', label: '已掌握' }
];

Page({
  data: {
    loading: true,
    tabs: TABS.map((t) => ({ ...t, count: 0 })),
    tab: 'hard',
    tabLabel: '易错题',
    // 题库筛选：'' 表示全部题库
    setId: '',
    setFilter: [],
    // 分组后的题目列表
    groups: [],
    sum: { sets: 0, total: 0, pending: 0, hard: 0, mastered: 0 },
    scope: { total: 0, pending: 0, hard: 0, mastered: 0 },
    scopeTitle: '全部题库',
    emptyTip: ''
  },

  onShow() {
    // 从题库弹层/结果页跳转过来时，通过 globalData 传递筛选题库
    const app = getApp();
    if (app && app.globalData && app.globalData.wrongFilter != null) {
      const fid = app.globalData.wrongFilter;
      app.globalData.wrongFilter = null;
      this.setData({ setId: fid || '', tab: 'hard' });
      this.expanded = {};
    }
    this.refresh();
  },

  refresh() {
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

    // 当前筛选范围
    let scoped = books;
    let setId = this.data.setId;
    if (setId && !books.some((b) => b.setId === setId)) setId = '';
    if (setId) scoped = books.filter((b) => b.setId === setId);

    const scope = { total: 0, pending: 0, hard: 0, mastered: 0 };
    scoped.forEach((b) => {
      scope.total += b.total;
      scope.pending += b.pending;
      scope.hard += b.hard;
      scope.mastered += b.mastered;
    });

    // tab 计数随筛选范围变化
    const counts = { hard: scope.hard, pending: scope.pending, mastered: scope.mastered };

    // 当前 tab 无内容时自动落到有内容的 tab，避免一进来就是空页
    let tab = this.data.tab;
    if (!counts[tab]) {
      if (counts.hard) tab = 'hard';
      else if (counts.pending) tab = 'pending';
      else if (counts.mastered) tab = 'mastered';
    }

    this.expanded = this.expanded || {};
    const groups = [];
    scoped.forEach((b) => {
      const items = wrongbook.listItems(b.setId, tab);
      if (!items.length) return;
      groups.push({
        setId: b.setId,
        title: b.title,
        count: items.length,
        items: items.map((it) => this.mapItem(it, b))
      });
    });

    const setFilter = [{ setId: '', title: '全部题库', count: sum.pending }].concat(
      books.map((b) => ({ setId: b.setId, title: b.title, count: b.pending }))
    );

    this.setData({
      loading: false,
      setId,
      setFilter,
      scope,
      scopeTitle: setId ? (books.find((b) => b.setId === setId) || {}).title || '当前题库' : '全部题库',
      sum,
      tab,
      tabLabel: (TABS.find((t) => t.key === tab) || {}).label || '错题',
      tabs: TABS.map((t) => ({ ...t, count: counts[t.key] })),
      groups,
      emptyTip: this.emptyTip(tab)
    });
  },

  emptyTip(tab) {
    if (tab === 'hard') return '还没有易错题。错 2 次以上的题会自动出现在这里。';
    if (tab === 'pending') return '错题本是空的，去刷几道题吧。';
    return '还没有已掌握的错题。错题连续答对 2 次会自动归入这里。';
  },

  mapItem(it, book) {
    const key = `${book.setId}_${it.no}`;
    return {
      key,
      setId: book.setId,
      setTitle: book.title,
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
      lastWrongText: it.lastWrongAt ? formatTime(it.lastWrongAt) : '',
      expanded: !!this.expanded[key]
    };
  },

  changeTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.expanded = {};
    this.setData({ tab }, () => this.refresh());
  },

  switchSet(e) {
    const setId = e.currentTarget.dataset.id || '';
    this.expanded = {};
    this.setData({ setId }, () => this.refresh());
  },

  toggleItem(e) {
    const key = e.currentTarget.dataset.key;
    this.expanded = this.expanded || {};
    this.expanded[key] = !this.expanded[key];
    const groups = this.data.groups.map((g) => ({
      ...g,
      items: g.items.map((it) => (it.key === key ? { ...it, expanded: !!this.expanded[key] } : it))
    }));
    this.setData({ groups });
  },

  // ---------- 操作 ----------
  // 错题本写失败不能静默：明确告知用户，否则会以为改动已生效
  surfaceStorageError() {
    const p = safe.take();
    if (!p) return false;
    wx.showModal({ title: '记录未能保存', content: p.message, showCancel: false });
    return true;
  },

  goQuiz(setId, title, mode, nos) {
    if (!setId) return;
    let url = `/pages/quiz/quiz?setId=${setId}&mode=${mode}&title=${encodeURIComponent(title || '')}`;
    if (nos && nos.length) url += `&nos=${encodeURIComponent(nos.join(','))}`;
    wx.navigateTo({ url });
  },

  retrainItem(e) {
    const { sid, no } = e.currentTarget.dataset;
    const g = this.data.groups.find((x) => x.setId === sid);
    this.goQuiz(sid, (g && g.title) || '', 'wrong', [String(no)]);
  },

  retrainGroup(e) {
    const sid = e.currentTarget.dataset.id;
    const mode = this.data.tab === 'hard' ? 'hard' : 'wrong';
    const g = this.data.groups.find((x) => x.setId === sid);
    if (!g || !g.items.length) {
      wx.showToast({ title: '该题库暂无可重练的题', icon: 'none' });
      return;
    }
    this.goQuiz(sid, g.title, mode);
  },

  retrainScope() {
    if (!this.data.setId) {
      wx.showToast({ title: '请先选择单个题库', icon: 'none' });
      return;
    }
    const mode = this.data.tab === 'hard' ? 'hard' : 'wrong';
    const g = this.data.groups[0];
    if (!g) {
      wx.showToast({ title: '暂无可重练的题', icon: 'none' });
      return;
    }
    this.goQuiz(this.data.setId, g.title, mode);
  },

  markMastered(e) {
    const { sid, no } = e.currentTarget.dataset;
    wrongbook.setMastered(sid, no, true);
    wx.showToast({ title: '已标记掌握', icon: 'success' });
    this.surfaceStorageError();
    this.refresh();
  },

  unmarkMastered(e) {
    const { sid, no } = e.currentTarget.dataset;
    wrongbook.setMastered(sid, no, false);
    wx.showToast({ title: '已移回待攻克', icon: 'none' });
    this.surfaceStorageError();
    this.refresh();
  },

  removeItem(e) {
    const { sid, no } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '移出错题本',
      content: `确定将第 ${no} 题的记录移出错题本吗？该题的错误次数与掌握状态会一并清除。`,
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        wrongbook.removeItem(sid, no);
        wx.showToast({ title: '已移出', icon: 'success' });
        that.surfaceStorageError();
        that.refresh();
      }
    });
  },

  clearScope() {
    const setId = this.data.setId;
    if (!setId) {
      wx.showToast({ title: '请先选择单个题库', icon: 'none' });
      return;
    }
    const title = this.data.scopeTitle;
    const that = this;
    wx.showModal({
      title: '清空错题本',
      content: `确定清空「${title}」的全部 ${this.data.scope.total} 条错题记录吗？此操作不可恢复。`,
      confirmText: '清空',
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        wrongbook.clearBook(setId);
        that.expanded = {};
        that.setData({ setId: '' }, () => that.refresh());
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
