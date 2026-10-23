import { readFileSync } from "node:fs";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { certificateFileName, formatCertificateNumber, readCertificateSettings, seqToIssue, tallinnYear, type CertificateSettings } from "../../src/domain/certificate";
import { clientEmail, takeTerms } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import {
  completedCourse, highestIssuedSeq, insertCertificate, NUMBER_LOCK, storedCertificate, storedCertificateSetting, storedCourseCertificate, type StoredCertificate,
} from "./certificate";
import type { CompletionCourse } from "./completion";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { runName, studentPage } from "./protocols";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// The e-course certificate (phase 3d, spec §10 "End to end"): Maria fills an e-course's "Tunnistus" card; the student, her course completed,
// confirms her name on the course page (an emoji and a Cyrillic name refused first: Review Focus 2, Latin letters as in the passport) and
// downloads the PDF (`%PDF`, its file name); Maria's drawer shows it with her download, "Paranda nimi" re-issues it under the same number, the
// register lists it; the ended access's dashboard card links it, and once the access is revoked her link goes and her download is 404 while
// Maria's drawer keeps it, marked (Review Focus 5). A student whose access ended before she confirmed her name gets it from her dashboard
// card's own form (final review I-1). Seaded → "Tunnistus": the trainer's name is the signature (no picture to upload), and one
// in Cyrillic is refused on its field with nothing stored. And the screens at 390, 834, 1194 and 1440 px. Every student is a sample address
// (`e2e-client-cert-…@example.test`, never mailed) on an e-course of the test's own; all of it is removed after each test. Under `next dev`
// and the production build (E2E_PROD_BUILD=1); Maria signs in as Dim (admin-login.ts). The number series and Seaded's setting are the whole
// database's: see the lock in certificate.ts. The locks of the issue itself on real Postgres are certificate-race.spec.ts.

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
let restoreTerms: (() => Promise<void>) | null = null;

test.beforeEach(async ({}, info) => {
  submitsForms();
  // the first view of each page under `next dev` compiles it
  info.setTimeout(180_000);
});

/** The shared course terms of version "1", held while this test is on the e-course page (which checks them); the wait for them is this test's too. */
async function holdTerms(info: TestInfo): Promise<void> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  restoreTerms = await takeTerms();
}
async function releaseTerms(): Promise<void> {
  await restoreTerms?.();
  restoreTerms = null;
}

test.afterEach(async () => {
  try {
    for (const email of made) await removeClientRows(email);
    made.clear();
    await removeAdminRows(created).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
  } finally {
    await releaseTerms();
  }
});

type Student = CompletionCourse & { email: string };

/** A student (`name`, "Kati Kask" by default) whose e-course of her own is completed; her rows go after the test. */
async function student(label: string, info: TestInfo, name?: string): Promise<Student> {
  const email = clientEmail(`cert-${label}`, runName(info));
  made.add(email);
  await removeClientRows(email);
  return { email, ...(await completedCourse(email, name)) };
}

const coursePage = (s: Student) => `/konto/kursus/${s.slug}`;
const onAccess = (accessId: number, change: "ended" | "revoked") =>
  onLocalDb(
    (sql) =>
      change === "ended"
        ? sql`update course_access set expires_at = now() - interval '1 day' where id = ${accessId}`
        : sql`update course_access set revoked_at = now() where id = ${accessId}`,
    { marksPages: false },
  );
const pdfHead = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1");
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** A radio's, a checkbox's or a file field's touch target is its label, as in completion.spec.ts (these screens have none of their own). */
const LABELLED = /^<input[^>]*\stype="(radio|checkbox|file)"/;
/** "letters" in Estonian: the name in Latin letters as in the passport (account.certificate.letters). */
const LETTERS_ET = "Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).";
/** The file fields in `scope` whose label is under 44 px tall or missing (the start of each one's HTML with the height found). */
const smallLabels = (scope: Locator): Promise<string[]> =>
  scope.locator('input[type="file"]:visible').evaluateAll((els) =>
    els
      .map((el) => ({ el, height: Math.max(0, ...Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.getBoundingClientRect().height)) }))
      .filter(({ height }) => height < 44)
      .map(({ el, height }) => `${el.outerHTML.slice(0, 120)} (label ${Math.round(height)} px)`),
  );

test("§10 e2e: Maria's 'Tunnistus' card; the student confirms her name (an emoji and Cyrillic refused first) and downloads the PDF; Maria's drawer, 'Paranda nimi', the register; the ended access's card; revoked: hers 404, Maria's still there, marked", async ({ page, context, visitorIp, browser }, info) => {
  info.setTimeout(240_000 + LOCK_WAIT_MS); // the number series may be held by another test (and holdTerms adds the terms' wait)
  const s = await student("main", info);
  const lines = ["Kulmude kuju ja proportsioonid", "Värvi valik ja segamine"];

  // Maria fills the course's "Tunnistus" card (Koolitused → the course), saved with the course
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/koolitused/${s.courseId}`);
  await adminReady(page);
  const card = page.locator("[data-certificate-card]");
  await expect(card.locator("[data-certificate-skills] h3")).toHaveText("Oskused tunnistusel");
  for (const [i, line] of lines.entries()) {
    await card.locator("[data-add-skill]").click();
    await card.locator(`[data-certificate-skill="${i}"]`).fill(line);
  }
  await card.locator('[data-field="certificateVolume"]').fill("10 akadeemilist tundi");
  await page.getByRole("button", { name: "Salvesta", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
  expect(await storedCourseCertificate(s.courseId)).toEqual({ skills: lines, volume: "10 akadeemilist tundi" });

  // the student: "Lõpetamine" has the "Tunnistus" row, her account's name in the field
  await holdTerms(info);
  const her = await studentPage(browser, s.email, visitorIp);
  await her.page.goto(coursePage(s));
  const row = her.page.locator("[data-certificate]");
  await expect(row.locator("[data-certificate-name]")).toHaveValue("Kati Kask");
  // Review Focus 2: an emoji, and a name in Cyrillic (the script font has none), are refused with the field's error before anything is stored
  for (const name of ["Kati 😀", "Катя Каск"]) {
    await row.locator("[data-certificate-name]").fill(name);
    await row.locator("[data-certificate-issue]").click();
    await expect(row.locator("[data-certificate-error]"), name).toHaveText(LETTERS_ET);
  }
  expect(await storedCertificate(s.accessId)).toBeNull();

  // her name with Estonian letters and a double surname: issued with the series' next number, the setting one further (no other test issues meanwhile)
  let before!: CertificateSettings;
  let stored!: StoredCertificate;
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    before = readCertificateSettings(await storedCertificateSetting(), new Date());
    // the issue's own rule (domain/certificate.ts seqToIssue): the setting's number, never at or below the year's highest issued
    const year = tallinnYear(new Date());
    const expected = seqToIssue(before, year, await highestIssuedSeq(year));
    await row.locator("[data-certificate-name]").fill("Kätlin Kask-Žukova");
    await row.locator("[data-certificate-issue]").click();
    await expect(row.locator("[data-certificate-number]")).toBeVisible({ timeout: 30_000 });
    stored = (await storedCertificate(s.accessId))!;
    expect([stored.year, stored.seq]).toEqual([expected.year, expected.seq]);
    expect(stored.number).toBe(formatCertificateNumber(expected.year, expected.seq));
    expect(readCertificateSettings(await storedCertificateSetting(), new Date())).toMatchObject(expected.next);
  } finally {
    await unlock();
  }
  // the frozen copy: her name, the course's title, the card's lines and volume, Seaded's place, registry code and practical line
  expect(stored).toMatchObject({
    name: "Kätlin Kask-Žukova",
    courseTitle: "E2E lõpetamine",
    skills: lines,
    volume: "10 akadeemilist tundi",
    place: before.place,
    registryCode: before.registryCode,
    practicalLine: before.practicalLine,
    reissuedAt: null,
  });
  await expect(row.locator("[data-certificate-number]")).toContainText(stored.number);
  await expect(row.locator("input[data-certificate-name]:not([readonly]):not([disabled])")).toHaveCount(0); // issued: the name is no longer hers to change
  const link = row.locator("[data-certificate-download]");
  await expect(link).toHaveAttribute("href", `/api/konto/tunnistus/${stored.id}`);
  const [download] = await Promise.all([her.page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe(certificateFileName(stored.year, stored.seq));
  expect(pdfHead(readFileSync(String(await download.path())))).toBe("%PDF-");
  await releaseTerms(); // done with the e-course page

  // Maria's drawer: the line, her download (the PDF as a download named after its number), "Paranda nimi"
  await page.goto(`/admin/opilased?id=${s.clientId}`);
  await adminReady(page);
  const line = page.locator(`[data-access="${s.courseId}"] [data-access-certificate]`);
  await expect(line).toContainText(`Tunnistus ${stored.number} · `);
  await expect(line).toContainText("Nimi tunnistusel: Kätlin Kask-Žukova");
  await expect(line.locator("[data-certificate-admin-download]")).toHaveAttribute("href", `/api/admin/tunnistus/${stored.id}`);
  const pdf = await page.request.get(`/api/admin/tunnistus/${stored.id}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toBe(`attachment; filename="${certificateFileName(stored.year, stored.seq)}"`);
  expect(pdf.headers()["cache-control"]).toContain("no-store");
  expect(pdfHead(await pdf.body())).toBe("%PDF-");
  await line.locator("[data-reissue]").click();
  await expect(line.locator("[data-reissue-name]")).toHaveValue("Kätlin Kask-Žukova");
  await line.locator("[data-reissue-name]").fill("Kätlin Kask");
  await line.locator("[data-reissue-save]").click();
  await expect(line.locator("[data-reissue-done]")).toContainText(stored.number, { timeout: 30_000 });
  const fixed = (await storedCertificate(s.accessId))!;
  expect(fixed).toMatchObject({ id: stored.id, number: stored.number, year: stored.year, seq: stored.seq, name: "Kätlin Kask" });
  expect(fixed.issuedAt).toEqual(stored.issuedAt);
  expect(fixed.reissuedAt).not.toBeNull();
  await expect(line).not.toContainText("Žukova"); // the refreshed line has the new name

  // the register, from Hindamine's second tab (A4: „Ootab hindamist {n}“ and „Tunnistused“ are on both pages)
  await page.goto("/admin/hindamine");
  await adminReady(page);
  await expect(page.locator("[data-to-register]")).toHaveCount(0);
  await page.locator("[data-tab-pills]").getByRole("link", { name: "Tunnistused" }).click();
  await expect(page).toHaveURL(/\/admin\/tunnistused$/);
  await adminReady(page);
  await expect(page.locator('[data-tab-pills] a[aria-current="page"]')).toHaveText("Tunnistused");
  await expect(page.locator("[data-tab-pills]").getByRole("link", { name: /^Ootab hindamist/ })).toHaveAttribute("href", "/admin/hindamine");
  const entry = page.locator(`[data-certificate-register] [data-register-row="${stored.id}"]`);
  for (const text of [stored.number, "Kätlin Kask", "E2E lõpetamine"]) await expect(entry).toContainText(text);
  await expect(entry.locator("[data-register-download]")).toHaveAttribute("href", `/api/admin/tunnistus/${stored.id}`);

  // her access ended: the dashboard card links the certificate, which still downloads
  await onAccess(s.accessId, "ended");
  await her.page.goto("/konto");
  await expect(her.page.locator("[data-card-certificate]")).toHaveAttribute("href", `/api/konto/tunnistus/${stored.id}`);
  const ended = await her.page.request.get(`/api/konto/tunnistus/${stored.id}`);
  expect(ended.status()).toBe(200);
  expect(pdfHead(await ended.body())).toBe("%PDF-");

  // Review Focus 5: revoked — her link goes and her download is 404; Maria's drawer keeps it, marked, without "Paranda nimi", and hers works
  await onAccess(s.accessId, "revoked");
  await her.page.reload();
  await expect(her.page.locator("[data-account-dashboard]")).toBeVisible();
  await expect(her.page.locator("[data-card-certificate]")).toHaveCount(0);
  expect((await her.page.request.get(`/api/konto/tunnistus/${stored.id}`)).status()).toBe(404);
  await page.goto(`/admin/opilased?id=${s.clientId}`);
  await adminReady(page);
  await expect(line.locator("[data-certificate-revoked]")).toHaveText("ligipääs tühistatud");
  await expect(line.locator("[data-reissue]")).toHaveCount(0);
  expect((await page.request.get(`/api/admin/tunnistus/${stored.id}`)).status()).toBe(200);
  await her.close();
});

test("I-1: completed, then her access ended before she confirmed her name: the dashboard card has the name form, issues, and then links the PDF", async ({ browser, visitorIp }, info) => {
  info.setTimeout(180_000 + LOCK_WAIT_MS); // the number series may be held by another test
  const s = await student("ended", info);
  await onAccess(s.accessId, "ended");
  const her = await studentPage(browser, s.email, visitorIp); // she lands on her dashboard
  const form = her.page.locator("[data-card-certificate-form]");
  await expect(form.locator("[data-certificate-name]")).toHaveValue("Kati Kask");
  await expect(her.page.locator("[data-card-certificate]")).toHaveCount(0);
  let stored!: StoredCertificate;
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    await form.locator("[data-certificate-issue]").click();
    await expect(her.page.locator("[data-card-certificate]")).toBeVisible({ timeout: 30_000 });
    stored = (await storedCertificate(s.accessId))!;
  } finally {
    await unlock();
  }
  expect(stored).toMatchObject({ name: "Kati Kask", courseTitle: "E2E lõpetamine", reissuedAt: null });
  await expect(form).toHaveCount(0);
  await expect(her.page.locator("[data-card-certificate]")).toHaveAttribute("href", `/api/konto/tunnistus/${stored.id}`);
  expect(await noOverflow(her.page)).toBe(true);
  const pdf = await her.page.request.get(`/api/konto/tunnistus/${stored.id}`);
  expect([pdf.status(), pdfHead(await pdf.body())]).toEqual([200, "%PDF-"]);
  await her.close();
});

test("§6 Seaded → Tunnistus: the trainer's name is the signature (no picture to upload); one in Cyrillic is refused on its field and nothing is stored", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "Seaded's setting is the whole site's: the desktop project looks at it, once");
  info.setTimeout(120_000);
  const before = await storedCertificateSetting();
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/seaded");
  await adminReady(page);
  const card = page.locator("[data-certificate-settings]");
  await expect(card.locator("[data-cert-save]")).toHaveText("Salvesta tunnistuse andmed");
  await expect(card.locator('img, input[type="file"]')).toHaveCount(0);
  const trainer = card.locator("[data-cert-trainer]");
  await expect(trainer).toHaveValue(readCertificateSettings(before, new Date()).trainerName);
  // the server refuses it before its lock and stores nothing, so no other test's number is touched
  await trainer.fill("Мария Соснина");
  await card.locator("[data-cert-save]").click();
  await expect(trainer).toHaveAttribute("aria-invalid", "true", { timeout: 30_000 });
  await expect(card).toContainText(LETTERS_ET);
  await expect(card.locator("[data-cert-status]")).toHaveText("Kontrolli märgitud välju.");
  expect((await storedCertificateSetting())?.trainerName ?? null).toBe(before?.trainerName ?? null);
});

test("the student's row, Seaded's card, the drawer's line and the register at 390, 834, 1194 and 1440 px — no sideways scroll, every target 44 px", async ({ page, context, visitorIp, browser, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  await holdTerms(info); // the e-course page is two of the screens
  const a = await student("look-a", info); // completed, her name not confirmed yet
  const b = await student("look-b", info, "Kätlin Kask-Žukova");
  const cert = await insertCertificate(b.accessId, "Kätlin Kask-Žukova");
  await signInAsAdmin(page, context, visitorIp, created);
  const herA = await studentPage(browser, a.email, visitorIp);
  const herB = await studentPage(browser, b.email, visitorIp);
  // `shows`: what the screen must show before it is measured
  const screens: { page: Page; url: string; scope: string; admin: boolean; shows: string[] }[] = [
    { page: herA.page, url: coursePage(a), scope: "[data-certificate]", admin: false, shows: ["[data-certificate-name]", "[data-certificate-issue]"] },
    { page: herB.page, url: coursePage(b), scope: "[data-certificate]", admin: false, shows: ["[data-certificate-number]", "[data-certificate-download]"] },
    { page, url: "/admin/seaded", scope: "[data-certificate-settings]", admin: true, shows: ["[data-cert-save]", "[data-cert-trainer]"] },
    { page, url: `/admin/opilased?id=${b.clientId}`, scope: `[data-access="${b.courseId}"]`, admin: true, shows: ["[data-access-certificate]", "[data-reissue]"] },
    { page, url: "/admin/tunnistused", scope: "[data-certificate-register]", admin: true, shows: ["[data-tab-pills]", `[data-register-row="${cert.id}"]`] },
  ];
  for (const width of [390, 834, 1194, 1440]) {
    for (const v of screens) {
      await v.page.setViewportSize({ width, height: 900 });
      await v.page.goto(v.url);
      if (v.admin) await adminReady(v.page);
      const scope = v.page.locator(v.scope).first();
      await expect(scope).toBeVisible();
      for (const part of v.shows) await expect(scope.locator(part).first()).toBeVisible();
      const where = `${v.url} at ${width} px`;
      expect(await noOverflow(v.page), where).toBe(true);
      // the file field is small by design: its label is the 44 px target, measured instead
      expect((await smallTargets(scope)).filter((h) => !LABELLED.test(h)), where).toEqual([]);
      expect(await smallLabels(scope), `${where}: the file field's label`).toEqual([]);
    }
  }
  await herA.close();
  await herB.close();
});
