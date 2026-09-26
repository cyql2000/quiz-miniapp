// 校对 / 勘误 · 跨会话持久化
// 刷题时发现题目、答案、解析有问题，随手记下来，回头对照着改源文件。
// 每个题库一份：qz_er_{setId}
//
// item 结构：
// {
//   no: 12,
//   types: ['answer'],                       // 问题类型（可多选）
//   original: { stem, options, answer, explanation },   // 发现时的原值快照
//   fix: { stem, options, answer, explanation, note },  // 我填的修正值
//   note: '',                                // 备注（兼容旧字段）
//   status: 'open' | 'fixed',
//   createdAt, updatedAt
// }
const PREFIX = 'qz_er_';

// 本机（答题页）改得动的只有答案与解析：题干、选项、缺图、重复错位都得回源文件改。
// 「补答案算不算把这题修完了」以这个集合为准（见 utils/answers.js）。
// 校对面板不走这条：那边以「有没有写下改动后的正确内容」为准（见组件里的 hasChange 判定）。
const LOCAL_FIXABLE = { answer: 1, explanation: 1 };

const TYPES = [
  { key: 'stem', label: '题干有误', field: 'stem' },
  { key: 'options', label: '选项有误', field: 'options' },
  { key: 'answer', label: '答案有误', field: 'answer' },
  { key: 'explanation', label: '解析有误', field: 'explanation' },
  { key: 'image', label: '缺图/图题', field: null },
  { key: 'duplicate', label: '重复/错位', field: null },
  { key: 'other', label: '其他问题', field: null }
];
const TYPE_MAP = {};
TYPES.forEach((t) => { TYPE_MAP[t.key] = t; });

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

// 同 wrongbook：写失败不再静默吞掉，交给页面统一提示
function saveBook(book) {
  if (!book || !book.setId) return book;
  book.updatedAt = now();
  safe.write(bookKey(book.setId), book, {
    label: '校对记录',
    message: '本机存储空间已满，校对记录未能保存。请到「文件库」删除不再需要的题库后重试。'
  });
  return book;
}

function removeBook(setId) {
  try { wx.removeStorageSync(bookKey(setId)); } catch (e) { /* ignore */ }
}

// 扫描本地存储列出所有校对本（无需维护额外索引）
function listBooks() {
  let keys = [];
  try { keys = (wx.getStorageInfoSync() || {}).keys || []; } catch (e) { return []; }
  const books = [];
  keys.forEach((k) => {
    if (k.indexOf(PREFIX) !== 0) return;
    try {
      const b = wx.getStorageSync(k);
      if (b && b.setId && b.items && Object.keys(b.items).length) books.push(b);
    } catch (e) { /* ignore */ }
  });
  books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return books;
}

// ---------- 展示辅助 ----------
function typeLabels(types) {
  return (types || []).map((k) => (TYPE_MAP[k] ? TYPE_MAP[k].label : k));
}

// 把选项数组还原成一行文本，便于比对与复制
function optionsToText(options) {
  if (!options || !options.length) return '';
  return options.map((o) => `${o.key}. ${o.text}`).join('\n');
}

// 原值 → 修正值 是否有实际改动
function hasChange(item) {
  if (!item) return false;
  const o = item.original || {};
  const f = item.fix || {};
  return ['stem', 'options', 'answer', 'explanation'].some((k) => f[k] && String(f[k]).trim() !== String(o[k] || '').trim());
}

// 单条读取（补答案时要判断「这题原来记过什么问题」）
function getItem(setId, no) {
  const book = getBook(setId);
  return (book.items || {})[String(no)] || null;
}

// 这条记录当前的「原值」快照：已有记录用记录里的，没有就用题目本身的值
// （取法与 upsert 首次写入完全一致，否则 hasChange 比对会失真）
function originalOf(setId, question) {
  const old = question ? getItem(setId, question.no) : null;
  if (old && old.original) return old.original;
  const q = question || {};
  return {
    stem: q.stem || '',
    options: optionsToText(q.options),
    answer: q.answerKey || q.answer || '',
    explanation: q.explanation || ''
  };
}

function isPending(item) {
  return !!item && item.status !== 'fixed';
}

function decorate(item) {
  return Object.assign({}, item, {
    typeLabels: typeLabels(item.types),
    changed: hasChange(item),
    pending: isPending(item)
  });
}

function sortItems(list) {
  return list.slice().sort((a, b) => {
    const p = (isPending(b) ? 1 : 0) - (isPending(a) ? 1 : 0);
    if (p) return p;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

// filter: 'open' | 'fixed' | 'all'
function listItems(setId, filter) {
  const book = getBook(setId);
  const all = Object.keys(book.items).map((k) => book.items[k]);
  let list;
  if (filter === 'fixed') list = all.filter((i) => i.status === 'fixed');
  else if (filter === 'all') list = all;
  else list = all.filter(isPending);
  return sortItems(list).map(decorate);
}

function statsOf(book) {
  const all = Object.keys((book && book.items) || {}).map((k) => book.items[k]);
  return {
    total: all.length,
    open: all.filter(isPending).length,
    fixed: all.filter((i) => i.status === 'fixed').length
  };
}

function stats(setId) {
  return statsOf(getBook(setId));
}

function summary() {
  const books = listBooks();
  const sum = { sets: 0, total: 0, open: 0, fixed: 0 };
  books.forEach((b) => {
    const s = statsOf(b);
    if (!s.total) return;
    sum.sets += 1;
    sum.total += s.total;
    sum.open += s.open;
    sum.fixed += s.fixed;
  });
  return sum;
}

// ---------- 写入 ----------
// question: { no, stem, options, answerKey, answer, explanation }
// patch:    { types, fix: {...} }
function upsert(setId, question, patch) {
  if (!setId || !question) return null;
  const no = String(question.no);
  const book = getBook(setId);
  if (patch && patch.title) book.title = patch.title;
  const p = patch || {};
  const old = book.items[no];
  const item = old || {
    no,
    types: [],
    original: {
      stem: question.stem || '',
      options: optionsToText(question.options),
      answer: question.answerKey || question.answer || '',
      explanation: question.explanation || ''
    },
    fix: { stem: '', options: '', answer: '', explanation: '', note: '' },
    status: 'open',
    createdAt: now(),
    updatedAt: now()
  };
  if (p.types && p.types.length) item.types = p.types.slice();
  if (p.fix) item.fix = Object.assign({ stem: '', options: '', answer: '', explanation: '', note: '' }, item.fix, p.fix);
  if (p.status) item.status = p.status;
  item.updatedAt = now();
  book.items[no] = item;
  saveBook(book);
  return decorate(item);
}

function setStatus(setId, no, status) {
  const book = getBook(setId);
  const item = book.items[String(no)];
  if (!item) return null;
  item.status = status;
  item.updatedAt = now();
  saveBook(book);
  return decorate(item);
}

function removeItem(setId, no) {
  const book = getBook(setId);
  delete book.items[String(no)];
  if (Object.keys(book.items).length) saveBook(book);
  else removeBook(setId);
  return statsOf(book);
}

function clearBook(setId) {
  removeBook(setId);
}

// ---------- 导出：给源文件用的参照文本 ----------
function exportText(setId) {
  const book = getBook(setId);
  const items = sortItems(Object.keys(book.items).map((k) => book.items[k]));
  if (!items.length) return '';
  const lines = [];
  lines.push(`# 校对清单 · ${book.title || setId}（共 ${items.length} 条，待修 ${statsOf(book).open} 条）`);
  lines.push('');
  items.forEach((it) => {
    const o = it.original || {};
    const f = it.fix || {};
    const tags = typeLabels(it.types).join(' / ') || '未分类';
    lines.push(`【题号 ${it.no}】${tags}${it.status === 'fixed' ? '（已修）' : ''}`);
    if (f.stem && f.stem.trim() !== (o.stem || '').trim()) {
      lines.push(`  题干 原：${(o.stem || '').replace(/\n/g, ' ')}`);
      lines.push(`  题干 改：${f.stem.replace(/\n/g, ' ')}`);
    }
    if (f.options && f.options.trim() !== (o.options || '').trim()) {
      lines.push(`  选项 原：${(o.options || '').replace(/\n/g, ' ')}`);
      lines.push(`  选项 改：${f.options.replace(/\n/g, ' ')}`);
    }
    if (f.answer && f.answer.trim() !== (o.answer || '').trim()) {
      lines.push(`  答案 原：${o.answer || ''}`);
      lines.push(`  答案 改：${f.answer}`);
    }
    if (f.explanation && f.explanation.trim() !== (o.explanation || '').trim()) {
      lines.push(`  解析 原：${(o.explanation || '').replace(/\n/g, ' ')}`);
      lines.push(`  解析 改：${f.explanation.replace(/\n/g, ' ')}`);
    }
    if (f.note) lines.push(`  备注：${f.note.replace(/\n/g, ' ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

module.exports = {
  PREFIX,
  TYPES,
  TYPE_MAP,
  LOCAL_FIXABLE,
  bookKey,
  getBook,
  getItem,
  originalOf,
  saveBook,
  removeBook,
  clearBook,
  listBooks,
  listItems,
  stats,
  statsOf,
  summary,
  upsert,
  setStatus,
  removeItem,
  exportText,
  optionsToText,
  typeLabels,
  hasChange,
  isPending
};
