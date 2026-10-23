// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContactRegister, type ContactRegisterTexts, type SessionOption } from "@/components/site/ContactRegister";
import type { FormContract } from "@/components/site/ContractPreview";
import { EcoursePurchase, type EcoursePurchaseTexts } from "@/components/site/EcoursePurchase";
import { fillContract, filledContract } from "@/domain/contract";

// The inline contract of the registration form and of the cart (contracts, Task 4; spec D1, Review Focus 3): the box is the contract, and
// „Loe lepingut“ opens its text in the form, filled live from what the form holds — the chosen session's date and place, the price and the
// payment choice, the name and the address — with the very helpers the server fills the frozen contract with. Before a session is chosen,
// {toimumine} says „(vali toimumine)“. The values are Task 1's fixtures (tests/unit/contract-rules.test.ts): the preview fills them exactly as
// fillContract does.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ registerContact: vi.fn(), submitIndividual: vi.fn(), buyEcourse: vi.fn(), refresh: vi.fn() }));
vi.mock("@/server/actions/public", () => ({ registerContact: mocks.registerContact, submitIndividual: mocks.submitIndividual, buyEcourse: mocks.buyEcourse }));
vi.mock("@/lib/navigate", () => ({ navigate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/url-query", () => ({ useUrlQuery: () => [new URLSearchParams(), vi.fn()] }));

const NBSP = " ";
/** Task 1's values (contract-rules.test.ts VALUES), the euros as euro() writes them. */
const VALUES = { nimi: "Kati Kask", "e-post": "kati@example.test", koolitus: "Kulmude kujundus", toimumine: "14.11.2026, Tallinn", hind: `350,00${NBSP}€`, ettemaks: `175,00${NBSP}€` };
/** Task 1's text with every placeholder. */
const TEXT = "Õpilane {nimi} ({e-post}) osaleb koolitusel {koolitus}, {toimumine}. Hind {hind}, ettemaks {ettemaks}.";

const t: ContactRegisterTexts = {
  participationLabel: "Osalemisviis",
  group: "Grupikoolitus",
  individual: "Individuaalkoolitus",
  pickSession: "Vali toimumise aeg",
  noSessions: "Uued kuupäevad tulevad peagi.",
  switchIndividual: "Vali individuaalkoolitus",
  individualNote: "Maria lepib aja kokku.",
  sessionRequired: "Vali toimumise aeg.",
  sessionFull: "See kuupäev on täis.",
  sessionUnavailable: "See kuupäev ei ole enam saadaval.",
  name: "Nimi",
  email: "E-post",
  phone: "Telefon",
  paymentLabel: "Tasumine",
  payFull: "100% kohe",
  payHalf: "50% registreerimisel + 50% koolituspäeval",
  payFinancing: "Järelmaks (Inbank)",
  financingRange: "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.", financingOff: "Järelmaks pole praegu saadaval. Saad maksta pangalingiga.",
  financingLine: "Võimalik tasuda ka järelmaksuga (Inbank).",
  modelHelp: "Soovin koolituskeskuse abi modellide leidmisel",
  createAccount: "Loo mulle kohe konto MS LAB keskkonda",
  newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi",
  terms: "Olen tutvunud tingimustega ja nõustun nendega.",
  termsLink: { label: "Õppetingimused", href: "/tingimused" },
  contractTerms: "Olen tutvunud lepingu tingimustega ja nõustun nendega.",
  readContract: "Loe lepingut",
  contractNoSession: "(vali toimumine)",
  contractChanged: "Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.",
  preferredPeriod: "Soovitud periood või kuupäev",
  preferredPeriodPlaceholder: "Nt detsembri teine pool",
  message: "Sõnum",
  optional: "valikuline",
  register: "Registreeru",
  requestSubmit: "Saada päring",
  sending: "Saadan…",
  confirmAfterPrepayment: "Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.",
  registerSuccess: "Registreerimine on vastu võetud.",
  individualSent: "Aitäh! Sinu päring on saadetud.",
  errorRequired: "See väli on kohustuslik.",
  errorEmail: "Sisesta korrektne e-posti aadress.",
  errorTooMany: "Liiga palju katseid.",
  errorGeneric: "Midagi läks valesti.",
};
/** 14.11.2026 at 10:00 in Tallinn, as Task 1's session fixture. */
const session: SessionOption = { id: 7, startsAt: "2026-11-14T08:00:00.000Z", date: "14.11.2026", weekday: "laupäev", city: "Tallinn", venue: "", language: "ET", state: "open", stateLabel: "Vabu kohti · 6", disabled: false };
const other: SessionOption = { ...session, id: 8, startsAt: "2026-12-05T08:00:00.000Z", date: "05.12.2026", city: "Tartu", venue: "Kesk 2" };
const V1 = "2026-10-10T09:00:00.000Z";
const contactContract: FormContract = { version: V1, title: "Kontaktkoolituse leping — {koolitus}", body: `${TEXT}\n\nTeine lõik, {tundmatu} jääb.`, locale: "et", course: "Kulmude kujundus", priceCents: 35000 };
const contactProps = { financing: false, course: "kulmude-kujundus", locale: "et" as const, kinds: [{ kind: "group" as const, price: "350 €" }, { kind: "individual" as const, price: "450 €" }], sessions: [session, other], t, contract: contactContract };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const toggle = () => $<HTMLButtonElement>("[data-contract-toggle]");
const panel = () => $<HTMLElement>("[data-contract-preview]");
/** The panel's paragraphs, as she reads them. */
const shown = () => [...(panel()?.querySelectorAll("p") ?? [])].map((p) => p.textContent);
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const type = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the registration form (group): the box is the contract, „Loe lepingut“ opens it filled from the form", () => {
  beforeEach(async () => {
    await act(async () => root.render(createElement(ContactRegister, contactProps)));
  });

  test("the box says it is the contract; „Loe lepingut“ is a button in the form that opens the text below it (no link to another page)", async () => {
    const box = $<HTMLInputElement>("input[name='terms']")!;
    expect(box.closest("label")!.textContent).toBe("Olen tutvunud lepingu tingimustega ja nõustun nendega.");
    expect(container.querySelector("a[href='/tingimused']")).toBeNull();
    expect(toggle()!.textContent).toContain("Loe lepingut");
    expect(toggle()!.type).toBe("button");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()!.getAttribute("aria-controls")).toBe(panel()!.id);
    expect(panel()!.hidden).toBe(true);
    await click(toggle());
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(panel()!.hidden).toBe(false);
    // opening it submits nothing and ticks nothing
    expect(mocks.registerContact).not.toHaveBeenCalled();
    expect(box.checked).toBe(false);
    await click(toggle());
    expect(panel()!.hidden).toBe(true);
  });

  test("before a session is chosen, {toimumine} says „(vali toimumine)“; the price and the payment choice are filled from the start", async () => {
    await click(toggle());
    expect(shown()).toEqual([
      "Kontaktkoolituse leping — Kulmude kujundus",
      `Õpilane  () osaleb koolitusel Kulmude kujundus, (vali toimumine). Hind 350,00${NBSP}€, ettemaks 350,00${NBSP}€.`,
      "Teine lõik, {tundmatu} jääb.",
    ]);
  });

  test("the session, the name, the address and the payment choice fill it as she gives them, exactly as fillContract fills Task 1's values (Review Focus 3)", async () => {
    await click(toggle());
    await click($("[data-session='7']"));
    await type("input[name='name']", "  Kati   Kask ");
    await type("input[name='email']", " Kati@Example.test ");
    await click($("input[name='payment'][value='half']"));
    expect(shown()[1]).toBe(fillContract(TEXT, VALUES));
    expect(shown()[1]).toBe(`Õpilane Kati Kask (kati@example.test) osaleb koolitusel Kulmude kujundus, 14.11.2026, Tallinn. Hind 350,00${NBSP}€, ettemaks 175,00${NBSP}€.`);
    // another session and the full payment: the date and place, and the prepayment, follow
    await click($("[data-session='8']"));
    await click($("input[name='payment'][value='full']"));
    expect(shown()[1]).toBe(`Õpilane Kati Kask (kati@example.test) osaleb koolitusel Kulmude kujundus, 05.12.2026, Tartu, Kesk 2. Hind 350,00${NBSP}€, ettemaks 350,00${NBSP}€.`);
  });

  test("Järelmaks (Inbank) is a choice of the form only while it is offered; chosen, {ettemaks} is the whole price, as the server fills the frozen contract (Task 1: financing is due in full)", async () => {
    await act(async () => root.render(createElement(ContactRegister, { ...contactProps, financing: true })));
    await click(toggle());
    await click($("[data-session='7']"));
    await click($("input[name='payment'][value='half']"));
    expect(shown()[1]).toContain(`ettemaks 175,00${NBSP}€`);
    await click($("input[name='payment'][value='financing']"));
    expect(shown()[1]).toBe(`Õpilane  () osaleb koolitusel Kulmude kujundus, 14.11.2026, Tallinn. Hind 350,00${NBSP}€, ettemaks 350,00${NBSP}€.`);
    const server = filledContract(contactContract, { name: "", email: "", course: "Kulmude kujundus", session: { startsAt: new Date(session.startsAt), city: "Tallinn", venue: "" }, priceCents: 35000, choice: "financing", locale: "et" });
    expect(shown()).toEqual([server.title, ...server.body.split("\n\n")]);
  });

  test("the individual request keeps today's box and its link to „Õppetingimused“: no contract (spec D1)", async () => {
    await click($("input[name='kind'][value='individual']"));
    expect($<HTMLInputElement>("input[name='terms']")!.closest("label")!.textContent).toBe("Olen tutvunud tingimustega ja nõustun nendega.");
    expect($<HTMLAnchorElement>("a[href='/tingimused']")!.textContent).toContain("Õppetingimused");
    expect(toggle()).toBeNull();
    expect(panel()).toBeNull();
  });
});

describe("the cart: the e-course contract in the same way", () => {
  const et: EcoursePurchaseTexts = {
    name: "Nimi",
    email: "E-post",
    contractTerms: "Olen tutvunud lepingu tingimustega ja nõustun nendega.",
    readContract: "Loe lepingut",
    contractChanged: "Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.",
    newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi",
    paymentLabel: "Tasumine",
    payBank: "Pangalink",
    payFinancing: "Järelmaks (Inbank)",
    financingRange: "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.", financingOff: "Järelmaks pole praegu saadaval. Saad maksta pangalingiga.",
    submit: "Maksa 190 €",
    starting: "Avan makse…",
    alreadyPaid: "Makse on juba tehtud — vaata oma e-posti.",
    errorRequired: "See väli on kohustuslik.",
    errorEmail: "Sisesta korrektne e-posti aadress.",
    errorTooMany: "Liiga palju katseid.",
    errorGeneric: "Midagi läks valesti.",
  };
  const contract: FormContract = { version: V1, title: "E-koolituse tingimused", body: "Tere {nimi} ({e-post}). {koolitus} maksab {hind}.[{toimumine}{ettemaks}]", locale: "et", course: "Kulmumeistri e-koolitus", priceCents: 19000 };

  test("the box is the contract, „Loe lepingut“ opens it in the cart: the name and the address as typed, the course, the price; no session and no prepayment", async () => {
    await act(async () => root.render(createElement(EcoursePurchase, { financing: false, course: "kulmumeistri-e-koolitus", locale: "et", t: et, contract, fallback: null })));
    expect($<HTMLInputElement>("input[name='terms']")!.closest("label")!.textContent).toBe("Olen tutvunud lepingu tingimustega ja nõustun nendega.");
    expect(container.querySelector("a[href='/tingimused']")).toBeNull();
    expect(panel()!.hidden).toBe(true);
    await click(toggle());
    expect(shown()).toEqual(["E-koolituse tingimused", `Tere  (). Kulmumeistri e-koolitus maksab 190,00${NBSP}€.[]`]);
    await type("input[name='name']", "Kati Kask");
    await type("input[name='email']", "Kati@example.test");
    expect(shown()[1]).toBe(`Tere Kati Kask (kati@example.test). Kulmumeistri e-koolitus maksab 190,00${NBSP}€.[]`);
  });

  test("a contract with no text at all offers nothing to open (the box stays)", async () => {
    await act(async () => root.render(createElement(EcoursePurchase, { financing: false, course: "kulmumeistri-e-koolitus", locale: "et", t: et, contract: { ...contract, title: "", body: "  " }, fallback: null })));
    expect($("input[name='terms']")).not.toBeNull();
    expect(toggle()).toBeNull();
  });
});

describe("a text that changed since the page was loaded (ruling R6): the form says so, clears the box and loads the page again", () => {
  const V2 = "2026-10-17T09:02:00.000Z";
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
  const box = () => $<HTMLInputElement>("input[name='terms']")!;
  const MESSAGE = "Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.";

  test("the registration form sends the version its page shows; 'changed' shows the message at the box, unticks it, focuses it and loads the page again", async () => {
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { terms: "changed" } });
    await act(async () => root.render(createElement(ContactRegister, contactProps)));
    await click($("[data-session='7']"));
    await click(box());
    expect(box().checked).toBe(true);
    await act(async () => $<HTMLFormElement>("[data-register-form]")!.requestSubmit());
    await settle();
    expect((mocks.registerContact.mock.calls[0][0] as FormData).get("contractVersion")).toBe(V1);
    expect(box().checked).toBe(false);
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(box().getAttribute("aria-describedby")!)!.textContent).toBe(MESSAGE);
    expect(document.activeElement).toBe(box());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // the page loaded again brings the new text: the form shows it and sends its version with the next tick
    await act(async () => root.render(createElement(ContactRegister, { ...contactProps, contract: { ...contactContract, version: V2, body: "Uus tekst, {nimi}." } })));
    await click(toggle());
    expect(shown()).toContain("Uus tekst, .");
    expect($<HTMLInputElement>("input[name='contractVersion']")!.value).toBe(V2);
  });

  test("an individual request sends no version: it has no contract", async () => {
    mocks.submitIndividual.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(ContactRegister, contactProps)));
    expect($<HTMLInputElement>("input[name='contractVersion']")!.value).toBe(V1);
    await click($("input[name='kind'][value='individual']"));
    expect($("input[name='contractVersion']")).toBeNull();
  });

  test("the cart: it sends the version it shows; 'changed' shows the message at the box, unticks it and loads the cart again, and goes nowhere", async () => {
    const et: EcoursePurchaseTexts = {
      name: "Nimi", email: "E-post", contractTerms: "Olen tutvunud lepingu tingimustega ja nõustun nendega.", readContract: "Loe lepingut", contractChanged: MESSAGE,
      newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi", paymentLabel: "Tasumine", payBank: "Pangalink", payFinancing: "Järelmaks (Inbank)",
      financingRange: "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.", financingOff: "Järelmaks pole praegu saadaval. Saad maksta pangalingiga.", submit: "Maksa 190 €", starting: "Avan makse…", alreadyPaid: "Makse on juba tehtud — vaata oma e-posti.",
      errorRequired: "See väli on kohustuslik.", errorEmail: "Sisesta korrektne e-posti aadress.", errorTooMany: "Liiga palju katseid.", errorGeneric: "Midagi läks valesti.",
    };
    const contract: FormContract = { version: V1, title: "E-koolituse tingimused", body: "Tere {nimi}.", locale: "et", course: "Kulmumeistri e-koolitus", priceCents: 19000 };
    mocks.buyEcourse.mockResolvedValue({ ok: false, errors: { terms: "changed" } });
    await act(async () => root.render(createElement(EcoursePurchase, { financing: false, course: "kulmumeistri-e-koolitus", locale: "et", t: et, contract, fallback: null })));
    await type("input[name='name']", "Kati Kask");
    await type("input[name='email']", "kati@example.test");
    await click(box());
    await act(async () => $<HTMLFormElement>("[data-ecourse-form]")!.requestSubmit());
    await settle();
    expect((mocks.buyEcourse.mock.calls[0][0] as FormData).get("contractVersion")).toBe(V1);
    expect(box().checked).toBe(false);
    expect(document.getElementById(box().getAttribute("aria-describedby")!)!.textContent).toBe(MESSAGE);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect($("button[type='submit']")!.textContent).toBe("Maksa 190 €");
  });
});
