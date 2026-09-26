// 整卷回顾
//
// 交卷之后最想做的一件事是「把错的连解析过一遍」——成绩页只有统计和易错题 top5，
// 答不出这个诉求。本页把本次会话的整卷摊开：题干 / 我的作答 / 正确答案 / 解析。
//
// 题量是硬约束：一本行测书 1000 题，含解析的 JSON 单独一次 setData 会有几 MB。
// 所以只渲染前 PAGE_SIZE 条，滚到底再追加。
const dataStore = require('../../utils/store');
const store = require('../../utils/progress');
const marks = require('../../utils/marks');
const { sortLetters } = require('../../utils/util');

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };
const PAGE_SIZE = 20;

const SCOPES = [
  { key: 'all', label: '全部' },
  { key: 'wrong', label: '只看错题' },
  { key: 'marked', label: '只看标记' }
];

Page({
  data: {
    loaded: false,
    setId: '',
    title: '',
    modeLabel: '',
    custom: false,
    scope: 'all',
    tabs: [],
    items: [],
    total: 0,
    shown: 0,
    hasMore: false,
    wrongN: 0,
    markedN: 0,
    emptyText: ''
  },

  onLoad(options) {
    const setId = options.setId;
    if (!setId) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }
    this.setData({ setId });
    this.build(setId, options.scope || 'all');
  },

  build(setId, scope) {
    try {
      const state0 = store.getState(setId);
      // 自定义练习的题目来自多个题库，没有单份明细可取
      if (state0 && state0.custom) {
        this.buildCustom(state0, scope);
        return;
      }
      const bundle = dataStore.loadSetBundle(setId);
      if (!bundle) throw new Error('题库不存在或已删除');
      const questions = bundle.questions || [];
      const byNo = {};
      questions.forEach((q) => { byNo[String(q.no)] = q; });

      const state = state0;
      // 有会话就按那份卷子的题序还原；没有（比如从首页直接进来）就退回整本题库
      const order = state && state.order && state.order.length
        ? state.order.filter((no) => byNo[no])
        : questions.map((q) => String(q.no));
      const records = (state && state.records) || {};
      const markedNos = marks.getBook(setId).nos;

      const pool = order.map((no) => this.entry(byNo[no], no, records[no] || {}, markedNos));
      this.pool = pool;

      const counts = {
        all: pool.length,
        wrong: pool.filter((it) => it.isWrong).length,
        marked: pool.filter((it) => it.marked).length
      };
      // 请求的筛选维度为空时退回「全部」，避免一进来就是空页
      let key = SCOPES.some((s) => s.key === scope) ? scope : 'all';
      if (!counts[key] && counts.all) key = 'all';

      this.setData({
        custom: false,
        title: (bundle.set && bundle.set.title) || '',
        modeLabel: state ? (store.MODE_LABEL[state.mode] || '练习') : '尚未练习'
      });
      this.render(key, counts);
      wx.setNavigationBarTitle({ title: '整卷回顾' });
    } catch (e) {
      console.error('[review] build fail', e);
      this.setData({ loaded: true, emptyText: (e && e.message) || '加载失败' });
    }
  },

  // 自定义练习：按来源题库分组加载，只取本次抽中的题号。
  // 题号在各库之间会重复（每本书都从 1 开始），所以顺序完全以会话的 uid 为准。
  buildCustom(state, scope) {
    const uids = state.order || [];
    const wantBySid = {};
    uids.forEach((uid) => {
      const p = store.parseUid(uid);
      if (!wantBySid[p.sid]) wantBySid[p.sid] = {};
      wantBySid[p.sid][p.no] = 1;
    });

    const cache = {};
    Object.keys(wantBySid).forEach((sid) => {
      const b = dataStore.loadSetBundle(sid);
      const qs = (b && b.questions) || [];
      const want = wantBySid[sid];
      const byNo = {};
      qs.forEach((q) => {
        const no = String(q.no);
        if (want[no]) byNo[no] = q;
      });
      cache[sid] = {
        byNo,
        title: (b && b.set && b.set.title) || '',
        markedNos: marks.getBook(sid).nos || []
      };
    });

    const records = state.records || {};
    const pool = uids.map((uid, i) => {
      const p = store.parseUid(uid);
      const c = cache[p.sid] || {};
      const q = (c.byNo || {})[p.no];
      if (!q) return null;
      const it = this.entry(q, p.no, records[uid] || {}, c.markedNos || [], uid);
      it.seq = i + 1;
      it.from = c.title || '';
      it.no = i + 1;   // 展示本次序号：原题号跨库会撞车
      return it;
    }).filter(Boolean);
    this.pool = pool;

    const counts = {
      all: pool.length,
      wrong: pool.filter((it) => it.isWrong).length,
      marked: pool.filter((it) => it.marked).length
    };
    let key = SCOPES.some((s) => s.key === scope) ? scope : 'all';
    if (!counts[key] && counts.all) key = 'all';

    this.setData({
      custom: true,
      title: state.title || '自定义练习',
      modeLabel: store.MODE_LABEL.custom
    });
    this.render(key, counts);
    wx.setNavigationBarTitle({ title: '整卷回顾' });
  },

  // 把一道题摊平成展示对象
  entry(q, no, rec, markedNos, uid) {
    const correctKeys = q.answerKey ? q.answerKey.split('') : [];
    const selected = (rec.selected || []).slice();
    const answered = !!rec.answered || rec.manual != null;
    const isCorrect = rec.correct === true || rec.manual === 'right';
    const isWrong = rec.correct === false || rec.manual === 'wrong';
    const base = q.options && q.options.length
      ? q.options
      : (q.type === 'judge' ? [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] : []);

    const options = base.map((o) => {
      const right = correctKeys.indexOf(o.key) >= 0;
      const pick = selected.indexOf(o.key) >= 0;
      let cls = '';
      if (right) cls = 'rv-right';
      else if (pick) cls = 'rv-wrong';
      return { key: o.key, text: o.text, cls, right, pick };
    });

    let myAnswer = '未作答';
    if (selected.length) myAnswer = sortLetters(selected.join('')) || selected.join('');
    else if (answered) myAnswer = rec.manual ? '自评（未选）' : '未选择';

    return {
      key: uid || no,
      no,
      srcNo: no,
      from: '',
      seq: 0,
      typeLabel: TYPE_LABEL[q.type] || q.type,
      stem: q.stem || '（题干为空）',
      options,
      hasOptions: options.length > 0,
      myAnswer,
      answered,
      correctAnswer: q.answerKey || q.answer || '',
      isCorrect,
      isWrong,
      selfJudged: !!rec.manual,
      explanation: q.explanation || '',
      marked: markedNos.indexOf(String(no)) >= 0
    };
  },

  filter(scope) {
    const pool = this.pool || [];
    if (scope === 'wrong') return pool.filter((it) => it.isWrong);
    if (scope === 'marked') return pool.filter((it) => it.marked);
    return pool;
  },

  render(scope, counts) {
    const list = this.filter(scope);
    const c = counts || {
      all: (this.pool || []).length,
      wrong: this.filter('wrong').length,
      marked: this.filter('marked').length
    };
    const shown = Math.min(PAGE_SIZE, list.length);
    this.filtered = list;
    this.setData({
      loaded: true,
      scope,
      tabs: SCOPES.map((s) => ({ ...s, count: c[s.key] || 0 })),
      items: list.slice(0, shown),
      total: list.length,
      shown,
      hasMore: list.length > shown,
      wrongN: c.wrong || 0,
      markedN: c.marked || 0,
      emptyText: this.emptyText(scope)
    });
  },

  emptyText(scope) {
    if (!(this.pool || []).length) return '这套题还没有可回顾的内容。';
    if (scope === 'wrong') return '这一次没有答错的题，很稳。';
    if (scope === 'marked') return '这套题还没有标记过题目。答题时点右上角「标记」即可收进这里。';
    return '没有可展示的题目。';
  },

  changeScope(e) {
    const scope = e.currentTarget.dataset.scope;
    if (scope === this.data.scope) return;
    this.render(scope);
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  loadMore() {
    if (!this.data.hasMore) return;
    const list = this.filtered || [];
    const next = Math.min(this.data.shown + PAGE_SIZE, list.length);
    this.setData({
      items: list.slice(0, next),
      shown: next,
      hasMore: next < list.length
    });
  },

  onReachBottom() {
    this.loadMore();
  },

  toggleItem(e) {
    const no = String(e.currentTarget.dataset.no);
    const items = this.data.items.map((it) => (
      String(it.no) === no ? { ...it, expanded: !it.expanded } : it
    ));
    this.setData({ items });
  },

  goWrong() {
    if (!this.data.wrongN) {
      wx.showToast({ title: '这套题暂无错题', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=wrong&title=${encodeURIComponent(this.data.title)}`
    });
  },

  goMarked() {
    if (!this.data.markedN) {
      wx.showToast({ title: '这套题暂无标记题', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/quiz/quiz?setId=${this.data.setId}&mode=marked&title=${encodeURIComponent(this.data.title)}`
    });
  },

  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
