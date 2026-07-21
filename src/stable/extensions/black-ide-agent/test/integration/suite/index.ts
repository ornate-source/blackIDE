// Mocha entry point, executed INSIDE the extension host by runTest.ts.

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        // Activation + a real VS Code download are slow; a per-test default of 2s would
        // produce flaky failures that say nothing about the code under test.
        timeout: 60_000,
    });

    const suiteRoot = __dirname;
    for (const file of fs.readdirSync(suiteRoot)) {
        if (file.endsWith('.test.js')) mocha.addFile(path.resolve(suiteRoot, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run(failures => {
                if (failures > 0) reject(new Error(`${failures} integration test(s) failed.`));
                else resolve();
            });
        } catch (err) {
            reject(err);
        }
    });
}
