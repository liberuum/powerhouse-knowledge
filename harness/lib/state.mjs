/**
 * Runtime state for the vault harness.
 *
 * The vault is the record; this is the harness's own scratchpad for crash
 * recovery — what an interrupted run must remember to resume or to mark
 * BLOCKED. It holds only what the orchestrator (not the vault) owns: which
 * task is active and where its worktree is.
 *
 *   <stateDir>/state.json   { drive, active, lastRun, counts }
 *   <stateDir>/logs/        run logs + per-task audit dirs
 *   <stateDir>/worktrees/   one git worktree per active WBS goal
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p) {
  return p && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function nowIso() {
  return new Date().toISOString();
}

export const DEFAULT_STATE = {
  drive: null, // { slug, uuid } once detected
  // { type: "wbs", goalId, wbsId, scopeId, phase, round, worktree, base, branch, since } | null
  active: null,
  lastRun: null,
  counts: { completed: 0, blocked: 0, failed: 0 },
};

export class State {
  constructor(stateDir) {
    this.dir = expandHome(stateDir);
    this.path = join(this.dir, "state.json");
    mkdirSync(join(this.dir, "logs"), { recursive: true });
    this.data = State.load(this.path);
  }

  static load(path) {
    try {
      const d = JSON.parse(readFileSync(path, "utf8"));
      return {
        ...DEFAULT_STATE,
        ...d,
        counts: { ...DEFAULT_STATE.counts, ...(d.counts || {}) },
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
  }
}

/**
 * One line per transition to the console and <stateDir>/logs/<name>-<ts>.log.
 * Logs are the operator's window; the vault is the record.
 */
export function createLogger(stateDir, name) {
  const dir = expandHome(stateDir);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const file = join(dir, "logs", `${name}-${nowIso().replace(/[:.]/g, "-")}.log`);
  return (msg) => {
    const line = `[${nowIso()}] ${msg}`;
    console.log(line);
    try {
      appendFileSync(file, line + "\n");
    } catch {
      // logging must never kill the loop
    }
  };
}
