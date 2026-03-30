---
name: pipeline
description: Run the knowledge processing pipeline on a source or batch of notes. Chains extract -> connect -> reweave -> verify phases with handoff tracking. Use when processing source material end-to-end or advancing notes through the pipeline.
---

# Processing Pipeline

Run the 6R processing pipeline on source material or individual notes.

## Pipeline Phases

```
Source -> CREATE (extract claims) -> REFLECT (connect) -> REWEAVE (update old notes) -> VERIFY (quality gate + auto-repair)
```

Each phase is tracked in the `bai/pipeline-queue` singleton document.

## CRITICAL: Pipeline tracking operations

Pipeline operations (ADD_TASK, ASSIGN_TASK, ADVANCE_PHASE, COMPLETE_TASK, FAIL_TASK) are **dependent** — each requires the previous one to have created state. **Always use sequential `switchboard docs mutate` calls, never `docs apply`** (which reverses operation order for dependent actions).

The CLI auto-injects `timestampUtcMs` and `action.id` on all actions — no need to generate them manually.

## Pre-flight: Ensure methodology is imported

Before running the pipeline, check if research claims exist in `/research/`:

```bash
switchboard docs tree <drive-slug> --format json
# Count files where documentType === "bai/research-claim"
```

If count < 200 (methodology not imported), run `/powerhouse-knowledge:setup` first. The pipeline's methodology cross-referencing step requires the 249 research claims to be present.

For CLI: `python3 scripts/import-methodology.py <drive-slug>`

## Full Pipeline Run

### Step 1: Find pending tasks

```bash
switchboard docs tree <drive-slug> --format json
# Find the bai/pipeline-queue document (singleton in /ops/queue/)

switchboard docs get <pipeline-queue-id> --state --format json
# Check state.global.tasks for PENDING or IN_PROGRESS tasks
```

If there are PENDING tasks with a `documentRef`, process them. The source document always has the latest content regardless of how many edits the user made.

**Important:** Don't create duplicate tasks. Check if a task already exists for the same `documentRef` before creating a new one.

### Step 2: Phase 1 — CREATE (Extract)

Use `/powerhouse-knowledge:extract` on the source document:
- Read the source content
- Extract atomic claims as `bai/knowledge-note` documents
- **Verify all notes appear in the drive tree** after creation
- Update the source: SET_SOURCE_STATUS to EXTRACTED, ADD_EXTRACTED_CLAIM for each note, RECORD_EXTRACTION_STATS
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
- Apply articulation test: explain WHY each link exists
- Create typed links (RELATES_TO, BUILDS_ON, CONTRADICTS, SUPERSEDES, DERIVED_FROM)
- Target: >= 2 links per note, no orphans

Then **cross-reference with methodology claims** in `/research/`:
- For each extracted note, search the 249 research claims by topic and keywords
- Create BUILDS_ON links when a note implements or validates a methodology claim
- Create CONTRADICTS links when a note challenges a claim
- This grounds working knowledge in the theoretical foundation

Then use `/powerhouse-knowledge:synthesize` to create MOCs:
- Group notes by shared topics
- Create `bai/moc` documents in `/knowledge/` for any topic with 3+ notes that doesn't already have a MOC
- Add core ideas with articulated context phrases
- Set tier (HUB for 20+ notes, DOMAIN for 10+, TOPIC for 3+)

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
| "N notes not grounded in methodology" | Search research claims, add BUILDS_ON links |
| "N notes missing types" | Infer from content, dispatch SET_NOTE_TYPE |
| "Broken PENDING pipeline task" | Dispatch COMPLETE_TASK to clean up |

4. **Re-run health** after fixes to confirm improvement
5. **Report final status:**

```
=== POST-PIPELINE HEALTH ===
Before: WARN (3 issues)
Fixed: Created MOC, added 2 methodology links
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
Links created: N (N BUILDS_ON, N RELATES_TO, N cross-references to research claims)
Auto-repaired: N issues (descriptions, provenance, types)
Health: N PASS, N WARN, N FAIL
Drive verified: all N notes have file nodes
```

If "$ARGUMENTS" is provided, treat it as the source or note to process.
