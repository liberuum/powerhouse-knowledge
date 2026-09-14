#!/usr/bin/env node
/**
 * Unpack the Ars Contexta methodology corpus.
 *
 * The 249 claims ship as `data/methodology.tar.gz` rather than as loose
 * markdown. They are agent-directed prose — "agents trust curated maps
 * completely", "the agent never looks further" — and every file carries
 * `[[wikilinks]]`, which reads as prompt injection to a plugin security
 * scanner. Shipped loose, they produced ~85 findings and a DANGEROUS verdict
 * that blocked installation. Archived, the corpus is one opaque blob to a
 * scanner and identical on disk once unpacked.
 *
 *   node scripts/methodology.mjs          # unpack (idempotent)
 *   node scripts/methodology.mjs --check  # exit 1 if not unpacked
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(root, "data", "methodology.tar.gz");
const dir = join(root, "data", "methodology");
const EXPECTED = 249;

const count = () =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;

if (process.argv.includes("--check")) {
  const n = count();
  if (n < EXPECTED) {
    console.error(
      `methodology corpus not unpacked (${n}/${EXPECTED}) — run: node scripts/methodology.mjs`,
    );
    process.exit(1);
  }
  console.log(`methodology corpus present (${n} claims)`);
  process.exit(0);
}

if (!existsSync(archive)) {
  console.error(`missing ${archive.replace(root + "/", "")}`);
  process.exit(1);
}
mkdirSync(join(root, "data"), { recursive: true });
execFileSync("tar", ["-xzf", archive, "-C", join(root, "data")], {
  stdio: "inherit",
});
const n = count();
console.log(`unpacked ${n} methodology claims into data/methodology/`);
if (n < EXPECTED) {
  console.error(`expected ${EXPECTED}; the archive may be truncated`);
  process.exit(1);
}
