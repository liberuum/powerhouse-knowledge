# powerhouse-knowledge

Claude Code plugin for the Powerhouse Knowledge Vault. Enables AI agents and humans to query, create, connect, and verify knowledge notes stored as Powerhouse document models.

## What This Plugin Does

This plugin gives you (human or AI agent) the ability to manage a structured knowledge graph inside a Powerhouse reactor. It provides:

- **14 skills** for knowledge management (seed, extract, connect, search, verify, health, graph, etc.)
- **A knowledge-agent** definition optimized for knowledge work via the Switchboard CLI
- **Connection to a Powerhouse reactor** via MCP or Switchboard CLI
- **Access to the Graph Indexer** — a relational index with keyword search, topic queries, provenance filtering, and AI-powered semantic search

The vault stores knowledge as `bai/knowledge-note` documents — atomic claims with typed links, topics, provenance, and lifecycle states. Notes are organized by Maps of Content (MOCs), processed through a 6-phase pipeline, and visualized as an interactive graph.

## Prerequisites

- **Powerhouse reactor** running with the `bai-knowledge-note` Vetra package deployed
- **Claude Code** CLI installed (for AI agent use)
- **Switchboard CLI** installed (recommended — `curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash`)

## Installation

### Option 1: Clone into your project (recommended)

```bash
cd your-project/
git clone https://github.com/liberuum/powerhouse-knowledge .claude/plugins/powerhouse-knowledge
```

Claude Code auto-discovers plugins in `.claude/plugins/`.

### Option 2: Global plugin

```bash
git clone https://github.com/liberuum/powerhouse-knowledge ~/.claude/plugins/powerhouse-knowledge
```

### Option 3: Plugin directory flag

```bash
claude --plugin-dir /path/to/powerhouse-knowledge
```

## Quick Start

### Step 1: Connect to a reactor

**Local development:**
```bash
cd your-powerhouse-project/
ph vetra --watch   # starts reactor at localhost:4001
```

**Remote (Switchboard):**
```bash
switchboard config use remote-dev   # or your profile name
switchboard ping                     # verify connection
```

See [CONFIGURATION.md](CONFIGURATION.md) for detailed connection options (MCP, CLI, GraphQL).

### Step 2: Verify the vault

```bash
switchboard drives list --format json   # find the vault drive
switchboard docs tree <drive-slug> --format json   # check folder structure
```

Or use the setup skill:
```
/powerhouse-knowledge:setup
```

### Step 3: Start working

**Seed a source (article, transcript, documentation):**
```
/powerhouse-knowledge:seed
```

**Run the full pipeline (extract → connect → verify):**
```
/powerhouse-knowledge:pipeline
```

**Search the vault:**
```
/powerhouse-knowledge:search how does the reactor work
```

**Check vault health:**
```
/powerhouse-knowledge:health
```

**Explore the graph:**
```
/powerhouse-knowledge:graph
```

## Connection Modes

The plugin supports three ways to interact with the reactor:

| Mode | Tool | Best for |
|------|------|----------|
| **Switchboard CLI** | `switchboard` commands via Bash | Agent workflows, full feature parity |
| **MCP** | `mcp__reactor-mcp__*` tools | Direct document CRUD from Claude |
| **GraphQL** | HTTP queries to `/graphql/knowledgeGraph` | Subgraph queries, external integrations |

The **knowledge-agent** uses the Switchboard CLI by default. See [CONFIGURATION.md](CONFIGURATION.md) for setup details.

## Skills Reference

### Setup & Import

| Skill | Command | Description |
|-------|---------|-------------|
| Setup | `/powerhouse-knowledge:setup` | Verify vault structure, folders, and singletons |
| Import | `/powerhouse-knowledge:import <path>` | Bulk import from markdown, Obsidian, or JSON |
| Export | `/powerhouse-knowledge:export [path]` | Export vault as markdown, JSON, or .phd backup |

### Knowledge Management

| Skill | Command | Description |
|-------|---------|-------------|
| Seed | `/powerhouse-knowledge:seed` | Ingest source material into the vault |
| Extract | `/powerhouse-knowledge:extract` | Extract atomic claims from a source |
| Connect | `/powerhouse-knowledge:connect` | Find and create typed links between notes |
| Synthesize | `/powerhouse-knowledge:synthesize` | Create MOCs from topic clusters |
| Search | `/powerhouse-knowledge:search <query>` | Find notes (keyword, topic, semantic, provenance) |
| Verify | `/powerhouse-knowledge:verify` | Quality checks + auto-repair |
| Health | `/powerhouse-knowledge:health` | Vault diagnostics saved to health-report |
| Graph | `/powerhouse-knowledge:graph` | Structural analysis (triangles, bridges, clusters) |

### Processing & Automation

| Skill | Command | Description |
|-------|---------|-------------|
| Pipeline | `/powerhouse-knowledge:pipeline` | Full end-to-end: extract → connect → verify |
| Watch | `/powerhouse-knowledge:watch` | Real-time vault monitoring via WebSocket |

## Graph Indexer & Subgraph

The vault includes a **Graph Indexer processor** that maintains a relational index of all knowledge notes. The **Knowledge Graph subgraph** exposes this index via GraphQL at `/graphql/knowledgeGraph`.

### What's indexed

Every `bai/knowledge-note` operation triggers the indexer to update:
- **graph_nodes** — title, description, content, noteType, status, author, sourceOrigin, createdAt
- **graph_edges** — source, target, linkType, targetTitle
- **graph_topics** — document_id, topic name
- **note_embeddings** — 384-dim vector embeddings for semantic search (Transformers.js + pgvector)

### Available queries

**Search:**
- `knowledgeGraphSearch(query)` — keyword match on title + description
- `knowledgeGraphFullSearch(query)` — keyword match on title + description + content
- `knowledgeGraphSemanticSearch(query)` — AI-powered meaning-based search
- `knowledgeGraphSimilar(documentId)` — find semantically similar notes

**Topics:**
- `knowledgeGraphTopics` — all topics with note counts
- `knowledgeGraphByTopic(topic)` — notes tagged with a topic
- `knowledgeGraphRelatedByTopic(documentId)` — notes sharing topics with a given note

**Provenance:**
- `knowledgeGraphByAuthor(author)` — notes by author
- `knowledgeGraphByOrigin(origin)` — notes by source origin
- `knowledgeGraphRecent(limit, since?)` — recently created/updated notes

**Structure:**
- `knowledgeGraphStats` — node count, edge count, orphan count
- `knowledgeGraphNodes` / `knowledgeGraphEdges` — all indexed data
- `knowledgeGraphOrphans` — notes with no incoming links
- `knowledgeGraphBacklinks` / `knowledgeGraphForwardLinks` — directional edges
- `knowledgeGraphConnections(documentId, depth)` — BFS traversal
- `knowledgeGraphTriangles` — synthesis opportunities (A,B both link to C)
- `knowledgeGraphBridges` — articulation points
- `knowledgeGraphDensity` — graph density metric

**Admin:**
- `knowledgeGraphReindex(driveId)` — backfill the index after deployment
- `knowledgeGraphDebug(driveId)` — raw DB rows

### When to use which search

| User intent | Best query |
|-------------|-----------|
| Natural language question | `knowledgeGraphSemanticSearch` |
| Known keyword/term | `knowledgeGraphSearch` or `knowledgeGraphFullSearch` |
| "Notes about topic X" | `knowledgeGraphByTopic` |
| "Notes similar to this one" | `knowledgeGraphSimilar` |
| "What did author X write?" | `knowledgeGraphByAuthor` |
| "Recent notes" | `knowledgeGraphRecent` |

## Document Models

| Model | Type | Purpose |
|-------|------|---------|
| Knowledge Note | `bai/knowledge-note` | Atomic knowledge claims |
| Map of Content | `bai/moc` | Topic navigation hubs |
| Source | `bai/source` | Ingested source material |
| Knowledge Graph | `bai/knowledge-graph` | Materialized graph singleton |
| Pipeline Queue | `bai/pipeline-queue` | Processing task tracker |
| Health Report | `bai/health-report` | Point-in-time diagnostics |
| Vault Config | `bai/vault-config` | Vault configuration |
| Observation | `bai/observation` | Operational learning signals |
| Tension | `bai/tension` | Unresolved contradictions |
| Derivation | `bai/derivation` | Configuration audit trail |

## Processing Pipeline

The 6R pipeline transforms raw sources into structured, connected knowledge:

```
1. Record   →  /seed (ingest source material)
2. Reduce   →  /extract (extract atomic claims)
3. Reflect  →  /connect (find links between notes)
4. Reweave  →  /synthesize (create MOCs, update old notes)
5. Verify   →  /verify (quality gate, auto-repair)
6. Rethink  →  /health + /graph (challenge assumptions)
```

## Architecture

```
Human (Connect App)                    AI Agent (Claude Code)
  |                                     |
  +── Knowledge Vault App               +── powerhouse-knowledge plugin
  |     |── Notes tab (grid + search)   |     |── 14 skills
  |     |── Graph tab (cytoscape viz)   |     |── knowledge-agent
  |     |── Sources, Pipeline, Health   |     |── Switchboard CLI
  |     +── MOC editor, Note editor     |     +── MCP / GraphQL
  |                                     |
  +───────── Powerhouse Reactor ────────+
              |── 11 document models
              |── Graph Indexer processor
              |     |── Relational index (PGlite)
              |     +── Semantic embeddings (pgvector + Transformers.js)
              |── Knowledge Graph subgraph (25+ queries)
              +── MCP server
```

## Plugin Structure

```
powerhouse-knowledge/
├── agents/
│   └── knowledge-agent.md      # Agent definition with full vault API reference
├── skills/
│   ├── search/SKILL.md         # Multi-tier search (semantic, keyword, topic)
│   ├── graph/SKILL.md          # Structural + semantic graph analysis
│   ├── connect/SKILL.md        # Link discovery with articulation test
│   ├── seed/SKILL.md           # Source ingestion
│   ├── extract/SKILL.md        # Atomic claim extraction
│   ├── synthesize/SKILL.md     # MOC creation from topic clusters
│   ├── verify/SKILL.md         # Quality gate + auto-repair
│   ├── health/SKILL.md         # Vault diagnostics
│   ├── pipeline/SKILL.md       # End-to-end processing
│   ├── setup/SKILL.md          # Vault initialization
│   ├── import/SKILL.md         # Bulk import
│   ├── export/SKILL.md         # Vault export
│   ├── watch/SKILL.md          # Real-time monitoring
│   └── cli-reference/SKILL.md  # Switchboard CLI commands
├── data/
│   └── methodology/            # 249 Ars Contexta research claims (local reference)
├── hooks/                      # Pre-flight hooks for vault detection
├── scripts/                    # Utility scripts
├── settings.json               # Plugin settings
├── CONFIGURATION.md            # Connection setup guide
└── README.md                   # This file
```

## License

AGPL-3.0-only
