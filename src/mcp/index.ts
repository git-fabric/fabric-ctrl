import "dotenv/config";
import { resolve } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadApps } from "./loader.js";
import { orgTools } from "./tools/org.js";
import { handleInvoke, handleStatus } from "../invoke/index.js";
import type { InvokeRequest } from "../invoke/types.js";

/**
 * mcp/index.ts — fabric-ctrl aggregation plane
 *
 * Loads all fabric apps in-process and serves every tool
 * through a single MCP server. One repo, one server, full stack.
 *
 * Tool surface:
 *   - fabric_health, fabric_apps  (built-in)
 *   - org__*                       (GitHub App identity)
 *   - unifi_*, proxmox_*, k8s_*,  (fabric apps loaded from gateway.yaml)
 *     tailscale_*, cloudflare_*,
 *     sandfly_*, cve_*, git_*,
 *     chat_*, aiana_*
 *
 * Consumed by: Claude Desktop, git-steer, or any MCP host.
 */

// ── Load all fabric apps ────────────────────────────────────────────────────

const configPath = resolve(process.env.GATEWAY_CONFIG ?? "./gateway.yaml");
const apps = await loadApps(configPath);

for (const app of apps) {
  console.error(`[fabric-ctrl] registered ${app.name} (${app.tools.length} tools)`);
}

const totalAppTools = apps.reduce((n, a) => n + a.tools.length, 0);
console.error(
  `[fabric-ctrl] ${apps.length} apps loaded, ${totalAppTools} app tools + ${orgTools.length} org tools`
);

function buildServer(apps: Awaited<ReturnType<typeof loadApps>>, orgTools: typeof import('./tools/org.js').orgTools) {
// ── MCP server ──────────────────────────────────────────────────────────────
  
  const server = new Server(
    {
      name: process.env.MCP_SERVER_NAME ?? "fabric-ctrl",
      version: process.env.MCP_SERVER_VERSION ?? "0.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );
  
  // ── Built-in tools ──────────────────────────────────────────────────────────
  
  const BUILTIN_TOOLS = [
    {
      name: "fabric_health",
      description:
        "Health check across all registered fabric apps. Returns status, latency, and details for each app.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "fabric_apps",
      description:
        "List all registered fabric apps and their tools.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "fabric_invoke",
      description:
        "Route a query through the fabric-sdk specialist model pool. Automatically selects the correct specialist agent(s), executes multi-step sequences, recalls AIANA context, and records the outcome.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "The natural language query or task" },
          project: { type: "string", description: "AIANA project scope (e.g. 'stackforge', 'git-steer')" },
          dry_run: { type: "boolean", description: "Return routing decision only, no execution (default: false)" },
          record: { type: "boolean", description: "Record outcome to AIANA (default: true)" },
        },
        required: ["query"],
      },
    },
    {
      name: "fabric_route",
      description:
        "Get the routing decision for a query without executing it. Equivalent to fabric_invoke with dry_run: true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "The natural language query or task" },
        },
        required: ["query"],
      },
    },
    {
      name: "fabric_status",
      description:
        "Health check — which Ollama models are loaded, AIANA reachable, gateway registered.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];
  
  // ── List tools ──────────────────────────────────────────────────────────────
  
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const orgToolDefs = orgTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));
  
    const appToolDefs = apps.flatMap((app) =>
      app.tools.map((tool) => ({
        name: tool.name,
        description: `[${app.name}] ${tool.description}`,
        inputSchema: tool.inputSchema,
      }))
    );
  
    return { tools: [...BUILTIN_TOOLS, ...orgToolDefs, ...appToolDefs] };
  });
  
  // ── Call tool ────────────────────────────────────────────────────────────────
  
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
  
    // Built-in: fabric_health
    if (name === "fabric_health") {
      const results = [];
      for (const app of apps) {
        const start = Date.now();
        try {
          const status = await app.health();
          results.push({ ...status, latencyMs: Date.now() - start });
        } catch {
          results.push({
            app: app.name,
            status: "unavailable",
            latencyMs: Date.now() - start,
          });
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  
    // Built-in: fabric_invoke
    if (name === "fabric_invoke") {
      try {
        const req: InvokeRequest = {
          query: (args as any).query,
          project: (args as any).project,
          dry_run: (args as any).dry_run,
          record: (args as any).record,
        };
        const result = await handleInvoke(req);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `fabric_invoke error: ${message}` }],
          isError: true,
        };
      }
    }
  
    // Built-in: fabric_route
    if (name === "fabric_route") {
      try {
        const req: InvokeRequest = {
          query: (args as any).query,
          dry_run: true,
        };
        const result = await handleInvoke(req);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `fabric_route error: ${message}` }],
          isError: true,
        };
      }
    }
  
    // Built-in: fabric_status
    if (name === "fabric_status") {
      const status = await handleStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  
    // Built-in: fabric_apps
    if (name === "fabric_apps") {
      const appList = apps.map((app) => ({
        name: app.name,
        version: app.version,
        description: app.description,
        tools: app.tools.map((t) => t.name),
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            apps: appList,
            totalTools: totalAppTools + orgTools.length,
          }, null, 2),
        }],
      };
    }
  
    // Org tools (backed by GitHub App identity)
    const orgTool = orgTools.find((t) => t.name === name);
    if (orgTool) {
      try {
        const input = orgTool.inputSchema.parse(args ?? {});
        const result = await orgTool.handler(input as any);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  
    // Fabric app tools — find across all loaded apps
    for (const app of apps) {
      const tool = app.tools.find((t) => t.name === name);
      if (tool) {
        try {
          const result = await tool.execute((args ?? {}) as Record<string, unknown>);
          return {
            content: [{
              type: "text",
              text: typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `[${app.name}] Error: ${message}` }],
            isError: true,
          };
        }
      }
    }
  
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });
  return server;
}

// ── Pre-build for stdio (reused) ─────────────────────────────────────────────
const server = buildServer(apps, orgTools);

// ── Start ───────────────────────────────────────────────────────────────────

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT) : null;

if (httpPort) {
  const { createServer } = await import('node:http');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const httpServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      const parsedBody = body ? JSON.parse(body) : undefined;
      // Stateless: new server + transport per request
      const reqServer = buildServer(apps, orgTools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await reqServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  });
  httpServer.listen(httpPort, '0.0.0.0', () => {
    console.error('[fabric-ctrl:mcp] Aggregation plane running on HTTP port ' + httpPort);
  });
} else {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[fabric-ctrl:mcp] Aggregation plane running on stdio');
}
