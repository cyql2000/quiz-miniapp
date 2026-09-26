// ============================================================
// 自定义练习 —— 范围筛选 · 数量设定 · 随机抽取
//
// 为什么要有这一层：题库是按章节分卷存的（一本书会拆成多个 setId），
// 所以「按章节挑题来练」天然是跨题库的 —— 需要把多个题库的题目聚成一个
// 可统计、可筛选、可抽样的候选池，而不是逐库各练一遍。
//
// 三个维度都建立在真实数据上，不做推测：
//   章节 —— 哪些 setId 参与（可按整本书勾选）
//   题型 —— single / multi / judge / text（题目自带字段）
//   状态 —— 全部 / 曾做错过（错题本）/ 已标记（标记清单）
//
// 「随机抽取」与「随机顺序」由同一次洗牌完成：对候选池做 Fisher-Yates
// 洗牌后取前 N 条 —— 既是均匀随机抽样，又天然是随机顺序。不需要
// 「先抽再排」两步，也不会出现「题目抽得随机、顺序却仍是题库原序」这种半随机结果。
// ============================================================

const db = require('./localdb');
const wrongbook = require('./wrongbook');
const marks = require('./marks');
const safe = require('./safestore');

// 单次抽取的题量预设（自定义输入也支持）
const PRESETS = [10, 20, 30, 50];
const DEFAULT_COUNT = 20;

const TYPES = ['single', 'multi', 'judge', 'text'];
const TYPE_LABEL = { single: '单选题', multi: '多选题', judge: '判断题', text: '问答题' };

const STATES = [
  { key: 'any', label: '全部题目' },
  { key: 'wrong', label: '曾做错过' },
  { key: 'marked', label: '已标记' }
];

// 本次抽题计划的暂存键（custom 页 → 答题页，只活一次）
const PLAN_KEY = 'qz_custom_plan';

// ---------------- 题库 / 章节 ----------------

function stripExt(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

// 题库归属的「书」：优先用源文件名，退回标题里「 · 」前的部分。
// 一本行测书会拆成几十个分卷，按书分组后章节列表才找得到。
function bookOf(meta) {
  const f = meta && meta.questionFile;
  if (f && f.name) return stripExt(f.name);
  const t = String((meta && meta.title) || '');
  const i = t.indexOf(' · ');
  return i > 0 ? t.slice(0, i) : (t || '未命名');
}

function chapterOf(meta) {
  const t = String((meta && meta.title) || '');
  const i = t.indexOf(' · ');
  return i >= 0 ? t.slice(i + 3) : t;
}

function chapters() {
  return db.listSets().map((m) => ({
    setId: m.setId,
    title: m.title || '未命名题库',
    book: bookOf(m),
    chapter: chapterOf(m),
    count: m.questionCount || 0
  }));
}

// 章节顺序：按生成顺序（setId 里的时间戳 + 分卷序号），而不是沿用题库索引的
// 「最近生成在前」。否则同一本书的章节会倒着排，「第二章」跑到「第一章」前面。
// 序号必须按数字比 —— 字符串比较会把 local_1_10 排到 local_1_2 前面。
function chapterRank(setId) {
  const m = /^local_(\d+)_(\d+)$/.exec(String(setId));
  return m ? { t: Number(m[1]), i: Number(m[2]) } : null;
}

function compareChapter(a, b) {
  const ra = chapterRank(a.setId);
  const rb = chapterRank(b.setId);
  if (ra && rb) return (ra.t - rb.t) || (ra.i - rb.i);
  const sa = String(a.setId);
  const sb = String(b.setId);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// 按书分组，供选择器展示
function groupedChapters() {
  const map = {};
  const order = [];
  chapters().forEach((c) => {
    if (!map[c.book]) { map[c.book] = { book: c.book, chapters: [], count: 0 }; order.push(c.book); }
    map[c.book].chapters.push(c);
    map[c.book].count += c.count;
  });
  return order.map((b) => {
    map[b].chapters.sort(compareChapter);
    return map[b];
  });
}

// ---------------- 题目精简索引 ----------------
//
// 只留「题号 + 题型」：统计与抽样不需要题干与解析，
// 一本 1000 题的题库解析后有几 MB，整本留在内存里没有必要。
// 索引单独缓存，题库增删（setId 变）或题量变化时自动重建。
let idx = null;
let idxStamp = '';

// 题库指纹：集合或题量变了就说明缓存过期
function fingerprint() {
  return db.listSets().map((s) => `${s.setId}:${s.questionCount || 0}`).join(',');
}

function clearIndex() {
  idx = null;
  idxStamp = '';
}

function ensureIndex() {
  const stamp = fingerprint();
  if (idx && idxStamp === stamp) return idx;

  const next = {};
  db.listSets().forEach((m) => {
    const b = db.loadSetBundle(m.setId);
    const qs = (b && b.questions) || [];
    next[m.setId] = qs.map((q) => ({ no: String(q.no), type: q.type || 'single' }));
  });
  idx = next;
  idxStamp = stamp;
  return idx;
}

// ---------------- 状态维度 ----------------
// 「曾做错过」直接取错题本的题号：错题本只收录答错过的题（含已掌握的），语义准确。
// 不用「最近一次会话」推断「未做过」—— 那份记录只覆盖上一次练习，
// 拿它当「做没做过」会误导。
function wrongNosOf(setId) {
  const b = wrongbook.getBook(setId);
  return Object.keys((b && b.items) || {});
}

function markedNosOf(setId) {
  const b = marks.getBook(setId);
  return (b && b.nos) || [];
}

function toSet(list) {
  const s = {};
  (list || []).forEach((k) => { s[String(k)] = 1; });
  return s;
}

// ---------------- 候选池统计 ----------------
//
// opts: { setIds: [], types: [], state: 'any' }
//   空数组 = 不限制该维度
//
// 返回：
//   total   —— 章节范围内的题目总数
//   byType  —— 各题型数量（已叠加状态条件，未叠加题型条件）
//   byState —— 各状态数量（已叠加题型条件，未叠加状态条件）
//   pool    —— 三个条件全部叠加后的候选题（用于抽取）
//
// byType / byState 各自只排除「自己这一维」，这样界面上每个选项旁边的
// 数量都是「如果选它会有多少」，而不是一个永远不变的基数。
function survey(opts) {
  const o = opts || {};
  const wantSets = (o.setIds && o.setIds.length) ? o.setIds : null;
  const wantTypes = (o.types && o.types.length) ? o.types : null;
  const wantState = o.state || 'any';
  const all = ensureIndex();

  const byType = { single: 0, multi: 0, judge: 0, text: 0 };
  const byState = { any: 0, wrong: 0, marked: 0 };
  const pool = [];
  let total = 0;

  chapters().forEach((c) => {
    if (wantSets && wantSets.indexOf(c.setId) < 0) return;
    const list = all[c.setId] || [];
    if (!list.length) return;
    const wset = toSet(wrongNosOf(c.setId));
    const mset = toSet(markedNosOf(c.setId));

    list.forEach((it) => {
      const isWrong = !!wset[it.no];
      const isMarked = !!mset[it.no];
      total++;

      const okType = !wantTypes || wantTypes.indexOf(it.type) >= 0;
      const okState = wantState === 'any'
        || (wantState === 'wrong' ? isWrong : isMarked);

      if (okState) {
        if (byType[it.type] == null) byType[it.type] = 0;
        byType[it.type]++;
      }
      if (okType) {
        byState.any++;
        if (isWrong) byState.wrong++;
        if (isMarked) byState.marked++;
      }
      if (okType && okState) pool.push({ sid: c.setId, no: it.no, type: it.type });
    });
  });

  return { total, byType, byState, pool };
}

// ---------------- 抽取 ----------------
//
// 洗牌后取前 count 条。count 非法或大于池子时取全部（顺序同样已打乱）。
// rng 可注入，便于测试里用确定性序列验证「抽取是随机的、且真的换顺序」。
function draw(pool, count, rng) {
  const rand = rng || Math.random;
  const a = (pool || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  let n = Math.floor(Number(count));
  if (!isFinite(n) || n <= 0) n = a.length;
  if (n > a.length) n = a.length;
  return a.slice(0, n);
}

// ---------------- 计划 ----------------

// 人话描述当前范围，界面与会话标题都用它
function describe(opts) {
  const o = opts || {};
  const all = chapters().length;
  const picked = (o.setIds || []).length;
  const parts = [];
  parts.push((!picked || picked === all) ? '全部章节' : `${picked}/${all} 个章节`);
  const ts = o.types || [];
  parts.push(ts.length ? ts.map((t) => TYPE_LABEL[t] || t).join('/') : '全部题型');
  const st = STATES.filter((s) => s.key === (o.state || 'any'))[0];
  parts.push(st ? st.label : '全部题目');
  return parts.join(' · ');
}

// 生成计划：抽题 + 打乱顺序，并记录范围描述
function buildPlan(opts, count, rng) {
  const s = survey(opts);
  if (!s.pool.length) throw new Error('当前范围内没有符合条件的题目');
  const picked = draw(s.pool, count, rng);
  const scope = describe(opts);
  return {
    items: picked.map((it) => ({ sid: it.sid, no: it.no })),
    scope,
    count: picked.length,
    title: `自定义练习 · ${picked.length} 题`,
    at: Date.now()
  };
}

// 计划要先落一次 storage 再跳页：几十上百题没法塞进 URL。
// 写不进去就必须让调用方停下来（否则跳过去是个空练习），所以用 writeOrThrow。
function stash(plan) {
  safe.writeOrThrow(
    PLAN_KEY,
    plan,
    '本机存储空间已满，本次练习设置未能保存。请到「文件库」删除不再需要的题库后重试。'
  );
  return plan;
}

// 取用即删除：计划只活一次，避免「上次的设置」被静默复用
function takePlan() {
  let p = '';
  try { p = wx.getStorageSync(PLAN_KEY) || ''; } catch (e) { p = ''; }
  safe.remove(PLAN_KEY);
  return (p && p.items && p.items.length) ? p : null;
}

module.exports = {
  PRESETS,
  DEFAULT_COUNT,
  TYPES,
  TYPE_LABEL,
  STATES,
  PLAN_KEY,
  chapters,
  groupedChapters,
  bookOf,
  chapterOf,
  survey,
  draw,
  describe,
  buildPlan,
  stash,
  takePlan,
  fingerprint,
  ensureIndex,
  clearIndex
};
