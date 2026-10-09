/**
 * invoke/types.ts — Request, response, and domain types for fabric-invoke
 */

import type { ResolveOutput } from "../resolve/schema.js";

export interface InvokeRequest {
  query: string;
  project?: string;
  context?: string;
  dry_run?: boolean;
  record?: boolean;
}

export interface RouteDecision {
  primary: string;
  secondary: string[];
  sequence: string | null;
  reason: string;
  context_pass: string;
  escalated_to_claude: boolean;
}

export interface Step {
  step: number;
  agent: string;
  type: "recall" | "specialist" | "record" | "escalation";
  output: string;
  duration_ms: number;
}

export interface InvokeResponse {
  route: Omit<RouteDecision, "context_pass">;
  steps: Step[];
  result: string;
  aiana_memory_id?: string;
  total_duration_ms: number;
}

/** dry_run answers from fabric.resolve: a plan, not a model's routing guess (AI-ADR-013) */
export interface DryRunResponse {
  dry_run: true;
  resolve: ResolveOutput;
}

export interface StatusResponse {
  ollama: { endpoint: string; loaded_models: string[] };
  aiana: { reachable: boolean; endpoint: string };
  gateway: { reachable: boolean; endpoint: string };
  sequences: string[];
  status: "healthy" | "degraded" | "unhealthy";
}

/** Ollama model name registry — must match `ollama create` names */
export const MODEL_REGISTRY: Record<string, { model: string; temperature: number }> = {
  "fabric-router":     { model: "fabric-router",     temperature: 0.10 },
  "fabric-invoke":     { model: "fabric-invoke-ops", temperature: 0.10 },
  "unifi-ops":         { model: "unifi-ops",         temperature: 0.15 },
  "proxmox-ops":       { model: "proxmox-ops",       temperature: 0.15 },
  "k3s-ops":           { model: "k3s-ops",           temperature: 0.15 },
  "tailscale-ops":     { model: "tailscale-ops",     temperature: 0.15 },
  "sandfly-ops":       { model: "sandfly-ops",       temperature: 0.15 },
  "cloudflare-ops":    { model: "cloudflare-ops",    temperature: 0.15 },
  "n8n-ops":           { model: "n8n-ops",           temperature: 0.15 },
  "github-ops":        { model: "github-ops",        temperature: 0.15 },
  "cve-ops":           { model: "cve-ops",           temperature: 0.15 },
  "git-steer-ops":     { model: "git-steer-ops",     temperature: 0.15 },
  "aiana-ops":         { model: "aiana-ops",         temperature: 0.15 },
  "qdrant-fabric-ops": { model: "qdrant-fabric-ops", temperature: 0.15 },
};

/** Set of valid agent names for validation */
export const VALID_AGENTS = new Set(Object.keys(MODEL_REGISTRY));
