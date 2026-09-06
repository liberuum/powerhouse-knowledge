#!/usr/bin/env node
/**
 * One-off: seed the Treasury Management test fixtures in the vault —
 * scope of work + envelope (TM) + WBS goal tree + deliverables.
 * All writes go through the harness's applyWithVerify (lint → signed
 * apply → read-back + op-log check).
 */
import { randomUUID } from "node:crypto";
import { detectDrive, tree, getDocState, createDoc, applyWithVerify, actions } from "../harness/lib/vault.mjs";

const log = (m) => console.log(`[seed] ${m}`);

const drive = detectDrive();
log(`drive: ${drive.slug}`);
const nodes = tree(drive.slug);
const projectsFolder = nodes.find((n) => n.kind === "folder" && n.name === "projects" && n.parentFolder == null);
if (!projectsFolder) throw new Error("no /projects/ folder");

// idempotency guard
const existingScope = nodes.find((n) => n.documentType === "powerhouse/scopeofwork" && n.name === "Treasury Management");
if (existingScope) {
  const s = getDocState(existingScope.id);
  const env = (s.projects || []).find((p) => p.code === "TM");
  if (env?.wbsRef) {
    log(`fixtures already exist (scope ${existingScope.id.slice(0, 8)}, wbs ${env.wbsRef.slice(0, 8)}) — nothing to do`);
    process.exit(0);
  }
  throw new Error(`partial fixtures found (scope ${existingScope.id}) — inspect and re-run manually`);
}

const agentId = randomUUID();
const envId = randomUUID();

// 1. scope
const scopeId = createDoc("powerhouse/scopeofwork", "Treasury Management", { driveSlug: drive.slug, parentFolder: projectsFolder.id });
log(`scope created: ${scopeId}`);
applyWithVerify(
  scopeId,
  actions(
    {
      type: "EDIT_SCOPE_OF_WORK",
      input: {
        title: "Treasury Management",
        description: "Build the Treasury Management Reactor Package: domain core (money, positions, cash flows, exposure, limits), Powerhouse document models, and daily treasury reporting. Staged in the linked WBS.",
        status: "IN_PROGRESS",
      },
    },
    { type: "ADD_AGENT", input: { id: agentId, name: "Vault Harness", description: "Autonomous vault harness (worker/reviewer)" } },
  ),
  { log },
);

// 2. envelope
applyWithVerify(
  scopeId,
  actions({
    type: "ADD_PROJECT",
    input: {
      id: envId,
      code: "TM",
      title: "Treasury Management Package",
      slug: "treasury-management-package",
      projectOwner: agentId,
      abstract:
        "The treasury-management Reactor Package (powerhouse-inc/treasury-management): integer-minor-unit money, position valuation, cash-flow projection and liquidity alerts, counterparty exposure and limits, treasury/position + counterparty + exposure-report document models, and a daily treasury report. Each WBS stage is independently gated (lint + tsc + tests) and reviewed before delivery as a PR.",
      budgetType: "OPEX",
      currency: "USD",
    },
  }),
  { log },
);

// 3. WBS
const wbsId = createDoc("bai/wbs", "Treasury Management — WBS", { driveSlug: drive.slug, parentFolder: projectsFolder.id });
log(`wbs created: ${wbsId}`);
applyWithVerify(scopeId, actions({ type: "LINK_PROJECT_WBS", input: { projectId: envId, wbsRef: wbsId } }), { log });

const goals = [
  { id: "tm-t0", description: "Stage 0 — domain core foundations (money, positions)" },
  {
    id: "tm-t0-a",
    parentId: "tm-t0",
    description:
      "Add src/core/money.ts: a Money value type backed by integer minor units (cents) plus a currency code — constructors, add, subtract, compare, negate, and convert(money, rate) rounding half away from zero to the minor unit; reject mixed-currency arithmetic. Cover with vitest unit tests (rounding, signs, mixed-currency rejection).",
  },
  {
    id: "tm-t0-b",
    parentId: "tm-t0",
    dependencies: ["tm-t0-a"],
    description:
      "Add src/core/position.ts: a Position type { instrumentId, counterpartyId, currency, quantity, unitPrice } where quantity and unitPrice are Money, plus markToMarket(position): Money = quantity × unitPrice (unit-price arithmetic in minor units, single rounding). Cover with vitest unit tests including negative (short) positions and rounding cases.",
  },
  { id: "tm-t1", description: "Stage 1 — cash & liquidity (projection, alerts)" },
  {
    id: "tm-t1-a",
    parentId: "tm-t1",
    dependencies: ["tm-t0-a"],
    description:
      "Add src/core/cashflow.ts: projectCashflows(openingBalance: Money, flows: { date: string, amount: Money }[]) → an array of { date, balance: Money } sorted by date (ISO yyyy-mm-dd), applying each flow to the running balance; tolerate out-of-order input and duplicate dates. Cover with vitest unit tests (empty flows, out-of-order input, same-day flows).",
  },
  {
    id: "tm-t1-b",
    parentId: "tm-t1",
    dependencies: ["tm-t1-a"],
    description:
      "Add src/core/liquidity.ts: liquidityAlerts(projections: { date, balance: Money }[], threshold: Money) → the list of { date, balance } entries whose balance is strictly below the threshold, in projection order. Cover with vitest unit tests (no alerts, at-threshold excluded, below-threshold included).",
  },
  { id: "tm-t2", description: "Stage 2 — counterparty & exposure (aggregation, limits)" },
  {
    id: "tm-t2-a",
    parentId: "tm-t2",
    dependencies: ["tm-t0-b"],
    description:
      "Add src/core/exposure.ts: aggregateExposure(positions: Position[]) → { byCounterparty: Record<string, Money>, total: Money } where each counterparty's exposure is the net mark-to-market of its positions (longs minus shorts) and total is the sum of absolute counterparty exposures. Cover with vitest unit tests (offsetting positions, single counterparty, empty input).",
  },
  {
    id: "tm-t2-b",
    parentId: "tm-t2",
    dependencies: ["tm-t2-a"],
    description:
      "Add src/core/limits.ts: checkLimits(exposure: { byCounterparty: Record<string, Money>, total: Money }, limits: { counterparties: Record<string, Money>, total: Money }) → an array of breaches { scope: \"counterparty\" | \"total\", counterpartyId?: string, amount: Money, limit: Money, exceededBy: Money } for every limit whose absolute exposure is strictly above the limit. Cover with vitest unit tests (within limit, at limit, counterparty + total breaches).",
  },
  { id: "tm-t3", description: "Stage 3 — document models (position, counterparty, exposure report)" },
  {
    id: "tm-t3-a",
    parentId: "tm-t3",
    dependencies: ["tm-t0-b"],
    description:
      "Implement the treasury/position document model (GraphQL schema + TypeScript reducer under document-models/) following this repo's document-model conventions, and register it in document-models/document-models.ts so `npm run lint`, `npm run tsc` and `npm test` pass.",
  },
  {
    id: "tm-t3-b",
    parentId: "tm-t3",
    dependencies: ["tm-t2-a"],
    description:
      "Implement the treasury/counterparty document model (GraphQL schema + TypeScript reducer under document-models/) following this repo's document-model conventions, and register it in document-models/document-models.ts so `npm run lint`, `npm run tsc` and `npm test` pass.",
  },
  {
    id: "tm-t3-c",
    parentId: "tm-t3",
    dependencies: ["tm-t3-a", "tm-t3-b"],
    description:
      "Implement the treasury/exposure-report document model plus a processor (processors/) that computes counterparty exposure and limit breaches from treasury/position documents, following this repo's processor conventions; register both so `npm run lint`, `npm run tsc` and `npm test` pass.",
  },
  { id: "tm-t4", description: "Stage 4 — reporting (daily treasury report)" },
  {
    id: "tm-t4-a",
    parentId: "tm-t4",
    dependencies: ["tm-t1-b", "tm-t2-b"],
    description:
      "Add src/core/report.ts: buildTreasuryReport({ positions, projections, threshold, breaches }) → { generatedAt: string (ISO), valuation: Money (total mark-to-market), liquidity: { threshold: Money, alerts: { date, balance: Money }[] }, exposure: { byCounterparty: Record<string, Money>, total: Money }, breaches } composing the Stage 0–2 modules; do not duplicate their logic. Cover with vitest unit tests over a small fixture set.",
  },
];
applyWithVerify(
  wbsId,
  actions(
    { type: "SET_SOW_PROJECT_REF", input: { sowRef: scopeId, sowProjectId: envId } },
    ...goals.map((g) => ({ type: "CREATE_GOAL", input: { id: g.id, description: g.description, parentId: g.parentId ?? null, dependencies: g.dependencies ?? [] } })),
  ),
  { log },
);
const wbsState = getDocState(wbsId);
if (wbsState.goals?.length !== goals.length) throw new Error(`goal read-back: ${wbsState.goals?.length} of ${goals.length}`);
log(`goals seeded: ${wbsState.goals.length}`);

// 4. deliverables — one per top-level goal
const tops = goals.filter((g) => !g.parentId);
tops.forEach((g, i) => {
  const dId = randomUUID();
  applyWithVerify(
    scopeId,
    actions(
      { type: "ADD_PROJECT_DELIVERABLE", input: { projectId: envId, deliverableId: dId, title: g.description } },
      { type: "EDIT_DELIVERABLE", input: { id: dId, code: `TM-${String(i + 1).padStart(2, "0")}`, status: "TODO" } },
      { type: "LINK_DELIVERABLE_GOAL", input: { deliverableId: dId, goalRef: g.id } },
    ),
    { log },
  );
});
log("deliverables linked");

const scopeState = getDocState(scopeId);
const env = scopeState.projects.find((p) => p.code === "TM");
log(`done: scope=${scopeId} wbs=${wbsId} deliverables=${scopeState.deliverables?.length} envelope.wbsRef=${env?.wbsRef?.slice(0, 8)}`);
