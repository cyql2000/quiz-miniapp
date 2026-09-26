// 真实数据端到端验证（本地流水线 vs 云端基准）
// 运行：node _smoke/realdata.test.js [行测目录]
// 目的：本地化改造后，端上跑的解析结果必须与云函数完全一致，不能悄悄变差。
//       数据目录不存在时自动跳过（该测试依赖外部语料，不入 CI 也能跑）。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.argv[2] || 'E:/WORKAPP/行测/2027行测5000题【26年3月版】';
const BASE = path.join(__dirname, '../miniprogram');

if (!fs.existsSync(DATA_DIR)) {
  console.log('跳过：未找到数据目录 ' + DATA_DIR);
  console.log('（可传入目录参数：node _smoke/realdata.test.js <行测目录>）');
  process.exit(0);
}

// ---------------- 内存 wx 环境 ----------------
const mem = {};
const toasts = [];
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {}
};
const wxMock = require('./lib/wx-mock.js');
const fsx = wxMock.attach(global.wx);

const store = require(path.join(BASE, 'utils/store.js'));
const fsm = require(path.join(BASE, 'utils/localfs.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// 云端流水线（pipeline-report.md）的基准结果
// 文件名必须与 _ocr/pipeline.js 用的完全一致，否则比的不是同一份输入
const BASELINE = [
  { key: '01/02', name: '政治理论与常识判断', qf: '01 政治理论与常识判断（题本）.ocr.分章.txt', af: '02 政治理论与常识判断（解析）.ocr.分章.txt', parts: 43, q: 967, matched: 943 },
  { key: '03/04', name: '判断推理', qf: '03 判断推理（题本）.ocr.章合并.txt', af: '04 判断推理（解析）.ocr.章合并.txt', parts: 4, q: 970, matched: 954 },
  { key: '05/06', name: '数量关系', qf: '05 数量关系（题本）.ocr.章合并.txt', af: '06 数量关系（解析）.ocr.章合并.txt', parts: 4, q: 995, matched: 977 },
  { key: '07/08', name: '言语理解', qf: '07 言语理解（题本）.ocr.章合并.txt', af: '08 言语理解（解析）.ocr.章合并.txt', parts: 4, q: 980, matched: 963 },
  { key: '09/10', name: '资料分析', qf: '09 资料分析（题本）.ocr.章合并.txt', af: '10 资料分析（解析）.ocr.章合并.txt', parts: 6, q: 997, matched: 971 }
];

// 把真实文件「喂」进沙箱（模拟用户导入）
function feed(fileName, role) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  const tmp = '/tmp/' + fileName;
  const content = fs.readFileSync(filePath, 'utf8');
  fsx.files.set(tmp, Buffer.from(content, 'utf8'));
  return store.importFile(tmp, { name: fileName, size: content.length }, role);
}

console.log('数据目录: ' + DATA_DIR);
console.log('\n=== 端上流水线 vs 云端基准 ===');
console.log('科目 | 分卷 | 题目 | 匹配 | 匹配率 | 基准题数 | 基准匹配 | 一致性');

let allBytes = 0;
let totalQ = 0;

BASELINE.forEach((b) => {
  const qDoc = feed(b.qf, 'question');
  const aDoc = feed(b.af, 'answer');
  if (!qDoc || !aDoc) {
    console.log(`${b.key}  跳过：缺文件（题本=${!!qDoc} 解析=${!!aDoc}）`);
    return;
  }

  const t0 = Date.now();
  const r = store.buildSet({ questionFileId: qDoc.id, answerFileId: aDoc.id, title: b.name });
  const cost = Date.now() - t0;

  const parts = r.parts.length;
  const matched = r.matchedCount;
  const rate = ((matched / r.totalQuestions) * 100).toFixed(1);
  const sameAll = parts === b.parts && r.totalQuestions === b.q && matched === b.matched;

  totalQ += r.totalQuestions;
  r.parts.forEach((p) => { allBytes += fsm.sizeOf(fsm.DIR.sets + '/' + p.setId + '.json'); });

  console.log(
    `  ${b.key} | ${parts} | ${r.totalQuestions} | ${matched} | ${rate}% | ${b.q} | ${b.matched} | ` +
    `${sameAll ? '一致' : '不一致'}  (${cost}ms, 模式 ${r.answerPlanMode})`
  );
  // 三个维度一次断言，失败时 JSON 里能直接看出是哪一项对不上
  eq(
    `${b.key} 分卷/题数/匹配数 与云端基准一致`,
    { parts, q: r.totalQuestions, matched },
    { parts: b.parts, q: b.q, matched: b.matched }
  );
});

console.log('\n=== 题库可正常读回 ===');
const sets = store.listSets();
if (!sets.length) {
  // 语料文件全部缺失时（如换了新版行测目录），前面循环全部跳过，没有可读回的题库
  console.log('跳过：没有任何题库（语料文件缺失或均未导入）');
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过（本组无可比数据）');
  process.exit(fail ? 1 : 0);
}
const firstSet = sets[0];
const bundle = store.loadSetBundle(firstSet.setId);
eq('首个题库读回成功', !!bundle, true);
eq('题目数与索引一致', bundle.questions.length, firstSet.questionCount);
const withAns = bundle.questions.filter((q) => q.answerKey || q.answer).length;
console.log(`  抽样「${firstSet.title}」共 ${bundle.questions.length} 题，其中 ${withAns} 题带答案`);
console.log('  首题:', JSON.stringify({
  no: bundle.questions[0].no,
  answerKey: bundle.questions[0].answerKey,
  type: bundle.questions[0].type,
  stem: String(bundle.questions[0].stem).slice(0, 30)
}));

console.log('\n=== 本地存储占用（这是方案可行性的关键） ===');
console.log(`  题库总数: ${store.listSets().length} 个`);
console.log(`  题目总数: ${totalQ} 题`);
console.log(`  题库明细占用: ${(allBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  测算单本约: ${(allBytes / 1024 / 1024 / 5).toFixed(1)} MB`);
console.log('  对照：沙箱本地用户文件上限约 200MB，storage 上限 10MB（索引只占几百字节）');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
