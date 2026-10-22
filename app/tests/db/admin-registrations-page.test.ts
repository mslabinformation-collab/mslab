import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, courseSessions, registrations } from "@/db/schema";
import { makeTestDb } from "./helpers";

// Admin UX pass, piece 2, Task 4 (A2 Registreerimised, the list): the page rendered from a real (PGlite) database to HTML. The toolbar's search,
// scope select and two rows of pills with their counts; the five columns and what a row says; the empty states; and the list's address carried by
// the row links, the pager and the drawer's close link. The drawer's dialog and the server actions are stand-ins (they need a browser or a
// request); the toolbar reads the address from `nav`, as the browser would give it.

const state = vi.hoisted(() => ({ db: null as unknown }));
const nav = vi.hoisted(() => ({ search: "" }));
/** The props the page gave the toolbar (its scope options carry the addresses the markup does not). */
const seen = vi.hoisted(() => ({ toolbar: null as null | { scope: { value: string; options: { value: string; label: string; href: string }[] } } }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/registreerimised",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/components/admin/ListToolbar", async (original) => {
  const real = await original<typeof import("@/components/admin/ListToolbar")>();
  return {
    ...real,
    ListToolbar: (props: Parameters<typeof real.ListToolbar>[0]) => {
      seen.toolbar = props as unknown as NonNullable<typeof seen.toolbar>;
      return real.ListToolbar(props);
    },
  };
});
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return {
    Drawer: ({ children, closeHref }: { children: React.ReactNode; closeHref: string }) => createElement("div", { "data-drawer-stand-in": "", "data-close-href": closeHref }, children),
    useUnsavedInDrawer: () => {},
  };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({
  createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(),
  updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), saveInvoiceSettingsAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";

const NBSP = String.fromCharCode(160);
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** The page for an address like „?otsi=kask&staatus=ootab“, as a document. */
async function open(query = "") {
  nav.search = query;
  const search = Object.fromEntries(new URLSearchParams(query));
  const html = renderToStaticMarkup(await RegistrationsPage({ searchParams: Promise.resolve(search) }));
  const document = new Window().document;
  document.body.innerHTML = html;
  return document;
}
type Doc = Awaited<ReturnType<typeof open>>;
const texts = (doc: Doc, selector: string) => [...doc.querySelectorAll(selector)].map((e) => e.textContent!.replace(/\s+/g, " ").trim());
const rowOf = (doc: Doc, id: number) => doc.querySelector(`tr[data-registration="${id}"]`)!;
/** The value of the option the select shows as chosen (React marks it `selected`; happy-dom's `select.value` does not read the markup). */
const chosen = (doc: Doc) => doc.querySelector("select option[selected]")?.getAttribute("value");
/** The pills of the row labelled `label`: their words and counts, and which one is current. */
const pills = (doc: Doc, label: string) => {
  const row = [...doc.querySelectorAll("nav[data-list-pill-row]")].find((n) => n.getAttribute("aria-label") === label)!;
  expect(row, label).toBeTruthy();
  return [...row.querySelectorAll("a")].map((a) => ({ text: a.textContent!, href: a.getAttribute("href")!, current: a.getAttribute("aria-current") === "true" }));
};

let db: Db;
const ids: Record<string, number> = {};
const sessions: Record<string, number> = {};
const course: Record<string, number> = {};

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const [lami] = await db.insert(courses).values({ ...base, slug: "lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, priceIndividual: 30000 }).returning();
  const [lash] = await db.insert(courses).values({ ...base, slug: "lash", type: "contact", title: { et: "Lash Lift" }, priceGroup: 35000, priceIndividual: 45000 }).returning();
  const [ecourse] = await db.insert(courses).values({ ...base, slug: "ekursus", type: "e_learning", title: { et: "Kulmumeistri e-koolitus" }, price: 19000 }).returning();
  const [noPrice] = await db.insert(courses).values({ ...base, slug: "hinnata", type: "contact", title: { et: "Hinnata koolitus" } }).returning();
  Object.assign(course, { lami: lami.id, lash: lash.id, ecourse: ecourse.id, noPrice: noPrice.id });
  const [s1] = await db.insert(courseSessions).values({ courseId: lami.id, startsAt: new Date("2030-12-12T08:00:00Z"), city: "Tartu" }).returning();
  const [s2] = await db.insert(courseSessions).values({ courseId: lami.id, startsAt: new Date("2030-12-19T08:00:00Z"), city: "Pärnu" }).returning();
  const [s3] = await db.insert(courseSessions).values({ courseId: lash.id, startsAt: new Date("2030-12-05T08:00:00Z"), city: "Tallinn" }).returning();
  Object.assign(sessions, { s1: s1.id, s2: s2.id, s3: s3.id });

  const add = async (key: string, v: Partial<typeof registrations.$inferInsert> & { name: string }) => {
    const [r] = await db
      .insert(registrations)
      .values({ courseId: lami.id, courseSessionId: s1.id, kind: "group", email: `${key}@example.test`, paymentChoice: "half", ...v })
      .returning();
    ids[key] = r.id;
  };
  await add("kati", { name: "Kati Kask", phone: "+372 5123 4567", status: "awaiting_prepayment", createdAt: new Date("2030-10-19T08:00:00Z") });
  await add("mari", { name: "Mari Mets", phone: "5000-0002", status: "confirmed", paidCents: 22000, createdAt: new Date("2030-10-18T08:00:00Z") });
  await add("liis", { name: "Liis Lash", phone: "", courseId: lash.id, courseSessionId: s3.id, status: "confirmed", paidCents: 17550, createdAt: new Date("2030-10-17T08:00:00Z") });
  await add("tiina", { name: "Tiina Tamm", phone: "+372 5000 0004", courseSessionId: s2.id, status: "cancelled", createdAt: new Date("2030-10-16T08:00:00Z") });
  await add("eda", { name: "Eda Ekursus", phone: "+372 5000 0005", courseId: ecourse.id, courseSessionId: null, status: "confirmed", paidCents: 19000, createdAt: new Date("2030-10-15T08:00:00Z") });
  await add("ines", { name: "Ines Individuaal", phone: "+372 5000 0006", courseId: lami.id, courseSessionId: null, kind: "individual", status: "awaiting_prepayment", createdAt: new Date("2030-10-14T08:00:00Z") });
  await add("hind", { name: "Hanna Hinnata", phone: "+372 5000 0007", courseId: noPrice.id, courseSessionId: null, status: "awaiting_prepayment", paidCents: 5000, createdAt: new Date("2030-10-13T08:00:00Z") });
});

describe("the toolbar", () => {
  test("the search field says what it searches, and shows the text of the address", async () => {
    const doc = await open("otsi=kask");
    const field = doc.querySelector('form[role="search"] input[type="search"]')!;
    expect(field.getAttribute("placeholder")).toBe("Otsi nime, e-posti või telefoni järgi");
    expect(field.getAttribute("aria-label")).toBe("Otsi nime, e-posti või telefoni järgi");
    expect(field.getAttribute("value")).toBe("kask");
  });

  test("two rows of pills: the statuses with their counts (Kõik first), then the forms, light and with no count (Kõik vormid first)", async () => {
    const doc = await open();
    expect(pills(doc, "Staatus")).toEqual([
      { text: "Kõik7", href: "/admin/registreerimised", current: true },
      { text: "Ootab ettemaksu3", href: "/admin/registreerimised?staatus=ootab", current: false },
      { text: "Kinnitatud3", href: "/admin/registreerimised?staatus=kinnitatud", current: false },
      { text: "Tühistatud1", href: "/admin/registreerimised?staatus=tuhistatud", current: false },
    ]);
    expect(pills(doc, "Õppevorm")).toEqual([
      { text: "Kõik vormid", href: "/admin/registreerimised", current: true },
      { text: "E-õpe", href: "/admin/registreerimised?vorm=e", current: false },
      { text: "Kontaktõpe", href: "/admin/registreerimised?vorm=k", current: false },
    ]);
    // the form row is the light one (the prototype draws its chosen pill light); the status row is the ink one
    const tone = (label: string) => [...doc.querySelectorAll("nav[data-list-pill-row]")].find((n) => n.getAttribute("aria-label") === label)!.getAttribute("data-tone");
    expect(tone("Õppevorm")).toBe("light");
    expect(tone("Staatus")).toBeNull();
    expect(doc.querySelectorAll('nav[aria-label="Õppevorm"] a > span')).toHaveLength(0); // no count bubble on a form pill
  });

  test("each pill keeps the search, the scope and the other row, and starts at page 1; a status pill's count is the rows it then shows", async () => {
    const doc = await open(`otsi=a&toimumine=${sessions.s1}&staatus=ootab&vorm=k&leht=3`);
    const status = pills(doc, "Staatus");
    expect(status.find((p) => p.current)!.text).toMatch(/^Ootab ettemaksu/);
    expect(status[2].href).toBe(`/admin/registreerimised?otsi=a&toimumine=${sessions.s1}&staatus=kinnitatud&vorm=k`);
    expect(status[0].href).toBe(`/admin/registreerimised?otsi=a&toimumine=${sessions.s1}&vorm=k`);
    const forms = pills(doc, "Õppevorm");
    expect(forms[1].href).toBe(`/admin/registreerimised?otsi=a&toimumine=${sessions.s1}&staatus=ootab&vorm=e`);
    // each status count equals the rows of the page the pill leads to
    for (const pill of status) {
      const target = await open(pill.href.split("?")[1] ?? "");
      expect(pill.text.replace(/^\D+/, ""), pill.href).toBe(String(target.querySelectorAll("tbody tr").length));
    }
  });

  test("the scope select: „Kõik koolitused ja toimumised“, each course, its sessions indented under it as „dd.mm.yyyy linn“", async () => {
    const doc = await open();
    const select = doc.querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("Koolitus ja toimumine");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Kõik koolitused ja toimumised",
      "Kulmude LAMI",
      `${NBSP}${NBSP}12.12.2030 Tartu`,
      `${NBSP}${NBSP}19.12.2030 Pärnu`,
      "Lash Lift",
      `${NBSP}${NBSP}05.12.2030 Tallinn`,
      "Kulmumeistri e-koolitus",
      "Hinnata koolitus",
    ]);
    expect(chosen(doc)).toBe("");
  });

  test("the scope select shows the choice of the address: a session, or a course; a session wins; an id that does not exist is no scope", async () => {
    expect(chosen(await open(`toimumine=${sessions.s2}`))).toBe(`s${sessions.s2}`);
    expect(chosen(await open(`koolitus=${course.lash}`))).toBe(`k${course.lash}`);
    expect(chosen(await open(`koolitus=${course.lash}&toimumine=${sessions.s1}`))).toBe(`s${sessions.s1}`);
    const gone = await open("toimumine=999999&koolitus=888888");
    expect(chosen(gone)).toBe("");
    expect(gone.querySelectorAll("tbody tr").length).toBe(7);
  });

  test("each option leads to its own address: the session or the course, the search and the filters kept, the page and the drawer dropped", async () => {
    await open(`otsi=a&staatus=ootab&vorm=k&leht=2&id=${ids.kati}`);
    const options = seen.toolbar!.scope.options;
    const at = (value: string) => options.find((o) => o.value === value)!.href;
    expect(at("")).toBe("/admin/registreerimised?otsi=a&staatus=ootab&vorm=k");
    expect(at(`k${course.lash}`)).toBe(`/admin/registreerimised?otsi=a&koolitus=${course.lash}&staatus=ootab&vorm=k`);
    expect(at(`s${sessions.s2}`)).toBe(`/admin/registreerimised?otsi=a&toimumine=${sessions.s2}&staatus=ootab&vorm=k`);
    // from a course the session option takes the course away (one scope at a time), and from a session the course option takes the session away
    await open(`koolitus=${course.lami}`);
    expect(seen.toolbar!.scope.options.find((o) => o.value === `s${sessions.s1}`)!.href).toBe(`/admin/registreerimised?toimumine=${sessions.s1}`);
    await open(`toimumine=${sessions.s1}`);
    expect(seen.toolbar!.scope.options.find((o) => o.value === `k${course.lami}`)!.href).toBe(`/admin/registreerimised?koolitus=${course.lami}`);
    expect(seen.toolbar!.scope.value).toBe(`s${sessions.s1}`);
  });
});

describe("the table", () => {
  test("five columns: Kuupäev | Nimi ja kontakt | Koolitus ja toimumine | Laekunud | Staatus (no Liik, Modelli abi, Konto, Makse)", async () => {
    const doc = await open();
    expect(texts(doc, "thead th")).toEqual(["Kuupäev", "Nimi ja kontakt", "Koolitus ja toimumine", "Laekunud", "Staatus"]);
    expect(doc.body.innerHTML).not.toMatch(/>Liik<|Modelli abi|>Konto<|>Makse<|Kõik staatused/);
    expect(rowOf(doc, ids.kati).querySelectorAll("td").length).toBe(5);
  });

  test("a row: the date, the name (a link that opens the drawer) with the phone, the course with the session, the money, the status", async () => {
    const row = rowOf(await open(), ids.kati);
    const cells = [...row.querySelectorAll("td")];
    expect(cells[0].textContent).toBe("19.10.2030"); // the date, not the time
    const name = row.querySelector("a[aria-label]")!;
    expect(name.textContent).toBe("Kati Kask");
    expect(name.getAttribute("aria-label")).toBe("Ava Kati Kask");
    expect(name.getAttribute("href")).toBe(`/admin/registreerimised?id=${ids.kati}`);
    const phone = row.querySelector('a[href^="tel:"]')!;
    expect(phone.textContent).toBe("+372 5123 4567");
    expect(phone.getAttribute("href")).toBe("tel:+37251234567");
    expect(row.querySelector('a[href^="mailto:"]')).toBeNull(); // the e-mail is in the drawer; the search finds it
    expect(cells[2].textContent).toBe("Kulmude LAMI12.12 · Tartu");
    expect(cells[3].textContent).toBe("0 / 220 €");
    expect(cells[4].textContent).toBe("Ootab ettemaksu");
  });

  test("Laekunud is „{paid} / {price} €“, with cents when there are some; a course with no price shows the money alone", async () => {
    const doc = await open();
    const paid = (key: string) => rowOf(doc, ids[key]).querySelectorAll("td")[3].textContent;
    expect(paid("mari")).toBe("220 / 220 €");
    expect(paid("liis")).toBe("175,50 / 350 €");
    expect(paid("eda")).toBe("190 / 190 €");
    expect(paid("hind")).toBe("50 €");
    // the phone card reads „… · laekunud {x}“ from this cell: the word is the cell's attribute, not CSS text
    expect(rowOf(doc, ids.mari).querySelectorAll("td")[3].getAttribute("data-paid-word")).toBe("laekunud");
  });

  test("the second line under the course: the session's day and city, „Aeg kokkuleppel“ for an individual one, „E-õpe“ for an e-course", async () => {
    const doc = await open();
    const session = (key: string) => rowOf(doc, ids[key]).querySelector("td:nth-child(3) span:last-child")!.textContent;
    expect(session("mari")).toBe("12.12 · Tartu");
    expect(session("liis")).toBe("05.12 · Tallinn");
    expect(session("tiina")).toBe("19.12 · Pärnu");
    expect(session("ines")).toBe("Aeg kokkuleppel");
    expect(session("eda")).toBe("E-õpe");
  });

  test("a registration with no phone has the name alone; the count line is in the card", async () => {
    const doc = await open();
    expect(rowOf(doc, ids.liis).querySelector('a[href^="tel:"]')).toBeNull();
    expect(doc.querySelector("section")!.textContent).toContain("Registreerimisi: 7");
  });

  test("newest first", async () => {
    const doc = await open();
    expect([...doc.querySelectorAll("tbody tr")].map((r) => Number(r.getAttribute("data-registration")))).toEqual(
      [ids.kati, ids.mari, ids.liis, ids.tiina, ids.eda, ids.ines, ids.hind],
    );
  });
});

describe("searching and scoping", () => {
  test("a phone typed with spaces finds the registration stored as „+372 5123 4567“", async () => {
    const doc = await open(`otsi=${encodeURIComponent("5123 4567")}`);
    expect(texts(doc, "tbody tr td:nth-child(2) a:first-child")).toEqual(["Kati Kask"]);
    expect(doc.querySelector("section")!.textContent).toContain("Registreerimisi: 1");
    // and the pills count under the search
    expect(pills(doc, "Staatus").map((p) => p.text)).toEqual(["Kõik1", "Ootab ettemaksu1", "Kinnitatud0", "Tühistatud0"]);
  });

  test("a session or a course limits the list; the counts follow", async () => {
    const session = await open(`toimumine=${sessions.s1}`);
    expect(texts(session, "tbody tr td:nth-child(2) a:first-child")).toEqual(["Kati Kask", "Mari Mets"]);
    const course_ = await open(`koolitus=${course.lami}`);
    expect(texts(course_, "tbody tr td:nth-child(2) a:first-child")).toEqual(["Kati Kask", "Mari Mets", "Tiina Tamm", "Ines Individuaal"]);
    // (the status pills follow the course; the form pills have no count)
    expect(pills(course_, "Staatus").map((p) => p.text)).toEqual(["Kõik4", "Ootab ettemaksu2", "Kinnitatud1", "Tühistatud1"]);
    expect(pills(course_, "Õppevorm").map((p) => p.text)).toEqual(["Kõik vormid", "E-õpe", "Kontaktõpe"]);
  });
});

describe("empty states", () => {
  test("a search with no hit says so with the words typed, and offers to clear the search and the filters", async () => {
    const doc = await open("otsi=zzz&staatus=ootab");
    const empty = doc.querySelector("[data-list-empty]")!;
    expect(empty.querySelector("p")!.textContent).toBe("„zzz“ järgi registreerimisi ei leitud.");
    const clear = empty.querySelector("a")!;
    expect(clear.textContent).toBe("Tühjenda otsing ja filtrid");
    expect(clear.getAttribute("href")).toBe("/admin/registreerimised");
    expect(doc.querySelector("table")).toBeNull();
    expect(doc.querySelector("section")!.textContent).toContain("Registreerimisi: 0");
  });

  test("a filter with no hit: „Selle valikuga registreerimisi pole.“ and the button; a scope counts as a filter", async () => {
    const doc = await open(`staatus=tuhistatud&koolitus=${course.lash}`);
    expect(doc.querySelector("[data-list-empty] p")!.textContent).toBe("Selle valikuga registreerimisi pole.");
    expect(doc.querySelector("[data-list-empty] a")!.getAttribute("href")).toBe("/admin/registreerimised");
  });

  test("nothing registered at all: „Registreerimisi veel pole.“ and no button", async () => {
    const was = state.db;
    state.db = await makeTestDb();
    try {
      const doc = await open();
      expect(doc.querySelector("[data-list-empty]")!.textContent).toBe("Registreerimisi veel pole.");
      expect(doc.querySelector("[data-list-empty] a")).toBeNull();
    } finally {
      state.db = was;
    }
  });
});

describe("the list's address is carried to the drawer and the pager", () => {
  test("the row links open the drawer on the same list; the drawer closes back to it (search, scope, filters and page)", async () => {
    const query = `otsi=a&koolitus=${course.lami}&staatus=ootab&vorm=k`;
    const doc = await open(query);
    const link = rowOf(doc, ids.kati).querySelector("a[aria-label]")!;
    expect(link.getAttribute("href")).toBe(`/admin/registreerimised?otsi=a&koolitus=${course.lami}&staatus=ootab&vorm=k&id=${ids.kati}`);
    const withDrawer = await open(`${query}&id=${ids.kati}`);
    expect(withDrawer.querySelector("[data-drawer-stand-in]")!.getAttribute("data-close-href")).toBe(`/admin/registreerimised?${query}`);
    // the open row is marked (the admin's one extra colour)
    expect(rowOf(withDrawer, ids.kati).className).not.toBe("");
    expect(rowOf(withDrawer, ids.ines).className).toBe("");
  });

  test("the pager keeps the search and the scope", async () => {
    for (let i = 0; i < 55; i++)
      await db.insert(registrations).values({ courseId: course.lami, courseSessionId: sessions.s2, kind: "group", name: `Massi ${i}`, email: `massi${i}@example.test`, paymentChoice: "half" });
    const doc = await open(`otsi=massi&toimumine=${sessions.s2}`);
    expect(doc.querySelectorAll("tbody tr").length).toBe(50);
    const next = doc.querySelector('nav[data-pager] a[rel="next"]')!;
    expect(next.getAttribute("href")).toBe(`/admin/registreerimised?otsi=massi&toimumine=${sessions.s2}&leht=2`);
    const second = await open(`otsi=massi&toimumine=${sessions.s2}&leht=2`);
    expect(second.querySelectorAll("tbody tr").length).toBe(5);
    expect(second.querySelector('nav[data-pager] a[rel="prev"]')!.getAttribute("href")).toBe(`/admin/registreerimised?otsi=massi&toimumine=${sessions.s2}`);
  });
});

describe("the drawer (Task 5: README A2 drawer 1–3)", () => {
  const drawerOf = async (id: number) => (await open(`id=${id}`)).querySelector(`[data-registration-detail="${id}"]`)!;
  const said = (el: { textContent: string | null } | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  test("the header: the status pill and the note's SaveStatus on one line, the name, „{course} · {date time} · {city, venue} · Grupp“, the phone and the e-mail", async () => {
    const d = await drawerOf(ids.kati);
    const head = d.querySelector("header")!;
    expect(said(head.querySelector("[data-reg-status]"))).toBe("Ootab ettemaksu");
    expect(head.querySelector("[data-save-status]")).not.toBeNull();
    expect(said(head.querySelector("h2"))).toBe("Kati Kask");
    expect(said(head.querySelector("[data-registration-line]"))).toBe("Kulmude LAMI · 12.12.2030 10:00 · Tartu · Grupp");
    expect([...head.querySelectorAll("a[href^='tel:'], a[href^='mailto:']")].map((a) => a.getAttribute("href"))).toEqual(["tel:+37251234567", "mailto:kati@example.test"]);
    expect(head.querySelector("[data-registration-protocol]")!.getAttribute("href")).toBe(`/admin/protokollid?registreering=${ids.kati}`);
  });

  test("without a session the header says P-4's line; an e-learning one has no „Ava protokoll“", async () => {
    expect(said((await drawerOf(ids.ines)).querySelector("[data-registration-line]"))).toBe("Kulmude LAMI · Aeg kokkuleppel · Individuaal");
    const e = await drawerOf(ids.eda);
    expect(said(e.querySelector("[data-registration-line]"))).toBe("Kulmumeistri e-koolitus · E-õpe");
    expect(e.querySelector("[data-registration-protocol]")).toBeNull();
  });

  test("Raha: the money against the price and the session's free seats counted now (Mari's confirmed place takes one of 4)", async () => {
    const card = (await drawerOf(ids.kati)).querySelector("[data-money-card]")!;
    expect(said(card.querySelector("[data-paid]"))).toBe("0 €");
    expect(said(card.querySelector("[data-money-total]"))).toBe("/ 220 € laekunud");
    expect(said(card.querySelector("[data-money-choice]"))).toBe("Valitud: ettemaks 50%");
    expect(said(card.querySelector("[data-money-seat]"))).toBe("Koht kinnitub 110 € juures · vabu kohti 3 / 4");
    expect(said(card.querySelector("[data-add-payment]"))).toBe("Lisa laekumine");
    // no session: S3-d's line (an individual one is measured against the individual price)
    expect(said((await drawerOf(ids.ines)).querySelector("[data-money-seat]"))).toBe("Registreering kinnitub 150 € juures");
    expect(said((await drawerOf(ids.eda)).querySelector("[data-money-seat]"))).toBe("Registreering kinnitub 95 € juures");
    // no price: the notice, no bar
    const none = (await drawerOf(ids.hind)).querySelector("[data-money-card]")!;
    expect(none.querySelector("[data-money-bar]")).toBeNull();
    expect(said(none)).toContain("Koolitusel pole hinda, staatust ei arvutata. Muuda staatust käsitsi.");
    // a cancelled registration: no „Lisa laekumine“
    expect((await drawerOf(ids.tiina)).querySelector("[data-add-payment]")).toBeNull();
  });

  test("„Staatus ja märkus“ after Raha and before „Arved“: two status pills, the note with „Näeb ainult haldus.“; a cancelled one's pills are off", async () => {
    const d = await drawerOf(ids.kati);
    const html = d.innerHTML;
    expect(html.indexOf("data-money-card")).toBeLessThan(html.indexOf("data-status-form"));
    expect(html.indexOf("data-status-form")).toBeLessThan(html.indexOf("data-registration-invoices"));
    const part = d.querySelector("[data-status-form]")!;
    expect(said(part.querySelector("h3"))).toBe("Staatus ja märkus");
    const pills = [...part.querySelectorAll("[data-status-choice] input[type=radio]")];
    expect(pills.map((r) => [said(r.closest("label")), r.hasAttribute("checked"), r.hasAttribute("disabled")])).toEqual([
      ["Ootab ettemaksu", true, false],
      ["Kinnitatud", false, false],
    ]);
    const note = part.querySelector("textarea[name='note']")!;
    expect(note.getAttribute("maxlength")).toBe("2000");
    expect(said(part.querySelector(`label[for="${note.id}"]`))).toBe("Märkus");
    expect(said(part)).toContain("Näeb ainult haldus.");
    expect(said(part)).not.toContain("Salvesta staatus");
    const cancelled = [...(await drawerOf(ids.tiina)).querySelectorAll("[data-status-choice] input[type=radio]")];
    expect(cancelled.map((r) => [r.hasAttribute("checked"), r.hasAttribute("disabled")])).toEqual([
      [false, true],
      [false, true],
    ]);
  });
});
