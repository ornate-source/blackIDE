# Phase 4 — Repo Hygiene & Documentation Accuracy

**Defects:** B7 (committed `tmp/` fixtures) + the two 🟡 doc-accuracy items from the audit.
**Ship gate:** Recommended. Fully independent — can land any time, including first.

---

## 4.1 — Untrack test-fixture artifacts (B7)

- **Evidence:** `git ls-files` shows **125 tracked files** under
  `src/stable/extensions/black-ide-agent/tmp/` — harness leftovers (`tmp/ckpt-*/keep.txt`,
  `tmp/txn-*/*.txt`). (`test/tmp/`, `node_modules/`, `dist/`, `.npm-cache/`, `.vscode-test/` are
  correctly ignored; only `tmp/` slipped through.)
- **How:**
  1. `git rm -r --cached src/stable/extensions/black-ide-agent/tmp`
  2. Add `tmp/` to the extension's ignore rules next to the existing `test/tmp/` entry.
  3. **Prevent recurrence:** point the harness's scratch root at `test/tmp/` (already ignored)
     instead of `tmp/`. Grep the test harness for where it mkdtemps `ckpt-`/`txn-`/`sandbox-`
     prefixes and redirect the base dir. This is the real fix — without it the files come back.
  4. Verify: `git status` clean after a full `npm test` run.
- **Risk:** none — these are transient scratch files, not fixtures any test reads back.

---

## 4.2 — Fix README "SQLite vector embeddings" claim (doc drift)

- **Evidence:** README §"Semantic Codebase Indexing" says *"backed by SQLite vector embeddings."*
  The code persists to **JSON (`codebase-index.json`) + a binary `vectors.bin`**
  (`core/codebase-index.ts:287-291,383-387`) — there is no SQLite anywhere in the extension.
- **How:** update the README to describe the actual persistence: an on-disk JSON chunk store with a
  companion binary vector file, embeddings fused with BM25 via Reciprocal Rank Fusion. Keep the
  AST-aware-chunking description — that part is accurate.
- **Why it matters:** the feature works; only the description is wrong. Contributors reading "SQLite"
  will look for a schema that doesn't exist.

---

## 4.3 — Reconcile the "eight built-in modes" count (doc drift)

- **Evidence:** README says *"Eight built-in modes"* and lists Ask, Plan, Agent, Frontend, Backend,
  DevOps, Manager, Sr Architect. The loader ships **11** (`core/mode-loader.ts:107+`) — the three
  extra (`Sr Architect HLD`, `Sr Engineer LLD`, `Planner`) are internal pipeline-phase modes.
- **How:** either
  - clarify in the README that there are **8 user-selectable modes plus 3 internal pipeline-phase
    modes**, or
  - mark the three internal modes so they don't surface in the mode picker if they aren't meant to
    be user-facing (check `openModeSelector` in `extension.ts:659` — it lists `getAllModes()`, which
    today would show all 11).
- **Decision:** confirm whether HLD/LLD/Planner *should* appear in the user's mode picker. If not,
  filter them out of the picker and keep the README at "eight". If yes, update the README to 11.

---

## Test strategy

- 4.1: `npm test` then `git status` — working tree must be clean (no new `tmp/` files).
- 4.2/4.3: documentation only; no code test. If 4.3 filters the picker, add a harness assertion that
  `getAllModes()`-for-picker excludes the internal phase modes.

## Acceptance criteria

1. `tmp/` is untracked, ignored, and does not reappear after a full test run.
2. README's indexing description matches the actual JSON+`vectors.bin` persistence.
3. The mode count in the README matches what the picker actually shows.
4. `../missing-and-broken-features.md` B7 and both 🟡 doc items flipped/struck.
