import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, settings } from "@/db/schema";
import { CERT_DEFAULTS, formatCertificateNumber, tallinnYear } from "@/domain/certificate";
import { issueCertificate } from "@/server/certificates";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Seaded with its "Tunnistus" card (phase 3d, spec §6, §4), rendered from a real (PGlite) database to HTML: the card is a form of its own
// after the settings' form (never a form inside a form), it shows the stored setting (or the defaults) and the number last issued in the next
// number's year. The trainer's name is the signature (owner, 15.10): the card has no picture and no file field. The shell and the server
// actions are stand-ins (they need a browser or a request). The page reads the clock (`new Date()`): the tests set it, so none depends on
// the year the suite runs in.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/server/actions/admin-site", () => ({ saveSettings: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn() }));

import SettingsEditPage from "@/app/admin/(panel)/seaded/page";

/** The day the page is read on unless a test says otherwise (Tallinn year 2026). */
const OCTOBER = new Date("2026-10-20T10:00:00Z");

let db: Db;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); // only the clock: PGlite and the render keep their real timers
  vi.setSystemTime(OCTOBER);
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("ADMIN_EMAILS", "maria@example.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const page = async () => renderToStaticMarkup(await SettingsEditPage());
/** The value of the card's input `data-cert-<hook>`. */
const valueOf = (html: string, hook: string) => {
  const tag = new RegExp(`<input[^>]*data-cert-${hook}=""[^>]*>`).exec(html)?.[0] ?? "";
  return /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
};

test("without a setting: the defaults (Maria Sosnina signs), this year's number 1, nothing issued yet; the card is a form of its own after the settings' form, with no picture or file field", async () => {
  const html = await page();
  expect(html).toContain('data-shell-active="settings"');
  const card = html.indexOf("data-certificate-settings");
  expect(card).toBeGreaterThan(-1);
  expect(html.indexOf("</form>")).toBeLessThan(card); // the settings' form ends before the card begins
  expect(html.match(/<form/g)).toHaveLength(2);
  expect(html.slice(html.lastIndexOf("<section", card))).toMatch(/^<section id="tunnistus"/); // the card's anchor, for "Seaded → Tunnistus"
  expect(valueOf(html, "place")).toBe(CERT_DEFAULTS.place);
  expect(valueOf(html, "registry")).toBe(CERT_DEFAULTS.registryCode);
  expect(valueOf(html, "practical")).toBe(CERT_DEFAULTS.practicalLine);
  expect(valueOf(html, "trainer")).toBe(CERT_DEFAULTS.trainerName);
  expect(valueOf(html, "next-year")).toBe(String(tallinnYear(new Date())));
  expect(valueOf(html, "next-seq")).toBe("1");
  expect(html).toContain("Sel aastal pole veel tunnistusi väljastatud.");
  expect(html.slice(card)).not.toMatch(/<img|type="file"/);
});

test("a stored setting: its values, the trainer's name as stored, and the year's last issued number beside the next", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  await db.insert(certificates).values({
    accessId: kati.access.id,
    number: "MS LAB 2026-14",
    year: 2026,
    seq: 14,
    name: "Kati Kask",
    courseTitle: "Kulmumeistri e-koolitus",
    skills: [],
    volume: "",
    practicalLine: "Praktiline töö fotodel",
    place: "Pärnu linn",
    registryCode: "16346048",
    issuedAt: at(9),
  });
  await db.insert(settings).values({
    key: "certificate",
    value: { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria S.", nextYear: 2026, nextSeq: 15 },
  });
  const html = await page();
  expect([valueOf(html, "place"), valueOf(html, "trainer"), valueOf(html, "next-year"), valueOf(html, "next-seq")]).toEqual(["Tallinn", "Maria S.", "2026", "15"]);
  expect(html).toContain("Viimati väljastatud: MS LAB 2026-14");
});

// The year turns (Review Focus 3, with Task 3's note): in January, until the year's first issue, the stored next number is still last year's.
// An issue would not use it (another year starts at 1, and never at or below the year's highest), so the card shows the number it will get.

/** The stored setting, and one certificate per entry of `issued` ([year, seq]) with a student of its own. */
async function seed(setting: { nextYear: number; nextSeq: number }, issued: [number, number][]) {
  const course = await ecourse(db, { test: null });
  for (const [i, [year, seq]] of issued.entries()) {
    const s = await student(db, course.id, `Opilane${i}`, { completedAt: at(8) });
    await db.insert(certificates).values({
      accessId: s.access.id,
      number: formatCertificateNumber(year, seq),
      year,
      seq,
      name: "Kati Kask",
      courseTitle: "Kulmumeistri e-koolitus",
      skills: [],
      volume: "",
      practicalLine: "Praktiline töö fotodel",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: at(9),
    });
  }
  await db.insert(settings).values({ key: "certificate", value: { ...CERT_DEFAULTS, ...setting } });
  return course;
}
const shown = (html: string) => [valueOf(html, "next-year"), valueOf(html, "next-seq")];

test("January, no certificate yet this year: the stored number is last year's, so the card shows this year's number 1 and no 'last issued' of last year", async () => {
  await seed({ nextYear: 2026, nextSeq: 15 }, [[2026, 14]]);
  vi.setSystemTime(new Date("2027-01-05T10:00:00Z"));
  const html = await page();
  expect(shown(html)).toEqual(["2027", "1"]);
  expect(html).toContain("Sel aastal pole veel tunnistusi väljastatud.");
  expect(html).not.toContain("MS LAB 2026-14");
});

test("the year turns at Tallinn midnight: 31.12 at 22:30 UTC is already January there, so the card shows the new year then (and not before)", async () => {
  await seed({ nextYear: 2026, nextSeq: 15 }, [[2026, 14]]);
  vi.setSystemTime(new Date("2026-12-31T21:59:59Z"));
  expect(shown(await page())).toEqual(["2026", "15"]);
  vi.setSystemTime(new Date("2026-12-31T22:00:00Z"));
  expect(shown(await page())).toEqual(["2027", "1"]);
});

test("January, the stored number saved for last year after this year's issues began: the card shows what the next issue gets, this year's highest + 1, and that number beside it", async () => {
  await seed({ nextYear: 2026, nextSeq: 15 }, [[2026, 14], [2027, 3]]);
  vi.setSystemTime(new Date("2027-01-05T10:00:00Z"));
  const html = await page();
  expect(shown(html)).toEqual(["2027", "4"]);
  expect(html).toContain("Viimati väljastatud: MS LAB 2027-03");
});

test("the number shown is the number the next issue takes (the card and issueCertificate read one rule)", async () => {
  const course = await seed({ nextYear: 2026, nextSeq: 15 }, [[2026, 14], [2027, 3]]);
  const january = new Date("2027-01-05T10:00:00Z");
  vi.setSystemTime(january);
  const [year, seq] = shown(await page()).map(Number);
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  const issue = await issueCertificate(db, kati.client.id, "e-kulm", "Kati Kask", january);
  expect(issue).toMatchObject({ kind: "issued", certificate: { number: formatCertificateNumber(year, seq) } });
});

test("a next number ahead of this year (Maria's preset in December) or in it is shown as she saved it", async () => {
  await seed({ nextYear: 2027, nextSeq: 20 }, [[2026, 14]]);
  vi.setSystemTime(new Date("2026-12-10T10:00:00Z"));
  expect(shown(await page())).toEqual(["2027", "20"]);
  vi.setSystemTime(new Date("2027-01-05T10:00:00Z"));
  expect(shown(await page())).toEqual(["2027", "20"]);
});
