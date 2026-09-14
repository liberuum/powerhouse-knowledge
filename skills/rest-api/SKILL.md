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
DRIVE=$(curl -s -H "$AUTH" "$BASE/drives" | python3 -c 'import json,sys;print(json.load(sys.stdin)["drives"][0]["id"])')
```

Every route except `ping`, `drives` and `badge.svg` takes `?drive=$DRIVE`.

## Every route

`auth` is `renown` (bearer required when auth is on) unless stated.

### Read — notes and search

| Method | Route | Parameters | Returns |
|---|---|---|---|
| `GET` | `ping` | — | `{ ok, subgraph, user }` |
| `GET` | `drives` | — | `{ drives: [{ id, name, slug, nodes }] }`, knowledge-vault drives only |
| `GET` | `search` | `drive`, `q`, `mode=semantic` (default choice) `\|hybrid`, `limit` (≤25), `content=1`, `includeArchived=1` | `{ query, mode, hits: [{ similarity, score, matchedBy, node }] }` |
| `GET` | `notes/:id` | `drive` | `{ id, name, documentType, state, edges }` |
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
| `GET` | `bridges` | `canManage` | articulation points (O(V·E)) |
| `GET` | `access-map` | `canManage` | grants and protections |

### Write

| Method | Route | Body | Returns |
|---|---|---|---|
| `POST` | `actions` | `{ documentId, actions[], wait?, allowLiteralEscapes? }` | `{ revision, operations, readBack, jobId }`; `202 { jobId }` when `wait:false` |
| `POST` | `notes` | `{ drive, documentType?, notes: [{ name, actions? }] }` (≤25) | `201 { drive, parentFolder, notes[] }` |
| `POST` | `sources` | `{ drive, title, content, sourceType?, description?, author?, url?, publishedAt?, method?, tool?, queue? }` | `201 { id, parentFolder, path, status, readBack, task? }` |
| `POST` | `relationships` | `{ source, target, type, reason?, confidence? }` | `{ revision, operations, readBack, jobId }` |
| `PATCH` | `relationships` | same — replaces `reason`/`confidence` | same |
| `DELETE` | `relationships` | `{ source, target, type }` | same |
| `POST` | `tasks/:id/claim` | `drive`; `{ assignedTo? }` | `{ taskId, assignedTo }`; `409` if already assigned |
| `POST` | `admin/reindex` | `drive`; needs `canManage` | `{ indexedNodes, indexedEdges, errors }` |

## Examples

```bash
# search, with note bodies
curl -s -H "$AUTH" "$BASE/search?drive=$DRIVE&q=how+does+sync+work&mode=semantic&limit=6&content=1"

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
- **Placement is the API's job.** `POST notes` and `POST sources` reject
  `parentFolder`; documents go to the folder their type belongs in.
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
