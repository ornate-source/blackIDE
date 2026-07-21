declare const acquireVsCodeApi: any;

/**
 * Acquired exactly once per webview session — acquireVsCodeApi() throws if called a
 * second time. main.tsx imports both App.tsx (chat/settings) and ManagerPanel.tsx, so
 * whichever one called it independently would break the other; both instead import this
 * shared singleton (undefined outside a real webview, e.g. `vite dev` — callers fall
 * back to their own mock).
 */
export const rawVscode: any = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : undefined;
