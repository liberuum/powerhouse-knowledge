#!/usr/bin/env python3
"""
PreToolUse hook: no vault write without a signing identity, and every agent
write labelled as the agent's.

Why. A Switchboard signs every unsigned action with ITS identity and stamps
the user from ITS `ph login` session, so an unsigned agent write is attributed
to whoever logged the server in — or to nobody. `switchboard auth login
--renown` (CLI >= 1.0.34) makes the CLI sign client-side with the user's own
`ph login` key; the reactor stores that signature untouched and the vault can
show "written by the agent, acting for <address>". This hook is the "first
step before writing" the vault requires:

  * a write command with NO signing identity configured is BLOCKED (exit 2)
    with the exact commands that fix it;
  * a write with an identity is let through with
    `SWITCHBOARD_APP_NAME=powerhouse-knowledge` exported in front of it, via
    `updatedInput`, so the operation's `signer.app.name` says who really
    wrote it. The user's profile keeps its own label for manual use; the
    permission flow is untouched (no permissionDecision is set);
  * a raw `addRelationship`/`removeRelationship` mutation is steered to
    `docs link` / `docs unlink`, which are signed — the mutation form is
    always signed by the server.

Escape hatch: POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED=1 in the agent's environment
lets unsigned writes through (still labelled, nothing else changes). Fails
OPEN if the hook itself cannot run (no switchboard binary → the command will
fail on its own with a clearer error).
"""
import json, os, re, shlex, subprocess, sys

APP_NAME = "powerhouse-knowledge"
MIN_CLI = "1.0.34"
WRITE_SUBCOMMANDS = {"apply", "mutate", "link", "unlink", "annotate", "create"}

def split_groups(command: str):
    try:
        toks = shlex.split(command)
    except ValueError:
        return []
    groups, cur = [], []
    for t in toks:
        if t in ("&&", "||", ";", "|"):
            groups.append(cur); cur = []
        else:
            cur.append(t)
    groups.append(cur)
    return groups

def strip_env_prefix(g):
    """Drop leading VAR=value words so `FOO=1 switchboard …` is still recognised."""
    i = 0
    while i < len(g) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", g[i]):
        i += 1
    return g[i:]

def classify(command: str):
    """Return (writes, raw_relationship_mutation, profile)."""
    writes, raw_rel, profile = [], False, None
    for g in split_groups(command):
        g = strip_env_prefix(g)
        if len(g) < 2 or os.path.basename(g[0]) != "switchboard":
            continue
        # Global options may precede the subcommand: `switchboard -p X docs …`.
        rest = g[1:]
        while rest and rest[0].startswith("-"):
            flag = rest[0]
            if flag in ("-p", "--profile") and len(rest) > 1:
                profile = rest[1]
                rest = rest[2:]
            elif flag in ("--format",) and len(rest) > 1:
                rest = rest[2:]
            else:
                rest = rest[1:]
        if not rest:
            continue
        if rest[0] == "docs" and len(rest) >= 2 and rest[1] in WRITE_SUBCOMMANDS:
            writes.append(f"docs {rest[1]}")
        elif rest[0] == "query":
            body = " ".join(rest[1:])
            if re.search(r"\b(addRelationship|removeRelationship)\s*\(", body):
                raw_rel = True
    return writes, raw_rel, profile

def auth_status(profile):
    cmd = ["switchboard"] + (["-p", profile] if profile else []) + ["auth", "status", "--format", "json"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        return None, "switchboard CLI not found"
    except Exception as e:  # noqa: BLE001
        return None, str(e)
    try:
        return json.loads(r.stdout), None
    except ValueError:
        return None, (r.stderr or r.stdout).strip() or "auth status returned nothing"

def block(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 2

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") or ""
    if "switchboard" not in command:
        return 0
    writes, raw_rel, profile = classify(command)
    if raw_rel:
        return block(
            "BLOCKED by powerhouse-knowledge: use `switchboard docs link <source> <target> -t <TYPE>` "
            "(or `docs unlink`) instead of the raw addRelationship/removeRelationship mutation. "
            "The mutation builds the action server-side and is always signed by the Switchboard's identity; "
            "`docs link` sends the ADD_RELATIONSHIP action signed as you, so the edge is attributable "
            "like every other agent write.")
    if not writes:
        return 0

    allow_unsigned = os.environ.get("POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED") == "1"
    status, err = auth_status(profile)
    if status is None:
        if allow_unsigned or err == "switchboard CLI not found":
            return 0  # the command itself will report the missing binary
        return block(f"BLOCKED by powerhouse-knowledge: could not read `switchboard auth status` ({err}).")

    if "signing" not in status:
        if allow_unsigned:
            return 0
        return block(
            f"BLOCKED by powerhouse-knowledge: this switchboard CLI predates signed writes (need >= {MIN_CLI}). "
            "Run `switchboard update`, then `switchboard auth login --renown`. "
            "Set POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED=1 to write unsigned on purpose (attributed to the server's identity).")
    if status.get("identity_error"):
        if allow_unsigned:
            return 0
        return block(
            "BLOCKED by powerhouse-knowledge: the profile's signing identity is broken — "
            f"{status['identity_error']}\nRun `ph login` in that directory, then `switchboard auth login --renown --ph-dir <dir>`.")
    if not status.get("signing"):
        if allow_unsigned:
            return 0
        prof = status.get("profile", profile or "default")
        return block(
            f"BLOCKED by powerhouse-knowledge: profile '{prof}' has no signing identity, so these writes "
            f"({', '.join(writes)}) would be attributed to the Switchboard's own identity, not to you.\n"
            "First step before writing to the vault:\n"
            "  1. ph login                         # once per machine: creates .ph/.keypair.json + .ph/.renown.json\n"
            "  2. switchboard auth login --renown  # point the profile at it (use --ph-dir if it is elsewhere)\n"
            "  3. switchboard auth status          # expect: Signing: on … acting for <your address>\n"
            "Then re-run the write. (POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED=1 bypasses this on purpose.)")

    if status.get("credential_expired"):
        print(f"[powerhouse-knowledge] Renown credential expired {status.get('credential_expires')} — "
              "writes are still signed by your key; run `ph login` to renew the key↔address binding.", file=sys.stderr)

    # Label the write as the agent's, without touching the profile or the
    # permission flow. `export` reaches every command in the invocation, which
    # a plain `VAR=… cmd` prefix would not for `cd … && switchboard …`.
    if "SWITCHBOARD_APP_NAME" not in command:
        updated = dict(tool_input)
        updated["command"] = f"export SWITCHBOARD_APP_NAME={APP_NAME}; {command}"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
