#!/usr/bin/env node
/**
 * Add (or update) ONE skill directly in the Knowledge Vault — no repo, no
 * plugin release, no sync. The vault IS the home for skills added this way.
 *
 *   node scripts/add-skill.mjs --endpoint <.../graphql> --drive <uuid-or-slug> \
 *     (--url <raw-skill-md-url> | --file <path>) [--name <skill-name>] [--canonical <url>]
 *
 * Idempotent by title: "Agent skill: <name>" already in the vault -> the
 * same documents are updated in place (history preserved). Otherwise a
 * source + PROCEDURE note + MOC membership are created, closed out, and
 * verified by read-back. There is NO default endpoint — the user chooses
 * the vault.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const arg = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const ENDPOINT = arg("--endpoint"), DRIVE = arg("--drive");
const URLARG = arg("--url"), FILE = arg("--file");
if (!ENDPOINT || !DRIVE || (!URLARG && !FILE)) {
  console.error("usage: node scripts/add-skill.mjs --endpoint <.../graphql> --drive <id> (--url <raw-md-url> | --file <path>) [--name <n>] [--canonical <url>]");
  process.exit(1);
}
const READER = ENDPOINT.replace(/\/graphql\/?$/, "/graphql/r");
const AUTHOR = "skill-add";

async function gql(query, variables, endpoint = READER) {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}
const now = () => new Date().toISOString();
const mutate = (id, actions) => gql(
  "mutation($id: String!, $actions: [JSONObject!]!){ mutateDocument(documentIdentifier: $id, actions: $actions){ documentType } }",
  { id, actions: actions.map((a) => ({ id: randomUUID(), timestampUtcMs: now(), scope: "global", ...a })) });
const addRel = (s, t, r) => gql(
  'mutation($s: String!, $t: String!, $r: String!){ addRelationship(sourceIdentifier: $s, targetIdentifier: $t, relationshipType: $r, branch: "main"){ documentType } }',
  { s, t, r });
async function readState(id) {
  const d = await gql("query($id: String!){ document(identifier: $id){ document { state } } }", { id });
  let st = d.document?.document?.state;
  if (typeof st === "string") st = JSON.parse(st);
  return st?.global ?? st ?? {};
}

// ── load the skill text ────────────────────────────────────────────────
let raw, origin;
if (URLARG) {
  const res = await fetch(URLARG);
  if (!res.ok) throw new Error(`fetch ${URLARG}: HTTP ${res.status}`);
  raw = await res.text();
  origin = URLARG;
} else {
  raw = readFileSync(FILE, "utf8");
  origin = FILE;
}
const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
const meta = {};
if (fm) for (const l of fm[1].split("\n")) { const m = l.match(/^(\w[\w-]*):\s*(.*)$/); if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const body = fm ? raw.slice(fm[0].length) : raw;
const name = arg("--name") || meta.name ||
  (URLARG ? basename(new URL(URLARG).pathname).replace(/\.(md|markdown)$/i, "") : basename(FILE).replace(/\.(md|markdown)$/i, "").replace(/^SKILL$/i, basename(process.cwd())));
const canonical = arg("--canonical") || (URLARG ? URLARG.replace("raw.githubusercontent.com", "github.com").replace(/\/refs\/heads\/([^/]+)\//, "/blob/$1/") : null);
let description = (meta.description || "").trim();
if (!description) {
  const para = body.split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !x.startsWith("#"));
  description = (para ?? "").replace(/\s+/g, " ");
}
const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(0, 14);
const hash = createHash("sha256").update(raw).digest("hex");
console.log(`skill: ${name} (${raw.length} chars, sha256:${hash.slice(0, 12)}…) from ${origin}`);

// ── vault discovery (by title convention) ──────────────────────────────
const driveDoc = await gql("query($id: String!){ document(identifier: $id){ document { id state } } }", { id: DRIVE });
const driveId = driveDoc.document.document.id;
let dst = driveDoc.document.document.state;
if (typeof dst === "string") dst = JSON.parse(dst);
const nodes = (dst.global ?? dst).nodes ?? [];
const knowledgeId = nodes.find((n) => n.kind === "folder" && n.name === "knowledge" && !n.parentFolder)?.id;
const sourcesFolder = nodes.find((n) => n.kind === "folder" && n.name === "sources" && !n.parentFolder)?.id;
const notesFolder = nodes.find((n) => n.kind === "folder" && n.name === "notes" && n.parentFolder === knowledgeId)?.id;
let srcId = null, noteId = null, mocId = null, priorHash = null;
for (const n of nodes) {
  if (n.documentType === "bai/source" && !srcId) {
    const st = await readState(n.id);
    if ((st.title ?? "") === `Agent skill: ${name}`) { srcId = n.id; priorHash = (st.provenance?.method ?? "").replace(/^sha256:/, ""); }
  } else if (n.documentType === "bai/knowledge-note" && !noteId) {
    const st = await readState(n.id);
    if ((st.title ?? "").startsWith(`Agent skill: /${name}`)) noteId = n.id;
  } else if (n.documentType === "bai/moc" && !mocId) {
    const st = await readState(n.id);
    if ((st.title ?? "") === "Agent Skills") mocId = n.id;
  }
}
const FORCE = args.includes("--force");
if (priorHash === hash && !FORCE) { console.log("unchanged — vault already has this exact content (--force regenerates the note anyway)"); process.exit(0); }

async function createDoc(ns, docName) {
  const d = await gql(`mutation($name: String!, $p: String) { ${ns} { createDocument(name: $name, parentIdentifier: $p) { id } } }`, { name: docName, p: driveId }, ENDPOINT);
  return d[ns].createDocument.id;
}
const moveNode = (id, folder) => gql(
  "mutation($docId: PHID!, $input: DocumentDrive_MoveNodeInput!){ DocumentDrive { moveNode(docId: $docId, input: $input) { id } } }",
  { docId: driveId, input: { srcFolder: id, targetParentFolder: folder } }, ENDPOINT);

// ── source ──────────────────────────────────────────────────────────────
const isNewSrc = !srcId;
if (isNewSrc) { srcId = await createDoc("Source", `skill-${name}`); await moveNode(srcId, sourcesFolder); }
await mutate(srcId, [{ type: "INGEST_SOURCE", input: {
  title: `Agent skill: ${name}`, content: raw, sourceType: "DOCUMENTATION",
  description: description.slice(0, 200),
  ...(canonical ? { url: canonical } : {}),
  method: `sha256:${hash}`, tool: "add-skill", createdAt: now(), createdBy: AUTHOR } }]);

// ── note ────────────────────────────────────────────────────────────────
const isNewNote = !noteId;
if (isNewNote) { noteId = await createDoc("KnowledgeNote", `skill-${name}`); await moveNode(noteId, notesFolder); }
const firstSentence = description.split(/(?<=\.)\s/)[0] ?? description;
const content = [
  "## When to use", description, "",
  "## What it covers",
  headings.length ? headings.map((h) => `- ${h}`).join("\n") : "- (single-section skill)", "",
  "## Where the full skill lives",
  `- Vault source: **Agent skill: ${name}** (full text, DERIVED_FROM below) — the vault is this skill's home.`,
  ...(canonical ? [`- Upstream origin: ${canonical}`] : []), "",
  "## Invocation",
  "Read the vault source content and follow it. Not a plugin command.", "",
  `_Added via add-skill; content hash sha256:${hash.slice(0, 12)}…_`,
].join("\n");
await mutate(noteId, [
  { type: "SET_TITLE", input: { title: `Agent skill: /${name} — ${firstSentence.slice(0, 140)}`, updatedAt: now() } },
  { type: "SET_DESCRIPTION", input: { description: description.slice(0, 200), updatedAt: now() } },
  { type: "SET_NOTE_TYPE", input: { noteType: "PROCEDURE", updatedAt: now() } },
  { type: "SET_CONTENT", input: { content, updatedAt: now() } },
  ...(isNewNote ? [
    { type: "ADD_TOPIC", input: { id: randomUUID(), name: "agent-skills" } },
    { type: "ADD_TOPIC", input: { id: randomUUID(), name } },
  ] : []),
]);
if (isNewNote) {
  await mutate(noteId, [{ type: "SET_PROVENANCE", input: { author: AUTHOR, sourceOrigin: "IMPORT", createdAt: now() } }]);
  await mutate(noteId, [{ type: "SUBMIT_FOR_REVIEW", input: { id: randomUUID(), actor: AUTHOR, timestamp: now(), comment: "skill added to vault" } }]);
  await mutate(noteId, [{ type: "APPROVE_NOTE", input: { id: randomUUID(), actor: "knowledge-agent", timestamp: now(), comment: "vault-native skill" } }]);
}
await addRel(noteId, srcId, "DERIVED_FROM");
if (mocId) await addRel(mocId, noteId, "CORE_IDEA");
await mutate(srcId, [{ type: "ADD_EXTRACTED_CLAIM", input: { claimRef: noteId } }]);
await mutate(srcId, [{ type: "RECORD_EXTRACTION_STATS", input: { claimCount: 1, skippedCount: 0, skipRate: 0, extractedAt: now(), extractedBy: AUTHOR } }]);
await mutate(srcId, [{ type: "SET_SOURCE_STATUS", input: { status: "EXTRACTED" } }]);

// ── verify ──────────────────────────────────────────────────────────────
const sSt = await readState(srcId), nSt = await readState(noteId);
const ok = sSt.status === "EXTRACTED" && (sSt.provenance?.method ?? "").endsWith(hash) && (nSt.title ?? "").startsWith(`Agent skill: /${name}`);
console.log(ok
  ? `${isNewSrc ? "added" : "updated"}: source=${srcId} note=${noteId} (verified)`
  : `VERIFY FAILED: source=${sSt.status}/${sSt.provenance?.method} note=${nSt.title}`);
if (!ok) process.exit(1);
