#!/usr/bin/env node
/**
 * Vault harness — autonomous task processing for the Powerhouse knowledge
 * vault.
 *
 * Pulls the next actionable WBS goal from the vault, runs a headless worker
 * on it in a git worktree, re-runs the repo's gates, passes it through an
 * independent reviewer, delivers a PR, and records the outcome back in the
 * vault — one task at a time, every state transition owned by this code,
 * every vault write read-back verified.
 *
 * Modes:
 *   node harness/run.mjs --once          process tasks until none is actionable, exit
 *   node harness/run.mjs --loop          after each task: select again; when none: sleep pollSeconds
 *   node harness/run.mjs --max-tasks N   stop after N tasks (combinable with the above)
 *   node harness/run.mjs --status        print config + state, exit
 *   node harness/run.mjs --gc            remove worktrees of tasks no longer active under our assignee, exit
 *   node harness/run.mjs --help
 *
 * Run under tmux or systemd; the harness itself is a plain foreground
 * process with crash recovery in state.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, State, nowIso } from "./lib/state.mjs";
import { assertIdentity, cliVersion, isCliVersionAtLeast, detectDrive, tree, getDocState } from "./lib/vault.mjs";
import { loadRepos, selectNextTask, selectNextPipelineTask } from "./lib/select.mjs";
import { processWbsGoal, blockGoal } from "./lib/wbs.mjs";
import { processPipelineTask } from "./lib/pipeline.mjs";
import { expandHome } from "./lib/state.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const HELP = `vault-harness — process vault tasks end-to-end

usage: node harness/run.mjs [mode] [options]

modes:
  --once            process until no actionable task remains, then exit (default)
  --loop            like --once, but keep polling every <pollSeconds>
  --gc              remove worktrees for tasks no longer active under our assignee, then exit
  --status          print config + state, then exit
  --help            this text

options:
  --max-tasks N     stop after N completed attempts

config: harness/config.json (copy config.example.json), harness/repos.json
        (copy repos.example.json). Runtime artifacts live in stateDir.
`;

function parseArgs(argv) {
  const opts = { mode: "once", maxTasks: null, gc: false, status: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") opts.mode = "once";
    else if (a === "--loop") opts.mode = "loop";
    else if (a === "--gc") opts.gc = true;
    else if (a === "--status") opts.status = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--max-tasks") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--max-tasks needs a positive integer");
      opts.maxTasks = n;
    } else throw new Error(`unknown argument: ${a} (see --help)`);
  }
  return opts;
}

const REQUIRED_CONFIG_KEYS = [
  "profile",
  "stateDir",
  "assignee",
  "workerModel",
  "reviewModel",
  "taskTimeoutMin",
  "reviewTimeoutMin",
  "maxWorkerRounds",
  "maxReviewRounds",
  "pollSeconds",
  "delivery",
  "prRequired",
];

export function loadConfig(harnessDir = here) {
  const path = join(harnessDir, "config.json");
  if (!existsSync(path)) {
    throw new Error(
      `harness/config.json not found — copy the template first:\n  cp ${join(harnessDir, "config.example.json")} ${path}`,
    );
  }
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const missing = REQUIRED_CONFIG_KEYS.filter((k) => cfg[k] === undefined);
  if (missing.length) throw new Error(`harness/config.json missing keys: ${missing.join(", ")}`);
  if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds < 1)
    throw new Error("config.pollSeconds must be >= 1");
  if (cfg.delivery !== "pr") throw new Error(`config.delivery must be "pr" (got ${JSON.stringify(cfg.delivery)})`);
  return cfg;
}

function printStatus(cfg) {
  const state = new State(cfg.stateDir);
  console.log(JSON.stringify({ config: cfg, state: state.data }, null, 2));
}

/** Pre-flight: exact fix command on failure, no writes before it passes. */
function startupChecks(cfg, state, log) {
  const v = cliVersion();
  if (!isCliVersionAtLeast(v, [1, 0, 36])) {
    throw new Error(`switchboard CLI v${v.join(".")} < 1.0.36 — upgrade: curl -fsSL https://raw.githubusercontent.com/liberuum/switchboard-cli/main/install.sh | bash`);
  }
  const id = assertIdentity();
  log(`startup: signing on (did ${id.did.slice(0, 20)}…, profile ${id.profile})`);
  if (id.credential_expired) {
    log(`startup: WARNING — Renown credential expired ${id.credential_expires}; key still signs but the key↔address binding is stale (renew: cd <harness repo> && ph login && switchboard auth login --renown)`);
  }
  if (!state.data.drive) {
    state.data.drive = detectDrive();
    state.save();
  }
  log(`startup: drive ${state.data.drive.slug} (${state.data.drive.uuid})`);
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crash recovery: reconcile state.active against the vault before the first
 * select. Returns { kind, task, resume } for the WBS processor or
 * { kind, pt } for the pipeline processor, or null (state cleared/kept).
 */
function crashRecovery(cfg, state, log) {
  const a = state.data.active;
  if (!a) return null;
  try {
    if (a.type === "wbs") {
      let goal = null;
      try {
        goal = getDocState(a.wbsId).goals.find((x) => x.id === a.goalId);
      } catch (e) {
        log(`recovery: cannot read WBS ${String(a.wbsId).slice(0, 8)}: ${e.message}`);
      }
      const ours = goal && goal.assignee === cfg.assignee && (goal.status === "IN_PROGRESS" || goal.status === "IN_REVIEW");
      if (!ours) {
        log(`recovery: wbs ${String(a.goalId).slice(0, 8)} no longer ours (status=${goal?.status}, assignee=${goal?.assignee}) — clearing state`);
        state.data.active = null;
        state.save();
        return null;
      }
      const repos = loadRepos();
      const repo = a.repoCode ? repos[a.repoCode] : null;
      const blockAndClear = (reason) => {
        log(`recovery: ${reason} — BLOCKED`);
        try {
          blockGoal(a.wbsId, a.goalId, reason, log);
        } catch (e) {
          log(`recovery: BLOCKED write failed: ${e.message} (state kept for manual inspection)`);
          return;
        }
        state.data.active = null;
        state.data.counts.blocked++;
        state.save();
      };
      if (!repo) return blockAndClear(`harness restart: repos.json no longer maps ${a.repoCode}`) || null;
      if (a.phase !== "claim" && (!a.worktree || !existsSync(a.worktree))) return blockAndClear("harness restart lost the worktree") || null;
      const ref = a.taskRef;
      if (!ref?.goal || !ref?.envelope) {
        log("recovery: active record has no taskRef (pre-recovery state shape) — clearing state");
        state.data.active = null;
        state.save();
        return null;
      }
      log(`recovery: resuming wbs ${a.goalId.slice(0, 8)} (phase=${a.phase}, worktree=${a.worktree})`);
      return {
        kind: "wbs",
        task: { kind: "wbs", wbsId: a.wbsId, goal: ref.goal, scope: ref.scope, envelope: ref.envelope, ancestors: ref.ancestors || [], repo },
        resume: a,
      };
    }
    if (a.type === "pipeline") {
      if (!a.pqId) {
        log("recovery: pipeline active record has no pqId — clearing state");
        state.data.active = null;
        state.save();
        return null;
      }
      const t = getDocState(a.pqId).tasks.find((x) => x.id === a.taskId);
      if (!t || t.status !== "IN_PROGRESS" || t.assignedTo !== cfg.assignee) {
        log(`recovery: pipeline ${String(a.taskId).slice(0, 8)} no longer ours (status=${t?.status}, assignedTo=${t?.assignedTo}) — clearing state`);
        state.data.active = null;
        state.save();
        return null;
      }
      log(`recovery: resuming pipeline ${a.taskId.slice(0, 8)} (phase=${a.phase}${a.heldVerifyHandoff ? ", QA pending" : ""})`);
      return { kind: "pipeline", pt: { pqId: a.pqId, task: t } };
    }
    log(`recovery: unknown active type ${a.type} — clearing state`);
    state.data.active = null;
    state.save();
    return null;
  } catch (e) {
    log(`recovery FAILED (state kept for manual inspection): ${e.message}`);
    return null;
  }
}

/** --gc: remove worktrees whose goal is no longer active under our assignee. */
function runGc(cfg, state, log) {
  const repos = loadRepos();
  for (const repo of Object.values(repos)) {
    try {
      execFileSync("git", ["-C", repo.path, "worktree", "prune"], { encoding: "utf8", timeout: 60_000 });
    } catch {
      /* prune is best-effort */
    }
  }
  const wtRoot = join(expandHome(cfg.stateDir), "worktrees");
  if (!existsSync(wtRoot)) {
    log("gc: no worktrees — done");
    return;
  }
  // index every WBS goal by its id prefix (worktree dirs are vault-<g8>)
  const nodes = tree(state.data.drive.slug);
  const goalByG8 = {};
  for (const n of nodes.filter((x) => x.kind === "file" && x.documentType === "bai/wbs")) {
    let st;
    try {
      st = getDocState(n.id);
    } catch {
      continue;
    }
    for (const g of st.goals || []) goalByG8[g.id.slice(0, 8)] = g;
  }
  let removed = 0;
  let kept = 0;
  for (const name of readdirSync(wtRoot)) {
    if (!name.startsWith("vault-")) continue;
    const g8 = name.slice("vault-".length);
    const wtPath = join(wtRoot, name);
    const g = goalByG8[g8];
    const active = g && (g.status === "IN_PROGRESS" || g.status === "IN_REVIEW") && g.assignee === cfg.assignee;
    if (active) {
      kept++;
      log(`gc: keeping ${name} (${g.id} is ${g.status} under ${g.assignee})`);
      continue;
    }
    try {
      execFileSync("git", ["-C", wtPath, "worktree", "remove", "--force", wtPath], { encoding: "utf8", timeout: 120_000 });
    } catch (e) {
      log(`gc: worktree remove failed for ${name}: ${String(e.message).split("\n")[0]} — leaving for manual removal`);
      continue;
    }
    removed++;
    log(`gc: removed ${name} (${g ? `${g.id} ${g.status}` : "goal not found in any WBS"})`);
  }
  log(`gc: done (removed=${removed}, kept=${kept})`);
}
async function runTasks(cfg, state, log, { maxTasks }) {
  const repos = loadRepos();
  const cap = Math.min(maxTasks ?? Infinity, cfg.maxTasksPerRun ?? Infinity);
  let processed = 0;
  for (;;) {
    if (processed >= cap) break;
    // WBS goals first (implementation work), then pipeline tasks.
    const wbsTask = selectNextTask({ driveSlug: state.data.drive.slug, repos, assignee: cfg.assignee, log });
    const res = wbsTask
      ? await processWbsGoal(wbsTask, { cfg, state, log })
      : await (async () => {
          const pt = selectNextPipelineTask({ driveSlug: state.data.drive.slug, assignee: cfg.assignee, log });
          if (!pt) return null;
          return processPipelineTask(pt, { cfg, state, log });
        })();
    if (!res) break;
    processed++;
    log(`task ${res.outcome}: ${res.detail}`);
    if (state.data.active) {
      log(`isolation WARNING: state.active still set after task (${JSON.stringify(state.data.active)}) — will be reconciled at next startup`);
    }
  }
  return { processed };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }

  const state = new State(cfg.stateDir);
  const log = createLogger(cfg.stateDir, opts.gc ? "gc" : "run");

  if (opts.status) {
    printStatus(cfg);
    return;
  }

  state.data.lastRun = nowIso();
  state.save();
  log(`harness starting (mode=${opts.mode}, profile=${cfg.profile}, assignee=${cfg.assignee})`);

  if (opts.gc) {
    try {
      startupChecks(cfg, state, log);
    } catch (e) {
      log(`startup FAILED: ${e.message}`);
      process.exit(1);
    }
    runGc(cfg, state, log);
    return;
  }

  try {
    startupChecks(cfg, state, log);
  } catch (e) {
    log(`startup FAILED: ${e.message}`);
    process.exit(1);
  }
  const recovery = crashRecovery(cfg, state, log);
  if (recovery) {
    const res =
      recovery.kind === "wbs"
        ? await processWbsGoal(recovery.task, { cfg, state, log, resume: recovery.resume })
        : await processPipelineTask(recovery.pt, { cfg, state, log });
    log(`task ${res.outcome}: ${res.detail}`);
  }

  if (opts.mode === "loop") {
    let budget = opts.maxTasks;
    for (;;) {
      const { processed } = await runTasks(cfg, state, log, { maxTasks: budget });
      if (budget !== null) budget -= processed;
      if (budget === 0) break;
      if (processed === 0) {
        log(`loop: nothing actionable — sleeping ${cfg.pollSeconds}s`);
        await sleep(cfg.pollSeconds * 1000);
      }
    }
    log("harness finished (loop)");
  } else {
    const { processed } = await runTasks(cfg, state, log, { maxTasks: opts.maxTasks });
    log(`harness finished (processed=${processed})`);
  }
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
