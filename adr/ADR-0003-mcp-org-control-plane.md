# ADR-0003: MCP Server as the Org Control Plane

**Status:** Accepted  
**Date:** 2026-03-08  
**Author:** ry-ops

---

## Context

The individual `git-fabric` app repos (unifi, proxmox, k8s, sandfly, etc.) each expose MCP tools for their own infrastructure domains. There is no tool surface for the **org layer itself** — managing repos, reading security overviews, auditing access, and querying the audit log.

## Decision

`fabric-ctrl` exposes a **stdio MCP server** that wraps the GitHub App's Octokit client as org-level tools. Tool names are namespaced with `org__` to distinguish them from infrastructure-domain tools.

The MCP server does **not** proxy the individual fabric app servers. Each fabric app's MCP server is responsible for its own domain. `fabric-ctrl` owns only the org/GitHub layer. This preserves the "one app, one domain" principle from the `git-fabric` architecture.

Consumers (Claude Desktop, git-steer, cortex) can load `fabric-ctrl`'s MCP server alongside individual app servers to get full coverage — org control plane + infrastructure domains — without any single server becoming a monolith.

## Consequences

- Tool surface is intentionally narrow — org operations only
- Adding a new org-level capability means adding a tool to `src/mcp/tools/org.ts` (or a new file in `tools/`)
- The MCP server shares the same App auth as the webhook server — one identity, two entrypoints
- No credentials are accepted as tool inputs — all auth is derived from the App identity at runtime
