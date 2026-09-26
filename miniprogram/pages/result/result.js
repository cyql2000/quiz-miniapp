const store = require('../../utils/progress');
const wrongbook = require('../../utils/wrongbook');
const marks = require('../../utils/marks');
const { formatDuration } = require('../../utils/util');

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };

Page({
  data: {
    loaded: false,
    setId: '',
    title: '',
    modeLabel: '',
    rate: 0,
    rateColor: '#12A15D',
    answered: 0,
    correct: 0,
    wrongCount: 0,
    unanswered: 0,
    costText: '0分',
    // 错题本（跨会话累计）
    wbPending: 0,
    wbHard: 0,
    wbMastered: 0,
    hardList: [],
    markedCount: 0
  },

  onLoad(options) {
    const setId = options.setId;
    this.setData({ setId });
    this.compute(setId);
  },

  compute(setId) {
    const s = store.getState(setId);
    // 自定义练习的题目来自多个题库，没有「单库口径」的错题本与标记可算：
    // 硬套任一题库的统计会把完全不相关的错题算进来，所以只统计本次抽中的题。
    const isCustom = !!(s && s.custom);
    const ws = isCustom
      ? { total: 0, pending: 0, hard: 0, mastered: 0 }
      : wrongbook.stats(setId);
    const hardList = isCustom ? [] : wrongbook.listItems(setId, 'hard').slice(0, 5).map((it) => ({
      no: it.no,
      typeLabel: TYPE_LABEL[it.type] || it.type,
      wrongCount: it.wrongCount || 0,
      attempts: it.attempts || 0,
      errRate: it.errRate,
      stem: it.stem || ''
    }));
    const wbData = {
      wbPending: ws.pending,
      wbHard: ws.hard,
      wbMastered: ws.mastered,
      hardList
    };

    if (!s) {
      this.setData({
        loaded: true,
        custom: false,
        title: '未找到练习记录',
        modeLabel: '可直接从首页重新开始',
        costText: '--',
        ...wbData
      });
      return;
    }
    let correct = 0;
    let answered = 0;
    const records = s.records || {};
    Object.keys(records).forEach((no) => {
      const r = records[no];
      if (!r) return;
      const isAnswered = r.answered || r.manual;
      if (!isAnswered) return;
      answered++;
      const isRight = r.correct === true || r.manual === 'right';
      if (isRight) correct++;
    });
    const wrongCount = (s.wrongs || []).length;
    const unanswered = s.total - answered;
    const rate = answered ? Math.round((correct / answered) * 100) : 0;
    // 用时 = 累计活跃时长。旧实现用 now - startedAt，继续练习沿用旧 state 时
    // 隔天进来会显示上千分钟（见 utils/progress.js 的计时说明）。
    const costText = formatDuration(store.elapsedOf(s));

    this.setData({
      loaded: true,
      custom: isCustom,
      title: s.title,
      modeLabel: store.MODE_LABEL[s.mode] || '练习',
      rate,
      rateColor: rate >= 60 ? '#12A15D' : rate >= 30 ? '#E8A13A' : '#F04242',
      answered,
      correct,
      wrongCount,
      unanswered,
      costText,
      markedCount: isCustom ? this.countMarked(s) : marks.count(setId),
      ...wbData
    });
  },

  // 本次抽中的题里被标记了多少道（标记散落在各自的来源题库上）
  countMarked(s) {
    const cache = {};
    let n = 0;
    ((s && s.items) || []).forEach((it) => {
      if (!cache[it.sid]) cache[it.sid] = marks.getBook(it.sid).nos || [];
      if (cache[it.sid].indexOf(String(it.no)) >= 0) n++;
    });
    return n;
  },

  goReviewAll() {
    wx.navigateTo({
      url: `/pages/review/review?setId=${this.data.setId}&scope=all`
    });
  },

  goReviewWrong() {
    wx.navigateTo({
      url: `/pages/review/review?setId=${this.data.setId}&scope=wrong`
    });
  },

  goMarked() {
    if (!this.data.markedCount) {
      wx.showToast({ title: '暂无标记题', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=marked&title=${encodeURIComponent(this.data.title)}`
    });
  },

  redoWrong() {
    if (!this.data.wbPending) {
      wx.showToast({ title: '错题本暂无待攻克错题', icon: 'none' });
      return;
    }
    wx.redirectTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=wrong&title=${encodeURIComponent(this.data.title)}`
    });
  },

  redoHard() {
    if (!this.data.wbHard) {
      wx.showToast({ title: '暂无易错题', icon: 'none' });
      return;
    }
    wx.redirectTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=hard&title=${encodeURIComponent(this.data.title)}`
    });
  },

  retrainOne(e) {
    const no = e.currentTarget.dataset.no;
    wx.redirectTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=wrong&nos=${encodeURIComponent(no)}&title=${encodeURIComponent(this.data.title)}`
    });
  },

  // 错题本为 tabBar 页面，用 globalData 传递筛选题库
  goWrongBook() {
    const app = getApp();
    // 自定义练习跨多个题库，进错题本时不带筛选，避免落到一个不存在的题库上
    if (app && app.globalData) app.globalData.wrongFilter = this.data.custom ? '' : (this.data.setId || '');
    wx.switchTab({ url: '/pages/wrong/wrong' });
  },

  // 自定义练习没有「一键重练整卷」的说法（题目是随机抽的），改为再抽一组
  redoAll() {
    if (this.data.custom) {
      wx.redirectTo({ url: '/pages/custom/custom' });
      return;
    }
    wx.redirectTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=order&title=${encodeURIComponent(this.data.title)}`
    });
  },

  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
