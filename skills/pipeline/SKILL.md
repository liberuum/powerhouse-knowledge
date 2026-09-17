---
name: pipeline
description: Run the knowledge processing pipeline on a source or batch of notes. Chains extract -> connect -> reweave -> verify phases with handoff tracking. Use when processing source material end-to-end or advancing notes through the pipeline.
---

# Processing Pipeline

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Carry a source through to connected, verified notes in the MoC hierarchy. The
six R names (Record, Reduce, Reflect, Reweave, Verify, Rethink) are the
vocabulary; the `bai/pipeline-queue` task underneath has **four phases**:

```
CREATE (extract claims) → REFLECT (typed edges) → REWEAVE (MoC placement + backward pass) → VERIFY (quality gate, lifecycle)
```

Record (`/seed`) happens before the task exists; Rethink (`/health`, `/graph`)
after it completes. Each phase is one skill; this skill drives them and keeps
the queue honest.

## Pre-flight

- **Methodology on disk.** The 249 claims ship as `data/methodology.tar.gz`; the
  unpacked directory is gitignored. `ls data/methodology/*.md | wc -l` should
  print 249; if not, `node scripts/methodology.mjs`.
- **Queue and target.** From `switchboard docs tree <drive-slug> --format json`
  find the `bai/pipeline-queue` singleton (`/ops/queue/`), then read it:

```bash
switchboard docs get <pipeline-queue-id> --state --format json | python3 -c "
import json,sys; g=json.load(sys.stdin)['state']['global']
print([(t['id'][:8], t['status'], t.get('currentPhase'), t.get('documentRef')) for t in g['tasks'] if t['status'] in ('PENDING','IN_PROGRESS','BLOCKED')])"
```

Process `PENDING` tasks that carry a `documentRef`; the source document always
has the latest content. Before adding a task for a document, check no
non-DONE/FAILED task already references it.

## Working discipline

- **One source per run, phases in order.** Extraction needs the sharpest
  attention; run it first, verification last. Do not chain unrelated sources
  through one context — batch by topic similarity, three to five per session
  at most, and prefer a fresh session per source when you can.
- **No phase exits without its artifact.** Advancing is a claim that the work
  exists; the gates below say what must be true, verified by read-back.
- **Handoffs are packets and closures.** `workDone` tells the next phase what
  was done, what was learned, what is definitively finished and what remains.
  A handoff that is a timestamp forces the next session to reconstruct.

| Phase | Skill | Exit gate (all true, read back) |
|---|---|---|
| `create` | extract | every note has title, description, `noteType`, content, ≥ 1 topic, provenance, `confidence`, a `DERIVED_FROM` edge with its locus; source read back with `claimCount == len(extractedClaims) == notes written` and status `EXTRACTED`/`ARCHIVED` |
| `reflect` | connect | every new note has ≥ 2 knowledge edges with specific reasons and confidence, ≥ 1 incoming; every `CONTRADICTS` has its tension read back and articulated in both notes |
| `reweave` | synthesize + backward pass | every new note is a `CORE_IDEA` (with context phrase) of a TOPIC or DOMAIN MoC; every MoC touched has its orientation re-read and updated if it would read differently today; every MoC reachable from the HUB; older notes the new claims qualify, supersede or contradict have been rewritten, linked or archived |
| `verify` | verify | every note graded; repairs applied and read back; passing notes at `CANONICAL`; health report rewritten |

## Tracking — mandatory

**Every run updates the queue.** The app's Pipeline view reads this document and
`/health` grades stuck tasks. Per phase: `ASSIGN_TASK` then `ADVANCE_PHASE`,
batched in one `docs apply` — actions run in order and a rejected one is
skipped while the rest land — then read the task back and confirm `status`,
`currentPhase` and `handoffs.length`. The CLI stamps `timestampUtcMs` and
`action.id`; never generate them.

```bash
switchboard docs apply <pipeline-queue-id> --actions '[
  {"type":"ASSIGN_TASK","input":{"taskId":"<task>","assignedTo":"<agent>","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"ADVANCE_PHASE","input":{"taskId":"<task>","handoff":{
     "id":"<fresh uuid>","phase":"create",
     "workDone":"Extracted 7 claims from 11 candidates (skipRate 0.36): 3 struck as excerpts, 1 as a bare number. Source closed EXTRACTED and read back. Reflect: note 3 looks like it contradicts <title>; notes 5–6 extend the read-model cluster.",
     "filesModified":["<note-ids>","<source-id>"],"completedAt":"<ISO>","completedBy":"<agent>"},
   "updatedAt":"<ISO>"},"scope":"global"}
]'
```

### The queue contract

**`ADD_TASK`** — once per source, at `/seed` time (REST `POST sources` does it).

| Field | Rule |
|---|---|
| `id` | Fresh UUID per task. A repeated id throws `DuplicateTaskIdError` (since 2026-09-14) |
| `taskType` | `claim` (`create → reflect → reweave → verify`) or `enrichment` (`enrich → …`). Anything else → `UnknownTaskTypeError` |
| `target` | The source's title — the only human-readable label the Pipeline view has |
| `documentRef` | The source id. Optional in the schema, **always set it** — it is how a document's task is found, how duplicates are avoided, how `/health` tells a stranded source from a queued one |
| `batchId` | Set when one origin (a book, a docs sweep) yields several tasks |
| `currentPhase` | **Omit.** The reducer takes the first phase of `taskType`; a value outside its phases → `InvalidPhaseError` |
| `createdAt` | ISO UTC `Z` |

**Transitions** — all take `taskId` (unknown → `TaskNotFoundError`) and `updatedAt` (real clock; written to `task.updatedAt`, and to `lastProcessedAt` by every op except BLOCK/UNBLOCK).

| Op | Rule |
|---|---|
| `ASSIGN_TASK { assignedTo }` | Sets `IN_PROGRESS`. Throws `TaskAlreadyAssignedError` if already assigned — once per phase; `ADVANCE_PHASE` clears it, `FAIL_TASK` does **not** |
| `ADVANCE_PHASE { handoff }` | `handoff.id` fresh UUID; `phase` the one you finished (must equal `currentPhase` → `PhaseMismatchError`); `workDone` the packet; `filesModified` the ids touched (`[]` only if truly none); `completedAt`; `completedBy`. `learnings` is unwritable — put learnings in `workDone` |
| `COMPLETE_TASK` | Only to end a task **early**. Rejected on a `DONE`/`FAILED` task (`InvalidTaskStatusError`) |
| `RECONCILE_COUNTERS { updatedAt }` | Recomputes `completedCount` (DONE tasks) and `activeCount` (PENDING/IN_PROGRESS/BLOCKED) from the tasks. Idempotent; the only legitimate repair for drifted counters |
| `FAIL_TASK { reason }` / `BLOCK_TASK { reason }` | `reason` is **not written to state** — it survives only in the operation log; put what the next agent needs in the previous handoff. `UNBLOCK_TASK` throws `InvalidTaskStatusError` unless `BLOCKED` |

### Traps

1. **A rejected `ADD_TASK` in a batch redirects the rest.** `docs apply` isolates
   failures, so `[ADD_TASK, ASSIGN_TASK, ADVANCE_PHASE]` with a duplicate id
   skips the add and the next two act on the **pre-existing** task. Mint a fresh
   UUID, check `documentRef` first, read back.
2. **Terminal is terminal.** Since 2026-09-17 the reducer refuses to advance,
   complete, fail or block a `DONE`/`FAILED` task (`InvalidTaskStatusError`), so
   `completedCount`/`activeCount` cannot be double-counted and a `DONE` task is
   no longer resurrected at phase 0. A `FAILED` task is retried with a **new**
   task. A queue whose `completedCount` exceeds its task count was damaged
   before the guard; dispatch `RECONCILE_COUNTERS` to recompute both counters
   from the tasks (`switchboard docs mutate <queue-id> --op reconcileCounters --input '{"updatedAt":"<ISO>"}'`).
3. **`ADVANCE_PHASE` checks the handoff.** `handoff.phase` must equal the task's
   `currentPhase` (`PhaseMismatchError`); a handoff for the wrong phase used to
   be recorded and the task advanced anyway.

## The run

**1 — CREATE.** `/powerhouse-knowledge:extract` on the `documentRef`. The gate
above is extract's *Before you advance*; the source close-out is the step most
often missed when a pipeline is driven by script instead of by skill.

**2 — REFLECT.** `/powerhouse-knowledge:connect` on every new note: candidates
from the graph and from the batch itself, one specific reason per edge,
confidence on every edge, tensions read back and articulated, in-scope notes
grounded. Nothing else — MoC work is the next phase.

**3 — REWEAVE.** Two halves, both required:
- *Forward*: `/powerhouse-knowledge:synthesize` — `CORE_IDEA` with a context
  phrase for every new note, new MoCs attached to a parent in the same run,
  touched MoCs' orientation re-read.
- *Backward*: for each older note the new claims touch (the reflect handoff
  names them; `knowledgeGraphSimilar` on each new note finds the rest), ask
  **what would be different if it were written today** — and act: rewrite or
  sharpen the claim, add the condition the new note supplies, split a bundled
  note, `SUPERSEDES` + archive when it is now wrong, `CONTRADICTS` when it
  still holds against the new one. Adding a "See also" line is not reweaving.

**4 — VERIFY.** `/powerhouse-knowledge:verify` on every note from this run:
claim test, recite, schema, graph, repairs, walk to `CANONICAL` as a different
actor. Its `ADVANCE_PHASE` completes the task.

**5 — Rethink.** `/powerhouse-knowledge:health` with auto-fix, then re-run it and
rewrite the report; the dashboard shows the last one. Fix from the
recommendations (MoC gaps via `/synthesize` with an orientation — never a bare
list; descriptions; types; topics; a stranded `PENDING` task whose work is done
→ advance it through its remaining phases). Escalate only recite failures,
genuine tensions and decisions that are not yours.

**Failures.** `FAIL_TASK` when the run cannot finish (the reason goes in the log
and the previous handoff), `BLOCK_TASK` when it needs a human, `UNBLOCK_TASK`
to resume. A source that yields zero claims is **not** a failure — close it out
and advance.

## Batch of sources

Check the queue for every `PENDING` task; process each through all four phases;
verify drive nodes after each; report once:

```
=== PIPELINE COMPLETE ===
Sources: N | Claims: N (skipRate per source: …) | Struck: N (why, in one line each)
Edges: N (N BUILDS_ON, N CONTRADICTS → N tensions, N SUPERSEDES, N RELATES_TO) | Grounded: N of N in scope
MoCs: N created, N updated, unreachable 0 | Older notes reworked: N
Verify: N CANONICAL, N left DRAFT (why) | Health: before WARN (3) → after PASS (0)
Queue: task <id> DONE via final advance; activeCount N, completedCount N
```

If "$ARGUMENTS" is provided, treat it as the source or note to process.
