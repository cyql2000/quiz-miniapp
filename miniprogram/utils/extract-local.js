// ============================================================
// 本地文本抽取（替代云函数的 extractText）
// 端上能力边界：
//   txt / md / json  → 直接读取（无外部依赖，稳定）
//   docx             → Word 是 ZIP 容器，端上无解压库，无法解析
//   pdf              → 需要 PDF 对象解析 + zlib 解流，端上不可行
// 后两者请先用 tools/to-txt.js 在电脑上转成 txt 再导入（见 README）。
// ============================================================

const fsm = require('./localfs');

const LOCAL_SUPPORTED = ['txt', 'md', 'json', 'csv'];

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// 端上无法处理、需要电脑预处理的类型
const NEED_DESKTOP = {
  pdf: 'PDF 需要解析对象结构与压缩流，小程序端没有可用的运行库。\n请用 tools/to-txt.js 在电脑上转成 txt 后导入。',
  docx: 'docx 是 ZIP 容器（需解压 word/document.xml），端上无法解压。\n请用 tools/to-txt.js 在电脑上转成 txt 后导入，或在 Word 里另存为 .txt。',
  doc: '旧版 .doc 为二进制格式，请先另存为 .docx 或 .txt。'
};

// 从沙箱内的相对路径读取文本
function extractText(fileName, relPath) {
  const ext = extOf(fileName);
  if (NEED_DESKTOP[ext]) {
    const err = new Error(NEED_DESKTOP[ext]);
    err.code = 'NEED_DESKTOP';
    throw err;
  }
  if (LOCAL_SUPPORTED.indexOf(ext) < 0) {
    throw new Error(`端上不支持 .${ext || '未知'} 文件，目前支持：${LOCAL_SUPPORTED.join(' / ')}`);
  }
  let text = fsm.readText(relPath);
  text = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error(`文件「${fileName}」内容为空`);
  return text;
}

function isLocalSupported(name) {
  return LOCAL_SUPPORTED.indexOf(extOf(name)) >= 0;
}

module.exports = { extractText, extOf, isLocalSupported, LOCAL_SUPPORTED, NEED_DESKTOP };
