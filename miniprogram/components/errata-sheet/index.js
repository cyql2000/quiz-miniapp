// 校对编辑面板：刷题时发现题干/选项/答案/解析有问题，当场写下正确内容。
// 写下的内容会**直接写回题库明细**（applyFix）——只记清单不改题库，练习页还是旧内容，
// 等于白记；清单那一份是留给「回头把源文件也改掉」用的。
const errata = require('../../utils/errata');
const answers = require('../../utils/answers');
const util = require('../../utils/util');

// 各字段的占位提示（只读态显示它就等于「这里还没写」）
const FIELD_PH = {
  stem: '点这里写正确的题干',
  options: '点这里写正确的选项，如 A. 甲 / B. 乙',
  answer: '点这里写正确的答案，如 AC',
  explanation: '点这里写正确的解析',
  note: '点这里写备注，如：与书末答案速览不一致 / 题号错位 / 此处应有表格图'
};

// 只读框最多显示几行；超出的部分靠框内滚动看（滚轮），不把面板撑高。
// 「答案」通常就一行，固定给 6 行高会留一大片空白，所以高度按内容算（util.boxOf）。
const MAX_LINES = { stem: 6, options: 6, answer: 2, explanation: 6, note: 3 };
const boxOf = util.boxOf;

Component({
  properties: {
    show: { type: Boolean, value: false, observer: 'onShowChange' },
    setId: { type: String, value: '' },
    title: { type: String, value: '' },
    // { no, stem, options, answerKey, answer, explanation }
    question: { type: Object, value: null }
  },

  data: {
    types: errata.TYPES,
    active: [],
    // 需要显示的输入项 [{ key, label, ph, value, h, over }]（value 是只读态要展示的当前值）
    fields: [],
    // 以下五个是「已提交值」的镜像，只读态直接读它们
    stem: '',
    options: '',
    answer: '',
    explanation: '',
    note: '',
    noteH: 0,        // 备注只读框高度
    noteOver: false,
    // 上次写下过、题库里却还是另一个样子 → 面板顶部明说，别让人以为已经生效
    staleText: '',
    // 正文区高度（px），由 js 按「内容自然高」和「面板可用高」取小算出来，见 measure/bodyHeightOf。
    // 为什么非要算死：正文里、滚动容器里都可能藏着原生组件（textarea），
    // 它们层级最高又不吃 overflow 裁剪，只要正文区高度是"撑出来的"，
    // 就会画到面板底部压住「保存」（真机必现，开发者工具看不出来）。
    bodyH: 0,
    // 正在编辑的字段 key；'' = 列表态。编辑态下正文只放这一个输入框，见 startEdit 注释。
    editing: '',
    editLabel: '',
    editPh: '',
    editValue: '',
    existed: false
  },

  methods: {
    onShowChange(show) {
      if (show) this.reset();
    },

    reset() {
      const q = this.data.question || {};
      const old = errata.getItem(this.data.setId, q.no);
      const o = (old && old.original) || {};
      const f = (old && old.fix) || {};
      const active = (old && old.types) || [];
      // 预填一律以**题库现值**为准：面板上看到的必须是"这道题现在真实的样子"。
      // 原来优先填历史修正值，写回失败时面板显示的是"我上次写下的内容"，
      // 看上去像已经改好了，一刷题却还是旧的 —— 用户报的「我明明改过了」正是这么来的。
      // 只有题库里本身为空时才退回历史记录（用户写过的东西不能丢）。
      const values = {
        stem: q.stem || f.stem || o.stem || '',
        options: errata.optionsToText(q.options) || f.options || o.options || '',
        answer: q.answerKey || q.answer || f.answer || o.answer || '',
        explanation: q.explanation || f.explanation || o.explanation || '',
        note: f.note || ''
      };
      // 上次写下过、题库里却还是另一个样子 → 在面板上明说，别让人以为已经生效
      const stale = [];
      [['stem', '题干'], ['options', '选项'], ['answer', '答案'], ['explanation', '解析']].forEach((pair) => {
        const want = String(f[pair[0]] || '').trim();
        if (want && want !== String(values[pair[0]] || '').trim()) {
          stale.push(`${pair[1]}＝${want.length > 24 ? want.slice(0, 24) + '…' : want}`);
        }
      });
      this.draft = Object.assign({}, values);   // 用户输入只进这里，不回写 data，避免光标跳动
      this.editBefore = '';
      const noteBox = boxOf(values.note, MAX_LINES.note);
      this.setData(Object.assign({
        active,
        existed: !!old,
        editing: '',
        editLabel: '',
        editPh: '',
        editValue: '',
        noteH: noteBox.h,
        noteOver: noteBox.over,
        staleText: stale.join('；'),
        fields: this.fieldsOf(active, values)
      }, values), () => this.measure());
    },

    // ---------- 布局：把正文区高度算成确定的 px ----------
    // 屏幕信息（旧基础库没有 getWindowInfo，退回 getSystemInfoSync）
    winInfo() {
      try {
        const i = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
        const h = i.windowHeight;
        const w = i.windowWidth;
        if (!h || !w) return null;
        // 底部安全区（全面屏 home 条）：fixed bottom:0 到窗口底，这块算进面板下内边距
        const safeBottom = (i.safeArea && i.safeArea.bottom) ? Math.max(0, h - i.safeArea.bottom) : 0;
        return { winH: h, winW: w, safeBottom };
      } catch (e) {
        return null;
      }
    },

    // 正文区高度（px）。纯计算，方便离线断言。
    //   列表态 = min(内容自然高, 可用高)  —— 内容少就矮面板，内容多就在框内滚（滚轮）
    //   编辑态 = 可用高                    —— 输入框撑满正文区
    // 可用高 = 面板上限(86vh) - 面板里正文以外占掉的固定高度。
    // 固定高度按 rpx 折算（750rpx = 屏宽）：上内边距 24 + 手柄 8+20 + 副标题上间距 8
    //   + 正文上间距 8 + 底部按钮区 (上间距 20 + 按钮 84) + 下内边距 20 = 192rpx，
    // 再加上标题、副标题实测高度（字号、行数都会变，不能写死）。
    bodyHeightOf(box) {
      const W = box.winW / 750;
      const sheetMax = box.winH * 0.86;
      const fixedH = 192 * W + (box.headH || 0) + (box.subH || 0) + (box.safeBottom || 0);
      const avail = Math.max(120, sheetMax - fixedH);
      const h = box.editing ? avail : Math.min(box.innerH || 0, avail);
      return Math.max(0, Math.ceil(h));
    },

    measure() {
      if (!this.data.show) return;
      const win = this.winInfo();
      if (!win || !wx.createSelectorQuery) return;
      const editing = !!this.data.editing;
      const q = wx.createSelectorQuery().in(this);
      q.select('.er-head').boundingClientRect();
      q.select('.er-sub').boundingClientRect();
      // 列表态量内容自然高（.er-inner 不受正文区高度影响），编辑态不需要量
      if (editing) q.select('.er-edit').boundingClientRect();
      else q.select('.er-inner').boundingClientRect();
      q.exec((res) => {
        const head = res[0];
        const sub = res[1];
        const box = res[2];
        if (!head || !sub) return;
        const h = this.bodyHeightOf({
          innerH: editing ? 0 : ((box && box.height) || 0),
          headH: head.height,
          subH: sub.height,
          winH: win.winH,
          winW: win.winW,
          safeBottom: win.safeBottom,
          editing
        });
        if (h !== this.data.bodyH) this.setData({ bodyH: h });
      });
    },

    // 只显示与所选类型对应的输入项
    fieldsOf(active, values) {
      const v = values || this.draft || {};
      const fields = [];
      errata.TYPES.forEach((t) => {
        if (t.field && (active || []).indexOf(t.key) >= 0) {
          const box = boxOf(v[t.field], MAX_LINES[t.field]);
          fields.push({
            key: t.field,
            label: t.label.replace('有误', ''),
            ph: FIELD_PH[t.field] || '',
            value: v[t.field] || '',
            h: box.h,
            over: box.over
          });
        }
      });
      return fields;
    },

    // 唯一的数据出口：把 draft 落到 data，并重建只读态的展示值。
    // 两条路（重置 / 取消勾选）都走它，避免两处表示走岔。
    syncFromDraft(active) {
      const d = this.draft || {};
      const act = active || this.data.active || [];
      const noteBox = boxOf(d.note, MAX_LINES.note);
      this.setData({
        active: act,
        fields: this.fieldsOf(act, d),
        editing: '',
        editLabel: '',
        editPh: '',
        editValue: '',
        stem: d.stem || '',
        options: d.options || '',
        answer: d.answer || '',
        explanation: d.explanation || '',
        note: d.note || '',
        noteH: noteBox.h,
        noteOver: noteBox.over
      }, () => this.measure());
    },

    toggleType(e) {
      const key = e.currentTarget.dataset.key;
      const active = (this.data.active || []).slice();
      const i = active.indexOf(key);
      if (i >= 0) active.splice(i, 1);
      else active.push(key);
      this.syncFromDraft(active);
    },

    // 进编辑态：正文整体换成「只放这一个输入框」。
    // 为什么不在原地换：textarea 是原生组件，层级最高，而且**不会被 scroll-view 裁剪** ——
    // 只要它待在滚动区里，内容一长（或滚动位置让它越出可视区）就会画到面板底部，
    // 压住「保存」按钮。开发者工具里看不出来，真机必现。
    // 编辑态下正文里只有它一个、且高度就是正文区高度，就不存在"越出"这回事。
    startEdit(e) {
      const key = e.currentTarget.dataset.key;
      const d = this.draft || {};
      const f = (this.data.fields || []).filter((x) => x.key === key)[0];
      this.editBefore = d[key] || '';
      this.setData({
        editing: key,
        editLabel: key === 'note' ? '备注' : ((f && f.label) || ''),
        editPh: (f && f.ph) || FIELD_PH[key] || '',
        editValue: this.editBefore
      }, () => this.measure());
    },

    // 输入只进 draft：不回写 data，避免每敲一个字就 setData 打断光标。
    // field 兜底取 editing —— 真机上 event.currentTarget.dataset 偶有取不到的情况，
    // 取不到时改动会静默丢掉（用户看到输入框里有字、实际什么都没记），
    // 所以这里宁可退回"当前正在编辑的字段"。
    onInput(e) {
      const field = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.field)
        || this.data.editing;
      if (!field) return;
      this.draft = this.draft || {};
      this.draft[field] = e.detail.value;
    },

    endEdit() {
      this.syncFromDraft();
    },

    cancelEdit() {
      const key = this.data.editing;
      this.draft = this.draft || {};
      this.draft[key] = this.editBefore || '';
      this.syncFromDraft();
    },

    // 只把「确实改动了的」字段写回题库：draft 预填的就是原值，
    // 全量写回会把「只是打开看了一眼」也变成一次写入。
    patchOf(q, draft) {
      const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
      const p = {};
      if (!same(draft.stem, q.stem)) p.stem = draft.stem || '';
      if (!same(draft.options, errata.optionsToText(q.options))) p.options = draft.options || '';
      if (!same(draft.answer, q.answerKey || q.answer)) p.answerKey = draft.answer || '';
      if (!same(draft.explanation, q.explanation)) p.explanation = draft.explanation || '';
      return p;
    },

    save() {
      const q = this.data.question || {};
      const draft = this.draft || {};
      // 注意：各字段默认预填的是"原值"，所以不能用字段非空来判断有没有填写。
      // 真正的门槛是「至少选一个类型，或写了备注」。
      const note = (draft.note || '').trim();
      if (!this.data.active.length && !note) {
        wx.showToast({ title: '请选择问题类型或填写备注', icon: 'none' });
        return;
      }

      // ① 先把写下的修正落到题库明细：判分、回顾、错题本都读它。
      //    写失败也照样记清单（用户写的东西不能丢），但必须明确告诉他题库没更新。
      const patch = this.patchOf(q, draft);
      const applied = Object.keys(patch).length;
      // fresh 只带"确实写回盘上的那份"。没写回就传 null ——
      // 满值传旧快照会把练习页内存里的题目覆盖成更旧的版本。
      let fresh = null;
      let failMsg = '';
      if (applied) {
        try {
          const r = answers.applyFix(this.data.setId, q.no, patch);
          fresh = r.latest || r.question;
          // 落盘后读回不一致 = 题库没真正更新，必须说清楚，不能让用户以为改好了
          if (!r.persisted) failMsg = '改动没能落进题库明细（写入后读回来的内容对不上）';
        } catch (err) {
          failMsg = (err && err.message) || '未知错误';
        }
      }

      // ② 记进校对清单（源文件还是错的）。状态规则：
      //    写下了与原文不同的正确内容 = 这题在我这边处理完了 → 归入「已修」；
      //    只勾了类型、还没写内容 → 不动状态。
      //    这里只做「转已修」，不做「退回待修」：要退回用清单页那个开关。
      const changed = errata.hasChange({
        original: errata.originalOf(this.data.setId, q),
        fix: draft
      });
      errata.upsert(this.data.setId, q, {
        types: this.data.active,
        fix: {
          stem: draft.stem || '',
          options: draft.options || '',
          answer: draft.answer || '',
          explanation: draft.explanation || '',
          note: draft.note || ''
        },
        status: changed ? 'fixed' : undefined,
        title: this.data.title
      });
      if (failMsg) {
        // 题库里找不到这道题（题库被删/被重新导入过）：清单照记，但别让用户以为已经改好了
        wx.showModal({
          title: '已记入校对清单，但没能写回题库',
          content: `${failMsg}\n\n可以到「校对清单」导出这份对照，回电脑上改源文件。`,
          showCancel: false
        });
      } else if (applied) {
        wx.showToast({
          title: changed ? '已写回题库 · 已修' : '已写回题库',
          icon: 'success'
        });
      } else {
        // 只勾了类型 / 只写备注：题库里没有需要写回的内容。
        // 文案要说清楚"只记了清单"，否则用户会以为题目已经改好了（2026-09-24 报的就是这个）。
        wx.showToast({ title: '已记入校对清单，题库无改动', icon: 'none' });
      }
      this.triggerEvent('saved', { no: q.no, question: fresh, applied });
      this.triggerEvent('close');
    },

    del() {
      const q = this.data.question || {};
      const that = this;
      wx.showModal({
        title: '删除记录',
        content: `确定删除第 ${q.no} 题的校对记录吗？（题库里已改好的内容不会退回）`,
        confirmColor: '#F04242',
        success(res) {
          if (!res.confirm) return;
          errata.removeItem(that.data.setId, q.no);
          wx.showToast({ title: '已删除', icon: 'success' });
          that.triggerEvent('saved', { no: q.no });
          that.triggerEvent('close');
        }
      });
    },

    close() {
      this.triggerEvent('close');
    },

    noop() { /* 阻止面板内点击穿透到遮罩 */ }
  }
});
