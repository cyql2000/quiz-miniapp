// ============================================================
// 自定义练习 · 设定范围与题量
//
// 三步的联动是这一页的全部重点：
//   1) 改范围（章节 / 题型 / 状态）→ 立刻重算候选池
//   2) 候选池变了 → 题量上限跟着变，超出的数量自动夹回并说明
//   3) 顶部始终摆着「当前范围 + 范围内 N 题 + 本次抽 M 题」
// 每一次改动都走同一条 recount 路径，避免出现「界面显示了 A、
// 实际抽的是 B」这种不一致。
// ============================================================

const custom = require('../../utils/custom');
const store = require('../../utils/progress');

// 「练习状态」每项在界面上的一句话说明（说清点了会做什么）
const STATE_SUB = {
  any: '不筛选，全都要',
  wrong: '只抽做错过的',
  marked: '只抽我标记的'
};

Page({
  data: {
    loading: true,
    books: [],
    scopeAll: true,       // 全部题库与章节
    setIds: [],           // 手动选中的题库（scopeAll 时忽略）
    setTotal: 0,
    pickedCount: 0,
    grandTotal: 0,
    typeChips: [],
    stateChips: [],
    types: [],            // 选中的题型，空 = 全部
    state: 'any',
    presets: [],
    count: custom.DEFAULT_COUNT,
    countIsAll: false,
    poolTotal: 0,
    totalInScope: 0,
    scopeText: '',
    // 每块控件右上角的人话小结：「这几种题、这些状态、抽几道」
    typeText: '不限题型',
    stateText: '全部题目',
    countText: '',
    warn: '',
    canStart: false
  },

  onLoad() {
    this.setData({
      loading: true,
      presets: custom.PRESETS.map((n) => ({ n }))
    });
    // 首次进入要把所有题库扫一遍建索引（一本 1000 题的书解析后有 1MB 以上），
    // 先让页面把骨架渲染出来再算，不然点进来是白屏一段
    setTimeout(() => {
      try {
        this.load();
      } catch (e) {
        console.error('[custom] load fail', e);
        wx.showToast({ title: (e && e.message) || '题库统计失败', icon: 'none' });
      }
      this.setData({ loading: false });
    }, 0);
  },

  // 从文件库 / 生成页返回时题库可能已经变了：指纹变了才重建，否则保留当前选择
  onShow() {
    if (!this.fp) return;
    if (custom.fingerprint() !== this.fp) this.load();
  },

  load() {
    const grouped = custom.groupedChapters().map((b) => ({
      book: b.book,
      count: b.count,
      chapters: b.chapters.map((c) => ({
        setId: c.setId,
        chapter: c.chapter,
        count: c.count,
        checked: true
      }))
    }));

    // 从首页某个题库点进来：默认只在这个题库里抽
    const app = getApp();
    const preset = app && app.globalData ? app.globalData.customPresetSetId : '';
    let scopeAll = true;
    let setIds = [];
    if (preset) {
      const all = [];
      grouped.forEach((b) => b.chapters.forEach((c) => all.push(c.setId)));
      if (all.indexOf(preset) >= 0) {
        scopeAll = false;
        setIds = [preset];
      }
      app.globalData.customPresetSetId = '';
    }

    this.setData({
      books: grouped,
      scopeAll,
      setIds,
      setTotal: grouped.reduce((a, b) => a + b.chapters.length, 0),
      pickedCount: setIds.length,
      grandTotal: grouped.reduce((a, b) => a + b.count, 0)
    });
    this.fp = custom.fingerprint();
    this.refreshChecks();
    this.recount();
  },

  // ---------------- 联动核心 ----------------
  // 任何筛选条件变化后都调它：重算候选池 → 夹紧题量 → 刷新界面文案
  recount() {
    const s = custom.survey({
      setIds: this.data.scopeAll ? [] : this.data.setIds,
      types: this.data.types,
      state: this.data.state
    });
    this.pool = s.pool;

    const max = s.pool.length;
    let count = this.data.count;
    let warn = '';

    if (!max) {
      count = 0;
      // 一个章节都没勾选时，原因比「条件太严」更直白，别让用户去猜
      warn = (!this.data.scopeAll && !this.data.setIds.length)
        ? '还没有勾选任何章节，请在上面选择要练习的范围'
        : '当前范围内没有符合条件的题目，请放宽上面的条件';
    } else if (count > max) {
      // 范围缩小后原来的题量可能已经超过可抽数量：夹回并说明，而不是静默截断
      warn = `当前范围只有 ${max} 题，本次将抽 ${max} 题`;
      count = max;
    }
    if (max && !count) count = Math.min(custom.DEFAULT_COUNT, max);

    this.setData({
      poolTotal: max,
      totalInScope: s.total,
      // 块里写清「点了会做什么」，比只给一个光秃秃的「单选题 120」好懂
      typeChips: custom.TYPES.map((k) => ({
        key: k,
        label: custom.TYPE_LABEL[k],
        sub: '只抽这类题',
        count: s.byType[k] || 0,
        empty: !(s.byType[k] || 0),      // 范围内没有这种题型 → 置灰
        on: this.data.types.indexOf(k) >= 0
      })),
      stateChips: custom.STATES.map((st) => ({
        key: st.key,
        label: st.label,
        sub: STATE_SUB[st.key] || '只抽这类题',
        count: s.byState[st.key] || 0,
        empty: !(s.byState[st.key] || 0),
        on: this.data.state === st.key
      })),
      scopeText: custom.describe({
        setIds: this.data.scopeAll ? [] : this.data.setIds,
        types: this.data.types,
        state: this.data.state
      }),
      count,
      countIsAll: max > 0 && count === max,
      canStart: max > 0,
      // 预设题量随范围变化：超过可抽数量的置灰（点了给提示），否则会出现
      // 「点 10 题 / 20 题 / 30 题 都停在同一个数」这种看起来没反应的情况
      presets: custom.PRESETS.map((n) => ({ n, sub: `本次抽 ${n} 道`, off: n > max })),
      typeText: this.data.types.length
        ? this.data.types.map((t) => custom.TYPE_LABEL[t]).join(' + ')
        : '不限题型',
      stateText: (custom.STATES.filter((s) => s.key === this.data.state)[0] || {}).label || '全部题目',
      countText: `抽 ${count} 题`,
      warn
    });
  },

  // 章节勾选态回填（scopeAll 时全部视为选中）
  refreshChecks() {
    const all = this.data.scopeAll;
    const sel = this.data.setIds;
    const books = this.data.books.map((b) => {
      const chapters = b.chapters.map((c) => ({ ...c, checked: all || sel.indexOf(c.setId) >= 0 }));
      const picked = chapters.filter((c) => c.checked).length;
      return { ...b, chapters, picked, allChecked: picked > 0 && picked === chapters.length };
    });
    this.setData({
      books,
      pickedCount: all ? books.reduce((a, b) => a + b.chapters.length, 0) : sel.length
    });
  },

  // ---------------- 范围：章节 ----------------
  toggleScopeAll() {
    if (this.data.scopeAll) {
      // 切到手动时默认全勾：用户接下来是做减法，不该一上来就 0 题
      const all = [];
      this.data.books.forEach((b) => b.chapters.forEach((c) => all.push(c.setId)));
      this.setData({ scopeAll: false, setIds: all });
    } else {
      this.setData({ scopeAll: true, setIds: [] });
    }
    this.refreshChecks();
    this.recount();
  },

  toggleSet(e) {
    const id = e.currentTarget.dataset.id;
    const setIds = this.data.setIds.slice();
    const i = setIds.indexOf(id);
    if (i >= 0) setIds.splice(i, 1);
    else setIds.push(id);
    this.setData({ scopeAll: false, setIds });
    this.refreshChecks();
    this.recount();
  },

  // 整本书一起选 / 一起取消
  toggleBook(e) {
    const book = e.currentTarget.dataset.book;
    const hit = this.data.books.filter((b) => b.book === book)[0];
    if (!hit) return;
    const ids = hit.chapters.map((c) => c.setId);
    const allIn = ids.every((id) => this.data.setIds.indexOf(id) >= 0);
    let setIds = this.data.setIds.slice();
    if (allIn) setIds = setIds.filter((id) => ids.indexOf(id) < 0);
    else ids.forEach((id) => { if (setIds.indexOf(id) < 0) setIds.push(id); });
    this.setData({ scopeAll: false, setIds });
    this.refreshChecks();
    this.recount();
  },

  // ---------------- 范围：题型 / 状态 ----------------
  // 题型是多选（不选 = 不限），练习状态是三选一（选中的那个决定题池）。
  // 范围内为 0 的选项不拦着用户选（chip 会置灰，顶上还会给出可操作的提示）——
  // 「我想练错题但当前范围里没有」也是一种正当的选择，拦下来反而说不清。
  toggleType(e) {
    const k = e.currentTarget.dataset.k;
    // 模板绑定断了（data-k 为空）时不要往下走：那会往 types 里塞一个空串，
    // 候选池瞬间变 0，用户只看到「范围里没题了」，找不到原因
    if (!k) return;
    const types = this.data.types.slice();
    const i = types.indexOf(k);
    if (i >= 0) types.splice(i, 1);
    else types.push(k);
    // 固定顺序，chip 不随点击跳动
    types.sort((a, b) => custom.TYPES.indexOf(a) - custom.TYPES.indexOf(b));
    this.setData({ types });
    this.recount();
  },

  toggleState(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    this.setData({ state: k });
    this.recount();
  },

  // ---------------- 题量 ----------------
  pickPreset(e) {
    const n = parseInt(e.currentTarget.dataset.n, 10);
    if (!isFinite(n)) return;      // 拿到空值说明绑定坏了，绝不能静默把题量改成 1 题
    if (n > this.data.poolTotal) {
      // 置灰的预设点了要有回音，否则就是「点了没反应」
      wx.showToast({ title: `当前范围只有 ${this.data.poolTotal} 题`, icon: 'none' });
      return;
    }
    this.setCount(n);
  },

  pickAll() {
    this.setCount(this.data.poolTotal);
  },

  stepCount(e) {
    this.setCount(this.data.count + parseInt(e.currentTarget.dataset.d, 10));
  },

  // 输入过程中不改数据：一边输一边夹紧会把「15」打断成「1」
  onCountInput(e) {
    this.rawCount = e.detail.value;
  },

  onCountBlur() {
    if (this.rawCount == null) return;
    this.setCount(parseInt(this.rawCount, 10));
    this.rawCount = null;
  },

  setCount(n) {
    const max = this.data.poolTotal;
    if (!max) {
      wx.showToast({ title: '当前范围没有题目', icon: 'none' });
      return;
    }
    let c = Math.floor(Number(n));
    let warn = '';
    if (!isFinite(c) || c < 1) c = 1;
    if (c > max) {
      c = max;
      warn = `当前范围只有 ${max} 题，已取全部`;
    }
    this.setData({ count: c, countIsAll: c === max, warn, canStart: true });
  },

  // ---------------- 开始 ----------------
  start() {
    if (!this.data.canStart) {
      wx.showToast({ title: this.data.warn || '当前范围没有题目', icon: 'none' });
      return;
    }
    let plan;
    try {
      plan = custom.buildPlan(
        {
          setIds: this.data.scopeAll ? [] : this.data.setIds,
          types: this.data.types,
          state: this.data.state
        },
        this.data.count
      );
      custom.stash(plan);
    } catch (e) {
      wx.showModal({
        title: '无法开始',
        content: (e && e.message) || '抽题失败，请重试',
        showCancel: false
      });
      return;
    }

    const go = () => {
      wx.navigateTo({ url: `/pages/quiz/quiz?setId=${store.CUSTOM_SCOPE}&mode=custom` });
    };

    // 上一组自定义练习还没做完：先说清楚会被覆盖，而不是默默丢掉
    const old = store.getState(store.CUSTOM_SCOPE);
    if (old && !old.finished && (old.order || []).length) {
      wx.showModal({
        title: '有未完成的自定义练习',
        content: '开始新的练习会覆盖上一组未完成的记录，确定继续吗？',
        confirmText: '继续',
        cancelText: '取消',
        success: (res) => { if (res.confirm) go(); }
      });
      return;
    }
    go();
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
