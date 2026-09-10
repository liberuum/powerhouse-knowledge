---
name: setup
description: Use when pointing the plugin at a vault for the first time, when there is no Switchboard profile, ping fails, the CLI is missing, or when verifying folders and singletons so other skills can run. Use when the user asks to set up, initialize, or connect to a knowledge vault. Do not use for linking notes.
---

# Vault Setup

Leave the session able to run every other skill: CLI profile pointed at the
Switchboard the **user names**, an identity that is signed in (bearer) and
signs writes, a vault drive the identity may **write**, folders, singletons,
local methodology.

There is **no default vault**. Installing the plugin does not connect anything.
Linking notes is **connect**. MCP / raw GraphQL: [CONFIGURATION.md](../../CONFIGURATION.md)
— writes still go through the CLI.

## When to use

- First session, no profile, ping fail, or "connect me to the vault"
- After creating a new vault drive
- When `/setup` is invoked
- Before other skills, if the drive is not yet confirmed ready

## Process

### 1. CLI and profile

```bash
which switchboard || curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash
switchboard --version    # ≥ 1.0.36
switchboard config show
switchboard ping
```

If ping already succeeds and the user confirms that profile, skip to step 2.
If several profiles exist, `switchboard config use <name>` — do not guess.

Otherwise **ask** for the Switchboard `/graphql` URL **and** which drive.
Examples they may give (not defaults): local `ph vetra` →
`http://localhost:4001/graphql`; a host → `https://<host>/graphql`.

```bash
switchboard init --url <THE URL THEY NAMED> --name <short-name> --use-profile   # CLI ≥ 1.0.34; older: interactive init
switchboard ping
```

Pin later commands with `-p <name>` if another session might switch the default.

### 2. Sign in — bearer and signing

Two logins, both required on a protected Switchboard
(`REQUIRE_AUTHENTICATED_CALLER`): the bearer is *authentication* on every
request, reads included; signing is *attribution* of writes.

```bash
ph login                                              # once per machine (Renown → .ph/.keypair.json + .ph/.renown.json)
switchboard auth login --token "$(ph access-token)"   # bearer on every request — without it everything is 401
switchboard auth login --renown                       # sign writes as the user — the pre-write hook blocks writes until this is true
switchboard auth status --format json                 # expect has_token: true, signing: true, address: 0x…, credential_expired: false
```

If `has_token` or `signing` is false, or `credential_expired` is true, stop
and give the user the commands above (`ph login` renews the credential; the
bearer defaults to `--expiry 7d`). Nothing below that reads or writes will
work until this is true. Keep the `address` — it is what an administrator
grants, and what the report names.

### 3. Vault drive

```bash
switchboard drives list --format json
```

The vault is the drive that contains `bai/vault-config`. Multiple non-vetra
drives → ask. None → they create it in Connect, or:

```bash
switchboard drives create --name "Knowledge Vault" --preferred-editor knowledge-vault
```

Keep the UUID (`knowledgeGraph*` queries) and the slug (`--drive`).

### 4. Access — a grant on the drive

Identity says who you are; a grant says what you may do. Ask the Switchboard,
as the identity from step 2:

```bash
switchboard query '{ canExecuteOperation(documentId: "<drive-uuid>", operationType: "ADD_FILE") }'
```

| Answer | Meaning | Do |
|---|---|---|
| `true` | WRITE (or an operation grant): the pipeline can run | continue |
| `false`, reads work | READ-only | stop; ask a vault administrator to grant `WRITE` on the drive to the step-2 address |
| `Forbidden` on a read as well | no grant at all | same — `READ` for readers, `WRITE` for contributors |
| `HTTP 401` | bearer missing or expired | back to step 2 |
| `Cannot query field "canExecuteOperation"` | no authorization subgraph: permissions are not enforced here | continue |

The pre-flight prints the same verdict as `ACCESS: …` on every vault command.
A refusal is an administrator's decision: report it with the address, do not
retry or route around it. How grants work, and the administrator's own
commands: [AGENT.md → Authenticate, then get access](../../AGENT.md#authenticate-then-get-access--the-first-steps-before-writing).

### 5. Models

```bash
switchboard models list --format json | grep -E 'bai/'
```

If `bai/` is missing: `switchboard introspect`. Still missing → that Switchboard
does not have the knowledge package deployed; stop and say so.

### 6. Folders

```bash
switchboard docs tree <drive-slug> --format json
```

| Folder | Purpose |
|--------|---------|
| `/knowledge/` | MOCs |
| `/knowledge/notes/` | Atomic knowledge notes |
| `/sources/` | Source material |
| `/ops/` | Operational documents |
| `/ops/queue/` | Pipeline queue singleton |
| `/ops/health/` | Health report singleton |
| `/self/` | Config singleton |
| `/knowledge/inbox/` | Notes awaiting processing |
| `/knowledge/insights/` | Synthesised insights |
| `/projects/` | Projects and their WBS |
| `/ops/sessions/` | Session records |
| `/self/methodology/` | Reserved (methodology is read from the plugin, not the vault) |

If folders are missing, the vault hasn't been initialized — open it in Connect
first (the Knowledge Vault app auto-creates them).

### 7. Singletons

```bash
switchboard docs list --drive <drive-slug> --format json
```

Need `bai/vault-config` in `/self/`, `bai/health-report` in `/ops/health/`,
`bai/pipeline-queue` in `/ops/queue/`. There is **no** `bai/knowledge-graph`
document — the graph is the indexer's tables.

If missing:

```bash
switchboard docs create --type bai/pipeline-queue --name "Pipeline Queue" --drive <drive-slug> --parent-folder <ops-queue-folder-uuid> --format json
```

### 8. Local methodology

The 249 Ars Contexta claims are in the plugin at `data/methodology/*.md` — **not**
imported into the vault.

```bash
ls data/methodology/*.md | wc -l   # 249
```

If missing (marketplace install):

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/liberuum/powerhouse-knowledge.git /tmp/pk-methodology
cd /tmp/pk-methodology && git sparse-checkout set data/methodology
cp -r /tmp/pk-methodology/data/methodology/ <plugin-dir>/data/methodology/
```

### 9. Report — other skills may run

```
=== Vault Setup Complete ===
Profile: <name> -> <url>
Drive: <drive-name> (<drive-uuid> / <slug>)
Identity: bearer ✓  signing ✓  as 0x… (credential valid until <date>)
Access: WRITE on the drive
Folders: ✓  Singletons: ✓  Methodology: ✓ 249 local
Status: Ready — search, seed, pipeline, scope-of-work, …
```

## Common mistakes

| Wrong | Right |
|---|---|
| Assume `localhost:4001` | Ask; only use a URL the user named |
| `connect` skill | That links notes. This points the CLI and readies the drive |
| Skip `init` and call `docs list` | Profile, ping, then drive |
| Bake the URL into a script | Profile on the machine; user chose it |
| `auth login --renown` only | Also `--token "$(ph access-token)"` — signing is not authentication; a protected Switchboard answers 401 without the bearer |
| Retry a `Forbidden` write, or route around it | Stop; the address needs a `WRITE` grant from a vault administrator |
| Ask for `ADMIN` | `WRITE` runs the whole pipeline; `ADMIN` is for granting others |

## Idempotency

Safe to re-run: skip steps that already pass; never duplicate folders or singletons.
