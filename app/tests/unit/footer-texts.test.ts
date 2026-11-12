import { describe, expect, test } from "vitest";
import { footerNewsletterBody } from "@/components/site/Footer";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The footer's line under the logo (Maria 10.11: „Õpi, Loo, Arene - kustutada“): the sentence alone, in both languages.
describe("the footer's tagline", () => {
  test("is the sentence without „Õpi. Arene. Loo.“", () => {
    expect(et.footer.tagline).toBe("Õpilase edu on meie eesmärk.");
    expect(ru.footer.tagline).toBe("Успех ученика — наша цель.");
  });
});

// F1 Task 11: the footer's sign-up line follows the welcome code's row; without a code there is no „tervitussoodustus“ to promise.
describe("the footer's sign-up line", () => {
  test("bodyNoCode without a welcome code", () => {
    expect(et.newsletter.bodyNoCode).toBe("Uued koolitused ja kasulikud mõtted.");
    expect(ru.newsletter.bodyNoCode).toBe("Новые курсы и полезные идеи.");
    expect(et.newsletter.bodyNoCode).not.toContain("{discount}");
    expect(ru.newsletter.bodyNoCode).not.toContain("{discount}");
    expect(et.newsletter.body).toContain("{discount}");
    expect(ru.newsletter.body).toContain("{discount}");
  });
});

// P22: what the footer's card says, by whether a welcome code is valid today (its value, or null)
describe("footerNewsletterBody", () => {
  test("a welcome code's value fills {discount}, a percent or euros", () => {
    expect(footerNewsletterBody(et.newsletter, "10%")).toBe("Uued koolitused, kasulikud mõtted ja 10% tervitussoodustus sinu esimesele koolitusele.");
    expect(footerNewsletterBody(et.newsletter, "15 €")).toBe("Uued koolitused, kasulikud mõtted ja 15 € tervitussoodustus sinu esimesele koolitusele.");
    expect(footerNewsletterBody(ru.newsletter, "10%")).toBe(ru.newsletter.body.replace("{discount}", "10%"));
  });
  test("no welcome code valid today: the line without a discount", () => {
    expect(footerNewsletterBody(et.newsletter, null)).toBe("Uued koolitused ja kasulikud mõtted.");
    expect(footerNewsletterBody(ru.newsletter, null)).toBe("Новые курсы и полезные идеи.");
  });
});
