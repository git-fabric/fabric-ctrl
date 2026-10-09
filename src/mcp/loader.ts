import { readFile } from "node:fs/promises";

interface GatewayConfig {
  apps?: Array<{
    name: string;
    enabled: boolean;
    env?: Record<string, string>;
  }>;
}

export interface FabricApp {
  name: string;
  version: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }>;
  health: () => Promise<{ app: string; status: string; latencyMs?: number }>;
}

/**
 * mcp/loader.ts — Fabric app loader
 *
 * Loads fabric apps from gateway.yaml config.
 * Each app is dynamically imported and instantiated via createApp().
 *
 * Failures are isolated — one app failing to load doesn't prevent
 * the rest from starting.
 */

export async function loadApps(configPath: string): Promise<FabricApp[]> {
  let config: GatewayConfig;

  try {
    const raw = await readFile(configPath, "utf-8");
    const { parse: parseYaml } = await import("yaml");
    config = parseYaml(raw) as GatewayConfig;
  } catch {
    console.error(
      `[fabric-ctrl:loader] No config found at ${configPath}, starting with org tools only`
    );
    return [];
  }

  const apps: FabricApp[] = [];

  for (const appConfig of config.apps ?? []) {
    if (!appConfig.enabled) {
      console.error(`[fabric-ctrl:loader] skipping disabled app: ${appConfig.name}`);
      continue;
    }

    // Inject per-app env vars before createApp()
    if (appConfig.env) {
      for (const [key, value] of Object.entries(appConfig.env)) {
        process.env[key] = String(value);
      }
    }

    try {
      const mod = await import(appConfig.name);

      if (typeof mod.createApp !== "function") {
        console.error(
          `[fabric-ctrl:loader] ${appConfig.name} does not export createApp(), skipping`
        );
        continue;
      }

      const app: FabricApp = await mod.createApp();
      apps.push(app);
      console.error(`[fabric-ctrl:loader] loaded ${appConfig.name} (${app.tools.length} tools)`);
    } catch (err: unknown) {
      console.error(
        `[fabric-ctrl:loader] failed to load ${appConfig.name}: ${(err as Error).message}`
      );
    }
  }

  return apps;
}
