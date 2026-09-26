// 标记题目持久化（utils/marks.js）
// 运行：node _smoke/marks.test.js
//
// 背景：标记原先只写在刷题会话 state.marks 里，开新会话就被覆盖，
//       答题卡也不显示标记态 —— 标了也找不回来。改造后按题库持久化，
//       并保留旧会话标记的迁移。
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: () => {}, showModal: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

const marks = require(path.join(BASE, 'utils/marks.js'));
const localdb = require(path.join(BASE, 'utils/localdb.js'));
const progress = require(path.join(BASE, 'utils/progress.js'));
const dataStore = require(path.join(BASE, 'utils/store.js'));
const portable = require(path.join(BASE, 'utils/portable.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

console.log('=== 1. 空态 ===');
eq('未标记时列表为空', marks.list('s1'), []);
eq('未标记时计数为 0', marks.count('s1'), 0);
eq('未标记时 has 为 false', marks.has('s1', 1), false);
eq('不存在的题库也返回空', marks.list('nope'), []);

console.log('\n=== 2. 标记 / 取消标记 ===');
let r = marks.toggle('s1', 1, '题库一');
eq('首次标记返回标记态', r.marked, true);
eq('首次标记后计数', r.total, 1);
eq('has 生效', marks.has('s1', 1), true);
eq('列表内容', marks.list('s1'), ['1']);

r = marks.toggle('s1', 1, '题库一');
eq('再次点击为取消', r.marked, false);
eq('取消后计数归零', r.total, 0);
eq('取消后 has 为 false', marks.has('s1', 1), false);

console.log('\n=== 3. 空清单不占存储（与错题本/校对本一致）===');
eq('空清单时存储键被清掉', 'qz_mk_s1' in mem, false);
marks.toggle('s1', 1, '题库一');
eq('有内容时键存在', 'qz_mk_s1' in mem, true);
eq('标题一并记下', mem.qz_mk_s1.title, '题库一');

console.log('\n=== 4. 重复标记不产生重复项 ===');
marks.toggle('s1', 1, '题库一');
marks.toggle('s1', 1, '题库一');
eq('反复切换后仍在列表中且唯一', marks.list('s1'), ['1']);

console.log('\n=== 5. 题号按数值排序（字符串排序会把 10 排到 2 前面）===');
['10', '2', '1', '20', '3'].forEach((no) => {
  if (!marks.has('s1', no)) marks.toggle('s1', no, '题库一');
});
eq('数值升序', marks.list('s1'), ['1', '2', '3', '10', '20']);

console.log('\n=== 6. 跨会话持久化（这正是原实现丢掉标记的地方）===');
const raw = wx.getStorageSync('qz_mk_s1');
eq('标记已落在 storage 里', raw.nos.length, 5);
// 模拟"开了一个新会话"：会话 state 被重建，但标记不受影响
const st = progress.createState('s1', '题库一', 'order', ['1', '2', '3', '10', '20']);
eq('新会话里标记仍在', marks.list('s1').length, 5);
eq('新会话 state 不再依赖 marks 字段', st.marks, undefined);

console.log('\n=== 7. 单题移除 / 清空 / 整库删除 ===');
marks.remove('s1', 10, '题库一');
eq('移除后列表', marks.list('s1'), ['1', '2', '3', '20']);
marks.clearBook('s1');
eq('清空后列表为空', marks.list('s1'), []);
eq('清空后存储键被删', 'qz_mk_s1' in mem, false);

console.log('\n=== 8. summary 汇总 ===');
marks.toggle('s1', 1, '题库一');
marks.toggle('s1', 2, '题库一');
marks.toggle('s2', 5, '题库二');
eq('汇总套数', marks.summary().sets, 2);
eq('汇总条数', marks.summary().total, 3);
marks.removeBook('s2');
eq('删库后汇总', marks.summary(), { sets: 1, total: 2 });

console.log('\n=== 9. 旧数据迁移：会话 state.marks 并入持久化清单 ===');
const oldState = progress.createState('s3', '题库三', 'order', ['1', '2', '3']);
oldState.marks = ['2', '3'];
const moved = marks.migrateFromState('s3', oldState);
eq('迁移条数', moved, 2);
eq('迁移后持久化列表', marks.list('s3'), ['2', '3']);
eq('迁移后会话里的那份被清空', oldState.marks, []);
eq('重复迁移不再搬（幂等）', marks.migrateFromState('s3', oldState), 0);
eq('列表没有重复', marks.list('s3'), ['2', '3']);

// 已存在的标记不被迁移覆盖
marks.toggle('s3', 9, '题库三');
const again = progress.createState('s3', '题库三', 'order', []);
again.marks = ['9', '4'];
eq('迁移只补不覆盖', marks.migrateFromState('s3', again), 1);
eq('合并结果', marks.list('s3'), ['2', '3', '4', '9']);

console.log('\n=== 10. 删除题库时连带清理标记 ===');
localdb.saveSetBundle({ setId: 's9', title: '待删库' }, [
  { no: 1, stem: 'x', type: 'single', options: [{ key: 'A', text: 'a' }], answerKey: 'A' }
]);
marks.toggle('s9', 1, '待删库');
eq('删除前有标记', marks.count('s9'), 1);
dataStore.deleteSet('s9');
eq('删除题库后标记被清掉', marks.count('s9'), 0);
eq('存储键也消失', 'qz_mk_s9' in mem, false);

console.log('\n=== 11. 备份要带上标记（不然换机就丢）===');
localdb.saveSetBundle({ setId: 'sb', title: '备份库' }, [
  { no: 1, stem: 'x', type: 'single', options: [{ key: 'A', text: 'a' }], answerKey: 'A' },
  { no: 2, stem: 'y', type: 'single', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], answerKey: 'B' }
]);
marks.toggle('sb', 2, '备份库');
const payload = portable.buildPayload(['sb']);
eq('导出汇总里的标记数', payload.summary.markedCount, 1);
eq('导出内容里的标记', payload.sets[0].marks.nos, ['2']);

// 清空本机题库与标记，再按备份还原
delete mem.qz_local_sets_v1;
delete mem.qz_mk_sb;
eq('清空后标记为空', marks.count('sb'), 0);
const plan = portable.planImport(payload);
eq('导入计划文案包含标记', /含标记题目 1 道/.test(portable.planText(plan)), true);
portable.applyImport(payload);
eq('导入后标记还原', marks.list('sb'), ['2']);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
