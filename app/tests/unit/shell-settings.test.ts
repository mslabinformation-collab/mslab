import { describe, expect, test } from "vitest";
import { shellSettings } from "@/components/site/settings";

describe("shellSettings", () => {
  test("reads contact and trainer name from the settings rows", () => {
    const s = shellSettings(
      {
        contact: { email: " info@mslab.ee ", phone: "+372 5555 5555", address: "Pärnu", instagram: "", facebook: "" },
        trainer: { name: "Maria Sosnina", stats: [] },
      },
      "et",
      null,
    );
    expect(s).toEqual({
      newsletter: { discount: null },
      contact: { email: "info@mslab.ee", phone: "+372 5555 5555", instagram: "", facebook: "" },
      trainerName: "Maria Sosnina",
    });
  });

  test("the footer value is the welcome code's value, null without one", () => {
    // the stored newsletter setting (the old welcomeCode, discountPercent, discountLabel) no longer says anything here
    const old = { newsletter: { discountPercent: 15, codeDays: 30, welcomeCode: "TERE10", discountLabel: "20%" } };
    expect(shellSettings(old, "et", { code: "TERE10", value: "10%", days: 30 }).newsletter).toEqual({ discount: "10%" });
    expect(shellSettings(old, "et", { code: "TERE", value: "15 €", days: null }).newsletter).toEqual({ discount: "15 €" });
    expect(shellSettings(old, "et", null).newsletter).toEqual({ discount: null });
  });

  test("falls back to safe defaults when rows are missing or malformed", () => {
    for (const input of [{}, { contact: "x", newsletter: [], trainer: null }]) {
      const s = shellSettings(input as Record<string, unknown>, "et", null);
      expect(s.newsletter.discount).toBeNull();
      expect(s.contact).toEqual({ email: "", phone: "", instagram: "", facebook: "" });
      expect(s.trainerName).toBe("");
    }
  });
});
