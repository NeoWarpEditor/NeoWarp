/* ==========================================================================
 * NeoWarp 网页版 — 编辑器 EditorPreload 浏览器实现
 * 除了满足 scratch-gui 的契约，还把工程读写能力注册为宿主的 editor 服务，
 * 供 AI 助手、任务管理器、项目分析等子窗口远程调用。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NW = global.NW || (global.NW = {});
  var util = NW.util;
  var storage = NW.storage;

  /* ------------------------ 环境兜底：mediaDevices ------------------------ */
  if (!global.navigator.mediaDevices) {
    try {
      Object.defineProperty(global.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(new Error('当前环境不支持媒体设备（需要 HTTPS 安全上下文）')),
          enumerateDevices: () => Promise.resolve([]),
          getSupportedConstraints: () => ({}),
          addEventListener: () => {},
          removeEventListener: () => {}
        }
      });
    } catch (e) { /* 无法定义时保持原状 */ }
  }

  /* ---------------------------- 文件处理 ---------------------------- */
  var fileSeq = 0;
  var fileMap = new Map();       // id -> File
  var handleMap = new Map();     // id -> FileSystemFileHandle
  var writableMap = new Map();   // id -> 可写流
  var pendingFileMap = new Map();

  var FILE_OPEN_ACCEPTS = [
    { description: '项目文件', accept: { 'application/json': ['.sb3', '.np1', '.npnp', '.viewsb3', '.sb2', '.sb'] } },
    { description: '所有文件', accept: { '*/*': ['*'] } }
  ];

  global.addEventListener('message', function (event) {
    if (event.source !== global) return;
    var data = event.data;
    if (!data || typeof data.ipcStartWriteStream !== 'string') return;

    var id = data.ipcStartWriteStream;
    var port = event.ports[0];
    var stream = writableMap.get(id);
    if (!stream) {
      port.postMessage({ error: 'No writable stream' });
      port.close();
      return;
    }

    port.onmessage = async function (message) {
      var payload = message.data;
      try {
        if (payload.write) {
          await stream.write(payload.write);
          port.postMessage({ response: { id: payload.id, result: true } });
        } else if (payload.finish) {
          await stream.close();
          writableMap.delete(id);
          port.postMessage({ response: { id: payload.id, result: true } });
          port.close();
        } else if (payload.abort) {
          await stream.abort();
          writableMap.delete(id);
          port.postMessage({ response: { id: payload.id, result: true } });
          port.close();
        }
      } catch (error) {
        port.postMessage({ response: { id: payload.id, result: { error: String(error) } } });
      }
    };
  });

  function downloadBlob (blob, fileName) {
    var url = URL.createObjectURL(blob);
    var anchor = global.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    global.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  var showOpenFilePicker = async function () {
    if (global.showOpenFilePicker) {
      try {
        var handles = await global.showOpenFilePicker({ types: FILE_OPEN_ACCEPTS, multiple: false });
        if (handles && handles.length) {
          var file = await handles[0].getFile();
          var id = 'file-' + (++fileSeq);
          fileMap.set(id, file);
          handleMap.set(id, handles[0]);
          return { id: id, name: file.name };
        }
        return null;
      } catch (error) {
        if (error && error.name === 'AbortError') return null;
        // 权限受限时退回传统 file input
      }
    }
    return legacyOpenFile();
  };

  function legacyOpenFile () {
    return new Promise(function (resolve) {
      var input = global.document.createElement('input');
      input.type = 'file';
      input.accept = '.sb3,.np1,.npnp,.viewsb3,.sb2,.sb';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) {
          resolve(null);
          return;
        }
        var id = 'file-' + (++fileSeq);
        fileMap.set(id, file);
        resolve({ id: id, name: file.name });
      });
      input.click();
    });
  }

  var showSaveFilePicker = async function (suggestedName) {
    var name = suggestedName || 'project.sb3';
    if (global.showSaveFilePicker) {
      try {
        var handle = await global.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '项目文件', accept: { 'application/json': ['.sb3'] } }]
        });
        var id = 'save-' + (++fileSeq);
        handleMap.set(id, handle);
        return { id: id, name: handle.name || name };
      } catch (error) {
        if (error && error.name === 'AbortError') return null;
      }
    }
    // 兜底：下载模式
    var downloadId = 'save-' + (++fileSeq);
    handleMap.set(downloadId, { __downloadMode: true, name: name });
    return { id: downloadId, name: name };
  };

  async function getFile (id) {
    if (pendingFileMap.has(id)) {
      var pending = pendingFileMap.get(id);
      pendingFileMap.delete(id);
      return {
        data: new Uint8Array(pending.buffer),
        name: pending.name,
        type: 'file',
        isEncrypted: false,
        isViewOnly: false
      };
    }
    var file = fileMap.get(id);
    if (!file) throw new Error('文件未找到');
    var buffer = await file.arrayBuffer();
    return { data: new Uint8Array(buffer), name: file.name, type: 'file', isEncrypted: false, isViewOnly: false };
  }

  function startWriteStream (id) {
    var handle = handleMap.get(id);
    if (!handle) return;

    if (handle.__downloadMode) {
      var chunks = [];
      writableMap.set(id, {
        write: function (data) { chunks.push(new Uint8Array(data)); },
        close: function () {
          downloadBlob(new Blob(chunks, { type: 'application/octet-stream' }), handle.name);
        },
        abort: function () { chunks = []; }
      });
      return;
    }

    handle.createWritable().then(function (stream) {
      writableMap.set(id, stream);
    }).catch(function (error) {
      console.error('[NeoWarp] 创建可写流失败', error);
      util.toast('无法写入原文件，请改用「保存到新文件」');
    });
  }

  /* ---------------------------- 回调集中管理 ---------------------------- */
  var callbacks = {
    stageDetached: null,
    stageReattached: null,
    detachedStageInput: null,
    requestProjectJSON: [],
    applyProject: [],
    applySprite: [],
    requestSpriteLibrary: [],
    aiToolCall: [],
    spriteStats: [],
    importCostume: [],
    requestTheme: [],
    addExtension: [],
    myExtensionsUpsert: [],
    soloExportProject: [],
    soloStageStream: null,
    soloStageAnswer: null,
    soloStageControl: null,
    collaborationStateChange: [],
    collaborationChatMessage: [],
    collaborationEnded: [],
    collabRequestProjectJSON: [],
    collabProjectUpdate: []
  };

  var rpcPending = new Map();

  function awaitCallback (listName, buildPayload, timeout) {
    return new Promise(function (resolve, reject) {
      var list = callbacks[listName];
      if (!list || !list.length) {
        reject(new Error('编辑器尚未就绪'));
        return;
      }
      var requestId = 'nw-editor-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      var timer = global.setTimeout(function () {
        rpcPending.delete(requestId);
        reject(new Error('编辑器响应超时'));
      }, timeout || 60000);
      rpcPending.set(requestId, { resolve: resolve, timer: timer });
      list.forEach(function (callback) {
        try {
          callback(buildPayload(requestId));
        } catch (error) {
          global.clearTimeout(timer);
          rpcPending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  function resolveRequest (requestId, payload) {
    var entry = rpcPending.get(requestId);
    if (!entry) return;
    rpcPending.delete(requestId);
    global.clearTimeout(entry.timer);
    entry.resolve(payload);
  }

  /* ------------------------- 近似系统占用 ------------------------- */
  var cpuEstimate = 0;
  (function sampleCpu () {
    var INTERVAL = 250;
    var startedAt = performance.now();
    global.setTimeout(function () {
      if (!global.document.hidden) {
        var actual = performance.now() - startedAt;
        var busy = (actual - INTERVAL) / INTERVAL;
        if (!isFinite(busy) || busy < 0) busy = 0;
        if (busy > 1) busy = 1;
        cpuEstimate = cpuEstimate * 0.6 + busy * 100 * 0.4;
      }
      sampleCpu();
    }, INTERVAL);
  })();

  /* --------------------------- 页内窗口入口 --------------------------- */
  function openAppWindow (key, url, options) {
    var title = (options && options.title) || '';
    var width = (options && options.width) || 980;
    var height = (options && options.height) || 700;

    if (!global.NWWindow) {
      global.open(url, '_blank');
      return null;
    }
    return global.NWWindow.open(Object.assign({
      key: key,
      url: url,
      title: title,
      width: width,
      height: height
    }, options || {}));
  }

  /* ------------------------------ 契约实现 ------------------------------ */
  var nativeAlert = typeof global.alert === 'function' ? global.alert.bind(global) : function () {};
  var nativeConfirm = typeof global.confirm === 'function' ? global.confirm.bind(global) : function () { return false; };

  /* ------------- 工具：ArrayBuffer ↔ 字符串（协作项目传输用） ------------- */
  function strToBuf (text) {
    return new TextEncoder().encode(text).buffer;
  }
  function bufToStr (buffer) {
    return new TextDecoder().decode(buffer);
  }
  function bytesToBase64 (bytes) {
    var CHUNK = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(binary);
  }

  /* ------------------ 手机观看舞台（WebRTC 实时帧流） ------------------ */
  var stageShare = {
    host: null,
    room: null,
    urls: [],
    clients: 0,
    start: function () {
      var self = this;
      if (this.host) return Promise.resolve(this.urls);
      if (!NW.remote || !NW.remote.isAvailable()) {
        return Promise.reject(new Error('当前浏览器不支持 WebRTC 远控'));
      }
      this.room = NW.remote.generateRoom();
      this.host = NW.remote.host(this.room, {
        onOpen: function () {
          self.clients += 1;
          // 唤醒 GUI 的舞台帧推送（8fps dataURL）
          if (callbacks.soloStageStream) callbacks.soloStageStream({active: true});
        },
        onClose: function () {
          self.clients = Math.max(0, self.clients - 1);
          if (self.clients === 0 && callbacks.soloStageStream) {
            callbacks.soloStageStream({active: false});
          }
        },
        onData: function (link, obj) { self.handleCommand(link, obj); }
      });
      this.urls = [NW.remote.remoteUrl('remote/index.html', this.room)];
      return Promise.resolve(this.urls);
    },
    handleCommand: function (link, obj) {
      if (!obj) return;
      if (obj.t === 'stage-cmd') {
        awaitCallback('soloStageControl', function (requestId) {
          return {requestId: requestId, action: obj.action};
        }, 10000).then(function (result) {
          link.send({t: 'stage-cmd-res', id: obj.id, result: result || {success: false}});
        }).catch(function (error) {
          link.send({
            t: 'stage-cmd-res',
            id: obj.id,
            result: {success: false, error: (error && error.message) || String(error)}
          });
        });
      } else if (obj.t === 'answer') {
        awaitCallback('soloStageAnswer', function (requestId) {
          return {requestId: requestId, text: obj.text};
        }, 10000).catch(function () {});
      }
    },
    pushFrame: function (dataURL) {
      if (this.clients && this.host) this.host.broadcast({t: 'frame', data: dataURL});
    },
    pushOverlays: function (data) {
      if (this.clients && this.host) this.host.broadcast({t: 'overlays', data: data});
    }
  };

  /* --------------------- 多人协作（WebRTC 星型拓扑） --------------------- */
  var collab = {
    mode: null, // 'host' | 'participant'
    room: null,
    host: null,
    session: null,
    nickname: '',
    avatar: '🙂',
    roster: [],
    assembler: null,
    state: {isCollaborating: false, role: null, onlineCount: 0, permissions: null},
    defaultPermissions: {allowEdit: true, allowDeleteSprite: true, allowAddExtension: true}
  };

  function pushCollabState () {
    callbacks.collaborationStateChange.slice().forEach(function (cb) {
      try { cb(Object.assign({}, collab.state)); } catch (e) { void e; }
    });
  }

  function resetCollab () {
    collab.mode = null;
    collab.host = null;
    collab.session = null;
    collab.roster = [];
    collab.assembler = null;
    collab.state = {isCollaborating: false, role: null, onlineCount: 0, permissions: null};
    pushCollabState();
  }

  /** 从 VM 收集全部素材（md5ext → base64），随项目一并传给协作对端，
   *  解决「素材不互通」：项目 JSON 里的 md5 引用对端无法从官方 CDN 拉到 */
  function collectVmAssets () {
    var out = [];
    var vm = global.vm;
    if (!vm || !vm.runtime || !vm.runtime.targets) return out;
    vm.runtime.targets.forEach(function (target) {
      var items = [];
      try {
        items = target.getCostumes().concat(target.getSounds());
      } catch (e) {
        return;
      }
      items.forEach(function (item) {
        var asset = item && item.asset;
        if (!asset || !asset.data) return;
        // 网页版 VM 的素材对象只有 assetId（无 md5 / md5ext 字段），
        // 项目 JSON 里的 md5ext 用的就是 assetId 的值，这里按同样规则拼。
        var id = asset.assetId || asset.md5 || asset.md5ext;
        if (!id) return;
        var md5ext = String(id).indexOf('.') >= 0
          ? String(id)
          : String(id) + '.' + (asset.dataFormat || 'png');
        try {
          out.push({md5ext: md5ext, data: bytesToBase64(asset.data)});
        } catch (e) { void e; }
      });
    });
    return out;
  }

  /** 判断 GUI 传来的是否已是内含素材的 sb3 载荷（{format:'sb3',data:<base64>}） */
  function isSb3Payload (value) {
    if (value && typeof value === 'object') {
      return value.format === 'sb3' && !!value.data;
    }
    if (typeof value !== 'string') return false;
    // 便宜的前缀判断，避免为大字符串做一次完整 JSON.parse
    return /^\s*\{\s*"format"\s*:\s*"sb3"/.test(value);
  }

  /** 发送项目 + 素材（blob 分块）；target 传名字则定向，否则广播 */
  function sendProjectPayload (links, json) {
    var alreadyHasAssets = isSb3Payload(json);
    var projectStr = typeof json === 'string' ? json : JSON.stringify(json);
    var payload = JSON.stringify({
      project: projectStr,
      // sb3 载荷已内含全部素材，无需再单独传一遍
      assets: alreadyHasAssets ? [] : collectVmAssets()
    });
    links.forEach(function (link) {
      link.sendBlob('collab-project', strToBuf(payload));
    });
  }

  function applyIncomingProject (buffer) {
    try {
      var payload = JSON.parse(bufToStr(buffer));
      if (payload && payload.project) {
        if (payload.assets && payload.assets.length && global.NW.collabAssets) {
          global.NW.collabAssets.registerAssets(payload.assets);
        }
        callbacks.collabProjectUpdate.slice().forEach(function (cb) {
          try { cb({project: payload.project}); } catch (e) { void e; }
        });
      }
    } catch (e) {
      util.toast('协作：项目数据解析失败');
    }
  }

  /** 请求 GUI 导出当前项目（含全部素材）并推送给指定成员。
   *  直接调用 GUI 注册的回调，避免 awaitCallback 无人 resolve 造成 60s 后误报。 */
  function requestProjectFromGui (targetName) {
    var list = callbacks.collabRequestProjectJSON;
    if (!list || !list.length) return;
    var requestId = 'nw-editor-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    list.forEach(function (cb) {
      try {
        cb({requestId: requestId, targetUsername: targetName});
      } catch (e) { void e; }
    });
  }

  function hostOnData (link, obj) {
    if (!obj) return;
    switch (obj.t) {
      case 'hello': {
        link.meta.name = String(obj.name || '协作者').slice(0, 24);
        collab.roster.push({name: link.meta.name, avatar: obj.avatar || '🙂', role: 'participant'});
        link.send({t: 'welcome', roster: collab.roster, permissions: collab.state.permissions});
        collab.host.broadcast({t: 'roster', roster: collab.roster});
        collab.state.onlineCount = collab.roster.length;
        pushCollabState();
        util.toast('「' + link.meta.name + '」加入了协作');
        // 新成员加入：立刻把当前项目（含角色/背景/造型/音乐等素材）推给它
        requestProjectFromGui(link.meta.name);
        break;
      }
      case 'project-request': {
        requestProjectFromGui(link.meta.name);
        break;
      }
      case 'bye': {
        hostRemoveMember(link);
        break;
      }
    }
  }

  function hostRemoveMember (link) {
    if (collab.mode !== 'host' || !link || !link.meta.name) return;
    collab.roster = collab.roster.filter(function (m) {
      return m.role === 'host' || m.name !== link.meta.name;
    });
    collab.state.onlineCount = collab.roster.length;
    pushCollabState();
    if (collab.host) collab.host.broadcast({t: 'roster', roster: collab.roster});
  }

  function participantOnData (link, obj) {
    if (!obj) return;
    if (collab.assembler && collab.assembler.feed(obj)) return;
    switch (obj.t) {
      case 'welcome': {
        collab.roster = obj.roster || [];
        collab.state = {
          isCollaborating: true,
          role: 'participant',
          onlineCount: collab.roster.length,
          permissions: obj.permissions || collab.defaultPermissions
        };
        pushCollabState();
        break;
      }
      case 'roster': {
        collab.roster = obj.roster || [];
        collab.state.onlineCount = collab.roster.length;
        pushCollabState();
        break;
      }
      case 'collab-ended': {
        util.toast('房主已结束协作');
        callbacks.collaborationEnded.slice().forEach(function (cb) {
          try { cb({}); } catch (e) { void e; }
        });
        resetCollab();
        break;
      }
    }
  }

  /* 协作房间简易弹窗（Apple 风格） */
  function showCollabDialog (options) {
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:99990;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);';
      var panel = document.createElement('div');
      panel.style.cssText = 'width:min(380px,92vw);background:rgba(252,252,253,0.98);border-radius:18px;padding:24px 22px;box-shadow:0 18px 60px rgba(0,0,0,0.25);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f;';
      var title = document.createElement('div');
      title.textContent = options.title || '';
      title.style.cssText = 'font-size:17px;font-weight:700;letter-spacing:-0.3px;margin-bottom:14px;text-align:center;';
      panel.appendChild(title);

      var values = {};
      (options.fields || []).forEach(function (field) {
        var label = document.createElement('div');
        label.textContent = field.label || '';
        label.style.cssText = 'font-size:12.5px;color:#6e6e73;margin:10px 2px 5px;font-weight:600;';
        var input = document.createElement('input');
        input.value = field.value || '';
        input.placeholder = field.placeholder || '';
        input.style.cssText = 'width:100%;box-sizing:border-box;font-size:14px;padding:10px 12px;border:1px solid #e5e5ea;border-radius:10px;outline:none;background:#fff;color:#1d1d1f;';
        input.addEventListener('input', function () { values[field.key] = input.value; });
        panel.appendChild(label);
        panel.appendChild(input);
        values[field.key] = field.value || '';
      });

      var note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:#6e6e73;line-height:1.6;margin-top:12px;';
      note.textContent = options.note || '';
      panel.appendChild(note);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;margin-top:18px;';
      if (options.cancelText) {
        var cancel = document.createElement('button');
        cancel.textContent = options.cancelText;
        cancel.style.cssText = 'flex:1;padding:11px 0;font-size:14px;font-weight:600;border:none;border-radius:10px;background:#eef0f3;color:#1d1d1f;cursor:pointer;';
        cancel.addEventListener('click', function () { document.body.removeChild(backdrop); resolve(null); });
        row.appendChild(cancel);
      }
      var ok = document.createElement('button');
      ok.textContent = options.okText || '确定';
      ok.style.cssText = 'flex:2;padding:11px 0;font-size:14px;font-weight:600;border:none;border-radius:10px;background:#0a84ff;color:#fff;cursor:pointer;';
      ok.addEventListener('click', function () { document.body.removeChild(backdrop); resolve(values); });
      row.appendChild(ok);
      panel.appendChild(row);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      var firstInput = panel.querySelector('input');
      if (firstInput) firstInput.focus();
    });
  }

  collab.openHost = function () {
    var self = this;
    if (this.mode) {
      util.toast('已处于协作会话中');
      return Promise.resolve(false);
    }
    if (!NW.remote || !NW.remote.isAvailable()) {
      util.toast('当前浏览器不支持 WebRTC 协作');
      return Promise.resolve(false);
    }
    return showCollabDialog({
      title: '发起多人协作',
      fields: [{key: 'nickname', label: '你的昵称', placeholder: '主机', value: this.nickname || '主机'}],
      okText: '创建房间',
      cancelText: '取消',
      note: '网页版协作通过浏览器点对点直连，房间号是唯一的加入凭证。参与者在另一台设备的 NeoWarp 网页版编辑器里选择「加入协作」并输入房间号。'
    }).then(function (values) {
      if (!values) return false;
      self.nickname = String(values.nickname || '主机').slice(0, 24);
      self.room = NW.remote.generateRoom();
      self.mode = 'host';
      self.roster = [{name: self.nickname, avatar: self.avatar, role: 'host'}];
      self.assembler = new NW.remote.BlobAssembler();
      self.state = {
        isCollaborating: true,
        role: 'host',
        onlineCount: 1,
        permissions: Object.assign({}, self.defaultPermissions)
      };
      self.host = NW.remote.host(self.room, {
        onOpen: function () {},
        onClose: function (link) { hostRemoveMember(link); },
        onData: function (link, obj) {
          if (self.assembler.feed(obj)) return;
          hostOnData(link, obj);
        },
        onBinary: function (link, buffer) {
          var done = self.assembler.binary(buffer);
          // 参与者推送的完整项目（编辑同步）→ 本机应用
          if (done && done.name === 'collab-project') applyIncomingProject(done.buffer);
        }
      });
      pushCollabState();
      showCollabDialog({
        title: '协作房间已创建',
        fields: [{key: 'room', label: '房间号（告诉协作者）', value: self.room}],
        okText: '复制邀请链接',
        note: '协作者在 NeoWarp 网页版编辑器的「协作」里选择「加入协作」并输入上方房间号。关闭此弹窗不会关闭房间。'
      }).then(function (v) {
        if (v && v.room) {
          var url = NW.remote.remoteUrl('gui/gui.html', self.room, 'collab=1');
          try {
            navigator.clipboard.writeText(url).then(function () {
              util.toast('邀请链接已复制');
            }, function () {
              util.toast('复制失败，房间号：' + self.room);
            });
          } catch (e) { void e; }
        }
      });
      return true;
    });
  };

  collab.openJoin = function (presetRoom) {
    var self = this;
    if (this.mode) {
      util.toast('已处于协作会话中');
      return Promise.resolve(false);
    }
    if (!NW.remote || !NW.remote.isAvailable()) {
      util.toast('当前浏览器不支持 WebRTC 协作');
      return Promise.resolve(false);
    }
    return showCollabDialog({
      title: '加入协作',
      fields: [
        {key: 'room', label: '房间号', placeholder: '如 k7m2xq', value: presetRoom || ''},
        {key: 'nickname', label: '你的昵称', placeholder: '协作者', value: this.nickname || ''}
      ],
      okText: '加入',
      cancelText: '取消'
    }).then(function (values) {
      if (!values || !values.room) return false;
      return self.joinRoom(String(values.room).trim(), String(values.nickname || '协作者').slice(0, 24));
    });
  };

  collab.joinRoom = function (room, nickname) {
    var self = this;
    if (!room) {
      util.toast('请输入房间号');
      return Promise.resolve(false);
    }
    this.nickname = nickname || '协作者';
    this.mode = 'participant';
    this.room = room;
    this.assembler = new NW.remote.BlobAssembler();
    var joined = false;
    this.session = NW.remote.join(room, {
      onOpen: function (link) {
        joined = true;
        link.send({t: 'hello', name: self.nickname, avatar: self.avatar});
      },
      onData: function (link, obj) { participantOnData(link, obj); },
      onBinary: function (link, buffer) {
        var done = self.assembler.binary(buffer);
        if (done && done.name === 'collab-project') applyIncomingProject(done.buffer);
      },
      onClose: function () {
        if (self.mode === 'participant') {
          util.toast('与房主的连接已断开');
          callbacks.collaborationEnded.slice().forEach(function (cb) {
            try { cb({}); } catch (e) { void e; }
          });
          resetCollab();
        }
      },
      onFail: function (error) {
        self.mode = null;
        self.session = null;
        util.toast('加入失败：' + ((error && error.message) || '房间不可用'));
      }
    });
    global.setTimeout(function () {
      if (!joined && self.mode === 'participant') {
        util.toast('加入超时：请确认房间号正确且房主编辑器仍开着');
      }
    }, 46000);
    return Promise.resolve(true);
  };

  collab.end = function () {
    if (this.mode === 'host' && this.host) {
      this.host.broadcast({t: 'collab-ended'});
      try { this.host.close(); } catch (e) { void e; }
    }
    resetCollab();
    util.toast('协作已结束');
  };

  collab.leave = function () {
    if (this.mode === 'participant' && this.session) {
      try {
        if (this.session.link) this.session.link.send({t: 'bye'});
        this.session.close();
      } catch (e) { void e; }
    }
    resetCollab();
  };

  /** GUI 侧导出完成：把项目 JSON（+素材）发给协作者 */
  collab.deliverProjectJSON = function (json, target) {
    if (this.mode !== 'host' || !this.host) return;
    var links = target
      ? this.host.links.filter(function (l) { return l.meta.name === target; })
      : this.host.links;
    if (!links.length) return;
    sendProjectPayload(links, json);
  };

  /** 参与者本地编辑后向房主回传（GUI PROJECT_CHANGED 防抖后调用） */
  collab.sendProjectUpdate = function (json) {
    if (this.mode !== 'participant' || !this.session || !this.session.link) return;
    // 参与者改动不需要素材（房主本地就有），直接传项目 JSON
    this.session.link.sendBlob('collab-project', strToBuf(JSON.stringify({
      project: typeof json === 'string' ? json : JSON.stringify(json),
      assets: []
    })));
  };

  /* 编辑器地址带 ?collab=<房间号> 时自动弹出加入框 */
  (function checkCollabInvite () {
    try {
      var params = new URLSearchParams(global.location.search);
      var room = params.get('collab');
      if (room && NW.host) {
        // 等 GUI 就绪后再弹（状态回调由 GUI 注册）
        global.setTimeout(function () {
          if (!collab.mode) collab.openJoin(room);
        }, 6000);
      }
    } catch (e) { void e; }
  })();

  /* 供手机预览面板（misc shim）等外部模块驱动 */
  NW.stageShare = stageShare;
  NW.collab = collab;

  var EditorPreload = {
    /* ---- 基础 ---- */
    isInitiallyFullscreen: () => false,
    getInitialFile: () => storage.takePendingFile().then(function (pending) {
      if (!pending || !pending.buffer) return null;
      var id = 'pending-' + (++fileSeq);
      pendingFileMap.set(id, pending);
      return id;
    }).catch(function () { return null; }),

    /* ---- 文件 ---- */
    getFile: getFile,
    openedFile: () => {},
    closedFile: () => {},
    showOpenFilePicker: showOpenFilePicker,
    showSaveFilePicker: showSaveFilePicker,
    showEncryptedSaveFilePicker: showSaveFilePicker,
    showViewsb3SaveFilePicker: showSaveFilePicker,
    startWriteStream: startWriteStream,

    encryptAndSave: async () => { throw new Error('网页版暂不支持加密保存（.npnp）'); },
    decryptNpnpFile: async () => { throw new Error('网页版暂不支持加密文件'); },
    encryptAndSaveViewsb3: async () => { throw new Error('网页版暂不支持只读分享（.viewsb3）'); },

    setLocale: () => ({ strings: {} }),
    setChanged: () => {},
    setIsFullScreen: (isFullScreen) => {
      if (isFullScreen && global.document.documentElement.requestFullscreen) {
        global.document.documentElement.requestFullscreen().catch(() => {});
      } else if (!isFullScreen && global.document.exitFullscreen) {
        global.document.exitFullscreen().catch(() => {});
      }
    },

    /* ---- 窗口 ---- */
    openNewWindow: () => {
      global.open(global.location.href, '_blank');
      return Promise.resolve(true);
    },
    openAddonSettings: () => {
      openAppWindow('addons', new URL('../addons/addons.html', global.location.href).href, {
        title: '附加组件设置',
        width: Math.min(1100, global.innerWidth - 48),
        height: Math.min(760, global.innerHeight - 48)
      });
      return Promise.resolve(true);
    },
    openDesktopSettings: () => {
      openAppWindow('desktop-settings', new URL('../desktop-settings/desktop-settings.html', global.location.href).href, {
        title: '设置',
        width: Math.min(1020, global.innerWidth - 48),
        height: Math.min(720, global.innerHeight - 48),
        minimizable: false,
        maximizable: false,
        resizable: false
      });
      return Promise.resolve(true);
    },
    openPrivacy: () => {
      openAppWindow('privacy', new URL('../privacy/privacy.html', global.location.href).href, {
        title: '隐私设置',
        width: 760,
        height: 620
      });
      return Promise.resolve(true);
    },
    openAbout: () => {
      openAppWindow('about', new URL('../about/about.html', global.location.href).href, {
        title: '关于 NeoWarp',
        width: 760,
        height: 620,
        resizable: false
      });
      return Promise.resolve(true);
    },
    openContact: () => {
      openAppWindow('contact', new URL('../contact/contact.html', global.location.href).href, {
        title: '联系我们',
        width: 560,
        height: 560,
        resizable: false
      });
      return Promise.resolve(true);
    },
    openPackager: () => {
      openAppWindow('packager', new URL('migrate-helper.html', global.location.href).href, {
        title: '打包器',
        width: 900,
        height: 640
      });
      return Promise.resolve(true);
    },

    /**
     * 本地扩展库（Expands）。桌面版扫描 Expands/ 目录；网页版从虚拟文件系统
     * 读取扩展编辑器保存过的 .js，生成等价的库条目。
     */
    getNeowarpExpands: () => NW.storage.vfsList().then(function (entries) {
      return entries
        .filter(function (entry) { return /\.js$/i.test(entry.path || ''); })
        .map(function (entry) {
          var code = String(entry.content == null ? '' : entry.content);
          var match = /^\/\/\s*ID:\s*(\S+)\s*$/m.exec(code.slice(0, 2048));
          var base = String(entry.path).replace(/\.js$/i, '').split('/').pop() || 'extension';
          var url = '';
          try {
            url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          } catch (e) {
            url = '';
          }
          return {
            name: base,
            extensionId: match ? match[1] : ('neowarp_' + base),
            extensionURL: url,
            iconURL: null,
            insetIconURL: null,
            description: '',
            author: 'NeoWarp'
          };
        })
        .filter(function (item) { return !!item.extensionURL; });
    }).catch(function () { return []; }),

    openAI: () => {
      var handle = openAppWindow('ai-assistant', new URL('../ai/ai-assistant.html', global.location.href).href, {
        title: 'AI 助手',
        width: 480,
        height: 820,
        minWidth: 380,
        minHeight: 420
      });
      return Promise.resolve(!!handle);
    },

    openExtensionEditor: (payload) => {
      var handle = openAppWindow('extension-editor', new URL('../extension-editor/extension-editor.html', global.location.href).href, {
        title: '扩展编辑器',
        width: Math.min(1180, global.innerWidth - 48),
        height: Math.min(800, global.innerHeight - 48)
      });
      if (handle && payload) {
        pendingExtensionFiles.push(payload);
      }
      return Promise.resolve(true);
    },

    openTodoList: () => {
      openAppWindow('todo-list', new URL('../todo-list/todo-list.html', global.location.href).href, {
        title: '待办清单',
        width: 520,
        height: 680
      });
      return Promise.resolve(true);
    },
    openTaskManager: () => {
      openAppWindow('task-manager', new URL('../task-manager/task-manager.html', global.location.href).href, {
        title: '任务管理器',
        width: 640,
        height: 620
      });
      return Promise.resolve(true);
    },
    openProjectAnalysis: () => {
      openAppWindow('project-analysis', new URL('../project-analysis/project-analysis.html', global.location.href).href, {
        title: '工程分析',
        width: 900,
        height: 680
      });
      return Promise.resolve(true);
    },
    openMobilePreview: () => {
      openAppWindow('mobile-preview', new URL('../mobile-preview/mobile-preview.html', global.location.href).href, {
        title: '手机预览',
        width: 480,
        height: 620
      });
      return Promise.resolve(true);
    },

    /* ---- 媒体设备 / 自定义 ---- */
    getPreferredMediaDevices: async () => {
      try {
        var devices = await global.navigator.mediaDevices.enumerateDevices();
        var microphone = (devices.find(function (d) { return d.kind === 'audioinput'; }) || {}).deviceId || null;
        var camera = (devices.find(function (d) { return d.kind === 'videoinput'; }) || {}).deviceId || null;
        return { microphone: microphone, camera: camera, audioInputId: microphone || '', videoInputId: camera || '' };
      } catch (e) {
        return { microphone: null, camera: null, audioInputId: '', videoInputId: '' };
      }
    },

    getAdvancedCustomizations: async () => ({
      userscript: util.readLocal('neowarp:userscript', ''),
      userstyle: util.readLocal('neowarp:userstyle', '')
    }),

    setExportForPackager: (callback) => {
      global._neowarpExportForPackager = callback;
    },

    /* ---- 系统状态 ---- */
    getSystemStats: async () => {
      var usedMemory = 0;
      var totalMemory = 0;
      var perfMemory = global.performance && global.performance.memory;
      if (perfMemory) {
        usedMemory = perfMemory.usedJSHeapSize || 0;
        totalMemory = perfMemory.jsHeapSizeLimit || 0;
      } else if (global.navigator.deviceMemory) {
        totalMemory = global.navigator.deviceMemory * 1024 * 1024 * 1024;
      }
      var ramUsedMB = Math.max(0, Math.round(usedMemory / 1024 / 1024));
      var cpuPercent = Math.round(cpuEstimate * 10) / 10;
      return {
        cpuPercent: cpuPercent,
        ramUsedMB: ramUsedMB,
        usedMemory: usedMemory,
        totalMemory: totalMemory,
        cpuUsage: cpuPercent,
        memory: { used: usedMemory, total: totalMemory }
      };
    },
    getTopBarDeviceStats: () => storage.getSettings().topBarDeviceStats !== false,
    // 顶栏设备占用开关：本地存储变化或跨窗口广播时推进菜单栏实时显隐
    onTopBarDeviceStatsChanged: (callback) => {
      storage.onSettingsChanged(function (key, value) {
        if (key === 'topBarDeviceStats') callback(value);
      });
      util.onBroadcast(function (message) {
        if (message.type === 'topBarDeviceStats') callback(message.data && message.data.enabled);
      });
    },
    getAISystemInfo: async () => {
      var stats = await EditorPreload.getSystemStats();
      return {
        platform: 'web',
        version: global.NW_VERSION || '2.0.0',
        cpuPercent: stats.cpuPercent,
        ramUsedMB: stats.ramUsedMB
      };
    },

    /* ---- 分离舞台 ---- */
    detachStage: () => {
      openAppWindow('detached-stage', new URL('../detached-stage/index.html', global.location.href).href, {
        title: '分离舞台',
        width: 720,
        height: 600
      });
      return Promise.resolve(true);
    },
    reattachStage: () => {},
    sendStageFrame: () => {},
    onStageDetached: (cb) => { callbacks.stageDetached = cb; },
    onStageReattached: (cb) => { callbacks.stageReattached = cb; },
    onDetachedStageInput: (cb) => { callbacks.detachedStageInput = cb; },

    /* ---- 背景图 / 品牌 ---- */
    getCodeAreaBackgroundImage: () => util.readLocal('neowarp:codeBg', null),
    setCodeAreaBackgroundImage: async (imageData) => {
      util.writeLocal('neowarp:codeBg', imageData || null);
    },
    getStageAreaBackgroundImage: () => util.readLocal('neowarp:stageBg', null),
    setStageAreaBackgroundImage: async (imageData) => {
      util.writeLocal('neowarp:stageBg', imageData || null);
    },
    // 标签栏「源代码Beta」按钮显隐（编辑器设置模态框 → 外观）：
    // 本地存储 + 广播，多标签页实时同步
    getShowSourceCodeButton: () => {
      // localStorage 会把布尔转成 "true"/"false" 字符串，这里统一解析；
      // 未存储过时默认显示
      var value = util.readLocal('neowarp:showSourceCodeButton', null);
      return value === null ? true : String(value) !== 'false';
    },
    setShowSourceCodeButton: async (enabled) => {
      util.writeLocal('neowarp:showSourceCodeButton', enabled !== false);
      util.broadcast('showSourceCodeButton', enabled !== false);
    },
    onShowSourceCodeButtonChanged: (callback) => {
      util.onBroadcast(function (message) {
        if (message.type === 'showSourceCodeButton') callback(message.data);
      });
    },
    getGlobalUITheme: async () => storage.getSettings().uiTheme || 'system',
    onGlobalUIThemeChanged: (callback) => {
      storage.onSettingsChanged(function (key, value) {
        if (key === 'uiTheme') callback(value);
      });
      util.onBroadcast(function (message) {
        if (message.type === 'uiTheme') callback(message.data);
      });
    },

    // 顶部工具栏高度（normal / narrow）。同步返回：需要在 React 渲染前
    // 拿到值，让 Blockly 首次注入时就按正确高度测量代码区。
    getToolbarHeight: () => {
      var value = storage.getSettings().toolbarHeight;
      return value === 'narrow' ? 'narrow' : 'normal';
    },
    onToolbarHeightChanged: (callback) => {
      storage.onSettingsChanged(function (key, value) {
        if (key === 'toolbarHeight') callback(value);
      });
      util.onBroadcast(function (message) {
        if (message.type === 'toolbarHeight') callback(message.data && message.data.height);
      });
    },

    /* ---- AI / 扩展协作回调 ---- */
    onRequestProjectJSON: (cb) => { callbacks.requestProjectJSON.push(cb); },
    sendProjectJSON: (data) => {
      resolveRequest(data && data.requestId, {
        projectJSON: data && data.projectJSON,
        assetSize: data && data.assetSize
      });
    },
    onApplyProject: (cb) => { callbacks.applyProject.push(cb); },
    onApplySprite: (cb) => { callbacks.applySprite.push(cb); },
    onRequestSpriteLibrary: (cb) => { callbacks.requestSpriteLibrary.push(cb); },
    sendSpriteLibrary: (data) => { global._neowarpSpriteLibrary = data; },
    fetchImage: async (url) => {
      var response = await fetch(url);
      var blob = await response.blob();
      return new Uint8Array(await blob.arrayBuffer());
    },
    onAIToolCall: (cb) => { callbacks.aiToolCall.push(cb); },
    sendAIToolResponse: (data) => {
      resolveRequest(data && data.requestId, data && data.result);
    },
    onRequestTheme: (cb) => { callbacks.requestTheme.push(cb); },
    sendTheme: () => {},
    notifyThemeChanged: (theme) => { if (NW.host) NW.host.notifyAppearanceChanged(); },
    onRequestSpriteStats: (cb) => { callbacks.spriteStats.push(cb); },
    sendSpriteStats: (data) => { resolveRequest(data && data.requestId, data); },
    // 图片编辑器「导出到 Scratch 项目」：把图片导入为造型 / 新角色
    onImportCostume: (cb) => { callbacks.importCostume.push(cb); },
    sendImportCostumeResult: (data) => { resolveRequest(data && data.requestId, data); },
    removeAllAIListeners: () => {
      callbacks.requestProjectJSON.length = 0;
      callbacks.applyProject.length = 0;
      callbacks.applySprite.length = 0;
      callbacks.aiToolCall.length = 0;
      callbacks.requestTheme.length = 0;
      // 注意：不清空 spriteStats —— GUI 在调用 removeAllAIListeners 之前注册
      // onRequestSpriteStats（见 desktop-hoc.jsx 注释），清掉会让角色统计/列表失效
      callbacks.importCostume.length = 0;
    },

    onAddExtension: (cb) => { callbacks.addExtension.push(cb); },
    sendAddExtensionResult: (data) => { resolveRequest(data && data.requestId, data); },
    /* 调试用：返回各回调的注册状态（GUI didMount 完成后 addExtension 应为 1） */
    _nwDebugCallbacks: () => Object.keys(callbacks).map(function (k) {
      var list = callbacks[k];
      return k + ':' + (list && list.length ? 1 : 0);
    }).join(','),
    openExtensionInEditor: (payload) => EditorPreload.openExtensionEditor(payload),
    onMyExtensionsUpsert: (cb) => { callbacks.myExtensionsUpsert.push(cb); },
    sendMyExtensionsUpsertResult: (data) => { resolveRequest(data && data.requestId, data); },

    /* ---- 待加入的桌面能力，先给出安全空实现 ---- */
    onSoloExportProject: (cb) => { callbacks.soloExportProject.push(cb); },
    sendSoloExportProject: (data) => { resolveRequest(data && data.requestId, data); },
    onSoloStageStream: (cb) => { callbacks.soloStageStream = cb; },
    sendSoloStageFrame: (dataURL) => { stageShare.pushFrame(dataURL); },
    sendSoloStageOverlays: (data) => { stageShare.pushOverlays(data); },
    onSoloStageAnswer: (cb) => { callbacks.soloStageAnswer = cb; },
    onSoloStageControl: (cb) => { callbacks.soloStageControl = cb; },
    sendSoloStageControl: (data) => { resolveRequest(data && data.requestId, data); },
    sendSoloStageRunStatus: () => {},

    openCollaborationHost: () => collab.openHost(),
    openCollaborationJoin: () => collab.openJoin(),
    endCollaboration: () => collab.end(),
    leaveCollaboration: () => collab.leave(),
    openCollaborationChat: () => {},
    checkCollaborationPermission: async () => !!(collab.state && collab.state.isCollaborating),
    onCollaborationStateChange: (cb) => { callbacks.collaborationStateChange.push(cb); },
    onCollaborationChatMessage: (cb) => { callbacks.collaborationChatMessage.push(cb); },
    onCollaborationEnded: (cb) => { callbacks.collaborationEnded.push(cb); },
    onCollabRequestProjectJSON: (cb) => { callbacks.collabRequestProjectJSON.push(cb); },
    sendCollabProjectJSON: (json, target) => collab.deliverProjectJSON(json, target),
    onCollabProjectUpdate: (cb) => { callbacks.collabProjectUpdate.push(cb); },
    sendCollabProjectUpdate: (json) => collab.sendProjectUpdate(json),
    removeAllCollaborationListeners: () => {
      callbacks.collaborationStateChange.length = 0;
      callbacks.collaborationChatMessage.length = 0;
      callbacks.collaborationEnded.length = 0;
      callbacks.collabRequestProjectJSON.length = 0;
      callbacks.collabProjectUpdate.length = 0;
    }
  };

  global.EditorPreload = EditorPreload;

  global.PromptsPreload = {
    alert: (message) => { nativeAlert(message); return true; },
    confirm: (message) => nativeConfirm(message)
  };

  /* ------------- 扩展编辑器需要的待打开文件（序号从 1 开始） ------------- */
  var pendingExtensionFiles = [];
  global.__neowarpTakeExtensionFiles = function () {
    var files = pendingExtensionFiles.slice();
    pendingExtensionFiles.length = 0;
    return files;
  };

  /* -------------------- 注册为宿主的 editor 服务 -------------------- */
  if (NW.host) {
    var WINDOW_ID = 'editor-' + Math.random().toString(36).slice(2, 8);

    NW.host.register('editor', {
      getProjectCode: function () {
        return awaitCallback('requestProjectJSON', function (requestId) {
          return { requestId: requestId };
        }, 90000).then(function (result) {
          return (result && result.projectJSON) || null;
        });
      },

      applyProject: function (projectJSON) {
        if (!callbacks.applyProject.length) return { success: false, error: '编辑器尚未就绪' };
        callbacks.applyProject.forEach(function (cb) {
          try { cb({ projectJSON: projectJSON }); } catch (e) { /* 忽略 */ }
        });
        return { success: true };
      },

      applySprite: function (spriteJSON, targetId) {
        if (!callbacks.applySprite.length) return { success: false, error: '编辑器尚未就绪' };
        callbacks.applySprite.forEach(function (cb) {
          try { cb({ spriteJSON: spriteJSON, targetId: targetId }); } catch (e) { /* 忽略 */ }
        });
        return { success: true };
      },

      getSpriteLibrary: function () {
        return awaitCallback('requestSpriteLibrary', function (requestId) {
          return { requestId: requestId };
        }, 30000).catch(function () { return null; });
      },

      callTool: function (toolName, params) {
        return awaitCallback('aiToolCall', function (requestId) {
          return { requestId: requestId, toolName: toolName, params: params };
        }, 600000).then(function (result) {
          return result || { success: false, error: '编辑器未返回结果' };
        }, function (error) {
          return { success: false, error: (error && error.message) || String(error) };
        });
      },

      getSpriteStats: function () {
        return awaitCallback('spriteStats', function (requestId) {
          return { requestId: requestId };
        }, 30000).catch(function () { return { sprites: [], totalThreads: 0 }; });
      },

      importCostume: function (targetId, name, dataUrl, asNewSprite) {
        return importCostumeLocal(targetId, name, dataUrl, asNewSprite);
      },

      getSystemStats: EditorPreload.getSystemStats,

      listProjects: function () {
        return [{ id: WINDOW_ID, title: global.document.title || '项目' }];
      },

      addToProject: function (targetId, name, code) {
        var normalized = util.normalizeExtensionCode(code, name);
        return awaitCallback('addExtension', function (requestId) {
          return { requestId: requestId, name: name, code: normalized };
        }, 60000).then(function (result) {
          return result || { success: false, error: '编辑器未响应' };
        }, function (error) {
          return { success: false, error: (error && error.message) || String(error) };
        });
      },

      upsertMyExtension: function (id, name, code) {
        var normalized = util.normalizeExtensionCode(code, name);
        return awaitCallback('myExtensionsUpsert', function (requestId) {
          return { requestId: requestId, id: id || null, name: name, code: normalized };
        }, 60000).then(function (result) {
          return result || { success: false, error: '编辑器未响应' };
        }, function (error) {
          return { success: false, error: (error && error.message) || String(error) };
        });
      },

      takePendingExtensionFiles: function () {
        return global.__neowarpTakeExtensionFiles();
      },

      getProjectAnalysisData: function () {
        return awaitCallback('requestProjectJSON', function (requestId) {
          return { requestId: requestId };
        }, 90000).then(function (result) {
          return (result && result.projectJSON) || null;
        });
      }
    });

    NW.host.register('desktop', {
      openDesktopSettings: function () {
        EditorPreload.openDesktopSettings();
        return true;
      }
    });

    /** 把图片导入本编辑器：targetId 有值 → 追加为该角色的造型；为空或 asNewSprite → 新建角色 */
    function importCostumeLocal (targetId, name, dataUrl, asNewSprite) {
      return awaitCallback('importCostume', function (requestId) {
        return {
          requestId: requestId,
          targetId: targetId || null,
          name: name,
          dataUrl: dataUrl,
          asNewSprite: !!asNewSprite
        };
      }, 60000).then(function (result) {
        return result || { success: false, error: '编辑器未响应' };
      }, function (error) {
        return { success: false, error: (error && error.message) || String(error) };
      });
    }

    /* 编辑器开/关要广播出去：扩展编辑器据此显示「添加到项目 / 添加到我的扩展」，
       图片编辑器据此显示「导出到 Scratch 项目」。跨标签页场景靠 BroadcastChannel
       送达，与页内窗口共用同一套事件名。带上角色列表供图片编辑器选择导入目标。 */
    function announceProjects () {
      if (!NW.host || !NW.host.emit) return;
      var title = global.document.title || '项目';
      var emitList = function (sprites) {
        NW.host.emit('editor', 'projectsChanged', [{ id: WINDOW_ID, title: title, sprites: sprites || [] }]);
      };
      if (callbacks.spriteStats.length) {
        awaitCallback('spriteStats', function (requestId) {
          return { requestId: requestId };
        }, 5000).then(function (data) {
          emitList(data && data.sprites);
        }, function () {
          emitList([]);
        });
      } else {
        emitList([]);
      }
    }

    global.setTimeout(announceProjects, 1200);
    global.addEventListener('pagehide', function () {
      if (NW.host && NW.host.emit) NW.host.emit('editor', 'projectsChanged', []);
    });

    // 图片编辑器广播「请求项目列表」→ 回报本项目的角色；广播「导入造型」→ 只有匹配的编辑器响应
    if (NW.rpc && NW.rpc.on) {
      NW.rpc.on('editor', 'requestProjectsChanged', function () {
        announceProjects();
      });
      NW.rpc.on('editor', 'importCostumeFor', function (data) {
        if (!data || data.editorId !== WINDOW_ID) return;
        importCostumeLocal(data.targetId, data.name, data.dataUrl, data.asNewSprite).then(function (res) {
          if (!NW.host || !NW.host.emit) return;
          NW.host.emit('editor', 'importCostumeResult', {
            requestId: data.requestId,
            editorId: WINDOW_ID,
            success: !!(res && res.success),
            error: (res && res.error) || null
          });
        });
      });
    }
  }
})(window);
