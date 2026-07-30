# Retrieval corpus (Phase 3, M3/M14–M17)

A small but *realistic* multi-language service, committed as real files on disk so
`CodebaseIndex.build()` can index it through the same `vscode.workspace.findFiles`
path it uses in the extension host (see `test/vscode-stub.js`).

**Why a purpose-built corpus rather than this repo's own source.** The gold sets in
`eval/retrieval-queries.js` name specific files. Pointing them at living source would
make the metric rot every time a file is renamed, and a regression gate that fails for
unrelated reasons gets switched off. This corpus is frozen: it changes only when a
query or gold set changes, deliberately.

**Why it looks like an application and not like test data.** Recall@k is only
meaningful if the distractors are plausible. Every file here has believable imports,
naming and duplication — `order-service.ts` and `payment-service.ts` both mention
"charge", `retry.ts` and `rate-limit.ts` both mention "backoff" — so a query can be
got *wrong* by a retriever that only matches surface tokens. A corpus where the answer
is the only file containing the query word measures nothing.

Nothing here is executed. It is read as text.
