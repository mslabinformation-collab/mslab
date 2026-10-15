# MS LAB — E-course Certificate (Phase 3d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an e-course is "Lõpetatud", the student confirms her name once and downloads a PDF certificate that looks like Maria's paper ones and continues their number series. Maria manages the certificate settings (signature, next number, place) in Seaded, corrects a name and re-issues it from the student's drawer, and sees every certificate in one register.

**Architecture:**
- **Data:** one additive migration, `0009_certificates.sql`.
  - A `certificates` table holds one row per completed access with a frozen copy of everything printed: the number "MS LAB {year}-{nn}", year and seq, name, course title, skills, volume, practical line, place, registry code and issue date.
  - `courses.certificate_skills` and `courses.certificate_volume` hold the per-course text.
  - The `settings` key `certificate` holds the place, the registry code, the practical line, the trainer's name, the next number and the private signature image key.
  - The `courses.modules` drop moves to `0010`.
- **Rules:** the name rules, the number format, next-number with year rollover and the skills fallback are pure, in `src/domain/certificate.ts`.
- **Issuing:** `src/server/certificates.ts` issues in one transaction. It locks the access row first, then a transaction-scoped advisory lock for the number series, then reads and advances the setting. Re-issue keeps the number.
- **PDF:** `src/server/certificate-pdf.ts` renders the certificate on every download from the frozen row with `pdf-lib` and `@pdf-lib/fontkit`. The committed fonts are Jost and Great Vibes, and Maria's signature PNG comes from private R2. The output is A4 landscape, black, laid out like Maria's sample.
- **Student:**
  - **E-course page:** the "Lõpetamine" block gets a "Tunnistus" row with "Nimi tunnistusel", then "Kinnita ja koosta tunnistus", then "Laadi tunnistus alla (PDF)".
  - **Routes:** `POST /api/konto/kursus/<slug>/tunnistus` and `GET /api/konto/tunnistus/<id>`.
  - **Dashboard:** an ended access's card links its certificate.
  - **Mail:** the "completed" mail gets one line asking her to confirm her name and download it.
- **Admin:**
  - **Course editor:** a "Tunnistus" card on e-courses (skills, volume).
  - **Seaded:** a "Tunnistus" card. The signature upload turns the scan into white ink on transparent in the browser and stores it privately through `POST /api/admin/allkiri`.
  - **Downloads and corrections:** Maria downloads through `GET /api/admin/tunnistus/<id>`, and the Õpilased drawer has "Paranda nimi".
  - **Register:** `/admin/tunnistused`, linked from Hindamine.

**Tech Stack:**
- Next.js 16.3.8 (pinned exactly; do not upgrade), React 19, TypeScript.
- Drizzle 0.45 + postgres.js 3.4 (Railway); PGlite for DB tests.
- Vitest (+ happy-dom), Playwright.
- **New and pinned exactly:** `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1` (MIT, pure JavaScript).
- R2 for the signature image.
- Hosting: Vercel Hobby, project `mslab` (fra1).

**Spec:** `docs/superpowers/specs/2026-10-15-certificate-design.md` (decisions D1–D6, amended 15.10 after the font spike). Read all of it before starting; the section your task names is binding.

## Global Constraints

### Platform and dependencies
- **Vercel Hobby only.** The PDF is rendered on request in the account API (`maxDuration` 30) and in `GET /api/admin/tunnistus/[id]` (`maxDuration = 30`). It is under 300 KB and takes tens of milliseconds. The signature upload is at most 1 MB, well under the 4.5 MB body limit.
- **The only new dependencies:** `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1`, exact versions in `app/package.json` (no caret). No other new package.
- **Font files:** committed exactly as downloaded, checked by SHA-256:
  - `app/assets/fonts/GreatVibes-Regular.ttf` (`8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15`, from `https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf`);
  - `app/assets/fonts/Jost[wght].ttf` (`6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076`, from `https://raw.githubusercontent.com/google/fonts/main/ofl/jost/Jost%5Bwght%5D.ttf`);
  - their licences `app/assets/fonts/OFL-GreatVibes.txt` (`61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49`) and `app/assets/fonts/OFL-Jost.txt` (`1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5`), from the same folders' `OFL.txt`.
- **Font tracing and line endings:**
  - `next.config.ts` lists `./assets/fonts/**` in `outputFileTracingIncludes` under the keys `"/api/konto/**"` and `"/api/admin/tunnistus/**"`. Under Turbopack in Next 16.3.8, bracketed route keys trace nothing.
  - `.vercelignore` gets `!/app/assets`.
  - A root `.gitattributes` holds `app/assets/fonts/** -text`, so autocrlf never changes the hashed files.
  - The server reads the fonts with `fs` from `path.join(process.cwd(), "assets", "fonts")`.
- **Never call real Resend, Telegram or R2 from a test** (`stubFetch`, `fakeMediaStore`).

### The rules of this phase (spec §3–§7)
- **Numbering:** `"MS LAB " + year + "-" + seq` with `seq` zero-padded to at least 2 digits. The year is the Tallinn year of the issue moment. A new year starts at 1. Two certificates never share a number: the access row is locked, then `pg_advisory_xact_lock(hashtext('certificate-number'))` is taken, and the unique (`year`, `seq`) index is the backstop.
- **Frozen copy:** an issued certificate prints only what its row holds. Later course or settings changes never alter it, except the signature image, which is not frozen. A re-issue changes only `name` and `reissued_at`.
- **Name rules** (`checkCertificateName`): NFC, trimmed, inner whitespace collapsed; 2–80 characters; at least 2 letters.
  - Allowed letters are only those Great Vibes can draw: Estonian, other European Latin, and Russian, Ukrainian and Belarusian Cyrillic. Task 2's test checks every accepted letter against the font.
  - Spaces, hyphens, apostrophes (' and ’) and dots are also allowed.
  - No lookbehind.
- **Who may download:**
  - **The student:** only her own access's certificate, and only while the access is not revoked. Expiry does not matter.
  - **Maria:** every certificate, revoked ones included, marked "ligipääs tühistatud".
- **Certificate text:** Estonian only. The pages around it are ET and RU for the student, and Estonian for the admin.
- **Mails:** the only change is one added line in the "completed" mail. It carries a link only, no attachment. Mails go after the commit and skip sample addresses, as before.
- **Logs:** ids only (`[certificate] access N: issued <number>`, `[certificate] N: re-issued`). Never a name or an address.

### Static shells, the account API, the gate
- **Account pages stay static** (no query, no cookies). The new account routes:
  - start with `requireClient`;
  - answer through `clientResponse`, or through a helper defined above the guard test's START marker for the PDF's binary answer (handlers never build `new Response`);
  - are registered in `tests/unit/account-guards.test.ts`;
  - are matched before `LESSON_PATH`;
  - are gated (`/api/konto*` is already).
- **The PDF answer headers:** `content-type: application/pdf`, `content-disposition: attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`, `cache-control: private, no-store`, `x-content-type-options: nosniff`.

### Simplicity and design
- **One primary button per screen; 44 px targets; widths 390/834/1194/1440 without overflow; colour tokens only.** Every new `.module.css` goes into `tests/unit/colour-tokens.test.ts` COURSE_CSS.
- **Old Safari:** no lookbehind in any browser file. `src/domain/certificate.ts` and `src/lib/signature-ink.ts` go into `tests/unit/old-safari.test.ts` BROWSER_FILES.
- **Texts:** student strings in `et.ts` and `ru.ts` (parity, placeholders, Cyrillic; the `account.certificate` block joins the Russian-typography list in `tests/unit/protocols.test.ts`). Admin strings in `admin.ts`, Estonian only. Every new text is in the task's Wording table, marked Spec or Draft.

### Repository, database, commits
- **The repository is PUBLIC.** No real address or secret anywhere. Tests use `@example.test`. Maria's reference certificate (in the git-ignored `Assets/`) is never committed or published. The registry code "16346048" is the company's public register code, which may appear.
- **Migration `0009_certificates.sql`** is additive, generated with `npx drizzle-kit generate --name certificates` and reviewed. The texts that call the `courses.modules` drop 0009 become **0010**:
  - `src/db/schema.ts`;
  - `drizzle/0003_lessons.sql` (a comment);
  - `tests/db/migration-0003.test.ts`;
  - `docs/launch-checklist.md`;
  - `docs/deploy.md`.
  The old plans and specs stay as they are.
- **Applying the migration:** locally only during the tasks: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/mslab npm run db:migrate` from `app/` (local Docker `mslab-pg`). Railway and the push are Task 8 (controller). mslab.ee is staging: push after review.
- **Commits:** Conventional Commits, from the repository root, ending with the harness's Co-Authored-By line. Each task ends green on its own: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, plus the e2e specs it names.

## Review Focus

1. **Two certificates at the same moment** (two students completing in the same second, or one student double-tapping on two devices): two numbers, never one, and one certificate per access. Tests:
   - Task 3 `certificates.test.ts` "Review Focus 1" (the second issue answers `already`; the number advances);
   - Task 7 `certificate-race.spec.ts` (two accesses issuing at once on real Postgres get consecutive numbers).
2. **A name the fonts or the layout cannot take:**
   - a very long name, or a double surname with a hyphen;
   - Cyrillic, or letters such as õ, š, ž;
   - an emoji or digits.
   Allowed letters print. The long name shrinks to fit the line, then wraps to two lines. An emoji or digits are refused with the field error before anything is stored. Tests:
   - Task 1 `certificate-rules.test.ts` "Review Focus 2";
   - Task 2 `certificate-pdf.test.ts` "Review Focus 2" (an 80-character name and a Cyrillic name render, and the text extraction finds them).
3. **The year turns** at Tallinn midnight on 31.12: a certificate issued at 22:30 UTC on 31.12 is already the next year's in Tallinn, so it starts at 1. Maria's "next number" for the old year does not carry over. Tests:
   - Task 1 "Review Focus 3" (`nextNumber`, `tallinnYear`);
   - Task 3 "Review Focus 3".
4. **Maria changes the settings after certificates exist:**
   - a new place or registry code: old certificates keep theirs;
   - a new signature: shown on every download;
   - a "next number" at or below an issued one in the same year: refused with a field error.
   Tests: Task 3 "Review Focus 4"; Task 5 `certificate-settings-dom.test.ts`.
5. **The access is revoked after the certificate was issued:**
   - the student's download answers 404;
   - the dashboard link disappears;
   - Maria still sees and downloads it, marked revoked.
   Tests: Task 3 "Review Focus 5"; Task 4 `certificate-api.test.ts` "Review Focus 5"; Task 6.

---

## File Structure

```
app/
  package.json, package-lock.json              pdf-lib@1.17.1, @pdf-lib/fontkit@1.1.1 (Task 1)
  assets/fonts/GreatVibes-Regular.ttf, Jost[wght].ttf, OFL-GreatVibes.txt, OFL-Jost.txt   (Task 1)
  next.config.ts                                outputFileTracingIncludes for the fonts (Task 1)
  drizzle/0009_certificates.sql                 certificates; courses.certificate_skills/_volume (Task 1)
  src/db/schema.ts                              certificates, Certificate, the two course columns (Task 1)
  src/domain/certificate.ts                     pure: name rules, number format, next number, skills fallback, settings reader (Task 1)
  src/server/certificate-pdf.ts                 loadCertificateAssets, renderCertificate (Task 2)
  src/server/certificates.ts                    issue, re-issue, reads, settings, signature key, register (Task 3)
  src/server/account-api.ts                     POST /kursus/:slug/tunnistus, GET /tunnistus/:id, pdfAnswer (Task 4)
  src/server/client-data.ts                     EcourseView.completion.certificate, EcourseCard.certificateId (Task 4)
  src/components/account/CompletionSteps.tsx (+css), AccountCourseCard.tsx   the "Tunnistus" row, the card link (Task 4)
  src/server/account-mail.ts, src/i18n/dict/et.ts, ru.ts                     the completed mail's line, account.certificate (Task 4)
  src/domain/course-editor.ts, src/server/admin-content.ts, src/db/queries/admin.ts, src/components/admin/CourseEditor.tsx
                                                the course editor's "Tunnistus" card (Task 5)
  src/lib/signature-ink.ts                      the browser's white-ink conversion of the signature scan (Task 5)
  src/components/admin/CertificateSettings.tsx (+css), src/app/admin/(panel)/seaded/page.tsx   Seaded → Tunnistus (Task 5)
  src/app/api/admin/allkiri/route.ts            POST/GET/DELETE the signature image (Task 5)
  src/app/api/admin/tunnistus/[id]/route.ts     Maria's download (Task 5)
  src/server/actions/admin-certificates.ts      saveCertificateSettingsAction (Task 5), reissueCertificateAction (Task 6)
  src/server/admin-clients.ts, src/components/admin/ClientDrawer.tsx, src/components/admin/ReissueCertificate.tsx
                                                the drawer's certificate line and "Paranda nimi" (Task 6)
  src/app/admin/(panel)/tunnistused/page.tsx    the register (Task 6)
  tests/…                                       each task's tests
  tests/e2e/certificate.spec.ts, certificate-race.spec.ts   end to end (Task 7)
docs/deploy.md, docs/launch-checklist.md        0010 renumbering (Task 1); §14 runbook, §13 list (Task 7)
```

---

### Task 1: pdf-lib and the fonts, their tracing, migration 0009 (`certificates`, the course's certificate lines and volume), the pure rules (`domain/certificate.ts`); the drop of `courses.modules` becomes 0010

**Scope.**
- **Spec:** §3 (the data and the settings' defaults), §4 (numbering), §5 (the name rules), §7 (the fonts), §10 (unit tests); decisions D2, D3 and D5.
- **Global Constraints:** "Platform and dependencies" (the exact pins, the font files and their hashes, the font tracing), "The rules of this phase" (numbering, name rules) and "Migration 0009".
- **Review Focus 2 and 3** (the rule tests).
- **Two plan rulings (Self-review, "Spec against the code" rows 1–2):** the tracing keys and the name rule's letters.
- **Spec conflict:** §10's "Cyrillic refused" predates the font spike of 15.10. §5 and the Global Constraints accept Cyrillic, and so does this task.

Nothing reads the new table or columns yet. Every later task builds on them.

**What the migration does to live data.** It only adds:
- the table `certificates`, empty;
- two columns on `courses`, `certificate_skills` (default `[]`) and `certificate_volume` (default `''`).

No existing column changes, so the code that is live now runs on unchanged.

**Two files beyond the outline.**
- **`.vercelignore`:** the root file is an allow-list, so without `!/app/assets` a CLI deploy (`docs/deploy.md` section 3) would leave the fonts out. Its guard test and §3's list change with it.
- **A root `.gitattributes`:** this machine has `core.autocrlf=true`, which would turn the OFL texts' line endings into CRLF on the next checkout (a worktree, a branch switch) and break their SHA-256. `-text` keeps the four files byte for byte.

**Files:**
- Modify: `app/package.json`, `app/package-lock.json` (npm, step 3)
- Create: `app/assets/fonts/GreatVibes-Regular.ttf`, `app/assets/fonts/Jost[wght].ttf`, `app/assets/fonts/OFL-GreatVibes.txt`, `app/assets/fonts/OFL-Jost.txt`; `.gitattributes` (repository root)
- Modify: `.vercelignore` (line 10, after `!/app/public`); `app/tests/unit/vercelignore.test.ts` (line 30 `BUILD_INPUTS`, line 35 `wanted`); `docs/deploy.md:80`
- Modify: `app/next.config.ts` (after `...e2ePageCache,`, line 32); `app/tests/unit/next-config.test.ts` (a new `describe` at the end)
- Modify: `app/src/db/schema.ts` (line 35; after line 52 `protocolStages`; after line 521, the end of `practicalPhotos`; the settings comment, line 537; the type list, after line 587)
- Create (drizzle-kit): `app/drizzle/0009_certificates.sql`, `app/drizzle/meta/0009_snapshot.json`, the `0009_certificates` entry of `app/drizzle/meta/_journal.json`
- Modify: `app/tests/db/migration-0007.test.ts:49`
- Create: `app/src/domain/certificate.ts`
- Modify: `app/tests/unit/old-safari.test.ts` (`BROWSER_FILES`, after line 68)
- Modify (the 0010 texts): `app/drizzle/0003_lessons.sql:55` (a comment only), `app/tests/db/migration-0003.test.ts:14`, `docs/launch-checklist.md:107` and `:163`, `docs/deploy.md:112`, `:208` and `:237`. The old plans and specs are history and stay as they are.
- Test: `app/tests/unit/certificate-fonts.test.ts` (new), `app/tests/db/migration-0009.test.ts` (new), `app/tests/unit/certificate-rules.test.ts` (new, Review Focus 2 and 3)

**Interfaces:**
- **Consumes:**
  - nothing from earlier tasks;
  - existing: `tallinnFormParts(instant: Date): { date: string; time: string }` (`src/domain/calendar.ts`, browser-safe, already in `BROWSER_FILES`) and `migrationsThrough(tag)` (`tests/db/helpers.ts`).
- **Produces, from `src/db/schema.ts`** (exactly as listed):
  - `certificates` (`certificates`: `id, accessId → course_access cascade, number, year, seq, name, courseTitle, skills (jsonb string[]), volume (default ""), practicalLine, place, registryCode, issuedAt, reissuedAt (null), createdAt`), with the unique indexes `certificates_access` (access_id), `certificates_number` (number) and `certificates_year_seq` (year, seq), and the check `certificates_seq_positive` (`seq >= 1`);
  - `type Certificate = typeof certificates.$inferSelect`;
  - `courses.certificateSkills: string[]` (default `[]`) and `courses.certificateVolume: string` (default `""`).
- **Produces, from `src/domain/certificate.ts`** (pure, browser-safe, no lookbehind):
  - `CERT_LIMITS`, `CERT_DEFAULTS`;
  - `type CertificateSettings = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: number; nextSeq: number; signatureKey: string | null }`;
  - `tallinnYear(d: Date): number` and `tallinnDateText(d: Date): string` ("dd.mm.yyyy");
  - `readCertificateSettings(value: unknown, now: Date): CertificateSettings`;
  - `checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" }`;
  - `formatCertificateNumber(year: number, seq: number): string` and `certificateFileName(year: number, seq: number): string`;
  - `nextNumber(s: { nextYear: number; nextSeq: number }, year: number): { year: number; seq: number; next: { nextYear: number; nextSeq: number } }`;
  - `certificateSkills(course: { certificateSkills: readonly string[]; outcomes: readonly { et: string }[] }): string[]`.
- **Produces, for Tasks 2–8:**
  - the four files in `app/assets/fonts/`;
  - `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1` installed;
  - `outputFileTracingIncludes` `{ "/api/konto/**": ["./assets/fonts/**"], "/api/admin/tunnistus/**": ["./assets/fonts/**"] }`.
- **Rules the later tasks rely on** (all in the code and pinned by the tests below):
  - **`checkCertificateName`:**
    - it first cleans: NFC, then every run of white space (no-break spaces included) becomes one space, then a trim;
    - "length" when the cleaned name is not 2–80 code points;
    - "letters" when it holds anything other than an accepted letter or a joiner (space, `-`, `'`, `’`, `.`), or fewer than two letters.
    - The accepted name is the cleaned one: store that, never the raw input.
  - **`readCertificateSettings`:**
    - each text is trimmed, and a missing, blank or over-limit one becomes its default;
    - `nextYear`/`nextSeq` are a pair: a whole year 2000–9999 and a whole number ≥ 1, else both become (`tallinnYear(now)`, 1);
    - `signatureKey` counts only when it starts with `certificate/`.
  - **`nextNumber`:** `seq = nextSeq` only when `nextYear === year`, else 1. The setting then becomes `{ nextYear: year, nextSeq: seq + 1 }`. The caller passes `tallinnYear(issue moment)`.
  - **`certificateSkills`:**
    - the course's own lines when any is not blank, else its outcomes' `et`;
    - each line is collapsed to one line and trimmed, and blank ones are dropped;
    - at most 16 lines; a line is never cut.

- [ ] **Step 1: Write the failing test of the fonts and the pins** `tests/unit/certificate-fonts.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The certificate's two fonts and their licences (phase 3d, spec §7) are committed exactly as downloaded from google/fonts on 15.10.2026
// (ofl/greatvibes and ofl/jost, each folder's OFL.txt beside its font): byte for byte, so a changed or truncated file, or a checkout that
// converted line endings, fails here and not in a student's PDF. The root .gitattributes keeps git from converting them. The two packages
// that draw the PDF are pinned exactly, as the spike of 15.10 proved them with these fonts.

const FONTS = join(process.cwd(), "assets", "fonts");
const SHA256: Record<string, string> = {
  "GreatVibes-Regular.ttf": "8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15",
  "Jost[wght].ttf": "6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076",
  "OFL-GreatVibes.txt": "61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49",
  "OFL-Jost.txt": "1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5",
};

test("the folder holds exactly the two fonts and their licences, byte for byte as downloaded (SHA-256)", () => {
  expect(readdirSync(FONTS).sort()).toEqual(Object.keys(SHA256).sort());
  for (const [name, hash] of Object.entries(SHA256)) expect(createHash("sha256").update(readFileSync(join(FONTS, name))).digest("hex"), name).toBe(hash);
});

test("the licences are the SIL Open Font License 1.1 of each font", () => {
  for (const [name, font] of [["OFL-GreatVibes.txt", "Great Vibes"], ["OFL-Jost.txt", "Jost"]]) {
    const text = readFileSync(join(FONTS, name), "utf8");
    expect(text, name).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text, name).toContain(font);
  }
});

test("pdf-lib and its fontkit are pinned exactly (no range), in package.json and in the lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  expect([pkg.dependencies["pdf-lib"], pkg.dependencies["@pdf-lib/fontkit"]]).toEqual(["1.17.1", "1.1.1"]);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
  expect([lock.packages["node_modules/pdf-lib"].version, lock.packages["node_modules/@pdf-lib/fontkit"].version]).toEqual(["1.17.1", "1.1.1"]);
});
```

- [ ] **Step 2: Run it — expect FAIL.** `cd app && npx vitest run tests/unit/certificate-fonts.test.ts`:
  - the first two tests fail with `ENOENT: no such file or directory, scandir '…\app\assets\fonts'` (or `open …`): the folder does not exist yet;
  - the third fails with `expected [ undefined, undefined ] to deeply equal [ '1.17.1', '1.1.1' ]`.

- [ ] **Step 3: Install the two packages, pinned exactly.**
  1. From `app/`, run `npm install --save-exact pdf-lib@1.17.1 @pdf-lib/fontkit@1.1.1`.
  2. `package.json`'s `dependencies` then reads exactly as below (npm sorts the keys; no caret on the two new lines):

```json
  "dependencies": {
    "@pdf-lib/fontkit": "1.1.1",
    "aws4fetch": "^1.0.20",
    "drizzle-orm": "^0.45.3",
    "next": "16.3.8",
    "pdf-lib": "1.17.1",
    "postgres": "^3.4.9",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "resend": "^6.31.0",
    "tus-js-client": "^4.3.1",
    "zod": "^4.6.5"
  },
```

  3. Check `git diff package-lock.json`: it may only **add** entries, besides the root package's two `dependencies` lines. The entries are:
     - `node_modules/@pdf-lib/fontkit` 1.1.1;
     - `node_modules/@pdf-lib/standard-fonts` 1.0.0;
     - `node_modules/@pdf-lib/upng` 1.0.1;
     - `node_modules/pako` 1.0.11;
     - `node_modules/pdf-lib` 1.17.1;
     - `node_modules/pdf-lib/node_modules/tslib` 1.14.1. The app's own `node_modules/tslib` stays 2.8.1.

     All are MIT, except pako (MIT and Zlib) and tslib (0BSD).
  4. If npm changed any other entry: run `git checkout package.json package-lock.json` and install again; never commit an unrelated upgrade.

- [ ] **Step 4: Download the fonts and their licences, byte for byte, and keep git from converting them.**
  1. From `app/` (Git Bash; `--globoff` because the Jost URL carries brackets, encoded):

```bash
mkdir -p assets/fonts
curl -fsSL --globoff -o assets/fonts/GreatVibes-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf"
curl -fsSL --globoff -o "assets/fonts/Jost[wght].ttf" "https://raw.githubusercontent.com/google/fonts/main/ofl/jost/Jost%5Bwght%5D.ttf"
curl -fsSL --globoff -o assets/fonts/OFL-GreatVibes.txt "https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/OFL.txt"
curl -fsSL --globoff -o assets/fonts/OFL-Jost.txt "https://raw.githubusercontent.com/google/fonts/main/ofl/jost/OFL.txt"
sha256sum assets/fonts/*
```

  2. `sha256sum` must print exactly these four lines (sizes 457 588, 134 996, 4 399 and 4 384 bytes):

```
8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15 *assets/fonts/GreatVibes-Regular.ttf
6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076 *assets/fonts/Jost[wght].ttf
61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49 *assets/fonts/OFL-GreatVibes.txt
1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5 *assets/fonts/OFL-Jost.txt
```

     If a hash differs (google/fonts changed a file after 15.10.2026), **stop and report it**. Never commit other bytes and never edit the test's hashes: the spike proved these exact files.
  3. Create `.gitattributes` at the **repository root** (there is none yet):

```
# The certificate's fonts and their licences are committed byte for byte as downloaded (app/tests/unit/certificate-fonts.test.ts checks
# their SHA-256): no line-ending conversion on any checkout (this machine has core.autocrlf=true, which would make the OFL texts CRLF).
app/assets/fonts/** -text
```

  4. Check from the repository root: `git check-attr text -- "app/assets/fonts/OFL-Jost.txt"` prints `app/assets/fonts/OFL-Jost.txt: text: unset`, and `git check-ignore -v app/assets/fonts/OFL-Jost.txt` prints nothing (not ignored).

- [ ] **Step 5: Run** `npx vitest run tests/unit/certificate-fonts.test.ts` — expect PASS (3 tests).

- [ ] **Step 6: The tracing test (failing).** Append to `tests/unit/next-config.test.ts`, after the last `});` of the file:

```ts

describe("next.config.ts outputFileTracingIncludes (the certificate, phase 3d)", () => {
  // The PDF is drawn in two functions, the account API and Maria's download, from fonts read with fs (server/certificate-pdf.ts), so the
  // folder goes with both. The keys are globs matched against each route's name. Turbopack (Next 16.3.8, `next build`'s bundler) matches
  // "/api/konto/**", but neither the literal "/api/konto/[[...path]]" nor a backslash-escaped one: checked with a build on 15.10.2026.
  test("the fonts go with the two functions that render the certificate, named by their folders", async () => {
    expect((await config()).outputFileTracingIncludes).toEqual({
      "/api/konto/**": ["./assets/fonts/**"],
      "/api/admin/tunnistus/**": ["./assets/fonts/**"],
    });
  });
});
```

  Run `npx vitest run tests/unit/next-config.test.ts` — expect FAIL: `expected undefined to deeply equal { '/api/konto/**': [ './assets/fonts/**' ], … }`.

- [ ] **Step 7: Trace the fonts** (`next.config.ts`). Replace `  ...e2ePageCache,` (line 32) with:

```ts
  ...e2ePageCache,
  // The certificate's fonts (phase 3d): server/certificate-pdf.ts reads app/assets/fonts with fs on every download, so `next build` must put
  // the folder into the two functions that render the PDF, the account API (/api/konto/[[...path]]) and Maria's download
  // (/api/admin/tunnistus/[id]). Turbopack matches these keys by glob against the route's name: "/**" works, the bracketed route names do
  // not (checked with a build on 15.10.2026), so each key names the route's folder.
  outputFileTracingIncludes: {
    "/api/konto/**": ["./assets/fonts/**"],
    "/api/admin/tunnistus/**": ["./assets/fonts/**"],
  },
```

  Run `npx vitest run tests/unit/next-config.test.ts` — expect PASS.

- [ ] **Step 8: A CLI deploy uploads the fonts too** (the root `.vercelignore` is an allow-list).
  1. In `tests/unit/vercelignore.test.ts`, line 30 becomes:

```ts
const BUILD_INPUTS = ["src", "public", "assets", "drizzle", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "vercel.json", "drizzle.config.ts"];
```

     and line 35 becomes:

```ts
    const wanted = [...BUILD_INPUTS.filter((p) => !["src", "public", "assets", "drizzle"].includes(p)), "src/middleware.ts", "src/instrumentation.ts", "public/feedback.js", "assets/fonts/Jost[wght].ttf", `drizzle/${sql}`];
```

     Then the comment above `BUILD_INPUTS` (line 29) becomes:

```ts
/** What the Vercel build of app/ reads (project Root Directory `app`), the certificate's fonts included (phase 3d): the only things of app/ that may be uploaded. */
```

  2. Run `npx vitest run tests/unit/vercelignore.test.ts` — expect FAIL in one test, "uploads what the build of app/ reads": `expected [ 'assets/fonts/Jost[wght].ttf' ] to deeply equal []`. The file still leaves `app/assets` out; the other five tests pass.
  3. In the repository root's `.vercelignore`, after line 10 `!/app/public`, add the line `!/app/assets`, so that the allow-list block reads:

```
/*
!/app
/app/*
!/app/src
!/app/public
!/app/assets
!/app/drizzle
```

  4. In `docs/deploy.md` line 80, ``The root file is an allow-list of what `next build` in `app/` reads: `app/src`, `app/public`, `app/drizzle` and six files`` becomes ``The root file is an allow-list of what `next build` in `app/` reads: `app/src`, `app/public`, `app/assets` (the certificate's fonts, phase 3d), `app/drizzle` and six files``. The rest of the line stays.
  5. Run `npx vitest run tests/unit/vercelignore.test.ts` — expect PASS.

- [ ] **Step 9: Write the failing migration test** `tests/db/migration-0009.test.ts`:

```ts
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { certificates, clients, courseAccess, courses } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0009 (the certificate, phase 3d) as the Railway database goes through it: 0000–0008 applied, a contact course and an e-course
// with a completed access, all written by the live code (which knows none of 0009's columns), then 0009. Every course gets no certificate
// lines and no volume, and the new table is there, empty, with its rules: one certificate per access, one per number and one per year and
// number, the number from 1, the access required, and the account's deletion takes the access and its certificate with it. A rule that
// fails is checked by the name of the constraint in the database's own error, so that another failure cannot pass for it.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0009 gives every course no certificate lines and no volume, and adds certificates with their rules, deleted with the access", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0008_ecourse_completion");
  // the live code's rows (raw SQL: drizzle would name the columns 0009 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group, outcomes) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000, '[{"et":"Kulmude kuju"}]')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900)`);
  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  await db.execute(sql`insert into clients (email) values ('kati@example.test'), ('mari@example.test')`);
  const who = Object.fromEntries((await db.select({ id: clients.id, email: clients.email }).from(clients)).map((c) => [c.email, c.id]));
  await db.execute(
    sql`insert into course_access (client_id, course_id, granted_by, expires_at, completed_at) values (${who["kati@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', '2026-10-14T10:00:00Z'), (${who["mari@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', null)`,
  );
  const access = Object.fromEntries((await db.select({ id: courseAccess.id, clientId: courseAccess.clientId }).from(courseAccess)).map((a) => [a.clientId, a.id]));

  await through("0009_certificates");

  // what was there: each course gets no certificate lines and no volume; its outcomes stay as they were
  expect(await db.select({ slug: courses.slug, outcomes: courses.outcomes, skills: courses.certificateSkills, volume: courses.certificateVolume }).from(courses).orderBy(courses.slug)).toEqual([
    { slug: "e", outcomes: [], skills: [], volume: "" },
    { slug: "k", outcomes: [{ et: "Kulmude kuju" }], skills: [], volume: "" },
  ]);
  expect(await db.select().from(certificates)).toEqual([]);

  // a certificate: the frozen copy, the volume empty by default, no re-issue yet, its creation stamped
  const kati = access[who["kati@example.test"]];
  const copy = {
    number: "MS LAB 2026-03", year: 2026, seq: 3, name: "Kati Kask", courseTitle: "E", skills: ["Kulmude kuju"],
    practicalLine: "Praktiline töö", place: "Pärnu linn", registryCode: "16346048", issuedAt: new Date("2026-10-15T09:00:00Z"),
  };
  const [first] = await db.insert(certificates).values({ accessId: kati, ...copy }).returning();
  expect(first).toMatchObject({ accessId: kati, ...copy, volume: "", reissuedAt: null });
  expect(first.createdAt).toBeInstanceOf(Date);

  // one per access, one per number, one per year and number; the number from 1; the access must exist
  const mari = access[who["mari@example.test"]];
  await violates(db.insert(certificates).values({ ...copy, accessId: kati, number: "MS LAB 2026-04", seq: 4 }), "certificates_access");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, seq: 4 }), "certificates_number");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2026-3" }), "certificates_year_seq");
  await violates(db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2026-00", seq: 0 }), "certificates_seq_positive");
  await violates(db.insert(certificates).values({ ...copy, accessId: 999_999, number: "MS LAB 2026-04", seq: 4 }), "certificates_access_id_course_access_id_fk");
  // the same number in another year is another certificate
  await db.insert(certificates).values({ ...copy, accessId: mari, number: "MS LAB 2027-03", year: 2027, volume: "10 akadeemilist tundi" });

  // the account's deletion takes the access and its certificate; the other one stays
  await db.delete(clients).where(eq(clients.id, who["kati@example.test"]));
  expect((await db.select({ number: certificates.number }).from(certificates)).map((c) => c.number)).toEqual(["MS LAB 2027-03"]);
});
```

  Run `npx vitest run tests/db/migration-0009.test.ts` — expect FAIL. `migrationsThrough("0009_certificates")` stops at its own `expect(at, "0009_certificates").toBeGreaterThanOrEqual(0)` (`expected -1 to be greater than or equal to 0`): the migration does not exist yet, and neither does the `certificates` export.

- [ ] **Step 10: Change the schema** (`src/db/schema.ts`). Make these five edits.
  1. Line 35 becomes:

```ts
  // Legacy (phase 3a): module titles live in course_modules; nothing reads or writes this column. Migration 0010 drops it after the 3a deploy (code first).
```

  2. After line 52 (`protocolStages: jsonb("protocol_stages").$type<string[]>().notNull().default([]),`) add:

```ts
  /**
   * An e-course's competency lines on its certificate (phase 3d, spec §3): plain Estonian text, at most 16 of at most 120 characters (the
   * course editor's "Tunnistus" card). Empty: the certificate takes the course's outcomes, Estonian (domain/certificate.ts certificateSkills).
   */
  certificateSkills: jsonb("certificate_skills").$type<string[]>().notNull().default([]),
  /** An e-course's volume on its certificate, "10 akadeemilist tundi"; empty: the PDF leaves it out. */
  certificateVolume: text("certificate_volume").notNull().default(""),
```

  3. After line 521 (`}, (t) => [index("practical_photos_protocol").on(t.protocolId, t.stage, t.round)]);`, the end of `practicalPhotos`) add a blank line and:

```ts
// ---------- the certificate (phase 3d) ----------

/**
 * One e-course certificate (phase 3d, spec §3): one per completed access, made when the student confirms her name
 * (server/certificates.ts issueCertificate). It holds a frozen copy of everything the PDF prints, so a later change of the course or of
 * Seaded → Tunnistus never alters it; Maria's "Paranda nimi" changes only `name` and `reissuedAt`, under the same number. The PDF is drawn
 * from this row on every download (server/certificate-pdf.ts); only the signature image is not frozen. Deleted with the access, and so with
 * the account; its number is never given again (the series then has a gap).
 */
export const certificates = pgTable("certificates", {
  id: serial("id").primaryKey(),
  accessId: integer("access_id").notNull().references(() => courseAccess.id, { onDelete: "cascade" }),
  /** "MS LAB 2026-03" (domain/certificate.ts formatCertificateNumber): one series with Maria's paper certificates. */
  number: text("number").notNull(),
  /** The Tallinn year of the issue and the number within it: unique together, the backstop behind the issue's number lock. */
  year: integer("year").notNull(),
  seq: integer("seq").notNull(),
  /** As the student confirmed it (domain/certificate.ts checkCertificateName), or as Maria corrected it. */
  name: text("name").notNull(),
  /** The course's Estonian title at the issue. */
  courseTitle: text("course_title").notNull(),
  /** The competency lines at the issue (domain/certificate.ts certificateSkills). */
  skills: jsonb("skills").$type<string[]>().notNull(),
  /** "10 akadeemilist tundi"; empty: not printed. */
  volume: text("volume").notNull().default(""),
  practicalLine: text("practical_line").notNull(),
  place: text("place").notNull(),
  registryCode: text("registry_code").notNull(),
  /** The issue; its Tallinn date is printed after the place. A re-issue keeps it. */
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  /** Maria's last "Paranda nimi"; null before one. */
  reissuedAt: timestamp("reissued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("certificates_access").on(t.accessId),
  uniqueIndex("certificates_number").on(t.number),
  uniqueIndex("certificates_year_seq").on(t.year, t.seq),
  check("certificates_seq_positive", sql`${t.seq} >= 1`),
]);
```

  4. The settings comment (line 537) becomes two lines:

```ts
// keys: "contact" {email, phone, address, instagram, facebook}, "newsletter" {discountLabel, welcomeCode}, "trainer" {portraitKey, name, role: I18n, stats: [{value,label:I18n}]}, "prepayment" {receiver, iban, bank, referencePrefix},
// "certificate" {place, registryCode, practicalLine, trainerName, nextYear, nextSeq, signatureKey} (phase 3d: domain/certificate.ts readCertificateSettings)
```

  5. After `export type PracticalPhoto = typeof practicalPhotos.$inferSelect;` (line 587) add:

```ts
export type Certificate = typeof certificates.$inferSelect;
```

  `check`, `uniqueIndex`, `jsonb`, `text`, `timestamp`, `serial`, `integer` and `sql` are imported already (lines 1–2).

  **The new `Course` fields.** `Course` gains `certificateSkills` and `certificateVolume`. Checked on a copy of this branch with the schema above (15.10), `npx tsc --noEmit` reports no error:
  - every `db.insert(courses)` in `src/` and `tests/` leaves the two columns to their defaults;
  - no code builds a whole `Course` literal. `tests/unit/domain.test.ts` casts its partial one with `as any`.

- [ ] **Step 11: Generate the migration and review it.**
  1. Run `cd app && npx drizzle-kit generate --name certificates`. It writes:
     - `drizzle/0009_certificates.sql`;
     - `drizzle/meta/0009_snapshot.json`;
     - the journal entry (`"idx": 9`, `"tag": "0009_certificates"`, a `when` greater than 0008's `1791902157382`).
  2. Open the SQL. It must be exactly this (drizzle-kit 0.31's order and formatting; the plan's schema produced it on this branch) and hold **nothing** that drops, renames or rewrites:

```sql
CREATE TABLE "certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"access_id" integer NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"course_title" text NOT NULL,
	"skills" jsonb NOT NULL,
	"volume" text DEFAULT '' NOT NULL,
	"practical_line" text NOT NULL,
	"place" text NOT NULL,
	"registry_code" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"reissued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificates_seq_positive" CHECK ("certificates"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certificate_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certificate_volume" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_access_id_course_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."course_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_access" ON "certificates" USING btree ("access_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_number" ON "certificates" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_year_seq" ON "certificates" USING btree ("year","seq");
```

  3. Check by eye:
     - the check `certificates_seq_positive` is inside the `CREATE TABLE`;
     - the two `ALTER TABLE "courses" ADD COLUMN` have their defaults, so they fill the existing rows (`[]`, `''`);
     - the one foreign key is `ON DELETE cascade`;
     - the three indexes are `CREATE UNIQUE INDEX`.

     There is no data step.

- [ ] **Step 12: Run** `npx vitest run tests/db/migration-0009.test.ts tests/db/migration-0008.test.ts tests/db/migration-0007.test.ts`.
  - **Expected:** migration-0009 and migration-0008 PASS, and **migration-0007 FAILS** with `column "certificate_skills" does not exist`.
  - **Why 0007 fails:** that test stops at 0007, but its `db.select().from(courses)` (line 49) names every column of the schema, 0009's too. migration-0008 selects only `id` and `slug` from `courses`, and its `delete` names no column.

- [ ] **Step 13: Fix `tests/db/migration-0007.test.ts`** so that it names only 0007's column. Line 49 becomes:

```ts
  const [course] = await db.select({ protocolStages: courses.protocolStages }).from(courses); // only 0007's column: drizzle would name 0009's (certificate_skills, certificate_volume)
```

  Run `npx vitest run tests/db/migration-0009.test.ts tests/db/migration-0008.test.ts tests/db/migration-0007.test.ts tests/db/schema.test.ts tests/db/admin-content.test.ts` — expect PASS. A course still saves, round-trips and loads with its relations.

- [ ] **Step 14: Write the failing rule tests** `tests/unit/certificate-rules.test.ts` (Review Focus 2 and 3):

```ts
import { describe, expect, test } from "vitest";
import {
  CERT_DEFAULTS, CERT_LIMITS, certificateFileName, certificateSkills, checkCertificateName, formatCertificateNumber, nextNumber, readCertificateSettings,
  tallinnDateText, tallinnYear,
} from "@/domain/certificate";

// The certificate's pure rules (phase 3d, spec §3–§5, §10 unit): the limits and the defaults, the stored setting read defensively, the name
// rules (Review Focus 2), the number and the file name, the next number at the year's turn in Tallinn (Review Focus 3) and the course's lines.

describe("the limits and the defaults (spec §3)", () => {
  test("as the spec and the plan name them", () => {
    expect(CERT_LIMITS).toEqual({ nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 });
    expect(CERT_DEFAULTS).toEqual({
      place: "Pärnu linn",
      registryCode: "16346048",
      practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
      trainerName: "Maria Sosnina",
    });
  });
});

describe("Review Focus 3: the year turns at Tallinn midnight", () => {
  test("tallinnYear and tallinnDateText: 22:30 UTC on 31.12 is already 1 January in Tallinn (UTC+2); 21:59 is not", () => {
    expect(tallinnYear(new Date("2026-12-31T21:59:59Z"))).toBe(2026);
    expect(tallinnDateText(new Date("2026-12-31T21:59:59Z"))).toBe("31.12.2026");
    expect(tallinnYear(new Date("2026-12-31T22:30:00Z"))).toBe(2027);
    expect(tallinnDateText(new Date("2026-12-31T22:30:00Z"))).toBe("01.01.2027");
    // summer time (UTC+3): 21:30 UTC on 30 June is 1 July in Tallinn
    expect(tallinnDateText(new Date("2026-06-30T21:30:00Z"))).toBe("01.07.2026");
    expect(tallinnDateText(new Date("2026-10-15T09:00:00Z"))).toBe("15.10.2026");
  });

  test("nextNumber: the setting's number in its own year; the next year starts at 1, and Maria's number for the old year does not carry over", () => {
    const setting = { nextYear: 2026, nextSeq: 7 };
    expect(nextNumber(setting, tallinnYear(new Date("2026-12-31T21:30:00Z")))).toEqual({ year: 2026, seq: 7, next: { nextYear: 2026, nextSeq: 8 } });
    expect(nextNumber(setting, tallinnYear(new Date("2026-12-31T22:30:00Z")))).toEqual({ year: 2027, seq: 1, next: { nextYear: 2027, nextSeq: 2 } });
    // the next issue of the new year continues from the setting the first one left
    expect(nextNumber({ nextYear: 2027, nextSeq: 2 }, 2027)).toEqual({ year: 2027, seq: 2, next: { nextYear: 2027, nextSeq: 3 } });
    // a setting of another year, earlier or later, gives 1 (spec §4: seq = nextSeq only when nextYear is the issue's year)
    expect(nextNumber({ nextYear: 2025, nextSeq: 40 }, 2026)).toEqual({ year: 2026, seq: 1, next: { nextYear: 2026, nextSeq: 2 } });
    expect(nextNumber({ nextYear: 2027, nextSeq: 5 }, 2026)).toEqual({ year: 2026, seq: 1, next: { nextYear: 2026, nextSeq: 2 } });
  });
});

describe("the number and the file name (spec §4, §5)", () => {
  test("padded to at least 2 digits", () => {
    expect(formatCertificateNumber(2026, 3)).toBe("MS LAB 2026-03");
    expect(formatCertificateNumber(2026, 12)).toBe("MS LAB 2026-12");
    expect(formatCertificateNumber(2026, 123)).toBe("MS LAB 2026-123");
    expect(certificateFileName(2026, 3)).toBe("MS-LAB-tunnistus-2026-03.pdf");
    expect(certificateFileName(2027, 104)).toBe("MS-LAB-tunnistus-2027-104.pdf");
  });
});

describe("Review Focus 2: the name rules (spec §5)", () => {
  test("Estonian letters, a double surname with a hyphen, apostrophes and dots", () => {
    for (const name of ["Kertu Õunapuu", "Mari-Liis Tamm-Šmidt", "Žanna Äär", "Ülle Öövel", "D'Artagnan O’Neill", "Anna M. Kask", "Jõe", "Li"])
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
  });

  test("Cyrillic and other European letters print, so they are accepted", () => {
    for (const name of ["Мария Соснина", "Ёлкина Анна", "Олеся Ґудзь-Їжакевич", "Ўладзімір Шчэрба", "Zoë Brontë", "Łucja Wąsik", "Ștefan Țepeș", "Ægir Ørsted", "Nguyễn Thị Ánh"])
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
  });

  test("cleaned first: NFC, trimmed, every run of white space one space", () => {
    expect(checkCertificateName("  Kertu \t\n Õunapuu  ")).toEqual({ ok: true, name: "Kertu Õunapuu" });
    expect(checkCertificateName("Kertu Õunapuu")).toEqual({ ok: true, name: "Kertu Õunapuu" }); // a no-break space; õ as o + combining tilde
    expect(checkCertificateName("Kertu Õunapuu")).toEqual({ ok: true, name: "Kertu Õunapuu" });
  });

  test("length: 2–80 characters after the cleaning", () => {
    expect(checkCertificateName("A")).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName("   A   ")).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName("")).toEqual({ ok: false, error: "length" });
    const long = `Anna-Maria ${"Õ".repeat(69)}`; // 80
    expect(Array.from(long)).toHaveLength(80);
    expect(checkCertificateName(long)).toEqual({ ok: true, name: long });
    expect(checkCertificateName(`${long}a`)).toEqual({ ok: false, error: "length" });
    expect(checkCertificateName(`  ${long}  `)).toEqual({ ok: true, name: long }); // measured after trimming
  });

  test("letters: an emoji, digits or another sign are refused, and so is a name with fewer than two letters", () => {
    for (const name of ["Kertu 🌸", "Kertu2", "Kertu Tamm 3", "Kertu_Tamm", "Kertu@Tamm", "Kertu, Tamm", "Kertu (Tamm)", "Kertu/Tamm", "Kertu Tamm!"])
      expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
    for (const name of ["--", "A.", "' '", "A -"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
  });

  test("a Latin or Cyrillic letter the script font cannot draw is refused like a digit (it would print as an empty box)", () => {
    for (const name of ["Қайрат", "Әлия", "Ａnna", "ſara", "ʃana", "Ƿynn", "Ѳеодор"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" });
    for (const name of ["Αθηνά", "王芳", "שרה", "Ann̲a"]) expect(checkCertificateName(name), name).toEqual({ ok: false, error: "letters" }); // Greek, Chinese, Hebrew, a combining mark
  });

  test("every letter the rule accepts is a Latin or Cyrillic letter (\\p{L}, Script=Latin or Cyrillic)", () => {
    const accepted: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (r.ok) accepted.push(...Array.from(r.name));
    }
    expect(accepted.length).toBeGreaterThan(400);
    expect(accepted.filter((c) => !/^\p{L}$/u.test(c) || !/^[\p{Script=Latin}\p{Script=Cyrillic}]$/u.test(c))).toEqual([]);
  });
});

describe("readCertificateSettings: the stored setting read defensively", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const defaults = { ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 1, signatureKey: null };

  test("nothing stored, or not an object: the defaults, this Tallinn year and 1", () => {
    for (const value of [null, undefined, "x", 5, [], true]) expect(readCertificateSettings(value, now)).toEqual(defaults);
    expect(readCertificateSettings(null, new Date("2026-12-31T22:30:00Z"))).toMatchObject({ nextYear: 2027, nextSeq: 1 });
  });

  test("a well-formed setting as it is, its texts trimmed", () => {
    const stored = { place: " Tallinn ", registryCode: "12345678", practicalLine: "Praktiline töö", trainerName: "Maria", nextYear: 2026, nextSeq: 14, signatureKey: "certificate/signature-0b5e.png" };
    expect(readCertificateSettings(stored, now)).toEqual({ ...stored, place: "Tallinn" });
  });

  test("each malformed text is its default: missing, not a string, blank, or over its limit", () => {
    expect(readCertificateSettings({ place: "   ", registryCode: 16346048, trainerName: "x".repeat(61), practicalLine: "y".repeat(201) }, now)).toEqual(defaults);
    expect(readCertificateSettings({ place: "x".repeat(60), trainerName: "x".repeat(60), registryCode: "1".repeat(20), practicalLine: "y".repeat(200) }, now)).toMatchObject({
      place: "x".repeat(60),
      trainerName: "x".repeat(60),
      registryCode: "1".repeat(20),
      practicalLine: "y".repeat(200),
    });
  });

  test("the next number is a pair: a whole year 2000–9999 and a whole number from 1, else both are the default", () => {
    for (const [nextYear, nextSeq] of [[2026, 0], [2026, 1.5], [2026, "3"], [26, 3], [10_000, 3], [2026.5, 3], [null, 3], [2026, null]])
      expect(readCertificateSettings({ nextYear, nextSeq }, now), `${nextYear} ${nextSeq}`).toMatchObject({ nextYear: 2026, nextSeq: 1 });
    expect(readCertificateSettings({ nextYear: 2025, nextSeq: 31 }, now)).toMatchObject({ nextYear: 2025, nextSeq: 31 }); // nextNumber then starts 2026 at 1
  });

  test("the signature key counts only under certificate/", () => {
    for (const signatureKey of ["img/0b5e.png", "practical/a.jpg", "", 5, null]) expect(readCertificateSettings({ signatureKey }, now).signatureKey).toBeNull();
  });
});

describe("certificateSkills: the course's lines (spec §3)", () => {
  const outcomes = [{ et: " Kulmude kuju " }, { et: "" }, { et: "Värvimine\nja hooldus", ru: "Окрашивание" }];

  test("its own lines when it has any: trimmed, on one line, the blank ones left out", () => {
    expect(certificateSkills({ certificateSkills: [" Kulmude analüüs ", "  ", "Kulmude\tvärvimine"], outcomes })).toEqual(["Kulmude analüüs", "Kulmude värvimine"]);
  });

  test("else the outcomes' Estonian texts, the same way", () => {
    expect(certificateSkills({ certificateSkills: [], outcomes })).toEqual(["Kulmude kuju", "Värvimine ja hooldus"]);
    expect(certificateSkills({ certificateSkills: ["   "], outcomes })).toEqual(["Kulmude kuju", "Värvimine ja hooldus"]);
    expect(certificateSkills({ certificateSkills: [], outcomes: [] })).toEqual([]);
  });

  test("at most 16 lines", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Oskus ${i + 1}`);
    expect(certificateSkills({ certificateSkills: many, outcomes })).toEqual(many.slice(0, 16));
    expect(certificateSkills({ certificateSkills: [], outcomes: many.map((et) => ({ et })) })).toEqual(many.slice(0, 16));
  });
});
```

  Run `npx vitest run tests/unit/certificate-rules.test.ts` — expect FAIL: the suite does not load, because `@/domain/certificate` does not exist yet (`Failed to resolve import "@/domain/certificate"` / `Cannot find module`).

- [ ] **Step 15: The rules** — create `src/domain/certificate.ts`:

```ts
// The e-course certificate's pure rules (phase 3d, spec §3–§5): the limits, Seaded → Tunnistus's defaults and their defensive read, the
// name rules, the number and its file name, the next number with the year's turn at Tallinn midnight, and the course's competency lines.
// No database, no React: the server, Maria's screens and the student's "Tunnistus" row share them. It runs in the browser too (the name
// field, Seaded), on iOS Safari before 16.4 as well: no lookbehind here nor in what it imports (tests/unit/old-safari.test.ts).

import { tallinnFormParts } from "./calendar";

/**
 * The name 2–80 characters; at most 16 competency lines of at most 120 characters; the volume, the place, the registry code, the practical
 * line and the trainer's name at most these characters (spec §3, §5).
 */
export const CERT_LIMITS = { nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 } as const;

/** The `settings` key "certificate" as read (readCertificateSettings): what Seaded → Tunnistus sets and the number series' next number. */
export type CertificateSettings = {
  place: string;
  registryCode: string;
  practicalLine: string;
  /** Written in the script font where the signature goes, while there is no signature image. */
  trainerName: string;
  /** The next certificate of `nextYear` gets `nextSeq` (nextNumber); another year starts at 1. */
  nextYear: number;
  nextSeq: number;
  /** The private R2 object `certificate/signature-<uuid>.png` (white ink on transparent), or null. */
  signatureKey: string | null;
};

/** Before Maria saves Seaded → Tunnistus (spec §3). The practical line is a draft for her. */
export const CERT_DEFAULTS = {
  place: "Pärnu linn",
  registryCode: "16346048",
  practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
  trainerName: "Maria Sosnina",
} as const;

/** The Tallinn calendar year of a moment: 31.12 22:30 UTC is already the next year in Tallinn (UTC+2 in winter). */
export function tallinnYear(d: Date): number {
  return Number(tallinnFormParts(d).date.slice(0, 4));
}

/** "dd.mm.yyyy" of the Tallinn date of a moment: the date the PDF prints after the place. */
export function tallinnDateText(d: Date): string {
  const [y, m, day] = tallinnFormParts(d).date.split("-");
  return `${day}.${m}.${y}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The stored setting read defensively (jsonb: anything). Each text is trimmed; a missing, blank or over-long one is the default. The next
 * number is a pair: a whole year 2000–9999 and a whole number from 1, else both are the default (this Tallinn year, 1). The signature key
 * counts only under "certificate/": the PDF never reads any other object of the store.
 */
export function readCertificateSettings(value: unknown, now: Date): CertificateSettings {
  const v = isObject(value) ? value : {};
  const text = (key: keyof typeof CERT_DEFAULTS, max: number): string => {
    const s = typeof v[key] === "string" ? (v[key] as string).trim() : "";
    return s && s.length <= max ? s : CERT_DEFAULTS[key];
  };
  const numbered = wholeIn(v.nextYear, 2000, 9999) && wholeIn(v.nextSeq, 1, Number.MAX_SAFE_INTEGER);
  const key = v.signatureKey;
  return {
    place: text("place", CERT_LIMITS.place),
    registryCode: text("registryCode", CERT_LIMITS.registryCode),
    practicalLine: text("practicalLine", CERT_LIMITS.practicalLine),
    trainerName: text("trainerName", CERT_LIMITS.trainerName),
    nextYear: numbered ? (v.nextYear as number) : tallinnYear(now),
    nextSeq: numbered ? (v.nextSeq as number) : 1,
    signatureKey: typeof key === "string" && key.startsWith("certificate/") ? key : null,
  };
}

/**
 * The letters a name may hold: the Latin and Cyrillic letters (\p{Script=Latin} / \p{Script=Cyrillic}) that the script font, Great Vibes,
 * draws. That is A–Z, the Latin-1 letters, Latin Extended-A but ŉ and ſ, Romanian Ș ș Ț ț, Latin Extended Additional (Vietnamese) but
 * the few it lacks, and Cyrillic А–я with Ѐ–Џ, ѐ–џ and Ґ ґ (Russian, Ukrainian, Belarusian, Serbian, Macedonian, Bulgarian). A Latin or
 * Cyrillic letter outside it (IPA, most of Latin Extended-B, Kazakh Қ, fullwidth Ａ) would print as an empty box, so it is refused like a
 * digit (tests/unit/certificate-pdf.test.ts asks the font for every letter accepted here).
 */
const LETTER = /^[A-Za-zÀ-ÖØ-öø-ňŊ-žȘ-țЀ-џҐґḀ-ẕẞẠ-ỹ]$/;
/** Between the letters: a space, a hyphen, an apostrophe (' or ’) or a dot. */
const JOINERS = " -'’.";

/**
 * The name on the certificate (spec §5): NFC, trimmed, every run of white space one space; 2–80 characters ("length"); then only letters
 * (LETTER) and joiners, with at least two letters ("letters": "Kasuta nimes ainult tähti, tühikuid ja sidekriipse"). A digit, an emoji or a
 * letter the font lacks is refused before anything is stored.
 */
export function checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" } {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  const chars = Array.from(name);
  if (chars.length < CERT_LIMITS.nameMin || chars.length > CERT_LIMITS.nameMax) return { ok: false, error: "length" };
  let letters = 0;
  for (const c of chars) {
    if (LETTER.test(c)) letters++;
    else if (!JOINERS.includes(c)) return { ok: false, error: "letters" };
  }
  return letters >= 2 ? { ok: true, name } : { ok: false, error: "letters" };
}

const seqText = (seq: number): string => String(seq).padStart(2, "0");

/** "MS LAB 2026-03" (spec §4): the number padded to at least 2 digits, so 2026-123 once the year reaches it. */
export function formatCertificateNumber(year: number, seq: number): string {
  return `MS LAB ${year}-${seqText(seq)}`;
}

/** "MS-LAB-tunnistus-2026-03.pdf": the download's file name (Content-Disposition). */
export function certificateFileName(year: number, seq: number): string {
  return `MS-LAB-tunnistus-${year}-${seqText(seq)}.pdf`;
}

/**
 * The number a certificate issued in `year` (its Tallinn year, tallinnYear) takes, and the setting after it (spec §4): the setting's
 * `nextSeq` when its `nextYear` is that year, else 1, so each year starts again at 1; then the setting is that year and the next number.
 */
export function nextNumber(s: { nextYear: number; nextSeq: number }, year: number): { year: number; seq: number; next: { nextYear: number; nextSeq: number } } {
  const seq = s.nextYear === year ? s.nextSeq : 1;
  return { year, seq, next: { nextYear: year, nextSeq: seq + 1 } };
}

/** A line as the PDF draws it: every run of white space (a line break too) one space, trimmed. */
const oneLine = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * The course's certificate lines (spec §3): its own "Oskused tunnistusel" when it has any, else its outcomes' Estonian texts ("Mida
 * õpid"); each on one line and trimmed, the blank ones left out, at most CERT_LIMITS.skills.
 */
export function certificateSkills(course: { certificateSkills: readonly string[]; outcomes: readonly { et: string }[] }): string[] {
  const own = course.certificateSkills.map(oneLine).filter(Boolean);
  const lines = own.length ? own : course.outcomes.map((o) => oneLine(o?.et)).filter(Boolean);
  return lines.slice(0, CERT_LIMITS.skills);
}
```

- [ ] **Step 16: The browser files.** In `tests/unit/old-safari.test.ts`, after line 68 (`  "src/components/admin/verdict-taps.ts",`) add:

```ts
  // the certificate, Task 1: the name rules the student's name field and Seaded share (it pulls domain/calendar.ts, listed above)
  "src/domain/certificate.ts",
```

  Run `npx vitest run tests/unit/certificate-rules.test.ts tests/unit/old-safari.test.ts` — expect PASS:
  - the 19 rule tests pass;
  - the walk finds no lookbehind in `domain/certificate.ts` or what it imports (`domain/calendar.ts`, `domain/catalogue.ts`).

- [ ] **Step 17: Migration 0010 everywhere the texts said 0009** (the drop of `courses.modules`). "Code first, then the migration" stays. The old plans and specs are history and stay as written.
  - **`app/src/db/schema.ts:35`:** done in step 10.1.
  - **`app/drizzle/0003_lessons.sql:55`:** in the data step's comment, `(migration 0009 drops it after the 3a deploy)` → `(migration 0010 drops it after the 3a deploy)`. Change the comment only: drizzle's migrator compares the journal's time stamps, not the file's text.
  - **`app/tests/db/migration-0003.test.ts:14`:** `// migration 0009 drops the column from the schema and the database (Task 12; 0004 adds the lessons' video shape).` → `// migration 0010 drops the column from the schema and the database (Task 12; 0004 adds the lessons' video shape).`
  - **`docs/launch-checklist.md:107`:** ``- [ ] Migration 0009 (drops `courses.modules`) only after 3a has run …`` → ``- [ ] Migration 0010 (drops `courses.modules`) only after 3a has run …``. The rest of the line stays.
  - **`docs/launch-checklist.md:163`:** the line becomes ``- [ ] Migration 0010 (drops `courses.modules`; the e-course completion took 0008 and the certificate 0009) stays as planned in phase 3a: the code first, then the migration (section 8); the migrations count afterwards is 11.``
  - **`docs/deploy.md:112` (§6):** ``(`select count(*) from drizzle.__drizzle_migrations`; 7 after phase 2b's 0006, 8 after the protocols' 0007, 9 after the e-course completion's 0008).`` → ``(`select count(*) from drizzle.__drizzle_migrations`; 7 after phase 2b's 0006, 8 after the protocols' 0007, 9 after the e-course completion's 0008, 10 after the certificate's 0009).`` Task 7 writes §14 and leaves this line alone.
  - **`docs/deploy.md:208` (§12 item 2):** the last sentence ``The drop of `courses.modules` is migration 0009 (0008 is the e-course completion's; code first, then the migration, as planned in phase 3a).`` → ``The drop of `courses.modules` is migration 0010 (0008 is the e-course completion's and 0009 the certificate's; code first, then the migration, as planned in phase 3a).``
  - **`docs/deploy.md:237` (§13 item 2):** ``   - The drop of `courses.modules` is migration 0009 (code first, then the migration, as planned in phase 3a).`` → ``   - The drop of `courses.modules` is migration 0010 (0009 is the certificate's; code first, then the migration, as planned in phase 3a).``
  - **Check** (from the repository root): `grep -rn "0009" app/src app/drizzle/0003_lessons.sql app/tests/db/migration-0003.test.ts docs/launch-checklist.md docs/deploy.md`. It lists only lines that name 0009 as the certificate's (`docs/launch-checklist.md:163`, `docs/deploy.md:112`, `:208` and `:237`); no line still calls the drop 0009. Then `grep -rn "0010" app/src/db/schema.ts app/drizzle/0003_lessons.sql app/tests/db/migration-0003.test.ts docs/launch-checklist.md docs/deploy.md` lists the six drop lines.

- [ ] **Step 18: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .` — no output.
  - **Apply the migration locally only.** Run `docker start mslab-pg` first if it is stopped. A `CONNECT_TIMEOUT` means Docker's engine is down: run `docker desktop restart`, then `docker start mslab-pg`. Then:
    - `DATABASE_URL=postgres://postgres:postgres@localhost:5432/mslab npm run db:migrate` (never Railway's URL);
    - `docker exec mslab-pg psql -U postgres -d mslab -c "select count(*) from drizzle.__drizzle_migrations"` → `10`;
    - `docker exec mslab-pg psql -U postgres -d mslab -c "select count(*) filter (where certificate_skills <> '[]'::jsonb or certificate_volume <> '') as touched, count(*) from courses"` → `0 | <the courses there>`;
    - `docker exec mslab-pg psql -U postgres -d mslab -c "\d certificates"` lists:
      - `"certificates_access" UNIQUE, btree (access_id)`;
      - `"certificates_number" UNIQUE, btree (number)`;
      - `"certificates_year_seq" UNIQUE, btree (year, seq)`;
      - `"certificates_seq_positive" CHECK (seq >= 1)`;
      - `"certificates_access_id_course_access_id_fk" FOREIGN KEY (access_id) REFERENCES course_access(id) ON DELETE CASCADE`.
  - `npx playwright test admin-edit course account-ecourse` (dev): the course editor saves a course, and the course page and the e-course page load with the new columns. Nothing shows them yet.

- [ ] **Step 19: Commit** (from the repository root).

```bash
git add .gitattributes .vercelignore app/package.json app/package-lock.json app/assets/fonts app/next.config.ts app/src/db/schema.ts app/drizzle/0009_certificates.sql app/drizzle/meta/0009_snapshot.json app/drizzle/meta/_journal.json app/drizzle/0003_lessons.sql app/src/domain/certificate.ts app/tests/unit/certificate-fonts.test.ts app/tests/unit/certificate-rules.test.ts app/tests/unit/next-config.test.ts app/tests/unit/vercelignore.test.ts app/tests/unit/old-safari.test.ts app/tests/db/migration-0009.test.ts app/tests/db/migration-0007.test.ts app/tests/db/migration-0003.test.ts docs/launch-checklist.md docs/deploy.md
git commit -m "feat(db): migration 0009 — certificates, the course's certificate lines and volume; the certificate rules; pdf-lib and the fonts, traced and uploaded; the drop of courses.modules becomes 0010

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  `git show --stat HEAD` lists the four font files under `app/assets/fonts/`. Check it, because a `Jost[wght].ttf` left out by a shell glob would pass locally and fail on Vercel.

**Wording (for the appendix):** no dictionary key. The settings' defaults are printed on the certificate until Maria saves Seaded:

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| `CERT_DEFAULTS.place` (`src/domain/certificate.ts`) | Pärnu linn | — (the certificate is Estonian only, D6) | Spec (§3) |
| `CERT_DEFAULTS.registryCode` | 16346048 | — | Spec (§3) |
| `CERT_DEFAULTS.practicalLine` | Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine | — | Spec (§3; a draft for Maria) |
| `CERT_DEFAULTS.trainerName` | Maria Sosnina | — | Spec (§3) |

---

### Task 2: The certificate's PDF — `src/server/certificate-pdf.ts` (`loadCertificateAssets`, `renderCertificate`)

**Scope.**
- **Spec:** §7 (the page, the layout, the fonts, the generation), §9 ("Long course titles") and §10 ("PDF"); decisions D4, D5 and D6.
- **Global Constraints:** "Platform and dependencies" (under 300 KB, tens of milliseconds, the fonts read with `fs` from `path.join(process.cwd(), "assets", "fonts")`) and "Frozen copy" (the PDF prints only what the row holds; the signature image is not frozen).
- **Review Focus 2:** the 80-character and Cyrillic names render, and the text extraction finds them.

**The layout** (842 × 595 pt, y from the bottom; measured and rendered on 15.10):

| Element | Where and how |
|---|---|
| Background | Black over the whole page. |
| "TUNNISTUS" | Jost 54 pt, spaced 0.08 em, centred on 421, baseline 478. |
| Course title | Capitals, spaced 0.35 em, 18 pt at baseline 440. When it is wider than 662 pt: two balanced lines at 14 pt (smaller only if the wider line still does not fit), baselines 448 and 428. |
| Name | Great Vibes 54 pt at baseline 334. A long name shrinks to fit 570 pt, down to 30 pt. Below that, two lines (broken at a space or after a hyphen, the wider line as narrow as can be) at 30 pt or smaller, baselines 330 + 1.15 × size and 330. A name with nowhere to break stays on one line, as small as it must be. |
| Rule | 0.75 pt white line at y 316, x 126.3–715.7 (70 % of the width). |
| Skills | Two columns, x 96 and 434, each 312 pt wide. "•" with the text 1.2 em further. The left column takes the first ⌈n/2⌉. Jost 9.5 pt (8.5 above 12 lines), spaced 0.05 em, leading 1.6. The first baseline is 290; a long line wraps under its bullet. If the rows would go below 172, the size steps down 0.25 pt, to 5 pt at the least. |
| Practical line | Capitals, 8 pt, spaced 0.12 em, x 56, baseline 148. It shrinks to 6.5 pt, then takes two lines. |
| Volume | Capitals, right edge at 786, on the practical line's baseline, 24 pt clear of it. Left out when empty. |
| Logo | Frame x 56, y 80, 150 × 50, 0.8 pt, its lower edge open under "KOOLITUSKESKUS" (5.2 pt, spaced 0.4 em, centred on 131, on the edge). "MS LAB" is Jost 30 pt, spaced 0.12 em, centred in the frame. |
| Bottom left | "REGISTRIKOOD: {code}" and "Tunnistuse nr. {number}", 7.5 pt, x 56, baselines 58 and 46. |
| Bottom right | Centred on 706. The signature PNG is scaled to fit 170 × 56 and stands on y 72; without one, the trainer's name in Great Vibes, 26 pt or smaller to fit 170, at baseline 78. Then "KOOLITAJA" (8 pt, spaced 0.3 em, baseline 58) and "{place} {dd.mm.yyyy}" (8 pt, baseline 46; the Tallinn date of `issuedAt`). |
| Metadata | Title "Tunnistus {number}"; author, creator and producer "MS LAB"; both dates `issuedAt`, so the same row gives the same bytes. pdf-lib's random name suffixes come from a seeded generator. |

**How the test reads the PDF back, and why this way.** pdf-lib embeds each font as a subset and writes glyph ids, not letters (`<0001000200030003…> Tj`), so searching the file for "Kertu" finds nothing. It also writes a ToUnicode map for each font, which a PDF reader uses for copy and search. The test's `readPdf`:
1. loads the file with pdf-lib (`PDFDocument.load`);
2. decodes the page's content stream and each font's ToUnicode stream with pdf-lib's own `decodePDFRawStream`;
3. follows `Tf`, `Tc`, `Tm` and `Tj`;
4. turns each run's glyph ids back into letters, with its font, size, spacing and position.

That is real text extraction, verified in the spike on pdf-lib 1.17.1's output: it reads back "Kertu Õunapuu", the Cyrillic names and every fixed text, and MuPDF's extraction of the same files agrees. Two mutations were caught: the name drawn in Jost, and the date one day off. So the test checks what the file says, not which calls were made. A thin wrapper counting `drawText` calls would pass a PDF whose name came out in the wrong font or as empty boxes.

**Files:**
- Create: `app/src/server/certificate-pdf.ts`
- Test: `app/tests/unit/certificate-pdf.test.ts` (new; Review Focus 2)

**Interfaces:**
- **Consumes, from Task 1:**
  - `type Certificate = typeof certificates.$inferSelect` (`@/db/schema`);
  - `tallinnDateText(d: Date): string` and `checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" }` (`@/domain/certificate`);
  - the four files in `app/assets/fonts/`;
  - `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1`.
- **Consumes, existing:**
  - `FileStore` (`src/server/media.ts`: `get(key): Promise<{ body: ReadableStream | ArrayBuffer; … } | null>`, and it throws when the store cannot be reached);
  - `fakeMediaStore` (`tests/fakes.ts`).
- **Produces** (exactly as listed):
  - `export const CERT_FONT_DIR: string` (`path.join(process.cwd(), "assets", "fonts")`);
  - `export type CertificateAssets = { sans: Uint8Array; script: Uint8Array; signature: Uint8Array | null }`;
  - `export async function loadCertificateAssets(store: FileStore | null, signatureKey: string | null): Promise<CertificateAssets>`:
    - the fonts are read once per process (a failed read is tried again);
    - the signature is null without a store, a key or the object;
    - it **rejects** when the store throws, so a certificate never prints without the signature it has;
  - `export type CertificateContent = Pick<Certificate, "number" | "name" | "courseTitle" | "skills" | "volume" | "practicalLine" | "place" | "registryCode" | "issuedAt"> & { trainerName: string }`;
  - `export async function renderCertificate(c: CertificateContent, assets: CertificateAssets): Promise<Uint8Array>`.
- **Rules Task 3 and Task 5 rely on:**
  - `renderCertificate` takes no database and no store. Task 3's `certificatePdf` passes the row, the settings' `trainerName` and `loadCertificateAssets(store, settings.signatureKey)`;
  - the signature must be a PNG (pdf-lib's `embedPng`; Task 5 stores only PNGs);
  - every text is drawn on one line: runs of white space collapse;
  - the title, the practical line and the volume are printed in Estonian capitals (`toLocaleUpperCase("et")`).

- [ ] **Step 1: Write the failing test** `tests/unit/certificate-pdf.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { checkCertificateName } from "@/domain/certificate";
import { CERT_FONT_DIR, loadCertificateAssets, renderCertificate, type CertificateAssets, type CertificateContent } from "@/server/certificate-pdf";
import { fakeMediaStore } from "../fakes";

// The certificate's PDF (phase 3d, spec §7, §10 "PDF", Review Focus 2): rendered from a fixture and read back the way a PDF reader reads
// it. pdf-lib embeds each font as a subset and writes glyph ids, not letters, into the page (the name is never in the file as text), but
// it also writes each font's ToUnicode map: readPdf below decodes the page's content stream, follows every text-showing operator (Tf, Tc,
// Tm, Tj) and turns its glyph ids back into letters through that map. That is real text extraction (a reader's copy and search use the same
// map), so it checks at once that the right letters were drawn, in which font and size, and where. Positions are PDF points from the
// bottom left of the 842 × 595 page.

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, "Jost[wght].ttf")));
const SCRIPT = new Uint8Array(readFileSync(join(CERT_FONT_DIR, "GreatVibes-Regular.ttf")));
const jost = fontkit.create(SANS);
const greatVibes = fontkit.create(SCRIPT);

/** The CRC-32 of a PNG chunk. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** An RGBA PNG of white ink: `ink(x, y)` is each pixel's alpha (as Seaded's upload makes the signature: white on transparent). */
function pngOf(width: number, height: number, ink: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1)); // each row: filter 0, then RGBA
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([255, 255, 255, ink(x, y)], y * (width * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (png.set(p, at), at + p.length), 0);
  return png;
}

/** A scanned signature's size after Seaded's conversion (at most 1200 px wide): a wavy stroke of ink. */
const SIGNATURE = pngOf(1200, 400, (x, y) => (Math.abs(y - (200 + 120 * Math.sin(x / 90))) < 9 ? 255 : 0));

const FIXTURE: CertificateContent = {
  number: "MS LAB 2026-03",
  name: "Kertu Õunapuu",
  courseTitle: "Kulmude kujundamise e-koolitus",
  skills: ["Kulmude kuju analüüs", "Värvi valik ja segamine", "Kulmude värvimine", "Laminatsioon", "Hügieen ja ohutus", "Kliendi nõustamine"],
  volume: "10 akadeemilist tundi",
  practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
  place: "Pärnu linn",
  registryCode: "16346048",
  issuedAt: new Date("2026-10-15T09:00:00Z"),
  trainerName: "Maria Sosnina",
};
const ASSETS: CertificateAssets = { sans: SANS, script: SCRIPT, signature: SIGNATURE };
const NO_SIGNATURE: CertificateAssets = { ...ASSETS, signature: null };

type Run = { font: string; size: number; spacing: number; x: number; y: number; text: string };

const rawStream = (o: unknown): PDFRawStream => {
  if (!(o instanceof PDFRawStream)) throw new Error("not a stream");
  return o;
};
const streamText = (o: unknown): string => new TextDecoder().decode(decodePDFRawStream(rawStream(o)).decode());

/** A ToUnicode map (pdf-lib writes `<glyph> <UTF-16BE>` pairs between beginbfchar and endbfchar): glyph id → its letters. */
function toUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of cmap.split("beginbfchar").slice(1)) {
    for (const [, glyph, utf16] of section.split("endbfchar")[0].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(glyph.toUpperCase(), String.fromCharCode(...(utf16.match(/.{4}/g) ?? []).map((u) => parseInt(u, 16))));
    }
  }
  return map;
}

/**
 * The PDF read back: its one page, the text runs (each Tj with its font's family, size, letter spacing in em, position and letters), the
 * embedded fonts' names, and each image drawn (its pixel size and the rectangle it is drawn into).
 */
async function readPdf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const page = pages[0];
  const resources = page.node.Resources()!;
  const fonts = new Map<string, { name: string; unicode: Map<string, string> }>();
  for (const [key, ref] of resources.lookup(PDFName.of("Font"), PDFDict).entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    fonts.set(key.decodeText(), { name: font.lookup(PDFName.of("BaseFont"), PDFName).decodeText(), unicode: toUnicode(streamText(font.lookup(PDFName.of("ToUnicode")))) });
  }
  const xobjects = resources.lookup(PDFName.of("XObject"));
  const images = new Map<string, { width: number; height: number }>();
  if (xobjects instanceof PDFDict)
    for (const [key, ref] of xobjects.entries()) {
      const dict = rawStream(doc.context.lookup(ref)).dict;
      if (dict.get(PDFName.of("Subtype"))?.toString() === "/Image")
        images.set(key.decodeText(), { width: Number(dict.get(PDFName.of("Width"))!.toString()), height: Number(dict.get(PDFName.of("Height"))!.toString()) });
    }
  const contents = page.node.Contents();
  const ops = (contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents]).map(streamText).join("\n");

  const runs: Run[] = [];
  const drawn: { width: number; height: number; x: number; y: number; pixels: { width: number; height: number } }[] = [];
  let font = "";
  let size = 0;
  let spacing = 0;
  let at = [0, 0];
  let matrices: number[][] = [];
  let args: string[] = [];
  for (const token of ops.match(/\/[^\s/<>[\]()]+|<[0-9A-Fa-f]*>|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|\[|\]/g) ?? []) {
    if (!/^[A-Za-z*'"]+$/.test(token)) {
      args.push(token);
      continue;
    }
    if (token === "Tf") [font, size] = [args[0].slice(1), Number(args[1])];
    else if (token === "Tc") spacing = Number(args[0]);
    else if (token === "Tm") at = [Number(args[4]), Number(args[5])];
    else if (token === "Tj") {
      const f = fonts.get(font)!;
      const glyphs = args[0].slice(1, -1).match(/.{4}/g) ?? [];
      runs.push({ font: f.name.replace(/-Regular-\d+$/, ""), size, spacing: spacing / size, x: at[0], y: at[1], text: glyphs.map((g) => f.unicode.get(g.toUpperCase()) ?? "�").join("") });
    } else if (token === "q") matrices = [];
    else if (token === "cm") matrices.push(args.map(Number));
    else if (token === "Do" && images.has(args[0].slice(1))) {
      // pdf-lib draws an image as: translate to its corner, then scale the unit square to its size
      const corner = matrices.find((m) => m[0] === 1 && m[3] === 1 && (m[4] !== 0 || m[5] !== 0))!;
      const scale = matrices.find((m) => m[0] !== 1 || m[3] !== 1)!;
      drawn.push({ width: scale[0], height: scale[3], x: corner[4], y: corner[5], pixels: images.get(args[0].slice(1))! });
    }
    args = [];
  }
  const fontNames = [...new Set([...fonts.values()].map((f) => f.name))].sort();
  return { doc, pages, page, runs, fontNames, drawn, ops };
}

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const font = run.font === "GreatVibes" ? greatVibes : jost;
  const glyphs = font.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / font.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}

const runsIn = (runs: Run[], family: string) => runs.filter((r) => r.font === family);
const one = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text === text);
  expect(found.map((r) => r.text), text).toEqual([text]);
  return found[0];
};
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 1);

describe("renderCertificate: the page (spec §7)", () => {
  test("one A4 landscape page, black, both fonts embedded as subsets, under 300 KB with a full-size signature", async () => {
    const bytes = await renderCertificate(FIXTURE, ASSETS);
    expect(bytes.length).toBeLessThan(300 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const { doc, pages, page, fontNames, ops } = await readPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(page.getSize()).toEqual({ width: 842, height: 595 });
    expect(fontNames).toHaveLength(2);
    expect(fontNames[0]).toMatch(/^GreatVibes-Regular-\d+$/);
    expect(fontNames[1]).toMatch(/^Jost-Regular-\d+$/);
    // the whole page is filled black first
    expect(ops.trimStart().startsWith("q\n0 0 0 rg")).toBe(true);
    expect(ops).toContain("0 0 m\n0 595 l\n842 595 l\n842 0 l\nh\nf");
    // each font's file is in the PDF (Type0 font → its CID font → the descriptor → FontFile2), a subset: much smaller than the font
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(2);
    for (const font of fontDicts) {
      const cid = doc.context.lookup(font.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
      const file = cid.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"));
      expect(decodePDFRawStream(rawStream(file)).decode().length).toBeLessThan(SANS.length / 2);
    }
    // neutral metadata, dated by the issue
    expect([doc.getTitle(), doc.getAuthor(), doc.getProducer(), doc.getCreator()]).toEqual(["Tunnistus MS LAB 2026-03", "MS LAB", "MS LAB", "MS LAB"]);
    expect(doc.getCreationDate()).toEqual(FIXTURE.issuedAt);
  });

  test("the same certificate gives the same file on every download", async () => {
    expect(Buffer.from(await renderCertificate(FIXTURE, ASSETS)).equals(Buffer.from(await renderCertificate(FIXTURE, ASSETS)))).toBe(true);
  });

  test("the texts, their fonts, sizes and places: the heading, the title in spaced capitals, the name over the line, the foot", async () => {
    const { runs, ops } = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const heading = one(runs, "TUNNISTUS");
    expect([heading.font, heading.size, heading.y]).toEqual(["Jost", 54, 478]);
    near(heading.x + widthOf(heading) / 2, 421);
    const title = one(runs, "KULMUDE KUJUNDAMISE E-KOOLITUS");
    expect([title.font, title.size, title.y]).toEqual(["Jost", 18, 440]);
    near(title.spacing, 0.35);
    near(title.x + widthOf(title) / 2, 421);
    const name = one(runs, "Kertu Õunapuu");
    expect([name.font, name.size, name.y]).toEqual(["GreatVibes", 54, 334]);
    near(name.x + widthOf(name) / 2, 421);
    // the thin line under the name: 70 % of the width, centred
    expect(ops).toMatch(/126\.3\d* 316 m\n715\.7 316 l\nS/);
    // the practical line at the left and the volume at the right, on one baseline, in capitals
    const practical = one(runs, "PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE");
    expect([practical.font, practical.size, practical.x, practical.y]).toEqual(["Jost", 8, 56, 148]);
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    expect([volume.size, volume.y]).toEqual([8, 148]);
    near(volume.x + widthOf(volume), 786);
    // bottom left: the logo, then the registry code and the number
    const logo = one(runs, "MS LAB");
    near(logo.x + widthOf(logo) / 2, 131);
    const small = one(runs, "KOOLITUSKESKUS");
    near(small.x + widthOf(small) / 2, 131);
    expect(one(runs, "REGISTRIKOOD: 16346048")).toMatchObject({ x: 56, y: 58, size: 7.5 });
    expect(one(runs, "Tunnistuse nr. MS LAB 2026-03")).toMatchObject({ x: 56, y: 46, size: 7.5 });
    // bottom right: "KOOLITAJA" and the place with the Tallinn date of the issue, centred under the signature
    for (const [text, y] of [["KOOLITAJA", 58], ["Pärnu linn 15.10.2026", 46]] as const) {
      const run = one(runs, text);
      expect([run.font, run.size, run.y]).toEqual(["Jost", 8, y]);
      near(run.x + widthOf(run) / 2, 706);
    }
  });

  test("the date is the issue's Tallinn date: 22:30 UTC on 31.12 prints 1 January", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, issuedAt: new Date("2026-12-31T22:30:00Z") }, ASSETS));
    one(runs, "Pärnu linn 01.01.2027");
  });

  test("no volume: nothing at the right of the practical line", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, volume: "" }, ASSETS));
    expect(runs.filter((r) => r.y === 148).map((r) => r.text)).toEqual(["PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE"]);
  });

  test("a long practical line shrinks, then takes two lines, and never runs into the volume", async () => {
    const practicalLine = "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine ning kliendi nõustamine ".repeat(2).slice(0, 200).trim();
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, practicalLine }, ASSETS));
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    const lines = runs.filter((r) => r.x === 56 && r.y <= 148 && r.y > 130);
    expect(lines.map((r) => r.text).join(" ")).toBe(practicalLine.toLocaleUpperCase("et"));
    expect(lines.map((r) => r.y)).toEqual([148, expect.closeTo(148 - lines[0].size * 1.35, 5)]);
    for (const r of lines) {
      expect(r.size).toBeLessThanOrEqual(6.5);
      expect(r.x + widthOf(r)).toBeLessThanOrEqual(volume.x - 24 + 0.01);
    }
  });

  test("the signature image in its box at the bottom right; without one, the trainer's name in the script font there", async () => {
    const signed = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    expect(signed.drawn).toHaveLength(1);
    const [image] = signed.drawn;
    expect(image.pixels).toEqual({ width: 1200, height: 400 });
    // scaled to fit 170 × 56, keeping its proportions, standing on y 72, centred on 706
    near(image.height, 56);
    near(image.width, 168);
    near(image.y, 72);
    near(image.x + image.width / 2, 706);
    expect(runsIn(signed.runs, "GreatVibes").map((r) => r.text)).toEqual(["Kertu Õunapuu"]);

    const unsigned = await readPdf(await renderCertificate(FIXTURE, NO_SIGNATURE));
    expect(unsigned.drawn).toEqual([]);
    const trainer = one(unsigned.runs, "Maria Sosnina");
    expect([trainer.font, trainer.size, trainer.y]).toEqual(["GreatVibes", 26, 78]);
    near(trainer.x + widthOf(trainer) / 2, 706);
  });

  test("a long course title wraps to two lines at 14 pt", async () => {
    const courseTitle = "Kulmude ja ripsmete kujundamise, värvimise ning laminatsiooni põhjalik e-koolitus algajatele";
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, courseTitle }, ASSETS));
    const lines = runs.filter((r) => r.font === "Jost" && r.y > 400 && r.text !== "TUNNISTUS");
    expect(lines.map((r) => [r.size, r.y])).toEqual([[14, 448], [14, 428]]);
    expect(lines.map((r) => r.text).join(" ")).toBe(courseTitle.toLocaleUpperCase("et"));
    for (const line of lines) {
      expect(widthOf(line)).toBeLessThanOrEqual(662 + 0.01);
      near(line.x + widthOf(line) / 2, 421);
    }
  });

  test("the competency lines: two columns of bullets, the left one filled first, 9.5 pt; 8.5 pt above 12 lines; a long line wraps under its bullet", async () => {
    const six = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const rows = (runs: Run[]) => runs.filter((r) => r.font === "Jost" && r.y <= 290 && r.y > 160 && r.text !== "•");
    const bullets = (runs: Run[]) => runs.filter((r) => r.text === "•");
    expect(rows(six.runs).map((r) => [r.text, r.x, r.y, r.size])).toEqual([
      ["Kulmude kuju analüüs", 107.4, 290, 9.5],
      ["Värvi valik ja segamine", 107.4, 274.8, 9.5],
      ["Kulmude värvimine", 107.4, 259.6, 9.5],
      ["Laminatsioon", 445.4, 290, 9.5],
      ["Hügieen ja ohutus", 445.4, 274.8, 9.5],
      ["Kliendi nõustamine", 445.4, 259.6, 9.5],
    ].map(([text, x, y, size]) => [text, expect.closeTo(x as number, 5), expect.closeTo(y as number, 5), size]));
    expect(bullets(six.runs).map((r) => [r.x, r.y])).toEqual([[96, 290], [96, 274.8], [96, 259.6], [434, 290], [434, 274.8], [434, 259.6]].map(([x, y]) => [expect.closeTo(x, 5), expect.closeTo(y, 5)]));

    const thirteen = await readPdf(await renderCertificate({ ...FIXTURE, skills: Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`) }, ASSETS));
    expect(rows(thirteen.runs).map((r) => r.text)).toEqual(Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`));
    expect(new Set(rows(thirteen.runs).map((r) => r.size))).toEqual(new Set([8.5]));
    expect(rows(thirteen.runs).filter((r) => r.x > 400).map((r) => r.text)).toEqual(["Oskus 8", "Oskus 9", "Oskus 10", "Oskus 11", "Oskus 12", "Oskus 13"]);

    const long = "Kulmude kuju analüüs, mõõtmine ja kujundamine vastavalt näo proportsioonidele ning kliendi soovidele ja eelistustele";
    const wrapped = await readPdf(await renderCertificate({ ...FIXTURE, skills: [long, "Värvimine"] }, ASSETS));
    const left = rows(wrapped.runs).filter((r) => r.x < 400);
    expect(left.length).toBeGreaterThan(1);
    expect(left.map((r) => r.text).join(" ")).toBe(long);
    expect(bullets(wrapped.runs)).toHaveLength(2);
    for (const r of left) expect(r.x + widthOf(r)).toBeLessThanOrEqual(96 + 312 + 0.01);
  });

  test("16 lines of 120 characters still stay above the practical line", async () => {
    const skills = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${"Kulmude kuju analüüs ja värvimine ".repeat(4)}`.slice(0, 120));
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, skills }, ASSETS));
    const rows = runs.filter((r) => r.font === "Jost" && r.y <= 290 && r.y > 150 && r.text !== "•");
    expect(Math.min(...rows.map((r) => r.y))).toBeGreaterThanOrEqual(172);
    expect(rows.map((r) => r.text).join(" ")).toBe(skills.map((s) => s.trim()).join(" "));
  });
});

describe("Review Focus 2: a name the fonts or the layout cannot take", () => {
  const nameRuns = async (name: string) => runsIn((await readPdf(await renderCertificate({ ...FIXTURE, name }, ASSETS))).runs, "GreatVibes");
  /** Two lines of a name read back as one: a break after a hyphen keeps it, a break at a space drops it. */
  const joined = (lines: Run[]) => lines.reduce((s, r) => (s === "" ? r.text : s.endsWith("-") ? s + r.text : `${s} ${r.text}`), "");

  test("an 80-character name with a double surname wraps to two lines at 30 pt or smaller, each within the line and centred", async () => {
    const name = "Anna-Maria Kristiina Elisabeth Õunapuu-Šmidt von Liivalaid-Kuusemäe Tammsaar-Ots";
    expect(checkCertificateName(name)).toEqual({ ok: true, name });
    expect(Array.from(name)).toHaveLength(80);
    const lines = await nameRuns(name);
    expect(lines).toHaveLength(2);
    expect(joined(lines)).toBe(name);
    expect(lines[0].size).toBe(lines[1].size);
    expect(lines[0].size).toBeLessThanOrEqual(30);
    expect(lines[0].size).toBeGreaterThan(20);
    expect(lines.map((r) => r.y)).toEqual([expect.closeTo(330 + lines[0].size * 1.15, 5), 330]);
    for (const r of lines) {
      expect(widthOf(r)).toBeLessThanOrEqual(570 + 0.01);
      near(r.x + widthOf(r) / 2, 421);
    }
  });

  test("a long name shrinks to fit the line on one line while it can stay at 30 pt or more", async () => {
    const [line, ...rest] = await nameRuns("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(rest).toEqual([]);
    expect(line.text).toBe("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(line.size).toBeLessThan(54);
    expect(line.size).toBeGreaterThanOrEqual(30);
    near(widthOf(line), 570);
    expect(line.y).toBe(334);
  });

  test("a Cyrillic name prints in the script font, and the text extraction finds it", async () => {
    for (const name of ["Мария Соснина", "Анастасия Владимировна Соколова-Кузнецова", "Олеся Ґудзь-Їжакевич"]) {
      const lines = await nameRuns(name);
      expect(joined(lines), name).toBe(name);
      for (const r of lines) expect(widthOf(r)).toBeLessThanOrEqual(570 + 0.01);
    }
  });

  test("a name with nowhere to break stays on one line, as small as it must be", async () => {
    const name = "Õ".repeat(80);
    const [line, ...rest] = await nameRuns(name);
    expect(rest).toEqual([]);
    expect(line.text).toBe(name);
    expect(line.size).toBeLessThan(30);
    near(widthOf(line), 570);
  });

  test("every letter the name rules accept has a glyph in the script font (none prints as an empty box)", () => {
    const missing: string[] = [];
    let letters = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (!r.ok) continue;
      for (const c of new Set(Array.from(r.name))) {
        letters++;
        if (!greatVibes.hasGlyphForCodePoint(c.codePointAt(0)!)) missing.push(c);
      }
    }
    expect(letters).toBeGreaterThan(400);
    expect(missing).toEqual([]);
    // and the joiners between them
    for (const c of " -'’.") expect(greatVibes.hasGlyphForCodePoint(c.codePointAt(0)!), c).toBe(true);
  });
});

describe("loadCertificateAssets", () => {
  test("the two fonts from app/assets/fonts, read once per process", async () => {
    const a = await loadCertificateAssets(null, null);
    expect(Buffer.from(a.sans).equals(Buffer.from(SANS))).toBe(true);
    expect(Buffer.from(a.script).equals(Buffer.from(SCRIPT))).toBe(true);
    const b = await loadCertificateAssets(null, null);
    expect([b.sans, b.script]).toEqual([a.sans, a.script]);
    expect(b.sans).toBe(a.sans); // the same bytes, not read again
  });

  test("the signature from the store; null without a key, a store or the object", async () => {
    const key = "certificate/signature-0b5e8f2a.png";
    const store = fakeMediaStore({ [key]: { bytes: Array.from(SIGNATURE), contentType: "image/png" } });
    expect(Buffer.from((await loadCertificateAssets(store, key)).signature!).equals(Buffer.from(SIGNATURE))).toBe(true);
    expect((await loadCertificateAssets(store, "certificate/signature-gone.png")).signature).toBeNull();
    expect((await loadCertificateAssets(null, key)).signature).toBeNull();
    store.requested.length = 0;
    expect((await loadCertificateAssets(store, null)).signature).toBeNull();
    expect(store.requested).toEqual([]); // no key: the store is not asked
  });

  test("a store that cannot be reached fails the download (never a certificate without the signature it has)", async () => {
    const store = { ...fakeMediaStore(), get: async () => Promise.reject(new Error("R2 down")) };
    await expect(loadCertificateAssets(store, "certificate/signature-x.png")).rejects.toThrow("R2 down");
  });

  test("an ArrayBuffer body works as well as a stream", async () => {
    const store = { ...fakeMediaStore(), get: async () => ({ body: SIGNATURE.slice().buffer as ArrayBuffer }) };
    expect(Buffer.from((await loadCertificateAssets(store, "certificate/signature-x.png")).signature!).equals(Buffer.from(SIGNATURE))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `cd app && npx vitest run tests/unit/certificate-pdf.test.ts`: the suite does not load, because `@/server/certificate-pdf` does not exist yet (`Failed to resolve import "@/server/certificate-pdf"` / `Cannot find module`).

- [ ] **Step 3: The renderer** — create `src/server/certificate-pdf.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import type { Certificate } from "@/db/schema";
import { tallinnDateText } from "@/domain/certificate";
import type { FileStore } from "./media";

// The e-course certificate as a PDF (phase 3d, spec §7): drawn on every download from the certificate's frozen row, Maria's signature
// image and the two committed fonts, with pdf-lib and its fontkit. A4 landscape, white on black, laid out as Maria's paper certificate:
// "TUNNISTUS", the course title in spaced capitals, the student's name in the script font over a thin line, the competency lines in two
// columns, the practical line and the volume on one baseline, then the logo, the registry code and the number at the bottom left and the
// signature, "KOOLITAJA" and the place and date at the bottom right. Every position below is in PDF points from the bottom left corner.
// Both fonts are embedded as subsets (only the letters drawn): the page is about 20 KB, and Maria's signature adds little (white ink on
// transparent compresses well); tests/unit/certificate-pdf.test.ts holds it under 300 KB.

/**
 * app/assets/fonts, next to package.json (`next dev`, `next start` and the tests run in app/; on Vercel the function's working directory is
 * the project's). `next build`'s file tracing follows this join (LOCAL_MEDIA_DIR opts out of it, this does not), and next.config.ts names
 * the folder for the two functions that render besides.
 */
export const CERT_FONT_DIR = path.join(process.cwd(), "assets", "fonts");

/** Jost (the variable font, drawn at its default weight 400) and Great Vibes, as bytes; the signature PNG, or null. */
export type CertificateAssets = { sans: Uint8Array; script: Uint8Array; signature: Uint8Array | null };

/** What the PDF prints: the certificate's frozen copy, and the trainer's name from Seaded (written where the signature goes without one). */
export type CertificateContent = Pick<Certificate, "number" | "name" | "courseTitle" | "skills" | "volume" | "practicalLine" | "place" | "registryCode" | "issuedAt"> & {
  trainerName: string;
};

/** The fonts' bytes, read once per process; a failed read is tried again on the next download. */
let fontFiles: Promise<{ sans: Uint8Array; script: Uint8Array }> | null = null;

function readFonts(): Promise<{ sans: Uint8Array; script: Uint8Array }> {
  fontFiles ??= Promise.all([readFile(path.join(CERT_FONT_DIR, "Jost[wght].ttf")), readFile(path.join(CERT_FONT_DIR, "GreatVibes-Regular.ttf"))]).then(
    ([sans, script]) => ({ sans: new Uint8Array(sans), script: new Uint8Array(script) }),
    (e: unknown) => {
      fontFiles = null;
      throw e;
    },
  );
  return fontFiles;
}

/**
 * The two fonts from disk and the signature PNG from the store (null without a key, a store or the object). A store that cannot be reached
 * throws: the download then fails and is tried again, rather than printing a certificate without the signature it has.
 */
export async function loadCertificateAssets(store: FileStore | null, signatureKey: string | null): Promise<CertificateAssets> {
  const signature = async (): Promise<Uint8Array | null> => {
    if (!store || !signatureKey) return null;
    const object = await store.get(signatureKey);
    if (!object) return null;
    return new Uint8Array(object.body instanceof ArrayBuffer ? object.body : await new Response(object.body).arrayBuffer());
  };
  const [fonts, image] = await Promise.all([readFonts(), signature()]);
  return { ...fonts, signature: image };
}

// ---------- the layout (842 × 595 pt) ----------

const PAGE = { width: 842, height: 595 } as const;
const CENTRE = PAGE.width / 2;
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);

/** "TUNNISTUS": the sans at 54 pt, slightly spaced, centred; its capitals reach about 80 pt below the top. */
const HEADING = { size: 54, spacing: 0.08, baseline: 478 } as const;
/** The course title: capitals spaced 0.35 em, 18 pt on one line, else two lines at 14 pt (or smaller, so the wider line fits). */
const TITLE = { size: 18, twoLineSize: 14, spacing: 0.35, width: 662, baseline: 440, twoLineBaselines: [448, 428] } as const;
/** The name: the script font at 54 pt, shrunk to fit down to 30 pt, then two lines at 30 pt or smaller; over a thin line 70 % of the width. */
const NAME = { size: 54, shrinkTo: 30, width: 570, baseline: 334, secondBaseline: 330, leading: 1.15 } as const;
const RULE = { y: 316, halfWidth: PAGE.width * 0.35, thickness: 0.75 } as const;
/** The competency lines: two columns of "• line", the left one filled first; 9.5 pt, 8.5 pt above 12 lines, smaller still if they would reach the practical line. */
const SKILLS = { size: 9.5, manySize: 8.5, many: 12, minSize: 5, spacing: 0.05, leading: 1.6, top: 290, bottom: 172, left: 96, width: 650, gap: 26 } as const;
/** The practical line at the left and the volume at the right, capitals, 8 pt on one baseline; a long practical line shrinks to 6.5 pt, then takes two lines. */
const FOOT = { size: 8, shrinkTo: 6.5, spacing: 0.12, baseline: 148, left: 56, right: 786, gap: 24, leading: 1.35 } as const;
/** The MS LAB logo as vector shapes (public/brand/logo.png is dark on transparent): a thin frame, "MS LAB" in it, "KOOLITUSKESKUS" on its lower edge. */
const LOGO = { x: 56, y: 80, width: 150, height: 50, thickness: 0.8, nameSize: 30, nameSpacing: 0.12, smallSize: 5.2, smallSpacing: 0.4, smallPad: 4 } as const;
/** Under the logo: "REGISTRIKOOD: …" and "Tunnistuse nr. …". */
const LEFT_LINES = { x: 56, size: 7.5, spacing: 0.1, baselines: [58, 46] } as const;
/** The bottom right block, centred on one axis: the signature in its box (or the trainer's name in the script font), "KOOLITAJA", the place and date. */
const SIGN = { centre: 706, width: 170, height: 56, bottom: 72, nameSize: 26, nameBaseline: 78, size: 8, labelSpacing: 0.3, spacing: 0.06, baselines: [58, 46] } as const;

/** A piece of text in one font, size and letter spacing (em). */
type Style = { font: PDFFont; size: number; spacing: number };

/** Every run of white space one space, trimmed: pdf-lib would break a line at a line break, and the layout measures single lines. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Estonian capitals ("ü" → "Ü"). */
const upper = (s: string): string => oneLine(s).toLocaleUpperCase("et");

/** The width of `text` at 1 pt: the glyphs' advances plus the spacing between them (none after the last). Widths scale with the size. */
function unitWidth(text: string, font: PDFFont, spacing: number): number {
  return font.widthOfTextAtSize(text, 1) + spacing * Math.max(0, Array.from(text).length - 1);
}

const widthOf = (text: string, s: Style): number => unitWidth(text, s.font, s.spacing) * s.size;

/** Draws `text` with its left end at x; the letter spacing is the PDF's character spacing (Tc), set around this text only. */
function drawAt(page: PDFPage, text: string, s: Style, x: number, y: number): void {
  if (!text) return;
  const tc = s.spacing * s.size;
  if (tc) page.pushOperators(setCharacterSpacing(tc));
  page.drawText(text, { x, y, size: s.size, font: s.font, color: WHITE });
  if (tc) page.pushOperators(setCharacterSpacing(0));
}

const drawCentred = (page: PDFPage, text: string, s: Style, centre: number, y: number) => drawAt(page, text, s, centre - widthOf(text, s) / 2, y);
const drawRight = (page: PDFPage, text: string, s: Style, right: number, y: number) => drawAt(page, text, s, right - widthOf(text, s), y);

/** `text` broken at its spaces into lines that `fits` (a word too wide for any line stands on a line of its own). */
function wrap(text: string, fits: (line: string) => boolean): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && !fits(next)) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The break of `text` into two lines whose wider one is the narrowest: at a space (which goes) or after a hyphen (which stays, so a double
 * surname breaks as "Õunapuu-" / "Šmidt"). null: there is nowhere to break.
 */
function splitInTwo(text: string, unit: (line: string) => number): [string, string] | null {
  let best: [string, string] | null = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (let i = 1; i < text.length; i++) {
    const pair: [string, string] | null = text[i] === " " ? [text.slice(0, i), text.slice(i + 1)] : text[i - 1] === "-" ? [text.slice(0, i), text.slice(i)] : null;
    if (!pair || !pair[0].trim() || !pair[1].trim()) continue;
    const wider = Math.max(unit(pair[0]), unit(pair[1]));
    if (wider < bestWidth) [best, bestWidth] = [pair, wider];
  }
  return best;
}

/**
 * A text that must fit `width`: one line at `size`, or smaller down to `shrinkTo`; else two lines (splitInTwo) at `twoLineSize`, or
 * smaller so that the wider line fits. A text with nowhere to break stays on one line, as small as it must be.
 */
function fitBlock(text: string, unit: (line: string) => number, o: { width: number; size: number; shrinkTo: number; twoLineSize: number }): { size: number; lines: string[] } {
  const oneLineSize = o.width / unit(text);
  if (oneLineSize >= o.shrinkTo) return { size: Math.min(o.size, oneLineSize), lines: [text] };
  const pair = splitInTwo(text, unit);
  if (!pair) return { size: oneLineSize, lines: [text] };
  return { size: Math.min(o.twoLineSize, o.width / Math.max(unit(pair[0]), unit(pair[1]))), lines: pair };
}

/** The competency lines laid out: the size, the gap between baselines, the bullet's indent and each column's rows (a wrapped line's first row carries the bullet). */
function layoutSkills(skills: readonly string[], font: PDFFont): { size: number; leading: number; indent: number; columns: { text: string; bullet: boolean }[][] } {
  const lines = skills.map(oneLine).filter(Boolean);
  const half = Math.ceil(lines.length / 2);
  const columnWidth = (SKILLS.width - SKILLS.gap) / 2;
  for (let size: number = lines.length > SKILLS.many ? SKILLS.manySize : SKILLS.size; ; size -= 0.25) {
    const indent = size * 1.2;
    const style = { font, size, spacing: SKILLS.spacing };
    const columns = [lines.slice(0, half), lines.slice(half)].map((column) =>
      column.flatMap((line) => wrap(line, (row) => widthOf(row, style) <= columnWidth - indent).map((text, i) => ({ text, bullet: i === 0 }))),
    );
    const rows = Math.max(columns[0].length, columns[1].length);
    const leading = size * SKILLS.leading;
    if (SKILLS.top - (rows - 1) * leading >= SKILLS.bottom || size <= SKILLS.minSize) return { size, leading, indent, columns };
  }
}

/** The logo, drawn in white: the frame (its lower edge open under the small word), "MS LAB" centred in it, "KOOLITUSKESKUS" on the edge. */
function drawLogo(page: PDFPage, sans: PDFFont): void {
  const { x, y, width, height, thickness } = LOGO;
  const centre = x + width / 2;
  const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: WHITE });
  const small: Style = { font: sans, size: LOGO.smallSize, spacing: LOGO.smallSpacing };
  const half = widthOf("KOOLITUSKESKUS", small) / 2 + LOGO.smallPad;
  line(x, y + height, x + width, y + height);
  line(x, y, x, y + height);
  line(x + width, y, x + width, y + height);
  line(x, y, centre - half, y);
  line(centre + half, y, x + width, y);
  const name: Style = { font: sans, size: LOGO.nameSize, spacing: LOGO.nameSpacing };
  // Jost's capitals are 0.7 em high (700 of its 1000 units): "MS LAB" sits in the middle of the frame, the small word on its edge
  drawCentred(page, "MS LAB", name, centre, y + (height - LOGO.nameSize * 0.7) / 2);
  drawCentred(page, "KOOLITUSKESKUS", small, centre, y - (LOGO.smallSize * 0.7) / 2);
}

/** A4 landscape (842 × 595), black, laid out as spec §7 (the constants above). */
export async function renderCertificate(c: CertificateContent, assets: CertificateAssets): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // neutral metadata; the dates are the issue's, so the same row gives the same file
  doc.setTitle(`Tunnistus ${c.number}`);
  doc.setAuthor("MS LAB");
  doc.setCreator("MS LAB");
  doc.setProducer("MS LAB");
  doc.setCreationDate(c.issuedAt);
  doc.setModificationDate(c.issuedAt);
  const sans = await doc.embedFont(assets.sans, { subset: true });
  const script = await doc.embedFont(assets.script, { subset: true });
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: BLACK });

  drawCentred(page, "TUNNISTUS", { font: sans, size: HEADING.size, spacing: HEADING.spacing }, CENTRE, HEADING.baseline);

  const title = upper(c.courseTitle);
  const titleFit = fitBlock(title, (s) => unitWidth(s, sans, TITLE.spacing), { width: TITLE.width, size: TITLE.size, shrinkTo: TITLE.size, twoLineSize: TITLE.twoLineSize });
  const titleBaselines = titleFit.lines.length === 1 ? [TITLE.baseline] : TITLE.twoLineBaselines;
  titleFit.lines.forEach((line, i) => drawCentred(page, line, { font: sans, size: titleFit.size, spacing: TITLE.spacing }, CENTRE, titleBaselines[i]));

  const nameFit = fitBlock(oneLine(c.name), (s) => unitWidth(s, script, 0), { width: NAME.width, size: NAME.size, shrinkTo: NAME.shrinkTo, twoLineSize: NAME.shrinkTo });
  const nameStyle: Style = { font: script, size: nameFit.size, spacing: 0 };
  if (nameFit.lines.length === 1) drawCentred(page, nameFit.lines[0], nameStyle, CENTRE, NAME.baseline);
  else {
    drawCentred(page, nameFit.lines[0], nameStyle, CENTRE, NAME.secondBaseline + nameFit.size * NAME.leading);
    drawCentred(page, nameFit.lines[1], nameStyle, CENTRE, NAME.secondBaseline);
  }
  page.drawLine({ start: { x: CENTRE - RULE.halfWidth, y: RULE.y }, end: { x: CENTRE + RULE.halfWidth, y: RULE.y }, thickness: RULE.thickness, color: WHITE });

  const skills = layoutSkills(c.skills, sans);
  const skillStyle: Style = { font: sans, size: skills.size, spacing: SKILLS.spacing };
  skills.columns.forEach((rows, column) => {
    const x = SKILLS.left + column * ((SKILLS.width + SKILLS.gap) / 2);
    rows.forEach((row, i) => {
      const y = SKILLS.top - i * skills.leading;
      if (row.bullet) drawAt(page, "•", skillStyle, x, y);
      drawAt(page, row.text, skillStyle, x + skills.indent, y);
    });
  });

  const footStyle = (size: number): Style => ({ font: sans, size, spacing: FOOT.spacing });
  const volume = upper(c.volume);
  const volumeWidth = volume ? widthOf(volume, footStyle(FOOT.size)) + FOOT.gap : 0;
  const practical = fitBlock(upper(c.practicalLine), (s) => unitWidth(s, sans, FOOT.spacing), {
    width: FOOT.right - FOOT.left - volumeWidth,
    size: FOOT.size,
    shrinkTo: FOOT.shrinkTo,
    twoLineSize: FOOT.shrinkTo,
  });
  practical.lines.forEach((line, i) => drawAt(page, line, footStyle(practical.size), FOOT.left, FOOT.baseline - i * practical.size * FOOT.leading));
  if (volume) drawRight(page, volume, footStyle(FOOT.size), FOOT.right, FOOT.baseline);

  drawLogo(page, sans);
  const left: Style = { font: sans, size: LEFT_LINES.size, spacing: LEFT_LINES.spacing };
  drawAt(page, `REGISTRIKOOD: ${oneLine(c.registryCode)}`, left, LEFT_LINES.x, LEFT_LINES.baselines[0]);
  drawAt(page, `Tunnistuse nr. ${c.number}`, left, LEFT_LINES.x, LEFT_LINES.baselines[1]);

  if (assets.signature) {
    const image = await doc.embedPng(assets.signature);
    const scale = Math.min(SIGN.width / image.width, SIGN.height / image.height);
    const [width, height] = [image.width * scale, image.height * scale];
    page.drawImage(image, { x: SIGN.centre - width / 2, y: SIGN.bottom, width, height });
  } else {
    const trainer = oneLine(c.trainerName);
    const size = Math.min(SIGN.nameSize, SIGN.width / unitWidth(trainer, script, 0));
    drawCentred(page, trainer, { font: script, size, spacing: 0 }, SIGN.centre, SIGN.nameBaseline);
  }
  drawCentred(page, "KOOLITAJA", { font: sans, size: SIGN.size, spacing: SIGN.labelSpacing }, SIGN.centre, SIGN.baselines[0]);
  drawCentred(page, `${oneLine(c.place)} ${tallinnDateText(c.issuedAt)}`, { font: sans, size: SIGN.size, spacing: SIGN.spacing }, SIGN.centre, SIGN.baselines[1]);

  return doc.save();
}
```

  **Notes on the code:**
  - `import fontkit from "@pdf-lib/fontkit"` is the package's documented default import. Under Vitest it loads the UMD build, under `next build` the ES build. Both were checked: `tsc` has no error, and a Turbopack production build served a PDF drawn this way.
  - Letter spacing is the PDF's character spacing (`Tc`), set just before a text and reset just after. `drawText` saves and restores the graphics state inside, so the spacing applies to that text alone.

- [ ] **Step 4: Run** `npx vitest run tests/unit/certificate-pdf.test.ts` — expect PASS (19 tests, a few seconds: about 25 renders, and the coverage walk asks the font about 65 000 code points).

- [ ] **Step 5: Look at it once.** Tests cannot judge the look.
  1. From `app/`, run:

```bash
npx tsx -e "import { loadCertificateAssets, renderCertificate } from './src/server/certificate-pdf'; import { writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; (async () => { const a = await loadCertificateAssets(null, null); const file = join(tmpdir(), 'tunnistus-check.pdf'); writeFileSync(file, await renderCertificate({ number: 'MS LAB 2026-03', name: 'Kertu Õunapuu', courseTitle: 'Kulmude kujundamise e-koolitus', skills: ['Kulmude kuju analüüs', 'Värvi valik ja segamine', 'Kulmude värvimine', 'Laminatsioon', 'Hügieen ja ohutus', 'Kliendi nõustamine'], volume: '10 akadeemilist tundi', practicalLine: 'Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine', place: 'Pärnu linn', registryCode: '16346048', issuedAt: new Date(), trainerName: 'Maria Sosnina' }, a)); console.log(file); })()"
```

  2. Open the printed file (outside the repository) and compare it with the layout table above. Expect:
     - a black page;
     - "TUNNISTUS" with the spaced title under it;
     - the name in script over the thin line;
     - three skills in each column;
     - the practical line left and "10 AKADEEMILIST TUNDI" right on one line;
     - the framed "MS LAB" logo with "KOOLITUSKESKUS" on its lower edge, then the registry code and the number;
     - "Maria Sosnina" in script, "KOOLITAJA" and "Pärnu linn {today}" at the right.
  3. Delete the file afterwards.

- [ ] **Step 6: Run everything.** `npx vitest run` — all green; `npx tsc --noEmit`, then `npx eslint .` — no output. No e2e spec in this task: nothing calls the renderer yet. Task 7 downloads a real one.

- [ ] **Step 7: Commit** (from the repository root).

```bash
git add app/src/server/certificate-pdf.ts app/tests/unit/certificate-pdf.test.ts
git commit -m "feat(certificate): the PDF — A4 landscape, white on black, Jost and Great Vibes as subsets, the logo as vector shapes; a long name shrinks then wraps, a long title wraps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):** no dictionary key. The fixed texts printed on the certificate, in `src/server/certificate-pdf.ts` (Estonian only, D6):

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| PDF heading | TUNNISTUS | — | Spec (§7) |
| PDF bottom left, line 1 | REGISTRIKOOD: {code} | — | Spec (§7) |
| PDF bottom left, line 2 | Tunnistuse nr. {number} | — | Spec (§7) |
| PDF bottom right, under the signature | KOOLITAJA | — | Spec (§7) |
| PDF bottom right, last line | {place} {dd.mm.yyyy} | — | Spec (§7) |
| PDF logo | MS LAB / KOOLITUSKESKUS | — | Spec (§7: as `public/brand/logo.png`) |
| PDF title (document metadata) | Tunnistus {number} | — | Draft |

---

### Task 3: The certificate's server — `src/server/certificates.ts` (issue, re-issue, reads, Seaded's settings, the signature key, the register, `certificatePdf`)

Spec §3 (the frozen copy, the `settings` key `certificate` and its defaults), §4 (numbering, no duplicate numbers, Maria's "Järgmine number"), §6 ("Paranda nimi" re-issues under the same number, the register), §9 (completion is never undone, revoked hides it from her, deletion cascades with a gap in the series, settings changed after issue, course renamed after issue, the Tallinn year), D2, D3, D4. Review Focus 1, 3, 4 and 5. Rulings (this plan's Global Constraints): the number lock order — the access row first (`lockAccess`), then `pg_advisory_xact_lock(hashtext('certificate-number'))`, then the `certificate` setting read and moved on; an expired access CAN issue (she completed it), a revoked one is `notFound`; logs carry ids and numbers only.

**Where the refusals sit between the two locks.** `issueCertificate` checks the name before anything is read. In its transaction it locks the access row, then answers `notFound` (revoked), `notCompleted` or `already` (a certificate exists) **before** it takes the number lock: the access lock alone already serialises every issue of that access, so a double tap never waits for the whole series. Only an issue that will write a certificate takes the number lock, after the access lock, so the order is always access → series and no two writes can wait for each other the other way round. The Task 7 race spec relies on this: two different accesses both get past their own access locks and queue at the number lock.

**Every writer of the setting holds the number lock.** `saveCertificateSettings` and `setSignatureKey` rewrite the whole `certificate` setting. Without the lock, one of them could cross an issue's "next number" move and undo it (or undo the signature). Both therefore take the same transaction lock before they read the setting.

**What is not frozen.** The signature image and the trainer's name are read from Seaded on every download (`certificatePdf`). Everything else printed comes from the certificate's own row.

**Files:**
- Create: `app/src/server/certificates.ts`
- Test: `app/tests/db/certificates.test.ts` (new)

**Interfaces:**
- Consumes (Task 1), from `src/db/schema.ts`: `certificates` (`id, accessId, number, year, seq, name, courseTitle, skills, volume, practicalLine, place, registryCode, issuedAt, reissuedAt, createdAt`; unique `certificates_access`, `certificates_number`, `certificates_year_seq`; check `certificates_seq_positive`), `type Certificate = typeof certificates.$inferSelect`, `courses.certificateSkills: string[]` (default `[]`), `courses.certificateVolume: string` (default `""`).
- Consumes (Task 1), from `src/domain/certificate.ts`:
  - `CERT_LIMITS = { nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 }`;
  - `type CertificateSettings = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: number; nextSeq: number; signatureKey: string | null }`;
  - `CERT_DEFAULTS = { place: "Pärnu linn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine", trainerName: "Maria Sosnina" }`;
  - `tallinnYear(d: Date): number`;
  - `readCertificateSettings(value: unknown, now: Date): CertificateSettings`;
  - `checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" }`;
  - `formatCertificateNumber(year: number, seq: number): string`;
  - `nextNumber(s: { nextYear: number; nextSeq: number }, year: number): { year: number; seq: number; next: { nextYear: number; nextSeq: number } }`;
  - `certificateSkills(course: { certificateSkills: readonly string[]; outcomes: readonly { et: string }[] }): string[]`.
- Consumes (Task 2), from `src/server/certificate-pdf.ts`:
  - `type CertificateAssets = { sans: Uint8Array; script: Uint8Array; signature: Uint8Array | null }`;
  - `loadCertificateAssets(store: FileStore | null, signatureKey: string | null): Promise<CertificateAssets>`;
  - `type CertificateContent = Pick<Certificate, "number" | "name" | "courseTitle" | "skills" | "volume" | "practicalLine" | "place" | "registryCode" | "issuedAt"> & { trainerName: string }`;
  - `renderCertificate(c: CertificateContent, assets: CertificateAssets): Promise<Uint8Array>`.
- Consumes (existing):
  - `accessFor(db, clientId, slug)` and `lockAccess(tx, accessId)` (`src/server/completion.ts`);
  - `readSetting(q: Q, key)` (`src/db/queries/public.ts`);
  - `setSetting(db: Q, key, value)`, `paged`, `type Paged` (`src/db/queries/admin.ts`);
  - `PAGE_SIZE` (`src/domain/paging.ts`);
  - `toStorable` (`src/lib/to-storable.ts`);
  - `type FileStore` (`src/server/media.ts`).
- Produces, from `src/server/certificates.ts` :
  - `type CertificateView = { id: number; number: string; name: string; issuedAt: string; reissuedAt: string | null }`;
  - `type IssueResult = { kind: "issued"; certificate: CertificateView } | { kind: "already"; certificate: CertificateView } | { kind: "notCompleted" } | { kind: "invalid"; error: "length" | "letters" } | { kind: "notFound" }`;
  - `issueCertificate(db: Db, clientId: number, slug: string, rawName: string, now: Date): Promise<IssueResult>`;
  - `reissueCertificate(db: Db, certificateId: number, rawName: string, now: Date): Promise<{ kind: "reissued"; certificate: CertificateView } | { kind: "invalid"; error: "length" | "letters" } | { kind: "notFound" }>`;
  - `certificateForStudent(db: Db, clientId: number, certificateId: number): Promise<Certificate | null>`;
  - `certificateForAdmin(db: Db, certificateId: number): Promise<(Certificate & { revoked: boolean }) | null>`;
  - `certificateOfAccess(db: Db, accessId: number): Promise<CertificateView | null>`;
  - `getCertificateSettings(db: Db, now: Date): Promise<CertificateSettings>`;
  - `saveCertificateSettings(db: Db, raw: unknown, now: Date): Promise<{ ok: true; settings: CertificateSettings } | { ok: false; fields: Record<string, string> }>`;
  - `setSignatureKey(db: Db, key: string | null, now: Date): Promise<string | null>`;
  - `type RegisterRow = { id: number; number: string; name: string; course: string; issuedAt: Date; reissuedAt: Date | null; revoked: boolean; clientId: number }`;
  - `listCertificates(db: Db, page: number): Promise<Paged<RegisterRow>>`;
  - `lastIssued(db: Db, year: number): Promise<string | null>`;
  - `certificatePdf(db: Db, store: FileStore | null, cert: Certificate, now: Date): Promise<Uint8Array>`.
- Produces (**added**, for Task 5's field texts): `type CertificateFieldError = "required" | "tooLong" | "invalid" | "taken"`. These are the values of `saveCertificateSettings`'s `fields`:
  - `place`, `registryCode`, `practicalLine`, `trainerName`: `"required"` (empty after trimming) or `"tooLong"` (over its `CERT_LIMITS`);
  - `nextSeq`: `"invalid"` (the year is not a whole number 2000–2099, or the number is not 1–99 999; the year has no key of its own) or `"taken"` (at or below the highest number issued in `nextYear`).
- The setting's stored shape is exactly `CertificateSettings` (all seven keys), under the `settings` key `"certificate"`. Inputs to `saveCertificateSettings`: `{ place, registryCode, practicalLine, trainerName, nextYear, nextSeq }`. The texts are made storable (`toStorable`), with their white space collapsed to one space and trimmed. The numbers may be numbers or digit strings. The signature key is never changed by this save.

- [ ] **Step 1: Write the failing test** `tests/db/certificates.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { certificates, clients, courseAccess, courses } from "@/db/schema";
import { CERT_DEFAULTS } from "@/domain/certificate";
import { renderCertificate } from "@/server/certificate-pdf";
import {
  certificateForAdmin, certificateForStudent, certificateOfAccess, certificatePdf, getCertificateSettings, issueCertificate, lastIssued, listCertificates,
  reissueCertificate, saveCertificateSettings, setSignatureKey, type IssueResult,
} from "@/server/certificates";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The e-course certificate's server (phase 3d, spec §3, §4, §6, §9) against a real (PGlite) database: the issue (the name rules first, then
// under the access's lock and the number series' lock; one per access; the number from Seaded, moved on; the frozen copy), the re-issue under
// the same number, the student's and Maria's reads, Seaded's settings and the signature key, the register, and the PDF of a row rendered with
// Seaded's signature and trainer name. The renderer is the real one (Task 2), wrapped so a test can see what it was given.

vi.mock("@/server/certificate-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/certificate-pdf")>();
  return { ...real, renderCertificate: vi.fn(real.renderCertificate) };
});

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
/** A valid 1 × 1 PNG (the renderer embeds it). `PNG_B` is another file of the same picture: a PNG reader stops at IEND, the byte after it is not read. */
const PNG_A = [...Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")];
const PNG_B = [...PNG_A, 0];
/** Seaded as these tests store it unless one says otherwise: the defaults, 2026, the next number 3. */
const SETTING = { ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 3, signatureKey: null };
/** A save of Seaded's card that passes. */
const VALID = { place: "Pärnu linn", registryCode: "16346048", practicalLine: CERT_DEFAULTS.practicalLine, trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 1 };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.mocked(renderCertificate).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const stored = () => readSetting(db, "certificate");
const rows = () => db.select().from(certificates).orderBy(certificates.id);

/** The e-course "kulmud-e": two "Mida õpid" lines (the second with spaces around it) and 10 hours; `over` changes it. */
async function ecourse(over: Partial<typeof courses.$inferInsert> = {}) {
  const [c] = await db
    .insert(courses)
    .values({
      slug: "kulmud-e",
      type: "e_learning",
      level: "basic",
      title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" },
      summary: { et: "" },
      body: { et: "" },
      price: 9500,
      published: true,
      outcomes: [{ et: "Kulmude kuju määramine", ru: "Форма бровей" }, { et: " Värvimine " }],
      certificateVolume: "10 akadeemilist tundi",
      ...over,
    })
    .returning();
  return c;
}

/** A student with six months of access to `courseId`, completed yesterday unless `access` says otherwise. */
async function student(email: string, courseId: number, access: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [client] = await db.insert(clients).values({ email, name: "Kati Kask" }).returning();
  const [a] = await db
    .insert(courseAccess)
    .values({ clientId: client.id, courseId, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), completedAt: new Date(NOW.getTime() - DAY), ...access })
    .returning();
  return { client, access: a };
}

/** issueCertificate for "kulmud-e" that must issue: its view. */
async function issued(clientId: number, name: string, now = NOW) {
  const result = await issueCertificate(db, clientId, "kulmud-e", name, now);
  expect(result.kind, name).toBe("issued");
  return (result as Extract<IssueResult, { kind: "issued" }>).certificate;
}

describe("issueCertificate (spec §4, §5)", () => {
  test("a completed access: the name as she confirmed it (NFC, trimmed, one space), the number from Seaded, the frozen copy; Seaded's number moves on; the log names the access and the number only", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    await setSetting(db, "certificate", SETTING);
    // "To" + U+0303 (a combining tilde) is "Tõ" once it is NFC
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "  Mari-Liis   To\u0303nisson ", NOW)).toEqual({
      kind: "issued",
      certificate: { id: expect.any(Number), number: "MS LAB 2026-03", name: "Mari-Liis Tõnisson", issuedAt: NOW.toISOString(), reissuedAt: null },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      accessId: kati.access.id,
      number: "MS LAB 2026-03",
      year: 2026,
      seq: 3,
      name: "Mari-Liis Tõnisson",
      courseTitle: "Kulmude e-kursus",
      skills: ["Kulmude kuju määramine", "Värvimine"],
      volume: "10 akadeemilist tundi",
      practicalLine: CERT_DEFAULTS.practicalLine,
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: NOW,
      reissuedAt: null,
    });
    expect(await stored()).toEqual({ ...SETTING, nextSeq: 4 });
    expect(infoLog()).toContain(`[certificate] access ${kati.access.id}: issued MS LAB 2026-03`);
    expect(infoLog()).not.toMatch(/Mari|Tõnisson|kati@/);
  });

  test("the course's own certificate lines when it has any (else its 'Mida õpid' lines); no volume, none; nothing in Seaded yet: its defaults and this year's number 1", async () => {
    const c = await ecourse({ certificateSkills: [" Kulmude kuju ", "", "Hooldus"], certificateVolume: "" });
    const kati = await student("kati@example.test", c.id);
    expect((await issued(kati.client.id, "Kati Kask")).number).toBe("MS LAB 2026-01");
    expect((await rows())[0]).toMatchObject({ skills: ["Kulmude kuju", "Hooldus"], volume: "", place: "Pärnu linn", registryCode: "16346048", practicalLine: CERT_DEFAULTS.practicalLine });
    expect(await stored()).toEqual({ ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 2, signatureKey: null });
  });

  test("the refusals: a name the rules refuse, a course not completed yet, a revoked access, no access or a contact course — nothing stored; an expired completed access issues (she completed it)", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati 2", NOW)).toEqual({ kind: "invalid", error: "letters" });
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati 😀", NOW)).toEqual({ kind: "invalid", error: "letters" });
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "A".repeat(81), NOW)).toEqual({ kind: "invalid", error: "length" });
    const open = await student("open@example.test", c.id, { completedAt: null });
    expect(await issueCertificate(db, open.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notCompleted" });
    const revoked = await student("revoked@example.test", c.id, { revokedAt: NOW });
    expect(await issueCertificate(db, revoked.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await issueCertificate(db, kati.client.id, "pole-olemas", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    const [none] = await db.insert(clients).values({ email: "none@example.test" }).returning();
    expect(await issueCertificate(db, none.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    const [contact] = await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "Kontakt" }, summary: { et: "" }, body: { et: "" } }).returning();
    await db.insert(courseAccess).values({ clientId: kati.client.id, courseId: contact.id, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + DAY), completedAt: NOW });
    expect(await issueCertificate(db, kati.client.id, "kontakt", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await rows()).toEqual([]);
    expect(await stored()).toBeNull();
    const ended = await student("ended@example.test", c.id, { expiresAt: new Date(NOW.getTime() - DAY) });
    expect((await issued(ended.client.id, "Kati Kask")).number).toBe("MS LAB 2026-01");
  });
});

describe("Review Focus 1: two certificates at the same moment", () => {
  test("Review Focus 1: the same access twice (a double tap, a second device): one certificate; the second answers 'already' with the first one's view, whatever name it sent; the number moves on once", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const first = await issued(kati.client.id, "Kati Kask");
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Katrin Kask", new Date(NOW.getTime() + 60_000))).toEqual({ kind: "already", certificate: first });
    // both at once: the access's lock lets one through, the other finds its certificate
    const mari = await student("mari@example.test", c.id);
    const both = await Promise.all([issueCertificate(db, mari.client.id, "kulmud-e", "Mari Maasikas", NOW), issueCertificate(db, mari.client.id, "kulmud-e", "Mari Maasikas", NOW)]);
    expect(both.map((r) => r.kind).sort()).toEqual(["already", "issued"]);
    expect((await rows()).map((r) => [r.accessId, r.number])).toEqual([
      [kati.access.id, "MS LAB 2026-01"],
      [mari.access.id, "MS LAB 2026-02"],
    ]);
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 3 });
  });

  test("Review Focus 1: three students at the same moment get three numbers in a row, never one twice; Seaded's number after the last", async () => {
    await setSetting(db, "certificate", SETTING);
    const c = await ecourse();
    const people = [await student("a@example.test", c.id), await student("b@example.test", c.id), await student("c@example.test", c.id)];
    const results = await Promise.all(people.map((p) => issueCertificate(db, p.client.id, "kulmud-e", "Kati Kask", NOW)));
    expect(results.map((r) => r.kind)).toEqual(["issued", "issued", "issued"]);
    expect((await rows()).map((r) => r.number).sort()).toEqual(["MS LAB 2026-03", "MS LAB 2026-04", "MS LAB 2026-05"]);
    expect(await stored()).toMatchObject({ nextSeq: 6 });
  });

  test("Review Focus 1: the order of the locks — the access row (FOR UPDATE), then the number series' transaction lock, then Seaded read, the certificate written and the number moved on; an issued one never waits for the series", async () => {
    const log: { query: string; params: unknown[] }[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string, params: unknown[]) => void log.push({ query, params }) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    db = logged; // the helpers write through it
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    log.length = 0;
    expect((await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).kind).toBe("issued");
    const accessLock = log.findIndex((e) => /from "course_access"[\s\S]*for update/.test(e.query));
    const numberLock = log.findIndex((e) => /pg_advisory_xact_lock\(hashtext\(/.test(e.query) && e.params.includes("certificate-number"));
    const settingRead = log.findIndex((e, i) => i > numberLock && /from "settings"/.test(e.query));
    const written = log.findIndex((e) => /^insert into "certificates"/.test(e.query));
    const moved = log.findIndex((e) => /^insert into "settings"/.test(e.query));
    expect(accessLock).toBeGreaterThanOrEqual(0);
    expect([accessLock < numberLock, numberLock < settingRead, settingRead < written, written < moved]).toEqual([true, true, true, true]);
    expect(log.filter((e) => /pg_advisory/.test(e.query))).toHaveLength(1);
    // asked again: the access's lock finds it issued; the number series is never touched
    log.length = 0;
    expect((await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).kind).toBe("already");
    expect(log.some((e) => /from "course_access"[\s\S]*for update/.test(e.query))).toBe(true);
    expect(log.some((e) => /pg_advisory/.test(e.query))).toBe(false);
  });
});

test("Review Focus 3: the year turns at Tallinn midnight: at 23:59 on 31.12 the old year's number, at 22:30 UTC (00:30 on 1.1 in Tallinn) the new year's first; Maria's number for the old year does not carry over", async () => {
  await setSetting(db, "certificate", { ...SETTING, nextSeq: 7 });
  const c = await ecourse();
  const kati = await student("kati@example.test", c.id);
  const mari = await student("mari@example.test", c.id);
  const liis = await student("liis@example.test", c.id);
  const late = new Date("2026-12-31T21:59:00Z"); // 23:59 in Tallinn (UTC+2)
  const turned = new Date("2026-12-31T22:30:00Z"); // 00:30 on 1.1.2027 in Tallinn
  expect((await issued(kati.client.id, "Kati Kask", late)).number).toBe("MS LAB 2026-07");
  expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 8 });
  expect(await issued(mari.client.id, "Mari Maasikas", turned)).toMatchObject({ number: "MS LAB 2027-01", issuedAt: turned.toISOString() });
  expect(await stored()).toMatchObject({ nextYear: 2027, nextSeq: 2 });
  expect((await issued(liis.client.id, "Liis Lill", new Date("2027-01-02T08:00:00Z"))).number).toBe("MS LAB 2027-02");
  expect((await rows()).map((r) => [r.year, r.seq])).toEqual([
    [2026, 7],
    [2027, 1],
    [2027, 2],
  ]);
  expect([await lastIssued(db, 2026), await lastIssued(db, 2027), await lastIssued(db, 2025)]).toEqual(["MS LAB 2026-07", "MS LAB 2027-02", null]);
});

describe("re-issue ('Paranda nimi', spec §6)", () => {
  test("the same number and copy, the new name and reissued_at; the student's name rules; an unknown id; no number taken; logged by its id only", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const { id } = await issued(kati.client.id, "Kati Kask");
    const [before] = await rows();
    const LATER = new Date(NOW.getTime() + 3 * DAY);
    expect(await reissueCertificate(db, id, "  Katrin   Kask ", LATER)).toEqual({
      kind: "reissued",
      certificate: { id, number: "MS LAB 2026-01", name: "Katrin Kask", issuedAt: NOW.toISOString(), reissuedAt: LATER.toISOString() },
    });
    expect((await rows())[0]).toEqual({ ...before, name: "Katrin Kask", reissuedAt: LATER });
    expect(await reissueCertificate(db, id, "Katrin 2", LATER)).toEqual({ kind: "invalid", error: "letters" });
    expect(await reissueCertificate(db, id, "A".repeat(81), LATER)).toEqual({ kind: "invalid", error: "length" });
    expect(await reissueCertificate(db, 999_999, "Katrin Kask", LATER)).toEqual({ kind: "notFound" });
    expect((await rows())[0].name).toBe("Katrin Kask");
    expect(await stored()).toMatchObject({ nextSeq: 2 });
    expect(infoLog()).toContain(`[certificate] ${id}: re-issued`);
    expect(infoLog()).not.toContain("Katrin");
  });
});

describe("who reads a certificate", () => {
  test("certificateOfAccess: the view of the access's certificate; null before it is issued", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    expect(await certificateOfAccess(db, kati.access.id)).toBeNull();
    const view = await issued(kati.client.id, "Kati Kask");
    expect(await certificateOfAccess(db, kati.access.id)).toEqual(view);
  });

  test("Review Focus 5: revoked after issue — her read is null (an ended access's is not), Maria's still has it marked revoked, the register says so, and she cannot issue again", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    const { id } = await issued(kati.client.id, "Kati Kask");
    const [row] = await rows();
    expect(await certificateForStudent(db, kati.client.id, id)).toEqual(row);
    expect(await certificateForStudent(db, mari.client.id, id)).toBeNull(); // never another student's
    expect(await certificateForStudent(db, kati.client.id, 999_999)).toBeNull();
    // her access has ended: the certificate stays hers
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.id, kati.access.id));
    expect(await certificateForStudent(db, kati.client.id, id)).toEqual(row);
    expect(await certificateForAdmin(db, id)).toEqual({ ...row, revoked: false });
    // Maria revokes it (a refund): gone for her, still Maria's, marked
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, kati.access.id));
    expect(await certificateForStudent(db, kati.client.id, id)).toBeNull();
    expect(await certificateForAdmin(db, id)).toEqual({ ...row, revoked: true });
    expect((await listCertificates(db, 1)).rows).toEqual([
      { id, number: "MS LAB 2026-01", name: "Kati Kask", course: "Kulmude e-kursus", issuedAt: NOW, reissuedAt: null, revoked: true, clientId: kati.client.id },
    ]);
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await certificateForAdmin(db, 999_999)).toBeNull();
  });

  test("the account's deletion takes her certificate with it (cascade); its number is never given again: the series has a gap", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    await issued(kati.client.id, "Kati Kask");
    await issued(mari.client.id, "Mari Maasikas");
    await db.delete(clients).where(eq(clients.id, kati.client.id));
    expect((await rows()).map((r) => r.number)).toEqual(["MS LAB 2026-02"]);
    const liis = await student("liis@example.test", c.id);
    expect((await issued(liis.client.id, "Liis Lill")).number).toBe("MS LAB 2026-03");
  });

  test("the register: newest first, 50 a page, each row with its course, the client and whether the access was revoked; a page past the end shows the last; lastIssued", async () => {
    const c = await ecourse();
    const people = await db
      .insert(clients)
      .values(Array.from({ length: 51 }, (_, i) => ({ email: `opilane${i}@example.test`, name: `Õpilane ${i}` })))
      .returning();
    const accesses = await db
      .insert(courseAccess)
      .values(people.map((p) => ({ clientId: p.id, courseId: c.id, grantedBy: "maria@example.test", expiresAt: NOW, completedAt: NOW })))
      .returning();
    await db.insert(certificates).values(
      accesses.map((a, i) => ({
        accessId: a.id,
        number: `MS LAB 2026-${String(i + 1).padStart(2, "0")}`,
        year: 2026,
        seq: i + 1,
        name: `Õpilane ${i}`,
        courseTitle: "Kulmude e-kursus",
        skills: [],
        volume: "",
        practicalLine: "Praktiline töö",
        place: "Pärnu linn",
        registryCode: "16346048",
        issuedAt: new Date(NOW.getTime() + i * 60_000),
      })),
    );
    const first = await listCertificates(db, 1);
    expect([first.page, first.pages, first.total, first.rows.length]).toEqual([1, 2, 51, 50]);
    expect(first.rows[0]).toEqual({
      id: expect.any(Number),
      number: "MS LAB 2026-51",
      name: "Õpilane 50",
      course: "Kulmude e-kursus",
      issuedAt: new Date(NOW.getTime() + 50 * 60_000),
      reissuedAt: null,
      revoked: false,
      clientId: people[50].id,
    });
    expect((await listCertificates(db, 2)).rows.map((r) => r.number)).toEqual(["MS LAB 2026-01"]);
    expect((await listCertificates(db, 9)).page).toBe(2);
    expect(await lastIssued(db, 2026)).toBe("MS LAB 2026-51");
  });
});

describe("Seaded → Tunnistus (spec §3, §4)", () => {
  test("getCertificateSettings: the defaults before anything is stored (this year, number 1, no signature); what was stored after", async () => {
    expect(await getCertificateSettings(db, NOW)).toEqual({ ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 1, signatureKey: null });
    await setSetting(db, "certificate", { ...SETTING, place: "Tallinn" });
    expect(await getCertificateSettings(db, NOW)).toEqual({ ...SETTING, place: "Tallinn" });
  });

  test("saveCertificateSettings: the texts on one line and trimmed, the numbers as numbers (a form's digit strings too); the signature key kept", async () => {
    await setSignatureKey(db, "certificate/signature-a.png", NOW);
    const saved = await saveCertificateSettings(
      db,
      { place: "  Tallinn ", registryCode: " 16346048 ", practicalLine: "Praktiline töö\n fotodel ", trainerName: "Maria  Sosnina", nextYear: "2026", nextSeq: "12" },
      NOW,
    );
    const settings = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 12, signatureKey: "certificate/signature-a.png" };
    expect(saved).toEqual({ ok: true, settings });
    expect(await stored()).toEqual(settings);
  });

  test("its refusals, each by its field: empty or too long, a year or a number that is none; nothing is stored", async () => {
    expect(await saveCertificateSettings(db, { place: " ", registryCode: "1".repeat(21), practicalLine: "x".repeat(201), trainerName: "", nextYear: 2026, nextSeq: 0 }, NOW)).toEqual({
      ok: false,
      fields: { place: "required", registryCode: "tooLong", practicalLine: "tooLong", trainerName: "required", nextSeq: "invalid" },
    });
    const numbers: [unknown, unknown][] = [[1999, 1], [2100, 1], ["20x6", 1], [2026, 1.5], [2026, -1], [2026, "-1"], [2026, 100_000], [2026, null], [null, 1]];
    for (const [nextYear, nextSeq] of numbers)
      expect(await saveCertificateSettings(db, { ...VALID, nextYear, nextSeq }, NOW), `${String(nextYear)} ${String(nextSeq)}`).toEqual({ ok: false, fields: { nextSeq: "invalid" } });
    for (const raw of [null, "x", [], 7]) expect((await saveCertificateSettings(db, raw, NOW)).ok, JSON.stringify(raw)).toBe(false);
    expect(await stored()).toBeNull();
    expect(await saveCertificateSettings(db, VALID, NOW)).toEqual({ ok: true, settings: { ...VALID, signatureKey: null } });
  });

  test("setSignatureKey: the previous key back (the caller removes that object), the other settings kept; only a certificate/ key", async () => {
    await setSetting(db, "certificate", SETTING);
    expect(await setSignatureKey(db, "certificate/signature-a.png", NOW)).toBeNull();
    expect(await setSignatureKey(db, "certificate/signature-b.png", NOW)).toBe("certificate/signature-a.png");
    expect(await stored()).toEqual({ ...SETTING, signatureKey: "certificate/signature-b.png" });
    expect(await setSignatureKey(db, null, NOW)).toBe("certificate/signature-b.png");
    expect(await stored()).toEqual(SETTING);
    await expect(setSignatureKey(db, "img/x.png", NOW)).rejects.toThrow();
    expect(await stored()).toEqual(SETTING);
  });

  test("Review Focus 4: Maria changes Seaded after certificates exist: they keep their place, registry code and practical line (and their course's title and lines); a next number at or below an issued one of that year is refused; a new signature is on every download, old certificates' too", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    const liis = await student("liis@example.test", c.id);
    await issued(kati.client.id, "Kati Kask"); // MS LAB 2026-01
    await issued(mari.client.id, "Mari Maasikas"); // MS LAB 2026-02
    const changed = { place: "Tallinn", registryCode: "12345678", practicalLine: "Uus rida", trainerName: "Maria S.", nextYear: 2026 };
    for (const nextSeq of [1, 2]) expect(await saveCertificateSettings(db, { ...changed, nextSeq }, NOW), String(nextSeq)).toEqual({ ok: false, fields: { nextSeq: "taken" } });
    expect(await stored()).toMatchObject({ place: "Pärnu linn", nextSeq: 3 }); // nothing stored
    expect(await saveCertificateSettings(db, { ...changed, nextYear: 2027, nextSeq: 1 }, NOW)).toMatchObject({ ok: true }); // nothing issued in 2027 yet
    expect(await saveCertificateSettings(db, { ...changed, nextSeq: 3 }, NOW)).toMatchObject({ ok: true });
    await db.update(courses).set({ title: { et: "Kulmud 2.0" }, certificateSkills: ["Uus oskus"], certificateVolume: "12 tundi" }).where(eq(courses.id, c.id));
    await issued(liis.client.id, "Liis Lill"); // MS LAB 2026-03
    const [k, m, l] = await rows();
    for (const old of [k, m])
      expect(old).toMatchObject({
        place: "Pärnu linn",
        registryCode: "16346048",
        practicalLine: CERT_DEFAULTS.practicalLine,
        courseTitle: "Kulmude e-kursus",
        skills: ["Kulmude kuju määramine", "Värvimine"],
        volume: "10 akadeemilist tundi",
      });
    expect(l).toMatchObject({ number: "MS LAB 2026-03", place: "Tallinn", registryCode: "12345678", practicalLine: "Uus rida", courseTitle: "Kulmud 2.0", skills: ["Uus oskus"], volume: "12 tundi" });

    // the signature is not frozen: each download reads Seaded's, an old certificate's too; so is the trainer's name
    const store = fakeMediaStore({ "certificate/signature-a.png": { bytes: PNG_A, contentType: "image/png" }, "certificate/signature-b.png": { bytes: PNG_B, contentType: "image/png" } });
    const render = vi.mocked(renderCertificate);
    await setSignatureKey(db, "certificate/signature-a.png", NOW);
    await certificatePdf(db, store, k, NOW);
    await setSignatureKey(db, "certificate/signature-b.png", NOW);
    const pdf = await certificatePdf(db, store, k, NOW);
    expect(store.requested).toEqual(["certificate/signature-a.png", "certificate/signature-b.png"]);
    expect(render.mock.calls.map(([, assets]) => [...(assets.signature ?? [])])).toEqual([PNG_A, PNG_B]);
    expect(render.mock.calls[1][0]).toEqual({
      number: "MS LAB 2026-01",
      name: "Kati Kask",
      courseTitle: "Kulmude e-kursus",
      skills: ["Kulmude kuju määramine", "Värvimine"],
      volume: "10 akadeemilist tundi",
      practicalLine: CERT_DEFAULTS.practicalLine,
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: NOW,
      trainerName: "Maria S.",
    });
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  test("certificatePdf without a store, or with a key whose object is gone: no signature (the trainer's name is written instead), no failure; a PDF under 300 KB", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    await issued(kati.client.id, "Kati Kask");
    const [k] = await rows();
    const pdf = await certificatePdf(db, null, k, NOW);
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeLessThan(300 * 1024);
    await setSignatureKey(db, "certificate/signature-gone.png", NOW);
    await certificatePdf(db, fakeMediaStore(), k, NOW);
    expect(vi.mocked(renderCertificate).mock.calls.map(([, assets]) => assets.signature)).toEqual([null, null]);
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.**
  - Run: `npx vitest run tests/db/certificates.test.ts` (from `app/`).
  - Expected: FAIL, because `@/server/certificates` does not exist (the import fails before any test runs).

- [ ] **Step 3: Create** `src/server/certificates.ts`:

```ts
import { and, count, desc, eq, getTableColumns, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { paged, setSetting, type Paged } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { certificates, courseAccess, courses, type Certificate } from "@/db/schema";
import {
  CERT_LIMITS, certificateSkills, checkCertificateName, formatCertificateNumber, nextNumber, readCertificateSettings, tallinnYear, type CertificateSettings,
} from "@/domain/certificate";
import { PAGE_SIZE } from "@/domain/paging";
import { toStorable } from "@/lib/to-storable";
import { loadCertificateAssets, renderCertificate } from "./certificate-pdf";
import { accessFor, lockAccess } from "./completion";
import type { FileStore } from "./media";

// The e-course certificate (phase 3d, spec §3–§7), without Next.js: the issue (one per completed access, numbered in Maria's own series), the
// re-issue under the same number ("Paranda nimi"), the student's and Maria's reads, Seaded → Tunnistus (the settings key `certificate`) and
// the register. Every write of the number series — an issue, Seaded's save, the signature — holds the transaction lock `certificate-number`
// (pg_advisory_xact_lock), and an issue locks its access row before it (completion.ts lockAccess, the first lock of every write about one
// access): two issues of one access go one after the other and the second finds the first's certificate; two of different accesses get two
// numbers; the unique (year, seq) is the backstop. A certificate prints its own frozen copy, never the course or Seaded as they are now,
// except the signature image and the trainer's name, which each download reads. Logs carry ids and numbers only, never a name.

/** The settings key of Seaded → Tunnistus: CertificateSettings, all seven keys. */
const SETTING_KEY = "certificate";
/** The number series' transaction lock (hashtext of this): every write that reads and rewrites the setting holds it. */
const NUMBER_LOCK = "certificate-number";
/** "Järgmine number": a year Maria can mean, and a number below six digits. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2099;
const SEQ_MAX = 99_999;

export type CertificateView = { id: number; number: string; name: string; issuedAt: string; reissuedAt: string | null };

export type IssueResult =
  | { kind: "issued"; certificate: CertificateView }
  | { kind: "already"; certificate: CertificateView }
  | { kind: "notCompleted" }
  | { kind: "invalid"; error: "length" | "letters" }
  | { kind: "notFound" };

export type RegisterRow = { id: number; number: string; name: string; course: string; issuedAt: Date; reissuedAt: Date | null; revoked: boolean; clientId: number };

/**
 * Seaded's refusal of one field (saveCertificateSettings): "required" empty, "tooLong" over its CERT_LIMITS, "invalid" no year 2000–2099
 * or no number 1–99 999 (both under `nextSeq`), "taken" a number at or below one already issued in that year.
 */
export type CertificateFieldError = "required" | "tooLong" | "invalid" | "taken";

type SaveResult = { ok: true; settings: CertificateSettings } | { ok: false; fields: Record<string, string> };

/** What the pages get of a certificate row (ISO times). */
const viewOf = (c: Pick<Certificate, "id" | "number" | "name" | "issuedAt" | "reissuedAt">): CertificateView => ({
  id: c.id,
  number: c.number,
  name: c.name,
  issuedAt: c.issuedAt.toISOString(),
  reissuedAt: c.reissuedAt ? c.reissuedAt.toISOString() : null,
});

/** Waits for and takes the number series' lock; it is held to the end of `tx`'s transaction. */
const lockNumbers = (tx: Db) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${NUMBER_LOCK}))`);

/** Seaded's certificate settings as stored, or the defaults (domain/certificate.ts readCertificateSettings); inside a write, after lockNumbers. */
const readSettings = async (q: Db, now: Date): Promise<CertificateSettings> => readCertificateSettings(await readSetting(q, SETTING_KEY), now);

/**
 * "Kinnita ja koosta tunnistus" (spec §4, §5): the certificate of her completed access to the e-course `slug`, with `rawName` as she confirmed
 * it. A name the rules refuse (domain/certificate.ts checkCertificateName) is `invalid` before anything is read. Then ONE transaction:
 * - the access row is locked (lockAccess). A revoked access is `notFound`; an expired one issues, since she completed it. One without
 *   completed_at is `notCompleted`. One that has a certificate is `already`, with that one's view (a double tap, a second device). These
 *   answers need only the access's lock, so they never wait for the number series;
 * - otherwise the course's copy is read, the number series locked, Seaded read and the number taken: nextNumber for the Tallinn year of
 *   `now`, a new year starting at 1;
 * - the frozen copy is written: the course's Estonian title, its certificate lines (certificateSkills: its own, else "Mida õpid") and its
 *   volume, and Seaded's practical line, place and registry code;
 * - Seaded's next number is moved on.
 * `notFound` also without an access, and for a contact course (accessFor). Logs `[certificate] access N: issued <number>` after the commit.
 */
export async function issueCertificate(db: Db, clientId: number, slug: string, rawName: string, now: Date): Promise<IssueResult> {
  const checked = checkCertificateName(rawName);
  if (!checked.ok) return { kind: "invalid", error: checked.error };
  const known = await accessFor(db, clientId, slug);
  if (!known) return { kind: "notFound" };
  const result = await db.transaction(async (t): Promise<IssueResult> => {
    const tx = t as unknown as Db;
    const access = await lockAccess(tx, known.id);
    if (!access || access.revokedAt !== null) return { kind: "notFound" };
    if (access.completedAt === null) return { kind: "notCompleted" };
    const [existing] = await tx.select().from(certificates).where(eq(certificates.accessId, access.id)).limit(1);
    if (existing) return { kind: "already", certificate: viewOf(existing) };
    const [course] = await tx
      .select({ title: courses.title, certificateSkills: courses.certificateSkills, certificateVolume: courses.certificateVolume, outcomes: courses.outcomes })
      .from(courses)
      .where(eq(courses.id, access.courseId))
      .limit(1);
    if (!course) return { kind: "notFound" };
    // the series' lock after the access's, always in this order: no two writes ever wait for each other the other way round
    await lockNumbers(tx);
    const settings = await readSettings(tx, now);
    const { year, seq, next } = nextNumber(settings, tallinnYear(now));
    const [row] = await tx
      .insert(certificates)
      .values({
        accessId: access.id,
        number: formatCertificateNumber(year, seq),
        year,
        seq,
        name: checked.name,
        courseTitle: course.title.et,
        skills: certificateSkills(course),
        volume: course.certificateVolume.trim(),
        practicalLine: settings.practicalLine,
        place: settings.place,
        registryCode: settings.registryCode,
        issuedAt: now,
      })
      .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
    await setSetting(tx, SETTING_KEY, { ...settings, ...next });
    return { kind: "issued", certificate: viewOf(row) };
  });
  if (result.kind === "issued") console.info(`[certificate] access ${known.id}: issued ${result.certificate.number}`);
  return result;
}

/**
 * "Paranda nimi" (spec §6): the certificate `certificateId` under its own number with a new name and reissued_at = now. Nothing else of it
 * changes: the frozen copy stays, and no mail goes. It has the student's name rules; `notFound` for an unknown id. Maria may correct a
 * revoked access's certificate too. Logs `[certificate] N: re-issued` (its id).
 */
export async function reissueCertificate(
  db: Db,
  certificateId: number,
  rawName: string,
  now: Date,
): Promise<{ kind: "reissued"; certificate: CertificateView } | { kind: "invalid"; error: "length" | "letters" } | { kind: "notFound" }> {
  const checked = checkCertificateName(rawName);
  if (!checked.ok) return { kind: "invalid", error: checked.error };
  const [row] = await db.update(certificates).set({ name: checked.name, reissuedAt: now }).where(eq(certificates.id, certificateId)).returning();
  if (!row) return { kind: "notFound" };
  console.info(`[certificate] ${certificateId}: re-issued`);
  return { kind: "reissued", certificate: viewOf(row) };
}

/** Her own certificate (its access is hers) while that access is not revoked; an ended one keeps it (spec §5). null otherwise. */
export async function certificateForStudent(db: Db, clientId: number, certificateId: number): Promise<Certificate | null> {
  const [row] = await db
    .select(getTableColumns(certificates))
    .from(certificates)
    .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
    .where(and(eq(certificates.id, certificateId), eq(courseAccess.clientId, clientId), isNull(courseAccess.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Any certificate, for Maria (spec §6, §9): `revoked` when its access was revoked after the issue ("ligipääs tühistatud"). */
export async function certificateForAdmin(db: Db, certificateId: number): Promise<(Certificate & { revoked: boolean }) | null> {
  const [row] = await db
    .select({ ...getTableColumns(certificates), revoked: sql<boolean>`${courseAccess.revokedAt} is not null` })
    .from(certificates)
    .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
    .where(eq(certificates.id, certificateId))
    .limit(1);
  return row ?? null;
}

/** The view of an access's certificate (the e-course page's "Tunnistus" row, Maria's drawer); null before it is issued. */
export async function certificateOfAccess(db: Db, accessId: number): Promise<CertificateView | null> {
  const [row] = await db
    .select({ id: certificates.id, number: certificates.number, name: certificates.name, issuedAt: certificates.issuedAt, reissuedAt: certificates.reissuedAt })
    .from(certificates)
    .where(eq(certificates.accessId, accessId))
    .limit(1);
  return row ? viewOf(row) : null;
}

/** Seaded → Tunnistus as stored, or its defaults (this year, number 1, no signature). */
export async function getCertificateSettings(db: Db, now: Date): Promise<CertificateSettings> {
  return readSettings(db, now);
}

/** A text of Seaded's card as stored: what Postgres can hold, on one line (each run of white space one space), trimmed. */
const oneLine = (value: unknown): string => (typeof value === "string" ? toStorable(value).replace(/\s+/g, " ").trim() : "");

/** A whole number from the form: a number, or digits as a string; null for anything else. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  return typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * Seaded → Tunnistus "Salvesta" (spec §3, §4), apart from the signature, which has its own route.
 * - The four texts are kept on one line and trimmed; each is required and within its CERT_LIMITS.
 * - "Järgmine number" is a year 2000–2099 and a number 1–99 999.
 * - Under the number series' lock, a number at or below the highest one issued in that year is refused (`nextSeq: "taken"`). Two certificates
 *   must never share a number, and a student's issue between Maria's loading the page and her save moves the series on.
 * Field errors (CertificateFieldError) are keyed place, registryCode, practicalLine, trainerName and nextSeq (a bad year is reported under
 * nextSeq too); nothing is stored when there is one. The signature key is kept as it is.
 */
export async function saveCertificateSettings(db: Db, raw: unknown, now: Date): Promise<SaveResult> {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, CertificateFieldError> = {};
  const text = (key: "place" | "registryCode" | "practicalLine" | "trainerName"): string => {
    const value = oneLine(input[key]);
    if (!value) fields[key] = "required";
    else if (value.length > CERT_LIMITS[key]) fields[key] = "tooLong";
    return value;
  };
  const place = text("place");
  const registryCode = text("registryCode");
  const practicalLine = text("practicalLine");
  const trainerName = text("trainerName");
  const nextYear = wholeNumber(input.nextYear);
  const nextSeq = wholeNumber(input.nextSeq);
  if (nextYear === null || nextYear < YEAR_MIN || nextYear > YEAR_MAX || nextSeq === null || nextSeq < 1 || nextSeq > SEQ_MAX) fields.nextSeq = "invalid";
  // the null checks again, written out: the transaction's closure below sees both as numbers
  if (nextYear === null || nextSeq === null || Object.keys(fields).length > 0) return { ok: false, fields };
  return db.transaction(async (t): Promise<SaveResult> => {
    const tx = t as unknown as Db;
    await lockNumbers(tx);
    const [{ top }] = await tx.select({ top: max(certificates.seq) }).from(certificates).where(eq(certificates.year, nextYear));
    if (top !== null && nextSeq <= top) return { ok: false, fields: { nextSeq: "taken" } };
    const current = await readSettings(tx, now);
    const settings: CertificateSettings = { place, registryCode, practicalLine, trainerName, nextYear, nextSeq, signatureKey: current.signatureKey };
    await setSetting(tx, SETTING_KEY, settings);
    return { ok: true, settings };
  });
}

/**
 * The signature image's key (POST and DELETE /api/admin/allkiri): a `certificate/…` key, or null. It is written under the number series'
 * lock, because the setting is rewritten whole and must not cross an issue's move of the number. Returns the key it replaces: the caller
 * removes that object from the store after the commit. A key outside certificate/ is a programming error: thrown, nothing stored.
 */
export async function setSignatureKey(db: Db, key: string | null, now: Date): Promise<string | null> {
  if (key !== null && !key.startsWith("certificate/")) throw new Error("[certificate] a signature key starts with certificate/");
  return db.transaction(async (t): Promise<string | null> => {
    const tx = t as unknown as Db;
    await lockNumbers(tx);
    const current = await readSettings(tx, now);
    await setSetting(tx, SETTING_KEY, { ...current, signatureKey: key });
    return current.signatureKey;
  });
}

/** The register /admin/tunnistused (spec §6): every certificate, revoked ones too, newest first, 50 a page (a page past the end is the last). */
export async function listCertificates(db: Db, page: number): Promise<Paged<RegisterRow>> {
  return paged(
    page,
    PAGE_SIZE,
    async () => (await db.select({ n: count() }).from(certificates))[0].n,
    (range) =>
      db
        .select({
          id: certificates.id,
          number: certificates.number,
          name: certificates.name,
          course: certificates.courseTitle,
          issuedAt: certificates.issuedAt,
          reissuedAt: certificates.reissuedAt,
          revoked: sql<boolean>`${courseAccess.revokedAt} is not null`,
          clientId: courseAccess.clientId,
        })
        .from(certificates)
        .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
        .orderBy(desc(certificates.issuedAt), desc(certificates.id))
        .limit(range.limit)
        .offset(range.offset),
  );
}

/** The issued number with the highest seq in `year`, for Seaded's "viimane väljastatud"; null without one. */
export async function lastIssued(db: Db, year: number): Promise<string | null> {
  const [row] = await db.select({ number: certificates.number }).from(certificates).where(eq(certificates.year, year)).orderBy(desc(certificates.seq)).limit(1);
  return row?.number ?? null;
}

/**
 * The PDF of a certificate row, rendered on each download (spec §7). It uses the row's frozen copy, and from Seaded as it is now the trainer's
 * name and the signature image, which the store gives (certificate-pdf.ts loadCertificateAssets: none without a store, a key or the object;
 * the trainer's name in the script font is drawn then). Nothing is stored.
 */
export async function certificatePdf(db: Db, store: FileStore | null, cert: Certificate, now: Date): Promise<Uint8Array> {
  const settings = await getCertificateSettings(db, now);
  const assets = await loadCertificateAssets(store, settings.signatureKey);
  return renderCertificate(
    {
      number: cert.number,
      name: cert.name,
      courseTitle: cert.courseTitle,
      skills: cert.skills,
      volume: cert.volume,
      practicalLine: cert.practicalLine,
      place: cert.place,
      registryCode: cert.registryCode,
      issuedAt: cert.issuedAt,
      trainerName: settings.trainerName,
    },
    assets,
  );
}
```

- [ ] **Step 4: Run it and expect PASS.**
  - Run: `npx vitest run tests/db/certificates.test.ts`.
  - Expected: PASS (18 tests).
  - If "the order of the locks" fails on a regex, print `log.map((e) => e.query)` once and fix the pattern to drizzle's real SQL text, never the order.

- [ ] **Step 5: Run everything.**
  - `npx vitest run`: all green.
  - `npx tsc --noEmit`, then `npx eslint .`: clean.

- [ ] **Step 6: Commit** (from the repository root):

```bash
git add app/src/server/certificates.ts app/tests/db/certificates.test.ts
git commit -m "feat(certificate): issue under the access's lock and the number series' lock, re-issue, the reads, Seaded's settings and the register

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):** none. This task has no texts. Seaded's field error texts are Task 5's (the codes are `CertificateFieldError`).

---

### Task 4: The student's side — the two account routes, the "Tunnistus" row, the card link, `account.certificate`, the completed mail's line

Spec §5 (the student's side: the row before and after the issue, the name rules' words, access and expiry, the API, the mail's added line), §2 D3 and D6 (Estonian certificate, the pages in her language), §9 ("completion is never undone": revoked hides it), §7 ("private, no-store"). Review Focus 5 (revoked after issue: her download answers 404, the dashboard link disappears). Global Constraints applied:
- the new routes start with `requireClient` and answer through `clientResponse`, or through `pdfAnswer` above the guard test's START marker for the binary answer (no handler builds a `Response`);
- they are matched before `LESSON_PATH`, and are gated (`/api/konto*`);
- the PDF answer's headers are fixed;
- the page keeps one primary button;
- the texts are in ET and RU, with the Russian no-break space rule.

**The row.** It is a `<li data-certificate>` after "Lõpetatud" in the "Lõpetamine" list, shown once `completedAt` is set (`CertificateRow`, inside `CompletionSteps.tsx`).
- **Before the issue:**
  - the line "Kontrolli, kuidas su nimi tunnistusel kirjas on";
  - the field "Nimi tunnistusel", filled with her account's name (`certificateName`);
  - the button "Kinnita ja koosta tunnistus".
  - The button first checks the name with `checkCertificateName`, the server's own rule. A refused name is the field's error, and nothing is sent. Then it POSTs once: a second press waits for the first.
  - The certificate in the answer (a 200, or a 409 "already" from another device) turns the row into its issued form.
- **After the issue:**
  - "Tunnistus nr. {number}" (it takes the focus when it was just made);
  - "Laadi tunnistus alla (PDF)": a plain `<a href download>`, since the API names the file;
  - "Kui nimes on viga, kirjuta meile", to the contact page.
- **One primary button.** When the row shows, every step is done (`courseSteps` with `completedAt` set), so no step link is primary and the row's button is the page's one primary. One exception: Maria added a lesson after the completion and the page shows "Jätka". The row's button is then an outline one (`resumeShown`).
- **Read-only** (the admin's view as client): the same row, with the field disabled and inert spans.

**The data.**
- `loadEcourse` reads the certificate (`certificateOfAccess`) and her account's name only for a completed access, since only then does the row show. Before completion it gives `certificate: null` and `certificateName: ""`.
- `loadDashboard` left-joins the access's certificate. `certificateId` is its id while the access is not revoked, and null otherwise. The card shows "Laadi tunnistus alla" (a quiet text link, `[data-card-certificate]`) on an ended access's card that has one.

**The mail.** Only `completionMail`'s "completed" kind gets one more line, in text and HTML: "Kinnita oma nimi ja laadi tunnistus alla:" with the e-course's page (`ecourseUrl`), where the row is. It is a link, never an attachment, and it adds no second button.

**The download limit.** The spec rate-limits both routes at 10 an hour per client. The issue counts in `client-certificate` , and the download in its own `client-certificate-pdf`, because each download renders the PDF. A 404 for another student's id counts as well, so ids cannot be probed.

**Files:**
- Modify: `app/src/server/account-api.ts`:
  - the header comment, line 62;
  - imports, after lines 5 and 18;
  - constants, after line 123;
  - `pdfAnswer`, after `photoAnswer` (line 457);
  - two handlers, before `favouriteCourses`'s doc comment (line 803);
  - `CERT_PATH` / `CERT_FILE_PATH`, after line 1063;
  - the router, after line 1106.
- Modify: `app/src/server/client-data.ts`:
  - the schema import, line 7;
  - imports, before line 22;
  - `EcourseView.completion`, lines 77–81;
  - `loadDashboard`'s access query, lines 153–157, and its card, lines 239–246;
  - `loadEcourse`, lines 330–364.
- Modify: `app/src/domain/account-cards.ts` (`EcourseCard`, after `completedAt`, line 101).
- Modify: `app/src/components/account/CompletionSteps.tsx` (whole file) and `CompletionSteps.module.css` (the header comment; the new rules before the `@media` block).
- Modify: `app/src/components/account/EcourseView.tsx` (doc comment lines 38–39; the `CompletionSteps` call, lines 167–169).
- Modify: `app/src/components/account/AccountCourseCard.tsx` (doc comment line 74; after the protocol block, line 218).
- Modify: `app/src/components/account/texts.ts` (`CoursesTexts`, `EcourseTexts`, `ecourseTexts`, `coursesTexts`).
- Modify: `app/src/server/account-mail.ts` (`completionMail` with its doc comment, lines 624–666).
- Modify: `app/src/i18n/dict/et.ts`, `app/src/i18n/dict/ru.ts` (`account.completionMail.completedCertificate`; the `account.certificate` block before `favourites`).
- Modify (tests, existing):
  - `app/tests/unit/account-guards.test.ts`;
  - `app/tests/unit/site-gate.test.ts` (GATED);
  - `app/tests/unit/completion-mail.test.ts`;
  - `app/tests/unit/protocols.test.ts` (Russian typography);
  - `app/tests/unit/completion-steps-dom.test.ts` (line 47);
  - `app/tests/unit/account-ecourse.test.ts` (line 50);
  - `app/tests/db/client-data.test.ts` (lines 245, 455);
  - `app/tests/db/account-api.test.ts` (line 815);
  - `app/tests/db/admin-clients.test.ts` (line 341).
- Test (new): `app/tests/db/certificate-api.test.ts`, `app/tests/unit/certificate-row-dom.test.ts`.
- No new `.module.css` file and no new browser entry point. `tests/unit/old-safari.test.ts` walks every "use client" file's imports, so `CompletionSteps.tsx`'s new import of `@/domain/certificate` (listed by Task 1) is covered.

**Interfaces:**
- Consumes (Task 1), from `src/domain/certificate.ts`: `checkCertificateName(raw: string): { ok: true; name: string } | { ok: false; error: "length" | "letters" }` (browser-safe); `certificateFileName(year: number, seq: number): string` ("MS-LAB-tunnistus-2026-03.pdf"). From `src/db/schema.ts`: `certificates`, `type Certificate`.
- Consumes (Task 3), from `src/server/certificates.ts`:
  - `type CertificateView = { id: number; number: string; name: string; issuedAt: string; reissuedAt: string | null }`;
  - `issueCertificate(db: Db, clientId: number, slug: string, rawName: string, now: Date): Promise<IssueResult>`;
  - `certificateForStudent(db: Db, clientId: number, certificateId: number): Promise<Certificate | null>`;
  - `certificateOfAccess(db: Db, accessId: number): Promise<CertificateView | null>`;
  - `certificatePdf(db: Db, store: FileStore | null, cert: Certificate, now: Date): Promise<Uint8Array>`.
- Produces:
  - routes `POST /api/konto/kursus/<slug>/tunnistus` (handler `issueCertificateRoute`) and `GET /api/konto/tunnistus/<id>` (handler `certificateFile`, answered by `pdfAnswer(session, bytes, fileName)` above the START marker);
  - `const CERT_PATH = /^\/kursus\/([^/]+)\/tunnistus$/`, `const CERT_FILE_PATH = /^\/tunnistus\/([^/]+)$/`;
  - the answers 200 `{ ok:true, certificate }`, 409 `{ ok:false, error:"already", certificate }`, 409 `{ ok:false, error:"notCompleted" }`, 400 `{ ok:false, error:"name", reason }`, 404 `{ ok:false }`, 429 `{ ok:false, error:"rate" }`;
  - `EcourseView.completion: CourseSteps & { protocolSent: boolean; certificate: CertificateView | null; certificateName: string }`;
  - `EcourseCard.certificateId?: number | null` (present, null or the id, on every card `loadDashboard` makes);
  - `CompletionSteps` gains the props `certificate: CertificateView | null`, `certificateName: string`, `resumeShown?: boolean`;
  - data attributes `[data-certificate]` (with `data-step-state` "open" / "done" for the mark), `[data-certificate-name]`, `[data-certificate-issue]`, `[data-certificate-number]`, `[data-certificate-download]`, `[data-certificate-error]`, `[data-card-certificate]`; **added**: `[data-certificate-contact]` ("Kui nimes on viga, kirjuta meile");
  - texts: `account.certificate` (et, ru); `account.completionMail.completedCertificate`; `EcourseTexts.certificate: Dict["account"]["certificate"] & { rate: string; failed: string }`; `CoursesTexts.certificate: string` (the card's link).

- [ ] **Step 1: Write the failing database test** `tests/db/certificate-api.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, clients, clientSessions, courseAccess, courseModules, courses, lessonProgress, lessons } from "@/db/schema";
import { handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { issueCertificate } from "@/server/certificates";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard, loadEcourse } from "@/server/client-data";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The certificate's two endpoints of the account API (phase 3d, spec §5) against a real (PGlite) database:
// - POST /kursus/<slug>/tunnistus makes it once, with the name she confirmed (200, then 409 "already" with the same one), with its refusals
//   and its limit;
// - GET /tunnistus/<id> answers with the PDF as a download named by its number: hers only, also after her access has ended, never once it
//   is revoked (Review Focus 5);
// - the e-course page's data and the dashboard card carry it.
// The issue's own rules are server/certificates.ts's (tests/db/certificates.test.ts).

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const ISSUE = "/kursus/veebikursus/tunnistus";

let db: Db;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The account API's dependencies: a store with no signature in it, `later` dropping its tasks (nothing is mailed here). */
const deps = (over: Partial<AccountDeps> = {}): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
  files: fakeMediaStore(),
  ...over,
});

/** A client named `name` with one live session. `renewing`: the session was last renewed two days ago, so the next request renews it. */
async function student(email: string, name: string, renewing = false) {
  const [client] = await db.insert(clients).values({ email, name }).returning();
  const raw = newToken();
  const expiresAt = new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS - (renewing ? 2 * DAY : 0));
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt });
  return { id: client.id, raw, cookie: `__Host-mslab_client=${raw}` };
}

/**
 * The e-course "veebikursus" (one text lesson, two "Mida õpid" lines). Kati Kask has six months of access, which she completed yesterday
 * (`over` changes it), and the lesson done. `grant` gives another student the same.
 */
async function world(over: Partial<typeof courseAccess.$inferInsert> = {}, renewing = false) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500, outcomes: [{ et: "Kulmude kuju" }, { et: "Värvimine" }] })
    .returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Teooria" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Tekst" }, kind: "text" }).returning();
  const grant = async (clientId: number, access: Partial<typeof courseAccess.$inferInsert> = {}) => {
    const [a] = await db
      .insert(courseAccess)
      .values({ clientId, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), completedAt: new Date(NOW.getTime() - DAY), ...access })
      .returning();
    await db.insert(lessonProgress).values({ clientId, lessonId: lesson.id, doneAt: NOW });
    return a;
  };
  const kati = await student("kati@example.test", "Kati Kask", renewing);
  const access = await grant(kati.id, over);
  return { course, kati, access, grant };
}

const call = async (cookie: string | null, method: string, path: string, body?: unknown, d: AccountDeps = deps()) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, {
      method,
      headers: cookie ? { cookie } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    d,
  ))!;
/** Her certificate made through the API: its id. */
const issue = async (cookie: string) => ((await (await call(cookie, "POST", ISSUE, { name: "Kati Kask" })).json()) as { certificate: { id: number } }).certificate.id;

describe("POST /kursus/:slug/tunnistus", () => {
  test("her name confirmed: 200 with the certificate (private, never cached); asked again, 409 'already' with the same one", async () => {
    const w = await world();
    const res = await call(w.kati.cookie, "POST", ISSUE, { name: "  Kati   Kask " });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { ok: boolean; certificate: unknown };
    expect(body).toEqual({ ok: true, certificate: { id: expect.any(Number), number: "MS LAB 2026-01", name: "Kati Kask", issuedAt: NOW.toISOString(), reissuedAt: null } });
    const again = await call(w.kati.cookie, "POST", ISSUE, { name: "Katrin Kask" });
    expect([again.status, await again.json()]).toEqual([409, { ok: false, error: "already", certificate: body.certificate }]);
    expect(await db.select().from(certificates)).toHaveLength(1);
  });

  test("the refusals: the name rules (400 with the reason, nothing stored), not completed (409), revoked or not hers (404); the path is never read as a lesson; no session (401)", async () => {
    const w = await world();
    for (const [name, reason] of [["Kati 2", "letters"], ["A".repeat(81), "length"], ["", "length"]] as const) {
      const res = await call(w.kati.cookie, "POST", ISSUE, { name });
      expect([res.status, await res.json()], name).toEqual([400, { ok: false, error: "name", reason }]);
    }
    // a body that is no { name } (not JSON, no string, longer than 1024 characters) is an empty name
    for (const body of ["x", { name: 7 }, {}, { name: "A".repeat(1100) }]) {
      const res = await call(w.kati.cookie, "POST", ISSUE, body);
      expect([res.status, await res.json()], JSON.stringify(body).slice(0, 40)).toEqual([400, { ok: false, error: "name", reason: "length" }]);
    }
    expect(await db.select().from(certificates)).toEqual([]);
    const mari = await student("mari@example.test", "Mari Maasikas");
    await w.grant(mari.id, { completedAt: null });
    const open = await call(mari.cookie, "POST", ISSUE, { name: "Mari Maasikas" });
    expect([open.status, await open.json()]).toEqual([409, { ok: false, error: "notCompleted" }]);
    const liis = await student("liis@example.test", "Liis Lill");
    await w.grant(liis.id, { revokedAt: NOW });
    expect((await call(liis.cookie, "POST", ISSUE, { name: "Liis Lill" })).status).toBe(404);
    const none = await student("none@example.test", "Keegi Teine");
    expect((await call(none.cookie, "POST", ISSUE, { name: "Keegi Teine" })).status).toBe(404);
    expect((await call(w.kati.cookie, "POST", "/kursus/pole-olemas/tunnistus", { name: "Kati Kask" })).status).toBe(404);
    // the certificate's path is its own: another method never reaches the lesson paths
    for (const method of ["GET", "DELETE"]) {
      const res = await call(w.kati.cookie, method, ISSUE);
      expect([res.status, await res.json()], method).toEqual([404, { ok: false }]);
    }
    expect((await call(null, "POST", ISSUE, { name: "Kati Kask" })).status).toBe(401);
    expect(await db.select().from(certificates)).toEqual([]);
  });

  test("10 an hour per student; the 11th is 429 before anything is made", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await call(w.kati.cookie, "POST", ISSUE, { name: "Kati 2" })).status, `try ${i + 1}`).toBe(400);
    const res = await call(w.kati.cookie, "POST", ISSUE, { name: "Kati Kask" });
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
    expect(await db.select().from(certificates)).toEqual([]);
  });
});

describe("GET /tunnistus/:id", () => {
  test("her certificate as a PDF download: the type, the file name by its number, private and never cached, nosniff; the bytes are a PDF; a renewed session's cookies go with it", async () => {
    const w = await world({}, true);
    const made = await issueCertificate(db, w.kati.id, "veebikursus", "Kati Kask", NOW);
    const id = (made as { certificate: { id: number } }).certificate.id;
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-tunnistus-2026-01.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.getSetCookie()).toEqual(sessionCookies(w.kati.raw));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  });

  test("after her access has ended the certificate is still hers; 10 downloads an hour, the 11th is 429", async () => {
    const w = await world({ expiresAt: new Date(NOW.getTime() - DAY) });
    const made = await issueCertificate(db, w.kati.id, "veebikursus", "Kati Kask", NOW); // an ended access issues too: she completed it
    const id = (made as { certificate: { id: number } }).certificate.id;
    for (let i = 0; i < 10; i++) expect((await call(w.kati.cookie, "GET", `/tunnistus/${id}`)).status, `download ${i + 1}`).toBe(200);
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
  });

  test("Review Focus 5: revoked after the certificate was made: her download is 404 and her card loses the link; another student's or an unknown id is 404 too", async () => {
    const w = await world();
    const id = await issue(w.kati.cookie);
    for (const path of [`/tunnistus/${id + 1}`, "/tunnistus/abc", "/tunnistus/0"]) expect((await call(w.kati.cookie, "GET", path)).status, path).toBe(404);
    const mari = await student("mari@example.test", "Mari Maasikas");
    expect((await call(mari.cookie, "GET", `/tunnistus/${id}`)).status).toBe(404); // never another student's
    expect((await call(null, "GET", `/tunnistus/${id}`)).status).toBe(401);
    const card = async () => (await loadDashboard(db, w.kati.id, NOW))!.cards.find((c) => c.kind === "ecourse");
    expect(await card()).toMatchObject({ certificateId: id });
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    const res = await call(w.kati.cookie, "GET", `/tunnistus/${id}`);
    expect([res.status, await res.json()]).toEqual([404, { ok: false }]);
    expect(await card()).toMatchObject({ revoked: true, certificateId: null });
    expect(await db.select().from(certificates)).toHaveLength(1); // still Maria's: her register and her drawer show it
  });
});

describe("the e-course page and the dashboard carry it", () => {
  test("loadEcourse: before the completion nothing for the row; once completed her account's name for the field; after the issue its view, in GET /kursus/:slug too", async () => {
    const w = await world({ completedAt: null });
    expect((await loadEcourse(db, w.kati.id, "veebikursus", NOW))!.completion).toMatchObject({ completedAt: null, certificate: null, certificateName: "" });
    await db.update(courseAccess).set({ completedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect((await loadEcourse(db, w.kati.id, "veebikursus", NOW))!.completion).toMatchObject({ completedAt: NOW.toISOString(), certificate: null, certificateName: "Kati Kask" });
    const made = (await (await call(w.kati.cookie, "POST", ISSUE, { name: "Kati Kask" })).json()) as { certificate: unknown };
    const page = (await (await call(w.kati.cookie, "GET", "/kursus/veebikursus")).json()) as { completion: unknown };
    expect(page.completion).toMatchObject({ certificate: made.certificate, certificateName: "Kati Kask" });
  });

  test("loadDashboard: the card's certificateId, null before, its id after, still there once the access has ended", async () => {
    const w = await world();
    const card = async (now = NOW) => (await loadDashboard(db, w.kati.id, now))!.cards[0];
    expect(await card()).toMatchObject({ kind: "ecourse", certificateId: null });
    const id = await issue(w.kati.cookie);
    expect(await card()).toMatchObject({ certificateId: id });
    expect(await card(new Date(NOW.getTime() + 200 * DAY))).toMatchObject({ certificateId: id }); // ended: the card's way back to it
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.**
  - Run: `npx vitest run tests/db/certificate-api.test.ts`.
  - Expected: FAIL:
    - the POST answers 404: the old router reads `/kursus/veebikursus/tunnistus` as a lesson, "tunnistus", and finds no handler;
    - `GET /tunnistus/1` is 404;
    - `loadEcourse`'s `completion` has no `certificate`;
    - the card has no `certificateId`.

- [ ] **Step 3: Write the failing DOM test** `tests/unit/certificate-row-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountCourseCard } from "@/components/account/AccountCourseCard";
import { EcourseView } from "@/components/account/EcourseView";
import { coursesTexts, ecourseTexts } from "@/components/account/texts";
import type { EcourseCard } from "@/domain/account-cards";
import type { CourseSteps } from "@/domain/completion";
import { getDict, type Locale } from "@/i18n/locales";
import type { CertificateView } from "@/server/certificates";
import type { EcourseView as EcourseData } from "@/server/client-data";

// "Tunnistus" in "Lõpetamine" (phase 3d, spec §5) in a browser-like document (happy-dom), with POST …/tunnistus answered here:
// - the row follows "Lõpetatud" once the course is completed, with the name field filled with her account's name;
// - the name is checked here with the server's own rule before anything is sent, and only one request goes however often she presses;
// - the number and the PDF's download link take the field's place, and the server's refusals are put in words;
// - the page keeps one primary button; the admin's read-only copy has nothing to press; it reads in Russian;
// - an ended access's course card links its certificate.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETED = "2026-11-14T10:00:00.000Z";
const ISSUED: CertificateView = { id: 7, number: "MS LAB 2026-03", name: "Kati Kask", issuedAt: "2026-11-15T10:00:00.000Z", reissuedAt: null };
const MODULES: EcourseData["course"]["modules"] = [
  {
    id: 1,
    title: { et: "Teooria", ru: "Теория" },
    lessons: [
      { id: 11, moduleId: 1, title: { et: "Sissejuhatus" }, state: "done" },
      { id: 12, moduleId: 1, title: { et: "Värvid" }, state: "done" },
    ],
  },
];
const DONE: CourseSteps = { lessons: { done: 2, total: 2, state: "done" }, test: { state: "done", triesLeft: null }, practical: { state: "done", round: 1 }, completedAt: COMPLETED };
const data = (over: Partial<EcourseData["completion"]> = {}, progress: EcourseData["progress"] = { done: 2, total: 2, next: null }): EcourseData => ({
  course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, modules: MODULES },
  access: { expiresAt: "2027-04-03T10:00:00.000Z" },
  terms: { version: "1", accepted: true, text: null },
  progress,
  completion: { ...DONE, protocolSent: false, certificate: null, certificateName: "Kati Kask", ...over },
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = (d: EcourseData, locale: Locale = "et", readOnly = false) =>
  act(async () => root.render(createElement(EcourseView, { data: d, locale, t: ecourseTexts(getDict(locale)), readOnly })));
const field = () => $<HTMLInputElement>("[data-certificate-name]");
/** Types into the controlled field as a person would (React listens to the native input event). */
const type = async (value: string) => {
  const input = field();
  expect(input, "the name field").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async () => {
  await act(async () => $<HTMLFormElement>("[data-certificate] form")!.requestSubmit());
  await settle();
};
const errorText = () => $("[data-certificate-error]")!.textContent;
/** The page's filled buttons and links ("Jätka", a step's way in, the certificate's): there may be one at most. */
const primaries = () => $$("[data-ecourse] a, [data-ecourse] button, [data-ecourse] [aria-disabled]").filter((e) => /btn/.test(e.className) && !/btnOutline/.test(e.className));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the 'Tunnistus' row", () => {
  test("after 'Lõpetatud' once the course is completed: the line, 'Nimi tunnistusel' with her account's name, 'Kinnita ja koosta tunnistus' the page's one primary button; none before", async () => {
    await show(data({ completedAt: null, practical: { state: "review", round: 1 } }));
    expect($("[data-certificate]")).toBeNull();
    await show(data());
    const row = $("[data-certificate]")!;
    expect(row.closest("[data-completion]")).not.toBeNull();
    expect($("[data-step='done']")!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.getAttribute("data-step-state")).toBe("open");
    expect(row.textContent).toContain("Tunnistus");
    expect(row.textContent).toContain("Kontrolli, kuidas su nimi tunnistusel kirjas on");
    const label = row.querySelector("label")!;
    expect([label.textContent, label.htmlFor]).toEqual(["Nimi tunnistusel", field()!.id]);
    expect(field()!.value).toBe("Kati Kask");
    const issue = $("[data-certificate-issue]")!;
    expect([issue.tagName, issue.textContent]).toEqual(["BUTTON", "Kinnita ja koosta tunnistus"]);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0]).toBe(issue);
    expect($("[data-certificate-number]")).toBeNull();
    expect($("[data-certificate-download]")).toBeNull();
  });

  test("the name is checked here first, with the server's own rule: digits or an emoji, or too long, is the field's error and nothing is sent", async () => {
    await show(data());
    await type("Kati 2");
    await press();
    expect(errorText()).toBe("Kasuta nimes ainult tähti, tühikuid ja sidekriipse");
    expect(field()!.getAttribute("aria-invalid")).toBe("true");
    expect(field()!.getAttribute("aria-describedby")).toBe($("[data-certificate-error]")!.id);
    await type("Kati 😀");
    await press();
    expect(errorText()).toBe("Kasuta nimes ainult tähti, tühikuid ja sidekriipse");
    await type("A".repeat(81));
    await press();
    expect(errorText()).toBe("Nimi peab olema 2–80 tähemärki pikk");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a good name: sent once, as the rule writes it (a second press waits for the first); the number, 'Laadi tunnistus alla (PDF)' — a plain download link, the page's one primary — and 'Kui nimes on viga, kirjuta meile'; no field any more", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    await show(data());
    await type("  Mari-Liis   Tamm ");
    await press();
    await press(); // a double tap while the first is on its way
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect([url, JSON.parse(String(init!.body))]).toEqual(["/api/konto/kursus/veebikursus/tunnistus", { name: "Mari-Liis Tamm" }]);
    const issue = $("[data-certificate-issue]")!;
    expect([issue.getAttribute("aria-disabled"), issue.textContent]).toEqual(["true", "Koostan tunnistust…"]);
    await act(async () => answer(json(200, { ok: true, certificate: ISSUED })));
    await settle();
    expect($("[data-certificate]")!.getAttribute("data-step-state")).toBe("done");
    const number = $("[data-certificate-number]")!;
    expect(number.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    expect(document.activeElement).toBe(number); // a screen reader hears what happened
    const download = $<HTMLAnchorElement>("[data-certificate-download]")!;
    expect([download.tagName, download.textContent, download.getAttribute("href"), download.hasAttribute("download")]).toEqual(["A", "Laadi tunnistus alla (PDF)", "/api/konto/tunnistus/7", true]);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0]).toBe(download);
    const contact = $("[data-certificate-contact]")!;
    expect([contact.textContent, contact.getAttribute("href")]).toEqual(["Kui nimes on viga, kirjuta meile", "/kontakt"]);
    expect(field()).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  test("another device was first (409 'already'): that certificate is shown; the server's refusals in words, and the button can be pressed again", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: "already", certificate: ISSUED }));
    await show(data());
    await press();
    expect($("[data-certificate-number]")!.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    const cases: [() => Promise<Response>, string][] = [
      [async () => json(400, { ok: false, error: "name", reason: "letters" }), "Kasuta nimes ainult tähti, tühikuid ja sidekriipse"],
      [async () => json(400, { ok: false, error: "name", reason: "length" }), "Nimi peab olema 2–80 tähemärki pikk"],
      [async () => json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
      [async () => json(409, { ok: false, error: "notCompleted" }), "Midagi läks valesti. Proovi uuesti."],
      [async () => json(404, { ok: false }), "Midagi läks valesti. Proovi uuesti."],
      [
        async () => {
          throw new TypeError("offline");
        },
        "Midagi läks valesti. Proovi uuesti.",
      ],
    ];
    for (const [respond, text] of cases) {
      await act(async () => root.unmount()); // a fresh page: the row as it loads
      root = createRoot(container);
      fetchMock.mockImplementationOnce(respond);
      await show(data());
      await press();
      expect(errorText(), text).toBe(text);
      expect($("[data-certificate-issue]")!.hasAttribute("aria-disabled"), text).toBe(false);
      expect($("[data-certificate-number]"), text).toBeNull();
    }
  });

  test("issued already when the page loads: the number and the download, no field; the mark done; the focus stays where it was", async () => {
    await show(data({ certificate: ISSUED }));
    expect($("[data-certificate]")!.getAttribute("data-step-state")).toBe("done");
    expect($("[data-certificate-number]")!.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    expect($("[data-certificate-download]")!.getAttribute("href")).toBe("/api/konto/tunnistus/7");
    expect(field()).toBeNull();
    expect(document.activeElement).not.toBe($("[data-certificate-number]")); // only a certificate made here takes the focus
  });

  test("a lesson added after the completion ('Jätka' on the page): the certificate's button is an outline one, so the page keeps one primary", async () => {
    await show(data({ lessons: { done: 2, total: 3, state: "done" } }, { done: 2, total: 3, next: 13 }));
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].hasAttribute("data-ecourse-next")).toBe(true);
    expect($("[data-certificate-issue]")!.className).toMatch(/btnOutline/);
  });

  test("read-only (the admin's view as client): the row is there with nothing to type, press or follow, also in the server's markup", async () => {
    await show(data(), "et", true);
    expect(field()!.disabled).toBe(true);
    const issue = $("[data-certificate-issue]")!;
    expect([issue.tagName, issue.getAttribute("aria-disabled")]).toEqual(["SPAN", "true"]);
    await show(data({ certificate: ISSUED }), "et", true);
    expect($("[data-certificate-download]")!.tagName).toBe("SPAN");
    expect($("[data-certificate-contact]")!.tagName).toBe("SPAN");
    expect($$("[data-ecourse] a")).toHaveLength(0);
    for (const over of [{}, { certificate: ISSUED }]) {
      const html = renderToStaticMarkup(createElement(EcourseView, { data: data(over), locale: "et", t: ecourseTexts(getDict("et")), readOnly: true }));
      expect(html).toContain('data-certificate=""');
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("<button");
    }
  });

  test("Russian: the row in Russian, a Cyrillic name taken, the contact page under /ru", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, certificate: ISSUED }));
    await show(data(), "ru");
    const row = $("[data-certificate]")!;
    expect(row.textContent).toContain("Сертификат");
    expect(row.textContent).toContain("Проверьте, как ваше имя будет написано в\u00a0сертификате");
    expect(row.querySelector("label")!.textContent).toBe("Имя в\u00a0сертификате");
    expect($("[data-certificate-issue]")!.textContent).toBe("Подтвердить и создать сертификат");
    await type("Kati 2");
    await press();
    expect(errorText()).toBe("Используйте в\u00a0имени только буквы, пробелы и дефисы");
    await type("Катя Каск");
    await press();
    expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({ name: "Катя Каск" });
    expect($("[data-certificate-number]")!.textContent).toBe("Сертификат № MS LAB 2026-03");
    expect($("[data-certificate-download]")!.textContent).toBe("Скачать сертификат (PDF)");
    expect($("[data-certificate-contact]")!.getAttribute("href")).toBe("/ru/kontakt");
  });
});

describe("the course card's 'Laadi tunnistus alla' (spec §5)", () => {
  const card = (over: Partial<EcourseCard> = {}): EcourseCard => ({
    kind: "ecourse",
    course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" } },
    grantedAt: "2026-05-01T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    revoked: false,
    completedAt: COMPLETED,
    certificateId: 7,
    ...over,
  });
  const showCard = (c: EcourseCard, locale: Locale = "et", readOnly = false) =>
    act(async () =>
      root.render(
        createElement(AccountCourseCard, { card: c, now: new Date("2026-11-20T10:00:00.000Z"), locale, t: coursesTexts(getDict(locale)), pay: null, readOnly, sent: false, onChangeRequest: () => {} }),
      ),
    );
  const link = () => $("[data-card-certificate]");

  test("an ended access's card: a quiet download link to its PDF, the way back to it once the course page is closed", async () => {
    await showCard(card());
    expect($("[data-card]")!.hasAttribute("data-past")).toBe(true);
    const a = link()!;
    expect([a.tagName, a.textContent, a.getAttribute("href"), a.hasAttribute("download")]).toEqual(["A", "Laadi tunnistus alla", "/api/konto/tunnistus/7", true]);
    expect(a.className).not.toMatch(/btn/);
    await showCard(card(), "ru");
    expect(link()!.textContent).toBe("Скачать сертификат");
  });

  test("none while the access is open (the course page has the row), without a certificate, or for a revoked access; inert in the admin's view", async () => {
    await showCard(card({ expiresAt: "2027-04-03T10:00:00.000Z", progress: { done: 2, total: 2, next: null } }));
    expect(link()).toBeNull();
    await showCard(card({ certificateId: null }));
    expect(link()).toBeNull();
    await showCard(card({ certificateId: undefined }));
    expect(link()).toBeNull();
    await showCard(card({ revoked: true }));
    expect(link()).toBeNull();
    await showCard(card(), "et", true);
    expect([link()!.getAttribute("href"), link()!.getAttribute("aria-disabled")]).toEqual([null, "true"]);
  });
});
```

- [ ] **Step 4: Run it and expect FAIL.**
  - Run: `npx vitest run tests/unit/certificate-row-dom.test.ts`.
  - Expected: FAIL: there is no `[data-certificate]` row and no `[data-card-certificate]` link (and `tsc` would also flag the `completion` fields and `certificateId`, which do not exist yet).

- [ ] **Step 5: The guard, gate, mail and typography tests** (they fail until the code below exists).
  1. **`tests/unit/account-guards.test.ts`:**
     - After `const nameOf = (chunk: string) => /async function (\w+)/.exec(chunk)![1];` add:

```ts
/** The data endpoints in their order in the source; every one starts with requireClient. */
const HANDLERS = [
  "dashboard", "ecourse", "lesson", "progress", "lessonDone", "lessonFile", "testPage", "submitTest", "resubmitTest", "practicalPage", "uploadPhoto", "deletePhoto", "submitWork", "photo",
  "issueCertificateRoute", "certificateFile", "favouriteCourses", "favourite", "mergeFavouriteList", "profile", "newsletter", "setPassword", "removePassword", "changeRequest", "payRegistration",
  "protocol", "feedbackForm", "sendFeedback", "dismissFeedback", "terms", "deleteAccount",
];
```

     - The line `    expect(handlers.map(nameOf)).toEqual(["dashboard", … "deleteAccount"]);` (line 23) becomes `    expect(handlers.map(nameOf)).toEqual(HANDLERS);`.
     - The line `  test.each(["dashboard", … "deleteAccount"])(` (line 26) becomes `  test.each(HANDLERS)(`.
     - After the test "a practical photo's 302 is built above the handlers …" (it ends at line 63) add:

```ts
  test("a certificate's PDF is built above the handlers (pdfAnswer: the bytes, the PDF's headers, the session's cookies), never by the handler itself", () => {
    const helper = SOURCE.indexOf("function pdfAnswer(");
    expect(helper).toBeGreaterThan(0);
    expect(helper).toBeLessThan(SOURCE.indexOf(START));
    const body = SOURCE.slice(helper, SOURCE.indexOf("\n}\n", helper));
    for (const part of ['"content-type": "application/pdf"', "attachment; filename=", '"x-content-type-options": "nosniff"', "BASE_HEADERS", "session.cookies"]) expect(body, part).toContain(part);
    expect(handlers.find((h) => nameOf(h) === "certificateFile")).toContain("pdfAnswer(session, ");
  });
```

     - In the router test (line 65), its title becomes `"the router sends every known path to a handler, and only GET /kursus/:slug, the test's, the practical work's, the certificate's and the lesson paths are matched by pattern"`, and after its last line `    expect(router.indexOf("TEST_PATH.exec(path)")).toBeLessThan(router.indexOf("LESSON_PATH.exec(path)"));` add:

```ts
    // the certificate (phase 3d): its POST path before the lesson paths, which would read "tunnistus" as a lesson; its PDF by GET only
    expect(router).toContain("CERT_PATH.exec(path)");
    expect(router.indexOf("CERT_PATH.exec(path)")).toBeLessThan(router.indexOf("LESSON_PATH.exec(path)"));
    expect(router).toContain('request.method === "GET" ? CERT_FILE_PATH.exec(path) : null');
```

  2. **`tests/unit/site-gate.test.ts`**: in `GATED`, after `  "/api/konto/kursus/x/test",` add:

```ts
  "/api/konto/kursus/x/tunnistus", // the certificate (phase 3d)
  "/api/konto/tunnistus/1",
```

  3. **`tests/unit/completion-mail.test.ts`**: in `describe("completionMail (Estonian)")`, after the test "completed: the course in the subject; …" (it ends at line 65), add:

```ts
  test("completed: one more line, 'Kinnita oma nimi ja laadi tunnistus alla:' with the e-course's page, where the certificate is (phase 3d); a link, never an attachment; no other kind has it", () => {
    const page = `${BASE}/konto/kursus/kulmude-e-kursus`;
    const withPoints = completionMail(input({ kind: "completed", hasPoints: true }));
    expect(withPoints.text).toBe(
      [
        "Tere, Kati!", "",
        "Oled kõik koolituse sammud läbinud.", "",
        "Kulmude e-kursus", "",
        "Vaata koolitust:", `${page}/praktiline`, "",
        "Kinnita oma nimi ja laadi tunnistus alla:", page, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(withPoints.html).toContain(`Kinnita oma nimi ja laadi tunnistus alla:<br><a href="${page}"`);
    expect((withPoints.html!.match(/mso-padding-alt/g) ?? []).length).toBe(1); // still one button: the line is a text link
    expect(withPoints).not.toHaveProperty("attachments");
    expect(completionMail(input({ kind: "completed" })).text).toContain(`Vaata koolitust:\n${page}\n\nKinnita oma nimi ja laadi tunnistus alla:\n${page}\n\nMS LAB Koolituskeskus`);
    for (const kind of KINDS.filter((k) => k !== "completed")) expect(completionMail(input({ kind })).text, kind).not.toContain("tunnistus");
    expect(completionMail(input({ kind: "completed", locale: "ru" })).text).toContain(`Подтвердите своё имя и скачайте сертификат:\n${BASE}/ru/konto/kursus/kulmude-e-kursus\n`);
  });
```

  4. **`tests/unit/protocols.test.ts`** ("Russian typography"): after `      "account.completion": ru.account.completion,` add:

```ts
      // the certificate (phase 3d, Task 4)
      "account.certificate": ru.account.certificate,
```

- [ ] **Step 6: The texts.**
  1. **`src/i18n/dict/et.ts`.**
     - In `completionMail`, after `      completedButton: "Vaata koolitust",` add `      completedCertificate: "Kinnita oma nimi ja laadi tunnistus alla:",`.
     - In its comment (the three lines above `completionMail: {`), the last line `    // points to fix. Maria's notes-only protocol of an e-course without points takes \`protocolMail\`'s texts. No mail holds a note or an answer.` becomes:

```ts
    // points to fix. Maria's notes-only protocol of an e-course without points takes `protocolMail`'s texts. No mail holds a note or an answer.
    // "completed" adds `completedCertificate` with the e-course's page (phase 3d): her name to confirm and the certificate, a link only.
```

     - Immediately before the line `    // "Lemmikud" /konto/lemmikud (components/account/FavouritesTab.tsx): the hearted courses as the catalogue's cards, each with ♡ to` add:

```ts
    // "Tunnistus" in "Lõpetamine" (components/account/CompletionSteps.tsx; phase 3d, spec §5) once the course is completed, and an ended
    // access's card link (AccountCourseCard.tsx). The certificate itself is Estonian only; these are the page's words around it. {number} is
    // "MS LAB 2026-03". `letters` and `length` are the name rules' refusals (domain/certificate.ts checkCertificateName).
    certificate: {
      title: "Tunnistus",
      check: "Kontrolli, kuidas su nimi tunnistusel kirjas on",
      nameLabel: "Nimi tunnistusel",
      issue: "Kinnita ja koosta tunnistus",
      issuing: "Koostan tunnistust…",
      letters: "Kasuta nimes ainult tähti, tühikuid ja sidekriipse",
      length: "Nimi peab olema 2–80 tähemärki pikk",
      number: "Tunnistus nr. {number}",
      download: "Laadi tunnistus alla (PDF)",
      fixName: "Kui nimes on viga, kirjuta meile",
      cardLink: "Laadi tunnistus alla",
    },
```

  2. **`src/i18n/dict/ru.ts`.**
     - In `completionMail`, after `      completedButton: "Открыть обучение",` add `      completedCertificate: "Подтвердите своё имя и скачайте сертификат:",`.
     - Immediately before `    favourites: {` add:

```ts
    certificate: {
      title: "Сертификат",
      check: "Проверьте, как ваше имя будет написано в\u00a0сертификате",
      nameLabel: "Имя в\u00a0сертификате",
      issue: "Подтвердить и создать сертификат",
      issuing: "Создаю сертификат…",
      letters: "Используйте в\u00a0имени только буквы, пробелы и дефисы",
      length: "Имя должно быть длиной от 2 до 80 символов",
      number: "Сертификат № {number}",
      download: "Скачать сертификат (PDF)",
      fixName: "Если в\u00a0имени ошибка, напишите нам",
      cardLink: "Скачать сертификат",
    },
```

  3. **`src/components/account/texts.ts`.**
     - In `CoursesTexts`, after `  completed: string;` add:

```ts
  /** An ended e-course card's "Laadi tunnistus alla" (phase 3d: account.certificate.cardLink). */
  certificate: string;
```

     - `EcourseTexts` and `ecourseTexts` become:

```ts
/**
 * The e-course page's: the account.ecourse strings, the modules' lock label (course.locked), AccountLoader's, "Lõpetamine" (account.completion)
 * and its "Tunnistus" row (account.certificate, with the two failure lines of the issue: too many tries, anything else).
 */
export type EcourseTexts = Dict["account"]["ecourse"] & {
  locked: string;
  loader: LoaderTexts;
  completion: Dict["account"]["completion"];
  certificate: Dict["account"]["certificate"] & { rate: string; failed: string };
};
```

```ts
export const ecourseTexts = (d: Dict): EcourseTexts => ({
  ...d.account.ecourse,
  locked: d.course.locked,
  loader: loaderTexts(d),
  completion: d.account.completion,
  certificate: { ...d.account.certificate, rate: d.forms.errorTooMany, failed: d.forms.errorGeneric },
});
```

     - `coursesTexts` becomes:

```ts
export const coursesTexts = (d: Dict): CoursesTexts => ({
  ...d.account.dashboard,
  next: d.account.next,
  loader: loaderTexts(d),
  online: payTexts(d),
  completed: d.account.completion.completedOn,
  certificate: d.account.certificate.cardLink,
});
```

  - Run `npx vitest run tests/unit/i18n.test.ts tests/unit/protocols.test.ts`: PASS.

- [ ] **Step 7: The data.**
  1. **`src/domain/account-cards.ts`.** In `EcourseCard`, after `  completedAt?: string | null;` add:

```ts
  /**
   * Her certificate's id (phase 3d, spec §5): null without one, and for a revoked access (Maria revoked it: it is hers no more). Present on
   * every card loadDashboard makes. An ended access's card links GET /api/konto/tunnistus/<id> ("Laadi tunnistus alla"), the one way back to
   * it once the course page has closed. Optional so cards built elsewhere keep compiling.
   */
  certificateId?: number | null;
```

  2. **`src/server/client-data.ts`.**
     - Line 7 becomes `  certificates, clientFavourites, clientLoginTokens, clients, courseAccess, courseFeedback, courses, courseSessions, pages, practicePackages, protocols, registrations, requests,`.
     - Before `import { lockAddress } from "./client-auth";` add `import { certificateOfAccess, type CertificateView } from "./certificates";`.
     - In `EcourseView`, the `completion` field with its doc comment (lines 77–81) becomes:

```ts
  /**
   * "Lõpetamine" (e-course completion, spec §4.1): the path's steps (server/completion.ts loadSteps), and `protocolSent`: an e-course
   * without points whose notes-only protocol Maria has sent (spec §4.3 last bullet: the block links to it, "Vaata protokolli").
   * "Tunnistus" (phase 3d, spec §5), read once the course is completed: `certificate` is its view (null before it is issued), and
   * `certificateName` her account's name, the first value of "Nimi tunnistusel". Before the completion they are null and "".
   */
  completion: CourseSteps & { protocolSent: boolean; certificate: CertificateView | null; certificateName: string };
```

     - In `loadDashboard`, the `course_access` query (lines 153–157) becomes:

```ts
    db
      .select({
        courseId: courseAccess.courseId,
        grantedAt: courseAccess.grantedAt,
        expiresAt: courseAccess.expiresAt,
        revokedAt: courseAccess.revokedAt,
        completedAt: courseAccess.completedAt,
        certificateId: certificates.id,
        slug: courses.slug,
        title: courses.title,
      })
      .from(courseAccess)
      .innerJoin(courses, eq(courseAccess.courseId, courses.id))
      .leftJoin(certificates, eq(certificates.accessId, courseAccess.id))
      .where(eq(courseAccess.clientId, clientId)),
```

     - The card in `for (const a of accessRows)` becomes:

```ts
    const card: EcourseCard = {
      kind: "ecourse",
      course: { slug: a.slug, title: a.title },
      grantedAt: iso(a.grantedAt),
      expiresAt: iso(a.expiresAt),
      revoked: a.revokedAt !== null,
      completedAt: a.completedAt ? iso(a.completedAt) : null,
      // the certificate (phase 3d): its id while the access is not revoked, so an ended access's card links it; a revoked one's never
      certificateId: a.revokedAt === null ? a.certificateId : null,
    };
```

     - `loadEcourse` with its doc comment (lines 330–364) becomes:

```ts
/**
 * The e-course page's data: null without active access (none, revoked or expired: the access row is read in any state,
 * server/completion.ts accessFor, and must be active, isActive), with its modules, the visible lessons and their states, the counts, and
 * the path's steps ("Lõpetamine", e-course completion). The terms notice shows while `terms.accepted` is false;
 * the page then sends back `terms.version` with the acceptance. The version is read BEFORE the text: an admin save that lands
 * in between then pairs the old version with the new text (the next visit shows the notice again), never a new version with
 * text the student did not see. The client's acceptances are read alongside. Once the course is completed, its certificate and her
 * account's name are read for the "Tunnistus" row (phase 3d); before, nothing is read for it.
 *
 * `onCompleted` is given by the student's own page (account-api.ts) and by nobody else (Maria's read-only view only reads): the load then
 * completes an access whose steps are all done and `completed_at` is still null (completeIfDone, before the steps are read: the view shows
 * it done), and calls `onCompleted(accessId)` once, for the call that set it, so the handler queues the "completed" mail. It heals the
 * accesses whose steps were done before the completion existed, and a check that failed once after a lesson write.
 */
export async function loadEcourse(db: Db, clientId: number, slug: string, now: Date, onCompleted?: (accessId: number) => void): Promise<EcourseView | null> {
  let access = await accessFor(db, clientId, slug);
  if (!access || !isActive(access, now)) return null;
  if (onCompleted && access.completedAt === null && (await completeOnLoad(db, access.id, now))) {
    access = { ...access, completedAt: now };
    onCompleted(access.id);
  }
  const completed = access.completedAt !== null;
  const [terms, outline, steps, sent, certificate, certificateName] = await Promise.all([
    termsState(db, clientId, access.course.id),
    courseOutline(db, access.course.id, clientId),
    loadSteps(db, access),
    // a notes-only protocol of this access that Maria has sent (only read for a course without points, but one small read either way)
    db.select({ id: protocols.id }).from(protocols).where(and(eq(protocols.accessId, access.id), isNotNull(protocols.sentAt))).limit(1),
    // "Tunnistus" (phase 3d): only a completed course has the row
    completed ? certificateOfAccess(db, access.id) : null,
    completed ? db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1).then(([c]) => c?.name ?? "") : "",
  ]);
  return {
    course: { slug: access.course.slug, title: access.course.title, modules: outline.modules },
    access: { expiresAt: iso(access.expiresAt) },
    terms,
    progress: outline.progress,
    completion: { ...steps, protocolSent: steps.practical === null && sent.length > 0, certificate, certificateName },
  };
}
```

  3. **The pins of the old shapes** (each gains the new fields):
     - `tests/db/client-data.test.ts`, line 245: the `expect(cards[1]).toEqual({ … revoked: false, progress: null, completedAt: null })` object gains `certificateId: null`.
     - `tests/db/client-data.test.ts`, line 455: the `completion: { … completedAt: null, protocolSent: false }` object gains `certificate: null, certificateName: ""`.
     - `tests/db/account-api.test.ts`, line 815: the same `completion` line gains `certificate: null, certificateName: ""`.
     - `tests/db/admin-clients.test.ts`, line 341: the `expect(dash.cards).toEqual([{ … progress: null, completedAt: null }])` object gains `certificateId: null`.
     - `tests/unit/account-ecourse.test.ts`, line 50: `COMPLETION` becomes `{ lessons: { done: 1, total: 4, state: "open" }, test: null, practical: null, completedAt: null, protocolSent: false, certificate: null, certificateName: "" }`.
     - `tests/unit/completion-steps-dom.test.ts`, line 47: `  completion: { ...s, protocolSent },` becomes `  completion: { ...s, protocolSent, certificate: null, certificateName: "" },`.

- [ ] **Step 8: The two routes** (`src/server/account-api.ts`).
  1. In the header comment (line 62), `GET /praktiline/foto/:id and …/:id/pisi one of her photos (a 302 to a signed address), POST /kustuta account deletion` becomes `GET /praktiline/foto/:id and …/:id/pisi one of her photos (a 302 to a signed address), POST /kursus/:slug/tunnistus the certificate of her completed e-course with the name she confirmed and GET /tunnistus/:id its PDF (phase 3d), POST /kustuta account deletion`.
  2. After `import { clients } from "@/db/schema";` add `import { certificateFileName } from "@/domain/certificate";`. After `import type { BunnyConfig } from "./bunny";` add `import { certificateForStudent, certificatePdf, issueCertificate } from "./certificates";`.
  3. After `const PHOTO_BODY_BYTES = PHOTO_LIMITS.fullBytes + PHOTO_LIMITS.thumbBytes + PHOTO_ENVELOPE;` add:

```ts
/** Certificate issues a student may ask for per hour (phase 3d, spec §5): one is enough, a double tap or a retry after a refused name more. */
const CERTIFICATE_ISSUES_PER_HOUR = 10;
/** Certificate downloads per hour (spec §5): each one renders the PDF, a few tens of milliseconds of the function. */
const CERTIFICATE_FILES_PER_HOUR = 10;
/** The issue's body, `{ name }`: a name of at most 80 characters, with room for its JSON escapes. */
const CERTIFICATE_BODY_CHARS = 1024;
```

  4. After `photoAnswer` (its closing `}` follows `  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);\n  return res;`, line 457) add:

```ts
/**
 * A certificate's PDF for its owner (phase 3d, spec §5, §7): the bytes as a download named `fileName`, `private, no-store`, not for search
 * engines, nosniff; the cookies of a renewed session go with it, as with clientResponse. The handlers never build a Response of their own.
 * (The cast: the PDF's bytes are a Uint8Array<ArrayBufferLike>, which TypeScript does not take as a BlobPart as it stands.)
 */
function pdfAnswer(session: ClientSession, bytes: Uint8Array, fileName: string): Response {
  const res = new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
    headers: { ...BASE_HEADERS, "content-type": "application/pdf", "content-disposition": `attachment; filename="${fileName}"`, "x-content-type-options": "nosniff" },
  });
  for (const cookie of session.cookies) res.headers.append("set-cookie", cookie);
  return res;
}
```

  5. Immediately before the doc comment `/**\n * GET /lemmikud?l=<et|ru>: the Lemmikud tab, …` (after `photo`) add:

```ts
/**
 * POST /kursus/:slug/tunnistus `{ name }` (phase 3d, spec §5): the certificate of her completed e-course, with the name she confirmed. It is
 * made by certificates.ts issueCertificate, under the access's lock and then the number series' lock, one per access.
 * - 200 `{ ok: true, certificate }`.
 * - 409 `{ error: "already", certificate }`: made already, by a double tap or another device; the answer is the one there is.
 * - 409 `{ error: "notCompleted" }`.
 * - 400 `{ error: "name", reason: "length" | "letters" }`: the name rules. A body that is no `{ name }` counts as an empty name.
 * - 429 `{ error: "rate" }` after 10 in an hour.
 * - 404 without the access (a revoked one too), and for a contact course.
 */
async function issueCertificateRoute(request: Request, deps: AccountDeps, rawSlug: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const slug = parseSlug(rawSlug);
  if (slug === null) return clientResponse(session, { ok: false }, 404);
  const body = await readObject(request, CERTIFICATE_BODY_CHARS);
  if (!(await withinClientLimit(deps, session.clientId, "client-certificate", CERTIFICATE_ISSUES_PER_HOUR, 60 * 60))) {
    logNote("[account] certificate issues rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const result = await issueCertificate(deps.db, session.clientId, slug, typeof body?.name === "string" ? body.name : "", deps.now);
  switch (result.kind) {
    case "issued":
      return clientResponse(session, { ok: true, certificate: result.certificate });
    case "already":
      return clientResponse(session, { ok: false, error: "already", certificate: result.certificate }, 409);
    case "notCompleted":
      return clientResponse(session, { ok: false, error: "notCompleted" }, 409);
    case "invalid":
      return clientResponse(session, { ok: false, error: "name", reason: result.error }, 400);
    default:
      return clientResponse(session, { ok: false }, 404);
  }
}

/**
 * GET /tunnistus/:id (phase 3d, spec §5, §7): her certificate as a PDF (certificates.ts certificatePdf, rendered from the frozen row on each
 * download), via pdfAnswer as `attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`. Only her own access's certificate, and only while
 * that access is not revoked; an ended (expired) access keeps it. 404 `{ ok: false }` for any other id; 429 `{ error: "rate" }` after 10
 * in an hour (a 404 counts too, so ids cannot be probed).
 */
async function certificateFile(request: Request, deps: AccountDeps, rawId: string): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = parseRowId(rawId);
  if (id === null) return clientResponse(session, { ok: false }, 404);
  if (!(await withinClientLimit(deps, session.clientId, "client-certificate-pdf", CERTIFICATE_FILES_PER_HOUR, 60 * 60))) {
    logNote("[account] certificate downloads rate limited");
    return clientResponse(session, { ok: false, error: "rate" }, 429);
  }
  const cert = await certificateForStudent(deps.db, session.clientId, id);
  if (!cert) return clientResponse(session, { ok: false }, 404);
  const bytes = await certificatePdf(deps.db, deps.files ?? null, cert, deps.now);
  return pdfAnswer(session, bytes, certificateFileName(cert.year, cert.seq));
}
```

  6. After `const PHOTO_PATH = /^\/praktiline\/foto\/([^/]+)(\/pisi)?$/;` add:

```ts
/** The certificate of one e-course (phase 3d): POST /kursus/<slug>/tunnistus. Tried before LESSON_PATH, which would read "tunnistus" as a lesson id. */
const CERT_PATH = /^\/kursus\/([^/]+)\/tunnistus$/;
/** A certificate's PDF (phase 3d; the id in the path, never a query): GET /tunnistus/<id>. */
const CERT_FILE_PATH = /^\/tunnistus\/([^/]+)$/;
```

  7. In `dataRoute`, after `  if (photoPath) return photo(request, deps, photoPath[1], photoPath[2] !== undefined);` add:

```ts
  // the certificate (phase 3d): its path before the lesson paths, which would read "tunnistus" as a lesson; POST only
  const certPath = CERT_PATH.exec(path);
  if (certPath) return request.method === "POST" ? issueCertificateRoute(request, deps, certPath[1]) : accountResponse({ ok: false }, 404);
  const certFile = request.method === "GET" ? CERT_FILE_PATH.exec(path) : null;
  if (certFile) return certificateFile(request, deps, certFile[1]);
```

  - Run `npx vitest run tests/db/certificate-api.test.ts tests/unit/account-guards.test.ts tests/unit/site-gate.test.ts tests/db/client-data.test.ts tests/db/account-api.test.ts tests/db/admin-clients.test.ts`: PASS.

- [ ] **Step 9: The completed mail's line** (`src/server/account-mail.ts`). `completionMail` with its doc comment (lines 624–666) becomes:

```ts
/**
 * The student's mails of the e-course completion (spec §6): the greeting, one line, the course in its box (an assessment adds how many points
 * to fix), and one button to the page it is about, written out under it. No login code: the button opens the page, and she signs in there if
 * she must. Never a note, an answer or a photo, only the link. The test's and practical work's links follow the kind:
 * - assessed, protocol, protocolAgain and testPassed: the practical work;
 * - testFix and reopened: the test;
 * - completed: the practical work of a course with points, else the e-course's page.
 * "completed" adds one line under the button (phase 3d, spec §5): "Kinnita oma nimi ja laadi tunnistus alla:" with the e-course's page, where
 * its "Tunnistus" row is. It is a text link, so the mail keeps its one button, and never an attachment. Plain text and HTML; the caller never
 * sends it to a sample address.
 */
export function completionMail(input: CompletionMailInput): Mail {
  const dict = getDict(input.locale);
  const m = dict.account.completionMail;
  const p = dict.account.protocolMail;
  const mail = dict.account.mail;
  const title = pick(input.course, input.locale);
  const practical = practicalUrl(input.siteUrl, input.locale, input.slug);
  const test = testUrl(input.siteUrl, input.locale, input.slug);
  const parts: Record<CompletionMailKind, { subject: string; lead: string; button: string; link: string }> = {
    assessed: { subject: m.assessedSubject, lead: m.assessedLead, button: m.assessedButton, link: practical },
    completed: {
      subject: oneLine(fill(m.completedSubject, { title })),
      lead: m.completedLead,
      button: m.completedButton,
      link: input.hasPoints ? practical : ecourseUrl(input.siteUrl, input.locale, input.slug),
    },
    testPassed: { subject: m.testPassedSubject, lead: m.testPassedLead, button: m.testPassedButton, link: practical },
    testFix: { subject: m.testFixSubject, lead: m.testFixLead, button: m.testFixButton, link: test },
    reopened: { subject: m.reopenedSubject, lead: m.reopenedLead, button: m.reopenedButton, link: test },
    protocol: { subject: p.subjectFirst, lead: p.leadFirst, button: p.button, link: practical },
    protocolAgain: { subject: p.subjectAgain, lead: p.leadAgain, button: p.button, link: practical },
  };
  const { subject, lead, button, link } = parts[input.kind];
  const greeting = hello(dict.account.dashboard, input.name);
  const lines = input.kind === "assessed" && input.fixCount ? [fill(m.fixCount, { n: input.fixCount })] : [];
  // the certificate (phase 3d): her name to confirm and the PDF to download, on the e-course's page
  const certificate = input.kind === "completed" ? ecourseUrl(input.siteUrl, input.locale, input.slug) : null;
  const text = [
    greeting, "",
    lead, "",
    title, ...lines, "",
    `${button}:`, link,
    ...(certificate ? ["", m.completedCertificate, certificate] : []),
    "", mail.signature,
  ].join("\n");
  const html = mailCard(subject, input.locale, [
    greetingRow(greeting),
    paragraphRow(lead),
    boxRow(`<div style="font:600 18px/1.4 ${FONT};color:${INK};">${esc(title)}</div>` + lines.map((line) => `<div>${esc(line)}</div>`).join(""), 12),
    buttonRow(link, button),
    linkRow(link),
    ...(certificate
      ? [
          row(
            `padding:20px 28px 0;${textStyle(14)}`,
            `${esc(m.completedCertificate)}<br><a href="${esc(certificate)}" style="color:${INK};text-decoration:underline;word-break:break-all;">${esc(certificate)}</a>`,
          ),
        ]
      : []),
    signatureRow(mail),
  ]);
  return { to: input.email, subject, text, html };
}
```

  - Run `npx vitest run tests/unit/completion-mail.test.ts tests/db/completion-core.test.ts tests/db/assessment.test.ts tests/db/test-attempts.test.ts`: PASS. The "completed" mail's other assertions are `toContain`, so they hold.

- [ ] **Step 10: The row** — `src/components/account/CompletionSteps.tsx` becomes:

```tsx
"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { checkCertificateName } from "@/domain/certificate";
import type { CourseSteps, StepState } from "@/domain/completion";
import { fill, formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { CertificateView } from "@/server/certificates";
import type { EcourseTexts } from "./texts";
import styles from "./CompletionSteps.module.css";

type CompletionTexts = EcourseTexts["completion"];
type CertificateTexts = EcourseTexts["certificate"];
type StepKey = "lessons" | "test" | "practical" | "done";
/** One row: the step, its state, its name, its one line, and where it leads (nothing while it is locked, nor for the lessons and the end). */
type Row = { key: StepKey; state: StepState; name: string; line: string; link: { to: string; label: string; main: boolean } | null };

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** A step she has to act in now: its link opens it ("Ava …"); otherwise the link shows her results. */
const acts = (state: StepState): boolean => state === "open" || state === "fix";

/** The test's line: why it waits, the tries left, Maria's turn, a fix, passed, or no tries left (spec §4.2's words). */
function testLine(state: StepState, triesLeft: number | null, c: CompletionTexts): string {
  switch (state) {
    case "locked":
      return c.lockedLessons;
    case "open":
      return triesLeft === null ? c.open : fill(c.testOpen, { n: triesLeft });
    case "review":
      return c.testReview;
    case "fix":
      return c.testFix;
    case "done":
      return c.testDone;
    case "used":
      return c.testUsed;
  }
}

/** The practical work's line; locked, it waits for the test, or (a course without questions) for the lessons. */
function practicalLine(state: StepState, hasTest: boolean, c: CompletionTexts): string {
  switch (state) {
    case "locked":
      return hasTest ? c.lockedTest : c.lockedLessons;
    case "review":
      return c.practicalReview;
    case "fix":
      return c.practicalFix;
    case "done":
      return c.practicalDone;
    default:
      return c.practicalOpen;
  }
}

/** The certificate in an answer of POST …/tunnistus (a 200's, or a 409 "already"'s): its view; null for anything that is not one. */
function certificateOf(value: unknown): CertificateView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "number" || typeof v.number !== "string" || typeof v.name !== "string" || typeof v.issuedAt !== "string") return null;
  return { id: v.id, number: v.number, name: v.name, issuedAt: v.issuedAt, reissuedAt: typeof v.reissuedAt === "string" ? v.reissuedAt : null };
}

/**
 * "Tunnistus" (phase 3d, spec §5), the row after "Lõpetatud" once the course is completed.
 * - **Before the certificate is made:** "Kontrolli, kuidas su nimi tunnistusel kirjas on", the field "Nimi tunnistusel" (her account's name
 *   to start with) and "Kinnita ja koosta tunnistus". The button checks the name here first (domain/certificate.ts checkCertificateName,
 *   the server's own rule), then POSTs it once; a second press waits for the first.
 * - **The answer:** its certificate, made now or by another of her devices first ("already"), turns the row into "Tunnistus nr. {number}"
 *   (which takes the focus), "Laadi tunnistus alla (PDF)" (a plain download link; the API names the file) and "Kui nimes on viga, kirjuta
 *   meile", to the contact page; the name is hers to change no more. A refusal is put in words under the field.
 * - **Its button** is the page's one primary (every step is done by now), unless "Jätka" is on the page (`quiet`: a lesson added after the
 *   completion); it is then an outline one.
 * `readOnly` (the admin's view as client): the same row, nothing to type, press or follow.
 */
function CertificateRow({ slug, mark, certificate, startName, locale, t, readOnly, quiet }: {
  slug: string;
  /** The row's number in the list, shown in its mark until the certificate is made. */
  mark: number;
  certificate: CertificateView | null;
  startName: string;
  locale: Locale;
  t: CertificateTexts;
  readOnly: boolean;
  quiet: boolean;
}) {
  const nameId = useId();
  const errorId = useId();
  const [made, setMade] = useState<CertificateView | null>(null);
  const [name, setName] = useState(startName);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);
  const issued = made ?? certificate;
  const button = `${quiet ? ui.btnOutline : ui.btn} ${styles.action} ${styles.main}`;

  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || sending.current) return;
    const checked = checkCertificateName(name);
    if (!checked.ok) return setError(checked.error === "letters" ? t.letters : t.length);
    sending.current = true;
    setBusy(true);
    setError("");
    const answer = await sendJson(`/api/konto/kursus/${encodeURIComponent(slug)}/tunnistus`, { name: checked.name });
    sending.current = false;
    setBusy(false);
    const view = certificateOf(answer.data.certificate);
    // made now, or by another of her devices first: either way the one she has
    if (view && (isDone(answer) || answer.data.error === "already")) return setMade(view);
    if (answer.status === 400 && answer.data.error === "name") return setError(answer.data.reason === "letters" ? t.letters : t.length);
    setError(answer.status === 429 ? t.rate : t.failed);
  };

  return (
    <li className={styles.step} data-step-state={issued ? "done" : "open"} data-certificate="">
      <span className={styles.mark} aria-hidden="true">
        {issued ? <Icon name="check" size={16} /> : mark}
      </span>
      <div className={styles.body}>
        <p className={styles.name}>{t.title}</p>
        {issued ? (
          <>
            <p ref={made ? focusOnMount : undefined} className={`${styles.line} ${styles.number}`} tabIndex={-1} data-certificate-number="">
              {fill(t.number, { number: issued.number })}
            </p>
            {readOnly ? (
              <span className={button} aria-disabled="true" data-certificate-download="">
                {t.download}
              </span>
            ) : (
              <a className={button} href={`/api/konto/tunnistus/${issued.id}`} download data-certificate-download="">
                {t.download}
              </a>
            )}
            {readOnly ? (
              <span className={`${ui.link} ${styles.fix}`} aria-disabled="true" data-certificate-contact="">
                {t.fixName}
              </span>
            ) : (
              <Link className={`${ui.link} ${styles.fix}`} href={href(locale, "/kontakt")} data-certificate-contact="">
                {t.fixName}
              </Link>
            )}
          </>
        ) : (
          <form className={styles.certificate} onSubmit={issue} noValidate>
            <p className={styles.line}>{t.check}</p>
            <div className={styles.field}>
              <label htmlFor={nameId}>{t.nameLabel}</label>
              <input
                id={nameId}
                name="certificateName"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={readOnly}
                aria-invalid={error ? true : undefined}
                aria-describedby={errorId}
                data-certificate-name=""
              />
            </div>
            <p id={errorId} className={styles.error} role="alert" data-certificate-error="">
              {error}
            </p>
            {readOnly ? (
              <span className={button} aria-disabled="true" data-certificate-issue="">
                {t.issue}
              </span>
            ) : (
              <button type="submit" className={button} aria-disabled={busy || undefined} data-certificate-issue="">
                {busy ? t.issuing : t.issue}
              </button>
            )}
          </form>
        )}
      </div>
    </li>
  );
}

/**
 * "Lõpetamine" on the e-course page (e-course completion, spec §4.1), below the modules: Õppetunnid → Teadmiste test → Praktiline töö →
 * Lõpetatud. Each step: a round mark (its number while ahead, ✓ done, a lock while it waits), its name, its state in one line (a locked
 * step says why), and once open the way in — the test's page, the practical work's page. A step the course does not have (`steps.test` /
 * `steps.practical` null) is not shown. The link of the step she acts in is the page's one button once the lessons are done ("Jätka" is
 * gone by then); every other link is a text link. `protocolSent` (an e-course without points whose notes Maria sent, spec §4.3): "Vaata
 * protokolli", to the practical page that shows her notes. `readOnly` (the admin's view as client): the links are there and do nothing.
 * Once the course is completed the "Tunnistus" row follows "Lõpetatud" (CertificateRow, phase 3d): `certificate` once made, else her
 * account's name in its field (`certificateName`). Every step is done by then, so its button is the page's one primary, unless "Jätka" is
 * on the page (`resumeShown`: a lesson added after the completion).
 */
export function CompletionSteps({
  slug,
  steps,
  protocolSent,
  certificate,
  certificateName,
  resumeShown = false,
  locale,
  t,
  readOnly,
}: {
  slug: string;
  steps: CourseSteps;
  protocolSent: boolean;
  certificate: CertificateView | null;
  certificateName: string;
  resumeShown?: boolean;
  locale: Locale;
  t: EcourseTexts;
  readOnly: boolean;
}) {
  const c = t.completion;
  const headingId = useId();
  const base = `/konto/kursus/${slug}`;
  const lessonsDone = steps.lessons.state === "done";
  const rows: Row[] = [
    {
      key: "lessons",
      state: steps.lessons.state,
      name: c.steps.lessons,
      line: lessonsDone ? c.lessonsDone : fill(c.lessonsOpen, { done: steps.lessons.done, total: steps.lessons.total }),
      link: null,
    },
  ];
  if (steps.test) {
    const { state, triesLeft } = steps.test;
    rows.push({
      key: "test",
      state,
      name: c.steps.test,
      line: testLine(state, triesLeft, c),
      link: state === "locked" ? null : { to: `${base}/test`, label: acts(state) ? c.openTest : c.viewResult, main: acts(state) && lessonsDone },
    });
  }
  if (steps.practical) {
    const { state } = steps.practical;
    rows.push({
      key: "practical",
      state,
      name: c.steps.practical,
      line: practicalLine(state, steps.test !== null, c),
      // at most one primary button: when the test is hers to act in too (Maria added questions while the work was at "fix"), the test's is it
      link: state === "locked" ? null : { to: `${base}/praktiline`, label: acts(state) ? c.openPractical : c.viewPractical, main: acts(state) && lessonsDone && !rows.some((r) => r.link?.main) },
    });
  }
  rows.push({
    key: "done",
    state: steps.completedAt ? "done" : "locked",
    name: c.steps.done,
    line: steps.completedAt ? fill(c.completedOn, { date: formatDate(new Date(steps.completedAt), locale) }) : c.doneLocked,
    link: null,
  });

  /** A step's way in: a link, or (read-only) the same look doing nothing, as the page's "Jätka". */
  const way = (link: NonNullable<Row["link"]>) => {
    const cls = link.main ? `${ui.btn} ${styles.action} ${styles.main}` : `${ui.link} ${styles.action}`;
    const label = (
      <>
        {link.label}
        {link.main && <Icon name="arrow" />}
      </>
    );
    return readOnly ? (
      <span className={cls} aria-disabled="true" data-step-link="">
        {label}
      </span>
    ) : (
      <Link className={cls} href={href(locale, link.to)} data-step-link="">
        {label}
      </Link>
    );
  };

  return (
    <section className={styles.block} aria-labelledby={headingId} data-completion="">
      <h2 id={headingId} className={styles.title}>
        {c.title}
      </h2>
      <ol className={styles.steps}>
        {rows.map((row, i) => (
          <li key={row.key} className={styles.step} data-step={row.key} data-step-state={row.state}>
            <span className={styles.mark} aria-hidden="true">
              {row.state === "done" ? <Icon name="check" size={16} /> : row.state === "locked" ? <Icon name="lock" size={16} /> : i + 1}
            </span>
            <div className={styles.body}>
              <p className={styles.name} data-step-name="">
                {row.name}
              </p>
              <p className={styles.line} data-step-line="">
                {row.line}
              </p>
              {row.link && way(row.link)}
            </div>
          </li>
        ))}
        {steps.completedAt !== null && (
          <CertificateRow
            slug={slug}
            mark={rows.length + 1}
            certificate={certificate}
            startName={certificateName}
            locale={locale}
            t={t.certificate}
            readOnly={readOnly}
            quiet={resumeShown}
          />
        )}
      </ol>
      {protocolSent && (
        <p className={styles.protocol}>
          {readOnly ? (
            <span className={ui.btnOutline} aria-disabled="true" data-view-protocol="">
              {c.viewProtocol}
            </span>
          ) : (
            <Link className={ui.btnOutline} href={href(locale, `${base}/praktiline`)} data-view-protocol="">
              {c.viewProtocol}
            </Link>
          )}
        </p>
      )}
    </section>
  );
}
```

  **`src/components/account/CompletionSteps.module.css`.**
  1. Its header comment becomes:

```css
/* "Lõpetamine" under the e-course's modules (e-course completion, spec §4.1): the path's steps as a numbered column between thin lines (the
   modules' rows): a round mark (the step's number while it is ahead, ✓ done, a lock while it waits), the step's name, its state in one line,
   and the way in — the page's one button for the step she acts in, a text link otherwise. Once the course is completed, "Tunnistus" (phase
   3d) is the last row: the name field (the login's B .field look) and its button, then the number, the download and the contact link. Every
   row, field and link is at least 44 px. The page is EcoursePage.module.css's. Tokens only; nothing moves. */
```

  2. After the `.protocol { margin: 18px 0 0; }` rule (before `@media (max-width: 640px)`) add:

```css
/* "Tunnistus" (phase 3d, spec §5): before the certificate is made, the line, the name field with its error under it and the button */
.certificate {
  display: grid;
  justify-items: start;
  justify-self: stretch;
  gap: 2px;
  max-width: 440px;
}

.field {
  display: flex;
  flex-direction: column;
  justify-self: stretch;
  margin: 12px 0 0;
  font: 600 13px/1.3 var(--font-body);
}

.field label {
  margin: 0 0 8px;
}

.field input {
  width: 100%;
  min-height: 52px;
  padding: 12px 16px;
  border: 1px solid var(--heather);
  border-radius: 12px;
  background: var(--paper);
  color: var(--ink);
  font: 400 17px/1.4 var(--font-body);
}

.field input:focus {
  border-color: var(--rose);
}

.field input:disabled {
  color: var(--muted);
}

.field [aria-invalid="true"] {
  border-color: var(--bad);
}

.error {
  margin: 8px 0 0;
  color: var(--bad);
  font: 500 14px/1.45 var(--font-body);
}

.error:empty {
  margin: 0;
}

/* the number takes the focus once the certificate is made (a screen reader hears it): no ring for a line of text */
.number:focus {
  outline: none;
}

/* "Kui nimes on viga, kirjuta meile": ui.link's look, its words wrapping on a phone (two classes outweigh ui.link's nowrap) */
.body .fix {
  white-space: normal;
}
```

- [ ] **Step 11: The page and the card.**
  1. **`src/components/account/EcourseView.tsx`.**
     - In its doc comment, the bullet ` * - below them, "Lõpetamine" (CompletionSteps, e-course completion): the path's steps, once the course has lessons (or is completed, or Maria\n *   sent her notes: "Vaata protokolli").` becomes:

```ts
 * - below them, "Lõpetamine" (CompletionSteps, e-course completion): the path's steps, once the course has lessons (or is completed, or Maria
 *   sent her notes: "Vaata protokolli"); once completed, its "Tunnistus" row (phase 3d), whose button gives way to "Jätka" when that is shown.
```

     - The `CompletionSteps` call (lines 167–169) becomes:

```tsx
      {(total > 0 || data.completion.completedAt !== null || data.completion.protocolSent) && (
        <CompletionSteps
          slug={slug}
          steps={data.completion}
          protocolSent={data.completion.protocolSent}
          certificate={data.completion.certificate}
          certificateName={data.completion.certificateName}
          resumeShown={total > 0 && next !== null}
          locale={locale}
          t={t}
          readOnly={readOnly}
        />
      )}
```

  2. **`src/components/account/AccountCourseCard.tsx`.**
     - In the component's doc comment, after the line ` * A completed e-course says 'Lõpetatud {date}' (e-course completion), also after its access has ended.` add the line ` * An ended e-course with a certificate links its PDF, "Laadi tunnistus alla" (phase 3d), a quiet text link: the course page has closed.`.
     - After the protocol block (it ends with `      );\n  }` after `if (main) button = link;\n    else\n      second = (…);`, line 218) add:

```tsx
  // "Laadi tunnistus alla" (phase 3d, spec §5): an ended access's way back to its certificate, since the e-course page needs an active access.
  // A revoked access has none (certificateId is null). A plain link: the API answers with the PDF as a download, named by its number.
  const certificateId = card.kind === "ecourse" && !card.revoked && isPastCard(card, now) ? (card.certificateId ?? null) : null;
  if (certificateId !== null) {
    const link = readOnly ? (
      <a className={styles.second} role="link" aria-disabled="true" data-card-certificate="">
        {t.certificate}
      </a>
    ) : (
      <a className={styles.second} href={`/api/konto/tunnistus/${certificateId}`} download data-card-certificate="">
        {t.certificate}
      </a>
    );
    second = (
      <>
        {second}
        {link}
      </>
    );
  }
```

  - Run `npx vitest run tests/unit/certificate-row-dom.test.ts tests/unit/completion-steps-dom.test.ts tests/unit/account-ecourse.test.ts tests/unit/account-readonly.test.ts tests/unit/account-dashboard-dom.test.ts tests/unit/old-safari.test.ts tests/unit/colour-tokens.test.ts tests/db/certificate-api.test.ts tests/db/completion-ecourse.test.ts`: PASS.

- [ ] **Step 12: Run everything.**
  - `npx vitest run`: all green.
  - `npx tsc --noEmit`, then `npx eslint .`: clean.
  - `npx playwright test completion account-ecourse account-dashboard`: green. These specs cover:
    - the completed course page, which now shows the "Tunnistus" row under every step done;
    - the e-course page;
    - the dashboard cards.
  - The row's widths and the download itself are Task 7's.

- [ ] **Step 13: Commit** (from the repository root):

```bash
git add app/src/server/account-api.ts app/src/server/client-data.ts app/src/domain/account-cards.ts app/src/server/account-mail.ts \
  app/src/components/account/CompletionSteps.tsx app/src/components/account/CompletionSteps.module.css app/src/components/account/EcourseView.tsx \
  app/src/components/account/AccountCourseCard.tsx app/src/components/account/texts.ts app/src/i18n/dict/et.ts app/src/i18n/dict/ru.ts \
  app/tests/db/certificate-api.test.ts app/tests/unit/certificate-row-dom.test.ts app/tests/unit/account-guards.test.ts app/tests/unit/site-gate.test.ts \
  app/tests/unit/completion-mail.test.ts app/tests/unit/protocols.test.ts app/tests/unit/completion-steps-dom.test.ts app/tests/unit/account-ecourse.test.ts \
  app/tests/db/client-data.test.ts app/tests/db/account-api.test.ts app/tests/db/admin-clients.test.ts
git commit -m "feat(certificate): the student confirms her name and downloads the PDF — the Tunnistus row, the two account routes, the card link, the completed mail's line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):**

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| `account.certificate.title` | Tunnistus | Сертификат | Spec (ET); RU Draft |
| `account.certificate.check` | Kontrolli, kuidas su nimi tunnistusel kirjas on | Проверьте, как ваше имя будет написано в сертификате | Spec (ET); RU Draft |
| `account.certificate.nameLabel` | Nimi tunnistusel | Имя в сертификате | Spec (ET); RU Draft |
| `account.certificate.issue` | Kinnita ja koosta tunnistus | Подтвердить и создать сертификат | Spec (ET); RU Draft |
| `account.certificate.issuing` | Koostan tunnistust… | Создаю сертификат… | Draft |
| `account.certificate.letters` | Kasuta nimes ainult tähti, tühikuid ja sidekriipse | Используйте в имени только буквы, пробелы и дефисы | Spec (ET); RU Draft |
| `account.certificate.length` | Nimi peab olema 2–80 tähemärki pikk | Имя должно быть длиной от 2 до 80 символов | Draft |
| `account.certificate.number` | Tunnistus nr. {number} | Сертификат № {number} | Spec (ET); RU Draft |
| `account.certificate.download` | Laadi tunnistus alla (PDF) | Скачать сертификат (PDF) | Spec (ET); RU Draft |
| `account.certificate.fixName` | Kui nimes on viga, kirjuta meile | Если в имени ошибка, напишите нам | Spec (ET); RU Draft |
| `account.certificate.cardLink` | Laadi tunnistus alla | Скачать сертификат | Spec (ET); RU Draft |
| `account.completionMail.completedCertificate` | Kinnita oma nimi ja laadi tunnistus alla: | Подтвердите своё имя и скачайте сертификат: | Spec (ET); RU Draft |

(In the code, the Russian strings write the no-break space after the one-letter preposition "в" as `\u00a0`: `в\u00a0сертификате`, `в\u00a0имени`. The other words keep a plain space.)

---

### Task 5: Admin settings and course text — the course editor's "Tunnistus" card, Seaded → "Tunnistus" with the signature, Maria's download

Spec §6 (the course editor's card, Seaded's card, the signature), §3 (the two course columns, the setting's keys), §4 (Maria's "Järgmine number" with the last issued number; a number at or below an issued one refused), §7 (the signature is white on black), D4. Rulings applied: the controller's update of 15.10 (the signature comes from Maria's Canva document as a PNG, light ink on transparency or dark ink on white: `inkSignature` handles both), the interface note above (the card's draft and Task 3's error codes), and this task's own decisions, below.

**Decisions (read before coding):**
- **Seaded's card is a form of its own, after the settings' form.** Seaded's page today is one form (`SettingsEditor`, its parts saved together through `saveSettingsForm`, with a sticky save bar). The certificate settings are not a part of it: they have their own server action (`saveCertificateSettingsAction`) and a "next number" rule the parts cannot express, and a form inside a form is invalid HTML. So the page renders `<CertificateSettings>` after `<SettingsEditor>` in the shell: its own `<section id="tunnistus">` card with its own `<form>`, its own button "Salvesta tunnistuse andmed" (secondary: the page's one primary button stays the save bar's "Salvesta") and its own status line (`[data-cert-status]`, never `[data-save-status]`, which the Seaded e2e reads). The card does not refresh the page: it keeps its own state, as Hindamine's actions do.
- **The signature is not an action but a route** (`POST|GET|DELETE /api/admin/allkiri`): a file is a multipart upload, and the preview `<img>` needs a GET. The browser makes the PNG (`src/lib/signature-ink.ts`); the server checks it again (PNG signature, at most 1 MB), stores it under `certificate/signature-<uuid>.png` with the media store's `put`, points the setting at it (`setSignatureKey`, which returns the old key) and only then removes the old object; a failed removal is logged by its label, never the key. The key never reaches the browser: the card knows only whether there is a signature, and its preview is `/api/admin/allkiri?v=<n>` (a new `n` after each upload, so the `<img>` loads the new one).
- **`ProtocolStagesEditor` gets `kind?: "stages" | "skills"`.** Reusing it for "Oskused tunnistusel"  needs its own title, row label, "add" text, limit (16 lines, `CERT_LIMITS.skills`) and its own data hooks: with the stages' hooks, an e-course's editor would have two `[data-protocol-stages]`, and `tests/e2e/admin-edit.spec.ts` (`page.locator("[data-protocol-stages] h3")`) would break. `kind="skills"` uses `[data-certificate-skills]`, `[data-certificate-skill]`, `[data-add-skill]`; the hint and the empty line come through the existing `hint` / `empty` props.
- **`inkSignature` knows two kinds of picture** (the controller's update). "light": more than 20 % of the pixels transparent (alpha < 16) and the other pixels' mean luminance > 160 — every pixel stays white with alpha = its alpha × luminance / 255. Otherwise "dark": each pixel's grey on white (a transparent part is paper) below the threshold 140 becomes white with an alpha from its darkness (full at half the threshold), the rest transparent. Either way: crop to the box of the pixels with alpha ≥ 64 (a speck of the paper's grain must not widen it) plus 4 px, at most 1200 px wide, PNG. The picture is read at most 2400 px on its longest side (twice the result: a phone photo of 4000 px is not read as 12 million pixels).
- **The course columns:** `CourseDraft` gains `certificateSkills: string[]` and `certificateVolume: string` (zod `.default([])` / `.default("")`, so an editor page loaded before the deploy still saves). Each line and the volume is cleaned as a heading is (`toStorable`, a line break becomes a space), trimmed, blank lines dropped; at most 16 lines of at most 120 characters, the volume at most 80 (`tooMany` / `tooLong` on `certificateSkills`, `tooLong` on `certificateVolume`). A contact course stores `[]` and `""`. `CourseFields` makes the two required, so the save cannot forget them.

**Files:**
- Modify: `app/src/domain/course-editor.ts` (`CourseDraft`, `newCourseDraft`, `StoredCourse`, `draftFromCourse`)
- Modify: `app/src/server/admin-content.ts` (imports, lines 1–13; `draftSchema`, lines 41–72; `saveCourseForm`, after the "Teadmiste test" block that ends at line 154, and the `fields` object, lines 187–210)
- Modify: `app/src/db/queries/admin.ts` (`CourseFields`, lines 117–118)
- Modify: `app/src/components/admin/ProtocolStagesEditor.tsx` (whole file below)
- Modify: `app/src/components/admin/CourseEditor.tsx` (imports, lines 8–24; after the "Teadmiste test" card, lines 321–330), `app/src/components/admin/CourseEditor.module.css` (one rule after `.cardTitle`, line 60)
- Modify: `app/src/lib/shrink-image.ts` (`Decoded` and `decode` exported)
- Create: `app/src/lib/signature-ink.ts`
- Create: `app/src/app/api/admin/allkiri/route.ts`, `app/src/app/api/admin/tunnistus/[id]/route.ts`
- Create: `app/src/server/actions/admin-certificates.ts`
- Create: `app/src/components/admin/CertificateSettings.tsx`, `app/src/components/admin/CertificateSettings.module.css`
- Modify: `app/src/app/admin/(panel)/seaded/page.tsx` (whole file below)
- Modify: `app/src/i18n/dict/admin.ts` (`courseEditor.sections`, `courseEditor.fields`; a new top-level `certificates` block after `clients`' closing `},` at line 670, before `// /admin/opilased/<id>/vaade` )
- Test: create `app/tests/unit/signature-ink.test.ts`, `app/tests/unit/certificate-settings-dom.test.ts`, `app/tests/unit/admin-certificates-action.test.ts`, `app/tests/db/admin-signature-route.test.ts`, `app/tests/db/admin-certificate-route.test.ts`, `app/tests/db/seaded-certificate-page.test.ts`; modify `app/tests/unit/protocol-stages-dom.test.ts` (whole file below), `app/tests/unit/admin-content.test.ts` (the "drafts" test), `app/tests/db/admin-content.test.ts` (a new `describe` at the end), `app/tests/unit/admin-guards.test.ts`, `app/tests/unit/colour-tokens.test.ts`, `app/tests/unit/old-safari.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 (`src/domain/certificate.ts`): `CERT_LIMITS = { nameMin: 2, nameMax: 80, skills: 16, skill: 120, volume: 80, place: 60, registryCode: 20, practicalLine: 200, trainerName: 60 }`; `type CertificateSettings = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: number; nextSeq: number; signatureKey: string | null }`; `CERT_DEFAULTS`; `tallinnYear(d: Date): number`; `certificateFileName(year: number, seq: number): string`. From `src/db/schema.ts`: `certificates` (columns `accessId, number, year, seq, name, courseTitle, skills, volume, practicalLine, place, registryCode, issuedAt, reissuedAt`), `type Certificate`, `courses.certificateSkills: string[]` (default `[]`), `courses.certificateVolume: string` (default `""`).
  - Task 2/3 (`src/server/certificates.ts`): `getCertificateSettings(db: Db, now: Date): Promise<CertificateSettings>`; `saveCertificateSettings(db: Db, raw: unknown, now: Date): Promise<{ ok: true; settings: CertificateSettings } | { ok: false; fields: Record<string, string> }>` (raw as the interface note; the codes `type CertificateFieldError = "required" | "tooLong" | "invalid" | "taken"`, exported by Task 3; it takes the number lock before rewriting the setting); `setSignatureKey(db: Db, key: string | null, now: Date): Promise<string | null>` (returns the previous key); `lastIssued(db: Db, year: number): Promise<string | null>`; `certificateForAdmin(db: Db, certificateId: number): Promise<(Certificate & { revoked: boolean }) | null>`; `certificatePdf(db: Db, store: FileStore | null, cert: Certificate, now: Date): Promise<Uint8Array>`.
  - Existing: `withAdmin`, `adminAction` (`src/server/auth.ts`); `mediaStore()` (`src/server/media-store.ts`); `hasImageSignature`, `type FileStore` (`src/server/media.ts`); `privateFileAnswer(store, key, { contentType, headers })` (`src/server/private-file.ts`); `parseRowId` (`src/lib/row-id.ts`); `fitWithin`, `MAX_SOURCE_BYTES` (`src/lib/shrink-image.ts`); `logFailure`, `logNote` (`src/server/log.ts`).
- Produces:
  - `src/domain/course-editor.ts`: `CourseDraft.certificateSkills: string[]`, `CourseDraft.certificateVolume: string`; `StoredCourse` accepts optional `certificateSkills?: string[]`, `certificateVolume?: string`.
  - `src/db/queries/admin.ts`: `CourseFields = Omit<CourseInput, "id" | "sort"> & { test: CourseTestFields | null; certificateSkills: string[]; certificateVolume: string }`.
  - `src/components/admin/ProtocolStagesEditor.tsx`: prop `kind?: "stages" | "skills"` (**added**); hooks `[data-certificate-skills]`, `[data-certificate-skill="<i>"]`, `[data-add-skill]` (**added**).
  - The course editor's card `[data-certificate-card]`; its volume input `[data-field="certificateVolume"]`.
  - `src/lib/shrink-image.ts`: `export type Decoded`, `export async function decode(file: Blob): Promise<Decoded>` (**added exports**).
  - `src/lib/signature-ink.ts`: `export async function inkSignature(file: File, opts?: { maxWidth?: number; threshold?: number }): Promise<Blob>` (contract); **added**: `SIGNATURE_MAX_BYTES = 1024 * 1024`, `INK = { maxWidth: 1200, threshold: 140, pad: 4 }`, `class InkError extends Error { problem: "decode" | "empty" }`, `type InkMode = "dark" | "light"`, `inkAlpha(gray: number, threshold: number): number`, `inkMode(data: Uint8ClampedArray): InkMode`, `type InkBox = { left: number; top: number; right: number; bottom: number }`, `whiten(data: Uint8ClampedArray, width: number, height: number, mode: InkMode, threshold: number): InkBox | null`.
  - `POST /api/admin/allkiri` (multipart `file`: 200 `{ ok: true }`; 400 `missing` | `empty`; 413 `size`; 415 `type` | `content`; 503 `storage`; 500 `server`), `GET /api/admin/allkiri` (the image: local bytes inline as `image/png`, or a 302 to a signed R2 address; 404 `notFound`), `DELETE /api/admin/allkiri` (200 `{ ok: true }`); all `maxDuration = 30`.
  - `GET /api/admin/tunnistus/<id>`: 200 `application/pdf`, `content-disposition: attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`, `cache-control: private, no-store`, `x-content-type-options: nosniff`; 404 `notFound`; 500 `server`; `maxDuration = 30`.
  - `src/server/actions/admin-certificates.ts`: `saveCertificateSettingsAction = adminAction(async (_admin, raw: unknown) => …)` answering `{ ok: true; settings: Omit<CertificateSettings, "signatureKey">; last: string | null } | { ok: false; fields: Record<string, string> } | { ok: false; error: "server" }`.
  - `src/components/admin/CertificateSettings.tsx`: `export type CertificateSettingsInitial = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: number; nextSeq: number; last: string | null; hasSignature: boolean }`; `export function CertificateSettings({ initial }: { initial: CertificateSettingsInitial })`. Hooks: `[data-certificate-settings]` (the card, `id="tunnistus"`), `[data-cert-form]`, `[data-cert-place]`, `[data-cert-registry]`, `[data-cert-practical]`, `[data-cert-trainer]`, `[data-cert-next-year]`, `[data-cert-next-seq]`, `[data-cert-last]`, `[data-cert-save]`, `[data-cert-status]`, `[data-cert-signature]` (the black preview: an `<img>` or the "no signature" line), `[data-cert-signature-file]`, `[data-cert-signature-remove]`, **added**: `[data-cert-signature-confirm]` (the removal's question; its first button is "Jah, eemalda"), `[data-cert-signature-status]`.
  - Dictionary: `adminEt.courseEditor.sections.certificate`, `adminEt.courseEditor.fields.certificate*`, `adminEt.certificates.settings.*` (Task 6 adds `certificates.drawer`, `.reissue`, `.register`).

- [ ] **Step 1: Write the failing signature test** — create `tests/unit/signature-ink.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INK, InkError, inkAlpha, inkMode, inkSignature, SIGNATURE_MAX_BYTES, whiten } from "@/lib/signature-ink";

// lib/signature-ink.ts (phase 3d, spec §6, D4; the controller's update of 15.10: two kinds of picture) in a browser-like document. The pure
// parts — a grey's alpha, which kind a picture is, the white ink and its box — are checked on pixel lists; inkSignature with the decoder and
// the canvases as stand-ins that record what is asked of them (happy-dom has no canvas), so the crop, the size and the PNG are seen exactly.
// What a real browser's canvas makes of a real picture is the end-to-end run's (tests/e2e/certificate.spec.ts).

type Rgba = [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** The RGBA pixels of a width × height picture, painted by `paint`. */
function pixels(width: number, height: number, paint: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return data;
}
/** One pixel of `data` (a picture `width` wide). */
const at = (data: Uint8ClampedArray, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
/** `ink` inside x0…x1 × y0…y1 (inclusive), `outside` elsewhere. */
const block =
  (x0: number, x1: number, y0: number, y1: number, ink: Rgba, outside: Rgba) =>
  (x: number, y: number): Rgba =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1 ? ink : outside;

describe("the pure parts", () => {
  test("a grey's alpha: none at the threshold and lighter, full at half of it and darker, in proportion between", () => {
    expect([inkAlpha(255, 140), inkAlpha(140, 140), inkAlpha(139, 140)]).toEqual([0, 0, 4]);
    expect([inkAlpha(70, 140), inkAlpha(0, 140), inkAlpha(100, 140), inkAlpha(120, 140)]).toEqual([255, 255, 146, 73]);
  });

  test("which kind a picture is: light ink on transparency (more than 20 % transparent, the rest light on average), else dark ink", () => {
    // Maria's signature exported from Canva: white ink on a transparent background
    expect(inkMode(pixels(10, 10, block(2, 7, 4, 5, WHITE, CLEAR)))).toBe("light");
    // a scan or a photo: dark ink on white paper, nothing transparent
    expect(inkMode(pixels(10, 10, block(2, 7, 4, 5, BLACK, WHITE)))).toBe("dark");
    // dark ink on a transparent background: transparent enough, but its ink is dark
    expect(inkMode(pixels(10, 10, block(2, 7, 4, 5, BLACK, CLEAR)))).toBe("dark");
    // exactly 20 % transparent is not more than 20 %
    expect(inkMode(pixels(10, 10, (_x, y) => (y < 2 ? CLEAR : WHITE)))).toBe("dark");
    expect(inkMode(pixels(10, 10, (_x, y) => (y < 3 ? CLEAR : WHITE)))).toBe("light");
    // nearly transparent counts as transparent (alpha under 16); light grey ink of luminance 150 is not light enough
    expect(inkMode(pixels(10, 10, block(2, 7, 4, 5, [255, 255, 255, 200], [0, 0, 0, 15])))).toBe("light");
    expect(inkMode(pixels(10, 10, block(2, 7, 4, 5, [150, 150, 150, 255], CLEAR)))).toBe("dark");
  });

  test("dark ink: every pixel white, its alpha from its grey on white (a transparent part is paper); the box holds the strokes, not a faint speck", () => {
    // 6 × 4: a stroke on row 1 (black at x 1, grey 100 at x 2), a faint grey 135 speck at (5, 3), a transparent black pixel at (0, 3)
    const paint = (x: number, y: number): Rgba =>
      y === 1 && x === 1 ? BLACK : y === 1 && x === 2 ? [100, 100, 100, 255] : x === 5 && y === 3 ? [135, 135, 135, 255] : x === 0 && y === 3 ? CLEAR : WHITE;
    const data = pixels(6, 4, paint);
    expect(whiten(data, 6, 4, "dark", INK.threshold)).toEqual({ left: 1, top: 1, right: 2, bottom: 1 });
    expect(at(data, 6, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(data, 6, 2, 1)).toEqual([255, 255, 255, 146]);
    expect(at(data, 6, 5, 3)).toEqual([255, 255, 255, 18]); // ink, but too faint to widen the box
    expect(at(data, 6, 0, 3)).toEqual([255, 255, 255, 0]); // transparent: paper
    expect(at(data, 6, 0, 0)).toEqual([255, 255, 255, 0]);
    // a lower threshold: grey 100 is paper now
    expect(whiten(pixels(6, 4, paint), 6, 4, "dark", 90)).toEqual({ left: 1, top: 1, right: 1, bottom: 1 });
    // nothing darker than the threshold: no box
    expect(whiten(pixels(6, 4, () => [200, 200, 200, 255]), 6, 4, "dark", INK.threshold)).toBeNull();
  });

  test("light ink: every pixel white, its own alpha times its luminance; the box holds what shows", () => {
    // 6 × 4 on transparency: white at (1, 1), half-transparent white at (2, 1), light grey 200 at (3, 2), a faint white (alpha 40) at (5, 3)
    const paint = (x: number, y: number): Rgba =>
      x === 1 && y === 1 ? WHITE : x === 2 && y === 1 ? [255, 255, 255, 128] : x === 3 && y === 2 ? [200, 200, 200, 255] : x === 5 && y === 3 ? [255, 255, 255, 40] : CLEAR;
    const data = pixels(6, 4, paint);
    expect(whiten(data, 6, 4, "light", INK.threshold)).toEqual({ left: 1, top: 1, right: 3, bottom: 2 });
    expect(at(data, 6, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(data, 6, 2, 1)).toEqual([255, 255, 255, 128]);
    expect(at(data, 6, 3, 2)).toEqual([255, 255, 255, 200]);
    expect(at(data, 6, 5, 3)).toEqual([255, 255, 255, 40]);
    expect(at(data, 6, 0, 0)).toEqual([255, 255, 255, 0]);
  });

  test("the limits: the server takes at most 1 MB; the result is at most 1200 px wide, ink below grey 140, 4 px around it", () => {
    expect(SIGNATURE_MAX_BYTES).toBe(1024 * 1024);
    expect(INK).toEqual({ maxWidth: 1200, threshold: 140, pad: 4 });
  });
});

describe("inkSignature", () => {
  /** A stand-in canvas: what is drawn on it, what is put back on it, and each encode (its size when asked, the type wanted). */
  type FakeCanvas = {
    width: number;
    height: number;
    draws: unknown[][];
    puts: Uint8ClampedArray[];
    encodes: { width: number; height: number; type: string }[];
    getContext: () => unknown;
    toBlob: (done: (blob: Blob | null) => void, type: string) => void;
  };
  let canvases: FakeCanvas[];
  let bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[];
  /** What the picture is, in the working canvas's pixels (getImageData paints it at the size asked). */
  let paint: (x: number, y: number) => Rgba;
  const realCreate = document.createElement.bind(document);

  function fakeCanvas(): FakeCanvas {
    const canvas: FakeCanvas = {
      width: 0,
      height: 0,
      draws: [],
      puts: [],
      encodes: [],
      getContext: () => context,
      toBlob(done, type) {
        canvas.encodes.push({ width: canvas.width, height: canvas.height, type });
        setTimeout(() => done(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type })), 0);
      },
    };
    const context = {
      imageSmoothingQuality: "low",
      drawImage: (...args: unknown[]) => void canvas.draws.push(args),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: pixels(w, h, paint), width: w, height: h }),
      putImageData: (image: { data: Uint8ClampedArray }) => void canvas.puts.push(new Uint8ClampedArray(image.data)),
    };
    canvases.push(canvas);
    return canvas;
  }
  /** An <img> that fails a moment after its address is set (the fallback decoder of a picture this browser cannot open). */
  function failingImg() {
    const img = {
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null as null | (() => void),
      onerror: null as null | (() => void),
      set src(_url: string) {
        setTimeout(() => img.onerror?.(), 0);
      },
    };
    return img;
  }
  /** createImageBitmap decoding every file as width × height. */
  function decodesAs(width: number, height: number) {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        const bitmap = { width, height, close: vi.fn() };
        bitmaps.push(bitmap);
        return bitmap;
      }),
    );
  }
  const scan = new File([new Uint8Array(16)], "allkiri.jpg", { type: "image/jpeg" });

  beforeEach(() => {
    canvases = [];
    bitmaps = [];
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) =>
      tag === "canvas" ? fakeCanvas() : tag === "img" ? failingImg() : realCreate(tag, options)) as typeof document.createElement);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:allkiri");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("dark ink on paper (a scan): read at its size, made white ink, cut to the ink with 4 px around it, encoded as PNG; the picture and the canvases are freed", async () => {
    decodesAs(30, 12);
    paint = block(10, 19, 2, 9, [30, 30, 60, 255], [240, 236, 228, 255]);
    const png = await inkSignature(scan);
    expect(png.type).toBe("image/png");
    const [work, out] = canvases;
    expect(work.draws[0]).toEqual([bitmaps[0], 0, 0, 30, 12]);
    expect(at(work.puts[0], 30, 10, 2)).toEqual([255, 255, 255, 255]); // ink
    expect(at(work.puts[0], 30, 0, 0)).toEqual([255, 255, 255, 0]); // paper
    // the box 10…19 × 2…9 with 4 px around it, inside the picture: 6…23 × 0…11
    expect(out.draws[0]).toEqual([work, 6, 0, 18, 12, 0, 0, 18, 12]);
    expect(out.encodes).toEqual([{ width: 18, height: 12, type: "image/png" }]);
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    expect([work.width, work.height, out.width, out.height]).toEqual([0, 0, 0, 0]);
  });

  test("light ink on transparency (Maria's signature exported from Canva as PNG): each pixel keeps its own alpha, scaled by its luminance", async () => {
    decodesAs(30, 12);
    const canva = new File([new Uint8Array(16)], "allkiri.png", { type: "image/png" });
    paint = (x, y) => (x >= 4 && x <= 25 && y >= 5 && y <= 6 ? (x === 4 ? [255, 255, 255, 128] : [250, 250, 250, 255]) : CLEAR);
    await inkSignature(canva);
    const [work, out] = canvases;
    expect(at(work.puts[0], 30, 10, 5)).toEqual([255, 255, 255, 250]);
    expect(at(work.puts[0], 30, 4, 5)).toEqual([255, 255, 255, 128]);
    expect(at(work.puts[0], 30, 0, 0)).toEqual([255, 255, 255, 0]);
    // the box 4…25 × 5…6 with 4 px around it: 0…29 × 1…10
    expect(out.draws[0]).toEqual([work, 0, 1, 30, 10, 0, 0, 30, 10]);
    expect(out.encodes[0]).toEqual({ width: 30, height: 10, type: "image/png" });
  });

  test("a wide picture: read at twice the widest result at most, and the crop made at most `maxWidth` wide (1200 by default)", async () => {
    decodesAs(40, 20);
    paint = block(2, 17, 2, 7, BLACK, WHITE);
    await inkSignature(scan, { maxWidth: 10 });
    expect(canvases[0].draws[0]).toEqual([bitmaps[0], 0, 0, 20, 10]);
    expect(canvases[1].draws[0]).toEqual([canvases[0], 0, 0, 20, 10, 0, 0, 10, 5]);

    // a phone photo of the paper, 4000 × 1000: read at 2400 × 600, the ink 100…2299 × 100…499, cut at 96…2303 × 96…503, 1200 px wide
    canvases = [];
    decodesAs(4000, 1000);
    paint = block(100, 2299, 100, 499, BLACK, WHITE);
    await inkSignature(scan);
    expect(canvases[0].draws[0]).toEqual([bitmaps[1], 0, 0, 2400, 600]);
    expect(canvases[1].draws[0]).toEqual([canvases[0], 96, 96, 2208, 408, 0, 0, 1200, 222]);
  });

  test("the threshold is the caller's: grey 145 is paper at the default 140 (no ink: InkError 'empty', nothing encoded) and ink at 200", async () => {
    decodesAs(10, 10);
    paint = block(3, 6, 3, 6, [145, 145, 145, 255], WHITE);
    const empty = await inkSignature(scan).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(InkError);
    expect(empty).toMatchObject({ problem: "empty" });
    expect(canvases.flatMap((c) => c.encodes)).toEqual([]);
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    canvases = [];
    await inkSignature(scan, { threshold: 200 });
    expect(canvases[1].draws[0]).toEqual([canvases[0], 0, 0, 10, 10, 0, 0, 10, 10]);
  });

  test("a picture this browser cannot open (createImageBitmap and the <img> both fail): InkError 'decode', no canvas made", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("unsupported");
      }),
    );
    const heic = new File([new Uint8Array(16)], "allkiri.heic", { type: "image/heic" });
    const e = await inkSignature(heic).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InkError);
    expect(e).toMatchObject({ problem: "decode" });
    expect(canvases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `cd app && npx vitest run tests/unit/signature-ink.test.ts` fails to import: `Failed to resolve import "@/lib/signature-ink"` (the file does not exist yet).

- [ ] **Step 3: Export the decoder** — in `src/lib/shrink-image.ts`, the lines

```ts
/** A decoded image, upright: what the canvas draws from, its size, and what to free afterwards. */
type Decoded = { source: CanvasImageSource; width: number; height: number; close(): void };
```

become

```ts
/** A decoded image, upright: what the canvas draws from, its size, and what to free afterwards (lib/signature-ink.ts uses it too). */
export type Decoded = { source: CanvasImageSource; width: number; height: number; close(): void };
```

and the lines

```ts
/** The image upright (the EXIF orientation applied): createImageBitmap where it reads the file with its options, else an <img>. */
async function decode(file: Blob): Promise<Decoded> {
```

become

```ts
/**
 * The image upright (the EXIF orientation applied): createImageBitmap where it reads the file with its options, else an <img>. ShrinkError
 * "decode" when this browser cannot open it. Also the signature's decoder (lib/signature-ink.ts, phase 3d).
 */
export async function decode(file: Blob): Promise<Decoded> {
```

- [ ] **Step 4: Write the signature's conversion** — create `src/lib/signature-ink.ts`:

```ts
import { decode, fitWithin } from "./shrink-image";

// Maria's signature for the e-course certificate (phase 3d, spec §6, D4), made ready in the browser: the certificate is black (spec §7), so
// its signature is white ink on a transparent picture. Two kinds of picture come in (the controller's update of 15.10):
// - "light": a PNG that is light ink on transparency already — Maria's signature exported from her Canva certificate document. It is one
//   when more than 20 % of its pixels are transparent (alpha under 16) and its other pixels are light (mean luminance above 160). Each pixel
//   stays white, with its own alpha scaled by its luminance.
// - "dark": anything else — a photo or a scan of dark ink on light paper, or a PNG of dark ink on white or on transparency. Each pixel's grey
//   on white (a transparent part counts as paper) decides: darker than the threshold (140) is ink, white with an alpha that grows with its
//   darkness (full at half the threshold and below, so a stroke's soft edge stays soft); lighter is paper, transparent.
// Either way the picture is cut to the ink's box with a 4 px margin (the box counts the pixels of alpha 64 and up: a speck of the paper's
// grain is not a stroke), made at most 1200 px wide and encoded as PNG (a canvas holds pixels only: no metadata). The picture is read at most
// twice that size on its longest side: a phone photo of 4000 px is not read as 12 million pixels. The server checks the PNG again
// (api/admin/allkiri). Browser only (document, canvas); no lookbehind anywhere (tests/unit/old-safari.test.ts).

/** The largest PNG the server takes (api/admin/allkiri); a signature of 1200 px is far below it. */
export const SIGNATURE_MAX_BYTES = 1024 * 1024;
/** maxWidth: the widest result; threshold: the grey (0–255) under which a pixel of a "dark" picture is ink; pad: the margin around the ink. */
export const INK = { maxWidth: 1200, threshold: 140, pad: 4 } as const;
/** A pixel counts toward the ink's box from this alpha on. */
const BOX_ALPHA = 64;
/** A "light" picture: more than `share` of its pixels under `alpha` (transparent), and its other pixels' mean luminance above `luminance`. */
const LIGHT = { share: 0.2, alpha: 16, luminance: 160 } as const;

export type InkProblem = "decode" | "empty";

/** decode: this browser cannot open the picture (a HEIC in Chrome); empty: no ink on it. */
export class InkError extends Error {
  constructor(readonly problem: InkProblem) {
    super(problem);
    this.name = "InkError";
  }
}

export type InkMode = "dark" | "light";
/** The ink's box, in pixels, both ends included. */
export type InkBox = { left: number; top: number; right: number; bottom: number };

/** The luminance (0–255) of the pixel at byte `i` of RGBA data. */
const luminance = (data: Uint8ClampedArray, i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/** A "dark" picture's pixel of grey `gray` (0 black … 255 white): alpha 0 at the threshold and lighter, 255 at half of it and darker, linear between. */
export function inkAlpha(gray: number, threshold: number): number {
  if (gray >= threshold) return 0;
  return Math.min(255, Math.round((510 * (threshold - gray)) / threshold));
}

/** Which kind of picture RGBA `data` is (see the top of this file). */
export function inkMode(data: Uint8ClampedArray): InkMode {
  let transparent = 0;
  let opaque = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < LIGHT.alpha) transparent++;
    else {
      opaque++;
      sum += luminance(data, i);
    }
  }
  const all = data.length / 4;
  return all > 0 && transparent > all * LIGHT.share && opaque > 0 && sum / opaque > LIGHT.luminance ? "light" : "dark";
}

/** RGBA `data` made white ink in place, as `mode` says; the box of its pixels of alpha BOX_ALPHA and up, or null when there are none. */
export function whiten(data: Uint8ClampedArray, width: number, height: number, mode: InkMode, threshold: number): InkBox | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = luminance(data, i);
      const alpha = mode === "light" ? Math.round((data[i + 3] * lum) / 255) : inkAlpha(255 - (255 - lum) * (data[i + 3] / 255), threshold);
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alpha;
      if (alpha >= BOX_ALPHA) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  return right < 0 ? null : { left, top, right, bottom };
}

/**
 * The signature's PNG, ready to send (see the top of this file). InkError "decode" when this browser cannot open the picture, "empty" when
 * there is no ink on it. `maxWidth` (default 1200) and `threshold` (default 140) are for the tests.
 */
export async function inkSignature(file: File, opts: { maxWidth?: number; threshold?: number } = {}): Promise<Blob> {
  const maxWidth = opts.maxWidth ?? INK.maxWidth;
  const threshold = opts.threshold ?? INK.threshold;
  const image = await decode(file).catch(() => {
    throw new InkError("decode");
  });
  const work = document.createElement("canvas");
  const out = document.createElement("canvas");
  try {
    const size = fitWithin(image.width, image.height, 2 * maxWidth);
    work.width = size.width;
    work.height = size.height;
    const ctx = work.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new InkError("decode");
    ctx.drawImage(image.source, 0, 0, size.width, size.height);
    const picture = ctx.getImageData(0, 0, size.width, size.height);
    const box = whiten(picture.data, size.width, size.height, inkMode(picture.data), threshold);
    if (!box) throw new InkError("empty");
    ctx.putImageData(picture, 0, 0);
    const left = Math.max(0, box.left - INK.pad);
    const top = Math.max(0, box.top - INK.pad);
    const width = Math.min(size.width, box.right + 1 + INK.pad) - left;
    const height = Math.min(size.height, box.bottom + 1 + INK.pad) - top;
    const scale = Math.min(1, maxWidth / width);
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    const o = out.getContext("2d");
    if (!o) throw new InkError("decode");
    o.imageSmoothingQuality = "high";
    o.drawImage(work, left, top, width, height, 0, 0, out.width, out.height);
    const png = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
    if (!png || png.type !== "image/png") throw new InkError("decode");
    return png;
  } finally {
    image.close();
    // the canvases' memory back at once: iOS Safari has a small budget for all canvases together
    work.width = 0;
    work.height = 0;
    out.width = 0;
    out.height = 0;
  }
}
```

- [ ] **Step 5: Run it — expect PASS.** `cd app && npx vitest run tests/unit/signature-ink.test.ts tests/unit/shrink-image.test.ts` — both green (the shrink tests are unchanged: only two exports were added).

- [ ] **Step 6: Write the failing course-editor tests.**

  1. `tests/unit/admin-content.test.ts`, in the test "a stored course becomes a draft with euro amounts as typed and empty optional texts", after the line `expect(newCourseDraft()).toMatchObject({ id: null, version: null, type: "contact", published: false, isSample: false, badge: null, protocolStages: [], test: { questions: [], passPercent: "80", tries: "3" } });` add:

```ts
    // "Tunnistus" (phase 3d, spec §6): none stored (or a caller without them) is none; stored lines as they are, anything that is not a line left out
    expect([d.certificateSkills, d.certificateVolume]).toEqual([[], ""]);
    expect(draftFromCourse({ ...stored, certificateSkills: ["Kulmude kuju", 7 as unknown as string], certificateVolume: "10 akadeemilist tundi" })).toMatchObject({
      certificateSkills: ["Kulmude kuju"],
      certificateVolume: "10 akadeemilist tundi",
    });
    expect(newCourseDraft()).toMatchObject({ certificateSkills: [], certificateVolume: "" });
```

  2. `tests/db/admin-content.test.ts`, at the end of the file, add:

```ts
describe("saveCourseForm: 'Tunnistus' (phase 3d, spec §6)", () => {
  test("an e-course stores its certificate lines trimmed, without blank ones, in order, and its volume; the editor gets them back", async () => {
    const e = await load(online.id);
    expect([e.certificateSkills, e.certificateVolume]).toEqual([[], ""]);
    expect(await save({ ...e, certificateSkills: [" Kulmude kuju ja proportsioonid ", "", "Värvi valik"], certificateVolume: " 10 akadeemilist tundi " })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju ja proportsioonid", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
    expect(await load(online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju ja proportsioonid", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
  });

  test("more than 16 lines, a line over 120 characters or a volume over 80 is refused on its field; nothing is saved", async () => {
    const e = await load(online.id);
    expect(fieldsOf(await save({ ...e, certificateSkills: Array.from({ length: 17 }, (_, i) => `Oskus ${i + 1}`) }))).toEqual({ certificateSkills: "tooMany" });
    expect(fieldsOf(await save({ ...e, certificateSkills: ["x".repeat(121)] }))).toEqual({ certificateSkills: "tooLong" });
    expect(fieldsOf(await save({ ...e, certificateVolume: "x".repeat(81) }))).toEqual({ certificateVolume: "tooLong" });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
    expect(await save({ ...e, certificateSkills: Array.from({ length: 16 }, () => "x".repeat(120)), certificateVolume: "x".repeat(80) })).toMatchObject({ ok: true });
  });

  test("a contact course has no certificate: a draft's lines and volume are not stored, and switching an e-course to contact empties them", async () => {
    expect(await save({ ...(await load(contact.id)), certificateSkills: ["Kulmude kuju"], certificateVolume: "6 ak" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, contact.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
    expect(await save({ ...(await load(online.id)), certificateSkills: ["Kulmude kuju"], certificateVolume: "10 akadeemilist tundi" })).toMatchObject({ ok: true });
    expect(await save({ ...(await load(online.id)), type: "contact", priceGroup: "100" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
  });

  test("a draft without them (an editor page opened before the deploy) still saves, with none", async () => {
    const older: Partial<CourseDraft> = { ...(await load(online.id)) };
    delete older.certificateSkills;
    delete older.certificateVolume;
    expect(await saveCourseForm(db, form({ data: JSON.stringify(older) }))).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
  });

  test("a pasted line is cleaned, not refused (control characters and NUL go, a line break is a space); a line blank once cleaned is dropped", async () => {
    const e = await load(online.id);
    expect(await save({ ...e, certificateSkills: ["Kulmude\u0000 kuju", "Värvi\r\nvalik", "\u0000 \u0001"], certificateVolume: "10\u000bakadeemilist tundi" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
  });
});
```

  3. Replace `tests/unit/protocol-stages-dom.test.ts` with:

```ts
// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ProtocolStagesEditor } from "@/components/admin/ProtocolStagesEditor";

// "Protokolli punktid" in the course editor (phase protocols, spec §3): one plain field per heading, in order, with ↑ / ↓ / ×, "Lisa punkt",
// at most 30 (the button says so then), each field at most 120 characters. And the same editor for the e-course certificate's lines (phase
// 3d, spec §6: kind "skills"): its own title, labels, limit (16) and data hooks, so an e-course's editor tells its two lists apart.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { kind?: "stages" | "skills"; hint?: string; empty?: string };

let container: HTMLDivElement;
let root: Root;
let current: string[] = [];
function Harness({ initial, kind, hint, empty }: { initial: string[] } & Opts) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    current = items; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [items]);
  return createElement(ProtocolStagesEditor, { items, onChange: setItems, kind, hint, empty });
}
// a new key for each list: a new editor, as the course editor's reload gives one
const render = async (initial: string[], opts: Opts = {}) =>
  act(async () => root.render(createElement(Harness, { key: `${opts.kind ?? "stages"}:${initial.join("|")}`, initial, ...opts })));
const fields = (hook = "data-protocol-stage") => [...container.querySelectorAll<HTMLInputElement>(`[${hook}]`)];
const click = async (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("add, type, move and remove; the new field takes the focus; each field is labelled and takes at most 120 characters", async () => {
  await render(["Ettevalmistus"]);
  await click(container.querySelector("[data-add-stage]"));
  expect(fields()).toHaveLength(2);
  expect(document.activeElement).toBe(fields()[1]);
  await type(fields()[1], "Värvimine");
  expect(current).toEqual(["Ettevalmistus", "Värvimine"]);
  expect(fields()[1].maxLength).toBe(120);
  expect(container.querySelector(`label[for="${fields()[1].id}"]`)?.textContent).toBe("Punkt 2");
  await click(container.querySelector('[aria-label="Liiguta rida 2 üles"]'));
  expect(current).toEqual(["Värvimine", "Ettevalmistus"]);
  await click(container.querySelector('[aria-label="Eemalda rida 1"]'));
  expect(current).toEqual(["Ettevalmistus"]);
});

test("none yet says what the protocol has then; at 30 'Lisa punkt' adds nothing and says so", async () => {
  await render([]);
  expect(container.textContent).toContain("Punkte veel pole");
  await render(Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`));
  const add = container.querySelector("[data-add-stage]")!;
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await click(add);
  expect(current).toHaveLength(30);
  expect(container.textContent).toContain("Rohkem kui 30 punkti ei saa lisada.");
});

test("the certificate's lines (kind 'skills'): their own title, labels and hooks, the hint and the empty line given; at 16 'Lisa rida' adds nothing and says so", async () => {
  await render([], { kind: "skills", hint: "Tühjana kasutatakse „Mida õpid“ ridu", empty: "Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read." });
  expect(container.querySelector("[data-protocol-stages]")).toBeNull();
  expect(container.querySelector("[data-add-stage]")).toBeNull();
  expect(container.querySelector("[data-certificate-skills] h3")!.textContent).toBe("Oskused tunnistusel");
  expect(container.textContent).toContain("Tühjana kasutatakse „Mida õpid“ ridu");
  expect(container.textContent).toContain("Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read.");
  const add = container.querySelector("[data-add-skill]")!;
  expect(add.textContent).toBe("+ Lisa rida");
  await click(add);
  const [first] = fields("data-certificate-skill");
  expect(first.getAttribute("data-certificate-skill")).toBe("0");
  expect(document.activeElement).toBe(first);
  expect(first.maxLength).toBe(120);
  expect(container.querySelector(`label[for="${first.id}"]`)?.textContent).toBe("Rida 1");
  await type(first, "Kulmude kuju");
  expect(current).toEqual(["Kulmude kuju"]);

  await render(Array.from({ length: 16 }, (_, i) => `Oskus ${i + 1}`), { kind: "skills" });
  const full = container.querySelector("[data-add-skill]")!;
  expect(full.getAttribute("aria-disabled")).toBe("true");
  await click(full);
  expect(current).toHaveLength(16);
  expect(container.textContent).toContain("Rohkem kui 16 rida ei saa lisada.");
});
```

- [ ] **Step 7: Run them — expect FAIL.** `cd app && npx vitest run tests/unit/admin-content.test.ts tests/db/admin-content.test.ts tests/unit/protocol-stages-dom.test.ts`: the drafts have no `certificateSkills` (`expected undefined to deeply equal []`), the saves store nothing (`certificateSkills: []` where the lines were expected; the 17 lines are not refused), and the skills test finds no `[data-certificate-skills]` (`Cannot read properties of null`). The first two protocol-stages tests still pass.

- [ ] **Step 8: The draft** (`src/domain/course-editor.ts`).

  1. In `CourseDraft`, after the `test: TestDraft;` member add:

```ts
  /**
   * "Tunnistus" (phase 3d, spec §6): an e-course certificate's competency lines (plain Estonian text, at most 16 of at most 120 characters;
   * none: the course's "Õpiväljundid" are printed, domain/certificate.ts certificateSkills) and its volume ("10 akadeemilist tundi"; empty: left
   * out of the PDF). A contact course has none.
   */
  certificateSkills: string[];
  certificateVolume: string;
```

  2. In `newCourseDraft()`, after `test: emptyTestDraft(),` add:

```ts
    certificateSkills: [],
    certificateVolume: "",
```

  3. In `StoredCourse`, after the `test?: …` member add:

```ts
  /** "Tunnistus" (phase 3d); absent where a caller has none to give (none then). */
  certificateSkills?: string[];
  certificateVolume?: string;
```

  4. In `draftFromCourse`, after the `test: …` line add:

```ts
    // jsonb read defensively: only the lines that are text
    certificateSkills: (c.certificateSkills ?? []).filter((s): s is string => typeof s === "string"),
    certificateVolume: c.certificateVolume ?? "",
```

- [ ] **Step 9: The save** (`src/server/admin-content.ts`, `src/db/queries/admin.ts`).

  1. `src/db/queries/admin.ts`: the lines

```ts
/** The course fields the editor writes (everything but id, sort and updatedAt), and the e-course's test (null: none, its row is deleted). */
export type CourseFields = Omit<CourseInput, "id" | "sort"> & { test: CourseTestFields | null };
```

  become

```ts
/**
 * The course fields the editor writes (everything but id, sort and updatedAt), and the e-course's test (null: none, its row is deleted). The
 * certificate's lines and volume (phase 3d) are required here although the columns have defaults: every save writes them (a contact course
 * `[]` and `""`), so a save that forgot them could not leave an old e-course's lines behind.
 */
export type CourseFields = Omit<CourseInput, "id" | "sort"> & { test: CourseTestFields | null; certificateSkills: string[]; certificateVolume: string };
```

  2. `src/server/admin-content.ts`: after `import { tallinnInstant } from "@/domain/calendar";` add `import { CERT_LIMITS } from "@/domain/certificate";`.

  3. In `draftSchema`, after the `test: z…default(emptyTestDraft),` member add:

```ts
  // "Tunnistus" (phase 3d): loose here, the real limits after (with field errors); the defaults: an editor page loaded before the deploy posts neither
  certificateSkills: z.array(z.string().max(2000)).max(200).default([]),
  certificateVolume: z.string().max(2000).default(""),
```

  4. In `saveCourseForm`, after the closing `}` of the `if (online) { … }` block of "Teadmiste test" (the line before `// a published course must be buyable / bookable`) add:

```ts
  // "Tunnistus" (phase 3d, spec §6): an e-course's certificate lines and volume, each cleaned as a heading is (one line), trimmed, blank lines
  // dropped; at most 16 lines of at most 120 characters, the volume at most 80. A contact course has no certificate: it stores none.
  let certificateSkills: string[] = [];
  let certificateVolume = "";
  if (online) {
    const lines = d.certificateSkills.map((s) => heading(s).trim()).filter(Boolean);
    if (lines.length > CERT_LIMITS.skills) c.fail("certificateSkills", "tooMany");
    else if (lines.some((s) => s.length > CERT_LIMITS.skill)) c.fail("certificateSkills", "tooLong");
    else certificateSkills = lines;
    certificateVolume = c.plain("certificateVolume", heading(d.certificateVolume), CERT_LIMITS.volume);
  }
```

  5. In the `fields: CourseFields` object, after `test,` add:

```ts
    certificateSkills,
    certificateVolume,
```

  6. The doc comment of `saveCourseForm`: the sentence `"Teadmiste test" is an e-course's (course_tests, R1); a contact course's row is deleted.` becomes `"Teadmiste test" is an e-course's (course_tests, R1); a contact course's row is deleted. So is "Tunnistus" (phase 3d): a contact course stores no lines and no volume.`

- [ ] **Step 10: The list editor's second kind** — replace `src/components/admin/ProtocolStagesEditor.tsx` with:

```tsx
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import { CERT_LIMITS } from "@/domain/certificate";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

let rowCount = 0;
const newKey = () => `stage-${++rowCount}`;

/**
 * "Protokolli punktid": a contact course's stage headings for the course day's protocols (phase protocols, spec §3), or an e-course's practical
 * points, to each of which the student adds 1–3 photos (e-course completion, spec §5.1: `hint` and `empty` give the e-course's texts). In the
 * language Maria writes in (one plain field each, no translation), in order: add, remove, ↑ / ↓; at most 30, each at most 120 characters. Saved
 * with the course ("Salvesta"); blank rows are dropped then. A change reaches only protocols not created yet (the hint says so). As ListEditor:
 * the arrows are aria-disabled at the ends, after adding a row its field gets the focus, after removing one the next row's field (or "Lisa punkt").
 * `kind` "skills": the same editor for the e-course certificate's lines ("Oskused tunnistusel", phase 3d, spec §6), with their own title, row
 * label, limit (16 lines of 120 characters, CERT_LIMITS) and data hooks, so an e-course's editor tells its two lists apart.
 */
export function ProtocolStagesEditor({
  items,
  onChange,
  error,
  hint,
  empty,
  kind = "stages",
}: {
  items: string[];
  onChange: (items: string[]) => void;
  error?: string;
  /** The hint under the title (default: the contact course's). */
  hint?: string;
  /** The line shown while there are none (default: the contact course's). */
  empty?: string;
  /** stages (default): "Protokolli punktid"; skills: the certificate's lines (phase 3d). */
  kind?: "stages" | "skills";
}) {
  const t = adminEt.courseEditor;
  const l = adminEt.list;
  const skills = kind === "skills";
  const words = skills
    ? { title: t.fields.certificateSkills, item: t.fields.certificateSkill, add: t.fields.certificateSkillsAdd, full: t.fields.certificateSkillsFull }
    : { title: t.sections.protocolStages, item: t.fields.protocolStage, add: t.fields.protocolStagesAdd, full: t.fields.protocolStagesFull };
  const most = skills ? CERT_LIMITS.skills : PROTOCOL_LIMITS.stages;
  const longest = skills ? CERT_LIMITS.skill : PROTOCOL_LIMITS.title;
  const uid = useId();
  const [keys, setKeys] = useState<string[]>(() => items.map(newKey));
  // the list was replaced from outside (the editor reloads the saved course): new rows, new keys
  if (keys.length !== items.length) setKeys(items.map(newKey));
  const focus = useRef<number | "add" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") addBtn.current?.focus();
    else root.current?.querySelector<HTMLInputElement>(`[data-row="${target}"] input`)?.focus();
  });

  const set = (list: string[], k: string[]) => {
    setKeys(k);
    onChange(list);
  };
  const full = items.length >= most;
  const add = () => {
    if (full) return;
    set([...items, ""], [...keys, newKey()]);
    focus.current = items.length;
  };
  const remove = (i: number) => {
    set(items.filter((_, j) => j !== i), keys.filter((_, j) => j !== i));
    focus.current = items.length > 1 ? Math.min(i, items.length - 2) : "add";
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    set(moveItem(items, i, j), moveItem(keys, i, j));
  };

  return (
    <div
      ref={root}
      className={styles.list}
      {...(skills ? { "data-certificate-skills": "" } : { "data-protocol-stages": "" })}
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={error ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {words.title}
        </h3>
      </div>
      <p id={`${uid}-hint`} className={ui.hint}>
        {hint ?? t.fields.protocolStagesHint}
      </p>
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{empty ?? t.fields.protocolStagesEmpty}</p>
      ) : (
        <ol className={styles.rows}>
          {items.map((item, i) => {
            const n = i + 1;
            const id = `${uid}-${i}`;
            return (
              <li key={keys[i] ?? i} className={styles.item} data-row={i}>
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div>
                  <label htmlFor={id} className={ui.sr}>
                    {`${words.item} ${n}`}
                  </label>
                  <input
                    id={id}
                    className={ui.input}
                    type="text"
                    value={item}
                    maxLength={longest}
                    autoComplete="off"
                    onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                    {...(skills ? { "data-certificate-skill": i } : { "data-protocol-stage": i })}
                  />
                </div>
                <span className={styles.tools}>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.down, { n })} aria-disabled={i === items.length - 1 || undefined} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && (
        <p id={`${uid}-error`} className={ui.error}>
          {error}
        </p>
      )}
      <button
        ref={addBtn}
        type="button"
        className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addBtn}`}
        aria-disabled={full || undefined}
        onClick={add}
        {...(skills ? { "data-add-skill": "" } : { "data-add-stage": "" })}
      >
        + {words.add}
      </button>
      {full && <p className={ui.hint}>{words.full}</p>}
    </div>
  );
}
```

- [ ] **Step 11: The course editor's card.**

  1. `src/components/admin/CourseEditor.tsx`: after `import type { CourseWithImages } from "@/db/queries/public";` add `import { CERT_LIMITS } from "@/domain/certificate";`.

  2. After the "Teadmiste test" card — the block that ends

```tsx
                errors={{ test: err("test"), testPassPercent: err("testPassPercent"), testTries: err("testTries"), at: state && !state.ok ? state.at : undefined }}
              />
            </section>
          )}
```

  — add:

```tsx

          {/* "Tunnistus" (phase 3d, spec §6): an e-course certificate's lines (none: its "Õpiväljundid" are printed) and its volume, saved with the course */}
          {online && (
            <section className={ui.card} aria-labelledby={`${uid}-certificate`} data-certificate-card="">
              <h2 id={`${uid}-certificate`} className={`${ui.h2} ${styles.cardTitle}`}>
                {t.sections.certificate}
              </h2>
              <div className={styles.certificate}>
                <p className={ui.muted}>{f.certificateLead}</p>
                <ProtocolStagesEditor
                  kind="skills"
                  items={draft.certificateSkills}
                  onChange={(v) => set("certificateSkills", v)}
                  error={err("certificateSkills")}
                  hint={f.certificateSkillsHint}
                  empty={f.certificateSkillsEmpty}
                />
                {plain("certificateVolume", f.certificateVolume, { hint: f.certificateVolumeHint, maxLength: CERT_LIMITS.volume })}
              </div>
            </section>
          )}
```

  3. `src/components/admin/CourseEditor.module.css`: after the `.cardTitle { … }` rule add:

```css
/* "Tunnistus" (phase 3d): the card's lead, its lines and its volume, one under another */
.certificate {
  display: grid;
  gap: 22px;
  min-width: 0;
}
```

- [ ] **Step 12: The course editor's texts** (`src/i18n/dict/admin.ts`). In `courseEditor.sections`, after `test: "Teadmiste test",` add `certificate: "Tunnistus",`. In `courseEditor.fields`, after `testRemove: "Eemalda küsimus {n}",` add:

```ts
      // "Tunnistus" (phase 3d, spec §6): an e-course certificate's lines and volume (the list is ProtocolStagesEditor's kind "skills")
      certificateLead: "E-kursuse tunnistuse tekst. Juba väljastatud tunnistused jäävad selliseks, nagu need väljastati.",
      certificateSkills: "Oskused tunnistusel",
      certificateSkill: "Rida",
      certificateSkillsHint: "Tühjana kasutatakse „Mida õpid“ ridu",
      certificateSkillsEmpty: "Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read.",
      certificateSkillsAdd: "Lisa rida",
      certificateSkillsFull: "Rohkem kui 16 rida ei saa lisada.",
      certificateVolume: "Maht",
      certificateVolumeHint: "nt 10 akadeemilist tundi. Tühjaks jättes tunnistusel ei näidata.",
```

- [ ] **Step 13: Run the course-editor tests — expect PASS.** `cd app && npx vitest run tests/unit/admin-content.test.ts tests/db/admin-content.test.ts tests/unit/protocol-stages-dom.test.ts` — green.

- [ ] **Step 14: Write the failing route tests.**

  1. Create `tests/db/admin-signature-route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { createSession } from "@/server/auth";
import { getCertificateSettings } from "@/server/certificates";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// POST|GET|DELETE /api/admin/allkiri (phase 3d, spec §6, D4): Maria's signature for the certificates, a private object of the store — signed-in
// admins only (a cross-site upload or removal is 403). The upload takes one PNG of at most 1 MB (its first bytes checked), stores it as
// certificate/signature-<uuid>.png, points the setting at it and removes the old object only after that; the GET answers the image (the local
// folder's bytes, or a 302 to a signed R2 address); the DELETE clears the setting and removes the object. The route runs with the database
// (PGlite), the admin's session cookie (next/headers) and the store faked, as tests/db/admin-photo-route.test.ts runs Maria's photo route.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, store: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => state.store }));

import { DELETE, GET, maxDuration, POST } from "@/app/api/admin/allkiri/route";

const ORIGIN = "https://mslab.example";
const URL_ = `${ORIGIN}/api/admin/allkiri`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const KEY = /^certificate\/signature-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

let db: Db;
beforeEach(async () => {
  db = await makeTestDb(); // a fresh database each time: the setting is one row
  state.db = db;
  state.cookie = undefined;
  state.store = fakeMediaStore();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const store = () => state.store as ReturnType<typeof fakeMediaStore>;
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const signatureKey = async () => (await getCertificateSettings(db, new Date("2026-10-20T09:00:00Z"))).signatureKey;
const upload = (bytes: ArrayLike<number>, type = "image/png", headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(Array.from(bytes))], "allkiri.png", { type }));
  return POST(new Request(URL_, { method: "POST", body: form, headers }), {});
};
const get = () => GET(new Request(URL_), {});
const remove = (headers: Record<string, string> = {}) => DELETE(new Request(URL_, { method: "DELETE", headers }), {});
const answer = async (res: Response) => [res.status, await res.json()];

describe("/api/admin/allkiri", () => {
  test("without an admin's session: 401 for each method and nothing stored; a cross-site upload or removal is 403", async () => {
    expect(await answer(await upload(PNG))).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect((await get()).status).toBe(401);
    expect((await remove()).status).toBe(401);
    state.cookie = await createSession(db, "former.admin@example.com");
    expect((await upload(PNG)).status).toBe(401);
    await signIn();
    expect((await upload(PNG, "image/png", { origin: "https://evil.example" })).status).toBe(403);
    expect((await remove({ origin: "https://evil.example" })).status).toBe(403);
    expect(store().objects.size).toBe(0);
    expect(await signatureKey()).toBeNull();
  });

  test("a PNG: stored privately as certificate/signature-<uuid>.png (image/png), the setting names it; a second one replaces it and the first object goes after", async () => {
    await signIn();
    expect(await answer(await upload(PNG))).toEqual([200, { ok: true }]);
    const first = await signatureKey();
    expect(first).toMatch(KEY);
    expect(store().objects.get(first!)?.contentType).toBe("image/png");
    expect([...store().objects.get(first!)!.bytes]).toEqual(PNG);
    expect(store().deleted).toEqual([]);
    expect((await upload([...PNG, 1, 2, 3])).status).toBe(200);
    const second = await signatureKey();
    expect(second).toMatch(KEY);
    expect(second).not.toBe(first);
    expect(store().deleted).toEqual([first]);
    expect([...store().objects.keys()]).toEqual([second]);
  });

  test("GET: the local folder's bytes inline as image/png, never kept; on R2 a 302 to a signed address; 404 without a signature, the object or a store", async () => {
    await signIn();
    expect(await answer(await get())).toEqual([404, { ok: false, error: "notFound" }]);
    await upload(PNG);
    const key = (await signatureKey())!;
    const local = await get();
    expect(local.status).toBe(200);
    expect(local.headers.get("content-type")).toBe("image/png");
    expect(local.headers.get("cache-control")).toBe("private, no-store");
    expect(local.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await local.arrayBuffer())]).toEqual(PNG);
    const signedGetUrl = vi.fn(async (k: string) => `https://r2.example/${k}?X-Amz-Expires=300`);
    state.store = { ...store(), signedGetUrl };
    const signed = await get();
    expect([signed.status, signed.headers.get("location"), signed.headers.get("referrer-policy")]).toEqual([302, `https://r2.example/${key}?X-Amz-Expires=300`, "no-referrer"]);
    state.store = fakeMediaStore(); // the setting names an object this folder does not have
    expect((await get()).status).toBe(404);
    state.store = null;
    expect((await get()).status).toBe(404);
  });

  test("refused, nothing stored and the setting unchanged: no file, an empty one, one over 1 MB (or a body announced over it), not a PNG by its type or by its first bytes", async () => {
    await signIn();
    expect(await answer(await POST(new Request(URL_, { method: "POST", body: new FormData() }), {}))).toEqual([400, { ok: false, error: "missing" }]);
    expect(await answer(await upload([]))).toEqual([400, { ok: false, error: "empty" }]);
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    expect(await answer(await upload(big))).toEqual([413, { ok: false, error: "size" }]);
    const announced = new Request(URL_, { method: "POST", body: new FormData(), headers: { "content-length": String(2 * 1024 * 1024) } });
    expect(await answer(await POST(announced, {}))).toEqual([413, { ok: false, error: "size" }]);
    expect(await answer(await upload(PNG, "image/jpeg"))).toEqual([415, { ok: false, error: "type" }]);
    expect(await answer(await upload([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toEqual([415, { ok: false, error: "content" }]);
    expect(store().objects.size).toBe(0);
    expect(await signatureKey()).toBeNull();
  });

  test("no file store (production without the R2 variables): 503 'storage', said in the log by the variables' names", async () => {
    await signIn();
    state.store = null;
    expect(await answer(await upload(PNG))).toEqual([503, { ok: false, error: "storage" }]);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET");
    expect(await signatureKey()).toBeNull();
  });

  test("the setting cannot be saved: the new object is removed again and the answer is 500; the log has the label, never the key", async () => {
    await signIn();
    // the session is read as always; the setting's write (a transaction: setSignatureKey takes the number lock) fails as a restarting database does
    state.db = new Proxy(db, {
      get: (target, name, receiver) =>
        name === "transaction"
          ? async () => {
              throw Object.assign(new Error("database down"), { code: "57P01" });
            }
          : Reflect.get(target, name, receiver),
    });
    expect(await answer(await upload(PNG))).toEqual([500, { ok: false, error: "server" }]);
    expect(store().objects.size).toBe(0);
    expect(store().deleted).toHaveLength(1);
    expect(store().deleted[0]).toMatch(KEY);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[certificate] the signature setting could not be saved: Error (code 57P01)");
    expect(logged).not.toContain("certificate/signature-");
  });

  test("a store that cannot remove the old object: the new signature is in place all the same; the failure is logged by its label, never the key", async () => {
    await signIn();
    await upload(PNG);
    const first = await signatureKey();
    state.store = {
      ...store(),
      delete: async () => {
        throw new TypeError(`cannot delete ${first}`);
      },
    };
    expect((await upload(PNG)).status).toBe(200);
    expect(await signatureKey()).not.toBe(first);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[certificate] the old signature image could not be removed: TypeError");
    expect(logged).not.toContain("certificate/signature-");
  });

  test("DELETE: the setting cleared and the object removed; again: nothing to remove, still ok", async () => {
    await signIn();
    await upload(PNG);
    const key = await signatureKey();
    expect(await answer(await remove())).toEqual([200, { ok: true }]);
    expect(await signatureKey()).toBeNull();
    expect(store().deleted).toEqual([key]);
    expect(store().objects.size).toBe(0);
    expect(await answer(await remove())).toEqual([200, { ok: true }]);
    expect(store().deleted).toEqual([key]);
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect(maxDuration).toBe(30);
  });
});
```

  2. Create `tests/db/admin-certificate-route.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, courseAccess, settings } from "@/db/schema";
import { createSession } from "@/server/auth";
import { fakeMediaStore } from "../fakes";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// GET /api/admin/tunnistus/<id> (phase 3d, spec §6): Maria's download of any certificate, a revoked access's too — signed-in admins only; the
// PDF rendered from the frozen row (server/certificates.ts certificatePdf, the real fonts of assets/fonts), as a download named after its
// number, private and never kept; the signature from the store when the setting names one. The database is PGlite, the session cookie
// (next/headers) and the store are faked, as in tests/db/admin-photo-route.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, store: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => state.store }));

import { GET, maxDuration } from "@/app/api/admin/tunnistus/[id]/route";

const ORIGIN = "https://mslab.example";
const SIGNATURE = "certificate/signature-0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.png";
/** A valid 1 × 1 PNG (RGBA): what pdf-lib embeds as an image. */
const PIXEL = [...Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")];

let db: Db;
let certId: number;
let accessId: number;
beforeAll(async () => {
  db = await makeTestDb();
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  accessId = kati.access.id;
  const [c] = await db
    .insert(certificates)
    .values({
      accessId,
      number: "MS LAB 2026-03",
      year: 2026,
      seq: 3,
      name: "Kätlin Kask-Žukova",
      courseTitle: "Kulmumeistri e-koolitus",
      skills: ["Kulmude kuju ja proportsioonid", "Värvi valik"],
      volume: "10 akadeemilist tundi",
      practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: at(10),
    })
    .returning();
  certId = c.id;
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  state.store = fakeMediaStore();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const download = (id: string) => GET(new Request(`${ORIGIN}/api/admin/tunnistus/${id}`), { params: Promise.resolve({ id }) });
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("GET /api/admin/tunnistus/<id>", () => {
  test("without an admin's session: 401, and nothing is rendered or read from the store", async () => {
    const res = await download(String(certId));
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect((state.store as ReturnType<typeof fakeMediaStore>).requested).toEqual([]);
  });

  test("the PDF as a download named after its number, private and never kept, nosniff; without a signature no image in it", async () => {
    await signIn();
    const res = await download(String(certId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-tunnistus-2026-03.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const pdf = await bytesOf(res);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeLessThan(300 * 1024);
    expect(pdf.includes("/Subtype /Image")).toBe(false);
  });

  test("Review Focus 4: the signature the setting names is drawn on every download (an image in the PDF), read from the store", async () => {
    await signIn();
    await db.insert(settings).values({ key: "certificate", value: { signatureKey: SIGNATURE } });
    state.store = fakeMediaStore({ [SIGNATURE]: { bytes: PIXEL, contentType: "image/png" } });
    try {
      const pdf = await bytesOf(await download(String(certId)));
      expect(pdf.includes("/Subtype /Image")).toBe(true);
      expect((state.store as ReturnType<typeof fakeMediaStore>).requested).toContain(SIGNATURE);
    } finally {
      await db.delete(settings).where(eq(settings.key, "certificate"));
    }
  });

  test("Review Focus 5: a revoked access's certificate is still Maria's to download", async () => {
    await signIn();
    await db.update(courseAccess).set({ revokedAt: at(12) }).where(eq(courseAccess.id, accessId));
    try {
      expect((await download(String(certId))).status).toBe(200);
    } finally {
      await db.update(courseAccess).set({ revokedAt: null }).where(eq(courseAccess.id, accessId));
    }
  });

  test("404: an id that is no certificate, or no id at all", async () => {
    await signIn();
    for (const id of ["999999", "abc", "0", "007", "2147483648"]) {
      const res = await download(id);
      expect([res.status, await res.json()], id).toEqual([404, { ok: false, error: "notFound" }]);
    }
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect(maxDuration).toBe(30);
  });
});
```

- [ ] **Step 15: Run them — expect FAIL.** `cd app && npx vitest run tests/db/admin-signature-route.test.ts tests/db/admin-certificate-route.test.ts` — both fail to import (`Failed to resolve import "@/app/api/admin/allkiri/route"`, and `…/tunnistus/[id]/route`).

- [ ] **Step 16: The signature's route** — create `src/app/api/admin/allkiri/route.ts`:

```ts
import { getDb } from "@/db/client";
import { SIGNATURE_MAX_BYTES } from "@/lib/signature-ink";
import { withAdmin } from "@/server/auth";
import { getCertificateSettings, setSignatureKey } from "@/server/certificates";
import { logFailure, logNote } from "@/server/log";
import { hasImageSignature, type FileStore } from "@/server/media";
import { mediaStore } from "@/server/media-store";
import { privateFileAnswer } from "@/server/private-file";

export const dynamic = "force-dynamic";
// R2 is given 10 s to answer (server/r2.ts); whatever else holds a request up ends after 30 s, not after the default 300 s
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
/** Room for the multipart boundaries and headers around the file. */
const ENVELOPE = 64 * 1024;
/** The image's answer is one admin's, never kept; Seaded's address is not passed on to R2. */
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

/**
 * The object of a replaced or removed signature, removed once the setting no longer names it. A failure is logged by its label only (never
 * the key): the object stays in the bucket with no setting naming it, to be deleted by hand (docs/deploy.md section 14).
 */
async function removeObject(store: FileStore | null, key: string | null): Promise<void> {
  if (!key) return;
  if (!store) return logNote("[certificate] no file store: the old signature image was not removed");
  try {
    await store.delete(key);
  } catch (e) {
    logFailure("[certificate] the old signature image could not be removed", e);
  }
}

/**
 * POST /api/admin/allkiri (phase 3d, spec §6, D4): Maria's signature as multipart field `file`, the PNG her browser made of her scan or her
 * Canva export (lib/signature-ink.ts: white ink on transparency). Signed-in admins only; a cross-site POST is 403. The server trusts none of
 * the browser's work: one PNG by its type and its first bytes, 1 B to 1 MB. It is stored as a new private object
 * certificate/signature-<uuid>.png, the setting is pointed at it (server/certificates.ts setSignatureKey), and only then is the old object
 * removed: a certificate downloaded meanwhile has one signature or the other, never none. 200 `{ ok: true }`; 400 missing | empty; 413
 * size; 415 type | content; 503 storage (no store: the four R2 variables); 500 server (the new object is removed again when the setting
 * cannot be saved).
 */
export const POST = withAdmin(async (request) => {
  if (Number(request.headers.get("content-length") ?? 0) > SIGNATURE_MAX_BYTES + ENVELOPE) return json({ ok: false, error: "size" }, 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "missing" }, 400);
  if (file.size === 0) return json({ ok: false, error: "empty" }, 400);
  if (file.size > SIGNATURE_MAX_BYTES) return json({ ok: false, error: "size" }, 413);
  if (file.type !== "image/png") return json({ ok: false, error: "type" }, 415);
  const store = mediaStore();
  if (!store) {
    logNote("[certificate] signature refused: no file store (production needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET)");
    return json({ ok: false, error: "storage" }, 503);
  }
  const key = `certificate/signature-${crypto.randomUUID()}.png`;
  try {
    const bytes = await file.arrayBuffer();
    if (!hasImageSignature("image/png", new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)))) return json({ ok: false, error: "content" }, 415);
    await store.put(key, bytes, "image/png");
  } catch (e) {
    logFailure("[certificate] the signature could not be stored", e);
    return json({ ok: false, error: "server" }, 500);
  }
  let old: string | null;
  try {
    old = await setSignatureKey(getDb(), key, new Date());
  } catch (e) {
    logFailure("[certificate] the signature setting could not be saved", e);
    await removeObject(store, key); // no setting names it
    return json({ ok: false, error: "server" }, 500);
  }
  if (old !== key) await removeObject(store, old);
  return json({ ok: true }, 200);
});

/**
 * GET /api/admin/allkiri: the signature the setting names, for Seaded's preview on black — a 302 to a 5-minute signed R2 address, or the
 * local folder's bytes (server/private-file.ts). 404 `notFound` without a signature, a store or the object; 500 `server` (logged).
 */
export const GET = withAdmin(async () => {
  try {
    const store = mediaStore();
    const { signatureKey } = await getCertificateSettings(getDb(), new Date());
    if (!store || !signatureKey) return json({ ok: false, error: "notFound" }, 404);
    return (await privateFileAnswer(store, signatureKey, { contentType: "image/png", headers: HEADERS })) ?? json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure("[certificate] the signature could not be read", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

/** DELETE /api/admin/allkiri ("Eemalda allkiri"): the setting cleared, then the object removed. 200 `{ ok: true }` (also when there was none); 500 `server`. */
export const DELETE = withAdmin(async () => {
  try {
    const old = await setSignatureKey(getDb(), null, new Date());
    await removeObject(mediaStore(), old);
    return json({ ok: true }, 200);
  } catch (e) {
    logFailure("[certificate] the signature could not be removed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});
```

- [ ] **Step 17: Maria's download** — create `src/app/api/admin/tunnistus/[id]/route.ts`:

```ts
import { getDb } from "@/db/client";
import { certificateFileName } from "@/domain/certificate";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { certificateForAdmin, certificatePdf } from "@/server/certificates";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
// the PDF takes tens of milliseconds (spec §7) and R2 is given 10 s for the signature: a hung call ends after 30 s, not the default 300 s.
// next.config.ts traces assets/fonts into this function (outputFileTracingIncludes, Task 1).
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/tunnistus/<id> (phase 3d, spec §6): any certificate as Maria downloads it from the Õpilased drawer or the register — a
 * revoked access's too (Review Focus 5). Rendered from its frozen row with the signature of now (server/certificates.ts certificatePdf), as
 * `attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`, private and never kept. Signed-in admins only (withAdmin: 401 otherwise). 404
 * `notFound` for an id that is no certificate; 500 `server` (logged by the certificate's id).
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    const cert = await certificateForAdmin(db, id);
    if (!cert) return json({ ok: false, error: "notFound" }, 404);
    const bytes = await certificatePdf(db, mediaStore(), cert, new Date());
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${certificateFileName(cert.year, cert.seq)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    logFailure(`[certificate] ${id}: the admin's download failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});
```

- [ ] **Step 18: Run them — expect PASS.** `cd app && npx vitest run tests/db/admin-signature-route.test.ts tests/db/admin-certificate-route.test.ts` — green.

- [ ] **Step 19: Write the failing action test** — create `tests/unit/admin-certificates-action.test.ts`:

```ts
import { beforeEach, expect, test, vi } from "vitest";

// Seaded's "Salvesta tunnistuse andmed" (server/actions/admin-certificates.ts, phase 3d, spec §6, §4): the card's fields go on as they came
// (server/certificates.ts saveCertificateSettings checks them; tests/db/certificates.test.ts); saved, the browser gets the settings without the
// signature's key and the saved year's last number; a refusal's field errors as they came; a throw is { ok: false, error: "server" }.

const work = vi.hoisted(() => ({ saveCertificateSettings: vi.fn(), lastIssued: vi.fn(), reissueCertificate: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/server/certificates", () => work);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

const { saveCertificateSettingsAction } = await import("@/server/actions/admin-certificates");

const RAW = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: "2026", nextSeq: "15" };
const STORED = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 15 };

beforeEach(() => {
  work.saveCertificateSettings.mockReset();
  work.lastIssued.mockReset();
  work.reissueCertificate.mockReset();
  cache.refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("the card's fields go on as they came; saved: the settings without the signature's key, and the saved year's last number", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: true, settings: { ...STORED, signatureKey: "certificate/signature-0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.png" } });
  work.lastIssued.mockResolvedValue("MS LAB 2026-14");
  const result = await saveCertificateSettingsAction(RAW);
  expect(result).toEqual({ ok: true, settings: STORED, last: "MS LAB 2026-14" });
  expect(JSON.stringify(result)).not.toContain("certificate/");
  expect(work.saveCertificateSettings.mock.calls[0][1]).toBe(RAW);
  expect(work.saveCertificateSettings.mock.calls[0][2]).toBeInstanceOf(Date);
  expect(work.lastIssued.mock.calls[0][1]).toBe(2026);
  expect(cache.refresh).not.toHaveBeenCalled(); // the card keeps its own state
});

test("refused: the field errors as they came, nothing else read", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: false, fields: { nextSeq: "taken", place: "required" } });
  expect(await saveCertificateSettingsAction(RAW)).toEqual({ ok: false, fields: { nextSeq: "taken", place: "required" } });
  expect(work.lastIssued).not.toHaveBeenCalled();
});

test("a throw is { ok: false, error: 'server' }, logged by its label only", async () => {
  work.saveCertificateSettings.mockRejectedValue(new TypeError("boom: Tallinn"));
  expect(await saveCertificateSettingsAction(RAW)).toEqual({ ok: false, error: "server" });
  const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(logged).toContain("[certificate] the settings save failed: TypeError");
  expect(logged).not.toContain("Tallinn");
});
```

- [ ] **Step 20: Run it — expect FAIL.** `cd app && npx vitest run tests/unit/admin-certificates-action.test.ts` — `Failed to resolve import "@/server/actions/admin-certificates"`.

- [ ] **Step 21: The action file** — create `src/server/actions/admin-certificates.ts`:

```ts
"use server";

import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { lastIssued, saveCertificateSettings } from "../certificates";
import { logFailure } from "../log";

// The e-course certificate's admin actions (phase 3d, spec §6): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../certificates.ts. Seaded's "Tunnistus" card keeps its own state, so its save refreshes nothing. The signature is not an action but a route
// (app/api/admin/allkiri): a file is a multipart upload, and its preview needs a GET.

/**
 * Seaded → "Tunnistus" → "Salvesta tunnistuse andmed": the card's fields as typed (`{ place, registryCode, practicalLine, trainerName, nextYear,
 * nextSeq }`, the two numbers as text), checked by saveCertificateSettings (a next number at or below one already issued in that year is
 * refused on `nextSeq`, "taken": Review Focus 4). Saved: the settings as stored without the signature's key (it never goes to the browser) and
 * the number last issued in the saved year. A throw is { ok: false, error: "server" }, logged by its label only.
 */
export const saveCertificateSettingsAction = adminAction(async (_admin, raw: unknown) => {
  try {
    const db = getDb();
    const result = await saveCertificateSettings(db, raw, new Date());
    if (!result.ok) return { ok: false as const, fields: result.fields };
    const s = result.settings;
    // named one by one: the signature's key is left behind on purpose
    const settings = { place: s.place, registryCode: s.registryCode, practicalLine: s.practicalLine, trainerName: s.trainerName, nextYear: s.nextYear, nextSeq: s.nextSeq };
    return { ok: true as const, settings, last: await lastIssued(db, settings.nextYear) };
  } catch (e) {
    logFailure("[certificate] the settings save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});
```


- [ ] **Step 22: Run it — expect PASS.** `cd app && npx vitest run tests/unit/admin-certificates-action.test.ts` — green.

- [ ] **Step 23: Write the failing card tests.**

  1. Create `tests/unit/certificate-settings-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stubFetch } from "../fakes";

// Seaded → "Tunnistus" (phase 3d, spec §6, §4; Review Focus 4) in a browser-like document (happy-dom), with the server action answered here,
// the signature's conversion (lib/signature-ink.ts, its own test) a stand-in and fetch stubbed: the stored values in their fields, the save
// as typed, a next number at or below an issued one refused on its field with the last issued number beside it, a new signature sent as PNG
// and shown anew on black, its refusals, and "Eemalda allkiri" with its one question.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: action }));
const ink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/signature-ink", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/signature-ink")>()), inkSignature: ink }));

import { CertificateSettings, type CertificateSettingsInitial } from "@/components/admin/CertificateSettings";
import { InkError } from "@/lib/signature-ink";

const PRACTICAL = "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine";
const INITIAL: CertificateSettingsInitial = {
  place: "Pärnu linn",
  registryCode: "16346048",
  practicalLine: PRACTICAL,
  trainerName: "Maria Sosnina",
  nextYear: 2026,
  nextSeq: 15,
  last: "MS LAB 2026-14",
  hasSignature: false,
};
const PNG = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" });

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The card as the page renders it (a new key: a new card, as a new page load gives). */
const show = async (initial: CertificateSettingsInitial = INITIAL) => {
  await act(async () => root.render(createElement(CertificateSettings, { key: JSON.stringify(initial), initial })));
  await settle();
};
const input = (hook: string) => $<HTMLInputElement>(`[data-cert-${hook}]`)!;
const errorOf = (hook: string) => document.getElementById(`${input(hook).id}-error`)?.textContent ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-cert-form]")!.requestSubmit());
  await settle();
};
/** The signature's file field picks `file`. */
const pick = async (file: File) => {
  const field = input("signature-file");
  Object.defineProperty(field, "files", { configurable: true, value: [file] });
  await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
};
const signatureLine = () => $("[data-cert-signature-status]")!.textContent;
const fileLabel = () => container.querySelector(`label[for="${input("signature-file").id}"]`)!.textContent;

beforeEach(() => {
  action.mockReset();
  ink.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CertificateSettings", () => {
  test("the stored values in their fields; the last issued number beside the next one; without a signature, the card says the name is written instead", async () => {
    await show();
    expect(["place", "registry", "practical", "trainer", "next-year", "next-seq"].map((h) => input(h).value)).toEqual(["Pärnu linn", "16346048", PRACTICAL, "Maria Sosnina", "2026", "15"]);
    expect($("[data-cert-last]")!.textContent).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect($("[data-cert-signature] img")).toBeNull();
    expect($("[data-cert-signature]")!.textContent).toBe("Allkirja pole: tunnistusel on koolitaja nimi käekirjas.");
    expect($("[data-cert-signature-remove]")).toBeNull();
    expect(fileLabel()).toBe("Lae allkiri üles");
    expect($("[data-cert-save]")!.textContent).toBe("Salvesta tunnistuse andmed");
    await show({ ...INITIAL, last: null });
    expect($("[data-cert-last]")!.textContent).toBe("Sel aastal pole veel tunnistusi väljastatud.");
  });

  test("'Salvesta tunnistuse andmed' sends the fields as typed; saved, the fields take the stored values and the saved year's last number", async () => {
    action.mockResolvedValue({ ok: true, settings: { place: "Tallinn", registryCode: "16346048", practicalLine: PRACTICAL, trainerName: "Maria Sosnina", nextYear: 2027, nextSeq: 1 }, last: null });
    await show();
    await type(input("place"), "  Tallinn ");
    await type(input("next-year"), "2027");
    await type(input("next-seq"), "1");
    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0]).toEqual({ place: "  Tallinn ", registryCode: "16346048", practicalLine: PRACTICAL, trainerName: "Maria Sosnina", nextYear: "2027", nextSeq: "1" });
    expect(input("place").value).toBe("Tallinn");
    expect($("[data-cert-status]")!.textContent).toBe("Tunnistuse andmed on salvestatud.");
    expect($("[data-cert-last]")!.textContent).toBe("Sel aastal pole veel tunnistusi väljastatud.");
  });

  test("Review Focus 4: a next number at or below one already issued is refused on its field, which takes the focus; the last issued number stays beside it", async () => {
    action.mockResolvedValue({ ok: false, fields: { nextSeq: "taken" } });
    await show();
    await type(input("next-seq"), "14");
    await submit();
    expect(input("next-seq").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("next-seq"));
    expect(errorOf("next-seq")).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(input("next-seq").getAttribute("aria-describedby")).toContain(`${input("next-seq").id}-error`);
    expect($("[data-cert-last]")!.textContent).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect($("[data-cert-status]")!.textContent).toBe("Kontrolli märgitud välju.");
    expect(input("place").getAttribute("aria-invalid")).toBeNull();
    expect(input("next-seq").value).toBe("14"); // what she typed stays

    // the other codes in their own words (a bad year is reported on the number, "invalid"); a code the card does not know in a general line
    action.mockResolvedValue({ ok: false, fields: { place: "required", registryCode: "tooLong", nextSeq: "invalid", trainerName: "somethingNew" } });
    await submit();
    expect([errorOf("place"), errorOf("registry"), errorOf("next-seq"), errorOf("trainer"), errorOf("next-year")]).toEqual([
      "Täida see väli.",
      "Tekst on liiga pikk.",
      "Kontrolli aastat (2000–2099) ja numbrit (1–99 999).",
      "Kontrolli seda välja.",
      null,
    ]);
    expect(document.activeElement).toBe(input("place"));
    action.mockResolvedValue({ ok: false, error: "server" });
    await submit();
    expect($("[data-cert-status]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("Review Focus 4: a new signature — the picture becomes white ink (inkSignature), goes as PNG to POST /api/admin/allkiri, and the preview on black loads it anew", async () => {
    ink.mockImplementation(async () => PNG());
    const net = stubFetch(() => Response.json({ ok: true }));
    await show();
    const scan = new File([new Uint8Array(32)], "IMG_0042.jpg", { type: "image/jpeg" });
    await pick(scan);
    expect(ink).toHaveBeenCalledWith(scan);
    expect(net.calls.map((c) => [c.url, c.method])).toEqual([["/api/admin/allkiri", "POST"]]);
    const sent = (net.calls[0].body as FormData).get("file") as File;
    expect([sent.name, sent.type, sent.size]).toEqual(["allkiri.png", "image/png", 8]);
    const img = $<HTMLImageElement>("[data-cert-signature] img")!;
    expect(img.getAttribute("src")).toBe("/api/admin/allkiri?v=2");
    expect(img.getAttribute("alt")).toBe("Allkiri, nagu see tunnistusel paistab");
    expect(signatureLine()).toBe("Allkiri on salvestatud. See on nüüd kõigil tunnistustel, ka varem väljastatutel.");
    expect(fileLabel()).toBe("Vaheta allkiri");
    // another one (Maria's Canva export) replaces it: a new address, so the browser never shows the old picture
    await pick(new File([new Uint8Array(32)], "allkiri-canva.png", { type: "image/png" }));
    expect($("[data-cert-signature] img")!.getAttribute("src")).toBe("/api/admin/allkiri?v=3");
    net.restore();
  });

  test("a picture without ink, one the browser cannot open, a refused or too big upload says why; nothing is shown as saved", async () => {
    const net = stubFetch(() => Response.json({ ok: false, error: "storage" }, { status: 503 }));
    await show();
    const file = () => new File([new Uint8Array(32)], "valge.jpg", { type: "image/jpeg" });
    ink.mockRejectedValueOnce(new InkError("empty"));
    await pick(file());
    expect(signatureLine()).toBe("Pildilt ei leitud allkirja. Vali pilt, kus on tume allkiri heledal taustal või hele allkiri läbipaistval taustal.");
    ink.mockRejectedValueOnce(new InkError("decode"));
    await pick(file());
    expect(signatureLine()).toBe("Seda pilti ei saa avada. Vali JPG- või PNG-pilt.");
    expect(net.calls).toEqual([]);
    ink.mockResolvedValueOnce(PNG());
    await pick(file());
    expect(signatureLine()).toBe("Failide salvestamine pole seadistatud — anna arendajale teada.");
    ink.mockResolvedValueOnce(new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/png" }));
    await pick(file());
    expect(signatureLine()).toBe("Allkirja pilt on liiga suur.");
    expect(net.calls).toHaveLength(1); // the too big one never left the browser
    expect($("[data-cert-signature] img")).toBeNull();
    expect($("[data-cert-signature-status]")!.className).toContain("error");
    net.restore();
  });

  test("'Eemalda allkiri' asks once; 'Ei' keeps it; 'Jah, eemalda' sends DELETE and the card says the name is written instead", async () => {
    const net = stubFetch(() => Response.json({ ok: true }));
    await show({ ...INITIAL, hasSignature: true });
    expect($("[data-cert-signature] img")!.getAttribute("src")).toBe("/api/admin/allkiri?v=1");
    expect(fileLabel()).toBe("Vaheta allkiri");
    await click($("[data-cert-signature-remove]"));
    const question = $("[data-cert-signature-confirm] p")!;
    expect(question.textContent).toBe("Kas eemaldan allkirja? Tunnistustel on siis koolitaja nimi käekirjas.");
    expect(document.activeElement).toBe(question);
    await click(button("Ei"));
    expect($("[data-cert-signature-confirm]")).toBeNull();
    expect(net.calls).toEqual([]);
    await click($("[data-cert-signature-remove]"));
    await click(button("Jah, eemalda"));
    expect(net.calls.map((c) => [c.url, c.method])).toEqual([["/api/admin/allkiri", "DELETE"]]);
    expect($("[data-cert-signature] img")).toBeNull();
    expect($("[data-cert-signature]")!.textContent).toBe("Allkirja pole: tunnistusel on koolitaja nimi käekirjas.");
    expect(signatureLine()).toBe("Allkiri on eemaldatud.");
    expect($("[data-cert-signature-remove]")).toBeNull();
    net.restore();
  });
});
```

  (A CSS module's class name keeps its own name in vitest, as `tests/unit/account-details-dom.test.ts` reads `className` with `/error/`.)

  2. Create `tests/db/seaded-certificate-page.test.ts`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, settings } from "@/db/schema";
import { CERT_DEFAULTS, tallinnYear } from "@/domain/certificate";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Seaded with its "Tunnistus" card (phase 3d, spec §6, §4), rendered from a real (PGlite) database to HTML: the card is a form of its own
// after the settings' form (never a form inside a form), it shows the stored setting (or the defaults), the number last issued in the next
// number's year, and the signature's preview through the admin route — never the signature's key. The shell and the server actions are
// stand-ins (they need a browser or a request).

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

const KEY = "certificate/signature-0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.png";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("ADMIN_EMAILS", "maria@example.test");
});
afterEach(() => vi.unstubAllEnvs());

const page = async () => renderToStaticMarkup(await SettingsEditPage());
/** The value of the card's input `data-cert-<hook>`. */
const valueOf = (html: string, hook: string) => {
  const tag = new RegExp(`<input[^>]*data-cert-${hook}=""[^>]*>`).exec(html)?.[0] ?? "";
  return /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
};

test("without a setting: the defaults, this year's number 1, nothing issued yet, no signature; the card is a form of its own after the settings' form", async () => {
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
  expect(html).toContain("Allkirja pole: tunnistusel on koolitaja nimi käekirjas.");
  expect(html).not.toContain("/api/admin/allkiri");
});

test("a stored setting: its values, the year's last issued number beside the next, and the signature's preview from the admin route (its key never in the page)", async () => {
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
    value: { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 15, signatureKey: KEY },
  });
  const html = await page();
  expect([valueOf(html, "place"), valueOf(html, "next-year"), valueOf(html, "next-seq")]).toEqual(["Tallinn", "2026", "15"]);
  expect(html).toContain("Viimati väljastatud: MS LAB 2026-14");
  expect(html).toContain('src="/api/admin/allkiri?v=1"');
  expect(html).not.toContain(KEY);
  expect(html).not.toContain("Allkirja pole");
});
```

- [ ] **Step 24: Run them — expect FAIL.** `cd app && npx vitest run tests/unit/certificate-settings-dom.test.ts tests/db/seaded-certificate-page.test.ts` — `Failed to resolve import "@/components/admin/CertificateSettings"`.

- [ ] **Step 25: The card** — create `src/components/admin/CertificateSettings.tsx`:

```tsx
"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { MAX_SOURCE_BYTES } from "@/lib/shrink-image";
import { InkError, inkSignature, SIGNATURE_MAX_BYTES } from "@/lib/signature-ink";
import { saveCertificateSettingsAction } from "@/server/actions/admin-certificates";
import type { CertificateFieldError } from "@/server/certificates";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./CertificateSettings.module.css";

/** What the Seaded page reads for the card (server/certificates.ts getCertificateSettings and lastIssued); the signature's key stays on the server. */
export type CertificateSettingsInitial = {
  place: string;
  registryCode: string;
  practicalLine: string;
  trainerName: string;
  nextYear: number;
  nextSeq: number;
  /** The number last issued in `nextYear` ("MS LAB 2026-14"), or null. */
  last: string | null;
  hasSignature: boolean;
};

/** The fields as typed: the two numbers too (the server parses them, as the course editor's). */
type Draft = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: string; nextSeq: string };
type Field = keyof Draft;
type Stored = Omit<CertificateSettingsInitial, "last" | "hasSignature">;

const draftOf = (s: Stored): Draft => ({
  place: s.place,
  registryCode: s.registryCode,
  practicalLine: s.practicalLine,
  trainerName: s.trainerName,
  nextYear: String(s.nextYear),
  nextSeq: String(s.nextSeq),
});

type SignatureProblem = keyof (typeof adminEt)["certificates"]["settings"]["signatureErrors"];
/** A status line: empty, on its way, done or refused. */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/** The signature's PNG to POST /api/admin/allkiri; "ok" or why it was refused. */
async function sendSignature(png: Blob): Promise<"ok" | SignatureProblem> {
  const body = new FormData();
  body.set("file", new File([png], "allkiri.png", { type: "image/png" }));
  let res: Response;
  try {
    res = await fetch("/api/admin/allkiri", { method: "POST", body, credentials: "same-origin" });
  } catch {
    return "server";
  }
  if (res.ok) return "ok";
  if (res.status === 401) return "session";
  if (res.status === 413) return "size";
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return res.status === 503 && json?.error === "storage" ? "storage" : "server";
}

/** DELETE /api/admin/allkiri; "ok" or why not. */
async function deleteSignature(): Promise<"ok" | "session" | "server"> {
  try {
    const res = await fetch("/api/admin/allkiri", { method: "DELETE", credentials: "same-origin" });
    return res.ok ? "ok" : res.status === 401 ? "session" : "server";
  } catch {
    return "server";
  }
}

/**
 * Seaded → "Tunnistus" (phase 3d, spec §6, §4): what every new e-course certificate prints besides the student's name and her course — the
 * place, the registry code, the practical work's line and the trainer's name (written in the script font when there is no signature) — and
 * "Järgmine number" (year and number), with the number last issued in that year beside it. A form of its own after the settings' form, with
 * its own "Salvesta tunnistuse andmed" (a secondary button: the page's primary one is the settings' save bar); a refused field is marked and
 * the first one takes the focus (Review Focus 4: a next number at or below one already issued is "taken"). The signature is uploaded at once
 * when a picture is picked: the browser makes it white ink on transparency (lib/signature-ink.ts: a scan of dark ink, or Maria's Canva export
 * of light ink), POST /api/admin/allkiri stores it, and the preview on black loads it anew (a new `v`). "Eemalda allkiri" asks once first.
 * The card keeps its own state; the page is not refreshed.
 */
export function CertificateSettings({ initial }: { initial: CertificateSettingsInitial }) {
  const t = adminEt.certificates.settings;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [last, setLast] = useState(initial.last);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const [hasSignature, setHasSignature] = useState(initial.hasSignature);
  const [version, setVersion] = useState(1);
  const [sig, setSig] = useState<Line>(IDLE);
  const [confirming, setConfirming] = useState(false);
  const question = useRef<HTMLParagraphElement>(null);
  const remover = useRef<HTMLButtonElement>(null);
  const busy = sig.tone === "busy";

  // a refused save: the first marked field takes the focus
  useEffect(() => {
    if (Object.keys(fields).length > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);
  useEffect(() => {
    if (confirming) question.current?.focus();
  }, [confirming]);

  const id = (name: Field) => `${uid}-${name}`;
  const change = (name: Field) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [name]: e.target.value }));
  const errorOf = (name: Field): string | undefined => {
    const code = fields[name];
    if (code === undefined) return undefined;
    // Task 3's codes (CertificateFieldError) have their own words; anything else the general line
    const known: Record<CertificateFieldError, string> & Record<string, string | undefined> = t.errors;
    return known[code] ?? t.errors.other;
  };
  /** A field's marks: invalid when refused, described by its hint and its error. */
  const aria = (name: Field, hint?: string) => ({
    "aria-invalid": errorOf(name) ? (true as const) : undefined,
    "aria-describedby": [hint ? `${id(name)}-hint` : "", errorOf(name) ? `${id(name)}-error` : ""].filter(Boolean).join(" ") || undefined,
  });
  /** A field's label, its input, its hint and its error. */
  const box = (name: Field, label: string, input: ReactNode, hint?: string, className = "") => (
    <div className={`${ui.field} ${className}`}>
      <label htmlFor={id(name)}>{label}</label>
      {input}
      {hint && (
        <p id={`${id(name)}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {errorOf(name) && (
        <p id={`${id(name)}-error`} className={ui.error}>
          {errorOf(name)}
        </p>
      )}
    </div>
  );

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setStatus({ tone: "busy", text: t.saving });
    start(async () => {
      const result = await saveCertificateSettingsAction(draft);
      if (result.ok) {
        setDraft(draftOf(result.settings));
        setLast(result.last);
        setFields({});
        setStatus({ tone: "done", text: t.saved });
      } else if ("fields" in result) {
        setFields(result.fields);
        setStatus({ tone: "error", text: t.invalid });
      } else setStatus({ tone: "error", text: t.error });
    });
  };

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setConfirming(false);
    if (file.size > MAX_SOURCE_BYTES) return setSig({ tone: "error", text: t.signatureErrors.size });
    setSig({ tone: "busy", text: t.preparing });
    let png: Blob;
    try {
      png = await inkSignature(file);
    } catch (e) {
      return setSig({ tone: "error", text: t.signatureErrors[e instanceof InkError ? e.problem : "decode"] });
    }
    if (png.size > SIGNATURE_MAX_BYTES) return setSig({ tone: "error", text: t.signatureErrors.size });
    const sent = await sendSignature(png);
    if (sent !== "ok") return setSig({ tone: "error", text: t.signatureErrors[sent] });
    setHasSignature(true);
    setVersion((v) => v + 1);
    setSig({ tone: "done", text: t.uploaded });
  };

  const remove = async () => {
    if (busy) return;
    setSig({ tone: "busy", text: t.removing });
    const done = await deleteSignature();
    setConfirming(false);
    if (done !== "ok") return setSig({ tone: "error", text: t.signatureErrors[done] });
    setHasSignature(false);
    setSig({ tone: "done", text: t.removed });
  };

  return (
    <section id="tunnistus" className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-certificate-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <form ref={form} onSubmit={save} noValidate data-cert-form="">
        <div className={ed.grid}>
          {box(
            "place",
            t.place,
            <input id={id("place")} className={ui.input} type="text" autoComplete="off" maxLength={CERT_LIMITS.place} value={draft.place} onChange={change("place")} {...aria("place", t.placeHint)} data-cert-place="" />,
            t.placeHint,
          )}
          {box(
            "registryCode",
            t.registryCode,
            <input
              id={id("registryCode")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.registryCode}
              value={draft.registryCode}
              onChange={change("registryCode")}
              {...aria("registryCode")}
              data-cert-registry=""
            />,
          )}
          {box(
            "practicalLine",
            t.practicalLine,
            <input
              id={id("practicalLine")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.practicalLine}
              value={draft.practicalLine}
              onChange={change("practicalLine")}
              {...aria("practicalLine", t.practicalLineHint)}
              data-cert-practical=""
            />,
            t.practicalLineHint,
            ed.wide,
          )}
          {box(
            "trainerName",
            t.trainerName,
            <input
              id={id("trainerName")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.trainerName}
              value={draft.trainerName}
              onChange={change("trainerName")}
              {...aria("trainerName", t.trainerNameHint)}
              data-cert-trainer=""
            />,
            t.trainerNameHint,
          )}
          <fieldset className={ed.fieldset} aria-describedby={`${uid}-next-hint ${uid}-last`}>
            <legend className={ui.legend}>{t.nextNumber}</legend>
            <div className={styles.number}>
              {box(
                "nextYear",
                t.nextYear,
                <input
                  id={id("nextYear")}
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={draft.nextYear}
                  onChange={change("nextYear")}
                  {...aria("nextYear")}
                  data-cert-next-year=""
                />,
              )}
              {box(
                "nextSeq",
                t.nextSeq,
                <input
                  id={id("nextSeq")}
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={draft.nextSeq}
                  onChange={change("nextSeq")}
                  {...aria("nextSeq")}
                  data-cert-next-seq=""
                />,
              )}
            </div>
            <p id={`${uid}-next-hint`} className={ui.hint}>
              {t.nextHint}
            </p>
            <p id={`${uid}-last`} className={ui.hint} data-cert-last="">
              {last ? fill(t.last, { number: last }) : t.lastNone}
            </p>
          </fieldset>
        </div>
        <div className={styles.actions}>
          <p role="status" className={toneClass(status.tone)} data-cert-status="">
            {status.text}
          </p>
          <button type="submit" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} data-cert-save="">
            {pending ? t.saving : t.save}
          </button>
        </div>
      </form>

      <div className={styles.signature} role="group" aria-labelledby={`${uid}-sig`} aria-busy={busy || undefined}>
        <h3 id={`${uid}-sig`} className={ui.h3}>
          {t.signature}
        </h3>
        <p id={`${uid}-sig-hint`} className={ui.hint}>
          {t.signatureHint}
        </p>
        <div className={styles.preview} data-cert-signature="">
          {hasSignature ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private image of the admin API, shown as it is: no optimisation
            <img src={`/api/admin/allkiri?v=${version}`} alt={t.signatureAlt} />
          ) : (
            <p className={styles.none}>{t.signatureNone}</p>
          )}
        </div>
        <div className={styles.tools}>
          <input
            id={`${uid}-file`}
            className={styles.file}
            type="file"
            accept="image/*"
            disabled={busy}
            aria-describedby={`${uid}-sig-hint ${uid}-sig-status`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // the same picture can be picked again
              void pick(file);
            }}
            data-cert-signature-file=""
          />
          <label htmlFor={`${uid}-file`} className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}>
            {hasSignature ? t.replace : t.upload}
          </label>
          {hasSignature && !confirming && (
            <button
              ref={remover}
              type="button"
              className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`}
              aria-disabled={busy || undefined}
              onClick={() => !busy && setConfirming(true)}
              data-cert-signature-remove=""
            >
              {t.remove}
            </button>
          )}
        </div>
        {confirming && (
          <div className={styles.confirm} role="group" aria-labelledby={`${uid}-q`} data-cert-signature-confirm="">
            <p id={`${uid}-q`} ref={question} tabIndex={-1} className={ui.notice}>
              {t.removeConfirm}
            </p>
            <div className={styles.tools}>
              <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={busy || undefined} onClick={() => void remove()}>
                {t.removeYes}
              </button>
              <button
                type="button"
                className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
                onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => remover.current?.focus());
                }}
              >
                {t.removeNo}
              </button>
            </div>
          </div>
        )}
        <p id={`${uid}-sig-status`} role="status" className={toneClass(sig.tone)} data-cert-signature-status={sig.tone}>
          {sig.text}
        </p>
      </div>
    </section>
  );
}
```

  Create `src/components/admin/CertificateSettings.module.css`:

```css
/* Seaded → "Tunnistus" (phase 3d, spec §6): a card of its own after the settings' form and its save bar; the next number's two short fields side
   by side; the signature's preview on black, as the certificate shows it (white ink on a transparent picture), with its upload and removal.
   Every control is the admin's 44 px one; colours from tokens.css only. */

.card {
  margin-top: 25px;
  scroll-margin-top: 20px;
}

.number {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 140px));
  gap: 12px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  margin-top: 22px;
}

.actions p {
  flex: 1 1 260px;
  margin: 0;
}

.signature {
  display: grid;
  gap: 14px;
  min-width: 0;
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.preview {
  display: grid;
  place-items: center;
  width: 100%;
  max-width: 520px;
  min-height: 120px;
  padding: 20px;
  border-radius: 12px;
  background: var(--ink);
}

.preview img {
  display: block;
  max-width: 100%;
  max-height: 160px;
  height: auto;
}

.none {
  margin: 0;
  color: var(--paper);
  font-size: 13px;
  text-align: center;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

/* the file field itself is hidden; its label is the 44 px button (as ImageUpload's) */
.file {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.file:focus-visible + label {
  outline: 2px solid var(--rose);
  outline-offset: 3px;
}

.confirm {
  display: grid;
  gap: 10px;
  max-width: 520px;
}

.confirm p {
  margin: 0;
}

.confirm p:focus {
  outline: 2px solid var(--rose);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .actions button {
    flex: 1 1 100%;
  }
}
```

- [ ] **Step 26: The page** — replace `src/app/admin/(panel)/seaded/page.tsx` with:

```tsx
import type { Metadata } from "next";
import { CertificateSettings } from "@/components/admin/CertificateSettings";
import { adminTitle } from "@/components/admin/sections";
import { SettingsEditor } from "@/components/admin/SettingsEditor";
import { Shell } from "@/components/admin/Shell";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { loadSettings } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";
import { getCertificateSettings, lastIssued } from "@/server/certificates";
import { serverEnv } from "@/server/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.settings) };

/**
 * Seaded: contact details, social links, newsletter discount, legal pages; the admin addresses read-only (Task 13B). Then the e-course
 * certificate's card (phase 3d, spec §6): a form of its own after the settings' form, with its own save and its signature upload (a form
 * cannot sit inside another, and its rules are not a settings part's). The signature's key stays here: the card gets only whether there is one.
 */
export default async function SettingsEditPage() {
  const email = await requireAdmin();
  const db = getDb();
  const [initial, certificate] = await Promise.all([loadSettings(db), getCertificateSettings(db, new Date())]);
  const last = await lastIssued(db, certificate.nextYear);
  // the sign-in allow-list (the environment variable ADMIN_EMAILS): shown, never edited here
  const admins = serverEnv()
    .ADMIN_EMAILS.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <Shell email={email} active="settings">
      <SettingsEditor initial={initial} admins={admins} />
      <CertificateSettings
        initial={{
          place: certificate.place,
          registryCode: certificate.registryCode,
          practicalLine: certificate.practicalLine,
          trainerName: certificate.trainerName,
          nextYear: certificate.nextYear,
          nextSeq: certificate.nextSeq,
          last,
          hasSignature: certificate.signatureKey !== null,
        }}
      />
    </Shell>
  );
}
```

- [ ] **Step 27: The card's texts** — `src/i18n/dict/admin.ts`, after the `clients` block's closing `},` (the line after `attempts: "Testi katsed",` and its `},`), before the comment `// /admin/opilased/<id>/vaade: the student's own "Minu koolitused", read-only`, add:

```ts

  // The e-course certificate (phase 3d, spec §6): Seaded → "Tunnistus" (components/admin/CertificateSettings.tsx). Task 6 adds the drawer's line,
  // "Paranda nimi" and the register here.
  certificates: {
    settings: {
      title: "Tunnistus",
      lead: "Need andmed lähevad igale uuele e-kursuse tunnistusele. Väljastatud tunnistus jääb selliseks, nagu see väljastati; ainult allkiri on igal allalaadimisel praegune.",
      place: "Koht",
      placeHint: "Kuupäeva ees, nt Pärnu linn.",
      registryCode: "Registrikood",
      practicalLine: "Praktilise töö rida",
      practicalLineHint: "Tunnistuse allservas vasakul, suurtähtedega.",
      trainerName: "Koolitaja nimi",
      trainerNameHint: "Kirjutatakse tunnistusele käekirjas, kui allkirja pole.",
      nextNumber: "Järgmine number",
      nextYear: "Aasta",
      nextSeq: "Number",
      nextHint: "Jätka oma paberil tunnistuste numbreid. Uue aasta esimene tunnistus saab numbri 1.",
      last: "Viimati väljastatud: {number}",
      lastNone: "Sel aastal pole veel tunnistusi väljastatud.",
      save: "Salvesta tunnistuse andmed",
      saving: "Salvestan…",
      saved: "Tunnistuse andmed on salvestatud.",
      invalid: "Kontrolli märgitud välju.",
      error: "Salvestamine ei õnnestunud. Proovi uuesti.",
      // server/certificates.ts CertificateFieldError (a bad year is reported on the number, "invalid"); `other` for a code this list does not know
      errors: {
        required: "Täida see väli.",
        tooLong: "Tekst on liiga pikk.",
        invalid: "Kontrolli aastat (2000–2099) ja numbrit (1–99 999).",
        taken: "See number on juba väljastatud. Vali suurem number kui viimati väljastatud.",
        other: "Kontrolli seda välja.",
      },
      signature: "Allkiri",
      signatureHint:
        "Lae üles allkirja PNG-pilt (nt Canvast: hele allkiri läbipaistval taustal või tume allkiri valgel taustal) või tumeda pastakaga valgele paberile kirjutatud allkirja foto. Brauser teeb sellest valge allkirja läbipaistval taustal, nagu see tunnistusel paistab.",
      signatureAlt: "Allkiri, nagu see tunnistusel paistab",
      signatureNone: "Allkirja pole: tunnistusel on koolitaja nimi käekirjas.",
      upload: "Lae allkiri üles",
      replace: "Vaheta allkiri",
      remove: "Eemalda allkiri",
      removeConfirm: "Kas eemaldan allkirja? Tunnistustel on siis koolitaja nimi käekirjas.",
      removeYes: "Jah, eemalda",
      removeNo: "Ei",
      preparing: "Valmistan allkirja ette…",
      removing: "Eemaldan…",
      uploaded: "Allkiri on salvestatud. See on nüüd kõigil tunnistustel, ka varem väljastatutel.",
      removed: "Allkiri on eemaldatud.",
      signatureErrors: {
        decode: "Seda pilti ei saa avada. Vali JPG- või PNG-pilt.",
        empty: "Pildilt ei leitud allkirja. Vali pilt, kus on tume allkiri heledal taustal või hele allkiri läbipaistval taustal.",
        size: "Allkirja pilt on liiga suur.",
        session: "Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti.",
        storage: "Failide salvestamine pole seadistatud — anna arendajale teada.",
        server: "Allkirja salvestamine ei õnnestunud. Proovi uuesti.",
      },
    },
  },
```

- [ ] **Step 28: Run the card tests — expect PASS.** `cd app && npx vitest run tests/unit/certificate-settings-dom.test.ts tests/db/seaded-certificate-page.test.ts` — green.

- [ ] **Step 29: The guards and the lists.**

  1. `tests/unit/admin-guards.test.ts`:
     - in the second `expect(all.map((f) => f.path)).toEqual(expect.arrayContaining([ … ]))` list, after `"server/actions/admin-assessment.ts",` add:

```ts
        // phase 3d: Maria's certificate download, the signature, and the certificate's actions
        "app/api/admin/tunnistus/[id]/route.ts",
        "app/api/admin/allkiri/route.ts",
        "server/actions/admin-certificates.ts",
```

     - in the test "every route under app/api/admin and app/admin is wrapped", the list `["app/api/admin/subscribers.csv/route.ts", … "app/api/admin/hinnang/route.ts"]` gains `"app/api/admin/allkiri/route.ts", "app/api/admin/tunnistus/[id]/route.ts"` at its end;
     - in the test "every admin page calls requireAdmin() itself and every admin action is wrapped", after the three `assessmentActions` lines (before the comment `// It reads and scans every admin source file: …`) add:

```ts
    const certificateActions = files().find((f) => f.path === "server/actions/admin-certificates.ts")!;
    const certificateExports = [...strip(certificateActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(certificateExports).toEqual(["saveCertificateSettingsAction"]);
    expect(violations(certificateActions.path, certificateActions.source)).toEqual([]);
    expect([...strip(certificateActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(certificateExports);
```

  2. `tests/unit/colour-tokens.test.ts`: at the end of `COURSE_CSS`, after `"src/components/admin/Assessment.module.css",` add:

```ts
  // Seaded → "Tunnistus" (phase 3d, Task 5)
  "src/components/admin/CertificateSettings.module.css",
```

  3. `tests/unit/old-safari.test.ts`: at the end of `BROWSER_FILES`, after `"src/components/admin/verdict-taps.ts",` add:

```ts
  // phase 3d, Task 5: the signature's white ink (Seaded's card is a "use client" file, walked anyway)
  "src/lib/signature-ink.ts",
```

- [ ] **Step 30: Run the task's checks.** From `app/`:
  - `npx vitest run` — all green (the new files, the guards, the tokens, the old-Safari walk, the course editor's tests);
  - `npx tsc --noEmit` and `npx eslint .` — clean;
  - E2E (`docker start mslab-pg` if it is not running; migration 0009 is applied locally since Task 1; stop any dev server you started): `npx playwright test admin-edit admin-site` — green on both edit projects. The e-course's type switch still finds one `[data-protocol-stages]` (the skills list has its own hooks); Seaded at 390 px has no sideways scroll and every control of the new card is 44 px tall; the settings' "Salvesta" and `[data-save-status]` are still the only ones of their names.

- [ ] **Step 31: Commit** (from the repository root).

```bash
git add app/src/domain/course-editor.ts app/src/server/admin-content.ts app/src/db/queries/admin.ts app/src/components/admin/ProtocolStagesEditor.tsx app/src/components/admin/CourseEditor.tsx app/src/components/admin/CourseEditor.module.css app/src/lib/shrink-image.ts app/src/lib/signature-ink.ts app/src/app/api/admin/allkiri/route.ts "app/src/app/api/admin/tunnistus/[id]/route.ts" app/src/server/actions/admin-certificates.ts app/src/components/admin/CertificateSettings.tsx app/src/components/admin/CertificateSettings.module.css "app/src/app/admin/(panel)/seaded/page.tsx" app/src/i18n/dict/admin.ts app/tests/unit/signature-ink.test.ts app/tests/unit/certificate-settings-dom.test.ts app/tests/unit/admin-certificates-action.test.ts app/tests/db/admin-signature-route.test.ts app/tests/db/admin-certificate-route.test.ts app/tests/db/seaded-certificate-page.test.ts app/tests/unit/protocol-stages-dom.test.ts app/tests/unit/admin-content.test.ts app/tests/db/admin-content.test.ts app/tests/unit/admin-guards.test.ts app/tests/unit/colour-tokens.test.ts app/tests/unit/old-safari.test.ts
git commit -m "feat(admin): the certificate's settings — the course editor's Tunnistus card, Seaded → Tunnistus with the signature as white ink, Maria's PDF download

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):** the admin is Estonian only.

| Key | ET | Spec/Draft |
|---|---|---|
| `adminEt.courseEditor.sections.certificate` | Tunnistus | Spec (§6 "a 'Tunnistus' card") |
| `adminEt.courseEditor.fields.certificateLead` | E-kursuse tunnistuse tekst. Juba väljastatud tunnistused jäävad selliseks, nagu need väljastati. | Draft |
| `adminEt.courseEditor.fields.certificateSkills` | Oskused tunnistusel | Spec (§6) |
| `adminEt.courseEditor.fields.certificateSkill` | Rida (a field's label: "Rida 1") | Draft |
| `adminEt.courseEditor.fields.certificateSkillsHint` | Tühjana kasutatakse „Mida õpid“ ridu | Spec (§6) |
| `adminEt.courseEditor.fields.certificateSkillsEmpty` | Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read. | Draft (names the editor's own card, which the public page calls „Mida õpid“) |
| `adminEt.courseEditor.fields.certificateSkillsAdd` | Lisa rida | Draft |
| `adminEt.courseEditor.fields.certificateSkillsFull` | Rohkem kui 16 rida ei saa lisada. | Draft |
| `adminEt.courseEditor.fields.certificateVolume` | Maht | Spec (§6) |
| `adminEt.courseEditor.fields.certificateVolumeHint` | nt 10 akadeemilist tundi. Tühjaks jättes tunnistusel ei näidata. | Spec (the example, §6) + Draft (the second sentence, §3) |
| `adminEt.certificates.settings.title` | Tunnistus | Spec (§6) |
| `adminEt.certificates.settings.lead` | Need andmed lähevad igale uuele e-kursuse tunnistusele. Väljastatud tunnistus jääb selliseks, nagu see väljastati; ainult allkiri on igal allalaadimisel praegune. | Draft |
| `adminEt.certificates.settings.place` | Koht | Spec (§6) |
| `adminEt.certificates.settings.placeHint` | Kuupäeva ees, nt Pärnu linn. | Draft |
| `adminEt.certificates.settings.registryCode` | Registrikood | Spec (§6) |
| `adminEt.certificates.settings.practicalLine` | Praktilise töö rida | Spec (§6) |
| `adminEt.certificates.settings.practicalLineHint` | Tunnistuse allservas vasakul, suurtähtedega. | Draft |
| `adminEt.certificates.settings.trainerName` | Koolitaja nimi | Draft |
| `adminEt.certificates.settings.trainerNameHint` | Kirjutatakse tunnistusele käekirjas, kui allkirja pole. | Draft |
| `adminEt.certificates.settings.nextNumber` | Järgmine number | Spec (§4, §6) |
| `adminEt.certificates.settings.nextYear` / `nextSeq` | Aasta / Number | Draft |
| `adminEt.certificates.settings.nextHint` | Jätka oma paberil tunnistuste numbreid. Uue aasta esimene tunnistus saab numbri 1. | Draft |
| `adminEt.certificates.settings.last` | Viimati väljastatud: {number} | Draft |
| `adminEt.certificates.settings.lastNone` | Sel aastal pole veel tunnistusi väljastatud. | Draft |
| `adminEt.certificates.settings.save` | Salvesta tunnistuse andmed | Draft |
| `adminEt.certificates.settings.saving` | Salvestan… | Draft (as `common.saving`) |
| `adminEt.certificates.settings.saved` | Tunnistuse andmed on salvestatud. | Draft |
| `adminEt.certificates.settings.invalid` | Kontrolli märgitud välju. | Draft (as `courseEditor.invalid`) |
| `adminEt.certificates.settings.error` | Salvestamine ei õnnestunud. Proovi uuesti. | Draft (as `common.saveError`) |
| `adminEt.certificates.settings.errors.required` | Täida see väli. | Draft |
| `adminEt.certificates.settings.errors.tooLong` | Tekst on liiga pikk. | Draft (as the editors') |
| `adminEt.certificates.settings.errors.invalid` | Kontrolli aastat (2000–2099) ja numbrit (1–99 999). | Draft (Task 3's ranges) |
| `adminEt.certificates.settings.errors.taken` | See number on juba väljastatud. Vali suurem number kui viimati väljastatud. | Draft (§4's rule) |
| `adminEt.certificates.settings.errors.other` | Kontrolli seda välja. | Draft |
| `adminEt.certificates.settings.signature` | Allkiri | Spec (§6) |
| `adminEt.certificates.settings.signatureHint` | Lae üles allkirja PNG-pilt (nt Canvast: hele allkiri läbipaistval taustal või tume allkiri valgel taustal) või tumeda pastakaga valgele paberile kirjutatud allkirja foto. Brauser teeb sellest valge allkirja läbipaistval taustal, nagu see tunnistusel paistab. | Draft (§6, and the controller's update of 15.10: Maria's Canva export) |
| `adminEt.certificates.settings.signatureAlt` | Allkiri, nagu see tunnistusel paistab | Draft |
| `adminEt.certificates.settings.signatureNone` | Allkirja pole: tunnistusel on koolitaja nimi käekirjas. | Draft (§6 "Seaded says so") |
| `adminEt.certificates.settings.upload` / `replace` | Lae allkiri üles / Vaheta allkiri | Draft |
| `adminEt.certificates.settings.remove` | Eemalda allkiri | Draft |
| `adminEt.certificates.settings.removeConfirm` | Kas eemaldan allkirja? Tunnistustel on siis koolitaja nimi käekirjas. | Draft |
| `adminEt.certificates.settings.removeYes` / `removeNo` | Jah, eemalda / Ei | Draft (as the drawer's confirmations) |
| `adminEt.certificates.settings.preparing` | Valmistan allkirja ette… | Draft |
| `adminEt.certificates.settings.removing` | Eemaldan… | Draft |
| `adminEt.certificates.settings.uploaded` | Allkiri on salvestatud. See on nüüd kõigil tunnistustel, ka varem väljastatutel. | Draft (§9: the signature is not frozen) |
| `adminEt.certificates.settings.removed` | Allkiri on eemaldatud. | Draft |
| `adminEt.certificates.settings.signatureErrors.decode` | Seda pilti ei saa avada. Vali JPG- või PNG-pilt. | Draft |
| `adminEt.certificates.settings.signatureErrors.empty` | Pildilt ei leitud allkirja. Vali pilt, kus on tume allkiri heledal taustal või hele allkiri läbipaistval taustal. | Draft |
| `adminEt.certificates.settings.signatureErrors.size` | Allkirja pilt on liiga suur. | Draft |
| `adminEt.certificates.settings.signatureErrors.session` | Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti. | Draft (as `upload.session`) |
| `adminEt.certificates.settings.signatureErrors.storage` | Failide salvestamine pole seadistatud — anna arendajale teada. | Draft |
| `adminEt.certificates.settings.signatureErrors.server` | Allkirja salvestamine ei õnnestunud. Proovi uuesti. | Draft |

---

### Task 6: Maria's side of an issued certificate — the Õpilased drawer's line, "Paranda nimi", the register `/admin/tunnistused`

Spec §6 (the drawer: "Tunnistus MS LAB 2026-03 · {date}" with "Laada alla", "Paranda nimi", and "Tunnistus: õpilane pole veel nime kinnitanud" before she confirms; the register linked from Hindamine, not in the menu, number, name, course and issue date, newest first, 50 a page, each with its download), §9 (a revoked access: Maria's drawer still shows the certificate, marked "ligipääs tühistatud"), D3 (Maria corrects a name and re-issues under the same number). Review Focus 5 (Maria still sees and downloads a revoked access's certificate) and Review Focus 2 (a name with an emoji or digits is refused with the field error before anything is stored).

**What the drawer shows, per e-course access:**
- **With a certificate** (`[data-access-certificate="<id>"]`): "Tunnistus MS LAB 2026-03 · 19.10.2026" (the Tallinn date of `issued_at`), "nimi parandatud {date}" after a re-issue, "Nimi tunnistusel: {name}", Maria's link "Laada alla" (`[data-certificate-admin-download]`, `/api/admin/tunnistus/<id>`) and `ReissueCertificate` ("Paranda nimi").
- **An access an admin ended** keeps the line and the download, marked "ligipääs tühistatud" (`[data-certificate-revoked]`), without "Paranda nimi": the drawer's rule for an ended access is "its line, nothing that changes it" (Task 13 of the previous phase), and the student cannot download it any more anyway.
- **A completed access without one** (and not ended): "Tunnistus: õpilane pole veel nime kinnitanud" (`[data-access-certificate=""]`). An access not completed: no line.

**"Paranda nimi"** opens a small form in place with the name as printed; "Väljasta uuesti" calls `reissueCertificateAction` (the student's rules in `reissueCertificate`: a refusal is the field's error, nothing stored), and a re-issue refreshes the page (the line and the register show the new name); the line "Tunnistus MS LAB 2026-03 on uuesti väljastatud nimega …" stays and takes the focus. No mail (spec §6).

**The register** `/admin/tunnistused` (`[data-certificate-register]`, a row `[data-register-row="<id>"]`): the admin lists' table (`list-table.module.css`: a narrow screen shows each row as label + value lines), the name a link to her drawer (`/admin/opilased?id=<client>`), each row's "Laada alla" (`[data-register-download]`), the re-issue day and "ligipääs tühistatud" under the date; 50 a page (`?leht=`, `Pager`); "← Hindamisse" back. The shell marks "Hindamine" (it is reached from there). Hindamine's heading gets "Väljastatud tunnistused" (`[data-to-register]`), whether anything waits or not.

**Files:**
- Modify: `app/src/server/admin-clients.ts` (the schema import, line 8; a type import; `ClientAccessRow`, lines 75–100; `clientDetail`, lines 175–216)
- Modify: `app/src/components/admin/ClientDrawer.tsx` (imports; the doc comment of `ClientDetailView`; its first lines; the access row after the step line, lines 103–107), `app/src/components/admin/ClientDrawer.module.css` (appended)
- Create: `app/src/components/admin/ReissueCertificate.tsx`
- Modify: `app/src/server/actions/admin-certificates.ts` (whole file below)
- Create: `app/src/app/admin/(panel)/tunnistused/page.tsx`, `app/src/app/admin/(panel)/tunnistused/register.module.css`
- Modify: `app/src/app/admin/(panel)/hindamine/page.tsx` (the doc comment and the heading)
- Modify: `app/src/i18n/dict/admin.ts` (`certificates`, after `settings`)
- Test: create `app/tests/db/certificate-admin.test.ts`, `app/tests/unit/reissue-certificate-dom.test.ts`; modify `app/tests/unit/admin-certificates-action.test.ts`, `app/tests/unit/admin-guards.test.ts`, `app/tests/unit/colour-tokens.test.ts`, and the action mocks of `app/tests/db/client-drawer-steps.test.ts`, `app/tests/db/feedback-admin-pages.test.ts`, `app/tests/db/payments-admin-pages.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `certificates` (`src/db/schema.ts`: `id, accessId, number, name, issuedAt, reissuedAt`, …); `CERT_LIMITS.nameMax` (80) (`src/domain/certificate.ts`).
  - Task 3 (`src/server/certificates.ts`): `type CertificateView = { id: number; number: string; name: string; issuedAt: string; reissuedAt: string | null }`; `reissueCertificate(db: Db, certificateId: number, rawName: string, now: Date): Promise<{ kind: "reissued"; certificate: CertificateView } | { kind: "invalid"; error: "length" | "letters" } | { kind: "notFound" }>`; `type RegisterRow = { id: number; number: string; name: string; course: string; issuedAt: Date; reissuedAt: Date | null; revoked: boolean; clientId: number }`; `listCertificates(db: Db, page: number): Promise<Paged<RegisterRow>>` (newest first, 50 a page).
  - Task 5: `src/server/actions/admin-certificates.ts` with `saveCertificateSettingsAction`; `adminEt.certificates.settings`; `GET /api/admin/tunnistus/<id>`.
  - Existing: `clientDetail`, `ClientAccessRow` (`src/server/admin-clients.ts`); `ClientDetailView` (`src/components/admin/ClientDrawer.tsx`) with `stepLine` and `CourseSteps.completedAt: string | null`; `Pager`, `list-table.module.css`, `parsePage`, `adminTitle`, `Shell`, `getAdminCounts`; `ecourse`, `student`, `at`, `LATER` (`tests/db/hindamine-fixtures.ts`).
- Produces:
  - `ClientAccessRow.certificate: (CertificateView & { revoked: boolean }) | null` (contract).
  - `reissueCertificateAction = adminAction(async (_admin, input: { certificateId: number; name: string }) => …)` answering `reissueCertificate`'s result or `{ kind: "failed" }` (bad input: `{ kind: "notFound" }`).
  - `src/components/admin/ReissueCertificate.tsx`: `export type ReissueTexts = AdminDict["certificates"]["reissue"] & { saving: string; error: string }`; `export function ReissueCertificate({ certificateId, name, t }: { certificateId: number; name: string; t: ReissueTexts })`. Hooks `[data-reissue]`, `[data-reissue-name]`, `[data-reissue-save]`, `[data-reissue-done]` (contract); **added**: `[data-reissue-form]`, `[data-reissue-error]`.
  - The drawer: `[data-access-certificate]` (contract; its value the certificate's id, or "" on the not-yet line), `[data-certificate-admin-download]` (contract); **added**: `[data-certificate-revoked]`.
  - `/admin/tunnistused`: `[data-certificate-register]`, `[data-register-row="<id>"]` (contract); **added**: `[data-register-download]`, `[data-register-revoked]`, `[data-register-count]`. Hindamine: `[data-to-register]` (contract).
  - Dictionary: `adminEt.certificates.drawer.*`, `adminEt.certificates.reissue.*`, `adminEt.certificates.register.*`.

- [ ] **Step 1: Write the failing page and drawer test** — create `tests/db/certificate-admin.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, clients, courseAccess } from "@/db/schema";
import { at, ecourse, LATER, student, type Student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// Maria's side of an issued certificate (phase 3d, spec §6, §9; Review Focus 5), rendered from a real (PGlite) database to HTML: the
// Õpilased drawer's line (before she confirms; its number and day, the name printed, Maria's download and "Paranda nimi"; a re-issue's day;
// an access an admin ended keeps the line and the download, marked, without "Paranda nimi"), the register /admin/tunnistused (newest first,
// 50 a page, the name to her drawer, each with its download, a re-issue and a revoked access marked) and Hindamine's way to it. The shell and
// the server actions are stand-ins (they need a browser or a request). The certificates are written straight to the database (their issue is
// Task 3's: tests/db/certificates.test.ts).

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test", adminName: () => "Maria" }));
vi.mock("@/components/admin/data", () => ({ getAdminCounts: async () => ({}) }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));

import AssessmentPage from "@/app/admin/(panel)/hindamine/page";
import CertificateRegisterPage from "@/app/admin/(panel)/tunnistused/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const NOW = new Date("2026-10-20T09:00:00Z");

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
});

/** Her certificate "MS LAB 2026-<seq>", issued at `seq` o'clock (UTC) on 19.10.2026 unless `over` says otherwise. */
async function certificate(s: Student, seq: number, name: string, over: Partial<typeof certificates.$inferInsert> = {}) {
  const [row] = await db
    .insert(certificates)
    .values({
      accessId: s.access.id,
      number: `MS LAB 2026-${String(seq).padStart(2, "0")}`,
      year: 2026,
      seq,
      name,
      courseTitle: "Kulmumeistri e-koolitus",
      skills: ["Kulmude kuju"],
      volume: "",
      practicalLine: "Praktiline töö fotodel",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: at(seq),
      ...over,
    })
    .returning();
  return row;
}
const drawer = async (clientId: number) => renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, clientId, NOW))!, ecourses: [], now: NOW }));
const register = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CertificateRegisterPage({ searchParams: Promise.resolve(search) }));
const rowIds = (html: string) => [...html.matchAll(/data-register-row="(\d+)"/g)].map((m) => Number(m[1]));
/** The HTML from `attribute="value"` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};

test("clientDetail: each access's certificate as the drawer shows it, with whether an admin ended the access; null before one", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toBeNull();
  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toEqual({
    id: c.id,
    number: "MS LAB 2026-03",
    name: "Kätlin Kask-Žukova",
    issuedAt: at(3).toISOString(),
    reissuedAt: null,
    revoked: false,
  });
  await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, kati.access.id));
  expect((await clientDetail(db, kati.client.id, NOW))!.access[0].certificate).toMatchObject({ id: c.id, revoked: true });
});

test("the drawer: before she confirms, a line says so; after, the number and day, the name printed, Maria's download and 'Paranda nimi'; a re-issue's day", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  let row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("Tunnistus: õpilane pole veel nime kinnitanud");
  expect(row).not.toContain("data-certificate-admin-download");
  expect(row).not.toContain('data-reissue=""');

  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain(`data-access-certificate="${c.id}"`);
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026");
  expect(row).toContain("Nimi tunnistusel: Kätlin Kask-Žukova");
  expect(row).toContain(`href="/api/admin/tunnistus/${c.id}"`);
  expect(row).toContain("Laada alla");
  expect(row).toContain('data-reissue=""');
  expect(row).toContain("Paranda nimi");
  expect(row).not.toContain("ligipääs tühistatud");
  expect(row).not.toContain("pole veel nime kinnitanud");

  await db.update(certificates).set({ name: "Kätlin Kask", reissuedAt: new Date("2026-10-21T10:00:00Z") }).where(eq(certificates.id, c.id));
  row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("nimi parandatud 21.10.2026");
  expect(row).toContain("Nimi tunnistusel: Kätlin Kask");
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026"); // the number and the day stay
});

test("Review Focus 5: an access an admin ended keeps its certificate's line and Maria's download, marked 'ligipääs tühistatud', without 'Paranda nimi'; an ended one without a certificate says nothing of one", async () => {
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8), revokedAt: NOW });
  const c = await certificate(kati, 3, "Kätlin Kask-Žukova");
  const row = part(await drawer(kati.client.id), "data-access", course.id);
  expect(row).toContain("Tunnistus MS LAB 2026-03 · 19.10.2026");
  expect(row).toContain('data-certificate-revoked=""');
  expect(row).toContain("ligipääs tühistatud");
  expect(row).toContain(`href="/api/admin/tunnistus/${c.id}"`);
  expect(row).not.toContain('data-reissue=""');

  const liis = await student(db, course.id, "Liis", { completedAt: at(8), revokedAt: NOW });
  expect(part(await drawer(liis.client.id), "data-access", course.id)).not.toContain("data-access-certificate");
  const eve = await student(db, course.id, "Eve"); // not completed
  expect(part(await drawer(eve.client.id), "data-access", course.id)).not.toContain("data-access-certificate");
});

test("the register: number, name (to her drawer), course and issue day, newest first, each with its download; a re-issue's day and an ended access marked", async () => {
  const course = await ecourse(db, { test: null });
  const anu = await student(db, course.id, "Anu", { completedAt: at(8) });
  const eve = await student(db, course.id, "Eve", { completedAt: at(8) });
  const first = await certificate(anu, 1, "Anu Kask");
  const second = await certificate(eve, 2, "Eve Tamm", { reissuedAt: at(9) });
  await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, eve.access.id));
  const html = await register();
  expect(html).toContain('data-shell-active="assessment"');
  expect(html).toContain("data-certificate-register");
  expect(rowIds(html)).toEqual([second.id, first.id]);
  expect(html).toContain("Tunnistusi: 2");
  const row = part(html, "data-register-row", second.id);
  for (const text of ["MS LAB 2026-02", "Eve Tamm", "Kulmumeistri e-koolitus", "19.10.2026", "nimi parandatud 19.10.2026", "ligipääs tühistatud"]) expect(row, text).toContain(text);
  expect(row).toContain(`href="/admin/opilased?id=${eve.client.id}"`);
  expect(row).toContain(`href="/api/admin/tunnistus/${second.id}"`);
  const other = part(html, "data-register-row", first.id);
  expect(other).not.toContain("ligipääs tühistatud");
  expect(other).not.toContain("parandatud");
  expect(html).toContain('href="/admin/hindamine"'); // the way back
});

test("the register: nothing issued says so; 50 a page, the pager to the next (?leht=2)", async () => {
  expect(await register()).toContain("Tunnistusi pole veel väljastatud.");
  const course = await ecourse(db, { test: null });
  const people = await db
    .insert(clients)
    .values(Array.from({ length: 51 }, (_, i) => ({ email: `s${i}@example.test`, name: `Õpilane ${i}` })))
    .returning();
  const accesses = await db
    .insert(courseAccess)
    .values(people.map((p) => ({ clientId: p.id, courseId: course.id, grantedBy: "maria@example.test", expiresAt: LATER, completedAt: at(1) })))
    .returning();
  await db.insert(certificates).values(
    accesses.map((a, i) => ({
      accessId: a.id,
      number: `MS LAB 2026-${String(i + 1).padStart(2, "0")}`,
      year: 2026,
      seq: i + 1,
      name: `Õpilane ${i}`,
      courseTitle: "Kulmumeistri e-koolitus",
      skills: [],
      volume: "",
      practicalLine: "Praktiline töö fotodel",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
    })),
  );
  const page1 = await register();
  expect(rowIds(page1)).toHaveLength(50);
  expect(page1).toContain('href="/admin/tunnistused?leht=2"');
  expect(page1).not.toContain("MS LAB 2026-01<"); // the oldest is on the next page
  const page2 = await register({ leht: "2" });
  expect(rowIds(page2)).toHaveLength(1);
  expect(page2).toContain("MS LAB 2026-01");
});

test("Hindamine links the register ('Väljastatud tunnistused'), whether anything waits or not", async () => {
  const html = renderToStaticMarkup(await AssessmentPage());
  expect(html).toContain("Kõik on hinnatud.");
  const tag = /<a[^>]*data-to-register=""[^>]*>/.exec(html)?.[0] ?? "";
  expect(tag).toContain('href="/admin/tunnistused"');
  expect(part(html, "data-to-register", "")).toContain("Väljastatud tunnistused");
});
```

- [ ] **Step 2: Write the failing form test** — create `tests/unit/reissue-certificate-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { adminEt } from "@/i18n/dict/admin";

// "Paranda nimi" in a student's drawer (phase 3d, spec §6, D3; Review Focus 2) in a browser-like document (happy-dom), with the server action
// answered here: the form in place with the name as printed, the student's rules' refusals on the field, the line that says what was done
// (it stays, and takes the focus), "Katkesta", and a certificate gone meanwhile or a failure.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: action }));

import { ReissueCertificate } from "@/components/admin/ReissueCertificate";

const t = { ...adminEt.certificates.reissue, saving: adminEt.common.saving, error: adminEt.common.saveError };
const VIEW = { id: 7, number: "MS LAB 2026-03", name: "Kätlin Kask", issuedAt: "2026-10-19T10:00:00.000Z", reissuedAt: "2026-10-20T09:00:00.000Z" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async () => {
  await act(async () => root.render(createElement(ReissueCertificate, { certificateId: 7, name: "Kätlin Kask-Žukova", t })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-reissue-form]")!.requestSubmit());
  await settle();
};
const field = () => $<HTMLInputElement>("[data-reissue-name]")!;

beforeEach(() => {
  action.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ReissueCertificate", () => {
  test("one button; its form has the name as printed, which takes the focus; 'Katkesta' closes it with the focus back on the button, nothing sent", async () => {
    await show();
    expect($("[data-reissue]")!.textContent).toBe("Paranda nimi");
    expect($("[data-reissue-form]")).toBeNull();
    await click($("[data-reissue]"));
    expect(field().value).toBe("Kätlin Kask-Žukova");
    expect(document.activeElement).toBe(field());
    expect(container.querySelector(`label[for="${field().id}"]`)!.textContent).toBe("Nimi tunnistusel");
    expect(container.textContent).toContain("Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta.");
    expect($("[data-reissue-save]")!.textContent).toBe("Väljasta uuesti");
    await click(button("Katkesta"));
    expect($("[data-reissue-form]")).toBeNull();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe($("[data-reissue]"));
    expect(action).not.toHaveBeenCalled();
  });

  test("'Väljasta uuesti' sends the certificate and the name as typed; re-issued: the line says so under the same number and takes the focus", async () => {
    action.mockResolvedValue({ kind: "reissued", certificate: VIEW });
    await show();
    await click($("[data-reissue]"));
    await type(field(), " Kätlin  Kask ");
    await submit();
    expect(action.mock.calls).toEqual([[{ certificateId: 7, name: " Kätlin  Kask " }]]);
    expect($("[data-reissue-form]")).toBeNull();
    const done = $("[data-reissue-done]")!;
    expect(done.textContent).toBe("Tunnistus MS LAB 2026-03 on uuesti väljastatud nimega Kätlin Kask.");
    expect(document.activeElement).toBe(done);
    expect($("[data-reissue]")).not.toBeNull(); // another correction stays possible
  });

  test("Review Focus 2: an emoji or digits, or a name too short, are refused on the field in the student's words; the form stays with what was typed", async () => {
    action.mockResolvedValueOnce({ kind: "invalid", error: "letters" });
    await show();
    await click($("[data-reissue]"));
    await type(field(), "Kati 😀");
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Kasuta nimes ainult tähti, tühikuid ja sidekriipse");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toContain($("[data-reissue-error]")!.id);
    expect(field().value).toBe("Kati 😀");
    expect(document.activeElement).toBe(field());
    action.mockResolvedValueOnce({ kind: "invalid", error: "length" });
    await type(field(), "K");
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Nimi peab olema 2–80 märki.");
    expect($("[data-reissue-done]")!.textContent).toBe("");
  });

  test("a certificate gone meanwhile, or a failure, says so; the form stays open", async () => {
    action.mockResolvedValueOnce({ kind: "notFound" });
    await show();
    await click($("[data-reissue]"));
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Seda tunnistust ei leitud. Laadi leht uuesti.");
    action.mockResolvedValueOnce({ kind: "failed" });
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-reissue-form]")).not.toBeNull();
  });
});
```

- [ ] **Step 3: Extend the action test** — in `tests/unit/admin-certificates-action.test.ts`, the line

```ts
const { saveCertificateSettingsAction } = await import("@/server/actions/admin-certificates");
```

  becomes

```ts
const { reissueCertificateAction, saveCertificateSettingsAction } = await import("@/server/actions/admin-certificates");
```

  and at the end of the file add:

```ts
test("'Paranda nimi' passes on the certificate and the name as typed; re-issued, the page is refreshed; invalid and notFound as they came without a refresh; bad input is notFound; a throw is 'failed', logged by the certificate's id", async () => {
  const view = { id: 7, number: "MS LAB 2026-03", name: "Kätlin Kask", issuedAt: "2026-10-19T10:00:00.000Z", reissuedAt: "2026-10-20T09:00:00.000Z" };
  work.reissueCertificate.mockResolvedValueOnce({ kind: "reissued", certificate: view });
  expect(await reissueCertificateAction({ certificateId: 7, name: " Kätlin  Kask " })).toEqual({ kind: "reissued", certificate: view });
  expect(work.reissueCertificate.mock.calls[0].slice(1, 3)).toEqual([7, " Kätlin  Kask "]);
  expect(work.reissueCertificate.mock.calls[0][3]).toBeInstanceOf(Date);
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  work.reissueCertificate.mockResolvedValueOnce({ kind: "invalid", error: "letters" });
  expect(await reissueCertificateAction({ certificateId: 7, name: "Kati 😀" })).toEqual({ kind: "invalid", error: "letters" });
  work.reissueCertificate.mockResolvedValueOnce({ kind: "notFound" });
  expect(await reissueCertificateAction({ certificateId: 8, name: "Kati Kask" })).toEqual({ kind: "notFound" });
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  for (const bad of [{ certificateId: 0, name: "Kati" }, { certificateId: 1.5, name: "Kati" }, { certificateId: 7 }, { certificateId: 7, name: "x".repeat(1025) }, { name: "Kati" }])
    expect(await reissueCertificateAction(bad as never), JSON.stringify(bad).slice(0, 60)).toEqual({ kind: "notFound" });
  expect(work.reissueCertificate).toHaveBeenCalledTimes(3);
  work.reissueCertificate.mockRejectedValueOnce(new TypeError("boom: Kätlin"));
  expect(await reissueCertificateAction({ certificateId: 7, name: "Kätlin Kask" })).toEqual({ kind: "failed" });
  const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(logged).toContain("[certificate] 7: the re-issue failed: TypeError");
  expect(logged).not.toContain("Kätlin");
});
```

- [ ] **Step 4: Run them — expect FAIL.** `cd app && npx vitest run tests/db/certificate-admin.test.ts tests/unit/reissue-certificate-dom.test.ts tests/unit/admin-certificates-action.test.ts`: the first two cannot import (`Failed to resolve import "@/app/admin/(panel)/tunnistused/page"`, `…/ReissueCertificate"`); the action test fails with `reissueCertificateAction is not a function`.

- [ ] **Step 5: The drawer's data** (`src/server/admin-clients.ts`).

  1. The schema import (line 8) gains `certificates`:

```ts
import { certificates, clients, courseAccess, courses, lessonProgress, practicePackages, protocols, registrations, requests, termsAcceptances, testAttempts } from "@/db/schema";
```

  and after `import { loadSteps } from "./completion";` add `import type { CertificateView } from "./certificates";`.

  2. In `ClientAccessRow`, after `hasAttempts: boolean;` add:

```ts
  /**
   * Her certificate of this e-course (phase 3d, spec §6), or null before she has confirmed her name; `revoked`: an admin ended the access, so
   * she can no longer download it (Maria still can, Review Focus 5).
   */
  certificate: (CertificateView & { revoked: boolean }) | null;
```

  3. Before `/** Everything the student's drawer shows, …` (the doc comment of `clientDetail`) add:

```ts
/** A certificate row as the drawer shows it (server/certificates.ts CertificateView), with whether an admin ended her access. */
const certificateView = (c: { id: number; number: string; name: string; issuedAt: Date; reissuedAt: Date | null } | undefined, revoked: boolean): ClientAccessRow["certificate"] =>
  c ? { id: c.id, number: c.number, name: c.name, issuedAt: c.issuedAt.toISOString(), reissuedAt: c.reissuedAt?.toISOString() ?? null, revoked } : null;

```

  4. In `clientDetail`, the line

```ts
  const [outlines, steps, accessProtocols, registrationProtocols, attempts] = await Promise.all([
```

  becomes

```ts
  const [outlines, steps, accessProtocols, registrationProtocols, attempts, issued] = await Promise.all([
```

  and after the last entry of that `Promise.all` — the line `db.select({ courseId: testAttempts.courseId, number: testAttempts.number, correct: testAttempts.correct, total: testAttempts.total }).from(testAttempts).where(eq(testAttempts.clientId, id)),` — add:

```ts
    // her certificates (phase 3d): at most one per access
    access.length
      ? db
          .select({ id: certificates.id, accessId: certificates.accessId, number: certificates.number, name: certificates.name, issuedAt: certificates.issuedAt, reissuedAt: certificates.reissuedAt })
          .from(certificates)
          .where(inArray(certificates.accessId, access.map((a) => a.id)))
      : [],
```

  5. After `const registrationProtocol = new Map(registrationProtocols.map((p) => [p.registrationId, p.id]));` add:

```ts
  const certificateOf = new Map(issued.map((c) => [c.accessId, c]));
```

  6. In the access map's returned object, after `hasAttempts: newest.has(a.courseId),` add:

```ts
        certificate: certificateView(certificateOf.get(a.id), a.revokedAt !== null),
```

- [ ] **Step 6: "Paranda nimi"** — create `src/components/admin/ReissueCertificate.tsx`:

```tsx
"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import type { AdminDict } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { reissueCertificateAction } from "@/server/actions/admin-certificates";
import ui from "./ui.module.css";
import forms from "./RegistrationForms.module.css";
import styles from "./ClientDrawer.module.css";

export type ReissueTexts = AdminDict["certificates"]["reissue"] & { saving: string; error: string };

/**
 * "Paranda nimi" (phase 3d, spec §6, D3) on a certificate in a student's drawer: a small form in place with the name as it is printed; the
 * same rules as hers (server/certificates.ts reissueCertificate: 2–80 characters, letters of the Latin or Cyrillic script, spaces, hyphens,
 * apostrophes and dots; Review Focus 2: an emoji or digits are refused on the field, nothing stored). "Väljasta uuesti" re-issues it under
 * the same number, sets its re-issue day and mails nobody; the page is refreshed (the drawer's line and the register show the new name), and
 * the line that says what was done stays and takes the focus. "Katkesta" closes the form with the focus back on the button.
 */
export function ReissueCertificate({ certificateId, name, t }: { certificateId: number; name: string; t: ReissueTexts }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [pending, start] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const doneLine = useRef<HTMLParagraphElement>(null);

  // the form opened, or a refusal: the field has the focus
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open, error]);
  useEffect(() => {
    if (done) doneLine.current?.focus();
  }, [done]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      const result = await reissueCertificateAction({ certificateId, name: value });
      if (result.kind === "reissued") {
        setError("");
        setOpen(false);
        setDone(fill(t.done, { number: result.certificate.number, name: result.certificate.name }));
      } else if (result.kind === "invalid") setError(t.errors[result.error]);
      else setError(result.kind === "notFound" ? t.errors.notFound : t.error);
    });
  };

  return (
    <>
      {!open && (
        <button
          ref={opener}
          type="button"
          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
          onClick={() => {
            setValue(name);
            setError("");
            setDone("");
            setOpen(true);
          }}
          data-reissue=""
        >
          {t.button}
        </button>
      )}
      {open && (
        <form className={styles.confirm} onSubmit={save} noValidate data-reissue-form="">
          <div className={ui.field}>
            <label htmlFor={`${uid}-name`}>{t.label}</label>
            <input
              ref={field}
              id={`${uid}-name`}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.nameMax}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
              data-reissue-name=""
            />
            <p id={`${uid}-hint`} className={ui.hint}>
              {t.hint}
            </p>
            {error && (
              <p id={`${uid}-error`} role="alert" className={ui.error} data-reissue-error="">
                {error}
              </p>
            )}
          </div>
          <div className={forms.actions}>
            <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-reissue-save="">
              {pending ? t.saving : t.save}
            </button>
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
              onClick={() => {
                setOpen(false);
                setError("");
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              {t.cancel}
            </button>
          </div>
        </form>
      )}
      <p ref={doneLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.done}`} data-reissue-done="">
        {done}
      </p>
    </>
  );
}
```

- [ ] **Step 7: The action** — replace `src/server/actions/admin-certificates.ts` with:

```ts
"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { lastIssued, reissueCertificate, saveCertificateSettings } from "../certificates";
import { logFailure } from "../log";

// The e-course certificate's admin actions (phase 3d, spec §6): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../certificates.ts. Seaded's "Tunnistus" card keeps its own state, so its save refreshes nothing; "Paranda nimi" refreshes the open page (the
// drawer's line and the register show the new name). The signature is not an action but a route (app/api/admin/allkiri): a file is a
// multipart upload, and its preview needs a GET.

/**
 * Seaded → "Tunnistus" → "Salvesta tunnistuse andmed": the card's fields as typed (`{ place, registryCode, practicalLine, trainerName, nextYear,
 * nextSeq }`, the two numbers as text), checked by saveCertificateSettings (a next number at or below one already issued in that year is
 * refused on `nextSeq`, "taken": Review Focus 4). Saved: the settings as stored without the signature's key (it never goes to the browser) and
 * the number last issued in the saved year. A throw is { ok: false, error: "server" }, logged by its label only.
 */
export const saveCertificateSettingsAction = adminAction(async (_admin, raw: unknown) => {
  try {
    const db = getDb();
    const result = await saveCertificateSettings(db, raw, new Date());
    if (!result.ok) return { ok: false as const, fields: result.fields };
    const s = result.settings;
    // named one by one: the signature's key is left behind on purpose
    const settings = { place: s.place, registryCode: s.registryCode, practicalLine: s.practicalLine, trainerName: s.trainerName, nextYear: s.nextYear, nextSeq: s.nextSeq };
    return { ok: true as const, settings, last: await lastIssued(db, settings.nextYear) };
  } catch (e) {
    logFailure("[certificate] the settings save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});

const reissueInput = z.object({ certificateId: z.number().int().positive().max(2_147_483_647), name: z.string().max(1024) });

/**
 * The drawer's "Paranda nimi" (spec §6, D3): one certificate, the name as typed; reissueCertificate checks it with the student's rules and
 * re-issues under the same number (`reissued_at`), mailing nobody. Re-issued: the open page is refreshed. Bad input is notFound; a throw is
 * "failed", logged by the certificate's id only (never the name).
 */
export const reissueCertificateAction = adminAction(async (_admin, input: { certificateId: number; name: string }) => {
  const parsed = reissueInput.safeParse(input);
  if (!parsed.success) return { kind: "notFound" as const };
  try {
    const result = await reissueCertificate(getDb(), parsed.data.certificateId, parsed.data.name, new Date());
    if (result.kind === "reissued") refresh();
    return result;
  } catch (e) {
    logFailure(`[certificate] ${parsed.data.certificateId}: the re-issue failed`, e);
    return { kind: "failed" as const };
  }
});
```

- [ ] **Step 8: The drawer's line** (`src/components/admin/ClientDrawer.tsx`).

  1. After `import { PaymentLines } from "./PaymentLines";` add `import { ReissueCertificate } from "./ReissueCertificate";`.

  2. In the doc comment of `ClientDetailView`, the words `"Testi katsed" and, while her tries are used up, "Ava test uuesti" (an access an admin ended keeps only its line);` become `"Testi katsed" and, while her tries are used up, "Ava test uuesti" (an access an admin ended keeps only its line); her certificate (phase 3d, spec §6): its number and day with Maria's download and "Paranda nimi", or, on a completed access, that she has not confirmed her name yet (an ended access keeps the certificate's line and download, marked "ligipääs tühistatud");`.

  3. After `const reopen = { ...adminEt.assessment.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };` add:

```tsx
  const ct = adminEt.certificates.drawer;
  const reissue = { ...adminEt.certificates.reissue, saving: adminEt.common.saving, error: adminEt.common.saveError };
```

  4. The block

```tsx
                  {line && (
                    <p className={styles.meta} data-access-steps="">
                      {line}
                    </p>
                  )}
```

  becomes

```tsx
                  {line && (
                    <p className={styles.meta} data-access-steps="">
                      {line}
                    </p>
                  )}
                  {/* her certificate (phase 3d, spec §6): the number and day, the name printed, Maria's download and "Paranda nimi"; an access an
                      admin ended keeps the line and the download, marked (Review Focus 5); a completed access without one says she has not
                      confirmed her name yet */}
                  {a.certificate ? (
                    <div className={styles.certificate} data-access-certificate={a.certificate.id}>
                      <p className={styles.meta}>
                        <span>{fill(ct.line, { number: a.certificate.number, date: formatDate(new Date(a.certificate.issuedAt), "et") })}</span>
                        {a.certificate.reissuedAt && <span>{fill(ct.reissued, { date: formatDate(new Date(a.certificate.reissuedAt), "et") })}</span>}
                        {a.certificate.revoked && (
                          <span className={`${ui.tag} ${ui.bad}`} data-certificate-revoked="">
                            {ct.revoked}
                          </span>
                        )}
                      </p>
                      <p className={styles.meta}>{fill(ct.name, { name: a.certificate.name })}</p>
                      <a
                        className={ui.link}
                        href={`/api/admin/tunnistus/${a.certificate.id}`}
                        aria-label={fill(ct.downloadLabel, { number: a.certificate.number })}
                        data-certificate-admin-download=""
                      >
                        {ct.download}
                      </a>
                      {live && <ReissueCertificate certificateId={a.certificate.id} name={a.certificate.name} t={reissue} />}
                    </div>
                  ) : (
                    live &&
                    a.steps.completedAt && (
                      <p className={styles.meta} data-access-certificate="">
                        {ct.notYet}
                      </p>
                    )
                  )}
```

  (`live` is the row's existing `const live = a.state !== "revoked";`, declared before the row's `return`.)

  5. `src/components/admin/ClientDrawer.module.css`, at the end:

```css
/* an e-course's certificate (phase 3d): its line, the name printed, the download and "Paranda nimi", one under another */
.certificate {
  display: grid;
  justify-items: start;
  gap: 4px;
  margin-top: 6px;
}
```

- [ ] **Step 9: The register** — create `src/app/admin/(panel)/tunnistused/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { parsePage } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { listCertificates } from "@/server/certificates";
import styles from "./register.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.certificates.register.title) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Tunnistused (phase 3d, spec §6): every issued e-course certificate, newest first, 50 a page (?leht=) — its number, the name printed (a link
 * to her drawer in Õpilased), the course's title as printed, the issue day (and the re-issue day; "ligipääs tühistatud" for an access an admin
 * ended: Maria's download works all the same, Review Focus 5) and "Laada alla". Reached from Hindamine, not from the menu: the shell marks
 * Hindamine.
 */
export default async function CertificateRegisterPage({ searchParams }: Props) {
  const email = await requireAdmin();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list] = await Promise.all([listCertificates(getDb(), parsePage((await searchParams).leht)), getAdminCounts()]);
  const t = adminEt.certificates.register;

  return (
    <Shell email={email} active="assessment">
      <div className={ui.page} data-certificate-register="">
        <p className={styles.back}>
          <Link className={ui.link} href="/admin/hindamine">
            <span aria-hidden="true">←</span> {t.back}
          </Link>
        </p>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small}`} data-register-count="">
            {fill(t.count, { n: list.total })}
          </p>
          {list.rows.length === 0 ? (
            <p className={ui.empty}>{t.empty}</p>
          ) : (
            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.number}</th>
                  <th scope="col">{t.col.name}</th>
                  <th scope="col">{t.col.course}</th>
                  <th scope="col">{t.col.issued}</th>
                  <th scope="col">{t.col.file}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={r.id} data-register-row={r.id}>
                    <td data-label={t.col.number} className={ui.nowrap}>
                      <strong>{r.number}</strong>
                    </td>
                    <td data-label={t.col.name}>
                      <Link className={listTable.name} href={`/admin/opilased?id=${r.clientId}`} aria-label={fill(t.openStudent, { name: r.name })}>
                        {r.name}
                      </Link>
                    </td>
                    <td data-label={t.col.course}>{r.course}</td>
                    <td data-label={t.col.issued}>
                      <span className={styles.issued}>
                        <span className={ui.nowrap}>{formatDate(r.issuedAt, "et")}</span>
                        {r.reissuedAt && <span className={styles.note}>{fill(t.reissued, { date: formatDate(r.reissuedAt, "et") })}</span>}
                        {r.revoked && (
                          <span className={`${ui.tag} ${ui.bad}`} data-register-revoked="">
                            {t.revoked}
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label={t.col.file}>
                      <a className={ui.link} href={`/api/admin/tunnistus/${r.id}`} aria-label={fill(t.downloadLabel, { number: r.number })} data-register-download="">
                        {t.download}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => `/admin/tunnistused${n > 1 ? `?leht=${n}` : ""}`} />
        </section>
      </div>
    </Shell>
  );
}
```

  Create `src/app/admin/(panel)/tunnistused/register.module.css`:

```css
/* The certificate register (phase 3d, spec §6): the way back to Hindamine, and in a row's issue cell the re-issue day and the "ligipääs
   tühistatud" mark under the date. The table is the admin lists' (components/admin/list-table.module.css: on a narrow screen each row is a
   block of label + value lines). Colours from tokens.css only. */

.back {
  margin: 0 0 18px;
}

.issued {
  display: grid;
  justify-items: start;
  gap: 4px;
}

.note {
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 10: Hindamine's way to it** (`src/app/admin/(panel)/hindamine/page.tsx`).

  1. In the doc comment of `AssessmentPage`, after `Each group has an anchor the overview's card links to.` add ` Its heading links the certificate register (/admin/tunnistused, phase 3d), which is not in the menu.`

  2. The heading

```tsx
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>
```

  becomes

```tsx
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href="/admin/tunnistused" data-to-register="">
            {adminEt.certificates.register.fromAssessment}
          </Link>
        </div>
```

- [ ] **Step 11: The texts** — `src/i18n/dict/admin.ts`, in `certificates`, the end of the `settings` block

```ts
        server: "Allkirja salvestamine ei õnnestunud. Proovi uuesti.",
      },
    },
```

  becomes

```ts
        server: "Allkirja salvestamine ei õnnestunud. Proovi uuesti.",
      },
    },
    // the Õpilased drawer's line about an access's certificate (components/admin/ClientDrawer.tsx); {date}: dd.mm.yyyy in Tallinn
    drawer: {
      line: "Tunnistus {number} · {date}",
      reissued: "nimi parandatud {date}",
      name: "Nimi tunnistusel: {name}",
      download: "Laada alla",
      downloadLabel: "Laada alla tunnistus {number}",
      notYet: "Tunnistus: õpilane pole veel nime kinnitanud",
      revoked: "ligipääs tühistatud",
    },
    // "Paranda nimi" (components/admin/ReissueCertificate.tsx): the student's rules, the same number, no mail
    reissue: {
      button: "Paranda nimi",
      label: "Nimi tunnistusel",
      hint: "Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta.",
      save: "Väljasta uuesti",
      cancel: "Katkesta",
      done: "Tunnistus {number} on uuesti väljastatud nimega {name}.",
      errors: {
        length: "Nimi peab olema 2–80 märki.",
        letters: "Kasuta nimes ainult tähti, tühikuid ja sidekriipse",
        notFound: "Seda tunnistust ei leitud. Laadi leht uuesti.",
      },
    },
    // /admin/tunnistused, from Hindamine's heading ("Väljastatud tunnistused")
    register: {
      fromAssessment: "Väljastatud tunnistused",
      eyebrow: "Hindamine",
      title: "Tunnistused",
      lead: "Kõik väljastatud e-kursuse tunnistused, uusimad eespool.",
      back: "Hindamisse",
      count: "Tunnistusi: {n}",
      empty: "Tunnistusi pole veel väljastatud.",
      col: { number: "Number", name: "Nimi", course: "Koolitus", issued: "Väljastatud", file: "Tunnistus" },
      reissued: "nimi parandatud {date}",
      revoked: "ligipääs tühistatud",
      openStudent: "Ava õpilane {name}",
      download: "Laada alla",
      downloadLabel: "Laada alla tunnistus {number}",
    },
```

- [ ] **Step 12: The tests that render the drawer** stand in for the new action file too. In `tests/db/client-drawer-steps.test.ts`, `tests/db/feedback-admin-pages.test.ts` and `tests/db/payments-admin-pages.test.ts`, after the line `vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: vi.fn() }));` add:

```ts
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn(), reissueCertificateAction: vi.fn() }));
```

- [ ] **Step 13: The guards and the colours.**
  1. `tests/unit/admin-guards.test.ts`:
     - in the second `expect.arrayContaining([...])` list, after the three lines Task 5 added, add:

```ts
        // phase 3d, Task 6: the certificate register (from Hindamine)
        "app/admin/(panel)/tunnistused/page.tsx",
```

     - `expect(pages.length).toBeGreaterThanOrEqual(16);` becomes `expect(pages.length).toBeGreaterThanOrEqual(23);` (22 pages before this task, and the register);
     - `expect(certificateExports).toEqual(["saveCertificateSettingsAction"]);` becomes `expect(certificateExports).toEqual(["saveCertificateSettingsAction", "reissueCertificateAction"]);`.
  2. `tests/unit/colour-tokens.test.ts`: at the end of `COURSE_CSS`, after Task 5's line, add:

```ts
  // the certificate register (phase 3d, Task 6)
  "src/app/admin/(panel)/tunnistused/register.module.css",
```

- [ ] **Step 14: Run them — expect PASS.** `cd app && npx vitest run tests/db/certificate-admin.test.ts tests/unit/reissue-certificate-dom.test.ts tests/unit/admin-certificates-action.test.ts tests/db/client-drawer-steps.test.ts tests/db/feedback-admin-pages.test.ts tests/db/payments-admin-pages.test.ts tests/db/assessment-admin.test.ts tests/unit/admin-guards.test.ts tests/unit/colour-tokens.test.ts` — green.

- [ ] **Step 15: Run the task's checks.** From `app/`:
  - `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — green and clean;
  - E2E (`docker start mslab-pg` first; stop any dev server you started): `npx playwright test admin-clients admin-inbox completion` — green. The drawer's flows ("Ava ligipääs", "Lõpeta ligipääs", "Ava järgmine õppetund", "Lisa protokoll") are unchanged; a completed access in completion.spec's drawer now has the line "Tunnistus: õpilane pole veel nime kinnitanud", which no existing assertion excludes; Hindamine's heading has one more 44 px button; the widths test of completion.spec (390–1440 px, Hindamine included) stays without sideways scroll.

- [ ] **Step 16: Commit** (from the repository root).

```bash
git add app/src/server/admin-clients.ts app/src/components/admin/ClientDrawer.tsx app/src/components/admin/ClientDrawer.module.css app/src/components/admin/ReissueCertificate.tsx app/src/server/actions/admin-certificates.ts "app/src/app/admin/(panel)/tunnistused/page.tsx" "app/src/app/admin/(panel)/tunnistused/register.module.css" "app/src/app/admin/(panel)/hindamine/page.tsx" app/src/i18n/dict/admin.ts app/tests/db/certificate-admin.test.ts app/tests/unit/reissue-certificate-dom.test.ts app/tests/unit/admin-certificates-action.test.ts app/tests/unit/admin-guards.test.ts app/tests/unit/colour-tokens.test.ts app/tests/db/client-drawer-steps.test.ts app/tests/db/feedback-admin-pages.test.ts app/tests/db/payments-admin-pages.test.ts
git commit -m "feat(admin): the certificate in the student's drawer, 'Paranda nimi' under the same number, the register /admin/tunnistused from Hindamine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):** the admin is Estonian only.

| Key | ET | Spec/Draft |
|---|---|---|
| `adminEt.certificates.drawer.line` | Tunnistus {number} · {date} | Spec (§6 "Tunnistus MS LAB 2026-03 · {date}") |
| `adminEt.certificates.drawer.reissued` | nimi parandatud {date} | Draft |
| `adminEt.certificates.drawer.name` | Nimi tunnistusel: {name} | Draft (the student's field "Nimi tunnistusel", §5) |
| `adminEt.certificates.drawer.download` | Laada alla | Spec (§6; Dim may prefer the imperative "Laadi alla", as the student's "Laadi tunnistus alla") |
| `adminEt.certificates.drawer.downloadLabel` | Laada alla tunnistus {number} | Draft (the link's accessible name) |
| `adminEt.certificates.drawer.notYet` | Tunnistus: õpilane pole veel nime kinnitanud | Spec (§6) |
| `adminEt.certificates.drawer.revoked` | ligipääs tühistatud | Spec (§9) |
| `adminEt.certificates.reissue.button` | Paranda nimi | Spec (§6) |
| `adminEt.certificates.reissue.label` | Nimi tunnistusel | Spec (§5's field) |
| `adminEt.certificates.reissue.hint` | Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta. | Draft (§6: same number, no mail) |
| `adminEt.certificates.reissue.save` | Väljasta uuesti | Draft |
| `adminEt.certificates.reissue.cancel` | Katkesta | Draft |
| `adminEt.certificates.reissue.done` | Tunnistus {number} on uuesti väljastatud nimega {name}. | Draft |
| `adminEt.certificates.reissue.errors.length` | Nimi peab olema 2–80 märki. | Draft |
| `adminEt.certificates.reissue.errors.letters` | Kasuta nimes ainult tähti, tühikuid ja sidekriipse | Spec (§5) |
| `adminEt.certificates.reissue.errors.notFound` | Seda tunnistust ei leitud. Laadi leht uuesti. | Draft |
| `adminEt.certificates.register.fromAssessment` | Väljastatud tunnistused | Draft |
| `adminEt.certificates.register.eyebrow` | Hindamine | Draft (the section it is reached from) |
| `adminEt.certificates.register.title` | Tunnistused | Draft |
| `adminEt.certificates.register.lead` | Kõik väljastatud e-kursuse tunnistused, uusimad eespool. | Draft |
| `adminEt.certificates.register.back` | Hindamisse | Draft (as `assessment.screen.back`) |
| `adminEt.certificates.register.count` | Tunnistusi: {n} | Draft |
| `adminEt.certificates.register.empty` | Tunnistusi pole veel väljastatud. | Draft |
| `adminEt.certificates.register.col.*` | Number · Nimi · Koolitus · Väljastatud · Tunnistus | Spec (§6 "number, name, course and issue date") + Draft (the download column's name) |
| `adminEt.certificates.register.reissued` | nimi parandatud {date} | Draft |
| `adminEt.certificates.register.revoked` | ligipääs tühistatud | Spec (§9) |
| `adminEt.certificates.register.openStudent` | Ava õpilane {name} | Draft |
| `adminEt.certificates.register.download` / `downloadLabel` | Laada alla / Laada alla tunnistus {number} | Spec (§6) / Draft |

---

### Task 7: End to end — the whole path in a real browser, two issues at once on real Postgres; the runbook and the launch list

Spec §10 ("Real Postgres (e2e)": two accesses issuing at the same moment get two different numbers; "End to end": complete → confirm the name → download (`%PDF`, filename); Maria's drawer shows it and "Paranda nimi" re-issues it; the register lists it; widths 390/834/1194/1440), §11 (rollout), §5–§7. Review Focus 1 (on real Postgres), 2 (the emoji refused in the browser), 4 (a new signature on old certificates), 5 (revoked: hers 404, Maria's still there). Rulings: Task 3's lock order (the access row, then the refusals — an existing certificate answers `already` without the number lock —, then `pg_advisory_xact_lock(hashtext('certificate-number'))`; `saveCertificateSettings` and `setSignatureKey` take the same lock), and the controller's update of 15.10 (Maria's signature comes from her Canva document as a PNG, uploaded once in Seaded and never committed; the e2e draws its own signatures).

**What the e2e shares with other tests, and how it stays out of their way:**
- **The number series is the whole database's.** Every test here that issues a certificate through the app holds the e2e lock `e2e-certificate-number` (`holdLocalLock`) while it does, so the race spec's two numbers are consecutive whatever runs beside it. Certificates a test only needs to look at are written straight to the database with the year 1999 and the access's id as their number (`MS LAB 1999-<id>`): no app's certificate ever has it.
- **The signature is the whole site's.** Only one test changes it, in the desktop project only, under the e2e lock `e2e-certificate-signature`; it ends by removing it ("Eemalda allkiri"). It never saves Seaded's other fields: another test may issue a number meanwhile, and a stale "Järgmine number" would be refused (rightly).
- **The rows:** every student is a sample address `e2e-client-cert-…@example.test` (never mailed) on an e-course of her own (`tests/e2e/completion.ts insertCompletionCourse`, then `completed_at` set), removed after each test with everything she has (`removeClientRows`; her certificate goes with her access). The e-course page needs the shared course terms (`takeTerms`), held only while a test is on that page.

**Files:**
- Create: `app/tests/e2e/certificate.ts`, `app/tests/e2e/certificate.spec.ts`, `app/tests/e2e/certificate-race.spec.ts`
- Modify: `docs/deploy.md` (§6, the migrations count, line 112; a new §14 at the end), `docs/launch-checklist.md` (a new §13 at the end)

**Interfaces:**
- Consumes:
  - Task 1 (`src/domain/certificate.ts`): `readCertificateSettings(value: unknown, now: Date): CertificateSettings`; `nextNumber(s: { nextYear: number; nextSeq: number }, year: number): { year: number; seq: number; next: { nextYear: number; nextSeq: number } }`; `tallinnYear(d: Date): number`; `formatCertificateNumber(year: number, seq: number): string`; `certificateFileName(year: number, seq: number): string`. The tables `certificates`, `settings` (key `certificate`), `courses.certificate_skills` / `certificate_volume`.
  - Task 3 (`src/server/certificates.ts`): `issueCertificate(db: Db, clientId: number, slug: string, rawName: string, now: Date): Promise<IssueResult>`; `type IssueResult` (`issued` | `already` with `certificate: CertificateView`, …).
  - Task 4: `POST /api/konto/kursus/<slug>/tunnistus`, `GET /api/konto/tunnistus/<id>` (10 downloads an hour per student); the row `[data-certificate]`, `[data-certificate-name]`, `[data-certificate-issue]`, `[data-certificate-number]`, `[data-certificate-download]`, `[data-certificate-error]`; the dashboard card's `[data-card-certificate]`.
  - Task 5: `[data-certificate-card]`, `[data-certificate-skills]`, `[data-certificate-skill]`, `[data-add-skill]`, `[data-field="certificateVolume"]`; Seaded's `[data-certificate-settings]`, `[data-cert-save]`, `[data-cert-signature]`, `[data-cert-signature-file]`, `[data-cert-signature-status]`, `[data-cert-signature-remove]`, `[data-cert-signature-confirm]`; `GET|DELETE /api/admin/allkiri`; `GET /api/admin/tunnistus/<id>`.
  - Task 6: `[data-access-certificate]`, `[data-certificate-admin-download]`, `[data-certificate-revoked]`, `[data-reissue]`, `[data-reissue-name]`, `[data-reissue-save]`, `[data-reissue-done]`; `/admin/tunnistused` with `[data-certificate-register]`, `[data-register-row]`, `[data-register-download]`; Hindamine's `[data-to-register]`.
  - Existing e2e helpers: `insertCompletionCourse`, `type CompletionCourse` (`tests/e2e/completion.ts`); `clientEmail`, `takeTerms` (`account.ts`); `signInAsAdmin`, `adminReady`, `type CreatedRows` (`admin-login.ts`); `holdLocalLock`, `LOCK_WAIT_MS`, `localDatabaseUrl`, `onLocalDb`, `removeAdminRows`, `removeClientRows` (`fixtures.ts`); `runName`, `studentPage` (`protocols.ts`); `smallTargets` (`targets.ts`); `expect`, `submitsForms`, `test` (`test.ts`).
- Produces (`tests/e2e/certificate.ts`): `NUMBER_LOCK`, `SIGNATURE_LOCK`, `E2E_YEAR`; `completedCourse(email: string, name?: string): Promise<CompletionCourse>`; `type StoredCertificate`; `storedCertificate(accessId: number): Promise<StoredCertificate | null>`; `insertCertificate(accessId: number, name: string): Promise<{ id: number; number: string }>`; `storedCertificateSetting(): Promise<Record<string, unknown> | null>`; `storedCourseCertificate(courseId: number): Promise<{ skills: string[]; volume: string }>`; `signaturePng(page: Page, kind: "paper" | "canva"): Promise<Buffer>`; `inkStats(page: Page, png: Buffer): Promise<{ width: number; height: number; corner: number; ink: number; white: boolean }>`.

- [ ] **Step 1: The e2e rows** — create `tests/e2e/certificate.ts`:

```ts
import type { Page } from "@playwright/test";
import { insertCompletionCourse, type CompletionCourse } from "./completion";
import { onLocalDb } from "./fixtures";

// The certificate's e2e rows (certificate.spec.ts, certificate-race.spec.ts; phase 3d): a completed access on an e-course of the test's own
// (completion.ts insertCompletionCourse: no test, no points, its one lesson done; completed an hour ago), a certificate written straight to the
// database (the year 1999 and the access's id as its number: no certificate of the app's ever has it), and the stored `certificate` setting.
// Every address is a sample one (`e2e-client-cert-…@example.test`, never mailed) that fixtures.ts removeClientRows removes with its course; a
// certificate goes with its access (on delete cascade). And the signature fixtures, drawn on a canvas in the test's own browser: no binary in
// the repository, and never Maria's signature (it comes from her Canva document, is uploaded once by hand in Seaded and is never committed).

/** The local database for rows no public page shows. */
const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

/**
 * Held by every e2e test that issues a certificate through the app, while it does: the number series is the whole database's, and the race
 * spec's two numbers are consecutive only if no other test takes one between them.
 */
export const NUMBER_LOCK = "e2e-certificate-number";
/** Held by the one test that changes the signature: the setting is the whole site's. */
export const SIGNATURE_LOCK = "e2e-certificate-signature";
/** The year of the certificates written straight: no real certificate has it, so their numbers never meet the app's. */
export const E2E_YEAR = 1999;

/** A client (`name`) with a completed access to an e-course of her own: no test, no points, the lesson done, the course terms accepted. */
export async function completedCourse(email: string, name = "Kati Kask"): Promise<CompletionCourse> {
  const s = await insertCompletionCourse(email, { points: [], lessonsDone: true, name });
  await localDb((sql) => sql`update course_access set completed_at = now() - interval '1 hour' where id = ${s.accessId}`);
  return s;
}

export type StoredCertificate = {
  id: number;
  number: string;
  year: number;
  seq: number;
  name: string;
  courseTitle: string;
  skills: string[];
  volume: string;
  practicalLine: string;
  place: string;
  registryCode: string;
  issuedAt: Date;
  reissuedAt: Date | null;
};

/** The access's certificate as stored, or null. */
export async function storedCertificate(accessId: number): Promise<StoredCertificate | null> {
  const [row] = await localDb(
    (sql) => sql<StoredCertificate[]>`
      select id, number, year, seq, name, course_title as "courseTitle", skills, volume, practical_line as "practicalLine", place,
             registry_code as "registryCode", issued_at as "issuedAt", reissued_at as "reissuedAt"
      from certificates where access_id = ${accessId}`,
  );
  return row ?? null;
}

/** A certificate written straight for the access, issued now: "MS LAB 1999-<access id>". */
export async function insertCertificate(accessId: number, name: string): Promise<{ id: number; number: string }> {
  const number = `MS LAB ${E2E_YEAR}-${String(accessId).padStart(2, "0")}`;
  return localDb(async (sql) => {
    const [row] = await sql<{ id: number }[]>`
      insert into certificates (access_id, number, year, seq, name, course_title, skills, volume, practical_line, place, registry_code, issued_at)
      values (${accessId}, ${number}, ${E2E_YEAR}, ${accessId}, ${name}, 'E2E lõpetamine', ${sql.json(["Kulmude kuju ja proportsioonid", "Värvi valik"])},
              '10 akadeemilist tundi', 'Praktiline töö fotodel', 'Pärnu linn', '16346048', now())
      returning id`;
    return { id: row.id, number };
  });
}

/** The stored `certificate` setting; null before anything is saved (the app's defaults apply then). */
export async function storedCertificateSetting(): Promise<Record<string, unknown> | null> {
  const [row] = await localDb((sql) => sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'certificate'`);
  return row?.value ?? null;
}

/** The course's "Tunnistus" card as stored. */
export async function storedCourseCertificate(courseId: number): Promise<{ skills: string[]; volume: string }> {
  const [row] = await localDb(
    (sql) => sql<{ skills: string[]; volume: string }[]>`select certificate_skills as skills, certificate_volume as volume from courses where id = ${courseId}`,
  );
  return row;
}

/**
 * A signature drawn in `page`'s browser as a PNG of 1600 × 600: "paper", dark blue ink on paper lit by a lamp, with the paper's grain (light
 * specks, all lighter than the ink's threshold), as a photo or a scan of a signature is; "canva", white ink on a transparent background, as
 * Maria's signature exported from her Canva certificate is. The same strokes in both: a signature about 960 px wide.
 */
export async function signaturePng(page: Page, kind: "paper" | "canva"): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (kind) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 600;
    const g = canvas.getContext("2d")!;
    if (kind === "paper") {
      g.fillStyle = "#efebe4";
      g.fillRect(0, 0, 1600, 600);
      let seed = 11;
      for (let i = 0; i < 4000; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        g.fillStyle = seed & 1 ? "#d8d2c8" : "#f7f4ef";
        g.fillRect(seed % 1600, (seed >>> 11) % 600, 2, 2);
      }
    }
    g.strokeStyle = kind === "paper" ? "#1d2440" : "#ffffff";
    g.lineWidth = 7;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(300, 380);
    g.bezierCurveTo(360, 160, 440, 160, 470, 360);
    g.bezierCurveTo(500, 520, 560, 200, 640, 300);
    g.bezierCurveTo(720, 400, 780, 240, 860, 330);
    g.bezierCurveTo(940, 420, 1040, 260, 1180, 310);
    g.stroke();
    g.beginPath();
    g.moveTo(420, 440);
    g.lineTo(1250, 410);
    g.stroke();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas gave no PNG"))), "image/png"));
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }, kind);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/**
 * A stored signature as `page`'s browser decodes it: its size, the alpha of its top left pixel (the margin around the ink: transparent), how
 * many pixels show (alpha 128 and up) and whether every one of those is white.
 */
export async function inkStats(page: Page, png: Buffer): Promise<{ width: number; height: number; corner: number; ink: number; white: boolean }> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { premultiplyAlpha: "none" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
    let ink = 0;
    let white = true;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] >= 128) {
        ink++;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) white = false;
      }
    const stats = { width: bitmap.width, height: bitmap.height, corner: data[3], ink, white };
    bitmap.close();
    return stats;
  }, png.toString("base64"));
}
```

- [ ] **Step 2: Two at once on real Postgres** — create `tests/e2e/certificate-race.spec.ts`:

```ts
import type { TestInfo } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { readCertificateSettings, tallinnYear } from "../../src/domain/certificate";
import { issueCertificate, type IssueResult } from "../../src/server/certificates";
import { clientEmail } from "./account";
import { completedCourse, NUMBER_LOCK, storedCertificate, storedCertificateSetting } from "./certificate";
import type { CompletionCourse } from "./completion";
import { holdLocalLock, localDatabaseUrl, LOCK_WAIT_MS, onLocalDb, removeClientRows } from "./fixtures";
import { runName } from "./protocols";
import { expect, submitsForms, test } from "./test";

// Spec §10 "Real Postgres (e2e)" and Review Focus 1: what the unit tests' single-connection PGlite cannot show. The app's own issueCertificate,
// in this process, on a pool of the local Postgres:
// - two students completing at the same moment get two numbers, one after the other, and the setting goes past both;
// - one student confirming on two devices at the same moment gets one certificate; the second answer is "already", with the same number.
// "At the same moment" is proven, not hoped for (atOnce): another connection holds the number's transaction lock (pg_advisory_xact_lock of
// hashtext('certificate-number'), server/certificates.ts) while the calls start, and lets it go only once this pool shows every call waiting
// — the two students' at the number's lock, or the second device's at her access row, which the first holds while it waits for the number.
// The e2e lock NUMBER_LOCK keeps the other tests' issues out of the series meanwhile. Nothing here depends on the screen: the desktop project
// runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const made = new Set<string>();
/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-certificate-race-${process.pid}`;
let pool: postgres.Sql | null = null;
let db: Db;

test.beforeAll(() => {
  pool = postgres(localDatabaseUrl(), { max: 6, connect_timeout: 20, onnotice: () => {}, connection: { application_name: APPLICATION } });
  db = drizzle(pool, { schema }) as unknown as Db;
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000 + LOCK_WAIT_MS); // the wait for NUMBER_LOCK is this test's too
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Waiting = { query: string; wait_event: string | null };
/**
 * This pool's backends that wait for a lock (pg_stat_activity by its application_name), asked again every 50 ms until there are `n` of them, or
 * `gone()` says the work it waits for is over, or `ms` have passed: a test proves the wait instead of sleeping and hoping.
 */
async function lockWaits(n: number, gone: () => boolean, ms = 15_000): Promise<Waiting[]> {
  const until = Date.now() + ms;
  for (;;) {
    const waiting = await onLocalDb(
      (other) => other<Waiting[]>`select query, wait_event from pg_stat_activity where application_name = ${APPLICATION} and wait_event_type = 'Lock'`,
      { marksPages: false },
    );
    if (waiting.length >= n || gone() || Date.now() > until) return waiting;
    await pause(50);
  }
}

/** What one waiting backend waits at: the number's lock, her access row, or (for the failure message) its query. */
const waitsAt = (w: Waiting) => (/pg_advisory_xact_lock/i.test(w.query) ? "number" : /from "?course_access"?[\s\S]*\bfor update\b/i.test(w.query) ? "access" : w.query);

/**
 * The calls of issueCertificate that `calls` starts, at the same moment for certain: another connection holds the number's transaction lock
 * while they start; the test waits until this pool shows every one of them waiting (`at`: where each waits, in any order), and only then lets
 * the lock go (its transaction ends). A call that ran its whole transaction before the other began would never be seen waiting beside it, so
 * the outcome that follows is the locks', not the timing's. Their results, in the order started.
 */
async function atOnce(calls: () => Promise<IssueResult>[], at: string[]): Promise<IssueResult[]> {
  let running: Promise<IssueResult>[] = [];
  let settled = 0;
  try {
    await onLocalDb(
      (sql) =>
        sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext('certificate-number'))`;
          running = calls();
          for (const r of running)
            void r.then(
              () => settled++,
              () => settled++,
            );
          const waiting = await lockWaits(running.length, () => settled > 0);
          expect(settled, "an issue went past the locks while the number's lock was held").toBe(0);
          expect(waiting.map(waitsAt).sort(), "where each issue waits (server/certificates.ts issueCertificate)").toEqual([...at].sort());
        }),
      { marksPages: false },
    );
  } finally {
    await Promise.allSettled(running); // a failure above lets the lock go too: what is on its way finishes before the clean-up
  }
  return Promise.all(running);
}

/** A student (`name`) with a completed access to an e-course of her own. */
async function student(label: string, info: TestInfo, name: string): Promise<CompletionCourse> {
  const email = clientEmail(`cert-race-${label}`, runName(info));
  made.add(email);
  await removeClientRows(email);
  return completedCourse(email, name);
}

const issue = (s: CompletionCourse, name: string) => issueCertificate(db, s.clientId, s.slug, name, new Date());
const NUMBER = /^MS LAB (\d{4})-(\d{2,})$/;

test("Review Focus 1: two students completing at the same moment — two numbers, one after the other, and the setting past both", async ({}, info) => {
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    const anu = await student("a", info, "Anu Kask");
    const eve = await student("b", info, "Eve Tamm");
    const results = await atOnce(() => [issue(anu, "Anu Kask"), issue(eve, "Eve Tamm")], ["number", "number"]);
    expect(results.map((r) => r.kind)).toEqual(["issued", "issued"]);
    const numbers = results.map((r) => (r.kind === "issued" ? r.certificate.number : ""));
    const parts = numbers.map((n) => NUMBER.exec(n));
    expect(parts.every(Boolean), numbers.join(", ")).toBe(true);
    const [y1, y2] = parts.map((p) => Number(p![1]));
    const seqs = parts.map((p) => Number(p![2])).sort((a, b) => a - b);
    expect([y1, y2]).toEqual([tallinnYear(new Date()), tallinnYear(new Date())]);
    expect(seqs[1], `${numbers.join(" and ")}: one after the other`).toBe(seqs[0] + 1);
    // stored as answered, one each; the setting is past the second
    expect((await storedCertificate(anu.accessId))?.number).toBe(numbers[0]);
    expect((await storedCertificate(eve.accessId))?.number).toBe(numbers[1]);
    expect(readCertificateSettings(await storedCertificateSetting(), new Date())).toMatchObject({ nextYear: y1, nextSeq: seqs[1] + 1 });
  } finally {
    await unlock();
  }
});

test("Review Focus 1: one student confirming on two devices at the same moment — one certificate; the second answer is 'already', with the same number", async ({}, info) => {
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    const kati = await student("twice", info, "Kati Kask");
    // the first locks her access row and waits for the number; the second waits for her access row
    const results = await atOnce(() => [issue(kati, "Kati Kask"), issue(kati, "Kati Kask")], ["number", "access"]);
    expect(results.map((r) => r.kind).sort()).toEqual(["already", "issued"]);
    const [a, b] = results.map((r) => (r.kind === "issued" || r.kind === "already" ? r.certificate : null));
    expect(a?.id).toBe(b?.id);
    expect(a?.number).toBe(b?.number);
    expect(a?.number).toMatch(NUMBER);
    const stored = await onLocalDb((sql) => sql<{ number: string }[]>`select number from certificates where access_id = ${kati.accessId}`, { marksPages: false });
    expect(stored).toEqual([{ number: a!.number }]);
  } finally {
    await unlock();
  }
});
```

- [ ] **Step 3: Run it.** `docker start mslab-pg` if it is not running (migration 0009 is applied locally since Task 1). From `app/`: `npx playwright test certificate-race` — expect PASS on the desktop project (the mobile project skips both). A failure names the earlier task's part it exercises: "where each issue waits" not `["number", "number"]` means `issueCertificate` does not take the number's lock as Task 3 builds it; a gap between the two numbers means something outside `NUMBER_LOCK` issued meanwhile (look for a `next dev` you are using by hand). Fix it there, not here.

- [ ] **Step 4: The whole path** — create `tests/e2e/certificate.spec.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { certificateFileName, formatCertificateNumber, nextNumber, readCertificateSettings, tallinnYear, type CertificateSettings } from "../../src/domain/certificate";
import { clientEmail, takeTerms } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import {
  completedCourse, inkStats, insertCertificate, NUMBER_LOCK, SIGNATURE_LOCK, signaturePng, storedCertificate, storedCertificateSetting, storedCourseCertificate, type StoredCertificate,
} from "./certificate";
import type { CompletionCourse } from "./completion";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { runName, studentPage } from "./protocols";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// The e-course certificate (phase 3d, spec §10 "End to end"): Maria fills an e-course's "Tunnistus" card; the student, her course completed,
// confirms her name on the course page (an emoji refused first: Review Focus 2) and downloads the PDF (`%PDF`, its file name); Maria's drawer
// shows it with her download, "Paranda nimi" re-issues it under the same number, the register lists it; the ended access's dashboard card
// links it, and once the access is revoked her link goes and her download is 404 while Maria's drawer keeps it, marked (Review Focus 5).
// Seaded → "Tunnistus": a signature photographed on paper and one exported from Canva (light ink on transparency) each become white ink on
// transparency, stored privately, shown on black and drawn on the certificates; "Eemalda allkiri" takes it off (Review Focus 4). And the
// screens at 390, 834, 1194 and 1440 px. Every student is a sample address (`e2e-client-cert-…@example.test`, never mailed) on an e-course of
// the test's own; all of it is removed after each test. Under `next dev` and the production build (E2E_PROD_BUILD=1); Maria signs in as Dim
// (admin-login.ts). The number series and the signature are the whole database's: see the locks in certificate.ts. The locks of the issue
// itself on real Postgres are certificate-race.spec.ts.

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
const localFile = (key: string) => join(process.cwd(), ".media-local", ...key.split("/"));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** A file field's touch target is its label (Seaded's "Lae allkiri üles"), as in completion.spec.ts. */
const LABELLED = /^<input[^>]*\stype="(radio|checkbox|file)"/;
/** The file fields in `scope` whose label is under 44 px tall or missing (the start of each one's HTML with the height found). */
const smallLabels = (scope: Locator): Promise<string[]> =>
  scope.locator('input[type="file"]:visible').evaluateAll((els) =>
    els
      .map((el) => ({ el, height: Math.max(0, ...Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.getBoundingClientRect().height)) }))
      .filter(({ height }) => height < 44)
      .map(({ el, height }) => `${el.outerHTML.slice(0, 120)} (label ${Math.round(height)} px)`),
  );

test("§10 e2e: Maria's 'Tunnistus' card; the student confirms her name (an emoji refused first) and downloads the PDF; Maria's drawer, 'Paranda nimi', the register; the ended access's card; revoked: hers 404, Maria's still there, marked", async ({ page, context, visitorIp, browser }, info) => {
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
  // Review Focus 2: an emoji is refused with the field's error before anything is stored
  await row.locator("[data-certificate-name]").fill("Kati 😀");
  await row.locator("[data-certificate-issue]").click();
  await expect(row.locator("[data-certificate-error]")).toContainText("Kasuta nimes ainult tähti, tühikuid ja sidekriipse");
  expect(await storedCertificate(s.accessId)).toBeNull();

  // her name with Estonian letters and a double surname: issued with the series' next number, the setting one further (no other test issues meanwhile)
  let before!: CertificateSettings;
  let stored!: StoredCertificate;
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    before = readCertificateSettings(await storedCertificateSetting(), new Date());
    const expected = nextNumber(before, tallinnYear(new Date()));
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

  // the register, from Hindamine
  await page.goto("/admin/hindamine");
  await adminReady(page);
  await page.locator("[data-to-register]").click();
  await expect(page).toHaveURL(/\/admin\/tunnistused$/);
  await adminReady(page);
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

test("§6 Seaded → Tunnistus: a signature on paper and one exported from Canva each become white ink on transparency, stored privately, shown on black and on the certificates; 'Eemalda allkiri' takes it off", async ({ page, context, visitorIp, request, isMobile }, info) => {
  test.skip(isMobile, "the signature is the whole site's: the desktop project changes it, once");
  info.setTimeout(180_000 + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(SIGNATURE_LOCK);
  try {
    const s = await student("sig", info);
    const cert = await insertCertificate(s.accessId, "Kati Kask");
    await signInAsAdmin(page, context, visitorIp, created);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const card = page.locator("[data-certificate-settings]");
    await expect(card.locator("[data-cert-save]")).toHaveText("Salvesta tunnistuse andmed");
    const status = card.locator("[data-cert-signature-status]");
    const keys: string[] = [];
    // a photo of the signature on paper, then Maria's kind: the Canva export (light ink on transparency), which replaces it
    for (const [kind, name] of [
      ["paper", "IMG_0042.png"],
      ["canva", "allkiri-canva.png"],
    ] as const) {
      await card.locator("[data-cert-signature-file]").setInputFiles({ name, mimeType: "image/png", buffer: await signaturePng(page, kind) });
      await expect(status).toHaveAttribute("data-cert-signature-status", "done", { timeout: 30_000 });
      await expect(status).toHaveText("Allkiri on salvestatud. See on nüüd kõigil tunnistustel, ka varem väljastatutel.");
      await expect(card.locator("[data-cert-signature] img")).toBeVisible();
      const key = String((await storedCertificateSetting())?.signatureKey ?? "");
      expect(key, kind).toMatch(/^certificate\/signature-[0-9a-f-]{36}\.png$/);
      expect(keys, kind).not.toContain(key);
      const png = readFileSync(localFile(key));
      expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), kind).toBe(true);
      // white ink on transparency, cut to the ink with its margin (the strokes are about 960 px wide), at most 1200 px wide
      const ink = await inkStats(page, png);
      expect(ink.width, kind).toBeGreaterThan(900);
      expect(ink.width, kind).toBeLessThanOrEqual(1200);
      expect(ink.corner, kind).toBe(0);
      expect(ink.ink, kind).toBeGreaterThan(1000);
      expect(ink.white, kind).toBe(true);
      keys.push(key);
      // a replaced signature's file goes once the setting names the new one
      if (keys.length === 2) await expect.poll(() => existsSync(localFile(keys[0])), { timeout: 15_000 }).toBe(false);
    }
    // private: Maria's GET answers it, a visitor's is 401; Review Focus 4: the certificate issued before it shows it now (an image in the PDF)
    const own = await page.request.get("/api/admin/allkiri");
    expect([own.status(), own.headers()["content-type"]]).toEqual([200, "image/png"]);
    expect((await request.get("/api/admin/allkiri")).status()).toBe(401);
    expect((await (await page.request.get(`/api/admin/tunnistus/${cert.id}`)).body()).includes("/Subtype /Image")).toBe(true);

    // "Eemalda allkiri", after its one question: the setting cleared, the file gone, the certificate without an image
    await card.locator("[data-cert-signature-remove]").click();
    await card.locator("[data-cert-signature-confirm] button").first().click();
    await expect(card.locator("[data-cert-signature]")).toHaveText("Allkirja pole: tunnistusel on koolitaja nimi käekirjas.");
    expect((await storedCertificateSetting())?.signatureKey ?? null).toBeNull();
    await expect.poll(() => existsSync(localFile(keys[1])), { timeout: 15_000 }).toBe(false);
    expect((await page.request.get("/api/admin/allkiri")).status()).toBe(404);
    expect((await (await page.request.get(`/api/admin/tunnistus/${cert.id}`)).body()).includes("/Subtype /Image")).toBe(false);
  } finally {
    await unlock();
  }
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
    { page, url: "/admin/seaded", scope: "[data-certificate-settings]", admin: true, shows: ["[data-cert-save]", "[data-cert-signature]"] },
    { page, url: `/admin/opilased?id=${b.clientId}`, scope: `[data-access="${b.courseId}"]`, admin: true, shows: ["[data-access-certificate]", "[data-reissue]"] },
    { page, url: "/admin/tunnistused", scope: "[data-certificate-register]", admin: true, shows: [`[data-register-row="${cert.id}"]`] },
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
```

- [ ] **Step 5: Run it under `next dev` and the production build.** From `app/` (`docker start mslab-pg` first; stop any dev server you started):
  - `npx playwright test certificate` — expect PASS: the whole path on both projects, the Seaded test and the widths on the desktop one, the race spec's two tests on the desktop one.
  - `E2E_PROD_BUILD=1 npx playwright test certificate` — expect PASS (the fonts are read from `assets/fonts` by the local `next start`; the signature goes to `app/.media-local` with `MEDIA_LOCAL=1`).
  - A failure names the earlier task's part it exercises (a selector, a route, a text): fix it there, not here — unless the earlier task's own tests pin that behaviour; then the e2e step is wrong and is fixed here.

- [ ] **Step 6: The migrations count** — in `docs/deploy.md` §6 (line 112), the text

```md
9 after the e-course completion's 0008).
```

  becomes

```md
9 after the e-course completion's 0008, 10 after the certificate's 0009).
```

- [ ] **Step 7: The runbook** — at the end of `docs/deploy.md` add:

```md

## 14. The e-course certificate

When an e-course is "Lõpetatud", the student confirms her name once and downloads a PDF certificate that looks like Maria's paper ones and continues their number series (spec `docs/superpowers/specs/2026-10-15-certificate-design.md`, plan `docs/superpowers/plans/2026-10-15-certificate.md`). E-courses only: contact courses stay on paper.

1. **What runs where.**
   - **The student:** the "Tunnistus" row of "Lõpetamine" on `/konto/kursus/<slug>` ("Nimi tunnistusel", "Kinnita ja koosta tunnistus", then "Laadi tunnistus alla (PDF)"), and the quiet link "Laadi tunnistus alla" on the dashboard card of an ended access. Her routes are `POST /api/konto/kursus/<slug>/tunnistus` (`{ name }`) and `GET /api/konto/tunnistus/<id>` (the PDF): `private, no-store`, at most 10 issues and 10 downloads an hour per student, and behind the coming-soon gate until the launch, like every account route.
   - **Maria's pages:** the course editor's "Tunnistus" card on e-courses ("Oskused tunnistusel", "Maht"); Seaded → "Tunnistus" (a card of its own under the settings' save bar: "Koht", "Registrikood", "Praktilise töö rida", "Koolitaja nimi", "Järgmine number" with the year's last issued number, "Allkiri"); the Õpilased drawer's line "Tunnistus MS LAB 2026-03 · {date}" with "Laada alla" and "Paranda nimi"; the register `/admin/tunnistused` (from Hindamine's "Väljastatud tunnistused", not in the menu; 50 a page, newest first).
   - **Maria's endpoints:** `GET /api/admin/tunnistus/<id>` (any certificate, a revoked access's too) and `POST|GET|DELETE /api/admin/allkiri` (the signature image), behind `withAdmin`, all `maxDuration = 30`. The settings' save and "Paranda nimi" are server actions (`src/server/actions/admin-certificates.ts`).
   - **Configuration:** no new variable, no cron. The fonts are files of the repository (`app/assets/fonts/`: Jost and Great Vibes with their OFL texts, checked by SHA-256 in the tests); `next.config.ts` traces them into the two functions that render (`outputFileTracingIncludes` for `/api/konto/[[...path]]` and `/api/admin/tunnistus/[id]`). The only new packages are `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1`, pinned exactly.
2. **The data.** Migration `0009_certificates` is additive. It runs on Railway before the deploy (section 6), and the live code does not name what it adds.
   - `certificates`: one row per completed access (unique `access_id`, deleted with the access and so with the account), the number "MS LAB {year}-{nn}" with `year` and `seq` (unique together, `seq` ≥ 1), and the frozen copy: the name as confirmed, the course's Estonian title, the skills, the volume, the practical line, the place, the registry code and `issued_at` (the date printed); `reissued_at` after "Paranda nimi".
   - `courses.certificate_skills` (jsonb lines, `[]`) and `courses.certificate_volume` (text, `''`): the course editor's card. With no lines, the course's "Õpiväljundid" (Estonian) are printed, at most 16.
   - The `settings` row `certificate`: `{ place, registryCode, practicalLine, trainerName, nextYear, nextSeq, signatureKey }`. Without it, the defaults: Pärnu linn, 16346048, the plan's practical line, Maria Sosnina, this year, 1, no signature.
   - The signature: one private R2 object `certificate/signature-<uuid>.png`, never served by `/media`.
   - The drop of `courses.modules` is migration 0010 (code first, then the migration, as planned in phase 3a).
3. **The rules.**
   - **Numbering:** a certificate issued in Tallinn year Y takes `nextSeq` when the setting's `nextYear` is Y, else 1; the setting then becomes Y and the number after it. The year turns at Tallinn midnight on 31.12. The issue runs in one transaction: the access row (`FOR UPDATE`), then the refusals (a revoked access is "not found", one not completed "not completed", one with a certificate answers "already" with it), then the transaction's advisory lock `pg_advisory_xact_lock(hashtext('certificate-number'))`, then the setting is read and advanced and the row written; the unique (`year`, `seq`) is the backstop. Two students at the same moment get two numbers, one after the other; one student on two devices gets one certificate, and the second answer is "already" with the same number (`tests/e2e/certificate-race.spec.ts`). Seaded's save and the signature take the same lock before they rewrite the setting.
   - **One series with paper:** Maria's paper certificates (contact courses) share the series. When she writes one on paper, she takes the number Seaded shows as next and raises "Järgmine number" by one ("Salvesta tunnistuse andmed"); otherwise the site can issue the same number. Seaded refuses a next number at or below one already issued in its year ("See number on juba väljastatud. …") and a year outside 2000–2099.
   - **The frozen copy:** a certificate prints only what its row holds. A later change of the course (its title, its card) or of Seaded's place, registry code or practical line never changes an issued certificate. Not frozen: the signature (a new one appears on every later download, old certificates included) and the trainer's name written in the script font when there is no signature (read from Seaded at each download).
   - **The name:** NFC, trimmed, inner spaces collapsed; 2–80 characters with at least 2 letters; Latin or Cyrillic letters, spaces, hyphens, apostrophes (' and ’) and dots. Anything else (digits, an emoji) is refused with "Kasuta nimes ainult tähti, tühikuid ja sidekriipse" before anything is stored. A long name shrinks to 30 pt on the PDF, then wraps to two lines.
   - **Who may download:** the student her own certificate while her access is not revoked (expiry does not matter); a revoked access answers 404, and its card link goes. Maria every certificate, a revoked access's too, marked "ligipääs tühistatud" in the drawer and the register.
   - **"Paranda nimi":** the student's rules; it keeps the number and the issue date, changes the name and sets `reissued_at`, and mails nobody. The student cannot change her name once it is issued: her row says "Kui nimes on viga, kirjuta meile".
   - **Deletion:** the account's deletion takes its certificates (cascade); their numbers are not reused, so the series has a gap.
4. **The PDF.** Rendered on every download from the frozen row (`src/server/certificate-pdf.ts`): A4 landscape (842 × 595 pt), black, white text, Jost and Great Vibes embedded as subsets, the MS LAB logo drawn as vector shapes, the signature image (or the trainer's name in the script font); tens of milliseconds, under 300 KB. Nothing but the signature is stored. The answer is `attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`, `private, no-store`, nosniff (Maria's `/api/admin/…` answers get `Cache-Control: no-store` from `next.config.ts`). A function log saying a font is missing (`ENOENT … assets/fonts`) means the tracing of `next.config.ts` did not include it: check the deployment's function files.
5. **The signature.**
   - **Where it comes from:** Maria's signature is in her Canva certificate document. Dim exports it from Canva as a PNG (light ink on a transparent background, or dark ink on white) and uploads it once in Seaded → Tunnistus → "Allkiri". It is never committed (the repository is public) and never sent by mail. A photo or a scan of her signature on white paper works the same way.
   - **In the browser:** the picture becomes white ink on a transparent background (`src/lib/signature-ink.ts`). A picture more than 20 % transparent whose other pixels are light (a Canva export) keeps each pixel's alpha, scaled by its luminance; any other picture's pixels darker than grey 140 become white, with an alpha from their darkness, and the rest transparent. It is cut to the ink with a 4 px margin, made at most 1200 px wide and sent as PNG. A picture without ink says so; nothing is sent.
   - **On the server:** `POST /api/admin/allkiri` takes one PNG (its first bytes checked) of at most 1 MB, stores it as a new private object, points the setting at it, and then removes the old object. A failed removal is logged (item 7) and the old object stays in the bucket with no setting naming it: delete it by hand (its key is under `certificate/`; the setting's `signatureKey` names the one in use). Without a store (the four `R2_*` variables) the upload answers 503 "storage".
   - **"Eemalda allkiri"** clears the setting and then removes the object; the certificates then show the trainer's name in the script font.
6. **The mails.** The "Palju õnne!" mail of a completed e-course has one more line, "Kinnita oma nimi ja laadi tunnistus alla:", with the course page's link; no attachment. Nothing else mails: the issue and "Paranda nimi" send nothing.
7. **The logs.** A failure is written at error level; `<error class>` is the class, the code and the HTTP status only (section 12, item 7).
   - **The issue:** `[certificate] access N: issued <number>`, `[certificate] N: re-issued`; failures `[certificate] N: the re-issue failed: <error class>` and the student's routes' (`src/server/account-api.ts`).
   - **Maria's download and the settings:** `[certificate] N: the admin's download failed: <error class>`, `[certificate] the settings save failed: <error class>`.
   - **The signature:** `[certificate] signature refused: no file store (…)` (it names the four `R2_*` variables), `[certificate] the signature could not be stored: <error class>`, `[certificate] the signature setting could not be saved: <error class>` (the new object is removed again), `[certificate] the old signature image could not be removed: <error class>`, `[certificate] no file store: the old signature image was not removed`, `[certificate] the signature could not be read: <error class>`, `[certificate] the signature could not be removed: <error class>`.
   - Never a name, an address or an R2 key.
8. **Rollback.** A rollback of the code past this phase leaves 0009's additions in place, and the older code ignores them: the student's routes, the "Tunnistus" row and the register are gone (the completed mail's link lands on her course page without the row), and no certificate can be downloaded until the code is back. The older course editor saves a course without touching its two certificate columns, and the signature object stays in R2.
```

  Before you write item 7, list the labels the code logs (from `app/`):

```bash
grep -rhoE '\[certificate\][^"`]*|\[account\][^"`]*certificat[^"`]*' src | sort -u
```

  Every label it prints must be in item 7 in the form above (`N` for an id, `<number>` for a number, `<error class>` for a summary). Task 4's labels of the student's routes and of their rate limits go where the item says "the student's routes' (`src/server/account-api.ts`)", in the same form, and that pointer is then removed.

- [ ] **Step 8: The launch list** — at the end of `docs/launch-checklist.md` add:

```md

## 13. The e-course certificate (phase 3d)
- [ ] Go-live behind the coming-soon gate (plan 2026-10-15-certificate, Task 8), in this order: migration 0009 on Railway first (the count in `drizzle.__drizzle_migrations` goes from 9 to 10, `docs/deploy.md` section 6), then the deploy, then the smoke check (`/api/admin/tunnistus/1` and `/api/admin/allkiri` answer 401 without a session).
- [ ] Maria's signature comes from her Canva certificate document: Dim exports it from Canva as a PNG (light ink on a transparent background, or dark ink on white) and uploads it once in Seaded → Tunnistus → "Allkiri". It is never committed (the repository is public) and never mailed; the preview on black shows what the certificate will show.
- [ ] Maria's setup, before the first real student completes an e-course (Dim passes it on):
  1. Seaded → Tunnistus: the signature (the item above); "Järgmine number": the year and the number after her last paper certificate ("Viimati väljastatud" beside it shows the site's last one); "Praktilise töö rida": the plan's wording "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine" is a draft, she confirms or rewrites it; and she checks "Koht" (Pärnu linn), "Registrikood" (16346048) and "Koolitaja nimi" (Maria Sosnina).
  2. Each e-course's "Tunnistus" card (Koolitused → the course): "Oskused tunnistusel", the lines the certificate lists (empty: the course's "Õpiväljundid" are printed), and "Maht", e.g. "10 akadeemilist tundi" (empty: left out).
  3. One try with a sample student (`<label>.naidis@example.test`, "Proov (näidis)") on a temporary unpublished sample e-course "Proov (näidis)", completed by hand: confirm the name, download the PDF, open it on her tablet and on a phone, try "Paranda nimi". The try takes a real number of the series. Afterwards delete the sample account and the sample course by that exact address and that course only (never with the pattern `like '%.naidis@example.test'`, section 11; the certificate goes with the account), then set "Järgmine number" again to the number after her last paper certificate.
- [ ] From the go-live on, every paper certificate takes its number from Seaded: Maria writes the number Seaded shows as next and raises "Järgmine number" by one. The site refuses a next number at or below one it has issued that year, but it cannot know her paper ones.
- [ ] Dim approves the wording sheet (the plan's Wording appendix): the student's "Tunnistus" row and card link, the mail's line, the course editor's card, Seaded's card, the drawer's line, "Paranda nimi" and the register. The PDF's own texts ("TUNNISTUS", "KOOLITAJA", "REGISTRIKOOD", "Tunnistuse nr.") follow Maria's sample.
- [ ] Native-speaker check of the Russian texts this phase added, all in `src/i18n/dict/ru.ts`: `account.certificate.*` and `account.completionMail.completedCertificate`. The no-break space after в, с, к, о, у is enforced by `tests/unit/protocols.test.ts`. The certificate itself is Estonian only (D6).
- [ ] The privacy text (Seaded → Privaatsus) gets Maria's line about certificates: the name as confirmed and the course are kept with the account, shown only to the student and to Maria, and deleted with the account.
- [ ] Maria's own certificate, the design's reference, stays in the git-ignored `Assets/` (it carries a real student's name): never committed or published.
- [ ] Until the coming-soon gate is removed, students cannot reach the "Tunnistus" row or the PDF: real certificates after the public launch.
- [ ] Owner notes (Dim decides; nothing is changed until he does):
  - The signature is not frozen: a new signature appears on old certificates too (Maria's real signature in either case), and so does a new trainer's name when there is no signature.
  - A deleted account takes its certificate with it, and its number is not reused: the series has a gap.
  - A student who never confirms her name has no certificate ("Tunnistus: õpilane pole veel nime kinnitanud" in the drawer); Maria cannot issue one for her.
  - The student cannot correct her own name once issued; she writes to Maria ("Kui nimes on viga, kirjuta meile"), who uses "Paranda nimi" (no mail goes; Maria tells her).
  - The drawer's and the register's link says "Laada alla" (the spec's word); the student's says "Laadi tunnistus alla". Dim decides whether the admin's becomes "Laadi alla".
  - Contact courses stay on paper (Maria's answer of 12.10.2026).
```

- [ ] **Step 9: Run everything.** From `app/`:
  - `npx vitest run` (`tests/unit/test-addresses.test.ts` scans the new files and the docs: only `@example.test` and the listed public addresses), `npx tsc --noEmit`, `npx eslint .` — green and clean;
  - the whole `npx playwright test` once under `next dev` (the specs of the earlier phases share the database: nothing of this phase may leave a row they count; afterwards `docker exec mslab-pg psql -U postgres -d mslab -c "select count(*) from certificates c join course_access a on a.id = c.access_id join clients k on k.id = a.client_id where k.email like 'e2e-client-%'"` → 0, and no file is left under `app/.media-local/certificate/` that the setting does not name: `docker exec mslab-pg psql -U postgres -d mslab -c "select value->>'signatureKey' from settings where key = 'certificate'"` names the only one, or none);
  - `E2E_PROD_BUILD=1 npx playwright test certificate completion account-ecourse admin-clients` and the gate: `npx playwright test -c playwright.gate.config.ts` — PASS.

- [ ] **Step 10: Commit** (from the repository root).

```bash
git add app/tests/e2e/certificate.ts app/tests/e2e/certificate.spec.ts app/tests/e2e/certificate-race.spec.ts docs/deploy.md docs/launch-checklist.md
git commit -m "test(e2e): the certificate end to end and two issues at once on real Postgres; docs: the certificate's runbook and Maria's setup list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Wording (for the appendix):** none — this task adds no text a person reads in the app (the docs are Dim's and the controller's).

---

### Task 8: Migration 0009 on Railway, the merge, the push and a smoke check (controller)

Spec section 11. The controller runs this, not a subagent. mslab.ee is staging (Dim, 14.10.2026): after the final review, migrate, merge and push without a separate go-live decision.

The order is "the additive migration first, then the push". The live code never names `certificates` or the two new course columns, and the new columns have defaults, so 0009 cannot disturb it.

The ledger is `.superpowers/sdd/2026-10-15-certificate/progress.md` (git-ignored). Record counts and statuses only, never a URL, a key, a token or an address.

**Files:** none (the database, the deployment, the ledger).

- [ ] **Step 1: Branch checks.** Run the whole `npx vitest run`, `npx tsc --noEmit` and `npx eslint .`. Run `npm run build` and confirm the account routes are still prerendered and `/api/admin/tunnistus/[id]` is listed as ƒ. Run the e2e `certificate` specs under `next dev` and with `E2E_PROD_BUILD=1`, and the gate run. Finally, `git status` must be clean on `feat/certificate`.
- [ ] **Step 2 (read-only): Railway before.** Pull Maria's production env into the scratchpad (`vercel --global-config ~/.vercel-mslabinformation --cwd <scratchpad>/maria-link-rclg env pull <scratchpad>/rw.env --environment=production --yes`). Read `DATABASE_URL` only inside a node script, which prints counts only (read-only transaction):
  - `select count(*) from drizzle.__drizzle_migrations` → 9;
  - `select to_regclass('public.certificates') is null` → `t`.
- [ ] **Step 3: Migration 0009 on Railway.** Run `drizzle-kit migrate` from `app/` with that URL (`?sslmode=require` added when it has none), through a node script that never prints the URL. Check:
  - the migration count is 10;
  - `select count(*) from certificates` → 0;
  - `select count(*) from courses where certificate_volume <> '' or certificate_skills <> '[]'::jsonb` → 0.
  Then delete `rw.env`.
- [ ] **Step 4: Merge and push.** Run `git switch main`, `git pull --ff-only` and `git merge --no-ff feat/certificate`. Run the whole `npx vitest run` on the merged result, then `git push origin main` (this deploys mslab.ee) and `git branch -d feat/certificate`.
- [ ] **Step 5: READY and smoke.** Check `vercel --global-config ~/.vercel-mslabinformation ls mslab` until the newest deployment is Ready. Then:
  - `curl -s -o /dev/null -w '%{http_code}' https://mslab.ee/` → 200;
  - `curl -s https://mslab.ee/api/konto/tunnistus/1` → `{"ok":false,"error":"not_found"}` (the gate);
  - `curl -s -w ' %{http_code}' https://mslab.ee/api/admin/tunnistus/1` → `{"ok":false,"error":"unauthorized"} 401` (the new route is live);
  - `curl -s -w ' %{http_code}' https://mslab.ee/api/admin/allkiri` → 401.
- [ ] **Step 6: Tell Maria (through Dim) what to set up.** The list is `docs/launch-checklist.md` §13:
  1. Seaded → Tunnistus: the signature, the next number after her last paper certificate, and the wording of the practical line.
  2. Each e-course's "Tunnistus" card: the skills (or leave it empty to use "Mida õpid") and the volume.
  3. One try with a sample student on a sample e-course.
- [ ] **Step 7: Memory and ledger.** Record the deployment in the ledger and in the project memory (`mslab-next-phase-pending.md`). Migration 0010 (the drop of `courses.modules`) stays as planned: code first, then the migration.

---

## Wording appendix (for Dim's approval)

Every text this phase adds, by task and key. **Spec** marks a text the spec gives; **Draft** marks a text this plan proposes for Dim's approval (a change is the dictionary line only). The Russian is a draft for the native-speaker check. The certificate itself and the admin are Estonian only.

### Task 1: pdf-lib and the fonts, their tracing, migration 0009 (`certificates`, the course's certificate lines and volume), the pure rules (`domain/certificate.ts`); the drop of `courses.modules` becomes 0010

no dictionary key. The settings' defaults are printed on the certificate until Maria saves Seaded:

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| `CERT_DEFAULTS.place` (`src/domain/certificate.ts`) | Pärnu linn | — (the certificate is Estonian only, D6) | Spec (§3) |
| `CERT_DEFAULTS.registryCode` | 16346048 | — | Spec (§3) |
| `CERT_DEFAULTS.practicalLine` | Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine | — | Spec (§3; a draft for Maria) |
| `CERT_DEFAULTS.trainerName` | Maria Sosnina | — | Spec (§3) |

### Task 2: The certificate's PDF — `src/server/certificate-pdf.ts` (`loadCertificateAssets`, `renderCertificate`)

no dictionary key. The fixed texts printed on the certificate, in `src/server/certificate-pdf.ts` (Estonian only, D6):

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| PDF heading | TUNNISTUS | — | Spec (§7) |
| PDF bottom left, line 1 | REGISTRIKOOD: {code} | — | Spec (§7) |
| PDF bottom left, line 2 | Tunnistuse nr. {number} | — | Spec (§7) |
| PDF bottom right, under the signature | KOOLITAJA | — | Spec (§7) |
| PDF bottom right, last line | {place} {dd.mm.yyyy} | — | Spec (§7) |
| PDF logo | MS LAB / KOOLITUSKESKUS | — | Spec (§7: as `public/brand/logo.png`) |
| PDF title (document metadata) | Tunnistus {number} | — | Draft |

### Task 4: The student's side — the two account routes, the "Tunnistus" row, the card link, `account.certificate`, the completed mail's line

| key | ET | RU | Spec/Draft |
|---|---|---|---|
| `account.certificate.title` | Tunnistus | Сертификат | Spec (ET); RU Draft |
| `account.certificate.check` | Kontrolli, kuidas su nimi tunnistusel kirjas on | Проверьте, как ваше имя будет написано в сертификате | Spec (ET); RU Draft |
| `account.certificate.nameLabel` | Nimi tunnistusel | Имя в сертификате | Spec (ET); RU Draft |
| `account.certificate.issue` | Kinnita ja koosta tunnistus | Подтвердить и создать сертификат | Spec (ET); RU Draft |
| `account.certificate.issuing` | Koostan tunnistust… | Создаю сертификат… | Draft |
| `account.certificate.letters` | Kasuta nimes ainult tähti, tühikuid ja sidekriipse | Используйте в имени только буквы, пробелы и дефисы | Spec (ET); RU Draft |
| `account.certificate.length` | Nimi peab olema 2–80 tähemärki pikk | Имя должно быть длиной от 2 до 80 символов | Draft |
| `account.certificate.number` | Tunnistus nr. {number} | Сертификат № {number} | Spec (ET); RU Draft |
| `account.certificate.download` | Laadi tunnistus alla (PDF) | Скачать сертификат (PDF) | Spec (ET); RU Draft |
| `account.certificate.fixName` | Kui nimes on viga, kirjuta meile | Если в имени ошибка, напишите нам | Spec (ET); RU Draft |
| `account.certificate.cardLink` | Laadi tunnistus alla | Скачать сертификат | Spec (ET); RU Draft |
| `account.completionMail.completedCertificate` | Kinnita oma nimi ja laadi tunnistus alla: | Подтвердите своё имя и скачайте сертификат: | Spec (ET); RU Draft |

(In the code, the Russian strings write the no-break space after the one-letter preposition "в" as `\u00a0`: `в\u00a0сертификате`, `в\u00a0имени`. The other words keep a plain space.)

### Task 5: Admin settings and course text — the course editor's "Tunnistus" card, Seaded → "Tunnistus" with the signature, Maria's download

the admin is Estonian only.

| Key | ET | Spec/Draft |
|---|---|---|
| `adminEt.courseEditor.sections.certificate` | Tunnistus | Spec (§6 "a 'Tunnistus' card") |
| `adminEt.courseEditor.fields.certificateLead` | E-kursuse tunnistuse tekst. Juba väljastatud tunnistused jäävad selliseks, nagu need väljastati. | Draft |
| `adminEt.courseEditor.fields.certificateSkills` | Oskused tunnistusel | Spec (§6) |
| `adminEt.courseEditor.fields.certificateSkill` | Rida (a field's label: "Rida 1") | Draft |
| `adminEt.courseEditor.fields.certificateSkillsHint` | Tühjana kasutatakse „Mida õpid“ ridu | Spec (§6) |
| `adminEt.courseEditor.fields.certificateSkillsEmpty` | Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read. | Draft (names the editor's own card, which the public page calls „Mida õpid“) |
| `adminEt.courseEditor.fields.certificateSkillsAdd` | Lisa rida | Draft |
| `adminEt.courseEditor.fields.certificateSkillsFull` | Rohkem kui 16 rida ei saa lisada. | Draft |
| `adminEt.courseEditor.fields.certificateVolume` | Maht | Spec (§6) |
| `adminEt.courseEditor.fields.certificateVolumeHint` | nt 10 akadeemilist tundi. Tühjaks jättes tunnistusel ei näidata. | Spec (the example, §6) + Draft (the second sentence, §3) |
| `adminEt.certificates.settings.title` | Tunnistus | Spec (§6) |
| `adminEt.certificates.settings.lead` | Need andmed lähevad igale uuele e-kursuse tunnistusele. Väljastatud tunnistus jääb selliseks, nagu see väljastati; ainult allkiri on igal allalaadimisel praegune. | Draft |
| `adminEt.certificates.settings.place` | Koht | Spec (§6) |
| `adminEt.certificates.settings.placeHint` | Kuupäeva ees, nt Pärnu linn. | Draft |
| `adminEt.certificates.settings.registryCode` | Registrikood | Spec (§6) |
| `adminEt.certificates.settings.practicalLine` | Praktilise töö rida | Spec (§6) |
| `adminEt.certificates.settings.practicalLineHint` | Tunnistuse allservas vasakul, suurtähtedega. | Draft |
| `adminEt.certificates.settings.trainerName` | Koolitaja nimi | Draft |
| `adminEt.certificates.settings.trainerNameHint` | Kirjutatakse tunnistusele käekirjas, kui allkirja pole. | Draft |
| `adminEt.certificates.settings.nextNumber` | Järgmine number | Spec (§4, §6) |
| `adminEt.certificates.settings.nextYear` / `nextSeq` | Aasta / Number | Draft |
| `adminEt.certificates.settings.nextHint` | Jätka oma paberil tunnistuste numbreid. Uue aasta esimene tunnistus saab numbri 1. | Draft |
| `adminEt.certificates.settings.last` | Viimati väljastatud: {number} | Draft |
| `adminEt.certificates.settings.lastNone` | Sel aastal pole veel tunnistusi väljastatud. | Draft |
| `adminEt.certificates.settings.save` | Salvesta tunnistuse andmed | Draft |
| `adminEt.certificates.settings.saving` | Salvestan… | Draft (as `common.saving`) |
| `adminEt.certificates.settings.saved` | Tunnistuse andmed on salvestatud. | Draft |
| `adminEt.certificates.settings.invalid` | Kontrolli märgitud välju. | Draft (as `courseEditor.invalid`) |
| `adminEt.certificates.settings.error` | Salvestamine ei õnnestunud. Proovi uuesti. | Draft (as `common.saveError`) |
| `adminEt.certificates.settings.errors.required` | Täida see väli. | Draft |
| `adminEt.certificates.settings.errors.tooLong` | Tekst on liiga pikk. | Draft (as the editors') |
| `adminEt.certificates.settings.errors.invalid` | Kontrolli aastat (2000–2099) ja numbrit (1–99 999). | Draft (Task 3's ranges) |
| `adminEt.certificates.settings.errors.taken` | See number on juba väljastatud. Vali suurem number kui viimati väljastatud. | Draft (§4's rule) |
| `adminEt.certificates.settings.errors.other` | Kontrolli seda välja. | Draft |
| `adminEt.certificates.settings.signature` | Allkiri | Spec (§6) |
| `adminEt.certificates.settings.signatureHint` | Lae üles allkirja PNG-pilt (nt Canvast: hele allkiri läbipaistval taustal või tume allkiri valgel taustal) või tumeda pastakaga valgele paberile kirjutatud allkirja foto. Brauser teeb sellest valge allkirja läbipaistval taustal, nagu see tunnistusel paistab. | Draft (§6, and the controller's update of 15.10: Maria's Canva export) |
| `adminEt.certificates.settings.signatureAlt` | Allkiri, nagu see tunnistusel paistab | Draft |
| `adminEt.certificates.settings.signatureNone` | Allkirja pole: tunnistusel on koolitaja nimi käekirjas. | Draft (§6 "Seaded says so") |
| `adminEt.certificates.settings.upload` / `replace` | Lae allkiri üles / Vaheta allkiri | Draft |
| `adminEt.certificates.settings.remove` | Eemalda allkiri | Draft |
| `adminEt.certificates.settings.removeConfirm` | Kas eemaldan allkirja? Tunnistustel on siis koolitaja nimi käekirjas. | Draft |
| `adminEt.certificates.settings.removeYes` / `removeNo` | Jah, eemalda / Ei | Draft (as the drawer's confirmations) |
| `adminEt.certificates.settings.preparing` | Valmistan allkirja ette… | Draft |
| `adminEt.certificates.settings.removing` | Eemaldan… | Draft |
| `adminEt.certificates.settings.uploaded` | Allkiri on salvestatud. See on nüüd kõigil tunnistustel, ka varem väljastatutel. | Draft (§9: the signature is not frozen) |
| `adminEt.certificates.settings.removed` | Allkiri on eemaldatud. | Draft |
| `adminEt.certificates.settings.signatureErrors.decode` | Seda pilti ei saa avada. Vali JPG- või PNG-pilt. | Draft |
| `adminEt.certificates.settings.signatureErrors.empty` | Pildilt ei leitud allkirja. Vali pilt, kus on tume allkiri heledal taustal või hele allkiri läbipaistval taustal. | Draft |
| `adminEt.certificates.settings.signatureErrors.size` | Allkirja pilt on liiga suur. | Draft |
| `adminEt.certificates.settings.signatureErrors.session` | Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti. | Draft (as `upload.session`) |
| `adminEt.certificates.settings.signatureErrors.storage` | Failide salvestamine pole seadistatud — anna arendajale teada. | Draft |
| `adminEt.certificates.settings.signatureErrors.server` | Allkirja salvestamine ei õnnestunud. Proovi uuesti. | Draft |

### Task 6: Maria's side of an issued certificate — the Õpilased drawer's line, "Paranda nimi", the register `/admin/tunnistused`

the admin is Estonian only.

| Key | ET | Spec/Draft |
|---|---|---|
| `adminEt.certificates.drawer.line` | Tunnistus {number} · {date} | Spec (§6 "Tunnistus MS LAB 2026-03 · {date}") |
| `adminEt.certificates.drawer.reissued` | nimi parandatud {date} | Draft |
| `adminEt.certificates.drawer.name` | Nimi tunnistusel: {name} | Draft (the student's field "Nimi tunnistusel", §5) |
| `adminEt.certificates.drawer.download` | Laada alla | Spec (§6; Dim may prefer the imperative "Laadi alla", as the student's "Laadi tunnistus alla") |
| `adminEt.certificates.drawer.downloadLabel` | Laada alla tunnistus {number} | Draft (the link's accessible name) |
| `adminEt.certificates.drawer.notYet` | Tunnistus: õpilane pole veel nime kinnitanud | Spec (§6) |
| `adminEt.certificates.drawer.revoked` | ligipääs tühistatud | Spec (§9) |
| `adminEt.certificates.reissue.button` | Paranda nimi | Spec (§6) |
| `adminEt.certificates.reissue.label` | Nimi tunnistusel | Spec (§5's field) |
| `adminEt.certificates.reissue.hint` | Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta. | Draft (§6: same number, no mail) |
| `adminEt.certificates.reissue.save` | Väljasta uuesti | Draft |
| `adminEt.certificates.reissue.cancel` | Katkesta | Draft |
| `adminEt.certificates.reissue.done` | Tunnistus {number} on uuesti väljastatud nimega {name}. | Draft |
| `adminEt.certificates.reissue.errors.length` | Nimi peab olema 2–80 märki. | Draft |
| `adminEt.certificates.reissue.errors.letters` | Kasuta nimes ainult tähti, tühikuid ja sidekriipse | Spec (§5) |
| `adminEt.certificates.reissue.errors.notFound` | Seda tunnistust ei leitud. Laadi leht uuesti. | Draft |
| `adminEt.certificates.register.fromAssessment` | Väljastatud tunnistused | Draft |
| `adminEt.certificates.register.eyebrow` | Hindamine | Draft (the section it is reached from) |
| `adminEt.certificates.register.title` | Tunnistused | Draft |
| `adminEt.certificates.register.lead` | Kõik väljastatud e-kursuse tunnistused, uusimad eespool. | Draft |
| `adminEt.certificates.register.back` | Hindamisse | Draft (as `assessment.screen.back`) |
| `adminEt.certificates.register.count` | Tunnistusi: {n} | Draft |
| `adminEt.certificates.register.empty` | Tunnistusi pole veel väljastatud. | Draft |
| `adminEt.certificates.register.col.*` | Number · Nimi · Koolitus · Väljastatud · Tunnistus | Spec (§6 "number, name, course and issue date") + Draft (the download column's name) |
| `adminEt.certificates.register.reissued` | nimi parandatud {date} | Draft |
| `adminEt.certificates.register.revoked` | ligipääs tühistatud | Spec (§9) |
| `adminEt.certificates.register.openStudent` | Ava õpilane {name} | Draft |
| `adminEt.certificates.register.download` / `downloadLabel` | Laada alla / Laada alla tunnistus {number} | Spec (§6) / Draft |

---

## Self-review

### Spec coverage

| Spec section | Task |
|---|---|
| 1 Goal, D1–D6 | 1–7 |
| 3 Data: `certificates`, the two course columns, the `certificate` setting (with `trainerName`) | 1 (schema, migration, `readCertificateSettings`), 3 (reads and writes) |
| 4 Numbering: the format, year rollover, Maria's next number, no duplicates | 1 (`formatCertificateNumber`, `nextNumber`, `tallinnYear`), 3 (locks, unique backstop, "taken" refusal), 7 (race) |
| 5 The student: the "Tunnistus" row, name rules, issue, download after expiry, revoked 404, the ended card's link, the API, the mail line | 1 (`checkCertificateName`), 3 (`issueCertificate`, `certificateForStudent`), 4 (routes, row, card, mail) |
| 6 Maria: course card, Seaded card with the signature (Canva PNG or scan → white ink), drawer line with "Paranda nimi", register | 5, 6 |
| 7 The PDF: layout, fonts, vector logo, on-demand rendering, no-store | 1 (fonts, tracing), 2 (renderer), 3 (`certificatePdf`) |
| 8 Building blocks | 1–6 |
| 9 Edge cases | revoked: 3, 4, 6; deletion cascade: 1 (migration test), 3; two devices: 3, 7; settings changed: 3, 5; course renamed: 3 (frozen copy); year rollover: 1, 3; long titles and names: 2 |
| 10 Testing | each task's tests; 7 (e2e, race) |
| 11 Rollout (staging) | 8 |
| 12 Out of scope | nothing built for them |

### Spec against the code

| # | The spec says | The plan |
|---|---|---|
| 1 | Name rules: Latin or Cyrillic (as amended after the spike) | Only the letters Great Vibes can draw, so a name never prints as empty boxes. The signature and errors are unchanged (Task 1, tested against the font in Task 2). |
| 2 | Fonts in `outputFileTracingIncludes` | Keys `/api/konto/**` and `/api/admin/tunnistus/**`. Bracketed keys trace nothing under Turbopack. Also `.vercelignore` `!/app/assets` and `.gitattributes` `-text` for the fonts (Task 1). |
| 3 | §5 rate-limits "both" student routes at 10 an hour | Separate buckets: `client-certificate` (issue) and `client-certificate-pdf` (download) (Task 4). |
| 4 | §6 Seaded card | Its own form and action beside the settings form, so the existing Seaded tests are unaffected (Task 5). |
| 5 | §6 skills list | `ProtocolStagesEditor` gains `kind="skills"` with its own data hooks, so an e-course editor never shows two `[data-protocol-stages]` lists (Task 5). |
| 6 | §6 "the signature from Maria's Canva document" (Dim, 15.10) | `inkSignature` handles a light-on-transparent export and a dark-on-light scan. The file is never committed; it is uploaded once after the deploy (Tasks 5, 8). |

### Placeholder scan
No "TBD", "TODO", "implement later" or "similar to Task N". Every code step has its code, every test its assertions, and every command its expected result.

### For the owner (Dim, and Maria where named)
1. **The practical line** (Maria): "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine" (a draft; editable in Seaded).
2. **The signature** (Dim): export it from Maria's Canva document as PNG into `Assets/`; the controller uploads it after the deploy.
3. **The next number** (Maria): set "Järgmine number" to follow her last paper certificate before the first e-course completes.
4. **The Draft texts** in the Wording appendix (Dim), and the Russian native-speaker check.
5. **Re-issue mails nothing:** a corrected name is not announced to the student (spec §6).

