/**
 * invoke/router.ts — Calls fabric-router Ollama model and parses the route decision
 */

import { callModel } from "./dispatcher.js";
import type { RouteDecision } from "./types.js";

/**
 * Parse fabric-router's structured output into a RouteDecision.
 *
 * Expected format:
 *   ROUTE: k3s-ops
 *   SECONDARY: proxmox-ops, sandfly-ops
 *   SEQUENCE: SEQ-04
 *   REASON: Infrastructure health check...
 *   CONTEXT-PASS: ...
 */
function parseRouteOutput(raw: string): RouteDecision {
  const lines = raw.split("\n");

  let primary = "";
  let secondary: string[] = [];
  let sequence: string | null = null;
  let reason = "";
  let context_pass = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("ROUTE:")) {
      primary = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("SECONDARY:")) {
      const val = trimmed.slice(10).trim();
      secondary = val === "NONE" || val === ""
        ? []
        : val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (trimmed.startsWith("SEQUENCE:")) {
      const val = trimmed.slice(9).trim();
      sequence = val === "NONE" || val === "" ? null : val;
    } else if (trimmed.startsWith("REASON:")) {
      reason = trimmed.slice(7).trim();
    } else if (trimmed.startsWith("CONTEXT-PASS:")) {
      context_pass = trimmed.slice(13).trim();
    }
  }

  if (!primary) {
    throw new Error(`fabric-router output missing ROUTE field:\n${raw}`);
  }

  return { primary, secondary, sequence, reason, context_pass };
}

/**
 * Route a query through fabric-router and return the parsed decision.
 */
export async function routeQuery(
  query: string,
  preContext?: string,
): Promise<{ decision: RouteDecision; duration_ms: number }> {
  const prompt = preContext
    ? `${preContext}\n\n${query}`
    : query;

  const { response, duration_ms } = await callModel("fabric-router", prompt);
  const decision = parseRouteOutput(response);
  return { decision, duration_ms };
}
