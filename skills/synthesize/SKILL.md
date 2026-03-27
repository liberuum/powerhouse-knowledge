---
name: synthesize
description: Create Maps of Content (MOCs) from topic clusters in the knowledge graph. Groups notes by shared topics, creates bai/moc documents with core ideas, orientation, and tensions. Use after extraction to organize growing knowledge.
---

# Synthesize — Create Maps of Content

Analyze the knowledge graph for topic clusters and create `bai/moc` documents that organize notes into navigable topic maps.

## When to use

- After extraction when multiple notes share topics
- When health check shows "0 MOCs for N notes"
- When the user asks to organize or structure their knowledge
- As part of the reflect/reweave pipeline phases

## Process

### Step 1: Identify topic clusters

Read all knowledge notes and group by topics:

```
mcp__reactor-mcp__getDocuments({ parentId: "<drive-uuid>" })
// For each bai/knowledge-note, read state.global.topics[]
// Group: topic-name -> [{ docId, title, noteType }]
// Filter: only topics with 3+ notes are MOC candidates
```

Or use the subgraph:
```bash
curl -s $REACTOR_URL/graphql/knowledgeGraph \
  -H "Content-Type: application/json" \
  -d '{"query":"{ knowledgeGraphNodes(driveId: \"<UUID>\") { documentId title noteType } }"}'
```

### Step 2: Check for existing MOCs

```
mcp__reactor-mcp__getDocuments({ parentId: "<drive-uuid>" })
// Find all bai/moc documents
// Compare: if a MOC already exists for topic X, update it instead of creating a new one
```

### Step 3: Find the /knowledge/ folder

MOCs go in `/knowledge/` (not `/knowledge/notes/` — MOCs are navigation, not atomic claims):

```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Find: kind="folder", name="knowledge", parentFolder=null
```

### Step 4: Create MOC documents

For each topic cluster with 3+ notes:

```
mcp__reactor-mcp__createDocument({
  documentType: "bai/moc",
  driveId: "<drive-uuid>",
  name: "<topic-name>",
  parentFolder: "<knowledge-folder-uuid>"
})
```

**Wait 100ms between creates** (MCP race condition prevention).

Then initialize the MOC:
```
mcp__reactor-mcp__addActions({
  documentId: "<moc-id>",
  actions: [{
    type: "CREATE_MOC",
    input: {
      title: "<topic-name>",
      description: "Map of Content for <topic> — N notes covering <brief scope>",
      orientation: "<1-2 paragraph synthesis of what this topic covers, key themes, and how notes relate>",
      tier: "TOPIC",
      createdAt: "<ISO>"
    },
    scope: "global"
  }]
})
```

**MOC Tiers:**
- `HUB` — top-level entry point (e.g., "Knowledge Management")
- `DOMAIN` — broad area with 10+ notes (e.g., "Cognitive Science")
- `TOPIC` — focused cluster with 3-9 notes (e.g., "extended-mind")

### Step 5: Add core ideas

For each note in the topic, add it as a core idea with an articulated context phrase:

```
mcp__reactor-mcp__addActions({
  documentId: "<moc-id>",
  actions: [{
    type: "ADD_CORE_IDEA",
    input: {
      id: "<unique-id>",
      noteRef: "<note-document-id>",
      contextPhrase: "<WHY this note matters in this topic — not just 'related to X'>",
      sortOrder: 0,
      addedAt: "<ISO>",
      addedBy: "knowledge-agent"
    },
    scope: "global"
  }]
})
```

**The context phrase is critical.** It's the articulation test for MOCs — explain WHY each note is a core idea in this topic, not just that it exists.

### Step 6: Add tensions and open questions (optional)

If notes within the topic contradict each other:
```
mcp__reactor-mcp__addActions({
  documentId: "<moc-id>",
  actions: [{
    type: "ADD_TENSION",
    input: {
      id: "<unique-id>",
      description: "<what the contradiction is>",
      involvedRefs: ["<note-id-1>", "<note-id-2>"],
      addedAt: "<ISO>"
    },
    scope: "global"
  }]
})
```

If there are unexplored directions:
```
mcp__reactor-mcp__addActions({
  documentId: "<moc-id>",
  actions: [{
    type: "ADD_OPEN_QUESTION",
    input: { question: "<what hasn't been explored yet in this topic?>" },
    scope: "global"
  }]
})
```

### Step 7: Verify drive nodes

After creating all MOCs, verify they appear in the drive tree:
```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
// Check each MOC ID exists as a file node
// Repair missing with ADD_FILE if needed
```

## Output

```
=== MOC SYNTHESIS COMPLETE ===
Topic clusters found: N
MOCs created: N
MOCs updated: N (existing)
Total core ideas added: N

New MOCs:
  extended-mind (TOPIC) — 4 notes
  powerhouse-architecture (TOPIC) — 5 notes
  editor-styling (TOPIC) — 3 notes
```

## Integration with pipeline

MOC creation should happen during the **reflect** or **reweave** phase:
- After connecting notes, check if any topic has 3+ notes without a MOC
- Create MOCs for uncovered topics
- Update existing MOCs with new core ideas from the latest extraction

The `/health` check for MOC_COHERENCE will pass once MOCs exist for all active topics.

If "$ARGUMENTS" is provided, focus on that specific topic.
