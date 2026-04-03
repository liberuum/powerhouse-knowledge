---
name: cli-reference
description: Switchboard CLI commands for Knowledge Vault operations. Use as an alternative to MCP when the CLI is available. Install from GitHub releases.
---

# Switchboard CLI Reference

Alternative to MCP for vault operations. All commands work against local or remote Switchboard instances.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash
```

## Configuration

```bash
# Switch to local profile (targets http://localhost:4001/graphql)
switchboard config use local

# Check connection
switchboard ping

# Introspect models (discovers bai/* types — run once after API changes)
switchboard introspect
```

## Drive Operations

```bash
# List drives
switchboard drives list --format table

# Create a Knowledge Vault drive
switchboard drives create --name "Knowledge Vault" --preferred-editor knowledge-vault

# View drive tree (all drives or specific)
switchboard docs tree
switchboard docs tree <drive-slug>

# Get drive tree as flat JSON with folder IDs (for scripting)
switchboard docs tree <drive-slug> --format json

# Check for ghost nodes
switchboard drives check <drive-slug>

# Fix ghost nodes
switchboard drives fix <drive-slug> -y

# Delete a drive (cascades to children)
switchboard drives delete <drive-slug> -y
```

## Document Creation

The CLI uses `Model { createDocument(parentIdentifier) }` which goes through the reactor's proper creation pipeline — documents are visible in Connect immediately.

```bash
# Create document in a drive
switchboard docs create --type bai/knowledge-note --name "My Note" --drive knowledge-vault

# Create document in a specific folder
switchboard docs create --type bai/source --name "Source" --drive knowledge-vault --parent-folder <folder-uuid>

# Find folder UUIDs from the tree
switchboard docs tree knowledge-vault --format json
```

**NOTE:** Do NOT use `createEmptyDocument` + manual `ADD_FILE` — Connect's PGLite won't sync those documents.

## Mutations via Interactive Editor

```bash
# Interactive: pick operation, fill fields one by one
switchboard docs mutate <doc-id>

# Skip operation picker
switchboard docs mutate <doc-id> --op setTitle

# Scripted with JSON input
switchboard docs mutate <doc-id> --op setTitle --input '{"title":"My Claim","updatedAt":"2026-03-30T15:00:00.000Z"}'
```

## Dispatching Raw Actions

The CLI auto-injects `timestampUtcMs` and `action.id` on all actions.

```bash
# Single action
switchboard docs apply <doc-id> --actions '[{
  "type": "INGEST_SOURCE",
  "input": {
    "title": "Source Title",
    "content": "Full content...",
    "sourceType": "ARTICLE",
    "createdAt": "2026-03-30T12:00:00.000Z"
  },
  "scope": "global"
}]'

# Multiple actions (batched)
switchboard docs apply <doc-id> --actions '[
  {"type": "SET_TITLE", "input": {"title": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_DESCRIPTION", "input": {"description": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_CONTENT", "input": {"content": "...", "updatedAt": "..."}, "scope": "global"}
]'

# From a file (avoids shell escaping)
switchboard docs apply <doc-id> --file actions.json --wait
```

## CRITICAL: Required Fields

Content mutations require `updatedAt: DateTime!`:
```bash
switchboard docs mutate <id> --op setTitle --input '{"title":"...","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setDescription --input '{"description":"...","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setNoteType --input '{"noteType":"CONCEPT","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setContent --input '{"content":"...","updatedAt":"2026-03-30T15:00:00.000Z"}'
```

Linking uses `id` + `targetDocumentId` + `linkType` (NOT `targetId`):
```bash
switchboard docs mutate <id> --op addLink --input '{"id":"link-1","targetDocumentId":"<target-uuid>","targetTitle":"Target","linkType":"RELATES_TO"}'
```

Topics use `id` + `name` (NOT `topic`):
```bash
switchboard docs mutate <id> --op addTopic --input '{"id":"t1","name":"zettelkasten"}'
```

Lifecycle mutations require `id`, `actor`, `timestamp`:
```bash
switchboard docs mutate <id> --op submitForReview --input '{"id":"rev-1","actor":"author","timestamp":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op approveNote --input '{"id":"appr-1","actor":"reviewer","timestamp":"2026-03-30T15:00:00.000Z"}'
```

Provenance:
```bash
switchboard docs mutate <id> --op setProvenance --input '{"author":"agent","sourceOrigin":"DERIVED","createdAt":"2026-03-30T15:00:00.000Z"}'
```

MOC:
```bash
switchboard docs mutate <moc-id> --op createMoc --input '{"title":"Topic","description":"...","orientation":"...","tier":"TOPIC","createdAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <moc-id> --op addCoreIdea --input '{"id":"ci-1","noteRef":"<note-uuid>","contextPhrase":"WHY this note matters","sortOrder":0,"addedAt":"2026-03-30T15:00:00.000Z","addedBy":"agent"}'
```

Health report:
```bash
switchboard docs mutate <hr-id> --op generateReport --input '{"generatedAt":"...","mode":"full","overallStatus":"PASS","graphMetrics":{...},"recommendations":[...]}'
switchboard docs mutate <hr-id> --op addCheck --input '{"id":"chk-1","category":"ORPHAN_DETECTION","status":"PASS","message":"All notes linked","affectedItems":[]}'
```

Pipeline queue (`target` is required, NOT `documentRef`):
```bash
switchboard docs mutate <pq-id> --op addTask --input '{"id":"task-1","taskType":"SEED","target":"<source-uuid>","documentRef":"<source-uuid>","createdAt":"2026-03-30T15:00:00.000Z"}'
```

## CRITICAL: Operation Order Bug in `docs apply`

**`docs apply` reverses operation order** when batching dependent actions. If action B depends on action A creating state, B executes before A and fails with errors like "Task not found".

**Safe to batch:** Independent actions (SET_TITLE + SET_DESCRIPTION + SET_CONTENT) — order doesn't matter.

**Must be sequential:** Dependent actions (ADD_TASK then ASSIGN_TASK then ADVANCE_PHASE) — use `docs mutate` one at a time:
```bash
switchboard docs mutate <id> --op addTask --input '{...}'
switchboard docs mutate <id> --op assignTask --input '{...}'
switchboard docs mutate <id> --op advancePhase --input '{...}'
```

## Two-Batch Pattern

Separate content from provenance to prevent batch failures:

```bash
# Batch 1: Content
switchboard docs apply <note-id> --actions '[
  {"type": "SET_TITLE", "input": {"title": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_DESCRIPTION", "input": {"description": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_NOTE_TYPE", "input": {"noteType": "CONCEPT", "updatedAt": "..."}, "scope": "global"},
  {"type": "SET_CONTENT", "input": {"content": "...", "updatedAt": "..."}, "scope": "global"},
  {"type": "ADD_TOPIC", "input": {"id": "t1", "name": "topic"}, "scope": "global"}
]'

# Batch 2: Provenance (separate — validation failures won't kill content)
switchboard docs apply <note-id> --actions '[
  {"type": "SET_PROVENANCE", "input": {"author": "agent", "sourceOrigin": "DERIVED", "createdAt": "..."}, "scope": "global"}
]'
```

## Full Pipeline via CLI

### 1. Seed Source
```bash
SOURCE_ID=$(switchboard docs create --type bai/source --name "Source Title" --drive knowledge-vault --parent-folder <sources-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $SOURCE_ID --op ingestSource --input '{"title":"...","content":"...","sourceType":"ARTICLE","createdAt":"2026-03-30T12:00:00.000Z","createdBy":"agent"}'
```

### 2. Extract Claims
```bash
NOTE_ID=$(switchboard docs create --type bai/knowledge-note --name "Claim title" --drive knowledge-vault --parent-folder <notes-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# Content batch
switchboard docs mutate $NOTE_ID --op setTitle --input '{"title":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setDescription --input '{"description":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setNoteType --input '{"noteType":"CONCEPT","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setContent --input '{"content":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op addTopic --input '{"id":"t1","name":"topic"}'

# Provenance batch (separate)
switchboard docs mutate $NOTE_ID --op setProvenance --input '{"author":"agent","sourceOrigin":"DERIVED","createdAt":"..."}'
```

### 3. Connect
```bash
switchboard docs mutate <note-id> --op addLink --input '{"id":"l1","targetDocumentId":"<target>","targetTitle":"Target Note","linkType":"RELATES_TO"}'
```

### 4. Synthesize (MOC)
```bash
MOC_ID=$(switchboard docs create --type bai/moc --name "Topic Name" --drive knowledge-vault --parent-folder <knowledge-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $MOC_ID --op createMoc --input '{"title":"Topic","description":"...","orientation":"...","tier":"TOPIC","createdAt":"..."}'
switchboard docs mutate $MOC_ID --op addCoreIdea --input '{"id":"ci-1","noteRef":"<note-uuid>","contextPhrase":"WHY this note matters","sortOrder":0,"addedAt":"...","addedBy":"agent"}'
```

### 5. Pipeline Tracking (MUST be sequential — never batch!)

**`docs apply` reverses dependent operations.** Always use `docs mutate` one at a time:

```bash
PQ=<pipeline-queue-id>
SOURCE=<source-id>

# Step 1: Add task
switchboard docs mutate $PQ --op addTask --input '{"id":"task-1","taskType":"claim","target":"Source Title","documentRef":"'$SOURCE'","createdAt":"2026-03-30T16:00:00Z"}'

# Step 2: Assign
switchboard docs mutate $PQ --op assignTask --input '{"taskId":"task-1","assignedTo":"knowledge-agent","updatedAt":"2026-03-30T16:00:01Z"}'

# Step 3: Advance create phase
switchboard docs mutate $PQ --op advancePhase --input '{"taskId":"task-1","handoff":{"id":"h-create","phase":"create","workDone":"Extracted N claims","filesModified":["<note-ids>"],"completedAt":"2026-03-30T16:01:00Z","completedBy":"knowledge-agent"},"updatedAt":"2026-03-30T16:01:00Z"}'

# Step 4: Assign reflect
switchboard docs mutate $PQ --op assignTask --input '{"taskId":"task-1","assignedTo":"knowledge-agent","updatedAt":"2026-03-30T16:01:01Z"}'

# Step 5: Advance reflect phase
switchboard docs mutate $PQ --op advancePhase --input '{"taskId":"task-1","handoff":{"id":"h-reflect","phase":"reflect","workDone":"N links + MOC created","filesModified":["<ids>"],"completedAt":"2026-03-30T16:02:00Z","completedBy":"knowledge-agent"},"updatedAt":"2026-03-30T16:02:00Z"}'

# Step 6-7: Assign + advance reweave
switchboard docs mutate $PQ --op assignTask --input '{"taskId":"task-1","assignedTo":"knowledge-agent","updatedAt":"2026-03-30T16:02:01Z"}'
switchboard docs mutate $PQ --op advancePhase --input '{"taskId":"task-1","handoff":{"id":"h-reweave","phase":"reweave","workDone":"No older notes to update","filesModified":[],"completedAt":"2026-03-30T16:02:30Z","completedBy":"knowledge-agent"},"updatedAt":"2026-03-30T16:02:30Z"}'

# Step 8-9: Assign + advance verify (final — auto-completes task to DONE)
switchboard docs mutate $PQ --op assignTask --input '{"taskId":"task-1","assignedTo":"knowledge-agent","updatedAt":"2026-03-30T16:03:00Z"}'
switchboard docs mutate $PQ --op advancePhase --input '{"taskId":"task-1","handoff":{"id":"h-verify","phase":"verify","workDone":"All notes PASS","filesModified":["<ids>"],"completedAt":"2026-03-30T16:03:00Z","completedBy":"knowledge-agent"},"updatedAt":"2026-03-30T16:03:00Z"}'
```

### 6. Methodology Cross-Reference (Local)

Methodology claims are read from the plugin's local `data/methodology/*.md` files, not from the remote vault. Use Grep/Read tools to search them:

```bash
# Search local methodology files by keyword
grep -rl "local-first" data/methodology/*.md

# Read a specific claim
cat "data/methodology/claim title.md"
```

After finding a matching claim, reference it in the note's content (via SET_CONTENT), not as a document link.

### 7. Lifecycle
```bash
switchboard docs mutate <note-id> --op submitForReview --input '{"id":"rev-1","actor":"author","timestamp":"..."}'
switchboard docs mutate <note-id> --op approveNote --input '{"id":"appr-1","actor":"reviewer","timestamp":"..."}'
```

### 8. Health Report
```bash
switchboard query '{ knowledgeGraphStats(driveId: "<uuid>") { nodeCount edgeCount orphanCount } }'
switchboard query '{ knowledgeGraphDensity(driveId: "<uuid>") }'
switchboard query '{ knowledgeGraphOrphans(driveId: "<uuid>") { documentId title } }'

switchboard docs mutate <health-report-id> --op generateReport --input '{"generatedAt":"...","mode":"full","overallStatus":"PASS","graphMetrics":{"noteCount":3,"mocCount":1,"connectionCount":6,"density":1.0,"orphanCount":0,"danglingLinkCount":0,"mocCoverage":1.0,"averageLinksPerNote":2.0},"recommendations":["..."]}'
switchboard docs mutate <health-report-id> --op addCheck --input '{"id":"chk-1","category":"ORPHAN_DETECTION","status":"PASS","message":"All notes linked","affectedItems":[]}'
```

## Querying

```bash
# List all docs in drive
switchboard docs list --drive <slug> --format table

# Get document state
switchboard docs get <doc-id> --state --format json

# View operation history
switchboard ops <doc-id> --format json

# Show parent drive
switchboard docs parents <doc-id>

# Raw GraphQL (subgraph queries)
switchboard query '{ knowledgeGraphStats(driveId: "<uuid>") { nodeCount edgeCount orphanCount } }'
switchboard query '{ knowledgeGraphSearch(driveId: "<uuid>", query: "atomic") { documentId title } }'
switchboard query '{ knowledgeGraphNodes(driveId: "<uuid>") { documentId title noteType status } }'
```

## Monitoring

```bash
# Watch for changes (real-time via WebSocket)
switchboard watch docs --drive <drive-uuid> --format json

# React to changes (pipe event JSON to a command)
switchboard watch docs --drive <drive-uuid> --exec './on-change.sh'

# Export drive (preserves full operation history)
switchboard export drive <drive-uuid> -o ./backup/

# Import drive
switchboard import ./backup/ --drive <drive-uuid>
```

## Document Relationships

```bash
# Add doc to a drive
switchboard docs add-to <drive-id> <doc-id>

# Remove doc from a drive (doc still exists, just unlinked)
switchboard docs remove-from <drive-id> <doc-id>

# Move doc between drives
switchboard docs move <doc-id> --from <src-drive> --to <dst-drive>

# Delete doc (non-cascading — drive survives)
switchboard docs delete <doc-id> -y

# Delete drive (CASCADE — deletes drive + all children)
switchboard drives delete <drive-slug> -y
```

## Methodology Reference (Local)

The 249 Ars Contexta research claims are bundled with the plugin in `data/methodology/*.md`. They are read directly from disk by the agent — no import to the vault is needed.

```bash
# List all methodology files
ls data/methodology/*.md | wc -l  # Should be 249

# Search by keyword
grep -rl "cognitive offloading" data/methodology/*.md

# Read a specific claim's frontmatter
head -20 "data/methodology/cognitive offloading is the architectural foundation for vault design.md"
```
