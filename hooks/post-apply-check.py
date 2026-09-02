#!/usr/bin/env python3
"""
PostToolUse hook: after an agent's `switchboard docs apply` / `docs mutate`
completes, read the document's recent operations and report any the reactor
REJECTED — with the reactor's own error text.

Why: the reactor applies the valid actions of a batch, records each rejected
one with its error, and reports the job as successful. Without this, an agent
learns of a rejection only by noticing a field that never changed. The
operation log knows exactly what happened; this hook reads it back so the
agent sees, e.g.:

  ✗ post-apply check on 8bf48aef: 1 of 3 recent operations REJECTED
      #16 SET_DESCRIPTION — Description exceeds 200 characters

Informational only (exit 0): PostToolUse output is shown to the agent as
context. Fails open on any error of its own. Uses `switchboard` so it targets
whatever profile the agent is already using — no endpoint is hardcoded.
"""
import json, os, re, shlex, subprocess, sys
from datetime import datetime, timedelta, timezone

def summarize(err):
    """One line for a reactor error: reducer messages pass through; zod issue
    arrays become `code at path: detail`."""
    text = str(err).strip()
    try:
        issues = json.loads(text)
        if isinstance(issues, list):
            parts = []
            for i in issues[:3]:
                path = ".".join(str(p) for p in (i.get("path") or [])) or "input"
                detail = i.get("message") or ""
                if i.get("values"): detail = f"expected one of {', '.join(map(str, i['values']))}"
                parts.append(f"{i.get('code','invalid')} at {path}: {detail}")
            return "; ".join(parts)[:200]
    except ValueError:
        pass
    return text.splitlines()[0][:160]

def writes(command):
    try: toks = shlex.split(command)
    except ValueError: return
    groups, cur = [], []
    for t in toks:
        if t in ("&&", "||", ";", "|"): groups.append(cur); cur = []
        else: cur.append(t)
    groups.append(cur)
    for g in groups:
        if len(g) >= 4 and os.path.basename(g[0]) == "switchboard" and g[1] == "docs" and g[2] in ("apply", "mutate"):
            yield g[2], g[3], ("--wait" in g)

def main():
    try: payload = json.load(sys.stdin)
    except Exception: return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    if "switchboard" not in command: return 0
    resp = payload.get("tool_response")
    out = ""
    if isinstance(resp, dict): out = str(resp.get("stdout") or "") + str(resp.get("stderr") or "")
    elif isinstance(resp, str): out = resp
    targets = list(writes(command))
    if not targets: return 0

    job_ids = re.findall(r'"jobId":\s*"([0-9a-f-]{36})"', out)
    # Only operations from the last few minutes belong to this command; the
    # window is generous so a slow job still counts, and overridable for tests.
    minutes = float(os.environ.get("POST_APPLY_WINDOW_MIN", "5"))
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    for kind, doc_id, waited in targets:
        if not waited:
            for jid in job_ids[:3]:
                subprocess.run(["switchboard", "jobs", "wait", jid, "--timeout", "60", "--quiet"], capture_output=True, text=True, timeout=90)
        q = ('{ document(identifier:"%s"){ document{ operations(filter:{ scopes:["global"], timestampFrom:"%s" }, paging:{ limit:200 }){ items{ index error action{ type } } } } } }' % (doc_id, since))
        try:
            r = subprocess.run(["switchboard", "query", q, "--format", "json"], capture_output=True, text=True, timeout=60)
            data = json.loads(r.stdout)
        except Exception as e:
            print(f"post-apply check: could not read operations for {doc_id[:8]} ({e})"); continue
        data = data.get("data", data)
        doc = ((data.get("document") or {}).get("document")) if isinstance(data, dict) else None
        if not doc:
            continue  # bogus id or not a document — nothing to check
        ops = (doc.get("operations") or {}).get("items") or []
        rejected = [o for o in ops if o.get("error")]
        if rejected:
            print(f"✗ post-apply check on {doc_id[:8]}: {len(rejected)} of {len(ops)} recent operations were REJECTED by the reactor (the job still reported success):")
            for o in rejected:
                print(f"    #{o['index']} {o['action']['type']} — {summarize(o['error'])}")
            print("  The other actions in the batch applied. Fix and re-dispatch only the rejected ones; then read the document back.")
        else:
            print(f"✓ post-apply check on {doc_id[:8]}: {len(ops)} recent operation(s), none rejected")
    return 0

if __name__ == "__main__":
    sys.exit(main())
