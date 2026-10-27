# Admin UX pass, piece 4b: Uudised and Hüpikaken on the draft layer, the old save bar removed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design's C3 Uudised and C4 Hüpikaken on piece 4a's site draft layer, with Dim's answers S4-Q1…Q4, then delete the old SaveBar save path that only these two screens still used.

**Architecture:**
- **Uudised.** A post is its own draft entity: `post`, with the post's id. A post that was never published saves straight to its row. A published post saves into drafts and goes live with „Avalda muudatused“. Its „Avaldatud“ switch is the first publish (README:292).
- **Hüpikaken.** The popup is the entity `popup` (id `0`). Its offer fields are drafted, and its „Lehel näidatakse“ switch acts on the live row at once, with an UndoBar.
- **Discount.** It moves from Seaded into the popup's drafted fields (S4-Q2 A). Seaded keeps only „Tervituskood“.
- **Reuse.** Both screens use 4a's `SiteEditorPage`, `useSitePart`, `siteChangeLabels`, the generic routes and `withSiteDrafts`.

This plan is built after piece 4a (`docs/superpowers/plans/2026-10-26-admin-ux-site-content.md`) merges, on its branch or on main after it.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright, Resend.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`, built as designed: §8 item 4 for C3 and C4, D3 (Hüpikaken), §10 (popup timing).

Other sources:
- **Design:** `handoff/README.md` §4 C3, C4 and the template line; Part 4 frames.
- **Approved texts:** `analysis/piece4-texts.md`. Dim approved them on 26.10:
  - S4-Q1 = A: cover, plus title and text in ET and RU, at publish;
  - S4-Q2 = A: one discount value, on Hüpikaken;
  - S4-Q3 = A: the welcome mail says how long the code is valid;
  - S4-Q4 = A: the popup's button follows the code;
  - S4-18…S4-30, with S4-29 reworded;
  - §4 dead keys and §5 builder notes.
- **Code map** (git-ignored): `.superpowers/sdd/piece4-research-c1-c5.md`, sections B "C3", B "C4" and D 1, 5, 9.

## Global Constraints

Piece 4a's Global Constraints apply word for word (its plan, the section of that name, which includes piece 3a's), except its line "The old save path stays for piece 4b" — this plan removes that path. These are added:
- **Migration.** None. The discount's stored shape changes inside `settings.newsletter` (R-c), which needs no SQL. If a task finds a migration is needed, it stops and reports.
- **Instant controls.** Only these two:
  - the popup switch „Lehel näidatakse“;
  - a post's „Avaldatud“ when the post has never been published.

  Everything else waits for „Avalda muudatused“ (builder notes §5).
- **Fields the mocks leave out stay.**
  - C3: slug, category, excerpt, date, cover, „Avaldatud“.
  - C4: „Silt“ and „Pilt“; the preview then shows the picture.
- **The word „kampaania“** is left on no admin screen. The route `/admin/kampaania` stays.

## Rulings carried (spec silent)

- **R-a. Post entity.** `content_drafts.entity = "post"`, `entity_id` = the post's id, and one part `post` = `{ title: I18n, slug, category, excerpt: I18n, body: I18n, coverKey, coverPos?, publishedAt }`.
  - `published` is not in the part. Its version hash leaves `published` out (4a R-b).
  - A post with `published = false` and no `published_at` saves straight to its row: there is no draft and no bar, as an unpublished course in 3a.
  - A published post saves into drafts.
- **R-b. The post's „Avaldatud“.**
  - **On, for a never-published post:** the post's publish. It runs the strict check of S4-Q1 A: cover, plus title and text in ET and RU, plus today's category and slug rules. A missing field refuses the switch with S4-22's `Puudub: …` under it.
  - **Off, on a published post:** it hides the post. If drafts are pending, they are published in the same transaction first, and a blocked part refuses the switch (3a's `switchCoursePublished` rule).
- **R-c. Discount and code days.**
  - They live in `settings.newsletter` as `discountPercent: number` (whole, 1–99) and `codeDays: number | null` (whole, 1–365), beside `welcomeCode`.
  - The popup entity's part `offer` covers `{kicker, title, text, imageKey, imagePos?, discountPercent, codeDays}`. The campaign row id 2 holds the text fields, and `settings.newsletter` the two numbers.
  - The part's version hashes only those fields, so Seaded's `welcomeCode` never blocks it (4a R-b).
  - Old data: a stored `discountLabel` like „10%“ is read as `discountPercent = 10` until the first publish writes the number. The footer shows `{discountPercent}%`.
- **R-d. The old campaign-offer row** (`campaign` id 1, kind `campaign`).
  - The admin no longer edits it, and the public site no longer shows it: the popup reader takes the newsletter row only.
  - Switching the newsletter popup on still switches row 1 off in the same transaction (`upsertCampaign` already does), so the `campaign_one_active` index holds.
  - `docs/deploy.md` names the read-only check of row 1 on Railway.
- **R-e. Popup timing** (builder notes §5).
  - It shows on the home page only, 8 s after the page appears.
  - It shows once in 30 days per browser, with a localStorage stamp under a new key, so the old sessionStorage key no longer applies.
  - It never shows again in a browser that signed up (`NEWSLETTER_SIGNED_KEY`).
  - In draft mode with an admin session the timing and the stamp are skipped, so the preview shows the popup at once.
- **R-f. Uudised layout.**
  - From 1180 px the list (320 px) stays at the left while a post is open. The list is server-rendered by the `uudised` layout from all posts, with the drafts lookup for the status.
  - The title search filters on the client from `?otsi=` (layouts get no `searchParams`).
  - Below 1180 px it is two screens, with S4-21's back link.
- **R-g. Slugs.**
  - „Lisa postitus +“ creates `Uus postitus` with S4-19's slug.
  - The slug follows the title until the post is first published, unless Maria typed one.
  - A typed slug stops following.
  - A slug that is taken is refused at publish with ADM:2281's existing text.
- **R-h. Deleting a post** deletes its drafts in the same transaction.
- **R-i. Carry from piece 4a.** The shared autosave engine (`components/admin/autosave/engine.ts`) must not send a queued save after its screen unmounts. A save already in flight may finish; a queued one is dropped and its copy stays in localStorage for the next mount. Fixed in Task 2 with engine tests, since Uudised mounts and unmounts editors as Maria moves between posts.

## Review Focus

1. **A published post edited in two tabs.** Expected: a conflict, with the second tab's text kept. „Avaldatud“ off while drafts are pending publishes them first or refuses — never loses them. (Task 1 db tests.)
2. **„Lisa postitus +“ pressed twice quickly, or by two tabs.** Expected: two posts with unique slugs (`uus-postitus`, `uus-postitus-2`). The unique index never throws to the screen. (Task 1 db test.)
3. **The popup switched on while its draft lacks a picture.**
   - Expected: the switch acts on the live row, so it is refused only if the live row lacks a required field (S4-26 `Puudub: …`).
   - A pending draft does not block it.
   - (Task 3 db tests.)
4. **The discount changed but not published.** Expected: the footer and the welcome mail keep the published value; the preview shows the draft. (Task 3 db tests.)
5. **The popup on a phone, and its timing.** Expected: it opens 8 s after the home page appears and not again for 30 days. It never opens on other pages, and never opens after a sign-up. (Task 4 e2e `campaign.spec.ts`.)

---

### Task 1: The post entity — server

**Files:**
- Modify:
  - `src/domain/site-entities.ts` (add `post`, with entity ids from the posts table)
  - `src/server/site-drafts.ts` (per-entity id; R-a "no draft for an unpublished post")
  - `src/server/admin-site.ts` (`postParts` with a loose and a strict check; R-g slug)
  - `src/db/queries/admin-site.ts` (`insertPost` with the slug numbering; delete with drafts, R-h)
  - `src/db/queries/admin.ts` (`listAllPosts` with a `changes` flag from `content_drafts`, as `listAllCourses`)
- Create:
  - `src/app/api/admin/uudised/uus/route.ts` (POST → `{id}`)
  - `src/app/api/admin/uudised/[id]/avaldatud/route.ts` (POST `{on}` → R-b)
  - `src/app/api/admin/uudised/[id]/kustuta/route.ts` (POST → R-h)
- Test:
  - `tests/db/post-drafts.test.ts` (new)
  - `tests/db/admin-site.test.ts` (posts)
  - `tests/unit/admin-guards.test.ts`

**Interfaces:**
- Produces:
  - `createPost(db, now): Promise<{ id: number; slug: string }>`
  - `switchPostPublished(db, id, on, now): Promise<{ ok: true; stamp } | { ok: false; missing: string[] } | { ok: false; blocked: BlockedPart[] }>`
  - `deletePost(db, id): Promise<boolean>`
  - The generic routes of 4a, now taking `post/<id>` (autosave, `avalda`, `loobu`).
- Consumes: 4a's `readSiteEditor`, `writeSitePart`, `publishSite` and `discardSite`, now with a non-zero id for `post`.

- [ ] **Step 1: Failing db tests.**
  - `createPost` twice gives slugs `uus-postitus` and `uus-postitus-2`, both unpublished, with title `Uus postitus`.
  - An unpublished post's save writes the row, with no draft.
  - A published post's save writes a draft, and `getPost` (public) still returns the live text.
  - **Switch on.** `switchPostPublished(on)` on a post with no cover answers `missing: ["kaanepilt"]`. With cover and ET title and text but no Russian it answers `missing: ["pealkiri (RU)", "tekst (RU)"]`, in S4-22's order. Complete, it publishes.
  - **Switch off with drafts.** It publishes the drafts first. A draft blocked as `changed` refuses the switch.
  - **Slug.** A taken slug at publish answers ADM:2281's code.
  - `deletePost` removes the post's drafts.
  - `listAllPosts` gives `changes: true` for a post with a draft.
- [ ] **Step 2: Run** `npx vitest run tests/db/post-drafts.test.ts`. They FAIL.
- [ ] **Step 3: Implement.** The old `savePost` and `deletePost` actions stay until Task 5.
- [ ] **Step 4: Run** the tests, `tests/db/admin-site.test.ts`, `tests/db/site-drafts.test.ts` and `tests/unit/admin-guards.test.ts`. All pass.
- [ ] **Step 5: Commit** `feat(admin): posts on the draft layer — create at once with a unique slug, publish checks in both languages, switch and delete with drafts`.

### Task 2: C3 Uudised — the list and the editor, and the public preview

**Files:**
- Create:
  - `src/app/admin/(panel)/uudised/layout.tsx` (R-f)
  - `src/components/admin/news/NewsList.tsx` + `.module.css`
- Modify:
  - `src/app/admin/(panel)/uudised/page.tsx`
  - `src/app/admin/(panel)/uudised/[id]/page.tsx`
  - `src/components/admin/PostEditor.tsx`
  - `src/i18n/dict/admin.ts`
  - the public `src/app/[locale]/(site)/uudised/page.tsx`, `…/uudised/[slug]/page.tsx` and the home carousel's reader (`getHomeData.posts`), through `withSiteDrafts` (4a R-f)
- Test:
  - `tests/unit/news-list-dom.test.ts` (new)
  - `tests/unit/post-editor-dom.test.ts` (new)
  - `tests/e2e/admin-site.spec.ts` (news)
  - `tests/db/site-preview.test.ts` (posts)

**Exact behaviour** (README C3, P4 frame, S4-18…S4-24):
- **The list.** A ListToolbar with S4-18's search, and „Lisa postitus +“.
  - Rows have a thumbnail, the title, and `{staatus} · {dd.mm}`. The status is one of „Avaldatud“ (`#2f5d46`), „Mustand“ (`#5e5559`) or „Avaldamata muudatused“ (`#6b4f5c`).
  - The whole row is a link. The open row has a 1 px `#222` border.
  - When the search finds nothing, the list shows S4-18's empty line.
- **The editor.** It uses `SiteEditorPage` for a published post (bar, labels S4-24) and the same header without a bar for an unpublished one.
  - The fields: „Pealkiri“; „Tekst“ (the accent-bordered 150 px textarea); slug; category; excerpt; date; cover.
  - The side card holds „Avaldatud“ (R-b), with `Puudub: …` under it when refused.
  - The footer line follows S4-20. „Kustuta postitus“ opens the ConfirmPanel of S4-23, and the list then says „Postitus kustutatud.“.
- **After „Lisa postitus +“** the editor opens with the cursor in „Pealkiri“ and ADM:2273's line.

- [ ] **Step 1: Failing tests.**
  - Engine (R-i, `tests/unit/autosave-engine.test.ts`): a save queued behind one in flight is not sent after `stop()`/unmount, and its copy stays stored.
  - DOM:
    - the search filters the rows;
    - the empty line;
    - the status words and colours;
    - the editor shows a bar only for a published post;
    - a refused „Avaldatud“ shows `Puudub: kaanepilt`.
  - e2e (news):
    - „Lisa postitus +“, then type a title, add a cover, ET and RU text;
    - switch „Avaldatud“ on, and `/uudised` lists it;
    - edit the published text; `/uudised/<slug>` still shows the old text until „Avalda muudatused“;
    - from 1180 px the list stays beside the editor;
    - at 375 px it is two screens with „← Uudised“.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `tests/e2e/admin-site.spec.ts` (news). All pass.
- [ ] **Step 5: Test plan.**
  - `haldus-uudised-postitus` is `redo`.
  - `avalik-uudised` is `reworded` if its steps name saving.
  - Add a `new` check for the post's draft: edit a published post, check the public page shows the old text, preview it, then publish.
- [ ] **Step 6: Commit** `feat(admin): C3 Uudised — list beside the post from 1180 px, search, create at once, drafts for a published post`.

### Task 3: The popup entity and the discount — server, Seaded and the welcome mail

**Files:**
- Modify:
  - `src/domain/site-entities.ts` (`popup`)
  - `src/server/admin-site.ts` (`popupParts`: part `offer`, R-c; the instant switch)
  - `src/db/queries/admin.ts` / `admin-site.ts` (newsletter row only, R-d)
  - `src/server/newsletter.ts` (`sendWelcome`: the line `Kood kehtib {n} päeva.` / `Kood kehtib 1 päev.` and the Russian forms of S4-Q3, only when a code and `codeDays` are set)
  - `src/i18n/dict/et.ts` and `ru.ts` (that line)
  - `src/components/admin/SettingsEditor.tsx` (Seaded → „Uudiskiri“ loses „Tervitussoodustus“ and its hint; the ADM:2357 hint drops „pärast e-posti kinnitamist“ per the S4-29 ruling)
  - `src/server/admin-site.ts` `writeSettingsPart` (the `newsletter` part keeps only `welcomeCode`)
  - `src/components/site/settings.ts` + `Footer.tsx` (`{discountPercent}%`, with R-c's old-data read)
- Create: `src/app/api/admin/hupikaken/naita/route.ts` (POST `{on, version}` → the switch, S4-26 answers).
- Test:
  - `tests/db/popup-drafts.test.ts` (new)
  - `tests/db/newsletter-welcome.test.ts`
  - `tests/db/seaded-route.test.ts`
  - `tests/unit/settings-editor-dom.test.ts`
  - `tests/unit/admin-guards.test.ts`

**Interfaces:**
- Produces:
  - `switchPopup(db, on, version, now): Promise<{ ok: true; version } | { ok: false; missing: string[] } | { ok: false; error: "changed" }>`
  - The `popup/0` entity on 4a's generic routes, with the part `offer`.
  - `welcomeMail(…, codeDays)`.

- [ ] **Step 1: Failing tests.**
  - db:
    - An `offer` draft with `discountPercent: 15` leaves the footer reader at the published value. Publishing writes `settings.newsletter.discountPercent = 15` and keeps `welcomeCode`.
    - Seaded's `welcomeCode` save does not move the `offer` version.
    - `switchPopup(true)` with a live row lacking its picture answers `missing: ["pilt"]`. With a pending draft lacking the picture but a complete live row, it switches on.
    - A switch with a stale version answers `changed`.
    - The welcome mail has `Kood kehtib 30 päeva.` when a code and `codeDays = 30` are set, and has no such line without `codeDays`. Russian gives `30 дней`, `1 день` and `2 дня`.
  - DOM: Seaded's „Uudiskiri“ card shows „Tervituskood“ only.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** The old `saveCampaign` stays until Task 5.
- [ ] **Step 4: Run** the tests and `tests/db/admin-site.test.ts` (campaign). All pass.
- [ ] **Step 5: Test plan.**
  - `kirjad-tervituskiri` is `redo` (the days line).
  - Seaded's newsletter check is `reworded` (no discount field).
- [ ] **Step 6: Commit** `feat(admin): the popup on the draft layer — discount and code days move to Hüpikaken, the welcome mail says how long the code is valid`.

### Task 4: C4 Hüpikaken — the screen and the public popup

**Files:**
- Modify:
  - `src/app/admin/(panel)/kampaania/page.tsx`
  - `src/components/admin/CampaignEditor.tsx` (rebuilt on `SiteEditorPage`; `Choice` and `PreviewLangSwitch` leave it)
  - `src/components/site/PopupDialog.tsx` and `src/domain/campaign.ts` (R-e)
  - `src/components/site/NewsletterPopup.tsx` / `NewsletterPopupCard.tsx` (the button follows the code: ET `Saa kood`, RU `Получить код` with a code, else `Liitu` / `Подписаться`; S4-Q4)
  - `src/app/[locale]/(site)/page.tsx` (the popup reader through `withSiteDrafts` in draft mode)
  - `src/i18n/dict/admin.ts`, `et.ts` and `ru.ts`
- Test:
  - `tests/unit/campaign-editor-page-dom.test.ts` (new; name it so it is not confused with the letter editor's test)
  - `tests/unit/newsletter-popup-dom.test.ts`
  - `tests/unit/campaign.test.ts`
  - `tests/e2e/admin-site.spec.ts` (campaign, newsletter popup)
  - `tests/e2e/campaign.spec.ts`

**Exact behaviour** (README C4, P4 frame, S4-25…S4-30):
- Eyebrow „Turundus“ and H1 „Hüpikaken“.
- **The top card.** „Lehel näidatakse“ with the S4-25 line and a two-state `Switch`.
  - It acts at once. Off shows the UndoBar „Hüpikaken peidetud.“; on shows no bar.
  - Refusals follow S4-26.
- **Below.** `minmax(0,1fr) 440px`:
  - **left, the card „Pakkumine“:** „Silt“, „Pealkiri“, „Tekst“ and „Pilt“, then „Soodustus (%)“ and „Kood kehtib (päeva)“ inline, and S4-28 under the two numbers;
  - **right, the live preview:** it follows the page's `LangSwitch`, with S4-29 under it.
- **The bar** carries S4-30's labels. The switch never appears on it.
- **Phone:** the preview goes under the card.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - the switch offers the undo and calls the switch route;
    - the preview changes language with `LangSwitch`;
    - the bar shows `Soodustus` after a discount edit.
  - unit `campaign.test.ts`:
    - the delay is 8000 ms;
    - "seen within 30 days" is read from a localStorage stamp;
    - a signed-up browser never sees it.
  - e2e: switch off → undo → on; publish a new title, after which the home page popup shows it after 8 s; the popup does not open on `/koolitused`; at 375 px nothing scrolls sideways.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Remove the old campaign-offer editor and its preview (R-d).
- [ ] **Step 4: Run** the tests, `tests/e2e/campaign.spec.ts`, and `tests/e2e/admin-site.spec.ts` (campaign, newsletter popup). All pass.
- [ ] **Step 5: Test plan.**
  - `haldus-hupikaken` is `redo`.
  - `avalik-hupikaken` is `redo` (8 s, once in 30 days, home only).
  - `avalik-uudiskiri` is `reworded` (the button follows the code).
  - `avalik-jalus` is `reworded` if it names the discount text.
- [ ] **Step 6: Commit** `feat(admin): C4 Hüpikaken — one popup, an instant switch with undo, the offer drafted, the preview follows the language switch`.

### Task 5: Remove the old save path, docs, test-plan sweep and the full run

**Files:**
- Delete:
  - `src/components/admin/SaveBar.tsx`, `useSiteDraft.ts` and `site-draft.ts`. Move `type Loaded` to where `SettingsEditor.tsx` can still import it, or drop the import if 3b no longer needs it.
  - The actions `saveCampaign`, `savePost` and `deletePost`, with their `admin-guards` pins.
  - The e2e helpers `saveBarButton` and `saveBarStatus` (`tests/e2e/admin-login.ts`) and their remaining uses.
  - piece4-texts §4's dead keys in `src/i18n/dict/admin.ts`.
- Modify:
  - `tests/unit/admin-fab-avoid.test.ts` and `tests/unit/foot-bar-dom.test.ts` (they import `SaveBar`).
  - `tests/unit/old-safari.test.ts` (`BROWSER_FILES`).
  - `docs/deploy.md`, a new section 26:
    - no migration; the discount's new shape (R-c) and its old-data read;
    - the read-only check of the campaign row 1 (R-d): `select id, kind, active from campaign`;
    - what changed for Maria; the public popup timing;
    - the rollback note:
      - before rolling back past 4b, publish or discard every post and popup draft: `select entity, count(*) from content_drafts where entity in ('post','popup') group by 1` should return no row;
      - the older code reads `discountLabel`, so publish once after the rollback.
  - `docs/launch-checklist.md`.
  - Spec amendments: the newsletter-simple spec (discount moved; code days); the reviews of §9 are not here.
  - `src/data/testplan.json`.
- Test: the full suites.

- [ ] **Step 1: Delete and sweep.** Search `src/`, `tests/` and `testplan.json` for every removed name and string: `SaveBar`, `useSiteDraft`, `data-save-bar`, „Salvesta“ on these screens, „Tervitussoodustus“ and „kampaania“ on admin screens.
- [ ] **Step 2: Docs.** Write them, and check each claim against the code.
- [ ] **Step 3: Full run.** tsc, lint, all of vitest, the build, and the full Playwright run with its project dependencies, with the ports checked first. A flake must pass when run alone. A test that fails twice is a finding.
- [ ] **Step 4: Commit** `refactor(admin): piece 4b — the old save bar goes; docs, launch checklist, test plan sweep`.
