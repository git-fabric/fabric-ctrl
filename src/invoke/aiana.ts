/**
 * invoke/aiana.ts — AIANA recall and record wrappers
 *
 * Non-fatal: failures are logged and swallowed, never abort the invocation.
 */

const AIANA_ENDPOINT = process.env.AIANA_ENDPOINT ?? "http://localhost:8765";

/**
 * Recall: search AIANA for prior context relevant to the query.
 * Returns empty string on failure or no results.
 */
export async function recallContext(
  query: string,
  project?: string,
): Promise<{ output: string; duration_ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${AIANA_ENDPOINT}/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, project, limit: 5 }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[invoke:aiana] recall failed: ${res.status}`);
      return { output: "", duration_ms: Date.now() - start };
    }

    const data = (await res.json()) as {
      results?: Array<{ content: string }>;
    };

    if (!data.results?.length) {
      return {
        output: "No prior context found for this query.",
        duration_ms: Date.now() - start,
      };
    }

    return {
      output: data.results.map((r) => r.content).join("\n"),
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    console.warn("[invoke:aiana] recall error:", err);
    return { output: "", duration_ms: Date.now() - start };
  }
}

/**
 * Record: save the invocation outcome to AIANA.
 * Returns the memory ID if available.
 */
export async function recordOutcome(
  content: string,
  project?: string,
  tags: string[] = [],
): Promise<{ memory_id?: string; duration_ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${AIANA_ENDPOINT}/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, project, tags, role: "assistant" }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[invoke:aiana] record failed: ${res.status}`);
      return { duration_ms: Date.now() - start };
    }

    const data = (await res.json()) as { id?: string };
    return { memory_id: data.id, duration_ms: Date.now() - start };
  } catch (err) {
    console.warn("[invoke:aiana] record error:", err);
    return { duration_ms: Date.now() - start };
  }
}

/**
 * Check if AIANA is reachable.
 */
export async function isAianaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${AIANA_ENDPOINT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getAianaEndpoint(): string {
  return AIANA_ENDPOINT;
}

/** Detect memory language in a query that should trigger AIANA recall */
const MEMORY_PATTERNS = [
  /what (have|did) (i|we)/i,
  /past sessions?/i,
  /last time/i,
  /what did we decide/i,
  /prior (context|incidents?|work)/i,
  /do you remember/i,
  /recall/i,
  /history of/i,
  /previously/i,
];

export function hasMemoryLanguage(query: string): boolean {
  return MEMORY_PATTERNS.some((p) => p.test(query));
}
