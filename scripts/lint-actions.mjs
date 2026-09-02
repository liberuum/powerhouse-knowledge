#!/usr/bin/env node
/**
 * Pre-flight lint for a `docs apply` actions file against the bai/* rules
 * the reactor enforces silently.
 *
 * Why this exists: the reactor accepts a batch, rejects the invalid action
 * inside it, records it with an error, applies the rest, and reports the job
 * as successful. The agent only finds out by reading state back — after a
 * round trip. Everything here can be known before dispatch:
 *
 *   - knowledge-note description  > 200 chars       (DescriptionTooLongError)
 *     Counted the way the reducer counts: JavaScript string length, i.e.
 *     UTF-16 code units. An emoji is 2. Python's len() says 1 — which is how
 *     an agent "checks" 200 and still fails.
 *   - noteType not one of the ten lowercase values   (accepted, never matches the UI)
 *   - sourceOrigin / SourceStatus / HealthCategory / HealthStatus / taskType /
 *     sourceType / MocTier / ObservationCategory outside the enum  (rejected or unreachable)
 *   - literal backslash-escapes in any string        (double-encoded line breaks)
 *   - missing `scope` or `type`
 *
 * Exit 0 = clean. Exit 1 = findings, one per line with the JSON path.
 *
 *   node scripts/lint-actions.mjs /tmp/actions.json && switchboard docs apply <id> --file /tmp/actions.json
 *   node scripts/lint-actions.mjs -              # read the actions JSON from stdin
 *   node scripts/lint-actions.mjs --self-test
 */
import { readFileSync } from "node:fs";

/** The only hard length limit in any bai/* reducer (knowledge-note SET_DESCRIPTION). */
export const LIMITS = { "SET_DESCRIPTION.description": 200 };

export const ENUMS = {
  "SET_NOTE_TYPE.noteType": ["concept", "decision", "pattern", "observation", "procedure", "architecture", "bug-pattern", "integration", "workflow", "reference"],
  "SET_PROVENANCE.sourceOrigin": ["DERIVED", "IMPORT", "MANUAL", "SESSION_MINE"],
  "SET_SOURCE_STATUS.status": ["INBOX", "EXTRACTING", "EXTRACTED", "ARCHIVED"],
  "INGEST_SOURCE.sourceType": ["ARTICLE", "PAPER", "BOOK_CHAPTER", "TRANSCRIPT", "DOCUMENTATION", "CONVERSATION", "WEB_PAGE", "MANUAL_ENTRY"],
  "ADD_CHECK.category": ["SCHEMA_COMPLIANCE", "ORPHAN_DETECTION", "LINK_HEALTH", "DESCRIPTION_QUALITY", "THREE_SPACE_BOUNDARIES", "PROCESSING_THROUGHPUT", "STALE_NOTES", "MOC_COHERENCE"],
  "ADD_CHECK.status": ["PASS", "WARN", "FAIL"],
  "GENERATE_REPORT.overallStatus": ["PASS", "WARN", "FAIL"],
  "ADD_TASK.taskType": ["claim", "enrichment"],
  "CREATE_MOC.tier": ["HUB", "DOMAIN", "TOPIC"],
  "CREATE_OBSERVATION.category": ["METHODOLOGY", "PROCESS", "FRICTION", "SURPRISE", "QUALITY"],
  // knowledge-note metadata: the reducers whitelist field names and throw InvalidMetadataFieldError otherwise
  "SET_METADATA_FIELD.field": ["scope", "confidence", "severity", "editor", "modelId", "version", "filePath", "computes", "context", "decisionStatus", "model", "sourceType", "targetType", "relationType", "cardinality", "errorMessage", "rootCause", "correctPattern"],
  "SET_METADATA_LIST_FIELD.field": ["models", "hooksUsed", "dispatchTargets", "modules", "inputs", "outputs", "consumedBy", "alternatives", "consequences"],
};

/** JavaScript string length — what the reducers compare against. */
export const jsLength = (s) => s.length;

export function lintActions(actions) {
  const findings = [];
  if (!Array.isArray(actions)) return ["actions file must be a JSON array of actions"];
  actions.forEach((a, i) => {
    const at = `[${i}]`;
    if (!a || typeof a !== "object") return findings.push(`${at}: not an object`);
    if (typeof a.type !== "string") findings.push(`${at}.type: missing`);
    if (a.scope !== "global" && a.scope !== "local") findings.push(`${at}.scope: must be "global" (or "local")`);
    const input = a.input && typeof a.input === "object" ? a.input : {};
    for (const [key, max] of Object.entries(LIMITS)) {
      const [type, field] = key.split(".");
      if (a.type === type && typeof input[field] === "string" && jsLength(input[field]) > max) {
        findings.push(`${at}.input.${field}: ${jsLength(input[field])} chars > ${max} (reducer counts UTF-16 units; the reactor will reject this action and apply the rest)`);
      }
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      const [type, field] = key.split(".");
      if (a.type === type && input[field] !== undefined && !allowed.includes(input[field])) {
        findings.push(`${at}.input.${field}: "${input[field]}" is not one of ${allowed.join(" | ")}`);
      }
    }
    walkStrings(input, `${at}.input`, (s, path) => {
      if (/\\[ntr]/.test(s)) findings.push(`${path}: contains a literal backslash-escape — double-encoded line break (CLI ≥ 1.0.32 refuses this)`);
    });
  });
  return findings;
}

function walkStrings(v, path, fn) {
  if (typeof v === "string") return fn(v, path);
  if (Array.isArray(v)) return v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, fn));
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkStrings(x, `${path}.${k}`, fn);
}

function selfTest() {
  const ok = (name, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) process.exitCode = 1; };
  const desc199 = "x".repeat(199), emoji = "🚀";
  ok("200 plain chars pass", lintActions([{ type: "SET_DESCRIPTION", input: { description: "x".repeat(200), updatedAt: "t" }, scope: "global" }]).length === 0);
  ok("201 plain chars fail", lintActions([{ type: "SET_DESCRIPTION", input: { description: "x".repeat(201), updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("199 chars + one emoji = 201 UTF-16 units, fails (Python len would say 200)", lintActions([{ type: "SET_DESCRIPTION", input: { description: desc199 + emoji, updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("uppercase noteType fails", lintActions([{ type: "SET_NOTE_TYPE", input: { noteType: "CONCEPT", updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("lowercase noteType passes", lintActions([{ type: "SET_NOTE_TYPE", input: { noteType: "bug-pattern", updatedAt: "t" }, scope: "global" }]).length === 0);
  ok("bad sourceOrigin fails", lintActions([{ type: "SET_PROVENANCE", input: { author: "a", sourceOrigin: "BOGUS", createdAt: "t" }, scope: "global" }]).length === 1);
  ok("taskType SEED fails", lintActions([{ type: "ADD_TASK", input: { id: "1", taskType: "SEED", target: "t", createdAt: "t" }, scope: "global" }]).length === 1);
  ok("literal backslash-n fails", lintActions([{ type: "SET_CONTENT", input: { content: "a\\nb", updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("real newline passes", lintActions([{ type: "SET_CONTENT", input: { content: "a\nb", updatedAt: "t" }, scope: "global" }]).length === 0);
  ok("missing scope fails", lintActions([{ type: "SET_TITLE", input: { title: "t", updatedAt: "t" } }]).length === 1);
  ok("title has no limit", lintActions([{ type: "SET_TITLE", input: { title: "x".repeat(1000), updatedAt: "t" }, scope: "global" }]).length === 0);
  ok("unknown metadata field fails", lintActions([{ type: "SET_METADATA_FIELD", input: { field: "priority", value: "high", updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("list field written with the scalar op fails", lintActions([{ type: "SET_METADATA_FIELD", input: { field: "models", value: "x", updatedAt: "t" }, scope: "global" }]).length === 1);
  ok("valid list field passes", lintActions([{ type: "SET_METADATA_LIST_FIELD", input: { field: "alternatives", values: ["a", "b"], updatedAt: "t" }, scope: "global" }]).length === 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.argv.includes("--self-test")) { selfTest(); }
  else {
    const file = process.argv[2];
    if (!file) { console.error("usage: node scripts/lint-actions.mjs <actions.json> | --self-test"); process.exit(2); }
    let actions;
    try { actions = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")); } catch (e) { console.error(`${file}: not valid JSON — ${e.message}`); process.exit(2); }
    const findings = lintActions(actions);
    if (findings.length) { console.error(`${findings.length} finding(s) in ${file}:`); for (const f of findings) console.error("  " + f); process.exit(1); }
    console.log(`${file}: ${actions.length} action(s) clean`);
  }
}
