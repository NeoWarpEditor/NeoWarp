/**
 * Regression tests for the AI stream disconnect auto-retry (issue #8).
 *
 * These tests do NOT reimplement the retry logic. They slice the REAL code out of
 * src-renderer/ai-assistant/ai-assistant.html — the retry state machine inside
 * sendMessage() plus the module-level isTransientStreamFailure() — and drive it in a
 * harness with stubbed DOM/API helpers and a virtual clock. Whatever is currently
 * written in the HTML is exactly what gets exercised.
 *
 * Covered behaviour:
 *   - transient failures (network error / mid-stream drop) retry every 5s, max 10 retries
 *   - after 10 failed retries the last error is surfaced to the user as a message
 *   - an empty final text (DeepSeek long-thinking stream drop, no tool calls) counts as
 *     a disconnect and is retried
 *   - permanent API rejections (e.g. HTTP 401) surface the error immediately without retry
 *   - HTTP 408/429/5xx are treated as transient and retried
 *   - user abort (Esc) during an attempt or during the retry wait cancels everything
 *   - a successful attempt resets nothing but stops the retry loop (tool_calls / text)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src-renderer/ai-assistant/ai-assistant.html'), 'utf8');

// ── slice the code under test out of the html ──────────────────────────────
const retryMarker = HTML.indexOf('── 断连自动重试');
if (retryMarker < 0) throw new Error('retry block marker not found in ai-assistant.html');
const blockStart = HTML.lastIndexOf('var lastContent', retryMarker);
const callStart = HTML.lastIndexOf('startStreamAttempt();');
if (blockStart < 0 || callStart < 0) throw new Error('retry block boundaries not found');
const blockEnd = HTML.indexOf('\n', callStart) + 1;
const retryBlock = HTML.slice(blockStart, blockEnd);

const itsfStart = HTML.indexOf('// 判断一次模型请求失败是否值得自动重试');
const itsfEnd = HTML.indexOf('function doApiCall', itsfStart);
if (itsfStart < 0 || itsfEnd < 0) throw new Error('isTransientStreamFailure not found');
const itsf = HTML.slice(itsfStart, itsfEnd);

// ── virtual clock so 10 retries × 5s run instantly ─────────────────────────
function makeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    function nextDue() {
        let best = null;
        timers.forEach(function(t) { if (best === null || t.fireAt < best.fireAt) best = t; });
        return best;
    }
    return {
        setTimeout: function(fn, ms) { var id = ++seq; timers.set(id, { id: id, fireAt: now + (ms || 0), fn: fn, interval: 0 }); return id; },
        setInterval: function(fn, ms) { var id = ++seq; timers.set(id, { id: id, fireAt: now + (ms || 0), fn: fn, interval: ms || 1 }); return id; },
        clearTimeout: function(id) { timers.delete(id); },
        clearInterval: function(id) { timers.delete(id); },
        tick: function(ms) {
            var end = now + ms;
            for (;;) {
                var t = nextDue();
                if (!t || t.fireAt > end) break;
                now = t.fireAt;
                if (t.interval) t.fireAt = now + t.interval; else timers.delete(t.id);
                t.fn();
            }
            now = end;
        },
        pending: function() { return timers.size; }
    };
}

// ── harness: eval the sliced code with stubbed externals ───────────────────
function makeElement() {
    return {
        className: '', id: '', innerHTML: '', removed: false, parentNode: null,
        remove: function() { this.removed = true; },
        appendChild: function() {},
        querySelector: function() { return null; },
        querySelectorAll: function() { return []; },
        classList: { add: function() {}, remove: function() {} }
    };
}

var T = {
    streamRetrying: '连接断开，{s} 秒后自动重试（{n}/{max}）',
    streamRetryExhausted: '已自动重试 10 次仍失败，最后一次报错：',
    emptyStreamResponse: '模型返回了空响应（流已结束但没有任何输出）。',
    thinking: 'Thinking...'
};

function runHarness(script) {
    var clock = makeClock();
    var calls = [];
    var rec = function(name) { return function() { calls.push({ name: name, args: Array.prototype.slice.call(arguments) }); }; };

    var streamingWrapper = makeElement();
    var streamingBubble = { innerHTML: '' };
    var chatHistory = [];
    var abortController = { signal: { listeners: [], addEventListener: function(type, fn) { this.listeners.push(fn); } } };

    var attempts = 0;
    var doApiCall = function(msgs, cb) {
        attempts++;
        if (attempts > script.length) throw new Error('doApiCall attempt #' + attempts + ' but only ' + script.length + ' scripted');
        calls.push({ name: 'doApiCall', attempt: attempts });
        cb(script[attempts - 1].result);
    };

    var exported = null;
    var exportShim = ';__export({' +
        'get isLoading() { return isLoading; },' +
        'get retryAttempt() { return retryAttempt; },' +
        'get streamSettled() { return streamSettled; },' +
        'get lastStreamError() { return lastStreamError; },' +
        'get bubble() { return streamingBubble.innerHTML; } });';

    var factory = new Function(
        'apiMessages', 'chatHistory', 'isLoading', 'abortController', 'currentRequestTokens',
        'streamingWrapper', 'streamingBubble', 'activeProcessBody', 'chatArea', 'document',
        't', 'escapeHtml', 'formatTime', 'formatMarkdown', 'renderSummaryFooter',
        'appendAIMessage', 'appendToolResult', 'saveCurrentConversation', 'updateSendBtn',
        'noteBuiltinQuotaIfExhausted', 'scrollToBottom', 'finalizeProcessGroup',
        'updateStreamingReasoning', 'phoneClearStream', 'phonePushHistory', 'phonePushStream',
        'getTodoAppendTarget', 'executeToolCall', 'buildApiMessages', 'sendMessage',
        'PROVIDERS', 'currentConfig', 'doApiCall', 'isGeneratingConvVisible', 'setGeneratingConv',
        'getGeneratingConv', 'pushGeneratingMessage', 'trackSidebarTodoToolCalls', 'notifySidebarTodoTurnEnd',
        'handleWorkflowTurnEnd',
        'generationAbortRequested',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', '__export',
        itsf + retryBlock + exportShim
    );

    factory(
        [], chatHistory, true, abortController, 1234,
        streamingWrapper, streamingBubble, null,
        { appendChild: function() {}, querySelectorAll: function() { return []; } },
        { createElement: makeElement, getElementById: function() { return null; } },
        function(k) { return T[k] || k; },
        function(s) { return String(s); }, function() { return '12:00'; },
        function(md) { return 'MD:' + md; }, rec('renderSummaryFooter'),
        rec('appendAIMessage'), rec('appendToolResult'), rec('saveCurrentConversation'), rec('updateSendBtn'),
        rec('noteBuiltinQuotaIfExhausted'), rec('scrollToBottom'), rec('finalizeProcessGroup'),
        rec('updateStreamingReasoning'), rec('phoneClearStream'), rec('phonePushHistory'), rec('phonePushStream'),
        function() { return { appendChild: function() {} }; },
        function() { return Promise.resolve({ ok: true }); },
        function() { return { messages: [], tokenCount: 100 }; },
        rec('sendMessage'),
        {}, { provider: 'none' },
        doApiCall,
        function() { return true; },
        rec('setGeneratingConv'),
        function() { return null; },
        function(m) { chatHistory.push(m); },
        rec('trackSidebarTodoToolCalls'),
        rec('notifySidebarTodoTurnEnd'),
        rec('handleWorkflowTurnEnd'),
        false,
        clock.setTimeout, clock.setInterval, clock.clearTimeout, clock.clearInterval,
        function(e) { exported = e; }
    );

    return {
        clock: clock, calls: calls, exported: exported,
        chatHistory: chatHistory, streamingWrapper: streamingWrapper,
        abortController: abortController, attempts: function() { return attempts; }
    };
}

var netErr = { name: 'TypeError', message: 'Connect Timeout Error (443, timeout 10000ms)' };
var failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

async function main() {
    // ── S1: 11 consecutive transient failures → 1 attempt + 10 retries, then last error shown ──
    console.log('S1: 断连 10 次重试后呈现最后的报错');
    var script = [];
    for (var i = 0; i < 11; i++) script.push({ result: { type: 'error', error: netErr } });
    var h = runHarness(script);
    check('首次尝试立即发起', h.attempts() === 1);
    check('首次失败后进入 5s 倒计时并显示 (1/10)', h.exported.bubble.indexOf('（1/10）') !== -1 && h.exported.bubble.indexOf('5 秒后') !== -1, h.exported.bubble);
    check('倒计时中报错信息一并展示', h.exported.bubble.indexOf('Connect Timeout Error (443, timeout 10000ms)') !== -1);
    for (var j = 0; j < 10; j++) h.clock.tick(5000);
    check('共发起 1+10 次请求', h.attempts() === 11, h.attempts());
    check('重试预算耗尽后不再有挂起任务', h.clock.pending() === 0);
    check('向用户呈现最后一次的报错', h.chatHistory.length === 1 && h.chatHistory[0].content === 'Error: ' + T.streamRetryExhausted + netErr.message, h.chatHistory);
    check('报错以 AI 消息渲染', h.calls.filter(function(c) { return c.name === 'appendAIMessage'; }).length === 1);
    check('会话状态收尾（isLoading=false、流气泡移除；按钮重启用在切片外的收尾链里完成）',
        h.exported.isLoading === false && h.streamingWrapper.removed === true, { isLoading: h.exported.isLoading, removed: h.streamingWrapper.removed });

    // ── S2: 第 3 次尝试成功（正常文本）→ 重试停止，正常收尾 ──
    console.log('S2: 重试期间恢复，成功后停止重试');
    var h2 = runHarness([
        { result: { type: 'error', error: netErr } },
        { result: { type: 'error', error: { name: 'TypeError', message: 'session ended' } } },
        { result: { type: 'text', content: '最终回答', reasoning: '' } }
    ]);
    h2.clock.tick(5000);
    h2.clock.tick(5000);
    await new Promise(function(r) { setImmediate(r); });
    check('共发起 3 次请求', h2.attempts() === 3, h2.attempts());
    check('成功后无错误消息', h2.chatHistory.length === 1 && h2.chatHistory[0].content === '最终回答', h2.chatHistory);
    check('成功后 isLoading=false', h2.exported.isLoading === false);
    check('成功后无挂起任务', h2.clock.pending() === 0);

    // ── S3: 空文本输出（issue 的断流场景）→ 视为断连自动重试 ──
    console.log('S3: 空文本输出触发重试');
    var h3 = runHarness([
        { result: { type: 'text', content: '', reasoning: '思考了 2m49s 但没有输出' } },
        { result: { type: 'text', content: '好了，完成了', reasoning: '' } }
    ]);
    check('空文本立即进入重试', h3.exported.retryAttempt === 1 && h3.clock.pending() > 0);
    h3.clock.tick(5000);
    check('重试后成功', h3.attempts() === 2 && h3.chatHistory.length === 1 && h3.chatHistory[0].content === '好了，完成了', h3.chatHistory);
    check('纯空白文本同样触发重试', (function() {
        var h3b = runHarness([
            { result: { type: 'text', content: '  \n  ', reasoning: '' } },
            { result: { type: 'text', content: 'ok', reasoning: '' } }
        ]);
        return h3b.exported.retryAttempt === 1;
    })());

    // ── S4: 等待重试期间按 Esc（abort 信号）→ 取消重试并清理 ──
    console.log('S4: 等待重试期间可取消');
    var h4 = runHarness([
        { result: { type: 'error', error: netErr } },
        { result: { type: 'text', content: '不该到达', reasoning: '' } }
    ]);
    check('等待期有挂起任务', h4.clock.pending() > 0);
    h4.abortController.signal.listeners.forEach(function(fn) { fn(); });
    h4.clock.tick(60000);
    check('取消后不再发起重试', h4.attempts() === 1, h4.attempts());
    check('取消后状态收尾', h4.exported.isLoading === false && h4.streamingWrapper.removed === true && h4.clock.pending() === 0);
    check('取消不产生错误消息', h4.chatHistory.length === 0, h4.chatHistory);

    // ── S5: 活跃请求期间中断（AbortError 经回调返回）→ 静默清理 ──
    console.log('S5: 请求进行中按 Esc 中断');
    var h5 = runHarness([{ result: { type: 'error', error: { name: 'AbortError', message: 'aborted' } } }]);
    check('中断后立即收尾且无重试', h5.exported.streamSettled === true && h5.attempts() === 1 && h5.clock.pending() === 0 && h5.exported.isLoading === false);
    check('中断不产生错误消息', h5.chatHistory.length === 0);

    // ── S6: HTTP 401（明确拒绝）→ 不重试，立即呈现报错 ──
    console.log('S6: 不可重试的 API 拒绝立即呈现');
    var h6 = runHarness([{ result: { type: 'error', error: { name: 'Error', message: 'Invalid API key', status: 401 } } }]);
    check('401 不重试', h6.attempts() === 1, h6.attempts());
    check('401 报错直接展示', h6.chatHistory.length === 1 && h6.chatHistory[0].content === 'Error: Invalid API key', h6.chatHistory);
    check('401 后无挂起任务', h6.clock.pending() === 0);

    // ── S7: HTTP 500 / 429 / 408 视为瞬时故障，参与重试 ──
    console.log('S7: 5xx/429/408 参与重试');
    var h7 = runHarness([
        { result: { type: 'error', error: { name: 'Error', message: 'server exploded', status: 500 } } },
        { result: { type: 'error', error: { name: 'Error', message: 'rate limited', status: 429 } } },
        { result: { type: 'error', error: { name: 'Error', message: 'request timeout', status: 408 } } },
        { result: { type: 'text', content: '恢复', reasoning: '' } }
    ]);
    h7.clock.tick(5000); h7.clock.tick(5000); h7.clock.tick(5000);
    check('三次瞬时故障后第 4 次成功', h7.attempts() === 4 && h7.chatHistory[0].content === '恢复', { attempts: h7.attempts(), history: h7.chatHistory });
    check('耗尽重试同样适用于瞬时故障（400 不重试）', (function() {
        var h7b = runHarness([{ result: { type: 'error', error: { name: 'Error', message: 'bad request', status: 400 } } }]);
        return h7b.attempts() === 1 && h7b.chatHistory[0].content === 'Error: bad request';
    })());

    // ── S8: tool_calls 结果 → 正常进入工具循环，不触发重试 ──
    console.log('S8: 工具调用不受重试逻辑影响');
    var h8 = runHarness([{ result: { type: 'tool_calls', toolCalls: [{ id: 't1', function: { name: 'list_sprites', arguments: '{}' } }], content: '', reasoning: '' } }]);
    await new Promise(function(r) { setImmediate(r); });
    var sent = h8.calls.filter(function(c) { return c.name === 'sendMessage'; });
    check('工具执行后继续 Agent 循环', sent.length === 1 && h8.attempts() === 1, { sends: sent.length, attempts: h8.attempts() });

    // ── S9: isTransientStreamFailure 判定表 ──
    console.log('S9: 瞬时故障判定');
    var h9 = runHarness([{ result: { type: 'text', content: 'x', reasoning: '' } }]); // 借 harness 拿到函数作用域
    // 直接从切片代码里再取一次函数做纯判定测试
    var fn = new Function(itsf + ';return isTransientStreamFailure;')();
    check('网络错误可重试', fn(netErr) === true);
    check('无 status 的 Error 可重试', fn(new Error('boom')) === true);
    check('null（空响应）可重试', fn(null) === true);
    check('AbortError 不可重试', fn({ name: 'AbortError' }) === false);
    [400, 401, 402, 403, 404, 422].forEach(function(s) { check('HTTP ' + s + ' 不可重试', fn({ name: 'Error', status: s }) === false); });
    [408, 429, 500, 502, 503, 529].forEach(function(s) { check('HTTP ' + s + ' 可重试', fn({ name: 'Error', status: s }) === true); });
    check('noRetry 明确错误（网关 200+HTML/200+JSON）不可重试', fn({ name: 'Error', message: 'x', noRetry: true }) === false);

    // ── S10：网关 200+HTML / 200+JSON 的 noRetry 应答 → 不进重试，直接呈现 ──
    console.log('S10: noRetry 明确错误跳过重试');
    var h10 = runHarness([
        { result: { type: 'error', error: { name: 'Error', message: '端点返回了网页而非对话接口（HTTP 200 + text/html）', noRetry: true } } },
        { result: { type: 'text', content: '不该到达', reasoning: '' } }
    ]);
    check('noRetry 不发起第二次请求', h10.attempts() === 1, h10.attempts());
    check('noRetry 报错直接呈现', h10.chatHistory.length === 1 && h10.chatHistory[0].content === 'Error: 端点返回了网页而非对话接口（HTTP 200 + text/html）', h10.chatHistory);
    check('noRetry 后无挂起重试任务', h10.clock.pending() === 0);

    console.log(failures === 0 ? '\n全部通过 ✓' : '\n失败 ' + failures + ' 项 ✗');
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(function(e) { console.error(e); process.exit(1); });
