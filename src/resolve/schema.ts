/**
 * resolve/schema.ts — fabric.resolve: read-only capability looking glass (AI-ADR-013)
 *
 * Advises, never executes. Answers have / need / missing for an intent from a
 * live capability inventory. Matching may be fuzzy; everything in this file is
 * deterministic so the same inventory and matches always produce the same answer.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/* ---------- Input ---------- */

export const ResolveInput = z.object({
  /** Natural-language intent, e.g. "move the plex VM onto the IoT VLAN" */
  intent: z.string().min(3),
  constraints: z
    .object({
      /** Disallow plans that escalate to Claude/cloud models */
      localOnly: z.boolean().default(false),
      /** Write/destructive steps are reported as policy_denied gaps */
      readOnly: z.boolean().default(false),
      maxSteps: z.number().int().min(1).max(20).default(8),
    })
    .default({}),
  // No caller field: fabric-ctrl takes caller identity from the connection,
  // never from the payload, because policy_denied depends on it.
});
export type ResolveInput = z.infer<typeof ResolveInput>;

/* ---------- Shared enums ---------- */

export const Effect = z.enum(["read", "write", "destructive"]);
export const Health = z.enum(["up", "degraded", "down", "unknown"]);
export const Scope = z.enum(["ok", "insufficient", "unknown"]);
export type Effect = z.infer<typeof Effect>;
export type Health = z.infer<typeof Health>;

/* ---------- Plan ---------- */

export const Step = z.object({
  order: z.number().int().min(1),
  app: z.string(),               // e.g. "unifi"
  tool: z.string(),              // e.g. "unifi_list_devices"
  purpose: z.string(),           // why this step exists
  effect: Effect,
  /** "default" means the tool has no annotations and was assumed to write */
  effectSource: z.enum(["annotation", "default"]),
  dependsOn: z.array(z.number().int()).default([]),
  route: z.object({
    local: z.boolean(),          // can a fabric-llm model handle this hop?
    model: z.string().optional(),// MODEL_REGISTRY key, e.g. "unifi-ops"
  }),
  health: Health,
  scope: Scope,
  matchScore: z.number().min(0).max(1), // intent→tool similarity from the matcher
});
export type Step = z.infer<typeof Step>;

/* ---------- Gaps ---------- */

export const GapKind = z.enum([
  "no_tool",            // no capability matches
  "no_model",           // e.g. needs vision, no VLM route
  "insufficient_scope", // tool exists, credential can't do it
  "app_down",           // tool exists, app unhealthy
  "stale_inventory",    // record past TTL
  "low_confidence",     // match below threshold, or needs chaining no template covers
  "policy_denied",      // fabric-ctrl policy or the readOnly constraint forbids it
]);
export type GapKind = z.infer<typeof GapKind>;

export const Gap = z.object({
  kind: GapKind,
  detail: z.string(),
  /** Set when the gap blocks a plan step; a blocked step cannot run as planned */
  step: z.number().int().optional(),
  suggestion: z
    .object({
      type: z.enum(["build_app", "add_model", "grant_scope", "restore_app", "improve_description"]),
      target: z.string(),            // e.g. "git-fabric/opnsense", "qwen2.5-vl"
    })
    .optional(),
  /** gapSignature(kind, target) — groups the same gap across differently worded intents */
  signature: z.string(),
});
export type Gap = z.infer<typeof Gap>;

/* ---------- Output ---------- */

export const ResolveOutput = z.object({
  verdict: z.enum(["have", "partial", "missing"]),
  /** Caller MUST treat < 0.6 as advisory only */
  confidence: z.number().min(0).max(1),
  plan: z.array(Step),
  missing: z.array(Gap),
  escalation: z.object({
    recommended: z.enum(["local", "claude", "none"]),
    reason: z.string(),
  }),
  inventory: z.object({
    generatedAt: z.string().datetime(),
    ttlSeconds: z.number().int(),
    apps: z.number().int(),
    tools: z.number().int(),
    source: z.literal("live"),
    /** lexical until Qdrant is deployed; callers can weigh matchScore accordingly */
    matcher: z.enum(["lexical", "semantic"]),
  }),
});
export type ResolveOutput = z.infer<typeof ResolveOutput>;

/* ---------- Inventory record (in memory in phase 1, keyed per tool) ---------- */

export const CapabilityRecord = z.object({
  app: z.string(),
  tool: z.string(),
  description: z.string(),
  inputSchemaHash: z.string(),
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
  requiredScopes: z.array(z.string()).default([]),
  /** registry = apps loaded in-process (phase 1); frib = sdk gateway route (phase 2) */
  origin: z.enum(["registry", "frib"]),
  embeddingId: z.string().optional(), // Qdrant point id, once the semantic matcher exists
  health: Health,
  lastSeen: z.string().datetime(),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

/* ---------- Deterministic helpers ---------- */

/** Maps @git-fabric/gateway HealthStatus.status onto Health */
export function healthFrom(status: "healthy" | "degraded" | "unavailable" | undefined): Health {
  switch (status) {
    case "healthy": return "up";
    case "degraded": return "degraded";
    case "unavailable": return "down";
    default: return "unknown";
  }
}

export function effectFrom(a: CapabilityRecord["annotations"]): { effect: Effect; effectSource: Step["effectSource"] } {
  if (!a || (a.readOnlyHint === undefined && a.destructiveHint === undefined)) {
    return { effect: "write", effectSource: "default" }; // unannotated tools are assumed to write
  }
  if (a.destructiveHint) return { effect: "destructive", effectSource: "annotation" };
  if (a.readOnlyHint) return { effect: "read", effectSource: "annotation" };
  return { effect: "write", effectSource: "annotation" };
}

/**
 * The plan builder must emit a step-bound gap for every step that cannot run:
 * health down/unknown, scope insufficient, or policy denied. The verdict then
 * follows from the gaps alone.
 */
export function verdictFor(plan: Step[], gaps: Gap[]): ResolveOutput["verdict"] {
  if (plan.length === 0) return "missing";
  const blocked = new Set(gaps.flatMap((g) => (g.step === undefined ? [] : [g.step])));
  if (plan.every((s) => blocked.has(s.order))) return "missing";
  return gaps.length > 0 ? "partial" : "have";
}

/**
 * Weakest match across the plan, less 0.1 for each step that writes with an
 * unknown credential scope.
 */
export function confidenceFor(plan: Step[]): number {
  if (plan.length === 0) return 0;
  const weakest = Math.min(...plan.map((s) => s.matchScore));
  const unknownWrites = plan.filter((s) => s.effect !== "read" && s.scope === "unknown").length;
  return Math.max(0, Math.round((weakest - 0.1 * unknownWrites) * 100) / 100);
}

/** Intent is deliberately excluded so rewordings of the same gap dedupe together */
export function gapSignature(kind: GapKind, target: string): string {
  return createHash("sha256").update(`${kind}\0${target}`).digest("hex").slice(0, 16);
}

/* ---------- Example ----------
intent: "move the plex VM onto the IoT VLAN"
{
  "verdict": "partial",
  "confidence": 0.82,
  "plan": [
    { "order": 1, "app": "unifi", "tool": "unifi_list_networks", "purpose": "find IoT VLAN id",
      "effect": "read", "effectSource": "annotation", "dependsOn": [],
      "route": { "local": true, "model": "unifi-ops" },
      "health": "up", "scope": "ok", "matchScore": 0.91 },
    { "order": 2, "app": "proxmox", "tool": "proxmox_vm_set_nic", "purpose": "retag VM NIC",
      "effect": "write", "effectSource": "annotation", "dependsOn": [1],
      "route": { "local": true, "model": "proxmox-ops" },
      "health": "up", "scope": "insufficient", "matchScore": 0.87 }
  ],
  "missing": [
    { "kind": "insufficient_scope", "step": 2,
      "detail": "proxmox token is read-only (PVEAuditor)",
      "suggestion": { "type": "grant_scope", "target": "proxmox:VM.Config.Network" },
      "signature": "a91f03c2e7b45d10" }
  ],
  "escalation": { "recommended": "local", "reason": "all hops have fabric-llm routes" },
  "inventory": { "generatedAt": "2026-10-08T23:45:00Z", "ttlSeconds": 300,
                 "apps": 10, "tools": 112, "source": "live", "matcher": "lexical" }
}
*/
