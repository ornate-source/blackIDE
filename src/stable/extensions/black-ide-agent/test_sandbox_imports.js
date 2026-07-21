const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

os.tmpdir = () => {
  const tmp = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmp)) {
    fs.mkdirSync(tmp, { recursive: true });
  }
  return tmp;
};

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

const DIST = path.join(__dirname, 'dist');
console.log('Importing llm-client...');
require(path.join(DIST, 'core/llm-client.js'));
console.log('Importing agent-loop...');
require(path.join(DIST, 'agent/agent-loop.js'));
console.log('Importing tools...');
require(path.join(DIST, 'core/tools.js'));
console.log('Importing command-policy...');
require(path.join(DIST, 'core/command-policy.js'));
console.log('Importing checkpoint-manager...');
require(path.join(DIST, 'core/checkpoint-manager.js'));
console.log('Importing tool-executor...');
require(path.join(DIST, 'agent/tool-executor.js'));
console.log('Importing context-manager...');
require(path.join(DIST, 'core/context-manager.js'));
console.log('Importing diff...');
require(path.join(DIST, 'core/diff.js'));
console.log('Importing prompt-builder...');
require(path.join(DIST, 'core/prompt-builder.js'));
console.log('Importing event-bus...');
require(path.join(DIST, 'core/event-bus.js'));
console.log('Importing session-manager...');
require(path.join(DIST, 'core/session-manager.js'));
console.log('All imports completed successfully!');
