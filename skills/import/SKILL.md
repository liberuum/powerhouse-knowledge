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
```bash
switchboard docs tree <drive-slug> --format json
# Build a folder map: "knowledge/notes" -> folder-id, "sources" -> folder-id, etc.
```

### Step 2: First pass — create all documents (no links)

For each note/source in the import data:
```bash
switchboard docs create --type bai/knowledge-note --name "<note-title>" --drive <drive-slug> --parent-folder <notes-folder-uuid> --format json
```

Then set content:
```bash
switchboard docs apply <new-doc-id> --actions '[
  { "type": "SET_TITLE", "input": { "title": "...", "updatedAt": "..." }, "scope": "global" },
  { "type": "SET_DESCRIPTION", "input": { "description": "...", "updatedAt": "..." }, "scope": "global" },
  { "type": "SET_CONTENT", "input": { "content": "...", "updatedAt": "..." }, "scope": "global" },
  { "type": "SET_NOTE_TYPE", "input": { "noteType": "...", "updatedAt": "..." }, "scope": "global" }
]'
```

Then set provenance in a **separate batch** (validation failures won't kill content):
```bash
switchboard docs mutate <new-doc-id> --op setProvenance --input '{"author": "...", "sourceOrigin": "IMPORT", "createdAt": "..."}'
```

**Valid sourceOrigin values:** `DERIVED`, `IMPORT`, `MANUAL`, `SESSION_MINE`. For bulk imports, use `IMPORT`.

**Save a title -> document-id mapping** for link resolution in step 3.

### Step 3: Verify drive nodes (repair missing)

After creating all documents, verify every document has a file node in the drive:
```bash
switchboard docs tree <drive-slug> --format json
# Compare file node IDs against created document IDs
# For any missing: dispatch ADD_FILE on the drive
```

```bash
switchboard docs mutate <drive-id> --op addFile --input '{
  "id": "<missing-doc-id>",
  "name": "<title>",
  "documentType": "bai/knowledge-note",
  "parentFolder": "<folder-id>"
}'
```

### Step 4: Second pass — resolve and create links

For each note that has references (wiki links, related notes):
1. Look up the target document ID from the title mapping
2. Create typed links:
```bash
switchboard docs mutate <source-note-id> --op addLink --input '{
  "id": "<generate-unique-id>",
  "targetDocumentId": "<resolved-target-id>",
  "targetTitle": "<target-title>",
  "linkType": "RELATES_TO"
}'
```

### Step 5: Create MOCs from folder structure or tags (optional)

If the source has categories/folders/tags with 2+ notes, create MOC documents:
```bash
switchboard docs create --type bai/moc --name "<topic-name>" --drive <drive-slug> --parent-folder <knowledge-folder-uuid> --format json
```

Then add core ideas linking to the notes in that category.

### Step 6: Verify and report

- Count: notes created, links resolved, links unresolved
- Verify all documents in drive tree (no ghost nodes)
- Report orphan notes that need manual connection

## Automated Import Scripts

For large imports (50+ notes), prefer the dedicated scripts which include built-in pacing and verification:

```bash
# Import research claims (Ars Contexta methodology) via CLI
python3 scripts/import-methodology.py <drive-slug>

# Import knowledge notes from a vault directory
node scripts/import-vault.mjs \
  --drive-id <UUID> \
  --vault-path /path/to/vault/notes/ \
  [--create-mocs] [--dry-run] [--limit N]

# Import research claims via MCP script
node scripts/import-research-claims.mjs \
  --drive-id <UUID> \
  --vault-path /path/to/methodology/ \
  [--dry-run] [--limit N]
```

These scripts use the Switchboard CLI for bulk creation and include automatic drive node verification + repair.

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
