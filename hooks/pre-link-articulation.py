#!/usr/bin/env python3
"""
PreToolUse hook: no knowledge edge without a reason.

The articulation test — "A connects to B because [specific reason]" — is the
vault's one rule for links. Until CLI 1.0.36 the reason could only live in
note prose, where nothing could check it; `docs link --reason` now stores it
as relationship metadata on the edge itself, and the health report counts
edges that carry one. This hook makes the agent write it there.

  * `docs link … -t RELATES_TO|BUILDS_ON|CONTRADICTS|SUPERSEDES|DERIVED_FROM`
    without a usable `--reason` is BLOCKED (exit 2) with the corrected form;
  * a reason must be a sentence, not a token: at least MIN_REASON_CHARS,
    not just the type name, not the literal placeholder;
  * navigation edges (`CORE_IDEA`, `CHILD_MOC`, the reactor's `child`) may
    stay bare — their meaning IS the type;
  * `docs annotate` (UPDATE_RELATIONSHIP) is held to the same reason quality.

Escape hatch: POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1 for bulk imports of
links whose reasons genuinely do not exist yet — the import skill says how to
record that honestly afterwards. Fails OPEN if the hook itself cannot parse
the command (the CLI reports its own errors).
"""
import os, re, shlex, sys, json

KNOWLEDGE_TYPES = {"RELATES_TO", "BUILDS_ON", "CONTRADICTS", "SUPERSEDES", "DERIVED_FROM"}
NAVIGATION_TYPES = {"CORE_IDEA", "CHILD_MOC", "child"}
MIN_REASON_CHARS = 20
PLACEHOLDERS = {"because", "reason", "todo", "tbd", "n/a", "none", "...", "…"}

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
    i = 0
    while i < len(g) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", g[i]):
        i += 1
    return g[i:]

def option(args, *flags):
    """Value of the first present flag, supporting `--flag value` and `--flag=value`."""
    for i, a in enumerate(args):
        for f in flags:
            if a == f and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(f + "="):
                return a[len(f) + 1:]
    return None

def link_commands(command: str):
    """Yield (subcommand, rel_type, reason) for each docs link / annotate in the command."""
    for g in split_groups(command):
        g = strip_env_prefix(g)
        if len(g) < 2 or os.path.basename(g[0]) != "switchboard":
            continue
        rest = g[1:]
        while rest and rest[0].startswith("-"):
            rest = rest[2:] if rest[0] in ("-p", "--profile", "--format") and len(rest) > 1 else rest[1:]
        if len(rest) < 2 or rest[0] != "docs" or rest[1] not in ("link", "annotate"):
            continue
        args = rest[2:]
        rel_type = option(args, "-t", "--type") or "RELATES_TO"
        reason = option(args, "-r", "--reason")
        yield rest[1], rel_type, reason

def reason_problem(reason):
    """None when the reason passes; otherwise why it does not."""
    if reason is None:
        return "no --reason given"
    text = re.sub(r"\s+", " ", reason).strip()
    if not text:
        return "--reason is blank"
    if text.lower().strip(".:") in PLACEHOLDERS or text.upper() in KNOWLEDGE_TYPES:
        return f"--reason {text!r} is a placeholder, not an articulation"
    if len(text) < MIN_REASON_CHARS:
        return f"--reason {text!r} is too short ({len(text)} chars; a sentence of at least {MIN_REASON_CHARS})"
    return None

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    command = ((payload.get("tool_input") or {}).get("command")) or ""
    if "switchboard" not in command or "docs" not in command:
        return 0
    allow_bare = os.environ.get("POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS") == "1"
    problems = []
    for sub, rel_type, reason in link_commands(command):
        if sub == "link" and rel_type in NAVIGATION_TYPES:
            continue
        if sub == "link" and rel_type in KNOWLEDGE_TYPES and reason is None and allow_bare:
            continue
        problem = reason_problem(reason)
        if problem:
            problems.append(f"docs {sub} … -t {rel_type}: {problem}")
    if not problems:
        return 0
    print(
        "BLOCKED by powerhouse-knowledge: a knowledge edge needs its reason ON THE EDGE.\n\n"
        + "\n".join(f"  - {p}" for p in problems)
        + "\n\nThe articulation test is the vault's one rule for links: \"A connects to B because [specific reason]\". "
        "Since CLI 1.0.36 the reason is stored as relationship metadata, where the graph and the health report can read it:\n\n"
        "  switchboard docs link <source> <target> -t BUILDS_ON \\\n"
        "    --reason \"<source> extends <target>'s claim about X to Y\" --confidence established\n\n"
        "Write the reason as the specific sentence you would give a reader (>= 20 chars; not the type name). "
        "Add --confidence grounded|established|speculative when you can say how well-founded the link is. "
        "CORE_IDEA / CHILD_MOC edges may stay bare. For a bulk import of links whose reasons do not exist yet, "
        "set POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS=1 and record the gap as the import skill describes. "
        "If the CLI rejects --reason as an unexpected argument, run `switchboard update` (needs >= 1.0.36).",
        file=sys.stderr,
    )
    return 2

if __name__ == "__main__":
    sys.exit(main())
