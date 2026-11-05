const {clipboard, ipcMain} = require('electron');
const AbstractWindow = require('./abstract');
const {APP_NAME} = require('../brand');
const MobilePreviewServer = require('../mobile-preview-server');

// 手机预览窗口：展示局域网链接和二维码。项目数据由编辑器窗口按需导出，
// 手机端拿到的是一份独立运行的副本，不与编辑器内的舞台联动。
class MobilePreviewWindow extends AbstractWindow {
  constructor (editorWindow) {
    super();

    /** @type {import('./editor')} */
    this.editorWindow = editorWindow;

    this.window.setTitle(`手机预览 - ${APP_NAME}`);
    this.window.on('page-title-updated', (event) => {
      event.preventDefault();
    });

    this.server = new MobilePreviewServer({
      getProject: () => this.exportProject(),
      getTitle: () => this.getProjectTitle()
    });

    this.window.on('closed', () => {
      this.server.stop();
    });

    this.ipc.handle('mobile-preview-start', async () => {
      const result = await this.server.start();
      if (!result.success) {
        return result;
      }
      return {
        success: true,
        port: result.port,
        url: this.server.getURL(),
        urls: this.server.getAllURLs(),
        title: this.getProjectTitle()
      };
    });

    this.ipc.handle('mobile-preview-stop', async () => {
      await this.server.stop();
      return {success: true};
    });

    this.ipc.handle('mobile-preview-copy', (event, text) => {
      // 自定义协议不是浏览器的安全上下文，navigator.clipboard 可能不可用。
      // 通过受限的 IPC 使用 Electron 剪贴板，避免依赖页面权限。
      if (typeof text !== 'string' || !text) {
        throw new Error('没有可复制的链接');
      }
      clipboard.writeText(text);
      return {success: true};
    });

    this.ipc.handle('mobile-preview-get-qr', (event, url) => {
      // qrcode-generator 是纯 JS 实现，在主进程里生成再交给渲染进程显示
      const qrcode = require('qrcode-generator');
      const qr = qrcode(0, 'M');
      qr.addData(String(url || ''));
      qr.make();
      return qr.createSvgTag({
        cellSize: 8,
        margin: 0,
        scalable: true
      });
    });

    this.ipc.handle('mobile-preview-get-theme', () => this.requestEditorTheme());

    this.loadURL('tw-mobile-preview://./mobile-preview.html');
    this.show();
  }

  getProjectTitle () {
    const editorWindow = this.editorWindow;
    if (!editorWindow || editorWindow.window.isDestroyed()) {
      return '';
    }
    // 编辑器窗口标题是「项目名 - NeoWarp」，手机端只需要项目名
    const title = editorWindow.window.getTitle() || '';
    if (title === APP_NAME) {
      return '';
    }
    const suffix = ` - ${APP_NAME}`;
    return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
  }

  /**
   * 让编辑器渲染进程把当前项目导出成 sb3。复用打包器那条 MessagePort 通道。
   * @returns {Promise<{name: string; data: ArrayBuffer}>}
   */
  exportProject () {
    const editorWindow = this.editorWindow;
    if (!editorWindow || editorWindow.window.isDestroyed()) {
      return Promise.reject(new Error('编辑器窗口已关闭'));
    }

    return new Promise((resolve, reject) => {
      const {MessageChannelMain} = require('electron');
      const {port1, port2} = new MessageChannelMain();

      const timeout = setTimeout(() => {
        port1.close();
        reject(new Error('导出项目超时'));
      }, 120000);

      port1.on('message', (event) => {
        clearTimeout(timeout);
        const data = event.data;
        port1.close();
        if (!data || data.error) {
          reject(new Error('导出项目失败'));
          return;
        }
        resolve({
          name: data.name,
          data: data.data
        });
      });
      port1.start();

      editorWindow.window.webContents.postMessage('export-project-to-port', null, [port2]);
    });
  }

  requestEditorTheme () {
    const editorWindow = this.editorWindow;
    if (!editorWindow || editorWindow.window.isDestroyed()) {
      return 'light';
    }
    return new Promise((resolve) => {
      const requestId = `mobile-preview-${Date.now()}`;
      const handler = (event, data) => {
        if (data && data.requestId === requestId) {
          ipcMain.removeListener('theme-response', handler);
          clearTimeout(timeout);
          resolve(data.theme || 'light');
        }
      };
      const timeout = setTimeout(() => {
        ipcMain.removeListener('theme-response', handler);
        resolve('light');
      }, 3000);
      ipcMain.on('theme-response', handler);
      editorWindow.window.webContents.send('request-theme', {requestId});
    });
  }

  getDimensions () {
    return {
      width: 520,
      height: 700
    };
  }

  getPreload () {
    return 'mobile-preview';
  }

  handlePermissionCheck (permisson, details) {
    // 页面里的复制链接按钮走 navigator.clipboard，默认权限策略会全部拒绝
    return permisson === 'clipboard-sanitized-write' || super.handlePermissionCheck(permisson, details);
  }

  async handlePermissionRequest (permisson, details) {
    return permisson === 'clipboard-sanitized-write' || super.handlePermissionRequest(permisson, details);
  }

  isPopup () {
    return true;
  }

  getBackgroundColor () {
    return '#f5f5f7';
  }

  static show (editorWindow) {
    const existing = AbstractWindow.getWindowsByClass(MobilePreviewWindow)
      .find(window => window.editorWindow === editorWindow);
    if (existing) {
      existing.show();
      return existing;
    }
    return new MobilePreviewWindow(editorWindow);
  }
}

module.exports = MobilePreviewWindow;
