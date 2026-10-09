# ADR-0002: Webhook Server as the Security Event Bus

**Status:** Accepted  
**Date:** 2026-03-08  
**Author:** ry-ops

---

## Context

`fabric-ctrl` needs to react to security events across the org — not poll for them. Polling is slow, burns API rate limits, and creates windows where threats go undetected. The alternative is a push-based webhook receiver that processes events in real time.

## Decision

`fabric-ctrl` runs a lightweight **Hono** webhook server as one of its two entrypoints (the other being the MCP server). All GitHub org events flow through this server. The server is the single inbound surface for the org's security event stream.

The server is intentionally minimal — it receives, verifies, and dispatches. Business logic lives in typed handler modules (`push.ts`, `security-alert.ts`, `dependabot.ts`, `audit.ts`). This separation makes handlers independently testable and replaceable.

## Consequences

- `fabric-ctrl` must be reachable from GitHub's webhook delivery IPs (requires a public endpoint or tunnel in dev — e.g., `ngrok`, Cloudflare Tunnel, or a k3s ingress in prod)
- Webhook delivery failures are retried by GitHub for up to 72hrs — the server must be idempotent on re-delivery
- The `/health` endpoint is unauthenticated and returns no sensitive data — safe to expose publicly
