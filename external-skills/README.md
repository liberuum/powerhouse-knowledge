# External skills (pinned mirrors)

Skills whose canonical copy lives in ANOTHER repo. Each directory holds:

- `SKILL.md` — a pinned mirror of the external file, used by the sync for
  hashing and vault ingestion
- `CANONICAL` — the URL of the true source of truth

Refresh one:

```bash
curl -sL <raw-url-of-canonical> > external-skills/<name>/SKILL.md
node scripts/sync-skills.mjs --endpoint <...> --drive <...>
```

`scripts/sync-skills.mjs` picks this directory up automatically. The vault
note and source point at the CANONICAL url, not this mirror.
