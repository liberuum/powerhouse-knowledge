---
name: connect
description: Find connections between knowledge notes and create links. Use after extracting notes, when exploring relationships, or when a topic needs synthesis.
---

# Connect Knowledge Notes

Find genuine connections between notes and create typed links. This is the "reflect" phase — the step that transforms isolated claims into a knowledge graph.

## Connection discovery process

1. **Identify the target note** — which note are we connecting?
2. **Search for candidates** — use the search skill to find potentially related notes
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

After connecting notes to each other, **search the 249 research claims in `/research/`** for methodology backing:

1. For each new note, search research claims by topic and keywords:
```bash
# List all documents and filter by type
switchboard docs list --drive <drive-slug> --format json
# Filter: documentType === "bai/research-claim"
# Match: topics overlap OR title contains similar keywords
```

Or use the subgraph:
```bash
switchboard query '{ knowledgeGraphSearch(driveId: "<UUID>", query: "<keyword from note>") { documentId title } }'
```

2. For each matching claim, create a cross-link from the note to the claim:
```bash
switchboard docs mutate <note-id> --op addLink --input '{
  "id": "<unique-id>",
  "targetDocumentId": "<research-claim-id>",
  "targetTitle": "<claim title>",
  "linkType": "BUILDS_ON"
}'
```

**Link type selection for methodology:**
- `BUILDS_ON` — note implements or validates the research claim
- `CONTRADICTS` — note's findings challenge the methodology claim
- `RELATES_TO` — thematic connection without direct support/conflict

**Why this matters:** Cross-referencing grounds working knowledge in the methodology foundation. When someone asks "why is the vault designed this way?", the links trace from notes → research claims → cognitive science backing.

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
