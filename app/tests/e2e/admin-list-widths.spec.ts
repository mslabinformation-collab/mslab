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
// of its card, and the table's own scroll width is no wider than that. Registreerimised has five columns since A2 (piece 2, Task 4) and Maksed six
// since A6 (Task 13), both on the shared 760 switch: they are measured in table mode at 1180, 1280, 1366 and 1440 as well (the ledger's L163), the
// cells of a row side by side; their phone cards are in admin-inbox.spec.ts. One student's rows are all of it: her registration (and its feedback and
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
    const all = Array.from(tr.querySelectorAll("td")).map((td) => td.getBoundingClientRect());
    // (a phone card hides some cells and gives the payer's cell to the row itself, `display: contents`: those have no box of their own)
    const cells = all.filter((c) => c.width > 0 || c.height > 0);
    return {
      display: getComputedStyle(table).display,
      rowCells: all.length,
      sameTop: cells.every((c) => Math.abs(c.top - cells[0].top) < 1),
      inner: right - left,
      tableScroll: table.scrollWidth,
      cellsLeft: Math.min(...cells.map((c) => c.left)) - left,
      cellsRight: right - Math.max(...cells.map((c) => c.right)),
    };
  });
}

test("every list that uses the shared table keeps all its columns inside its card, from 880 to 1440 px", async ({ page, context, visitorIp, isMobile }, info) => {
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
  // the widest Maksed row there is: a held järelmaks with a check reason (two tags: „Ootel kontrollil“ and „Topeltmakse — tagasta“)
  const worst = await insertStoredPayment({
    email,
    name,
    kind: "balance",
    status: "held",
    amountCents: 17500,
    registrationId,
    courseId: fx.course.id,
    clientId: fx.clientId,
    method: "hirePurchase",
    paid: true,
    minutesAgo: 4,
  });
  await onLocalDb((sql) => sql`update payments set check_reason = 'double' where id = ${worst.id}`, { marksPages: false });
  const [access] = await onLocalDb((sql) => sql<{ id: number }[]>`select id from course_access where client_id = ${fx.clientId}`, { marksPages: false });
  const certificate = await insertCertificate(access.id, "Liis Loend");
  await signInAsAdmin(page, context, visitorIp, created);

  // (`tableAt`: the widths at which the list must be a table, not the stack of rows)
  const lists = [
    { url: `/admin/registreerimised?otsi=${encodeURIComponent(email)}`, row: `tr[data-registration="${registrationId}"]`, widths: [...WIDTHS, 1366, 1440], tableAt: TABLE_WIDTHS, cells: 5 },
    { url: `/admin/opilased?otsi=${encodeURIComponent(email)}`, row: `tr[data-client="${fx.clientId}"]`, widths: WIDTHS, tableAt: [] as number[], cells: 0 },
    // Maksed: six columns, a table from a 761 px card (870 px is the narrowest, 1120 px the widest card that still stacks)
    { url: `/admin/maksed?otsi=${encodeURIComponent(email)}`, row: `tr[data-payment="${payment.reference}"]`, widths: [870, 1120, ...WIDTHS, 1366, 1440], tableAt: [870, ...TABLE_WIDTHS], cells: 6 },
    { url: `/admin/maksed?otsi=${encodeURIComponent(email)}`, row: `tr[data-payment="${worst.reference}"]`, widths: [870, 1120, ...WIDTHS, 1366, 1440], tableAt: [870, ...TABLE_WIDTHS], cells: 6 },
    { url: "/admin/tagasiside", row: `tr[data-feedback-row]:has-text("${name}")`, widths: WIDTHS, tableAt: [] as number[], cells: 0 },
    { url: "/admin/tunnistused", row: `tr[data-register-row="${certificate.id}"]`, widths: WIDTHS, tableAt: [] as number[], cells: 0 },
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
        // the columns side by side: the cells of the row share one line each (no cell is stacked under another)
        expect(f.rowCells, `${where}: ${list.cells} cells in a row`).toBe(list.cells);
        expect(f.sameTop, `${where}: the cells start on one line`).toBe(true);
      }
    }
  }
});

// Koolitused (B1, piece 3a) is a list of rows (DragList's `ol > li`) with a grid for the columns, not the shared table, and has three layouts by the width of its
// card: the README's eight columns on a card from 1040 px (a 1440 screen with the sidebar), two lines on a middle one (761 to 1039: an iPad, a small laptop), and the
// phone card from 760 px down. At each width every cell of a seeded row lies inside the content box of the card, the page does not scroll sideways, and the row has the
// grid it should.
test("Koolitused keeps its cells inside its card from 390 to 1440 px: eight columns, two lines, or the phone card", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  info.setTimeout(info.timeout + 60_000);
  await signInAsAdmin(page, context, visitorIp, created);
  // the viewport's width, how many tracks a row's grid has, and whether the heading row over the columns is drawn
  const layouts = [
    { width: 390, tracks: 4, headed: false },
    { width: 880, tracks: 5, headed: false },
    { width: 1180, tracks: 5, headed: false },
    { width: 1280, tracks: 5, headed: false },
    { width: 1360, tracks: 5, headed: false },
    { width: 1440, tracks: 8, headed: true },
  ];
  for (const { width, tracks, headed } of layouts) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/koolitused");
    await adminReady(page);
    const rowBox = page.locator("[data-course-row]").first();
    await expect(rowBox, `${width} px: a row`).toBeVisible();
    const f = await rowBox.evaluate((row) => {
      const card = row.closest("section")!;
      const css = getComputedStyle(card);
      const box = card.getBoundingClientRect();
      const left = box.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
      const right = box.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
      // the cells: the row's children, and the children of the wrapper that takes no box of its own (display: contents) on a wide card
      const cells = Array.from(row.children)
        .flatMap((c) => (getComputedStyle(c).display === "contents" ? Array.from(c.children) : [c]))
        .map((c) => ({ name: c.className.toString().trim().split(/\s+/).pop() ?? "", rect: c.getBoundingClientRect() }))
        .filter((c) => c.rect.width > 0 && c.rect.height > 0);
      const grid = getComputedStyle(row).gridTemplateColumns.split(" ").length;
      const list = row.closest("ol")!;
      const head = document.querySelector("[data-course-head]")!;
      return {
        inner: right - left,
        cellsLeft: Math.min(...cells.map((c) => c.rect.left)) - left,
        cellsRight: right - Math.max(...cells.map((c) => c.rect.right)),
        listScroll: list.scrollWidth,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        grid,
        headed: getComputedStyle(head).display !== "none",
        names: cells.map((c) => c.name),
        lefts: cells.map((c) => c.rect.left),
        // the title's, the type / price / badge line's (the wrapper has a box of its own on a middle card) and the status's boxes, for the two-line layout
        title: cells.find((c) => /titleCell$/.test(c.name))?.rect.toJSON() as { top: number; bottom: number; left: number },
        meta: cells.find((c) => /meta$/.test(c.name))?.rect.toJSON() as { top: number; bottom: number; left: number },
        status: cells.find((c) => /statusCell$/.test(c.name))?.rect.toJSON() as { top: number; left: number; right: number },
        line: cells.find((c) => /phoneLine$/.test(c.name))?.rect.toJSON() as { top: number; left: number },
      };
    });
    const where = `/admin/koolitused at ${width} px (card ${Math.round(f.inner)} px)`;
    expect(f.cellsLeft, `${where}: the first cell against the card's left edge`).toBeGreaterThanOrEqual(-9); // (the row bleeds 8 px into the card's padding, its cells do not)
    expect(f.cellsLeft, `${where}: the cells start inside the card's content`).toBeGreaterThanOrEqual(-1);
    expect(f.cellsRight, `${where}: the last cell against the card's right edge`).toBeGreaterThanOrEqual(-1);
    expect(f.listScroll, `${where}: the list's scroll width`).toBeLessThanOrEqual(f.inner + 17);
    expect(f.pageScroll, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
    expect(f.grid, `${where}: the row's grid has ${tracks} tracks`).toBe(tracks);
    expect(f.headed, `${where}: the heading row`).toBe(headed);
    if (width === 1440) {
      // the README's eight columns side by side: the cells in the order of the columns, each to the right of the one before
      expect(f.lefts.length, `${where}: eight cells`).toBe(8);
      expect(f.lefts, `${where}: left to right`).toEqual([...f.lefts].sort((a, b) => a - b));
      expect(new Set(f.lefts.map(Math.round)).size, `${where}: no two in one column`).toBe(8);
    } else if (width >= 880) {
      // two lines: the type, price and badge under the title, the status on the title's line
      expect(f.meta.top, `${where}: the type, price and badge under the title`).toBeGreaterThanOrEqual(f.title.bottom - 1);
      expect(f.status.top, `${where}: the status on the title's line`).toBeLessThan(f.title.bottom);
      expect(f.status.left, `${where}: the status beside the title`).toBeGreaterThan(f.title.left);
    } else {
      // the phone card: „{Õppevorm} · {Staatus}“ under the title, and no arrows, price, badge or tags
      expect(f.line.top, `${where}: the line under the title`).toBeGreaterThanOrEqual(f.title.bottom - 1);
      expect(f.line.left, `${where}: the line in the title's column`).toBeLessThanOrEqual(f.title.left + 1);
      expect(f.names.some((n) => /arrowsCell$|__price$|badgeCell$|statusCell$|__type$/.test(n)), `${where}: no arrows, price, badge or tags`).toBe(false);
    }
  }
});
