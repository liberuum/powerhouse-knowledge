---
name: graph
description: Interactive knowledge graph analysis — find synthesis opportunities, bridges, clusters, and structural patterns. Use for deep graph exploration and strategic knowledge management.
---

# Graph Analysis

Structural analysis of the knowledge graph to find patterns, gaps, and opportunities.

## Analysis types

### Triangles (Synthesis Opportunities)
Find note pairs (A, B) that both connect to C but not to each other. These are synthesis opportunities — if A and B share a common reference, they may relate directly.

**Process:**
1. For each note, get its outgoing links
2. For each pair of notes sharing a link target, check if they link to each other
3. Report missing edges as synthesis opportunities

### Bridges
Find notes whose removal would disconnect parts of the graph. These are critical knowledge nodes that need extra verification and connection redundancy.

### Clusters
Identify connected components — groups of notes that are internally connected but isolated from other groups. Cross-cluster connections strengthen the graph.

### Hubs
Find notes with the most connections (both incoming and outgoing):
- **Authority nodes**: High incoming links (widely referenced)
- **Hub nodes**: High outgoing links (well-connected to the graph)

### Density Analysis
- Overall: total edges / possible edges
- Per-topic: density within each topic group
- Identify sparse topics that need more connections

## Using the subgraph

If available, use GraphQL queries:
```graphql
query {
  knowledgeGraphConnections(driveId: "...", documentId: "...", depth: 3) {
    node { title status }
    depth
    viaLinkType
  }
}
```

Otherwise, compute from document reads.

## Output format

Present findings as actionable recommendations:
```
=== GRAPH ANALYSIS ===
Triangles found: N synthesis opportunities
Top 3: A <-> B (via C) — suggest: RELATES_TO because ...
Bridges: N critical nodes — verify these have backups
Clusters: N groups — suggest cross-cluster connections
Hub notes: top 5 by connection count
```

If "$ARGUMENTS" is provided, focus analysis on that topic or note.
