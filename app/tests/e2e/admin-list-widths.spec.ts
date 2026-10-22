import type { Page } from "@playwright/test";
import { clientEmail, insertAccountFixtures } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { insertCertificate } from "./certificate";
import { insertStoredPayment, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { insertFeedbackAnswer, runName } from "./protocols";
import { expect, submitsForms, test } from "./test";

// The admin's lists that use the shared list table (list-table.module.css): Registreerimised, Õpilased, Maksed, Tagasiside and Tunnistused. The
// table is a table from a 761 px card (the shared switch is 760), and a table too wide for its card is cut or spills with no scrollbar to find it
// in (admin UX pass, Task 13 fix round: Registreerimised had 9 columns, Maksed 8). So at the widths of an iPad with the top bar (880), an iPad
// and a small laptop with the sidebar (1180, 1280) and a laptop (1360), every cell of a seeded row, in every list, lies inside the content box
// of its card, and the table's own scroll width is no wider than that. Maksed stacks below 980 (`stackAt980`) until its screen (A6) drops
// columns. Registreerimised has five columns since A2 (piece 2, Task 4) and the shared 760 switch: it is measured in table mode at 1180, 1280,
// 1366 and 1440 as well (the ledger's L163); its phone card is in admin-inbox.spec.ts. One student's rows are all of it: her registration (and its feedback and
// payment) and her e-course certificate, removed with her address after the test.

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const made = new Set<string>();

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

const WIDTHS = [880, 1180, 1280, 1360];
/** A laptop's widths, where Registreerimised must be a table (the card is wider than 760 px at each of them). */
const TABLE_WIDTHS = [1180, 1280, 1366, 1440];

/** Where a row's cells lie against the content box of its list's card, and what the table is. */
async function fit(page: Page, row: string) {
  return page.locator(row).evaluate((tr) => {
    const table = tr.closest("table")!;
    const card = table.closest("section")!;
    const css = getComputedStyle(card);
    const box = card.getBoundingClientRect();
    const left = box.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const right = box.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
    const cells = Array.from(tr.querySelectorAll("td")).map((td) => td.getBoundingClientRect());
    return {
      display: getComputedStyle(table).display,
      rowCells: cells.length,
      sameTop: cells.every((c) => Math.abs(c.top - cells[0].top) < 1),
      inner: right - left,
      tableScroll: table.scrollWidth,
      cellsLeft: Math.min(...cells.map((c) => c.left)) - left,
      cellsRight: right - Math.max(...cells.map((c) => c.right)),
    };
  });
}

test("every list that uses the shared table keeps all its columns inside its card at 880, 1180, 1280 and 1360 px", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  info.setTimeout(info.timeout + 120_000); // each page's first view under `next dev` compiles it
  const email = clientEmail("lists", runName(info));
  made.add(email);
  await removeClientRows(email);
  const name = `Liis Loend ${info.project.name}`;
  const fx = await insertAccountFixtures(email, { name, cards: ["confirmed", "ecourse"] });
  const registrationId = fx.registrations.confirmed!;
  await insertFeedbackAnswer(registrationId, { score: 8, expectations: "exceeded", recommend: "Jah, kindlasti." });
  const payment = await insertStoredPayment({
    email,
    name,
    kind: "prepayment",
    status: "paid",
    amountCents: 17500,
    registrationId,
    courseId: fx.course.id,
    clientId: fx.clientId,
    method: "paymentInitiation",
    bank: "Swedbank",
    paid: true,
    minutesAgo: 5,
  });
  const [access] = await onLocalDb((sql) => sql<{ id: number }[]>`select id from course_access where client_id = ${fx.clientId}`, { marksPages: false });
  const certificate = await insertCertificate(access.id, "Liis Loend");
  await signInAsAdmin(page, context, visitorIp, created);

  // (`tableAt`: the widths at which the list must be a table, not the stack of rows)
  const lists = [
    { url: `/admin/registreerimised?otsi=${encodeURIComponent(email)}`, row: `tr[data-registration="${registrationId}"]`, widths: [...WIDTHS, 1366, 1440], tableAt: TABLE_WIDTHS },
    { url: `/admin/opilased?otsi=${encodeURIComponent(email)}`, row: `tr[data-client="${fx.clientId}"]`, widths: WIDTHS, tableAt: [] as number[] },
    { url: "/admin/maksed", row: `tr[data-payment="${payment.reference}"]`, widths: WIDTHS, tableAt: [] as number[] },
    { url: "/admin/tagasiside", row: `tr[data-feedback-row]:has-text("${name}")`, widths: WIDTHS, tableAt: [] as number[] },
    { url: "/admin/tunnistused", row: `tr[data-register-row="${certificate.id}"]`, widths: WIDTHS, tableAt: [] as number[] },
  ];
  for (const list of lists) {
    for (const width of list.widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(list.url);
      await adminReady(page);
      await expect(page.locator(list.row), `${list.url} at ${width} px: the seeded row`).toBeVisible();
      const f = await fit(page, list.row);
      const where = `${list.url} at ${width} px (${f.display}, card ${Math.round(f.inner)} px)`;
      expect(f.tableScroll, `${where}: the table's scroll width`).toBeLessThanOrEqual(f.inner + 1);
      expect(f.cellsRight, `${where}: the last cell's right edge against the card's`).toBeGreaterThanOrEqual(-1);
      expect(f.cellsLeft, `${where}: the first cell's left edge against the card's`).toBeGreaterThanOrEqual(-1);
      if (list.tableAt.includes(width)) {
        expect(f.display, `${where}: a table, not the stack of rows`).toBe("table");
        // the five columns side by side: the cells of the row share one line each (no cell is stacked under another)
        expect(f.rowCells, `${where}: five cells in a row`).toBe(5);
        expect(f.sameTop, `${where}: the cells start on one line`).toBe(true);
      }
    }
  }
});
