---
name: verify
description: Run verification checks on knowledge notes — recite test, schema validation, and health checks. Use as a quality gate after creating or editing notes.
---

# Verify Knowledge Notes

Three-part verification combining cold-read prediction, schema compliance, and link health.

## Verification process

### 1. Recite Test (Description Quality)

Read ONLY the title and description of the note. Without reading the content, predict what the note contains. Then read the actual content and compare:
- **PASS**: Your prediction closely matches the actual content
- **WARN**: Prediction partially matches — description may need sharpening
- **FAIL**: Prediction doesn't match — title or description is misleading

### 2. Schema Validation

Check the note has all expected fields populated:
- [ ] Title is a prose sentence making one claim
- [ ] Description is ~150 chars, adds info beyond title
- [ ] Note type is set and appropriate
- [ ] Content is substantive (not empty or stub)
- [ ] Provenance is set (author, source origin)
- [ ] Status is appropriate for the note's maturity

### 3. Health Checks

- [ ] **Link density**: Note has >= 2 outgoing links (not an orphan)
- [ ] **Link resolution**: All linked document IDs point to existing documents
- [ ] **Topic coverage**: Note belongs to at least one topic
- [ ] **Description length**: Between 80-200 characters
- [ ] **Content length**: At least 200 characters of substantive prose

## Output format

```
Note: "<title>"
Recite:   PASS | WARN | FAIL — <explanation>
Schema:   PASS | WARN | FAIL — <issues found>
Health:   PASS | WARN | FAIL — <issues found>
Overall:  PASS | WARN | FAIL
Action:   <what to fix if not PASS>
```

## Recording verification

After verification, dispatch the result to the knowledge graph processor by updating the note's metadata:

```
SET_METADATA_FIELD: { field: "confidence", value: "established|emerging|speculative" }
```

If "$ARGUMENTS" is provided, verify that specific note (by title or document ID).
