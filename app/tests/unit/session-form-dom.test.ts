// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import type { SessionFields } from "@/domain/session-fields";
import { stubFetch } from "../fakes";

// The Kalender drawer (admin UX pass piece 3b, Task 3; README B3, the Part 3 frame „B3 Kalender“ and the Part 4 „B3 Session drawer“; piece3-texts
// S3-P3-g, S3-P3-i, P-2, P-7, P-8; rulings R-a, R-b, R-c). A stored session's drawer: the header (SaveStatus left of ✕, the course, „{date} · {city} ·
// {k}/{cap} kinnitatud · ootab ettemaksu {a} · ootenimekirjas {n}“ — the last two parts only when above 0, Dim 25.10 —, „Protokollid“ as the first button); the notice „{n} õpilast on registreerunud. …“; the fields autosave on
// api/admin/toimumine/<id> (no „Salvesta toimumine“), the date or time changed says „Muudetud — teavita {n} õpilast ise.“, „Kohti“ commits on blur and
// below the confirmed is refused in the field, „Koolitus“ is locked once anyone is booked with S3-P3-i under it; the status is instant, „Tühistatud“ with
// registrations behind a ConfirmPanel; „Kustuta toimumine“ only without registrations, else the refusal text. A new session (?id=uus): the header's
// „Täida kohustuslikud väljad“ / „Vajuta „Lisa toimumine“.“, the one explicit create, then the drawer goes on at ?id=<n>; leaving with typed text asks
// with „Toimumist pole veel lisatud.“.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ createSessionAction: vi.fn(), setSessionStatusAction: vi.fn(), deleteSession: vi.fn() }));
vi.mock("@/server/actions/admin-content", () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { Drawer } from "@/components/admin/Drawer";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { NewSession, SessionDrawer } from "@/components/admin/SessionForm";

const ID = 7;
const COURSES = [
  { id: 3, title: "Kulmumeistri baaskoolitus", published: true },
  { id: 5, title: "Lash Lift BOTOX baaskoolitus", published: true },
  { id: 9, title: "Uus kursus", published: false },
];
const FIELDS: SessionFields = { courseId: 3, date: "2026-12-05", time: "10:00", city: "Pärnu", venue: "MS LAB stuudio, Rüütli 12", language: "ET", capacity: "4" };
type DrawerProps = Parameters<typeof SessionDrawer>[0];
const props = (over: Partial<DrawerProps> = {}): DrawerProps => ({
  id: ID,
  version: "s:v1",
  fields: FIELDS,
  status: "scheduled",
  counts: { confirmed: 4, booked: 4, all: 4 },
  awaiting: 0,
  waitlist: 2,
  title: "Kulmumeistri baaskoolitus",
  when: "05.12.2026",
  contact: true,
  courses: COURSES,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
/** The route's version: a save of it is stored and moves it; another is a conflict. `refuse`: the route's 400 for the next save. */
let current = "s:v1";
let saves = 0;
let refuse: Record<string, string> | null = null;
let gone = false;
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url !== `/api/admin/toimumine/${ID}`) return Response.json({ ok: false }, { status: 404 });
  if (gone) return Response.json({ ok: false, error: "notFound" }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  if (refuse) {
    const fields = refuse;
    refuse = null;
    return Response.json({ ok: false, error: "invalid", fields }, { status: 400 });
  }
  if (body.version !== current) return Response.json({ ok: false, error: "conflict", version: current, value: { ...FIELDS, city: "Tartu", status: "scheduled" } }, { status: 409 });
  current = `s:v${2 + saves++}`;
  return Response.json({ ok: true, version: current, savedAt: "2026-10-24T11:03:00.000Z" });
};

/** The page round the drawer as the (panel) layout has it: the guard, the row link the focus goes back to, the drawer. */
const page = (content: React.ReactNode, label = "Toimumine: Kulmumeistri baaskoolitus, 05.12.2026") =>
  createElement(
    LeaveGuardProvider,
    null,
    createElement("a", { id: `session-${ID}`, href: `/admin/kalender?id=${ID}` }, "Kulmumeistri baaskoolitus"),
    createElement(Drawer, { label, closeHref: "/admin/kalender", closeLabel: "Sulge", returnFocus: `session-${ID}` } as Parameters<typeof Drawer>[0], content),
  );
const show = (over: Partial<DrawerProps> = {}) => act(async () => root.render(page(createElement(SessionDrawer, props(over)))));
const showNew = (listHref = "/admin/kalender?linn=P%C3%A4rnu") =>
  act(async () => root.render(page(createElement(NewSession, { courses: COURSES, listHref }), "Uus toimumine")));

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const $$ = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
const buttonNamed = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const field = (name: string) => dialog().querySelector<HTMLInputElement>(`input[name="${name}"], select[name="${name}"]`)!;
const select = (name: string) => dialog().querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
const labelOf = (el: Element) => text(document.querySelector(`label[for="${el.id}"]`));
/** The words under a field: its hint and its error, in the order the field names them (aria-describedby). */
const described = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => text(document.getElementById(id)));
const type = async (el: HTMLInputElement | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const choose = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const leave = (el: Element | null) => act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const chip = () => $("[data-session-head] [data-save-status]");
const radio = (status: "scheduled" | "cancelled") => $<HTMLInputElement>(`[data-session-status] input[value='${status}']`)!;
const panel = () => $("[data-session-status] [data-confirm-panel]");

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  actions.setSessionStatusAction.mockImplementation(async () => {
    current = `${current}c`;
    return { ok: true, version: current };
  });
  actions.deleteSession.mockResolvedValue({ ok: true, id: ID, deleted: true });
  current = "s:v1";
  saves = 0;
  refuse = null;
  gone = false;
  localStorage.clear();
  history.replaceState({ __NA: true }, "", `/admin/kalender?id=${ID}`);
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  fetched.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the header (README B3; P-7)", () => {
  it("SaveStatus left of ✕ „Sulge“, the course, „05.12.2026 · Pärnu · 4/4 kinnitatud · ootenimekirjas 2“ and „Protokollid“ as the first button; no „Salvesta toimumine“", async () => {
    await show();
    const head = $("[data-session-head]")!;
    expect(chip()).not.toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(buttonNamed("Sulge", dialog())).not.toBeNull();
    expect(text(head.querySelector("h2"))).toBe("Kulmumeistri baaskoolitus");
    expect(text(head.querySelector("[data-line='wide']"))).toBe("05.12.2026 · Pärnu · 4/4 kinnitatud · ootenimekirjas 2");
    // the phone's short form (Part 4), drawn there instead
    expect(text(head.querySelector("[data-line='short']"))).toBe("05.12.2026 · Pärnu · 4/4 · ootel 2");
    const protocols = head.querySelector<HTMLAnchorElement>("[data-session-protocols]")!;
    expect(text(protocols)).toBe("Protokollid");
    expect(protocols.getAttribute("href")).toBe(`/admin/protokollid?sessioon=${ID}`);
    // the first control of the drawer's content, before any field (the drawer's own ✕ aside)
    const controls = Array.from(dialog().querySelectorAll<HTMLElement>("[data-session-drawer] a, [data-session-drawer] button, [data-session-drawer] input, [data-session-drawer] select"));
    expect(controls[0]).toBe(protocols);
    expect(buttonNamed("Salvesta toimumine", dialog())).toBeNull();
    expect(dialog().textContent).not.toContain("Salvesta toimumine");
  });

  it("no waitlist: the last part is left out („… · 0/6 kinnitatud“, the phone „… · 0/6“); a course that is not a contact course has no „Protokollid“", async () => {
    await show({ fields: { ...FIELDS, capacity: "6", city: "Tartu" }, counts: { confirmed: 0, booked: 0, all: 0 }, waitlist: 0, contact: false });
    expect(text($("[data-line='wide']"))).toBe("05.12.2026 · Tartu · 0/6 kinnitatud");
    expect(text($("[data-line='short']"))).toBe("05.12.2026 · Tartu · 0/6");
    expect($("[data-session-protocols]")).toBeNull();
  });

  it("registrations awaiting their prepayment (Dim 25.10): „· ootab ettemaksu {n}“ between the confirmed and the waitlist, only when there is one; on the phone's line too", async () => {
    await show({ counts: { confirmed: 3, booked: 5, all: 5 }, awaiting: 1 });
    expect(text($("[data-line='wide']"))).toBe("05.12.2026 · Pärnu · 3/4 kinnitatud · ootab ettemaksu 1 · ootenimekirjas 2");
    expect(text($("[data-line='short']"))).toBe("05.12.2026 · Pärnu · 3/4 · ootab ettemaksu 1 · ootel 2");
    await show({ counts: { confirmed: 3, booked: 5, all: 5 }, awaiting: 2, waitlist: 0 });
    expect(text($("[data-line='wide']"))).toBe("05.12.2026 · Pärnu · 3/4 kinnitatud · ootab ettemaksu 2");
    await show({ counts: { confirmed: 3, booked: 5, all: 5 }, awaiting: 0 });
    expect(text($("[data-line='wide']"))).toBe("05.12.2026 · Pärnu · 3/4 kinnitatud · ootenimekirjas 2");
    expect(text($("[data-line='short']"))).toBe("05.12.2026 · Pärnu · 3/4 · ootel 2");
    expect($("[data-session-head]")!.textContent).not.toContain("ootab ettemaksu");
  });

  it("a session just added (?lisatud=) says „Toimumine lisatud.“ at the top of the drawer", async () => {
    await show({ added: true, counts: { confirmed: 0, booked: 0, all: 0 } });
    expect(text($("[data-session-drawer] [data-flash='added']"))).toBe("Toimumine lisatud.");
    await show({ added: false });
    expect($("[data-flash='added']")).toBeNull();
  });
});

describe("the registrations notice (README B3; P-8; R-b: n = the registrations that are not cancelled)", () => {
  it("„4 õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“; one: „1 õpilane on registreerunud. Muudatusest talle kirja ei saadeta.“; none: no notice", async () => {
    await show({ counts: { confirmed: 1, booked: 4, all: 6 } });
    expect(text($("[data-session-booked]"))).toBe("4 õpilast on registreerunud. Muudatusest neile kirja ei saadeta.");
    await show({ counts: { confirmed: 0, booked: 1, all: 1 } });
    expect(text($("[data-session-booked]"))).toBe("1 õpilane on registreerunud. Muudatusest talle kirja ei saadeta.");
    await show({ counts: { confirmed: 0, booked: 0, all: 2 } });
    expect($("[data-session-booked]")).toBeNull();
  });
});

describe("the fields autosave (README B3, §1.3; R-a)", () => {
  it("are „Koolitus“, „Kuupäev“, „Algus (Eesti aeg)“, „Linn“, „Kohti“, „Toimumiskoht“ and „Keel“, with the stored values; no „Eesti aeg.“ hint", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    const names = ["courseId", "date", "time", "city", "capacity", "venue", "language"];
    expect(names.map((n) => labelOf(field(n)))).toEqual(["Koolitus", "Kuupäev", "Algus (Eesti aeg)", "Linn", "Kohti", "Toimumiskoht", "Keel"]);
    expect(names.map((n) => field(n).value)).toEqual(["3", "2026-12-05", "10:00", "Pärnu", "4", "MS LAB stuudio, Rüütli 12", "ET"]);
    expect(dialog().textContent).not.toContain("Eesti aeg.");
  });

  it("a city typed saves on the session's route from the version the page read when the field is left; the chip says it; the page is read again", async () => {
    await show();
    await type(field("city"), "Tartu");
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    await leave(field("city"));
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url, c.body])).toEqual([["POST", `/api/admin/toimumine/${ID}`, { version: "s:v1", patch: { city: "Tartu" } }]]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(text(chip()!.querySelector("[data-save-text]"))).toBe("✓ Salvestatud 14:03");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("the date or the time changed on a booked session says „Muudetud — teavita 4 õpilast ise.“ under that field; typed back, it goes; the city never does", async () => {
    await show();
    const date = field("date");
    await type(date, "2026-12-06");
    const hint = () => dialog().querySelector("[data-field='date'] [data-changed-hint]");
    expect(text(hint())).toBe("Muudetud — teavita 4 õpilast ise.");
    expect(described(date)).toContain("Muudetud — teavita 4 õpilast ise.");
    expect(date.hasAttribute("data-changed")).toBe(true);
    await type(field("time"), "11:30");
    expect(text(dialog().querySelector("[data-field='time'] [data-changed-hint]"))).toBe("Muudetud — teavita 4 õpilast ise.");
    await type(date, "2026-12-05");
    expect(hint()).toBeNull();
    await type(field("city"), "Tartu");
    expect(dialog().querySelector("[data-field='city'] [data-changed-hint]")).toBeNull();
    // one booked: the same words (P-8)
    await act(async () => root.unmount());
    root = createRoot(container);
    await show({ counts: { confirmed: 1, booked: 1, all: 1 } });
    await type(field("date"), "2026-12-06");
    expect(text(dialog().querySelector("[data-field='date'] [data-changed-hint]"))).toBe("Muudetud — teavita 1 õpilast ise.");
  });

  it("nobody booked: a changed date says nothing (there is nobody to tell)", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await type(field("date"), "2026-12-06");
    expect(dialog().querySelector("[data-changed-hint]")).toBeNull();
  });

  it("„Kohti“ commits on blur: nothing is sent while it is typed, not even after the autosave's wait; left, it is saved", async () => {
    fakeClock();
    await show();
    await type(field("capacity"), "1");
    await type(field("capacity"), "12");
    await wait(DEBOUNCE_MS + 500);
    expect(fetched.calls).toEqual([]);
    expect(field("capacity").value).toBe("12");
    await leave(field("capacity"));
    await wait(10);
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { capacity: "12" } }]);
  });

  it("„Kohti“ below the confirmed is refused in the field: „Kinnitatud on 4 — kohti ei saa olla vähem.“, nothing is sent, the chip says a field waits", async () => {
    await show();
    const capacity = field("capacity");
    await type(capacity, "3");
    await leave(capacity);
    await settle();
    expect(fetched.calls).toEqual([]);
    expect(capacity.getAttribute("aria-invalid")).toBe("true");
    expect(text(dialog().querySelector("[data-field='capacity'] [data-field-error]"))).toBe("Kinnitatud on 4 — kohti ei saa olla vähem.");
    expect(described(capacity)).toContain("Kinnitatud on 4 — kohti ei saa olla vähem.");
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    // „Näita“ goes to it
    await click(buttonNamed("Näita", chip()!));
    expect(document.activeElement).toBe(capacity);
    // as many seats as confirmed is fine
    await type(capacity, "4");
    await leave(capacity);
    await settle();
    expect(capacity.getAttribute("aria-invalid")).toBeNull();
    expect(fetched.calls).toEqual([]); // (4 is the stored value: nothing to send)
    await type(capacity, "5");
    await leave(capacity);
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { capacity: "5" } }]);
  });

  it("the server's own refusal (a seat confirmed meanwhile) is shown in the field too, and the page is read again for the counts", async () => {
    await show({ counts: { confirmed: 2, booked: 2, all: 2 } });
    refuse = { capacity: "capacityBelow" };
    await type(field("capacity"), "2");
    await leave(field("capacity"));
    await settle();
    expect(fetched.calls).toHaveLength(1);
    expect(field("capacity").getAttribute("aria-invalid")).toBe("true");
    expect(text(dialog().querySelector("[data-field='capacity'] [data-field-error]"))).toBe("Kinnitatud on 2 — kohti ei saa olla vähem.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a session row under an e-course: the server's „course“ refusal (with every field sent named) is said under „Koolitus“ alone, and „Näita“ goes there", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    refuse = { courseId: "course", capacity: "course" };
    await type(field("capacity"), "3");
    await leave(field("capacity"));
    await settle();
    expect(text(dialog().querySelector("[data-field='courseId'] [data-field-error]"))).toBe("Vali koolitus.");
    expect(dialog().querySelector("[data-field='capacity'] [data-field-error]")).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    await click(buttonNamed("Näita", chip()!));
    expect(document.activeElement).toBe(select("courseId"));
  });

  it("„Koolitus“ is locked once anyone is booked, with S3-P3-i under it; with nobody booked another course is saved at once (a number)", async () => {
    await show({ counts: { confirmed: 0, booked: 1, all: 1 } });
    const course = select("courseId");
    expect(course.disabled).toBe(true);
    expect(text(dialog().querySelector("[data-field='courseId'] [data-course-locked]"))).toBe("Toimumisel on registreeringuid, seega koolitust muuta ei saa.");
    expect(described(course)).toContain("Toimumisel on registreeringuid, seega koolitust muuta ei saa.");
    await act(async () => root.unmount());
    root = createRoot(container);
    // only cancelled registrations: not booked (R-b), the course may change
    await show({ counts: { confirmed: 0, booked: 0, all: 3 } });
    const free = select("courseId");
    expect(free.disabled).toBe(false);
    expect(dialog().querySelector("[data-course-locked]")).toBeNull();
    expect(Array.from(free.options).map((o) => o.textContent)).toEqual(["Kulmumeistri baaskoolitus", "Lash Lift BOTOX baaskoolitus", "Uus kursus (Mustand)"]);
    await choose(free, "5");
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { courseId: 5 } }]);
  });

  it("„Keel“ is saved at once when chosen", async () => {
    await show();
    await choose(select("language"), "ET / RU");
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { language: "ET / RU" } }]);
  });

  it("✕ with „Kohti“ typed and not left yet: it is committed and saved first, and the drawer closes", async () => {
    await show();
    await type(field("capacity"), "6");
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { capacity: "6" } }]);
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/admin/kalender", { scroll: false });
  });

  it("✕ with „Kohti“ below the confirmed: the guard asks, naming „Kohti“, and „Jää siia“ goes back to it", async () => {
    await show();
    await type(field("capacity"), "2");
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(dialog().open).toBe(true);
    expect(text($("[data-leave-title]"))).toBe("Muudatust „Kohti“ ei saanud veel salvestada.");
    expect(text($("[data-leave-reason]"))).toBe("Üks väli vajab parandamist.");
    await click(buttonNamed("Jää siia"));
    expect(document.activeElement).toBe(field("capacity"));
  });

  it("the session deleted meanwhile: the chip says „Seda toimumist enam ei ole. Tekst on selles seadmes alles.“", async () => {
    gone = true;
    await show();
    await type(field("venue"), "Teine saal");
    await leave(field("venue"));
    await settle();
    expect(chip()!.getAttribute("data-save-kind")).toBe("gone");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Seda toimumist enam ei ole. Tekst on selles seadmes alles.");
  });
});

describe("„Staatus“: instant; „Tühistatud“ with registrations asks first (README B3; P-8)", () => {
  it("the pills „Toimub“ / „Tühistatud“ with the stored one chosen, and the existing hint under them", async () => {
    await show();
    expect(radio("scheduled").checked).toBe(true);
    expect(radio("cancelled").checked).toBe(false);
    expect(text($("[data-session-status] legend"))).toBe("Staatus");
    expect(text($("[data-session-status]"))).toContain("Tühistatud toimumine jääb avalikku kalendrisse märkega „Tühistatud“.");
  });

  it("booked: the ConfirmPanel „Kas tühistan toimumise?“ · „2 registreeringut jäävad alles; teavita õpilasi ise.“ · „Jah, tühista“ / „Katkesta“; „Katkesta“ keeps „Toimub“", async () => {
    await show({ counts: { confirmed: 1, booked: 2, all: 2 } });
    await click(radio("cancelled"));
    const p = panel()!;
    expect(p).not.toBeNull();
    expect(text(p.querySelector("p"))).toBe("Kas tühistan toimumise?");
    expect(Array.from(p.querySelectorAll("li")).map(text)).toEqual(["2 registreeringut jäävad alles; teavita õpilasi ise."]);
    expect(Array.from(p.querySelectorAll("button")).map(text)).toEqual(["Jah, tühista", "Katkesta"]);
    expect(document.activeElement).toBe(p);
    expect(actions.setSessionStatusAction).not.toHaveBeenCalled();
    await click(buttonNamed("Katkesta", p));
    expect(panel()).toBeNull();
    expect(radio("scheduled").checked).toBe(true);
    expect(document.activeElement).toBe(radio("scheduled"));
    expect(actions.setSessionStatusAction).not.toHaveBeenCalled();
    // asked again and confirmed: the instant action with the version the drawer holds
    await click(radio("cancelled"));
    await click(buttonNamed("Jah, tühista"));
    await settle();
    expect(actions.setSessionStatusAction).toHaveBeenCalledExactlyOnceWith({ id: ID, status: "cancelled", version: "s:v1" });
    expect(panel()).toBeNull();
  });

  it("one booked: „1 registreering jääb alles; teavita õpilast ise.“", async () => {
    await show({ counts: { confirmed: 0, booked: 1, all: 1 } });
    await click(radio("cancelled"));
    expect(Array.from(panel()!.querySelectorAll("li")).map(text)).toEqual(["1 registreering jääb alles; teavita õpilast ise."]);
  });

  it("nobody booked: „Tühistatud“ is saved at once with no question, and „Toimub“ puts it back the same way", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(radio("cancelled"));
    await settle();
    expect(panel()).toBeNull();
    expect(actions.setSessionStatusAction).toHaveBeenCalledExactlyOnceWith({ id: ID, status: "cancelled", version: "s:v1" });
    // the page's read after the action has it
    await show({ counts: { confirmed: 0, booked: 0, all: 0 }, status: "cancelled", version: "s:v1c" });
    expect(radio("cancelled").checked).toBe(true);
    await click(radio("scheduled"));
    await settle();
    expect(panel()).toBeNull();
    expect(actions.setSessionStatusAction).toHaveBeenLastCalledWith({ id: ID, status: "scheduled", version: "s:v1c" });
  });

  it("booked and cancelled: „Toimub“ puts it back with no question", async () => {
    await show({ status: "cancelled" });
    await click(radio("scheduled"));
    await settle();
    expect(panel()).toBeNull();
    expect(actions.setSessionStatusAction).toHaveBeenCalledExactlyOnceWith({ id: ID, status: "scheduled", version: "s:v1" });
  });

  it("one version for the fields and the status (R-a): a field save's version goes with the status, and the status's with the next field save", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await type(field("city"), "Tartu");
    await leave(field("city"));
    await settle();
    expect(fetched.calls.at(-1)!.body).toEqual({ version: "s:v1", patch: { city: "Tartu" } });
    await click(radio("cancelled"));
    await settle();
    expect(actions.setSessionStatusAction).toHaveBeenLastCalledWith({ id: ID, status: "cancelled", version: "s:v2" });
    // the status moved the version on the server (s:v2c): the next field save goes from it, not as a conflict
    await type(field("venue"), "Teine saal");
    await leave(field("venue"));
    await settle();
    expect(fetched.calls.at(-1)!.body).toEqual({ version: "s:v2c", patch: { venue: "Teine saal" } });
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("a field typed just before the status: it is saved first, and the status goes from the version after it", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await type(field("venue"), "Uus saal");
    await click(radio("cancelled"));
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1", patch: { venue: "Uus saal" } }]);
    expect(actions.setSessionStatusAction).toHaveBeenCalledExactlyOnceWith({ id: ID, status: "cancelled", version: "s:v2" });
  });

  it("a field left while the status is on its way waits for it, then goes from the version the status left (the two never cross on the server)", async () => {
    let answer = () => {};
    actions.setSessionStatusAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => {
            current = `${current}c`;
            resolve({ ok: true, version: current });
          };
        }),
    );
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(radio("cancelled"));
    await settle();
    expect(actions.setSessionStatusAction).toHaveBeenCalledOnce();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saving");
    await type(field("venue"), "Teine saal");
    await leave(field("venue"));
    await settle();
    expect(fetched.calls).toEqual([]); // waiting for the status
    await act(async () => answer());
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "s:v1c", patch: { venue: "Teine saal" } }]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("an answer that comes after she moved into a field leaves the focus there (review M1); the line still says it", async () => {
    let answer: (r: unknown) => void = () => {};
    actions.setSessionStatusAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(radio("cancelled"));
    await settle();
    await act(async () => field("venue").focus());
    await act(async () => answer({ ok: false, error: "server" }));
    await settle();
    expect(text($("[data-status-line]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(radio("scheduled").checked).toBe(true);
    expect(document.activeElement).toBe(field("venue"));
  });

  it("a status answer later than SAVE_TIMEOUT_MS: „Salvestamine ei õnnestunud. …“, and when it comes stored the line goes and the stored status shows (review M2)", async () => {
    fakeClock();
    let answer: (r: unknown) => void = () => {};
    actions.setSessionStatusAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(radio("cancelled"));
    await wait(SAVE_TIMEOUT_MS + 100);
    await settle();
    expect(text($("[data-status-line]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(radio("scheduled").checked).toBe(true);
    await act(async () => answer({ ok: true, version: "s:v1c" }));
    await settle();
    expect(text($("[data-status-line]"))).toBe("");
    expect(radio("cancelled").checked).toBe(true);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("changed in another tab meanwhile: the chip says „Muudeti teises aknas — vaata üle“, the page is read again and the stored status stays chosen", async () => {
    actions.setSessionStatusAction.mockResolvedValue({ ok: false, error: "conflict", version: "s:other", value: { ...FIELDS, status: "scheduled" } });
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(radio("cancelled"));
    await settle();
    expect(chip()!.getAttribute("data-save-kind")).toBe("conflict");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Muudeti teises aknas — vaata üle");
    expect(router.refresh).toHaveBeenCalled();
    expect(radio("scheduled").checked).toBe(true);
  });

  it("a status the server could not save: „Salvestamine ei õnnestunud. Proovi uuesti.“ under the pills, the stored one chosen; the panel closes with the focus on it", async () => {
    actions.setSessionStatusAction.mockResolvedValue({ ok: false, error: "server" });
    await show();
    await click(radio("cancelled"));
    await click(buttonNamed("Jah, tühista"));
    await settle();
    expect(text($("[data-status-line]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(panel()).toBeNull();
    expect(radio("scheduled").checked).toBe(true);
    expect(document.activeElement).toBe(radio("scheduled"));
  });
});

describe("„Kustuta toimumine“ (README B3; P-7; R-b: every registration counts, cancelled ones too)", () => {
  it("without registrations: the button, then the ConfirmPanel „Kas kustutan selle toimumise?“ · „Seda ei saa tagasi võtta.“ · „Jah, kustuta“ / „Katkesta“", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    expect($("[data-delete-refusal]")).toBeNull();
    await click(buttonNamed("Kustuta toimumine"));
    const p = $("[data-session-delete] [data-confirm-panel]")!;
    expect(text(p.querySelector("p"))).toBe("Kas kustutan selle toimumise?");
    expect(Array.from(p.querySelectorAll("li")).map(text)).toEqual(["Seda ei saa tagasi võtta."]);
    expect(Array.from(p.querySelectorAll("button")).map(text)).toEqual(["Jah, kustuta", "Katkesta"]);
    await click(buttonNamed("Katkesta", p));
    expect($("[data-session-delete] [data-confirm-panel]")).toBeNull();
    expect(document.activeElement).toBe(buttonNamed("Kustuta toimumine"));
    await click(buttonNamed("Kustuta toimumine"));
    await click(buttonNamed("Jah, kustuta"));
    await settle();
    expect(actions.deleteSession).toHaveBeenCalledOnce();
    expect(Object.fromEntries((actions.deleteSession.mock.calls[0][1] as FormData).entries())).toEqual({ id: String(ID) });
  });

  it("with registrations (even cancelled ones only): no button, the text „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“", async () => {
    await show({ counts: { confirmed: 0, booked: 0, all: 1 } });
    expect(buttonNamed("Kustuta toimumine")).toBeNull();
    expect(text($("[data-delete-refusal]"))).toBe("Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.");
    await show();
    expect(buttonNamed("Kustuta toimumine")).toBeNull();
    expect(text($("[data-delete-refusal]"))).toBe("Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.");
  });

  it("someone registered meanwhile: the server's refusal says the same text", async () => {
    actions.deleteSession.mockResolvedValue({ ok: false, error: "inUse" });
    await show({ counts: { confirmed: 0, booked: 0, all: 0 } });
    await click(buttonNamed("Kustuta toimumine"));
    await click(buttonNamed("Jah, kustuta"));
    await settle();
    expect(text($("[data-session-delete] [role=alert]"))).toBe("Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.");
  });
});

describe("a new session (?id=uus; S3-P3-g): one explicit „Lisa toimumine“", () => {
  const line = () => $("[data-new-session-line]");

  it("the header says „Täida kohustuslikud väljad“ instead of a save status, then „Vajuta „Lisa toimumine“.“ once Koolitus, Kuupäev and Linn are filled; no status, no delete", async () => {
    await showNew();
    expect(text(line())).toBe("Täida kohustuslikud väljad");
    expect(line()!.getAttribute("role")).toBe("status");
    expect($("[data-save-status]")).toBeNull();
    expect(text($("[data-new-session] h2"))).toBe("Uus toimumine");
    expect($("[data-session-status]")).toBeNull();
    expect(buttonNamed("Kustuta toimumine")).toBeNull();
    // the pre-filled ones (S3-P3-g: Algus 10:00, Kohti 4, Keel ET) and the course's „—“
    expect(["courseId", "time", "capacity", "language"].map((n) => field(n).value)).toEqual(["", "10:00", "4", "ET"]);
    expect(labelOf(field("time"))).toBe("Algus (Eesti aeg)");
    await choose(select("courseId"), "3");
    await type(field("date"), "2027-03-13");
    expect(text(line())).toBe("Täida kohustuslikud väljad");
    await type(field("city"), "Pärnu");
    expect(text(line())).toBe("Vajuta „Lisa toimumine“.");
    expect(buttonNamed("Lisa toimumine")).not.toBeNull();
    expect(fetched.calls).toEqual([]); // nothing autosaves before the session exists
  });

  it("pressed with the required fields empty: each says what is missing, the first gets the focus, nothing is sent", async () => {
    await showNew();
    await type(field("time"), "");
    await click(buttonNamed("Lisa toimumine"));
    expect(actions.createSessionAction).not.toHaveBeenCalled();
    for (const [name, words] of [
      ["courseId", "Vali koolitus."],
      ["date", "Sisesta kuupäev."],
      ["time", "Sisesta kellaaeg, näiteks 10:00."],
      ["city", "Sisesta linn."],
    ]) {
      expect(field(name).getAttribute("aria-invalid"), name).toBe("true");
      expect(described(field(name)), name).toContain(words);
    }
    expect(document.activeElement).toBe(field("courseId"));
    // typed again, the field's words go
    await type(field("city"), "Pärnu");
    expect(field("city").getAttribute("aria-invalid")).toBeNull();
  });

  it("pressed: the session is created (always „Toimub“: no status is sent) and the drawer goes on at ?id=<n> on the same list, autosaving there", async () => {
    actions.createSessionAction.mockResolvedValue({ ok: true, id: 55, version: "s:new", savedAt: "2026-10-24T11:03:00.000Z" });
    await showNew();
    await choose(select("courseId"), "3");
    await type(field("date"), "2027-03-13");
    await type(field("city"), " Pärnu ");
    await type(field("venue"), "E2E saal");
    await click(buttonNamed("Lisa toimumine"));
    await settle();
    expect(actions.createSessionAction).toHaveBeenCalledExactlyOnceWith({ courseId: 3, date: "2027-03-13", time: "10:00", city: " Pärnu ", venue: "E2E saal", language: "ET", capacity: "4" });
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/admin/kalender?linn=P%C3%A4rnu&id=55&lisatud=55", { scroll: false });
    expect(localStorage.getItem("mslab-draft:toimumine:uus")).toBeNull();
  });

  it("a create the server refuses marks its fields with their words and focuses the first; a failure says „Salvestamine ei õnnestunud. Proovi uuesti.“", async () => {
    actions.createSessionAction.mockResolvedValue({ ok: false, error: "invalid", fields: { courseId: "course" } });
    await showNew();
    await choose(select("courseId"), "3");
    await type(field("date"), "2027-03-13");
    await type(field("city"), "Pärnu");
    await click(buttonNamed("Lisa toimumine"));
    await settle();
    expect(field("courseId").getAttribute("aria-invalid")).toBe("true");
    expect(described(field("courseId"))).toContain("Vali koolitus.");
    expect(document.activeElement).toBe(field("courseId"));
    expect(text($("[data-new-session-error]"))).toBe("Kontrolli märgitud välju.");
    actions.createSessionAction.mockResolvedValue({ ok: false, error: "server" });
    await choose(select("courseId"), "5");
    await click(buttonNamed("Lisa toimumine"));
    await settle();
    expect(text($("[data-new-session-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  it("while the create is on its way the fields are read-only and nothing typed is taken; a second press makes no second session (review M3, M4)", async () => {
    let answer: (r: unknown) => void = () => {};
    actions.createSessionAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await showNew();
    await choose(select("courseId"), "3");
    await type(field("date"), "2027-03-13");
    await type(field("city"), "Pärnu");
    await click(buttonNamed("Lisa toimumine"));
    expect(actions.createSessionAction).toHaveBeenCalledOnce();
    expect(field("city").readOnly).toBe(true);
    expect($("[data-session-form]")!.getAttribute("aria-busy")).toBe("true");
    expect(select("language").getAttribute("aria-disabled")).toBe("true");
    await type(field("city"), "Tartu");
    await choose(select("language"), "RU");
    expect(field("city").value).toBe("Pärnu");
    expect(select("language").value).toBe("ET");
    await click(buttonNamed("Lisa toimumine"));
    expect(actions.createSessionAction).toHaveBeenCalledOnce();
    // created: the drawer moves on to it; a press before it has is not another create
    await act(async () => answer({ ok: true, id: 55, version: "s:new", savedAt: "2026-10-24T11:03:00.000Z" }));
    await settle();
    expect(router.replace).toHaveBeenCalledOnce();
    await click(buttonNamed("Lisa toimumine"));
    await settle();
    expect(actions.createSessionAction).toHaveBeenCalledOnce();
  });

  it("a kept copy whose course is no longer a contact course comes back with „—“ and its other fields (review M5)", async () => {
    localStorage.setItem("mslab-draft:toimumine:uus", JSON.stringify({ courseId: 99, date: "2027-03-13", time: "10:00", city: "Viljandi", venue: "", language: "ET", capacity: "4" }));
    await showNew();
    await settle();
    expect(field("city").value).toBe("Viljandi");
    expect(select("courseId").value).toBe("");
    expect(text(select("courseId").options[0])).toBe("—");
    expect(text($("[data-new-session-line]"))).toBe("Täida kohustuslikud väljad");
  });

  it("leaving with typed text asks with the leave notice and the reason „Toimumist pole veel lisatud.“ (✕ too)", async () => {
    await showNew();
    await type(field("city"), "Pärnu");
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(dialog().open).toBe(true);
    expect(text($("[data-leave-title]"))).toBe("Muudatust „Linn“ ei saanud veel salvestada.");
    expect(text($("[data-leave-reason]"))).toBe("Toimumist pole veel lisatud.");
    await click(buttonNamed("Jää siia"));
    expect(document.activeElement).toBe(field("city"));
  });

  it("nothing typed: ✕ closes at once", async () => {
    await showNew();
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(dialog().open).toBe(false);
    expect($("[data-leave-notice]")).toBeNull();
  });

  it("what was typed stays in this browser („Sulge, tekst jääb seadmesse“) and comes back the next time the drawer opens", async () => {
    await showNew();
    await type(field("city"), "Viljandi");
    await choose(select("courseId"), "5");
    expect(JSON.parse(localStorage.getItem("mslab-draft:toimumine:uus")!)).toMatchObject({ city: "Viljandi", courseId: 5 });
    await act(async () => root.unmount());
    root = createRoot(container);
    await showNew();
    await settle();
    expect(field("city").value).toBe("Viljandi");
    expect(field("courseId").value).toBe("5");
  });
});

describe("the layout hooks", () => {
  it("the fields are in the drawer's pairs as Part 3 draws them: Kuupäev | Algus, Linn | Kohti", async () => {
    await show();
    const pairs = $$("[data-session-form] [data-pair]").map((p) => Array.from(p.querySelectorAll("input, select")).map((e) => e.getAttribute("name")));
    expect(pairs).toEqual([
      ["date", "time"],
      ["city", "capacity"],
    ]);
  });
});
