#!/usr/bin/env node
// ============================================================
// 电脑端预处理：把 PDF / Word 转成小程序端可解析的 txt
//
// 用途：小程序端只能解析纯文本（txt/md/json/csv）。
//      PDF 需要 PDF 对象解析 + zlib 解流，docx 需要解 ZIP，
//      这两件事在小程序沙箱里都做不到，所以放在电脑上先转一次。
//
// 用法：
//   node tools/to-txt.js <文件或目录> [输出目录]
//   node tools/to-txt.js book.pdf
//   node tools/to-txt.js ./raw ./txt
//
// 依赖：需先安装（只需一次）
//   cd tools && npm install
// ============================================================
const fs = require('fs');
const path = require('path');

// 依赖查找顺序：tools 自带优先；其次退回 v1 云端存档里已装好的依赖（老环境兜底）
const SEARCH_DIRS = [
  __dirname,
  path.join(__dirname, '..', 'legacy', 'cloudfunctions', 'generateSet')
];

function loadDep(name) {
  for (const dir of SEARCH_DIRS) {
    try {
      return require(require.resolve(name, { paths: [dir] }));
    } catch (e) { /* 换下一个位置 */ }
  }
  console.error(
    `[错误] 找不到依赖 ${name}。\n` +
    '请先在 tools 目录安装依赖：\n' +
    '   cd tools && npm install'
  );
  process.exit(1);
}

const SUPPORTED = ['.pdf', '.docx', '.txt', '.md'];

async function pdfToText(file) {
  const pdf = loadDep('pdf-parse');
  const data = await pdf(fs.readFileSync(file));
  if (!data || !data.text || !data.text.trim()) {
    throw new Error('未提取到文字：可能是扫描版/图片型 PDF（无文字层），需要先做 OCR');
  }
  return data.text;
}

async function docxToText(file) {
  const mammoth = loadDep('mammoth');
  const result = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
  const text = result.value || '';
  if (!text.trim()) throw new Error('未提取到文字');
  return text;
}

async function convertOne(file, outDir) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);
  const out = path.join(outDir, base + '.txt');

  let text;
  if (ext === '.pdf') text = await pdfToText(file);
  else if (ext === '.docx') text = await docxToText(file);
  else text = fs.readFileSync(file, 'utf8');

  // 统一行尾 + 去 BOM，保持与端上一致
  text = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  fs.writeFileSync(out, text, 'utf8');
  const lines = text.split('\n').length;
  console.log(`  ${path.basename(file)}  →  ${path.basename(out)}  (${lines} 行, ${(text.length / 1024).toFixed(0)} KB)`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('用法: node tools/to-txt.js <文件或目录> [输出目录]');
    process.exit(1);
  }
  const target = path.resolve(args[0]);
  if (!fs.existsSync(target)) {
    console.error('[错误] 路径不存在: ' + target);
    process.exit(1);
  }

  const stat = fs.statSync(target);
  const outDir = path.resolve(args[1] || (stat.isDirectory() ? path.join(target, 'txt') : path.dirname(target)));
  fs.mkdirSync(outDir, { recursive: true });

  const targets = stat.isDirectory()
    ? fs.readdirSync(target).filter((n) => SUPPORTED.indexOf(path.extname(n).toLowerCase()) >= 0 && !path.resolve(target, n).startsWith(outDir)).map((n) => path.join(target, n))
    : [target];

  if (!targets.length) {
    console.error('[错误] 目录下没有可转换的文件（支持 ' + SUPPORTED.join(' ') + '）');
    process.exit(1);
  }

  console.log(`输出目录: ${outDir}`);
  let done = 0, failed = 0;
  for (const f of targets) {
    try {
      await convertOne(f, outDir);
      done++;
    } catch (e) {
      failed++;
      console.error(`  ${path.basename(f)}  →  失败: ${(e && e.message) || e}`);
    }
  }
  console.log(`\n完成：成功 ${done} 个，失败 ${failed} 个。`);
  if (done) console.log('下一步：把 txt 发到微信（文件传输助手）→ 小程序「文件库」导入 → 「生成题库」。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
