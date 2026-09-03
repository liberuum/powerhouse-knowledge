---
name: connect
description: Find connections between knowledge notes and create links. Use after extracting notes, when exploring relationships, or when a topic needs synthesis.
---

# Connect Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Find genuine connections between notes and create typed links. This is the "reflect" phase — the step that transforms isolated claims into a knowledge graph.

## Connection discovery process

1. **Identify the target note** — which note are we connecting?
2. **Search for candidates** using multiple strategies:
   - `knowledgeGraphSimilar(documentId)` — AI-powered semantic similarity (finds conceptually related notes even without keyword overlap)
   - `knowledgeGraphSemanticSearch(query, mode: SEMANTIC)` — semantic search from the note's core claim phrased as a question (pkg ≥ 1.0.50; falls back to keyword transparently)
   - `knowledgeGraphRelatedByTopic(documentId)` — notes sharing the most topics
   - `knowledgeGraphSearch(query)` — keyword search on title + description
   - `knowledgeGraphFullSearch(query)` — full-text search; ANDs terms, so use 1-2 keywords
3. **Apply the articulation test** — for each candidate, answer: "[[A]] connects to [[B]] because [specific reason]". The sentence you write here IS the edge's `--reason` in the next step; if you cannot write it, there is no link.
4. **If the connection is genuine**, create the edge with `docs link --reason`. Since the drive-override migration, edges live in the reactor's `DocumentRelationship` table (one row per ADD_RELATIONSHIP system action) — not in the source note's `links[]` array. The legacy `--op addLink` writes to the old per-doc array and is **not** indexed by the graph subgraph.

```bash
switchboard docs link <source-uuid> <target-uuid> -t BUILDS_ON \
  --reason "<A> extends <B>'s claim that X holds for one read model to every read model" \
  --confidence established
```

**The reason lives on the edge.** `--reason` (CLI ≥ 1.0.36) is stored as
relationship metadata and comes back on every edge read
(`knowledgeGraphEdges { reason confidence }`, the Links panel, the sidebar's
Connections list, the chat's `linked_notes`); `/health` reports the share of
knowledge edges that carry one. The pre-write hook **blocks** a `RELATES_TO`,
`BUILDS_ON`, `CONTRADICTS`, `SUPERSEDES` or `DERIVED_FROM` link without a
real one (≥ 20 chars; not the type name, not "because"). Write it as the
specific sentence you would give a reader — name the claim, not the titles.
`--confidence` says how well-founded the link is: `grounded` (evidence or a
source backs it), `established` (well accepted, not evidenced here),
`speculative` (a lead worth recording). `CORE_IDEA` / `CHILD_MOC` edges have
no reason to give — their meaning is the type.

**Existing bare edges** (created before 1.0.36, or by an import) are the
backlog this skill works through: `knowledgeGraphForwardLinks` returns
`reason: null` for them. Articulate each one in place — a repeated
`docs link` is a no-op, metadata included:

```bash
switchboard docs annotate <source-uuid> <target-uuid> -t RELATES_TO \
  --reason "…" --confidence grounded
```

If you cannot articulate an existing edge after reading both notes, that is
the finding: `docs unlink` it rather than invent a sentence.

`docs link` sends the `ADD_RELATIONSHIP` action **signed as you**
when the profile has a signing identity (`switchboard auth login --renown` —
the plugin's pre-write hook requires it), so the edge is attributable like any
other agent write: the vault shows `powerhouse-knowledge` acting for your
address. The raw `addRelationship` GraphQL mutation builds the action
server-side, cannot carry a reason and is always signed by the Switchboard's
own identity; the hook steers you away from it. Idempotent on
`(source, target, type)`.

To remove an edge: `switchboard docs unlink <source-uuid> <target-uuid> -t RELATES_TO`.

**Quote a reason that starts with a dash.** `--reason "--base is baked into the
bundle"` is parsed as an unknown flag and the command fails. Use the attached
form — `--reason=--base is baked into the bundle` — or reword the sentence so it
does not open with a dash.

## Link types

- **RELATES_TO** — general thematic connection
- **BUILDS_ON** — this note extends or strengthens the target
- **CONTRADICTS** — this note challenges or conflicts with the target
- **SUPERSEDES** — this note replaces the target (newer/better understanding)
- **DERIVED_FROM** — this note was extracted or derived from the target

## Methodology cross-reference

After connecting notes to each other, **search the local methodology files** for research backing. The 249 Ars Contexta research claims are bundled with the plugin in `data/methodology/*.md` — they are **not** stored in the remote vault.

1. For each new note, search the local methodology files by topic and keywords:
```bash
# Search methodology files by keyword (from the plugin directory)
grep -rl "<keyword from note>" data/methodology/*.md
```

Or use the Grep tool to search file contents and the Glob tool to list all `data/methodology/*.md` files. Each file has YAML frontmatter with `description`, `topics`, and `methodology` fields that help match against the note.

2. For each matching claim, **record the methodology reference in the note's content** rather than creating a document link (since the claim has no remote document ID):

Add a "Methodology grounding" section to the note's content via `SET_CONTENT`:
```markdown
## Methodology grounding
- **[[claim title]]** — how this note relates to the claim (BUILDS_ON / CONTRADICTS / RELATES_TO)
```

```bash
switchboard docs mutate <note-id> --op setContent --input '{
  "content": "<existing content + methodology grounding section>",
  "updatedAt": "<ISO>"
}'
```

**Relationship types for methodology:**
- `BUILDS_ON` — note implements or validates the research claim
- `CONTRADICTS` — note's findings challenge the methodology claim
- `RELATES_TO` — thematic connection without direct support/conflict

**Why this matters:** Cross-referencing grounds working knowledge in the methodology foundation. The claims live locally as plugin reference data — the agent reads them directly from disk, which is faster and requires no remote import step.

## Tension detection

**The indexer opens tensions for you.** Since the graph-indexer automation
(vault package ≥ 1.0.55), every `CONTRADICTS` edge that lands on the
Switchboard makes the server create a `bai/tension` in `/ops` — a short
title (`Contradiction on <shared topics or words>`), both claims in full in
the description, `involvedRefs [a, b]`, `observedBy: graph-indexer` — and add an
`ADD_TENSION` entry (id = the tension's document id) to every MoC that holds
either note as a `CORE_IDEA`. One tension per unordered pair, ever: a pair
that already has a tension (any status) is left alone.

So after creating a CONTRADICTS link, **do not create a tension by hand**.
Instead, within a couple of seconds:

```bash
# The tension the indexer opened for this pair (INVOLVES edges point at both notes)
switchboard query '{ knowledgeGraphBacklinks(driveId:"<UUID>", documentId:"<note-a>") { sourceDocumentId linkType } }'
# → the INVOLVES source is the tension id. Read it:
switchboard docs get <tension-id> --state --format json
```

Then **articulate it** — this is the part only you can do. The automation
knows the two titles; you know why they conflict. The tension model has no
content-update operation after `CREATE_TENSION`, so the articulation goes
where readers meet it: append a short **"Contradicts"** paragraph to each
note's content naming the other note and the specific point of conflict
(`SET_CONTENT` on each note, whole body, real newlines). If more notes are
party to the same disagreement, add them to the tension:

```bash
switchboard docs mutate <tension-id> --op addInvolvedRef --input '{"ref":"<note-id-3>"}'
```

If the contradiction turns out NOT to be substantive (different wording, or
both true in different scopes), **dissolve** the tension with the reason:

```bash
switchboard docs mutate <tension-id> --op dissolveTension --input '{"resolution":"<why both hold>","resolvedAt":"<ISO>"}'
```

**A tension is for an unresolved knowledge conflict, not for a known bug.**
The commonest reason a vault sits at FAIL on THREE_SPACE_BOUNDARIES is that
defects were filed as tensions. When a design document describes the intended
path and a defect note describes the failure path, *both claims are true* — the
missing thing is the boundary, so **dissolve** it, write the boundary into both
notes, and keep the defect as a note plus a `/health` recommendation naming
where to file it. The tension list should answer "what does the vault not know
yet", and a documented bug with an owner is something the vault knows very
well.

Two more patterns worth naming, because each looks unresolvable and is not:

- **A claim that is true in a narrower scope.** A premise refuted by later
  primary sources is usually not wrong, it is *unbounded*. Scope it in place
  (the OSS edition, this version, this jurisdiction), link the evidence notes
  with reasons, and resolve in favour of the sources. Deleting the claim throws
  away the part that still holds.
- **A decision that is not yours.** Where closing needs a commercial or product
  call, do the knowledge half — correct the notes — and move the call to an
  `ADD_OPEN_QUESTION` on the MoC that holds the cluster, where whoever browses
  it will meet it. An open question is the right home for a pending decision; a
  tension is not.

If one side is right, **resolve** it and consider `SUPERSEDES` on the winner:

```bash
switchboard docs mutate <tension-id> --op resolveTension --input '{"resolution":"<which side and why>","resolvedAt":"<ISO>"}'
```

Only when the Switchboard predates the automation (no tension appears after
a few seconds and `knowledgeGraphNodesByType(driveId, documentType:"bai/tension")`
is unsupported) fall back to creating it yourself:

```bash
switchboard docs create --type bai/tension --name "<what contradicts what>" --drive <drive-slug> --parent-folder <ops-folder-uuid> --format json
switchboard docs apply <tension-id> --actions '[{"type":"CREATE_TENSION","input":{"title":"<title>","description":"<summary>","content":"<Side A says… Side B says… This matters because…>","involvedRefs":["<note-id-1>","<note-id-2>"],"observedAt":"<ISO>","observedBy":"knowledge-agent"},"scope":"global"}]'
switchboard docs mutate <moc-id> --op addTension --input '{"id":"<tension-id>","description":"<summary>","involvedRefs":["<note-id-1>","<note-id-2>"],"addedAt":"<ISO>"}'
```

## Quality rules

- Every connection must pass the **articulation test** — and the sentence goes on the edge (`--reason`). Bare links without reasons are address books, not knowledge graphs; a reason that only restates the type or the titles is a bare link in disguise
- Prefer specific link types over generic RELATES_TO when the relationship is clear
- Create bidirectional links when appropriate (if A builds on B, B may also relate to A)
- Minimum 2 connections per note. Separately, an **orphan** is a note with zero *incoming* edges (what `knowledgeGraphOrphans` returns) — adding outgoing links from it does not fix that; a link *to* it does
- Update the target note's content if the connection reveals new context
- After a CONTRADICTS link, read back the tension the indexer opened and enrich or dissolve it — never open a duplicate by hand

If "$ARGUMENTS" is provided, find connections for that specific note.
