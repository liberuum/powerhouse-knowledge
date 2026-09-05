/**
 * WBS goal processor — takes one selected task and drives it end-to-end:
 *
 *   claim → worktree → worker round(s) → gate → IN_REVIEW → reviewer →
 *   (fix rounds) → PR delivery → vault record → cleanup
 *
 * Every state transition is owned by this code; agents do only the
 * intellectual work. The only exits after a successful claim are
 * COMPLETED (with outcome) or BLOCKED (with non-blank reason) — a goal is
 * never left IN_PROGRESS/IN_REVIEW at the end of an attempt.
 */

import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { getDoc, getDocState, applyWithVerify, actions, repoRoot } from "./vault.mjs";
import { runAgent } from "./runner.mjs";
import { review, worktreeDiff } from "./review.mjs";
import { nowIso, expandHome } from "./state.mjs";

const WORKER_PROMPT = join(repoRoot, "harness", "prompts", "worker-code.md");
const NOVAULT_HOOK = join(repoRoot, "harness", "hooks", "no-vault-writes.ts");
const GLOBAL_NOTES = join(homedir(), ".omp", "agent", "AGENTS.md");

/** Per-task audit directory under <stateDir>/logs/<g8>-<ts>/. */
export class Audit {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  write(name, content) {
    try {
      writeFileSync(join(this.dir, name), content);
    } catch {
      // audit must never break the run
    }
  }
}

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 });

/** gh has no -C — run it with the worktree as cwd. */
const gh = (cwd, ...args) => execFileSync("gh", args, { cwd, encoding: "utf8", timeout: 120_000 }).trim();

/** Close the deliverable linked to a goal (SET_DELIVERABLE_PROGRESS done +
 *  Shipped key result). Returns true if a deliverable was closed. */
function closeDeliverableForGoal(goalId, { scopeId, link, log }) {
  let deliverable = null;
  try {
    const scope = getDocState(scopeId);
    deliverable = (scope.deliverables || []).find((d) => d.goalRef === goalId) || null;
  } catch (e) {
    log(`wbs: scope read failed for deliverable close-out (${goalId}): ${e.message}`);
  }
  if (!deliverable) return false;
  const batch = [{ type: "SET_DELIVERABLE_PROGRESS", input: { id: deliverable.id, workProgress: { done: true } } }];
  if (link) batch.push({ type: "ADD_KEY_RESULT", input: { id: randomUUID(), deliverableId: deliverable.id, title: "Shipped", link } });
  applyWithVerify(scopeId, actions(...batch), { log });
  return true;
}

/**
 * Assemble the plain-text task brief the worker receives.
 * knowledgeRefs are optional context; a ref that fails to read is skipped
 * with a log line, never fatal.
 */
export function buildBrief(task, log = () => {}) {
  const parts = [
    `# Goal\n${task.goal.description}`,
    task.ancestors.length
      ? `## Context (ancestor goals, root → nearest)\n${task.ancestors.map((a) => `- ${a.description}`).join("\n")}`
      : null,
    `## Envelope\n${task.envelope.code} — ${task.envelope.title}` +
      (task.envelope.abstract ? `\n${task.envelope.abstract}` : "") +
      (task.envelope.references.length ? `\nReferences:\n${task.envelope.references.map((r) => `- ${r}`).join("\n")}` : ""),
  ];

  const knowledge = [];
  for (const ref of (task.envelope.knowledgeRefs || []).slice(0, 5)) {
    try {
      const doc = getDoc(ref);
      const content = doc.state?.global?.content ?? "";
      knowledge.push(`### ${doc.name ?? ref}\n${content.slice(0, 4000)}`);
    } catch (e) {
      log(`brief: skipping unreadable knowledgeRef ${ref}: ${e.message}`);
    }
  }
  if (knowledge.length) parts.push(`## Vault knowledge to build on\n${knowledge.join("\n\n")}`);

  parts.push(
    "## Completion criteria\nThe goal is done when the implementation is committed to the current branch. Do not push. Do not open PRs.",
  );
  return parts.filter(Boolean).join("\n\n");
}

/** Commit anything the worker left uncommitted (never lose work). */
function commitLooseChanges(wt) {
  const status = git(wt, "status", "--porcelain");
  if (status.trim()) {
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "vault: uncommitted worktree changes");
    return true;
  }
  return false;
}

function commitCount(wt, range) {
  return Number(git(wt, "rev-list", "--count", range).trim());
}

/** Run every gate command in the worktree. Bounded per command. */
export function runGates(wt, gate) {
  for (const cmd of gate) {
    const r = spawnSync(cmd, { cwd: wt, shell: true, encoding: "utf8", timeout: 20 * 60_000 });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (r.status !== 0) {
      return { ok: false, command: cmd, output: out, code: r.status };
    }
  }
  return { ok: true };
}

function gateFailureInstruction(fail, brief) {
  return [
    "The harness re-ran the repository gate and it FAILED. Fix exactly this failure, then re-run the failing command to prove it passes.",
    "",
    `Failing command: ${fail.command}`,
    `Exit code: ${fail.code}`,
    "",
    "Last 500 lines of output:",
    "```",
    fail.output.split("\n").slice(-500).join("\n"),
    "```",
    "",
    "Original goal (for context):",
    brief,
  ].join("\n");
}

function reviewFixInstruction(v, brief) {
  return [
    "An independent reviewer REJECTED the current work. Fix exactly these findings (blockers and majors first), then re-run the repo's checks.",
    "",
    "Review summary:",
    v.summary,
    "",
    "Findings (JSON):",
    JSON.stringify(v.findings, null, 2),
    "",
    "Original goal (for context):",
    brief,
  ].join("\n");
}

/**
 * One vault note recording what happened (author = assignee).
 */
function note(goalId, text) {
  return { type: "ADD_NOTE", input: { goalId, noteId: randomUUID(), note: text, author: "vault-harness", timestamp: nowIso() } };
}

/** BLOCKED + explanatory note in one batch. Throws if rejected. */
export function blockGoal(wbsId, goalId, reason, log = () => {}) {
  applyWithVerify(
    wbsId,
    actions(
      { type: "SET_GOAL_STATUS", input: { id: goalId, status: "BLOCKED", blockReason: reason } },
      note(goalId, `BLOCKED by vault-harness: ${reason}`),
    ),
    { log },
  );
}

/** Parse `git remote get-url origin` → { owner, repo } for a GitHub remote. */
function githubRemote(wt) {
  try {
    const url = git(wt, "remote", "get-url", "origin").trim();
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)\.git$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

/**
 * Process one selected WBS task to a terminal vault state.
 *
 * @returns {Promise<{outcome: "completed"|"blocked"|"skipped", detail: string}>}
 */
export async function processWbsGoal(task, { cfg, state, log }) {
  const g = task.goal;
  const g8 = g.id.slice(0, 8);
  const branch = `feat/vault-${g8}`;
  const audit = new Audit(join(state.dir, "logs", `${g8}-${nowIso().replace(/[:.]/g, "-")}`));
  const repoPath = task.repo.path;
  let workerRound = 0;
  let reviewRound = 0;
  let workerModel = null;
  let workerTokens = 0;
  let reviewModel = null;

  const fail = async (reason) => {
    log(`wbs ${g8}: BLOCKED — ${reason}`);
    audit.write("result.json", JSON.stringify({ outcome: "blocked", reason }, null, 2));
    try {
      blockGoal(task.wbsId, g.id, reason, log);
    } catch (e) {
      log(`wbs ${g8}: FATAL — could not record BLOCKED status: ${e.message} (worktree kept for inspection)`);
    }
    state.data.active = null;
    state.data.counts.blocked++;
    state.save();
    return { outcome: "blocked", detail: reason };
  };

  // 1. — Claim: assign + start in one order-preserving batch, then read back.
  log(`wbs ${g8}: claiming goal "${g.description}" (wbs ${task.wbsId.slice(0, 8)})`);
  try {
    applyWithVerify(
      task.wbsId,
      actions(
        { type: "ASSIGN_GOAL", input: { id: g.id, assignee: cfg.assignee } },
        { type: "SET_GOAL_STATUS", input: { id: g.id, status: "IN_PROGRESS" } },
      ),
      { log },
    );
  } catch (e) {
    log(`wbs ${g8}: claim failed — skipping: ${e.message}`);
    return { outcome: "skipped", detail: `claim failed: ${e.message}` };
  }
  const claimed = getDocState(task.wbsId).goals.find((x) => x.id === g.id);
  if (!claimed || claimed.assignee !== cfg.assignee || claimed.status !== "IN_PROGRESS") {
    log(`wbs ${g8}: claim did not stick (race or rejection) — skipping`);
    return { outcome: "skipped", detail: "claim did not stick" };
  }

  const WT = join(expandHome(cfg.stateDir), "worktrees", `vault-${g8}`);
  try {
    spawnSync("git", ["-C", repoPath, "fetch", "--quiet", "origin"], { timeout: 120_000 }); // best-effort
  } catch {
    log(`wbs ${g8}: fetch failed (continuing with local refs)`);
  }
  try {
    try {
      git(repoPath, "worktree", "add", WT, "-b", branch, task.repo.defaultBranch);
    } catch {
      // re-adopted task: branch already exists
      git(repoPath, "worktree", "add", WT, branch);
    }
  } catch (e) {
    await fail(`could not create worktree: ${String(e.message).slice(0, 300)}`);
    return;
  }
  const base = git(repoPath, "rev-parse", task.repo.defaultBranch).trim();
  for (const cmd of task.repo.setup || []) {
    log(`wbs ${g8}: worktree setup: ${cmd}`);
    const r = spawnSync(cmd, { cwd: WT, shell: true, encoding: "utf8", timeout: 30 * 60_000 });
    if (r.status !== 0) log(`wbs ${g8}: WARNING — setup command failed (exit ${r.status}): ${cmd}`);
  }

  state.data.active = {
    type: "wbs",
    goalId: g.id,
    wbsId: task.wbsId,
    scopeId: task.scope.id,
    phase: "worker",
    round: 0,
    reviewRound: 0,
    worktree: WT,
    base,
    branch,
    since: nowIso(),
  };
  state.save();
  log(`wbs ${g8}: worktree ${WT} (branch ${branch}, base ${base.slice(0, 8)})`);

  const brief = buildBrief(task, log);
  audit.write("brief.md", brief);

  /** Worker run + commit checks + gate, looping worker rounds on gate failure. */
  const workerGateLoop = async (instruction) => {
    for (;;) {
      workerRound++;
      if (workerRound > cfg.maxWorkerRounds) {
        throw { reason: `gate failed after ${cfg.maxWorkerRounds} rounds` };
      }
      state.data.active.phase = "worker";
      state.data.active.round = workerRound;
      state.save();
      const wr = await runAgent({
        cwd: WT,
        model: cfg.workerModel,
        prompt: instruction,
        systemPrompt: WORKER_PROMPT,
        hooks: [NOVAULT_HOOK],
        timeoutMin: cfg.taskTimeoutMin,
        log,
      });
      workerModel = wr.model || workerModel;
      workerTokens += wr.usage?.totalTokens || 0;
      audit.write(`worker-round-${workerRound}.txt`, `model: ${wr.model || "?"}\nok: ${wr.ok}\nexit: ${wr.exitCode}\n\n${wr.finalText}`);
      if (!wr.ok) {
        log(`wbs ${g8}: worker round ${workerRound} did not complete cleanly (terminal=${wr.terminal}, exit=${wr.exitCode}) — treating as failed round`);
      }
      commitLooseChanges(WT);
      if (commitCount(WT, `${base}..HEAD`) === 0) {
        return { failed: { reason: `no commits produced after ${workerRound} round(s)` } };
      }
      const gate = runGates(WT, task.repo.gate);
      audit.write(`gate-round-${workerRound}.log`, gate.ok ? "ok" : `$ ${gate.command}\nexit ${gate.code}\n${gate.output}`);
      if (gate.ok) {
        log(`wbs ${g8}: gate passed after worker round ${workerRound}`);
        return { failed: null };
      }
      log(`wbs ${g8}: gate failed (round ${workerRound}): ${gate.command}`);
      if (workerRound >= cfg.maxWorkerRounds) {
        return { failed: { reason: `gate failed after ${workerRound} rounds: ${gate.command}: ${gate.output.slice(0, 300)}` } };
      }
      instruction = gateFailureInstruction(gate, brief);
    }
  };

  try {
    // 4–6. — Worker + gate loop.
    const first = await workerGateLoop(brief);
    if (first.failed) return await fail(first.failed.reason);

    // 7. — Review & QA loop.
    applyWithVerify(task.wbsId, actions({ type: "SET_GOAL_STATUS", input: { id: g.id, status: "IN_REVIEW" } }), { log });
    const inReview = getDocState(task.wbsId).goals.find((x) => x.id === g.id);
    if (inReview?.status !== "IN_REVIEW") throw { reason: `could not move goal to IN_REVIEW (read-back: ${inReview?.status})` };
    log(`wbs ${g8}: IN_REVIEW — starting review`);

    for (;;) {
      reviewRound++;
      state.data.active.phase = "review";
      state.data.active.reviewRound = reviewRound;
      state.save();
      const v = await review({
        cwd: WT,
        brief,
        guidelines: [
          `- ${join(repoPath, "AGENTS.md")} and/or ${join(repoPath, "CLAUDE.md")} — repo guidelines (read them)`,
          `- ${GLOBAL_NOTES} — global agent notes (branch/commit hygiene)`,
        ],
        diffResult: worktreeDiff({ worktree: WT, base }),
        model: cfg.reviewModel,
        timeoutMin: cfg.reviewTimeoutMin,
        log,
      });
      reviewModel = v.model || reviewModel;
      audit.write(`review-round-${reviewRound}.json`, JSON.stringify({ ...v, run: undefined }, null, 2));
      if (v.verdict === "APPROVE") {
        log(`wbs ${g8}: review APPROVED (round ${reviewRound})`);
        break;
      }
      log(`wbs ${g8}: review REJECTED (round ${reviewRound}): ${v.summary}`);
      if (reviewRound >= cfg.maxReviewRounds) {
        const top = v.findings.filter((f) => f.severity !== "minor").slice(0, 3).map((f) => f.issue).join(" | ");
        return await fail(`review rejected after ${reviewRound} rounds: ${top || v.summary}`);
      }
      const fixed = await workerGateLoop(reviewFixInstruction(v, brief));
      if (fixed.failed) return await fail(fixed.failed.reason);
    }

    // 8. — Deliver (PR).
    state.data.active.phase = "deliver";
    state.save();
    const commitSha = git(WT, "rev-parse", "HEAD").trim();
    let prUrl = null;
    let deliveryNote = null;
    try {
      const originUrl = git(WT, "remote", "get-url", "origin").trim();
      void originUrl;
      git(WT, "push", "-u", "origin", branch);
      const title = `Vault ${g8}: ${g.description.split("\n")[0]}`.slice(0, 72);
      const body = [
        g.description,
        "",
        `Envelope: ${task.envelope.code} ${task.envelope.title}`,
        `Worker model: ${workerModel || "unknown"}`,
        `Review: APPROVED by reviewer (${reviewModel || "unknown"}), ${reviewRound} round(s)`,
        `Gates: ${task.repo.gate.join(" && ")} — all passing`,
      ].join("\n");
      gh(WT, "pr", "create", "--base", task.repo.defaultBranch, "--head", branch, "--title", title, "--body", body);
      prUrl = gh(WT, "pr", "view", "--head", branch, "--json", "url").trim();
    } catch (e) {
      // existing PR from a prior attempt of this goal?
      try {
        prUrl = gh(WT, "pr", "view", "--head", branch, "--json", "url").trim();
        deliveryNote = "PR already existed from a prior attempt";
      } catch {
        prUrl = null;
        deliveryNote = `PR not created: ${String(e.message).split("\n")[0].slice(0, 300)}`;
      }
    }
    if (prUrl === null && cfg.prRequired) {
      return await fail(deliveryNote || "PR not created: unknown reason");
    }
    audit.write("delivery.json", JSON.stringify({ commitSha, prUrl, deliveryNote }, null, 2));
    log(`wbs ${g8}: delivered — ${prUrl || deliveryNote}`);

    // 9. — Record in the vault.
    state.data.active.phase = "record";
    state.save();
    const repoBasename = repoPath.split("/").filter(Boolean).pop();
    const outcome = `${repoBasename}@${branch}@${commitSha.slice(0, 7)} (${prUrl || `branch only: ${deliveryNote}`})`;
    applyWithVerify(
      task.wbsId,
      actions(
        { type: "SET_GOAL_STATUS", input: { id: g.id, status: "COMPLETED", outcome } },
        note(
          g.id,
          `Implemented by vault-harness (worker model: ${workerModel || "unknown"}, ${workerTokens} tokens); ` +
            `reviewed by vault-harness (review model: ${reviewModel || "unknown"}, verdict APPROVE); ` +
            `gates passed: ${task.repo.gate.join(", ")}; ${nowIso()}`,
        ),
      ),
      { log },
    );

    // 9b. — Scope close-out. Deliverables are typically linked to the
    // top-level goals, so after the leaf completes, walk the ancestor
    // chain: a parent is COMPLETED once every child is, and each closed
    // level's deliverable is marked DELIVERED.
    const remote = githubRemote(WT);
    const link = prUrl || (remote ? `https://github.com/${remote.owner}/${remote.repo}/commit/${commitSha}` : null);
    const closedDeliverables = [];
    if (closeDeliverableForGoal(g.id, { scopeId: task.scope.id, link, log })) closedDeliverables.push(g.id);
    let cur = g;
    let wbsState = getDocState(task.wbsId);
    for (let depth = 0; depth < 8; depth++) {
      const curGoal = wbsState.goals.find((x) => x.id === cur.id);
      if (!curGoal?.parentId) break;
      const parent = wbsState.goals.find((x) => x.id === curGoal.parentId);
      if (!parent || parent.status === "COMPLETED" || parent.status === "CANCELLED") break;
      const kids = wbsState.goals.filter((x) => x.parentId === parent.id);
      if (!kids.every((k) => k.status === "COMPLETED" || k.status === "CANCELLED")) break;
      log(`wbs ${g8}: parent ${parent.id} — all children complete, marking COMPLETED`);
      applyWithVerify(
        task.wbsId,
        actions({
          type: "SET_GOAL_STATUS",
          input: { id: parent.id, status: "COMPLETED", outcome: `all children completed: ${kids.map((k) => k.id).join(", ")}` },
        }),
        { log },
      );
      if (closeDeliverableForGoal(parent.id, { scopeId: task.scope.id, link, log })) closedDeliverables.push(parent.id);
      cur = parent;
      wbsState = getDocState(task.wbsId);
    }

    // read-back assertions
    const done = getDocState(task.wbsId).goals.find((x) => x.id === g.id);
    let mismatch = null;
    if (!done || done.status !== "COMPLETED" || !done.outcome) {
      mismatch = `goal read-back: status=${done?.status} outcome=${JSON.stringify(done?.outcome || null)}`;
    } else if (closedDeliverables.length > 0) {
      const scope = getDocState(task.scope.id);
      for (const goalId of closedDeliverables) {
        const d = (scope.deliverables || []).find((x) => x.goalRef === goalId);
        if (d?.status !== "DELIVERED") {
          mismatch = `deliverable read-back (${goalId}): status=${d?.status}`;
          break;
        }
      }
    }
    audit.write("readback.json", JSON.stringify({ goal: done, closedDeliverables, mismatch }, null, 2));
    if (mismatch) {
      log(`wbs ${g8}: READ-BACK MISMATCH: ${mismatch} — recording note (no re-assert)`);
      applyWithVerify(task.wbsId, actions(note(g.id, `vault-harness read-back mismatch after COMPLETED: ${mismatch} @ ${nowIso()}`)), { log });
    }

    // 10. — Clean up.
    try {
      git(repoPath, "worktree", "remove", WT, "--force");
    } catch (e) {
      log(`wbs ${g8}: worktree remove failed: ${e.message}`);
    }
    state.data.active = null;
    state.data.counts.completed++;
    state.save();
    audit.write("result.json", JSON.stringify({ outcome: "completed", outcomeRef: outcome, prUrl }, null, 2));
    log(`wbs ${g8}: COMPLETED — ${outcome}`);
    return { outcome: "completed", detail: outcome };
  } catch (e) {
    if (e && e.reason) return await fail(e.reason);
    const msg = String(e.stack || e.message).slice(0, 400);
    log(`wbs ${g8}: unexpected error: ${msg}`);
    return await fail(`harness error: ${msg}`);
  }
}
