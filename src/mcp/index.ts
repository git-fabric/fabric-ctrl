import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { orgTools } from "./tools/org.js";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * mcp/index.ts — fabric-ctrl MCP server
 *
 * Exposes org-level GitHub operations as MCP tools.
 * Identity is derived from the GitHub App — no PATs, no user tokens.
 * Consumed by: Claude Desktop, git-steer, cortex, or any MCP host.
 */

const server = new Server(
  {
    name: process.env.MCP_SERVER_NAME ?? "fabric-ctrl",
    version: process.env.MCP_SERVER_VERSION ?? "0.1.0",
  },
  {
    capabilities: { tools: {} },
  }
);

const allTools = [...orgTools];

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = allTools.find((t) => t.name === request.params.name);

  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  try {
    const input = tool.inputSchema.parse(request.params.arguments ?? {});
    const result = await tool.handler(input as any);
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
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[fabric-ctrl:mcp] Server running on stdio");
