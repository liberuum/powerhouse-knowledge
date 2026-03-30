---
name: health
description: Check vault health — orphan notes, dangling links, graph density, processing stats. Saves results to the bai/health-report document for historical tracking. Use for maintenance, monitoring, or when the user asks about vault status.
---

# Vault Health Check

Run diagnostics across the knowledge vault, report actionable findings, and **save results to the `bai/health-report` document** in `/ops/health/`.

## Process

### Step 1: Gather metrics

Query the subgraph at `/graphql/knowledgeGraph`:

```bash
# Graph stats
curl -s $REACTOR_URL/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphStats(driveId: \"<UUID>\") { nodeCount edgeCount orphanCount } }"}'

# Density
curl -s $REACTOR_URL/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphDensity(driveId: \"<UUID>\") }"}'

# Orphans
curl -s $REACTOR_URL/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphOrphans(driveId: \"<UUID>\") { documentId title } }"}'
```

Also read individual notes via MCP to check:
- Missing descriptions
- Missing provenance
- Missing note types
- Missing topics
- Link density per note

### Step 2: Compute checks

| Category | PASS | WARN | FAIL |
|---|---|---|---|
| ORPHAN_DETECTION | 0 orphans | 1-3 | 4+ |
| LINK_HEALTH | avg >= 2.0 | avg >= 1.0 | avg < 1.0 |
| DESCRIPTION_QUALITY | 0 missing | 1-2 missing | 3+ missing |
| SCHEMA_COMPLIANCE | all have type | some missing | many missing |
| MOC_COHERENCE | all have topics | some without | many without |
| METHODOLOGY_GROUNDING | all notes link to research claims | some ungrounded | many ungrounded |
| PROCESSING_THROUGHPUT | 0 pending obs | some pending | many pending |
| STALE_NOTES | 0 stale | some stale | many stale |

**METHODOLOGY_GROUNDING check:** For each knowledge note, check if it has at least one outgoing link to a `bai/research-claim` document. Notes without methodology grounding are "floating" — their design rationale isn't traceable to the research foundation. The verify skill auto-repairs this by searching for matching claims.

**CRITICAL: Verify, don't assume.** After auto-fixing any health recommendation (creating MOCs, adding descriptions, importing methodology), **re-read the drive tree** to confirm the fix actually applied. Don't report PASS based on what you dispatched — report PASS based on what you verified exists in the drive. Silent failures are common (MCP race condition, CLI bugs, network issues).

### Step 3: Save to bai/health-report document

Find or create the health report document in `/ops/health/`:

```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Find existing: kind="file", documentType="bai/health-report" in /ops/health/
// Or create new:
mcp__reactor-mcp__createDocument({
  documentType: "bai/health-report",
  driveId: "<drive-uuid>",
  name: "Health Report",
  parentFolder: "<ops-health-folder-uuid>"
})
```

**Write the report via GENERATE_REPORT:**
```
mcp__reactor-mcp__addActions({
  documentId: "<health-report-id>",
  actions: [{
    type: "GENERATE_REPORT",
    input: {
      generatedAt: "<ISO timestamp>",
      generatedBy: "knowledge-agent",
      mode: "full",
      overallStatus: "PASS|WARN|FAIL",
      graphMetrics: {
        noteCount: N,
        mocCount: N,
        connectionCount: N,
        density: 0.83,
        orphanCount: N,
        danglingLinkCount: N,
        mocCoverage: 0.75,
        averageLinksPerNote: 2.5
      },
      recommendations: [
        "Connect 2 orphan notes",
        "Add descriptions to 3 notes"
      ]
    },
    scope: "global"
  }]
})
```

**Then add individual checks via ADD_CHECK:**
```
mcp__reactor-mcp__addActions({
  documentId: "<health-report-id>",
  actions: [
    {
      type: "ADD_CHECK",
      input: {
        id: "<unique-id>",
        category: "ORPHAN_DETECTION",
        status: "WARN",
        message: "2 orphan notes found",
        affectedItems: ["note-title-1", "note-title-2"]
      },
      scope: "global"
    },
    {
      type: "ADD_CHECK",
      input: {
        id: "<unique-id>",
        category: "DESCRIPTION_QUALITY",
        status: "PASS",
        message: "All notes have descriptions",
        affectedItems: []
      },
      scope: "global"
    }
  ]
})
```

**Valid categories:** SCHEMA_COMPLIANCE, ORPHAN_DETECTION, LINK_HEALTH, DESCRIPTION_QUALITY, THREE_SPACE_BOUNDARIES, PROCESSING_THROUGHPUT, STALE_NOTES, MOC_COHERENCE

**Valid statuses:** PASS, WARN, FAIL

### Step 4: Auto-repair (optional)

If `--fix` or the user asks to repair:
- Missing descriptions → generate and SET_DESCRIPTION
- Missing provenance → set DERIVED
- Missing types → infer and SET_NOTE_TYPE
- Missing topics → identify and ADD_TOPIC

Record repairs in the report recommendations.

### Step 5: Report to user

```
=== VAULT HEALTH REPORT ===
Saved to: bai/health-report (<doc-id>)

Notes: N | Links: N | Density: N%
Orphans: N | Dangling: N | Avg links: N

PASS  ORPHAN_DETECTION     All notes have incoming links
WARN  LINK_HEALTH          3 notes have fewer than 2 links
PASS  DESCRIPTION_QUALITY  All notes have descriptions
PASS  SCHEMA_COMPLIANCE    All notes have a type
WARN  MOC_COHERENCE        2 notes without topics

Overall: WARN
Recommendations:
  1. Connect 3 under-linked notes via /connect
  2. Tag 2 notes with topics
```

## Reading health history

The HealthDashboard in the app reads from the `bai/health-report` document. Each time `/health` runs, it overwrites the report with current data (GENERATE_REPORT resets checks, then ADD_CHECK adds new ones). This gives the app always-current health data without computing it on every render.

Previous health states are preserved in the document's operation history (revision history in Connect).

## Fallback (no subgraph)

If the subgraph isn't available, compute metrics from individual document reads:
```
mcp__reactor-mcp__getDocuments({ parentId: "<drive-uuid>" })
// Read each bai/knowledge-note document, compute metrics manually
```

Resolve `$REACTOR_URL` from `.mcp.json` before running curl commands (see agent docs).
