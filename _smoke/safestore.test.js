// 存储写入容错（safestore + 三个数据层的接入）
// 运行：node _smoke/safestore.test.js
//
// 背景：改造前 localdb/progress 裸调 setStorageSync（异常冒到页面），
//       wrongbook/errata 用 catch 吞掉（错题本与校对记录无声丢失）。
//       本套件把「storage 写满」这个场景造出来，验证两条路径都不再静默。
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
let failWrites = false;

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => {
    if (failWrites) {
      const e = new Error('setStorageSync:fail exceed storage limit');
      e.errMsg = 'setStorageSync:fail exceed storage limit';
      throw e;
    }
    mem[k] = JSON.parse(JSON.stringify(v));
  },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: () => {},
  showModal: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const safe = require(path.join(BASE, 'utils/safestore.js'));
const localdb = require(path.join(BASE, 'utils/localdb.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const wrongbook = require(path.join(BASE, 'utils/wrongbook.js'));
const errata = require(path.join(BASE, 'utils/errata.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

const Q = (no, key) => ({
  no,
  stem: '题干' + no,
  type: 'single',
  options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
  answerKey: key,
  explanation: '解析' + no
});

console.log('=== 1. safestore 基本行为 ===');
safe.clear();
eq('正常写入返回 true', safe.write('k_ok', { a: 1 }), true);
eq('正常写入无待提示错误', safe.peek(), null);
eq('值确实落库', wx.getStorageSync('k_ok'), { a: 1 });

failWrites = true;
safe.clear();
eq('写满时返回 false', safe.write('k_bad', { a: 1 }), false);
ok('失败被记录下来（不静默）', safe.peek() && safe.peek().key === 'k_bad');
ok('默认提示可读且指向存储空间', /存储空间/.test(safe.peek().message));
ok('记录了底层原始错误', /exceed storage/.test(safe.peek().raw || ''));
const taken = safe.take();
ok('take 取回现场', !!taken && taken.key === 'k_bad');
eq('take 之后清空（不会反复弹）', safe.peek(), null);

console.log('\n=== 2. writeOrThrow：强一致场景必须抛出 ===');
safe.clear();
let threw = null;
try {
  safe.writeOrThrow('k_cons', { a: 1 }, '清单未能更新，请清理后重试');
} catch (e) {
  threw = e;
}
ok('写不进去时抛错', !!threw);
eq('错误文案可读', threw && threw.message, '清单未能更新，请清理后重试');
eq('带 storageFull 标记便于上层判断', !!(threw && threw.storageFull), true);
eq('失败键可追溯', threw && threw.key, 'k_cons');
eq('抛错同样留下待提示现场', !!(safe.peek() && safe.peek().key === 'k_cons'), true);

console.log('\n=== 3. localdb 索引写入：失败即抛，不让调用方以为成功 ===');
safe.clear();
failWrites = false;
const doc = localdb.addFile({ name: 'a.txt', ext: 'txt', size: 3, path: 'q_source/a.txt' });
ok('正常建档', !!doc && doc.id);
failWrites = true;
let idxErr = null;
try {
  localdb.addFile({ name: 'b.txt', ext: 'txt', size: 3, path: 'q_source/b.txt' });
} catch (e) {
  idxErr = e;
}
ok('存储满时建档抛错', !!idxErr);
ok('错误文案指向存储空间', /存储空间/.test((idxErr && idxErr.message) || ''));
failWrites = false;
eq('失败的建档没有留下半截索引', localdb.listFiles().length, 1);

console.log('\n=== 4. wrongbook：写失败不再静默吞掉 ===');
safe.clear();
failWrites = false;
wrongbook.recordAnswer('s1', Q(1, 'A'), { correct: false, selected: 'B', mode: 'order', title: 'T' });
eq('正常写入后错题数为 1', wrongbook.stats('s1').total, 1);

safe.clear();
failWrites = true;
let wbThrew = false;
try {
  wrongbook.recordAnswer('s1', Q(2, 'B'), { correct: false, selected: 'A', mode: 'order', title: 'T' });
} catch (e) {
  wbThrew = true;
}
eq('写失败不抛错（不打断作答）', wbThrew, false);
const wp = safe.peek();
ok('但错误被记录下来了（旧实现这里被 catch 吞掉）', !!wp);
ok('提示文案指向错题记录', /错题/.test((wp && wp.message) || ''));
eq('存储里仍是上一次成功的状态', wrongbook.stats('s1').total, 1);

console.log('\n=== 5. errata：同上 ===');
safe.clear();
failWrites = false;
errata.upsert('s1', Q(1, 'A'), { types: ['answer'] });
eq('正常写入校对记录', errata.stats('s1').total, 1);
safe.clear();
failWrites = true;
errata.upsert('s1', Q(3, 'A'), { types: ['stem'] });
const ep = safe.peek();
ok('校对写失败被记录', !!ep);
ok('提示文案指向校对记录', /校对/.test((ep && ep.message) || ''));
eq('存储里仍是上一次成功的状态', errata.stats('s1').total, 1);

console.log('\n=== 6. progress：进度写失败也不静默 ===');
safe.clear();
failWrites = false;
const st = progress.createState('s1', 'T', 'order', ['1', '2']);
eq('正常建会话', !!st.setId, true);
safe.clear();
failWrites = true;
progress.saveState(st);
ok('进度写失败被记录', !!(safe.peek() && /刷题进度/.test(safe.peek().label || '')));
eq('一次操作连写多个 key 时保留首次失败的现场', (safe.peek() || {}).label, '刷题进度');

console.log('\n=== 7. 恢复写入能力后一切照旧 ===');
failWrites = false;
safe.clear();
progress.saveState(st);
eq('恢复后写入不再报错', safe.peek(), null);
eq('进度确实落库', !!(wx.getStorageSync('qz_state_s1') || {}).setId, true);
wrongbook.recordAnswer('s1', Q(2, 'B'), { correct: false, selected: 'A', mode: 'order', title: 'T' });
eq('错题重新可写', wrongbook.stats('s1').total, 2);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
