/**
 * Hard block for code-worker runs: the worker implements code in the
 * worktree; it does not touch the vault. Vault bookkeeping is the
 * harness's job, made through lib/vault.mjs (lint → signed apply →
 * read-back verified).
 *
 * Blocks switchboard write subcommands on the bash tool:
 *   docs    apply | mutate | create | delete | rename | move |
 *           add-to | remove-from | link | unlink | annotate
 *   drives  create | delete | fix
 *   folders (any write verb)
 *   (top-level) import | migrate
 * Reads (docs get/tree/list, query, ops, …) are allowed. Fails open on its
 * own errors: a hook bug must not freeze the worker — the harness's
 * read-backs still catch bad vault state.
 *
 * Loaded via `omp --hook` (see lib/runner.mjs).
 */

const GROUP_VERBS = new Set([
  "apply",
  "mutate",
  "create",
  "delete",
  "rename",
  "move",
  "add-to",
  "remove-from",
  "link",
  "unlink",
  "annotate",
  "fix",
]);
const TOP_VERBS = new Set(["import", "migrate"]);

/** True if any command segment invokes a switchboard write subcommand. */
export function isVaultWrite(cmd) {
  for (const seg of String(cmd).split(/;|\|\||&&|\n|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = toks.findIndex((t) => t === "switchboard" || t.endsWith("/switchboard"));
    if (i === -1) continue;
    i += 1;
    if (TOP_VERBS.has(toks[i])) return true;
    const verb = toks[i + 1];
    if (toks[i] && GROUP_VERBS.has(verb)) return true;
  }
  return false;
}

export default function (pi) {
  pi.on("tool_call", async (event) => {
    try {
      if (event.toolName !== "bash") return;
      const cmd = String(event.input?.command ?? "");
      if (isVaultWrite(cmd)) {
        return {
          block: true,
          reason:
            "vault writes are made by the harness only — implement the goal in the worktree and stop; status/notes/outcomes are recorded by the orchestrator",
        };
      }
    } catch {
      // fail-open by design (see header)
    }
  });
}
