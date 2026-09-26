// parser.js 题号判定回归测试（重点：表格数值行不再被误当题目）
// 运行：node _smoke/parser.test.js
const path = require('path');
const P = require(path.join(__dirname, '../legacy/cloudfunctions/generateSet/parser.js'));

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const nos = (text) => P.splitQuestions(text).map((q) => q.fileNo);

// ---------- 1. 表格数值行不得被当作题目 ----------
const tableBook = [
  '（2023国考副省121～125）根据下列资料完成以下各题。',
  '2016一2021年全国及部分省市集成电路产量',
  '单位：亿块',
  '2016年 2017年 2018年 2019年',
  '江苏 454 518 554 516',
  '460.6 4077.5 2162.3 458.6 4077.4 2202.1',
  '8305.8',
  '50.95 50.33',
  '2000. 60',
  '1.2021年，表中所列省市集成电路产量约占全国总产量的：',
  'A. 80% B. 84%',
  '2.2017一2021年间，全国集成电路产量同比增速超过20%的年份有几个？',
  'A. 1 B. 2'
].join('\n');
eq('表格数值行不算题目', nos(tableBook), [1, 2]);

// ---------- 2. 数据行不得污染上一题题干 ----------
const qs = P.splitQuestions(tableBook);
eq('第 1 题题干不含表格数字', /460\.6|8305\.8|2000\./.test(qs[0].stem), false);
eq('第 1 题题干完好', qs[0].stem.indexOf('2021年，表中所列') === 0, true);

// ---------- 3. 正常题号形态必须放行 ----------
const normal = [
  '1.（2024深圳16）我国民间俗语说“宅中现四喜，家中出贵人”，',
  'A. ①② B. ①③',
  '2.某公司2020年销售收入为1.5亿元，则利润为：',
  'A. 0.3亿元 B. 0.5亿元',
  '3、下列说法正确的是（　　）',
  'A. 甲 B. 乙',
  '4）下列选项中，与题干逻辑关系一致的是：',
  'A. 甲 B. 乙',
  '5.2019年—2021年间，该省GDP年均增速为：',
  'A. 5% B. 6%'
].join('\n');
eq('点/顿号/括号/年份 题号均放行', nos(normal), [1, 2, 3, 4, 5]);

// ---------- 4. 年份题号不得被误判为小数 ----------
eq('题号+题源年份放行', nos('6.2023年，Z省法律顾问数约是2020年的多少倍？\nA. 1 B. 2'), [6]);
eq('题号+4位年份无“年”字仍放行', nos('7.2020年五年规划提及：\nA. 甲 B. 乙'), [7]);

// ---------- 5. 保守取舍：单个小数+中文仍视为题目（宁留噪声不删真题） ----------
eq('单个小数+中文保守放行', nos('9.4个省份2018-2020年结余额趋势是：\nA. 甲 B. 乙'), [9]);

// ---------- 5b. 题干续行以小数开头时，须结合上一行判断 ----------
const contBook = [
  '3.（2023江苏B56）某高新技术企业为扩大业务，招收了两批新员工，原计划',
  '每批招收的人数相同，实际第二批多招了4人，结果第一批和第二批招收后员工人数',
  '新增的百分比相同。若第二批再多招6人，则员工总人数是两次招收前员工人数的',
  '1.5倍。该企业招收两批新员工前的员工人数是：',
  'A. 96 B. 100',
  'C. 104 D. 108'
].join('\n');
eq('小数续行不算新题号', nos(contBook), [3]);
eq('续行并入上一题题干', P.splitQuestions(contBook)[0].stem.indexOf('1.5倍') > 0, true);
eq('上一题选项完好', P.splitQuestions(contBook)[0].options.length, 4);

// 反过来：真题目以年份开头（上一行是句读结尾）必须放行
const yearQ = [
  '（2023国考副省121～125）根据下列资料完成以下各题。',
  '1.2021年，表中所列省市集成电路产量约占全国总产量的：',
  'A. 80% B. 84%'
].join('\n');
eq('题号+年份在句读后放行', nos(yearQ), [1]);

// ---------- 5b2. 行测 2027 版真实语料的三种伪题形态（isQStart 新增防护） ----------
// 材料段落的百分比行：`14.` 被误当题号
const pctBook = [
  '（2024国考副省121～125）根据下列资料完成以下各题。',
  '8月，全国电梯维保采购规模9650.81万元，环比下降40.06%，同比下降',
  '14.11%，主要分布于政府机关、医疗系统、教育系统、轨道交通等，其中，政府机关',
  '电梯维保占全国电梯维保采购市场40.85%。',
  '1.2024年8月，全国电梯采购规模约为多少亿元？',
  'A. 1.4 B. 1.8'
].join('\n');
eq('材料段落百分比行不算题号', nos(pctBook), [1]);

// 真题断行后的数量+单位碎行：`252.` 被误当题号
const unitBook = [
  '19.（2025江苏B57）在巴黎奥运会男子10米气步枪射击决赛中，江苏选手以',
  '252.2环的成绩夺得金牌并打破奥运会纪录。10米气步枪射击比赛用的靶纸上有10',
  '个环，问靶纸上共有多少个环？',
  'A. 5 B. 10'
].join('\n');
eq('数量+单位碎行不算题号', nos(unitBook), [19]);
eq('碎行并入上一题题干', P.splitQuestions(unitBook)[0].stem.indexOf('252.2环') > 0, true);

// 数量列表行（题号 ≥100 的大号跳变）：`115、` 被误当题号
const listBook = [
  '2.（2025新疆65）某农科所将一块上底长为20米的直角梯形形状实验田划分',
  '为4个完全相同的区域，产量分别为110、',
  '115、125和130千克。那么平均产量为：',
  'A. 110 B. 120'
].join('\n');
eq('数量列表行不算题号', nos(listBook), [2]);

// 豁免形态：题号+「4个省份」问句（数字+量词「个」开头的真题）
eq('题号+数字量词问句仍放行', nos('9.4个省份2018-2020年结余额趋势是：\nA. 甲 B. 乙'), [9]);
// 豁免形态：题号+年份区间开头（OCR 把破折号写成「一」）
eq('题号+年份区间仍放行', nos('2.2017一2021年间，全国集成电路产量同比增速超过20%的年份有几个？\nA. 1 B. 2'), [2]);

// ---------- 5b. 表格数值行被小数拆行 → 不得被当题号 ----------
// 资料分析题本里表格同一行的多个数值常被 OCR 串成一串，行首看起来像「题号.小数」
// （`3393.3141731.42商品零售` / `70.88总资产增速`）。判据里的年份豁免只认 19xx/20xx
// 且后面不接数字 —— 否则 `3141731` / `202118` 这种 4 位开头的表格数值会被当成
// "年份"放行。实测（09 资料分析题本）：规则生效后切出的题数 1334 → 1087，零误杀真题。
const splitDecimalBook = [
  '1.（2023浙江A20）2021年，表中所列省市集成电路产量约占全国总产量的：',
  'A. 80% B. 84%',
  '3393.3141731.42商品零售',
  '2.2022年，Z省法律顾问数约是2020年的多少倍？',
  'A. 1 B. 2'
].join('\n');
eq('小数拆行的表格数值行不算题号', nos(splitDecimalBook), [1, 2]);
eq('表格数值行不并入上一题题干', P.splitQuestions(splitDecimalBook)[0].stem.indexOf('商品零售') < 0, true);
// 反向护栏：题号后面真正接年份（19xx/20xx）仍要放行
eq('题号+年份开头仍放行', nos('1.2021年，表中所列省市集成电路产量约占全国总产量的：\nA. 甲 B. 乙'), [1]);

// ---------- 5c. 方法讲解块内的编号条目不是题目 ----------
const methodBook = [
  '「考点介绍」',
  '排列组合问题的本质是讨论按给定条件完成某件事共有多少种情况。',
  '解题思维',
  '1.如果题干中出现“相邻”“在一起”“连续”等要求时，考虑捆绑法，',
  '做题时先捆再排。',
  '2.如果题干中要求把n个相同的物品分给m个主体，考虑插板法。',
  '?粉笔提示',
  '1.当正面考虑情况数较多时，可以从反面的角度解题。',
  '2.n个人随机围绕圆桌就座，即环形排列情况数为A-1种。',
  '1.（2023江苏B56）某高新技术企业为扩大业务，招收了两批新员工，原计划',
  '每批招收的人数相同。',
  'A. 96 B. 100',
  'C. 104 D. 108'
].join('\n');
eq('方法块内编号不算题目', nos(methodBook), [1]);
eq('方法块后的真题正常切出', P.splitQuestions(methodBook)[0].options.length, 4);

// 图形推理题无文字选项，但带题源标注 → 仍须识别为题目
const graphic = [
  '「考点介绍」',
  '1.曲直性：根据组成图形的线条是曲线还是直线。',
  '2.开闭性：根据图形本身有无封闭区域。',
  '1.（2020四川58）从所给的四个选项中，选择最合适的一个填入问号处，使之',
  '呈现一定的规律性。',
  '2.（2023国考地市73）从所给的四个选项中，选择最合适的一个填入问号处。',
  '3.（2021贵州67）分析下图中图形的变化规律。'
].join('\n');
eq('无选项但有题源的真题不被吞', nos(graphic), [1, 2, 3]);

// ---------- 6. 分卷：数据行不应触发 qStarted ----------
const parts = P.splitParts('## 第一章 表格资料\n460.6 4077.5\n8305.8');
eq('仅数据行时不分卷', parts.length, 1);
eq('仅数据行时无题目', P.splitQuestions(parts[0].text).length, 0);

// ---------- 7. 选项解析不受影响 ----------
const q1 = P.splitQuestions('1.甲、乙两数之和是1.2，差是0.8，则甲是：\nA. 1.0 B. 1.1 C. 1.2 D. 1.3')[0];
eq('小数题干不被当作续行', q1.fileNo, 1);
eq('选项解析完整', q1.options.map((o) => o.key), ['A', 'B', 'C', 'D']);
eq('选项文本正确', q1.options[0].text, '1.0');

// ---------- 8. 答案与解析匹配仍正常 ----------
const built = P.buildQuestions(
  P.splitQuestions('1.下列说法正确的是：\nA. 甲 B. 乙\n2.下列说法错误的是：\nA. 甲 B. 乙'),
  P.parseAnswers('1.【答案】A。解析：甲正确。\n2.【答案】B。解析：乙错误。')
);
eq('答案匹配', built.map((q) => q.answerKey), ['A', 'B']);
eq('解析挂接', built[0].explanation.indexOf('甲正确') >= 0, true);
eq('题型判定', built.map((q) => q.type), ['single', 'single']);

// ============================================================
// 顺序对齐（题号在书内重复时的唯一可靠办法）
// ============================================================

// ---------- 9. parseAnswerEntries 必须"不去重、按文档顺序" ----------
// 反例：旧的 parseAnswers 用 map[题号] 去重，题号每考点重置时只剩最后一组
const dupNo = [
  '1.【答案】A。粉笔大数据：【解析】第一题。',
  '2.【答案】B。粉笔大数据：【解析】第二题。',
  '故正确答案为B。',
  '1.【答案】C。粉笔大数据：【解析】第三题（新考点又从头编号）。',
  '2.【答案】D。粉笔大数据：【解析】第四题。'
].join('\n');
const de = P.parseAnswerEntries(dupNo);
eq('不去重·条目数', de.length, 4);
eq('不去重·题号序列', de.map((e) => e.no), [1, 2, 1, 2]);
eq('不去重·答案序列', de.map((e) => e.answer), ['A', 'B', 'C', 'D']);
eq('结尾定论被记录', de[1].tailAnswer, 'B');
eq('结尾定论不混入解析', de[1].explanation.indexOf('故正确答案为'), -1);
eq('解析正文保留', de[3].explanation.indexOf('第四题') >= 0, true);
eq('旧接口会丢条目（对照）', P.parseAnswers(dupNo).length, 2);

// ---------- 10. 题号重复时按位置装配正确 ----------
// 每题给满 4 个选项：答案 A/B/C/D 都能落在选项上，这样测的是「装配位置」而不是答案越界
const dupQs = '1.甲是（　）\nA. 1 B. 2 C. 3 D. 4\n2.乙是（　）\nA. 1 B. 2 C. 3 D. 4\n1.丙是（　）\nA. 1 B. 2 C. 3 D. 4\n2.丁是（　）\nA. 1 B. 2 C. 3 D. 4';
const dupBuilt = P.buildQuestionsByPosition(P.splitQuestions(dupQs), de);
eq('按位置装配·答案', dupBuilt.map((q) => q.answerKey), ['A', 'B', 'C', 'D']);
// 旧的按题号装配会被覆盖：两道 1、两道 2 只能取到最后一组
const oldBuilt = P.buildQuestions(P.splitQuestions(dupQs), de).map((q) => q.answerKey);
eq('按题号装配会串位（对照）', oldBuilt, ['C', 'D', 'C', 'D']);

// ---------- 11. alignAnswerEntries：缺失项标 null，不错位 ----------
const segs3 = [{
  title: '第一章',
  count: 5,
  questions: P.splitQuestions('1.甲\n2.乙\n3.丙\n4.丁\n5.戊')
}];
// 解析缺第 3 条
const partial = [
  '1.【答案】A。【解析】甲',
  '2.【答案】B。【解析】乙',
  '4.【答案】D。【解析】丁',
  '5.【答案】C。【解析】戊'
].join('\n');
const plan3 = P.alignAnswerEntries(segs3, partial);
eq('对齐·匹配数', plan3.matched, 4);
eq('对齐·缺答处为 null', plan3.perPart[0].map((e) => (e ? e.answer : '□')), ['A', 'B', '□', 'D', 'C']);
eq('对齐·未匹配题数', plan3.unmatchedQuestions, 1);
eq('对齐·多余条目', plan3.orphanAnswers, 0);

// 解析多一条（重复题号干扰）时，应把多余项留空而不是整体错位
const withExtra = [
  '1.【答案】A。【解析】甲',
  '1.【答案】C。【解析】多出来的这条',
  '2.【答案】B。【解析】乙',
  '3.【答案】C。【解析】丙',
  '4.【答案】D。【解析】丁',
  '5.【答案】A。【解析】戊'
].join('\n');
const plan4 = P.alignAnswerEntries(segs3, withExtra);
eq('多余条目不错位·答案', plan4.perPart[0].map((e) => (e ? e.answer : '□')), ['A', 'B', 'C', 'D', 'A']);
eq('多余条目计数', plan4.orphanAnswers, 1);

// ---------- 12. resolveAnswerPlan 走 sequential 且能容忍缺失 ----------
// 注意：本例题目没有选项，字母答案会落在 answer 字段（无法自动判分，按主观题展示）
const plan5 = P.resolveAnswerPlan(segs3, partial);
eq('resolveAnswerPlan 模式', plan5.mode, 'sequential');
eq('resolveAnswerPlan 装配', P.buildQuestionsByPosition(segs3[0].questions, plan5.perPart[0]).map((q) => q.answer || ''), ['A', 'B', '', 'D', 'C']);

// ---------- 13. 答案归一化：多选 / 判断题两字写法（曾经的静默丢答案 bug） ----------
// 早期实现只写单字符匹配，导致 `ABD`（多选）与 `正确`/`错误`（两字词）被判成「无答案」，
// 题目却仍显示「已匹配」——答案空着，刷题时不报错、只是没有答案。这里锁死行为。
const ansBook = [
  '1. 单选正常作答',
  'A. 甲 B. 乙 C. 丙 D. 丁',
  '2. 多选正常作答',
  'A. 甲 B. 乙 C. 丙 D. 丁',
  '3. 判断题两字写法',
  '4. 多选带顿号',
  'A. 甲 B. 乙 C. 丙 D. 丁'
].join('\n');
const ansKey = [
  '1.【答案】b。',            // 小写也要能识别
  '2.【答案】ABD。',
  '3. 答案：正确。',
  '4.【答案】A、C。'
].join('\n');

const entries = P.parseAnswerEntries(ansKey);
eq('四条答案都抽到', entries.length, 4);
eq('小写字母归一为大写', entries[0].answer, 'B');
eq('多选答案完整保留', entries[1].answer, 'ABD');
eq('判断题两字写法识别', [entries[2].kind, entries[2].answer], ['judge', '对']);
eq('顿号分隔多选', entries[3].answer, 'AC');

const seg4 = [{ title: null, count: 4, questions: P.splitQuestions(ansBook) }];
const plan6 = P.resolveAnswerPlan(seg4, ansKey);
const built4 = P.buildQuestionsByPosition(seg4[0].questions, plan6.perPart[0]);
eq('多选判为 multi', built4[1].type, 'multi');
eq('多选答案已排序', built4[1].answerKey, 'ABD');
eq('判断题判为 judge', built4[2].type, 'judge');
eq('判断题答案映射到选项', built4[2].answerKey, 'A');
eq('判断题自动补选项', built4[2].options.map((o) => o.text), ['正确', '错误']);
eq('多选(顿号)类型', built4[3].type, 'multi');

// 反向保护：正文里出现字母不得被误当答案
eq('「C项正确」等正文不算答案', P.parseAnswerEntries('1.【答案】C项正确，ABD均不符。').length, 1);
eq('正文答案仍取首字母', P.parseAnswerEntries('1.【答案】C项正确，ABD均不符。')[0].answer, 'C');

// ---------- 12. 选项清洗：去重 / 规范序号 / 答案同步换算 ----------
const C = require(path.join(__dirname, '../legacy/cloudfunctions/generateSet/parser-core.js'));

// 两题粘连 → 同一字母出现两次（A B C D A B C D），只保留首次出现的那一组
const glued = C.sanitizeOptions([
  { key: 'A', text: '1项' }, { key: 'B', text: '2项' }, { key: 'C', text: '3项' },
  { key: 'D', text: '4项宝。关于' }, { key: 'A', text: '东风夜放花千树' },
  { key: 'B', text: '以居住地为姓氏' }, { key: 'C', text: '丙' }, { key: 'D', text: '丁' }
]);
eq('粘连选项去重', glued.options.map((o) => o.key), ['A', 'B', 'C', 'D']);
eq('去重保留首次内容', glued.options[3].text, '4项宝。关于');

// 选项行被漏扫 → 序号不从 A 起（B C D），统一重排为 A B C
const shifted = C.sanitizeOptions([{ key: 'B', text: '甲' }, { key: 'C', text: '乙' }, { key: 'D', text: '丙' }]);
eq('跳号序号重排', shifted.options.map((o) => o.key), ['A', 'B', 'C']);
eq('重排保留文本顺序', shifted.options.map((o) => o.text), ['甲', '乙', '丙']);
eq('重排给出字母映射', shifted.remap, { B: 'A', C: 'B', D: 'C' });
eq('已是规范序号时不重排', C.sanitizeOptions([{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }]).changed, false);
eq('空选项被丢弃', C.sanitizeOptions([{ key: 'A', text: '甲' }, { key: 'B', text: '  ' }]).options.length, 1);
eq('噪声尾巴被剥离', C.sanitizeOptions([{ key: 'A', text: '甲 本部分题目解析见下册第509~518页' }]).options[0].text, '甲');

// 序号重排后答案要跟着换算：BCD + 答案 C → 新答案 B
const remapped = C.buildOne(
  { canonicalNo: 1, stem: '题', options: [{ key: 'B', text: '甲' }, { key: 'C', text: '乙' }, { key: 'D', text: '丙' }] },
  { kind: 'choice', answer: 'C', explanation: '' }
);
eq('答案随序号换算', remapped.answerKey, 'B');
eq('答案文本同步换算', remapped.answer, 'B');
eq('可判分时无存疑标记', remapped.answerSuspect, false);

// 答案指向一个丢失的选项（选项只有 A/B/C，答案是 D）：不猜，转自评
const lost = C.buildOne(
  { canonicalNo: 2, stem: '题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }] },
  { kind: 'choice', answer: 'D', explanation: '' }
);
eq('答案缺项时不硬猜', lost.answerKey, '');
eq('答案缺项时标存疑', lost.answerSuspect, true);
eq('答案缺项时保留原答案文本', lost.answer, 'D');
eq('答案缺项时仍可正常展示选项', lost.options.map((o) => o.key), ['A', 'B', 'C']);
eq('存疑原因标为选项缺失', lost.answerSuspectKind, 'missingOption');

// 答案与题型自相矛盾：答案写「对 / 错」，题目却是四选一。
// 盲信答案条目会得到一道「带 4 个选项的判断题」—— 判分把 A 当"正确"、B 当"错误"，
// 考生选 C、D 永远判错，而且界面上看不出哪里不对。
const judgeOnChoice = C.buildOne(
  { canonicalNo: 3, stem: '「白日依山尽」的下一句是：', options: [{ key: 'A', text: '疑是地上霜' }, { key: 'B', text: '相逢何必曾相识' }, { key: 'C', text: '黄河入海流' }, { key: 'D', text: '明月何时照我还' }] },
  { kind: 'judge', answer: '对', explanation: '' }
);
eq('矛盾时不认判断题', judgeOnChoice.type, 'single');
eq('矛盾时不给判分键', judgeOnChoice.answerKey, '');
eq('矛盾时标存疑', judgeOnChoice.answerSuspect, true);
eq('存疑原因标为题型冲突', judgeOnChoice.answerSuspectKind, 'typeConflict');
eq('矛盾时选项原样保留', judgeOnChoice.options.map((o) => o.key), ['A', 'B', 'C', 'D']);

// 正常判断题不受影响：没有选项 → 补 A 正确 / B 错误
const judgePlain = C.buildOne(
  { canonicalNo: 4, stem: '声音在空气中传播得比光快。', options: [] },
  { kind: 'judge', answer: '错', explanation: '' }
);
eq('无选项仍是判断题', judgePlain.type, 'judge');
eq('无选项补正确/错误', judgePlain.options.map((o) => o.text), ['正确', '错误']);
eq('「错」落在 B', judgePlain.answerKey, 'B');
eq('正常判断题不标存疑', judgePlain.answerSuspect, false);

// 题本自己印了 A 正确 / B 错误 两个选项 → 仍是判断题，沿用题本选项
const judgeTwo = C.buildOne(
  { canonicalNo: 5, stem: '下列说法正确吗？', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] },
  { kind: 'judge', answer: '对', explanation: '' }
);
eq('两选项仍是判断题', judgeTwo.type, 'judge');
eq('两选项时不覆盖题本选项', judgeTwo.options.map((o) => o.text), ['正确', '错误']);
eq('「对」落在 A', judgeTwo.answerKey, 'A');

// 只剩 1 个选项：另一条被 OCR 吞了，「错」会无处可选 → 也不认判断题
const judgeOne = C.buildOne(
  { canonicalNo: 6, stem: '下列说法正确吗？', options: [{ key: 'A', text: '正确' }] },
  { kind: 'judge', answer: '对', explanation: '' }
);
eq('只剩一个选项时不认判断题', judgeOne.type, 'single');
eq('只剩一个选项时不给判分键', judgeOne.answerKey, '');
eq('只剩一个选项时标题型冲突', judgeOne.answerSuspectKind, 'typeConflict');

// 护栏：任何题型都不该出现「判分键指向不存在的选项」
const allBuilt = [remapped, lost, judgeOnChoice, judgePlain, judgeTwo, judgeOne];
const orphanKey = allBuilt.filter((q) => q.answerKey
  && !q.answerKey.split('').every((c) => q.options.some((o) => o.key === c)));
eq('判分键必须落在选项内', orphanKey.length, 0);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
