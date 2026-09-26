const { formatTime } = require('../../utils/util');
const store = require('../../utils/progress');
const wrongbook = require('../../utils/wrongbook');
const errata = require('../../utils/errata');
const marks = require('../../utils/marks');
const safe = require('../../utils/safestore');
const dataStore = require('../../utils/store');
const portable = require('../../utils/portable');
const fsm = require('../../utils/localfs');
const custom = require('../../utils/custom');

// 首页题库列表最多摊开几份，其余进「题库管理」页
const HOME_SET_LIMIT = 6;

Page({
  data: {
    loading: true,
    sets: [],
    setsShown: [],
    continueCard: null,
    wb: { sets: 0, total: 0, pending: 0, hard: 0, mastered: 0 },
    er: { sets: 0, total: 0, open: 0, fixed: 0 },
    storage: { fileCount: 0, setCount: 0, sizeText: '0 B' },
    sheet: {
      show: false,
      setId: '',
      title: '',
      total: 0,
      hasProgress: false,
      progress: 0,
      markedCount: 0,
      wrongCount: 0,
      hardCount: 0,
      masteredCount: 0,
      stateLabel: '浏览全部题目'
    }
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const docs = dataStore.listSets();
      const sets = docs.map((d) => {
        const st = store.getState(d.setId);
        const ws = wrongbook.stats(d.setId);
        let done = 0;
        if (st) {
          const recs = st.records || {};
          done = Object.keys(recs).filter((no) => recs[no].answered || recs[no].manual).length;
        }
        return {
          setId: d.setId,
          title: d.title || '未命名题库',
          // 卡片主行显示卷名（章节路径）、副行显示书名：
          //  完整 title 形如「01 政治理论…（题本） · 第一章 … · 第一节 …」，
          //  单行省略会把最有区分度的尾部截掉，一本书几十卷看起来全一样。
          book: custom.bookOf(d),
          chapter: custom.chapterOf(d) || d.title || '未命名题库',
          questionCount: d.questionCount || 0,
          matchedCount: d.matchedCount || 0,
          // 有没有答案看 answerSource：答案可直接来自试题文件文末（此时 answerFile 为 null）。
          // 老题库没有该字段，回退到 answerFile 判断。
          answerFile: d.answerSource ? d.answerSource !== 'none' : !!d.answerFile,
          answerInline: d.answerSource === 'inline',
          timeText: formatTime(d.createTime) || '--',
          done,
          progress: d.questionCount ? Math.min(100, Math.round((done / d.questionCount) * 100)) : 0,
          wrongCount: ws.pending,
          hardCount: ws.hard,
          markedCount: marks.count(d.setId)
        };
      });

      // 继续卡片：最近一条未完成记录
      const recents = store.listRecents();
      let continueCard = null;
      const recent = recents.find((r) => !r.finished);
      if (recent && recent.setId === store.CUSTOM_SCOPE) {
        // 自定义练习没有对应的题库明细，卡片直接用它自己带过来的计数
        continueCard = {
          setId: recent.setId,
          title: recent.title || '自定义练习',
          total: recent.total || 0,
          done: recent.done || 0,
          progress: recent.progress || 0,
          custom: true
        };
      } else if (recent) {
        const s = sets.find((x) => x.setId === recent.setId);
        if (s) {
          continueCard = {
            setId: s.setId,
            title: s.title,
            chapter: s.chapter,
            book: s.book,
            total: s.questionCount,
            done: s.done,
            progress: s.progress,
            custom: false
          };
        }
      }

      // 首屏先出列表，剩下的汇总卡延后一个 tick 回填：
      // 「错题本 / 校对 / 占用」都要扫全量数据（占用那份还要挨个 stat 文件），
      // 全塞在 onShow 的同步块里就会顶到 100ms 以上被框架点名。
      this.setData({
        sets,
        // 首页只摊开最近几份：一本书常拆成几十卷，全列出来只剩滚动。
        // 要一次看全 / 批量收拾，走「题库管理」页。
        setsShown: sets.slice(0, HOME_SET_LIMIT),
        continueCard,
        loading: false
      });
      setTimeout(() => this.loadSummary(), 0);
    } catch (e) {
      console.error('[index] load sets fail', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载题库失败', icon: 'none' });
    }
    wx.stopPullDownRefresh();
  },

  // 三块汇总数字：与首屏列表分开算，不占 onShow 的同步时间
  loadSummary() {
    if (this.gone) return;   // 页面已经卸载，别再 setData
    try {
      this.setData({
        wb: wrongbook.summary(),
        er: errata.summary(),
        storage: dataStore.storageStats()
      });
    } catch (e) {
      console.error('[index] load summary fail', e);
    }
  },

  onUnload() {
    this.gone = true;
  },

  onPullDownRefresh() {
    this.refresh();
  },

  goContinue() {
    const c = this.data.continueCard;
    if (!c) return;
    this.goQuiz(c.setId, '', 'continue');
  },

  goGenerate() {
    wx.navigateTo({ url: '/pages/generate/generate' });
  },

  // 自定义练习：自选章节范围与题量，随机抽题。
  // 从某个题库的弹层点进来时带上该题库，默认只在这个题库里抽。
  goCustom(e) {
    const setId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || '';
    const app = getApp();
    if (app && app.globalData) app.globalData.customPresetSetId = setId;
    if (this.data.sheet.show) this.setData({ 'sheet.show': false });
    wx.navigateTo({ url: '/pages/custom/custom' });
  },

  goFiles() {
    wx.switchTab({ url: '/pages/files/files' });
  },

  // 题库管理：一次看全 + 批量收拾（首页只摊开最近几份）
  goManage() {
    wx.navigateTo({ url: '/pages/manage/manage' });
  },

  openSheet(e) {
    const setId = e.currentTarget.dataset.id;
    const s = this.data.sets.find((x) => x.setId === setId);
    if (!s) return;
    const st = store.getState(setId);
    const ws = wrongbook.stats(setId);
    const mk = marks.count(setId);
    let hasProgress = false;
    let progress = 0;
    if (st && !st.finished && st.idx > 0) {
      hasProgress = true;
      progress = st.total ? Math.min(100, Math.round((st.idx / st.total) * 100)) : 0;
    }
    this.setData({
      sheet: {
        show: true,
        setId,
        title: s.title,
        total: s.questionCount,
        hasProgress,
        progress,
        markedCount: mk,
        wrongCount: ws.pending,
        hardCount: ws.hard,
        masteredCount: ws.mastered,
        stateLabel: st ? (st.finished ? '查看整卷解析' : '回顾已作答的题') : '浏览全部题目',
        wrongLabel: ws.pending || ws.mastered
          ? `（待攻克 ${ws.pending} · 易错 ${ws.hard}）`
          : '（暂无记录）'
      }
    });
  },

  closeSheet() {
    this.setData({ 'sheet.show': false });
  },

  chooseMode(e) {
    const mode = e.currentTarget.dataset.mode;
    const s = this.data.sheet;
    if (!s.setId) return;
    if (mode === 'wrong' && !s.wrongCount) {
      wx.showToast({ title: '暂无错题', icon: 'none' });
      return;
    }
    if (mode === 'hard' && !s.hardCount) {
      wx.showToast({ title: '暂无易错题', icon: 'none' });
      return;
    }
    if (mode === 'marked' && !s.markedCount) {
      wx.showToast({ title: '暂无标记题', icon: 'none' });
      return;
    }
    this.setData({ 'sheet.show': false });
    this.goQuiz(s.setId, s.title, mode);
  },

  // 整卷回顾：逐题对照我的作答、正确答案与解析
  goReview() {
    const s = this.data.sheet;
    if (!s.setId) return;
    this.setData({ 'sheet.show': false });
    wx.navigateTo({ url: `/pages/review/review?setId=${s.setId}&scope=all` });
  },

  // 错题本是 tabBar 页面，无法通过 url 带参，用 globalData 传递筛选条件
  goWrongBook(setId) {
    const id = typeof setId === 'string' ? setId : '';
    const app = getApp();
    if (app && app.globalData) app.globalData.wrongFilter = id;
    wx.switchTab({ url: '/pages/wrong/wrong' });
  },

  openWrongBook(e) {
    const setId = (e && e.currentTarget && e.currentTarget.dataset.id) || '';
    this.setData({ 'sheet.show': false });
    this.goWrongBook(setId);
  },

  // 校对清单不是 tabBar 页，直接 navigateTo 即可带参
  goErrata(e) {
    const setId = (e && e.currentTarget && e.currentTarget.dataset.id) || '';
    if (setId) {
      const app = getApp();
      if (app && app.globalData) app.globalData.errataFilter = setId;
    }
    wx.navigateTo({ url: '/pages/errata/errata' });
  },

  goQuiz(setId, title, mode, start) {
    // start 可选：直达第 N 题（答题页的答题卡也能随时点题跳转，此处仅保留能力入口）
    const extra = start ? `&start=${start}` : '';
    wx.navigateTo({
      url: `/pages/quiz/quiz?setId=${setId}&mode=${mode}&title=${encodeURIComponent(title || '')}${extra}`
    });
  },

  deleteSet(e) {
    const setId = e.currentTarget.dataset.id || this.data.sheet.setId;
    const s = this.data.sets.find((x) => x.setId === setId);
    const that = this;
    wx.showModal({
      title: '删除题库',
      content: `确定删除「${s ? s.title : ''}」吗？仅删除题库记录，不会删除文件库中的源文件；本题库的错题本、校对记录与标记也会一并清除。`,
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          // 题库明细 + 进度 + 错题本 + 校对记录 + 标记 一并清理
          dataStore.deleteSet(setId);
          wx.hideLoading();
          that.surfaceStorageError();
          that.setData({ 'sheet.show': false });
          that.refresh();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
        }
      }
    });
  },

  // ---------------- 数据备份（导出 / 导入） ----------------

  exportAll() {
    if (!this.data.sets.length) {
      wx.showToast({ title: '还没有题库可导出', icon: 'none' });
      return;
    }
    this.doExport(null, '全部');
  },

  exportOne(e) {
    const setId = e.currentTarget.dataset.id || this.data.sheet.setId;
    const s = this.data.sets.find((x) => x.setId === setId);
    this.setData({ 'sheet.show': false });
    this.doExport([setId], s ? s.title : '单库');
  },

  // setIds 为 null 表示导出全部
  doExport(setIds, label) {
    let file;
    wx.showLoading({ title: '打包中...', mask: true });
    try {
      file = portable.exportToSandbox(setIds, label);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '导出失败', icon: 'none' });
      return;
    }
    wx.hideLoading();

    const that = this;
    // 转发到聊天是主路径；PC 端额外提供「保存到本机磁盘」
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
    const s = file.summary;
    wx.showLoading({ title: '准备转发...', mask: true });
    portable.shareToChat(file.absPath, file.name)
      .then(() => {
        wx.hideLoading();
        wx.showToast({
          title: `${s.setCount} 套 / ${s.questionCount} 题 / ${file.sizeText}`,
          icon: 'success',
          duration: 2200
        });
      })
      .catch((err) => {
        wx.hideLoading();
        // 转发失败时给出兜底路径，而不是让用户卡住
        wx.showModal({
          title: '转发失败',
          content: ((err && err.message) || '转发失败') +
            `\n\n备份已生成在小程序内（${file.name}），可稍后重试，或在电脑版微信里选择「保存到电脑」。`,
          showCancel: false
        });
      });
  },

  saveExport(file) {
    wx.showLoading({ title: '保存中...', mask: true });
    portable.saveToDisk(file.absPath, file.name)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已保存到电脑', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showModal({
          title: '保存失败',
          content: (err && err.message) || '保存失败',
          showCancel: false
        });
      });
  },

  // 写入失败不静默：storage 满时明确告知，而不是让记录悄悄丢掉
  surfaceStorageError() {
    const p = safe.take();
    if (!p) return false;
    wx.showModal({
      title: '记录未能保存',
      content: p.message,
      showCancel: false
    });
    return true;
  },

  importBackup() {
    const that = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success(res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (f) that.confirmImport(f);
      }
    });
  },

  confirmImport(f) {
    const that = this;
    let parsed;
    const rel = `${fsm.DIR.tmp}/import_${Date.now()}.json`;
    try {
      // 先拷进沙箱再读，这样与其它文件走同一套读取逻辑（临时文件路径不能长期依赖）
      fsm.copyIn(f.path, rel);
      parsed = portable.readImportFile(rel);
    } catch (err) {
      wx.showModal({
        title: '无法导入',
        content: (err && err.message) || '文件解析失败',
        showCancel: false
      });
      return;
    } finally {
      fsm.remove(rel);
    }

    const { payload, plan } = parsed;
    if (!plan.add.length) {
      wx.showModal({
        title: '无需导入',
        content: portable.planText(plan) + '\n\n备份里的题库在本机都已存在，未做任何改动。',
        showCancel: false
      });
      return;
    }

    wx.showModal({
      title: '确认导入',
      content: portable.planText(plan),
      confirmText: '导入',
      success(res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '导入中...', mask: true });
        try {
          const r = portable.applyImport(payload, plan);
          wx.hideLoading();
          that.surfaceStorageError();
          that.refresh();
          wx.showToast({ title: `已导入 ${r.imported} 个题库`, icon: 'success' });
        } catch (err) {
          wx.hideLoading();
          wx.showModal({
            title: '导入失败',
            content: (err && err.message) || '导入过程中出错，已导入的部分会保留',
            showCancel: false
          });
        }
      }
    });
  }
});
