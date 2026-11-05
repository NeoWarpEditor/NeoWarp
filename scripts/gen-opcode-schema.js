/**
 * 从 scratch-blocks / scratch-vm 生成 OPCODE_SCHEMA。
 *
 * DSL 是位置式的：一行 `data_addtolist "x" @list` 里的 token 按下标落到 schema
 * 声明的槽位上。所以槽位的顺序、名称、以及"字段还是输入"必须与 scratch-blocks
 * 的 args0 完全一致，否则值会被写进相邻参数，且没有任何报错。
 *
 * 手写这张表容易随上游变动而失配，故改为生成：
 *   node scripts/gen-opcode-schema.js          # 打印，供人工核对
 *   node scripts/gen-opcode-schema.js --check  # 与源码里的表比对，不一致则非零退出
 *
 * 数据来源：
 *   - 参数顺序/名称/类型：node_modules/scratch-blocks/blocks_vertical/*.js 的 args0
 *   - 影子块类型：同目录的 toolbox XML 片段 + scratch-gui 的 make-toolbox-xml.js
 *     + core/data_category.js（变量/列表分类是动态生成的，XML 里查不到）
 *   - 画笔扩展：scratch-vm/src/extensions/scratch3_pen
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BLOCKS_DIR = path.join(ROOT, 'node_modules/scratch-blocks/blocks_vertical');
const GUI_TOOLBOX = path.join(ROOT, 'node_modules/scratch-gui/src/lib/make-toolbox-xml.js');
const TARGET_FILE = path.join(ROOT, 'src-renderer-webpack/editor/gui/desktop-hoc.jsx');

/** 原始值影子块 -> 它承载值的字段名。这类影子只存字面量，不是菜单。 */
const PRIMITIVE_SHADOWS = {
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

const FIELD_TYPES = new Set([
  'field_dropdown', 'field_variable', 'field_variable_getter', 'field_colour_slider',
  'field_note', 'field_angle', 'field_number', 'field_matrix', 'field_numberdropdown',
  'field_input_removable', 'field_label_serializable'
]);

/** 纯菜单块本身不该进 DSL（它们只作为别人的影子出现） */
const MENU_ONLY = new Set([
  'motion_goto_menu', 'motion_glideto_menu', 'motion_pointtowards_menu',
  'looks_costume', 'looks_backdrops', 'sound_sounds_menu', 'event_broadcast_menu',
  'sensing_touchingobjectmenu', 'sensing_distancetomenu', 'sensing_keyoptions',
  'sensing_of_object_menu', 'control_create_clone_of_menu', 'data_variable',
  'data_listcontents'
]);

/** 过时/内部/尚未支持的块 */
const SKIP = /^(extension_|argument_editor_|procedures_|motion_align_scene|motion_scroll|motion_[xy]scroll|data_listindex|looks_hideallsprites|sensing_loud$|sensing_online|sensing_userid|event_whentouchingobject|event_touchingobjectmenu)/;

/** 无参数块：scratch-blocks 里用 appendField 而非 args0，正则扫不到 */
const ZERO_ARG = [
  'control_clear_counter', 'control_delete_this_clone', 'control_get_counter',
  'control_incr_counter', 'control_start_as_clone', 'event_whenflagclicked',
  'event_whenstageclicked', 'event_whenthisspriteclicked', 'looks_cleargraphiceffects',
  'looks_hide', 'looks_nextbackdrop', 'looks_nextcostume', 'looks_show', 'looks_size',
  'motion_direction', 'motion_ifonedgebounce', 'motion_xposition', 'motion_yposition',
  'sensing_answer', 'sensing_dayssince2000', 'sensing_loudness', 'sensing_mousedown',
  'sensing_mousex', 'sensing_mousey', 'sensing_resettimer', 'sensing_timer',
  'sensing_username', 'sound_cleareffects', 'sound_stopallsounds', 'sound_volume',
  'pen_clear', 'pen_stamp', 'pen_penDown', 'pen_penUp'
];

/**
 * 无法从 args0 正则得到的条目。
 * control_stop 用 appendField 挂下拉（substack 可选：单独 "all" 合法 → optionalBody）；
 * argument_reporter_* 用 init 里的 appendDummyInput 声明字段，args0 扫不出来；
 * control_all_at_once 的 substack 在 args1；
 * 画笔扩展的块由 scratch-vm 在运行时注册，没有 blocks_vertical 定义。
 */
const MANUAL = {
  control_stop: { args: [{ name: 'STOP_OPTION', kind: 'field' }], substack: true, optionalBody: true },
  argument_reporter_boolean: { args: [{ name: 'VALUE', kind: 'field' }] },
  argument_reporter_string_number: { args: [{ name: 'VALUE', kind: 'field' }] },
  control_all_at_once: { args: [], substack: true },
  looks_switchbackdroptoandwait: {
    args: [{ name: 'BACKDROP', kind: 'menu', shadow: 'looks_backdrops', menuField: 'BACKDROP' }]
  },
  pen_setPenColorToColor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }] },
  pen_changePenColorParamBy: {
    args: [
      { name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' },
      { name: 'VALUE', kind: 'input', shadow: 'math_number' }
    ]
  },
  pen_setPenColorParamTo: {
    args: [
      { name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' },
      { name: 'VALUE', kind: 'input', shadow: 'math_number' }
    ]
  },
  pen_changePenSizeBy: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  pen_setPenSizeTo: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] }
};

/**
 * 变量/列表/说话类块的默认影子取自 core/data_category.js 的 addBlock 调用与
 * scratch-blocks 的官方默认值——这些分类的 toolbox 是运行时拼的，XML 里没有。
 */
const DYNAMIC_SHADOWS = {
  data_setvariableto: { VALUE: 'text' },
  data_changevariableby: { VALUE: 'math_number' },
  data_addtolist: { ITEM: 'text' },
  data_deleteoflist: { INDEX: 'math_integer' },
  data_insertatlist: { INDEX: 'math_integer', ITEM: 'text' },
  data_replaceitemoflist: { INDEX: 'math_integer', ITEM: 'text' },
  data_itemoflist: { INDEX: 'math_integer' },
  data_itemnumoflist: { ITEM: 'text' },
  data_listcontainsitem: { ITEM: 'text' },
  looks_say: { MESSAGE: 'text' },
  looks_sayforsecs: { MESSAGE: 'text', SECS: 'math_number' },
  looks_think: { MESSAGE: 'text' },
  looks_thinkforsecs: { MESSAGE: 'text', SECS: 'math_number' },
  sensing_askandwait: { QUESTION: 'text' },
  control_for_each: { VALUE: 'math_whole_number' },
  looks_changestretchby: { CHANGE: 'math_number' },
  looks_setstretchto: { STRETCH: 'math_number' }
};

function readBlocksSources () {
  return fs.readdirSync(BLOCKS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(BLOCKS_DIR, f), 'utf8'));
}

/** 解析 args0：{opcode: [{type, name, bool}]} */
function parseArgSpecs (sources) {
  const spec = {};
  const blockRe = /Blockly\.Blocks\['([a-zA-Z0-9_]+)'\]\s*=\s*\{([\s\S]*?)\n\};/g;
  const argRe = /\{[^{}]*?["']type["']:\s*["']([a-z_]+)["'][^{}]*?["']name["']:\s*["']([A-Z_0-9]+)["']([^{}]*?)\}/g;
  for (const src of sources) {
    let block;
    while ((block = blockRe.exec(src)) !== null) {
      const [, opcode, body] = block;
      const args = [];
      let arg;
      argRe.lastIndex = 0;
      while ((arg = argRe.exec(body)) !== null) {
        args.push({
          type: arg[1],
          name: arg[2],
          bool: /["']check["']:\s*["']Boolean["']/.test(arg[3])
        });
      }
      if (args.length) spec[opcode] = args;
    }
  }
  return spec;
}

/** 从 toolbox XML 片段里抓 <value name=X><shadow type=Y> 配对 */
function parseShadows (text, joined) {
  const map = {};
  const chunks = text.split(joined ? /'<block type="/ : /<block type="/).slice(1);
  const valueRe = joined
    ? /<value name="([A-Z_0-9]+)">'\s*\+\s*'<shadow(?: id="[^"]*")? type="([a-zA-Z_0-9]+)"/g
    : /<value name="([A-Z_0-9]+)">\s*<shadow(?: id="[^"]*")? type="([a-zA-Z_0-9]+)"/g;
  for (const chunk of chunks) {
    const opcode = chunk.slice(0, chunk.indexOf('"'));
    let m;
    valueRe.lastIndex = 0;
    while ((m = valueRe.exec(chunk)) !== null) {
      if (!map[opcode]) map[opcode] = {};
      if (!map[opcode][m[1]]) map[opcode][m[1]] = m[2];
    }
  }
  return map;
}

function build () {
  const sources = readBlocksSources();
  const spec = parseArgSpecs(sources);
  const toolboxShadows = parseShadows(sources.join('\n'), true);
  const guiShadows = fs.existsSync(GUI_TOOLBOX)
    ? parseShadows(fs.readFileSync(GUI_TOOLBOX, 'utf8'), false)
    : {};

  const shadowOf = (opcode, argName) =>
    (toolboxShadows[opcode] || {})[argName] ||
    (guiShadows[opcode] || {})[argName] ||
    (DYNAMIC_SHADOWS[opcode] || {})[argName] ||
    null;

  const opcodes = new Set([...Object.keys(spec), ...ZERO_ARG, ...Object.keys(MANUAL)]);
  const entries = [];

  for (const opcode of [...opcodes].sort()) {
    if (SKIP.test(opcode) || MENU_ONLY.has(opcode)) continue;

    if (MANUAL[opcode]) {
      entries.push({ opcode, ...MANUAL[opcode] });
      continue;
    }

    const args = [];
    let substack = false;
    let substack2 = false;
    for (const arg of spec[opcode] || []) {
      if (arg.type === 'input_statement') {
        if (arg.name === 'SUBSTACK2') substack2 = true;
        else substack = true;
        continue;
      }
      if (FIELD_TYPES.has(arg.type)) {
        args.push({ name: arg.name, kind: 'field' });
        continue;
      }
      const shadow = shadowOf(opcode, arg.name);
      if (shadow && !PRIMITIVE_SHADOWS[shadow]) {
        // 菜单影子：外观是下拉，实际是可插 reporter 的输入槽
        const menuSpec = spec[shadow];
        args.push({
          name: arg.name,
          kind: 'menu',
          shadow,
          menuField: menuSpec && menuSpec[0] ? menuSpec[0].name : arg.name
        });
      } else if (arg.bool) {
        args.push({ name: arg.name, kind: 'input', bool: true });
      } else {
        const entry = { name: arg.name, kind: 'input' };
        if (shadow) entry.shadow = shadow;
        args.push(entry);
      }
    }
    entries.push({ opcode, args, substack, substack2 });
  }
  return entries;
}

function render (entries) {
  return entries.map(e => {
    const args = e.args.map(a => {
      const bits = [`name: '${a.name}'`, `kind: '${a.kind}'`];
      if (a.shadow) bits.push(`shadow: '${a.shadow}'`);
      if (a.menuField) bits.push(`menuField: '${a.menuField}'`);
      if (a.bool) bits.push('bool: true');
      return `{ ${bits.join(', ')} }`;
    }).join(', ');
    let line = `  ${e.opcode}: { args: [${args}]`;
    if (e.substack) line += ', substack: true';
    if (e.substack2) line += ', substack2: true';
    if (e.optionalBody) line += ', optionalBody: true';
    return line + ' },';
  }).join('\n');
}

const rendered = render(build());

if (process.argv.includes('--check')) {
  const src = fs.readFileSync(TARGET_FILE, 'utf8');
  const start = src.indexOf('const OPCODE_SCHEMA = {');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) {
    console.error('OPCODE_SCHEMA not found in ' + TARGET_FILE);
    process.exit(2);
  }
  // 工作区文件可能是 CRLF（Windows 编辑器），生成物永远是 LF：比对前归一化换行
  const current = src.slice(src.indexOf('\n', start) + 1, end).replace(/\s+$/, '').replace(/\r\n/g, '\n');
  if (current === rendered) {
    console.log('OPCODE_SCHEMA is up to date (' + rendered.split('\n').length + ' opcodes)');
  } else {
    console.error('OPCODE_SCHEMA is stale. Regenerate with: node scripts/gen-opcode-schema.js');
    const a = current.split('\n');
    const b = rendered.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error('  first difference at line ' + (i + 1));
        console.error('    in source:  ' + (a[i] || '(missing)'));
        console.error('    generated:  ' + (b[i] || '(missing)'));
        break;
      }
    }
    process.exit(1);
  }
} else {
  console.log(rendered);
}
