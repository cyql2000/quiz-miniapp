// 全局配置
//
// 【架构说明】本版本已改为**纯本地**运行：
//   - 数据存储：wx.setStorageSync（轻量索引）+ 小程序沙箱文件系统（题库明细、源文件）
//   - 文件解析：端上跑 utils/parser-core.js（与云函数共用同一份识别引擎）
//   - 不再依赖云开发（云数据库 / 云存储 / 云函数）
//
// 端上能力边界（重要）：
//   可以解析：txt / md / json / csv   —— 纯文本，直接读取
//   不能解析：pdf / docx              —— 需要解压与对象解析，小程序端无可用运行库
//   PDF/Word 请先用电脑上的 tools/to-txt.js 转成 txt 再导入（见 README 第七节）
module.exports = {
  // 允许导入的文件类型（可入库保存）
  acceptExts: ['txt', 'md', 'json', 'csv', 'pdf', 'docx'],

  // 端上可直接解析的类型（其余类型可保存但无法生成题库）
  localParsableExts: ['txt', 'md', 'json', 'csv'],

  // 单个源文件大小上限（MB）
  // 注：小程序沙箱「本地用户文件」总容量约 200MB，单文件请控制在这个值以内
  maxUploadMB: 20,

  // 品牌与题库信息
  brand: {
    name: '轻刷题',
    slogan: '导入文件，自动生成可随时刷题的题库'
  }
};
