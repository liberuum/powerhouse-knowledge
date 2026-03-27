---
name: extract
description: Extract atomic knowledge claims from source material. Creates bai/knowledge-note documents from a bai/source document, preserving the provenance chain.
---

# Extract Atomic Claims

Extract individual knowledge claims from a source document and create `bai/knowledge-note` documents for each.

## Extraction process

### Step 1: Read the source document

```
mcp__reactor-mcp__getDocument({ id: "<source-doc-id>" })
```

Read the source's `state.global.content` to get the raw text. Also note the title and sourceType for provenance.

### Step 2: Find the notes folder

```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Find: /knowledge/notes/ folder UUID
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

### Step 4: Create note documents (with pacing)

For each claim, create a document and populate it:

```
mcp__reactor-mcp__createDocument({
  documentType: "bai/knowledge-note",
  driveId: "<drive-uuid>",
  name: "<declarative claim title>",
  parentFolder: "<notes-folder-uuid>"
})
```

**CRITICAL: Add a 100ms delay between each createDocument call** to avoid the MCP race condition where drive file nodes silently fail to register.

Then populate the note:
```
mcp__reactor-mcp__addActions({
  documentId: "<new-note-id>",
  actions: [
    { type: "SET_TITLE", input: { title: "<claim title>", updatedAt: "<ISO>" }, scope: "global" },
    { type: "SET_DESCRIPTION", input: { description: "<~150 char summary>", updatedAt: "<ISO>" }, scope: "global" },
    { type: "SET_NOTE_TYPE", input: { noteType: "<concept|pattern|architecture|decision|...>", updatedAt: "<ISO>" }, scope: "global" },
    { type: "SET_CONTENT", input: { content: "<full markdown body>", updatedAt: "<ISO>" }, scope: "global" },
    { type: "SET_PROVENANCE", input: { author: "<agent-name>", sourceOrigin: "DERIVED", createdAt: "<ISO>" }, scope: "global" },
    { type: "ADD_TOPIC", input: { id: "<unique-id>", name: "<topic>" }, scope: "global" }
  ]
})
```

**Valid sourceOrigin values:** `DERIVED` (extracted from source), `IMPORT` (bulk import), `MANUAL` (user-created), `SESSION_MINE` (session capture). For extraction, always use `DERIVED`.

### Step 5: Verify drive nodes

After creating all notes, verify they all appear as file nodes in the drive. If any are missing (race condition), repair with ADD_FILE:

```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Check: each created note ID exists as a file node
// If missing: dispatch ADD_FILE action on the drive document
```

### Step 6: Update the source document

Track what was extracted:
```
mcp__reactor-mcp__addActions({
  documentId: "<source-doc-id>",
  actions: [
    { type: "SET_SOURCE_STATUS", input: { status: "EXTRACTED" }, scope: "global" },
    { type: "ADD_EXTRACTED_CLAIM", input: { claimRef: "<note-id-1>" }, scope: "global" },
    { type: "ADD_EXTRACTED_CLAIM", input: { claimRef: "<note-id-2>" }, scope: "global" },
    { type: "RECORD_EXTRACTION_STATS", input: {
      claimCount: 5, skippedCount: 0, skipRate: 0.0,
      extractedAt: "<ISO>", extractedBy: "knowledge-agent"
    }, scope: "global" }
  ]
})
```

### Step 7: Record pipeline handoff

If this extraction is part of a pipeline task, advance the phase:
```
mcp__reactor-mcp__addActions({
  documentId: "<pipeline-queue-id>",
  actions: [{
    type: "ADVANCE_PHASE",
    input: {
      taskId: "<task-id>",
      handoff: {
        id: "<unique-id>",
        phase: "create",
        workDone: "Extracted N claims: <brief list>. X% skip rate.",
        filesModified: ["<note-id-1>", "<note-id-2>"],
        completedAt: "<ISO>",
        completedBy: "knowledge-agent"
      },
      updatedAt: "<ISO>"
    },
    scope: "global"
  }]
})
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

## Quality gates

- [ ] Each note makes exactly ONE point
- [ ] Titles are declarative sentences (not questions or fragments)
- [ ] Descriptions add information beyond the title (~150 chars)
- [ ] Content includes arguments/evidence, not just assertions
- [ ] All notes have at least one topic tag
- [ ] Provenance traces back to the source (sourceOrigin: DERIVED)
- [ ] Skip rate < 10% for domain-relevant content
- [ ] All created notes verified in drive tree (no ghost nodes)

If "$ARGUMENTS" is provided, treat it as the source document ID to extract from.
