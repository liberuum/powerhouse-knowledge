---
name: rest-api
description: The vault's REST HTTP API — every route, with the request and response shape. Use when reading or writing the vault over HTTP, when you need a route you have not used before, or when a call returns an error you do not recognise.
---

# Vault REST API

> **Target first.** Every call below runs against the Switchboard the active
> profile points at, and `<UUID>` means *that* server's vault drive. If the
> pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID`, use those.
> Otherwise run `switchboard config show` and the drive detection in AGENT.md
> § *Find the vault drive*.

## Connect

```bash
BASE=<origin>/api/@powerhousedao/knowledge-note    # origin from `switchboard config show`
curl -s -w '\n%{http_code}\n' "$BASE/ping"         # no token — is auth on?
```

| `ping` answers | Meaning | Do |
|---|---|---|
| `200`, `"user": null` | auth off | send no `Authorization` header |
| `401` | auth on | `TOKEN=$(switchboard auth token)` |
| `200`, `"user": "0x…"` | auth on, token valid | carry on |

```bash
AUTH="Authorization: Bearer $TOKEN"     # omit entirely when auth is off
curl -s -H "$AUTH" "$BASE/drives"       # read the id you want from the output
DRIVE=<the drive id>
```

Every route except `ping`, `drives` and `badge.svg` takes `?drive=$DRIVE`.

## Every route

`auth` is `renown` (bearer required when auth is on) unless stated.

### Read — notes and search

| Method | Route | Parameters | Returns |
|---|---|---|---|
| `GET` | `ping` | — | `{ ok, subgraph, user }` |
| `GET` | `drives` | — | `{ drives: [{ id, name, slug, nodes }] }`, knowledge-vault drives only |
| `GET` | `search` | `drive`, `q`, `mode=semantic` (the only mode), `limit` (≤25), `related` (default 10, max 50, `0` off), `content=1`, `includeArchived=1` | `{ query, mode, hits: [{ similarity, score, matchedBy, node }], related, links, expansion }` — **expansion is ON by default**; see below |
| `GET` | `notes/:id` | `drive` | `{ id, name, documentType, state, edges }` — **serves any document type**, not just notes: sources, the pipeline queue, the health report and the vault config all come back with full state |
| `GET` | `notes/:id.md` | `drive` | markdown with YAML frontmatter |
| `GET` | `notes/:id/similar` | `drive`, `limit` | semantic neighbours |
| `GET` | `notes/:id/links` | `drive` | forward edges, with reasons |
| `GET` | `notes/:id/backlinks` | `drive` | incoming edges, with reasons |
| `GET` | `notes/:id/connections` | `drive`, `depth` | BFS over outgoing edges |

### Read — the graph

| Method | Route | Parameters | Returns |
|---|---|---|---|
| `GET` | `stats` | `drive` | per-kind counts |
| `GET` | `density` | `drive` | edges per knowledge node |
| `GET` | `topics` | `drive` | the topic vocabulary with counts |
| `GET` | `topics/:name` | `drive` | notes carrying that topic |
| `GET` | `orphans` | `drive` | nodes with no incoming edge |
| `GET` | `triangles` | `drive`, `limit` (≤100, default 20) | synthesis opportunities |
| `GET` | `graph.json` | `drive` | `{ nodes, edges }` — the whole graph |
| `GET` | `embeddings/missing` | `drive` | ids with no embedding; should be `[]` |
| `GET` | `changes` | `drive`, `since` (required), `until`, `moc`, `topic`, `q`, `documentIds`, `types` (comma-separated), `limit` (default 50, max 200), `cursor` | what changed over a window: `{ window, scope, story, thenVsNow?, totals, groups, events?, nextCursor? }` — `story` leads; `Accept: text/markdown` for a report that opens with it. See [What changed](#what-changed) |

### Read — whole vault and status

| Method | Route | `auth` | Returns |
|---|---|---|---|
| `GET` | `llms.txt` | `renown-optional` | MoC index, plain text |
| `GET` | `llms-full.txt` | `renown-optional` | every canonical note; `includeDrafts=1` for non-archived too |
| `GET` | `health.json` | `renown` | the last health report |
| `GET` | `badge.svg` | **`public`** | `PASS`/`WARN`/`FAIL`/`UNKNOWN` as SVG |

### Read — privileged

| Method | Route | Needs | Returns |
|---|---|---|---|
| `GET` | `activity` | `canWrite` | audit log; `since`, `limit` |
| `GET` | `notes/:id/history` | `canWrite` | that note's operations, with signer |
| `GET` | `bridges` | `canWrite` | articulation points — notes whose removal would split the graph (Tarjan, O(V+E)) |
| `GET` | `access-map` | `canManage` | grants and protections |

### Write

| Method | Route | Body | Returns |
|---|---|---|---|
| `POST` | `actions` | `{ documentId, actions[], wait?, allowLiteralEscapes? }` | `{ revision, operations, readBack, jobId }`; `202 { jobId }` when `wait:false` |
| `POST` | `notes` | `{ drive, documentType?, notes: [{ name, actions? }] }` (≤25) | `201 { drive, parentFolder, notes[] }` |
| `POST` | `sources` | `{ drive, title, content, sourceType?, description?, author?, url?, publishedAt?, method?, tool?, queue?, parentFolder? }` | `201 { id, parentFolder, path, status, readBack, task? }` |
| `POST` | `sources/folders` | `{ drive, name }` — one folder, no `/` in the name | `{ id, name, path, created }`; idempotent on name within `/sources` |
| `POST` | `relationships` | `{ source, target, type, reason?, confidence? }` | `{ revision, operations, readBack, jobId }` |
| `PATCH` | `relationships` | same — replaces `reason`/`confidence` | same |
| `DELETE` | `relationships` | `{ source, target, type }` | same |
| `POST` | `tasks/:id/claim` | `drive`; `{ assignedTo? }` | `{ taskId, assignedTo }`; `409` if already assigned |
| `POST` | `admin/reindex` | `drive`; needs `canManage` | `{ indexedNodes, indexedEdges, errors }` |
| `POST` | `admin/backfill-source-history` | `drive`, `scope` (`sources` default, or `all`); needs `canManage` | `{ sources, documents, inserted, skipped, errors }` — once per vault indexed before change history; `scope=all` also refills every indexed document's global history; idempotent |

## Search returns the graph around its results

`GET search` expands its hits by one hop **by default**, so a single call
tells you not just which notes match but what they connect to and how. Most
of what the vault knows about a question is in the edges, not the ranking.

```jsonc
{
  "hits":  [ { "similarity": 0.96, "node": { … } } ],
  "related": [                      // ranked nodes ONE link from the hits
    { "documentId": "…", "title": "…", "description": "…", "noteType": "CONCEPT",
      "hitCount": 3,                // how many hits point at it — convergence is signal
      "via": [ { "from": "<hit>", "to": "<this>", "linkType": "BUILDS_ON",
                 "reason": "…", "confidence": "grounded" } ] }
  ],
  "links": [ … ],                   // edges BETWEEN the hits
  "expansion": { "hops": 1, "relatedTotal": 105, "relatedShown": 10, "truncated": true }
}
```

- `via` is written **source → target**, so there is no direction to decode.
- **A `CONTRADICTS` or `SUPERSEDES` in `via` is a finding.** It means a hit is
  disputed or stale — say so and cite both sides. The markdown rendering puts
  a `**Caution:**` line above the list when any are present.
- `related=0` turns expansion off; max 50.
- `Accept: text/markdown` renders the whole thing — hits, how they connect to
  each other, and the related notes with the edge that reached each one — as
  a digest meant to be read directly.

## What changed

`GET changes` answers "what changed in X since Y" from the vault's operation
history — never answer that with search, which ranks by meaning and ignores
time. Any reader of the drive may call it.

- **Window.** `since` is required; `until` defaults to now. ISO dates, UTC: a
  date alone for `since` starts at 00:00Z, for `until` covers that whole day.
- **The story leads.** `story` says what the vault knows now that it did not
  before. `story.growth`: live notes `notesThen → notesNow`, `newAreas`,
  `newMaps` (`{ id, title, area }`). `story.areas`: the hub's main areas (its
  `CHILD_MOC` maps; a note belongs to an area when the area's map tree holds it
  as a `CORE_IDEA`) with any change, most changed first, `id: null` =
  Elsewhere last — each with `notesThen`/`notesNow`, the uncapped counts
  `newCount`, `changedCount`, `retiredCount` (the lists below are capped: say
  "and N more" from these), `mergedCount` (supersessions that merged twin
  notes — near-identical titles, or a reason saying twin / duplicate / same
  claim / merged: housekeeping, counted and never listed as changed),
  `versions { first, now }` when the area's sources carry `git:` refs (the ref
  standing at `since`, else first ingested → the latest: "first recorded at
  v6.2.2-dev.74, now v6.2.3-dev.91+e0f277d"), `newClaims` (≤ 8, most connected first; a note
  that replaced another is that shift's `now`, never also new), `changedClaims` (≤ 8: `{ documentId, then { claim, gist },
  now { claim, gist }, why, replacedBy?, thenAt? }` — a revised
  title/description with its `## Revision history` line as `why`, or a
  superseded note with its replacement and the SUPERSEDES reason; a note
  *created* in the window and revised after its creating batch is a shift
  from its **first recorded** state (title/description as last written within
  an hour of its creation), `thenAt` saying when — and it is also listed as
  new; a version stamp alone is never a shift) and `retiredClaims` (≤ 5: archived in the window, still archived,
  never replaced). A shift whose `then.claim` equals `now.claim` changed its
  description: tell it by the gists. A claim is
  `{ documentId, claim (the title), gist (the description) }`.
- **Then vs now.** With `q=` or `topic=` the answer adds `thenVsNow { then,
  now, unchanged }` (≤ 12 each): `then` — the scope's claims as they stood at
  `since` (notes that existed and were not archived or superseded then, with
  their then-titles) that read differently now or are gone; `now` — today's
  claims that read differently at `since` or are new; `unchanged` — claims held
  in the same words throughout, listed once. A note created in the window and
  revised since puts its first recorded claim on `then`, with `thenAt`. That answers "how did X work then,
  and how does it work now". "Now" is always the current state, even with a
  past `until`: for two past dates, answer from `events`.
- **Cursor pages** carry no `story` and no `thenVsNow` — the first page did.
- **Scope the whole vault unscoped.** When the subject is the vault as a whole
  or its main subject (the hub's title — "the Powerhouse stack" in a
  Powerhouse vault), call without `moc`, `topic` or `q`: a `q` cuts it down to
  a handful of notes.
- **Writing the answer.** Lead with the story, for a reader who is not
  technical: how the vault grew, what is new per area, what is now understood
  differently (then → now, because …), where to look next. Keep ids and
  operation counts out of the prose — cite claims as `[[documentId]]`.
- **Totals and groups** are the plumbing beneath it: `totals` (created,
  revised, superseded, archived, reverified notes; `sourcesRevised`,
  `sourcesAdded`; `documents`, `operations`) and `groups` — one per map of
  content (else topic, else `unplaced`), each with its own totals and up to
  five `highlights`. Groups are never paged.
- **Drill down.** Add a scope — `moc=<map id>` (an area's `id` from
  `story.areas`, or a group's `id`; Elsewhere, `id: null`, is no map — use
  `q=` for it; the scope includes its
  child maps, their notes and those notes' sources), `topic=`, `q=<words>`
  (a `q` that names a main area or a map below it — whole words,
  case-insensitive, plurals folded — scopes to that map; otherwise the top 25
  semantic hits plus their one-hop neighbours; `scope.resolved` says which:
  `{ kind: "moc", id, title }` or `{ kind: "search", query, hits }` — say what
  you covered) or `documentIds=` — and
  the answer adds `events`, most significant first, paged by `limit` and
  `cursor=<nextCursor>`. A cursor keeps its window: pass it with the same
  `since`; leaving `until` out then continues the same window, not one ending
  "now". A cursor the endpoint did not issue is a 400.
- **Events.** `created` (with `derivedFrom`), `revised` (`fields.title` /
  `fields.description` as `before → after`, `before: null` when not set
  before; `fields.content` as diff `hunks` with `added`/`removed` line counts
  and the earlier text's first 400 characters in `before`;
  `revisionNotes` from a `## Revision history` section), `superseded`
  (`supersededBy { documentId, title, reason }`), `archived`, `restored`,
  `approved`, `reverified` (a `version` stamp with no claim change),
  `source-added`, `source-revised` (`source { refBefore, refAfter, added,
  removed, hunks, noteIds, noteCount }` — the git refs come from the source's
  `method`; `noteIds` lists the first 20 of `noteCount` notes; `added` and
  `removed` are `null` when the earlier text was never recorded — say "earlier
  version not recorded", never "unchanged"),
  `source-archived`. Other operations are counted in `folded`, not listed.
- **Empty.** `totals.documents: 0` and `groups: []` means nothing changed in
  that window — say so; do not fill the gap from search.

```bash
# the story since a date
curl -s -H "$AUTH" "$BASE/changes?drive=$DRIVE&since=2026-09-01" | jq '.story'

# then vs now for a subject
curl -s -H "$AUTH" "$BASE/changes?drive=$DRIVE&since=2026-09-01&q=processor%20delivery" | jq '{thenVsNow, shifts: [.story.areas[].changedClaims[]]}'

# one map, as a readable report
curl -s -H "$AUTH" -H 'accept: text/markdown' "$BASE/changes?drive=$DRIVE&since=2026-09-01&moc=$MOC"

# a subject in words: what did it resolve to?
curl -s -H "$AUTH" "$BASE/changes?drive=$DRIVE&since=2026-09-01&q=processors&limit=20" | jq '.scope.resolved'
```

Source revisions enter the history from the release that records them. On a
vault indexed before that, a manager runs
`POST admin/backfill-source-history?drive=$DRIVE&scope=all` once: it records
each source's ingestions and refills the first operations of every note the
older index dropped (without them a revision reads its earlier title as "not
set before"). Until then re-ingested sources show without their earlier ref
and line counts.

## Examples

```bash
# search: hits plus the connected notes, as JSON
curl -s -H "$AUTH" "$BASE/search?drive=$DRIVE&q=how+does+sync+work&limit=6&related=8&content=1"

# the same as a markdown digest — the most useful form if you are answering
curl -s -H "$AUTH" -H 'accept: text/markdown' "$BASE/search?drive=$DRIVE&q=how+does+sync+work&limit=4"

# ranking only, no expansion
curl -s -H "$AUTH" "$BASE/search?drive=$DRIVE&q=how+does+sync+work&limit=6&related=0"

# a note and its edges, one call
curl -s -H "$AUTH" "$BASE/notes/$ID?drive=$DRIVE"

# write actions to a document
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/actions" -d '{
  "documentId": "'"$ID"'",
  "actions": [
    {"type":"SET_TITLE","input":{"title":"A claim, as a sentence","updatedAt":"2026-09-14T12:00:00.000Z"}},
    {"type":"SET_DESCRIPTION","input":{"description":"<= 200 characters","updatedAt":"2026-09-14T12:00:00.000Z"}}
  ]}'

# ingest a source — content only, the API files it
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/sources" -d '{
  "drive": "'"$DRIVE"'", "title": "…", "content": "…", "sourceType": "ARTICLE"}'

# create notes in a batch
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/notes" -d '{
  "drive": "'"$DRIVE"'",
  "notes": [{"name":"note-slug","actions":[
     {"type":"SET_TITLE","input":{"title":"…","updatedAt":"2026-09-14T12:00:00.000Z"}}]}]}'

# an articulated link
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/relationships" -d '{
  "source":"'"$A"'","target":"'"$B"'","type":"BUILDS_ON",
  "reason":"A extends B's claim about X to Y","confidence":"grounded"}'
```

## Reading the response

**`readBack`** is on every synchronous write.

| Value | Meaning |
|---|---|
| `confirmed` | the actions were found in the operation log; `operations[]` describes them |
| `unconfirmed` | the write **was dispatched** but could not be read back. Do not retry — poll `jobId` or re-read the document |
| `skipped` | `wait: false`; nothing was checked |

**Status codes.**

| Code | Meaning |
|---|---|
| `400` | the request was refused and **nothing was dispatched** — `details[]` carries the JSON path of each problem |
| `401` | auth is on and the token is missing or invalid |
| `403` | you lack the permission the route needs |
| `404` | no such document or task |
| `409` | the task is already assigned |
| `422` | the reactor refused the dispatch |
| `502` | a create failed and **everything it created was deleted**. If the body says `Rollback INCOMPLETE`, `details[].orphaned` lists the ids that survived |

## Rules the API enforces

You do not need to remember these — the API returns `400` with the offending
path — but knowing them saves a round trip.

- **Envelope fields are optional.** `id`, `timestampUtcMs` and `scope` are
  generated when absent. Supply them and they are checked: `id` a UUID unique
  within the batch, `timestampUtcMs` an ISO instant, `scope` one of `global`,
  `local`, `document`, `auth`.
- **Unknown body fields are rejected**, listing the allowed ones.
- **Placement is the API's job.** `POST notes` rejects `parentFolder`;
  documents go to the folder their type belongs in. `POST sources` is the one
  exception — its `parentFolder` may name a folder **within `/sources`**, so a
  book's chapters stay one book. Mint it with `POST sources/folders` and pass
  the id it returns; anything outside `/sources` is rejected with
  `FOLDER_OUTSIDE_VAULT_PATH`.
- **Knowledge edges need a reason.** `RELATES_TO`, `BUILDS_ON`, `CONTRADICTS`,
  `SUPERSEDES` and `DERIVED_FROM` require a specific `reason`; `CORE_IDEA` and
  `CHILD_MOC` may be bare.
- **A note's description is ≤ 200 characters.** It is the only length limit in
  any model.
- **One batch is fine.** Actions run in order; a rejected one is skipped and
  the rest land. Read back to confirm.

## What REST does not do

Deleting a document, reading the drive tree, and profiles/sign-in are CLI only
— see **cli-reference**. Raw GraphQL is read-only for vault work.

**The one gap that blocks a pure-REST pipeline: document id discovery.** Every
write route addresses a document by id, and nothing over REST lists a drive's
contents — `GET drives` returns a node **count**, not a node list, and
`stats` / `graph.json` cover only the seven indexed types, which exclude the
pipeline queue and the health report. So the singleton ids must be learned once
per drive with `switchboard docs tree`. After that the whole pipeline is REST:
`GET notes/<queue-id>` reads the queue, and `POST actions` drives `ADVANCE_PHASE`,
`GENERATE_REPORT` and `ADD_CHECK` — all twelve vault document types are in the
REST lint registry, so none of them is rejected as unknown.
