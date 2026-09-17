---
name: health
description: Check remote vault health — orphan notes, dangling links, graph density, methodology grounding, MOC coverage, processing stats. Saves results to the bai/health-report document. All checks run against the live reactor over REST or the Switchboard CLI.
---

# Vault Health Check

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Rethink: measure the vault's structure against what a healthy graph looks like,
write the snapshot to the `bai/health-report` singleton the dashboard renders,
and — with `--fix` or from the pipeline — repair what can be repaired, then
measure again. Detection only reads and is always safe; every grade is derived
from a measured number, never typed in; every PASS is read back, never assumed.
**A truthful WARN is worth more than a fabricated PASS.**

## 1. Pre-flight

```bash
switchboard config show && switchboard ping
switchboard drives list --format json | python3 -c "
import json,sys
for d in json.load(sys.stdin):
    nodes = d.get('nodes', d.get('state',{}).get('global',{}).get('nodes',[]))
    if any(n.get('documentType')=='bai/vault-config' for n in nodes): print(d['slug'], d['id'], d['name'])"
switchboard docs tree <drive-slug> --format json      # note the bai/health-report id (/ops/health/) and bai/pipeline-queue id (/ops/queue/)
```

## 2. Gather — one request, then compute

Do not read notes one by one; the index carries every field the checks need:

```bash
switchboard query "{
  stats:    knowledgeGraphStats(driveId:\"$D\"){ nodeCount edgeCount orphanCount noteCount mocCount claimCount tensionCount openTensionCount observationCount articulatedEdgeCount }
  density:  knowledgeGraphDensity(driveId:\"$D\")
  orphans:  knowledgeGraphOrphans(driveId:\"$D\"){ documentId title noteType status }
  mocs:     knowledgeGraphNodesByStatus(driveId:\"$D\", status:\"MOC\"){ documentId title noteType }
  stale:    knowledgeGraphStale(driveId:\"$D\", since:\"<ISO 30 days ago>\", limit:500){ documentId status }
  nodes:    knowledgeGraphNodes(driveId:\"$D\"){ documentId title description status noteType documentType topics content }
  tensions: knowledgeGraphNodesByType(driveId:\"$D\", documentType:\"bai/tension\"){ documentId title status }
  edges:    knowledgeGraphEdges(driveId:\"$D\"){ sourceDocumentId targetDocumentId linkType reason confidence }
}" --format json > /tmp/health.json
```

Plus the queue and every `bai/source` by id (`docs get --state`) — neither is
indexed.

Rules that keep the numbers honest:

- **Count by kind.** `nodeCount` is every indexed kind (notes, MoCs, claims,
  tensions, observations, scopes, WBS). Every per-note ratio uses
  `stats.noteCount` or `nodes` filtered by `documentType`.
- **Orphan** = a live note with zero **incoming** edges — what `orphans` returns,
  minus MoCs (an orphan MoC is a hierarchy defect, reported under the hierarchy)
  and minus `ARCHIVED` notes (retiring a note *is* removing its citations; say
  how many you excluded). Outgoing links change nothing.
- **Edges** come from `edges`, never from a note's legacy `links[]`.
  `averageLinksPerNote = stats.edgeCount / stats.noteCount`.
- **Articulation coverage** = `stats.articulatedEdgeCount / stats.edgeCount`.
  Absent on a pre-1.0.36 Switchboard — say so rather than reporting 0%.
- **MoC coverage** = share of notes that are the target of a `CORE_IDEA` edge;
  **context-phrase coverage** = share of `CORE_IDEA` edges with a `reason`.
  **Hierarchy**: every MoC but one (the HUB) has exactly one incoming
  `CHILD_MOC`.
- **Open tensions** = `stats.openTensionCount`. One opened by `graph-indexer`
  still needs a human to resolve or dissolve it, so it counts.
- **Descriptions**: missing fails; < 80 UTF-16 units is terse; > 200 cannot
  exist in state, so a missing one is often a rejected over-long attempt.
  Restatement (> 70% of the title's words) is a quality WARN — a description
  that paraphrases its title is not a retrieval filter.
- **Stale** = `stale` entries with `status = "DRAFT"`; report the DRAFT share in
  `recommendations` — a vault that is mostly DRAFT has never been verified.
- **Stranded source** = a `bai/source` in `INBOX`/`EXTRACTING` with notes derived
  from it (`extractedClaims` or `DERIVED_FROM` backlinks). Invisible to the task
  check because its task may be DONE; repair with extract § *Close out*.
- **Grounding**: a note is grounded if its content has a `## Grounding` section
  citing a methodology claim. Size the **in-scope** set first — notes about
  knowledge work, agent cognition, documentation or retrieval (a few
  `knowledgeGraphSemanticSearch` probes; ≥ 0.80 similarity) — and report
  `grounded / in-scope`, never `grounded / all notes`. A vault of software
  internals will never legitimately reach 100%, and inventing groundings to
  move the number is a fabricated link.

## 3. Grade — derive every status from the table

| Category | PASS | WARN | FAIL |
|---|---|---|---|
| `SCHEMA_COMPLIANCE` | all notes: title, `noteType`, provenance | any missing (the dashboard never grades this FAIL) | — |
| `ORPHAN_DETECTION` | 0 live orphans | 1–3 | 4+ |
| `LINK_HEALTH` | avg ≥ 2.0 links/note | ≥ 1.0 | < 1.0 |
| `DESCRIPTION_QUALITY` | all present and informative | 1–2 missing or restated | 3+ missing |
| `MOC_COHERENCE` | every note has ≥ 1 topic | 1–3 without | 4+ without |
| `THREE_SPACE_BOUNDARIES` | 0 open tensions | 1–3 | 4+ |
| `PROCESSING_THROUGHPUT` | 0 pending observations, stuck tasks, stranded sources | 1–5 pending observations, or 1–2 stuck tasks / stranded sources | > 5 pending observations, or 3+ stuck/FAILED tasks or stranded sources |
| `STALE_NOTES` | 0 DRAFT notes > 30 days | 1–3 | 4+ |

`overallStatus` = the worst check. The grades match the in-app dashboard's own
rules — `MOC_COHERENCE` is *notes without topics*, not clusters without a MoC;
grading differently would make `/health` and the app disagree on the same
vault — so what the dashboard cannot grade goes in the **message** and in
`recommendations`: articulation coverage and the notes holding most bare edges
(`LINK_HEALTH` message: `Avg 2.4 links/note; 1,180 of 2,257 edges (52%) carry a
reason`), MoC coverage, context-phrase coverage, unreachable MoCs, grounding
`grounded / in-scope`, DRAFT share. A vault with 100% link density and 0%
reasons is an address book; the report must say so while `LINK_HEALTH` shows
PASS.

The tell that grading went wrong: metrics and grades disagreeing in one
document — `orphanCount: 1` beside a green `ORPHAN_DETECTION`.

## 4. Write the report

Two operations, one contract. `GENERATE_REPORT` **first** — it resets `checks`
to `[]`, so an `ADD_CHECK` sent before it is wiped — then eight `ADD_CHECK`s.
Write both to files and `docs apply --file`.

**`GENERATE_REPORT`** — every field required except `generatedBy` (write it anyway):
`generatedAt` (this run's clock — a copied timestamp makes a fresh run look
stale), `generatedBy`, `mode` (`full` | `quick` — the app keys on those two),
`overallStatus` (derived), `graphMetrics` (all eight `Int!`/`Float!` below),
`recommendations` (`[String!]!`, `[]` when nothing is open).

| `graphMetrics` | Source |
|---|---|
| `noteCount` | `stats.noteCount` — never `nodeCount` |
| `mocCount` | `stats.mocCount` |
| `connectionCount` | `stats.edgeCount` |
| `density` | `knowledgeGraphDensity`, 0–1 |
| `orphanCount` | live orphans, as computed above |
| `danglingLinkCount` | `edges` whose `targetDocumentId` matches no node — measured, never a placeholder 0 |
| `mocCoverage` | share of notes with a `CORE_IDEA` incoming, 0–1 |
| `averageLinksPerNote` | `stats.edgeCount / stats.noteCount` |

**`ADD_CHECK`** × 8 — `id` fresh UUID per check per run (no duplicate guard;
a reused id renders twice), `category` from the eight above (there is no
ninth), `status` `PASS` | `WARN` | `FAIL`, `message` carrying the **measured
number** (`"Link health OK" tells the reader nothing the colour did not`),
`affectedItems` the document ids to open (`[]` on PASS, never omitted).

Two silent-failure traps: an `undefined` field is dropped from the JSON and the
reducer then rejects the **whole action** — one mistyped source name leaves
`GENERATE_REPORT` unapplied while every `ADD_CHECK` lands, so the document holds
old metrics and two runs' worth of checks; and a typo'd `category` is rejected
by the generated validator before the reducer runs, so the check is simply
absent. Assert every value is defined before dispatch, then re-read:
`generatedAt` is this run's and the check count is exactly eight.

There is no `METHODOLOGY_GROUNDING` category. Do **not** file grounding under
`THREE_SPACE_BOUNDARIES` — the app renders tension-specific remediation copy
for it. Grounding goes in `recommendations`.

### `recommendations` — open actions only

Each names the action and where to do it, and is dropped once done (the next
run replaces the list wholesale). Not status, not a changelog (the operation
history is the changelog), not design rationale, not anything already fixed.

## 5. Repair (`--fix`, or always from the pipeline), then measure again

Two drifts have a dedicated, auditable repair — use these, never a database edit:

| Finding | Repair |
|---|---|
| Queue `completedCount` > DONE tasks, or `activeCount` ≠ live tasks (history predates the status guards) | `RECONCILE_COUNTERS { updatedAt }` on the queue — recomputes both from the tasks |
| Source `extractionStats.claimCount` ≠ `len(extractedClaims)` (stats recorded before the invariant) | `node scripts/repair-source-stats.mjs --drive <uuid>` in the model repo: dry run lists every mismatch, `--apply` re-records with `claimCount = len(extractedClaims)`, `skippedCount` kept, `skipRate` recomputed |
| `noteType` outside the `NoteType` enum (drive predates the enum) | `node scripts/migrate-note-type.mjs --drive <uuid>` — see its runbook |

Sources that are `EXTRACTED` with **no** stats are reported, not repaired: inventing a
`skippedCount` would be a lie. Duplicate singletons (two pipeline queues, two health
reports, two vault configs in one drive) are a finding for a human — deleting a queue
deletes its handoff history.

| Finding | Fix |
|---|---|
| Notes without description / type / topics / provenance | `/verify` on them — it writes from the content and the operation history, counting UTF-16 |
| Bare edges | `/connect` — `docs annotate` with a real reason, or `docs unlink` |
| Topic clusters (3+ notes) without a MoC; notes without `CORE_IDEA`; unreachable MoCs | `/synthesize` — with a written orientation and a context phrase per member. A MoC created as a bare list to move the coverage number is the hollow map the methodology warns about |
| Stranded sources | extract § *Close out* — `ADD_EXTRACTED_CLAIM` per note, `RECORD_EXTRACTION_STATS`, `EXTRACTED` |
| Stranded `PENDING` task whose work is done | `ADVANCE_PHASE` through the remaining phases; the final advance completes it (never `COMPLETE_TASK` after it) |
| Stale DRAFT notes | `/verify` walks the passing ones to `CANONICAL` as a different actor |
| Open tensions | Read, then resolve or dissolve with the reasoning written into both notes (`/connect` § *Tensions*). A defect filed as a tension is dissolved, not left open |

Repair is judgment; detection is not. Fix what you can read and state; report
what needs the source or a human. After fixing, **re-run the whole check and
rewrite the report** — the dashboard shows the last snapshot, and a repair after
a run leaves the user looking at problems already fixed. Report before/after.

## 6. Report to the user

```
=== VAULT HEALTH ===
Server: <profile> (<url>) | Drive: <name> (<slug>) | Saved to: bai/health-report <id>
Notes N | MoCs N (1 HUB, N unreachable) | Edges N | Density N | Avg links/note N | Reasons N/N (N%) | MoC coverage N% | Grounded N/N in scope

PASS  SCHEMA_COMPLIANCE       All N notes have title, type, provenance
WARN  ORPHAN_DETECTION        2 live orphans (3 archived excluded): <titles>
PASS  LINK_HEALTH             Avg 2.4 links/note; 1,180 of 2,257 edges (52%) carry a reason
…
Overall: WARN
Recommendations:
  1. Articulate 1,077 bare edges — start with <note> (41) and <note> (37), via /connect
  2. Create a MoC for 'document-toolbar' (5 notes) via /synthesize
```

Standalone: `--fix` repairs, otherwise report only; `quick` / `full` set `mode`.
From the pipeline: always fix, then re-run. Previous snapshots live in the
document's operation history.

If "$ARGUMENTS" is provided, treat it as mode (`--fix`, `quick`, `full`) or a specific note ID to check.
