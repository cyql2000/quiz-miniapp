// 标记题目 · 跨会话持久化
// 每个题库一份：qz_mk_{setId}
//
// 为什么独立成一层：标记原先只写在刷题会话的 state.marks 里，而会话每次开新的
// 就被覆盖，答题卡也不显示标记态 —— 结果是标了也找不回来。
// 改成按题库持久化后，「标记题重练」才有稳定的题源。
//
// book 结构：{ setId, title, nos: ['12', '37'], updatedAt }
const safe = require('./safestore');

const PREFIX = 'qz_mk_';
const bookKey = (setId) => PREFIX + setId;
const now = () => Date.now();

function emptyBook(setId, title) {
  return { setId, title: title || '', nos: [], updatedAt: now() };
}

function getBook(setId) {
  if (!setId) return emptyBook('', '');
  try {
    const b = wx.getStorageSync(bookKey(setId));
    if (b && b.setId && Array.isArray(b.nos)) return b;
  } catch (e) { /* ignore */ }
  return emptyBook(setId, '');
}

function saveBook(book) {
  if (!book || !book.setId) return book;
  book.updatedAt = now();
  // 空清单不占存储：直接删键，与错题本/校对本的处理一致
  if (!book.nos.length) {
    safe.remove(bookKey(book.setId));
    return book;
  }
  safe.write(bookKey(book.setId), book, { label: '标记题目' });
  return book;
}

function removeBook(setId) {
  safe.remove(bookKey(setId));
}

function clearBook(setId) {
  removeBook(setId);
}

// 题号按数值升序（题库题号是数字字符串，纯字符串排序会把 10 排到 2 前面）
function sortNos(nos) {
  return nos.slice().sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (isNaN(na) || isNaN(nb)) return String(a) < String(b) ? -1 : 1;
    if (na !== nb) return na - nb;
    return String(a) < String(b) ? -1 : 1;
  });
}

function list(setId) {
  return sortNos(getBook(setId).nos);
}

function count(setId) {
  return getBook(setId).nos.length;
}

function has(setId, no) {
  return getBook(setId).nos.indexOf(String(no)) >= 0;
}

// 标记 / 取消标记。返回 { marked, total } 便于页面直接提示
function toggle(setId, no, title) {
  if (!setId || no == null || no === '') return { marked: false, total: count(setId) };
  const book = getBook(setId);
  if (title) book.title = title;
  const key = String(no);
  const i = book.nos.indexOf(key);
  if (i >= 0) book.nos.splice(i, 1);
  else book.nos.push(key);
  saveBook(book);
  return { marked: i < 0, total: book.nos.length };
}

function remove(setId, no, title) {
  const book = getBook(setId);
  if (title) book.title = title;
  const key = String(no);
  const i = book.nos.indexOf(key);
  if (i < 0) return { marked: false, total: book.nos.length };
  book.nos.splice(i, 1);
  saveBook(book);
  return { marked: false, total: book.nos.length };
}

function listBooks() {
  let keys = [];
  try { keys = (wx.getStorageInfoSync() || {}).keys || []; } catch (e) { return []; }
  const books = [];
  keys.forEach((k) => {
    if (k.indexOf(PREFIX) !== 0) return;
    try {
      const b = wx.getStorageSync(k);
      if (!b || !b.setId || !Array.isArray(b.nos)) return;
      if (!b.nos.length) { safe.remove(k); return; }
      books.push(b);
    } catch (e) { /* ignore */ }
  });
  books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return books;
}

function summary() {
  const books = listBooks();
  const sum = { sets: 0, total: 0 };
  books.forEach((b) => {
    sum.sets += 1;
    sum.total += b.nos.length;
  });
  return sum;
}

// 旧数据迁移：把刷题会话里残留的 state.marks 并进持久化清单。
// 迁移后清空 state.marks，重复进入不会重复搬。
function migrateFromState(setId, state) {
  if (!setId || !state || !Array.isArray(state.marks) || !state.marks.length) return 0;
  const book = getBook(setId);
  if (state.title) book.title = state.title;
  let added = 0;
  state.marks.forEach((no) => {
    const key = String(no);
    if (book.nos.indexOf(key) < 0) { book.nos.push(key); added++; }
  });
  state.marks = [];
  saveBook(book);
  return added;
}

module.exports = {
  PREFIX,
  bookKey,
  getBook,
  saveBook,
  removeBook,
  clearBook,
  list,
  count,
  has,
  toggle,
  remove,
  listBooks,
  summary,
  sortNos,
  migrateFromState
};
