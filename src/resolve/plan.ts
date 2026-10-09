/**
 * resolve/plan.ts — deterministic plan assembly (AI-ADR-013 rules 4–6, 9)
 *
 * Order of preference: a sequence template whose trigger matches the intent;
 * otherwise the matcher's set cover (one tool when one suffices), grouped by
 * app with reads before writes. No model is consulted. Every step that cannot
 * run gets a gap.
 */

import { MODEL_REGISTRY } from "../invoke/types.js";
import type { InventorySnapshot } from "./inventory.js";
import type { Match, Matcher } from "./matcher.js";
import {
  confidenceFor,
  effectFrom,
  gapSignature,
  verdictFor,
  type CapabilityRecord,
  type Gap,
  type GapKind,
  type ResolveInput,
  type ResolveOutput,
  type Step,
} from "./schema.js";

/** The selected tools must together cover at least this share of the intent */
export const MATCH_THRESHOLD = 0.5;
/** Below this, report no_tool instead of low_confidence */
const NEAR_MISS = 0.25;
/** Confidence cap for plans whose cross-step data flow is not known */
const ADVISORY_CAP = 0.59;

/** fabric app → MODEL_REGISTRY agent that can handle its hops locally */
const APP_AGENT: Record<string, string> = {
  unifi: "unifi-ops",
  proxmox: "proxmox-ops",
  k8s: "k3s-ops",
  tailscale: "tailscale-ops",
  cloudflare: "cloudflare-ops",
  sandfly: "sandfly-ops",
  cve: "cve-ops",
  git: "github-ops",
  aiana: "aiana-ops",
};

export interface SequenceTemplate {
  id: string;
  trigger: RegExp;
  tools: string[];
}

/** Tool-level sequence templates; SEQ-01…06 move here (AI-ADR-013 implementation step 4) */
export const TEMPLATES: SequenceTemplate[] = [];

function gap(kind: GapKind, target: string, detail: string, extra: Partial<Gap> = {}): Gap {
  return { kind, detail, signature: gapSignature(kind, target), ...extra };
}

function purposeOf(r: CapabilityRecord): string {
  return r.description.split(/(?<=\.)\s/)[0];
}

function toStep(order: number, m: Match, snap: InventorySnapshot): Step {
  const r = m.record;
  const agent = APP_AGENT[r.app];
  const model = agent ? MODEL_REGISTRY[agent]?.model : undefined;
  return {
    order,
    app: r.app,
    tool: r.tool,
    purpose: purposeOf(r),
    ...effectFrom(r.annotations),
    dependsOn: [],
    route: { local: !!model && snap.loadedModels.has(model), ...(agent && { model: agent }) },
    health: r.health,
    scope: r.requiredScopes.length === 0 ? "unknown" : "ok",
    matchScore: m.score,
  };
}

/** Reads first, each write depending on the reads before it in the same app */
function orderSteps(matches: Match[], snap: InventorySnapshot): Step[] {
  const steps: Step[] = [];
  const apps = [...new Set(matches.map((m) => m.record.app))];
  for (const app of apps) {
    const ofApp = matches.filter((m) => m.record.app === app);
    const reads = ofApp.filter((m) => effectFrom(m.record.annotations).effect === "read");
    const writes = ofApp.filter((m) => effectFrom(m.record.annotations).effect !== "read");
    const readOrders: number[] = [];
    for (const m of reads) {
      const s = toStep(steps.length + 1, m, snap);
      readOrders.push(s.order);
      steps.push(s);
    }
    for (const m of writes) steps.push({ ...toStep(steps.length + 1, m, snap), dependsOn: [...readOrders] });
  }
  return steps;
}

export function buildPlan(
  input: ResolveInput,
  snap: InventorySnapshot,
  matcher: Matcher,
): ResolveOutput {
  const { intent, constraints } = input;
  const gaps: Gap[] = [];
  let plan: Step[] = [];
  let advisory = false;

  const template = TEMPLATES.find((t) => t.trigger.test(intent));

  if (template) {
    const byTool = new Map(snap.records.map((r) => [r.tool, r]));
    const present: Match[] = [];
    for (const tool of template.tools) {
      const record = byTool.get(tool);
      if (record) present.push({ record, score: 1 });
      else gaps.push(gap("no_tool", tool, `${template.id} step ${tool} is not in the inventory`, {
        suggestion: { type: "build_app", target: tool },
      }));
    }
    plan = present.map((m, i) => ({ ...toStep(i + 1, m, snap), dependsOn: i ? [i] : [] }));
  } else {
    // Select up to maxSteps + 1 so an over-long plan is reported, not silently cut
    const selection = matcher.select(intent, snap.records, constraints.maxSteps + 1);
    if (selection.coverage < MATCH_THRESHOLD) {
      const best = selection.matches[0];
      if (best && selection.coverage >= NEAR_MISS) {
        gaps.push(gap("low_confidence", best.record.tool,
          `best tools cover ${Math.round(selection.coverage * 100)}% of the intent`, {
            suggestion: { type: "improve_description", target: `${best.record.app}/${best.record.tool}` },
          }));
      } else {
        const unknown = matcher.unknownTerms(intent, snap.records);
        const target = unknown.join("-") || "unmatched";
        gaps.push(gap("no_tool", target,
          unknown.length ? `no tool covers: ${unknown.join(", ")}` : "no tool matches this intent", {
            suggestion: { type: "build_app", target },
          }));
      }
    } else {
      plan = orderSteps(selection.matches, snap);

      const apps = [...new Set(plan.map((s) => s.app))];
      if (apps.length > 1) {
        advisory = true;
        gaps.push(gap("low_confidence", `cross-app:${apps.join("+")}`,
          `plan spans ${apps.join(", ")}; data flow between them is not inferred`));
      }
    }
  }

  if (plan.length > constraints.maxSteps) {
    advisory = true;
    gaps.push(gap("low_confidence", "max-steps",
      `plan needs ${plan.length} steps; truncated to maxSteps=${constraints.maxSteps}`));
    plan = plan.slice(0, constraints.maxSteps).map((s) => ({
      ...s,
      dependsOn: s.dependsOn.filter((d) => d <= constraints.maxSteps),
    }));
  }

  // Every step that cannot run as planned gets a step-bound gap (rule 6)
  for (const s of plan) {
    if (s.health === "down") {
      gaps.push(gap("app_down", s.app, `${s.app} is unhealthy`, {
        step: s.order, suggestion: { type: "restore_app", target: `git-fabric/${s.app}` },
      }));
    } else if (s.health === "unknown") {
      gaps.push(gap("stale_inventory", s.app, `${s.app} has not been seen within ${snap.ttlSeconds}s`, {
        step: s.order,
      }));
    }
    if (s.scope === "insufficient") {
      gaps.push(gap("insufficient_scope", s.tool, `credential for ${s.app} cannot run ${s.tool}`, {
        step: s.order, suggestion: { type: "grant_scope", target: `${s.app}:${s.tool}` },
      }));
    }
    if (constraints.readOnly && s.effect !== "read") {
      gaps.push(gap("policy_denied", s.tool,
        `${s.tool} is a ${s.effect}${s.effectSource === "default" ? " (unannotated)" : ""} step and readOnly is set`,
        { step: s.order }));
    }
  }

  let escalation: ResolveOutput["escalation"];
  const remote = [...new Set(plan.filter((s) => !s.route.local).map((s) => s.app))];
  if (plan.length === 0) {
    escalation = { recommended: "none", reason: "no capability matches; see missing" };
  } else if (advisory) {
    escalation = { recommended: "claude", reason: "the plan needs chaining that local routing cannot infer" };
  } else if (remote.length === 0) {
    escalation = { recommended: "local", reason: "every step has a loaded fabric-llm model" };
  } else {
    escalation = { recommended: "claude", reason: `no loaded fabric-llm model for: ${remote.join(", ")}` };
  }
  if (constraints.localOnly && escalation.recommended === "claude") {
    gaps.push(gap("policy_denied", "localOnly", `${escalation.reason}, and localOnly is set`));
    escalation = { recommended: "none", reason: `localOnly forbids escalation: ${escalation.reason}` };
  }

  const confidence = confidenceFor(plan);
  return {
    verdict: verdictFor(plan, gaps),
    confidence: advisory ? Math.min(confidence, ADVISORY_CAP) : confidence,
    plan,
    missing: gaps,
    escalation,
    inventory: {
      generatedAt: snap.generatedAt,
      ttlSeconds: snap.ttlSeconds,
      apps: snap.apps,
      tools: snap.records.length,
      source: "live",
      matcher: matcher.kind,
    },
  };
}
