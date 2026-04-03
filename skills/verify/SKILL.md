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
- [ ] **Methodology grounding**: Note content includes a "Methodology grounding" section referencing at least one research claim from the plugin's `data/methodology/` files

## Auto-repair (fix before reporting)

When verification finds fixable issues, **repair them immediately** instead of just reporting:

### Missing description
Generate a description from the title and content, then dispatch:
```bash
switchboard docs mutate <note-id> --op setDescription --input '{"description": "<generated ~150 char summary>", "updatedAt": "<ISO>"}'
```

### Missing provenance
```bash
switchboard docs mutate <note-id> --op setProvenance --input '{"author": "knowledge-agent", "sourceOrigin": "DERIVED", "createdAt": "<ISO>"}'
```

### Missing note type
Infer the type from content and set it:
```bash
switchboard docs mutate <note-id> --op setNoteType --input '{"noteType": "<inferred-type>", "updatedAt": "<ISO>"}'
```

### Missing methodology grounding
Search the plugin's local methodology files (`data/methodology/*.md`) by keywords from the note's title and topics. Use the Grep tool to find matching claims by title, description, or topic overlap.

If a relevant claim is found, append a "Methodology grounding" section to the note's content:

```bash
switchboard docs mutate <note-id> --op setContent --input '{
  "content": "<existing content>\n\n## Methodology grounding\n- **[[claim title]]** — how this note relates to the claim (BUILDS_ON)",
  "updatedAt": "<ISO>"
}'
```

### Missing topics
Identify key topics from the content and add them:
```bash
switchboard docs mutate <note-id> --op addTopic --input '{"id": "<unique-id>", "name": "<topic>"}'
```

## Batch verification

When verifying all notes in the vault (no specific note targeted):

1. Read all knowledge notes from the drive
2. For each note, run the three checks
3. **Auto-repair all fixable issues first**
4. Report only issues that require human judgment (recite test failures, content quality)

```bash
# Use the subgraph to quickly find problem notes
switchboard query '{ knowledgeGraphOrphans(driveId: "<UUID>") { documentId title } }'
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
```bash
switchboard docs mutate <note-id> --op setMetadataField --input '{"field": "confidence", "value": "established|emerging|speculative", "updatedAt": "<ISO>"}'
```

## Pipeline integration

When verify runs as part of the pipeline (phase 4), record a handoff. **Use `docs mutate` for pipeline operations — never batch with `docs apply`:**
```bash
switchboard docs mutate <pipeline-queue-id> --op advancePhase --input '{
  "taskId": "<task-id>",
  "handoff": {
    "id": "<unique-id>",
    "phase": "verify",
    "workDone": "Verified N notes. Auto-repaired M issues. N PASS, N WARN, N FAIL.",
    "filesModified": ["<note-ids>"],
    "completedAt": "<ISO>",
    "completedBy": "knowledge-agent"
  },
  "updatedAt": "<ISO>"
}'
```

If "$ARGUMENTS" is provided, verify that specific note (by title or document ID).
