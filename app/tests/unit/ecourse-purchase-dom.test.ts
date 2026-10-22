// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EcoursePurchase, type EcoursePurchaseTexts } from "@/components/site/EcoursePurchase";

// The e-course cart's purchase form (phase 2b, spec 6.4, D3): name, e-mail, the box (the e-course contract with „Loe lepingut“: contracts, D1;
// tests/unit/contract-preview-dom.test.ts fills it), the newsletter box and "Maksa 190 €";
// filled from the account when the browser is signed in; the action's paymentUrl is where the page goes; "unavailable" shows the
// purchase-interest form instead. The action and the navigation are stood in for here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ buyEcourse: vi.fn<(fd: FormData) => Promise<unknown>>(), navigate: vi.fn<(url: string) => void>(), address: { search: "" } }));
vi.mock("@/server/actions/public", () => ({ buyEcourse: mocks.buyEcourse }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// the cart is one cached page per course: its address (?makse=jarelmaks from the result page's „Proovi uuesti“) is read in the browser
vi.mock("@/lib/url-query", () => ({ useUrlQuery: () => [new URLSearchParams(mocks.address.search), vi.fn()] }));

const t: EcoursePurchaseTexts = {
  name: "Nimi",
  email: "E-post",
  contractTerms: "Olen tutvunud lepingu tingimustega ja nõustun nendega.",
  readContract: "Loe lepingut",
  contractChanged: "Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita.",
  newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi",
  paymentLabel: "Tasumine",
  payBank: "Pangalink",
  payFinancing: "Järelmaks (Inbank)",
  financingRange: "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.",
  financingOff: "Järelmaks pole praegu saadaval. Saad maksta pangalingiga.",
  submit: "Maksa 190 €",
  starting: "Avan makse…",
  alreadyPaid: "Makse on juba tehtud — vaata oma e-posti.",
  errorRequired: "See väli on kohustuslik.",
  errorEmail: "Sisesta korrektne e-posti aadress.",
  errorTooMany: "Liiga palju katseid. Proovi mõne minuti pärast.",
  errorGeneric: "Midagi läks valesti. Proovi uuesti.",
};
const contract = { version: "2026-10-01T00:00:00.000Z", title: "E-koolituse tingimused", body: "Tere {nimi}, hind {hind}.", locale: "et" as const, course: "Kulmumeistri e-koolitus", priceCents: 19000 };
const props = { financing: false, course: "kulmumeistri-e-koolitus", locale: "et" as const, t, contract, fallback: createElement("p", { "data-fallback": "" }, "Makse lisandub peagi") };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-ecourse-form]")!.requestSubmit());
  await settle();
};
const type = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  mocks.buyEcourse.mockReset();
  mocks.navigate.mockReset();
  mocks.address.search = "";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  document.cookie = "mslab_in=; max-age=0";
});

test("the markup: a POST form with name, e-mail, the box with „Loe lepingut“ (no link away: the contract opens in the cart), the newsletter box (unticked), the course, the honeypot and 'Maksa 190 €'", () => {
  const html = renderToStaticMarkup(createElement(EcoursePurchase, props));
  // either order of the two attributes (React 19 writes a form's `method` after the others)
  expect(html).toMatch(/<form\b(?=[^>]*\bmethod="post")(?=[^>]*\bdata-ecourse-form="")[^>]*>/);
  for (const part of ['name="name"', 'name="email"', 'name="terms"', 'name="newsletter"', 'name="course" value="kulmumeistri-e-koolitus"', 'name="locale" value="et"', 'name="website"', 'name="contractVersion" value="2026-10-01T00:00:00.000Z"', "Olen tutvunud lepingu tingimustega ja nõustun nendega.", "Loe lepingut", "Maksa 190 €"])
    expect(html).toContain(part);
  expect(html).not.toContain('href="/tingimused"');
  expect(html).not.toMatch(/name="newsletter"[^>]*checked/);
  // the server renders it for everyone: nothing personal in it, and no price field to trust
  expect(html).not.toMatch(/name="(price|amount)/);
  expect(html).not.toMatch(/name="(name|email)"[^>]*value="[^"]/);
});

test("a paid start: the button says 'Avan makse…' and the page goes to Montonio", async () => {
  mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await submit();
  const sent = mocks.buyEcourse.mock.calls[0][0];
  expect([sent.get("name"), sent.get("email"), sent.get("terms"), sent.get("newsletter"), sent.get("course")]).toEqual(["Kati Tamm", "kati@example.test", "on", null, "kulmumeistri-e-koolitus"]);
  expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-1");
  expect($("button[type='submit']")!.textContent).toBe("Avan makse…");
});

test("the newsletter box ticked goes with the purchase; a second press while the page opens sends nothing more", async () => {
  mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await act(async () => $<HTMLInputElement>("input[name='newsletter']")!.click());
  await submit();
  await submit(); // the button says 'Avan makse…': the page is on its way
  expect(mocks.buyEcourse).toHaveBeenCalledTimes(1);
  expect(mocks.buyEcourse.mock.calls[0][0].get("newsletter")).toBe("on");
});

test("Back from Montonio (the page comes from the back-forward cache): the button is ready again, and only then", async () => {
  mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await submit();
  expect($("button[type='submit']")!.textContent).toBe("Avan makse…");
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false })));
  expect($("button[type='submit']")!.textContent).toBe("Avan makse…");
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
  expect($("button[type='submit']")!.textContent).toBe("Maksa 190 €");
  expect($<HTMLInputElement>("input[name='name']")!.value).toBe("Kati Tamm"); // what she typed is still there
});

test("a payment page that is no web page is never navigated to: the interest form takes the place", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: true, paymentUrl: "javascript:alert(1)" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await submit();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect($("[data-fallback]")).not.toBeNull();
});

test("paid a moment ago ('alreadyPaid'): the line takes the form's place, and nothing else — not the interest form, no amount, no name; nothing is navigated to", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "alreadyPaid" } });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await submit();
  const line = $("[role='status']")!;
  expect(line.textContent).toBe("Makse on juba tehtud — vaata oma e-posti.");
  expect(document.activeElement).toBe(line);
  expect($("[data-ecourse-form]")).toBeNull();
  expect($("[data-fallback]")).toBeNull();
  expect(container.textContent).toBe("Makse on juba tehtud — vaata oma e-posti.");
  expect(container.textContent).not.toMatch(/Kati|kati@|€/);
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("the payer presses Back from the bank (the page comes from the back-forward cache) and 'Maksa' again: the line, not a second payment", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Kati Tamm");
  await type("input[name='email']", "kati@example.test");
  await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
  await submit();
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
  expect($("button[type='submit']")!.textContent).toBe("Maksa 190 €");
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "alreadyPaid" } });
  await submit();
  expect($("[role='status']")!.textContent).toBe("Makse on juba tehtud — vaata oma e-posti.");
  expect($("[data-ecourse-form]")).toBeNull();
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
});

test("errors: the first field with one takes the focus; 'unavailable' shows the purchase-interest form instead", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { name: "required", terms: "required" } });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await submit();
  expect(document.activeElement).toBe($("input[name='name']"));
  expect($("input[name='terms']")!.getAttribute("aria-invalid")).toBe("true");
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "unavailable" } });
  await submit();
  expect($("[data-fallback]")!.textContent).toBe("Makse lisandub peagi");
  expect($("[data-ecourse-form]")).toBeNull();
});

test("an e-mail the server refuses is said under the e-mail; too many presses and anything else are said above the button, and take the focus", async () => {
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { email: "invalid" } });
  await submit();
  expect(document.activeElement).toBe($("input[name='email']"));
  expect($("#" + $("input[name='email']")!.getAttribute("aria-describedby"))!.textContent).toBe("Sisesta korrektne e-posti aadress.");
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "rate" } });
  await submit();
  expect($("[role='alert']")!.textContent).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
  expect(document.activeElement).toBe($("[role='alert']"));
  mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { form: "server" } });
  await submit();
  expect($("[role='alert']")!.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
  mocks.buyEcourse.mockRejectedValueOnce(new Error("network"));
  await submit();
  expect($("[role='alert']")!.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("an answer that is ok but has no payment page (the honeypot's) gives way to the purchase-interest form, never a blank page", async () => {
  mocks.buyEcourse.mockResolvedValueOnce({ ok: true });
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await submit();
  expect($("[data-fallback]")).not.toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("not signed in on this browser (no hint cookie): /api/konto/me is not asked", async () => {
  const me = vi.fn(async () => new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", me);
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await settle();
  expect(me).not.toHaveBeenCalled();
  expect([$<HTMLInputElement>("input[name='name']")!.value, $<HTMLInputElement>("input[name='email']")!.value]).toEqual(["", ""]);
});

test("signed in on this browser (the hint cookie): her name and e-mail from /api/konto/me, never over what she typed", async () => {
  document.cookie = "mslab_in=1";
  const me = vi.fn(async () => new Response(JSON.stringify({ ok: true, email: "kati@example.test", name: "Kati Tamm" }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", me);
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await settle();
  expect(me).toHaveBeenCalledWith("/api/konto/me", expect.objectContaining({ credentials: "same-origin" }));
  expect([$<HTMLInputElement>("input[name='name']")!.value, $<HTMLInputElement>("input[name='email']")!.value]).toEqual(["Kati Tamm", "kati@example.test"]);
});

test("what she typed before the answer came is kept; a hint with no session (401) or a broken answer leaves the fields empty", async () => {
  document.cookie = "mslab_in=1";
  let answer!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
  await act(async () => root.render(createElement(EcoursePurchase, props)));
  await type("input[name='name']", "Mari Mägi");
  await act(async () => answer(new Response(JSON.stringify({ ok: true, email: "kati@example.test", name: "Kati Tamm" }))));
  await settle();
  expect([$<HTMLInputElement>("input[name='name']")!.value, $<HTMLInputElement>("input[name='email']")!.value]).toEqual(["Mari Mägi", "kati@example.test"]);

  await act(async () => root.unmount());
  root = createRoot(container);
  for (const response of [new Response("{}", { status: 401 }), new Response("not json", { status: 200 }), new Response(JSON.stringify({ ok: false }), { status: 200 })]) {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await act(async () => root.render(createElement(EcoursePurchase, props)));
    await settle();
    expect([$<HTMLInputElement>("input[name='name']")!.value, $<HTMLInputElement>("input[name='email']")!.value]).toEqual(["", ""]);
    await act(async () => root.unmount());
    root = createRoot(container);
  }
});

// ---------- Järelmaks (Inbank) in the cart (instalments D4, §4, Task 6) ----------
// The choice „Pangalink“ (the default) / „Järelmaks (Inbank)“ shows only while the page says it is offered (the cart reads the toggle, the price and the
// payments setting); the form then sends `method`, the way the start is made (paymentInitiation | hirePurchase). Otherwise the cart is as it was: no field.

describe("Järelmaks (Inbank) in the cart", () => {
  const offered = { ...props, financing: true };
  const methods = () => [...container.querySelectorAll<HTMLInputElement>("input[name='method']")];
  const fillAndSubmit = async () => {
    await type("input[name='name']", "Kati Tamm");
    await type("input[name='email']", "kati@example.test");
    await act(async () => $<HTMLInputElement>("input[name='terms']")!.click());
    await submit();
  };

  test("not offered: no choice and no field, as today — the server starts the bank link", async () => {
    mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" });
    await act(async () => root.render(createElement(EcoursePurchase, props)));
    expect(methods()).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Järelmaks|Pangalink/);
    expect(renderToStaticMarkup(createElement(EcoursePurchase, props))).not.toContain('name="method"');
    await fillAndSubmit();
    expect(mocks.buyEcourse.mock.calls[0][0].get("method")).toBeNull();
  });

  test("offered: „Pangalink“ (the default) and „Järelmaks (Inbank)“, both enabled, in a group labelled „Tasumine“", async () => {
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    expect(methods().map((m) => [m.value, m.checked, m.disabled, m.closest("label")!.textContent])).toEqual([
      ["paymentInitiation", true, false, "Pangalink"],
      ["hirePurchase", false, false, "Järelmaks (Inbank)"],
    ]);
    expect(methods()[0].closest("fieldset")!.querySelector("legend")!.textContent).toBe("Tasumine");
    // the server renders the choice for everyone, with the bank link chosen
    expect(renderToStaticMarkup(createElement(EcoursePurchase, offered))).toMatch(/<input(?=[^>]*name="method")(?=[^>]*value="paymentInitiation")(?=[^>]*checked="")[^>]*>/); // (either order of the attributes)
  });

  test("the bank link is sent as paymentInitiation; „Järelmaks (Inbank)“ chosen is sent as hirePurchase, and the page goes where the start says", async () => {
    mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/loan-1" });
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    await fillAndSubmit();
    expect(mocks.buyEcourse.mock.calls[0][0].get("method")).toBe("paymentInitiation");
    await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))); // (back from the bank)
    await act(async () => methods()[1].click());
    expect(methods().map((m) => m.checked)).toEqual([false, true]);
    await submit();
    expect(mocks.buyEcourse.mock.calls[1][0].get("method")).toBe("hirePurchase");
    expect(mocks.navigate).toHaveBeenLastCalledWith("https://sandbox-stargate.montonio.com/loan-1");
  });

  test("the result page's „Proovi uuesti“ (?makse=jarelmaks) opens the cart with the järelmaks chosen; anything else, or the choice not offered, is the bank link", async () => {
    mocks.address.search = "kursus=kulmumeistri-e-koolitus&makse=jarelmaks";
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    expect(methods().map((m) => m.checked)).toEqual([false, true]);
    mocks.buyEcourse.mockResolvedValue({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/loan-2" });
    await fillAndSubmit();
    expect(mocks.buyEcourse.mock.calls[0][0].get("method")).toBe("hirePurchase");
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.address.search = "kursus=kulmumeistri-e-koolitus&makse=pangalink";
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    expect(methods().map((m) => m.checked)).toEqual([true, false]);
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.address.search = "makse=jarelmaks";
    await act(async () => root.render(createElement(EcoursePurchase, props))); // not offered now: no choice, nothing to choose
    expect(methods()).toHaveLength(0);
  });

  test("a järelmaks the server refuses because the price is out of 100–5000 € now: the range is said at the choice, the bank link is chosen, nothing is navigated to", async () => {
    mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { method: "financing" } });
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    await act(async () => methods()[1].click());
    await fillAndSubmit();
    const note = $("[data-financing-range]")!;
    expect(note.textContent).toBe("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    expect(methods()[0].closest("fieldset")!.contains(note)).toBe(true); // at the choice
    expect(methods().map((m) => m.checked)).toEqual([true, false]); // the next press is by bank
    expect(methods()[1].getAttribute("aria-describedby")).toBe(note.id);
    expect(document.activeElement).toBe(methods()[0]);
    expect($("[role='alert']")).toBeNull(); // not the generic line
    expect(mocks.navigate).not.toHaveBeenCalled();
    // and the next press, by bank, starts
    mocks.buyEcourse.mockResolvedValueOnce({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-3" });
    await submit();
    expect(mocks.buyEcourse.mock.calls[1][0].get("method")).toBe("paymentInitiation");
    expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-3");
  });

  test("a järelmaks the server refuses because it was switched off (the price within the range): its own sentence at the choice, not the range; the bank link is chosen, nothing is navigated to", async () => {
    mocks.buyEcourse.mockResolvedValueOnce({ ok: false, errors: { method: "financingOff" } });
    await act(async () => root.render(createElement(EcoursePurchase, offered)));
    await act(async () => methods()[1].click());
    await fillAndSubmit();
    const note = $("[data-financing-range]")!;
    expect(note.textContent).toBe("Järelmaks pole praegu saadaval. Saad maksta pangalingiga.");
    expect(note.textContent).not.toContain("100–5000");
    expect(methods()[0].closest("fieldset")!.contains(note)).toBe(true); // at the choice
    expect(methods().map((m) => m.checked)).toEqual([true, false]); // the next press is by bank
    expect(methods()[1].getAttribute("aria-describedby")).toBe(note.id);
    expect(document.activeElement).toBe(methods()[0]);
    expect($("[role='alert']")).toBeNull(); // not the generic line
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.buyEcourse.mockResolvedValueOnce({ ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-4" });
    await submit();
    expect(mocks.buyEcourse.mock.calls[1][0].get("method")).toBe("paymentInitiation");
    expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-4");
  });
});
