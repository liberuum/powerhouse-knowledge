---
name: search
description: Search knowledge notes by title, type, topic, content, or meaning. Use when the user wants to find notes, look up knowledge, or explore what exists in the vault.
---

# Search Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Search the Knowledge Vault using the graph indexer subgraph. Supports keyword search, topic filtering, provenance queries, and AI-powered semantic search.

## Rich context in two calls (answering a question)

When the user wants an **answer**, not a list, do not fetch hits one at a time. The node type carries `content`, and GraphQL aliases let one request fan out. Measured on a 521-note vault: ~1.4 s and ~4.3k tokens for everything below, versus 12+ round trips for less.

**Call 1 — the best notes, with their full text** (~1 s):

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<the question, verbatim>", mode: HYBRID, limit: 6) { similarity matchedBy node { documentId title description content noteType status documentType } } }' --format json > /tmp/hits.json
```

**Call 2 — the neighbourhood of the top 3, and the MoC map, in ONE request** (~0.4 s). Substitute the three ids from call 1:

```bash
switchboard query '{
  out0: knowledgeGraphForwardLinks(driveId:"<UUID>", documentId:"<id0>") { targetDocumentId targetTitle linkType }
  in0:  knowledgeGraphBacklinks(driveId:"<UUID>", documentId:"<id0>") { sourceDocumentId linkType }
  sim0: knowledgeGraphSimilar(driveId:"<UUID>", documentId:"<id0>", limit:3) { similarity node { documentId title } }
  out1: knowledgeGraphForwardLinks(driveId:"<UUID>", documentId:"<id1>") { targetDocumentId targetTitle linkType }
  in1:  knowledgeGraphBacklinks(driveId:"<UUID>", documentId:"<id1>") { sourceDocumentId linkType }
  sim1: knowledgeGraphSimilar(driveId:"<UUID>", documentId:"<id1>", limit:3) { similarity node { documentId title } }
  out2: knowledgeGraphForwardLinks(driveId:"<UUID>", documentId:"<id2>") { targetDocumentId targetTitle linkType }
  in2:  knowledgeGraphBacklinks(driveId:"<UUID>", documentId:"<id2>") { sourceDocumentId linkType }
  sim2: knowledgeGraphSimilar(driveId:"<UUID>", documentId:"<id2>", limit:3) { similarity node { documentId title } }
  mocs: knowledgeGraphNodesByStatus(driveId:"<UUID>", status:"MOC") { documentId title noteType }
}' --format json > /tmp/ctx.json
```

What that gives you, and how to use it:

- **`content` of the 6 hits** — quote the notes' own words; cite each by `documentId`.
- **`out*` / `in*` edges** — `CONTRADICTS` edges are findings (say so and cite both sides); `BUILDS_ON` / `SUPERSEDES` tell you which claim is current. A `CORE_IDEA` **backlink** is the MoC that owns the note — resolve its title from `mocs` and tell the user which cluster the answer lives in, so they can explore around it. An `INVOLVES` **backlink** is a tension that involves the note: the claim is contested — read the tension (`docs get`) and report its status.
- **`sim*`** — notes that say similar things without a link: candidates for a follow-up, or for `/connect`.
- If a hit is a MoC (`status = "MOC"`), its `content` is the orientation — a ready-made summary of the whole cluster; mention it and its `CHILD_MOC` children rather than re-deriving.

Only go deeper (`knowledgeGraphNodeByDocumentId` on a neighbour, `knowledgeGraphConnections(depth: 2)`) when the first two calls leave a specific gap. `topics` is a per-node resolver (one server-side query per row): one whole-vault fetch per run is cheap (~0.3 s / 500 notes), but do not select it inside a per-hit loop.

## Search tiers (try in order)

### 1. Semantic search (best for natural language)

When the user asks a question or uses natural language (e.g., "how does storage work?", "notes about legal setup"), use `knowledgeGraphSemanticSearch` (package ≥ 1.0.50). Pass the question as-is — the server embeds it and ranks by meaning, and falls back to keyword search transparently if embeddings are unavailable:

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<natural language question>", mode: HYBRID, limit: 10) { similarity matchedBy node { documentId title description noteType status topics } } }'
```

- `similarity` is **always a 0–1 relevance**, monotonic with result order — safe to show as a percentage or threshold on in either mode (package ≥ 1.0.52).
- `mode: SEMANTIC` — pure vector ranking; `similarity` is cosine (>0.8 strong match)
- `mode: HYBRID` — semantic + keyword fusion rescaled onto 0–1: **~1.0 = both signals matched at top rank, ~0.5 = only one signal matched**. `matchedBy` tells you which.
- `score` is the RAW value (cosine, or an ordinal RRF weight topping out near 0.033) — **never display `score` as a percentage**.
- **Before 1.0.52** HYBRID leaked the raw RRF weight into `similarity`, so a perfect match read as ~3%. Rank only; don't threshold.
- If the field fails schema validation, the deployment runs an older package — use tier 2 with 1-2 keywords instead.

### 2. Keyword search (fast, exact matches)

For known terms or exact phrases:

```bash
# Title + description match
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<term>", limit: 20) { documentId title noteType status } }'
```

**Archived notes are not returned** by any discovery query — `knowledgeGraphSearch`, `FullSearch`, `SemanticSearch`, `Similar`, `ByTopic`, `RelatedByTopic` — because an `ARCHIVED` note is a claim the vault no longer holds as current. When the user asks what the vault *used* to say, or you are checking whether a claim was already retired before creating a duplicate, pass `includeArchived: true`:

```bash
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<term>", includeArchived: true) { documentId title status } }'
```

An archived hit should be reported as history; follow its incoming `SUPERSEDES` edge (`knowledgeGraphBacklinks`) to the current claim.
```bash
# (structural reads — nodes, backlinks, forward links, nodesByStatus — are never filtered)

# Title + description + full content match
switchboard query '{ knowledgeGraphFullSearch(driveId: "<UUID>", query: "<term>", limit: 20) { documentId title noteType } }'
```

Ranked by where the term matched — title, then description, then body
(package ≥ 1.0.52) — so a title hit is no longer pushed out of the `limit`
window by incidental body mentions.

### 3. Topic search

When the user asks "what do we know about X topic":

```bash
# List all topics with note counts
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'

# Notes tagged with a specific topic
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "<topic-name>") { documentId title noteType status } }'
```

### 4. Find related notes

```bash
# By semantic similarity (AI-powered)
switchboard query '{ knowledgeGraphSimilar(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 10) { node { documentId title noteType } similarity } }'

# By shared topics (structural)
switchboard query '{ knowledgeGraphRelatedByTopic(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 10) { node { documentId title } sharedTopics sharedTopicCount } }'
```

### 5. Filter by provenance

```bash
# Notes by author
switchboard query '{ knowledgeGraphByAuthor(driveId: "<UUID>", author: "knowledge-agent") { documentId title noteType } }'

# Notes by source origin (DERIVED, IMPORT, MANUAL, SESSION_MINE)
switchboard query '{ knowledgeGraphByOrigin(driveId: "<UUID>", origin: "DERIVED") { documentId title } }'

# Recently created/updated
switchboard query '{ knowledgeGraphRecent(driveId: "<UUID>", limit: 10) { documentId title createdAt } }'
```

### 6. Other useful queries

```bash
# One node by id (full node incl. content)
switchboard query '{ knowledgeGraphNodeByDocumentId(driveId: "<UUID>", documentId: "<NOTE-ID>") { title description noteType status content topics } }'
# All notes in a lifecycle state
switchboard query '{ knowledgeGraphNodesByStatus(driveId: "<UUID>", status: "DRAFT") { documentId title } }'
# Notes untouched since a date
switchboard query '{ knowledgeGraphStale(driveId: "<UUID>", since: "<ISO>", limit: 50) { documentId title updatedAt } }'
```

**Five kinds of node come back from every query above.** Select `documentType` to tell them apart:

| `documentType` | what it is | `status` carries | how to use it |
|---|---|---|---|
| `bai/knowledge-note` | an atomic claim | DRAFT / IN_REVIEW / CANONICAL / ARCHIVED | cite as knowledge |
| `bai/research-claim` | a methodology claim | `CANONICAL` | cite as knowledge (imported research) |
| `bai/moc` | a map of a cluster | `"MOC"` (sentinel; `noteType = "MOC (<tier>)"`) | its `content` is the orientation — a ready summary; don't render through a note-status badge |
| `bai/tension` | a recorded contradiction between notes | OPEN / RESOLVED / DISSOLVED | report as a disagreement, never as a fact; its `INVOLVES` edges point at the notes |
| `bai/observation` | a note about the vault's own process | PENDING / PROMOTED / IMPLEMENTED / ARCHIVED | process signal, not subject knowledge |

Filter to `bai/knowledge-note` (and `bai/research-claim`) when the question is about the subject. A tension in the hits is itself a finding — say the notes disagree and cite both sides. `knowledgeGraphNodesByType(driveId, documentType)` lists one kind directly.

### 7. Fallback: Full document scan

If the subgraph returns empty (index needs rebuilding), scan directly:

1. `switchboard docs list --drive <drive-slug> --format json`
2. For each `bai/knowledge-note`, `switchboard docs get <doc-id> --state --format json`
3. Filter by title, description, topics, content, author

## When to use which search

| User intent | Best query |
|-------------|-----------|
| Natural language question | `knowledgeGraphSemanticSearch` (mode: HYBRID) — pass the question verbatim |
| Known keyword/term | `knowledgeGraphSearch` or `knowledgeGraphFullSearch` (1-2 keywords, terms are ANDed) |
| "Notes about topic X" | `knowledgeGraphByTopic` |
| "Notes similar to this one" | `knowledgeGraphSimilar` |
| "What did author X write?" | `knowledgeGraphByAuthor` |
| "Recent notes" | `knowledgeGraphRecent` |
| "Show all topics" | `knowledgeGraphTopics` |

## Output format

Present results as a concise list:
- **Title** (status badge) -- description
- Note type | Cluster: <owning MoC title> | Links: N out / N in (from call 2)
- Similarity: 0.85 (if semantic search)

If the user asks "$ARGUMENTS", search for that term using the most appropriate tier.
