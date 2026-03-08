import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { writeAuditLog } from "../audit-log.js";
import { notify } from "../notify.js";

/**
 * handlers/audit.ts
 * Handles org membership, repository permission, and workflow changes.
 *
 * Zero-trust posture: all access changes are audited and anomalies flagged.
 * Principle of least privilege — any permission escalation is suspicious.
 */

export async function handleMember(
  event: EmitterWebhookEvent<"member">
): Promise<void> {
  const { action, member, repository } = event.payload;
  const login = member?.login ?? "unknown";
  console.log(
    `[audit:member] ${action} — ${login} on ${repository.full_name}`
  );

  if (action === "added") {
    console.warn(
      `[audit:access-grant] ${login} granted access to ${repository.full_name} — verify authorization`
    );

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "access-grant",
      severity: "medium",
      event: `${login} granted access to ${repository.full_name}`,
      repo: repository.full_name,
      actor: login,
    });

    await notify({
      channel: "audit",
      severity: "medium",
      title: `Access granted: ${login} → ${repository.full_name}`,
      body: `Verify this access grant is authorized.`,
      repo: repository.full_name,
    });
  }
}

export async function handleOrganization(
  event: EmitterWebhookEvent<"organization">
): Promise<void> {
  const { action } = event.payload;

  // All org-level changes are high-signal in a ZT posture
  const highSignalActions = [
    "member_added",
    "member_removed",
    "member_invited",
  ];

  if (highSignalActions.includes(action)) {
    console.warn(`[audit:org] ${action} — review immediately`);

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "org-membership",
      severity: "high",
      event: `Org membership change: ${action}`,
      detail: { action },
    });

    await notify({
      channel: "security",
      severity: "high",
      title: `Org membership: ${action}`,
      body: `Organization membership change detected. Review immediately.`,
    });
  }
}

export async function handleWorkflowRun(
  event: EmitterWebhookEvent<"workflow_run">
): Promise<void> {
  const { action, workflow_run, repository } = event.payload;

  if (workflow_run.conclusion === "failure") {
    console.log(
      `[audit:workflow] ${workflow_run.name} failed in ${repository.full_name}`
    );
  }

  // Flag workflows running on forks — potential exfiltration vector
  if (workflow_run.head_repository?.fork) {
    console.warn(
      `[audit:workflow:fork] Workflow triggered from fork in ${repository.full_name}: ${workflow_run.html_url}`
    );

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "workflow-fork",
      severity: "high",
      event: `Fork-triggered workflow in ${repository.full_name}`,
      repo: repository.full_name,
      detail: {
        workflow: workflow_run.name,
        url: workflow_run.html_url,
        headRepo: workflow_run.head_repository?.full_name,
      },
    });

    await notify({
      channel: "security",
      severity: "high",
      title: `Fork workflow: ${repository.full_name}`,
      body: `Workflow triggered from fork — potential exfiltration vector.\nWorkflow: ${workflow_run.name}`,
      url: workflow_run.html_url,
      repo: repository.full_name,
    });
  }
}
