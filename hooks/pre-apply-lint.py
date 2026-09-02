#!/usr/bin/env python3
"""
PreToolUse hook: lint every `switchboard docs apply` / `docs mutate` an agent
runs, BEFORE it runs, and block it if the payload would be rejected.

Claude Code hands us the pending Bash command on stdin as JSON. We find any
write to a document — `docs apply <id> --file F | --actions J` or
`docs mutate <id> --op OP --input J | --input-file F` — reconstruct the
actions array, and run scripts/lint-actions.mjs on it. Exit 2 blocks the tool
call and shows stderr to the agent; exit 0 lets it through.

Fails OPEN: if anything about this hook itself breaks (no node, odd quoting),
it warns and lets the command run. The hook must never be the thing that
stops an agent working; the linter's job is to stop a bad write.
"""
import json, os, re, shlex, subprocess, sys, tempfile

def camel_to_snake(op: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", op).upper()

def find_writes(command: str):
    """Yield ('apply', file, inline) / ('mutate', op, file, inline) for each write in the command."""
    try:
        toks = shlex.split(command)
    except ValueError:
        return
    # split on shell separators so chained commands are each inspected
    groups, cur = [], []
    for t in toks:
        if t in ("&&", "||", ";", "|"):
            groups.append(cur); cur = []
        else:
            cur.append(t)
    groups.append(cur)
    for g in groups:
        if len(g) < 3 or os.path.basename(g[0]) != "switchboard" or g[1] != "docs":
            continue
        def val(flag):
            return g[g.index(flag) + 1] if flag in g and g.index(flag) + 1 < len(g) else None
        if g[2] == "apply":
            yield ("apply", val("--file"), val("--actions"))
        elif g[2] == "mutate":
            yield ("mutate", val("--op"), val("--input-file"), val("--input"))

def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    if "switchboard" not in command or "docs" not in command:
        return 0
    root = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    linter = os.path.join(root, "scripts", "lint-actions.mjs")
    if not os.path.exists(linter):
        return 0

    problems = []
    for w in find_writes(command):
        actions_json = None
        label = ""
        if w[0] == "apply":
            _, file, inline = w
            if file and file != "-":
                try: actions_json = open(file, encoding="utf-8").read(); label = file
                except OSError: continue
            elif inline:
                actions_json = inline; label = "--actions"
        else:
            _, op, file, inline = w
            raw = None
            if file:
                try: raw = open(file, encoding="utf-8").read(); label = file
                except OSError: continue
            elif inline:
                raw = inline; label = "--input"
            if raw is None or not op:
                continue
            try:
                actions_json = json.dumps([{"type": camel_to_snake(op), "input": json.loads(raw), "scope": "global"}])
            except ValueError:
                continue  # not JSON; the CLI will report that itself
        if actions_json is None:
            continue
        try:
            r = subprocess.run(["node", linter, "-"], input=actions_json, capture_output=True, text=True, timeout=20)
        except Exception as e:  # fail open
            print(f"[lint-actions hook] could not run linter ({e}); letting the command through", file=sys.stderr)
            return 0
        if r.returncode == 1:
            problems.append(f"{label}:\n{r.stderr.strip() or r.stdout.strip()}")
    if problems:
        print("BLOCKED by powerhouse-knowledge pre-apply lint — the reactor would reject part of this write silently:\n\n"
              + "\n\n".join(problems)
              + "\n\nFix the payload (count the description as UTF-16 units; lowercase noteType; valid enums; real line breaks) and re-run.",
              file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
