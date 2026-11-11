import { describe, expect, test } from "vitest";
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
