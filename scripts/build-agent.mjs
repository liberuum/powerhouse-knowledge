#!/usr/bin/env node
/**
 * Generate every host-specific agent artifact from AGENT.md.
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
// AGENTS.md is the cross-tool convention (Linux Foundation AAIF): Codex,
// Cursor, Gemini CLI, Zed, Windsurf, OpenCode and others read it from the
// repository root. Claude Code is the exception and reads its own frontmatter
// file, which is why both are generated from the same source.
const agentsMd = join(root, "AGENTS.md");

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
const marker = (file) =>
  `<!-- GENERATED from AGENT.md (sha256:${hash}) by scripts/build-agent.mjs — edit AGENT.md, not ${file} -->\n\n`;

// Claude Code: needs YAML frontmatter AGENT.md must not carry.
const renderedAgent = FRONTMATTER + marker("this file") + body;

// Everyone else: plain markdown, no frontmatter, plus a line saying what this
// repository is — an AGENTS.md reader arrives with no other context.
const AGENTS_PREFIX = `# Powerhouse Knowledge Vault — agent instructions

This repository is an **agent**, not an application: it is the instruction set
and skills for working with a Powerhouse Knowledge Vault. There is nothing to
build or test here. Read the instructions below, then read the skill you need
from \`skills/<name>/SKILL.md\`.

`;
const renderedAgents = AGENTS_PREFIX + marker("this file") + body;

const targets = [
  [out, renderedAgent],
  [agentsMd, renderedAgents],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [file, want] of targets) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== want) {
      console.error(`${file.replace(root + "/", "")} is stale`);
      stale = true;
    }
  }
  if (stale) {
    console.error("run: node scripts/build-agent.mjs");
    process.exit(1);
  }
  console.log("agents/knowledge-agent.md and AGENTS.md are up to date");
  process.exit(0);
}

for (const [file, want] of targets) {
  writeFileSync(file, want);
  console.log(
    `wrote ${file.replace(root + "/", "")} (${want.split("\n").length} lines, sha256:${hash})`,
  );
}
