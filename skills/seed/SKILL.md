---
name: seed
description: Ingest source material into the Knowledge Vault for processing. Use when the user has an article, transcript, documentation, or any text they want to add to the knowledge base.
---

# Seed Source Material

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Add source material to the Knowledge Vault and queue it for the extraction pipeline.

## Seeding process

1. **Receive the source** — text content, URL, file path, or pasted content from the user
2. **Find the `/sources/` folder ID** by reading the drive:
```bash
switchboard docs tree <drive-slug> --format json
# Find: kind="folder", name="sources", parentFolder=null
```

3. **Create the source document** in the correct folder. Use the source's real title as `--name`: sources are not graph-indexed, so the drive node name is what the note editor shows next to a `DERIVED_FROM` link — a slug here reads as a slug there.
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

**Important:** Check if a pipeline task already exists for this `documentRef` before creating a duplicate. If one exists and isn't DONE/FAILED, skip creating a new task. Generate a fresh UUID for the task `id` — a reused id creates an unreachable ghost task (see the pipeline skill).

Then mark the source as queued. `INGEST_SOURCE` leaves it in `INBOX`; the app's own "Queue for Processing" button moves it to `EXTRACTING` at the same time it adds the task, and `/health` reports a source left in `INBOX` with a task or notes behind it as stranded:
```bash
switchboard docs mutate <source-doc-id> --op setSourceStatus --input '{"status":"EXTRACTING"}'
```
The lifecycle is `INBOX → EXTRACTING → EXTRACTED → ARCHIVED`; the extract skill sets `EXTRACTED` when the notes exist.

6. **Suggest next steps**:
   - Run `/powerhouse-knowledge:extract` to extract atomic claims from this source
   - Or run `/powerhouse-knowledge:pipeline` for the full extract → connect → reweave → verify flow — which also places the new notes in the MoC hierarchy (TOPIC → DOMAIN → HUB) so they are explorable by cluster

**Length limits:** none on a source's title, description or content. (The only hard length limit in any model is a knowledge note's description, ≤ 200 characters.)

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
- [ ] Pipeline task created for processing (fresh UUID, `taskType: "claim"`)
- [ ] Source status set to `EXTRACTING` once queued

If "$ARGUMENTS" is provided, treat it as the source material or URL to seed.
