# Certificate designs (tunnistuse kujundused) — design

Status: approved in outline by Dim 11.11 ("Pick per course": designs kept in Seaded → Tunnistus, Dark and Light to start, the course's certificate card picks one, the choice stored on each certificate at issue). Everything marked *(my call)* is mine, for Dim to check. All new texts are **Draft** and go to Dim's wording sheet.

## 1. Why

The e-course certificate PDF (`server/certificate-pdf.ts`) is laid out as Maria's Canva certificate but drawn white on black, with no background. Her paper certificates are light: a white flower photo behind dark text (reference: `public/seed/certificate-white.jpg`). She sent the background on 10.11. Dim chose designs Maria can pick per course over one fixed light design.

No certificate has been issued on mslab.ee yet (11.11), so nothing issued changes.

## 2. Goals, non-goals

- **Goals:** a list of designs in Seaded → Tunnistus (name, tone, optional background photo); a „Kujundus“ pick on the course's „Tunnistus“ card; the design frozen on each certificate when it is issued; the light tone draws dark text and the black logo over the photo.
- **Non-goals:** moving or resizing the text per design (the layout stays the Canva one); fonts per design; a colour picker; contact-course certificates (they stay on paper, Maria 10.11).
- **Anti-goals:** an issued certificate that changes look because Maria later edited or deleted a design; a PDF of several megabytes.

## 3. Data (one additive migration: the next free number after the areas filter's, 0024 if that lands first)

- New table `certificate_designs`: `id serial pk`, `name text not null` (Estonian only, admin-facing), `tone text not null check (tone in ('light','dark'))`, `background_key text not null default ''` (an image key from the admin upload, `img/<uuid>.jpg`; empty = no photo), `sort integer not null default 0`.
- The migration seeds *(my call)*: „Hele“ (tone `light`, no photo yet, sort 1) and „Tume“ (tone `dark`, no photo, sort 2). After deploy the controller uploads Maria's background to „Hele“ through the admin (the file is never committed: it is her Canva stock photo).
- `courses.certificate_design_id integer null references certificate_designs(id) on delete restrict`. Null means "the first design" (lowest `sort`, then `id`) *(my call)*, so a new e-course and today's e-course get „Hele“ without anyone picking.
- `certificates.design jsonb null`: `{ tone, backgroundKey }` copied at issue. Null (every certificate issued before this change) draws exactly today's dark design. A re-issue („Paranda nimi“) keeps the frozen design *(my call: only the name changes)*.
- `db/seed-data.ts`/demo data: both designs; local and e2e use a small generated test JPEG for „Hele“ (committed test fixture, made by us), never Maria's photo.
- A migration test in the house pattern (`tests/db/migration-0022.test.ts`).

## 4. The PDF

- `renderCertificate` takes the frozen design. `dark`: black page, white text, `logo-white.png` (today). `light`: white page, black text and lines, `logo-black.png` (`LOGO_FILES.black`, already committed).
- With a `backgroundKey`, the photo is read from the media store (`server/media.ts` `mediaStore()`), embedded with pdf-lib's `embedJpg`, and drawn first, scaled to **cover** the A4 landscape page and centred (cropped, never stretched). It is cached per process by key, like the fonts.
- If the photo cannot be read (missing object, store down), the download fails and is tried again, as a failed font read does today *(my call: never issue a silently different-looking PDF)*.
- Size: the background upload is limited to **JPEG, at most 1.5 MB** *(my call: no image processing in the app; sharp is not a direct dependency and must not be added)*. `tests/unit/certificate-pdf.test.ts` keeps the dark design under 300 KB and holds a design with a background under 300 KB + the photo's size + 50 KB.
- The sample certificate (`api/admin/naidistunnistus`) takes a design id, so each design row can show its sample.

## 5. Admin

### 5.1 Seaded → Tunnistus: „Kujundused“

- Inside the existing Tunnistus section (`components/admin/CertificateSettings.tsx`), in its autosave-card pattern with its own version for the stale-save check.
- One row per design: „Nimi“ (required, at most 40 characters, unique), „Toon“ („Hele taust, tume tekst“ / „Tume taust, hele tekst“), „Taustapilt“ (the existing single-image upload, optional; hint: „JPEG, kuni 1,5 MB, horisontaalne A4 (näiteks 3508 × 2480 px). Pilt kärbitakse lehe järgi.“), „Vaata näidist“ (opens the sample PDF of that design), „Kustuta“. Below: „Lisa kujundus“.
- „Kustuta“ only for a design no course uses (live or draft) and not the last one. Otherwise: „Seda kujundust kasutab {n} koolitust.“ Issued certificates keep their frozen copy, so deleting is safe for them; the R2 photo is never deleted while a certificate names it (no clean-up of background images at all) *(my call)*.
- Lead (Draft): „Tunnistuse taust ja teksti värv. Koolituse kaardil „Tunnistus“ valid, millist kujundust see koolitus kasutab. Väljastatud tunnistused jäävad selliseks, nagu need väljastati.“

### 5.2 The course's „Tunnistus“ card

- The certificate part gets `certificateDesignId` (in `PART_FIELDS.certificate`, the strict zod schema, the drafts layer, `queries/admin.ts`, `EMPTIED_FOR_TYPE.contact` → null), so it saves as a draft and goes live on publish, like `certificateTitle` (F4, migration 0022 — the same path to copy).
- A „Kujundus“ select listing the designs by sort; null shows as the first design. Hint (Draft): „Kujundusi muudad: Seaded → Tunnistus.“
- The issue (`server/certificates.ts`) resolves the course's design (null → first) and freezes `{ tone, backgroundKey }`.

## 6. Tests and test plan

- Unit: the PDF for both tones (colours, logo choice, the background drawn first and covering the page, the size limits), the design resolution (null → first), the upload limit (type, size).
- DB: the migration; the Seaded card (add, rename, tone, photo, delete refused while used or last, the version check); the course card save with `certificateDesignId`; the issue freezes the design; a re-issue keeps it; an old certificate (design null) still renders dark.
- E2E (written, run by the controller after merge): Seaded → Tunnistus designs (add a design, sample PDF), the course card pick, the issued certificate PDF downloads (existing `tests/e2e/certificate.spec.ts`).
- `src/data/testplan.json`: new checks for „Kujundused“ and the course card's „Kujundus“; redo the certificate PDF checks (`ekursus-tunnistus` and the ones whose look changes); house style, marks with `markedAt "deploy"`.

## 7. Left to the builder

The rows' layout within the admin UX conventions; the exact light-tone colours (black or the site's near-black, matching the reference photo); the wording around the Draft texts, within the glossary.
