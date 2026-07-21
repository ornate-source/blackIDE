const fs = require('fs');
const path = require('path');

const f1 = fs.readFileSync(path.join(__dirname, 'test_simple.js'), 'utf8');
const f2 = fs.readFileSync(path.join(__dirname, 'test_debug.js'), 'utf8');

const l1 = f1.split('\n');
const l2 = f2.split('\n');

let diffCount = 0;
for (let i = 0; i < Math.max(l1.length, l2.length); i++) {
  if (l1[i] !== l2[i]) {
    diffCount++;
    console.log(`Difference #${diffCount} (Line ${i + 1}):`);
    console.log(`  simple: ${JSON.stringify(l1[i])}`);
    console.log(`  debug : ${JSON.stringify(l2[i])}`);
    if (diffCount >= 20) {
      break;
    }
  }
}
