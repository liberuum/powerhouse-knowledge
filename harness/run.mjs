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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, State, nowIso } from "./lib/state.mjs";
import { assertIdentity, cliVersion, isCliVersionAtLeast, detectDrive } from "./lib/vault.mjs";
import { loadRepos, selectNextTask, selectNextPipelineTask } from "./lib/select.mjs";
import { processWbsGoal } from "./lib/wbs.mjs";
import { processPipelineTask } from "./lib/pipeline.mjs";

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
    log("--gc not wired yet — nothing to do");
    return;
  }

  try {
    startupChecks(cfg, state, log);
  } catch (e) {
    log(`startup FAILED: ${e.message}`);
    process.exit(1);
  }
  if (state.data.active) {
    log(`startup: WARNING — state.active is set (${JSON.stringify(state.data.active)}); crash recovery not wired yet, not resuming`);
  }
  if (opts.mode === "loop") {
    log("mode=loop: polling not wired yet — running one pass");
  }

  const { processed } = await runTasks(cfg, state, log, { maxTasks: opts.maxTasks });
  log(`harness finished (processed=${processed})`);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
