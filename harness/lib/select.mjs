/**
 * Task selection — returns the single next actionable WBS goal, or null.
 *
 * Order is deterministic and equals display order (the rule the vault itself
 * uses): scope order from the drive tree listing, then envelope array order,
 * then goal array order (depth-first) within each WBS. Selection reads
 * nothing mutable; claiming (wbs.mjs) makes it safe against concurrent
 * humans — a claim that fails read-back is simply skipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tree, getDocState, repoRoot } from "./vault.mjs";

/** Scopes in these states are work orders; the rest are plans or closed. */
const ACTIONABLE_SCOPE_STATUSES = new Set(["IN_PROGRESS", "APPROVED"]);

export class ReposError extends Error {}

/**
 * Load harness/repos.json: maps an envelope's `code` to a local checkout and
 * its gate commands. Envelopes whose `code` is absent are never picked.
 */
export function loadRepos(harnessDir = join(repoRoot, "harness")) {
  const path = join(harnessDir, "repos.json");
  if (!existsSync(path)) {
    throw new ReposError(
      `harness/repos.json not found — copy the template and map at least one envelope:\n  cp ${join(harnessDir, "repos.example.json")} ${path}`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const repos = {};
  for (const [code, entry] of Object.entries(raw)) {
    if (code.startsWith("_")) continue;
    if (typeof entry?.path !== "string" || !existsSync(entry.path)) {
      throw new ReposError(`repos.json[${code}].path: not an existing directory: ${entry?.path}`);
    }
    if (typeof entry.defaultBranch !== "string") {
      throw new ReposError(`repos.json[${code}].defaultBranch: missing (the branch worktrees are created from)`);
    }
    if (!Array.isArray(entry.gate) || entry.gate.length === 0 || entry.gate.some((g) => typeof g !== "string")) {
      throw new ReposError(`repos.json[${code}].gate: must be a non-empty array of shell commands`);
    }
    if (entry.setup !== undefined && (!Array.isArray(entry.setup) || entry.setup.some((s) => typeof s !== "string"))) {
      throw new ReposError(`repos.json[${code}].setup: must be an array of shell commands (run once per worktree, before gates)`);
    }
    repos[code] = { code, path: entry.path, defaultBranch: entry.defaultBranch, gate: entry.gate, setup: entry.setup || [] };
  }
  return repos;
}

/** Build a parent→children index from the flat depth-first goals array. */
export function buildGoalTree(goals) {
  const byId = new Map(goals.map((g) => [g.id, { ...g, children: [] }]));
  for (const g of byId.values()) {
    if (g.parentId && byId.has(g.parentId)) byId.get(g.parentId).children.push(g);
  }
  return byId;
}

/** Parent chain (root first … nearest parent last). */
export function ancestorsOf(goalId, byId) {
  const chain = [];
  let cur = byId.get(goalId);
  while (cur?.parentId && byId.has(cur.parentId)) {
    cur = byId.get(cur.parentId);
    chain.unshift({ id: cur.id, description: cur.description });
  }
  return chain;
}

/**
 * A goal is actionable iff:
 *  - status TODO
 *  - a leaf (no children — parents are aggregates)
 *  - every id in dependencies resolves to a goal with status COMPLETED
 *  - unassigned, or assigned to us
 */
function goalIsActionable(g, byId, assignee) {
  if (g.status !== "TODO") return { ok: false };
  if (g.children.length > 0) return { ok: false };
  for (const dep of g.dependencies || []) {
    const d = byId.get(dep);
    if (!d) return { ok: false, why: `dangling dependency ${dep}` };
    if (d.status !== "COMPLETED") return { ok: false, why: `dependency ${dep} is ${d.status}` };
  }
  if (g.assignee && g.assignee !== assignee) return { ok: false };
  return { ok: true };
}

/**
 * Select the next actionable task.
 *
 * @param {object} p
 * @param {string} p.driveSlug  vault drive slug
 * @param {object} p.repos      loadRepos() result
 * @param {string} p.assignee   config.assignee
 * @param {(msg:string)=>void} [p.log]
 * @returns the task descriptor, or null when nothing is actionable
 */
export function selectNextTask({ driveSlug, repos, assignee, log = () => {} }) {
  const nodes = tree(driveSlug);

  // the /projects/ folder at the drive root
  const projectsFolder = nodes.find(
    (n) => n.kind === "folder" && n.name === "projects" && n.parentFolder == null,
  );
  if (!projectsFolder) {
    log("select: no /projects/ folder in the drive — nothing to do");
    return null;
  }

  // scopes in tree-listing order
  const scopes = nodes.filter(
    (n) => n.kind === "file" && n.documentType === "powerhouse/scopeofwork" && n.parentFolder === projectsFolder.id,
  );
  for (const scopeNode of scopes) {
    let scope;
    try {
      scope = getDocState(scopeNode.id);
    } catch (e) {
      log(`select: skipping unreadable scope ${scopeNode.name}: ${e.message}`);
      continue;
    }
    if (!ACTIONABLE_SCOPE_STATUSES.has(scope.status)) {
      log(`select: scope "${scope.title}" is ${scope.status} — not an active work order, skipping`);
      continue;
    }

    // envelopes in array order
    for (const envelope of scope.projects || []) {
      if (!envelope.wbsRef) continue;
      const repo = repos[envelope.code];
      if (!repo) {
        log(`select: envelope ${envelope.code} (${envelope.title}) has no repos.json mapping — skipping`);
        continue;
      }
      let wbs;
      try {
        wbs = getDocState(envelope.wbsRef);
      } catch (e) {
        log(`select: skipping unreadable WBS for envelope ${envelope.code}: ${e.message}`);
        continue;
      }
      const byId = buildGoalTree(wbs.goals || []);

      // goals in array order (depth-first = display = work order); byId
      // preserves that insertion order and carries the children index
      for (const goal of byId.values()) {
        const check = goalIsActionable(goal, byId, assignee);
        if (!check.ok) {
          if (check.why?.startsWith("dependency")) {
            log(`select: goal ${goal.id} waiting — ${check.why}`);
          }
          continue;
        }
        log(
          `select: goal ${goal.id} ("${goal.description}") under ${envelope.code} / scope "${scope.title}" — actionable`,
        );
        return {
          kind: "wbs",
          scope: { id: scopeNode.id, title: scope.title, status: scope.status },
          envelope: {
            code: envelope.code,
            title: envelope.title,
            abstract: envelope.abstract || null,
            references: envelope.references || [],
            knowledgeRefs: envelope.knowledgeRefs || [],
            wbsRef: envelope.wbsRef,
          },
          wbsId: envelope.wbsRef,
          goal: {
            id: goal.id,
            description: goal.description,
            dependencies: goal.dependencies || [],
          },
          ancestors: ancestorsOf(goal.id, byId),
          repo,
        };
      }
      log(`select: WBS for envelope ${envelope.code} (${envelope.wbsRef}) has no actionable goal`);
    }
  }
  log("select: no actionable WBS goal found");
  return null;
}

/**
 * Select the next actionable pipeline task from the bai/pipeline-queue
 * singleton.
 *
 * Actionable: status PENDING (claim it), or IN_PROGRESS assigned to us
 * (resume it). taskType must be `claim` or `enrichment` — the only values
 * with a phaseOrder (AGENT.md); anything else (e.g. legacy PROCESS_SOURCE)
 * can never advance and is logged, not picked.
 *
 * @param {object} p
 * @param {string} p.driveSlug
 * @param {string} p.assignee
 * @param {(msg:string)=>void} [p.log]
 * @returns {{kind:"pipeline", pqId:string, task:object}|null}
 */
export function selectNextPipelineTask({ driveSlug, assignee, log = () => {} }) {
  const nodes = tree(driveSlug);
  const queueNode = nodes.find((n) => n.kind === "file" && n.documentType === "bai/pipeline-queue");
  if (!queueNode) {
    log("select: no bai/pipeline-queue singleton found");
    return null;
  }
  let queue;
  try {
    queue = getDocState(queueNode.id);
  } catch (e) {
    log(`select: pipeline-queue unreadable: ${e.message}`);
    return null;
  }
  for (const t of queue.tasks || []) {
    if (t.taskType !== "claim" && t.taskType !== "enrichment") {
      if (t.status === "PENDING" || t.status === "IN_PROGRESS")
        log(`select: pipeline task ${t.id.slice(0, 8)} has unadvanceable taskType ${t.taskType} (status ${t.status}) — skipping`);
      continue;
    }
    const fresh = t.status === "PENDING";
    const ours = t.status === "IN_PROGRESS" && t.assignedTo === assignee;
    if (!fresh && !ours) continue;
    log(`select: pipeline task ${t.id.slice(0, 8)} ("${t.target}") ${fresh ? "pending" : `in progress (phase ${t.currentPhase ?? "?"})`} — actionable`);
    return { kind: "pipeline", pqId: queueNode.id, task: t };
  }
  log("select: no actionable pipeline task");
  return null;
}
