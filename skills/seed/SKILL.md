---
name: seed
description: Ingest source material into the Knowledge Vault for processing. Use when the user has an article, transcript, documentation, or any text they want to add to the knowledge base.
---

# Seed Source Material

Add source material to the Knowledge Vault and queue it for the extraction pipeline.

## Seeding process

1. **Receive the source** — text content, URL, file path, or pasted content from the user
2. **Find the `/sources/` folder ID** by reading the drive:
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-id>" })
// Find: kind="folder", name="sources", parentFolder=null
```

3. **Create the source document** in the correct folder (use drive UUID, never slug):
```
mcp__reactor-mcp__createDocument({
  documentType: "bai/source",
  driveId: "<drive-uuid>",
  name: "<source title>",
  parentFolder: "<sources-folder-uuid>"
})
```

3. **Set the source metadata**:

```
mcp__reactor-mcp__addActions({
  documentId: "<doc-id>",
  actions: [
    { type: "SET_TITLE", input: { title: "<source title>", updatedAt: "..." }, scope: "global" },
    { type: "SET_CONTENT", input: { content: "<full source content>", updatedAt: "..." }, scope: "global" },
    { type: "SET_NOTE_TYPE", input: { noteType: "reference", updatedAt: "..." }, scope: "global" },
    { type: "SET_PROVENANCE", input: {
      author: "<user or source author>",
      sourceOrigin: "IMPORT",
      createdAt: "..."
    }, scope: "global" },
    { type: "SET_METADATA_FIELD", input: { field: "sourceType", value: "<article|paper|transcript|documentation|conversation|web_page>", updatedAt: "..." }, scope: "global" }
  ]
})
```

4. **Suggest next steps**:
   - Run `/powerhouse-knowledge:extract` to extract atomic claims from this source
   - The extract skill will create individual note documents for each claim

## Source types

- **article** — web articles, blog posts
- **paper** — academic papers, research
- **transcript** — conversation transcripts, meeting notes
- **documentation** — technical docs, API references
- **conversation** — chat logs, session transcripts
- **web_page** — general web content

## Quality checklist

- [ ] Source title is descriptive
- [ ] Full content is preserved (not truncated)
- [ ] Source type is set correctly
- [ ] Provenance records the origin
- [ ] No duplicate source exists (search first)

If "$ARGUMENTS" is provided, treat it as the source material or URL to seed.
