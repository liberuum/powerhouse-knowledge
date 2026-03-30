---
name: search
description: Search knowledge notes by title, type, topic, or content. Use when the user wants to find notes, look up knowledge, or explore what exists in the vault.
---

# Search Knowledge Notes

Search the Knowledge Vault for notes matching a query. Uses the Switchboard CLI to access documents.

## How to search

### Preferred: Subgraph search

Use the knowledge graph subgraph for fast full-text search:
```bash
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<search-term>", limit: 20) { documentId title noteType } }'
```

### Fallback: Full document scan

If the subgraph isn't available, scan documents directly:

1. Use `switchboard drives list --format json` to find available drives
2. Use `switchboard docs list --drive <drive-slug> --format json` to list all documents
3. For each document of type `bai/knowledge-note`, use `switchboard docs get <doc-id> --state --format json` to read its state
4. Filter results by the user's query against `state.global.title`, `state.global.description`, `state.global.noteType`, `state.global.topics`, and `state.global.content`

## Search strategies

- **By title**: Match against `state.global.title`
- **By type**: Filter by `state.global.noteType` (concept, decision, pattern, observation, procedure, architecture, bug-pattern, integration, workflow, reference)
- **By topic**: Match against `state.global.topics[].name`
- **By status**: Filter by `state.global.status` (DRAFT, IN_REVIEW, CANONICAL, ARCHIVED)
- **By content**: Search within `state.global.content` for keyword matches
- **By author**: Filter by `state.global.provenance.author`

## Output format

Present results as a concise list:
- **Title** (status badge) — description
- Note type | Topics: #topic1, #topic2 | Links: N

If the user asks "$ARGUMENTS", search for that term across all fields.
