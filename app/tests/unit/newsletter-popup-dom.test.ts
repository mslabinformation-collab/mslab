// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FlashNotice, type FlashMessage } from "@/components/site/FlashNotice";
import type { NewsletterPopupTexts } from "@/components/site/NewsletterPopup";
import { popupFormTexts } from "@/components/site/NewsletterPopupCard";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The home page's newsletter popup next to the confirmation notice (phase 2c final fix): the confirmation link lands on
// /?uudiskiri=kinnitatud#kood=…, where the popup must not open over the notice with her code, and the browser remembers she is signed up.
// The page renders FlashNotice before the popup, and FlashNotice takes the parameter out of the address in its own effect, which runs
// before the popup's: so the popup reads the address in its first render. Both are rendered here in the page's order.
// Its timing (admin UX pass piece 4b, Task 4; ruling R-e): once in 30 days per browser (the localStorage stamp "mslab-popup", the time it was shown),
// never again in a browser that signed up; the admin's draft preview (`preview`) opens it at once and leaves the stamp alone. Its button follows Seaded's
// welcome code (S4-Q4: „Saa kood“ / „Получить код“ with a code, else „Liitu“ / „Подписаться“).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  interface Window {
    __mslabCampaignDelay?: number;
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/server/actions/public", () => ({ subscribe: vi.fn() }));

const notices: Record<string, FlashMessage> = {
  kinnitatud: { tone: "ok", title: "Uudiskiri on kinnitatud", codeLine: "Sinu kood: {code}" },
  loobutud: { tone: "ok", title: "Oled uudiskirjast loobunud.", text: "Me ei saada sulle enam MS LABi uudiskirja." },
  vigane: { tone: "warn", title: "Link on vigane" },
  viga: { tone: "warn", title: "Midagi läks valesti." },
};
const t: NewsletterPopupTexts = {
  close: "Sulge",
  form: {
    emailLabel: "Sinu e-post",
    emailPlaceholder: "nimi@e-post.ee",
    submit: "Liitu",
    notice: "Liitudes saad MS LABi uudiskirja.",
    privacy: "Privaatsus",
    sentTitle: "",
    sentText: "Saatsime sulle tervituskirja.",
    errorEmail: "Sisesta korrektne e-posti aadress.",
    errorTooMany: "Liiga palju katseid.",
    errorGeneric: "Midagi läks valesti.",
  },
};
const view = { image: "", kicker: "MS LABi kirjad", title: "Hea järgmine samm.", text: "Uued koolitused." };
const DAY = 86_400_000;

let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const address = () => window.location.pathname + window.location.search + window.location.hash;
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/**
 * The home page's two parts in its order (the notice, then the popup), freshly loaded at `at`: a new document, so the popup's once-per-load state is
 * new. `preview`: the admin's draft preview.
 */
async function loadHome(at: string, preview = false) {
  vi.resetModules();
  const { NewsletterPopup } = await import("@/components/site/NewsletterPopup");
  window.history.replaceState(null, "", at);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(FlashNotice, { param: "uudiskiri", notices, closeLabel: "Sulge" }),
        createElement(NewsletterPopup, { n: view, locale: "et", t, preview }),
      ),
    ),
  );
}
const leave = async () => {
  await act(async () => root.unmount());
  container.remove();
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.__mslabCampaignDelay = 30; // the e2e's short delay, in place of the site's 8 s
});
afterEach(async () => {
  await leave();
  delete window.__mslabCampaignDelay;
  window.history.replaceState(null, "", "/");
});

describe("the newsletter popup on the home page", () => {
  test("a plain visit: it opens after the delay (and remembers no sign-up)", async () => {
    await loadHome("/");
    expect($("[data-newsletter-popup]")).toBeNull();
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
    expect(localStorage.getItem("mslab-nl")).toBeNull();
  });

  test("the confirmed landing (?uudiskiri=kinnitatud#kood=…): the notice with her code, and no popup over it, however long she stays; this browser is marked signed up", async () => {
    await loadHome("/?uudiskiri=kinnitatud#kood=TERE10");
    await wait(300);
    expect($("[data-flash-notice]")?.textContent).toContain("Sinu kood: TERE10");
    expect($("[data-newsletter-popup]")).toBeNull();
    expect(localStorage.getItem("mslab-popup")).toBeNull(); // the popup did not even use up its turn
    expect(localStorage.getItem("mslab-nl")).toBe("1");
    expect(address()).toBe("/"); // FlashNotice took the parameter and the code out, as before
  });

  test("the unsubscribed landing (?uudiskiri=loobutud): the notice, no popup over it, and this browser is NOT marked signed up (only kinnitatud marks it); the next page load is an ordinary one", async () => {
    await loadHome("/?uudiskiri=loobutud");
    await wait(300);
    expect($("[data-flash-notice]")?.getAttribute("data-flash-notice")).toBe("ok");
    expect($("[data-flash-notice]")?.textContent).toContain("Oled uudiskirjast loobunud.");
    expect($("[data-flash-notice]")?.textContent).toContain("Me ei saada sulle enam MS LABi uudiskirja.");
    expect($("[data-flash-code]")).toBeNull();
    expect($("[data-newsletter-popup]")).toBeNull();
    expect(localStorage.getItem("mslab-popup")).toBeNull();
    expect(localStorage.getItem("mslab-nl")).toBeNull();
    expect(address()).toBe("/");
    // she may sign up again: the next visit shows the popup (a signed-up mark from before would have kept it away; unsubscribing removes the reason for it)
    await leave();
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });

  test("a reload of / in the same browser, and a visit 31 days later: still none (she is signed up here)", async () => {
    await loadHome("/?uudiskiri=kinnitatud");
    await wait(150);
    await leave();
    await loadHome("/");
    await wait(300);
    expect($("[data-newsletter-popup]")).toBeNull();
    await leave();
    localStorage.setItem("mslab-popup", String(Date.now() - 31 * DAY)); // a stamp whose 30 days are over
    await loadHome("/");
    await wait(300);
    expect($("[data-newsletter-popup]")).toBeNull();
  });

  test.each(["vigane", "viga", "mingi-muu", ""])("any other landing (?uudiskiri=%s) shows no popup on that page load either, and marks nothing", async (value) => {
    await loadHome(`/?uudiskiri=${value}`);
    await wait(300);
    expect($("[data-newsletter-popup]")).toBeNull();
    expect(localStorage.getItem("mslab-nl")).toBeNull();
    expect(localStorage.getItem("mslab-popup")).toBeNull();
    // the next page load is an ordinary one
    await leave();
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });

  test("other query parameters do not stop it", async () => {
    await loadHome("/?utm_source=x");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });

  test("signed up from the popup before (mslab-nl): none, as before", async () => {
    localStorage.setItem("mslab-nl", "1");
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).toBeNull();
  });

  test("Tab stays inside and goes ✕ → e-mail → the button → „Privaatsus“ → ✕: never to the hidden fields or the honeypot (lib/modal.ts FOCUSABLE)", async () => {
    await loadHome("/");
    await wait(200);
    expect(document.activeElement?.hasAttribute("data-newsletter-close")).toBe(true);
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
      const el = document.activeElement as HTMLElement;
      visited.push(el.getAttribute("aria-label") ?? el.getAttribute("type") ?? el.textContent ?? el.tagName);
    }
    expect(visited).toEqual(["email", "submit", "Privaatsus", "Sulge"]);
  });
});

describe("once in 30 days per browser (R-e)", () => {
  test("shown: the stamp is the time it opened; a new page load within 30 days shows none; 30 days on, it opens again", async () => {
    const before = Date.now();
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
    const stamp = Number(localStorage.getItem("mslab-popup"));
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
    await leave();
    await loadHome("/");
    await wait(300);
    expect($("[data-newsletter-popup]")).toBeNull();
    await leave();
    localStorage.setItem("mslab-popup", String(Date.now() - 29 * DAY));
    await loadHome("/");
    await wait(300);
    expect($("[data-newsletter-popup]")).toBeNull();
    await leave();
    localStorage.setItem("mslab-popup", String(Date.now() - 30 * DAY - 1000));
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });

  test("the old once-per-visit key (sessionStorage mslab-camp) no longer keeps it away", async () => {
    sessionStorage.setItem("mslab-camp", "1");
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });

  test("not before its time: the page's delay (the test hook here), nothing at once", async () => {
    window.__mslabCampaignDelay = 400;
    await loadHome("/");
    await wait(100);
    expect($("[data-newsletter-popup]")).toBeNull();
    await wait(500);
    expect($("[data-newsletter-popup]")).not.toBeNull();
  });
});

describe("the admin's draft preview (R-e, ruling c2: the time, the stamp and the sign-up skipped)", () => {
  test("it opens at once, though this browser saw it a day ago, and it writes no stamp", async () => {
    window.__mslabCampaignDelay = 5000; // (a visitor would wait long)
    const seen = String(Date.now() - DAY);
    localStorage.setItem("mslab-popup", seen);
    await loadHome("/", true);
    await wait(60);
    expect($("[data-newsletter-popup]")).not.toBeNull();
    expect(localStorage.getItem("mslab-popup")).toBe(seen);
  });

  test("a browser that signed up sees it too, at once (her own browser may have signed up); it leaves the sign-up mark and the stamp as they were", async () => {
    window.__mslabCampaignDelay = 5000;
    localStorage.setItem("mslab-nl", "1");
    await loadHome("/", true);
    await wait(60);
    expect($("[data-newsletter-popup]")).not.toBeNull();
    expect(localStorage.getItem("mslab-nl")).toBe("1");
    expect(localStorage.getItem("mslab-popup")).toBeNull();
    // the same browser as a visitor: none
    await leave();
    window.__mslabCampaignDelay = 30;
    await loadHome("/");
    await wait(200);
    expect($("[data-newsletter-popup]")).toBeNull();
  });
});

describe("the popup's button follows Seaded's welcome code (S4-Q4)", () => {
  test("with a code „Saa kood“ / „Получить код“, without one „Liitu“ / „Подписаться“; the rest are the footer form's words", () => {
    expect(popupFormTexts(et, true).submit).toBe("Saa kood");
    expect(popupFormTexts(ru, true).submit).toBe("Получить код");
    expect(popupFormTexts(et, false).submit).toBe("Liitu");
    expect(popupFormTexts(ru, false).submit).toBe("Подписаться");
    expect(popupFormTexts(et, true)).toMatchObject({
      emailLabel: et.newsletter.emailLabel,
      emailPlaceholder: et.newsletter.emailPlaceholder,
      notice: et.newsletter.notice,
      privacy: et.footer.privacy,
      sentTitle: "",
      sentText: et.newsletter.popupSent,
      errorEmail: et.forms.errorEmail,
    });
    // the footer's own button stays „Liitu“ in every case
    expect(et.newsletter.submit).toBe("Liitu");
    expect(ru.newsletter.submit).toBe("Подписаться");
  });
});
