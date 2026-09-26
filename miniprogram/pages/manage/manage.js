// 题库统一管理
//
// 首页的题库卡片是「看一眼、点进去练」，题库一多（一本书拆几十卷）就只剩滚动。
// 这一页解决的是另一件事：一次性看全 + 批量收拾。
//   · 按「书」分组，章节按生成顺序排（复用 utils/custom.js 的分组规则）
//   · 搜索标题/书名
//   · 批量模式：全选 / 按书选 / 批量删除 / 批量导出
const dataStore = require('../../utils/store');
const store = require('../../utils/progress');
const wrongbook = require('../../utils/wrongbook');
const marks = require('../../utils/marks');
const portable = require('../../utils/portable');
const custom = require('../../utils/custom');

Page({
  data: {
    loading: true,
    keyword: '',
    books: [],
    total: 0,
    totalQuestions: 0,
    manage: false,        // 批量模式
    selected: [],
    selectedCount: 0,
    selectedQuestions: 0,
    exporting: false
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    try {
      // 与自定义练习页同一套分组规则：按源文件归书、组内按生成顺序排章节
      const groups = custom.groupedChapters();
      const metaById = {};
      dataStore.listSets().forEach((d) => { metaById[d.setId] = d; });

      const books = groups.map((g) => {
        const chapters = g.chapters.map((c) => {
          const d = metaById[c.setId] || {};
          const st = store.getState(c.setId);
          const ws = wrongbook.stats(c.setId);
          let done = 0;
          if (st) {
            const recs = st.records || {};
            done = Object.keys(recs).filter((no) => recs[no].answered || recs[no].manual).length;
          }
          const count = d.questionCount || c.count || 0;
          const matched = d.matchedCount || 0;
          return {
            setId: c.setId,
            title: d.title || c.title || '未命名题库',
            chapter: c.chapter || d.title || c.setId,
            count,
            matched,
            unmatched: Math.max(0, count - matched),
            hasAnswer: d.answerSource ? d.answerSource !== 'none' : !!d.answerFile,
            done,
            progress: count ? Math.min(100, Math.round((done / count) * 100)) : 0,
            wrong: ws.pending,
            hard: ws.hard,
            marked: marks.count(c.setId),
            checked: false
          };
        });
        const count = chapters.reduce((a, c) => a + c.count, 0);
        const done = chapters.reduce((a, c) => a + c.done, 0);
        return {
          book: g.book,
          chapters,
          count,
          done,
          progress: count ? Math.min(100, Math.round((done / count) * 100)) : 0,
          checked: false
        };
      });

      this.allBooks = books;
      this.setData({
        loading: false,
        total: books.reduce((a, b) => a + b.chapters.length, 0),
        totalQuestions: books.reduce((a, b) => a + b.count, 0)
      });
      this.applyFilter();
    } catch (e) {
      console.error('[manage] load fail', e);
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.applyFilter();
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  // 按关键词过滤（书名或章节名命中都保留）
  applyFilter() {
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const selected = this.data.selected || [];
    let books = (this.allBooks || []).slice();
    if (kw) {
      books = books
        .map((b) => {
          const bookHit = b.book.toLowerCase().indexOf(kw) >= 0;
          const chapters = bookHit ? b.chapters : b.chapters.filter((c) => c.title.toLowerCase().indexOf(kw) >= 0);
          return Object.assign({}, b, { chapters });
        })
        .filter((b) => b.chapters.length);
    }
    books = books.map((b) => {
      const chapters = b.chapters.map((c) => Object.assign({}, c, { checked: selected.indexOf(c.setId) >= 0 }));
      const picked = chapters.filter((c) => c.checked).length;
      return Object.assign({}, b, {
        chapters,
        picked,
        allChecked: picked > 0 && picked === chapters.length
      });
    });
    this.setData({ books });
  },

  // ---------------- 批量模式 ----------------
  toggleManage() {
    const manage = !this.data.manage;
    this.setData({ manage, selected: [], selectedCount: 0, selectedQuestions: 0 });
    this.applyFilter();
  },

  syncSelected(selected) {
    const byId = {};
    (this.allBooks || []).forEach((b) => b.chapters.forEach((c) => { byId[c.setId] = c.count; }));
    const qs = selected.reduce((a, id) => a + (byId[id] || 0), 0);
    this.setData({ selected, selectedCount: selected.length, selectedQuestions: qs });
    this.applyFilter();
  },

  toggleOne(e) {
    const id = e.currentTarget.dataset.id;
    const selected = (this.data.selected || []).slice();
    const i = selected.indexOf(id);
    if (i >= 0) selected.splice(i, 1);
    else selected.push(id);
    this.syncSelected(selected);
  },

  // 整本书一起选 / 一起取消（按当前筛选后的可见章节）
  toggleBook(e) {
    const book = e.currentTarget.dataset.book;
    const hit = (this.data.books || []).filter((b) => b.book === book)[0];
    if (!hit) return;
    const ids = hit.chapters.map((c) => c.setId);
    const allIn = ids.every((id) => (this.data.selected || []).indexOf(id) >= 0);
    let selected = (this.data.selected || []).slice();
    if (allIn) selected = selected.filter((id) => ids.indexOf(id) < 0);
    else ids.forEach((id) => { if (selected.indexOf(id) < 0) selected.push(id); });
    this.syncSelected(selected);
  },

  selectAll() {
    const all = [];
    (this.data.books || []).forEach((b) => b.chapters.forEach((c) => all.push(c.setId)));
    this.syncSelected(all);
  },

  clearAll() {
    this.syncSelected([]);
  },

  // ---------------- 批量操作 ----------------
  batchDelete() {
    const ids = this.data.selected || [];
    if (!ids.length) {
      wx.showToast({ title: '请先勾选题库', icon: 'none' });
      return;
    }
    const qs = this.data.selectedQuestions;
    const that = this;
    wx.showModal({
      title: `删除 ${ids.length} 个题库`,
      content: `这些题库共 ${qs} 题，连同它们的刷题进度、错题本、校对记录与标记会一起清除，无法恢复。\n\n源文件不受影响（仍在「文件库」里），需要时可以重新生成。`,
      confirmText: '删除',
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中…', mask: true });
        let ok = 0;
        const failed = [];
        ids.forEach((id) => {
          try { dataStore.deleteSet(id); ok++; } catch (e) { failed.push(id); }
        });
        wx.hideLoading();
        wx.showToast({
          title: failed.length ? `已删除 ${ok} 个，${failed.length} 个失败` : `已删除 ${ok} 个题库`,
          icon: 'none',
          duration: 2000
        });
        that.syncSelected([]);
        that.setData({ manage: false });
        that.load();
      }
    });
  },

  batchExport() {
    const ids = this.data.selected || [];
    if (!ids.length) {
      wx.showToast({ title: '请先勾选题库', icon: 'none' });
      return;
    }
    let file;
    wx.showLoading({ title: '打包中…', mask: true });
    try {
      file = portable.exportToSandbox(ids, `选中${ids.length}个题库`);
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '导出失败', content: (e && e.message) || '未知错误', showCancel: false });
      return;
    }
    wx.hideLoading();

    const that = this;
    const items = ['转发到微信'];
    if (typeof wx.saveFileToDisk === 'function') items.push('保存到电脑');
    wx.showActionSheet({
      itemList: items,
      success(a) {
        if (a.tapIndex === 0) that.shareExport(file);
        else that.saveExport(file);
      },
      fail() {
        wx.showToast({ title: '备份已生成，未发送', icon: 'none' });
      }
    });
  },

  shareExport(file) {
    wx.showLoading({ title: '准备转发…', mask: true });
    portable.shareToChat(file.absPath, file.name)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: `已生成 ${file.sizeText}`, icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showModal({
          title: '转发失败',
          content: ((err && err.message) || '转发失败') +
            `\n\n备份已生成在小程序内（${file.name}），可稍后重试，或在电脑版微信里选择「保存到电脑」。`,
          showCancel: false
        });
      });
  },

  saveExport(file) {
    wx.showLoading({ title: '保存中…', mask: true });
    portable.saveToDisk(file.absPath, file.name)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已保存到电脑', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showModal({ title: '保存失败', content: (err && err.message) || '保存失败', showCancel: false });
      });
  },

  // ---------------- 单项 ----------------
  // 非批量模式下点一项 = 先看题（预 览页能看到题干与答案完整度）
  openSet(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.manage) { this.toggleOne(e); return; }
    wx.navigateTo({ url: `/pages/preview/preview?setId=${id}` });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onPullDownRefresh() {
    this.load();
    wx.stopPullDownRefresh();
  }
});
