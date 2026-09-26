// 本地存储流水线测试（无需微信环境）
// 运行：node _smoke/localstore.test.js
// 用内存文件系统 + 内存 storage 模拟 wx，验证「导入文件 → 端上解析 → 落库 → 读回」全链路
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');
const ROOT = '/usr';

// ---------------- 内存文件系统（模拟 FileSystemManager） ----------------
const files = new Map(); // 绝对路径 -> Buffer
const dirs = new Set([ROOT]);

function isDir(p) { return dirs.has(p); }
function parentOf(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }

const fsmMock = {
  accessSync(p) {
    if (!files.has(p) && !dirs.has(p)) {
      const e = new Error('accessSync:fail no such file or directory, access ' + p);
      throw e;
    }
  },
  mkdirSync(p, recursive) {
    if (dirs.has(p)) { const e = new Error('mkdirSync:fail file already exists'); e.errMsg = 'mkdirSync:fail'; throw e; }
    if (recursive) {
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      parts.forEach((seg) => {
        cur += '/' + seg;
        dirs.add(cur);
      });
    } else {
      dirs.add(p);
    }
  },
  readFileSync(p, encoding) {
    if (!files.has(p)) throw new Error('readFileSync:fail no such file, ' + p);
    const buf = files.get(p);
    return encoding ? buf.toString(encoding) : buf;
  },
  writeFileSync(p, data) {
    files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
  },
  copyFileSync(src, dst) {
    if (!files.has(src)) throw new Error('copyFileSync:fail no such file, ' + src);
    files.set(dst, Buffer.from(files.get(src)));
  },
  unlinkSync(p) {
    if (!files.has(p)) throw new Error('unlinkSync:fail no such file, ' + p);
    files.delete(p);
  },
  rmdirSync(p, recursive) {
    if (recursive) {
      [...files.keys()].forEach((k) => { if (k.indexOf(p + '/') === 0) files.delete(k); });
      [...dirs].forEach((d) => { if (d.indexOf(p + '/') === 0) dirs.delete(d); });
    }
    dirs.delete(p);
  },
  statSync(p) {
    if (files.has(p)) return { size: files.get(p).byteLength, isDirectory: () => false };
    if (dirs.has(p)) return { size: 0, isDirectory: () => true };
    throw new Error('statSync:fail no such file, ' + p);
  },
  readdirSync(p) {
    if (!dirs.has(p)) throw new Error('readdirSync:fail no such directory, ' + p);
    const out = [];
    files.forEach((_, k) => { if (parentOf(k) === p) out.push(k.slice(p.length + 1)); });
    return out;
  }
};

// ---------------- 内存 storage ----------------
const mem = {};
const toasts = [];
global.wx = {
  env: { USER_DATA_PATH: ROOT },
  getFileSystemManager: () => fsmMock,
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => { toasts.push(o && o.title); },
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  setNavigationBarTitle: () => {}
};

const fsm = require(path.join(BASE, 'utils/localfs.js'));
const db = require(path.join(BASE, 'utils/localdb.js'));
const store = require(path.join(BASE, 'utils/store.js'));
const extract = require(path.join(BASE, 'utils/extract-local.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// ---------------- 样例数据 ----------------
const QFILE = [
  '# 第一章 常识判断',
  '1.（2023北京5）下列说法正确的是：',
  'A. 甲说法',
  'B. 乙说法',
  'C. 丙说法',
  'D. 丁说法',
  '2. 第二题题干内容',
  'A. 甲',
  'B. 乙',
  'C. 丙',
  'D. 丁',
  '# 第二章 言语理解',
  '1. 第二卷第一题',
  'A. 甲',
  'B. 乙',
  'C. 丙',
  'D. 丁',
  '2. 第二卷第二题',
  'A. 甲',
  'B. 乙',
  'C. 丙',
  'D. 丁',
  ''
].join('\n');

// 解析册：题号在每节内重新从 1 开始（真实场景的关键特征）
const AFILE = [
  '1.【答案】B。【解析】解析一，故正确答案为B。',
  '2.【答案】A。【解析】解析二，故正确答案为A。',
  '1.【答案】D。【解析】解析三，故正确答案为D。',
  '2.【答案】C。【解析】解析四，故正确答案为C。',
  ''
].join('\n');

console.log('=== 1. 沙箱目录与索引自检 ===');
fsm.ensureDir(fsm.DIR.sets);
fsm.ensureDir(fsm.DIR.source);
eq('根目录可用', fsm.ROOT, ROOT);
fsm.writeText('q_tmp/p.txt', 'ok');
eq('写入后读回', fsm.readText('q_tmp/p.txt'), 'ok');
fsm.remove('q_tmp/p.txt');
eq('删除后不存在', fsm.exists('q_tmp/p.txt'), false);

console.log('\n=== 2. 导入文件（临时文件 → 沙箱持久化） ===');
// 模拟 chooseMessageFile 给出的临时文件
files.set('/tmp/wx_q.txt', Buffer.from(QFILE, 'utf8'));
files.set('/tmp/wx_a.txt', Buffer.from(AFILE, 'utf8'));

const qf = store.importFile('/tmp/wx_q.txt', { name: '题本.txt', size: QFILE.length }, 'question');
const af = store.importFile('/tmp/wx_a.txt', { name: '解析.txt', size: AFILE.length }, 'answer');
ok('试题文件已建档', qf.id && qf.path);
eq('文件在沙箱内', fsm.exists(qf.path), true);
eq('索引条数', store.listFiles().length, 2);
eq('角色标记（新的在前）', store.listFiles().map((f) => f.role), ['answer', 'question']);
eq('可解析标记', store.listFiles().every((f) => f.parsable), true);

console.log('\n=== 3. 端上不可解析类型：可以入库保存，但无法解析 ===');
// 设计取舍：pdf/docx 允许存入文件库（方便留着），但解析必须走电脑预处理
files.set('/tmp/x.pdf', Buffer.from('%PDF-1.4 fake', 'utf8'));
files.set('/tmp/x.exe', Buffer.from('MZ', 'utf8'));
const pdfDoc = store.importFile('/tmp/x.pdf', { name: 'a.pdf', size: 10 }, 'question');
eq('pdf 可入库', !!pdfDoc.id, true);
eq('pdf 标记为不可解析', store.listFiles().find((f) => f.id === pdfDoc.id).parsable, false);
let threw = '';
try { extract.extractText('a.pdf', pdfDoc.path); } catch (e) { threw = e; }
eq('pdf 抽取报 NEED_DESKTOP', threw && threw.code, 'NEED_DESKTOP');
ok('提示指向电脑预处理', threw && /to-txt\.js/.test(threw.message));
let threw2 = '';
try { store.buildSet({ questionFileId: pdfDoc.id, title: 'x' }); } catch (e) { threw2 = e.code; }
eq('用 pdf 生成题库被拦截', threw2, 'NEED_DESKTOP');
store.deleteFile(pdfDoc.id);
let threwUnknown = '';
try { store.importFile('/tmp/x.exe', { name: 'a.exe' }, ''); } catch (e) { threwUnknown = e.message; }
ok('无关类型直接拒绝', /不支持的文件类型/.test(threwUnknown));

console.log('\n=== 4. 生成题库（分卷 + 顺序对齐） ===');
const r = store.buildSet({ questionFileId: qf.id, answerFileId: af.id, title: '本地题库' });
eq('拆成 2 个题库', r.parts.length, 2);
eq('总题数', r.totalQuestions, 4);
eq('对齐模式', r.answerPlanMode, 'sequential');
eq('全部匹配到答案', r.matchedCount, 4);
eq('解析条数', r.explCount, 4);
eq('第一册标题', r.parts[0].title, '本地题库 · 第一章 常识判断');
eq('第二册标题', r.parts[1].title, '本地题库 · 第二章 言语理解');

console.log('\n=== 5. 读回题库，校验答案按位置对位（题号重复也不串位） ===');
const b0 = store.loadSetBundle(r.parts[0].setId);
const b1 = store.loadSetBundle(r.parts[1].setId);
eq('第一册题数', b0.questions.length, 2);
eq('第一册答案', b0.questions.map((q) => q.answerKey), ['B', 'A']);
// 解析正文原样保留（含结尾"故正确答案为X"），保证与源文件一致
eq('第一册解析', b0.questions.map((q) => q.explanation), ['解析一，故正确答案为B。', '解析二，故正确答案为A。']);
eq('第二册答案', b1.questions.map((q) => q.answerKey), ['D', 'C']);
eq('第二册解析', b1.questions.map((q) => q.explanation), ['解析三，故正确答案为D。', '解析四，故正确答案为C。']);
eq('题干快照', b0.questions[0].stem, '（2023北京5）下列说法正确的是：');
eq('选项数', b0.questions[0].options.length, 4);
eq('题型', b0.questions[0].type, 'single');

console.log('\n=== 6. 题库清单与统计 ===');
eq('题库清单条数', store.listSets().length, 2);
const st = store.storageStats();
eq('统计·文件数', st.fileCount, 2);
eq('统计·题库数', st.setCount, 2);
ok('统计·占用体积 > 0', st.sizeText !== '0 B');
eq('无孤儿文件', st.orphans.length, 0);

// 占用统计要挨个 stat 文件，首页每次回前台都跑一遍会把 onShow 顶到 100ms 以上，
// 所以 localdb 里加了一份 30 秒缓存：命中缓存必须给出同样的数
const stCache = store.storageStats();
eq('统计·命中缓存结果一致', stCache.setCount, st.setCount);
eq('统计·缓存体积一致', stCache.sizeText, st.sizeText);

console.log('\n=== 7. 删除题库连带清理关联数据 ===');
const progress = require(path.join(BASE, 'utils/progress.js'));
const wrongbook = require(path.join(BASE, 'utils/wrongbook.js'));
const errata = require(path.join(BASE, 'utils/errata.js'));
const sid = r.parts[0].setId;
progress.createState(sid, '本地题库', 'order', [1, 2]);
wrongbook.recordAnswer(sid, b0.questions[0], { correct: false, selected: 'A', mode: 'order', title: '本地题库' });
errata.upsert(sid, b0.questions[0], { types: ['stem'], fix: { stem: '修正后的题干' }, title: '本地题库' });
ok('删除前有进度', !!progress.getState(sid));
ok('删除前有错题', wrongbook.stats(sid).total > 0);

store.deleteSet(sid);
eq('题库明细已删', store.loadSetBundle(sid), null);
eq('题库索引已删', store.listSets().length, 1);
ok('进度已清理', !progress.getState(sid));
eq('错题本已清理', wrongbook.stats(sid).total, 0);
eq('校对记录已清理', errata.stats(sid).total, 0);
eq('源文件保留（不受影响）', store.listFiles().length, 2);
// 写索引（这里是删除题库）必须让占用统计缓存失效，否则首页会一直显示旧数字
const stDel = store.storageStats();
eq('删除后统计立刻重算', stDel.setCount, 1);

console.log('\n=== 8. 删除源文件不影响已生成题库 ===');
store.deleteFile(qf.id);
eq('文件索引减一', store.listFiles().length, 1);
ok('另一题库仍在', !!store.loadSetBundle(r.parts[1].setId));
eq('被删文件实体已移除', fsm.exists(qf.path), false);

console.log('\n=== 9. 无答案文件也能生成（答案留空待补） ===');
const qf2 = store.importFile('/tmp/wx_q.txt', { name: '无答案题本.txt' }, 'question');
const r2 = store.buildSet({ questionFileId: qf2.id, title: '无答案' });
eq('生成成功', r2.ok, true);
eq('匹配数 0', r2.matchedCount, 0);
eq('疑问标记 matched=false', store.loadSetBundle(r2.parts[0].setId).questions.every((q) => !q.matched), true);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
