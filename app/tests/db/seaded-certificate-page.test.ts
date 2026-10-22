import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, settings } from "@/db/schema";
import { CERT_DEFAULTS, formatCertificateNumber, tallinnYear } from "@/domain/certificate";
import { certificateCard, issueCertificate, saveCertificateSettings } from "@/server/certificates";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Seaded with its "Tunnistus" card (phase 3d, spec §6, §4), rendered from a real (PGlite) database to HTML: the card is a form of its own
// after the settings' form (never a form inside a form), it shows the stored setting (or the defaults) and the number last issued in the next
// number's year. The trainer's name is the signature (owner, 15.10): the card has no picture and no file field. The server
// actions are stand-ins (they need a browser or a request). The page reads the clock (`new Date()`): its tests count their years from it, so
// none depends on the year the suite runs in; the cases of one moment or another go to certificateCard with that moment given. The clock is
// never faked here: a PGlite that lives through a jump of Date.now() makes its Postgres timers overflow Node's setTimeout (a warning each).

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-site", () => ({ saveSettings: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-financing", () => ({ saveFinancingSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

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
/** The value of the card's input `data-cert-<hook>`. */
const valueOf = (html: string, hook: string) => {
  const tag = new RegExp(`<input[^>]*data-cert-${hook}=""[^>]*>`).exec(html)?.[0] ?? "";
  return /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
};
const shown = (html: string) => [valueOf(html, "next-year"), valueOf(html, "next-seq")];
/** The line under "Järgmine number" when nothing is issued in the year the card shows. */
const NOT_YET = (year: number) => `${year}. aastal pole veel tunnistusi väljastatud.`;
/** The Tallinn year the page is read in. */
const THIS = () => tallinnYear(new Date());

/** The stored setting (null: no row, the defaults), and one certificate per entry of `issued` ([year, seq]) with a student of its own. */
async function seed(setting: { nextYear: number; nextSeq: number } | null, issued: [number, number][]) {
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
  if (setting) await db.insert(settings).values({ key: "certificate", value: { ...CERT_DEFAULTS, ...setting } });
  return course;
}

test("without a setting: the defaults (Maria Sosnina signs), this year's number 1, nothing issued yet; the card is a form of its own after the settings' form, with no picture or file field", async () => {
  const html = await page();
  const card = html.indexOf("data-certificate-settings");
  expect(card).toBeGreaterThan(-1);
  expect(html.indexOf("</form>")).toBeLessThan(card); // the settings' form ends before the card begins
  expect(html.match(/<form/g)).toHaveLength(6); // (the settings', the certificate's and, after it, the invoices' card: invoices Task 5; then Järelmaks (Inbank)'s: instalments Task 5; then the contracts' save and sample: contracts Task 5)
  expect(html.slice(html.lastIndexOf("<section", card))).toMatch(/^<section id="tunnistus"/); // the card's anchor, for "Seaded → Tunnistus"
  expect(valueOf(html, "place")).toBe(CERT_DEFAULTS.place);
  expect(valueOf(html, "registry")).toBe(CERT_DEFAULTS.registryCode);
  expect(valueOf(html, "practical")).toBe(CERT_DEFAULTS.practicalLine);
  expect(valueOf(html, "trainer")).toBe(CERT_DEFAULTS.trainerName);
  expect(valueOf(html, "next-year")).toBe(String(THIS()));
  expect(valueOf(html, "next-seq")).toBe("1");
  expect(html).toContain(NOT_YET(THIS()));
  expect(html.slice(card)).not.toMatch(/<img|type="file"/);
});

test("a stored setting: its values, the trainer's name as stored, and the year's last issued number beside the next", async () => {
  const year = THIS();
  await seed(null, [[year, 14]]);
  await db.insert(settings).values({
    key: "certificate",
    value: { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria S.", nextYear: year, nextSeq: 15 },
  });
  const html = await page();
  expect([valueOf(html, "place"), valueOf(html, "trainer"), valueOf(html, "next-year"), valueOf(html, "next-seq")]).toEqual(["Tallinn", "Maria S.", String(year), "15"]);
  expect(html).toContain(`Viimati väljastatud: ${formatCertificateNumber(year, 14)}`);
});

test("a setting behind the series: the card shows the number after the highest, with the highest issued beside it (not a number Seaded would refuse)", async () => {
  const year = THIS();
  await seed({ nextYear: year, nextSeq: 1 }, [[year, 14]]);
  const html = await page();
  expect(shown(html)).toEqual([String(year), "15"]);
  expect(html).toContain(`Viimati väljastatud: ${formatCertificateNumber(year, 14)}`);
});

test("a setting that is still last year's (January, until the year's first issue): this year's number 1, and the card says this year has none (not last year's last number)", async () => {
  const year = THIS();
  await seed({ nextYear: year - 1, nextSeq: 15 }, [[year - 1, 14]]);
  const html = await page();
  expect(shown(html)).toEqual([String(year), "1"]);
  expect(html).toContain(NOT_YET(year));
  expect(html).not.toContain(formatCertificateNumber(year - 1, 14));
});

test("a preset for a later year says which year has no certificate yet (not 'this year': the card's year is not this year's), and is shown as saved", async () => {
  const year = THIS();
  await seed({ nextYear: year + 1, nextSeq: 20 }, [[year, 14]]);
  const html = await page();
  expect(shown(html)).toEqual([String(year + 1), "20"]);
  expect(html).toContain(NOT_YET(year + 1));
  expect(html).not.toContain("Sel aastal");
  expect(html).not.toContain(formatCertificateNumber(year, 14)); // the later year's series is shown, not this year's
});

// What the card shows as "Järgmine number" is what the next issue takes (domain/certificate.ts seqToIssue: the one rule of the issue, the save and
// the card). The setting is stored for a year and a number; an issue moves it on, but the series' highest number rules (Review Focus 3, and Task 3's
// note: in January, until the year's first issue, the stored number is still last year's). Only a number for a LATER year (Maria's preset in
// December) is shown as she saved it: an issue before that year takes this year's number, but replacing her preset on the card would let an
// unrelated save of the card overwrite it. The moment is given to certificateCard, as the page gives `new Date()`.

type Case = {
  name: string;
  setting: { nextYear: number; nextSeq: number } | null;
  issued: [number, number][];
  now: string;
  /** What the card shows (year, number) and the last issued number beside it (that year's). */
  card: [number, number];
  last: string | null;
  /** What a student's issue at that moment really gets: the card's number, except where Maria's preset is for a later year. */
  issues: [number, number];
};
const CASES: Case[] = [
  { name: "this year, nothing issued: the setting's number", setting: { nextYear: 2026, nextSeq: 3 }, issued: [], now: "2026-10-20T10:00:00Z", card: [2026, 3], last: null, issues: [2026, 3] },
  { name: "this year, the setting just past the highest", setting: { nextYear: 2026, nextSeq: 15 }, issued: [[2026, 14]], now: "2026-10-20T10:00:00Z", card: [2026, 15], last: "MS LAB 2026-14", issues: [2026, 15] },
  { name: "this year, ahead of the highest (Maria's jump): kept", setting: { nextYear: 2026, nextSeq: 20 }, issued: [[2026, 14]], now: "2026-10-20T10:00:00Z", card: [2026, 20], last: "MS LAB 2026-14", issues: [2026, 20] },
  { name: "this year, behind the highest (a number Maria set long ago): the highest + 1", setting: { nextYear: 2026, nextSeq: 1 }, issued: [[2026, 14]], now: "2026-10-20T10:00:00Z", card: [2026, 15], last: "MS LAB 2026-14", issues: [2026, 15] },
  { name: "no setting row (deleted or malformed: this year, 1) with 14 issued: the highest + 1", setting: null, issued: [[2026, 14]], now: "2026-10-20T10:00:00Z", card: [2026, 15], last: "MS LAB 2026-14", issues: [2026, 15] },
  { name: "no setting row and nothing issued: this year's 1", setting: null, issued: [], now: "2026-10-20T10:00:00Z", card: [2026, 1], last: null, issues: [2026, 1] },
  { name: "the day before the year turns in Tallinn (31.12 21:59 UTC): still this year", setting: { nextYear: 2026, nextSeq: 15 }, issued: [[2026, 14]], now: "2026-12-31T21:59:59Z", card: [2026, 15], last: "MS LAB 2026-14", issues: [2026, 15] },
  { name: "the year has turned in Tallinn (31.12 22:00 UTC) and the setting is still last year's: the new year starts at 1", setting: { nextYear: 2026, nextSeq: 15 }, issued: [[2026, 14]], now: "2026-12-31T22:00:00Z", card: [2027, 1], last: null, issues: [2027, 1] },
  { name: "January, the setting is last year's but this year's numbers have begun: the highest + 1", setting: { nextYear: 2026, nextSeq: 15 }, issued: [[2026, 14], [2027, 3]], now: "2027-01-05T10:00:00Z", card: [2027, 4], last: "MS LAB 2027-03", issues: [2027, 4] },
  { name: "a preset for next year, in December: shown as saved; an issue before the year turns still gets this year's number", setting: { nextYear: 2027, nextSeq: 20 }, issued: [[2026, 14]], now: "2026-12-10T10:00:00Z", card: [2027, 20], last: null, issues: [2026, 15] },
  { name: "that preset once the year has come: its number", setting: { nextYear: 2027, nextSeq: 20 }, issued: [[2026, 14]], now: "2027-01-05T10:00:00Z", card: [2027, 20], last: null, issues: [2027, 20] },
  { name: "that preset once the year has come and passed it: the highest + 1", setting: { nextYear: 2027, nextSeq: 20 }, issued: [[2026, 14], [2027, 25]], now: "2027-02-01T10:00:00Z", card: [2027, 26], last: "MS LAB 2027-25", issues: [2027, 26] },
];

test.each(CASES)("the card's number and the issue's number: $name", async ({ setting, issued, now, card, last, issues }) => {
  const course = await seed(setting, issued);
  const moment = new Date(now);
  const read = await certificateCard(db, moment);
  expect([read.settings.nextYear, read.settings.nextSeq, read.last]).toEqual([...card, last]);
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  const issue = await issueCertificate(db, kati.client.id, "e-kulm", "Kati Kask", moment);
  expect(issue).toMatchObject({ kind: "issued", certificate: { number: formatCertificateNumber(...issues) } });
});

test.each(CASES)("what the card shows is accepted by its own save: $name", async ({ setting, issued, now, card }) => {
  await seed(setting, issued);
  const read = await certificateCard(db, new Date(now));
  expect([read.settings.nextYear, read.settings.nextSeq]).toEqual(card);
  expect(await saveCertificateSettings(db, { ...CERT_DEFAULTS, nextYear: card[0], nextSeq: card[1] }, new Date(now))).toMatchObject({ ok: true });
});
