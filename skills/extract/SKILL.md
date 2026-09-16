---
name: extract
description: Extract atomic knowledge claims from source material. Creates bai/knowledge-note documents from a bai/source document, preserving the provenance chain.
---

# Extract Atomic Claims

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Extract individual knowledge claims from a source document and create `bai/knowledge-note` documents for each.

## Writing many notes at once

Create the notes and their content in one call, up to 25 at a time:

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/notes" -d '{
  "drive": "<drive-uuid>",
  "notes": [
    {"name": "note-slug", "actions": [
      {"type":"SET_TITLE","input":{"title":"<claim as a sentence>","updatedAt":"<ISO>"}},
      {"type":"SET_DESCRIPTION","input":{"description":"<= 200 chars","updatedAt":"<ISO>"}},
      {"type":"SET_NOTE_TYPE","input":{"noteType":"concept","updatedAt":"<ISO>"}},
      {"type":"SET_CONTENT","input":{"content":"<body>","updatedAt":"<ISO>"}},
      {"type":"ADD_TOPIC","input":{"id":"<uuid>","name":"<topic>"}}
    ]}
  ]
}'
```

Notes go to `/knowledge/notes` automatically; `parentFolder` is rejected. Every
action is linted before anything is created, so a `400` means no note was made.
Check each note's `readBack` in the response.

Then link each note to its source:

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/relationships" \
  -d '{"source":"<note>","target":"<source>","type":"DERIVED_FROM","reason":"<where in the source>","confidence":"grounded"}'
```

### Generating a large batch


Extracting a batch by hand-editing JS template literals fails on backtick and
`${` escaping, repeatedly. Generate the batch instead: a small script that
builds a list of note objects and emits `export const notes = <json>` plus a
`perFile` record of `{ path, claims, skipped, note }`. Two properties earn
their keep — content is JSON-escaped so no character needs thought, and a
`assert len(description) <= 200` in the note constructor fails at generation
time instead of leaving a note with no description in the vault.

Then publish with one driver that, per note, creates or updates by key, writes
content and provenance in separate dispatches, walks the lifecycle to
CANONICAL, links every edge with its reason, and finally records the real
per-file claim and skip counts on each source. Keep a key → document-id map on
disk so a re-run updates in place rather than duplicating.

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

Then populate the note. One batch is fine: actions run in order and a rejected action is skipped while the rest land.

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

**One batch, then ask the job what happened.** `docs apply` runs actions in
order and isolates failures per action: a rejected one is recorded with its
error and skipped while the rest land. So `SET_PROVENANCE` rides in the same
batch as the content — one round trip per note.

The job now tells you which actions applied. `docs apply` prints a `jobId`;
ask it (stack ≥ 6.2.3-dev.10):

```bash
switchboard query '{ jobStatus(jobId: "<id>") { status result } }'
# result.allApplied is false when any action was rejected, and
# result.actions names each one: {"kind":"reducer-error","message":"Description exceeds 200 characters"}
```

That replaces re-reading the whole document to infer what went wrong — it
names the action and quotes the reducer. On an older stack, or to confirm the
final shape anyway, `docs get --state` and check `title`, `description`,
lowercase `noteType`, `topics` and `provenance.sourceOrigin`.

**Lint the actions file before dispatching it — never estimate a length.** `node scripts/lint-actions.mjs /tmp/acts-<id>.json && switchboard docs apply <id> --file /tmp/acts-<id>.json`. It counts the description the way the reducer does (UTF-16 units; an emoji is 2, Python's `len()` undercounts), rejects a `noteType` outside the ten lowercase values, an invalid `sourceOrigin`, and double-encoded newlines — each with the JSON path — so a rejected action never costs a round trip. The description limit (≤ 200) is the **only** hard length limit in any model; titles are unlimited, and so is every field on other document types.

**CRITICAL: the body must hold real line breaks before it is JSON-encoded — encode once, read back.** The bug is *double encoding*: a bash `"\n"` is two characters; a script that JSON-encodes that argument escapes the backslash again; the note is stored with the text `\n` between paragraphs and the write reports success. Write the body in a file or heredoc (or compose it inside Python), serialize once, `docs apply --file`, then `docs get --state` and confirm `content` has real newlines and no `\n`. Switchboard CLI ≥ 1.0.32 refuses such payloads and names the field; do not reach for `--allow-literal-escapes` to get past it.

**Every note MUST have a description.** It carries the middle layer of
progressive disclosure (title → description → content); a note without one
fails health checks and is invisible to scanning workflows. Aim for ~150
characters and say something the title does not. A rejected `SET_DESCRIPTION`
costs only itself — the note is created with every other field set and no
description — which is why the limit is linted before dispatch, above.

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
  traverses), with the place in the source the claim comes from as its
  reason — that is the articulation of a derivation, and it is what lets a
  reader (or `/verify`) check the claim against the source:

  ```bash
  switchboard docs link <note-id> <source-id> -t DERIVED_FROM \
    --reason "§ 'Storage', para 3: the author states the cache is invalidated per read model" \
    --confidence grounded
  ```

  `grounded` is the right confidence for a faithful extraction; use
  `speculative` when the note is your inference from the source rather than
  a claim the source makes.

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
- [ ] Description ≤ 200 UTF-16 units — assert it **where the note is written**, not after dispatch; em dashes and arrows push one over the line invisibly, and Python's `len()` undercounts what the reducer counts. `lint-actions.mjs` checks it
- [ ] One `DERIVED_FROM` edge per note (`switchboard docs link <note> <source> -t DERIVED_FROM --reason "<where in the source>" --confidence grounded`) — this is how `/health` finds a note's source; the source's `extractedClaims` alone is not traversable from the note, and the reason is how anyone checks the claim against it
- [ ] Provenance traces back to the source (sourceOrigin: DERIVED)
- [ ] Skip rate < 10% for domain-relevant content — and a **high** rate is the finding on a source that is mostly not claims. Report it with the reasoning per file (`claims`, `skipped`, and one line of why), because a fabricated zero hides what the source actually was. A 57% rate across a corpus of tutorials, cloud-vendor walkthroughs and a chronological changelog is honest; the same number on a reference page means the reading was shallow
- [ ] **Zero yield is a real outcome, and it is not INBOX.** A source read end to end that honestly yields nothing (a glossary, a click-by-click tutorial, an index stub) gets `RECORD_EXTRACTION_STATS` with `claimCount: 0` and the reasoning, then status `EXTRACTED`. Leaving it INBOX claims it was never processed
- [ ] **Check the code before asserting what a document says.** Where a doc and the tree disagree, the disagreement is the most valuable note on that source — name which is authoritative and how you checked (`git grep` at the tag). Five such divergences came out of one repository pass; each is worth an upstream fix
- [ ] **All created notes verified in drive tree** — read the drive after creation and confirm each note exists as a file node
- [ ] **`result.allApplied` checked after the batch** — `jobStatus(jobId:)` names any rejected action and quotes the reducer; a rejected action leaves its field untouched while the other actions land
- [ ] Source closed out: `ADD_EXTRACTED_CLAIM` per note, `RECORD_EXTRACTION_STATS`, status `EXTRACTED`
- [ ] **Re-running a close-out must not grow `extractedClaims`.** `ADD_EXTRACTED_CLAIM` is idempotent on `claimRef` from `@powerhousedao/knowledge-note` 1.0.54-dev.6 onward. On anything older it appends blindly and the source overstates its own yield, so check the deployed version before a re-sync; repair a duplicated list with `REMOVE_EXTRACTED_CLAIM` then one `ADD_EXTRACTED_CLAIM`.
- [ ] Handoff recorded with `ADVANCE_PHASE` (phase `create`); connecting, MoC attachment and the walk to `CANONICAL` happen in the reflect/reweave/verify phases — see AGENT.md § Definition of done for the full per-note list

If "$ARGUMENTS" is provided, treat it as the source document ID to extract from.
