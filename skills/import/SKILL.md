---
name: import
description: Bulk import knowledge from external sources — markdown files, Obsidian vaults, Ars Contexta local vaults, or JSON data. Creates documents in correct folders with links preserved. Use when migrating an existing knowledge base to the vault.
---

# Bulk Import

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Import knowledge from external sources into the Knowledge Vault.

## Supported Sources

- **Markdown files** (with YAML frontmatter)
- **Obsidian vaults** (wiki links -> typed document links)
- **Ars Contexta local vaults** (full structure preservation)
- **JSON data** (array of note objects)

## Create in batches, not one call per document

`POST notes` creates up to 25 documents **and places them** in one request.
This is the difference between a fast import and a slow one: each create
dispatches its own `ADD_FILE` against the drive, and the reactor stores a full
JSON copy of the drive's state with every operation, so N creates re-serialise
the whole node list N times. Measured on a 1489-node drive: **4 documents took
5.02 s created one at a time, 1.41 s batched.**

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/notes" \
  -d '{"drive":"<UUID>","notes":[{"name":"slug","actions":[…]}]}'
```

Three properties of this route shape the whole import:

- **Never send `parentFolder`** — it is a hard 400 (`VAULT_LAYOUT`). Placement
  follows the document type, so notes land in `/knowledge/notes` by themselves.
  An import does not need a folder map for notes at all.
- **`documentType` is accepted** (default `bai/knowledge-note`), so MoCs and
  sources go through the same batch route, each placed by its own type.
- **A 400 means nothing was dispatched.** Every note's actions are linted up
  front, exactly so a lint failure halfway through cannot leave half a batch
  created.

The route verifies containment itself and **deletes what it created** if
placement fails — its stated invariant is that it never leaves the vault worse
than it found it. That is why this skill no longer carries a "verify drive
nodes and repair the missing ones" step: the orphan it used to repair is one
the route now refuses to produce.

### Read the result; do not infer it

Every note in the response carries `readBack` — `confirmed` (verified),
`unconfirmed` (dispatched but not read back: poll the job, do not re-send) or
`skipped` (no actions given) — plus the `name`, `parentFolder` and `path` **read
back from the drive**, never echoed from the request.

That last point has teeth on an import: **the drive renames on collision**, so a
note whose name already exists comes back under a different one. Key the
title→id map off the returned `id`, and reconcile duplicate titles *before* the
link pass — otherwise a `[[wiki link]]` resolves to whichever duplicate you
mapped last.

When an action was rejected, ask the job which one (stack ≥ 6.2.3-dev.10):

```bash
switchboard query '{ jobStatus(jobId: "<id>") { status result } }'
# result.allApplied is false when any action was rejected, and result.actions
# names each: {"kind":"reducer-error","message":"Description exceeds 200 characters"}
```

A rejected action costs only itself and the rest of the batch lands — so a note
arrives complete except for the one field that failed, and the job still reports
success. That is the failure mode to watch for across thousands of documents.

## Import Process

### Step 1 — Group imported *sources* under a folder

Only relevant when the import brings in source material (a book, a docs site,
an interview set), not when it brings in notes. A long source is expensive to
keep — every operation stores a full JSON copy of the document's state, so each
`ADD_EXTRACTED_CLAIM` on a book-sized source re-serialises the whole book — so
split it. Splitting then leaves twenty loose sources with nothing saying they
are one book, which is what the folder restores.

When one origin yields **three or more sources**, mint the folder once and give
every source the id it returns:

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/sources/folders" \
  -d '{"drive":"<UUID>","name":"Building the Knowledge Vault"}'
# -> { "id": "f-book", "path": "/sources/Building the Knowledge Vault", "created": true }

curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/sources" -d '{
  "drive": "<UUID>", "title": "Chapter 3 — Why atomicity",
  "content": "<chapter text>", "sourceType": "BOOK_CHAPTER", "parentFolder": "f-book"
}'
```

The route is idempotent on name within `/sources`, so a re-run of the import
returns the existing folder rather than a second one. **Fill every field on each
source** — the contract is in **seed** § *The ingest contract*, and an import is
where it is most often skipped. Two traps specific to importing:

- **A file's own date is `publishedAt`, not `createdAt`.** `createdAt` is when
  the document entered the vault — now. Putting the original's date there makes
  everything you just imported look years old to `knowledgeGraphRecent` and
  `knowledgeGraphStale`. A 24-chapter book import got this wrong on all 24.
- **Provenance is built when any of** `url`, `author`, `publishedAt`, `method`
  or `tool` is present (older reducers dropped `method`/`tool` alone). For an import, `url` is
  the source path or blob URL and `method` records how the text was extracted. `parentFolder` takes the
folder **id**, never a name — a name would make the server guess on every
ingest, and twenty chapters racing would mint several folders sharing one name.
A folder outside `/sources` is rejected with `FOLDER_OUTSIDE_VAULT_PATH`; a
drive that was never scaffolded gives `FOLDER_UNRESOLVED` (open it in the app
once). Grouping is navigation only — every source keeps its own fields, so
extraction, search and provenance are unchanged. See **seed** for the same
workflow one source at a time.

### Step 2 — First pass: create every document, no links

Batch 25 at a time. Notes need no folder lookup; give each one its full action
list so the document arrives complete in a single round trip.

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/notes" -d '{
  "drive": "<UUID>",
  "notes": [
    { "name": "<slug>", "actions": [
      { "type": "SET_TITLE",       "input": { "title": "…",       "updatedAt": "<ISO>" }, "scope": "global" },
      { "type": "SET_DESCRIPTION", "input": { "description": "…", "updatedAt": "<ISO>" }, "scope": "global" },
      { "type": "SET_CONTENT",     "input": { "content": "…",     "updatedAt": "<ISO>" }, "scope": "global" },
      { "type": "SET_NOTE_TYPE",   "input": { "noteType": "CONCEPT", "updatedAt": "<ISO>" }, "scope": "global" },
      { "type": "ADD_TOPIC",       "input": { "id": "<uuid>", "name": "<topic>" }, "scope": "global" },
      { "type": "SET_PROVENANCE",  "input": { "author": "…", "sourceOrigin": "IMPORT", "createdAt": "<ISO>" }, "scope": "global" }
    ] }
  ]
}'
```

**Valid `sourceOrigin`:** `DERIVED`, `IMPORT`, `MANUAL`, `SESSION_MINE`. For
bulk imports, `IMPORT`.

**Save the returned `id` per document** — see the collision note above — for
link resolution in Step 3.

<details><summary>Without the REST surface (CLI)</summary>

One document per call, and the create can time out leaving the document
unplaced, so verify against the tree afterwards:

```bash
switchboard docs tree <drive-slug> --format json   # folder map: "knowledge/notes" -> uuid
switchboard docs create --type bai/knowledge-note --name "<title>" --drive <drive-slug> \
  --parent-folder <notes-folder-uuid> --format json
switchboard docs apply <new-doc-id> --file /tmp/actions-<id>.json
```

Lint before dispatching: `node scripts/lint-actions.mjs /tmp/actions-<id>.json`.
It counts the description the way the reducer does (UTF-16 units) and rejects
invalid enums, each with its JSON path — the same checks `POST notes` runs
server-side.
</details>

### Step 3 — Second pass: resolve and create relationships

One call per edge — **`POST relationships` takes a single edge; there is no
batch form.** Look the target up in the title→id map, then:

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/relationships" \
  -d '{"source":"<note-id>","target":"<resolved-id>","type":"RELATES_TO",
       "reason":"<the sentence in the source note that made the link>","confidence":"established"}'
```

Edges are idempotent on `(source, target, type)`, so re-running an import is
safe — but a repeat never changes an existing reason. Use `PATCH relationships`
(or `switchboard docs annotate`) for that.

#### When the import carries no reasons

A bare `[[wiki link]]` says only that two notes touch. **Do not invent a
reason.** The articulation hook blocks a bare `RELATES_TO`, `BUILDS_ON`,
`CONTRADICTS`, `SUPERSEDES` or `DERIVED_FROM`; `CORE_IDEA` and `CHILD_MOC` are
always exempt.

To lift it for a bulk import, `POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1` must be
in **the environment Claude Code itself runs in** — `env` in `settings.json`, or
exported before launching:

```jsonc
// .claude/settings.json
{ "env": { "POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS": "1" } }
```

**An inline prefix does not work.** `POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1
switchboard docs link …` sets the variable for the `switchboard` child process,
but the hook is a *separate* process spawned before the command runs and reads
its own environment — so the link is still blocked. Two further limits: the
hatch covers only a **missing** `--reason`, so a short or placeholder one
(< 20 chars) still blocks; and it does not cover `docs annotate`.

The edges land with `reason: null`. `/health` counts them under LINK_HEALTH as
unarticulated coverage and `/connect` works through them later. **Report the
bare-edge count in the import summary** so the backlog is visible from day one.

### Step 4 — MoCs from the source's folders or tags (optional)

If a category, folder or tag holds 3+ notes, give it a MoC — the threshold
**synthesize** and **health** use. A MoC needs more than a document: create it,
then initialise it with `CREATE_MOC`, which carries the `tier` and the
`orientation` a reader arrives on.

```bash
switchboard docs apply <moc-id> --actions '[{
  "type": "CREATE_MOC",
  "input": {
    "title": "<topic name>",
    "description": "Map of Content for <topic> — N notes covering <brief scope>",
    "orientation": "<1–2 paragraphs: what this area is and how to read it>",
    "tier": "TOPIC",
    "createdAt": "<ISO>"
  }, "scope": "global" }]'
```

Then attach members and **attach the MoC itself to a parent**:

```bash
switchboard docs link <moc-uuid> <note-uuid> -t CORE_IDEA     # one per member note
switchboard docs link <parent-moc-uuid> <moc-uuid> -t CHILD_MOC
```

Membership lives in the relationship table, not in the MoC's state — the editor
renders only `CORE_IDEA` / `CHILD_MOC` edges as membership. Parentage is not
optional: 2+ TOPIC MoCs sharing a theme want a DOMAIN above them, and once the
vault has 2+ MoCs it needs its single HUB, with every parentless MoC hanging
off it. **An import that mints a hundred tier-less, parentless MoCs is worse
than one that mints none** — they are unreachable from the HUB and invisible to
the way readers browse. See **synthesize**.

### Step 5 — Verify and report

Report honestly, including what did not work:

- notes created, and how many came back `confirmed` vs `unconfirmed`
- links resolved — **articulated vs bare** — and links unresolved
- titles that collided and were renamed by the drive
- any action the job reported rejected (`result.allApplied: false`)
- orphan notes (no incoming edge) that need manual connection
- MoCs created, and whether every one is reachable from the HUB

## Markdown Frontmatter Mapping

```yaml
---
title: "Note Title"           -> SET_TITLE
description: "Summary"        -> SET_DESCRIPTION   # ≤ 200 chars, the only length limit in any model
type: pattern                  -> SET_NOTE_TYPE    # map to the enum: PATTERN, BUG_PATTERN, …
topics: ["topic-a", "topic-b"] -> ADD_TOPIC (x2; each needs its own `id` plus `name`)
confidence: established        -> SET_METADATA_FIELD      (`field`, `value`, required `updatedAt`)
models: [...] / inputs: [...]  -> SET_METADATA_LIST_FIELD (`field`, `values[]`, required `updatedAt`)
---
Content body                   -> SET_CONTENT
```

**Metadata field names are whitelisted — do not map arbitrary YAML keys.** An
unknown field throws (`InvalidMetadataFieldError` / `InvalidMetadataListFieldError`),
and because a rejected action is skipped while the rest of the batch applies and
the job still reports success, the loss is silent across a large import.

- **18 string fields** (`SET_METADATA_FIELD`): `scope`, `confidence`,
  `severity`, `editor`, `modelId`, `version`, `filePath`, `computes`,
  `context`, `decisionStatus`, `model`, `sourceType`, `targetType`,
  `relationType`, `cardinality`, `errorMessage`, `rootCause`, `correctPattern`
- **9 list fields** (`SET_METADATA_LIST_FIELD`): `models`, `hooksUsed`,
  `dispatchTargets`, `modules`, `inputs`, `outputs`, `consumedBy`,
  `alternatives`, `consequences`

Anything else from the source's frontmatter belongs in the note body, or
nowhere. The scalar op cannot write lists (`value: String`), and the list op
cannot write scalars.

## Wiki Link Resolution

```
For each [[target title]] in note content:
  1. Find the document id for that title in the title→id map (built from
     returned ids, reconciled for collisions)
  2. If found: POST relationships with the sentence around the link as `reason`
     (or bare, with the env var set as above, when the source gives no reason)
  3. If not found: log as unresolved — it may be an external reference
```

## Importing a git repository's docs (bundled script)

For a repository whose markdown files should become sources pinned to a release,
use `scripts/sync-repo-docs.mjs` rather than hand-driving the CLI. One source
per file, with provenance that says exactly which commit the text came from:

```bash
node scripts/sync-repo-docs.mjs \
  --endpoint <switchboard /graphql URL> --drive <uuid-or-slug> --profile <cli profile> \
  --repo <path to the checkout> --repo-url https://github.com/<org>/<repo> \
  --tag <release tag> --base-tag <previous tag> \
  --manifest manifest.json [--attribution attribution.json] \
  [--bump-version <string>] [--only <path substring>] [--workers 4] [--dry-run] \
  [--author <createdBy>] [--doc-author <provenance author>] [--out <run-log path>]
```

`--author` (default `repo-docs-sync`) is written as `createdBy` on every ingest;
`--doc-author` (default `Powerhouse Inc.`) is the `author` on source provenance;
`--out` (default `sync-repo-docs-${TAG}.json`) is the run log.

What it does per manifest entry: finds the existing source (by manifest id, by a
provenance URL ending in the same repo path, or by exact title) or creates one;
ingests the file at `--tag`; **and, when the file differs between the two tags,
ingests the base text first**, so the source's own operation log carries the
upstream diff as two revisions. A source whose stored `sha256` already matches
the tag is skipped, so re-runs are no-ops. Provenance: `url` = the blob at the
tag, `publishedAt` = the file's last upstream commit, `method` =
`sha256:<hash> git:<tag>`, `tool` = `sync-repo-docs`.

With `--attribution` it also wires existing notes to their backing file
(`DERIVED_FROM` with the reason naming the section, `ADD_EXTRACTED_CLAIM`,
`filePath` metadata), and with `--bump-version` it stamps the version **only on
notes whose file is unchanged between the two tags** — a note on a changed file
needs a reading, not a stamp.

Two rules the script encodes, both learned the hard way:

- **Only current docs.** Exclude archived trees (`docs/archive/`,
  `*-LEGACY.md`), generated benchmark fixtures and agent scratch files. An
  archived doc describes a version the code no longer has, and a source that
  claims to be current is worse than no source.
- **`DateTime` inputs must be UTC `Z` strings.** An offset form (`+02:00`) is
  accepted by the job and silently dropped by the reducer, leaving
  `publishedAt: null`. The script normalises every date through
  `new Date(x).toISOString()`.

A source with no notes yet is left **INBOX** on purpose: that is the visible
extraction backlog, and `/health` counts it.

## Automated Import Scripts

No bundled generic import script exists — `sync-repo-docs.mjs` is repo-specific
and `seed-source.mjs` takes one file. For large imports, drive the REST calls
above from your own script: batch 25 per `POST notes`, hold one connection open
rather than shelling out per document, and checkpoint the title→id map to disk
so a failure resumes instead of restarting.

If "$ARGUMENTS" is provided, treat it as the path to import from.
