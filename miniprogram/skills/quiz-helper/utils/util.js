// ============================================================
// 分包工具层：返回值工厂 + 格式化
//
// 返回值工厂为 CODE_TEMPLATES §1.1 的标准形态；格式化函数从主包
// utils/util.js 逐字拷贝（formatTime / formatDuration，按函数名找，别记行号 —— 那个会漂）。
// 主包 util.js 里 extOf / fileTypeLabel / sortLetters / nextAvailableName / boxOf
// 分别与文件类型判断、答案归一化、导入重命名、面板展示框尺寸相关，
// 本分包的原子接口都不使用，故不纳入（**不要顺手同步过来**）。
// ============================================================

function errorResult(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

function successResult(msg, structuredContent) {
  const result = { isError: false, content: [{ type: 'text', text: msg }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

const pad = (n) => (n < 10 ? '0' + n : '' + n);

function formatTime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round((ms || 0) / 1000));
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}分${sec % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

module.exports = { errorResult, successResult, formatTime, formatDuration };
