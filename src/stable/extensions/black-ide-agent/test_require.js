const path = require('path');
const { agentReducer, initialAgentState, phaseLabel, elapsedMs, pendingReview } = require(path.join(__dirname, 'test', 'agent-store.js'));

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
console.log('Reduced events successfully!');

const withCkpt = agentReducer(final, { type: 'checkpoints', value: [
  { id: 'cp1', messageId: 'task_1', label: 'x', createdAt: 1, files: [
    { path: '/a', relPath: 'a.ts', kind: 'modified', stat: '+1 -0', reviewState: 'pending' },
    { path: '/b', relPath: 'b.ts', kind: 'created', stat: '+9 -0', reviewState: 'kept' },
  ] },
] });
console.log('Checkpoint reduced successfully!');

const next = agentReducer(withCkpt, { type: 'TaskStarted', taskId: 't2', traceId: 'tr2', mode: 'ask', model: 'm', prompt: 'p', ts: 2000 });
console.log('Next task started successfully!');
