import type { EmitterWebhookEvent } from "@octokit/webhooks";

/**
 * handlers/security-alert.ts
 * Handles code scanning, secret scanning, and repository vulnerability alerts.
 */

export async function handleCodeScanningAlert(
  event: EmitterWebhookEvent<"code_scanning_alert">
): Promise<void> {
  const { action, alert, repository } = event.payload;
  const rule = (alert as any)?.rule ?? { id: "unknown", severity: "unknown" };
  console.log(
    `[code-scanning] ${action} — ${rule.id} in ${repository.full_name} (severity: ${rule.severity})`
  );

  if (action === "created" && (rule.severity as string) === "critical") {
    console.warn(
      `[code-scanning:critical] Immediate triage required: ${alert.html_url}`
    );
    // TODO: open triage PR via git-fabric/cve MCP tools
  }
}

export async function handleSecretScanningAlert(
  event: EmitterWebhookEvent<"secret_scanning_alert">
): Promise<void> {
  const { action, alert, repository } = event.payload;
  console.warn(
    `[secret-scanning] ${action} — ${alert.secret_type} in ${repository.full_name}`
  );

  if (action === "created") {
    // Zero-trust: assume the secret is compromised the moment it's detected
    console.error(
      `[secret-scanning:CRITICAL] Secret detected. Treat as compromised: ${alert.html_url}`
    );
    // TODO: trigger rotation workflow, notify on-call
  }
}

export async function handleRepositoryVulnerabilityAlert(
  event: EmitterWebhookEvent<"repository_vulnerability_alert">
): Promise<void> {
  const { action, alert, repository } = event.payload;
  console.log(
    `[vuln-alert] ${action} — ${alert.affected_package_name} in ${repository.full_name}`
  );
  // TODO: route to Dependabot handler or cve fabric app
}
