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

const DIST = path.join(__dirname, 'dist');
const { CheckpointManager } = require(path.join(DIST, 'core/checkpoint-manager.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-'));
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
const edited = path.join(dir, 'edited.txt');
const created = path.join(dir, 'created.txt');
fs.writeFileSync(edited, 'line1\nline2\nline3');

const cp = new CheckpointManager(store);
cp.snapshot(edited); 
fs.writeFileSync(edited, 'line1\nLINE2-CHANGED\nline3');
cp.snapshot(created); 
fs.writeFileSync(created, 'brand new');
const txn = cp.commit('task_1', 'Refactor', dir);
console.log('Transaction committed successfully:', txn !== undefined);
