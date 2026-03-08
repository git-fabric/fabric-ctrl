import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { dispatch } from "../dispatch.js";
import { writeAuditLog } from "../audit-log.js";
import { notify } from "../notify.js";

/**
 * handlers/push.ts
 * Handles push events across all git-fabric org repos.
 * Zero-trust posture: treat every push as potentially significant.
 */
export async function handlePush(
  event: EmitterWebhookEvent<"push">
): Promise<void> {
  const { ref, repository, commits, pusher } = event.payload;

  console.log(`[push] ${repository.full_name} ${ref} by ${pusher.name}`);

  // Flag direct pushes to protected branches — should never happen in ZT posture
  if (ref === "refs/heads/main" || ref === "refs/heads/master") {
    console.warn(
      `[push:warn] Direct push to ${ref} in ${repository.full_name} by ${pusher.name}`
    );

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      category: "direct-push",
      severity: "high",
      event: `Direct push to ${ref} by ${pusher.name}`,
      repo: repository.full_name,
      actor: pusher.name,
      detail: { ref, commitCount: commits.length },
    });

    await notify({
      channel: "security",
      severity: "high",
      title: `Direct push to ${ref.replace("refs/heads/", "")}`,
      body: `${pusher.name} pushed directly to ${ref} in ${repository.full_name}. This should not happen under zero-trust policy.`,
      repo: repository.full_name,
    });
  }

  // Flag commits touching sensitive paths
  const sensitivePaths = [".github/workflows", "mcp.json", ".env", "secrets/"];
  for (const commit of commits) {
    const touchedSensitive = [...(commit.added ?? []), ...(commit.modified ?? [])].filter(
      (f) => sensitivePaths.some((p) => f.startsWith(p))
    );
    if (touchedSensitive.length > 0) {
      console.warn(
        `[push:sensitive] ${commit.id.slice(0, 7)} touched: ${touchedSensitive.join(", ")}`
      );

      await writeAuditLog({
        timestamp: new Date().toISOString(),
        category: "sensitive-path",
        severity: "high",
        event: `Sensitive paths modified: ${touchedSensitive.join(", ")}`,
        repo: repository.full_name,
        actor: pusher.name,
        detail: {
          commitId: commit.id,
          paths: touchedSensitive,
        },
      });

      // Trigger deeper scan via CVE app (dependency/config changes)
      await dispatch("cve_scan", {
        repos: [repository.full_name],
        severity_threshold: "MEDIUM",
      });

      // Trigger Sandfly scan for infrastructure-level intrusion detection
      await dispatch("sandfly_start_scan", {
        host_ids: [repository.full_name],
      });

      await notify({
        channel: "security",
        severity: "high",
        title: `Sensitive paths modified in ${repository.full_name}`,
        body: `Commit ${commit.id.slice(0, 7)} touched: ${touchedSensitive.join(", ")}\nScans dispatched to CVE + Sandfly.`,
        repo: repository.full_name,
      });
    }
  }
}
