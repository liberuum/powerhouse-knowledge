---
name: graph
description: Interactive knowledge graph analysis — find synthesis opportunities, bridges, clusters, and structural patterns. Use for deep graph exploration and strategic knowledge management.
---

# Graph Analysis

Structural analysis of the knowledge graph to find patterns, gaps, and opportunities.

## Using the subgraph

The Knowledge Graph subgraph is at `/graphql/knowledgeGraph`. Use Bash to query:

```bash
# Stats
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphStats(driveId: \"<UUID>\") { nodeCount edgeCount orphanCount } }"}'

# Triangles (synthesis opportunities)
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphTriangles(driveId: \"<UUID>\", limit: 10) { noteA { title documentId } noteB { title documentId } sharedTarget { title } } }"}'

# Bridges (critical nodes)
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphBridges(driveId: \"<UUID>\") { title documentId } }"}'

# Orphans
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphOrphans(driveId: \"<UUID>\") { title documentId noteType } }"}'

# N-hop connections from a note
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphConnections(driveId: \"<UUID>\", documentId: \"<NOTE-ID>\", depth: 3) { node { title } depth viaLinkType } }"}'

# Backlinks (who links to this note?)
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphBacklinks(driveId: \"<UUID>\", documentId: \"<NOTE-ID>\") { sourceDocumentId linkType } }"}'

# Forward links (what does this note link to?)
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphForwardLinks(driveId: \"<UUID>\", documentId: \"<NOTE-ID>\") { targetDocumentId linkType targetTitle } }"}'

# Full-text search
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphSearch(driveId: \"<UUID>\", query: \"cognitive\", limit: 20) { title documentId noteType } }"}'

# Density
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphDensity(driveId: \"<UUID>\") }"}'
```

For remote Switchboard, replace `localhost:4001` with the remote host.

## Analysis types

### Triangles (Synthesis Opportunities)
Find note pairs (A, B) that both connect to C but not to each other. These are synthesis opportunities — if A and B share a common reference, they may relate directly.

Use `knowledgeGraphTriangles` query. For each triangle, suggest a link type and articulation.

### Bridges (Critical Nodes)
Find notes whose removal would disconnect parts of the graph. These need extra verification and connection redundancy.

Use `knowledgeGraphBridges` query. Recommend adding redundant links to reduce single-point-of-failure risk.

### Hubs
Find notes with the most connections:
- **Authority nodes**: High incoming links (widely referenced) — via backlinks query
- **Hub nodes**: High outgoing links — via forwardLinks query

### Density Analysis
- Overall: `knowledgeGraphDensity` query
- Per-topic: Group nodes by topic, compute density within each group
- Identify sparse topics that need more connections

### Orphan Recovery
Use `knowledgeGraphOrphans` to find disconnected notes. For each, search for related notes and suggest connections.

## Output format

Present findings as actionable recommendations:
```
=== GRAPH ANALYSIS ===
Nodes: N | Edges: N | Density: N%

Triangles: N synthesis opportunities
  Top 3: "A" <-> "B" (via "C") — suggest: RELATES_TO because ...

Bridges: N critical nodes
  "title" — N connections would break if removed

Orphans: N disconnected notes
  "title" — suggest connecting to: "related note"

Hubs: Top 5 by connection count
  "title" — N incoming, N outgoing
```

If "$ARGUMENTS" is provided, focus analysis on that topic or note.
