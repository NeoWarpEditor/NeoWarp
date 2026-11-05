const AbstractWindow = require('./abstract');
const {ipcMain, nativeTheme, dialog} = require('electron');
const {translate, getLocale} = require('../l10n');
const {APP_NAME} = require('../brand');
const settings = require('../settings');
const {getEffectiveTheme} = require('../effective-theme');
const privilegedFetch = require('../fetch');
const phoneSync = require('../phone-sync');
const {registerAiModelConfigIpc} = require('../ai-model-configs');
const {registerAiWorkflowIpc} = require('../ai-workflow-settings');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// iconv-lite 是间接依赖，用于解码 GBK/GB2312 等非 UTF-8 页面；缺失时退回 UTF-8
let iconv = null;
try {
  iconv = require('iconv-lite');
} catch (e) {
  iconv = null;
}

/**
 * Fetch URL with redirect support, returns text content.
 * Handles gzip/deflate/br compression and non-UTF-8 charsets.
 * @param {string} url
 * @param {object} options
 * @param {number} maxRedirects
 * @returns {Promise<string>}
 */
function fetchText (url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsedURL = new URL(url);
    const mod = parsedURL.protocol === 'http:' ? http : https;
    const headers = Object.assign({'Accept-Encoding': 'gzip, deflate, br'}, options.headers || {});
    const req = mod.get(url, Object.assign({}, options, {headers}), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        let redirectUrl = res.headers.location;
        // Handle protocol-relative URLs (//example.com/path)
        if (redirectUrl.startsWith('//')) {
          redirectUrl = parsedURL.protocol + redirectUrl;
        } else if (redirectUrl.startsWith('/')) {
          // Handle absolute paths
          redirectUrl = parsedURL.origin + redirectUrl;
        } else if (!redirectUrl.startsWith('http')) {
          // Handle relative paths
          redirectUrl = parsedURL.origin + parsedURL.pathname.replace(/[^/]*$/, '') + redirectUrl;
        }
        res.resume();
        return resolve(fetchText(redirectUrl, options, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      // 压缩响应不解压直接当文本解析会得到一堆二进制垃圾
      let stream = res;
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      const chunks = [];
      stream.on('data', chunk => { chunks.push(chunk); });
      stream.on('error', reject);
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        const charsetMatch = contentType.match(/charset=["']?([\w-]+)/i);
        const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
        if (charset !== 'utf-8' && charset !== 'utf8' && iconv && iconv.encodingExists(charset)) {
          try {
            return resolve(iconv.decode(buffer, charset));
          } catch (e) {
            // fall through to utf-8
          }
        }
        resolve(buffer.toString('utf-8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Decode HTML entities: named entities plus numeric (&#123; / &#x1F;) references.
 * Search-engine result HTML is full of entities like &ensp; &#0183; &amp;.
 * @param {string} text
 * @returns {string}
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', minus: '−',
  copy: '©', reg: '®', trade: '™', deg: '°',
  middot: '·', bull: '•', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', divide: '÷', plusmn: '±', sect: '§', para: '¶'
};
function decodeEntities (text) {
  if (!text) return '';
  return text
    .replace(/&#(x?[0-9a-fA-F]+);/g, (m, code) => {
      const n = (code[0] === 'x' || code[0] === 'X') ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      if (isNaN(n) || n < 0 || n > 0x10FFFF) return m;
      try {
        return String.fromCodePoint(n);
      } catch (e) {
        return m;
      }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m
    ));
}

/**
 * Strip HTML tags and decode entities, collapsing whitespace.
 * @param {string} html
 * @returns {string}
 */
function htmlToText (html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Decode a DuckDuckGo redirect URL to extract the actual target URL.
 * DuckDuckGo wraps result URLs like: //duckduckgo.com/l/?uddg=<encoded>&rut=...
 * @param {string} rawUrl
 * @returns {string}
 */
function decodeDDGUrl (rawUrl) {
  if (!rawUrl) return '';
  // Handle protocol-relative URLs
  let url = rawUrl;
  if (url.startsWith('//')) url = 'https:' + url;
  // Extract uddg parameter from redirect URLs
  const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch (e) {
      return rawUrl;
    }
  }
  return rawUrl;
}

/**
 * Parse DuckDuckGo HTML search results.
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
function parseDDGResults (html) {
  const results = [];
  // Match result anchors regardless of attribute order; href is pulled out of the tag itself
  const linkRegex = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null && results.length < 8) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const hrefMatch = tag.match(/href="([^"]*)"/i);
    if (!hrefMatch) continue;
    const url = decodeDDGUrl(decodeEntities(hrefMatch[1]));
    if (!url) continue;
    const title = htmlToText(m[1]);
    // 摘要跟在同一条结果后面；全局分别收集再按下标配对会在缺摘要时整体错位
    const rest = html.slice(m.index, m.index + 4000);
    const snippetMatch = rest.match(/<(?:a|td)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td)>/i);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : '';
    results.push({title: title, url: url, snippet: snippet});
  }
  return results;
}

/**
 * Parse Bing HTML search results.
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
function parseBingResults (html) {
  const results = [];
  // Bing results use <li class="b_algo"> with <h2><a href="...">title</a></h2> and <p>snippet</p>
  const itemRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itemRegex.exec(html)) !== null && results.length < 8) {
    const block = m[1];
    // 真正的标题链接在 <h2> 里；块内第一个 <a> 现在是面包屑（域名+路径），
    // 直接取第一个会把 "fandom.comhttps://... › wiki › ..." 当成标题
    let linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    }
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1]);
    const title = htmlToText(linkMatch[2]);
    if (!title || !url) continue;
    // Snippet is usually in <p> or class="b_caption"
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : '';
    results.push({title: title, url: url, snippet: snippet});
  }
  return results;
}

/**
 * Extract readable text content from an HTML string.
 * @param {string} html
 * @returns {string}
 */
function extractPageContent (html) {
  if (!html) return '';
  var text = html;
  // Remove script, style, nav, footer, header, aside, form, noscript, svg tags and their contents
  text = text.replace(/<(script|style|nav|footer|header|aside|form|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode HTML entities (named + numeric)
  text = decodeEntities(text);
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  // Truncate to 2000 characters
  if (text.length > 2000) text = text.substring(0, 2000);
  return text;
}

/**
 * Perform web search using DuckDuckGo HTML, Bing, and Wikipedia API.
 * @param {string} query
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function webSearch (query) {
  const results = [];
  const errors = [];
  const seenUrls = new Set();

  // Helper to add results without duplicates
  function addResult (r) {
    if (r.url && !seenUrls.has(r.url)) {
      seenUrls.add(r.url);
      results.push(r);
    }
  }

  // DuckDuckGo HTML search
  try {
    const searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const html = await fetchText(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://duckduckgo.com/'
      }
    });
    const ddgResults = parseDDGResults(html);
    ddgResults.forEach(r => addResult({...r, source: 'DuckDuckGo'}));
  } catch (e) {
    errors.push('DuckDuckGo: ' + e.message);
  }

  // Bing search as fallback / supplement
  if (results.length < 5) {
    try {
      const bingUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
      const bingHtml = await fetchText(bingUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });
      const bingResults = parseBingResults(bingHtml);
      bingResults.forEach(r => addResult({...r, source: 'Bing'}));
    } catch (e) {
      errors.push('Bing: ' + e.message);
    }
  }

  // DuckDuckGo Instant Answer API as fallback
  if (results.length === 0) {
    try {
      const apiUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
      const data = await privilegedFetch.json(apiUrl);
      if (data.Abstract) {
        addResult({
          title: data.Heading || query,
          url: data.AbstractURL || '',
          snippet: data.Abstract,
          source: data.AbstractSource || 'DuckDuckGo'
        });
      }
      if (data.RelatedTopics) {
        data.RelatedTopics.forEach(t => {
          if (t.Text && results.length < 12) {
            addResult({
              title: t.Text.substring(0, 80),
              url: t.FirstURL || '',
              snippet: t.Text,
              source: 'DuckDuckGo'
            });
          }
        });
      }
    } catch (e) {
      errors.push('DuckDuckGo API: ' + e.message);
    }
  }

  // Wikipedia search - try both Chinese and English
  const wikiSources = [
    {lang: 'zh', label: 'Wikipedia', url: 'https://zh.wikipedia.org/w/api.php'},
    {lang: 'en', label: 'Wikipedia (EN)', url: 'https://en.wikipedia.org/w/api.php'}
  ];
  for (const src of wikiSources) {
    if (results.length >= 12) break;
    try {
      const wikiUrl = src.url + '?action=query&list=search&srsearch=' +
        encodeURIComponent(query) + '&format=json&srlimit=3&utf8=1';
      const wikiData = await privilegedFetch.json(wikiUrl);
      if (wikiData.query && wikiData.query.search) {
        wikiData.query.search.forEach(s => {
          addResult({
            title: s.title,
            url: 'https://' + src.lang + '.wikipedia.org/wiki/' + encodeURIComponent(s.title),
            snippet: s.snippet.replace(/<[^>]+>/g, '').trim(),
            source: src.label
          });
        });
      }
    } catch (e) {
      errors.push(src.label + ': ' + e.message);
    }
  }

  // Fetch page content for top 3 results
  const topResults = results.slice(0, 3);
  for (const r of topResults) {
    try {
      const pageHtml = await fetchText(r.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });
      r.content = extractPageContent(pageHtml);
    } catch (e) {
      // Silently skip content extraction on failure
    }
  }

  if (results.length === 0) {
    return {success: false, error: 'No results found. ' + errors.join('; ')};
  }
  const out = {success: true, data: results.slice(0, 12)};
  // 部分搜索源失败时也告诉调用方，避免"只剩一个源的劣质结果"被当成完整结果
  if (errors.length) {
    out.warnings = errors;
  }
  return out;
}

class AIAssistantWindow extends AbstractWindow {
  constructor (editorWindow) {
    super();

    this.editorWindow = editorWindow;

    this.window.on('page-title-updated', event => {
      event.preventDefault();
    });
    this.window.setTitle(`AI Assistant`);

    this.ipc.handle('get-project-code', async () => {
      // 编辑器页面还没挂好监听时先等就绪信号，再走原有 5 秒取码逻辑；
      // 否则请求落进未挂监听的页面里，AI 拿到 null 当成"工程是空的"
      if (this.editorWindow && !this.editorWindow.window.isDestroyed() &&
          this.editorWindow.aiListenersReady !== true) {
        await Promise.race([
          this.editorWindow.aiListenersReadyPromise,
          new Promise(resolve => setTimeout(resolve, 25000))
        ]);
        if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
          return null;
        }
      }
      return new Promise((resolve) => {
        if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
          resolve(null);
          return;
        }
        // 随机后缀：多个窗口（SOLO + AI 助手）在同一毫秒各发一次请求时，
        // 纯时间戳的 requestId 会撞车，导致结果互相串台
        const requestId = Date.now().toString() + Math.random().toString(16).slice(2);
        const handler = (event, data) => {
          if (data && data.requestId === requestId) {
            ipcMain.removeListener('project-json-response', handler);
            resolve(data.projectJSON || null);
          }
        };
        ipcMain.on('project-json-response', handler);
        this.editorWindow.window.webContents.send('request-project-json', { requestId });
        setTimeout(() => {
          ipcMain.removeListener('project-json-response', handler);
          resolve(null);
        }, 5000);
      });
    });

    this.ipc.handle('apply-project', async (event, projectJSON) => {
      if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
        return { success: false, error: 'Editor window not available' };
      }
      this.editorWindow.window.webContents.send('apply-project', { projectJSON });
      return { success: true };
    });

    this.ipc.handle('apply-sprite', async (event, spriteJSON, targetId) => {
      if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
        return { success: false, error: 'Editor window not available' };
      }
      this.editorWindow.window.webContents.send('apply-sprite', { spriteJSON, targetId });
      return { success: true };
    });

    this.ipc.handle('ai-tool-call', (event, toolName, params) => this.handleAIToolCall(toolName, params));

    // 统一的 AI 模型配置存储（与 SOLO、扩展编辑器、桌面设置共用）：
    // 读取/保存/广播 + 打开桌面设置窗口
    registerAiModelConfigIpc(this.ipc);

    // AI 工作流设置（Plan / Spec / Goal 默认项与文档保存位置）：
    // 读取/保存/广播 + 选目录 + 文档落盘；SOLO 继承本窗口构造函数，自动获得
    registerAiWorkflowIpc(this.ipc);

    this.ipc.handle('get-sprite-library', async () => {
      if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
        return null;
      }
      return new Promise((resolve) => {
        // 回带 requestId：响应走全局通道，并发请求（多窗口/多工具并行）
        // 没有它就会互相串台
        const requestId = Date.now().toString() + Math.random().toString(16).slice(2);
        const handler = (event, data) => {
          if (data && data.requestId !== requestId) return;
          ipcMain.removeListener('sprite-library-response', handler);
          resolve((data && data.data) || null);
        };
        ipcMain.on('sprite-library-response', handler);
        this.editorWindow.window.webContents.send('request-sprite-library', { requestId });
        setTimeout(() => {
          ipcMain.removeListener('sprite-library-response', handler);
          resolve(null);
        }, 5000);
      });
    });

    this.ipc.handle('web-search', async (event, query) => {
      try {
        return await webSearch(query);
      } catch (e) {
        return {success: false, error: e.message};
      }
    });

    this.ipc.handle('ai-get-theme', () => {
      if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
        // 没有编辑器可问（SOLO 未挂工程 / js 工程）时，按桌面设置的
        // 全局主题解析，不再硬编码浅色
        return getEffectiveTheme();
      }
      return new Promise((resolve) => {
        const requestId = Date.now().toString() + Math.random().toString(16).slice(2);
        const handler = (event, data) => {
          if (data && data.requestId === requestId) {
            ipcMain.removeListener('theme-response', handler);
            resolve(data.theme || 'light');
          }
        };
        ipcMain.on('theme-response', handler);
        this.editorWindow.window.webContents.send('request-theme', { requestId });
        setTimeout(() => {
          ipcMain.removeListener('theme-response', handler);
          getEffectiveTheme().then(resolve);
        }, 3000);
      });
    });

    this.ipc.handle('ai-get-locale', () => {
      return getLocale() || 'en';
    });

    // 手机编程：局域网同步服务（扫码后手机加载的就是这份桌面页面本体）
    this.ipc.handle('ai-get-phone-link', () => {
      phoneSync.register(this, ipcMain);
      return phoneSync.getLinkInfo();
    });
    this.ipc.handle('ai-phone-get-state', () => phoneSync.getSnapshot());
    const onPhoneBroadcast = (event, payload) => {
      // 只接受 AI 窗口自身的广播
      if (event.sender === this.window.webContents) {
        phoneSync.broadcast(payload);
      }
    };
    ipcMain.on('ai-phone-broadcast', onPhoneBroadcast);
    // ipcMain 是全局的，窗口关掉后要摘掉监听，否则反复开关会越积越多
    this.window.on('closed', () => {
      ipcMain.removeListener('ai-phone-broadcast', onPhoneBroadcast);
    });

    // AI 任务未完成时拦截窗口关闭（点 X、Esc、ai-close-window、退出应用都会触发）：
    // 渲染层在生成期间用 beforeunload 阻止卸载，这里弹确认框通知用户，
    // 让其选择继续等待还是中断输出强制关闭
    let processingWillPreventUnload = false;
    this.window.webContents.on('will-prevent-unload', () => {
      // 与 editor.js 相同：事件回调里同步弹框会导致 Windows 焦点异常，
      // 先让窗口保持打开，稍等一拍再弹框
      if (processingWillPreventUnload) {
        return;
      }
      processingWillPreventUnload = true;
      setTimeout(() => {
        if (!this.window || this.window.isDestroyed()) {
          processingWillPreventUnload = false;
          return;
        }
        const choice = dialog.showMessageBoxSync(this.window, {
          title: APP_NAME,
          type: 'warning',
          buttons: [
            translate('ai-close.stay'),
            translate('ai-close.leave')
          ],
          cancelId: 0,
          defaultId: 0,
          message: translate('ai-close.message'),
          detail: translate('ai-close.detail'),
          noLink: true
        });
        if (choice === 1) {
          // destroy 绕过 beforeunload，强制关闭
          this.window.destroy();
        }
        processingWillPreventUnload = false;
      });
    });

    this.ipc.handle('ai-close-window', () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }
      return { success: true };
    });

    this.loadURL(this.getPageURL());
    this.show();
  }

  /**
   * 助手页面地址。SoloWindow 覆写为 tw-solo 协议下的同一页面：
   * 协议不同源，localStorage 隔离，SOLO 拥有独立的会话记录。
   * @returns {string}
   */
  getPageURL () {
    return 'tw-ai-assistant://./ai-assistant.html';
  }

  getDimensions () {
    return {
      width: 1040,
      height: 640
    };
  }

  /**
   * 把 AI 工具调用转发给编辑器窗口并等待结果。
   * 独立成方法是为了让 SoloWindow 可以覆写：js 工程的工具在主进程本地处理，
   * 其余仍走编辑器（隐藏的后台 EditorWindow）。
   * @param {string} toolName
   * @param {object} params
   * @returns {Promise<object>}
   */
  async handleAIToolCall (toolName, params) {
    if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
      return { success: false, error: 'Editor window not available' };
    }
    // 隐藏编辑器刚创建时页面可能还没挂好 AI 监听（就绪信号未到）。先等它就绪
    // 再派发，否则调用石沉大海，AI 侧只会看到 30 秒超时（"AI 读不到新工程"）。
    // 信号迟迟不来（异常/旧版本页面）也按旧行为继续派发，宁多等不误事。
    // 打包/恢复整个工程要压缩全部素材，大工程可能远超普通工具调用的 30 秒
    const SLOW_TOOLS = {
      captureProjectSnapshot: 180000,
      restoreProjectSnapshot: 180000
    };
    if (this.editorWindow.aiListenersReady !== true) {
      const settleBudget = SLOW_TOOLS[toolName] ? 170000 : 25000;
      await Promise.race([
        this.editorWindow.aiListenersReadyPromise,
        new Promise(resolve => setTimeout(resolve, settleBudget))
      ]);
      // 等待期间可能被换工程（旧编辑器销毁）或窗口关闭
      if (!this.editorWindow || this.editorWindow.window.isDestroyed()) {
        return { success: false, error: 'Editor window not available' };
      }
    }
    return new Promise((resolve) => {
      // 随机后缀：模型一轮里并行发多个工具调用时（Promise.all 同时派发），
      // 纯时间戳的 requestId 在同一毫秒会撞车，结果互相串台
      const requestId = Date.now().toString() + Math.random().toString(16).slice(2);
      let timer = null;
      const handler = (event, data) => {
        if (data && data.requestId === requestId) {
          ipcMain.removeListener('ai-tool-response', handler);
          if (timer) clearTimeout(timer);
          resolve(data.result || { success: false, error: 'No response' });
        }
      };
      ipcMain.on('ai-tool-response', handler);
      this.editorWindow.window.webContents.send('ai-tool-call', { requestId, toolName, params });
      timer = setTimeout(() => {
        ipcMain.removeListener('ai-tool-response', handler);
        resolve({ success: false, error: 'Tool call timeout' });
      }, SLOW_TOOLS[toolName] || 30000);
    });
  }

  getPreload () {
    return 'ai-assistant';
  }

  handlePermissionCheck (permisson, details) {
    // 页面里的复制按钮走 navigator.clipboard，默认权限策略会全部拒绝
    return permisson === 'clipboard-sanitized-write' || super.handlePermissionCheck(permisson, details);
  }

  async handlePermissionRequest (permisson, details) {
    return permisson === 'clipboard-sanitized-write' || super.handlePermissionRequest(permisson, details);
  }

  isPopup () {
    return true;
  }

  getBackgroundColor () {
    // 跟随桌面设置的全局主题，窗口底色与页面一致，避免开窗瞬间闪错色
    if (settings.uiTheme === 'dark') return '#000000';
    if (settings.uiTheme === 'light') return '#f5f5f7';
    return nativeTheme.shouldUseDarkColors ? '#000000' : '#f5f5f7';
  }

  /**
   * 向所有 AI 助手与 SOLO 窗口广播主题变化，并同步窗口底色。
   * 注意 getWindowsByClass 按精确类注册，SOLO 是子类，需要单独遍历。
   * @param {'light'|'dark'} theme
   */
  static broadcastTheme (theme) {
    // Late require to avoid circular dependencies
    const SoloWindow = require('./solo');
    const backgroundColor = theme === 'dark' ? '#000000' : '#f5f5f7';
    for (const cls of [AIAssistantWindow, SoloWindow]) {
      for (const w of AbstractWindow.getWindowsByClass(cls)) {
        if (w.window.isDestroyed()) continue;
        w.window.webContents.send('ai-theme-changed', { theme });
        try {
          w.window.setBackgroundColor(backgroundColor);
        } catch (e) {
          // Window might be closing
        }
      }
    }
  }

  static show (editorWindow) {
    const existing = AbstractWindow.getWindowsByClass(AIAssistantWindow);
    if (existing.length) {
      existing[0].show();
      return existing[0];
    }
    return new AIAssistantWindow(editorWindow);
  }
}

module.exports = AIAssistantWindow;
// 导出给测试/调试脚本用
module.exports.webSearch = webSearch;
module.exports.parseBingResults = parseBingResults;
module.exports.parseDDGResults = parseDDGResults;
