---
name: watch
description: Start a live watch session on the Knowledge Vault. Monitors note changes in real-time via WebSocket and suggests actions (auto-connect, verify, health alerts). Use when the user wants continuous vault monitoring or autonomous knowledge management.
---

# Watch Knowledge Vault

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

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
- After a few seconds, check `knowledgeGraphForwardLinks` and `knowledgeGraphBacklinks` for it (not the note's `links[]`, which is not the edge store)
- If it has no incoming edge (an orphan): suggest running `/powerhouse-knowledge:connect` on it
- Log: "New note '{title}' has no connections — consider linking it"

### 2. Notes Modified Without Re-verification
When a note's content changes:
- Check if it was previously verified (confidence = "grounded" or "established")
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

For direct WebSocket integration, subscribe at `ws://<the-switchboard-host>/graphql/subscriptions` (the same host as the active profile's `/graphql`):

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
mutation MutateNote($id: String!, $actions: [JSONObject!]!) {
  mutateDocument(documentIdentifier: $id, actions: $actions) {
    id name
  }
}
```

Each action must be fully stamped before it is sent:
```json
{
  "id": "2b1b1b0a-6b1e-4c1a-9b1a-6b1e4c1a9b1a",
  "type": "SET_TITLE",
  "input": {"title": "My Note", "updatedAt": "2026-03-26T21:00:00.000Z"},
  "scope": "global",
  "timestampUtcMs": "2026-03-26T21:00:00.000Z"
}
```

Required envelope fields, `id` **first**: `id` (UUID), `timestampUtcMs`, `scope`, `type`, `input`.
An action persisted without `id` permanently breaks every browser client's sync channel
(`pollSyncEnvelopes` -> non-nullable `Action.id`).

If "$ARGUMENTS" is provided, use it as the drive UUID to watch.
