---
name: health
description: Check remote vault health — orphan notes, dangling links, graph density, methodology grounding, MOC coverage, processing stats. Saves results to the bai/health-report document. All checks run against the live reactor via Switchboard CLI.
---

# Vault Health Check

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
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount } }'

# Density
switchboard query '{ knowledgeGraphDensity(driveId: "<UUID>") }'

# Orphans
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { documentId title } }'
```

## Step 2: Read individual note state

For each `bai/knowledge-note` in the drive tree, read its full state:

```bash
switchboard docs get <note-id> --state --format json
```

Extract per note:
- `title` — present or missing
- `description` — present, length, quality (does it add info beyond title?)
- `noteType` — present or missing
- `status` — DRAFT, IN_REVIEW, CANONICAL, ARCHIVED
- `topics[]` — count
- `links[]` — count and types
- `provenance.sourceOrigin` — present or missing
- `content` — present and length

## Step 3: Check methodology grounding via note content

For each note, check if its content includes a "Methodology grounding" section referencing at least one claim from the plugin's local `data/methodology/` files. Read each note's state:

```bash
switchboard docs get <note-id> --state --format json
# Check if state.global.content contains "## Methodology grounding"
```

A note is **grounded** if its content references at least one methodology claim. Notes without methodology grounding are "floating" — their design rationale isn't traceable to the research foundation.

## Step 4: Check MOC coverage

From the drive tree, find all `bai/moc` documents. For each topic that appears on 3+ notes but has no MOC, flag it as a coverage gap.

```bash
# Count topic frequency across all notes
# python3 -c "... aggregate topics from note states ..."
# Flag topics with 3+ notes and no corresponding MOC
```

## Step 5: Compute diagnostic checks

| Category | PASS | WARN | FAIL |
|---|---|---|---|
| SCHEMA_COMPLIANCE | all notes have title, type, provenance | 1-2 missing fields | 3+ missing |
| ORPHAN_DETECTION | 0 orphans | 1-3 orphans | 4+ orphans |
| LINK_HEALTH | avg links >= 2.0 | avg >= 1.0 | avg < 1.0 |
| DESCRIPTION_QUALITY | all present + informative | 1-2 missing or restated | 3+ missing |
| MOC_COHERENCE | all 3+ note topics have MOCs | 1-2 gaps | 3+ gaps |
| METHODOLOGY_GROUNDING | all notes reference methodology in content | some ungrounded | many ungrounded |
| PROCESSING_THROUGHPUT | 0 pending pipeline tasks | 1-2 pending | 3+ pending or FAILED |
| STALE_NOTES | 0 DRAFT notes > 30 days | 1-3 stale | 4+ stale |

**Description quality check (not just presence):**
- Length: 50-200 chars ideal. < 30 = too terse, > 200 = **will silently fail SET_DESCRIPTION** (kill entire batch)
- Restatement: if description uses >70% same words as title = WARN
- Must add scope, mechanism, or implication beyond the title

**METHODOLOGY_GROUNDING check:** For each knowledge note, check if its content includes a "Methodology grounding" section referencing at least one claim from the plugin's local `data/methodology/` files. Notes without methodology grounding are "floating" — their design rationale isn't traceable to the research foundation. The verify skill auto-repairs this by searching local methodology files and appending grounding references to the note's content.

**CRITICAL: Verify, don't assume.** After auto-fixing any health recommendation, **re-read the drive tree and re-query the subgraph** to confirm. Don't report PASS based on what you dispatched — report PASS based on what you verified. Silent failures are common with remote reactors (race conditions, CLI bugs, network latency).

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

**Valid categories:** SCHEMA_COMPLIANCE, ORPHAN_DETECTION, LINK_HEALTH, DESCRIPTION_QUALITY, MOC_COHERENCE, METHODOLOGY_GROUNDING, PROCESSING_THROUGHPUT, STALE_NOTES

**Valid statuses:** PASS, WARN, FAIL

## Step 7: Auto-repair (if `--fix` or user requests)

| Issue | Auto-fix |
|---|---|
| Missing descriptions | Generate from title + content, `docs mutate --op setDescription` (**max 200 chars!**) |
| Missing provenance | `docs mutate --op setProvenance` with sourceOrigin: DERIVED |
| Missing note types | Infer from content, `docs mutate --op setNoteType` |
| Missing topics | Identify from content, `docs mutate --op addTopic` |
| Ungrounded notes | Search local methodology files, add grounding references to note content via `docs mutate --op setContent` |
| Missing MOCs | **Auto-create**: find topic clusters with 3+ notes and no MOC, create `bai/moc` via `docs create` + `CREATE_MOC` + `ADD_CORE_IDEA` per note. Verify in drive tree. |
| Stale DRAFT notes | Submit for review via `docs mutate --op submitForReview` |

**After each auto-fix, verify it applied** by re-reading the document state. Then re-run the health check to confirm the fix improved the score.

## Step 8: Report to user

```
=== VAULT HEALTH REPORT ===
Server: <profile-name> (<url>)
Drive: <drive-name> (<drive-slug>)
Saved to: bai/health-report (<doc-id>)

Notes: N | Links: N | Density: N%
Orphans: N | Research claims: N | MOCs: N
Avg links/note: N | Methodology grounding: N/N

PASS  SCHEMA_COMPLIANCE      All N notes have title, type, provenance
PASS  ORPHAN_DETECTION       0 orphan notes
PASS  LINK_HEALTH            Avg 2.4 links/note, density 0.6
PASS  DESCRIPTION_QUALITY    All descriptions present and informative
WARN  MOC_COHERENCE          No MOC for 'document-toolbar' (5 notes)
WARN  METHODOLOGY_GROUNDING  2/5 notes not linked to research claims
PASS  PROCESSING_THROUGHPUT  0 pending pipeline tasks
PASS  STALE_NOTES            No stale notes detected

Overall: WARN
Recommendations:
  1. Create MOC for 'document-toolbar' topic (5 notes)
  2. Ground 2 notes in methodology via /connect
```

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
