/**
 * Pipeline task processor — knowledge-processing tasks from the
 * `bai/pipeline-queue` singleton.
 *
 * The phase agents do the knowledge work (through the switchboard CLI, as
 * the pipeline skills prescribe); this module does every state transition:
 * claim, per-phase ADVANCE_PHASE with handoffs, the QA pass, and the held
 * final advance. The `verify` handoff is held back until the reviewer
 * approves, because the final ADVANCE_PHASE auto-completes the task —
 * holding it keeps the task IN_PROGRESS, the state in which FAIL_TASK is
 * legal. The only exits are DONE (final advance, verified) or FAILED
 * (FAIL_TASK with a reason) — a task is never left mid-phase at the end of
 * an attempt.
 *
 * Phase order (exact literals, AGENT.md):
 *   claim      → create  → reflect → reweave → verify
 *   enrichment → enrich  → reflect → reweave → verify
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runAgent, extractLastJson } from "./runner.mjs";
import { reviewPipeline } from "./review.mjs";
import { applyWithVerify, actions, getDocState, repoRoot } from "./vault.mjs";
import { nowIso } from "./state.mjs";
import { Audit } from "./wbs.mjs";

const WORKER_PIPELINE_PROMPT = join(repoRoot, "harness", "prompts", "worker-pipeline.md");
const VERIFY_SKILL = join(repoRoot, "skills", "verify", "SKILL.md");

const PHASES_BY_TYPE = {
  claim: ["create", "reflect", "reweave", "verify"],
  enrichment: ["enrich", "reflect", "reweave", "verify"],
};
const PHASE_SKILL = {
  create: "extract",
  enrich: "extract",
  reflect: "connect",
  reweave: "synthesize",
  verify: "verify",
};

function phasePrompt(phase, t) {
  const variant = phase === "enrich" ? " (enrichment variant)" : "";
  return (
    `Run the \`${phase}\` phase of pipeline task \`${t.id}\` (target \`${t.target}\`, ` +
    `source document \`${t.documentRef ?? "none"}\`). Follow \`skills/${PHASE_SKILL[phase]}/SKILL.md\` exactly${variant}. ` +
    `All vault writes through the switchboard CLI as the skill prescribes, and do not record anything in the ` +
    `pipeline queue yourself — the harness records the handoff. ` +
    `When the phase is complete, reply with a JSON handoff: ` +
    `\`{"workDone":"<2-4 sentence summary>","filesModified":["<doc-uuid>", …]}\`.`
  );
}

function repairPrompt(t, findings) {
  return (
    `Pipeline task \`${t.id}\` (target \`${t.target}\`) passed its phases, but the independent QA ` +
    `pass rejected the result. The findings (severity: issue → fix):\n\n` +
    findings.map((f) => `- [${f.severity}] ${f.issue} → ${f.fix}`).join("\n") +
    `\n\nRun \`skills/verify/SKILL.md\` on the task's documents and auto-repair exactly these findings ` +
    `(the skill's auto-repairs cover missing descriptions, provenance, note types, and topics). ` +
    `All vault writes through the switchboard CLI. When done, reply with a JSON handoff: ` +
    `\`{"workDone":"<2-4 sentence summary>","filesModified":["<doc-uuid>", …]}\`.`
  );
}

/**
 * Process one pipeline task end-to-end.
 *
 * @param {object} p
 * @param {string} p.pqId          the bai/pipeline-queue doc id
 * @param {object} p.task          { id, taskType, target, documentRef, currentPhase, handoffs }
 * @param {object} p.cfg           harness config
 * @param {object} p.state         State (with .dir)
 * @param {(msg:string)=>void} p.log
 */
export async function processPipelineTask({ pqId, task: t0, cfg, state, log }) {
  const t8 = t0.id.slice(0, 8);
  const audit = new Audit(join(state.dir, "logs", `${t8}-${nowIso().replace(/[:.]/g, "-")}`));
  const runRecords = [];
  const record = (entry) => {
    runRecords.push(entry);
    audit.write("runs.json", JSON.stringify(runRecords, null, 2));
  };

  const failTask = async (reason) => {
    log(`pipeline ${t8}: FAIL_TASK — ${reason}`);
    try {
      applyWithVerify(
        pqId,
        actions({ type: "FAIL_TASK", input: { taskId: t0.id, reason, updatedAt: nowIso() } }),
        { log },
      );
    } catch (e) {
      log(`pipeline ${t8}: FAIL_TASK write failed: ${e.message}`);
    }
    state.data.active = null;
    state.save();
    audit.write("result.json", JSON.stringify({ outcome: "failed", reason }, null, 2));
    return { outcome: "failed", detail: reason };
  };

  try {
    // 1. — Claim (or confirm an existing claim on resume).
    if (t0.status !== "IN_PROGRESS" || t0.assignedTo !== cfg.assignee) {
      log(`pipeline ${t8}: claiming task "${t0.target}" (type ${t0.taskType})`);
      applyWithVerify(
        pqId,
        actions({ type: "ASSIGN_TASK", input: { taskId: t0.id, assignedTo: cfg.assignee, updatedAt: nowIso() } }),
        { log },
      );
    }
    let t = getDocState(pqId).tasks.find((x) => x.id === t0.id);
    if (!t || t.assignedTo !== cfg.assignee || t.status !== "IN_PROGRESS") {
      log(`pipeline ${t8}: claim did not stick (status=${t?.status}, assignedTo=${t?.assignedTo}) — skipping`);
      return { outcome: "skipped", detail: "claim did not stick" };
    }

    const phases = PHASES_BY_TYPE[t.taskType];
    if (!phases) return await failTask(`unsupported taskType ${t.taskType} (expected claim or enrichment)`);
    // Crash recovery: a run that crashed during QA left the held verify
    // handoff in state — resume straight at QA, do not re-run the verify agent.
    const prior = state.data.active;
    const resumeQa = prior?.type === "pipeline" && prior.taskId === t.id && prior.phase === "qa" && prior.heldVerifyHandoff;
    const startIdx = t.currentPhase ? phases.indexOf(t.currentPhase) : 0;
    if (!resumeQa && startIdx < 0) return await failTask(`resumable currentPhase "${t.currentPhase}" not in ${phases.join(" → ")}`);

    // 2. — Phase machine (resume-safe: the task's handoffs mark done phases).
    let heldVerifyHandoff = resumeQa ? prior.heldVerifyHandoff : null;
    const filesModified = new Set((t.handoffs || []).flatMap((h) => h.filesModified || []));
    if (heldVerifyHandoff?.filesModified) for (const f of heldVerifyHandoff.filesModified) filesModified.add(f);
    if (resumeQa) log(`pipeline ${t8}: resuming at QA — verify handoff held from crashed run`);
    for (let pi = startIdx; !resumeQa && pi < phases.length; pi++) {
      const phase = phases[pi];
      let handoff = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        state.data.active = { type: "pipeline", taskId: t.id, pqId, phase, round: attempt, since: nowIso() };
        state.save();
        const run = await runAgent({
          cwd: repoRoot,
          model: cfg.workerModel,
          prompt: phasePrompt(phase, t),
          systemPrompt: WORKER_PIPELINE_PROMPT,
          timeoutMin: cfg.taskTimeoutMin,
          log,
        });
        record({ phase, attempt, model: run.model, usage: run.usage, ok: run.ok, durationMs: run.durationMs });
        if (!run.ok) {
          log(
            `pipeline ${t8}: phase ${phase} attempt ${attempt} failed (ok=${run.ok}, terminal=${run.terminal})` +
              (run.stderrTail ? ` — ${String(run.stderrTail).slice(0, 200)}` : ""),
          );
          continue;
        }
        const j = extractLastJson(run.finalText) || {};
        handoff = {
          id: randomUUID(),
          phase,
          workDone:
            typeof j.workDone === "string" && j.workDone.trim()
              ? j.workDone.trim()
              : (run.finalText || "").slice(-400).trim() || `phase ${phase} completed (no summary)`,
          filesModified: Array.isArray(j.filesModified) ? j.filesModified.filter((x) => typeof x === "string") : [],
          completedAt: nowIso(),
          completedBy: cfg.assignee,
        };
        break;
      }
      if (!handoff) return await failTask(`phase ${phase} failed after 2 attempts`);
      for (const f of handoff.filesModified) filesModified.add(f);
      log(`pipeline ${t8}: phase ${phase} done — ${handoff.workDone.slice(0, 160)}`);

      if (phase === "verify") {
        heldVerifyHandoff = handoff; // held until QA approves
        break;
      }
      applyWithVerify(
        pqId,
        actions({ type: "ADVANCE_PHASE", input: { taskId: t.id, handoff, updatedAt: nowIso() } }),
        { log },
      );
      t = getDocState(pqId).tasks.find((x) => x.id === t.id);
      if (!t || t.status !== "IN_PROGRESS" || t.currentPhase !== phases[pi + 1]) {
        return await failTask(`ADVANCE_PHASE(${phase}) did not stick (status=${t?.status}, currentPhase=${t?.currentPhase})`);
      }
    }
    if (!heldVerifyHandoff) {
      return await failTask("phase machine did not reach verify (no handoff to hold)");
    }

    // 3. — QA pass (the separate reviewer, before the task may become DONE).
    let verdict = null;
    for (let reviewRound = 1; reviewRound <= cfg.maxReviewRounds; reviewRound++) {
      state.data.active = { type: "pipeline", taskId: t.id, pqId, phase: "qa", round: reviewRound, heldVerifyHandoff, since: nowIso() };
      state.save();
      verdict = await reviewPipeline({
        cwd: repoRoot,
        brief: `Pipeline task ${t.id} (type ${t.taskType}): "${t.target}" — source document ${t.documentRef ?? "none"}.`,
        guidelines: [VERIFY_SKILL],
        documents: [...filesModified],
        model: cfg.reviewModel,
        timeoutMin: cfg.reviewTimeoutMin,
        log,
      });
      record({ phase: "qa", round: reviewRound, model: verdict.model, verdict: verdict.verdict });
      if (verdict.verdict === "APPROVE") break;
      log(`pipeline ${t8}: QA REJECT (round ${reviewRound}) — ${verdict.summary}`);
      if (reviewRound >= cfg.maxReviewRounds) break;
      const run = await runAgent({
        cwd: repoRoot,
        model: cfg.workerModel,
        prompt: repairPrompt(t, verdict.findings),
        systemPrompt: WORKER_PIPELINE_PROMPT,
        timeoutMin: cfg.taskTimeoutMin,
        log,
      });
      record({ phase: "repair", round: reviewRound, model: run.model, ok: run.ok });
      if (!run.ok) {
        return await failTask(`QA rejected after ${reviewRound} rounds and the repair run failed (ok=${run.ok})`);
      }
      const j = extractLastJson(run.finalText) || {};
      if (Array.isArray(j.filesModified)) for (const f of j.filesModified) filesModified.add(f);
    }
    if (verdict.verdict !== "APPROVE") {
      const top = verdict.findings
        .filter((f) => f.severity !== "minor")
        .slice(0, 3)
        .map((f) => `${f.severity}: ${f.issue}`)
        .join("; ");
      return await failTask(`QA rejected after ${cfg.maxReviewRounds} rounds: ${top || verdict.summary}`);
    }
    log(`pipeline ${t8}: QA APPROVED model=${verdict.model || "?"}`);

    // 4. — Complete: dispatch the held verify handoff (auto-completes the task).
    applyWithVerify(
      pqId,
      actions({ type: "ADVANCE_PHASE", input: { taskId: t.id, handoff: heldVerifyHandoff, updatedAt: nowIso() } }),
      { log },
    );
    const done = getDocState(pqId).tasks.find((x) => x.id === t.id);
    if (!done || done.status !== "DONE") {
      return await failTask(`final ADVANCE_PHASE did not complete the task (status=${done?.status})`);
    }

    // 5. — Optional health pass (informational; never fails the task).
    if (cfg.runHealth) {
      state.data.active = { type: "pipeline", taskId: t.id, pqId, phase: "health", round: 0, since: nowIso() };
      state.save();
      const h = await runAgent({
        cwd: repoRoot,
        model: cfg.workerModel,
        prompt:
          "Run `skills/health/SKILL.md`: compute the checks and write the health report as the skill prescribes. " +
          "Reply with one line: `HEALTH: PASS|WARN|FAIL — <worst check>`.",
        timeoutMin: cfg.reviewTimeoutMin,
        log,
      });
      record({ phase: "health", model: h.model, ok: h.ok });
      log(`pipeline ${t8}: health ${h.ok ? (h.finalText || "").trim().slice(0, 200) : "run failed (informational only)"}`);
    }

    state.data.active = null;
    state.save();
    audit.write("result.json", JSON.stringify({ outcome: "done", target: t.target, filesModified: [...filesModified] }, null, 2));
    log(`pipeline ${t8}: DONE — ${t.target}`);
    return { outcome: "done", detail: t.target };
  } catch (e) {
    log(`pipeline ${t8}: unexpected error: ${e.stack || e.message}`);
    return await failTask(`unexpected error: ${String(e.message).slice(0, 300)}`);
  }
}
