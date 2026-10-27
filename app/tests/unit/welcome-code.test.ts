import { describe, expect, test } from "vitest";
import { codeDaysOf, discountPercentOf, isWelcomeCode, normalizeWelcomeCode, WELCOME_CODE_MAX, WELCOME_FRAGMENT, welcomeCodeOf, welcomeFragment } from "@/domain/welcome-code";

describe("the welcome code (Seaded 'Tervituskood', phase 2c)", () => {
  test("as typed → as stored: trimmed, in capitals", () => {
    expect(normalizeWelcomeCode("  tere-10 ")).toBe("TERE-10");
  });

  test("A–Z, 0–9 and '-', at most 30; empty is no code (allowed)", () => {
    expect(WELCOME_CODE_MAX).toBe(30);
    for (const ok of ["", "TERE10", "MS-LAB-2026", "A".repeat(30)]) expect(isWelcomeCode(ok), ok).toBe(true);
    for (const bad of ["TERE 10", "tere10", "ÕUN", "A".repeat(31), "X_1", "<b>"]) expect(isWelcomeCode(bad), bad).toBe(false);
  });

  test("the stored setting → its code, or '' (none, or a stored value of another shape)", () => {
    expect(welcomeCodeOf({ discountLabel: "10%", welcomeCode: "TERE10" })).toBe("TERE10");
    expect(welcomeCodeOf({ discountLabel: "10%" })).toBe("");
    expect(welcomeCodeOf({ welcomeCode: "tere 10" })).toBe("");
    expect(welcomeCodeOf(null)).toBe("");
    expect(welcomeCodeOf("TERE10")).toBe("");
  });

  test("the confirmed page's fragment: kood=<CODE>, read back only in that shape", () => {
    expect(welcomeFragment("TERE10")).toBe("kood=TERE10");
    expect(WELCOME_FRAGMENT.exec("kood=TERE-10")?.[1]).toBe("TERE-10");
    expect(WELCOME_FRAGMENT.exec("kood=<script>")).toBeNull();
    expect(WELCOME_FRAGMENT.exec("kood=")).toBeNull();
  });
});

describe("the popup's two numbers in the same setting (Hüpikaken, piece 4b R-c)", () => {
  test("Hüpikaken's discount (piece 4b R-c): a whole 1–99; before its first publish the stored label's number („10%“, „-15%“); else 10", () => {
    expect(discountPercentOf({ discountPercent: 15, discountLabel: "20%" })).toBe(15);
    expect(discountPercentOf({ discountPercent: 99 })).toBe(99);
    expect(discountPercentOf({ discountLabel: "10%" })).toBe(10);
    expect(discountPercentOf({ discountLabel: " -15 % " })).toBe(15);
    for (const bad of [null, {}, "15%", { discountPercent: 0 }, { discountPercent: 100 }, { discountPercent: 12.5 }, { discountPercent: "15" }, { discountLabel: "150%" }, { discountLabel: "kümme" }, { discountLabel: "0%" }])
      expect(discountPercentOf(bad), JSON.stringify(bad)).toBe(10);
  });

  test("Hüpikaken's „Kood kehtib (päeva)“ (piece 4b R-c, S4-Q3 A): a whole 1–365, else none (null)", () => {
    expect(codeDaysOf({ codeDays: 30 })).toBe(30);
    expect(codeDaysOf({ codeDays: 1 })).toBe(1);
    expect(codeDaysOf({ codeDays: 365 })).toBe(365);
    for (const bad of [null, {}, { codeDays: null }, { codeDays: 0 }, { codeDays: 366 }, { codeDays: 2.5 }, { codeDays: "30" }]) expect(codeDaysOf(bad), JSON.stringify(bad)).toBeNull();
  });
});
