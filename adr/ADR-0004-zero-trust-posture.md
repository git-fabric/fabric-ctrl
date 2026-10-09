# ADR-0004: Zero-Trust Security Posture

**Status:** Accepted  
**Date:** 2026-03-08  
**Author:** ry-ops

---

## Context

The `git-fabric` org hosts infrastructure automation tooling. A compromise of any repo in the org is a potential pivot to real infrastructure (Proxmox, UniFi, k3s clusters, Cloudflare DNS). The security posture of `fabric-ctrl` must reflect this blast radius.

## Decision

`fabric-ctrl` adopts an explicit **zero-trust** posture across all surfaces:

### Never trust, always verify
- Every inbound webhook is HMAC-verified before dispatch — no exceptions
- Timing-safe comparison for all signature checks (prevents timing attacks)
- The `/health` endpoint is the only unauthenticated surface and returns no sensitive data

### Assume breach
- Secret scanning alerts are treated as **confirmed compromises** the moment they fire — rotation is the immediate response, investigation comes second
- Direct pushes to `main` are flagged regardless of who made them
- Auto-dismissed Dependabot alerts are logged to the audit trail — dismissal is never silent
- Workflows triggered from forks are flagged as potential exfiltration vectors

### Least privilege
- The GitHub App declares the minimum permissions required in [ADR-0001](ADR-0001-github-app-identity.md)
- Installation tokens are short-lived and never stored
- The private key never leaves the local machine — it is never committed, never logged, never transmitted

### Audit everything
- All access grants, org membership changes, and permission escalations are logged
- Audit log entries are retained for a configurable period (`AUDIT_LOG_RETENTION_DAYS`)
- The audit log is append-only from `fabric-ctrl`'s perspective — it does not modify or delete entries

### Sensitive path alerting
Changes to `.github/workflows`, `mcp.json`, `.env`, and `secrets/` in any org repo trigger elevated scrutiny — these are the paths through which supply chain attacks enter.
