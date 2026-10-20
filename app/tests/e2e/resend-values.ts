/**
 * The e2e run's Resend webhook (newsletter campaigns, Task 5): the signing secret the app's server is started with (RESEND_WEBHOOK_SECRET,
 * tests/local-secrets.ts LOCAL_ENV) and the spec signs its fake events with. Made up and local, not a secret: Resend's own are `whsec_` and
 * base64 bytes, and so is this one. Only the webhook is set up for the run; the marketing key stays blank (LOCAL_ENV), so nothing is ever
 * synced with Resend or sent.
 */
export const E2E_RESEND = {
  webhookSecret: `whsec_${Buffer.from("e2e-resend-webhook-signing-key-not-a-real-one").toString("base64")}`,
} as const;
