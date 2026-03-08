import type { EmitterWebhookEvent } from "@octokit/webhooks";

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
    // TODO: emit to audit log, notify via Slack
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
      // TODO: trigger deeper scan via git-fabric/cve or Sandfly app
    }
  }
}
