import { appendFile, mkdir } from "fs/promises";
import { resolve } from "path";

/**
 * audit-log.ts — Local audit log persistence
 *
 * Append-only JSONL audit log for security events.
 * Zero-trust posture: every security-relevant event is persisted locally
 * before any downstream dispatch. The local log is the source of truth;
 * gateway/notification delivery is best-effort.
 */

export interface AuditEntry {
  timestamp: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  event: string;
  repo?: string;
  actor?: string;
  detail?: Record<string, unknown>;
}

const LOG_DIR = resolve(process.env.AUDIT_LOG_DIR ?? "./state");
const LOG_FILE = resolve(LOG_DIR, "audit.jsonl");

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

/**
 * Append an entry to the audit log.
 * Non-throwing — logs errors to stderr but never blocks the caller.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(LOG_FILE, line, "utf-8");
    console.log(`[audit-log] ${entry.category}:${entry.severity} — ${entry.event}`);
  } catch (err) {
    console.error(
      `[audit-log:error] Failed to write: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
