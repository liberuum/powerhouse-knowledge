#!/usr/bin/env python3
"""Look up anything nested inside a scope of work.

Projects, deliverables, roadmaps, milestones, cited maps/notes, people and
the linked WBS goal tree all live *inside* documents — they are not
documents themselves. This script is the vault-aware layer over the
Switchboard CLI (model-agnostic). It does not mutate.

    python3 lookup.py list
    python3 lookup.py get "PPD"
    python3 lookup.py get "paperless billing"
    python3 lookup.py get "[[<scope-id>#<envelope-id>]]"
    python3 lookup.py search "paperless billing"
    python3 lookup.py search M1 --kind milestone
    python3 lookup.py outline <scope-id>

Drive: --drive, else $VAULT_DRIVE_SLUG / $VAULT_DRIVE_ID.
Profile: --profile / -p, else the CLI default.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess


SOW_TYPE = "powerhouse/scopeofwork"
WBS_TYPE = "bai/wbs"
CITE_RE = re.compile(r"\[\[([^\]#]+)(?:#([^\]]+))?\]\]")
BARE_CITE_RE = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.I,
)
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)

KINDS = (
    "scope",
    "envelope",
    "deliverable",
    "roadmap",
    "milestone",
    "contributor",
    "map",
    "goal",
)


def sb(profile: str | None, args: list[str]) -> object:
    cmd = ["switchboard"]
    if profile:
        cmd += ["-p", profile]
    cmd += args + ["--format", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
        raise SystemExit(f"switchboard {' '.join(args)} failed:\n{err}")
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        raise SystemExit(f"switchboard returned non-JSON:\n{out[:500]}") from e


def drive_flag(drive: str | None) -> list[str]:
    return ["--drive", drive] if drive else []


def resolve_drive(profile: str | None, drive: str | None) -> str | None:
    """Accept a UUID, slug, or drive *name* (e.g. powerhouse-knowledge)."""
    if not drive:
        return None
    if UUID_RE.match(drive):
        return drive
    data = sb(profile, ["drives", "list"])
    for d in data if isinstance(data, list) else []:
        if drive in (d.get("slug"), d.get("id"), d.get("name")):
            return d.get("id") or d.get("slug")
    return drive


def list_docs(profile: str | None, drive: str | None, doc_type: str) -> list[dict]:
    data = sb(profile, ["docs", "list", *drive_flag(drive), "-t", doc_type])
    if data is None:
        return []
    if isinstance(data, list):
        return data
    return []


def get_state(profile: str | None, drive: str | None, ident: str) -> dict:
    data = sb(profile, ["docs", "get", ident, *drive_flag(drive), "--state"])
    if not isinstance(data, dict):
        raise SystemExit(f"docs get {ident}: unexpected payload")
    return data


def try_get_state(profile: str | None, drive: str | None, ident: str) -> dict | None:
    try:
        return get_state(profile, drive, ident)
    except SystemExit:
        return None


def global_state(doc: dict) -> dict:
    state = doc.get("state") or {}
    if isinstance(state, str):
        state = json.loads(state)
    g = state.get("global") if isinstance(state, dict) else None
    return g if isinstance(g, dict) else {}


def envelope_deliverables(g: dict, env: dict) -> list[dict]:
    ids = set((env.get("scope") or {}).get("deliverables") or [])
    return [d for d in (g.get("deliverables") or []) if d.get("id") in ids]


def milestone_index(g: dict) -> dict[str, list[str]]:
    """deliverable id → list of 'roadmap / M1 title' labels."""
    out: dict[str, list[str]] = {}
    for r in g.get("roadmaps") or []:
        rtitle = r.get("title") or r.get("slug") or r.get("id")
        for m in r.get("milestones") or []:
            label = f"{m.get('sequenceCode') or '?'} {m.get('title') or ''}".strip()
            label = f"{rtitle} / {label}"
            for did in (m.get("scope") or {}).get("deliverables") or []:
                out.setdefault(did, []).append(label)
    return out


def owned_ids(g: dict, env: dict) -> set:
    return {d.get("id") for d in envelope_deliverables(g, env)}


def parse_cite(query: str) -> tuple[str, str | None] | None:
    q = query.strip()
    m = CITE_RE.fullmatch(q) or CITE_RE.search(q)
    if m:
        return m.group(1).strip(), (m.group(2) or "").strip() or None
    m = BARE_CITE_RE.fullmatch(q)
    if m:
        return m.group(1), m.group(2)
    return None


def score_text(q: str, exacts: list[str | None], titles: list[str | None], blobs: list[str | None]) -> int:
    """Higher wins. Exact id/code/slug beat exact title; title beats other text."""
    if not q:
        return 0
    for v in exacts:
        if v and q == v.lower():
            return 100
    for v in titles:
        if not v:
            continue
        t = v.lower()
        if q == t:
            return 90
        if q in t:
            return 70
    for v in blobs:
        if v and q in v.lower():
            return 40
    return 0


def score_hit(query: str, env: dict, g: dict, sow: dict) -> int:
    """Envelope score. Nested matches only count for *this* envelope's fields."""
    q = query.lower()
    if not q:
        return 0
    best = score_text(
        q,
        [env.get("id"), env.get("code"), env.get("slug"), sow.get("id")],
        [env.get("title")],
        [env.get("abstract")],
    )
    if q in (g.get("title") or "").lower() or q in (sow.get("name") or "").lower():
        best = max(best, 10)
    ids = owned_ids(g, env)
    for r in g.get("roadmaps") or []:
        for m in r.get("milestones") or []:
            owned = ids & set((m.get("scope") or {}).get("deliverables") or [])
            if not owned:
                continue
            s = score_text(
                q,
                [m.get("id"), m.get("sequenceCode"), r.get("id"), r.get("slug")],
                [m.get("title"), r.get("title")],
                [m.get("description"), r.get("description")],
            )
            if s:
                best = max(best, min(s, 50) if s < 100 else 50)
    for d in envelope_deliverables(g, env):
        s = score_text(
            q,
            [d.get("id"), d.get("code"), d.get("goalRef")],
            [d.get("title")],
            [d.get("description")],
        )
        if s:
            best = max(best, min(s, 30) if s < 100 else 30)
    for ref in env.get("knowledgeRefs") or []:
        if q in str(ref).lower():
            best = max(best, 20)
    return best


def print_envelope(sow: dict, g: dict, env: dict, wbs_name: str | None) -> None:
    agents = {a.get("id"): a.get("name") for a in (g.get("contributors") or [])}
    owner_id = env.get("projectOwner")
    ds = envelope_deliverables(g, env)
    done = sum(1 for d in ds if d.get("status") == "DELIVERED")
    ms_of = milestone_index(g)
    sow_id = sow.get("id")
    print(f"SCOPE     {g.get('title') or sow.get('name')}  [{g.get('status')}]")
    print(f"          documentId={sow_id}  cite=[[{sow_id}]]")
    print(f"ENVELOPE  {env.get('code')} · {env.get('title')}")
    print(f"          id={env.get('id')}  slug={env.get('slug')}")
    print(f"          cite=[[{sow_id}#{env.get('id')}]]")
    print(f"          owner={agents.get(owner_id, owner_id)}  set={(env.get('scope') or {}).get('status')}")
    print(f"          {done}/{len(ds)} deliverables DELIVERED")
    if env.get("abstract"):
        print(f"          {env['abstract']}")
    print(f"          budgetType={env.get('budgetType')} currency={env.get('currency')} budget={env.get('budget')}")
    wbs = env.get("wbsRef")
    if wbs:
        print(f"WBS       {wbs_name or wbs}  documentId={wbs}  cite=[[{wbs}]]")
    else:
        print("WBS       (none linked)")
    refs = env.get("knowledgeRefs") or []
    if refs:
        print(f"MAPS      {len(refs)} cited notes/MoCs (envelope knowledgeRefs, not vault folders)")
        for r in refs:
            print(f"          [[{r}]]")
    for url in env.get("references") or []:
        print(f"REF       {url}")
    print("DELIVERABLES")
    if not ds:
        print("          (none)")
    for d in ds:
        owner = agents.get(d.get("owner"), d.get("owner"))
        print(f"  [{d.get('status'):<12}] {(d.get('code') or '—'):<8} {d.get('title')}")
        print(f"               id={d.get('id')}  owner={owner}  goalRef={d.get('goalRef')}")
        for lab in ms_of.get(d.get("id"), []):
            print(f"               milestone: {lab}")
        for kr in d.get("keyResults") or []:
            print(f"               KR {kr.get('title')}: {kr.get('link')}")
    print("SCHEDULE")
    owned = {d.get("id") for d in ds}
    any_ms = False
    for r in g.get("roadmaps") or []:
        touching = [
            m
            for m in (r.get("milestones") or [])
            if owned & set((m.get("scope") or {}).get("deliverables") or [])
            or not owned
        ]
        if not touching:
            continue
        any_ms = True
        print(f"  roadmap {r.get('title')} ({r.get('slug')})")
        for m in touching:
            coords = [agents.get(c, c) for c in (m.get("coordinators") or [])]
            print(
                f"    {m.get('sequenceCode')} {m.get('title')}  "
                f"target={m.get('deliveryTarget')}  coordinators={coords or '—'}"
            )
    if not any_ms:
        print("          (no milestones on this envelope)")
    print("PEOPLE")
    for a in g.get("contributors") or []:
        print(f"  {a.get('name')}  id={a.get('id')}  {a.get('description') or ''}")


def print_wbs(doc: dict, g: dict) -> None:
    print(f"WBS {doc.get('name')}  documentId={doc.get('id')}  cite=[[{doc.get('id')}]]")
    print(f"     sowRef={g.get('sowRef')}  sowProjectId={g.get('sowProjectId')}  owner={g.get('owner')}")
    print("GOALS")
    for goal in g.get("goals") or []:
        indent = "  " if goal.get("parentId") else ""
        extra = []
        if goal.get("assignee"):
            extra.append("@" + goal["assignee"])
        if goal.get("blockReason"):
            extra.append("blocked: " + goal["blockReason"])
        print(f"{indent}[{goal.get('status')}] {goal.get('description')}  {' '.join(extra)}")


def cmd_list(profile: str | None, drive: str | None) -> None:
    sows = list_docs(profile, drive, SOW_TYPE)
    wbs_docs = {d.get("id"): d.get("name") for d in list_docs(profile, drive, WBS_TYPE)}
    if not sows:
        print("No powerhouse/scopeofwork documents on this drive.")
        return
    for sow in sows:
        doc = get_state(profile, drive, sow["id"])
        g = global_state(doc)
        print(f"{g.get('title') or sow.get('name')}  [{g.get('status')}]  [[{sow['id']}]]")
        envs = g.get("projects") or []
        if not envs:
            print("  (no envelopes)")
            continue
        for env in envs:
            ds = envelope_deliverables(g, env)
            done = sum(1 for d in ds if d.get("status") == "DELIVERED")
            wbs = env.get("wbsRef")
            wbs_bit = f"  wbs={wbs_docs.get(wbs, wbs)}" if wbs else ""
            print(
                f"  {env.get('code') or '—':<8} {env.get('title')}  "
                f"set={(env.get('scope') or {}).get('status')}  "
                f"{done}/{len(ds)} delivered{wbs_bit}"
            )
            print(f"           envelope={env.get('id')}  cite=[[{sow['id']}#{env.get('id')}]]")


def find_envelope(sow: dict, g: dict, envelope_id: str) -> dict | None:
    eid = envelope_id.lower()
    for env in g.get("projects") or []:
        if (env.get("id") or "").lower() == eid or (env.get("code") or "").lower() == eid:
            return env
    return None


def cmd_get(profile: str | None, drive: str | None, query: str) -> None:
    q = query.strip()
    q_lower = q.lower()
    sows = list_docs(profile, drive, SOW_TYPE)
    wbs_docs = {d.get("id"): d.get("name") for d in list_docs(profile, drive, WBS_TYPE)}

    cite = parse_cite(q)
    if cite:
        scope_id, env_id = cite
        doc = get_state(profile, drive, scope_id)
        g = global_state(doc)
        if env_id:
            env = find_envelope(doc, g, env_id)
            if not env:
                raise SystemExit(f"No envelope {env_id} in scope {scope_id}")
            print_envelope(doc, g, env, wbs_docs.get(env.get("wbsRef")))
            return
        envs = g.get("projects") or []
        if len(envs) == 1:
            print_envelope(doc, g, envs[0], wbs_docs.get(envs[0].get("wbsRef")))
            return
        print(f"SCOPE {g.get('title')}  [{g.get('status')}]  [[{doc.get('id')}]]  ({len(envs)} envelopes — pick one)")
        for env in envs:
            print(f"  {env.get('code')}  {env.get('title')}  [[{doc.get('id')}#{env.get('id')}]]")
        return

    doc = try_get_state(profile, drive, q)
    if doc is not None:
        dtype = doc.get("documentType")
        if dtype == SOW_TYPE:
            g = global_state(doc)
            envs = g.get("projects") or []
            if len(envs) == 1:
                print_envelope(doc, g, envs[0], wbs_docs.get(envs[0].get("wbsRef")))
                return
            print(f"SCOPE {g.get('title')}  [{g.get('status')}]  [[{doc.get('id')}]]  ({len(envs)} envelopes — pick one)")
            for env in envs:
                print(f"  {env.get('code')}  {env.get('title')}  [[{doc.get('id')}#{env.get('id')}]]")
            return
        if dtype == WBS_TYPE:
            g = global_state(doc)
            print_wbs(doc, g)
            if g.get("sowRef"):
                sow = get_state(profile, drive, g["sowRef"])
                sg = global_state(sow)
                env = find_envelope(sow, sg, g.get("sowProjectId") or "")
                if env:
                    print()
                    print_envelope(sow, sg, env, doc.get("name"))
            return

    scored: list[tuple[int, dict, dict, dict]] = []
    for sow_meta in sows:
        sow = get_state(profile, drive, sow_meta["id"])
        g = global_state(sow)
        for env in g.get("projects") or []:
            s = score_hit(q_lower, env, g, sow)
            if s:
                scored.append((s, sow, g, env))
    scored.sort(key=lambda row: -row[0])
    if not scored:
        raise SystemExit(
            f"No envelope matched {query!r}. Try `lookup.py list` or `lookup.py search {query!r}`."
        )
    best = scored[0][0]
    top = [row for row in scored if row[0] == best]
    if len(top) > 1:
        print(f"{len(top)} matches for {query!r} (score {best}):")
        for _, sow, g, env in top:
            print(
                f"  {env.get('code')}  {env.get('title')}  "
                f"in {g.get('title')}  [[{sow.get('id')}#{env.get('id')}]]"
            )
        print("Pass a code, envelope id, or [[scopeId#envelopeId]] to pick one.")
        return
    _, sow, g, env = top[0]
    print_envelope(sow, g, env, wbs_docs.get(env.get("wbsRef")))


def collect_hits(
    profile: str | None,
    drive: str | None,
    q: str,
    kinds: set[str],
) -> list[tuple[int, str, str]]:
    """(score, kind, line) sorted high → low."""
    hits: list[tuple[int, str, str]] = []
    sows = list_docs(profile, drive, SOW_TYPE)
    wbs_cache: dict[str, dict] = {}

    def wbs_state(wbs_id: str) -> dict | None:
        if wbs_id in wbs_cache:
            return wbs_cache[wbs_id]
        doc = try_get_state(profile, drive, wbs_id)
        wbs_cache[wbs_id] = doc if doc is not None else {}
        return doc

    for sow_meta in sows:
        sow = get_state(profile, drive, sow_meta["id"])
        g = global_state(sow)
        sow_id = sow.get("id")
        scope_title = g.get("title") or sow.get("name")
        cite_scope = f"[[{sow_id}]]"

        if "scope" in kinds:
            s = score_text(q, [sow_id], [scope_title, sow.get("name")], [g.get("description")])
            if s:
                hits.append((s, "SCOPE", f"{scope_title}  [{g.get('status')}]  {cite_scope}"))

        def env_label(env: dict | None) -> str:
            if not env:
                return "—"
            return f"{env.get('code') or '—'} {env.get('title')}"

        for env in g.get("projects") or []:
            cite = f"[[{sow_id}#{env.get('id')}]]"
            if "envelope" in kinds:
                s = score_text(
                    q,
                    [env.get("id"), env.get("code"), env.get("slug")],
                    [env.get("title")],
                    [env.get("abstract")],
                )
                if s:
                    hits.append(
                        (s, "ENVELOPE", f"{env_label(env)}  in {scope_title}  {cite}")
                    )
            if "map" in kinds:
                for ref in env.get("knowledgeRefs") or []:
                    s = score_text(q, [ref], [], [])
                    if s or (UUID_RE.match(q) and q == str(ref).lower()):
                        hits.append(
                            (s or 100, "MAP", f"[[{ref}]]  cited by {env_label(env)}  {cite}")
                        )
            if "deliverable" in kinds:
                for d in envelope_deliverables(g, env):
                    s = score_text(
                        q,
                        [d.get("id"), d.get("code"), d.get("goalRef")],
                        [d.get("title")],
                        [d.get("description")],
                    )
                    if s:
                        hits.append(
                            (
                                s,
                                "DELIVERABLE",
                                f"[{d.get('status')}] {d.get('code')} {d.get('title')}  "
                                f"in {env_label(env)}  {cite}",
                            )
                        )
            if "goal" in kinds and env.get("wbsRef"):
                wdoc = wbs_state(env["wbsRef"])
                if wdoc:
                    wg = global_state(wdoc)
                    for goal in wg.get("goals") or []:
                        notes = " ".join(n.get("note") or "" for n in (goal.get("notes") or []))
                        s = score_text(
                            q,
                            [goal.get("id")],
                            [goal.get("description")],
                            [goal.get("assignee"), goal.get("blockReason"), goal.get("outcome"), notes],
                        )
                        if s:
                            hits.append(
                                (
                                    s,
                                    "GOAL",
                                    f"[{goal.get('status')}] {goal.get('description')}  "
                                    f"wbs=[[{env.get('wbsRef')}]]  {cite}",
                                )
                            )

        if "roadmap" in kinds or "milestone" in kinds:
            for r in g.get("roadmaps") or []:
                if "roadmap" in kinds:
                    s = score_text(
                        q,
                        [r.get("id"), r.get("slug")],
                        [r.get("title")],
                        [r.get("description")],
                    )
                    if s:
                        hits.append(
                            (s, "ROADMAP", f"{r.get('title')} ({r.get('slug')})  {cite_scope}")
                        )
                if "milestone" not in kinds:
                    continue
                for m in r.get("milestones") or []:
                    s = score_text(
                        q,
                        [m.get("id"), m.get("sequenceCode")],
                        [m.get("title")],
                        [m.get("description"), m.get("deliveryTarget")],
                    )
                    if not s:
                        continue
                    owners = []
                    m_dels = set((m.get("scope") or {}).get("deliverables") or [])
                    for env in g.get("projects") or []:
                        if owned_ids(g, env) & m_dels:
                            owners.append(env)
                    owner = owners[0] if len(owners) == 1 else None
                    cite = (
                        f"[[{sow_id}#{owner.get('id')}]]" if owner else cite_scope
                    )
                    hits.append(
                        (
                            s,
                            "MILESTONE",
                            f"{m.get('sequenceCode')} {m.get('title')}  "
                            f"roadmap={r.get('title')}  "
                            f"target={m.get('deliveryTarget')}  "
                            f"{env_label(owner) if owner else scope_title}  {cite}",
                        )
                    )

        if "contributor" in kinds:
            for a in g.get("contributors") or []:
                s = score_text(q, [a.get("id")], [a.get("name")], [a.get("description")])
                if s:
                    hits.append(
                        (s, "CONTRIBUTOR", f"{a.get('name')}  id={a.get('id')}  {cite_scope}")
                    )

    hits.sort(key=lambda row: (-row[0], row[1], row[2]))
    return hits


def cmd_search(
    profile: str | None,
    drive: str | None,
    query: str,
    kind: str | None,
    limit: int,
) -> None:
    q = query.strip().lower()
    if not q:
        raise SystemExit("search needs a query")
    kinds = set(KINDS)
    if kind:
        wanted = {k.strip().lower() for k in kind.split(",") if k.strip()}
        bad = wanted - set(KINDS)
        if bad:
            raise SystemExit(f"unknown --kind {sorted(bad)}. choose from: {', '.join(KINDS)}")
        kinds = wanted
    hits = collect_hits(profile, drive, q, kinds)
    if not hits:
        raise SystemExit(f"No nested SOW match for {query!r}. Try `lookup.py list`.")
    shown = hits[:limit]
    print(f"{len(hits)} hit(s) for {query!r}" + (f" (showing {len(shown)})" if len(hits) > limit else ""))
    for score, kind_name, line in shown:
        print(f"{kind_name:<12} {score:>3}  {line}")
    if len(hits) > limit:
        print(f"… {len(hits) - limit} more. Raise --limit or pass --kind.")


def cmd_outline(profile: str | None, drive: str | None, scope_id: str) -> None:
    drive_id = drive if drive and UUID_RE.match(drive) else os.environ.get("VAULT_DRIVE_ID")
    if not drive_id or not UUID_RE.match(str(drive_id)):
        raise SystemExit("outline needs --drive as the drive UUID, or $VAULT_DRIVE_ID")
    data = sb(
        profile,
        [
            "query",
            "{ knowledgeGraphNodeByDocumentId(driveId:\"%s\", documentId:\"%s\") { title noteType status content } }"
            % (drive_id, scope_id),
        ],
    )
    node = (data or {}).get("knowledgeGraphNodeByDocumentId") if isinstance(data, dict) else None
    if not node:
        raise SystemExit(f"No SCOPE node for {scope_id}. Is the drive UUID right? Is the indexer up?")
    print(f"# {node.get('title')}  ({node.get('noteType')})")
    print()
    print(node.get("content") or "(empty outline)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--drive", default=os.environ.get("VAULT_DRIVE_SLUG") or os.environ.get("VAULT_DRIVE_ID"))
    p.add_argument("-p", "--profile", default=os.environ.get("SWITCHBOARD_PROFILE"))
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="every scope and its envelopes")
    g = sub.add_parser("get", help="one envelope by id, code, slug, cite, or title substring")
    g.add_argument("query")
    s = sub.add_parser("search", help="nested hits: envelope, deliverable, milestone, roadmap, map, goal, …")
    s.add_argument("query")
    s.add_argument("--kind", help="comma list: " + ",".join(KINDS))
    s.add_argument("--limit", type=int, default=25)
    o = sub.add_parser("outline", help="indexed renderScope() text for a scope document id")
    o.add_argument("scope_id")
    args = p.parse_args()
    args.drive = resolve_drive(args.profile, args.drive)
    if args.cmd == "list":
        cmd_list(args.profile, args.drive)
    elif args.cmd == "get":
        cmd_get(args.profile, args.drive, args.query)
    elif args.cmd == "search":
        cmd_search(args.profile, args.drive, args.query, args.kind, args.limit)
    else:
        cmd_outline(args.profile, args.drive, args.scope_id)


if __name__ == "__main__":
    main()
