/**
 * Vault client — every vault interaction in the harness goes through this
 * module.
 *
 * Golden rule (CONFIGURATION.md): read however you like — write ONLY through
 * the switchboard CLI. There is exactly one write path here,
 * `applyWithVerify`: lint → signed apply → read-back + operation-log
 * rejection check → fail loud. No raw GraphQL writes anywhere.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, nowIso } from "./state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

/** Labels every write the harness makes (the repo's existing convention). */
const APP_NAME = "powerhouse-knowledge";

/** The pre-dispatch linter that ships in this repo; its ENUMS map is the
 *  authoritative status/field vocabulary. */
const LINT = join(repoRoot, "scripts", "lint-actions.mjs");

export class VaultError extends Error {}

/** The reactor rejected action(s) from our batch — carries its error text. */
export class RejectedActionsError extends Error {
  constructor(docId, rejections) {
    const lines = rejections.map((r) => `  ${r.type} — ${summarizeError(r.error)}`);
    super(
      `vault rejected ${rejections.length} of ${rejections.length} action(s) on ${docId.slice(0, 8)}:\n${lines.join("\n")}`,
    );
    this.name = "RejectedActionsError";
    this.docId = docId;
    this.rejections = rejections;
  }
}

/** Run the switchboard CLI (argv array, no shell). Throws on non-zero exit. */
function sb(args, { env, timeoutMs = 120_000 } = {}) {
  try {
    return execFileSync("switchboard", args, {
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
      timeout: timeoutMs,
    });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`.trim();
    throw new VaultError(`switchboard ${args.slice(0, 3).join(" ")}… failed (${e.status}): ${out.slice(-2000)}`);
  }
}

function sbJson(args, opts = {}) {
  let out = sb([...args, "--format", "json"], opts);
  try {
    return JSON.parse(out);
  } catch {
    throw new VaultError(`switchboard returned non-JSON output: ${out.slice(0, 300)}`);
  }
}

/** `switchboard --version` → [major, minor, patch]. */
export function cliVersion() {
  const out = sb(["--version"]).trim();
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new VaultError(`cannot parse switchboard version: ${out}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isCliVersionAtLeast(v, [maj, min, pat]) {
  return v[0] > maj || (v[0] === maj && v[1] > min) || (v[0] === maj && v[1] === min && v[2] >= pat);
}

/**
 * Signing identity required before any write. Fails with the exact fix
 * command when the profile is not signed.
 */
export function assertIdentity() {
  const st = sbJson(["auth", "status"]);
  if (!st.signing) {
    throw new VaultError(
      `profile "${st.profile}" has signing OFF — vault writes are refused.\n` +
        `Fix: cd ${repoRoot} && ph login && switchboard auth login --renown`,
    );
  }
  return st;
}

/**
 * Find the vault drive: the drive whose tree contains a `bai/vault-config`
 * singleton (AGENT.md § Find the vault drive).
 */
export function detectDrive() {
  const drives = sbJson(["drives", "list"]);
  for (const d of drives) {
    let nodes;
    try {
      nodes = sbJson(["docs", "tree", d.slug]).nodes || [];
    } catch {
      continue;
    }
    if (nodes.some((n) => n.documentType === "bai/vault-config")) {
      return { slug: d.slug, uuid: d.id };
    }
  }
  throw new VaultError(
    `no drive containing a bai/vault-config singleton found (checked ${drives.length} drives)`,
  );
}

/** Full document JSON: `docs get <id> --state --format json`. */
export function getDoc(docId) {
  return sbJson(["docs", "get", docId, "--state"]);
}
/** Create a document in the vault (through the CLI pipeline — never
 *  createEmptyDocument). Returns the doc id. `docs create` owns --format,
 *  so parse the JSON here rather than via sbJson. */
export function createDoc(type, name, { driveSlug, parentFolder }) {
  const args = ["docs", "create", "--type", type, "--name", name, "--drive", driveSlug];
  if (parentFolder) args.push("--parent-folder", parentFolder);
  const out = sb([...args, "--format", "json"]);
  return JSON.parse(out).id;
}

/** `state.global` of a document. */
export function getDocState(docId) {
  const doc = getDoc(docId);
  return doc.state?.global ?? {};
}

/** Drive tree nodes: `docs tree <slug> --format json`. */
export function tree(slug) {
  return sbJson(["docs", "tree", slug]).nodes || [];
}

/** Raw GraphQL read: `switchboard query '<q>' --format json`. Reads only. */
export function query(q) {
  return sbJson(["query", q]);
}

/** One line for a reactor error: reducer messages pass through; zod issue
 *  arrays become `code at path: detail` (mirrors hooks/post-apply-check.py). */
export function summarizeError(err) {
  const text = String(err).trim();
  try {
    const issues = JSON.parse(text);
    if (Array.isArray(issues)) {
      return issues
        .slice(0, 3)
        .map((i) => {
          const path = (i.path || []).map(String).join(".") || "input";
          let detail = i.message || "";
          if (i.values) detail = `expected one of ${i.values.map(String).join(", ")}`;
          return `${i.code || "invalid"} at ${path}: ${detail}`;
        })
        .join("; ")
        .slice(0, 200);
    }
  } catch {
    // not a zod payload — fall through
  }
  return text.split("\n")[0].slice(0, 160);
}

/** Stamp every action with `scope: "global"`. The CLI stamps the envelope
 *  `id` + `timestampUtcMs`; business timestamps inside `input` (ADD_NOTE.
 *  timestamp, handoff completedAt, …) are the harness's job — callers must
 *  include them where the reducer requires them. */
export function actions(...batch) {
  return batch.flat().map((a) => ({ ...a, scope: "global" }));
}

/**
 * The only write path.
 *
 * 1. write actions to a temp JSON file
 * 2. lint it (exit ≠ 0 → abort, nothing dispatched)
 * 3. `switchboard docs apply <docId> --file <file> --wait` (signed, labeled)
 * 4. read the operation log for actions the reactor REJECTED — batches are
 *    silently partial; a rejected action is recorded with its error string
 *    and no state change
 * 5. any rejection of our actions → throw; caller decides retry/escalate
 */
export function applyWithVerify(docId, batch, { tmpDir, log } = {}) {
  const list = actions(...batch);
  const tmpParent = expandHome(tmpDir || "~/.omp/vault-harness/tmp");
  mkdirSync(tmpParent, { recursive: true });
  const dir = mkdtempSync(join(tmpParent, "apply-"));
  const file = join(dir, "actions.json");
  try {
    writeFileSync(file, JSON.stringify(list, null, 2) + "\n");

    // 2. pre-dispatch lint — the linter reads the same file the CLI will
    let lintOut = "";
    try {
      lintOut = execFileSync(process.execPath, [LINT, file], { encoding: "utf8", timeout: 30_000 });
    } catch (e) {
      const out = `${e.stdout || ""}${e.stderr || ""}`.trim();
      throw new VaultError(`lint-actions rejected the batch (nothing dispatched):\n${out}`);
    }
    if (log) log(`apply lint ok (${list.length} action(s) on ${docId.slice(0, 8)})`);

    // 3. signed, labeled, synchronous apply
    const before = new Date(Date.now() - 5000).toISOString(); // margin: ops recorded during --wait
    sb(["docs", "apply", docId, "--file", file, "--wait"], {
      env: { SWITCHBOARD_APP_NAME: APP_NAME },
      timeoutMs: 300_000,
    });

    // 4. operation-log rejection check (hooks/post-apply-check.py pattern)
    const q = `{ document(identifier:"${docId}"){ document{ operations(filter:{ scopes:["global"], timestampFrom:"${before}" }, paging:{ limit:200 }){ items{ index error action{ type input } } } } } }`;
    const data = query(q);
    const ops = data?.document?.document?.operations?.items || [];
    const ours = new Map(list.map((a) => [JSON.stringify({ type: a.type, input: a.input }), a]));
    const rejections = [];
    for (const op of ops) {
      if (!op.error) continue;
      const key = JSON.stringify({ type: op.action?.type, input: op.action?.input });
      if (ours.has(key)) rejections.push({ type: op.action?.type, error: op.error });
    }
    if (rejections.length) {
      throw new RejectedActionsError(docId, rejections);
    }
    if (log) log(`apply verified: ${list.length} action(s) on ${docId.slice(0, 8)}, none rejected`);
    return ops;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
