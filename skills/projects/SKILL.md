---
name: projects
description: Manage work in the vault — scopes of work (powerhouse/scopeofwork) whose envelopes are the projects, and the bai/wbs goal trees that deliver them. Find or create a scope, add an envelope, create and link its WBS both ways, turn top-level goals into deliverables, run the agent goal-working loop (assign, start, note, complete or block), and close deliverables out. Operations run over REST `POST actions` or the Switchboard CLI against the live reactor; both types are graph-indexed as SCOPE / WBS sentinel nodes (searchable outline, CITES / DELIVERED_BY edges) but are mutated by id. bai/project is retired — never create one.
---

# Scopes of work, projects (envelopes) and Work Breakdown Structures

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Work lives in two document types, both under `/projects/` in the same drive as the
knowledge notes:

| Type | What it is | One per |
|---|---|---|
| `powerhouse/scopeofwork` | A **scope of work**: the stakeholder plan. Holds **envelopes** (`projects[]` — the projects: code, title, owner, budget, cited knowledge, references, a link to their WBS), the **deliverables** those envelopes fund (priced in story points or hours, each linked to the goal that delivers it), **roadmaps → milestones**, and **contributors** | team / programme / client |
| `bai/wbs` | A **work breakdown structure**: the goal tree the team actually works — statuses, assignees, dependencies, notes. Points back at the envelope it delivers | envelope |

```
scope of work ──▶ envelope (project) ──wbsRef──▶ WBS document
                       │                             ▲
                       └─ deliverable ──goalRef──▶ a top-level goal in that WBS
                       WBS ──sowRef + sowProjectId──▶ back to the envelope
```

**Find and read nested SOW data with scope-of-work** (`lookup.py list` /
`get` / `search` / `outline`). This skill is **create, mutate, and the
goal-working loop**.

**`bai/project` is retired (2026-09-04).** Its fields moved onto the envelope
(`wbsRef`, `knowledgeRefs`, `references`, owner). Never create a `bai/project`
document; if you meet one in an older vault, it is legacy data to migrate into an
envelope, not a type to write to.

**Both types are graph-indexed — as execution documents, not knowledge.** Since
1.0.54-dev.7 the Graph Indexer projects a scope as a node with `status = "SCOPE"`
(`noteType = "Scope (<ScopeOfWorkStatus>)"`) and a WBS as `status = "WBS"`
(`noteType = "WBS (TODO|IN_PROGRESS|BLOCKED|COMPLETED)"`); the node's `content` is a
rendered outline (envelopes, deliverables with quotes and owners, milestones,
contributors / the goal tree), so `knowledgeGraphSemanticSearch` finds the project that
delivers "payments demo" and `knowledgeGraphNodesByStatus(status:"SCOPE")` lists every
scope. A scope also carries derived edges — `CITES` to each note/MoC in an envelope's
`knowledgeRefs`, `DELIVERED_BY` to its WBS — so a note's backlinks show which project
cites it. None of that counts as knowledge: scopes and WBS are excluded from orphans,
density and `edgeCount`, and health checks ignore them. The index is for *finding*;
quotes, budgets, `goalRef`s and goal notes are read from the document itself with
`docs get`, as below, and every write goes by id. In the vault chat, `list_projects`,
`read_document` and `search_vault` all understand scopes.

## When to use

- Creating a scope of work, an envelope inside one, or the envelope's WBS
- Turning a goal tree into priced deliverables, or a deliverable into scheduled work
- An agent needs to pick up, progress, or close out a WBS goal
- Citing the vault knowledge an envelope builds on

Reading status, searching nested SOW fields, or looking up a named project:
**scope-of-work**, not this skill.

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
switchboard models list --format json | grep -E 'powerhouse/scopeofwork|bai/wbs'
switchboard introspect   # only if absent
```

## Step 1: Find the projects folder, the scopes and their envelopes

**REQUIRED SUB-SKILL:** use scope-of-work to list and read — do not walk the
drive tree looking for envelope titles.

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/scope-of-work/lookup.py" list
python3 "${CLAUDE_PLUGIN_ROOT:-.}/skills/scope-of-work/lookup.py" get "<code or title>"
```

When **creating** (Step 2), you still need the `/projects/` folder UUID:

```bash
switchboard docs tree <drive-slug> --format json | python3 -c "
import json, sys
nodes = json.load(sys.stdin).get('nodes', [])
folder = next((n for n in nodes if n.get('kind')=='folder' and n.get('name')=='projects' and n.get('parentFolder') is None), None)
print('FOLDER:', folder['id'] if folder else 'MISSING')
"
```

**Check before creating.** If `/projects/` exists, use it. If a scope already exists for
the team or client, add an envelope to it rather than creating a second scope.

## Step 2: Create a scope of work and an envelope

```bash
DRIVE=<drive-slug>; FOLDER=<projects-folder-uuid>

# a scope — only when the team/programme/client has none yet
SOW=$(switchboard docs create --type powerhouse/scopeofwork --name "<Scope title>" \
  --drive $DRIVE --parent-folder $FOLDER --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
switchboard docs mutate $SOW --op editScopeOfWork --input '{"title":"<Scope title>","description":"<what it scopes>","status":"DRAFT"}'

# the people first: an envelope's owner and a milestone's coordinators are agent ids
switchboard docs mutate $SOW --op addAgent --input '{"id":"<agent-id>","name":"<Person>","description":"<role>"}'

# an envelope (the project) — code and title are required
ENV=$(python3 -c "import uuid; print(uuid.uuid4())")
switchboard docs mutate $SOW --op addProject --input \
  '{"id":"'$ENV'","code":"<CODE>","title":"<Project title>","slug":"<project-slug>","projectOwner":"<agent-id>","abstract":"<one paragraph>","budgetType":"OPEX","currency":"USD"}'
```

`ADD_PROJECT` with a `budget` **fixes** the envelope (`targetBudget`) — unpinned
quotes then derive their margin from it. Omit `budget` for an envelope whose total
should be derived from its quotes. `ADD_AGENT` ids are PHIDs (strings): reuse an
existing contributor's id for the same person rather than adding a second agent.

## Step 3: Create the WBS and link it both ways

The WBS is its own document, created **remote-first** (server side) so nothing links
to an id that does not exist yet. Two links, on two documents:

```bash
WBS=$(switchboard docs create --type bai/wbs --name "<Project title> — WBS" \
  --drive $DRIVE --parent-folder $FOLDER --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

switchboard docs mutate $SOW --op linkProjectWbs   --input '{"projectId":"'$ENV'","wbsRef":"'$WBS'"}'
switchboard docs mutate $WBS --op setSowProjectRef --input '{"sowRef":"'$SOW'","sowProjectId":"'$ENV'"}'
switchboard docs mutate $WBS --op setOwner --input '{"owner":"<Person>"}'
```

Leave the WBS's legacy `projectRef` null — it pointed at `bai/project`.

Then seed the goal tree, parents before children — one `docs apply` batch lands a
whole tree (actions apply in order; a child whose `parentId` is wrong is rejected and
skipped while the rest land, so read `goals.length` back):

```bash
switchboard docs mutate $WBS --op createGoal --input '{"id":"<goal-1>","description":"<...>"}'
switchboard docs mutate $WBS --op createGoal --input '{"id":"<goal-1a>","description":"<...>","parentId":"<goal-1>"}'
```

## Step 4: Deliverables — one per top-level goal, linked by `goalRef`

A deliverable is a top-level goal's subtree, priced. Create it **through the
envelope** (`ADD_PROJECT_DELIVERABLE` creates the deliverable *and* puts it in the
envelope's scope — do not `ADD_DELIVERABLE` first), then link the goal, quote it, and
schedule it:

```bash
D=$(python3 -c "import uuid; print(uuid.uuid4())")
switchboard docs mutate $SOW --op addProjectDeliverable --input '{"projectId":"'$ENV'","deliverableId":"'$D'","title":"<top-level goal description>"}'
switchboard docs mutate $SOW --op editDeliverable      --input '{"id":"'$D'","code":"<CODE>-01","status":"TODO","owner":"<agent-id>"}'
switchboard docs mutate $SOW --op linkDeliverableGoal  --input '{"deliverableId":"'$D'","goalRef":"<goal-1>"}'
switchboard docs mutate $SOW --op setDeliverableBudgetAnchorProject --input '{"deliverableId":"'$D'","project":"'$ENV'","unit":"StoryPoints","unitCost":140,"quantity":20}'
```

Schedule: a roadmap holds dated milestones; an **existing** deliverable joins a
milestone with `ADD_DELIVERABLE_IN_SET` (`ADD_MILESTONE_DELIVERABLE` would *create*
another deliverable):

```bash
RM=$(python3 -c "import uuid; print(uuid.uuid4())"); M1=$(python3 -c "import uuid; print(uuid.uuid4())")
switchboard docs mutate $SOW --op addRoadmap   --input '{"id":"'$RM'","title":"<Roadmap>","slug":"<roadmap-slug>"}'
switchboard docs mutate $SOW --op addMilestone --input '{"id":"'$M1'","roadmapId":"'$RM'","sequenceCode":"M1","title":"<Milestone>","deliveryTarget":"2026-10-31"}'
switchboard docs mutate $SOW --op addDeliverableInSet --input '{"milestoneId":"'$M1'","deliverableId":"'$D'"}'
```

In the editor the same step is one click: **Import N goals as deliverables** on the
envelope's work-breakdown view.

## Step 5: Cite knowledge and references on the envelope

```bash
switchboard docs mutate $SOW --op addProjectKnowledgeRef --input '{"projectId":"'$ENV'","ref":"<note-or-moc-uuid>"}'
switchboard docs mutate $SOW --op setProjectReferences   --input '{"projectId":"'$ENV'","references":["https://…"]}'
```

`knowledgeRefs` are plain PHIDs on the envelope — not `docs link` edges. Cite the notes
and MOCs the work actually builds on. `SET_PROJECT_REFERENCES` **replaces** the list.

## Populate every field — the work contract

A scope of work is the plan of record: what the editor renders, what `lookup.py
search` matches, and what the graph indexer turns into the searchable outline.
**The `ADD_*` operations write defaults, not nulls** — an envelope created without
a `budgetType` is not "undecided", it is `CAPEX`, and a deliverable created through
an envelope is `DRAFT`, unowned, uncoded and quoted at 0 `Hours`. Nothing fills any
of it in later. Create *and* complete in the same run.

The document's own name (`docs create --name`) is none of these fields. A scope
carries its own `title` / `description` / `status` (`EDIT_SCOPE_OF_WORK` — all three
optional, an explicit null ignored, so you can overwrite but never blank). A WBS
carries **no title at all**, only `owner`, so its `--name` is the only place a human
reads what it is. Write both.

### The envelope — `ADD_PROJECT` unless noted

| Field | What it means | Rule |
|---|---|---|
| `id` **OID** | the envelope's id *inside* the scope document | You mint it. Every `projectId` input, `sowProjectId` and `budgetAnchor.project` means **this** — never a document id |
| `code` | short stable handle (`PKV`) | Required; deliverable codes build on it (`PKV-01`) |
| `title` | the project's name | Required |
| `slug` | url handle | Defaults to `""`. Write it |
| `projectOwner` | the accountable person — an `ADD_AGENT` id (a PHID) | Add the agent first: the id is stored unvalidated, so a typo renders as a raw string. `UPDATE_PROJECT` cannot change it — `UPDATE_PROJECT_OWNER` does |
| `abstract` | one paragraph: what this project delivers, and why | Null unless you write it. It is the first thing a reader sees |
| `imageUrl` | optional cover image | — |
| `budgetType` | `BudgetType` | **Omitted ⇒ `CAPEX`**, not null. State the real one |
| `currency` | `PMCurrency` | **Omitted ⇒ `USD`**, not null |
| `budget` | fixes the envelope (`targetBudget`) | Omit for an envelope derived from its quotes; negative is `INVALID_INITIAL_BUDGET`. `UPDATE_PROJECT {budget: null}` releases it |
| `expenditure` | actual spend — `SET_PROJECT_EXPENDITURE {actuals, cap}` | `percentage` is derived: against `cap` when `cap > 0`, otherwise against `budget` |
| `scope` | the envelope's `DeliverablesSet` | Created empty at `DRAFT`. Only `status` is yours (`EDIT_DELIVERABLES_SET`); progress and counts are derived |
| `wbsRef` **PHID** | the WBS **document** that delivers this envelope | `LINK_PROJECT_WBS` — Step 3 |
| `knowledgeRefs` **[PHID]** | the vault notes / MOCs the work builds on | `ADD_PROJECT_KNOWLEDGE_REF`, one call each |
| `references` **[URL]** | external links | `SET_PROJECT_REFERENCES` **replaces** the list |

### The deliverable

`ADD_PROJECT_DELIVERABLE` carries exactly one field of its own — `title`. Everything
below it comes from a follow-up op, and what it writes instead are not blanks you can
spot later: `code`, `description`, `owner`, `icon` are `""`, not null.

| Field | What it means | Rule |
|---|---|---|
| `id` **OID** | the deliverable's id in the scope document | You mint it; it is `deliverableId` in every other op |
| `title` | what gets delivered — normally the top-level goal's description | The only field `ADD_PROJECT_DELIVERABLE` takes |
| `code` | `PKV-01` | `""` until `EDIT_DELIVERABLE` |
| `description` | what "done" means | `""` until `EDIT_DELIVERABLE`. `String!` in state, so it never reads as null — it reads as empty |
| `owner` | an agent id (PHID), the same ids as `projectOwner` | `""` on creation (null via `ADD_DELIVERABLE`) |
| `icon` | optional glyph | `""` on creation (null via `ADD_DELIVERABLE`) |
| `status` | `DeliverableStatus` | **Starts `DRAFT`.** `EDIT_DELIVERABLE {status}` is the only direct setter — move it to `TODO` when it is real, committed work |
| `goalRef` **OID** | the goal in the envelope's WBS whose subtree delivers this | `LINK_DELIVERABLE_GOAL`. Unvalidated — a wrong id is stored verbatim and nothing ever completes it |
| `budgetAnchor.project` **OID** | which envelope pays | Set for you by `ADD_PROJECT_DELIVERABLE`; `""` when created by `ADD_DELIVERABLE` |
| `budgetAnchor.unit` | `StoryPoints` or `Hours` | **Omitted ⇒ `Hours`**. Pass `StoryPoints` explicitly when that is the currency of the estimate |
| `unitCost`, `quantity` | the quote | `0` until set. Line budget = `unitCost × quantity × (1 + margin/100)`, 2 dp |
| `margin` | percent on top | Passing it **pins** it (Key semantics 4); negative values → `INVALID_BUDGET_ANCHOR` |
| `workProgress` | `SET_DELIVERABLE_PROGRESS` only | Percentage-0 from `ADD_PROJECT_DELIVERABLE`, null from `ADD_DELIVERABLE`. Never set it before work starts |
| `keyResults` | shipped artifacts — `{id!, deliverableId!, title!, link}` | `link` defaults to `""` |

Roadmaps and milestones default the same way: `slug`, `description`, `sequenceCode`
and `deliveryTarget` are all `""` when omitted, and `deliveryTarget` is a plain
`String!` — write an ISO `YYYY-MM-DD` so it sorts.

### The WBS goal

| Field | What it means | Rule |
|---|---|---|
| `id` **OID** | the goal's id inside the WBS document | You mint it; this is what a deliverable's `goalRef` carries |
| `description` | the goal's only text | Required. The deliverable title is normally taken from it |
| `status` | `GoalStatus` | **Always starts `TODO`** — `CREATE_GOAL` has no status input; use `SET_GOAL_STATUS` after |
| `parentId` **OID** | null = top level | Top-level goals are the ones that become deliverables. Create parents before children |
| `assignee` | free text — **not** an agent id | Spell it identically every time (Key semantics 7) |
| `dependencies` **[OID]** | other goal ids in the same WBS | `ADD_DEPENDENCIES`; self-dependency and unknown ids are rejected |
| `blockReason` | why it is stuck | Required for `BLOCKED`; cleared automatically on any other status |
| `outcome` | the artifact the goal produced | Send it with the `COMPLETED` status, or `SET_OUTCOME`. `SET_GOAL_STATUS` writes `outcome` only when truthy, so it can set one but never clear one |
| `notes` | `ADD_NOTE {goalId!, noteId!, note!, author, timestamp}` | `author` and `timestamp` default to **null** and nothing backfills them. Send both; timestamp full ISO-8601 `Z` |

The WBS document itself holds `owner` (free text), `references` (`SET_REFERENCES`
**replaces**), `sowRef` + `sowProjectId`, and the legacy `projectRef` (leave null).

### Which id goes where

Getting this wrong is the common failure, because **a project is an envelope inside a
document, not a document of its own**. `PHID` = another document. `OID` = something
inside this one.

| Field | Lives on | Kind | The value is |
|---|---|---|---|
| `wbsRef` | the envelope, in the scope doc | PHID | the **WBS document** id |
| `sowRef` | the WBS doc | PHID | the **scope document** id |
| `sowProjectId` | the WBS doc | OID | the **envelope's `id`** inside that scope — *not* the scope document id |
| `goalRef` | the deliverable, in the scope doc | OID | a **goal id** inside the WBS — *not* the WBS document id |
| `budgetAnchor.project` | the deliverable | OID | the envelope's `id` |
| `knowledgeRefs[]` | the envelope | PHID | note / MOC **document** ids |
| `projectOwner`, `Deliverable.owner`, `coordinators[]` | scope doc | agent id (PHID) | a `contributors[].id` created by `ADD_AGENT` |
| `assignee` | a WBS goal | String | free text, no id at all |

The two that get swapped are `sowProjectId` (envelope OID, the partner of `sowRef`)
and `goalRef` (goal OID, the partner of `wbsRef`). A few inputs type these as `ID`
rather than `OID`/`PHID` — `ADD_PROJECT_DELIVERABLE.deliverableId`,
`REMOVE_PROJECT.projectId`, the `*_DELIVERABLE_IN_SET` ids, `ADD_COORDINATOR.id` — a
schema wart, not a different kind of id.

### Reducer behaviours that quietly eat your input

- **`EDIT_DELIVERABLE` with an explicit `null` blanks a field, it does not skip it.**
  `title` / `code` / `description` become `""`, `owner` / `icon` clear, and only
  `status: null` is ignored. Omit what you do not mean to change.
  (`deliverables.ts:88-103`)
- **`UPDATE_PROJECT` is the opposite:** null on `title` / `code` / `slug` is ignored,
  null on `abstract` / `imageUrl` / `budgetType` / `currency` clears the field, and
  `budget: null` releases the fixed envelope. (`projects.ts:74-84`)
- **`SET_DELIVERABLE_PROGRESS` forces the status even with no progress in it.** An
  omitted or empty `workProgress` leaves progress untouched and still writes
  `IN_PROGRESS` (or `DELIVERED`). Sending more than one representation is not an
  error: `percentage` wins over `storyPoints` over `done`, silently.
  (`deliverables.ts:129-154`)
- **`EDIT_DELIVERABLES_SET.deliverablesCompleted` is discarded.** The same operation
  ends in `applyInvariants`, which recomputes both `progress` and
  `deliverablesCompleted` from the deliverables. Only `status` survives the write.
  (`deliverables-set.ts:28,59` → `projects.ts:448-457`)
- **Pass both `milestoneId` and `projectId` and nothing happens.**
  `EDIT_DELIVERABLES_SET` and `ADD_DELIVERABLE_IN_SET` need exactly one; with both,
  the action is recorded with no error and no change.
  `REMOVE_DELIVERABLE_IN_SET` instead acts on the milestone and ignores the project.
  (`deliverables-set.ts:15,40,91,126,181,204`)
- **`ADD_DELIVERABLE_IN_SET {projectId}` moves the payer:** it rewrites
  `budgetAnchor.project` to that envelope, and the remove rewrites it to `""`. The
  milestone forms leave the anchor alone. (`deliverables-set.ts:161-175,232-246`)
- **Deleting a container deletes its deliverables.** `REMOVE_MILESTONE` and
  `REMOVE_ROADMAP` delete every deliverable in scope — including ones an envelope
  funds and a goal delivers — wherever else they were listed.
  (`milestones.ts:152-155`, `roadmaps.ts:54-60`)
- **`REMOVE_AGENT` nulls what the agent held:** every `Deliverable.owner` and
  `Project.projectOwner` carrying that id, and every `coordinators` entry. Re-own
  first. (`contributors.ts:42-59`)
- **`SET_SOW_PROJECT_REF` writes both fields every time.** Sending only `sowRef`
  sets `sowProjectId` to null, leaving a WBS that points at a scope but at no
  envelope. Always send the pair. (`documentation.ts:41-42`)
- **`ADD_PROJECT_DELIVERABLE` collides across the whole document** — the id must be
  unused in `deliverables[]`, not just in this envelope. (`projects.ts:161-169`)
- **No reference is validated anywhere.** `wbsRef`, `sowRef`, `sowProjectId`,
  `goalRef`, `knowledgeRefs`, `projectOwner`, `owner` and `assignee` are stored as
  given; a reducer cannot see another document. A wrong id fails silently and is
  found months later. Read the target back after linking (Step 6).
  (`projects.ts:239,249`, `deliverables.ts:283`)

**The mistake to avoid: creating with one operation and moving on.**
`ADD_PROJECT_DELIVERABLE` reports success on `{projectId, deliverableId, title}`
alone, and leaves a deliverable with no code, no description, no owner, status
`DRAFT` and a quote of `0 Hours` — indistinguishable from work nobody planned, and
unfindable by code. The same run must follow with `EDIT_DELIVERABLE`
(code, description, owner, `status: "TODO"`), `LINK_DELIVERABLE_GOAL` and
`SET_DELIVERABLE_BUDGET_ANCHOR_PROJECT` — Step 4 is four operations for a reason.

## Step 6: Read an envelope and its WBS

**REQUIRED SUB-SKILL:** use scope-of-work (`lookup.py get` / `outline`).
`docs get` is for mutate ids after you already have them — envelope title is
not a document name.

Links are independent, not mirrored: read both directions rather than assuming one
implies the other. Step 3 sets both when creating a fresh pair.

## Step 7: The goal-working loop (unchanged from before)

Every agent picking up WBS work follows this loop:

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
   reactor. See [skills/search/SKILL.md](../search/SKILL.md).
5. **Record progress** — notes are append-only, dispatch as many as useful:
   ```bash
   switchboard docs mutate <wbs-id> --op addNote --input '{"goalId":"<goal-id>","noteId":"<unique-id>","note":"<what happened>","author":"<agent-name>","timestamp":"<ISO-Z>"}'
   ```
6. **Close it out — done or stuck:**
   ```bash
   switchboard docs mutate <wbs-id> --op setGoalStatus --input '{"id":"<goal-id>","status":"COMPLETED","outcome":"<artifact ref>"}'
   switchboard docs mutate <wbs-id> --op setGoalStatus --input '{"id":"<goal-id>","status":"BLOCKED","blockReason":"<why>"}'
   ```
   `BLOCKED` without a non-blank `blockReason` fails — see Key semantics.
7. **If the goal is a deliverable's `goalRef`**, close the deliverable out too — Step 8.

Steps 2–3 and 5–6 are dependent writes to the same document — they may share one
`docs apply` batch (order is preserved); read the document back afterwards, because a
rejected action is skipped silently.

## Step 8: Deliverable close-out (on the scope document)

Nothing cascades: completing a goal never touches the scope. Find the deliverable whose
`goalRef` is the goal you finished, then mark it delivered — either by progress, which
sets the status for you, or by status directly:

```bash
switchboard docs get <scope-id> --state --format json | python3 -c "
import json, sys
g = json.load(sys.stdin)['state']['global']
for d in g['deliverables']:
    if d.get('goalRef') == '<goal-id>': print(d['id'], d['code'], d['status'])
"
switchboard docs mutate <scope-id> --op setDeliverableProgress --input '{"id":"<deliverable-id>","workProgress":{"done":true}}'
# and the shipped artifact, if there is a URL for it
switchboard docs mutate <scope-id> --op addKeyResult --input '{"id":"<kr-id>","deliverableId":"<deliverable-id>","title":"Shipped","link":"https://…"}'
```

## Operations: `powerhouse/scopeofwork` (7 modules, 39 ops)

Ground truth: `document-models/scope-of-work/v1/schema.graphql` in the
`bai-knowledge-note` repo. The table shows the canonical `SCREAMING_SNAKE_CASE` name —
the `type` in a `docs apply` action; `docs mutate --op` takes the camelCase form.

**scope_of_work** — `EDIT_SCOPE_OF_WORK { title, description, status }`

**projects** (the envelopes)

| Op | Input | Errors |
|---|---|---|
| `ADD_PROJECT` | `{ id!, code!, title!, slug, projectOwner, abstract, imageUrl, budgetType, currency, budget }` — a `budget` fixes the envelope | `PROJECT_ALREADY_EXISTS`, `INVALID_INITIAL_BUDGET` |
| `UPDATE_PROJECT` | `{ id!, code, slug, title, abstract, imageUrl, budgetType, currency, budget }` — `budget: null` releases a fixed envelope | `INVALID_BUDGET_UPDATE` |
| `UPDATE_PROJECT_OWNER` | `{ id!, projectOwner! }` (agent id) | — |
| `REMOVE_PROJECT` | `{ projectId! }` — **deletes the deliverables it funds** | `PROJECT_NOT_FOUND` |
| `SET_PROJECT_MARGIN` | `{ projectId!, margin! }` — applies to every unpinned quote | `INVALID_PROJECT_MARGIN` |
| `SET_PROJECT_TOTAL_BUDGET` | `{ projectId!, totalBudget! }` | `INVALID_PROJECT_BUDGET` |
| `ADD_PROJECT_DELIVERABLE` | `{ projectId!, deliverableId!, title! }` — **creates** the deliverable and scopes it | `PROJECT_DELIVERABLE_ALREADY_EXISTS` |
| `REMOVE_PROJECT_DELIVERABLE` | `{ projectId!, deliverableId! }` | — |
| `SET_PROJECT_EXPENDITURE` | `{ projectId!, actuals, cap }` | `INVALID_EXPENDITURE` |
| `LINK_PROJECT_WBS` | `{ projectId!, wbsRef }` (null unlinks) | — |
| `ADD_PROJECT_KNOWLEDGE_REF` | `{ projectId!, ref! }` — PHID of a vault note/MOC | `KNOWLEDGE_REF_ALREADY_EXISTS` |
| `REMOVE_PROJECT_KNOWLEDGE_REF` | `{ projectId!, ref! }` | `KNOWLEDGE_REF_NOT_FOUND` |
| `SET_PROJECT_REFERENCES` | `{ projectId!, references! }` — **replaces** | — |

**deliverables**

| Op | Input | Errors |
|---|---|---|
| `ADD_DELIVERABLE` | `{ id!, owner, title, code, description, status }` — unscoped; prefer `ADD_PROJECT_DELIVERABLE` | `DELIVERABLE_ALREADY_EXISTS` |
| `EDIT_DELIVERABLE` | `{ id!, owner, icon, title, code, description, status }` — the way to set/correct status | — |
| `REMOVE_DELIVERABLE` | `{ id! }` — also removed from every project and milestone scope | — |
| `SET_DELIVERABLE_PROGRESS` | `{ id!, workProgress: { percentage \| storyPoints{total,completed} \| done } }` — **forces status**: complete → `DELIVERED`, anything else → `IN_PROGRESS`; refused on `CANCELED`/`WONT_DO` | `INVALID_PROGRESS`, `DELIVERABLE_CLOSED` |
| `LINK_DELIVERABLE_GOAL` | `{ deliverableId!, goalRef }` — a goal in the anchoring envelope's WBS; null unlinks | `DELIVERABLE_NOT_FOUND` |
| `SET_DELIVERABLE_BUDGET_ANCHOR_PROJECT` | `{ deliverableId!, project, unit, unitCost, quantity, margin, marginPinned }` — only the fields given change; a given `margin` pins itself | `INVALID_BUDGET_ANCHOR` (negative) |
| `ADD_KEY_RESULT` / `EDIT_KEY_RESULT` / `REMOVE_KEY_RESULT` | `{ id!, deliverableId!, title, link }` — the shipped-artifact URL lives here | `KEY_RESULT_ALREADY_EXISTS` |

**roadmaps** — `ADD_ROADMAP { id!, title!, slug, description }` · `EDIT_ROADMAP` · `REMOVE_ROADMAP { id! }`

**milestones** — `ADD_MILESTONE { id!, roadmapId!, sequenceCode, title, description, deliveryTarget }` · `EDIT_MILESTONE` · `REMOVE_MILESTONE { id!, roadmapId! }` · `ADD_COORDINATOR` / `REMOVE_COORDINATOR { id!, milestoneId! }` (agent id) · `ADD_MILESTONE_DELIVERABLE { milestoneId!, deliverableId!, title! }` (**creates**) · `REMOVE_MILESTONE_DELIVERABLE`

**deliverables_set** — `ADD_DELIVERABLE_IN_SET` / `REMOVE_DELIVERABLE_IN_SET { milestoneId | projectId, deliverableId! }` (an **existing** deliverable joins/leaves a milestone or envelope scope) · `EDIT_DELIVERABLES_SET { milestoneId | projectId, status, deliverablesCompleted }` — the set status is **set by a person**, not derived

**contributors** — `ADD_AGENT { id!, name!, icon, description }` · `EDIT_AGENT` · `REMOVE_AGENT { id! }` (`AGENT_ALREADY_EXISTS`, `AGENT_NOT_FOUND`)

## Operations: `bai/wbs` (3 modules, 15 ops)

Ground truth: `document-models/work-breakdown-structure/v1/schema.graphql`.

**goals**

| Op | Input | Errors |
|---|---|---|
| `CREATE_GOAL` | `{ id!, description!, parentId, assignee, insertBefore }` — appends as last child of `parentId` (or last root); starts `TODO` | `DUPLICATE_GOAL_ID`, `GOAL_NOT_FOUND` |
| `UPDATE_GOAL_DESCRIPTION` | `{ id!, description! }` | `GOAL_NOT_FOUND` |
| `DELETE_GOAL` | `{ id! }` — removes the whole subtree + strips dangling `dependencies` | `GOAL_NOT_FOUND` |
| `REORDER` | `{ id!, parentId, insertBefore }` | `GOAL_NOT_FOUND`, `INVALID_PARENT` |

**workflow**

| Op | Input | Errors |
|---|---|---|
| `SET_GOAL_STATUS` | `{ id!, status!, blockReason, outcome }` — `BLOCKED` requires `blockReason`; it auto-clears on any other status | `GOAL_NOT_FOUND`, `MISSING_BLOCK_REASON` |
| `ASSIGN_GOAL` | `{ id!, assignee }` (falsy unassigns) | `GOAL_NOT_FOUND` |
| `SET_OUTCOME` | `{ id!, outcome }` (falsy clears) | `GOAL_NOT_FOUND` |
| `ADD_DEPENDENCIES` / `REMOVE_DEPENDENCIES` | `{ id!, dependencies! }` | `GOAL_NOT_FOUND`, `DEPENDENCY_NOT_FOUND`, `INVALID_DEPENDENCY` |

**documentation**

| Op | Input | Errors |
|---|---|---|
| `ADD_NOTE` | `{ goalId!, noteId!, note!, author, timestamp }` — append-only | `GOAL_NOT_FOUND`, `DUPLICATE_NOTE_ID` |
| `REMOVE_NOTE` | `{ goalId!, noteId! }` | `GOAL_NOT_FOUND`, `NOTE_NOT_FOUND` |
| `SET_OWNER` | `{ owner }` (falsy clears) | — |
| `SET_REFERENCES` | `{ references! }` — **replaces** | — |
| `SET_SOW_PROJECT_REF` | `{ sowRef, sowProjectId }` — the scope document and the envelope inside it; both null unlinks | — |
| `SET_PROJECT_REF` | `{ projectRef }` — **legacy** (pointed at `bai/project`); leave null | — |

## Enums (write exactly these values)

| Field | Values |
|---|---|
| `ScopeOfWorkStatus` | `DRAFT`, `SUBMITTED`, `IN_PROGRESS`, `REJECTED`, `APPROVED`, `DELIVERED`, `CANCELED` |
| `DeliverableStatus` | `WONT_DO`, `DRAFT`, `TODO`, `BLOCKED`, `IN_PROGRESS`, `DELIVERED`, `CANCELED` |
| `DeliverableSetStatus` (an envelope's or milestone's set) | `DRAFT`, `TODO`, `IN_PROGRESS`, `FINISHED`, `CANCELED` |
| `Unit` | `StoryPoints`, `Hours` |
| `BudgetType` | `CONTINGENCY`, `OPEX`, `CAPEX`, `OVERHEAD` |
| `PMCurrency` | `DAI`, `USDS`, `EUR`, `USD` |
| `GoalStatus` | `TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `COMPLETED`, `WONT_DO` |

Note the spelling: `CANCELED` (one L) everywhere in the scope. `WONT_DO` is excluded
from goal-progress denominators. The pre-dispatch linter (`scripts/lint-actions.mjs`)
checks every one of these and blocks the write if a value is off.

The input side mirrors the first five under separate type names
(`ScopeOfWorkStatusInput`, `PMDeliverableStatusInput`, `DeliverableSetStatusInput`,
`PMBudgetTypeInput`, `PMCurrencyInput`) with identical values; `Unit` and `GoalStatus`
are referenced directly. **Omitting an enum is not the same as sending null** —
`ADD_PROJECT` stores `CAPEX` and `USD`, both deliverable-creating ops store `Hours` and
`DRAFT`, and `CREATE_GOAL` stores `TODO`. See § *Populate every field*.

## Key semantics

1. **A project is an envelope inside a scope document, not a document.** It has no
   documentId of its own — cite the **scope** (`[[<scope-id>]]`) when you state
   something about a project or deliverable, and the WBS (`[[<wbs-id>]]`) when you draw
   on the goal tree. Only scopes and WBS documents are `setSelectedNode` targets.
2. **Creating through the envelope.** `ADD_PROJECT_DELIVERABLE` and
   `ADD_MILESTONE_DELIVERABLE` both **create** a deliverable (and throw if the id
   exists). To place an existing deliverable in a milestone or another envelope, use
   `ADD_DELIVERABLE_IN_SET`. A deliverable can sit in one envelope scope and one
   milestone scope at the same time; its **payer** is `budgetAnchor.project`.
3. **Progress writes status.** `SET_DELIVERABLE_PROGRESS` sets `DELIVERED` when the
   progress is complete (100%, all points, or `done: true`) and `IN_PROGRESS`
   otherwise — so **never record progress on unstarted work** (`done: false` on a
   `TODO` item reopens it as in-progress). There is no operation that clears progress;
   correct a status with `EDIT_DELIVERABLE { status }`. Switching the progress *kind*
   in the editor fires this operation too.
4. **Budgets are derived from quotes.** An envelope's `budget` is
   Σ `unitCost × quantity × (1 + margin/100)` over its deliverables unless it was fixed
   (`ADD_PROJECT`/`UPDATE_PROJECT` with a `budget`, or `SET_PROJECT_TOTAL_BUDGET`), in
   which case unpinned margins are derived to make the lines add up. A `margin` you
   pass to `SET_DELIVERABLE_BUDGET_ANCHOR_PROJECT` **pins** itself; `marginPinned: false`
   releases it. A budget of `0` means "nothing quoted yet", not zero dollars.
5. **Set status is manual.** An envelope's or milestone's `scope.status`
   (`DeliverableSetStatus`) is set with `EDIT_DELIVERABLES_SET` and is **not** derived
   from its deliverables — 4 of 7 delivered can legitimately still read `DRAFT`. Update
   it when the work's state changes.
6. **Links are explicit and independent; nothing cascades.** `LINK_PROJECT_WBS` and
   `SET_SOW_PROJECT_REF` are two writes on two documents (Step 3). Completing a goal
   does not deliver its deliverable (Step 8); completing every child does not complete
   the parent goal. Set each explicitly.
7. **People are the weak spot.** A scope's `contributors[].id` is a PHID string
   (`ADD_AGENT`), `Deliverable.owner` / `Project.projectOwner` / `Milestone.coordinators`
   name that id, but a WBS goal's `assignee` is **free text**. Reuse one agent id per
   person, spell assignees the same way every time, and never write `"Frank & liberuum"`
   as one assignee — split the goal or pick one.
8. **Goal order is meaningful.** `goals[]` is kept depth-first after every structural
   change; array order **is** display order. Insert/move with `insertBefore` (an id),
   never an index; `REORDER` under a descendant throws `InvalidParentError`.
9. **`SET_GOAL_STATUS` to `BLOCKED` requires `blockReason`.** The rejected operation is
   still recorded with a non-null `.error`; state is unchanged. Re-read state after any
   status change.
10. **Timestamps are full ISO-8601, Z-suffixed** (`ADD_NOTE.timestamp` etc.); the CLI
    injects the action envelope's own `id`/`timestampUtcMs` but never these.
11. **`DELETE_GOAL` deletes the subtree; `REMOVE_PROJECT` deletes the deliverables it
    funds.** Read before deleting.
12. **Progress % over goals is a leaf-only measure.** `goalRollup()` counts
    `total`/`finished`/`pct` over leaf goals only (parents are aggregates), while
    `blocked`/`inProgress` count every row. Adding goals lowers the displayed % with no
    work undone — say so when reporting. A `TODO` parent over a `COMPLETED` child is a
    stale status, not a data error; fix it before quoting a number.
13. **Older data may predate the fields.** Envelopes written before `knowledgeRefs` /
    `references` / `wbsRef` existed store none of them; read them as empty, never as an
    error. Migrated envelopes carry their old `bai/project` deliverables with the same
    goal ids, so `goalRef`s still resolve.

## Rules

- **Never create a `bai/project`.** The type is retired; the model is gone from the
  repository. If a vault still holds one, migrate it into an envelope (Step 2–5) and
  archive or delete the document — do not write to it.
- **Never leave a goal `IN_PROGRESS` at session end.** Every goal you moved to
  `IN_PROGRESS` must end `COMPLETED`, `BLOCKED` (with a real `blockReason`), or carry a
  note saying where it stands. An honest `BLOCKED` beats a stale `IN_PROGRESS`.
- **One scope per team/programme/client; envelopes inside it.** Check Step 1 before
  creating a scope, and check the envelope list before adding a duplicate code.
- **Create documents with `--parent-folder <projects-folder-uuid>`.** Scopes and WBS
  documents go directly under `/projects/` — no per-project subfolder.
- **Link both ways in the same run** (Step 3). A WBS without `sowRef` cannot show
  which envelope it delivers; an envelope without `wbsRef` cannot import goals.
- **Fill every field in the run that creates it.** `ADD_*` writes defaults, not nulls,
  so an unfinished envelope, deliverable or goal is indistinguishable from a deliberate
  one. See § *Populate every field — the work contract*.
