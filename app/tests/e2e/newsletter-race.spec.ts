import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { saveCampaign, sendCampaign } from "../../src/server/newsletter-campaigns";
import type { Env } from "../../src/server/notify";
import { ensureSegments, fullSync, FullSyncBusy, SEGMENT_NAMES, SYNC_LEASE_SETTING, type MarketingDeps, type ResendLike } from "../../src/server/resend-marketing";
import { fakeResend, type FakeResend } from "../db/resend-fake";
import { inFlight, racePool } from "./race";
import { createScratchDatabase, type Scratch } from "./scratch-db";
import { expect, submitsForms, test } from "./test";

// The newsletter on real Postgres (newsletter campaigns, Task 5; rulings R9, R11; owed by Tasks 3 and 4): what the unit tests' single-connection
// PGlite cannot show, because it runs one statement at a time. The app's own fullSync and sendCampaign, in this process, on a pool of 5 connections
// (the app's own size, db/client.ts) of a SCRATCH database (scratch-db.ts: made on the local server, migrated with the app's migrations, dropped
// afterwards; the sync writes the subscribers and the settings of the whole table, which the other specs' rows must not meet). Resend is the unit
// tests' in-memory fake (tests/db/resend-fake.ts), injected in this process: the real API is never called, and no key is read.
//
// (a) THE LEASE (resend-marketing.ts takeLease / releaseLease; the setting `newsletter_sync_lease`):
// - five callers of fullSync at the same moment, on a database where the lease is absent, or held by a sync that died (its `until` has passed): exactly
//   one wins and the other four get FullSyncBusy. The winner sits at a gate inside its first Resend call until the four have been answered, so the
//   other four really tried while it held the lease; and the segments are made once (a second first-time set-up would make duplicates in Maria's Resend);
// - a holder whose lease ran out and was taken over leaves the new holder's row alone when it finishes (the release is holder-checked), the new holder
//   keeps others out until it is done, and then the row is gone.
// (b) THE SEND'S ROW LOCK (newsletter-campaigns.ts sendCampaign: the campaign row `FOR UPDATE`, its state checked again under the lock):
// - two sendCampaign of one campaign at the same moment: exactly one set of broadcasts (one a language), the other answers `busy`, `sent` or `changed`;
// - the same with the lease taken over, so that BOTH reach the row (this is the lock's own test: the lease alone would have kept the second out):
//   another connection holds the campaign row while the first send reaches it; the test then lets the second one's lease run out, so the second
//   takes it over and queues behind the first at the row (race.ts inFlight proves both wait, in the order started); when the row is let go the
//   first writes `sending` and sends, and the second finds the row already sent (`sent`) and sends nothing.
// Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const APPLICATION = `mslab-e2e-newsletter-race-${process.pid}`;
const SITE = "https://mslab.example";
const loggedInfo = console.info;

let scratch: Scratch;
let pool: postgres.Sql;
let db: Db;
/** Connections of their own to the scratch database (named so, under no `application_name`): the tests' reads and writes, and the lock `inFlight` holds (one of the three, in a transaction). */
let other: postgres.Sql;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = await createScratchDatabase("newsletter");
  ({ pool, db } = racePool(APPLICATION, scratch.url, 5));
  other = postgres(scratch.url, { max: 3, connect_timeout: 20, onnotice: () => {} });
  console.info = () => {}; // (the app's own log lines, ids and counts only: not the test's output)
});
test.afterAll(async () => {
  console.info = loggedInfo;
  await pool?.end();
  await other?.end();
  await scratch?.drop();
});
test.beforeEach(async () => {
  submitsForms();
  test.setTimeout(60_000);
  await other`truncate table newsletter_campaigns, subscribers, settings, mail_suppressions restart identity`;
});

// ---------- what both parts use ----------

const env: Env = {
  KV: { get: async () => null, put: async () => {} },
  MAIL_FROM: "MS LAB <info@send.example.test>",
  MARIA_EMAIL: "maria@example.com",
  SITE_URL: SITE,
  RESEND_MARKETING_KEY: "re_marketing_test", // (a made-up value: the fake never looks at it)
};
const deps = (resend: ResendLike): MarketingDeps => ({ db, env, siteUrl: SITE, now: new Date(), resend, gapMs: 0 });

/** `n` confirmed subscribers, a third of them Russian (consent an hour ago: the sync's R1 check leaves them be). */
async function subscribers(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await other`
      insert into subscribers (email, locale, token, consent_at, confirmed_at)
      values (${`race-${i}@example.com`}, ${i % 3 === 0 ? "ru" : "et"}, ${`race-token-${i}-${"x".repeat(24)}`}, now() - interval '1 hour', now() - interval '1 hour')`;
  }
}

/** The lease row as the database holds it, if any. */
async function lease(): Promise<{ holder: string; until: number } | null> {
  const [row] = await other<{ value: { holder: string; until: number } }[]>`select value from settings where key = ${SYNC_LEASE_SETTING}`;
  return row?.value ?? null;
}

/**
 * A Resend whose every call waits at a gate: the first one to reach it says so (`entered`), and none goes on before `open()`. Wraps the fake's
 * methods, so everything else about it (contacts, segments, broadcasts) is the fake's own.
 */
function gated(fake: FakeResend) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const hold = async () => {
    enter();
    await opened;
  };
  const wrap = (part: object): object =>
    Object.fromEntries(
      Object.entries(part).map(([key, value]) => [
        key,
        typeof value === "function"
          ? async (...args: unknown[]) => {
              await hold();
              return (value as (...a: unknown[]) => unknown)(...args);
            }
          : wrap(value as object),
      ]),
    );
  const { webhooks, ...calls } = fake.r;
  return { r: { ...(wrap(calls) as Omit<ResendLike, "webhooks">), webhooks } as ResendLike, open, entered };
}

type Outcome = { ok: true; report: Awaited<ReturnType<typeof fullSync>> } | { ok: false; error: unknown };
const outcome = (call: Promise<Awaited<ReturnType<typeof fullSync>>>): Promise<Outcome> =>
  call.then(
    (report) => ({ ok: true as const, report }),
    (error: unknown) => ({ ok: false as const, error }),
  );

// ---------- (a) the lease ----------

test.describe("the full sync's lease", () => {
  for (const start of ["absent", "expired"] as const) {
    test(`five callers at the same moment, the lease ${start}: exactly one wins, four get FullSyncBusy, the segments are made once`, async () => {
      for (let round = 1; round <= 6; round++) {
        await other`truncate table subscribers, settings restart identity`;
        await subscribers(3);
        // a sync that died holding the lease: its time is past, so the next one takes it over (or: no row at all)
        if (start === "expired") await other`insert into settings (key, value) values (${SYNC_LEASE_SETTING}, ${other.json({ holder: "dead", until: Date.now() - 1000 })})`;
        const fake = fakeResend();
        const gate = gated(fake);
        let answered = 0;
        const callers = Array.from({ length: 5 }, () => outcome(fullSync(deps(gate.r))).then((o) => (answered++, o)));
        // the winner stands at the gate in its first call, holding the lease, while the other four are answered
        await gate.entered;
        await expect.poll(() => answered, { message: `round ${round}: four callers are answered while one holds the lease`, timeout: 15_000 }).toBe(4);
        const held = await lease();
        expect(held?.holder, `round ${round}: the winner holds the lease`).toBeTruthy();
        expect(held?.holder, `round ${round}: and not the dead one`).not.toBe("dead");
        gate.open();
        const results = await Promise.all(callers);

        const won = results.filter((o) => o.ok);
        const busy = results.filter((o) => !o.ok && o.error instanceof FullSyncBusy);
        expect(won.length, `round ${round}: callers that synced`).toBe(1);
        expect(busy.length, `round ${round}: callers refused as busy`).toBe(4);
        expect(results.length).toBe(won.length + busy.length); // (nothing failed another way)
        expect(fake.calls.filter((c) => c === "segments.create"), `round ${round}: the two segments are made once`).toHaveLength(2);
        expect([...fake.contacts.values()].map((c) => c.email).sort(), `round ${round}: the winner's sync pushed the three subscribers`).toEqual(["race-1@example.com", "race-2@example.com", "race-3@example.com"]);
        expect(await lease(), `round ${round}: the winner gave the lease back`).toBeNull();
      }
    });
  }

  test("a holder whose lease ran out and was taken over leaves the new holder's row alone; the new holder keeps the others out until it is done", async () => {
    await subscribers(2);
    const fake = fakeResend();
    await ensureSegments(deps(fake.r)); // (the segments exist, so a sync's first call is not inside their set-up's transaction)

    // A holds the lease and is slow: it stands at its gate
    const a = gated(fake);
    const syncA = outcome(fullSync(deps(a.r)));
    await a.entered;
    const holderA = (await lease())?.holder;
    expect(holderA, "A holds the lease").toBeTruthy();

    // A's time runs out (the lease row says so; A does not know)
    await other`update settings set value = jsonb_set(value, '{until}', to_jsonb(${Date.now() - 1000}::bigint)) where key = ${SYNC_LEASE_SETTING}`;

    // B takes it over, and stands at its own gate
    const b = gated(fake);
    const syncB = outcome(fullSync(deps(b.r)));
    await b.entered;
    const holderB = (await lease())?.holder;
    expect(holderB, "B holds a lease of its own now").toBeTruthy();
    expect(holderB).not.toBe(holderA);

    // A finishes: its release is for A's lease, and the row is B's now
    a.open();
    const doneA = await syncA;
    expect(doneA.ok, "A, slow but not stopped, finishes its sync").toBe(true);
    const after = await lease();
    expect(after?.holder, "A's release left B's lease alone").toBe(holderB);
    expect(after!.until, "and it is still B's to hold").toBeGreaterThan(Date.now());

    // so a third caller is kept out while B works
    const c = await outcome(fullSync(deps(fake.r)));
    expect(c.ok, "C, while B holds the lease").toBe(false);
    expect(!c.ok && c.error instanceof FullSyncBusy).toBe(true);
    expect((await lease())?.holder, "C changed nothing").toBe(holderB);

    // B is done: the row is gone, and the next caller syncs
    b.open();
    expect((await syncB).ok, "B finishes").toBe(true);
    expect(await lease(), "B gave its lease back").toBeNull();
    expect((await outcome(fullSync(deps(fake.r)))).ok, "the next caller").toBe(true);
    expect(await lease()).toBeNull();
  });
});

// ---------- (b) the send's row lock ----------

/** When the race's campaign is saved: the time its confirmation carries (CONFIRMED, the review's M3). */
const SAVED_AT = new Date("2026-10-19T10:00:00.000Z");

/** Maria's campaign as the editor sends it, saved through the rules at SAVED_AT; the id. */
async function campaign(): Promise<number> {
  const saved = await saveCampaign(
    db,
    null,
    {
      name: "Oktoobri pakkumine",
      subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
      preheader: { et: "−15% kõigile koolitustele", ru: "Скидка 15% на все курсы" },
      imageKey: null,
      body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац.\n\nВторой абзац." },
      code: "sugis15",
      buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
      buttonHref: "/koolitused",
    },
    SAVED_AT,
  );
  if (!saved.ok) throw new Error(`the campaign was refused: ${JSON.stringify(saved)}`);
  return saved.id;
}

/** What Maria confirmed: three subscribers make two Estonian ones and one Russian one (subscribers()), of the campaign saved at SAVED_AT. */
const CONFIRMED = { et: 2, ru: 1, updatedAt: SAVED_AT.toISOString() };
const COUNTS = { et: 2, ru: 1 };

async function stored(id: number) {
  const [row] = await other<{ status: string; recipients: { et: number; ru: number } | null; broadcasts: { et?: string; ru?: string } | null }[]>`
    select status, recipients, broadcasts from newsletter_campaigns where id = ${id}`;
  return row;
}

/** What a set of broadcasts looks like: one to the Estonian segment and one to the Russian one, each to its subscribers. */
function expectOneSet(fake: FakeResend, where: string): void {
  const segmentOf = (name: string) => fake.segment(name);
  expect(fake.broadcasts, `${where}: broadcasts made`).toHaveLength(2);
  expect(fake.broadcasts.map((b) => b.args.segmentId).sort(), `${where}: one to each language's segment`).toEqual([segmentOf(SEGMENT_NAMES.et)!, segmentOf(SEGMENT_NAMES.ru)!].sort());
  const reached = fake.broadcasts.flatMap((b) => b.delivered.map((d) => d.email)).sort();
  expect(reached, `${where}: every subscriber got the mail once`).toEqual(["race-1@example.com", "race-2@example.com", "race-3@example.com"]);
}

test.describe("the send's row lock", () => {
  test("two sends of one campaign at the same moment make one set of broadcasts; the other is told busy, sent or changed", async () => {
    for (let round = 1; round <= 8; round++) {
      await other`truncate table newsletter_campaigns, subscribers, settings restart identity`;
      await subscribers(3);
      const id = await campaign();
      const fake = fakeResend();
      const [first, second] = await Promise.all([sendCampaign(deps(fake.r), id, CONFIRMED), sendCampaign(deps(fake.r), id, CONFIRMED)]);

      const done = [first, second].filter((r) => r.ok);
      const refused = [first, second].filter((r) => !r.ok);
      expect(done.length, `round ${round}: sends that went (${JSON.stringify([first, second].map((r) => (r.ok ? "ok" : r.error)))})`).toBe(1);
      expect(refused.map((r) => (r.ok ? "" : r.error))[0], `round ${round}: the other one`).toMatch(/^(busy|sent|changed)$/);
      expectOneSet(fake, `round ${round}`);
      expect(await stored(id), `round ${round}`).toMatchObject({ status: "sent", recipients: COUNTS, broadcasts: { et: expect.any(String), ru: expect.any(String) } });
    }
  });

  test("with the second send's lease taken over, both reach the campaign's row: the first writes `sending` and sends, the second finds it sent and sends nothing", async () => {
    await subscribers(3);
    const id = await campaign();
    const fake = fakeResend();
    const holdRow = (tx: postgres.TransactionSql) => tx`select id from newsletter_campaigns where id = ${id} for update`;
    // the second send starts when the first is seen waiting for the row: its lease runs out first (the first send's `until` is in the past), so it takes it over
    const second = async () => {
      await other`update settings set value = jsonb_set(value, '{until}', to_jsonb(${Date.now() - 1000}::bigint)) where key = ${SYNC_LEASE_SETTING}`;
      return sendCampaign(deps(fake.r), id, CONFIRMED);
    };
    const [a, b] = await inFlight(APPLICATION, holdRow, () => sendCampaign(deps(fake.r), id, CONFIRMED), second, (work) => work(other));

    expect(a, "the first send, first in the row's queue").toMatchObject({ ok: true, recipients: COUNTS });
    expect(b, "the second send, behind it").toEqual({ ok: false, error: "sent" });
    expectOneSet(fake, "after both");
    expect(await stored(id)).toMatchObject({ status: "sent", recipients: COUNTS });
    // each broadcast was made once: two calls, by the first send alone
    expect(fake.calls.filter((c) => c === "broadcasts.create")).toHaveLength(2);
    expect(await lease(), "no lease is left behind").toBeNull();
  });
});
