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
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
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

4. **Set the source metadata via INGEST_SOURCE** (single operation that initializes all fields):
```
mcp__reactor-mcp__addActions({
  documentId: "<doc-id>",
  actions: [{
    type: "INGEST_SOURCE",
    input: {
      title: "<source title>",
      content: "<full source content>",
      sourceType: "<ARTICLE|PAPER|TRANSCRIPT|DOCUMENTATION|CONVERSATION|WEB_PAGE|BOOK_CHAPTER|MANUAL_ENTRY>",
      description: "<brief summary>",
      author: "<source author>",
      url: "<source URL if available>",
      createdAt: "<ISO timestamp>",
      createdBy: "<user or agent name>"
    },
    scope: "global"
  }]
})
```

5. **Queue for processing** — add a pipeline task:
```
// Find the PipelineQueue singleton
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Find: kind="file", documentType="bai/pipeline-queue"

mcp__reactor-mcp__addActions({
  documentId: "<pipeline-queue-id>",
  actions: [{
    type: "ADD_TASK",
    input: {
      id: "<generate-unique-id>",
      taskType: "claim",
      target: "<source title>",
      documentRef: "<source-doc-id>",
      createdAt: "<ISO timestamp>"
    },
    scope: "global"
  }]
})
```

**Important:** Check if a pipeline task already exists for this `documentRef` before creating a duplicate. If one exists and isn't DONE/FAILED, skip creating a new task.

6. **Suggest next steps**:
   - Run `/powerhouse-knowledge:extract` to extract atomic claims from this source
   - Or run `/powerhouse-knowledge:pipeline` for the full extract → connect → reweave → verify flow

## Source types

- **ARTICLE** — web articles, blog posts
- **PAPER** — academic papers, research
- **TRANSCRIPT** — conversation transcripts, meeting notes
- **DOCUMENTATION** — technical docs, API references
- **CONVERSATION** — chat logs, session transcripts
- **WEB_PAGE** — general web content
- **BOOK_CHAPTER** — book excerpts
- **MANUAL_ENTRY** — manually typed content

## Quality checklist

- [ ] Source title is descriptive
- [ ] Full content is preserved (not truncated)
- [ ] Source type is set correctly
- [ ] Provenance records the origin (author, URL)
- [ ] No duplicate source exists (search first)
- [ ] Pipeline task created for processing

If "$ARGUMENTS" is provided, treat it as the source material or URL to seed.
