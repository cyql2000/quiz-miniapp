// ============================================================
// 统一的安全写入（storage 兜底）
//
// 背景：wx.setStorageSync 在总量超过 10MB 时直接抛错。改造前这里有两类问题：
//   1) localdb.writeIdx / progress.saveState 裸调，异常直接冒到页面；
//   2) wrongbook.saveBook / errata.saveBook 用 `catch (e) { /* ignore */ }` 吞掉，
//      错题本与校对记录写不进去时**没有任何提示** —— 用户以为在积累，其实一直在丢。
//
// 两种诉求分开处理：
//   writeOrThrow —— 强一致场景（索引类）。写不进去就不能继续，抛出可读错误交给页面 toast。
//   write        —— 高频写（进度/错题/标记）。不能打断作答，失败先记录下来，
//                   由页面在每次操作后 take() 一次并统一提示，既不静默也不刷屏。
// ============================================================

const DEFAULT_MSG = '本机存储空间已满，本次记录未能保存。请到「文件库」删除不再需要的题库后重试。';

// 最近一次写入失败的现场（未被页面取走前一直保留）
let pending = null;

function write(key, value, opts) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    // 保留「首次」失败：一次操作里常常连写多个 key（如进度 + 最近记录），
    // 后面的失败只是前一个的连带后果，覆盖掉会让提示对应到次要的那条数据上。
    if (!pending) {
      const o = opts || {};
      pending = {
        key,
        label: o.label || '',
        message: o.message || DEFAULT_MSG,
        raw: (e && (e.errMsg || e.message)) || String(e)
      };
    }
    return false;
  }
}

// 写不进去就必须让调用方停下来的场景：抛出带 message 的错误
function writeOrThrow(key, value, message) {
  if (write(key, value, { message })) return true;
  const err = new Error(message || DEFAULT_MSG);
  err.storageFull = true;
  err.key = key;
  throw err;
}

function remove(key) {
  try {
    wx.removeStorageSync(key);
    return true;
  } catch (e) {
    return false;
  }
}

// 取出并清空待提示的失败现场（页面每次操作后调用一次，避免同一个错误反复弹）
function take() {
  const p = pending;
  pending = null;
  return p;
}

function peek() {
  return pending;
}

function clear() {
  pending = null;
}

module.exports = { DEFAULT_MSG, write, writeOrThrow, remove, take, peek, clear };
