# For AI Agents

> **The golden rule: read however you like — write ONLY through the CLI.**
> Reads (queries, searches, state checks) are safe over raw GraphQL and faster (~0.2s vs ~1-2s).
> Writes (create, mutate, link) go through the `switchboard` CLI or the vetted scripts: they
> auto-stamp every action with `id` + `timestampUtcMs` and resolve drive slugs to UUIDs.
> A single raw write missing the action `id` permanently breaks sync for every connected client.
> Bulk writes: batch into one `switchboard docs apply --file` call.
> If you must write raw anyway, follow every rule in CONFIGURATION.md → "Writing via raw GraphQL — the safety rules".

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
| Managing projects and Work Breakdown Structure goal trees | [skills/projects/SKILL.md](skills/projects/SKILL.md) |
| Skill discovery in the vault + incremental sync | [skills/skills/SKILL.md](skills/skills/SKILL.md) |

## First: Establish which vault to use — ASK, never assume

**There is no default vault.** Different users run different Switchboards
(local dev, shared team deployments, per-project drives), and pointing writes
at the wrong one corrupts someone's knowledge base. Before the first vault
operation of a session:

1. Check whether a target is already established — an active CLI profile
   (`switchboard config show`), a project `.mcp.json`, or the user having
   named one in conversation.
2. If none is unambiguous, **ask the user** which vault to connect to:
   the Switchboard URL (e.g. `http://localhost:4001/graphql` for local
   `ph vetra`, or `https://<their-host>/graphql` for a deployment) **and**
   which drive on it.
3. Confirm reachability before proceeding:

```bash
switchboard config show    # which server are you targeting?
switchboard ping           # is it reachable?
```

Never hardcode an endpoint or drive id into scripts or saved config without
the user having named it. If the CLI isn't configured, check if MCP tools are
available (`mcp__reactor-mcp__*` or `mcp__claude_ai_*`) — and the same rule
applies: the MCP server's target must be one the user chose.

### Connecting to a shared remote vault

A hosted vault needs no auth for reads. Point a profile at the Switchboard and
confirm the models are deployed:

```bash
switchboard config add remote-vault --url https://<host>-switchboard.vetra.io/graphql
switchboard config use remote-vault
switchboard ping
```

Two things to verify before trusting results, because both fail quietly:

```bash
# 1. Are the bai/* models deployed on that Switchboard?
#    If KnowledgeNote is absent, the drive may exist but nothing can read it properly.
switchboard query '{ __schema { types { name } } }' --format json | grep -c KnowledgeNote

# 2. Has the graph projection been built for this drive?
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount } }'
```

If step 2 errors with `relation "<hash>.graph_nodes" does not exist`, the
GraphIndexer has never processed that drive — every `knowledgeGraph*` query
will fail until someone runs the reindex mutation:

```bash
switchboard query 'mutation { knowledgeGraphReindex(driveId: "<UUID>") { indexedNodes indexedEdges errors } }'
```

Note `orphanCount` counts nodes with **zero incoming edges**. On a drive whose
membership edges are fully indexed this reads 0 for everything, which is
misleading; on a freshly-imported drive it reflects genuinely un-referenced
notes. Treat a non-zero value as signal, not breakage.

**Writing over a slow link:** the CLI spawns a process per call and each one
does its own TLS handshake. For bulk writes to a remote host that is
handshake-bound rather than CPU-bound — hundreds of calls will start failing
with `_ssl.c:983: handshake operation timed out`. Batch actions into a single
`docs apply`, or talk to `/graphql` over one keep-alive connection — stamping
every action with `id` + `timestampUtcMs` yourself (copy the `envelope()`
helper from scripts/sync-skills.mjs). An id-less action bricks sync for every
client.

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

**Start with `knowledgeGraphSemanticSearch`** (package ≥ 1.0.50). Send the
question in plain natural language — the Switchboard embeds the query
server-side and ranks by meaning, falling back to keyword search
transparently if embeddings are unavailable, so it is always safe to call:

```bash
# DEFAULT: semantic/hybrid search from plain query text
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "how does the reactor store operations?", mode: HYBRID, limit: 10) { similarity matchedBy node { documentId title description noteType } } }'
```

- `similarity` is **always a 0–1 relevance** and always decreases down the result list, so it is safe to render as a percentage or threshold on in either mode (package ≥ 1.0.52).
- `mode: SEMANTIC` — pure vector ranking; `similarity` is cosine (>0.8 is a strong match)
- `mode: HYBRID` — semantic + keyword rank fusion, rescaled onto 0–1: **~1.0 = matched by both signals at top rank, ~0.5 = matched by only one signal**. Select `matchedBy` to see which fired (`["semantic","keyword"]`).
- `score` carries the RAW number instead — cosine in SEMANTIC, the Reciprocal Rank Fusion weight in HYBRID. An RRF weight is ordinal and tops out near 0.033, so **never render `score` as a percentage**; use `similarity`.
- **Before 1.0.52** the raw RRF weight leaked through `similarity`, so every HYBRID hit scored ~0.016–0.033 (a "perfect" match displayed as 3%). On those deployments only the ORDER is meaningful — do not threshold on the value.
- If the field doesn't exist (schema validation error), the deployment runs an older package — fall back to `knowledgeGraphFullSearch` below.

Keyword search still matters for exact terms:

```bash
# Full-text keyword search across title + description + content
switchboard query '{ knowledgeGraphFullSearch(driveId: "<UUID>", query: "operation store", limit: 20) { documentId title noteType } }'
```

Results are ranked by WHERE the term matched — title, then description, then
body — so a title match can no longer be pushed out of the result window by
incidental body mentions (package ≥ 1.0.52).

⚠️ **`knowledgeGraphFullSearch` ANDs its terms.** A long natural-language question silently returns `[]`. Give it 1–2 distinctive keywords, not a sentence — natural-language questions belong in `knowledgeGraphSemanticSearch`.

Other vector queries:

```bash
# Notes similar to a given note
switchboard query '{ knowledgeGraphSimilar(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 5) { node { title } similarity } }'
```

Embeddings are **computed server-side by the graph-indexer processor** (package ≥ 1.0.50): every title/description/content change re-embeds the note, and a boot-time backfill embeds anything missing — no client ever pushes vectors. Coverage check (should be `[]` shortly after a deployment boots):

```bash
switchboard query '{ knowledgeGraphMissingEmbeddings(driveId: "<UUID>") }'
```

On older deployments only: embeddings had to be client-computed and pushed via `knowledgeGraphUpsertEmbedding(driveId, documentId, embedding)` — that mutation remains as a legacy force-push path. If `knowledgeGraphMissingEmbeddings` errors with `relation "note_embeddings" does not exist`, the deployment predates the embedding store entirely and only keyword/topic search will work.

Other retrieval paths, all always available:

```bash
# Title + description only (narrower than fullSearch)
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "reactor", limit: 20) { documentId title noteType } }'

# By topic
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "reactor") { documentId title } }'

# All topics, with counts — good for discovering the vocabulary first
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'
```

For a broad sweep, `knowledgeGraphNodes` returns every node (title, description, content, topics, status) in one call — often cheaper than many searches when you need to scan.

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

## Definition of done — leave the vault at 100% health

The vault is expected to sit at **all checks PASS**. That standard is met by
completing the work, never by making the report look green. Before you call
any vault task finished, every line below must be true — and **verified by
reading state back**, not assumed from a successful dispatch (invalid enums,
over-long descriptions and bad timestamps all fail silently).

**Creating a note**
- [ ] title, description (<= 200 chars, adds information beyond the title), noteType, content
- [ ] topics added; provenance set in a SEPARATE dispatch from content
- [ ] >= 2 typed relationships, each passing the articulation test
- [ ] attached to a MoC (`addRelationship(<moc-uuid>, <note-uuid>, "RELATES_TO")`)
- [ ] lifecycle walked to CANONICAL (submit, then approve as a different actor)

**Extracting from a source**
- [ ] every claim is atomic; skip rate reported honestly
- [ ] `ADD_EXTRACTED_CLAIM` per note + `DERIVED_FROM` edge per note
- [ ] `RECORD_EXTRACTION_STATS`, then `SET_SOURCE_STATUS` -> `EXTRACTED`
- [ ] no source left in INBOX/EXTRACTING once its notes exist

**Any pipeline run**
- [ ] task advanced through each phase with a handoff, then COMPLETE_TASK
- [ ] no PENDING or FAILED tasks left behind
- [ ] `/health` re-run and the report rewritten (the dashboard shows the LAST report)

## Never buy a PASS with a lie

A truthful WARN is worth more than a fabricated PASS. The report exists to
direct attention; an agent that games it destroys the only signal the vault
has about itself. Specifically — do not:

- **Massage a metric.** A 60% skip rate on a thin vendor blog is the finding.
  Rounding it under the 10% target hides that the source was low-yield.
- **Fabricate links or grounding** to raise coverage. A relationship that
  cannot complete "A connects to B because [specific reason]" is noise, and
  grounding a note about PGlite tables in note-taking research is a lie that
  fails the articulation test.
- **Move a finding to a category that happens to be green,** or file it under
  an unrelated enum value to make a FAIL disappear.
- **Report PASS from what you dispatched.** Read it back first.
- **Redefine the denominator to flatter the number.** Scope it honestly
  (e.g. grounded / in-methodology-scope) and say so in the message.

If a check cannot legitimately pass, leave it WARN or FAIL, put the concrete
next action in `recommendations`, and tell the user what it would take.

## Key rules

1. **Two-batch pattern**: Content ops (SET_TITLE, SET_DESCRIPTION, SET_CONTENT) in one batch. Provenance (SET_PROVENANCE) in a separate call.
2. **Description max 200 chars**: Longer descriptions silently fail.
3. **Always verify after creating**: `switchboard docs tree <drive> --format json` to confirm the node exists.
4. **Never batch dependent operations**: Pipeline ops (ADD_TASK → ASSIGN_TASK → ADVANCE_PHASE) must be dispatched one at a time via `docs mutate`.
5. **Never reuse a pipeline task id — a collision is unrecoverable.** `ADD_TASK` appends with no duplicate-id guard, while every other queue op resolves via `tasks.find(t => t.id === taskId)` and so always hits the first match. A second task sharing an id can never be assigned, advanced, completed or failed, and it inflates `activeCount` forever; there is no `REMOVE_TASK`. Generate a fresh UUID per `ADD_TASK`, and if a dispatch times out read the queue back before re-sending — a 502 whose commit lands late is indistinguishable from a failure.
6. **The CLI auto-injects timestamps and action IDs** — no need to generate them manually.
7. **GraphQL identifier arguments take UUIDs, not slugs**: `sourceIdentifier`, `targetIdentifier`, `parentIdentifier`, and `documentIdentifier` take document UUIDs. Drive slugs are CLI-only (`--drive <slug>` is fine — the CLI resolves them). A slug passed to GraphQL `createDocument`/`createEmptyDocument` makes the containment job fail and the create hangs forever.

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
| `/powerhouse-knowledge:projects` | Manage projects (`bai/project`) and WBS goal trees (`bai/wbs`); agent goal-working loop |
| `/powerhouse-knowledge:skills <need>` | Find/read agent skills stored in the vault (semantic, by need) |

## Graph indexer queries (quick reference)

All queries require `driveId: "<UUID>"`.

| Query | Use when |
|-------|----------|
| `knowledgeGraphSemanticSearch(query, mode)` | **Default for natural language.** Server-side embedding, keyword fallback (pkg ≥ 1.0.50) |
| `knowledgeGraphFullSearch(query)` | Exact terms in title+description+content; ANDs terms, so use 1-2 keywords |
| `knowledgeGraphSearch(query)` | Title+description only — narrower than fullSearch |
| `knowledgeGraphNodes` | Every node in one call; cheaper than many searches when scanning |
| `knowledgeGraphByTopic(topic)` | "Notes about X topic" |
| `knowledgeGraphSimilar(documentId)` | "Notes like this one" — needs embeddings, else empty |
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
| `bai/project` | Project tracking: status, owner, team, deliverables | `/projects/` |
| `bai/wbs` | Work-breakdown goal tree for a project | `/projects/` |

## Relationships

Edges between documents live in the reactor's `DocumentRelationship` table since the drive-override migration. Create them with the `addRelationship` GraphQL mutation:

```bash
switchboard query 'mutation { addRelationship(sourceIdentifier:"<source-uuid>", targetIdentifier:"<target-uuid>", relationshipType:"RELATES_TO", branch:"main"){ documentType } }'
```

Valid `relationshipType` values:

| Type | Meaning |
|------|---------|
| `RELATES_TO` | General thematic connection |
| `BUILDS_ON` | Extends or strengthens the target |
| `CONTRADICTS` | Challenges the target |
| `SUPERSEDES` | Replaces the target |
| `DERIVED_FROM` | Extracted from the target |
| `CORE_IDEA` | MoC → note: this note is a core idea of the MoC |
| `CHILD_MOC` | Parent MoC → child MoC: hub/domain hierarchy |

Idempotent on `(source, target, type)`. To remove a relationship, use `removeRelationship` with the same argument shape. The legacy `--op addLink` / `--op addCoreIdea` / `--op addChildMoc` document-scope actions are bypassed by the graph subgraph and should not be used for new code.

## Quality principles

- Each note makes **one atomic claim**
- Every link passes the **articulation test**: "A connects to B because [specific reason]"
- **Progressive disclosure**: title → description → content, each layer adds detail
- **Minimum 2 connections** per note
- Keep descriptions under **200 characters**
