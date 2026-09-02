#!/usr/bin/env node
/**
 * Generate agents/knowledge-agent.md from AGENT.md.
 *
 * AGENT.md is the single canonical instruction set for the agent. Claude Code
 * loads the agent from agents/knowledge-agent.md, which needs YAML frontmatter
 * (name, description, model, tools) that AGENT.md must not carry. So the agent
 * file is a build artifact: frontmatter + a provenance marker + AGENT.md
 * verbatim. Run this after every edit to AGENT.md; the pre-flight hook warns
 * when the marker's hash no longer matches.
 *
 *   node scripts/build-agent.mjs          # write
 *   node scripts/build-agent.mjs --check  # exit 1 if stale
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "AGENT.md");
const out = join(root, "agents", "knowledge-agent.md");

const FRONTMATTER = `---
name: knowledge-agent
description: AI agent for managing a Powerhouse Knowledge Vault — seeding sources, extracting atomic notes, connecting and verifying them via the Switchboard CLI.
model: opus
tools:
  - Bash
  - Read
  - Grep
  - Glob
  - WebSearch
  - WebFetch
  - Agent
---
`;

const body = readFileSync(src, "utf8");
const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
const marker = `<!-- GENERATED from AGENT.md (sha256:${hash}) by scripts/build-agent.mjs — edit AGENT.md, not this file -->\n\n`;
const rendered = FRONTMATTER + marker + body;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== rendered) {
    console.error("agents/knowledge-agent.md is stale — run: node scripts/build-agent.mjs");
    process.exit(1);
  }
  console.log("agents/knowledge-agent.md is up to date");
  process.exit(0);
}

writeFileSync(out, rendered);
console.log(`wrote agents/knowledge-agent.md from AGENT.md (${body.split("\n").length} lines, sha256:${hash})`);
