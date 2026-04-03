---
name: setup
description: Initialize a Knowledge Vault — verify drive structure, folder layout, and singleton documents are in place. The Ars Contexta methodology (249 research claims) is bundled locally with the plugin and does NOT need to be imported into the vault.
---

# Vault Setup

Verify that a Knowledge Vault drive is ready for use — correct folder structure, singleton documents exist, and the plugin's local methodology files are accessible.

## When to use

- First time connecting the plugin to a vault drive
- After creating a new vault drive
- When the user asks to set up or initialize the vault
- When `/setup` is invoked explicitly

## Prerequisites

- Reactor running (`ph vetra --watch` or remote reactor)
- A vault drive exists (created via Connect UI or CLI)
- `switchboard` CLI installed and configured (`switchboard config use local` or appropriate profile, `switchboard introspect` run once)

## Setup Process

### Step 1: Find the vault drive

```bash
switchboard drives list --format json
```

If multiple drives exist, ask the user which one to set up. If only one non-vetra drive exists, use that.

### Step 2: Verify folder structure

```bash
switchboard docs tree <drive-slug> --format json
```

The vault needs these folders:
| Folder | Purpose |
|--------|---------|
| `/knowledge/` | MOCs |
| `/knowledge/notes/` | Atomic knowledge notes |
| `/sources/` | Source material |
| `/ops/` | Operational documents |
| `/ops/queue/` | Pipeline queue singleton |
| `/ops/health/` | Health report singleton |
| `/self/` | Config and graph singletons |

If folders are missing, the vault hasn't been initialized — suggest opening it in Connect first (the Knowledge Vault app auto-creates the folder structure).

### Step 3: Verify singleton documents

```bash
switchboard docs list --drive <drive-slug> --format json
```

Check that these exist:
- `bai/vault-config` in `/self/`
- `bai/knowledge-graph` in `/self/`
- `bai/pipeline-queue` in `/ops/queue/`

If missing, create them:
```bash
switchboard docs create --type bai/pipeline-queue --name "Pipeline Queue" --drive <drive-slug> --parent-folder <ops-queue-folder-uuid> --format json
```

### Step 4: Verify local methodology files

The 249 Ars Contexta research claims are bundled with the plugin in `data/methodology/*.md`. They are **not** imported into the vault — the agent reads them directly from disk during connect, verify, and pipeline phases.

```bash
ls data/methodology/*.md | wc -l
# Should be 249
```

If the `data/methodology/` directory is missing (marketplace install), clone from GitHub:
```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/liberuum/powerhouse-knowledge.git /tmp/pk-methodology
cd /tmp/pk-methodology && git sparse-checkout set data/methodology
cp -r /tmp/pk-methodology/data/methodology/ <plugin-dir>/data/methodology/
```

### Step 5: Report results

```
=== Vault Setup Complete ===
Drive: <drive-name> (<drive-uuid>)
Folders: ✓ all present
Singletons: ✓ pipeline-queue, vault-config, knowledge-graph
Methodology: ✓ 249 claims available locally (not imported to vault)
Status: Ready for use
```

## What the methodology provides (locally)

The 249 claims are the theoretical foundation for how the Knowledge Vault works:
- **Processing pipeline design** — why 6Rs, why each phase matters
- **Note architecture** — why atomic claims, why typed links, why progressive disclosure
- **Quality principles** — what makes a good note, link, MOC
- **Cognitive science backing** — attention management, cognitive offloading, memory systems
- **Agent design patterns** — how AI agents should operate knowledge systems

The agent reads these files directly from `data/methodology/` during:
- **Connect phase** — searching for methodology backing when creating note connections
- **Verify phase** — checking if notes are grounded in methodology
- **Health check** — reporting METHODOLOGY_GROUNDING status

No remote import, no `bai/research-claim` documents, no `/research/` folder needed.

## Idempotency

This skill is safe to run multiple times — it only checks and creates missing structure, never duplicates.
