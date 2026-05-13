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

```bash
switchboard docs list --drive <drive-slug> --format json
# For each bai/knowledge-note, read state.global.topics[]
switchboard docs get <note-id> --state --format json
# Group: topic-name -> [{ docId, title, noteType }]
# Filter: only topics with 3+ notes are MOC candidates
```

Or use the subgraph:
```bash
switchboard query '{ knowledgeGraphNodes(driveId: "<UUID>") { documentId title noteType } }'
```

### Step 2: Check for existing MOCs

```bash
switchboard docs list --drive <drive-slug> --format json
# Find all bai/moc documents
# Compare: if a MOC already exists for topic X, update it instead of creating a new one
```

### Step 3: Find the /knowledge/ folder

MOCs go in `/knowledge/` (not `/knowledge/notes/` — MOCs are navigation, not atomic claims):

```bash
switchboard docs tree <drive-slug> --format json
# Find: kind="folder", name="knowledge", parentFolder=null
```

### Step 4: Create MOC documents

For each topic cluster with 3+ notes:

```bash
switchboard docs create --type bai/moc --name "<topic-name>" --drive <drive-slug> --parent-folder <knowledge-folder-uuid> --format json
```

Then initialize the MOC:
```bash
switchboard docs apply <moc-id> --actions '[{
  "type": "CREATE_MOC",
  "input": {
    "title": "<topic-name>",
    "description": "Map of Content for <topic> — N notes covering <brief scope>",
    "orientation": "<1-2 paragraph synthesis of what this topic covers, key themes, and how notes relate>",
    "tier": "TOPIC",
    "createdAt": "<ISO>"
  },
  "scope": "global"
}]'
```

**MOC Tiers:**
- `HUB` — top-level entry point (e.g., "Knowledge Management")
- `DOMAIN` — broad area with 10+ notes (e.g., "Cognitive Science")
- `TOPIC` — focused cluster with 3-9 notes (e.g., "extended-mind")

### Step 5: Attach core ideas

For each note in the topic, attach it to the MoC via an `addRelationship` mutation with type `CORE_IDEA`. Since the drive-override migration, core ideas live in the reactor's `DocumentRelationship` table — not in the MoC's `coreIdeas[]` state array. This is the same mutation used for note↔note links; only the `relationshipType` differs.

```bash
switchboard query 'mutation {
  addRelationship(
    sourceIdentifier: "<moc-id>",
    targetIdentifier: "<note-document-id>",
    relationshipType: "CORE_IDEA",
    branch: "main"
  ) { documentType }
}'
```

For a hub/domain hierarchy, use `CHILD_MOC` from the parent MoC to each child MoC:

```bash
switchboard query 'mutation {
  addRelationship(
    sourceIdentifier: "<parent-moc-id>",
    targetIdentifier: "<child-moc-id>",
    relationshipType: "CHILD_MOC",
    branch: "main"
  ) { documentType }
}'
```

**Articulation lives in the note body, not on the edge.** The pre-migration `addCoreIdea` op accepted a `contextPhrase` that explained WHY each note was a core idea. The new `DocumentRelationship` row is just `(source, target, type)` — no metadata. To preserve the articulation, edit the source note's content (`--op setContent`) and add a section explaining how it fits the topic. The reader sees this when they navigate from the MoC into the note.

### Step 6: Add tensions and open questions (optional)

If notes within the topic contradict each other:
```bash
switchboard docs mutate <moc-id> --op addTension --input '{
  "id": "<unique-id>",
  "description": "<what the contradiction is>",
  "involvedRefs": ["<note-id-1>", "<note-id-2>"],
  "addedAt": "<ISO>"
}'
```

If there are unexplored directions:
```bash
switchboard docs mutate <moc-id> --op addOpenQuestion --input '{"question": "<what has not been explored yet in this topic?>"}'
```

### Step 7: Verify MOCs actually exist

**CRITICAL:** Don't assume creation succeeded. After creating all MOCs, **read the drive tree and confirm each MOC appears**:
```bash
switchboard docs tree <drive-slug> --format json
# Check each MOC ID exists as a file node with documentType === "bai/moc"
# If missing: the creation silently failed — recreate
```
Only report MOC_COHERENCE as PASS after verification, not after dispatching the create.

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
