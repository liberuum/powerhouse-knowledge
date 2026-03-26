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
4. **If the connection is genuine**, create a link using `ADD_LINK`:

```
mcp__reactor-mcp__addActions({
  documentId: "<source-note-id>",
  actions: [{
    type: "ADD_LINK",
    input: {
      id: "<generate-unique-id>",
      targetDocumentId: "<target-note-id>",
      targetTitle: "<target note title>",
      linkType: "RELATES_TO"
    },
    scope: "global"
  }]
})
```

## Link types

- **RELATES_TO** — general thematic connection
- **BUILDS_ON** — this note extends or strengthens the target
- **CONTRADICTS** — this note challenges or conflicts with the target
- **SUPERSEDES** — this note replaces the target (newer/better understanding)
- **DERIVED_FROM** — this note was extracted or derived from the target

## Quality rules

- Every connection must pass the **articulation test** — bare links without reasons are address books, not knowledge graphs
- Prefer specific link types over generic RELATES_TO when the relationship is clear
- Create bidirectional links when appropriate (if A builds on B, B may also relate to A)
- Minimum 2 connections per note — orphan notes indicate incomplete processing
- Update the target note's content if the connection reveals new context

If "$ARGUMENTS" is provided, find connections for that specific note.
