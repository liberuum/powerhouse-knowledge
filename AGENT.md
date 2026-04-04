# For AI Agents

You have access to a Powerhouse Knowledge Vault via the `powerhouse-knowledge` plugin. This file tells you how to get started quickly.

## Deep-dive references

Read these files for full details on specific areas:

| What you need | Read this |
|---------------|-----------|
| Full agent instructions, all document model operations, CLI reference | [agents/knowledge-agent.md](agents/knowledge-agent.md) |
| Connection setup (MCP, CLI, GraphQL, WebSocket) | [CONFIGURATION.md](CONFIGURATION.md) |
| Switchboard CLI commands (drives, docs, mutations, queries) | [skills/cli-reference/SKILL.md](skills/cli-reference/SKILL.md) |
| Search (semantic, keyword, topic, provenance) | [skills/search/SKILL.md](skills/search/SKILL.md) |
| Graph analysis (triangles, bridges, clusters, semantic neighborhoods) | [skills/graph/SKILL.md](skills/graph/SKILL.md) |
| Finding and creating links between notes | [skills/connect/SKILL.md](skills/connect/SKILL.md) |
| Extracting atomic claims from source material | [skills/extract/SKILL.md](skills/extract/SKILL.md) |
| Ingesting source material into the vault | [skills/seed/SKILL.md](skills/seed/SKILL.md) |
| Creating MOCs from topic clusters | [skills/synthesize/SKILL.md](skills/synthesize/SKILL.md) |
| Quality checks and auto-repair | [skills/verify/SKILL.md](skills/verify/SKILL.md) |
| Vault health diagnostics | [skills/health/SKILL.md](skills/health/SKILL.md) |
| End-to-end processing pipeline | [skills/pipeline/SKILL.md](skills/pipeline/SKILL.md) |
| Vault initialization and structure verification | [skills/setup/SKILL.md](skills/setup/SKILL.md) |
| Bulk import from markdown/Obsidian/JSON | [skills/import/SKILL.md](skills/import/SKILL.md) |
| Export vault as markdown/JSON/backup | [skills/export/SKILL.md](skills/export/SKILL.md) |
| Real-time vault monitoring via WebSocket | [skills/watch/SKILL.md](skills/watch/SKILL.md) |

## First: Check your connection

```bash
switchboard config show    # which server are you targeting?
switchboard ping           # is it reachable?
```

If the CLI isn't configured, check if MCP tools are available (`mcp__reactor-mcp__*` or `mcp__claude_ai_*`).

## Find the vault drive

```bash
switchboard drives list --format json | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    nodes = d.get('state',{}).get('global',{}).get('nodes',[])
    if any(n.get('documentType')=='bai/vault-config' for n in nodes):
        print(f'VAULT: slug={d[\"slug\"]} id={d[\"id\"]}')
"
```

Save the drive slug and UUID — you'll need them for every query.

## Search the vault

**Always use semantic search as the default.** It understands meaning, not just keywords — "how does storage work?" finds notes about reactors without exact word matches.

```bash
# DEFAULT: Semantic search — use this first for any user query
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<user question>", limit: 10) { node { documentId title noteType description } similarity } }'
```

Only fall back to keyword search if semantic search is unavailable or you need exact term matches:

```bash
# Keyword fallback (title + description + content)
switchboard query '{ knowledgeGraphFullSearch(driveId: "<UUID>", query: "reactor", limit: 20) { documentId title noteType } }'

# By topic
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "reactor") { documentId title } }'

# Similar to a specific note
switchboard query '{ knowledgeGraphSimilar(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 5) { node { title } similarity } }'

# All topics
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'
```

## Read a document

```bash
switchboard docs get <document-id> --state --format json
```

## Create a note

```bash
# Create the document
switchboard docs create --type bai/knowledge-note --name "my-note-slug" --drive <drive-slug> --parent-folder <notes-folder-uuid> --format json

# Set its content (batch independent operations)
switchboard docs apply <doc-id> --actions '[
  {"type":"SET_TITLE","input":{"title":"My claim","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_DESCRIPTION","input":{"description":"Brief summary","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_NOTE_TYPE","input":{"noteType":"CONCEPT","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_CONTENT","input":{"content":"Full body...","updatedAt":"<ISO>"},"scope":"global"}
]'

# Set provenance separately (validation failures kill the batch)
switchboard docs mutate <doc-id> --op setProvenance --input '{"author":"knowledge-agent","sourceOrigin":"DERIVED","createdAt":"<ISO>"}'
```

## Key rules

1. **Two-batch pattern**: Content ops (SET_TITLE, SET_DESCRIPTION, SET_CONTENT) in one batch. Provenance (SET_PROVENANCE) in a separate call.
2. **Description max 200 chars**: Longer descriptions silently fail.
3. **Always verify after creating**: `switchboard docs tree <drive> --format json` to confirm the node exists.
4. **Never batch dependent operations**: Pipeline ops (ADD_TASK → ASSIGN_TASK → ADVANCE_PHASE) must be dispatched one at a time via `docs mutate`.
5. **The CLI auto-injects timestamps and action IDs** — no need to generate them manually.

## Available skills

| Command | What it does |
|---------|-------------|
| `/powerhouse-knowledge:search <query>` | Multi-tier search (semantic, keyword, topic) |
| `/powerhouse-knowledge:seed` | Ingest source material |
| `/powerhouse-knowledge:extract` | Extract atomic claims from a source |
| `/powerhouse-knowledge:connect` | Find and create typed links |
| `/powerhouse-knowledge:pipeline` | Full end-to-end processing |
| `/powerhouse-knowledge:synthesize` | Create MOCs from topic clusters |
| `/powerhouse-knowledge:verify` | Quality gate + auto-repair |
| `/powerhouse-knowledge:health` | Vault health diagnostics |
| `/powerhouse-knowledge:graph` | Graph structure analysis |
| `/powerhouse-knowledge:setup` | Verify vault is ready |

## Graph indexer queries (quick reference)

All queries require `driveId: "<UUID>"`.

| Query | Use when |
|-------|----------|
| `knowledgeGraphSemanticSearch(query)` | Natural language questions |
| `knowledgeGraphSearch(query)` | Known keywords |
| `knowledgeGraphFullSearch(query)` | Search includes note content |
| `knowledgeGraphByTopic(topic)` | "Notes about X topic" |
| `knowledgeGraphSimilar(documentId)` | "Notes like this one" |
| `knowledgeGraphRelatedByTopic(documentId)` | Notes sharing topics |
| `knowledgeGraphTopics` | See all topics + counts |
| `knowledgeGraphByAuthor(author)` | Notes by author |
| `knowledgeGraphRecent(limit)` | Latest notes |
| `knowledgeGraphStats` | Node/edge/orphan counts |
| `knowledgeGraphTriangles` | Synthesis opportunities |
| `knowledgeGraphBridges` | Critical connector nodes |
| `knowledgeGraphOrphans` | Disconnected notes |
| `knowledgeGraphReindex(driveId)` | Rebuild index (mutation) |

## Document types

| Type | Purpose | Folder |
|------|---------|--------|
| `bai/knowledge-note` | Atomic claims | `/knowledge/notes/` |
| `bai/moc` | Maps of Content | `/knowledge/` |
| `bai/source` | Raw source material | `/sources/` |
| `bai/pipeline-queue` | Task tracker (singleton) | `/ops/queue/` |
| `bai/health-report` | Diagnostics (singleton) | `/ops/health/` |
| `bai/knowledge-graph` | Graph (singleton) | `/self/` |
| `bai/vault-config` | Config (singleton) | `/self/` |

## Link types

| Type | Meaning |
|------|---------|
| `RELATES_TO` | General thematic connection |
| `BUILDS_ON` | Extends or strengthens the target |
| `CONTRADICTS` | Challenges the target |
| `SUPERSEDES` | Replaces the target |
| `DERIVED_FROM` | Extracted from the target |

## Quality principles

- Each note makes **one atomic claim**
- Every link passes the **articulation test**: "A connects to B because [specific reason]"
- **Progressive disclosure**: title → description → content, each layer adds detail
- **Minimum 2 connections** per note
- Keep descriptions under **200 characters**
