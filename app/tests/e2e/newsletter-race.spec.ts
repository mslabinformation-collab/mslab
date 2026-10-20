import postgres from "postgres";
import type { Db } from "../../src/db/client";
import {
  PRESS_LOCK,
  STALE_CLAIM_MS,
  prepareSend,
  progressOf,
  runBatch,
  runDueCampaigns,
  saveCampaign,
  startSend,
  type SendDeps,
} from "../../src/server/newsletter-campaigns";
import type { Env, Mail, MailOutcome } from "../../src/server/notify";
import { inFlight, pause, racePool, type OnDb } from "./race";
import { createScratchDatabase, type Scratch } from "./scratch-db";
import { expect, submitsForms, test } from "./test";

// The simple newsletter's sending on real Postgres (the 20.10 design, Task 5; spec §3 "Each mail goes at most once", "One campaign at a time"): what the
// unit tests' single-connection PGlite cannot show, because it runs one statement at a time. The app's own startSend („Saada kõigile“), runBatch and
// runDueCampaigns (the daily job's), in this process, on a pool of 5 connections (the app's own size, db/client.ts) of a SCRATCH database (scratch-db.ts:
// made on the local server, migrated with the app's migrations, dropped afterwards). Resend is never called and no key is read: the engine's `send` is a
// fake of this process that records each mail and answers "accepted" (SendDeps.send, the seam the engine has for it).
//
// (a) THE CLAIM (newsletter-campaigns.ts claimNext: `FOR UPDATE SKIP LOCKED`, committed before the send). The press's batch and a cron batch run on
//     one campaign at the same time:
//     - the press is at its first send (its first row claimed) while another connection holds the next waiting row, as a runner in the middle of
//       claiming it would; the cron batch starts then and must pass over the held row, never wait for it: it sends the others and stops short of the
//       held one. When the row is let go and the press goes on, each address has been sent exactly once, every row is `sent`, the counts are exact,
//       and both runners really sent (their batch lines: 2 + 7 of 9). Without SKIP LOCKED the cron batch waits for the held row and the test says so.
//     - the same two runners free-running over 24 rows: each address once, the counts exact, both runners sent some.
// (b) THE PRESS'S LOCK (startSend / prepareSend: pressState takes a transaction advisory lock first). Two presses of two different campaigns at the same
//     moment, in both orders: exactly one starts `sending` (its rows written), the other answers `busy` and writes nothing. "At the same moment" is proven,
//     not hoped for (race.ts inFlight, as the other race specs): another connection holds the press lock while both start, and lets it go only once this
//     pool shows both waiting for it; they stand in its queue in the order started, so which one goes first is the test's, and the outcome is the lock's.
//     Without the lock neither waits, and the test says so. Then the same two presses with no lock held, eight times in a row.
// (c) THE SETTLE'S GUARD (newsletter-campaigns.ts settle: only while the row is still `claimed`). A slow runner: its row is claimed and its send takes
//     longer than STALE_CLAIM_MS (a gate holds it), the daily job's sweep (by a clock 7 minutes on) marks the stale claim `unknown`, and then the slow
//     runner's answer arrives ("accepted"): its settle must not write `sent` over `unknown`. The row stays `unknown`, nothing is sent again, the campaign
//     finishes with the mails the rows say went. Without the guard the row turns `sent` and the test says so.
// Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const APPLICATION = `mslab-e2e-newsletter-race-${process.pid}`;
const SITE = "https://mslab.example";
const loggedInfo = console.info;

let scratch: Scratch;
let pool: postgres.Sql;
let db: Db;
/** Connections of their own to the scratch database (under no `application_name`): the tests' reads and writes, the lock `inFlight` holds, the row a test holds. */
let other: postgres.Sql;
/** Where the lock is held: the scratch database (race.ts inFlight defaults to the local test database). */
const onScratch: OnDb = (work) => work(other);
/** The app's log lines of the running test (the batch lines carry each runner's own tally). */
let lines: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = await createScratchDatabase("newsletter");
  ({ pool, db } = racePool(APPLICATION, scratch.url, 5));
  other = postgres(scratch.url, { max: 4, connect_timeout: 20, onnotice: () => {} });
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(" ")); // (the app's own log lines, ids and counts only: kept for the tests, not printed)
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
  lines = [];
  await other`truncate table newsletter_campaigns, subscribers, settings, mail_quota restart identity cascade`;
});

// ---------- what the parts use ----------

const env: Env = {
  KV: { get: async () => null, put: async () => {} },
  MAIL_FROM: "MS LAB <info@send.example.test>",
  MARIA_EMAIL: "maria@example.com",
  SITE_URL: SITE,
};

/** Maria's campaign: both languages. */
const DRAFT = {
  name: "Proov 3 pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "", ru: "" },
  body: { et: "Esimene lõik.", ru: "Первый абзац." },
};

async function campaign(name = DRAFT.name): Promise<number> {
  const saved = await saveCampaign(db, null, { ...DRAFT, name }, new Date());
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.id;
}

/** `n` confirmed subscribers, race-1@ … race-n@, every third one Russian. Oldest first: the press writes its list in this order. */
async function subscribers(n: number): Promise<string[]> {
  const addresses: string[] = [];
  for (let i = 1; i <= n; i++) {
    const email = `race-${i}@example.com`;
    addresses.push(email);
    await other`
      insert into subscribers (email, locale, token, consent_at, confirmed_at)
      values (${email}, ${i % 3 === 0 ? "ru" : "et"}, ${`race-token-${i}-${"x".repeat(24)}`}, now() - interval '1 hour', now() - interval '1 hour')`;
  }
  return addresses;
}

/** What the press showed in its confirmation (prepareSend): the counts by language and the campaign's version. */
async function plan(id: number) {
  const p = await prepareSend(db, id);
  if (!p.ok) throw new Error(`prepareSend: ${p.error}`);
  return p;
}

/** A gate: whoever calls `hold` says so (`entered`) and waits there until `open()`. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return {
    entered,
    open,
    hold: async () => {
      enter();
      await opened;
    },
  };
}

/**
 * The fake Resend of a batch: every mail it was given, in the order they arrived, answered "accepted". `hold(mail)`: a promise to wait for before the answer
 * (a slow send); `pauseMs`: a pause in every send, so that two runners overlap. It counts nothing on the day's counter: the room (70) stays out of the way.
 */
function fakeSend(o: { hold?: (mail: Mail) => Promise<void> | undefined; pauseMs?: number } = {}) {
  const mails: Mail[] = [];
  const send = async (_env: Env, mail: Mail): Promise<MailOutcome> => {
    mails.push(mail);
    await o.hold?.(mail);
    if (o.pauseMs) await pause(o.pauseMs);
    return { ok: true };
  };
  return { send: send as NonNullable<SendDeps["send"]>, mails, to: () => mails.map((m) => m.to) };
}

/** The deps of a runner of this process: the pool, the fake send, no pause between sends, a long time. */
const deps = (send: SendDeps["send"], over: Partial<SendDeps> = {}): SendDeps => ({ db, env, siteUrl: SITE, now: () => new Date(), deadline: Date.now() + 10 * 60_000, gapMs: 0, send, ...over });

/** A row another runner is claiming, as its transaction holds it (`FOR UPDATE`, uncommitted); the returned function lets it go. */
async function holdRow(id: number): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const tx = other.begin(async (t) => {
    await t`select 1 from newsletter_deliveries where id = ${id} for update`;
    locked();
    await released;
  });
  await Promise.race([isLocked, tx]); // (a transaction that fails before it has the row throws here)
  return async () => {
    release();
    await tx;
  };
}

/** The mails each address was sent, as a count per address. */
const perAddress = (to: string[]) => to.reduce<Record<string, number>>((n, a) => ((n[a] = (n[a] ?? 0) + 1), n), {});

/** What each runner's batch line says it sent (`[newsletter] campaign N: batch: S sent, …`), in the order the batches ended. */
const batchesSent = () =>
  lines.flatMap((l) => {
    const m = /campaign \d+: batch: (\d+) sent, (\d+) failed, (\d+) unknown, (\d+) skipped/.exec(l);
    return m ? [Number(m[1])] : [];
  });

const deliveries = (id: number) =>
  other<{ email: string; status: string; sent: boolean }[]>`select email, status, sent_at is not null as sent from newsletter_deliveries where campaign_id = ${id} order by id`;
const campaignRow = async (id: number) => (await other<{ status: string; recipients: { et: number; ru: number } | null }[]>`select status, recipients from newsletter_campaigns where id = ${id}`)[0];

// ---------- (a) the claim ----------

test.describe("a batch claims a row (FOR UPDATE SKIP LOCKED)", () => {
  test("the press's batch and a cron batch at once: the cron passes over the row another runner holds, each address is sent once, the counts are exact", async () => {
    const addresses = await subscribers(9); // 6 Estonian, 3 Russian
    const id = await campaign();
    const first = gate();
    // the press's first send waits at a gate: its row 1 is claimed (committed) and it is in its send
    const sent = fakeSend({ hold: (mail) => (mail.to === addresses[0] ? first.hold() : undefined) });
    const press = startSend(deps(sent.send), id, await plan(id));
    let release: (() => Promise<void>) | null = null;
    let cron: ReturnType<typeof runDueCampaigns> | undefined;
    try {
      await first.entered;
      expect((await deliveries(id)).map((d) => d.status), "the press has claimed its first row and written the others").toEqual(["claimed", ...Array(8).fill("waiting")]);

      // another runner is in the middle of claiming the next row: its transaction holds it
      const [next] = await other<{ id: number; email: string }[]>`select id, email from newsletter_deliveries where campaign_id = ${id} and status = 'waiting' order by id limit 1`;
      expect(next.email, "the next waiting row is the second subscriber's").toBe(addresses[1]);
      release = await holdRow(next.id);

      // the cron batch starts now. It must not wait for the held row: it sends rows 3 to 9 and stops short of the held one
      cron = runDueCampaigns(deps(sent.send));
      const outcome = await Promise.race([cron.then(() => "finished" as const), pause(10_000).then(() => "waited" as const)]);
      expect(outcome, "the cron batch waited for a row another runner holds (without FOR UPDATE SKIP LOCKED it does)").toBe("finished");
      const ran = await cron;
      expect(ran).toMatchObject({ campaignId: id, stopped: null, progress: { total: 9, sent: 7, waiting: 2 } });
      expect(sent.to().sort(), "the cron batch sent the third to the ninth, and neither the held row nor the press's slow one").toEqual([addresses[0], ...addresses.slice(2)].sort());
    } finally {
      // the other runner lets go of its row (it changed nothing), the press's send is answered, and the press goes on to the row it was passed
      await release?.();
      first.open();
      await Promise.allSettled([press, cron]); // (a failed check above leaves no work behind: the pool is closed after the test)
    }
    const pressed = await press;
    expect(pressed).toMatchObject({ ok: true, stopped: null, progress: { total: 9, sent: 9, waiting: 0, failed: 0, unknown: 0, skipped: 0 } });

    // each address exactly once, in the end: nothing doubled, nothing missed
    expect(perAddress(sent.to())).toEqual(Object.fromEntries(addresses.map((a) => [a, 1])));
    const rows = await deliveries(id);
    expect(rows.map((d) => [d.email, d.status, d.sent])).toEqual(addresses.map((a) => [a, "sent", true]));
    expect(await campaignRow(id)).toEqual({ status: "sent", recipients: { et: 6, ru: 3 } });
    expect(await progressOf(db, id)).toEqual({ total: 9, sent: 9, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
    // and both runners really sent: the cron 7 (rows 3 to 9), the press 2 (rows 1 and 2)
    expect(batchesSent().sort((x, y) => x - y), "the batches' own tallies").toEqual([2, 7]);
  });

  test("the same two runners free-running over 24 rows: each address once, the counts exact, both runners sent some", async () => {
    const addresses = await subscribers(24);
    const id = await campaign();
    const sent = fakeSend({ pauseMs: 4 }); // a send takes a moment, so that the two batches overlap
    const press = startSend(deps(sent.send), id, await plan(id));
    await expect.poll(() => sent.mails.length, { message: "the press is sending", timeout: 15_000 }).toBeGreaterThan(0);
    const cron = runDueCampaigns(deps(sent.send));
    const [pressed, ran] = await Promise.all([press, cron]);

    expect(pressed).toMatchObject({ ok: true });
    expect(ran.campaignId).toBe(id);
    expect(perAddress(sent.to())).toEqual(Object.fromEntries(addresses.map((a) => [a, 1])));
    expect((await deliveries(id)).map((d) => d.status)).toEqual(Array(24).fill("sent"));
    expect(await campaignRow(id)).toEqual({ status: "sent", recipients: { et: 16, ru: 8 } });
    expect(await progressOf(db, id)).toEqual({ total: 24, sent: 24, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
    const tallies = batchesSent();
    expect(tallies, "two batches ran").toHaveLength(2);
    expect(tallies.reduce((a, b) => a + b, 0), "between them every mail once").toBe(24);
    expect(Math.min(...tallies), "both runners sent").toBeGreaterThan(0);
  });
});

// ---------- (b) the press's lock ----------

test.describe("a press takes the press lock first", () => {
  /** Two campaigns, each with its confirmation (the subscribers are the same). */
  async function twoCampaigns() {
    await other`truncate table newsletter_campaigns, subscribers restart identity cascade`;
    await subscribers(3);
    const a = await campaign("Proov 3 kampaania A");
    const b = await campaign("Proov 3 kampaania B");
    return { a, b, planA: await plan(a), planB: await plan(b) };
  }
  /** No batch runs after the press (its time is over at once): the campaign stays `sending`, so that the state of the press itself is what is looked at. */
  const press = (id: number, p: Awaited<ReturnType<typeof plan>>, send: SendDeps["send"]) => startSend(deps(send, { deadline: 0 }), id, p);
  const statuses = async () => Object.fromEntries((await other<{ id: number; status: string }[]>`select id, status from newsletter_campaigns order by id`).map((r) => [r.id, r.status]));
  const writtenFor = async (id: number) => (await other<{ n: number }[]>`select count(*)::int as n from newsletter_deliveries where campaign_id = ${id}`)[0].n;

  for (const order of ["A first", "B first"] as const) {
    test(`two presses of two campaigns at the same moment (${order}): exactly one starts sending, the other is told busy and writes nothing`, async () => {
      const { a, b, planA, planB } = await twoCampaigns();
      const sent = fakeSend();
      const hold = (tx: postgres.TransactionSql) => tx`select pg_advisory_xact_lock(hashtext(${PRESS_LOCK}))`;
      const [firstId, secondId] = order === "A first" ? [a, b] : [b, a];
      const [firstPlan, secondPlan] = order === "A first" ? [planA, planB] : [planB, planA];
      const [first, second] = await inFlight(APPLICATION, hold, () => press(firstId, firstPlan, sent.send), () => press(secondId, secondPlan, sent.send), onScratch);

      // the one that stood first in the lock's queue won; the other came to a campaign going out
      expect(first, "the first press").toMatchObject({ ok: true });
      expect(second, "the second press").toEqual({ ok: false, error: "busy" });
      expect(await statuses(), "exactly one campaign is going out").toEqual({ [firstId]: "sending", [secondId]: "draft" });
      expect(await writtenFor(firstId), "the winner wrote its list").toBe(3);
      expect(await writtenFor(secondId), "the loser wrote nothing").toBe(0);
      expect(sent.mails, "no batch ran: no mail").toHaveLength(0);
    });
  }

  test("the same two presses with no lock held, eight times: exactly one starts sending each time", async () => {
    for (let round = 1; round <= 8; round++) {
      const { a, b, planA, planB } = await twoCampaigns();
      const sent = fakeSend();
      const results = await Promise.all([press(a, planA, sent.send), press(b, planB, sent.send)]);
      expect(results.filter((r) => r.ok), `round ${round}: presses that started`).toHaveLength(1);
      expect(results.filter((r) => !r.ok), `round ${round}: presses told busy`).toEqual([{ ok: false, error: "busy" }]);
      const going = Object.values(await statuses()).filter((s) => s === "sending");
      expect(going, `round ${round}: campaigns going out`).toHaveLength(1);
      expect((await writtenFor(a)) + (await writtenFor(b)), `round ${round}: deliveries written`).toBe(3);
    }
  });
});

// ---------- (c) the settle's guard ----------

test.describe("a runner writes its outcome only while its row is still claimed", () => {
  test("a slow runner settles after the stale sweep marked its row unknown: the row stays unknown, nothing is sent again", async () => {
    const [slowAddress, otherAddress] = await subscribers(2);
    const id = await campaign();
    const slow = gate();
    // the press's first send (race-1@) is slow: the answer comes only when the gate opens
    const sent = fakeSend({ hold: (mail) => (mail.to === slowAddress ? slow.hold() : undefined) });
    const press = startSend(deps(sent.send), id, await plan(id));
    let ran: Awaited<ReturnType<typeof runDueCampaigns>> | undefined;
    try {
      await slow.entered;
      expect((await deliveries(id)).map((d) => d.status)).toEqual(["claimed", "waiting"]);

      // the daily job, 7 minutes on by its clock: the sweep marks the stale claim `unknown` (the slow runner is taken for dead), then it sends the other row
      const late = () => new Date(Date.now() + STALE_CLAIM_MS + 60_000);
      ran = await runDueCampaigns(deps(sent.send, { now: late, deadline: Date.now() + 60 * 60_000 }));
      expect((await deliveries(id)).map((d) => [d.email, d.status]), "the stale claim is unknown, the other row went").toEqual([
        [slowAddress, "unknown"],
        [otherAddress, "sent"],
      ]);
      expect(ran).toMatchObject({ stopped: null, progress: { total: 2, sent: 1, unknown: 1, waiting: 0 } });
      expect(await campaignRow(id), "the job finished the campaign").toMatchObject({ status: "sent", recipients: { et: 1, ru: 0 } });
    } finally {
      slow.open(); // the slow send is answered "accepted" now: its settle runs
      await Promise.allSettled([press]);
    }
    const pressed = await press;
    expect(pressed).toMatchObject({ ok: true });

    // the settle did not overwrite `unknown` with `sent`
    expect((await deliveries(id)).map((d) => [d.email, d.status, d.sent]), "the settle of the slow runner changed nothing").toEqual([
      [slowAddress, "unknown", false],
      [otherAddress, "sent", true],
    ]);
    expect(lines.some((l) => /delivery \d+: no longer claimed, its outcome \(sent\) not written/.test(l)), "the guard refused the write, and said so").toBe(true);
    expect(await campaignRow(id)).toEqual({ status: "sent", recipients: { et: 1, ru: 0 } });
    expect(await progressOf(db, id)).toEqual({ total: 2, sent: 1, waiting: 0, failed: 0, unknown: 1, skipped: 0 });

    // an `unknown` row is never sent again: another batch finds nothing to do
    await runBatch(deps(sent.send), id);
    expect(perAddress(sent.to()), "each address was given to Resend once").toEqual({ [slowAddress]: 1, [otherAddress]: 1 });
  });
});
