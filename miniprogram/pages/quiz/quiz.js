const store = require('../../utils/progress');
const wrongbook = require('../../utils/wrongbook');
const errata = require('../../utils/errata');
const marks = require('../../utils/marks');
const safe = require('../../utils/safestore');
const dataStore = require('../../utils/store');
const custom = require('../../utils/custom');
const { sortLetters } = require('../../utils/util');

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };
const MODE_TAG = {
  order: '顺序练习',
  random: '随机练习',
  wrong: '错题重练',
  hard: '易错题重练',
  marked: '标记题重练',
  review: '背题模式',
  custom: '自定义练习'
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 解析 'a=1&b=2' 形态的 query 字符串。
// 小程序 AI 的 handoff 接力（skills/quiz-helper 的 createPracticePlan）把
// query 以字符串形态投递过来；页面正常打开时拿到的是已解析好的对象，
// 这里统一成对象再取参，两种入口共用同一段逻辑。
function parseQuery(str) {
  const out = {};
  String(str || '').split('&').forEach((seg) => {
    if (!seg) return;
    const i = seg.indexOf('=');
    const k = i < 0 ? seg : seg.slice(0, i);
    const v = i < 0 ? '' : seg.slice(i + 1);
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  return out;
}

Page({
  data: {
    ready: false,
    setId: '',
    title: '',
    mode: 'order',
    modeTag: '',
    isCustom: false,   // 自定义练习：题目跨多个题库
    customScope: '',   // 本次范围的人话描述，答题页顶部直接展示
    idx: 0,            // 当前位置（1-based）
    total: 0,
    jumpNo: '',        // 答题卡「跳到第 N 题」输入值
    done: 0,           // 已作答数
    cur: null,         // 题干信息
    options: [],       // 选项（含状态）
    answered: false,   // 是否已展示判定结果
    isCorrect: false,
    manualDone: false,
    showReveal: false, // 显示“查看参考答案”
    showSelfJudge: false, // 显示 记对/记错
    isReview: false,
    revealNow: false,  // 主观题已展开参考答案
    correctKeys: [],
    sheet: { show: false, grid: [], marked: 0 },
    marked: false,
    answerText: '',
    explanation: '',
    wb: null,           // 该题在错题本中的历史统计
    justMastered: false,
    masterStreak: wrongbook.MASTER_STREAK,
    errated: false,     // 该题是否已有校对记录
    hasKey: false,      // 该题是否已有可自动判分的标准答案
    er: { show: false, setId: '', title: '', question: null },
    ans: { show: false, setId: '', title: '', question: null }
  },

  onLoad(options) {
    // 小程序 AI 接力进来时 options 是 query 字符串，正常跳转时是对象 —— 统一成对象
    const q = typeof options === 'string' ? parseQuery(options) : (options || {});
    const setId = q.setId;
    const mode = q.mode || 'order';
    const title = decodeURIComponent(q.title || '');
    // nos：指定题号重练（错题本单题/多题重练）
    const nos = q.nos
      ? decodeURIComponent(q.nos).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    if (!setId) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }
    this.nos = nos;
    // start：从第 N 题开始（首页「从第 N 题开始」入口）。初始化完成后再跳，避免与建会话竞态。
    this.pendingStart = parseInt(q.start, 10) || 0;
    this.setData({ setId, title, mode, modeTag: MODE_TAG[mode] || '练习' });
    wx.setNavigationBarTitle({ title: (MODE_TAG[mode] || '练习') + ' · ' + (title || '') });
    this.init(setId, mode).then(() => this.applyPendingStart());
  },

  // 把「从第 N 题开始」落到会话位置上：只移动当前题序，作答记录原样保留
  applyPendingStart() {
    const n = this.pendingStart;
    this.pendingStart = 0;
    if (!n || !this.items || !this.items.length || !this.state) return;
    const i = Math.max(0, Math.min(n, this.items.length) - 1);
    if (i === this.state.idx) return;
    this.state.idx = i;
    this.persist();
    this.goto(i);
  },

  // ---------- 计时（用时统计只计「页面在前台」的时间） ----------
  onShow() {
    // 从后台/其他页面回来：把离场的这段时间跳过，不计入用时
    if (this.state) store.skipIdle(this.state);
    // 回到练习页时，把题库明细重新读一遍。
    // 题目可能在别处被改过（校对清单页里补答案、练习页面板写回），内存里那份若还是旧的，
    // 题卡就一直显示旧内容 —— 用户看到的现象是"我明明改过了，刷题还是错的"。
    // 首次 onShow 紧跟 onLoad，此时 init 还没读完盘（state 为空），自然不会重复读。
    if (this.state) this.syncFromStore();
  },

  // 重新读盘，换掉内存里的题目与错题本/校对缓存，并按当前题序重渲染。
  // 只做「单题库」的会话：自定义练习的题目跨多个题库、由本次抽题计划决定，不在这里重读。
  syncFromStore() {
    if (this.isCustom || !this.state) return;
    const sid = this.data.setId;
    if (!sid) return;
    const b = dataStore.loadSetBundle(sid);
    const qs = (b && b.questions) || [];
    if (!qs.length) return;
    const byNo = {};
    qs.forEach((q) => { byNo[String(q.no)] = q; });
    const item = (this.items || [])[this.state.idx];
    // 题库被换过（重导/删除）时别把页面清空，保持原样由用户自己退出
    if (item && !byNo[String(item.no)]) return;
    this.questions = qs;
    this.byNo = byNo;
    this.refreshBook(sid);
    this.refreshEr(sid);
    if (item) this.setData({ errated: !!this.erItem(sid, item.no) });
    this.goto(this.state.idx);
  },

  onHide() {
    this.persist(true);
  },

  onUnload() {
    this.persist(true);
  },

  async init(setId, mode) {
    try {
      const old = store.getState(setId);
      // 自定义练习：题目清单来自计划/会话本身（跨题库），没有对应的单份题库明细
      if (mode === 'custom' || (old && old.custom)) {
        this.initCustom(setId, mode, old);
        return;
      }
      const bundle = dataStore.loadSetBundle(setId);
      if (!bundle) throw new Error('题库不存在或已删除');
      const questions = bundle.questions || [];
      if (!questions.length) throw new Error('题库为空');
      this.questions = questions;
      const byNo = {};
      questions.forEach((q) => { byNo[String(q.no)] = q; });
      this.byNo = byNo;
      // 错题本 / 校对本 / 标记本：按题库缓存，写入后刷新。
      // 用 Map 而不是单个对象，是因为自定义练习的题目来自多个题库。
      this.books = { wb: {}, er: {}, mk: {} };

      const oldUnfinished = old && !old.finished && ((old.idx && old.idx > 0) || (old.records && Object.keys(old.records).length > 0));

      // 旧数据迁移：标记早期只写在会话 state.marks 里，开新会话就丢。
      // 这里把存量标记并进持久化清单，并把会话里那份清空（idempotent，重复进入不会重复搬）。
      if (marks.migrateFromState(setId, old) && old) {
        store.skipIdle(old);
        store.saveState(old);
      }

      const enter = () => {
        this.buildItems();
        store.skipIdle(this.state); // 进入答题页时把计时基准移到此刻
        this.setData({ ready: true, total: this.state.total });
        this.goto(this.state.idx);
      };

      // 恢复上次未完成的会话：兼容题库变更（剔除已不存在的题目）并夹紧位置。
      // 「点继续」和 mode==='continue' 走的是同一条路，抽出来只维护一份。
      const resume = () => {
        if (old.order) old.order = old.order.filter((no) => byNo[no]);
        if (!old.order || !old.order.length) old.order = questions.map((q) => String(q.no));
        old.total = old.order.length;
        if (old.idx > old.total - 1) old.idx = old.total - 1;
        if (old.idx < 0) old.idx = 0;
        // 上次可能是另一种模式（上次做随机、这次点顺序）：标签跟着会话走，别指错
        const m = old.mode || mode;
        this.setData({ mode: m, modeTag: MODE_TAG[m] || MODE_TAG[mode] || '练习' });
        wx.setNavigationBarTitle({ title: (MODE_TAG[m] || '练习') + ' · ' + (this.data.title || '') });
        this.state = old;
        enter();
      };

      if (mode === 'continue') {
        if (old && !old.finished) { resume(); return; }
        mode = 'order';
        this.setData({ mode: 'order', modeTag: MODE_TAG.order });
        this.state = store.createState(setId, this.data.title, 'order', questions.map((q) => String(q.no)));
        enter();
        return;
      }
      if (mode === 'wrong' || mode === 'hard' || mode === 'marked') {
        // 错题本 / 标记都是跨会话持久化数据，题目来源于它们而非上一次会话
        let pool;
        if (this.nos && this.nos.length) {
          pool = this.nos.filter((no) => byNo[no]);
        } else if (mode === 'marked') {
          pool = marks.list(setId).filter((no) => byNo[no]);
        } else {
          pool = wrongbook
            .listItems(setId, mode === 'hard' ? 'hard' : 'pending')
            .map((it) => String(it.no))
            .filter((no) => byNo[no]);
        }
        if (!pool.length) {
          wx.showToast({ title: this.emptyPoolTip(mode), icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
          return;
        }
        this.state = store.createState(setId, this.data.title, mode, pool);
        enter();
        return;
      }
      // order / random / review：新建会话。startNo = 从第几题开始（1 起算）
      const build = (startNo) => {
        const order = mode === 'random' ? shuffle(questions.map((q) => String(q.no))) : questions.map((q) => String(q.no));
        this.state = store.createState(setId, this.data.title, mode, order);
        const i = Math.max(0, Math.min((startNo || 1) - 1, (this.state.total || 1) - 1));
        this.state.idx = i;        // enter() 里 goto(state.idx)
        this.persist();            // createState 刚落盘的是 idx=0，起点要跟着一起存
        enter();
      };
      if (oldUnfinished) {
        // 三条路都摆在明面上，各自后果写进选项文案：
        //   继续（不动记录，从上次停下那道题接着做）
        //   从第 N 题开始（清空记录，从这次点进来的那道题重做）
        //   重新开始（清空记录，从第 1 题重做）
        // 「重新开始 / 从第 N 题开始」都会覆盖整套未完成进度且不可恢复，
        // 所以主位留给「继续」——点进练习页的意图多半是把没做完的做完。
        const answered = Object.keys(old.records || {}).length;
        const total = old.total || (old.order || []).length;
        const at = Math.max(1, Math.min((old.idx || 0) + 1, total));
        // 「当前题目」= 这次点进来的那道题（预览页 / 答题卡跳题带过来的 start），
        // 没有指定就是上次停下的那道。
        const cur = this.pendingStart > 0 ? Math.max(1, Math.min(this.pendingStart, total)) : at;
        const itemList = [`继续（第 ${at} 题 · 已答 ${answered}/${total}）`];
        // 随机顺序里「第 N 题」没有意义（每轮顺序都不同），这一项就不给
        if (mode !== 'random') itemList.push(`从第 ${cur} 题开始（清空记录，从这道题重做）`);
        itemList.push('重新开始（清空记录，从第 1 题重做）');
        wx.showActionSheet({
          itemList,
          success: (s) => {
            if (s.tapIndex === 0) resume();
            else if (itemList.length === 3 && s.tapIndex === 1) build(cur);
            else build(1);
          },
          // 点遮罩取消 = 退出，不动任何数据
          fail: () => wx.navigateBack()
        });
      } else {
        build(1);
      }
    } catch (e) {
      console.error('[quiz] init fail', e);
      wx.showModal({
        title: '加载失败',
        content: (e && e.message) || '未知错误',
        showCancel: false,
        success: () => wx.navigateBack()
      });
    }
  },

  // 会话题序 → 题项数组。
  // 普通会话的 uid 就是题号本身（历史进度按题号存，不做迁移）；
  // 自定义练习的 uid 是 sid::no（题号会跨库撞车，必须带上来源）。
  buildItems() {
    const s = this.state;
    if (!s) { this.items = []; return; }
    this.items = (s.order || []).map((key) => {
      if (!this.isCustom) {
        return { uid: key, sid: this.data.setId, no: key, title: this.data.title };
      }
      const p = store.parseUid(key);
      const hit = this.byUid[key];
      return { uid: key, sid: p.sid, no: p.no, title: (hit && hit.title) || '' };
    });
  },

  // 自定义练习：题目清单由自定义页抽好后带过来（或沿用上次未完成的会话）。
  // 只加载涉及到的题库、且只把抽中的题留在内存 —— 抽 20 题不该把 60 个
  // 题库的明细全读进来常驻。
  initCustom(setId, mode, old) {
    const resuming = mode === 'continue' && old && !old.finished && (old.order || []).length;
    let plan = resuming
      ? { items: old.items || [], title: old.title, scope: old.scope || '' }
      : custom.takePlan();

    if (!plan || !plan.items || !plan.items.length) {
      wx.showToast({ title: '练习计划已失效，请重新设定范围', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 统一题号类型，否则 uid 会出现 '1' 与 1 拼不成同一个键
    plan.items = plan.items.map((it) => ({ sid: it.sid, no: String(it.no) }));

    this.isCustom = true;

    const want = {};
    const sids = [];
    plan.items.forEach((it) => {
      want[store.itemUid(it.sid, it.no)] = 1;
      if (sids.indexOf(it.sid) < 0) sids.push(it.sid);
    });

    const byUid = {};
    sids.forEach((sid) => {
      const b = dataStore.loadSetBundle(sid);
      const qs = (b && b.questions) || [];
      const title = (b && b.set && b.set.title) || '';
      qs.forEach((q) => {
        const uid = store.itemUid(sid, q.no);
        if (!want[uid]) return;
        byUid[uid] = { q, sid, title };
      });
    });
    this.byUid = byUid;
    this.books = { wb: {}, er: {}, mk: {} };

    this.setData({
      setId,
      title: plan.title || '自定义练习',
      mode: 'custom',
      modeTag: MODE_TAG.custom,
      isCustom: true,
      customScope: plan.scope || ''
    });
    wx.setNavigationBarTitle({ title: plan.title || MODE_TAG.custom });

    // 恢复时以会话题序为准；题目被删或题库更新过就剔除，不让用户卡在空题上
    const order = (resuming ? old.order : plan.items.map((it) => store.itemUid(it.sid, it.no)))
      .filter((uid) => byUid[uid]);

    if (!order.length) {
      wx.showModal({
        title: '无法开始练习',
        content: '抽中的题目已被删除或题库已更新，请重新设定范围。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }

    const toItems = (uids) => uids.map((uid) => {
      const p = store.parseUid(uid);
      return { sid: p.sid, no: p.no };
    });

    if (resuming && order.length === old.order.length) {
      this.state = old;
    } else if (resuming) {
      // 有题目失效：保留作答记录，只摘掉失效项
      old.order = order;
      old.items = toItems(order);
      old.total = order.length;
      if (old.idx > old.total - 1) old.idx = old.total - 1;
      if (old.idx < 0) old.idx = 0;
      this.state = old;
      store.saveState(old);
    } else {
      this.state = store.createCustomState({
        items: toItems(order),
        title: plan.title,
        scope: plan.scope
      });
    }

    store.skipIdle(this.state);
    this.buildItems();
    this.setData({ ready: true, total: this.state.total });
    this.goto(this.state.idx);
  },

  emptyPoolTip(mode) {
    if (mode === 'hard') return '暂无易错题';
    if (mode === 'marked') return '暂无标记题，答题时点右上角「标记」就能收进来';
    return '暂无错题，先去练几道吧';
  },

  goto(position) {
    const s = this.state;
    if (!s || !this.items || !this.items.length) return;
    if (position < 0) position = 0;
    if (position > this.items.length - 1) position = this.items.length - 1;
    s.idx = position;
    const item = this.items[position];
    const no = item.no;
    this.curItem = item;
    this.curNo = no;
    // 题目来源题库：错题本 / 标记 / 校对都要写回它自己那一本
    this.curSid = item.sid;
    const q = this.isCustom ? (this.byUid[item.uid] || {}).q : this.byNo[no];
    if (!q) return;
    this.curQ = q;
    // 答题记录必须挂回 records 上：这里取到的是「引用」，
    // 后面 confirmAnswer / judgeSelf / tapOption 都是直接改这个对象的字段。
    // 原先写成 `(s.records[uid]) || {}` —— 新题拿到的是个游离对象，改完没写回，
    // 结果 records 永远是空的：已答数、正确率、整卷回顾的「我的作答」全部失真。
    if (!s.records) s.records = {};
    if (!s.records[item.uid]) s.records[item.uid] = {};
    const rec = s.records[item.uid];
    this.curRec = rec;

    const isReview = s.mode === 'review';
    const auto = !!(q.answerKey);                 // 可自动判定
    const treatManual = q.type === 'text' || !auto; // 需主观自评/对照答案
    const unjudged = rec.manual == null && !rec.answered;

    const answered = !!rec.answered || rec.manual != null || (auto && isReview);
    const revealNow = !!rec.reveal || answered || (isReview && !!(q.answer || q.explanation));
    const showReveal = treatManual && !isReview && !rec.reveal && unjudged;
    // 最后一项是 `rec.answered && …`：新题上 rec.answered 是 undefined，
    // 整个短路链就返回 undefined（而不是 false）→ setData 报
    // "Setting data field "showSelfJudge" to undefined is invalid"。
    // wxml 里它走 wx:elif，undefined 与 false 表现一致，所以功能没坏、只是刷屏。
    // 整体布尔化，从根上不许非布尔进 setData。
    const showSelfJudge = !!(
      (auto && isReview && unjudged) ||                       // 背题模式：记住/没记住
      (treatManual && isReview && unjudged) ||                // 主观题背题
      (treatManual && !isReview && rec.reveal && unjudged) || // 主观题看完答案后自评
      (rec.answered && !rec.manual && !auto)                  // 无标准答案题需补自评
    );

    this.selected = (rec.selected || []).slice();

    const options = this.buildOptions(q, rec, isReview);
    const done = this.countAnswered(s);

    this.setData({
      idx: position + 1,
      // 自定义练习的题号来自不同题库（每本书都从 1 开始），展示用本次序号，
      // 原题号保留在 srcNo 里，来源章节单独标一行
      cur: {
        no: this.isCustom ? position + 1 : no,
        srcNo: no,
        from: this.isCustom ? (item.title || '') : '',
        stem: q.stem,
        type: q.type,
        typeLabel: TYPE_LABEL[q.type] || q.type,
        // 有没有可判分的标准答案 —— 没有时给「补答案」入口
        hasKey: !!q.answerKey,
        // 有答案但用不上 → 展示时要说明原因，避免被当成"答案错了"
        //   missingOption 选项录入时缺失 / typeConflict 答案与题目形态对不上
        answerSuspect: !!q.answerSuspect,
        answerSuspectKind: q.answerSuspectKind || ''
      },
      options,
      answered,
      isCorrect: rec.correct === true,
      manualDone: rec.manual != null,
      showReveal,
      showSelfJudge,
      isReview,
      revealNow,
      correctKeys: auto ? q.answerKey.split('') : [],
      answerText: q.answer || '',
      explanation: q.explanation || '',
      marked: this.isMarked(item.sid, no),
      wb: this.wbInfo(item.sid, no),
      errated: !!this.erItem(item.sid, no),
      justMastered: false,
      done,
      total: s.total,
      progress: s.total ? Math.round((position / s.total) * 100) : 0
    });
  },

  // ---------- 错题本 ----------
  wbBookOf(sid) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    if (!this.books.wb[sid]) this.books.wb[sid] = wrongbook.getBook(sid);
    return this.books.wb[sid];
  },

  wbItem(sid, no) {
    return (this.wbBookOf(sid).items || {})[String(no)] || null;
  },

  refreshBook(sid) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    this.books.wb[sid] = wrongbook.getBook(sid);
  },

  wbInfo(sid, no) {
    const it = this.wbItem(sid, no);
    if (!it) return null;
    const attempts = it.attempts || 0;
    return {
      wrongCount: it.wrongCount || 0,
      rightCount: it.rightCount || 0,
      attempts,
      errRate: attempts ? Math.round(((it.wrongCount || 0) / attempts) * 100) : 0,
      hard: wrongbook.isHard(it),
      mastered: !!it.mastered
    };
  },

  // 判定结果写入错题本：答错收录/累加，连续答对满次数自动归入已掌握
  // sid 只在「交卷时批量判分」这类跨题场景才传 —— 那时 curSid 还停在别的题上
  recordToBook(q, correct, selected, sid) {
    const book = sid || this.curSid || this.data.setId;
    const it = wrongbook.recordAnswer(book, q, {
      correct,
      selected: selected || '',
      mode: this.state ? this.state.mode : '',
      title: this.titleOf(book)
    });
    this.refreshBook(book);
    return it;
  },

  // 题库标题：单库会话直接用页面标题，自定义练习取题项带上来的来源标题
  titleOf(sid) {
    if (!this.isCustom) return this.data.title;
    const hit = this.items && this.items.filter((it) => it.sid === sid)[0];
    return (hit && hit.title) || '';
  },

  // ---------- 校对（勘误） ----------
  erItem(sid, no) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    if (!this.books.er[sid]) this.books.er[sid] = errata.getBook(sid);
    return (this.books.er[sid].items || {})[String(no)] || null;
  },

  refreshEr(sid) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    this.books.er[sid] = errata.getBook(sid);
  },

  openErrata() {
    const q = this.curQ;
    if (!q) return;
    const sid = this.curSid || this.data.setId;
    this.setData({
      er: {
        show: true,
        setId: sid,
        title: this.titleOf(sid),
        question: {
          no: this.curNo,
          stem: q.stem || '',
          options: q.options || [],
          answerKey: q.answerKey || '',
          answer: q.answer || '',
          explanation: q.explanation || ''
        }
      }
    });
  },

  closeErrata() {
    this.setData({ 'er.show': false });
  },

  onErrataSaved(e) {
    // 校对面板保存时已经把这题的修正写回题库明细（applyFix），
    // 这里把内存里那份换成新的 —— 不然题卡上还是改之前的内容，等于白改。
    this.applyFreshQuestion(e && e.detail && e.detail.question);
    const sid = this.curSid || this.data.setId;
    this.refreshEr(sid);
    this.setData({ errated: !!this.erItem(sid, this.curNo) });
  },

  // 题目明细被面板改过之后：换掉内存里那份并重渲染当前题
  applyFreshQuestion(fresh) {
    if (!fresh) return;
    if (this.isCustom) {
      const hit = this.byUid && this.byUid[this.curItem.uid];
      if (hit) hit.q = fresh;
    } else if (this.byNo) {
      this.byNo[String(fresh.no)] = fresh;
    }
    if (this.questions) {
      this.questions = this.questions.map((it) => (String(it.no) === String(fresh.no) ? fresh : it));
    }
    // 错题本里的快照也被 applyFix 一并更了，缓存跟着刷新
    const sid = this.curSid || this.data.setId;
    if (sid) this.refreshBook(sid);
    if (this.state) this.goto(this.state.idx);
  },

  // ---------- 答案补全 ----------
  // 题库里没答案，或答案明显有误时，当场把这题的正确答案与解析补上。
  // 改的是题库明细本身，所以判分、整卷回顾、错题本快照会一起跟上。
  openAnswerSheet() {
    const q = this.curQ;
    if (!q) return;
    const sid = this.curSid || this.data.setId;
    this.setData({
      ans: {
        show: true,
        setId: sid,
        title: this.titleOf(sid),
        question: {
          no: this.curNo,
          stem: q.stem || '',
          type: q.type,
          options: q.options || [],
          answerKey: q.answerKey || '',
          answer: q.answer || '',
          explanation: q.explanation || ''
        }
      }
    });
  },

  closeAnswerSheet() {
    this.setData({ 'ans.show': false });
  },

  onAnswerSaved(e) {
    const fresh = e.detail && e.detail.question;
    // 把新题目换进内存里的那份，再重渲染当前题 —— 此时已有答案，可以正常判分
    this.applyFreshQuestion(fresh);
    // 面板不在这里关：组件要先展示「修改结果」让用户确认，点「完成」才走 closeAnswerSheet
    // 校对记录也一起变了（补答案会把能修完的题归入「已修」），题卡上的纠错标记同步刷新
    const sid = this.curSid || this.data.setId;
    this.refreshEr(sid);
    this.setData({ errated: !!this.erItem(sid, this.curNo) });
  },

  buildOptions(q, rec, isReview) {
    if (q.type === 'text') return [];
    const selected = (rec.selected || []).slice();
    const correctKeys = q.answerKey ? q.answerKey.split('') : [];
    const hasKey = !!q.answerKey;
    // 无标准答案的题目不做红绿判定，仅保留选中态，由用户自评
    const shown = hasKey && (rec.answered || rec.manual != null || isReview);
    const classify = (key) => {
      if (shown) {
        if (correctKeys.indexOf(key) >= 0) return 'opt-right';
        if (selected.indexOf(key) >= 0) return 'opt-wrong';
        return '';
      }
      if (selected.indexOf(key) >= 0) return 'opt-picked';
      return '';
    };
    const base = q.options && q.options.length
      ? q.options
      : (q.type === 'judge'
          ? [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }]
          : []);
    return base.map((o) => ({
      key: o.key,
      text: o.text,
      cls: classify(o.key),
      isRight: correctKeys.indexOf(o.key) >= 0,
      isSel: selected.indexOf(o.key) >= 0
    }));
  },

  countAnswered(s) {
    let n = 0;
    Object.keys(s.records || {}).forEach((no) => {
      const r = s.records[no];
      if (r.answered || r.manual) n++;
    });
    return n;
  },

  // 已选、但还没点「确认答案」的题数 —— 交卷时会自动判掉
  pendingCount(s) {
    let n = 0;
    (this.items || []).forEach((item) => {
      const r = (s.records || {})[item.uid];
      if (!r || r.answered || r.manual != null) return;
      if ((r.selected || []).length) n++;
    });
    return n;
  },

  // 取某道题的对象：单库按题号，自定义练习按 uid（题号会跨库撞车）
  qOfItem(item) {
    if (this.isCustom) {
      const hit = this.byUid && this.byUid[item.uid];
      return hit ? hit.q : null;
    }
    return this.byNo ? this.byNo[item.no] : null;
  },

  // 交卷时把「选了但没确认」的题一次性判掉 —— 一次刷几十道不用逐题点确认。
  // 判分口径必须与 confirmAnswer 完全一致（同样的 sortLetters 比较、同样写错题本），
  // 否则会出现「自动判的」与「手动确认的」两套结果。
  // 返回 { judged, needSelf }：judged = 已自动判分；needSelf = 没标准答案、留给用户自评。
  autoJudgePending(s) {
    let judged = 0;
    let needSelf = 0;
    (this.items || []).forEach((item) => {
      const rec = (s.records || {})[item.uid];
      if (!rec || rec.answered || rec.manual != null) return;
      const sel = rec.selected || [];
      if (!sel.length) return;
      const q = this.qOfItem(item);
      if (!q || q.type === 'text') return;      // 问答题本来就要自评，不替用户判
      const mine = sortLetters(sel.join(''));
      const right = sortLetters(q.answerKey || '');
      rec.answered = true;
      rec.reveal = true;
      if (!right) {
        rec.correct = null;                     // 无标准答案 → 与点「确认答案」后一样，进自评
        needSelf++;
        return;
      }
      rec.correct = mine === right;
      this.recordToBook(q, rec.correct, mine, item.sid);
      judged++;
    });
    return { judged, needSelf };
  },

  // silent：页面正在离开（onHide/onUnload）时不弹窗——弹窗在卸载过程中看不见，
  //         留给待提示队列，由下一个可见页面 take() 后告知，信息不会丢。
  persist(silent) {
    if (!this.state) return;
    store.recomputeWrongs(this.state);
    store.saveState(this.state);
    if (!silent) this.surfaceStorageError();
    this.setData({ done: this.countAnswered(this.state) });
  },

  // 写入失败不能静默：一次会话只弹一次，避免每答一题都打断
  surfaceStorageError() {
    if (this.storageWarned) return;
    const p = safe.take();
    if (!p) return;
    this.storageWarned = true;
    wx.showModal({
      title: '记录未能保存',
      content: p.message,
      showCancel: false
    });
  },

  // ---------- 交互 ----------
  tapOption(e) {
    const key = e.currentTarget.dataset.key;
    const rec = this.curRec;
    const q = this.curQ;
    const auto = !!q.answerKey;
    if (rec.answered || rec.manual != null || (auto && this.data.isReview)) return;
    if (q.type === 'multi') {
      const i = this.selected.indexOf(key);
      if (i >= 0) this.selected.splice(i, 1);
      else this.selected.push(key);
    } else {
      this.selected = [key];
    }
    this.curRec.selected = this.selected.slice();
    this.setData({
      options: this.data.options.map((o) => ({
        ...o,
        cls: this.selected.indexOf(o.key) >= 0 ? 'opt-picked' : '',
        isSel: this.selected.indexOf(o.key) >= 0
      }))
    });
  },

  confirmAnswer() {
    const q = this.curQ;
    const rec = this.curRec;
    if (q.type === 'text') return;
    if (!this.selected.length) {
      wx.showToast({ title: '请先作答', icon: 'none' });
      return;
    }
    const mine = sortLetters(this.selected.join(''));
    const right = sortLetters(q.answerKey || '');
    rec.selected = this.selected.slice();
    rec.answered = true;
    rec.reveal = true;

    if (!right) {
      // 无标准答案：进入自评
      rec.correct = null;
      this.persist();
      this.setData({
        answered: true,
        showReveal: false,
        showSelfJudge: true,
        revealNow: true,
        answerText: q.answer || '',
        explanation: q.explanation || '',
        options: this.buildOptions(q, rec, false)
      });
      wx.showToast({ title: '暂无标准答案，请对照参考答案自评', icon: 'none' });
      return;
    }
    const correct = mine === right;
    rec.correct = correct;
    this.persist();

    const before = this.wbItem(this.curSid, this.curNo);
    const wasMastered = !!(before && before.mastered);
    const it = this.recordToBook(q, correct, mine);

    this.setData({
      answered: true,
      isCorrect: correct,
      showSelfJudge: false,
      wb: this.wbInfo(this.curSid, this.curNo),
      justMastered: !wasMastered && !!(it && it.mastered),
      options: this.buildOptions(q, rec, false)
    });
    wx.showToast({ title: correct ? '回答正确' : '回答错误', icon: correct ? 'success' : 'none' });
  },

  toggleReveal() {
    const rec = this.curRec;
    rec.reveal = true;
    this.persist();
    this.setData({ revealNow: true, showReveal: false, showSelfJudge: true });
  },

  judgeSelf(e) {
    const ok = e.currentTarget.dataset.ok === '1';
    const rec = this.curRec;
    const q = this.curQ;
    rec.manual = ok ? 'right' : 'wrong';
    rec.answered = true;
    rec.reveal = true;
    rec.correct = ok;
    this.persist();

    // 主观题自评 / 背题模式自评同样计入错题本
    const before = this.wbItem(this.curSid, this.curNo);
    const wasMastered = !!(before && before.mastered);
    const it = this.recordToBook(q, ok, this.selected.join(''));

    this.setData({
      answered: true,
      isCorrect: ok,
      manualDone: true,
      showSelfJudge: false,
      wb: this.wbInfo(this.curSid, this.curNo),
      justMastered: !wasMastered && !!(it && it.mastered),
      options: this.buildOptions(q, rec, this.data.isReview)
    });
  },

  // ---------- 标记 ----------
  // 会话内缓存，写入后刷新（与错题本、校对本同一套做法，避免每翻一题读一次 storage）
  mkBookOf(sid) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    if (!this.books.mk[sid]) this.books.mk[sid] = marks.getBook(sid);
    return this.books.mk[sid];
  },

  markNos(sid) {
    return this.mkBookOf(sid).nos || [];
  },

  isMarked(sid, no) {
    return this.markNos(sid).indexOf(String(no)) >= 0;
  },

  refreshMk(sid) {
    if (!this.books) this.books = { wb: {}, er: {}, mk: {} };
    this.books.mk[sid] = marks.getBook(sid);
  },

  // 标记按题库持久化（utils/marks.js），不再只活在本次会话里 —— 这样「标记题重练」
  // 才有稳定的题源，也才能从首页/答题卡再找回来。
  // 自定义练习跨库时，标记写在题目所属的那个题库上。
  toggleMark() {
    const no = this.curNo;
    const sid = this.curSid || this.data.setId;
    if (!no) return;
    const r = marks.toggle(sid, no, this.titleOf(sid));
    this.refreshMk(sid);
    this.setData({ marked: r.marked });
    this.surfaceStorageError();
    wx.showToast({
      title: r.marked ? `已标记（共 ${r.total} 题）` : `已取消标记（剩 ${r.total} 题）`,
      icon: 'none'
    });
    this.persist();
  },

  prev() {
    const s = this.state;
    if (s.idx <= 0) { wx.showToast({ title: '已经是第一题', icon: 'none' }); return; }
    s.idx -= 1;
    this.persist();
    this.goto(s.idx);
  },

  next() {
    const s = this.state;
    this.persist();
    if (s.idx >= s.total - 1) { this.finish(); return; }
    s.idx += 1;
    this.goto(s.idx);
  },

  finish() {
    const s = this.state;
    if (s.finished) { this.goResult(); return; }
    const pending = this.pendingCount(s);
    const left = s.total - this.countAnswered(s) - pending;
    const parts = [];
    if (left > 0) parts.push(`还有 ${left} 题未作答`);
    if (pending > 0) parts.push(`另有 ${pending} 题已选未确认，交卷时按已选自动判分`);
    const tip = parts.length ? `${parts.join('；')}。确定交卷吗？` : '完成本次练习，查看成绩？';
    const that = this;
    wx.showModal({
      title: '交卷',
      content: tip,
      confirmText: '交卷',
      success(res) {
        if (!res.confirm) return;
        // 交卷即把「选了没确认」的题一并判掉：单题判分链路完全复用 autoJudgePending
        const r = that.autoJudgePending(s);
        s.finished = true;
        store.recomputeWrongs(s);
        store.saveState(s);       // 交卷即结清计时
        that.surfaceStorageError();
        if (r.judged) {
          wx.showToast({ title: `已自动判分 ${r.judged} 题`, icon: 'none' });
          setTimeout(() => that.goResult(), 700);   // 让提示露个脸再跳成绩页
          return;
        }
        that.goResult();
      }
    });
  },

  goResult() {
    wx.redirectTo({ url: `/pages/result/result?setId=${this.data.setId}` });
  },

  exit() {
    const that = this;
    wx.showModal({
      title: '退出练习',
      content: '当前进度已自动保存，可随时从首页继续。',
      confirmText: '退出',
      success(res) {
        if (res.confirm) wx.navigateBack();
      }
    });
  },

  // ---------- 答题卡 ----------
  openSheet() {
    const s = this.state;
    let markedInSheet = 0;
    const grid = (this.items || []).map((item, i) => {
      const r = (s.records && s.records[item.uid]) || {};
      let cls = 'g-blank';
      if (r.correct === true || r.manual === 'right') cls = 'g-right';
      else if (r.correct === false || r.manual === 'wrong') cls = 'g-wrong';
      else if (r.answered) cls = 'g-done';
      if (i === s.idx) cls = 'g-cur';
      // 标记态单独用角标表示，不参与 cls 竞争（cls 已被「当前题」抢占）
      const mk = this.isMarked(item.sid, item.no);
      if (mk) markedInSheet++;
      // 自定义练习的题号跨库会重复，格子里显示本次序号
      return { uid: item.uid, cls, num: this.isCustom ? (i + 1) : item.no, i, mk };
    });
    this.setData({ sheet: { show: true, grid, marked: markedInSheet } });
  },

  closeSheet() {
    this.setData({ 'sheet.show': false });
  },

  jumpTo(e) {
    const i = parseInt(e.currentTarget.dataset.i, 10);
    this.state.idx = i;
    this.persist();
    this.setData({ 'sheet.show': false });
    this.goto(i);
  },

  // 答题卡「跳到第 N 题」：N 是本次练习的题序（1 起），与题卡格子编号一致
  onJumpInput(e) {
    this.setData({ jumpNo: e.detail.value });
  },

  doJump() {
    const n = parseInt(this.data.jumpNo, 10);
    const total = (this.items || []).length;
    if (!n || n < 1) {
      wx.showToast({ title: '输入要跳到的题序', icon: 'none' });
      return;
    }
    if (n > total) {
      wx.showToast({ title: `本次共 ${total} 题`, icon: 'none' });
      return;
    }
    this.setData({ jumpNo: '' });
    this.state.idx = n - 1;
    this.persist();
    this.setData({ 'sheet.show': false });
    this.goto(n - 1);
  }
});
