/**
 * invoke/dispatcher.ts — Ollama REST API dispatch for specialist models
 */

import { MODEL_REGISTRY } from "./types.js";

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
const SPECIALIST_TIMEOUT_MS = Number(process.env.SPECIALIST_TIMEOUT_MS ?? 30000);
const ROUTER_TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS ?? 10000);

/**
 * Call an Ollama model via the /api/generate REST endpoint.
 * Returns the model's text response.
 */
export async function callModel(
  agent: string,
  prompt: string,
): Promise<{ response: string; duration_ms: number }> {
  const entry = MODEL_REGISTRY[agent];
  const model = entry?.model ?? agent;
  const temperature = entry?.temperature ?? 0.15;
  const isRouter = agent === "fabric-router";
  const timeout = isRouter ? ROUTER_TIMEOUT_MS : SPECIALIST_TIMEOUT_MS;

  const start = Date.now();

  const res = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama ${model} returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { response: string };
  return { response: data.response, duration_ms: Date.now() - start };
}

/**
 * Build a context-chained prompt for step N (N > 1).
 * Format: labeled prior context sections + original query last.
 */
export function buildChainedPrompt(
  priorSteps: Array<{ agent: string; output: string }>,
  originalQuery: string,
  preContext?: string,
): string {
  const parts: string[] = [];

  if (preContext) {
    parts.push(`[Pre-injected context]\n${preContext}`);
  }

  for (const step of priorSteps) {
    parts.push(`[Prior context from ${step.agent}]\n${step.output}`);
  }

  parts.push(`[Original query]\n${originalQuery}`);

  return parts.join("\n\n");
}

/**
 * List all models loaded in the Ollama instance.
 */
export async function listLoadedModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { models: Array<{ name: string }> };
  return data.models.map((m) => m.name.split(":")[0]);
}

export function getOllamaEndpoint(): string {
  return OLLAMA_ENDPOINT;
}
