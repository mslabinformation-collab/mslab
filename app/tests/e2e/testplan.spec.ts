import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { planCounts, type AnswersDoc, type TestPlan } from "../../src/domain/testplan";
import { fill } from "../../src/i18n/format";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { onLocalDb, removeAdminRows } from "./fixtures";
import { LOCAL_URL, TARGET } from "./target";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// The test page (phase 4, piece 1, Task 3; redrawn by admin UX pass piece 4c, C7), followed through in a browser against the local database: two
// checks answered („Läbitud“, „Viga“ with a note: the note box is open under every answer, Dim 22.10) and a third left open, kept over a reload,
// found again through „Olek“, an empty selection, and counted on Avaleht; a second admin session answering one of them, which the first reads after
// „Värskenda“; a press made offline, kept and sent when the connection is back; a press made after the session ended, kept on the device with no
// retries, and sent after signing in again (R-i, Review Focus 5); two saves at once of different checks, both of which land (the row lock and the
// merge, on a real Postgres); a link to a check; and the layout at 390, 834, 1194 and 1440 px. Nothing is mocked on the server: Telegram is not
// configured locally, so the Viga's message is logged and skipped.
// The checks are the plan's own, picked when the test runs (the first three of the first area that has checks), never fixed ids: the plan is
// replaced as a whole when it changes. The tests that write answers run in the desktop project only; the mobile project runs the layout and
// the link. Every answer a test gives is removed afterwards by its id, from the one `testplan_answers` row (never the whole row).

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
/** The checks this test answered (or may have): their answers are removed after it. */
const answered = new Set<string>();

const desktop = (info: TestInfo) => !info.project.name.startsWith("mobile");
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** The page's one SaveStatus (README §1.4): `data-save-kind` is its state, `[data-save-text]` the words it shows. */
const chip = (page: Page) => page.locator("[data-testplan] [data-save-status]");
const chipText = (page: Page) => chip(page).locator("[data-save-text]");
/**
 * A save of this page came back: „✓ Salvestatud HH:MM“. (The chip says „✓ Salvestatud“ with no time from the start once the answers were read,
 * review M-1, so the kind alone would pass before the save is over.)
 */
const savedAt = (page: Page, timeout?: number) => expect(chipText(page)).toHaveText(/^✓ Salvestatud \d\d:\d\d$/, { timeout });
const check = (page: Page, id: string) => page.locator(`[data-check="${id}"]`);
const VIEW_KEY = "mslab-testplan-view";
const OUTBOX_KEY = "mslab-testplan-outbox";
const SAVING_FAILS = "Salvestamata — proovin uuesti";
const SIGNED_OUT = "Salvestamata — logi uuesti sisse";
const EMPTY = "Selle valikuga kontrolle pole.";

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  await removeAnswers([...answered]);
  answered.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

/** Takes these checks' answers out of the stored row, leaving every other answer (and the row) alone. */
async function removeAnswers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await onLocalDb(
    async (sql) => {
      for (const id of ids)
        await sql`update settings set value = jsonb_set(value, '{answers}', (value->'answers') - ${id}::text)
          where key = 'testplan_answers' and jsonb_typeof(value->'answers') = 'object'`;
    },
    { marksPages: false },
  );
}

type ApiAnswer = { status: "ok" | "bad" | "skip"; note: string; at: string; byName: string };
type Api = { plan: TestPlan; answers: Record<string, ApiAnswer>; you: { name: string; tester: "maria" | "dim" | null } };

const readApi = async (page: Page): Promise<Api> => {
  const res = await page.request.get("/api/admin/testplan");
  expect(res.status()).toBe(200);
  return (await res.json()) as Api;
};

/** The first three checks of the first area that has any (the plan is replaced as a whole when it changes: no fixed ids). Their old answers are removed first. */
async function pickChecks(page: Page): Promise<{ area: string; ids: [string, string, string] }> {
  const { plan } = await readApi(page);
  const area = plan.areas.find((a) => a.checks !== false && plan.items.some((i) => i.area === a.id));
  expect(area, "the plan has an area with checks").toBeTruthy();
  const ids = plan.items.filter((i) => i.area === area!.id).slice(0, 3).map((i) => i.id);
  expect(ids, "the first area with checks holds at least three").toHaveLength(3);
  for (const id of ids) answered.add(id);
  await removeAnswers(ids);
  return { area: area!.id, ids: ids as [string, string, string] };
}

/** The tester's own view („Mina“) is the default (Dim's hides Maria's checks); these tests look at everything. */
const seeEverything = (context: BrowserContext) =>
  context.addInitScript(([key]) => {
    try {
      localStorage.setItem(key, JSON.stringify({ filter: "all", who: "all" }));
    } catch {
      // no storage: the page's own defaults
    }
  }, [VIEW_KEY]);

async function openPage(page: Page, hash = ""): Promise<void> {
  await page.goto(`/admin/testimine${hash}`);
  await adminReady(page);
  await expect(page.locator("[data-testplan]")).toBeVisible();
}
async function openArea(page: Page, id: string): Promise<void> {
  const toggle = page.locator(`[data-area="${id}"] [data-area-toggle]`);
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
async function openEveryArea(page: Page): Promise<void> {
  for (const toggle of await page.locator("[data-area-toggle]").all()) if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
const pressed = (page: Page, id: string) => check(page, id).locator('[data-answer][aria-pressed="true"]');

/** What the Avaleht card should say for the signed-in admin, from the API's own answers (null: no card, nothing open or failed for his tester). */
async function expectedCard(page: Page): Promise<{ open: number; bad: number } | null> {
  const { plan, answers, you } = await readApi(page);
  const doc: AnswersDoc = { v: 1, answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { status: a.status, note: a.note, at: a.at, by: a.byName }])) };
  const { open, bad } = planCounts(plan, doc, new Date(0).toISOString(), you.tester);
  return open + bad === 0 ? null : { open, bad };
}
/** On Avaleht: the card says what `expectedCard` says (or is not there), and its link goes to the page. */
async function cardIsRight(page: Page): Promise<boolean> {
  const expected = await expectedCard(page);
  await page.goto("/admin");
  await adminReady(page);
  const card = page.locator("[data-testplan-card]");
  if (expected === null) {
    await expect(card).toHaveCount(0);
    return false;
  }
  await expect(card).toBeVisible();
  await expect(card).toContainText(fill("Testimine: {open} avatud, {bad} viga", expected));
  await card.getByRole("link", { name: "Ava" }).click();
  await expect(page).toHaveURL(/\/admin\/testimine$/);
  return true;
}

/** At each width: no sideways scrolling, and no control of the page less than 44 px tall. */
async function layoutHolds(page: Page, widths: number[]): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noOverflow(page), `${width} px: sideways scrolling`).toBe(true);
    expect(await page.locator("[data-testplan]").evaluate((el) => el.scrollWidth <= el.clientWidth), `${width} px: the page's own width`).toBe(true);
    expect(await smallTargets(page.locator("[data-testplan]")), `${width} px: controls under 44 px`).toEqual([]);
  }
}

test("guard: the page and its API need an admin session", async ({ request }) => {
  const page = await request.get("/admin/testimine", { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(page.status());
  expect(page.headers().location).toMatch(/\/admin\/login$/);
  for (const method of ["get", "put"] as const) {
    const res = await request[method]("/api/admin/testplan", method === "put" ? { data: { answers: {} } } : {});
    expect(res.status(), method).toBe(401);
  }
});

test("answers persist: „Läbitud“ and „Viga“ with their note boxes open, kept over a reload, found by „Olek“, an empty selection, and the Avaleht card", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  const { area, ids } = await pickChecks(page);

  await openPage(page);
  // the header: the eyebrow, the H1 and the line; „Mina“ is the default (admin@example.test is Dim in .env.example); no „Sina: …“
  await expect(page.locator("[data-testplan] h1")).toHaveText("Testimine");
  await expect(page.locator("[data-progress]")).toHaveText(/^(1 kontroll|\d+ kontrolli) · \d+ läbitud · \d+ viga$/);
  await expect(page.locator('[data-who="mina"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-you]")).toHaveCount(0);
  await expect(page.locator('[data-filter-group="olek"] button')).toHaveText([/^Kõik$/, /^Avatud \d+$/, /^Viga \d+$/, /^Läbitud \d+$/]);
  await expect(page.locator('[data-filter-group="kes"] button')).toHaveText(["Mina", "Kõik", "Automaattest"]);
  await page.locator('[data-who="all"]').click();
  await page.locator('[data-filter="all"]').click();
  await openArea(page, area);

  const [first, second, third] = ids.map((id) => check(page, id));
  await expect(first.locator('[data-answer="skip"]')).toHaveCount(0); // („Jäta vahele“ is gone, spec §10)
  await expect(first.locator("[data-answer]")).toHaveText(["Läbitud", "Viga"]);
  await expect(first.locator("[data-check-note]")).toHaveCount(0); // (no answer, no box)
  await first.locator('[data-answer="ok"]').click();
  // Dim 22.10: the note box is open under every answer, asking „Märkus“ under a pass, „Mis läks valesti?“ under a Viga
  const firstNote = first.locator("[data-check-note]");
  await expect(firstNote).toBeVisible();
  await expect(firstNote).toHaveAttribute("placeholder", "Märkus");
  await expect(firstNote).not.toBeFocused();
  await second.locator('[data-answer="bad"]').click();
  const note = second.locator("[data-check-note]");
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute("placeholder", "Mis läks valesti?");
  await note.fill("E2E: nupp ei tööta");
  await note.blur();
  // (every press and the note delivered: nothing is left in the outbox; then the chip shows the last save's time)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toBeNull();
  await savedAt(page);
  await expect(first).toHaveAttribute("data-check-state", "done");
  await expect(second).toHaveAttribute("data-check-state", "failed");
  await expect(third).toHaveAttribute("data-check-state", "open");

  // „Sammud ▸“ folds the steps, „Mida näed“ and „Miks“
  const steps = third.locator("[data-steps]");
  await expect(steps).toBeHidden();
  await third.locator("[data-steps-toggle]").click();
  await expect(steps).toBeVisible();
  await expect(steps).toContainText("Mida näed");
  await expect(steps).toContainText("Miks");

  // the server has them: who answered, and the note
  const api = await readApi(page);
  expect(ids.map((id) => api.answers[id]?.status)).toEqual(["ok", "bad", undefined]);
  expect(api.answers[ids[1]].note).toBe("E2E: nupp ei tööta");
  expect(api.answers[ids[0]].byName).toBe("Dim");

  // a reload shows both, each with its last answer; the note is in its field; the choice of „Kes“ is still „Kõik“
  await page.reload();
  await adminReady(page);
  await expect(page.locator('[data-who="all"]')).toHaveAttribute("aria-pressed", "true");
  await openArea(page, area);
  for (const [id, label] of [[ids[0], "Läbitud"], [ids[1], "Viga"]] as const)
    await expect(check(page, id).locator("[data-check-last]")).toHaveText(new RegExp(`^Dim · \\d\\d\\.\\d\\d \\d\\d:\\d\\d · ${label}$`));
  await expect(pressed(page, ids[0])).toHaveAttribute("data-answer", "ok");
  await expect(pressed(page, ids[1])).toHaveAttribute("data-answer", "bad");
  await expect(pressed(page, ids[2])).toHaveCount(0);
  await expect(check(page, ids[1]).locator("[data-check-note]")).toHaveValue("E2E: nupp ei tööta");
  await expect(check(page, ids[0]).locator("[data-check-note]")).toHaveValue(""); // (open over a reload too, empty)

  // „Olek“ finds each again: „Viga“ the failed one, „Läbitud“ the passed one, „Avatud“ the open one
  for (const [filter, shown] of [["bad", 1], ["done", 0], ["open", 2]] as const) {
    await page.locator(`[data-filter="${filter}"]`).click();
    await expect(page.locator(`[data-filter="${filter}"]`)).toHaveAttribute("aria-pressed", "true");
    for (const [i, id] of ids.entries()) await expect(check(page, id), `${filter}: ${id}`).toHaveCount(i === shown ? 1 : 0);
  }
  // an empty selection (S4-46): „Automaattest“ with a state it has no check of (locally it has answered nothing at all)
  await page.locator('[data-who="auto"]').click();
  const zero = page.locator('[data-filter-group="olek"] button').filter({ hasText: / 0$/ }).first();
  await expect(zero, "a state with no check under „Automaattest“").toHaveCount(1);
  await zero.click();
  await expect(page.locator("[data-list-empty]")).toHaveText(EMPTY);
  await expect(page.locator("[data-check]")).toHaveCount(0);
  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-who="all"]').click();
  await expect(page.locator("[data-list-empty]")).toHaveCount(0);

  // an area folds with its note
  await openArea(page, area);
  await page.locator(`[data-area="${area}"] [data-area-toggle]`).click();
  await expect(page.locator(`[data-area="${area}"] [data-check]`)).toHaveCount(0);
  await expect(page.locator(`[data-area="${area}"] [data-area-note]`)).toHaveCount(0);
  await expect(page.locator(`[data-area="${area}"] [data-area-count]`)).toHaveText(/^\d+ \/ \d+$/);

  // with the answers and a note open, at a phone's width and a tablet's
  await openEveryArea(page);
  await layoutHolds(page, [390, 834]);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Avaleht: the card counts the checks still open or failed for this admin's tester (computed from the same API, whatever the plan holds)
  await cardIsRight(page);
});

test("a second admin session answers the third check differently; the first sees it after „Värskenda“, without a reload", async ({ page, context, browser, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await seeEverything(context);
  await signInAsAdmin(page, context, visitorIp, created);
  const { area, ids } = await pickChecks(page);
  await openPage(page);
  await openArea(page, area);
  await check(page, ids[2]).locator('[data-answer="bad"]').click();
  await savedAt(page);
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));

  // the other session, in a browser of its own
  const otherIp = `${visitorIp}-second`;
  const other = await browser.newContext({ baseURL: TARGET || LOCAL_URL, extraHTTPHeaders: { "x-forwarded-for": otherIp } });
  try {
    await seeEverything(other);
    const page2 = await other.newPage();
    await signInAsAdmin(page2, other, otherIp, created);
    await openPage(page2);
    await openArea(page2, area);
    await expect(pressed(page2, ids[2])).toHaveAttribute("data-answer", "bad"); // (it reads what the first gave)
    await check(page2, ids[2]).locator('[data-answer="ok"]').click();
    await savedAt(page2);
  } finally {
    await other.close();
  }

  // the first does not know yet; „Värskenda“ reads again
  await expect(pressed(page, ids[2])).toHaveAttribute("data-answer", "bad");
  await page.locator("[data-refresh]").click();
  await expect(pressed(page, ids[2])).toHaveAttribute("data-answer", "ok");
  await expect(check(page, ids[2]).locator("[data-check-last]")).toContainText("· Läbitud");
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
});

test("offline: a press is kept and shown as „Salvestamata — proovin uuesti“; back online it is sent; a reload shows it", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await seeEverything(context);
  await signInAsAdmin(page, context, visitorIp, created);
  const { area, ids } = await pickChecks(page);
  await openPage(page);
  await openArea(page, area);

  await context.setOffline(true);
  await check(page, ids[0]).locator('[data-answer="ok"]').click();
  await expect(chipText(page)).toHaveText(SAVING_FAILS);
  await expect(check(page, ids[0])).toHaveAttribute("data-check-state", "done"); // (shown at once, though the server has not heard)
  expect(await page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toContain('"ok"');

  await context.setOffline(false);
  await savedAt(page, 15_000); // (the browser's 'online', or the retry after 2 s)
  expect(await page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toBeNull();

  await page.reload();
  await adminReady(page);
  await openArea(page, area);
  await expect(pressed(page, ids[0])).toHaveAttribute("data-answer", "ok");
  expect((await readApi(page)).answers[ids[0]].status).toBe("ok");
});

// R-i, Review Focus 5: the session ends while the page is open (here: its cookie is gone). A press is refused with 401: the chip says so, the press stays
// on the device, nothing asks again by itself, and after signing in again the page sends it.
test("signed out: a press shows „Salvestamata — logi uuesti sisse“, is kept on the device with no retries, and is sent after signing in again", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await seeEverything(context);
  await signInAsAdmin(page, context, visitorIp, created);
  const { area, ids } = await pickChecks(page);
  await openPage(page);
  await openArea(page, area);

  await context.clearCookies({ name: "__Host-mslab_admin" });
  const puts: number[] = [];
  page.on("response", (res) => {
    if (res.request().method() === "PUT" && new URL(res.url()).pathname === "/api/admin/testplan") puts.push(res.status());
  });
  await check(page, ids[1]).locator('[data-answer="bad"]').click();
  await expect(chip(page)).toHaveAttribute("data-save-kind", "signedOut");
  await expect(chipText(page)).toHaveText(SIGNED_OUT);
  await expect(check(page, ids[1])).toHaveAttribute("data-check-state", "failed"); // (her press is shown all the same)
  expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)) ?? "{}")[ids[1]]).toMatchObject({ status: "bad" });
  // no request storm: the first retry of a failure would come after 2 s; a 401 sets none
  await page.waitForTimeout(3000);
  expect(puts).toEqual([401]);
  await expect(chip(page)).toHaveAttribute("data-save-kind", "signedOut");

  // signed in again, the page sends the kept press at once
  await signInAsAdmin(page, context, visitorIp, created);
  await openPage(page);
  await savedAt(page);
  expect((await readApi(page)).answers[ids[1]]).toMatchObject({ status: "bad", byName: "Dim" });
  expect(await page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toBeNull();
});

test("a press left on the device by a visit that never got to send it is sent when the page is opened again", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await seeEverything(context);
  await signInAsAdmin(page, context, visitorIp, created);
  const { area, ids } = await pickChecks(page);
  await openPage(page);
  await page.evaluate(
    ([key, id]) => localStorage.setItem(key, JSON.stringify({ [id]: { status: "bad", note: "E2E: jäi saatmata", clientAt: new Date().toISOString() } })),
    [OUTBOX_KEY, ids[1]],
  );
  await page.reload();
  await adminReady(page);
  await openArea(page, area);
  await savedAt(page);
  await expect(check(page, ids[1])).toHaveAttribute("data-check-state", "failed");
  expect((await readApi(page)).answers[ids[1]]).toMatchObject({ status: "bad", note: "E2E: jäi saatmata" });
  expect(await page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toBeNull();
});

test("Avaleht: a failed check of the admin's own tester brings the card, with the counts of the plan; its link opens the page", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  const { plan, you } = await readApi(page);
  // a check that is this admin's own (or shared): the card counts only those. The plan's first one, whatever it is
  const mine = plan.items.find((i) => plan.areas.find((a) => a.id === i.area)?.checks !== false && (you.tester === null || i.who === you.tester || i.who === "koos"));
  test.skip(!mine, `the plan has no check for ${you.tester} or shared: the card is never shown to this admin (the plan's own, not the page's, choice)`);
  answered.add(mine!.id);
  await removeAnswers([mine!.id]);
  const res = await page.request.put("/api/admin/testplan", { data: { answers: { [mine!.id]: { status: "bad", note: "E2E: kaardi proov" } } } });
  expect(res.status()).toBe(200);
  expect(await expectedCard(page), "a failed check of his own is counted").not.toBeNull();
  expect(await cardIsRight(page)).toBe(true);
});

test("two saves at once of different checks both land: the row lock and the merge, on a real database", async ({ page, context, visitorIp }, info) => {
  test.skip(!desktop(info), "writes answers: the desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  const { ids } = await pickChecks(page);
  // (the API still takes a `skip`, the stored answers' third status: the data stays, piece 4c, though the page has no such button)
  const put = (id: string, answer: "ok" | "skip") => page.request.put("/api/admin/testplan", { data: { answers: { [id]: { status: answer, note: "" } } } });
  // several rounds, the answer of each different from the one before it: a save that overwrote the other's check would bring back the earlier answer
  for (const round of [0, 1, 2, 3, 4, 5]) {
    const answer = round % 2 === 0 ? "ok" : "skip";
    const [a, b] = await Promise.all([put(ids[0], answer), put(ids[1], answer)]);
    expect([a.status(), b.status()], `round ${round}`).toEqual([200, 200]);
    const { answers } = await readApi(page);
    expect([answers[ids[0]]?.status, answers[ids[1]]?.status], `round ${round}: both answers are there`).toEqual([answer, answer]);
  }
});

test("a link to a check (the Telegram message's #id) opens its area and shows the check, whoever's it is", async ({ page, context, visitorIp }) => {
  await signInAsAdmin(page, context, visitorIp, created);
  const { plan } = await readApi(page);
  // the last check of the plan: in the farthest area, which starts closed
  const target = [...plan.items].reverse().find((i) => plan.areas.find((a) => a.id === i.area)?.checks !== false)!;
  await openPage(page, `#${target.id}`);
  await expect(check(page, target.id)).toBeVisible();
  await expect(page.locator(`[data-area="${target.area}"] [data-area-toggle]`)).toHaveAttribute("aria-expanded", "true");
  await expect(check(page, target.id)).toBeInViewport();
});

test("layout: no sideways scrolling and every control at least 44 px tall, at 390, 834, 1194 and 1440 px", async ({ page, context, visitorIp }) => {
  await seeEverything(context);
  await signInAsAdmin(page, context, visitorIp, created);
  await openPage(page);
  await openEveryArea(page);
  await expect(page.locator("[data-check]").first()).toBeVisible();
  // one check's steps open, so the fold is measured too
  await page.locator("[data-check] [data-steps-toggle]").first().click();
  await layoutHolds(page, [390, 834, 1194, 1440]);
});
