// ============================================================
// 本地数据层（替代云数据库 quiz_files / quiz_sets / quiz_questions）
//
// 存储分工（这是本方案的关键设计）：
//   轻量索引（文件清单、题库清单）→ wx.setStorageSync
//       单 key 上限 1MB、总量上限 10MB，索引只有几百字节，够用
//   重量明细（题目 + 答案解析）→ 沙箱文件系统 q_sets/{setId}.json
//       单本书约 1000 题、含解析可达 1MB 以上，storage 装不下，必须走文件
//
// 说明：三个原集合被扁平化成 2 个索引 + N 个明细文件；
//       quiz_questions 不再单独存在，直接内联在题库明细里。
// ============================================================

const fsm = require('./localfs');
const safe = require('./safestore');

const KEY_FILES = 'qz_local_files_v1';
const KEY_SETS = 'qz_local_sets_v1';

function readIdx(key) {
  try {
    const v = wx.getStorageSync(key);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// ---------------- 本地占用统计的缓存 ----------------
// stats() 要挨个 stat 每个源文件和题库明细，个别基础库上 stat 拿不到体积还会退化成整份读文件；
// 几十份题库跑一遍就是上百次同步 IO —— 首页每次回前台都重算，正是在 onShow 上量到的那 100+ms。
// 缓存一份，两条保障让它不至于给出陈旧数字：
//   ① 任何写索引的动作（导入 / 替换 / 删除 / 清库）立刻失效 —— 见 writeIdx
//   ② 30 秒 TTL 兜底，万一哪条写路径漏了失效，最多陈旧半分钟
const STATS_TTL = 30 * 1000;
let statsCache = null;
let statsAt = 0;

function invalidateStats() {
  statsCache = null;
  statsAt = 0;
}

// 索引是「权威记录」，写不进去就不能让调用方以为成功了 —— 抛可读错误交给页面提示
function writeIdx(key, arr) {
  safe.writeOrThrow(
    key,
    arr,
    '本机存储空间不足，清单未能更新。请到「文件库」删除不再需要的源文件或题库后重试。'
  );
  // 文件清单 / 题库清单变了，占用统计就得重算
  invalidateStats();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

// ---------------- 源文件 ----------------

function listFiles() {
  return readIdx(KEY_FILES);
}

function getFile(id) {
  return listFiles().filter((f) => f.id === id)[0] || null;
}

// 按文件名精确匹配（重名判断的唯一依据，见 store.replaceFile）
function findFileByName(name) {
  const key = String(name || '');
  if (!key) return null;
  return listFiles().filter((f) => f.name === key)[0] || null;
}

function addFile(meta) {
  const doc = {
    id: meta.id || newId('f'),
    name: meta.name || '',
    ext: meta.ext || '',
    size: meta.size || 0,
    role: meta.role || '',
    path: meta.path || '',        // 沙箱内相对路径
    textPath: meta.textPath || '', // 预处理出的 txt（可选）
    createTime: Date.now(),
    updateTime: Date.now()
  };
  const arr = listFiles();
  arr.unshift(doc);
  writeIdx(KEY_FILES, arr);
  return doc;
}

function updateFile(id, patch) {
  const arr = listFiles();
  const i = arr.findIndex((f) => f.id === id);
  if (i < 0) return null;
  arr[i] = Object.assign({}, arr[i], patch, { updateTime: Date.now() });
  writeIdx(KEY_FILES, arr);
  return arr[i];
}

// 删除文件记录 + 沙箱实体（不影响已生成的题库）
function removeFile(id) {
  const f = getFile(id);
  if (f) {
    if (f.path) fsm.remove(f.path);
    if (f.textPath) fsm.remove(f.textPath);
  }
  writeIdx(KEY_FILES, listFiles().filter((x) => x.id !== id));
  return true;
}

// ---------------- 题库 ----------------

function listSets() {
  const arr = readIdx(KEY_SETS);
  return arr.slice().sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
}

function getSetMeta(setId) {
  return listSets().filter((s) => s.setId === setId)[0] || null;
}

function detailPath(setId) {
  return `${fsm.DIR.sets}/${setId}.json`;
}

// 写入题库：索引（轻） + 明细文件（重）
function saveSetBundle(meta, questions) {
  const setId = meta.setId || newId('s');
  const doc = Object.assign({}, meta, {
    setId,
    path: detailPath(setId),
    questionCount: (questions || []).length,
    createTime: meta.createTime || Date.now(),
    updateTime: Date.now()
  });
  fsm.writeText(doc.path, JSON.stringify({ set: doc, questions: questions || [] }));

  const arr = listSets().filter((s) => s.setId !== setId);
  arr.unshift(doc);
  writeIdx(KEY_SETS, arr);
  return doc;
}

function loadSetBundle(setId) {
  const meta = getSetMeta(setId);
  const p = (meta && meta.path) || detailPath(setId);
  if (!fsm.exists(p)) return null;
  try {
    const raw = JSON.parse(fsm.readText(p));
    return { set: raw.set || meta, questions: raw.questions || [] };
  } catch (e) {
    console.error('[localdb] 题库明细解析失败', setId, e);
    return null;
  }
}

// 只取题目，不做全量解析缓存（题库页/答题页都走这个）
function loadQuestions(setId) {
  const b = loadSetBundle(setId);
  return b ? b.questions : [];
}

function removeSet(setId) {
  const meta = getSetMeta(setId);
  if (meta && meta.path) fsm.remove(meta.path);
  writeIdx(KEY_SETS, listSets().filter((s) => s.setId !== setId));
  return true;
}

// ---------------- 维护 ----------------

// 统计本地占用，并清理孤儿明细文件（索引里已无记录）
// 走 STATS_TTL 缓存，写索引时失效（见文件头注释）。返回值请当作只读。
function stats() {
  const now = Date.now();
  if (statsCache && now - statsAt < STATS_TTL) return statsCache;

  const files = listFiles();
  const sets = listSets();
  const onDisk = fsm.listDir(fsm.DIR.sets) || [];
  const known = {};
  sets.forEach((s) => {
    const base = String(s.path || '').split('/').pop();
    if (base) known[base] = 1;
  });
  const orphans = onDisk.filter((n) => /\.json$/.test(n) && !known[n]);

  let bytes = 0;
  files.forEach((f) => { bytes += fsm.sizeOf(f.path); });
  sets.forEach((s) => { bytes += fsm.sizeOf(s.path); });

  const r = { fileCount: files.length, setCount: sets.length, bytes, orphans };
  statsCache = r;
  statsAt = now;
  return r;
}

function cleanOrphans() {
  const r = stats();
  r.orphans.forEach((n) => fsm.remove(`${fsm.DIR.sets}/${n}`));
  // 刚删掉一批明细文件，缓存里的体积和孤儿列表都已过时
  invalidateStats();
  return r.orphans.length;
}

// 清空全部本地数据（仅供设置页/排障使用）
function clearAll() {
  readIdx(KEY_SETS).forEach((s) => { if (s.path) fsm.remove(s.path); });
  readIdx(KEY_FILES).forEach((f) => {
    if (f.path) fsm.remove(f.path);
    if (f.textPath) fsm.remove(f.textPath);
  });
  writeIdx(KEY_FILES, []);
  writeIdx(KEY_SETS, []);
}

module.exports = {
  KEY_FILES,
  KEY_SETS,
  listFiles,
  getFile,
  findFileByName,
  addFile,
  updateFile,
  removeFile,
  listSets,
  getSetMeta,
  saveSetBundle,
  loadSetBundle,
  loadQuestions,
  removeSet,
  stats,
  invalidateStats,   // 外部改了文件内容（比如重写明细）后手动让占用统计失效
  cleanOrphans,
  clearAll
};
