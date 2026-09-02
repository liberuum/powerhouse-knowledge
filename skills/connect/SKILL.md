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
3. **Apply the articulation test** — for each candidate, answer: "[[A]] connects to [[B]] because [specific reason]"
4. **If the connection is genuine**, create a relationship via the `addRelationship` GraphQL mutation. Since the drive-override migration, edges live in the reactor's `DocumentRelationship` table (one row per ADD_RELATIONSHIP system action) — not in the source note's `links[]` array. The legacy `--op addLink` writes to the old per-doc array and is **not** indexed by the graph subgraph.

```bash
switchboard query 'mutation {
  addRelationship(
    sourceIdentifier: "<source-uuid>",
    targetIdentifier: "<target-uuid>",
    relationshipType: "RELATES_TO",
    branch: "main"
  ) { documentType }
}'
```

Or via direct HTTP to `/graphql/r` (faster for batch loops):

```bash
GRAPHQL_ENDPOINT=<switchboard>/graphql
curl -s "$GRAPHQL_ENDPOINT" -H 'content-type: application/json' -d '{
  "query": "mutation($s:String!,$t:String!,$r:String!,$b:String){ addRelationship(sourceIdentifier:$s,targetIdentifier:$t,relationshipType:$r,branch:$b){ documentType } }",
  "variables": {"s":"<source-uuid>","t":"<target-uuid>","r":"RELATES_TO","b":"main"}
}'
```

This curl pattern is safe ONLY because `addRelationship` constructs the action server-side. Do
not extend it to `mutateDocument` without stamping `id`/`timestampUtcMs` on every action.

To remove a relationship, use `removeRelationship` with the same argument shape.

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
(vault package ≥ 1.0.55), every `addRelationship(…, "CONTRADICTS")` on the
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

- Every connection must pass the **articulation test** — bare links without reasons are address books, not knowledge graphs
- Prefer specific link types over generic RELATES_TO when the relationship is clear
- Create bidirectional links when appropriate (if A builds on B, B may also relate to A)
- Minimum 2 connections per note. Separately, an **orphan** is a note with zero *incoming* edges (what `knowledgeGraphOrphans` returns) — adding outgoing links from it does not fix that; a link *to* it does
- Update the target note's content if the connection reveals new context
- After a CONTRADICTS link, read back the tension the indexer opened and enrich or dissolve it — never open a duplicate by hand

If "$ARGUMENTS" is provided, find connections for that specific note.
