// apis/createPracticePlan.js —— 出一组题去练
//
// 两条路径，都对应主包现成入口：
//   1) 错题 / 易错题 / 标记题 → 复刻 pages/custom/custom.js 的 start()：
//      抽 count 题 → 写 qz_custom_plan（结构逐字对齐 utils/custom.js buildPlan()）
//      → handoff 到答题页的 custom 模式（progress.CUSTOM_SCOPE）
//   2) 指定题库整库随机 → 复刻 pages/index/index.js:205-209 goQuiz() 的 URL 构造，
//      直接 handoff 到该题库的随机练习（不写计划）
//
// 题号一律取自 storage 中的既有清单（错题本 / 标记清单），
// 不读沙箱里的题库明细 —— 该 API 不在白名单（见 .ai-mode-skills/analysis-apis.md §6）。
const { successResult, errorResult } = require('../utils/util');
const progress = require('../utils/progress');
const wrongbook = require('../utils/wrongbook');
const marks = require('../utils/marks');
const db = require('../utils/localindex');
const safe = require('../utils/safestore');

// 与 utils/custom.js 的 PLAN_KEY 一致（该 key 由主包答题页 takePlan() 消费）
const PLAN_KEY = 'qz_custom_plan';
const DEFAULT_COUNT = 20;
const MAX_COUNT = 200;

// 与 utils/custom.js 的 draw() 逐字一致：Fisher-Yates 洗牌后取前 N。
// 一次洗牌同时完成「随机抽取」与「随机顺序」，避免出现「题抽得随机、顺序仍是原序」。
function draw(pool, count) {
  const a = (pool || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  let n = Math.floor(Number(count));
  if (!isFinite(n) || n <= 0) n = a.length;
  if (n > a.length) n = a.length;
  return a.slice(0, n);
}

// 候选题号池：按题库聚合，全部来自 storage 既有清单
function collectPool(source, setId) {
  const out = [];
  if (source === 'marked') {
    // marks.listBooks() 扫的是 qz_mk_ 前缀（marks.js:95-110），nos 为数值升序
    marks.listBooks().forEach((b) => {
      if (setId && b.setId !== setId) return;
      (b.nos || []).forEach((no) => out.push({ sid: b.setId, no: String(no) }));
    });
    return out;
  }
  const filter = source === 'hard' ? 'hard' : 'pending';
  wrongbook.listBooks().forEach((b) => {
    if (setId && b.setId !== setId) return;
    wrongbook.listItems(b.setId, filter).forEach((it) => {
      out.push({ sid: b.setId, no: String(it.no) });
    });
  });
  return out;
}

const SOURCE_LABEL = { wrong: '错题重练', hard: '易错题重练', marked: '标记题重练', set: '随机练习' };

async function createPracticePlan(params = {}) {
  const source = params.source || 'wrong';
  const setId = params.setId || '';
  const count = Math.min(Math.max(parseInt(params.count, 10) || DEFAULT_COUNT, 1), MAX_COUNT);
  console.info('[ai-mode] createPracticePlan 入口, source =', source, 'setId =', setId, 'count =', count);

  try {
    if (source === 'set') {
      // 整库随机练习：题量由该题库全部题目决定，此时 count 不生效
      const meta = setId ? db.getSetMeta(setId) : null;
      if (!meta) {
        const tip = setId
          ? `没有找到题库 ${setId}，请先用 listSets 确认可用的题库。`
          : '整库练习需要指定一个题库，请先用 listSets 拿到 setId。';
        return errorResult(tip);
      }
      const query = `setId=${setId}&mode=random`;
      console.info('[ai-mode] createPracticePlan 出口(整库), query =', query);
      return Object.assign(
        successResult(`已准备好「${meta.title || '未命名题库'}」的随机练习（整库 ${meta.questionCount || 0} 题）。点下方卡片即可开始。`, {
          source,
          setId,
          title: meta.title || '未命名题库',
          questionCount: meta.questionCount || 0,
          scope: `${meta.title || '未命名题库'} · 整库随机`,
          count: meta.questionCount || 0,
          handoffPath: '/pages/quiz/quiz'
        }),
        { handoff: { query } }
      );
    }

    if (!SOURCE_LABEL[source]) {
      return errorResult(`不支持的题源 ${source}，可选值：wrong / hard / marked / set。`);
    }

    const pool = collectPool(source, setId);
    if (!pool.length) {
      const scopeTip = setId ? '该题库' : '全部题库';
      const emptyTip = source === 'marked'
        ? `${scopeTip}还没有标记题。答题时点题卡右上角「标记」就能收进来。`
        : source === 'hard'
          ? `${scopeTip}还没有易错题（错 2 次以上才会归入）。`
          : `${scopeTip}还没有错题记录。`;
      return errorResult(emptyTip);
    }

    const picked = draw(pool, count);
    const scopeName = setId ? ((db.getSetMeta(setId) || {}).title || '当前题库') : '全部题库';
    const scope = `${SOURCE_LABEL[source]} · ${scopeName} · ${picked.length} 题`;

    // 计划结构逐字对齐 utils/custom.js buildPlan()：{ items, scope, count, title, at }
    const plan = {
      items: picked.map((it) => ({ sid: it.sid, no: it.no })),
      scope,
      count: picked.length,
      title: `自定义练习 · ${picked.length} 题`,
      at: Date.now()
    };
    // 写不进去就必须停下来（否则跳过去是个空练习），与 custom.js stash() 同用 writeOrThrow
    safe.writeOrThrow(
      PLAN_KEY,
      plan,
      '本机存储空间已满，本次练习设置未能保存。请到「文件库」删除不再需要的题库后重试。'
    );

    const query = `setId=${progress.CUSTOM_SCOPE}&mode=custom`;
    const limited = picked.length < count
      ? `（候选共 ${pool.length} 题，已全部抽出）`
      : '';
    console.info('[ai-mode] createPracticePlan 出口, picked =', picked.length, 'query =', query);

    return Object.assign(
      successResult(`已抽好 ${picked.length} 题${limited}，每次顺序都不同。点下方卡片即可开始练习。`, {
        source,
        setId,
        title: plan.title,
        scope,
        count: picked.length,
        poolSize: pool.length,
        itemsPreview: picked.slice(0, 10).map((it) => ({ setId: it.sid, no: it.no })),
        handoffPath: '/pages/quiz/quiz'
      }),
      { handoff: { query } }
    );
  } catch (err) {
    console.error('[ai-mode] createPracticePlan 出错:', err.message);
    return errorResult(`生成练习失败: ${err.message}`);
  }
}

module.exports = { createPracticePlan };
