#!/usr/bin/env node
/**
 * Sync agent skills into a Knowledge Vault — INCREMENTAL by content hash.
 *
 * Git is canonical (the execution copy); the vault is the discovery layer.
 * Each skill becomes:
 *   - a bai/source  "Agent skill: <name>" holding the full SKILL.md
 *     (sha256 of the file stored in the source's `method` field)
 *   - a bai/knowledge-note (PROCEDURE) distilling when-to-use, for
 *     semantic discovery; DERIVED_FROM the source; topic `agent-skills`
 *   - membership in the "Agent Skills" MOC (CORE_IDEA)
 *
 * Re-runs are no-ops for unchanged files: hash matches -> skip. Changed
 * files re-ingest the source and rewrite the note IN PLACE (same document
 * ids — history preserved in the operation log). New files create.
 * Nothing is ever deleted; retire a skill by archiving its note manually.
 *
 * There is NO default endpoint (the user chooses the vault):
 *   node scripts/sync-skills.mjs --endpoint <.../graphql> --drive <uuid-or-slug> \
 *     [--skills-dir <dir>]... [--dry-run]
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(flag, multi = false) {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === flag) out.push(args[++i]);
  return multi ? out : out[0] ?? null;
}
const ENDPOINT = arg("--endpoint");
const DRIVE = arg("--drive");
const DRY = args.includes("--dry-run");
const APPROVER = arg("--approver") ?? "knowledge-agent";
const skillDirs = arg("--skills-dir", true);
if (!ENDPOINT || !DRIVE) {
  console.error(
    "usage: node scripts/sync-skills.mjs --endpoint <switchboard /graphql URL> --drive <uuid-or-slug> [--skills-dir <dir>]... [--dry-run]\n" +
      "No default endpoint: ask the user which vault to sync into.",
  );
  process.exit(1);
}
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDirs = [join(pluginRoot, "skills")];
if (existsSync(join(pluginRoot, "external-skills")))
  defaultDirs.push(join(pluginRoot, "external-skills"));
const dirs = skillDirs.length ? skillDirs : defaultDirs;
const READER = ENDPOINT.replace(/\/graphql\/?$/, "/graphql/r");
const AUTHOR = "skill-sync";

// ── tiny gql client (keep-alive via global fetch; volume is small) ─────
async function gql(query, variables, endpoint = READER) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}
const now = () => new Date().toISOString(); // always Z-suffixed
function envelope(action) {
  return { id: randomUUID(), timestampUtcMs: now(), scope: "global", ...action };
}
async function mutate(docId, actions) {
  if (DRY) return;
  await gql(
    "mutation($id: String!, $actions: [JSONObject!]!){ mutateDocument(documentIdentifier: $id, actions: $actions){ documentType } }",
    { id: docId, actions: actions.map(envelope) },
  );
}
async function createDoc(ns, name) {
  const d = await gql(
    `mutation($name: String!, $p: String) { ${ns} { createDocument(name: $name, parentIdentifier: $p) { id } } }`,
    { name, p: driveId },
    ENDPOINT,
  );
  return d[ns].createDocument.id;
}
async function moveNode(id, folder) {
  // `srcFolder` is the reactor's name for the moved node, folder OR file.
  await gql(
    "mutation($docId: PHID!, $input: DocumentDrive_MoveNodeInput!){ DocumentDrive { moveNode(docId: $docId, input: $input) { id } } }",
    { docId: driveId, input: { srcFolder: id, targetParentFolder: folder } },
    ENDPOINT,
  );
}
async function addRel(source, target, type) {
  if (DRY) return;
  await gql(
    "mutation($s: String!, $t: String!, $r: String!){ addRelationship(sourceIdentifier: $s, targetIdentifier: $t, relationshipType: $r, branch: \"main\"){ documentType } }",
    { s: source, t: target, r: type },
  );
}
async function readState(id) {
  const d = await gql(
    "query($id: String!){ document(identifier: $id){ document { state } } }",
    { id },
  );
  let st = d.document?.document?.state;
  if (typeof st === "string") st = JSON.parse(st);
  return st?.global ?? st ?? {};
}

// ── read skills from disk ───────────────────────────────────────────────
function parseSkill(file, sourceDir) {
  const raw = readFileSync(file, "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (fm)
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  const body = fm ? raw.slice(fm[0].length) : raw;
  const name = meta.name || basename(dirname(file));
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(0, 14);
  // Frontmatter-less skills (external repos): first prose paragraph
  // stands in for the description.
  let description = (meta.description || "").trim();
  if (!description) {
    const para = body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .find((x) => x && !x.startsWith("#"));
    description = (para ?? "").replace(/\s+/g, " ");
  }
  // External skills carry a CANONICAL sidecar: first line = URL of the
  // true source of truth (another repo). The vendored copy here is a
  // pinned mirror used for hashing; refresh = re-fetch + re-run sync.
  const canonicalFile = join(dirname(file), "CANONICAL");
  const canonicalUrl = existsSync(canonicalFile)
    ? readFileSync(canonicalFile, "utf8").trim().split("\n")[0]
    : null;
  const rel = file.startsWith(pluginRoot + "/")
    ? file.slice(pluginRoot.length + 1)
    : `skills/${basename(dirname(file))}/SKILL.md`;
  return {
    name,
    description,
    raw,
    headings,
    hash: createHash("sha256").update(raw).digest("hex"),
    repoPath: rel,
    canonicalUrl,
    sourceDir,
  };
}
const skills = [];
for (const dir of dirs) {
  if (!existsSync(dir)) { console.error(`skip missing dir ${dir}`); continue; }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(f)) skills.push(parseSkill(f, dir));
  }
}
console.log(`found ${skills.length} skills in ${dirs.length} dir(s)`);

// ── vault discovery ─────────────────────────────────────────────────────
let driveId = DRIVE;
{
  const d = await gql("query($id: String!){ document(identifier: $id){ document { id } } }", { id: DRIVE });
  driveId = d.document.document.id;
}
const treeState = await readState(driveId);
const nodes = treeState.nodes ?? [];
const folders = Object.fromEntries(
  nodes.filter((n) => n.kind === "folder").map((n) => [n.name + "|" + (n.parentFolder ?? ""), n.id]),
);
const knowledgeId = nodes.find((n) => n.kind === "folder" && n.name === "knowledge" && !n.parentFolder)?.id;
const sourcesFolder = nodes.find((n) => n.kind === "folder" && n.name === "sources" && !n.parentFolder)?.id;
const notesFolder = nodes.find((n) => n.kind === "folder" && n.name === "notes" && n.parentFolder === knowledgeId)?.id;
if (!sourcesFolder || !notesFolder) throw new Error("vault folder layout not found (sources/, knowledge/notes/)");

// existing skill sources & notes, by title convention
const srcDocs = nodes.filter((n) => n.documentType === "bai/source");
const noteDocs = nodes.filter((n) => n.documentType === "bai/knowledge-note");
const mocDocs = nodes.filter((n) => n.documentType === "bai/moc");
const existingSources = {}; // name -> {id, hash, owned, status}
const duplicateSources = []; // same-name extras we refuse to touch
for (const s of srcDocs) {
  const st = await readState(s.id);
  const m = (st.title ?? "").match(/^Agent skill: (\S+)/);
  if (!m) continue;
  const entry = {
    id: s.id,
    hash: (st.provenance?.method ?? "").replace(/^sha256:/, ""),
    owned: st.createdBy === AUTHOR || st.provenance?.tool === "sync-skills",
    status: st.status ?? "INBOX",
  };
  const prior = existingSources[m[1]];
  if (!prior) existingSources[m[1]] = entry;
  // Two sources claim the same skill name: prefer the sync-owned one and
  // refuse to write through the other — updating a hand-made document
  // that happens to share a title would destroy someone's draft.
  else if (!prior.owned && entry.owned) {
    duplicateSources.push({ name: m[1], id: prior.id });
    existingSources[m[1]] = entry;
  } else duplicateSources.push({ name: m[1], id: entry.id });
}
for (const d of duplicateSources)
  console.warn(
    `⚠ duplicate source for '${d.name}' (${d.id}) — not managed by this sync; resolve manually`,
  );
const existingNotes = {}; // name -> id
for (const n of noteDocs) {
  const st = await readState(n.id);
  const m = (st.title ?? "").match(/^Agent skill: \/(\S+)/);
  if (m) existingNotes[m[1]] = n.id;
}
let mocId = null;
let ecosystemMocId = null;
for (const m of mocDocs) {
  const st = await readState(m.id);
  const t = st.title ?? "";
  if (t === "Agent Skills") mocId = m.id;
  if (t === "Powerhouse Ecosystem") ecosystemMocId = m.id;
  if (mocId && ecosystemMocId) break;
}

// ── MOC ─────────────────────────────────────────────────────────────────
if (!mocId && !DRY) {
  mocId = await createDoc("Moc", "agent-skills");
  await moveNode(mocId, knowledgeId);
  await mutate(mocId, [{
    type: "CREATE_MOC",
    input: {
      title: "Agent Skills",
      description: "Operating procedures for agents working on the Knowledge Vault and Powerhouse stack — synced from the powerhouse-knowledge plugin's skills. Git is canonical; these notes are the discovery layer.",
      orientation: "Each note here distills one agent skill: when to reach for it and what it covers. The full, executable SKILL.md text lives in the paired 'Agent skill:' source document; the canonical copy is the plugin repo. Find skills by asking for what you need — semantic search over these notes is the index.",
      tier: "TOPIC",
      createdAt: now(),
    },
  }]);
  console.log(`created Agent Skills MOC ${mocId}`);
} else console.log(`Agent Skills MOC: ${mocId ?? "(dry-run)"} `);
// Hang the skills map under the ecosystem hub so top-down MOC browsing
// finds it (semantic/topic discovery work without this). Best-effort:
// vaults without a "Powerhouse Ecosystem" MOC simply skip it. The edge
// is idempotent on (source, target, type).
if (mocId && ecosystemMocId && !DRY) {
  await addRel(ecosystemMocId, mocId, "CHILD_MOC");
  console.log("Agent Skills hung under Powerhouse Ecosystem (CHILD_MOC)");
}

// ── per-skill sync ──────────────────────────────────────────────────────
let created = 0, updated = 0, skipped = 0;
for (const sk of skills) {
  const prior = existingSources[sk.name];
  if (prior && prior.hash === sk.hash) { skipped++; continue; }
  const verb = prior ? "update" : "create";
  console.log(`${verb}: ${sk.name}`);
  if (DRY) { if (prior) updated++; else created++; continue; }

  // source
  let srcId = prior?.id;
  if (!srcId) { srcId = await createDoc("Source", `skill-${sk.name}`); await moveNode(srcId, sourcesFolder); }
  await mutate(srcId, [{
    type: "INGEST_SOURCE",
    input: {
      title: `Agent skill: ${sk.name}`,
      content: sk.raw,
      sourceType: "DOCUMENTATION",
      description: sk.description.slice(0, 200),
      url: sk.canonicalUrl ?? `https://github.com/liberuum/powerhouse-knowledge/blob/main/${sk.repoPath}`,
      author: "powerhouse-knowledge plugin",
      method: `sha256:${sk.hash}`,
      tool: "sync-skills",
      createdAt: now(),
      createdBy: AUTHOR,
    },
  }]);

  // note
  let noteId = existingNotes[sk.name];
  const isNew = !noteId;
  if (isNew) { noteId = await createDoc("KnowledgeNote", `skill-${sk.name}`); await moveNode(noteId, notesFolder); }
  const firstSentence = sk.description.split(/(?<=\.)\s/)[0] ?? sk.description;
  const content = [
    `## When to use`,
    sk.description,
    ``,
    `## What it covers`,
    sk.headings.length ? sk.headings.map((h) => `- ${h}`).join("\n") : "- (single-section skill)",
    ``,
    `## Where the full skill lives`,
    `- Vault source: **Agent skill: ${sk.name}** (full SKILL.md text, DERIVED_FROM below)`,
    sk.canonicalUrl
      ? `- Canonical copy: ${sk.canonicalUrl} (external repo; mirrored in this plugin at \`${sk.repoPath}\`) — always execute from the canonical copy; this note is the discovery layer.`
      : `- Canonical copy: plugin repo \`${sk.repoPath}\` — always execute from the repo copy; this note is the discovery layer.`,
    ``,
    `## Invocation`,
    sk.canonicalUrl
      ? `External skill — not a plugin command. Install per its repo (typically as a Claude skill, e.g. \`.claude/skills/${sk.name}/\`), or read the source content and follow it manually.`
      : `\`/powerhouse-knowledge:${sk.name}\` in Claude Code (plugin installed), or read the source content and follow it manually.`,
    ``,
    `_Synced by sync-skills; source hash sha256:${sk.hash.slice(0, 12)}…_`,
  ].join("\n");
  await mutate(noteId, [
    { type: "SET_TITLE", input: { title: `Agent skill: /${sk.name} — ${firstSentence.slice(0, 140)}`, updatedAt: now() } },
    { type: "SET_DESCRIPTION", input: { description: sk.description.slice(0, 200), updatedAt: now() } },
    { type: "SET_NOTE_TYPE", input: { noteType: "PROCEDURE", updatedAt: now() } },
    { type: "SET_CONTENT", input: { content, updatedAt: now() } },
    ...(isNew ? [
      { type: "ADD_TOPIC", input: { id: randomUUID(), name: "agent-skills" } },
      { type: "ADD_TOPIC", input: { id: randomUUID(), name: sk.name } },
    ] : []),
    { type: "SET_METADATA_FIELD", input: { field: "filePath", value: sk.repoPath, updatedAt: now() } },
  ]);
  if (isNew) {
    await mutate(noteId, [{ type: "SET_PROVENANCE", input: { author: AUTHOR, sourceOrigin: "IMPORT", createdAt: now() } }]);
    await mutate(noteId, [{ type: "SUBMIT_FOR_REVIEW", input: { id: randomUUID(), actor: AUTHOR, timestamp: now(), comment: "skill sync" } }]);
    await mutate(noteId, [{ type: "APPROVE_NOTE", input: { id: randomUUID(), actor: APPROVER, timestamp: now(), comment: "mechanical sync from canonical repo copy" } }]);
  }

  // edges + source close-out (mandatory)
  await addRel(noteId, srcId, "DERIVED_FROM");
  if (mocId) await addRel(mocId, noteId, "CORE_IDEA");
  await mutate(srcId, [{ type: "ADD_EXTRACTED_CLAIM", input: { claimRef: noteId } }]);
  await mutate(srcId, [{ type: "RECORD_EXTRACTION_STATS", input: { claimCount: 1, skippedCount: 0, skipRate: 0, extractedAt: now(), extractedBy: AUTHOR } }]);
  await mutate(srcId, [{ type: "SET_SOURCE_STATUS", input: { status: "EXTRACTED" } }]);

  // verify by read-back
  const sSt = await readState(srcId);
  const nSt = await readState(noteId);
  const ok = sSt.status === "EXTRACTED" && (sSt.provenance?.method ?? "").endsWith(sk.hash) && (nSt.title ?? "").startsWith(`Agent skill: /${sk.name}`);
  if (!ok) { console.error(`VERIFY FAILED for ${sk.name}: source=${sSt.status}/${sSt.method}, note=${nSt.title}`); process.exitCode = 1; }
  if (prior) updated++; else created++;
}
// Vault-native skills: present in the vault, not bundled with the plugin.
// That is a fully supported home — added via scripts/add-skill.mjs or any
// agent, updated in place by re-adding. The sync never touches them; it
// only manages the plugin's own bundled skills. Listed for visibility.
const repoNames = new Set(skills.map((k) => k.name));
const vaultNative = Object.entries(existingSources).filter(
  ([name, e]) => !repoNames.has(name) && e.status !== "ARCHIVED",
);
if (vaultNative.length)
  console.log(
    `vault-native skills (managed in the vault, not by this sync): ${vaultNative
      .map(([n]) => n)
      .join(", ")}`,
  );
console.log(`\nsync done: ${created} created, ${updated} updated, ${skipped} skipped (unchanged)${DRY ? " [dry-run]" : ""}`);
