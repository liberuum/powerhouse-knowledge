---
name: seed
description: Ingest source material into the Knowledge Vault for processing. Use when the user has an article, transcript, documentation, or any text they want to add to the knowledge base.
---

# Seed Source Material

Add source material to the Knowledge Vault and queue it for the extraction pipeline.

## Seeding process

1. **Receive the source** — text content, URL, file path, or pasted content from the user
2. **Find the `/sources/` folder ID** by reading the drive:
```bash
switchboard docs tree <drive-slug> --format json
# Find: kind="folder", name="sources", parentFolder=null
```

3. **Create the source document** in the correct folder:
```bash
switchboard docs create --type bai/source --name "<source title>" --drive <drive-slug> --parent-folder <sources-folder-uuid> --format json
```

4. **Set the source metadata via INGEST_SOURCE** (single operation that initializes all fields):
```bash
switchboard docs mutate <doc-id> --op ingestSource --input '{
  "title": "<source title>",
  "content": "<full source content>",
  "sourceType": "<ARTICLE|PAPER|TRANSCRIPT|DOCUMENTATION|CONVERSATION|WEB_PAGE|BOOK_CHAPTER|MANUAL_ENTRY>",
  "description": "<brief summary>",
  "author": "<source author>",
  "url": "<source URL if available>",
  "createdAt": "<ISO timestamp>",
  "createdBy": "<user or agent name>"
}'
```

For long content, write the action to a temp file and use `--file`:
```bash
cat > /tmp/ingest-action.json << 'EOF'
[{
  "type": "INGEST_SOURCE",
  "input": {
    "title": "...",
    "content": "...",
    "sourceType": "ARTICLE",
    "createdAt": "2026-03-30T12:00:00.000Z"
  },
  "scope": "global"
}]
EOF
switchboard docs apply <doc-id> --file /tmp/ingest-action.json
```

5. **Queue for processing** — add a pipeline task:
```bash
# Find the PipelineQueue singleton
switchboard docs tree <drive-slug> --format json
# Find: kind="file", documentType="bai/pipeline-queue"

switchboard docs mutate <pipeline-queue-id> --op addTask --input '{
  "id": "<generate-unique-id>",
  "taskType": "claim",
  "target": "<source title>",
  "documentRef": "<source-doc-id>",
  "createdAt": "<ISO timestamp>"
}'
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
