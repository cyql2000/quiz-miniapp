// 解析引擎核心的「一致性 + 护栏」测试
// 运行：node _smoke/parser-core.test.js
//
// 背景：parser-core.js 需要同时存在于 Node 侧与小程序端（小程序无法 require
// 到 miniprogram/ 之外），靠 tools/sync-parser.js 单向同步。本测试防止：
//   1) 两份拷贝悄悄漂移
//   2) 核心误引入 Node 专有能力（小程序端会崩）
//   3) 护栏本身失效或误报
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 护栏与路径都由脚本单点提供，测试不再复制一份逻辑（避免两处实现漂移）
const sync = require(path.join(ROOT, 'tools/sync-parser.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const cloudSrc = fs.readFileSync(sync.SRC, 'utf8');
const miniSrc = fs.readFileSync(sync.DST, 'utf8');

console.log('=== 1. 两份拷贝必须逐字节一致 ===');
eq('Node 侧 / 小程序端核心一致', cloudSrc === miniSrc, true);
eq('核心体积合理（>10KB）', cloudSrc.length > 10000, true);

console.log('\n=== 2. 真源通过「零 Node 依赖」护栏 ===');
eq('真源无违规', sync.lint(cloudSrc), []);

console.log('\n=== 3. 护栏回归：必须能拦住违规 ===');
eq('拦住 require()', sync.lint('const fs = require("fs");'), ['require()']);
eq('拦住 Buffer', sync.lint('const b = Buffer.from(x);'), ['Buffer']);
eq('拦住 process.env', sync.lint('const e = process.env.HOME;'), ['process.*']);
eq('拦住 __dirname', sync.lint('const p = __dirname;'), ['__dirname']);
eq('一次报多个', sync.lint('require("fs"); Buffer.from(1); __dirname;'), ['require()', 'Buffer', '__dirname']);

console.log('\n=== 4. 护栏回归：注释里的说明文字不得误报 ===');
// 这条是踩坑后补的：文件头写着"不要引入 Buffer / __dirname"，
// 早期版本扫原始文本，把说明文字当成了违规。
eq('整行注释不误报', sync.lint('// 不要引入 require / Buffer / process / __dirname\nconst a = 1;'), []);
eq('块注释不误报', sync.lint('/* Buffer 与 __dirname 都不可用 */\nconst a = 1;'), []);
eq('注释剥离后再查真代码', sync.lint('// Buffer\nconst b = Buffer.from(x);'), ['Buffer']);

console.log('\n=== 5. 同步脚本 --check 退出码为 0 ===');
let checkOut = '';
let checkCode = 0;
try {
  checkOut = execFileSync(process.execPath, [path.join(ROOT, 'tools/sync-parser.js'), '--check'], { encoding: 'utf8' }).trim();
} catch (e) {
  checkCode = e.status || 1;
  checkOut = String((e.stdout || '') + (e.stderr || '')).trim();
}
eq('--check 通过', checkCode, 0);
eq('--check 输出', /两份解析核心一致/.test(checkOut), true);

console.log('\n=== 6. --lint 对违规文件必须返回 1 ===');
const tmp = path.join(ROOT, '_smoke', '.lint-fixture.js');
fs.writeFileSync(tmp, 'const fs = require("fs");\n', 'utf8');
let lintCode = 0;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/sync-parser.js'), '--lint', tmp], { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  lintCode = e.status;
}
fs.unlinkSync(tmp);
eq('--lint 违规文件退出码 1', lintCode, 1);

console.log('\n=== 7. 适配层导出 = 核心导出 + extractText ===');
const core = require(sync.SRC);
const adapter = require(path.join(ROOT, 'legacy/cloudfunctions/generateSet/parser.js'));
const coreKeys = Object.keys(core).sort();
const adapterKeys = Object.keys(adapter).sort();
eq('适配层无缺失导出', coreKeys.filter((k) => adapterKeys.indexOf(k) < 0), []);
eq('适配层多出的仅为 extractText', adapterKeys.filter((k) => coreKeys.indexOf(k) < 0), ['extractText']);

console.log('\n=== 8. 核心在「无 Node 全局」环境下仍可加载并解析 ===');
// 小程序端没有 Buffer / process，用子进程把全局置空后实跑一遍
const probe = `
  global.Buffer = undefined;
  global.process = undefined;
  const P = require(${JSON.stringify(sync.DST)});
  const txt = ['1. 甲题', 'A. a', 'B. b', 'C. c', 'D. d', '2. 乙题', 'A. a', 'B. b', 'C. c', 'D. d', ''].join('\\n');
  const qs = P.splitQuestions(txt);
  const ans = ['1.【答案】B。', '2.【答案】D。', ''].join('\\n');
  const plan = P.resolveAnswerPlan([{ title: null, count: qs.length, questions: qs }], ans);
  const built = P.buildQuestionsByPosition(qs, plan.perPart[0]);
  console.log(JSON.stringify({ n: qs.length, keys: built.map((q) => q.answerKey) }));
`;
let out = '';
try {
  out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
} catch (e) {
  out = 'ERROR: ' + ((e && e.message) || e);
}
eq('无 Node 全局下解析结果', out, JSON.stringify({ n: 2, keys: ['B', 'D'] }));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
