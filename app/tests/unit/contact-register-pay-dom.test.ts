// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  payFinancing: "Järelmaks (Inbank)",
  financingRange: "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.",
  financingOff: "Järelmaks pole praegu saadaval. Saad maksta pangalingiga.",
  financingLine: "Võimalik tasuda ka järelmaksuga (Inbank).",
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
const props = { financing: false, course: "kulmumeistri-baaskoolitus", locale: "et" as const, kinds: [{ kind: "group" as const, price: "350 €" }, { kind: "individual" as const, price: "450 €" }], sessions: [session], t, contract: { version: "2026-10-01T00:00:00.000Z", title: "Leping", body: "{nimi}, {toimumine}, {hind}.", locale: "et" as const, course: "Kulmumeistri baaskoolitus", priceCents: 35000 } };

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

// ---------- Järelmaks (Inbank) on the form (instalments D2, D4, §4, Task 6) ----------
// A third payment choice, only while the course page says it is offered (the toggle on, Montonio payments on, the group price within 100–5000 €); never a
// disabled placeholder. A järelmaks the server refuses after all (the toggle was switched off, or the price moved, since the page was loaded) keeps the
// registration: the answer says so and the form tells her, at once, what Järelmaks needs.

describe("Järelmaks (Inbank) on the registration form", () => {
  const offered = { ...props, financing: true };
  const choices = () => [...container.querySelectorAll<HTMLInputElement>("input[name='payment']")];
  const line = () => $("[data-financing-line]");
  const fillIn = async () => {
    await act(async () => $<HTMLButtonElement>("[data-session='7']")!.click());
    const set = (selector: string, value: string) => {
      const input = $<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      set("input[name='name']", "Kati Tamm");
      set("input[name='email']", "kati@example.test");
      set("input[name='phone']", "+372 5555 0101");
    });
    await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  };

  test("not offered: the two choices it has always had, nothing disabled, no placeholder, no line", async () => {
    expect(choices().map((c) => [c.value, c.disabled, c.closest("label")?.textContent])).toEqual([
      ["full", false, "100% kohe"],
      ["half", false, "50% registreerimisel + 50% koolituspäeval"],
    ]);
    expect($("[data-pay-instalment]")).toBeNull();
    expect(container.textContent).not.toMatch(/[Jj]ärelmaks|tulekul/);
    expect(line()).toBeNull();
  });

  test("offered: three choices, „Järelmaks (Inbank)“ the third and enabled; the quiet line next to the prices for the group course, not for the individual request", async () => {
    await act(async () => root.render(createElement(ContactRegister, offered)));
    expect(choices().map((c) => [c.value, c.disabled, c.checked, c.closest("label")?.textContent])).toEqual([
      ["full", false, true, "100% kohe"],
      ["half", false, false, "50% registreerimisel + 50% koolituspäeval"],
      ["financing", false, false, "Järelmaks (Inbank)"],
    ]);
    expect($("[data-pay-instalment]")).toBeNull();
    expect(line()?.textContent).toBe("Võimalik tasuda ka järelmaksuga (Inbank).");
    await act(async () => $<HTMLInputElement>("input[name='kind'][value='individual']")!.click());
    expect(line()).toBeNull(); // (an individual course has no online payment)
    expect(choices()).toHaveLength(0);
  });

  test("choosing it sends payment=financing and the browser goes on to the page the start gave (Inbank's, through Montonio)", async () => {
    mocks.registerContact.mockResolvedValue({ ok: true, paymentUrl: "https://pay.example/orders/loan" });
    await act(async () => root.render(createElement(ContactRegister, offered)));
    await fillIn();
    await act(async () => choices()[2].click());
    expect(choices().map((c) => c.checked)).toEqual([false, false, true]);
    await submit();
    expect(mocks.registerContact.mock.calls[0][0].get("payment")).toBe("financing");
    expect(mocks.navigate.mock.calls).toEqual([["https://pay.example/orders/loan"]]);
  });

  test("a järelmaks refused at the start ({ ok: true, financing: \"refused\" }): the registration stands, she is told what Järelmaks needs and that the payment instructions follow by e-mail; nothing is navigated to", async () => {
    mocks.registerContact.mockResolvedValue({ ok: true, financing: "refused" });
    await act(async () => root.render(createElement(ContactRegister, offered)));
    await fillIn();
    await act(async () => choices()[2].click());
    await submit();
    expect(mocks.navigate).not.toHaveBeenCalled();
    const sent = $("[data-register-sent]")!;
    // the form is gone (a second press would register her twice): the range first, then what she was told of every registration
    expect($("[data-register-form]")).toBeNull();
    expect([...sent.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Järelmaks on võimalik 100–5000 € hinnaga koolitusele.", "Aitäh! Registreerimine on vastu võetud."]);
    expect(sent.querySelector("[data-financing-refused]")).not.toBeNull();
    expect(document.activeElement).toBe(sent);
  });

  test("a järelmaks refused because it was switched off ({ ok: true, financing: \"off\" }): the registration stands and she is told it is not available now and that the bank is open — not the range", async () => {
    mocks.registerContact.mockResolvedValue({ ok: true, financing: "off" });
    await act(async () => root.render(createElement(ContactRegister, offered)));
    await fillIn();
    await act(async () => choices()[2].click());
    await submit();
    expect(mocks.navigate).not.toHaveBeenCalled();
    const sent = $("[data-register-sent]")!;
    expect($("[data-register-form]")).toBeNull();
    expect([...sent.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Järelmaks pole praegu saadaval. Saad maksta pangalingiga.", "Aitäh! Registreerimine on vastu võetud."]);
    expect(sent.textContent).not.toContain("100–5000");
    expect(sent.querySelector("[data-financing-refused]")).not.toBeNull();
    expect(document.activeElement).toBe(sent);
  });

  test("a registration with no payment page and no refusal (payments off) says only what it always said", async () => {
    mocks.registerContact.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(ContactRegister, offered)));
    await fillIn();
    await submit();
    expect([...$("[data-register-sent]")!.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Aitäh! Registreerimine on vastu võetud."]);
    expect($("[data-financing-refused]")).toBeNull();
  });
});
