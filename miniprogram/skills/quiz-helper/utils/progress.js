// 刷题进度本地存储管理
// 每次刷题会话对应 key: qz_state_{setId}
const safe = require('./safestore');

const stateKey = (setId) => `qz_state_${setId}`;
const RECENTS_KEY = 'qz_recents';

// 自定义练习的会话槽位：它的题目跨多个题库，没有单一 setId 可挂，
// 所以固定占用一个槽位。一次只保留一份 —— 重新抽题即覆盖上一组，
// 与「每个题库一条会话」的既有形态互不干扰。
const CUSTOM_SCOPE = '__custom__';

const MODE_LABEL = {
  order: '顺序练习',
  random: '随机练习',
  wrong: '错题重练',
  hard: '易错题重练',
  marked: '标记题重练',
  review: '背题模式',
  custom: '自定义练习'
};

// ---------------- 用时统计 ----------------
//
// 旧实现只有 startedAt（建会话时写一次），结果页算「用时」= now - startedAt。
// 但 mode=continue 是直接沿用旧 state 的，隔天接着刷就会显示上千分钟。
//
// 改成累计活跃时长：
//   elapsedMs  —— 已结清的活跃毫秒数
//   lastTickAt —— 上一次结清的时间点
// 每次 saveState 都结清一次；页面从后台回来时调 skipIdle 把离场那段时间跳过，
// 所以只有「页面在前台」的时间会被计入。
function tick(state, at) {
  if (!state) return 0;
  const now = at || Date.now();
  if (!state.lastTickAt) {
    state.lastTickAt = now;
    if (state.elapsedMs == null) state.elapsedMs = 0;
    return state.elapsedMs;
  }
  const dt = now - state.lastTickAt;
  if (dt > 0) state.elapsedMs = (state.elapsedMs || 0) + dt;
  state.lastTickAt = now;
  return state.elapsedMs || 0;
}

// 从后台/其他页面回到答题页：不把离开的这段时间算进来
function skipIdle(state, at) {
  if (state) state.lastTickAt = at || Date.now();
  return state;
}

function elapsedOf(state) {
  return (state && state.elapsedMs) || 0;
}

function getState(setId) {
  let s = null;
  try {
    s = wx.getStorageSync(stateKey(setId)) || null;
  } catch (e) {
    return null;
  }
  if (!s) return null;
  // 旧版本会话没有计时字段：清零重计，避免把历史 startedAt 当成活跃时长
  if (s.elapsedMs == null) {
    s.elapsedMs = 0;
    s.lastTickAt = Date.now();
  }
  return s;
}

function saveState(state) {
  if (!state || !state.setId) return;
  tick(state);
  safe.write(stateKey(state.setId), state, { label: '刷题进度' });

  // 更新最近记录
  let recents = [];
  try { recents = wx.getStorageSync(RECENTS_KEY) || []; } catch (e) { recents = []; }
  recents = recents.filter((r) => r.setId !== state.setId);
  // done / total 一并存下：自定义练习没有对应的题库明细，首页构造「继续」卡片
  // 时无从另算，只能靠这里带过去
  let done = 0;
  Object.keys(state.records || {}).forEach((k) => {
    const r = state.records[k];
    if (r && (r.answered || r.manual)) done++;
  });
  recents.unshift({
    setId: state.setId,
    title: state.title,
    mode: state.mode,
    custom: !!state.custom,
    total: state.total || 0,
    done,
    progress: state.total ? Math.min(100, Math.round(((state.idx) / state.total) * 100)) : 0,
    finished: !!state.finished,
    updatedAt: Date.now()
  });
  recents = recents.slice(0, 10);
  safe.write(RECENTS_KEY, recents, { label: '最近练习' });
}

function listRecents() {
  try { return wx.getStorageSync(RECENTS_KEY) || []; } catch (e) { return []; }
}

function removeState(setId) {
  safe.remove(stateKey(setId));
  const recents = listRecents().filter((r) => r.setId !== setId);
  safe.write(RECENTS_KEY, recents, { label: '最近练习' });
}

// 新建会话
function createState(setId, title, mode, orderNos) {
  const state = {
    setId,
    title,
    mode,
    order: orderNos || [],
    idx: 0,
    total: (orderNos || []).length,
    records: {},
    wrongs: [],
    elapsedMs: 0,
    lastTickAt: Date.now(),
    startedAt: Date.now(),
    finished: false
  };
  saveState(state);
  return state;
}

// ---------------- 跨题库题项的身份 ----------------
//
// 普通会话里题号在本库内唯一，直接用题号当键就够了（历史进度也是这么存的，
// 不做迁移）。自定义练习的题目来自多个题库，题号会撞车（每本书都从 1 开始），
// 所以用「题库 + 题号」拼成的 uid 当键：sid::no。
function itemUid(setId, no) {
  return `${setId}::${no}`;
}

function parseUid(uid) {
  const s = String(uid == null ? '' : uid);
  const i = s.indexOf('::');
  if (i < 0) return { sid: '', no: s };
  return { sid: s.slice(0, i), no: s.slice(i + 2) };
}

// 新建自定义练习会话：题目清单由计划带来（跨题库），records 按 uid 记
function createCustomState(plan) {
  const items = (plan && plan.items) || [];
  const state = {
    setId: CUSTOM_SCOPE,
    custom: true,
    title: (plan && plan.title) || '自定义练习',
    scope: (plan && plan.scope) || '',
    mode: 'custom',
    order: items.map((it) => itemUid(it.sid, it.no)),
    items: items.map((it) => ({ sid: it.sid, no: String(it.no) })),
    idx: 0,
    total: items.length,
    records: {},
    wrongs: [],
    elapsedMs: 0,
    lastTickAt: Date.now(),
    startedAt: Date.now(),
    finished: false
  };
  saveState(state);
  return state;
}

// 由 records 重新统计错题
function recomputeWrongs(state) {
  const wrongs = [];
  Object.keys(state.records || {}).forEach((no) => {
    const r = state.records[no];
    const isWrong = (r && r.answered && r.correct === false) || (r && r.manual === 'wrong');
    if (isWrong && wrongs.indexOf(no) < 0) wrongs.push(no);
  });
  state.wrongs = wrongs;
  return state;
}

module.exports = {
  stateKey,
  CUSTOM_SCOPE,
  getState,
  saveState,
  listRecents,
  removeState,
  createState,
  createCustomState,
  itemUid,
  parseUid,
  recomputeWrongs,
  tick,
  skipIdle,
  elapsedOf,
  MODE_LABEL
};
