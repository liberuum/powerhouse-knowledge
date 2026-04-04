---
name: connect
description: Find connections between knowledge notes and create links. Use after extracting notes, when exploring relationships, or when a topic needs synthesis.
---

# Connect Knowledge Notes

Find genuine connections between notes and create typed links. This is the "reflect" phase — the step that transforms isolated claims into a knowledge graph.

## Connection discovery process

1. **Identify the target note** — which note are we connecting?
2. **Search for candidates** using multiple strategies:
   - `knowledgeGraphSimilar(documentId)` — AI-powered semantic similarity (finds conceptually related notes even without keyword overlap)
   - `knowledgeGraphRelatedByTopic(documentId)` — notes sharing the most topics
   - `knowledgeGraphSearch(query)` — keyword search on title + description
   - `knowledgeGraphSemanticSearch(query)` — meaning-based search for specific concepts
3. **Apply the articulation test** — for each candidate, answer: "[[A]] connects to [[B]] because [specific reason]"
4. **If the connection is genuine**, create a link:

```bash
switchboard docs mutate <source-note-id> --op addLink --input '{
  "id": "<generate-unique-id>",
  "targetDocumentId": "<target-note-id>",
  "targetTitle": "<target note title>",
  "linkType": "RELATES_TO"
}'
```

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

When you find a CONTRADICTS link, check whether this is a genuine unresolved tension:

- Do two notes make opposing claims about the same topic?
- Is the contradiction substantive (not just different wording)?
- Is it unresolved (no existing note reconciles the two positions)?

If yes, create a `bai/tension` document:
```bash
switchboard docs create --type bai/tension --name "<what contradicts what>" --drive <drive-slug> --parent-folder <ops-folder-uuid> --format json
```

Then populate it:
```bash
switchboard docs apply <tension-id> --actions '[{
  "type": "CREATE_TENSION",
  "input": {
    "title": "<tension title>",
    "description": "<brief summary>",
    "content": "<Side A says... Side B says... This matters because...>",
    "involvedRefs": ["<note-id-1>", "<note-id-2>"],
    "observedAt": "<ISO>",
    "observedBy": "knowledge-agent"
  },
  "scope": "global"
}]'
```

Also add the tension to the relevant MOC if one exists:
```bash
switchboard docs mutate <moc-id> --op addTension --input '{
  "id": "<unique-id>",
  "description": "<tension summary>",
  "involvedRefs": ["<note-id-1>", "<note-id-2>"],
  "addedAt": "<ISO>"
}'
```

## Quality rules

- Every connection must pass the **articulation test** — bare links without reasons are address books, not knowledge graphs
- Prefer specific link types over generic RELATES_TO when the relationship is clear
- Create bidirectional links when appropriate (if A builds on B, B may also relate to A)
- Minimum 2 connections per note — orphan notes indicate incomplete processing
- Update the target note's content if the connection reveals new context
- When creating CONTRADICTS links, always check if a `bai/tension` document should be created

If "$ARGUMENTS" is provided, find connections for that specific note.
