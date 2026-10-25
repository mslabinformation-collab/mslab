import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { eq } from "drizzle-orm";
import { courses, courseSessions, registrations, requests } from "@/db/schema";
import listTable from "@/components/admin/list-table.module.css";
import { makeTestDb } from "./helpers";

// Admin UX pass, piece 3b, Task 1 (B3 Kalender, the list): the page rendered from a real (PGlite) database to HTML. The toolbar (no search field; the
// course select and the city select; the pills „Tulevased / Möödunud“ with their counts under the two selects), the rows (the whole row is the link
// that opens the drawer, through the shared list table and ListRows), the count line, the empty states, and the list's address carried to the row
// links, the „Lisa toimumine +“ button and the drawer's close link. The drawer's dialog and its form's server actions are stand-ins.

const state = vi.hoisted(() => ({ db: null as unknown }));
const nav = vi.hoisted(() => ({ search: "" }));
type ToolbarProps = {
  placeholder?: string;
  scope?: unknown;
  scopes?: { label: string; value: string; short?: string; params?: string[]; options: { value: string; label: string; href: string }[] }[];
};
/** The props the page gave the toolbar (its select options carry the addresses the markup does not). */
const seen = vi.hoisted(() => ({ toolbar: null as null | ToolbarProps }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/kalender",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/components/admin/ListToolbar", async (original) => {
  const real = await original<typeof import("@/components/admin/ListToolbar")>();
  return {
    ...real,
    ListToolbar: (props: Parameters<typeof real.ListToolbar>[0]) => {
      seen.toolbar = props as unknown as ToolbarProps;
      return real.ListToolbar(props);
    },
  };
});
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return {
    Drawer: ({ children, closeHref, label }: { children: React.ReactNode; closeHref: string; label: string }) =>
      createElement("div", { "data-drawer-stand-in": "", "data-close-href": closeHref, "data-label": label }, children),
  };
});
vi.mock("@/server/actions/admin-content", () => ({ saveSession: vi.fn(), deleteSession: vi.fn() }));

import CalendarAdminPage from "@/app/admin/(panel)/kalender/page";

const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** The page for an address like „?koolitus=3&linn=Pärnu“, as a document. */
async function open(query = "") {
  nav.search = query;
  const search = Object.fromEntries(new URLSearchParams(query));
  const html = renderToStaticMarkup(await CalendarAdminPage({ searchParams: Promise.resolve(search) }));
  const document = new Window().document;
  document.body.innerHTML = html;
  return document;
}
type Doc = Awaited<ReturnType<typeof open>>;
const texts = (doc: Doc, selector: string) => [...doc.querySelectorAll(selector)].map((e) => e.textContent!.replace(/\s+/g, " ").trim());
const rowOf = (doc: Doc, id: number) => doc.querySelector(`tr[data-session-row="${id}"]`)!;
const rowIds = (doc: Doc) => [...doc.querySelectorAll("tr[data-session-row]")].map((r) => Number(r.getAttribute("data-session-row")));
/** The pills of the row labelled `label`: their words and counts, where they lead, and which one is current. */
const pills = (doc: Doc, label: string) => {
  const row = [...doc.querySelectorAll("nav[data-list-pill-row]")].find((n) => n.getAttribute("aria-label") === label)!;
  expect(row, label).toBeTruthy();
  return [...row.querySelectorAll("a")].map((a) => ({ text: a.textContent!, href: a.getAttribute("href")!, current: a.getAttribute("aria-current") === "true" }));
};
const selectOf = (doc: Doc, label: string) => [...doc.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === label)!;
const optionsOf = (doc: Doc, label: string) => [...selectOf(doc, label).querySelectorAll("option")].map((o) => [o.getAttribute("value"), o.textContent]);
const chosenOf = (doc: Doc, label: string) => selectOf(doc, label).querySelector("option[selected]")?.getAttribute("value");

let db: Db;
const course: Record<string, number> = {};
const s: Record<string, number> = {};

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const [lami] = await db.insert(courses).values({ ...base, slug: "lami", type: "contact", title: { et: "Kulmude LAMI" }, published: true, sort: 1 }).returning();
  const [lash] = await db.insert(courses).values({ ...base, slug: "lash", type: "contact", title: { et: "Lash Lift" }, published: true, sort: 2 }).returning();
  const [draft] = await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustandkoolitus" }, published: false, sort: 3 }).returning();
  const [ecourse] = await db.insert(courses).values({ ...base, slug: "ekursus", type: "e_learning", title: { et: "Kulmumeistri e-koolitus" }, price: 19000, sort: 4 }).returning();
  Object.assign(course, { lami: lami.id, lash: lash.id, draft: draft.id, ecourse: ecourse.id });
  const at = (iso: string) => new Date(iso);
  const rows = await db
    .insert(courseSessions)
    .values([
      { courseId: draft.id, startsAt: at("2030-11-20T08:00:00Z"), city: "Pärnu", venue: "Kalamaja 3", capacity: 4 }, // upcoming, a draft course's
      { courseId: lami.id, startsAt: at("2030-12-05T08:00:00Z"), city: "Pärnu", venue: "Rüütli 12", capacity: 4 }, // upcoming, 2 confirmed + 1 held + 1 waiting
      { courseId: lash.id, startsAt: at("2030-12-12T08:00:00Z"), city: "Tallinn", venue: "Stuudio Kalamaja", capacity: 4, status: "cancelled" },
      { courseId: lami.id, startsAt: at("2030-12-19T08:00:00Z"), city: "Tartu", venue: "", capacity: 6 },
      { courseId: lami.id, startsAt: at("2020-09-01T08:00:00Z"), city: "Tallinn", venue: "Vana saal", capacity: 4 }, // past
      { courseId: lash.id, startsAt: at("2021-05-05T08:00:00Z"), city: "Pärnu", venue: "", capacity: 4 }, // past
    ])
    .returning();
  ["draft", "booked", "cancelled", "tartu", "oldTallinn", "oldParnu"].forEach((k, i) => (s[k] = rows[i].id));
  const reg = (status: "confirmed" | "awaiting_prepayment" | "cancelled", n: number, extra: Partial<typeof registrations.$inferInsert> = {}) => ({
    courseId: lami.id,
    courseSessionId: s.booked,
    kind: "group" as const,
    name: `Õpilane ${n}`,
    email: `opilane${n}@example.test`,
    paymentChoice: "half" as const,
    status,
    ...extra,
  });
  await db.insert(registrations).values([
    reg("confirmed", 1),
    reg("confirmed", 2),
    reg("awaiting_prepayment", 3, { seatHoldUntil: new Date("2099-01-01T00:00:00Z") }), // a live hold: takes a seat
    reg("awaiting_prepayment", 4, { seatHoldUntil: new Date("2000-01-01T00:00:00Z") }), // an ended hold: waiting, takes none
    reg("cancelled", 5),
  ]);
  await db.insert(requests).values([
    { kind: "waitlist", payload: { session: s.booked, email: "w1@example.test" } },
    { kind: "waitlist", payload: { session: s.booked, email: "w2@example.test" } },
  ]);
});

describe("the toolbar", () => {
  test("no search field; two selects, the course first and the city second, then the pills", async () => {
    const doc = await open();
    expect(doc.querySelector('form[role="search"]')).toBeNull();
    expect(doc.querySelector("input")).toBeNull();
    expect(seen.toolbar!.placeholder).toBeUndefined();
    expect([...doc.querySelectorAll("[data-list-toolbar] select")].map((e) => e.getAttribute("aria-label"))).toEqual(["Koolitus", "Linn"]);
    const order = [...doc.querySelectorAll("[data-list-toolbar] select, [data-list-toolbar] nav")].map((e) => e.tagName.toLowerCase());
    expect(order).toEqual(["select", "select", "nav"]);
  });

  test("the course select: „Kõik koolitused“ and each contact course, drafts too, in the public order; the city select: „Kõik linnad“ and each city once", async () => {
    const doc = await open();
    expect(optionsOf(doc, "Koolitus")).toEqual([
      ["", "Kõik koolitused"],
      [String(course.lami), "Kulmude LAMI"],
      [String(course.lash), "Lash Lift"],
      [String(course.draft), "Mustandkoolitus"],
    ]);
    expect(optionsOf(doc, "Linn")).toEqual([
      ["", "Kõik linnad"],
      ["Pärnu", "Pärnu"],
      ["Tallinn", "Tallinn"],
      ["Tartu", "Tartu"],
    ]);
    expect(chosenOf(doc, "Koolitus")).toBe("");
    expect(chosenOf(doc, "Linn")).toBe("");
  });

  test("the phone's pill word of the city select is „Linn“; the course select is no pill", async () => {
    await open();
    const [course_, city] = seen.toolbar!.scopes!;
    expect(city.short).toBe("Linn");
    expect(course_.short).toBeUndefined();
    expect([course_.params, city.params]).toEqual([["koolitus"], ["linn"]]);
  });

  test("the selects show the address's choice; a course or a city that does not exist is no filter", async () => {
    const doc = await open(`koolitus=${course.lash}&linn=Tallinn`);
    expect(chosenOf(doc, "Koolitus")).toBe(String(course.lash));
    expect(chosenOf(doc, "Linn")).toBe("Tallinn");
    const gone = await open(`koolitus=999999&linn=Narva`);
    expect(chosenOf(gone, "Koolitus")).toBe("");
    expect(chosenOf(gone, "Linn")).toBe("");
    expect(rowIds(gone)).toHaveLength(4);
    // an e-course is no contact course: not an option, so not a filter either
    expect(rowIds(await open(`koolitus=${course.ecourse}`))).toHaveLength(4);
    // (own keys only: nothing from the object prototype)
    expect(rowIds(await open(`linn=constructor&koolitus=__proto__`))).toHaveLength(4);
  });

  test("each option leads to its own address: the other select's choice and the time pill kept, the drawer dropped", async () => {
    await open(`aeg=moodunud&linn=Tallinn&id=${s.oldTallinn}`);
    const [courses_, cities] = seen.toolbar!.scopes!;
    const at = (scope: typeof courses_, value: string) => scope.options.find((o) => o.value === value)!.href;
    expect(at(courses_, "")).toBe("/admin/kalender?aeg=moodunud&linn=Tallinn");
    expect(at(courses_, String(course.lash))).toBe(`/admin/kalender?aeg=moodunud&koolitus=${course.lash}&linn=Tallinn`);
    expect(at(cities, "")).toBe("/admin/kalender?aeg=moodunud");
    expect(at(cities, "Pärnu")).toBe("/admin/kalender?aeg=moodunud&linn=P%C3%A4rnu");
    await open(`koolitus=${course.lami}`);
    expect(seen.toolbar!.scopes![1].options.find((o) => o.value === "Tartu")!.href).toBe(`/admin/kalender?koolitus=${course.lami}&linn=Tartu`);
  });

  test("the pills „Tulevased“ and „Möödunud“ carry their counts, and the counts follow the two selects", async () => {
    expect(pills(await open(), "Aeg")).toEqual([
      { text: "Tulevased4", href: "/admin/kalender", current: true },
      { text: "Möödunud2", href: "/admin/kalender?aeg=moodunud", current: false },
    ]);
    expect(pills(await open(`koolitus=${course.lami}`), "Aeg").map((p) => p.text)).toEqual(["Tulevased2", "Möödunud1"]);
    expect(pills(await open(`linn=Pärnu`), "Aeg").map((p) => p.text)).toEqual(["Tulevased2", "Möödunud1"]);
    expect(pills(await open(`koolitus=${course.lash}&linn=Pärnu`), "Aeg").map((p) => p.text)).toEqual(["Tulevased0", "Möödunud1"]);
    expect(pills(await open(`koolitus=${course.draft}&linn=Tartu`), "Aeg").map((p) => p.text)).toEqual(["Tulevased0", "Möödunud0"]);
  });

  test("each pill keeps the course and the city; the current one follows ?aeg=", async () => {
    const doc = await open(`koolitus=${course.lami}&linn=Tallinn&aeg=moodunud&id=${s.oldTallinn}`);
    expect(pills(doc, "Aeg")).toEqual([
      { text: "Tulevased0", href: `/admin/kalender?koolitus=${course.lami}&linn=Tallinn`, current: false },
      { text: "Möödunud1", href: `/admin/kalender?aeg=moodunud&koolitus=${course.lami}&linn=Tallinn`, current: true },
    ]);
  });

  test("each pill's count is the number of rows the list then shows", async () => {
    for (const query of ["", `koolitus=${course.lami}`, "linn=Pärnu", `koolitus=${course.lash}&linn=Tallinn`, "linn=Tartu"]) {
      const doc = await open(query);
      for (const pill of pills(doc, "Aeg")) {
        const target = await open(pill.href.split("?")[1] ?? "");
        expect(pill.text.replace(/^\D+/, ""), `${query} → ${pill.href}`).toBe(String(rowIds(target).length));
      }
    }
  });

  test("the count line is the rows shown", async () => {
    expect(texts(await open(), "[data-calendar-count]")).toEqual(["Toimumisi: 4"]);
    expect(texts(await open("aeg=moodunud"), "[data-calendar-count]")).toEqual(["Toimumisi: 2"]);
    expect(texts(await open("linn=Tartu"), "[data-calendar-count]")).toEqual(["Toimumisi: 1"]);
    expect(texts(await open("linn=Tartu&aeg=moodunud"), "[data-calendar-count]")).toEqual(["Toimumisi: 0"]);
  });
});

describe("the list", () => {
  test("upcoming soonest first, past latest first; the course and the city limit both", async () => {
    expect(rowIds(await open())).toEqual([s.draft, s.booked, s.cancelled, s.tartu]);
    expect(rowIds(await open("aeg=moodunud"))).toEqual([s.oldParnu, s.oldTallinn]);
    expect(rowIds(await open(`koolitus=${course.lami}`))).toEqual([s.booked, s.tartu]);
    expect(rowIds(await open("linn=Pärnu"))).toEqual([s.draft, s.booked]);
    expect(rowIds(await open(`koolitus=${course.lami}&linn=Pärnu`))).toEqual([s.booked]);
    expect(rowIds(await open(`koolitus=${course.lash}&linn=Pärnu&aeg=moodunud`))).toEqual([s.oldParnu]);
  });

  test("columns: Kuupäev | Koolitus | Kohad | Staatus; no Koht or Keel column (the place is under the course, as drawn)", async () => {
    const doc = await open();
    expect(texts(doc, "thead th")).toEqual(["Kuupäev", "Koolitus", "Kohad", "Staatus"]);
    expect(rowOf(doc, s.booked).querySelectorAll("td")).toHaveLength(4);
  });

  test("the shared list table: the card, the table and the row's name link are the list table's, so ListRows can forward a click on the row", async () => {
    const doc = await open();
    expect(doc.querySelector("section")!.classList.contains(listTable.card)).toBe(true);
    expect(doc.querySelector("table")!.classList.contains(listTable.table)).toBe(true);
    for (const id of [s.draft, s.booked, s.cancelled, s.tartu]) expect(rowOf(doc, id).querySelectorAll(`a.${listTable.name}`)).toHaveLength(1);
    // the table sits in ListRows' wrapper
    expect(doc.querySelector("table")!.parentElement!.classList.contains(listTable.rows)).toBe(true);
  });

  test("a row: the date with the weekday and the time, the course as the link that opens the drawer with the place under it, the seats, the state", async () => {
    const row = rowOf(await open(), s.booked);
    const cells = [...row.querySelectorAll("td")];
    expect(cells[0].querySelector("strong")!.textContent).toBe("05.12.2030");
    expect(cells[0].querySelector("strong + span")!.textContent).toBe("neljapäev · 10:00");
    const link = cells[1].querySelector("a")!;
    expect(link.textContent).toBe("Kulmude LAMI");
    expect(link.id).toBe(`session-${s.booked}`);
    expect(link.getAttribute("href")).toBe(`/admin/kalender?id=${s.booked}`);
    expect(link.getAttribute("aria-label")).toBe("Muuda toimumist: Kulmude LAMI, 05.12.2030, Pärnu");
    expect(cells[1].querySelector("[data-session-place]")!.textContent).toBe("Pärnu · Rüütli 12");
    expect(cells[3].textContent).toBe("Toimub"); // 2 confirmed and 1 live hold of 4: a seat is left
  });

  test("the seats: „{confirmed} / {capacity} kinnitatud“ with a bar, then free seats, the ones awaiting their prepayment and the waitlist", async () => {
    const doc = await open();
    const seats = (id: number) => rowOf(doc, id).querySelectorAll("td")[2];
    expect(seats(s.booked).querySelector("[data-session-seats]")!.textContent).toBe("2 / 4 kinnitatud");
    expect(seats(s.booked).querySelector("[data-seats-short]")!.textContent).toBe("2/4"); // the phone card's figure
    expect(texts(doc, `tr[data-session-row="${s.booked}"] [data-seats-more]`)).toEqual(["Vabu kohti 1 · 2 ootab ettemaksu · Ootenimekirjas 2"]);
    expect(seats(s.tartu).querySelector("[data-session-seats]")!.textContent).toBe("0 / 6 kinnitatud");
    expect(texts(doc, `tr[data-session-row="${s.tartu}"] [data-seats-more]`)).toEqual(["Vabu kohti 6"]);
    // a cancelled session offers no free seats, and with nothing awaiting or waiting there is no line at all
    expect(texts(doc, `tr[data-session-row="${s.cancelled}"] [data-seats-more]`)).toEqual([]);
  });

  test("the bar fills with the confirmed seats; it is the warning colour when the session is full", async () => {
    const [full] = await db.insert(courseSessions).values({ courseId: course.lami, startsAt: new Date("2031-01-10T08:00:00Z"), city: "Narva", capacity: 2 }).returning();
    try {
      await db.insert(registrations).values([1, 2].map((n) => ({ courseId: course.lami, courseSessionId: full.id, kind: "group" as const, name: `N${n}`, email: `narva${n}@example.test`, paymentChoice: "half" as const, status: "confirmed" as const })));
      const doc = await open();
      const fill = (id: number) => rowOf(doc, id).querySelector("[data-seats-bar] > span")!;
      expect(fill(s.booked).getAttribute("style")).toContain("width:50%");
      expect(fill(s.tartu).getAttribute("style")).toContain("width:0%");
      expect(fill(full.id).getAttribute("style")).toContain("width:100%");
      expect(rowOf(doc, full.id).querySelector("[data-seats-bar]")!.getAttribute("data-full")).toBe("");
      expect(rowOf(doc, s.booked).querySelector("[data-seats-bar]")!.getAttribute("data-full")).toBeNull();
      expect(rowOf(doc, full.id).querySelector("[data-session-state]")!.textContent).toBe("Täis");
    } finally {
      await db.delete(registrations).where(eq(registrations.courseSessionId, full.id));
      await db.delete(courseSessions).where(eq(courseSessions.id, full.id));
    }
  });

  test("the state: Toimub, Täis (no seat left, a live hold counts), Tühistatud", async () => {
    const doc = await open();
    const state_ = (id: number) => rowOf(doc, id).querySelector("[data-session-state]")!.textContent;
    expect(state_(s.booked)).toBe("Toimub"); // 2 confirmed + 1 live hold = 3 of 4
    expect(state_(s.tartu)).toBe("Toimub");
    expect(state_(s.cancelled)).toBe("Tühistatud");
  });

  test("a cancelled session: the place line, and for the phone card „{linn} · tühistatud“ in its place", async () => {
    const row = rowOf(await open(), s.cancelled);
    expect(row.querySelector("[data-session-place]")!.textContent).toBe("Tallinn · Stuudio Kalamaja");
    expect(row.querySelector("[data-session-place-cancelled]")!.textContent).toBe("Tallinn · tühistatud");
    expect(rowOf(await open(), s.booked).querySelector("[data-session-place-cancelled]")).toBeNull();
  });

  test("a session with no venue shows the city alone; a draft course's session carries the „Mustand“ tag", async () => {
    const doc = await open();
    expect(rowOf(doc, s.tartu).querySelector("[data-session-place]")!.textContent).toBe("Tartu");
    expect(texts(doc, `tr[data-session-row="${s.draft}"] td:nth-child(2) [title]`)).toEqual(["Mustand"]);
    expect(rowOf(doc, s.booked).querySelector("td:nth-child(2) [title]")).toBeNull();
  });

  test("the phone card's date: the day over the short month (Intl's own „dets“, „veebr“), and the full date stays for the screen reader", async () => {
    const doc = await open();
    const day = rowOf(doc, s.booked).querySelector("[data-session-day]")!;
    expect(day.getAttribute("aria-hidden")).toBe("true");
    expect([...day.children].map((c) => c.textContent)).toEqual(["05", "dets"]);
    expect([...rowOf(await open("aeg=moodunud"), s.oldTallinn).querySelector("[data-session-day]")!.children].map((c) => c.textContent)).toEqual(["01", "sept"]);
  });
});

describe("empty states", () => {
  test("no upcoming session at all: the two old sentences", async () => {
    const was = state.db;
    state.db = await makeTestDb();
    try {
      const upcoming = await open();
      expect(texts(upcoming, "[data-calendar-empty]")).toEqual(["Tulevasi toimumisi pole."]);
      expect(upcoming.querySelector("[data-list-empty]")).toBeNull();
      expect(texts(await open("aeg=moodunud"), "[data-calendar-empty]")).toEqual(["Möödunud toimumisi pole."]);
      expect(texts(upcoming, "[data-calendar-count]")).toEqual(["Toimumisi: 0"]);
    } finally {
      state.db = was;
    }
  });

  test("a course or a city chosen and nothing found: „Selle valikuga toimumisi pole.“ and „Tühjenda otsing ja filtrid“", async () => {
    const doc = await open(`koolitus=${course.lash}&linn=Tartu`);
    expect(doc.querySelector("table")).toBeNull();
    expect(texts(doc, "[data-list-empty] p")).toEqual(["Selle valikuga toimumisi pole."]);
    const clear = doc.querySelector("[data-list-empty] a")!;
    expect(clear.textContent).toBe("Tühjenda otsing ja filtrid");
    expect(clear.getAttribute("href")).toBe("/admin/kalender");
    expect(doc.querySelector("[data-calendar-empty]")).toBeNull();
  });

  test("the clearing link stays in the same time view (Tulevased or Möödunud are not filters)", async () => {
    const doc = await open(`linn=Tartu&aeg=moodunud`);
    expect(doc.querySelector("[data-list-empty] a")!.getAttribute("href")).toBe("/admin/kalender?aeg=moodunud");
  });
});

describe("the list's address is carried to the add button and the drawer", () => {
  test("the row links open the drawer on the same list; „Lisa toimumine +“ and the drawer's close link return to it", async () => {
    const upcoming = await open(`koolitus=${course.lami}&linn=Pärnu`);
    expect(rowOf(upcoming, s.booked).querySelector("a")!.getAttribute("href")).toBe(`/admin/kalender?koolitus=${course.lami}&linn=P%C3%A4rnu&id=${s.booked}`);
    expect(upcoming.querySelector("a[data-add-session]")!.getAttribute("href")).toBe(`/admin/kalender?koolitus=${course.lami}&linn=P%C3%A4rnu&id=uus`);
    const withDrawer = await open(`koolitus=${course.lami}&linn=Pärnu&id=${s.booked}`);
    expect(withDrawer.querySelector("[data-drawer-stand-in]")!.getAttribute("data-close-href")).toBe(`/admin/kalender?koolitus=${course.lami}&linn=P%C3%A4rnu`);
    expect(withDrawer.querySelector("[data-drawer-stand-in]")!.getAttribute("data-label")).toBe("Toimumine: Kulmude LAMI, 05.12.2030");
    const timeView = await open(`aeg=moodunud&id=${s.oldTallinn}`);
    expect(timeView.querySelector("[data-drawer-stand-in]")!.getAttribute("data-close-href")).toBe("/admin/kalender?aeg=moodunud");
  });

  test("a session opened from a list it is not in still opens (the drawer reads it by its id)", async () => {
    const doc = await open(`linn=Tartu&id=${s.oldTallinn}`);
    expect(doc.querySelector("[data-drawer-stand-in]")!.getAttribute("data-label")).toBe("Toimumine: Kulmude LAMI, 01.09.2020");
    expect(rowIds(doc)).toEqual([s.tartu]);
  });

  test("the open row is marked; the others are not", async () => {
    const doc = await open(`id=${s.booked}`);
    expect(rowOf(doc, s.booked).className).not.toBe("");
    expect(rowOf(doc, s.tartu).className).toBe("");
  });

  test("a session just added (?lisatud=) is highlighted, and the flash words stay", async () => {
    const doc = await open(`lisatud=${s.tartu}`);
    expect(rowOf(doc, s.tartu).hasAttribute("data-highlight")).toBe(true);
    expect(texts(doc, '[data-flash="added"]')).toEqual(["Toimumine lisatud."]);
    expect(texts(await open("kustutatud=1"), '[data-flash="deleted"]')).toEqual(["Toimumine kustutatud."]);
  });
});
