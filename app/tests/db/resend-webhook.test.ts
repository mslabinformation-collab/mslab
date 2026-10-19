import { createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebhookEventPayload } from "resend";
import type { Db } from "@/db/client";
import { kvEntries, mailSuppressions, subscribers } from "@/db/schema";
import { handleWebhook, SEGMENT_NAMES, type MarketingDeps } from "@/server/resend-marketing";
import { fakeKv } from "../fakes";
import { fakeResend, type FakeResend } from "./resend-fake";
import { makeTestDb } from "./helpers";

// POST /api/resend/webhook: Resend's signed events (svix headers, checked by the resend package's webhooks.verify against the raw body and
// RESEND_WEBHOOK_SECRET) bring back what happens on Resend's side (newsletter campaigns, spec D3, D10): a contact that unsubscribed there
// (contact.updated with unsubscribed) loses her subscriber row, unless her consent is newer than the event (ruling R1); a suppression is
// recorded and cleared (suppression.added / .removed). Every verified event is answered 200, the ones the site ignores too; a bad
// signature, or no secret set, is 400. The events here are signed with a local test secret, the way Resend (svix) signs them.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { POST } from "@/app/api/resend/webhook/route";

const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const NOW = new Date("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

/** The svix signature of a payload: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" with the secret's bytes, as `v1,<signature>`. */
function sign(id: string, timestamp: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

let seq = 0;
/**
 * A POST as Resend sends it: the raw JSON body and the three svix headers. `signedBody`: the body the signature is made for (default: the one
 * sent); `headers` overrides the headers (null leaves one out).
 */
function post(event: unknown, o: { id?: string; timestamp?: number; secret?: string; signedBody?: string; headers?: Record<string, string | null> } = {}) {
  const body = JSON.stringify(event);
  const id = o.id ?? `msg_${++seq}`;
  const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": sign(id, timestamp, o.signedBody ?? body, o.secret) };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return POST(new Request("https://mslab.example/api/resend/webhook", { method: "POST", headers, body }));
}

const contactUpdated = (email: string, unsubscribed: boolean, createdAt = at(0)) => ({
  type: "contact.updated",
  created_at: createdAt.toISOString(),
  data: { id: "ct_1", audience_id: "seg_1", segment_ids: ["seg_1"], created_at: at(-600).toISOString(), updated_at: createdAt.toISOString(), email, first_name: null, last_name: null, unsubscribed },
});
const suppression = (type: "suppression.added" | "suppression.removed", email: string, origin: "bounce" | "complaint" | "manual" = "bounce", createdAt = at(0)) => ({
  type,
  created_at: createdAt.toISOString(),
  data: { id: "sup_1", email, origin, source_id: "em_1", created_at: createdAt.toISOString() },
});

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
  for (const name of ["RESEND_API_KEY", "RESEND_MARKETING_KEY"]) vi.stubEnv(name, ""); // the route itself never calls Resend here
  for (const method of ["info", "error", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const emails = async () => (await db.select({ email: subscribers.email }).from(subscribers)).map((r) => r.email).sort();
async function sub(email: string, consentAt = at(-60)) {
  await db.insert(subscribers).values({ email, locale: "et", token: `tok-${email}`, consentAt, confirmedAt: consentAt, syncedAt: at(-30) });
}

describe("the signature", () => {
  test("a bad signature, another secret, a changed body, an old timestamp or a missing header: 400, nothing changes; the answers are never cached", async () => {
    await sub("kati@example.test");
    const event = contactUpdated("kati@example.test", true);
    const answers = [
      await post(event, { headers: { "svix-signature": "v1,AAAA" } }),
      await post(event, { secret: `whsec_${randomBytes(24).toString("base64")}` }),
      await post(event, { signedBody: JSON.stringify(contactUpdated("kati@example.test", false)) }), // signed for another body
      await post(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      await post(event, { headers: { "svix-id": null } }),
      await post(event, { headers: { "svix-timestamp": null } }),
      await post(event, { headers: { "svix-signature": null } }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await emails()).toEqual(["kati@example.test"]);
  });

  test("no RESEND_WEBHOOK_SECRET set: 400 for every event, signed or not", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    await sub("kati@example.test");
    expect((await post(contactUpdated("kati@example.test", true))).status).toBe(400);
    expect(await emails()).toEqual(["kati@example.test"]);
  });
});

describe("verified events", () => {
  test("contact.updated with unsubscribed: the row of that address goes (any case on either side), 200 no-store", async () => {
    await sub("Kati@Example.test");
    await sub("mari@example.test");
    const res = await post(contactUpdated("KATI@example.TEST", true));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await emails()).toEqual(["mari@example.test"]);
  });

  test("R1: a consent given after the event (she signed up again since) keeps her row; the event of her own earlier unsubscribe does not undo it", async () => {
    await sub("kati@example.test", at(5));
    expect((await post(contactUpdated("kati@example.test", true, at(0)))).status).toBe(200);
    expect(await emails()).toEqual(["kati@example.test"]);
  });

  test("contact.updated without unsubscribed (the site's own updates fire it too), contact.created, email.* and an unknown type: 200, nothing changes", async () => {
    await sub("kati@example.test");
    for (const event of [
      contactUpdated("kati@example.test", false),
      { ...contactUpdated("kati@example.test", false), type: "contact.created" },
      { type: "email.delivered", created_at: at(0).toISOString(), data: { email_id: "em_1", created_at: at(0).toISOString(), from: "x", to: ["kati@example.test"], subject: "S", message_id: "m" } },
      { type: "something.new", created_at: at(0).toISOString(), data: {} },
    ]) {
      const res = await post(event);
      expect(res.status, event.type).toBe(200);
    }
    expect(await emails()).toEqual(["kati@example.test"]);
    expect(await db.select().from(mailSuppressions)).toEqual([]);
  });

  test("suppression.added is recorded in lower case with its reason and time; suppression.removed clears it; added again, it is active again", async () => {
    expect((await post(suppression("suppression.added", "Opilane@Example.test", "complaint", at(-10)))).status).toBe(200);
    expect(await db.select().from(mailSuppressions)).toMatchObject([{ email: "opilane@example.test", reason: "complaint", since: at(-10), clearedAt: null }]);
    expect((await post(suppression("suppression.removed", "OPILANE@example.test", "complaint", at(-5)))).status).toBe(200);
    expect(await db.select().from(mailSuppressions)).toMatchObject([{ email: "opilane@example.test", clearedAt: at(-5) }]);
    expect((await post(suppression("suppression.added", "opilane@example.test", "manual", at(-1)))).status).toBe(200);
    expect(await db.select().from(mailSuppressions)).toMatchObject([{ email: "opilane@example.test", reason: "other", since: at(-1), clearedAt: null }]);
    // the subscriber row is the site's: a suppression never deletes it (spec §5)
    await sub("kati@example.test");
    await post(suppression("suppression.added", "kati@example.test", "bounce"));
    expect(await emails()).toEqual(["kati@example.test"]);
  });

  test("the same svix-id twice is handled once (a retry of a delivered event): the second is answered 200 and changes nothing", async () => {
    await sub("kati@example.test");
    expect((await post(contactUpdated("kati@example.test", true), { id: "msg_same" })).status).toBe(200);
    await sub("kati@example.test", at(-60)); // signed up again, with an old consent time (a test of the mark, not of R1)
    expect((await post(contactUpdated("kati@example.test", true), { id: "msg_same" })).status).toBe(200);
    expect(await emails()).toEqual(["kati@example.test"]);
    expect((await db.select().from(kvEntries)).map((r) => r.key)).toHaveLength(1);
  });

  test("the database failing: 500, so Resend sends the event again (and no mark is kept that would skip the retry); no address in the log", async () => {
    await sub("kati@example.test");
    await db.execute(sql`alter table subscribers rename to subscribers_away`);
    try {
      expect((await post(contactUpdated("kati@example.test", true), { id: "msg_retry" })).status).toBe(500);
    } finally {
      await db.execute(sql`alter table subscribers_away rename to subscribers`);
    }
    expect((await post(contactUpdated("kati@example.test", true), { id: "msg_retry" })).status).toBe(200);
    expect(await emails()).toEqual([]);
    const lines = (["info", "error", "warn"] as const).flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat()).map(String).join("\n");
    expect(lines).toContain("[newsletter-sync]");
    expect(lines).not.toContain("@");
  });
});

describe("handleWebhook", () => {
  let fake: FakeResend;
  const deps = (): MarketingDeps => ({
    db,
    env: { KV: fakeKv(), MAIL_FROM: "x", MARIA_EMAIL: "", SITE_URL: "https://mslab.example", RESEND_MARKETING_KEY: "re_marketing_test" },
    siteUrl: "https://mslab.example",
    now: NOW,
    resend: fake.r,
    gapMs: 0,
  });

  test("a Resend-side unsubscribe: the row goes first, then her contact (the site keeps no contact without a row)", async () => {
    fake = fakeResend();
    await fake.r.segments.create({ name: SEGMENT_NAMES.et });
    fake.add("kati@example.test", { unsubscribed: true, segments: [fake.segment(SEGMENT_NAMES.et)!] });
    await sub("kati@example.test");
    await handleWebhook(deps(), contactUpdated("kati@example.test", true) as WebhookEventPayload);
    expect(await emails()).toEqual([]);
    expect(fake.contacts.size).toBe(0);
  });

  test("an event whose address is not one: ignored", async () => {
    fake = fakeResend();
    await sub("kati@example.test");
    await handleWebhook(deps(), { ...contactUpdated("kati@example.test", true), data: { ...contactUpdated("x", true).data, email: 42 } } as unknown as WebhookEventPayload);
    await handleWebhook(deps(), { type: "suppression.added", created_at: "nonsense", data: null } as unknown as WebhookEventPayload);
    expect(await emails()).toEqual(["kati@example.test"]);
    expect(await db.select().from(mailSuppressions)).toEqual([]);
  });
});
