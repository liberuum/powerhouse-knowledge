---
name: import
description: Bulk import knowledge from external sources — markdown files, Obsidian vaults, Ars Contexta local vaults, or JSON data. Creates documents in correct folders with links preserved. Use when migrating an existing knowledge base to the vault.
---

# Bulk Import

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

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
```

For any missing: re-create the containment by re-running the namespaced create, or use
`switchboard docs mutate <drive-id> --op addFile` ONLY as a last resort (CLI stamps the envelope;
note containment edges since the drive-override migration live in DocumentRelationship — verify
with `docs tree` afterward). CLI-stamped ADD_FILE is sync-safe; the caveat is containment
completeness, not action safety.

```bash
switchboard docs mutate <drive-id> --op addFile --input '{
  "id": "<missing-doc-id>",
  "name": "<title>",
  "documentType": "bai/knowledge-note",
  "parentFolder": "<folder-id>"
}'
```

### Step 4: Second pass — resolve and create relationships

For each note that has references (wiki links, related notes):
1. Look up the target document ID from the title mapping
2. Create the relationship with `docs link` (writes to the reactor's `DocumentRelationship` table — the indexed source of truth since the drive-override migration — signed as you). When the import data carries a reason (a sentence around the wiki link, a `related:` note, frontmatter), put it on the edge:
```bash
switchboard docs link <source-note-id> <resolved-target-id> -t RELATES_TO \
  --reason "<the sentence in the source note that made the link>" --confidence established
```

**When the import has no reasons** — a bare `[[wiki link]]` says only that two
notes touch — do not invent one. Run the import with the hook's escape hatch
and be honest about the result:

```bash
POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1 switchboard docs link <source-note-id> <resolved-target-id> -t RELATES_TO
```

The edges land with `reason: null`; `/health` reports them under LINK_HEALTH
as unarticulated coverage, and `/connect` works through them with
`docs annotate` (or unlinks the ones nobody can explain). Report the count of
bare edges in the import summary so the backlog is visible from day one.

Edges are idempotent on `(source, target, type)`, so re-running an import is safe (a repeat never changes an existing reason — use `docs annotate` for that).

### Step 5: Create MOCs from folder structure or tags (optional)

If the source has categories/folders/tags with 3+ notes, create MOC documents (the same threshold `synthesize` and `health` use):
```bash
switchboard docs create --type bai/moc --name "<topic-name>" --drive <drive-slug> --parent-folder <knowledge-folder-uuid> --format json
```

Then attach the notes with `switchboard docs link <moc-uuid> <note-uuid> -t CORE_IDEA` — one call per note; there is no per-document core-idea operation any more

### Step 6: Verify and report

- Count: notes created, links resolved (articulated vs bare), links unresolved
- Verify all documents in drive tree (no ghost nodes)
- Report orphan notes that need manual connection

## Automated Import Scripts

No bundled import script exists — for large imports (50+ notes), loop the CLI steps above (Steps 1-4) yourself in a shell/Python driver with pacing and verification.

## Wiki Link Resolution

Convert `[[wiki link]]` to relationship rows:

```
For each [[target title]] in note content:
  1. Find document with matching title in the title-to-id map
  2. If found: call `switchboard docs link source target -t RELATES_TO --reason "<sentence around the link>"` (or bare, under POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1, when the source gives no reason)
  3. If not found: log as unresolved (may be an external reference)
```

## Markdown Frontmatter Mapping

```yaml
---
title: "Note Title"           -> SET_TITLE
description: "Summary"        -> SET_DESCRIPTION
type: pattern                  -> SET_NOTE_TYPE
topics: ["topic-a", "topic-b"] -> ADD_TOPIC (x2; each needs its own `id` plus `name`)
confidence: established        -> SET_METADATA_FIELD (`field`, `value`, and required `updatedAt`)
models: [...] / inputs: [...]  -> SET_METADATA_LIST_FIELD (`field`, `values[]`, `updatedAt`) — the scalar op cannot write lists
---
Content body                   -> SET_CONTENT
```

If "$ARGUMENTS" is provided, treat it as the path to import from.
