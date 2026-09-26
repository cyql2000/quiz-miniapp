// 错题本 · 跨会话持久化
// 每个题库一份：qz_wb_{setId}
// item 结构：
// {
//   no, stem, type, options, answer, answerKey, explanation,   // 题干快照（题库被删也能回顾）
//   wrongCount, rightCount, attempts,                          // 累计统计
//   streak,                                                    // 连续答对次数
//   mastered,                                                  // 是否已掌握
//   firstAt, lastAt, lastWrongAt, lastSelected, lastMode
// }
const PREFIX = 'qz_wb_';
const MASTER_STREAK = 2; // 连续答对达到该次数即视为已掌握

const safe = require('./safestore');

const bookKey = (setId) => PREFIX + setId;
const now = () => Date.now();

function emptyBook(setId, title) {
  return { setId, title: title || '', items: {}, updatedAt: now() };
}

function getBook(setId) {
  if (!setId) return emptyBook('', '');
  try {
    const b = wx.getStorageSync(bookKey(setId));
    if (b && b.setId && b.items) return b;
  } catch (e) { /* ignore */ }
  return emptyBook(setId, '');
}

// 写失败不再静默吞掉：记进 safestore 的待提示错误，由答题页取走后弹一次窗。
// 原先的 `catch (e) { /* ignore */ }` 会让用户以为错题在积累，实际一直在丢。
function saveBook(book) {
  if (!book || !book.setId) return book;
  book.updatedAt = now();
  safe.write(bookKey(book.setId), book, {
    label: '错题本',
    message: '本机存储空间已满，错题记录未能保存。请到「文件库」删除不再需要的题库后重试。'
  });
  return book;
}

// 扫描本地存储，列出所有错题本（无需额外维护索引，避免不一致）
// 空错题本（items 为空）不返回，并顺手清理其存储键
function listBooks() {
  let keys = [];
  try { keys = (wx.getStorageInfoSync() || {}).keys || []; } catch (e) { return []; }
  const books = [];
  keys.forEach((k) => {
    if (k.indexOf(PREFIX) !== 0) return;
    try {
      const b = wx.getStorageSync(k);
      if (!b || !b.setId || !b.items) return;
      if (!Object.keys(b.items).length) {
        wx.removeStorageSync(k);
        return;
      }
      books.push(b);
    } catch (e) { /* ignore */ }
  });
  books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return books;
}

function removeBook(setId) {
  try { wx.removeStorageSync(bookKey(setId)); } catch (e) { /* ignore */ }
}

// ---------- 判定 ----------
function errorRate(item) {
  const a = (item && item.attempts) || 0;
  return a ? (item.wrongCount || 0) / a : 0;
}

// 待攻克：在错题本里且尚未掌握
function isPending(item) {
  return !!item && !item.mastered;
}

// 易错题：错过 2 次及以上；或错过 1 次但反复尝试仍未掌握（尝试 ≥3 且错率 ≥60%）
function isHard(item) {
  if (!isPending(item)) return false;
  const w = item.wrongCount || 0;
  if (w >= 2) return true;
  const a = item.attempts || 0;
  return w >= 1 && a >= 3 && errorRate(item) >= 0.6;
}

// 排序：错误次数降序 → 最近答错时间降序 → 题号升序
// 最后一级平局兜底是必要的：前两级都相同时（同一毫秒内连续作答很常见），
// 若不兜底，列表顺序会随作答时的毫秒数变化而抖动 —— 用户反复刷同一批题时，
// 看到的两道「同样错 1 次」的题会莫名其妙地换位置。
function sortItems(list) {
  return list.slice().sort((a, b) => {
    const d = (b.wrongCount || 0) - (a.wrongCount || 0);
    if (d) return d;
    const t = (b.lastWrongAt || 0) - (a.lastWrongAt || 0);
    if (t) return t;
    return (parseInt(a.no, 10) || 0) - (parseInt(b.no, 10) || 0);
  });
}

function decorate(item) {
  return Object.assign({}, item, {
    errRate: Math.round(errorRate(item) * 100),
    hard: isHard(item),
    pending: isPending(item)
  });
}

// filter: 'pending' | 'hard' | 'mastered' | 'all'
function listItems(setId, filter) {
  const book = getBook(setId);
  const all = Object.keys(book.items).map((k) => book.items[k]);
  let list;
  if (filter === 'hard') list = all.filter(isHard);
  else if (filter === 'mastered') list = all.filter((i) => i.mastered);
  else if (filter === 'all') list = all;
  else list = all.filter(isPending);
  return sortItems(list).map(decorate);
}

function statsOf(book) {
  const all = Object.keys((book && book.items) || {}).map((k) => book.items[k]);
  const pending = all.filter(isPending);
  return {
    total: all.length,
    pending: pending.length,
    hard: pending.filter(isHard).length,
    mastered: all.filter((i) => i.mastered).length
  };
}

function stats(setId) {
  return statsOf(getBook(setId));
}

// 全局合计（覆盖所有题库）
function summary() {
  const books = listBooks();
  const sum = { sets: 0, total: 0, pending: 0, hard: 0, mastered: 0 };
  books.forEach((b) => {
    const s = statsOf(b);
    if (!s.total) return;
    sum.sets += 1;
    sum.total += s.total;
    sum.pending += s.pending;
    sum.hard += s.hard;
    sum.mastered += s.mastered;
  });
  return sum;
}

// ---------- 写入 ----------
// 只有「已进错题本」的题才累计统计：第一次就答对的题不会污染错题本
// opt: { correct: true|false, selected, mode, title }
function recordAnswer(setId, q, opt) {
  if (!setId || !q) return null;
  const o = opt || {};
  if (o.correct !== true && o.correct !== false) return null;
  const no = String(q.no);

  const book = getBook(setId);
  if (o.title) book.title = o.title;
  let item = book.items[no];

  if (o.correct === true && !item) return null; // 一次就答对，不入错题本

  if (!item) {
    item = {
      no,
      stem: q.stem || '',
      type: q.type || 'single',
      options: q.options || [],
      answer: q.answer || '',
      answerKey: q.answerKey || '',
      explanation: q.explanation || '',
      wrongCount: 0,
      rightCount: 0,
      attempts: 0,
      streak: 0,
      mastered: false,
      firstAt: now(),
      lastAt: now(),
      lastWrongAt: 0,
      lastSelected: '',
      lastMode: ''
    };
  }

  // 题干快照保持最新
  if (q.stem) item.stem = q.stem;
  if (q.answer) item.answer = q.answer;
  if (q.answerKey) item.answerKey = q.answerKey;
  if (q.explanation) item.explanation = q.explanation;
  if (q.options && q.options.length) item.options = q.options;
  if (q.type) item.type = q.type;
  if (o.title) book.title = o.title;

  item.attempts = (item.attempts || 0) + 1;
  item.lastAt = now();
  item.lastMode = o.mode || '';
  if (o.selected != null) item.lastSelected = o.selected;

  if (o.correct === true) {
    item.rightCount = (item.rightCount || 0) + 1;
    item.streak = (item.streak || 0) + 1;
    if (item.streak >= MASTER_STREAK) item.mastered = true;
  } else {
    item.wrongCount = (item.wrongCount || 0) + 1;
    item.streak = 0;
    item.mastered = false;
    item.lastWrongAt = now();
  }

  book.items[no] = item;
  saveBook(book);
  return decorate(item);
}

function setMastered(setId, no, val) {
  const book = getBook(setId);
  const item = book.items[String(no)];
  if (!item) return null;
  item.mastered = !!val;
  if (val) item.streak = Math.max(item.streak || 0, MASTER_STREAK);
  else item.streak = 0;
  saveBook(book);
  return decorate(item);
}

// 移出错题本（彻底删除该题记录）
function removeItem(setId, no) {
  const book = getBook(setId);
  delete book.items[String(no)];
  saveBook(book);
  return statsOf(book);
}

function clearBook(setId) {
  removeBook(setId);
}

module.exports = {
  MASTER_STREAK,
  bookKey,
  getBook,
  saveBook,
  listBooks,
  removeBook,
  clearBook,
  listItems,
  stats,
  statsOf,
  summary,
  recordAnswer,
  setMastered,
  removeItem,
  isHard,
  isPending,
  errorRate
};
