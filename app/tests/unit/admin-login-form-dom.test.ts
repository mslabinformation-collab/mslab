// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ADMIN_EMAIL_KEY, LoginForm, type LoginTexts } from "@/app/admin/login/LoginForm";
import { adminEt } from "@/i18n/dict/admin";
import { stubFetch } from "../fakes";

// C8 Sisselogimine (admin UX pass piece 4c, Task 5; README §4 C8, texts S4-47a–d): the remembered address with „Muu aadress“ (R-h), the way back
// sent with the request (B19, R-f: the page's ?tagasi= and the address bar's #fragment), the sent state that names the address, and the 4th
// request's own message (B20, R-g). The request is answered here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const l = adminEt.login;
/** The texts as the login page hands them on. */
const t: LoginTexts = {
  emailLabel: l.emailLabel,
  submit: l.submit,
  sending: l.sending,
  sentTitle: l.sentTitle,
  sent: l.sent,
  sentHint: l.sentHint,
  other: l.other,
  errorEmail: l.errorEmail,
  errorTooMany: l.errorTooMany,
  errorAddress: l.errorAddress,
  errorGeneric: l.errorGeneric,
};

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const field = () => $<HTMLInputElement>('input[name="email"]')!;
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name && !b.closest("[hidden]")) ?? null;
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (props: Partial<Parameters<typeof LoginForm>[0]> = {}) => {
  await act(async () => root.render(createElement(LoginForm, { t, ...props })));
  await settle();
};
const type = (value: string) =>
  act(async () => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => void $<HTMLFormElement>("[data-login-form]")!.requestSubmit());
  await settle();
};
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => void (el as HTMLElement).click());
  await settle();
};
const sentBody = (calls: ReturnType<typeof stubFetch>["calls"]) => calls.map((c) => c.body);
const raf = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/admin/login");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the texts (S4-47)", () => {
  test("the lead, the sent state, „Muu aadress“ and the 4th request's message are the approved ones; the per-IP limit keeps ADM:57", () => {
    expect(l.lead).toBe("Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.");
    expect(l.sentTitle).toBe("Link on teel");
    expect(l.sent).toBe("Saatsime lingi aadressile {email}. See kehtib 15 minutit.");
    expect(l.sentHint).toBe("Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.");
    expect(l.other).toBe("Muu aadress");
    expect(l.errorAddress).toBe("Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.");
    expect(l.errorTooMany).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
  });
});

describe("the remembered address (R-h)", () => {
  test("is filled in from localStorage mslab-admin-email, with „Muu aadress“ beside it", async () => {
    localStorage.setItem(ADMIN_EMAIL_KEY, "admin@example.test");
    expect(ADMIN_EMAIL_KEY).toBe("mslab-admin-email");
    await render();
    expect(field().value).toBe("admin@example.test");
    expect(button("Muu aadress")).not.toBeNull();
  });

  test("„Muu aadress“ empties the field and puts the cursor there; then it is gone (nothing left to clear)", async () => {
    localStorage.setItem(ADMIN_EMAIL_KEY, "admin@example.test");
    await render();
    await click(button("Muu aadress"));
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(button("Muu aadress")).toBeNull();
    expect(localStorage.getItem(ADMIN_EMAIL_KEY)).toBe("admin@example.test"); // the next sent answer replaces it
  });

  test("nothing remembered, or storage blocked: an empty field and no „Muu aadress“", async () => {
    await render();
    expect(field().value).toBe("");
    expect(button("Muu aadress")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await render();
    expect(field().value).toBe("");
    expect(button("Muu aadress")).toBeNull();
  });

  test("is written only after a sent answer: not after a refused or failed one", async () => {
    const answers = [Response.json({ ok: false, error: "email" }, { status: 400 }), Response.json({ ok: false, error: "address" }, { status: 429 }), Response.json({ ok: false, error: "server" }, { status: 500 })];
    stubFetch(() => answers.shift() ?? Response.json({ ok: true }));
    await render();
    await type("admin@example.test");
    for (let i = 0; i < 3; i++) {
      await submit();
      expect(localStorage.getItem(ADMIN_EMAIL_KEY), String(i)).toBeNull();
    }
    await submit();
    expect(localStorage.getItem(ADMIN_EMAIL_KEY)).toBe("admin@example.test");
  });

  test("a blocked storage on writing changes nothing she sees", async () => {
    stubFetch(() => Response.json({ ok: true }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await render();
    await type("admin@example.test");
    await submit();
    expect($("[data-login-status]")!.textContent).toContain("Link on teel");
  });
});

describe("the request: the address and the way back (B19)", () => {
  test("the address and the page's ?tagasi= with the address bar's #fragment (which never reaches the server)", async () => {
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    history.replaceState(null, "", "/admin/login?tagasi=%2Fadmin%2Ftestimine#kirjad-halduse-link");
    await render({ tagasi: "/admin/testimine" });
    await type(" admin@example.test ");
    await submit();
    expect(calls[0]).toMatchObject({ url: "/api/auth/request", method: "POST" });
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    // (an e-mail field drops the spaces around its value itself)
    expect(sentBody(calls)).toEqual([{ email: "admin@example.test", tagasi: "/admin/testimine#kirjad-halduse-link" }]);
  });

  test("a way back that has its fragment already (SaveStatus's link) keeps it, and the address bar's is not added twice", async () => {
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    history.replaceState(null, "", "/admin/login?tagasi=%2Fadmin%2Ftestimine%23x#y");
    await render({ tagasi: "/admin/testimine#x" });
    await type("admin@example.test");
    await submit();
    expect(sentBody(calls)).toEqual([{ email: "admin@example.test", tagasi: "/admin/testimine#x" }]);
  });

  test("no ?tagasi=: only a #fragment is sent with the panel's front page, and nothing at all without one", async () => {
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    await render();
    await type("admin@example.test");
    await submit();
    history.replaceState(null, "", "/admin/login#x");
    await click(button("Muu aadress"));
    await type("admin@example.test");
    await submit();
    expect(sentBody(calls)).toEqual([{ email: "admin@example.test" }, { email: "admin@example.test", tagasi: "/admin#x" }]);
  });
});

describe("the sent state (S4-47c)", () => {
  test("„Link on teel“, the address it went to in bold, the hint and „Muu aadress“; the status region takes the focus", async () => {
    stubFetch(() => Response.json({ ok: true }));
    await render();
    await type(" admin@example.test ");
    await submit();
    const status = $("[data-login-status]")!;
    expect(status.querySelector("h2")!.textContent).toBe("Link on teel");
    expect(status.querySelector("[data-login-sent]")!.textContent).toBe("Saatsime lingi aadressile admin@example.test. See kehtib 15 minutit.");
    expect(status.querySelector("[data-login-sent] b")!.textContent).toBe("admin@example.test");
    expect(status.textContent).toContain("Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.");
    expect(document.activeElement).toBe(status);
    expect($("[data-login-form]")!.hidden).toBe(true);
    expect(button("Muu aadress")?.closest("[data-login-status]")).toBe(status);
    expect(localStorage.getItem(ADMIN_EMAIL_KEY)).toBe("admin@example.test");
  });

  test("„Muu aadress“ there returns to the form with an empty field and the cursor in it", async () => {
    stubFetch(() => Response.json({ ok: true }));
    await render();
    await type("admin@example.test");
    await submit();
    await click(button("Muu aadress"));
    await raf();
    expect($("[data-login-form]")!.hidden).toBe(false);
    expect($("[data-login-status]")!.textContent).toBe("");
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
  });

  test("the same state for any address: the server's answer is the same, so is the page (SPEC S4)", async () => {
    stubFetch(() => Response.json({ ok: true }));
    await render();
    await type("someone@example.test");
    await submit();
    expect($("[data-login-sent]")!.textContent).toBe("Saatsime lingi aadressile someone@example.test. See kehtib 15 minutit.");
  });
});

describe("the limits", () => {
  const refused = async (answer: () => Response) => {
    stubFetch(answer);
    await render();
    await type("admin@example.test");
    await submit();
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
    return { text: alert.textContent, focused: document.activeElement === alert, sent: $("[data-login-status]")!.textContent };
  };

  test("B20: the 4th request for the address (429 `address`) says so, focused, and claims nothing was sent", async () => {
    expect(await refused(() => Response.json({ ok: false, error: "address" }, { status: 429 }))).toEqual({ text: "Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.", focused: true, sent: "" });
    expect(field().value).toBe("admin@example.test"); // the address stays in the field
  });

  test("the per-IP limit (429 `rate`) keeps its own words, and so does a 429 whose answer cannot be read", async () => {
    expect((await refused(() => Response.json({ ok: false, error: "rate" }, { status: 429 }))).text).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
    await act(async () => root.unmount());
    root = createRoot(container);
    expect((await refused(() => new Response("<html>", { status: 429 }))).text).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
  });

  test("a wrong address and a failure keep their words", async () => {
    expect((await refused(() => Response.json({ ok: false, error: "server" }, { status: 500 }))).text).toBe("Midagi läks valesti. Proovi uuesti.");
    await act(async () => root.unmount());
    root = createRoot(container);
    stubFetch(() => Response.json({ ok: false, error: "email" }, { status: 400 }));
    await render();
    await type("vale");
    await submit();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
  });
});
