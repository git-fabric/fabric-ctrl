import { App } from "@octokit/app";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * auth.ts — zero-trust GitHub App authentication
 *
 * All Octokit clients are derived from short-lived installation tokens.
 * No PATs. No long-lived credentials. The App private key is the only
 * long-lived secret and must be kept out of the repo.
 */

function loadPrivateKey(): string {
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!keyPath) throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is required");
  return readFileSync(resolve(keyPath), "utf-8");
}

let _app: App | null = null;

export function getApp(): App {
  if (_app) return _app;

  const appId = process.env.GITHUB_APP_ID;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!appId) throw new Error("GITHUB_APP_ID is required");
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");

  _app = new App({
    appId,
    privateKey: loadPrivateKey(),
    webhooks: { secret: webhookSecret },
    oauth: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  });

  return _app;
}

/**
 * Returns an installation-scoped Octokit client.
 * Tokens are short-lived (~1hr) and automatically refreshed by @octokit/app.
 */
export async function getInstallationOctokit() {
  const app = getApp();
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (!installationId) throw new Error("GITHUB_INSTALLATION_ID is required");
  return app.getInstallationOctokit(Number(installationId));
}
