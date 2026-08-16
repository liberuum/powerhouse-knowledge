---
name: projects
description: Manage bai/project and bai/wbs documents — find/read a project and its Work Breakdown Structure, run the agent goal-working loop (assign a goal, start it, do the work, log progress, complete or block it), and close out linked deliverables. All operations run through the Switchboard CLI against the live reactor; bai/project and bai/wbs are not graph-indexed.
---

# Projects & Work Breakdown Structure

Projects (`bai/project`) and their Work Breakdown Structures (`bai/wbs`) live in the
same vault drive as the knowledge notes — same `/projects/` folder, same reactor, same
Switchboard CLI. An agent working a WBS goal can query the vault's knowledge (semantic
search, notes, MOCs) from the drive it's already on, and a project can cite the
knowledge it builds on via `knowledgeRefs`.

**These two types are not graph-indexed.** The Graph Indexer, embedder, and health
checks all filter on knowledge types and ignore `bai/project` / `bai/wbs` by design —
don't reach for `knowledgeGraphSemanticSearch` or any other `knowledgeGraph*` query to
find or search them. Use `docs tree` / `docs get` directly, as below.

## When to use

- The user asks about project or task status, or "what should I work on next"
- An agent needs to pick up, progress, or close out a WBS goal
- Creating a new project or its WBS
- Tying a vault artifact (note, MOC) back to the project/deliverable it serves

## Pre-flight

1. Establish the vault the same way as any other skill:
```bash
switchboard config show
switchboard ping
```

2. Confirm the reactor knows both types. A stale CLI schema cache is a known false
   alarm, not a BLOCKED condition — re-run `switchboard introspect` before concluding
   the models aren't deployed:
```bash
switchboard models list --format json | grep -E 'bai/project|bai/wbs'
# if absent, re-introspect before assuming the models are missing:
switchboard introspect
```

## Step 1: Find the projects folder and existing docs

Both `bai/project` and `bai/wbs` documents live directly under a single top-level
`/projects/` folder — not nested per-project subfolders.

```bash
switchboard docs tree <drive-slug> --format json | python3 -c "
import json, sys
nodes = json.load(sys.stdin).get('nodes', [])
folder = next((n for n in nodes if n.get('kind')=='folder' and n.get('name')=='projects' and n.get('parentFolder') is None), None)
print('FOLDER:', folder['id'] if folder else 'MISSING')
for n in nodes:
    if n.get('documentType') in ('bai/project', 'bai/wbs'):
        print(n['documentType'], n['id'], n.get('name'))
"
```

**Check before creating.** If `/projects/` already exists, use it — do not create a
duplicate top-level folder. If it's genuinely missing, either create it with
`ADD_FOLDER` on the drive (check the `powerhouse/document-drive` schema first) or ask
the user to open the app once — the drive app seeds `/projects/` idempotently.

## Step 2: Create a new project + WBS (if none exists yet)

```bash
DRIVE=<drive-slug>
FOLDER=<projects-folder-uuid>

# 1. Create the project document and initialize it
PROJ=$(switchboard docs create --type bai/project --name "<Project Name>" \
  --drive $DRIVE --parent-folder $FOLDER --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $PROJ --op createProject --input \
  '{"name":"<Project Name>","description":"<what it is>","owner":"<owner>","status":"ACTIVE","createdAt":"<ISO-Z>"}'

# 2. Create its WBS document, same folder
WBS=$(switchboard docs create --type bai/wbs --name "<Project Name> — WBS" \
  --drive $DRIVE --parent-folder $FOLDER --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 3. Cross-link both directions — two ops, on two different documents
switchboard docs mutate $PROJ --op linkWbs --input '{"wbsRef":"'$WBS'"}'
switchboard docs mutate $WBS  --op setProjectRef --input '{"projectRef":"'$PROJ'"}'
```

`CREATE_PROJECT` is a one-time initializer, not an upsert — calling it twice on the
same document throws `AlreadyInitializedError` (`ALREADY_INITIALIZED`) once `name` is
already set.

Then seed the goal tree, root goals first, then their children:

```bash
switchboard docs mutate $WBS --op createGoal --input '{"id":"<goal-1>","description":"<...>"}'
switchboard docs mutate $WBS --op createGoal --input '{"id":"<goal-1a>","description":"<...>","parentId":"<goal-1>"}'
```

**Dispatch goal creation one at a time via `docs mutate`, never batched through `docs
apply`.** A child's `CREATE_GOAL` depends on its parent already existing in state, and
`docs apply` is documented elsewhere in this plugin to reverse operation order for
dependent actions.

## Step 3: Read a project and its linked WBS

```bash
switchboard docs get <project-id> --state --format json
# state.global.wbsRef is the PHID of its WBS document (null if not linked yet)

switchboard docs get <wbs-id> --state --format json
# state.global.goals[] — flat array, depth-first order = display order (see Key semantics)
```

Cross-links are independent, not mirrored automatically: `Project.wbsRef` points at
the WBS doc id (`LINK_WBS`), `WorkBreakdownStructure.projectRef` points back at the
project doc id (`SET_PROJECT_REF`). Read both directions rather than assuming one
implies the other — Step 2 sets both when creating a fresh pair.

## Step 4: The goal-working loop

Every agent picking up WBS work should follow this loop:

1. **Pick a goal** — read WBS state, choose a `TODO` leaf you're assigned to (or
   unassigned and appropriate for you to pick up).
2. **Claim it:**
   ```bash
   switchboard docs mutate <wbs-id> --op assignGoal --input '{"id":"<goal-id>","assignee":"<agent-name>"}'
   ```
3. **Start it:**
   ```bash
   switchboard docs mutate <wbs-id> --op setGoalStatus --input '{"id":"<goal-id>","status":"IN_PROGRESS"}'
   ```
4. **Do the work.** Query the vault for relevant knowledge — same drive, same
   reactor. See [skills/search/SKILL.md](../search/SKILL.md) for
   `knowledgeGraphSemanticSearch` and the rest of the search surface.
5. **Record progress** as you go — notes are append-only, dispatch as many as useful:
   ```bash
   switchboard docs mutate <wbs-id> --op addNote --input '{"goalId":"<goal-id>","noteId":"<unique-id>","note":"<what happened>","author":"<agent-name>","timestamp":"<ISO-Z>"}'
   ```
6. **Close it out — done or stuck:**
   ```bash
   # Done
   switchboard docs mutate <wbs-id> --op setGoalStatus --input '{"id":"<goal-id>","status":"COMPLETED","outcome":"<artifact ref>"}'

   # Stuck
   switchboard docs mutate <wbs-id> --op setGoalStatus --input '{"id":"<goal-id>","status":"BLOCKED","blockReason":"<why>"}'
   ```
   `BLOCKED` without a non-blank `blockReason` fails — see Key semantics.
7. **If the goal has a linked deliverable**, close that out too — Step 5.

Steps 2–3 and 5–6 are dependent, sequential writes to the same document — dispatch
one at a time with `docs mutate`, never batched through `docs apply`.

## Step 5: Deliverable close-out

Nothing does this for you — by design (no cascades; see Key semantics), completing a
goal never touches the project document. If the goal you just completed is the
`goalRef` target of a deliverable, close the deliverable out yourself, as its own
operation on the **project** document:

```bash
# Find the deliverable whose goalRef matches the goal you just completed
switchboard docs get <project-id> --state --format json | python3 -c "
import json, sys
g = json.load(sys.stdin)['state']['global']
for d in g['deliverables']:
    if d.get('goalRef') == '<goal-id>':
        print(d['id'], d['status'])
"

# Mark it delivered
switchboard docs mutate <project-id> --op setDeliverableStatus --input '{"id":"<deliverable-id>","status":"DELIVERED","deliveredAt":"<ISO-Z>"}'
```

Moving a deliverable to any status other than `DELIVERED` clears `deliveredAt` back
to `null`; moving it to `DELIVERED` without passing `deliveredAt` keeps whatever value
was already recorded.

## Operations: `bai/project` (4 modules, 16 ops)

Ground truth: `document-models/project/v1/schema.graphql` in the `bai-knowledge-note`
repo. The table shows the schema's canonical `SCREAMING_SNAKE_CASE` operation name —
the `type` in a `docs apply` action. The CLI's `docs mutate --op` flag takes the
camelCase form of the same name (`CREATE_PROJECT` -> `createProject`,
`SET_DELIVERABLE_STATUS` -> `setDeliverableStatus`, etc. — see the examples above).

**lifecycle**

| Op | Input | Errors |
|---|---|---|
| `CREATE_PROJECT` | `{ name!, description, owner, status, createdAt! }` | `ALREADY_INITIALIZED` — name already set |
| `UPDATE_PROJECT_INFO` | `{ name, description }` | — |
| `SET_PROJECT_STATUS` | `{ status! }` | — |
| `SET_OWNER` | `{ owner }` (falsy clears) | — |
| `SET_TARGET_DATE` | `{ targetDate }` (falsy clears) | — |
| `LINK_WBS` | `{ wbsRef }` (falsy unlinks) | — |

**team**

| Op | Input | Errors |
|---|---|---|
| `ADD_MEMBER` | `{ id!, name!, role, kind }` | `DUPLICATE_MEMBER` |
| `UPDATE_MEMBER` | `{ id!, name, role, kind }` — patch: only truthy fields overwrite | `MEMBER_NOT_FOUND` |
| `REMOVE_MEMBER` | `{ id! }` | `MEMBER_NOT_FOUND` |

**deliverables**

| Op | Input | Errors |
|---|---|---|
| `ADD_DELIVERABLE` | `{ id!, title!, description, goalRef, url }` — starts `PLANNED` | `DUPLICATE_DELIVERABLE` |
| `UPDATE_DELIVERABLE` | `{ id!, title, description, goalRef, url }` — patch: only truthy fields overwrite | `DELIVERABLE_NOT_FOUND` |
| `SET_DELIVERABLE_STATUS` | `{ id!, status!, deliveredAt }` | `DELIVERABLE_NOT_FOUND` |
| `REMOVE_DELIVERABLE` | `{ id! }` | `DELIVERABLE_NOT_FOUND` |

**knowledge**

| Op | Input | Errors |
|---|---|---|
| `ADD_KNOWLEDGE_REF` | `{ ref! }` — PHID of a vault note/MOC | `DUPLICATE_KNOWLEDGE_REF` |
| `REMOVE_KNOWLEDGE_REF` | `{ ref! }` | `KNOWLEDGE_REF_NOT_FOUND` |
| `SET_REFERENCES` | `{ references! }` — **replaces** the whole array | — |

## Operations: `bai/wbs` (3 modules, 14 ops)

Ground truth: `document-models/work-breakdown-structure/v1/schema.graphql`.

**goals**

| Op | Input | Errors |
|---|---|---|
| `CREATE_GOAL` | `{ id!, description!, parentId, assignee, insertBefore }` — no `insertBefore` appends as last child of `parentId` (or last root); starts `TODO` | `DUPLICATE_GOAL_ID`, `GOAL_NOT_FOUND` (parent or insertBefore missing) |
| `UPDATE_GOAL_DESCRIPTION` | `{ id!, description! }` | `GOAL_NOT_FOUND` |
| `DELETE_GOAL` | `{ id! }` — removes the whole subtree + strips dangling `dependencies` refs | `GOAL_NOT_FOUND` |
| `REORDER` | `{ id!, parentId, insertBefore }` | `GOAL_NOT_FOUND`, `INVALID_PARENT` (self/descendant cycle) |

**workflow**

| Op | Input | Errors |
|---|---|---|
| `SET_GOAL_STATUS` | `{ id!, status!, blockReason, outcome }` — `BLOCKED` requires non-blank `blockReason`; `blockReason` auto-clears on any other status; `outcome` only overwrites when provided | `GOAL_NOT_FOUND`, `MISSING_BLOCK_REASON` |
| `ASSIGN_GOAL` | `{ id!, assignee }` (falsy unassigns) | `GOAL_NOT_FOUND` |
| `SET_OUTCOME` | `{ id!, outcome }` (falsy clears) | `GOAL_NOT_FOUND` |
| `ADD_DEPENDENCIES` | `{ id!, dependencies! }` | `GOAL_NOT_FOUND`, `DEPENDENCY_NOT_FOUND`, `INVALID_DEPENDENCY` (self) |
| `REMOVE_DEPENDENCIES` | `{ id!, dependencies! }` | `GOAL_NOT_FOUND` |

**documentation**

| Op | Input | Errors |
|---|---|---|
| `ADD_NOTE` | `{ goalId!, noteId!, note!, author, timestamp }` — append-only | `GOAL_NOT_FOUND`, `DUPLICATE_NOTE_ID` |
| `REMOVE_NOTE` | `{ goalId!, noteId! }` | `GOAL_NOT_FOUND`, `NOTE_NOT_FOUND` |
| `SET_OWNER` | `{ owner }` (falsy clears) | — |
| `SET_REFERENCES` | `{ references! }` — **replaces** the whole array | — |
| `SET_PROJECT_REF` | `{ projectRef }` (falsy unlinks) | — |

## Key semantics

1. **Goal order is meaningful.** `goals[]` is always kept depth-first (parents before
   children; sibling order = insertion/move order within the same `parentId`) after
   every structural change. Array order **is** display order — don't re-sort
   client-side, and don't infer hierarchy from position alone without checking
   `parentId`.
2. **Moving/inserting goals uses `insertBefore`, not an index.** Both `CREATE_GOAL`
   and `REORDER` accept an optional `insertBefore: OID` — the id of the goal that
   should immediately follow the new/moved one. Omit it to append as the last child
   of `parentId` (or last root). `REORDER` validates the move: retargeting a goal
   under itself or one of its own descendants throws `InvalidParentError` and leaves
   state unchanged.
3. **`SET_GOAL_STATUS` to `BLOCKED` requires `blockReason`.** A blank/missing
   `blockReason` throws `MissingBlockReasonError` ("BLOCKED requires a blockReason").
   The operation is still recorded — `switchboard ops <wbs-id>` will show it with a
   non-null `.error` — but `state.global` is byte-identical to before the call.
   Re-read state (or the op log) after a status change to confirm it actually applied.
4. **No automatic cascades — anywhere.** This is deliberate: completing every child
   goal does not auto-complete the parent, and completing a goal does not
   auto-update the deliverable that references it. Set parent-goal statuses and
   deliverable statuses explicitly, as their own operations (Step 4.7, Step 5).
5. **Timestamps are full ISO-8601, Z-suffixed.** `DateTime` fields (`ADD_NOTE.timestamp`,
   `CREATE_PROJECT.createdAt`, `SET_DELIVERABLE_STATUS.deliveredAt`, etc.) expect e.g.
   `2026-08-16T19:41:32.000Z`. The CLI does not auto-generate these the way it injects
   the action envelope's own `id`/`timestampUtcMs` — you must supply them.
6. **`DELETE_GOAL` deletes the whole subtree, not just the one node**, then strips any
   now-dangling id out of every remaining goal's `dependencies[]`. There's no
   "detach children first" step and no confirmation — read the subtree before
   deleting if you need to preserve any of it elsewhere.
7. **`knowledgeRefs` are PHIDs, not a relationship-table edge.** Unlike
   knowledge-note-to-note links (which go through `addRelationship` /
   `DocumentRelationship`), a project's `knowledgeRefs[]` is a plain PHID array in
   `ProjectState`, managed directly with `ADD_KNOWLEDGE_REF` / `REMOVE_KNOWLEDGE_REF`
   on the project document — do not use `addRelationship` for these. Cite the notes
   and MOCs the project actually builds on, not everything tangentially related.
8. **`SET_REFERENCES` replaces, it doesn't append** — on both models. Read the
   current `references[]` first if you want to keep existing entries.
9. **"Setter" ops vs. "patch" ops.** `SET_OWNER`, `SET_TARGET_DATE`, `LINK_WBS`,
   `ASSIGN_GOAL`, `SET_OUTCOME`, and `SET_PROJECT_REF` treat a falsy/omitted value as
   "clear the field" (null). `UPDATE_PROJECT_INFO`, `UPDATE_MEMBER`, and
   `UPDATE_DELIVERABLE` are the opposite — they only overwrite a field when you pass
   a non-empty value, so there's no way to blank out `name`/`role`/`title` via
   `UPDATE_*`; use the dedicated `SET_*` op where one exists instead.

## Rules

- **Never leave a goal `IN_PROGRESS` at session end.** Before ending a session or
  handing off, every goal you moved to `IN_PROGRESS` must be `COMPLETED`, `BLOCKED`
  (with a real `blockReason`), or given a note explaining where it stands. An honest
  `BLOCKED` beats a silently stale `IN_PROGRESS`.
- **Check for an existing `projects` folder before creating one.** Don't create a
  duplicate top-level folder — see Step 1.
- **Create documents with `--parent-folder <projects-folder-uuid>`.** Both
  `bai/project` and `bai/wbs` go directly under `/projects/` — no per-project
  subfolder.
