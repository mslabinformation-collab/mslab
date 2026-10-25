// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import { stubFetch } from "../fakes";

// Seaded (admin UX pass piece 3b, Task 4; README B4, the Part 3 frame „B4 Seaded“ and the Part 4 phone frame; rulings R-f, „Cards that move“) in a
// browser-like document (happy-dom): one page with the section map Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs
// (and below 1180 px its „Jaotised ▾“ select); the old anchors #arve, #ettemaks and #jarelmaks lead to „Maksmine“, #tunnistus and #lepingud to their
// sections; every card autosaves under the one SaveStatus of the header — no page „Salvesta“ and no card button, save the legal texts' own (their
// save path stays until their drafts, Task 5's: the pre-flight ruling). The page lead is gone (piece3-texts §4).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));
const site = vi.hoisted(() => ({ saveSettings: vi.fn() }));
vi.mock("@/server/actions/admin-site", () => site);
const contracts = vi.hoisted(() => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => contracts);

import { SettingsEditor } from "@/components/admin/SettingsEditor";

const PAGE = { title: { et: "Privaatsus" }, body: { et: "Tekst." } };
const PROPS: Parameters<typeof SettingsEditor>[0] = {
  initial: {
    values: {
      contact: { email: "info@example.test", phone: "", address: "Pärnu", instagram: "", facebook: "" },
      newsletter: { discountLabel: "10%", welcomeCode: "" },
      prepayment: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" },
      privacy: PAGE,
      terms: { title: { et: "Õppetingimused" }, body: { et: "Tekst." } },
      course_terms: { title: { et: "E-koolituse leping" }, body: { et: "Tekst." } },
    },
    versions: { contact: "k1", newsletter: "n1", prepayment: "p1", privacy: "x1", terms: "x2", course_terms: "x3" },
  },
  admins: ["maria@example.test"],
  invoice: { company: "MS LAB OÜ", registryCode: "16346048", address: "Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 7, termDays: 7, footer: "", last: null, version: "i:a.b" },
  certificate: { place: "Pärnu linn", registryCode: "16346048", practicalLine: "Praktiline töö", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 93, last: null, version: "c:a.b" },
  financing: { enabled: false, version: "f1" },
  contract: { title: { et: "", ru: "" }, body: { et: "", ru: "" } },
  now: new Date("2026-10-25T09:00:00Z"),
};

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
let refuse: Record<string, Record<string, string>>;
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  const part = /^\/api\/admin\/seaded\/(\w+)$/.exec(url)?.[1];
  if (!part) return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string };
  if (refuse[part]) return Response.json({ ok: false, error: "invalid", fields: refuse[part] }, { status: 400 });
  return Response.json({ ok: true, version: `${body.version}+`, savedAt: "2026-10-25T08:20:00.000Z" });
};

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const show = async () => {
  await act(async () => root.render(createElement(SettingsEditor, PROPS)));
  await settle();
};
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const leave = (el: Element) => act(async () => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
/** The header's one chip (SaveStatus), and how many chips the page has. */
const chip = () => $("[data-seaded-head] [data-save-status]");
const contactField = (name: string) => $<HTMLInputElement>(`[data-seaded-section] [data-field="contact.${name}"]`)!;

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
  refuse = {};
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.useRealTimers();
});

describe("the page (README B4; the Part 3 and Part 4 frames)", () => {
  test("the header: „Seaded“ over the H1 „Seaded“, no lead; the one SaveStatus beside the language switch", async () => {
    await show();
    const head = $("[data-seaded-head]")!;
    expect(text(head.querySelector("h1"))).toBe("Seaded");
    expect(text(head)).not.toContain("Kontaktandmed, sotsiaalmeedia lingid");
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect($$("[data-save-status][data-save-kind]")).toHaveLength(1);
  });

  test("the section map: the six sections in order, each a link to its section; the same six in the „Jaotised“ select", async () => {
    await show();
    const links = $$<HTMLAnchorElement>("nav a");
    expect(links.map((a) => [text(a.querySelector("[data-section-label]")), a.getAttribute("href")])).toEqual([
      ["Kontakt", "#kontakt"],
      ["Uudiskiri", "#uudiskiri"],
      ["Maksmine", "#maksmine"],
      ["Tunnistus", "#tunnistus"],
      ["Lepingud ja tingimused", "#lepingud"],
      ["Halduse ligipääs", "#ligipaas"],
    ]);
    expect($$<HTMLOptionElement>("[data-section-select] option").map((o) => o.value)).toEqual(["kontakt", "uudiskiri", "maksmine", "tunnistus", "lepingud", "ligipaas"]);
    // each entry's section is on the page, in the map's order
    const sections = $$("[data-seaded-section]").map((s) => s.id);
    expect(sections).toEqual(["kontakt", "uudiskiri", "maksmine", "tunnistus", "lepingud", "ligipaas"]);
  });

  test("the old anchors are aliases: #arve, #ettemaks and #jarelmaks at the start of „Maksmine“, #tunnistus and #lepingud the sections themselves; each id once", async () => {
    await show();
    const sectionOf = (anchor: string) => document.getElementById(anchor)?.closest("[data-seaded-section]")?.id ?? null;
    expect(Object.fromEntries(["arve", "ettemaks", "jarelmaks", "tunnistus", "lepingud"].map((a) => [a, sectionOf(a)]))).toEqual({
      arve: "maksmine",
      ettemaks: "maksmine",
      jarelmaks: "maksmine",
      tunnistus: "tunnistus",
      lepingud: "lepingud",
    });
    const maksmine = document.getElementById("maksmine")!;
    // (before the section's first card: a jump lands at the section's top)
    for (const alias of ["arve", "ettemaks", "jarelmaks"]) {
      const anchor = document.getElementById(alias)!;
      const firstCard = maksmine.querySelector("section")!;
      expect(anchor.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING, alias).toBeTruthy();
    }
    const ids = $$("[id]").map((el) => el.id);
    for (const id of ["kontakt", "uudiskiri", "maksmine", "tunnistus", "lepingud", "ligipaas", "arve", "ettemaks", "jarelmaks"]) expect(ids.filter((x) => x === id), id).toHaveLength(1);
  });

  test("what each section holds: Maksmine the merged card and „Järelmaks (Inbank)“; Lepingud ja tingimused the four legal texts; the admin addresses read-only", async () => {
    await show();
    const titles = (id: string) => Array.from(document.getElementById(id)!.querySelectorAll("h2")).map(text);
    expect(titles("kontakt")).toEqual(["Kontaktandmed"]);
    expect(titles("uudiskiri")).toEqual(["Uudiskiri"]);
    expect(titles("maksmine")).toEqual(["Maksmine", "Järelmaks (Inbank)"]);
    expect(titles("tunnistus")).toEqual(["Tunnistus"]);
    expect(titles("lepingud")).toEqual(["Privaatsus", "Õppetingimused", "E-koolituse leping (tingimused)", "Lepingud"]);
    expect(titles("ligipaas")).toEqual(["Halduse ligipääs"]);
    expect(Array.from(document.querySelectorAll("#ligipaas li")).map(text)).toEqual(["maria@example.test"]);
    expect(document.querySelector("#ligipaas input")).toBeNull();
  });

  test("no „Salvesta“ outside „Lepingud ja tingimused“: the legal texts keep their own save until their drafts (Task 5)", async () => {
    await show();
    const saves = $$<HTMLButtonElement>("button").filter((b) => /Salvesta/.test(text(b)));
    expect(saves.map(text).sort()).toEqual(["Salvesta", "Salvesta lepingud"]);
    for (const b of saves) expect(b.closest("[data-seaded-section]")!.id).toBe("lepingud");
    expect(document.querySelector("#lepingud [data-save-bar]")).not.toBeNull();
  });
});

describe("one status for every card", () => {
  test("a contact field autosaves on its part (after the typing, at once when left); the chip says so", async () => {
    await show();
    await type(contactField("phone"), "+372 5555 0101");
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([["/api/admin/seaded/contact", { version: "k1", patch: { phone: "+372 5555 0101" } }]]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    await type($<HTMLInputElement>('[data-field="newsletter.welcomeCode"]')!, "TERE");
    await leave($<HTMLInputElement>('[data-field="newsletter.welcomeCode"]')!);
    await settle();
    expect(fetched.calls.at(-1)).toMatchObject({ url: "/api/admin/seaded/newsletter", body: { version: "n1", patch: { welcomeCode: "TERE" } } });
  });

  test("a field one card's route refuses is marked in its own words; the one chip says „kontrolli“ with „Näita“, which goes to it", async () => {
    refuse.contact = { email: "email" };
    await show();
    await type(contactField("email"), "info@");
    await leave(contactField("email"));
    await settle();
    expect(contactField("email").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Sisesta korrektne e-posti aadress.");
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    contactField("phone").focus();
    await act(async () => chip()!.querySelector("button")!.click());
    expect(document.activeElement).toBe(contactField("email"));
  });

  test("the financing switch is one of the page's saves: ticked, it goes at once, under the same chip", async () => {
    await show();
    await act(async () => $<HTMLInputElement>("[data-financing-enabled]")!.click());
    await settle();
    expect(fetched.calls.at(-1)).toMatchObject({ url: "/api/admin/seaded/financing", body: { version: "f1", patch: { enabled: true } } });
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });
});
