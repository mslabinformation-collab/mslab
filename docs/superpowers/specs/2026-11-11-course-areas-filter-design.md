# Course areas filter (koolitusvaldkonnad) — design

Status: approved in outline by Dim 11.11 (Maria-managed list, a pick per course, the filter on the calendar and on /koolitused). Everything marked *(my call)* is mine, for Dim to check while reading. All new texts are **Draft** and go to Dim's wording sheet.

## 1. Why

Maria (10.11): more courses are coming (brow and lash trainings), other trainers will join, and sessions will run on the same days in several cities. With every date on one page, a student has trouble finding the training they want. The calendar already filters by city; she asks for the same choice by training area, with „Kõik“ kept in both.

Today a course has only a format (contact or e-course) and a level (basic or advanced). Nothing says "brows" or "lashes".

## 2. Goals, non-goals

- **Goals:** Maria keeps the list of areas herself (Estonian and Russian name). Every course can have one area. The calendar and the catalogue let a student narrow by area, combined with the filters they already have.
- **Non-goals:** several areas per course; areas for the practice page or the news; month headings or a date picker in the calendar; a filter by trainer.
- **Anti-goals:** a filter row that offers only one choice besides „Kõik“; a link with an old or unknown area that shows an empty page instead of everything.

## 3. Data (one additive migration: the next free number, 0023 today)

- New table `course_areas`: `id serial pk`, `name jsonb I18n not null` (`{ et, ru }`, as every bilingual field), `sort integer not null default 0`.
- `courses.area_id integer null references course_areas(id) on delete restrict`. Null means no area: the course shows only under „Kõik“.
- The migration seeds two areas *(my call, the names from her message)*: „Kulmukoolitused“ / „Курсы по бровям“ (sort 1) and „Ripsmekoolitused“ / „Курсы по ресницам“ (sort 2). It sets no course's area: Maria picks them (her six courses, a minute's work), so nothing changes on the site until she does.
- `db/seed-data.ts` and the demo data give the local and e2e courses areas, so the filter is exercised.
- A migration test in the house pattern (`tests/db/migration-0022.test.ts`).

## 4. Admin

### 4.1 Seaded → „Valdkonnad“ (a new section of the Seaded page) *(my call: placement)*

- A card in the Seaded section map, in the existing autosave-card pattern (`components/admin/SettingsEditor.tsx`, `api/admin/seaded/<part>`), with its own version for the stale-save check like the other cards.
- One row per area: „Nimi (eesti keeles)“, „Nimi (vene keeles)“, move up/down (sort), „Kustuta“. Below: „Lisa valdkond“.
- Both names are required, at most 60 characters, trimmed; the Estonian names are unique (case- and accent-insensitive, by the same slug the URL uses, §5.3).
- „Kustuta“ works only for an area no course uses (live or in a draft). Otherwise the row says „Seda valdkonda kasutab {n} koolitust.“ and keeps it. *(my call: refuse rather than clear courses silently)*
- Lead (Draft): „Valdkonnad, mille järgi õpilane saab koolituskalendris ja koolituste lehel koolitusi valida. Koolituse valdkonna valid koolituse kaardil „Põhiandmed“.“ (use the basics card's real name.)

### 4.2 Course editor

- The basics part gets `areaId` (in `PART_FIELDS.basics`, the strict zod schema, the drafts layer, the field labels, `queries/admin.ts`), so it saves as a draft and goes live on publish, like the course's other basics.
- A „Valdkond“ select: „Määramata“ first, then the areas by sort. Hint (Draft): „Valdkonna järgi saab õpilane koolitusi kalendris ja koolituste lehel valida. Valdkondi muudad: Seaded → Valdkonnad.“
- An `areaId` that no longer exists (deleted between load and save) is refused with the editor's usual field error.

## 5. Public site

### 5.1 Calendar (/koolituskalender, RU /ru/koolituskalender)

- A second chip row, below the city chips, in the same chip style: „Kõik“ then the areas, by sort. `role="group"`, `aria-label` „Valdkond“ / „Направление“ (Draft), as the city row's „Linn“.
- The row lists only areas that have a session in the list, and is shown only when there are **two or more** such areas (anti-goal). A course without an area appears only under „Kõik“.
- City and area combine (AND). The `aria-live` results line counts what is shown.
- The address is the single source of truth, as for the city: `?valdkond=<slug>` next to `?linn=…`; a chip writes it in place (history.replaceState) and keeps the other parameters. An unknown or old slug reads as „Kõik“.
- The empty state: when the filters leave nothing, the text is „Valitud filtritega hetkel koolitusi pole.“ / „По выбранным фильтрам сейчас нет курсов.“ (Draft; replaces „Selles linnas hetkel koolitusi pole.“) and the button „Näita kõiki“ / „Показать все“ (Draft; replaces „Kõik linnad“) clears both filters. *(my call)*

### 5.2 Catalogue (/koolitused)

- A „Valdkond“ chip row in the existing filter arrangement (`components/site/CatalogueFilters.tsx`), after the level chips, same style and the same „Kõik“ chip text; same rule: only areas that have a listed course, shown only for two or more.
- `?valdkond=<slug>`, combined with `vorm`, `tase` and `otsi`; „Lähtesta filtrid“ clears it too.

### 5.3 The slug

`citySlug(name.et)` (domain/calendar.ts: normalised, spaces to hyphens), e.g. `kulmukoolitused`. The Russian pages use the same Estonian slug. A renamed area gets a new slug; old links fall back to „Kõik“.

## 6. Tests and test plan

- Unit: the area chip list (only present areas, two-or-more rule, sort order), parsing the slug, the AND filter, the empty state's reset; the catalogue filter the same way.
- DB: the migration; the Seaded card (add, rename, reorder, delete refused while used, the version check); the course basics save with `areaId` (draft, publish, a deleted area refused).
- E2E (written, run by the controller after merge): the calendar on desktop and phone with two areas (pick an area, pick a city, the URL, reload, the empty state and „Näita kõiki“), the RU calendar, the catalogue chip.
- `src/data/testplan.json`: new checks for the Seaded card, the course „Valdkond“ field, the calendar row and the catalogue row; redo the existing calendar and catalogue filter checks whose steps change; marks `new`/`redo`/`reworded` with `markedAt "deploy"`, house style (`checkPlan`).

## 7. Left to the builder

The card's layout within the admin UX conventions; the exact wording around the Draft texts, within the glossary; the query shape (`listUpcomingSessions` and the catalogue query return the course's area id, the page reads the area list once).
