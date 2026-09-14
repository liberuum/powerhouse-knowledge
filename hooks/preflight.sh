#!/bin/sh
# Pre-flight for powerhouse-knowledge vault commands.
#
# Extracted from hooks/hooks.json, where it was a single 2,259-character line.
# Inline, it read as an obfuscated blob — a plugin security scanner flagged it
# CRITICAL for obfuscation and supply-chain — and nobody could review it. The
# behaviour is unchanged: read the prompt from stdin, and if it is one of this
# plugin's commands, print the connection facts the agent needs before acting.
#
# Every step is best-effort: a missing tool prints a warning and the hook still
# exits 0, because a pre-flight must never block the user's prompt.

set -u

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null)

# Only run for this plugin's commands.
case "$PROMPT" in
  /powerhouse-knowledge:*|/seed*|/extract*|/connect*|/synthesize*|/verify*|/pipeline*|/health*|/graph*|/search*|/setup*|/import*|/export*|/watch*|/projects*|/scope-of-work*|/skills*|/cli-reference*|/rest-api*) ;;
  *) exit 0 ;;
esac

if ! which switchboard >/dev/null 2>&1; then
  echo 'WARNING: switchboard CLI not found — install: download https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh, read it, then run it'
  exit 0
fi

# Is the Switchboard reachable, and are the vault models deployed?
switchboard ping 2>&1 | head -1
switchboard models list --format json 2>/dev/null | grep -q 'bai/' || switchboard introspect 2>&1 | tail -1

# Which server, which identity, which drive.
switchboard config show 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Profile: {d.get(\"name\",\"unknown\")} -> {d.get(\"url\",\"unknown\")}')" 2>/dev/null

switchboard auth status --format json 2>/dev/null | python3 -c "
import json,sys
d = json.load(sys.stdin)
if d.get('signing'):
    warn = ' — WARNING: Renown credential expired; run ph login' if d.get('credential_expired') else ''
    print(f'Signing: on as {d.get(\"app_name\")} ({d.get(\"did\",\"\")[:24]}…) for {d.get(\"address\")}' + warn)
elif 'signing' in d:
    print('WARNING: no signing identity on this profile — vault writes are BLOCKED until: ph login && switchboard auth login --renown')
else:
    print('WARNING: switchboard CLI < 1.0.34 — run: switchboard update (signed writes required)')
" 2>/dev/null

switchboard drives list --format json 2>/dev/null | python3 -c "
import json,sys
drives = json.load(sys.stdin)
vault = [d for d in drives
         if any(n.get('documentType') == 'bai/vault-config'
                for n in d.get('state', {}).get('global', {}).get('nodes', []))]
if vault:
    print(f'VAULT_DRIVE_SLUG={vault[0][\"slug\"]}')
    print(f'VAULT_DRIVE_ID={vault[0][\"id\"]}')
else:
    print('NOTE: no vault drive found on this profile — ask the user which vault to use')
" 2>/dev/null

# Warn if the generated agent files have drifted from AGENT.md.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/build-agent.mjs" --check >/dev/null 2>&1 \
    || echo 'WARNING: agents/knowledge-agent.md or AGENTS.md is stale — run: node scripts/build-agent.mjs'
  node "$CLAUDE_PLUGIN_ROOT/scripts/methodology.mjs" --check >/dev/null 2>&1 \
    || echo 'NOTE: methodology corpus not unpacked — run: node scripts/methodology.mjs (grounding checks need it)'
  python3 "$CLAUDE_PLUGIN_ROOT/hooks/session-access-probe.py" 2>/dev/null
fi

exit 0
