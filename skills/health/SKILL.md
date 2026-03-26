---
name: health
description: Check vault health — orphan notes, dangling links, graph density, processing stats. Use for maintenance, monitoring, or when the user asks about vault status.
---

# Vault Health Check

Run diagnostics across the knowledge vault and report actionable findings.

## Health check categories

### 1. Graph Metrics
Query all notes and compute:
- **Note count**: Total knowledge notes in the drive
- **Edge count**: Total links between notes
- **Density**: edges / (nodes * (nodes - 1)) — how interconnected the graph is
- **Average links per note**: edges / nodes

### 2. Orphan Detection
Find notes with **zero incoming links** — no other note points to them.
These are disconnected from the knowledge graph and need `/connect`.

### 3. Link Health
Check all outgoing links resolve to existing documents:
- Fetch each note's `state.global.links`
- Verify each `targetDocumentId` exists in the drive
- Report dangling links (target doesn't exist)

### 4. Status Distribution
Count notes by status: DRAFT, IN_REVIEW, CANONICAL, ARCHIVED.
Flag if too many notes are stuck in DRAFT (need processing).

### 5. Type Distribution
Count notes by noteType. Flag if any type is empty or dominant.

### 6. Stale Notes
Find notes not modified in >30 days with < 2 links.
These need `/connect` or reweaving.

## Output format

```
=== VAULT HEALTH REPORT ===
Notes: N | Links: N | Density: N%
Orphans: N (list top 5)
Dangling links: N
Status: DRAFT(N) IN_REVIEW(N) CANONICAL(N) ARCHIVED(N)

PASS/WARN/FAIL per category
Recommended actions (ranked by impact)
```

## Using the subgraph (when available)

If the knowledge graph subgraph is running at the reactor endpoint, prefer querying it:
- `knowledgeGraphStats(driveId)` for metrics
- `knowledgeGraphOrphans(driveId)` for orphan detection

Otherwise, compute from individual document reads.
