// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountCourseCard } from "@/components/account/AccountCourseCard";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts } from "@/components/account/texts";
import { contractOf, type AccountCard, type ContactCard, type EcourseCard, type IndividualCard } from "@/domain/account-cards";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The contract on the account's course cards (contracts Task 6; spec §4 Account) in a browser-like document (happy-dom):
// - a quiet line „Leping · kinnitatud {date}“ with „Laadi alla (PDF)“ (a link to /api/konto/leping/<id>; aria-disabled in the admin's read-only copy);
// - once Maria has asked (`contractRequested`), the card instead offers „Kinnita leping“, which opens the current filled text (GET
//   /api/konto/leping-tekst/<registration>?l=<page language>) with „Kinnitan“ (POST /api/konto/leping { registrationId, version, locale });
// - what the answers do: 200 → „Leping on kinnitatud.“ and the cards are loaded again; 409 version → the new text is read and shown with the
//   box's words „Lepingu tekst on vahepeal muutunud …“; 409 nothing (a second tap) → as accepted; 404/401 → the cards are loaded again; else a sentence;
// - an e-course card has the line only; an individual card has neither; in Russian; the lines are quiet (no filled button).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ navigate: vi.fn<(url: string) => void>() }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));

const NOW = "2026-10-18T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
const PAST = "2026-09-01T08:00:00.000Z";
const ACCEPTED = "2026-10-15T09:00:00.000Z";
const PAY = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false },
  status: "confirmed", paymentChoice: "half", priceCents: 35000, paidCents: 35000, createdAt: NOW, ...over,
});
const ecourse = (over: Partial<EcourseCard> = {}): EcourseCard => ({
  kind: "ecourse", course: { slug: "kulmud-e", title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" } }, grantedAt: NOW, expiresAt: "2027-04-09T10:00:00.000Z", revoked: false, ...over,
});
const dashboard = (cards: AccountCard[], over: Partial<Dashboard> = {}): Dashboard => ({
  client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
  cards, favourites: [], prepayment: null, resume: null, ...over,
});
/** The text the server gives for a card whose ask is open (GET /leping-tekst): filled, with the version the page sends back. */
const TEXT = { ok: true, title: "Kontaktkoolituse leping", body: "Õpilane Kati Kask registreerub.\n\nToimumine: 14.11.2026, Pärnu.", version: "v-1", locale: "et" };
const NEW_TEXT = { ok: true, title: "Uus leping", body: "Uus tekst.", version: "v-2", locale: "et" };
const asked = (registrationId = 7, over: Partial<ContactCard> = {}) => contact(registrationId, { contract: { id: 51, acceptedAt: ACCEPTED }, contractRequested: true, ...over });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (data: Dashboard, opts: { locale?: Locale; readOnly?: boolean } = {}) => {
  const locale = opts.locale ?? "et";
  await act(async () => root.render(createElement(CoursesTab, { locale, t: coursesTexts(getDict(locale)), data, readOnly: opts.readOnly ?? false, now: NOW })));
};
/** One card on its own, to see the callback it is given. */
const renderCard = async (card: AccountCard, extra: { onContract?: (card: ContactCard) => Promise<boolean>; locale?: Locale } = {}) => {
  const locale = extra.locale ?? "et";
  await act(async () =>
    root.render(
      createElement(AccountCourseCard, {
        card, now: new Date(NOW), locale, t: coursesTexts(getDict(locale)), pay: null, readOnly: false, sent: false, onChangeRequest: () => {}, onContract: extra.onContract,
      }),
    ),
  );
};
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const open = () => $("[data-card-contract-open]");
const accept = () => $("[data-card-contract-accept]");
const panelText = () => $("[data-contract-panel]")?.textContent;
const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`);
const posted = (n = 0) => JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")[n][1]?.body));

beforeEach(() => {
  fetchMock.mockReset();
  mocks.navigate.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the contract line", () => {
  test("„Leping · kinnitatud 15.10.2026“ with „Laadi alla (PDF)“: a link to /api/konto/leping/<id> that downloads", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED }, contractRequested: false })]));
    expect($("[data-card-contract]")?.getAttribute("data-card-contract")).toBe("line");
    expect($("[data-contract-line]")?.textContent).toBe("Leping · kinnitatud 15.10.2026");
    const link = $("a[data-card-contract-download]") as HTMLAnchorElement;
    expect([link.getAttribute("href"), link.hasAttribute("download"), link.textContent]).toEqual(["/api/konto/leping/51", true, "Laadi alla (PDF)"]);
    expect($("[data-card-contract-open]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the date is the Estonian day she accepted: a late evening in UTC is the next day in Tallinn", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: "2026-10-15T22:30:00.000Z" }, contractRequested: false })]));
    expect($("[data-contract-line]")?.textContent).toBe("Leping · kinnitatud 16.10.2026");
  });

  test("the download is named for a screen reader by its course, the visible words first", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED } }), ecourse({ contract: { id: 61, acceptedAt: ACCEPTED } })]));
    expect($$("a[data-card-contract-download]").map((a) => a.getAttribute("aria-label")).sort()).toEqual(["Laadi alla (PDF): Kulmude e-kursus", "Laadi alla (PDF): Kulmude lamineerimine"]);
  });

  test("a card with no contract has no contract block; nor has a card from before the field existed", async () => {
    await render(dashboard([contact(7, { contract: null, contractRequested: false }), contact(8)]));
    expect($("[data-card-contract]")).toBeNull();
  });

  test("an e-course card has the line and the download (a purchase's or the gate's contract); it never offers „Kinnita leping“", async () => {
    await render(dashboard([ecourse({ contract: { id: 61, acceptedAt: ACCEPTED }, contractRequested: false })]));
    expect($("[data-card='course-kulmud-e'] [data-contract-line]")?.textContent).toBe("Leping · kinnitatud 15.10.2026");
    expect($("[data-card='course-kulmud-e'] a[data-card-contract-download]")?.getAttribute("href")).toBe("/api/konto/leping/61");
    // (an e-course card that says "requested" is a card nobody builds: the line still shows, nothing to confirm)
    await render(dashboard([ecourse({ contract: { id: 61, acceptedAt: ACCEPTED }, contractRequested: true })]));
    expect($("[data-card-contract-open]")).toBeNull();
    expect($("[data-contract-line]")).not.toBeNull();
  });

  test("an over card (a past training, an ended access) still has its contract line: she may want the copy after the course", async () => {
    await render(dashboard([contact(7, { session: { startsAt: PAST, city: "Pärnu", venue: "", cancelled: false }, contract: { id: 51, acceptedAt: ACCEPTED } }), ecourse({ revoked: true, contract: { id: 61, acceptedAt: ACCEPTED } })]));
    expect($$("[data-contract-line]")).toHaveLength(2);
  });

  test("an individual course's card has no contract block", async () => {
    const individual: IndividualCard = { kind: "individual", registrationId: 9, course, status: "awaiting_prepayment", preferredPeriod: "märts", createdAt: NOW };
    await render(dashboard([individual]));
    expect($("[data-card-contract]")).toBeNull();
  });

  test("the line is quiet: no filled button, no extra main action", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED } })]));
    expect($$("[data-card-contract] button")).toEqual([]);
    expect($$("[data-card-contract] a").every((a) => !/btn/.test(a.className))).toBe(true);
  });

  test("several cards: each has its own contract's address", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED } }), contact(8, { contract: { id: 52, acceptedAt: ACCEPTED } })]));
    expect($$("[data-card='registration-7'] a[data-card-contract-download]").map((a) => a.getAttribute("href"))).toEqual(["/api/konto/leping/51"]);
    expect($$("[data-card='registration-8'] a[data-card-contract-download]").map((a) => a.getAttribute("href"))).toEqual(["/api/konto/leping/52"]);
  });

  test("the pure helper says the same: the contract and the ask of a contact or e-course card; nothing for the others", () => {
    expect(contractOf(asked())).toEqual({ contract: { id: 51, acceptedAt: ACCEPTED }, requested: true });
    expect(contractOf(contact(7))).toEqual({ contract: null, requested: false });
    expect(contractOf(ecourse({ contract: { id: 61, acceptedAt: ACCEPTED } }))).toEqual({ contract: { id: 61, acceptedAt: ACCEPTED }, requested: false });
    expect(contractOf({ kind: "individual", registrationId: 9, course, status: "awaiting_prepayment", preferredPeriod: "", createdAt: NOW })).toBeNull();
  });
});

describe("„Kinnita leping“ after Maria has asked", () => {
  test("the card offers „Kinnita leping“ instead of the line: no download, no text yet, nothing fetched", async () => {
    await render(dashboard([asked()]));
    expect($("[data-card-contract]")?.getAttribute("data-card-contract")).toBe("asked");
    expect(open()?.textContent).toBe("Kinnita leping");
    expect(open()?.getAttribute("aria-expanded")).toBe("false");
    expect($("[data-contract-asked]")?.textContent).toBe("Maria palub sul lepingu kinnitada.");
    expect($("[data-contract-line]")).toBeNull();
    expect($("a[data-card-contract-download]")).toBeNull();
    expect($("[data-contract-panel]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("it works with no contract yet (a registration that had none): the same „Kinnita leping“", async () => {
    await render(dashboard([asked(7, { contract: null })]));
    expect(open()?.textContent).toBe("Kinnita leping");
  });

  test("opening reads the filled text for the page's language and shows its title and paragraphs, with „Kinnitan“", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT));
    await render(dashboard([asked()]));
    await click(open());
    expect(calls()).toEqual(["GET /api/konto/leping-tekst/7?l=et"]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
    expect(open()?.getAttribute("aria-expanded")).toBe("true");
    expect($$("[data-contract-panel] p").map((p) => p.textContent)).toEqual(["Kontaktkoolituse leping", "Õpilane Kati Kask registreerub.", "Toimumine: 14.11.2026, Pärnu."]);
    expect(open()?.getAttribute("aria-controls")).toBe($("[data-contract-panel]")?.id);
    expect($("[data-contract-panel]")?.getAttribute("role")).toBe("region");
    expect($("[data-contract-panel]")?.getAttribute("lang")).toBe("et");
    expect(accept()?.textContent).toBe("Kinnitan");
    expect(calls()).toHaveLength(1);
  });

  test("it closes again with „Peida leping“ and opens again without reading the text again", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT));
    await render(dashboard([asked()]));
    await click(open());
    expect(open()?.textContent).toBe("Peida leping");
    await click(open());
    expect($("[data-contract-panel]")).toBeNull();
    expect(open()?.textContent).toBe("Kinnita leping");
    await click(open());
    expect(panelText()).toContain("Õpilane Kati Kask registreerub.");
    expect(calls()).toHaveLength(1);
  });

  test("while the text is read: „Laadin lepingut…“ and no „Kinnitan“", async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    await render(dashboard([asked()]));
    await click(open());
    expect(panelText()).toContain("Laadin lepingut…");
    expect(accept()).toBeNull();
    await act(async () => answer(json(200, TEXT)));
    await settle();
    expect(panelText()).not.toContain("Laadin lepingut…");
    expect(accept()).not.toBeNull();
  });

  test("a text that cannot be read says so and can be tried again (close, open); there is no „Kinnitan“ without a text", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(json(200, TEXT));
    await render(dashboard([asked()]));
    await click(open());
    expect($("[data-contract-panel]")?.textContent).toContain("Lepingut ei õnnestunud laadida. Proovi uuesti.");
    expect(accept()).toBeNull();
    await click(open());
    await click(open());
    expect(accept()).not.toBeNull();
    expect(calls()).toHaveLength(2);
  });

  test("„Kinnitan“ posts { registrationId, version, locale }; the answer 200 reads „Leping on kinnitatud.“, the text and the buttons are gone, and the cards are loaded again", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(200, { ok: true }));
    const onContract = vi.fn<(card: ContactCard) => Promise<boolean>>(async () => true);
    await renderCard(asked(), { onContract });
    await click(open());
    await click(accept());
    expect(calls()).toEqual(["GET /api/konto/leping-tekst/7?l=et", "POST /api/konto/leping"]);
    expect(posted()).toEqual({ registrationId: 7, version: "v-1", locale: "et" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: "same-origin" });
    expect($("[data-contract-done]")?.textContent).toBe("Leping on kinnitatud.");
    expect(document.activeElement).toBe($("[data-contract-done]"));
    expect(open()).toBeNull();
    expect(accept()).toBeNull();
    expect($("[data-contract-panel]")).toBeNull();
    expect(onContract).toHaveBeenCalledTimes(1);
    expect(onContract.mock.calls[0][0]).toMatchObject({ kind: "contact", registrationId: 7 });
  });

  test("when the cards are loaded again the card shows the line with the new contract's date, not „Kinnita leping“", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(200, { ok: true }));
    await render(dashboard([asked()]));
    await click(open());
    await click(accept());
    await render(dashboard([contact(7, { contract: { id: 53, acceptedAt: NOW }, contractRequested: false })]));
    expect($("[data-contract-line]")?.textContent).toBe("Leping · kinnitatud 18.10.2026");
    expect($("a[data-card-contract-download]")?.getAttribute("href")).toBe("/api/konto/leping/53");
    expect($("[data-card-contract-open]")).toBeNull();
    expect($("[data-contract-done]")).toBeNull();
  });

  test("one request at a time: two quick presses on „Kinnitan“ post once", async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    await render(dashboard([asked()]));
    await click(open());
    const button = accept()!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => answer(json(200, { ok: true })));
    await settle();
    expect(calls().filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  test("409 version (Maria saved a new text meanwhile): the new text is read and shown with the box's words, the old text is gone, and the next „Kinnitan“ sends the new version", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, TEXT))
      .mockResolvedValueOnce(json(409, { ok: false, error: "version" }))
      .mockResolvedValueOnce(json(200, NEW_TEXT))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await render(dashboard([asked()]));
    await click(open());
    await click(accept());
    expect(calls()).toEqual(["GET /api/konto/leping-tekst/7?l=et", "POST /api/konto/leping", "GET /api/konto/leping-tekst/7?l=et"]);
    expect($("[data-contract-notice]")?.textContent).toBe("Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.");
    expect($("[data-contract-notice]")?.getAttribute("role")).toBe("alert");
    expect(panelText()).toContain("Uus tekst.");
    expect(panelText()).not.toContain("Õpilane Kati Kask");
    expect($("[data-contract-done]")).toBeNull();
    await click(accept());
    expect(posted(1)).toEqual({ registrationId: 7, version: "v-2", locale: "et" });
    expect($("[data-contract-done]")).not.toBeNull();
    expect($("[data-contract-notice]")).toBeNull();
  });

  test("409 nothing (a second tap, or another device accepted): it is accepted — „Leping on kinnitatud.“ and the cards are loaded again", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(409, { ok: false, error: "nothing" }));
    const onContract = vi.fn(async () => true);
    await renderCard(asked(), { onContract });
    await click(open());
    await click(accept());
    expect($("[data-contract-done]")?.textContent).toBe("Leping on kinnitatud.");
    expect(onContract).toHaveBeenCalledTimes(1);
  });

  test("404 (the registration is cancelled or not hers any more): the cards are loaded again; with no answer to that, a plain sentence", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(404, { ok: false, error: "registration" }));
    const onContract = vi.fn(async () => true);
    await renderCard(asked(), { onContract });
    await click(open());
    await click(accept());
    expect(onContract).toHaveBeenCalledTimes(1);
    expect($("[data-contract-error]")).toBeNull();
    expect($("[data-contract-done]")).toBeNull();
    // the load found nothing new (no answer): the sentence
    fetchMock.mockResolvedValueOnce(json(404, { ok: false, error: "registration" }));
    onContract.mockResolvedValue(false);
    await click(accept());
    expect($("[data-contract-error]")?.textContent).toBe(et.forms.errorGeneric);
  });

  test("the text read as 404 (the ask is gone) loads the cards again too, and says nothing when they answer", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { ok: false }));
    const onContract = vi.fn(async () => true);
    await renderCard(asked(), { onContract });
    await click(open());
    expect(onContract).toHaveBeenCalledTimes(1);
    expect($("[data-contract-panel]")?.textContent ?? "").not.toContain("õnnestunud");
  });

  test("429 and any other failure: a sentence under the text, the text stays, and „Kinnitan“ can be pressed again", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(429, { ok: false, error: "rate" })).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(json(500, { ok: false, error: "server" }));
    await render(dashboard([asked()]));
    await click(open());
    await click(accept());
    expect($("[data-contract-error]")?.textContent).toBe(et.forms.errorTooMany);
    expect(accept()?.getAttribute("aria-disabled")).toBeNull();
    await click(accept());
    expect($("[data-contract-error]")?.textContent).toBe(et.forms.errorGeneric);
    await click(accept());
    expect($("[data-contract-error]")?.textContent).toBe(et.forms.errorGeneric);
    expect(panelText()).toContain("Õpilane Kati Kask registreerub.");
    expect(calls().filter((c) => c.startsWith("POST"))).toHaveLength(3);
  });

  test("with no cards to load again (the page cannot reload) the done sentence stays, so she knows", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(200, { ok: true }));
    await render(dashboard([asked()]));
    await click(open());
    await click(accept());
    expect($("[data-contract-done]")?.textContent).toBe("Leping on kinnitatud.");
  });

  test("the lines around it are quiet: „Kinnita leping“ is a text button, not a filled one; the card keeps its own one main button", async () => {
    await render(dashboard([asked(7, { status: "awaiting_prepayment", paidCents: 0 })], { prepayment: PAY }));
    expect(open()?.className).not.toMatch(/btn/);
    expect($$("[data-card-action]").map((b) => b.getAttribute("data-card-action"))).toEqual(["pay"]);
  });
});

describe("read-only (the admin's view as the client)", () => {
  test("the line and its download are there, the download aria-disabled with no address", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED } })]), { readOnly: true });
    const link = $("a[data-card-contract-download]")!;
    expect([link.getAttribute("aria-disabled"), link.getAttribute("role"), link.hasAttribute("href"), link.hasAttribute("download")]).toEqual(["true", "link", false, false]);
    expect($("[data-contract-line]")?.textContent).toBe("Leping · kinnitatud 15.10.2026");
  });

  test("„Kinnita leping“ is there but aria-disabled and does nothing: nothing is fetched or opened", async () => {
    await render(dashboard([asked()]), { readOnly: true });
    expect(open()?.getAttribute("aria-disabled")).toBe("true");
    await click(open());
    expect($("[data-contract-panel]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("in Russian", () => {
  test("the line, the download and the aria-label read in Russian; the date is the same Estonian day", async () => {
    await render(dashboard([contact(7, { contract: { id: 51, acceptedAt: ACCEPTED } })]), { locale: "ru" });
    expect($("[data-contract-line]")?.textContent).toBe("Договор · подтверждён 15.10.2026");
    const link = $("a[data-card-contract-download]")!;
    expect([link.textContent, link.getAttribute("aria-label")]).toEqual(["Скачать (PDF)", "Скачать (PDF): Ламинирование бровей"]);
  });

  test("„Подтвердить договор“ reads the text for the Russian page, shows it in the language it is in, and „Подтверждаю“ posts the page's language", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...TEXT, title: "Договор очного обучения", body: "Ученик Kati Kask записывается.", locale: "ru" })).mockResolvedValueOnce(json(200, { ok: true }));
    await render(dashboard([asked()]), { locale: "ru" });
    expect(open()?.textContent).toBe("Подтвердить договор");
    expect($("[data-contract-asked]")?.textContent).toBe("Мария просит вас подтвердить договор.");
    await click(open());
    expect(calls()[0]).toBe("GET /api/konto/leping-tekst/7?l=ru");
    expect(open()?.textContent).toBe("Скрыть договор");
    expect($("[data-contract-panel]")?.getAttribute("lang")).toBe("ru");
    expect(accept()?.textContent).toBe("Подтверждаю");
    await click(accept());
    expect(posted()).toEqual({ registrationId: 7, version: "v-1", locale: "ru" });
    expect($("[data-contract-done]")?.textContent).toBe("Договор подтверждён.");
  });

  test("a Russian page that was given the Estonian text (no Russian one exists) marks the text as Estonian for a screen reader", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT));
    await render(dashboard([asked()]), { locale: "ru" });
    await click(open());
    expect($("[data-contract-panel]")?.getAttribute("lang")).toBe("et");
  });

  test("the version notice and the failures are the forms' own Russian words", async () => {
    fetchMock.mockResolvedValueOnce(json(200, TEXT)).mockResolvedValueOnce(json(409, { ok: false, error: "version" })).mockResolvedValueOnce(json(200, NEW_TEXT)).mockResolvedValueOnce(json(429, { ok: false }));
    await render(dashboard([asked()]), { locale: "ru" });
    await click(open());
    await click(accept());
    expect($("[data-contract-notice]")?.textContent).toBe(ru.forms.contractChanged);
    await click(accept());
    expect($("[data-contract-error]")?.textContent).toBe(ru.forms.errorTooMany);
  });
});

describe("the texts", () => {
  const strings = (value: unknown, path: string): [string, string][] =>
    typeof value === "string" ? [[path, value]] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, `${path}.${k}`));

  test("both dictionaries hold the same keys and the same {placeholders}", () => {
    expect(Object.keys(ru.account.contract).sort()).toEqual(Object.keys(et.account.contract).sort());
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(et.account.contract) as (keyof typeof et.account.contract)[]) expect(vars(ru.account.contract[key]), key).toEqual(vars(et.account.contract[key]));
  });

  test("the spec's quoted words, as quoted", () => {
    expect([et.account.contract.line, et.account.contract.download, et.account.contract.open, et.account.contract.accept]).toEqual(["Leping · kinnitatud {date}", "Laadi alla (PDF)", "Kinnita leping", "Kinnitan"]);
  });

  test("Russian typography: no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = strings(ru.account.contract, "contract");
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });

  test("no tool's name in a text a student reads", () => {
    for (const dict of [et, ru]) for (const [key, text] of strings(dict.account.contract, "contract")) expect(text, key).not.toMatch(/claude|anthropic|\bAI\b|chatgpt|gemini/i);
  });
});
