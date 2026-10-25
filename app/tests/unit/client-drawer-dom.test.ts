// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CourseSteps } from "@/domain/completion";
import type { ClientAccessRow, ClientDetail, ClientRegistrationRow, EcourseOption } from "@/server/admin-clients";

// A student's drawer (admin UX pass, README A5, the Part 2 prototype), drawn from a ready-made ClientDetail in a browser-like document (happy-dom):
// the header with its one line, "Koolitused" as one list of cards — e-course accesses and registrations, newest first — with the state in the pill
// ("Avatud kuni", "Läbitud", "Ligipääs lõppes", "Ligipääs lõpetatud") and in the phone's kicker, the actions each card has, and the folded rows with their
// summaries. (The same drawer from a real database: tests/db/client-drawer-steps.test.ts and client-drawer-contracts.test.ts.)

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/server/actions/admin-clients", () => ({
  addStudent: vi.fn(),
  grantCourseAccess: vi.fn(),
  revokeCourseAccess: vi.fn(),
  unlockNextLesson: vi.fn(),
  extendAccessAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: vi.fn() }));

import { ClientDetailView } from "@/components/admin/ClientDrawer";

const NOW = new Date("2026-10-20T09:00:00Z");

const steps = (over: Partial<CourseSteps> = {}): CourseSteps => ({
  lessons: { done: 3, total: 3, state: "done" },
  test: { state: "done", triesLeft: null },
  practical: { state: "review", round: 1 },
  completedAt: null,
  ...over,
});

let nextId = 100;
/** An e-course access of Kati's: open until 17.03.2027, opened 20.10.2026, her work waiting (`over` changes it). */
const access = (over: Partial<ClientAccessRow> = {}): ClientAccessRow => {
  const id = nextId++;
  return {
    id,
    courseId: id,
    title: { et: `Kursus ${id}` },
    slug: `kursus-${id}`,
    grantedBy: "maria@example.test",
    grantedAt: new Date("2026-10-20T08:00:00Z"),
    expiresAt: new Date("2027-03-17T21:59:59.999Z"),
    revokedAt: null,
    completedAt: null,
    state: "active",
    progress: { done: 3, total: 3 },
    nextLocked: null,
    steps: steps(),
    protocolId: null,
    testPercent: 100,
    hasAttempts: true,
    waitingAttemptId: null,
    certificate: null,
    ...over,
  };
};
/** The fields of an access completed on `day` (the row's and the steps' say it together, as loadSteps reads the row). */
const completed = (day: string): Partial<ClientAccessRow> => ({ completedAt: new Date(day), steps: steps({ completedAt: day }) });
/** A registration of hers; `over` changes it. */
const registration = (over: Record<string, unknown> = {}): ClientRegistrationRow =>
  ({
    id: nextId++,
    status: "confirmed",
    paymentChoice: "full",
    paidCents: 35000,
    preferredPeriod: "",
    createdAt: new Date("2026-10-19T08:00:00Z"),
    kind: "group",
    course: { slug: "kulm", title: { et: "Kulmumeistri baaskoolitus" }, type: "contact" },
    courseSession: { startsAt: new Date("2026-12-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", status: "scheduled" },
    protocolId: null,
    contact: true,
    ...over,
  }) as unknown as ClientRegistrationRow;

const detail = (over: Partial<ClientDetail> = {}): ClientDetail => ({
  client: { id: 3, email: "kati@example.test", name: "Kati Kask", ownName: "Kati Kask", phone: "+372 5000 0161", locale: "et", createdAt: new Date("2026-10-20T07:00:00Z") },
  registrations: [],
  requests: [],
  access: [],
  contracts: [],
  newsletter: "no",
  payments: [],
  feedback: [],
  ...over,
});

const ecourses: EcourseOption[] = [
  { id: 100, title: { et: "Kursus 100" }, published: true, accessMonths: 6, until: "2027-04-20" },
  { id: 777, title: { et: "Ripsmete e-koolitus" }, published: false, accessMonths: null, until: "2027-10-20" },
];

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => scope.querySelector<E>(selector);
const $$ = (selector: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const draw = async (d: ClientDetail, options: EcourseOption[] = ecourses) => {
  await act(async () => root.render(createElement(ClientDetailView, { detail: d, ecourses: options, now: NOW })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** A text that is shorter on a phone (Swap): the page holds the wide one; the phone's is `data-short`, drawn in its place by the stylesheet. */
const wide = (el: Element | null) => text($("[data-wide]", el!));
const phone = (el: Element | null) => $("[data-swap]", el!)!.getAttribute("data-short");
const cardOf = (courseId: number) => $(`[data-access="${courseId}"]`)!;

beforeEach(() => {
  nextId = 100;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the header", () => {
  test("name, phone, e-mail — and one line: 'Konto loodud … · Keel … · Uudiskiri: …'", async () => {
    await draw(detail({ newsletter: "pending" }));
    expect(text($("h2"))).toBe("Kati Kask");
    expect($$("[data-client-detail] > div:first-child a").map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["+372 5000 0161", "tel:+37250000161"],
      ["kati@example.test", "mailto:kati@example.test"],
      ["Vaata tema vaadet", "/admin/opilased/3/vaade"],
    ]);
    expect(text($("[data-client-detail] > div:first-child p:nth-of-type(2)"))).toBe("Konto loodud 20.10.2026 · Keel ET · Uudiskiri: ootab kinnitust");
    expect($("[data-client-newsletter]")!.getAttribute("data-client-newsletter")).toBe("pending");
  });
});

describe("„Koolitused“: one list, newest first", () => {
  test("accesses and registrations together by the day each was opened or made, the newest first", async () => {
    const oldest = registration({ createdAt: new Date("2026-09-01T08:00:00Z") });
    const middle = access({ grantedAt: new Date("2026-10-05T08:00:00Z") });
    const newest = access({ grantedAt: new Date("2026-10-20T08:00:00Z") });
    const between = registration({ createdAt: new Date("2026-10-12T08:00:00Z") });
    await draw(detail({ access: [newest, middle], registrations: [between, oldest] }));
    expect(text($("[data-client-courses] h3"))).toBe("Koolitused");
    const order = $$("[data-client-courses] li[data-access], [data-client-courses] li[data-client-registration]").map((li) => li.getAttribute("data-access") ?? `r${li.getAttribute("data-client-registration")}`);
    expect(order).toEqual([String(newest.courseId), `r${between.id}`, String(middle.courseId), `r${oldest.id}`]);
  });

  test("nothing yet: the list says so as the other lists do", async () => {
    await draw(detail());
    expect(text($("[data-client-courses] > p"))).toBe("Koolitusi veel pole.");
    expect($("[data-client-courses] ul")).toBeNull();
  });
});

describe("an e-course card", () => {
  test("the kicker, the title, the pill and the steps; the phone's kicker holds the state and its steps are the short line", async () => {
    const a = access({ title: { et: "Kulmumeistri e-koolitus" } });
    await draw(detail({ access: [a] }));
    const card = cardOf(a.courseId);
    expect(wide($("[data-access-kicker]", card))).toBe("E-õpe");
    expect(phone($("[data-access-kicker]", card))).toBe("E-õpe · Avatud kuni 17.03.2027");
    expect(text($("strong", card))).toBe("Kulmumeistri e-koolitus");
    expect(text($("[data-access-pill]", card))).toBe("Avatud kuni 17.03.2027");
    expect(wide($("[data-access-steps]", card))).toBe("Õppetunnid 3/3 · Test läbitud (100 %) · Praktiline töö ootab hindamist");
    expect(phone($("[data-access-steps]", card))).toBe("3/3 · test läbitud · praktiline ootab");
    expect(text($(".meta, p:not([data-access-steps])", card))).toContain("Avas maria@example.test, 20.10.2026 11:00");
  });

  test("a completed course says 'Läbitud' with its day — also when its access has run out since —, an access that ran out 'Ligipääs lõppes', one an admin ended 'Ligipääs lõpetatud'", async () => {
    const open = access(completed("2026-11-14T10:00:00.000Z"));
    const completedThenRanOut = access({ state: "expired", expiresAt: new Date("2026-09-30T20:59:59.999Z"), ...completed("2026-09-20T10:00:00.000Z") });
    const ranOut = access({ state: "expired", expiresAt: new Date("2026-08-31T20:59:59.999Z") });
    const ended = access({ state: "revoked", revokedAt: new Date("2026-10-18T10:00:00Z") });
    await draw(detail({ access: [open, completedThenRanOut, ranOut, ended] }));
    const pill = (a: ClientAccessRow) => text($("[data-access-pill]", cardOf(a.courseId)));
    expect(pill(open)).toBe("Läbitud 14.11.2026");
    expect(pill(completedThenRanOut)).toBe("Läbitud 20.09.2026");
    expect(pill(ranOut)).toBe("Ligipääs lõppes 31.08.2026");
    expect(pill(ended)).toBe("Ligipääs lõpetatud 18.10.2026");
    // (a completed course has no step line: its pill is the line)
    expect($("[data-access-steps]", cardOf(open.courseId))).toBeNull();
    expect($("[data-access-steps]", cardOf(ranOut.courseId))).not.toBeNull();
    expect(phone($("[data-access-kicker]", cardOf(ranOut.courseId)))).toBe("E-õpe · Ligipääs lõppes 31.08.2026");
  });

  test("'Pikenda ▾' on an open card and on one that ran out (its menu title says 'lõppes'), none on an access an admin ended", async () => {
    const open = access();
    const ranOut = access({ state: "expired", expiresAt: new Date("2026-08-31T20:59:59.999Z") });
    const ended = access({ state: "revoked", revokedAt: new Date("2026-10-18T10:00:00Z") });
    await draw(detail({ access: [open, ranOut, ended] }));
    const trigger = (a: ClientAccessRow) => $<HTMLButtonElement>("[data-extend] button[aria-haspopup=menu]", cardOf(a.courseId));
    expect(text(trigger(open))).toBe("Pikenda ▾");
    expect(trigger(open)!.getAttribute("aria-label")).toBe(`Pikenda: ${open.title.et}`);
    expect(text(trigger(ranOut))).toBe("Pikenda ▾");
    expect(trigger(ended)).toBeNull();
    expect(cardOf(ended.courseId).textContent).not.toContain("Pikenda");
    await click(trigger(open));
    expect(text($("[role=menu]")!.firstElementChild)).toBe("Pikenda ligipääsu (praegu kuni 17.03.2027)");
    await click(trigger(open)); // closed again
    await click(trigger(ranOut));
    expect(text($("[role=menu]")!.firstElementChild)).toBe("Pikenda ligipääsu (lõppes 31.08.2026)");
  });

  test("'Hinda' beside it when work waits (the practical work: her protocol; the test's open answers: that attempt), 'Veel ▾' with the rarer ones in README's order", async () => {
    const practical = access({ steps: steps({ practical: { state: "review", round: 1 } }), hasAttempts: true, protocolId: 9, nextLocked: { id: 7, title: { et: "Kolmas tund" } } });
    const test = access({ steps: steps({ test: { state: "review", triesLeft: null }, practical: { state: "locked", round: 0 } }), waitingAttemptId: 55 });
    const idle = access({ steps: steps({ practical: { state: "locked", round: 0 } }) });
    await draw(detail({ access: [practical, test, idle] }));
    const assess = (a: ClientAccessRow) => $<HTMLAnchorElement>("[data-access-assess]", cardOf(a.courseId));
    expect(assess(practical)!.getAttribute("href")).toBe(`/admin/protokollid?ligipaas=${practical.id}`);
    expect(assess(test)!.getAttribute("href")).toBe("/admin/hindamine/test?id=55");
    expect(assess(idle)).toBeNull();
    // under "Veel ▾" of the first: the lesson to open, the protocol she has (it is written: "Ava"), her attempts, her page of the course, the end
    await click($("[data-more='veel'] button", cardOf(practical.courseId)));
    expect($$("[role=menuitem]").map((i) => [text(i), i.getAttribute("href")])).toEqual([
      ["Ava järgmine õppetund", null],
      ["Ava protokoll", `/admin/protokollid?ligipaas=${practical.id}`],
      ["Testi katsed", `/admin/hindamine/test?ligipaas=${practical.id}`],
      ["Vaata tema vaadet", `/admin/opilased/3/vaade/${practical.slug}`],
      ["Lõpeta ligipääs", null],
    ]);
  });

  test("an access an admin ended keeps its history and nothing to open: no actions, no 'Ava test uuesti'", async () => {
    const ended = access({ state: "revoked", revokedAt: new Date("2026-10-18T10:00:00Z"), steps: steps({ test: { state: "used", triesLeft: 0 } }) });
    await draw(detail({ access: [ended] }));
    const card = cardOf(ended.courseId);
    expect($("button", card)).toBeNull();
    expect($("[data-access-assess]", card)).toBeNull();
    expect($("[data-reopen]", card)).toBeNull();
    expect($("[data-access-steps]", card)).not.toBeNull();
  });

  test("her certificate stays on the card: the number and day, the download; an ended access marks it", async () => {
    const certificate = { id: 8, number: "MSL2026-001", name: "Kati Kask", issuedAt: "2026-10-01T10:00:00.000Z", reissuedAt: null, revoked: true };
    const ended = access({ state: "revoked", revokedAt: new Date("2026-10-18T10:00:00Z"), certificate });
    await draw(detail({ access: [ended] }));
    const box = $("[data-access-certificate]", cardOf(ended.courseId))!;
    expect(text(box)).toContain("Tunnistus MSL2026-001 · 01.10.2026");
    expect(box.querySelector("[data-certificate-revoked]")).not.toBeNull();
    expect(box.querySelector("[data-certificate-admin-download]")!.getAttribute("href")).toBe("/api/admin/tunnistus/8");
  });
});

describe("a registration's card", () => {
  test("kicker 'Kontaktõpe · 14.12.2026 Pärnu' (the phone: 'Kontaktõpe · 14.12 Pärnu · Kinnitatud'), the title, the status, 'Ava registreering' (the phone: 'Registreering') and 'Lisa protokoll'", async () => {
    const reg = registration();
    await draw(detail({ registrations: [reg] }));
    const card = $(`[data-client-registration="${reg.id}"]`)!;
    expect(wide($("[data-registration-kicker]", card))).toBe("Kontaktõpe · 14.12.2026 Pärnu");
    expect(phone($("[data-registration-kicker]", card))).toBe("Kontaktõpe · 14.12 Pärnu · Kinnitatud");
    expect(text($("strong", card))).toBe("Kulmumeistri baaskoolitus");
    expect(text($("[data-reg-status]", card))).toBe("Kinnitatud");
    const open = $("[data-registration-open]", card)!;
    expect(open.getAttribute("href")).toBe(`/admin/registreerimised?id=${reg.id}`);
    expect(text(open)).toBe("Ava registreering");
    expect(phone(open)).toBe("Registreering");
    const protocol = $("[data-registration-protocol]", card)!;
    expect(protocol.getAttribute("href")).toBe(`/admin/protokollid?registreering=${reg.id}`);
    expect(text(protocol)).toBe("Lisa protokoll");
  });

  test("'Ava protokoll' (the phone: 'Protokoll') once it is written; none on a cancelled registration or an e-course purchase", async () => {
    const written = registration({ protocolId: 4 });
    const cancelled = registration({ status: "cancelled" });
    const purchase = registration({ contact: false, courseSession: null, kind: "individual", course: { slug: "e", title: { et: "Veebikoolitus" }, type: "e_learning" } });
    await draw(detail({ registrations: [written, cancelled, purchase] }));
    const protocol = $("[data-registration-protocol]", $(`[data-client-registration="${written.id}"]`)!)!;
    expect(text(protocol)).toBe("Ava protokoll"); // (one text: the phone's „Protokoll“ is generated content)
    expect(phone(protocol)).toBe("Protokoll");
    expect($("[data-registration-protocol]", $(`[data-client-registration="${cancelled.id}"]`)!)).toBeNull();
    expect($("[data-registration-protocol]", $(`[data-client-registration="${purchase.id}"]`)!)).toBeNull();
    // an e-learning purchase has no place or day
    expect(wide($("[data-registration-kicker]", $(`[data-client-registration="${purchase.id}"]`)!))).toBe("E-õpe");
  });

  test("an individual contact registration: 'Kontaktõpe · Aeg kokkuleppel' (P-7)", async () => {
    const individual = registration({ kind: "individual", courseSession: null, preferredPeriod: "Jaanuaris" });
    await draw(detail({ registrations: [individual] }));
    const kicker = $("[data-registration-kicker]", $(`[data-client-registration="${individual.id}"]`)!);
    expect(wide(kicker)).toBe("Kontaktõpe · Aeg kokkuleppel");
    expect(phone(kicker)).toBe("Kontaktõpe · Aeg kokkuleppel · Kinnitatud");
  });
});

describe("the folded rows", () => {
  test("Ava ligipääs e-koolitusele, Maksed, Lepingud, Päringud, Tagasiside — in that order, closed, each with its summary", async () => {
    await draw(detail());
    const rows = $$("[data-fold]");
    expect(rows.map((r) => [text($("summary > span > span:first-child", r)), text($("[data-fold-summary]", r))])).toEqual([
      ["Ava ligipääs e-koolitusele", "vali koolitus"],
      ["Maksed", "0"],
      ["Lepingud", "0"],
      ["Päringud", "0"],
      ["Tagasiside", "0"],
    ]);
    expect(rows.every((r) => !r.hasAttribute("open"))).toBe(true);
  });

  test("the counts: the payments with the sum paid, the contracts, the requests, the feedback", async () => {
    const payment = (id: number, status: string, amountCents: number) => ({ id, reference: `MSLAB-L${id}`, status, amountCents, kind: "ecourse", method: "", bank: "", checkReason: null, paidAt: null, createdAt: NOW, courseTitle: { et: "Kulm" }, courseSlug: "kulm", startsAt: null });
    await draw(
      detail({
        payments: [payment(1, "paid", 19000), payment(2, "failed", 17500), payment(3, "paid", 1000)] as unknown as ClientDetail["payments"],
        requests: [{ id: 1, kind: "contact", handled: false, createdAt: NOW, interest: false, wish: null, subject: null }],
      }),
    );
    const summary = (title: string) => text($("[data-fold-summary]", $$("[data-fold]").find((r) => text($("summary", r)).startsWith(title))!));
    expect(summary("Maksed")).toBe("3 · 200 €");
    expect(summary("Päringud")).toBe("1");
    expect(summary("Lepingud")).toBe("0");
  });

  test("'Ava ligipääs e-koolitusele' holds the form: the select says '{course} · mustand · avatud kuni {date}'", async () => {
    await draw(detail({ access: [access({ courseId: 100, title: { et: "Kursus 100" } })] }));
    const options = $$("[data-grant-form] option").map((o) => text(o));
    expect(options).toEqual(["Kursus 100 · avatud kuni 17.03.2027", "Ripsmete e-koolitus · mustand"]);
    // the first she cannot open now is the one picked
    expect($<HTMLSelectElement>("[data-grant-form] select")!.value).toBe("777");
    expect($("[data-grant-form]")!.getAttribute("aria-label")).toBe("Ava ligipääs");
    expect($("[data-grant-form] h4")).toBeNull();
  });

  test("no e-course to give: the row says so in place of the form, with no summary", async () => {
    await draw(detail(), []);
    const row = $$("[data-fold]")[0];
    expect($("[data-fold-summary]", row)).toBeNull();
    expect(text($(".notice, [class*=notice]", row))).toContain("E-koolitusi pole.");
    expect($("[data-grant-form]")).toBeNull();
  });
});
