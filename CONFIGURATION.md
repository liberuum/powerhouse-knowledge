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

### Mode 3: Switchboard CLI (Scripting)

For batch operations, debugging, and automation scripts.

```bash
# Create documents
switchboard docs create --type 'bai/knowledge-note' --name 'My Note' --drive <drive-uuid>

# Apply actions (auto-injects timestamps)
switchboard docs apply <doc-id> --file actions.json --wait

# Watch changes in real-time
switchboard watch docs --drive <drive-uuid> --format json

# Export vault
switchboard export drive <drive-uuid> -o ./backup/
```

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
3. For each match: dispatch ADD_LINK with context phrase
4. Re-entrancy guard: skip if the change was our own link addition
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
