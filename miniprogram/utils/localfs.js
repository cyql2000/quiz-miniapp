// ============================================================
// 本地文件系统封装（替代云存储）
// 存储位置：小程序沙箱 wx.env.USER_DATA_PATH（本地用户文件，上限约 200MB）
// 说明：chooseMessageFile 拿到的是临时文件，必须拷进沙箱才能持久化。
// ============================================================

const ROOT = (wx.env && wx.env.USER_DATA_PATH) || '';

const DIR = {
  source: 'q_source', // 用户导入的源文件（试题 / 答案解析）
  sets: 'q_sets',     // 题库明细 JSON（题目量大，放文件而非 storage）
  exports: 'q_export', // 导出的备份文件（可发送给他人或存到电脑）
  tmp: 'q_tmp'        // 中间产物
};

let fsm = null;
function manager() {
  if (!fsm) fsm = wx.getFileSystemManager();
  return fsm;
}

function abs(rel) {
  if (!rel) return ROOT;
  if (rel.indexOf(ROOT) === 0) return rel; // 已是绝对路径
  return ROOT + '/' + rel;
}

function dirOf(rel) {
  const i = String(rel).lastIndexOf('/');
  return i < 0 ? '' : String(rel).slice(0, i);
}

function exists(rel) {
  try {
    manager().accessSync(abs(rel));
    return true;
  } catch (e) {
    return false;
  }
}

function ensureDir(rel) {
  if (!rel) return;
  try {
    manager().mkdirSync(abs(rel), true);
  } catch (e) {
    // 已存在时 mkdirSync 会抛错，access 一下确认
    if (!exists(rel)) throw e;
  }
}

function writeText(rel, text) {
  ensureDir(dirOf(rel));
  manager().writeFileSync(abs(rel), text, 'utf8');
  return rel;
}

function appendText(rel, text) {
  if (!exists(rel)) return writeText(rel, text);
  const old = readText(rel);
  return writeText(rel, old + text);
}

function readText(rel) {
  return manager().readFileSync(abs(rel), 'utf8');
}

// 返回 ArrayBuffer
function readBuffer(rel) {
  return manager().readFileSync(abs(rel));
}

function writeBuffer(rel, buffer) {
  ensureDir(dirOf(rel));
  manager().writeFileSync(abs(rel), buffer);
  return rel;
}

// 把 chooseMessageFile 的临时文件拷进沙箱（持久化）
function copyIn(tempPath, rel) {
  ensureDir(dirOf(rel));
  manager().copyFileSync(tempPath, abs(rel));
  return rel;
}

function remove(rel) {
  try {
    manager().unlinkSync(abs(rel));
    return true;
  } catch (e) {
    return false;
  }
}

// 递归删除目录（用于删除整个题库）
function removeDir(rel) {
  try {
    manager().rmdirSync(abs(rel), true);
    return true;
  } catch (e) {
    return false;
  }
}

function stat(rel) {
  try {
    return manager().statSync(abs(rel));
  } catch (e) {
    return null;
  }
}

function sizeOf(rel) {
  const s = stat(rel);
  if (!s) return 0;
  // statSync 返回的 size 在部分基础库上不准确，回退到读字节长度
  if (typeof s.size === 'number' && s.size > 0) return s.size;
  try {
    return readBuffer(rel).byteLength;
  } catch (e) {
    return 0;
  }
}

function listDir(rel) {
  try {
    return manager().readdirSync(abs(rel)) || [];
  } catch (e) {
    return [];
  }
}

// 生成一个不会被覆盖的相对路径
function uniquePath(dir, fileName) {
  const safe = String(fileName || 'file').replace(/[\\/:*?"<>|\s]+/g, '_');
  return `${dir}/${Date.now()}_${Math.floor(Math.random() * 100000)}_${safe}`;
}

module.exports = {
  ROOT,
  DIR,
  abs,
  dirOf,
  exists,
  ensureDir,
  writeText,
  appendText,
  readText,
  readBuffer,
  writeBuffer,
  copyIn,
  remove,
  removeDir,
  stat,
  sizeOf,
  listDir,
  uniquePath
};
