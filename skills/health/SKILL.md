---
name: health
description: Check remote vault health — orphan notes, dangling links, graph density, methodology grounding, MOC coverage, processing stats. Saves results to the bai/health-report document. All checks run against the live reactor via Switchboard CLI.
---

# Vault Health Check

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Run diagnostics against the **remote knowledge vault** via the Switchboard CLI. All data comes from the live reactor — there are no local files to scan. Results are saved to the `bai/health-report` document for the app's HealthDashboard.

## Pre-flight

1. Verify CLI connectivity:
```bash
switchboard config show
switchboard ping
```

2. Detect the vault drive (look for `bai/vault-config`):
```bash
switchboard drives list --format json | python3 -c "
import json, sys
drives = json.load(sys.stdin)
for d in drives:
    nodes = d.get('nodes', d.get('state', {}).get('global', {}).get('nodes', []))
    if any(n.get('documentType') == 'bai/vault-config' for n in nodes):
        print(f'SLUG={d[\"slug\"]}')
        print(f'ID={d[\"id\"]}')
        print(f'NAME={d[\"name\"]}')
"
```

3. Get the drive tree and index all documents by type:
```bash
switchboard docs tree <drive-slug> --format json | python3 -c "
import json, sys
tree = json.load(sys.stdin)
nodes = tree.get('nodes', [])
# Index by documentType
by_type = {}
for n in nodes:
    dt = n.get('documentType', n.get('kind', 'unknown'))
    by_type.setdefault(dt, []).append(n)
for dt, items in sorted(by_type.items()):
    print(f'{dt}: {len(items)}')
"
```

Record: note count, MOC count, source count, research claim count, folder UUIDs.

## Step 1: Gather metrics from the subgraph

Run these queries **in parallel** (they are independent):

```bash
# Graph stats
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount noteCount mocCount claimCount tensionCount openTensionCount observationCount } }'

# Density
switchboard query '{ knowledgeGraphDensity(driveId: "<UUID>") }'

# Orphans
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { documentId title } }'
```

## Step 2: Gather everything from the graph in one request

Do **not** read notes one by one with `docs get` — on a 500-note vault that is 500 CLI processes. The graph index carries every field the checks need, MoCs included, and one aliased request returns all of it (measured: ~0.3 s for 487 notes + 38 MoCs):

```bash
switchboard query "{
  stats:   knowledgeGraphStats(driveId:\"$D\"){ nodeCount edgeCount orphanCount noteCount mocCount claimCount tensionCount openTensionCount observationCount }
  density: knowledgeGraphDensity(driveId:\"$D\")
  orphans: knowledgeGraphOrphans(driveId:\"$D\"){ documentId title noteType status }
  mocs:    knowledgeGraphNodesByStatus(driveId:\"$D\", status:\"MOC\"){ documentId title noteType }
  drafts:  knowledgeGraphNodesByStatus(driveId:\"$D\", status:\"DRAFT\"){ documentId }
  stale:   knowledgeGraphStale(driveId:\"$D\", since:\"<ISO 30 days ago>\", limit:500){ documentId status }
  nodes:   knowledgeGraphNodes(driveId:\"$D\"){ documentId title description status noteType documentType topics content }
  tensions: knowledgeGraphNodesByType(driveId:\"$D\", documentType:\"bai/tension\"){ documentId title status }
  edges:   knowledgeGraphEdges(driveId:\"$D\"){ sourceDocumentId targetDocumentId linkType }
}" --format json > /tmp/health.json
```

Then compute in Python from that one file. The rules that keep the numbers honest:

- **Count by kind, not by `nodeCount`.** The index holds five kinds — `documentType` is `bai/knowledge-note`, `bai/moc`, `bai/research-claim`, `bai/tension` or `bai/observation` — and `stats` reports each: use `stats.noteCount` for every note metric, never `nodeCount` (the total). `orphans` already excludes tensions and observations (they have nothing pointing at them by design) but still includes MoCs; an orphan MoC is a hierarchy problem, not an orphan note. MoCs are still recognisable by `status = "MOC"` / `noteType = "MOC (<tier>)"` on older indexes that lack `documentType`.
- **Open tensions** = `stats.openTensionCount` (or `tensions` filtered to `status = "OPEN"`). This is what THREE_SPACE_BOUNDARIES grades. A tension whose `observedBy` is `graph-indexer` was opened automatically from a CONTRADICTS edge — it still needs a human to resolve or dissolve it, so it counts.
- **Orphan** = a note with zero incoming edges — exactly what `orphans` returns. Outgoing links do not change it.
- **Links** come from `edges`, never from a note's `links[]` (empty since the relationship migration). `averageLinksPerNote` = outgoing edges per note; `connectionCount` = `stats.edgeCount`.
- **MoC coverage** = share of notes that are the target of a `CORE_IDEA` edge.
- **MOC_COHERENCE** = notes whose `topics` is empty (the dashboard's definition): `PASS` at 0, `WARN` ≤ 3, `FAIL` above. Selecting `topics` on `knowledgeGraphNodes` costs one server-side query per node, which is fine once per run (~0.3 s / 500 notes) — just never do it inside a per-hit loop.
- **Descriptions**: missing fails; < 80 is a quality warning. A description > 200 cannot exist in state — the reducer rejects it — so a missing description is often an over-long attempt that was silently dropped. Count length as UTF-16 units (JavaScript `.length`), the way the reducer does.
- **STALE_NOTES**: `stale` entries with `status = "DRAFT"`.
- **Lifecycle**: report the DRAFT share in `recommendations` — a vault where nearly every note is DRAFT has never been verified.

## Step 3: Check methodology grounding via note content

`nodes[].content` from Step 2 is the full body — no extra reads. A note is **grounded** if its content contains a "Methodology grounding" section referencing at least one claim from the plugin's local `data/methodology/` files. Notes without it are "floating" — their design rationale isn't traceable to the research foundation. Report the count in `recommendations` (there is no `HealthCategory` for it).

## Step 4: Check MOC coverage and the hierarchy

From the Step 2 data: a note is covered when it is the target of a `CORE_IDEA` edge; a MoC is placed when it is the target of a `CHILD_MOC` edge. Report uncovered notes, and any MoC other than the single HUB with no parent — an unreachable MoC is a hierarchy defect (see `synthesize`).

## Step 5: Compute diagnostic checks

| Category | PASS | WARN | FAIL |
|---|---|---|---|
| SCHEMA_COMPLIANCE | all notes have title, lowercase type, provenance | any missing (the dashboard never grades this FAIL) | — |
| ORPHAN_DETECTION | 0 orphans | 1-3 orphans | 4+ orphans |
| LINK_HEALTH | avg links >= 2.0 | avg >= 1.0 | avg < 1.0 |
| DESCRIPTION_QUALITY | all present + informative | 1-2 missing or restated | 3+ missing |
| MOC_COHERENCE | every note has ≥1 topic | 1-3 notes without topics | 4+ notes without topics |
| THREE_SPACE_BOUNDARIES | 0 open tensions | 1-3 open tensions | 4+ open tensions |
| PROCESSING_THROUGHPUT | 0 pending observations, 0 stuck tasks, 0 stranded sources | 1–5 pending observations, or 1–2 stuck tasks / stranded sources | >5 pending observations (the dashboard's own rule), or 3+ stuck/FAILED tasks or stranded sources |
| STALE_NOTES | 0 DRAFT notes > 30 days | 1-3 stale | 4+ stale |

**Description quality check (not just presence):**
- Length: 80-200 chars (aim ~150). < 30 = too terse, > 200 = **will silently fail SET_DESCRIPTION** (kill entire batch)
- Restatement: if description uses >70% same words as title = WARN
- Must add scope, mechanism, or implication beyond the title

**Methodology-grounding check (report in `recommendations`, NOT as a check):** For each knowledge note, check if its content includes a "Methodology grounding" section referencing at least one claim from the plugin's local `data/methodology/` files. Notes without methodology grounding are "floating" — their design rationale isn't traceable to the research foundation. The verify skill auto-repairs this by searching local methodology files and appending grounding references to the note's content.

**CRITICAL: Verify, don't assume.** After auto-fixing any health recommendation, **re-read the drive tree and re-query the subgraph** to confirm. Don't report PASS based on what you dispatched — report PASS based on what you verified. Silent failures are common with remote reactors (race conditions, CLI bugs, network latency).

**Two counting traps.** `knowledgeGraphStats.nodeCount` counts every indexed kind — MoCs, tensions, observations, research claims — so read `stats.noteCount` for notes (or filter `nodes` by `documentType`); dividing by `nodeCount` under-reports every per-note ratio. And MOC_COHERENCE above is defined the way the shipped dashboard defines it — **notes without topics** — not "topics without a MoC"; grading it differently makes `/health` and the in-app check contradict each other on the same vault. For STALE_NOTES prefer `knowledgeGraphStale(driveId, since, limit)` and `knowledgeGraphNodesByStatus(driveId, status: "DRAFT")` over reading every note.

## Step 6: Save to bai/health-report document

Find the existing `bai/health-report` in `/ops/health/` from the drive tree. If it doesn't exist, create it:

```bash
switchboard docs create --type bai/health-report --name "Health Report" --drive <drive-slug> --parent-folder <ops-health-folder-uuid> --format json
```

**Write report (overwrites previous):**
```bash
switchboard docs apply <health-report-id> --file /tmp/health-report.json
```

Where `/tmp/health-report.json` contains:
```json
[{
  "type": "GENERATE_REPORT",
  "input": {
    "generatedAt": "<ISO>",
    "generatedBy": "knowledge-agent",
    "mode": "full",
    "overallStatus": "PASS|WARN|FAIL",
    "graphMetrics": {
      "noteCount": 0,
      "mocCount": 0,
      "connectionCount": 0,
      "density": 0.0,
      "orphanCount": 0,
      "danglingLinkCount": 0,
      "mocCoverage": 0.0,
      "averageLinksPerNote": 0.0
    },
    "recommendations": ["..."]
  },
  "scope": "global"
}]
```

**Then add individual checks:**
```json
[
  {"type":"ADD_CHECK","input":{"id":"<uid>","category":"SCHEMA_COMPLIANCE","status":"PASS","message":"...","affectedItems":[]},"scope":"global"},
  {"type":"ADD_CHECK","input":{"id":"<uid>","category":"ORPHAN_DETECTION","status":"PASS","message":"...","affectedItems":[]},"scope":"global"}
]
```

Write to `/tmp/health-checks.json` and apply via `--file` to avoid shell escaping issues.

**Valid categories** — these are the ONLY values `bai/health-report`'s
`HealthCategory` enum accepts; ADD_CHECK with anything else is silently
dropped (the batch reports success, the check never lands):
SCHEMA_COMPLIANCE, ORPHAN_DETECTION, LINK_HEALTH, DESCRIPTION_QUALITY,
THREE_SPACE_BOUNDARIES, PROCESSING_THROUGHPUT, STALE_NOTES, MOC_COHERENCE.

⚠️ There is no `METHODOLOGY_GROUNDING` category — report that finding in
`recommendations` instead. Do **not** borrow `THREE_SPACE_BOUNDARIES`:
the app reserves it for **open tensions**, and both editors render
tension-specific remediation copy for it ("Open each tension and either
resolve it…"), so a methodology finding filed there shows the user
instructions that don't match the problem. Adding a dedicated enum value
to `bai/health-report` is the proper fix when the model is next edited.

⚠️ ADD_CHECK with an invalid category is **silently dropped** — the
mutation reports success and the check never lands. Always re-read the
report afterwards and confirm every check you dispatched is present.

**Valid statuses:** PASS, WARN, FAIL

## Step 7: Auto-repair (if `--fix` or user requests)

| Issue | Auto-fix |
|---|---|
| Missing descriptions | Generate from title + content, `docs mutate --op setDescription` (**max 200 chars!**) |
| Missing provenance | `docs mutate --op setProvenance` with sourceOrigin: DERIVED |
| Missing note types | Infer from content, `docs mutate --op setNoteType` |
| Missing topics | Identify from content, `docs mutate --op addTopic` |
| Ungrounded notes | Search local methodology files, add grounding references to note content via `docs mutate --op setContent` |
| Missing MOCs | **Auto-create**: find topic clusters with 3+ notes and no MOC. Create `bai/moc` via `docs create` + `--op createMoc`, then attach each cluster note as a core idea via `addRelationship(moc-id, note-id, "CORE_IDEA")` GraphQL mutation. (The legacy `--op addCoreIdea` writes to a state array the graph subgraph no longer indexes.) Verify in drive tree. |
| Stale DRAFT notes | Submit for review via `docs mutate --op submitForReview` |

**After each auto-fix, verify it applied** by re-reading the document state. Then re-run the health check to confirm the fix improved the score.

## Step 8: Report to user

```
=== VAULT HEALTH REPORT ===
Server: <profile-name> (<url>)
Drive: <drive-name> (<drive-slug>)
Saved to: bai/health-report (<doc-id>)

Notes: N | Links: N | Density: N%
Orphans: N | MOCs: N (hierarchy: 1 HUB, N unreachable)
Avg links/note: N | Methodology grounding: N/N

PASS  SCHEMA_COMPLIANCE      All N notes have title, type, provenance
PASS  ORPHAN_DETECTION       0 orphan notes
PASS  LINK_HEALTH            Avg 2.4 links/note, density 0.6
PASS  DESCRIPTION_QUALITY    All descriptions present and informative
WARN  MOC_COHERENCE          2 note(s) without topics
WARN  THREE_SPACE_BOUNDARIES 2 open tensions awaiting resolution
PASS  PROCESSING_THROUGHPUT  0 pending pipeline tasks
PASS  STALE_NOTES            No stale notes detected

Overall: WARN
Recommendations:
  1. Create MOC for 'document-toolbar' topic (5 notes)
  2. Ground 2 notes in methodology via /connect
```

## Stranded sources

A **stranded source** is a `bai/source` still in `INBOX` or `EXTRACTING`
that already has notes derived from it — extraction happened but nobody
closed the document out. It renders as unprocessed in the app's Sources
tab indefinitely, and it is invisible to the pipeline-task check because
its task may well be DONE.

Fold this into PROCESSING_THROUGHPUT:

```bash
# For each bai/source: read state, compare status against derived notes
switchboard docs get <source-id> --state --format json | python3 -c "
import json,sys; g=json.load(sys.stdin)['state']['global']
print(g.get('status'), len(g.get('extractedClaims') or []))"
# stranded if status in (INBOX, EXTRACTING) and notes exist (via
# knowledgeGraphBacklinks ... linkType DERIVED_FROM, or extractedClaims)
```

Repair with the Step 6 sequence in
[skills/extract/SKILL.md](../extract/SKILL.md): ADD_EXTRACTED_CLAIM per
note, RECORD_EXTRACTION_STATS, SET_SOURCE_STATUS EXTRACTED.

## What belongs in `recommendations`

**Open actions only** — things a human or agent should still do, each naming
the action and where to do it. The field renders as a to-do list in the app,
so anything else is noise:

- ❌ Status ("MoC membership complete: 100%") — that belongs in the relevant
  check's message, where it is already visible.
- ❌ Changelog ("Repaired this session: 144 note types…") — the document's
  operation history is the changelog.
- ❌ Design rationale ("Membership edges use RELATES_TO") — belongs in a note
  or the skill docs.
- ❌ Anything already fixed. Re-running the report replaces recommendations
  wholesale, so a fixed item must not survive into the next snapshot — and
  watch for self-contradicting leftovers like "0 notes at minimum degree 1 —
  candidates for the next pass".

## Scope methodology grounding honestly

`data/methodology/` is knowledge-systems research (PKM, agent cognition,
retrieval). A vault whose notes are mostly software internals will never
legitimately reach 100% grounding — "the reactor persists sync state in four
PGlite tables" has no methodology counterpart, and inventing one is a
fabricated link that fails the articulation test.

Before reporting a grounding gap, **size the addressable subset**: run a
couple of `knowledgeGraphSemanticSearch` probes for knowledge-management,
documentation-practice and agent-workflow themes, and treat notes scoring
>= 0.80 as the real denominator. Report `grounded / in-scope`, not
`grounded / all notes`.

## Re-run after every fix

A health report is a snapshot, and the dashboard shows the **last** one —
so any repair made after a run leaves the UI reporting stale problems.
Whenever you fix something the report flagged (here, in `/verify --fix`,
or during a pipeline), **re-run the full check and rewrite the report**
before telling the user it's fixed. GENERATE_REPORT resets metrics,
recommendations and checks, so a re-run cleanly replaces the previous
snapshot; the old one stays in the document's operation history.

## Reading health history

The HealthDashboard in the app reads from the `bai/health-report` document. Each `/health` run overwrites with current data (GENERATE_REPORT resets, then ADD_CHECK adds). Previous states are preserved in the document's operation history (revision history in Connect).

## Fallback (no subgraph)

If subgraph queries fail, compute metrics from individual document reads:

```bash
# List all documents in the drive
switchboard docs tree <drive-slug> --format json
# For each bai/knowledge-note, read state and compute metrics manually
switchboard docs get <note-id> --state --format json
# Count links, check descriptions, etc. from state data
```

This is slower (one HTTP call per document) but works when the subgraph indexer is behind.

## Automation

**When called from the pipeline (Step 6 — post-verify):** Always run with auto-fix enabled. The pipeline's health check phase should leave the vault in PASS state if possible — don't just report issues, fix them.

**When called standalone:** If `$ARGUMENTS` contains `--fix`, run auto-repair. Otherwise, report only.

**MOC creation is the most common auto-fix.** After every extraction, new topic clusters form. The pipeline REFLECT phase should create MOCs, but if it missed any, the health auto-fix catches them. This means no human intervention is needed for MOC creation — it's fully automated between pipeline + health.

If "$ARGUMENTS" is provided, treat it as mode (`--fix`, `quick`, `full`) or a specific note ID to check.
