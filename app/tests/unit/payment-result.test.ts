// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PaymentResult, type PaymentResultTexts } from "@/components/site/PaymentResult";
import { parseResultFragment, resultFragment } from "@/domain/payments";
import { getDict } from "@/i18n/locales";

// /makse (phase 2b, spec 6.5): where the bank sends the payer back. The result is in the fragment (#tulemus=…&liik=…[&maksa=…][&kursus=…]),
// which no server or cache sees; the static page reads it in the browser and says what happened, with "Proovi uuesti" or the way on.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "AbC_d-0123456789012345678901234567890123";

describe("the fragment", () => {
  test("a Järelmaks (Inbank) is liik=jarelmaks, written and read back with its way on", () => {
    const registration = { outcome: "pooleli" as const, kind: "jarelmaks" as const, payToken: TOKEN, course: null };
    expect(resultFragment(registration)).toBe(`tulemus=pooleli&liik=jarelmaks&maksa=${TOKEN}`);
    expect(parseResultFragment(`#${resultFragment(registration)}`)).toEqual(registration);
    const ecourse = { outcome: "katkestatud" as const, kind: "jarelmaks" as const, payToken: null, course: "kulmumeistri-e-koolitus" };
    expect(resultFragment(ecourse)).toBe("tulemus=katkestatud&liik=jarelmaks&kursus=kulmumeistri-e-koolitus");
    expect(parseResultFragment(`#${resultFragment(ecourse)}`)).toEqual(ecourse);
    expect(parseResultFragment("#tulemus=pooleli&liik=jarelmaks")).toEqual({ outcome: "pooleli", kind: "jarelmaks", payToken: null, course: null });
  });

  test("written and read back; what cannot be ours is dropped", () => {
    const view = { outcome: "katkestatud" as const, kind: "registreering" as const, payToken: TOKEN, course: null };
    expect(resultFragment(view)).toBe(`tulemus=katkestatud&liik=registreering&maksa=${TOKEN}`);
    expect(parseResultFragment(`#${resultFragment(view)}`)).toEqual(view);
    expect(parseResultFragment("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus")).toEqual({ outcome: "makstud", kind: "ekoolitus", payToken: null, course: "kulmumeistri-e-koolitus" });
    expect(parseResultFragment("tulemus=pooleli")).toEqual({ outcome: "pooleli", kind: null, payToken: null, course: null });
    expect(parseResultFragment("#tulemus=makstud&liik=x&maksa=%3Cscript%3E&kursus=Not%20A%20Slug")).toEqual({ outcome: "makstud", kind: null, payToken: null, course: null });
    for (const hash of ["", "#", "#main", "#tulemus=paid", "#liik=registreering"]) expect(parseResultFragment(hash), hash).toBeNull();
  });

  test("it carries the outcome, the kind, the pay token and the slug — nothing else: no address, no Montonio uuid, no amount", () => {
    const all = { outcome: "pooleli" as const, kind: "ekoolitus" as const, payToken: TOKEN, course: "kulmumeistri-e-koolitus" };
    expect([...new URLSearchParams(resultFragment(all)).keys()]).toEqual(["tulemus", "liik", "maksa", "kursus"]);
    expect([...new URLSearchParams(resultFragment({ outcome: "katkestatud", kind: null, payToken: null, course: null })).keys()]).toEqual(["tulemus"]);
    // what is read back is only what the page knows: another key in the address is never passed on
    expect(parseResultFragment("#tulemus=makstud&email=kati%40example.test&summa=175&uuid=abc&liik=registreering")).toEqual({ outcome: "makstud", kind: "registreering", payToken: null, course: null });
  });

  test("a token or slug of the wrong shape or length is dropped, not shortened or escaped", () => {
    for (const bad of ["a".repeat(19), "a".repeat(101), "a b".padEnd(30, "c"), "é".repeat(30), `${"a".repeat(30)}/..`, `${"a".repeat(30)}?x=1`])
      expect(parseResultFragment(`#tulemus=katkestatud&liik=registreering&maksa=${encodeURIComponent(bad)}`)?.payToken, bad).toBeNull();
    for (const bad of ["-x", "x-", "x--y", "X", "x_y", "x/y", "x?y", "../x", "a".repeat(81), "a".repeat(121)])
      expect(parseResultFragment(`#tulemus=katkestatud&liik=ekoolitus&kursus=${encodeURIComponent(bad)}`)?.course, bad).toBeNull();
    // the slug rule is the admin's own (lib/slug.ts isSlug): the longest slug it stores still comes through
    expect(parseResultFragment(`#tulemus=katkestatud&liik=ekoolitus&kursus=${"a".repeat(80)}`)?.course).toBe("a".repeat(80));
  });
});

describe("the page", () => {
  const d = getDict("et");
  const t: PaymentResultTexts = { ...d.payment.result, payBank: d.payment.payBank, account: d.account.shell.courses };
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.location.hash = "";
  });
  const show = async (hash: string, locale: "et" | "ru" = "et", texts = t) => {
    window.location.hash = hash;
    await act(async () => root.render(createElement(PaymentResult, { locale, t: texts })));
  };
  const links = () => [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
  const line = () => container.querySelector("p")?.textContent ?? null;

  test("makstud: 'Makse õnnestus. …' and Minu koolitused; an e-course: 'Makse õnnestus.', where her login is, and 'Ava e-koolitus'", async () => {
    await show("#tulemus=makstud&liik=registreering");
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
    expect(line()).toBeNull();
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    // the owner's wording (09.10): a buyer who is not signed in learns where her login is
    await show("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus");
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus.");
    expect(line()).toBe("Saatsime sulle e-postiga sisselogimislingi.");
    expect(container.textContent).not.toContain("kinnituse");
    expect(links()).toEqual([["Ava e-koolitus", "/konto/kursus/kulmumeistri-e-koolitus"]]);
    // an e-course without a (valid) slug: the same sentences, the way on is Minu koolitused
    await show("#tulemus=makstud&liik=ekoolitus&kursus=Not%20A%20Slug");
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus.");
    expect(line()).toBe("Saatsime sulle e-postiga sisselogimislingi.");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    // no kind: the registration's sentence
    await show("#tulemus=makstud");
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
  });

  test("katkestatud and pooleli: the sentence, 'Proovi uuesti' (the /maksa page, or the cart) and Minu koolitused", async () => {
    await show(`#tulemus=katkestatud&liik=registreering&maksa=${TOKEN}`);
    expect(container.querySelector("h1")?.textContent).toBe("Makse jäi tegemata.");
    expect(links()).toEqual([["Proovi uuesti", `/maksa/${TOKEN}`], ["Minu koolitused", "/konto"]]);
    await show("#tulemus=pooleli&liik=ekoolitus&kursus=kulmumeistri-e-koolitus");
    expect(container.querySelector("h1")?.textContent).toBe("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
    expect(links()).toEqual([["Proovi uuesti", "/ostukorv?kursus=kulmumeistri-e-koolitus"], ["Minu koolitused", "/konto"]]);
    await show("#tulemus=katkestatud");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
  });

  test("never 'Proovi uuesti' without the way the return gave: a held payment (the money is at Montonio) comes back as pooleli with no token and no slug", async () => {
    await show("#tulemus=pooleli&liik=registreering");
    expect(container.querySelector("h1")?.textContent).toBe("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    expect(container.querySelector("[data-payment-retry]")).toBeNull();
    await show("#tulemus=pooleli&liik=ekoolitus");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    // and a paid one never offers it, whatever the address carries
    await show(`#tulemus=makstud&liik=registreering&maksa=${TOKEN}`);
    expect(container.querySelector("[data-payment-retry]")).toBeNull();
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
  });

  test("the address is only read, never printed or followed: a script in it, a foreign path, a made-up token", async () => {
    await show("#tulemus=katkestatud&liik=registreering&maksa=%3Cscript%3Ealert(1)%3C%2Fscript%3E&kursus=..%2F..%2Fadmin");
    expect(container.innerHTML).not.toContain("<script");
    expect(container.innerHTML).not.toContain("admin");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    await show(`#tulemus=katkestatud&liik=registreering&maksa=${TOKEN}&next=https%3A%2F%2Fevil.example&url=%2F%2Fevil.example`);
    expect(container.innerHTML).not.toContain("evil");
    for (const [, hrefValue] of links()) expect(hrefValue).toMatch(/^\/(maksa\/[A-Za-z0-9_-]+|konto)$/);
  });

  describe("a Järelmaks (Inbank) that is not decided (instalments §4)", () => {
    const forms = () => [...container.querySelectorAll("form")].map((f) => [f.getAttribute("method"), f.getAttribute("action"), f.querySelector("input[name='method']")?.getAttribute("value"), f.querySelector("button")?.textContent]);

    test("a registration's: the application's sentence, then „Maksa pangalingiga“ (the bank) and „Proovi uuesti“ (Inbank again), each a button that posts to the registration's /maksa page; not the bank's sentence", async () => {
      await show(`#tulemus=pooleli&liik=jarelmaks&maksa=${TOKEN}`);
      expect(container.querySelector("h1")?.textContent).toBe("Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.");
      expect(container.textContent).not.toContain("Kui pank");
      expect(forms()).toEqual([
        ["post", `/maksa/${TOKEN}`, "paymentInitiation", "Maksa pangalingiga"],
        ["post", `/maksa/${TOKEN}`, "hirePurchase", "Proovi uuesti"],
      ]);
      expect(container.querySelector("[data-payment-retry]")?.textContent).toBe("Proovi uuesti");
      expect(container.querySelector("[data-payment-result]")?.getAttribute("data-payment-result")).toBe("pooleli");
      expect(links()).toEqual([["Minu koolitused", "/konto"]]);
      // both fields are the page's own, the form sends no other
      for (const f of container.querySelectorAll("form")) expect([...f.querySelectorAll("input")].map((i) => i.getAttribute("name"))).toEqual(["method"]);
    });

    test("an e-course's: both go to its cart (it needs her name and the terms again) — the bank as the cart opens, Inbank with ?makse=jarelmaks", async () => {
      await show("#tulemus=pooleli&liik=jarelmaks&kursus=kulmumeistri-e-koolitus");
      expect(container.querySelector("h1")?.textContent).toBe("Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.");
      expect(forms()).toEqual([]);
      expect(links()).toEqual([
        ["Maksa pangalingiga", "/ostukorv?kursus=kulmumeistri-e-koolitus"],
        ["Proovi uuesti", "/ostukorv?kursus=kulmumeistri-e-koolitus&makse=jarelmaks"],
        ["Minu koolitused", "/konto"],
      ]);
      expect(container.querySelector("a[data-payment-retry]")?.textContent).toBe("Proovi uuesti");
    });

    test("without a way on (a held late loan: the money is at Montonio) the sentence stands alone: no button that could charge her twice", async () => {
      await show("#tulemus=pooleli&liik=jarelmaks");
      expect(container.querySelector("h1")?.textContent).toBe("Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.");
      expect(container.querySelector("form")).toBeNull();
      expect(container.querySelector("[data-payment-retry]")).toBeNull();
      expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    });

    test("not paid at all (katkestatud): the usual sentence and the usual „Proovi uuesti“ link; a bank order's pooleli keeps the bank's sentence", async () => {
      await show(`#tulemus=katkestatud&liik=jarelmaks&maksa=${TOKEN}`);
      expect(container.querySelector("h1")?.textContent).toBe("Makse jäi tegemata.");
      expect(links()).toEqual([["Proovi uuesti", `/maksa/${TOKEN}`], ["Minu koolitused", "/konto"]]);
      await show("#tulemus=katkestatud&liik=jarelmaks&kursus=kulmumeistri-e-koolitus");
      expect(links()).toEqual([["Proovi uuesti", "/ostukorv?kursus=kulmumeistri-e-koolitus"], ["Minu koolitused", "/konto"]]);
      await show(`#tulemus=pooleli&liik=registreering&maksa=${TOKEN}`);
      expect(container.querySelector("h1")?.textContent).toBe("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
      expect(forms()).toEqual([]);
    });

    test("Russian: the Draft sentence, the buttons under /ru", async () => {
      const ru = getDict("ru");
      const ruTexts = { ...ru.payment.result, payBank: ru.payment.payBank, account: ru.account.shell.courses };
      await show(`#tulemus=pooleli&liik=jarelmaks&maksa=${TOKEN}`, "ru", ruTexts);
      expect(container.querySelector("h1")?.textContent).toBe("Заявка на рассрочку в\u00a0процессе или не завершена. Если Inbank её одобрит, мы пришлём подтверждение.");
      expect(forms()).toEqual([
        ["post", `/maksa/${TOKEN}`, "paymentInitiation", "Оплатить через банк"],
        ["post", `/maksa/${TOKEN}`, "hirePurchase", "Попробовать снова"],
      ]);
      await show("#tulemus=pooleli&liik=jarelmaks&kursus=kulmumeistri-e-koolitus", "ru", ruTexts);
      expect(links()).toEqual([
        ["Оплатить через банк", "/ru/ostukorv?kursus=kulmumeistri-e-koolitus"],
        ["Попробовать снова", "/ru/ostukorv?kursus=kulmumeistri-e-koolitus&makse=jarelmaks"],
        ["Мои курсы", "/ru/konto"],
      ]);
    });

    test("the address is only read: a foreign token or slug makes no form and no link", async () => {
      await show("#tulemus=pooleli&liik=jarelmaks&maksa=%3Cscript%3Ealert(1)%3C%2Fscript%3E&kursus=..%2F..%2Fadmin");
      expect(container.innerHTML).not.toContain("<script");
      expect(container.innerHTML).not.toContain("admin");
      expect(container.querySelector("form")).toBeNull();
      expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    });
  });

  test("the page follows the address: a new fragment on the same page (hashchange) shows its result", async () => {
    await show("#tulemus=katkestatud");
    expect(container.querySelector("h1")?.textContent).toBe("Makse jäi tegemata.");
    await act(async () => {
      window.location.hash = "#tulemus=makstud&liik=registreering";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
  });

  test("no result in the address: the page's title and Minu koolitused; Russian links under /ru", async () => {
    await show("");
    expect(container.querySelector("h1")?.textContent).toBe("Makse");
    expect(links()).toEqual([["Minu koolitused", "/konto"]]);
    const ru = getDict("ru");
    const ruTexts = { ...ru.payment.result, payBank: ru.payment.payBank, account: ru.account.shell.courses };
    await show("#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus", "ru", ruTexts);
    expect(container.querySelector("h1")?.textContent).toBe("Оплата прошла.");
    expect(line()).toBe("Мы отправили вам ссылку для входа на e-mail.");
    expect(links()).toEqual([["Открыть онлайн-курс", "/ru/konto/kursus/kulmumeistri-e-koolitus"]]);
    await show("#tulemus=makstud&liik=registreering", "ru", ruTexts);
    expect(container.querySelector("h1")?.textContent).toBe("Оплата прошла. Мы отправили вам подтверждение по e-mail.");
    await show("#tulemus=pooleli&liik=ekoolitus&kursus=kulmumeistri-e-koolitus", "ru", ruTexts);
    expect(links()[0]).toEqual(["Попробовать снова", "/ru/ostukorv?kursus=kulmumeistri-e-koolitus"]);
  });
});
