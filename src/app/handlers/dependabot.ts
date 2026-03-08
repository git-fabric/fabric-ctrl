import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { dispatch } from "../dispatch.js";
import { writeAuditLog } from "../audit-log.js";
import { notify } from "../notify.js";

/**
 * handlers/dependabot.ts
 * Routes Dependabot alerts into the git-fabric/cve triage pipeline.
 *
 * Zero-trust posture: every dependency alert is a potential supply-chain
 * attack surface until triaged and resolved.
 */

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function handleDependabotAlert(
  event: EmitterWebhookEvent<"dependabot_alert">
): Promise<void> {
  const { action, alert, repository } = event.payload;
  const severity = alert.security_vulnerability?.severity ?? "unknown";
  const pkg = alert.dependency?.package?.name ?? "unknown";
  const cve = alert.security_advisory?.cve_id ?? "no-cve";

  console.log(
    `[dependabot] ${action} — ${pkg} (${cve}) in ${repository.full_name} [${severity}]`
  );

  if (action === "created") {
    const priority = SEVERITY_PRIORITY[severity] ?? 99;

    if (priority <= 1) {
      // Critical or high — escalate immediately
      console.warn(
        `[dependabot:escalate] ${severity.toUpperCase()} ${cve} in ${repository.full_name}: ${pkg}`
      );

      await writeAuditLog({
        timestamp: new Date().toISOString(),
        category: "dependabot",
        severity: priority === 0 ? "critical" : "high",
        event: `${severity.toUpperCase()} dependency alert: ${cve} (${pkg})`,
        repo: repository.full_name,
        detail: { cve, package: pkg, severity },
      });

      // Forward to CVE app for triage — will open PRs based on severity policy
      await dispatch("cve_triage", {
        auto_pr_threshold: "HIGH",
        max_prs_per_run: 5,
      });

      // Open remediation PR via git fabric app
      const patchedVersion =
        alert.security_vulnerability?.first_patched_version?.identifier;
      if (patchedVersion) {
        await dispatch("git_pr_create", {
          owner: repository.owner.login,
          repo: repository.name,
          title: `fix(security): ${cve} — ${severity.toUpperCase()} in ${pkg}`,
          head: `security/${cve.toLowerCase()}`,
          body: `## Dependabot Alert\n\n- **Package:** ${pkg}\n- **CVE:** ${cve}\n- **Severity:** ${severity.toUpperCase()}\n- **Patched version:** ${patchedVersion}\n\nAutomatic remediation PR opened by fabric-ctrl.`,
          draft: severity !== "critical",
          labels: ["security", "cve", "git-fabric"],
        });
      }

      await notify({
        channel: "security",
        severity: priority === 0 ? "critical" : "high",
        title: `Dependabot: ${cve} in ${repository.full_name}`,
        body: `${severity.toUpperCase()} vulnerability in \`${pkg}\`. Triage dispatched.`,
        repo: repository.full_name,
      });
    } else {
      // Medium/low — queue for batch triage
      console.log(`[dependabot:queue] ${cve} queued for batch triage`);

      await writeAuditLog({
        timestamp: new Date().toISOString(),
        category: "dependabot",
        severity: severity === "medium" ? "medium" : "low",
        event: `Queued dependency alert: ${cve} (${pkg})`,
        repo: repository.full_name,
        detail: { cve, package: pkg, severity },
      });
    }
  }

  if (action === "auto_dismissed") {
    // Zero-trust: log all auto-dismissals for audit
    console.warn(
      `[dependabot:audit] Auto-dismissed alert for ${pkg} in ${repository.full_name} — verify this is intentional`
    );

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "dependabot",
      severity: "medium",
      event: `Auto-dismissed alert for ${pkg} — verify intentional`,
      repo: repository.full_name,
      detail: { cve, package: pkg, action: "auto_dismissed" },
    });
  }
}
