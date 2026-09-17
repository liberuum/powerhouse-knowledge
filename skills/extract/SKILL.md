---
name: extract
description: Extract atomic knowledge claims from source material. Creates bai/knowledge-note documents from a bai/source document, preserving the provenance chain.
---

# Extract Atomic Claims

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

Read a source, work out what is **true** in it, and write each truth as an
independent `bai/knowledge-note` that stands without the source and can meet
claims from other sources.

This is the vault's most important operation. Everything downstream — connect,
synthesize, verify, health — operates on what it produces, and noise written
here is never cleaned up: it is linked to, counted and surfaced in search
forever. **Transform, do not harvest.** The source document is already the
archive. A note that could have been produced by copying from it is a
duplicate with worse provenance.

## Method — read, then write; never read-and-write

1. **Read the whole source first — the `bai/source`, not the original file.**
   A claim in §1 is often qualified in §4, so read all of it before writing.
   And read it *from the vault*: the source document is what every
   `DERIVED_FROM` edge points at and what a reader will check the claim
   against, so it is the object of record even when the file it came from is
   on your disk. The two can differ silently — content truncated at ingest, a
   failed re-ingest leaving an older revision, an encoding fault, a file edited
   afterwards — and extracting from the file then writes claims the source
   cannot support behind an edge asserting it can. If they differ, fix the
   source first.
2. **List candidate claims** as sentences in your own words, source closed.
3. **Run the six gates** over each candidate. Strike the failures.
4. **Search the vault before writing each survivor**
   (`GET search?q=<the claim>&mode=semantic`). If it already exists, do not
   duplicate it: strengthen the existing note's content with this source's
   evidence and add a second `DERIVED_FROM` edge. Two sources arguing the same
   thing meet at **one** node — that convergence is the point of
   concept-orientation; duplicate nodes are how graphs rot.
5. **Write the survivors** — one batch per note, every field (below).
6. **Count honestly.** `claimCount` = notes written; `skippedCount` = candidates
   struck at step 3 plus material you judged out of scope.
7. **Close out the source**, then record the handoff.

## The six gates — a claim passes all six or it is not written

Run them in order; the first failure stops the note.

| # | Gate | The test | Fails when |
|---|---|---|---|
| 1 | **Sentence** | Does the title complete *"This note argues that …"*? | `Emotion` · `Attraction Offers` · `FIGURE 14-2` — labels and captions |
| 2 | **Transclusion** | Does the title work as a clause: *"Since [title], it follows that …"*? | A question, a fragment, a noun phrase |
| 3 | **Falsifiability** | Could a competent practitioner **disagree** with this specific assertion? | "Quality matters" — true, empty, nothing can build on it |
| 4 | **Coherence** | Can you state it in 1–3 sentences without an "and also"? | Bundled claims: "how X works, why Y matters, when to Z" is three notes |
| 5 | **Independence** | Does it hold for a reader who has never seen the source? | It needs the chapter's running example to parse |
| 6 | **Non-attribution** | Does the title assert what is **true**, not what the **author said**? | "Hormozi says you should …" — attribution lives in provenance, never in the claim |

Gate 3 does the most work: a claim nobody could disagree with is a claim nobody
can engage with. Gate 6 is the one agents fail most on books — extract the
knowledge, not the reading.

**Not a claim, however quotable:** an excerpt or quotation (cite it in a body as
evidence); a chapter summary (about the source, not the world); a heading or
topic label (a MoC at best); a caption, table title or structural artefact; a
story or anecdote (evidence — the claim is the mechanism it demonstrates); a
bare number (the claim is what moves it, and when); a restatement of the
source's structure ("there are four types of X" is a claim only if the cut is
the insight, and then the title says what the cut is); a definition with no
stake.

**Conditions travel inside the claim.** Atomicity strips argumentative context,
and the claims most at risk are heuristics and trade-offs whose truth depends
on *when* they apply. Put the condition in the claim, do not skip the claim:

- ❌ "Discounting the first month increases retention"
- ✅ "Discounting the first month increases retention only when the product's value is felt before the second charge; otherwise it buys churn"

A claim that cannot carry its own conditions is not yet understood or not yet
atomic. Either way: do not write it yet.

**When decomposition resists**, try the split twice. If each piece passes all six
gates, write them. If they only make sense together, write **one** note whose
title carries the joint claim. Never three fragments that each fail gate 5.

**Zero is a valid yield.** There is no coverage target; `skipRate` is a
measurement, not a goal. A section introduction, a recap, a foreword, a glossary
can honestly yield nothing, and writing a note anyway to avoid an empty result
is the most damaging thing an agent can do here — noise never announces itself,
it just dilutes every query that touches its topic. A high skip rate is a
finding about the source; the failure to watch for is the opposite: a
*suspiciously complete* extraction (every chapter at `skipRate: 0`) means
excerpts were filed as claims.

## What a note holds — the claim and its basis

A note records the claim **and why the vault holds it**. Progressive disclosure:
title → description → content, each layer adding what the previous lacks.

- **Title** — the claim, as a declarative sentence (gates 1–2).
- **Description** — a retrieval filter, not a summary. It answers "should I open
  this?" and "which of the similar notes is this one?" Never paraphrase the
  title. Layer it: what holds (heuristic) → why (mechanism) → so what
  (implication). If the sentence could describe several notes in the vault, it
  is not distinctive enough. ≤ 200 UTF-16 units; aim ~150.
- **Content** — the argument, not the assertion again:
  the mechanism; the evidence from the source (quotation or anecdote, *cited as
  evidence*); the conditions under which the claim holds and when it does not;
  what it qualifies, extends or disputes in the vault, by note title; and what
  extracting it lets a reader do or predict. This is what makes the note
  self-supporting once the source has left context.
- **Topics** — at least one. Reuse the vault's vocabulary
  (`knowledgeGraphTopics`) before minting a new name.
- **Metadata** — the typed layer that makes claims comparable (below). At
  minimum `confidence`.
- **Provenance — two layers, both required.**
  *Documentary* (where it came from): `SET_PROVENANCE` with `author` = your
  agent id, `sourceOrigin: DERIVED`, `createdAt` = now; plus one `DERIVED_FROM`
  edge to the source whose `--reason` names the **locus** ("§ 'Storage', para 3
  …") so a reader can check the claim against the text.
  *Epistemic* (how well it is known): the `confidence` metadata field —
  `grounded` (the source demonstrates it, or you verified it in code or data),
  `established` (documented and widely agreed), `speculative` (your inference).
  The edge's own `--confidence` rates the *extraction*: `grounded` for a claim
  the source makes, `speculative` for one you inferred from it.

### Field contract — `bai/knowledge-note`

| Field (op) | Rule |
|---|---|
| `title` (`SET_TITLE`) | Required. No length limit |
| `description` (`SET_DESCRIPTION`) | Required. ≤ 200 UTF-16 units — the only hard length limit in any model. Over the limit → `DescriptionTooLongError`; the note lands **without** a description while the rest of the batch applies |
| `noteType` (`SET_NOTE_TYPE`) | One of the ten `NoteType` enum values (below). Anything else is rejected by the reducer — the action is recorded with its error and the note is left typeless |
| `content` (`SET_CONTENT`) | Real line breaks, encoded once |
| `topics[]` (`ADD_TOPIC`) | ≥ 1. Fresh OID per topic. Throws `DuplicateTopicError` on a repeated **name** (`REMOVE_TOPIC` matches **id**) — a re-run fails its topic actions, which is expected |
| `provenance` (`SET_PROVENANCE`) | `{author, sourceOrigin, sessionId?, createdAt}`. `updatedAt` is not an input; the reducer sets it to `createdAt` |
| 18 string fields (`SET_METADATA_FIELD`) | Whitelist: `scope confidence severity editor modelId version filePath computes context decisionStatus model sourceType targetType relationType cardinality errorMessage rootCause correctPattern`. `""` writes null — omit the action to say "not applicable". Unknown name → `InvalidMetadataFieldError` |
| 9 list fields (`SET_METADATA_LIST_FIELD`) | Whitelist: `models hooksUsed dispatchTargets modules inputs outputs consumedBy alternatives consequences`. The scalar op rejects these names |
| `status` | Starts `DRAFT`; extract does not move it |
| `links[]` | Legacy. Nothing writes it; edges live in the relationship table (`docs link`) |

**`noteType`** — `CONCEPT` (idea or principle) · `PATTERN` (recurring solution) ·
`ARCHITECTURE` (design structure) · `DECISION` (choice with rationale) ·
`OBSERVATION` (empirical finding) · `PROCEDURE` (how-to) · `REFERENCE`
(lookup fact) · `BUG_PATTERN` (failure and cause) · `INTEGRATION` (how two
things connect) · `WORKFLOW` (end-to-end process).

### Metadata by `noteType` — fill what the source supports, leave the rest empty

On every note where the source says so: `confidence` (above), `scope`
(`global` | `team` | `personal`), `version` (the stack version observed, only
when stated), `filePath`, `model` (`reducer` `hook` `component` `processor`
`subgraph` `editor` `cli` `document-model`), `modelId` (the document type),
`editor` (your agent id).

| noteType | Populate |
|---|---|
| `BUG_PATTERN` | `severity` (`critical`/`warning`/`info`), `errorMessage`, `rootCause`, `correctPattern` |
| `DECISION` | `decisionStatus` (`proposed`/`accepted`/`rejected`/`superseded`), `context`, `alternatives[]`, `consequences[]` |
| `ARCHITECTURE` | `models[]`, `modules[]`, `computes`, `inputs[]`, `outputs[]`, `consumedBy[]`, `dispatchTargets[]` |
| `INTEGRATION` | `sourceType`, `targetType`, `relationType`, `cardinality`, `inputs[]`, `outputs[]` |
| `PATTERN` | `correctPattern`, `context`, `hooksUsed[]`, `alternatives[]` |
| `PROCEDURE` | `context`, `inputs[]`, `outputs[]`, `filePath`, `version` |
| `WORKFLOW` | `inputs[]`, `outputs[]`, `consumedBy[]`, `dispatchTargets[]` |
| `REFERENCE` | `modelId`, `version`, `filePath`, `model` |
| `CONCEPT` | `scope`, `confidence` |
| `OBSERVATION` | `confidence`, `severity`, `context` |

An invented `severity` is a lie; an empty one is honest. A code-derived
`BUG_PATTERN` whose editor panel reads `Metadata (0)` is under-extracted.

## Writing the batch

One batch per note; actions run in order and a rejected action is skipped while
the rest land. Lint first, then read `jobStatus(jobId).result.allApplied`.

1. **`SET_PROVENANCE` anywhere in the batch.** Every content, metadata and
   lifecycle reducer stamps the note's top-level `updatedAt`, so order no longer
   loses timestamps. `provenance.createdAt` is immutable once set — a later
   correction of `author`/`sourceOrigin` must pass the same `createdAt` back.
2. **Lint before dispatch**: `node scripts/lint-actions.mjs <actions.json>` —
   it counts the description the way the reducer does (UTF-16 units; an emoji
   is 2, Python's `len()` says 1), rejects a `noteType` outside the ten, a bad
   `sourceOrigin`, an unknown metadata field, and double-encoded newlines.
3. **Real newlines, encoded once.** Build the body in a file or in Python,
   serialize once, `docs apply --file`, read `content` back: no literal `\n`.
4. **Generate large batches** with a script that asserts the description
   length where the note is written and keeps a key → document-id map on disk,
   so a re-run updates in place instead of duplicating.

```bash
# REST — up to 25 notes per call; filed in /knowledge/notes; parentFolder is rejected
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/notes" -d '{
  "drive": "<drive-uuid>",
  "notes": [{"name": "<slug>", "actions": [
    {"type":"SET_PROVENANCE","input":{"author":"<agent>","sourceOrigin":"DERIVED","createdAt":"<ISO>"}},
    {"type":"SET_TITLE","input":{"title":"<claim as a sentence>","updatedAt":"<ISO>"}},
    {"type":"SET_DESCRIPTION","input":{"description":"<≤ 200, not the title again>","updatedAt":"<ISO>"}},
    {"type":"SET_NOTE_TYPE","input":{"noteType":"CONCEPT","updatedAt":"<ISO>"}},
    {"type":"SET_CONTENT","input":{"content":"<argument, evidence, conditions>","updatedAt":"<ISO>"}},
    {"type":"ADD_TOPIC","input":{"id":"<uuid>","name":"<topic>"}},
    {"type":"SET_METADATA_FIELD","input":{"field":"confidence","value":"grounded","updatedAt":"<ISO>"}}
  ]}]
}'
# then the provenance edge, per note
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST "$BASE/relationships" \
  -d '{"source":"<note>","target":"<source>","type":"DERIVED_FROM","reason":"§ <where in the source>: <what the text says>","confidence":"grounded"}'
```

```bash
# CLI — same actions, one document at a time, signed as you
switchboard docs create --type bai/knowledge-note --name "<slug>" --drive <drive-slug> --parent-folder <notes-folder-uuid> --format json
node scripts/lint-actions.mjs /tmp/acts-<id>.json && switchboard docs apply <note-id> --file /tmp/acts-<id>.json   # actions carry "scope":"global"
switchboard docs link <note-id> <source-id> -t DERIVED_FROM --reason "§ <where>: <what>" --confidence grounded
switchboard docs tree <drive-slug> --format json | grep <note-id>       # exists — never assume from a dispatch
```

**You cannot approve your own note.** `APPROVE_NOTE` throws `SelfApprovalError`
when `actor` equals `provenance.author`. Extract leaves notes in `DRAFT`; the
walk to `CANONICAL` happens in verify, as a different actor.

## Close out the source — mandatory

A source left in `INBOX` or `EXTRACTING` reads as unprocessed forever; its
notes carry no signal back to it. Provenance lives in two places and both are
required: `extractedClaims[]` on the source (what the app renders) and the
`DERIVED_FROM` edge per note (what the graph traverses).

**The invariant: `claimCount == len(extractedClaims) == notes written.`**
Nothing in the stack checks it — `RECORD_EXTRACTION_STATS` copies its inputs
and replaces the whole object, `ADD_EXTRACTED_CLAIM.claimRef` is unvalidated
(a typo is a permanent phantom the app counts), and `SET_SOURCE_STATUS` has no
transition guard. A real run left 24 sources asserting nine claims each with
`extractedClaims: []` — the vault reported itself processed and held nothing.
So: build the stats from the list of ids you actually created, dispatch them in
the **same batch** as the `ADD_EXTRACTED_CLAIM`s, and read the source back.

`skipRate = skippedCount / (claimCount + skippedCount)` — a fraction 0–1 (the
editor renders ×100; `57` where `0.57` was meant shows `5700%`), `0` when both
counts are 0.

| Zero yield lands as | When |
|---|---|
| `EXTRACTED`, `claimCount: 0` | in-domain but thin, or every claim already in the vault — processed, nothing to take this time |
| `ARCHIVED` | structurally not knowledge: front matter, table of contents, index, a recap that only restates |

```bash
switchboard docs apply <source-id> --actions '[
  {"type":"ADD_EXTRACTED_CLAIM","input":{"claimRef":"<note-1>"},"scope":"global"},
  {"type":"ADD_EXTRACTED_CLAIM","input":{"claimRef":"<note-2>"},"scope":"global"},
  {"type":"RECORD_EXTRACTION_STATS","input":{"claimCount":2,"skippedCount":3,"skipRate":0.6,"extractedAt":"<ISO>","extractedBy":"<agent>"},"scope":"global"},
  {"type":"SET_SOURCE_STATUS","input":{"status":"EXTRACTED"},"scope":"global"}
]'
switchboard docs get <source-id> --state --format json | python3 -c "
import json,sys; g=json.load(sys.stdin)['state']['global']; s=g.get('extractionStats') or {}
print('status:',g.get('status'),'| refs:',len(g.get('extractedClaims') or []),'| claimCount:',s.get('claimCount'),'| skipRate:',s.get('skipRate'))"
```

`ADD_EXTRACTED_CLAIM` is idempotent on `claimRef` (package ≥ 1.0.54-dev.6);
older deployments append blindly — repair a duplicated list with
`REMOVE_EXTRACTED_CLAIM` then one `ADD_EXTRACTED_CLAIM`.

## Handoff

If this run is a pipeline task, `ADVANCE_PHASE` with phase `create`. The handoff
is a packet for the next phase, not a timestamp: in `workDone` give the counts
per source with one line of reasoning each, what was struck and why, and what
reflect should look at first — the contradictions and supersessions you noticed
while reading. `filesModified` = the note ids and the source id.

Extraction produces `DRAFT` notes with provenance and a `DERIVED_FROM` edge.
They still need reflect (typed edges), reweave (a `CORE_IDEA` from a MoC, the
backward pass on older notes) and verify (quality gate, walk to `CANONICAL`).
Run `/powerhouse-knowledge:pipeline` to carry them through.

## Before you advance

- [ ] Every note passes all six gates; nothing is an excerpt, summary, heading or caption
- [ ] The vault was searched first — an existing claim got evidence and a second `DERIVED_FROM`, not a twin
- [ ] Title is a declarative sentence; description adds mechanism/scope/implication and is distinctive; content carries argument, evidence and conditions
- [ ] `noteType` from the enum; ≥ 1 topic; `SET_PROVENANCE` set; `confidence` ∈ `grounded|established|speculative` (the reducer rejects anything else); type-specific metadata where the source supports it
- [ ] Description ≤ 200 UTF-16 units, linted before dispatch; content read back has real line breaks
- [ ] `result.allApplied` checked; every note present in the drive tree
- [ ] One `DERIVED_FROM` edge per note with the locus as its reason
- [ ] Source closed out and read back: `claimCount == len(extractedClaims) == notes written`; `skipRate` computed as a fraction; status `EXTRACTED` or `ARCHIVED`, never `INBOX`/`EXTRACTING`
- [ ] Handoff recorded with phase `create`

If "$ARGUMENTS" is provided, treat it as the source document ID to extract from.
