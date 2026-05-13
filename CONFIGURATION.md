# Configuration Guide

## Reactor Connection

The plugin connects to a Powerhouse reactor via MCP. There are three ways the MCP server can be configured, and **only one should be active** to avoid conflicts.

### Priority Order (highest wins)

| Priority | Source | Tool prefix | When to use |
|----------|--------|-------------|-------------|
| 1 | **Claude.ai remote MCP config** (IDE settings) | `mcp__claude_ai_*` | Cloud-hosted Claude sessions |
| 2 | **Project root `.mcp.json`** | `mcp__reactor-mcp__*` | Local development |
| 3 | **Plugin `.mcp.json`** | `mcp__reactor-mcp__*` | Fallback/template |

**IMPORTANT:** If you have multiple configs pointing to different servers, only the highest-priority one takes effect. The others create confusion. **Use exactly one.**

### Option A: Claude.ai Remote MCP (recommended for cloud)

Configure the MCP server in Claude.ai settings (Settings > MCP Servers). The tools will be registered as `mcp__claude_ai_Powerhouse_xyz_Reactor_MCP__*` or similar.

When using this option:
- **Delete** or empty the project root `.mcp.json` (set `"mcpServers": {}`)
- The plugin's `.mcp.json` will be ignored
- The agent adapts to whatever tool prefix is available

### Option B: Project Root .mcp.json (recommended for local dev)

Place a single `.mcp.json` in your **project root** (not inside the plugin):

```json
{
  "mcpServers": {
    "reactor-mcp": {
      "url": "http://localhost:4001/mcp"
    }
  }
}
```

Tools will be `mcp__reactor-mcp__*`. Start the reactor with `ph vetra --watch`.

For remote Switchboard, change the URL:
```json
{
  "mcpServers": {
    "reactor-mcp": {
      "url": "https://your-switchboard.example.com/mcp"
    }
  }
}
```

### Option C: Plugin .mcp.json (fallback)

The plugin ships with a default `.mcp.json` pointing to `localhost:4001`. This is only used if no project root config or IDE config exists. You generally don't need to edit this.

### Tool Name Adaptation

The agent and skills reference tools as `mcp__reactor-mcp__getDrives`, `mcp__reactor-mcp__createDocument`, etc. If the actual tool prefix differs (e.g., `mcp__claude_ai_Powerhouse_xyz_Reactor_MCP__getDrives`), the agent should use whatever tools are available in the session. The function names (getDrives, getDocument, createDocument, addActions, etc.) are always the same — only the prefix changes.

### Troubleshooting

**"Unknown tool" errors:** The MCP server name in `.mcp.json` doesn't match what the session registered. Check which tools are actually available and use those.

**Tools available but wrong endpoint:** Multiple `.mcp.json` files conflict. Remove all but one. Check: project root, plugin directory, and IDE settings.

**Hook warns "reactor not reachable":** The hook reads the URL from the nearest `.mcp.json`. If you're using Claude.ai remote MCP, the hook may not find the URL. Safe to ignore — the connection works through the IDE.

The remote Switchboard must have the Knowledge Vault document models deployed (the `knowledge-note` Vetra package). All skills work identically regardless of connection method.

For GraphQL and WebSocket endpoints on remote, replace `localhost:4001` with your Switchboard domain throughout this guide.

---

## Connection Modes

The plugin supports two connection modes to the Powerhouse reactor:

### Mode 1: MCP (Default — Request/Response)

All skills use MCP by default. This is the simplest setup.

```json
// .mcp.json
{
  "mcpServers": {
    "reactor-mcp": {
      "type": "http",
      "url": "http://localhost:4001/mcp"
    }
  }
}
```

**When to use:** Standard skill-triggered workflows — user runs `/extract`, agent does work, returns results.

### Mode 2: GraphQL + WebSocket (Real-Time)

For autonomous agent behavior — watching vault changes, auto-connecting notes, health monitoring.

**Endpoints:**
```
HTTP queries/mutations:  http://localhost:4001/graphql/r
WebSocket subscriptions: ws://localhost:4001/graphql/subscriptions
Drive REST:              http://localhost:4001/d/<drive-uuid-or-slug>
```

**WebSocket subscription for document changes:**
```graphql
subscription WatchVault($search: SearchFilterInput) {
  documentChanges(search: $search) {
    type          # ADD | UPDATE | DELETE
    documents {
      id
      name
      slug
      documentType
      revisionsList { scope revision }
    }
    context {
      parentId    # drive ID
    }
  }
}
```

**Filter by drive and document type:**
```json
{
  "search": {
    "type": "bai/knowledge-note",
    "parentId": "<your-drive-id>"
  }
}
```

**Mutate via GraphQL (same connection):**
```graphql
mutation MutateNote($id: String!, $actions: [JSONObject!]!) {
  mutateDocument(documentIdentifier: $id, actions: $actions) {
    id
    name
  }
}
```

**IMPORTANT:** Each action must include `timestampUtcMs` as an ISO string:
```json
{
  "type": "SET_TITLE",
  "input": {"title": "My Note", "updatedAt": "2026-03-26T21:00:00.000Z"},
  "scope": "global",
  "timestampUtcMs": "2026-03-26T21:00:00.000Z"
}
```

### Mode 3: Switchboard CLI (Full Feature Parity)

The Switchboard CLI (v1.0.6+) provides full feature parity with MCP for all vault operations. Use `hooks/hooks-cli.json` instead of `hooks/hooks.json` to enable CLI mode.

**Setup:**
```bash
# Install CLI
curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash

# Configure local profile
switchboard config use local   # targets http://localhost:4001/graphql

# Introspect models (discovers bai/* types correctly — bai/source, not powerhouse/source)
switchboard introspect

# Create vault drive (slug becomes "knowledge-vault")
switchboard drives create --name "Knowledge Vault" --preferred-editor knowledge-vault
```

**MCP → CLI equivalents:**

| MCP Tool | CLI Command |
| -------- | ----------- |
| `getDrives()` | `switchboard drives list --format json` |
| `getDrive({ driveId })` | `switchboard docs tree <drive> --format json` |
| `getDocument({ documentId })` | `switchboard docs get <id> --state --format json` |
| `getDocuments({ parentId })` | `switchboard docs list --drive <drive> --format json` |
| `createDocument({ type, driveId, name, parentFolder })` | `switchboard docs create --type <type> --name <name> --drive <drive> --parent-folder <folder>` |
| `addActions({ documentId, actions })` | `switchboard docs mutate <id> --op <op> --input '<json>'` |
| `addActions({ documentId, actions[] })` | `switchboard docs apply <id> --actions '<json-array>'` |
| `deleteDocument({ documentId })` | `switchboard docs delete <id> -y` |
| `getDocumentModelSchema({ type })` | `switchboard models ops <type>` |

**CRITICAL: Required fields discovered during testing (the schema docs don't always match):**

Content mutations require `updatedAt: DateTime!`:
```bash
# setTitle, setDescription, setNoteType, setContent all need updatedAt
switchboard docs mutate <id> --op setTitle --input '{"title":"My Claim","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setDescription --input '{"description":"Summary","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setNoteType --input '{"noteType":"CONCEPT","updatedAt":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op setContent --input '{"content":"Full body","updatedAt":"2026-03-30T15:00:00.000Z"}'
```

Topics (per-document state):
```bash
# addTopic: uses "id" + "name" (NOT "topic")
switchboard docs mutate <id> --op addTopic --input '{"id":"topic-unique-id","name":"zettelkasten"}'
```

Relationships (since the drive-override migration, edges live in the reactor's `DocumentRelationship` table, NOT in per-document `links[]`). Use the `addRelationship` GraphQL mutation — the legacy `--op addLink` is bypassed by the graph subgraph:
```bash
switchboard query 'mutation { addRelationship(sourceIdentifier:"<source-uuid>", targetIdentifier:"<target-uuid>", relationshipType:"RELATES_TO", branch:"main"){ documentType } }'
switchboard query 'mutation { removeRelationship(sourceIdentifier:"<source-uuid>", targetIdentifier:"<target-uuid>", relationshipType:"RELATES_TO", branch:"main"){ documentType } }'
```

Valid `relationshipType`: `RELATES_TO`, `BUILDS_ON`, `CONTRADICTS`, `SUPERSEDES`, `DERIVED_FROM`, `CORE_IDEA` (MoC → note), `CHILD_MOC` (MoC → MoC). Mutation is idempotent on `(source, target, type)`.

Lifecycle mutations require `id`, `actor`, `timestamp`:
```bash
# submitForReview, approveNote, rejectNote, archiveNote, restoreNote
switchboard docs mutate <id> --op submitForReview --input '{"id":"review-1","actor":"author-name","timestamp":"2026-03-30T15:00:00.000Z"}'
switchboard docs mutate <id> --op approveNote --input '{"id":"approve-1","actor":"reviewer-name","timestamp":"2026-03-30T15:00:00.000Z"}'
# NOTE: approveNote actor must differ from the note's provenance author
```

MOC mutations:
```bash
# createMoc requires createdAt — sets title/description/orientation/tier on the MoC's state
switchboard docs mutate <moc-id> --op createMoc --input '{"title":"Topic","description":"...","orientation":"...","tier":"TOPIC","createdAt":"2026-03-30T15:00:00.000Z"}'

# Attach a note as a core idea — addRelationship with type CORE_IDEA (NOT --op addCoreIdea)
switchboard query 'mutation { addRelationship(sourceIdentifier:"<moc-id>", targetIdentifier:"<note-uuid>", relationshipType:"CORE_IDEA", branch:"main"){ documentType } }'

# Attach a child MoC — addRelationship with type CHILD_MOC (NOT --op addChildMoc)
switchboard query 'mutation { addRelationship(sourceIdentifier:"<parent-moc-id>", targetIdentifier:"<child-moc-id>", relationshipType:"CHILD_MOC", branch:"main"){ documentType } }'
```

The pre-migration `--op addCoreIdea` accepted a `contextPhrase` (the articulation: WHY this note matters in this MoC). The new `DocumentRelationship` row stores only `(source, target, type)` — articulation now lives in the source note's content body instead of on the edge.

Health report mutations:
```bash
switchboard docs mutate <hr-id> --op generateReport --input '{"generatedAt":"...","mode":"full","overallStatus":"PASS","graphMetrics":{"noteCount":3,"mocCount":1,"connectionCount":6,"density":1.0,"orphanCount":0,"danglingLinkCount":0,"mocCoverage":1.0,"averageLinksPerNote":2.0},"recommendations":["..."]}'
switchboard docs mutate <hr-id> --op addCheck --input '{"id":"chk-1","category":"ORPHAN_DETECTION","status":"PASS","message":"All notes linked","affectedItems":[]}'
```

Pipeline queue:
```bash
# addTask: uses "target" (required), NOT "documentRef" as primary
switchboard docs mutate <pq-id> --op addTask --input '{"id":"task-1","taskType":"SEED","target":"<source-uuid>","documentRef":"<source-uuid>","createdAt":"2026-03-30T15:00:00.000Z"}'
```

**Batch actions (CLI auto-injects `timestampUtcMs` and `action.id`):**
```bash
# Multiple operations via apply
switchboard docs apply <doc-id> --actions '[
  {"type":"SET_TITLE","input":{"title":"My Claim","updatedAt":"2026-03-30T15:00:00.000Z"},"scope":"global"},
  {"type":"SET_DESCRIPTION","input":{"description":"A brief summary","updatedAt":"2026-03-30T15:00:00.000Z"},"scope":"global"}
]'

# From file
switchboard docs apply <doc-id> --file actions.json --wait
```

**Subgraph queries (CLI uses raw GraphQL):**
```bash
# Graph stats
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount } }'

# Density
switchboard query '{ knowledgeGraphDensity(driveId: "<UUID>") }'

# Orphans
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { documentId title } }'

# Search
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "atomic") { documentId title } }'
```

**Watch + react to changes:**
```bash
switchboard watch docs --drive <drive-uuid> --format json
switchboard watch docs --drive <drive-uuid> --exec './on-change.sh'
```

**Export/import vault:**
```bash
switchboard export drive <drive-uuid> -o ./backup/
switchboard import ./backup/ --drive <drive-uuid>
```

**Ghost node detection and cleanup:**
```bash
# Scan for orphan file nodes pointing to missing documents
switchboard drives check <drive>

# Auto-remove ghost nodes
switchboard drives fix <drive> -y
```

**Hooks:** Copy `hooks/hooks-cli.json` to `hooks/hooks.json` to use CLI mode:
```bash
cp hooks/hooks-cli.json hooks/hooks.json
```

### Known Issues and Workarounds

**Document creation and Connect sync:** The CLI uses `Model { createDocument(parentIdentifier: driveId) }` which goes through the reactor's proper creation pipeline. Documents created this way are visible in Connect immediately. Do NOT use `createEmptyDocument` + manual `ADD_FILE` — Connect's PGLite won't sync those documents.

**Server restart after errors:** If the reactor shows `RevisionMismatchError` after a failed operation, restart the server. The retry loop will block all subsequent operations on that document until cleared.

**`--parent-folder` placement:** The CLI creates the doc at the drive root first, then moves it into the folder via `DocumentDrive { moveNode }`. This is a two-step process — if the move fails, the doc remains at the root.

**Action `id` field:** The CLI auto-generates action IDs for all `mutateDocument` operations (ADD_FILE, DELETE_NODE, etc.). This prevents null `action.id` errors in Connect's sync stream. If you use `docs apply` with raw actions, the CLI injects IDs automatically via `stamp_actions`.

**Soft delete:** `docs delete` uses non-cascading soft delete (won't destroy parent drives). `drives delete` uses CASCADE (deletes drive + all children). Ghost nodes left behind by failed operations can be cleaned up with `drives check` + `drives fix`.

## Drive Setup

### First-Time Setup

1. Start the reactor:
```bash
ph vetra --watch
```

2. Create a drive with the knowledge-vault editor:
```bash
switchboard drives create --name "My Knowledge Vault" --preferred-editor knowledge-vault
```

3. Open in Connect at `http://localhost:3001` — the vault app auto-creates:
   - Folder structure (`/knowledge/notes/`, `/sources/`, `/ops/`, `/self/`, `/research/`)
   - Singleton documents (PipelineQueue, KnowledgeGraph, VaultConfig)

4. Note the drive ID (UUID) — you'll need it for queries.

### Remote Setup

For a remote reactor, update the URLs:

```json
// .mcp.json
{
  "mcpServers": {
    "reactor-mcp": {
      "type": "http",
      "url": "https://your-reactor.example.com/mcp"
    }
  }
}
```

GraphQL endpoint: `https://your-reactor.example.com/graphql/r`
WebSocket: `wss://your-reactor.example.com/graphql/subscriptions`

## Folder Placement

When creating documents via MCP, always place them in the correct folder:

1. Read the drive to find folder IDs:
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-id>" })
```

2. Find the target folder node:
   - Knowledge Notes → `name: "notes"` inside `name: "knowledge"`
   - Sources → `name: "sources"` at root
   - Observations → `name: "ops"` at root
   - MOCs → `name: "knowledge"` at root

3. Pass `parentFolder` when creating:
```
mcp__reactor-mcp__createDocument({
  documentType: "bai/knowledge-note",
  driveId: "<drive-id>",
  name: "My Note",
  parentFolder: "<notes-folder-id>"
})
```

## Processor

The GraphIndexer processor automatically indexes all `bai/knowledge-note` operations into a relational database. Query the indexed data via:

```graphql
query {
  knowledgeGraphDebug(driveId: "<drive-id>") {
    rawNodeCount
    rawEdgeCount
    rawNodes { documentId title noteType status }
    rawEdges { sourceDocumentId targetDocumentId linkType }
    processorNamespace
  }
}
```

## Autonomous Agent Patterns

### Pattern 1: Watch and Auto-Connect (Cross-Document Reactor)

Subscribe to note changes, find related notes, auto-create links:

```
1. Subscribe to bai/knowledge-note changes
2. On new note: search for notes with overlapping topics
3. For each match: call `addRelationship(source, target, RELATES_TO)`
4. Re-entrancy guard: skip if the change was our own ADD_RELATIONSHIP system action
```

### Pattern 2: Pipeline Saga (Saga Pattern)

Chain processing phases with full traceability:

```
1. Source ingested (INGEST_SOURCE) → create extract task in pipeline-queue
2. Extract complete → advance to reflect phase
3. Reflect complete → advance to reweave phase
4. Reweave complete → advance to verify phase
5. Each phase logs handoff data for audit trail
```

### Pattern 3: Batch Import (Batch Progress)

Import multiple notes with dependencies:

```
1. Create all note documents in parallel (no dependencies)
2. Wait for all creations to complete
3. Add links between notes (depends on step 1)
4. Update pipeline-queue with import batch
```

### Pattern 4: Health Monitoring (Sync Health Monitor)

Track vault health via subscription events:

```
1. Subscribe to all document changes in the vault drive
2. Track: notes created/modified, links added, orphan count
3. Compute: density, coverage, staleness
4. Alert when thresholds exceeded (e.g., orphan count > 10)
```
