---
name: synthesize
description: Create Maps of Content (MOCs) from topic clusters in the knowledge graph. Groups notes by shared topics, creates bai/moc documents with core ideas, orientation, and tensions. Use after extraction to organize growing knowledge.
---

# Synthesize — Create Maps of Content

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Analyze the knowledge graph for topic clusters and create `bai/moc` documents that organize notes into navigable topic maps.

## When to use

- After extraction when multiple notes share topics
- When health check shows "0 MOCs for N notes"
- When the user asks to organize or structure their knowledge
- As part of the reflect/reweave pipeline phases

## Process

### Step 1: Identify topic clusters

Two graph calls give you every cluster — do not read notes one by one:

```bash
# 1. The topic vocabulary with counts; only topics with 3+ notes are MoC candidates
switchboard query '{ knowledgeGraphTopics(driveId: "<UUID>") { name noteCount } }'
# 2. The members of each candidate topic (no `content` — you only need ids and titles here)
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "<topic>") { documentId title noteType status } }'
```

Then read the existing hierarchy in one call, so you know which topics already have a MoC and where the HUB is:

```bash
switchboard query '{ mocs: knowledgeGraphNodesByStatus(driveId: "<UUID>", status: "MOC") { documentId title noteType } edges: knowledgeGraphEdges(driveId: "<UUID>") { sourceDocumentId targetDocumentId linkType } }'
# noteType is "MOC (HUB)" / "MOC (DOMAIN)" / "MOC (TOPIC)"
# CHILD_MOC edges are the tree; CORE_IDEA edges are membership
# the HUB is the MoC with no incoming CHILD_MOC edge — there should be exactly one
```

### Step 2: Check for existing MOCs

```bash
switchboard docs list --drive <drive-slug> --format json
# Find all bai/moc documents
# Compare: if a MOC already exists for topic X, update it instead of creating a new one —
# UPDATE_DESCRIPTION { description, updatedAt } / UPDATE_ORIENTATION { orientation, updatedAt }
# on the existing MoC, plus `switchboard docs link <moc> <note> -t CORE_IDEA` for each new member
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

**MOC tiers and the hierarchy.** MoCs form a tree with one root; agents and humans explore the vault by walking it, so every MoC must be reachable from the top.

| Tier | Holds | Size | Parent |
|------|-------|------|--------|
| `TOPIC` | a focused cluster of notes (`CORE_IDEA`) | 3–9 notes | a `DOMAIN`, or the HUB if no domain fits |
| `DOMAIN` | a broad area: its own notes plus `CHILD_MOC` TOPIC MoCs | 10+ notes, or 2+ topic MoCs | the HUB |
| `HUB` | the vault's single entry point: `CHILD_MOC` to every DOMAIN and to any TOPIC without a domain | one per vault | — |

Apply, in this order, every time you run:

1. **Topic with 3+ notes and no MoC → create a TOPIC MoC**, `CORE_IDEA` every member.
2. **2+ TOPIC MoCs that share a broader theme, or a topic past ~10 notes → a DOMAIN MoC** (create it, or promote the TOPIC by `SET_METADATA_FIELD`/recreate with tier `DOMAIN`), then `CHILD_MOC` the topics under it. Name the domain for the theme the children share, not for one of them.
3. **3+ DOMAIN/TOPIC MoCs and no HUB → create the HUB** (tier `HUB`, a title naming the whole vault's subject, an orientation that says how the domains divide the territory). Then `CHILD_MOC` every MoC that has no parent under it. A vault has exactly one HUB.
4. **Attach every MoC you created to a parent in the same run.** Leaving a MoC unreachable from the HUB is the failure mode this step exists to prevent.

Example — a vault of 37 MoCs: one HUB "Powerhouse Ecosystem" → 17 DOMAIN MoCs ("Reactor and Drives", "Editors and UX", …) and the TOPIC MoCs that fit no domain; "Editors and UX" → `CHILD_MOC` → TOPIC "Document Toolbar Styling" (5 notes).

**Length limits:** none on a MoC's title, description or orientation — the only hard length limit in any model is a knowledge note's description (≤ 200). Keep MoC descriptions to one or two sentences for the picker; put the substance in `orientation`.

### Step 5: Attach core ideas

For each note in the topic, attach it to the MoC with `docs link … -t CORE_IDEA`. Since the drive-override migration, core ideas live in the reactor's `DocumentRelationship` table — not in the MoC's `coreIdeas[]` state array. This is the same command used for note↔note links; only the type differs, and it is signed as you when the profile has an identity.

```bash
switchboard docs link <moc-id> <note-document-id> -t CORE_IDEA
```

For a hub/domain hierarchy, use `CHILD_MOC` from the parent MoC to each child MoC:

```bash
switchboard docs link <parent-moc-id> <child-moc-id> -t CHILD_MOC
```

**The old `contextPhrase` has a home again — on the edge, optionally.** The pre-migration `addCoreIdea` op accepted a `contextPhrase` explaining WHY each note was a core idea. Since CLI 1.0.36 the relationship row carries metadata, so that phrase can go on the edge: `docs link <moc> <note> -t CORE_IDEA --reason "<why this note anchors the topic>"`. The hook does not require it for `CORE_IDEA` / `CHILD_MOC` (membership is the meaning), but when you know why a note is central to the map, say it there — the MoC editor and the sidebar read `reason` off the edge, and a reader navigating from the MoC sees it before opening the note.

### Step 5b: Place every new MoC in the tree

For each MoC created in Step 4, add one `CHILD_MOC` edge from its parent (the DOMAIN it belongs to, else the HUB). If the vault now has 3+ MoCs and no HUB, create the HUB first (Step 4, tier `HUB`) and attach every parentless MoC to it. Verify afterwards:

```bash
# Every MoC except the HUB must have exactly one incoming CHILD_MOC edge
switchboard query '{ knowledgeGraphEdges(driveId: "<UUID>") { sourceDocumentId targetDocumentId linkType } }' --format json \
  | python3 -c "import json,sys; e=[x for x in json.load(sys.stdin)['data']['knowledgeGraphEdges'] if x['linkType']=='CHILD_MOC']; print(len(e),'CHILD_MOC edges;', len({x['sourceDocumentId'] for x in e}),'parents')"
```

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

Hierarchy:
  HUB  Powerhouse Ecosystem — 18 child MoCs (1 new)
    DOMAIN  Editors and UX — 19 notes, 2 child MoCs
      TOPIC  Document Toolbar Styling — 5 notes
      TOPIC  editor-styling — 3 notes (new, attached)
Unreachable MoCs: 0
```

## Integration with pipeline

MOC creation should happen during the **reflect** or **reweave** phase:
- After connecting notes, check if any topic has 3+ notes without a MOC
- Create MOCs for uncovered topics and attach each to its DOMAIN or the HUB in the same run
- Promote to a DOMAIN, or create the HUB, when the thresholds above are crossed
- Update existing MOCs with new core ideas from the latest extraction

Note that the `/health` check MOC_COHERENCE grades **notes without topics**, not topic clusters without a MoC — creating MoCs does not move it; tagging notes does.

If "$ARGUMENTS" is provided, focus on that specific topic.
