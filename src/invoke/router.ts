/**
 * invoke/router.ts — Calls fabric-router Ollama model and parses the route decision
 *
 * Hardened against: unknown agent names, parse failures, router timeouts.
 * Falls back to Claude API when routing can't be determined locally.
 */

import { callModel } from "./dispatcher.js";
import type { RouteDecision } from "./types.js";
import { VALID_AGENTS } from "./types.js";

/**
 * Validate an agent name against MODEL_REGISTRY.
 * Supports fuzzy matching for minor hallucinations (k3s_ops → k3s-ops).
 */
function validateAgent(name: string): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  if (VALID_AGENTS.has(normalized)) return normalized;
  // Fuzzy: handle underscore/hyphen confusion
  const fuzzy = [...VALID_AGENTS].find(
    (m) => m.replace(/-/g, "") === normalized.replace(/[-_]/g, ""),
  );
  if (fuzzy) {
    console.warn(`[router] Fuzzy-matched "${name}" → "${fuzzy}"`);
    return fuzzy;
  }
  return null;
}

/**
 * Create a Claude fallback route decision.
 * Used when fabric-router output can't be parsed or returns unknown agents.
 */
function claudeFallbackRoute(reason: string): RouteDecision {
  return {
    primary: "__claude__",
    secondary: [],
    sequence: null,
    reason,
    context_pass: "",
    escalated_to_claude: true,
  };
}

/**
 * Parse fabric-router's structured output into a RouteDecision.
 *
 * Expected format:
 *   ROUTE: k3s-ops
 *   SECONDARY: proxmox-ops, sandfly-ops
 *   SEQUENCE: SEQ-04
 *   REASON: Infrastructure health check...
 *   CONTEXT-PASS: ...
 *
 * Hardened against extra whitespace, mixed case, unknown agent names.
 */
function parseRouteOutput(raw: string): RouteDecision {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const extract = (key: string): string => {
    const prefix = `${key}:`;
    const line = lines.find((l) => l.toUpperCase().startsWith(prefix.toUpperCase()));
    if (!line) return "";
    return line.slice(prefix.length).trim();
  };

  const primaryRaw = extract("ROUTE");
  const secondaryRaw = extract("SECONDARY");
  const sequenceRaw = extract("SEQUENCE").replace(/^NONE$/i, "");
  const reason = extract("REASON") || "No reason provided";
  const context_pass = extract("CONTEXT-PASS") || "";

  // Validate primary against registry
  const primary = validateAgent(primaryRaw);
  if (!primary) {
    console.error(
      `[router] fabric-router returned unknown agent: "${primaryRaw}". Escalating to Claude.`,
    );
    return claudeFallbackRoute(`Unknown primary agent from router: "${primaryRaw}"`);
  }

  // Validate secondaries — silently drop unknowns
  const secondary = secondaryRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== "none")
    .filter((agent) => {
      const valid = validateAgent(agent);
      if (!valid) {
        console.warn(`[router] Unknown secondary agent "${agent}" — skipping`);
      }
      return !!valid;
    })
    .map((agent) => validateAgent(agent)!);

  const sequence = sequenceRaw || null;

  return { primary, secondary, sequence, reason, context_pass, escalated_to_claude: false };
}

/**
 * Route a query through fabric-router and return the parsed decision.
 * Falls back to Claude route on router timeout or parse failure.
 */
export async function routeQuery(
  query: string,
  preContext?: string,
): Promise<{ decision: RouteDecision; duration_ms: number }> {
  const prompt = preContext ? `${preContext}\n\n${query}` : query;

  try {
    const { response, duration_ms } = await callModel("fabric-router", prompt);
    const decision = parseRouteOutput(response);
    return { decision, duration_ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[router] fabric-router failed: ${message}. Escalating to Claude.`);
    return {
      decision: claudeFallbackRoute(`fabric-router failed: ${message}`),
      duration_ms: 0,
    };
  }
}
