---
name: health
description: Check vault health — orphan notes, dangling links, graph density, processing stats. Use for maintenance, monitoring, or when the user asks about vault status.
---

# Vault Health Check

Run diagnostics across the knowledge vault and report actionable findings.

## Health check categories

### 1. Graph Metrics
Query the subgraph for real-time stats:
- **Note count**: Total knowledge notes indexed
- **Edge count**: Total links between notes
- **Density**: edges / (nodes * (nodes - 1)) — how interconnected the graph is
- **Average links per note**: edges / nodes
- **Orphan count**: Notes with zero incoming links

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

### 6. Pipeline Status
Check the PipelineQueue for stuck or failed tasks:
- PENDING tasks waiting too long
- BLOCKED tasks needing manual intervention
- FAILED tasks needing retry

## Using the subgraph

The Knowledge Graph subgraph is at `/graphql/knowledgeGraph` (NOT `/graphql/r/`). Use Bash to query it:

```bash
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphStats(driveId: \"<DRIVE-UUID>\") { nodeCount edgeCount orphanCount } }"}'
```

**Available queries:**
- `knowledgeGraphStats(driveId)` → { nodeCount, edgeCount, orphanCount }
- `knowledgeGraphOrphans(driveId)` → [{ documentId, title, noteType }]
- `knowledgeGraphDensity(driveId)` → Float
- `knowledgeGraphSearch(driveId, query)` → search results
- `knowledgeGraphNodesByStatus(driveId, status)` → notes filtered by status

For remote Switchboard, replace `localhost:4001` with the remote host.

## Fallback (no subgraph)

If the subgraph isn't available, compute from individual document reads:
```
mcp__reactor-mcp__getDocuments({ parentId: "<drive-uuid>" })
// Then read each document's state to compute metrics
```

## Output format

```
=== VAULT HEALTH REPORT ===
Notes: N | Links: N | Density: N%
Orphans: N (list top 5)
Dangling links: N
Status: DRAFT(N) IN_REVIEW(N) CANONICAL(N) ARCHIVED(N)
Pipeline: N pending, N blocked, N failed

PASS/WARN/FAIL per category
Recommended actions (ranked by impact)
```

## Thresholds

| Check | PASS | WARN | FAIL |
|---|---|---|---|
| Orphans | 0 | 1-3 | 4+ |
| Avg links | >= 2.0 | >= 1.0 | < 1.0 |
| Density | > 10% | > 5% | < 5% |
| DRAFT ratio | < 30% | < 60% | >= 60% |
| Missing descriptions | 0 | 1-2 | 3+ |
