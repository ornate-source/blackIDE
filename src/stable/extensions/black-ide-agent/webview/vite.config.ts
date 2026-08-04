import * as path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    /*
     * The vscode-free core, resolved to its **source** (M74).
     *
     * The webview has always declared its own copies of the shapes it renders —
     * `RunSummary`, `TaskAgentSummary`, `InboxItem` are all duplicated in
     * `ManagerPanel.tsx` — which was tolerable while they were four fields each. The
     * Office renders a *projection* (`office-model.ts`) whose whole purpose is that one
     * place decides what a run is doing, and a second hand-maintained copy of that shape
     * is precisely the drift it exists to prevent.
     *
     * Only the pure core is reachable this way. Nothing under `src/` is, so a webview
     * import cannot accidentally pull in `vscode`, and the modules it does reach — the
     * projection, the narrator, the inbox, the governor — have no node builtins and tree-
     * shake to what is used. Same target as `vitest.config.ts`, deliberately: a shape
     * tested in one runner and bundled from another must not be two files.
     */
    alias: [
      { find: /^@blackide\/agent-core\/(.*)$/, replacement: path.resolve(__dirname, '../packages/agent-core/src') + '/$1' },
    ],
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});
