// skills/quiz-helper/index.js —— 原子接口注册入口
//
// 三者必须完全一致：require 导入名 = registerAPI 第一参数 = mcp.json 的 apis[].name
// 本 skill 不涉及登录态与网络请求（数据全部来自本机 storage），故不使用中间件。
const { listSets } = require('./apis/listSets');
const { getStudyOverview } = require('./apis/getStudyOverview');
const { listWrongItems } = require('./apis/listWrongItems');
const { listErrataItems } = require('./apis/listErrataItems');
const { createPracticePlan } = require('./apis/createPracticePlan');

wx.modelContext.registerAPI('listSets', listSets);
wx.modelContext.registerAPI('getStudyOverview', getStudyOverview);
wx.modelContext.registerAPI('listWrongItems', listWrongItems);
wx.modelContext.registerAPI('listErrataItems', listErrataItems);
wx.modelContext.registerAPI('createPracticePlan', createPracticePlan);
