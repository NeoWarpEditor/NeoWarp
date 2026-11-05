const {contextBridge, ipcRenderer} = require('electron');

// 与 src-preload/ai-assistant.js 完全一致的桥：SOLO 页面与 AI 助手共用同一份
// 渲染层代码，页面检测到 SoloPreload 存在才进入 SOLO 模式。
contextBridge.exposeInMainWorld('AIAssistantPreload', {
  getProjectCode: () => ipcRenderer.invoke('get-project-code'),
  applyProject: (projectJSON) => ipcRenderer.invoke('apply-project', projectJSON),
  applySprite: (spriteJSON, targetId) => ipcRenderer.invoke('apply-sprite', spriteJSON, targetId),
  getSpriteLibrary: () => ipcRenderer.invoke('get-sprite-library'),
  // 统一的 AI 模型配置存储（与 AI 助手、扩展编辑器、桌面设置共用）
  getModelConfigs: () => ipcRenderer.invoke('ai-get-model-configs'),
  saveModelConfigs: (payload) => ipcRenderer.invoke('ai-save-model-configs', payload),
  openDesktopSettings: () => ipcRenderer.invoke('open-desktop-settings'),
  // AI 工作流设置（Plan / Spec / Goal）：读取/保存/选目录/文档落盘
  getWorkflowSettings: () => ipcRenderer.invoke('ai-get-workflow-settings'),
  saveWorkflowSettings: (payload) => ipcRenderer.invoke('ai-save-workflow-settings', payload),
  pickWorkflowDocsDir: () => ipcRenderer.invoke('ai-pick-workflow-docs-dir'),
  saveWorkflowDoc: (payload) => ipcRenderer.invoke('ai-save-workflow-doc', payload),
  openWorkflowDocsDir: () => ipcRenderer.invoke('ai-open-workflow-docs-dir'),
  callTool: (toolName, params) => ipcRenderer.invoke('ai-tool-call', toolName, params),
  webSearch: (query) => ipcRenderer.invoke('web-search', query),
  getTheme: () => ipcRenderer.invoke('ai-get-theme'),
  getLocale: () => ipcRenderer.invoke('ai-get-locale'),
  closeWindow: () => ipcRenderer.invoke('ai-close-window'),
  // 手机编程：获取局域网链接/二维码信息
  getPhoneLink: () => ipcRenderer.invoke('ai-get-phone-link'),
  // 手机编程：把聊天状态变化广播给已连接的手机
  phoneSyncBroadcast: (payload) => ipcRenderer.send('ai-phone-broadcast', payload),
  onPhoneClientsChanged: (callback) => {
    ipcRenderer.on('ai-phone-clients', (event, data) => callback(data));
  },
  onProjectCodeResponse: (callback) => {
    ipcRenderer.on('project-code-response', (event, data) => callback(data));
  },
  onThemeChanged: (callback) => {
    ipcRenderer.on('ai-theme-changed', (event, data) => callback(data));
  },
  onAiModelConfigsChanged: (callback) => {
    ipcRenderer.on('ai-model-configs-changed', (event, data) => callback(data));
  },
  onWorkflowSettingsChanged: (callback) => {
    ipcRenderer.on('ai-workflow-settings-changed', (event, data) => callback(data));
  },
  onLocaleChanged: (callback) => {
    ipcRenderer.on('ai-locale-changed', (event, data) => callback(data));
  },
  removeThemeListener: () => {
    ipcRenderer.removeAllListeners('ai-theme-changed');
  },
  removeLocaleListener: () => {
    ipcRenderer.removeAllListeners('ai-locale-changed');
  }
});

// SOLO 专属能力：选择/切换工程、查询当前工程、保存 sb3 工程
contextBridge.exposeInMainWorld('SoloPreload', {
  getState: () => ipcRenderer.invoke('solo-get-state'),
  pickProject: (type) => ipcRenderer.invoke('solo-pick-project', type),
  saveProject: () => ipcRenderer.invoke('solo-save-project'),
  // 侧边栏舞台预览点击 → 弹出该对话工程的舞台窗口（绿旗/暂停）
  openStageWindow: () => ipcRenderer.invoke('solo-open-stage-window'),
  // AI 自主新建工程（create_project）后主进程推送的新工程状态
  onProjectChanged: (callback) => {
    ipcRenderer.on('solo-project-changed', (event, data) => callback(data));
  },
  // 后台编辑器推来的舞台帧（用于侧边栏底部预览）
  onStageFrame: (callback) => {
    ipcRenderer.on('solo-stage-frame', (event, dataURL) => callback(dataURL));
  },
  removeStageFrameListener: () => {
    ipcRenderer.removeAllListeners('solo-stage-frame');
  }
});
