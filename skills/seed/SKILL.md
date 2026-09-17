---
name: seed
description: Ingest source material into the Knowledge Vault for processing. Use when the user has an article, transcript, documentation, or any text they want to add to the knowledge base.
---

# Seed Source Material

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Record: put source material into the vault as a `bai/source` and queue it for
extraction. A source is the archive and the provenance record for every note
extracted from it — capture is fast, but a field left null now cannot be
recovered later without the original.

## Ingest — one call

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/sources" -d '{
  "drive": "<drive-uuid>",
  "title": "<Parent work — Ch. 05: Title>",
  "content": "<full text, real newlines>",
  "sourceType": "BOOK_CHAPTER",
  "description": "<what it covers, and why it was brought in>",
  "author": "<who wrote it>",
  "url": "<canonical URL or local path>",
  "publishedAt": "<ISO UTC Z>",
  "method": "pdf-extract",
  "tool": "<script or agent>"
}'
```

That request creates the document in `/sources`, dispatches `INGEST_SOURCE`,
sets the status to `EXTRACTING` and adds the `claim` task to the pipeline queue
(checking first that no task already references this document). Add
`"queue": false` to skip the task. The response gives `id`, `path` and
`readBack`. The CLI path below needs six commands for the same state.

### The ingest contract

| Field | Rule |
|---|---|
| `title` | The source's own title; name the parent work for a part: `Design for How People Think — Ch. 05: Language` |
| `content` | The full text, never truncated. Real newlines, encoded once |
| `sourceType` | `ARTICLE` `PAPER` `BOOK_CHAPTER` `TRANSCRIPT` `DOCUMENTATION` `CONVERSATION` `WEB_PAGE` `MANUAL_ENTRY` |
| `description` | One or two sentences: what the source covers **and why it is in the vault** — the reaction that made it worth ingesting is what seeds synthesis later; the content alone only seeds reference. Never null: a source without one is unbrowsable |
| `author` | The person or organisation — not you |
| `url` | Canonical URL, or the file path for a local import |
| `publishedAt` | When the source was **written** |
| `createdAt` | When you **ingested** it — now. REST sets it; on the CLI pass it |
| `method`, `tool` | How the text was obtained (`pdf-extract`, `sha256:<hash> git:<tag>`) and by what |
| `createdBy` | REST takes it from your bearer; pass it on the CLI |

- **`publishedAt` vs `createdAt`.** Putting the publication year in `createdAt`
  makes a source that arrived today look years old to `knowledgeGraphRecent` and
  `knowledgeGraphStale` and leaves "when was this published?" unanswerable. A
  24-chapter ingest got this wrong on all 24.
- **Provenance is built when any of** `url`, `author`, `publishedAt`, `method`,
  `tool` is present (since 2026-09-17; older reducers dropped `method`/`tool`
  alone).
- **Re-ingesting resets the status to `INBOX`**, unconditionally — an `EXTRACTED`
  source reverts to the backlog and `/health` reports it stranded. Walk it back
  in two steps, `EXTRACTING` then `EXTRACTED`: the transition table rejects
  `INBOX → EXTRACTED` (`InvalidSourceStatusTransitionError`).
- Dates are UTC `Z` strings; an offset form (`+02:00`) is dropped by the reducer,
  leaving the field null.

### No duplicates — check the title in state, not the node name

`POST sources` does not detect duplicates and the drive does not reject the
second copy; it **renames** it (`… (copy) 1`). Two copies mean two tasks, two
extractions and two sets of notes citing different ids. Before a bulk ingest,
list `/sources` and compare on the source **title in state**. Cleaning one up
takes both halves: `switchboard docs delete <id> -y` (CLI only) **and**
`FAIL_TASK` on its queue task, or the task holds an `activeCount` slot forever.

### One origin, many sources → a folder

Every operation stores a full copy of the document's state, so each
`ADD_EXTRACTED_CLAIM` on a book-sized source re-serialises the whole book: split
long sources into chapters. When one origin yields **three or more** sources,
mint a folder first so they stay one thing:

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/sources/folders" \
  -d '{"drive":"<drive-uuid>","name":"<the book or series>"}'           # idempotent on name within /sources
# then each chapter names the id it returned
curl … -X POST "$BASE/sources" -d '{ …, "parentFolder": "<folder-id>" }'
```

`parentFolder` takes the folder **id**, never a name. The folder must be
`/sources` or inside it (`FOLDER_OUTSIDE_VAULT_PATH` otherwise); a drive never
opened in the app gives `FOLDER_UNRESOLVED`. Grouping is navigation only.
Sources are not batched: `POST notes` with `documentType: "bai/source"` creates
documents that are neither ingested, queued nor placeable — one `POST sources`
per source even for a whole book.

<details><summary>Without the REST surface (CLI, six commands, signed as you)</summary>

```bash
switchboard docs tree <drive-slug> --format json                                   # sources folder + queue id
switchboard docs create --type bai/source --name "<title>" --drive <drive-slug> --parent-folder <sources-folder-uuid> --format json
switchboard docs apply <source-id> --file /tmp/ingest.json                         # one INGEST_SOURCE action with every field above, "scope":"global"
switchboard docs mutate <pipeline-queue-id> --op addTask --input '{"id":"<fresh uuid>","taskType":"claim","target":"<title>","documentRef":"<source-id>","createdAt":"<ISO>"}'
switchboard docs mutate <source-id> --op setSourceStatus --input '{"status":"EXTRACTING"}'
switchboard docs tree <drive-slug> --format json | grep <source-id>                # exists
```

Check the queue for an existing non-DONE task on this `documentRef` before
`addTask`; a reused id is rejected with `DuplicateTaskIdError`. The lifecycle is
`INBOX → EXTRACTING → EXTRACTED → ARCHIVED`; extract sets `EXTRACTED`.

</details>

## Then

Run `/powerhouse-knowledge:pipeline` (or `/extract` alone) on the new source.
Every source ends the pipeline `EXTRACTED` or `ARCHIVED` with its notes placed
in the MoC hierarchy; a source left `EXTRACTING` reads as unprocessed forever.

## Checklist

- [ ] Title names the parent work for a part; full content preserved; correct `sourceType`
- [ ] `description` says what it covers and why it is here
- [ ] `author`, `url`, `publishedAt`, `method`, `tool` filled from the original; `createdAt` is the ingest time
- [ ] No existing source with this title in state
- [ ] 3+ sources from one origin share a `/sources` folder
- [ ] Status `EXTRACTING` and one `claim` task with `documentRef` set, read back

If "$ARGUMENTS" is provided, treat it as the source material or URL to seed.
