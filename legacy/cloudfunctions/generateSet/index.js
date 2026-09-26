// 云函数：generateSet
// 输入：{ questionFile:{fileID,name}, answerFile?:{fileID,name}, title?, splitMode? }
// 动作：下载试题/解析文件 → 解析文本 → 按章节标题自动拆卷(通用识别,可用 splitMode:false 关闭)
//      → 每卷一个 quiz_sets/quiz_questions；答案解析支持「与试题同构的章节结构」或整体编号
// 注意：请在云开发控制台把本函数超时时间调至 60 秒
const cloud = require('wx-server-sdk');
const { extractText, splitQuestions, splitParts, buildQuestionsByPosition, resolveAnswerPlan } = require('./parser');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function assertFile(f, label) {
  if (!f || !f.fileID || !f.name) {
    throw new Error(`${label}无效，请重新选择文件`);
  }
}

async function download(file) {
  try {
    const res = await cloud.downloadFile({ fileID: file.fileID });
    return res.fileContent;
  } catch (e) {
    throw new Error(`读取文件「${file.name}」失败，请检查文件是否仍存在：${e.errMsg || e.message || e}`);
  }
}

// 分批并发写入
async function insertBatch(collection, docs, size) {
  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const groups = chunk(docs, size || 20);
  for (const g of groups) {
    await Promise.all(g.map((doc) => db.collection(collection).add({ data: doc })));
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const questionFile = event.questionFile || {};
  const answerFile = event.answerFile || null;
  const hasAnswer = !!(answerFile && answerFile.fileID);
  const splitMode = event.splitMode !== false; // 默认自动按章节标题拆分（未识别到标题时退回单卷）

  assertFile(questionFile, '试题文件');
  if (hasAnswer) assertFile(answerFile, '答案解析文件');

  const qBuf = await download(questionFile);
  const qText = await extractText(questionFile.name, qBuf);
  const baseTitle = (event.title && event.title.trim()) || questionFile.name.replace(/\.[^.]+$/, '');

  // ---- 按章节/标题拆分（通用识别） ----
  const parts = splitMode ? splitParts(qText) : [{ title: null, text: qText }];
  const segs = parts
    .map((p) => ({ title: p.title, questions: splitQuestions(p.text) }))
    .filter((s) => s.questions.length);
  if (!segs.length) {
    throw new Error('未能从试题文件中识别到题目。请确认题目以「1. / 1、/ 第1题」编号开头，且文件为文字版（非扫描图片）');
  }

  // ---- 答案解析/参考答案：顺序对齐（题号在书内会重复，不能按题号建索引） ----
  let ansPerPart = null;   // 与 segs 一一对应，且与每卷题目逐题对位
  let planInfo = null;
  if (hasAnswer) {
    const aBuf = await download(answerFile);
    const aText = await extractText(answerFile.name, aBuf);
    const plan = resolveAnswerPlan(
      segs.map((s) => ({ title: s.title, count: s.questions.length, questions: s.questions })),
      aText
    );
    ansPerPart = plan.perPart;
    planInfo = {
      mode: plan.mode,
      matched: plan.matched,
      unmatchedQuestions: plan.unmatchedQuestions,
      orphanAnswers: plan.orphanAnswers
    };
  }

  const now = db.serverDate();
  const stamp = Date.now();
  const results = [];
  let totalQ = 0, totalMatched = 0, totalExpl = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const built = buildQuestionsByPosition(seg.questions, ansPerPart ? ansPerPart[i] : null);
    const matchedCount = built.filter((q) => q.matched).length;
    const explCount = built.filter((q) => q.explanation).length;

    const title = segs.length > 1 ? `${baseTitle} · ${(seg.title || '第' + (i + 1) + '部分').trim()}` : baseTitle;
    const setId = `${OPENID.replace(/-/g, '')}_${stamp}_${i}`;

    const setDoc = {
      _openid: OPENID,
      setId,
      title,
      questionFile: { fileID: questionFile.fileID, name: questionFile.name },
      answerFile: hasAnswer ? { fileID: answerFile.fileID, name: answerFile.name } : null,
      questionCount: built.length,
      matchedCount,
      unmatchedCount: built.length - matchedCount,
      explCount,
      answerPlanMode: planInfo ? planInfo.mode : '',
      createTime: now,
      updateTime: now
    };
    await db.collection('quiz_sets').add({ data: setDoc });

    const qDocs = built.map((q) => ({
      _openid: OPENID,
      setId,
      no: q.no,
      stem: q.stem,
      options: q.options,
      type: q.type,
      answer: q.answer,
      answerKey: q.answerKey,
      explanation: q.explanation,
      matched: q.matched,
      createTime: now
    }));
    await insertBatch('quiz_questions', qDocs, 20);

    results.push({ setId, title, questionCount: built.length, matchedCount, explCount, hasAnswer, planMode: planInfo ? planInfo.mode : '' });
    totalQ += built.length;
    totalMatched += matchedCount;
    totalExpl += explCount;
    console.log(`[generateSet] openid=${OPENID} part=${i + 1}/${segs.length} set=${setId} q=${built.length} matched=${matchedCount} title=${title}`);
  }

  return {
    ok: true,
    setId: results[0].setId,          // 兼容单卷：首卷即整卷
    title: results[0].title,
    parts: results,
    totalQuestions: totalQ,
    questionCount: totalQ,
    matchedCount: totalMatched,
    explCount: totalExpl,
    unmatched: totalQ - totalMatched,
    answerPlanMode: planInfo ? planInfo.mode : '',
    orphanAnswers: planInfo ? planInfo.orphanAnswers : 0,
    hasAnswer
  };
};
