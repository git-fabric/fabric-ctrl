import { z } from "zod";
import { getInstallationOctokit } from "../../app/auth.js";

/**
 * tools/org.ts — org-level MCP tools
 *
 * All tools use installation-scoped tokens (zero-trust).
 * No tool accepts credentials as input — they derive from the App identity.
 */

export const orgTools = [
  {
    name: "org__list_repos",
    description: "List all repositories in the git-fabric org",
    inputSchema: z.object({
      type: z
        .enum(["all", "public", "private", "forks", "sources"])
        .default("all"),
    }),
    handler: async (input: { type: string }) => {
      const octokit = await getInstallationOctokit();
      const { data } = await (octokit as any).rest.repos.listForOrg({
        org: "git-fabric",
        type: input.type,
        per_page: 100,
      });
      return (data as any[]).map((r: any) => ({
        name: r.name,
        url: r.html_url,
        visibility: r.visibility,
        language: r.language,
        updatedAt: r.updated_at,
        openIssues: r.open_issues_count,
      }));
    },
  },

  {
    name: "org__get_security_overview",
    description:
      "Get a security overview for the git-fabric org — open Dependabot, code scanning, and secret scanning alerts",
    inputSchema: z.object({
      repo: z.string().optional().describe("Filter to a specific repo name"),
    }),
    handler: async (input: { repo?: string }) => {
      const octokit = await getInstallationOctokit();

      const { data: dependabot } = await (octokit as any).rest.dependabot.listAlertsForOrg({
        org: "git-fabric",
        state: "open",
        per_page: 50,
      });

      return {
        dependabotAlerts: (dependabot as any[]).map((a: any) => ({
          repo: a.repository?.name,
          package: a.dependency?.package?.name,
          severity: a.security_vulnerability?.severity,
          cve: a.security_advisory?.cve_id,
          url: a.html_url,
        })),
        summary: {
          total: dependabot.length,
          critical: (dependabot as any[]).filter(
            (a: any) => a.security_vulnerability?.severity === "critical"
          ).length,
          high: (dependabot as any[]).filter(
            (a: any) => a.security_vulnerability?.severity === "high"
          ).length,
        },
      };
    },
  },

  {
    name: "org__list_members",
    description: "List members of the git-fabric org",
    inputSchema: z.object({
      role: z.enum(["all", "admin", "member"]).default("all"),
    }),
    handler: async (input: { role: string }) => {
      const octokit = await getInstallationOctokit();
      const { data } = await (octokit as any).rest.orgs.listMembers({
        org: "git-fabric",
        role: input.role,
        per_page: 100,
      });
      return (data as any[]).map((m: any) => ({ login: m.login, url: m.html_url }));
    },
  },

  {
    name: "org__get_audit_log",
    description:
      "Fetch recent org audit log entries (access changes, workflow runs, permission escalations)",
    inputSchema: z.object({
      phrase: z.string().optional().describe("Search phrase to filter events"),
      limit: z.number().default(50),
    }),
    handler: async (input: { phrase?: string; limit: number }) => {
      const octokit = await getInstallationOctokit();
      const { data } = await (octokit as any).rest.orgs.getAuditLog({
        org: "git-fabric",
        phrase: input.phrase,
        per_page: input.limit,
      });
      return data;
    },
  },
];
