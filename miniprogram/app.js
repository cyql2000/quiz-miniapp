const config = require('./config');

App({
  globalData: {
    storageReady: false,
    storageError: '',
    wrongFilter: '', // 错题本页筛选（tabBar 页无法带参，用 globalData 传递）
    agentHandoffs: {} // 小程序 AI 接力（handoff）投递的数据，按 pageId 存放
  },

  onLaunch() {
    // 小程序 AI 的 handoff 接力：配了 _meta.ui.pagePath 的原子接口
    // （skills/quiz-helper 的 createPracticePlan）由此把「本次抽好的题」交给目标页；
    // 普通打开小程序不会触发。
    //
    // 必须做能力判断：该 API 只在支持小程序 AI 的基础库上存在，低版本真机上是
    // undefined。无防护调用会让 onLaunch 直接抛错中断，连下面的存储自检都跑不到 ——
    // 表现就是「模拟器/预览正常、真机打不开」。能力不足时静默跳过即可：
    // 接力用不上，但其余功能一切照常。
    if (typeof wx.onAgentHandoff === 'function') {
      wx.onAgentHandoff(({ pageId, path, query, payload }) => {
        this.globalData.agentHandoffs = this.globalData.agentHandoffs || {};
        this.globalData.agentHandoffs[pageId] = { path, query, payload };
      });
    } else {
      console.info('[agent] 当前环境不支持 wx.onAgentHandoff，AI 接力不可用（不影响其他功能）');
    }
    this.checkStorage();
  },

  // 本地存储自检：确认沙箱文件系统可用、索引可读写
  // 替代原先的云环境连通性检查
  checkStorage() {
    const fsm = require('./utils/localfs');
    try {
      if (!fsm.ROOT) {
        throw new Error('wx.env.USER_DATA_PATH 不可用');
      }
      fsm.ensureDir(fsm.DIR.sets);
      fsm.ensureDir(fsm.DIR.source);
      const probe = `${fsm.DIR.tmp}/.probe`;
      fsm.writeText(probe, 'ok');
      const back = fsm.readText(probe);
      fsm.remove(probe);
      if (back !== 'ok') throw new Error('写入校验不一致');

      wx.setStorageSync('qz_probe', 1);
      wx.removeStorageSync('qz_probe');

      this.globalData.storageReady = true;
      console.log('[storage] 本地存储就绪，沙箱根目录:', fsm.ROOT);
    } catch (e) {
      this.globalData.storageError = (e && e.message) || '本地存储不可用';
      console.error('[storage] 自检失败:', e);
      wx.showModal({
        title: '本地存储不可用',
        content:
          '小程序无法读写本地文件，题库将无法保存。\n' +
          '可能原因：存储空间已满（可在微信「设置-通用-存储空间」清理小程序缓存），或基础库版本过低。\n\n' +
          '错误信息：' + ((e && e.message) || '未知'),
        showCancel: false
      });
    }
  }
});
