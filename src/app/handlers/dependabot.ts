import type { EmitterWebhookEvent } from "@octokit/webhooks";

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
      // TODO: call git-fabric/cve MCP tool: cve__triage_alert
      // TODO: open remediation PR via git-fabric/git MCP tool
    } else {
      // Medium/low — log for batch triage
      console.log(`[dependabot:queue] ${cve} queued for batch triage`);
      // TODO: append to triage queue in state store
    }
  }

  if (action === "auto_dismissed") {
    // Zero-trust: log all auto-dismissals for audit
    console.warn(
      `[dependabot:audit] Auto-dismissed alert for ${pkg} in ${repository.full_name} — verify this is intentional`
    );
  }
}
