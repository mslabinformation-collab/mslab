import { describe, expect, test } from "vitest";
import { NEWSLETTER_LANDING_PARAM, NEWSLETTER_SIGNED_KEY, newsletterLanding, newsletterPopupView, POPUP_DELAY_MS, POPUP_SEEN_KEY, popupDelay, popupDue, popupSeenWithin } from "@/domain/campaign";
import type { Campaign } from "@/db/schema";

// The home page's popup (admin UX pass piece 4b, Task 4; ruling R-e, builder notes §5; spec D3): one popup, the newsletter sign-up (row 2). It opens on
// the home page only, 8 s after the page appears, once in 30 days per browser (a localStorage stamp), never again in a browser that signed up; the
// admin's draft preview skips the time and the stamp.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);

const row = (patch: Partial<Campaign> = {}): Campaign => ({
  id: 2,
  active: true,
  kind: "newsletter",
  kicker: { et: "MS LABi kirjad", ru: "Письма MS LAB" },
  title: { et: "Hea järgmine samm.", ru: "Ваш следующий шаг." },
  text: { et: "Tekst" },
  code: "",
  ctaLabel: { et: "" },
  ctaHref: "",
  imageKey: "img/0b6f3b7e-2c4d-4f7a-9a59-3d7c2f1e8a10.jpg",
  ...patch,
});

describe("when the popup opens (R-e)", () => {
  test("8 s after the page appears, unless a test page sets its own delay (a finite number of ms, 0 or more)", () => {
    expect(POPUP_DELAY_MS).toBe(8000);
    expect(popupDelay(undefined)).toBe(8000);
    expect(popupDelay(250)).toBe(250);
    expect(popupDelay(0)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "300", null, {}]) expect(popupDelay(bad), String(bad)).toBe(8000);
  });

  test("seen within 30 days is read from the localStorage stamp: the time it was shown, in ms; a stamp of any other shape is none", () => {
    expect(POPUP_SEEN_KEY).toBe("mslab-popup");
    expect(popupSeenWithin(String(NOW), NOW)).toBe(true);
    expect(popupSeenWithin(String(NOW - 29 * DAY), NOW)).toBe(true);
    expect(popupSeenWithin(String(NOW - 30 * DAY + 1), NOW)).toBe(true);
    expect(popupSeenWithin(String(NOW - 30 * DAY), NOW)).toBe(false); // 30 days on: due again
    expect(popupSeenWithin(String(NOW - 400 * DAY), NOW)).toBe(false);
    // no stamp, the old session key's "1" (once per visit, 6 s: no longer the rule) and anything else that is not a time
    for (const none of [null, "", "1", "abc", "-5", "12.5", " 1730000000000", "1e12"]) expect(popupSeenWithin(none, NOW), String(none)).toBe(false);
    // a stamp from the future (the clock was set back): not seen, so the popup is not held back for longer than 30 days
    expect(popupSeenWithin(String(NOW + DAY), NOW)).toBe(false);
  });

  test("due: not seen within 30 days and not signed up here; a browser that signed up never sees it", () => {
    expect(NEWSLETTER_SIGNED_KEY).toBe("mslab-nl");
    expect(popupDue({ seen: null, signed: null }, NOW)).toBe(true);
    expect(popupDue({ seen: String(NOW - 31 * DAY), signed: null }, NOW)).toBe(true);
    expect(popupDue({ seen: String(NOW - DAY), signed: null }, NOW)).toBe(false);
    expect(popupDue({ seen: null, signed: "1" }, NOW)).toBe(false);
    expect(popupDue({ seen: String(NOW - 400 * DAY), signed: "1" }, NOW)).toBe(false);
  });

  test("the admin's draft preview skips the stamp and the sign-up (ruling c2): shown seen or not, signed up or not; a visitor's sign-up still keeps it away", () => {
    expect(popupDue({ seen: String(NOW - DAY), signed: null }, NOW, { preview: true })).toBe(true);
    expect(popupDue({ seen: String(NOW), signed: null }, NOW, { preview: true })).toBe(true);
    expect(popupDue({ seen: null, signed: "1" }, NOW, { preview: true })).toBe(true);
    expect(popupDue({ seen: String(NOW), signed: "1" }, NOW, { preview: true })).toBe(true);
    expect(popupDue({ seen: null, signed: "1" }, NOW)).toBe(false);
    expect(popupDue({ seen: null, signed: "1" }, NOW, { preview: false })).toBe(false);
  });
});

describe("the popup's card (R-d: the newsletter row only)", () => {
  test("the picture, kicker, title and text in the page's language (no code, no button)", () => {
    expect(newsletterPopupView(row(), "ru")).toEqual({
      image: "/media/img/0b6f3b7e-2c4d-4f7a-9a59-3d7c2f1e8a10.jpg",
      kicker: "Письма MS LAB",
      title: "Ваш следующий шаг.",
      text: "Tekst",
    });
  });

  test("none for a switched-off row, a missing one, one without a title, or the old campaign offer's row (kind campaign, row 1), active or not", () => {
    expect(newsletterPopupView(row({ active: false }), "et")).toBeNull();
    expect(newsletterPopupView(null, "et")).toBeNull();
    expect(newsletterPopupView(row({ title: { et: " " } }), "et")).toBeNull();
    expect(newsletterPopupView(row({ id: 1, kind: "campaign", code: "TALV15" }), "et")).toBeNull();
  });

  test("the confirmation link's landing: ?uudiskiri= with any value, an empty one too, is a landing; no parameter is not", () => {
    expect(NEWSLETTER_LANDING_PARAM).toBe("uudiskiri");
    expect(newsletterLanding("?uudiskiri=kinnitatud")).toBe("kinnitatud");
    expect(newsletterLanding("?utm=x&uudiskiri=vigane")).toBe("vigane");
    expect(newsletterLanding("?uudiskiri=")).toBe("");
    expect(newsletterLanding("?uudiskiri")).toBe("");
    expect(newsletterLanding("")).toBeNull();
    expect(newsletterLanding("?utm_source=x")).toBeNull();
    expect(newsletterLanding("?Uudiskiri=kinnitatud")).toBeNull(); // the parameter is spelt as FlashNotice spells it
  });
});
