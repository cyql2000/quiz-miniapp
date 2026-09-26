// 生成页：文件类型白名单（试题槽只列试题文件，答案解析槽只列答案解析）
// 运行：node _smoke/generate.test.js
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
const toasts = [];
const modals = [];
const navs = [];

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => { modals.push(o.title); if (o.success) o.success({ confirm: true }); },
  navigateBack: () => navs.push('back'),
  navigateTo: (o) => navs.push(o.url),
  redirectTo: (o) => navs.push(o.url),
  switchTab: (o) => navs.push(o.url),
  setNavigationBarTitle: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  pageScrollTo: () => {},
  stopPullDownRefresh: () => {}
};
global.getApp = () => ({ globalData: {} });
require('./lib/wx-mock.js').attach(global.wx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const { guessFileRole } = require(path.join(BASE, 'utils/util.js'));

// ---------- 1. 文件名特征词判定 ----------
eq('文件名带「解析」判为答案', guessFileRole('02 政治理论与常识判断（解析）.txt'), 'answer');
eq('文件名带「题本」判为试题', guessFileRole('01 政治理论与常识判断（题本）.txt'), 'question');
eq('扩展名不干扰判定', guessFileRole('答案.docx'), 'answer');
eq('判不出来返回空', guessFileRole('行测5000题.txt'), '');

// ---------- 2. 生成页的两个文件槽位各自只列对应类型 ----------
let captured = null;
global.Page = (o) => { captured = o; };
require(path.join(BASE, 'pages/generate/generate.js'));

const mk = (files) => {
  const inst = Object.assign({}, captured);
  inst.data = JSON.parse(JSON.stringify(captured.data));
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

// 与 loadFiles 的输出同构：role 是导入时的手动分类，parsable 表示端上能否解析
const FILES = [
  { _id: 'q1', name: '01 政治理论（题本）.txt', role: 'question', parsable: true },
  { _id: 'a1', name: '02 政治理论（解析）.txt', role: 'answer', parsable: true },
  { _id: 'p1', name: '扫描件.pdf', role: '', parsable: false },
  { _id: 'u1', name: '未分类题目.txt', role: '', parsable: true },
  { _id: 'u2', name: '行测答案汇总.txt', role: '', parsable: true }
];

let p = mk(FILES);
p.openPicker({ currentTarget: { dataset: { slot: 'q' } } });
eq('试题槽只见试题文件', p.data.candidates.map((f) => f._id), ['q1', 'u1']);
eq('试题槽过滤数量', p.data.picker.hidden, 3);

p = mk(FILES);
p.openPicker({ currentTarget: { dataset: { slot: 'a' } } });
eq('答案槽只见答案解析', p.data.candidates.map((f) => f._id), ['a1', 'u2']);

// 已选中的那个不再出现在候选里
p = mk(FILES);
p.data.qFile = FILES[0];
p.openPicker({ currentTarget: { dataset: { slot: 'q' } } });
eq('已选文件不重复出现', p.data.candidates.map((f) => f._id), ['u1']);

// ---------- 3. 没有可用文件时给明确提示 ----------
p = mk([FILES[1], FILES[2]]);   // 只有答案解析 + pdf
modals.length = 0;
p.openPicker({ currentTarget: { dataset: { slot: 'q' } } });
eq('无试题文件时弹窗提示', modals, ['没有可用的试题文件']);
eq('无候选时不展开列表', p.data.picker.show, false);

p = mk([]);
modals.length = 0;
p.openPicker({ currentTarget: { dataset: { slot: 'a' } } });
eq('无答案解析时弹窗提示', modals, ['没有可用的答案解析文件']);

// ---------- 4. 强行塞错类型会被拦下 ----------
p = mk(FILES);
p.data.picker = { show: true, slot: 'q', hidden: 0 };
modals.length = 0;
p.pickFile({ currentTarget: { dataset: { id: 'a1' } } });
eq('试题槽拒收答案解析', modals, ['这不是试题文件']);
eq('拒收后不写入试题栏', p.data.qFile, null);

p = mk(FILES);
p.data.picker = { show: true, slot: 'a', hidden: 0 };
p.data.qFile = FILES[0];
modals.length = 0;
p.pickFile({ currentTarget: { dataset: { id: 'q1' } } });
eq('答案槽拒收试题文件', modals, ['这不是答案解析文件']);
eq('拒收后不写入答案栏', p.data.aFile, null);

// 正常选择不受影响
p = mk(FILES);
p.data.picker = { show: true, slot: 'q', hidden: 0 };
modals.length = 0;
p.pickFile({ currentTarget: { dataset: { id: 'q1' } } });
eq('正常选中试题文件', p.data.qFile._id, 'q1');
eq('正常选中不弹窗', modals, []);

// ---------- 5. 生成前的最后一道类型校验 ----------
p = mk(FILES);
p.data.qFile = FILES[1];   // 试题栏放了个答案解析
modals.length = 0;
p.doGenerate();
eq('生成前拦截类型不匹配', modals, ['文件类型不匹配']);
eq('拦截后不进入生成中', p.data.generating, false);

p = mk(FILES);
p.data.qFile = FILES[0];
p.data.aFile = FILES[0];   // 答案栏放了试题文件
modals.length = 0;
p.doGenerate();
eq('答案栏类型不符也被拦下', modals, ['文件类型不匹配']);

p = mk(FILES);
p.data.qFile = FILES[2];   // pdf：端上解析不了
modals.length = 0;
p.doGenerate();
eq('端上无法解析的类型被拦下', modals, ['文件类型不匹配']);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
