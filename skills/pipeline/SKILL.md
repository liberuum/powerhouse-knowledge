---
name: pipeline
description: Run the knowledge processing pipeline on a source or batch of notes. Chains extract -> connect -> reweave -> verify phases with handoff tracking. Use when processing source material end-to-end or advancing notes through the pipeline.
---

# Processing Pipeline

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Carry a source through to connected, verified notes in the MoC hierarchy. The six R names (Record, Reduce, Reflect, Reweave, Verify, Rethink) are the vocabulary; the pipeline-queue task underneath has **four phases**, and this skill drives them:

## Pipeline Phases

```
Source -> CREATE (extract claims) -> REFLECT (connect) -> REWEAVE (MoC membership + hierarchy, update old notes) -> VERIFY (quality gate + auto-repair)
```

Record (`/seed`) happens before the task exists; Rethink (`/health`, `/graph`) after it completes.

Each phase is tracked in the `bai/pipeline-queue` singleton document.

## CRITICAL: Pipeline tracking is MANDATORY

**Every pipeline run MUST update the `bai/pipeline-queue` document.** After completing each phase (create, reflect, reweave, verify), immediately record the handoff via ASSIGN_TASK + ADVANCE_PHASE. The task must reach DONE status by the end of the pipeline. Never skip pipeline tracking — the app's Pipeline view reads from this document.

Pipeline operations (ADD_TASK, ASSIGN_TASK, ADVANCE_PHASE, COMPLETE_TASK, FAIL_TASK) are **dependent** — each requires the previous one to have created state. **Batch them.** `docs apply` applies actions in order and isolates failures per action (verified on CLI 1.0.32): `[ADD_TASK, ASSIGN_TASK, ADVANCE_PHASE]` in one call works, and so does a batch of chained advances. The cost moves to the read-back: after each batch, `docs get` the queue and confirm the task's `status`, `currentPhase` and `handoffs.length` — a rejected action (wrong `taskId`, unknown `taskType`) is skipped while the job reports success.

The CLI auto-injects `timestampUtcMs` and `action.id` on all actions — no need to generate them manually.

## Pre-flight: Verify methodology files are available locally

The 249 Ars Contexta research claims are bundled with the plugin in `data/methodology/*.md`. They are **not** stored in the remote vault — the agent reads them directly from disk during the cross-reference step.

Before running the pipeline, confirm the files exist:
```bash
ls data/methodology/*.md | wc -l
# Should be 249
```

If the `data/methodology/` directory is missing (e.g., marketplace install without data), clone it from GitHub:
```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/liberuum/powerhouse-knowledge.git /tmp/pk-methodology
cd /tmp/pk-methodology && git sparse-checkout set data/methodology
cp -r /tmp/pk-methodology/data/methodology/ <plugin-dir>/data/methodology/
```

## Full Pipeline Run

### Step 1: Find pending tasks

```bash
switchboard docs tree <drive-slug> --format json
# Find the bai/pipeline-queue document (singleton in /ops/queue/)

switchboard docs get <pipeline-queue-id> --state --format json
# Check state.global.tasks for PENDING or IN_PROGRESS tasks
```

If there are PENDING tasks with a `documentRef`, process them. The source document always has the latest content regardless of how many edits the user made.

### ⚠️ Never reuse a task id — the model cannot recover from it

`ADD_TASK` appends to `state.tasks` with **no duplicate-id guard**, but
every other queue operation resolves its target with
`state.tasks.find(t => t.id === taskId)`, which always returns the
**first** match. Dispatching `ADD_TASK` twice with the same id therefore
creates a permanently unreachable ghost task: it can never be assigned,
advanced, completed, failed or unblocked, and it inflates `activeCount`
for the life of the document. There is no `REMOVE_TASK` operation, so
the only way to clear one is to recreate the queue document.

**Generate a fresh UUID for every `ADD_TASK`.** Never reuse an id across
retries — if a dispatch times out, read the queue back and check whether
the task landed before re-sending. A 502 whose commit arrives after the
client gives up looks exactly like a failure.

```bash
# Read back before retrying, and before adding work for a document
switchboard docs get <pipeline-queue-id> --state --format json \
  | python3 -c "import json,sys; g=json.load(sys.stdin)['state']['global']; \
      print([(t['id'], t['status'], t.get('documentRef')) for t in g['tasks']])"
```

Also don't create a second task for the same `documentRef` — check the
existing task list first.

### Step 2: Phase 1 — CREATE (Extract)

Use `/powerhouse-knowledge:extract` on the source document:
- Read the source content
- Extract atomic claims as `bai/knowledge-note` documents
- **Verify all notes appear in the drive tree** after creation
- **Close out the source (mandatory, verify by read-back):** `ADD_EXTRACTED_CLAIM`
  per note, `RECORD_EXTRACTION_STATS`, then `SET_SOURCE_STATUS` to `EXTRACTED`,
  plus a `switchboard docs link <note> <source> -t DERIVED_FROM --reason "<where in the source>" --confidence grounded` edge per note.
  A source left in `EXTRACTING` reads as unprocessed in the app forever —
  this is the single most-missed step when driving the pipeline by script
  instead of by skill.
- **Split actions into two batches**: content first (title, description, noteType, content, topics), provenance second — so a provenance validation error doesn't kill content

Record handoff with sequential `docs mutate` calls:
```bash
switchboard docs mutate <pipeline-queue-id> --op assignTask --input '{
  "taskId": "<task-id>",
  "assignedTo": "knowledge-agent",
  "updatedAt": "<ISO>"
}'

switchboard docs mutate <pipeline-queue-id> --op advancePhase --input '{
  "taskId": "<task-id>",
  "handoff": {
    "id": "<uid>",
    "phase": "create",
    "workDone": "Extracted N claims. 0% skip rate.",
    "filesModified": ["<note-ids>"],
    "completedAt": "<ISO>",
    "completedBy": "knowledge-agent"
  },
  "updatedAt": "<ISO>"
}'
```

### Step 3: Phase 2 — REFLECT (Connect + Synthesize)

Use `/powerhouse-knowledge:connect` on each extracted note:
- Find related notes (both new and existing) via search and graph queries
- Apply the articulation test: the WHY of each link goes on the edge as `--reason` (the hook blocks a bare knowledge edge); add `--confidence` where you can say
- Create typed links (RELATES_TO, BUILDS_ON, CONTRADICTS, SUPERSEDES, DERIVED_FROM) with `docs link … --reason "…"`; articulate pre-existing bare edges on the note with `docs annotate`
- Target: >= 2 links per note, no orphans

Then **cross-reference with local methodology files** in the plugin's `data/methodology/`:
- For each extracted note, search the 249 research claim files by topic and keywords (using Grep on `data/methodology/*.md`)
- Append a "Methodology grounding" section to the note's content referencing matching claims
- Use BUILDS_ON when a note implements or validates a research claim, CONTRADICTS when it challenges one
- This grounds working knowledge in the theoretical foundation without requiring remote import

**MANDATORY: Create MOCs via `/powerhouse-knowledge:synthesize`:**
- Group notes by shared topics (aggregate `topics[]` from all note states)
- Create `bai/moc` documents in `/knowledge/` for any topic with 3+ notes that doesn't already have a MOC
- Add core ideas with `switchboard docs link <moc> <note> -t CORE_IDEA`; the edge carries no context phrase any more — put WHY the note matters to the topic in the note's own body
- Set tier: TOPIC for a focused cluster (3–9 notes), DOMAIN for a broad area (10+ notes or 2+ topic MoCs), HUB for the vault's single entry point
- **Place every new MoC in the tree:** `switchboard docs link <parent-moc> <new-moc> -t CHILD_MOC` from its DOMAIN, or from the HUB. If the vault has 3+ MoCs and no HUB yet, create the HUB and attach every parentless MoC to it. A MoC unreachable from the HUB is a defect — the synthesize skill has the full rules and thresholds
- **Verify each MOC appears in the drive tree after creation** — don't skip this
- This is NOT optional — the health check will flag missing MOCs as WARN

Then **detect tensions** — look for contradictions between notes:
- Check if any CONTRADICTS links were created during connection
- Compare claims that address the same topic but reach different conclusions
- For each genuine contradiction, create a `bai/tension` document:

```bash
switchboard docs create --type bai/tension --name "<what contradicts what>" --drive <drive-slug> --parent-folder <ops-folder-uuid> --format json
```

```bash
switchboard docs apply <tension-id> --actions '[{
  "type": "CREATE_TENSION",
  "input": {
    "title": "<what contradicts what>",
    "description": "<brief summary of the conflict>",
    "content": "<full analysis: Side A says X because..., Side B says Y because..., this matters because...>",
    "involvedRefs": ["<note-id-1>", "<note-id-2>"],
    "observedAt": "<ISO>",
    "observedBy": "knowledge-agent"
  },
  "scope": "global"
}]'
```

Also add the tension to the relevant MOC if one exists:
```bash
switchboard docs mutate <moc-id> --op addTension --input '{
  "id": "<unique-id>",
  "description": "<tension summary>",
  "involvedRefs": ["<note-id-1>", "<note-id-2>"],
  "addedAt": "<ISO>"
}'
```

**Three outcomes for tensions:**
- **OPEN** — genuine unresolved contradiction, needs human judgment
- **RESOLVED** — one side is correct, the other should be updated or archived
- **DISSOLVED** — apparent contradiction only, both sides are compatible at different levels

Record handoff with sequential `docs mutate` calls for `ADVANCE_PHASE`.

### Step 4: Phase 3 — REWEAVE (Update older notes)

Check if existing notes need updating given the new claims:
- Search for notes that reference similar topics
- If a new claim supersedes, contradicts, or extends an old one, add links
- Update old note content if needed (add "See also" references)

Record handoff with sequential `docs mutate` calls for `ADVANCE_PHASE`.

### Step 5: Phase 4 — VERIFY (Quality gate + auto-repair)

Use `/powerhouse-knowledge:verify` on all notes from this pipeline run:
- Run recite test on each note
- **Auto-repair missing descriptions** (generate from title + content)
- **Auto-repair missing provenance** (set sourceOrigin: DERIVED)
- **Auto-repair missing note types** (infer from content)
- **Auto-repair missing topics** (identify from content)
- Check link density (>= 2 per note)
- Report remaining issues that need human judgment

Record final handoff — task auto-completes on the last phase.

### Step 6: HEALTH CHECK + AUTO-FIX (automatic after verify)

After the pipeline task completes, **automatically run /health and act on recommendations:**

1. **Run health check** — gather metrics from subgraph, check all notes
2. **Write report** to `bai/health-report` document
3. **Auto-fix actionable recommendations:**

| Recommendation | Auto-fix action |
|---|---|
| "Create MOC for X topic (N notes)" | Run `/synthesize` — create `bai/moc` with core ideas |
| "N notes missing descriptions" | Generate descriptions from title + content, dispatch SET_DESCRIPTION |
| "N notes not grounded in methodology" | Search local methodology files, add grounding references to note content |
| "N notes missing types" | Infer from content, dispatch SET_NOTE_TYPE |
| "Stranded PENDING pipeline task → if its work is actually done, `ADVANCE_PHASE` it through the remaining phases (the final advance auto-completes it); use `COMPLETE_TASK` only to end a task early — never after a final advance, which would double-count `completedCount`

4. **Re-run health** after fixes to confirm improvement
5. **Report final status:**

```
=== POST-PIPELINE HEALTH ===
Before: WARN (3 issues)
Fixed: Created MOC, added 2 methodology grounding references
After: PASS (0 issues)
```

**Only escalate to human:** Recite test failures (description doesn't predict content), genuine tensions between notes, methodology conflicts.

### Step 7: Handle failures

```bash
switchboard docs mutate <pipeline-queue-id> --op failTask --input '{"taskId": "<task-id>", "reason": "<what went wrong>", "updatedAt": "<ISO>"}'

switchboard docs mutate <pipeline-queue-id> --op blockTask --input '{"taskId": "<task-id>", "reason": "<needs human input>", "updatedAt": "<ISO>"}'

switchboard docs mutate <pipeline-queue-id> --op unblockTask --input '{"taskId": "<task-id>", "updatedAt": "<ISO>"}'
```

## Subgraph Queries

Use the subgraph for graph analysis during pipeline phases:

```bash
# Graph stats
switchboard query '{ knowledgeGraphStats(driveId: "<UUID>") { nodeCount edgeCount orphanCount } }'

# Search for related notes
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<keyword>", limit: 20) { documentId title noteType } }'

# Find orphans
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { documentId title } }'

# Density
switchboard query '{ knowledgeGraphDensity(driveId: "<UUID>") }'
```

## Quick Pipeline (Single Note)

For processing a single note (not from a source):

```
1. Run /powerhouse-knowledge:connect on the note (reflect phase)
2. Run /powerhouse-knowledge:verify on the note (auto-repairs + quality gate)
3. If all pass: note is ready for IN_REVIEW status
```

## Batch Pipeline

For processing multiple sources:

```
1. Check pipeline queue for all PENDING tasks
2. Process each task through all 4 phases
3. After each source: verify drive nodes, repair if needed
4. Report: N sources processed, N claims extracted, N links created, N issues auto-repaired
```

## Quality summary after pipeline

After completing all phases, report:
```
=== PIPELINE COMPLETE ===
Source: "<title>"
Claims extracted: N (skip rate: X%)
Links created: N (N BUILDS_ON, N RELATES_TO) | Methodology references: N
Auto-repaired: N issues (descriptions, provenance, types)
Health: N PASS, N WARN, N FAIL
Drive verified: all N notes have file nodes
```

If "$ARGUMENTS" is provided, treat it as the source or note to process.
