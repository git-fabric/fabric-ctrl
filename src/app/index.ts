import "dotenv/config";
import { Hono } from "hono";

type AppEnv = { Variables: { rawBody: string } };

import { getApp } from "./auth.js";
import { verifyGitHubSignature } from "./middleware/verify-signature.js";
import { handlePush } from "./handlers/push.js";
import {
  handleCodeScanningAlert,
  handleSecretScanningAlert,
  handleRepositoryVulnerabilityAlert,
} from "./handlers/security-alert.js";
import { handleDependabotAlert } from "./handlers/dependabot.js";
import {
  handleMember,
  handleOrganization,
  handleWorkflowRun,
} from "./handlers/audit.js";

/**
 * app/index.ts — fabric-ctrl GitHub App webhook server
 *
 * Single entry point for all inbound GitHub org events.
 * Every request is signature-verified before processing.
 */

const app = new Hono<AppEnv>();
const githubApp = getApp();

// Wire Octokit webhook handlers
githubApp.webhooks.on("push", handlePush);
githubApp.webhooks.on("code_scanning_alert", handleCodeScanningAlert);
githubApp.webhooks.on("secret_scanning_alert", handleSecretScanningAlert);
githubApp.webhooks.on(
  "repository_vulnerability_alert",
  handleRepositoryVulnerabilityAlert
);
githubApp.webhooks.on("dependabot_alert", handleDependabotAlert);
githubApp.webhooks.on("member", handleMember);
githubApp.webhooks.on("organization", handleOrganization);
githubApp.webhooks.on("workflow_run", handleWorkflowRun);

// Catch-all error handler
githubApp.webhooks.onError((error) => {
  console.error("[webhook:error]", error);
});

// Webhook route — signature verified before dispatch
app.post(
  process.env.WEBHOOK_PATH ?? "/webhooks/github",
  verifyGitHubSignature,
  async (c) => {
    const eventName = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const rawBody = c.get("rawBody") as string;

    console.log(`[webhook] ${eventName} [${deliveryId}]`);

    await githubApp.webhooks.verifyAndReceive({
      id: deliveryId,
      name: eventName as any,
      signature,
      payload: rawBody,
    });

    return c.json({ ok: true });
  }
);

// Health check — no auth required, no sensitive data
app.get("/health", (c) => c.json({ status: "ok", service: "fabric-ctrl" }));

const port = Number(process.env.WEBHOOK_PORT ?? 3000);
console.log(`[fabric-ctrl:app] Webhook server listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};
