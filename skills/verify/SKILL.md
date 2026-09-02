---
name: verify
description: Run verification checks on knowledge notes — recite test, schema validation, and health checks. Automatically repairs common issues (missing descriptions, provenance). Use as a quality gate after extraction or editing.
---

# Verify Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

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

- [ ] **Link density**: Note has >= 2 links (read from `knowledgeGraphForwardLinks` / `knowledgeGraphBacklinks`, not the note's `links[]`)
- [ ] **Not an orphan**: at least one **incoming** edge. An orphan is a node with zero incoming knowledge edges — this is what `knowledgeGraphOrphans` returns; outgoing links do not make a note non-orphan
- [ ] **Real line breaks**: `content` contains no literal `\n` sequence (see repair below)
- [ ] **Link resolution**: every `targetDocumentId` in the note's forward edges points to an existing document
- [ ] **Link articulation**: every knowledge edge out of the note (`RELATES_TO`, `BUILDS_ON`, `CONTRADICTS`, `SUPERSEDES`, `DERIVED_FROM`) carries a `reason` (`knowledgeGraphForwardLinks { targetDocumentId linkType reason confidence }`). A bare edge is a WARN on the note, not a FAIL — but it is never silently PASS
- [ ] **Topic coverage**: Note belongs to at least one topic
- [ ] **Description length**: Between 80-200 characters
- [ ] **Content length**: At least 200 characters of substantive prose
- [ ] **Methodology grounding**: Note content includes a "Methodology grounding" section referencing at least one research claim from the plugin's `data/methodology/` files

## Auto-repair (fix before reporting)

When verification finds fixable issues, **repair them immediately** instead of just reporting:

### Literal `\n` in content (double-encoded line breaks)

Symptom: `content` contains the two characters `\n` (and no real newlines) — the note renders as one run-on line. Detect across the vault in one call, then repair with a real serializer:

```bash
switchboard query '{ knowledgeGraphNodes(driveId: "<UUID>") { documentId status content } }' --format json \
  | python3 -c "
import json,sys; d=json.load(sys.stdin); d=d.get('data',d)['knowledgeGraphNodes']
bad=[n['documentId'] for n in d if n['status']!='MOC' and (n['content'] or '').count(chr(92)+'n')>0]
print(len(bad),'notes with literal backslash-n'); print(chr(10).join(bad))"
```

Repair each: read the content, replace the two-character sequence with a newline **in Python** (`s.replace(chr(92)+'n', chr(10))`), `json.dump` a single `SET_CONTENT` action to a file, `docs apply --file`, and read back. Never do the replacement in bash — that is how the bug is made.

### Over-long description (rejected on write)

A description over 200 characters never reaches state — the reducer rejects it and the note is left with whatever description it had before (often none), while the batch reports success. So an "empty description" on a note whose extraction clearly produced one is usually this. When repairing, **count the way the reducer does**: JavaScript `.length` (UTF-16 units). In Python use `len(s.encode("utf-16-le")) // 2`, not `len(s)` — an emoji is 2 units, and `len()` undercounts it. Or run `node scripts/lint-actions.mjs` on the repair file before applying it.

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

### Bare edges (a link with no reason)

Read both notes; if the connection is real, write the sentence onto the edge —
this is the one repair in this skill that needs judgment, so it is repaired
only when you can actually state the reason:

```bash
switchboard docs annotate <note-id> <target-id> -t BUILDS_ON \
  --reason "<note> extends <target>'s claim about X to Y" --confidence established
```

If, having read both, you cannot complete "A connects to B because …", the
edge fails the articulation test: `docs unlink` it and say so in the report.
Never write a reason that restates the type or the two titles to turn the
WARN green — an unarticulated edge honestly reported beats a fake sentence.
Count both outcomes in the summary (`articulated: N, unlinked: M, left bare: K`).

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
Edges: N articulated (docs annotate), M unlinked (failed the articulation test), K left bare

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
switchboard docs mutate <note-id> --op setMetadataField --input '{"field": "confidence", "value": "grounded|established|speculative", "updatedAt": "<ISO>"}'
```

## Pipeline integration

When verify runs as part of the pipeline (phase 4), record a handoff. **Batch it with any other queue ops if you like — `docs apply` preserves order and isolates failures — then read the task back to confirm the phase advanced:**
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

## After auto-repair: refresh the health report

`/verify --fix` changes exactly the things the health report grades
(descriptions, provenance, note types, links). The dashboard reads the
**last** `bai/health-report`, so skipping this step leaves the user
looking at problems you already fixed.

After any repair, re-run the health check and rewrite the report:
`/powerhouse-knowledge:health` — see [skills/health/SKILL.md](../health/SKILL.md).
Verify by reading the report back, not by trusting the dispatch.
