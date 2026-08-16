---
name: skills
description: Find, read, and add agent skills stored in the Knowledge Vault. Use when you need a procedure for working on the vault or the Powerhouse stack and don't know which skill covers it — ask for what you need in natural language.
---

# Skill Discovery

The vault stores every agent skill as knowledge: one PROCEDURE note per
skill (the searchable index) paired with a `bai/source` holding the full
SKILL.md text. **Git is canonical** — the vault is the discovery layer.
Sync is mechanical and incremental (`scripts/sync-skills.mjs`, keyed on
content hash), so the two never drift silently.

## Find a skill (by need, not by name)

```bash
switchboard query '{ knowledgeGraphSemanticSearch(driveId: "<UUID>", query: "<what you need to do>", mode: HYBRID, limit: 5) { similarity node { documentId title description } } }'
```

Skill notes are recognizable by their `Agent skill: /<name>` title prefix
and the `agent-skills` topic. To list them all:

```bash
switchboard query '{ knowledgeGraphByTopic(driveId: "<UUID>", topic: "agent-skills") { documentId title description } }'
```

## Read a skill

The note is the summary; the FULL executable text lives in the paired
source (follow the note's DERIVED_FROM edge, or search sources by title
`Agent skill: <name>`):

```bash
# note -> its source
switchboard query '{ knowledgeGraphForwardLinks(driveId: "<UUID>", documentId: "<note-id>") { targetDocumentId linkType } }'
# read the full SKILL.md text
switchboard docs get <source-id> --state --format json   # state.global.content
```

If the plugin is installed locally, prefer executing via the command
(`/powerhouse-knowledge:<name>`) or reading the repo copy — that is the
canonical version. The vault copy is for discovery and for agents that
only have Switchboard access.

## Add or update skills

1. Write/edit the `SKILL.md` in the plugin repo under `skills/<name>/`
   (or any skills directory) — normal git flow, reviewed like code.
2. Sync (incremental — unchanged files are skipped, changed ones update
   the SAME documents in place, new ones are created; nothing is deleted):

```bash
node scripts/sync-skills.mjs --endpoint <switchboard /graphql URL> --drive <uuid-or-slug>
# extra skill directories:
node scripts/sync-skills.mjs --endpoint ... --drive ... --skills-dir /path/to/other/skills
# preview without writing:
node scripts/sync-skills.mjs --endpoint ... --drive ... --dry-run
```

There is **no default endpoint** — ask the user which vault to sync into.

The script performs the full close-out per skill (source → EXTRACTED with
stats, note → CANONICAL, DERIVED_FROM + MOC CORE_IDEA edges) and verifies
every write by read-back. Run it twice: the second run must report
`0 created, 0 updated, N skipped` — that is the idempotency proof.

## Adding skills: the vault is the home

Adding a skill is a **vault operation** — no plugin release, no repo
commit, no sync run. One command handles fetch/read, source + note +
edges + close-out, and read-back verification, and it is idempotent by
title (re-adding updates the same documents in place):

```bash
# from a URL (e.g. a skill kept in another repo)
node scripts/add-skill.mjs --endpoint <.../graphql> --drive <id> --url <raw-md-url>

# from a local file
node scripts/add-skill.mjs --endpoint <.../graphql> --drive <id> --file ./my-skill.md --name my-skill

# update after upstream changes: run the same command again
```

Or simply ask the agent: "add this skill to the vault: <url or file>" —
it runs the same pattern. Skills added this way are **vault-native**:
the vault copy IS the executable copy. If the skill originated at a URL,
the source records it as `Upstream origin` for reference. To retire one,
archive it (`SET_SOURCE_STATUS` → `ARCHIVED` + archive its note).

The sync script below manages ONLY the plugin's bundled skills — it lists
vault-native skills informationally and never touches them. Same-name
collisions are safe: the sync writes only through documents it owns
(`createdBy: skill-sync`) and warns about the rest.

## Staleness detection

Each source stores `sha256:<hash>` of its SKILL.md in the `method` field.
A health or verify pass can recompute hashes from the repo and flag vault
copies that are behind — treat a mismatch as "re-run sync", never as
"edit the vault copy".

If "$ARGUMENTS" is provided, treat it as the need description and run the
semantic search with it.
