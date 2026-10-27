import { describe, expect, test } from "vitest";
import { shellSettings } from "@/components/site/settings";

describe("shellSettings", () => {
  test("reads contact, newsletter discount and trainer name from the settings rows", () => {
    const s = shellSettings({
      contact: { email: " info@mslab.ee ", phone: "+372 5555 5555", address: "Pärnu", instagram: "", facebook: "" },
      newsletter: { discountPercent: 15, codeDays: 30, welcomeCode: "TERE10" },
      trainer: { name: "Maria Sosnina", stats: [] },
    });
    expect(s).toEqual({
      newsletter: { discountPercent: 15 },
      contact: { email: "info@mslab.ee", phone: "+372 5555 5555", instagram: "", facebook: "" },
      trainerName: "Maria Sosnina",
    });
  });

  test("the discount before piece 4b (R-c): a stored label such as „15%“ or „-15%“ is read as its number until Hüpikaken's publish writes one", () => {
    expect(shellSettings({ newsletter: { discountLabel: "15%" } }).newsletter).toEqual({ discountPercent: 15 });
    expect(shellSettings({ newsletter: { discountLabel: "-15%" } }).newsletter).toEqual({ discountPercent: 15 });
    expect(shellSettings({ newsletter: { discountLabel: "15%", discountPercent: 20 } }).newsletter).toEqual({ discountPercent: 20 });
  });

  test("falls back to safe defaults when rows are missing or malformed", () => {
    for (const input of [{}, { contact: "x", newsletter: [], trainer: null }, { newsletter: { discountLabel: "  " } }, { newsletter: { discountPercent: 100 } }]) {
      const s = shellSettings(input as Record<string, unknown>);
      expect(s.newsletter.discountPercent).toBe(10);
      expect(s.contact).toEqual({ email: "", phone: "", instagram: "", facebook: "" });
      expect(s.trainerName).toBe("");
    }
  });
});
