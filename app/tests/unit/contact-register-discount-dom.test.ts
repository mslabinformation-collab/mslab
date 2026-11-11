// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContactRegister, type ContactRegisterTexts, type SessionOption } from "@/components/site/ContactRegister";
import type { CheckAnswer } from "@/domain/discount-codes";

// The sooduskood on the group registration form (F1, Task 9; design "Sooduskoodi väli"): the field under „Sõnum“, the total, the contract filled with
// it, järelmaks decided on it, a typed code applied by the submit, the server's refusals going back to the field. The server is mocked: its own rules
// are tested at the server (discount-check, submit).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  registerContact: vi.fn<(fd: FormData) => Promise<unknown>>(),
  submitIndividual: vi.fn<(fd: FormData) => Promise<unknown>>(),
  checkDiscountCode: vi.fn<(fd: FormData) => Promise<CheckAnswer>>(),
}));
vi.mock("@/server/actions/public", () => mocks);
vi.mock("@/lib/navigate", () => ({ navigate: vi.fn() }));
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
  contractChanged: "Lepingu tekst on vahepeal muutunud.",
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
  discount: {
    open: "Mul on sooduskood",
    label: "Sooduskood",
    apply: "Rakenda",
    applied: "Sooduskood {code}: −{amount}",
    remove: "Eemalda",
    total: "Kokku {total}",
    hintWelcome: "Kehtib uudiskirjaga liitunud aadressil ja ainult esimesel koolitusel.",
    hintFirst: "Kehtib ainult esimesel koolitusel.",
    hintReturning: "Kehtib MS LABi varasematele õpilastele.",
    errors: {
      empty: "Kirjuta sooduskood.",
      unknown: "Sellist sooduskoodi ei ole.",
      paused: "See sooduskood ei kehti enam.",
      ended: "See sooduskood ei kehti enam.",
      notYet: "See sooduskood kehtib alates {date}.",
      usedUp: "Selle sooduskoodi kasutuskorrad on otsas.",
      scope: "See sooduskood ei kehti sellele koolitusele.",
      person: "Seda sooduskoodi ei saa selle e-posti aadressiga kasutada.",
      changed: "Sooduskood muutus vahepeal. Vaata uus hind üle ja proovi uuesti.",
      rate: "Liiga palju katseid.",
      server: "Midagi läks valesti.",
    },
  },
};
const session: SessionOption = { id: 7, startsAt: "2026-11-14T08:00:00.000Z", date: "14.11", weekday: "laupäev", city: "Tallinn", venue: "Stuudio", language: "ET", state: "open", stateLabel: "Vabu kohti · 6", disabled: false };
const KEY = "mslab-discount:kulmumeistri-baaskoolitus";
const base = {
  financingSwitch: { enabled: false, paymentsOn: true },
  course: "kulmumeistri-baaskoolitus",
  locale: "et" as const,
  kinds: [{ kind: "group" as const, price: "350 €" }, { kind: "individual" as const, price: "450 €" }],
  sessions: [session],
  t,
  contract: { version: "v1", title: "Leping", body: "Hind on {hind}.", locale: "et" as const, course: "Kulmumeistri baaskoolitus", priceCents: 35000 },
};

/** What the check answers for a code: the answer a course of `list` cents would give. */
const ok = (code: string, off: number, list = 35000, extra: Partial<Extract<CheckAnswer, { ok: true }>> = {}): CheckAnswer => ({
  ok: true,
  code,
  discountCents: off,
  totalCents: list - off,
  value: "10%",
  audience: "all",
  welcome: false,
  ...extra,
});
const refused = (error: Extract<CheckAnswer, { ok: false }>["error"], startsOn?: string): CheckAnswer => ({ ok: false, error, startsOn });

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (props: Partial<typeof base> = {}) => {
  await act(async () => root.render(createElement(ContactRegister, { ...base, ...props })));
  await settle();
};
const setValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const codeInput = () => $<HTMLInputElement>("[data-discount] input")!;
const openField = async () => act(async () => $<HTMLButtonElement>("[data-discount-open]")!.click());
const type = async (code: string) => act(async () => setValue(codeInput(), code));
const apply = async () => {
  await act(async () => $<HTMLButtonElement>("[data-discount-apply]")!.click());
  await settle();
};
const applyCode = async (code: string) => {
  await openField();
  await type(code);
  await apply();
};
const fillIn = async () => {
  await act(async () => $<HTMLButtonElement>("[data-session='7']")!.click());
  await act(async () => {
    setValue($<HTMLInputElement>("input[name='name']")!, "Kati Tamm");
    setValue($<HTMLInputElement>("input[name='email']")!, "kati@example.test");
    setValue($<HTMLInputElement>("input[name='phone']")!, "+372 5555 0101");
  });
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
};
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-register-form]")!.requestSubmit());
  await settle();
};
const choices = () => [...container.querySelectorAll<HTMLInputElement>("input[name='payment']")];
const appliedLine = () => $("[data-discount-applied]")?.textContent ?? null;
const totalLine = () => $("[data-discount-total]")?.textContent ?? null;
const errorText = () => $("[data-discount-error]")?.textContent ?? null;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});

describe("the field", () => {
  test("Mul on sooduskood opens the field; Rakenda shows the line and Kokku", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    // closed: only the quiet button, no box, no total; between „Sõnum“ and „Tasumine“ in the form
    expect($("[data-discount-open]")?.textContent).toBe("Mul on sooduskood");
    expect(codeInput()).toBeNull();
    expect(totalLine()).toBeNull();
    const html = container.innerHTML;
    expect(html.indexOf("data-discount-open")).toBeGreaterThan(html.indexOf("Sõnum"));
    expect(html.indexOf("data-discount-open")).toBeLessThan(html.indexOf("Makse"));
    await openField();
    expect(document.activeElement).toBe(codeInput());
    await type("tere10");
    await apply();
    const sent = mocks.checkDiscountCode.mock.calls[0][0];
    expect([sent.get("course"), sent.get("code")]).toEqual(["kulmumeistri-baaskoolitus", "tere10"]);
    expect(appliedLine()).toContain("Sooduskood TERE10: −35 €");
    expect($("[data-discount-applied] strong")?.textContent).toBe("TERE10");
    expect(totalLine()).toContain("Kokku");
    expect($("[data-discount-total] s")?.textContent).toBe("350 €");
    expect($("[data-discount-total] strong")?.textContent).toBe("315 €");
    expect(window.sessionStorage.getItem(KEY)).toBe("TERE10");
  });

  test("a refused code says why, with the list price still shown", async () => {
    mocks.checkDiscountCode.mockResolvedValue(refused("ended"));
    await render();
    await applyCode("SUVI2025");
    expect(errorText()).toBe("See sooduskood ei kehti enam.");
    expect(codeInput().getAttribute("aria-invalid")).toBe("true");
    expect(totalLine()).toBeNull();
  });

  test("a code that starts later says its date as pp.kk.aaaa", async () => {
    mocks.checkDiscountCode.mockResolvedValue(refused("notYet", "2026-12-01"));
    await render();
    await applyCode("JOULUD");
    expect(errorText()).toBe("See sooduskood kehtib alates 01.12.2026.");
  });

  test("Enter applies and does not submit", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    await openField();
    await type("tere10");
    let prevented = false;
    await act(async () => {
      const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      codeInput().dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    await settle();
    expect(prevented).toBe(true);
    expect(mocks.checkDiscountCode).toHaveBeenCalledTimes(1);
    expect(mocks.registerContact).not.toHaveBeenCalled();
    expect(appliedLine()).toContain("TERE10");
  });

  test("the box has no name: the form's own data never carries it", async () => {
    await render();
    await openField();
    expect(codeInput().getAttribute("name")).toBeNull();
  });

  test("Eemalda brings back the list price and clears the memory", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    await applyCode("tere10");
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    expect(appliedLine()).toBeNull();
    expect(totalLine()).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(codeInput().value).toBe(""); // the box is open for another code
    expect(document.activeElement).toBe(codeInput());
  });

  test("a second code replaces the first", async () => {
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("TERE10", 3500)).mockResolvedValueOnce(ok("JOULUD-20", 7000, 35000, { value: "20%" }));
    await render();
    await applyCode("tere10");
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    await type("joulud-20");
    await apply();
    expect(appliedLine()).toContain("JOULUD-20: −70 €");
    expect(appliedLine()).not.toContain("TERE10");
    expect($("[data-discount-total] strong")?.textContent).toBe("280 €");
    expect(window.sessionStorage.getItem(KEY)).toBe("JOULUD-20");
  });

  test("ignores a stale check answer", async () => {
    // the first check resolves after the second: the second's line shows
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode
      .mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r)))
      .mockResolvedValueOnce(ok("JOULUD-20", 7000, 35000, { value: "20%" }));
    await render();
    await openField();
    await type("tere10");
    await act(async () => $<HTMLButtonElement>("[data-discount-apply]")!.click()); // pending
    await type("joulud-20");
    await apply();
    expect(appliedLine()).toContain("JOULUD-20");
    await act(async () => first(ok("TERE10", 3500)));
    await settle();
    expect(appliedLine()).toContain("JOULUD-20");
    expect(appliedLine()).not.toContain("TERE10");
    expect(window.sessionStorage.getItem(KEY)).toBe("JOULUD-20");
  });

  test("the code's hint shows under the line", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500, 35000, { welcome: true, audience: "first" }));
    await render();
    await applyCode("tere10");
    expect($("[data-discount-hint]")?.textContent).toBe("Kehtib uudiskirjaga liitunud aadressil ja ainult esimesel koolitusel.");
  });
});

describe("the total decides järelmaks and the contract", () => {
  const on = { financingSwitch: { enabled: true, paymentsOn: true } };

  test("järelmaks disappears under 100 € and the range line shows", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 1100, 11000));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render({ ...on, contract: { ...base.contract, priceCents: 11000 } });
    await act(async () => choices()[2].click());
    expect(choices().map((c) => c.checked)).toEqual([false, false, true]);
    expect($("[data-financing-range]")).toBeNull();
    await applyCode("tere10");
    expect($("[data-discount-total] strong")?.textContent).toBe("99 €");
    expect(choices().map((c) => [c.value, c.checked])).toEqual([["full", true], ["half", false]]);
    expect($("[data-financing-range]")?.textContent).toBe("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    expect($("[data-financing-line]")).toBeNull();
    // what is sent is the effective choice
    await fillIn();
    await submit();
    expect(mocks.registerContact.mock.calls[0][0].get("payment")).toBe("full");
  });

  test("removing the code brings järelmaks back as selected", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 1100, 11000));
    await render({ ...on, contract: { ...base.contract, priceCents: 11000 } });
    await act(async () => choices()[2].click());
    await applyCode("tere10");
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    expect(choices().map((c) => [c.value, c.checked])).toEqual([["full", false], ["half", false], ["financing", true]]);
    expect($("[data-financing-range]")).toBeNull();
  });

  test("another choice than järelmaks never says the range", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 1100, 11000));
    await render({ ...on, contract: { ...base.contract, priceCents: 11000 } });
    await applyCode("tere10");
    expect($("[data-financing-range]")).toBeNull();
  });

  test("a code can add järelmaks when the list is over 5 000 €", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("SUUR", 150000, 600000));
    await render({ ...on, contract: { ...base.contract, priceCents: 600000 } });
    expect(choices().map((c) => c.value)).toEqual(["full", "half"]);
    await applyCode("suur");
    expect($("[data-discount-total] strong")?.textContent).toBe("4 500 €");
    expect(choices().map((c) => c.value)).toEqual(["full", "half", "financing"]);
    expect($("[data-financing-line]")).not.toBeNull();
  });

  test("the inline contract shows the total", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    await act(async () => $<HTMLButtonElement>("[data-contract-toggle]")!.click());
    expect($("[data-contract-preview]")?.textContent).toContain("Hind on 350,00\u00a0€.");
    await applyCode("tere10");
    expect($("[data-contract-preview]")?.textContent).toContain("Hind on 315,00\u00a0€.");
  });
});

describe("remembering", () => {
  test("a remembered code is applied again on load", async () => {
    window.sessionStorage.setItem(KEY, "TERE10");
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    expect(mocks.checkDiscountCode.mock.calls[0][0].get("code")).toBe("TERE10");
    expect(appliedLine()).toContain("TERE10: −35 €");
    expect($("[data-discount-total] strong")?.textContent).toBe("315 €");
  });

  test("a remembered code refused on load shows the list price", async () => {
    window.sessionStorage.setItem(KEY, "SUVI2025");
    mocks.checkDiscountCode.mockResolvedValue(refused("ended"));
    await render();
    expect(errorText()).toBe("See sooduskood ei kehti enam.");
    expect(totalLine()).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("works with sessionStorage throwing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    await applyCode("tere10");
    expect(appliedLine()).toContain("TERE10");
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    expect(appliedLine()).toBeNull();
  });
});

describe("the submit", () => {
  test("a typed code is applied by the submit and sent with its discount", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("PROOV-16", 3500));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render();
    await openField();
    await type("proov-16");
    await fillIn();
    await submit();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["PROOV-16", "3500"]);
    expect(fd.get("code")).toBeNull();
  });

  test("an applied code is sent as it is, without another check", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render();
    await applyCode("tere10");
    await fillIn();
    await submit();
    expect(mocks.checkDiscountCode).toHaveBeenCalledTimes(1);
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["TERE10", "3500"]);
  });

  test("no code: the fields go empty, as the server expects", async () => {
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render();
    await fillIn();
    await submit();
    expect(mocks.checkDiscountCode).not.toHaveBeenCalled();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["", ""]);
  });

  test("a typed code refused by the submit's check is not sent", async () => {
    mocks.checkDiscountCode.mockResolvedValue(refused("unknown"));
    await render();
    await openField();
    await type("vale");
    await fillIn();
    await submit();
    expect(mocks.registerContact).not.toHaveBeenCalled();
    expect(errorText()).toBe("Sellist sooduskoodi ei ole.");
    expect($("[data-register-sent]")).toBeNull();
  });

  test("a person error keeps the code applied and the hint visible", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500, 35000, { welcome: true, audience: "first" }));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "person" } });
    await render();
    await applyCode("tere10");
    await fillIn();
    await submit();
    expect(appliedLine()).toContain("TERE10");
    expect(errorText()).toBe("Seda sooduskoodi ei saa selle e-posti aadressiga kasutada.");
    expect($("[data-discount-hint]")?.textContent).toContain("Kehtib uudiskirjaga liitunud");
    expect($("[data-discount-total] strong")?.textContent).toBe("315 €");
    expect(container.textContent).not.toContain("Midagi läks valesti.");
  });

  test("changed checks again and shows the new total", async () => {
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("TERE10", 3500)).mockResolvedValueOnce(ok("TERE10", 7000, 35000, { value: "20%" }));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "changed" } });
    await render();
    await applyCode("tere10");
    await fillIn();
    await submit();
    expect(mocks.checkDiscountCode).toHaveBeenCalledTimes(2);
    expect(appliedLine()).toContain("−70 €");
    expect($("[data-discount-total] strong")?.textContent).toBe("280 €");
    expect(errorText()).toBe("Sooduskood muutus vahepeal. Vaata uus hind üle ja proovi uuesti.");
  });

  test("a code the server refused for good is dropped and the check says why", async () => {
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("SUVI", 3500)).mockResolvedValueOnce(refused("usedUp"));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "usedUp" } });
    await render();
    await applyCode("suvi");
    await fillIn();
    await submit();
    expect(appliedLine()).toBeNull();
    expect(totalLine()).toBeNull();
    expect(errorText()).toBe("Selle sooduskoodi kasutuskorrad on otsas.");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("when the check cannot run, the submit's own refusal is said", async () => {
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("SUVI", 3500)).mockResolvedValueOnce(refused("server"));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "ended" } });
    await render();
    await applyCode("suvi");
    await fillIn();
    await submit();
    expect(appliedLine()).toBeNull();
    expect(errorText()).toBe("See sooduskood ei kehti enam.");
  });
});

describe("the individual request", () => {
  test("the individual request has no code field and sends no code", async () => {
    mocks.submitIndividual.mockResolvedValue({ ok: true });
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    await render();
    await applyCode("tere10"); // a code applied on the group view must not follow her to the request
    await act(async () => $<HTMLInputElement>("input[name='kind'][value='individual']")!.click());
    expect($("[data-discount]")).toBeNull();
    await act(async () => {
      setValue($<HTMLInputElement>("input[name='name']")!, "Kati Tamm");
      setValue($<HTMLInputElement>("input[name='email']")!, "kati@example.test");
      setValue($<HTMLInputElement>("input[name='phone']")!, "+372 5555 0101");
      setValue($<HTMLInputElement>("input[name='period']")!, "jaanuar");
    });
    await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
    await submit();
    expect(mocks.registerContact).not.toHaveBeenCalled();
    const fd = mocks.submitIndividual.mock.calls[0][0];
    expect([fd.has("discountCode"), fd.has("discountCents")]).toEqual([false, false]);
  });
});

describe("fix round 1: what the submit shows and sends", () => {
  const on = { financingSwitch: { enabled: true, paymentsOn: true }, contract: { ...base.contract, priceCents: 11000 } };

  test("a typed code applied at submit that takes järelmaks out of range is not sent as järelmaks", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 1100, 11000));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render(on);
    await act(async () => choices()[2].click());
    await openField();
    await type("tere10");
    await fillIn();
    await submit();
    // nothing is sent: she sees the 99 €, the flipped choice and the range line first
    expect(mocks.registerContact).not.toHaveBeenCalled();
    expect($("[data-discount-total] strong")?.textContent).toBe("99 €");
    expect(choices().map((c) => [c.value, c.checked])).toEqual([["full", true], ["half", false]]);
    expect($("[data-financing-range]")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-financing-range]"));
    // pressing Registreeru again sends it, as „100% kohe“, with the discount
    await submit();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("payment"), fd.get("discountCode"), fd.get("discountCents")]).toEqual(["full", "TERE10", "1100"]);
  });

  test("a typed code applied at submit sends with its discount when the effective choice did not change", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 1100, 11000));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render(on);
    await openField();
    await type("tere10");
    await fillIn();
    await submit();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("payment"), fd.get("discountCode"), fd.get("discountCents")]).toEqual(["full", "TERE10", "1100"]);
  });

  test("a refused typed code at submit moves focus to the code input", async () => {
    mocks.checkDiscountCode.mockResolvedValue(refused("unknown"));
    await render();
    await openField();
    await type("vale");
    await fillIn();
    await act(async () => $<HTMLButtonElement>("button[type='submit']")!.focus());
    await submit();
    expect(mocks.registerContact).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(codeInput());
  });

  test("a person refusal moves focus to the code's message", async () => {
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "person" } });
    await render();
    await applyCode("tere10");
    await fillIn();
    await submit();
    const message = $("[data-discount-error]")!;
    expect(message.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(message);
  });

  test("a refusal for good puts focus in the box again", async () => {
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("SUVI", 3500)).mockResolvedValueOnce(refused("usedUp"));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "usedUp" } });
    await render();
    await applyCode("suvi");
    await fillIn();
    await submit();
    expect(document.activeElement).toBe(codeInput());
  });
});

describe("fix round 1: late answers", () => {
  test("remove() while a check is in flight: the late ok does not apply the code again", async () => {
    let late!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockResolvedValueOnce(ok("TERE10", 3500)).mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (late = r)));
    mocks.registerContact.mockResolvedValue({ ok: false, errors: { discountCode: "changed" } });
    await render();
    await applyCode("tere10");
    await fillIn();
    await submit(); // `changed`: the re-check is now in flight
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    await act(async () => late(ok("TERE10", 7000)));
    await settle();
    expect(appliedLine()).toBeNull();
    expect(totalLine()).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("the mount re-check racing a typed apply: the typed code's answer wins", async () => {
    window.sessionStorage.setItem(KEY, "OLD");
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r))).mockResolvedValueOnce(ok("NEW", 3500));
    await render();
    await openField();
    await type("new");
    await apply();
    expect(appliedLine()).toContain("NEW");
    await act(async () => first(ok("OLD", 7000)));
    await settle();
    expect(appliedLine()).toContain("NEW");
    expect(appliedLine()).not.toContain("OLD");
    expect(window.sessionStorage.getItem(KEY)).toBe("NEW");
  });

  test("the mount re-check does not overwrite what the visitor started typing", async () => {
    window.sessionStorage.setItem(KEY, "OLD");
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r)));
    await render();
    await openField();
    await type("ne");
    await act(async () => first(refused("ended")));
    await settle();
    expect(codeInput().value).toBe("ne");
  });
});

describe("M4: a submit while the remembered code's re-check is still on its way", () => {
  test("waits for it and sends the code at the price it answers", async () => {
    window.sessionStorage.setItem(KEY, "TERE10");
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r)));
    mocks.registerContact.mockImplementation(() => new Promise(() => {})); // (still sending: the form stays on screen)
    await render();
    await fillIn();
    await submit();
    // nothing goes before the answer: the request would otherwise leave at the list price while the screen then shows the discount
    expect(mocks.registerContact).not.toHaveBeenCalled();
    await act(async () => first(ok("TERE10", 3500)));
    await settle();
    expect(mocks.checkDiscountCode).toHaveBeenCalledTimes(1);
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["TERE10", "3500"]);
    expect($("[data-discount-total] strong")?.textContent).toBe("315 €");
  });

  test("a refusal it answers is what a finished check leaves: sent without the code, at the list price the field shows", async () => {
    window.sessionStorage.setItem(KEY, "SUVI2025");
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r)));
    mocks.registerContact.mockImplementation(() => new Promise(() => {}));
    await render();
    await fillIn();
    await submit();
    expect(mocks.registerContact).not.toHaveBeenCalled();
    await act(async () => first(refused("ended")));
    await settle();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["", ""]);
    expect(errorText()).toBe("See sooduskood ei kehti enam.");
    expect(totalLine()).toBeNull();
  });

  test("once it has answered, a later Eemalda wins: the next submit sends no code", async () => {
    window.sessionStorage.setItem(KEY, "TERE10");
    mocks.checkDiscountCode.mockResolvedValue(ok("TERE10", 3500));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render();
    expect(appliedLine()).toContain("TERE10");
    await act(async () => $<HTMLButtonElement>("[data-discount-remove]")!.click());
    await fillIn();
    await submit();
    const fd = mocks.registerContact.mock.calls[0][0];
    expect([fd.get("discountCode"), fd.get("discountCents")]).toEqual(["", ""]);
  });
});

describe("fix round 2: her typing is newer than the remembered code", () => {
  test("typing during the remembered code's re-check wins over its answer", async () => {
    window.sessionStorage.setItem(KEY, "TERE10");
    let first!: (a: CheckAnswer) => void;
    mocks.checkDiscountCode.mockImplementationOnce(() => new Promise<CheckAnswer>((r) => (first = r))).mockResolvedValueOnce(ok("PROOV-16", 3500));
    mocks.registerContact.mockResolvedValue({ ok: true });
    await render();
    await openField();
    await type("PROOV-16");
    await act(async () => first(ok("TERE10", 7000)));
    await settle();
    expect(appliedLine()).toBeNull();
    expect(errorText()).toBeNull();
    expect(codeInput().value).toBe("PROOV-16");
    expect(window.sessionStorage.getItem(KEY)).toBe("TERE10");
    await fillIn();
    await submit();
    expect(mocks.checkDiscountCode.mock.calls[1][0].get("code")).toBe("PROOV-16");
    expect(mocks.registerContact.mock.calls[0][0].get("discountCode")).toBe("PROOV-16");
  });
});
