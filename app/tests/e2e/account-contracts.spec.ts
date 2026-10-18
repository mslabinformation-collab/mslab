import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { formatDate } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures, signInAsClient, type AccountCardKind } from "./account";
import { onLocalDb, removeClientRows } from "./fixtures";
import { submitsForms, test, expect } from "./test";

// Contracts, the student's side (contracts Task 6, spec §4 Account) in a browser: the quiet line „Leping · kinnitatud {kuupäev}“ on a contact and an
// e-course card with „Laadi alla (PDF)“ (a download named by the contract's id, the bytes a PDF, never another student's); once Maria has asked,
// „Kinnita leping“ opens the current text on the card and „Kinnitan“ makes the new contract (the old one superseded, the ask cleared, the card back
// to the line), a second „Kinnitan“ is a 409 and makes nothing; the same in Russian. The clients are sample addresses (`e2e-client-…@example.test`,
// never mailed: nothing is mailed from the local server anyway) with registrations and contracts written straight to the local database
// (tests/e2e/account.ts insertAccountFixtures; removeClientRows deletes the contracts of the address too: they keep their rows when the registration
// or the account goes). The contact text is whatever Seaded holds (until Maria writes hers, the public „Õppetingimused“): the tests do not write it.

const made = new Set<string>();
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

const card = (page: Page, key: string) => page.locator(`[data-card="${key}"]`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const DAY = 86_400_000;

/** A fresh client with these cards; `signIn` opens /konto (or `path`) with the dashboard loaded. */
async function signedInWith(page: Page, label: string, project: string, cards: AccountCardKind[], locale: "et" | "ru" = "et") {
  const email = clientEmail(label, project);
  made.add(email);
  await removeClientRows(email);
  const f = await insertAccountFixtures(email, { name: "Kati Tamm", cards, locale });
  return {
    email,
    f,
    signIn: async (path = "/konto") => {
      await signInAsClient(page, email);
      if (path !== "/konto") await page.goto(path);
      await expect(page.locator("[data-account-dashboard]")).toBeVisible();
    },
  };
}

const fieldsOf = (email: string, course: string) => ({ school: { company: "E2E OÜ", registryCode: "", address: "" }, student: { name: "Kati Tamm", email }, course, session: "", price: "350,00 €", payment: "" });

/** A frozen contract of a registration, written to the local database: accepted `days` ago, the way, and whether Maria has replaced it. */
async function addContract(email: string, f: { clientId: number; course: { id: number; title: string } }, registrationId: number, o: { days?: number; via?: string } = {}): Promise<number> {
  const [row] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`
      insert into contracts (kind, registration_id, course_id, client_id, version, locale, title, body, fields, accepted_at, accepted_via)
      values ('contact', ${registrationId}, ${f.course.id}, ${f.clientId}, 'e2e-old', 'et', 'E2E vana leping', 'E2E vana tekst.', ${sql.json(fieldsOf(email, f.course.title))}, now() - ${`${o.days ?? 0} days`}::interval, ${o.via ?? "form"})
      returning id`,
    { marksPages: false },
  );
  return row.id;
}
/** The e-course access the fixture made, and a contract of it. */
async function addEcourseContract(email: string, clientId: number): Promise<number> {
  const [row] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`
      insert into contracts (kind, access_id, course_id, client_id, version, locale, title, body, fields, accepted_at, accepted_via)
      select 'ecourse', a.id, a.course_id, ${clientId}, '1', 'et', 'E2E E-koolituse leping', 'E2E tekst.', ${sql.json(fieldsOf(email, "Kulmumeistri e-koolitus"))}, now() - interval '2 days', 'terms'
      from course_access a where a.client_id = ${clientId}
      returning id`,
    { marksPages: false },
  );
  return row.id;
}
const askAgain = (registrationId: number) => onLocalDb((sql) => sql`update registrations set contract_requested_at = now() where id = ${registrationId}`, { marksPages: false });
const asked = async (registrationId: number) => (await onLocalDb((sql) => sql<{ at: Date | null }[]>`select contract_requested_at as at from registrations where id = ${registrationId}`, { marksPages: false }))[0].at;
/** The contracts of a test address as stored, the oldest first. */
const storedContracts = (email: string) =>
  onLocalDb(
    (sql) => sql<{ id: number; via: string; superseded: boolean; locale: string; client: number | null }[]>`
      select id, accepted_via as via, superseded_at is not null as superseded, locale, client_id as client from contracts where fields->'student'->>'email' = ${email} order by id`,
    { marksPages: false },
  );

test("a card shows its contract: a quiet line with „Laadi alla (PDF)“, a PDF named by the contract's id; an e-course card too; another student's contract is a 404", async ({ page }, info) => {
  const { email, f, signIn } = await signedInWith(page, "ctr", info.project.name, ["confirmed", "ecourse"]);
  const mine = await addContract(email, f, f.registrations.confirmed!, { days: 3 });
  const ecourse = await addEcourseContract(email, f.clientId);
  await signIn();

  const confirmed = card(page, `registration-${f.registrations.confirmed}`);
  await expect(confirmed.locator("[data-contract-line]")).toHaveText(`Leping · kinnitatud ${formatDate(new Date(Date.now() - 3 * DAY), "et")}`);
  const link = confirmed.getByRole("link", { name: "Laadi alla (PDF)" });
  await expect(link).toHaveAttribute("href", `/api/konto/leping/${mine}`);
  // the line is quiet: no button of its own, the card keeps its one main button
  await expect(confirmed.locator("[data-card-contract] button")).toHaveCount(0);
  await expect(confirmed.locator("[data-card-action]")).toHaveCount(1);
  await expect(confirmed.locator("[data-card-contract-open]")).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe(`MS-LAB-leping-${mine}.pdf`);
  expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  // the e-course card: the same line, its own contract
  const course = card(page, `course-${f.ecourse.slug}`);
  await expect(course.locator("[data-contract-line]")).toHaveText(`Leping · kinnitatud ${formatDate(new Date(Date.now() - 2 * DAY), "et")}`);
  await expect(course.getByRole("link", { name: "Laadi alla (PDF)" })).toHaveAttribute("href", `/api/konto/leping/${ecourse}`);

  // a contract that is not hers is a 404, whoever asks; hers is private and uncached
  const other = await signedInWith(page, "ctr-other", info.project.name, ["confirmed"]);
  const theirs = await addContract(other.email, other.f, other.f.registrations.confirmed!);
  const res = await page.request.get(`/api/konto/leping/${theirs}`);
  expect([res.status(), await res.json()]).toEqual([404, { ok: false }]);
  const own = await page.request.get(`/api/konto/leping/${mine}`);
  expect([own.status(), own.headers()["content-type"], own.headers()["cache-control"], own.headers()["x-content-type-options"]]).toEqual([200, "application/pdf", "private, no-store", "nosniff"]);

  // the phone: nothing wider than the screen, the download a 44 px target
  expect(await noOverflow(page)).toBe(true);
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("after Maria asks: „Kinnita leping“ opens the text on the card, „Kinnitan“ makes the new contract and the card goes back to the line; a second „Kinnitan“ makes nothing", async ({ page }, info) => {
  submitsForms();
  const { email, f, signIn } = await signedInWith(page, "ctr-ask", info.project.name, ["confirmed"]);
  const reg = f.registrations.confirmed!;
  const old = await addContract(email, f, reg, { days: 5 });
  await askAgain(reg);
  await signIn();

  const c = card(page, `registration-${reg}`);
  await expect(c.locator("[data-contract-asked]")).toHaveText("Maria palub sul lepingu kinnitada.");
  const open = c.locator("[data-card-contract-open]"); // (its name is „Peida leping“ while the text is open)
  await expect(open).toHaveText("Kinnita leping");
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(c.locator("[data-contract-line]")).toHaveCount(0);
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await open.click();
  const panel = c.locator("[data-contract-panel]");
  await expect(panel).toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(open).toHaveText("Peida leping");
  await expect(panel.locator("p").first()).not.toBeEmpty();
  expect(await noOverflow(page)).toBe(true);
  const accept = c.getByRole("button", { name: "Kinnitan", exact: true });
  await expect(accept).toBeVisible();
  expect((await accept.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await accept.click();
  // the card goes back to the line, with today's date and the new contract's PDF
  await expect(c.locator("[data-contract-line]")).toHaveText(`Leping · kinnitatud ${formatDate(new Date(), "et")}`);
  await expect(c.locator("[data-card-contract-open]")).toHaveCount(0);
  const rows = await storedContracts(email);
  expect(rows).toEqual([
    { id: old, via: "form", superseded: true, locale: "et", client: f.clientId },
    { id: rows[1].id, via: "account", superseded: false, locale: "et", client: f.clientId },
  ]);
  expect(await asked(reg)).toBeNull();
  await expect(c.getByRole("link", { name: "Laadi alla (PDF)" })).toHaveAttribute("href", `/api/konto/leping/${rows[1].id}`);
  await page.reload();
  await expect(c.locator("[data-contract-line]")).toBeVisible();

  // a second tap (another device, a double tap) finds the ask answered: 409 nothing, no third contract; the old, superseded one is still hers to download
  const again = await page.request.post("/api/konto/leping", { data: { registrationId: reg, version: "whatever" } });
  expect([again.status(), await again.json()]).toEqual([409, { ok: false, error: "nothing" }]);
  expect(await storedContracts(email)).toHaveLength(2);
  expect((await page.request.get(`/api/konto/leping/${old}`)).status()).toBe(200);
});

test("the card in Russian: the line, the download, „Подтвердить договор“ and „Подтверждаю“", async ({ page }, info) => {
  submitsForms();
  const { email, f, signIn } = await signedInWith(page, "ctr-ru", info.project.name, ["confirmed"], "ru");
  const reg = f.registrations.confirmed!;
  const mine = await addContract(email, f, reg, { days: 4 });
  await signIn("/ru/konto");
  const c = card(page, `registration-${reg}`);
  await expect(c.locator("[data-contract-line]")).toHaveText(`Договор · подтверждён ${formatDate(new Date(Date.now() - 4 * DAY), "ru")}`);
  await expect(c.getByRole("link", { name: "Скачать (PDF)" })).toHaveAttribute("href", `/api/konto/leping/${mine}`);

  await askAgain(reg);
  await page.reload();
  await expect(c.locator("[data-contract-asked]")).toHaveText("Мария просит вас подтвердить договор.");
  await c.getByRole("button", { name: "Подтвердить договор" }).click();
  await expect(c.locator("[data-contract-panel]")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await c.getByRole("button", { name: "Подтверждаю" }).click();
  await expect(c.locator("[data-contract-line]")).toHaveText(`Договор · подтверждён ${formatDate(new Date(), "ru")}`);
  const rows = await storedContracts(email);
  expect(rows.map((r) => [r.via, r.superseded])).toEqual([["form", true], ["account", false]]);
});
