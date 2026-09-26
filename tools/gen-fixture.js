#!/usr/bin/env node
// ============================================================
// 生成一套「无版权」的合成语料，供端到端测试使用
//   运行：node tools/gen-fixture.js
//   产出：fixtures/ 下的题本、解析与 expected.json
//
// 为什么自己合成，而不是放一份真实题本：
//   真实教辅（行测等）有版权，不能进仓库；一旦测试依赖仓库外的语料，
//   别人 clone 下来就跑不了端到端，CI 也只能跳过 —— 等于没有验证。
//
// 为什么这套语料没有版权问题：
//   1) 数学题全部由程序生成，答案由计算得出，不存在"复制"；
//   2) 古诗填空取自唐宋名家的千古名句 —— 作者逝世远超 50 年，属公有领域；
//   3) 常识题写的是客观事实（水的沸点、行星数量、元素序号……），
//      事实本身不受著作权保护，题干表述由本脚本自行组织；
//   4) 干扰项由脚本按数值邻近/同类混淆自动生成，非摘抄。
//
// 语料刻意覆盖了引擎要处理的每一种形态（见 CHAPTERS 的 style / noise 配置），
// 因此它同时也是一份回归夹具：改了解析规则，跑一遍就知道有没有打坏边界。
//
// 引擎的两条对齐链路，这里各造一份语料分别覆盖：
//   顺序对齐（题号在分卷内重置）→ 6 章分卷题本 + 解析文件
//   按题号对齐（题号全局唯一）  → 单卷题本 + 聚合/单行多题答案
//   文末自带答案               → 单卷题本 + 末尾「参考答案」区
// ============================================================

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../fixtures');

// ---------------- 确定性随机（同一份种子 → 同一份语料） ----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260925);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
const intOf = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---------------- 素材库 ----------------

// 唐宋名句填空（公有领域：作者逝世远超 50 年）
const POEMS = [
  ['两个黄鹂鸣翠柳', '一行白鹭上青天'],
  ['床前明月光', '疑是地上霜'],
  ['春眠不觉晓', '处处闻啼鸟'],
  ['白日依山尽', '黄河入海流'],
  ['锄禾日当午', '汗滴禾下土'],
  ['举头望明月', '低头思故乡'],
  ['野火烧不尽', '春风吹又生'],
  ['海内存知己', '天涯若比邻'],
  ['欲穷千里目', '更上一层楼'],
  ['千山鸟飞绝', '万径人踪灭'],
  ['会当凌绝顶', '一览众山小'],
  ['停车坐爱枫林晚', '霜叶红于二月花'],
  ['孤帆远影碧空尽', '唯见长江天际流'],
  ['忽如一夜春风来', '千树万树梨花开'],
  ['沉舟侧畔千帆过', '病树前头万木春'],
  ['山重水复疑无路', '柳暗花明又一村'],
  ['不识庐山真面目', '只缘身在此山中'],
  ['春风又绿江南岸', '明月何时照我还'],
  ['天生我材必有用', '千金散尽还复来'],
  ['同是天涯沦落人', '相逢何必曾相识']
];

// 客观事实（事实不受著作权保护，表述为本脚本自行组织）
const FACTS = [
  ['标准大气压下，水的沸点是 100 摄氏度。', true],
  ['太阳系目前公认有八大行星。', true],
  ['地球自转一周的时间约为 24 小时。', true],
  ['光在真空中的传播速度约为每秒 30 万千米。', true],
  ['中国最长的河流是黄河。', false],
  ['人体最大的器官是皮肤。', true],
  ['一年共有 24 个节气。', true],
  ['元素周期表中原子序数为 1 的元素是氦。', false],
  ['三角形的内角和等于 180 度。', true],
  ['中国的陆地面积约为 960 万平方千米。', true],
  ['水的化学式为 H2O。', true],
  ['声音在空气中的传播速度约为每秒 340 米。', true],
  ['太阳系中体积最大的行星是土星。', false],
  ['地球上已知最深的海沟是马里亚纳海沟。', true],
  ['一天共有 86400 秒。', true],
  ['圆周率 π 的近似值通常取 3.14。', true]
];

// 简答（无选项，答案是一段文字）
const ESSAYS = [
  ['简述水的三态变化及其发生条件。', '水在常压下降温至 0 摄氏度以下凝结为冰，升温至 100 摄氏度以上汽化为水蒸气，常温常压下呈液态。'],
  ['写出勾股定理的内容。', '直角三角形两条直角边的平方和等于斜边的平方，即 a² + b² = c²。'],
  ['说明可再生能源与非可再生能源的区别。', '可再生能源能在自然界中不断补充，如太阳能、风能；非可再生能源储量有限，用后难以再生，如煤、石油。']
];

// ---------------- 题目工厂 ----------------

function makeMathCalc() {
  const a = intOf(11, 89);
  const b = intOf(11, 89);
  const op = pick(['+', '-', '×']);
  let val;
  if (op === '+') val = a + b;
  else if (op === '-') val = Math.max(a, b) - Math.min(a, b);
  else val = a * b;
  const text = op === '×' ? `${Math.max(a, b)} × ${Math.min(a, b)}` : `${op === '-' ? Math.max(a, b) - Math.min(a, b) + ' + ' + Math.min(a, b) : a + ' ' + op + ' ' + b}`;
  const r = shuffleOptions(String(val), [
    String(val + intOf(1, 9)),
    String(Math.abs(val - intOf(1, 9))),
    String(val + intOf(10, 30))
  ]);
  return { stem: `计算：${text} 等于多少？`, options: r.options, answerKey: r.answerKey, type: 'single' };
}

function makeEquation() {
  const x = intOf(2, 40);
  const p = intOf(2, 30);
  const r = shuffleOptions(String(x), [String(x + 1), String(Math.max(1, x - 2)), String(x + p)]);
  return { stem: `若 x + ${p} = ${x + p}，则 x 等于多少？`, options: r.options, answerKey: r.answerKey, type: 'single' };
}

function makePercent() {
  const price = pick([120, 200, 240, 300, 360, 480]);
  const up = pick([10, 20, 25, 50]);
  const after = Math.round(price * (1 + up / 100));
  const r = shuffleOptions(`${Math.round(after * 0.9)} 元`, [
    `${price} 元`, `${after} 元`, `${Math.round(price * 0.9)} 元`
  ]);
  return {
    stem: `某商品原价 ${price} 元，先涨价 ${up}%，再按九折出售，最终价格是多少？`,
    options: r.options, answerKey: r.answerKey, type: 'single'
  };
}

function makePoem() {
  const [head, tail] = POEMS[intOf(0, POEMS.length - 1)];
  const others = shuffled(POEMS.filter((p) => p[1] !== tail).map((p) => p[1])).slice(0, 3);
  const r = shuffleOptions(tail, others);
  return { stem: `「${head}」的下一句是：`, options: r.options, answerKey: r.answerKey, type: 'single' };
}

function makeFact() {
  const [text, ok] = pick(FACTS);
  return { stem: text, options: [], type: 'judge', answerKey: ok ? 'A' : 'B' };
}

function makeMultiNumber() {
  const base = pick([2, 3, 4, 5, 6, 9]);
  const rights = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
    .filter((n) => n % base === 0)).slice(0, 2).sort((a, b) => a - b).map(String);
  const wrongs = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
    .filter((n) => n % base !== 0 && rights.indexOf(String(n)) < 0)).slice(0, 2).sort((a, b) => a - b).map(String);
  const all = shuffled(rights.concat(wrongs));
  const answerKey = all.map((t, idx) => (rights.indexOf(t) >= 0 ? String.fromCharCode(65 + idx) : '')).join('');
  return { stem: `下列各数中，是 ${base} 的倍数的有（多选）：`, options: all, type: 'multi', answerKey };
}

function makeMultiEnergy() {
  const renew = ['太阳能', '风能', '水能', '生物质能', '地热能', '潮汐能'];
  const nonrenew = ['煤炭', '石油', '天然气', '铀矿'];
  const r = shuffled(renew).slice(0, 2);
  const w = shuffled(nonrenew).slice(0, 2);
  const all = shuffled(r.concat(w));
  const answerKey = all.map((t, idx) => (r.indexOf(t) >= 0 ? String.fromCharCode(65 + idx) : '')).join('');
  return { stem: '下列属于可再生能源的有（多选）：', options: all, type: 'multi', answerKey };
}

function makeEssay() {
  const [stem, answer] = pick(ESSAYS);
  return { stem, options: [], type: 'text', answerText: answer };
}

function shuffleOptions(right, wrongs) {
  const list = shuffled([right].concat(wrongs.filter((w) => w !== right))).slice(0, 4);
  const idx = list.indexOf(right);
  return { options: list, answerKey: String.fromCharCode(65 + idx) };
}

// ---------------- 章节配置 ----------------
// style 决定答案文件的写法。这里的每一种都是「顺序对齐」链路实测能捕获的写法：
//   expl    1.【答案】A。【解析】……故正确答案为A。
//   plain   1. A            ← 纯字母/字母串；判卷题的「对/错」走这条会捕获不到，
//                              所以该章不放判断题（真实解析册的判卷题都带「答案：」前缀）
//   colon   1. 答案：C 解析：……
//   refcolon 1. 参考答案：C
//   paren   1.（答案A。粉笔大数据显示本题考查……）
//   mixed   以上写法混合，验证同一份解析册里多种写法共存时仍能对齐
const CHAPTERS = [
  {
    title: '第一章 常识判断', count: 20, style: 'expl', opt: 'A. ',
    mix: [makeFact, makePoem, makeMathCalc, makeFact, makeMultiEnergy],
    noise: ['dataRow']
  },
  {
    title: '第二章 数量关系', count: 20, style: 'plain', opt: '（A）',
    mix: [makeMathCalc, makeEquation, makePercent, makeMathCalc, makeMultiNumber],
    noise: ['watermark', 'continuation']
  },
  {
    title: '第三章 言语理解', count: 20, style: 'colon', opt: 'A、',
    mix: [makePoem, makePoem, makeFact, makePoem, makeFact],
    noise: ['methodBlock']
  },
  {
    title: '第四章 资料分析', count: 20, style: 'refcolon', opt: 'A) ',
    mix: [makeMathCalc, makePercent, makeEquation, makeMathCalc, makeFact],
    noise: ['material']
  },
  {
    title: '第五章 判断推理', count: 15, style: 'paren', opt: 'A. ',
    mix: [makeFact, makePoem, makeMathCalc, makeFact, makeMultiEnergy],
    noise: ['yearHead']
  },
  {
    title: '第六章 综合练习', count: 15, style: 'mixed', opt: 'A. ',
    mix: [makePoem, makeMathCalc, makeEssay, makeFact, makeEquation],
    noise: ['dataRow', 'watermark']
  }
];

// ---------------- 噪声注入 ----------------
// 这些都是真实语料里会把切题搞乱的形态，引擎有专门的防护。
// 注入它们是为了让这份语料能测到那些防护，而不是只跑通"干净输入"。
const NOISE = {
  dataRow: () => ['460.6 4077.5 2162.3', '8305.8', '2000. 60'],
  watermark: () => ['免费公众号：考公学社 扫码领取资料'],
  methodBlock: () => [
    '考点介绍',
    '1. 先读问题，再回材料定位。',
    '2. 注意单位换算与基期现期。',
    '3. 选项差距大时可直接估算。'
  ],
  material: () => [
    '（2023上海B 111～115）根据下列资料完成以下各题',
    '27302 30889 36938 41924',
    '1.2 2.4 3.6 4.8'
  ]
};

// ---------------- 答案文件渲染 ----------------
function answerTextOf(q) {
  if (q.type === 'text') return { letter: null, text: q.answerText };
  if (q.type === 'judge') return { letter: q.answerKey === 'A' ? pick(['对', '正确']) : pick(['错', '错误']), text: null };
  return { letter: q.answerKey, text: null };
}

function renderAnswers(chapter, questions) {
  const lines = [];
  const st = chapter.style;

  questions.forEach((q, i) => {
    const no = i + 1;
    const a = answerTextOf(q);

    if (st === 'plain') {
      // 纯字母：多选连写、单选单字母
      lines.push(`${no}. ${a.letter}`);
      return;
    }
    if (st === 'colon') {
      lines.push(`${no}. 答案：${a.letter || a.text} 解析：本题考查基础知识的掌握情况，逐项排除即可。`);
      return;
    }
    if (st === 'refcolon') {
      lines.push(`${no}. 参考答案：${a.letter}`);
      return;
    }
    if (st === 'paren') {
      lines.push(`${no}.（答案${a.letter}。本题考查对基本概念的辨析，排除法可得${a.letter}项。`);
      return;
    }
    if (st === 'mixed') {
      if (q.type === 'text') lines.push(`${no}. 答案：${a.text}`);
      else if (q.type === 'judge') lines.push(`${no}. 答案：${a.letter}`);
      else if (i % 2 === 0) lines.push(`${no}.【答案】${a.letter}。【解析】逐项分析可知${a.letter}项正确。故正确答案为${a.letter}。`);
      else lines.push(`${no}. ${a.letter}`);
      return;
    }
    // expl：解析书式，句尾带「故正确答案为X」作为二次校验信号
    if (q.type === 'judge') {
      lines.push(`${no}.【答案】${a.letter}。【解析】该说法${a.letter === '对' || a.letter === '正确' ? '符合' : '不符合'}事实。故正确答案为${a.letter}。`);
    } else {
      lines.push(`${no}.【答案】${a.letter}。【解析】逐项分析可知${a.letter}项正确。故正确答案为${a.letter}。`);
    }
  });
  return lines;
}

// 文末「答案速查」区（单卷题本自带答案时用）
function renderInlineAnswerBlock(questions) {
  const lines = ['参考答案'];
  questions.forEach((q, i) => {
    const a = answerTextOf(q);
    lines.push(`${i + 1}. ${a.letter || a.text}`);
  });
  lines.push('');
  return lines;
}

// ---------------- 组装分卷题本 ----------------
function buildChapter(chapter, chapterIndex) {
  const lines = [];
  const expected = [];
  const questions = [];

  lines.push(`# ${chapter.title}`);
  lines.push('');

  for (let i = 0; i < chapter.count; i++) {
    const no = i + 1;
    let q = chapter.mix[i % chapter.mix.length]();

    // 第五章第 4 题：造一道「题号 + 年份」开头的真题形态
    // （引擎必须识别为题目，不能误判成小数/表格行）
    if (chapter.noise.indexOf('yearHead') >= 0 && i === 3) {
      const r = shuffleOptions('1280', ['1180', '1380', '1480']);
      q = { stem: '2021年，表中所列省市的产量合计约为：', options: r.options, answerKey: r.answerKey, type: 'single' };
    }

    // 第二章第 6 题：题干续行。上一行必须「不含句读且够长」，
    // 否则行首的 `1.5倍…` 会被当成新题号（这正是对该防护要验证的点）
    if (chapter.noise.indexOf('continuation') >= 0 && i === 5) {
      q = {
        stem: '某车间原有职工若干人，扩招后男女职工人数之比保持不变，'
          + '且扩招前后职工总人数之比与产量之比相同，则扩招前该车间的职工总人数是',
        options: ['30', '45', '60', '75'],
        answerKey: 'B',
        type: 'single'
      };
      lines.push(`${no}.${q.stem}`);
      lines.push('1.5倍。该车间在扩招前的员工人数是：');
      q.options.forEach((text, k) => {
        const key = String.fromCharCode(65 + k);
        lines.push(`${chapter.opt.replace('A', key)}${text}`);
      });
      lines.push('');
      questions.push(q);
      expected.push({
        chapter: chapterIndex + 1, no, type: q.type,
        answerKey: q.answerKey, answerText: '', stemHead: String(q.stem).slice(0, 12)
      });
      continue;
    }

    lines.push(`${no}.${q.stem}`);
    if (q.options && q.options.length) {
      q.options.forEach((text, k) => {
        const key = String.fromCharCode(65 + k);
        lines.push(`${chapter.opt.replace('A', key)}${text}`);
      });
    }
    lines.push('');

    // 噪声放在题目之间的空档：不该产生新题，也不该并入上一题。
    // 落点固定在第 8 题之后 —— 后面必须紧跟「有选项」的题。
    // 因为引擎在方法块/材料块内只认「带题源标注」或「后面十四行内有选项行」的编号行
    // （这是为了防止表格碎片变成伪题，代价是紧随其后的判断题、简答题会被一并跳过），
    // 噪声后面若跟一道判断题，那道题就会被吞掉 —— 那是引擎的已知边界，不是本语料要测的东西。
    if (i === 7) {
      chapter.noise.forEach((n) => {
        if (n === 'yearHead') return;
        (NOISE[n] || (() => []))().forEach((l) => lines.push(l));
        lines.push('');
      });
    }

    questions.push(q);
    expected.push({
      chapter: chapterIndex + 1, no, type: q.type,
      answerKey: q.answerKey || '', answerText: q.answerText || '',
      stemHead: String(q.stem).slice(0, 12)
    });
  }

  return { lines, questions, expected };
}

// ---------------- 主流程 ----------------
function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // ===== 1. 分卷题本（顺序对齐链路）=====
  const qLines = [];
  const aLines = [];
  const expected = [];

  CHAPTERS.forEach((chapter, ci) => {
    const { lines, questions, expected: exp } = buildChapter(chapter, ci);
    qLines.push(...lines);
    expected.push(...exp);
    aLines.push(`# ${chapter.title}`);
    aLines.push(...renderAnswers(chapter, questions));
    aLines.push('');
  });

  // ===== 2. 单卷题本（按题号对齐 + 文末自带答案）=====
  // 单卷、题号全局唯一，才能测到「聚合式 / 单行多题」这两种答案写法
  const single = [];
  for (let i = 0; i < 20; i++) single.push(makePoem());
  const sLines = [];
  single.forEach((q, i) => {
    sLines.push(`${i + 1}.${q.stem}`);
    q.options.forEach((t, k) => sLines.push(`${String.fromCharCode(65 + k)}. ${t}`));
    sLines.push('');
  });

  // 聚合式 + 单行多题（只在题号唯一的单卷下成立）
  const aggLines = [];
  const letters = single.map((q) => q.answerKey);
  aggLines.push('1-5. ' + letters.slice(0, 5).join(' '));
  aggLines.push('6-10. ' + letters.slice(5, 10).join(' '));
  aggLines.push(letters.slice(10, 15).map((l, k) => `${11 + k}.${l}`).join(' '));
  aggLines.push(letters.slice(15, 20).map((l, k) => `${16 + k}.${l}`).join(' '));

  const singleExpected = single.map((q, i) => ({
    chapter: 1, no: i + 1, type: q.type, answerKey: q.answerKey,
    answerText: '', stemHead: String(q.stem).slice(0, 12)
  }));

  // 真实 OCR 语料是 CRLF，这里也用 CRLF：顺带覆盖「换行符不统一」这个老坑
  const write = (name, lines) => {
    const text = lines.join('\r\n');
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(text, 'utf8'));
    return text.length;
  };

  const sizes = {
    '合成题本.txt': write('合成题本.txt', qLines),
    '合成解析.txt': write('合成解析.txt', aLines),
    '合成题本-单卷.txt': write('合成题本-单卷.txt', sLines),
    '合成解析-聚合.txt': write('合成解析-聚合.txt', aggLines),
    '合成题本-文末答案.txt': write('合成题本-文末答案.txt', sLines.concat(renderInlineAnswerBlock(single)))
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'expected.json'),
    JSON.stringify({
      chapters: CHAPTERS.map((c) => c.title),
      questions: expected,
      single: singleExpected
    }, null, 2)
  );

  console.log(`已生成 ${OUT_DIR}`);
  Object.keys(sizes).forEach((k) => console.log(`  ${k.padEnd(26)} ${(sizes[k] / 1024).toFixed(1)} KB`));
  console.log(`  expected.json             ${expected.length} 题（${CHAPTERS.length} 卷）+ 单卷 ${singleExpected.length} 题`);
  CHAPTERS.forEach((c, i) => {
    const n = expected.filter((e) => e.chapter === i + 1).length;
    console.log(`    ${c.title}：${n} 题，答案写法 ${c.style}`);
  });
}

main();
