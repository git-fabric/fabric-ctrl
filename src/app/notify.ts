/**
 * notify.ts — Security notification emitter
 *
 * Sends security notifications to configured channels.
 * Currently supports webhook-based notification (Slack incoming webhook,
 * Discord webhook, or any endpoint accepting a JSON payload).
 *
 * Non-throwing — notification delivery is best-effort.
 * The audit log is the source of truth, not the notification channel.
 */

export interface Notification {
  channel: "security" | "audit" | "general";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  body: string;
  url?: string;
  repo?: string;
}

const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL;
const NOTIFY_TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS ?? 5_000);

/**
 * Send a notification to the configured webhook endpoint.
 * Returns true if delivered, false otherwise.
 */
export async function notify(n: Notification): Promise<boolean> {
  if (!NOTIFY_WEBHOOK_URL) {
    console.log(`[notify:skip] No NOTIFY_WEBHOOK_URL configured — ${n.title}`);
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

    // Slack-compatible payload — works with Slack, Discord (via /slack), and generic webhooks
    const payload = {
      text: `${severityEmoji(n.severity)} *[${n.channel}:${n.severity}]* ${n.title}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${severityEmoji(n.severity)} *${n.title}*\n${n.body}${n.url ? `\n<${n.url}|View>` : ""}${n.repo ? ` | \`${n.repo}\`` : ""}`,
          },
        },
      ],
    };

    const res = await fetch(NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[notify:error] ${res.status} — ${n.title}`);
      return false;
    }

    console.log(`[notify:sent] ${n.channel}:${n.severity} — ${n.title}`);
    return true;
  } catch (err) {
    console.error(
      `[notify:fail] ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function severityEmoji(severity: Notification["severity"]): string {
  switch (severity) {
    case "critical":
      return "[CRITICAL]";
    case "high":
      return "[HIGH]";
    case "medium":
      return "[MEDIUM]";
    case "low":
      return "[LOW]";
    case "info":
      return "[INFO]";
  }
}
