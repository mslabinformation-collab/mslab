import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0015 (newsletter campaigns, phase 4 piece 5) as the Railway database goes through it (the test stops at 0015 and checks it in plain SQL: migration 0016
// drops again the Resend columns and the table this one adds, so the code's schema no longer names them): 0000–0014 applied, subscribers written by the
// code of 0014 (which knows no Resend contact), then 0015. The two new tables are there, empty, and `subscribers` gains two nullable columns
// without touching a row: the migration only adds. The rules fail by the name of their index (the database's own error, so that another failure
// cannot pass for it): one suppression per address. `mail_suppressions.email` is a plain unique index; the code stores the address in lower case
// (as `subscribers.email` is stored), the database does not fold the case itself.

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
/** A timestamp as a raw query gives it: drizzle's PGlite driver returns text in the session's zone ("2026-10-19 10:00:00+02"), not a Date. */
const time = (v: unknown) => new Date(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
type Info = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };
const shape = (rows: Info[]) => Object.fromEntries(rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]));

test("0015 adds newsletter_campaigns and mail_suppressions, empty, and two nullable columns to subscribers; the old subscribers are untouched", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0014_reviews");
  // the code of 0014's rows (raw SQL: drizzle would name the columns 0015 adds): a confirmed Estonian subscriber, a Russian one and one still unconfirmed
  await db.execute(
    sql`insert into subscribers (email, locale, token, consent_at, confirmed_at) values
      ('kati@example.test', 'et', 'tok-kati', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'),
      ('mari@example.test', 'ru', 'tok-mari', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z'),
      ('liis@example.test', 'et', 'tok-liis', '2026-09-01T09:00:00Z', null)`,
  );
  const rowsBefore = await db.execute<Record<string, unknown>>(sql`select * from subscribers order by id`);
  const columnsBefore = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const tablesBefore = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const indexesBefore = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'subscribers' order by indexname`);
  expect(rowsBefore.rows).toHaveLength(3);

  await through("0015_newsletter_campaigns");

  // the migration only adds: two columns of subscribers and the two new tables' columns, nothing removed
  const columnsAfter = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const isNew = (c: Column) => !columnsBefore.rows.some((b) => b.table_name === c.table_name && b.column_name === c.column_name);
  expect(columnsAfter.rows.filter(isNew).map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
    "mail_suppressions.cleared_at", "mail_suppressions.email", "mail_suppressions.id", "mail_suppressions.reason", "mail_suppressions.since",
    "newsletter_campaigns.body", "newsletter_campaigns.broadcasts", "newsletter_campaigns.button_href", "newsletter_campaigns.button_label",
    "newsletter_campaigns.code", "newsletter_campaigns.created_at", "newsletter_campaigns.id", "newsletter_campaigns.image_key", "newsletter_campaigns.name",
    "newsletter_campaigns.preheader", "newsletter_campaigns.recipients", "newsletter_campaigns.sent_at", "newsletter_campaigns.status",
    "newsletter_campaigns.subject", "newsletter_campaigns.updated_at",
    "subscribers.resend_contact_id", "subscribers.synced_at",
  ]);
  expect(columnsBefore.rows.filter((b) => !columnsAfter.rows.some((c) => b.table_name === c.table_name && b.column_name === c.column_name))).toEqual([]);
  const tablesAfter = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  expect(tablesAfter.rows.filter((t) => !tablesBefore.rows.some((b) => b.table_name === t.table_name)).map((t) => t.table_name)).toEqual(["mail_suppressions", "newsletter_campaigns"]);

  // (the rest runs at 0015 itself, in plain SQL: the code's schema no longer names what migration 0016 drops again — subscribers.resend_contact_id and
  // synced_at, newsletter_campaigns.broadcasts, the table mail_suppressions — so drizzle's typed queries cannot be used for them; and no later migration can
  // break what this one checks)

  // subscribers: the old rows are byte for byte what they were, with the two new columns empty ("not synced")
  const rowsAfter = await db.execute<Record<string, unknown>>(sql`select * from subscribers order by id`);
  expect(rowsAfter.rows.map(({ resend_contact_id, synced_at, ...rest }) => ({ rest, resend_contact_id, synced_at }))).toEqual(
    rowsBefore.rows.map((rest) => ({ rest, resend_contact_id: null, synced_at: null })),
  );
  const old = await db.execute<{ id: number; email: string; locale: string; resend_contact_id: string | null; synced_at: Date | null }>(
    sql`select id, email, locale, resend_contact_id, synced_at from subscribers order by id`,
  );
  expect(old.rows.map((s) => [s.email, s.locale, s.resend_contact_id, s.synced_at])).toEqual([
    ["kati@example.test", "et", null, null], ["mari@example.test", "ru", null, null], ["liis@example.test", "et", null, null],
  ]);
  const subscriberColumns = await db.execute<Info>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'subscribers' order by column_name`);
  expect(shape(subscriberColumns.rows)).toMatchObject({ resend_contact_id: "text null", synced_at: "timestamp with time zone null" });
  expect(subscriberColumns.rows.filter((c) => ["resend_contact_id", "synced_at"].includes(c.column_name)).map((c) => c.column_default)).toEqual([null, null]);
  // (a subscriber still has its one index: nothing is added there)
  const indexesAfter = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'subscribers' order by indexname`);
  expect(indexesAfter.rows).toEqual(indexesBefore.rows);
  // the sync marks are written by the code, and cleared by it
  const [kati] = old.rows;
  const stamp = new Date("2026-10-19T08:00:00Z");
  await db.execute(sql`update subscribers set resend_contact_id = 'c-1', synced_at = ${stamp.toISOString()} where id = ${kati.id}`);
  const marked = (await db.execute<{ resend_contact_id: string; synced_at: string }>(sql`select resend_contact_id, synced_at from subscribers where id = ${kati.id}`)).rows[0];
  expect([marked.resend_contact_id, time(marked.synced_at)]).toEqual(["c-1", stamp]);
  await db.execute(sql`update subscribers set synced_at = null where id = ${kati.id}`);
  expect((await db.execute<{ synced_at: Date | null }>(sql`select synced_at from subscribers where id = ${kati.id}`)).rows[0].synced_at).toBeNull();

  // newsletter_campaigns: empty; the columns, their types, which may be empty; the defaults are 'draft' (status) and now() (the two stamps), none else
  expect((await db.execute(sql`select * from newsletter_campaigns`)).rows).toEqual([]);
  const campaignInfo = await db.execute<Info>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'newsletter_campaigns' order by column_name`);
  expect(shape(campaignInfo.rows)).toEqual({
    body: "jsonb not null", broadcasts: "jsonb null", button_href: "text null", button_label: "jsonb null", code: "text null",
    created_at: "timestamp with time zone not null", id: "integer not null", image_key: "text null", name: "text not null", preheader: "jsonb not null",
    recipients: "jsonb null", sent_at: "timestamp with time zone null", status: "text not null", subject: "jsonb not null", updated_at: "timestamp with time zone not null",
  });
  expect(Object.fromEntries(campaignInfo.rows.filter((c) => c.column_default !== null && c.column_name !== "id").map((c) => [c.column_name, c.column_default]))).toEqual({
    created_at: "now()", status: "'draft'::text", updated_at: "now()",
  });

  // a draft with only what is required: draft, not sent, nothing recorded, its stamps set
  const [draft] = (
    await db.execute<Record<string, unknown>>(
      sql`insert into newsletter_campaigns (name, subject, preheader, body) values ('Oktoober', '{"et":"Sügis"}', '{"et":""}', '{"et":"Tere!"}') returning *`,
    )
  ).rows;
  expect(draft).toMatchObject({
    name: "Oktoober", subject: { et: "Sügis" }, preheader: { et: "" }, body: { et: "Tere!" }, image_key: null, code: null, button_label: null, button_href: null,
    status: "draft", sent_at: null, recipients: null, broadcasts: null,
  });
  expect(time(draft.created_at).getTime()).not.toBeNaN();
  expect(time(draft.updated_at).getTime()).not.toBeNaN();
  // a campaign as it is after the send: the status, the time, the counts and the broadcast ids are stored as they were written
  const sentAt = new Date("2026-10-20T07:00:00Z");
  const [sent] = (
    await db.execute<Record<string, unknown>>(
      sql`insert into newsletter_campaigns (name, subject, preheader, body, image_key, code, button_label, button_href, status, sent_at, recipients, broadcasts) values
        ('Saadetud', '{"et":"S","ru":"С"}', '{"et":"E","ru":"Р"}', '{"et":"T","ru":"Т"}', 'img/flyer.jpg', 'SUGIS15', '{"et":"Ava","ru":"Открыть"}', '/koolitused', 'sent',
         ${sentAt.toISOString()}, '{"et":12,"ru":3}', '{"et":"b-et","ru":"b-ru"}') returning *`,
    )
  ).rows;
  expect(sent).toMatchObject({
    status: "sent", recipients: { et: 12, ru: 3 }, broadcasts: { et: "b-et", ru: "b-ru" }, button_label: { et: "Ava", ru: "Открыть" }, image_key: "img/flyer.jpg",
  });
  expect(time(sent.sent_at)).toEqual(sentAt);
  // (a campaign has no unique rule: two with one name are fine, and "Kopeeri" makes a second draft of the first)
  const [copy] = (
    await db.execute<{ id: number }>(sql`insert into newsletter_campaigns (name, subject, preheader, body) select name, subject, preheader, body from newsletter_campaigns where id = ${draft.id as number} returning id`)
  ).rows;
  expect(copy.id).not.toBe(draft.id);
  // a campaign needs its name, subject, preview line and text (the columns are not null, and have no default)
  await violates(db.execute(sql`insert into newsletter_campaigns (subject, preheader, body) values ('{"et":"s"}', '{"et":""}', '{"et":"t"}')`), "name");
  await violates(db.execute(sql`insert into newsletter_campaigns (name, preheader, body) values ('n', '{"et":""}', '{"et":"t"}')`), "subject");
  await violates(db.execute(sql`insert into newsletter_campaigns (name, subject, body) values ('n', '{"et":"s"}', '{"et":"t"}')`), "preheader");
  await violates(db.execute(sql`insert into newsletter_campaigns (name, subject, preheader) values ('n', '{"et":"s"}', '{"et":""}')`), "body");

  // mail_suppressions: empty; the columns, their types, which may be empty; no defaults at all (the code says when it began)
  expect((await db.execute(sql`select * from mail_suppressions`)).rows).toEqual([]);
  const suppressionInfo = await db.execute<Info>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'mail_suppressions' order by column_name`);
  expect(shape(suppressionInfo.rows)).toEqual({
    cleared_at: "timestamp with time zone null", email: "text not null", id: "integer not null", reason: "text not null", since: "timestamp with time zone not null",
  });
  expect(suppressionInfo.rows.filter((c) => c.column_default !== null && c.column_name !== "id")).toEqual([]);
  // its one index besides the key: the address is unique (mail_suppressions_email)
  const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'mail_suppressions' and indexname not like '%_pkey' order by indexname`);
  expect(indexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual(["CREATE UNIQUE INDEX mail_suppressions_email ON mail_suppressions USING btree (email)"]);

  // one row per address: a second row for it is refused, a different address is not; a cleared one stays a row (the code sets cleared_at, never inserts again)
  type Suppression = { id: number; email: string; reason: string; since: string; cleared_at: string | null };
  const since = new Date("2026-10-18T10:00:00Z");
  const suppress = (email: string, reason: string) =>
    db.execute<Suppression>(sql`insert into mail_suppressions (email, reason, since) values (${email}, ${reason}, ${since.toISOString()}) returning *`);
  const suppression = async (id: number) => (await db.execute<Suppression>(sql`select * from mail_suppressions where id = ${id}`)).rows[0];
  const [bounced] = (await suppress("kati@example.test", "bounce")).rows;
  expect(bounced).toMatchObject({ email: "kati@example.test", reason: "bounce", cleared_at: null });
  expect(time(bounced.since)).toEqual(since);
  await violates(suppress("kati@example.test", "complaint"), "mail_suppressions_email");
  const [complaint] = (await suppress("mari@example.test", "complaint")).rows;
  expect(complaint.id).not.toBe(bounced.id);
  const clearedAt = new Date("2026-10-19T10:00:00Z");
  await db.execute(sql`update mail_suppressions set cleared_at = ${clearedAt.toISOString()} where id = ${bounced.id}`);
  expect(time((await suppression(bounced.id)).cleared_at)).toEqual(clearedAt);
  await violates(suppress("kati@example.test", "other"), "mail_suppressions_email"); // (the cleared row still holds the address)
  // upsert on the address, the way the webhook will write it
  await db.execute(
    sql`insert into mail_suppressions (email, reason, since) values ('kati@example.test', 'other', ${since.toISOString()})
      on conflict (email) do update set reason = 'other', since = ${since.toISOString()}, cleared_at = null`,
  );
  const upserted = await suppression(bounced.id);
  expect([upserted.reason, time(upserted.since), upserted.cleared_at]).toEqual(["other", since, null]);
  // an address needs its reason and its time
  await violates(db.execute(sql`insert into mail_suppressions (email, since) values ('x@example.test', now())`), "reason");
  await violates(db.execute(sql`insert into mail_suppressions (email, reason) values ('x@example.test', 'bounce')`), "since");
  await violates(db.execute(sql`insert into mail_suppressions (reason, since) values ('bounce', now())`), "email");
  // a suppression is its own: a subscriber's deletion does not touch it (a student who never subscribed can be suppressed too)
  await db.execute(sql`delete from subscribers where id = ${kati.id}`);
  expect((await db.execute<{ email: string }>(sql`select email from mail_suppressions order by email`)).rows.map((s) => s.email)).toEqual(["kati@example.test", "mari@example.test"]);
});
