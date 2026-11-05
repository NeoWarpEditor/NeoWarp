/* NeoWarp 扩展编辑器 —— AI 面板共享模块
 * 同一个面板工厂同时服务两个场景：
 *  - 停靠在扩展编辑器右侧的侧栏（extension-editor.html）
 *  - 弹出的独立 AI 窗口（ai-panel.html）
 * 调用方通过 options 注入差异点：取代码、插入代码、设置读写、状态变化上报。
 */
(function () {
  'use strict';

  var STRINGS = {
    zh: {
      aiTitle: 'AI 助手',
      saved: '已保存',
      aiSettings: 'AI 设置',
      clearChat: '清空对话',
      model: '模型',
      openSettings: '打开设置',
      manageHint: '模型与 API Key 在「设置 → AI 模型」中管理，与 AI 助手、NeoWarp SOLO 共用。',
      noConfigs: '还没有模型配置，点「打开设置」添加',
      freeModelsTitle: '免费模型',
      myModelsTitle: '我的模型',
      freeEnded: '免费使用活动已结束',
      inputPlaceholder: '询问关于代码的问题…',
      send: '发送',
      stop: '停止生成',
      noApiKey: '请先在设置中选择模型并填写 API Key',
      insertCode: '插入',
      replaceCode: '替换全文',
      confirmReplace: '确认替换？',
      copyCode: '复制',
      copied: '已复制到剪贴板',
      copiedShort: '已复制',
      inserted: '代码已插入编辑器',
      requestFailed: '请求失败：',
      welcomeTitle: '扩展开发助手',
      welcome: '我会自动读取编辑器里的当前代码来回答问题，也能帮你直接修改整个文件。试试下面的快捷操作：',
      quickExplain: '解释当前代码',
      quickOptimize: '优化这段代码',
      quickAddBlock: '添加一个积木',
      quickFix: '检查并修复问题',
      promptExplain: '请解释当前代码的功能和整体结构。',
      promptOptimize: '请审查当前代码，指出可以优化的地方，并给出修改后的代码。',
      promptAddBlock: '请基于当前扩展，帮我再添加一个实用的积木（Block），给出完整代码。',
      promptFix: '请检查当前代码是否存在问题（语法、逻辑、API 用法），并给出修复方案。',
      systemPrompt: '你是 NeoWarp 的扩展开发助手，帮助用户编写和调试 TurboWarp/Scratch 扩展的 JavaScript 代码。' +
        '回答使用简体中文，代码注释可使用中文。给出代码时使用 Markdown 代码块。\n' +
        '\n' +
        '## TurboWarp 扩展开发规范教程\n' +
        '\n' +
        '### 1. 扩展基本结构\n' +
        '扩展是一个对象，通过 getInfo() 描述自己，并交给 Scratch.extensions.register 注册：\n' +
        '```javascript\n' +
        '(function (Scratch) {\n' +
        "  'use strict';\n" +
        '  class MyExtension {\n' +
        '    constructor (runtime) {\n' +
        '      this.runtime = runtime;\n' +
        '    }\n' +
        '    getInfo () {\n' +
        '      return {\n' +
        "        id: 'myextension',  // 全局唯一 ID，只能用小写字母和数字\n" +
        "        name: '我的扩展',\n" +
        "        color1: '#4C97FF',  // 积木主色\n" +
        "        color2: '#3373CC',  // 积木深色（可选）\n" +
        '        blocks: [],         // 积木定义\n' +
        '        menus: {}           // 下拉菜单（可选）\n' +
        '      };\n' +
        '    }\n' +
        '  }\n' +
        '  Scratch.extensions.register(new MyExtension());\n' +
        '})(Scratch);\n' +
        '```\n' +
        '如需访问网络、DOM 等浏览器能力，必须声明未沙盒化（在 register 之前）：\n' +
        '`Scratch.extensions.unsandboxed = true;`\n' +
        '\n' +
        '### 2. 积木定义\n' +
        'blocks 数组的每一项可以用数组简写或对象形式，五类积木：\n' +
        '- 命令块：`[\'opcode\', \'command\', \'显示文本 [ARG]\']`\n' +
        '- 返回块（数值/字符串）：`[\'opcode\', \'reporter\', \'…\']`\n' +
        '- 布尔块：`[\'opcode\', \'boolean\', \'…\']`\n' +
        '- 帽子块：`[\'opcode\', \'hat\', \'当 …\']`\n' +
        '- 分隔标签：`[\'---\', \'label\', \'分组文字\']`\n' +
        '显示文本中 `[ARG]` 是参数占位符。对象形式用 arguments 描述参数：\n' +
        '```javascript\n' +
        '{\n' +
        "  opcode: 'myBlock',\n" +
        '  blockType: Scratch.BlockType.COMMAND,\n' +
        "  text: '设置 [NAME] 为 [VALUE]',\n" +
        '  arguments: {\n' +
        '    NAME: {type: Scratch.ArgumentType.STRING, defaultValue: "score"},\n' +
        '    VALUE: {type: Scratch.ArgumentType.NUMBER, defaultValue: 0}\n' +
        '  }\n' +
        '}\n' +
        '```\n' +
        '参数类型：NUMBER、STRING、BOOLEAN（六边形输入框）、ANGLE、COLOR、COSTUME、SOUND、BROADCAST、MATRIX、NOTE 等。\n' +
        '\n' +
        '### 3. 下拉菜单\n' +
        '```javascript\n' +
        'menus: {\n' +
        '  choices: {\n' +
        '    acceptReporters: true,          // 是否允许塞入返回块\n' +
        "    items: ['选项A', '选项B']        // 也可以是 () => [...] 动态返回\n" +
        '  }\n' +
        '}\n' +
        '```\n' +
        '菜单参数在 arguments 中写成 `{type: Scratch.ArgumentType.STRING, menu: "choices"}`。\n' +
        '\n' +
        '### 4. 积木实现\n' +
        '方法名与 opcode 一致，第一个参数是 args 对象（键为参数名），this 指向扩展实例：\n' +
        '```javascript\n' +
        'myBlock (args) {\n' +
        '  const name = String(args.NAME);\n' +
        '  const value = Number(args.VALUE);\n' +
        '  // 读写舞台数据：\n' +
        '  const stage = this.runtime.getTargetForStage();\n' +
        '  // 所有角色：this.runtime.targets\n' +
        '  // 触发帽子块：this.runtime.startHats(...)\n' +
        '  // 修改扩展数据后通知运行时：this.runtime.emitProjectChanged()\n' +
        '}\n' +
        '```\n' +
        '\n' +
        '### 5. 常用 API 与注意事项\n' +
        '- `Scratch.vm`：虚拟机实例（`Scratch.vm.runtime`、`Scratch.vm.renderer` 等）\n' +
        '- `Scratch.renderer`：渲染器，用于创建/操作皮肤与可绘制对象\n' +
        '- `Scratch.ArgumentType` / `Scratch.BlockType` / `Scratch.extensions.categoryColors`：枚举与配色\n' +
        '- 运行时常用：`runtime.stageWidth/stageHeight`、`runtime.ioDevices`、`runtime.targets`\n' +
        '- 代码必须兼容严格模式，不要使用 alert/confirm 等阻塞式弹窗\n' +
        '- 需要整体重写或大范围修改时，给出修改后的完整文件代码，用户可一键替换编辑器全部内容；小范围修改给出片段即可\n' +
        '写扩展代码时请严格遵循以上规范，确保给出的代码完整、可直接加载运行。'
    },
    en: {
      aiTitle: 'AI Assistant',
      saved: 'Saved',
      aiSettings: 'AI Settings',
      clearChat: 'Clear chat',
      model: 'Model',
      openSettings: 'Open settings',
      manageHint: 'Models and API keys live in Settings → AI Models, shared with the NeoWarp AI assistant and SOLO.',
      noConfigs: 'No model configs yet — open settings to add one',
      freeModelsTitle: 'Free models',
      myModelsTitle: 'My models',
      freeEnded: 'Free offer has ended',
      inputPlaceholder: 'Ask about your code…',
      send: 'Send',
      stop: 'Stop generating',
      noApiKey: 'Pick a model and set an API key in Settings first',
      insertCode: 'Insert',
      replaceCode: 'Replace file',
      confirmReplace: 'Confirm replace?',
      copyCode: 'Copy',
      copied: 'Copied to clipboard',
      copiedShort: 'Copied',
      inserted: 'Code inserted into editor',
      requestFailed: 'Request failed: ',
      welcomeTitle: 'Extension Developer Assistant',
      welcome: 'I automatically read the code in the editor before answering, and I can rewrite the whole file for you. Try a quick action:',
      quickExplain: 'Explain this code',
      quickOptimize: 'Optimize this code',
      quickAddBlock: 'Add a block',
      quickFix: 'Check & fix issues',
      promptExplain: 'Please explain what the current code does and how it is structured.',
      promptOptimize: 'Please review the current code, point out improvements, and provide the revised code.',
      promptAddBlock: 'Based on the current extension, please add one more useful block and give me the complete code.',
      promptFix: 'Please check the current code for problems (syntax, logic, API usage) and provide fixes.',
      systemPrompt: 'You are the NeoWarp extension development assistant. You help users write and debug JavaScript code ' +
        'for TurboWarp/Scratch extensions. Reply in English. Use Markdown code blocks for code.\n' +
        '\n' +
        '## TurboWarp Extension Development Tutorial\n' +
        '\n' +
        '### 1. Basic extension structure\n' +
        'An extension is an object that describes itself through getInfo() and registers itself with Scratch.extensions.register:\n' +
        '```javascript\n' +
        '(function (Scratch) {\n' +
        "  'use strict';\n" +
        '  class MyExtension {\n' +
        '    constructor (runtime) {\n' +
        '      this.runtime = runtime;\n' +
        '    }\n' +
        '    getInfo () {\n' +
        '      return {\n' +
        "        id: 'myextension',  // globally unique ID, lowercase letters and digits only\n" +
        "        name: 'My Extension',\n" +
        "        color1: '#4C97FF',  // primary block color\n" +
        "        color2: '#3373CC',  // darker shade (optional)\n" +
        '        blocks: [],         // block definitions\n' +
        '        menus: {}           // dropdown menus (optional)\n' +
        '      };\n' +
        '    }\n' +
        '  }\n' +
        '  Scratch.extensions.register(new MyExtension());\n' +
        '})(Scratch);\n' +
        '```\n' +
        'To access the network, DOM, and other browser capabilities, declare the extension as unsandboxed (before registering):\n' +
        '`Scratch.extensions.unsandboxed = true;`\n' +
        '\n' +
        '### 2. Block definitions\n' +
        'Each entry in the blocks array can use the array shorthand or the object form. Five block types:\n' +
        '- Command: `[\'opcode\', \'command\', \'text [ARG]\']`\n' +
        '- Reporter (number/string): `[\'opcode\', \'reporter\', \'…\']`\n' +
        '- Boolean: `[\'opcode\', \'boolean\', \'…\']`\n' +
        '- Hat: `[\'opcode\', \'hat\', \'when …\']`\n' +
        '- Label: `[\'---\', \'label\', \'section text\']`\n' +
        '`[ARG]` in the text is a placeholder for an argument. The object form describes arguments via "arguments":\n' +
        '```javascript\n' +
        '{\n' +
        "  opcode: 'myBlock',\n" +
        '  blockType: Scratch.BlockType.COMMAND,\n' +
        "  text: 'set [NAME] to [VALUE]',\n" +
        '  arguments: {\n' +
        '    NAME: {type: Scratch.ArgumentType.STRING, defaultValue: "score"},\n' +
        '    VALUE: {type: Scratch.ArgumentType.NUMBER, defaultValue: 0}\n' +
        '  }\n' +
        '}\n' +
        '```\n' +
        'Argument types: NUMBER, STRING, BOOLEAN (hexagonal input), ANGLE, COLOR, COSTUME, SOUND, BROADCAST, MATRIX, NOTE, etc.\n' +
        '\n' +
        '### 3. Dropdown menus\n' +
        '```javascript\n' +
        'menus: {\n' +
        '  choices: {\n' +
        '    acceptReporters: true,          // allow reporter blocks inside the input\n' +
        "    items: ['Option A', 'Option B'] // or () => [...] for dynamic items\n" +
        '  }\n' +
        '}\n' +
        '```\n' +
        'A menu argument is declared as `{type: Scratch.ArgumentType.STRING, menu: "choices"}`.\n' +
        '\n' +
        '### 4. Block implementation\n' +
        'The method name matches the opcode. The first parameter is the args object (keys are argument names); "this" is the extension instance:\n' +
        '```javascript\n' +
        'myBlock (args) {\n' +
        '  const name = String(args.NAME);\n' +
        '  const value = Number(args.VALUE);\n' +
        '  // Stage data: this.runtime.getTargetForStage()\n' +
        '  // All sprites: this.runtime.targets\n' +
        '  // Trigger hats: this.runtime.startHats(...)\n' +
        '  // Notify the runtime after mutating extension data: this.runtime.emitProjectChanged()\n' +
        '}\n' +
        '```\n' +
        '\n' +
        '### 5. Common APIs and notes\n' +
        '- `Scratch.vm`: the virtual machine (`Scratch.vm.runtime`, `Scratch.vm.renderer`, …)\n' +
        '- `Scratch.renderer`: create/manipulate skins and drawables\n' +
        '- `Scratch.ArgumentType` / `Scratch.BlockType` / `Scratch.extensions.categoryColors`: enums and palette\n' +
        '- Runtime essentials: `runtime.stageWidth/stageHeight`, `runtime.ioDevices`, `runtime.targets`\n' +
        '- Code must be strict-mode compatible; never use alert/confirm or other blocking dialogs\n' +
        '- For full rewrites or sweeping changes, output the complete revised file so the user can replace the editor content in one click; small changes can stay as snippets\n' +
        'Follow this specification strictly so the extension code you produce is complete and loadable as-is.'
    }
  };

  // 与 NeoWarp AI 助手（ai-assistant.html）一致的完整服务商/模型表
  // 模型信息更新于 2026-10，来源：各厂商官方模型/定价文档；已停售/退役的
  // 旧模型不再列出（DeepSeek v4-flash、Qwen3.7-max/Qwen3.6、MiMo V2.5 等）。
  var PROVIDERS = {
    openai: {
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      models: [
        {id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol'},
        {id: 'gpt-6-sol', name: 'GPT-6 Sol'},
        {id: 'gpt-6-luna', name: 'GPT-6 Luna'},
        {id: 'gpt-6-astra', name: 'GPT-6 Astra'},
        {id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol'},
        {id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra'},
        {id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna'},
        {id: 'gpt-5.5', name: 'GPT-5.5'},
        {id: 'gpt-5.4', name: 'GPT-5.4'},
        {id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini'},
        {id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano'},
        {id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex'}
      ],
      defaultModel: 'gpt-6.1-sol'
    },
    deepseek: {
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      models: [
        {id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro'},
        {id: 'deepseek-flash', name: 'DeepSeek Flash'}
      ],
      defaultModel: 'deepseek-v4-pro'
    },
    glm: {
      name: 'Zhipu GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      models: [
        {id: 'glm-5.3', name: 'GLM-5.3'},
        {id: 'glm-5.3-flash', name: 'GLM-5.3 Flash'},
        {id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX'},
        {id: 'glm-5.2', name: 'GLM-5.2'}
      ],
      defaultModel: 'glm-5.3'
    },
    kimi: {
      name: 'Kimi (Moonshot)',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      models: [
        {id: 'kimi-k3', name: 'Kimi K3'},
        {id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code'},
        {id: 'kimi-k2.6', name: 'Kimi K2.6'}
      ],
      defaultModel: 'kimi-k3'
    },
    mimo: {
      name: 'Xiaomi MiMo',
      endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
      models: [
        {id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro'},
        {id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed'},
        {id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash'}
      ],
      defaultModel: 'mimo-v2.6-pro'
    },
    huaweipangu: {
      name: 'Huawei Pangu',
      endpoint: 'https://api.huaweicloud.com/api/v2/chat/completions',
      models: [
        {id: 'pangu-2.0-pro', name: 'Pangu 2.0 Pro'},
        {id: 'pangu-2.0-flash', name: 'Pangu 2.0 Flash'}
      ],
      defaultModel: 'pangu-2.0-pro'
    },
    qwen: {
      name: 'Qwen',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      models: [
        {id: 'qwen3.8-max', name: 'Qwen3.8 Max'},
        {id: 'qwen3.8-flash', name: 'Qwen3.8 Flash'},
        {id: 'qwen3.7-plus', name: 'Qwen3.7 Plus'},
        {id: 'qwen3.7-flash', name: 'Qwen3.7 Flash'}
      ],
      defaultModel: 'qwen3.7-plus'
    },
    // NeoWarp 官方免费中转：配置由主进程动态注入（密钥不落盘），
    // 模型与截止时间须与 src-main/ai-model-configs.js 保持一致。
    free: {
      name: 'NeoWarp Free',
      endpoint: 'https://api.sy1.top/v1/chat/completions',
      isFree: true,
      models: [
        {id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash'},
        {id: 'glm-5.3-flash', name: 'GLM-5.3 Flash'},
        {id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite'},
        {id: 'glm-5.2', name: 'GLM-5.2'}
      ],
      defaultModel: 'deepseek-v4.1-flash'
    },
    custom: {
      name: 'Custom',
      nameEn: 'Custom',
      nameZh: '自定义',
      endpoint: '',
      isCustom: true,
      models: [],
      defaultModel: ''
    }
  };

  /**
   * 创建 AI 面板。
   * @param {object} options
   * @param {'zh'|'en'} options.lang
   * @param {() => (Promise<{name: string, content: string}|null>|{name: string, content: string}|null)} options.getCode
   * @param {(code: string) => void} options.insertCode
   * @param {(code: string) => void} [options.replaceCode] 用代码替换编辑器整个文件内容（带二次确认）
   * @param {{getSettings: () => Promise<object>, saveSettings: (s: object) => Promise<any>, onChanged: (cb: (s: object) => void) => void}} [options.legacySettingsApi] 已废弃
   * @param {{getConfigs: () => Promise<{configs: Array, activeId: string|null}>, saveActive: (activeId: string, configs: Array) => Promise<any>, onChanged: (cb: (payload: object) => void) => void, openSettings: () => void}} options.settingsApi
   *   统一模型配置存储的访问口（AI 助手 / SOLO / 桌面设置共用同一份）
   * @param {(state: {chatHistory: Array}) => void} [options.onStateChanged]
   */
  function createNeoWarpAiPanel (options) {
    var strings = STRINGS[options.lang] || STRINGS.en;
    var lang = options.lang === 'zh' ? 'zh' : 'en';

    var aiConfig = {provider: 'openai', apiKey: '', model: '', customEndpoint: '', customModelId: '', apiFormat: 'openai'};
    // 统一存储里的全部模型配置与激活项 id
    var modelConfigs = [];
    var activeConfigId = null;
    var chatHistory = [];
    var streaming = false;
    var abortController = null;

    function $ (id) {
      return document.getElementById(id);
    }

    function notifyStateChanged () {
      if (options.onStateChanged) {
        options.onStateChanged(getState());
      }
    }

    // ── Toast ─────────────────────────────────────────────────
    var toastTimer = null;
    function showToast (message) {
      var toast = $('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toast.classList.remove('visible');
      }, 2600);
    }

    // ── 文案与表单初始化 ──────────────────────────────────────
    function applyStrings () {
      $('ai-title').textContent = strings.aiTitle;
      $('ai-settings-btn').title = strings.aiSettings;
      $('ai-clear-btn').title = strings.clearChat;
      $('ai-model-select-label').textContent = strings.model;
      $('ai-open-settings').textContent = strings.openSettings;
      $('ai-settings-hint').textContent = strings.manageHint;
      $('ai-input').placeholder = strings.inputPlaceholder;
      $('ai-send').title = strings.send;
    }

    function init () {
      applyStrings();

      $('ai-settings-btn').addEventListener('click', toggleSettings);
      $('ai-model-chip').addEventListener('click', toggleSettings);
      $('ai-clear-btn').addEventListener('click', clearChat);
      $('ai-model-select').addEventListener('change', onModelSelectChanged);
      $('ai-open-settings').addEventListener('click', openAppSettings);
      $('ai-send').addEventListener('click', onSendClicked);
      $('ai-input').addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          onSendClicked();
        }
      });
      $('ai-input').addEventListener('input', autoResizeInput);

      showWelcome();

      if (options.settingsApi.getConfigs) {
        options.settingsApi.getConfigs().then(applyModelConfigs);
      }
      if (options.settingsApi.onChanged) {
        options.settingsApi.onChanged(applyModelConfigs);
      }
    }

    // 模型与 API Key 的管理入口已移至应用设置（桌面设置窗口 → AI 模型）
    function openAppSettings () {
      if (options.settingsApi.openSettings) {
        options.settingsApi.openSettings();
      }
    }

    function toggleSettings () {
      $('ai-settings').classList.toggle('open');
    }

    function clearChat () {
      chatHistory = [];
      $('ai-messages').innerHTML = '';
      showWelcome();
      notifyStateChanged();
    }

    // 采用统一存储发来的配置列表与激活项（初始化拉取与广播共用）
    function applyModelConfigs (payload) {
      modelConfigs = (payload && payload.configs) || [];
      activeConfigId = (payload && payload.activeId) || null;
      if (!modelConfigs.some(function (c) { return c.id === activeConfigId; })) {
        activeConfigId = modelConfigs.length ? modelConfigs[0].id : null;
      }
      applyActiveToAiConfig(activeConfig());
      fillModelSelect();
      updateModelChip();
    }

    function activeConfig () {
      return modelConfigs.find(function (c) { return c.id === activeConfigId; }) ||
        modelConfigs[0] || null;
    }

    function applyActiveToAiConfig (cfg) {
      cfg = cfg || null;
      aiConfig.provider = cfg ? (cfg.provider || 'openai') : 'openai';
      aiConfig.apiKey = cfg ? (cfg.apiKey || '') : '';
      aiConfig.model = cfg ? (cfg.model || '') : '';
      aiConfig.customEndpoint = cfg ? (cfg.customEndpoint || '') : '';
      aiConfig.customModelId = cfg ? (cfg.customModelId || '') : '';
      aiConfig.apiFormat = cfg ? (cfg.apiFormat || 'openai') : 'openai';
    }

    function modelConfigLabel (cfg) {
      var provider = PROVIDERS[cfg.provider] || {};
      var modelLabel = provider.isCustom
        ? (cfg.customModelId || cfg.model)
        : (((provider.models || []).find(function (m) { return m.id === cfg.model; }) || {}).name || cfg.model);
      // “自定义”服务商名称按界面语言显示（预设厂商品牌名两种语言一致）
      var providerLabel = (lang === 'zh' ? (provider.nameZh || provider.name) : (provider.nameEn || provider.name)) || 'Model';
      return cfg.name || modelLabel || providerLabel;
    }

    // ── 免费模型活动 ──
    // 截止时间与主进程 ai-model-configs.js 的 FREE_MODEL_END_AT 一致：
    // 2026-11-30 12:00:00（UTC+8）＝ 04:00 UTC。过期后免费模型禁选。
    var FREE_MODEL_END_AT = Date.UTC(2026, 10, 30, 4, 0, 0);
    function isFreeModelConfig (cfg) {
      return !!cfg && (cfg.isFree === true || String(cfg.id || '').indexOf('free_') === 0);
    }
    function isFreeModelExpired (cfg) {
      return isFreeModelConfig(cfg) && (cfg.freeExpired === true || Date.now() >= FREE_MODEL_END_AT);
    }

    function fillModelSelect () {
      var select = $('ai-model-select');
      if (!select) return;
      select.innerHTML = '';
      if (!modelConfigs.length) {
        var empty = document.createElement('option');
        empty.value = '';
        empty.textContent = strings.noConfigs;
        select.appendChild(empty);
        select.value = '';
        select.disabled = true;
        return;
      }
      select.disabled = false;
      // 免费模型 / 我的模型 分组展示；活动结束的免费模型禁用（无法选中）
      var freeConfigs = modelConfigs.filter(function (cfg) { return isFreeModelConfig(cfg); });
      var ownConfigs = modelConfigs.filter(function (cfg) { return !isFreeModelConfig(cfg); });
      function appendGroup (label, configs) {
        if (!configs.length) return;
        var group = document.createElement('optgroup');
        group.label = label;
        configs.forEach(function (cfg) {
          var option = document.createElement('option');
          option.value = cfg.id;
          var expired = isFreeModelExpired(cfg);
          option.textContent = modelConfigLabel(cfg) + (expired ? '（' + strings.freeEnded + '）' : '');
          option.disabled = expired;
          group.appendChild(option);
        });
        select.appendChild(group);
      }
      appendGroup(strings.freeModelsTitle, freeConfigs);
      appendGroup(strings.myModelsTitle, ownConfigs);
      select.value = activeConfigId || '';
    }

    // 切换模型：立即生效并写回统一存储（列表一并传回，避免漏传被当成清空）
    function onModelSelectChanged () {
      var id = $('ai-model-select').value;
      if (!id || id === activeConfigId) return;
      activeConfigId = id;
      applyActiveToAiConfig(activeConfig());
      updateModelChip();
      if (options.settingsApi.saveActive) {
        options.settingsApi.saveActive(id, modelConfigs).then(function () {
          showToast(strings.saved || 'Saved');
        });
      }
    }

    function getEffectiveModelId () {
      var provider = PROVIDERS[aiConfig.provider];
      if (!provider) return aiConfig.model || '';
      if (provider.isCustom) {
        return aiConfig.customModelId || aiConfig.model || '';
      }
      var listed = provider.models.some(function (m) { return m.id === aiConfig.model; });
      return listed ? aiConfig.model : provider.defaultModel;
    }

    function getModelDisplayName () {
      var provider = PROVIDERS[aiConfig.provider] || {name: aiConfig.provider};
      var modelId = getEffectiveModelId();
      var found = (provider.models || []).find(function (m) { return m.id === modelId; });
      return found ? found.name : (modelId || provider.name);
    }

    function updateModelChip () {
      var chip = $('ai-model-chip');
      chip.textContent = getModelDisplayName();
      chip.title = getEffectiveModelId();
    }

    // ── 对话 ──────────────────────────────────────────────────
    function onSendClicked () {
      if (streaming) {
        if (abortController) abortController.abort();
        return;
      }
      var input = $('ai-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      autoResizeInput();
      sendChat(text);
    }

    function autoResizeInput () {
      var input = $('ai-input');
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    function buildApiProxyUrl (endpoint, headers) {
      var url = 'tw-ai-proxy://request/?u=' + encodeURIComponent(endpoint);
      if (headers && Object.keys(headers).length) {
        url += '&h=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(headers)))));
      }
      return url;
    }

    var aiProxyBroken = false;
    function aiFetch (endpoint, options_) {
      if (aiProxyBroken) return fetch(endpoint, options_);
      return fetch(buildApiProxyUrl(endpoint, options_.headers), options_).catch(function (error) {
        if (error && error.name === 'AbortError') throw error;
        aiProxyBroken = true;
        return fetch(endpoint, options_);
      });
    }

    function getRequestTarget () {
      var provider = PROVIDERS[aiConfig.provider];
      return {
        endpoint: provider.isCustom ? (aiConfig.customEndpoint || provider.endpoint) : provider.endpoint,
        model: getEffectiveModelId(),
        apiKey: aiConfig.apiKey
      };
    }

    function sendChat (text) {
      var provider = PROVIDERS[aiConfig.provider];
      if (!aiConfig.apiKey) {
        showToast(strings.noApiKey);
        $('ai-settings').classList.add('open');
        return;
      }

      chatHistory.push({role: 'user', content: text});
      addUserBubble(text);

      var target = getRequestTarget();
      var apiMessages = [{role: 'system', content: strings.systemPrompt}];

      var beginRequest = function (codeContext) {
        if (codeContext) {
          apiMessages.push({
            role: 'user',
            content: (lang === 'zh' ? '这是当前文件 ' : 'This is the current file ') + codeContext.name +
              '：\n```javascript\n' + codeContext.content + '\n```'
          });
          apiMessages.push({
            role: 'assistant',
            content: lang === 'zh' ? '好的，我已经阅读了这份代码。' : 'Got it, I have read this code.'
          });
        }
        chatHistory.slice(-10).forEach(function (message) {
          apiMessages.push(message);
        });
        runStream(target, apiMessages);
      };

      Promise.resolve(options.getCode()).then(beginRequest, function () {
        beginRequest(null);
      });
    }

    function runStream (target, apiMessages) {
      var bubble = addAssistantBubble('');
      // 首个 token 到达前显示「思考中」指示点
      bubble.classList.add('thinking');
      bubble.innerHTML = '<span class="ai-thinking"><i></i><i></i><i></i></span>';
      scrollMessagesToBottom(true);

      streaming = true;
      updateSendButton();
      abortController = new AbortController();

      var fullText = '';
      var cursor = null;
      var onFirstDelta = function () {
        bubble.classList.remove('thinking');
        cursor = document.createElement('span');
        cursor.className = 'ai-cursor';
      };
      aiFetch(target.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + target.apiKey
        },
        body: JSON.stringify({
          model: target.model,
          messages: apiMessages,
          stream: true
        }),
        signal: abortController.signal
      }).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (body) {
            throw new Error('HTTP ' + response.status + (body ? ' - ' + body.slice(0, 300) : ''));
          });
        }
        // 与 ai-assistant.html 同一套防护：个别网关用 HTTP 200 应答出错内容
        // （One API / New API 类中转对不带 /v1 的路径会回控制台 HTML），按流
        // 解析永远出不了对话分片，直接呈现原因而不是干等。
        var respCT = String((response.headers && response.headers.get('content-type')) || '');
        if (/text\/html/i.test(respCT)) {
          throw new Error(lang === 'zh'
            ? '端点返回了网页而非对话接口（HTTP 200 + text/html）。One API / New API 类中转的接口地址应带 /v1，例如 https://主机/v1/chat/completions'
            : 'Endpoint returned a webpage instead of a chat API (HTTP 200 + text/html). One API / New API relay endpoints need /v1, e.g. https://host/v1/chat/completions');
        }
        if (/json/i.test(respCT)) {
          return response.json().then(function (j) {
            var msg = (j && j.error && (j.error.message || j.error.type)) ||
              (lang === 'zh' ? '端点返回了 JSON 而非 SSE 流（HTTP 200），请核对接口地址' : 'Endpoint returned JSON instead of an SSE stream (HTTP 200); check the endpoint');
            throw new Error(msg);
          });
        }
        return readSseStream(response.body.getReader(), function (delta) {
          fullText += delta;
          if (!cursor) onFirstDelta();
          renderAssistantContent(bubble, fullText, cursor);
          scrollMessagesToBottom();
        });
      }).then(function () {
        bubble.classList.remove('thinking');
        if (fullText) {
          chatHistory.push({role: 'assistant', content: fullText});
          renderAssistantContent(bubble, fullText, null);
        }
      }).catch(function (error) {
        bubble.classList.remove('thinking');
        if (error && error.name === 'AbortError') {
          renderAssistantContent(bubble, fullText, null);
          if (fullText) chatHistory.push({role: 'assistant', content: fullText});
          return;
        }
        bubble.classList.add('error');
        bubble.textContent = strings.requestFailed + String((error && error.message) || error);
      }).then(function () {
        streaming = false;
        abortController = null;
        updateSendButton();
        scrollMessagesToBottom();
        notifyStateChanged();
      });
    }

    function readSseStream (reader, onDelta) {
      var decoder = new TextDecoder();
      var buffer = '';

      function pump () {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, {stream: true});
          var lines = buffer.split('\n');
          buffer = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try {
              var json = JSON.parse(data);
              var delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && delta.content) onDelta(delta.content);
            } catch (e) {
              // 半截 JSON 等下一批拼上再说不了（SSE 按行分割，容错跳过即可）
            }
          }
          return pump();
        });
      }

      return pump();
    }

    function updateSendButton () {
      var button = $('ai-send');
      button.title = streaming ? strings.stop : strings.send;
      button.classList.toggle('streaming', streaming);
      $('ai-send-icon').classList.toggle('hidden', streaming);
      $('ai-stop-icon').classList.toggle('hidden', !streaming);
    }

    // ── 消息渲染 ──────────────────────────────────────────────
    var QUICK_ACTIONS = [
      {key: 'explain', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z'},
      {key: 'optimize', icon: 'M7 2v11h3v9l7-12h-4l4-8H7z'},
      {key: 'addBlock', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 11h4v-2h-4V7h-2v4H7v2h4v4h2v-4z'},
      {key: 'fix', icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z'}
    ];

    function showWelcome () {
      var wrap = document.createElement('div');
      wrap.className = 'ai-welcome';

      var avatar = document.createElement('div');
      avatar.className = 'ai-welcome-avatar';
      avatar.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2a1 1 0 0 1 .95.68l1.7 4.67 4.67 1.7a1 1 0 0 1 0 1.9l-4.67 1.7-1.7 4.67a1 1 0 0 1-1.9 0l-1.7-4.67-4.67-1.7a1 1 0 0 1 0-1.9l4.67-1.7 1.7-4.67A1 1 0 0 1 12 2zm7 12a.9.9 0 0 1 .86.61l.85 2.34 2.34.85a.9.9 0 0 1 0 1.71l-2.34.85-.85 2.34a.9.9 0 0 1-1.71 0l-.85-2.34-2.34-.85a.9.9 0 0 1 0-1.71l2.34-.85.85-2.34A.9.9 0 0 1 19 14z"/></svg>';
      wrap.appendChild(avatar);

      var title = document.createElement('div');
      title.className = 'ai-welcome-title';
      title.textContent = strings.welcomeTitle;
      wrap.appendChild(title);

      var desc = document.createElement('div');
      desc.className = 'ai-welcome-desc';
      desc.textContent = strings.welcome;
      wrap.appendChild(desc);

      var actions = document.createElement('div');
      actions.className = 'ai-welcome-actions';
      var prompts = {
        explain: strings.promptExplain,
        optimize: strings.promptOptimize,
        addBlock: strings.promptAddBlock,
        fix: strings.promptFix
      };
      var labels = {
        explain: strings.quickExplain,
        optimize: strings.quickOptimize,
        addBlock: strings.quickAddBlock,
        fix: strings.quickFix
      };
      QUICK_ACTIONS.forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-quick-btn';
        button.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + action.icon + '"/></svg>';
        var label = document.createElement('span');
        label.textContent = labels[action.key];
        button.appendChild(label);
        button.addEventListener('click', function () {
          if (streaming) return;
          sendChat(prompts[action.key]);
        });
        actions.appendChild(button);
      });
      wrap.appendChild(actions);
      $('ai-messages').appendChild(wrap);
      scrollMessagesToBottom(true);
    }

    function addUserBubble (text) {
      var bubble = document.createElement('div');
      bubble.className = 'ai-msg user';
      bubble.textContent = text;
      $('ai-messages').appendChild(bubble);
      scrollMessagesToBottom(true);
    }

    function addAssistantBubble (text) {
      var bubble = document.createElement('div');
      bubble.className = 'ai-msg assistant';
      $('ai-messages').appendChild(bubble);
      if (text) renderAssistantContent(bubble, text, null);
      scrollMessagesToBottom(true);
      return bubble;
    }

    function scrollMessagesToBottom (smooth) {
      var box = $('ai-messages');
      // 流式输出期间用即时滚动避免抖动；新消息用平滑滚动
      if (smooth) {
        box.scrollTo({top: box.scrollHeight, behavior: 'smooth'});
      } else {
        box.scrollTop = box.scrollHeight;
      }
    }

    function escapeHtml (text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function renderAssistantContent (bubble, text, cursor) {
      bubble.innerHTML = '';
      var blockRegex = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
      var lastIndex = 0;
      var match;
      while ((match = blockRegex.exec(text)) !== null) {
        appendTextSegment(bubble, text.slice(lastIndex, match.index));
        appendCodeBlock(bubble, match[1], match[2]);
        lastIndex = blockRegex.lastIndex;
      }
      appendTextSegment(bubble, text.slice(lastIndex));
      if (cursor) bubble.appendChild(cursor);
    }

    function renderInlineMarkdown (text) {
      var html = escapeHtml(text);
      html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      return html;
    }

    // ── Markdown 表格 ─────────────────────────────────────────
    // 分隔行：| --- | :---: | ---: | 这类
    function isTableSeparatorLine (line) {
      var t = line.trim();
      if (t.indexOf('|') === -1) return false;
      var parts = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
      return parts.length > 0 && parts.every(function (part) {
        return /^\s*:?-+:?\s*$/.test(part);
      });
    }

    // 数据行/表头行：非空、含 '|'、且不是分隔行
    function isTableRowLine (line) {
      var t = line.trim();
      return t.length > 0 && t.indexOf('|') !== -1 && !isTableSeparatorLine(t);
    }

    function parseTableRowCells (line) {
      var t = line.trim();
      if (t.charAt(0) === '|') t = t.slice(1);
      if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
      return t.split(/(?<!\\)\|/).map(function (cell) {
        return cell.trim().replace(/\\\|/g, '|');
      });
    }

    function appendTableNode (container, tableLines) {
      var wrapper = document.createElement('div');
      wrapper.className = 'md-table-wrap';
      var table = document.createElement('table');
      table.className = 'md-table';

      var aligns = parseTableRowCells(tableLines[1]).map(function (cell) {
        if (/^:-+:$/.test(cell)) return 'center';
        if (/^-+:$/.test(cell)) return 'right';
        return 'left';
      });

      var thead = document.createElement('thead');
      var headRow = document.createElement('tr');
      parseTableRowCells(tableLines[0]).forEach(function (cell, index) {
        var th = document.createElement('th');
        th.innerHTML = renderInlineMarkdown(cell);
        th.style.textAlign = aligns[index] || 'left';
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      tableLines.slice(2).forEach(function (line) {
        if (!line.trim()) return;
        var tr = document.createElement('tr');
        parseTableRowCells(line).forEach(function (cell, index) {
          var td = document.createElement('td');
          td.innerHTML = renderInlineMarkdown(cell);
          td.style.textAlign = aligns[index] || 'left';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      wrapper.appendChild(table);
      container.appendChild(wrapper);
    }

    function appendTextSegment (bubble, segment) {
      if (!segment) return;
      var lines = segment.split('\n');
      var container = document.createElement('span');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // 表格块：表头行 + 分隔行 + 连续的数据行，整体渲染为 <table>
        if (i + 1 < lines.length &&
            isTableRowLine(line) &&
            isTableSeparatorLine(lines[i + 1])) {
          var tableLines = [line, lines[i + 1]];
          var j = i + 2;
          while (j < lines.length &&
              lines[j].trim() !== '' &&
              isTableRowLine(lines[j])) {
            tableLines.push(lines[j]);
            j++;
          }
          if (container.childNodes.length) {
            container.appendChild(document.createElement('br'));
          }
          appendTableNode(container, tableLines);
          i = j - 1;
          continue;
        }
        if (container.childNodes.length) {
          container.appendChild(document.createElement('br'));
        }
        var trimmed = line.trim();
        var node;
        var headingMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed);
        var ulMatch = /^[-*]\s+(.*)$/.exec(trimmed);
        var olMatch = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
        if (headingMatch) {
          node = document.createElement('div');
          node.className = 'md-h md-h' + headingMatch[1].length;
          node.innerHTML = renderInlineMarkdown(headingMatch[2]);
        } else if (ulMatch) {
          node = document.createElement('span');
          node.className = 'md-li';
          node.innerHTML = renderInlineMarkdown(ulMatch[1]);
        } else if (olMatch) {
          node = document.createElement('span');
          node.className = 'md-li md-ol';
          node.setAttribute('data-index', olMatch[1]);
          node.innerHTML = renderInlineMarkdown(olMatch[2]);
        } else {
          node = document.createElement('span');
          node.innerHTML = renderInlineMarkdown(line);
        }
        container.appendChild(node);
      }
      bubble.appendChild(container);
    }

    function appendCodeBlock (bubble, language, code) {
      var wrapper = document.createElement('div');
      wrapper.className = 'code-block';

      var header = document.createElement('div');
      header.className = 'code-block-header';
      var langLabel = document.createElement('span');
      langLabel.className = 'lang-label';
      langLabel.textContent = language || 'code';
      var spacer = document.createElement('span');
      spacer.className = 'spacer';

      var codeText = code.replace(/\n$/, '');

      var copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'code-action-btn';
      copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>' + strings.copyCode;
      copyButton.addEventListener('click', function () {
        copyToClipboard(codeText);
        // 按钮短暂变为「已复制」反馈
        copyButton.classList.add('success');
        copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>' + strings.copiedShort;
        setTimeout(function () {
          copyButton.classList.remove('success');
          copyButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>' + strings.copyCode;
        }, 1500);
      });

      var insertButton = document.createElement('button');
      insertButton.type = 'button';
      insertButton.className = 'code-action-btn';
      insertButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>' + strings.insertCode;
      insertButton.addEventListener('click', function () {
        options.insertCode(codeText);
      });

      header.appendChild(langLabel);
      header.appendChild(spacer);
      header.appendChild(copyButton);
      header.appendChild(insertButton);

      // 一键替换整个编辑器文件（二次确认，防止误点覆盖）
      if (options.replaceCode) {
        var replaceButton = document.createElement('button');
        replaceButton.type = 'button';
        replaceButton.className = 'code-action-btn replace';
        var replaceIcon = '<svg viewBox="0 0 24 24"><path d="M17 1h6v6h-2V4.4L14.4 11 13 9.6 19.6 3H17V1zM7 23H1v-6h2v2.6L9.6 13 11 14.4 4.4 21H7v2z"/></svg>';
        var replaceHtml = replaceIcon + strings.replaceCode;
        replaceButton.innerHTML = replaceHtml;
        var confirmTimer = null;
        var resetReplaceButton = function () {
          clearTimeout(confirmTimer);
          replaceButton.classList.remove('confirming');
          replaceButton.innerHTML = replaceHtml;
        };
        replaceButton.addEventListener('click', function () {
          if (replaceButton.classList.contains('confirming')) {
            resetReplaceButton();
            options.replaceCode(codeText);
          } else {
            replaceButton.classList.add('confirming');
            replaceButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z"/></svg>' + strings.confirmReplace;
            confirmTimer = setTimeout(resetReplaceButton, 3000);
          }
        });
        header.appendChild(replaceButton);
      }

      var pre = document.createElement('pre');
      var codeEl = document.createElement('code');
      codeEl.textContent = codeText;
      pre.appendChild(codeEl);

      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      bubble.appendChild(wrapper);
    }

    function copyToClipboard (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast(strings.copied);
        }, function () {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    }

    function fallbackCopy (text) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(textarea);
      showToast(strings.copied);
    }

    // ── 状态交接（弹出 / 恢复时搬运聊天记录） ─────────────────
    function getState () {
      return {
        chatHistory: chatHistory
      };
    }

    function setState (state) {
      chatHistory = (state && Array.isArray(state.chatHistory)) ? state.chatHistory : [];
      $('ai-messages').innerHTML = '';
      if (!chatHistory.length) {
        showWelcome();
        return;
      }
      chatHistory.forEach(function (message) {
        if (message.role === 'user') {
          addUserBubble(message.content);
        } else {
          addAssistantBubble(message.content);
        }
      });
    }

    init();

    return {
      getState: getState,
      setState: setState,
      isStreaming: function () { return streaming; }
    };
  }

  window.createNeoWarpAiPanel = createNeoWarpAiPanel;
  window.NEO_WARP_AI_PROVIDERS = PROVIDERS;
})();
