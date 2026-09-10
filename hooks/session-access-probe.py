#!/usr/bin/env python3
"""
Pre-flight (UserPromptSubmit) probe: one `ACCESS:` line per vault command, so
the agent knows BEFORE its first write whether this profile can read and write
the vault — and, if not, which of the two gates is shut and what opens it.

Two things stand between an agent and a vault write, and they fail differently
(AGENT.md → "Authenticate, then get access"):

  * identity — a Renown bearer on every request (401 without it) and a signing
               key on writes (the pre-write hook blocks without it);
  * access   — a READ / WRITE / ADMIN grant on the vault drive (FORBIDDEN
               without it).

The probe asks the Switchboard itself, as the active profile:

  * `document(identifier: <drive>) { document { id } }`
      — can this identity READ the drive?
  * `canExecuteOperation(documentId: <drive>, operationType: "ADD_FILE")`
      — may it create documents in it? That is `canMutate`: the WRITE grant
        (or an explicit operation grant) — the exact check every write faces.

Contract: prints at most one line, starting with `ACCESS:`; exits 0 whatever
happens (a probe must never block the prompt); never prints a token.
"""
import json
import subprocess

TIMEOUT_S = 15

FIX_401 = (
    'run: ph login && switchboard auth login --token "$(ph access-token)"'
    " (then switchboard auth login --renown for signing)"
)


def run(args):
    try:
        r = subprocess.run(["switchboard", *args], capture_output=True, text=True, timeout=TIMEOUT_S)
    except FileNotFoundError:
        return 127, "", "switchboard CLI not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    return r.returncode, r.stdout, r.stderr


def auth_status():
    code, out, _ = run(["auth", "status", "--format", "json"])
    if code != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def vault_drive():
    """('ok', {'slug','id'}) | ('none', None) | ('error', text)."""
    code, out, err = run(["drives", "list", "--format", "json"])
    if code != 0:
        return "error", (err or out).strip()
    try:
        drives = json.loads(out)
    except ValueError:
        return "error", "drives list returned no JSON"
    for d in drives:
        nodes = d.get("state", {}).get("global", {}).get("nodes", [])
        if any(n.get("documentType") == "bai/vault-config" for n in nodes):
            return "ok", {"slug": d.get("slug"), "id": d.get("id")}
    return "none", None


def query(gql):
    """('ok', data) | ('error', text) — text is what the CLI printed."""
    code, out, err = run(["query", gql, "--format", "json"])
    if code != 0:
        return "error", (err or out).strip()
    try:
        return "ok", json.loads(out)
    except ValueError:
        return "error", "no JSON in response"


def classify_error(text):
    """Map the CLI's error text to the gate it names.

    The CLI renders a non-2xx as `HTTP 401 Unauthorized: {"error":"…"}`, GraphQL
    refusals as `GraphQL errors:\\n  Forbidden: …`, and a dead server as
    `Failed to connect to <url>`.
    """
    low = (text or "").lower()
    if "failed to connect" in low or "transient gateway" in low or "timed out" in low:
        return "unreachable"
    if (
        "http 401" in low
        or "authentication required" in low
        or "unauthenticated" in low
        or "credentials no longer valid" in low
        or "token verification failed" in low
    ):
        return "unauthenticated"
    if "cannot query field" in low and "canexecuteoperation" in low:
        return "no-auth-subgraph"
    if "http 403" in low or "forbidden" in low or "insufficient permissions" in low:
        return "forbidden"
    return "other"


def first_line(text, limit=160):
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            if line.startswith("Error:"):
                line = line[len("Error:"):].strip()
            if len(line) <= limit:
                return line
            return line[:limit].rsplit(" ", 1)[0] + "…"
    return ""


def _read_only(slug, who, expired):
    return (
        f"ACCESS: READ-only on {slug} as {who} — every write will be refused (FORBIDDEN). "
        f"Ask a vault administrator to grant WRITE on the drive to {who}; do not retry writes until then.{expired}"
    )


def interpret(status, drive, read, write):
    """The one ACCESS line, from what the CLI answered. Pure, for tests."""
    status = status or {}
    who = status.get("address") or "this profile"
    slug = (drive or {}).get("slug") or "the vault"
    expired = (
        " — WARNING: the Renown credential has expired; run ph login"
        if status.get("credential_expired")
        else ""
    )

    kind, payload = read
    if kind == "error":
        c = classify_error(payload)
        if c == "unreachable":
            return f"ACCESS: unknown — the Switchboard did not answer ({first_line(payload)})."
        if c == "unauthenticated":
            return f"ACCESS: 401 — no valid bearer on this profile, so nothing can be read or written; {FIX_401}"
        if c == "forbidden":
            return (
                f"ACCESS: none on {slug} for {who} — the vault is protected and this address holds no grant. "
                f"Ask a vault administrator to grant READ (to read) or WRITE (to contribute) on the drive to {who}; "
                f"do not retry until then.{expired}"
            )
        return f"ACCESS: unknown — could not read the drive ({first_line(payload)})."

    kind, payload = write
    if kind == "error":
        c = classify_error(payload)
        if c == "no-auth-subgraph":
            return "ACCESS: open — this Switchboard runs without the authorization subgraph, so grants are not enforced."
        if c == "forbidden":
            return _read_only(slug, who, expired)
        if c == "unauthenticated":
            return f"ACCESS: 401 — the bearer was refused; {FIX_401}"
        return f"ACCESS: READ on {slug} as {who}; could not check write permission ({first_line(payload)}).{expired}"

    can = payload.get("canExecuteOperation") if isinstance(payload, dict) else None
    if can is True:
        return f"ACCESS: WRITE on {slug} as {who} — reads and writes will be accepted.{expired}"
    if can is False:
        return _read_only(slug, who, expired)
    return f"ACCESS: READ on {slug} as {who}; write permission unknown.{expired}"


def main():
    status = auth_status()
    kind, drive = vault_drive()
    if kind == "error":
        c = classify_error(drive)
        if c == "unauthenticated":
            print(f"ACCESS: 401 — no valid bearer on this profile, so nothing can be read or written; {FIX_401}")
        elif c == "unreachable":
            print(f"ACCESS: unknown — the Switchboard did not answer ({first_line(drive)}).")
        else:
            print(f"ACCESS: unknown — could not list drives ({first_line(drive)}).")
        return 0
    if kind == "none":
        return 0  # the pre-flight already says there is no vault drive on this profile

    did = drive["id"]
    read = query(f'{{ document(identifier: "{did}") {{ document {{ id }} }} }}')
    write = query(f'{{ canExecuteOperation(documentId: "{did}", operationType: "ADD_FILE") }}')
    line = interpret(status, drive, read, write)
    if line:
        print(line)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — a probe never blocks the prompt
        raise SystemExit(0)
