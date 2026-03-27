---
name: verify
description: Run verification checks on knowledge notes — recite test, schema validation, and health checks. Automatically repairs common issues (missing descriptions, provenance). Use as a quality gate after extraction or editing.
---

# Verify Knowledge Notes

Three-part verification combining cold-read prediction, schema compliance, and link health. **Automatically repairs fixable issues.**

## Verification process

### 1. Recite Test (Description Quality)

Read ONLY the title and description of the note. Without reading the content, predict what the note contains. Then read the actual content and compare:
- **PASS**: Your prediction closely matches the actual content
- **WARN**: Prediction partially matches — description may need sharpening
- **FAIL**: Prediction doesn't match — title or description is misleading

### 2. Schema Validation

Check the note has all expected fields populated:
- [ ] Title is a prose sentence making one claim
- [ ] **Description exists and is ~150 chars** (adds info beyond title)
- [ ] Note type is set and appropriate
- [ ] Content is substantive (not empty or stub)
- [ ] **Provenance is set** (author, sourceOrigin, createdAt)
- [ ] At least one topic tag
- [ ] Status is appropriate for the note's maturity

### 3. Health Checks

- [ ] **Link density**: Note has >= 2 outgoing links (not an orphan)
- [ ] **Link resolution**: All linked document IDs point to existing documents
- [ ] **Topic coverage**: Note belongs to at least one topic
- [ ] **Description length**: Between 80-200 characters
- [ ] **Content length**: At least 200 characters of substantive prose

## Auto-repair (fix before reporting)

When verification finds fixable issues, **repair them immediately** instead of just reporting:

### Missing description
Generate a description from the title and content, then dispatch:
```
mcp__reactor-mcp__addActions({
  documentId: "<note-id>",
  actions: [{
    type: "SET_DESCRIPTION",
    input: { description: "<generated ~150 char summary>", updatedAt: "<ISO>" },
    scope: "global"
  }]
})
```

### Missing provenance
```
mcp__reactor-mcp__addActions({
  documentId: "<note-id>",
  actions: [{
    type: "SET_PROVENANCE",
    input: { author: "knowledge-agent", sourceOrigin: "DERIVED", createdAt: "<ISO>" },
    scope: "global"
  }]
})
```

### Missing note type
Infer the type from content and set it:
```
mcp__reactor-mcp__addActions({
  documentId: "<note-id>",
  actions: [{
    type: "SET_NOTE_TYPE",
    input: { noteType: "<inferred-type>", updatedAt: "<ISO>" },
    scope: "global"
  }]
})
```

### Missing topics
Identify key topics from the content and add them:
```
mcp__reactor-mcp__addActions({
  documentId: "<note-id>",
  actions: [{
    type: "ADD_TOPIC",
    input: { id: "<unique-id>", name: "<topic>" },
    scope: "global"
  }]
})
```

## Batch verification

When verifying all notes in the vault (no specific note targeted):

1. Read all knowledge notes from the drive
2. For each note, run the three checks
3. **Auto-repair all fixable issues first**
4. Report only issues that require human judgment (recite test failures, content quality)

```bash
# Use the subgraph to quickly find problem notes
curl -s $REACTOR_URL/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphOrphans(driveId: \"<UUID>\") { documentId title } }"}'
```

## Output format

```
=== VERIFICATION REPORT ===

Verified: N notes
Auto-repaired: N issues (M descriptions, P provenance, Q types)

Note: "<title>"
  Recite:   PASS | WARN | FAIL — <explanation>
  Schema:   PASS (auto-repaired: added description) | FAIL — <issues>
  Health:   PASS | WARN | FAIL — <issues>
  Overall:  PASS | WARN | FAIL
  Action:   <what to fix if not PASS>

Summary:
  PASS: N | WARN: N | FAIL: N
  Remaining issues: <list of issues requiring human action>
```

## Recording verification

After verification, update confidence based on results:
```
mcp__reactor-mcp__addActions({
  documentId: "<note-id>",
  actions: [{
    type: "SET_METADATA_FIELD",
    input: { field: "confidence", value: "established|emerging|speculative", updatedAt: "<ISO>" },
    scope: "global"
  }]
})
```

## Pipeline integration

When verify runs as part of the pipeline (phase 4), record a handoff:
```
mcp__reactor-mcp__addActions({
  documentId: "<pipeline-queue-id>",
  actions: [{
    type: "ADVANCE_PHASE",
    input: {
      taskId: "<task-id>",
      handoff: {
        id: "<unique-id>",
        phase: "verify",
        workDone: "Verified N notes. Auto-repaired M issues. N PASS, N WARN, N FAIL.",
        filesModified: ["<note-ids>"],
        completedAt: "<ISO>",
        completedBy: "knowledge-agent"
      },
      updatedAt: "<ISO>"
    },
    scope: "global"
  }]
})
```

If "$ARGUMENTS" is provided, verify that specific note (by title or document ID).
