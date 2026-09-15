---
name: search
description: Use when the user wants to find notes, look up knowledge, explore what exists in the vault, or search for a project, deliverable, milestone, roadmap, map, workflow, or work-breakdown without knowing where it lives.
---

# Search Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Search the Knowledge Vault using the graph indexer subgraph. Supports keyword search, topic filtering, provenance queries, and AI-powered semantic search.

```bash
curl -s -H "$AUTH" "$BASE/search?drive=<UUID>&q=<question>&mode=semantic&limit=6"
curl -s -H "$AUTH" "$BASE/notes/<id>?drive=<UUID>"      # note with its links
curl -s -H "$AUTH" "$BASE/notes/<id>.md?drive=<UUID>"   # readable markdown
```

Add `&content=1` to `search` for full note bodies. Use GraphQL instead when you
want only selected fields of a large result.

## Choosing the query and the mode

`hybrid` fuses a semantic leg with a keyword leg, and **the keyword leg ANDs its
terms**. A whole question has too many terms to match anything, so the keyword
leg returns nothing and hybrid silently degrades to semantic-only.

**For a question about how two things relate, search the narrower one alone.**
Naming both pulls the embedding toward whichever concept the vault holds more
of, and you get generic notes about that one. Measured: "What is Swarm and how
is it connected with Powerhouse?" returned five Powerhouse-general notes and one
about Swarm; searching `Swarm` alone returned the Swarm MoC, whose `CORE_IDEA`
members are the connection. Find the narrow thing, then read its links.

**For a proper noun or an exact term, `knowledgeGraphFullSearch` is better than
semantic.** It is keyword-only and ANDs its terms, so give it 1-2 words — but it
is precise where an embedding is fuzzy.

**`semantic` is the only mode.** Its `similarity` is a true cosine, so it can be compared and
thresholded. For an exact term use `knowledgeGraphFullSearch`, which is keyword-only.

**Always add `content=1` when you intend to answer.** Without it a hit carries
only title and description, which is enough to list results and not enough to
explain anything.

```bash
curl -s -H "$AUTH" "$BASE/search?drive=$DRIVE&q=how+a+document+model+works:+state+schema,+actions,+reducer&mode=semantic&limit=6&content=1"
```

Then follow the best hit's MoC: `GET notes/:id/links` lists its `CORE_IDEA`
members with their titles, which is the curated reading order for that topic.

## Work vs knowledge — fork first

Graph search ranks **documents**. A project is an envelope inside
`powerhouse/scopeofwork`, not a document — `docs get "Paperless Billing"`
fails, and semantic search often ranks notes above the envelope.

If the query is about a **project, deliverable, milestone, roadmap, cited
map on a project, workflow/goal status, or WBS**: **REQUIRED SUB-SKILL:**
use scope-of-work (`lookup.py search` / `get` / `outline`). Then continue
here for subject knowledge around that work.

A `SCOPE` / `WBS` hit from the queries below is a rendered outline, not
structured state (quotes, envelope UUID, `goalRef`). Pass its `documentId`
to `lookup.py get` or `outline`.

## Rich context in ONE call (answering a question)

When the user wants an **answer**, not a list, do not fetch hits one at a time.
The node type carries `content`, and **`related` carries the neighbourhood** —
so a single request returns the best notes, their full text, and what they
connect to. This replaces the old two-call recipe: `related` gives you what a
second aliased query of `forwardLinks` + `backlinks` + `similar` used to.

Most of what the vault knows about a question is in the edges, not the
ranking. Six hits typically sit next to a hundred directly connected notes.

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<the question>", mode: SEMANTIC, limit: 6) {
  similarity matchedBy
  node { documentId title description content noteType status documentType }
  related(limit: 6) { documentId title description noteType hitCount via { from to linkType reason confidence } }
  linkedHits { from to linkType reason confidence }
} }' --format json > /tmp/hits.json
```

**Select both.** `related` is what is one link AWAY from the hits; `linkedHits`
is the edges BETWEEN them. `related` excludes nodes that are themselves hits by
construction, and semantic search routinely returns both sides of a
disagreement — so the `CONTRADICTS` joining two of your results appears ONLY in
`linkedHits`. Omit it and you will report two confident claims without noticing
that one disputes the other.

How to read `related`:

- Ranked by `hit similarity x link-type weight`, summed over every edge, so a
  note **several** hits point at outranks one only a single hit points at.
  `hitCount` is how many — treat a high `hitCount` as the vault agreeing.
- `via` is always written **source → target**, so there is no direction to
  decode, and carries the edge's `reason` when the author gave one.
- **`CONTRADICTS` / `SUPERSEDES` — in `via` OR in `linkedHits` — is a finding,
  not a footnote.** It means a hit is disputed or stale. Say so and cite both
  sides rather than reporting the hit as settled: this is the case where
  ignoring the neighbourhood produces a WRONG answer, not merely a thin one.
  Check whether a `bai/tension` over the pair is OPEN or already
  RESOLVED/DISSOLVED before calling the dispute live — a retained
  `CONTRADICTS` edge is often the provenance of a correction that was already
  made, not an argument still running.
- A `CORE_IDEA` edge **into** a hit is the MoC that owns it: name the cluster
  so the user can explore around the answer.
- An `INVOLVES` edge is a tension involving the note — read it (`docs get`)
  and report its status.
- Selecting `related` costs the same two queries however many hits you select
  it on, and nothing if you do not select it.

### Going deeper (only when the single call leaves a specific gap)

Aliases let one request fan out across several notes. Substitute ids from the
search above:

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

Reach for this only when `related` did not answer the gap:

- **`sim*`** — notes that say similar things **without** a link. `related`
  cannot surface these, because there is no edge to follow: they are
  candidates for a follow-up question, or for `/connect`.
- **`mocs`** — the MoC map, when you need a title for a cluster `related`
  referenced by id.
- If a hit is a MoC (`status = "MOC"`), its `content` is the orientation — a
  ready-made summary of the whole cluster; mention it and its `CHILD_MOC`
  children rather than re-deriving.
- `knowledgeGraphNodeByDocumentId` on a neighbour for its full text, or
  `knowledgeGraphConnections(depth: 2)` for a two-hop walk.

`topics` is a per-node resolver (one server-side query per row): one
whole-vault fetch per run is fine, but do not select it inside a per-hit loop.

## Search tiers (try in order)

### 1. Semantic search (best for natural language)

When the user asks a question or uses natural language (e.g., "how does storage work?", "notes about legal setup"), use `knowledgeGraphSemanticSearch` (package ≥ 1.0.50). Pass the question as-is — the server embeds it and ranks by meaning, and falls back to keyword search transparently if embeddings are unavailable:

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<natural language question>", mode: SEMANTIC, limit: 10) { similarity matchedBy node { documentId title description noteType status } related(limit: 5) { title noteType hitCount via { linkType reason } } linkedHits { from to linkType reason } } }'
```

- Add `related` AND `linkedHits` whenever the user wants an answer rather than a list — see *Rich context in ONE call* above. Neither costs a query per hit.
- `similarity` is **always a 0–1 relevance**, monotonic with result order — safe to show as a percentage or threshold on in either mode (package ≥ 1.0.52).
- `mode: SEMANTIC` — pure vector ranking; `similarity` is cosine (>0.8 strong match)
- `score` is the RAW value (cosine, or an ordinal RRF weight topping out near 0.033) — **never display `score` as a percentage**.
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

**Seven kinds of node come back from every query above.** Select `documentType` to tell them apart:

| `documentType` | what it is | `status` carries | how to use it |
|---|---|---|---|
| `bai/knowledge-note` | an atomic claim | DRAFT / IN_REVIEW / CANONICAL / ARCHIVED | cite as knowledge |
| `bai/research-claim` | a methodology claim | `CANONICAL` | cite as knowledge (imported research) |
| `bai/moc` | a map of a cluster | `"MOC"` (sentinel; `noteType = "MOC (<tier>)"`) | its `content` is the orientation — a ready summary; don't render through a note-status badge |
| `powerhouse/scopeofwork` | a scope of work — envelopes (projects), deliverables, milestones, contributors | `"SCOPE"` (sentinel; `noteType = "Scope (<ScopeOfWorkStatus>)"`) | outline only; nested fields → **scope-of-work**. `CITES` → notes/MoCs, `DELIVERED_BY` → WBS |
| `bai/wbs` | the goal tree that delivers one envelope | `"WBS"` (sentinel; `noteType = "WBS (TODO\|IN_PROGRESS\|BLOCKED\|COMPLETED)"`) | outline / goal tree → **scope-of-work** `get <wbs-id>`. Backlink `DELIVERED_BY` from its scope |
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
| Natural language question | `knowledgeGraphSemanticSearch` (mode: SEMANTIC) |
| Known keyword/term | `knowledgeGraphSearch` or `knowledgeGraphFullSearch` (1-2 keywords, terms are ANDed) |
| Project / deliverable / milestone / roadmap / WBS / "what's the status of X" | **scope-of-work** (`lookup.py search` / `get`) — not graph search |
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
