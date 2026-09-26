// 生成向导：本地解析版
// 改动：wx.cloud.callFunction('generateSet') → store.buildSet（端上跑 parser-core）
const config = require('../../config');
const store = require('../../utils/store');
const { formatTime, fileTypeLabel, extOf, guessFileRole } = require('../../utils/util');

// 文件类型白名单：试题槽只列「试题文件」，答案解析槽只列「答案解析」。
// 判定顺序：导入时的手动分类 > 文件名特征词 > 未分类按试题处理（多数人导入的就是题本）。
// 端上解析不了的类型（pdf / docx）一律排除，避免选进去才发现生成不了。
function kindOf(f) {
  if (!f) return 'other';
  if (config.localParsableExts.indexOf(extOf(f.name)) < 0) return 'other';
  if (f.role === 'answer') return 'answer';
  if (f.role === 'question') return 'question';
  return guessFileRole(f.name) === 'answer' ? 'answer' : 'question';
}

const KIND_LABEL = { question: '试题文件', answer: '答案解析', other: '端上无法解析的文件' };

Page({
  data: {
    files: [],
    qFile: null,
    aFile: null,
    title: '',
    split: true,
    generating: false,
    picker: { show: false, slot: 'q', hidden: 0 },
    candidates: []
  },

  onShow() {
    this.loadFiles();
  },

  loadFiles() {
    try {
      const files = store.listFiles().map((f) => ({
        _id: f._id,
        name: f.name,
        sizeText: f.sizeText,
        timeText: f.timeText,
        role: f.role,
        roleLabel: fileTypeLabel(f.role || ''),
        // 白名单判定结果（试题文件 / 答案解析 / 端上无法解析的文件），用于过滤与展示
        kind: kindOf(f),
        kindLabel: KIND_LABEL[kindOf(f)],
        parsable: f.parsable,
        needDesktop: f.needDesktop
      }));
      this.setData({ files });
    } catch (e) {
      console.error('[generate] 读取文件库失败', e);
      wx.showToast({ title: '读取文件库失败', icon: 'none' });
    }
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  onSplitChange(e) {
    this.setData({ split: e.detail.value });
  },

  openPicker(e) {
    const slot = e.currentTarget.dataset.slot;
    const wanted = slot === 'q' ? 'question' : 'answer';
    const chosenId = slot === 'q' ? (this.data.qFile || {})._id : (this.data.aFile || {})._id;
    const all = this.data.files.filter((f) => f._id !== chosenId);
    // 只列该槽位要的那一种：试题槽绝不出现答案解析文件（反之亦然）
    const candidates = all.filter((f) => kindOf(f) === wanted);
    const hidden = all.length - candidates.length;

    if (!candidates.length) {
      const nAns = all.filter((f) => kindOf(f) === 'answer').length;
      const nOther = all.filter((f) => kindOf(f) === 'other').length;
      const isQ = slot === 'q';
      wx.showModal({
        title: isQ ? '没有可用的试题文件' : '没有可用的答案解析文件',
        content:
          (isQ
            ? '文件库里还没有被识别为「试题文件」的文件。\n\n'
            : '文件库里还没有被识别为「答案解析」的文件。\n\n') +
          (hidden
            ? `本次已过滤 ${hidden} 个文件：答案解析 ${nAns} 个、端上无法解析的类型 ${nOther} 个。\n\n`
            : '') +
          `生成题库只接受${isQ ? '试题文件' : '答案解析文件'}（${config.localParsableExts.join(' / ')}）。\n` +
          '可到「文件库」导入文件，并把它分类为「试题文件」或「答案解析」。',
        confirmText: '去文件库',
        cancelText: '知道了',
        success(r) {
          if (r.confirm) wx.switchTab({ url: '/pages/files/files' });
        }
      });
      return;
    }
    this.setData({ picker: { show: true, slot, hidden }, candidates });
  },

  closePicker() {
    this.setData({ 'picker.show': false });
  },

  goUpload() {
    wx.switchTab({ url: '/pages/files/files' });
  },

  pickFile(e) {
    const id = e.currentTarget.dataset.id;
    const f = this.data.files.find((x) => x._id === id);
    if (!f) return;
    const slot = this.data.picker.slot;
    // 端上不能解析的类型提前拦截，避免选了才发现失败
    if (!f.parsable) {
      wx.showModal({
        title: '这个文件端上无法解析',
        content:
          `小程序端只能解析纯文本（${config.localParsableExts.join(' / ')}）。\n\n` +
          '请先在电脑上用 tools/to-txt.js 把它转成 txt，再导入文件库。',
        showCancel: false
      });
      return;
    }
    // 文件类型白名单：试题槽不能放答案解析，反之亦然（列表已过滤，这里是兜底）
    const wanted = slot === 'q' ? 'question' : 'answer';
    if (kindOf(f) !== wanted) {
      wx.showModal({
        title: slot === 'q' ? '这不是试题文件' : '这不是答案解析文件',
        content:
          `「${f.name}」被识别为「${KIND_LABEL[kindOf(f)]}」，不能放在「${KIND_LABEL[wanted]}」这一栏。\n\n` +
          '可到「文件库」改它的分类（试题文件 / 答案解析）。',
        showCancel: false
      });
      return;
    }
    this.setData(slot === 'q' ? { qFile: f } : { aFile: f });
    this.setData({ 'picker.show': false });
  },

  clearSlot(e) {
    const slot = e.currentTarget.dataset.slot;
    this.setData(slot === 'q' ? { qFile: null } : { aFile: null });
  },

  doGenerate() {
    const { qFile, aFile, title, split } = this.data;
    if (!qFile) {
      wx.showToast({ title: '请先选择试题文件', icon: 'none' });
      return;
    }
    // 生成前的最后一道类型校验：试题栏必须是试题文件，答案栏必须是答案解析
    if (kindOf(qFile) !== 'question' || (aFile && kindOf(aFile) !== 'answer')) {
      const bad = kindOf(qFile) !== 'question' ? qFile : aFile;
      wx.showModal({
        title: '文件类型不匹配',
        content:
          `「${bad.name}」被识别为「${KIND_LABEL[kindOf(bad)]}」，不能用来${kindOf(qFile) !== 'question' ? '生成题库' : '匹配答案'}。\n\n` +
          '请重新选择，或到「文件库」修改该文件的分类。',
        showCancel: false
      });
      return;
    }
    if (this.data.generating) return;
    this.setData({ generating: true });
    wx.showLoading({ title: '解析中，请稍候…', mask: true });

    // 解析是同步的纯 JS 计算，用 setTimeout 让 loading 有机会渲染出来
    setTimeout(() => {
      try {
        const r = store.buildSet({
          questionFileId: qFile._id,
          answerFileId: (aFile && aFile._id) || null,
          title: title || '',
          splitMode: split !== false
        });
        wx.hideLoading();
        this.setData({ generating: false });

        const n = (r.parts && r.parts.length) || 1;
        // 答案来源如实反馈：文末识别 / 单独文件匹配 / 完全没有
        const ansTag = r.answerSource === 'inline'
          ? `，文末识别到答案 ${r.matchedCount} 题`
          : (r.hasAnswer ? `，匹配答案 ${r.matchedCount} 题` : '，未带答案解析');

        if (!r.hasAnswer) {
          wx.showModal({
            title: '这次没有识别到标准答案',
            content:
              '试题文件文末没有找到「参考答案 / 答案解析」区，也没有选择答案解析文件。\n\n' +
              '题库仍可正常生成与练习；碰到没答案的题，答题页会提供「补答案」入口，' +
              '可以现场判断并补上正确答案与解析。',
            showCancel: false
          });
        }

        if (n > 1) {
          wx.showToast({ title: `共 ${r.totalQuestions} 题，已拆成 ${n} 个题库`, icon: 'none', duration: 2400 });
          setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1200);
        } else {
          wx.showToast({ title: `识别 ${r.questionCount} 题${ansTag}`, icon: 'none', duration: 2400 });
          setTimeout(() => wx.redirectTo({ url: `/pages/preview/preview?setId=${r.setId}` }), 1200);
        }
      } catch (e) {
        wx.hideLoading();
        this.setData({ generating: false });
        console.error('[generate] 解析失败', e);

        const msg = (e && e.message) || '生成失败';
        if (e && e.code === 'NEED_DESKTOP') {
          wx.showModal({ title: '该文件需要电脑预处理', content: msg, showCancel: false });
          return;
        }
        if (/无法与题目对齐|顺序对齐/.test(msg)) {
          wx.showModal({
            title: '答案/解析对不上题目',
            content:
              msg +
              '\n\n常见原因：答案文件与试题文件不是同一本书，或解析条目缺失过多。\n' +
              '可先只选试题文件生成题库（答案留空），再去「校对清单」逐题补。',
            showCancel: false
          });
          return;
        }
        wx.showModal({ title: '生成失败', content: msg, showCancel: false });
      }
    }, 50);
  }
});
