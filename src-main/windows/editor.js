const fsPromises = require('fs/promises');
const path = require('path');
const nodeURL = require('url');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const {app, dialog, ipcMain, nativeTheme} = require('electron');
const os = require('os');
const ProjectRunningWindow = require('./project-running-window');
const AddonsWindow = require('./addons');
const DesktopSettingsWindow = require('./desktop-settings');
const PrivacyWindow = require('./privacy');
const AboutWindow = require('./about');
const ContactWindow = require('./contact');
const PackagerWindow = require('./packager');
const {createAtomicWriteStream} = require('../atomic-write-stream');
const {translate, updateLocale, getStrings} = require('../l10n');
const {APP_NAME} = require('../brand');
const prompts = require('../prompts');
const settings = require('../settings');
const {recordRecentProject} = require('../recent-projects');
const privilegedFetch = require('../fetch');
const RichPresence = require('../rich-presence.js');
const FileAccessWindow = require('./file-access-window.js');
const ExtensionDocumentationWindow = require('./extension-documentation.js');
const DetachedStageWindow = require('./detached-stage.js');
const AIAssistantWindow = require('./ai-assistant');
const TodoListWindow = require('./todo-list');
const ProjectAnalysisWindow = require('./project-analysis');
const TaskManagerWindow = require('./task-manager');
const CollaborationWindow = require('./collaboration');
const MobilePreviewWindow = require('./mobile-preview');
const HomeWindow = require('./home');
const AbstractWindow = require('./abstract');
const {scanExpands} = require('../neowarp-expands');
const editorWindowEvents = require('../editor-window-events');
const {getEffectiveTheme} = require('../effective-theme');

const TYPE_FILE = 'file';
const TYPE_URL = 'url';
const TYPE_SCRATCH = 'scratch';
const TYPE_SAMPLE = 'sample';

// .npnp encrypted file format constants
const NPNP_MAGIC = Buffer.from('NPNP\x01');
const NPNP_SALT_LENGTH = 16;
const NPNP_IV_LENGTH = 12; // For AES-256-GCM
const NPNP_AUTH_TAG_LENGTH = 16;
const NPNP_PBKDF2_ITERATIONS = 100000;

// .viewsb3 encrypted file format constants (fixed-key encryption for view-only sharing)
const VSB3_MAGIC = Buffer.from('VSB3\x01');
const VSB3_SALT = Buffer.from('NeoWarpViewSb3FixedSalt2024', 'utf8');
const VSB3_IV = Buffer.from('ViewSb3FixIV', 'utf8');
const VSB3_PBKDF2_PASSWORD = 'neowarp-viewsb3-viewonly-v1';
const VSB3_PBKDF2_ITERATIONS = 10000;

/**
 * Get the fixed key for viewsb3 encryption/decryption
 * @returns {Buffer} 32-byte key
 */
const getViewSb3Key = () => {
  return nodeCrypto.pbkdf2Sync(VSB3_PBKDF2_PASSWORD, VSB3_SALT, VSB3_PBKDF2_ITERATIONS, 32, 'sha256');
};

/**
 * Encrypt data for .viewsb3 format using AES-256-GCM with a fixed key
 * @param {Buffer} data - The data to encrypt
 * @returns {Buffer} The encrypted data in .viewsb3 format
 */
const encryptViewSb3 = (data) => {
  const key = getViewSb3Key();
  const iv = VSB3_IV;

  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([VSB3_MAGIC, iv, authTag, encrypted]);
};

/**
 * Decrypt .viewsb3 file data
 * @param {Buffer} data - The encrypted file data
 * @returns {Buffer} The decrypted sb3 data
 * @throws {Error} If the file is not a valid .viewsb3 file
 */
const decryptViewSb3 = (data) => {
  if (data.length < 5 + 12 + 16 ||
      !data.slice(0, 5).equals(VSB3_MAGIC)) {
    throw new Error('Not a valid .viewsb3 file');
  }

  const iv = data.slice(5, 5 + 12);
  const authTag = data.slice(5 + 12, 5 + 12 + 16);
  const encrypted = data.slice(5 + 12 + 16);

  const key = getViewSb3Key();

  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    throw new Error('Corrupted .viewsb3 file');
  }
};

/**
 * Encrypt data using AES-256-GCM with a password-derived key
 * @param {Buffer} data - The data to encrypt
 * @param {string} password - The encryption password
 * @returns {Buffer} The encrypted data in .npnp format
 */
const encryptNpnp = (data, password) => {
  const salt = nodeCrypto.randomBytes(NPNP_SALT_LENGTH);
  const iv = nodeCrypto.randomBytes(NPNP_IV_LENGTH);

  const key = nodeCrypto.pbkdf2Sync(password, salt, NPNP_PBKDF2_ITERATIONS, 32, 'sha512');

  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([NPNP_MAGIC, salt, iv, authTag, encrypted]);
};

/**
 * Decrypt .npnp file data
 * @param {Buffer} data - The encrypted file data
 * @param {string} password - The decryption password
 * @returns {Buffer} The decrypted sb3 data
 * @throws {Error} If the file is not a valid .npnp file or the password is wrong
 */
const decryptNpnp = (data, password) => {
  // Verify magic bytes
  if (data.length < 5 + NPNP_SALT_LENGTH + NPNP_IV_LENGTH + NPNP_AUTH_TAG_LENGTH ||
      !data.slice(0, 5).equals(NPNP_MAGIC)) {
    throw new Error('Not a valid .npnp file');
  }

  const salt = data.slice(5, 5 + NPNP_SALT_LENGTH);
  const iv = data.slice(5 + NPNP_SALT_LENGTH, 5 + NPNP_SALT_LENGTH + NPNP_IV_LENGTH);
  const authTag = data.slice(5 + NPNP_SALT_LENGTH + NPNP_IV_LENGTH, 5 + NPNP_SALT_LENGTH + NPNP_IV_LENGTH + NPNP_AUTH_TAG_LENGTH);
  const encrypted = data.slice(5 + NPNP_SALT_LENGTH + NPNP_IV_LENGTH + NPNP_AUTH_TAG_LENGTH);

  const key = nodeCrypto.pbkdf2Sync(password, salt, NPNP_PBKDF2_ITERATIONS, 32, 'sha512');

  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    throw new Error('Wrong password or corrupted file');
  }
};

class OpenedFile {
  constructor (type, path) {
    /** @type {TYPE_FILE|TYPE_URL|TYPE_SCRATCH|TYPE_SAMPLE} */
    this.type = type;

    /**
     * Absolute file path or URL
     * @type {string}
     */
    this.path = path;
  }

  async read () {
    if (this.type === TYPE_FILE) {
      return {
        name: path.basename(this.path),
        data: await fsPromises.readFile(this.path)
      };
    }

    if (this.type === TYPE_URL) {
      const buffer = await privilegedFetch(this.path);
      return {
        name: decodeURIComponent(path.basename(this.path)),
        data: buffer
      };
    }

    if (this.type === TYPE_SCRATCH) {
      const metadata = await privilegedFetch.json(`https://api.scratch.mit.edu/projects/${this.path}`);
      const token = metadata.project_token;
      const title = metadata.title;

      const projectBuffer = await privilegedFetch(`https://projects.scratch.mit.edu/${this.path}?token=${token}`);
      return {
        name: title,
        data: projectBuffer
      };
    }

    if (this.type === TYPE_SAMPLE) {
      const sampleRoot = path.resolve(__dirname, '../../dist-extensions/samples/');
      const resolvedPath = path.join(sampleRoot, this.path);
      if (resolvedPath.startsWith(sampleRoot)) {
        const compressedPath = `${resolvedPath}.br`;
        const compressedData = await fsPromises.readFile(compressedPath);

        // dist-extensions is all brotli'd; must decompress
        const decompressedData = await new Promise((resolve, reject) => {
          zlib.brotliDecompress(compressedData, (err, res) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          });
        });

        return {
          name: this.path,
          data: decompressedData
        };
      }
      throw new Error('Unsafe join');
    }

    throw new Error(`Unknown type: ${this.type}`);
  }
}

/**
 * @param {string} file
 * @param {string|null} workingDirectory
 * @returns {OpenedFile}
 */
const parseOpenedFile = (file, workingDirectory) => {
  let url;
  try {
    url = new URL(file);
  } catch (e) {
    // Error means it was not a valid full URL
  }

  if (url) {
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      // Scratch URLs require special treatment as they are not direct downloads.
      const scratchMatch = file.match(/^https?:\/\/scratch\.mit\.edu\/projects\/(\d+)\/?/);
      if (scratchMatch) {
        return new OpenedFile(TYPE_SCRATCH, scratchMatch[1]);
      }

      // Need to manually redirect extension samples to the copies we already have offline as the
      // fetching code will not go through web request handlers or custom protocols.
      const sampleMatch = file.match(/^https?:\/\/extensions\.turbowarp\.org\/samples\/(.+\.sb3)$/);
      if (sampleMatch) {
        return new OpenedFile(TYPE_SAMPLE, decodeURIComponent(sampleMatch[1]));
      }

      return new OpenedFile(TYPE_URL, file);
    }

    // Parse file:// URLs.
    // Notably we receive these in the flatpak version of the app when we can only access a file through
    // the XDG document portal instead of having direct access with eg. --filesystem=home
    if (url.protocol === 'file:') {
      let filePath;
      try {
        filePath = nodeURL.fileURLToPath(file);
      } catch (e) {
        // Very unlikely but possible
      }

      if (filePath) {
        return new OpenedFile(TYPE_FILE, path.resolve(workingDirectory, filePath));
      }
    }

    // Don't throw an error just because we don't recognize the URL protocol as
    // Windows paths look close enough to real URLs to be parsed successfully.
  }

  return new OpenedFile(TYPE_FILE, path.resolve(workingDirectory, file));
};

/**
 * @returns {Array<{path: string; app: string;}>}
 */
const getUnsafePaths = () => {
  if (process.platform !== 'win32') {
    // This problem doesn't really exist on other platforms
    return [];
  }

  const localPrograms = path.join(app.getPath('home'), 'AppData', 'Local', 'Programs');
  const appData = app.getPath('appData');
  return [
    // Current app, regardless of where it is installed or how modded it is
    {
      path: path.dirname(app.getPath('exe')),
      app: APP_NAME,
    },
    {
      path: app.getPath('userData'),
      app: APP_NAME,
    },

    // TurboWarp Desktop defaults
    {
      path: path.join(appData, 'turbowarp-desktop'),
      app: 'TurboWarp Desktop'
    },
    {
      path: path.join(localPrograms, 'TurboWarp'),
      app: 'TurboWarp Desktop'
    },

    // Scratch Desktop defaults
    {
      path: path.join(appData, 'Scratch'),
      app: 'Scratch Desktop'
    },
    {
      path: path.join(localPrograms, 'Scratch 3'),
      app: 'Scratch Desktop'
    }
  ];
};

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
const isChildPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * 解码 data: URL 为 UTF-8 文本（我的扩展的 extensionURL 通常是 .js 文件的 data: URL）。
 * @param {string} url
 * @returns {string}
 */
const decodeDataUrl = url => {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid data URL');
  }
  const meta = url.slice(5, commaIndex);
  const data = url.slice(commaIndex + 1);
  if (/;base64$/i.test(meta)) {
    return Buffer.from(data, 'base64').toString('utf8');
  }
  return decodeURIComponent(data);
};

/**
 * @returns {string} A unique string.
 */
const generateFileId = () => {
  // Note that we can't use the randomUUID from web crypto as we need to support Electron 22.
  return `desktop_file_id{${nodeCrypto.randomUUID()}}`;
};

class EditorWindow extends ProjectRunningWindow {
  /**
   * @param {OpenedFile|null} initialFile
   * @param {boolean} isInitiallyFullscreen
   * @param {{hidden?: boolean}} [options] hidden=true 时不显示窗口（SOLO 后台工程宿主）
   */
  constructor (initialFile, isInitiallyFullscreen, options) {
    super();

    // SOLO 的后台工程宿主（hidden=true）：不显示窗口，不应出现在
    // 扩展编辑器「添加到项目」的项目列表里
    this.isHiddenHost = !!(options && options.hidden);

    // NeoWarp: 渲染层上报的标题条实际底色（按深浅主题分别保存）。写入前
    // 按钮覆盖层用下面的硬编码兜底；深浅切换时另一主题的颜色直接复用，
    // 不会闪色。仅读取 title-bar-overlay-color 频道，格式见取值处校验。
    this.overlayColors = {};

    // AI 工具监听就绪信号：渲染层挂好全部 AI 相关监听（ai-tool-call、
    // request-project-json 等）后发来。SOLO 换工程会重开一个隐藏编辑器窗口，
    // 页面加载要几秒，期间发 ai-tool-call 无人接收、石沉大海，AI 侧表现为
    // 整轮 30 秒超时（"AI 读不到新工程"）。主进程在信号到达前暂存等待。
    this.aiListenersReady = false;
    this.aiListenersReadyPromise = new Promise(resolve => {
      this.resolveAIListenersReady = resolve;
    });
    const markAIListenersReady = (event) => {
      if (event.sender === this.window.webContents) {
        this.aiListenersReady = true;
        this.resolveAIListenersReady();
        ipcMain.removeListener('editor-ai-listeners-ready', markAIListenersReady);
      }
    };
    ipcMain.on('editor-ai-listeners-ready', markAIListenersReady);
    this.window.on('closed', () => {
      ipcMain.removeListener('editor-ai-listeners-ready', markAIListenersReady);
    });

    // 通知图片编辑器等订阅者：项目列表发生了变化
    editorWindowEvents.emit('changed');
    this.window.on('closed', () => {
      editorWindowEvents.emit('changed');
    });

    /**
     * Ideally we would revoke access after loading a new project, but our file handle handling in
     * the GUI isn't robust enough for that yet. We do at least use random file handle IDs which
     * makes it much harder for malicious code in the renderer process to enumerate all previously
     * opened IDs and overwrite them.
     * @type {Map<string, OpenedFile>}
     */
    this.openedFiles = new Map();
    this.activeFileId = null;

    if (initialFile !== null) {
      this.activeFileId = generateFileId();
      this.openedFiles.set(this.activeFileId, initialFile);
    }

    this.openedProjectAt = Date.now();

    /**
     * @param {string} id
     * @returns {OpenedFile}
     * @throws if invalid ID
     */
    const getFileById = (id) => {
      if (!this.openedFiles.has(id)) {
        throw new Error('Invalid file ID');
      }
      return this.openedFiles.get(id);
    };

    let processingWillPreventUnload = false;
    this.window.webContents.on('will-prevent-unload', () => {
      // Using showMessageBoxSync synchronously in the event handler causes broken focus on Windows.
      // See https://github.com/TurboWarp/desktop/issues/1245
      // To work around that, we won't cancel that will-prevent-unload event so the window stays
      // open. After a very short delay to let focus get fixed, we'll show a dialog and force close
      // the window ourselves if the user wants.

      // Due to the timeout, this event could theoretically fire multiple times before we show the
      // dialog. Make sure to only show one dialog if that happens.
      if (processingWillPreventUnload) {
        return;
      }
      processingWillPreventUnload = true;

      setTimeout(() => {
        const choice = dialog.showMessageBoxSync(this.window, {
          title: APP_NAME,
          type: 'info',
          buttons: [
            translate('unload.stay'),
            translate('unload.leave')
          ],
          cancelId: 0,
          defaultId: 0,
          message: translate('unload.message'),
          detail: translate('unload.detail'),
          noLink: true
        });
        if (choice === 1) {
          this.window.destroy();
        }
        processingWillPreventUnload = false;
      });
    });

    this.window.on('page-title-updated', (event, title, explicitSet) => {
      event.preventDefault();
      if (explicitSet && title) {
        this.window.setTitle(`${title} - ${APP_NAME}`);
        this.projectTitle = title;
      } else {
        this.window.setTitle(APP_NAME);
        this.projectTitle = '';
      }

      this.updateRichPresence();
    });
    this.window.setTitle(APP_NAME);

    // Clean up collaboration when editor closes
    this.window.on('closed', () => {
      const collabWindows = AbstractWindow.getWindowsByClass(CollaborationWindow);
      for (const cw of collabWindows) {
        // 只清理挂在本编辑器上的协作会话；
        // 主页「加入协作」的独立表单窗口（尚无编辑器）不受其他编辑器关闭影响
        if (cw.editorWindow !== this) {
          continue;
        }
        cw.forceClose = true;
        if (cw.server) {
          cw.server.end().then(() => { cw.server = null; });
        }
        if (cw.ws) {
          try { cw.ws.close(); } catch (e) {}
          cw.ws = null;
        }
        if (cw.window && !cw.window.isDestroyed()) {
          cw.window.destroy();
        }
      }
    });

    this.window.on('focus', () => {
      this.updateRichPresence();
    });

    // NeoWarp: Windows 窗口控制覆盖层（WCO）。窗口创建时就以"隐藏原生
    // 标题栏 + 原生窗口控制按钮覆盖层"生成（Electron 只能在创建时启用
    // titleBarOverlay，运行期仅能改颜色/高度），「Windows 窗口样式」开关
    // 只影响渲染层呈现：关闭 = 顶部自绘标题条；开启 = 顶栏兼作标题栏。
    if (process.platform === 'win32') {
      this.window.on('enter-full-screen', () => {
        // F11 / Alt+Enter 等 OS 级全屏：渲染层隐藏标题条并取消内容区补偿；
        // 编辑器自身的全屏模式（GUI 内部）不涉及这里
        this.window.webContents.send('os-fullscreen-changed', {fullscreen: true});
      });
      this.window.on('leave-full-screen', () => {
        this.window.webContents.send('os-fullscreen-changed', {fullscreen: false});
      });
      // overlay 按钮底色按生效主题修正：getWindowOptions 里只能同步猜
      // （全局固定主题或系统外观，编辑器自身的主题配置拿不到），这里
      // 在构造完窗口后异步取一次生效主题
      getEffectiveTheme().then((theme) => {
        if (this.window.isDestroyed()) return;
        this.overlayTheme = theme === 'dark' ? 'dark' : 'light';
        this.updateTitleBarOverlay();
      }).catch(() => {});
    }

    // NeoWarp: 渲染层测量并上报标题条的实际底色（自绘标题条或顶栏），
    // 按深浅主题分别保存，确保窗口控制覆盖层（右上角最小化/最大化/
    // 关闭按钮）的底色跟随主题与积木颜色变化，和标题条保持一致。
    this.ipc.on('title-bar-overlay-color', (event, data) => {
      if (!data || (data.theme !== 'dark' && data.theme !== 'light')) {
        return;
      }
      // 只接受不透明的 #rrggbb / #rrggbbaa 十六进制颜色
      if (typeof data.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(data.color)) {
        return;
      }
      this.overlayColors[data.theme] = data.color;
      this.updateTitleBarOverlay();
    });

    this.ipc.on('is-initially-fullscreen', (e) => {
      e.returnValue = isInitiallyFullscreen;
    });

    this.ipc.handle('get-initial-file', () => {
      return this.activeFileId;
    });

    this.ipc.handle('get-file', async (event, id) => {
      const file = getFileById(id);
      const {name, data} = await file.read();

      // Check if this is a .viewsb3 view-only file
      const isViewSb3 = name.endsWith('.viewsb3') ||
        (data && data.length >= 5 && data.slice(0, 5).equals(VSB3_MAGIC));
      if (isViewSb3) {
        try {
          const decrypted = decryptViewSb3(data);
          return {
            name,
            type: file.type,
            data: decrypted,
            isViewOnly: true
          };
        } catch (e) {
          console.error('Failed to decrypt .viewsb3 file:', e.message);
          return {
            name,
            type: file.type,
            data: null,
            isViewOnly: true,
            error: 'Failed to open .viewsb3 file'
          };
        }
      }

      // Check if this is an encrypted .npnp file
      const isNpnp = name.endsWith('.npnp') ||
        (data && data.length >= 5 && data.slice(0, 5).equals(NPNP_MAGIC));
      if (isNpnp) {
        return {
          name,
          type: file.type,
          data: null,
          isEncrypted: true
        };
      }

      return {
        name,
        type: file.type,
        data
      };
    });

    this.ipc.on('set-locale', async (event, locale) => {
      if (settings.locale !== locale) {
        settings.locale = locale;
        updateLocale(locale);

        // Imported late due to circular dependency
        const rebuildMenuBar = require('../menu-bar');
        rebuildMenuBar();

        // Let the save happen in the background, not important
        Promise.resolve().then(() => settings.save());

        // Broadcast locale change to AI assistant window
        const AbstractWindow = require('./abstract');
        const aiWindows = AbstractWindow.getWindowsByClass(AIAssistantWindow);
        aiWindows.forEach((win) => {
          if (win.window && !win.window.isDestroyed()) {
            win.window.webContents.send('ai-locale-changed', { locale });
          }
        });

        // 桌面设置与主页不会自动感知这次切换，重载保持语言同步
        const DesktopSettingsWindow = require('./desktop-settings');
        DesktopSettingsWindow.reloadAll();
        const HomeWindow = require('./home');
        for (const win of AbstractWindow.getWindowsByClass(HomeWindow)) {
          if (!win.window.isDestroyed()) {
            win.reload();
          }
        }
      }
      event.returnValue = {
        strings: getStrings()
      };
    });

    this.ipc.handle('set-changed', (event, changed) => {
      this.window.setDocumentEdited(changed);
    });

    this.ipc.handle('opened-file', (event, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }
      this.activeFileId = id;
      this.openedProjectAt = Date.now();
      this.window.setRepresentedFilename(file.path);
      // SOLO 的隐藏工程宿主不算用户主动打开，不进最近列表
      if (!this.isHiddenHost) {
        recordRecentProject(file.path, 'scratch');
      }
    });

    this.ipc.handle('closed-file', () => {
      this.activeFileId = null;
      this.window.setRepresentedFilename('');
    });

    this.ipc.handle('show-open-file-picker', async () => {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openFile'],
        defaultPath: settings.lastDirectory,
        filters: [
          {
            name: 'Scratch Project',
            extensions: ['np1', 'sb3', 'sb2', 'sb', 'npnp', 'viewsb3'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePaths[0];
      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('show-save-file-picker', async (event, suggestedName) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(settings.lastDirectory, suggestedName),
        filters: [
          {
            name: 'NeoWarp Project',
            extensions: ['np1'],
          },
          {
            name: 'Scratch 3 Project',
            extensions: ['sb3'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePath;

      const unsafePath = getUnsafePaths().find(i => isChildPath(i.path, filePath));
      if (unsafePath) {
        // No need to block until the message box is closed
        dialog.showMessageBox(this.window, {
          type: 'error',
          title: APP_NAME,
          message: translate('unsafe-path.title'),
          detail: translate(`unsafe-path.details`)
            .replace('{APP_NAME}', unsafePath.app)
            .replace('{file}', filePath),
          noLink: true
        });  
        return null;
      }

      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('get-preferred-media-devices', () => {
      return {
        microphone: settings.microphone,
        camera: settings.camera
      };
    });

    this.ipc.on('start-write-stream', async (startEvent, id) => {
      const file = getFileById(id);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }

      const port = startEvent.ports[0];

      /** @type {NodeJS.WritableStream|null} */
      let writeStream = null;

      const handleError = (error) => {
        console.error('Write stream error', error);
        port.postMessage({
          error
        });

        // Make sure the port is started in case we encounter an error before we normally
        // begin to accept messages.
        port.start();
      };

      try {
        writeStream = await createAtomicWriteStream(file.path);
      } catch (error) {
        handleError(error);
        return;
      }

      writeStream.on('atomic-error', handleError);

      const handleMessage = (data) => {
        if (data.write) {
          if (writeStream.write(data.write)) {
            // Still more space in the buffer. Ask for more immediately.
            return;
          }
          // Wait for the buffer to become empty before asking for more.
          return new Promise(resolve => {
            writeStream.once('drain', resolve);
          });
        } else if (data.finish) {
          // Wait for the atomic file write to complete.
          return new Promise(resolve => {
            writeStream.once('atomic-finish', resolve);
            writeStream.end();
          });
        } else if (data.abort) {
          writeStream.emit('error', new Error('Aborted by renderer process'));
          return;
        }
        throw new Error('Unknown message from renderer');
      };

      port.on('message', async (messageEvent) => {
        try {
          const data = messageEvent.data;
          const id = data.id;
          const result = await handleMessage(data);
          port.postMessage({
            response: {
              id,
              result
            }
          });
        } catch (error) {
          handleError(error);
        }
      });

      port.start();
    });

    this.ipc.on('alert', (event, message) => {
      event.returnValue = prompts.alert(this.window, message);
    });

    this.ipc.on('confirm', (event, message) => {
      event.returnValue = prompts.confirm(this.window, message);
    });

    this.ipc.handle('open-packager', () => {
      PackagerWindow.forEditor(this);
    });

    this.ipc.handle('show-encrypted-save-file-picker', async (event, suggestedName) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(settings.lastDirectory, suggestedName + '.npnp'),
        filters: [
          {
            name: 'NeoWarp Encrypted Project',
            extensions: ['npnp'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePath;

      const unsafePath = getUnsafePaths().find(i => isChildPath(i.path, filePath));
      if (unsafePath) {
        dialog.showMessageBox(this.window, {
          type: 'error',
          title: APP_NAME,
          message: translate('unsafe-path.title'),
          detail: translate(`unsafe-path.details`)
            .replace('{APP_NAME}', unsafePath.app)
            .replace('{file}', filePath),
          noLink: true
        });
        return null;
      }

      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('encrypt-and-save', async (event, fileId, data, password) => {
      const file = getFileById(fileId);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }

      const encryptedData = encryptNpnp(Buffer.from(data), password);
      await fsPromises.writeFile(file.path, encryptedData);
    });

    this.ipc.handle('decrypt-npnp-file', async (event, fileId, password) => {
      const file = getFileById(fileId);
      const {data} = await file.read();
      return decryptNpnp(data, password);
    });

    this.ipc.handle('show-viewsb3-save-file-picker', async (event, suggestedName) => {
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: path.join(settings.lastDirectory, suggestedName + '.viewsb3'),
        filters: [
          {
            name: 'NeoWarp View-only Project',
            extensions: ['viewsb3'],
          }
        ]
      });
      if (result.canceled) {
        return null;
      }

      const filePath = result.filePath;

      const unsafePath = getUnsafePaths().find(i => isChildPath(i.path, filePath));
      if (unsafePath) {
        dialog.showMessageBox(this.window, {
          type: 'error',
          title: APP_NAME,
          message: translate('unsafe-path.title'),
          detail: translate('unsafe-path.details')
            .replace('{APP_NAME}', unsafePath.app)
            .replace('{file}', filePath),
          noLink: true
        });
        return null;
      }

      settings.lastDirectory = path.dirname(filePath);
      await settings.save();

      const id = generateFileId();
      this.openedFiles.set(id, new OpenedFile(TYPE_FILE, filePath));

      return {
        id,
        name: path.basename(filePath)
      };
    });

    this.ipc.handle('encrypt-and-save-viewsb3', async (event, fileId, data) => {
      const file = getFileById(fileId);
      if (file.type !== TYPE_FILE) {
        throw new Error('Not a file');
      }

      const encryptedData = encryptViewSb3(Buffer.from(data));
      await fsPromises.writeFile(file.path, encryptedData);
    });

    this.ipc.handle('fetch-image', async (event, url) => {
      try {
        // Also allow importing images from the local filesystem
        if (/^file:/i.test(url)) {
          return await fsPromises.readFile(nodeURL.fileURLToPath(url));
        }
        // Windows drive letter ("C:\...") or UNC path ("\\server\...")
        if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(url)) {
          return await fsPromises.readFile(path.resolve(url));
        }
        const buffer = await privilegedFetch(url);
        return buffer;
      } catch (e) {
        throw new Error('Failed to fetch image: ' + e.message);
      }
    });

    this.ipc.handle('open-new-window', () => {
      EditorWindow.newWindow();
    });

    this.ipc.handle('open-addon-settings', (event, search) => {
      AddonsWindow.show(search);
    });

    this.ipc.handle('open-desktop-settings', () => {
      DesktopSettingsWindow.show();
    });

    this.ipc.handle('open-privacy', () => {
      PrivacyWindow.show();
    });

    this.ipc.handle('open-about', () => {
      AboutWindow.show();
    });

    this.ipc.handle('open-contact', () => {
      ContactWindow.show();
    });

    this.ipc.handle('open-ai-assistant', () => {
      AIAssistantWindow.show(this);
    });

    this.ipc.handle('open-todo-list', () => {
      TodoListWindow.show(this);
    });

    this.ipc.handle('open-project-analysis', () => {
      ProjectAnalysisWindow.show(this);
    });

    this.ipc.handle('open-task-manager', () => {
      TaskManagerWindow.show(this);
    });

    this.ipc.handle('open-mobile-preview', () => {
      MobilePreviewWindow.show(this);
    });

    // NeoWarp: 扩展库「我的扩展」右键「编辑」——解码扩展代码送入扩展编辑器
    this.ipc.handle('open-extension-in-editor', async (event, payload) => {
      const {id, name, url} = payload || {};
      let code = null;
      if (typeof url === 'string' && url.startsWith('data:')) {
        code = decodeDataUrl(url);
      } else if (typeof url === 'string' && /^https?:/i.test(url)) {
        code = (await privilegedFetch(url)).toString('utf8');
      } else {
        throw new Error('Unsupported extension URL');
      }
      // Imported late due to circular dependencies
      const ExtensionEditorWindow = require('./extension-editor');
      ExtensionEditorWindow.openMemoryFile({
        name: name || 'extension.js',
        content: code,
        myExtId: id || null
      });
    });

    this.ipc.on('project-json-response', (event, data) => {
      const aiWindows = AbstractWindow.getWindowsByClass(AIAssistantWindow);
      aiWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('project-code-response', data);
      });
    });

    this.ipc.on('sprite-library-response', (event, data) => {
      const aiWindows = AbstractWindow.getWindowsByClass(AIAssistantWindow);
      aiWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('sprite-library-response', data);
      });
    });

    this.ipc.on('sprite-stats-response', (event, data) => {
      const tmWindows = AbstractWindow.getWindowsByClass(TaskManagerWindow);
      tmWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('sprite-stats-response', data);
      });
      // 图片编辑器查询角色列表：按 requestId 回给发起方
      if (data && data.requestId) {
        const waiter = this._spriteListWaiters && this._spriteListWaiters.get(data.requestId);
        if (waiter) {
          this._spriteListWaiters.delete(data.requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(Array.isArray(data.sprites) ? data.sprites : []);
        }
      }
    });

    // 图片编辑器「导出到 Scratch 项目」：导入造型的结果回执
    this._spriteListWaiters = new Map();
    this._costumeWaiters = new Map();
    this.ipc.on('import-costume-result', (event, data) => {
      if (!data || !data.requestId) return;
      const waiter = this._costumeWaiters.get(data.requestId);
      if (waiter) {
        this._costumeWaiters.delete(data.requestId);
        clearTimeout(waiter.timer);
        waiter.resolve({success: !!data.success, error: data.error || null});
      }
    });

    this.ipc.on('theme-changed', (event, data) => {
      // NeoWarp: overlay 按钮底色跟随编辑器的实际主题（编辑器自身可能
      // 配置了与全局设置不同的主题）
      if (process.platform === 'win32') {
        this.overlayTheme = data && data.theme === 'dark' ? 'dark' : 'light';
        this.updateTitleBarOverlay();
      }
      // 统一走 AIAssistantWindow.broadcastTheme：里面会连同 SOLO（子类）一起广播
      AIAssistantWindow.broadcastTheme(data.theme);
      const todoWindows = AbstractWindow.getWindowsByClass(TodoListWindow);
      todoWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('todo-theme-changed', data);
      });
      const paWindows = AbstractWindow.getWindowsByClass(ProjectAnalysisWindow);
      paWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('pa-theme-changed', data);
      });
      const tmWindows = AbstractWindow.getWindowsByClass(TaskManagerWindow);
      tmWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('tm-theme-changed', data);
      });
      const dsWindows = AbstractWindow.getWindowsByClass(DesktopSettingsWindow);
      dsWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('ds-theme-changed', data);
      });
      const contactWindows = AbstractWindow.getWindowsByClass(ContactWindow);
      contactWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('contact-theme-changed', data);
      });
      const mpWindows = AbstractWindow.getWindowsByClass(MobilePreviewWindow);
      mpWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('mobile-preview-theme-changed', data);
      });
      const collabWindows = AbstractWindow.getWindowsByClass(CollaborationWindow);
      collabWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('collab-theme-changed', data);
      });
      const homeWindows = AbstractWindow.getWindowsByClass(HomeWindow);
      homeWindows.forEach(w => {
        if (!w.window.isDestroyed()) w.window.webContents.send('home-theme-changed', data);
      });
    });

    this.ipc.handle('get-advanced-customizations', async () => {
      const USERSCRIPT_PATH = path.join(app.getPath('userData'), 'userscript.js');
      const USERSTYLE_PATH = path.join(app.getPath('userData'), 'userstyle.css');

      const [userscript, userstyle] = await Promise.all([
        fsPromises.readFile(USERSCRIPT_PATH, 'utf-8').catch(() => ''),
        fsPromises.readFile(USERSTYLE_PATH, 'utf-8').catch(() => '')
      ]);

      return {
        userscript,
        userstyle
      };
    });

    // NeoWarp: 本地 Expands 扩展目录（扩展库 NeoWarp 标签的数据源）
    this.ipc.handle('get-neowarp-expands', () => scanExpands());

    // 全局 UI 主题（桌面设置里配置）：编辑器挂载时读取一次，
    // 之后的变更由桌面设置广播（global-ui-theme-changed）推送
    this.ipc.handle('editor-get-global-ui-theme', () => settings.uiTheme);

    // 顶部工具栏高度（桌面设置 → UI 设置）：在 React 渲染前同步读一次，
    // 让 Blockly 首次注入时就按正确高度测量代码区；之后的变更由桌面设置
    // 广播（toolbar-height-changed）推送。
    this.ipc.on('editor-get-toolbar-height', (event) => {
      event.returnValue = settings.toolbarHeight;
    });

    // NeoWarp: Windows 窗口控制覆盖层状态：渲染层在 React 渲染前同步
    // 读取一次，决定画自绘标题条还是把顶栏兼作标题栏；之后的切换由
    // compact-window-style-changed 广播推送（见 applyCompactWindowStyle）。
    this.ipc.on('editor-get-window-controls-overlay-state', (event) => {
      const hasOverlay = process.platform === 'win32';
      event.returnValue = {
        hasOverlay,
        compact: hasOverlay && settings.compactWindowStyle
      };
    });

    this.ipc.on('get-code-area-background-image', (event) => {
      event.returnValue = settings.codeAreaBackgroundImage;
    });

    this.ipc.handle('set-code-area-background-image', async (event, imageData) => {
      settings.codeAreaBackgroundImage = imageData;
      AbstractWindow.settingsChanged();
      await settings.save();
    });

    this.ipc.on('get-stage-area-background-image', (event) => {
      event.returnValue = settings.stageAreaBackgroundImage;
    });

    this.ipc.on('get-top-bar-device-stats', (event) => {
      event.returnValue = settings.topBarDeviceStats;
    });

    // NeoWarp: 右键菜单毛玻璃（桌面设置 → UI 设置）：渲染前同步读一次，
    // 变更由桌面设置广播（context-menu-glass-changed）实时推送。
    this.ipc.on('editor-get-context-menu-glass', (event) => {
      event.returnValue = settings.contextMenuGlass;
    });

    this.ipc.handle('set-stage-area-background-image', async (event, imageData) => {
      settings.stageAreaBackgroundImage = imageData;
      AbstractWindow.settingsChanged();
      await settings.save();
    });

    // NeoWarp: 编辑器标签栏「源代码Beta」按钮显隐开关（编辑器设置模态框 →
    // 外观）。渲染前同步读取一次；设置模态框保存后广播给所有编辑器窗口，
    // 标签栏按钮实时显隐，无需重启。
    this.ipc.on('get-show-source-code-button', (event) => {
      event.returnValue = settings.showSourceCodeButton;
    });

    this.ipc.handle('set-show-source-code-button', async (event, enabled) => {
      if (typeof enabled !== 'boolean') {
        return;
      }
      settings.showSourceCodeButton = enabled;
      AbstractWindow.settingsChanged();
      await settings.save();
      for (const editorWindow of AbstractWindow.getWindowsByClass(EditorWindow)) {
        if (!editorWindow.window.isDestroyed()) {
          editorWindow.window.webContents.send('show-source-code-button-changed', enabled);
        }
      }
    });

    this.ipc.handle('check-drag-and-drop-path', (event, filePath) => {
      FileAccessWindow.check(filePath);
    });

    /**
     * Refers to the full screen button in the editor, not the OS-level fullscreen through
     * F11/Alt+Enter (Windows, Linux) or buttons provided by the OS (macOS).
     */
    this.isInEditorFullScreen = false;

    this.ipc.handle('set-is-full-screen', (event, isFullScreen) => {
      this.isInEditorFullScreen = !!isFullScreen;
    });

    // NeoWarp: System stats monitoring
    // Store initial CPU times for calculating usage percentage like Task Manager
    this.lastCpuTimes = this._getCpuTimes();
    this.lastCpuCheckTime = Date.now();
    
    this.ipc.handle('get-system-stats', () => {
      const currentCpuTimes = this._getCpuTimes();
      const currentTime = Date.now();
      const timeDelta = (currentTime - this.lastCpuCheckTime) / 1000; // Convert to seconds
      
      // Calculate CPU usage percentage like Windows Task Manager
      // Formula: (idle time difference / total time difference) * 100
      const idleDiff = currentCpuTimes.idle - this.lastCpuTimes.idle;
      const totalDiff = currentCpuTimes.total - this.lastCpuTimes.total;
      
      let cpuPercent = 0;
      if (totalDiff > 0) {
        cpuPercent = Math.round((1 - idleDiff / totalDiff) * 100);
      }
      
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      
      // Update last values for next calculation
      this.lastCpuTimes = currentCpuTimes;
      this.lastCpuCheckTime = currentTime;
      
      return {
        cpuPercent: Math.min(Math.max(cpuPercent, 0), 100), // Clamp between 0-100
        ramUsedMB: Math.round(usedMemory / 1024 / 1024),
        ramTotalMB: Math.round(totalMemory / 1024 / 1024)
      };
    });

    // NeoWarp: AI tool - get complete system info (uses Node.js native os module
    // to avoid os-browserify polyfill issue in webpack-bundled renderer)
    this.ipc.handle('get-ai-system-info', () => {
      try {
        const cpus = os.cpus();
        const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
        return {
          success: true,
          data: {
            model: cpuModel,
            cores: cpus.length,
            speed: cpus.length > 0 ? cpus[0].speed + ' MHz' : 'Unknown',
            architecture: os.arch(),
            platform: os.platform(),
            release: os.release(),
            hostname: os.hostname(),
            totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 100) / 100 + ' GB',
            freeMemory: Math.round(os.freemem() / (1024 * 1024 * 1024) * 100) / 100 + ' GB',
            uptime: Math.round(os.uptime() / 3600 * 100) / 100 + ' hours',
            userInfo: os.userInfo().username,
            homedir: os.homedir(),
            endianness: os.endianness()
          }
        };
      } catch (e) {
        return { success: false, error: 'Failed to get system info: ' + e.message };
      }
    });

    // NeoWarp: Detached stage window
    this.detachedStageWindow = null;

    this.ipc.handle('detach-stage', (event, stageWidth, stageHeight) => {
      if (this.detachedStageWindow) {
        return;
      }
      this.detachedStageWindow = new DetachedStageWindow(this.window, this, stageWidth, stageHeight);
      this.window.webContents.send('stage-detached');
    });

    this.ipc.handle('reattach-stage', () => {
      if (this.detachedStageWindow) {
        this.detachedStageWindow.close();
        this.detachedStageWindow = null;
      }
    });

    this.ipc.on('stage-frame', (event, dataURL) => {
      if (this.detachedStageWindow) {
        this.detachedStageWindow.sendFrame(dataURL);
      }
    });

    // NeoWarp: Collaboration
    this.ipc.handle('open-collaboration-host', () => {
      CollaborationWindow.showHost(this);
    });

    this.ipc.handle('open-collaboration-join', () => {
      CollaborationWindow.showJoin(this);
    });

    this.ipc.handle('end-collaboration', () => {
      // Forward to collaboration window if it exists
      const collabWindows = AbstractWindow.getWindowsByClass(CollaborationWindow);
      if (collabWindows.length > 0) {
        collabWindows[0].window.webContents.send('collab-end-requested');
      }
    });

    this.ipc.handle('leave-collaboration', () => {
      const collabWindows = AbstractWindow.getWindowsByClass(CollaborationWindow);
      if (collabWindows.length > 0) {
        collabWindows[0].window.webContents.send('collab-leave-requested');
      }
    });

    this.ipc.handle('open-collaboration-chat', () => {
      CollaborationWindow.focusChat(this);
    });

    // Project JSON flows from the editor renderer to the collaboration window.
    // Per-frame IPC only delivers messages sent from the same frame, so these
    // must be registered HERE (on the editor's own frame), not on the
    // collaboration window's frame, or the messages are silently dropped.
    this.ipc.on('collab-send-project-json', (event, { project, targetUsername }) => {
      const collabWindow = AbstractWindow.getWindowsByClass(CollaborationWindow)
        .find(cw => cw.editorWindow === this);
      if (collabWindow) {
        collabWindow.handleProjectJSONFromEditor(project, targetUsername);
      }
    });

    this.ipc.on('collab-send-project-update', (event, { project }) => {
      const collabWindow = AbstractWindow.getWindowsByClass(CollaborationWindow)
        .find(cw => cw.editorWindow === this);
      if (collabWindow) {
        collabWindow.handleProjectUpdateFromEditor(project);
      }
    });

    this.loadURL('tw-editor://./gui/gui.html');
    if (!options || !options.hidden) {
      this.show();
    }

    // 扩展编辑器「添加到项目」按钮的显隐跟随可见编辑器数量；
    // 打开/关闭编辑器窗口时广播一次（循环依赖，运行时再加载）
    require('./extension-editor').notifyProjectsChanged();
    this.window.on('closed', () => {
      require('./extension-editor').notifyProjectsChanged();
    });
  }

  handleDetachedStageClosed() {
    this.detachedStageWindow = null;
    try {
      this.window.webContents.send('stage-reattached');
    } catch (e) {
      // Window might be closing
    }
  }

  handleDetachedStageInput(inputData) {
    try {
      this.window.webContents.send('detached-stage-input', inputData);
    } catch (e) {
      // Window might be closing
    }
  }

  /**
   * Get aggregated CPU times across all cores
   * Similar to how Windows Task Manager calculates CPU usage
   */
  _getCpuTimes() {
    const cpus = os.cpus();
    let user = 0;
    let nice = 0;
    let sys = 0;
    let idle = 0;
    let irq = 0;
    
    for (const cpu of cpus) {
      user += cpu.times.user;
      nice += cpu.times.nice;
      sys += cpu.times.sys;
      idle += cpu.times.idle;
      irq += cpu.times.irq;
    }
    
    return {
      user,
      nice,
      sys,
      idle,
      irq,
      total: user + nice + sys + idle + irq
    };
  }

  /** 项目标题（窗口标题去掉 " - <APP_NAME>" 后缀） */
  getProjectTitle () {
    try {
      const title = this.window.getTitle();
      if (!title || title === APP_NAME) return '';
      const suffix = ` - ${APP_NAME}`;
      return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
    } catch (e) {
      return '';
    }
  }

  /**
   * 本窗口项目的角色列表（含造型数量），供图片编辑器选择导入目标。
   * 走渲染层已有的 request-sprite-stats 通道，按 requestId 匹配响应。
   * @returns {Promise<Array<{id: string, name: string, isStage: boolean, costumeCount: number}>>}
   */
  getSpriteList () {
    if (this.window.isDestroyed()) return Promise.resolve([]);
    return new Promise(resolve => {
      const requestId = `sprites-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = setTimeout(() => {
        this._spriteListWaiters.delete(requestId);
        resolve([]);
      }, 4000);
      this._spriteListWaiters.set(requestId, {resolve, timer});
      try {
        this.window.webContents.send('request-sprite-stats', {requestId});
      } catch (e) {
        clearTimeout(timer);
        this._spriteListWaiters.delete(requestId);
        resolve([]);
      }
    });
  }

  /**
   * 把一张 PNG（dataURL）导入本窗口项目：
   * spriteId 有值 → 作为该角色的新造型；为空 → 新建一个角色。
   * @param {{spriteId?: string|null, name?: string, dataUrl: string, asNewSprite?: boolean}} payload
   * @returns {Promise<{success: boolean, error?: string|null}>}
   */
  importCostume (payload) {
    if (this.window.isDestroyed()) return Promise.resolve({success: false, error: '目标项目已关闭'});
    const {spriteId, name, dataUrl, asNewSprite} = payload || {};
    return new Promise(resolve => {
      const requestId = `costume-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = setTimeout(() => {
        this._costumeWaiters.delete(requestId);
        resolve({success: false, error: '导入超时'});
      }, 30000);
      this._costumeWaiters.set(requestId, {resolve, timer});
      try {
        this.window.webContents.send('import-costume', {
          requestId,
          targetId: spriteId || null,
          name,
          dataUrl,
          asNewSprite: !!asNewSprite
        });
      } catch (e) {
        clearTimeout(timer);
        this._costumeWaiters.delete(requestId);
        resolve({success: false, error: String((e && e.message) || e)});
      }
    });
  }

  /**
   * NeoWarp: Windows 窗口控制覆盖层（WCO）。只有创建时才能启用
   * titleBarOverlay（运行期仅能改颜色/高度），所以无论「Windows 窗口
   * 样式」开关如何都以 hidden + overlay 创建，开关只切换渲染层呈现
   * （见 window-titlebar.js 与 gui.css）；compactWindowStyle 的处理、
   * 主题配色与主题修正见构造函数。
   */
  getWindowOptions () {
    const options = super.getWindowOptions();
    if (process.platform === 'win32') {
      options.titleBarStyle = 'hidden';
      options.titleBarOverlay = this.getTitleBarOverlayOptions();
    }
    return options;
  }

  getPreload () {
    return 'editor';
  }

  getDimensions () {
    return {
      width: 1280,
      height: 800
    };
  }

  getBackgroundColor () {
    return '#333333';
  }

  applySettings () {
    this.window.webContents.setBackgroundThrottling(settings.backgroundThrottling);
  }

  enumerateMediaDevices () {
    // Used by desktop settings
    return new Promise((resolve, reject) => {
      this.ipc.once('enumerated-media-devices', (event, result) => {
        if (typeof result.error !== 'undefined') {
          reject(result.error);
        } else {
          resolve(result.devices);
        }
      });
      this.window.webContents.send('enumerate-media-devices');
    });
  }

  handleWindowOpen (details) {
    const url = new URL(details.url);
    const params = new URLSearchParams(url.search);

    // Open extension sample projects in-app
    if (
      url.protocol === 'tw-editor:' &&
      url.host === '.' &&
      params.has('project_url')
    ) {
      const projectUrl = params.get('project_url');
      const parsedFile = parseOpenedFile(projectUrl, null);
      if (parsedFile.type === TYPE_SAMPLE) {
        new EditorWindow(parsedFile, null);
        return {
          action: 'deny'
        };
      }
    }

    // Open extension documentation in-app
    const extensionsDocsMatch = details.url.match(
      /^https:\/\/extensions\.turbowarp\.org\/([\w_\-.\/]+)$/
    );
    if (extensionsDocsMatch) {
      ExtensionDocumentationWindow.open(extensionsDocsMatch[1]);
      return {
        action: 'deny'
      };
    }

    return super.handleWindowOpen(details);
  }

  canExitFullscreenByPressingEscape () {
    return !this.isInEditorFullScreen;
  }

  updateRichPresence () {
    RichPresence.setActivity(this.projectTitle, this.openedProjectAt);
  }

  /**
   * NeoWarp: 更新 Windows 窗口控制覆盖层（按钮底色/符号色/高度）。
   * 只有 compactWindowStyle 开关和主题变化时需要调用。
   */
  updateTitleBarOverlay () {
    if (process.platform !== 'win32') {
      return;
    }
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    try {
      this.window.setTitleBarOverlay(this.getTitleBarOverlayOptions());
    } catch (e) {
      // setTitleBarOverlay 要求窗口创建时启用了 titleBarOverlay；
      // 编辑器窗口都启用，万一失败保持系统默认按钮样式即可
    }
  }

  /**
   * NeoWarp: Windows 窗口控制覆盖层配置。配色跟随生效主题（亮色 =
   * 渲染层上报的标题条实际底色，兜底为 TurboWarp 默认强调色红；深色
   * = #333333，与渲染层标题条变量一致）；高度对应渲染层布局：未开启
   * 紧凑样式时为自绘标题条高度 32px，开启后等于窄档顶栏 36px。
   */
  getTitleBarOverlayOptions () {
    let isDark;
    if (this.overlayTheme === 'dark' || this.overlayTheme === 'light') {
      isDark = this.overlayTheme === 'dark';
    } else {
      // super() 构造窗口时构造体还没跑到主题修正：同步只有全局设置与
      // 系统外观可用，构造完成后会按生效主题立即刷新一次
      isDark = settings.uiTheme === 'dark' ||
        (settings.uiTheme !== 'light' && nativeTheme.shouldUseDarkColors);
    }
    return {
      color: (this.overlayColors && this.overlayColors[isDark ? 'dark' : 'light']) ||
        (isDark ? '#333333' : '#ff4c4c'),
      symbolColor: '#ffffff',
      height: settings.compactWindowStyle ? 36 : 32
    };
  }

  /**
   * NeoWarp: 桌面设置切换「Windows 窗口样式」后统一应用到所有编辑器：
   * 更新覆盖层高度（32 ⇄ 36）并广播渲染层切换标题栏布局。
   */
  static applyCompactWindowStyle () {
    for (const editorWindow of AbstractWindow.getWindowsByClass(EditorWindow)) {
      if (editorWindow.window.isDestroyed()) {
        continue;
      }
      editorWindow.updateTitleBarOverlay();
      editorWindow.window.webContents.send('compact-window-style-changed', settings.compactWindowStyle === true);
    }
  }

  /**
   * @param {string[]} files
   * @param {boolean} fullscreen
   * @param {string|null} workingDirectory
   */
  static openFiles (files, fullscreen, workingDirectory) {
    const windows = [];
    if (files.length === 0) {
      windows.push(EditorWindow.newWindow(fullscreen));
    } else {
      for (const file of files) {
        windows.push(new EditorWindow(parseOpenedFile(file, workingDirectory), fullscreen));
      }
    }
    return windows;
  }

  /**
   * Open a new window with the default project.
   * @param {boolean} fullscreen
   * @returns {EditorWindow} the created window
   */
  static newWindow (fullscreen) {
    const window = new EditorWindow(null, fullscreen);
    return window;
  }

  /**
   * 以隐藏窗口打开工程文件：窗口不显示，仅作为 SOLO 这类
   * "无编辑器界面"功能的工程宿主（VM、AI 工具 IPC 都照常工作）。
   * @param {string} filePath 本地工程文件绝对路径
   * @returns {EditorWindow}
   */
  static openHidden (filePath) {
    return new EditorWindow(parseOpenedFile(filePath, null), false, {hidden: true});
  }
}

module.exports = EditorWindow;
