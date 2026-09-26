// apis/getStudyOverview.js —— 学习总览
//
// 数据组装复刻三处主包消费点：
//   错题合计 ← utils/wrongbook.js:140 summary()（页面 pages/wrong/wrong.js:56 调用）
//   校对合计 ← utils/errata.js:141 summary()（页面 pages/errata/errata.js:50 调用）
//   标记合计 ← utils/marks.js:112 summary()（页面 pages/index/index.js:86 调用）
//   逐题正确率统计 ← pages/result/result.js:64-78 的 records 遍历与 rate 计算
//   继续练习 ← pages/index/index.js:65-80 的 recents 取首条未完成项
const { successResult, errorResult, formatTime } = require('../utils/util');
const progress = require('../utils/progress');
const wrongbook = require('../utils/wrongbook');
const errata = require('../utils/errata');
const marks = require('../utils/marks');
const db = require('../utils/localindex');

async function getStudyOverview() {
  console.info('[ai-mode] getStudyOverview 入口');
  try {
    const sets = db.listSets();
    const totalQuestions = sets.reduce((a, s) => a + (s.questionCount || 0), 0);

    // 与 result.js:64-78 同一口径：只统计「已作答」的题，自评也算已作答
    let answered = 0;
    let correct = 0;
    sets.forEach((s) => {
      const st = progress.getState(s.setId);
      if (!st) return;
      const records = st.records || {};
      Object.keys(records).forEach((no) => {
        const r = records[no];
        if (!r) return;
        const isAnswered = r.answered || r.manual;
        if (!isAnswered) return;
        answered++;
        const isRight = r.correct === true || r.manual === 'right';
        if (isRight) correct++;
      });
    });
    const rate = answered ? Math.round((correct / answered) * 100) : 0;

    const wb = wrongbook.summary();
    const er = errata.summary();
    const mk = marks.summary();

    // 与 index.js:65-80 一致：最近记录里首条未完成的即「继续练习」
    const recents = progress.listRecents();
    const recent = recents.filter((r) => !r.finished)[0] || null;

    const overview = {
      setCount: sets.length,
      totalQuestions,
      answered,
      correct,
      rate,
      wrongbook: { sets: wb.sets, total: wb.total, pending: wb.pending, hard: wb.hard, mastered: wb.mastered },
      errata: { sets: er.sets, total: er.total, open: er.open, fixed: er.fixed },
      marks: { sets: mk.sets, total: mk.total },
      recent: recent
        ? {
          setId: recent.setId,
          title: recent.title || '未命名题库',
          mode: recent.mode,
          progress: recent.progress || 0,
          done: recent.done || 0,
          total: recent.total || 0,
          updatedTimeText: formatTime(recent.updatedAt)
        }
        : null
    };

    console.info('[ai-mode] getStudyOverview 出口, answered =', answered, 'rate =', rate);
    if (!sets.length) {
      return successResult('本机还没有题库，也还没有学习记录。', overview);
    }

    const parts = [`已答 ${answered} 题，正确率 ${rate}%`];
    if (wb.pending) parts.push(`待攻克错题 ${wb.pending} 道`);
    if (wb.hard) parts.push(`易错题 ${wb.hard} 道`);
    if (er.open) parts.push(`待修校对 ${er.open} 条`);
    if (mk.total) parts.push(`标记题 ${mk.total} 道`);

    return successResult(`${parts.join('，')}。`, overview);
  } catch (err) {
    console.error('[ai-mode] getStudyOverview 出错:', err.message);
    return errorResult(`查询学习总览失败: ${err.message}`);
  }
}

module.exports = { getStudyOverview };
