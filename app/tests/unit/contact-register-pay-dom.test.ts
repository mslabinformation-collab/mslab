// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ContactRegister, type ContactRegisterTexts, type SessionOption } from "@/components/site/ContactRegister";

// A group registration's way to the bank (phase 2b, spec 6.1): the browser leaves for the payment page only once the action's whole answer is on
// the page. That answer carries the revalidated course page (Next streams it after the result); leaving from inside the action cut it off and
// the server logged "The destination stream closed early" for every registration (Task 10, found by the e2e run). So `navigate` runs from an
// effect, after the confirmation is shown, exactly once, and only for a group registration that has a payment page.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  registerContact: vi.fn<(fd: FormData) => Promise<unknown>>(),
  submitIndividual: vi.fn<(fd: FormData) => Promise<unknown>>(),
  navigate: vi.fn<(url: string) => void>(),
}));
vi.mock("@/server/actions/public", () => ({ registerContact: mocks.registerContact, submitIndividual: mocks.submitIndividual }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/url-query", () => ({ useUrlQuery: () => [new URLSearchParams(), vi.fn()] }));

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
  paymentLabel: "Makse",
  payFull: "100% kohe",
  payHalf: "50% registreerimisel + 50% koolituspäeval",
  payInstalment: "Järelmaks",
  payInstalmentNote: "Peagi",
  modelHelp: "Vajan abi modellide leidmisel",
  createAccount: "Loo mulle konto",
  newsletterConsent: "Soovin uudiseid",
  terms: "Olen tutvunud tingimustega",
  termsLink: { label: "Tingimused", href: "/tingimused" },
  contractTerms: "Olen tutvunud lepingu tingimustega",
  readContract: "Loe lepingut",
  contractNoSession: "(vali toimumine)",
  contractChanged: "Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.",
  preferredPeriod: "Sobiv aeg",
  preferredPeriodPlaceholder: "Näiteks jaanuar",
  message: "Sõnum",
  optional: "valikuline",
  register: "Registreeru",
  requestSubmit: "Saada päring",
  sending: "Saadan…",
  confirmAfterPrepayment: "Koht kinnitatakse pärast ettemaksu.",
  registerSuccess: "Aitäh! Registreerimine on vastu võetud.",
  individualSent: "Päring on saadetud.",
  errorRequired: "See väli on kohustuslik.",
  errorEmail: "Sisesta korrektne e-posti aadress.",
  errorTooMany: "Liiga palju katseid.",
  errorGeneric: "Midagi läks valesti.",
};
const session: SessionOption = { id: 7, startsAt: "2026-11-14T08:00:00.000Z", date: "14.11", weekday: "laupäev", city: "Tallinn", venue: "Stuudio", language: "ET", state: "open", stateLabel: "Vabu kohti · 6", disabled: false };
const props = { course: "kulmumeistri-baaskoolitus", locale: "et" as const, kinds: [{ kind: "group" as const, price: "350 €" }, { kind: "individual" as const, price: "450 €" }], sessions: [session], t, contract: { version: "2026-10-01T00:00:00.000Z", title: "Leping", body: "{nimi}, {toimumine}, {hind}.", locale: "et" as const, course: "Kulmumeistri baaskoolitus", priceCents: 35000 } };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-register-form]")!.requestSubmit());
  await settle();
};
/** What the page showed when `navigate` was called. */
let shownAtLeaving: boolean[] = [];

beforeEach(async () => {
  for (const m of Object.values(mocks)) m.mockReset();
  shownAtLeaving = [];
  mocks.navigate.mockImplementation(() => void shownAtLeaving.push($("[data-register-sent]") !== null));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ContactRegister, props)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("a group registration with a payment page: the browser leaves once, after the confirmation is on the page", async () => {
  mocks.registerContact.mockResolvedValue({ ok: true, paymentUrl: "https://pay.example/orders/abc" });
  await submit();
  expect(mocks.registerContact).toHaveBeenCalledTimes(1);
  expect(mocks.navigate.mock.calls).toEqual([["https://pay.example/orders/abc"]]);
  expect(shownAtLeaving).toEqual([true]); // not from inside the action, while its answer is still coming in
  expect($("[data-register-sent]")?.textContent).toContain("Registreerimine on vastu võetud");
});

test("a group registration with no payment page (payments off) goes nowhere", async () => {
  mocks.registerContact.mockResolvedValue({ ok: true });
  await submit();
  expect($("[data-register-sent]")).not.toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("an individual request never leaves the page, whatever the answer carries", async () => {
  mocks.submitIndividual.mockResolvedValue({ ok: true, paymentUrl: "https://pay.example/orders/abc" });
  await act(async () => {
    const radio = $<HTMLInputElement>("input[name='kind'][value='individual']")!;
    radio.click();
  });
  await submit();
  expect(mocks.submitIndividual).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("a refused registration shows its error and goes nowhere", async () => {
  mocks.registerContact.mockResolvedValue({ ok: false, errors: { form: "rate" } });
  await submit();
  expect($("[data-register-sent]")).toBeNull();
  expect(container.textContent).toContain("Liiga palju katseid.");
  expect(mocks.navigate).not.toHaveBeenCalled();
});
