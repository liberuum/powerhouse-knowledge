---
name: synthesize
description: Create Maps of Content (MOCs) from topic clusters in the knowledge graph. Groups notes by shared topics, creates bai/moc documents with core ideas, orientation, and tensions. Use after extraction to organize growing knowledge.
---

# Synthesize — Maps of Content

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

A MoC is an attention-management device: the first thing a reader or agent
meets in a topic, telling them what the cluster claims, where it disagrees and
where to start — so they read three notes instead of thirty. Building one has
three phases and only the first can be automated: **Dump** (gather every
candidate note), **Lump** (group them and write, for each, *why* it belongs),
**Jump** (write the orientation: what the cluster agrees on, where it is in
tension, what is still open). A MoC that is a list of titles has skipped Lump
and Jump. It is an address book, and a reader who trusts it learns nothing.

Run this in the **reweave** phase of a pipeline task, after connect; or
standalone when a topic has grown or `/health` reports a hierarchy defect.

## Process

### 1. Dump — read the clusters and the hierarchy (three calls, not N)

```bash
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'                       # topics with 3+ notes are MoC candidates
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "<topic>") { documentId title noteType status } }'
switchboard query '{ mocs: knowledgeGraphNodesByStatus(driveId: "<UUID>", status: "MOC") { documentId title noteType }
                     edges: knowledgeGraphEdges(driveId: "<UUID>") { sourceDocumentId targetDocumentId linkType reason } }'
# noteType is "MOC (HUB)" / "MOC (DOMAIN)" / "MOC (TOPIC)"; CHILD_MOC edges are the tree, CORE_IDEA edges are membership
# the HUB is the one MoC with no incoming CHILD_MOC edge
```

Widen the net past the topic name: `knowledgeGraphSimilar` on two or three
members finds notes that belong to the cluster under a different vocabulary.
**A MoC already exists for the theme? Update it** (steps 2–4 on the existing
document). Never create a second.

### 2. Create — every field in one `CREATE_MOC`

MoCs live in `/knowledge/` (not `/knowledge/notes/`):

```bash
switchboard docs create --type bai/moc --name "<topic>" --drive <drive-slug> --parent-folder <knowledge-folder-uuid> --format json
switchboard docs apply <moc-id> --actions '[{"type":"CREATE_MOC","input":{
  "title":"<the territory, as a reader would name it>",
  "description":"<one or two sentences: what the map covers and roughly how much>",
  "orientation":"<the synthesis — see below>",
  "tier":"TOPIC","createdAt":"<ISO>"},"scope":"global"}]'
```

| Field | Rule |
|---|---|
| `title` | Name the territory, not the first note in it |
| `description` | For the picker and sidebar. `Nine notes on how the reactor projects documents into read models.` No length limit anywhere on a MoC |
| `orientation` | **The MoC.** The indexer projects it as the node's `content` — the only MoC text full-text search matches and the embedding is built from. A MoC without one cannot be found by what it is about, and a reader who opens it learns nothing the title did not say |
| `tier` | `HUB` / `DOMAIN` / `TOPIC`. **Only `CREATE_MOC` writes it.** Changing tier means re-dispatching `CREATE_MOC`, which overwrites title, description, orientation, `parentRef` **and `createdAt`** — resend the originals |
| `createdAt` | Now; copied into `updatedAt` |
| `version` | The **only** field `SET_METADATA_FIELD` accepts; anything else throws `InvalidMetadataFieldError` |
| `coreIdeas[]`, `childRefs[]`, `parentRef`, `noteCount` | Legacy state. **Do not write them.** The indexer derives nothing from them; membership and hierarchy are edges. `ADD_CORE_IDEA` bumps `noteCount` and changes nothing anyone sees; `REORDER_CORE_IDEAS` replaces the array with only the ids passed |
| `agentNotes[]` | No operation writes it |

**Orientation — the Jump phase.** Two to four paragraphs, naming notes by title:

- what territory this covers and where its edges are — what is *not* here;
- the two or three things the cluster agrees on, **stated**, not listed;
- where the notes disagree and what is still open;
- a reading order — which note first, and why; which pair together make an argument; which note looks relevant and is a dead end.

The last item is the navigation intuition an agent loses at every session
boundary; the orientation is the only place in this model to keep it. Later
edits: `UPDATE_ORIENTATION` / `UPDATE_DESCRIPTION { …, updatedAt }` with the real
time of the edit.

### 3. Lump — membership with a context phrase

```bash
switchboard docs link <moc-id> <note-id> -t CORE_IDEA \
  --reason "<why this note anchors this map — what it settles or what following it gets you>"
```

Give every `CORE_IDEA` edge a reason. The hook allows a bare one (membership is
the type's meaning) and the methodology does not: the context phrase is what
lets a reader commit to a branch without opening the note, it is where the
grouping judgment gets recorded, and the MoC editor and sidebar show it beside
the title. A phrase that restates the title ("about read models") fails for the
same reason a paraphrased description does. Since 1.0.36 this is the old
`contextPhrase`, now on the edge where the graph can read it.

### 4. Place it in the tree

| Tier | Holds | Size | Parent |
|---|---|---|---|
| `TOPIC` | a focused cluster of notes | 3–9 notes | a `DOMAIN`, or the HUB if no domain fits |
| `DOMAIN` | its own notes plus `CHILD_MOC` TOPIC MoCs | 10+ notes, or 2+ topic MoCs | the HUB |
| `HUB` | the vault's single entry point: `CHILD_MOC` to every DOMAIN and to any TOPIC without a domain | one per vault | — |

Apply in order, every run:

1. Topic with 3+ notes and no MoC → TOPIC MoC, every member a `CORE_IDEA`.
2. **MoCs that belong together → a DOMAIN.** Two or more TOPIC MoCs share a broader theme when their members overlap (notes that are a `CORE_IDEA` of both), when knowledge edges run between their member sets, or when `knowledgeGraphSimilar` on one MoC returns the other — count these from the edges you already fetched; do not guess from titles. A topic past ~10 notes is a DOMAIN on its own. Create the DOMAIN (or promote a TOPIC by re-dispatching `CREATE_MOC` with tier `DOMAIN`), name it for the theme the children share, and `CHILD_MOC` the topics under it.
3. **2+ MoCs and no HUB → create the HUB, in the same run.** It is the vault's single entry point, so it takes a `CHILD_MOC` edge to **every** parentless MoC — every DOMAIN, and every TOPIC that fits no domain. Title = the vault's subject. Orientation = how the maps relate: which domains divide the territory, which ones interlock (shared members, cross-edges) and what the overlap is about, and where a reader should start. Two MoCs and no HUB is two roots — already the defect.
4. **Attach every MoC you created to a parent in the same run.** A MoC unreachable from the HUB is the defect this step exists to prevent.

Two MoCs that relate but do not nest — a TOPIC in one DOMAIN whose members keep citing a TOPIC in another — are connected in prose: name the other map in each orientation and say what following it gets you (the MoC editor renders only `CHILD_MOC` and `CORE_IDEA`, so a lateral edge would reach no reader). A note that is a `CORE_IDEA` of two maps is the graph's own record of that relationship — an integration point, not a duplicate; leave it.

```bash
switchboard docs link <parent-moc-id> <child-moc-id> -t CHILD_MOC \
  --reason "<what this child covers within the parent — the phrase a reader picks the branch by>"
# verify: every MoC except the HUB has exactly one incoming CHILD_MOC edge
switchboard query '{ knowledgeGraphEdges(driveId: "<UUID>") { sourceDocumentId targetDocumentId linkType } }' --format json \
  | python3 -c "import json,sys; e=[x for x in json.load(sys.stdin)['data']['knowledgeGraphEdges'] if x['linkType']=='CHILD_MOC']; print(len(e),'CHILD_MOC edges;',len({x['sourceDocumentId'] for x in e}),'parents')"
```

### 5. Tensions and open questions

Do not hand-write tensions. Record a contradiction on the edge
(`docs link <a> <b> -t CONTRADICTS --reason "…"`); the indexer opens the
`bai/tension` and adds the `ADD_TENSION` entry (id = the tension's document id)
to every MoC that holds either note as a `CORE_IDEA`. The connect skill says how
to read it back and articulate it. Manual `ADD_TENSION` is the fallback for an
edge the automation never saw (imported, replayed, older Switchboard) — it does
not dedupe.

Record an open question for every direction the cluster leaves unexplored and
every decision that is not yours to make:

```bash
switchboard docs mutate <moc-id> --op addOpenQuestion --input '{"question":"<what this topic has not answered yet>"}'
```

Questions are plain strings. `REMOVE_OPEN_QUESTION` takes `{"question":"<exact
text>"}` and matches by string equality — one character off removes nothing and
reports success; a question added twice is stored twice. Write it once, in its
final wording.

### 6. Keep the map current — a stale MoC is worse than none

Without a MoC an agent falls back to search, which sees current content. With a
stale one it trusts the map, never looks past it, and reasons inside
yesterday's topology — nothing in the output shows the gap. Every run that
touches a topic:

- add the new notes as `CORE_IDEA` with context phrases; every note carrying the topic should be a member (**coverage**);
- re-read the orientation and ask *what would be different if I wrote this today?* — a new agreement, a new disagreement, a changed reading order → `UPDATE_ORIENTATION`. The HUB included: a new DOMAIN changes how the territory divides;
- split when a TOPIC outgrows its tier or two sub-clusters emerge; merge two small MoCs that overlap; archive is not an operation the model has — leave a MoC with no members out of the tree and say so in `/health`.

### 7. Verify

Read the drive tree and confirm each MoC exists as a `bai/moc` node; read the
edges back for membership and hierarchy. Report the hierarchy from what you
read, not from what you dispatched.

## Output

```
=== MOC SYNTHESIS ===
Clusters: N | MoCs created: N | updated: N | CORE_IDEA edges added: N (all with reasons)
HUB  Powerhouse Ecosystem — 18 child MoCs (1 new)
  DOMAIN  Editors and UX — 19 notes, 2 child MoCs
    TOPIC  Document Toolbar Styling — 5 notes
Roots: 1 (the HUB) | Unreachable MoCs: 0 | Open questions added: N
```

In a pipeline run this is part of the **reweave** handoff. Note that `/health`'s
`MOC_COHERENCE` grades **notes without topics**, not clusters without a MoC —
tagging moves it, creating MoCs does not; MoC coverage and reachability are
reported separately.

If "$ARGUMENTS" is provided, focus on that specific topic.
