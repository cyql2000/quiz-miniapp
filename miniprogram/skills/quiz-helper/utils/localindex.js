// ============================================================
// 本地数据索引读取（主包 utils/localdb.js 的 storage 部分复刻）
//
// 为什么不整文件拷贝 localdb.js：它引用了主包的文件系统封装模块，而那个模块
// 依赖沙箱文件系统相关 API —— 这类 API 不在小程序 AI 接口侧白名单
// （references/JSAPI_WHITELIST.md §1/§2），独立分包里出现会导致产物不合规。
// 本文件只保留其中**只读 storage 索引**的那部分，key、排序、容错逻辑与
// localdb.js 逐字一致：
//
//   readIdx   ← localdb.js:20-27
//   listSets  ← localdb.js:92-95
//   getSetMeta← localdb.js:97-99
//
// 题库明细（沙箱里的 q_sets/*.json）不在本分包的读取范围内 —— 需要题目正文的
// 能力由主包答题页承担，原子接口只负责把用户带到那里（见 mcp.json 的 handoff）。
// ============================================================

const KEY_FILES = 'qz_local_files_v1';
const KEY_SETS = 'qz_local_sets_v1';

// 与 localdb.js:20-27 逐字一致：读不到或类型不符一律回空数组
function readIdx(key) {
  try {
    const v = wx.getStorageSync(key);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

const listFiles = () => readIdx(KEY_FILES);

// 与 localdb.js:92-95 逐字一致：按 createTime 降序
function listSets() {
  const arr = readIdx(KEY_SETS);
  return arr.slice().sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
}

function getSetMeta(setId) {
  return listSets().filter((s) => s.setId === setId)[0] || null;
}

module.exports = {
  KEY_FILES,
  KEY_SETS,
  readIdx,
  listFiles,
  listSets,
  getSetMeta
};
