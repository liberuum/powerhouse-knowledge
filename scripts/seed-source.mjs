#!/usr/bin/env node
/**
 * Seed a local file as a bai/source document into the Knowledge Vault.
 *
 * Usage:
 *   node seed-source.mjs --endpoint <switchboard-/graphql/r-URL> --drive-id <UUID> --sources-folder-id <UUID> --file <path>
 *
 * There is no default endpoint on purpose: the user chooses which vault to
 * write to. Ask them for their Switchboard URL if you don't have it.
 */

import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { authHeaders } from "./lib/bearer.mjs";

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const ENDPOINT = getArg("--endpoint", null);
const DRIVE_ID = getArg("--drive-id", null);
const SOURCES_FOLDER_ID = getArg("--sources-folder-id", null);
const FILE_PATH = getArg("--file", null);

if (!ENDPOINT || !DRIVE_ID || !SOURCES_FOLDER_ID || !FILE_PATH) {
  console.error("Usage: node seed-source.mjs --endpoint <switchboard-/graphql/r-URL> --drive-id <UUID> --sources-folder-id <UUID> --file <path>");
  console.error("No default endpoint: pass the Switchboard the user chose (e.g. http://localhost:4001/graphql/r).");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

function now() {
  return new Date().toISOString();
}

// Every action dispatched through mutateDocument MUST carry a unique `id`
// plus `timestampUtcMs` — an action persisted without `id` permanently
// breaks every browser client's sync channel (pollSyncEnvelopes -> non-
// nullable Action.id). Copied verbatim from scripts/sync-skills.mjs:68-70.
function envelope(action) {
  return { id: randomUUID(), timestampUtcMs: now(), scope: "global", ...action };
}

async function main() {
  const content = fs.readFileSync(FILE_PATH, "utf-8");
  const fileName = path.basename(FILE_PATH, path.extname(FILE_PATH));
  const ext = path.extname(FILE_PATH).toLowerCase();

  const sourceType =
    ext === ".md" ? "DOCUMENTATION" :
    ext === ".txt" ? "MANUAL_ENTRY" :
    ext === ".json" ? "DOCUMENTATION" :
    "WEB_PAGE";

  // Extract title from first heading or filename
  const headingMatch = content.match(/^#\s+(.+)$/m);
  const title = headingMatch ? headingMatch[1] : fileName;

  // Generate description from first paragraph
  const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const description = lines[0]?.substring(0, 200) || title;

  console.log(`File: ${FILE_PATH}`);
  console.log(`Title: ${title}`);
  console.log(`Type: ${sourceType}`);
  console.log(`Content: ${content.length} chars`);
  console.log();

  // Resolve the drive identifier to its canonical UUID. Reactor ≥ 6.2.3-dev.35
  // resolves a slug in parentIdOrSlug itself, but the UUID is also what the
  // drive's MOVE_NODE and the queue's documentRef need, and on an older
  // Switchboard a slug there makes the create hang forever.
  const driveIdRes = await gql(
    `query($id: String!){ document(idOrSlug: $id){ document { id } } }`,
    { id: DRIVE_ID },
  );
  const driveId = driveIdRes.document.document.id;

  // Find PipelineQueue
  const driveRes = await gql(
    `query($id: String!){ document(idOrSlug: $id){ document { state } } }`,
    { id: driveId },
  );
  const nodes = driveRes.document.document.state.global.nodes;
  const queueNode = nodes.find((n) => n.documentType === "bai/pipeline-queue");

  // 1. Create source document via the namespaced create (Source.createDocument)
  // — this resolves drive containment correctly server-side, so the manual
  // createEmptyDocument + ADD_FILE dance is unnecessary.
  console.log("1. Creating source document...");
  const r1 = await gql(
    `mutation($name: String!, $p: String) { Source { createDocument(name: $name, parentIdOrSlug: $p) { id } } }`,
    { name: title, p: driveId },
  );
  const sourceId = r1.Source.createDocument.id;
  console.log(`   ID: ${sourceId}`);

  // 2. Move into /sources/ folder
  console.log("2. Moving into sources folder...");
  await gql(
    `mutation($docId: String!, $input: DocumentDrive_MoveNodeInput!){ DocumentDrive { moveNode(documentIdOrSlug: $docId, input: $input) { id } } }`,
    { docId: driveId, input: { srcFolder: sourceId, targetParentFolder: SOURCES_FOLDER_ID } },
  );

  // 3. Ingest source content
  console.log("3. Ingesting source content...");
  await gql(
    `mutation($id: String!, $actions: [JSONObject!]!) { mutateDocument(documentIdentifier: $id, actions: $actions) { id } }`,
    {
      id: sourceId,
      actions: [
        envelope({
          type: "INGEST_SOURCE",
          input: {
            title,
            content,
            sourceType,
            description,
            author: "builder-profile project",
            url: `file://${path.resolve(FILE_PATH)}`,
            createdAt: now(),
            createdBy: "knowledge-agent",
          },
        }),
      ],
    },
  );

  // 4. Queue for processing
  if (queueNode) {
    console.log("4. Adding to pipeline queue...");
    await gql(
      `mutation($id: String!, $actions: [JSONObject!]!) { mutateDocument(documentIdentifier: $id, actions: $actions) { id } }`,
      {
        id: queueNode.id,
        actions: [
          envelope({
            type: "ADD_TASK",
            input: {
              id: randomUUID(),
              taskType: "claim",
              target: title,
              documentRef: sourceId,
              createdAt: now(),
            },
          }),
        ],
      },
    );
  }

  // 5. Verify
  const verifyRes = await gql(
    `{ document(idOrSlug: "${sourceId}") { document { state } } }`,
  );
  const state = verifyRes.document.document.state.global;

  console.log("\n=== SOURCE SEEDED ===");
  console.log(`ID:      ${sourceId}`);
  console.log(`Title:   ${state.title}`);
  console.log(`Type:    ${state.sourceType}`);
  console.log(`Status:  ${state.status}`);
  console.log(`Content: ${state.content?.length || 0} chars`);
  console.log(`Queue:   ${queueNode ? "task added" : "no queue found"}`);
  console.log(
    "\nNext: run /powerhouse-knowledge:extract or /powerhouse-knowledge:pipeline to process",
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
