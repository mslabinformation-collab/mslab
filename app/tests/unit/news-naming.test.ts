import { describe, expect, test } from "vitest";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { adminEt } from "@/i18n/dict/admin";

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

  // (review of the UX pass) the admin's Uudised says where a post shows in the same words: the news page („uudiste leht“), not „blogi“; its eyebrow is
  // „Koduleht“, as the other site pages' (Avaleht, Koolitaja)
  test("the admin's Uudised: no „blogi“ left", () => {
    expect(adminEt.news.eyebrow).toBe(adminEt.home.eyebrow);
    expect(adminEt.news.lead).toBe("Kõik postitused, ka mustandid, uuemad eespool. Uudiste lehel ja avalehel on näha avaldatud postitused.");
    expect(adminEt.post.excerptHint).toBe("Postituse kaardil uudiste lehel ja avalehel.");
    expect(adminEt.post.publishedHint).toBe("Avaldatud postitus on uudiste lehel ja avalehel nähtav. Mustandit näed ainult siin.");
    expect(adminEt.post.remove.public).toBe("Postitus kaob uudiste lehelt ja avalehelt.");
    const leaves = (o: object): string[] => Object.values(o).flatMap((v) => (typeof v === "object" ? leaves(v) : [String(v)]));
    for (const words of leaves({ news: adminEt.news, post: adminEt.post })) expect(words).not.toMatch(/blog/i);
  });
});
