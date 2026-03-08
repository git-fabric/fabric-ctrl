import type { EmitterWebhookEvent } from "@octokit/webhooks";

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
    // TODO: write to audit log store
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
    // TODO: notify security channel, write to audit log
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
  }
}
