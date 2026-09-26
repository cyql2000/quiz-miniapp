// 答案补全面板：给「没答案」或「答案有误」的题补上正确答案与解析
// 与 errata-sheet 的区别：那个是「记清单 + 写回题库」，这个是「当场改到能用」
const answers = require('../../utils/answers');
const util = require('../../utils/util');

const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };

// 只读展示框最多显示几行，超出的在框内滚（滚轮）；高度按内容算（util.boxOf）
const MAX_LINES = { answer: 4, explanation: 6 };

Component({
  properties: {
    show: { type: Boolean, value: false, observer: 'onShowChange' },
    setId: { type: String, value: '' },
    title: { type: String, value: '' },
    // { no, stem, type, options, answerKey, answer, explanation }
    question: { type: Object, value: null }
  },

  data: {
    typeLabel: '',
    isChoice: false,     // 有选项、可点选正确答案
    isJudge: false,      // 判断题：A 正确 / B 错误
    choices: [],         // [{ key, text, on }] —— on 在 js 里算好，WXML 不能调函数
    picked: [],
    answerText: '',
    explanation: '',
    oldText: '',
    hasOld: false,
    // 只读框的尺寸与「要不要滚」：由 util.boxOf 按内容行数算
    answerH: 0,
    answerOver: false,
    explH: 0,
    explOver: false,
    // 正在编辑的字段 key；'' = 列表态。编辑态下正文只放这一个输入框，见 startEdit 的注释。
    editing: '',
    editLabel: '',
    editPh: '',
    editValue: '',
    // 保存后先展示「改成了什么」，用户确认过再关面板；null = 还在编辑态
    result: null
  },

  methods: {
    onShowChange(show) {
      if (show) this.reset();
    },

    reset() {
      const q = this.data.question || {};
      const type = q.type || 'single';
      const picked = String(q.answerKey || '').split('').filter(Boolean);
      const isJudge = type === 'judge';
      const base = (q.options && q.options.length)
        ? q.options
        : (isJudge ? [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] : []);
      const isChoice = !isJudge && base.length > 0;

      // 用户输入只进 this.draft，不回写 data，避免输入过程中光标跳动
      this.draft = { answer: q.answer || '', explanation: q.explanation || '' };
      this.editBefore = '';
      const aBox = util.boxOf(this.draft.answer, MAX_LINES.answer);
      const eBox = util.boxOf(this.draft.explanation, MAX_LINES.explanation);

      this.setData({
        typeLabel: TYPE_LABEL[type] || type,
        isChoice,
        isJudge,
        choices: base.map((o) => ({ key: o.key, text: o.text, on: picked.indexOf(o.key) >= 0 })),
        picked,
        answerText: q.answer || '',
        explanation: q.explanation || '',
        answerH: aBox.h,
        answerOver: aBox.over,
        explH: eBox.h,
        explOver: eBox.over,
        oldText: q.answerKey ? q.answerKey : (q.answer || '（这道题原本没有答案）'),
        hasOld: !!(q.answerKey || q.answer),
        editing: '',
        editLabel: '',
        editPh: '',
        editValue: '',
        result: null
      });
    },

    // 进编辑态：正文整体换成「只放这一个输入框」。
    // 为什么不在原地换：textarea 是原生组件，层级最高，而且**不会被 scroll-view 裁剪** ——
    // 只要它待在滚动区里，内容一长（或滚动位置让它越出可视区）就会画到面板底部压住按钮。
    // 编辑态下正文里只有它一个、高度就是正文区高度，就不存在"越出"这回事。
    startEdit(e) {
      const key = e.currentTarget.dataset.key;
      const d = this.draft || {};
      this.editBefore = d[key] || '';
      this.setData({
        editing: key,
        editLabel: key === 'answer' ? '参考答案' : '解析',
        editPh: key === 'answer' ? '填上参考答案；这类题没有选项，判分靠自评' : '写下解析（可选）',
        editValue: this.editBefore
      });
    },

    // 输入只进 draft：不回写 data，避免每敲一个字就 setData 打断光标
    onInput(e) {
      const field = e.currentTarget.dataset.field;
      this.draft = this.draft || {};
      this.draft[field] = e.detail.value;
    },

    // 把 draft 落到只读态展示上（高度要重算，内容变了）
    syncFromDraft() {
      const d = this.draft || {};
      const aBox = util.boxOf(d.answer, MAX_LINES.answer);
      const eBox = util.boxOf(d.explanation, MAX_LINES.explanation);
      this.setData({
        answerText: d.answer || '',
        explanation: d.explanation || '',
        answerH: aBox.h,
        answerOver: aBox.over,
        explH: eBox.h,
        explOver: eBox.over,
        editing: '',
        editLabel: '',
        editPh: '',
        editValue: ''
      });
    },

    endEdit() {
      this.syncFromDraft();
    },

    cancelEdit() {
      this.draft = this.draft || {};
      this.draft[this.data.editing] = this.editBefore || '';
      this.syncFromDraft();
    },

    toggleOption(e) {
      const key = e.currentTarget.dataset.key;
      const picked = (this.data.picked || []).slice();
      const i = picked.indexOf(key);
      // 判断题只有一个正确答案；选择题允许多选，最后按字母序归一
      if (this.data.isJudge) {
        picked.length = 0;
        if (i < 0) picked.push(key);
      } else if (i >= 0) {
        picked.splice(i, 1);
      } else {
        picked.push(key);
      }
      picked.sort();
      this.setData({
        picked,
        choices: this.data.choices.map((c) => ({ key: c.key, text: c.text, on: picked.indexOf(c.key) >= 0 }))
      });
    },

    save() {
      const q = this.data.question || {};
      const draft = this.draft || {};
      const patch = { explanation: draft.explanation || '' };

      if (this.data.isChoice || this.data.isJudge) {
        if (!this.data.picked.length) {
          wx.showToast({ title: '请先点选正确答案', icon: 'none' });
          return;
        }
        patch.answerKey = this.data.picked.join('');
        // 判断题同时写人类可读的文本答案，与解析引擎的约定一致
        if (this.data.isJudge) patch.answer = this.data.picked[0] === 'A' ? '正确' : '错误';
      } else {
        if (!(draft.answer || '').trim() && !patch.explanation.trim()) {
          wx.showToast({ title: '请填写参考答案或解析', icon: 'none' });
          return;
        }
        patch.answer = draft.answer || '';
      }

      try {
        const r = answers.saveAnswer(this.data.setId, q.no, patch);
        // 落盘后读回不一致 = 题库其实没更新，当场说清楚，别让用户等下刷题时才发现
        if (!r.persisted) {
          wx.showModal({
            title: '没能写进题库',
            content: '改动写进题库明细后读回来的内容对不上，可能是本机存储出了问题。这一笔仍会保留在校对清单里。',
            showCancel: false
          });
        }
        // 交给练习页的题目以「盘上那份」为准，而不是内存里刚拼的那份
        this.triggerEvent('saved', { no: q.no, question: r.latest || r.question });
        // 不立刻关：先把改完的效果摊开（题干/选项照最终值渲染，答案与解析给出前后对比），
        // 用户点「完成」再关。改完只看一个 toast 是没法确认到底改成什么样的。
        this.setData({ result: this.buildResult(r), editing: '', editValue: '' });
      } catch (err) {
        wx.showModal({ title: '保存失败', content: (err && err.message) || '未知错误', showCancel: false });
      }
    },

    // 修改结果：题干、选项照最终值渲染（这个面板不改这两项），答案与解析给前后对比
    buildResult(r) {
      const q = r.question || {};
      const b = r.before || {};
      const a = r.after || {};
      const plain = (x) => x.answerKey || x.answer || '';
      return {
        no: q.no,
        typeLabel: TYPE_LABEL[q.type] || q.type || '',
        stem: q.stem || '',
        options: (q.options || []).map((o) => ({
          key: o.key,
          text: o.text,
          right: !!(q.answerKey && q.answerKey.indexOf(o.key) >= 0)
        })),
        answerChanged: plain(b) !== plain(a),
        answerOld: plain(b) || '（原本没有答案）',
        answerNew: plain(a) || '（未填写）',
        explChanged: String(b.explanation || '') !== String(a.explanation || ''),
        explOld: b.explanation || '（原本没有解析）',
        explNew: a.explanation || '（未填写）'
      };
    },

    // 结果视图里点「完成」
    finish() {
      this.triggerEvent('close');
    },

    close() {
      this.triggerEvent('close');
    },

    noop() { /* 阻止面板内点击穿透到遮罩 */ }
  }
});
