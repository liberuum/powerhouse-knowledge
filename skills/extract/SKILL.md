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
switchboard docs mutate <new-note-id> --op setProvenance --input '{"author": "<agent-name>", "sourceOrigin": "DERIVED", "createdAt": "<ISO>"}'
```

**CRITICAL: Why two batches?** If ANY action in a batch fails validation, ALL actions in that batch are rejected. Provenance has a strict enum (`DERIVED`, `IMPORT`, `MANUAL`, `SESSION_MINE`) — a typo kills the entire batch including title, description, and content. By separating them, content is always saved even if provenance fails.

**CRITICAL: Every note MUST have a description.** Descriptions enable progressive disclosure (title -> description -> content). A note without a description fails health checks and is invisible to scanning workflows. The description should be ~150 chars and add information beyond the title. **Max 200 characters** — longer descriptions silently fail and the entire batch is rejected.

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

If this extraction is part of a pipeline task, advance the phase. **Use `docs mutate` for dependent pipeline operations — never batch with `docs apply`:**
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
- [ ] `noteType` is one of the ten lowercase values (never `CONCEPT`)
- [ ] Description ≤ 200 characters (longer fails silently and rejects the whole batch)
- [ ] One `DERIVED_FROM` edge per note (`addRelationship(<note>, <source>, "DERIVED_FROM")`) — this is how `/health` finds a note's source; the source's `extractedClaims` alone is not traversable from the note
- [ ] Provenance traces back to the source (sourceOrigin: DERIVED)
- [ ] Skip rate < 10% for domain-relevant content
- [ ] **All created notes verified in drive tree** — read the drive after creation and confirm each note exists as a file node
- [ ] **Content and provenance in separate batches** — never batch SET_PROVENANCE with content actions
- [ ] Source closed out: `ADD_EXTRACTED_CLAIM` per note, `RECORD_EXTRACTION_STATS`, status `EXTRACTED`
- [ ] Handoff recorded with `ADVANCE_PHASE` (phase `create`); connecting, MoC attachment and the walk to `CANONICAL` happen in the reflect/reweave/verify phases — see AGENT.md § Definition of done for the full per-note list

If "$ARGUMENTS" is provided, treat it as the source document ID to extract from.
