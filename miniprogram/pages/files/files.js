// 文件库：本地存储版
// 改动：wx.cloud.uploadFile + 云数据库 → 沙箱文件系统 + 本地索引（store）
const config = require('../../config');
const store = require('../../utils/store');
const { extOf, nextAvailableName, formatSize, formatTime } = require('../../utils/util');

Page({
  data: {
    loading: true,
    importing: false,
    filter: 'all',
    files: [],
    list: [],
    storage: { fileCount: 0, setCount: 0, sizeText: '0 B' },
    acceptText: config.localParsableExts.join(' / ')
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true });
    try {
      const files = store.listFiles();
      this.setData({ files, storage: store.storageStats() });
      this.applyFilter();
    } catch (e) {
      console.error('[files] 读取本地文件库失败', e);
      wx.showToast({ title: '读取失败：' + ((e && e.message) || ''), icon: 'none' });
    }
    this.setData({ loading: false });
    wx.stopPullDownRefresh();
  },

  onPullDownRefresh() {
    this.refresh();
  },

  applyFilter() {
    const f = this.data.filter;
    let list = this.data.files;
    if (f === 'question') list = list.filter((x) => x.role === 'question');
    else if (f === 'answer') list = list.filter((x) => x.role === 'answer');
    else if (f === 'none') list = list.filter((x) => !x.role);
    this.setData({ list });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.f });
    this.applyFilter();
  },

  // 从微信会话选择文件 → 拷入沙箱 → 建档
  // 注意：小程序没有「浏览设备任意目录」的文件选择 API，
  //       chooseMessageFile 只能从聊天会话里选（电脑版微信的选择器可以浏览本机磁盘）。
  chooseImport() {
    const that = this;
    if (this.data.importing) return;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: config.acceptExts,
      success(res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        const ext = extOf(f.name);
        if (!ext || config.acceptExts.indexOf(ext) < 0) {
          wx.showToast({ title: `仅支持 ${config.acceptExts.join(' / ')}`, icon: 'none' });
          return;
        }
        if (f.size > config.maxUploadMB * 1024 * 1024) {
          wx.showToast({ title: `文件超过 ${config.maxUploadMB}MB 上限`, icon: 'none' });
          return;
        }
        // 同名冲突：先让用户决定怎么处理，再走原有的保存流程
        const dup = store.findFileByName(f.name);
        if (dup) {
          that.askConflict(f, dup);
          return;
        }
        that.askSave(f, f.name);
      }
    });
  },

  // 无冲突（或已重命名）时的保存流程：先问分类 → 再存
  // 顺序不能反：原生弹层互斥，Modal 的 success 里立刻弹 ActionSheet 会被静默吞掉，
  //             表现为「点了仍要保存，然后什么都没发生」。所以风险提示放在选完分类之后。
  askSave(f, name) {
    const that = this;
    const ext = extOf(f.name);
    // 端上不能解析的类型：选完分类再提示，仍允许保存
    const warn = config.localParsableExts.indexOf(ext) < 0;
    const commit = (role) => {
      if (!warn) return that.doImport(f, role, name);
      wx.showModal({
        title: '该类型端上无法解析',
        content:
          `小程序端只能解析纯文本（${config.localParsableExts.join(' / ')}）。\n\n` +
          `${ext.toUpperCase()} 需要解压/对象解析，端上没有可用运行库，导入后无法直接生成题库，` +
          '但会保存在本地文件库中。\n\n建议：先在电脑上用 tools/to-txt.js 转成 txt 再导入。\n\n是否仍要保存该文件？',
        confirmText: '仍要保存',
        success(r) { if (r.confirm) that.doImport(f, role, name); }
      });
    };
    wx.showActionSheet({
      itemList: ['作为试题文件', '作为答案解析', '暂不分类'],
      success(s) {
        commit(s.tapIndex === 0 ? 'question' : s.tapIndex === 1 ? 'answer' : '');
      },
      fail() { /* 取消 */ }
    });
  },

  // ---------- 同名冲突：替换 / 重命名 / 跳过 ----------

  // 第一层就用 ActionSheet，不用 Modal：
  //   ① 原生弹层互斥 —— Modal 的 success 里立刻弹 ActionSheet 会被静默吞掉，
  //      用户点了「选择处理方式」却只看到「已跳过」（此前就是这么坏的）；
  //   ② 「替换」是这个场景下最高频的选择，必须第一眼就看到，而不是藏在二级菜单里。
  // 后果说明写进选项文案；更详细的删除清单留给替换前的二次确认。
  askConflict(f, dup) {
    const that = this;
    const sets = store.setsByFileId(dup.id);
    const replaceLabel = sets.length
      ? `替换原文件（清除 ${sets.length} 个题库）`
      : '替换原文件';
    wx.showActionSheet({
      itemList: [replaceLabel, '重命名后导入（保留两份）', '取消本次导入'],
      success(s) {
        if (s.tapIndex === 0) that.confirmReplace(f, dup);
        else if (s.tapIndex === 1) that.askNewName(f, dup);
        else wx.showToast({ title: '已跳过本次导入', icon: 'none' });
      },
      fail() { wx.showToast({ title: '已跳过本次导入', icon: 'none' }); }
    });
  },

  // 替换前二次确认：必须说清「原题库会被删」这件事
  confirmReplace(f, dup) {
    const that = this;
    const sets = store.setsByFileId(dup.id);
    const listed = sets.slice(0, 5).map((s) => `· ${s.title}（${s.questionCount || 0} 题）`).join('\n');
    wx.showModal({
      title: '确认替换？此操作不可恢复',
      content:
        `将用新文件覆盖「${f.name}」。\n` +
        `原文件：${formatSize(dup.size)} · 导入于 ${formatTime(dup.createTime)}\n\n` +
        (sets.length
          ? `以下 ${sets.length} 个题库及其作答进度、错题本、校对记录、标记都会被删除：\n${listed}` +
            (sets.length > 5 ? `\n…其余 ${sets.length - 5} 个` : '') +
            '\n\n替换后需要重新生成题库才能继续练习。'
          : '该文件没有关联题库，只替换文件本身。'),
      confirmText: '替换',
      confirmColor: '#F04242',
      success(r) { if (r.confirm) that.doReplace(f, dup); }
    });
  },

  doReplace(f, dup) {
    this.setData({ importing: true });
    wx.showLoading({ title: '替换中...', mask: true });
    try {
      // 分类沿用原文件的 —— 同名替换的文件，用途不会变
      const r = store.replaceFile(dup.id, f.path, { name: f.name, size: f.size }, dup.role);
      wx.hideLoading();
      this.setData({ importing: false });
      const n = r.removedSets.length;
      wx.showModal({
        title: '已替换',
        content: n
          ? `文件已更新，并清除了 ${n} 个旧题库及其作答记录。\n\n请到「生成题库」重新生成后再练习。`
          : '文件已更新，原文件没有关联题库。',
        showCancel: false
      });
      this.refresh();
    } catch (e) {
      wx.hideLoading();
      this.setData({ importing: false });
      console.error('[files] 替换失败', e);
      wx.showModal({
        title: '替换失败',
        content:
          ((e && e.message) || '未知错误') +
          '\n\n如提示空间不足，请在微信「设置 - 通用 - 存储空间」清理小程序缓存后重试。',
        showCancel: false
      });
    }
  },

  // 重命名：给一个可用的默认名，允许手动改
  // 分类沿用原文件的（同名的文件用途不会变），这样确定后直接保存，
  // 不必再弹一次角色选择 —— 少一层弹层，也避开 Modal→ActionSheet 的嵌套。
  askNewName(f, dup) {
    const that = this;
    const taken = this.data.files.map((x) => x.name);
    const suggest = nextAvailableName(f.name, taken);
    wx.showModal({
      title: '重命名后导入',
      content: `保留原文件，用下面的名字再存一份：\n${suggest}\n\n可直接确定，也可以改成其它名称（扩展名保持不变）。`,
      editable: true,
      placeholderText: suggest,
      confirmText: '导入',
      success(r) {
        if (!r.confirm) return;
        const input = String((r && r.content) || '').trim();
        let name = input || suggest;
        // 名字里不能带路径分隔符，扩展名必须与原件一致（它决定端上能不能解析）
        name = name.replace(/[\\/:*?"<>|]+/g, '_');
        const ext = extOf(f.name);
        if (extOf(name) !== ext) name = `${name.replace(/\.[^.]+$/, '')}.${ext}`;
        if (!name.replace(/\.[^.]+$/, '')) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        if (store.findFileByName(name)) {
          wx.showToast({ title: '该名称仍与已有文件重名', icon: 'none' });
          return;
        }
        that.doImport(f, (dup && dup.role) || '', name);
      }
    });
  },

  doImport(f, role, name) {
    this.setData({ importing: true });
    wx.showLoading({ title: '保存到本地...', mask: true });
    try {
      store.importFile(f.path, { name: name || f.name, size: f.size }, role);
      wx.hideLoading();
      this.setData({ importing: false });
      wx.showToast({ title: '已保存到本地', icon: 'success' });
      this.refresh();
    } catch (e) {
      wx.hideLoading();
      this.setData({ importing: false });
      console.error('[files] 导入失败', e);
      wx.showModal({
        title: '保存失败',
        content:
          ((e && e.message) || '未知错误') +
          '\n\n如提示空间不足，请在微信「设置 - 通用 - 存储空间」清理小程序缓存后重试。',
        showCancel: false
      });
    }
  },

  changeRole(e) {
    const { id } = e.currentTarget.dataset;
    const that = this;
    wx.showActionSheet({
      itemList: ['设为试题文件', '设为答案解析', '设为未分类'],
      success(res) {
        const role = res.tapIndex === 0 ? 'question' : res.tapIndex === 1 ? 'answer' : '';
        store.setFileRole(id, role);
        wx.showToast({ title: '已更新', icon: 'success' });
        that.refresh();
      }
    });
  },

  deleteFile(e) {
    const { id, name } = e.currentTarget.dataset;
    const that = this;
    wx.showModal({
      title: '删除文件',
      content: `确定删除「${name}」吗？已生成的题库不受影响。`,
      confirmColor: '#F04242',
      success(res) {
        if (!res.confirm) return;
        store.deleteFile(id);
        wx.showToast({ title: '已删除', icon: 'success' });
        that.refresh();
      }
    });
  },

  goGenerate() {
    wx.navigateTo({ url: '/pages/generate/generate' });
  }
});
