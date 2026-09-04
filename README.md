# powerhouse-knowledge

Claude Code plugin for the Powerhouse Knowledge Vault. Enables AI agents and humans to query, create, connect, and verify knowledge notes stored as Powerhouse document models.

## What This Plugin Does

This plugin gives you (human or AI agent) the ability to manage a structured knowledge graph inside a Powerhouse reactor. It provides:

- **16 skills** for knowledge management (seed, extract, connect, search, verify, health, graph, scopes of work/WBS, skills discovery, etc.)
- **One canonical instruction set** — [AGENT.md](AGENT.md). The `knowledge-agent` Claude Code agent is generated from it (`node scripts/build-agent.mjs`), so there is exactly one document to keep true
- **Connection to a Powerhouse reactor** via MCP or Switchboard CLI
- **Access to the Graph Indexer** — a relational index with keyword search, topic queries, provenance filtering, and AI-powered semantic search

The vault stores knowledge as `bai/knowledge-note` documents — atomic claims with typed links, topics, provenance, and lifecycle states. Notes are organized by Maps of Content (MOCs), processed through a pipeline, and visualized as an interactive graph.

**This plugin is the vault's write path.** Its job is to run the pipeline well: take in source material, extract atomic notes and create them correctly (title, description, type, topics, provenance), connect them with typed relationships, attach them to MoCs, and verify the result. Humans read the vault in the Knowledge Vault app — including its built-in Chat, which answers questions over the same graph index this plugin populates, read-only.

## Prerequisites

- **Powerhouse reactor** running with the `bai-knowledge-note` Vetra package deployed
- **Claude Code** CLI installed (for AI agent use)
- **Switchboard CLI** installed (recommended — `curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash`)

## Installation

Claude Code loads plugins from **marketplaces** — a plugin directory sitting
on disk (e.g. cloned into `.claude/plugins/`) is NOT discovered by itself.
This repo is its own single-plugin marketplace (see
`.claude-plugin/marketplace.json`), so installation is two commands.

### Option 1: From GitHub (recommended)

```bash
claude plugin marketplace add liberuum/powerhouse-knowledge
claude plugin install powerhouse-knowledge@powerhouse-knowledge
```

Or interactively inside Claude Code: `/plugin marketplace add liberuum/powerhouse-knowledge`,
then `/plugin install powerhouse-knowledge@powerhouse-knowledge`.

### Option 2: From a local clone (development)

```bash
git clone https://github.com/liberuum/powerhouse-knowledge
claude plugin marketplace add ./powerhouse-knowledge
claude plugin install powerhouse-knowledge@powerhouse-knowledge
```

After pulling changes into the clone, refresh with
`claude plugin marketplace update powerhouse-knowledge` and
`claude plugin update powerhouse-knowledge`.

Restart your Claude Code session after installing — skills register at
session start. Verify with `/help` or by typing `/powerhouse-knowledge:` and
checking the completion list.

## Quick Start

### Step 1: Connect to a reactor

**Local development:**
```bash
cd your-powerhouse-project/
ph vetra --watch   # starts reactor at localhost:4001
```

**Remote (Switchboard):**
```bash
# Point a profile at YOUR deployment's /graphql endpoint — there is no default vault.
switchboard init --url https://<your-switchboard-host>/graphql --name my-vault --use-profile   # CLI ≥ 1.0.34; older: `switchboard init` (interactive)
switchboard ping                     # verify connection
```

**Sign your writes (required by the plugin's pre-write hook):**
```bash
ph login                             # once per machine — creates .ph/.keypair.json + .ph/.renown.json
switchboard auth login --renown      # the profile signs every write with that key; path only, never the key
switchboard auth status              # Signing: on … acting for <your address>
```
Every note, edge and tension the agent writes is then signed by *your* key and labelled
`powerhouse-knowledge`, so the vault can tell agent writes from your own in Connect. Without this,
the Switchboard would attribute agent writes to whoever logged the *server* in.

The agent always works against the active profile. If you have several vaults,
say which one you mean — it will ask rather than guess.

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

**Find an agent skill by describing what you need:**
```
/powerhouse-knowledge:skills how do I bulk import notes?
```
(Skills are synced into the vault as PROCEDURE notes by `scripts/sync-skills.mjs` —
incremental by content hash, git stays canonical.)

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

> **The golden rule: read however you like — write ONLY through the CLI.**
> Reads (queries, searches, state checks) are safe over raw GraphQL and faster (~0.2s vs ~1-2s).
> Writes (create, mutate, link) go through the `switchboard` CLI or the vetted scripts: they
> auto-stamp every action with `id` + `timestampUtcMs` and resolve drive slugs to UUIDs.
> A single raw write missing the action `id` permanently breaks sync for every connected client.
> Bulk writes: batch into one `switchboard docs apply --file` call.
> If you must write raw anyway, follow every rule in CONFIGURATION.md → "Writing via raw GraphQL — the safety rules".

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
| Skills | `/powerhouse-knowledge:skills <need>` | Find/read agent skills stored in the vault; sync via `scripts/sync-skills.mjs` |
| Verify | `/powerhouse-knowledge:verify` | Quality checks + auto-repair |
| Health | `/powerhouse-knowledge:health` | Vault diagnostics saved to health-report |
| Graph | `/powerhouse-knowledge:graph` | Structural analysis (triangles, bridges, clusters) |

### Processing & Automation

| Skill | Command | Description |
|-------|---------|-------------|
| Pipeline | `/powerhouse-knowledge:pipeline` | Full end-to-end: extract → connect → verify |
| Watch | `/powerhouse-knowledge:watch` | Real-time vault monitoring via WebSocket |

### Project & Work Tracking

| Skill | Command | Description |
|-------|---------|-------------|
| Projects | `/powerhouse-knowledge:projects` | Manage `powerhouse/scopeofwork` (envelopes are the projects) + `bai/wbs` — deliverables, goal tracking, agent goal-working loop |

## Graph Indexer & Subgraph

The vault includes a **Graph Indexer processor** that maintains a relational index of all knowledge notes. The **Knowledge Graph subgraph** exposes this index via GraphQL at `/graphql/knowledgeGraph`.

### What's indexed

Every `bai/knowledge-note` and `bai/moc` operation — plus every `ADD_RELATIONSHIP` on the drive — triggers the indexer to update (sources, tensions, observations, scopes of work and WBS are **not** indexed; read those by id):
- **graph_nodes** — title, description, content, noteType, status, author, sourceOrigin, createdAt
- **graph_edges** — source, target, linkType, targetTitle
- **graph_topics** — document_id, topic name
- **note_embeddings** — 384-dim vector embeddings for semantic search, computed server-side by the processor on every content change plus a boot-time backfill (gte-small via Transformers.js; package ≥ 1.0.50)

### Available queries

**Search:**
- `knowledgeGraphSemanticSearch(query, mode: HYBRID|SEMANTIC)` — meaning + keyword, ranked; `similarity` is a 0–1 relevance (package ≥ 1.0.52). **Default for natural-language questions.**
- `knowledgeGraphSearch(query)` — keyword match on title + description
- `knowledgeGraphFullSearch(query)` — keyword match on title + description + content (ANDs terms; use 1–2 keywords)
- `knowledgeGraphSimilar(documentId)` — semantically similar notes to a given note

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
- `knowledgeGraphOrphans` — nodes with no incoming links (MoCs are nodes too — check `noteType`)
- `knowledgeGraphNodesByStatus(status)` / `knowledgeGraphNodeByDocumentId(documentId)` — filter or fetch single nodes
- `knowledgeGraphStale(since)` / `knowledgeGraphHistory(documentId)` / `knowledgeGraphActivity(since)` — change tracking
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
| Natural language question | `knowledgeGraphSemanticSearch` (mode: HYBRID), question passed verbatim |
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
| Pipeline Queue | `bai/pipeline-queue` | Processing task tracker |
| Health Report | `bai/health-report` | Point-in-time diagnostics |
| Vault Config | `bai/vault-config` | Vault configuration |
| Observation | `bai/observation` | Operational learning signals |
| Tension | `bai/tension` | Unresolved contradictions |
| Derivation | `bai/derivation` | Configuration audit trail |
| Scope of Work | `powerhouse/scopeofwork` | Envelopes (the projects), priced deliverables, roadmaps, milestones, contributors |
| Work Breakdown Structure | `bai/wbs` | Goal tree that delivers one envelope: statuses, assignees, dependencies, notes |

## Processing Pipeline

Source material goes in; connected, verified notes come out. The agent runs it as
`/powerhouse-knowledge:pipeline`, or one skill at a time:

```
Record   →  /seed        ingest a source (bai/source, status INBOX → EXTRACTING) and queue a task
Reduce   →  /extract     one bai/knowledge-note per atomic claim; ADD_EXTRACTED_CLAIM + DERIVED_FROM
                         edge per note; RECORD_EXTRACTION_STATS; source → EXTRACTED
Reflect  →  /connect     typed relationships (`docs link --reason`), the articulation stored on the edge
Reweave  →  /synthesize  MoCs via CORE_IDEA edges; update older notes with new context
Verify   →  /verify      recite test, schema check, link health — auto-repair, then /health
Rethink  →  /health + /graph   challenge the structure against the evidence
```

The six R names are the vocabulary. The **pipeline-queue task** underneath has four phases —
`create → reflect → reweave → verify` for a `claim` task (`enrich → reflect → reweave → verify`
for `enrichment`). Advance it with `ADVANCE_PHASE` and a handoff per phase; the final advance
completes the task by itself. Every note the pipeline creates must end with: title, description
(≤ 200 chars, adds information beyond the title), lowercase `noteType`, topics, provenance
(dispatched separately), ≥ 2 typed relationships, a MoC `CORE_IDEA` edge, and a walk to
`CANONICAL`.

## Architecture

```
Human (Connect App)                    AI Agent (Claude Code)
  |                                     |
  +── Knowledge Vault App               +── powerhouse-knowledge plugin
  |     |── Notes tab (grid + search)   |     |── 16 skills
  |     |── Graph tab (cytoscape viz)   |     |── knowledge-agent
  |     |── Sources, Pipeline, Health   |     |── Switchboard CLI
  |     +── MOC editor, Note editor     |     +── MCP / GraphQL
  |                                     |
  +───────── Powerhouse Reactor ────────+
              |── 11 document models
              |── Graph Indexer processor
              |     |── Relational index (PGlite)
              |     +── Semantic embeddings (server-side Transformers.js)
              |── Knowledge Graph subgraph (25+ queries)
              +── MCP server
```

## Plugin Structure

```
powerhouse-knowledge/
├── AGENT.md                    # THE agent instructions — canonical, edit this
├── agents/
│   └── knowledge-agent.md      # GENERATED from AGENT.md by scripts/build-agent.mjs — do not edit
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
│   ├── cli-reference/SKILL.md  # Switchboard CLI commands
│   └── projects/SKILL.md       # Scopes of work (powerhouse/scopeofwork) + WBS (bai/wbs) goal tracking
├── data/
│   └── methodology/            # 249 Ars Contexta research claims (local reference)
├── hooks/                      # Pre-flight hooks for vault detection
├── scripts/
│   ├── lint-actions.mjs        # Pre-flight for a docs apply file: 200-char description (UTF-16), enums, escapes
│                               #   (run automatically on every docs apply/mutate by hooks/pre-apply-lint.py)
│   ├── sync-skills.mjs         # Sync SKILL.md files into a vault as PROCEDURE notes + sources (content-hashed)
│   ├── build-agent.mjs         # Regenerate agents/knowledge-agent.md from AGENT.md
│   └── seed-source.mjs         # Seed a local file as a bai/source
├── settings.json               # Plugin settings
├── CONFIGURATION.md            # Connection setup guide
└── README.md                   # This file
```

## License

AGPL-3.0-only
