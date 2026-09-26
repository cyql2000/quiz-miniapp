// 云函数：initCollections —— 一键创建所需数据库集合（可重复执行）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ['quiz_files', 'quiz_sets', 'quiz_questions'];

exports.main = async () => {
  const results = [];
  for (const name of COLLECTIONS) {
    try {
      if (typeof db.createCollection === 'function') {
        await db.createCollection(name);
        results.push({ name, status: 'created' });
      } else {
        results.push({ name, status: 'skip', reason: '当前 SDK 不支持 createCollection，请在云开发控制台手动创建' });
      }
    } catch (e) {
      // -501001 / collection already exists
      if (e && (e.errCode === -501001 || /exist/i.test(e.errMsg || ''))) {
        results.push({ name, status: 'exists' });
      } else {
        results.push({ name, status: 'error', reason: e.errMsg || e.message });
      }
    }
  }
  return { ok: true, results };
};
