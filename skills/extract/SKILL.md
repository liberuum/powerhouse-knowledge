---
name: extract
description: Extract atomic knowledge claims from source material and create note documents. Use when the user provides text, articles, transcripts, or any content to be processed into structured knowledge notes.
---

# Extract Knowledge Claims

Extract atomic, composable knowledge claims from source material and create them as `bai/knowledge-note` documents in the Knowledge Vault.

## Extraction process

1. **Analyze the source material** provided by the user (text, URL content, transcript, etc.)
2. **Identify atomic claims** — each claim should:
   - Make exactly ONE point
   - Be titled as a prose sentence (e.g., "Spreading activation explains why wiki links aid recall")
   - Have a ~150 character description that adds information beyond the title
   - Be categorized by note type: concept, decision, pattern, observation, procedure, architecture, bug-pattern, integration, workflow, reference
3. **Create documents** for each claim using MCP tools

## Creating a note

For each extracted claim:

**IMPORTANT: Always place notes in the correct folder.**

**Step A:** Find the target folder ID (use the drive UUID, never the slug):
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Find: kind="folder", name="notes", parentFolder=<knowledge-folder-id>
```

**Step B:** Create the document with `parentFolder`:
```
mcp__reactor-mcp__createDocument({
  documentType: "bai/knowledge-note",
  driveId: "<drive-uuid>",
  name: "<claim title>",
  parentFolder: "<notes-folder-uuid>"
})
```

Then dispatch operations:
```
mcp__reactor-mcp__addActions({
  documentId: "<new-doc-id>",
  actions: [
    { type: "SET_TITLE", input: { title: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_DESCRIPTION", input: { description: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_NOTE_TYPE", input: { noteType: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_CONTENT", input: { content: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_PROVENANCE", input: { author: "...", sourceOrigin: "IMPORT", createdAt: "..." }, scope: "global" }
  ]
})
```

## Quality gates

- **Comprehensive extraction**: skip rate < 10% for domain-relevant sources
- **Atomic claims**: each note makes one point, not a summary
- **Description quality**: adds information beyond the title, enables filter-before-read
- **No duplicates**: search existing notes before creating (use the search skill)

If the user provides "$ARGUMENTS", treat it as the source material to extract from.
