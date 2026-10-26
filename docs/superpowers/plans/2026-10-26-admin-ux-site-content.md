# Admin UX pass, piece 4a: the site-content draft layer, Praktika, Koolitaja, Avaleht — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the site-content editors C5 Praktika, C2 Koolitaja and C1 Avaleht on the draft layer, as designed. Every field autosaves into a draft, and the public pages keep the live content until „Avalda muudatused“. „Eelvaade ↗“ shows the draft on the public page, and „Loobu muudatustest“ drops it.

**Architecture:**
- **Draft layer.** A site-content layer sits over piece 1's `content_drafts` and `server/drafts.ts`, and is shared by every site editor. It has three entities, `home`, `trainer` and `practice`, each with a fixed id `0`. Their parts are the parts `server/admin-site.ts` already defines.
- **Routes and checks.** One generic set of admin routes autosaves, publishes and discards any part. A draft save runs a loose check, and the publish runs the parts' existing strict checks and writers, so incomplete rows wait in the draft.
- **Client.** A client shell (header, one SaveStatus, PublishBar, section map) hosts each editor.
- **Preview.** Public overlay readers show drafts in draft mode.
- **Piece 4b and 4c.** 4b moves Uudised and Hüpikaken onto this same layer and deletes the old SaveBar chain. 4c does Tagasiside, Testimine and Sisselogimine.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`, built as designed. This plan covers §8 item 4 for C1, C2 and C5, together with the shared site-editor template and B2's draft layer.

Other sources:
- **Design:** `docs/superpowers/specs/admin-ux-pass/handoff/README.md`: §1.8 the draft bar, and §4 C1, C2, C5 with the template line; prototypes `… Part 3.dc.html` and `… Part 4.dc.html`.
- **Approved texts:** **`docs/superpowers/specs/admin-ux-pass/analysis/piece4-texts.md`**. Dim approved them on 26.10: S4-1…S4-17, S4-31…S4-34, the reused texts of §3, the dead keys of §4, and the builder notes of §5.
- **Code map** (git-ignored; read it first): `.superpowers/sdd/piece4-research-c1-c5.md`. It lists every function, file and test this plan touches, with line numbers.
- **Screens:** `analysis/screens.md` C1, C2, C5 and the "Template" paragraph.

## Global Constraints

Piece 3a's Global Constraints apply word for word: `docs/superpowers/plans/2026-10-23-admin-ux-courses.md`, the section of that name. Read „piece3-texts.md“ there as „piece4-texts.md, then piece3-texts.md“. These are added:
- **Migration.** None in this plan; `content_drafts` exists. If a task finds one is needed, it stops and reports.
- **Always drafted.** On these three screens every field waits for „Avalda muudatused“. There is no instant control; a slide's „Näidatakse avalehel“ is a drafted field (builder notes §5).
- **Fields the mocks leave out stay.**
  - C1: the slide kicker, button text and link, „Näidatakse avalehel“, and both focal views.
  - C2: „Amet“.
  - C5: „Nimi“, „Lühitekst“ and the hints.
- **The bar's buttons.** All three („Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“) show on every bar (README §1.8 wins over the mocks).
- **The old save path stays for piece 4b.** `SaveBar`, `useSiteDraft`, `site-draft.ts` and the actions `saveCampaign`, `savePost` and `deletePost` are still used by Uudised and Hüpikaken. Only the actions this plan replaces leave: `saveHome`, `saveTrainer` and `savePractice`, together with their `admin-guards` pins.
- **Images upload at once** (`ImageUpload` → `/api/admin/upload`). A draft holds only the key. Nothing deletes a file on discard; harmless orphans are accepted.

## Rulings carried (spec silent)

- **R-a. Entities.** `content_drafts.entity` takes `"home"`, `"trainer"` and `"practice"`, each with `entity_id = 0`.
  - The part names are the existing ones:
    - home: `slides`, `statement`, `teaser`, `faq`;
    - trainer: `trainer`, `bio`, `works`, `center_story`, `trainer_journey`;
    - practice: one part per package code, read from `practice_packages`.
  - The design's cards are views over these parts. „Portree ja tutvustus“ shows fields of `trainer` and `bio`; „Numbrid“ shows `trainer.stats`. No part is split.
- **R-b. Versions.**
  - The engine version is `"l:<hash>"` while a part has no draft and `"d:<draftRowId>.<n>"` with one, as `course-parts.ts` does.
  - The hash is `contentVersion` of the part's **draft-shaped live value**, never of the stored row, so a column outside the part cannot block its draft.
- **R-c. Locks.**
  - A draft save takes only the advisory lock `site-draft:<entity>:<id>`, never a table lock (precedent `legal-drafts.ts` `lockText`).
  - A publish takes the same advisory lock first, then `lockTables` for all of the entity's tables at once, in their alphabetical order, before any draft is read.
- **R-d. Two checks.**
  - A draft save runs a **loose** check: types, length limits and list caps only. So a new slide without a picture or title is kept in the draft.
  - The publish runs each part's existing **strict** check (`Part.check`) inside `Publisher.hold`. A part that fails is blocked with `missing` labels in the S4-1/S4-2 words, e.g. `Puudub: slaid 3 pilt`. The other parts publish.
- **R-e. Discard.** „Loobu muudatustest“ drops every draft of the entity (`discardDrafts`), on all three screens.
- **R-f. Preview.**
  - In draft mode with a live admin session (`previewActive()`), the public home, `/koolitaja` and `/praktika` read each part's draft. A part whose draft fails the strict check shows its live value instead, as `withCourseDrafts` does.
  - A signed-out visitor and every cached render see live content only.
  - The footer (in the ISR site layout) always shows live values, and its "nothing here depends on the request" rule stays.
- **R-g. The trainer gallery.** `GalleryEditor` gains `layout="grid"`: 120 px tiles, each with a 32 px round ✕, a „+ Lisa“ tile, and the counter of S4-15. Only Koolitaja uses it; the course gallery stays as 3a built it (builder notes §5).
- **R-h. Practice points.** Enter in the last point's field adds a new empty point and moves the cursor into it (S4-33). Enter in any other point does nothing new.
- **R-i. Row labels.** S4-1's labels come from a pure differ of draft against live, in `domain/site-changes.ts`. A row is numbered by its position in the draft, starting at 1. `(RU)` is added when only the Russian side of a field differs.

## Review Focus

1. **Two tabs on the same card.**
   - Expected: the second tab's save is a conflict, its text is kept, and „Taasta minu tekst“ works as in piece 2.
   - Pinned by Task 1 db tests (version compare) and Task 2 DOM tests.
2. **„Avalda muudatused“ while another tab is still saving that part.**
   - Expected: the publish reads drafts under the lock. A part whose draft or live value moved after the bar was drawn is blocked as `changed` and stays a draft, and nothing is half-published.
   - Pinned by a Task 1 db test.
3. **An incomplete row** (a new slide with no picture; a package with an empty price).
   - Expected: it autosaves, and the bar lists it as `Puudub: …`. The other parts still publish, and the incomplete one stays a draft.
   - Pinned by Task 1 db tests and Task 6 e2e.
4. **Preview leaks.**
   - Expected: a signed-out visitor, or a signed-in admin without draft mode, never sees a draft. Cached pages are not changed by a preview.
   - Pinned by Task 3 db tests and e2e.
5. **„Loobu muudatustest“ or „Avalda“ pressed while a save is in flight.**
   - Expected: a flush with one bound first, then the press. No draft is lost or brought back after a discard.
   - Pinned by Task 2 DOM tests.

---

### Task 1: Site draft server — registry, autosave, publish, discard

**Files:**
- Create:
  - `src/domain/site-entities.ts`
  - `src/server/site-drafts.ts`
  - `src/app/api/admin/sisu/[entity]/[id]/osa/[part]/route.ts`
  - `src/app/api/admin/sisu/[entity]/[id]/avalda/route.ts`
  - `src/app/api/admin/sisu/[entity]/[id]/loobu/route.ts`
- Modify:
  - `src/server/admin-site.ts`: export `homeParts`, `trainerParts` and `practiceParts`; add each part's loose check (R-d). The old `saveHome`, `saveTrainer` and `savePractice` actions stay until Tasks 6, 5 and 4 remove them.
- Test:
  - `tests/db/site-drafts.test.ts` (new);
  - `tests/unit/admin-guards.test.ts` (new routes);
  - `tests/unit/autosave-route.test.ts` if the helper changes.

**Interfaces:**
- Produces:
  - `type SiteEntity = "home" | "trainer" | "practice"`; `SITE_ENTITY_ID = 0`; `isSiteEntity(s: string): s is SiteEntity`.
  - `type SitePartState = { version: string; value: unknown; live: unknown }`.
  - `readSiteEditor(q: Q, entity: SiteEntity): Promise<{ stamp: string; parts: Record<string, SitePartState> }>`.
  - `writeSitePart(db: Db, entity: SiteEntity, part: string, patch: unknown, version: string, admin: string, now: Date): Promise<SaveAnswer>`.
  - `publishSite(db: Db, entity: SiteEntity, now: Date): Promise<{ stamp: string; published: string[]; blocked: { part: string; reason: "changed" | "missing"; fields: string[] }[] }>`.
  - `discardSite(db: Db, entity: SiteEntity): Promise<{ stamp: string }>`.
  - Routes:
    - `POST /api/admin/sisu/<entity>/0/osa/<part>`: autosave, through `autosaveHandler`.
    - `POST …/avalda`: `200 {stamp, published, blocked}`.
    - `POST …/loobu`: `200 {stamp}`.
    - An unknown entity, id or part is a 404.
- Consumes:
  - `readDrafts`, `saveDraftPart`, `dropDraftPart`, `discardDrafts`, `publishDraftsIn` and `type Publisher` from `src/server/drafts.ts`;
  - `contentVersion` from `src/lib/version.ts`;
  - `readStamp` from `src/server/read-stamp.ts`;
  - `revalidatePublic` from `src/server/public-cache.ts`, with today's kinds `home`, `trainer` (with part names) and `practice`.

- [ ] **Step 1: Failing db tests**, `tests/db/site-drafts.test.ts`:
  - A save to `practice/MINI` with `version` = the read's version stores a draft. The read then answers `d:…` with the draft value and the unchanged `live`, and the public reader (`getPracticePackages`) still returns the live price.
  - **Conflict.** A save with a stale version answers `conflict`, with the stored version and value.
  - **Typing back.** A save that types a field back to its live value drops the draft. The read answers `l:…` again.
  - **Loose check.** A `home/slides` save with a new slide that has no picture and no title is stored. A title over 120 characters is refused as `invalid` with field codes.
  - **Publish.** With drafts on `slides` and `faq`, `publishSite("home")` writes both. Live then equals the drafts, the drafts are gone, and the slide ids are kept (`saveSlides` keeps ids).
  - **Blocked part.**
    - Setup: a `slides` draft whose new slide has no picture, beside a valid `faq` draft.
    - Expected answer: `blocked: [{part:"slides", reason:"missing", fields:["slaid 3 pilt"]}]`, with `published: ["faq"]`. The words follow S4-2 and S4-12.
  - **Changed meanwhile.** A live row that changed after the draft was based (a direct `saveSlides` in the test) is blocked as `changed` and stays a draft.
  - **Discard.** `discardSite("trainer")` removes every trainer draft, and the read answers the live values.
  - **Versions.**
    - Changing `settings.trainer.contactPhotoKey` does not move the `trainer` part's version (R-b, draft-shaped hash).
    - Changing a package that is not in a part does not move the other part's version.
- [ ] **Step 2: Run** `npx vitest run tests/db/site-drafts.test.ts`. They FAIL.
- [ ] **Step 3: Implement** the registry, the read, write, publish and discard functions, and the three routes (`withAdmin`; `export const maxDuration = 30` as the other admin routes have).
  - The publish's `Publisher`:
    - `lock` = R-c;
    - `liveVersion` = the R-b hash;
    - `hold` = each part's strict `check`, with failures mapped to R-i labels;
    - `write` = the `Write` that `check` returned;
    - `revalidate` = once, with the entity's kinds.
- [ ] **Step 4: Run** the db file, `tests/unit/admin-guards.test.ts`, `tests/db/drafts.test.ts` and `tests/db/admin-site.test.ts`. All pass.
- [ ] **Step 5: Commit** `feat(admin): site-content draft layer — entities home, trainer, practice; autosave, publish, discard routes`.

### Task 2: Site editor client — part hook, page shell, change labels, narrow section map

**Files:**
- Create:
  - `src/domain/site-changes.ts`
  - `src/components/admin/site/useSitePart.ts`
  - `src/components/admin/site/SiteEditorPage.tsx` + `.module.css`
- Modify:
  - `src/components/admin/SectionMap.tsx` + `.module.css`: a `width?: 170 | 190` prop, default 190.
  - `src/i18n/dict/admin.ts`.
- Test:
  - `tests/unit/site-changes.test.ts` (new);
  - `tests/unit/site-editor-page-dom.test.ts` (new);
  - `tests/unit/section-map-dom.test.ts`;
  - `tests/unit/old-safari.test.ts` (`BROWSER_FILES`: `domain/site-changes.ts`).

**Interfaces:**
- Produces:
  - `siteChangeLabels(entity: SiteEntity, parts: { part: string; live: unknown; draft: unknown }[]): string[]`. It gives S4-1 for C5 (S4-34), C2 (S4-17) and C1 (S4-12), in the cards' order, with `(RU)` per R-i.
  - `missingLabels(fields: string[]): string`. It gives S4-2's casing: lower case except KKK, MINI and MAXI.
  - `useSitePart({ entity, part, seed: SitePartState, label(field): string }): SitePartApi`, where `SitePartApi = { fields, set(name, v), update(name, fn), commit(name), flush(): Promise<boolean>, error(name), refusedValue(name), unpublished(name): boolean, conflict, restore(), status, discardCopy() }`.
    - It is `useAutosave` with `patchSender("/api/admin/sisu/<entity>/0/osa/<part>")`.
    - The copies owner is `site:<entity>`.
  - `<SiteEditorPage eyebrow title lead viewHref previewPath sections? parts={Record<string, SitePartState>} entity render={(apis: Record<string, SitePartApi>) => ReactNode} />`. It renders, in order:
    1. the header: eyebrow, H1, `LangSwitch`, one `SaveStatus` from `combineStatus`, and „Vaata lehel ↗“;
    2. the `PublishBar`, with `changed` from `siteChangeLabels` and `blocked` from the last publish answer;
    3. the section map at 170 px when `sections` has 4 or more entries;
    4. the cards.
- Consumes:
  - `useAutosave`, `patchSender`, `combineStatus` (`course/course-view.ts`), `PublishBar`, `SaveStatus`, `SectionMap`, `LangSwitch` and the leave guard, all as they are;
  - Task 1's routes.

**Exact behaviour:**
- **Publish.**
  1. Flush every part, with one bound (`SAVE_TIMEOUT_MS`, the `SavedCourse` `hold` pattern).
  2. POST `…/avalda`.
  3. Read the page again with the answer's `stamp`, restarting each part from a read at or past the press.
  4. A blocked answer shows `blocked` on the bar. The parts that were published leave the bar.
- **Discard.**
  1. Flush.
  2. POST `…/loobu`.
  3. Run `discardCopy()` on every part, then restart from live.
- **Sharing with the course editor.** Extract into a shared module whatever of `SavedCourse.tsx`'s flush, hold and stamp logic can move without changing its behaviour. `tests/unit/course-editor-dom.test.ts` must stay green unchanged. What cannot move cleanly is written in the shell, and the report says why.

- [ ] **Step 1: Failing tests.**
  - Unit `site-changes.test.ts`:
    - a price change gives `["MAXI hind"]`;
    - a 4th point gives `["MAXI punkt 4"]`;
    - a changed slide 2 title gives `["Slaid 2 pealkiri"]`, and only its Russian side gives `["Slaid 2 pealkiri (RU)"]`;
    - FAQ question 4 gives `["KKK küsimus 4"]`;
    - the trainer portrait and focal give `["Portree"]`;
    - `missingLabels(["Slaid 3 pilt","KKK vastus 2"])` gives `"slaid 3 pilt, KKK vastus 2"`.
  - DOM `site-editor-page-dom.test.ts`, with a two-part fixture and a fake fetch:
    - one chip for both parts;
    - „Avalda muudatused“ flushes a pending edit before the publish POST (order asserted);
    - a blocked answer renders `Puudub: …`;
    - „Loobu muudatustest“ → confirm → the POST, after which the fields show live;
    - a publish while a save hangs waits at most `SAVE_TIMEOUT_MS`, then shows the save's failure, not a publish.
  - DOM `section-map-dom.test.ts`: `width={170}` sets the modifier class.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests, `course-editor-dom`, `publish-bar-dom`, `section-map-dom`, `save-status-dom`, `leave-guard-dom` and `old-safari`. All pass.
- [ ] **Step 5: Commit** `feat(admin): site editor shell — part hook, one chip, PublishBar with row labels, 170 px section map`.

### Task 3: Public preview of site drafts

**Files:**
- Create: `src/server/site-preview.ts`.
- Modify:
  - `src/components/site/PreviewBar.tsx`: replace `courseId` with `discardHref: string | null`, and keep the course call site working.
  - `src/server/preview-bar.ts`: `sitePreviewBarProps(entity)`.
  - Pages: `src/app/[locale]/(site)/page.tsx` (home), `…/(site)/koolitaja/page.tsx`, `…/(site)/praktika/page.tsx`.
  - `src/db/queries/public.ts` (`getHomeData`, `getPracticePackages`, the trainer readers) where an overlay needs a hook.
- Test:
  - `tests/db/site-preview.test.ts` (new);
  - `tests/unit/preview-bar-dom.test.ts`;
  - `tests/e2e/admin-eelvaade.spec.ts` (a site case).

**Interfaces:**
- Produces:
  - `withSiteDrafts<T>(db: Db, entity: SiteEntity, live: T, pick: (parts: Record<string, unknown>) => T): Promise<T>`. It overlays each part's draft that passes its strict check (R-f) and leaves every other part live.
  - `sitePreviewBarProps(entity): PreviewBarProps`, with `discardHref = "/api/admin/sisu/<entity>/0/loobu"`.
- Consumes:
  - `previewActive()` (`src/server/preview.ts`);
  - `/api/admin/eelvaade?tee=<path>`, unchanged;
  - Task 1's parts and checks.

- [ ] **Step 1: Failing tests.**
  - db:
    - with a `practice` draft, the overlay returns the draft price;
    - a draft that fails the strict check (an empty price) returns live;
    - without draft mode the page reader returns live.
  - DOM: `PreviewBar` with `discardHref = null` renders no discard; with one, it posts to that URL.
  - e2e: an admin edits a package price, opens „Eelvaade ↗“ and sees the draft price on `/praktika` with the bar. A second, signed-out context sees the live price.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Read the draft-mode flag first, as `previewActive` does, so pages without it stay static.
- [ ] **Step 4: Run** the tests, `tests/e2e/admin-eelvaade.spec.ts` and `tests/e2e/home.spec.ts`. All pass.
- [ ] **Step 5: Commit** `feat(site): draft-mode preview of the home, trainer and practice pages`.

### Task 4: C5 Praktika on the draft layer (pilot)

**Files:**
- Modify:
  - `src/app/admin/(panel)/praktika/page.tsx`
  - `src/components/admin/PracticeEditor.tsx`
  - `src/components/admin/ListEditor.tsx` (`onEnterLast?: () => void`, R-h)
  - `src/server/actions/admin-site.ts` (remove `savePractice`)
  - `src/i18n/dict/admin.ts`
- Test:
  - `tests/unit/practice-editor-dom.test.ts` (new)
  - `tests/unit/list-editor-dom.test.ts`
  - `tests/e2e/admin-site.spec.ts` (practice)
  - `tests/unit/admin-guards.test.ts`

**Interfaces:**
- Consumes: `SiteEditorPage`, `useSitePart`, the `practice` entity, and `ListEditor`.

**Exact behaviour** (README C5, P4 frame, S4-31…S4-34):
- Eyebrow `Koolitused`, H1 „Praktikapaketid“, and the lead S4-32.
- Two cards side by side: MINI with border `#d9d2d5`, MAXI with border `#9e8993`.
- In each card:
  - „Nimi“ and „Lühitekst“;
  - a row of three short fields, „Hind (€)“, „Modelle“ and „Kestus“, each validated on its own;
  - the „Sisaldab“ points, with drag, ↑/↓ and undo „Rida eemaldatud.“, and Enter on the last row (R-h).
- The add button reads S4-33.
- One bar for both packages.
- Phone: the cards stack.

- [ ] **Step 1: Failing tests.**
  - DOM: Enter in the last point adds one and focuses it; removing a point offers „Rida eemaldatud.“ with undo; the bar shows `MAXI hind` after a price edit.
  - e2e (practice):
    - change the MAXI price, then wait for „Mustand salvestatud“;
    - `/praktika` still shows the old price;
    - „Avalda muudatused“ makes it show the new one;
    - at 375 px nothing scrolls sideways.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Remove `savePractice` and its pin.
- [ ] **Step 4: Run** the tests and `tests/e2e/admin-site.spec.ts` (practice). All pass.
- [ ] **Step 5: Test plan.** `haldus-praktika` is `redo`: the steps no longer name „Salvesta“, and they add „Avalda muudatused“. `avalik-praktika` is `reworded` if its steps name saving.
- [ ] **Step 6: Commit** `feat(admin): C5 Praktika — draft, one bar for both packages, points drag/undo, Enter adds a point`.

### Task 5: C2 Koolitaja on the draft layer

**Files:**
- Modify:
  - `src/app/admin/(panel)/koolitaja/page.tsx`
  - `src/components/admin/TrainerEditor.tsx`
  - `src/components/admin/GalleryEditor.tsx` + `.module.css` (`layout?: "list" | "grid"`, R-g)
  - `src/server/actions/admin-site.ts` (remove `saveTrainer`)
  - `src/i18n/dict/admin.ts`
- Test:
  - `tests/unit/trainer-editor-dom.test.ts` (new)
  - `tests/unit/gallery-editor-dom.test.ts`
  - `tests/e2e/admin-site.spec.ts` (trainer)
  - `tests/unit/admin-guards.test.ts`

**Exact behaviour** (README C2, P4 frame, S4-13…S4-17):
- Eyebrow `Koduleht`.
- The cards, in order:
  1. **„Portree ja tutvustus“.** A 240 px image column (300 px tall, radius 16) with the focal points, beside „Nimi“, „Amet“ and „Tutvustus“.
  2. **„Numbrid“.** Three fixed inline pairs (value + label). An empty pair is left off the public page.
  3. **„Galerii“.** The grid of R-g, with S4-15.
  4. **„Koolituskeskuse lugu“.** When empty, it folds to `tühi` + „Lisa tekst“ (S4-16).
  5. **„Koolitaja teekond“.** Folds the same way.
- The section map (5 entries) is at 170 px.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - the order of the cards;
    - an empty story folds, and „Lisa tekst“ opens it with focus in its title;
    - the grid shows `{n} / 24` and „+ Lisa“, and ✕ offers „Pilt eemaldatud.“ with undo;
    - the bar shows `Portree` after a focal change.
  - e2e (trainer):
    - reorder two gallery tiles by drag;
    - publish;
    - `/koolitaja` shows the new order;
    - at 375 px nothing scrolls sideways.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Remove `saveTrainer` and its pin. The course gallery's look is unchanged; assert this with the existing `gallery-editor-dom` cases.
- [ ] **Step 4: Run** the tests, `tests/unit/gallery-editor-dom.test.ts` and `tests/e2e/admin-site.spec.ts` (trainer). All pass.
- [ ] **Step 5: Test plan.** `haldus-koolitaja` is `redo` (draft, publish, gallery drag, fold). `avalik-koolitaja` gets a `reworded` check if needed.
- [ ] **Step 6: Commit** `feat(admin): C2 Koolitaja — portrait beside its text, three number pairs, gallery grid, empty stories fold`.

### Task 6: C1 Avaleht on the draft layer

**Files:**
- Modify:
  - `src/app/admin/(panel)/avaleht/page.tsx`
  - `src/components/admin/HomeEditor.tsx`
  - `src/components/admin/SlidesEditor.tsx`
  - `src/components/admin/FaqEditor.tsx`
  - `src/server/actions/admin-site.ts` (remove `saveHome`)
  - `src/i18n/dict/admin.ts`
- Test:
  - `tests/unit/home-editor-dom.test.ts` (new)
  - `tests/unit/edit-lang-dom.test.ts`
  - `tests/e2e/admin-site.spec.ts` (home)
  - `tests/e2e/feedback.spec.ts` (it used the Avaleht save bar)
  - `tests/unit/admin-guards.test.ts`

**Exact behaviour** (README C1, P3/P4 frames, S4-5…S4-12):
- Eyebrow `Koduleht`, and the lead S4-6.
- The cards follow the public page: Slaidid → MS LABi lause → Koolitaja kaart → KKK, then the link row „Koolitaja plokk“ with S4-8 (a link to `/admin/koolitaja`). The section map has 5 entries; the link entry's value is `→`.
- **Slide row.** A `24px | 72px | 1fr | 80px | 96px` grid:
  - drag handle;
  - 72 × 48 thumbnail;
  - the ET title over S4-9;
  - the tone tag „Hele“ / „Tume“;
  - ↑ ↓.
- **The open slide.** Only one is open at a time. It is a 1 px `#222` box: the 190 px image on the left with the focal dot and the hint of S4-10, and on the right the fields. Every existing field stays (§ Global Constraints), and the field names follow S4-10.
  - „Eemalda slaid“ offers „Slaid eemaldatud.“ with undo.
  - „+ Lisa slaid“ opens the new slide, up to 8 slides.
- **FAQ.**
  - The question shows and the answer is folded (▸).
  - Each row shows the S4-11 state.
  - Rows have drag, ↑/↓ and removal with undo, „Küsimus eemaldatud.“.
  - The RU pass (`LangSwitch`'s „Järgmine →“) opens a folded answer whose Russian is missing, as `CollapsedRu` does for slides.
- **Errors.** A row's error is placed by the row's id, not its index (TestCard `placeOf` pattern).
- **Phone:** `Jaotised · Slaidid ▾`; the bar's phone form comes from `PublishBar`.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - card order and the link row;
    - opening slide 2 closes slide 1;
    - after a reorder, an error on the moved slide stays on that slide;
    - FAQ removal and undo;
    - with RU on, „Järgmine →“ reaches a folded FAQ answer and opens it.
  - e2e (home):
    - add a slide without a picture;
    - the bar reads `Puudub: slaid {n} pilt` after „Avalda muudatused“;
    - add the picture, then publish;
    - the home page shows the slide;
    - at 375 px nothing scrolls sideways.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Remove `saveHome` and its pin. `feedback.spec.ts` stops using the save bar helper for Avaleht.
- [ ] **Step 4: Run** the tests, `tests/unit/edit-lang-dom.test.ts`, and `tests/e2e/admin-site.spec.ts` (home) and `feedback.spec.ts`. All pass.
- [ ] **Step 5: Test plan.**
  - `haldus-avaleht-slaid` and `haldus-avaleht-kkk` are `redo`.
  - `haldus-keel-lehel` is `reworded` if its Avaleht steps change.
  - `haldus-kommentaar-nupp` is `reworded`: its last step named the Avaleht save bar.
- [ ] **Step 6: Commit** `feat(admin): C1 Avaleht — draft, slides inline one at a time, FAQ fold with drag and undo, link row to Koolitaja`.

### Task 7: Docs, test-plan sweep and the full run

**Files:**
- Modify:
  - `docs/deploy.md`, a new section 25 covering:
    - no migration;
    - the three entities and the routes;
    - what changed for Maria;
    - the rollback note: before rolling back past 4a, publish or discard every site draft; `select entity, count(*) from content_drafts where entity in ('home','trainer','practice') group by 1` should return no row;
    - the footer-preview limit (R-f).
  - `docs/launch-checklist.md`.
  - The spec's §9 amendments, if any rule moved.
  - `src/data/testplan.json`.
- Test: the full suites.

- [ ] **Step 1: Sweep.** Search `tests/` and `testplan.json` for every removed or changed string of Tasks 1–6 („Salvesta“ on these screens, `saveBarButton` uses for Avaleht, Koolitaja and Praktika).
- [ ] **Step 2: Docs.** Write them, and check each claim against the code.
- [ ] **Step 3: Full run.** tsc, lint, all of vitest, the build, and the full Playwright run with its project dependencies (not `--no-deps`), with the ports checked first. A flake must pass when run alone. A test that fails twice is a finding.
- [ ] **Step 4: Commit** `docs(admin): piece 4a — deploy notes, launch checklist, test plan sweep`.
