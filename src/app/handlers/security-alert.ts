import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { dispatch } from "../dispatch.js";
import { writeAuditLog } from "../audit-log.js";
import { notify } from "../notify.js";

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

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "code-scanning",
      severity: "critical",
      event: `Critical code scanning alert: ${rule.id}`,
      repo: repository.full_name,
      detail: { ruleId: rule.id, alertUrl: alert.html_url },
    });

    // Forward to CVE app for triage
    await dispatch("cve_scan", {
      repos: [repository.full_name],
      severity_threshold: "CRITICAL",
    });

    await notify({
      channel: "security",
      severity: "critical",
      title: `Code scanning: ${rule.id} in ${repository.full_name}`,
      body: `Critical code scanning alert requires immediate triage.`,
      url: alert.html_url,
      repo: repository.full_name,
    });
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

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "secret-scanning",
      severity: "critical",
      event: `Secret exposed: ${alert.secret_type}`,
      repo: repository.full_name,
      detail: { secretType: alert.secret_type, alertUrl: alert.html_url },
    });

    await notify({
      channel: "security",
      severity: "critical",
      title: `Secret exposed: ${alert.secret_type} in ${repository.full_name}`,
      body: `Treat as compromised. Rotate immediately.\nType: ${alert.secret_type}`,
      url: alert.html_url,
      repo: repository.full_name,
    });
  }
}

export async function handleRepositoryVulnerabilityAlert(
  event: EmitterWebhookEvent<"repository_vulnerability_alert">
): Promise<void> {
  const { action, alert, repository } = event.payload;
  console.log(
    `[vuln-alert] ${action} — ${alert.affected_package_name} in ${repository.full_name}`
  );

  // Route to CVE app for enrichment and triage
  await dispatch("cve_scan", {
    repos: [repository.full_name],
    severity_threshold: "HIGH",
  });
}
