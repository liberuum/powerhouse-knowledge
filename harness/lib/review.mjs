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
import { join } from "node:path";
import { runAgent, extractLastJson } from "./runner.mjs";
import { repoRoot } from "./vault.mjs";

const REVIEWER_PROMPT = join(repoRoot, "harness", "prompts", "reviewer.md");
export const MAX_DIFF_LINES = 4000;

/** base→HEAD diff of a worktree, capped (the reviewer reads beyond directly). */
export function worktreeDiff({ worktree, base, maxLines = MAX_DIFF_LINES }) {
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", timeout: 60_000 });
  const diffStat = git(["diff", `${base}..HEAD`, "--stat"]);
  const all = git(["diff", `${base}..HEAD`]);
  const lines = all.split("\n");
  return {
    diffStat,
    diff: lines.slice(0, maxLines).join("\n"),
    truncated: lines.length > maxLines,
  };
}

export function buildReviewPrompt({ diffStat, diff, truncated, brief, guidelines }) {
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
    "## Full diff",
    "```diff",
    diff,
    truncated ? `\n… diff truncated at ${MAX_DIFF_LINES} lines — read the worktree directly for anything beyond` : "",
    "```",
    "",
    "Judge the work per your contract. End with the verdict JSON block.",
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
  const prompt = buildReviewPrompt({
    diffStat: diffResult.diffStat,
    diff: diffResult.diff,
    truncated: diffResult.truncated,
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
