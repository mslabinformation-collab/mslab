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
