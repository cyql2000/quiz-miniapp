// ============================================================
// 题目显示异常 · 三级定位工具
//
// 用途：手机上看到某题不对时，先判断责任在【题目文件】还是【小程序】。
//   · 文件侧：清理后的可导入 txt（可导入/*.txt）
//   · 解析侧：小程序的切题/装配引擎（miniprogram/utils/parser-core.js）
//   · 数据侧：手机上那份题库是导入时存下的快照，文件改了不会自动更新
//
// 用法：
//   node tools/diag-question.js "<txt路径>" "<题干里的关键词>"
//       定位该题，打印它在文件里被切成的样子（题干、选项、题号），并列出前后各一题
//
//   node tools/diag-question.js "<txt路径>" --scan
//       全文件扫描两类粘连：
//         ① 选项文本里吞进了下一题的题号（形如 "… 20.（2025黑龙江9）…"）
//         ② 同一题出现重复的选项字母（形如 A B C D A B C D，题号行丢失的典型形态）
//
// 判读：
//   · 诊断输出干净 → 文件与解析引擎都没问题，手机上那份是旧数据，重新导入该文件即可
//   · 输出里能看到粘连 → 文件侧问题，回到 _ocr/build_importable.py 查清理链
//
// 注意：解析引擎真源是 legacy/cloudfunctions/generateSet/parser-core.js，
//      改完必须先 node tools/sync-parser.js；本工具读的是同步后的副本，故始终与分析一致。
// ============================================================
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'parser-core.js'));

// 选项文本里内嵌的「下一题题号」（题号 + 题源标注年份）
const INLINE_QNO = /(\d{1,4})\s*[.、．)）]\s*[（(]\s*(?:19|20)\d{2}/g;

function loadQuestions(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const paper = core.splitPaper(raw);
  const qText = paper.hasAnswer ? paper.questionText : raw;
  const parts = core.splitParts(qText);
  const out = [];
  parts.forEach((p, pi) => {
    core.splitQuestions(p.text).forEach((q, qi) => {
      out.push({ part: p.title, partIndex: pi, inPart: qi, partCount: null, q });
    });
  });
  // 回填每卷题数
  const counts = {};
  out.forEach((r) => { counts[r.partIndex] = (counts[r.partIndex] || 0) + 1; });
  out.forEach((r) => { r.partCount = counts[r.partIndex]; });
  return { parts, rows: out, hasAnswer: paper.hasAnswer };
}

function dumpRow(r, tag) {
  const q = r.q;
  console.log(`\n[${tag}] 分卷：${r.part || '（无标题）'}　卷内第 ${r.inPart + 1}/${r.partCount} 题　文件题号 ${q.fileNo}`);
  console.log('  题干：' + (q.stem || '（空）').replace(/\n/g, '\n        '));
  (q.options || []).forEach((o) => console.log(`  ${o.key} ── ${o.text}`));
  if (!q.options || !q.options.length) console.log('  （无选项）');
}

function glueCheck(q) {
  const issues = [];
  (q.options || []).forEach((o) => {
    INLINE_QNO.lastIndex = 0;
    const m = INLINE_QNO.exec(o.text || '');
    if (m) issues.push(`选项 ${o.key} 里出现下一题题号「${m[1]}.」`);
  });
  const keys = (q.options || []).map((o) => o.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) issues.push(`选项字母重复：${keys.join(' ')}`);
  return issues;
}

function main() {
  const file = process.argv[2];
  const arg = process.argv[3];
  if (!file || !arg) {
    console.log('用法：node tools/diag-question.js "<txt路径>" "<关键词>"  或  "<txt路径>" --scan');
    process.exit(1);
  }
  const { rows, hasAnswer } = loadQuestions(file);
  console.log(`文件：${file}`);
  console.log(`切出题目：${rows.length} 题${hasAnswer ? '（文末答案区已切出）' : ''}`);

  if (arg === '--scan') {
    let hit = 0;
    const seen = new Set();
    rows.forEach((r) => {
      const issues = glueCheck(r.q);
      if (!issues.length) return;
      hit++;
      const key = r.partIndex + '#' + r.q.fileNo;
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`\n! 分卷「${r.part || '（无标题）'}」文件题号 ${r.q.fileNo}`);
      issues.forEach((s) => console.log('   · ' + s));
      console.log('   题干：' + (r.q.stem || '').slice(0, 60));
    });
    console.log(`\n合计可疑题：${hit} 处 / ${rows.length} 题`);
    process.exit(0);
  }

  const idx = rows.findIndex((r) => {
    const blob = (r.q.stem || '') + '\n' + (r.q.options || []).map((o) => o.text).join('\n');
    return blob.indexOf(arg) >= 0;
  });
  if (idx < 0) {
    console.log(`\n未在任何题目里找到「${arg}」。可能：关键词被 OCR 拆断、或该处文字在清理时被丢弃。`);
    console.log('建议改用题干中的另一个短语再试，或直接 grep 原始页文件 _ocr/pages/<书名>/*.txt 定位书页。');
    process.exit(0);
  }
  console.log(`命中 ${rows.filter((r) => ((r.q.stem || '') + (r.q.options || []).map((o) => o.text).join('\n')).indexOf(arg) >= 0).length} 处`);

  [idx - 1, idx, idx + 1].forEach((i) => {
    if (rows[i]) dumpRow(rows[i], i === idx ? '命中' : (i < idx ? '上一题' : '下一题'));
  });

  const issues = glueCheck(rows[idx].q);
  console.log('\n──── 自检 ────');
  if (!issues.length) {
    console.log('该题在文件+解析引擎侧的切分结果是干净的（选项字母正常、未吞入其它题）。');
    console.log('→ 若手机上看到的不是这个样子，说明手机里那份题库是导入时的旧快照，重新导入本文件即可。');
  } else {
    issues.forEach((s) => console.log('! ' + s));
    console.log('→ 文件侧仍有粘连，需回 _ocr/build_importable.py 的清理链排查。');
  }

  // 顺带报一下全文件可疑处，便于判断是个案还是普遍
  let total = 0;
  rows.forEach((r) => { if (glueCheck(r.q).length) total++; });
  console.log(`全文件粘连自检：${total} 处 / ${rows.length} 题`);
}

main();
