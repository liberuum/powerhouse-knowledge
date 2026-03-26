---
name: pipeline
description: Run the knowledge processing pipeline on a source or batch of notes. Chains extract → connect → reweave → verify phases with handoff tracking. Use when processing source material end-to-end or advancing notes through the pipeline.
---

# Processing Pipeline

Run the 6R processing pipeline (Record → Reduce → Reflect → Reweave → Verify → Rethink) on source material or individual notes.

## Pipeline Phases

```
Source → EXTRACT claims → CONNECT to graph → REWEAVE old notes → VERIFY quality
```

Each phase is tracked in the `bai/pipeline-queue` singleton document.

## Full Pipeline Run

### Step 1: Find the pipeline queue
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-id>" })
// Find the bai/pipeline-queue document (singleton in /ops/queue/)
```

### Step 2: Add a task to the queue
```
mcp__reactor-mcp__addActions({
  documentId: "<pipeline-queue-id>",
  actions: [{
    type: "ADD_TASK",
    input: {
      id: "<generate-unique-id>",
      taskType: "claim",
      target: "<source-title or note-title>",
      documentRef: "<source-or-note-document-id>",
      createdAt: "<ISO-timestamp>"
    },
    scope: "global"
  }]
})
```

### Step 3: Process each phase

For each phase (create/reflect/reweave/verify):

1. **Do the work** — extract claims, find connections, update older notes, run quality checks
2. **Record the handoff**:
```
mcp__reactor-mcp__addActions({
  documentId: "<pipeline-queue-id>",
  actions: [{
    type: "ADVANCE_PHASE",
    input: {
      taskId: "<task-id>",
      updatedAt: "<ISO-timestamp>",
      handoff: {
        id: "<generate-unique-id>",
        phase: "create",
        workDone: "Extracted 5 claims from source",
        filesModified: ["<note-id-1>", "<note-id-2>"],
        completedAt: "<ISO-timestamp>"
      }
    },
    scope: "global"
  }]
})
```

The reducer automatically advances to the next phase. On the final phase (verify), the task is auto-completed.

### Step 4: Handle failures
```
FAIL_TASK — marks task as failed with reason
BLOCK_TASK — marks task as blocked (waiting for external input)
UNBLOCK_TASK — resumes a blocked task
```

## Quick Pipeline (Single Note)

For processing a single note through reflect + verify:

```
1. Run /powerhouse-knowledge:connect on the note (reflect phase)
2. Run /powerhouse-knowledge:verify on the note (verify phase)
3. If pass: update note status to CONNECTED or VERIFIED
```

## Batch Pipeline

For processing multiple notes from a source:

```
1. Run /powerhouse-knowledge:extract on the source → creates N notes + N pipeline tasks
2. For each task: run connect → reweave → verify
3. Track progress via pipeline-queue document
```

If "$ARGUMENTS" is provided, treat it as the source or note to process.
