#!/usr/bin/env node
// ============================================================
// 解析引擎核心的同步与护栏（单点负责，测试也调用这里）
//
// 为什么需要同步：小程序**无法 require 到 miniprogram/ 之外的目录**，
// 所以核心文件必须在两端各存一份。为避免两份实现悄悄跑偏，
// 固定「一份真源 + 单向同步 + 静态护栏」：
//
//   唯一真源  legacy/cloudfunctions/generateSet/parser-core.js   ← 改这里
//   生成副本  miniprogram/utils/parser-core.js                   ← 不要手改
//
// 用法：
//   node tools/sync-parser.js              同步（已最新则跳过）
//   node tools/sync-parser.js --check      只校验一致性 + 护栏，不改文件
//   node tools/sync-parser.js --lint <文件> 只对该文件跑「零 Node 依赖」护栏
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'legacy/cloudfunctions/generateSet/parser-core.js');
const DST = path.join(ROOT, 'miniprogram/utils/parser-core.js');

// 小程序端没有 Node 运行时；核心一旦引入这些能力，真机必崩
const FORBIDDEN = [
  [/\brequire\s*\(/, 'require()'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bprocess\.(env|argv|platform|cwd)/, 'process.*'],
  [/\b__dirname\b/, '__dirname']
];

// 检查前必须剥掉注释：文件头里"不要引入 Buffer/__dirname"这类说明文字
// 本身会被正则误判成违规（踩过这个坑，所以这里单列出来）
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function lint(code) {
  const codeOnly = stripComments(code);
  return FORBIDDEN.filter((pair) => pair[0].test(codeOnly)).map((pair) => pair[1]);
}

module.exports = { SRC, DST, lint, stripComments, FORBIDDEN };

// 被 require 时不执行 CLI 逻辑
if (require.main !== module) return;

const argv = process.argv.slice(2);
const lintIdx = argv.indexOf('--lint');

if (lintIdx >= 0) {
  const target = argv[lintIdx + 1];
  if (!target) {
    console.error('用法：node tools/sync-parser.js --lint <文件>');
    process.exit(2);
  }
  const bad = lint(fs.readFileSync(target, 'utf8'));
  if (bad.length) {
    console.error('[失败] 含 Node 专用代码：' + bad.join('、'));
    process.exit(1);
  }
  console.log('[OK] 零 Node 依赖');
  process.exit(0);
}

const src = fs.readFileSync(SRC, 'utf8');

const bad = lint(src);
if (bad.length) {
  console.error('[失败] 核心含 Node 专用代码，小程序端会崩：' + bad.join('、'));
  process.exit(1);
}

const existed = fs.existsSync(DST);
const same = existed && fs.readFileSync(DST, 'utf8') === src;

if (argv.indexOf('--check') >= 0) {
  if (!same) {
    console.error('[失败] miniprogram/utils/parser-core.js 与真源不一致，请运行 node tools/sync-parser.js');
    process.exit(1);
  }
  console.log('[OK] 两份解析核心一致，且零 Node 依赖');
  process.exit(0);
}

if (same) {
  console.log('已是最新，无需同步（' + src.length + ' 字节）');
  process.exit(0);
}

fs.writeFileSync(DST, src, 'utf8');
console.log((existed ? '已同步' : '已生成') + ' miniprogram/utils/parser-core.js（' + src.length + ' 字节）');
