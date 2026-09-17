---
name: verify
description: Run verification checks on knowledge notes — recite test, schema validation, and health checks. Automatically repairs common issues (missing descriptions, provenance). Use as a quality gate after extraction or editing.
---

# Verify Knowledge Notes

> **Target first.** Every command below runs against the Switchboard the active
> profile points at, and `<UUID>` / `<drive-slug>` mean *that* server's vault
> drive. If the pre-flight hook printed `Profile: … -> …` and `VAULT_DRIVE_ID` /
> `VAULT_DRIVE_SLUG`, use those. Otherwise run `switchboard config show` and the
> drive detection in AGENT.md § *Find the vault drive*. REST calls take the same
> drive as `?drive=<UUID>`; see AGENT.md § *Which surface to use*.

The quality gate. Verification is **simulated use, not static linting**: you
test whether a note works as a claim, whether its description lets a reader
find and filter it, and whether its edges carry reasoning — then repair what
you can state the fix for, report what needs the source or a human, and walk
the survivors to `CANONICAL`. Read every field back; a dispatch is not a fact.

## The checks

Read the note (`GET notes/:id` — title, description, content, edges) and run,
in order:

**1. Claim test — is the title a claim?** Three tests: does it complete *"This
note argues that …"*; does it work as a clause (*"Since [title], …"*); is it a
positive assertion, not a question or topic label. A failure is not a weak
note, it is not a note: rewrite the title if the content holds one claim,
split if it holds several, propose archiving if it holds none (an excerpt, a
heading, a caption). Never "repair" this by improving the description.

**2. Recite test — does the description work as a filter?** Read **only** title
and description, predict the content, then read the content and score:

| Score | Meaning | Action |
|---|---|---|
| 5 | Prediction matched — description excellent | — |
| 4 | Core captured, details missed | — |
| 3 | Right area, key aspect missed | sharpen if cheap |
| 2 | Significant mismatch | **rewrite** |
| 1 | Prediction wrong — description misleads | **rewrite** |

A description that paraphrases the title always scores low: it adds no
mechanism, scope or implication to predict from. Name the missing layer — what
holds / why / so what — and rewrite that. Titles and descriptions that could
belong to several notes fail the distinctiveness half of the test.

**3. Schema.** Title; description present and 80–200 UTF-16 units; `noteType`
set (the enum makes a wrong value impossible, so only *missing* is a finding); substantive content (≥ 200 chars of argument, not a
stub); provenance (`author`, `sourceOrigin`, `createdAt`); ≥ 1 topic;
`confidence` metadata; type-specific metadata where the source could have
supplied it (extract § *Metadata by noteType*); status appropriate to maturity.

**4. Graph** — from `knowledgeGraphForwardLinks` / `Backlinks`, never the note's
legacy `links[]`:
- ≥ 2 knowledge edges, and ≥ 1 **incoming** (an orphan is a node with zero incoming edges; outgoing links do not fix it);
- every knowledge edge (`RELATES_TO` `BUILDS_ON` `CONTRADICTS` `SUPERSEDES` `DERIVED_FROM`) has a `reason` that passes the specificity test — a sentence that could describe any pair is a bare edge in disguise — and a `confidence`;
- every `targetDocumentId` resolves;
- one `DERIVED_FROM` to a source whose reason names the locus;
- a `CORE_IDEA` edge from at least one MoC;
- `content` holds real line breaks, no literal `\n`.

**5. Grounding** — only for notes whose claim is about knowledge work, agent
cognition or retrieval (connect § *Grounding*). An in-scope note without a
`## Grounding` section is a WARN; an out-of-scope note without one is nothing.

## Repair — fix what you can state, report what you cannot

You are the judgment the methodology reserves for remediation, so fix when you
have read the note and can state the correct value; report when the fix needs
the source re-read, a human decision, or would change what the note claims.

| Finding | Fix |
|---|---|
| Failed claim test | Rewrite the title (one claim), split (several), or report for archiving (none). Say which in the report |
| Recite < 3 | Rewrite the description from the content, adding the missing layer; count in UTF-16 (`len(s.encode("utf-16-le"))//2`, or lint) |
| Missing description | Usually an over-long attempt the reducer rejected. Write one ≤ 200 from title + content |
| Missing provenance | Take `author` and `createdAt` from the document's operation history (who created it, when) — not "now", not a guessed origin. `sourceOrigin` = `DERIVED` only if a `DERIVED_FROM` edge or `extractedClaims` entry exists; else `IMPORT` or `MANUAL` as the history shows |
| Missing `noteType` | Infer from the content, write the `NoteType` enum value (`CONCEPT`, `BUG_PATTERN`, …) |
| Missing topics | From the content and the vault's existing vocabulary; read `topics[]` back first |
| Bare edge | Read both notes; `docs annotate` with the sentence, or `docs unlink` if you cannot complete it. Count both (`articulated: N, unlinked: M, left bare: K`) |
| Literal `\n` | Replace in Python (`s.replace(chr(92)+'n', chr(10))`), one `SET_CONTENT` via `--file`, read back. Never in bash — that is how the bug is made |
| Fewer than 2 edges / orphan | Run `/connect` on the note |
| No `CORE_IDEA` | Run `/synthesize` for its topic |

Repair follows the creation contract (extract § *Field contract*), with four
reducer behaviours that bite edits specifically:

- `SET_PROVENANCE` may correct `author`/`sourceOrigin`, but `provenance.createdAt` is immutable — pass the existing value back or the action is rejected (`ProvenanceCreatedAtImmutableError`). The note's top-level `updatedAt` is stamped by every op, so batch order no longer matters.
- `confidence` (`grounded|established|speculative`), `severity` (`critical|warning|info`) and `decisionStatus` (`proposed|accepted|rejected|superseded`) are closed vocabularies — `InvalidMetadataValueError` otherwise.
- `ADD_TOPIC` throws `DuplicateTopicError` on an existing **name**; `REMOVE_TOPIC` matches **id**.
- `SET_CONTENT` replaces the whole body — read it back first, edit, send the whole thing.
- A description > 200 UTF-16 units is rejected and the field left as it was.

Vault-wide detection is one graph call, not N reads:

```bash
switchboard query '{ knowledgeGraphNodes(driveId: "<UUID>") { documentId status description content } }' --format json \
  | python3 -c "
import json,sys; d=json.load(sys.stdin); d=d.get('data',d)['knowledgeGraphNodes']
notes=[n for n in d if n['status'] not in ('MOC','SCOPE','WBS')]
print(len([n for n in notes if not n['description']]),'without description;',
      len([n for n in notes if (n['content'] or '').count(chr(92)+'n')]),'with literal backslash-n')"
```

## Record the verdict on the note

- **Epistemic confidence**: set or correct `confidence` (`grounded` | `established`
  | `speculative`) from what you found — a claim you checked against its source
  or the code is `grounded`; one that rests on the author's word is `established`.
- **Lifecycle**: a note that passes walks to `CANONICAL` — `SUBMIT_FOR_REVIEW`
  (from `DRAFT`), then `APPROVE_NOTE` **as a different actor** from
  `provenance.author` (`SelfApprovalError` otherwise; approval is legal only
  from `IN_REVIEW`). A note that fails and cannot be repaired stays `DRAFT` with
  the reason in the report. `ARCHIVE_NOTE` is legal only from `CANONICAL`.

```bash
switchboard docs apply <note-id> --actions '[
  {"type":"SUBMIT_FOR_REVIEW","input":{"id":"<uuid>","actor":"<agent>","timestamp":"<ISO>"},"scope":"global"},
  {"type":"APPROVE_NOTE","input":{"id":"<uuid>","actor":"<reviewer ≠ author>","timestamp":"<ISO>","comment":"recite 5/5; 3 reasoned edges; DERIVED_FROM checked against § 4"},"scope":"global"}
]'
```

## Report

```
=== VERIFICATION ===
Verified: N notes | Repaired: N (M descriptions, P provenance, Q types, R topics)
Edges: N articulated, M unlinked (failed articulation), K left bare
Lifecycle: N → CANONICAL, M left DRAFT

"<title>"
  Claim:   PASS | FAIL — <which test>
  Recite:  5..1 — <missing layer>
  Schema:  PASS | repaired: <what> | FAIL — <what>
  Graph:   PASS | WARN — <what>
  Action:  <what remains for a human>

Remaining: <findings that need the source or a decision>
```

In a pipeline run, `ADVANCE_PHASE` with phase `verify` — the final advance
completes the task by itself; do not follow it with `COMPLETE_TASK`. `workDone`
is the closure packet: what passed, what was repaired, what is left and for
whom. Then run `/powerhouse-knowledge:health` and rewrite the report: the
dashboard shows the **last** report, and everything this skill repairs is
something the report grades.

If "$ARGUMENTS" is provided, verify that specific note (by title or document ID).
