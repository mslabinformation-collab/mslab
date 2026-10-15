# E-course certificate (phase 3d) — design

Status: approved in conversation on 15.10.2026 (Dim). Maria's own certificate is the visual reference. Its file lives only in the git-ignored `Assets/` folder and contains a real student's name, so it is never committed or published.

## 1. Goal

When an e-course is "Lõpetatud" (`course_access.completed_at`, set once Maria has approved the practical work), the student gets a certificate she can download as a PDF in her account. The certificate looks like Maria's paper ones, continues their numbering, and carries the name the student confirmed and Maria's real signature. Contact courses stay on paper (Maria's answer of 12.10.2026).

Success:
- **The student:** confirms her name once and downloads a PDF that looks like Maria's certificate.
- **Maria:** sees every issued certificate in one register, can correct a name, and never numbers a certificate twice.

## 2. Decisions (Dim, 15.10.2026)

| # | Decision |
|---|---|
| D1 | E-courses only. A certificate becomes available automatically when the access is completed. |
| D2 | One number series with Maria's paper certificates: "MS LAB {year}-{nn}". Maria sets the next number once in Seaded. |
| D3 | The student confirms the spelling of her name before the certificate is made. Maria can correct it later and re-issue it under the same number. |
| D4 | Maria's real signature is uploaded once as an image. |
| D5 | Approach A: the PDF is generated on the server with `pdf-lib` and `@pdf-lib/fontkit` (MIT, pure JavaScript). Two OFL fonts are committed: a geometric sans and a handwritten script. This is the phase's only new dependency. |
| D6 | The certificate is in Estonian only, as Maria's sample is. The pages around it are in the student's language (ET/RU). |

## 3. Data (migration `0009_certificates`, additive)

The planned drop of `courses.modules` moves to `0010` (code first, then the migration).

- **`certificates`**:
  - `id` serial;
  - `access_id` unique, referencing `course_access` on delete cascade, so the certificate is deleted with the account;
  - `number` text unique ("MS LAB 2026-03"), `year` integer and `seq` integer, unique together;
  - the frozen copy:
    - `name` text (as confirmed);
    - `course_title` text (the course's Estonian title);
    - `skills` jsonb text[];
    - `volume` text;
    - `practical_line` text;
    - `place` text;
    - `registry_code` text;
  - `issued_at` timestamptz (the date printed);
  - `reissued_at` timestamptz null;
  - `created_at`.
  - A later course or settings change never alters an issued certificate. A re-issue changes only `name` and `reissued_at`.
- **`courses.certificate_skills`**: jsonb text[], default `[]`. These are the certificate's competency lines, plain text in Estonian; at most 16, each at most 120 characters. When the list is empty, the course's `outcomes` (Estonian) are used, up to the limit.
- **`courses.certificate_volume`**: text, default `''`, for example "10 akadeemilist tundi". It is left out of the PDF when empty.
- **Settings** (the existing `settings` key-value table), key `certificate`:
  - `{ place, registryCode, practicalLine, nextYear, nextSeq, signatureKey }`.
  - Defaults:
    - place: "Pärnu linn";
    - registryCode: "16346048";
    - practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine" (a draft for Maria);
    - nextYear: the current year, nextSeq: 1;
    - signatureKey: null.
  - `signatureKey` is a private R2 object `certificate/signature-<uuid>.png`.

## 4. Numbering

- A certificate issued in year Y (Tallinn date) takes:
  - `seq = nextSeq` when `nextYear == Y`;
  - else `seq = 1`, so the series starts again each year.
  - The setting then becomes `{ nextYear: Y, nextSeq: seq + 1 }`.
- `number = "MS LAB " + Y + "-" + pad2(seq)`; for example 2026-03, and 2026-123 once the sequence reaches three digits.
- **No duplicate numbers.** The issue runs in one transaction. It locks the access row first, then takes a transaction-scoped advisory lock `certificate-number` before reading and writing the setting. The unique (`year`, `seq`) is the backstop: two certificates issued at the same moment get two numbers.
- **Maria's setting:** "Järgmine number" in Seaded sets `nextYear`/`nextSeq`. The page shows the last issued number beside it. A number lower than or equal to an issued one in the same year is refused with a field error.

## 5. The student's side

On the e-course page, once `completedAt` is set, the "Lõpetamine" block gets a "Tunnistus" row:
- **Not yet issued:**
  - the text "Kontrolli, kuidas su nimi tunnistusel kirjas on";
  - a field "Nimi tunnistusel", filled with her account name;
  - one primary button "Kinnita ja koosta tunnistus".
  - **Name rules** (trimmed): 2–80 characters, at least two letters; only Latin letters (Estonian and common European letters included), spaces, hyphens, apostrophes and dots. Anything else is refused with "Kirjuta nimi ladina tähtedega, nagu passis". The script font has no Cyrillic.
- **Issued:**
  - "Tunnistus nr. MS LAB 2026-03";
  - the link "Laadi tunnistus alla (PDF)", pointing to `GET /api/konto/tunnistus/<id>` (owner only), which answers with `Content-Disposition: attachment; filename="MS-LAB-tunnistus-2026-03.pdf"`;
  - the name is no longer editable by her. "Kui nimes on viga, kirjuta meile" links to the contact page.
- **Access:**
  - The download keeps working after her access has expired.
  - A revoked access answers 404: Maria revoked it, for example after a refund.
  - The e-course page itself still needs active access, as today. The dashboard card of an ended access with a certificate gets the quiet link "Laadi tunnistus alla", the one way back to the certificate after the access ends.
- **API:**
  - `POST /api/konto/kursus/<slug>/tunnistus` with `{ name }` issues the certificate. It answers 200 with the view; 409 `already` with the view when it is issued already; 409 `notCompleted`; 400 `name`; 404.
  - `GET /api/konto/tunnistus/<id>` returns the PDF.
  - Both are behind `requireClient`, rate-limited (10 an hour per client), and behind the coming-soon gate like every account route.
- **Mail:** the existing "completed" mail ("Palju õnne!…") gets one more line: "Kinnita oma nimi ja laadi tunnistus alla:" with the course page link. No attachment.

## 6. Maria's side

- **Course editor (e-courses):** a "Tunnistus" card with:
  - "Oskused tunnistusel": a list of lines, with the hint "Tühjana kasutatakse „Mida õpid“ ridu";
  - "Maht", for example "10 akadeemilist tundi".
- **Seaded:** a "Tunnistus" card with:
  - "Koht" and "Registrikood";
  - "Praktilise töö rida";
  - "Järgmine number" (year and number, with the last issued number shown);
  - "Allkiri": upload a photo or scan.
    - The browser makes it white ink on a transparent background: pixels darker than a threshold become white, the rest transparent. It is then shrunk to at most 1200 px wide and sent as PNG.
    - It is stored privately, and a preview is shown on a black box.
    - Without a signature, the certificate shows Maria's name in the script font instead, and Seaded says so.
- **Õpilased drawer**, for each completed access:
  - "Tunnistus MS LAB 2026-03 · {date}" with "Laada alla" (`GET /api/admin/tunnistus/<id>`);
  - "Paranda nimi": a small form with the same name rules. It re-issues under the same number, sets `reissued_at`, and sends no mail.
  - Before the student has confirmed, the line says "Tunnistus: õpilane pole veel nime kinnitanud".
- **Register:** `/admin/tunnistused`, linked from "Hindamine" (not in the menu). It lists number, name, course and issue date, newest first, 50 a page, each with its download.

## 7. The PDF

- **Page and style:** A4 landscape (842 × 595 pt), black background (`#000`), white text. Laid out as Maria's sample:
  - "TUNNISTUS": the sans, about 54 pt, centred.
  - **The course title:** upper case, letter-spaced about 0.35 em, about 18 pt.
  - **The student's name:**
    - in the script font, about 54 pt, centred, above a thin white line about 70 % of the width;
    - a long name shrinks to fit the line, down to 30 pt, then wraps to two lines.
  - **Skills:** two columns of "• line", about 9.5 pt, letter-spaced, filled left column first. With more than 12 lines the font shrinks to 8.5 pt.
  - **The practical-work line:** upper case, about 8 pt, at the left. The volume (upper case) is at the right on the same baseline.
  - **Bottom left:**
    - the MS LAB logo (the site's `public/brand/logo.png`, drawn white on black);
    - "REGISTRIKOOD: {code}";
    - "Tunnistuse nr. {number}".
  - **Bottom right:**
    - the signature image (or the script name);
    - "KOOLITAJA";
    - "{place} {dd.mm.yyyy}" (the Tallinn date of `issued_at`).
- **Fonts:** a geometric sans close to the sample's title (Jost, OFL) and a handwritten script (Great Vibes, OFL, with Latin Extended glyphs; Jost and Great Vibes are the decided fonts). Both are committed under `app/assets/fonts/` with their licence files and embedded as subsets.
- **Generation:** on each download, from the frozen row, the settings' signature and the logo, in a few tens of milliseconds. Nothing is stored in R2 except the signature. The answer is `private, no-store`.
- **Old Safari:** the PDF is generated on the server only, so the browser bundles nothing new.

## 8. Building blocks

| Unit | Responsibility |
|---|---|
| `src/domain/certificate.ts` | Pure: the name rules, the number format, the next-number rule (year rollover), the skills fallback and limits. |
| `src/server/certificates.ts` | Issue (locks, number, frozen copy), re-issue, the student's and Maria's reads, settings read and write. |
| `src/server/certificate-pdf.ts` | `renderCertificate(row, assets) → Uint8Array` (pdf-lib, fontkit, layout). |
| `src/server/account-api.ts` | The two student routes. |
| `src/app/api/admin/tunnistus/[id]/route.ts` | Maria's download (`withAdmin`). |
| Admin | The course editor card, the Seaded card (signature upload with the browser's white-ink conversion), the drawer line with "Paranda nimi", the register page. |
| Account | The "Tunnistus" row in "Lõpetamine", the card link, `account.certificate` texts in ET and RU. |
| Mail | One line added to the "completed" mail (`account.completionMail`). |

## 9. Edge cases

- **Completion is never undone.** Revoking the access hides the certificate (404 to her). Maria's drawer still shows it, marked "ligipääs tühistatud".
- **Account deletion:** the certificate goes with the account (cascade). Its number is not reused; the series has a gap.
- **Two devices confirming at once:** one certificate. The second gets `already` with the same view.
- **Settings changed after issue:** place, registry code and practical line are frozen per certificate. The signature is not frozen: a new signature appears on later downloads of old certificates too (Maria's real signature in either case).
- **Course renamed after issue:** the certificate keeps the old title (frozen).
- **Year rollover at Tallinn midnight on 31.12:** covered by unit tests.
- **Long course titles:** they wrap to two lines and shrink to 14 pt.

## 10. Testing

- **Unit:**
  - the name rules (Estonian letters, Cyrillic refused, length);
  - the number format and padding;
  - next-number with year rollover;
  - the skills fallback.
- **PDF:** render a fixture with pdf-lib and parse it back:
  - one page, 842 × 595;
  - the embedded fonts are present;
  - the text includes "TUNNISTUS", the name, the number and the date;
  - it is under 300 KB.
- **Database (PGlite):**
  - issuing needs completion;
  - the number comes from the setting, and the setting advances;
  - issuing twice gives `already`;
  - re-issue keeps the number and changes the name;
  - a revoked access gets 404;
  - deletion cascades;
  - a "next number" at or below an issued one is refused.
- **Real Postgres (e2e):** two accesses issuing at the same moment get two different numbers.
- **End to end:**
  - complete → confirm the name → download (`%PDF`, filename);
  - Maria's drawer shows it, and "Paranda nimi" re-issues it;
  - the register lists it;
  - widths 390/834/1194/1440.

## 11. Rollout (staging)

1. Migration `0009` on Railway first.
2. Push `main`.
3. Maria fills Seaded → Tunnistus (signature, next number) and each e-course's "Tunnistus" card, then tries it with a sample student.

## 12. Out of scope

- certificates for contact courses or practice packages;
- a Russian or bilingual certificate;
- a public verification page;
- a QR code;
- attaching the PDF to the mail;
- printing services.
