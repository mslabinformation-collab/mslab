import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { newsletterCampaigns, newsletterDeliveries, settings, subscribers } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0016 (the simple newsletter) as the Railway database goes through it: 0000–0015 applied, with what the 0015 code could have written
// (a subscriber with a Resend contact, a campaign with its broadcasts, a suppression, the three settings rows of the Resend lists), then 0016.
// It drops what only the Resend lists used (`subscribers.resend_contact_id`, `subscribers.synced_at`, `newsletter_campaigns.broadcasts`, the table
// `mail_suppressions`) and deletes the three settings rows `resend_segments`, `resend_test_segment` and `newsletter_sync_lease`; it adds `newsletter_deliveries` and
// changes nothing else: every other row, column, table and settings row is as it was. The new table's rules fail by the name of their index or
// constraint (the database's own error, so that another failure cannot pass for it): one delivery per address and campaign, a delivery needs its
// campaign, and a campaign's deletion takes its deliveries.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

type Column = { table_name: string; column_name: string };
type Info = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };
const shape = (rows: Info[]) => Object.fromEntries(rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]));

test("0016 drops the Resend list columns and mail_suppressions, deletes the three settings rows, adds newsletter_deliveries with its rules, and touches nothing else", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0015_newsletter_campaigns");
  // what the 0015 code wrote (raw SQL: drizzle would no longer name the columns 0016 drops)
  await db.execute(
    sql`insert into subscribers (email, locale, token, consent_at, confirmed_at, resend_contact_id, synced_at) values
      ('kati@example.test', 'et', 'tok-kati', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'c-1', '2026-10-19T08:00:00Z'),
      ('mari@example.test', 'ru', 'tok-mari', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z', null, null),
      ('liis@example.test', 'et', 'tok-liis', '2026-09-01T09:00:00Z', null, null, null)`,
  );
  await db.execute(
    sql`insert into newsletter_campaigns (name, subject, preheader, body, code, status, sent_at, recipients, broadcasts) values
      ('Saadetud', '{"et":"S","ru":"С"}', '{"et":"E"}', '{"et":"T"}', 'SUGIS15', 'sent', '2026-10-20T07:00:00Z', '{"et":12,"ru":3}', '{"et":"b-et","ru":"b-ru"}'),
      ('Mustand', '{"et":"M"}', '{"et":""}', '{"et":"Tere!"}', null, 'draft', null, null, null)`,
  );
  await db.execute(sql`insert into mail_suppressions (email, reason, since) values ('kati@example.test', 'bounce', '2026-10-18T10:00:00Z')`);
  await db.execute(
    sql`insert into settings (key, value) values
      ('resend_segments', '{"et":"seg-et","ru":"seg-ru","property":"unsubscribe_url"}'),
      ('resend_test_segment', '{"id":"seg-test"}'),
      ('newsletter_sync_lease', '{"holder":"x","until":1792400000000}'),
      ('contact', '{"email":"info@example.test"}'),
      ('newsletter', '{"discountLabel":"-15%","welcomeCode":"SUGIS15"}')`,
  );
  const without = (row: Record<string, unknown>, ...columns: string[]) => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));
  const subscribersBefore = (await db.execute<Record<string, unknown>>(sql`select * from subscribers order by id`)).rows;
  const campaignsBefore = (await db.execute<Record<string, unknown>>(sql`select * from newsletter_campaigns order by id`)).rows;
  const columnsBefore = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const tablesBefore = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const indexesBefore = await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`);
  expect(subscribersBefore).toHaveLength(3);
  expect(campaignsBefore).toHaveLength(2);

  await through("0016_newsletter_simple");

  // the tables: mail_suppressions gone, newsletter_deliveries new, no other table added or removed
  const tablesAfter = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const names = (rows: { table_name: string }[]) => rows.map((t) => t.table_name);
  expect(names(tablesAfter.rows).filter((t) => !names(tablesBefore.rows).includes(t))).toEqual(["newsletter_deliveries"]);
  expect(names(tablesBefore.rows).filter((t) => !names(tablesAfter.rows).includes(t))).toEqual(["mail_suppressions"]);

  // the columns: exactly the three Resend columns and the dropped table's gone; the new table's are the only ones added
  const columnsAfter = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const label = (c: Column) => `${c.table_name}.${c.column_name}`;
  expect(columnsBefore.rows.map(label).filter((c) => !columnsAfter.rows.map(label).includes(c))).toEqual([
    "mail_suppressions.cleared_at", "mail_suppressions.email", "mail_suppressions.id", "mail_suppressions.reason", "mail_suppressions.since",
    "newsletter_campaigns.broadcasts", "subscribers.resend_contact_id", "subscribers.synced_at",
  ]);
  expect(columnsAfter.rows.map(label).filter((c) => !columnsBefore.rows.map(label).includes(c))).toEqual([
    "newsletter_deliveries.campaign_id", "newsletter_deliveries.claimed_at", "newsletter_deliveries.created_at", "newsletter_deliveries.email",
    "newsletter_deliveries.id", "newsletter_deliveries.locale", "newsletter_deliveries.sent_at", "newsletter_deliveries.status", "newsletter_deliveries.token",
  ]);

  // the indexes: the dropped table's went with it; the new table has its three (key, one delivery per address and campaign, the claim's lookup); no other changed
  const indexesAfter = await db.execute<{ tablename: string; indexname: string }>(sql`select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`);
  const indexLabel = (i: { tablename: string; indexname: string }) => `${i.tablename}.${i.indexname}`;
  expect(indexesBefore.rows.map(indexLabel).filter((i) => !indexesAfter.rows.map(indexLabel).includes(i))).toEqual(["mail_suppressions.mail_suppressions_email", "mail_suppressions.mail_suppressions_pkey"]);
  expect(indexesAfter.rows.map(indexLabel).filter((i) => !indexesBefore.rows.map(indexLabel).includes(i))).toEqual([
    "newsletter_deliveries.newsletter_deliveries_campaign_email", "newsletter_deliveries.newsletter_deliveries_campaign_status", "newsletter_deliveries.newsletter_deliveries_pkey",
  ]);

  // the rows: subscribers and campaigns are what they were, without the dropped columns; the Resend data went with them
  const subscribersAfter = (await db.execute<Record<string, unknown>>(sql`select * from subscribers order by id`)).rows;
  expect(subscribersAfter).toEqual(subscribersBefore.map((r) => without(r, "resend_contact_id", "synced_at")));
  expect(subscribersAfter.map((r) => Object.keys(r).includes("resend_contact_id") || Object.keys(r).includes("synced_at"))).toEqual([false, false, false]);
  const campaignsAfter = (await db.execute<Record<string, unknown>>(sql`select * from newsletter_campaigns order by id`)).rows;
  expect(campaignsAfter).toEqual(campaignsBefore.map((r) => without(r, "broadcasts")));
  const current = await db.select().from(subscribers).orderBy(subscribers.id);
  expect(current.map((s) => [s.email, s.locale, s.token, s.confirmedAt?.toISOString() ?? null])).toEqual([
    ["kati@example.test", "et", "tok-kati", "2026-10-01T09:00:00.000Z"], ["mari@example.test", "ru", "tok-mari", "2026-10-02T09:00:00.000Z"], ["liis@example.test", "et", "tok-liis", null],
  ]);
  const campaigns = await db.select().from(newsletterCampaigns).orderBy(newsletterCampaigns.id);
  expect(campaigns.map((c) => [c.name, c.status, c.recipients, c.code])).toEqual([["Saadetud", "sent", { et: 12, ru: 3 }, "SUGIS15"], ["Mustand", "draft", null, null]]);

  // the settings: the three rows of the Resend lists are deleted, every other row is untouched
  const keys = (await db.select().from(settings).orderBy(settings.key)).map((s) => s.key);
  expect(keys).toEqual(["contact", "newsletter"]);
  expect((await db.select().from(settings).where(eq(settings.key, "newsletter")))[0].value).toEqual({ discountLabel: "-15%", welcomeCode: "SUGIS15" });

  // newsletter_deliveries: empty; the columns and their types; which may be empty; the defaults are 'waiting' (status) and now() (the stamp), none else
  expect(await db.select().from(newsletterDeliveries)).toEqual([]);
  const info = await db.execute<Info>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'newsletter_deliveries' order by column_name`);
  expect(shape(info.rows)).toEqual({
    campaign_id: "integer not null", claimed_at: "timestamp with time zone null", created_at: "timestamp with time zone not null", email: "text not null",
    id: "integer not null", locale: "text not null", sent_at: "timestamp with time zone null", status: "text not null", token: "text not null",
  });
  expect(Object.fromEntries(info.rows.filter((c) => c.column_default !== null && c.column_name !== "id").map((c) => [c.column_name, c.column_default]))).toEqual({
    created_at: "now()", status: "'waiting'::text",
  });
  const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'newsletter_deliveries' and indexname not like '%_pkey' order by indexname`);
  expect(indexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual([
    "CREATE UNIQUE INDEX newsletter_deliveries_campaign_email ON newsletter_deliveries USING btree (campaign_id, email)",
    "CREATE INDEX newsletter_deliveries_campaign_status ON newsletter_deliveries USING btree (campaign_id, status)",
  ]);

  // a delivery as the press writes it: waiting, not claimed, not sent, its stamp set; the status then moves through the six values
  const [sentCampaign, draft] = campaigns;
  const [waiting] = await db
    .insert(newsletterDeliveries)
    .values({ campaignId: draft.id, email: "kati@example.test", locale: "et", token: "tok-kati" })
    .returning();
  expect(waiting).toMatchObject({ campaignId: draft.id, email: "kati@example.test", locale: "et", token: "tok-kati", status: "waiting", claimedAt: null, sentAt: null });
  expect(waiting.createdAt).toBeInstanceOf(Date);
  const claimedAt = new Date("2026-10-20T08:00:00Z");
  const sentAt = new Date("2026-10-20T08:00:03Z");
  await db.update(newsletterDeliveries).set({ status: "claimed", claimedAt }).where(eq(newsletterDeliveries.id, waiting.id));
  await db.update(newsletterDeliveries).set({ status: "sent", sentAt }).where(eq(newsletterDeliveries.id, waiting.id));
  expect((await db.select().from(newsletterDeliveries).where(eq(newsletterDeliveries.id, waiting.id)))[0]).toMatchObject({ status: "sent", claimedAt, sentAt });
  // one delivery per address and campaign; the same address in another campaign, and another address in the same one, are fine
  await violates(db.insert(newsletterDeliveries).values({ campaignId: draft.id, email: "kati@example.test", locale: "ru", token: "other" }), "newsletter_deliveries_campaign_email");
  const [other] = await db.insert(newsletterDeliveries).values({ campaignId: sentCampaign.id, email: "kati@example.test", locale: "et", token: "tok-kati" }).returning();
  const [mari] = await db.insert(newsletterDeliveries).values({ campaignId: draft.id, email: "mari@example.test", locale: "ru", token: "tok-mari" }).returning();
  expect(new Set([waiting.id, other.id, mari.id]).size).toBe(3);
  // a delivery needs its campaign, address, language and token (the columns are not null, and have no default), and the campaign has to exist
  await violates(db.execute(sql`insert into newsletter_deliveries (email, locale, token) values ('x@example.test', 'et', 't')`), "campaign_id");
  await violates(db.execute(sql`insert into newsletter_deliveries (campaign_id, locale, token) values (${draft.id}, 'et', 't')`), "email");
  await violates(db.execute(sql`insert into newsletter_deliveries (campaign_id, email, token) values (${draft.id}, 'x@example.test', 't')`), "locale");
  await violates(db.execute(sql`insert into newsletter_deliveries (campaign_id, email, locale) values (${draft.id}, 'x@example.test', 'et')`), "token");
  await violates(db.insert(newsletterDeliveries).values({ campaignId: 999_999, email: "x@example.test", locale: "et", token: "t" }), "newsletter_deliveries_campaign_id_newsletter_campaigns_id_fk");
  // a subscriber's deletion does not touch a delivery (it is skipped when its turn comes): the row has no foreign key to subscribers
  await db.delete(subscribers).where(eq(subscribers.email, "kati@example.test"));
  expect(await db.select({ id: newsletterDeliveries.id }).from(newsletterDeliveries).where(eq(newsletterDeliveries.email, "kati@example.test"))).toHaveLength(2);
  // a campaign's deletion takes its deliveries (and only its own)
  await db.delete(newsletterCampaigns).where(eq(newsletterCampaigns.id, draft.id));
  expect((await db.select().from(newsletterDeliveries)).map((d) => d.id)).toEqual([other.id]);
});
