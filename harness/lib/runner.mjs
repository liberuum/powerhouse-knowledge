/**
 * Headless OMP runner.
 *
 * Spawns `omp -p --mode json` (an NDJSON event stream), parses it line by
 * line, and resolves on the terminal `agent_end` event. The final assistant
 * message is the ground truth for attribution: its `model`/`usage` fields —
 * never the config — are what gets recorded in the vault.
 */

import { spawn } from "node:child_process";

export class RunnerError extends Error {}

/**
 * Run one headless OMP agent session.
 *
 * @param {object} p
 * @param {string} p.cwd            working directory (worktree, or repo root)
 * @param {string} p.model          model alias/selector, e.g. "@worker"
 * @param {string} p.prompt         the user message
 * @param {string} [p.systemPrompt] --append-system-prompt: text or a file path
 * @param {string[]} [p.hooks]      --hook files (e.g. the no-vault-writes hook)
 * @param {number} p.timeoutMin     --max-time in minutes (bounded runs only)
 * @param {(msg: string) => void} [p.log]
 *
 * @returns {Promise<{
 *   ok: boolean,            terminal agent_end AND clean exit
 *   terminal: boolean,      saw a terminal agent_end
 *   finalText: string,      text content of the final assistant message
 *   model: string|null,     actual model from the stream (attribution)
 *   provider: string|null,
 *   usage: object|null,     { input, output, totalTokens, … }
 *   exitCode: number|null,
 *   durationMs: number,
 *   stderrTail?: string
 * }}}
 *
 * A timeout (OMP's --max-time killing the session) or a non-terminal exit
 * resolves with ok: false — the caller treats it as a failed round.
 */
export function runAgent({ cwd, model, prompt, systemPrompt, hooks = [], timeoutMin, log = () => {} }) {
  const args = [
    "-p",
    "--no-session",
    "--no-title",
    "--mode",
    "json",
    "--cwd",
    cwd,
    "--model",
    model,
    "--approval-mode",
    "yolo",
    "--max-time",
    `${Math.max(1, Math.round(timeoutMin))}m`,
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  for (const h of hooks) args.push("--hook", h);
  args.push(prompt);

  log?.(`runner: omp start (model=${model}, cwd=${cwd}, max-time=${timeoutMin}m)`);

  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      log?.(`runner: omp done (ok=${result.ok}, ${Math.round(result.durationMs / 1000)}s, model=${result.model || "?"})`);
      resolve(result);
    };

    let child;
    try {
      child = spawn("omp", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, terminal: false, finalText: "", model: null, provider: null, usage: null, exitCode: null, durationMs: Date.now() - t0, error: e.message });
      return;
    }

    let buf = "";
    let terminalEvent = null;
    const stderrTail = [];

    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // partial or non-JSON line — ignore
        }
        if (ev.type === "agent_end") terminalEvent = ev;
      }
    });
    child.stderr.on("data", (d) => {
      stderrTail.push(d.toString("utf8"));
      if (stderrTail.length > 100) stderrTail.shift();
    });
    child.on("error", (e) => {
      finish({ ok: false, terminal: false, finalText: "", model: null, provider: null, usage: null, exitCode: null, durationMs: Date.now() - t0, error: `spawn failed: ${e.message}` });
    });
    child.on("close", (code) => {
      const isTerminal = terminalEvent != null && terminalEvent.isTerminal !== false;
      const messages = terminalEvent?.messages || [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const finalText = (lastAssistant?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      finish({
        ok: isTerminal && code === 0,
        terminal: isTerminal,
        finalText,
        model: lastAssistant?.model || null,
        provider: lastAssistant?.provider || null,
        usage: lastAssistant?.usage || null,
        exitCode: code,
        durationMs: Date.now() - t0,
        stderrTail: stderrTail.join("").trim().slice(-1000) || undefined,
      });
    });
  });
}

/**
 * Extract the last JSON object from free text (the reviewer's verdict is
 * specified as exactly one final JSON block). Forward balanced scan with
 * proper string/escape handling; returns the last span that parses as a
 * JSON object, or null.
 */
export function extractLastJson(text) {
  let last = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      last = JSON.parse(text.slice(i, end + 1));
    } catch {
      // not valid JSON — keep scanning
    }
    i = end;
  }
  return last;
}
