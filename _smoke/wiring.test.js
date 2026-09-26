// 接线检查：页面注册、文件齐备、WXML 事件绑定都能落到真实方法上
// 运行：node _smoke/wiring.test.js
//
// 为什么需要它：小程序里 bindtap="xxx" 拼错、或新增页面忘了在 app.json 注册，
// 都不会在编译期报错，而是"点了没反应 / 跳转失败"。这类 bug 在开发者工具里要
// 手点一遍才发现，用静态检查几毫秒就能挡住。
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '../miniprogram');

const mem = {};
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  showToast: () => {}, showModal: () => {}, navigateTo: () => {},
  switchTab: () => {}, redirectTo: () => {}, navigateBack: () => {},
  setNavigationBarTitle: () => {}, pageScrollTo: () => {}
};
global.getApp = () => ({ globalData: {} });

const wxMock = require('./lib/wx-mock.js');
wxMock.attach(global.wx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

// WXML 里的 bindXxx / bind:xxx / catchXxx="handlerName"
// 排除 {{...}} 绑定（那是表达式，不是方法名）
const BIND_RE = /\b(?:bind|catch)[:a-z]*\s*=\s*"([A-Za-z_$][\w$]*)"/g;

function handlersIn(wxmlPath) {
  const src = fs.readFileSync(wxmlPath, 'utf8');
  const names = new Set();
  let m;
  while ((m = BIND_RE.exec(src))) names.add(m[1]);
  return Array.from(names).sort();
}

function listDirs(p) {
  return fs.readdirSync(p).filter((n) => fs.statSync(path.join(p, n)).isDirectory());
}

console.log('=== 1. app.json 注册的页面都存在且四件套齐备 ===');
const appJson = JSON.parse(fs.readFileSync(path.join(BASE, 'app.json'), 'utf8'));
const missing = [];
appJson.pages.forEach((p) => {
  ['.js', '.json', '.wxml', '.wxss'].forEach((ext) => {
    if (!fs.existsSync(path.join(BASE, p + ext))) missing.push(p + ext);
  });
});
eq('注册页面的四件套无缺失', missing, []);

console.log('\n=== 2. pages/ 下的目录都已在 app.json 注册 ===');
const pageDirs = listDirs(path.join(BASE, 'pages'));
const registered = appJson.pages.map((p) => p.split('/')[p.split('/').length - 2]);
eq('未注册的页面目录', pageDirs.filter((d) => registered.indexOf(d) < 0), []);

console.log('\n=== 3. 每个页面的 WXML 绑定都能落到真实方法上 ===');
pageDirs.forEach((name) => {
  const jsPath = path.join(BASE, 'pages', name, name + '.js');
  const wxmlPath = path.join(BASE, 'pages', name, name + '.wxml');
  if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) return;

  let captured = null;
  global.Page = (obj) => { captured = obj; };
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);

  const missingHandlers = handlersIn(wxmlPath).filter((h) => typeof captured[h] !== 'function');
  eq(`pages/${name} 绑定方法齐备`, missingHandlers, []);
});

console.log('\n=== 4. 组件的 WXML 绑定能落到 methods / observers 上 ===');
listDirs(path.join(BASE, 'components')).forEach((name) => {
  const jsPath = path.join(BASE, 'components', name, 'index.js');
  const wxmlPath = path.join(BASE, 'components', name, 'index.wxml');
  if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) return;

  let captured = null;
  global.Component = (obj) => { captured = obj; };
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);

  const methods = captured.methods || {};
  const props = captured.properties || {};
  const allowed = new Set(Object.keys(methods));
  Object.keys(captured.observers || {}).forEach((k) => allowed.add(k));
  Object.keys(props).forEach((k) => {
    if (typeof props[k].observer === 'string') allowed.add(props[k].observer);
    if (typeof props[k].observer === 'function') allowed.add('__fn__' + k);
  });

  const missingHandlers = handlersIn(wxmlPath).filter((h) => !allowed.has(h));
  eq(`components/${name} 绑定方法齐备`, missingHandlers, []);
});

console.log('\n=== 5. 组件自定义事件的绑定方在父页面里也有对应方法 ===');
// errata-sheet 被 quiz 页以 bind:close / bind:saved 的方式挂上去
const quizJs = path.join(BASE, 'pages/quiz/quiz.js');
let quizPage = null;
global.Page = (obj) => { quizPage = obj; };
delete require.cache[require.resolve(quizJs)];
require(quizJs);
const quizHandlers = handlersIn(path.join(BASE, 'pages/quiz/quiz.wxml'));
eq('quiz 页处理组件回调 closeErrata / onErrataSaved',
  quizHandlers.filter((h) => h === 'closeErrata' || h === 'onErrataSaved').sort(),
  ['closeErrata', 'onErrataSaved']);
eq('两个都能落到方法上',
  quizHandlers.filter((h) => (h === 'closeErrata' || h === 'onErrataSaved') && typeof quizPage[h] !== 'function'),
  []);

console.log('\n=== 6. 页面里 navigateTo / switchTab 的目标都已在 app.json 注册 ===');
const routeRe = /(?:url:\s*`|url:\s*')(\/pages\/[a-z]+\/[a-z]+)/g;
const badRoutes = [];
pageDirs.forEach((name) => {
  const jsPath = path.join(BASE, 'pages', name, name + '.js');
  if (!fs.existsSync(jsPath)) return;
  const src = fs.readFileSync(jsPath, 'utf8');
  let m;
  while ((m = routeRe.exec(src))) {
    if (appJson.pages.indexOf(m[1].slice(1)) < 0) badRoutes.push(`${name} → ${m[1]}`);
  }
});
eq('没有指向未注册页面的跳转', badRoutes, []);

console.log('\n=== 7. tabBar 指向的页面必须已在 pages 里 ===');
const tabPages = (appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).map((t) => t.pagePath);
eq('tabBar 页面都已注册', tabPages.filter((p) => appJson.pages.indexOf(p) < 0), []);

// ---------------------------------------------------------------------------
// 8. WXML 里 wx:for 的循环变量引用，必须对得上声明
//
// 为什么需要它：wx:for 的默认循环变量是 item，写成 {{c.label}} 又不声明
// wx:for-item="c"，取到的就是 undefined —— 表现是「框在、文字空、点了没反应」。
// 数据层测试全绿照样漏，因为它只测 Page.data，不看模板怎么取。
// ---------------------------------------------------------------------------
// 注意：斜杠一律写成 [/]，不用 \/ —— 这个文件里 \/ 曾被转义层吃掉反斜杠，
// 导致正则字面量提前闭合，报「Unterminated group」。
const TAG_RE = /<([/]?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)([/]?)>/g;
const REF_RE = /\{\{([\s\S]*?)\}\}/g;

// 页面/组件的 data 顶层字段名 —— 模板里能直接引用的「根」变量
function dataKeys(jsPath) {
  if (!fs.existsSync(jsPath)) return new Set();
  const src = fs.readFileSync(jsPath, 'utf8');
  const keys = new Set();
  ['data', 'properties'].forEach((field) => {
    const i = src.indexOf(field + ':');
    if (i < 0) return;
    const j = src.indexOf('{', i);
    let depth = 0, k = j;
    while (k < src.length) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) break; }
      k++;
    }
    let d = 0;
    src.slice(j + 1, k).split('\n').forEach((line) => {
      d += (line.match(/\{/g) || []).length + (line.match(/\[/g) || []).length
        - (line.match(/\}/g) || []).length - (line.match(/\]/g) || []).length;
      if (d <= 1) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
        if (m) keys.add(m[1]);
      }
    });
  });
  return keys;
}

// 找出「引用了名字却没声明」的循环体，返回 { problems, loops }
// loops 是实际扫到的循环数 —— 用它挡住「检查器什么都没解析到、于是永远通过」
function scanLoops(src, roots) {
  const stack = [];
  const problems = [];
  let loops = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2];
    const attrs = m[3];
    const selfClose = m[4] === '/';
    const tagEnd = m.index + m[0].length;

    if (closing) {
      if (!stack.length || stack[stack.length - 1].name !== name) {
        if (stack.length) stack.pop();
        continue;
      }
      const open = stack.pop();
      if (open.attrs.indexOf('wx:for=') < 0) continue;
      loops++;

      const inner = src.slice(open.tagEnd, m.index);
      // 合法名 = 自身 + 祖辈循环变量 + 子树里自己声明过的（嵌套循环）
      const legit = new Set(stack.map((s) => s.itemVar));
      legit.add(open.itemVar);
      let im;
      const innerItem = /wx:for-item="([^"]+)"/g;
      while ((im = innerItem.exec(inner))) legit.add(im[1]);
      // 子循环若用默认循环变量，也会在子树里写 item —— 那是它自己的，不算错
      const innerFor = (inner.match(/wx:for="/g) || []).length;
      const innerNamed = (inner.match(/wx:for-item="/g) || []).length;
      if (innerFor > innerNamed) legit.add('item');

      const used = new Set();
      let rm;
      REF_RE.lastIndex = 0;
      while ((rm = REF_RE.exec(inner))) {
        // 只看成员链的根：`bk.chapters.length` 里 chapters 是属性，不是根变量
        const idRe = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\./g;
        let idm;
        while ((idm = idRe.exec(rm[1]))) used.add(idm[1]);
      }

      const wrong = Array.from(used).filter((u) => !legit.has(u) && !roots.has(u)).sort();
      if (wrong.length) {
        problems.push({
          line: src.slice(0, open.start).split('\n').length,
          expr: (/wx:for="\{\{([^}]+)\}\}"/.exec(open.attrs) || [, '?'])[1],
          itemVar: open.itemVar,
          wrong
        });
      }
      continue;
    }
    if (selfClose) continue;
    const iv = /wx:for-item="([^"]+)"/.exec(attrs);
    stack.push({ name, attrs, start: m.index, tagEnd, itemVar: iv ? iv[1] : 'item' });
  }
  return { problems, loops };
}

const wxmlFiles = [];
pageDirs.forEach((n) => wxmlFiles.push(path.join(BASE, 'pages', n, n + '.wxml')));
listDirs(path.join(BASE, 'components')).forEach((n) => wxmlFiles.push(path.join(BASE, 'components', n, 'index.wxml')));

const loopBad = [];
let loopCount = 0;
wxmlFiles.forEach((wxmlPath) => {
  if (!fs.existsSync(wxmlPath)) return;
  const jsPath = wxmlPath.replace(/\.wxml$/, '.js');
  const roots = dataKeys(jsPath);
  const r = scanLoops(fs.readFileSync(wxmlPath, 'utf8'), roots);
  loopCount += r.loops;
  r.problems.forEach((p) => {
    loopBad.push(`${path.basename(wxmlPath)} L${p.line} wx:for=${p.expr} (item=${p.itemVar}) 却引用 ${p.wrong.join(',')}`);
  });
});
eq('WXML 里 wx:for 的循环变量引用都对得上声明', loopBad, []);
// 反空断言：确认真的解析到了循环，而不是「一个都没扫到所以永远通过」
ok(`扫到了足够多的 wx:for 循环（实扫 ${loopCount} 个）`, loopCount >= 20);

// 检查器自身的自检：坏样例必须被抓到，好的不能误报（否则上面那条断言是空的）
eq('检查器能抓到变量名不匹配',
  scanLoops('<view wx:for="{{rows}}"><text>{{c.label}}</text></view>', new Set()).problems.length, 1);
eq('检查器不误报显式声明的循环',
  scanLoops('<view wx:for="{{rows}}" wx:for-item="c"><text>{{c.label}}</text></view>', new Set()).problems.length, 0);
eq('检查器不误报嵌套循环',
  scanLoops('<view wx:for="{{rows}}" wx:for-item="r"><view wx:for="{{r.list}}"><text>{{item.k}} {{r.k}}</text></view></view>', new Set()).problems.length, 0);
eq('检查器不误报 data 根字段',
  scanLoops('<view wx:for="{{rows}}"><text>{{sheet.n}} {{item.k}}</text></view>', new Set(['sheet'])).problems.length, 0);
eq('检查器不把属性名当根变量',
  scanLoops('<view wx:for="{{rows}}"><text>{{item.a.b.c}}</text></view>', new Set()).problems.length, 0);

// ---------------------------------------------------------------------------
// 9. 组件的样式要么自包含，要么声明 styleIsolation
//
// 为什么需要它：自定义组件默认 styleIsolation: isolated，此时 app.wxss 里的
// **类选择器**对组件内部不生效（只有标签名选择器等少数会穿透）。answer-sheet
// 的遮罩/面板用了全局的 .mask / .sheet 定位，却没声明隔离级别 → 面板弹出来
// 没有 fixed、没有背景、没有 z-index，页面上什么都看不到，表现就是
// 「补答案按钮点了没反应」。组件 JS、WXML 全对，数据层测试全绿，都挡不住它。
// ---------------------------------------------------------------------------
function classRefs(wxml) {
  const out = [];
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(wxml))) {
    // {{...}} 是动态类名，静态判不了，剥掉再分词
    m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ').split(/\s+/).filter(Boolean).forEach((c) => {
      if (out.indexOf(c) < 0) out.push(c);
    });
  }
  return out;
}

function cssClassSet(cssPath) {
  const s = new Set();
  if (!fs.existsSync(cssPath)) return s;
  const src = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /\.(-?[A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(src))) s.add(m[1]);
  return s;
}

// 判定抽成纯函数，方便下面的自检直接喂样例
function isolationProblems(refs, own, app, iso) {
  const fromApp = refs.filter((c) => !own.has(c) && app.has(c));
  const shared = iso === 'apply-shared' || iso === 'shared';
  return (fromApp.length && !shared) ? fromApp : [];
}

const appCssPath = path.join(BASE, 'app.wxss');
const appClasses = cssClassSet(appCssPath);

const isoBad = [];
const compDirs = listDirs(path.join(BASE, 'components'));
compDirs.forEach((name) => {
  const dir = path.join(BASE, 'components', name);
  const wxmlPath = path.join(dir, 'index.wxml');
  if (!fs.existsSync(wxmlPath)) return;
  const jsonPath = path.join(dir, 'index.json');
  const cfg = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
  const iso = cfg.styleIsolation || 'isolated';
  const bad = isolationProblems(
    classRefs(fs.readFileSync(wxmlPath, 'utf8')),
    cssClassSet(path.join(dir, 'index.wxss')),
    appClasses,
    iso
  );
  if (bad.length) isoBad.push(`${name}(${iso}): ${bad.join(',')}`);
});
eq('依赖 app.wxss 全局类的组件都声明了 styleIsolation', isoBad, []);

// 反空断言：确认样式表和组件真的被读到了，而不是「什么都没解析到所以永远通过」
ok(`app.wxss 里解析到足够多的类（实扫 ${appClasses.size} 个）`, appClasses.size >= 30);
ok(`扫到了 ${compDirs.length} 个组件`, compDirs.length >= 2);

// 回归保护：面板能弹出来这件事依赖两条，缺任一条都会回到「点了没反应」
const ansJson = JSON.parse(fs.readFileSync(path.join(BASE, 'components/answer-sheet/index.json'), 'utf8'));
eq('answer-sheet 声明了 apply-shared', ansJson.styleIsolation, 'apply-shared');
const ansOwnCss = cssClassSet(path.join(BASE, 'components/answer-sheet/index.wxss'));
ok('answer-sheet 自留了遮罩与面板定位', ansOwnCss.has('mask') && ansOwnCss.has('sheet'));
ok('answer-sheet 的按钮仍走全局样式（apply-shared 生效才可用）',
  classRefs(fs.readFileSync(path.join(BASE, 'components/answer-sheet/index.wxml'), 'utf8')).indexOf('btn') >= 0);

// 检查器自检：坏样例抓得到，好样例不误报
eq('隔离检查：依赖全局类 + isolated 会被抓出来',
  isolationProblems(['mask', 'ans-stem'], new Set(['ans-stem']), new Set(['mask']), 'isolated').length, 1);
eq('隔离检查：声明 apply-shared 后放行',
  isolationProblems(['mask'], new Set(), new Set(['mask']), 'apply-shared').length, 0);
eq('隔离检查：声明 shared 也放行',
  isolationProblems(['mask'], new Set(), new Set(['mask']), 'shared').length, 0);
eq('隔离检查：样式自包含时 isolated 也不报',
  isolationProblems(['er-mask'], new Set(['er-mask']), new Set(['mask']), 'isolated').length, 0);
eq('隔离检查：用到的类谁都没有时不算全局依赖',
  isolationProblems(['whoops'], new Set(), new Set(['mask']), 'isolated').length, 0);

// ---------------------------------------------------------------------------
console.log('\n=== 10. 不允许在 Modal 的回调里同步再弹 ActionSheet ===');
// 原生弹层互斥：Modal 还没真正关掉就弹 ActionSheet，新弹层会被静默吞掉，
// 用户点了「选择处理方式」却只看到「已跳过」—— 同名导入被跳过就是这么坏的。
// 方向反过来（ActionSheet → Modal）不受影响，所以只禁这一个方向。

function jsFiles(dir) {
  const out = [];
  fs.readdirSync(dir).forEach((n) => {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) out.push.apply(out, jsFiles(p));
    else if (/\.js$/.test(n)) out.push(p);
  });
  return out;
}

function nestedPopups(src) {
  // 行注释整行去掉，否则说明性注释里的 API 名字会被当成真调用
  const text = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const bad = [];
  let i = 0;
  for (;;) {
    const at = text.indexOf('wx.showModal({', i);
    if (at < 0) break;
    let depth = 0;
    let j = at + 'wx.showModal'.length;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const block = text.slice(at, j + 1);
    if (block.indexOf('wx.showActionSheet') >= 0) bad.push(`第 ${text.slice(0, at).split('\n').length} 行`);
    i = j + 1;
  }
  return bad;
}

const jsPaths = jsFiles(path.join(BASE, 'pages')).concat(jsFiles(path.join(BASE, 'utils')));
let modalCalls = 0;
jsPaths.forEach((p) => {
  modalCalls += (fs.readFileSync(p, 'utf8').match(/wx\.showModal\(/g) || []).length;
});
ok('弹层检查：扫到的文件与 showModal 数量够多（防空跑）', jsPaths.length >= 15 && modalCalls >= 3);

const popupBad = [];
jsPaths.forEach((p) => {
  nestedPopups(fs.readFileSync(p, 'utf8')).forEach((loc) => {
    popupBad.push(`${path.relative(BASE, p)} ${loc}`);
  });
});
eq('页面与工具里没有 Modal 套 ActionSheet', popupBad, []);
eq('弹层检查：Modal 里同步弹 ActionSheet 会被抓出来',
  nestedPopups('wx.showModal({ success() { wx.showActionSheet({ itemList: [] }); } });').length, 1);
eq('弹层检查：注释里提到不算违规',
  nestedPopups('// 不能 wx.showActionSheet\nwx.showModal({ success() {} });').length, 0);
eq('弹层检查：ActionSheet 里弹 Modal 放行',
  nestedPopups('wx.showActionSheet({ success() { wx.showModal({}); } });').length, 0);

// --- 第 11 节：面板里的 textarea 必须写死高度 ---
// textarea 是小程序的**原生组件**：层级最高，而且**不会被 scroll-view 裁剪**。
// 让它按内容长高（auto-height），长解析会直接画到面板底部、压住固定在那里的「保存」按钮
// —— 滚到哪儿都盖得住，因为裁剪对它无效。开发者工具里看不出来，只有真机才复现。
// 所以：只读态用普通 view 展示，点一下才出现唯一的 textarea，且高度写死。
function autoHeightTextareas(wxml) {
  const bad = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(wxml)) !== null) {
    if (m[1] === '/' || m[2] !== 'textarea') continue;
    if (/\sauto-height(?=[\s/>=])/.test(m[3])) bad.push(m[3].replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  return bad;
}

let taCount = 0;
const taBad = [];
listDirs(path.join(BASE, 'components')).forEach((name) => {
  const wxmlPath = path.join(BASE, 'components', name, 'index.wxml');
  if (!fs.existsSync(wxmlPath)) return;
  const src = fs.readFileSync(wxmlPath, 'utf8');
  taCount += (src.match(/<textarea\b/g) || []).length;
  autoHeightTextareas(src).forEach((attrs) => taBad.push(`${name}: ${attrs}`));
});
ok('textarea 高度检查：扫到的 textarea 够多（防空跑）', taCount >= 2);
eq('面板里的 textarea 一律写死高度，不用 auto-height', taBad, []);
eq('textarea 检查：auto-height 会被抓出来',
  autoHeightTextareas('<textarea auto-height value="{{a}}" />').length, 1);
eq('textarea 检查：属性值里出现这几个字不算',
  autoHeightTextareas('<textarea value="{{x ? \'auto-height\' : \'y\'}}" />').length, 0);
eq('textarea 检查：固定高度放行',
  autoHeightTextareas('<textarea class="er-input" value="{{a}}" />').length, 0);

// --- 第 12 节：textarea 一律不得待在 scroll-view 里 ---
// 这才是那条真规则，第 11 节只是它的一半。原因：
// textarea 是原生组件，画在**独立的原生层**上，而原生层**不受 scroll-view 的裁剪**。
// 只要它在滚动内容里，内容一长（或滚动位置让它越出可视区）就会画到滚动区外面，
// 压住同在一个面板里的底部按钮 —— 高度写死也挡不住，因为「越出」来自滚动位置。
// 所以编辑态必须把正文整体让给那一个输入框（正文里没有滚动容器），
// 只读展示则用普通 view / scroll-view（它们都会被正常裁剪）。
// 开发者工具里看不出来，只有真机复现，只能静态守。
function textareaInScroll(wxml) {
  const src = String(wxml).replace(/<!--[\s\S]*?-->/g, '');   // 注释里提到标签名不算
  const stack = [];
  const bad = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const closing = m[1] === '/';
    const tag = m[2];
    const selfClose = m[4] === '/';
    if (closing) {
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const inScroll = stack.indexOf('scroll-view') >= 0;
    if (tag === 'textarea' && inScroll) bad.push(stack.slice().join(' > ') + ' > textarea');
    if (selfClose) continue;
    stack.push(tag);
  }
  return bad;
}

let taInScroll = 0;
const taScrollBad = [];
listDirs(path.join(BASE, 'components')).forEach((name) => {
  const wxmlPath = path.join(BASE, 'components', name, 'index.wxml');
  if (!fs.existsSync(wxmlPath)) return;
  const src = fs.readFileSync(wxmlPath, 'utf8');
  taInScroll += (src.replace(/<!--[\s\S]*?-->/g, '').match(/<textarea\b/g) || []).length;
  textareaInScroll(src).forEach((pathIn) => taScrollBad.push(`${name}: ${pathIn}`));
});
ok('textarea 位置检查：扫到的 textarea 够多（防空跑）', taInScroll >= 2);
eq('组件里的 textarea 一律不在 scroll-view 内', taScrollBad, []);
eq('textarea 位置检查：scroll-view 里的会被抓出来',
  textareaInScroll('<scroll-view scroll-y><view><textarea value="{{a}}" /></view></scroll-view>').length, 1);
eq('textarea 位置检查：不在滚动区里放行',
  textareaInScroll('<view><textarea value="{{a}}" /></view>').length, 0);
eq('textarea 位置检查：兄弟节点里的 scroll-view 不算',
  textareaInScroll('<view><scroll-view scroll-y><view>文</view></scroll-view><textarea value="{{a}}" /></view>').length, 0);
eq('textarea 位置检查：注释里提到不算',
  textareaInScroll('<!-- <scroll-view><textarea /></scroll-view> -->').length, 0);

// --- 第 13 节：面板底部按钮区必须是「压在最上面的实心条」 ---
// 这是第 11/12 节之外的最后一道防线。「内容压住保存按钮」真机上报过两轮
// （2026-09-23 补答案面板、2026-09-24 校对面板的备注区），两次都是正文画到了按钮所在的位置。
// 主修是把正文区高度算死，但必须静态守住「按钮区输不了」：
//   background        —— 实心底色，漏出来的内容会被它盖住（透明的话按钮上会透出内容）
//   position+z-index  —— 层叠里排在正文之后
// 面板容器再补一层 overflow:hidden，自己兜住任何越界内容。
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(css).match(new RegExp(`(?:^|[\\s,}])${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}
eq('规则提取：本体能取到', ruleBody('.er-foot { background: #fff }', '.er-foot').trim(), 'background: #fff');
eq('规则提取：后代选择器不算本体（.er-foot .btn 不是 .er-foot）',
  ruleBody('.er-foot .btn { color: red }', '.er-foot'), '');

const PANEL_CSS = { 'errata-sheet': ['.er-sheet', '.er-foot'], 'answer-sheet': ['.ans-sheet', '.ans-foot'] };
const footBad = [];
const boxBad = [];
Object.keys(PANEL_CSS).forEach((name) => {
  const css = fs.readFileSync(path.join(BASE, 'components', name, 'index.wxss'), 'utf8');
  const box = ruleBody(css, PANEL_CSS[name][0]);
  const foot = ruleBody(css, PANEL_CSS[name][1]);
  if (!/overflow\s*:\s*hidden/.test(box)) boxBad.push(`${name}: 面板容器没有 overflow:hidden`);
  if (!/background\s*:\s*(#|rgb|white|var\()/i.test(foot)) footBad.push(`${name}: 底部按钮区没有实心底色`);
  if (!/position\s*:\s*(relative|absolute|fixed)/.test(foot)) footBad.push(`${name}: 底部按钮区没有定位`);
  if (!/z-index\s*:\s*\d/.test(foot)) footBad.push(`${name}: 底部按钮区没有 z-index`);
});
ok('面板规则能取到（防空跑）',
  ruleBody(fs.readFileSync(path.join(BASE, 'components/errata-sheet/index.wxss'), 'utf8'), '.er-sheet').length > 0);
eq('面板容器：overflow hidden 兜住越界内容', boxBad, []);
eq('面板底部按钮区：实心底色 + 定位 + z-index', footBad, []);

// 正文区高度必须是 js 算出来的 px：不靠 flex 撑、不靠滚动容器裁剪（两者真机上都会漏）
const erWxml = fs.readFileSync(path.join(BASE, 'components/errata-sheet/index.wxml'), 'utf8');
ok('校对面板：列表态正文区高度绑定到 bodyH', /class="er-body"[^>]*style="\{\{bodyH/.test(erWxml));
ok('校对面板：编辑态高度也绑定到 bodyH', /class="er-edit"[^>]*style="\{\{bodyH/.test(erWxml));
ok('校对面板：有内容自然高的量尺 er-inner', /class="er-inner"/.test(erWxml));

// --- 第 14 节：引擎说「答案用不上」的原因，页面必须都有对应说明 ---
// 引擎用 answerSuspectKind 区分原因，页面据此给不同提示：
//   missingOption  选项在录入时丢了，答案对不上 → 去「补答案」核对
//   typeConflict   答案写的是对/错，题目却有 4 个选项 → 多半是答案文件选错了
// 新增一类原因却忘了在页面写分支，后果是静默的：那道题既不自动判分、又不说明为什么，
// 只有真机点到它才看得出来。这里把「引擎产出的取值」和「页面写的分支」对上。
function suspectKinds(src) {
  const out = [];
  const re = /answerSuspectKind\s*=\s*'([a-zA-Z]+)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return Array.from(new Set(out)).sort();
}
const coreSrc = fs.readFileSync(path.join(BASE, 'utils/parser-core.js'), 'utf8');
const kinds = suspectKinds(coreSrc);
eq('引擎会产出的两种存疑原因', kinds, ['missingOption', 'typeConflict']);
ok('存疑原因检查：扫到的取值够多（防空跑）', kinds.length >= 2);
const quizWxml = fs.readFileSync(path.join(BASE, 'pages/quiz/quiz.wxml'), 'utf8');
eq('每个存疑原因在答题页都有对应说明',
  kinds.filter((k) => quizWxml.indexOf(`cur.answerSuspectKind === '${k}'`) < 0), []);
eq('存疑原因分支检查：漏写的会被抓出来',
  ['missingOption', 'typeConflict', 'brandNew'].filter((k) => quizWxml.indexOf(`cur.answerSuspectKind === '${k}'`) < 0),
  ['brandNew']);
// 布尔标记只能由 kind 推导，不许在别处单独赋值 —— 两处各写各的迟早会不一致
ok('answerSuspect 一律由 kind 推导', !/answerSuspect\s*=\s*true/.test(coreSrc));

// --- 第 15 节：弹层（.sheet）内容一多，必须自己滚，不许溢出也不许穿透 ---
//
// 为什么需要它：首页的题库操作弹层原本是整块 flex 平铺，app.wxss 给了
// max-height: 82vh 但**没有滚动容器**。选项一多（有进度、有错题、有标记）
// 就整块溢出屏幕，「删除该题库」被切在屏幕外点不到；更要命的是弹层自身
// 没有可滚动区域，滚轮会**穿透到后面的首页题库列表**，看着是"滚错了地方"。
// 数据层、组件 JS 全对，没有任何断言能发现它 —— 只有真机点开才看得见。
//
// 中途试过「头部固定 + 正文滚动 + 删除/取消固定底栏」，真机上固定底栏会
// **盖住正文里还没滚到的内容**（「导出该题库」被压在底栏下），已改回单列整条滚。
// 所以这里断言的是「删除/取消必须在滚动区里面」，别再抓回去做固定底栏。
// ---------------------------------------------------------------------------
const HOME_WXML = fs.readFileSync(path.join(BASE, 'pages/index/index.wxml'), 'utf8');
const HOME_CSS = fs.readFileSync(path.join(BASE, 'pages/index/index.wxss'), 'utf8');
const HOME_JS = fs.readFileSync(path.join(BASE, 'pages/index/index.js'), 'utf8');
const sheetBody = ruleBody(HOME_CSS, '.sheet');
ok('首页弹层样式能取到（防空跑）', sheetBody.length > 0);
ok('弹层：panel 内点击不许穿透到遮罩（有 catchtap）', /class="sheet"[^>]*catchtap=/.test(HOME_WXML));
ok('弹层：有独立滚动容器 sheet-body', /class="sheet-body"[^>]*scroll-y/.test(HOME_WXML)
  || /scroll-y[^>]*class="sheet-body"/.test(HOME_WXML));
ok('弹层：滚动区写在 scroll-view 上（不是 view）', /<scroll-view class="sheet-body"/.test(HOME_WXML));
// 关键：删除/取消必须在滚动区**内部**，跟其他项一起滚
// （放固定底栏会盖住正文里没滚到的内容，真机已复现）
ok('弹层：删除在滚动区内部（不做固定底栏）', (() => {
  const bodyAt = HOME_WXML.indexOf('<scroll-view class="sheet-body"');
  const bodyEnd = HOME_WXML.indexOf('</scroll-view>', bodyAt);
  const delAt = HOME_WXML.indexOf('data-id="{{sheet.setId}}">删除该题库');
  return bodyAt >= 0 && delAt > bodyAt && delAt < bodyEnd;
})());
ok('弹层：取消也在滚动区内部', (() => {
  const bodyAt = HOME_WXML.indexOf('<scroll-view class="sheet-body"');
  const bodyEnd = HOME_WXML.indexOf('</scroll-view>', bodyAt);
  const at = HOME_WXML.indexOf('bindtap="closeSheet"', bodyAt);
  return at > bodyAt && at < bodyEnd;
})());
ok('弹层：面板不许有固定底栏（会盖住没滚到的内容）', HOME_WXML.indexOf('class="sheet-foot"') < 0);
ok('弹层：面板 overflow:hidden 兜住越界内容', /overflow\s*:\s*hidden/.test(sheetBody));
ok('弹层：滚动区 min-height:0（不写 flex 子项不收缩，高度会被内容顶开）',
  /min-height\s*:\s*0/.test(ruleBody(HOME_CSS, '.sheet-body')));
// 最要命的一条：高度必须是 js 算出来的 px，不能靠 flex 推导。
// flex 推导出的高度 == 内容高 → scroll-view 永不溢出 → 永远不滚 →
// 滚轮穿透到下面的首页列表（真机复现过两轮才定位到）。
ok('弹层：滚动区高度绑定到算出来的 bodyH（flex 推导的高度滚不动）',
  /class="sheet-body"[^>]*style="\{\{bodyH/.test(HOME_WXML));
ok('弹层：有内容自然高的量尺 sheet-inner', /class="sheet-inner"/.test(HOME_WXML));
ok('弹层：面板 catchtouchmove 兜住触摸穿透',
  /class="sheet"[^>]*catchtouchmove=/.test(HOME_WXML));
// 纯计算函数必须存在且被页面引用（改了公式但忘了接，页面就会静默用 flex 兜底）
const utilSrc = fs.readFileSync(path.join(BASE, 'utils/util.js'), 'utf8');
ok('弹层高度：util 里导出了 sheetBodyHeightOf',
  /sheetBodyHeightOf/.test(utilSrc) && /module\.exports[\s\S]*sheetBodyHeightOf/.test(utilSrc));
ok('弹层高度：页面引用了 util 的 sheetBodyHeightOf',
  /require\(['"][^'"]*util['"]\)/.test(HOME_JS)
  && /util\.sheetBodyHeightOf|sheetBodyHeightOf\(/.test(HOME_JS));
// 穿透的根因就在这里：面板本身能不能滚？不能滚的容器滚轮必然传给下层
ok('弹层：面板本体不自己滚，交给 sheet-body（avoid 双重滚动）',
  !/overflow-y\s*:\s*(auto|scroll)/.test(sheetBody));
// 滚动区底部留白：最后一条（取消）不贴滚动区底边
ok('弹层：滚动区末尾有留白元素', HOME_WXML.indexOf('class="sheet-body-pad"') > 0);
eq('弹层结构检查：拆分标记缺一不可',
  ['sheet-head', 'sheet-body'].filter((k) => HOME_WXML.indexOf(`class="${k}"`) < 0), []);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
