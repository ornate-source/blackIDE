import { useEffect, useReducer } from 'react';
import { OfficeView } from './OfficeView';
import { EMPTY_OFFICE, reduceOffice } from './office-state';
import { rawVscode } from './webview-bridge';

// ─── The Front Desk — the Office in the sidebar (M73) ───────────────────────
//
// The same floor as the editor tab, in ~46 columns, beside the work rather than on top of
// it. That is the entire reason it exists: checking on your agents should not cost you the
// file you were reading, and until this view there was no way to check that did not.
//
// ── What this component is allowed to decide ─────────────────────────────────
// Almost nothing. It owns a message listener, a reducer it did not write, and two
// hand-offs. Every question about *what a run is doing* is answered by `office-model.ts`
// and rendered by `OfficeView`, which already responds to its container's width — so the
// sidebar is a narrower viewport onto the same projection rather than a second opinion
// about it. The three surfaces that drifted apart before the Office existed all began as
// a reasonable-looking second renderer.
//
// M75 replaces the body below with the purpose-built Front Desk of §7.2 — inbox first,
// ordered by `buildInbox`, with per-reason action rows. This is the shell that gets it
// registered, visible and wired.

const vscode = rawVscode || {
  postMessage: (msg: any) => console.log('VSCode PostMessage (mock):', msg),
};

export default function FrontDesk() {
  const [office, dispatch] = useReducer(reduceOffice, EMPTY_OFFICE);

  useEffect(() => {
    // One message on mount carries the whole floor; everything after it is a patch.
    vscode.postMessage({ type: 'listOffice' });

    const handleMessage = (event: MessageEvent) => dispatch(event.data);
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="flex-1 overflow-y-auto p-2">
        <OfficeView
          office={office.snapshot}
          files={office.files}
          post={vscode.postMessage}
          /*
           * The journal opens in the Manager panel, not here.
           *
           * A log reader wants width — timestamps, verbs, targets and durations in
           * columns — and rendering one in a sidebar would mean wrapping every line,
           * which is how a record becomes unreadable. The host opens the Logs tab on
           * this run.
           */
          onOpenLogs={(runId) => vscode.postMessage({ type: 'openRunLogs', value: { runId } })}
        />
      </div>

      {/*
        * The way out.
        *
        * Two things genuinely do not fit in a sidebar — the files-in-play table and the
        * logs — and both live on the Office tab. Stated as a footer rather than left to
        * be discovered through the command palette: a surface that is a subset of another
        * one owes the user a pointer to the whole.
        */}
      <div className="shrink-0 border-t border-border/40 px-2 py-1.5 flex justify-end">
        <button
          onClick={() => vscode.postMessage({ type: 'openOfficeTab' })}
          className="px-2 py-1 rounded text-[10.5px] text-muted/70 hover:text-foreground hover:bg-panel/50 cursor-pointer transition-colors"
        >
          Office ▸
        </button>
      </div>
    </div>
  );
}
