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

// Kalender (B3, piece 3b Task 1) is the shared list table with four columns (date and weekday | course and place | seats with a bar | state). Its own session
// is a draft course's (the „Mustand“ tag beside the name) with one student confirmed („1 / 6“). From 1180 to 1440 px the four cells of the row are side by side inside the section's card; from 880 the table stays inside it; and
// the page never scrolls sideways. On a phone (640, 390 and 375 px; the box is 760 px or less, calendar.module.css .box) the section has no card and each session is a
// white card of its own as Part 4 draws it (18 px radius, 14 px 16 px inside, 12 px apart): the day over the short month, the course, the place, the seat bar with
// „{k}/{cap}“ (no state tag, no table figure; the seats are the figure and the bar, nothing else: Dim, 25.10). The city select is the pill „Linn ▾“ in the pill row, 44 px, with the select itself over
// it, and the field above the pills is not drawn: one combobox named „Linn“ is in the accessibility tree.
test("Kalender keeps its cells inside its card from 880 to 1440 px, and each session is a phone card with the city as a pill from 640 px down", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  info.setTimeout(info.timeout + 120_000);
  const email = clientEmail("kalender", runName(info));
  made.add(email);
  await removeClientRows(email);
  const fx = await insertAccountFixtures(email, { name: `Liis Kalender ${info.project.name}`, cards: ["confirmed"] });
  await signInAsAdmin(page, context, visitorIp, created);
  const row = `tr[data-session-row="${fx.session.id}"]`;
  const pageScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const width of [...WIDTHS, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/kalender");
    await adminReady(page);
    await expect(page.locator(row), `${width} px: the seeded row`).toBeVisible();
    const f = await fit(page, row);
    const where = `/admin/kalender at ${width} px (${f.display}, card ${Math.round(f.inner)} px)`;
    expect(f.tableScroll, `${where}: the table's scroll width`).toBeLessThanOrEqual(f.inner + 1);
    expect(f.cellsRight, `${where}: the last cell's right edge against the card's`).toBeGreaterThanOrEqual(-1);
    expect(f.cellsLeft, `${where}: the first cell's left edge against the card's`).toBeGreaterThanOrEqual(-1);
    expect(await pageScroll(), `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
    // above a phone the city select is the plain select above the pills, and the phone's copy in the pill row is not drawn: one combobox named „Linn“ in the
    // accessibility tree and the tab order, outside the pill row
    await expect(page.locator("[data-scope-pill]"), `${where}: no pill`).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Linn" }), `${where}: one city select`).toHaveCount(1);
    expect(await page.getByRole("combobox", { name: "Linn" }).evaluate((el) => el.closest("nav") === null), `${where}: the city select is above the pills`).toBe(true);
    // the section keeps its card (white, padded, rounded) and the rows are the table's own, no cards
    const chrome = await page.locator(row).evaluate((tr) => {
      const sc = getComputedStyle(tr.closest("section")!);
      const rc = getComputedStyle(tr);
      return { card: { background: sc.backgroundColor, padding: sc.paddingLeft, radius: sc.borderTopLeftRadius }, row: { background: rc.backgroundColor, radius: rc.borderTopLeftRadius } };
    });
    expect(chrome.card.background, `${where}: the section's own card`).toBe("rgb(255, 255, 255)");
    expect(chrome.card.padding, `${where}: the section's own card`).not.toBe("0px");
    expect(chrome.row, `${where}: no card of the row's own`).toEqual({ background: "rgba(0, 0, 0, 0)", radius: "0px" });
    if (TABLE_WIDTHS.includes(width)) {
      expect(f.display, `${where}: a table, not the stack of rows`).toBe("table");
      expect(f.rowCells, `${where}: 4 cells in a row`).toBe(4);
      expect(f.sameTop, `${where}: the cells start on one line`).toBe(true);
    }
  }

  for (const width of [640, 390, 375]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/admin/kalender");
    await adminReady(page);
    const card = page.locator(row);
    await expect(card, `${width} px: the card`).toBeVisible();
    const m = await card.evaluate((tr) => {
      const box = (selector: string) => {
        const el = tr.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        row: tr.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number },
        day: box("[data-session-day]"),
        month: box("[data-session-day] > span"),
        link: box("a"),
        place: box("[data-session-place]"),
        bar: box("[data-seats-bar]"),
        short: box("[data-seats-short]"),
        long: box("[data-session-seats]"),
        state: box("[data-session-state]"),
        shortText: tr.querySelector("[data-seats-short]")?.textContent ?? "",
      };
    });
    const where = `/admin/kalender at ${width} px`;
    // separate white cards on the grey canvas (Part 4, as Koolitused draws its rows): the section has no card of its own and is as wide as its box, each row is
    // a white card of 18 px radius with 14 px 16 px inside, and 12 px between one card and the next
    const cards = await page.locator("[data-session-row]").evaluateAll((trs) => {
      const section = trs[0].closest("section")!;
      const sc = getComputedStyle(section);
      return {
        section: { background: sc.backgroundColor, border: sc.borderTopWidth, padding: sc.paddingLeft, radius: sc.borderTopLeftRadius },
        width: section.getBoundingClientRect().width,
        box: section.parentElement!.getBoundingClientRect().width,
        rows: trs.slice(0, 4).map((tr) => {
          const cs = getComputedStyle(tr);
          const r = tr.getBoundingClientRect();
          return { background: cs.backgroundColor, radius: cs.borderTopLeftRadius, padding: `${cs.paddingTop} ${cs.paddingLeft}`, border: cs.borderBottomWidth, top: r.top, bottom: r.bottom };
        }),
      };
    });
    expect(cards.section, `${where}: no card of the section's own`).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", padding: "0px", radius: "0px" });
    expect(Math.abs(cards.width - cards.box), `${where}: the cards use the box's whole width`).toBeLessThanOrEqual(1);
    expect(cards.rows.length, `${where}: at least two sessions to tell cards apart`).toBeGreaterThanOrEqual(2);
    for (const [i, c] of cards.rows.entries()) {
      expect(c, `${where}: row ${i + 1} is a white card`).toMatchObject({ background: "rgb(255, 255, 255)", radius: "18px", padding: "14px 16px", border: "0px" });
      if (i > 0) expect(Math.abs(c.top - cards.rows[i - 1].bottom - 12), `${where}: 12 px between card ${i} and card ${i + 1}`).toBeLessThanOrEqual(1);
    }
    // the day block at the left, over both lines; the course, the place and the bar in the column beside it
    expect(m.day!.width, `${where}: the day block is drawn`).toBeGreaterThan(0);
    expect(m.day!.right, `${where}: the day at the left of the course`).toBeLessThanOrEqual(m.link!.left + 1);
    expect(m.month!.top, `${where}: the month under the day`).toBeGreaterThan(m.day!.top);
    expect(m.place!.top, `${where}: the place under the course`).toBeGreaterThanOrEqual(m.link!.top);
    expect(m.bar!.top, `${where}: the seat bar under the place`).toBeGreaterThanOrEqual(m.place!.bottom - 1);
    expect(m.bar!.width, `${where}: the bar takes what the figure leaves (a 5 px line across the card)`).toBeGreaterThan(m.row.right - m.row.left - 56 - 12 - 32 - 8 - 40);
    expect(m.bar!.height, `${where}: the bar is a thin line`).toBeLessThanOrEqual(6);
    expect(m.short!.left, `${where}: „{k}/{cap}“ beside the bar`).toBeGreaterThanOrEqual(m.bar!.right - 1);
    expect(m.shortText, `${where}: the short figure`).toBe("1/6");
    // what the card leaves out is not drawn: the table's figure and the state tag
    for (const gone of [m.long, m.state]) expect(gone === null || gone.width === 0, `${where}: left out of the card`).toBe(true);
    for (const part of [m.day, m.link, m.place, m.bar, m.short]) expect(part!.right, `${where}: inside the card`).toBeLessThanOrEqual(m.row.right + 1);
    expect(await pageScroll(), `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);

    // the city select is a pill in the pill row (`Tulevased 5 | Möödunud 3 | Linn ▾`, one line at each width): 44 px tall, with the
    // select over it, the word „Linn“ until a city is chosen; the field above the pills is not drawn, so one combobox named „Linn“ is in the accessibility tree
    // and the tab order, and it is the one in the pill row
    const city = page.getByRole("combobox", { name: "Linn" });
    await expect(city, `${where}: one city select`).toHaveCount(1);
    expect(await city.evaluate((el) => el.closest("nav[data-list-pill-row]") !== null), `${where}: the city select is in the pill row`).toBe(true);
    const pill = page.locator("[data-scope-pill]");
    await expect(pill, `${where}: the pill`).toHaveText("Linn");
    const line = await page.locator("nav[data-list-pill-row]").evaluate((nav) => ({ nav: Math.round(nav.getBoundingClientRect().width), items: [...nav.children].map((c) => Math.round(c.getBoundingClientRect().width)), tops: [...nav.children].map((c) => Math.round(c.getBoundingClientRect().top)) }));
    expect(line.tops.length, `${where}: two pills and the city`).toBe(3);
    expect(Math.max(...line.tops) - Math.min(...line.tops), `${where}: Tulevased, Möödunud and Linn on one line (${JSON.stringify(line)})`).toBeLessThanOrEqual(4);
    const [p, s] = await Promise.all([pill.boundingBox(), city.boundingBox()]);
    expect(p!.height, `${where}: the pill is a 44 px target`).toBeGreaterThanOrEqual(44);
    expect(Math.abs(p!.x - s!.x) + Math.abs(p!.y - s!.y) + Math.abs(p!.width - s!.width) + Math.abs(p!.height - s!.height), `${where}: the select lies over the pill`).toBeLessThanOrEqual(2);
    expect(p!.x + p!.width, `${where}: the pill inside the screen`).toBeLessThanOrEqual(width);
    await city.selectOption("Pärnu");
    await expect(pill, `${where}: the chosen city`).toHaveText("Pärnu");
    await expect(page).toHaveURL((url) => url.searchParams.get("linn") === "Pärnu");
    await expect(page.locator(row), `${where}: the row stays in its city`).toBeVisible();
    expect(await pageScroll(), `${where}: the page does not scroll sideways with a city chosen`).toBeLessThanOrEqual(0);
  }
});

// Koolitused (B1, piece 3a) is a list of rows (DragList's `ol > li`) with a grid for the columns, not the shared table, and has four layouts by the width of its
// box (the card's whole width, courses.module.css .box: a card content plus the 58 px of its padding and border, which a phone's card has none of): the README's
// eight columns from 1098 px (a 1440 screen with the sidebar), the same closed up from 998 (a card content of 940: a 1366 laptop, an iPad Pro in landscape), two lines
// from 997 down to 761 (an iPad, a 1280 laptop), and the phone from 760 down, each course a white card of its own. At each width every cell of a seeded row lies
// inside the content box of the card, the page does not scroll sideways, and the row has the grid it should.
// The cases are the box's width the layouts switch on, and the test sets the viewport that gives it: the box is the viewport less the page's scrollbar (the
// headless browser has a classic one, 15 px, which a Windows browser has too; an iPad or a Mac has none, measured here), the sidebar (235 px, none below 900) and
// the page's side padding (2 x 45, 30 from 1180 down, 24 from 899, 16 from 640). The box is measured again at each width, so a change of the shell's widths says so here
// and not as a layout that quietly switches somewhere else.
test("Koolitused keeps its cells inside its card from 390 to 1440 px: eight columns, the closed-up eight, two lines, or the phone cards", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  info.setTimeout(info.timeout + 90_000);
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/koolitused");
  await adminReady(page);
  const scrollbar = await page.evaluate(() => window.innerWidth - document.documentElement.getBoundingClientRect().width);
  // the box's width, the shell's own (sidebar and side paddings) at that width, the row grid's tracks, whether the heading row is drawn, and which layout it is
  const WIDE = [44, 96, 56, 0, 120, 150, 120, 180];
  const CLOSED = [44, 96, 56, 0, 100, 124, 108, 164];
  const layouts = [
    { box: 340, shell: 32, tracks: 4, headed: false, kind: "phone" }, // (a 390 phone)
    { box: 740, shell: 48, tracks: 4, headed: false, kind: "phone" }, // (the widest phone box: 760)
    { box: 830, shell: 48, tracks: 5, headed: false, kind: "lines" }, // (an iPad in portrait)
    { box: 870, shell: 295, tracks: 5, headed: false, kind: "lines" }, // (an iPad Air in landscape: a 1180 viewport)
    { box: 940, shell: 325, tracks: 5, headed: false, kind: "lines" }, // (a 1280 laptop)
    { box: 997, shell: 325, tracks: 5, headed: false, kind: "lines" }, // (the widest box of the two lines)
    { box: 998, shell: 325, tracks: 8, headed: true, kind: "eight", fixed: CLOSED }, // (the narrowest of the closed-up eight: a card content of 940)
    { box: 1000, shell: 325, tracks: 8, headed: true, kind: "eight", fixed: CLOSED },
    { box: 1026, shell: 325, tracks: 8, headed: true, kind: "eight", fixed: CLOSED }, // (a 1366 laptop)
    { box: 1097, shell: 325, tracks: 8, headed: true, kind: "eight", fixed: CLOSED }, // (the widest of them)
    { box: 1100, shell: 325, tracks: 8, headed: true, kind: "eight", fixed: WIDE }, // (a 1440 viewport: the frame's)
  ];
  for (const { box, shell, tracks, headed, kind, fixed } of layouts) {
    const width = Math.round(box + shell + scrollbar);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/koolitused");
    await adminReady(page);
    const rowBox = page.locator("[data-course-row]").first();
    await expect(rowBox, `${width} px: a row`).toBeVisible();
    const f = await rowBox.evaluate((row) => {
      const card = row.closest("section")!;
      const css = getComputedStyle(card);
      const outer = card.getBoundingClientRect();
      const left = outer.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
      const right = outer.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
      // the cells: the row's children, and the children of the wrapper that takes no box of its own (display: contents) on a wide card
      const cells = Array.from(row.children)
        .flatMap((c) => (getComputedStyle(c).display === "contents" ? Array.from(c.children) : [c]))
        .map((c) => ({ name: c.className.toString().trim().split(/\s+/).pop() ?? "", rect: c.getBoundingClientRect() }))
        .filter((c) => c.rect.width > 0 && c.rect.height > 0);
      const columns = getComputedStyle(row).gridTemplateColumns.split(" ").map(parseFloat);
      const list = row.closest("ol")!;
      const head = document.querySelector("[data-course-head]")!;
      const li = row.closest("li")!;
      const liCss = getComputedStyle(li);
      return {
        box: card.parentElement!.getBoundingClientRect().width,
        inner: right - left,
        // the section's own card, and the row's: the phone has the rows as cards and no card of the section's
        sectionCard: { background: css.backgroundColor, border: css.borderTopWidth, padding: css.paddingLeft },
        rowCard: { background: liCss.backgroundColor, radius: liCss.borderTopLeftRadius },
        cellsLeft: Math.min(...cells.map((c) => c.rect.left)) - left,
        cellsRight: right - Math.max(...cells.map((c) => c.rect.right)),
        listScroll: list.scrollWidth,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        columns,
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
    const where = `/admin/koolitused at ${width} px (box ${Math.round(f.box)} px, card content ${Math.round(f.inner)} px)`;
    expect(Math.abs(f.box - box), `${where}: the box the shell gives (expected ${box}; if this moved, the container thresholds in CourseList.module.css need working out again)`).toBeLessThanOrEqual(1);
    expect(f.cellsLeft, `${where}: the cells start inside the card's content`).toBeGreaterThanOrEqual(-1);
    expect(f.cellsRight, `${where}: the last cell against the card's right edge`).toBeGreaterThanOrEqual(-1);
    expect(f.listScroll, `${where}: the list's scroll width`).toBeLessThanOrEqual(f.inner + 17);
    expect(f.pageScroll, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
    expect(f.columns.length, `${where}: the row's grid has ${tracks} tracks`).toBe(tracks);
    expect(f.headed, `${where}: the heading row`).toBe(headed);
    // the card: the section's own one everywhere but the phone, where each row is a white 18 px card of its own on the grey canvas
    if (kind === "phone") {
      expect(f.sectionCard, `${where}: no card of the section's own`).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", padding: "0px" });
      expect(f.rowCard, `${where}: the row is a white card`).toEqual({ background: "rgb(255, 255, 255)", radius: "18px" });
      expect(Math.round(f.inner), `${where}: the cards use the box's whole width`).toBe(Math.round(f.box));
    } else {
      expect(f.sectionCard.background, `${where}: the section's own card`).toBe("rgb(255, 255, 255)");
      expect(f.sectionCard.padding, `${where}: the section's own card`).not.toBe("0px");
      expect(f.rowCard.background, `${where}: the row has no card of its own`).toBe("rgba(0, 0, 0, 0)");
    }
    if (kind === "eight") {
      // the eight columns side by side: the cells in the order of the columns, each to the right of the one before, the fixed columns at their widths, the title not under 150 px
      expect(f.lefts.length, `${where}: eight cells`).toBe(8);
      expect(f.lefts, `${where}: left to right`).toEqual([...f.lefts].sort((a, b) => a - b));
      expect(new Set(f.lefts.map(Math.round)).size, `${where}: no two in one column`).toBe(8);
      expect(f.columns.map((w, i) => (i === 3 ? 0 : Math.round(w))), `${where}: the fixed columns`).toEqual(fixed);
      expect(f.columns[3], `${where}: the title column`).toBeGreaterThanOrEqual(150);
      if (fixed === WIDE) expect(f.columns[3], `${where}: the frame's title column (179 px at 1440 with the frame's sidebar and padding)`).toBeGreaterThanOrEqual(170);
    } else if (kind === "lines") {
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
