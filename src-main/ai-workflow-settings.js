const path = require('path');
const fsPromises = require('fs/promises');
const {app, dialog, shell} = require('electron');
const settings = require('./settings');
const {writeFileAtomic} = require('./atomic-write-stream');

/**
 * AI 工作流设置（Plan / Spec / Goal）。
 *
 * 存储复用全局 settings（tw_config.json）：
 *  - aiWorkflow：默认工作流（none / plan / spec / goal），AI 助手与 SOLO 共用
 *  - aiWorkflowDocsDir：工作流文档保存目录；空串表示不落盘
 *
 * Plan/Spec 工作流产生的文档由渲染层通过 ai-save-workflow-doc 写到
 * docsDir 下的「任务名」子文件夹，便于纳入版本控制长期保留。
 */

const WORKFLOW_MODES = ['none', 'plan', 'spec', 'goal'];

// 文档只允许写进这几类文件名，防止借工作流通道写任意文件
const DOC_FILE_NAMES = ['plan.md', 'spec.md', 'tasks.md', 'checklist.md'];

const getWorkflowSettings = () => ({
  workflow: settings.aiWorkflow,
  docsDir: settings.aiWorkflowDocsDir
});

/**
 * Windows 下阻止把文档写进应用安装目录 / userData，与 solo.js 的防护一致。
 */
const getUnsafePaths = () => {
  if (process.platform !== 'win32') return [];
  return [
    path.dirname(app.getPath('exe')),
    app.getPath('userData')
  ];
};

const isChildPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * 任务名转安全文件夹名：去掉非法字符，限制长度。
 */
const sanitizeFolderName = (name) => {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^\.+/, '');
  return cleaned || '未命名任务';
};

async function pickWorkflowDocsDir (senderWindow) {
  const result = await dialog.showOpenDialog(senderWindow, {
    title: '选择工作流文档保存位置',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.aiWorkflowDocsDir || app.getPath('documents')
  });
  if (result.canceled || !result.filePaths.length) {
    return {success: false, canceled: true};
  }
  return {success: true, docsDir: result.filePaths[0]};
}

/**
 * 把工作流文档写到 docsDir/<folder>/<file>。
 * @param {{folder: string, file: string, content: string}} payload
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function saveWorkflowDoc (payload) {
  const docsDir = String(settings.aiWorkflowDocsDir || '').trim();
  if (!docsDir) {
    return {success: false, error: 'docs dir not set'};
  }
  const file = DOC_FILE_NAMES.includes(payload && payload.file) ? payload.file : null;
  if (!file) {
    return {success: false, error: 'invalid file name'};
  }
  const folder = sanitizeFolderName(payload && payload.folder);
  const target = path.resolve(docsDir, folder, file);
  const root = path.resolve(docsDir);
  // 目录本身要存在性校验：resolve 后必须仍在 docsDir 之内（防 ../ 穿越）
  if (target !== root && !isChildPath(root, target)) {
    return {success: false, error: 'path escapes docs dir'};
  }
  for (const unsafe of getUnsafePaths()) {
    if (target === unsafe || isChildPath(unsafe, target)) {
      return {success: false, error: 'refusing to write inside the application directory'};
    }
  }
  try {
    await fsPromises.mkdir(path.dirname(target), {recursive: true});
    await writeFileAtomic(target, String(payload.content || ''), 'utf-8');
    return {success: true, path: target};
  } catch (e) {
    return {success: false, error: e.message};
  }
}

/**
 * 把最新工作流设置推给所有 AI 助手与 SOLO 窗口。
 * @param {Electron.WebContents|null} sender 发起方的 webContents，不回推
 */
function broadcastWorkflowSettingsChanged (sender) {
  const AbstractWindow = require('./windows/abstract');
  const AIAssistantWindow = require('./windows/ai-assistant');
  const SoloWindow = require('./windows/solo');
  const payload = getWorkflowSettings();
  const targets = [
    ...AbstractWindow.getWindowsByClass(AIAssistantWindow),
    ...AbstractWindow.getWindowsByClass(SoloWindow)
  ];
  for (const win of targets) {
    if (win.window && !win.window.isDestroyed() && win.window.webContents !== sender) {
      win.window.webContents.send('ai-workflow-settings-changed', payload);
    }
  }
}

/**
 * 保存工作流设置并广播。
 * @param {{workflow?: string, docsDir?: string}} partial
 * @param {Electron.WebContents|null} sender
 */
async function saveWorkflowSettings (partial, sender) {
  const p = partial || {};
  if (p.workflow !== undefined) {
    settings.aiWorkflow = WORKFLOW_MODES.includes(p.workflow) ? p.workflow : 'none';
  }
  if (p.docsDir !== undefined) {
    settings.aiWorkflowDocsDir = typeof p.docsDir === 'string' ? p.docsDir.trim() : '';
  }
  await settings.save();
  broadcastWorkflowSettingsChanged(sender || null);
  return getWorkflowSettings();
}

/**
 * 在窗口自身的 frame ipc 上注册工作流设置通道。
 * 各窗口的 frame ipc 相互独立，同名通道互不冲突。
 * @param {Electron.IpcRenderer} ipc 由窗口构造函数传入的 this.ipc
 */
function registerAiWorkflowIpc (ipc) {
  ipc.handle('ai-get-workflow-settings', () => getWorkflowSettings());
  ipc.handle('ai-save-workflow-settings', async (event, payload) => {
    const result = await saveWorkflowSettings(payload, event.sender);
    // 广播跳过了发起者，这里把最终结果回给发起方
    event.sender.send('ai-workflow-settings-changed', result);
    return result;
  });
  ipc.handle('ai-pick-workflow-docs-dir', async (event) => {
    const win = event.sender;
    let browserWindow = null;
    try {
      browserWindow = require('electron').BrowserWindow.fromWebContents(win);
    } catch (e) {
      browserWindow = null;
    }
    const picked = await pickWorkflowDocsDir(browserWindow);
    if (picked.success) {
      return saveWorkflowSettings({docsDir: picked.docsDir}, event.sender);
    }
    return getWorkflowSettings();
  });
  ipc.handle('ai-save-workflow-doc', (event, payload) => saveWorkflowDoc(payload));
  ipc.handle('ai-open-workflow-docs-dir', async () => {
    const docsDir = settings.aiWorkflowDocsDir;
    if (!docsDir) return {success: false, error: 'docs dir not set'};
    try {
      await fsPromises.mkdir(docsDir, {recursive: true});
      await shell.openPath(docsDir);
      return {success: true};
    } catch (e) {
      return {success: false, error: e.message};
    }
  });
}

module.exports = {
  getWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowDoc,
  registerAiWorkflowIpc
};
