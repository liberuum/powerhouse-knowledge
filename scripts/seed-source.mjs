#!/usr/bin/env node
/**
 * Seed a local file as a bai/source document into the Knowledge Vault.
 *
 * Usage:
 *   node seed-source.mjs --drive-id <UUID> --sources-folder-id <UUID> --file <path> [--endpoint <URL>]
 */

import fs from "fs";
import path from "path";

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const ENDPOINT = getArg("--endpoint", "https://switchboard-dev.powerhouse.xyz/graphql/r");
const DRIVE_ID = getArg("--drive-id", null);
const SOURCES_FOLDER_ID = getArg("--sources-folder-id", null);
const FILE_PATH = getArg("--file", null);

if (!DRIVE_ID || !SOURCES_FOLDER_ID || !FILE_PATH) {
  console.error("Usage: node seed-source.mjs --drive-id <UUID> --sources-folder-id <UUID> --file <path>");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

function now() {
  return new Date().toISOString();
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

  // Find PipelineQueue
  const driveRes = await gql(
    `{ document(identifier: "${DRIVE_ID}") { document { state } } }`,
  );
  const nodes = driveRes.document.document.state.global.nodes;
  const queueNode = nodes.find((n) => n.documentType === "bai/pipeline-queue");

  // 1. Create source document
  console.log("1. Creating source document...");
  const r1 = await gql(
    `mutation { createEmptyDocument(documentType: "bai/source") { id } }`,
  );
  const sourceId = r1.createEmptyDocument.id;
  console.log(`   ID: ${sourceId}`);

  // 2. Add to /sources/ folder
  console.log("2. Adding to /sources/ folder...");
  await gql(
    `mutation($id: String!, $actions: [JSONObject!]!) { mutateDocument(documentIdentifier: $id, actions: $actions) { id } }`,
    {
      id: DRIVE_ID,
      actions: [
        {
          type: "ADD_FILE",
          input: {
            id: sourceId,
            name: title,
            documentType: "bai/source",
            parentFolder: SOURCES_FOLDER_ID,
          },
          scope: "global",
          timestampUtcMs: now(),
        },
      ],
    },
  );

  // 3. Ingest source content
  console.log("3. Ingesting source content...");
  await gql(
    `mutation($id: String!, $actions: [JSONObject!]!) { mutateDocument(documentIdentifier: $id, actions: $actions) { id } }`,
    {
      id: sourceId,
      actions: [
        {
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
          scope: "global",
          timestampUtcMs: now(),
        },
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
          {
            type: "ADD_TASK",
            input: {
              id: crypto.randomUUID(),
              taskType: "claim",
              target: title,
              documentRef: sourceId,
              createdAt: now(),
            },
            scope: "global",
            timestampUtcMs: now(),
          },
        ],
      },
    );
  }

  // 5. Verify
  const verifyRes = await gql(
    `{ document(identifier: "${sourceId}") { document { state } } }`,
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
