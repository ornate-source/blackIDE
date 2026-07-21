import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('CSS Quality', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const indexCssPath = path.join(projectRoot, 'webview', 'src', 'index.css');

    it('has no duplicate selectors in index.css', () => {
        const css = fs.readFileSync(indexCssPath, 'utf8');
        const selectorRegex = /^([.#][a-zA-Z][\w-]*)\s*\{/gm;
        const selectors: string[] = [];
        let match;

        while ((match = selectorRegex.exec(css)) !== null) {
            selectors.push(match[1]);
        }

        const duplicates = selectors.filter((s, i) => selectors.indexOf(s) !== i);
        expect(duplicates).toEqual([]);
    });

    it('stylelint passes with zero errors', () => {
        expect(() => {
            execSync('npm run lint:css', { cwd: projectRoot, stdio: 'pipe' });
        }).not.toThrow();
    });

    it('compilation succeeds after CSS changes', () => {
        expect(() => {
            execSync('npm run compile', { cwd: projectRoot, stdio: 'pipe' });
        }).not.toThrow();
    });
});
