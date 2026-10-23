import type { BrowserContext, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { signInAsAdmin } from "./admin-login";
import { insertAdminFixtures, onLocalDb, removeAdminFixtures, removeAdminRows, type AdminFixtures } from "./fixtures";
import { expectFits, openDrawer, openRow, today } from "./invoices";

// Contracts, Maria's side (contracts Task 5, spec §4): the registration drawer's „Leping“ (the current contract with its PDF and „Saada koopia
// õpilasele“, „Saada leping kinnitamiseks“ and the pending state, the no-account words, a cancelled registration), the Õpilased drawer's „Lepingud“, and
// the guard of the two PDF routes. Seaded → „Lepingud“ is in admin-site.spec.ts (it changes shared settings and runs after the others). The signed-in
// tests run against the local dev server only: they sign in as Dim through the devLink and look at rows each test inserts for itself and deletes again
// (tests/e2e/fixtures.ts, an unpublished fixture course; its contracts keep their rows when the registration goes — set null — so they are deleted by
// the student's address). No mail is sent here (no RESEND_API_KEY): the ask is recorded and says it was not mailed, a copy answers „Kirjade saatmine pole siin seadistatud.“ (Minor 9:
// refused before its PDF is drawn).

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
let fx: AdminFixtures | null = null;
const clientIds: number[] = [];

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  try {
    if (fx) {
      await onLocalDb((sql) => sql`delete from contracts where fields->'student'->>'email' like ${`%${fx!.tag}%`}`, { marksPages: false });
      await onLocalDb((sql) => sql`delete from clients where email like ${`%${fx!.tag}%`}`, { marksPages: false });
      expect(await removeAdminFixtures(fx.tag)).toBe(0);
    }
  } finally {
    fx = null;
    clientIds.length = 0;
  }
});

async function fixtures(project: string): Promise<AdminFixtures> {
  fx = await insertAdminFixtures(project);
  return fx;
}
const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);

/** An account for the fixture registration's address, and the registration linked to it. */
async function linkAccount(f: AdminFixtures): Promise<number> {
  const id = await onLocalDb(async (sql) => {
    const [client] = await sql<{ id: number }[]>`insert into clients (email, name) values (${f.registration.email}, ${f.registration.name}) returning id`;
    await sql`update registrations set client_id = ${client.id} where id = ${f.registration.id}`;
    return client.id;
  }, { marksPages: false });
  clientIds.push(id);
  return id;
}

/** A frozen contract of the fixture registration: `accepted` days ago, the way, and (for a replaced one) the day it was superseded. */
async function addContract(f: AdminFixtures, clientId: number | null, over: { title?: string; via?: string; acceptedDaysAgo?: number; supersededDaysAgo?: number | null } = {}): Promise<number> {
  const fields = { school: { company: "E2E OÜ", registryCode: "", address: "" }, student: { name: f.registration.name, email: f.registration.email }, course: f.course.title, session: "", price: "350,00 €", payment: "" };
  return onLocalDb(async (sql) => {
    const [row] = await sql<{ id: number }[]>`
      insert into contracts (kind, registration_id, course_id, client_id, version, locale, title, body, fields, accepted_at, accepted_via, superseded_at)
      values ('contact', ${f.registration.id}, ${f.course.id}, ${clientId}, '1', 'et', ${over.title ?? "E2E Kontaktkoolituse leping"}, 'E2E tekst.', ${sql.json(fields)},
              now() - ${(over.acceptedDaysAgo ?? 0) + " days"}::interval, ${over.via ?? "form"},
              ${over.supersededDaysAgo == null ? null : sql`now() - ${over.supersededDaysAgo + " days"}::interval`})
      returning id`;
    return row.id;
  }, { marksPages: false });
}

test.describe("guard", () => {
  test("the contract PDF and the sample need a session", async ({ request }) => {
    const get = await request.get("/api/admin/leping/1");
    expect([get.status(), await get.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    const post = await request.post("/api/admin/naidisleping", { form: { titleEt: "X", bodyEt: "Y" } });
    expect([post.status(), await post.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
  });
});

test.describe("the registration drawer's „Leping“", () => {
  test("no account: a folded row saying there is no contract (on a phone: „puudub“), then the words of the spec and no button; the block fits the screen", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    const { drawer } = await openDrawer(page, f);
    // closed, the row says what is inside (README A2 drawer 5, P-3); the words are the phone's own on a phone
    const fold = drawer.locator("details[data-fold]").filter({ hasText: /^\s*Leping/ });
    await expect(fold).toHaveJSProperty("open", false);
    await expect(fold.locator("[data-fold-summary]")).toHaveText("Sellele registreeringule pole lepingut");
    await expect(fold.locator("[data-fold-summary-short]")).toHaveText("puudub");
    await expect(isMobile ? fold.locator("[data-fold-summary-short]") : fold.locator("[data-fold-summary]")).toBeVisible();
    await expect(isMobile ? fold.locator("[data-fold-summary]") : fold.locator("[data-fold-summary-short]")).toBeHidden();
    const block = (await openRow(drawer, "Leping")).locator("[data-registration-contracts]");
    await expect(block).toHaveAttribute("aria-label", "Leping");
    await expect(block.locator("[data-contracts-none]")).toHaveText("Sellele registreeringule pole lepingut.");
    await expect(block.locator("[data-contract-no-account]")).toHaveText("Õpilasel pole kontot — lisa ta Õpilased lehel.");
    await expect(block.getByRole("button")).toHaveCount(0);
    await expectFits(page, drawer, "the drawer of a registration without an account");
  });

  test("an account and a contract: the PDF as Maria downloads it, the copy that cannot go here, the ask recorded and shown as pending", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    const clientId = await linkAccount(f);
    const current = await addContract(f, clientId, { acceptedDaysAgo: 1 });
    const old = await addContract(f, clientId, { title: "E2E vana leping", via: "account", acceptedDaysAgo: 9, supersededDaysAgo: 1 });
    await signIn(page, context, visitorIp);
    const { drawer } = await openDrawer(page, f);
    // closed, the row's summary is the contract's state (P-3)
    await expect(drawer.locator("details[data-fold]").filter({ hasText: /^\s*Leping/ }).locator("[data-fold-summary]")).toHaveText(/^Kinnitatud \d\d\.\d\d\.\d{4}$/);
    const block = (await openRow(drawer, "Leping")).locator("[data-registration-contracts]");

    // the current contract first, the superseded one after it
    await expect(block.locator("[data-contract]")).toHaveCount(2);
    expect(await block.locator("[data-contract]").evaluateAll((els) => els.map((e) => e.getAttribute("data-contract-state")))).toEqual(["current", "superseded"]);
    const row = block.locator(`[data-contract="${current}"]`);
    await expect(row).toContainText("E2E Kontaktkoolituse leping");
    await expect(row.locator("[data-contract-facts]")).toContainText("Registreerimisvorm");
    await expect(row.getByRole("button")).toHaveText(["Saada koopia õpilasele"]);
    const oldRow = block.locator(`[data-contract="${old}"]`);
    await expect(oldRow.locator("[data-contract-superseded]")).toContainText("Asendatud");
    await expect(oldRow.getByRole("button")).toHaveCount(0);
    await expect(oldRow.locator("[data-contract-facts]")).toContainText("Õpilase konto");

    // its PDF, as Maria downloads it
    const href = (await row.locator("[data-contract-download]").getAttribute("href"))!;
    expect(href).toBe(`/api/admin/leping/${current}`);
    const pdf = await page.request.get(href);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["content-disposition"]).toBe(`attachment; filename="MS-LAB-leping-${current}.pdf"`);
    expect(pdf.headers()["cache-control"]).toBe("private, no-store");
    expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await page.request.get(`/api/admin/leping/${current + 100_000}`)).status()).toBe(404);

    // a copy cannot go without Resend: it says so in words that do not ask to retry (Minor 9), and no send is recorded
    await row.getByRole("button", { name: "Saada koopia õpilasele" }).click();
    await expect(block.locator("[data-contract-status]")).toHaveText("Kirjade saatmine pole siin seadistatud.");
    expect((await onLocalDb((sql) => sql<{ sentAt: Date | null }[]>`select sent_at as "sentAt" from contracts where id = ${current}`, { marksPages: false }))[0].sentAt).toBeNull();

    // the ask: recorded, said not to be mailed, then pending on the page with today's date
    await expect(block.locator("[data-contract-pending]")).toHaveCount(0);
    await block.getByRole("button", { name: "Saada leping kinnitamiseks" }).click();
    await expect(block.locator("[data-contract-status]")).toHaveText("Palve on märgitud, aga kirja ei saadetud. Õpilane näeb seda oma kontol ka ilma kirjata.");
    const [y, m, d] = today().split("-");
    await expect(block.locator("[data-contract-pending]")).toHaveText(`Kinnitamist ootab (saadetud ${d}.${m}.${y})`);
    await expect(drawer.locator("details[data-fold]").filter({ hasText: /^\s*Leping/ }).locator("[data-fold-summary]")).toHaveText(`Kinnitamist ootab (saadetud ${d}.${m}.${y})`);
    expect((await onLocalDb((sql) => sql<{ at: Date | null }[]>`select contract_requested_at as at from registrations where id = ${f.registration.id}`, { marksPages: false }))[0].at).toBeInstanceOf(Date);
    // the contract itself is as it was
    expect((await onLocalDb((sql) => sql<{ superseded: Date | null }[]>`select superseded_at as superseded from contracts where id = ${current}`, { marksPages: false }))[0].superseded).toBeNull();
    await expectFits(page, drawer, "the drawer of a registration with a contract");
  });

  test("a cancelled registration keeps its contracts and has no button to ask", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    const clientId = await linkAccount(f);
    const current = await addContract(f, clientId);
    // (it was asked before it was cancelled: cancelling never clears the ask, and the block does not show it as pending)
    await onLocalDb((sql) => sql`update registrations set status = 'cancelled', contract_requested_at = now() where id = ${f.registration.id}`, { marksPages: false });
    await signIn(page, context, visitorIp);
    const { drawer } = await openDrawer(page, f);
    const block = (await openRow(drawer, "Leping")).locator("[data-registration-contracts]");
    await expect(block.locator(`[data-contract="${current}"]`)).toBeVisible();
    await expect(block.locator("[data-contract-pending]")).toHaveCount(0);
    await expect(block.getByRole("button", { name: "Saada leping kinnitamiseks" })).toHaveCount(0);
    await expect(block.locator("[data-contract-no-account]")).toHaveCount(0);
    await expect(block.locator(`[data-contract-download="${current}"]`)).toBeVisible();
  });

  test("an individual registration has no „Leping“ block (no contract is made for it)", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await onLocalDb((sql) => sql`update registrations set kind = 'individual', course_session_id = null where id = ${f.registration.id}`, { marksPages: false });
    await signIn(page, context, visitorIp);
    await openDrawer(page, f);
    await expect(page.locator("[data-registration-contracts]")).toHaveCount(0);
  });
});

test.describe("the Õpilased drawer's „Lepingud“", () => {
  test("her contracts newest first with the superseded one marked, each with its PDF and the contact one with a link to its registration", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    const clientId = await linkAccount(f);
    // (the newest was frozen before her account existed — client_id null — and is hers through her linked registration: ruling R14)
    const current = await addContract(f, null, { acceptedDaysAgo: 1, via: "account" });
    const old = await addContract(f, clientId, { title: "E2E vana leping", acceptedDaysAgo: 8, supersededDaysAgo: 1 });
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/opilased?id=${clientId}`);
    // „Lepingud“ is a folded row of the drawer (README A5) with its count; opened, it lists them
    const row = page.locator("details[data-fold]", { has: page.locator("summary", { hasText: "Lepingud" }) });
    await expect(row.locator("[data-fold-summary]")).toHaveText("2");
    await row.locator("summary").click();
    const section = row.locator("[data-client-contracts]");
    expect(await section.locator("[data-client-contract]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client-contract")))).toEqual([String(current), String(old)]);
    await expect(section.locator(`[data-client-contract="${current}"]`)).toContainText("Õpilase konto");
    await expect(section.locator(`[data-client-contract="${old}"]`)).toContainText("Asendatud");
    await expect(section.locator(`[data-client-contract="${current}"] [data-contract-registration]`)).toHaveAttribute("href", `/admin/registreerimised?id=${f.registration.id}`);
    const pdf = await page.request.get((await section.locator(`[data-contract-download="${old}"]`).getAttribute("href"))!);
    expect([pdf.status(), pdf.headers()["content-disposition"]]).toEqual([200, `attachment; filename="MS-LAB-leping-${old}.pdf"`]);
    await expect(page.locator("[data-client-terms]")).toHaveCount(0);
  });
});
