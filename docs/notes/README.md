# `docs/notes/` — who owns what

Five documents. Each owns one question, and **no fact should appear in two of them.** That rule is
written down because it was broken: until 2026-08-04 three files carried a capability inventory
(`plan.md` Part 1, `enhancement.md` §1, `features.md`), they were regenerated on different cadences,
and the two that were not canonical drifted into claiming the code graph and git-history search did
not exist months after they shipped.

| Document | Answers | Regenerate when |
|---|---|---|
| **[`features.md`](./features.md)** | *What does Black IDE do, and how good is each part?* Per-capability **Status** and **Level**. **Canonical** — where another doc disagrees, this one is right. | Any feature lands or changes maturity. |
| **[`pending-tasks.md`](./pending-tasks.md)** | *What is open, in what order, blocked by what?* Organised by phase, with acceptance criteria. **Canonical for open work.** | Any task closes or is re-audited. |
| **[`enhancement.md`](./enhancement.md)** | *Where do we stand against competitors, what is the complete gap inventory (§3), and what is the phase plan (§4)?* Plus the revision log (§6). | A phase closes, or a competitor read changes. |
| **[`eval-baseline.md`](./eval-baseline.md)** | *What did the harness measure, and against what?* The recorded Phase-0 baseline, plus a today's-numbers table at the top. | A metric moves. |
| **[`plan.md`](./plan.md)** | *How does the skills subsystem work and why is it built that way?* A **delivered design record**, not a status document. | Only if the skills design changes. |

## Rules that keep them from drifting

1. **One inventory.** New capability → a row in `features.md`. Do not restate its grade elsewhere;
   link to it.
2. **Numbers come from a run, not from the previous revision.** Every headline figure in this folder
   should be reproducible with `npm test`, `npm run test:unit` and `npm run eval` in
   `src/stable/extensions/black-ide-agent/`. Each doc's header states when it was last verified that
   way.
3. **A closed backlog is deleted, not archived in place.** Historical audits move to a revision log
   (`enhancement.md` §6) or go away. A resolved list sitting beside a live one is how the two
   disagree.
4. **Say what is missing in the row that claims the feature.** A 🟡 with no named limitation is a
   grade nobody can check.

## The one shared vocabulary

**Status** — ✅ Shipped · 🟡 Partial · 🧪 Built but default-off · 📋 Planned · ⬜ Deliberate
non-feature.

**Level** — 🟢 Advanced · 🟡 Mid (real limitation, named) · 🔴 Beginning · — nothing built.
