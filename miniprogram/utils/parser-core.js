// ============================================================
// 轻刷题 · 解析引擎核心（纯 JS，零 Node 依赖）
// 职责：文本 → 题目切分 → 答案解析抽取 → 顺序对齐 → 装配
// 运行环境：微信小程序端 / Node 脚本 均可
//
// ★ 本文件是解析引擎的【唯一真源】，请直接改这里。
//   改完运行：node tools/sync-parser.js
//   会把本文件同步到 miniprogram/utils/parser-core.js
//   （小程序无法 require 到 miniprogram/ 之外，故必须双份）
//
//   注意：不要引入 require / Buffer / process / __dirname，
//        同步脚本会拦截，小程序端也会崩。
// ============================================================
const SUPPORTED = ['pdf', 'docx', 'txt', 'md'];

// ---------- 文本预处理 ----------
function normalizeLines(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\uFEFF/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => {
      const s = l.trim();
      if (!s) return false;
      if (/^(第\s*)?\d+\s*页\s*[,，]?\s*(共\s*\d+\s*页)?$/.test(s)) return false; // 页码
      if (/^[-—–_·•*]{3,}$/.test(s)) return false; // 分隔线
      return true;
    });
}

// 题号行：第1题 / 1. / 1、 / 1） / 12.
const QSTART = /^\s*(?:第)?\s*(\d{1,4})\s*题?\s*[.、．)）]\s*/;
// 选项行起点：A. / A、 / （A） / A)
const OPTLINE = /^\s*[（(]?([A-Ha-h])\s*[)）.、．:：]\s*/;

// ---------- 表格数值行 / 小数误判防护 ----------
// 资料分析等题本的表格里存在大量形如下列的行，会被 QSTART 误当成题号：
//   460.6 4077.5 2162.3   （一行多个小数）
//   8305.8                （单个小数且整行无中文）
//   2000. 60              （小数被空格拆开）
// 这类行既不是题目，也不该并入上一题题干，识别后直接跳过。
const DATA_DOT_SPACE_NUM = /^\s*\d+\.\s+\d/;
const DATA_LEAD_DECIMAL = /^\s*\d+\.\d/;
function isDataRowLine(line) {
  const raw = (line || '').trim();
  if (!raw) return false;
  if (DATA_DOT_SPACE_NUM.test(raw)) return true;                 // "2000. 60"
  // 关键：只在「行首就是小数」时才继续判断。
  // 否则会误伤正常题干（如 "1.甲、乙两数之和是1.2，差是0.8，则甲是：" 含两个小数）。
  if (!DATA_LEAD_DECIMAL.test(raw)) return false;
  // 一行多个小数 → 表格数值。
  // 护栏（2026-09-23）：`17.2023年前三季度，营业收人超过1.2万亿元的行业…` 这种「题号+年份开头」
  // 的真题行里也有两个小数，会被引擎当成表格行跳过 → 整道题被上一题吞掉（09 实测 2 处）。
  // 真正的表格碎片要么几乎没有汉字，要么连一个句读标点都没有（"460.6 4077.5 2162.3"），
  // 真题问句两条都不满足，据此区分。
  if ((raw.match(/\d+\.\d+/g) || []).length >= 2
      && ((raw.match(/[\u4e00-\u9fa5]/g) || []).length <= 10
          || !/[，,。；;：:！？!?、]/.test(raw))) return true;
  if (!/[\u4e00-\u9fa5]/.test(raw)) return true;                  // 纯数值无中文 → 表格数值
  return false;
}

// 是否为真正的题号行（在 QSTART 基础上排除小数误判）
// prev 为上一行原文（可为 null）。仅在「行首是小数」这种可疑情况下才要求上一行情景合理，
// 因此不会影响任何正常题号，零回归风险。
//   `1.5倍。该企业招收两批新员工前的员工人数是：`   ← 题干续行（上一行以"人数的"结尾）
//   `1.2021年，表中所列省市集成电路产量约为：`      ← 真题（上一行以"。"结尾或为选项行）
// 上一行看起来像"一题的结束"或"一个小节的起点"
// 只有满足其中之一，才允许行首带数字的行成为新题号；否则视为上一题的续行。
// 典型误判：`2、4、4个选手共计10人参加。` 其实是 30 题题干的续行。
const HEAD_LIKE = /^\s*(?:#{1,6}\s*)?(?:[【\[「『][^\n]{0,16}|第[一二三四五六七八九十百\d]{1,6}\s*[章节篇部]|考点\s*\d|专项集训|综合训练|模块练习|卷[一二三四五六七八九十]|[（(]\s*[一二三四五六七八九十]{0,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[)）])/;

// 水印/推广行：不是正文，遇到时直接跳过（且不影响"上一行"的判断）
const NOISE_LINE = /(免费公众号|考公学社|扫码关注|扫码领取|微信号|QQ群|官方微博|粉笔公考)/;

// 资料分析的「材料块」起点：小节标记（四）/ 带题源标注的材料起始句
// （（2025上海B 111～115）根据下列资料完成以下各题）。
// 它不属于任何一题；不认出来的话，它连同后面整段表格数值会被**上一题的最后一个选项**整段吞掉
// （09 实测：17 道题的 D 选项里塞进一整块数字 + 下一组材料）。
// 只在「不是题号行」时才走到这一支（题号行先被 QSTART 接走），
// 所以 `5.根据上述资料，下列说法正确的是：` 这类真题问句不受影响。
const MATERIAL_START = /^(?:[（(]\s*[一二三四五六七八九十]{1,3}\s*[）)]\s*$|[（(]\s*(?:19|20)\d{2}[^）)]{0,20}[）)]\s*(?:根据|阅读|回答|据)|(?:根据下列资料|根据所给材料|阅读下列材料))/;

function isBoundaryBefore(prev) {
  if (prev == null) return true;
  const p = String(prev).trim();
  if (!p) return true;
  if (OPTLINE.test(p)) return true;                    // 上一行是选项行
  if (/[。！？；：:;）)】”」…]$/.test(p)) return true;    // 上一行以句读收尾
  if (!/[\u4e00-\u9fa5]/.test(p)) return true;         // 上一行无中文（图形/数值占位行）
  if (HEAD_LIKE.test(p)) return true;                  // 上一行像小节标题
  // 短行且无句读标点 → 视作小节标题/水印等非正文行
  // 兼顾 OCR 残缺形态：`（）夯实基础`、`二）高难进阶`、`「决战真题`、`、给完工时间型`
  if (p.length <= 18 && !/[，,。；;：:！？!?]/.test(p)) return true;
  // 上一行是表格行（数字占比高，如"律师人数（人） 27302 30889 36938 41924"）
  const digits = (p.match(/\d/g) || []).length;
  if (digits >= 3 && digits / p.length >= 0.25) return true;
  return false;
}

// 是否为真正的题号行
// prev   = 上一行原文（可为 null）
// lastNo = 上一个已识别题目的题号（可为 null）
// 判定原则：默认放行，只在高置信"不是题号"的情形下拦截——
//   1) 行首是小数且上一行不像一题的结束（表格数值 / 题干续行，如 `1.5倍。…`）
//   2) 题号相对上一题"倒退"，且上一行明显不是一题的结束（如 `2、4、4个选手共计10人参加。`）
//   3) 真实语料（行测 2027 版）新增的四种伪题形态（行首数字被 QSTART 误吃）：
//        `14.11%，主要分布于政府机关…`（资料分析材料段落的百分比行）
//        `252.2环的成绩夺得金牌…`（真题断行，数量+单位碎行）
//        `115、125和130千克。`（数量列表行，题号 ≥100 的大号跳变）
//        `13.12大型商业银行金额`（表格里「13.12」被小数拆行，只在资料分析题本出现；
//          这类行是 09 题数虚高的主因 —— 放开会让切出的题数比真实多出三成）
//      注意豁免真题形态：`9.4个省份2018-2020年结余额趋势是：`（题号+「4个省份」问句）、
//      `1.2021年，表中所列省市…`、`2.2017一2021年间…`（题号+年份/年份区间开头）。
function isQStart(line, prev, lastNo) {
  const raw = (line || '').trim();
  if (!QSTART.test(raw)) return false;
  if (isDataRowLine(raw)) return false;
  const leadDecimal = DATA_LEAD_DECIMAL.test(raw);
  const m = QSTART.exec(raw);
  const no = parseInt(m[1], 10);
  const rest = raw.slice(m[0].length).trim();
  if (leadDecimal && /^\d{1,3}\s*[%‰]/.test(rest)) return false;          // 材料段落百分比
  if (leadDecimal && /^\d+\s*[环吨千克]/.test(rest)) return false;         // 数量+单位碎行
  // 表格数值行：行首是小数、题号位后面又是数字（`3393.3141731.42商品零售`、
  // `70.88总资产增速`）。真题目号后面不会紧跟数字，除非那是年份
  // （`1.2021年，…` / `2.2017一2021年间…`）—— 所以年份豁免只认 19xx/20xx 且后面不接数字，
  // 否则 `3141731` / `202118` 这种表格数值会被当成"年份"放行。
  // 再要求「整行没有句读标点、汉字不超过 10 个」—— 表格碎片就是这种形态，
  // 而 `9.4个省份2018-2020年结余额趋势是：` 这类真题问句行带冒号，会被正确放行。
  // 注意：顿号「、」**不能**算句读标点 —— 表格行里并列词之间大量使用顿号
  // （`70.8计算机、通信和其他电子411`），算进去这条护栏就形同虚设，
  // 09 里几十道表格碎片就是这么混进来当题的（真题问句另有逗号/冒号/问号兜底）。
  if (leadDecimal && /^\d/.test(rest) && !/^(?:19|20)\d{2}(?!\d)/.test(rest)
      && !/[，,。；;：:！？!?]/.test(rest)
      && (raw.match(/[\u4e00-\u9fa5]/g) || []).length <= 10) return false;
  // 大号跳变的数字列表：同样只认真正的年份开头
  if (no >= 100 && /^\d/.test(rest) && !/^(?:19|20)\d{2}(?!\d)/.test(rest)) return false;
  if (!leadDecimal && lastNo == null) return true;
  if (leadDecimal && !isBoundaryBefore(prev)) return false;
  if (lastNo != null && no < lastNo && !isBoundaryBefore(prev)) return false;
  return true;
}

// ---------- 方法讲解块防护 ----------
// 「考点介绍」「解题思维」「粉笔提示」等栏目内部也用 `1.` `2.` `3.` 编号，
// 但内容是方法条目而非题目（数量关系等书很常见）。识别到此类栏目头后，
// 直到出现"带选项的真题目"为止，其中的编号行都不再当作题号。
const METHOD_BLOCK_HEAD =
  /^\s*(?:#{1,6}\s*)?[^\u4e00-\u9fa5]{0,3}(考点介绍|粉笔提示|解题思维|常用方法|方法精讲|知识梳理|考点梳理|学习说明|考情分析|备考指导|命题趋势|小贴士)[^\u4e00-\u9fa5]{0,3}\s*$/;

// 题源标注，如 `3.（2023江苏B56）`、`2.（2020四川58）`；方法条目不会有此标注
const SOURCE_TAG = /^[^\u4e00-\u9fa5]{0,6}[（(]\s*(?:19|20)\d{2}/;
const METHOD_BLOCK_MAX = 60; // 方法块最多容忍的行数，超出即认为已回到正文

// 判断某个编号行是否像"真题目"：带题源标注，或随后能读到选项行
// （图形推理等题在纯文字 OCR 里没有选项行，所以题源标注是必要的第二信号）
function looksLikeRealQuestion(lines, i) {
  if (SOURCE_TAG.test((lines[i] || '').trim())) return true;
  let seen = 0;
  for (let k = i + 1; k < lines.length && seen < 14; k++) {
    const t = (lines[k] || '').trim();
    if (!t) continue;
    seen++;
    if (OPTLINE.test(t)) return true;
    if (QSTART.test(t)) return false;
  }
  return false;
}

// ---------- 通用分卷/章节识别（按标题把题目自动拆成多个题库） ----------
// 强标题：无条件视为分卷点
const STRONG_HEAD = [
  { re: /^#{1,6}\s*(.*)$/, pick: (m) => m[1].trim() },                                    // # 一级标题 / ## …
  { re: /^【分卷】\s*(.*)$/, pick: (m) => m[1].trim() },                                   // 【分卷】显式分卷
  { re: /^第\s*([一二三四五六七八九十百千零\d]{1,6})\s*(章|节|篇|卷|部分|专题|讲)\s*[:：]?\s*(.*)$/, pick: (m) => `第${m[1]}${m[2]}${m[3] ? ' ' + m[3].trim() : ''}` },
  { re: /^考点\s*([0-9一二三四五六七八九十]{1,3})\s*(\S.{0,14})?$/, pick: (m) => `考点${m[1]}${m[2] ? ' ' + m[2].trim() : ''}` },
  { re: /^(Chapter|Part|Lesson|Section|Unit)\s+([A-Z\d]{1,4})\s*[:：\-–]?\s*(.*)$/i, pick: (m) => `${m[1]} ${m[2]}${m[3] ? ' ' + m[3].trim() : ''}` }
];
// 弱标题：短行 + 后续紧跟题号行才算（防误切题干）。仅中文序号式小节；
// 排除含标点行（如选项/枚举"（1）酒类排在…；"）与纯阿拉伯序号枚举
const SOFT_HEAD = [
  /^[（(]\s*[一二三四五六七八九十]{1,3}\s*[)）]\s*\S{1,20}$/,
  /^[一二三四五六七八九十]{1,3}[、.]\s*\S{1,20}$/,
  /^\d{1,3}\s*[、.]\s*(?:专题|模块|单元|课时|套|组)\s*\S{0,24}$/i
];
const HEAD_TRAIL = /[·.．\s]+$/;
const HEAD_BAD_CHAR = /[：:；;，,。？！?、]/; // 含句读标点不像标题（枚举/选项内容）

function headOfLine(line, lines, i) {
  const raw = (line || '').trim();
  if (!raw || isQStart(raw)) return null;
  let title = null;
  for (const h of STRONG_HEAD) {
    const m = h.re.exec(raw);
    if (m) { title = h.pick(m).replace(HEAD_TRAIL, ''); break; }
  }
  // 「第X节」「考点N」单独一行、名字在下一行（05 数量关系实测：`第二节` + `工程问题`、
  //  `考点 3` + `赋值法`）→ 合并取名。不合并的后果：同节下多个「（一）夯实基础」卷名
  //  完全相同，题库列表无法区分。
  const bareHead = new RegExp('^第\\s*[一二三四五六七八九十百千零\\d]{1,6}\\s*(章|节|篇|讲|部分)$').test(raw)
    || /^考点\s*[0-9一二三四五六七八九十]{1,3}$/.test(raw);
  if (title != null && bareHead) {
    let gotName = false;
    for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
      const nx = (lines[k] || '').trim();
      if (!nx) continue;
      if (nx.length <= 14 && !HEAD_BAD_CHAR.test(nx) && !isQStart(nx) && !OPTLINE.test(nx)) {
        title = title + ' ' + nx;
        gotName = true;
      }
      break;
    }
    // 「第X篇」单独一行且拼不上名字 → 是篇章阅读的「文章序号」（07 实测：`第一篇` 下面是
    //  材料长文），不是章节层级。放行会把整条标题栈弹空，卷名全变成「第一篇」。
    if (!gotName && new RegExp('^第\\s*[一二三四五六七八九十百千零\\d]{1,6}\\s*篇$').test(raw)) return null;
  }
  if (title == null && raw.length <= 30 && SOFT_HEAD.some((r) => r.test(raw))) {
    // 中文序号式标题自带顿号（「一、普通行程」），先剥掉序号再判「含句读标点不像标题」；
    //  否则整类子分组标题（05 实测：节 > 一、给完工时间型 > （一）夯实基础）会被漏掉，
    //  同节下多个「（一）夯实基础」卷名完全相同。
    const body = raw.replace(/^[（(]?\s*[一二三四五六七八九十\d]{1,3}\s*[)）.、．]\s*/, '');
    if (body && !HEAD_BAD_CHAR.test(body)) {
    // 要求其后 3 行内出现题号行
    for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
      const t = (lines[k] || '').trim();
      if (!t) continue;
      if (isQStart(t)) { title = raw; break; }
      const isHeadish = !HEAD_BAD_CHAR.test(t) && (SOFT_HEAD.some((r) => r.test(t)) || STRONG_HEAD.some((h) => h.re.test(t)));
      if (!isHeadish) break; // 中间出现正文 → 不是标题
    }
    }
  }
  return title == null ? null : (cleanTitle(title) || null);
}

// ---------- 标题层级（供「标题栈」拼完整卷名，如 第一章 · 第一节 · 考点1 · 一、普通行程 · （一）夯实基础） ----------
// 1=篇/部分/专题/卷  2=章  3=节  4=考点  5=「一、」式子分组  6=小节（（一）/数字式与兜底）
function headLevel(raw) {
  const s = String(raw || '').trim();
  const h = /^(#{1,6})\s/.exec(s);
  if (h) return h[1].length <= 2 ? 1 : 2;
  const cn = '[一二三四五六七八九十百千零\\d]{1,6}';
  if (new RegExp('^第\\s*' + cn + '\\s*(篇|部分|专题|讲|卷)').test(s)) return 1;
  if (new RegExp('^第\\s*' + cn + '\\s*章').test(s)) return 2;
  if (new RegExp('^第\\s*' + cn + '\\s*节').test(s)) return 3;
  if (/^考点\s*[0-9一二三四五六七八九十]{1,3}/.test(s)) return 4;
  // 「一、普通行程」式子分组（05 实测：节 > 考点/方法 > 一、xx > （一）夯实基础）
  if (/^[一二三四五六七八九十]{1,3}\s*[、.]/.test(s)) return 5;
  if (/^\d{1,3}\s*[、.]\s*(专题|模块|单元|课时|套|组)/.test(s)) return 5;
  return 6;
}

// 标题清洗：去掉书里的装饰性符号（竖线分隔符、成对书名号），统一括号形态。
//  OCR 实测形态：`第一章 丨图形推理`、`第二章 「定义判断`、`(三）新考法`
function cleanTitle(t) {
  return String(t == null ? '' : t)
    .replace(/[「」『』]/g, '')
    .replace(/\s*[丨|]\s*/g, ' ')
    .replace(/\(([一二三四五六七八九十]{1,3})[)）]/g, '（$1）')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

// 目录区识别：连续 >=6 个标题行（中间无正文）判为目录页，整块丢弃。
//  真实正文最多 4 连（篇-章-节-小节），目录页则有几十行；阈值 6 留有安全余量。
//  不丢目录的后果：目录里所有章节名被拼进第一卷卷名（Ocr 语料实测出现过 28 个标题的卷名）。
const TOC_RUN = 6;

// 分卷：卷名 = 「标题栈」的完整路径（章-节-小节），保证同名的「（一）夯实基础」可区分
function splitParts(text) {
  const lines = normalizeLines(text);
  const heads = lines.map((l, i) => headOfLine(l, lines, i));
  const inToc = new Array(lines.length).fill(false);
  let run = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && heads[i] != null) { run++; continue; }
    if (run >= TOC_RUN) for (let k = i - run; k < i; k++) inToc[k] = true;
    run = 0;
  }

  const parts = [];
  const stack = [];   // [{level, title}] 持久层级，跨卷保留
  let cur = { lines: [], qStarted: false, title: null };
  const path = () => stack.map((x) => x.title).join(' · ') || null;
  const flush = () => {
    if (cur.lines.length || cur.qStarted) {
      parts.push({ title: cur.title, text: cur.lines.join('\n'), hasQ: cur.qStarted });
    }
    cur = { lines: [], qStarted: false, title: null };
  };
  for (let i = 0; i < lines.length; i++) {
    const t = heads[i];
    if (t != null) {
      if (inToc[i]) continue;                       // 目录行：丢弃，不压栈不入正文
      const lv = headLevel(lines[i]);
      while (stack.length && stack[stack.length - 1].level >= lv) stack.pop();  // 同层或更深→截断
      stack.push({ level: lv, title: t });
      if (cur.qStarted) flush();                    // 已有题目 → 收卷开新卷
      cur.title = path();                           // 卷标题跟随最新栈路径
      continue;
    }
    cur.lines.push(lines[i]);
    if (isQStart(lines[i])) {
      if (!cur.qStarted) { cur.qStarted = true; if (!cur.title) cur.title = path(); }
    }
  }
  flush();

  const withQ = parts.filter((p) => p.hasQ);
  if (!withQ.length) return [{ title: null, text }];
  return withQ.map((p) => ({ title: p.title, text: p.text }));
}


// ---------- 试卷分区：题目 + 文末标准答案 ----------
// 行测书常见形态：题目与标准答案**在同一份文件里**，答案集中在文末，
// 标题形如「参考答案」「答案解析」「答案与解析」「标准答案」「答案速查」。
// 这里把答案区切出来，后续交给既有的答案条目解析 + 顺序对齐（resolveAnswerPlan）。
//
// 判定刻意保守：只有「标题行之后确实跟着成串的编号条目」才认。切错的代价是
// 整本书丢答案（甚至把答案当题干），比不切更糟 —— 所以宁可漏判，不可误切。
const ANSWER_HEAD = /^(?:参考|标准)?答案(?:与解析|及解析|与答案解析|解析|速查|和解析)?$/;

function isAnswerHeadLine(line) {
  let t = String(line || '').trim();
  if (!t || t.length > 24) return false;               // 标题不会很长
  if (/^\d{1,4}\s*[.、．)）]/.test(t)) return false;    // 带题号 → 是答案条目本身，不是分界标题
  t = t
    .replace(/^[【\[（(]\s*/, '')
    .replace(/\s*[】\]）)]$/, '')
    .replace(/[：:]\s*$/, '')
    .trim();
  if (ANSWER_HEAD.test(t)) return true;
  // 也接受「第X章 参考答案」「参考答案 第一章」这类带章节前缀的写法
  const segs = t.split(/[\s　]+/).filter(Boolean);
  if (segs.length > 1 && (ANSWER_HEAD.test(segs[segs.length - 1]) || ANSWER_HEAD.test(segs[0]))) return true;
  return false;
}

// 快速估算「编号条目」行数（答案条目必带题号，比完整解析一遍便宜得多）
function countNumberedLines(text) {
  let n = 0;
  String(text || '').split('\n').forEach((l) => {
    if (/^\s*\d{1,4}\s*[.、．)）]/.test(l)) n++;
  });
  return n;
}

// 切入点必在文末，故从后往前找第一个合格标题；找不到即视为纯题目文件
function splitPaper(text) {
  const MIN_ANSWER_LINES = 3;
  const lines = normalizeLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isAnswerHeadLine(lines[i])) continue;
    const answerText = lines.slice(i + 1).join('\n');
    if (countNumberedLines(answerText) < MIN_ANSWER_LINES) continue; // 后面不像答案区 → 不是分界
    return {
      hasAnswer: true,
      headLine: lines[i],
      headIndex: i,
      answerLines: lines.length - i - 1,
      questionText: lines.slice(0, i).join('\n'),
      answerText
    };
  }
  return { hasAnswer: false, headLine: '', headIndex: -1, answerLines: 0, questionText: text, answerText: '' };
}


// ---------- 题目切分 ----------
function splitQuestions(text) {
  const lines = normalizeLines(text);
  const segs = [];
  let cur = null;
  let prev = null;
  let lastNo = null;
  let inMethod = false;
  let methodLines = 0;
  let inMaterial = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 表格数值行：既不是题目，也不该并入题干，直接跳过
    if (isDataRowLine(line)) { prev = line; continue; }
    // 水印/推广行：直接跳过，且不改变"上一行"（避免破坏边界判断）
    if (NOISE_LINE.test(line)) continue;
    // 进入方法讲解块（其内的编号行不是题目）
    if (METHOD_BLOCK_HEAD.test(line.trim())) {
      inMethod = true;
      methodLines = 0;
      if (cur) cur.lines.push(line.trim());
      prev = line;
      continue;
    }
    if (inMethod && ++methodLines > METHOD_BLOCK_MAX) inMethod = false;
    const candidate = isQStart(line, prev, lastNo);
    // 材料块（表格/资料正文区）里的编号行：只有「像真题」才算题。
    // 表格正文被 OCR 出来常带编号感（`58.其中：提取物`、`70.8计算机、通信…`），
    // 认下来就是一道没选项、没答案的伪题（09 实测几十道）。
    // 真材料题题干后紧跟 A./B./C./D.，looksLikeRealQuestion 能认出来。
    if (candidate && inMaterial && !looksLikeRealQuestion(lines, i)) {
      prev = line;
      continue;
    }
    // 方法块内且不像真题（无题源标注、后续无选项行）→ 按正文处理
    if (candidate && inMethod && !looksLikeRealQuestion(lines, i)) {
      if (cur) cur.lines.push(line.trim());
      prev = line;
      continue;
    }
    const tm = candidate ? QSTART.exec(line) : null;
    if (tm) {
      inMethod = false;
      inMaterial = false;
      lastNo = parseInt(tm[1], 10);
      cur = { no: lastNo, lines: [] };
      const rest = line.slice(tm[0].length).trim();
      if (rest) cur.lines.push(rest);
      segs.push(cur);
    } else if (MATERIAL_START.test(line.trim())) {
      // 材料块起点：断开上一题。之后的表格数值行按「首题之前的引言」处理（丢弃），
      // 直到下一题的题号行重新开题 —— 材料正文在纯文本层本来就还原不了表格。
      cur = null;
      inMethod = false;
      inMaterial = true;
      prev = line;
      continue;
    } else if (cur) {
      cur.lines.push(line.trim());
    }
    // 首题之前的内容视为引言/大题说明，忽略
    prev = line;
  }

  const questions = segs.map((seg, i) => {
    const body = seg.lines;
    // 定位第一行选项起点
    let optIdx = -1;
    for (let k = 0; k < body.length; k++) {
      if (OPTLINE.test(body[k])) { optIdx = k; break; }
    }
    let stemLines = body;
    let optText = '';
    if (optIdx >= 0) {
      stemLines = body.slice(0, optIdx);
      optText = body.slice(optIdx).join('\n');
    }
    const stem = stemLines.join('\n').trim().replace(/^[（(]\s*\d*\s*分\s*[)）]\s*/, '').trim();
    return {
      fileNo: seg.no,
      // 无有效题干的片段（如被误判的大题说明行）标记为待过滤
      stem,
      options: parseOptions(optText),
      fileIdx: i
    };
  });

  // 过滤疑似大题说明/目录行：无题干又无选项的短片段
  return questions.filter((q) => {
    if (q.stem || (q.options && q.options.length)) return true;
    return false;
  }).map((q, i) => ({ ...q, canonicalNo: i + 1 }));
}

// 解析选项文本（支持整段中 A.xx B.xx 与换行两种形态）
function parseOptions(optText) {
  if (!optText) return [];
  const re = /[（(]?([A-Ha-h])\s*[)）.、．:：]\s*/g;
  const items = [];
  let m;
  while ((m = re.exec(optText)) !== null) {
    // 忽略紧贴中文字符的字母（如题干里的"选A."），要求前面是空白/换行/括号
    const prev = optText[m.index - 1] || '\n';
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(prev)) continue;
    items.push({ letter: m[1].toUpperCase(), begin: m.index + m[0].length, letterAt: m.index });
  }
  if (!items.length) return [];
  const options = [];
  items.forEach((it, idx) => {
    // 文本区间：本项分隔符之后 ~ 下一项字母之前（避免吞掉下一项）
    const end = idx + 1 < items.length ? items[idx + 1].letterAt : optText.length;
    const text = optText.slice(it.begin, end).trim().replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ');
    if (text) options.push({ key: it.letter, text });
  });
  // 去掉文字为空的悬挂选项（如"B."后无内容）
  return cleanOptionList(options);
}

// ---------- 选项清洗：去空 / 去重 / 剥噪声 / 规范序号 ----------
// 真数据里选项异常有四类来源，这里只做「保证能正常展示」的兜底，绝不猜缺失项的内容：
//   ① 两题粘连 → 同一字母出现两次（A B C D A B C D），去重保留首次出现的那一组；
//   ② 选项行被扫描漏掉 → 序号不从 A 起或跳号（B C D / A B D），统一重排为 A B C…；
//   ③ 页眉页脚 / 跨册提示混进选项文本，剥掉尾巴上的那一段；
//   ④ 答案指向一个不存在的选项（选项丢了）→ 不硬猜，交给 buildOne 标为「存疑」。
const OPT_NOISE_TAIL = /(?:本部分(?:题目|试题)[^。]{0,6}解析见[^。]{0,24}|==\s*第\s*\d+\s*页\s*==)\s*$/;

function cleanOptionText(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.replace(OPT_NOISE_TAIL, '').trim();
}

// 只做「清洗」：去空、同字母去重、剥噪声。序号重排需要连带改答案，放在 buildOne 里做。
function cleanOptionList(options) {
  const out = [];
  const seen = {};
  (options || []).forEach((o) => {
    const key = String((o && o.key) || '').toUpperCase();
    if (!/^[A-H]$/.test(key) || seen[key]) return;
    const text = cleanOptionText(o && o.text);
    if (!text) return;
    seen[key] = 1;
    out.push({ key, text });
  });
  return out;
}

// 序号规范化：不是「A 起、逐个递进」就重排成 A/B/C…，并返回旧字母→新字母的映射表，
// 供答案同步换算。答案里出现映射表中没有的字母 = 那个选项整条丢了，无法还原。
function sanitizeOptions(options) {
  const list = cleanOptionList(options);
  const remap = {};
  let changed = false;
  list.forEach((o, i) => {
    const want = String.fromCharCode(65 + i);
    remap[o.key] = want;
    if (o.key !== want) changed = true;
  });
  const fixed = changed && list.length <= 8
    ? list.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text }))
    : list;
  if (!changed || fixed === list) {
    // 未重排：映射表取恒等，方便调用方无差别使用
    list.forEach((o) => { remap[o.key] = o.key; });
  }
  return { options: fixed, remap, changed: changed && list.length <= 8 };
}

// ---------- 答案归一化 ----------
function normAnswer(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { kind: 'none', value: '' };
  if (/^(对|正确|√|T|是)$/i.test(s)) return { kind: 'judge', value: '对' };
  if (/^(错|错误|×|F|否)$/i.test(s)) return { kind: 'judge', value: '错' };
  const letters = s.toUpperCase().replace(/[^A-H]/g, '');
  if (letters) return { kind: 'choice', value: letters };
  return { kind: 'text', value: s };
}

// ---------- 答案解析文件解析 ----------
// 支持形态（编号须与题目文件一致）：
//   1. C / 1. 答案：C / 1. 答案：C 解析：xxx / 1. A B 形式请用分隔写法
//   1. 参考答案：社会主义……（简答）
//   1-5. C C A D A（聚合）
//   1.A 2.B 3.C（单行多题）
//   答案：C（紧随上一题号占位行）
function parseAnswers(text) {
  const lines = normalizeLines(text);
  const map = {};
  const ensure = (no) => {
    if (!map[no]) map[no] = { no, raw: '', explanation: '' };
    return map[no];
  };
  const appendExpl = (no, t) => {
    const e = ensure(no);
    e.explanation = e.explanation ? `${e.explanation}\n${t}` : t;
  };

  let curNo = null;   // 当前上下文题号（用于承接"解析："与独立"答案："行）
  let explOpen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { if (curNo != null) explOpen = false; continue; }
    if (/^(第\s*)?\d+\s*页/.test(line)) continue;

    let m;
    // 1) 聚合：1-5. CCADA / 1-5 CCADA
    m = line.match(/^\s*(\d{1,4})\s*[-~～至]\s*(\d{1,4})\s*[.、．)）]?\s*[:：、]?\s*(?:答案|参考答案|答|【答案】)?\s*[:：]?\s*([A-Ha-h][A-Ha-h\s,，、]*)$/);
    if (m) {
      const from = +m[1];
      const to = +m[2];
      const letters = m[3].toUpperCase().replace(/[^A-H]/g, '').split('');
      letters.forEach((L, k) => { if (from + k <= to) ensure(from + k).raw = L; });
      curNo = from + Math.max(letters.length - 1, 0);
      explOpen = false;
      continue;
    }
    // 1b) 编号 + 带元数据的答案行（形如 1.（答案A。粉笔大数据… / 2.【答案】D。粉笔大数据…）
    //     【解析】正文可能同行或随后续行，一并归入 explanation
    m = line.match(/^\s*(\d{1,4})\s*[.、．)）]\s*[（(]?\s*(?:答案|参考答案|答|【答案】)\s*[:：]?\s*([A-Ha-h对错正误√×]{1,10}|正确|错误|对|错)\s*[。．.,，]?\s*(.*)$/);
    if (m) {
      const no = +m[1];
      ensure(no).raw = m[2].toUpperCase();
      const rest = (m[3] || '').trim();
      const em = rest.search(/(?:【解析】|【详解】|解析|详解|解释|理由)/);
      const expl = em >= 0 ? rest.slice(em).replace(/^\s*【?(?:解析|详解|解释|理由)】?\s*[:：]?\s*/, '') : '';
      if (expl) appendExpl(no, expl);
      curNo = no;
      explOpen = !!expl;
      continue;
    }
    // 2a) 编号 + 显式"答案："关键字（可含简答长文本与内联解析）
    m = line.match(/^\s*(\d{1,4})\s*[.、．)）]\s*(?:答案|参考答案|答|【答案】)\s*[:：]?\s*([^:：\n]+?)(?:\s*(?:解析|详解|解释|理由)\s*[:：]?\s*(.*))?$/);
    if (m) {
      const no = +m[1];
      ensure(no).raw = m[2].trim();
      if (m[3] && m[3].trim()) appendExpl(no, m[3].trim());
      curNo = no;
      explOpen = !!(m[3] && m[3].trim());
      continue;
    }
    // 2b) 编号 + 纯字母/判断题答案（整行约束，防止误吞"1.A 2.B"并列格式）
    m = line.match(/^\s*(\d{1,4})\s*[.、．)）]\s*([A-Ha-h]{1,10}|正确|错误|对|错|√|×)(?:\s*(?:解析|详解|解释|理由)\s*[:：]?\s*(.*))?$/);
    if (m) {
      const no = +m[1];
      ensure(no).raw = m[2];
      if (m[3] && m[3].trim()) appendExpl(no, m[3].trim());
      curNo = no;
      explOpen = !!(m[3] && m[3].trim());
      continue;
    }
    // 3) 单行多题：1.A 2.B 3.C
    if (/^\s*\d{1,4}\s*[.、．)）]\s*[A-Ha-h]\s/.test(line)) {
      const g = /(\d{1,4})\s*[.、．)）]\s*([A-Ha-h])(?=\s|$)/g;
      let mm; let last = null;
      while ((mm = g.exec(line)) !== null) { ensure(+mm[1]).raw = mm[2]; last = +mm[1]; }
      if (last != null) curNo = last;
      explOpen = false;
      continue;
    }
    // 4) 独立"答案："行（承接上一题号）
    m = line.match(/^\s*(?:答案|参考答案|答|【答案】)\s*[:：]?\s*([^:：\n]+?)(?:\s*(?:解析|详解|解释|理由)\s*[:：]?\s*(.*))?$/);
    if (m && curNo != null) {
      ensure(curNo).raw = m[1].trim();
      if (m[2] && m[2].trim()) appendExpl(curNo, m[2].trim());
      explOpen = !!(m[2] && m[2].trim());
      continue;
    }
    // 5) 纯题号占位行："12."
    m = line.match(/^\s*(\d{1,4})\s*[.、．)）]\s*$/);
    if (m) { curNo = +m[1]; explOpen = false; continue; }
    // 6) 单独"解析："
    m = line.match(/^\s*(?:解析|详解|解释|【解析】|【详解】|理由)\s*[:：]?\s*(.*)$/);
    if (m) {
      if (curNo != null && m[1].trim()) { appendExpl(curNo, m[1].trim()); explOpen = true; }
      continue;
    }
    // 7) 普通续行：解析段落延续
    if (curNo != null && explOpen) { appendExpl(curNo, line); continue; }
    // 其余内容忽略
  }

  const list = Object.keys(map)
    .map((n) => +n)
    .sort((a, b) => a - b)
    .map((no) => {
      const e = map[no];
      const canon = normAnswer(e.raw);
      return {
        no,
        raw: e.raw,
        kind: canon.kind,
        answer: canon.value,
        explanation: (e.explanation || '').trim()
      };
    });
  return list;
}

// ---------- 解析册「顺序条目」抽取（不去重） ----------
// 上述 parseAnswers 按题号去重，只适合题号全局唯一的答案文件；
// 而解析册的题号在每个考点/小节内会重新从 1 开始，去重后会只剩下 1..N 一组。
// 因此这里按文档顺序完整抽取，供「顺序对齐」使用。
// 覆盖形态：1.【答案】B。… ／ 1.（答案A。… ／ 1. 答案：C 解析：… ／ 1.D
// 答案位的捕获范围要与 normAnswerKind 的能力对齐，否则「捕获不到」会伪装成「没有答案」：
//   多选连写 ABD ✓ / 多选带分隔 A、C ✓ / 判断 对·错·正确·错误·√·× ✓
// 注意第一个分支必须以 [A-Ha-h] 开头（而不是放进同一个字符类），
// 否则「正确」会被逐字吃掉、只剩「正」。
const EXPL_HEAD = /^\s*(\d{1,4})\s*[.、．)）]\s*[（(]?\s*(?:【答案】|答案|参考答案|答)\s*[:：]?\s*([A-Ha-h][A-Ha-h,，、 ]{0,15}|正确|错误|对|错|正|误|√|×)\s*[。．.,，]?\s*(.*)$/;
const EXPL_HEAD_PLAIN = /^\s*(\d{1,4})\s*[.、．)）]\s*([A-Ha-h][A-Ha-h,，、 ]{0,15})(?:\s*$|\s*[（(【])/;
// 结尾定论位：允许「故正确答案为ABD。」这类多选写法（早期只认单个字符）
const EXPL_TAIL = /故?\s*正确答案为\s*([A-Ha-h]{1,10}|正确|错误|对|错)\s*[。．.]?/;

function parseAnswerEntries(text) {
  const lines = normalizeLines(text);
  const entries = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let h = EXPL_HEAD.exec(line);
    if (!h) h = EXPL_HEAD_PLAIN.exec(line);
    if (h) {
      const kind = normAnswerKind(h[2]);
      let rest = (h[3] || '').trim()
        .replace(/^\s*【?(?:解析|详解|解释|理由)】?\s*[:：]?\s*/, '')
        .trim();
      cur = { no: +h[1], kind: kind.kind, answer: kind.answer, raw: String(h[2]).toUpperCase(), explanation: rest, tail: '' };
      entries.push(cur);
      const t = EXPL_TAIL.exec(line);
      if (t) cur.tail = normAnswerKind(t[1]).answer;
      continue;
    }
    if (!cur) continue;
    const t = EXPL_TAIL.exec(line);
    if (t) {
      // 结尾定论语句单独记录，不作为解析正文
      if (!cur.tail) cur.tail = normAnswerKind(t[1]).answer;
      const left = line.replace(EXPL_TAIL, '').trim();
      if (left) cur.explanation = cur.explanation ? `${cur.explanation}\n${left}` : left;
      continue;
    }
    cur.explanation = cur.explanation ? `${cur.explanation}\n${line}` : line;
  }
  return entries.map((e) => ({
    no: e.no,
    raw: e.raw,
    kind: e.kind,
    answer: e.answer,
    explanation: (e.explanation || '').trim(),
    tailAnswer: e.tail || ''
  }));
}

// ---------- 题目与答案匹配、题型归类 ----------
const JUDGE_OPTIONS = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];

// 单题装配：把一条答案条目挂到题目上（entry 可为 null）
function buildOne(q, entry) {
  const matched = !!entry;
  let type = 'single';
  let answer = '';
  let answerKey = '';
  let explanation = '';
  // '' = 正常；否则记录「答案用不上」的原因，页面据此给不同的解释
  //   missingOption = 答案指向的选项整条丢失（扫描漏行）
  //   typeConflict  = 答案与题目形态自相矛盾（说是判断题，题目却有 3 个以上选项）
  let answerSuspectKind = '';
  // 选项先在 buildOne 里过一遍清洗与序号规范化：同一字母的重复项、跳号/不从 A 起的
  // 序号都会在展示层变成"看不懂的选项"，这里统一压成 A/B/C… 并给出字母映射表。
  const san = sanitizeOptions(q.options || []);
  let options = san.options;

  if (entry) {
    answer = entry.kind === 'judge' ? (entry.answer === '对' ? '正确' : '错误') : entry.answer;
    explanation = entry.explanation || '';
  }

  if (entry && entry.kind === 'judge') {
    // 答案写的是「对 / 错」，题目却有 3 个以上选项 —— 这两件事不可能同时成立
    // （判断题只有两种状态）。多半是答案解析文件选错了，或顺序对齐串了位。
    // 盲信答案条目的后果很隐蔽：题目会被标成「判断题」，选项照旧展示 4 条，
    // 而判分把 A 当「正确」、B 当「错误」—— 考生选 C、D 永远判错，且看不出为什么。
    // 所以只认「没有选项」或「正好两个选项」的判断题，其余一律不采信。
    // （1 个选项同理：那多半是 OCR 丢了另一条，留着会让「错」这个答案无处可选）
    if (options.length === 1 || options.length > 2) {
      answerSuspectKind = 'typeConflict';
    } else {
      type = 'judge';
      if (!options.length) options = JUDGE_OPTIONS;
      answerKey = entry.answer === '对' ? 'A' : 'B';
    }
  } else if (entry && entry.kind === 'choice' && options.length) {
    const raw = String(entry.answer || '').toUpperCase().replace(/[^A-H]/g, '').split('');
    const mapped = raw.map((c) => san.remap[c]).filter(Boolean);
    if (raw.length && mapped.length === raw.length) {
      // 全部字母都能换算到现有选项上 —— 序号重排后答案依然对得上，
      // 展示用的答案文本同步换算（否则会出现「参考答案 C」但选项里 C 是另一条）
      answerKey = mapped.sort().join('');
      answer = answerKey;
      type = answerKey.length > 1 ? 'multi' : 'single';
    } else {
      // 答案指向的选项整条丢失（扫描漏行）：不猜，转成自评，避免自动判分永远判错
      answerSuspectKind = 'missingOption';
      type = 'single';
    }
  } else if (entry && entry.kind === 'choice') {
    // 无选项却有字母答案 → 无法自动判定，按主观题展示参考答案
    type = 'text';
    answerKey = '';
  } else {
    // 无匹配或文字答案
    type = options.length ? 'single' : 'text';
    answerKey = '';
    answer = entry ? entry.answer : '';
  }

  return {
    no: q.canonicalNo,
    stem: q.stem,
    options,
    type,
    answer,
    answerKey,
    explanation,
    matched,
    // true = 答案用不上（见 answerSuspectKind），页面按自评处理
    answerSuspect: !!answerSuspectKind,
    answerSuspectKind
  };
}

// 按「题号」匹配（仅适合题号全局唯一的答案文件；题号重复时会互相覆盖）
function buildQuestions(questions, answers) {
  const answerMap = {};
  (answers || []).forEach((a) => { answerMap[a.no] = a; });
  return questions.map((q) => buildOne(q, answerMap[q.fileNo] || answerMap[q.canonicalNo] || null));
}

// 按「位置」匹配：entries[i] 对应 questions[i]（null 表示该题没有答案）
// 题号在书内会按考点/小节重新编号，因此顺序对齐的结果必须按位置装配。
function buildQuestionsByPosition(questions, entries) {
  return questions.map((q, i) => buildOne(q, (entries && entries[i]) || null));
}

// ---------- 参考答案速览解析（区间+字母串 / 纯字母行 / OCR 残缺容错） ----------
const LETTER_OK = /^[A-Ha-h对错正误√×]$/;

function lettersOf(s) {
  const out = [];
  for (const ch of (s || '')) {
    const c = ch.toUpperCase ? ch.toUpperCase() : ch;
    if (LETTER_OK.test(c)) out.push(c);
  }
  return out;
}

function splitIntPair(digits, nLetters) {
  // '610' + 5个字母 → 试图拆成 start=6, end=10
  for (let k = 1; k < digits.length; k++) {
    const s = parseInt(digits.slice(0, k), 10);
    const e = parseInt(digits.slice(k), 10);
    if (s >= 1 && e >= s && e - s + 1 === nLetters) return { s, e };
  }
  return null;
}

// 解析速览文本为【字母序列】；容错：1-5 ADACA / 1—5 CCADA / 610 ADDDC / 6C / 纯字母串
function parseAnswerKey(text) {
  const lines = (text || '').split('\n');
  const letters = [];
  for (let raw of lines) {
    raw = (raw || '').trim();
    if (!raw) continue;
    const tokens = raw.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      let m = /^(\d{1,3})\s*[-~～至]\s*(\d{1,3})[:：]?\s*([A-Ha-h对错正误√×]+)$/.exec(tok);
      if (m) {
        const ls = lettersOf(m[3]);
        letters.push(...ls);
        continue;
      }
      m = /^([A-Ha-h对错正误√×]{1,})$/.exec(tok);
      if (m) { letters.push(...lettersOf(m[1])); continue; }
      // 残缺形态：纯数字(可能丢了连字符)后跟字母
      if (/^\d{2,3}$/.test(tok) && i + 1 < tokens.length && /^[A-Ha-h对错正误√×]{2,}$/.test(tokens[i + 1])) {
        const ls = lettersOf(tokens[i + 1]);
        const pair = splitIntPair(tok, ls.length);
        if (pair) {
          letters.push(...ls);
          i++; // 消费下一 token
          continue;
        }
      }
      m = /^(\d{1,3})([A-Ha-h对错正误√×]+)$/.exec(tok); // 如 6C
      if (m) { letters.push(...lettersOf(m[2])); continue; }
    }
  }
  return { letters };
}

// 答案归一化。调用方有两类，必须同时兼容：
//   1) 速览字母流按**单个字符**逐个喂进来（parseAnswerKey）
//   2) 解析册条目一次给出**整串**答案（parseAnswerEntries 的【答案】位、结尾定论位）
//
// 早期版本只写了单字符匹配（/^[A-H]$/），导致两类答案被静默判成「无答案」：
//   多选题  ABD / A、C   → 答案丢失，题面还显示「已匹配」但答案是空的
//   判断题  正确 / 错误  → 只有单字「对 / 错」能用，两字写法失效
// 所以这里改为「先去符号再抽字母」，并显式接受对错的各种写法。
function normAnswerKind(ch) {
  const s = String(ch == null ? '' : ch).trim();
  if (!s) return { kind: 'none', answer: '' };
  if (/^(对|正确|正|√|T|是)$/i.test(s)) return { kind: 'judge', answer: '对' };
  if (/^(错|错误|误|×|F|否)$/i.test(s)) return { kind: 'judge', answer: '错' };
  // 只由字母与分隔符组成才当选项答案，避免把「C项正确」这类正文误判成答案
  if (/^[A-Ha-h][A-Ha-h\s,，、]*$/.test(s)) {
    return { kind: 'choice', answer: s.toUpperCase().replace(/[^A-H]/g, '') };
  }
  return { kind: 'none', answer: '' };
}

// 通用对齐裁决：把“答案解析/参考答案”文本映射到各分卷题目
// ---------- 顺序对齐：题目序列 ↔ 答案解析条目序列 ----------
// 题号在书内会按考点/小节/「作业题」组重新从 1 开始，因此不能按题号建索引映射；
// 这里改用「全局顺序 + 单调对齐」：把两条序列按文档顺序配对，只在顺序上不错位。
const ALIGN_SKIP = 1.2;      // 某一侧多出/缺失一项的代价
function alignCost(qn, an) {
  if (qn === an) return 0;                       // 题号相同，最可信
  if (qn === 1 && an === 1) return 0.1;          // 同时开头，视为同一节起点
  const d = Math.abs(qn - an);
  return d <= 2 ? 0.6 : 2.0;
}

// 返回 pairs: [[题本下标, 解析下标]]，-1 表示该侧未配对
function alignByNoSequence(qNos, aNos) {
  const n = qNos.length, m = aNos.length;
  if (!n || !m) return [];
  const W = m + 1;
  const dir = new Uint8Array((n + 1) * W);   // 1=配对 2=题本多出 3=解析多出
  let prev = new Float64Array(W);
  let cur = new Float64Array(W);
  for (let j = 0; j <= m; j++) prev[j] = j * ALIGN_SKIP;
  for (let i = 1; i <= n; i++) {
    cur[0] = i * ALIGN_SKIP;
    dir[i * W] = 2;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + alignCost(qNos[i - 1], aNos[j - 1]);
      const up = prev[j] + ALIGN_SKIP;
      const left = cur[j - 1] + ALIGN_SKIP;
      let best = diag, d = 1;
      if (up < best) { best = up; d = 2; }
      // 平局时优先"跳过解析侧本项"：保证从头开始一一对应，
      // 避免多出来的一条解析把后面整段答案往前拉。
      if (left <= best) { best = left; d = 3; }
      cur[j] = best;
      dir[i * W + j] = d;
    }
    const t = prev; prev = cur; cur = t;
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const d = dir[i * W + j];
    if (i > 0 && j > 0 && d === 1) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && (j === 0 || d === 2)) { pairs.push([i - 1, -1]); i--; }
    else { pairs.push([-1, j - 1]); j--; }
  }
  return pairs.reverse();
}

// 顺序对齐整本书，返回与各卷题目一一对应的条目数组（未匹配处为 null）
function alignAnswerEntries(segs, aText) {
  const entries = parseAnswerEntries(aText);
  const qFlat = [];
  segs.forEach((s, pi) => (s.questions || []).forEach((q, qi) => qFlat.push({ pi, qi, no: q.fileNo })));
  const perPart = segs.map((s) => (s.questions || []).map(() => null));
  if (!entries.length || !qFlat.length) {
    return { mode: 'sequential', perPart, matched: 0, unmatchedQuestions: qFlat.length, orphanAnswers: entries.length, entries };
  }
  const pairs = alignByNoSequence(qFlat.map((x) => x.no), entries.map((e) => e.no));
  let matched = 0;
  pairs.forEach(([qi, aj]) => {
    if (qi < 0 || aj < 0) return;
    perPart[qFlat[qi].pi][qFlat[qi].qi] = entries[aj];
    matched++;
  });
  return {
    mode: 'sequential',
    perPart,
    matched,
    unmatchedQuestions: qFlat.length - matched,   // 题本有题、答案里找不到
    orphanAnswers: entries.length - matched,      // 答案里有、题本没有（多余条目）
    entries
  };
}

// 通用对齐裁决
// segs: [{ title, count, questions? }]（questions 可选；有则做顺序对齐）
// 返回 { mode, perPart }，perPart[i][j] 与 segs[i] 的第 j 题一一对应（未匹配为 null）
// 顺序对齐可容忍两侧少量缺失，因此不再「对不齐即报错」；但匹配率过低仍会抛错，避免错配。
function resolveAnswerPlan(segs, aText) {
  const total = segs.reduce((s, x) => s + x.count, 0);
  const hasQuestions = segs.every((s) => Array.isArray(s.questions));

  // 1) 顺序对齐（首选，可容忍缺失；题号重复也适用）
  if (hasQuestions) {
    const plan = alignAnswerEntries(segs, aText);
    if (plan.matched > 0 && plan.matched / total >= 0.5) return plan;
  }

  // 2) 答案解析自带与题目同构的章节标题 → 逐卷按位置对齐
  const aParts = splitParts(aText).filter((p) => /(?:^|\n)\s*\d/.test('\n' + p.text));
  if (aParts.length === segs.length) {
    const perPart = aParts.map((p, i) => {
      const entries = parseAnswerEntries(p.text);
      const cnt = segs[i].count;
      const out = new Array(cnt).fill(null);
      for (let k = 0; k < Math.min(cnt, entries.length); k++) out[k] = entries[k];
      return out;
    });
    const hit = perPart.reduce((a, arr) => a + arr.filter(Boolean).length, 0);
    if (hit >= Math.min(total, 4)) return { mode: 'header', perPart, matched: hit, unmatchedQuestions: total - hit, orphanAnswers: 0 };
  }

  // 3) 全局连续编号答案（1. C / 1-5. CCADA，编号唯一）→ 顺序分配
  const list = parseAnswers(aText);
  if (list.length === total && list.every((e) => e.kind !== 'none')) {
    return { mode: 'numbered', perPart: sliceInto(list, segs), matched: total, unmatchedQuestions: 0, orphanAnswers: 0 };
  }

  // 4) 参考答案速览字母流（数量=总题数）→ 顺序分配
  const key = parseAnswerKey(aText);
  if (key.letters.length === total) {
    const perPart = [];
    let off = 0;
    for (const s of segs) {
      const slice = key.letters.slice(off, off + s.count);
      perPart.push(slice.map((ch) => {
        const k = normAnswerKind(ch);
        return { no: 0, kind: k.kind, answer: k.answer, raw: ch, explanation: '' };
      }));
      off += s.count;
    }
    return { mode: 'key', perPart, matched: total, unmatchedQuestions: 0, orphanAnswers: 0 };
  }

  const diag = [];
  if (hasQuestions) {
    const plan = alignAnswerEntries(segs, aText);
    diag.push(`顺序对齐仅匹配到 ${plan.matched}/${total} 题（需 ≥50%）`);
    diag.push(`解析条目 ${plan.entries.length} 条`);
  }
  if (list.length !== total) diag.push(`编号答案 ${list.length} 条 vs 题目 ${total} 题`);
  if (key.letters.length !== total) diag.push(`速览字母 ${key.letters.length} 个 vs 题目 ${total} 题`);
  throw new Error('参考答案/解析无法与题目对齐：' + diag.join('；') + '。请确认答案/解析文件与题目文件来自同一本书');
}

function sliceInto(list, segs) {
  const perPart = [];
  let off = 0;
  for (const s of segs) {
    perPart.push(list.slice(off, off + s.count));
    off += s.count;
  }
  return perPart;
}

module.exports = {
  SUPPORTED,
  splitQuestions,
  splitParts,
  buildOne,
  parseOptions,
  sanitizeOptions,
  splitPaper,
  parseAnswers,
  parseAnswerEntries,
  buildQuestions,
  buildQuestionsByPosition,
  alignAnswerEntries,
  alignByNoSequence,
  resolveAnswerPlan,
  parseAnswerKey
};
