---
name: extract
description: Extract atomic knowledge claims from source material. Creates bai/knowledge-note documents from a bai/source document, preserving the provenance chain.
---

# Extract Atomic Claims

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Extract individual knowledge claims from a source document and create `bai/knowledge-note` documents for each.

## Extraction process

### Step 1: Read the source document

```bash
switchboard docs get <source-doc-id> --state --format json
```

Read the source's `state.global.content` to get the raw text. Also note the title and sourceType for provenance.

### Step 2: Find the notes folder

```bash
switchboard docs tree <drive-slug> --format json
# Find: /knowledge/notes/ folder UUID
```

### Step 3: Identify atomic claims

Read the source content and identify distinct claims. Each claim should:
- Make **exactly one point** (atomic)
- Have a **declarative title** that reads as a complete sentence
- Be **independently understandable** without the source context
- Contain **arguments and evidence** in the body, not just the assertion

**Extraction criteria:**
- Skip rate < 10% (extract most domain-relevant claims)
- No duplicates (check existing notes first via search)
- Skip trivial/obvious statements
- Split compound claims into separate notes

### Step 4: Create note documents

For each claim, create a document and populate it:

```bash
switchboard docs create --type bai/knowledge-note --name "<declarative claim title>" --drive <drive-slug> --parent-folder <notes-folder-uuid> --format json
```

Then populate the note in **two separate batches** (never mix provenance with content — if provenance fails with an invalid enum value, it kills the entire batch):

**Batch 1 — Content (must succeed):**
```bash
switchboard docs apply <new-note-id> --actions '[
  { "type": "SET_TITLE", "input": { "title": "<claim title>", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_DESCRIPTION", "input": { "description": "<~150 char summary>", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_NOTE_TYPE", "input": { "noteType": "<concept|pattern|architecture|decision|...>", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_CONTENT", "input": { "content": "<full markdown body>", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "ADD_TOPIC", "input": { "id": "<unique-id>", "name": "<topic>" }, "scope": "global" }
]'
```

For long content, write the actions to a temp file and use `--file`:
```bash
switchboard docs apply <new-note-id> --file /tmp/note-content.json
```

**Batch 2 — Provenance (separate so failures don't lose content):**
```bash
# Provenance may be a fifth action in the same batch; shown separately only for clarity
switchboard docs mutate <new-note-id> --op setProvenance --input '{"author": "<agent-name>", "sourceOrigin": "DERIVED", "createdAt": "<ISO>"}'
```

**One batch is fine — but read it back.** Verified on the current stack: `docs apply` applies actions in order and isolates failures per action — an invalid `sourceOrigin` is recorded with its error and skipped while title, description, content and topics still land. So `SET_PROVENANCE` can ride in the same batch as the content (one round trip per note). The catch is that the job still reports success: after the apply, `docs get --state` and confirm `title`, `description` (≤ 200), lowercase `noteType`, `topics`, and `provenance.sourceOrigin` are all present. A missing field means that one action was rejected — fix and re-dispatch just that action.

**Lint the actions file before dispatching it — never estimate a length.** `node scripts/lint-actions.mjs /tmp/acts-<id>.json && switchboard docs apply <id> --file /tmp/acts-<id>.json`. It counts the description the way the reducer does (UTF-16 units; an emoji is 2, Python's `len()` undercounts), rejects a `noteType` outside the ten lowercase values, an invalid `sourceOrigin`, and double-encoded newlines — each with the JSON path — so a rejected action never costs a round trip. The description limit (≤ 200) is the **only** hard length limit in any model; titles are unlimited, and so is every field on other document types.

**CRITICAL: the body must hold real line breaks before it is JSON-encoded — encode once, read back.** The bug is *double encoding*: a bash `"\n"` is two characters; a script that JSON-encodes that argument escapes the backslash again; the note is stored with the text `\n` between paragraphs and the write reports success. Write the body in a file or heredoc (or compose it inside Python), serialize once, `docs apply --file`, then `docs get --state` and confirm `content` has real newlines and no `\n`. Switchboard CLI ≥ 1.0.32 refuses such payloads and names the field; do not reach for `--allow-literal-escapes` to get past it.

**CRITICAL: Every note MUST have a description.** Descriptions enable progressive disclosure (title -> description -> content). A note without a description fails health checks and is invisible to scanning workflows. The description should be ~150 chars and add information beyond the title. **Max 200 characters** — longer descriptions silently fail and the entire batch is rejected.

### Step 4b: Populate the structured metadata — in the same batch

A knowledge note is a **typed document**, not a markdown file: it has 18 string fields and 9 list fields that make claims filterable and comparable across the vault, and every write to them is in the operation history. Notes extracted without them are prose with a title. Fill the fields the source **actually supports**; leave the rest empty — an empty field is honest, an invented `severity` is not.

**On every note where the source says so:**

| Field | Put here | Vocabulary |
|---|---|---|
| `scope` | how widely the claim holds | `global` (true of the stack), `team`, `personal` |
| `confidence` | how the claim is known | `grounded` (verified in code or data), `established` (documented, widely agreed), `speculative` (inferred) |
| `version` | the stack/package version the claim was observed on | e.g. `6.2.2-dev.71` — only when the source states it |
| `filePath` | the file or module the claim is about | e.g. `document-models/pipeline-queue/v1/src/reducers/queue-management.ts` |
| `model` | the kind of artifact | `reducer`, `hook`, `component`, `processor`, `subgraph`, `editor`, `cli`, `document-model` |
| `modelId` | the document type, when the claim is about one | e.g. `bai/pipeline-queue` |
| `editor` | who wrote this version of the note | your agent id, e.g. `knowledge-agent` |

**Then by `noteType` — the fields that carry that type's signal:**

| noteType | Populate |
|---|---|
| `bug-pattern` | `severity` (`critical` / `warning` / `info`), `errorMessage` (the exact error class or text), `rootCause`, `correctPattern` |
| `decision` | `decisionStatus` (`proposed` / `accepted` / `rejected` / `superseded`), `context` (what forced the decision), `alternatives[]`, `consequences[]` |
| `architecture` | `models[]` (document types involved), `modules[]`, `computes` (what the design derives), `inputs[]`, `outputs[]`, `consumedBy[]`, `dispatchTargets[]` |
| `integration` | `sourceType`, `targetType` (e.g. `API` → `component`), `relationType` (`depends-on`, `extends`, `emits`), `cardinality` (`one-to-many`…), `inputs[]`, `outputs[]` |
| `pattern` | `correctPattern`, `context` (when it applies), `hooksUsed[]`, `alternatives[]` |
| `procedure` | `context`, `inputs[]` (prerequisites), `outputs[]` (results), `filePath`, `version` |
| `workflow` | `inputs[]`, `outputs[]`, `consumedBy[]`, `dispatchTargets[]` |
| `reference` | `modelId`, `version`, `filePath`, `model` |
| `concept` | `scope`, `confidence` — the rest is prose |
| `observation` | `confidence`, `severity`, `context` |

Strings go through `SET_METADATA_FIELD { field, value, updatedAt }`; lists **only** through `SET_METADATA_LIST_FIELD { field, values[], updatedAt }` (the scalar op rejects a list field name). Both ride in the same `docs apply` batch as the content — no extra round trip — and both field names are whitelisted by the reducer, so a typo is rejected silently; `lint-actions.mjs` checks them. Example, for a `bug-pattern`:

```json
[
  { "type": "SET_METADATA_FIELD", "input": { "field": "severity", "value": "critical", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "errorMessage", "value": "completedCount incremented twice; no operation decrements it", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "rootCause", "value": "completeTaskOperation repeats the bookkeeping the final advancePhaseOperation already did", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "correctPattern", "value": "Advance through every phase and stop; use COMPLETE_TASK only to end a task early", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "filePath", "value": "document-models/pipeline-queue/v1/src/reducers/queue-management.ts", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "model", "value": "reducer", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "modelId", "value": "bai/pipeline-queue", "updatedAt": "<ISO>" }, "scope": "global" },
  { "type": "SET_METADATA_FIELD", "input": { "field": "confidence", "value": "grounded", "updatedAt": "<ISO>" }, "scope": "global" }
]
```

Read back afterwards: the editor's Metadata panel shows a count — `Metadata (8)` — and a note whose panel reads `Metadata (0)` after extraction from a code or documentation source is under-extracted.

### Step 5: Verify drive nodes

After creating all notes, verify they all appear as file nodes in the drive:

```bash
switchboard docs tree <drive-slug> --format json
# Check: each created note ID exists as a file node
# If missing: re-create the containment by re-running the namespaced create, or use
# `switchboard docs mutate <drive-id> --op addFile` ONLY as a last resort (CLI stamps the
# envelope; note containment edges since the drive-override migration live in
# DocumentRelationship — verify with docs tree afterward). CLI-stamped ADD_FILE is sync-safe;
# the caveat is containment completeness, not action safety.
```

### Step 6: Close out the source document — MANDATORY

**Extraction is not finished until the source says so.** A source left in
`EXTRACTING` shows as unprocessed in the app's Sources tab forever, even
though its notes exist — the notes carry no signal back to the document
they came from. Every extraction run MUST end with all three writes below,
and a read-back that confirms them.

Provenance lives in **two** places and both are required:
- `extractedClaims[]` on the source (document state — what the app renders)
- a `DERIVED_FROM` relationship per note (graph edges — what the subgraph
  traverses): `addRelationship(<note-id>, <source-id>, "DERIVED_FROM")`

Track what was extracted:
```bash
switchboard docs apply <source-doc-id> --actions '[
  { "type": "SET_SOURCE_STATUS", "input": { "status": "EXTRACTED" }, "scope": "global" },
  { "type": "ADD_EXTRACTED_CLAIM", "input": { "claimRef": "<note-id-1>" }, "scope": "global" },
  { "type": "ADD_EXTRACTED_CLAIM", "input": { "claimRef": "<note-id-2>" }, "scope": "global" },
  { "type": "RECORD_EXTRACTION_STATS", "input": {
    "claimCount": 5, "skippedCount": 0, "skipRate": 0.0,
    "extractedAt": "<ISO>", "extractedBy": "knowledge-agent"
  }, "scope": "global" }
]'
```

**Verify before moving on** — `SET_SOURCE_STATUS` accepts only INBOX,
EXTRACTING, EXTRACTED, ARCHIVED, and an invalid value fails silently:

```bash
switchboard docs get <source-doc-id> --state --format json | python3 -c "
import json,sys; g=json.load(sys.stdin)['state']['global']
print('status:', g.get('status'), '| claims:', len(g.get('extractedClaims') or []), '| stats:', bool(g.get('extractionStats')))"
# expect: status: EXTRACTED | claims: <N> | stats: True
```

Report `skipRate` honestly. A thin vendor blog legitimately scores high;
massaging the number to clear the <10% target hides the real signal, which
is that the source was low-yield.

### Step 7: Record pipeline handoff

If this extraction is part of a pipeline task, advance the phase. **This can share a batch with other queue ops (`docs apply` preserves order and isolates failures) — read the task back to confirm the phase advanced:**
```bash
switchboard docs mutate <pipeline-queue-id> --op advancePhase --input '{
  "taskId": "<task-id>",
  "handoff": {
    "id": "<unique-id>",
    "phase": "create",
    "workDone": "Extracted N claims: <brief list>. X% skip rate.",
    "filesModified": ["<note-id-1>", "<note-id-2>"],
    "completedAt": "<ISO>",
    "completedBy": "knowledge-agent"
  },
  "updatedAt": "<ISO>"
}'
```

### After extraction: the notes are not done

Extraction produces DRAFT notes with provenance and a `DERIVED_FROM` edge. They still need the reflect and reweave phases — typed links, and a place in the MoC hierarchy (`CORE_IDEA` from a TOPIC or DOMAIN MoC, itself a `CHILD_MOC` of the HUB) — before they are explorable and pass health. Run `/powerhouse-knowledge:pipeline` to carry them through, or `/connect` then `/synthesize` by hand. Once several topic MoCs exist, `synthesize` groups them under DOMAIN MoCs and a single HUB so clusters can be walked from the top.

## Note types

Choose the most specific type for each claim:
- **concept** — a theoretical idea or principle
- **pattern** — a recurring solution or approach
- **architecture** — system design decision or structure
- **decision** — a choice made with rationale
- **observation** — an empirical finding
- **procedure** — a how-to or workflow step
- **reference** — factual information for lookup
- **bug-pattern** — a recurring failure and its cause
- **integration** — how two systems or components connect
- **workflow** — an end-to-end process across steps or roles

These ten lowercase values are the canonical set (the note editor's type select). `noteType` is a free string in the schema, so `CONCEPT` is accepted on write but never matches the editor or the health dashboard's filters — always write lowercase.

## Quality gates

- [ ] Each note makes exactly ONE point
- [ ] Titles are declarative sentences (not questions or fragments)
- [ ] Descriptions add information beyond the title (~150 chars)
- [ ] Content includes arguments/evidence, not just assertions
- [ ] All notes have at least one topic tag
- [ ] Metadata populated for what the source supports — at least `confidence`, plus the type-specific fields (a code-derived `bug-pattern` with `Metadata (0)` is under-extracted)
- [ ] `noteType` is one of the ten lowercase values (never `CONCEPT`)
- [ ] Content read back contains real line breaks (no literal `\n`) — the classic shell-interpolation bug
- [ ] Description ≤ 200 UTF-16 units — checked by `lint-actions.mjs`, not by eye (an over-long one is rejected and the note is left with no description while the batch reports success)
- [ ] One `DERIVED_FROM` edge per note (`addRelationship(<note>, <source>, "DERIVED_FROM")`) — this is how `/health` finds a note's source; the source's `extractedClaims` alone is not traversable from the note
- [ ] Provenance traces back to the source (sourceOrigin: DERIVED)
- [ ] Skip rate < 10% for domain-relevant content
- [ ] **All created notes verified in drive tree** — read the drive after creation and confirm each note exists as a file node
- [ ] **Every field read back after the batch** — title, description, noteType, topics, provenance; a rejected action leaves its field untouched while the job reports success
- [ ] Source closed out: `ADD_EXTRACTED_CLAIM` per note, `RECORD_EXTRACTION_STATS`, status `EXTRACTED`
- [ ] Handoff recorded with `ADVANCE_PHASE` (phase `create`); connecting, MoC attachment and the walk to `CANONICAL` happen in the reflect/reweave/verify phases — see AGENT.md § Definition of done for the full per-note list

If "$ARGUMENTS" is provided, treat it as the source document ID to extract from.
