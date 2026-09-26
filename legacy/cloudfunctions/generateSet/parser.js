// ============================================================
// 轻刷题 · 解析引擎（Node / 云函数侧）
// 职责：在纯 JS 核心之上补充「文件字节 → 文本」的抽取能力
// 核心逻辑全部来自 ./parser-core（同一份代码，小程序端也在用）
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./parser-core');

const SUPPORTED = core.SUPPORTED;

// ---------- 文本抽取 ----------
async function extractText(fileName, buffer) {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName || '');
  const ext = m ? m[1].toLowerCase() : '';
  if (SUPPORTED.indexOf(ext) < 0) {
    if (ext === 'doc') {
      throw new Error('暂不支持旧版 .doc 文件：请在 Word 中「另存为」.docx 或 PDF 后再上传');
    }
    throw new Error(`不支持的文件类型 .${ext || '未知'}，请上传 PDF / Word(.docx) / txt / md`);
  }

  if (ext === 'txt' || ext === 'md') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) throw new Error('文件内容为空');
    return text;
  }

  if (ext === 'pdf') {
    const pdf = require('pdf-parse');
    const tmp = path.join(os.tmpdir(), `qz_${Date.now()}_${Math.floor(Math.random() * 100000)}.pdf`);
    fs.writeFileSync(tmp, buffer);
    try {
      const data = await pdf(fs.readFileSync(tmp));
      if (!data || !data.text || !data.text.trim()) {
        throw new Error('未能从 PDF 中提取到文字，该文件可能是扫描版/图片型 PDF（无文字层），请改用文字版 PDF 或 Word 文件');
      }
      return data.text;
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  }

  // docx
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || '';
  if (!text.trim()) throw new Error('未能从 Word 文件中提取到文字');
  return text;
}

module.exports = Object.assign({}, core, { extractText, SUPPORTED });
