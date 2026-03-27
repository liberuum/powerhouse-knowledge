---
name: import
description: Bulk import knowledge from external sources — markdown files, Obsidian vaults, Ars Contexta local vaults, or JSON data. Creates documents in correct folders with links preserved. Use when migrating an existing knowledge base to the vault.
---

# Bulk Import

Import knowledge from external sources into the Knowledge Vault.

## Supported Sources

- **Markdown files** (with YAML frontmatter)
- **Obsidian vaults** (wiki links -> typed document links)
- **Ars Contexta local vaults** (full structure preservation)
- **JSON data** (array of note objects)

## Import Process

### Step 1: Read the drive and find folder IDs
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Build a folder map: "knowledge/notes" -> folder-id, "sources" -> folder-id, etc.
```

### Step 2: First pass — create all documents (no links)

For each note/source in the import data:
```
mcp__reactor-mcp__createDocument({
  documentType: "bai/knowledge-note",
  driveId: "<drive-uuid>",
  name: "<note-title>",
  parentFolder: "<notes-folder-uuid>"
})
```

**CRITICAL: MCP race condition prevention**
- Add a **100ms delay** between each `createDocument` call
- Rapid sequential calls can cause drive file nodes to silently fail
- This is a known reactor issue with concurrent drive mutations

Then set content:
```
mcp__reactor-mcp__addActions({
  documentId: "<new-doc-id>",
  actions: [
    { type: "SET_TITLE", input: { title: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_DESCRIPTION", input: { description: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_CONTENT", input: { content: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_NOTE_TYPE", input: { noteType: "...", updatedAt: "..." }, scope: "global" },
    { type: "SET_PROVENANCE", input: { author: "...", sourceOrigin: "IMPORT", createdAt: "..." }, scope: "global" }
  ]
})
```

**Valid sourceOrigin values:** `DERIVED`, `IMPORT`, `MANUAL`, `SESSION_MINE`. For bulk imports, use `IMPORT`.

**Save a title -> document-id mapping** for link resolution in step 3.

### Step 3: Verify drive nodes (repair missing)

After creating all documents, verify every document has a file node in the drive:
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Compare file node IDs against created document IDs
// For any missing: dispatch ADD_FILE on the drive
```

```
mcp__reactor-mcp__addActions({
  documentId: "<drive-uuid>",
  actions: [{
    type: "ADD_FILE",
    input: { id: "<missing-doc-id>", name: "<title>", documentType: "bai/knowledge-note", parentFolder: "<folder-id>" },
    scope: "global"
  }]
})
```

### Step 4: Second pass — resolve and create links

For each note that has references (wiki links, related notes):
1. Look up the target document ID from the title mapping
2. Create typed links:
```
mcp__reactor-mcp__addActions({
  documentId: "<source-note-id>",
  actions: [{
    type: "ADD_LINK",
    input: {
      id: "<generate-unique-id>",
      targetDocumentId: "<resolved-target-id>",
      targetTitle: "<target-title>",
      linkType: "RELATES_TO"
    },
    scope: "global"
  }]
})
```

### Step 5: Create MOCs from folder structure or tags (optional)

If the source has categories/folders/tags with 2+ notes, create MOC documents:
```
mcp__reactor-mcp__createDocument({
  documentType: "bai/moc",
  driveId: "<drive-uuid>",
  name: "<topic-name>",
  parentFolder: "<knowledge-folder-uuid>"
})
```

Then add core ideas linking to the notes in that category.

### Step 6: Verify and report

- Count: notes created, links resolved, links unresolved
- Verify all documents in drive tree (no ghost nodes)
- Report orphan notes that need manual connection

## Automated Import Scripts

For large imports (50+ notes), prefer the dedicated scripts which include built-in pacing and verification:

```bash
# Import knowledge notes from a vault directory
node scripts/import-vault.mjs \
  --drive-id <UUID> \
  --vault-path /path/to/vault/notes/ \
  [--create-mocs] [--dry-run] [--limit N]

# Import research claims (Ars Contexta methodology)
node scripts/import-research-claims.mjs \
  --drive-id <UUID> \
  --vault-path /path/to/methodology/ \
  [--dry-run] [--limit N]
```

These scripts use MCP Streamable HTTP for bulk creation and include automatic drive node verification + repair.

## Wiki Link Resolution

Convert `[[wiki link]]` to document links:

```
For each [[target title]] in note content:
  1. Find document with matching title in the title-to-id map
  2. If found: create ADD_LINK with the document ID
  3. If not found: log as unresolved (may be an external reference)
```

## Markdown Frontmatter Mapping

```yaml
---
title: "Note Title"           -> SET_TITLE
description: "Summary"        -> SET_DESCRIPTION
type: pattern                  -> SET_NOTE_TYPE
topics: ["topic-a", "topic-b"] -> ADD_TOPIC (x2)
confidence: established        -> SET_METADATA_FIELD
---
Content body                   -> SET_CONTENT
```

If "$ARGUMENTS" is provided, treat it as the path to import from.
