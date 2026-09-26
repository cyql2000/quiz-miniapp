// 小程序 AI 原子接口（skills/quiz-helper）离线逻辑验证
//
// 说明：正式的平台校验（静态规则 V001~V021 + 真机 execute / render）由
// wxa-skills-validate 负责；本文件只验证**生成产物自身**的业务逻辑是否正确：
// 注册名与 mcp.json 对齐、每个接口的返回结构与字段、抽题计划的落盘形态、
// handoff query 是否与答题页 onLoad 的消费方式一致。
//
// 运行：node _smoke/aiskill.test.js
const path = require('path');
const fs = require('fs');
const BASE = path.join(__dirname, '../miniprogram');
const SKILL = path.join(BASE, 'skills/quiz-helper');

const mem = {};
const registered = {};

global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  modelContext: {
    registerAPI: (name, fn) => { registered[name] = fn; }
  }
};

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// ---------------- 造数据（形态与主包 storage 一致）----------------
mem.qz_local_sets_v1 = [
  {
    setId: 's1',
    title: '示例题库 · 第一章 常识',
    questionCount: 4,
    matchedCount: 3,
    answerFile: { id: 'f2', name: '解析.txt' },
    createTime: 1700000000000
  },
  {
    setId: 's2',
    title: '另一本书 · 第一章',
    questionCount: 2,
    matchedCount: 2,
    answerFile: null,
    createTime: 1700000001000
  }
];

// s1 错题本：第 2 题错 2 次（→ 易错），第 3 题错 1 次（→ 待攻克）
mem.qz_wb_s1 = {
  setId: 's1',
  title: '示例题库 · 第一章 常识',
  updatedAt: 1700000005000,
  items: {
    2: {
      no: '2', stem: '下列属于可再生能源的有', type: 'multi',
      options: [{ key: 'A', text: '风能' }], answer: 'AB', answerKey: 'AB', explanation: '解析2',
      wrongCount: 2, rightCount: 0, attempts: 2, streak: 0, mastered: false,
      lastSelected: 'A', lastWrongAt: 1700000004000
    },
    3: {
      no: '3', stem: '标准大气压下水沸点', type: 'judge',
      options: [], answer: '正确', answerKey: 'A', explanation: '解析3',
      wrongCount: 1, rightCount: 0, attempts: 1, streak: 0, mastered: false,
      lastSelected: 'B', lastWrongAt: 1700000002000
    }
  }
};

// s2 标记清单
mem.qz_mk_s2 = { setId: 's2', title: '另一本书 · 第一章', nos: ['1'], updatedAt: 1700000006000 };

// s1 会话进度：第 1 题答对、第 2 题答错
mem.qz_state_s1 = {
  setId: 's1', title: '示例题库 · 第一章 常识', mode: 'order',
  order: ['1', '2', '3', '4'], idx: 2, total: 4,
  records: { 1: { answered: true, correct: true }, 2: { answered: true, correct: false } },
  wrongs: ['2'], elapsedMs: 30000, lastTickAt: 1700000000000,
  startedAt: 1700000000000, finished: false
};
mem.qz_recents = [{
  setId: 's1', title: '示例题库 · 第一章 常识', mode: 'order', custom: false,
  total: 4, done: 2, progress: 50, finished: false, updatedAt: 1700000010000
}];

// s1 校对记录：答案由 A 改成 B
mem.qz_er_s1 = {
  setId: 's1',
  title: '示例题库 · 第一章 常识',
  updatedAt: 1700000007000,
  items: {
    2: {
      no: '2', types: ['answer'],
      original: { stem: '题干原值', options: 'A. 风能', answer: 'A', explanation: '原解析' },
      fix: { stem: '', options: '', answer: 'B', explanation: '', note: '答案是 B' },
      status: 'open', createdAt: 1700000007000, updatedAt: 1700000007000
    }
  }
};

(async () => {
  // ---------------- 1. 注册入口与 mcp.json 对齐 ----------------
  require(path.join(SKILL, 'index.js'));
  const mcp = JSON.parse(fs.readFileSync(path.join(SKILL, 'mcp.json'), 'utf8'));
  const mcpNames = mcp.apis.map((a) => a.name);
  eq('注册的接口名与 mcp.json 完全一致', Object.keys(registered).sort(), mcpNames.slice().sort());
  ok('每个 mcp 条目都有对应实现', mcpNames.every((n) => typeof registered[n] === 'function'));
  ok('每个接口都写了 description', mcp.apis.every((a) => (a.description || '').length > 10));
  ok('每个接口都声明了 inputSchema', mcp.apis.every((a) => a.inputSchema && a.inputSchema.type === 'object'));

  // ---------------- 2. listSets ----------------
  const r1 = await registered.listSets({});
  eq('listSets 非错误返回', r1.isError, false);
  eq('listSets 题库数', r1.structuredContent.total, 2);
  eq('listSets 题目总数', r1.structuredContent.totalQuestions, 6);
  const s1 = r1.structuredContent.sets.filter((s) => s.setId === 's1')[0];
  eq('listSets 已答数来自会话 records', s1.done, 2);
  eq('listSets 完成度', s1.progress, 50);
  eq('listSets 待攻克错题数', s1.wrongCount, 2);
  eq('listSets 易错题数', s1.hardCount, 1);
  eq('listSets 标记题数', s1.markedCount, 0);
  eq('listSets 配了解析的题库 answerFile=true', s1.answerFile, true);
  const s2 = r1.structuredContent.sets.filter((s) => s.setId === 's2')[0];
  eq('listSets 未配解析的题库 answerFile=false', s2.answerFile, false);
  eq('listSets 标记数落在 s2', s2.markedCount, 1);

  // ---------------- 3. getStudyOverview ----------------
  const r2 = await registered.getStudyOverview({});
  eq('overview 已答数', r2.structuredContent.answered, 2);
  eq('overview 答对数', r2.structuredContent.correct, 1);
  eq('overview 正确率', r2.structuredContent.rate, 50);
  eq('overview 错题合计', r2.structuredContent.wrongbook.total, 2);
  eq('overview 待攻克', r2.structuredContent.wrongbook.pending, 2);
  eq('overview 易错', r2.structuredContent.wrongbook.hard, 1);
  eq('overview 标记合计', r2.structuredContent.marks.total, 1);
  eq('overview 待修校对', r2.structuredContent.errata.open, 1);
  eq('overview 带出未完成的最近练习', r2.structuredContent.recent.setId, 's1');
  eq('overview 最近练习的模式', r2.structuredContent.recent.mode, 'order');

  // ---------------- 4. listWrongItems ----------------
  const r3 = await registered.listWrongItems({});
  eq('错题默认视图为待攻克', r3.structuredContent.tab, 'pending');
  eq('错题待攻克数量', r3.structuredContent.total, 2);
  const w0 = r3.structuredContent.groups[0].items.filter((it) => it.no === '2')[0];
  eq('错题带出题干', w0.stem, '下列属于可再生能源的有');
  eq('错题带出题型标签', w0.typeLabel, '多选题');
  eq('错题带出答案', w0.answerKey, 'AB');
  eq('错题带出解析', w0.explanation, '解析2');
  eq('错题错率', w0.errRate, 100);
  eq('错题易错标记', w0.hard, true);
  eq('错题 key 与错题本页同构', w0.key, 's1_2');

  const r3b = await registered.listWrongItems({ filter: 'hard' });
  eq('易错视图只含易错题', r3b.structuredContent.groups[0].items.map((i) => i.no), ['2']);
  const r3c = await registered.listWrongItems({ setId: 's2' });
  // 与 pages/wrong/wrong.js:61-62 同款回退：传入的题库不在错题列表里时退回全部
  eq('指定无错题的题库时回退为全部', r3c.structuredContent.total, 2);
  eq('回退后范围标题为全部题库', r3c.structuredContent.scopeTitle, '全部题库');
  const r3d = await registered.listWrongItems({ limit: 1 });
  eq('limit 生效', r3d.structuredContent.shown, 1);

  // ---------------- 5. listErrataItems ----------------
  const r4 = await registered.listErrataItems({});
  eq('校对默认视图为待修', r4.structuredContent.tab, 'open');
  eq('待修条数', r4.structuredContent.total, 1);
  const e0 = r4.structuredContent.groups[0].items[0];
  eq('校对 key 与校对页同构', e0.key, 's1_2');
  eq('校对带出差异条数', e0.diffs.length, 1);
  eq('校对差异：原值', e0.diffs[0].from, 'A');
  eq('校对差异：修正值', e0.diffs[0].to, 'B');
  eq('校对差异标签', e0.diffs[0].label, '答案');
  eq('校对带出备注', e0.note, '答案是 B');
  eq('校对带出问题类型标签', e0.typeLabels, ['答案有误']);

  // ---------------- 6. createPracticePlan：错题抽题 + handoff ----------------
  const r5 = await registered.createPracticePlan({ source: 'wrong', count: 5 });
  eq('抽题非错误返回', r5.isError, false);
  eq('候选只有 2 题时全取', r5.structuredContent.count, 2);
  ok('返回 handoff', !!r5.handoff);
  eq('handoff query 指向答题页 custom 模式', r5.handoff.query, 'setId=__custom__&mode=custom');
  ok('计划已写入 qz_custom_plan', !!mem.qz_custom_plan);
  eq('计划题数', mem.qz_custom_plan.items.length, 2);
  eq('计划标题与 custom.js 同构', mem.qz_custom_plan.title, '自定义练习 · 2 题');
  ok('计划项结构为 {sid,no}', mem.qz_custom_plan.items.every((it) => !!it.sid && it.no != null));
  ok('计划范围描述非空', (mem.qz_custom_plan.scope || '').length > 3);
  ok('计划题号来自错题本', mem.qz_custom_plan.items.every((it) => it.sid === 's1' && ['2', '3'].indexOf(it.no) >= 0));
  eq('mcp 声明的接力页与真实页面一致',
    mcp.apis.filter((a) => a.name === 'createPracticePlan')[0]._meta.ui.pagePath,
    '/pages/quiz/quiz');
  ok('接力页在 app.json 里真实存在',
    JSON.parse(fs.readFileSync(path.join(BASE, 'app.json'), 'utf8')).pages.indexOf('pages/quiz/quiz') >= 0);

  // 抽题顺序随机：多次抽同一批题，次序不应固定
  const orders = {};
  for (let i = 0; i < 30; i++) {
    const r = await registered.createPracticePlan({ source: 'wrong', count: 2 });
    orders[mem.qz_custom_plan.items.map((it) => it.no).join()] = 1;
  }
  ok('多次抽题顺序不固定', Object.keys(orders).length > 1);

  // ---------------- 7. createPracticePlan：标记题源 ----------------
  const r6 = await registered.createPracticePlan({ source: 'marked', count: 10 });
  eq('标记题源抽题数', r6.structuredContent.count, 1);
  eq('标记题来自 s2', mem.qz_custom_plan.items[0].sid, 's2');

  // ---------------- 8. createPracticePlan：整库随机（不写计划） ----------------
  delete mem.qz_custom_plan;
  const r7 = await registered.createPracticePlan({ source: 'set', setId: 's1' });
  eq('整库练习非错误返回', r7.isError, false);
  eq('整库练习 handoff query', r7.handoff.query, 'setId=s1&mode=random');
  eq('整库练习不写自定义计划', mem.qz_custom_plan, undefined);
  eq('整库练习带出题量', r7.structuredContent.questionCount, 4);

  // ---------------- 9. 空题源与非法参数的错误返回 ----------------
  const r8 = await registered.createPracticePlan({ source: 'hard', setId: 's2' });
  eq('该库无易错题时返回错误', r8.isError, true);
  ok('错误文案可操作', r8.content[0].text.indexOf('易错题') >= 0);
  const r9 = await registered.createPracticePlan({ source: 'set' });
  eq('整库练习缺 setId 时返回错误', r9.isError, true);
  const r10 = await registered.createPracticePlan({ source: 'nonsense' });
  eq('非法题源返回错误', r10.isError, true);

  // ---------------- 10. 空库时的空态 ----------------
  const backup = mem.qz_local_sets_v1;
  mem.qz_local_sets_v1 = [];
  const r11 = await registered.listSets({});
  eq('无题库时返回空列表且非错误', [r11.isError, r11.structuredContent.total], [false, 0]);
  const r12 = await registered.getStudyOverview({});
  eq('无题库时总览不报错', r12.isError, false);
  mem.qz_local_sets_v1 = backup;

  // ---------------- 11. 产物完整性 · 体积上限 · 配置集成 ----------------
  ['mcp.json', 'SKILL.md', 'index.js', 'utils/util.js'].forEach((f) => {
    ok(`产物齐备 ${f}`, fs.existsSync(path.join(SKILL, f)));
  });
  ok('apis/ 只放 mcp.json 注册的原子接口',
    fs.readdirSync(path.join(SKILL, 'apis')).every((f) => mcpNames.indexOf(f.replace('.js', '')) >= 0));

  // 平台上限：mcp.json 计算时去掉 outputSchema 与空白
  const slim = JSON.parse(JSON.stringify(mcp));
  slim.apis.forEach((a) => { delete a.outputSchema; });
  const mcpBytes = Buffer.byteLength(JSON.stringify(slim).replace(/\s/g, ''), 'utf8');
  ok(`mcp.json 未超 24000 字节（实测 ${mcpBytes}）`, mcpBytes <= 24000);
  const skillBytes = fs.statSync(path.join(SKILL, 'SKILL.md')).size;
  ok(`SKILL.md 未超 16000 字节（实测 ${skillBytes}）`, skillBytes <= 16000);

  const appJson = JSON.parse(fs.readFileSync(path.join(BASE, 'app.json'), 'utf8'));
  eq('app.json 已开启 lazyCodeLoading', appJson.lazyCodeLoading, 'requiredComponents');
  eq('app.json agent.skills 注册本技能',
    appJson.agent.skills.map((s) => [s.name, s.path]), [['quiz-helper', 'skills/quiz-helper']]);
  ok('每个 skill 条目都写了 description', appJson.agent.skills.every((s) => (s.description || '').length > 10));
  eq('app.json 注册独立分包 skills',
    appJson.subPackages.map((p) => [p.root, p.independent]), [['skills', true]]);
  eq('project.config.json 的 packOptions.include 含 skills',
    JSON.parse(fs.readFileSync(path.join(BASE, '../project.config.json'), 'utf8')).packOptions.include,
    [{ type: 'folder', value: 'skills' }]);

  // 主包接力适配
  const appJs = fs.readFileSync(path.join(BASE, 'app.js'), 'utf8');
  // 必须带能力判断：该 API 在低版本基础库上不存在，无防护调用会让 onLaunch 中断 ——
  // 表现就是「模拟器/预览正常、真机起不来」，所以这条断言同时要求判断存在
  ok('主包 onLaunch 内**带能力判断地**注册 onAgentHandoff',
    /onLaunch\(\)\s*\{[\s\S]{0,1200}typeof wx\.onAgentHandoff === 'function'[\s\S]{0,300}wx\.onAgentHandoff\(/.test(appJs));
  ok('答题页兼容 handoff 传进来的字符串 query',
    fs.readFileSync(path.join(BASE, 'pages/quiz/quiz.js'), 'utf8').indexOf("typeof options === 'string'") >= 0);

  // SKILL.md 硬性约束：接口契约只在 mcp.json 维护
  const skillMd = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  ['inputSchema', 'outputSchema', 'componentPath', 'qz_', 'storage'].forEach((k) => {
    ok(`SKILL.md 不出现「${k}」`, skillMd.indexOf(k) < 0);
  });
  ok('SKILL.md 里提到的方法名都在 mcp.json 中',
    ['listSets', 'getStudyOverview', 'listWrongItems', 'listErrataItems', 'createPracticePlan']
      .filter((n) => skillMd.indexOf(n) >= 0).length === 5);

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
