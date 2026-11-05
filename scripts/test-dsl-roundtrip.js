/**
 * DSL round-trip and insertion tests.
 *
 * Loads the real helper functions out of desktop-hoc.jsx (they are top-level, so they can be
 * evaluated in isolation) and drives them against scratch-vm's actual Blocks container. This
 * catches the failure mode that motivated the work: a script that "applies successfully" but
 * lands values in the wrong slots, which only shows up when you read the blocks back.
 *
 *   node scripts/test-dsl-roundtrip.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOC = path.join(ROOT, 'src-renderer-webpack/editor/gui/desktop-hoc.jsx');

const VirtualMachine = require(path.join(ROOT, 'node_modules/scratch-vm/src/virtual-machine.js'));
const Sprite = require(path.join(ROOT, 'node_modules/scratch-vm/src/sprites/sprite.js'));
const RenderedTarget = require(path.join(ROOT, 'node_modules/scratch-vm/src/sprites/rendered-target.js'));

/** Pull the standalone helper functions (everything before the React component) out of the JSX. */
function loadHelpers () {
  const src = fs.readFileSync(HOC, 'utf8');
  const cut = src.indexOf('const DesktopHOC = function');
  if (cut < 0) throw new Error('DesktopHOC marker not found');
  const head = src.slice(0, cut);

  const names = [
    'OPCODE_SCHEMA', 'SHADOW_VALUE_FIELD', 'tokenizeArgs', 'argToInputValue',
    'mapArgsToDescriptor', 'parseDslLine', 'convertNode', 'resolveVariableField',
    'resolveBroadcastField', 'schemaArgFor', 'toHexColor', 'createInputShadow',
    'buildBlockStructure', 'buildSubstackChain', 'buildScriptBlocks',
    'spliceBlocksIntoScript', 'validateParsedScript', 'formatValidationError',
    'serializeBlockToDsl', 'convertBlockObjToDsl', 'parseScratchDSL',
    'collectTargetDsl', 'parseDefineLine', 'resolveBlockSchema', 'collectProcRegistry',
    'applyDslTextToTarget'
  ];

  // The head contains imports and React-only code; keep just what we need by evaluating the
  // whole thing with a stub module system and returning the named helpers.
  const stripped = head
    .replace(/^import[\s\S]*?;$/gm, '')
    .replace(/^const \{[\s\S]*?\} = require\([^)]*\);$/gm, '')
    .replace(/^const [A-Za-z_$][\w$]* = require\([^)]*\);$/gm, '');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'require', 'module', 'exports',
    stripped + '\nreturn {' + names.map(n => n + ': typeof ' + n + " !== 'undefined' ? " + n + ' : undefined').join(', ') + '};'
  );
  return factory(require, { exports: {} }, {});
}

const H = loadHelpers();

let passed = 0;
let failed = 0;
const failures = [];

function check (name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name + (detail ? '\n      ' + detail : ''));
  }
}

function makeTarget () {
  const vm = new VirtualMachine();
  const sprite = new Sprite(null, vm.runtime);
  sprite.name = 'Cat';
  const target = new RenderedTarget(sprite, vm.runtime);
  target.isStage = false;
  const stageSprite = new Sprite(null, vm.runtime);
  stageSprite.name = 'Stage';
  const stage = new RenderedTarget(stageSprite, vm.runtime);
  stage.isStage = true;
  vm.runtime.targets = [stage, target];
  vm.editingTarget = target; // applyDslTextToTarget → emitWorkspaceUpdate 需要
  return { vm, target };
}

/** Apply DSL, read it back, and compare token-for-token.
 * `prep` (optional) runs against the fresh target before parsing — used to install the
 * fake extension block info for the dynamic-schema tests. */
function roundTrip (dsl, prep) {
  const { target } = makeTarget();
  if (prep) prep(target);
  const parsed = H.parseScratchDSL(dsl, target);
  const validation = H.validateParsedScript(parsed, target);
  if (validation.errors.length) {
    return { error: validation.errors.join('; ') };
  }
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));

  const all = target.blocks._blocks;
  const topId = Object.keys(all).find(id => all[id].topLevel && all[id].parent === null);
  const lines = [];
  const emit = (blk, ind) => {
    lines.push('  '.repeat(ind) + H.serializeBlockToDsl(blk, all, 0, target.runtime));
    if (blk.inputs && blk.inputs.SUBSTACK && blk.inputs.SUBSTACK.block) {
      let sub = all[blk.inputs.SUBSTACK.block];
      while (sub) { emit(sub, ind + 1); sub = sub.next ? all[sub.next] : null; }
    }
    if (blk.inputs && blk.inputs.SUBSTACK2 && blk.inputs.SUBSTACK2.block) {
      lines.push('  '.repeat(ind) + 'else');
      let sub2 = all[blk.inputs.SUBSTACK2.block];
      while (sub2) { emit(sub2, ind + 1); sub2 = sub2.next ? all[sub2.next] : null; }
    }
    if (blk.next && ind === 0) {
      if (blk.opcode === 'procedures_definition') {
        // define 的身体挂在 next 链上，重新发出时缩进一级（与 collectTargetDsl 一致）
        let sub = all[blk.next];
        while (sub) { emit(sub, ind + 1); sub = sub.next ? all[sub.next] : null; }
      } else {
        emit(all[blk.next], 0);
      }
    }
  };
  emit(all[topId], 0);
  return { dsl: lines.join('\n'), target, blocks: all, warnings: validation.warnings };
}

console.log('--- round trip ---');
[
  ['simple stack',
    'event_whenflagclicked\nmotion_movesteps 10\nlooks_say "hello"'],
  ['nested C-blocks',
    'event_whenkeypressed "space"\ncontrol_repeat 10\n  motion_changeyby 6\n  control_wait 0.02'],
  ['if/else with reporters',
    'event_whenflagclicked\ncontrol_if_else (operator_gt (sensing_timer) 10)\n  looks_say "up"\nelse\n  looks_say "down"'],
  ['list ops (argument order regression)',
    'event_whenflagclicked\ndata_addtolist "apple" @fruit\ndata_insertatlist "pear" 2 @fruit\ndata_replaceitemoflist 1 @fruit "kiwi"\ndata_deleteoflist 3 @fruit'],
  ['variable ops',
    'event_whenflagclicked\ndata_setvariableto $score 0\ndata_changevariableby $score 5'],
  ['menus and dropdowns',
    'event_whenflagclicked\nmotion_goto "_random_"\nmotion_pointtowards "_mouse_"\nlooks_switchcostumeto "costume1"\ncontrol_stop "this script"'],
  ['layer order (FORWARD_BACKWARD regression)',
    'event_whenflagclicked\nlooks_goforwardbackwardlayers "backward" 3'],
  ['glide (arg order regression)',
    'event_whenflagclicked\nmotion_glideto 1.5 "_mouse_"'],
  ['colour input',
    'event_whenflagclicked\ncontrol_wait_until (sensing_touchingcolor "#ff0000")'],
  ['angle input',
    'event_whenflagclicked\nmotion_pointindirection 45'],
  ['broadcast',
    'event_whenbroadcastreceived "go"\nevent_broadcast "done"'],
  ['deep reporter nesting',
    'event_whenflagclicked\nmotion_movesteps (operator_multiply (operator_add 1 2) (operator_random 1 10))'],
  ['boolean operators',
    'event_whenflagclicked\ncontrol_if (operator_and (sensing_mousedown) (operator_not (sensing_keypressed "a")))\n  looks_say "both"']
].forEach(([name, dsl]) => {
  const out = roundTrip(dsl);
  if (out.error) {
    check(name, false, 'validation rejected: ' + out.error);
    return;
  }
  const norm = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
  check(name, norm(out.dsl) === norm(dsl),
    'input:\n' + dsl.split('\n').map(l => '        ' + l).join('\n') +
    '\n      output:\n' + out.dsl.split('\n').map(l => '        ' + l).join('\n'));
});

console.log('--- shadow types ---');
{
  const r = roundTrip('event_whenflagclicked\nmotion_pointindirection 45\nsensing_touchingcolor "#ff0000"\ncontrol_repeat 4\n  looks_say "x"');
  const opcodes = Object.keys(r.blocks).map(id => r.blocks[id].opcode);
  check('math_angle shadow used for DIRECTION', opcodes.indexOf('math_angle') >= 0, 'shadows: ' + opcodes.join(','));
  check('colour_picker shadow used for COLOR', opcodes.indexOf('colour_picker') >= 0, 'shadows: ' + opcodes.join(','));
  check('math_whole_number shadow used for TIMES', opcodes.indexOf('math_whole_number') >= 0, 'shadows: ' + opcodes.join(','));
}
{
  const r = roundTrip('event_whenflagclicked\nsound_play "meow"');
  const opcodes = Object.keys(r.blocks).map(id => r.blocks[id].opcode);
  check('sound menu shadow created', opcodes.indexOf('sound_sounds_menu') >= 0, 'shadows: ' + opcodes.join(','));
}
{
  const r = roundTrip('event_whenflagclicked\nevent_broadcast "go"');
  const ids = Object.keys(r.blocks);
  const menu = ids.map(id => r.blocks[id]).find(b => b.opcode === 'event_broadcast_menu');
  check('broadcast menu shadow created', !!menu);
  check('broadcast bound to a real message id',
    !!(menu && menu.fields.BROADCAST_OPTION && menu.fields.BROADCAST_OPTION.id),
    menu ? JSON.stringify(menu.fields.BROADCAST_OPTION) : 'no menu block');
}
{
  const r = roundTrip('event_whenflagclicked\ncontrol_if (sensing_mousedown)\n  looks_say "x"');
  const ifBlock = Object.keys(r.blocks).map(id => r.blocks[id]).find(b => b.opcode === 'control_if');
  const condition = ifBlock.inputs.CONDITION;
  check('boolean slot holds a reporter, not a shadow',
    condition && condition.block && condition.shadow === null,
    JSON.stringify(condition));
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncontrol_if\n  looks_say "x"', target);
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));
  const ifBlock = built.blocks.find(b => b.opcode === 'control_if');
  check('empty boolean slot stays empty', !ifBlock.inputs.CONDITION, JSON.stringify(ifBlock.inputs));
}

console.log('--- validation ---');
[
  // validateParsedScript 带 runtime 时，未加载/未知的扩展积木给出中文提示
  ['unknown opcode', 'event_whenflagclicked\nmotion_teleport 10', /来自未加载或未知的扩展积木/],
  ['nested hat block', 'event_whenflagclicked\ncontrol_repeat 2\n  event_whenflagclicked', /hat blocks can only be/],
  ['too many arguments', 'event_whenflagclicked\nmotion_movesteps 10 20 30', /too many arguments/],
  ['body under a non-C block', 'event_whenflagclicked\nlooks_say "x"\n  motion_movesteps 1', /no body slot/],
  ['else on a plain if', 'event_whenflagclicked\ncontrol_if (sensing_mousedown)\n  looks_say "a"\nelse\n  looks_say "b"', /没有匹配到同缩进的 if\/if_else/]
].forEach(([name, dsl, pattern]) => {
  const { target } = makeTarget();
  let parsed;
  try {
    parsed = H.parseScratchDSL(dsl, target);
  } catch (e) {
    check(name, pattern.test(e.message), 'threw: ' + e.message);
    return;
  }
  const v = H.validateParsedScript(parsed, target);
  check(name, v.errors.some(e => pattern.test(e)),
    'errors: ' + (v.errors.join(' | ') || '(none)'));
});
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncontrol_repeat 5', target);
  const v = H.validateParsedScript(parsed, target);
  check('empty C-block body warns (not an error)',
    v.errors.length === 0 && v.warnings.some(w => /empty body/.test(w)),
    'errors: ' + v.errors.join('|') + ' warnings: ' + v.warnings.join('|'));
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncontrol_wait "soon"', target);
  const v = H.validateParsedScript(parsed, target);
  check('text in a number slot warns',
    v.warnings.some(w => /expects a number/.test(w)),
    'warnings: ' + v.warnings.join('|'));
}

console.log('--- insertion ---');
function setupScript (dsl) {
  const { vm, target } = makeTarget();
  const parsed = H.parseScratchDSL(dsl, target);
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));
  const all = target.blocks._blocks;
  const topId = Object.keys(all).find(id => all[id].topLevel && all[id].parent === null);
  return { vm, target, all, topId };
}
function readBack (target) {
  const all = target.blocks._blocks;
  const topIds = Object.keys(all).filter(id => all[id].topLevel && all[id].parent === null);
  return topIds.map(topId => {
    const lines = [];
    const emit = (blk, ind) => {
      lines.push('  '.repeat(ind) + H.serializeBlockToDsl(blk, all, 0, target.runtime));
      if (blk.inputs && blk.inputs.SUBSTACK && blk.inputs.SUBSTACK.block) {
        let sub = all[blk.inputs.SUBSTACK.block];
        while (sub) { emit(sub, ind + 1); sub = sub.next ? all[sub.next] : null; }
      }
      if (blk.inputs && blk.inputs.SUBSTACK2 && blk.inputs.SUBSTACK2.block) {
        lines.push('  '.repeat(ind) + 'else');
        let sub2 = all[blk.inputs.SUBSTACK2.block];
        while (sub2) { emit(sub2, ind + 1); sub2 = sub2.next ? all[sub2.next] : null; }
      }
      if (blk.next && ind === 0) emit(all[blk.next], 0);
    };
    emit(all[topId], 0);
    return lines.join('\n');
  });
}
function doInsert (env, anchorId, position, dsl, branch) {
  const parsed = H.parseScratchDSL(dsl, env.target);
  const body = { hat: null, blocks: parsed.blocks, warnings: parsed.warnings };
  const built = H.buildScriptBlocks(body, env.target, { topLevel: false });
  const first = built.blocks.filter(b => !b.shadow)[0];
  return H.spliceBlocksIntoScript(env.target, built.blocks, first.id, built.lastId,
    { position, blockId: anchorId, branch });
}
function findBlock (env, opcode) {
  return Object.keys(env.all).find(id => env.all[id].opcode === opcode);
}

{
  const env = setupScript('event_whenflagclicked\nmotion_movesteps 10\nlooks_say "end"');
  const anchor = findBlock(env, 'motion_movesteps');
  const res = doInsert(env, anchor, 'after', 'control_wait 1');
  check('insert after: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('insert after: single script kept', scripts.length === 1, 'got ' + scripts.length + ' scripts');
  check('insert after: order correct',
    scripts[0] === 'event_whenflagclicked\nmotion_movesteps 10\ncontrol_wait 1\nlooks_say "end"',
    JSON.stringify(scripts[0]));
}
{
  const env = setupScript('event_whenflagclicked\nmotion_movesteps 10\nlooks_say "end"');
  const anchor = findBlock(env, 'looks_say');
  const res = doInsert(env, anchor, 'before', 'control_wait 2');
  check('insert before: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('insert before: order correct',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\nmotion_movesteps 10\ncontrol_wait 2\nlooks_say "end"',
    JSON.stringify(scripts));
}
{
  const env = setupScript('event_whenflagclicked\nmotion_movesteps 10');
  const anchor = findBlock(env, 'event_whenflagclicked');
  const res = doInsert(env, anchor, 'before', 'control_wait 1');
  check('insert before a hat is refused', !res.ok && /hat block/.test(res.error || ''), res.error);
}
{
  const env = setupScript('event_whenflagclicked\ncontrol_repeat 3\n  motion_movesteps 5');
  const anchor = findBlock(env, 'control_repeat');
  const res = doInsert(env, anchor, 'body_start', 'looks_say "first"');
  check('body_start: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('body_start: placed at top of body',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\ncontrol_repeat 3\n  looks_say "first"\n  motion_movesteps 5',
    JSON.stringify(scripts));
}
{
  const env = setupScript('event_whenflagclicked\ncontrol_repeat 3\n  motion_movesteps 5');
  const anchor = findBlock(env, 'control_repeat');
  const res = doInsert(env, anchor, 'body_end', 'looks_say "last"');
  check('body_end: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('body_end: appended to body',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\ncontrol_repeat 3\n  motion_movesteps 5\n  looks_say "last"',
    JSON.stringify(scripts));
}
{
  const env = setupScript('event_whenflagclicked\ncontrol_forever');
  const anchor = findBlock(env, 'control_forever');
  const res = doInsert(env, anchor, 'body_end', 'motion_movesteps 1\nmotion_ifonedgebounce');
  check('body_end into empty body: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('body_end into empty body: both blocks inside',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\ncontrol_forever\n  motion_movesteps 1\n  motion_ifonedgebounce',
    JSON.stringify(scripts));
}
{
  const env = setupScript('event_whenflagclicked\ncontrol_if_else (sensing_mousedown)\n  looks_say "a"\nelse\n  looks_say "b"');
  const anchor = findBlock(env, 'control_if_else');
  const res = doInsert(env, anchor, 'body_end', 'control_wait 1', 'else');
  check('else branch: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('else branch: appended to else body',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\ncontrol_if_else (sensing_mousedown)\n  looks_say "a"\nelse\n  looks_say "b"\n  control_wait 1',
    JSON.stringify(scripts));
}
{
  const env = setupScript('event_whenflagclicked\nlooks_say "x"');
  const anchor = findBlock(env, 'looks_say');
  const res = doInsert(env, anchor, 'body_start', 'control_wait 1');
  check('body_start on a non-C block is refused',
    !res.ok && /no body slot/.test(res.error || ''), res.error);
}
{
  const env = setupScript('event_whenflagclicked\ncontrol_repeat 2\n  motion_movesteps 1');
  const anchor = findBlock(env, 'motion_movesteps');
  const res = doInsert(env, anchor, 'before', 'looks_say "inner"');
  check('insert before first block of a body: ok', res.ok, res.error);
  const scripts = readBack(env.target);
  check('insert before first block of a body: stays inside',
    scripts.length === 1 &&
    scripts[0] === 'event_whenflagclicked\ncontrol_repeat 2\n  looks_say "inner"\n  motion_movesteps 1',
    JSON.stringify(scripts));
}

console.log('--- JSON block object fallback ---');
{
  const obj = {
    opcode: 'event_whenflagclicked',
    next: { opcode: 'data_addtolist', inputs: { ITEM: 'apple' }, fields: { LIST: 'fruit' } }
  };
  const dsl = H.convertBlockObjToDsl(obj, 0).join('\n');
  check('object → DSL keeps schema order',
    dsl === 'event_whenflagclicked\ndata_addtolist "apple" @fruit',
    JSON.stringify(dsl));
}

console.log('--- value primitives (Phase B) ---');
function findAll (blocks) {
  return Object.keys(blocks).map(id => blocks[id]);
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\nmotion_movesteps (math_number "10")', target);
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));
  const all = target.blocks._blocks;
  const move = findAll(all).find(b => b.opcode === 'motion_movesteps');
  const shadow = all[move.inputs.STEPS.shadow];
  check('(math_number "10") folds into a math_number shadow worth 10',
    shadow && shadow.opcode === 'math_number' && shadow.fields.NUM.value === 10,
    JSON.stringify(shadow && shadow.fields));
  check('no standalone math_number block is created',
    findAll(all).every(b => b.opcode !== 'math_number' || b.shadow === true),
    'found a non-shadow math_number');
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\nlooks_say (data_variable "score")', target);
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));
  const all = target.blocks._blocks;
  const say = findAll(all).find(b => b.opcode === 'looks_say');
  const reporter = all[say.inputs.MESSAGE.block];
  check('(data_variable "score") becomes a data_variable reporter on MESSAGE',
    reporter && reporter.opcode === 'data_variable' && reporter.fields.VARIABLE.value === 'score',
    JSON.stringify(reporter && reporter.fields));
  const r = roundTrip('event_whenflagclicked\nlooks_say (data_variable "score")');
  check('folded variable reporter serializes to the $score shorthand',
    !r.error && r.dsl === 'event_whenflagclicked\nlooks_say $score', r.error || r.dsl);
  check('$score shorthand re-parses and round-trips',
    (() => { const r2 = roundTrip('event_whenflagclicked\nlooks_say $score'); return !r2.error && r2.dsl === 'event_whenflagclicked\nlooks_say $score'; })(),
    (() => { const r2 = roundTrip('event_whenflagclicked\nlooks_say $score'); return r2.error || r2.dsl; })());
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\nsensing_touchingcolor (colour_picker "#ff0000")', target);
  const built = H.buildScriptBlocks(parsed, target);
  built.blocks.forEach(b => target.blocks.createBlock(b));
  const all = target.blocks._blocks;
  const touch = findAll(all).find(b => b.opcode === 'sensing_touchingcolor');
  const shadow = all[touch.inputs.COLOR.shadow];
  check('(colour_picker "#ff0000") folds into a colour_picker shadow',
    shadow && shadow.opcode === 'colour_picker' && shadow.fields.COLOUR.value === '#ff0000',
    JSON.stringify(shadow && shadow.fields));
}
[
  ['bare math_number line', 'math_number "0"'],
  ['bare text line', 'text "50"']
].forEach(([name, dsl]) => {
  const { target } = makeTarget();
  const v = H.validateParsedScript(H.parseScratchDSL(dsl, target), target);
  check(name + ' is rejected as a value primitive',
    v.errors.some(e => e.indexOf('值原语') >= 0), v.errors.join(' | '));
});

console.log('--- floating value blocks (Phase B) ---');
{
  const { vm, target } = makeTarget();
  // 手工放一个漂浮 shadow 值块（模拟用户拖到画布上没接进脚本的块）
  target.blocks.createBlock({
    id: '_float_num_1', opcode: 'math_number',
    fields: { NUM: { name: 'NUM', value: 42, id: undefined } },
    inputs: {}, next: null, parent: null, shadow: true, topLevel: true, x: 10, y: 10
  });
  const parsed = H.parseScratchDSL('event_whenflagclicked\nlooks_say "real"', target);
  H.buildScriptBlocks(parsed, target).blocks.forEach(b => target.blocks.createBlock(b));
  const text = H.collectTargetDsl(target).map(s => s.dsl).join('\n\n');
  const floatLine = text.split('\n').find(l => l.indexOf('# 漂浮值块:') === 0);
  check('floating shadow is serialized as a 漂浮值块 comment line',
    !!floatLine && floatLine.indexOf('math_number') >= 0, JSON.stringify(text));
  const res = H.applyDslTextToTarget(vm, target, text);
  check('text containing the comment re-applies cleanly', res.success === true, res.error);
}

console.log('--- quoted names and escapes (Phase B) ---');
{
  const r = roundTrip('event_whenflagclicked\ndata_setvariableto $"my var" 0');
  check('quoted variable name round-trips',
    !r.error && r.dsl === 'event_whenflagclicked\ndata_setvariableto $"my var" 0', r.error || r.dsl);
  const set = findAll(r.blocks).find(b => b.opcode === 'data_setvariableto');
  check('variable field binds to "my var"',
    set && set.fields.VARIABLE && set.fields.VARIABLE.value === 'my var' && !!set.fields.VARIABLE.id,
    JSON.stringify(set && set.fields));
}
{
  const r = roundTrip('event_whenflagclicked\ndata_addtolist "apple" @"my list"');
  check('quoted list name round-trips',
    !r.error && r.dsl === 'event_whenflagclicked\ndata_addtolist "apple" @"my list"', r.error || r.dsl);
  const add = findAll(r.blocks).find(b => b.opcode === 'data_addtolist');
  check('list field binds to "my list"',
    add && add.fields.LIST && add.fields.LIST.value === 'my list' && !!add.fields.LIST.id,
    JSON.stringify(add && add.fields));
}
{
  const r = roundTrip('event_whenflagclicked\nlooks_say "line1\\nline2"');
  check('newline escape survives the round trip on one line',
    !r.error && r.dsl === 'event_whenflagclicked\nlooks_say "line1\\nline2"',
    r.error || JSON.stringify(r.dsl));
  const say = findAll(r.blocks).find(b => b.opcode === 'looks_say');
  const textShadow = r.blocks[say.inputs.MESSAGE.shadow];
  check('rebuilt TEXT holds a real newline',
    textShadow && textShadow.fields.TEXT.value === 'line1\nline2',
    JSON.stringify(textShadow && textShadow.fields.TEXT));
}
{
  const r = roundTrip('event_whenflagclicked\nlooks_say "say \\"hi\\""');
  check('escaped quotes round-trip',
    !r.error && r.dsl === 'event_whenflagclicked\nlooks_say "say \\"hi\\""', r.error || r.dsl);
}

console.log('--- else strictness and control_stop (Phase B) ---');
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncontrol_repeat 2\n  looks_say "a"\nelse\n  looks_say "b"', target);
  const v = H.validateParsedScript(parsed, target);
  check('else without a matching if/if_else is rejected',
    v.errors.some(e => /没有匹配到同缩进的 if\/if_else/.test(e)), v.errors.join(' | '));
}
{
  const r = roundTrip('event_whenflagclicked\ncontrol_stop "other scripts in sprite"\n  looks_say "x"');
  check('control_stop with a substack round-trips',
    !r.error && r.dsl === 'event_whenflagclicked\ncontrol_stop "other scripts in sprite"\n  looks_say "x"',
    r.error || r.dsl);
  check('control_stop with a body does not warn about empty bodies',
    r.warnings.every(w => !/empty body/.test(w)), r.warnings.join(' | '));
}
{
  const r = roundTrip('event_whenflagclicked\ncontrol_stop "all"');
  check('control_stop "all" without a body does not warn',
    !r.error && r.warnings.every(w => !/empty body/.test(w)),
    r.error || r.warnings.join(' | '));
}

console.log('--- custom blocks: define + call (Phase C) ---');
{
  const { vm, target } = makeTarget();
  const text = 'define walk (steps) <fast>\n' +
    '  motion_movesteps %steps\n' +
    '  control_if %fast\n' +
    '    looks_say "fast!"\n' +
    '\n' +
    'event_whenflagclicked\n' +
    'call "walk %s %b" 10 (operator_gt (sensing_timer) 5)';
  const r1 = H.applyDslTextToTarget(vm, target, text);
  check('define + call applies through the panel path', r1.success === true, r1.error);
  const all = target.blocks._blocks;
  const blocks = findAll(all);
  const proto = blocks.find(b => b.opcode === 'procedures_prototype');
  const definition = proto && all[proto.parent];
  check('procedures_prototype carries the proccode',
    !!proto && proto.mutation.proccode === 'walk %s %b',
    proto ? JSON.stringify(proto.mutation) : 'no prototype');
  let protoArgIds = [];
  let protoArgNames = [];
  try {
    protoArgIds = JSON.parse(proto.mutation.argumentids);
    protoArgNames = JSON.parse(proto.mutation.argumentnames);
  } catch (e) { /* checked below */ }
  check('prototype argumentids/argumentnames are aligned JSON arrays',
    Array.isArray(protoArgIds) && protoArgIds.length === 2 &&
    protoArgNames[0] === 'steps' && protoArgNames[1] === 'fast',
    JSON.stringify(protoArgNames));
  check('prototype warp defaults to false', proto.mutation.warp === 'false', String(proto.mutation.warp));
  check('prototype is a shadow hanging off procedures_definition',
    proto.shadow === true && definition && definition.opcode === 'procedures_definition',
    definition ? definition.opcode : 'no parent');
  const argReporter = blocks.find(b => b.opcode === 'argument_reporter_string_number');
  check('%steps becomes a string/number argument reporter',
    argReporter && argReporter.fields.VALUE.value === 'steps',
    JSON.stringify(argReporter && argReporter.fields));
  const ifBlock = blocks.find(b => b.opcode === 'control_if');
  const cond = ifBlock && all[ifBlock.inputs.CONDITION.block];
  check('%fast becomes a boolean argument reporter',
    cond && cond.opcode === 'argument_reporter_boolean' && cond.fields.VALUE.value === 'fast',
    cond ? cond.opcode + ' ' + JSON.stringify(cond.fields) : 'no condition');
  const call = blocks.find(b => b.opcode === 'procedures_call');
  check('call mutation.argumentids match the prototype',
    !!call && JSON.parse(call.mutation.argumentids).join(',') === protoArgIds.join(','),
    call ? call.mutation.argumentids : 'no call block');
  const numShadow = call && all[call.inputs[protoArgIds[0]].shadow];
  check('call first slot holds a math_number shadow worth 10',
    numShadow && numShadow.opcode === 'math_number' && numShadow.fields.NUM.value === 10,
    JSON.stringify(numShadow && numShadow.fields));
  const boolArg = call && all[call.inputs[protoArgIds[1]].block];
  check('call second slot holds the boolean reporter',
    boolArg && boolArg.opcode === 'operator_gt' && call.inputs[protoArgIds[1]].shadow === null,
    boolArg ? boolArg.opcode : 'empty slot');

  const collected = H.collectTargetDsl(target).map(s => s.dsl).join('\n\n');
  const r2 = H.applyDslTextToTarget(vm, target, collected);
  check('collected define+call text re-applies', r2.success === true, r2.error);
  const collected2 = r2.success ? H.collectTargetDsl(target).map(s => s.dsl).join('\n\n') : '';
  check('define + call round-trips idempotently through the panel path',
    collected2 === collected,
    'first:\n' + collected.split('\n').map(l => '        ' + l).join('\n') +
    '\n      second:\n' + collected2.split('\n').map(l => '        ' + l).join('\n'));
}
{
  const r = roundTrip('define go <flag> warp=true\n  motion_movesteps 1');
  check('define with warp=true round-trips',
    !r.error && r.dsl === 'define go <flag> warp=true\n  motion_movesteps 1', r.error || r.dsl);
  const proto = findAll(r.blocks).find(b => b.opcode === 'procedures_prototype');
  check('warp=true lands in the prototype mutation',
    proto && proto.mutation.warp === 'true', proto ? String(proto.mutation.warp) : 'no prototype');
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncall "walk %s %b" 10', target);
  const v = H.validateParsedScript(parsed, target);
  check('call to an unknown proccode is an error',
    v.errors.some(e => /call 引用的自定义积木 "walk %s %b" 不存在/.test(e)), v.errors.join(' | '));
}
{
  const { vm, target } = makeTarget();
  const text = 'define walk (steps) <fast>\n  motion_movesteps %steps\n\n' +
    'event_whenflagclicked\ncall "walk %s %b" 10 (operator_gt (sensing_timer) 5) 20';
  const r = H.applyDslTextToTarget(vm, target, text);
  check('call with too many arguments is rejected',
    r.success === false && /call 参数过多/.test(r.error || ''), r.error);
}
{
  const { vm, target } = makeTarget();
  const text = 'define walk (steps) <fast>\n  motion_movesteps %steps\n\n' +
    'event_whenflagclicked\ncall "walk %s %b" 10';
  const r = H.applyDslTextToTarget(vm, target, text);
  check('missing %b argument warns but still applies',
    r.success === true && (r.warnings || []).some(w => /%b 没有对应的实参/.test(w)),
    JSON.stringify({ error: r.error, warnings: r.warnings }));
}
{
  const { vm, target } = makeTarget();
  const text = 'define walk (steps) <fast>\n  motion_movesteps %steps\n\n' +
    'event_whenflagclicked\ncall "walk %s %b" 10 true';
  const r = H.applyDslTextToTarget(vm, target, text);
  check('bare true in a %b slot is left empty with a warning',
    r.success === true && (r.warnings || []).some(w => /布尔参数用 true\/false/.test(w)),
    JSON.stringify({ error: r.error, warnings: r.warnings }));
}
{
  const { vm, target } = makeTarget();
  const text = 'define walk (steps)\n  motion_movesteps %steps\n\ndefine walk (steps)\n  motion_movesteps %steps';
  const r = H.applyDslTextToTarget(vm, target, text);
  check('duplicate define is refused', r.success === false && /重复定义/.test(r.error || ''), r.error);
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\ncontrol_repeat 2\n  define walk (steps)\n    motion_movesteps %steps', target);
  const v = H.validateParsedScript(parsed, target);
  check('define nested inside a body is a hat error',
    v.errors.some(e => /hat blocks can only be/.test(e)), v.errors.join(' | '));
}
{
  const { target } = makeTarget();
  const parsed = H.parseScratchDSL('event_whenflagclicked\nmotion_movesteps %steps', target);
  const v = H.validateParsedScript(parsed, target);
  check('%ref outside a define body is an error',
    v.errors.some(e => /不在最近的 define 参数列表中/.test(e)), v.errors.join(' | '));
}
{
  const { vm, target } = makeTarget();
  H.applyDslTextToTarget(vm, target, 'define walk (steps) <fast> warp=true\n  motion_movesteps %steps');
  const entry = H.collectProcRegistry(target).get('walk %s %b');
  check('collectProcRegistry parses the VM prototype',
    !!entry && entry.argNames.join(',') === 'steps,fast' &&
    entry.argTypes.join(',') === 'string,bool' && entry.argIds.length === 2 && entry.warp === true,
    JSON.stringify(Array.from(H.collectProcRegistry(target).entries())));
}

console.log('--- extension dynamic schema (Phase B/C) ---');
// 伪造一个已加载扩展：1 个按钮项、1 个带 input_value(number)/field_dropdown/布尔输入的
// 语句块、1 个 C 形块。结构对齐 scratch-vm 在 runtime._blockInfo 里的真实形态。
const installFakeExt = function (target) {
  target.runtime._blockInfo = [{
    id: 'myext',
    name: 'My Ext',
    menuInfo: {},
    blocks: [
      // 按钮项：不会匹配任何 opcode，不应干扰 schema 推导
      { info: {}, json: { type: 'button', message0: 'press me', args0: [] } },
      {
        info: { arguments: { NUM: { type: 'number' }, FLAG: { type: 'Boolean' } } },
        json: {
          type: 'myext_do',
          args0: [
            { name: 'NUM', type: 'input_value' },
            { name: 'MODE', type: 'field_dropdown' },
            { name: 'FLAG', type: 'input_value', check: 'Boolean' }
          ]
        }
      },
      {
        info: {},
        json: {
          type: 'myext_c',
          args0: [
            { name: 'LABEL', type: 'field_dropdown' },
            { name: 'SUBSTACK', type: 'input_statement' }
          ]
        }
      }
    ]
  }];
};
{
  const r = roundTrip('event_whenflagclicked\nmyext_do 7 "hi" (sensing_mousedown)', installFakeExt);
  check('extension block round-trips through the dynamic schema',
    !r.error && r.dsl === 'event_whenflagclicked\nmyext_do 7 "hi" (sensing_mousedown)', r.error || r.dsl);
  const doBlock = findAll(r.blocks).find(b => b.opcode === 'myext_do');
  const numShadow = doBlock && r.blocks[doBlock.inputs.NUM.shadow];
  check('ext number input gets a math_number shadow',
    numShadow && numShadow.fields.NUM.value === 7, JSON.stringify(numShadow && numShadow.fields));
  check('ext dropdown is stored as a field value',
    doBlock && doBlock.fields.MODE && doBlock.fields.MODE.value === 'hi',
    JSON.stringify(doBlock && doBlock.fields));
  const flagArg = doBlock && r.blocks[doBlock.inputs.FLAG.block];
  check('ext boolean input holds the reporter, not a shadow',
    flagArg && flagArg.opcode === 'sensing_mousedown' && doBlock.inputs.FLAG.shadow === null,
    flagArg ? flagArg.opcode : 'empty slot');
}
{
  const { vm, target } = makeTarget();
  installFakeExt(target);
  const text = 'event_whenflagclicked\nmyext_do 7 "hi" (sensing_mousedown)';
  const parsed = H.parseScratchDSL(text, target);
  const v = H.validateParsedScript(parsed, target);
  check('extension block validates without errors', v.errors.length === 0, v.errors.join(' | '));
  H.buildScriptBlocks(parsed, target).blocks.forEach(b => target.blocks.createBlock(b));
  const collected = H.collectTargetDsl(target).map(s => s.dsl).join('\n');
  check('collectTargetDsl serializes the extension block verbatim', collected === text, collected);
  const r2 = H.applyDslTextToTarget(vm, target, collected);
  check('collected extension text re-applies', r2.success === true, r2.error);
  const collected2 = r2.success ? H.collectTargetDsl(target).map(s => s.dsl).join('\n') : '';
  check('extension text survives another apply/collect cycle', collected2 === text, collected2);
}
{
  const r = roundTrip('event_whenflagclicked\nmyext_c "mode"\n  looks_say "inner"', installFakeExt);
  check('extension C-block round-trips with its body',
    !r.error && r.dsl === 'event_whenflagclicked\nmyext_c "mode"\n  looks_say "inner"', r.error || r.dsl);
  const cBlock = findAll(r.blocks).find(b => b.opcode === 'myext_c');
  const inner = cBlock && r.blocks[cBlock.inputs.SUBSTACK.block];
  check('body landed inside the extension C-block', inner && inner.opcode === 'looks_say',
    inner ? inner.opcode : 'no body');
}
{
  const { target } = makeTarget();
  installFakeExt(target);
  const s1 = H.resolveBlockSchema('myext_do', target.runtime);
  const s2 = H.resolveBlockSchema('myext_do', target.runtime);
  check('dynamic schema is derived once and cached per runtime (WeakMap)',
    !!s1 && s1 === s2 && s1.dynamic === true && s1.args.length === 3, JSON.stringify(s1));
  check('core opcodes still resolve from the static table',
    H.resolveBlockSchema('motion_movesteps', target.runtime) === H.OPCODE_SCHEMA.motion_movesteps);
}
{
  const { target } = makeTarget();
  installFakeExt(target);
  const parsed = H.parseScratchDSL('event_whenflagclicked\nmyext_missing 1', target);
  const v = H.validateParsedScript(parsed, target);
  check('unloaded extension opcode is rejected with the Chinese hint',
    v.errors.some(e => /未加载或未知的扩展积木/.test(e)), v.errors.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('');
  failures.forEach(f => console.log('  FAIL: ' + f));
  process.exit(1);
}
