---
name: scope-of-work
description: Use when looking up, searching, or reading anything inside a scope of work — roadmaps, maps (cited notes/MoCs), milestones, project envelopes, deliverables, workflows, or work-breakdown (WBS) goal trees. Use when the user names a project, code, milestone, or deliverable and you need nested state. Do not use for creating or mutating work.
---

# Read a scope of work

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

A **project is an envelope** inside a `powerhouse/scopeofwork` document, not a
document. Roadmaps, milestones, deliverables, cited maps, and people live in
that same document. The goal tree / workflow is a linked `bai/wbs`. Graph
search ranks documents, so it misses or mis-ranks nested work.

This skill **reads**. Writes, create, and the goal-working loop are **projects**.

## What's inside

| Thing | Where it lives | Cite |
|---|---|---|
| Scope | `powerhouse/scopeofwork` document | `[[scopeId]]` |
| Project (envelope) | `state.global.projects[]` | `[[scopeId#envelopeId]]` |
| Deliverable | `state.global.deliverables[]`, scoped by the envelope | same envelope cite |
| Roadmap → milestone | `state.global.roadmaps[].milestones[]` | envelope that owns its deliverables |
| Maps | envelope `knowledgeRefs[]` (note/MoC PHIDs, **not** vault `/knowledge/` folders) | `[[noteOrMocId]]` |
| Workflow / work breakdown | linked `bai/wbs` (`wbsRef` ↔ `sowRef`+`sowProjectId`); goals, status, assignee, notes | `[[wbsId]]` |

`bai/project` is retired. Never create one.

## Helper

```bash
HELPER="${CLAUDE_PLUGIN_ROOT:-.}/skills/scope-of-work/lookup.py"
# --drive accepts UUID, slug, or drive name. -p / $SWITCHBOARD_PROFILE.

python3 "$HELPER" list
python3 "$HELPER" get "PPD"                    # code, id, slug, title, or [[scopeId#envelopeId]]
python3 "$HELPER" get "paperless billing"      # unique nested hit → that envelope
python3 "$HELPER" search "paperless billing"   # typed hits (milestone, deliverable, goal, …)
python3 "$HELPER" search M1 --kind milestone
python3 "$HELPER" outline <scope-id>           # needs drive UUID ($VAULT_DRIVE_ID)
```

`--kind` is a comma list: `scope,envelope,deliverable,roadmap,milestone,contributor,map,goal`.

If the query is a **raw UUID** and you do not already know the kind: **search
first**. `search` labels the hit (`DELIVERABLE`, `ENVELOPE`, `MILESTONE`, …).
`get` is envelope-centric — a deliverable or milestone id still dumps the
**parent envelope**, so it will not tell you what the id is.

`docs get` only works for a **document** id or exact document name. Envelope
title, code, and milestone title are not document names.

## After a hit

1. Quote nested facts from `get` / `search` / `outline`. Cite the scope (or
   WBS) as above — an envelope has no documentId.
2. Cited maps: `switchboard docs get <knowledgeRef> --state` (or **search**
   for the note). Those are knowledge, not work.
3. To change anything, **projects**.

## Common mistakes

| Wrong | Right |
|---|---|
| `docs get "Paperless Billing"` | `lookup.py get "paperless billing"` |
| `get` on a raw UUID | `search` first — `get` dumps the parent envelope |
| Treat a graph `SCOPE` hit as the answer | `lookup.py get` / `outline` that `documentId` for quotes, ids, `goalRef` |
| Search `/knowledge/` for a project's "maps" | envelope `knowledgeRefs` |
| Create `bai/project` | envelope inside the scope |
