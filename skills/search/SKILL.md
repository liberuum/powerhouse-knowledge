---
name: search
description: Search knowledge notes by title, type, topic, content, or meaning. Use when the user wants to find notes, look up knowledge, or explore what exists in the vault.
---

# Search Knowledge Notes

Search the Knowledge Vault using the graph indexer subgraph. Supports keyword search, topic filtering, provenance queries, and AI-powered semantic search.

## Search tiers (try in order)

### 1. Semantic search (best for natural language)

When the user asks a question or uses natural language (e.g., "how does storage work?", "notes about legal setup"), use semantic search. It understands meaning, not just keywords:

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<user question>", limit: 10) { node { documentId title description noteType status topics } similarity } }'
```

Results ranked by similarity (0-1). Notes > 0.75 are strong matches.

### 2. Keyword search (fast, exact matches)

For known terms or exact phrases:

```bash
# Title + description match
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<term>", limit: 20) { documentId title noteType status } }'

# Title + description + full content match
switchboard query '{ knowledgeGraphFullSearch(driveId: "<UUID>", query: "<term>", limit: 20) { documentId title noteType } }'
```

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

### 6. Fallback: Full document scan

If the subgraph returns empty (index needs rebuilding), scan directly:

1. `switchboard docs list --drive <drive-slug> --format json`
2. For each `bai/knowledge-note`, `switchboard docs get <doc-id> --state --format json`
3. Filter by title, description, topics, content, author

## When to use which search

| User intent | Best query |
|-------------|-----------|
| Natural language question | `knowledgeGraphSemanticSearch` |
| Known keyword/term | `knowledgeGraphSearch` or `knowledgeGraphFullSearch` |
| "Notes about topic X" | `knowledgeGraphByTopic` |
| "Notes similar to this one" | `knowledgeGraphSimilar` |
| "What did author X write?" | `knowledgeGraphByAuthor` |
| "Recent notes" | `knowledgeGraphRecent` |
| "Show all topics" | `knowledgeGraphTopics` |

## Output format

Present results as a concise list:
- **Title** (status badge) -- description
- Note type | Topics: #topic1, #topic2 | Links: N
- Similarity: 0.85 (if semantic search)

If the user asks "$ARGUMENTS", search for that term using the most appropriate tier.
