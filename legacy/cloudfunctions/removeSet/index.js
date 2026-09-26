// 云函数：removeSet —— 删除题库（元信息 + 全部题目）。源文件保留在文件库
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const setId = event.setId;
  if (!setId) throw new Error('缺少 setId');
  const { OPENID } = cloud.getWXContext();

  let removedQuestions = 0;
  const MAX = 1000;
  for (let i = 0; i < 50; i++) {
    const res = await db.collection('quiz_questions').where({ setId, _openid: OPENID }).limit(MAX).get();
    if (!res.data.length) break;
    const ids = res.data.map((d) => d._id);
    // 服务端 remove 上限 1000/次
    for (let k = 0; k < ids.length; k += 1000) {
      const chunkIds = ids.slice(k, k + 1000);
      const del = await db.collection('quiz_questions').where({ _id: db.command.in(chunkIds) }).remove();
      removedQuestions += del.stats.removed || 0;
    }
    if (res.data.length < MAX) break;
  }

  const setDel = await db.collection('quiz_sets').where({ setId, _openid: OPENID }).remove();

  console.log(`[removeSet] openid=${OPENID} set=${setId} removedQuestions=${removedQuestions}`);
  return { ok: true, removedQuestions, removedSets: setDel.stats.removed || 0 };
};
