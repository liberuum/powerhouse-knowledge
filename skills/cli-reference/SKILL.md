---
name: cli-reference
description: Switchboard CLI commands for Knowledge Vault operations. Use as an alternative to MCP when the CLI is available. Install with 'npm i -g @powerhousedao/switchboard-cli'.
---

# Switchboard CLI Reference

Alternative to MCP for vault operations. All commands work against local or remote Switchboard instances.

## Installation

```bash
npm i -g @powerhousedao/switchboard-cli
# or
bun add -g @powerhousedao/switchboard-cli
```

## Configuration

```bash
# Add a profile
switchboard config add local http://localhost:4001/graphql
switchboard config add remote-dev https://switchboard-dev.powerhouse.xyz/graphql

# Switch profiles
switchboard config use local
switchboard config use remote-dev

# Check connection
switchboard ping
```

## Drive Operations

```bash
# List drives
switchboard drives list

# Create a Knowledge Vault drive
switchboard drives create --name "my vault" --preferred-editor knowledge-vault

# View drive tree
switchboard docs tree <drive-slug>

# Check for ghost nodes
switchboard drives check <drive-slug>

# Fix ghost nodes
switchboard drives fix <drive-slug>
```

## Document Creation

The CLI `docs create` can timeout on schema introspection. Use GraphQL directly for creation, then `docs apply` for operations:

```bash
# Create via GraphQL (reliable)
DOC_ID=$(curl -s $REACTOR_URL/graphql/r/ \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { createEmptyDocument(documentType: \"bai/source\") { id } }"}' \
  | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.createEmptyDocument.id")

# Add to drive in correct folder
switchboard docs apply <drive-id> --wait --actions '[{
  "type": "ADD_FILE",
  "input": {
    "id": "'$DOC_ID'",
    "name": "Document Name",
    "documentType": "bai/source",
    "parentFolder": "<folder-uuid>"
  },
  "scope": "global"
}]'
```

## Dispatching Operations

Use `docs apply` with JSON actions:

```bash
# Single action
switchboard docs apply <doc-id> --wait --actions '[{
  "type": "INGEST_SOURCE",
  "input": {
    "title": "Source Title",
    "content": "Full content...",
    "sourceType": "ARTICLE",
    "createdAt": "2026-03-30T12:00:00Z"
  },
  "scope": "global"
}]'

# Multiple actions (batched)
switchboard docs apply <doc-id> --wait --actions '[
  {"type": "SET_TITLE", "input": {"title": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_DESCRIPTION", "input": {"description": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_CONTENT", "input": {"content": "...", "updatedAt": "..."}, "scope": "global"}
]'

# From a file (avoids shell escaping)
switchboard docs apply <doc-id> --wait --file actions.json
```

## CRITICAL: Two-Batch Pattern

Always separate content from provenance to prevent batch failures:

```bash
# Batch 1: Content (must succeed)
switchboard docs apply <note-id> --wait --actions '[
  {"type": "SET_TITLE", "input": {"title": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_DESCRIPTION", "input": {"description": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_NOTE_TYPE", "input": {"noteType": "concept", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_CONTENT", "input": {"content": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "ADD_TOPIC", "input": {"id": "t1", "name": "topic"}, "scope": "global"}
]'

# Batch 2: Provenance (separate so failures don't kill content)
switchboard docs apply <note-id> --wait --actions '[
  {"type": "SET_PROVENANCE", "input": {"author": "agent", "sourceOrigin": "DERIVED", "createdAt": "..."}, "scope": "global"}
]'
```

## Full Pipeline via CLI

### 1. Seed Source
```bash
# Create source
SOURCE_ID=$(curl -s $REACTOR_URL/graphql/r/ -H "Content-Type: application/json" \
  -d '{"query":"mutation { createEmptyDocument(documentType: \"bai/source\") { id } }"}' \
  | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.createEmptyDocument.id")

# Add to drive
switchboard docs apply <drive-id> --wait --actions '[{"type":"ADD_FILE","input":{"id":"'$SOURCE_ID'","name":"Source Title","documentType":"bai/source","parentFolder":"<sources-folder>"},"scope":"global"}]'

# Ingest content
switchboard docs apply $SOURCE_ID --wait --actions '[{"type":"INGEST_SOURCE","input":{"title":"...","content":"...","sourceType":"ARTICLE","createdAt":"..."},"scope":"global"}]'
```

### 2. Extract Claims
```bash
# Create each note (100ms delays)
NOTE_ID=$(curl -s $REACTOR_URL/graphql/r/ -H "Content-Type: application/json" \
  -d '{"query":"mutation { createEmptyDocument(documentType: \"bai/knowledge-note\") { id } }"}' \
  | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.createEmptyDocument.id")
sleep 0.1

# Add to drive
switchboard docs apply <drive-id> --wait --actions '[{"type":"ADD_FILE","input":{"id":"'$NOTE_ID'","name":"claim title","documentType":"bai/knowledge-note","parentFolder":"<notes-folder>"},"scope":"global"}]'

# Populate (content batch)
switchboard docs apply $NOTE_ID --wait --actions '[{"type":"SET_TITLE",...},{"type":"SET_DESCRIPTION",...}]'

# Populate (provenance batch)
switchboard docs apply $NOTE_ID --wait --actions '[{"type":"SET_PROVENANCE","input":{"author":"agent","sourceOrigin":"DERIVED","createdAt":"..."},"scope":"global"}]'
```

### 3. Connect
```bash
switchboard docs apply <note-id> --wait --actions '[
  {"type":"ADD_LINK","input":{"id":"l1","targetDocumentId":"<target>","targetTitle":"...","linkType":"RELATES_TO"},"scope":"global"}
]'
```

### 4. Update Source + Pipeline
```bash
# Mark source extracted
switchboard docs apply <source-id> --wait --actions '[{"type":"SET_SOURCE_STATUS","input":{"status":"EXTRACTED"},"scope":"global"},{"type":"ADD_EXTRACTED_CLAIM","input":{"claimRef":"<note-id>"},"scope":"global"}]'

# Track in pipeline
switchboard docs apply <pipeline-queue-id> --wait --actions '[{"type":"ADD_TASK","input":{"id":"task-1","taskType":"claim","target":"...","documentRef":"<source-id>","createdAt":"..."},"scope":"global"},{"type":"ADVANCE_PHASE","input":{"taskId":"task-1","handoff":{"id":"h1","phase":"create","workDone":"...","filesModified":[],"completedAt":"..."},"updatedAt":"..."},"scope":"global"}]'
```

### 5. Health Report
```bash
switchboard docs apply <health-report-id> --wait --actions '[{"type":"GENERATE_REPORT","input":{"generatedAt":"...","generatedBy":"knowledge-agent","mode":"full","overallStatus":"PASS","graphMetrics":{"noteCount":3,"mocCount":0,"connectionCount":6,"density":1.0,"orphanCount":0,"danglingLinkCount":0,"mocCoverage":0,"averageLinksPerNote":2},"recommendations":[]},"scope":"global"}]'
```

## Querying

```bash
# List all docs in drive
switchboard docs list --drive <slug>

# Get document state
switchboard docs get <doc-id> --format json

# View operation history
switchboard ops list <doc-id>

# Raw GraphQL
switchboard query '{ knowledgeGraphStats(driveId: "<uuid>") { nodeCount edgeCount orphanCount } }'
```

## Monitoring

```bash
# Watch for changes
switchboard watch <drive-slug>

# Export drive
switchboard export <drive-slug> --output vault-backup.phd

# Import drive
switchboard import vault-backup.phd
```
