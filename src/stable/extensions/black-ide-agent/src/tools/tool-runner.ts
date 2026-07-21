import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommandResult, GrepResult } from '../core/types';

// Local File System & Terminal Tool Runners
// Enhanced with: terminal output capture (Feature 1), grep search (Feature 3), list directory (Feature 4)
export class ToolRunner {

    // ─── File Operations ────────────────────────────────────────────────

    public static async readFile(filePath: string, startLine?: number | null, endLine?: number | null): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open');

        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
        if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${filePath}`);

        const content = fs.readFileSync(absolutePath, 'utf8');
        if (startLine !== undefined && startLine !== null) {
            const lines = content.split(/\r?\n/);
            const start = Math.max(0, startLine - 1);
            const end = endLine !== undefined && endLine !== null ? Math.min(lines.length, endLine) : lines.length;
            return lines.slice(start, end).join('\n');
        }
        return content;
    }

    public static async writeFile(filePath: string, content: string): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open');

        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);

        // Ensure parent directory exists
        const parentDir = path.dirname(absolutePath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(absolutePath, content, 'utf8');
        return `Successfully wrote file to ${filePath}`;
    }

    // ─── Terminal Execution — Feature 1: Output Capture ─────────────────

    /**
     * Execute a command, streaming stdout/stderr as they arrive and returning the
     * captured result. `onChunk` is what makes a long build or test run watchable
     * instead of a silent wait followed by a wall of text.
     */
    public static async executeCommand(
        command: string,
        cwd?: string,
        timeoutMs: number = 30000,
        signal?: AbortSignal,
        onChunk?: (stream: 'stdout' | 'stderr', text: string) => void
    ): Promise<CommandResult> {
        const { spawn } = require('child_process');
        const rootPath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

        // Cross-platform shell: cmd.exe on Windows, /bin/sh elsewhere.
        const isWin = process.platform === 'win32';
        const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
        const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

        return new Promise((resolve) => {
            const proc = spawn(shell, shellArgs, {
                cwd: rootPath,
                env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
                // On Unix, start a new process group (pgid == child pid) so that on
                // cancel we can signal the whole tree — the shell plus every grandchild
                // it spawned (compilers, dev servers) — instead of orphaning them.
                detached: !isWin,
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            let timedOut = false;

            const maxLen = 10240;
            const cap = (s: string) => s.length > maxLen ? s.slice(0, maxLen) + `\n... (truncated, total: ${s.length} chars)` : s;

            const finish = (code: number | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve({ stdout: cap(stdout), stderr: cap(stderr), exitCode: code ?? 1, timedOut });
            };

            // Kill the entire process group, not just the shell, so no grandchild
            // (dev server, compiler, watcher) is left orphaned after a cancel/timeout.
            const onAbort = () => {
                const pid = proc.pid;
                if (isWin) {
                    // /T terminates the process tree, /F forces it.
                    if (pid) { try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)]); } catch {} }
                    try { proc.kill('SIGKILL'); } catch {}
                    return;
                }
                // Negative pid targets the whole process group created by detached spawn.
                try { if (pid) process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
            };
            const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
            if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort);
            }

            // Stream to the UI as it arrives; the captured copy (fed back to the model)
            // is still capped, but the user sees the whole thing live.
            proc.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                try { onChunk?.('stdout', text); } catch {}
            });
            proc.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                try { onChunk?.('stderr', text); } catch {}
            });
            proc.on('error', (err: Error) => { stderr += `\nCommand execution failed: ${err.message}`; finish(1); });
            proc.on('close', (code: number | null) => finish(code));
        });
    }

    /**
     * Fire-and-forget terminal execution (for commands that need user-visible terminal UI).
     * Falls back to old behavior when output capture isn't needed.
     */
    public static async executeCommandInTerminal(command: string): Promise<string> {
        const terminal = vscode.window.createTerminal('Black IDE Agent Executor');
        terminal.show(true);
        terminal.sendText(command);
        return `Sent command to terminal: ${command}`;
    }

    // ─── Feature 3: Regex-Aware Grep Search ─────────────────────────────

    public static async grepSearch(
        query: string,
        searchPath?: string,
        options?: { isRegex?: boolean; caseInsensitive?: boolean; includes?: string[] }
    ): Promise<GrepResult[]> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open');

        const targetPath = searchPath
            ? (path.isAbsolute(searchPath) ? searchPath : path.join(rootPath, searchPath))
            : rootPath;

        const results: GrepResult[] = [];
        const pattern = options?.isRegex ? new RegExp(query, options.caseInsensitive ? 'gi' : 'g') : null;
        const lowerQuery = options?.caseInsensitive ? query.toLowerCase() : query;

        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(targetPath, '**/*'),
            '**/node_modules/**',
            500
        );

        for (const uri of uris) {
            try {
                // Skip binary files by checking for null bytes in first 512 bytes
                const fd = fs.openSync(uri.fsPath, 'r');
                const buf = Buffer.alloc(512);
                fs.readSync(fd, buf, 0, 512, 0);
                fs.closeSync(fd);
                if (buf.includes(0)) continue;

                const content = fs.readFileSync(uri.fsPath, 'utf8');
                const lines = content.split(/\r?\n/);

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const match = pattern
                        ? pattern.test(line)
                        : (options?.caseInsensitive ? line.toLowerCase().includes(lowerQuery) : line.includes(query));

                    // Reset regex lastIndex for global flag
                    if (pattern) pattern.lastIndex = 0;

                    if (match) {
                        results.push({
                            file: vscode.workspace.asRelativePath(uri),
                            line: i + 1,
                            content: line.trim().slice(0, 200)
                        });
                    }
                }
            } catch {
                // skip unreadable/binary files
            }

            if (results.length >= 50) break;
        }

        return results;
    }

    // ─── Feature 4: List Directory ──────────────────────────────────────

    public static async listDirectory(dirPath: string): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open');

        const absolutePath = path.isAbsolute(dirPath) ? dirPath : path.join(rootPath, dirPath);
        if (!fs.existsSync(absolutePath)) throw new Error(`Directory not found: ${dirPath}`);

        const stat = fs.statSync(absolutePath);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

        const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
        const result = entries
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
            .sort((a, b) => {
                // Directories first, then files
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            })
            .map(e => {
                if (e.isDirectory()) {
                    try {
                        const children = fs.readdirSync(path.join(absolutePath, e.name)).length;
                        return `📁 ${e.name}/ (${children} items)`;
                    } catch {
                        return `📁 ${e.name}/`;
                    }
                } else {
                    try {
                        const stats = fs.statSync(path.join(absolutePath, e.name));
                        const sizeKB = (stats.size / 1024).toFixed(1);
                        return `📄 ${e.name} (${sizeKB} KB)`;
                    } catch {
                        return `📄 ${e.name}`;
                    }
                }
            })
            .join('\n');

        return `Contents of ${dirPath}:\n${result}`;
    }

    // ─── Search/Replace Edit Engine ─────────────────────────────────────

    public static applySearchReplace(fileContent: string, blocksStr: string): string {
        const ORIGINAL_MARKER = '<<<<<<< ORIGINAL';
        const DIVIDER_MARKER = '=======';
        const UPDATED_MARKER = '>>>>>>> UPDATED';

        let content = fileContent;
        let startIndex = 0;
        let blockCount = 0;

        while (true) {
            const origStart = blocksStr.indexOf(ORIGINAL_MARKER, startIndex);
            if (origStart === -1) break;

            const origEnd = blocksStr.indexOf(DIVIDER_MARKER, origStart);
            if (origEnd === -1) {
                throw new Error('Malformed search/replace block: Missing ======= divider');
            }

            const updatedEnd = blocksStr.indexOf(UPDATED_MARKER, origEnd);
            if (updatedEnd === -1) {
                throw new Error('Malformed search/replace block: Missing >>>>>>> UPDATED marker');
            }

            blockCount++;

            const originalCode = blocksStr.substring(origStart + ORIGINAL_MARKER.length, origEnd).replace(/^\r?\n|\r?\n$/g, '');
            const updatedCode = blocksStr.substring(origEnd + DIVIDER_MARKER.length, updatedEnd).replace(/^\r?\n|\r?\n$/g, '');

            // Apply the edit
            const matchIndex = content.indexOf(originalCode);
            if (matchIndex === -1) {
                throw new Error(`Original code block not found in the file:\n${originalCode}`);
            }

            const lastMatchIndex = content.lastIndexOf(originalCode);
            if (lastMatchIndex !== matchIndex) {
                throw new Error(`Original code block is not unique; it appears multiple times in the file:\n${originalCode}`);
            }

            content = content.substring(0, matchIndex) + updatedCode + content.substring(matchIndex + originalCode.length);

            startIndex = updatedEnd + UPDATED_MARKER.length;
        }

        if (blockCount === 0) {
            throw new Error('No valid search/replace blocks found in tool input. Format blocks as:\n<<<<<<< ORIGINAL\n...\n=======\n...\n>>>>>>> UPDATED');
        }

        return content;
    }

    // ─── Feature 6: Diagnostic Collection ───────────────────────────────

    /**
     * Collect lint/compile errors after a file edit.
     * Waits briefly for language servers to update diagnostics.
     */
    public static async collectDiagnostics(filePath: string): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
        const uri = vscode.Uri.file(absPath);

        // Open the file to trigger language server diagnostics
        try {
            await vscode.workspace.openTextDocument(uri);
        } catch { /* file may already be open */ }

        // Wait for diagnostics to update
        await new Promise(resolve => setTimeout(resolve, 1500));

        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (diagnostics.length === 0) return '';

        const errors = diagnostics
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
            .map(d => `Line ${d.range.start.line + 1}: ${d.message} [${d.source || 'unknown'}]`)
            .slice(0, 10) // cap at 10 errors
            .join('\n');

        const warnings = diagnostics
            .filter(d => d.severity === vscode.DiagnosticSeverity.Warning)
            .slice(0, 5)
            .map(d => `Line ${d.range.start.line + 1}: ${d.message} [${d.source || 'unknown'}]`)
            .join('\n');

        let result = '';
        if (errors) result += `\n⚠️ Errors:\n${errors}`;
        if (warnings) result += `\n⚡ Warnings:\n${warnings}`;
        return result;
    }
}
