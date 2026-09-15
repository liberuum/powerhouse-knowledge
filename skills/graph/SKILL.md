---
name: graph
description: Interactive knowledge graph analysis — find synthesis opportunities, bridges, clusters, topic structure, and semantic neighborhoods. Use for deep graph exploration and strategic knowledge management.
---

# Graph Analysis

These are REST routes as well as GraphQL queries:

```bash
curl -s -H "$AUTH" "$BASE/stats?drive=<UUID>"
curl -s -H "$AUTH" "$BASE/density?drive=<UUID>"
curl -s -H "$AUTH" "$BASE/orphans?drive=<UUID>"
curl -s -H "$AUTH" "$BASE/triangles?drive=<UUID>&limit=20"
curl -s -H "$AUTH" "$BASE/graph.json?drive=<UUID>"
```

Use GraphQL when you want only some fields of a large result.


> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Structural, topical, and semantic analysis of the knowledge graph to find patterns, gaps, and opportunities.

> `knowledgeGraphStats.nodeCount`, `density`, `orphans`, `triangles` and `bridges` all include **MoC nodes** (`status = "MOC"`, `noteType = "MOC (<tier>)"`). "N orphan notes" may be MoCs — check `noteType` before reporting. For a vault-wide ranking of hubs/authorities use one `knowledgeGraphEdges(driveId)` call and count in Python, not `backlinks`/`forwardLinks` per note. Also available: `knowledgeGraphHistory(documentId)`, `knowledgeGraphActivity(since)`, `knowledgeGraphActivityByType(operationType)`, `knowledgeGraphStale(since)`, `knowledgeGraphNodesByStatus(status)`, `knowledgeGraphNodeByDocumentId(documentId)`.

## Core queries

```bash
# Stats
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount } }'

# Density
switchboard query '{ knowledgeGraphDensity(driveId: "<UUID>") }'

# Triangles (synthesis opportunities)
switchboard query '{ knowledgeGraphTriangles(driveId: "<UUID>", limit: 10) { noteA { title documentId } noteB { title documentId } sharedTarget { title } } }'

# Bridges (critical nodes)
switchboard query '{ knowledgeGraphBridges(driveId: "<UUID>") { title documentId } }'

# Orphans
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { title documentId noteType } }'
```

## Neighborhood exploration

```bash
# N-hop connections from a note
switchboard query '{ knowledgeGraphConnections(driveId: "<UUID>", documentId: "<NOTE-ID>", depth: 3) { node { title } depth viaLinkType } }'

# Backlinks (who links to this note?)
switchboard query '{ knowledgeGraphBacklinks(driveId: "<UUID>", documentId: "<NOTE-ID>") { sourceDocumentId linkType } }'

# Forward links (what does this note link to?)
switchboard query '{ knowledgeGraphForwardLinks(driveId: "<UUID>", documentId: "<NOTE-ID>") { targetDocumentId linkType targetTitle } }'
```

## Topic structure

```bash
# All topics with note counts — shows knowledge distribution
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'

# Notes in a specific topic
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "reactor") { documentId title noteType status } }'

# Notes sharing topics with a given note (topic affinity)
switchboard query '{ knowledgeGraphRelatedByTopic(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 10) { node { title documentId } sharedTopics sharedTopicCount } }'
```

## Semantic neighborhoods

AI-powered queries over server-computed embeddings (the graph-indexer processor embeds every note; package ≥ 1.0.50). Find conceptually related notes even without shared topics or direct links:

```bash
# Find notes semantically similar to a given note
switchboard query '{ knowledgeGraphSimilar(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 10) { node { documentId title noteType } similarity } }'

# Semantic search for a concept — natural language works verbatim
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "how do reducers report errors?", mode: SEMANTIC, limit: 10) { similarity node { documentId title } } }'
```

Use `knowledgeGraphSimilar` during connection analysis — it reveals non-obvious relationships that topic overlap and link structure miss.

## Analysis types

### Triangles (Synthesis Opportunities)
Find note pairs (A, B) that both connect to C but not to each other. These are synthesis opportunities — if A and B share a common reference, they may relate directly.

Use `knowledgeGraphTriangles` query. For each triangle, suggest a link type and articulation.

### Bridges (Critical Nodes)
Find notes whose removal would split the graph into more pieces — the ones
holding two clusters together.

Use `knowledgeGraphBridges`. **Needs write access** (it answers what
structural work needs doing, which is a curation question). One DFS pass —
Tarjan, O(V+E) — so it is an ordinary read to run, not something to avoid.

Reading the result:

- **A bridge is a weakness, not an asset.** The fix is a second, independent
  link between the two regions so the note stops being the only path — not
  protecting the bridge.
- It is **not** "most connected". A note with 100 links inside one dense
  cluster is not a bridge; a note with 2 links is, if those are the only path
  between two halves.
- **Check before archiving.** Retiring a bridge strands whatever sits behind
  it. `SUPERSEDES` + `ARCHIVE_NOTE` on a bridge silently orphans a subgraph.
- A MoC near the top of the list is expected — a hierarchy is bridges by
  design. Notes near the top are the finding: each is a claim whose only
  route into the vault runs through one other note, so it satisfies
  "2+ connections" on paper but not independently. That is the `/connect`
  backlog.

### Topic Landscape
Use `knowledgeGraphTopics` to see the full topic distribution. Identify:
- **Dense topics** (many notes) — may need MOC organization
- **Sparse topics** (1-2 notes) — may need more extraction or may be candidates for merging
- **Overlapping notes** — use `knowledgeGraphRelatedByTopic` to find notes that span multiple topics

### Hubs & Authorities
Find notes with the most connections:
- **Authority nodes**: High incoming links (widely referenced) — via backlinks query
- **Hub nodes**: High outgoing links — via forwardLinks query

### Density Analysis
- Overall: `knowledgeGraphDensity` query
- Per-topic: use `knowledgeGraphByTopic` for each major topic, count edges within the group
- Identify sparse topics that need more connections

### Orphan Recovery
Use `knowledgeGraphOrphans` to find disconnected notes. For each orphan:
1. Try `knowledgeGraphSimilar` to find semantically related notes
2. Try `knowledgeGraphRelatedByTopic` to find topic neighbors
3. Suggest specific connections with articulation

### Semantic Cluster Discovery
Use `knowledgeGraphSimilar` on multiple seed notes to map out conceptual regions. Notes that appear as similar to several seeds form an implicit cluster — even if they don't share topics or links.

## Output format

Present findings as actionable recommendations:
```
=== GRAPH ANALYSIS ===
Nodes: N | Edges: N | Density: N% | Topics: N

Topic landscape:
  reactor (25 notes) | document-model (18 notes) | legal (12 notes) ...

Triangles: N synthesis opportunities
  Top 3: "A" <-> "B" (via "C") -- suggest: RELATES_TO because ...

Bridges: N critical nodes
  "title" -- N connections would break if removed

Orphans: N disconnected notes
  "title" -- semantically similar to: "related note" (0.82)

Hubs: Top 5 by connection count
  "title" -- N incoming, N outgoing
```

If "$ARGUMENTS" is provided, focus analysis on that topic or note.
