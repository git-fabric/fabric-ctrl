/**
 * resolve/index.ts — fabric.resolve entry point (AI-ADR-013)
 *
 * One inventory per process, shared by the MCP server and the webhook app.
 * Read-only: nothing here executes a fabric tool.
 */

import { getApps } from "../app/dispatch.js";
import { listLoadedModels } from "../invoke/dispatcher.js";
import { createInventory, type Inventory } from "./inventory.js";
import { lexicalMatcher } from "./matcher.js";
import { buildPlan } from "./plan.js";
import { ResolveInput, ResolveOutput } from "./schema.js";

let inventory: Inventory | null = null;

function getInventory(): Inventory {
  inventory ??= createInventory(getApps, { listModels: listLoadedModels });
  return inventory;
}

/** Validates the input, resolves it against the live inventory, validates the answer */
export async function resolveIntent(raw: unknown): Promise<ResolveOutput> {
  const input = ResolveInput.parse(raw);
  const snap = await getInventory().snapshot();
  return ResolveOutput.parse(buildPlan(input, snap, lexicalMatcher));
}

export { ResolveInput, ResolveOutput } from "./schema.js";
