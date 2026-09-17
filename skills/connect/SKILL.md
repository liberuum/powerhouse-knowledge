---
name: connect
description: Find connections between knowledge notes and create links. Use after extracting notes, when exploring relationships, or when a topic needs synthesis.
---

# Connect Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

The reflect phase: turn isolated claims into a graph. A link is itself a claim —
*A relates to B in this specific way* — and it is only worth as much as the
sentence that justifies it. Connecting is where a new claim gets encoded into
what the vault already knows; a note without articulated connections is
structurally present and cognitively orphaned.

## Process

1. **Identify the target note** and read it — title, description, content.
2. **Find candidates**, several ways:
   - `knowledgeGraphSimilar(documentId)` — semantic neighbours, no keyword overlap needed
   - `knowledgeGraphSemanticSearch(query, mode: SEMANTIC)` with the note's claim phrased as a question. Asking how two things relate? Search the **narrower** one alone
   - `knowledgeGraphRelatedByTopic(documentId)` — shared topics
   - `knowledgeGraphFullSearch(query)` — a literal substring; give it **one** distinctive term
   - **The batch itself**: the other notes from this source and from sources in the same `/sources` folder. Cross-source juxtaposition surfaces relationships that source-by-source processing misses
3. **Articulate.** For each candidate complete *"[A] connects to [B] because …"*
   in one sentence a reader can check. That sentence **is** the edge's `reason`.
   If you cannot write it, there is no link — waiting for a genuine fit builds
   a better graph than linking for activity's sake.
4. **Create the edge** with its type, reason and confidence.

```bash
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/relationships" \
  -d '{"source":"<a>","target":"<b>","type":"BUILDS_ON","reason":"<why>","confidence":"grounded"}'
# PATCH the same body to change a reason; DELETE {source,target,type} to remove

switchboard docs link <a> <b> -t BUILDS_ON --reason "<why>" --confidence established
switchboard docs annotate <a> <b> -t BUILDS_ON --reason "<new why>"     # a repeated `docs link` is a no-op, metadata included
switchboard docs unlink <a> <b> -t BUILDS_ON
```

## The edge contract

An edge is five fields wide. `source`, `target`, `type` record *that* two notes
connect; `reason` and `confidence` are the two a reader can use — and the two a
hurried run leaves null.

| Field | Rule |
|---|---|
| `source` → `target` | **Direction is a claim.** `A BUILDS_ON B` says A extends B; never add the reverse "for symmetry". The note whose content should mention the relationship is the source |
| `type` | One of the seven indexed types (below). Any other string is stored by the reactor and reaches nothing |
| `reason` | Required on the five knowledge types. A sentence ≥ 20 chars; rejected if it is the type restated or a placeholder (`because`, `todo`, `tbd`, `related`, `n/a`, `none`). **Specificity test:** if the sentence could describe any pair of notes, it has not processed *this* pair. "extends B by adding detail" ✗ · "extends B's per-read-model claim to every read model, by naming the shared cache" ✓. Name the claims, not the titles |
| `confidence` | `grounded` (evidence or a source backs the link) · `established` (well accepted, not evidenced here) · `speculative` (a lead worth recording). Exactly those three, lowercase. **Nothing rejects an edge for lacking one** — set it every time |

**Two surfaces validate, and they disagree.** `POST /relationships` checks reason
*and* confidence and returns `400 LINT_CONVENTION` on either (including on
`CORE_IDEA`, where the confidence check runs before the bare-type exemption).
`docs link` is checked only by the plugin's pre-write hook, which enforces the
reason but **not** the confidence value — `Grounded`, `high`, `strong` are
dropped silently and the edge lands articulated but unrated. Spell it from the
three, or use REST and let the 400 catch you. Reasons starting with a dash need
the attached form (`--reason=--base is …`).

The reason lives on the edge (CLI ≥ 1.0.36) and comes back on every edge read;
`/health` reports the share of knowledge edges that carry one. Edges live in
the reactor's `DocumentRelationship` table; the legacy `addLink` op writes a
per-document array the graph does not index. `docs link` is signed as you when
the profile has a signing identity — the raw `addRelationship` GraphQL mutation
is server-signed and cannot carry a reason, which is why the hook refuses it.

## Choosing the type

| Type | Use when | Note |
|---|---|---|
| `BUILDS_ON` | A extends, specifies, supports or provides the mechanism for B | The default for a genuine relationship |
| `CONTRADICTS` | A and B cannot both hold as stated | The indexer opens a `bai/tension` — see below. Scope them first: a claim true in a narrower scope is unbounded, not wrong |
| `SUPERSEDES` | A replaces B | Then `ARCHIVE_NOTE` B with a comment — legal only from `CANONICAL`, so walk B there first if it is still `DRAFT`. Knowledge is retired, not deleted |
| `RELATES_TO` | A thematic connection that is none of the above | Last resort. If you reach for it, ask whether the link is real |
| `DERIVED_FROM` | note → source, written by extract | Reason = the locus in the source |
| `CORE_IDEA`, `CHILD_MOC` | MoC → note, MoC → MoC | Navigation; written by synthesize. May be bare for the hook — synthesize says why they should not be |

**Density.** Every note ends reflect with ≥ 2 knowledge edges and ≥ 1
**incoming** edge — an orphan is a node nobody points at, and outgoing links do
not fix it. Atomic notes carry 3–6 links in a healthy graph; a note past ~15 is
bundling claims or wants to be a MoC.

**Write it into the body when the link changes what the note means.** The edge
carries the reason; the content carries the argument. A contradiction, a
condition another note adds, a supersession — say it in the note in a sentence
that names the other note. Do not append lists of titles.

**Articulate the backlog.** Edges created before 1.0.36 or by an import come back
with `reason: null` from `knowledgeGraphForwardLinks`. Read both notes; if the
connection is real, `docs annotate` it with the sentence. If, having read both,
you cannot complete the sentence, `docs unlink` it and say so — never invent a
reason to turn a WARN green.

## Tensions

**The indexer opens them.** On a Switchboard with vault package ≥ 1.0.55, a
`CONTRADICTS` edge makes the graph-indexer create a `bai/tension` in the drive's
`/ops` (title `Contradiction on <shared topics or words>`, both claims quoted in
the description, `involvedRefs [a, b]`, `observedBy: graph-indexer`) and add an
`ADD_TENSION` entry to every MoC holding either note as a `CORE_IDEA`. One
tension per unordered pair, ever. Two gates: it acts only on operations stamped
**live** (an edge imported, backfilled or replayed at boot opens nothing) and
only when **both** notes belong to its drive.

After a `CONTRADICTS` edge, read the tension back — it is the `INVOLVES`
backlink on either note:

```bash
switchboard query '{ knowledgeGraphBacklinks(driveId:"<UUID>", documentId:"<note-a>") { sourceDocumentId linkType } }'
switchboard docs get <tension-id> --state --format json
```

Then **articulate it** — the automation knows the two titles, you know why they
conflict. `CREATE_TENSION` is write-once for `title`, `description` and
`content` (no update op exists; re-dispatching it overwrites everything and
forces `OPEN` while leaving the old `resolution` in place), so the articulation
goes where readers meet it: a short "Contradicts" paragraph in each note's
content naming the other note and the point of conflict. Add further parties
with `ADD_INVOLVED_REF` (deduped). Then close it when you can — both closers
throw `TensionAlreadyResolvedError` if the tension is not `OPEN`:

- **Resolve** (`RESOLVE_TENSION {resolution, resolvedAt}`) when one side is right; consider `SUPERSEDES` on the winner.
- **Dissolve** (`DISSOLVE_TENSION`) when both hold in different scopes — and write the boundary into both notes.

Three patterns that look unresolvable and are not:

- **A defect filed as a tension.** A design note describes the intended path, a bug note the failure path — both true. Dissolve, write the boundary, keep the defect as a note plus a `/health` recommendation. The tension list answers "what does the vault not know yet"; a documented bug with an owner is something it knows well.
- **A claim true in a narrower scope.** Scope it in place (this edition, this version, this jurisdiction), link the evidence with reasons, resolve in favour of the sources. Deleting it throws away the part that still holds.
- **A decision that is not yours.** Correct the notes, then move the call to `ADD_OPEN_QUESTION` on the MoC that holds the cluster.

Create a tension by hand only when the automation could not have fired — an
older Switchboard, an imported or replayed edge, a cross-drive pair — filling
every field in the one `CREATE_TENSION` you get (`title`, `description` quoting
both claims, `content` saying what A holds, what B holds, why it matters and
what would settle it, `involvedRefs`, `observedAt`, `observedBy`), then
`ADD_TENSION` on the MoC with the tension's **document id**.

## Grounding in the methodology — only where it is genuine

The 249 Ars Contexta claims live on disk (`data/methodology/*.md`, unpacked by
`node scripts/methodology.mjs`), not in the vault, so grounding is written into a
note's content, not as an edge. It applies **only** to notes whose claim is
about knowledge work, agent cognition, documentation or retrieval — the
methodology's own territory. A note about PGlite tables has no methodology
counterpart; grounding it is a fabricated link that fails the articulation
test, and its absence is not a defect.

When a note is in scope: find the claim by title (`grep -ril "<term>"
data/methodology/*.md`, then read it), and append a `## Grounding` section that
cites the exact claim title in prose with the specific relationship — *builds
on*, *contradicts* or *relates to* — and one sentence saying how. Read the
current content first: `SET_CONTENT` replaces the whole body.

```markdown
## Grounding
Builds on **"claims must be specific enough to be wrong"** — the six-gate falsifiability test is that claim applied at extraction time.
```

`/health` reports grounded ÷ in-scope in `recommendations`, never grounded ÷ all
notes. Do not write a grounding section to move that number.

## Handoff

In a pipeline run, `ADVANCE_PHASE` with phase `reflect`. `workDone` is the
packet for reweave: edges created by type, tensions opened and how they were
left, notes still under 2 edges and why, older notes you noticed that the new
claims qualify or supersede. `filesModified` = every note whose edges or
content changed.

## Quality rules

- Every knowledge edge carries a reason that passes the articulation **and**
  specificity tests, and a confidence from the three.
- Prefer the specific type; `RELATES_TO` is a last resort; direction is a claim.
- ≥ 2 knowledge edges and ≥ 1 incoming edge per note before advancing.
- Update a note's content when a link changes what it means.
- After `CONTRADICTS`, read the indexer's tension back, articulate it in both
  notes, resolve or dissolve when you can; never open a duplicate by hand.
- Ground only in-scope notes; never invent a grounding.

If "$ARGUMENTS" is provided, find connections for that specific note.
