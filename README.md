# powerhouse-knowledge

Claude Code plugin for the Powerhouse Knowledge Vault. Enables AI agents to query, create, connect, and verify knowledge notes stored as Powerhouse document models.

## What it does

This plugin connects Claude Code to a Powerhouse reactor running the Knowledge Vault document models (`bai/knowledge-note`, `bai/research-claim`, and 9 others). It provides 12 skills for knowledge management, an MCP server for direct document access, and an agent definition optimized for knowledge work.

## Prerequisites

- A running Powerhouse reactor with the Knowledge Vault document models deployed
- For local development: `ph vetra --watch` (serves MCP at `http://localhost:4001/mcp`)
- For remote: any deployed reactor endpoint

## Installation

### From a local path
```bash
claude --plugin-dir /path/to/powerhouse-knowledge
```

### From GitHub (when published)
```
/install-plugin github:bai/powerhouse-knowledge
```

## Configuration

Edit `.mcp.json` to point to your reactor:

```json
{
  "mcpServers": {
    "reactor-mcp": {
      "type": "http",
      "url": "http://localhost:4001/mcp"
    }
  }
}
```

For remote reactors, replace the URL with your deployed endpoint.

## Skills

### Setup & Import

| Skill | Command | Description |
|-------|---------|-------------|
| Setup | `/powerhouse-knowledge:setup` | Initialize vault with Ars Contexta methodology (249 research claims) |
| Import | `/powerhouse-knowledge:import <path>` | Bulk import from markdown, Obsidian, or Ars Contexta vaults |
| Export | `/powerhouse-knowledge:export [path]` | Export vault as markdown, JSON, or .phd backup |

### Knowledge Management (Core)

| Skill | Command | Description |
|-------|---------|-------------|
| Search | `/powerhouse-knowledge:search <query>` | Find notes by title, type, topic, content |
| Extract | `/powerhouse-knowledge:extract <source>` | Extract atomic claims from source material |
| Connect | `/powerhouse-knowledge:connect <note>` | Find and create links between notes |
| Verify | `/powerhouse-knowledge:verify <note>` | Run quality checks (recite, schema, health) |
| Health | `/powerhouse-knowledge:health` | Vault health report (orphans, density, stats) |
| Graph | `/powerhouse-knowledge:graph` | Structural analysis (triangles, bridges, clusters) |
| Seed | `/powerhouse-knowledge:seed <source>` | Ingest source material for processing |

### Processing & Automation

| Skill | Command | Description |
|-------|---------|-------------|
| Pipeline | `/powerhouse-knowledge:pipeline <source>` | Run the full extract->connect->reweave->verify pipeline |
| Watch | `/powerhouse-knowledge:watch [drive]` | Real-time vault monitoring via WebSocket |

## Agent

The plugin includes a `knowledge-agent` that activates by default. This agent:
- Understands all 11 document models and their operations
- Follows the 6-phase processing pipeline (Record, Reduce, Reflect, Reweave, Verify, Rethink)
- Enforces quality principles (atomic claims, articulation test, minimum connectivity)
- References the Ars Contexta methodology (249 research claims) for design decisions
- Can analyze graph structure for synthesis opportunities

## Document Models

| Model | Type | Purpose |
|-------|------|---------|
| Knowledge Note | `bai/knowledge-note` | Atomic knowledge claims (26 ops) |
| Research Claim | `bai/research-claim` | Methodology foundation (4 ops) |
| Knowledge Graph | `bai/knowledge-graph` | Materialized graph singleton (7 ops) |
| Map of Content | `bai/moc` | Topic navigation (12 ops) |
| Source | `bai/source` | Ingested source material (4 ops) |
| Pipeline Queue | `bai/pipeline-queue` | Processing pipeline state (7 ops) |
| Observation | `bai/observation` | Operational learning signals (4 ops) |
| Tension | `bai/tension` | Unresolved contradictions (4 ops) |
| Vault Config | `bai/vault-config` | Vault configuration (8 ops) |
| Derivation | `bai/derivation` | Configuration audit trail (4 ops) |
| Health Report | `bai/health-report` | Point-in-time diagnostics (2 ops) |

## Architecture

```
Claude Code Session
  |
  +-- powerhouse-knowledge plugin
  |     |-- skills/ (12 knowledge management skills)
  |     |-- agents/ (knowledge-agent with pipeline awareness)
  |     +-- .mcp.json -> reactor-mcp
  |
  +-- reactor-mcp (Powerhouse Reactor)
        |-- 11 document models (82 operations)
        |-- graph-indexer (processor, server-side sync)
        +-- knowledgeGraph (subgraph, GraphQL API)
```

## License

AGPL-3.0-only
