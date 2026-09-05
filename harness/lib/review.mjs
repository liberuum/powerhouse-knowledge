/**
 * Review & QA pass — one independent headless reviewer run per round.
 *
 * The reviewer did not write the work: fresh session, different system
 * prompt (prompts/reviewer.md), different model alias (config.reviewModel —
 * swappable to e.g. a hosted "fable" model without code changes), and
 * different input (the diff, not the working context). It returns exactly
 * one final JSON verdict; anything else is a REJECT — a reviewer that
 * cannot report is not an approval.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, extractLastJson } from "./runner.mjs";
import { repoRoot } from "./vault.mjs";

const REVIEWER_PROMPT = join(repoRoot, "harness", "prompts", "reviewer.md");
export const MAX_DIFF_LINES = 4000;
// The prompt is a single CLI argument; Linux caps one argument at 128 KiB
// (E2BIG). Keep the inline diff well under that, and hand the reviewer the
// full diff as a file for anything beyond.
export const MAX_DIFF_BYTES = 64 * 1024;

/** base→HEAD diff of a worktree, capped (the reviewer reads beyond directly). */
export function worktreeDiff({ worktree, base, maxLines = MAX_DIFF_LINES, maxBytes = MAX_DIFF_BYTES }) {
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", timeout: 60_000 });
  const diffStat = git(["diff", `${base}..HEAD`, "--stat"]);
  const all = git(["diff", `${base}..HEAD`]);
  let diff = all.split("\n").slice(0, maxLines).join("\n");
  let truncated = all.split("\n").length > maxLines;
  if (Buffer.byteLength(diff, "utf8") > maxBytes) {
    diff = diff.slice(0, Math.floor(diff.length * (maxBytes / Buffer.byteLength(diff, "utf8"))));
    truncated = true;
  }
  return { diffStat, diff, full: all, truncated };
}

export function buildReviewPrompt({ diffStat, diff, truncated, diffPath, brief, guidelines }) {
  return [
    "Review the work under review in the current directory (a git worktree; the diff is base→HEAD).",
    "",
    "## Goal brief",
    brief,
    "",
    "## Guidelines to check against",
    guidelines.join("\n"),
    "",
    "## Diff summary",
    diffStat,
    "",
    "## Diff",
    "```diff",
    diff,
    truncated && diffPath
      ? `\n… diff truncated — the full diff is at ${diffPath}; read it (and the worktree) directly for anything beyond`
      : "",
    "```",
    "",
    "Judge the work per your contract. End with the verdict JSON block.",
  ].join("\n");
}
/**
 * Review prompt for pipeline tasks: the "work" is a set of vault documents,
 * not a git diff. The reviewer reads each document through the CLI.
 */
export function buildPipelineReviewPrompt({ brief, guidelines, documents }) {
  return [
    "Review the work of a knowledge-pipeline task you did not perform. The work is a set of",
    "vault documents (knowledge notes, MoCs, tensions, links) written through the switchboard CLI.",
    "Read every document below with:",
    "",
    "    switchboard docs get <id> --state --format json",
    "",
    "and check its relationships with the CLI reads the verify skill prescribes.",
    "",
    "## Task brief",
    brief,
    "",
    "## Quality criteria to check against",
    ...guidelines,
    "",
    "Per-document checklist (from the verify skill): title; description ≤ 200 characters that adds",
    "information beyond the title; lowercase noteType; non-empty topics; provenance (sourceOrigin +",
    "sourceRef where applicable); ≥ 2 typed relationships each with a real reason (no bare edges);",
    "MoC membership with a CORE_IDEA edge where the note belongs to a topic; lifecycle walked to",
    "CANONICAL where the content warrants it. Also: the source document (if any) is closed out —",
    "status EXTRACTED, extracted claims recorded, DERIVED_FROM edges present.",
    "",
    "## Documents under review",
    documents.length ? documents.map((d) => `- ${d}`).join("\n") : "(none reported by the phase agents — that is a finding)",
    "",
    "Judge the work per your contract. `file` in findings is the document id (or `queue` for",
    "pipeline-queue hygiene). End with the verdict JSON block.",
  ].join("\n");
}

/**
 * Validate a verdict out of a review run.
 *
 * Contract: verdict APPROVE only with zero blocker/major findings. The
 * harness enforces this independently of the model: an APPROVE that still
 * carries blocker/major findings is downgraded to REJECT.
 */
export function parseVerdict(run) {
  const base = { model: run.model || null, usage: run.usage || null };
  if (!run.ok) {
    return {
      ...base,
      verdict: "REJECT",
      summary: `review run did not complete (terminal=${run.terminal}, exit=${run.exitCode})`,
      findings: [
        {
          severity: "blocker",
          file: null,
          line: null,
          issue: `reviewer run failed: ${run.error || run.stderrTail || "non-terminal or non-zero exit"}`,
          fix: "re-run the review round",
        },
      ],
    };
  }
  const j = extractLastJson(run.finalText);
  if (
    !j ||
    (j.verdict !== "APPROVE" && j.verdict !== "REJECT") ||
    typeof j.summary !== "string" ||
    !Array.isArray(j.findings)
  ) {
    return {
      ...base,
      verdict: "REJECT",
      summary: "reviewer produced no parseable verdict",
      findings: [
        {
          severity: "blocker",
          file: null,
          line: null,
          issue: `reviewer produced no parseable verdict: ${run.finalText.slice(-200)}`,
          fix: "the reviewer reply must end with the verdict JSON block",
        },
      ],
    };
  }
  const findings = j.findings.map((f) => ({
    severity: ["blocker", "major", "minor"].includes(f.severity) ? f.severity : "major",
    file: f.file ?? null,
    line: f.line ?? null,
    issue: String(f.issue ?? ""),
    fix: String(f.fix ?? ""),
  }));
  const hasBlocking = findings.some((f) => f.severity === "blocker" || f.severity === "major");
  const verdict = j.verdict === "APPROVE" && hasBlocking ? "REJECT" : j.verdict;
  return { ...base, verdict, summary: j.summary, findings };
}

/**
 * Run one review round.
 *
 * @param {object} p
 * @param {string} p.cwd          worktree (or repo root) containing the work
 * @param {string} p.brief        the goal brief
 * @param {string[]} p.guidelines guideline locations (paths or texts)
 * @param {object} p.diffResult   worktreeDiff() output
 * @param {string} p.model        config.reviewModel
 * @param {number} p.timeoutMin   config.reviewTimeoutMin
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{verdict, summary, findings, model, usage, run}>}
 */
export async function review({ cwd, brief, guidelines, diffResult, model, timeoutMin, log = () => {} }) {
  // The full (uncapped) diff goes to a temp file the reviewer can read;
  // only the capped diff goes inline (argv has a 128 KiB cap per argument).
  const diffPath = join(mkdtempSync(join(tmpdir(), "vault-harness-review-")), "full.diff");
  writeFileSync(diffPath, diffResult.full ?? diffResult.diff);
  const prompt = buildReviewPrompt({
    diffStat: diffResult.diffStat,
    diff: diffResult.diff,
    truncated: diffResult.truncated,
    diffPath,
    brief,
    guidelines,
  });
  const run = await runAgent({
    cwd,
    model,
    prompt,
    systemPrompt: REVIEWER_PROMPT,
    timeoutMin,
    log,
  });
  const v = parseVerdict(run);
  log?.(
    `review: verdict=${v.verdict} (${v.findings.filter((f) => f.severity === "blocker").length} blocker, ` +
      `${v.findings.filter((f) => f.severity === "major").length} major, ` +
      `${v.findings.filter((f) => f.severity === "minor").length} minor) model=${v.model || "?"}`,
  );
  return { ...v, run };
}

/**
 * Run one QA round over a pipeline task's vault documents.
 * Same verdict contract as review(); `file` in findings is a document id.
 *
 * @param {object} p
 * @param {string} p.cwd          repo root (skills/ + data/ reachable)
 * @param {string} p.brief        the task brief
 * @param {string[]} p.guidelines skill locations
 * @param {string[]} p.documents  doc ids under review
 * @param {string} p.model        config.reviewModel
 * @param {number} p.timeoutMin   config.reviewTimeoutMin
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{verdict, summary, findings, model, usage, run}>}
 */
export async function reviewPipeline({ cwd, brief, guidelines, documents, model, timeoutMin, log = () => {} }) {
  const prompt = buildPipelineReviewPrompt({ brief, guidelines, documents });
  const run = await runAgent({
    cwd,
    model,
    prompt,
    systemPrompt: REVIEWER_PROMPT,
    timeoutMin,
    log,
  });
  const v = parseVerdict(run);
  log?.(
    `review: verdict=${v.verdict} (${v.findings.filter((f) => f.severity === "blocker").length} blocker, ` +
      `${v.findings.filter((f) => f.severity === "major").length} major, ` +
      `${v.findings.filter((f) => f.severity === "minor").length} minor) model=${v.model || "?"}`,
  );
  return { ...v, run };
}
