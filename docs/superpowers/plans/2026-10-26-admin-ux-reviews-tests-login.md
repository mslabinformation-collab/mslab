# Admin UX pass, piece 4c: Tagasiside, Testimine, Sisselogimine, and two follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design's three remaining screens, with Dim's answer S4-Q5:
- **C6 Tagasiside:** decisions take effect at once with undo; review cards with stars from the feedback score; a „Lisa arvustus“ drawer; answers with search, linked to their review.
- **C7 Testimine:** one filter row, area progress, a two-segment answer, and SaveStatus.
- **C8 Sisselogimine:** the address remembered on this device; B19, a deep link after sign-in; B20, an honest rate-limit message.

Two follow-ups Dim approved come with it: a real-Postgres race test between an admin's capacity save and a public registration, and the newsletter's test send carrying the screen's version.

**Architecture:**
- **Reviews.** They get the spec §7 migration `0021`, `reviews.removed_at`, so Maria's own reviews are deleted softly. Undo restores within 8 s, and a purge clears them after 10 s plus a daily backstop, the lesson-file pattern.
- **Review decisions.** „Avalda“ and „Peida“ act at once. Their undo uses a guarded restore, the `RequestToggle` pattern.
- **Test page.** It keeps its data model (answers, `auto`, marks, notes, pings). Only the screen and the outbox's 401 handling change.
- **Sign-in.** It carries `?tagasi=` through the mailed link without a migration, and counts requests per typed address in the KV store, so the answer never tells an allowed address from an unknown one.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest + happy-dom, Playwright (with `tests/e2e/race.ts` for the race spec).

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`, built as designed. It covers:
- §8 item 4 for C6, C7, C8, B19 and B20;
- §7, the migration `removed_at` on reviews;
- §9's amendments for reviews, the sign-in and the test page;
- §10, what changes on „Testimine“.

Other sources:
- **Design:** `handoff/README.md` §4 C6, C7, C8 and §5 B19, B20; the Part 3 and Part 4 frames.
- **Approved texts:** `analysis/piece4-texts.md`, approved by Dim 26.10. That covers S4-Q5 = B (stars from the score: 9–10 = 5, 7–8 = 4, 5–6 = 3, 3–4 = 2, 0–2 = 1; none without a score), S4-35…S4-47, §3, §4 and §5.
- **Code map** (git-ignored): `.superpowers/sdd/piece4-research-c6-c8.md`, with every function, reader and test named, line numbers included.

## Global Constraints

Piece 4a's Global Constraints apply word for word (its plan, the section of that name, which includes piece 3a's), except its migration line, and with these additions:
- **Migration.**
  - This plan adds only `drizzle/0021_reviews_removed_at.sql`: `ALTER TABLE "reviews" ADD COLUMN "removed_at" timestamp with time zone;`.
  - Generate it with `npm run db:generate`, check it by hand, and add `tests/db/migration-0021.test.ts` on the model of `migration-0020.test.ts`.
  - Apply it to the local e2e DB. On Railway it is applied before the push (`docs/deploy.md`).
- **Every reader of `reviews` filters `removed_at is null`.** The list is research §A5:
  - `server/reviews.ts`: `reviewsOfClient`, `reviewCourseSlugs`, `adminReviews`, `reviewsOfFeedback`, `pendingReviewCount`, `courseReviews`, `homeReviews`, and `lockReview` (a removed row reads as `gone`);
  - `db/queries/admin.ts` `waitingReviews`;
  - `db/queries/overview.ts` `pendingReviews`.
- **A student's words are never edited.** „Muuda“ and „Kustuta“ appear only on reviews Maria added (builder notes §5, C6). A student's own withdrawal (`withdrawReview`) stays a hard delete.
- **The test page's data stays.** `skip` answers, `mark` data, `auto` answers and the ping rules are kept as stored. Only the „Jäta vahele“ button, the „Muudetud“ filter and the mark chips leave the screen (spec §10).

## Rulings carried (spec silent)

- **R-a. Undo of a decision.** `restoreReviewDecision(db, id, expected: {status, updatedAt}, now)` puts back the status and `decided_at` of the moment before the press. If the row moved since, the bar says S4-38's „Arvustust muudeti vahepeal. Vaata see üle.“. Every decision, undo, delete and restore revalidates `{kind: "reviews", course}`.
- **R-b. Soft delete.**
  - `removeManualReview` sets `removed_at`, and `restoreManualReview` clears it under the row's lock.
  - `purgeRemovedReviews(db, now, limit)` deletes rows removed at least 10 s ago. It runs in `after()` from the remove action and in the daily sweep. The sweep's log and response key appear only when something was purged.
- **R-c. „Muuda“** on a review Maria added is an autosave drawer:
  - route `POST /api/admin/arvustus/[id]`, through `autosaveHandler`;
  - the version is `"r:" + contentVersion({courseId, name, text, writtenAt, locale, note})`.

  „Lisa arvustus“ stays an explicit create, in a `Drawer` (S4-39). After the create the drawer closes with no result line, and focus returns to „Lisa arvustus +“.
- **R-d. Stable anchors.** Each review card has `id="arvustus-<id>"`. „Vaata arvustust →“ links to `/admin/tagasiside?vaade=arvustused#arvustus-<id>`. Focus stays on the acted row (D5).
- **R-e. Pills** have no „Kõik“: a pressed pill toggles off. The menu badge still lands on `?vaade=arvustused&olek=ootel`. The counts come from `reviewCounts(db)`.
- **R-f. Sign-in deep link (B19).**
  1. Middleware sets the request header `x-mslab-path` (pathname + search) on `/admin/*`.
  2. `requireAdmin()` redirects to `/admin/login?tagasi=<that>`.
  3. On submit, `LoginForm` sends `tagasi` and appends `location.hash`.
  4. `handleLoginRequest` validates it and appends `&tagasi=` to the mailed verify link.
  5. `verify` validates it again and redirects there.

  The validation is research §D's: same origin; `/admin` or `/admin/…` but not `/admin/login`; the `UNCLEAN` patterns of `lib/site-gate.ts`; rebuilt from pathname + search (+ hash); length ≤ 300. Anything else lands on `/admin` without a word (builder notes §5).
- **R-g. Per-address rate limit (B20).**
  - `reserveSlot(kv, hashedKey("login-addr", normalisedEmail), 3, 600)` runs for every typed address, allowed or not, so the answer is the same for both.
  - The 4th request in 10 minutes answers `429 {ok:false, error:"address"}`, which `LoginForm` shows as S4-47d. The IP limit keeps `429 {error:"rate"}` and ADM:57.
  - `issueLoginToken`'s cap stays as the backstop.
  - The key is a SHA-256 of the address, so no address sits in the KV table in plain text.
  - Tests that sign in many times reset the address slot through a test helper, as `unlockLogin` resets the IP limit today.
- **R-h. Remembered address.**
  - `localStorage["mslab-admin-email"]` is written only after a "sent" answer. It is read on load; blocked storage gives an empty field.
  - „Muu aadress“ empties the field and puts the cursor there. In the sent state it returns to the form.
- **R-i. Test page answers.**
  - „Läbitud“ is today's `ok` reworded (S4-45). The Telegram text and the "last answer" line say „Läbitud“.
  - „Kes“: „Mina“ = the signed-in tester's checks plus `koos`, and an admin who is not a tester sees every check; „Kõik“; „Automaattest“ stays as today.
  - The outbox gets the status `signedOut` on a 401. That means no tight retry, and the answers stay in localStorage.
- **R-j. Test send version.** `sendTestAction({id, to, locale, version})` compares it with `campaignVersion(row)` by a plain read. A mismatch answers `changed` and the page is read again, as `prepareSendAction` does.

## Review Focus

1. **Undo after the row moved.**
   - Setup: Maria hides a review, and in another tab publishes it again, before pressing „Võta tagasi“ in the first.
   - Expected: the undo is refused with S4-38's "changed meanwhile" line. Nothing is overwritten.
   - Pinned by a Task 1 db test.
2. **A removed review never shows.**
   - Expected: it is absent from the home page, the course page, the menu badge, the Avaleht queue and the student's account between its removal and the purge.
   - Pinned by Task 1 db tests.
3. **`?tagasi=` abuse.**
   - Inputs: `//evil`, `/\evil`, `%2F%2Fevil`, `/admin/login`, an over-long path, and a tab or newline inside the path.
   - Expected: every one lands on `/admin`. A good path through a real mailed link lands there, hash included.
   - Pinned by Task 5 unit tests and e2e.
4. **Address enumeration.**
   - Expected: four requests for an unknown address and four for an allowed one give the same answers in the same order (200, 200, 200, then 429 `address`).
   - Pinned by Task 5 db and e2e tests.
5. **The test page signed out.**
   - Expected: a press after the session ended shows „Salvestamata — logi uuesti sisse“. The press is kept on the device and sent after signing in again, with no request storm.
   - Pinned by Task 4 outbox tests.

---

### Task 1: Reviews — migration 0021, soft delete, guarded undo, counts and stars (server)

**Files:**
- Create:
  - `drizzle/0021_reviews_removed_at.sql` + `drizzle/meta/0021_snapshot.json` + the journal entry
  - `src/server/review-purge.ts`
  - `tests/db/migration-0021.test.ts`
- Modify:
  - `src/db/schema.ts` (`reviews.removedAt`)
  - `src/server/reviews.ts`: the readers; `removeManualReview`, `restoreManualReview`, `restoreReviewDecision` and `reviewCounts`; `adminReviews` selects `score` and `feedbackId`
  - `src/domain/review.ts`: `starsOf(score: number | null | undefined): 0 | 1 | 2 | 3 | 4 | 5`, which is client-safe
  - `src/db/queries/admin.ts` and `src/db/queries/overview.ts` (filters)
  - `src/server/actions/admin-reviews.ts`: `removeReviewAction`, `undoRemoveReviewAction` and `undoDecisionAction`; `decideReviewAction` returns the `expected` the undo needs; the purge runs in `after()`
  - `src/app/api/cron/sweep/route.ts` (backstop)
  - `src/components/admin/review-view.ts` (`score`, `feedbackId`)
- Test:
  - `tests/db/reviews.test.ts`
  - `tests/db/admin-reviews-actions.test.ts`
  - `tests/db/cron-sweep.test.ts`
  - `tests/db/admin-counts.test.ts`
  - `tests/db/overview-queue.test.ts`
  - `tests/db/public-reviews.test.ts`
  - `tests/unit/review-rules.test.ts` (`starsOf`)
  - `tests/unit/admin-guards.test.ts`

**Interfaces:**
- Produces:
  - the three new actions (`adminAction`);
  - `reviewCounts(db): Promise<{ pending; published; hidden }>`;
  - `starsOf`;
  - `ReviewRowView.score` and `ReviewRowView.feedbackId`.

- [ ] **Step 1: Failing tests.**
  - The migration test: exactly the new nullable column; rows untouched.
  - A removed manual review is absent from `homeReviews`, `courseReviews`, `adminReviews`, `pendingReviewCount`, `waitingReviews` and `pendingReviews`, and from the student's account reads.
  - `restoreManualReview` within 10 s brings it back. After `purgeRemovedReviews` (11 s) it is gone, and the restore answers `gone`.
  - `undoDecisionAction` after a hide restores `pending` with its old `decided_at`. After a second decision in another "tab" it answers the S4-38 "changed" code.
  - `starsOf`: 10 → 5, 9 → 5, 8 → 4, 7 → 4, 6 → 3, 5 → 3, 4 → 2, 3 → 2, 2 → 1, 0 → 1, `undefined` → 0.
  - `reviewCounts` equals the rows by status.
  - The sweep purges due rows and logs only when it purged.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Generate the migration with `npm run db:generate` and apply it to the local DB.
- [ ] **Step 4: Run** the tests, every `tests/db/*review*` file, and `tests/db/feedback*.test.ts`. All pass.
- [ ] **Step 5: Commit** `feat(reviews): 0021 removed_at — Maria's reviews deleted softly with undo, decisions undoable, counts and stars`.

### Task 2: C6 Arvustused — cards, instant decisions with undo, „Lisa arvustus“ drawer, „Muuda“ autosave

**Files:**
- Create: `src/app/api/admin/arvustus/[id]/route.ts` (R-c).
- Modify:
  - `src/app/admin/(panel)/tagasiside/page.tsx`: the reviews view, tabs, pills and the header button
  - `src/components/admin/ReviewsPanel.tsx` + `.module.css`
  - `src/components/admin/ManualReviewForm.tsx` (inside a `Drawer`, cancel „Katkesta“)
  - `src/i18n/dict/admin.ts`
- Test:
  - `tests/unit/reviews-panel-dom.test.ts`
  - `tests/db/reviews-admin-pages.test.ts`
  - `tests/e2e/reviews.spec.ts`
  - `tests/unit/colour-tokens.test.ts`
  - `tests/unit/admin-guards.test.ts`

**Exact behaviour** (README C6, P4 frame, S4-35…S4-39, builder notes §5 C6):
- **The header:**
  - eyebrow „Õpilased“ and H1 „Tagasiside“;
  - the ink button S4-35;
  - `TabPills` „Vastused | Arvustused“, with the phone's tab of S4-35;
  - the pills of S4-36, under R-e.
- **The review cards** form a 2-column grid (white, radius 22, padding 22). A waiting card has a 1 px `#222` border. Each card holds:
  - `starsOf(score)` stars (none at 0), the state pill, the quote, and S4-37's who-line;
  - its buttons, by state:
    - waiting: „Avalda“ (ink) and „Peida“;
    - published: „Peida“, plus the „Avalehel“ `Switch` (48 × 28);
    - a review Maria added: „Muuda“ and „Kustuta“.
- **Actions.**
  - „Avalda“ and „Peida“ act at once, with S4-38's bars and undo (R-a). „Avalehel“ shows no bar.
  - „Kustuta“ shows no panel: the soft delete happens at once, with the „Arvustus kustutatud.“ bar and undo (R-b).
  - „Muuda“ opens the autosave drawer (R-c, SaveStatus in its header). „Lisa arvustus +“ opens the create drawer of S4-39.
- **Focus** stays on the acted row (D5). The anchors follow R-d.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - stars from the score;
    - no stars for a review Maria added;
    - „Avalda“ calls the action and offers the undo;
    - „Kustuta“ hides the card and offers the undo;
    - „Muuda“ and „Kustuta“ are absent on a student's review;
    - a pressed pill toggles off;
    - the create drawer's „Katkesta“ closes it and refocuses „Lisa arvustus +“.
  - db (page HTML): the badge address `?vaade=arvustused&olek=ootel` shows only waiting cards.
  - e2e:
    - publish, then undo;
    - hide;
    - add a review, then delete and undo it;
    - edit a review Maria added, and its autosave chip shows „Salvestatud …“;
    - at 375 px nothing scrolls sideways.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** The old `deleteConfirm` keys go (piece4-texts §4).
- [ ] **Step 4: Run** the tests and `tests/e2e/reviews.spec.ts`. All pass.
- [ ] **Step 5: Test plan.**
  - `kontakt-arvustus-avalda`, `-peida`, `-avalehel` and `-lisa` are `redo`.
  - Add a `new` check for undo and the stars.
  - `haldus-menuu-margid` is `reworded` if its review step changes.
- [ ] **Step 6: Commit** `feat(admin): C6 Arvustused — cards with stars, instant publish and hide with undo, add and edit in drawers`.

### Task 3: C6 Vastused — search, course select, link to the review

**Files:**
- Modify:
  - `src/app/admin/(panel)/tagasiside/page.tsx` (the answers view)
  - `src/db/queries/protocols.ts`: `pageFeedback(db, {courseId, search, page, size})` searches name and e-mail with an escaped `containsPattern`
  - `src/i18n/dict/admin.ts`
- Test:
  - `tests/db/feedback-admin-pages.test.ts`
  - `tests/db/feedback-admin.test.ts`
  - `tests/e2e/feedback.spec.ts`

**Exact behaviour** (S4-40, S4-41, builder notes §5 C6):
- A `ListToolbar` with S4-40's search beside the course select. The empty lines are S4-40's.
- The answer drawer shows S4-41's „Vaata arvustust →“ when a review exists (R-d), beside the existing links.

- [ ] **Step 1: Failing tests.**
  - db:
    - the search finds by part of a name or an e-mail;
    - `%` and `_` match themselves;
    - the drawer HTML holds the review link only when a review exists.
  - e2e: search an answer, open it, follow „Vaata arvustust →“, and the card is in view.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `tests/e2e/feedback.spec.ts`. All pass.
- [ ] **Step 5: Test plan.** `kontakt-tagasiside-haldus` is `redo`.
- [ ] **Step 6: Commit** `feat(admin): C6 Vastused — search by name or e-mail, link from an answer to its review`.

### Task 4: C7 Testimine

**Files:**
- Modify:
  - `src/app/admin/(panel)/testimine/page.tsx`
  - `src/components/admin/TestPlan.tsx` + `.module.css`
  - `src/components/admin/testplan-outbox.ts` (`signedOut` on 401, R-i)
  - `src/server/testplan.ts` (the status word in pings)
  - `src/i18n/dict/admin.ts` (`testplan`; piece4-texts §4's removals)
- Test:
  - `tests/unit/testplan-dom.test.ts`
  - `tests/unit/testplan-outbox.test.ts`
  - `tests/db/testplan.test.ts`
  - `tests/e2e/testplan.spec.ts`

**Exact behaviour** (README C7, P4 frame, S4-42…S4-46, builder notes §5 C7):
- **The header:**
  - eyebrow „Haldus“ and the H1;
  - S4-43's line;
  - one `SaveStatus` in place of the outbox line (`saving`, `saved`, `retry`, `signedOut`, and `checking` while „Värskenda“ runs);
  - the „Värskenda“ pill.
- **Filters.** One row with the labelled groups of S4-44: „Olek“ (Kõik / Avatud n / Viga n / Läbitud n) and „Kes“ (Mina / Kõik / Automaattest), under R-i.
- **Area cards** have the progress „{done} / {total}“ with a bar, and ▾. They collapse together with their notes.
- **A check row** (min-height 56, `1fr | 110px | 240px`) holds:
  - the title;
  - S4-45's „Sammud ▸“, which folds the steps, „Miks“ and „Mida näed“;
  - the segmented „Läbitud“ (`#2f5d46` when set) | „Viga“ (`#8a3b3b`);
  - the note box under every answer, as Dim set on 22.10.
- **Chips.** The who, device and „Loob andmeid“ chips stay, and so does „Ava ↗“. The mark chips and „Sina: {name}“ go.
- **Empty filter:** S4-46.

- [ ] **Step 1: Failing tests.**
  - DOM:
    - the line of S4-43, with 1 → „1 kontroll“;
    - the Olek pills' counts under „Mina“;
    - no „Jäta vahele“ button;
    - an area collapses with its note;
    - „Sammud ▸“ folds;
    - „Viga“ opens the note and focuses it.
  - Outbox: a 401 sets `signedOut` with no retry timer, and the answer stays stored.
  - db: the ping text says „Läbitud“ for an `ok` with a note.
  - e2e: answer, reload, filter, empty filter text; layouts at 390, 834, 1194 and 1440 px.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `tests/unit/testplan-rules.test.ts`, `tests/unit/testplan-file.test.ts` and `tests/e2e/testplan.spec.ts`. All pass.
- [ ] **Step 5: Test plan.**
  - `testimine-automaattest` is `reworded`.
  - Add a `new` check, in area `haldus`, for the filters, the area progress and the signed-out state.
- [ ] **Step 6: Commit** `feat(admin): C7 Testimine — one filter row, area progress, Läbitud | Viga, SaveStatus with the signed-out state`.

### Task 5: C8 Sisselogimine — remembered address, deep link (B19), honest limit (B20)

**Files:**
- Modify:
  - `src/middleware.ts` (the `x-mslab-path` header on `/admin/*`)
  - `src/server/auth.ts` (`requireAdmin` with `?tagasi=`)
  - `src/server/login.ts`: `bodySchema` gains `tagasi`; R-g's address slot; `verifyUrl` gains `tagasi`
  - `src/app/api/auth/verify/route.ts` (R-f)
  - `src/lib/admin-return.ts` (new, pure): `adminReturnPath(raw: string | null, origin: string): string | null`
  - `src/app/admin/login/page.tsx`, `LoginForm.tsx` and `login.module.css` (S4-47a–d, R-h; inputs with radius 10 and border `#d9d2d5`; card 640 / 390 as the frames)
  - `src/i18n/dict/admin.ts` (`login`)
  - `src/components/admin/SaveStatus.tsx`: in `signedOut`, the words „logi uuesti sisse“ link to `/admin/login?tagasi=<current path+hash>`, with no new text
  - `tests/e2e/admin-login.ts` (the address-slot reset helper)
- Test:
  - `tests/unit/admin-return.test.ts` (new)
  - `tests/db/login.test.ts`
  - `tests/db/auth.test.ts`
  - `tests/unit/i18n.test.ts` (the pinned `login.sent`)
  - `tests/e2e/admin-auth.spec.ts`
  - `tests/unit/middleware*.test.ts`
  - `tests/unit/save-status-dom.test.ts`
  - `tests/unit/admin-login-form-dom.test.ts` (new)

**Exact behaviour** (README C8, P3 frames, S4-47a–d, builder notes §5 C8): R-f, R-g and R-h.

- [ ] **Step 1: Failing tests.**
  - unit `adminReturnPath`:
    - `/admin/kalender?id=3` and `/admin/testimine#x` are kept;
    - `//evil`, `/\evil`, `%2F%2Fevil`, `/admin/login`, `/adminx`, `https://other/admin`, a path with a tab or newline, and 301 characters all give `null`.
  - db login:
    - an unknown address and an allowed address give 200, 200, 200, then 429 `address`;
    - the IP limit still gives 429 `rate`;
    - the mailed link carries `&tagasi=`;
    - verify with a good `tagasi` redirects there, and with a bad one to `/admin`.
  - DOM `LoginForm`:
    - the remembered address is prefilled;
    - „Muu aadress“ clears it and focuses the field;
    - the sent state shows S4-47c with the address;
    - a 429 `address` shows S4-47d.
  - e2e:
    - open `/admin/kalender?id=…` signed out, which lands on `/admin/login?tagasi=…`;
    - sign in through the dev link, which lands on the deep link;
    - the stranger test of `admin-auth.spec.ts:343` now expects the 4th answer to be 429 `address`, and so does an allowed address.
- [ ] **Step 2: Run** them. They FAIL.
- [ ] **Step 3: Implement.** Update `login.test.ts` :133 and :157 to R-g's rule, with a comment naming B20.
- [ ] **Step 4: Run** the tests, `tests/e2e/admin-auth.spec.ts`, `tests/e2e/gate.spec.ts` and `tests/e2e/headers.spec.ts`. All pass.
- [ ] **Step 5: Test plan.**
  - `kirjad-halduse-link` is `reworded`: the sent texts changed. It keeps the private-window step from piece 3b.
  - Add a `new` check, in area `haldus`, covering the remembered address and „Muu aadress“, the deep link after sign-in, and the 4th request's message.
- [ ] **Step 6: Commit** `feat(admin): C8 Sisselogimine — remembered address, deep link after sign-in, honest limit message`.

### Task 6: Follow-ups — capacity race on real Postgres, test send with the screen's version

**Files:**
- Create: `tests/e2e/session-capacity-race.spec.ts`, modelled on `invoices-race.spec.ts` and `reviews-race.spec.ts`: it uses `inFlight` with the `course_sessions … for update` hold, does its cleanup by noted ids in `afterEach`, and runs `test.skip(isMobile)`.
- Modify:
  - `src/server/actions/admin-newsletter.ts` (`testInput` gains `version`, R-j)
  - `src/server/newsletter-campaigns.ts` (`sendTest(deps, id, to, locale, shown?)` gains the `changed` answer)
  - `src/components/admin/NewsletterCampaignEditor.tsx` (passes `versionNow()`; the `changed` refresh)
  - `src/i18n/dict/admin.ts` only if a `changed` text for the test send is missing; it reuses the existing `changed` sentence
- Test:
  - `tests/db/admin-newsletter-actions.test.ts`
  - `tests/db/newsletter-send.test.ts`
  - the new e2e spec

- [ ] **Step 1: Failing tests.**
  - e2e race, both orders:
    - **save first:** capacity set to the seats taken, then a registration, which answers `{session:"full"}`;
    - **registration first:** the registration succeeds, then the save of a lower capacity is refused (`capacityBelow`) only if it would go under the confirmed count.

    End state: capacity ≥ confirmed, and seats taken ≤ capacity.
  - db: `sendTestAction` with a stale `version` answers `changed` and sends nothing; with the current one it sends.
- [ ] **Step 2: Run** them. They FAIL: the db case does, and the race spec fails or is missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `tests/e2e/newsletter-campaigns.spec.ts` and the race spec twice. All pass.
- [ ] **Step 5: Commit** `test(sessions): admin capacity save against a registration on real Postgres; fix(newsletter): the test send carries the screen's version`.

### Task 7: Docs, test-plan sweep and the full run

**Files:**
- Modify:
  - `docs/deploy.md`, a new section 27. It covers:
    - the 0021 item in section 6, migrated before the push;
    - the rollback note: older code does not read `removed_at`, so before a code rollback run `delete from reviews where removed_at is not null` (they are rows Maria deleted);
    - the per-address limit and its KV keys;
    - B19;
    - what changed for Maria on the three screens.
  - `docs/launch-checklist.md`.
  - The spec §9 amendments: the reviews spec (undo, soft delete), the test-page spec (filters, „Läbitud“, no „Jäta vahele“ button) and the sign-in spec (B19, B20).
  - `src/data/testplan.json`.
- Test: the full suites.

- [ ] **Step 1: Sweep.** Search `tests/` and `testplan.json` for every removed or changed string of Tasks 1–6.
- [ ] **Step 2: Docs.** Write them, and check each claim against the code.
- [ ] **Step 3: Full run.** tsc, lint, all of vitest, the build, and the full Playwright run with its project dependencies, with the ports checked first. A flake must pass when run alone. A test that fails twice is a finding.
- [ ] **Step 4: Commit** `docs(admin): piece 4c — deploy notes with 0021, launch checklist, spec amendments, test plan sweep`.
