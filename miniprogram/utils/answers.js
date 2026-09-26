// ============================================================
// 题目修正 · 把「我改好的那份」写回题库明细
//
// 为什么直接写回题库明细（q_sets/{setId}.json），而不是另做一层覆盖表：
//   答题判分、整卷回顾、错题本快照、AI 原子接口读的都是题库明细。
//   覆盖表意味着每个读取点都要记得「先套一层」，漏一个地方就出现
//   「答题时判对了、回顾时还是错的」这种前后不一致。写回明细是单点改动，
//   与既有实现天然一致；导出备份时也随题库明细一起带走，不需要额外适配。
//
// 谁在用：
//   applyFix   —— 底层，「把这几项写进题库明细」。补答案面板与校对面板都走它。
//   saveAnswer —— 补答案面板：applyFix + 记一条校对记录（源文件还是错的）
//
// 两个面板都能改题干/选项/答案/解析了 —— 记了清单却不改题库，
// 练习页看到的还是旧内容，等于白记（用户 2026-09-24 报的就是这个）。
// 区别只剩「要不要顺带记进校对清单」：补答案记，校对面板自己记。
// ============================================================

const db = require('./localdb');
const errata = require('./errata');
const wrongbook = require('./wrongbook');

const LETTERS = 'ABCDEFGH';

function findQuestion(questions, no) {
  const key = String(no);
  return (questions || []).filter((q) => String(q.no) === key)[0] || null;
}

function normKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-H]/g, '').split('').sort().join('');
}

// 「A. 甲 / B. 乙」→ [{ key:'A', text:'甲' }]。
// 校对面板里选项是一个文本框（errata.optionsToText 的格式），写回题库必须还原成数组。
// 规则：首行带字母前缀 → 按字母解析（没带字母的行算上一项换行续写）；
//       整段都没字母 → 一行一个，按顺序补 A/B/C…
function optionsFromText(text) {
  const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n')
    .map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return [];
  const HEAD = /^([A-Ha-h])\s*[.、．)）:：]\s*/;
  if (!HEAD.test(lines[0])) {
    return lines.map((t, i) => ({ key: LETTERS[i] || String(i + 1), text: t }));
  }
  const out = [];
  lines.forEach((l) => {
    const m = l.match(HEAD);
    if (!m) {
      if (out.length) out[out.length - 1].text = `${out[out.length - 1].text} ${l}`.trim();
      return;
    }
    const key = m[1].toUpperCase();
    const body = l.slice(m[0].length).trim();
    const last = out[out.length - 1];
    if (last && last.key === key) {          // 同一选项写了多行
      last.text = `${last.text} ${body}`.trim();
      return;
    }
    out.push({ key, text: body });
  });
  return out;
}

// 这次修正动了哪些方面 —— 用于给校对清单打问题类型
function changedTypes(before, after) {
  const types = [];
  if (before.stem !== after.stem) types.push('stem');
  if (before.options !== after.options) types.push('options');
  if (before.answerKey !== after.answerKey || before.answer !== after.answer) types.push('answer');
  if (before.explanation !== after.explanation) types.push('explanation');
  return types.length ? types : ['other'];
}

// 本机改得动的只有答案与解析（定义在 errata，与纠错面板共用一份）
const LOCAL_FIXABLE = errata.LOCAL_FIXABLE;

// 把修正后的内容写回题库明细，并同步错题本里的旧快照。
// patch: { stem?, options?（文本或数组）, answerKey?, answer?, explanation? }
// 返回 { before, after, question, changed }：before/after 是文本态，给面板做前后对比。
// 一项都没传 → 直接返回，不写盘（避免无谓的写与 answerFixedAt 变动）。
function applyFix(setId, no, patch) {
  const bundle = db.loadSetBundle(setId);
  if (!bundle) throw new Error('题库不存在或已删除');
  const q = findQuestion(bundle.questions, no);
  if (!q) throw new Error(`题库中找不到第 ${no} 题`);

  const p = patch || {};
  const textOf = (x) => ({
    stem: x.stem || '',
    options: errata.optionsToText(x.options),
    answerKey: x.answerKey || '',
    answer: x.answer || '',
    explanation: x.explanation || ''
  });
  const before = textOf(q);

  const touched = ['stem', 'options', 'answerKey', 'answer', 'explanation'].some((k) => p[k] != null);
  // 什么都没传：不写盘，也不算"落盘失败"（persisted 只描述"盘上与期望是否一致"）
  if (!touched) return { before, after: before, question: q, latest: q, persisted: true, changed: false };

  const next = Object.assign({}, q);
  if (p.stem != null) next.stem = String(p.stem || '');
  if (p.options != null) {
    const opts = Array.isArray(p.options) ? p.options : optionsFromText(p.options);
    if (opts.length) next.options = opts;
  }
  if (p.answerKey != null) {
    const raw = String(p.answerKey || '').trim();
    const key = normKey(raw);
    if (!raw) {
      // 清空答案字段 = 这题不该有标准答案（原本判错的撤掉）
      next.answerKey = '';
      next.answer = '';
    } else if (key) {
      next.answerKey = key;
      // 答案文本跟着答案键走，判断题的「正确 / 错误」也在这里统一
      next.answer = raw;
    } else {
      // 写成了一句说明（不是选项字母）→ 只当参考答案，答案键留给用户自己决定
      next.answer = raw;
    }
  }
  if (p.answer != null) next.answer = String(p.answer || '');
  if (p.explanation != null) next.explanation = String(p.explanation || '');

  if (next.answerKey) {
    next.matched = true;
    // 有了答案键就可以自动判分，题型要跟着答案走。
    // 判断题保持 judge（它的 A/B 是"正确/错误"，不能简化成单选）；
    // 主观题没有选项，补了键也不参与自动判分，因此不动它的 type。
    if (next.type === 'single' || next.type === 'multi') {
      next.type = next.answerKey.length > 1 ? 'multi' : 'single';
    }
  } else if (next.answer || next.explanation) {
    // 只补了参考答案文本：算「已提供参考答案」，但仍需自评
    next.matched = true;
  }

  // 「答案用不上」这个标记必须跟着修好的内容走：用户已经人工核对过了，
  // 再挂着"标准答案对不上选项，请核对"就是误导（题目卡上会一直显示这段话）。
  if (p.options != null || p.answerKey != null || p.answer != null) {
    const keys = String(next.answerKey || '').split('').filter(Boolean);
    const usable = keys.length && keys.every((c) => (next.options || []).some((o) => o.key === c));
    next.answerSuspect = !!keys.length && !usable;
    next.answerSuspectKind = usable || !keys.length ? '' : 'missingOption';
  }
  next.answerFixedAt = Date.now();

  const questions = (bundle.questions || []).map((it) => (String(it.no) === String(no) ? next : it));
  const meta = Object.assign({}, bundle.set || {}, {
    setId,
    matchedCount: questions.filter((it) => it.matched).length
  });
  db.saveSetBundle(meta, questions);

  const after = textOf(next);

  // 落盘后读回来再核一遍。题库明细是沙箱里的大文件，真机上写入被截断 / 写到别处
  // 都出现过；当场发现比等用户刷题时看到旧内容好（那时已经不知道是哪一步坏的）。
  // latest 也顺便当"以盘上那份为准"的返回值给页面刷新用。
  const back = findQuestion((db.loadSetBundle(setId) || {}).questions || [], no);
  const persisted = !!back
    && (p.stem == null || back.stem === next.stem)
    && (p.options == null || JSON.stringify(back.options || []) === JSON.stringify(next.options || []))
    && (p.answerKey == null || back.answerKey === next.answerKey)
    && (p.answer == null || back.answer === next.answer)
    && (p.explanation == null || back.explanation === next.explanation);

  // 错题本里若已有这题的快照，一并更新，否则回顾错题时仍是旧题目
  const wb = wrongbook.getBook(setId);
  const item = (wb.items || {})[String(no)];
  if (item) {
    item.stem = after.stem;
    if (p.options != null && next.options) item.options = next.options;
    if (after.answerKey) item.answerKey = after.answerKey;
    if (after.answer) item.answer = after.answer;
    if (after.explanation) item.explanation = after.explanation;
    if (after.answerKey) item.type = next.type;
    wrongbook.saveBook(wb);
  }

  return {
    before,
    after,
    question: next,
    latest: back || next,
    persisted,
    changed: before.answerKey !== after.answerKey
      || before.answer !== after.answer || before.explanation !== after.explanation
      || before.stem !== after.stem || before.options !== after.options
  };
}

// 补答案面板专用：写回题库明细 + 记一条校对记录。
// patch: { answerKey?, answer?, explanation? }（面板只改这两项，但底层接口是通用的）
function saveAnswer(setId, no, patch) {
  const r = applyFix(setId, no, patch);
  const next = r.question;
  const before = r.before;
  const after = r.after;

  // 记进校对清单：源文件还是错的，回去改的时候需要这份对照。
  // 两条规则：
  //   ① 问题类型不覆盖 —— 用户在答题页勾过「题干有误 / 缺图」，不能被一次补答案抹成「答案有误」；
  //   ② 状态跟着「修没修完」走 —— 问题全在答案/解析上的，补完即归「已修」，
  //      不再挂在待修里让人以为还没处理；还牵扯题干/选项/图题的，继续留在待修。
  try {
    const q0 = r.question;   // 修正后的题目（题干/选项以题库现状为准）
    const prev = errata.getItem(setId, no);
    const prevTypes = (prev && prev.types) || [];
    const types = prevTypes.length ? prevTypes : changedTypes(before, after);
    const solved = types.every((t) => LOCAL_FIXABLE[t]);
    const meta = db.getSetMeta(setId) || {};
    errata.upsert(setId, {
      no: q0.no,
      stem: q0.stem || '',
      options: q0.options || [],
      answerKey: before.answerKey,
      answer: before.answer,
      explanation: before.explanation
    }, {
      types,
      fix: {
        answer: after.answerKey || after.answer || '',
        explanation: after.explanation || '',
        note: '答题页现场补录'
      },
      // 解决不了的不动状态：原本手动标过「已修」的，不能被一次补答案退回待修
      status: solved ? 'fixed' : undefined,
      title: meta.title || ''
    });
  } catch (e) {
    // 校对清单写不进去不该让修正本身失败（修正已落库），交给页面的存储提示
    console.error('[answers] 写入校对清单失败', e);
  }

  return { before, after, question: next, latest: r.latest, persisted: r.persisted };
}

// 当前题库还有多少题没有答案（用于提示「还有 N 题可补」）
function missingStats(setId) {
  const bundle = db.loadSetBundle(setId);
  const questions = (bundle && bundle.questions) || [];
  const noKey = questions.filter((q) => !q.answerKey).length;
  const noExpl = questions.filter((q) => !q.explanation).length;
  return { total: questions.length, noKey, noExpl };
}

module.exports = { applyFix, saveAnswer, missingStats, normKey, optionsFromText };
