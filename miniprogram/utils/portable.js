// ============================================================
// 数据导出 / 导入（备份与迁移）
//
// 为什么需要它：去云化之后数据只存在本机沙箱里，**不跨设备、不跨账号**。
// 删掉小程序、清理微信缓存、换手机，数据就没了。这个模块给数据开一个口子。
//
// 导出物是一个 JSON 文件，包含：
//   题库明细（题目 + 答案解析，自包含，导入后即可直接刷题）
//   + 刷题进度 + 错题本 + 校对记录 + 标记题目（这些才是真正不可再生的积累）
//
// 不含源文件内容：题库明细已内联题目，源文件只是「用于重新生成题库」的原料，
//   体积却可能很大（一本 160KB 的 txt 转 base64 会膨胀 1/3），故只记录文件名。
//
// 幂等性：导入时**已存在的 setId 一律跳过**，所以重复导入同一份备份不会产生重复题库，
//   也不会覆盖你在本机已有的进度。
//
// 版本策略：marks 是后加的**可选字段**，老备份没有它、老版本小程序读新备份会忽略它，
//   都不影响其余数据，所以 VERSION 保持 1 不递增 —— 递增会让老版本直接拒绝导入整份备份，
//   为一个可选字段付出这种代价不划算。
// ============================================================

const fsm = require('./localfs');
const db = require('./localdb');
const progress = require('./progress');
const wrongbook = require('./wrongbook');
const errata = require('./errata');
const marks = require('./marks');

const FORMAT = 'light-quiz-backup';
const VERSION = 1;

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function stamp(d) {
  const t = d || new Date();
  return `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}`;
}

// 文件名安全化（题库标题可能带 / 等字符）
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '未命名';
}

// ---------------- 导出 ----------------

function collectSet(setId) {
  const bundle = db.loadSetBundle(setId);
  if (!bundle) return null;
  const meta = bundle.set || {};
  const books = {
    progress: progress.getState(setId) || null,
    wrongbook: (function () {
      const b = wrongbook.getBook(setId);
      return b && b.items && Object.keys(b.items).length ? b : null;
    })(),
    errata: (function () {
      const b = errata.getBook(setId);
      return b && b.items && Object.keys(b.items).length ? b : null;
    })(),
    marks: (function () {
      const b = marks.getBook(setId);
      return b && b.nos && b.nos.length ? { setId, title: b.title || '', nos: b.nos.slice() } : null;
    })()
  };
  // 源文件只留名字，便于对方知道这份题库是从什么文件生成的
  const sourceFiles = [];
  if (meta.questionFile && meta.questionFile.name) sourceFiles.push({ name: meta.questionFile.name, role: 'question' });
  if (meta.answerFile && meta.answerFile.name) sourceFiles.push({ name: meta.answerFile.name, role: 'answer' });

  return {
    setId: meta.setId,
    title: meta.title,
    questionCount: (bundle.questions || []).length,
    matchedCount: meta.matchedCount || 0,
    explCount: meta.explCount || 0,
    answerPlanMode: meta.answerPlanMode || '',
    createTime: meta.createTime || 0,
    sourceFiles,
    questions: bundle.questions || [],
    progress: books.progress,
    wrongbook: books.wrongbook,
    errata: books.errata,
    marks: books.marks
  };
}

// setIds 省略 = 导出全部
function buildPayload(setIds) {
  const all = db.listSets();
  const target = setIds && setIds.length
    ? all.filter((s) => setIds.indexOf(s.setId) >= 0)
    : all;

  const sets = target.map((s) => collectSet(s.setId)).filter(Boolean);
  if (!sets.length) throw new Error('没有可导出的题库');

  let questionCount = 0, wrongCount = 0, errataCount = 0, markedCount = 0;
  sets.forEach((s) => {
    questionCount += s.questions.length;
    wrongCount += s.wrongbook ? Object.keys(s.wrongbook.items).length : 0;
    errataCount += s.errata ? Object.keys(s.errata.items).length : 0;
    markedCount += s.marks ? s.marks.nos.length : 0;
  });

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    exportedAtText: stamp(),
    app: '轻刷题',
    summary: { setCount: sets.length, questionCount, wrongCount, errataCount, markedCount },
    sets
  };
}

// 写进沙箱，返回文件信息（含可直接喂给 shareFileMessage 的绝对路径）
// label 显式指定文件名中的范围（「全部」/ 题库标题）；不传时才按数量推断。
// 注意不能无条件按数量推断——否则「导出全部」在只有 1 个题库时会被命名成该题库，
// 与「导出该题库」产生同名文件，用户无法区分。
function exportToSandbox(setIds, label) {
  const payload = buildPayload(setIds);
  const text = JSON.stringify(payload);
  const scope = safeName(label || (payload.sets.length === 1 ? payload.sets[0].title : '全部'));
  const base = `轻刷题备份-${scope}-${stamp()}.json`;
  const rel = uniqueRelPath(fsm.DIR.exports, base);
  fsm.writeText(rel, text);
  return {
    rel,
    absPath: fsm.abs(rel),
    name: rel.slice(rel.lastIndexOf('/') + 1),
    bytes: text.length,
    sizeText: sizeText(text.length),
    summary: payload.summary
  };
}

function uniqueRelPath(dir, base) {
  let name = base;
  let i = 2;
  while (fsm.exists(`${dir}/${name}`)) {
    name = base.replace(/\.json$/i, '') + `-${i}.json`;
    i++;
  }
  return `${dir}/${name}`;
}

function sizeText(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// 转发到聊天（主路径）。返回 Promise，便于调用方处理失败
function shareToChat(absPath, fileName) {
  return new Promise((resolve, reject) => {
    if (typeof wx.shareFileMessage !== 'function') {
      reject(new Error('当前微信版本不支持转发文件（需基础库 2.16.1 及以上）'));
      return;
    }
    wx.shareFileMessage({
      filePath: absPath,
      fileName,
      success: () => resolve(true),
      fail: (e) => reject(new Error((e && e.errMsg) || '转发失败'))
    });
  });
}

// 保存到电脑（仅 PC 微信支持）
function saveToDisk(absPath, fileName) {
  return new Promise((resolve, reject) => {
    if (typeof wx.saveFileToDisk !== 'function') {
      reject(new Error('仅电脑版微信支持直接保存到本机磁盘，请改用「转发到微信」'));
      return;
    }
    wx.saveFileToDisk({
      filePath: absPath,
      success: () => resolve(true),
      fail: (e) => reject(new Error((e && e.errMsg) || '保存失败'))
    });
  });
}

// ---------------- 导入 ----------------

function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('文件不是有效的 JSON，可能不是本小程序导出的备份');
  }
  if (!data || typeof data !== 'object') throw new Error('备份内容为空');
  if (data.format !== FORMAT) {
    throw new Error('文件格式不匹配：这不是「轻刷题」的备份文件');
  }
  if (typeof data.version !== 'number' || data.version > VERSION) {
    throw new Error(`备份版本（v${data.version}）高于当前小程序支持的版本（v${VERSION}），请先更新小程序`);
  }
  if (!Array.isArray(data.sets) || !data.sets.length) throw new Error('备份里没有题库数据');
  data.sets.forEach((s, i) => {
    if (!s || !s.setId || !Array.isArray(s.questions)) {
      throw new Error(`备份第 ${i + 1} 个题库的数据不完整`);
    }
  });
  return data;
}

// 只做规划、不落库，供 UI 先展示给用户确认
function planImport(payload) {
  const add = [];
  const skip = [];
  payload.sets.forEach((s) => {
    if (db.getSetMeta(s.setId)) skip.push({ setId: s.setId, title: s.title });
    else add.push({ setId: s.setId, title: s.title, questionCount: s.questions.length });
  });
  const addQuestions = add.reduce((a, x) => a + x.questionCount, 0);
  const addWrongs = payload.sets
    .filter((s) => add.some((a) => a.setId === s.setId))
    .reduce((a, s) => a + (s.wrongbook ? Object.keys(s.wrongbook.items).length : 0), 0);
  const addErrata = payload.sets
    .filter((s) => add.some((a) => a.setId === s.setId))
    .reduce((a, s) => a + (s.errata ? Object.keys(s.errata.items).length : 0), 0);
  const addMarked = payload.sets
    .filter((s) => add.some((a) => a.setId === s.setId))
    .reduce((a, s) => a + (s.marks && Array.isArray(s.marks.nos) ? s.marks.nos.length : 0), 0);
  return {
    add,
    skip,
    addQuestions,
    addWrongs,
    addErrata,
    addMarked,
    exportedAtText: payload.exportedAtText || ''
  };
}

function applyImport(payload, plan) {
  const p = plan || planImport(payload);
  const adding = {};
  p.add.forEach((x) => { adding[x.setId] = 1; });

  let imported = 0;
  payload.sets.forEach((s) => {
    if (!adding[s.setId]) return;
    // 保留原 setId，这样进度/错题本/校对记录的 key 不用重映射
    db.saveSetBundle({
      setId: s.setId,
      title: s.title,
      source: 'import',
      questionFile: s.sourceFiles && s.sourceFiles[0] ? { name: s.sourceFiles[0].name } : null,
      answerFile: (function () {
        const a = (s.sourceFiles || []).filter((f) => f.role === 'answer')[0];
        return a ? { name: a.name } : null;
      })(),
      matchedCount: s.matchedCount || 0,
      explCount: s.explCount || 0,
      answerPlanMode: s.answerPlanMode || '',
      createTime: s.createTime || Date.now()
    }, s.questions);

    if (s.progress) progress.saveState(s.progress);
    if (s.wrongbook) wrongbook.saveBook(s.wrongbook);
    if (s.errata) errata.saveBook(s.errata);
    if (s.marks && Array.isArray(s.marks.nos) && s.marks.nos.length) {
      marks.saveBook({ setId: s.setId, title: s.title || '', nos: s.marks.nos.slice() });
    }
    imported++;
  });

  return { imported, skipped: p.skip.length };
}

// 读沙箱里的备份文件 → 解析 → 出计划（不落库）
function readImportFile(rel) {
  const text = fsm.readText(rel);
  const payload = parsePayload(text);
  return { payload, plan: planImport(payload) };
}

// 供 UI 展示的确认文案
function planText(plan) {
  const lines = [];
  lines.push(`可导入：${plan.add.length} 个题库、${plan.addQuestions} 道题`);
  if (plan.addWrongs) lines.push(`含错题本记录 ${plan.addWrongs} 条`);
  if (plan.addErrata) lines.push(`含校对记录 ${plan.addErrata} 条`);
  if (plan.addMarked) lines.push(`含标记题目 ${plan.addMarked} 道`);
  if (plan.skip.length) lines.push(`已存在、将跳过：${plan.skip.length} 个题库`);
  if (plan.exportedAtText) lines.push(`备份导出时间：${plan.exportedAtText}`);
  return lines.join('\n');
}

module.exports = {
  FORMAT,
  VERSION,
  buildPayload,
  exportToSandbox,
  shareToChat,
  saveToDisk,
  parsePayload,
  planImport,
  applyImport,
  readImportFile,
  planText,
  sizeText
};
