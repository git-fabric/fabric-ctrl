/**
 * invoke/dispatcher.ts — Ollama REST API dispatch + Claude API fallback
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_REGISTRY } from "./types.js";

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT ?? "http://ollama.fabric-sdk:11434";
const SPECIALIST_TIMEOUT_MS = Number(process.env.SPECIALIST_TIMEOUT_MS ?? 30000);
const ROUTER_TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS ?? 10000);

let _anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/**
 * Call an Ollama model via the /api/generate REST endpoint.
 * Returns the model's text response, or null on failure.
 */
export async function callModel(
  agent: string,
  prompt: string,
): Promise<{ response: string; duration_ms: number }> {
  if (agent === "__claude__") {
    const start = Date.now();
    const response = await callClaude(prompt);
    return { response, duration_ms: Date.now() - start };
  }

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
 * Claude API fallback — called when:
 *   1. fabric-router output can't be parsed (unknown agent)
 *   2. fabric-router itself times out
 *   3. All specialist models fail/timeout for a query
 *
 * Prepends a brief preamble so Claude knows it's receiving an escalation.
 */
export async function callClaude(prompt: string): Promise<string> {
  console.warn("[dispatcher] Escalating to Claude API (route of last resort)");

  const preamble = [
    "You are receiving this query as a fallback because the fabric-sdk local",
    "specialist models were unavailable or could not route this request.",
    "Answer as helpfully as possible with full context.",
    "---",
    "",
  ].join("\n");

  const msg = await getAnthropic().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [{ role: "user", content: preamble + prompt }],
  });

  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
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
