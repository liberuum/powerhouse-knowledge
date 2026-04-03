# powerhouse-knowledge

Claude Code plugin for the Powerhouse Knowledge Vault. Enables AI agents to query, create, connect, and verify knowledge notes stored as Powerhouse document models.

## What it does

This plugin connects Claude Code to a Powerhouse reactor running the Knowledge Vault document models (`bai/knowledge-note`, `bai/moc`, and 9 others). It provides 13 skills for knowledge management, an MCP server for direct document access, and an agent definition optimized for knowledge work. The Ars Contexta methodology (249 research claims) is bundled locally in `data/methodology/` and read from disk — no remote import needed.

## Prerequisites

- **Powerhouse reactor** with the Knowledge Vault document models deployed (the `bai-knowledge-note` Vetra package)
- **Claude Code** CLI installed

## Installation

### Option 1: Clone into your project

```bash
cd your-project/
git clone https://github.com/liberuum/powerhouse-knowledge .claude/plugins/powerhouse-knowledge
```

Claude Code auto-discovers plugins in `.claude/plugins/`.

### Option 2: Install as a global plugin

```bash
git clone https://github.com/liberuum/powerhouse-knowledge ~/.claude/plugins/powerhouse-knowledge
```

### Option 3: Use the plugin directory flag

```bash
git clone https://github.com/liberuum/powerhouse-knowledge /path/to/powerhouse-knowledge
claude --plugin-dir /path/to/powerhouse-knowledge
```

### Option 4: Add to CLAUDE.md for AI agents

Add this to your project's `CLAUDE.md` so any AI agent session auto-discovers the plugin:

```markdown
## Plugins

This project uses the powerhouse-knowledge plugin for knowledge vault management.
Plugin path: .claude/plugins/powerhouse-knowledge
```

## Quick Start

### 1. Connect to a reactor

**Local (development):**
```bash
cd your-powerhouse-project/
ph vetra --watch   # serves MCP at http://localhost:4001/mcp
```

The default `.mcp.json` in the plugin points to `localhost:4001` — no changes needed.

**Remote (production):**

Edit `.mcp.json` in the plugin directory:
```json
{
  "mcpServers": {
    "reactor-mcp": {
      "type": "http",
      "url": "https://your-switchboard.example.com/mcp"
    }
  }
}
```

### 2. Open Claude Code

```bash
claude   # if plugin is in .claude/plugins/
# or
claude --plugin-dir /path/to/powerhouse-knowledge
```

### 3. Initialize the vault

```
/powerhouse-knowledge:setup
```

This verifies the vault drive structure, folder layout, and singleton documents are ready. The methodology is bundled locally — no import step needed.

### 4. Start building knowledge

```
/powerhouse-knowledge:seed     # paste an article or transcript
/powerhouse-knowledge:pipeline # extract claims, connect, verify
/powerhouse-knowledge:health   # check vault quality
```

## For AI Agents

If you're an AI agent (Claude, Gemini, or other) working in a repo with this plugin:

### Available MCP Tools

The plugin connects to a Powerhouse reactor via MCP. These tools are available:

| Tool | Purpose |
|------|---------|
| `mcp__reactor-mcp__getDrives` | List all drives |
| `mcp__reactor-mcp__getDrive` | Get drive structure (folders, files) |
| `mcp__reactor-mcp__getDocument` | Read a document's state |
| `mcp__reactor-mcp__getDocuments` | List documents in a drive |
| `mcp__reactor-mcp__createDocument` | Create a new document (use `driveId` + `parentFolder`) |
| `mcp__reactor-mcp__addActions` | Dispatch operations on a document |
| `mcp__reactor-mcp__deleteDocument` | Delete a document |
| `mcp__reactor-mcp__getDocumentModelSchema` | Get schema for a document type |

### Key Document Types

| Type | Purpose | Folder |
|------|---------|--------|
| `bai/knowledge-note` | Atomic knowledge claims | `/knowledge/notes/` |
| `bai/source` | Raw input material | `/sources/` |
| `bai/moc` | Maps of Content (topic navigation) | `/knowledge/` |
| _(methodology)_ | _(local: `data/methodology/*.md`, not in vault)_ | _(plugin directory)_ |
| `bai/pipeline-queue` | Processing pipeline tracker (singleton) | `/ops/queue/` |
| `bai/health-report` | Vault health diagnostics (singleton) | `/ops/health/` |
| `bai/vault-config` | Vault configuration (singleton) | `/self/` |
| `bai/knowledge-graph` | Materialized graph (singleton) | `/self/` |

### Important Patterns

**MCP race condition:** When creating multiple documents, add a 100ms delay between each `createDocument` call. Rapid calls can cause drive file nodes to silently fail.

**Two-batch actions:** Split content actions (SET_TITLE, SET_DESCRIPTION, SET_CONTENT) from provenance actions (SET_PROVENANCE) into separate `addActions` calls. If provenance validation fails, it kills the entire batch.

**Valid sourceOrigin values:** `DERIVED` (extracted from source), `IMPORT` (bulk import), `MANUAL` (user-created), `SESSION_MINE` (session capture).

**Folder placement:** Always read the drive first to find folder UUIDs, then pass `parentFolder` when creating documents.

### Subgraph Queries

The Knowledge Graph subgraph is at `/graphql/knowledgeGraph` (not `/graphql/r/`):

```bash
curl -s http://localhost:4001/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphStats(driveId: \"<UUID>\") { nodeCount edgeCount orphanCount } }"}'
```

Available: `knowledgeGraphStats`, `knowledgeGraphNodes`, `knowledgeGraphEdges`, `knowledgeGraphOrphans`, `knowledgeGraphSearch`, `knowledgeGraphTriangles`, `knowledgeGraphBridges`, `knowledgeGraphDensity`, `knowledgeGraphBacklinks`, `knowledgeGraphForwardLinks`, `knowledgeGraphConnections`, `knowledgeGraphDebug`.

### Processing Pipeline

The 6R pipeline: Record -> Reduce -> Reflect -> Reweave -> Verify -> Rethink

```
Source (article/transcript)
  -> /seed (creates bai/source in /sources/)
  -> /extract (creates bai/knowledge-note docs in /knowledge/notes/)
  -> /connect (adds typed links between notes)
  -> /synthesize (creates bai/moc docs from topic clusters)
  -> /verify (auto-repairs missing descriptions/provenance, quality gate)
  -> /health (writes results to bai/health-report)
```

## Skills

### Setup & Import

| Skill | Command | Description |
|-------|---------|-------------|
| Setup | `/powerhouse-knowledge:setup` | Verify vault structure, folders, and singletons are ready |
| Import | `/powerhouse-knowledge:import <path>` | Bulk import from markdown, Obsidian, or Ars Contexta vaults |
| Export | `/powerhouse-knowledge:export [path]` | Export vault as markdown, JSON, or .phd backup |

### Knowledge Management (Core)

| Skill | Command | Description |
|-------|---------|-------------|
| Synthesize | `/powerhouse-knowledge:synthesize` | Create MOCs from topic clusters (3+ notes per topic) |
| Search | `/powerhouse-knowledge:search <query>` | Find notes by title, type, topic, content |
| Extract | `/powerhouse-knowledge:extract <source>` | Extract atomic claims from source material |
| Connect | `/powerhouse-knowledge:connect <note>` | Find and create links between notes |
| Verify | `/powerhouse-knowledge:verify <note>` | Run quality checks + auto-repair (recite, schema, health) |
| Health | `/powerhouse-knowledge:health` | Vault health report saved to bai/health-report document |
| Graph | `/powerhouse-knowledge:graph` | Structural analysis (triangles, bridges, clusters) |
| Seed | `/powerhouse-knowledge:seed <source>` | Ingest source material for processing |

### Processing & Automation

| Skill | Command | Description |
|-------|---------|-------------|
| Pipeline | `/powerhouse-knowledge:pipeline` | Run the full extract -> connect -> synthesize -> reweave -> verify flow |
| Watch | `/powerhouse-knowledge:watch` | Real-time vault monitoring via WebSocket |

## Agent

The plugin includes a `knowledge-agent` that activates by default. This agent:
- Understands all 11 document models and their operations
- Follows the 6-phase processing pipeline (Record, Reduce, Reflect, Reweave, Verify, Rethink)
- Enforces quality principles (atomic claims, articulation test, minimum connectivity)
- References the Ars Contexta methodology (249 research claims, bundled locally) for design decisions
- Auto-repairs common issues during verification (missing descriptions, provenance, types)
- Can analyze graph structure for synthesis opportunities

## Document Models

| Model | Type | Operations | Purpose |
|-------|------|-----------|---------|
| Knowledge Note | `bai/knowledge-note` | 26 | Atomic knowledge claims |
| _(Methodology)_ | _(local files)_ | _(249 claims)_ | _(bundled in `data/methodology/`)_ |
| Knowledge Graph | `bai/knowledge-graph` | 7 | Materialized graph singleton |
| Map of Content | `bai/moc` | 12 | Topic navigation |
| Source | `bai/source` | 4 | Ingested source material |
| Pipeline Queue | `bai/pipeline-queue` | 7 | Processing pipeline state |
| Observation | `bai/observation` | 4 | Operational learning signals |
| Tension | `bai/tension` | 4 | Unresolved contradictions |
| Vault Config | `bai/vault-config` | 8 | Vault configuration |
| Derivation | `bai/derivation` | 4 | Configuration audit trail |
| Health Report | `bai/health-report` | 2 | Point-in-time diagnostics |

## Architecture

```
User (Connect App)                    AI Agent (Claude Code)
  |                                     |
  +-- Knowledge Vault App               +-- powerhouse-knowledge plugin
  |     |-- Notes, Graph, Sources        |     |-- 13 skills
  |     |-- Pipeline, Health, Config     |     |-- knowledge-agent
  |     +-- Source editor (Queue)        |     +-- .mcp.json
  |                                     |
  +--------- Powerhouse Reactor --------+
              |-- 11 document models (82 operations)
              |-- Graph Indexer processor
              |-- Knowledge Graph subgraph (12 queries)
              +-- MCP server (localhost:4001/mcp)
```

## License

AGPL-3.0-only
