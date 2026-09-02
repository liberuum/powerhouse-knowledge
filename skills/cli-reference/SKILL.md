---
name: cli-reference
description: Switchboard CLI commands for Knowledge Vault operations. Use as an alternative to MCP when the CLI is available. Install from GitHub releases.
---

# Switchboard CLI Reference

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

> **The golden rule: read however you like — write ONLY through the CLI.**
> Reads (queries, searches, state checks) are safe over raw GraphQL and faster (~0.2s vs ~1-2s).
> Writes (create, mutate, link) go through the `switchboard` CLI or the vetted scripts: they
> auto-stamp every action with `id` + `timestampUtcMs` and resolve drive slugs to UUIDs.
> A single raw write missing the action `id` permanently breaks sync for every connected client.
> Bulk writes: batch into one `switchboard docs apply --file` call.
> CLI ≥ 1.0.32 refuses `apply`/`mutate` payloads whose strings carry a literal `\n`/`\t`/`\r` (double-encoded line breaks) and names the field; `--allow-literal-escapes` overrides for a string that genuinely contains that text.
> If you must write raw anyway, follow every rule in CONFIGURATION.md → "Writing via raw GraphQL — the safety rules".

Alternative to MCP for vault operations. All commands work against local or remote Switchboard instances.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash
```

## Configuration

```bash
# Switch profiles — names are whatever the user created; e.g. a local `ph vetra`
# profile typically points at http://localhost:4001/graphql
switchboard config use <profile-name>

# Check connection
switchboard ping

# Introspect models (discovers bai/* types — run once after API changes)
switchboard introspect
```

## Drive Operations

```bash
# List drives (table gains a "Docs" column on CLI >= 1.0.29; JSON gains
# "documentCount" — the number of file nodes, folders excluded)
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
switchboard docs create --type bai/knowledge-note --name "My Note" --drive <drive-slug>

# Create document in a specific folder
switchboard docs create --type bai/source --name "Source" --drive <drive-slug> --parent-folder <folder-uuid>

# Find folder UUIDs from the tree
switchboard docs tree <drive-slug> --format json
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

### CLI version notes

Current CLI is **1.0.30**. `switchboard --version` to check; install from source
with `cargo install --path . --force` in the switchboard-cli checkout.

- **>= 1.0.29** — `drives list` reports a document count per drive (`Docs`
  column / `documentCount` in JSON). Handy for confirming a drive is the vault
  and not an empty scratch drive before writing to it.
- **>= 1.0.29** — `docs delete` also removes the drive node, so deleted
  documents no longer linger as ghost entries in `docs tree`.
- **>= 1.0.29** — `docs parents <id>` reports every drive containing the
  document (it scans drive state rather than the relationship index, which
  ADD_FILE/DELETE_NODE do not maintain).

#### `docs get --drive` (fixed in v1.0.28)

- `switchboard docs get <id> --drive <slug>` requires **CLI >= 1.0.28**. Older versions
  built a compound identifier the reactor cannot resolve, so every drive-scoped get
  failed with a false "Document not found" — on old CLIs, omit `--drive` on `docs get`.
- Since 1.0.28, `--drive` on `docs get` is an honest scope: a direct hit outside the
  drive errors with "exists but is not in drive <d>" (omit `--drive` to fetch it anyway).
- Drive **slugs are per-server** (`drives list` shows them). A human-readable slug
  exists only on the server where that drive was created; on local dev reactors the
  slug is often just the drive UUID. Never reuse a slug across profiles without
  checking — read it from `drives list` (or the pre-flight hook's `VAULT_DRIVE_SLUG`)
  on the profile you are actually targeting.
- A parallel session can switch your default profile — pin commands with `-p <profile>`
  or run `switchboard config show` before write batches.
- Transient "Document not found" right after a write: just retry (read-model lag).


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
switchboard docs mutate <id> --op setNoteType --input '{"noteType":"concept","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setContent --input '{"content":"...","updatedAt":"2026-03-30T15:00:00.000Z"}'
```

Linking — since the drive-override migration, relationships are stored in the reactor's `DocumentRelationship` table; create and remove them with `switchboard docs link` / `docs unlink` (CLI ≥ 1.0.34 — a signed `ADD_RELATIONSHIP`; the raw `addRelationship` mutation is the unsigned fallback on older CLIs). The graph subgraph reads from this table; the legacy `--op addLink` writes to a per-doc `links[]` array that the subgraph no longer indexes.

```bash
switchboard docs link <source-uuid> <target-uuid> -t RELATES_TO

# remove
switchboard docs unlink <source-uuid> <target-uuid> -t RELATES_TO
```

Valid `relationshipType` values: `RELATES_TO`, `BUILDS_ON`, `CONTRADICTS`, `SUPERSEDES`, `DERIVED_FROM`, `CORE_IDEA` (MoC → note), `CHILD_MOC` (MoC → MoC). The mutation writes one row to `DocumentRelationship` and emits an `ADD_RELATIONSHIP` system action on the source document's op log; idempotent on `(source, target, type)`.

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
# Create the MoC document and set its title/orientation/tier
switchboard docs mutate <moc-id> --op createMoc --input '{"title":"Topic","description":"...","orientation":"...","tier":"TOPIC","createdAt":"2026-03-30T15:00:00.000Z"}'

# Attach a note as a CORE_IDEA of this MoC — same docs link path as note↔note links
switchboard docs link <moc-id> <note-uuid> -t CORE_IDEA

# Attach a child MoC under a parent (hub/domain hierarchy)
switchboard docs link <parent-moc-id> <child-moc-id> -t CHILD_MOC
```

Note: the legacy `--op addCoreIdea` / `--op addChildMoc` ops wrote `contextPhrase` and ordering fields into the MoC's state. The drive-override pattern drops these — articulation (why this note belongs to this MoC) lives in the source note's content body rather than as metadata on the edge.

Health report:
```bash
switchboard docs mutate <hr-id> --op generateReport --input '{"generatedAt":"...","mode":"full","overallStatus":"PASS","graphMetrics":{...},"recommendations":[...]}'
switchboard docs mutate <hr-id> --op addCheck --input '{"id":"chk-1","category":"ORPHAN_DETECTION","status":"PASS","message":"All notes linked","affectedItems":[]}'
```

Pipeline queue (`target` is a human-readable title/label and is required; `documentRef` carries
the referenced document's UUID and is optional):
```bash
switchboard docs mutate <pq-id> --op addTask --input '{"id":"task-1","taskType":"claim","target":"Source Title","documentRef":"<source-uuid>","createdAt":"2026-03-30T15:00:00.000Z"}'
```

## Batching with `docs apply`: ordered, per-action isolated, silently partial

**Verified 2026-09-02 (CLI 1.0.32, reactor 6.2.2-dev.71):**

- **Order is preserved.** Two `SET_TITLE`s in one batch landed at increasing indices in the order given; the last won.
- **Failures are isolated per action.** A batch of `[SET_TITLE, SET_DESCRIPTION(300 chars), SET_METADATA_FIELD]` applied the title and the metadata; the over-long description was recorded with `DescriptionTooLongError` and skipped. Same for an invalid `sourceOrigin` enum on `SET_PROVENANCE`.
- **Dependent chains work.** `[ADD_TASK, ASSIGN_TASK, ADVANCE_PHASE]` in one batch created, assigned and advanced the task; `[ADVANCE_PHASE ×3]` walked a task from `reflect` to `DONE` and bumped `completedCount` exactly once.
- **The job does not tell you — the operation log does.** `--wait` returned `error: null` / `READ_READY` in every failing case, but each rejected action is recorded with its reason in `operations { index error action { type } }` on the reactor endpoint (`"Description exceeds 200 characters"`, or the zod issue listing the allowed enum values). Query it with `filter: { scopes: ["global"], sinceRevision: N }` to see only your batch. The plugin's PostToolUse hook does this after every apply/mutate and prints the rejections.

So: **lint the file first, batch to save round trips, then read state back to confirm every intended effect.** `node scripts/lint-actions.mjs <actions.json>` (in the plugin repo) catches, before dispatch, the things the reactor rejects silently: a knowledge-note description over 200 UTF-16 units — the only hard length limit in any bai/* model — any enum outside its set (`noteType`, `sourceOrigin`, `SourceStatus`, `taskType`, `HealthCategory`, `MocTier`, `ObservationCategory`, …), missing `scope`, and double-encoded line breaks. Exit 1 with the JSON path of each finding. Earlier versions of this file claimed order was reversed and that any failure rejected the whole batch — both are false on the current stack.

**Pipeline in one call:**
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
  {"type": "SET_NOTE_TYPE", "input": {"noteType": "concept", "updatedAt": "..."}, "scope": "global"},
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
SOURCE_ID=$(switchboard docs create --type bai/source --name "Source Title" --drive <drive-slug> --parent-folder <sources-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $SOURCE_ID --op ingestSource --input '{"title":"...","content":"...","sourceType":"ARTICLE","createdAt":"2026-03-30T12:00:00.000Z","createdBy":"agent"}'
```

### 2. Extract Claims
```bash
NOTE_ID=$(switchboard docs create --type bai/knowledge-note --name "Claim title" --drive <drive-slug> --parent-folder <notes-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# Content batch
switchboard docs mutate $NOTE_ID --op setTitle --input '{"title":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setDescription --input '{"description":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setNoteType --input '{"noteType":"concept","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op setContent --input '{"content":"...","updatedAt":"..."}'
switchboard docs mutate $NOTE_ID --op addTopic --input '{"id":"t1","name":"topic"}'

# Provenance batch (separate)
switchboard docs mutate $NOTE_ID --op setProvenance --input '{"author":"agent","sourceOrigin":"DERIVED","createdAt":"..."}'
```

### 3. Connect
```bash
# Note-to-note (or note-to-MoC) relationship — writes to DocumentRelationship table
switchboard docs link <note-id> <target-id> -t RELATES_TO
```

### 4. Synthesize (MOC)
```bash
MOC_ID=$(switchboard docs create --type bai/moc --name "Topic Name" --drive <drive-slug> --parent-folder <knowledge-folder> --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $MOC_ID --op createMoc --input '{"title":"Topic","description":"...","orientation":"...","tier":"TOPIC","createdAt":"..."}'

# Attach notes as CORE_IDEA edges — same docs link surface as note↔note
switchboard docs link <moc-id> <note-uuid> -t CORE_IDEA
```

### 5. Pipeline Tracking (batchable — read the task back afterwards)

**These can go in one `docs apply` batch** (order preserved, failures isolated) — but read the task back afterwards and confirm its `status`, `currentPhase` and handoff count, since a rejected action is skipped silently. Shown as separate `mutate` calls here only so each op's shape is visible:

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
