---
name: export
description: Export knowledge vault data — full backup, filtered export, or markdown conversion. Uses consistency tokens for reliable snapshots. Use for backup, migration, or sharing.
---

# Export Knowledge Vault

> **Target first.** Every command below runs against the Switchboard the
> active CLI profile points at, and `<UUID>` / `<drive-slug>` mean *that*
> server's vault drive. If the pre-flight hook printed `Profile: … -> …` and
> `VAULT_DRIVE_ID` / `VAULT_DRIVE_SLUG`, use those. Otherwise run
> `switchboard config show` and the drive detection in AGENT.md § *Find the
> vault drive*. If it is still ambiguous which vault the user means, **ask for
> the Switchboard URL and the drive** — never assume an endpoint.

Export vault data with guaranteed consistency.

## Export Methods

### Full Vault Backup (via Switchboard CLI)
```bash
switchboard export drive <drive-uuid> -o ./backup/ --format json
```

### Filtered Export (by date range)
```bash
switchboard export drive <drive-uuid> --from 2026-01-01T00:00:00Z --to 2026-03-26T00:00:00Z -o ./q1/ --format json
```

### Incremental Export (since last sync)
```bash
switchboard export drive <drive-uuid> --since-revision 50 -o ./incremental/ --format json
```

### Single Document Export
```bash
switchboard export doc <doc-id> --drive <drive-uuid> -o note.phd --format json
```

## Export to Markdown

For each note in the vault:

1. Read the document state:
```bash
switchboard docs get <doc-id> --state --format json
```

2. Convert state to markdown with YAML frontmatter:
```markdown
---
title: "<state.global.title>"
description: "<state.global.description>"
type: <state.global.noteType>
status: <state.global.status>
topics: [<state.global.topics[].name>]
author: <state.global.provenance.author>
created: <state.global.provenance.createdAt>
---

<state.global.content>

---
Links:
- [[<edge.targetTitle>]] — <edge.linkType>
```

Read the links from the **graph**, not from `state.global.links[]` — that array is empty for anything linked since the relationship migration, so an export built from it has no links. One call per note (`knowledgeGraphForwardLinks(driveId, documentId) { targetDocumentId targetTitle linkType }`) or one call for the vault (`knowledgeGraphEdges(driveId)`), then join on the note id.

Note that `knowledgeGraphDebug` returns only the indexed types (`bai/knowledge-note`, `bai/moc`): sources, tensions, observations, projects and WBS are not in it, so it is not a complete export on its own.

3. Write to local filesystem:
```
Write to: ./export/notes/<title-slug>.md
```

## Consistency Guarantee

The Powerhouse reactor uses consistency tokens to ensure exports reflect a complete state:
- Each write returns a consistency token
- Reads with a token are guaranteed to see all writes up to that point
- The switchboard CLI handles this automatically

## Graph Export

Export the knowledge graph structure:

```bash
switchboard query '{ knowledgeGraphDebug(driveId: "<UUID>") { rawNodes { documentId title noteType status description } rawEdges { sourceDocumentId targetDocumentId linkType targetTitle } } }'
```

This gives the full graph as JSON — useful for visualization tools, analysis, or migration.

If "$ARGUMENTS" is provided, treat it as the export destination path.
