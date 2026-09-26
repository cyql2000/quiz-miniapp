// 云函数：getSet —— 读取题库元信息 + 全部题目（按题号排序）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const setId = event.setId;
  if (!setId) throw new Error('缺少 setId');

  const setRes = await db.collection('quiz_sets').where({ setId }).limit(1).get();
  if (!setRes.data.length) {
    const envId = cloud.DYNAMIC_CURRENT_ENV;
    console.error(`[getSet] 未找到题库 setId=${setId} env=${envId}`);
    throw new Error(`题库不存在或已被删除 (setId=${setId}, env=${envId})`);
  }

  // 分页拉取全部题目（服务端单次上限 1000）
  const MAX = 1000;
  let questions = [];
  for (let i = 0; i < 20; i++) {
    const res = await db.collection('quiz_questions').where({ setId }).skip(i * MAX).limit(MAX).get();
    questions = questions.concat(res.data);
    if (res.data.length < MAX) break;
  }
  questions.sort((a, b) => a.no - b.no);

  const list = questions.map((q) => ({
    no: q.no,
    stem: q.stem,
    options: q.options || [],
    type: q.type || 'single',
    answer: q.answer || '',
    answerKey: q.answerKey || '',
    explanation: q.explanation || '',
    matched: !!q.matched
  }));

  return { ok: true, set: setRes.data[0], questions: list };
};
