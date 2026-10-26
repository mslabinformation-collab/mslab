import { readFileSync } from "node:fs";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { sessionText } from "../../src/domain/contract";
import { euro } from "../../src/domain/invoice";
import { prepaymentDue } from "../../src/domain/registration";
import { formatDate } from "../../src/i18n/format";
import { readPdf } from "../pdf-read";
import { clientEmail, insertClient, signInAsClient } from "./account";
import { adminReady, publishLegalText, signInAsAdmin } from "./admin-login";
import { holdContractTexts, holdLegalDraft } from "./contracts";
import { test } from "./edit-lock";
import { onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { expectFits, holdInvoiceSettings, INVOICE_COMPANY, noOverflow, openRow, today, WIDTHS } from "./invoices";
import { E2E_MONTONIO } from "./montonio-values";
import { expect as plainExpect, submitsForms } from "./test";

// Contracts end to end (contracts Task 7; spec §4): one continuous path on the local server and the local Postgres, the whole life of one contract
// as the people in it meet it —
//   1. Maria writes the contact course's contract text with placeholders in Seaded → „Kontaktkoolituse leping“ (its draft) and publishes it with
//      „Avalda uus leping“ (admin UX pass piece 3b, Task 5), and „Näidisleping (PDF)“ answers a PDF;
//   2. a visitor (a student whose address already has an account) registers on the course page with the box ticked; before she sends it the inline
//      „Loe lepingut“ shows the text filled with the session she chose; the registration stores the contract, filled with the same text;
//   3. Maria's registration drawer shows the contract, and its PDF downloads with the school, the student, the session and the way;
//   4. Maria presses „Saada leping kinnitamiseks“, the student signs in, her card offers „Kinnita leping“, and „Kinnitan“ makes the new contract: the old one
//      is „Asendatud“ on Maria's drawer, the ask is cleared;
//   5. the student downloads her PDF.
// The form's preview, the drawer's block and the card are looked at in a phone's, a tablet's, an iPad's and a desktop's width (390, 834, 1194, 1440).
// Nothing is paid and no mail goes out (a sample address, no Resend). No Montonio: an e-course purchase's contract is covered by the database tests
// (tests/db/contracts-flows.test.ts); the registration only starts its payment at the fake bank and leaves it there.
//
// It writes the shared contract text and the seller card, so it is one of the edit specs (playwright.config.ts EDITS: after every other test, desktop
// only, and in the production build one test at a time: edit-lock.ts) and takes the turn at the text (contracts.ts holdContractTexts). Its rows are
// found by the ids it stored and deleted by them: the contracts keep their rows when the registration or the account goes (their links are set null).

// (The path crosses a dozen pages and routes the dev server compiles on first use, beside the other edit specs: 15 s for an expectation, not the default 5.)
const expect = plainExpect.configure({ timeout: 15_000 });

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const undo: (() => Promise<unknown>)[] = [];
/** The rows this test made, by id, for the clean-up. */
const mine: { client: number | null; registration: number | null; email: string | null } = { client: null, registration: null, email: null };

test.afterEach(async () => {
  try {
    if (mine.registration !== null || mine.client !== null) {
      await onLocalDb(
        async (sql) => {
          const contractIds = (await sql<{ id: number }[]>`select id from contracts where registration_id = ${mine.registration} or client_id = ${mine.client}`).map((c) => c.id);
          if (contractIds.length) await sql`delete from contracts where id in ${sql(contractIds)}`;
          if (mine.registration !== null) {
            await sql`delete from payments where registration_id = ${mine.registration}`;
            await sql`delete from registrations where id = ${mine.registration}`;
          }
          if (mine.client !== null) await sql`delete from clients where id = ${mine.client}`;
        },
        { marksPages: mine.registration !== null }, // (a registration held a seat the course page counted)
      );
    }
    if (mine.email) expect(await removeClientRows(mine.email), "rows of the test address left").toBe(0);
  } finally {
    mine.client = mine.registration = mine.email = null;
    for (const step of undo.splice(0).reverse()) await step();
    await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
  }
});

/** Maria's text (spec D2): its placeholders, one of each. */
const TITLE = "E2E Kontaktkoolituse leping";
const BODY = "Õpilane {nimi} ({e-post}) registreerub koolitusele {koolitus}.\n\nToimumine: {toimumine}.\n\nHind {hind}, ettemaks {ettemaks}.";
const NAME = "Kati Tamm";
/** The screens' heights for the four widths the specs look at. */
const HEIGHTS: Record<(typeof WIDTHS)[number], number> = { 390: 844, 834: 1112, 1194: 834, 1440: 900 };

/** Runs `check` with the window at each width (390, 834, 1194, 1440) and puts it back to a desktop's 1440 × 900. */
async function atEachWidth(page: Page, check: (width: number) => Promise<void>): Promise<void> {
  try {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHTS[width] });
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))); // (the layout has settled)
      await check(width);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

/** The text of every page of a PDF, one run to a line, in the order they were drawn. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const first = await readPdf(bytes, 0);
  const rest = await Promise.all(first.pages.slice(1).map((_, i) => readPdf(bytes, i + 1)));
  return [first, ...rest].flatMap((p) => p.runs.map((r) => r.text)).join("\n");
}

/** A PDF answer as a download: the bytes (a PDF), and the headers every contract download carries. */
async function expectPdf(res: Awaited<ReturnType<Page["request"]["get"]>>, id: number): Promise<Uint8Array> {
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toBe(`attachment; filename="MS-LAB-leping-${id}.pdf"`);
  expect(res.headers()["cache-control"]).toBe("private, no-store");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  const bytes = new Uint8Array(await res.body());
  expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  return bytes;
}

/** The inline contract of the registration form at the width it has now: the toggle is a finger's size, the text stays inside the window and scrolls inside itself. */
async function previewFits(page: Page, toggle: Locator, preview: Locator): Promise<void> {
  const width = page.viewportSize()!.width;
  expect(await noOverflow(page), `the form at ${width}: the page scrolls sideways`).toBe(true);
  const box = await toggle.evaluate((el) => el.getBoundingClientRect().height);
  expect(box, `„Loe lepingut“ at ${width}`).toBeGreaterThanOrEqual(44);
  const inside = await preview.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= document.documentElement.clientWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
  });
  expect(inside, `the inline contract at ${width}: it runs outside the window or sideways`).toBe(true);
}

/** A text as the screen shows it, to be compared: no-break spaces are spaces, and a blank line between paragraphs is one line break. */
const plain = (text: string): string => text.split(String.fromCharCode(0xa0)).join(" ").replace(/\n+/g, "\n").trim();

const phone = (info: TestInfo) => info.project.name.startsWith("mobile");

test("a contract from Maria's text to the student's PDF: written in Seaded, accepted on the form, in Maria's drawer, asked again, „Kinnitan“, downloaded", async ({ page, context, visitorIp }, info) => {
  submitsForms();
  test.skip(phone(info), "one path on the desktop project; it looks at the four widths itself");
  test.setTimeout(240_000);
  // the school of every contract is the seller of Seaded → „Maksmine“ (the invoice settings), and the text is Maria's: both in the shared settings, put back afterwards
  undo.push(await holdInvoiceSettings(info));
  undo.push(await holdContractTexts(info));
  undo.push(await holdLegalDraft("contract_contact"));
  // (her text not written yet: the turn puts back what was there)
  await onLocalDb(async (sql) => {
    await sql`delete from pages where key = 'contract_contact'`;
    await sql`delete from settings where key = 'contractContactVersion'`;
  });
  const email = clientEmail("contract", info.project.name);
  await removeClientRows(email);
  mine.email = email;

  // ---------- 1. Maria writes the text in Seaded ----------
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/seaded");
  await adminReady(page);
  const texts = page.locator('[data-legal-editor="contract_contact"]');
  await texts.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill(TITLE);
  await texts.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true }).fill(BODY);
  // typing is its draft; „Avalda uus leping“ → „Jah, avalda“ publishes it (sending what is typed first)
  expect((await publishLegalText(page, texts, "contract_contact", "Avalda uus leping")).status()).toBe(200);
  await expect(texts.locator("[data-legal-said]")).toHaveText("Uus kontaktkoolituse leping on avaldatud.");
  const version = await onLocalDb((sql) => sql<{ v: string }[]>`select value #>> '{}' as v from settings where key = 'contractContactVersion'`, { marksPages: false });
  expect(version).toHaveLength(1);

  // „Näidisleping (PDF)“ posts what the screen holds (a form POST into a new tab, ruling R12) and answers a PDF; nothing is stored by it
  const sample = texts.locator("[data-contract-sample-form]");
  await expect(sample.getByRole("button", { name: "Näidisleping (PDF)", exact: true })).toBeVisible();
  const posted = await sample.evaluate((form: HTMLFormElement) => ({ action: form.getAttribute("action")!, fields: Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)])) }));
  expect(posted.action).toBe("/api/admin/naidisleping");
  expect(posted.fields).toMatchObject({ titleEt: TITLE, bodyEt: BODY });
  const sampleRes = await page.request.post(posted.action, { form: { ...posted.fields, lang: "et" } });
  expect(sampleRes.status()).toBe(200);
  expect(sampleRes.headers()["content-type"]).toBe("application/pdf");
  expect(sampleRes.headers()["cache-control"]).toBe("private, no-store");
  const sampleBytes = new Uint8Array(await sampleRes.body());
  expect(Buffer.from(sampleBytes.subarray(0, 4)).toString("latin1")).toBe("%PDF");
  expect(await pdfText(sampleBytes)).toContain(TITLE);

  // ---------- 2. a visitor registers with the box ticked ----------
  mine.client = await insertClient(email, { name: NAME }); // (her address has an account: the registration is linked to it at once, and Maria can ask her to confirm)
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  const form = page.locator("[data-register-form]");
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").first().click();
  const sessionId = Number(await page.locator("[data-session][aria-checked='true']").getAttribute("data-session"));
  await form.getByLabel("Nimi").fill(NAME);
  await form.getByLabel("E-post", { exact: true }).fill(email);
  await form.getByLabel("Telefon").fill("+3725555555");
  await form.getByRole("radio", { name: /50% registreerimisel/ }).check();
  await form.getByLabel(/lepingu tingimustega/).check();

  const chosen = await onLocalDb(
    (sql) => sql<{ startsAt: Date; city: string; venue: string; title: string; price: number }[]>`
      select s.starts_at as "startsAt", s.city, s.venue, c.title->>'et' as title, c.price_group as price
      from course_sessions s join courses c on c.id = s.course_id where s.id = ${sessionId}`,
    { marksPages: false },
  );
  expect(chosen).toHaveLength(1);
  const { title: courseTitle, price } = chosen[0];
  const when = sessionText(chosen[0]);
  const filled = `Õpilane ${NAME} (${email}) registreerub koolitusele ${courseTitle}.\n\nToimumine: ${when}.\n\nHind ${euro(price)}, ettemaks ${euro(prepaymentDue(price, "half"))}.`;

  // the inline contract shows the text with the chosen session's date and place, the price and the name and address she typed
  const toggle = form.locator("[data-contract-toggle]");
  const preview = form.locator("[data-contract-preview]");
  await expect(toggle).toHaveText("Loe lepingut");
  await expect(preview).toBeHidden();
  await toggle.click();
  await expect(preview).toBeVisible();
  expect(plain(await preview.innerText())).toBe(plain(`${TITLE}\n${filled}`));
  await atEachWidth(page, () => previewFits(page, toggle, preview));

  await form.getByRole("button", { name: "Registreeru" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`); // (the prepayment starts at the fake bank; it is left there)
  const [registration] = await onLocalDb((sql) => sql<{ id: number; clientId: number | null; status: string }[]>`select id, client_id as "clientId", status from registrations where email = ${email}`, { marksPages: false });
  expect(registration).toMatchObject({ clientId: mine.client, status: "awaiting_prepayment" });
  mine.registration = registration.id;

  // the contract the registration froze, from the same text
  const [first] = await onLocalDb(
    (sql) => sql<{ id: number; kind: string; via: string; version: string; locale: string; title: string; body: string; fields: Record<string, unknown>; current: boolean; client: number | null; sent: Date | null }[]>`
      select id, kind, accepted_via as via, version, locale, title, body, fields, superseded_at is null as current, client_id as client, sent_at as sent
      from contracts where registration_id = ${registration.id}`,
    { marksPages: false },
  );
  expect(first).toMatchObject({ kind: "contact", via: "form", version: version[0].v, locale: "et", title: TITLE, body: filled, current: true, client: mine.client, sent: null });
  expect(first.fields).toEqual({
    school: { company: INVOICE_COMPANY, registryCode: "12345678", address: "Testi 1, Pärnu" },
    student: { name: NAME, email },
    course: courseTitle,
    session: when,
    price: euro(price),
    payment: "50% registreerimisel + 50% koolituspäeval",
  });

  // ---------- 3. Maria's drawer shows it, and the PDF downloads ----------
  await page.goto(`/admin/registreerimised?id=${registration.id}`);
  const drawer = page.getByRole("dialog", { name: `Registreerimine: ${NAME}` });
  await expect(drawer).toBeVisible();
  // (a folded row of the drawer: closed it says „Kinnitatud {date}“; opened, the block is in it)
  await expect(drawer.locator("details[data-fold]").filter({ hasText: /^\s*Leping/ }).locator("[data-fold-summary]")).toHaveText(`Kinnitatud ${formatDate(new Date(), "et")}`);
  const block = (await openRow(drawer, "Leping")).locator("[data-registration-contracts]");
  await expect(block).toHaveAttribute("aria-label", "Leping");
  await expect(block.locator("[data-contract]")).toHaveCount(1);
  const row = block.locator(`[data-contract="${first.id}"]`);
  await expect(row).toHaveAttribute("data-contract-state", "current");
  await expect(row).toContainText(TITLE);
  await expect(row.locator("[data-contract-facts]")).toContainText(`Kinnitatud ${formatDate(new Date(), "et")} · Registreerimisvorm`);
  await expect(row.locator("[data-contract-superseded]")).toHaveCount(0);
  const href = (await row.locator("[data-contract-download]").getAttribute("href"))!;
  expect(href).toBe(`/api/admin/leping/${first.id}`);
  const adminPdf = await expectPdf(await page.request.get(href), first.id);
  const adminText = await pdfText(adminPdf);
  for (const part of [TITLE, INVOICE_COMPANY, NAME, email, courseTitle, when.split(",")[0], "Kinnitatud elektrooniliselt", "registreerimisvorm"])
    expect(adminText, `Maria's PDF holds „${part}“`).toContain(part);
  expect(adminText).not.toContain("Asendatud");
  await expect(block.getByRole("button", { name: "Saada leping kinnitamiseks" })).toBeVisible();
  await expect(block.locator("[data-contract-no-account]")).toHaveCount(0);
  await atEachWidth(page, () => expectFits(page, block, "Maria's „Leping“ block"));

  // ---------- 4. Maria asks again; the student confirms ----------
  await block.getByRole("button", { name: "Saada leping kinnitamiseks" }).click();
  await expect(block.locator("[data-contract-status]")).toHaveText("Palve on märgitud, aga kirja ei saadetud. Õpilane näeb seda oma kontol ka ilma kirjata.");
  const [y, m, d] = today().split("-");
  await expect(block.locator("[data-contract-pending]")).toHaveText(`Kinnitamist ootab (saadetud ${d}.${m}.${y})`);

  await signInAsClient(page, email);
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  const card = page.locator(`[data-card="registration-${registration.id}"]`);
  await expect(card.locator("[data-contract-asked]")).toHaveText("Maria palub sul lepingu kinnitada.");
  const open = card.locator("[data-card-contract-open]");
  await expect(open).toHaveText("Kinnita leping");
  await open.click();
  const panel = card.locator("[data-contract-panel]");
  await expect(panel).toBeVisible();
  // the current text, filled with her registration (the same words the form showed)
  await expect(panel).toContainText(TITLE); // (the text is read from the server when the panel opens)
  expect(plain(await panel.innerText())).toBe(plain(`${TITLE}\n${filled}`));
  const accept = card.getByRole("button", { name: "Kinnitan", exact: true });
  await expect(accept).toBeVisible();
  await atEachWidth(page, () => expectFits(page, card.locator("[data-card-contract]"), "the card with the contract open"));

  await accept.click();
  await expect(card.locator("[data-contract-line]")).toHaveText(`Leping · kinnitatud ${formatDate(new Date(), "et")}`);
  await expect(card.locator("[data-contract-asked]")).toHaveCount(0);
  await atEachWidth(page, () => expectFits(page, card.locator("[data-card-contract]"), "the card with the contract line"));

  const stored = await onLocalDb(
    (sql) => sql<{ id: number; via: string; superseded: boolean; client: number | null; title: string; body: string }[]>`
      select id, accepted_via as via, superseded_at is not null as superseded, client_id as client, title, body from contracts where registration_id = ${registration.id} order by id`,
    { marksPages: false },
  );
  expect(stored).toEqual([
    { id: first.id, via: "form", superseded: true, client: mine.client, title: TITLE, body: filled },
    { id: stored[1].id, via: "account", superseded: false, client: mine.client, title: TITLE, body: filled },
  ]);
  const [asked] = await onLocalDb((sql) => sql<{ at: Date | null }[]>`select contract_requested_at as at from registrations where id = ${registration.id}`, { marksPages: false });
  expect(asked.at).toBeNull();
  const second = stored[1].id;

  // Maria sees the old one „Asendatud“ and the new one as the account's
  await page.goto(`/admin/registreerimised?id=${registration.id}`);
  const after = (await openRow(page.getByRole("dialog", { name: `Registreerimine: ${NAME}` }), "Leping")).locator("[data-registration-contracts]");
  await expect(after.locator("[data-contract]")).toHaveCount(2);
  expect(await after.locator("[data-contract]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-contract"), e.getAttribute("data-contract-state")]))).toEqual([
    [String(second), "current"],
    [String(first.id), "superseded"],
  ]);
  await expect(after.locator(`[data-contract="${first.id}"] [data-contract-superseded]`)).toContainText("Asendatud");
  await expect(after.locator(`[data-contract="${first.id}"] [data-contract-facts]`)).toContainText("Registreerimisvorm");
  await expect(after.locator(`[data-contract="${second}"] [data-contract-facts]`)).toContainText("Õpilase konto");
  await expect(after.locator("[data-contract-pending]")).toHaveCount(0);
  await expect(after.locator(`[data-contract="${first.id}"]`).getByRole("button")).toHaveCount(0);

  // ---------- 5. the student downloads her PDF ----------
  await page.goto("/konto");
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  const link = card.getByRole("link", { name: "Laadi alla (PDF)" });
  await expect(link).toHaveAttribute("href", `/api/konto/leping/${second}`);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe(`MS-LAB-leping-${second}.pdf`);
  const mineBytes = new Uint8Array(readFileSync((await download.path())!));
  expect(Buffer.from(mineBytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  const mineText = await pdfText(mineBytes);
  for (const part of [TITLE, INVOICE_COMPANY, NAME, email, "Kinnitatud elektrooniliselt", "õpilase konto"]) expect(mineText, `her PDF holds „${part}“`).toContain(part);
  expect(mineText).not.toContain("Asendatud");
  // the old one is still hers, marked as replaced
  const oldText = await pdfText(await expectPdf(await page.request.get(`/api/konto/leping/${first.id}`), first.id));
  expect(oldText).toContain("Asendatud");
  expect(oldText).toContain("registreerimisvorm");
});
