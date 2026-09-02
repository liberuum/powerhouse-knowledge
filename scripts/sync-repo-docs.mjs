#!/usr/bin/env node
/**
 * Sync a git repository's markdown docs into a Knowledge Vault as bai/source
 * documents — one source per file, pinned to a git tag.
 *
 * What one run does, per manifest entry:
 *   1. finds the existing source (manifest `existingId`, else a source whose
 *      provenance.url ends in the same repo path, else an exact title match)
 *      or creates one in /sources
 *   2. ingests the file text at --tag (INGEST_SOURCE). If --base-tag is given
 *      and the file differs between the two tags, the base text is ingested
 *      FIRST, so the source's own operation history shows the upstream diff.
 *      A source whose provenance.method already carries the --tag hash is
 *      left alone (idempotent re-runs).
 *   3. optionally attributes existing notes (--attribution): a DERIVED_FROM
 *      edge note -> source with the reason given in the attribution file,
 *      ADD_EXTRACTED_CLAIM on the source (guarded — the deployed model may
 *      not dedupe), `filePath` metadata on the note
 *   4. sets status EXTRACTED when the source has claims, otherwise leaves the
 *      INBOX the ingest reducer resets it to (visible backlog)
 *   5. optionally stamps `version` metadata (--bump-version) on notes whose
 *      backing file is UNCHANGED between --base-tag and --tag — the claim is
 *      known to hold at the new version because the text it rests on did not
 *      move. Notes on changed files are NOT bumped here: they need a reading.
 *
 * Provenance written on every source: url = <repo-url>/blob/<tag>/<path>,
 * publishedAt = the file's last upstream commit at that tag, method =
 * "sha256:<hash> git:<tag>", tool = "sync-repo-docs", author = --author.
 *
 * There is NO default endpoint (the user chooses the vault). Writes go
 * through the switchboard CLI and are signed by the profile's identity.
 *
 *   node scripts/sync-repo-docs.mjs --endpoint <.../graphql> --drive <id|slug>
 *     --profile <cli profile> --repo <git checkout> --repo-url <https://github.com/org/repo>
 *     --tag <tag> [--base-tag <tag>] --manifest <manifest.json>
 *     [--attribution <attribution.json>] [--bump-version <string>]
 *     [--author "<name>"] [--only <path substring>] [--workers 4] [--dry-run]
 *     [--out <run-log.json>]
 *
 * manifest.json: [{ path, title, summary, existingId?, changed, new,
 *                   published74?: ISO, published47?: ISO, notes: [noteId] }]
 *   (publishedHead / publishedBase are also accepted as the date keys)
 * attribution.json: { attribution: { [noteId]: [{ path, confidence, method }] } }
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }
const ENDPOINT = arg("--endpoint"), DRIVE = arg("--drive"), PROFILE = arg("--profile");
const REPO = arg("--repo"), REPO_URL = (arg("--repo-url") ?? "").replace(/\/$/, "");
const TAG = arg("--tag"), BASE = arg("--base-tag");
const MANIFEST = arg("--manifest"), ATTRIBUTION = arg("--attribution");
const BUMP = arg("--bump-version");
const AUTHOR = arg("--author") ?? "repo-docs-sync";
const ONLY = arg("--only");
const WORKERS = Number(arg("--workers") ?? 4);
const OUT = arg("--out") ?? `sync-repo-docs-${TAG}.json`;
const DRY = args.includes("--dry-run");
if (!ENDPOINT || !DRIVE || !PROFILE || !REPO || !REPO_URL || !TAG || !MANIFEST) {
  console.error("usage: see header comment. Required: --endpoint --drive --profile --repo --repo-url --tag --manifest");
  process.exit(1);
}
const READER = ENDPOINT.replace(/\/graphql\/?$/, "/graphql/r");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")).filter((e) => !ONLY || e.path.includes(ONLY));
const attribution = ATTRIBUTION ? JSON.parse(readFileSync(ATTRIBUTION, "utf8")).attribution : {};
const now = () => new Date().toISOString();
// DateTime inputs must be UTC 'Z' strings — an offset form (+02:00) is accepted by the job and silently dropped by the reducer.
const utc = (iso) => (iso ? new Date(iso).toISOString() : null);
const sha = (t) => createHash("sha256").update(t).digest("hex");

// ── git ─────────────────────────────────────────────────────────────────
function show(tag, path) {
  try { return execFileSync("git", ["-C", REPO, "show", `${tag}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}
function commitDate(tag, path) {
  const d = execFileSync("git", ["-C", REPO, "log", "-1", "--format=%cI", tag, "--", path], { encoding: "utf8" }).trim();
  return d ? utc(d) : null;
}

// ── switchboard CLI (signed writes) ─────────────────────────────────────
const CLI_ENV = { ...process.env, SWITCHBOARD_APP_NAME: process.env.SWITCHBOARD_APP_NAME ?? "powerhouse-knowledge" };
function cli(cliArgs) {
  const out = execFileSync("switchboard", ["-p", PROFILE, ...cliArgs, "--format", "json"], {
    env: CLI_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  try { return JSON.parse(out); } catch { return out; }
}
if (!DRY) {
  const st = cli(["auth", "status"]);
  if (!st?.signing) throw new Error(`profile '${PROFILE}' has no signing identity — run: switchboard -p ${PROFILE} auth login --renown`);
  console.log(`signing for ${st.address} via ${CLI_ENV.SWITCHBOARD_APP_NAME}`);
}
function envelope(action) { return { id: randomUUID(), timestampUtcMs: now(), scope: "global", ...action }; }
function mutate(docId, actions, { verbatim = false } = {}) {
  if (DRY) return;
  const file = join(tmpdir(), `sync-repo-docs-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(actions.map(envelope)));
  try { cli(["docs", "apply", docId, "--file", file, "--wait", ...(verbatim ? ["--allow-literal-escapes"] : [])]); }
  finally { unlinkSync(file); }
}
function createSource(name, folder) {
  if (DRY) return `dry-${randomUUID()}`;
  const r = cli(["docs", "create", "--type", "bai/source", "--name", name, "--drive", driveId, "--parent-folder", folder]);
  const id = r?.id ?? r?.documentId;
  if (!id) throw new Error(`docs create returned no id for ${name}: ${JSON.stringify(r).slice(0, 200)}`);
  return id;
}
function link(source, target, type, reason, confidence) {
  if (DRY) return;
  cli(["docs", "link", source, target, "-t", type, "--reason", reason, "--confidence", confidence]);
}

// ── reads (GraphQL reader) ──────────────────────────────────────────────
async function gql(query, variables) {
  const res = await fetch(READER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}
async function readState(id) {
  const d = await gql("query($id: String!){ document(identifier: $id){ document { state } } }", { id });
  let st = d.document?.document?.state;
  if (typeof st === "string") st = JSON.parse(st);
  return st?.global ?? st ?? {};
}
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ── vault discovery ─────────────────────────────────────────────────────
const driveId = (await gql("query($id: String!){ document(identifier: $id){ document { id } } }", { id: DRIVE })).document.document.id;
const tree = await readState(driveId);
const nodes = tree.nodes ?? [];
const sourcesFolder = nodes.find((n) => n.kind === "folder" && n.name === "sources" && !n.parentFolder)?.id;
if (!sourcesFolder) throw new Error("vault folder layout not found (/sources)");
const srcNodes = nodes.filter((n) => n.documentType === "bai/source");
console.log(`drive ${driveId}: ${srcNodes.length} existing sources, ${manifest.length} manifest entries`);
const existing = new Map(); // id -> state
await pmap(srcNodes, 8, async (n) => existing.set(n.id, await readState(n.id)));
const byPath = new Map(), byTitle = new Map();
for (const [id, st] of existing) {
  const url = st.provenance?.url ?? "";
  const m = url.match(/\/blob\/[^/]+\/(.+)$/);
  if (m && url.startsWith(REPO_URL)) byPath.set(m[1], id);
  if (st.title) byTitle.set(st.title, id);
}
const hashOf = (st) => (st?.provenance?.method ?? "").match(/sha256:([0-9a-f]{64})/)?.[1] ?? null;

// ── per-doc sync ────────────────────────────────────────────────────────
const log = []; let created = 0, ingested = 0, current = 0, claimsAdded = 0, edges = 0, bumped = 0;
const noteFilePathDone = new Set();
function ingestInput(e, tag, text, publishedAt, note) {
  const status = e.new ? `new in ${TAG}` : e.changed ? `revised between ${BASE} and ${TAG}` : BASE ? `unchanged since ${BASE}` : null;
  const desc = `Powerhouse ${tag}${status && tag === TAG ? ` (${status})` : ""} — ${e.summary}`;
  return {
    type: "INGEST_SOURCE",
    input: {
      title: e.title,
      content: text,
      sourceType: "DOCUMENTATION",
      description: desc.length > 200 ? desc.slice(0, 199).trimEnd() + "…" : desc,
      url: `${REPO_URL}/blob/${tag}/${e.path}`,
      author: arg("--doc-author") ?? "Powerhouse Inc.",
      publishedAt,
      method: `sha256:${sha(text)} git:${tag}${note ? ` ${note}` : ""}`,
      tool: "sync-repo-docs",
      createdAt: now(),
      createdBy: AUTHOR,
    },
  };
}
async function syncDoc(e) {
  const head = show(TAG, e.path);
  if (head == null) { log.push({ path: e.path, error: `not in ${TAG}` }); return; }
  const base = BASE ? show(BASE, e.path) : null;
  const changed = base != null && base !== head;
  e.changed = changed; e.new = base == null && !!BASE;
  const headSha = sha(head), baseSha = base != null ? sha(base) : null;

  let id = e.existingId ?? byPath.get(e.path) ?? byTitle.get(e.title) ?? null;
  const prior = id ? existing.get(id) : null;
  const rec = { path: e.path, title: e.title, sourceId: id, created: false, revisions: [], claims: 0, edges: 0, status: null, changed, new: e.new };
  if (!id) { id = createSource(e.title, sourcesFolder); rec.sourceId = id; rec.created = true; created++; }

  const priorSha = hashOf(prior);
  if (priorSha === headSha) { current++; rec.revisions.push("current"); }
  else {
    if (changed && priorSha !== baseSha) {
      mutate(id, [ingestInput(e, BASE, base, utc(e.publishedBase ?? e.published47) ?? commitDate(BASE, e.path), `(baseline recorded ${now().slice(0, 10)})`)], { verbatim: true });
      rec.revisions.push(BASE);
    }
    mutate(id, [ingestInput(e, TAG, head, utc(e.publishedHead ?? e.published74) ?? commitDate(TAG, e.path))], { verbatim: true });
    rec.revisions.push(TAG); ingested++;
  }

  // attribution: edges + claims + note metadata
  const noteIds = e.notes ?? [];
  if (noteIds.length && !DRY) {
    const st = await readState(id);
    const have = new Set(st.extractedClaims ?? []);
    for (const noteId of noteIds) {
      const a = (attribution[noteId] ?? []).find((x) => x.path === e.path);
      const reason = a ? reasonFor(a, e) : `Backing page for this claim (${e.path}); attributed during the ${TAG} source sync`;
      link(noteId, id, "DERIVED_FROM", reason, a?.confidence ?? "established"); edges++; rec.edges++;
      if (!have.has(noteId)) { mutate(id, [{ type: "ADD_EXTRACTED_CLAIM", input: { claimRef: noteId } }]); have.add(noteId); claimsAdded++; }
      const meta = [];
      if (!noteFilePathDone.has(noteId)) { meta.push({ type: "SET_METADATA_FIELD", input: { field: "filePath", value: e.path, updatedAt: now() } }); noteFilePathDone.add(noteId); }
      if (BUMP && !changed && !e.new && allDocsUnchanged(noteId)) { meta.push({ type: "SET_METADATA_FIELD", input: { field: "version", value: BUMP, updatedAt: now() } }); bumped++; }
      if (meta.length) mutate(noteId, meta);
    }
    rec.claims = have.size;
  } else if (noteIds.length) { rec.edges = noteIds.length; rec.claims = noteIds.length; }

  // status: ingest resets to INBOX; a source with claims is EXTRACTED
  if (!DRY) {
    const st = await readState(id);
    const wantExtracted = (st.extractedClaims ?? []).length > 0;
    if (wantExtracted && st.status !== "EXTRACTED") mutate(id, [{ type: "SET_SOURCE_STATUS", input: { status: "EXTRACTED" } }]);
    const back = await readState(id);
    rec.status = back.status;
    const ok = hashOf(back) === headSha && (!wantExtracted || back.status === "EXTRACTED") && noteIds.every((n) => (back.extractedClaims ?? []).includes(n));
    if (!ok) { rec.verifyFailed = true; console.error(`VERIFY FAILED ${e.path}: status=${back.status} method=${back.provenance?.method}`); process.exitCode = 1; }
  }
  log.push(rec);
  console.log(`${rec.created ? "create" : "update"} ${rec.revisions.join("+")} ${changed ? "[changed]" : e.new ? "[new]" : ""} ${e.path} ← ${noteIds.length} notes`);
}
const changedPaths = new Set(manifest.filter((e) => e.changed || e.new).map((e) => e.path));
function allDocsUnchanged(noteId) {
  const paths = (attribution[noteId] ?? []).map((a) => a.path);
  return paths.length === 0 || paths.every((p) => !changedPaths.has(p));
}
function reasonFor(a, e) {
  const state = e.new ? `new in ${TAG}` : e.changed ? `revised between ${BASE} and ${TAG} — re-verified in the ${TAG} pass` : `identical at ${BASE} and ${TAG}`;
  if (a.method.startsWith("path named")) return `The note names ${e.path} as its source; page text ${state}`;
  const ids = a.method.match(/identifiers \[(.*?)\]/)?.[1]?.replace(/'/g, "");
  if (ids) return `Backing page found by content match in the ${TAG} source backfill — identifiers ${ids} from the claim appear in this page (text ${state}); attribution, not the original extraction record`;
  return `Backing page found by content match (${a.method.replace("content match ", "score ")}) in the ${TAG} source backfill; no distinctive identifier verified, attribution by topic overlap — not the original extraction record (text ${state})`;
}

await pmap(manifest, WORKERS, syncDoc);
writeFileSync(OUT, JSON.stringify({ tag: TAG, baseTag: BASE, driveId, at: now(), docs: log }, null, 1));
console.log(`\nsync done${DRY ? " [dry-run]" : ""}: ${created} sources created, ${ingested} ingested, ${current} already current, ${edges} DERIVED_FROM edges, ${claimsAdded} claims added, ${bumped} version bumps → ${OUT}`);
