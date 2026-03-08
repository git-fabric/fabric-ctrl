import { resolve } from "path";
import { loadApps } from "../mcp/loader.js";

/**
 * dispatch.ts — In-process fabric app dispatch
 *
 * Calls fabric app tools directly via the embedded gateway registry.
 * No HTTP hop — tools execute in-process.
 *
 * Zero-trust: every dispatch is logged. Failures are non-fatal —
 * webhook processing must never block on downstream availability.
 */

export interface DispatchResult {
  ok: boolean;
  app?: string;
  tool: string;
  result?: unknown;
  error?: string;
  durationMs: number;
}

// ── Lazy-initialized shared app list ────────────────────────────────────────

let _apps: Awaited<ReturnType<typeof loadApps>> | null = null;

async function getApps() {
  if (_apps) return _apps;
  const configPath = resolve(process.env.GATEWAY_CONFIG ?? "./gateway.yaml");
  _apps = await loadApps(configPath);
  for (const app of _apps) {
    console.error(`[dispatch] loaded ${app.name}`);
  }
  return _apps;
}

/**
 * Dispatch a tool call to a fabric app.
 * Non-throwing — returns a result envelope so callers can decide how to handle failures.
 */
export async function dispatch(
  tool: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const start = Date.now();

  try {
    const apps = await getApps();

    // Find the tool across all loaded apps
    for (const app of apps) {
      const match = app.tools.find((t) => t.name === tool);
      if (match) {
        const result = await match.execute(args);
        const durationMs = Date.now() - start;
        console.log(`[dispatch:ok] ${tool} → ${app.name} (${durationMs}ms)`);
        return { ok: true, app: app.name, tool, result, durationMs };
      }
    }

    console.error(`[dispatch:fail] ${tool}: no app registered for this tool`);
    return {
      ok: false,
      tool,
      error: `No fabric app registered for tool "${tool}"`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch:fail] ${tool}: ${message}`);
    return {
      ok: false,
      tool,
      error: message,
      durationMs: Date.now() - start,
    };
  }
}
