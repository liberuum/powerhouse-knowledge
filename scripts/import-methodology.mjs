#!/usr/bin/env node
/**
 * Import Ars Contexta methodology (249 research claims) into a Knowledge Vault drive
 * via the Switchboard GraphQL API.
 *
 * Three-pass approach to avoid drive corruption:
 *   Pass 1: Create all documents standalone + populate with CREATE_CLAIM
 *   Pass 1b: Batch ADD_FILE actions on the drive (groups of 10, with delays)
 *   Pass 2: Resolve cross-claim connections
 *
 * Usage:
 *   node import-methodology.mjs --drive-id <UUID> --research-folder-id <UUID> [--endpoint <URL>] [--dry-run] [--limit N] [--batch-size N]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METHODOLOGY_DIR = path.resolve(__dirname, "..", "data", "methodology");

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const ENDPOINT = getArg("--endpoint", "https://switchboard-dev.powerhouse.xyz/graphql/r");
const DRIVE_ID = getArg("--drive-id", null);
const RESEARCH_FOLDER_ID = getArg("--research-folder-id", null);
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = parseInt(getArg("--limit", "Infinity"), 10) || Infinity;
const BATCH_SIZE = parseInt(getArg("--batch-size", "10"), 10);

if (!DRIVE_ID || !RESEARCH_FOLDER_ID) {
  console.error(
    "Usage: node import-methodology.mjs --drive-id <UUID> --research-folder-id <UUID> [--endpoint <URL>] [--dry-run] [--limit N] [--batch-size N]",
  );
  process.exit(1);
}

// --- Helpers ---

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const rawMeta = match[1];
  const body = match[2].trim();
  const meta = {};

  for (const line of rawMeta.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) {
      const [, key, val] = m;
      if (val.startsWith("[")) {
        meta[key] = val
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/^\[\[|\]\]$/g, ""))
          .filter(Boolean);
      } else {
        meta[key] = val.replace(/^\[\[|\]\]$/g, "").replace(/^["']|["']$/g, "");
      }
    }
  }

  return { meta, body };
}

function extractRelevantNotes(body) {
  const section = body.match(/Relevant Notes:\n([\s\S]*?)(?:\n\nTopics:|\n---|\n$|$)/);
  if (!section) return [];
  const links = [];
  for (const line of section[1].split("\n")) {
    const m = line.match(/- \[\[(.+?)\]\]\s*[—–-]\s*(.+)/);
    if (m) links.push({ title: m[1].trim(), contextPhrase: m[2].trim() });
  }
  return links;
}

function extractContentBody(body) {
  let content = body.replace(/^#\s+.+\n\n?/, "");
  const rnIdx = content.indexOf("\nRelevant Notes:");
  if (rnIdx !== -1) content = content.substring(0, rnIdx);
  const sepIdx = content.indexOf("\n---\n---");
  if (sepIdx !== -1) content = content.substring(0, sepIdx);
  return content.trim();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function now() {
  return new Date().toISOString();
}

// --- Main ---

async function main() {
  const files = fs
    .readdirSync(METHODOLOGY_DIR)
    .filter((f) => f.endsWith(".md"))
    .slice(0, LIMIT);

  console.log(`Found ${files.length} methodology files`);
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Drive: ${DRIVE_ID}`);
  console.log(`Research folder: ${RESEARCH_FOLDER_ID}`);
  console.log(`Batch size for ADD_FILE: ${BATCH_SIZE}`);
  if (DRY_RUN) console.log("DRY RUN — no documents will be created");
  console.log();

  // ========================================
  // Pass 1: Create documents + populate
  // (NO drive mutations here — standalone docs only)
  // ========================================
  console.log("=== Pass 1: Create and populate documents ===");
  const titleToId = new Map();
  const titleToConnections = new Map();
  const createdDocs = []; // { docId, title } for Pass 1b
  let created = 0;
  let failed = 0;

  for (const file of files) {
    const title = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(METHODOLOGY_DIR, file), "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const content = extractContentBody(body);
    const connections = extractRelevantNotes(body);
    titleToConnections.set(title, connections);

    const description = meta.description || "";
    const kind = meta.kind || "research";
    const methodology = Array.isArray(meta.methodology) ? meta.methodology : meta.methodology ? [meta.methodology] : [];
    const sources = Array.isArray(meta.source) ? meta.source : meta.source ? [meta.source] : [];
    const topics = Array.isArray(meta.topics) ? meta.topics : meta.topics ? [meta.topics] : [];

    if (DRY_RUN) {
      console.log(`  [dry] ${title} (${connections.length} connections, ${topics.length} topics)`);
      titleToId.set(title, "dry-run-id");
      createdDocs.push({ docId: "dry-run-id", title });
      continue;
    }

    try {
      // Create empty document (standalone — no parent, no drive mutation)
      const createData = await gql(
        `mutation($docType: String!) {
          createEmptyDocument(documentType: $docType) { id }
        }`,
        { docType: "bai/research-claim" },
      );
      const docId = createData.createEmptyDocument.id;

      // Populate claim immediately
      await gql(
        `mutation($id: String!, $actions: [JSONObject!]!) {
          mutateDocument(documentIdentifier: $id, actions: $actions) { id }
        }`,
        {
          id: docId,
          actions: [
            {
              type: "CREATE_CLAIM",
              input: { title, description, content, kind, methodology, sources, topics },
              scope: "global",
              timestampUtcMs: now(),
            },
          ],
        },
      );

      titleToId.set(title, docId);
      createdDocs.push({ docId, title });
      created++;
      if (created % 10 === 0) console.log(`  Created ${created}/${files.length}...`);

      // Small delay between creates
      await delay(50);
    } catch (err) {
      console.error(`  FAIL: ${title}: ${err.message.substring(0, 200)}`);
      failed++;
    }
  }

  console.log(`\nPass 1 complete: ${created} created, ${failed} failed\n`);

  // ========================================
  // Pass 1b: Batch ADD_FILE on the drive
  // (groups of BATCH_SIZE with 500ms between batches)
  // ========================================
  console.log(`=== Pass 1b: Add files to drive in batches of ${BATCH_SIZE} ===`);

  if (!DRY_RUN) {
    let addedToDrive = 0;
    for (let i = 0; i < createdDocs.length; i += BATCH_SIZE) {
      const batch = createdDocs.slice(i, i + BATCH_SIZE);
      const actions = batch.map((doc) => ({
        type: "ADD_FILE",
        input: {
          id: doc.docId,
          name: doc.title,
          documentType: "bai/research-claim",
          parentFolder: RESEARCH_FOLDER_ID,
        },
        scope: "global",
        timestampUtcMs: now(),
      }));

      try {
        await gql(
          `mutation($id: String!, $actions: [JSONObject!]!) {
            mutateDocument(documentIdentifier: $id, actions: $actions) { id }
          }`,
          { id: DRIVE_ID, actions },
        );
        addedToDrive += batch.length;
        console.log(`  Added batch ${Math.floor(i / BATCH_SIZE) + 1}: ${addedToDrive}/${createdDocs.length} files in drive`);
      } catch (err) {
        console.error(`  FAIL batch at index ${i}: ${err.message.substring(0, 300)}`);
      }

      // Wait between drive mutations to avoid corruption
      await delay(500);
    }
    console.log(`\nPass 1b complete: ${addedToDrive} files added to drive\n`);
  } else {
    console.log(`  [dry] Would add ${createdDocs.length} files in ${Math.ceil(createdDocs.length / BATCH_SIZE)} batches\n`);
  }

  // ========================================
  // Pass 2: Resolve connections
  // ========================================
  console.log("=== Pass 2: Resolve connections ===");

  if (DRY_RUN) {
    let totalConns = 0;
    for (const [, conns] of titleToConnections) totalConns += conns.length;
    console.log(`  [dry] Would create ${totalConns} connections`);
    return;
  }

  let resolved = 0;
  let unresolved = 0;

  for (const [title, connections] of titleToConnections) {
    const sourceId = titleToId.get(title);
    if (!sourceId) continue;

    const actions = [];
    for (const conn of connections) {
      const targetId = titleToId.get(conn.title);
      if (targetId) {
        actions.push({
          type: "ADD_RESEARCH_CONNECTION",
          input: {
            id: crypto.randomUUID(),
            targetRef: targetId,
            contextPhrase: conn.contextPhrase,
          },
          scope: "global",
          timestampUtcMs: now(),
        });
        resolved++;
      } else {
        unresolved++;
      }
    }

    if (actions.length > 0) {
      try {
        await gql(
          `mutation($id: String!, $actions: [JSONObject!]!) {
            mutateDocument(documentIdentifier: $id, actions: $actions) { id }
          }`,
          { id: sourceId, actions },
        );
      } catch (err) {
        console.error(`  FAIL connections for ${title}: ${err.message.substring(0, 200)}`);
      }
      await delay(50);
    }
  }

  console.log(`\nPass 2 complete: ${resolved} connections resolved, ${unresolved} unresolved`);
  console.log(`\n=== METHODOLOGY IMPORT COMPLETE ===`);
  console.log(`Claims: ${created}`);
  console.log(`Connections: ${resolved} resolved, ${unresolved} unresolved`);
  console.log(`Drive mutations: ${Math.ceil(createdDocs.length / BATCH_SIZE)} batches (instead of ${createdDocs.length} individual)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
