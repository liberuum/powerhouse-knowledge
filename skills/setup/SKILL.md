---
name: setup
description: Initialize a Knowledge Vault with the Ars Contexta methodology. Checks if the vault is ready, imports 249 research claims into /research/, and verifies the setup. Run once per vault — idempotent (skips if already populated).
---

# Vault Methodology Setup

Initialize a Knowledge Vault drive with the Ars Contexta methodology foundation — 249 interconnected research claims about tools for thought, knowledge management, and agent-native cognitive architecture.

## When to use

- First time connecting the plugin to a vault drive
- After creating a new vault drive
- When the user asks to set up or initialize the methodology
- When `/setup` is invoked explicitly

## Prerequisites

- Reactor running (`ph vetra --watch` or remote reactor)
- A vault drive exists (created via Connect UI or CLI)
- The drive has the Ars Contexta folder structure (`/research/` folder exists)

## Setup Process

### Step 1: Find the vault drive

```
mcp__reactor-mcp__getDrives()
```

If multiple drives exist, ask the user which one to set up. If only one non-vetra drive exists, use that.

### Step 2: Check current state

```
mcp__reactor-mcp__getDrive({ driveId: "<drive-uuid>" })
```

Verify:
- The `/research/` folder exists → get its folder ID
- If no `/research/` folder, the drive hasn't been initialized → suggest opening it in Connect first (the Knowledge Vault app auto-creates the folder structure)

### Step 3: Check if methodology is already imported

```
mcp__reactor-mcp__getDocuments({ parentId: "<drive-uuid>" })
```

Count documents of type `bai/research-claim`. If count >= 200, the methodology is already imported → report status and skip.

### Step 4: Read the methodology source files

The 249 Ars Contexta research claims live as markdown files with YAML frontmatter. The plugin tries three locations in order:

1. **Bundled in plugin**: `data/methodology/` inside the plugin directory (included when cloned from GitHub)
2. **Local Ars Contexta repo**: `/home/p/Powerhouse/arscontexta/methodology/` (development)
3. **Download from GitHub**: If neither exists, fetch from `https://raw.githubusercontent.com/liberuum/powerhouse-knowledge/main/data/methodology/`

**To find the bundled files**, use the Glob tool to search for `**/powerhouse-knowledge/data/methodology/*.md`. If the plugin was installed via marketplace and the data directory is missing, download the file listing from the GitHub repo and fetch each file.

Each file has:
```yaml
---
description: "Claim summary"
kind: "research|foundation|methodology|principle|example"
methodology: [list of methods]
source: "source reference"
topics: [topic-a, topic-b]
confidence: "grounded|established|speculative"
---

# Claim title (same as filename without .md)

Full content with [[wiki links]] to other claims...

Relevant Notes:
- [[Other claim title]] — context phrase
- [[Another claim]] — why they're connected

Topics:
- [[topic-name]]
```

### Step 5: Two-pass import

**Pass 1 — Create all 249 claim documents:**

For each `.md` file in the methodology directory:

```
mcp__reactor-mcp__createDocument({
  documentType: "bai/research-claim",
  driveId: "<drive-uuid>",
  name: "<filename without .md>",
  parentFolder: "<research-folder-id>"
})
```

Then populate the claim:
```
mcp__reactor-mcp__addActions({
  documentId: "<new-doc-id>",
  actions: [{
    type: "CREATE_CLAIM",
    input: {
      title: "<filename without .md>",
      description: "<frontmatter description>",
      content: "<body content before Relevant Notes section>",
      kind: "<frontmatter kind, default: research>",
      methodology: ["<frontmatter methodology array>"],
      sources: ["<frontmatter source>"],
      topics: ["<extracted from frontmatter and Topics section>"]
    },
    scope: "global"
  }]
})
```

Save a **title → document ID map** for pass 2.

**Pass 2 — Resolve connections:**

For each claim that has a "Relevant Notes" section:
```
Parse lines like: - [[target title]] — context phrase
Look up target title in the title→ID map
```

```
mcp__reactor-mcp__addActions({
  documentId: "<source-claim-id>",
  actions: [{
    type: "ADD_RESEARCH_CONNECTION",
    input: {
      id: "<generate-unique-id>",
      targetRef: "<target-document-id>",
      contextPhrase: "<context phrase from the link>"
    },
    scope: "global"
  }]
})
```

### Step 6: Report results

```
=== Methodology Setup Complete ===
Claims imported: 249
Connections resolved: ~2,676
Connections unresolved: ~23 (external references)
Location: /research/ folder
```

## Automated alternative

For large imports, the dedicated import script is faster than MCP tool calls:

```bash
# Using bundled methodology files from the plugin
node /path/to/bai-knowledge-note/scripts/import-research-claims.mjs \
  --drive-id <drive-uuid> \
  --vault-path /path/to/powerhouse-knowledge/data/methodology/

# Or from the local Ars Contexta repo
node /path/to/bai-knowledge-note/scripts/import-research-claims.mjs \
  --drive-id <drive-uuid> \
  --vault-path /path/to/arscontexta/methodology/
```

This uses MCP Streamable HTTP for bulk creation and is ~10x faster than individual MCP tool calls.

## Downloading methodology from GitHub (marketplace installs)

If the plugin was installed via marketplace and the `data/methodology/` directory is missing, download the files:

```bash
# Clone just the data directory
git clone --depth 1 --filter=blob:none --sparse https://github.com/liberuum/powerhouse-knowledge.git /tmp/pk-methodology
cd /tmp/pk-methodology && git sparse-checkout set data/methodology
# Then use /tmp/pk-methodology/data/methodology/ as the vault-path
```

Or fetch individual files via the GitHub raw URL:
```
https://raw.githubusercontent.com/liberuum/powerhouse-knowledge/main/data/methodology/<filename>.md
```

## Document model: `bai/research-claim`

**State:**
- `title` — Declarative claim statement (the filename)
- `description` — Brief summary
- `content` — Full markdown body with arguments and evidence
- `kind` — research, foundation, methodology, principle, example
- `methodology[]` — Research methods used
- `sources[]` — Source references
- `topics[]` — Topic tags
- `connections[]` — Cross-claim links (`{ id, targetRef, contextPhrase }`)

**Operations:**
- `CREATE_CLAIM` — Initialize all fields at once
- `ADD_RESEARCH_CONNECTION` — Link to another claim
- `REMOVE_RESEARCH_CONNECTION` — Remove a link
- `UPDATE_CLAIM_CONTENT` — Update the content body

## Idempotency

This skill is safe to run multiple times:
- If methodology is already imported (>= 200 research claims exist), it reports status and skips
- If partially imported (some claims exist), suggest cleaning up and re-running the import script
- The import script itself is idempotent per run (creates new docs each time, doesn't duplicate)

## What the methodology provides

The 249 claims are the theoretical foundation for how the Knowledge Vault works:
- **Processing pipeline design** — why 6Rs, why each phase matters
- **Note architecture** — why atomic claims, why typed links, why progressive disclosure
- **Quality principles** — what makes a good note, link, MOC
- **Cognitive science backing** — attention management, cognitive offloading, memory systems
- **Agent design patterns** — how AI agents should operate knowledge systems

The Claude plugin uses these claims as reference when processing sources, extracting notes, and maintaining vault quality.
