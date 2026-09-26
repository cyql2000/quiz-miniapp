// 通用工具：格式化
// 注：原 fetchAll（云数据库分页读取）已随本地化改造移除，
//     数据读取统一走 utils/store.js。
const pad = (n) => (n < 10 ? '0' + n : '' + n);

function formatTime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function fileTypeLabel(role) {
  if (role === 'question') return '试题文件';
  if (role === 'answer') return '答案解析';
  return '未分类';
}

// 按文件名猜「试题 / 答案解析」，用于导入时没手动分类的文件。
// 只认文件名里的强特征词，猜不出来返回 ''（调用方按试题处理，多数人导入的就是题本）。
const ANSWER_NAME = /(解析|答案解析|答案|详解|参考答案)/;
const QUESTION_NAME = /(题本|试题|题库|练习题|真题|题集)/;

function guessFileRole(name) {
  const base = String(name || '').replace(/\.[^.]+$/, ''); // 去掉扩展名，避免 ".docx" 之类干扰
  if (ANSWER_NAME.test(base)) return 'answer';
  if (QUESTION_NAME.test(base)) return 'question';
  return '';
}

// 通过逗号/顿号/空格切分（多选答案归一化排序）
function sortLetters(letters) {
  return (letters || '').toUpperCase().replace(/[\s,，、]/g, '').split('').sort().join('');
}

// 用时展示。注意这里的入参是「累计活跃时长」，不是 now - 开始时间 ——
// 刷题常常跨天，按墙钟算会把离场时间也算进去（见 utils/progress.js 的计时说明）。
function formatDuration(ms) {
  const sec = Math.max(0, Math.round((ms || 0) / 1000));
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}分${sec % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

// 生成一个不与现有名字冲突的新名字：a.txt → a(2).txt → a(3).txt …
// 用于导入时「重命名」分支给的默认值（用户还能在弹窗里改）。
// 只动主名、保留扩展名 —— 扩展名决定端上能不能解析，不能被重命名改坏。
function nextAvailableName(name, taken) {
  const used = {};
  (taken || []).forEach((n) => { used[n] = 1; });
  const src = String(name || 'file');
  if (!used[src]) return src;
  const dot = src.lastIndexOf('.');
  const stem = dot > 0 ? src.slice(0, dot) : src;
  const ext = dot > 0 ? src.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}(${i})${ext}`;
    if (!used[cand]) return cand;
  }
  return `${stem}(${Date.now()})${ext}`;
}

// 只读展示框的尺寸：给「长了就在框内滚动（滚轮）」的只读字段用（校对 / 补答案面板）。
// 为什么不写死高度：答案常常就一行，固定给 6 行高会留一大片空白；
// 而完全不限高又会让面板长到好几屏（长解析比题干长得多）。
// 规则：按折行后的行数算高度，封顶 maxLines 行；超出时 over=true，由调用方换成 scroll-view 走框内滚动。
// 注意：这算的是**只读展示**用的框。输入框一律不参与 —— textarea 是原生组件，
// 不会被 scroll-view 裁剪，按内容长高会画到面板外面压住底部按钮。
const BOX_LINE_H = 44;   // 行高 27rpx × 1.6 ≈ 43，取 44 稳妥
const BOX_PAD_V = 36;    // 上下内边距各 18rpx
const BOX_CHARS = 22;    // 一行大约放得下多少字（按 27rpx 字号估）

function boxOf(text, maxLines) {
  const s = String(text == null ? '' : text);
  let lines = 0;
  s.split('\n').forEach((ln) => { lines += Math.max(1, Math.ceil(ln.length / BOX_CHARS)); });
  if (lines < 1) lines = 1;
  const cap = maxLines || 4;
  const shown = Math.min(lines, cap);
  return { h: BOX_PAD_V + shown * BOX_LINE_H, over: lines > cap };
}

// 弹层正文区高度（px）。纯计算，方便离线断言。
//
// 为什么非要算成确定的 px：小程序里 `flex: 1` 推导出来的高度**不会让 scroll-view 真正可滚**
// —— 高度是"内容撑出来的"时它等于内容高，没有溢出就没有滚动，滚轮事件会继续冒泡到
// 下面那层正在滚动的页面（首页题库列表），看着就是"滚错了地方"。
// 只有写死成 px、且小于内容自然高，scroll-view 才会自己承接滚动。
//
// 取 min(内容自然高, 可用高)：内容少就矮面板，内容多就在框内滚。
// 可用高 = 面板上限(82vh) - 头部实测高 - 面板固定开销 - 底部安全区。
// 固定开销按 rpx 折算（750rpx = 屏宽）：
//   上内边距 24 + 手柄下间距 20 + 正文上间距 24 + 下内边距 32 = 100rpx
function sheetBodyHeightOf(box) {
  const b = box || {};
  const winH = Number(b.winH) || 0;
  if (!winH) return 0;
  const W = (Number(b.winW) || 750) / 750;
  const sheetMax = winH * 0.82;
  const fixedH = 100 * W + (Number(b.headH) || 0) + (Number(b.safeBottom) || 0);
  const avail = Math.max(120, sheetMax - fixedH);
  const innerH = Number(b.innerH) || 0;
  // innerH 为 0 = 还没量到（首帧），这时按可用高给，别让面板塌成一条
  const h = innerH > 0 ? Math.min(innerH, avail) : avail;
  return Math.max(0, Math.ceil(h));
}

module.exports = { pad, formatTime, formatSize, extOf, fileTypeLabel, guessFileRole, sortLetters, formatDuration, nextAvailableName, boxOf, BOX_LINE_H, BOX_PAD_V, sheetBodyHeightOf };
