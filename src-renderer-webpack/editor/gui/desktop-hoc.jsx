import React from 'react';
import {connect} from 'react-redux';
import PropTypes from 'prop-types';
import {
  openLoadingProject,
  closeLoadingProject,
  openInvalidProjectModal
} from 'scratch-gui/src/reducers/modals';
import {
  requestProjectUpload,
  setProjectId,
  defaultProjectId,
  onFetchedProjectData,
  onLoadedProject,
  requestNewProject,
  LoadingState
} from 'scratch-gui/src/reducers/project-state';
import {
  setFileHandle,
  setUsername,
  setProjectError
} from 'scratch-gui/src/reducers/tw';
import {
  setViewOnly,
  setFullScreen
} from 'scratch-gui/src/reducers/mode';
import {setTheme} from 'scratch-gui/src/reducers/theme';
import {BLOCKS_CUSTOM} from 'scratch-gui/src/lib/themes';
import {detectTheme} from 'scratch-gui/src/lib/themes/themePersistance';
import {getAutoAddExtensions, addMyExtension, updateMyExtension, getMyExtensionById, generateId} from 'scratch-gui/src/lib/tw-my-extensions';
import {manuallyTrustExtension} from 'scratch-gui/src/containers/tw-security-manager.jsx';
import {WrappedFileHandle} from './filesystem-api.js';
import {setStrings} from '../prompt/prompt.js';
import {showEncryptedSaveDialog, showPasswordDialog, setStrings as setEncryptedSaveStrings} from '../encrypted-save-dialog/encrypted-save-dialog.js';
import JSZip from '@turbowarp/jszip';
import sb3 from 'scratch-vm/src/serialization/sb3';
import StageLayering from 'scratch-vm/src/engine/stage-layering';
import Runtime from 'scratch-vm/src/engine/runtime';
import AddonHooks from 'scratch-gui/src/addons/hooks';

let mountedOnce = false;
let isStageDetached = false;
let frameStreamingActive = false;
let frameAnimationId = null;
let aiListenersRegistered = false;
// SOLO：后台编辑器把舞台画面流转发给 SOLO 窗口的开关（独立于 detach 舞台）
let soloStreamActive = false;
let soloStreamTimer = null;

/**
 * @param {string} filename
 * @returns {string}
 */
const getDefaultProjectTitle = (filename) => {
  const match = filename.match(/([^/\\]+)\.(?:sb[2|3]?|np1|npnp|viewsb3)$/);
  if (!match) return filename;
  return match[1];
};

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

// NeoWarp: Collaboration — a project's JSON only references costumes, backdrops
// and sounds by md5. A peer that loads that JSON cannot resolve the host's
// uploaded assets (they are not on the public asset CDN), so every asset shows
// up empty. Collaborators therefore exchange the full .sb3 archive, which
// embeds all assets, base64-encoded inside the existing JSON message.
const COLLAB_PROJECT_FORMAT = 'sb3';

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ===== Collaboration: incremental project sync helpers =====
//
// Remote updates used to be applied with vm.loadProject(), which tears down
// and rebuilds every target: the whole editor visibly "reloads", all running
// scripts stop and the editing target resets on every single edit any peer
// makes. Instead, received projects are diffed against the local state and
// applied per sprite: only changed sprites are rebuilt in place, pure
// position/pose changes are merged onto the live target, monitors are synced
// through the runtime's monitor API, and a full reload remains only for
// stage-level/global changes. When a rebuild of the script workspace is
// needed, it is deferred while the user is dragging or editing a field, so
// remote updates land without visible flashes and without interrupting.

// Target fields that change while scripts run (dragging on stage, switching
// costume tabs, volume). They are synced, but must not be treated as a
// structural edit that requires rebuilding the target.
const COLLAB_SPRITE_RUNTIME_PROPS = [
  'x', 'y', 'size', 'direction', 'visible', 'draggable',
  'rotationStyle', 'currentCostume', 'volume'
];

const collabStableStringify = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(collabStableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${collabStableStringify(value[key])}`).join(',')}}`;
};

// Strip runtime-only data from sb3 target JSON: variable/list values are
// written by running scripts all the time and are not part of a structural
// edit, so they must not make two structurally identical sprites differ.
const collabNormalizeTarget = (targetJson, isStage) => {
  const normalized = JSON.parse(collabStableStringify(targetJson));
  const stripValues = record => {
    const copy = {};
    for (const id of Object.keys(record || {})) {
      const entry = record[id];
      // [name, value, ...flags] — keep the name and flags, drop the value
      copy[id] = Array.isArray(entry) ? entry.slice(0, 1).concat(entry.slice(2)) : entry;
    }
    return copy;
  };
  normalized.variables = stripValues(normalized.variables);
  normalized.lists = stripValues(normalized.lists);
  if (isStage) {
    // Stage fields scripts mutate while running (tempo, video settings…)
    for (const key of ['tempo', 'videoState', 'videoTransparency', 'textToSpeechLanguage', 'volume']) {
      delete normalized[key];
    }
  }
  return normalized;
};

const collabSpritesEqual = (localJson, remoteJson) =>
  collabStableStringify(collabNormalizeTarget(localJson, localJson.isStage)) ===
  collabStableStringify(collabNormalizeTarget(remoteJson, remoteJson.isStage));

// True when the two sprites differ only in runtime props (drag, costume tab,
// volume…): those can be merged onto the live target without rebuilding it.
const collabSpriteRuntimePropsOnly = (localJson, remoteJson) => {
  const stripProps = json => {
    const copy = collabNormalizeTarget(json, json.isStage);
    for (const prop of COLLAB_SPRITE_RUNTIME_PROPS) delete copy[prop];
    return copy;
  };
  if (collabStableStringify(stripProps(localJson)) !== collabStableStringify(stripProps(remoteJson))) {
    return false;
  }
  return COLLAB_SPRITE_RUNTIME_PROPS.some(prop =>
    JSON.stringify(localJson[prop]) !== JSON.stringify(remoteJson[prop]));
};

// Monitors diff. Every serialized monitor field maps onto a MonitorRecord
// property, so monitor differences never require a full project reload; this
// returns the per-record operations to apply to the runtime monitor state.
// The serialized `value` is a placeholder, so it is ignored when comparing.
const collabMonitorRecordShape = record => {
  const copy = {...record};
  delete copy.value;
  return copy;
};

const collabMonitorChanges = (localMonitors, remoteMonitors) => {
  const localById = new Map((localMonitors || []).map(record => [record.id, record]));
  const remoteById = new Map((remoteMonitors || []).map(record => [record.id, record]));
  const additions = [];
  const updates = [];
  const deletions = [];
  for (const [id, remote] of remoteById) {
    const local = localById.get(id);
    if (!local) {
      additions.push(remote);
      continue;
    }
    if (collabStableStringify(collabMonitorRecordShape(local)) !==
        collabStableStringify(collabMonitorRecordShape(remote))) {
      updates.push(remote);
    }
  }
  for (const [id] of localById) {
    if (!remoteById.has(id)) deletions.push(id);
  }
  return {additions, updates, deletions};
};

// Stage structural diff. Peers create variables, lists and broadcast messages
// all the time while editing; when that is the ONLY stage change it is applied
// in place: {additions, deletions}. Any other stage change (backdrops, stage
// blocks, comments, renames, cloud variable removal…) needs a full reload and
// returns null.
const collabStageChanges = (localStageJson, remoteStageJson) => {
  // Any difference outside the variable records cannot be applied in place
  const stripVariables = stageJson => {
    const copy = collabNormalizeTarget(stageJson, true);
    delete copy.variables;
    delete copy.lists;
    delete copy.broadcasts;
    return copy;
  };
  if (collabStableStringify(stripVariables(localStageJson)) !==
      collabStableStringify(stripVariables(remoteStageJson))) {
    return null;
  }
  const kinds = [
    ['variables', ''],
    ['lists', 'list'],
    ['broadcasts', 'broadcast_msg']
  ];
  const additions = [];
  const deletions = [];
  for (const [field, type] of kinds) {
    const localRecord = localStageJson[field] || {};
    const remoteRecord = remoteStageJson[field] || {};
    for (const id of Object.keys(remoteRecord)) {
      const entry = remoteRecord[id];
      if (Object.prototype.hasOwnProperty.call(localRecord, id)) {
        const localEntry = Array.isArray(localRecord[id])
          ? localRecord[id].slice(0, 1).concat(localRecord[id].slice(2))
          : localRecord[id];
        const remoteEntry = Array.isArray(entry) ? entry.slice(0, 1).concat(entry.slice(2)) : entry;
        if (JSON.stringify(localEntry) !== JSON.stringify(remoteEntry)) return null; // renamed
      } else {
        additions.push({
          id,
          field,
          name: Array.isArray(entry) ? entry[0] : entry,
          type,
          isCloud: Array.isArray(entry) && entry[2] === true
        });
      }
    }
    for (const id of Object.keys(localRecord)) {
      if (Object.prototype.hasOwnProperty.call(remoteRecord, id)) continue;
      const entry = localRecord[id];
      if (field === 'variables' && Array.isArray(entry) && entry[2] === true) {
        // Cloud variable bookkeeping lives in the runtime; don't remove here
        return null;
      }
      deletions.push({id, field});
    }
  }
  return {additions, deletions};
};

const handleClickAddonSettings = (search) => {
  EditorPreload.openAddonSettings(typeof search === 'string' ? search : null);
};

const handleClickNewWindow = () => {
  EditorPreload.openNewWindow();
};

const handleClickPackager = () => {
  EditorPreload.openPackager();
};

const handleClickDesktopSettings = () => {
  EditorPreload.openDesktopSettings();
};

const handleClickPrivacy = () => {
  EditorPreload.openPrivacy();
};

const handleClickAbout = () => {
  EditorPreload.openAbout();
};

const handleClickContact = () => {
  EditorPreload.openContact();
};

const handleClickAI = () => {
  EditorPreload.openAI();
};

const handleClickTodoList = () => {
  EditorPreload.openTodoList();
};

const handleClickProjectAnalysis = () => {
  EditorPreload.openProjectAnalysis();
};

const handleClickMobilePreview = () => {
  EditorPreload.openMobilePreview();
};

const handleClickSourceCode = () => {
  window.open('https://github.com/Shiyuan-318/Neowarp');
};

const handleClickFeedback = () => {
  window.open('https://github.com/Shiyuan-318/Neowarp/issues');
};

const handleDetachStage = (vm) => {
  let stageWidth = 480;
  let stageHeight = 360;
  try {
    if (vm && vm.runtime && vm.runtime.renderer) {
      stageWidth = vm.runtime.renderer._width || stageWidth;
      stageHeight = vm.runtime.renderer._height || stageHeight;
    }
  } catch (e) {
    // ignore - fall back to defaults
  }
  EditorPreload.detachStage(stageWidth, stageHeight);
};

const handleReattachStage = () => {
  EditorPreload.reattachStage();
};

const handleClickCollaborationHost = () => {
  EditorPreload.openCollaborationHost();
};

const handleClickCollaborationJoin = () => {
  EditorPreload.openCollaborationJoin();
};

const handleClickCollaborationChat = () => {
  EditorPreload.openCollaborationChat();
};

const handleClickEndCollaboration = () => {
  EditorPreload.endCollaboration();
};

const handleClickLeaveCollaboration = () => {
  EditorPreload.leaveCollaboration();
};

const startFrameStreaming = (vm) => {
  if (frameStreamingActive) return;
  frameStreamingActive = true;

  const streamFrame = () => {
    if (!frameStreamingActive || !isStageDetached) return;
    try {
      if (vm.renderer && vm.renderer.requestSnapshot) {
        // Use the renderer's built-in snapshot API
        // This properly handles preserveDrawingBuffer and renders the frame
        vm.renderer.requestSnapshot((dataURL) => {
          if (frameStreamingActive && isStageDetached) {
            EditorPreload.sendStageFrame(dataURL);
          }
        });
      }
    } catch (e) {
      // ignore
    }
    frameAnimationId = setTimeout(streamFrame, 33);
  };
  streamFrame();
};

const stopFrameStreaming = () => {
  frameStreamingActive = false;
  if (frameAnimationId !== null) {
    clearTimeout(frameAnimationId);
    frameAnimationId = null;
  }
};

/* ── SOLO 舞台画面流 ──
   与 detach 舞台的流式推送相互独立：SOLO 只要求画面（预览缩略图 + 弹出的
   舞台窗口），编辑器本体隐藏与否都不影响。帧率取较低值（~8fps），
   足够看动画效果又不会让隐藏窗口的 CPU 占用明显上升。 */
let soloQuestion = null; // 当前待回答的提问文本；null 表示没有提问

// 常用非变量类监视器的标签（与 Scratch 界面用词一致），不在表内的用 opcode 兜底
const SOLO_MONITOR_LABELS = {
  motion_xposition: 'x position',
  motion_yposition: 'y position',
  motion_direction: 'direction',
  looks_costumenumbername: 'costume #',
  looks_backdropnumbername: 'backdrop #',
  looks_size: 'size',
  sensing_timer: 'timer',
  sensing_loudness: 'loudness',
  sensing_dayssince2000: 'days since 2000',
  sensing_username: 'username',
  sound_volume: 'volume'
};

// 列表监视器最多推送的条目数（防超大列表每帧序列化撑爆 IPC）
const SOLO_LIST_MAX_ITEMS = 50;
// 单个值字符串的推送上限
const SOLO_VALUE_MAX_CHARS = 200;

const soloClipValue = (value) => {
  const str = String(value);
  return str.length > SOLO_VALUE_MAX_CHARS ? str.slice(0, SOLO_VALUE_MAX_CHARS) + '…' : str;
};

/**
 * 收集舞台上的变量/列表监视器与提问框状态。
 * 这些都是 scratch-gui 的 DOM 覆盖层，canvas 快照拍不到，必须单独序列化。
 */
const getSoloStageOverlays = (vm) => {
  const monitors = [];
  try {
    const state = vm.runtime && vm.runtime._monitorState;
    if (state && state.map) {
      state.map.forEach((rec, id) => {
        if (!rec || rec.visible === false) return;
        const params = rec.params || {};
        let label;
        if (rec.opcode === 'data_variable') {
          label = (rec.spriteName ? rec.spriteName + ': ' : '') + (params.VARIABLE || '');
        } else if (rec.opcode === 'data_list') {
          label = (rec.spriteName ? rec.spriteName + ': ' : '') + (params.LIST || '');
        } else if (rec.opcode === 'sensing_current') {
          label = String(params.CURRENTMENU || '').toLowerCase();
        } else if (SOLO_MONITOR_LABELS[rec.opcode]) {
          label = SOLO_MONITOR_LABELS[rec.opcode];
        } else if (params.PROPERTY && rec.opcode === 'sensing_of') {
          label = (params.OBJECT && params.OBJECT !== '_stage_' ? params.OBJECT + ': ' : '') + params.PROPERTY;
        } else {
          label = String(rec.opcode || '').replace(/^[a-z]+_/, '').replace(/_/g, ' ');
        }
        const isList = (rec.mode || 'default') === 'list';
        let value = rec.value;
        let listTotal = 0;
        if (isList && Array.isArray(value)) {
          listTotal = value.length;
          value = value.slice(0, SOLO_LIST_MAX_ITEMS).map(soloClipValue);
        } else if (isList) {
          value = [];
        } else {
          value = soloClipValue(value);
        }
        // 每帧全量推送；舞台端按 id 复用 DOM 元素，只在列表内容真正变化时
        // 才重绘行（滚动位置得以保留），这里不做变化过滤
        monitors.push({
          id,
          mode: rec.mode || 'default',
          label,
          value,
          listTotal,
          x: typeof rec.x === 'number' ? rec.x : null,
          y: typeof rec.y === 'number' ? rec.y : null,
          width: rec.width || 0
        });
      });
    }
  } catch (e) {
    // 监视器状态读取失败不阻塞画面流
  }
  return {
    monitors,
    prompt: soloQuestion === null ? null : { question: soloQuestion }
  };
};

const startSoloStream = (vm) => {
  if (soloStreamActive) return;
  soloStreamActive = true;
  // 监视器/提问是 DOM 覆盖层，canvas 快照拍不到；在这里顺带监听并随帧推送。
  // VM 换工程后会换实例，绑定标记挂在 runtime 上保证每个实例只绑一次
  try {
    if (vm.runtime && !vm.runtime.__soloOverlaysBound) {
      vm.runtime.__soloOverlaysBound = true;
      vm.runtime.on('QUESTION', (question) => {
        soloQuestion = question === null || typeof question === 'undefined' ? null : String(question);
      });
      vm.runtime.on('PROJECT_STOP_ALL', () => {
        soloQuestion = null;
      });
    }
  } catch (e) {
    // ignore - 事件绑定失败只影响监视器/提问显示
  }
  const streamFrame = () => {
    if (!soloStreamActive) return;
    try {
      if (vm.renderer && vm.renderer.requestSnapshot) {
        vm.renderer.requestSnapshot((dataURL) => {
          if (soloStreamActive) {
            EditorPreload.sendSoloStageFrame(dataURL);
            try {
              EditorPreload.sendSoloStageOverlays(getSoloStageOverlays(vm));
            } catch (e) {
              // ignore - 覆盖层收集失败不阻塞画面
            }
          }
        });
      }
    } catch (e) {
      // ignore - 编辑器窗口可能在关闭过程中
    }
    soloStreamTimer = setTimeout(streamFrame, 125);
  };
  streamFrame();
};

const stopSoloStream = () => {
  soloStreamActive = false;
  soloQuestion = null;
  if (soloStreamTimer !== null) {
    clearTimeout(soloStreamTimer);
    soloStreamTimer = null;
  }
};

/* AI 工具的「工程就绪」门：SOLO 用隐藏编辑器作工程宿主，create_project/
   adoptProject 刚挂上工程那几秒里，页面虽已挂载、VM 却还在异步加载（实测
   3~8 秒）。这期间工具要么"立即成功但读到空工程"（AI 误判新工程为空），
   要么干等主进程 30 秒超时（AI 读不到新项目）。因此 VM 类工具执行前先等
   runtime 出现原始 target：deserializeProject 一开始就清空 targets，
   全部装完才发 PROJECT_LOADED，所以"有 isOriginal 的 target"⇔ 已加载完。 */
const AI_TOOLS_NOT_REQUIRING_PROJECT = [
  // 这些工具不读工程数据（宿主信息 / AI 侧快照登记 / 联网搜索），不用等加载
  'getSystemTime',
  'getSystemInfo',
  'searchExtensions',
  'getSpriteLibrary',
  'hasProjectSnapshot',
  'dropProjectSnapshot'
];

/**
 * 等 VM 把工程真正加载完。返回 null 表示已就绪、调用方可继续执行工具；
 * 返回对象则代表放弃等待（超时），调用方应把它作为工具结果直接回给主进程，
 * 给 AI 一个明确的"工程还没加载好"信号而不是空数据或哑超时。
 * @param {VM} vm
 * @param {number} timeoutMs 最长等待毫秒数
 * @returns {Promise<{success: boolean, error: string}|null>}
 */
const waitProjectReadyForTools = (vm, timeoutMs) => new Promise(resolve => {
  const isReady = () => {
    try {
      const targets = vm.runtime && vm.runtime.targets;
      return Array.isArray(targets) && targets.some(t => t && t.isOriginal);
    } catch (e) {
      // 状态读不出来就不拦工具，保持原有行为
      return true;
    }
  };
  if (isReady()) {
    resolve(null);
    return;
  }
  let finished = false;
  let pollTimer = null;
  let loadedHandler = null;
  const finish = result => {
    if (finished) return;
    finished = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      if (loadedHandler) vm.runtime.off('PROJECT_LOADED', loadedHandler);
    } catch (e) {
      // ignore - 监听器解绑失败不影响结果
    }
    resolve(result);
  };
  // PROJECT_LOADED 恰在 targets 安装完时发出，事件到达比轮询更及时
  try {
    loadedHandler = () => finish(null);
    vm.runtime.on('PROJECT_LOADED', loadedHandler);
  } catch (e) {
    loadedHandler = null; // 挂不上监听就纯靠轮询
  }
  const deadline = Date.now() + timeoutMs;
  const poll = () => {
    if (finished) return;
    if (isReady()) {
      finish(null);
      return;
    }
    if (Date.now() >= deadline) {
      finish({
        success: false,
        error: 'Project is still loading (or failed to load). Please wait a few seconds and retry.'
      });
      return;
    }
    pollTimer = setTimeout(poll, 200);
  };
  poll();
});

/* SOLO 舞台控制：绿旗 = 重头运行；暂停/继续 = 直接停/启 VM 的帧循环
   （scratch-vm 的 FrameLoop，stop 后所有线程原样冻结，start 后接着跑）。 */
const handleSoloStageControl = (vm, action) => {
  try {
    if (action === 'greenFlag') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      vm.greenFlag();
      return { success: true, running: true };
    }
    if (action === 'pause') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running) {
        vm.runtime.frameLoop.stop();
      }
      return { success: true, running: false };
    }
    if (action === 'resume') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      return { success: true, running: true };
    }
    if (action === 'stop') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      vm.stopAll();
      return { success: true, running: false };
    }
    if (action === 'getState') {
      // "在运行" = 帧循环转着且还有活线程；stopAll 后线程清空，
      // 按此判断按钮能正确回到"未运行"档位
      const loopRunning = !!(vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running);
      const hasThreads = !!(vm.runtime && vm.runtime.threads && vm.runtime.threads.length > 0);
      return { success: true, running: loopRunning && hasThreads };
    }
    return { success: false, error: 'Unknown action: ' + action };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
};

const handleDetachedStageInput = (vm, inputData) => {
  try {
    if (inputData.type === 'mousedown' || inputData.type === 'mouseup' || inputData.type === 'mousemove') {
      const data = {
        x: inputData.x,
        y: inputData.y,
        canvasWidth: inputData.canvasWidth || 480,
        canvasHeight: inputData.canvasHeight || 360
      };
      if (inputData.type === 'mousedown') {
        data.isDown = true;
        data.button = inputData.button || 0;
      } else if (inputData.type === 'mouseup') {
        data.isDown = false;
        data.button = inputData.button || 0;
      }
      vm.postIOData('mouse', data);
    } else if (inputData.type === 'wheel') {
      vm.postIOData('mouseWheel', {
        deltaX: inputData.deltaX,
        deltaY: inputData.deltaY
      });
    } else if (inputData.type === 'keydown') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: true
      });
    } else if (inputData.type === 'keyup') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: false
      });
    }
  } catch (e) {
    // ignore
  }
};

const securityManager = {
  // Everything not specified here falls back to the scratch-gui security manager

  // Managed by Electron main process:
  canReadClipboard: () => true,
  canNotify: () => true,

  // Does not work in Electron:
  canGeolocate: () => false
};

const USERNAME_KEY = 'tw:username';
const DEFAULT_USERNAME = 'player';

// Schema mapping each Scratch opcode to its parameter layout.
// args: array of {name, kind} where kind is 'input' or 'field', in visual order.
// substack: true for C-shaped blocks; substack2: true for control_if_else.
// 每个 opcode 的参数布局，直接对齐 scratch-blocks 的 args0 定义（顺序、名称、字段/输入类型）。
// DSL 是位置式的：parseDslLine 产出的 token 按下标落到这里声明的槽位上，所以顺序错一位
// 就会把值写进相邻参数（例如 data_addtolist 真实顺序是 ITEM,LIST，写成 LIST,ITEM 会把
// 数字当成列表名）。这张表由 scripts/gen-opcode-schema.js 从 scratch-blocks 生成，勿手改顺序。
//   kind: input  普通输入槽，shadow 指明 Scratch 给它的默认影子块类型
//   kind: field  下拉/变量字段，值直接写进 block.fields
//   kind: menu   看着像下拉、实际是带菜单影子块的输入槽（可插入 reporter）
//   bool: true   布尔（六边形）输入，没有影子块
//   optionalBody: true  C 形块允许空 body（如单独的 control_stop "all"），不发 empty body 警告
// argument_reporter_* 是自定义积木的参数报告器：VALUE 是字段（参数名），不是输入槽。
const OPCODE_SCHEMA = {
  argument_reporter_boolean: { args: [{ name: 'VALUE', kind: 'field' }] },
  argument_reporter_string_number: { args: [{ name: 'VALUE', kind: 'field' }] },
  control_all_at_once: { args: [], substack: true },
  control_clear_counter: { args: [] },
  control_create_clone_of: { args: [{ name: 'CLONE_OPTION', kind: 'menu', shadow: 'control_create_clone_of_menu', menuField: 'CLONE_OPTION' }] },
  control_delete_this_clone: { args: [] },
  control_for_each: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_whole_number' }], substack: true },
  control_forever: { args: [], substack: true },
  control_get_counter: { args: [] },
  control_if: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  control_if_else: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true, substack2: true },
  control_incr_counter: { args: [] },
  control_repeat: { args: [{ name: 'TIMES', kind: 'input', shadow: 'math_whole_number' }], substack: true },
  control_repeat_until: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  control_start_as_clone: { args: [] },
  control_stop: { args: [{ name: 'STOP_OPTION', kind: 'field' }], substack: true, optionalBody: true },
  control_wait: { args: [{ name: 'DURATION', kind: 'input', shadow: 'math_positive_number' }] },
  control_wait_until: { args: [{ name: 'CONDITION', kind: 'input', bool: true }] },
  control_while: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  data_addtolist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'LIST', kind: 'field' }] },
  data_changevariableby: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  data_deletealloflist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_deleteoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_hidelist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_hidevariable: { args: [{ name: 'VARIABLE', kind: 'field' }] },
  data_insertatlist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_itemnumoflist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'LIST', kind: 'field' }] },
  data_itemoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_lengthoflist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_listcontainsitem: { args: [{ name: 'LIST', kind: 'field' }, { name: 'ITEM', kind: 'input', shadow: 'text' }] },
  data_replaceitemoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }, { name: 'ITEM', kind: 'input', shadow: 'text' }] },
  data_setvariableto: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'text' }] },
  data_showlist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_showvariable: { args: [{ name: 'VARIABLE', kind: 'field' }] },
  event_broadcast: { args: [{ name: 'BROADCAST_INPUT', kind: 'menu', shadow: 'event_broadcast_menu', menuField: 'BROADCAST_OPTION' }] },
  event_broadcastandwait: { args: [{ name: 'BROADCAST_INPUT', kind: 'menu', shadow: 'event_broadcast_menu', menuField: 'BROADCAST_OPTION' }] },
  event_whenbackdropswitchesto: { args: [{ name: 'BACKDROP', kind: 'field' }] },
  event_whenbroadcastreceived: { args: [{ name: 'BROADCAST_OPTION', kind: 'field' }] },
  event_whenflagclicked: { args: [] },
  event_whengreaterthan: { args: [{ name: 'WHENGREATERTHANMENU', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  event_whenkeypressed: { args: [{ name: 'KEY_OPTION', kind: 'field' }] },
  event_whenstageclicked: { args: [] },
  event_whenthisspriteclicked: { args: [] },
  looks_backdropnumbername: { args: [{ name: 'NUMBER_NAME', kind: 'field' }] },
  looks_changeeffectby: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_changesizeby: { args: [{ name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_changestretchby: { args: [{ name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_cleargraphiceffects: { args: [] },
  looks_costumenumbername: { args: [{ name: 'NUMBER_NAME', kind: 'field' }] },
  looks_goforwardbackwardlayers: { args: [{ name: 'FORWARD_BACKWARD', kind: 'field' }, { name: 'NUM', kind: 'input', shadow: 'math_integer' }] },
  looks_gotofrontback: { args: [{ name: 'FRONT_BACK', kind: 'field' }] },
  looks_hide: { args: [] },
  looks_nextbackdrop: { args: [] },
  looks_nextcostume: { args: [] },
  looks_say: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }] },
  looks_sayforsecs: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }, { name: 'SECS', kind: 'input', shadow: 'math_number' }] },
  looks_seteffectto: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  looks_setsizeto: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  looks_setstretchto: { args: [{ name: 'STRETCH', kind: 'input', shadow: 'math_number' }] },
  looks_show: { args: [] },
  looks_size: { args: [] },
  looks_switchbackdropto: { args: [{ name: 'BACKDROP', kind: 'menu', shadow: 'looks_backdrops', menuField: 'BACKDROP' }] },
  looks_switchbackdroptoandwait: { args: [{ name: 'BACKDROP', kind: 'menu', shadow: 'looks_backdrops', menuField: 'BACKDROP' }] },
  looks_switchcostumeto: { args: [{ name: 'COSTUME', kind: 'menu', shadow: 'looks_costume', menuField: 'COSTUME' }] },
  looks_think: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }] },
  looks_thinkforsecs: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }, { name: 'SECS', kind: 'input', shadow: 'math_number' }] },
  motion_changexby: { args: [{ name: 'DX', kind: 'input', shadow: 'math_number' }] },
  motion_changeyby: { args: [{ name: 'DY', kind: 'input', shadow: 'math_number' }] },
  motion_direction: { args: [] },
  motion_glidesecstoxy: { args: [{ name: 'SECS', kind: 'input', shadow: 'math_number' }, { name: 'X', kind: 'input', shadow: 'math_number' }, { name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_glideto: { args: [{ name: 'SECS', kind: 'input', shadow: 'math_number' }, { name: 'TO', kind: 'menu', shadow: 'motion_glideto_menu', menuField: 'TO' }] },
  motion_goto: { args: [{ name: 'TO', kind: 'menu', shadow: 'motion_goto_menu', menuField: 'TO' }] },
  motion_gotoxy: { args: [{ name: 'X', kind: 'input', shadow: 'math_number' }, { name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_ifonedgebounce: { args: [] },
  motion_movesteps: { args: [{ name: 'STEPS', kind: 'input', shadow: 'math_number' }] },
  motion_pointindirection: { args: [{ name: 'DIRECTION', kind: 'input', shadow: 'math_angle' }] },
  motion_pointtowards: { args: [{ name: 'TOWARDS', kind: 'menu', shadow: 'motion_pointtowards_menu', menuField: 'TOWARDS' }] },
  motion_setrotationstyle: { args: [{ name: 'STYLE', kind: 'field' }] },
  motion_setx: { args: [{ name: 'X', kind: 'input', shadow: 'math_number' }] },
  motion_sety: { args: [{ name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_turnleft: { args: [{ name: 'DEGREES', kind: 'input', shadow: 'math_number' }] },
  motion_turnright: { args: [{ name: 'DEGREES', kind: 'input', shadow: 'math_number' }] },
  motion_xposition: { args: [] },
  motion_yposition: { args: [] },
  operator_add: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_and: { args: [{ name: 'OPERAND1', kind: 'input', bool: true }, { name: 'OPERAND2', kind: 'input', bool: true }] },
  operator_contains: { args: [{ name: 'STRING1', kind: 'input', shadow: 'text' }, { name: 'STRING2', kind: 'input', shadow: 'text' }] },
  operator_divide: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_equals: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_gt: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_join: { args: [{ name: 'STRING1', kind: 'input', shadow: 'text' }, { name: 'STRING2', kind: 'input', shadow: 'text' }] },
  operator_length: { args: [{ name: 'STRING', kind: 'input', shadow: 'text' }] },
  operator_letter_of: { args: [{ name: 'LETTER', kind: 'input', shadow: 'math_whole_number' }, { name: 'STRING', kind: 'input', shadow: 'text' }] },
  operator_lt: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_mathop: { args: [{ name: 'OPERATOR', kind: 'field' }, { name: 'NUM', kind: 'input', shadow: 'math_number' }] },
  operator_mod: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_multiply: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_not: { args: [{ name: 'OPERAND', kind: 'input', bool: true }] },
  operator_or: { args: [{ name: 'OPERAND1', kind: 'input', bool: true }, { name: 'OPERAND2', kind: 'input', bool: true }] },
  operator_random: { args: [{ name: 'FROM', kind: 'input', shadow: 'math_number' }, { name: 'TO', kind: 'input', shadow: 'math_number' }] },
  operator_round: { args: [{ name: 'NUM', kind: 'input', shadow: 'math_number' }] },
  operator_subtract: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  pen_changePenColorParamBy: { args: [{ name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  pen_changePenSizeBy: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  pen_clear: { args: [] },
  pen_penDown: { args: [] },
  pen_penUp: { args: [] },
  pen_setPenColorParamTo: { args: [{ name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  pen_setPenColorToColor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }] },
  pen_setPenSizeTo: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  pen_stamp: { args: [] },
  sensing_answer: { args: [] },
  sensing_askandwait: { args: [{ name: 'QUESTION', kind: 'input', shadow: 'text' }] },
  sensing_coloristouchingcolor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }, { name: 'COLOR2', kind: 'input', shadow: 'colour_picker' }] },
  sensing_current: { args: [{ name: 'CURRENTMENU', kind: 'field' }] },
  sensing_dayssince2000: { args: [] },
  sensing_distanceto: { args: [{ name: 'DISTANCETOMENU', kind: 'menu', shadow: 'sensing_distancetomenu', menuField: 'DISTANCETOMENU' }] },
  sensing_keypressed: { args: [{ name: 'KEY_OPTION', kind: 'menu', shadow: 'sensing_keyoptions', menuField: 'KEY_OPTION' }] },
  sensing_loudness: { args: [] },
  sensing_mousedown: { args: [] },
  sensing_mousex: { args: [] },
  sensing_mousey: { args: [] },
  sensing_of: { args: [{ name: 'PROPERTY', kind: 'field' }, { name: 'OBJECT', kind: 'menu', shadow: 'sensing_of_object_menu', menuField: 'OBJECT' }] },
  sensing_resettimer: { args: [] },
  sensing_setdragmode: { args: [{ name: 'DRAG_MODE', kind: 'field' }] },
  sensing_timer: { args: [] },
  sensing_touchingcolor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }] },
  sensing_touchingobject: { args: [{ name: 'TOUCHINGOBJECTMENU', kind: 'menu', shadow: 'sensing_touchingobjectmenu', menuField: 'TOUCHINGOBJECTMENU' }] },
  sensing_username: { args: [] },
  sound_changeeffectby: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  sound_changevolumeby: { args: [{ name: 'VOLUME', kind: 'input', shadow: 'math_number' }] },
  sound_cleareffects: { args: [] },
  sound_play: { args: [{ name: 'SOUND_MENU', kind: 'menu', shadow: 'sound_sounds_menu', menuField: 'SOUND_MENU' }] },
  sound_playuntildone: { args: [{ name: 'SOUND_MENU', kind: 'menu', shadow: 'sound_sounds_menu', menuField: 'SOUND_MENU' }] },
  sound_seteffectto: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  sound_setvolumeto: { args: [{ name: 'VOLUME', kind: 'input', shadow: 'math_number' }] },
  sound_stopallsounds: { args: [] },
  sound_volume: { args: [] },
};

// 值原语（value primitive）：这些 opcode 本质是字面量/变量/列表取值器，只能出现在
// 参数槽里，不是可独立执行的积木。出现在 DSL 行首会被 validateParsedScript 拒绝；
// 出现在参数位置（如 (math_number 5)、(data_variable $x)）会被 argToInputValue 折叠成字面量。
const VALUE_PRIMITIVE_OPCODES = { math_number:1, math_integer:1, math_whole_number:1, math_positive_number:1, math_angle:1, text:1, colour_picker:1, note:1, matrix:1, data_variable:1, data_listcontents:1 };

// Tokenize a string of positional arguments into parsed values.
// Handles: numbers, double-quoted strings, $variables, @lists, and (opcode args...) nested reporters.
function tokenizeArgs(argsStr) {
  const args = [];
  const s = String(argsStr == null ? '' : argsStr);
  const n = s.length;
  let i = 0;
  const isWhitespace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  // Read a double-quoted string starting at s[i] === '"'; returns [value, nextIndex].
  // Escapes: \" \\ \n \r \t. Unknown escapes keep the backslash literally.
  const readString = (s, i) => {
    let j = i + 1; // skip opening quote
    let str = '';
    while (j < n) {
      if (s[j] === '\\' && j + 1 < n) {
        const esc = s[j + 1];
        if (esc === '"' || esc === '\\') {
          str += esc; // unescape \" -> " and \\ -> \
          j += 2;
          continue;
        }
        if (esc === 'n') { str += '\n'; j += 2; continue; }
        if (esc === 'r') { str += '\r'; j += 2; continue; }
        if (esc === 't') { str += '\t'; j += 2; continue; }
      }
      if (s[j] === '"') break;
      str += s[j];
      j++;
    }
    if (j >= n) {
      throw new Error('Unclosed string literal: "' + str + '"');
    }
    return [str, j + 1]; // past the closing quote
  };
  while (i < n) {
    while (i < n && isWhitespace(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"') {
      let str;
      [str, i] = readString(s, i);
      args.push(str);
    } else if (ch === '(') {
      i++; // skip opening paren
      let depth = 1;
      let inner = '';
      while (i < n && depth > 0) {
        if (s[i] === '"') {
          // consume a quoted string verbatim so parens inside it don't affect depth
          inner += s[i]; i++;
          while (i < n) {
            if (s[i] === '\\' && i + 1 < n && (s[i+1] === '"' || s[i+1] === '\\')) {
              inner += s[i]; inner += s[i+1]; i += 2; continue;
            }
            if (s[i] === '"') break;
            inner += s[i]; i++;
          }
          if (i < n) { inner += s[i]; i++; } // closing quote
        } else if (s[i] === '(') {
          depth++; inner += s[i]; i++;
        } else if (s[i] === ')') {
          depth--;
          if (depth === 0) { i++; break; }
          inner += s[i]; i++;
        } else {
          inner += s[i]; i++;
        }
      }
      if (depth > 0) {
        throw new Error('Unbalanced parentheses in: ' + s.substring(Math.max(0, i - 20), i));
      }
      // inner = "opcode args..."
      let subOpcode, subArgsStr;
      const wsMatch = inner.match(/\s/);
      if (wsMatch === null) {
        subOpcode = inner;
        subArgsStr = '';
      } else {
        const wsIdx = wsMatch.index;
        subOpcode = inner.substring(0, wsIdx);
        subArgsStr = inner.substring(wsIdx + 1);
      }
      args.push({ opcode: subOpcode, args: tokenizeArgs(subArgsStr) });
    } else if (ch === '$') {
      i++; // skip $
      if (s[i] === '"') {
        let name;
        [name, i] = readString(s, i);
        args.push({ variable: name });
      } else {
        let name = '';
        while (i < n && !isWhitespace(s[i])) name += s[i], i++;
        args.push({ variable: name });
      }
    } else if (ch === '@') {
      i++; // skip @
      if (s[i] === '"') {
        let name;
        [name, i] = readString(s, i);
        args.push({ list: name });
      } else {
        let name = '';
        while (i < n && !isWhitespace(s[i])) name += s[i], i++;
        args.push({ list: name });
      }
    } else if (ch === '%') {
      // define 体内的参数引用：%名称 → {argument: 名称}，由 argToInputValue
      // 折叠成 argument_reporter_* 描述符（类型按最近 define 的参数表翻转）。
      i++; // skip %
      let name = '';
      while (i < n && !isWhitespace(s[i])) name += s[i], i++;
      args.push({ argument: name });
    } else {
      // number or bareword: read until whitespace
      let token = '';
      while (i < n && !isWhitespace(s[i])) token += s[i], i++;
      if (/^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(token)) {
        args.push(parseFloat(token));
      } else {
        args.push(token);
      }
    }
  }
  return args;
}

// Convert a raw token (from tokenizeArgs) into an input value, applying variable/list/nested-reporter rules.
function argToInputValue(val, runtime) {
  if (val && typeof val === 'object') {
    if (val.variable) {
      return { opcode: 'data_variable', fields: { VARIABLE: val.variable } };
    }
    if (val.list) {
      return { opcode: 'data_listcontents', fields: { LIST: val.list } };
    }
    if (val.argument !== undefined) {
      // %参数：默认按字符串/数字报告器产出；类型翻转（bool → argument_reporter_boolean）
      // 与越界引用报错由 parseScratchDSL 的树遍历（applyArgumentRefs）完成。
      return { opcode: 'argument_reporter_string_number', fields: { VALUE: val.argument } };
    }
    if (val.opcode && VALUE_PRIMITIVE_OPCODES[val.opcode]) {
      // 值原语出现在参数位置：折叠成字面量（{variable}/{list} 简写、字符串或数字）
      // 直接返回，走常规 shadow 构建；不能保留 opcode 形态，否则会被
      // validateParsedScript 当成"值原语不是积木"拒绝，也会展开成残缺积木。
      const primArgs = Array.isArray(val.args) ? val.args : [];
      const prim0 = primArgs.length > 0 ? primArgs[0] : undefined;
      if (val.opcode === 'data_variable') {
        if (prim0 && typeof prim0 === 'object' && prim0.variable) return prim0;
        return { variable: prim0 == null ? '' : String(prim0) };
      }
      if (val.opcode === 'data_listcontents') {
        if (prim0 && typeof prim0 === 'object' && prim0.list) return prim0;
        return { list: prim0 == null ? '' : String(prim0) };
      }
      if (val.opcode === 'text' || val.opcode === 'colour_picker' ||
          val.opcode === 'note' || val.opcode === 'matrix') {
        return prim0 == null ? '' : String(prim0);
      }
      // math_*：trim 后可解析为数字则取数字，否则归 0
      const trimmed = String(prim0 == null ? '' : prim0).trim();
      const num = Number(trimmed);
      return trimmed !== '' && !isNaN(num) ? num : 0;
    }
    if (val.opcode) {
      return mapArgsToDescriptor(val.opcode, val.args, runtime);
    }
  }
  return val; // number or string
}

// Map an opcode + positional raw args to a block descriptor {opcode, inputs, fields}.
function mapArgsToDescriptor(opcode, rawArgs, runtime) {
  const schema = resolveBlockSchema(opcode, runtime);
  const inputs = {};
  const fields = {};
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  if (schema) {
    for (let i = 0; i < args.length; i++) {
      const argDef = schema.args[i];
      const val = args[i];
      if (!argDef) {
        inputs['ARG' + (i + 1)] = argToInputValue(val);
        continue;
      }
      if (argDef.kind === 'field') {
        if (val && typeof val === 'object') {
          if (val.variable && argDef.name === 'VARIABLE') {
            fields[argDef.name] = val.variable;
          } else if (val.list && argDef.name === 'LIST') {
            fields[argDef.name] = val.list;
          } else if (val.opcode) {
            inputs[argDef.name] = argToInputValue(val);
          } else {
            fields[argDef.name] = String(val);
          }
        } else {
          fields[argDef.name] = String(val);
        }
      } else {
        inputs[argDef.name] = argToInputValue(val);
      }
    }
  } else {
    for (let i = 0; i < args.length; i++) {
      inputs['ARG' + (i + 1)] = argToInputValue(args[i]);
    }
  }
  return { opcode, inputs, fields };
}

// Parse a single DSL line (already trimmed) into {opcode, args} where args is the raw token array.
// runtime 仅用于调用链统一透传（词法解析本身不依赖 schema）。
function parseDslLine(content, runtime) {
  void runtime;
  const wsMatch = content.match(/\s/);
  if (wsMatch === null) {
    return { opcode: content, args: [] };
  }
  const wsIdx = wsMatch.index;
  const opcode = content.substring(0, wsIdx);
  const argsStr = content.substring(wsIdx + 1);
  return { opcode, args: tokenizeArgs(argsStr) };
}

const isDefineLine = content => content === 'define' || content.indexOf('define ') === 0;
const isCallLine = content => content === 'call' || content.indexOf('call ') === 0;

// Parse a define hat line: `define walk (steps) <fast> warp=true`.
// 扫描规则：bareword → proccode 字面词；(名) → 文本参数（%s）；<名> → 布尔参数（%b）；
// warp=true|false 是标记，不进 proccode。proccode 按出现顺序用单空格连接。
// 返回树节点形态（与 body 节点同构），解析错误直接抛出（applyDslTextToTarget 统一捕获）。
function parseDefineLine(content, lineNo) {
  const rest = content.substring('define'.length);
  const proccodeParts = [];
  const argNames = [];
  const argTypes = [];
  let warp = false;
  let i = 0;
  const n = rest.length;
  const fail = msg => { throw new Error('line ' + lineNo + ': ' + msg); };
  while (i < n) {
    while (i < n && /\s/.test(rest[i])) i++;
    if (i >= n) break;
    const ch = rest[i];
    if (ch === '(' || ch === '<') {
      const isBool = ch === '<';
      const close = isBool ? '>' : ')';
      i++;
      let name = '';
      while (i < n && rest[i] !== close) { name += rest[i]; i++; }
      if (i >= n) fail('define 参数括号未闭合：' + ch + name);
      i++; // skip close
      if (name.trim() === '') fail('define 参数名不能为空：' + (isBool ? '<名称>' : '(名称)'));
      argNames.push(name);
      argTypes.push(isBool ? 'bool' : 'string');
      proccodeParts.push(isBool ? '%b' : '%s');
    } else {
      let word = '';
      while (i < n && !/\s/.test(rest[i])) { word += rest[i]; i++; }
      const warpMatch = word.match(/^warp=(true|false)$/);
      if (warpMatch) {
        warp = warpMatch[1] === 'true';
      } else {
        proccodeParts.push(word);
      }
    }
  }
  if (proccodeParts.length === 0) {
    fail('define 后必须有过程名（例如 define walk (steps) <fast>）');
  }
  return {
    opcode: 'procedures_definition',
    proc: { proccode: proccodeParts.join(' '), argNames, argTypes, warp },
    rawArgs: [],
    indent: 0,
    substack: [],
    substack2: [],
    lineNo
  };
}

// Parse a call line: `call "walk %s %b" 10 (operator_gt (sensing_timer) 5)`.
// call 后第一个 token 必须是加引号的原始 proccode（含 %s/%b 占位符）；
// 其余 token 按占位符顺序填充参数，原样保留到构建阶段再解析。
function parseCallLine(content, lineNo) {
  const rest = content.substring('call'.length);
  const firstChar = rest.match(/\S/);
  if (!firstChar || firstChar[0] !== '"') {
    throw new Error('line ' + lineNo + ': call 后第一个参数必须是加引号的 proccode（例如 call "walk %s" 10）');
  }
  const tokens = tokenizeArgs(rest);
  if (tokens.length === 0 || typeof tokens[0] !== 'string') {
    throw new Error('line ' + lineNo + ': call 后第一个参数必须是加引号的 proccode（例如 call "walk %s" 10）');
  }
  return {
    opcode: 'procedures_call',
    proccode: tokens[0],
    callArgs: tokens.slice(1),
    rawArgs: [],
    indent: 0,
    substack: [],
    substack2: [],
    lineNo
  };
}

// Convert a tree node (with rawArgs and child node arrays) into a block descriptor with substack/substack2.
function convertNode(node, runtime) {
  let descriptor;
  if (node.opcode === 'procedures_definition') {
    descriptor = { opcode: node.opcode, inputs: {}, fields: {}, proc: node.proc };
  } else if (node.opcode === 'procedures_call') {
    // callArgs 原样保留（原始 token），procedures_call 的输入在构建阶段按注册表解析
    descriptor = { opcode: node.opcode, inputs: {}, fields: {}, proccode: node.proccode, callArgs: node.callArgs };
  } else {
    descriptor = mapArgsToDescriptor(node.opcode, node.rawArgs, runtime);
  }
  if (node.lineNo !== undefined) descriptor.lineNo = node.lineNo;
  if (node.substack && node.substack.length > 0) {
    descriptor.substack = node.substack.map(child => convertNode(child, runtime));
  }
  if (node.substack2 && node.substack2.length > 0) {
    descriptor.substack2 = node.substack2.map(child => convertNode(child, runtime));
  }
  return descriptor;
}

// define 参数表 → {参数名: 'string'|'bool'}，供 %参数 类型翻转使用。
function procParamMap(proc) {
  const map = {};
  const names = (proc && proc.argNames) || [];
  const types = (proc && proc.argTypes) || [];
  names.forEach((nm, idx) => { map[nm] = types[idx] === 'bool' ? 'bool' : 'string'; });
  return map;
}

// 遍历描述符树（含 substack/substack2 与嵌套 reporter 描述符）：把 {argument} 生成的
// argument_reporter_string_number 按最近 define 的参数类型翻转成 boolean；不在任何
// define 参数表里的 %引用 记错误（仍保留 string_number 描述符，让构建有据可依）。
function applyArgumentRefs(desc, procMap, errors) {
  if (!desc || typeof desc !== 'object' || !desc.opcode) return;
  let map = procMap;
  if (desc.opcode === 'procedures_definition') {
    map = procParamMap(desc.proc);
  }
  const lineNo = desc.lineNo;
  Object.keys(desc.inputs || {}).forEach(key => {
    const v = desc.inputs[key];
    if (!v || typeof v !== 'object' || !v.opcode) return;
    if (v.opcode === 'argument_reporter_string_number' || v.opcode === 'argument_reporter_boolean') {
      const f = v.fields && v.fields.VALUE;
      // argToInputValue 产出的是裸字符串（{VALUE: 'steps'}），构建期才展开成字段对象
      const nm = f && typeof f === 'object' ? f.value : f;
      if (map && Object.prototype.hasOwnProperty.call(map, nm)) {
        if (map[nm] === 'bool' && v.opcode !== 'argument_reporter_boolean') {
          desc.inputs[key] = { opcode: 'argument_reporter_boolean', fields: { VALUE: nm } };
        }
      } else {
        errors.push('line ' + (lineNo === undefined ? '?' : lineNo) + ': %' + nm +
          ' 不在最近的 define 参数列表中（%参数只能在 define 体内引用）');
      }
      return;
    }
    applyArgumentRefs(v, map, errors);
  });
  (desc.substack || []).forEach(s => applyArgumentRefs(s, map, errors));
  (desc.substack2 || []).forEach(s => applyArgumentRefs(s, map, errors));
}

// Convert a JSON block object (e.g. {"opcode":"...","inputs":{},"next":{...}}) to DSL text lines.
// IMPORTANT: the DSL is positional — parseDslLine/mapArgsToDescriptor map tokens onto
// OPCODE_SCHEMA[opcode].args by index. So arguments must be emitted in schema order,
// not "all inputs then all fields". Emitting them out of order silently swaps values
// between slots (e.g. data_setvariableto would take the number as VARIABLE and the
// variable name as VALUE, creating a bogus variable named after the value).
// Resolve a VARIABLE / LIST field to a real VM variable descriptor.
// The VM binds a block's variable field by ID: if the id is missing/unknown, Scratch
// auto-creates a *local* variable on the sprite named after whatever it finds, which is
// how a stray variable named after a value ends up on the sprite. So look the name up
// (local first, then stage) and create the variable when it genuinely does not exist,
// always returning a concrete id.
function resolveVariableField(target, key, rawName) {
  const isList = key === 'LIST';
  const type = isList ? 'list' : '';
  const name = String(rawName == null ? '' : rawName);
  let variable = target.lookupVariableByNameAndType(name, type);
  if (!variable) {
    // Prefer creating globals on the stage so every sprite can see them, matching
    // how users normally declare variables in the editor.
    const stage = target.runtime && target.runtime.getTargetForStage ? target.runtime.getTargetForStage() : null;
    const owner = stage || target;
    const newId = 'aivar_' + Math.random().toString(36).slice(2, 10);
    if (isList) {
      owner.createVariable(newId, name, 'list');
    } else {
      owner.createVariable(newId, name, '');
    }
    variable = owner.lookupVariableByNameAndType(name, type) || { id: newId, name: name };
  }
  return { name: key, value: variable.name, id: variable.id, variableType: type };
}

// Resolve a broadcast message name to a real broadcast variable descriptor.
// Broadcast blocks bind by id just like variables; an id-less BROADCAST_OPTION renders
// blank and never fires, so create the message when it is genuinely new.
function resolveBroadcastField(target, rawName) {
  const name = String(rawName == null ? '' : rawName) || 'message1';
  const stage = target.runtime && target.runtime.getTargetForStage
    ? target.runtime.getTargetForStage()
    : null;
  const owner = stage || target;
  let msg = owner.lookupBroadcastByInputValue ? owner.lookupBroadcastByInputValue(name) : null;
  if (!msg) {
    const newId = 'aibcast_' + Math.random().toString(36).slice(2, 10);
    owner.createVariable(newId, name, 'broadcast_msg');
    msg = (owner.lookupBroadcastByInputValue && owner.lookupBroadcastByInputValue(name)) ||
      { id: newId, name: name };
  }
  return { name: 'BROADCAST_OPTION', value: msg.name, id: msg.id, variableType: 'broadcast_msg' };
}

// Which field carries the literal value inside each primitive shadow block.
const SHADOW_VALUE_FIELD = {
  math_number: 'NUM',
  math_integer: 'NUM',
  math_whole_number: 'NUM',
  math_positive_number: 'NUM',
  math_angle: 'NUM',
  text: 'TEXT',
  colour_picker: 'COLOUR',
  note: 'NOTE',
  matrix: 'MATRIX'
};

// 扩展积木动态 schema：OPCODE_SCHEMA 只覆盖核心积木，音乐/翻译等扩展积木的参数
// 布局要从 runtime._blockInfo（scratch-vm 注册扩展时生成的 scratch-blocks JSON）
// 现场推导。按 runtime 缓存命中结果（WeakMap<runtime, Map<opcode, schema>>）；
// 只缓存命中的 opcode——扩展可能稍后加载，未命中的下次必须重查。
const dynamicSchemaCache = new WeakMap();

// 把 runtime._blockInfo 里的一项块定义（{info, json}）转成与 OPCODE_SCHEMA 同构的
// schema：args 按 json.args0 的视觉顺序排列，substack/substack2 对齐 C 形分支。
function buildSchemaFromExtensionEntry(entry, category) {
  const args0 = Array.isArray(entry.json.args0) ? entry.json.args0 : [];
  const argInfoMap = (entry.info && entry.info.arguments) || {};
  const args = [];
  const schema = { args: args, dynamic: true };
  for (let i = 0; i < args0.length; i++) {
    const argJson = args0[i];
    const name = argJson && argJson.name;
    const type = argJson && argJson.type;
    if (!name) continue; // field_image / field_vertical_separator 等图标项没有 name
    if (type === 'input_value') {
      const argInfo = argInfoMap[name] || {};
      const argDef = { name: name, kind: 'input' };
      if (argInfo.menu && category && category.menuInfo && category.menuInfo[argInfo.menu] &&
          category.menuInfo[argInfo.menu].acceptReporters) {
        // 扩展菜单且接受报告器：输入槽 + 菜单影子块，与核心积木的 menu 形态一致
        // （影子块 id 与 scratch-vm _makeExtensionMenuId 的 `${id}_menu_${name}` 对齐）。
        argDef.kind = 'menu';
        argDef.shadow = (category.id || '') + '_menu_' + argInfo.menu;
        argDef.menuField = argInfo.menu;
      } else {
        switch (argInfo.type) {
          case 'Boolean':
            argDef.bool = true;
            break;
          case 'color':
            argDef.shadow = 'colour_picker';
            break;
          case 'angle':
            argDef.shadow = 'math_angle';
            break;
          case 'number':
            argDef.shadow = 'math_number';
            break;
          default:
            // 'string'、'note'、'matrix'、缺省都按文本影子处理
            argDef.shadow = 'text';
            break;
        }
        if (!argInfo.type && argJson.check === 'Boolean') {
          // info.arguments 缺失时退回 args0 的 check 标记（六边形布尔输入）
          delete argDef.shadow;
          argDef.bool = true;
        }
      }
      args.push(argDef);
    } else if (type === 'input_boolean') {
      args.push({ name: name, kind: 'input', bool: true });
    } else if (type === 'input_statement') {
      if (name === 'SUBSTACK') schema.substack = true;
      else if (name === 'SUBSTACK2') schema.substack2 = true;
      // 其它名字的子栈 DSL 无法表示，忽略
    } else if (type === 'field_dropdown' || type === 'field_number' || type === 'field_angle' ||
               type === 'field_colour' || type === 'field_text' || type === 'field_checkbox') {
      // 扩展的下拉/数值等字段直接存值（没有独立菜单块），走 block.fields
      args.push({ name: name, kind: 'field' });
    }
    // field_image / field_variable 等其它类型 → 忽略
  }
  return schema;
}

/**
 * Resolve a block's parameter schema: OPCODE_SCHEMA for core blocks, or a schema
 * derived on demand from runtime._blockInfo for loaded extension blocks.
 * Returns null when the opcode is unknown (no runtime, or extension not loaded).
 */
function resolveBlockSchema(opcode, runtime) {
  if (OPCODE_SCHEMA[opcode]) return OPCODE_SCHEMA[opcode];
  if (!runtime || !Array.isArray(runtime._blockInfo)) return null;
  let cache = dynamicSchemaCache.get(runtime);
  if (cache && cache.has(opcode)) return cache.get(opcode);
  let derived = null;
  for (let ci = 0; ci < runtime._blockInfo.length && !derived; ci++) {
    const category = runtime._blockInfo[ci];
    const blocks = category && category.blocks;
    if (!Array.isArray(blocks)) continue;
    for (let bi = 0; bi < blocks.length; bi++) {
      const entry = blocks[bi];
      // 按钮/分隔线等项没有 json；scratch-vm 把 opcode 放在 json.type（容错 json.opcode）
      if (!entry || !entry.json) continue;
      if ((entry.json.opcode || entry.json.type) !== opcode) continue;
      derived = buildSchemaFromExtensionEntry(entry, category);
      break;
    }
  }
  if (!derived) return null; // 未命中不缓存：扩展可能稍后加载
  if (!cache) {
    cache = new Map();
    dynamicSchemaCache.set(runtime, cache);
  }
  cache.set(opcode, derived);
  return derived;
}

function schemaArgFor(opcode, inputName, runtime) {
  const schema = resolveBlockSchema(opcode, runtime);
  if (!schema || !Array.isArray(schema.args)) return null;
  for (let i = 0; i < schema.args.length; i++) {
    if (schema.args[i].name === inputName) return schema.args[i];
  }
  return null;
}

// Scratch's colour_picker field stores '#rrggbb'. Models often pass the decimal form
// used by the sb3 format (16711680), which would otherwise render as literal text.
function toHexColor(value) {
  if (typeof value === 'number' && isFinite(value)) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(value)));
    return '#' + ('000000' + n.toString(16)).slice(-6);
  }
  const str = String(value == null ? '' : value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return str.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(str)) {
    return '#' + str[1] + str[1] + str[2] + str[2] + str[3] + str[3];
  }
  if (/^[0-9a-fA-F]{6}$/.test(str)) return '#' + str.toLowerCase();
  const asNum = Number(str);
  if (str !== '' && !isNaN(asNum)) return toHexColor(asNum);
  return '#0000ff';
}

function newAiBlockId() {
  return '_ai_' + Math.random().toString(36).substr(2, 9);
}

// ── 自定义积木（procedures_definition / procedures_call）注册表 ──
// proccode → {argIds, argNames, argTypes, warp}。call 与 define 之间的参数槽
// 靠 argumentids 对齐，构建时必须用注册表里的 id，不能两边各自生成。

/**
 * 扫描 target 现有积木中的 procedures_prototype，解析 mutation 组成注册表。
 * mutation 里的三个数组字段（argumentids/argumentnames/argumentdefaults）是
 * JSON 字符串；%s/%b 顺序无法从字段直接得知，用 proccode 中占位符出现顺序与
 * argumentnames 按下标对齐推导 argTypes。
 */
function collectProcRegistry(target) {
  const registry = new Map();
  const blocks = target && target.blocks && target.blocks._blocks ? target.blocks._blocks : {};
  Object.keys(blocks).forEach(id => {
    const b = blocks[id];
    if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) return;
    const proccode = b.mutation.proccode;
    if (typeof proccode !== 'string') return;
    let argIds = [];
    let argNames = [];
    try { argIds = JSON.parse(b.mutation.argumentids || '[]'); } catch (e) { argIds = []; }
    try { argNames = JSON.parse(b.mutation.argumentnames || '[]'); } catch (e) { argNames = []; }
    if (!Array.isArray(argIds)) argIds = [];
    if (!Array.isArray(argNames)) argNames = [];
    const placeholders = proccode.match(/%[sb]/g) || [];
    registry.set(proccode, {
      argIds,
      argNames,
      argTypes: placeholders.map(ph => (ph === '%b' ? 'bool' : 'string')),
      warp: b.mutation.warp === 'true' || b.mutation.warp === true
    });
  });
  return registry;
}

/** 把解析得到的文本 define 登记进注册表：每个参数分配一个新 id。 */
function registerTextDefines(registry, defines) {
  (defines || []).forEach(proc => {
    registry.set(proc.proccode, {
      argIds: (proc.argNames || []).map(() => newAiBlockId()),
      argNames: proc.argNames || [],
      argTypes: proc.argTypes || [],
      warp: !!proc.warp
    });
  });
}

/**
 * 构建用的注册表：优先 parsed.procRegistry（applyDslTextToTarget 已把文本 define
 * 合并进去）；否则 fallback 到 VM 现有 define + 本段 parsed.defines——保证 AI 助手
 * 单脚本路径（parseScratchDSL → validateParsedScript → buildScriptBlocks）可用。
 */
function procRegistryForParsed(parsed, target) {
  if (parsed && parsed.procRegistry) return parsed.procRegistry;
  const registry = collectProcRegistry(target);
  registerTextDefines(registry, parsed ? parsed.defines : null);
  return registry;
}

/**
 * Create the shadow block occupying one input slot, choosing its type from OPCODE_SCHEMA
 * rather than from the JavaScript type of the value.
 *
 * The distinction is not cosmetic: `motion_pointindirection` needs a math_angle dial,
 * `sensing_touchingcolor` a colour_picker, `control_repeat` a whole-number field,
 * `sound_play` a sound dropdown, and `event_broadcast` a broadcast menu bound to a real
 * message id. Filling every slot with math_number/text yields blocks that look wrong and,
 * for menus and broadcasts, do not work at all.
 *
 * @returns {[object|null, object]} [shadow block to create (or null), input reference]
 */
function createInputShadow(target, parentId, opcode, inputName, value) {
  const argDef = schemaArgFor(opcode, inputName, target && target.runtime);

  const mkShadow = (shadowOpcode, fields) => {
    const sid = newAiBlockId();
    return [
      {
        id: sid, opcode: shadowOpcode, fields: fields, inputs: {},
        next: null, parent: parentId, shadow: true, topLevel: false, x: 0, y: 0
      },
      { name: inputName, block: sid, shadow: sid }
    ];
  };

  // Variable / list reporters requested explicitly as {VARIABLE: n} / {LIST: n}
  if (value && typeof value === 'object' && value.VARIABLE !== undefined) {
    return mkShadow('data_variable', { VARIABLE: resolveVariableField(target, 'VARIABLE', value.VARIABLE) });
  }
  if (value && typeof value === 'object' && value.LIST !== undefined) {
    return mkShadow('data_listcontents', { LIST: resolveVariableField(target, 'LIST', value.LIST) });
  }
  // 同上的小写形态：argToInputValue 把嵌套的值原语（如 (data_variable $x)）折叠成的字面量简写
  if (value && typeof value === 'object' && value.variable !== undefined) {
    return mkShadow('data_variable', { VARIABLE: resolveVariableField(target, 'VARIABLE', value.variable) });
  }
  if (value && typeof value === 'object' && value.list !== undefined) {
    return mkShadow('data_listcontents', { LIST: resolveVariableField(target, 'LIST', value.list) });
  }

  // Boolean (hexagonal) slots hold no shadow in Scratch; an empty condition is legal and
  // reads as false. A text shadow there breaks the block's shape.
  if (argDef && argDef.bool) {
    return [null, { name: inputName, block: null, shadow: null }];
  }

  // Menu-backed input: dropdown appearance, real input slot underneath.
  if (argDef && argDef.kind === 'menu') {
    if (argDef.shadow === 'event_broadcast_menu') {
      return mkShadow('event_broadcast_menu', { BROADCAST_OPTION: resolveBroadcastField(target, value) });
    }
    const menuField = argDef.menuField || inputName;
    return mkShadow(argDef.shadow, {
      [menuField]: { name: menuField, value: String(value == null ? '' : value), id: undefined }
    });
  }

  const shadowType = (argDef && argDef.shadow) || null;
  if (shadowType === 'colour_picker') {
    return mkShadow('colour_picker', { COLOUR: { name: 'COLOUR', value: toHexColor(value), id: undefined } });
  }
  if (shadowType && SHADOW_VALUE_FIELD[shadowType] && shadowType !== 'text') {
    const fieldName = SHADOW_VALUE_FIELD[shadowType];
    const num = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    // A numeric slot given non-numeric text means the model put a string where Scratch
    // expects a number; keep it visible in a text shadow instead of silently zeroing it.
    if (isFinite(num) && String(value).trim() !== '') {
      return mkShadow(shadowType, { [fieldName]: { name: fieldName, value: num, id: undefined } });
    }
    return mkShadow('text', { TEXT: { name: 'TEXT', value: String(value == null ? '' : value), id: undefined } });
  }

  if (typeof value === 'number') {
    return mkShadow('math_number', { NUM: { name: 'NUM', value: value, id: undefined } });
  }
  if (typeof value === 'boolean') {
    return mkShadow('text', { TEXT: { name: 'TEXT', value: value ? 'true' : 'false', id: undefined } });
  }
  if (value === null || value === undefined) {
    return [null, { name: inputName, block: null, shadow: null }];
  }
  return mkShadow('text', { TEXT: { name: 'TEXT', value: String(value), id: undefined } });
}

/**
 * Turn a block descriptor tree into flat VM block records appended to `allBlocks`.
 * Handles nested reporters, SUBSTACK/SUBSTACK2 (array or single descriptor), `next`
 * chaining, menu/variable/broadcast fields, and parent wiring.
 * @param {object} procRegistry optional custom-procedure registry (proccode → {argIds,...});
 *        required when the tree contains procedures_definition / procedures_call
 * @returns {string|null} id of the created block
 */
function buildBlockStructure(scriptObj, target, allBlocks, procRegistry) {
  if (!scriptObj || !scriptObj.opcode) return null;
  const blockId = newAiBlockId();
  const inputs = {};
  const rawInputs = scriptObj.inputs || {};

  if (scriptObj.opcode === 'procedures_call') {
    // call 的输入键是 argumentid、带 mutation，构建形态与普通块差异太大，单独走。
    return buildProcedureCall(scriptObj, target, allBlocks, procRegistry);
  }

  if (scriptObj.opcode === 'procedures_definition') {
    // define hat：prototype shadow 挂在 custom_block 输入上（shadow:true, parent=definition），
    // 参数槽 id 用注册表里的，不得重新生成；身体由 buildScriptBlocks 的 next 链处理。
    const proc = scriptObj.proc || {};
    const entry = procRegistry ? procRegistry.get(proc.proccode) : null;
    if (!entry) return null;
    const protoId = newAiBlockId();
    const argDefaults = (entry.argTypes || []).map(t => (t === 'bool' ? 'false' : ''));
    allBlocks.push({
      id: protoId,
      opcode: 'procedures_prototype',
      inputs: {},
      fields: {},
      next: null,
      parent: blockId,
      shadow: true,
      topLevel: false,
      x: 0,
      y: 0,
      // mutation 的三个数组字段是 JSON 字符串；children 必须存在（mutationToXML 会遍历）
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode: proc.proccode,
        argumentids: JSON.stringify(entry.argIds || []),
        argumentnames: JSON.stringify(entry.argNames || []),
        argumentdefaults: JSON.stringify(argDefaults),
        warp: entry.warp ? 'true' : 'false'
      }
    });
    inputs.custom_block = { name: 'custom_block', block: protoId, shadow: protoId };
  }

  Object.keys(rawInputs).forEach(key => {
    if (key === 'SUBSTACK' || key === 'SUBSTACK2') return; // handled after the block exists
    const val = rawInputs[key];
    if (val && typeof val === 'object' && val.opcode) {
      const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[key] = { name: key, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = blockId;
      }
      return;
    }
    const [shadowBlock, inputRef] = createInputShadow(target, blockId, scriptObj.opcode, key, val);
    if (shadowBlock) allBlocks.push(shadowBlock);
    if (inputRef && inputRef.block) inputs[key] = inputRef;
  });

  const fields = {};
  if (scriptObj.fields) {
    Object.keys(scriptObj.fields).forEach(key => {
      const argDef = schemaArgFor(scriptObj.opcode, key, target && target.runtime);
      const raw = scriptObj.fields[key];
      // A model may place a menu value under `fields` even though Scratch models it as an
      // input slot; route it through the shadow path so the block still renders correctly.
      if (argDef && argDef.kind === 'menu') {
        const [shadowBlock, inputRef] = createInputShadow(target, blockId, scriptObj.opcode, key, raw);
        if (shadowBlock) allBlocks.push(shadowBlock);
        if (inputRef && inputRef.block) inputs[key] = inputRef;
        return;
      }
      if (key === 'VARIABLE') { fields[key] = resolveVariableField(target, 'VARIABLE', raw); return; }
      if (key === 'LIST') { fields[key] = resolveVariableField(target, 'LIST', raw); return; }
      if (key === 'BROADCAST_OPTION') { fields[key] = resolveBroadcastField(target, raw); return; }
      fields[key] = { name: key, value: String(raw), id: undefined };
    });
  }

  const blockDef = {
    id: blockId, opcode: scriptObj.opcode, next: null, parent: null,
    inputs: inputs, fields: fields, shadow: false, topLevel: false, x: 0, y: 0
  };
  allBlocks.push(blockDef);

  const subSource = scriptObj.substack || rawInputs.SUBSTACK;
  if (subSource) {
    const arr = Array.isArray(subSource) ? subSource : [subSource];
    const substackId = buildSubstackChain(arr, target, allBlocks, blockId, procRegistry);
    if (substackId) blockDef.inputs.SUBSTACK = { name: 'SUBSTACK', block: substackId, shadow: null };
  }
  const sub2Source = scriptObj.substack2 || rawInputs.SUBSTACK2;
  if (sub2Source) {
    const arr2 = Array.isArray(sub2Source) ? sub2Source : [sub2Source];
    const substack2Id = buildSubstackChain(arr2, target, allBlocks, blockId, procRegistry);
    if (substack2Id) blockDef.inputs.SUBSTACK2 = { name: 'SUBSTACK2', block: substack2Id, shadow: null };
  }

  if (scriptObj.next) {
    const nextId = buildBlockStructure(scriptObj.next, target, allBlocks, procRegistry);
    if (nextId) {
      blockDef.next = nextId;
      const nextDef = allBlocks.find(ab => ab.id === nextId);
      if (nextDef) nextDef.parent = blockId;
    }
  }

  return blockId;
}

/**
 * Build a procedures_call block: inputs keyed by argumentid（与 prototype 的
 * argumentids 对齐），mutation 记录 proccode + argumentids。
 * 参数槽规则：bool 槽接受嵌套报告器（走嵌套构建），裸 true/false 留空；
 * 其余值走 createInputShadow（数字/字符串 shadow），{variable}/{list} 简写转成
 * data_variable/data_listcontents 描述符走嵌套（与 argToInputValue 一致）。
 * 注册表查不到 proccode 时跳过创建（返回 null），校验阶段已报错。
 * @returns {string|null} id of the created call block
 */
function buildProcedureCall(scriptObj, target, allBlocks, procRegistry) {
  const entry = procRegistry ? procRegistry.get(scriptObj.proccode) : null;
  if (!entry) return null;
  const callId = newAiBlockId();
  const inputs = {};
  const placeholders = String(scriptObj.proccode).match(/%[sb]/g) || [];
  const callArgs = Array.isArray(scriptObj.callArgs) ? scriptObj.callArgs : [];
  const argIds = entry.argIds || [];
  const argTypes = entry.argTypes || [];
  for (let i = 0; i < placeholders.length && i < callArgs.length; i++) {
    const argId = argIds[i];
    if (!argId) break;
    let val = callArgs[i];
    // 原始 token 形态（{variable}/{list} 简写、{opcode, args} 嵌套 token）统一折叠：
    // 值原语变字面量/简写，其余变描述符——与普通积木参数走 argToInputValue 的规则一致。
    if (val && typeof val === 'object' && (val.variable !== undefined || val.list !== undefined ||
        (val.opcode && Array.isArray(val.args)))) {
      val = argToInputValue(val, target && target.runtime);
    }
    if (argTypes[i] === 'bool') {
      if (val && typeof val === 'object' && val.opcode) {
        const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
        if (nestedId) {
          inputs[argId] = { name: argId, block: nestedId, shadow: null };
          const nestedDef = allBlocks.find(ab => ab.id === nestedId);
          if (nestedDef) nestedDef.parent = callId;
        }
      }
      // 裸 true/false（或布尔）与折叠后的字面量：布尔槽留空（Scratch 里即 false）
    } else if (val && typeof val === 'object' && val.opcode) {
      const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[argId] = { name: argId, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = callId;
      }
    } else if (val && typeof val === 'object' && (val.variable !== undefined || val.list !== undefined)) {
      // 折叠出的 {variable}/{list} 简写：转成 data_variable/data_listcontents 描述符走嵌套
      const nestedId = buildBlockStructure(argToInputValue(val, target && target.runtime), target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[argId] = { name: argId, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = callId;
      }
    } else {
      const [shadowBlock, inputRef] = createInputShadow(target, callId, 'procedures_call', argId, val);
      if (shadowBlock) allBlocks.push(shadowBlock);
      if (inputRef && inputRef.block) inputs[argId] = inputRef;
    }
  }
  const callBlock = {
    id: callId,
    opcode: 'procedures_call',
    inputs,
    fields: {},
    next: null,
    parent: null,
    shadow: false,
    topLevel: false,
    x: 0,
    y: 0,
    mutation: {
      tagName: 'mutation',
      children: [],
      proccode: scriptObj.proccode,
      argumentids: JSON.stringify(argIds)
    }
  };
  allBlocks.push(callBlock);
  if (scriptObj.next) {
    const nextId = buildBlockStructure(scriptObj.next, target, allBlocks, procRegistry);
    if (nextId) {
      callBlock.next = nextId;
      const nextDef = allBlocks.find(ab => ab.id === nextId);
      if (nextDef) nextDef.parent = callId;
    }
  }
  return callId;
}

/** Build a vertical chain of blocks; returns the first block's id. */
function buildSubstackChain(substackArray, target, allBlocks, parentBlockId, procRegistry) {
  if (!Array.isArray(substackArray) || substackArray.length === 0) return null;
  let firstId = null;
  let prevId = null;
  for (let si = 0; si < substackArray.length; si++) {
    const subId = buildBlockStructure(substackArray[si], target, allBlocks, procRegistry);
    if (!subId) continue;
    if (firstId === null) firstId = subId;
    const curDef = allBlocks.find(ab => ab.id === subId);
    if (curDef) curDef.parent = prevId || parentBlockId;
    if (prevId) {
      const prevDef = allBlocks.find(ab => ab.id === prevId);
      if (prevDef) prevDef.next = subId;
    }
    prevId = subId;
  }
  return firstId;
}

/**
 * Build a complete top-level script (hat + body chain) from a parsed DSL result.
 * @returns {{blocks: Array, hatId: ?string, lastId: ?string}}
 */
/**
 * Splice a freshly built chain of blocks into an existing script.
 *
 * Scratch stores a stack as a singly linked list (`next`) plus a `parent` pointer, and
 * C-blocks hold their body under `inputs.SUBSTACK`. Inserting therefore means rewiring
 * exactly three links — predecessor→new, new tail→successor, successor→new tail — and
 * getting any of them wrong detaches the rest of the script into a floating stack.
 * Centralizing that here keeps every insert position consistent.
 *
 * @param {object} target the sprite/stage whose blocks are being edited
 * @param {Array} newBlocks flat block records to create (already linked among themselves)
 * @param {string} firstId id of the first block of the new chain
 * @param {string} lastId id of the last block of the new chain
 * @param {object} anchor {position, blockId} describing where to splice
 * @returns {{ok: boolean, error: ?string}}
 */
function spliceBlocksIntoScript(target, newBlocks, firstId, lastId, anchor) {
  const blocks = target.blocks;
  const position = anchor.position;
  const anchorBlock = anchor.blockId ? blocks.getBlock(anchor.blockId) : null;

  if (position !== 'body_start' && position !== 'body_end' && !anchorBlock) {
    return { ok: false, error: 'Anchor block not found' };
  }

  const create = () => newBlocks.forEach(b => blocks.createBlock(b));
  const firstDef = newBlocks.find(b => b.id === firstId);
  const lastDef = newBlocks.find(b => b.id === lastId);
  if (!firstDef || !lastDef) return { ok: false, error: 'New blocks were not built' };
  // Spliced blocks always live inside a script, never as their own stack.
  firstDef.topLevel = false;
  firstDef.x = 0;
  firstDef.y = 0;

  if (position === 'after') {
    const successorId = anchorBlock.next;
    create();
    blocks.getBlock(anchor.blockId).next = firstId;
    blocks.getBlock(firstId).parent = anchor.blockId;
    if (successorId) {
      blocks.getBlock(lastId).next = successorId;
      const successor = blocks.getBlock(successorId);
      if (successor) successor.parent = lastId;
    }
    return { ok: true };
  }

  if (position === 'before') {
    const parentId = anchorBlock.parent;
    const wasTopLevel = anchorBlock.topLevel;
    // Which link points at the anchor: a previous block's `next`, or a C-block's SUBSTACK?
    let parentBlock = parentId ? blocks.getBlock(parentId) : null;
    let branchInput = null;
    if (parentBlock) {
      if (parentBlock.next === anchor.blockId) {
        branchInput = null;
      } else if (parentBlock.inputs) {
        ['SUBSTACK', 'SUBSTACK2'].forEach(key => {
          if (parentBlock.inputs[key] && parentBlock.inputs[key].block === anchor.blockId) branchInput = key;
        });
      }
    }
    // Inserting before a hat block is meaningless — nothing can precede it.
    if (!parentBlock && !wasTopLevel) {
      return { ok: false, error: 'Anchor block has no parent and is not top level; cannot insert before it' };
    }
    if (anchorBlock.opcode.indexOf('event_when') === 0 || anchorBlock.opcode === 'control_start_as_clone') {
      return { ok: false, error: 'Cannot insert before a hat block (' + anchorBlock.opcode +
        '). Use position "after" to put blocks under the hat.' };
    }
    create();
    const anchorNow = blocks.getBlock(anchor.blockId);
    blocks.getBlock(lastId).next = anchor.blockId;
    anchorNow.parent = lastId;
    if (parentBlock) {
      const parentNow = blocks.getBlock(parentId);
      if (branchInput) {
        parentNow.inputs[branchInput] = { name: branchInput, block: firstId, shadow: null };
      } else {
        parentNow.next = firstId;
      }
      blocks.getBlock(firstId).parent = parentId;
    } else {
      // The anchor was the top of its own stack; the new chain takes that role.
      const firstNow = blocks.getBlock(firstId);
      firstNow.topLevel = true;
      firstNow.x = anchorBlock.x || 0;
      firstNow.y = anchorBlock.y || 0;
      firstNow.parent = null;
      anchorNow.topLevel = false;
      blocks._addScript(firstId);
      blocks._deleteScript(anchor.blockId);
    }
    return { ok: true };
  }

  if (position === 'body_start' || position === 'body_end') {
    const cBlock = blocks.getBlock(anchor.blockId);
    if (!cBlock) return { ok: false, error: 'C-block not found' };
    const schema = OPCODE_SCHEMA[cBlock.opcode];
    const branch = anchor.branch === 'else' ? 'SUBSTACK2' : 'SUBSTACK';
    if (!schema || (branch === 'SUBSTACK' && !schema.substack) || (branch === 'SUBSTACK2' && !schema.substack2)) {
      return { ok: false, error: cBlock.opcode + ' has no ' + (branch === 'SUBSTACK2' ? 'else branch' : 'body slot') +
        ', so it cannot receive blocks inside it. Use position "after" instead.' };
    }
    const existingFirstId = cBlock.inputs[branch] && cBlock.inputs[branch].block;
    create();
    if (!existingFirstId) {
      blocks.getBlock(anchor.blockId).inputs[branch] = { name: branch, block: firstId, shadow: null };
      blocks.getBlock(firstId).parent = anchor.blockId;
      return { ok: true };
    }
    if (position === 'body_start') {
      blocks.getBlock(anchor.blockId).inputs[branch] = { name: branch, block: firstId, shadow: null };
      blocks.getBlock(firstId).parent = anchor.blockId;
      blocks.getBlock(lastId).next = existingFirstId;
      const oldFirst = blocks.getBlock(existingFirstId);
      if (oldFirst) oldFirst.parent = lastId;
    } else {
      let tailId = existingFirstId;
      let guard = 0;
      while (blocks.getBlock(tailId) && blocks.getBlock(tailId).next && guard++ < 10000) {
        tailId = blocks.getBlock(tailId).next;
      }
      blocks.getBlock(tailId).next = firstId;
      blocks.getBlock(firstId).parent = tailId;
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown position "' + position + '"' };
}

function buildScriptBlocks(parsed, target, options) {
  const opts = options || {};
  const procRegistry = procRegistryForParsed(parsed, target);
  const allBlocks = [];
  const hatId = parsed.hat ? buildBlockStructure(parsed.hat, target, allBlocks, procRegistry) : null;
  if (hatId && opts.topLevel !== false) {
    const hatDef = allBlocks.find(b => b.id === hatId);
    if (hatDef) {
      hatDef.topLevel = true;
      hatDef.x = typeof opts.x === 'number' ? opts.x : 100 + Math.random() * 200;
      hatDef.y = typeof opts.y === 'number' ? opts.y : 100 + Math.random() * 200;
    }
  }
  let prevId = hatId;
  (parsed.blocks || []).forEach(block => {
    const blockId = buildBlockStructure(block, target, allBlocks, procRegistry);
    if (!blockId) return;
    if (prevId) {
      const prevDef = allBlocks.find(b => b.id === prevId);
      if (prevDef) prevDef.next = blockId;
      const curDef = allBlocks.find(b => b.id === blockId);
      if (curDef) curDef.parent = prevId;
    } else if (opts.topLevel !== false) {
      // Body-only script (no hat): the first block becomes the top-level one
      const curDef = allBlocks.find(b => b.id === blockId);
      if (curDef) {
        curDef.topLevel = true;
        curDef.x = typeof opts.x === 'number' ? opts.x : 100 + Math.random() * 200;
        curDef.y = typeof opts.y === 'number' ? opts.y : 100 + Math.random() * 200;
      }
    }
    prevId = blockId;
  });
  return { blocks: allBlocks, hatId: hatId, lastId: prevId };
}

/**
 * Validate a parsed DSL tree before touching the workspace.
 *
 * The point is to fail with a message the model can act on, and to fail *before* any
 * block is created — a half-applied script leaves the user's project in a state they
 * have to clean up by hand. Checks: unknown opcodes, hat blocks nested in a body,
 * C-blocks used without a body, argument counts, and non-numeric values in numeric slots.
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateParsedScript(parsed, target) {
  const errors = (parsed.errors || []).slice();
  const warnings = [];
  const spriteName = target && target.getName ? target.getName() : '';
  // 扩展积木动态 schema 的来源；无 target/runtime 时只能覆盖 OPCODE_SCHEMA 核心积木
  const runtime = target && target.runtime;

  const costumeNames = target && target.getCostumes
    ? target.getCostumes().map(c => c.name)
    : [];
  const soundNames = target && target.getSounds
    ? target.getSounds().map(s => s.name)
    : [];
  const spriteNames = target && target.runtime
    ? target.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName())
    : [];

  const isHat = opcode => opcode.indexOf('event_when') === 0 || opcode === 'control_start_as_clone' ||
    opcode === 'procedures_definition';

  function checkDescriptor(desc, path, depth) {
    if (!desc || !desc.opcode) return;
    const opcode = desc.opcode;
    const schema = resolveBlockSchema(opcode, runtime);
    const where = path + ' (' + opcode + ')';

    if (opcode === 'procedures_definition' || opcode === 'procedures_call') {
      // 自定义积木不在 OPCODE_SCHEMA 里，先于 unknown-opcode 检查单独处理。
      if (opcode === 'procedures_definition') {
        if (depth > 0) {
          errors.push(where + ': hat blocks can only be the first line of a script, never nested ' +
            'inside a body or a C-block. Split this into a separate add_script operation.');
        }
        (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
        (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
        return;
      }
      // procedures_call：注册表查 define，占位符数与 callArgs 数对齐。
      const registry = procRegistryForParsed(parsed, target);
      const entry = desc.proccode ? registry.get(desc.proccode) : null;
      if (!entry) {
        errors.push(where + ': call 引用的自定义积木 "' + desc.proccode +
          '" 不存在：本批文本与当前角色中都没有该 define。');
        return;
      }
      const placeholders = String(desc.proccode).match(/%[sb]/g) || [];
      const callArgs = Array.isArray(desc.callArgs) ? desc.callArgs : [];
      if (callArgs.length > placeholders.length) {
        errors.push(where + ': call 参数过多："' + desc.proccode + '" 只有 ' + placeholders.length +
          ' 个占位符，但提供了 ' + callArgs.length + ' 个参数。');
      }
      for (let pi = 0; pi < placeholders.length; pi++) {
        const ph = placeholders[pi];
        const val = pi < callArgs.length ? callArgs[pi] : undefined;
        if (val === undefined || val === null || val === '') {
          if (ph === '%s') {
            errors.push(where + ': call 缺少参数：第 ' + (pi + 1) + ' 个占位符 %s 没有对应的实参。');
          } else {
            warnings.push(where + ': call 缺少参数：第 ' + (pi + 1) + ' 个占位符 %b 没有对应的实参，布尔槽留空。');
          }
          continue;
        }
        if (ph === '%b' && (val === true || val === false || val === 'true' || val === 'false')) {
          warnings.push(where + ': 布尔参数用 true/false 留空处理，建议放括号内布尔报告器');
        }
        if (val && typeof val === 'object' && val.opcode) {
          const converted = argToInputValue(val, runtime);
          // {variable}/{list} 折叠出的 data_variable/data_listcontents 是值原语形态，
          // 构建时会成为嵌套变量报告器，不按「值原语不是积木」报错。
          if (converted && typeof converted === 'object' && converted.opcode &&
              !VALUE_PRIMITIVE_OPCODES[converted.opcode]) {
            checkDescriptor(converted, where + ' → ' + ph, depth + 1);
          }
        }
      }
      (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
      (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
      return;
    }

    if (VALUE_PRIMITIVE_OPCODES[opcode]) {
      errors.push(where + ': 「' + opcode + '」是值原语（value primitive），不是积木。数值/文本应直接写在参数里（例如 motion_movesteps 10），或放进对应积木的参数槽。');
      return;
    }
    if (!schema) {
      if (runtime) {
        errors.push(where + ': 「' + opcode + '」来自未加载或未知的扩展积木，无法解析其参数。请先在扩展库加载对应扩展后再应用。');
      } else {
        errors.push(where + ': unknown opcode. It is not in the supported block dictionary — ' +
          'check spelling, or use develop_extension if the block comes from an extension.');
      }
      return;
    }
    if (depth > 0 && isHat(opcode)) {
      errors.push(where + ': hat blocks can only be the first line of a script, never nested ' +
        'inside a body or a C-block. Split this into a separate add_script operation.');
    }
    if ((schema.substack || schema.substack2) && !schema.optionalBody &&
        (!desc.substack || desc.substack.length === 0) &&
        (!desc.substack2 || desc.substack2.length === 0)) {
      warnings.push(where + ': C-block has an empty body. Indent the blocks that belong inside it by two spaces.');
    }
    if (!schema.substack && desc.substack && desc.substack.length > 0) {
      errors.push(where + ': this block has no body slot, but ' + desc.substack.length +
        ' block(s) were indented under it. Remove the indentation.');
    }
    if (!schema.substack2 && desc.substack2 && desc.substack2.length > 0) {
      errors.push(where + ': this block has no else branch, so "else" is not valid here.');
    }

    // Extra positional tokens land in ARG1/ARG2… which Scratch cannot render.
    Object.keys(desc.inputs || {}).forEach(key => {
      if (/^ARG\d+$/.test(key)) {
        errors.push(where + ': too many arguments. This block takes ' + schema.args.length +
          ' (' + (schema.args.map(a => a.name).join(', ') || 'none') + ').');
      }
    });

    schema.args.forEach(argDef => {
      const provided = Object.prototype.hasOwnProperty.call(desc.inputs || {}, argDef.name) ||
        Object.prototype.hasOwnProperty.call(desc.fields || {}, argDef.name);
      if (!provided && !argDef.bool) {
        warnings.push(where + ': argument ' + argDef.name + ' is missing; Scratch will use its default.');
        return;
      }
      const raw = (desc.inputs || {})[argDef.name];
      if (raw === undefined || raw === null) return;
      if (typeof raw === 'object' && raw.opcode) {
        // $var/@list 简写经 argToInputValue 展开成的 data_variable/data_listcontents
        // 描述符是合法取值器（序列化端会还原成 $x/@x），与 call 参数路径一致放行；
        // 其内部没有可再嵌套的输入，无需递归校验。
        if (!VALUE_PRIMITIVE_OPCODES[raw.opcode]) {
          checkDescriptor(raw, where + ' → ' + argDef.name, depth + 1);
        }
        return;
      }
      if (typeof raw === 'object') return; // {VARIABLE}/{LIST} shorthand
      const shadow = argDef.shadow;
      if (shadow && SHADOW_VALUE_FIELD[shadow] && shadow !== 'text' && shadow !== 'colour_picker') {
        const num = Number(String(raw).trim());
        if (String(raw).trim() === '' || isNaN(num)) {
          warnings.push(where + ': ' + argDef.name + ' expects a number but got "' + raw +
            '". It will be kept as text, which Scratch reads as 0 in arithmetic.');
        }
      }
    });

    // Dropdown values that reference project assets: a typo produces a block that
    // silently does nothing, so surface it while the model can still fix it.
    const menuChecks = [
      { opcodes: ['looks_switchcostumeto'], arg: 'COSTUME', pool: costumeNames, label: 'costume' },
      { opcodes: ['sound_play', 'sound_playuntildone'], arg: 'SOUND_MENU', pool: soundNames, label: 'sound' }
    ];
    menuChecks.forEach(check => {
      if (check.opcodes.indexOf(opcode) < 0 || check.pool.length === 0) return;
      const val = (desc.inputs || {})[check.arg] !== undefined
        ? (desc.inputs || {})[check.arg]
        : (desc.fields || {})[check.arg];
      if (val === undefined || val === null || typeof val === 'object') return;
      if (check.pool.indexOf(String(val)) < 0) {
        warnings.push(where + ': ' + check.label + ' "' + val + '" does not exist on ' +
          (spriteName || 'this sprite') + '. Available: ' + check.pool.join(', '));
      }
    });
    if (opcode === 'control_create_clone_of' || opcode === 'sensing_touchingobject' ||
        opcode === 'motion_goto' || opcode === 'motion_glideto' || opcode === 'motion_pointtowards') {
      const argName = schema.args.filter(a => a.kind === 'menu').map(a => a.name)[0];
      const val = argName ? (desc.inputs || {})[argName] : undefined;
      if (typeof val === 'string' && val.charAt(0) !== '_' && spriteNames.length &&
          spriteNames.indexOf(val) < 0) {
        warnings.push(where + ': "' + val + '" is neither a special value (_myself_, _mouse_, ' +
          '_edge_, _random_) nor an existing sprite. Available sprites: ' + spriteNames.join(', '));
      }
    }

    (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
    (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
  }

  if (parsed.hat) checkDescriptor(parsed.hat, 'hat', 0);
  (parsed.blocks || []).forEach((b, i) => checkDescriptor(b, 'line ' + (i + 1), 0));
  return { errors: errors, warnings: warnings };
}

/** One place to phrase "nothing was changed" rejections so every caller reads alike. */
function formatValidationError(errors, scriptText) {
  const head = 'Script rejected before applying — the project was NOT modified. Fix these and retry:';
  const body = errors.map(e => '  - ' + e).join('\n');
  const tail = scriptText ? '\nScript text:\n' + String(scriptText).substring(0, 600) : '';
  return head + '\n' + body + tail;
}

/**
 * Serialize one live VM block back into a DSL line, walking OPCODE_SCHEMA in order.
 *
 * Emitting "all inputs then all fields" (the previous approach) breaks the round trip:
 * `data_addtolist` stores ITEM as an input and LIST as a field, so that order produced
 * `data_addtolist 100 @scores`, which parses back as list="100", item="scores". Walking
 * the schema keeps every token in the slot the parser will read it from.
 *
 * @param {object} blk block record from target.blocks._blocks
 * @param {object} blocks the whole _blocks map, for following input references
 * @param {number} depth recursion guard for nested reporters
 * @param {object} [runtime] VM runtime，用于扩展积木的动态 schema 解析
 * @returns {string} one DSL line without indentation
 */
function serializeBlockToDsl(blk, blocks, depth, runtime) {
  depth = depth || 0;
  if (!blk || !blk.opcode) return '';
  const escapeDsl = v => String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  const quote = v => '"' + escapeDsl(v) + '"';
  // 变量/列表名：含空白、引号或反斜杠时用带引号形式（$"my var" / @"my list"）
  const nameToken = (prefix, name) => /[\s"\\]/.test(String(name))
    ? prefix + '"' + escapeDsl(name) + '"'
    : prefix + name;

  // Value of whatever sits in one input slot, as a DSL token.
  const tokenForInput = (inputName) => {
    const inp = blk.inputs && blk.inputs[inputName];
    if (!inp || !inp.block) return null;
    const sub = blocks[inp.block];
    if (!sub) return null;
    const isShadow = inp.block === inp.shadow;
    if (isShadow) {
      const valueField = SHADOW_VALUE_FIELD[sub.opcode];
      if (valueField && sub.fields && sub.fields[valueField]) {
        const raw = sub.fields[valueField].value;
        if (sub.opcode === 'text' || sub.opcode === 'colour_picker') return quote(raw);
        return String(raw);
      }
      if (sub.opcode === 'data_variable') return nameToken('$', sub.fields.VARIABLE.value);
      if (sub.opcode === 'data_listcontents') return nameToken('@', sub.fields.LIST.value);
      // Menu shadow (sound_sounds_menu, motion_goto_menu, event_broadcast_menu, …)
      const menuKeys = sub.fields ? Object.keys(sub.fields) : [];
      for (let i = 0; i < menuKeys.length; i++) {
        const mf = sub.fields[menuKeys[i]];
        const mfv = mf && typeof mf === 'object' ? mf.value : mf;
        if (mfv !== null && mfv !== undefined) return quote(mfv);
      }
      return null;
    }
    // A real reporter is plugged in
    if (sub.opcode === 'data_variable' && sub.fields && sub.fields.VARIABLE) {
      return nameToken('$', sub.fields.VARIABLE.value);
    }
    if (sub.opcode === 'data_listcontents' && sub.fields && sub.fields.LIST) {
      return nameToken('@', sub.fields.LIST.value);
    }
    // %参数 引用：还原成裸 %名称（不是括号包裹的报告器），与解析端的 %名称 token 对应
    if (sub.opcode === 'argument_reporter_string_number' || sub.opcode === 'argument_reporter_boolean') {
      const f = sub.fields && sub.fields.VALUE;
      const nm = f ? (typeof f === 'object' ? f.value : f) : '';
      return '%' + String(nm == null ? '' : nm);
    }
    if (depth > 6) return '(' + sub.opcode + ')'; // pathological nesting guard
    return '(' + serializeBlockToDsl(sub, blocks, depth + 1, runtime) + ')';
  };

  const tokenForField = (fieldName) => {
    const f = blk.fields && blk.fields[fieldName];
    if (!f) return null;
    const value = typeof f === 'object' ? f.value : f;
    if (value === null || value === undefined) return null;
    if (fieldName === 'VARIABLE') return nameToken('$', value);
    if (fieldName === 'LIST') return nameToken('@', value);
    return quote(value);
  };

  // 自定义积木三类块在 generic 分支前拦截（procedures_* 不在 OPCODE_SCHEMA，
  // argument_reporter 要还原成 %参数）。
  if (blk.opcode === 'procedures_definition') {
    const cb = blk.inputs && blk.inputs.custom_block ? blocks[blk.inputs.custom_block.block] : null;
    const mutation = (cb && cb.mutation) || {};
    const proccode = String(mutation.proccode == null ? '' : mutation.proccode);
    let argNames = [];
    try { argNames = JSON.parse(mutation.argumentnames || '[]'); } catch (e) { argNames = []; }
    if (!Array.isArray(argNames)) argNames = [];
    // argumentnames 与 proccode 占位符按下标 zip，还原 (名)/<名> 显示形式
    let ai = 0;
    const display = proccode.replace(/%[sb]/g, ph => {
      const nm = ai < argNames.length && argNames[ai] != null ? String(argNames[ai]) : 'arg' + (ai + 1);
      ai++;
      return ph === '%b' ? '<' + nm + '>' : '(' + nm + ')';
    });
    return 'define ' + display + (String(mutation.warp) === 'true' ? ' warp=true' : '');
  }
  if (blk.opcode === 'procedures_call') {
    const mutation = blk.mutation || {};
    const proccode = String(mutation.proccode == null ? '' : mutation.proccode);
    let argIds = [];
    try { argIds = JSON.parse(mutation.argumentids || '[]'); } catch (e) { argIds = []; }
    if (!Array.isArray(argIds)) argIds = [];
    const callParts = ['call', quote(proccode)];
    argIds.forEach(argId => {
      const token = tokenForInput(argId);
      // null 只有空的 %b 会遇到（无输入可序列化），此时省略该 token
      if (token !== null) callParts.push(token);
    });
    return callParts.join(' ');
  }
  if (blk.opcode === 'argument_reporter_string_number' || blk.opcode === 'argument_reporter_boolean') {
    const f = blk.fields && blk.fields.VALUE;
    const nm = f ? (typeof f === 'object' ? f.value : f) : '';
    return '%' + String(nm == null ? '' : nm);
  }

  const parts = [blk.opcode];
  // 核心积木直接命中 OPCODE_SCHEMA；扩展积木带 runtime 时走 _blockInfo 推导的动态 schema，
  // 无 runtime 且不在 OPCODE_SCHEMA → 走后面的 unknown best-effort 分支。
  const schema = resolveBlockSchema(blk.opcode, runtime);
  const usedInputs = {};
  const usedFields = {};

  if (schema && Array.isArray(schema.args)) {
    for (let i = 0; i < schema.args.length; i++) {
      const argDef = schema.args[i];
      let token = null;
      if (argDef.kind === 'field') {
        token = tokenForField(argDef.name);
        if (token !== null) usedFields[argDef.name] = true;
      } else {
        token = tokenForInput(argDef.name);
        if (token !== null) {
          usedInputs[argDef.name] = true;
        } else {
          token = tokenForField(argDef.name);
          if (token !== null) usedFields[argDef.name] = true;
        }
      }
      // A boolean slot is legitimately empty; anything else needs a placeholder or
      // every later token would shift one slot left when parsed back.
      if (token === null) {
        if (argDef.bool) continue;
        token = argDef.kind === 'field' || argDef.shadow === 'text' ? '""' : '0';
      }
      parts.push(token);
    }
  } else {
    // Unknown opcode (extension block): best effort, inputs then fields.
    Object.keys(blk.inputs || {}).forEach(function(key) {
      if (key === 'SUBSTACK' || key === 'SUBSTACK2') return;
      const token = tokenForInput(key);
      if (token !== null) parts.push(token);
    });
    Object.keys(blk.fields || {}).forEach(function(key) {
      const token = tokenForField(key);
      if (token !== null) parts.push(token);
    });
  }
  return parts.join(' ');
}

/**
 * NeoWarp: 把一个 target（角色或舞台）的全部顶层脚本序列化为 DSL 文本。
 * 遍历 blocks._blocks 中的 topLevel 脚本，处理 SUBSTACK/SUBSTACK2 的 2 空格
 * 缩进与 else 行，输出与 AI 助手 getSpriteScripts 工具完全一致。
 *
 * @param {object} target VM target（vm.editingTarget 或按名查找的结果）
 * @returns {Array<{blockId: string, dsl: string}>}
 */
function collectTargetDsl(target) {
  const runtime = target && target.runtime; // 扩展积木序列化需要动态 schema
  const scripts = [];
  const allBlocks = target.blocks._blocks;
  Object.keys(allBlocks).forEach(function(blockId) {
    const b = allBlocks[blockId];
    if (!b.topLevel || b.parent !== null) return;
    // 漂浮值块（拖到画布上的独立 shadow/reporter）：不是可执行语句，序列化成注释行。
    // 解析端忽略 # 开头的行，这样面板自产文本重新应用时始终可用、不会校验失败。
    if (b.shadow === true || VALUE_PRIMITIVE_OPCODES[b.opcode] ||
        (b.opcode && b.opcode.indexOf('argument_reporter_') === 0)) {
      scripts.push({ blockId: blockId, dsl: '# 漂浮值块: ' + serializeBlockToDsl(b, allBlocks, 0, runtime) });
      return;
    }
    const dslLines = [];
    const emitBlock = (blk, ind) => {
      dslLines.push('  '.repeat(ind) + serializeBlockToDsl(blk, allBlocks, 0, runtime));
      if (blk.inputs && blk.inputs.SUBSTACK && blk.inputs.SUBSTACK.block) {
        let sub = allBlocks[blk.inputs.SUBSTACK.block];
        while (sub) {
          emitBlock(sub, ind + 1);
          sub = sub.next ? allBlocks[sub.next] : null;
        }
      }
      if (blk.inputs && blk.inputs.SUBSTACK2 && blk.inputs.SUBSTACK2.block) {
        dslLines.push('  '.repeat(ind) + 'else');
        let sub2 = allBlocks[blk.inputs.SUBSTACK2.block];
        while (sub2) {
          emitBlock(sub2, ind + 1);
          sub2 = sub2.next ? allBlocks[sub2.next] : null;
        }
      }
      if (blk.next) {
        if (blk.opcode === 'procedures_definition') {
          // define hat 的身体是 next 链：以 ind+1 缩进输出，重解析时才能回到 define 体内
          let sub = allBlocks[blk.next];
          while (sub) {
            emitBlock(sub, ind + 1);
            sub = sub.next ? allBlocks[sub.next] : null;
          }
        } else if (ind === 0) {
          emitBlock(allBlocks[blk.next], 0);
        }
      }
    };
    emitBlock(b, 0);
    scripts.push({ blockId: blockId, dsl: dslLines.join('\n') });
  });
  return scripts;
}

function convertBlockObjToDsl(obj, indent, runtime) {
  indent = indent || 0;
  var pad = '  '.repeat(indent);
  if (!obj || !obj.opcode) return [];

  var rawInputs = obj.inputs || {};
  var rawFields = obj.fields || {};

  var fieldValue = function(key) {
    var fv = rawFields[key];
    if (fv && typeof fv === 'object') fv = fv.value;
    return fv;
  };
  var escapeDslText = function(v) {
    return String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };
  var nameToken = function(prefix, name) {
    return /[\s"\\]/.test(String(name)) ? prefix + '"' + escapeDslText(name) + '"' : prefix + name;
  };
  var encodeInput = function(val) {
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'string') return '"' + escapeDslText(val) + '"';
    if (val && typeof val === 'object') {
      if (val.opcode) return '(' + convertBlockObjToDsl(val, 0, runtime).join(' ') + ')';
      // Variable/list reporter shorthand used by some callers
      if (val.VARIABLE) return '$' + val.VARIABLE;
      if (val.LIST) return '@' + val.LIST;
    }
    return null;
  };
  var encodeField = function(key) {
    var fv = fieldValue(key);
    if (fv === undefined || fv === null) return null;
    if (key === 'VARIABLE') return nameToken('$', fv);
    if (key === 'LIST') return nameToken('@', fv);
    return '"' + escapeDslText(fv) + '"';
  };

  var parts = [obj.opcode];
  // 扩展积木带 runtime 时走 _blockInfo 推导的动态 schema；否则只认 OPCODE_SCHEMA
  var schema = resolveBlockSchema(obj.opcode, runtime);
  var usedInputs = {};
  var usedFields = {};

  if (schema && Array.isArray(schema.args)) {
    // Walk the schema in order so each token lands in its declared slot.
    for (var ai = 0; ai < schema.args.length; ai++) {
      var argDef = schema.args[ai];
      var token = null;
      if (argDef.kind === 'field') {
        if (Object.prototype.hasOwnProperty.call(rawFields, argDef.name)) {
          token = encodeField(argDef.name);
          usedFields[argDef.name] = true;
        } else if (Object.prototype.hasOwnProperty.call(rawInputs, argDef.name)) {
          // Tolerate models that put a menu value under inputs
          token = encodeInput(rawInputs[argDef.name]);
          usedInputs[argDef.name] = true;
        }
      } else {
        if (Object.prototype.hasOwnProperty.call(rawInputs, argDef.name)) {
          token = encodeInput(rawInputs[argDef.name]);
          usedInputs[argDef.name] = true;
        } else if (Object.prototype.hasOwnProperty.call(rawFields, argDef.name)) {
          token = encodeField(argDef.name);
          usedFields[argDef.name] = true;
        }
      }
      // A missing middle argument would shift every later token, so emit a
      // placeholder to keep positions aligned.
      parts.push(token === null ? (argDef.kind === 'field' ? '""' : '0') : token);
    }
  }

  // Anything the schema didn't cover (unknown opcode, extra args) keeps the old
  // inputs-then-fields order as a best effort.
  Object.keys(rawInputs).forEach(function(key) {
    if (key === 'SUBSTACK' || key === 'SUBSTACK2' || usedInputs[key]) return;
    var token = encodeInput(rawInputs[key]);
    if (token !== null) parts.push(token);
  });
  Object.keys(rawFields).forEach(function(key) {
    if (usedFields[key]) return;
    var token = encodeField(key);
    if (token !== null) parts.push(token);
  });

  var lines = [pad + parts.join(' ')];
  // Substacks may arrive either under inputs.SUBSTACK or as obj.substack
  var subSource = (obj.inputs && obj.inputs.SUBSTACK) || obj.substack;
  if (subSource) {
    var subArr = Array.isArray(subSource) ? subSource : [subSource];
    subArr.forEach(function(b) {
      convertBlockObjToDsl(b, indent + 1, runtime).forEach(function(l) { lines.push(l); });
    });
  }
  var sub2Source = (obj.inputs && obj.inputs.SUBSTACK2) || obj.substack2;
  if (sub2Source) {
    lines.push(pad + 'else');
    var sub2Arr = Array.isArray(sub2Source) ? sub2Source : [sub2Source];
    sub2Arr.forEach(function(b) {
      convertBlockObjToDsl(b, indent + 1, runtime).forEach(function(l) { lines.push(l); });
    });
  }
  if (obj.next) {
    convertBlockObjToDsl(obj.next, indent, runtime).forEach(function(l) { lines.push(l); });
  }
  return lines;
}

// Parse Scratch block DSL text into {hat: descriptor, blocks: [descriptor, ...]}.
function parseScratchDSL(scriptText, target) {
  // 扩展积木动态 schema 来源（target.runtime）；变量/列表 id 解析仍在 buildBlockStructure
  const runtime = target && target.runtime;
  const warnings = [];
  const errors = [];
  const defines = []; // 本段文本中的自定义积木定义（proc 对象）
  const rawLines = String(scriptText == null ? '' : scriptText).split('\n');
  const parsedLines = [];
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li];
    // Normalize: convert leading tabs to 2 spaces each for indent calculation
    const indentMatch = line.match(/^[\t ]*/);
    const indentRaw = indentMatch ? indentMatch[0] : '';
    const indentSpaces = indentRaw.replace(/\t/g, '  ').length;
    const indent = Math.floor(indentSpaces / 2);
    const trimmed = line.replace(/^[\t ]+/, '').replace(/\s+$/, '');
    if (trimmed.length === 0 || trimmed.charAt(0) === '#') continue;
    parsedLines.push({ indent, content: trimmed, lineNo: li + 1 });
  }

  if (parsedLines.length === 0) {
    return { hat: { opcode: 'event_whenflagclicked', inputs: {}, fields: {} }, blocks: [], defines, warnings, errors };
  }

  // Determine hat. First line (indent 0) is the hat if it looks like one.
  const firstLine = parsedLines[0];
  let hatDescriptor;
  let bodyStartIdx;
  if (isDefineLine(firstLine.content)) {
    // define 行是自定义积木的 hat：proccode/参数表由 parseDefineLine 扫描得出，
    // 身体从下一行开始（bodyStartIdx=1）。
    const node = parseDefineLine(firstLine.content, firstLine.lineNo);
    hatDescriptor = { opcode: 'procedures_definition', inputs: {}, fields: {}, proc: node.proc, lineNo: firstLine.lineNo };
    defines.push(node.proc);
    bodyStartIdx = 1;
  } else {
    let firstParsed;
    try {
      firstParsed = parseDslLine(firstLine.content, runtime);
    } catch (e) {
      throw new Error('line ' + firstLine.lineNo + ': ' + e.message + ' (near: "' + firstLine.content.substring(0, 60) + '")');
    }
    const isFirstHat = firstParsed.opcode.indexOf('event_') === 0 || firstParsed.opcode === 'control_start_as_clone';
    if (isFirstHat) {
      if (!resolveBlockSchema(firstParsed.opcode, runtime)) {
        warnings.push('line ' + firstLine.lineNo + ': unknown opcode "' + firstParsed.opcode + '" (not in OPCODE_SCHEMA, block may not work correctly)');
      }
      hatDescriptor = mapArgsToDescriptor(firstParsed.opcode, firstParsed.args, runtime);
      bodyStartIdx = 1;
    } else {
      hatDescriptor = { opcode: 'event_whenflagclicked', inputs: {}, fields: {} };
      bodyStartIdx = 0;
    }
  }

  // Build the body tree using a stack.
  const rootNodes = [];
  const stack = []; // entries: {node, indent, inElse}
  let prevNode = null;
  let prevIndent = 0;
  let prevHadSubstack = false;
  for (let bi = bodyStartIdx; bi < parsedLines.length; bi++) {
    const { indent, content, lineNo } = parsedLines[bi];

    if (content === 'else') {
      // Mark the matching C-block entry (same indent) as being in its else branch.
      // 只接受「同缩进且支持 else 分支（substack2）」的栈项；栈空、缩进对不上、
      // 或匹配项不支持 else 时报错，避免 else 被静默吞掉或错误归入其它积木。
      let elseMatched = false;
      for (let sj = stack.length - 1; sj >= 0; sj--) {
        const entrySchema = resolveBlockSchema(stack[sj].node.opcode, runtime);
        if (stack[sj].indent === indent && entrySchema && entrySchema.substack2) {
          stack[sj].inElse = true;
          elseMatched = true;
          break;
        }
      }
      if (!elseMatched) {
        errors.push('line ' + lineNo + ': "else" 没有匹配到同缩进的 if/if_else 积木。');
      }
      continue;
    }

    // define/call 行在 parseDslLine 之前拦截：它们的语法不是「opcode + 位置参数」。
    let node;
    let hasSubstack = false;
    if (isDefineLine(content)) {
      node = parseDefineLine(content, lineNo);
      defines.push(node.proc);
    } else if (isCallLine(content)) {
      node = parseCallLine(content, lineNo);
    } else {
      let parsed;
      try {
        parsed = parseDslLine(content, runtime);
      } catch (e) {
        throw new Error('line ' + lineNo + ': ' + e.message + ' (near: "' + content.substring(0, 60) + '")');
      }
      const schema = resolveBlockSchema(parsed.opcode, runtime);
      if (!schema) {
        warnings.push('line ' + lineNo + ': unknown opcode "' + parsed.opcode + '" (not in OPCODE_SCHEMA, block may not work correctly)');
      }
      hasSubstack = !!(schema && (schema.substack === true || schema.substack2 === true));
      node = {
        opcode: parsed.opcode,
        rawArgs: parsed.args,
        indent,
        substack: [],
        substack2: []
      };
    }
    node.indent = indent;
    node.lineNo = lineNo;

    // Indenting under a block with no body slot would otherwise be silently dropped:
    // the line just becomes a sibling and the model never learns its nesting was lost.
    if (prevNode && indent > prevIndent && !prevHadSubstack) {
      errors.push('line ' + lineNo + ': "' + node.opcode + '" is indented under "' +
        prevNode.opcode + '", which has no body slot. Only C-blocks (repeat, forever, if, ...) ' +
        'can contain blocks. Remove the indentation.');
    }
    prevNode = node;
    prevIndent = indent;
    prevHadSubstack = hasSubstack;

    // Pop until top has indent < current indent.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootNodes.push(node);
    } else {
      const top = stack[stack.length - 1];
      if (top.inElse) {
        top.node.substack2.push(node);
      } else {
        top.node.substack.push(node);
      }
    }

    if (hasSubstack) {
      stack.push({ node, indent, inElse: false });
    }
  }

  const blocks = rootNodes.map(node => convertNode(node, runtime));
  // %参数 引用：按最近 define 的参数类型翻转 reporter 类型；define 体外引用记错误。
  // define hat 的身体是根节点列表，因此用它的参数表遍历全部根块。
  let hatProcMap = null;
  if (hatDescriptor && hatDescriptor.opcode === 'procedures_definition' && hatDescriptor.proc) {
    hatProcMap = procParamMap(hatDescriptor.proc);
  }
  applyArgumentRefs(hatDescriptor, null, errors);
  blocks.forEach(b => applyArgumentRefs(b, hatProcMap, errors));
  return { hat: hatDescriptor, blocks, defines, warnings, errors };
}

/* ══════════════════════════════════════════════════════════════════════════
   角色 / 变量 / 列表工具的共用辅助
   这些工具原来各自内联解析目标与变量，导致三类问题：
     1. 变量查找用 Object.values(target.variables).find(byName)，不会像 Scratch
        那样回退到舞台，于是"给了 sprite_name 就改不到全局变量"；
     2. 查找不带类型，set_variable 传一个列表名会把数组覆盖成字符串；
     3. 报错只有 "Variable not found"，模型不知道有哪些名字可用、也不知道拼错了。
   统一到这里之后，作用域、类型、报错措辞在所有工具里保持一致。
   ══════════════════════════════════════════════════════════════════════════ */

/** 把数字形态的字符串转成数字，与 Scratch 自身的宽松类型一致。 */
function coerceScratchValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  const num = Number(trimmed);
  return isNaN(num) ? value : num;
}

const STAGE_ALIASES = ['stage', '_stage_', '舞台', 'background', 'backdrop'];

/**
 * 解析变量/列表所属的目标。
 * 不传 sprite_name（或写成 Stage）表示全局，落在舞台上。
 * @returns {{target: ?object, error: ?string}}
 */
function resolveDataTarget(vm, params) {
  const raw = params.spriteName || params.sprite_name || params.targetName;
  const stage = vm.runtime.getTargetForStage();
  if (params.targetId) {
    const byId = vm.runtime.getTargetById(params.targetId);
    if (byId) return { target: byId, error: null };
  }
  if (!raw || STAGE_ALIASES.indexOf(String(raw).trim().toLowerCase()) >= 0) {
    return { target: stage, error: null };
  }
  const name = String(raw);
  const found = vm.runtime.targets.find(t => !t.isStage && t.getName() === name);
  if (found) return { target: found, error: null };
  const available = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
  return {
    target: null,
    error: 'Sprite "' + name + '" not found. Available sprites: ' +
      (available.length ? available.join(', ') : '(none)') +
      '. Omit sprite_name to use the Stage (global scope).'
  };
}

/** 名字打错时给出最接近的候选，比单纯罗列全部更有用。 */
function closestName(name, candidates) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestScore = 0;
  candidates.forEach(candidate => {
    const c = candidate.toLowerCase();
    let score = 0;
    if (c === lower) score = 100;
    else if (c.indexOf(lower) >= 0 || lower.indexOf(c) >= 0) score = 60 + Math.min(20, c.length);
    else {
      // 共同前缀长度，够简单也够用
      let i = 0;
      while (i < c.length && i < lower.length && c[i] === lower[i]) i++;
      score = i * 4;
    }
    if (score > bestScore) { bestScore = score; best = candidate; }
  });
  return bestScore >= 8 ? best : null;
}

/**
 * 在作用域内查找变量或列表：先找目标自己的，再回退到舞台，与 Scratch 一致。
 * @param {string} type '' 表示普通变量，'list' 表示列表
 * @returns {{variable: ?object, owner: ?object, scope: string, error: ?string}}
 */
function findDataVariable(vm, target, name, type) {
  const label = type === 'list' ? 'List' : 'Variable';
  if (!name) return { variable: null, owner: null, scope: '', error: 'No ' + label.toLowerCase() + ' name provided' };
  const stage = vm.runtime.getTargetForStage();

  const local = Object.values(target.variables).find(v => v.name === name && v.type === type);
  if (local) {
    return { variable: local, owner: target, scope: target.isStage ? 'global' : 'local', error: null };
  }
  if (!target.isStage && stage) {
    const global = Object.values(stage.variables).find(v => v.name === name && v.type === type);
    if (global) return { variable: global, owner: stage, scope: 'global', error: null };
  }

  // 同名但类型不对：这是最容易踩的坑，单独说清楚，别报 "not found"
  const wrongType = Object.values(target.variables).find(v => v.name === name) ||
    (!target.isStage && stage ? Object.values(stage.variables).find(v => v.name === name) : null);
  if (wrongType) {
    const actual = wrongType.type === 'list' ? 'a list' : 'a variable';
    const wanted = type === 'list' ? 'a list' : 'a variable';
    return {
      variable: null, owner: null, scope: '',
      error: '"' + name + '" is ' + actual + ', not ' + wanted +
        '. Use the ' + (wrongType.type === 'list' ? 'list' : 'variable') + ' tools for it.'
    };
  }

  const inScope = target.getAllVariableNamesInScopeByType(type);
  const suggestion = closestName(name, inScope);
  return {
    variable: null, owner: null, scope: '',
    error: label + ' "' + name + '" not found on ' +
      (target.isStage ? 'the Stage' : target.getName() + ' or the Stage') + '.' +
      (suggestion ? ' Did you mean "' + suggestion + '"?' : '') +
      ' In scope: ' + (inScope.length ? inScope.join(', ') : '(none)') + '.'
  };
}

/** 列表内容摘要：给模型看结果，避免它为了确认再读一次。 */
function listPreview(items, limit) {
  const max = limit || 20;
  const arr = Array.isArray(items) ? items : [];
  const shown = arr.slice(0, max);
  return {
    length: arr.length,
    items: shown,
    truncated: arr.length > shown.length ? arr.length - shown.length : 0
  };
}

/** 把 1 基下标（含 'first'/'last'/'all' 别名）解析成 0 基数组下标。 */
function resolveListIndex(raw, length, opts) {
  const allowAppend = !!(opts && opts.allowAppend);
  const upper = allowAppend ? length + 1 : length;
  if (raw === undefined || raw === null || raw === '') {
    return allowAppend ? { index: length, error: null } : { index: -1, error: 'No index provided' };
  }
  const token = String(raw).trim().toLowerCase();
  if (token === 'last') return { index: allowAppend ? length : length - 1, error: null };
  if (token === 'first') return { index: 0, error: null };
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    return { index: -1, error: 'Index must be a number (1 = first), or "first"/"last". Got: ' + raw };
  }
  if (parsed < 1 || parsed > upper) {
    return {
      index: -1,
      error: 'Index ' + parsed + ' is out of range. The list has ' + length + ' item(s), so valid values are 1' +
        (upper >= 1 ? '–' + upper : '') + (allowAppend ? ' (' + upper + ' appends to the end)' : '') + '.'
    };
  }
  return { index: parsed - 1, error: null };
}

/* ── AI 更改快照 ──
   撤销功能的存储层。快照是完整的 sb3 压缩包（含资产），只存活在编辑器渲染进程的
   内存里：不落盘是因为它只服务于"这次对话内的撤销"，用户重开编辑器后本就该失效；
   不经 IPC 传给 AI 窗口是因为体积可达几十 MB。 */
const aiSnapshots = new Map();
const aiSnapshotOrder = [];
const AI_SNAPSHOT_LIMIT = 4;

// NeoWarp: 「源代码Beta」标签页面板 —— 内嵌在编辑器第 4 个 TabPanel 中，
// 与造型/声音同级的完整区域：左侧行号、可编辑 DSL 文本、应用到积木。
// 序列化复用 collectTargetDsl（与 AI 助手 getSpriteScripts 输出一致），
// 应用复用 parseScratchDSL/validateParsedScript/buildScriptBlocks（与
// AI 助手 addScript 同一条链路）。样式见 editor/gui/gui.css。
const SOURCE_CODE_REFRESH_DELAY = 300;

/**
 * 把「源代码Beta」面板的文本应用到 target：按空行拆成多个脚本段，逐段
 * 解析（parseScratchDSL）并校验（validateParsedScript），全部通过后一次性
 * 替换 target 的全部顶层脚本（先删后建，与 AI 助手 addScript 相同的构建
 * 链路）。任何一段失败都不会改动 VM，避免留下半套脚本。
 *
 * @param {object} vm VirtualMachine
 * @param {object} target 目标（角色或舞台）
 * @param {string} text 面板中的 DSL 文本
 * @returns {{success: boolean, scripts?: number, blocks?: number,
 *            warnings?: string[], error?: string}}
 */
function applyDslTextToTarget(vm, target, text) {
  const chunks = String(text == null ? '' : text)
    .split(/\n[ \t]*\n/)
    .map(chunk => chunk.replace(/^\s+|\s+$/g, ''))
    // 只含注释/空白的段不生成任何积木，直接跳过
    .filter(chunk => chunk.split('\n').some(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && trimmed.charAt(0) !== '#';
    }));

  // 1. 解析全部脚本段（define/call 的行级解析错误在这里抛出）
  const parsedScripts = [];
  const warnings = [];
  for (let i = 0; i < chunks.length; i++) {
    let parsed;
    try {
      parsed = parseScratchDSL(chunks[i], target);
    } catch (e) {
      return { success: false, error: 'DSL 解析错误（第 ' + (i + 1) + ' 个脚本）：' + (e.message || String(e)) };
    }
    parsedScripts.push(parsed);
  }

  // 2. 组装自定义积木注册表：VM 现有 define 为底，本批文本 define 覆盖（先查重）。
  //    替换全部脚本会删掉 VM 里旧 define，所以文本 define 必须重新分配参数 id。
  const vmRegistry = collectProcRegistry(target);
  const registry = new Map(vmRegistry);
  const textDefineProccodes = [];
  for (let i = 0; i < parsedScripts.length; i++) {
    const defines = parsedScripts[i].defines || [];
    for (let di = 0; di < defines.length; di++) {
      const proc = defines[di];
      if (textDefineProccodes.indexOf(proc.proccode) >= 0) {
        return { success: false, error: '重复定义自定义积木 "' + proc.proccode + '"：同一批文本中 define 了两次。' };
      }
      textDefineProccodes.push(proc.proccode);
    }
  }
  if (textDefineProccodes.length > 0) {
    parsedScripts.forEach(parsed => registerTextDefines(registry, parsed.defines));
  }

  // 3. registry 挂到每个 parsed，校验与构建共用同一套参数 id。
  parsedScripts.forEach(parsed => { parsed.procRegistry = registry; });

  // 4. call 悬空警告：define 只存在于 VM（本批文本没有）时，替换全部脚本会把它删掉。
  parsedScripts.forEach(parsed => {
    const walkCalls = desc => {
      if (!desc || typeof desc !== 'object' || !desc.opcode) return;
      if (desc.opcode === 'procedures_call' &&
          textDefineProccodes.indexOf(desc.proccode) < 0 &&
          vmRegistry.has(desc.proccode)) {
        warnings.push('call 引用 "' + desc.proccode +
          '"：其 define 不在本次文本中，应用（替换全部脚本）后该定义会被删除，调用将悬空。');
      }
      (desc.substack || []).forEach(walkCalls);
      (desc.substack2 || []).forEach(walkCalls);
    };
    if (parsed.hat) walkCalls(parsed.hat);
    (parsed.blocks || []).forEach(walkCalls);
  });

  // 5. 校验全部通过后才动 VM，避免留下半套脚本。
  for (let i = 0; i < parsedScripts.length; i++) {
    const validation = validateParsedScript(parsedScripts[i], target);
    if (validation.errors.length > 0) {
      return { success: false, error: formatValidationError(validation.errors, chunks[i]) };
    }
    warnings.push(...(parsedScripts[i].warnings || []), ...(validation.warnings || []));
  }

  // 全部构建成功后再动 VM：删除现有顶层脚本（Blocks.deleteBlock 会递归
  // 删除子积木与 shadow），再创建新积木。
  const allBlocks = [];
  parsedScripts.forEach(parsed => {
    buildScriptBlocks(parsed, target).blocks.forEach(b => allBlocks.push(b));
  });
  const topLevelIds = Object.keys(target.blocks._blocks).filter(id => {
    const b = target.blocks._blocks[id];
    return b && b.topLevel && b.parent === null;
  });
  topLevelIds.forEach(id => target.blocks.deleteBlock(id));
  allBlocks.forEach(b => target.blocks.createBlock(b));
  vm.runtime.emitProjectChanged();
  vm.emitWorkspaceUpdate();
  vm.emitTargetsUpdate();
  return {
    success: true,
    scripts: parsedScripts.length,
    blocks: allBlocks.length,
    warnings: warnings.length ? warnings : undefined
  };
}

const DesktopHOC = function (WrappedComponent) {
  class DesktopComponent extends React.Component {
    constructor (props) {
      super(props);
      this.state = {
        title: '',
        collaborationState: { isCollaborating: false, role: null, onlineCount: 0, permissions: null },
        // NeoWarp: 标签栏「源代码Beta」标签页显隐
        showSourceCodeButton: true
      };
      this.handleUpdateProjectTitle = this.handleUpdateProjectTitle.bind(this);
      this.handleClickEncryptedSave = this.handleClickEncryptedSave.bind(this);
      this.handleSaveAsViewsb3 = this.handleSaveAsViewsb3.bind(this);

      // NeoWarp: 「源代码Beta」按钮显隐（编辑器设置模态框 → 外观），
      // 构造期同步读一次，避免按钮先显示再隐藏的闪烁
      try {
        if (typeof EditorPreload !== 'undefined' && EditorPreload.getShowSourceCodeButton) {
          this.state.showSourceCodeButton = EditorPreload.getShowSourceCodeButton() !== false;
        }
      } catch (e) { /* 读不到用默认值（显示） */ }

      // Changing locale always re-mounts this component
      const stateFromMain = EditorPreload.setLocale(this.props.locale);
      this.messages = stateFromMain.strings;
      setStrings({
        ok: this.messages['prompt.ok'],
        cancel: this.messages['prompt.cancel']
      });
      setEncryptedSaveStrings({
        title: this.messages['encrypted-save.title'],
        titleLabel: this.messages['encrypted-save.title-label'],
        passwordLabel: this.messages['encrypted-save.password-label'],
        confirmPasswordLabel: this.messages['encrypted-save.confirm-password-label'],
        saveButton: this.messages['encrypted-save.save-button'],
        cancelButton: this.messages['encrypted-save.cancel-button'],
        passwordMismatch: this.messages['encrypted-save.password-mismatch'],
        emptyPassword: this.messages['encrypted-save.empty-password'],
        emptyTitle: this.messages['encrypted-save.empty-title'],
        wrongPassword: this.messages['encrypted-save.wrong-password'],
        okButton: this.messages['encrypted-save.ok-button']
      });

      const storedUsername = localStorage.getItem(USERNAME_KEY);
      if (typeof storedUsername === 'string') {
        this.props.onSetReduxUsername(storedUsername);
      } else {
        this.props.onSetReduxUsername(DEFAULT_USERNAME);
      }
    }
    componentDidMount () {
      // NeoWarp: 「源代码Beta」按钮显隐变更推送（本窗口保存后主进程也会
      // 回推一次，因此同窗口与其他编辑器窗口都走同一条实时更新通道）
      if (typeof EditorPreload !== 'undefined' && EditorPreload.onShowSourceCodeButtonChanged) {
        EditorPreload.onShowSourceCodeButtonChanged(enabled => {
          this.setState({ showSourceCodeButton: enabled !== false });
        });
      }

      EditorPreload.setExportForPackager(() => this.props.vm.saveProjectSb3('arraybuffer')
        .then((buffer) => ({
          name: this.state.title,
          data: buffer
        })));

      EditorPreload.onStageDetached(() => {
        isStageDetached = true;
        startFrameStreaming(this.props.vm);
      });

      EditorPreload.onStageReattached(() => {
        isStageDetached = false;
        stopFrameStreaming();
      });

      EditorPreload.onDetachedStageInput((inputData) => {
        handleDetachedStageInput(this.props.vm, inputData);
      });

      // NeoWarp: Listen for collaboration state changes
      EditorPreload.onCollaborationStateChange((data) => {
        this.setState({ collaborationState: data }, () => {
          this.wrapVMWithPermissions();
        });
      });

      // NeoWarp: Collaboration - Host receives request for project JSON
      EditorPreload.onCollabRequestProjectJSON((data) => {
        this.buildCollabProjectPayload().then((payload) => {
          EditorPreload.sendCollabProjectJSON(payload, data.targetUsername);
        });
      });

      // NeoWarp: Collaboration - Receive project update from host/other participant
      this._collabLoadingProject = false;
      this._collabPendingProject = null;
      this._collabApplyingRemote = false;
      this._collabMissedLocalChange = false;
      EditorPreload.onCollabProjectUpdate((data) => {
        if (this._collabLoadingProject) {
          // Keep only the latest remote state; it is applied once the
          // current load and its echo-guard cooldown have settled
          this._collabPendingProject = data;
          return;
        }
        this.applyCollabProjectUpdate(data);
      });

      // NeoWarp: Collaboration - Broadcast project changes to others (debounced).
      // Building the archive is async, so guard against overlapping builds: a
      // change arriving mid-build just queues one more send.
      this._collabSyncTimer = null;
      this._collabWorkspaceRefreshTimer = null;
      this._collabWorkspaceRefreshAttempts = 0;
      this._collabLastWorkspaceRefresh = 0;
      this._collabBuildInFlight = false;
      this._collabBuildQueued = false;
      this._collabSendProjectPayload = () => {
        const collabState = this.state.collaborationState;
        if (!collabState || !collabState.isCollaborating) return;
        if (this._collabBuildInFlight) {
          this._collabBuildQueued = true;
          return;
        }
        this._collabBuildInFlight = true;
        this.buildCollabProjectPayload().then((payload) => {
          this._collabBuildInFlight = false;
          // The session may have ended while the archive was being built
          const current = this.state.collaborationState;
          if (current && current.isCollaborating) {
            if (current.role === 'host') {
              EditorPreload.sendCollabProjectJSON(payload, null);
            } else {
              EditorPreload.sendCollabProjectUpdate(payload);
            }
          }
          if (this._collabBuildQueued) {
            this._collabBuildQueued = false;
            this._collabSendProjectPayload();
          }
        });
      };
      this._collabBroadcastProject = () => {
        if (this._collabSyncTimer) clearTimeout(this._collabSyncTimer);
        this._collabSyncTimer = setTimeout(() => {
          this._collabSendProjectPayload();
        }, 1000);
      };

      // Listen for VM PROJECT_CHANGED events to trigger collaboration sync
      if (this.props.vm) {
        this.props.vm.on('PROJECT_CHANGED', () => {
          if (this._collabLoadingProject) {
            // Events our own apply produces are swallowed; genuine local
            // edits made in this window must not be lost, so remember to
            // re-broadcast once the apply and its cooldown have settled
            if (!this._collabApplyingRemote) this._collabMissedLocalChange = true;
            return;
          }
          const collabState = this.state.collaborationState;
          if (collabState && collabState.isCollaborating) {
            this._collabBroadcastProject();
          }
        });
      }

      // Wrap VM methods for permission control
      this._originalDeleteSprite = null;
      this._originalLoadExtensionURL = null;
      this._vmWrapped = false;
      setTimeout(() => this.wrapVMWithPermissions(), 500);

      // Apply code area background image
      const codeBackgroundImage = EditorPreload.getCodeAreaBackgroundImage();
      if (codeBackgroundImage) {
        this.applyCodeAreaBackground(codeBackgroundImage);
      }

      // Apply stage area background image
      if (EditorPreload.getStageAreaBackgroundImage) {
        const stageBackgroundImage = EditorPreload.getStageAreaBackgroundImage();
        if (stageBackgroundImage) {
          this.applyStageAreaBackground(stageBackgroundImage);
        }
      }

      // Setup frosted glass flyout overlay (delay to ensure Blockly is ready)
      setTimeout(() => this.setupFlyoutFrostedGlass(), 1000);
      setTimeout(() => this.setupFlyoutFrostedGlass(), 3000);

      // Listen for settings changes
      window.addEventListener('focus', () => {
        const newCodeBackgroundImage = EditorPreload.getCodeAreaBackgroundImage();
        this.applyCodeAreaBackground(newCodeBackgroundImage);
        if (EditorPreload.getStageAreaBackgroundImage) {
          const newStageBackgroundImage = EditorPreload.getStageAreaBackgroundImage();
          this.applyStageAreaBackground(newStageBackgroundImage);
        }
      });

      // NeoWarp: Task Manager - per-sprite stats collection
      // (顶栏 CPU/内存显示由菜单栏内统一实现，见 scratch-gui menu-bar.jsx，
      // 这里不再额外创建 fixed 覆盖层，避免重复)
      // Must be registered before removeAllAIListeners to avoid being cleared
      EditorPreload.onRequestSpriteStats((data) => {
        try {
          var vm = this.props.vm;
          if (!vm || !vm.runtime) {
            EditorPreload.sendSpriteStats({ requestId: data.requestId, sprites: [], totalThreads: 0 });
            return;
          }
          var runtime = vm.runtime;
          var targets = runtime.targets || [];
          var threads = runtime.threads || [];

          // Count threads per target
          // Thread status constants: 0=RUNNING, 1=PROMISE_WAIT, 2=YIELD, 3=YIELD_TICK
          // For clones, attribute threads to their parent original sprite
          var spriteToOriginalId = new Map();
          for (var oi = 0; oi < targets.length; oi++) {
            var origTarget = targets[oi];
            if (origTarget && origTarget.isOriginal && origTarget.sprite) {
              spriteToOriginalId.set(origTarget.sprite, origTarget.id);
            }
          }
          var threadCounts = {};
          var threadTimes = {};
          for (var i = 0; i < threads.length; i++) {
            var t = threads[i];
            if (t && t.target) {
              var tid = t.target.id;
              // 克隆的线程归属到其父原始角色
              if (!t.target.isOriginal && t.target.sprite && spriteToOriginalId.has(t.target.sprite)) {
                tid = spriteToOriginalId.get(t.target.sprite);
              }
              threadCounts[tid] = (threadCounts[tid] || 0) + 1;
              if (t.status === 0) { // STATUS_RUNNING
                threadTimes[tid] = (threadTimes[tid] || 0) + 1;
              } else if (t.status === 1) { // STATUS_PROMISE_WAIT
                threadTimes[tid] = (threadTimes[tid] || 0) + 0.3;
              } else if (t.status === 2) { // STATUS_YIELD
                threadTimes[tid] = (threadTimes[tid] || 0) + 0.2;
              } else if (t.status === 3) { // STATUS_YIELD_TICK
                threadTimes[tid] = (threadTimes[tid] || 0) + 0.5;
              }
            }
          }

          // Calculate total active time for percentage distribution
          var totalActiveTime = 0;
          for (var key in threadTimes) {
            totalActiveTime += threadTimes[key];
          }

          var sprites = targets.filter(function(target) {
            return !Object.prototype.hasOwnProperty.call(target, 'isOriginal') || target.isOriginal;
          }).map(function(target) {
            var tid = target.id;
            var threadCount = threadCounts[tid] || 0;
            var activeTime = threadTimes[tid] || 0;
            var cpuPercent = totalActiveTime > 0 ? (activeTime / totalActiveTime) * 100 : 0;

            // Estimate memory usage from asset data
            var memKB = 0;
            // Costumes - use asset.data.length for actual byte size
            var costumes = target.getCostumes ? target.getCostumes() : [];
            for (var ci = 0; ci < costumes.length; ci++) {
              var costume = costumes[ci];
              if (costume.asset && costume.asset.data) {
                memKB += Math.round(costume.asset.data.length / 1024);
              } else if (costume.width && costume.height) {
                // Fallback: estimate from dimensions for bitmap costumes
                memKB += Math.round(costume.width * costume.height * 4 / 1024);
              } else {
                memKB += 10;
              }
            }
            // Sounds - use asset.data.length for actual byte size
            var sounds = target.getSounds ? target.getSounds() : [];
            for (var si = 0; si < sounds.length; si++) {
              var sound = sounds[si];
              if (sound.asset && sound.asset.data) {
                memKB += Math.round(sound.asset.data.length / 1024);
              } else {
                memKB += 10;
              }
            }
            // Variables and lists overhead
            var varCount = target.variables ? Object.values(target.variables).filter(v => v.type !== 'list').length : 0;
            var listCount = target.variables ? Object.values(target.variables).filter(v => v.type === 'list').length : 0;
            memKB += varCount * 0.5 + listCount * 2;

            // Block count
            var blockCount = 0;
            if (target.blocks && target.blocks._blocks) {
              blockCount = Object.keys(target.blocks._blocks).length;
            }

            return {
              id: tid,
              name: target.getName ? target.getName() : 'Unknown',
              isStage: !!target.isStage,
              threads: threadCount,
              cpuPercent: Math.round(cpuPercent * 10) / 10,
              memEstimateKB: Math.max(memKB, 1),
              blockCount: blockCount,
              costumeCount: costumes.length,
              soundCount: sounds.length,
              visible: target.visible !== undefined ? target.visible : true,
              x: target.x || 0,
              y: target.y || 0
            };
          });

          EditorPreload.sendSpriteStats({
            requestId: data.requestId,
            sprites: sprites,
            totalThreads: threads.length
          });
        } catch (e) {
          EditorPreload.sendSpriteStats({ requestId: data.requestId, sprites: [], totalThreads: 0 });
        }
      });

      // NeoWarp: AI Assistant IPC listeners
      // Always re-register listeners on mount to ensure they are active
      // Remove old listeners first to avoid duplicates
      if (typeof EditorPreload.removeAllAIListeners === 'function') {
        EditorPreload.removeAllAIListeners();
      }

      // 图片编辑器「导出到 Scratch 项目」：把一张 PNG 导入为造型（或新建角色）
      if (typeof EditorPreload.onImportCostume === 'function') {
        EditorPreload.onImportCostume((data) => {
          const { requestId, targetId, name, dataUrl, asNewSprite } = data || {};
          const finish = (success, error) => {
            try {
              EditorPreload.sendImportCostumeResult({
                requestId,
                success: !!success,
                error: error ? String(error) : null
              });
            } catch (e) { /* 忽略 */ }
          };
          try {
            if (!dataUrl) { finish(false, '缺少图片数据'); return; }
            const raw = String(dataUrl);
            const commaIndex = raw.indexOf(',');
            const binary = atob(commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const vm = this.props.vm;
            if (!vm || !vm.runtime) { finish(false, '编辑器尚未就绪'); return; }
            // onError 必须在 import 之前声明：末尾 `.catch(onError)` 在外层作用域求值它，
            // 若定义在 .then 回调内会同步抛 "onError is not defined"（而导入其实已成功）
            const onError = (err) => finish(false, err);
            import(
              /* webpackChunkName: "file-uploader" */
              'scratch-gui/src/lib/file-uploader'
            ).then(({ costumeUpload, spriteUpload }) => {
              if (asNewSprite || !targetId) {
                // 新建角色：spriteUpload 会把图片作为造型生成一个精灵 JSON
                spriteUpload(bytes.buffer, 'image/png', name || 'Sprite', vm, (spriteJSON) => {
                  Promise.resolve(vm.addSprite(spriteJSON)).then(() => finish(true)).catch(onError);
                }, onError);
              } else {
                // 追加到已有角色的造型列表
                costumeUpload(bytes.buffer, 'image/png', vm, (costumes) => {
                  const list = Array.isArray(costumes) ? costumes : [costumes];
                  if (name) list.forEach((c, i) => { c.name = i ? `${name}${i + 1}` : name; });
                  Promise.all(list.map((c) => vm.addCostume(c.md5, c, targetId)))
                    .then(() => finish(true))
                    .catch(onError);
                }, onError);
              }
            }).catch(onError);
          } catch (e) {
            finish(false, (e && e.message) || e);
          }
        });
      }

      EditorPreload.onRequestProjectJSON((data) => {
        try {
          const json = this.props.vm.toJSON();
          // Calculate total asset size from runtime VM objects
          let assetSize = 0;
          let assetCostumeSize = 0;
          let assetSoundSize = 0;
          // asset.data 是二进制（Uint8Array/Buffer），仅文本取 base64 长度折算
          const assetByteCount = function (asset) {
            if (!asset) return 0;
            const data = asset.data;
            if (!data) return 0;
            if (typeof data === 'string') return Math.round(data.length * 0.75);
            if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return data.byteLength || 0;
            return data.length || 0;
          };
          // 按 assetId 去重，多角色共用素材只计一次，与导出的 sb3 占用一致
          const seenAssetIds = new Set();
          const runtimeTargets = this.props.vm.runtime.targets;
          if (runtimeTargets) {
            runtimeTargets.forEach(function(target) {
              var costumes = target.getCostumes ? target.getCostumes() : [];
              for (var ci = 0; ci < costumes.length; ci++) {
                var costume = costumes[ci];
                if (costume.asset) {
                  var costumeBytes = assetByteCount(costume.asset);
                  if (costumeBytes > 0) {
                    var costumeId = costume.assetId || costume.asset.assetId;
                    if (!seenAssetIds.has(costumeId)) {
                      seenAssetIds.add(costumeId);
                      assetSize += costumeBytes;
                      assetCostumeSize += costumeBytes;
                    }
                  } else if (costume.width && costume.height) {
                    assetSize += costume.width * costume.height * 4;
                    assetCostumeSize += costume.width * costume.height * 4;
                  }
                } else if (costume.width && costume.height) {
                  assetSize += costume.width * costume.height * 4;
                  assetCostumeSize += costume.width * costume.height * 4;
                }
              }
              var sounds = target.getSounds ? target.getSounds() : [];
              for (var si = 0; si < sounds.length; si++) {
                var sound = sounds[si];
                var soundBytes = assetByteCount(sound.asset);
                if (soundBytes > 0) {
                  var soundId = sound.assetId || (sound.asset && sound.asset.assetId);
                  if (!seenAssetIds.has(soundId)) {
                    seenAssetIds.add(soundId);
                    assetSize += soundBytes;
                    assetSoundSize += soundBytes;
                  }
                }
              }
            });
          }
          EditorPreload.sendProjectJSON({
            requestId: data.requestId,
            projectJSON: json,
            assetSize: assetSize,
            assetCostumeSize: assetCostumeSize,
            assetSoundSize: assetSoundSize
          });
        } catch (e) {
          EditorPreload.sendProjectJSON({
            requestId: data ? data.requestId : null,
            projectJSON: null,
            assetSize: 0,
            assetCostumeSize: 0,
            assetSoundSize: 0
          });
        }
      });

      EditorPreload.onApplyProject(async (data) => {
        try {
          const projectData = typeof data.projectJSON === 'string' ? data.projectJSON : JSON.stringify(data.projectJSON);
          await this.props.vm.loadProject(projectData);
        } catch (e) {
          console.error('Failed to apply project:', e);
        }
      });

      // 扩展编辑器「添加到项目」：把扩展脚本加载进当前项目的 VM
      if (typeof EditorPreload.onAddExtension === 'function') {
        EditorPreload.onAddExtension(async (data) => {
          const { requestId, name, code } = data || {};
          const vm = this.props.vm;
          let response;
          try {
            if (!vm || !vm.extensionManager || !vm.extensionManager.loadExtensionURL) {
              response = { success: false, error: 'Extension manager not available' };
            } else if (!code || String(code).trim().length < 10) {
              response = { success: false, error: 'Extension code is empty' };
            } else {
              const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);
              // 与 AI 助手 developExtension 相同：把该 data: URL 判为 unsandboxed，
              // 沙箱 worker 里拿不到 Scratch 全局，注册回调不会回传；加载完恢复原策略
              const secMgr = vm.extensionManager.securityManager;
              const prevGetSandboxMode = secMgr.getSandboxMode;
              secMgr.getSandboxMode = function (url) {
                if (url === dataUrl) return Promise.resolve('unsandboxed');
                return prevGetSandboxMode.call(secMgr, url);
              };
              const prevExtKeys = new Set(vm.extensionManager._loadedExtensions.keys());
              try {
                // 注册回调迟迟不来会一直挂着，加超时避免扩展编辑器侧白等
                await Promise.race([
                  vm.extensionManager.loadExtensionURL(dataUrl),
                  new Promise((_, rej) => {
                    setTimeout(() => rej(new Error('Extension registration timed out after 20s')), 20000);
                  })
                ]);
              } finally {
                secMgr.getSandboxMode = prevGetSandboxMode;
              }
              let newIds = [];
              try {
                newIds = Array.from(vm.extensionManager._loadedExtensions.keys())
                  .filter(id => !prevExtKeys.has(id));
              } catch (e) { void e; }
              response = { success: true, data: { name, extensionIds: newIds } };
            }
          } catch (e) {
            response = { success: false, error: (e && e.message) || String(e) };
          }
          EditorPreload.sendAddExtensionResult({ requestId, ...response });
        });
      }

      // 扩展编辑器「添加到/更新我的扩展」：写入本渲染层 localStorage 的我的扩展列表。
      // id 为空新增；否则只更新代码，名称/图标/沙盒等元数据仍由扩展库「设置」弹窗管理
      if (typeof EditorPreload.onMyExtensionsUpsert === 'function') {
        EditorPreload.onMyExtensionsUpsert(async (data) => {
          const { requestId, id, name, code } = data || {};
          let response;
          try {
            if (!code || String(code).trim().length < 10) {
              response = { success: false, error: 'Extension code is empty' };
            } else if (id) {
              const existing = getMyExtensionById(id);
              if (!existing) {
                response = { success: false, error: 'Extension not found in My Extensions' };
              } else {
                updateMyExtension(id, {
                  extensionURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code),
                  extensionFileName: name || existing.extensionFileName
                });
                response = { success: true, data: { id, updated: true } };
              }
            } else {
              const newId = generateId();
              addMyExtension({
                id: newId,
                name: name || 'My Extension',
                extensionURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code),
                extensionFileName: name || null,
                iconURL: '',
                unsandboxed: false,
                autoAddToNewProjects: false
              });
              response = { success: true, data: { id: newId, updated: false } };
            }
          } catch (e) {
            response = { success: false, error: (e && e.message) || String(e) };
          }
          EditorPreload.sendMyExtensionsUpsertResult({ requestId, ...response });
        });
      }

      // SOLO：窗口隐藏在后台时，主进程从这里拿完整 sb3 字节流写回源文件
      if (typeof EditorPreload.onSoloExportProject === 'function') {
        EditorPreload.onSoloExportProject(async (data) => {
          try {
            const buffer = await this.props.vm.saveProjectSb3('arraybuffer');
            EditorPreload.sendSoloExportProject({
              requestId: data && data.requestId,
              data: buffer
            });
          } catch (e) {
            EditorPreload.sendSoloExportProject({
              requestId: data && data.requestId,
              error: (e && e.message) || String(e)
            });
          }
        });
      }

      // SOLO：主进程发来"开始/停止转发舞台画面"的指令（选了 sb3 工程即开始）
      if (typeof EditorPreload.onSoloStageStream === 'function') {
        EditorPreload.onSoloStageStream((data) => {
          if (data && data.active) {
            startSoloStream(this.props.vm);
          } else {
            stopSoloStream();
          }
        });
      }

      // SOLO：舞台窗口上的绿旗/暂停/继续/停止按钮走这里控制后台 VM
      if (typeof EditorPreload.onSoloStageControl === 'function') {
        EditorPreload.onSoloStageControl((data) => {
          const result = handleSoloStageControl(this.props.vm, data && data.action);
          EditorPreload.sendSoloStageControl({
            requestId: data && data.requestId,
            result
          });
        });
      }

      // SOLO：舞台窗口提问框提交的"回答"，交给 VM 结束 ask and wait
      // （与 scratch-gui 自己的提问框回答方式一致：runtime emit ANSWER）
      if (typeof EditorPreload.onSoloStageAnswer === 'function') {
        EditorPreload.onSoloStageAnswer((data) => {
          try {
            this.props.vm.runtime.emit('ANSWER', String((data && data.text) ?? ''));
          } catch (e) {
            console.error('Failed to deliver solo stage answer:', e);
          }
        });
      }

      // SOLO：VM 运行状态变化时推给主进程（frameLoop 由我们的暂停/继续直接
      // start/stop，只有 RUNTIME_STARTED/STOPPED 事件会跟着发）
      if (typeof EditorPreload.onSoloStageRunStatus === 'function') {
        this.props.vm.on('RUNTIME_STARTED', () => {
          if (soloStreamActive) EditorPreload.sendSoloStageRunStatus({ running: true });
        });
        this.props.vm.on('RUNTIME_STOPPED', () => {
          if (soloStreamActive) EditorPreload.sendSoloStageRunStatus({ running: false });
        });
      }

      EditorPreload.onApplySprite(async (data) => {
        try {
          if (data.targetId) {
            this.props.vm.deleteSprite(data.targetId);
          }
          const spriteData = typeof data.spriteJSON === 'string' ? data.spriteJSON : JSON.stringify(data.spriteJSON);
          await this.props.vm.addSprite(spriteData);
        } catch (e) {
          console.error('Failed to apply sprite:', e);
        }
      });

      EditorPreload.onAIToolCall(async (data) => {
        const { requestId, toolName, params } = data;
        if (params) {
          // Generic snake_case → camelCase mapping for all params
          Object.keys(params).forEach(function(key) {
            if (key.indexOf('_') === -1) return;
            var camelKey = key.replace(/_([a-z])/g, function(_, c) { return c.toUpperCase(); });
            if (!params[camelKey]) params[camelKey] = params[key];
          });
        }
        const vm = this.props.vm;
        // 工程还没加载完时不执行 VM 类工具：等就绪或给明确报错（见 helper 注释）。
        // 慢工具（整包快照）主进程给了 180s 预算，等待预算也放宽到 170s。
        if (AI_TOOLS_NOT_REQUIRING_PROJECT.indexOf(toolName) === -1) {
          const waitBudgetMs = (toolName === 'captureProjectSnapshot' || toolName === 'restoreProjectSnapshot')
            ? 170000
            : 25000;
          const gateResult = await waitProjectReadyForTools(vm, waitBudgetMs);
          if (gateResult) {
            EditorPreload.sendAIToolResponse({ requestId, result: gateResult });
            return;
          }
        }
        let result = { success: false, error: 'Unknown tool' };
        try {
          switch (toolName) {
            case 'setSpriteProperty': {
              const propName = String(params.spriteName || params.sprite_name || '').trim();
              const propTarget = (params.targetId && vm.runtime.getTargetById(params.targetId)) ||
                vm.runtime.targets.find(t => !t.isStage && t.getName() === propName);
              if (!propTarget) {
                const names = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
                const hint = closestName(propName, names);
                result = { success: false, error: 'Sprite "' + propName + '" not found.' +
                  (hint ? ' Did you mean "' + hint + '"?' : '') +
                  ' Available: ' + (names.length ? names.join(', ') : '(none)') };
                break;
              }
              const propBefore = {
                x: Math.round(propTarget.x), y: Math.round(propTarget.y), size: propTarget.size,
                direction: propTarget.direction, visible: propTarget.visible
              };
              const propWarnings = [];
              const asNumber = (raw, label, min, max) => {
                const num = Number(raw);
                if (isNaN(num)) { propWarnings.push(label + ' "' + raw + '" is not a number and was ignored.'); return null; }
                // Scratch 自己会夹紧，但静默夹紧会让模型以为设成功了，说明一下
                if (num < min || num > max) {
                  propWarnings.push(label + ' ' + num + ' is outside ' + min + '–' + max + ' and was clamped by Scratch.');
                }
                return num;
              };
              if (params.x !== undefined) {
                const nx = asNumber(params.x, 'x', -240, 240);
                if (nx !== null) propTarget.setXY(nx, propTarget.y);
              }
              if (params.y !== undefined) {
                const ny = asNumber(params.y, 'y', -180, 180);
                if (ny !== null) propTarget.setXY(propTarget.x, ny);
              }
              if (params.size !== undefined) {
                const ns = asNumber(params.size, 'size', 5, 535);
                if (ns !== null) propTarget.setSize(ns);
              }
              if (params.direction !== undefined) {
                const nd = Number(params.direction);
                if (isNaN(nd)) propWarnings.push('direction "' + params.direction + '" is not a number and was ignored.');
                else propTarget.setDirection(nd);
              }
              if (params.visible !== undefined) {
                propTarget.setVisible(params.visible === true || params.visible === 'true');
              }
              if (params.draggable !== undefined) {
                propTarget.setDraggable(params.draggable === true || params.draggable === 'true');
              }
              if (params.rotationStyle !== undefined) {
                const STYLES = ['all around', 'left-right', "don't rotate"];
                const style = String(params.rotationStyle);
                if (STYLES.indexOf(style) < 0) {
                  propWarnings.push('rotationStyle must be one of: ' + STYLES.join(' / ') + '. Got "' + style + '", ignored.');
                } else {
                  propTarget.setRotationStyle(style);
                }
              }
              vm.runtime.emitProjectChanged();
              vm.emitTargetsUpdate();
              result = { success: true, data: {
                name: propTarget.getName(),
                before: propBefore,
                after: {
                  x: Math.round(propTarget.x), y: Math.round(propTarget.y), size: propTarget.size,
                  direction: propTarget.direction, visible: propTarget.visible,
                  draggable: propTarget.draggable, rotationStyle: propTarget.rotationStyle
                },
                warnings: propWarnings.length ? propWarnings : undefined
              } };
              break;
            }
            case 'getSpriteProperty': {
              const target = vm.runtime.getTargetById(params.targetId) || vm.runtime.targets.find(t => t.getName() === params.spriteName);
              if (!target) { result = { success: false, error: 'Sprite not found' }; break; }
              result = { success: true, data: { name: target.getName(), x: target.x, y: target.y, size: target.size, direction: target.direction, visible: target.visible, draggable: target.draggable, rotationStyle: target.rotationStyle, currentCostume: target.currentCostume, costumeCount: target.getCostumes().length } };
              break;
            }
            case 'getSpriteScripts': {
              // The AI tool sends sprite_name; older internal callers send spriteName.
              const scriptsTargetName = params.spriteName || params.sprite_name || 'Stage';
              const target = vm.runtime.targets.find(t => t.getName() === scriptsTargetName);
              if (!target) {
                const available = vm.runtime.targets.filter(t => t.isOriginal).map(t => t.getName()).join(', ');
                result = { success: false, error: 'Sprite "' + scriptsTargetName + '" not found. Available: ' + available };
                break;
              }
              const scripts = collectTargetDsl(target);
              result = { success: true, data: { spriteName: scriptsTargetName, scriptCount: scripts.length, scripts: scripts } };
              break;
            }
            case 'setVariable': {
              const varTargetInfo = resolveDataTarget(vm, params);
              if (!varTargetInfo.target) { result = { success: false, error: varTargetInfo.error }; break; }
              const varName = params.variableName || params.variable_name;
              const found = findDataVariable(vm, varTargetInfo.target, varName, '');
              if (!found.variable) { result = { success: false, error: found.error }; break; }
              if (params.value === undefined) {
                result = { success: false, error: 'No value provided. Pass value (number or text).' };
                break;
              }
              const previous = found.variable.value;
              // 走 VM 的 setVariableValue：云变量需要同步，直接改字段会漏掉
              const applied = vm.setVariableValue(found.owner.id, found.variable.id, coerceScratchValue(params.value));
              if (!applied) { result = { success: false, error: 'Failed to set variable "' + varName + '"' }; break; }
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: {
                name: found.variable.name, value: found.variable.value, previousValue: previous,
                scope: found.scope, owner: found.owner.getName()
              } };
              break;
            }
            case 'createVariable': {
              const newVarTargetInfo = resolveDataTarget(vm, params);
              if (!newVarTargetInfo.target) { result = { success: false, error: newVarTargetInfo.error }; break; }
              const newVarTarget = newVarTargetInfo.target;
              const newVarName = String(params.variableName || params.variable_name || '').trim();
              if (!newVarName) { result = { success: false, error: 'No variable name provided' }; break; }
              // 同名列表已存在：Scratch 允许，但模型几乎总是搞错了工具，先拦下来
              const clashingList = newVarTarget.lookupVariableByNameAndType(newVarName, 'list');
              if (clashingList) {
                result = { success: false, error: 'A list named "' + newVarName + '" already exists in this scope. Pick a different name, or use create_list if you meant a list.' };
                break;
              }
              const alreadyThere = findDataVariable(vm, newVarTarget, newVarName, '');
              if (alreadyThere.variable) {
                // 已存在就返回它，并把作用域说清楚（避免"我建了但代码里读不到"）
                result = { success: true, data: {
                  name: alreadyThere.variable.name, value: alreadyThere.variable.value,
                  existed: true, scope: alreadyThere.scope, owner: alreadyThere.owner.getName()
                } };
                break;
              }
              const newVarId = '_ai_var_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
              newVarTarget.createVariable(newVarId, newVarName, '', false);
              const createdVar = newVarTarget.variables[newVarId];
              if (createdVar) {
                const initial = params.initialValue !== undefined ? params.initialValue : params.initial_value;
                createdVar.value = initial !== undefined ? coerceScratchValue(initial) : 0;
              }
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: {
                name: newVarName, value: createdVar ? createdVar.value : 0, existed: false,
                scope: newVarTarget.isStage ? 'global' : 'local', owner: newVarTarget.getName()
              } };
              break;
            }
            case 'deleteVariable': {
              const delVarTargetInfo = resolveDataTarget(vm, params);
              if (!delVarTargetInfo.target) { result = { success: false, error: delVarTargetInfo.error }; break; }
              const delVarName = params.variableName || params.variable_name || params.listName || params.list_name;
              const delType = params.isList || params.is_list ? 'list' : '';
              const toDelete = findDataVariable(vm, delVarTargetInfo.target, delVarName, delType);
              if (!toDelete.variable) { result = { success: false, error: toDelete.error }; break; }
              // 仍被积木引用时删掉会留下空槽的积木，先告诉模型而不是默默破坏工程
              const referencing = [];
              vm.runtime.targets.forEach(t => {
                Object.keys(t.blocks._blocks).forEach(bid => {
                  const b = t.blocks._blocks[bid];
                  const f = b.fields && (b.fields.VARIABLE || b.fields.LIST);
                  if (f && f.id === toDelete.variable.id && referencing.indexOf(t.getName()) < 0) {
                    referencing.push(t.getName());
                  }
                });
              });
              if (referencing.length && !(params.force === true || params.force === 'true')) {
                result = { success: false, error: 'Still used by blocks in: ' + referencing.join(', ') +
                  '. Remove those blocks first, or pass force: true to delete anyway (the blocks will be left with an empty slot).' };
                break;
              }
              toDelete.owner.deleteVariable(toDelete.variable.id);
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: {
                name: delVarName, type: delType === 'list' ? 'list' : 'variable',
                owner: toDelete.owner.getName(), wasReferencedBy: referencing
              } };
              break;
            }
            case 'renameVariable': {
              const renVarTargetInfo = resolveDataTarget(vm, params);
              if (!renVarTargetInfo.target) { result = { success: false, error: renVarTargetInfo.error }; break; }
              const oldVarName = params.variableName || params.variable_name || params.listName || params.list_name;
              const newVarLabel = String(params.newName || params.new_name || '').trim();
              const renType = params.isList || params.is_list ? 'list' : '';
              if (!newVarLabel) { result = { success: false, error: 'No new name provided' }; break; }
              const toRename = findDataVariable(vm, renVarTargetInfo.target, oldVarName, renType);
              if (!toRename.variable) { result = { success: false, error: toRename.error }; break; }
              const taken = toRename.owner.lookupVariableByNameAndType(newVarLabel, renType);
              if (taken) { result = { success: false, error: 'A ' + (renType === 'list' ? 'list' : 'variable') + ' named "' + newVarLabel + '" already exists in that scope.' }; break; }
              // renameVariable 会顺带更新引用它的积木字段
              toRename.owner.renameVariable(toRename.variable.id, newVarLabel);
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: { oldName: oldVarName, newName: newVarLabel, owner: toRename.owner.getName() } };
              break;
            }
            case 'createList': {
              const newListTargetInfo = resolveDataTarget(vm, params);
              if (!newListTargetInfo.target) { result = { success: false, error: newListTargetInfo.error }; break; }
              const newListTarget = newListTargetInfo.target;
              const newListName = String(params.listName || params.list_name || '').trim();
              if (!newListName) { result = { success: false, error: 'No list name provided' }; break; }
              const clashingVar = newListTarget.lookupVariableByNameAndType(newListName, '');
              if (clashingVar) {
                result = { success: false, error: 'A variable named "' + newListName + '" already exists in this scope. Pick a different name, or use create_variable if you meant a variable.' };
                break;
              }
              const listExists = findDataVariable(vm, newListTarget, newListName, 'list');
              if (listExists.variable) {
                const existingItems = Array.isArray(listExists.variable.value) ? listExists.variable.value : [];
                result = { success: true, data: Object.assign({
                  name: listExists.variable.name, existed: true,
                  scope: listExists.scope, owner: listExists.owner.getName()
                }, listPreview(existingItems)) };
                break;
              }
              const newListId = '_ai_list_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
              newListTarget.createVariable(newListId, newListName, 'list', false);
              const createdList = newListTarget.variables[newListId];
              if (createdList) {
                const seedItems = params.items !== undefined ? params.items : params.initialItems;
                createdList.value = Array.isArray(seedItems) ? seedItems.map(coerceScratchValue) : [];
              }
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: Object.assign({
                name: newListName, existed: false,
                scope: newListTarget.isStage ? 'global' : 'local', owner: newListTarget.getName()
              }, listPreview(createdList ? createdList.value : [])) };
              break;
            }
            case 'getVariable': {
              const getVarTargetInfo = resolveDataTarget(vm, params);
              if (!getVarTargetInfo.target) { result = { success: false, error: getVarTargetInfo.error }; break; }
              const getVarName = params.variableName || params.variable_name;
              const gotVar = findDataVariable(vm, getVarTargetInfo.target, getVarName, '');
              if (!gotVar.variable) { result = { success: false, error: gotVar.error }; break; }
              result = { success: true, data: {
                name: gotVar.variable.name, value: gotVar.variable.value,
                scope: gotVar.scope, owner: gotVar.owner.getName(), isCloud: !!gotVar.variable.isCloud
              } };
              break;
            }
            case 'addToList': {
              const addListTargetInfo = resolveDataTarget(vm, params);
              if (!addListTargetInfo.target) { result = { success: false, error: addListTargetInfo.error }; break; }
              const addListTarget = addListTargetInfo.target;
              const addListName = String(params.listName || params.list_name || '').trim();
              if (!addListName) { result = { success: false, error: 'No list name provided' }; break; }
              // 支持一次追加多项：模型常需要填一整批数据
              const rawItems = params.items !== undefined ? params.items : params.item;
              if (rawItems === undefined || rawItems === null) {
                result = { success: false, error: 'No item provided. Pass item (one value) or items (an array).' };
                break;
              }
              const toAppend = (Array.isArray(rawItems) ? rawItems : [rawItems]).map(coerceScratchValue);
              let addList = null;
              let addCreated = false;
              const addFound = findDataVariable(vm, addListTarget, addListName, 'list');
              if (addFound.variable) {
                addList = addFound.variable;
              } else {
                // 同名变量存在时不要静默建列表，那会造出两个同名东西
                if (addListTarget.lookupVariableByNameAndType(addListName, '')) {
                  result = { success: false, error: 'A variable named "' + addListName + '" already exists in this scope, so a list cannot share that name.' };
                  break;
                }
                const autoId = '_ai_list_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                addListTarget.createVariable(autoId, addListName, 'list', false);
                addList = addListTarget.variables[autoId];
                addCreated = true;
              }
              if (!Array.isArray(addList.value)) addList.value = [];
              toAppend.forEach(function(v) { addList.value.push(v); });
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: Object.assign({
                listName: addListName, added: toAppend.length, createdList: addCreated,
                owner: (addFound.owner || addListTarget).getName()
              }, listPreview(addList.value)) };
              break;
            }
            case 'deleteFromList': {
              const delItemTargetInfo = resolveDataTarget(vm, params);
              if (!delItemTargetInfo.target) { result = { success: false, error: delItemTargetInfo.error }; break; }
              const delItemName = params.listName || params.list_name;
              const delItemFound = findDataVariable(vm, delItemTargetInfo.target, delItemName, 'list');
              if (!delItemFound.variable) { result = { success: false, error: delItemFound.error }; break; }
              const delItemList = delItemFound.variable;
              if (!Array.isArray(delItemList.value)) delItemList.value = [];
              const delToken = String(params.index === undefined ? '' : params.index).trim().toLowerCase();
              let removed = null;
              if (delToken === 'all') {
                removed = delItemList.value.length;
                delItemList.value = [];
              } else {
                if (delItemList.value.length === 0) {
                  result = { success: false, error: 'List "' + delItemName + '" is already empty.' };
                  break;
                }
                const delIdx = resolveListIndex(params.index, delItemList.value.length, {});
                if (delIdx.error) { result = { success: false, error: delIdx.error }; break; }
                removed = delItemList.value.splice(delIdx.index, 1)[0];
              }
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: Object.assign({
                listName: delItemName,
                removed: delToken === 'all' ? undefined : removed,
                removedCount: delToken === 'all' ? removed : 1,
                owner: delItemFound.owner.getName()
              }, listPreview(delItemList.value)) };
              break;
            }
            case 'getList': {
              const getListTargetInfo = resolveDataTarget(vm, params);
              if (!getListTargetInfo.target) { result = { success: false, error: getListTargetInfo.error }; break; }
              const getListName = params.listName || params.list_name;
              const gotList = findDataVariable(vm, getListTargetInfo.target, getListName, 'list');
              if (!gotList.variable) { result = { success: false, error: gotList.error }; break; }
              const allItems = Array.isArray(gotList.variable.value) ? gotList.variable.value : [];
              // 默认给完整内容；超长时按 limit 截断并说明还剩多少
              const limit = params.limit !== undefined ? Math.max(1, parseInt(params.limit, 10) || 100) : 200;
              result = { success: true, data: Object.assign({
                name: gotList.variable.name, scope: gotList.scope, owner: gotList.owner.getName()
              }, listPreview(allItems, limit)) };
              break;
            }
            case 'deleteSprite': {
              const delSpriteName = String(params.spriteName || params.sprite_name || '').trim();
              const delSprite = (params.targetId && vm.runtime.getTargetById(params.targetId)) ||
                vm.runtime.targets.find(t => !t.isStage && t.getName() === delSpriteName);
              if (!delSprite) {
                const names = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
                const hint = closestName(delSpriteName, names);
                result = { success: false, error: 'Sprite "' + delSpriteName + '" not found.' +
                  (hint ? ' Did you mean "' + hint + '"?' : '') +
                  ' Available: ' + (names.length ? names.join(', ') : '(none)') };
                break;
              }
              if (delSprite.isStage) { result = { success: false, error: 'The Stage cannot be deleted.' }; break; }
              // 删角色会一并丢掉它的脚本/造型/局部变量，先把这些数出来放进返回值，
              // 让模型（和用户）看到代价，而不是只回一个 success。
              const lostScripts = Object.keys(delSprite.blocks._blocks)
                .filter(id => delSprite.blocks._blocks[id].topLevel).length;
              const lostVars = Object.values(delSprite.variables).filter(v => v.type !== 'list').map(v => v.name);
              const lostLists = Object.values(delSprite.variables).filter(v => v.type === 'list').map(v => v.name);
              const removedName = delSprite.getName();
              vm.deleteSprite(delSprite.id);
              vm.runtime.emitProjectChanged();
              vm.emitTargetsUpdate();
              result = { success: true, data: {
                name: removedName, deletedScripts: lostScripts,
                deletedVariables: lostVars, deletedLists: lostLists,
                remainingSprites: vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName())
              } };
              break;
            }
            case 'renameSprite': {
              const renOldName = String(params.spriteName || params.sprite_name || params.sourceName || params.source_name || '').trim();
              const renNewName = String(params.newName || params.new_name || '').trim();
              if (!renNewName) { result = { success: false, error: 'No new name provided' }; break; }
              const renSprite = vm.runtime.targets.find(t => !t.isStage && t.getName() === renOldName);
              if (!renSprite) {
                const names = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
                result = { success: false, error: 'Sprite "' + renOldName + '" not found. Available: ' +
                  (names.length ? names.join(', ') : '(none)') };
                break;
              }
              const nameTaken = vm.runtime.targets.some(t => !t.isStage && t.id !== renSprite.id && t.getName() === renNewName);
              if (nameTaken) { result = { success: false, error: 'A sprite named "' + renNewName + '" already exists.' }; break; }
              vm.renameSprite(renSprite.id, renNewName);
              // renameSprite 遇到保留字或重名会静默改成别的名字，回报实际结果
              const actualName = renSprite.getName();
              vm.runtime.emitProjectChanged();
              vm.emitTargetsUpdate();
              result = { success: true, data: {
                oldName: renOldName, newName: actualName,
                renamedAsRequested: actualName === renNewName
              } };
              break;
            }
            case 'getAllSprites': {
              const spriteInfos = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => ({
                name: t.getName(), x: Math.round(t.x), y: Math.round(t.y), size: t.size,
                direction: t.direction, visible: t.visible, draggable: t.draggable,
                rotationStyle: t.rotationStyle,
                currentCostume: t.currentCostume + 1,
                costumes: t.getCostumes().map(c => c.name),
                sounds: t.getSounds().map(s => s.name),
                scriptCount: Object.keys(t.blocks._blocks).filter(id => t.blocks._blocks[id].topLevel).length,
                variables: Object.values(t.variables).filter(v => v.type !== 'list').map(v => v.name),
                lists: Object.values(t.variables).filter(v => v.type === 'list').map(v => v.name)
              }));
              const stageTarget = vm.runtime.getTargetForStage();
              result = { success: true, data: {
                spriteCount: spriteInfos.length,
                sprites: spriteInfos,
                stage: stageTarget ? {
                  backdrops: stageTarget.getCostumes().map(c => c.name),
                  currentBackdrop: stageTarget.currentCostume + 1,
                  globalVariables: Object.values(stageTarget.variables).filter(v => v.type !== 'list').map(v => v.name),
                  globalLists: Object.values(stageTarget.variables).filter(v => v.type === 'list').map(v => v.name)
                } : null
              } };
              break;
            }
            case 'getAllVariables': {
              const varRows = [];
              vm.runtime.targets.filter(t => t.isStage || t.isOriginal).forEach(t => {
                Object.values(t.variables).filter(v => v.type !== 'list').forEach(v => {
                  varRows.push({
                    name: v.name, value: v.value,
                    owner: t.getName(), scope: t.isStage ? 'global' : 'local',
                    isCloud: !!v.isCloud
                  });
                });
              });
              result = { success: true, data: { count: varRows.length, variables: varRows } };
              break;
            }
            case 'getAllLists': {
              const listRows = [];
              vm.runtime.targets.filter(t => t.isStage || t.isOriginal).forEach(t => {
                Object.values(t.variables).filter(v => v.type === 'list').forEach(l => {
                  const items = Array.isArray(l.value) ? l.value : [];
                  listRows.push(Object.assign({
                    name: l.name, owner: t.getName(), scope: t.isStage ? 'global' : 'local'
                  }, listPreview(items, 10)));
                });
              });
              result = { success: true, data: { count: listRows.length, lists: listRows } };
              break;
            }
            case 'getProjectSummary': {
              const targets = vm.runtime.targets;
              const stage = targets.find(t => t.isStage);
              function getScriptInfo(t) {
                var blks = t.blocks._blocks;
                var topBlocks = [];
                Object.keys(blks).forEach(function(bId) {
                  var b = blks[bId];
                  if (b.topLevel && b.parent === null) topBlocks.push(b.opcode);
                });
                return { scriptCount: topBlocks.length, scripts: topBlocks };
              }
              const spriteList = targets.filter(t => !t.isStage).map(t => ({
                name: t.getName(), x: t.x, y: t.y, size: t.size, direction: t.direction,
                visible: t.visible, costumeCount: t.getCostumes().length,
                variables: Object.values(t.variables).filter(v => v.type !== 'list').map(v => ({ name: v.name, value: v.value })),
                lists: Object.values(t.variables).filter(v => v.type === 'list').map(v => ({ name: v.name, length: v.value.length })),
                scriptCount: getScriptInfo(t).scriptCount, scripts: getScriptInfo(t).scripts
              }));
              var stageScriptInfo = stage ? getScriptInfo(stage) : { scriptCount: 0, scripts: [] };
              result = { success: true, data: {
                spriteCount: spriteList.length, sprites: spriteList,
                stageVariables: stage ? Object.values(stage.variables).filter(v => v.type !== 'list').map(v => ({ name: v.name, value: v.value })) : [],
                stageLists: stage ? Object.values(stage.variables).filter(v => v.type === 'list').map(v => ({ name: v.name, length: v.value.length })) : [],
                stageScriptCount: stageScriptInfo.scriptCount, stageScripts: stageScriptInfo.scripts
              } };
              break;
            }
            case 'getSpriteLibrary': {
              try {
                const libModule = await import(
                  /* webpackChunkName: "sprite-library" */
                  'scratch-gui/src/lib/libraries/tw-async-libraries'
                );
                const getLib = libModule.getSpriteLibrary;
                const library = getLib();
                const libData = library && library.then ? await library : library;
                if (!libData || !Array.isArray(libData)) {
                  result = { success: false, error: 'Sprite library not available' };
                  break;
                }
                const sprites = libData.map(function(s) {
                  return { name: s.name, tags: s.tags || [] };
                });
                result = { success: true, data: { count: sprites.length, sprites: sprites } };
              } catch (e) {
                result = { success: false, error: 'Failed to load sprite library: ' + (e.message || String(e)) };
              }
              break;
            }
            case 'addSprite': {
              const spriteName = String(params.spriteName || params.sprite_name || params.name || '').trim();
              if (spriteName) {
                // Named sprite: load from built-in library
                const storage = vm.runtime.storage;
                const libModule = await import(
                  /* webpackChunkName: "sprite-library" */
                  'scratch-gui/src/lib/libraries/tw-async-libraries'
                );
                const getLib = libModule.getSpriteLibrary;
                const library = getLib();
                const libData = library && library.then ? await library : library;
                if (!libData || !Array.isArray(libData) || libData.length === 0) {
                  result = { success: false, error: 'Sprite library not available' };
                  break;
                }
                const searchLower = spriteName.toLowerCase();
                let match = libData.find(s => s.name.toLowerCase() === searchLower);
                if (!match) {
                  match = libData.find(s => s.name.toLowerCase().includes(searchLower) || searchLower.includes(s.name.toLowerCase()));
                }
                if (!match) {
                  const available = libData.slice(0, 30).map(s => s.name).join(', ');
                  result = { success: false, error: 'Sprite "' + spriteName + '" not found in library. Available: ' + available };
                  break;
                }
                // Data structure: match.costumes[] is the source of truth (no top-level md5/info/json)
                const firstCostume = (match.costumes && match.costumes[0]) || {};
                const md5ext = firstCostume.md5ext || (firstCostume.assetId ? firstCostume.assetId + '.' + (firstCostume.dataFormat || 'svg') : '');
                if (!md5ext) {
                  result = { success: false, error: 'Sprite "' + spriteName + '" has no costume md5ext in library data' };
                  break;
                }
                const dotIdx = md5ext.lastIndexOf('.');
                const assetId = dotIdx > 0 ? md5ext.substring(0, dotIdx) : md5ext;
                const dataFormat = dotIdx > 0 ? md5ext.substring(dotIdx + 1) : 'svg';
                const assetType = dataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                let asset = null;
                try {
                  asset = await storage.load(assetType, assetId);
                } catch (loadErr) {
                  // Multi-source fallback: assets.scratch.mit.edu → cdn.assets.scratch.mit.edu
                  const assetSources = [
                    'https://assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/',
                    'https://cdn.assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/'
                  ];
                  for (let srcIdx = 0; srcIdx < assetSources.length; srcIdx++) {
                    try {
                      const buffer = await EditorPreload.fetchImage(assetSources[srcIdx]);
                      const newAssetId = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                      asset = storage.builtinHelper.get(newAssetId);
                      break;
                    } catch (fetchErr) {
                      // try next source
                    }
                  }
                  if (!asset) {
                    result = { success: false, error: 'Failed to load sprite asset "' + md5ext + '": all sources failed (assets.scratch.mit.edu and cdn.assets.scratch.mit.edu)' };
                    break;
                  }
                }
                if (!asset) {
                  result = { success: false, error: 'Failed to load sprite asset "' + md5ext + '": asset is null' };
                  break;
                }
                const rcX = firstCostume.rotationCenterX != null ? firstCostume.rotationCenterX : 47;
                const rcY = firstCostume.rotationCenterY != null ? firstCostume.rotationCenterY : 47;
                const costume = {
                  assetId: assetId,
                  name: firstCostume.name || match.name,
                  md5ext: md5ext,
                  dataFormat: dataFormat,
                  rotationCenterX: rcX,
                  rotationCenterY: rcY,
                  bitmapResolution: firstCostume.bitmapResolution || (dataFormat === 'svg' ? 1 : 2),
                  asset: asset
                };
                const spriteObj = {
                  isStage: false,
                  name: spriteName,
                  variables: {},
                  lists: {},
                  broadcasts: {},
                  blocks: {},
                  comments: {},
                  currentCostume: 0,
                  costumes: [costume],
                  sounds: [],
                  volume: 100,
                  layerOrder: vm.runtime.targets.length,
                  visible: true,
                  x: 0,
                  y: 0,
                  size: 100,
                  direction: 90,
                  draggable: false,
                  rotationStyle: 'all around'
                };
                // Load additional costumes from match.costumes array (skip index 0, already loaded)
                try {
                  if (match.sounds && match.sounds.length > 0) {
                    spriteObj.sounds = match.sounds;
                  }
                  if (match.costumes && match.costumes.length > 1) {
                    for (let ci = 1; ci < match.costumes.length; ci++) {
                      const c = match.costumes[ci];
                      const cMd5ext = c.md5ext || (c.assetId ? c.assetId + '.' + (c.dataFormat || 'svg') : '');
                      if (!cMd5ext) continue;
                      const cDotIdx = cMd5ext.lastIndexOf('.');
                      const cAssetId = cDotIdx > 0 ? cMd5ext.substring(0, cDotIdx) : cMd5ext;
                      const cDataFormat = cDotIdx > 0 ? cMd5ext.substring(cDotIdx + 1) : 'svg';
                      const cAssetType = cDataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                      let cAsset = null;
                      try { cAsset = await storage.load(cAssetType, cAssetId); } catch (e) {}
                      if (!cAsset) {
                        const cSources = [
                          'https://assets.scratch.mit.edu/internalapi/asset/' + cMd5ext + '/get/',
                          'https://cdn.assets.scratch.mit.edu/internalapi/asset/' + cMd5ext + '/get/'
                        ];
                        for (let csIdx = 0; csIdx < cSources.length; csIdx++) {
                          try {
                            const cBuf = await EditorPreload.fetchImage(cSources[csIdx]);
                            const cAid = storage.builtinHelper._store(cAssetType, cDataFormat, new Uint8Array(cBuf), null);
                            cAsset = storage.builtinHelper.get(cAid);
                            break;
                          } catch (e2) {}
                        }
                      }
                      if (cAsset) {
                        spriteObj.costumes.push({
                          assetId: cAssetId,
                          name: c.name || 'costume' + (ci + 1),
                          md5ext: cMd5ext,
                          dataFormat: cDataFormat,
                          rotationCenterX: c.rotationCenterX != null ? c.rotationCenterX : 47,
                          rotationCenterY: c.rotationCenterY != null ? c.rotationCenterY : 47,
                          bitmapResolution: c.bitmapResolution || (cDataFormat === 'svg' ? 1 : 2),
                          asset: cAsset
                        });
                      }
                    }
                  }
                } catch (multiCostumeErr) {
                  // Multi-costume loading failed, continue with single costume
                }
                await vm.addSprite(spriteObj);
                const newTarget = vm.runtime.targets[vm.runtime.targets.length - 1];
                // Scratch 遇到重名会自动加序号，库里的匹配名也可能与请求名不同；
                // 回报实际落地的名字，否则模型下一步会按错名字去找这个角色。
                const addedName = newTarget ? newTarget.getName() : spriteName;
                result = { success: true, data: {
                  name: addedName, requestedName: spriteName, matchedName: match.name,
                  renamedByScratch: addedName !== spriteName,
                  id: newTarget ? newTarget.id : null, source: 'library',
                  costumes: newTarget ? newTarget.getCostumes().map(c => c.name) : [],
                  sounds: newTarget ? newTarget.getSounds().map(sd => sd.name) : []
                } };
              } else {
                // No spriteName: create blank rectangle sprite
                try {
                const blankName = 'Sprite' + (vm.runtime.targets.length);
                const storage = vm.runtime.storage;
                const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#4c97ff"/></svg>';
                const data = new TextEncoder().encode(svgContent);
                const assetId = storage.builtinHelper._store(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, null);
                const asset = storage.builtinHelper.get(assetId);
                const costume = { assetId: assetId, name: 'costume1', md5ext: assetId + '.svg', dataFormat: 'svg', rotationCenterX: 50, rotationCenterY: 50, bitmapResolution: 1, asset: asset };
                const spriteObj = { isStage: false, name: blankName, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [costume], sounds: [], volume: 100, layerOrder: vm.runtime.targets.length, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' };
                await vm.addSprite(spriteObj);
                const newTarget = vm.runtime.targets[vm.runtime.targets.length - 1];
                result = { success: true, data: { name: blankName, id: newTarget ? newTarget.id : null, source: 'blank' } };
                } catch (blankErr) { result = { success: false, error: 'Failed to add blank sprite: ' + (blankErr.message || String(blankErr)) }; }
              }
              break;
            }
            case 'addSpriteFromLibrary': {
              try {
                const spriteName = (params.spriteName || params.name || '').trim();
                if (!spriteName) { result = { success: false, error: 'No sprite name provided' }; break; }
                const storage = vm.runtime.storage;
                const libModule = await import(
                  /* webpackChunkName: "sprite-library" */
                  'scratch-gui/src/lib/libraries/tw-async-libraries'
                );
                const getLib = libModule.getSpriteLibrary;
                const library = getLib();
                const libData = library && library.then ? await library : library;
                if (!libData || !Array.isArray(libData) || libData.length === 0) {
                  result = { success: false, error: 'Sprite library not available' };
                  break;
                }
                const searchLower = spriteName.toLowerCase();
                let match = libData.find(s => s.name.toLowerCase() === searchLower);
                if (!match) {
                  match = libData.find(s => s.name.toLowerCase().includes(searchLower) || searchLower.includes(s.name.toLowerCase()));
                }
                if (!match) {
                  const available = libData.slice(0, 30).map(s => s.name).join(', ');
                  result = { success: false, error: 'Sprite "' + spriteName + '" not found in library. Available: ' + available };
                  break;
                }
                const firstCostume = (match.costumes && match.costumes[0]) || {};
                const md5ext = firstCostume.md5ext || (firstCostume.assetId ? firstCostume.assetId + '.' + (firstCostume.dataFormat || 'svg') : '');
                if (!md5ext) {
                  result = { success: false, error: 'Sprite "' + spriteName + '" has no costume md5ext in library data' };
                  break;
                }
                const dotIdx = md5ext.lastIndexOf('.');
                const assetId = dotIdx > 0 ? md5ext.substring(0, dotIdx) : md5ext;
                const dataFormat = dotIdx > 0 ? md5ext.substring(dotIdx + 1) : 'svg';
                const assetType = dataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                let asset = null;
                try {
                  asset = await storage.load(assetType, assetId);
                } catch (loadErr) {
                  // Multi-source fallback: assets.scratch.mit.edu → cdn.assets.scratch.mit.edu
                  const assetSources = [
                    'https://assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/',
                    'https://cdn.assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/'
                  ];
                  for (let srcIdx = 0; srcIdx < assetSources.length; srcIdx++) {
                    try {
                      const buffer = await EditorPreload.fetchImage(assetSources[srcIdx]);
                      const newAssetId = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                      asset = storage.builtinHelper.get(newAssetId);
                      break;
                    } catch (fetchErr) {
                      // try next source
                    }
                  }
                  if (!asset) {
                    result = { success: false, error: 'Failed to load sprite asset "' + md5ext + '": all sources failed' };
                    break;
                  }
                }
                if (!asset) {
                  result = { success: false, error: 'Failed to load sprite asset "' + md5ext + '": asset is null' };
                  break;
                }
                const rcX = firstCostume.rotationCenterX != null ? firstCostume.rotationCenterX : 47;
                const rcY = firstCostume.rotationCenterY != null ? firstCostume.rotationCenterY : 47;
                const costume = {
                  assetId: assetId,
                  name: firstCostume.name || match.name,
                  md5ext: md5ext,
                  dataFormat: dataFormat,
                  rotationCenterX: rcX,
                  rotationCenterY: rcY,
                  bitmapResolution: firstCostume.bitmapResolution || (dataFormat === 'svg' ? 1 : 2),
                  asset: asset
                };
                const spriteObj = {
                  isStage: false, name: match.name, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
                  currentCostume: 0, costumes: [costume], sounds: match.sounds || [], volume: 100,
                  layerOrder: vm.runtime.targets.length, visible: true, x: 0, y: 0, size: 100, direction: 90,
                  draggable: false, rotationStyle: 'all around'
                };
                await vm.addSprite(spriteObj);
                const newTarget = vm.runtime.targets[vm.runtime.targets.length - 1];
                result = { success: true, data: { name: match.name, id: newTarget ? newTarget.id : null } };
              } catch (e2) { result = { success: false, error: 'Failed to add sprite from library: ' + (e2.message || String(e2)) }; }
              break;
            }
            case 'addCostumeFromLibrary': {
              try {
                const spriteName = params.spriteName || '';
                const costumeName = (params.costumeName || params.name || '').trim();
                if (!costumeName) { result = { success: false, error: 'No costume name provided' }; break; }
                const target = vm.runtime.targets.find(t => t.getName() === spriteName);
                if (!target) { result = { success: false, error: 'Sprite "' + spriteName + '" not found' }; break; }
                const storage = vm.runtime.storage;
                const libModule = await import(
                  /* webpackChunkName: "costume-library" */
                  'scratch-gui/src/lib/libraries/tw-async-libraries'
                );
                const getLib = libModule.getCostumeLibrary;
                const library = getLib();
                const libData = library && library.then ? await library : library;
                if (!libData || !Array.isArray(libData) || libData.length === 0) {
                  result = { success: false, error: 'Costume library not available' };
                  break;
                }
                const searchLower = costumeName.toLowerCase();
                let match = libData.find(c => c.name.toLowerCase() === searchLower);
                if (!match) {
                  match = libData.find(c => c.name.toLowerCase().includes(searchLower) || searchLower.includes(c.name.toLowerCase()));
                }
                if (!match) {
                  const available = libData.slice(0, 30).map(c => c.name).join(', ');
                  result = { success: false, error: 'Costume "' + costumeName + '" not found. Available: ' + available };
                  break;
                }
                const md5ext = match.md5ext;
                const dotIdx = md5ext.lastIndexOf('.');
                const assetId = dotIdx > 0 ? md5ext.substring(0, dotIdx) : md5ext;
                const dataFormat = dotIdx > 0 ? md5ext.substring(dotIdx + 1) : 'svg';
                const assetType = dataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                let asset = null;
                try {
                  asset = await storage.load(assetType, assetId);
                } catch (loadErr) {
                  // Multi-source fallback: assets.scratch.mit.edu → cdn.assets.scratch.mit.edu
                  const assetSources = [
                    'https://assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/',
                    'https://cdn.assets.scratch.mit.edu/internalapi/asset/' + md5ext + '/get/'
                  ];
                  for (let srcIdx = 0; srcIdx < assetSources.length; srcIdx++) {
                    try {
                      const buffer = await EditorPreload.fetchImage(assetSources[srcIdx]);
                      const newAssetId = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                      asset = storage.builtinHelper.get(newAssetId);
                      break;
                    } catch (fetchErr) {
                      // try next source
                    }
                  }
                  if (!asset) {
                    result = { success: false, error: 'Failed to load costume asset "' + md5ext + '": all sources failed (assets.scratch.mit.edu and cdn.assets.scratch.mit.edu)' };
                    break;
                  }
                }
                if (!asset) {
                  result = { success: false, error: 'Failed to load costume asset "' + md5ext + '": asset is null after load attempts' };
                  break;
                }
                const rcX = match.rotationCenterX != null ? match.rotationCenterX : 47;
                const rcY = match.rotationCenterY != null ? match.rotationCenterY : 47;
                const costume = {
                  assetId: assetId, name: match.name, md5ext: md5ext, dataFormat: dataFormat,
                  rotationCenterX: rcX, rotationCenterY: rcY,
                  bitmapResolution: match.bitmapResolution || (dataFormat === 'svg' ? 1 : 2), asset: asset
                };
                target.addCostume(costume);
                target.setCostume(target.getCostumes().length - 1);
                vm.runtime.emitProjectChanged();
                result = { success: true, data: { costumeName: match.name, spriteName: spriteName } };
              } catch (e2) { result = { success: false, error: 'Failed to add costume from library: ' + (e2.message || String(e2)) }; }
              break;
            }
            case 'addBackdrop': {
              try {
                const backdropName = params.backdropName || 'Backdrop';
                const storage = vm.runtime.storage;
                const bgColors = { space: '#0a0a2e', arctic: '#d6eaf8', underwater: '#1a5276', desert: '#e8c27a', forest: '#1e5631', night: '#0a0a1a', city: '#4a5568', castle: '#5c4033', garden: '#7dcea0', savanna: '#c9a96e', classroom: '#fef9e7', room: '#e8dcc8', beach: '#f9e79f', mountain: '#7f8c8d', rainbow: '#e8daef' };
                const searchName = (backdropName || '').toLowerCase();
                let bgColor = '#5cb1d6';
                Object.keys(bgColors).forEach(k => { if (searchName.includes(k)) bgColor = bgColors[k]; });
                const backdropSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + bgColor + '" stop-opacity="0.9"/><stop offset="100%" stop-color="' + bgColor + '" stop-opacity="0.5"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/><rect width="480" height="360" fill="' + bgColor + '" opacity="0.4"/></svg>';
                const data = new TextEncoder().encode(backdropSvg);
                const assetId = storage.builtinHelper._store(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, null);
                const asset = storage.builtinHelper.get(assetId);
                const costume = { name: backdropName, assetId: assetId, md5ext: assetId + '.svg', dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180, bitmapResolution: 1, asset: asset };
                await vm.addBackdrop(costume.md5ext, costume);
                result = { success: true, data: { name: backdropName } };
              } catch (e2) { result = { success: false, error: 'Failed to add backdrop: ' + (e2.message || String(e2)) }; }
              break;
            }
            case 'addScript': {
              try {
                const targetName = params.spriteName || params.sprite_name || 'Stage';
                const target = vm.runtime.targets.find(t => t.getName() === targetName);
                if (!target) { result = { success: false, error: 'Target "' + targetName + '" not found' }; break; }
                let scriptText = params.script || '';
                if (!scriptText) { result = { success: false, error: 'No script provided. You passed: ' + JSON.stringify(params).substring(0, 200) + '. The "script" parameter MUST be a DSL text string like "event_whenflagclicked\\n  motion_movesteps 10", NOT a JSON object.' }; break; }
                if (typeof scriptText === 'object') {
                  try {
                    var converted = convertBlockObjToDsl(scriptText, 0, target && target.runtime);
                    scriptText = converted.join('\n');
                  } catch (convErr) {
                    result = { success: false, error: 'Failed to convert script object to DSL text: ' + (convErr.message || String(convErr)) + '. Please pass a DSL text string instead. Example: "event_whenflagclicked\\n  motion_movesteps 10"' };
                    break;
                  }
                }
                if (typeof scriptText !== 'string') { result = { success: false, error: 'Script must be a DSL text string (not ' + typeof scriptText + '). Example: "event_whenflagclicked\\n  motion_movesteps 10"' }; break; }
                let parsed;
                try {
                  parsed = parseScratchDSL(scriptText, target);
                } catch (parseErr) {
                  result = { success: false, error: 'DSL parse error: ' + (parseErr.message || String(parseErr)) + '\nScript text (first 500 chars):\n' + scriptText.substring(0, 500) };
                  break;
                }
                var validation = validateParsedScript(parsed, target);
                if (validation.errors.length > 0) {
                  // Refuse before creating anything: a half-built script is worse than none.
                  result = { success: false, error: formatValidationError(validation.errors, scriptText) };
                  break;
                }
                var allWarnings = (parsed.warnings || []).concat(validation.warnings);

                var built = buildScriptBlocks(parsed, target);
                var allBlocks = built.blocks;
                allBlocks.forEach(function(b) { target.blocks.createBlock(b); });
                vm.runtime.emitProjectChanged();
                vm.emitWorkspaceUpdate();
                vm.emitTargetsUpdate();
                result = { success: true, data: { targetName: targetName, blocksAdded: allBlocks.length, warnings: allWarnings.length ? allWarnings : undefined } };
              } catch (e2) {
                result = {
                  success: false,
                  error: 'Failed to add blocks: ' + (e2.message || String(e2)) +
                    '\nBlocks attempted: ' + (typeof allBlocks !== 'undefined' ? allBlocks.length : 0) +
                    '\nLast opcode: ' + (typeof allBlocks !== 'undefined' && allBlocks.length > 0 ? allBlocks[allBlocks.length - 1].opcode : 'unknown')
                };
              }
              break;
            }
            case 'executeOperations': {
              try {
                const operationsStr = params.operations || '[]';
                const contextMapping = params.contextMapping || {};
                const operations = typeof operationsStr === 'string' ? JSON.parse(operationsStr) : operationsStr;
                if (!Array.isArray(operations)) { result = { success: false, error: 'operations must be an array' }; break; }

                const opResults = [];

                function resolveBlockId(tid) {
                  const entry = contextMapping[tid];
                  if (!entry) return null;
                  const target = vm.runtime.targets.find(t => t.getName() === entry.sprite);
                  if (!target) return null;
                  const block = target.blocks.getBlock(entry.blockId);
                  return block ? { blockId: entry.blockId, target: target } : null;
                }

                function getTarget(spriteName) {
                  return vm.runtime.targets.find(t => t.getName() === spriteName) || null;
                }


                for (let opIdx = 0; opIdx < operations.length; opIdx++) {
                  const op = operations[opIdx];
                  try {
                    switch (op.type) {
                      case 'add_script': {
                        const target = getTarget(op.sprite);
                        if (!target) { opResults.push({ index: opIdx, type: 'add_script', success: false, error: 'Sprite not found: ' + op.sprite }); break; }
                        let scriptText = op.script;
                        if (!scriptText) { opResults.push({ index: opIdx, type: 'add_script', success: false, error: 'No script provided. You passed: ' + JSON.stringify(op).substring(0, 200) + '. The "script" field MUST be a DSL text string like "event_whenflagclicked\\n  motion_movesteps 10", NOT a JSON object.' }); break; }
                        if (typeof scriptText === 'object') {
                          try {
                            var eoConverted = convertBlockObjToDsl(scriptText, 0, target && target.runtime);
                            scriptText = eoConverted.join('\n');
                          } catch (eoConvErr) {
                            opResults.push({ index: opIdx, type: 'add_script', success: false, error: 'Failed to convert script object to DSL: ' + (eoConvErr.message || String(eoConvErr)) });
                            break;
                          }
                        }
                        if (typeof scriptText !== 'string') { opResults.push({ index: opIdx, type: 'add_script', success: false, error: 'Script must be a DSL text string (not ' + typeof scriptText + '). Example: "event_whenflagclicked\\n  motion_movesteps 10"' }); break; }
                        let parsed;
                        try {
                          parsed = parseScratchDSL(scriptText, target);
                        } catch (parseErr) {
                          opResults.push({ index: opIdx, type: 'add_script', success: false, error: 'DSL parse error: ' + (parseErr.message || String(parseErr)) + '\nScript text (first 500 chars):\n' + scriptText.substring(0, 500) });
                          break;
                        }
                        const validation = validateParsedScript(parsed, target);
                        if (validation.errors.length > 0) {
                          opResults.push({ index: opIdx, type: 'add_script', success: false, error: formatValidationError(validation.errors, scriptText) });
                          break;
                        }
                        var eoWarnings = (parsed.warnings || []).concat(validation.warnings);
                        const allBlocks = buildScriptBlocks(parsed, target).blocks;
                        if (allBlocks.length > 0) {
                          try {
                            allBlocks.forEach(function(b) { target.blocks.createBlock(b); });
                            vm.runtime.emitProjectChanged();
                            vm.emitWorkspaceUpdate();
                            vm.emitTargetsUpdate();
                          } catch (createErr) {
                            opResults.push({
                              index: opIdx,
                              type: 'add_script',
                              success: false,
                              error: 'createBlock failed: ' + (createErr.message || String(createErr)) +
                                '\nBlocks attempted: ' + allBlocks.length +
                                '\nLast opcode: ' + (allBlocks.length > 0 ? allBlocks[allBlocks.length - 1].opcode : 'unknown')
                            });
                            break;
                          }
                        }
                        opResults.push({ index: opIdx, type: 'add_script', success: true, blocksCreated: allBlocks.length, warnings: eoWarnings.length ? eoWarnings : undefined });
                        break;
                      }
                      case 'insert_blocks': {
                        // Splice blocks into an existing script instead of creating a new stack.
                        const resolved = resolveBlockId(op.targetId);
                        if (!resolved) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'Block tid not found: ' + op.targetId + '. Use a tid from the project context.' });
                          break;
                        }
                        const target = resolved.target;
                        const anchorId = resolved.blockId;
                        const position = op.position || 'after';
                        const VALID_POSITIONS = ['after', 'before', 'body_start', 'body_end'];
                        if (VALID_POSITIONS.indexOf(position) < 0) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'Invalid position "' + position + '". Use one of: ' + VALID_POSITIONS.join(', ') });
                          break;
                        }
                        let insertText = op.blocks !== undefined ? op.blocks : op.script;
                        if (insertText === undefined || insertText === null || insertText === '') {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'No blocks provided. Pass "blocks" as DSL text, e.g. "looks_say \\"hi\\"\ncontrol_wait 1".' });
                          break;
                        }
                        if (typeof insertText === 'object') {
                          try {
                            insertText = convertBlockObjToDsl(insertText, 0, target && target.runtime).join('\n');
                          } catch (convErr) {
                            opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'Failed to convert blocks object to DSL: ' + (convErr.message || String(convErr)) });
                            break;
                          }
                        }
                        let parsedIns;
                        try {
                          parsedIns = parseScratchDSL(String(insertText), target);
                        } catch (parseErr) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'DSL parse error: ' + (parseErr.message || String(parseErr)) + '\nBlocks text:\n' + String(insertText).substring(0, 400) });
                          break;
                        }
                        // Inserted fragments are bodies, not scripts: an implicit green-flag hat
                        // would silently become the first inserted block.
                        const insBody = { hat: null, blocks: parsedIns.blocks, warnings: parsedIns.warnings };
                        if (parsedIns.hat && String(insertText).replace(/^[	 ]+/, '').indexOf('event_') === 0) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'insert_blocks takes body blocks only; "' + parsedIns.hat.opcode + '" is a hat block. Use add_script to create a new script.' });
                          break;
                        }
                        if (!insBody.blocks || insBody.blocks.length === 0) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'The DSL produced no blocks. Text was: ' + String(insertText).substring(0, 200) });
                          break;
                        }
                        const insValidation = validateParsedScript(insBody, target);
                        if (insValidation.errors.length > 0) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: formatValidationError(insValidation.errors, insertText) });
                          break;
                        }
                        const insBuilt = buildScriptBlocks(insBody, target, { topLevel: false });
                        const firstBlock = insBuilt.blocks.filter(function(b) { return !b.shadow; })[0];
                        if (!firstBlock || !insBuilt.lastId) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: 'Could not build the blocks to insert' });
                          break;
                        }
                        const spliced = spliceBlocksIntoScript(target, insBuilt.blocks, firstBlock.id, insBuilt.lastId, {
                          position: position,
                          blockId: anchorId,
                          branch: op.branch
                        });
                        if (!spliced.ok) {
                          opResults.push({ index: opIdx, type: 'insert_blocks', success: false, error: spliced.error });
                          break;
                        }
                        vm.runtime.emitProjectChanged();
                        vm.emitWorkspaceUpdate();
                        vm.emitTargetsUpdate();
                        opResults.push({
                          index: opIdx, type: 'insert_blocks', success: true,
                          blocksInserted: insBuilt.blocks.filter(function(b) { return !b.shadow; }).length,
                          position: position,
                          warnings: insValidation.warnings.length ? insValidation.warnings : undefined
                        });
                        break;
                      }
                      case 'delete_block': {
                        const resolved = resolveBlockId(op.targetId);
                        if (!resolved) { opResults.push({ index: opIdx, type: 'delete_block', success: false, error: 'Block tid not found: ' + op.targetId }); break; }
                        const target = resolved.target;
                        const blockId = resolved.blockId;
                        const block = target.blocks.getBlock(blockId);
                        if (!block) { opResults.push({ index: opIdx, type: 'delete_block', success: false, error: 'Block not found' }); break; }
                        const mode = op.mode || 'with_children';
                        if (mode === 'with_children') {
                          const idsToDelete = [];
                          function collectChain(id) {
                            if (!id || idsToDelete.indexOf(id) >= 0) return;
                            idsToDelete.push(id);
                            const b = target.blocks.getBlock(id);
                            if (!b) return;
                            if (b.next) collectChain(b.next);
                            if (b.inputs && b.inputs.SUBSTACK && b.inputs.SUBSTACK.block) collectChain(b.inputs.SUBSTACK.block);
                            if (b.inputs && b.inputs.SUBSTACK2 && b.inputs.SUBSTACK2.block) collectChain(b.inputs.SUBSTACK2.block);
                          }
                          collectChain(blockId);
                          idsToDelete.forEach(function(id) { target.blocks.deleteBlock(id); });
                        } else {
                          const parentId = block.parent;
                          if (block.next) {
                            const nextBlock = target.blocks.getBlock(block.next);
                            if (nextBlock) nextBlock.parent = parentId;
                          }
                          target.blocks.deleteBlock(blockId);
                        }
                        vm.runtime.emitProjectChanged();
                        vm.emitWorkspaceUpdate();
                        vm.emitTargetsUpdate();
                        opResults.push({ index: opIdx, type: 'delete_block', success: true });
                        break;
                      }
                      case 'modify_input': {
                        const resolved = resolveBlockId(op.targetId);
                        if (!resolved) { opResults.push({ index: opIdx, type: 'modify_input', success: false, error: 'Block tid not found: ' + op.targetId }); break; }
                        const target = resolved.target;
                        const blockId = resolved.blockId;
                        const block = target.blocks.getBlock(blockId);
                        if (!block) { opResults.push({ index: opIdx, type: 'modify_input', success: false, error: 'Block not found' }); break; }
                        const inputName = op.inputName;
                        const value = op.value;
                        const oldInput = block.inputs[inputName];
                        // Reject an input name the block doesn't have; otherwise the value goes
                        // into a slot Scratch never renders and the model thinks it succeeded.
                        const inputSchema = OPCODE_SCHEMA[block.opcode];
                        if (inputSchema && inputName !== 'SUBSTACK' && inputName !== 'SUBSTACK2' &&
                            !schemaArgFor(block.opcode, inputName)) {
                          opResults.push({
                            index: opIdx, type: 'modify_input', success: false,
                            error: block.opcode + ' has no input named "' + inputName + '". Valid: ' +
                              (inputSchema.args.map(function(a) { return a.name; }).join(', ') || 'none') +
                              (inputSchema.substack ? ', SUBSTACK' : '') + (inputSchema.substack2 ? ', SUBSTACK2' : '')
                          });
                          break;
                        }
                        function deleteOldShadow() {
                          if (oldInput && oldInput.shadow) {
                            target.blocks.deleteBlock(oldInput.shadow);
                          }
                          if (oldInput && oldInput.block) {
                            target.blocks.deleteBlock(oldInput.block);
                          }
                          if (oldInput && typeof oldInput === 'object' && oldInput.block === oldInput.shadow) {
                            target.blocks.deleteBlock(oldInput.block);
                          }
                        }
                        if (typeof value === 'string' && (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2')) {
                          // DSL text string for SUBSTACK/SUBSTACK2: parse and build chain
                          deleteOldShadow();
                          let parsedSub;
                          try {
                            parsedSub = parseScratchDSL(value, target);
                          } catch (parseErr) {
                            opResults.push({ index: opIdx, type: 'modify_input', success: false, error: 'SUBSTACK DSL parse error: ' + (parseErr.message || String(parseErr)) + '\nText (first 300 chars): ' + value.substring(0, 300) });
                            break;
                          }
                          const subAllBlocks = [];
                          let subFirstId = null;
                          let subPrevId = null;
                          parsedSub.blocks.forEach(function(blk) {
                            const subId = buildBlockStructure(blk, target, subAllBlocks);
                            if (subId) {
                              const subDef = subAllBlocks.find(function(ab) { return ab.id === subId; });
                              if (subDef) subDef.parent = subPrevId || blockId;
                              if (!subFirstId) subFirstId = subId;
                              if (subPrevId) {
                                const prevDef = subAllBlocks.find(function(ab) { return ab.id === subPrevId; });
                                if (prevDef) prevDef.next = subId;
                              }
                              subPrevId = subId;
                            }
                          });
                          if (subFirstId) {
                            subAllBlocks.forEach(function(b) { target.blocks.createBlock(b); });
                            block.inputs[inputName] = { name: inputName, block: subFirstId, shadow: null };
                          } else {
                            opResults.push({ index: opIdx, type: 'modify_input', success: false, error: 'SUBSTACK DSL produced no blocks. Text was: ' + value.substring(0, 200) });
                            break;
                          }
                        } else if (value && typeof value === 'object' && value.opcode && (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2')) {
                          // Object format for SUBSTACK: build chain and set parent
                          deleteOldShadow();
                          const subAllBlocks = [];
                          const reporterId = buildBlockStructure(value, target, subAllBlocks);
                          if (reporterId) {
                            const firstDef = subAllBlocks.find(function(ab) { return ab.id === reporterId; });
                            if (firstDef) firstDef.parent = blockId;
                            subAllBlocks.forEach(function(b) { target.blocks.createBlock(b); });
                            block.inputs[inputName] = { name: inputName, block: reporterId, shadow: null };
                          }
                        } else if (value && typeof value === 'object' && value.opcode) {
                          // Plug a reporter block into the slot
                          deleteOldShadow();
                          const reporterBlocks = [];
                          const reporterId = buildBlockStructure(value, target, reporterBlocks);
                          if (!reporterId) {
                            opResults.push({ index: opIdx, type: 'modify_input', success: false, error: 'Could not build reporter for ' + inputName + ': missing opcode' });
                            break;
                          }
                          const reporterDef = reporterBlocks.find(function(ab) { return ab.id === reporterId; });
                          if (reporterDef) reporterDef.parent = blockId;
                          reporterBlocks.forEach(function(b) { target.blocks.createBlock(b); });
                          block.inputs[inputName] = { name: inputName, block: reporterId, shadow: null };
                        } else {
                          // Literal value: let the schema pick the right shadow type so a colour
                          // stays a colour picker, an angle stays a dial, a menu stays a dropdown.
                          deleteOldShadow();
                          const shadowPair = createInputShadow(target, blockId, block.opcode, inputName, value);
                          if (shadowPair[0]) {
                            target.blocks.createBlock(shadowPair[0]);
                            block.inputs[inputName] = shadowPair[1];
                          } else {
                            delete block.inputs[inputName];
                          }
                        }
                        vm.runtime.emitProjectChanged();
                        vm.emitWorkspaceUpdate();
                        vm.emitTargetsUpdate();
                        opResults.push({ index: opIdx, type: 'modify_input', success: true });
                        break;
                      }
                      case 'add_comment': {
                        const target = getTarget(op.sprite) || vm.runtime.getTargetForStage();
                        if (!target) { opResults.push({ index: opIdx, type: 'add_comment', success: false, error: 'Target not found: ' + op.sprite }); break; }
                        const commentId = '_ai_cmt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                        const commentText = op.text || '';
                        const minimized = op.minimized === true;
                        if (op.targetId) {
                          // Block-attached comment
                          const resolved = resolveBlockId(op.targetId);
                          if (!resolved) { opResults.push({ index: opIdx, type: 'add_comment', success: false, error: 'Block tid not found: ' + op.targetId }); break; }
                          const block = resolved.target.blocks.getBlock(resolved.blockId);
                          if (!block) { opResults.push({ index: opIdx, type: 'add_comment', success: false, error: 'Block not found' }); break; }
                          target.createComment(commentId, resolved.blockId, commentText, block.x + 240, block.y, 200, 200, minimized);
                        } else {
                          // Standalone workspace comment
                          const cx = typeof op.x === 'number' ? op.x : 100 + Math.random() * 200;
                          const cy = typeof op.y === 'number' ? op.y : 100 + Math.random() * 200;
                          target.createComment(commentId, null, commentText, cx, cy, 200, 200, minimized);
                        }
                        vm.runtime.emitProjectChanged();
                        vm.emitWorkspaceUpdate();
                        vm.emitTargetsUpdate();
                        opResults.push({ index: opIdx, type: 'add_comment', success: true, data: { commentId: commentId } });
                        break;
                      }
                      case 'delete_comment': {
                        const target = getTarget(op.sprite) || vm.runtime.getTargetForStage();
                        if (!target) { opResults.push({ index: opIdx, type: 'delete_comment', success: false, error: 'Target not found: ' + op.sprite }); break; }
                        // targetId 可能是块 tid，也可能是 add_comment 返回的 commentId
                        // （独立工作区注释没有宿主块，只能按 commentId 删）。两种都接受，
                        // 并按 tid -> commentId -> 全 target 扫描的顺序回退。
                        const wanted = op.commentId || op.targetId;
                        let deleted = false;

                        const dropComment = (owner, cid) => {
                          if (!owner || !owner.comments || !owner.comments[cid]) return false;
                          const c = owner.comments[cid];
                          if (c && c.blockId) {
                            const b = owner.blocks.getBlock(c.blockId);
                            if (b) delete b.comment;
                          }
                          delete owner.comments[cid];
                          return true;
                        };

                        // 1) 当作块 tid：删掉该块挂着的注释
                        if (op.targetId) {
                          const resolved = resolveBlockId(op.targetId);
                          if (resolved) {
                            const block = resolved.target.blocks.getBlock(resolved.blockId);
                            if (block && block.comment) {
                              deleted = dropComment(resolved.target, block.comment);
                            }
                          }
                        }
                        // 2) 当作 commentId：先在指定 target 上找
                        if (!deleted && wanted) {
                          deleted = dropComment(target, wanted);
                        }
                        // 3) 仍未命中：跨所有 target 扫一遍（sprite 传错时的兜底）
                        if (!deleted && wanted) {
                          for (const t of vm.runtime.targets) {
                            if (dropComment(t, wanted)) { deleted = true; break; }
                          }
                        }

                        if (!deleted) {
                          opResults.push({
                            index: opIdx, type: 'delete_comment', success: false,
                            error: 'Comment not found: ' + String(wanted) +
                              '. Pass a block tid to remove that block\'s comment, or the commentId returned by add_comment for a standalone workspace comment.'
                          });
                          break;
                        }
                        vm.runtime.emitProjectChanged();
                        vm.emitWorkspaceUpdate();
                        vm.emitTargetsUpdate();
                        opResults.push({ index: opIdx, type: 'delete_comment', success: true });
                        break;
                      }
                      case 'explain': {
                        opResults.push({ index: opIdx, type: 'explain', success: true, text: op.text || '' });
                        break;
                      }
                      default: {
                        opResults.push({ index: opIdx, type: op.type, success: false, error: 'Unknown operation type: ' + op.type });
                      }
                    }
                  } catch (e3) {
                    opResults.push({ index: opIdx, type: op.type, success: false, error: e3.message || String(e3) });
                  }
                }

                result = { success: true, data: { results: opResults } };
              } catch (e2) { result = { success: false, error: 'Failed to execute operations: ' + (e2.message || String(e2)) }; }
              break;
            }
            case 'changeCostume': {
              const target = vm.runtime.getTargetById(params.targetId) || vm.runtime.targets.find(t => t.getName() === params.spriteName);
              if (!target) { result = { success: false, error: 'Sprite not found' }; break; }
              const costumes = target.getCostumes();
              const searchName = (params.costumeName || '').toLowerCase();
              const idx = costumes.findIndex(c => (c.name || '').toLowerCase() === searchName);
              if (idx < 0) {
                result = { success: false, error: 'Costume "' + params.costumeName + '" not found. Available: ' + costumes.map(c => c.name).join(', ') };
                break;
              }
              target.setCostume(idx);
              result = { success: true, data: { costumeName: costumes[idx].name, costumeIndex: idx } };
              break;
            }
            case 'changeBackdrop': {
              const stage = vm.runtime.getTargetForStage();
              const costumes = stage.getCostumes();
              const searchName = (params.backdropName || '').toLowerCase();
              const idx = costumes.findIndex(c => (c.name || '').toLowerCase() === searchName);
              if (idx < 0) {
                result = { success: false, error: 'Backdrop "' + params.backdropName + '" not found. Available: ' + costumes.map(c => c.name).join(', ') };
                break;
              }
              stage.setCostume(idx);
              vm.runtime.emitProjectChanged();
              result = { success: true, data: { backdropName: costumes[idx].name, index: idx } };
              break;
            }
            case 'getStageInfo': {
              const stage = vm.runtime.getTargetForStage();
              if (!stage) { result = { success: false, error: 'Stage not found' }; break; }
              const backdropList = stage.getCostumes().map(c => ({ name: c.name, index: c === stage.getCostumes()[stage.currentCostume] ? 'current' : '' }));
              result = { success: true, data: { currentBackdrop: stage.getCostumes()[stage.currentCostume] ? stage.getCostumes()[stage.currentCostume].name : '', backdropCount: stage.getCostumes().length, backdrops: backdropList } };
              break;
            }
            case 'getInstalledExtensions': {
              try {
                const extensionManager = vm.extensionManager;
                if (!extensionManager) { result = { success: false, error: 'Extension manager not available' }; break; }
                const loadedExtensions = extensionManager._loadedExtensions || {};
                const extList = [];
                Object.keys(loadedExtensions).forEach(extId => {
                  const ext = loadedExtensions[extId];
                  try {
                    const info = ext.getInfo ? ext.getInfo() : null;
                    const blockList = info && info.blocks ? info.blocks.map(b => ({
                      opcode: b.opcode,
                      blockType: b.blockType,
                      text: b.text || '',
                      arguments: b.arguments || {},
                      argumentCount: b.arguments ? Object.keys(b.arguments).length : 0,
                      func: b.func || '',
                      hideFromPalette: b.hideFromPalette || false,
                      isTerminal: b.isTerminal || false,
                      blockAllThreads: b.blockAllThreads || false
                    })) : [];
                    const menuList = info && info.menus ? Object.keys(info.menus).map(m => ({
                      name: m,
                      items: info.menus[m].items || []
                    })) : [];
                    extList.push({
                      id: info ? info.id : extId,
                      name: info ? info.name : extId,
                      blockCount: blockList.length,
                      blocks: blockList,
                      menus: menuList,
                      hasGetter: typeof ext.getInfo === 'function'
                    });
                  } catch (e2) {
                    extList.push({ id: extId, name: extId, error: e2.message });
                  }
                });
                result = { success: true, data: { extensionCount: extList.length, extensions: extList } };
              } catch (e) { result = { success: false, error: e.message }; }
              break;
            }
            case 'searchExtensions': {
              try {
                const keyword = (params.keyword || '').toLowerCase();
                const KNOWN_EXTENSIONS = [
                  { id: 'text', name: 'Text', description: 'Display text on the stage with customizable fonts, colors, and sizes.', url: 'https://extensions.turbowarp.org/text.js' },
                  { id: 'pen', name: 'Pen', description: 'Draw on the stage with pen blocks - lines, stamps, colors.', url: 'https://extensions.turbowarp.org/pen.js' },
                  { id: 'music', name: 'Music', description: 'Play instruments, drums, and create musical sequences.', url: 'https://extensions.turbowarp.org/music.js' },
                  { id: 'translate', name: 'Translate', description: 'Translate text between languages using machine translation.', url: 'https://extensions.turbowarp.org/translate.js' },
                  { id: 'video sensing', name: 'Video Sensing', description: 'Detect motion and interact with webcam video.', url: 'https://extensions.turbowarp.org/videoSensing.js' },
                  { id: 'tts', name: 'Text to Speech', description: 'Speak text aloud with different voices and languages.', url: 'https://extensions.turbowarp.org/text2speech.js' },
                  { id: 'gdxfor', name: 'Go Direct Force', description: 'Connect to Vernier Go Direct Force and Acceleration sensor.', url: 'https://extensions.turbowarp.org/gdxfor.js' },
                  { id: 'ev3', name: 'LEGO EV3', description: 'Control LEGO MINDSTORMS EV3 motors and sensors.', url: 'https://extensions.turbowarp.org/ev3.js' },
                  { id: 'makeymakey', name: 'Makey Makey', description: 'Use Makey Makey to trigger keyboard events from physical inputs.', url: 'https://extensions.turbowarp.org/makeymakey.js' },
                  { id: 'microbit', name: 'micro:bit', description: 'Connect to BBC micro:bit and use its sensors and LED display.', url: 'https://extensions.turbowarp.org/microbit.js' },
                  { id: 'wedo2', name: 'LEGO WeDo 2.0', description: 'Control LEGO WeDo 2.0 motors and sensors.', url: 'https://extensions.turbowarp.org/wedo2.js' },
                  { id: 'boost', name: 'LEGO BOOST', description: 'Control LEGO BOOST motors and sensors.', url: 'https://extensions.turbowarp.org/boost.js' },
                  { id: 'gamepad', name: 'Gamepad', description: 'Read gamepad/joystick button presses and axis values.', url: 'https://extensions.turbowarp.org/gamepad.js' },
                  { id: 'cursor', name: 'Cursor', description: 'Hide/show mouse cursor and get cursor position.', url: 'https://extensions.turbowarp.org/cursor.js' },
                  { id: 'files', name: 'Files', description: 'Read and write files from the local filesystem.', url: 'https://extensions.turbowarp.org/files.js' },
                  { id: 'clocks', name: 'Clocks', description: 'Get current time, date, and create timers.', url: 'https://extensions.turbowarp.org/clocks.js' },
                  { id: 'fetch', name: 'Fetch', description: 'Make HTTP requests to APIs and websites.', url: 'https://extensions.turbowarp.org/fetch.js' },
                  { id: 'runtime', name: 'Runtime', description: 'Control project execution - pause, stop, FPS.', url: 'https://extensions.turbowarp.org/runtime.js' },
                  { id: 'cloudlink', name: 'CloudLink', description: 'Connect projects together over the internet.', url: 'https://extensions.turbowarp.org/cloudlink.js' },
                  { id: 'utilities', name: 'Utilities', description: 'JSON parsing, math functions, advanced string operations.', url: 'https://extensions.turbowarp.org/utilities.js' },
                  { id: 'encoding', name: 'Encoding', description: 'Base64, hex, URL encoding and decoding.', url: 'https://extensions.turbowarp.org/encoding.js' },
                  { id: 'sound', name: 'Sound', description: 'Advanced sound analysis - loudness, pitch, waveform.', url: 'https://extensions.turbowarp.org/sound.js' },
                  { id: 'box2d', name: 'Box2D Physics', description: 'Realistic 2D physics simulation with gravity, collisions.', url: 'https://extensions.turbowarp.org/box2d.js' },
                  { id: 'pointer', name: 'Pointer', description: 'Get pointer/mouse position on stage with advanced options.', url: 'https://extensions.turbowarp.org/pointerlock.js' },
                  { id: 'turbo', name: 'TurboWarp', description: 'Advanced TurboWarp-specific features like warp mode.', url: 'https://extensions.turbowarp.org/turbowarp.js' },
                  { id: 'tween', name: 'Tween', description: 'Smooth animations - move, rotate, scale sprites over time.', url: 'https://extensions.turbowarp.org/tween.js' },
                  { id: 'stretch', name: 'Stretch', description: 'Stretch sprites on the stage canvas.', url: 'https://extensions.turbowarp.org/stretch.js' },
                  { id: 'xml', name: 'XML', description: 'Parse and create XML documents.', url: 'https://extensions.turbowarp.org/xml.js' },
                  { id: 'iframe', name: 'iframe', description: 'Embed web content in your project.', url: 'https://extensions.turbowarp.org/iframe.js' }
                ];
                const matches = KNOWN_EXTENSIONS.filter(ext => {
                  return ext.name.toLowerCase().includes(keyword) ||
                    ext.id.toLowerCase().includes(keyword) ||
                    ext.description.toLowerCase().includes(keyword);
                });
                if (matches.length === 0) {
                  result = { success: true, data: { keyword: params.keyword, count: 0, results: [], allExtensions: KNOWN_EXTENSIONS.map(e => e.name) } };
                } else {
                  result = { success: true, data: { keyword: params.keyword, count: matches.length, results: matches } };
                }
              } catch (e) { result = { success: false, error: e.message }; }
              break;
            }
            case 'developExtension': {
              try {
                var extCode = params.extension_code || '';
                var extName = params.extension_name || 'custom_extension_' + Date.now();
                if (!extCode || extCode.trim().length < 10) { result = { success: false, error: 'Extension code is too short or empty' }; break; }
                var safeExtName = extName.replace(/[^a-zA-Z0-9_]/g, '_');
                var wrappedCode = '(function(Scratch) {\n' +
                  '  var ExtensionClass = ' + extCode + '\n' +
                  '  if (typeof ExtensionClass === "function" && ExtensionClass.prototype) {\n' +
                  '    Scratch.extensions.register(new ExtensionClass());\n' +
                  '  } else if (typeof ExtensionClass === "object" && !Array.isArray(ExtensionClass)) {\n' +
                  '    var info = ExtensionClass;\n' +
                  '    Scratch.extensions.register({ getInfo: function() { return info; }, _customInfo: info });\n' +
                  '  } else {\n' +
                  '    Scratch.extensions.register({ getInfo: function() { return { id: "' + safeExtName + '", name: "' + safeExtName + '", blocks: [] }; } });\n' +
                  '  }\n' +
                  '})(Scratch);';
                var dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(wrappedCode);

                // AI 生成的扩展代码需要直接访问 Scratch API（vm/runtime），沙箱化的
                // worker/iframe 里拿不到，注册回调也不会回传，表现为"两次超时且未注册"。
                // 这里临时把该 data: URL 判为 unsandboxed，加载结束后恢复原策略。
                var secMgr = vm.extensionManager.securityManager;
                var prevGetSandboxMode = secMgr.getSandboxMode;
                secMgr.getSandboxMode = function(url) {
                  if (url === dataUrl) return Promise.resolve('unsandboxed');
                  return prevGetSandboxMode.call(secMgr, url);
                };

                var loadedIds = [];
                var prevExtKeys = new Set(vm.extensionManager._loadedExtensions.keys());
                try {
                  // loadExtensionURL 在注册回调迟迟不来时会一直挂着，加超时避免
                  // 阻塞整条工具调用链（主进程侧 30s 后会判定 Tool call timeout）。
                  await Promise.race([
                    vm.extensionManager.loadExtensionURL(dataUrl),
                    new Promise(function(_, rej) {
                      setTimeout(function() { rej(new Error('Extension registration timed out after 20s')); }, 20000);
                    })
                  ]);
                  try {
                    loadedIds = Array.from(vm.extensionManager._loadedExtensions.keys());
                  } catch (idErr) { void idErr; }
                } finally {
                  secMgr.getSandboxMode = prevGetSandboxMode;
                }
                // 记录本次由 AI 工具新加入的扩展，供 deleteExtension 校验（仅允许删除 AI 自己加入的扩展）
                var aiAddedExt = (this.aiAddedExtensionIds = this.aiAddedExtensionIds || new Set());
                loadedIds.forEach(function(id) { if (!prevExtKeys.has(id)) aiAddedExt.add(id); });

                result = {
                  success: true,
                  data: {
                    extensionName: extName,
                    safeId: safeExtName,
                    loadedExtensions: loadedIds,
                    message: 'Extension "' + extName + '" loaded successfully (unsandboxed)'
                  }
                };
              } catch (e) {
                result = {
                  success: false,
                  error: 'Failed to develop extension: ' + (e && e.message ? e.message : String(e)) +
                    '. Make sure extension_code is a class or object literal (no "const X =" prefix) whose getInfo() returns {id, name, blocks}.'
                };
              }
              break;
            }
            case 'installExtension': {
              try {
                var extUrl = params.extension_url || '';
                if (!extUrl) { result = { success: false, error: 'No extension URL provided' }; break; }
                var KNOWN_URLS = {
                  'text': 'https://extensions.turbowarp.org/text.js',
                  'pen': 'https://extensions.turbowarp.org/pen.js',
                  'music': 'https://extensions.turbowarp.org/music.js',
                  'translate': 'https://extensions.turbowarp.org/translate.js',
                  'video sensing': 'https://extensions.turbowarp.org/videoSensing.js',
                  'videoSensing': 'https://extensions.turbowarp.org/videoSensing.js',
                  'tts': 'https://extensions.turbowarp.org/text2speech.js',
                  'text2speech': 'https://extensions.turbowarp.org/text2speech.js',
                  'gdxfor': 'https://extensions.turbowarp.org/gdxfor.js',
                  'ev3': 'https://extensions.turbowarp.org/ev3.js',
                  'makeymakey': 'https://extensions.turbowarp.org/makeymakey.js',
                  'microbit': 'https://extensions.turbowarp.org/microbit.js',
                  'wedo2': 'https://extensions.turbowarp.org/wedo2.js',
                  'boost': 'https://extensions.turbowarp.org/boost.js',
                  'gamepad': 'https://extensions.turbowarp.org/gamepad.js',
                  'cursor': 'https://extensions.turbowarp.org/cursor.js',
                  'files': 'https://extensions.turbowarp.org/files.js',
                  'clocks': 'https://extensions.turbowarp.org/clocks.js',
                  'fetch': 'https://extensions.turbowarp.org/fetch.js',
                  'runtime': 'https://extensions.turbowarp.org/runtime.js',
                  'cloudlink': 'https://extensions.turbowarp.org/cloudlink.js',
                  'utilities': 'https://extensions.turbowarp.org/utilities.js',
                  'encoding': 'https://extensions.turbowarp.org/encoding.js',
                  'sound': 'https://extensions.turbowarp.org/sound.js',
                  'box2d': 'https://extensions.turbowarp.org/box2d.js',
                  'pointer': 'https://extensions.turbowarp.org/pointerlock.js',
                  'turbo': 'https://extensions.turbowarp.org/turbowarp.js',
                  'tween': 'https://extensions.turbowarp.org/tween.js',
                  'stretch': 'https://extensions.turbowarp.org/stretch.js',
                  'xml': 'https://extensions.turbowarp.org/xml.js',
                  'iframe': 'https://extensions.turbowarp.org/iframe.js'
                };
                if (KNOWN_URLS[extUrl]) extUrl = KNOWN_URLS[extUrl];
                if (KNOWN_URLS[extUrl.toLowerCase()]) extUrl = KNOWN_URLS[extUrl.toLowerCase()];
                if (!extUrl.startsWith('http')) { result = { success: false, error: 'Invalid URL. Provide a full URL or known extension ID.' }; break; }
                var prevExtKeys2 = new Set(vm.extensionManager._loadedExtensions.keys());
                await vm.extensionManager.loadExtensionURL(extUrl);
                // 记录本次由 AI 工具新加入的扩展，供 deleteExtension 校验（仅允许删除 AI 自己加入的扩展）
                var aiAddedExt2 = (this.aiAddedExtensionIds = this.aiAddedExtensionIds || new Set());
                Array.from(vm.extensionManager._loadedExtensions.keys()).forEach(function(id) { if (!prevExtKeys2.has(id)) aiAddedExt2.add(id); });
                result = { success: true, data: { url: extUrl, message: 'Extension loaded successfully' } };
              } catch (e) { result = { success: false, error: 'Failed to install extension: ' + e.message }; }
              break;
            }
            case 'deleteExtension': {
              try {
                const extensionManager = vm.extensionManager;
                if (!extensionManager) { result = { success: false, error: 'Extension manager not available' }; break; }
                const loadedExtensions = extensionManager._loadedExtensions;
                if (!loadedExtensions) { result = { success: false, error: 'No loaded extensions' }; break; }
                // 收集所有已加载扩展（兼容 Map 与纯对象两种存储形态）
                const entries = [];
                if (typeof loadedExtensions.entries === 'function') {
                  for (const [k, v] of loadedExtensions.entries()) entries.push([k, v]);
                } else {
                  Object.keys(loadedExtensions).forEach(k => entries.push([k, loadedExtensions[k]]));
                }
                if (entries.length === 0) { result = { success: false, error: 'No loaded extensions to delete' }; break; }
                const queryId = (params.extensionId || '').toLowerCase();
                const queryName = (params.extensionName || '').toLowerCase();
                // 定位目标扩展（按 key/URL、info.id 或 info.name 匹配）
                let matchedKey = null;
                let matchedExt = null;
                let matchedInfoId = null;
                for (const [key, ext] of entries) {
                  if (queryId && key && key.toLowerCase() === queryId) { matchedKey = key; matchedExt = ext; break; }
                  try {
                    const info = ext && ext.getInfo ? ext.getInfo() : null;
                    if (info) {
                      if (queryId && info.id && info.id.toLowerCase() === queryId) { matchedKey = key; matchedExt = ext; break; }
                      if (queryName && info.name && info.name.toLowerCase() === queryName) { matchedKey = key; matchedExt = ext; break; }
                    }
                  } catch (e2) { /* ignore */ }
                }
                if (!matchedKey) {
                  const available = entries.map(([key, ext]) => {
                    let name = key;
                    try { const info = ext && ext.getInfo ? ext.getInfo() : null; if (info && info.name) name = info.name + ' (id: ' + (info.id || key) + ')'; } catch (e2) { /* ignore */ }
                    return name;
                  });
                  result = { success: false, error: 'Extension not found. Available: ' + available.join(', ') };
                  break;
                }
                if (matchedExt && matchedExt.getInfo) {
                  try { const info = matchedExt.getInfo(); if (info && info.id) matchedInfoId = info.id; } catch (e2) { /* ignore */ }
                }
                // 仅允许删除 AI 自己通过工具（installExtension / developExtension）加入的扩展
                const aiAddedExt = this.aiAddedExtensionIds = this.aiAddedExtensionIds || new Set();
                const isAiAdded = aiAddedExt.has(matchedKey) ||
                  (matchedInfoId && aiAddedExt.has(matchedInfoId));
                if (!isAiAdded) {
                  result = {
                    success: false,
                    error: '只能删除由 AI 自己加入的扩展。该扩展并非通过 AI 工具（installExtension/developExtension）加载，无法删除。'
                  };
                  break;
                }
                // 从已加载扩展与积木调色板中移除
                loadedExtensions.delete(matchedKey);
                if (matchedInfoId) loadedExtensions.delete(matchedInfoId);
                const blockInfo = vm.runtime._blockInfo;
                if (Array.isArray(blockInfo)) {
                  for (let i = blockInfo.length - 1; i >= 0; i--) {
                    if (blockInfo[i] && (blockInfo[i].id === matchedKey || (matchedInfoId && blockInfo[i].id === matchedInfoId))) {
                      blockInfo.splice(i, 1);
                    }
                  }
                }
                aiAddedExt.delete(matchedKey);
                if (matchedInfoId) aiAddedExt.delete(matchedInfoId);
                // 重建积木调色板，使该扩展的积木从界面消失
                try { vm.refreshWorkspace(); } catch (e2) { /* ignore */ }
                result = { success: true, data: { extensionId: matchedInfoId || matchedKey, message: '扩展已删除' } };
              } catch (e) {
                result = { success: false, error: 'Failed to delete extension: ' + e.message };
              }
              break;
            }
            case 'renameProject': {
              try {
                const newName = params.name;
                if (!newName) { result = { success: false, error: 'No name provided' }; break; }
                vm.runtime.projectName = newName;
                vm.runtime.emitProjectChanged();
                document.title = newName + ' - NeoWarp';
                result = { success: true, data: { name: newName } };
              } catch (e) { result = { success: false, error: 'Failed to rename project: ' + e.message }; }
              break;
            }
            case 'setStageSize': {
              try {
                const width = Number(params.width);
                const height = Number(params.height);
                if (!width || !height || width < 240 || height < 180) {
                  result = { success: false, error: 'Invalid stage size. Width must be >= 240, height >= 180.' };
                  break;
                }
                vm.setStageSize(width, height);
                result = { success: true, data: { width: width, height: height, message: 'Stage size set to ' + width + 'x' + height } };
              } catch (e) { result = { success: false, error: 'Failed to set stage size: ' + e.message }; }
              break;
            }
            case 'clickGreenFlag': {
              try {
                vm.greenFlag();
                result = { success: true, data: { message: 'Green flag clicked' } };
              } catch (e) { result = { success: false, error: 'Failed to click green flag: ' + e.message }; }
              break;
            }
            case 'getSystemTime': {
              const now = new Date();
              result = { success: true, data: {
                timestamp: now.getTime(),
                iso: now.toISOString(),
                local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                date: now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'),
                time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0'),
                year: now.getFullYear(),
                month: now.getMonth() + 1,
                day: now.getDate(),
                hours: now.getHours(),
                minutes: now.getMinutes(),
                seconds: now.getSeconds(),
                weekday: now.getDay(),
                timezoneOffset: now.getTimezoneOffset()
              }};
              break;
            }
            case 'getSystemInfo': {
              try {
                const info = await EditorPreload.getAISystemInfo();
                result = info;
              } catch (e) { result = { success: false, error: 'Failed to get system info: ' + e.message }; }
              break;
            }
            case 'addCostumeFromUrl': {
              try {
                const spriteName = params.spriteName || '';
                const url = params.url || '';
                const costumeName = params.costumeName || 'costume';
                if (!url) { result = { success: false, error: 'No URL provided' }; break; }
                const target = vm.runtime.targets.find(t => t.getName() === spriteName);
                if (!target) { result = { success: false, error: 'Sprite "' + spriteName + '" not found' }; break; }

                // Fetch the image via main process (bypasses CORS, sets proper User-Agent)
                const buffer = await EditorPreload.fetchImage(url);

                // Determine format from URL
                const urlLower = url.toLowerCase();
                let dataFormat = 'png';
                if (urlLower.endsWith('.svg')) dataFormat = 'svg';
                else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) dataFormat = 'jpg';
                else if (urlLower.endsWith('.gif')) dataFormat = 'gif';
                else if (urlLower.endsWith('.bmp')) dataFormat = 'bmp';

                const storage = vm.runtime.storage;
                const assetType = dataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                const asset = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                const storedAsset = storage.builtinHelper.get(asset);

                const costume = {
                  name: costumeName,
                  assetId: asset,
                  md5ext: asset + '.' + dataFormat,
                  dataFormat: dataFormat,
                  rotationCenterX: dataFormat === 'svg' ? 240 : 0,
                  rotationCenterY: dataFormat === 'svg' ? 180 : 0,
                  bitmapResolution: dataFormat === 'svg' ? 1 : 2,
                  asset: storedAsset
                };

                target.addCostume(costume);
                target.setCostume(target.getCostumes().length - 1);
                vm.runtime.emitProjectChanged();
                result = { success: true, data: { costumeName: costumeName, spriteName: spriteName, format: dataFormat } };
              } catch (e) { result = { success: false, error: 'Failed to add costume from URL: ' + e.message }; }
              break;
            }
            case 'searchAndAddCostume': {
              try {
                const spriteName = params.spriteName || '';
                const query = params.query || '';
                const costumeName = params.costumeName || query || 'costume';
                if (!query) { result = { success: false, error: 'No search query provided' }; break; }
                const target = vm.runtime.targets.find(t => t.getName() === spriteName);
                if (!target) { result = { success: false, error: 'Sprite "' + spriteName + '" not found' }; break; }

                // Search Wikimedia Commons API for freely licensed images
                const searchUrl = 'https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=' +
                  encodeURIComponent(query) + '&format=json&origin=*&srnamespace=6&srlimit=10';
                const searchResponse = await globalThis.fetch(searchUrl);
                if (!searchResponse.ok) { result = { success: false, error: 'Wikimedia search failed: HTTP ' + searchResponse.status }; break; }
                const searchData = await searchResponse.json();
                const pages = searchData?.query?.search || [];
                if (pages.length === 0) { result = { success: false, error: 'No images found for query: ' + query }; break; }

                // Filter to image files only
                const imagePages = pages.filter(p => p.title && p.title.startsWith('File:'));
                if (imagePages.length === 0) { result = { success: false, error: 'No image files found for query: ' + query }; break; }

                // Try each result until we find a usable image
                let imageUrl = null;
                let chosenTitle = '';
                for (var si = 0; si < imagePages.length; si++) {
                  const pageTitle = imagePages[si].title;
                  const infoUrl = 'https://commons.wikimedia.org/w/api.php?action=query&titles=' +
                    encodeURIComponent(pageTitle) + '&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*';
                  const infoResponse = await globalThis.fetch(infoUrl);
                  if (!infoResponse.ok) continue;
                  const infoData = await infoResponse.json();
                  const pagesObj = infoData?.query?.pages || {};
                  for (var pk in pagesObj) {
                    const p = pagesObj[pk];
                    if (p.imageinfo && p.imageinfo.length > 0) {
                      const firstImg = p.imageinfo[0];
                      // Skip very large images (>5MB) and SVG (complex parsing)
                      if (firstImg.size && firstImg.size > 5 * 1024 * 1024) continue;
                      // Prefer small-medium images for Scratch
                      if (firstImg.width && firstImg.width > 2000) continue;
                      if (firstImg.mime && firstImg.mime === 'image/svg+xml') continue;
                      imageUrl = firstImg.url;
                      chosenTitle = pageTitle;
                      break;
                    }
                  }
                  if (imageUrl) break;
                }
                if (!imageUrl) { result = { success: false, error: 'No suitable image found for query: ' + query }; break; }

                // Download the image via main process (bypasses CORS, sets proper User-Agent)
                const buffer = await EditorPreload.fetchImage(imageUrl);

                // Determine format from URL
                const urlLower = imageUrl.toLowerCase();
                let dataFormat = 'png';
                if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) dataFormat = 'jpg';
                else if (urlLower.endsWith('.gif')) dataFormat = 'gif';
                else if (urlLower.endsWith('.bmp')) dataFormat = 'bmp';

                const storage = vm.runtime.storage;
                const assetType = storage.AssetType.ImageBitmap;
                const asset = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                const storedAsset = storage.builtinHelper.get(asset);

                const costume = {
                  name: costumeName,
                  assetId: asset,
                  md5ext: asset + '.' + dataFormat,
                  dataFormat: dataFormat,
                  rotationCenterX: 0,
                  rotationCenterY: 0,
                  bitmapResolution: 2,
                  asset: storedAsset
                };

                target.addCostume(costume);
                target.setCostume(target.getCostumes().length - 1);
                vm.runtime.emitProjectChanged();
                result = { success: true, data: { costumeName: costumeName, spriteName: spriteName, query: query, source: chosenTitle, format: dataFormat } };
              } catch (e) { result = { success: false, error: 'Failed to search and add costume: ' + e.message }; }
              break;
            }
            case 'addSpriteFromUrl': {
              try {
                const spriteName = params.spriteName || 'Sprite';
                const url = params.url || '';
                if (!url) { result = { success: false, error: 'No URL provided' }; break; }

                // Fetch the image via main process (bypasses CORS, sets proper User-Agent)
                const buffer = await EditorPreload.fetchImage(url);

                // Determine format from URL
                const urlLower = url.toLowerCase();
                let dataFormat = 'png';
                if (urlLower.endsWith('.svg')) dataFormat = 'svg';
                else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) dataFormat = 'jpg';
                else if (urlLower.endsWith('.gif')) dataFormat = 'gif';
                else if (urlLower.endsWith('.bmp')) dataFormat = 'bmp';

                const storage = vm.runtime.storage;
                const assetType = dataFormat === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
                const asset = storage.builtinHelper._store(assetType, dataFormat, new Uint8Array(buffer), null);
                const storedAsset = storage.builtinHelper.get(asset);

                const costume = {
                  name: 'costume1',
                  assetId: asset,
                  md5ext: asset + '.' + dataFormat,
                  dataFormat: dataFormat,
                  rotationCenterX: dataFormat === 'svg' ? 47 : 0,
                  rotationCenterY: dataFormat === 'svg' ? 47 : 0,
                  bitmapResolution: dataFormat === 'svg' ? 1 : 2,
                  asset: storedAsset
                };

                const spriteObj = {
                  isStage: false, name: spriteName, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
                  currentCostume: 0, costumes: [costume], sounds: [], volume: 100,
                  layerOrder: vm.runtime.targets.length, visible: true, x: 0, y: 0, size: 100, direction: 90,
                  draggable: false, rotationStyle: 'all around'
                };
                await vm.addSprite(spriteObj);
                const newTarget = vm.runtime.targets[vm.runtime.targets.length - 1];
                result = { success: true, data: { name: spriteName, id: newTarget ? newTarget.id : null, format: dataFormat } };
              } catch (e) { result = { success: false, error: 'Failed to add sprite from URL: ' + e.message }; }
              break;
            }
            case 'getStageScreenshot': {
              try {
                if (!vm.renderer || !vm.renderer.requestSnapshot) {
                  result = { success: false, error: 'Renderer snapshot not available' };
                  break;
                }
                const screenshotDataUrl = await new Promise((resolve, reject) => {
                  const timeout = setTimeout(() => reject(new Error('Screenshot timeout')), 5000);
                  vm.renderer.requestSnapshot((dataURL) => {
                    clearTimeout(timeout);
                    resolve(dataURL);
                  });
                });
                // Extract base64 data from data URL
                const base64Match = screenshotDataUrl.match(/^data:image\/png;base64,(.+)$/);
                if (base64Match) {
                  result = { success: true, data: { image: base64Match[1], format: 'png', mimeType: 'image/png' } };
                } else {
                  result = { success: true, data: { image: screenshotDataUrl, format: 'png', mimeType: 'image/png' } };
                }
              } catch (e) { result = { success: false, error: 'Failed to capture stage screenshot: ' + e.message }; }
              break;
            }
            case 'clickStage': {
              try {
                const scratchX = Number(params.x);
                const scratchY = Number(params.y);
                if (isNaN(scratchX) || isNaN(scratchY)) {
                  result = { success: false, error: 'Invalid coordinates. x and y must be numbers.' };
                  break;
                }
                // Get stage dimensions from renderer, fallback to 480x360
                let canvasWidth = 480;
                let canvasHeight = 360;
                if (vm.runtime && vm.runtime.renderer) {
                  canvasWidth = vm.runtime.renderer._width || canvasWidth;
                  canvasHeight = vm.runtime.renderer._height || canvasHeight;
                }
                // Convert Scratch coordinates (center origin, y-up) to canvas pixel coordinates (top-left origin, y-down)
                const canvasX = scratchX + canvasWidth / 2;
                const canvasY = canvasHeight / 2 - scratchY;
                // Simulate mouse down
                vm.postIOData('mouse', {
                  x: canvasX, y: canvasY,
                  canvasWidth: canvasWidth, canvasHeight: canvasHeight,
                  isDown: true, button: 0
                });
                // Brief delay to register the click
                await new Promise(resolve => setTimeout(resolve, 50));
                // Simulate mouse up
                vm.postIOData('mouse', {
                  x: canvasX, y: canvasY,
                  canvasWidth: canvasWidth, canvasHeight: canvasHeight,
                  isDown: false, button: 0
                });
                result = { success: true, data: { x: scratchX, y: scratchY, message: 'Clicked at (' + scratchX + ', ' + scratchY + ')' } };
              } catch (e) { result = { success: false, error: 'Failed to click stage: ' + e.message }; }
              break;
            }
            case 'setFramerate': {
              try {
                const fps = Number(params.fps);
                if (!fps || fps < 1 || fps > 240) {
                  result = { success: false, error: 'Invalid FPS. Must be between 1 and 240.' };
                  break;
                }
                if (typeof vm.setFramerate === 'function') {
                  vm.setFramerate(fps);
                } else if (vm.runtime && typeof vm.runtime.setFramerate === 'function') {
                  vm.runtime.setFramerate(fps);
                } else {
                  result = { success: false, error: 'setFramerate not available in this VM version' };
                  break;
                }
                const currentFps = (vm.runtime && vm.runtime._framerate) || fps;
                result = { success: true, data: { fps: currentFps, message: 'Frame rate set to ' + currentFps + ' FPS' } };
              } catch (e) { result = { success: false, error: 'Failed to set frame rate: ' + e.message }; }
              break;
            }
            case 'setListItem': {
              const setItemTargetInfo = resolveDataTarget(vm, params);
              if (!setItemTargetInfo.target) { result = { success: false, error: setItemTargetInfo.error }; break; }
              const setItemName = params.listName || params.list_name;
              const setItemFound = findDataVariable(vm, setItemTargetInfo.target, setItemName, 'list');
              if (!setItemFound.variable) { result = { success: false, error: setItemFound.error }; break; }
              const setItemList = setItemFound.variable;
              if (!Array.isArray(setItemList.value)) setItemList.value = [];
              if (setItemList.value.length === 0) {
                result = { success: false, error: 'List "' + setItemName + '" is empty, so there is no item to replace. Use add_to_list first.' };
                break;
              }
              const setItemIdx = resolveListIndex(params.index, setItemList.value.length, {});
              if (setItemIdx.error) { result = { success: false, error: setItemIdx.error }; break; }
              if (params.item === undefined) { result = { success: false, error: 'No item provided' }; break; }
              const replacedValue = setItemList.value[setItemIdx.index];
              setItemList.value[setItemIdx.index] = coerceScratchValue(params.item);
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: Object.assign({
                listName: setItemName, index: setItemIdx.index + 1,
                previousValue: replacedValue, value: setItemList.value[setItemIdx.index],
                owner: setItemFound.owner.getName()
              }, listPreview(setItemList.value)) };
              break;
            }
            case 'insertToList': {
              const insTargetInfo = resolveDataTarget(vm, params);
              if (!insTargetInfo.target) { result = { success: false, error: insTargetInfo.error }; break; }
              const insTarget = insTargetInfo.target;
              const insName = String(params.listName || params.list_name || '').trim();
              if (!insName) { result = { success: false, error: 'No list name provided' }; break; }
              if (params.item === undefined || params.item === null) { result = { success: false, error: 'No item provided' }; break; }
              let insList = null;
              let insCreated = false;
              const insFound = findDataVariable(vm, insTarget, insName, 'list');
              if (insFound.variable) {
                insList = insFound.variable;
              } else {
                if (insTarget.lookupVariableByNameAndType(insName, '')) {
                  result = { success: false, error: 'A variable named "' + insName + '" already exists in this scope, so a list cannot share that name.' };
                  break;
                }
                const insId = '_ai_list_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                insTarget.createVariable(insId, insName, 'list', false);
                insList = insTarget.variables[insId];
                insCreated = true;
              }
              if (!Array.isArray(insList.value)) insList.value = [];
              // allowAppend：插入允许落在"末尾之后"，即长度+1
              const insIdx = resolveListIndex(params.index, insList.value.length, { allowAppend: true });
              if (insIdx.error) { result = { success: false, error: insIdx.error }; break; }
              insList.value.splice(insIdx.index, 0, coerceScratchValue(params.item));
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: Object.assign({
                listName: insName, index: insIdx.index + 1, createdList: insCreated,
                owner: (insFound.owner || insTarget).getName()
              }, listPreview(insList.value)) };
              break;
            }
            case 'clearList': {
              const clrTargetInfo = resolveDataTarget(vm, params);
              if (!clrTargetInfo.target) { result = { success: false, error: clrTargetInfo.error }; break; }
              const clrName = params.listName || params.list_name;
              const clrFound = findDataVariable(vm, clrTargetInfo.target, clrName, 'list');
              if (!clrFound.variable) { result = { success: false, error: clrFound.error }; break; }
              const clearedCount = Array.isArray(clrFound.variable.value) ? clrFound.variable.value.length : 0;
              clrFound.variable.value = [];
              vm.runtime.emitProjectChanged();
              vm.emitWorkspaceUpdate();
              result = { success: true, data: { listName: clrName, removedCount: clearedCount, length: 0, owner: clrFound.owner.getName() } };
              break;
            }
            case 'getExtensionCode': {
              try {
                const extensionManager = vm.extensionManager;
                if (!extensionManager) { result = { success: false, error: 'Extension manager not available' }; break; }
                const loadedExtensions = extensionManager._loadedExtensions;
                if (!loadedExtensions) { result = { success: false, error: 'No loaded extensions' }; break; }
                // Collect all extension entries (handle both Map and plain object)
                const entries = [];
                if (typeof loadedExtensions.entries === 'function') {
                  for (const [k, v] of loadedExtensions.entries()) entries.push([k, v]);
                } else {
                  Object.keys(loadedExtensions).forEach(k => entries.push([k, loadedExtensions[k]]));
                }
                if (entries.length === 0) { result = { success: false, error: 'No loaded extensions found' }; break; }
                const queryId = (params.extensionId || '').toLowerCase();
                const queryName = (params.extensionName || '').toLowerCase();
                // Find matching extension by URL/ID or by name
                let matchedKey = null;
                let matchedExt = null;
                for (const [key, ext] of entries) {
                  if (key && key.toLowerCase().includes(queryId)) { matchedKey = key; matchedExt = ext; break; }
                  try {
                    const info = ext && ext.getInfo ? ext.getInfo() : null;
                    if (info) {
                      if (info.id && info.id.toLowerCase() === queryId) { matchedKey = key; matchedExt = ext; break; }
                      if (info.name && info.name.toLowerCase() === queryName) { matchedKey = key; matchedExt = ext; break; }
                      if (info.name && info.name.toLowerCase().includes(queryName) && queryName) { matchedKey = key; matchedExt = ext; break; }
                    }
                  } catch (e2) { /* ignore */ }
                }
                if (!matchedKey) {
                  // Return list of available extensions for the user
                  const available = entries.map(([key, ext]) => {
                    let name = key;
                    try { const info = ext && ext.getInfo ? ext.getInfo() : null; if (info && info.name) name = info.name + ' (id: ' + (info.id || key) + ')'; } catch (e2) { /* ignore */ }
                    return name;
                  });
                  result = { success: false, error: 'Extension not found. Available: ' + available.join(', ') };
                  break;
                }
                // Try to get the source code
                let sourceCode = '';
                let sourceType = '';
                if (matchedKey.startsWith('data:')) {
                  // Data URL - decode the source
                  sourceType = 'data-url';
                  try {
                    const commaIdx = matchedKey.indexOf(',');
                    if (commaIdx >= 0) sourceCode = decodeURIComponent(matchedKey.substring(commaIdx + 1));
                  } catch (e2) { sourceCode = '(Failed to decode data URL)'; }
                } else if (matchedKey.startsWith('http://') || matchedKey.startsWith('https://')) {
                  // HTTP URL - fetch the source
                  sourceType = 'url';
                  try {
                    const response = await fetch(matchedKey);
                    sourceCode = await response.text();
                  } catch (e2) { sourceCode = '(Failed to fetch from ' + matchedKey + ': ' + e2.message + ')'; }
                } else {
                  // Built-in or unknown - try to get constructor source
                  sourceType = 'builtin';
                  try {
                    if (matchedExt && matchedExt.constructor) {
                      sourceCode = '// Extension: ' + matchedKey + '\n// Type: ' + sourceType + '\n// Constructor source:\n' + matchedExt.constructor.toString();
                    } else if (matchedExt && typeof matchedExt === 'function') {
                      sourceCode = matchedExt.toString();
                    } else {
                      // Try to serialize the extension info
                      const info = matchedExt && matchedExt.getInfo ? matchedExt.getInfo() : null;
                      sourceCode = '// Extension: ' + matchedKey + '\n// Type: ' + sourceType + ' (source not available)\n// Extension info:\n' + JSON.stringify(info, null, 2);
                    }
                  } catch (e2) { sourceCode = '(Failed to get source: ' + e2.message + ')'; }
                }
                // Truncate if too long
                const maxLength = 50000;
                let truncated = false;
                if (sourceCode.length > maxLength) { sourceCode = sourceCode.substring(0, maxLength) + '\n\n... (truncated, total ' + sourceCode.length + ' chars)'; truncated = true; }
                // Get extension info for context
                let extInfo = null;
                try { extInfo = matchedExt && matchedExt.getInfo ? matchedExt.getInfo() : null; } catch (e2) { /* ignore */ }
                result = {
                  success: true,
                  data: {
                    extensionKey: matchedKey,
                    sourceType: sourceType,
                    sourceCode: sourceCode,
                    truncated: truncated,
                    info: extInfo ? { id: extInfo.id, name: extInfo.name, blockCount: extInfo.blocks ? extInfo.blocks.length : 0 } : null
                  }
                };
              } catch (e) { result = { success: false, error: 'Failed to get extension code: ' + e.message }; }
              break;
            }
            case 'sendKeyToStage': {
              try {
                const key = params.key;
                if (!key) { result = { success: false, error: 'No key provided' }; break; }
                const duration = Number(params.duration) || 100;
                // Key code mapping for common keys
                const keyCodeMap = {
                  'space': 32, 'enter': 13, 'return': 13, 'tab': 9, 'escape': 27, 'esc': 27,
                  'backspace': 8, 'delete': 46, 'home': 36, 'end': 35, 'page up': 33, 'page down': 34,
                  'up': 38, 'down': 40, 'left': 37, 'right': 39,
                  'shift': 16, 'control': 17, 'ctrl': 17, 'alt': 18, 'option': 18, 'meta': 91, 'command': 91
                };
                const normalizedKey = key.toLowerCase();
                const keyCode = keyCodeMap[normalizedKey] || (normalizedKey.length === 1 ? normalizedKey.charCodeAt(0) : 0);
                // Send key down
                vm.postIOData('keyboard', {
                  key: normalizedKey,
                  code: keyCode,
                  isDown: true
                });
                // Hold the key for the specified duration
                await new Promise(resolve => setTimeout(resolve, duration));
                // Send key up
                vm.postIOData('keyboard', {
                  key: normalizedKey,
                  code: keyCode,
                  isDown: false
                });
                result = { success: true, data: { key: normalizedKey, keyCode: keyCode, duration: duration, message: 'Key "' + key + '" sent to stage' } };
              } catch (e) { result = { success: false, error: 'Failed to send key: ' + e.message }; }
              break;
            }
            case 'duplicateSprite': {
              try {
                const dupSourceName = String(params.sourceName || params.source_name || params.spriteName || params.sprite_name || '').trim();
                const dupNewName = String(params.newName || params.new_name || '').trim();
                if (!dupSourceName) { result = { success: false, error: 'No source sprite name provided' }; break; }
                const dupSource = vm.runtime.targets.find(t => !t.isStage && t.getName() === dupSourceName);
                if (!dupSource) {
                  const names = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
                  const hint = closestName(dupSourceName, names);
                  result = { success: false, error: 'Sprite "' + dupSourceName + '" not found.' +
                    (hint ? ' Did you mean "' + hint + '"?' : '') +
                    ' Available: ' + (names.length ? names.join(', ') : '(none)') };
                  break;
                }
                if (dupNewName && vm.runtime.targets.some(t => !t.isStage && t.getName() === dupNewName)) {
                  result = { success: false, error: 'A sprite named "' + dupNewName + '" already exists. Pick another name.' };
                  break;
                }
                const idsBefore = vm.runtime.targets.map(t => t.id);
                await vm.duplicateSprite(dupSource.id);
                // 原实现用 vm.editingTarget 猜新角色；那是"当前编辑对象"，并不保证
                // 就是刚复制出来的那个。改成对比复制前后的 id 集合。
                const dupTarget = vm.runtime.targets.find(t => idsBefore.indexOf(t.id) < 0);
                if (!dupTarget) { result = { success: false, error: 'Duplication finished but the new sprite could not be located.' }; break; }
                const autoName = dupTarget.getName();
                if (dupNewName) vm.renameSprite(dupTarget.id, dupNewName);
                const finalName = dupTarget.getName();
                vm.runtime.emitProjectChanged();
                vm.emitTargetsUpdate();
                result = { success: true, data: {
                  sourceName: dupSourceName, name: finalName,
                  // 没传 new_name 时 Scratch 会自动编号（Cat2 等），把实际名字回报清楚
                  autoNamed: !dupNewName, defaultName: autoName,
                  renamedAsRequested: !dupNewName || finalName === dupNewName,
                  copiedScripts: Object.keys(dupTarget.blocks._blocks).filter(id => dupTarget.blocks._blocks[id].topLevel).length,
                  copiedCostumes: dupTarget.getCostumes().length,
                  copiedLocalVariables: Object.values(dupTarget.variables).map(v => v.name)
                } };
              } catch (e) { result = { success: false, error: 'Failed to duplicate sprite: ' + e.message }; }
              break;
            }
            case 'captureProjectSnapshot': {
              // 撤销 AI 更改：在动手前存一份完整工程快照。
              // 用 sb3 压缩包而非 project.json，因为恢复走的 loadProject 不带 zip 时
              // 造型/声音只能靠 storage 缓存命中——AI 新加的素材未必在缓存里，
              // 那样恢复出来会缺图。压缩包自带资产，恢复必然完整。
              // ArrayBuffer 留在编辑器这一侧，AI 窗口只拿 id，避免几十 MB 走 IPC。
              try {
                const snapId = params.snapshotId ? String(params.snapshotId) : ('snap_' + Date.now());
                if (aiSnapshots.has(snapId)) {
                  result = { success: true, data: { snapshotId: snapId, existed: true, bytes: aiSnapshots.get(snapId).bytes } };
                  break;
                }
                const buffer = await vm.saveProjectSb3('arraybuffer');
                // 只保留最近若干份，免得连续多轮对话把内存吃满
                while (aiSnapshotOrder.length >= AI_SNAPSHOT_LIMIT) {
                  const evicted = aiSnapshotOrder.shift();
                  aiSnapshots.delete(evicted);
                }
                aiSnapshots.set(snapId, {
                  buffer: buffer,
                  bytes: buffer.byteLength,
                  createdAt: Date.now(),
                  spriteCount: vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).length
                });
                aiSnapshotOrder.push(snapId);
                result = { success: true, data: { snapshotId: snapId, existed: false, bytes: buffer.byteLength } };
              } catch (e) {
                result = { success: false, error: 'Failed to capture project snapshot: ' + (e.message || String(e)) };
              }
              break;
            }
            case 'restoreProjectSnapshot': {
              try {
                const restoreId = String(params.snapshotId || '');
                const snap = aiSnapshots.get(restoreId);
                if (!snap) {
                  result = { success: false, error: 'Snapshot "' + restoreId + '" is no longer available. It may have been evicted, or the editor was reopened since it was taken.' };
                  break;
                }
                const beforeSprites = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).length;
                // 先停掉正在跑的脚本：loadProject 会换掉整个 runtime，
                // 让线程继续跑到一半再被抽走会留下悬空引用。
                vm.stopAll();
                await vm.loadProject(snap.buffer);
                vm.runtime.emitProjectChanged();
                vm.emitWorkspaceUpdate();
                vm.emitTargetsUpdate();
                result = { success: true, data: {
                  snapshotId: restoreId,
                  spriteCountBefore: beforeSprites,
                  spriteCountAfter: vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).length,
                  capturedAt: snap.createdAt
                } };
              } catch (e) {
                result = { success: false, error: 'Failed to restore project: ' + (e.message || String(e)) };
              }
              break;
            }
            case 'hasProjectSnapshot': {
              // 会话是从 localStorage 恢复的，快照却只活在编辑器内存里；
              // 渲染撤销按钮前先问一句，免得摆出一个点了必然失败的按钮。
              const askId = String(params.snapshotId || '');
              const askSnap = aiSnapshots.get(askId);
              result = { success: true, data: {
                snapshotId: askId, exists: !!askSnap,
                bytes: askSnap ? askSnap.bytes : 0,
                capturedAt: askSnap ? askSnap.createdAt : null
              } };
              break;
            }
            case 'dropProjectSnapshot': {
              const dropId = String(params.snapshotId || '');
              const had = aiSnapshots.delete(dropId);
              const orderIdx = aiSnapshotOrder.indexOf(dropId);
              if (orderIdx >= 0) aiSnapshotOrder.splice(orderIdx, 1);
              result = { success: true, data: { snapshotId: dropId, existed: had } };
              break;
            }            default:
              result = { success: false, error: 'Unknown tool: ' + toolName };
          }
        } catch (e) {
          result = { success: false, error: e.message };
        }
        EditorPreload.sendAIToolResponse({ requestId, result });
      });

      EditorPreload.onRequestSpriteLibrary((data) => {
        const libRequestId = data && data.requestId;
        try {
          import(
            /* webpackChunkName: "sprite-library" */
            'scratch-gui/src/lib/libraries/tw-async-libraries'
          ).then(module => {
            const library = module.getSpriteLibrary();
            const resolveLibrary = (payload) => {
              // 回带 requestId：多个窗口（SOLO + AI 助手）并发取素材库时结果不能串台
              EditorPreload.sendSpriteLibrary({ requestId: libRequestId, data: payload });
            };
            if (library && library.then) {
              library.then(resolveLibrary);
            } else {
              resolveLibrary(library);
            }
          }).catch(() => {
            EditorPreload.sendSpriteLibrary({ requestId: libRequestId, data: [] });
          });
        } catch (e) {
          EditorPreload.sendSpriteLibrary({ requestId: libRequestId, data: [] });
        }
      });

      EditorPreload.onRequestTheme((data) => {
        try {
          const raw = localStorage.getItem('tw:theme');
          let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          if (raw) {
            if (raw === '"dark"' || raw === 'dark') {
              isDark = true;
            } else if (raw === '"light"' || raw === 'light') {
              isDark = false;
            } else {
              try {
                const parsed = JSON.parse(raw);
                if (parsed.gui === 'dark') isDark = true;
                if (parsed.gui === 'light') isDark = false;
              } catch(e) {}
            }
          }
          EditorPreload.sendTheme({ requestId: data.requestId, theme: isDark ? 'dark' : 'light' });
        } catch (e) {
          EditorPreload.sendTheme({ requestId: data.requestId, theme: 'light' });
        }
      });

      var lastTheme = null;
      var checkThemeChange = function() {
        try {
          var raw = localStorage.getItem('tw:theme');
          var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          if (raw) {
            if (raw === '"dark"' || raw === 'dark') {
              isDark = true;
            } else if (raw === '"light"' || raw === 'light') {
              isDark = false;
            } else {
              try {
                var parsed = JSON.parse(raw);
                if (parsed.gui === 'dark') isDark = true;
                if (parsed.gui === 'light') isDark = false;
              } catch(e) {}
            }
          }
          var current = isDark ? 'dark' : 'light';
          if (lastTheme !== null && lastTheme !== current) {
            lastTheme = current;
            document.documentElement.setAttribute('data-gui-theme', current);
            EditorPreload.notifyThemeChanged(current);
          } else if (lastTheme === null) {
            lastTheme = current;
            document.documentElement.setAttribute('data-gui-theme', current);
          }
        } catch(e) {}
      };
      var themeInterval = setInterval(checkThemeChange, 1000);

      // 全局 UI 主题（桌面设置 → UI 设置）：写入 tw:theme 保证重启与系统主题
      // 变化后仍保持全局设置；再 dispatch Redux setTheme 让编辑器即时切换，
      // 并广播给 SOLO、AI 助手等子窗口（不等 1 秒轮询）。
      var applyGlobalUITheme = function(mode) {
        try {
          var parsed = {};
          try {
            parsed = JSON.parse(localStorage.getItem('tw:theme'));
          } catch (e) {}
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            parsed = {};
          }
          if (mode === 'light' || mode === 'dark') {
            parsed.gui = mode;
            localStorage.setItem('tw:theme', JSON.stringify(parsed));
          } else {
            // 跟随系统：移除 gui 覆盖，保留 accent/blocks 等自定义
            delete parsed.gui;
            if (Object.keys(parsed).length === 0) {
              localStorage.removeItem('tw:theme');
            } else {
              localStorage.setItem('tw:theme', JSON.stringify(parsed));
            }
          }
          var theme = detectTheme();
          if (this.props.guiTheme && this.props.guiTheme.blocks === BLOCKS_CUSTOM) {
            theme = theme.set('blocks', BLOCKS_CUSTOM);
          }
          if (mode === 'light' || mode === 'dark') {
            theme = theme.set('gui', mode);
          }
          this.props.onSetGuiTheme(theme);
          var current = (mode === 'light' || mode === 'dark') ? mode : (theme.gui === 'dark' ? 'dark' : 'light');
          document.documentElement.setAttribute('data-gui-theme', current);
          lastTheme = current;
          EditorPreload.notifyThemeChanged(current);
        } catch (e) {}
      }.bind(this);
      if (EditorPreload.getGlobalUITheme) {
        EditorPreload.getGlobalUITheme().then(applyGlobalUITheme).catch(() => {});
      }
      if (EditorPreload.onGlobalUIThemeChanged) {
        EditorPreload.onGlobalUIThemeChanged(applyGlobalUITheme);
      }

      // 顶部工具栏高度（桌面设置 → UI 设置）：normal（默认）/ narrow。
      // 初始值在 index.jsx 渲染前已同步写入 <html>，这里只负责之后的变更。
      // 关键：scratch-blocks 只在 window 的 resize 事件里重新测量代码区
      // （inject.js 的 workspaceResizeHandler），改 CSS 不会触发它，
      // 画布会停留在旧尺寸、与容器错位。因此改完属性要补发一次 resize。
      // 这与 scratch-gui 自己在 blocks.jsx 里切换舞台尺寸时的做法一致。
      var applyToolbarHeight = function(height) {
        try {
          var next = height === 'narrow' ? 'narrow' : 'normal';
          var current = document.documentElement.getAttribute('data-toolbar-height');
          if (current === next) return;
          document.documentElement.setAttribute('data-toolbar-height', next);
          // 等一帧再触发，确保浏览器已按新高度完成布局，Blockly 量到的
          // 才是最终尺寸（getBoundingClientRect 会同步触发 reflow）。
          window.requestAnimationFrame(function() {
            window.dispatchEvent(new Event('resize'));
          });
        } catch (e) {}
      };
      if (EditorPreload.onToolbarHeightChanged) {
        EditorPreload.onToolbarHeightChanged(applyToolbarHeight);
      }

      // NeoWarp: 右键菜单毛玻璃效果（桌面设置 → UI 设置）。初始值已在
      // index.jsx 渲染前写入 <html>，这里只负责之后的变更；纯 CSS 开关，
      // 改属性即生效（下一次右键打开菜单时即为新样式）。
      if (EditorPreload.onContextMenuGlassChanged) {
        EditorPreload.onContextMenuGlassChanged(function (enabled) {
          try {
            document.documentElement.setAttribute('data-ctx-menu-glass', enabled ? 'on' : 'off');
          } catch (e) {}
        });
      }

      // NeoWarp: Windows 窗口样式（compact）：系统按钮并入顶栏时顶栏高度
      // 变为 36px 并保持窄档，<html> 的 data-compact-window-style 由
      // window-titlebar.js 在 React 渲染前就写好并处理广播；这里再兜底
      // 订阅一次，行为与 toolbar-height 相同（幂等：<html> 已是目标值时
      // 不重复发 resize）。属性存在与否代表本窗口是否启用了标题栏覆盖层。
      if (EditorPreload.onCompactWindowStyleChanged &&
          document.documentElement.hasAttribute('data-compact-window-style')) {
        EditorPreload.onCompactWindowStyleChanged(function (compact) {
          try {
            var next = compact === true ? 'compact' : 'normal';
            if (document.documentElement.getAttribute('data-compact-window-style') === next) {
              return;
            }
            document.documentElement.setAttribute('data-compact-window-style', next);
            window.requestAnimationFrame(function () {
              window.dispatchEvent(new Event('resize'));
            });
          } catch (e) {}
        });
      }

      // This component is re-mounted when the locale changes, but we only want to load
      // the initial project once.
      if (mountedOnce) {
        return;
      }
      mountedOnce = true;

      this.props.onLoadingStarted();
      (async () => {
        // Note that 0 is a valid ID and does mean there is a file open
        const id = await EditorPreload.getInitialFile();
        if (id === null) {
          this.props.onHasInitialProject(false, this.props.loadingState);
          this.props.onLoadingCompleted();
          return;
        }

        this.props.onHasInitialProject(true, this.props.loadingState);
        const fileInfo = await EditorPreload.getFile(id);

        let projectData = fileInfo.data;

        // Handle encrypted .npnp files
        if (fileInfo.isEncrypted) {
          let decrypted = false;
          while (!decrypted) {
            const password = await showPasswordDialog();
            if (!password) {
              // User cancelled - load default project instead
              this.props.onLoadingCompleted();
              this.props.onLoadedProject(this.props.loadingState, false);
              this.props.onHasInitialProject(false, this.props.loadingState);
              this.props.onRequestNewProject();
              return;
            }
            try {
              projectData = await EditorPreload.decryptNpnpFile(id, password);
              decrypted = true;
            } catch (e) {
              // Wrong password, show dialog again
              continue;
            }
          }
        }

        await this.props.vm.loadProject(projectData);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, true);

        const title = getDefaultProjectTitle(fileInfo.name);
        if (title) {
          this.setState({
            title
          });
        }

        if (fileInfo.type === 'file' && (fileInfo.name.endsWith('.sb3') || fileInfo.name.endsWith('.np1') || fileInfo.name.endsWith('.npnp'))) {
          this.props.onSetFileHandle(new WrappedFileHandle(id, fileInfo.name));
        }

        // Handle .viewsb3 view-only mode: lock to fullscreen stage
        if (fileInfo.isViewOnly) {
          this.props.onSetViewOnly(true);
          // Delay fullscreen slightly to ensure stage is rendered
          setTimeout(() => {
            this.props.onSetFullScreen(true);
          }, 100);
        }
      })().catch(error => {
        console.error(error);

        this.props.onShowErrorModal(error);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, false);
        this.props.onHasInitialProject(false, this.props.loadingState);
        this.props.onRequestNewProject();
      });

      // AI 相关监听（onAIToolCall / onRequestProjectJSON / onRequestSpriteLibrary
      // / onRequestTheme 等）已在上面全部注册：通知主进程可以安全派发工具调用。
      // Web 端 shim 没有这个方法，按旧行为处理即可。
      if (typeof EditorPreload.sendAIListenersReady === 'function') {
        EditorPreload.sendAIListenersReady();
      }
    }
    componentDidUpdate (prevProps, prevState) {
      if (this.props.projectChanged !== prevProps.projectChanged) {
        EditorPreload.setChanged(this.props.projectChanged);
      }

      if (this.state.title !== prevState.title) {
        document.title = this.state.title;
      }

      if (this.props.fileHandle !== prevProps.fileHandle) {
        if (this.props.fileHandle) {
          EditorPreload.openedFile(this.props.fileHandle.id);
        } else {
          EditorPreload.closedFile();
        }
      }

      if (this.props.reduxUsername !== prevProps.reduxUsername) {
        localStorage.setItem(USERNAME_KEY, this.props.reduxUsername);
      }

      if (this.props.isFullScreen !== prevProps.isFullScreen) {
        EditorPreload.setIsFullScreen(this.props.isFullScreen);
      }

      // NeoWarp: 当新建项目加载完成时，自动添加标记了“自动添加到新项目”的扩展
      if (prevProps.loadingState === LoadingState.LOADING_VM_NEW_DEFAULT &&
          this.props.loadingState === LoadingState.SHOWING_WITHOUT_ID) {
        this.loadAutoAddExtensions();
      }
    }
    // NeoWarp: 加载标记了“自动添加到新项目”的我的扩展
    loadAutoAddExtensions () {
      const vm = this.props.vm;
      if (!vm || !vm.extensionManager || !vm.extensionManager.loadExtensionURL) return;
      const extensions = getAutoAddExtensions();
      if (!extensions.length) return;
      // 顺序加载，避免并发冲突；单个失败不影响其它
      extensions.reduce((promise, ext) => promise.then(() => {
        const url = ext.extensionURL;
        if (!url) return Promise.resolve();
        // 若扩展需要脱离沙盒运行，先信任它
        if (ext.unsandboxed) {
          manuallyTrustExtension(url);
        }
        return vm.extensionManager.loadExtensionURL(url).catch(e => {
          console.error('Auto-add extension failed:', ext.name, e);
        });
      }), Promise.resolve());
    }
    componentWillUnmount () {
      stopFrameStreaming();
      stopSoloStream();
      isStageDetached = false;
      if (this._flyoutFrostInterval) {
        clearInterval(this._flyoutFrostInterval);
        this._flyoutFrostInterval = null;
      }
      if (this._codeAreaBackgroundObserver) {
        this._codeAreaBackgroundObserver.disconnect();
        this._codeAreaBackgroundObserver = null;
      }
      if (this._stageAreaBackgroundObserver) {
        this._stageAreaBackgroundObserver.disconnect();
        this._stageAreaBackgroundObserver = null;
      }
      if (this._codeAreaBackgroundTimeouts) {
        this._codeAreaBackgroundTimeouts.forEach(id => clearTimeout(id));
        this._codeAreaBackgroundTimeouts = [];
      }
      if (this._stageAreaBackgroundTimeouts) {
        this._stageAreaBackgroundTimeouts.forEach(id => clearTimeout(id));
        this._stageAreaBackgroundTimeouts = [];
      }
      if (this._collabWorkspaceRefreshTimer) {
        clearTimeout(this._collabWorkspaceRefreshTimer);
        this._collabWorkspaceRefreshTimer = null;
      }
      if (this._collabLoadCooldown) {
        clearTimeout(this._collabLoadCooldown);
        this._collabLoadCooldown = null;
      }
      if (this._collabSyncTimer) {
        clearTimeout(this._collabSyncTimer);
        this._collabSyncTimer = null;
      }
    }
    setupFlyoutFrostedGlass () {
      const injectionDiv = document.querySelector('.injectionDiv');
      if (!injectionDiv) return;

      const existing = injectionDiv.querySelector('#neowarp-flyout-frost');
      if (existing) existing.remove();

      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const bgColor = isDark ? 'rgba(17, 17, 17, 0.35)' : 'rgba(255, 255, 255, 0.35)';

      const frostDiv = document.createElement('div');
      frostDiv.id = 'neowarp-flyout-frost';
      frostDiv.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        backdrop-filter: blur(12px) saturate(1.5);
        -webkit-backdrop-filter: blur(12px) saturate(1.5);
        background: ${bgColor};
        z-index: 2;
        pointer-events: none;
        display: none;
      `;
      injectionDiv.appendChild(frostDiv);

      const toggleFrost = () => {
        const flyout = document.querySelector('.blocklyFlyout');
        if (!flyout) {
          frostDiv.style.display = 'none';
          return;
        }
        let visible = false;
        if (flyout.style.display !== 'none') {
          const bg = flyout.querySelector('.blocklyFlyoutBackground');
          if (bg) {
            try {
              if (bg.getAttribute('width') && parseFloat(bg.getAttribute('width')) > 0) {
                visible = true;
              }
            } catch (e) {
              visible = true;
            }
          } else {
            visible = true;
          }
        }
        frostDiv.style.display = visible ? 'block' : 'none';
      };

      toggleFrost();
      this._flyoutFrostInterval = setInterval(toggleFrost, 300);

      const flyoutEl = document.querySelector('.blocklyFlyout');
      if (flyoutEl) {
        const observer = new MutationObserver(toggleFrost);
        observer.observe(flyoutEl, { attributes: true, childList: true, subtree: true });
      }
    }
    // NeoWarp: Serialize the whole project (code + every asset) as an sb3
    // archive so collaborators receive costumes, backdrops and sounds too,
    // not just md5 references they cannot resolve.
    buildCollabProjectPayload () {
      return Promise.resolve()
        .then(() => this.props.vm.saveProjectSb3('arraybuffer'))
        .then((sb3) => ({format: COLLAB_PROJECT_FORMAT, data: arrayBufferToBase64(sb3)}))
        .catch((error) => {
          // Fall back to bare JSON: syncing the code without assets still
          // beats not syncing at all.
          console.error('Collab: failed to build sb3 payload, falling back to JSON', error);
          return this.props.vm.toJSON();
        });
    }

    // Decode a collaboration payload into what vm.loadProject accepts. Peers
    // send {format:'sb3', data:<base64>} so assets travel along; a bare JSON
    // project (older peer, or the sb3 fallback) is still accepted.
    parseCollabProject (raw) {
      let project = raw;
      if (typeof project === 'string') {
        project = JSON.parse(project);
      }
      if (project && typeof project === 'object' &&
          project.format === COLLAB_PROJECT_FORMAT && project.data) {
        return base64ToArrayBuffer(project.data);
      }
      return project;
    }

    // NeoWarp: Apply a project state received from a collaborator.
    // Structural changes are applied incrementally (per sprite, in place) so
    // peers no longer reload the whole project on every edit; stage-level or
    // global changes fall back to a full reload. Applications are chained so
    // overlapping remote updates land in arrival order.
    applyCollabProjectUpdate (data) {
      this._collabApplyChain = (this._collabApplyChain || Promise.resolve())
        .then(() => this.collabApplyProjectUpdateInner(data))
        .catch(error => {
          console.error('Collab: failed to apply remote project update', error);
        });
    }

    // Decode a received payload into {raw, projectJSON, zip}: raw is what
    // vm.loadProject accepts (sb3 ArrayBuffer or bare JSON), projectJSON/zip
    // power the incremental diff.
    collabReadPayload (project) {
      return Promise.resolve()
        .then(() => {
          const raw = this.parseCollabProject(project);
          if (raw instanceof ArrayBuffer) {
            return JSZip.loadAsync(raw).then(zip =>
              zip.file('project.json').async('string').then(text => ({
                raw,
                projectJSON: JSON.parse(text),
                zip
              }))
            );
          }
          const projectJSON = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return {raw, projectJSON, zip: null};
        })
        .catch(error => {
          console.error('Collab: failed to decode project payload', error);
          return null;
        });
    }

    // Compute how to apply a remote project: a full reload, or a list of
    // per-sprite operations applied in place.
    collabBuildApplyPlan (projectJSON, zip) {
      const vm = this.props.vm;
      const localJSON = JSON.parse(vm.toJSON());
      const remoteStage = (projectJSON.targets || []).find(target => target.isStage);
      const localStage = (localJSON.targets || []).find(target => target.isStage);
      if (!remoteStage || !localStage) return {fullLoad: true};

      const stringify = value => collabStableStringify(value);
      // Monitor differences are applied in place through the runtime monitor
      // API; deliberately NOT a full reload (the most frequent source of
      // whole-project flicker: variable creation, monitor drags, checks)
      const monitorChanges = collabMonitorChanges(localJSON.monitors, projectJSON.monitors);
      if (stringify(projectJSON.extensionURLs || null) !== stringify(localJSON.extensionURLs || null) ||
          stringify(projectJSON.customFonts || null) !== stringify(localJSON.customFonts || null) ||
          stringify(projectJSON.extensionStorage || null) !== stringify(localJSON.extensionStorage || null)) {
        return {fullLoad: true};
      }

      const stageChanges = collabStageChanges(localStage, remoteStage);
      if (stageChanges === null) return {fullLoad: true};

      const remoteSprites = (projectJSON.targets || []).filter(target => !target.isStage);
      const localTargets = vm.runtime.targets.filter(target => target.isSprite && target.isSprite());
      const localTargetByName = new Map(localTargets.map(target => [target.getName(), target]));
      const localJsonByName = new Map((localJSON.targets || [])
        .filter(target => !target.isStage)
        .map(target => [target.name, target]));
      const remoteNames = new Set(remoteSprites.map(target => target.name));

      const ops = [];
      for (const sprite of remoteSprites) {
        const localTarget = localTargetByName.get(sprite.name);
        if (!localTarget) {
          ops.push({op: 'add', sprite, zip});
          continue;
        }
        const localSprite = localJsonByName.get(sprite.name);
        if (!localSprite || collabSpritesEqual(localSprite, sprite)) continue;
        if (collabSpriteRuntimePropsOnly(localSprite, sprite)) {
          ops.push({op: 'props', target: localTarget, sprite});
        } else {
          ops.push({op: 'replace', target: localTarget, sprite, zip});
        }
      }
      for (const target of localTargets) {
        if (!remoteNames.has(target.getName())) ops.push({op: 'delete', target});
      }

      const desiredOrder = remoteSprites.map(target => target.name);
      const currentOrder = localTargets.map(target => target.getName());
      const structural = ops.some(op => op.op === 'add' || op.op === 'delete');
      const orderDiffers = currentOrder.length === desiredOrder.length &&
        currentOrder.some((name, index) => name !== desiredOrder[index]);
      if (structural || orderDiffers) ops.push({op: 'reorder', desiredOrder});

      if (ops.length === 0 && stageChanges.additions.length === 0 && stageChanges.deletions.length === 0 &&
          monitorChanges.additions.length === 0 && monitorChanges.updates.length === 0 &&
          monitorChanges.deletions.length === 0) {
        return {noop: true};
      }
      return {ops, stageChanges, monitorChanges};
    }

    async collabApplyProjectUpdateInner (data) {
      const decoded = await this.collabReadPayload(data.project);
      if (!decoded) return;
      const {raw, projectJSON, zip} = decoded;

      let plan = null;
      try {
        plan = this.collabBuildApplyPlan(projectJSON, zip);
      } catch (error) {
        console.error('Collab: incremental diff failed, falling back to reload', error);
      }
      if (plan && !plan.fullLoad) {
        if (plan.noop) return; // identical state: no churn, no echo
        // A previous apply's cooldown must not fire mid-apply and drop the
        // echo guard this apply is about to install
        if (this._collabLoadCooldown) {
          clearTimeout(this._collabLoadCooldown);
          this._collabLoadCooldown = null;
        }
        // Swallow PROJECT_CHANGED events our own apply triggers, so the
        // refreshed state does not echo back to the sender
        this._collabLoadingProject = true;
        if (this._collabSyncTimer) {
          // A debounced send was scheduled for genuine local changes: don't
          // drop them, re-broadcast once the apply has settled
          this._collabMissedLocalChange = true;
          clearTimeout(this._collabSyncTimer);
          this._collabSyncTimer = null;
        }
        this._collabApplyingRemote = true;
        let applyFailed = false;
        try {
          await this.collabApplyPlan(plan);
        } catch (error) {
          console.error('Collab: incremental apply failed, falling back to reload', error);
          applyFailed = true;
        }
        this._collabApplyingRemote = false;
        if (applyFailed) {
          this._collabLoadingProject = false;
          this.collabFullLoad(raw);
          return;
        }
        this._collabLoadCooldown = setTimeout(() => {
          this._collabLoadCooldown = null;
          this._collabLoadingProject = false;
          if (this._collabMissedLocalChange) {
            // Local edits that were swallowed while this remote update was
            // being applied must still reach the room
            this._collabMissedLocalChange = false;
            this._collabBroadcastProject();
          }
          const pending = this._collabPendingProject;
          if (pending) {
            this._collabPendingProject = null;
            this.applyCollabProjectUpdate(pending);
          }
        }, 300);
        return;
      }
      this.collabFullLoad(raw);
    }

    collabApplyPlan (plan) {
      const vm = this.props.vm;
      const editingTargetBefore = vm.editingTarget;
      const stage = vm.runtime.getTargetForStage();
      // At runtime ALL stage data (scalars, lists, broadcasts) lives in
      // stage.variables; the variables/lists/broadcasts split only exists in
      // serialized project JSON
      for (const {id, name, type, isCloud} of plan.stageChanges.additions) {
        if (!Object.prototype.hasOwnProperty.call(stage.variables, id)) {
          stage.createVariable(id, name, type, isCloud);
        }
      }
      for (const {id} of plan.stageChanges.deletions) {
        if (Object.prototype.hasOwnProperty.call(stage.variables, id)) {
          delete stage.variables[id];
        }
      }
      if (plan.stageChanges.deletions.length > 0) {
        // Recreate any variable a local block still references (the peer was
        // guaranteed to have no references, but this editor might)
        for (const target of vm.runtime.targets) {
          target.fixUpVariableReferences();
        }
      }
      // Deletions and property merges run synchronously first; add/replace
      // deserialize assets and run sequentially to keep ordering deterministic.
      // Stamping whether an op touched the editing target must happen HERE:
      // collabReplaceSprite/collabDeleteSprite swap in new target objects (and
      // possibly a new editing target), so the identity captured in the plan
      // would no longer match vm.editingTarget afterwards.
      for (const op of plan.ops) {
        if (op.op === 'props') {
          this.collabApplyRuntimeProps(op.target, op.sprite);
        } else if (op.op === 'delete') {
          op.hadEditingTarget = op.target === vm.editingTarget;
          this.collabDeleteSprite(op.target);
        } else if (op.op === 'replace') {
          op.hadEditingTarget = op.target === vm.editingTarget;
        }
      }
      const asyncOps = plan.ops.filter(op => op.op === 'replace' || op.op === 'add');
      return asyncOps.reduce((chain, op) => chain.then(() => {
        const work = op.op === 'replace'
          ? this.collabReplaceSprite(op.target, op.sprite, op.zip)
          : this.collabAddSprite(op.sprite, op.zip);
        return work.catch(error => {
          // One broken sprite must not block the rest of the update
          console.error(`Collab: failed to apply sprite ${op.sprite.name}`, error);
        });
      }), Promise.resolve())
        .then(() => {
          const reorder = plan.ops.find(op => op.op === 'reorder');
          if (reorder) this.collabApplyReorder(reorder.desiredOrder);
          // Monitors are applied last; their params may reference variables
          // and sprites created by the ops above
          this.collabApplyMonitorChanges(plan.monitorChanges);
          vm.emitTargetsUpdate(false /* no project change echo */);
          // Rebuilding the workspace clears and reloads the whole canvas, so
          // it is visible churn: do it only when the code view actually
          // changed (the editing target was replaced or deleted, or global
          // variables/broadcasts changed and must show up in the palette),
          // and defer it while the user is interacting with the workspace
          const editingTouched = plan.ops.some(op => op.hadEditingTarget === true);
          const editingChanged = vm.editingTarget !== editingTargetBefore;
          const stageVariablesChanged = plan.stageChanges.additions.length > 0 ||
            plan.stageChanges.deletions.length > 0;
          if (editingTouched || editingChanged || stageVariablesChanged) {
            this.collabRequestWorkspaceRefresh();
          }
          if (vm.editingTarget) vm.runtime.setEditingTarget(vm.editingTarget);
        });
    }

    // Apply monitor differences in place through the runtime's public monitor
    // API (add/update/remove). Never merges the serialized placeholder value
    // over the live one for updates; the monitored blocks keep updating it.
    collabApplyMonitorChanges (monitorChanges) {
      if (!monitorChanges) return;
      const runtime = this.props.vm.runtime;
      for (const id of monitorChanges.deletions) {
        runtime.requestRemoveMonitor(id);
      }
      for (const record of monitorChanges.updates) {
        const delta = {...record};
        delete delta.value;
        runtime.requestAddMonitor(delta);
      }
      for (const record of monitorChanges.additions) {
        runtime.requestAddMonitor(record);
      }
      // The runtime step loop emits MONITORS_UPDATE whenever the monitor
      // state flagged itself dirty. Flush immediately when the frame loop is
      // stopped (the collab/pause feature freezes it), so the monitors still
      // refresh in place; otherwise the next frame carries the update.
      const monitorState = runtime._monitorState;
      if (monitorState && monitorState.dirty && runtime.frameLoop &&
          runtime.frameLoop.running === false) {
        monitorState.dirty = false;
        runtime.emit(Runtime.MONITORS_UPDATE, monitorState.shallowClone());
      }
    }

    // Schedule an in-place rebuild of the script workspace (the editor's code
    // view) after remote changes landed in the VM. The rebuild clears and
    // reloads the canvas, so it is batched and postponed until the user is
    // done interacting (dragging blocks, editing a field); without this,
    // every peer edit would visibly flash the workspace mid-drag.
    collabRequestWorkspaceRefresh () {
      if (this._collabWorkspaceRefreshTimer) return;
      this._collabWorkspaceRefreshAttempts = 0;
      this._collabWorkspaceRefreshTimer = setTimeout(() => this.collabFlushWorkspaceRefresh(), 150);
    }

    collabFlushWorkspaceRefresh () {
      this._collabWorkspaceRefreshTimer = null;
      // Deduplicate refreshes that were queued right after one already ran
      if (Date.now() - (this._collabLastWorkspaceRefresh || 0) < 150) {
        this.collabRequestWorkspaceRefresh();
        return;
      }
      if (this.collabWorkspaceRefreshIsBusy() && this._collabWorkspaceRefreshAttempts < 20) {
        // The user is mid-gesture: retry shortly until they go idle, giving
        // up after ~5s so an update can never be stuck indefinitely
        this._collabWorkspaceRefreshAttempts++;
        this.collabRequestWorkspaceRefresh();
        return;
      }
      const vm = this.props.vm;
      this._collabLastWorkspaceRefresh = Date.now();
      if (vm) vm.emitWorkspaceUpdate();
    }

    collabWorkspaceRefreshIsBusy () {
      try {
        const workspace = AddonHooks.blocklyWorkspace;
        if (!workspace) return false;
        if (workspace.currentGesture_) return true;
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('blocklyHtmlInput')) return true;
      } catch (error) {
        // Anything failing here simply means "not busy"
      }
      return false;
    }

    // Merge position/pose-only changes onto the live target: no rebuild, so
    // running scripts and editor state are untouched.
    collabApplyRuntimeProps (target, sprite) {
      target.setXY(sprite.x, sprite.y);
      if (typeof sprite.direction === 'number') target.setDirection(sprite.direction);
      if (typeof sprite.size === 'number') target.setSize(sprite.size);
      target.setVisible(sprite.visible !== false);
      target.setDraggable(sprite.draggable === true);
      if (typeof sprite.volume === 'number') target.volume = sprite.volume;
      if (sprite.rotationStyle) target.rotationStyle = sprite.rotationStyle;
      if (typeof sprite.currentCostume === 'number' && target.sprite.costumes.length > 0) {
        target.currentCostume = Math.max(0, Math.min(
          sprite.currentCostume, target.sprite.costumes.length - 1));
      }
      target.updateAllDrawableProperties();
    }

    // Remove a sprite remotely deleted by a peer (same steps as
    // vm.deleteSprite, minus the undo export).
    collabDeleteSprite (target) {
      const vm = this.props.vm;
      if (!target || !target.isSprite || !target.isSprite()) return;
      const index = vm.runtime.targets.indexOf(target);
      const wasEditing = vm.editingTarget === target;
      target.deleteMonitors();
      for (const clone of target.sprite.clones.slice()) {
        vm.runtime.stopForTarget(clone);
        vm.runtime.disposeTarget(clone);
      }
      if (wasEditing) {
        const next = vm.runtime.targets[Math.min(index, vm.runtime.targets.length - 1)];
        if (next) {
          // Mirror vm.setEditingTarget WITHOUT its immediate
          // emitWorkspaceUpdate: the deferred refresh scheduled by
          // collabApplyPlan rebuilds the (possibly stale) workspace once
          vm.editingTarget = next;
          vm.emitTargetsUpdate(false);
          vm.runtime.setEditingTarget(next);
        }
      }
    }

    // Install a sprite a peer added. Unlike vm.addSprite, the user's current
    // editing target is not changed.
    collabAddSprite (spriteJson, zip) {
      const vm = this.props.vm;
      const savedOrigin = vm.runtime.origin;
      return sb3.deserialize(spriteJson, vm.runtime, zip, true)
        .then(({targets, extensions}) =>
          vm._loadExtensions(extensions.extensionIDs, extensions.extensionURLs).then(() => targets[0]))
        .then(newTarget => {
          vm.runtime.origin = savedOrigin;
          if (!newTarget) return;
          vm.runtime.targets.push(newTarget);
          vm.runtime.executableTargets = vm.runtime.targets.slice();
          newTarget.updateAllDrawableProperties();
          newTarget.fixUpVariableReferences();
        });
    }

    // Rebuild a sprite a peer edited, in place: the new target takes over the
    // old one's id (so monitors and cross-sprite references keep working), its
    // position in the sprite pane and its stacking order on the stage. Scripts
    // on all OTHER sprites keep running, and the editing target stays put.
    collabReplaceSprite (oldTarget, spriteJson, zip) {
      const vm = this.props.vm;
      const savedOrigin = vm.runtime.origin;
      return sb3.deserialize(spriteJson, vm.runtime, zip, true)
        .then(({targets, extensions}) =>
          vm._loadExtensions(extensions.extensionIDs, extensions.extensionURLs).then(() => targets[0]))
        .then(newTarget => {
          vm.runtime.origin = savedOrigin;
          if (!newTarget) return;
          const wasEditing = vm.editingTarget === oldTarget;
          const oldId = oldTarget.id;
          const oldIndex = vm.runtime.targets.indexOf(oldTarget);
          const oldDrawableOrder = oldTarget.drawableID !== null && vm.renderer
            ? vm.renderer.getDrawableOrder(oldTarget.drawableID)
            : null;
          // Tear down the old sprite: stop its scripts and clones, free its
          // drawable. disposeTarget also removes it from runtime.targets.
          for (const clone of oldTarget.sprite.clones.slice()) {
            vm.runtime.stopForTarget(clone);
            vm.runtime.disposeTarget(clone);
          }
          newTarget.id = oldId;
          vm.runtime.targets.splice(Math.min(oldIndex, vm.runtime.targets.length), 0, newTarget);
          vm.runtime.executableTargets = vm.runtime.targets.slice();
          newTarget.updateAllDrawableProperties();
          newTarget.fixUpVariableReferences();
          // The new drawable is created on top; restore the old stacking
          if (oldDrawableOrder !== null && newTarget.drawableID !== null && vm.renderer) {
            vm.renderer.setDrawableOrder(
              newTarget.drawableID, oldDrawableOrder, StageLayering.SPRITE_LAYER, false);
          }
          if (wasEditing) vm.editingTarget = newTarget;
        });
    }

    // Align the sprite pane order with the remote project (best effort).
    collabApplyReorder (desiredOrder) {
      const vm = this.props.vm;
      for (let i = 0; i < desiredOrder.length; i++) {
        const index = vm.runtime.targets.findIndex((target, idx) =>
          idx > 0 && target.isSprite && target.isSprite() && target.getName() === desiredOrder[i]);
        if (index === -1) return;
        if (index !== i + 1) vm.reorderTarget(index, i + 1);
      }
    }

    // Full project reload — kept for stage-level and global changes that the
    // incremental path cannot express (backdrops, stage code, extension
    // changes…). The cooldown afterwards swallows PROJECT_CHANGED events
    // that fire after deserialization, so the reloaded state doesn't echo
    // back out.
    collabFullLoad (project) {
      const vm = this.props.vm;
      const previousName = vm.editingTarget ? vm.editingTarget.getName() : null;
      this._collabLoadingProject = true;
      this._collabApplyingRemote = true;
      // The incoming remote state supersedes any broadcast still pending:
      // those local changes get re-broadcast once the cooldown ends
      if (this._collabSyncTimer) {
        this._collabMissedLocalChange = true;
        clearTimeout(this._collabSyncTimer);
        this._collabSyncTimer = null;
      }
      vm.loadProject(project).then(() => {
        this._collabApplyingRemote = false;
        // Keep the user on the sprite they were editing before the reload
        if (previousName) {
          const match = vm.runtime.targets.find(target =>
            target.getName && target.getName() === previousName);
          if (match && vm.editingTarget !== match) vm.setEditingTarget(match.id);
        }
        this._collabLoadCooldown = setTimeout(() => {
          this._collabLoadCooldown = null;
          this._collabLoadingProject = false;
          if (this._collabMissedLocalChange) {
            this._collabMissedLocalChange = false;
            this._collabBroadcastProject();
          }
          const pending = this._collabPendingProject;
          if (pending) {
            this._collabPendingProject = null;
            this.applyCollabProjectUpdate(pending);
          }
        }, 1200);
      }).catch(() => {
        this._collabApplyingRemote = false;
        this._collabLoadingProject = false;
      });
    }

    wrapVMWithPermissions () {
      const vm = this.props.vm;
      if (!vm) return;

      const collabState = this.state.collaborationState;
      const isParticipant = collabState && collabState.isCollaborating && collabState.role === 'participant';

      // Only wrap once
      if (!this._vmWrapped) {
        this._originalDeleteSprite = vm.deleteSprite.bind(vm);
        if (vm.extensionManager) {
          this._originalLoadExtensionURL = vm.extensionManager.loadExtensionURL
            ? vm.extensionManager.loadExtensionURL.bind(vm.extensionManager)
            : null;
        }
        this._vmWrapped = true;
      }

      const self = this;

      // Wrap deleteSprite
      vm.deleteSprite = function (...args) {
        if (isParticipant) {
          const perms = collabState.permissions || {};
          if (perms.allowDeleteSprite === false) {
            alert('无权限执行此操作');
            return;
          }
        }
        return self._originalDeleteSprite(...args);
      };

      // Wrap extensionManager.loadExtensionURL
      if (vm.extensionManager && this._originalLoadExtensionURL) {
        vm.extensionManager.loadExtensionURL = function (...args) {
          if (isParticipant) {
            const perms = collabState.permissions || {};
            if (perms.allowAddExtension === false) {
              alert('无权限执行此操作');
              return Promise.reject(new Error('Permission denied: add extension'));
            }
          }
          return self._originalLoadExtensionURL(...args);
        };
      }
    }

    handleUpdateProjectTitle (newTitle) {
      this.setState({
        title: newTitle
      });
    }
    async handleClickEncryptedSave () {
      const result = await showEncryptedSaveDialog(this.state.title);
      if (!result) return;

      try {
        const sb3Data = await this.props.vm.saveProjectSb3('arraybuffer');
        const saveResult = await EditorPreload.showEncryptedSaveFilePicker(result.title);
        if (!saveResult) return;

        await EditorPreload.encryptAndSave(saveResult.id, sb3Data, result.password);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.error('Encrypted save failed:', e);
      }
    }
    async handleSaveAsViewsb3 () {
      try {
        const sb3Data = await this.props.vm.saveProjectSb3('arraybuffer');
        const title = this.state.title || 'project';
        const saveResult = await EditorPreload.showViewsb3SaveFilePicker(title);
        if (!saveResult) return;

        await EditorPreload.encryptAndSaveViewsb3(saveResult.id, sb3Data);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.error('View-only save failed:', e);
      }
    }
    applyCodeAreaBackground (backgroundImage) {
        this._codeAreaBackgroundImage = backgroundImage;

        // Clear pending timeouts
        if (this._codeAreaBackgroundTimeouts) {
            this._codeAreaBackgroundTimeouts.forEach(id => clearTimeout(id));
        }
        this._codeAreaBackgroundTimeouts = [];

        // Clear existing observer
        if (this._codeAreaBackgroundObserver) {
            this._codeAreaBackgroundObserver.disconnect();
            this._codeAreaBackgroundObserver = null;
        }

        this._isApplyingCodeBackground = false;

        const applyBackground = () => {
            this._isApplyingCodeBackground = true;

            const injectionDiv = document.querySelector('.injectionDiv');
            if (injectionDiv) {
                if (this._codeAreaBackgroundImage) {
                    injectionDiv.style.backgroundImage = `url(${this._codeAreaBackgroundImage})`;
                    injectionDiv.style.backgroundSize = 'cover';
                    injectionDiv.style.backgroundPosition = 'center';
                    injectionDiv.style.backgroundRepeat = 'no-repeat';
                    injectionDiv.style.backgroundColor = 'transparent';
                    injectionDiv.setAttribute('data-custom-background', 'true');
                } else {
                    injectionDiv.style.backgroundImage = '';
                    injectionDiv.style.backgroundSize = '';
                    injectionDiv.style.backgroundPosition = '';
                    injectionDiv.style.backgroundRepeat = '';
                    injectionDiv.style.backgroundColor = '';
                    injectionDiv.removeAttribute('data-custom-background');
                }
            }
            const blocklySvg = injectionDiv ? injectionDiv.querySelector('.blocklySvg') : document.querySelector('.blocklySvg');
            if (blocklySvg) {
                if (this._codeAreaBackgroundImage) {
                    blocklySvg.style.backgroundColor = 'transparent';
                } else {
                    blocklySvg.style.backgroundColor = '';
                }
            }

            // Reset flag after current frame so observer can catch future external changes
            requestAnimationFrame(() => {
                this._isApplyingCodeBackground = false;
            });
        };

        applyBackground();

        // Use MutationObserver to immediately restore background when overridden by Blockly/React
        if (backgroundImage) {
            const setupObserver = () => {
                const injectionDiv = document.querySelector('.injectionDiv');
                if (!injectionDiv) return false;

                this._codeAreaBackgroundObserver = new MutationObserver(() => {
                    if (this._isApplyingCodeBackground) return;
                    if (!this._codeAreaBackgroundImage) return;

                    const div = document.querySelector('.injectionDiv');
                    if (div && div.getAttribute('data-custom-background') !== 'true') {
                        applyBackground();
                    }
                });

                this._codeAreaBackgroundObserver.observe(injectionDiv, {
                    attributes: true,
                    subtree: true,
                    attributeFilter: ['style']
                });
                return true;
            };

            // Try to set up observer immediately; if element doesn't exist yet, retry once
            if (!setupObserver()) {
                const retryId = setTimeout(() => {
                    if (!this._codeAreaBackgroundObserver) {
                        setupObserver();
                    }
                }, 500);
                this._codeAreaBackgroundTimeouts.push(retryId);
            }
        }
    }
    applyStageAreaBackground (backgroundImage) {
        this._stageAreaBackgroundImage = backgroundImage;

        // Clear pending timeouts
        if (this._stageAreaBackgroundTimeouts) {
            this._stageAreaBackgroundTimeouts.forEach(id => clearTimeout(id));
        }
        this._stageAreaBackgroundTimeouts = [];

        // Clear existing observer
        if (this._stageAreaBackgroundObserver) {
            this._stageAreaBackgroundObserver.disconnect();
            this._stageAreaBackgroundObserver = null;
        }

        this._isApplyingStageBackground = false;

        const applyBackground = () => {
            this._isApplyingStageBackground = true;

            const stageArea = document.querySelector('[class*="stage-and-target-wrapper"]');
            if (stageArea) {
                if (this._stageAreaBackgroundImage) {
                    stageArea.style.backgroundImage = `url(${this._stageAreaBackgroundImage})`;
                    stageArea.style.backgroundSize = 'cover';
                    stageArea.style.backgroundPosition = 'center';
                    stageArea.style.backgroundRepeat = 'no-repeat';
                    stageArea.setAttribute('data-custom-background', 'true');
                } else {
                    stageArea.style.backgroundImage = '';
                    stageArea.style.backgroundSize = '';
                    stageArea.style.backgroundPosition = '';
                    stageArea.style.backgroundRepeat = '';
                    stageArea.removeAttribute('data-custom-background');
                }
            }

            requestAnimationFrame(() => {
                this._isApplyingStageBackground = false;
            });
        };

        applyBackground();

        // Use MutationObserver to immediately restore background when overridden
        if (backgroundImage) {
            const setupObserver = () => {
                const stageArea = document.querySelector('[class*="stage-and-target-wrapper"]');
                if (!stageArea) return false;

                this._stageAreaBackgroundObserver = new MutationObserver(() => {
                    if (this._isApplyingStageBackground) return;
                    if (!this._stageAreaBackgroundImage) return;

                    const area = document.querySelector('[class*="stage-and-target-wrapper"]');
                    if (area && area.getAttribute('data-custom-background') !== 'true') {
                        applyBackground();
                    }
                });

                this._stageAreaBackgroundObserver.observe(stageArea, {
                    attributes: true,
                    attributeFilter: ['style']
                });
                return true;
            };

            if (!setupObserver()) {
                const retryId = setTimeout(() => {
                    if (!this._stageAreaBackgroundObserver) {
                        setupObserver();
                    }
                }, 500);
                this._stageAreaBackgroundTimeouts.push(retryId);
            }
        }
    }
    render() {
      const {
        locale,
        loadingState,
        projectChanged,
        fileHandle,
        reduxUsername,
        onFetchedInitialProjectData,
        onHasInitialProject,
        onLoadedProject,
        onLoadingCompleted,
        onLoadingStarted,
        onRequestNewProject,
        onSetFileHandle,
        onSetReduxUsername,
        onShowErrorModal,
        vm,
        ...props
      } = this.props;
      return (
        <WrappedComponent
          projectTitle={this.state.title}
          onUpdateProjectTitle={this.handleUpdateProjectTitle}
          onClickAddonSettings={handleClickAddonSettings}
          onClickNewWindow={handleClickNewWindow}
          onClickPackager={handleClickPackager}
          onClickEncryptedSave={this.handleClickEncryptedSave}
          onViewsb3Save={this.handleSaveAsViewsb3}
          onClickAbout={[
            {
              title: this.messages['in-app-about.desktop-settings'],
              onClick: handleClickDesktopSettings
            },
            {
              title: this.messages['in-app-about.privacy'],
              onClick: handleClickPrivacy
            },
            {
              title: this.messages['in-app-about.about'],
              onClick: handleClickAbout
            },
            {
              title: this.messages['in-app-about.contact-us'] || 'Contact Us',
              onClick: handleClickContact
            },
            {
              title: this.messages['in-app-about.source-code'],
              onClick: handleClickSourceCode
            },
            {
              title: this.messages['in-app-about.feedback'] || 'NeoWarp Feedback',
              onClick: handleClickFeedback
            },
          ]}
          onClickDesktopSettings={handleClickDesktopSettings}
          onClickAI={handleClickAI}
          onClickTodoList={handleClickTodoList}
          onClickProjectAnalysis={handleClickProjectAnalysis}
          onClickMobilePreview={handleClickMobilePreview}
          onClickDetachStage={isStageDetached ? handleReattachStage : () => handleDetachStage(this.props.vm)}
          onClickCollaborationHost={handleClickCollaborationHost}
          onClickCollaborationJoin={handleClickCollaborationJoin}
          onClickCollaborationChat={handleClickCollaborationChat}
          onClickEndCollaboration={handleClickEndCollaboration}
          onClickLeaveCollaboration={handleClickLeaveCollaboration}
          collaborationState={this.state.collaborationState}
          securityManager={securityManager}
          // NeoWarp: 标签栏「源代码Beta」标签页显隐 + 内嵌 DSL 面板
          showSourceCodeButton={this.state.showSourceCodeButton}
          sourceCodePanel={<SourceCodePanel vm={this.props.vm} />}
          {...props}
        />
      );
    }
  }

  DesktopComponent.propTypes = {
    locale: PropTypes.string.isRequired,
    loadingState: PropTypes.string.isRequired,
    projectChanged: PropTypes.bool.isRequired,
    fileHandle: PropTypes.shape({
      id: PropTypes.string.isRequired
    }),
    isFullScreen: PropTypes.bool.isRequired,
    isViewOnly: PropTypes.bool.isRequired,
    reduxUsername: PropTypes.string.isRequired,
    onFetchedInitialProjectData: PropTypes.func.isRequired,
    onHasInitialProject: PropTypes.func.isRequired,
    onLoadedProject: PropTypes.func.isRequired,
    onLoadingCompleted: PropTypes.func.isRequired,
    onLoadingStarted: PropTypes.func.isRequired,
    onRequestNewProject: PropTypes.func.isRequired,
    onSetFileHandle: PropTypes.func.isRequired,
    onSetReduxUsername: PropTypes.func.isRequired,
    onSetViewOnly: PropTypes.func.isRequired,
    onSetFullScreen: PropTypes.func.isRequired,
    onShowErrorModal: PropTypes.func.isRequired,
    onViewsb3Save: PropTypes.func,
    vm: PropTypes.shape({
      loadProject: PropTypes.func.isRequired
    }).isRequired
  };

  const mapStateToProps = state => ({
    locale: state.locales.locale,
    loadingState: state.scratchGui.projectState.loadingState,
    isFullScreen: state.scratchGui.mode.isFullScreen,
    isViewOnly: state.scratchGui.mode.isViewOnly,
    projectChanged: state.scratchGui.projectChanged,
    fileHandle: state.scratchGui.tw.fileHandle,
    reduxUsername: state.scratchGui.tw.username,
    guiTheme: state.scratchGui.theme.theme,
    vm: state.scratchGui.vm
  });

  const mapDispatchToProps = dispatch => ({
    onLoadingStarted: () => dispatch(openLoadingProject()),
    onLoadingCompleted: () => dispatch(closeLoadingProject()),
    onHasInitialProject: (hasInitialProject, loadingState) => {
      if (hasInitialProject) {
        return dispatch(requestProjectUpload(loadingState));
      }
      return dispatch(setProjectId(defaultProjectId));
    },
    onFetchedInitialProjectData: (projectData, loadingState) => dispatch(onFetchedProjectData(projectData, loadingState)),
    onLoadedProject: (loadingState, loadSuccess) => {
      return dispatch(onLoadedProject(loadingState, /* canSave */ false, loadSuccess));
    },
    onRequestNewProject: () => dispatch(requestNewProject(false)),
    onSetFileHandle: fileHandle => dispatch(setFileHandle(fileHandle)),
    onSetReduxUsername: username => dispatch(setUsername(username)),
    onSetViewOnly: isViewOnly => dispatch(setViewOnly(isViewOnly)),
    onSetFullScreen: isFullScreen => dispatch(setFullScreen(isFullScreen)),
    onSetGuiTheme: theme => dispatch(setTheme(theme)),
    onShowErrorModal: error => {
      dispatch(setProjectError(error));
      dispatch(openInvalidProjectModal());
    }
  });

  return connect(
    mapStateToProps,
    mapDispatchToProps
  )(DesktopComponent);
};

// NeoWarp: SourceCodePanel 定义在 DesktopHOC 之后（模块级），因为
// scripts/test-dsl-roundtrip.js 会把「const DesktopHOC = function」之前的代码
// 当纯 JS 提取求值，JSX 出现在其前会让测试无法运行。
class SourceCodePanel extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      text: '',
      loadedText: '',
      targetName: '',
      scriptCount: 0,
      status: null // {type: 'ok'|'error', msg}
    };
    // 当前面板文本对应的目标 id（切换角色检测用）
    this._displayedTargetId = null;
    // 各目标未应用的编辑暂存（切换角色时保存，切回时恢复，避免丢失或误应用）
    this._pendingTexts = new Map();
    this.gutterRef = React.createRef();
    this.handleTextChange = this.handleTextChange.bind(this);
    this.handleTextScroll = this.handleTextScroll.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleApply = this.handleApply.bind(this);
    this.handleCopy = this.handleCopy.bind(this);
    this.reloadFromTarget = this.reloadFromTarget.bind(this);
    this.handleTargetSwitch = this.handleTargetSwitch.bind(this);
  }
  componentDidMount () {
    this.reloadFromTarget();
    // 防抖同步。触发源有三类：runtime 的 PROJECT_CHANGED / TARGETS_UPDATE
    // （积木变化等），以及 VM 自身的 'targetsUpdate'——切换角色时
    // vm.setEditingTarget 只会发后一个，前两个都不会触发。触发时再根据
    // editingTarget 是否变化决定是跟随切换还是普通同步
    this._onSyncNeeded = () => {
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        const target = this.props.vm.editingTarget;
        const editingId = target ? target.id : null;
        if (editingId !== this._displayedTargetId) {
          this.handleTargetSwitch();
        } else if (this.state.text === this.state.loadedText) {
          // 用户有未应用的编辑时不覆盖文本
          this.reloadFromTarget();
        }
      }, SOURCE_CODE_REFRESH_DELAY);
    };
    this.props.vm.runtime.on('PROJECT_CHANGED', this._onSyncNeeded);
    this.props.vm.runtime.on('TARGETS_UPDATE', this._onSyncNeeded);
    this.props.vm.on('targetsUpdate', this._onSyncNeeded);
  }
  componentWillUnmount () {
    this.props.vm.runtime.removeListener('PROJECT_CHANGED', this._onSyncNeeded);
    this.props.vm.runtime.removeListener('TARGETS_UPDATE', this._onSyncNeeded);
    this.props.vm.removeListener('targetsUpdate', this._onSyncNeeded);
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
  }
  reloadFromTarget () {
    const target = this.props.vm.editingTarget;
    this._displayedTargetId = target ? target.id : null;
    if (!target) {
      this.setState({ text: '', loadedText: '', targetName: '', scriptCount: 0, status: null });
      return;
    }
    const scripts = collectTargetDsl(target);
    const text = scripts.map(script => script.dsl).join('\n\n');
    this.setState({
      text,
      loadedText: text,
      targetName: target.getName(),
      scriptCount: scripts.length,
      status: null
    });
  }
  handleTargetSwitch () {
    const prevId = this._displayedTargetId;
    if (prevId) {
      if (this.state.text !== this.state.loadedText) {
        this._pendingTexts.set(prevId, {
          text: this.state.text,
          loadedText: this.state.loadedText,
          scriptCount: this.state.scriptCount
        });
      } else {
        this._pendingTexts.delete(prevId);
      }
    }
    const target = this.props.vm.editingTarget;
    const pending = target ? this._pendingTexts.get(target.id) : null;
    if (pending) {
      // 切回之前编辑过未应用的角色：恢复暂存的编辑
      this._pendingTexts.delete(target.id);
      this._displayedTargetId = target.id;
      this.setState({
        text: pending.text,
        loadedText: pending.loadedText,
        scriptCount: pending.scriptCount,
        targetName: target.getName(),
        status: null
      });
    } else {
      this.reloadFromTarget();
    }
  }
  handleTextChange (e) {
    this.setState({ text: e.target.value });
  }
  handleTextScroll (e) {
    if (this.gutterRef.current) {
      this.gutterRef.current.scrollTop = e.target.scrollTop;
    }
  }
  handleKeyDown (e) {
    // Tab 插入两个空格，保持 DSL 缩进编辑顺手
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.target;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = this.state.text.substring(0, start) + '  ' + this.state.text.substring(end);
      this.setState({ text: next }, () => {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 2;
      });
    }
  }
  handleApply () {
    const target = this.props.vm.editingTarget;
    if (!target) return;
    const outcome = applyDslTextToTarget(this.props.vm, target, this.state.text);
    if (outcome.success) {
      // 应用成功：把当前文本标记为已同步（不再自动回读覆盖，保留注释等
      // 用户格式），后续积木变化仍会触发自动同步
      let msg = '已应用：' + outcome.scripts + ' 个脚本 · ' + outcome.blocks + ' 个积木';
      if (outcome.warnings && outcome.warnings.length > 0) {
        msg += ' · ' + outcome.warnings.length + ' 条警告';
      }
      const nextStatus = {
        type: 'ok',
        msg: msg,
        detail: outcome.warnings ? outcome.warnings.join('\n') : undefined
      };
      this.setState(prevState => ({
        loadedText: prevState.text,
        scriptCount: outcome.scripts,
        status: nextStatus
      }));
    } else {
      this.setState({ status: { type: 'error', msg: outcome.error } });
    }
  }
  handleCopy () {
    const text = this.state.text;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this.fallbackCopy(text));
    } else {
      this.fallbackCopy(text);
    }
  }
  fallbackCopy (text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(textarea);
  }
  render () {
    const {text, targetName, scriptCount, status} = this.state;
    const dirty = text !== this.state.loadedText;
    const lineCount = text.length === 0 ? 1 : text.split('\n').length;
    const lineNumbers = [];
    for (let i = 1; i <= lineCount; i++) lineNumbers.push(i);
    return (
      <div className="neo-source-panel">
        <div className="neo-source-toolbar">
          <span className="neo-source-title-text">
            源代码 <span className="neo-source-beta">Beta</span>
          </span>
          {targetName ? (
            <span className="neo-source-target">
              {`${targetName} · ${scriptCount} 个脚本${dirty ? ' · 未应用' : ''}`}
            </span>
          ) : null}
          <span className="neo-source-toolbar-actions">
            <button
              className="neo-source-btn"
              onClick={this.reloadFromTarget}
              title="丢弃编辑，重新从积木生成"
            >
              重新载入
            </button>
            <button
              className="neo-source-btn"
              onClick={this.handleCopy}
              disabled={!text}
            >
              复制
            </button>
            <button
              className="neo-source-btn neo-source-apply"
              onClick={this.handleApply}
              title="用文本内容替换当前目标（角色/舞台）的全部脚本"
            >
              应用到积木
            </button>
          </span>
        </div>
        {status ? (
          <div
            className={'neo-source-status neo-source-status-' + status.type}
            title={status.detail || undefined}
          >
            {status.msg}
          </div>
        ) : null}
        <div className="neo-source-editor">
          <div
            className="neo-source-gutter"
            ref={this.gutterRef}
          >
            {lineNumbers.map(n => (
              <div
                key={n}
                className="neo-source-line-no"
              >
                {n}
              </div>
            ))}
          </div>
          <textarea
            className="neo-source-textarea"
            value={text}
            onChange={this.handleTextChange}
            onScroll={this.handleTextScroll}
            onKeyDown={this.handleKeyDown}
            spellCheck={false}
            wrap="off"
            placeholder={'此处显示当前角色/舞台的 DSL 代码：每行一条积木，2 空格缩进表示嵌套，空行分隔多个脚本。\n编辑后点击「应用到积木」生效。'}
          />
        </div>
        <div className="neo-source-footer">
          DSL 语法与 AI 助手一致 · 空行分隔多个脚本 · 应用后替换当前目标的全部脚本
        </div>
      </div>
    );
  }
}
SourceCodePanel.propTypes = {
  vm: PropTypes.shape({
    on: PropTypes.func.isRequired,
    removeListener: PropTypes.func.isRequired,
    runtime: PropTypes.shape({
      on: PropTypes.func.isRequired,
      removeListener: PropTypes.func.isRequired
    }).isRequired,
    editingTarget: PropTypes.shape({
      id: PropTypes.string
    })
  }).isRequired
};

export default DesktopHOC;
