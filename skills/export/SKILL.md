---
name: export
description: Export knowledge vault data — full backup, filtered export, or markdown conversion. Uses consistency tokens for reliable snapshots. Use for backup, migration, or sharing.
---

# Export Knowledge Vault

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

## Export to Markdown (via MCP)

For each note in the vault:

1. Read the document state:
```
mcp__reactor-mcp__getDocument({ id: "<doc-id>" })
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
- [[<link.targetTitle>]] — <link.linkType>
```

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

```graphql
query ExportGraph($driveId: ID!) {
  knowledgeGraphDebug(driveId: $driveId) {
    rawNodes { documentId title noteType status description }
    rawEdges { sourceDocumentId targetDocumentId linkType targetTitle }
  }
}
```

This gives the full graph as JSON — useful for visualization tools, analysis, or migration.

If "$ARGUMENTS" is provided, treat it as the export destination path.
