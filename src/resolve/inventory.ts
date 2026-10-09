/**
 * resolve/inventory.ts — live capability inventory (AI-ADR-013 rule 2, phase 1)
 *
 * Built from the fabric apps fabric-ctrl already loads: each app's tools and
 * health(), plus which fabric-llm models Ollama has loaded. Refreshed on an
 * interval and held in memory. Records past their TTL report health "unknown".
 */

import { createHash } from "node:crypto";
import type { FabricApp } from "../mcp/loader.js";
import { healthFrom, type CapabilityRecord, type Health } from "./schema.js";

const HEALTH_TIMEOUT_MS = 5000;

export interface InventorySnapshot {
  generatedAt: string;
  ttlSeconds: number;
  apps: number;
  records: CapabilityRecord[];
  /** Ollama model names currently loaded; empty when Ollama is unreachable */
  loadedModels: Set<string>;
  /** True when the last refresh is older than ttlSeconds */
  stale: boolean;
}

export interface InventoryOptions {
  ttlSeconds?: number;
  refreshMs?: number;
  /** Lists loaded Ollama models; injected so tests and offline runs need no network */
  listModels?: () => Promise<string[]>;
  now?: () => number;
}

export interface Inventory {
  snapshot(): Promise<InventorySnapshot>;
  refresh(): Promise<void>;
  stop(): void;
}

/** "@git-fabric/proxmox" → "proxmox" */
export function shortAppName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

async function appHealth(app: FabricApp): Promise<Health> {
  try {
    const status = await Promise.race([
      app.health(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS).unref(),
      ),
    ]);
    return healthFrom(status.status as Parameters<typeof healthFrom>[0]);
  } catch {
    return "down";
  }
}

export function createInventory(
  getApps: () => Promise<FabricApp[]> | FabricApp[],
  opts: InventoryOptions = {},
): Inventory {
  const ttlSeconds = opts.ttlSeconds ?? Number(process.env.RESOLVE_TTL_SECONDS ?? 300);
  const refreshMs = opts.refreshMs ?? Math.floor((ttlSeconds * 1000) / 2);
  const now = opts.now ?? Date.now;
  const listModels = opts.listModels ?? (async () => []);

  let records: CapabilityRecord[] = [];
  let apps = 0;
  let loadedModels = new Set<string>();
  let refreshedAt = 0;
  let inflight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function doRefresh(): Promise<void> {
    const loaded = await getApps();
    const [healths, models] = await Promise.all([
      Promise.all(loaded.map(appHealth)),
      listModels().catch(() => [] as string[]),
    ]);
    const seenAt = new Date(now()).toISOString();

    records = loaded.flatMap((app, i) =>
      app.tools.map((tool): CapabilityRecord => ({
        app: shortAppName(app.name),
        tool: tool.name,
        description: tool.description,
        inputSchemaHash: createHash("sha256").update(JSON.stringify(tool.inputSchema)).digest("hex").slice(0, 16),
        annotations: tool.annotations,
        requiredScopes: [], // no app declares scopes yet, so scope reports "unknown"
        origin: "registry",
        health: healths[i],
        lastSeen: seenAt,
      })),
    );
    apps = loaded.length;
    loadedModels = new Set(models);
    refreshedAt = now();
  }

  function refresh(): Promise<void> {
    inflight ??= doRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    refresh,

    async snapshot() {
      if (refreshedAt === 0) await refresh();
      if (!timer && refreshMs > 0) {
        timer = setInterval(() => {
          refresh().catch((err) => console.error(`[resolve:inventory] refresh failed: ${err}`));
        }, refreshMs);
        timer.unref();
      }
      const stale = now() - refreshedAt > ttlSeconds * 1000;
      return {
        generatedAt: new Date(refreshedAt).toISOString(),
        ttlSeconds,
        apps,
        records: stale ? records.map((r) => ({ ...r, health: "unknown" as const })) : records,
        loadedModels,
        stale,
      };
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
