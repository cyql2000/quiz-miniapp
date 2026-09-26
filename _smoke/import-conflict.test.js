// 导入同名文件时的冲突处理：替换 / 重命名 / 跳过
// 运行：node _smoke/import-conflict.test.js
//
// 覆盖三层：
//   1. util.nextAvailableName —— 重命名分支给的默认名
//   2. store.replaceFile —— 覆盖文件 + 清除由它生成的题库（连带进度）
//   3. pages/files —— 三项交互的实际走向（跳过零改动 / 替换要二次确认 / 重命名保留两份）
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');
const ROOT = '/usr';

// ---------------- wx 桩：内存 storage + 内存文件系统 ----------------
const mem = {};
let toasts = [];
let modals = [];        // 按弹出顺序记录 { title, content, editable }
let sheets = [];        // { itemList }
let loading = [];

// 弹窗行为可控：每次 showModal 之后怎么应答，由 modalAnswers 队列决定
let modalAnswers = [];
// showActionSheet 应答：队列里的值为 tapIndex（-1 表示走 fail 取消）
let sheetAnswers = [];

global.wx = {
  env: { USER_DATA_PATH: ROOT },
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o && o.title),
  showLoading: (o) => loading.push(o && o.title),
  hideLoading: () => {},
  showModal: (o) => {
    modals.push({ title: o.title, content: o.content || '', editable: !!o.editable, placeholderText: o.placeholderText });
    const ans = modalAnswers.length ? modalAnswers.shift() : { confirm: false };
    if (o.success) o.success({ confirm: !!ans.confirm, content: ans.content || '' });
    else if (ans.confirm && o.confirmText) { /* 无回调 */ }
  },
  showActionSheet: (o) => {
    sheets.push({ itemList: o.itemList || [] });
    const idx = sheetAnswers.length ? sheetAnswers.shift() : -1;
    if (idx < 0) { if (o.fail) o.fail({ errMsg: 'cancel' }); return; }
    if (o.success) o.success({ tapIndex: idx });
  },
  setNavigationBarTitle: () => {},
  stopPullDownRefresh: () => {},
  navigateTo: () => {},
  pageScrollTo: () => {}
};
require('./lib/wx-mock.js').attach(global.wx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

const fsm = require(path.join(BASE, 'utils/localfs.js'));
const db = require(path.join(BASE, 'utils/localdb.js'));
const store = require(path.join(BASE, 'utils/store.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const { nextAvailableName } = require(path.join(BASE, 'utils/util.js'));

// ---------------- 1. 可用新名称 ----------------
eq('无冲突时返回原名', nextAvailableName('a.txt', ['b.txt']), 'a.txt');
eq('重名时补 (2)', nextAvailableName('a.txt', ['a.txt']), 'a(2).txt');
eq('(2) 也被占用则补 (3)', nextAvailableName('a.txt', ['a.txt', 'a(2).txt']), 'a(3).txt');
eq('保留扩展名', nextAvailableName('01 题本.txt', ['01 题本.txt']), '01 题本(2).txt');
eq('无扩展名也能补号', nextAvailableName('题库', ['题库']), '题库(2)');
eq('空占用表不误伤', nextAvailableName('a.txt', []), 'a.txt');

// ---------------- 2. store：同名查找与关联题库 ----------------
db.clearAll();
const p1 = `${fsm.DIR.source}/old_01.txt`;
fsm.writeText(p1, '旧内容');
const oldFile = db.addFile({ name: '01 题本.txt', ext: 'txt', size: 9, role: 'question', path: p1 });

eq('按文件名能查到', (store.findFileByName('01 题本.txt') || {}).id, oldFile.id);
eq('文件名不同就查不到', store.findFileByName('01 题本(2).txt'), null);
eq('空名字不误命中', store.findFileByName(''), null);

// 造两个题库：一个拿它当试题文件，一个拿它当答案解析
db.saveSetBundle({ setId: 's_from_q', title: '卷一', questionFile: { id: oldFile.id, name: oldFile.name }, answerFile: null }, []);
db.saveSetBundle({ setId: 's_from_a', title: '卷二', questionFile: { id: 'other', name: 'x.txt' }, answerFile: { id: oldFile.id, name: oldFile.name } }, []);
db.saveSetBundle({ setId: 's_other', title: '卷三', questionFile: { id: 'other', name: 'x.txt' }, answerFile: null }, []);

eq('两种来源都算关联题库', store.setsByFileId(oldFile.id).map((s) => s.setId).sort(), ['s_from_a', 's_from_q']);
eq('不相关的文件没有关联题库', store.setsByFileId('nobody').length, 0);
eq('没有 questionFile 的备份题库不报错', store.setsByFileId('').length, 0);

// 给关联题库写一份进度，稍后验证被一起清掉
progress.saveState(progress.createState('s_from_q', '卷一', 'order', [1, 2, 3]));
ok('进度已写入', !!progress.getState('s_from_q'));

// ---------------- 3. store.replaceFile ----------------
// 注意：chooseMessageFile 给的是绝对路径（与沙箱路径不同源），copyIn 直接拿它当源
const tmp = `${ROOT}/${fsm.DIR.tmp}/new_01.txt`;
fsm.writeText(tmp, '新内容比较长');
const rep = store.replaceFile(oldFile.id, tmp, { name: '01 题本.txt', size: 18 }, '');

eq('替换后沿用原 id', rep.file.id, oldFile.id);
eq('替换后文件名不变', rep.file.name, '01 题本.txt');
eq('分类沿用原文件的', rep.file.role, 'question');
eq('沙箱内容已换成新文件', fsm.readText(rep.file.path), '新内容比较长');
eq('文件记录仍是同一条', db.listFiles().length, 1);
eq('被清除的题库数', rep.removedSets.map((s) => s.setId).sort(), ['s_from_a', 's_from_q']);
eq('关联题库已删除', !!db.getSetMeta('s_from_q'), false);
eq('关联题库已删除(答案来源)', !!db.getSetMeta('s_from_a'), false);
eq('无关题库保留', !!db.getSetMeta('s_other'), true);
eq('进度随题库一起清除', progress.getState('s_from_q'), null);
eq('旧沙箱实体已删除', fsm.exists(p1), false);
eq('替换后仍能按名查到', (store.findFileByName('01 题本.txt') || {}).id, oldFile.id);

// 目标文件不在库里时报错
let err = '';
try { store.replaceFile('nope', tmp, { name: 'x.txt', size: 1 }, ''); } catch (e) { err = e.message; }
ok('替换不存在的文件会报错', /无法替换/.test(err));

// ---------------- 4. 页面交互：三项走向 ----------------
let captured = null;
global.Page = (o) => { captured = o; };
require(path.join(BASE, 'pages/files/files.js'));

const mk = (files) => {
  const inst = Object.assign({}, captured);
  inst.data = JSON.parse(JSON.stringify({ loading: false, importing: false, filter: 'all', files: [], list: [] }));
  inst.data.files = files;
  inst.setData = function (o) {
    Object.keys(o).forEach((k) => {
      const ps = k.split('.');
      let t = this.data;
      for (let i = 0; i < ps.length - 1; i++) t = t[ps[i]];
      t[ps[ps.length - 1]] = o[k];
    });
  };
  return inst;
};

// 造一个干净的场景：库里已有一个同名文件 + 一个由它生成的题库
function scene() {
  db.clearAll();
  const rel = `${fsm.DIR.source}/scene_a.txt`;
  fsm.writeText(rel, '旧版本题目内容');
  const f = db.addFile({ name: '行测题本.txt', ext: 'txt', size: 21, role: 'question', path: rel });
  db.saveSetBundle({ setId: 's_scene', title: '行测题本 · 卷一', questionCount: 10, questionFile: { id: f.id, name: f.name } }, []);
  const list = store.listFiles().map((x) => ({ _id: x._id, id: x.id, name: x.name, size: x.size, role: x.role, path: x.path, createTime: 1 }));
  db.listFiles().forEach((x) => { const v = list.filter((y) => y.id === x.id)[0]; if (v) v.createTime = x.createTime; });
  return { file: f, list };
}

const NEW = { name: '行测题本.txt', size: 30, path: `${ROOT}/${fsm.DIR.tmp}/scene_new.txt` };

// --- 4a. 跳过：不做任何改动 ---
let sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
let pg = mk(sc.list);
modals = []; modalAnswers = []; sheetAnswers = [2];   // 选「取消本次导入」
pg.askConflict(NEW, db.getFile(sc.file.id));
eq('跳过：第一层是选项表，不再先弹窗', modals.length, 0);
ok('跳过：第一项就是替换', /替换/.test(sheets[0].itemList[0]));
ok('跳过：替换项写明会清几个题库', /1 个题库/.test(sheets[0].itemList[0]));
ok('跳过：三项齐全', /替换/.test(sheets[0].itemList[0]) && /重命名/.test(sheets[0].itemList[1]) && /取消/.test(sheets[0].itemList[2]));
eq('跳过：文件数不变', db.listFiles().length, 1);
eq('跳过：题库还在', !!db.getSetMeta('s_scene'), true);
eq('跳过：给了明确提示', toasts[toasts.length - 1], '已跳过本次导入');
eq('跳过：原文件内容未变', fsm.readText(sc.file.path), '旧版本题目内容');

// 点遮罩取消（走 fail）同样要给提示，不能静默
sc = scene();
pg = mk(sc.list);
modals = []; toasts.length = 0; sheetAnswers = [-1];
pg.askConflict(NEW, db.getFile(sc.file.id));
eq('跳过：点遮罩取消也有提示', toasts[toasts.length - 1], '已跳过本次导入');
eq('跳过：点遮罩取消不改数据', db.listFiles().length, 1);

// --- 4b. 替换：二次确认，取消则不动 ---
sc = scene();
pg = mk(sc.list.filter((x) => true));
modals = []; modalAnswers = [{ confirm: false }]; sheetAnswers = [0];
pg.askConflict(NEW, db.getFile(sc.file.id));
ok('替换：二次确认弹窗', /确认替换/.test(modals[0].title));
ok('替换：二次确认写明会删题库', /作答进度/.test(modals[0].content) && /行测题本/.test(modals[0].content));
eq('替换：取消后文件数不变', db.listFiles().length, 1);
eq('替换：取消后题库还在', !!db.getSetMeta('s_scene'), true);

// --- 4c. 替换：确认执行 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
progress.saveState(progress.createState('s_scene', '行测题本 · 卷一', 'order', [1, 2]));
pg = mk(sc.list);
modals = []; modalAnswers = [{ confirm: true }]; sheetAnswers = [0];
pg.askConflict(NEW, db.getFile(sc.file.id));
eq('替换：文件仍只有一条', db.listFiles().length, 1);
eq('替换：内容已更新', fsm.readText(db.listFiles()[0].path), '新版本题目内容');
eq('替换：旧题库被清除', !!db.getSetMeta('s_scene'), false);
eq('替换：进度被清除', progress.getState('s_scene'), null);
ok('替换：结果有反馈', /已替换/.test(modals[1].title));

// --- 4d. 重命名：默认名可用，确认后保留两份 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
pg = mk(sc.list);
modals = []; sheets = []; modalAnswers = [{ confirm: true, content: '' }];
sheetAnswers = [1];   // 选「重命名后导入」
pg.askConflict(NEW, db.getFile(sc.file.id));
ok('重命名：弹窗可编辑', modals[0].editable === true);
eq('重命名：默认名带 (2)', modals[0].placeholderText, '行测题本(2).txt');
eq('重命名：不再多弹一次角色选择', sheets.length, 1);
eq('重命名：保留新旧两份', db.listFiles().map((f) => f.name).sort(), ['行测题本(2).txt', '行测题本.txt']);
eq('重命名：原题库不受影响', !!db.getSetMeta('s_scene'), true);
eq('重命名：新文件内容正确', fsm.readText(db.listFiles().filter((f) => f.name.indexOf('(2)') > 0)[0].path), '新版本题目内容');
eq('重命名：分类沿用原文件', db.listFiles().filter((f) => f.name.indexOf('(2)') > 0)[0].role, 'question');

// --- 4e. 重命名：手动输入，扩展名被改坏时自动补回 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
pg = mk(sc.list);
modals = []; modalAnswers = [{ confirm: true, content: '我的题本' }];
sheetAnswers = [1];
pg.askConflict(NEW, db.getFile(sc.file.id));
const added = db.listFiles().filter((f) => f.name.indexOf('我的题本') === 0)[0];
ok('重命名：扩展名缺失时补回', added && added.name === '我的题本.txt');

// --- 4f. 重命名：手动输入仍重名则拒绝 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
pg = mk(sc.list);
modals = []; toasts.length = 0;
modalAnswers = [{ confirm: true, content: '行测题本.txt' }];
sheetAnswers = [1];
pg.askConflict(NEW, db.getFile(sc.file.id));
eq('重命名：撞回原名被拒', db.listFiles().length, 1);
eq('重命名：给出重名提示', toasts[toasts.length - 1], '该名称仍与已有文件重名');

// --- 4g. 入口：同名必须走冲突流程，而不是直接保存 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
pg = mk(sc.list);
modals = []; sheets = []; toasts.length = 0; modalAnswers = []; sheetAnswers = [2];
let picked = null;
global.wx.chooseMessageFile = (o) => { picked = o; o.success({ tempFiles: [{ name: NEW.name, size: NEW.size, path: NEW.path }] }); };
pg.chooseImport();
eq('入口：同名导入弹出冲突选项', sheets.length, 1);
ok('入口：第一项是替换', /替换/.test(sheets[0].itemList[0]));
eq('入口：同名时没有直接保存', db.listFiles().length, 1);
eq('入口：同名时未写沙箱', db.listFiles()[0].path, sc.file.path);
ok('入口：文件类型白名单生效', Array.isArray(picked.extension) && picked.extension.indexOf('txt') >= 0);

// --- 4h. 入口：不同名则照旧直接进保存流程 ---
sc = scene();
fsm.writeText(NEW.path, '新版本题目内容');
pg = mk(sc.list);
modals = []; sheets = []; modalAnswers = []; sheetAnswers = [0];
global.wx.chooseMessageFile = (o) => o.success({ tempFiles: [{ name: '全新题本.txt', size: 12, path: NEW.path }] });
pg.chooseImport();
eq('入口：不同名直接进保存流程', sheets.length, 1);
eq('入口：保存流程先问分类', sheets[0].itemList[0], '作为试题文件');
eq('入口：不同名时才新增文件', db.listFiles().map((f) => f.name).sort(), ['全新题本.txt', '行测题本.txt']);

// --- 4g. 替换：文件已不在库里（极端情况）不静默 ---
err = '';
try {
  pg.doReplace(NEW, { id: 'ghost', name: 'x.txt' });
} catch (e) { err = e.message; }
ok('替换异常由页面捕获而非抛出', modals.some((m) => m.title === '替换失败'));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
