import { describe, expect, test } from "vitest";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The news section has one name (UX pass 11.11 P10, the Vaiksed board: „Kõikjal „Uudised ja nõuanded““): the menu, the footer's column, the home
// section and the /uudised H1; the eyebrows over them are its short form „Uudised“. No „Blogi“, no „Uudised ja inspiratsioon“.
describe("the news section's one name (UX pass 11.11 P10)", () => {
  test.each([
    ["et", et, "Uudised ja nõuanded", "Uudised"],
    ["ru", ru, "Новости и советы", "Новости"],
  ] as const)("%s", (_, d, name, short) => {
    expect(d.nav.news).toBe(name);
    expect(d.news.title).toBe(name);
    expect(d.footer.news).toBe(name);
    expect(d.news.pageTitle).toBe(`${name}.`);
    expect(d.news.eyebrow).toBe(short);
    for (const words of [d.nav.news, d.news.title, d.news.eyebrow, d.news.pageTitle, d.footer.news]) expect(words).not.toMatch(/Blogi|inspiratsioon|Блог|вдохновение/);
  });
});
