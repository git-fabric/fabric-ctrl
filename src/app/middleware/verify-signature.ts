import type { Context, Next } from "hono";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * middleware/verify-signature.ts
 *
 * Zero-trust webhook verification.
 * Every inbound webhook is verified against the HMAC-SHA256 signature
 * GitHub sends in the X-Hub-Signature-256 header.
 * Requests without a valid signature are rejected — no exceptions.
 */
export async function verifyGitHubSignature(
  c: Context,
  next: Next
): Promise<Response | void> {
  const signature = c.req.header("x-hub-signature-256");
  if (!signature) {
    console.warn("[webhook:verify] Missing signature header — rejected");
    return c.json({ error: "Missing signature" }, 401);
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set");

  const body = await c.req.text();
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    console.warn("[webhook:verify] Invalid signature — rejected");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Re-attach raw body for downstream handlers
  c.set("rawBody", body);
  await next();
}
