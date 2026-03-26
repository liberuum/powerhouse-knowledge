---
name: watch
description: Start a live watch session on the Knowledge Vault. Monitors note changes in real-time via WebSocket and suggests actions (auto-connect, verify, health alerts). Use when the user wants continuous vault monitoring or autonomous knowledge management.
---

# Watch Knowledge Vault

Start a real-time monitoring session that watches for changes in the Knowledge Vault and suggests actions.

## How to Watch

Use the switchboard CLI to monitor the vault drive:

```bash
switchboard watch docs --drive <drive-uuid> --format json
```

This opens a WebSocket connection and streams every document change as JSON events.

## What to Watch For

### 1. New Notes Without Links (Orphan Alert)
When a new `bai/knowledge-note` is created:
- Check if it has 0 links after a few seconds
- If orphan: suggest running `/powerhouse-knowledge:connect` on it
- Log: "New note '{title}' has no connections — consider linking it"

### 2. Notes Modified Without Re-verification
When a note's content changes:
- Check if it was previously verified (confidence = "established" or "foundational")
- If verified content changed: suggest re-verification
- Log: "Verified note '{title}' was modified — verification may be stale"

### 3. Link Density Drops
When links are removed:
- Query `knowledgeGraphStats` for current density
- If density drops below threshold: alert
- Log: "Graph density dropped to {density}% — consider running /health"

### 4. New Source Ingested
When a `bai/source` document is created:
- Suggest extracting claims: "New source '{title}' ready for extraction — run /extract"

### 5. Pipeline Task Stuck
Query the `bai/pipeline-queue` periodically:
- Find tasks with status PENDING or IN_PROGRESS for > 1 hour
- Alert: "Task '{target}' stuck in {phase} for {duration}"

## Autonomous Actions

In autonomous mode, the agent can act on alerts:

```
USER: /powerhouse-knowledge:watch
AGENT: Starting vault watch session...

[20:35:01] Note "Small-world topology" created — checking connections...
[20:35:03] Found 2 potential connections via topic "graph-structure"
[20:35:03] AUTO: Added link → "Spreading activation..." (RELATES_TO)
[20:35:03] AUTO: Added link → "Over-linking..." (RELATES_TO)

[20:40:15] Source "New Research Paper" ingested
[20:40:15] SUGGEST: Run /powerhouse-knowledge:extract to process this source

[20:45:00] Health check: 8 nodes, 8 edges, density 14.3%, 1 orphan
[20:45:00] WARN: Note "test note" has no incoming links
```

## GraphQL Subscription (Advanced)

For direct WebSocket integration, subscribe at `ws://localhost:4001/graphql/subscriptions`:

```graphql
subscription WatchVault($search: SearchFilterInput) {
  documentChanges(search: $search) {
    type
    documents {
      id
      name
      documentType
      revisionsList { scope revision }
    }
  }
}
```

Variables:
```json
{
  "search": {
    "type": "bai/knowledge-note",
    "parentId": "<drive-id>"
  }
}
```

## Mutate via GraphQL (Bidirectional)

The same WebSocket connection can send mutations:

```graphql
mutation AddLink($id: String!, $actions: [JSONObject!]!) {
  mutateDocument(documentIdentifier: $id, actions: $actions) {
    id name
  }
}
```

Each action needs `timestampUtcMs` as ISO string alongside `type`, `input`, and `scope`.

If "$ARGUMENTS" is provided, use it as the drive UUID to watch.
