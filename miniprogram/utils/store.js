// ============================================================
// 统一数据门面（页面唯一的数据入口）
//
// 改造要点：页面不再直接调用 wx.cloud.*，全部收敛到这里。
// 存储：本地（storage 索引 + 沙箱文件明细）
// 解析：端上跑 parser-core（与云函数同一份代码）
// ============================================================

const config = require('../config');
const db = require('./localdb');
const fsm = require('./localfs');
const extract = require('./extract-local');
const parser = require('./parser-core');
const { formatSize, formatTime, extOf, fileTypeLabel } = require('./util');

// ---------------- 源文件 ----------------

// 页面用的视图对象
function listFiles() {
  return db.listFiles().map((f) => ({
    _id: f.id,
    id: f.id,
    name: f.name,
    ext: f.ext,
    size: f.size,
    sizeText: formatSize(f.size),
    timeText: formatTime(f.createTime),
    role: f.role || '',
    roleLabel: fileTypeLabel(f.role || ''),
    parsable: extract.isLocalSupported(f.name),
    needDesktop: !!extract.NEED_DESKTOP[f.ext],
    path: f.path
  }));
}

function getFile(id) {
  return db.getFile(id);
}

// 重名判断的唯一依据：文件名（沙箱里的物理路径本来就带时间戳，不会撞）
function findFileByName(name) {
  return db.findFileByName(name);
}

// 由某个文件生成的题库：既可能是它当试题文件，也可能是它当答案解析
function setsByFileId(fileId) {
  if (!fileId) return [];
  return db.listSets().filter((s) =>
    (s.questionFile && s.questionFile.id === fileId) ||
    (s.answerFile && s.answerFile.id === fileId));
}

// 把 chooseMessageFile 的临时文件拷进沙箱并建档
function importFile(tempFilePath, info, role) {
  const name = (info && info.name) || 'file';
  const ext = extOf(name);
  if (!ext || config.acceptExts.indexOf(ext) < 0) {
    throw new Error(`不支持的文件类型 .${ext || '未知'}，支持：${config.acceptExts.join(' / ')}`);
  }
  const rel = fsm.uniquePath(fsm.DIR.source, name);
  fsm.copyIn(tempFilePath, rel);
  return db.addFile({
    name,
    ext,
    size: (info && info.size) || fsm.sizeOf(rel),
    role: role || '',
    path: rel
  });
}

// 覆盖导入：沿用原文件的 id 与分类，替换沙箱实体，
// 并删除由它生成的题库（连同进度 / 错题本 / 校对记录 / 标记）。
//
// 为什么连题库一起删：文件被同名替换，说明用户认定这份才是最新的。
// 留着旧题库的话，「生成题库」会再多出一套同名题库，用户分不清该练哪个；
// 而且旧题仍然可答、答案却已过时，比没有更糟。
// 代价是进度会丢，所以调用方必须先把后果讲清楚并二次确认。
function replaceFile(fileId, tempFilePath, info, role) {
  const old = db.getFile(fileId);
  if (!old) throw new Error('原文件已不在文件库中，无法替换');
  const name = (info && info.name) || old.name;
  const ext = extOf(name);
  if (!ext || config.acceptExts.indexOf(ext) < 0) {
    throw new Error(`不支持的文件类型 .${ext || '未知'}，支持：${config.acceptExts.join(' / ')}`);
  }
  // 先拷新的，成功之后再删旧的 —— 中途失败不至于把原文件也弄丢
  const rel = fsm.uniquePath(fsm.DIR.source, name);
  fsm.copyIn(tempFilePath, rel);
  if (old.path) fsm.remove(old.path);
  if (old.textPath) fsm.remove(old.textPath);

  const doc = db.updateFile(fileId, {
    name,
    ext,
    size: (info && info.size) || fsm.sizeOf(rel),
    role: role || old.role || '',
    path: rel,
    textPath: ''          // 预处理产物失效，下次用的时候重新生成
  });

  const removedSets = [];
  setsByFileId(fileId).forEach((s) => {
    deleteSet(s.setId);
    removedSets.push({ setId: s.setId, title: s.title, questionCount: s.questionCount || 0 });
  });
  return { file: doc, removedSets };
}

function setFileRole(id, role) {
  return db.updateFile(id, { role });
}

function deleteFile(id) {
  return db.removeFile(id);
}

// ---------------- 题库 ----------------

function listSets() {
  return db.listSets();
}

function getSetMeta(setId) {
  return db.getSetMeta(setId);
}

function loadSetBundle(setId) {
  return db.loadSetBundle(setId);
}

// 删除题库：明细 + 索引 + 关联的进度/错题本/校对记录/标记
function deleteSet(setId) {
  db.removeSet(setId);
  try { require('./progress').removeState(setId); } catch (e) { /* ignore */ }
  try { require('./wrongbook').removeBook(setId); } catch (e) { /* ignore */ }
  try { require('./errata').removeBook(setId); } catch (e) { /* ignore */ }
  try { require('./marks').removeBook(setId); } catch (e) { /* ignore */ }
  return true;
}

// 读取某个文件的文本（优先用预处理出的 txt）
function readFileText(fileDoc) {
  if (!fileDoc) throw new Error('文件不存在');
  const target = fileDoc.textPath || fileDoc.path;
  if (!target) throw new Error('文件内容缺失，请重新导入');
  return extract.extractText(fileDoc.name, target);
}

// ---------------- 端上生成题库（原 generateSet 云函数逻辑） ----------------

function buildSet(opts) {
  const qDoc = db.getFile(opts.questionFileId);
  if (!qDoc) throw new Error('试题文件不存在，请重新选择');
  const aDoc = opts.answerFileId ? db.getFile(opts.answerFileId) : null;

  let qText = readFileText(qDoc);
  let aText = '';
  // 答案从哪来：file=单独的答案解析文件 / inline=试题文件文末自带的答案区 / none=没有
  let answerSource = 'none';

  if (aDoc) {
    aText = readFileText(aDoc);
    answerSource = 'file';
  }

  // 试题文件文末可能自带「参考答案」区（行测书常见形态）：这段**不是题目**，先切掉。
  // 原来只在「没选答案文件」时切，于是另配了解析文件时，整段答案速览会被当成题目 ——
  // 一本 20 题的卷子凭空多出 20 道假题，还把真题的答案挤到假题身上。
  // 判定保守：只有该标题后确实跟着成串编号条目才算分界，切不到就保持整文为题目区。
  const sp = parser.splitPaper(qText);
  if (sp.hasAnswer) {
    qText = sp.questionText;
    if (!aDoc) {
      aText = sp.answerText;
      answerSource = 'inline';
    }
  }

  const baseTitle = (opts.title || '').trim() || qDoc.name.replace(/\.[^.]+$/, '');

  // 分卷（按章节/标题），识别不到标题时退回单卷
  const parts = opts.splitMode === false ? [{ title: null, text: qText }] : parser.splitParts(qText);
  const segs = parts
    .map((p) => ({ title: p.title, questions: parser.splitQuestions(p.text) }))
    .filter((s) => s.questions.length);
  if (!segs.length) {
    throw new Error('未能从试题文件中识别到题目。请确认题目以「1. / 1、/ 第1题」编号开头');
  }

  // 答案解析：顺序对齐（不论答案来自单独文件还是文末自带，走的都是同一条链路）
  let ansPerPart = null;
  let planInfo = null;
  if (aText) {
    const plan = parser.resolveAnswerPlan(
      segs.map((s) => ({ title: s.title, count: s.questions.length, questions: s.questions })),
      aText
    );
    ansPerPart = plan.perPart;
    planInfo = {
      mode: plan.mode,
      matched: plan.matched,
      unmatchedQuestions: plan.unmatchedQuestions,
      orphanAnswers: plan.orphanAnswers
    };
  }

  const stamp = Date.now();
  const parts0 = [];
  let totalQ = 0, totalMatched = 0, totalExpl = 0;

  segs.forEach((seg, i) => {
    const built = parser.buildQuestionsByPosition(seg.questions, ansPerPart ? ansPerPart[i] : null);
    const matchedCount = built.filter((q) => q.matched).length;
    const explCount = built.filter((q) => q.explanation).length;
    const title = segs.length > 1
      ? `${baseTitle} · ${(seg.title || '第' + (i + 1) + '部分').trim()}`
      : baseTitle;
    const setId = `local_${stamp}_${i}`;

    db.saveSetBundle({
      setId,
      title,
      source: 'local',
      questionFile: { id: qDoc.id, name: qDoc.name },
      answerFile: aDoc ? { id: aDoc.id, name: aDoc.name } : null,
      // 答案的实际来源：单独文件 / 试题文件文末自带 / 没有。
      // 首页「未配答案解析」标签据此判断 —— 只看 answerFile 会把文末自带答案的题库误标。
      answerSource,
      matchedCount,
      unmatchedCount: built.length - matchedCount,
      explCount,
      answerPlanMode: planInfo ? planInfo.mode : '',
      bytes: 0
    }, built);

    parts0.push({ setId, title, questionCount: built.length, matchedCount, explCount });
    totalQ += built.length;
    totalMatched += matchedCount;
    totalExpl += explCount;
    console.log(`[store] 生成题库 part=${i + 1}/${segs.length} set=${setId} q=${built.length} matched=${matchedCount}`);
  });

  return {
    ok: true,
    setId: parts0[0].setId,
    title: parts0[0].title,
    parts: parts0,
    totalQuestions: totalQ,
    questionCount: totalQ,
    matchedCount: totalMatched,
    explCount: totalExpl,
    unmatched: totalQ - totalMatched,
    answerPlanMode: planInfo ? planInfo.mode : '',
    orphanAnswers: planInfo ? planInfo.orphanAnswers : 0,
    answerSource,
    hasAnswer: answerSource !== 'none'
  };
}

// ---------------- 维护 ----------------

function storageStats() {
  const s = db.stats();
  return { fileCount: s.fileCount, setCount: s.setCount, sizeText: formatSize(s.bytes), orphans: s.orphans };
}

module.exports = {
  listFiles,
  getFile,
  findFileByName,
  setsByFileId,
  importFile,
  replaceFile,
  setFileRole,
  deleteFile,
  listSets,
  getSetMeta,
  loadSetBundle,
  deleteSet,
  readFileText,
  buildSet,
  storageStats,
  cleanOrphans: db.cleanOrphans,
  clearAll: db.clearAll,
  DIR: fsm.DIR
};
