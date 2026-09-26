// apis/listSets.js —— 查看我的题库
//
// 逐字复刻主包 pages/index/index.js:41-63 的题库列表组装逻辑
// （字段集与表达式一一对应，见 .ai-mode-skills/analysis-apis.md §1）。
const { successResult, errorResult, formatTime } = require('../utils/util');
const db = require('../utils/localindex');
const progress = require('../utils/progress');
const wrongbook = require('../utils/wrongbook');
const marks = require('../utils/marks');

async function listSets() {
  console.info('[ai-mode] listSets 入口');
  try {
    const docs = db.listSets();
    const sets = docs.map((d) => {
      const st = progress.getState(d.setId);
      const ws = wrongbook.stats(d.setId);
      let done = 0;
      if (st) {
        const recs = st.records || {};
        done = Object.keys(recs).filter((no) => recs[no].answered || recs[no].manual).length;
      }
      return {
        setId: d.setId,
        title: d.title || '未命名题库',
        questionCount: d.questionCount || 0,
        matchedCount: d.matchedCount || 0,
        // 字段名沿用 pages/index/index.js:55-56 的原名
        answerFile: d.answerFile ? true : false,
        timeText: formatTime(d.createTime) || '--',
        done,
        progress: d.questionCount ? Math.min(100, Math.round((done / d.questionCount) * 100)) : 0,
        wrongCount: ws.pending,
        hardCount: ws.hard,
        markedCount: marks.count(d.setId)
      };
    });

    console.info('[ai-mode] listSets 出口, sets =', sets.length);
    if (!sets.length) {
      return successResult('本机还没有题库。需要先在「文件库」导入试题文本，再生成题库。', { sets: [], total: 0 });
    }

    const totalQuestions = sets.reduce((a, s) => a + s.questionCount, 0);
    return successResult(
      `共 ${sets.length} 个题库，合计 ${totalQuestions} 题`,
      { sets, total: sets.length, totalQuestions }
    );
  } catch (err) {
    console.error('[ai-mode] listSets 出错:', err.message);
    return errorResult(`查询题库失败: ${err.message}`);
  }
}

module.exports = { listSets };
