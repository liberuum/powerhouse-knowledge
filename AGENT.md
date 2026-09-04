# For AI Agents

> **The golden rule: read however you like — write ONLY through the CLI.**
> Reads (queries, searches, state checks) are safe over raw GraphQL and faster (~0.2s vs ~1-2s).
> Writes (create, mutate, link) go through the `switchboard` CLI or the vetted scripts: they
> auto-stamp every action with `id` + `timestampUtcMs` and resolve drive slugs to UUIDs.
> A single raw write missing the action `id` permanently breaks sync for every connected client.
> Bulk writes: batch into one `switchboard docs apply --file` call.
> If you must write raw anyway, follow every rule in CONFIGURATION.md → "Writing via raw GraphQL — the safety rules".

You are working on a **Powerhouse Knowledge Vault** through the `powerhouse-knowledge` plugin. The vault is a graph of atomic knowledge notes (`bai/knowledge-note`) organised by Maps of Content (`bai/moc`), fed by source documents (`bai/source`), tracked by a pipeline queue, and read by humans in the Knowledge Vault app. **Your job is the write path:** take source material in, extract atomic notes and create them correctly, connect them, place them in the MoC hierarchy, and verify the result. Everything else here serves that.

This file is the single canonical instruction set. `agents/knowledge-agent.md` is **generated from it** (`node scripts/build-agent.mjs`) — never edit that file by hand.

## Start here — the first five minutes

1. **Establish the target.** There is no default vault. Read the pre-flight hook output (`Profile: … -> …`, `VAULT_DRIVE_ID`, `VAULT_DRIVE_SLUG`) or run `switchboard config show`; if it is ambiguous which vault the user means, **ask** for the Switchboard URL and drive. See *First: Establish which vault to use*.
2. **Find the drive** — the one containing a `bai/vault-config` document. See *Find the vault drive*. Keep its UUID (for `knowledgeGraph*` queries) and slug (for `--drive`).
3. **Check it is ready** — folders and the three singletons exist: `/powerhouse-knowledge:setup`.
4. **Know the job** — read *The job: from source to connected notes* below. Most requests are one of: seed a source, run the pipeline on it, search, or check health.
5. **Pick the skill** from *Available skills* and read its `SKILL.md` before acting; each skill is the detailed procedure for one step.

## Deep-dive references

| What you need | Read this |
|---------------|-----------|
| Connection setup (CLI profiles, GraphQL, MCP, raw-write safety rules) | [CONFIGURATION.md](CONFIGURATION.md) |
| Switchboard CLI commands (drives, docs, mutations, queries) | [skills/cli-reference/SKILL.md](skills/cli-reference/SKILL.md) |
| Search (semantic, keyword, topic, provenance; rich-context recipe) | [skills/search/SKILL.md](skills/search/SKILL.md) |
| Graph analysis (triangles, bridges, clusters, semantic neighbourhoods) | [skills/graph/SKILL.md](skills/graph/SKILL.md) |
| Finding and creating links between notes | [skills/connect/SKILL.md](skills/connect/SKILL.md) |
| Extracting atomic claims from source material | [skills/extract/SKILL.md](skills/extract/SKILL.md) |
| Ingesting source material into the vault | [skills/seed/SKILL.md](skills/seed/SKILL.md) |
| Creating MoCs and the MoC hierarchy | [skills/synthesize/SKILL.md](skills/synthesize/SKILL.md) |
| Quality checks and auto-repair | [skills/verify/SKILL.md](skills/verify/SKILL.md) |
| Vault health diagnostics | [skills/health/SKILL.md](skills/health/SKILL.md) |
| End-to-end processing pipeline | [skills/pipeline/SKILL.md](skills/pipeline/SKILL.md) |
| Vault initialisation and structure verification | [skills/setup/SKILL.md](skills/setup/SKILL.md) |
| Bulk import from markdown/Obsidian/JSON | [skills/import/SKILL.md](skills/import/SKILL.md) |
| Export vault as markdown/JSON/backup | [skills/export/SKILL.md](skills/export/SKILL.md) |
| Real-time vault monitoring | [skills/watch/SKILL.md](skills/watch/SKILL.md) |
| Scopes of work, project envelopes and WBS goal trees | [skills/projects/SKILL.md](skills/projects/SKILL.md) |
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
switchboard init --url https://<host>-switchboard.vetra.io/graphql --name remote-vault --use-profile   # CLI ≥ 1.0.34 (non-interactive)
switchboard ping
```

Two things to verify before trusting results, because both fail quietly:

```bash
# 1. Are the bai/* models deployed on that Switchboard?
#    If KnowledgeNote is absent, the drive may exist but nothing can read it properly.
switchboard query '{ __schema { types { name } } }' --format json | grep -c KnowledgeNote

# 2. Has the graph projection been built for this drive?
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount noteCount edgeCount orphanCount openTensionCount } }'
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

Save the drive slug and UUID — you'll need them for every query. Then read the tree once to learn folder UUIDs (`switchboard docs tree <drive-slug> --format json`).

## The job: from source to connected notes

Content enters as a **source** and leaves as **connected, verified notes inside the MoC hierarchy**. The six R names are the vocabulary; the queue task underneath has four phases.

```
Record   →  /seed        bai/source in /sources/, INGEST_SOURCE, status → EXTRACTING, ADD_TASK (taskType "claim")
Reduce   →  /extract     one bai/knowledge-note per atomic claim (phase "create")
Reflect  →  /connect     typed relationships via `docs link --reason`, the articulation stored on the edge (phase "reflect")
Reweave  →  /synthesize  MoC membership (CORE_IDEA), MoC hierarchy (CHILD_MOC), update older notes (phase "reweave")
Verify   →  /verify      recite test, schema, link health; auto-repair; then /health and rewrite the report (phase "verify")
Rethink  →  /health, /graph   challenge the structure against the evidence
```

Either the **user** does step 1 in the app (paste a source, click *Queue for Processing* — which sets `EXTRACTING` and adds the task) and you run `/powerhouse-knowledge:pipeline`, or you do all of it with `/seed` then `/pipeline`. The pipeline-queue task moves `create → reflect → reweave → verify` via `ADVANCE_PHASE` with a handoff per phase; **the final advance completes the task by itself**.

What "created correctly" means for one note is the *Definition of done* below — read it before extracting.

## Search the vault

**Start with `knowledgeGraphSemanticSearch`** (package ≥ 1.0.50). Send the
question in plain natural language — the Switchboard embeds the query
server-side and ranks by meaning, falling back to keyword search
transparently if embeddings are unavailable, so it is always safe to call.

**To answer a question, fetch context in two calls, not twenty.** The node type carries `content`, so one search returns the full text of the best hits; a second aliased query pulls the neighbourhood of the top ones. The recipe is in [skills/search/SKILL.md](skills/search/SKILL.md) § *Rich context in two calls*.

```bash
# DEFAULT: semantic/hybrid search from plain query text — select content when you need to answer, not just list
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "how does the reactor store operations?", mode: HYBRID, limit: 6) { similarity matchedBy node { documentId title description content noteType status } } }'
```

- `similarity` is **always a 0–1 relevance** and always decreases down the result list, so it is safe to render as a percentage or threshold on in either mode (package ≥ 1.0.52).
- `mode: SEMANTIC` — pure vector ranking; `similarity` is cosine (>0.8 is a strong match)
- `mode: HYBRID` — semantic + keyword rank fusion, rescaled onto 0–1: **~1.0 = matched by both signals at top rank, ~0.5 = matched by only one signal**. Select `matchedBy` to see which fired.
- `score` carries the RAW number instead — cosine in SEMANTIC, the Reciprocal Rank Fusion weight in HYBRID (ordinal, tops out near 0.033) — **never render `score` as a percentage**.
- `topics` is a per-node field resolver (one server-side query per row). One whole-vault fetch per run is cheap (~0.3 s for 500 notes); selecting it inside a per-hit loop is not.
- **MoCs are nodes too** and come back from every query with `status = "MOC"` and `noteType = "MOC (<tier>)"` — filter them when the question is about notes.
- **Scopes of work and work breakdowns are nodes too** (package ≥ 1.0.54-dev.7): `status = "SCOPE"` / `"WBS"` (sentinels, like MoCs — a scope's own DRAFT would otherwise pollute note-lifecycle queries) with the real state in `noteType` (`Scope (IN_PROGRESS)`, `WBS (BLOCKED)`); their `content` is a rendered outline (envelopes, deliverables, quotes, milestones, contributors / the goal tree), so a search for a deliverable finds its project. They are not knowledge nodes: excluded from orphans, density and `edgeCount`. A scope carries derived edges `CITES` (→ each note/MoC in an envelope's `knowledgeRefs`) and `DELIVERED_BY` (→ its WBS), so a note's backlinks show which project cites it.
- If the field doesn't exist (schema validation error), the deployment runs an older package — fall back to `knowledgeGraphFullSearch`.

Keyword search still matters for exact terms — but **`knowledgeGraphFullSearch` ANDs its terms**, so give it 1–2 distinctive keywords, never a sentence:

```bash
switchboard query '{ knowledgeGraphFullSearch(driveId: "<UUID>", query: "operation store", limit: 20) { documentId title noteType } }'
```

Other retrieval paths, always available:

```bash
switchboard query '{ knowledgeGraphSimilar(driveId: "<UUID>", documentId: "<NOTE-ID>", limit: 5) { node { documentId title } similarity } }'
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "reactor") { documentId title } }'
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'
switchboard query '{ knowledgeGraphNodeByDocumentId(driveId: "<UUID>", documentId: "<NOTE-ID>") { title description content topics status } }'
```

Embeddings are computed server-side by the graph-indexer processor; `knowledgeGraphMissingEmbeddings(driveId)` should be `[]` shortly after a deployment boots.

## Read a document

```bash
switchboard docs get <document-id> --state --format json
```

Sources, health reports, the pipeline queue and the vault config are **not** in the graph index — read them this way, by id. Scopes of work and WBS *are* indexed (as `SCOPE` / `WBS` nodes with an outline as `content`), but their full structured state — quotes, budgets, `goalRef`s, goal notes — is still read this way.

## Create a note

```bash
# Create the document in /knowledge/notes/
switchboard docs create --type bai/knowledge-note --name "my-note-slug" --drive <drive-slug> --parent-folder <notes-folder-uuid> --format json

# Batch 1: content (independent operations)
switchboard docs apply <doc-id> --actions '[
  {"type":"SET_TITLE","input":{"title":"My claim","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_DESCRIPTION","input":{"description":"Brief summary (<= 200 chars)","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_NOTE_TYPE","input":{"noteType":"concept","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"SET_CONTENT","input":{"content":"Full body...","updatedAt":"<ISO>"},"scope":"global"},
  {"type":"ADD_TOPIC","input":{"id":"<uuid>","name":"reactor"},"scope":"global"}
]'

# Batch 2: provenance, separately (a validation failure kills the whole batch it is in)
switchboard docs mutate <doc-id> --op setProvenance --input '{"author":"knowledge-agent","sourceOrigin":"DERIVED","createdAt":"<ISO>"}'

# Verify it exists — never assume from a successful dispatch
switchboard docs tree <drive-slug> --format json | grep <doc-id>
```

## Definition of done — leave the vault at 100% health

The vault is expected to sit at **all checks PASS**. That standard is met by
completing the work, never by making the report look green. Before you call
any vault task finished, every line below must be true — and **verified by
reading state back**, not assumed from a successful dispatch (invalid enums,
over-long descriptions and bad timestamps all fail silently).

**Creating a note**
- [ ] title (a declarative claim), description (<= 200 chars, adds information beyond the title), `noteType` (one of the ten lowercase values), content
- [ ] topics added; provenance set in a SEPARATE dispatch from content
- [ ] >= 2 typed relationships, each created with `--reason` (the articulation test, on the edge) and `--confidence` where you can say
- [ ] attached to a MoC (`switchboard docs link <moc-uuid> <note-uuid> -t CORE_IDEA` — the MoC editor only renders `CORE_IDEA`/`CHILD_MOC` edges as membership; a `RELATES_TO` edge is indexed but never shows as belonging to the MoC)
- [ ] lifecycle walked to CANONICAL (submit, then approve as a different actor — approval is only legal from `IN_REVIEW`)

**Extracting from a source**
- [ ] every claim is atomic; skip rate reported honestly
- [ ] `ADD_EXTRACTED_CLAIM` per note + `DERIVED_FROM` edge per note (`switchboard docs link <note> <source> -t DERIVED_FROM --reason "<where in the source the claim comes from>" --confidence grounded`)
- [ ] `RECORD_EXTRACTION_STATS`, then `SET_SOURCE_STATUS` -> `EXTRACTED`
- [ ] no source left in INBOX/EXTRACTING once its notes exist

**Placing notes in the MoC hierarchy**
- [ ] every note is a `CORE_IDEA` of at least one TOPIC or DOMAIN MoC
- [ ] every TOPIC/DOMAIN MoC is a `CHILD_MOC` of a parent — a DOMAIN, or the vault's single HUB
- [ ] no MoC is left unreachable from the HUB (see *MoC hierarchy*)

**Any pipeline run**
- [ ] task advanced through each phase with a handoff — the **final `ADVANCE_PHASE` auto-completes** the task (sets DONE, `completedCount+1`, `activeCount-1`). Do **not** follow it with `COMPLETE_TASK`: that increments `completedCount` a second time and the metrics never recover. `COMPLETE_TASK` is only for a task you are ending early.
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
  fails the articulation test. The same goes for the reason itself: a
  `--reason` that restates the type ("relates to B") or the two titles is a
  bare edge wearing a costume — articulated coverage counts sentences a
  reader can check, not filler that satisfies the hook.
- **Move a finding to a category that happens to be green,** or file it under
  an unrelated enum value to make a FAIL disappear.
- **Report PASS from what you dispatched.** Read it back first.
- **Redefine the denominator to flatter the number.** Scope it honestly
  (e.g. grounded / in-methodology-scope) and say so in the message.

If a check cannot legitimately pass, leave it WARN or FAIL, put the concrete
next action in `recommendations`, and tell the user what it would take.

## Key rules

1. **Batch freely — `docs apply` is ordered and per-action isolated** (verified 2026-09-02, CLI 1.0.32, reactor 6.2.2-dev.71). Actions run in the order given; an action whose reducer rejects it (over-long description, invalid enum, unknown task id) is recorded with its error and **skipped**, and the actions before and after it still land. So one batch can carry content + topics + provenance, or ADD_TASK → ASSIGN_TASK → ADVANCE_PHASE, or three chained advances — one round trip instead of three to six. Older guidance about a "two-batch pattern" and "never batch dependent ops" described a reactor that no longer behaves that way.
2. **The job reports success even when an action failed.** `--wait` returns `error: null` / `READ_READY` with a rejected action inside, and the operation log's summary still reads as if it applied. **Read back — and read the operation log, which names the rejection.** Every operation carries an `error` field: `document(identifier){ document{ operations(filter:{scopes:["global"], sinceRevision: <rev before your batch>}){ items{ index error action{ type } } } } }` lists each rejected action with the reactor's own reason ("Description exceeds 200 characters", the zod issue with the allowed enum values). **This runs automatically:** the plugin's `PostToolUse` hook reads the recent operations after every `docs apply` / `docs mutate` you issue and prints any rejection with its reason. Batching moves the cost from round trips to read-backs; the hooks do the read-back for you, but a state check of the fields you care about is still yours.
3. **Limits: compute, never estimate — and lint before you dispatch.** Across all twelve models the reducers enforce exactly **one** hard length limit: a knowledge note's `description` must be **≤ 200 characters**, counted the way JavaScript counts (`.length`, UTF-16 units — an emoji is 2; Python's `len()` says 1, which is how an agent "checks" 200 and still fails). Titles have no limit; nothing on MoC, source, tension, observation, scope of work or WBS is length-limited (keep descriptions readable, ~150–200). An over-long description is rejected with `DescriptionTooLongError` while the rest of the batch applies, so the note ends up with *no* description and the job still reports success. Do not count by eye and do not try-fail-adjust: run `node scripts/lint-actions.mjs <actions.json>` before every `docs apply` — it checks the 200 limit the reactor's way, every enum the reactor drops silently (`noteType`, `sourceOrigin`, `SourceStatus`, `taskType`, `HealthCategory`, `MocTier`, …), and double-encoded line breaks, and exits non-zero with the JSON path of each problem. **This runs automatically:** the plugin's `PreToolUse` hook lints every `switchboard docs apply` / `docs mutate` you issue and blocks the command if the payload would be rejected — you will see the finding instead of a silent partial write.
4. **Always verify after creating**: `switchboard docs tree <drive> --format json` to confirm the node exists. CLI bugs and network blips cause silent failures.
5. **Never reuse a pipeline task id — a collision is unrecoverable.** `ADD_TASK` appends with no duplicate-id guard, while every other queue op resolves via `tasks.find(t => t.id === taskId)` and so always hits the first match. A second task sharing an id can never be assigned, advanced, completed or failed, and it inflates `activeCount` forever; there is no `REMOVE_TASK`. Generate a fresh UUID per `ADD_TASK`, and if a dispatch times out read the queue back before re-sending.
6. **Enum values are validated silently.** A `HealthCategory`, `sourceOrigin`, `SourceStatus`, `taskType` or `relationshipType` outside the model's set reports success and writes nothing (or writes an unreachable record). Read the document back and confirm your writes landed.
7. **The CLI auto-injects timestamps and action IDs** — never generate them manually for CLI writes.
8. **GraphQL identifier arguments take UUIDs, not slugs**: `sourceIdentifier`, `targetIdentifier`, `parentIdentifier`, `documentIdentifier` take document UUIDs. Drive slugs are CLI-only (`--drive <slug>` is fine — the CLI resolves them). A slug passed to GraphQL `createDocument` makes the containment job fail and the create hangs forever.
9. **Re-run health after every fix.** The dashboard shows the LAST report; a repair after a run leaves the UI showing stale problems.
10. **Line breaks: the string must hold real newlines *before* it is JSON-encoded — encode once, then read back.** The failure is double encoding: a bash `"\n"` is two characters, and a script that then JSON-encodes that argument escapes the backslash again, so the note is stored with the text `\n` between paragraphs. The write reports success. Put the body in a file or heredoc (or build it inside Python), serialize once, `docs apply --file`, then read `content` back and confirm it contains real newlines. The CLI (≥ 1.0.32) refuses payloads whose strings carry a literal `\n`/`\t`/`\r` and names the field — `--allow-literal-escapes` overrides for the rare legitimate case.
11. **Methodology lives on disk.** `data/methodology/*.md` (249 files) ships with the plugin and is read with Grep/Read — it is not imported into the vault.

## Available skills

| Command | What it does |
|---------|-------------|
| `/powerhouse-knowledge:setup` | Verify the vault is ready: folders, singletons, methodology files |
| `/powerhouse-knowledge:seed` | Ingest source material and queue it |
| `/powerhouse-knowledge:extract` | Extract atomic claims from a source into notes |
| `/powerhouse-knowledge:connect` | Find and create typed links |
| `/powerhouse-knowledge:synthesize` | Create MoCs from topic clusters and maintain the MoC hierarchy |
| `/powerhouse-knowledge:verify` | Quality gate + auto-repair |
| `/powerhouse-knowledge:pipeline` | Full end-to-end processing of a queued source |
| `/powerhouse-knowledge:health` | Vault health diagnostics, saved to the health report |
| `/powerhouse-knowledge:search <query>` | Multi-tier search; rich-context recipe for answering questions |
| `/powerhouse-knowledge:graph` | Graph structure analysis |
| `/powerhouse-knowledge:projects` | Scopes of work (`powerhouse/scopeofwork`) — the envelopes are the projects — and WBS goal trees (`bai/wbs`) |
| `/powerhouse-knowledge:import <path>` / `:export` | Bulk import / export |
| `/powerhouse-knowledge:watch` | Real-time monitoring |
| `/powerhouse-knowledge:skills <need>` | Find agent skills stored in the vault |

## Document types and folders

| Type | Purpose | Folder |
|------|---------|--------|
| `bai/knowledge-note` | Atomic claims | `/knowledge/notes/` |
| `bai/moc` | Maps of Content | `/knowledge/` |
| `bai/source` | Raw source material | `/sources/` |
| `bai/pipeline-queue` | Task tracker (singleton) | `/ops/queue/` |
| `bai/health-report` | Diagnostics (singleton) | `/ops/health/` |
| `bai/vault-config` | Config (singleton; the drive is detected by this document) | `/self/` |
| `bai/tension` | Unresolved contradictions | `/ops/` |
| `bai/observation` | Operational signals | `/ops/` |
| `powerhouse/scopeofwork` | Scope of work: envelopes (the projects), priced deliverables, roadmaps, milestones, contributors | `/projects/` |
| `bai/wbs` | Work-breakdown goal tree that delivers one envelope | `/projects/` |
| _(methodology)_ | _249 Ars Contexta claims_ | _local: `data/methodology/`, not in the vault_ |

The drive app scaffolds 12 folders on first open: `knowledge/{notes,inbox,insights}`, `sources`, `projects`, `ops/{sessions,health,queue}`, `self/methodology`. There is **no** graph singleton — the graph lives in the indexer's tables and is read through `knowledgeGraph*` queries. The three singletons are PipelineQueue, HealthReport and VaultConfig. Read the tree first to find folder UUIDs: `switchboard docs tree <drive-slug> --format json`.

## Document models and operations

### `bai/knowledge-note`

**State:** title (a prose sentence making one claim), description (≤ 200 chars), content (markdown), noteType, status (`DRAFT` → `IN_REVIEW` → `CANONICAL`, or `ARCHIVED`), topics[], provenance, metadata fields (scope, confidence, severity, context, model, version, filePath, …). The note's `links[]` array is **legacy** — edges live in the relationship table (see *Relationships*), and the graph ignores `links[]`.

**Metadata is where a note stops being prose.** 18 whitelisted string fields (`scope`, `confidence`, `severity`, `editor`, `modelId`, `version`, `filePath`, `computes`, `context`, `decisionStatus`, `model`, `sourceType`, `targetType`, `relationType`, `cardinality`, `errorMessage`, `rootCause`, `correctPattern`) and 9 list fields (`models`, `modules`, `hooksUsed`, `dispatchTargets`, `inputs`, `outputs`, `consumedBy`, `alternatives`, `consequences`). Which ones a note should carry depends on its `noteType` — the table is in [skills/extract/SKILL.md](skills/extract/SKILL.md) § *Populate the structured metadata*. Fill what the source supports; leave the rest empty.

**`noteType`** — ten lowercase values, always lowercase: `concept`, `decision`, `pattern`, `observation`, `procedure`, `architecture`, `bug-pattern`, `integration`, `workflow`, `reference`.

Content: `SET_TITLE { title, updatedAt }` · `SET_DESCRIPTION { description, updatedAt }` · `SET_NOTE_TYPE { noteType, updatedAt }` · `SET_CONTENT { content, updatedAt }` · `PATCH_CONTENT { offset, removeCount, insert, updatedAt }` · `SET_METADATA_FIELD { field, value, updatedAt }` · `SET_METADATA_LIST_FIELD { field, values[], updatedAt }` (the only way to write list metadata such as `models`, `inputs`, `outputs`, `modules`, `alternatives`, `consequences`)

Topics: `ADD_TOPIC { id, name, topicDocumentId? }` · `REMOVE_TOPIC { id }`

Lifecycle: `SUBMIT_FOR_REVIEW { id, actor, timestamp, comment? }` · `APPROVE_NOTE { id, actor, timestamp, comment? }` (only from `IN_REVIEW`; actor ≠ author) · `REJECT_NOTE`, `ARCHIVE_NOTE` `{ id, actor, timestamp, comment }` · `RESTORE_NOTE { id, actor, timestamp, comment? }`

Provenance: `SET_PROVENANCE { author, sourceOrigin, sessionId?, createdAt }` — `sourceOrigin` ∈ `DERIVED`, `IMPORT`, `MANUAL`, `SESSION_MINE`

### `bai/moc`

**State:** title, description, orientation (the MoC's body: what this area is and how to read it), tier (`HUB` | `DOMAIN` | `TOPIC`), tensions[], openQuestions[], agentNotes[], noteCount. Membership and hierarchy are **edges**, not state (see *MoC hierarchy*).

`CREATE_MOC { title, description, orientation, tier, parentRef?, createdAt }` · `UPDATE_DESCRIPTION { description, updatedAt }` · `UPDATE_ORIENTATION { orientation, updatedAt }` · `ADD_TENSION { id, description, involvedRefs[], addedAt }` / `REMOVE_TENSION { id }` · `ADD_OPEN_QUESTION { question }` / `REMOVE_OPEN_QUESTION { id }` · `SET_METADATA_FIELD { field, value, updatedAt }`. When a MoC for a topic already exists, **update it** rather than creating a second.

### `bai/source`

**State:** title, description, content, sourceType, status (`INBOX` → `EXTRACTING` → `EXTRACTED` → `ARCHIVED`), provenance, extractedClaims[], extractionStats.

`INGEST_SOURCE { title, content, sourceType, description?, author?, url?, publishedAt?, method?, tool?, createdAt, createdBy? }` · `SET_SOURCE_STATUS { status }` · `ADD_EXTRACTED_CLAIM { claimRef }` · `RECORD_EXTRACTION_STATS { claimCount, skippedCount, skipRate, extractedAt, extractedBy? }`

`sourceType` ∈ `ARTICLE`, `PAPER`, `BOOK_CHAPTER`, `TRANSCRIPT`, `DOCUMENTATION`, `CONVERSATION`, `WEB_PAGE`, `MANUAL_ENTRY`. Note → source provenance is the `DERIVED_FROM` edge; the source's `extractedClaims` is the other direction.

### `bai/tension`

Unresolved contradictions between claims. Live in `/ops/`. **State:** title, description, content, involvedRefs[], status (`OPEN` | `RESOLVED` | `DISSOLVED`), observedAt, observedBy, resolution, resolvedAt.

`CREATE_TENSION { title, description, content?, involvedRefs[], observedAt, observedBy? }` · `RESOLVE_TENSION { resolution, resolvedAt }` (one side is right) · `DISSOLVE_TENSION { resolution, resolvedAt }` (both compatible) · `ADD_INVOLVED_REF { ref }`.

**Opened automatically.** On a Switchboard running vault package ≥ 1.0.55 the graph-indexer opens a tension the moment a `CONTRADICTS` relationship lands — in `/ops` with a short title (`Contradiction on <shared topics or words>`; both claims in full in the description), `observedBy: graph-indexer`, one per unordered pair, and it adds an `ADD_TENSION` entry (id = the tension's document id) to every MoC holding either note as a `CORE_IDEA`. After adding a CONTRADICTS edge, read the tension back (it is the `INVOLVES` backlink on either note) and **articulate** the conflict in both notes' content, then resolve or dissolve when you can. Do not create a second one by hand; fall back to manual creation only on an older Switchboard. See [skills/connect/SKILL.md](skills/connect/SKILL.md) § Tension detection. Open tensions are what `/health` grades under `THREE_SPACE_BOUNDARIES`.

### `bai/observation`

Operational signals about how the vault is being worked. Live in `/ops/`. **State:** title, description, content, category (`METHODOLOGY` | `PROCESS` | `FRICTION` | `SURPRISE` | `QUALITY`), status (`PENDING` → `PROMOTED` → `IMPLEMENTED`, or `ARCHIVED`), observedAt, observedBy.

`CREATE_OBSERVATION { title, description, content?, category, observedAt, observedBy? }` · `PROMOTE_OBSERVATION` · `IMPLEMENT_OBSERVATION` · `ARCHIVE_OBSERVATION`. `/health` files PENDING observations under `PROCESSING_THROUGHPUT`.

### `bai/pipeline-queue`

Singleton in `/ops/queue/`. `ADD_TASK { id, taskType, target, documentRef?, createdAt }` · `ASSIGN_TASK { taskId, assignedTo, updatedAt }` · `ADVANCE_PHASE { taskId, handoff: { id, phase, workDone, filesModified, completedAt, completedBy? }, updatedAt }` · `COMPLETE_TASK { taskId, updatedAt }` · `FAIL_TASK { taskId, reason, updatedAt }` · `BLOCK_TASK { taskId, reason, updatedAt }` · `UNBLOCK_TASK { taskId, updatedAt }`

`taskType` is **`claim`** (phases `create → reflect → reweave → verify`) or **`enrichment`** (`enrich → reflect → reweave → verify`). Nothing else exists in `phaseOrder`: any other value yields a task that can never advance or complete. The final `ADVANCE_PHASE` completes the task; never follow it with `COMPLETE_TASK`. Check for an existing task with the same `documentRef` before adding one.

### `bai/health-report`

Singleton in `/ops/health/`. Checks use `HealthCategory` ∈ `SCHEMA_COMPLIANCE`, `ORPHAN_DETECTION`, `LINK_HEALTH`, `DESCRIPTION_QUALITY`, `THREE_SPACE_BOUNDARIES` (open tensions), `PROCESSING_THROUGHPUT`, `STALE_NOTES`, `MOC_COHERENCE` (notes without topics) — there is **no** `METHODOLOGY_GROUNDING`; report grounding in `recommendations`. Status ∈ `PASS`, `WARN`, `FAIL`. See [skills/health/SKILL.md](skills/health/SKILL.md).

### `powerhouse/scopeofwork` and `bai/wbs`

A **project is an envelope inside a scope-of-work document**, not a document of its own; each envelope links the `bai/wbs` that delivers it (`wbsRef` ↔ `sowRef`+`sowProjectId`) and each deliverable names the goal that delivers it (`goalRef`). `bai/project` is retired — never create one. See [skills/projects/SKILL.md](skills/projects/SKILL.md) for the 39 + 15 operations and the enums (`ScopeOfWorkStatus`, `DeliverableStatus`, `DeliverableSetStatus`, `Unit`, `BudgetType`, `PMCurrency`, `GoalStatus`). Both are graph-indexed as `SCOPE` / `WBS` nodes (searchable outline, `CITES` / `DELIVERED_BY` derived edges); mutate them by id.

## Relationships

Edges between documents live in the reactor's `DocumentRelationship` table. Create them with `switchboard docs link` (CLI ≥ 1.0.36; a signed `ADD_RELATIONSHIP`, see § Signed writes) — **not** the legacy `ADD_LINK` / `ADD_CORE_IDEA` / `ADD_CHILD_MOC` document actions, which the graph does not index:

```bash
# A knowledge edge carries its reason ON THE EDGE (relationship metadata)
switchboard docs link <source-uuid> <target-uuid> -t BUILDS_ON \
  --reason "<source> extends <target>'s claim about X to Y" --confidence established
# Change the reason / confidence of an existing edge (UPDATE_RELATIONSHIP)
switchboard docs annotate <source-uuid> <target-uuid> -t BUILDS_ON --reason "…"
switchboard docs unlink <source-uuid> <target-uuid> -t BUILDS_ON
# Navigation edges have no reason to give — their meaning is the type
switchboard docs link <moc-uuid> <note-uuid> -t CORE_IDEA
```

`--reason` is the **articulation test in data**: "A connects to B because [specific reason]". The pre-write hook blocks a `RELATES_TO` / `BUILDS_ON` / `CONTRADICTS` / `SUPERSEDES` / `DERIVED_FROM` link without one (a real sentence, ≥ 20 chars — not the type name, not "because"); `CORE_IDEA` and `CHILD_MOC` may stay bare. `--confidence` ∈ `grounded` (backed by evidence or a source) · `established` (well accepted, not evidenced here) · `speculative` (a lead). The graph exposes both on every edge (`knowledgeGraphEdges { reason confidence }`) and `knowledgeGraphStats.articulatedEdgeCount / edgeCount` is the coverage `/health` reports. A repeated `docs link` for the same `(source, target, type)` is a no-op in the reactor, metadata included — that is why changing a reason is `docs annotate`.

| Type | Direction | Meaning |
|------|-----------|---------|
| `RELATES_TO` | note → note | General thematic connection |
| `BUILDS_ON` | note → note | Extends or strengthens the target |
| `CONTRADICTS` | note → note | Challenges the target — the indexer opens a `bai/tension` for the pair |
| `SUPERSEDES` | note → note | Replaces the target |
| `DERIVED_FROM` | note → source | Extracted from this source |
| `CORE_IDEA` | MoC → note | This note is a core idea of the MoC (membership) |
| `CHILD_MOC` | MoC → MoC | Parent → child in the hierarchy |
| `INVOLVES` | tension → note | **Derived** by the indexer from a tension's `involvedRefs`; not created with `docs link` |
| `PROMOTED_TO` | observation → note | **Derived** from an observation's `promotedTo` |

The two derived types appear in `knowledgeGraphEdges`, backlinks and forward links so a reader sees what involves a note, but they are **not** knowledge edges: `stats.edgeCount`, density, orphans, triangles and bridges count the seven types above only. Idempotent on `(source, target, type)`. The *reason* a link exists lives on the edge (`--reason`, above); the note body may still carry the longer argument, but the edge is what the graph and the health report can check. An **orphan** is a node with zero **incoming** edges; outgoing links from it do not change that.

## Signed writes — the first step before writing

A Switchboard signs every unsigned action with **its own** Renown identity and
stamps the user from **its own** `ph login` session. An agent writing unsigned
is therefore attributed to whoever logged the *server* in, or to nobody. The
plugin's pre-write hook **blocks** `docs apply` / `mutate` / `link` / `unlink`
/ `create` until the active profile has a signing identity, and labels every
allowed write `SWITCHBOARD_APP_NAME=powerhouse-knowledge` so the vault's
Activity view and every note's History tab read *"powerhouse-knowledge ·
<did:key> for <address>"* with a verified ✓.

```bash
ph login                          # once per machine: .ph/.keypair.json + .ph/.renown.json
switchboard auth login --renown   # CLI ≥ 1.0.34; --ph-dir <dir> if the login lives elsewhere
switchboard auth status           # Signing: on as switchboard-cli (did:key:z…) acting for 0x…
```

If the hook blocks you, relay those three commands to the user — do not
work around the block with raw GraphQL (`addRelationship`, `mutateDocument`):
those are server-signed and the hook refuses them for that reason.
`POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED=1` exists for deliberate unsigned writes
only. The Renown credential binding key→address lasts 7 days; `auth status`
warns when it has expired (`ph login` renews it — signatures stay valid).

## MoC hierarchy

Maps of Content form a tree that both humans and agents use to explore the vault by cluster. Keep it to three tiers, one root:

| Tier | What it holds | Size | Parent |
|------|---------------|------|--------|
| `TOPIC` | a focused cluster of notes (`CORE_IDEA` edges) | 3–9 notes | a `DOMAIN`, or the HUB if no domain fits |
| `DOMAIN` | a broad area: its own `CORE_IDEA` notes plus `CHILD_MOC` TOPIC MoCs | 10+ notes, or 2+ topic MoCs | the HUB |
| `HUB` | the vault's single entry point: `CHILD_MOC` edges to every DOMAIN (and any TOPIC without a domain) | one per vault | — |

Rules the pipeline applies (`/synthesize`, reweave phase):

- A topic with **3+ notes and no MoC** gets a TOPIC MoC; every note becomes a `CORE_IDEA`.
- When **2+ TOPIC MoCs share a broader theme**, or a topic grows past ~10 notes, create (or promote to) a DOMAIN MoC and `CHILD_MOC` the topics under it.
- As soon as the vault has **3+ DOMAIN/TOPIC MoCs**, create the HUB (if absent) and `CHILD_MOC` every parentless MoC under it. Every new MoC is attached to a parent in the same run — **no MoC is left unreachable from the HUB.**
- Existing MoC for the theme? `UPDATE_DESCRIPTION` / `UPDATE_ORIENTATION` and add members — never create a duplicate.
- The `tier` field is set at `CREATE_MOC`; a MoC with no tier is projected as `TOPIC`.

Read the hierarchy with `knowledgeGraphEdges(driveId)` filtered to `CHILD_MOC` (MoC nodes have `status = "MOC"`). A well-kept vault has exactly one MoC with no incoming `CHILD_MOC` edge: the HUB.

## Graph indexer queries (quick reference)

All queries take `driveId: "<UUID>"` (a slug is also accepted). Five kinds are indexed — `bai/knowledge-note`, `bai/moc`, `bai/research-claim`, `bai/tension`, `bai/observation` — and every node carries `documentType` so you can tell them apart (see [skills/search/SKILL.md](skills/search/SKILL.md) for the table). Tensions and observations are indexed to be *found*, not counted as knowledge: they never appear in `orphans`, and `stats` reports `noteCount`, `mocCount`, `claimCount`, `tensionCount`, `openTensionCount`, `observationCount` beside the total `nodeCount`. Knowledge edges come from `docs link` (ADD_RELATIONSHIP); `INVOLVES` / `PROMOTED_TO` are derived from state.

| Query | Use when |
|-------|----------|
| `knowledgeGraphSemanticSearch(query, mode, limit)` | **Default for natural language.** Select `content` to answer, not just list |
| `knowledgeGraphFullSearch(query, limit)` | Exact terms in title+description+content; ANDs terms — 1–2 keywords |
| `knowledgeGraphSearch(query, limit)` | Title+description only |
| `knowledgeGraphNodeByDocumentId(documentId)` | One full node (content, topics) |
| `knowledgeGraphNodesByStatus(status)` | All notes in a lifecycle state, or all MoCs (`"MOC"`), scopes of work (`"SCOPE"`), work breakdowns (`"WBS"`) |
| `knowledgeGraphNodesByType(documentType)` | All nodes of one kind — e.g. every `bai/tension` |
| `knowledgeGraphByTopic(topic)` / `knowledgeGraphTopics` | Topic membership / the topic vocabulary with counts |
| `knowledgeGraphSimilar(documentId, limit)` | Semantic neighbours of a note |
| `knowledgeGraphRelatedByTopic(documentId, limit)` | Notes sharing topics |
| `knowledgeGraphForwardLinks(documentId)` / `knowledgeGraphBacklinks(documentId)` | Edges out of / into a note (the real link data). `targetTitle` is denormalised at link time and can be `null` for a target indexed later — resolve via `knowledgeGraphNodeByDocumentId` when you need the title |
| `knowledgeGraphConnections(documentId, depth)` | BFS over outgoing edges |
| `knowledgeGraphEdges` / `knowledgeGraphNodes` | The whole graph in one call each — cheaper than N queries when scanning |
| `knowledgeGraphStats` / `knowledgeGraphDensity` / `knowledgeGraphOrphans` | Per-kind counts (`noteCount`, `mocCount`, `openTensionCount`, …; `nodeCount` is the total), density over knowledge nodes, zero-incoming notes/MoCs/claims |
| `knowledgeGraphTriangles(limit)` / `knowledgeGraphBridges` | Synthesis opportunities / articulation points (bridges is O(V·E) — avoid on large vaults) |
| `knowledgeGraphByAuthor(author)` / `knowledgeGraphByOrigin(origin)` / `knowledgeGraphRecent(limit, since)` | Provenance and recency |
| `knowledgeGraphStale(since, limit)` / `knowledgeGraphHistory(documentId)` / `knowledgeGraphActivity(since)` / `knowledgeGraphActivityByType(operationType)` | Change tracking. Each `OperationRecord` carries `inputJson` (what changed), `signerAddress`, `signerApp`, `signerKey` (did:key) and `signature` — the stored tuple, verifiable by any reader (ECDSA P-256 over `"\x19Signed Operation:\n"+len+timestamp+did+hash+prevStateHash`) |
| `knowledgeGraphMissingEmbeddings` | Should be `[]`; otherwise semantic search is degraded |
| `knowledgeGraphReindex(driveId)` (mutation) | Rebuild the index after a deployment or bulk import |

## Ars Contexta methodology (local reference)

The 249 Ars Contexta research claims are bundled with the plugin in `data/methodology/*.md`. They are **not** stored in the vault — read them from disk with Grep/Read.

Each file has YAML frontmatter: `description`, `kind` (`research|foundation|methodology|principle|example`), `methodology[]`, `source`, `topics[]`, `confidence` (`grounded|established|speculative`), then the claim body with `[[wiki links]]` to other claims.

- During **connect**: search methodology files by topic/keywords and append a "Methodology grounding" section to the note's content — only where the grounding is genuine.
- During **verify**: check each note references at least one methodology claim.
- During **health**: report grounding coverage in `recommendations` (there is no `METHODOLOGY_GROUNDING` category).
- When **explaining a design decision**: read and cite the relevant claim.

## Quality principles

- Each note makes **one atomic claim**; its title is a declarative sentence.
- Every link passes the **articulation test**: "A connects to B because [specific reason]" — and since CLI 1.0.36 that sentence is stored on the edge (`docs link --reason`), where `/health` counts it. A bare knowledge edge is an address-book entry, not knowledge.
- **Progressive disclosure**: title → description → content, each layer adds detail. Descriptions 80–200 characters, aim ~150.
- **Minimum 2 connections** per note, and a `CORE_IDEA` edge from a MoC.
- **Comprehensive extraction**: skip rate < 10% for domain-relevant sources — and report it honestly when it isn't.
- Confidence vocabulary, where used: `grounded` | `established` | `speculative`.
- **Knowledge is retired, not deleted.** When new information disregards a claim: write the new note, `docs link <new> <old> -t SUPERSEDES --reason "…"`, then `ARCHIVE_NOTE` the old one with a comment. Archived notes leave search, topic browsing and semantic neighbours (`includeArchived: true` brings them back for archaeology) but keep their history, backlinks and the `SUPERSEDES` chain — the editor shows "Superseded by →" and chat chips mark them. Duplicates: merge, `SUPERSEDES` from the survivor, archive the duplicate. `docs delete` is for things that were never knowledge — test artefacts, accidental creates — because deletion breaks provenance in three places at once (the source's `extractedClaims`, `DERIVED_FROM` edges, and every chat citation that pointed at it) while saving nothing in an event-sourced store.
