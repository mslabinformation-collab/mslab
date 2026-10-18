// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { FeedbackForm } from "@/components/account/FeedbackForm";
import { coursesTexts, feedbackTexts } from "@/components/account/texts";
import type { AccountCard, ContactCard, EcourseCard, IndividualCard } from "@/domain/account-cards";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The student's side of the reviews in a browser-like document (student reviews, Task 3; spec D1, D3, D6):
// - the feedback form's tick under the recommend question (off and disabled while that answer is empty), the name it shows (prefilled, 40 at most,
//   a counter), what is sent (`consent: { name }`, or null when unticked, the typed name kept), the refusals;
// - the e-course's form by `#kursus=<slug>` and its card on the dashboard;
// - the course card's line „Lubasid oma soovitust avaldada“ with „Võta luba tagasi“ (a contact card's and an e-course's), its answers, and the
//   admin's read-only copy; an individual-course card has the same line (the final review's I1, ruling R10).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-18T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
const PAST = "2026-09-01T08:00:00.000Z";
const CONTACT = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const ECOURSE = { slug: "kulmud-e", title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" } };
const RECOMMEND = "Soovitaksin kindlasti, õppisin palju.";

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
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** Types into a textarea or an input the way a browser does (React listens to the native setter's input event). */
const type = async (el: HTMLElement | null, text: string) => {
  expect(el).not.toBeNull();
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);
const gets = (path: string) => fetchMock.mock.calls.filter(([input, init]) => init?.method !== "POST" && String(input) === path).length;

beforeEach(() => {
  fetchMock.mockReset();
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

describe("the form's tick and the name it shows", () => {
  /** The form of a registration (`#id=42`) or an e-course (`#kursus=…`); the GET answers with the course, nothing sent yet and the offered name. */
  const form = async (over: { locale?: Locale; hash?: string; shownName?: string; course?: typeof CONTACT } = {}) => {
    const locale = over.locale ?? "et";
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: over.course ?? CONTACT, sent: false, shownName: over.shownName ?? "Kati K." })));
    window.history.replaceState(null, "", `${locale === "ru" ? "/ru" : ""}/konto/tagasiside${over.hash ?? "#id=42"}`);
    await act(async () => root.render(createElement(FeedbackForm, { locale, t: feedbackTexts(getDict(locale)) })));
    await settle();
  };
  const answer = (text: string) => type($("[data-question='recommend'] textarea"), text);
  const tick = () => $("[data-consent-tick]") as HTMLInputElement;
  const nameField = () => $("[data-consent-name]") as HTMLInputElement | null;

  test("the tick is right under the recommend question and off and disabled while that answer is empty or only white space", async () => {
    await form();
    expect($("[data-question='recommend']")!.nextElementSibling).toBe($("[data-consent]"));
    expect($("[data-consent]")!.textContent).toContain("Luban seda vastust avaldada MS LAB kodulehel — selle koolituse lehel ja avalehel.");
    expect(tick().type).toBe("checkbox");
    expect(tick().checked).toBe(false);
    expect(tick().disabled).toBe(true);
    expect(nameField()).toBeNull();
    await answer("   \n ");
    expect(tick().disabled).toBe(true);
    await answer(RECOMMEND);
    expect(tick().disabled).toBe(false);
    await answer("");
    expect(tick().disabled).toBe(true);
  });

  test("ticking shows „Nimi, mida näidatakse“ prefilled with the offered name, 40 characters at most, with a counter that follows what she types", async () => {
    await form();
    await answer(RECOMMEND);
    await click(tick());
    expect(tick().checked).toBe(true);
    const label = $("[data-consent-name-field] label")!;
    expect(label.textContent).toBe("Nimi, mida näidatakse");
    expect(nameField()!.id).toBe(label.getAttribute("for"));
    expect(nameField()!.value).toBe("Kati K.");
    expect(nameField()!.maxLength).toBe(40);
    expect($("[data-consent-name-field]")!.textContent).toContain("7 / 40");
    await type(nameField(), "Kati Kask");
    expect($("[data-consent-name-field]")!.textContent).toContain("9 / 40");
  });

  test("ticked: the answers go with { name }; the name is sent as she typed it, its white space collapsed", async () => {
    await form();
    await answer(RECOMMEND);
    await click($("[data-question='score'] input[value='9']"));
    await click(tick());
    await type(nameField(), "  Kati   Kask ");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { score: 9, recommend: RECOMMEND }, consent: { name: "Kati Kask" } }]]);
    expect($("[data-feedback-done='done']")).not.toBeNull();
  });

  test("not ticked: consent is null, whatever the name field held; unticking keeps the typed name and sends null; ticking again shows the typed name", async () => {
    await form();
    await answer(RECOMMEND);
    await click(tick());
    await type(nameField(), "Anu A.");
    await click(tick());
    expect(tick().checked).toBe(false);
    expect(nameField()).toBeNull();
    await click(tick());
    expect(nameField()!.value).toBe("Anu A."); // the typed name is kept, not the offered one
    await click(tick());
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { recommend: RECOMMEND }, consent: null }]]);
  });

  test("no tick at all: consent null (an answer given without the tick never becomes a review)", async () => {
    await form();
    await click($("[data-question='score'] input[value='7']"));
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { score: 7 }, consent: null }]]);
  });

  test("the answer emptied after ticking takes the tick back: it is off and disabled, and typing again does not tick it for her", async () => {
    await form();
    await answer(RECOMMEND);
    await click(tick());
    await answer("");
    expect(tick().checked).toBe(false);
    expect(tick().disabled).toBe(true);
    expect(nameField()).toBeNull();
    await answer("Teine vastus.");
    expect(tick().checked).toBe(false);
    expect(tick().disabled).toBe(false);
    await click($("[data-feedback-submit]"));
    expect(posts()[0][1]).toMatchObject({ answers: { recommend: "Teine vastus." }, consent: null });
  });

  test("an empty name stops the send before any request, says so under the field and puts the focus in it; a name sends it", async () => {
    await form({ shownName: "" });
    await answer(RECOMMEND);
    await click(tick());
    expect(nameField()!.value).toBe("");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([]);
    expect($("[data-consent-error]")!.textContent).toBe("Kirjuta nimi, mida näidata (kuni 40 tähemärki).");
    expect(nameField()!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(nameField());
    await type(nameField(), "   ");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([]);
    await type(nameField(), "Kati K.");
    expect($("[data-consent-error]")).toBeNull(); // a name typed takes the line away
    await click($("[data-feedback-submit]"));
    expect(posts()[0][1]).toMatchObject({ consent: { name: "Kati K." } });
  });

  test("the name field's error is announced on the field (the final review): while the line is set the field is described by it and by its counter, and by the counter alone after", async () => {
    await form({ shownName: "" });
    await answer(RECOMMEND);
    await click(tick());
    const counterId = $("[data-consent-name-field] p")!.id;
    expect(counterId).not.toBe("");
    expect(nameField()!.getAttribute("aria-describedby")).toBe(counterId); // no error yet: the counter only
    await click($("[data-feedback-submit]"));
    const errorId = $("[data-consent-error]")!.id;
    expect(errorId).not.toBe("");
    expect(nameField()!.getAttribute("aria-describedby")!.split(" ").sort()).toEqual([counterId, errorId].sort());
    expect(document.getElementById(errorId)).toBe($("[data-consent-error]")); // the id names the line that is on the page
    await type(nameField(), "Kati K."); // a name typed takes the line away, and the reference with it
    expect($("[data-consent-error]")).toBeNull();
    expect(nameField()!.getAttribute("aria-describedby")).toBe(counterId);
  });

  test.each([
    ["consentName", "Kirjuta nimi, mida näidata (kuni 40 tähemärki)."],
    ["consentText", "Loa andmiseks kirjuta vastus küsimusele „Kas soovitaksid seda koolitust ka teistele? Miks?“."],
  ])("the server's 400 %s: its line under the tick, the answers kept, the form still there and sendable again", async (error, line) => {
    await form();
    await answer(RECOMMEND);
    await click(tick());
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(400, { ok: false, error }) : json(200, { ok: true, course: CONTACT, sent: false, shownName: "Kati K." })));
    await click($("[data-feedback-submit]"));
    expect($("[data-consent-error]")!.textContent).toBe(line);
    expect($("[data-feedback-error]")).toBeNull();
    expect($("[data-feedback-form]")).not.toBeNull();
    expect(($("[data-question='recommend'] textarea") as HTMLTextAreaElement).value).toBe(RECOMMEND);
    expect(tick().checked).toBe(true);
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, {})));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-done='done']")).not.toBeNull();
  });

  test("Russian: the tick, the name field and the line in Russian", async () => {
    await form({ locale: "ru" });
    await answer("Рекомендую всем.");
    await click(tick());
    expect($("[data-consent]")!.textContent).toContain("Разрешаю опубликовать этот ответ");
    expect($("[data-consent-name-field] label")!.textContent).toBe("Имя, которое будет показано");
    await type(nameField(), "");
    await click($("[data-feedback-submit]"));
    expect($("[data-consent-error]")!.textContent).toContain("40");
    await type(nameField(), "Катя К.");
    await click($("[data-feedback-submit]"));
    expect(posts()[0][1]).toEqual({ id: 42, locale: "ru", answers: { recommend: "Рекомендую всем." }, consent: { name: "Катя К." } });
  });

  test("an e-course: #kursus=<slug> asks GET ?kursus= and posts { kursus }, with the tick the same way; the name offered is the account's", async () => {
    await form({ hash: "#kursus=kulmud-e", course: ECOURSE, shownName: "Liis L." });
    expect(gets("/api/konto/tagasiside?kursus=kulmud-e")).toBe(1);
    expect(container.textContent).toContain("Kulmude e-kursus");
    await answer(RECOMMEND);
    await click(tick());
    expect(nameField()!.value).toBe("Liis L.");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { kursus: "kulmud-e", locale: "et", answers: { recommend: RECOMMEND }, consent: { name: "Liis L." } }]]);
  });

  test("an address that names no form, or two, or a slug that is none, asks nothing and says the form is not open", async () => {
    for (const hash of ["", "#kursus=", "#kursus=Not%20A%20Slug", "#kursus=x_y", "#id=abc", "#id=42&kursus=kulmud-e", "#viga=1"]) {
      fetchMock.mockReset();
      window.history.replaceState(null, "", `/konto/tagasiside${hash}`);
      await act(async () => root.render(createElement(FeedbackForm, { locale: "et", t: feedbackTexts(getDict("et")) })));
      await settle();
      expect(fetchMock, hash).not.toHaveBeenCalled();
      expect($("[data-account-state='feedbackClosed']")?.textContent, hash).toContain("Sellele koolitusele ei saa praegu tagasisidet anda.");
      await act(async () => root.render(createElement("div")));
    }
  });
});

describe("the dashboard's feedback cards", () => {
  const dashboard = (cards: AccountCard[], over: Partial<Dashboard> = {}): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards, favourites: [], prepayment: null, resume: null, ...over,
  });
  const render = async (data: Dashboard, readOnly = false, locale: Locale = "et") =>
    act(async () => root.render(createElement(CoursesTab, { locale, t: coursesTexts(getDict(locale)), data, readOnly, now: NOW })));
  const prompts: Dashboard["feedback"] = [
    { target: { courseSlug: "kulmud-e" }, course: ECOURSE },
    { target: { registrationId: 7 }, course: CONTACT },
  ];

  test("an e-course's card: its course, the e-course tag, 'Jäta tagasiside' to #kursus=<slug>; next to a contact course's, which keeps #id=", async () => {
    await render(dashboard([ecourseCard()], { feedback: prompts }));
    const cards = $$("[data-feedback-card]");
    expect(cards.map((c) => c.getAttribute("data-feedback-card"))).toEqual(["course-kulmud-e", "registration-7"]);
    expect(cards[0].textContent).toContain("Kulmude e-kursus");
    expect(cards[0].textContent).toContain("E-õpe");
    expect(cards[0].textContent).toContain("Kuidas koolitus läks?");
    expect(cards[0].querySelector("[data-feedback-open]")!.getAttribute("href")).toBe("/konto/tagasiside#kursus=kulmud-e");
    expect(cards[1].textContent).toContain("Kontaktõpe");
    expect(cards[1].querySelector("[data-feedback-open]")!.getAttribute("href")).toBe("/konto/tagasiside#id=7");
  });

  test("'Ei soovi' on the e-course's card posts { kursus } and takes only that card away; the focus goes to the heading", async () => {
    await render(dashboard([ecourseCard()], { feedback: prompts }));
    fetchMock.mockImplementation(async () => json(200, { ok: true }));
    await click($("[data-feedback-card='course-kulmud-e'] [data-feedback-dismiss]"));
    expect(posts()).toEqual([["/api/konto/tagasiside/peida", { kursus: "kulmud-e" }]]);
    expect($$("[data-feedback-card]").map((c) => c.getAttribute("data-feedback-card"))).toEqual(["registration-7"]);
    expect(document.activeElement).toBe($("h1"));
    await click($("[data-feedback-card='registration-7'] [data-feedback-dismiss]"));
    expect(posts().at(-1)).toEqual(["/api/konto/tagasiside/peida", { id: 7 }]);
    expect($("[data-feedback-card]")).toBeNull();
  });

  test("in Russian the card is the e-learning one; read-only (the admin's view): the buttons do nothing", async () => {
    await render(dashboard([ecourseCard()], { feedback: prompts }), false, "ru");
    expect($("[data-feedback-card='course-kulmud-e']")!.textContent).toContain("Онлайн-обучение");
    expect($("[data-feedback-card='course-kulmud-e'] [data-feedback-open]")!.getAttribute("href")).toBe("/ru/konto/tagasiside#kursus=kulmud-e");
    await render(dashboard([ecourseCard()], { feedback: prompts }), true);
    for (const open of $$("[data-feedback-open]")) expect(open.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-feedback-dismiss]"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function contactCard(over: Partial<ContactCard> = {}): ContactCard {
  return {
    kind: "contact", registrationId: 7, course: CONTACT, session: { startsAt: PAST, city: "Pärnu", venue: "", cancelled: false },
    status: "confirmed", paymentChoice: "full", priceCents: 35000, paidCents: 35000, createdAt: PAST, ...over,
  };
}
function individualCard(over: Partial<IndividualCard> = {}): IndividualCard {
  return { kind: "individual", registrationId: 9, course: CONTACT, status: "confirmed", preferredPeriod: "jaanuar", createdAt: PAST, protocolSent: true, ...over };
}
function ecourseCard(over: Partial<EcourseCard> = {}): EcourseCard {
  return { kind: "ecourse", course: ECOURSE, grantedAt: PAST, expiresAt: "2027-04-09T10:00:00.000Z", revoked: false, completedAt: "2026-10-10T09:00:00.000Z", ...over };
}

describe("„Võta luba tagasi“ on the course card", () => {
  const dashboard = (cards: AccountCard[]): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards, favourites: [], prepayment: null, resume: null,
  });
  const render = async (data: Dashboard, readOnly = false, locale: Locale = "et") =>
    act(async () => root.render(createElement(CoursesTab, { locale, t: coursesTexts(getDict(locale)), data, readOnly, now: NOW })));
  const line = (card = "registration-7") => $(`[data-card='${card}'] [data-card-review]`);
  const withdraw = (card = "registration-7") => $(`[data-card='${card}'] [data-card-review-withdraw]`);

  test("the line is there while the card has a review, on a contact card and an e-course's; not without one", async () => {
    await render(dashboard([contactCard({ review: { id: 5 } }), ecourseCard({ review: { id: 6 } })]));
    expect(line()!.textContent).toContain("Lubasid oma soovitust avaldada");
    expect(withdraw()!.textContent).toBe("Võta luba tagasi");
    expect(withdraw()!.tagName).toBe("BUTTON");
    expect(line("course-kulmud-e")!.textContent).toContain("Lubasid oma soovitust avaldada");
    await render(dashboard([contactCard({ review: null }), ecourseCard()]));
    expect(line()).toBeNull();
    expect(line("course-kulmud-e")).toBeNull();
    await render(dashboard([contactCard({ review: { id: 5 } })]));
    expect(withdraw()).not.toBeNull();
    // no status is shown or told: Maria's choices stay hers
    expect(container.textContent).not.toMatch(/Ootab kinnitust|Avaldatud|Peidetud/);
  });

  test("pressing it posts { reviewId }; after a 200 the line is gone and the focus is on the card's heading; the other card keeps its own line", async () => {
    await render(dashboard([contactCard({ review: { id: 5 } }), ecourseCard({ review: { id: 6 } })]));
    fetchMock.mockImplementation(async () => json(200, { ok: true }));
    await click(withdraw());
    expect(posts()).toEqual([["/api/konto/arvustus/tagasi", { reviewId: 5 }]]);
    expect(line()).toBeNull();
    expect(line("course-kulmud-e")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-card='registration-7'] h2"));
    await click(withdraw("course-kulmud-e"));
    expect(posts().at(-1)).toEqual(["/api/konto/arvustus/tagasi", { reviewId: 6 }]);
    expect(line("course-kulmud-e")).toBeNull();
  });

  test("a second press while the first is on its way sends nothing more", async () => {
    await render(dashboard([contactCard({ review: { id: 5 } })]));
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => void (answer = resolve)));
    await act(async () => withdraw()!.click());
    await act(async () => withdraw()!.click());
    expect(posts()).toHaveLength(1);
    expect(withdraw()!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => answer(json(200, { ok: true })));
    await settle();
    expect(line()).toBeNull();
  });

  test.each([
    ["500", json(500, { ok: false }), "Ei õnnestunud. Proovi uuesti."],
    ["429", json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
  ])("a %s keeps the line and its button, and says why under it; a second try goes through", async (_status, refusal, said) => {
    await render(dashboard([contactCard({ review: { id: 5 } })]));
    fetchMock.mockResolvedValueOnce(refusal);
    await click(withdraw());
    expect(line()).not.toBeNull();
    expect($("[data-card-review-error]")!.textContent).toBe(said);
    expect(withdraw()!.getAttribute("aria-disabled")).toBeNull();
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click(withdraw());
    expect(line()).toBeNull();
    expect($("[data-card-review-error]")).toBeNull();
  });

  test("a 404 (Maria deleted it, another tab took it back): the line goes and the cards are loaded again quietly", async () => {
    const before = dashboard([contactCard({ review: { id: 5 } })]);
    const after = dashboard([contactCard({ review: null })]);
    const loads = [json(200, before), json(200, after)];
    fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (loads.shift() ?? json(200, after)) : json(404, { ok: false, error: "review" })));
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), now: NOW })));
    await settle();
    expect(gets("/api/konto")).toBe(1);
    expect(line()).not.toBeNull();
    await click(withdraw());
    expect(gets("/api/konto")).toBe(2); // the quiet reload
    expect($("[data-card-skeleton]")).toBeNull();
    expect(line()).toBeNull();
    expect($("[data-card-review-error]")).toBeNull();
    expect(document.activeElement).toBe($("[data-card='registration-7'] h2"));
  });

  test("a 404 whose reload gets no answer still takes the line away (there is no review to take back)", async () => {
    const loads = [json(200, dashboard([contactCard({ review: { id: 5 } })])), json(500, { ok: false })];
    fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (loads.shift() ?? json(500, {})) : json(404, { ok: false, error: "review" })));
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), now: NOW })));
    await settle();
    await click(withdraw());
    expect(line()).toBeNull();
  });

  test("read-only (the admin's view of the client): the button is there but aria-disabled, and does nothing", async () => {
    await render(dashboard([contactCard({ review: { id: 5 } }), ecourseCard({ review: { id: 6 } })]), true);
    expect(withdraw()!.getAttribute("aria-disabled")).toBe("true");
    await click(withdraw());
    await click(withdraw("course-kulmud-e"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(line()).not.toBeNull();
  });

  test("Russian: the line and the button in Russian", async () => {
    await render(dashboard([contactCard({ review: { id: 5 } })]), false, "ru");
    expect(line()!.textContent).toContain("Вы разрешили опубликовать вашу рекомендацию");
    expect(withdraw()!.textContent).toBe("Отозвать разрешение");
  });

  test("an individual card with no review, a request and a waitlist entry have no line", async () => {
    await render(
      dashboard([
        individualCard({ review: null }),
        { kind: "request", requestId: 3, requestKind: "practice", title: null, detail: "", handled: false, createdAt: PAST },
        { kind: "waitlist", requestId: 4, course: CONTACT, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false }, handled: false, createdAt: PAST },
      ]),
    );
    expect($("[data-card-review]")).toBeNull();
    await render(dashboard([individualCard()])); // a card built before the field existed reads as none
    expect($("[data-card-review]")).toBeNull();
  });

  // The final review's I1 (ruling R10): a student of an individual course gives the permission from the same form, so she takes it back from the same line.
  describe("an individual-course card (no session)", () => {
    test("the line is there while the card has a review, with the words and the button of the other cards", async () => {
      await render(dashboard([individualCard({ review: { id: 8 } })]));
      expect(line("registration-9")!.textContent).toContain("Lubasid oma soovitust avaldada");
      expect(withdraw("registration-9")!.textContent).toBe("Võta luba tagasi");
      expect(withdraw("registration-9")!.tagName).toBe("BUTTON");
      expect(withdraw("registration-9")!.getAttribute("aria-label")).toBe("Võta luba tagasi: Kulmude lamineerimine");
      expect(container.textContent).not.toMatch(/Ootab kinnitust|Avaldatud|Peidetud/);
    });

    test("pressing it posts { reviewId }; after a 200 the line is gone and the focus is on the card's heading", async () => {
      await render(dashboard([individualCard({ review: { id: 8 } }), contactCard({ review: { id: 5 } })]));
      fetchMock.mockImplementation(async () => json(200, { ok: true }));
      await click(withdraw("registration-9"));
      expect(posts()).toEqual([["/api/konto/arvustus/tagasi", { reviewId: 8 }]]);
      expect(line("registration-9")).toBeNull();
      expect(line()).not.toBeNull(); // the contact card keeps its own
      expect(document.activeElement).toBe($("[data-card='registration-9'] h2"));
    });

    test("a 404 loads the cards again quietly and the line goes; a 500 keeps the line and says why; read-only does nothing", async () => {
      const loads = [json(200, dashboard([individualCard({ review: { id: 8 } })])), json(200, dashboard([individualCard({ review: null })]))];
      fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (loads.shift() ?? json(500, {})) : json(404, { ok: false, error: "review" })));
      await act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), now: NOW })));
      await settle();
      await click(withdraw("registration-9"));
      expect(gets("/api/konto")).toBe(2); // the quiet reload, with the focus kept on this card
      expect(line("registration-9")).toBeNull();
      expect(document.activeElement).toBe($("[data-card='registration-9'] h2"));
      await render(dashboard([individualCard({ review: { id: 8 } })]));
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json(500, { ok: false }));
      await click(withdraw("registration-9"));
      expect($("[data-card-review-error]")!.textContent).toBe("Ei õnnestunud. Proovi uuesti.");
      expect(line("registration-9")).not.toBeNull();
      await render(dashboard([individualCard({ review: { id: 8 } })]), true);
      fetchMock.mockReset();
      await click(withdraw("registration-9"));
      expect(withdraw("registration-9")!.getAttribute("aria-disabled")).toBe("true");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("Russian: the line and the button in Russian", async () => {
      await render(dashboard([individualCard({ review: { id: 8 } })]), false, "ru");
      expect(line("registration-9")!.textContent).toContain("Вы разрешили опубликовать вашу рекомендацию");
      expect(withdraw("registration-9")!.textContent).toBe("Отозвать разрешение");
    });
  });
});
