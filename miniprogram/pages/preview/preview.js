const { formatTime } = require('../../utils/util');
const store = require('../../utils/store');

const TYPE_LABEL = { single: '单选', multi: '多选', judge: '判断', text: '问答' };

Page({
  data: {
    loaded: false,
    setId: '',
    set: null,
    timeText: '',
    matchedCount: 0,
    noExpl: 0,
    dist: [],
    sample: []
  },

  onLoad(options) {
    const setId = options.setId;
    this.setData({ setId });
    this.loadSet(setId);
  },

  loadSet(setId) {
    try {
      const bundle = store.loadSetBundle(setId);
      if (!bundle) throw new Error('题库不存在或已删除');
      const set = bundle.set;
      const questions = bundle.questions || [];
      const matchedCount = questions.filter((q) => q.matched).length;
      const noExpl = questions.length - matchedCount;

      const distMap = {};
      questions.forEach((q) => {
        const t = q.type || 'single';
        distMap[t] = (distMap[t] || 0) + 1;
      });
      const dist = Object.keys(distMap).map((t) => ({
        t,
        label: TYPE_LABEL[t] || t,
        n: distMap[t]
      }));

      const sample = questions.slice(0, 100).map((q) => ({
        no: q.no,
        stem: q.stem,
        matched: !!q.matched,
        type: q.type,
        typeLabel: TYPE_LABEL[q.type] || q.type
      }));

      this.setData({
        loaded: true,
        set,
        timeText: formatTime(set.createTime),
        matchedCount,
        noExpl,
        dist,
        sample
      });
      wx.setNavigationBarTitle({ title: set.title || '解析预览' });
    } catch (e) {
      console.error('[preview] 加载失败', e);
      wx.showModal({
        title: '加载失败',
        content: (e && e.message) || '题库不存在或已删除',
        showCancel: false,
        success: () => wx.navigateBack()
      });
    }
  },

  startQuiz(e) {
    const mode = e.currentTarget.dataset.mode;
    const set = this.data.set;
    wx.redirectTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=${mode}&title=${encodeURIComponent(set.title || '')}`
    });
  },

  // ---------- 选具体题目进入 ----------
  // 预览列表原来只能看：想核对第 37 题，得先开始练习再一题题翻过去。
  // 现在点列表任意一条 = 直接进那道题（题序 = 列表下标 + 1，与答题卡格子编号一致）。
  openQuestion(e) {
    this.enterQuestion(Number(e.currentTarget.dataset.seq));
  },

  // 列表只渲染前 100 条（上千条 setData 会卡），其余题目按题序进入
  jumpToSeq() {
    const total = (this.data.set && this.data.set.questionCount) || 0;
    if (total <= 0) {
      wx.showToast({ title: '这套题库没有题目', icon: 'none' });
      return;
    }
    const that = this;
    wx.showModal({
      title: '跳到第几题',
      editable: true,
      placeholderText: `输入 1 - ${total}`,
      success(res) {
        if (!res.confirm) return;
        that.enterQuestion(parseInt(res.content, 10));
      }
    });
  },

  // 进入指定题序（1 起）。走答题页的 start 参数：只移动当前题序，已有作答记录原样保留，
  // 所以「进来看看这题」不会把进度打乱。
  enterQuestion(seq) {
    const set = this.data.set || {};
    const total = set.questionCount || 0;
    if (!seq || seq < 1 || seq > total) {
      wx.showToast({ title: `请输入 1 - ${total} 之间的题序`, icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=order&start=${seq}` +
        `&title=${encodeURIComponent(set.title || '')}`
    });
  }
});
