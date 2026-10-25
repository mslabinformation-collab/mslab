import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { pages } from "@/db/schema";
import { saveContractTexts } from "@/server/contracts";
import { readLegal, writeLegalDraft } from "@/server/legal-drafts";
import { makeTestDb } from "./helpers";
import { sectionOf } from "./seaded-page";

// Seaded's „Lepingud ja tingimused“ (admin UX pass piece 3b, Task 5; README B4; ruling R-d; piece3-texts P-11), rendered from a real (PGlite) database
// to HTML: the section holds the four legal texts as cards — Privaatsus, Õppetingimused, E-koolituse leping, Kontaktkoolituse leping —, each showing its
// draft when there is one (with the tag „Avaldamata muudatus“ and the map's „{n} avaldamata“), else its live text; Maria's contact text is empty
// before her first publish (never the public „Õppetingimused“ text that stands in for it); the two contracts have the placeholder chips; the contact
// card has the sample. Nothing in the section is a form with a „Salvesta“.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
// (the Maksmine card reads the page again once a new prefix is stored; a legal card after its publish: the router is a stand-in here)
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

import SettingsEditPage from "@/app/admin/(panel)/seaded/page";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("ADMIN_EMAILS", "maria@example.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const page = async () => renderToStaticMarkup(await SettingsEditPage());
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The value of the field with `data-i18n="<name>"`: an input's value or a textarea's text. */
const fieldValue = (html: string, name: string): string | null => {
  const input = new RegExp(`<input[^>]*data-i18n="${name}"[^>]*>`).exec(html)?.[0];
  if (input) return decode(/\svalue="([^"]*)"/.exec(input)?.[1] ?? "");
  const area = new RegExp(`<textarea[^>]*data-i18n="${name}"[^>]*>([^<]*)</textarea>`).exec(html);
  return area ? decode(area[1]) : null;
};
/** The HTML of one legal card (`data-legal-editor="<key>"`, up to its </section>). */
const cardOf = (html: string, key: string): string => {
  const from = html.slice(html.indexOf(`data-legal-editor="${key}"`));
  return from.slice(0, from.indexOf("</section>"));
};
const ADMIN = { email: "maria@example.test" };

test("the four legal texts are the cards of „Lepingud ja tingimused“, in order; before Maria writes hers, the contact card's fields are empty and its sample is there; no „Salvesta“", async () => {
  const html = await page();
  const order = ["privacy", "terms", "course_terms", "contract_contact"].map((key) => html.indexOf(`data-legal-editor="${key}"`));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  for (const key of ["privacy", "terms", "course_terms", "contract_contact"]) expect(sectionOf(html, `data-legal-editor="${key}"`), key).toBe("lepingud");
  expect(sectionOf(html, "data-admin-emails")).toBe("ligipaas");
  expect(cardOf(html, "contract_contact")).toContain("Kontaktkoolituse leping");
  expect([fieldValue(html, "contract_contact.title"), fieldValue(html, "contract_contact.body")]).toEqual(["", ""]);
  expect(cardOf(html, "contract_contact")).toContain('action="/api/admin/naidisleping"');
  expect(html).not.toMatch(/data-save-bar|Salvesta lepingud/);
  // the public „Õppetingimused“ text stands in for hers for the student, not in her card
  await db.insert(pages).values({ key: "terms", title: { et: "Õppetingimused" }, body: { et: "Avalik tingimuste tekst." } });
  const again = await page();
  expect(cardOf(again, "contract_contact")).not.toContain("Avalik tingimuste tekst.");
  expect(fieldValue(again, "terms.body")).toBe("Avalik tingimuste tekst.");
});

test("a published text is in its fields as stored; a draft over it is shown instead, with the tag „Avaldamata muudatus“ and the map's „1 avaldamata“", async () => {
  expect(await saveContractTexts(db, { title: { et: "Kontaktkoolituse leping", ru: "Договор" }, body: { et: "Õpilane {nimi}.\n\nTeine lõik.", ru: "Ученик {nimi}." } }, new Date("2026-10-17T09:00:00Z"))).toEqual({ ok: true });
  const html = await page();
  expect(fieldValue(html, "contract_contact.title")).toBe("Kontaktkoolituse leping");
  expect(fieldValue(html, "contract_contact.body")).toBe("Õpilane {nimi}.\n\nTeine lõik.");
  expect(cardOf(html, "contract_contact")).not.toContain("Avaldamata muudatus");
  // (the Russian text is behind the switch, so the Russian sample is offered)
  expect(cardOf(html, "contract_contact")).toContain("Näidisleping vene keeles (PDF)");

  const v = (await readLegal(db, "contract_contact")).version;
  expect(await writeLegalDraft(db, "contract_contact", { body: { et: "Mustand {nimi}." } }, v, ADMIN)).toMatchObject({ ok: true });
  const drafted = await page();
  expect(fieldValue(drafted, "contract_contact.body")).toBe("Mustand {nimi}.");
  expect(cardOf(drafted, "contract_contact")).toContain("Avaldamata muudatus");
  expect(cardOf(drafted, "contract_contact")).toContain("Avalda uus leping");
  expect(drafted).toMatch(/href="#lepingud"[^]*?data-section-status="">[^]*?1 avaldamata/);
});

test("the e-course contract's card is „E-koolituse leping“ (P-11) with its stored page title in a field of its own (ruling R3) and the title's hint", async () => {
  await db.insert(pages).values({ key: "course_terms", title: { et: "E-koolituse leping", ru: "Договор онлайн-обучения" }, body: { et: "Tere {nimi}." } });
  const html = await page();
  const card = cardOf(html, "course_terms");
  expect(card).toMatch(/<h2[^>]*>E-koolituse leping<\/h2>/);
  expect(card).not.toContain("(tingimused)");
  expect(fieldValue(html, "course_terms.title")).toBe("E-koolituse leping");
  expect(fieldValue(html, "course_terms.body")).toBe("Tere {nimi}.");
  expect(card).toContain("Soovitus: „E-koolituse leping“.");
  expect(card).toContain("Kui avaldad muudetud teksti, peab iga õpilane uuesti nõustuma.");
});

test("ruling R18: the two contracts' texts have the placeholder chips „+ nimi“ … „+ ettemaks“ with the same lead; the pages' have none", async () => {
  const html = await page();
  const chips = (key: string) => [...cardOf(html, key).matchAll(/data-placeholder-chip="([^"]+)"/g)].map((m) => m[1]);
  for (const key of ["course_terms", "contract_contact"]) {
    expect(chips(key), key).toEqual(["nimi", "e-post", "koolitus", "toimumine", "hind", "ettemaks"]);
    expect(cardOf(html, key)).toContain("Tekstis võid kasutada kohahoidjaid, mis täituvad lepingu kinnitamisel.");
  }
  expect(chips("privacy")).toEqual([]);
  expect(chips("terms")).toEqual([]);
});
