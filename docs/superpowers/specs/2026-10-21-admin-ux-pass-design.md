# Admin UX pass — design

The step after phase 4's six pieces, before the public launch. Dim's direction for the admin: "very simple and usable … as simple as it gets", "fewest clicks, autosave". The design was made in a design tool from the package of 20.10 (`.superpowers/ux-pass-package.zip`). Dim answered its questions Q1–Q5 and accepted all its behaviour changes B1–B22 there.

This document adopts that hand-off as the design. It adds what the hand-off could not know: how it meets the code and the decisions recorded in the earlier specs. Every ruling not attributed to Dim is my call and says so. Dim chose to skip questions for phase 4.

## 1. Why

Today the admin has eight different ways to save. Closing a drawer or clicking the menu can drop typed text without a word. The daily work is spread over a flat menu of 16, and several pages have no menu entry. Maria works away from the desk a lot, on a phone or tablet on the course day.

**Success:**
- **One way to save:** edits save themselves, and one status chip on each screen says where they are. Explicit buttons are kept only for actions that leave the admin (a mail, protocol, assessment, invoice, contract or newsletter), that publish, that move money, or that cannot be undone.
- **Nothing typed is lost silently:** not on closing a drawer, navigating, losing the connection or signing out.
- **Fewer clicks** for the weekly tasks, as counted in the hand-off.
- **Daily work first:** the menu is grouped and every page has an entry.
- **The course day works on a phone and on an iPad held upright.**

**Anti-goals:**
- **A business rule changed beyond the B list** (§5).
- **New features.**
- **A second visual language.** The tokens, fonts and shapes stay (G11).
- **Publishing or sending without an explicit press.**
- **Losing what works,** above all the protocol screen on a phone.

## 2. Sources and authority

- **The hand-off** is in `docs/superpowers/specs/admin-ux-pass/handoff/`. `README.md` is its build guide. The `.dc.html` files are reference prototypes: open them in a browser from that folder. Its stock photos are left out of the repo.
- **The analysis of the hand-off against the code** (21.10) is in `docs/superpowers/specs/admin-ux-pass/analysis/`. It has three files, with file:line maps:
  - `behaviours.md`: each B item, the save mechanisms today, the conflicts and the migrations;
  - `strings.md`: every changed and new Estonian string, and where the sources disagree;
  - `screens.md`: layout details the README leaves out, the Q&A, the parked list, and a screen → files map.
- **Order of authority:**
  1. this document's rulings;
  2. the hand-off README;
  3. the prototypes: the desktop mock, then the phone mock, then the notes;
  4. the earlier specs.

  The README's first page says B11–B20 are "still to decide"; that line is stale. Its §5, parts 3–4 and the deck all say B1–B22 are accepted.
- **House rule:** a commit that changes a rule recorded in an earlier spec amends that spec in the same commit. §7 lists them.

**Dim's decisions (in the design tool):**
- **Q1:** published content saves to a draft and goes live with „Avalda muudatused".
- **Q2:** money is recorded with an explicit „Lisa laekumine".
- **Q3:** below 900 px the phone top bar is used.
- **Q4:** Maria writes both languages as she goes: one ET | RU switch per page, with no side-by-side mode.
- **Q5:** „Testimine" is in the menu for every admin.
- **B1–B22** are accepted.

## 3. What gets built

The whole hand-off README:
- §1 global components;
- §2 the A screens;
- §3 the B screens;
- §4 the C screens;
- §5 behaviour changes B1–B22;
- §7 tokens (the only new colour is #faf6f8).

The rulings below change or complete it.

## 4. Rulings

### 4.1 Saving, drafts and publishing

- **R1. Autosave goes through route handlers** under `/api/admin/…`, not server actions (my call). Server actions can't send with `keepalive` on `pagehide`, and they redirect when the session has ended. The handler answers 401, and the chip shows „Salvestamata — logi uuesti sisse".
  - `useAutosave` generalises `protocol-autosave.ts`. Its constants already match the hand-off: `DEBOUNCE_MS = 1500`, retries 2/5/10/20/30 s, keepalive ≤ 64 000 bytes.
  - The builder chooses between one generic route and one route per editor.
- **R2. `Shell` moves into `app/admin/(panel)/layout.tsx`** (my call). The sidebar reads the active entry from the path, with the R23 exceptions. This is needed for:
  - `loading.tsx` and `error.tsx` that keep the sidebar;
  - `useLeaveGuard`, which watches every page;
  - reading the badges once per navigation instead of on every page.
- **R3. When a draft is used** (my call, from Q1):
  - **Draft layer:** an item that is published, or an e-course that has any access row (it has live readers even unpublished, phase 3a spec).
  - **Straight to the row:** everything else.
  - **Drafts are kept per part,** with the version of the live row they started from.
  - **„Avalda muudatused"** copies every part live in one transaction. A part whose live row changed meanwhile is not copied; the bar lists it.
  - **„Loobu muudatustest"** deletes the item's drafts.
  - **What a draft holds** (my call, from the builder check): every field of the item's form, except the instant controls (R7) and the lesson actions that act live (R5). That includes prices and package numbers, level, form („Õppevorm"), badge, the test's answers, pass mark and tries, a slide's tone, the language and „Näidissisu". So nothing typed on a live item reaches the public or a student before „Avalda muudatused".
  - **The publish switch leaves the form** (my call). Today it is „Avalikul lehel" on a course and „Avaldatud" on a post.
    - An unpublished item has the header button „Avalda" (Draft), which runs the checks that today run on save. For example, a post needs a cover.
    - A published item has „Peida avalikult lehelt" (Draft) under „Veel ▾", behind a ConfirmPanel.
    - On unpublishing, the waiting drafts are written to the row, so nothing is lost and nothing becomes public. If the item still has live readers (an e-course with access rows), its drafts stay drafts.
- **R4. Legal texts never autosave live** (my call, from contracts R6/R11/D4). These are:
  - Privaatsus (`privacy`);
  - Õppetingimused (`terms`);
  - E-koolituse leping (`course_terms`);
  - Kontaktkoolituse leping (`contract_contact`).

  They always save to a draft, published or not. They go live only through a ConfirmPanel:
  - „Avalda uus leping" for the three contract texts, with the count of e-course students who must accept again, or „kehtib uutele registreeringutele" for the contact contract;
  - „Avalda muudatused" for Privaatsus.

  Publishing is what makes a new version, exactly as a save does today. Nothing else in the contracts spec changes.
- **R5. Modules and lessons in a course draft (B18, my call):**
  - **Drafted:** names, texts and order.
  - **Real rows at once:** a new module or lesson, because videos and files belong to the row.
    - A new lesson starts hidden.
    - A new module is added as today: Maria types its name and presses „Lisa moodul", and it shows at once. Modules have no hidden flag, and pressing the button is explicit. Only later renames are drafted.
  - **Act live at once, as today:** a lesson's kind, its „Õpilastele nähtav" switch, its files and its video.
  - **Deleting a module or lesson** on a draft course is done at publish and checked again then. A lesson with progress is refused and listed.
- **R6. Preview uses Next's `draftMode()`** through an admin-only route (my call). The `mslab_preview` cookie only passes the coming-soon gate, and cached pages ignore `?mustand=1`.
  - Public pages read drafts only in draft mode. `server/public-cache.ts` stays as it is for visitors.
  - „Loobu muudatustest" stays in the admin. It does not go on the preview page, though the phone note puts it there; the README wins.
- **R7. Instant controls act live at once,** outside the draft, with the UndoBar where the hand-off shows one:
  - a review's „Avalda" / „Peida" / „Avalehel";
  - the popup's „Lehel näidatakse";
  - a slide's „Näidatakse avalehel";
  - a course's order.

  Everything else in the form is drafted (R3).
- **R8. The freshness rule is restated** (amends the vercel-move spec): the next public request after „Avalda muudatused" shows the change. For unpublished items, it is the next request after the autosave.
- **R9. Number fields save on blur,** not while typing, and keep their `taken` checks. These are „Järgmine number" for invoices and for certificates.
- **R10. „Taasta minu tekst" (B13)** overwrites the newer saved text only when pressed. The notice keeps the overwritten text visible so it can be copied. This amends the protocols spec's "newer text is never overwritten".
- **R11. The newsletter editor flushes before „Saada kõigile".** A save that changes nothing does not move `updatedAt`, so the send guard (campaigns spec) keeps working.
- **R12. Changing an issued invoice's buyer („Muuda saajat") stays explicit:** it changes a record.
- **R13. A new record is created by its first autosave,** not when the empty form opens (my call). After that the address changes to the new row. Examples: a post, a session (its explicit „Lisa toimumine" stays), a course.
  - A post's slug follows its title until it is first published.
  - This removes collisions like several „Uus postitus" drafts competing for one slug.

### 4.2 Money

- **R14. „Lisa laekumine" (B4)** reuses the existing `addRegistrationPayment` (`db/queries/admin.ts`). That function already adds the amount, recomputes the status and checks the seat (D2).
  - With the receipt box ticked, the same transaction makes the „Juba tasutud" invoice.
  - **An open payment request is paid first** (my call, from the builder check). If the registration has an unpaid request invoice („Maksmiseks"), the panel's first amount pill is that invoice: „Arve {nr} · {x} €" (Draft).
    - Recording it goes through today's `markInvoicePaid`. It makes no second invoice, and the student's „Maksa" no longer charges it.
    - The receipt box is hidden for that pill.
    - Another amount is still possible, through the other pills.
  - The amount must be positive.
  - The typed „Laekunud summa" field leaves the drawer's main path.
- **R15. Corrections** (my call: the hand-off has no correction path, and a ledger table would be a second money model).
  - Under „Veel ▾" in the Raha card, „Paranda laekunud summat" opens today's absolute field (`recordRegistrationPayment`) and its rule. The status is recomputed from scratch, with no seat check: below 50 % the registration goes back to „Ootab ettemaksu", even if Maria confirmed it by hand.
  - The ConfirmPanel names the resulting status before she confirms: „Kas parandan laekunud summa {x} € → {y} €? Staatus: {uus staatus}." (Draft). A correction that frees a place says so: „Koht vabaneb avalikus kalendris." (Draft).
  - A wrong receipt is cancelled with the invoice's own „Tühista arve".
  - Invoices R10 is unchanged: undoing an invoice's payment („Võta tasumine tagasi") never lowers „Laekunud summa".
  - This amends the payments spec ("Maria's manual form stays") and the invoices spec ("typing … still works") to "is the correction path".
- **R16. The status pills stay a manual override** without a seat check (`seats.ts`'s accepted rule).
  - An active registration shows „Ootab ettemaksu" / „Kinnitatud".
  - A cancelled one also shows „Tühistatud" selected, so picking another restores it (my call: today's way back, which the design leaves out).
  - Cancelling goes through the danger button and its ConfirmPanel (B10).
- **R17. „Lisa laekumine" details:**
  - The method pills are Pangaülekanne, Sularaha and Kaart. „Kaart" prints as today's „Kaardimakse kohapeal" on invoices.
  - The amount pills are: what is missing up to 50 %, the full remainder, and „Muu summa".
  - The builder words the messages the hand-off leaves out, in its style, marked Draft:
    - the payment stays under 50 %;
    - no receipt was made;
    - the seller data is missing, so the box is hidden.
- **R18. B10 cancel leaves invoices and open Montonio orders as they are.** A late payment follows today's settle handling: it is recorded, Maria is told, and she refunds.
- **R19. B11 batch invoices are built,** as Dim accepted. Its ConfirmPanel names the number range. This amends the invoices spec's "No bulk button" and the comment in `InvoiceCatchUp.tsx`.
- **R20. B22 adds the payment status `replaced`.**
  - Settle treats a replaced order that turns PAID like today's double payment: it is recorded and goes under „Ootel kontrollil" with the reason „Topeltmakse — tagasta" when the registration is already paid in full.
  - The daily check covers `replaced`.
  - A järelmaks attempt replaced by a bank attempt follows the same rule (instalments spec).
- **R21. The Maksed ja arved badge** counts:
  - paid online payments with no invoice;
  - payments `kontroll`, including „Tühistatud pangas" (B14);
  - replaced orders paid twice.

  A checked one leaves the count through `payments.checked_at`, set by „Märgi kontrollituks" (Draft) in the row's „Veel ▾".

### 4.3 Screens

- **R22. „Saada hinnang" (A4)** is the informed button with no panel. The exception is when every point is approved: then the send completes the course, issues the certificate and mails her. Then the ConfirmPanel asks first, by the README's own rule (§1.6: "changes a student's access … right away"). Its lines are today's `confirmPassed` and `confirmNotes`. This narrows the completion spec's "one confirmation" to that case.
  - The test review's send is „Saada · {õ} õige, {v} vale".
- **R23. The active menu entry:**
  - `/admin/protokollid?ligipaas=` is the assessment screen and stays under „Hindamine";
  - `?sessioon=` and `?registreering=` are under „Protokollid".
- **R24. The per-student protocol send reads „Saada protokoll · {eesnimi}"** (my call). An Estonian -le/-ile form can't be built reliably for every name, Cyrillic ones included.
- **R25. A lesson row shows „Töötlemisel {n}%"** only if Bunny's video object gives the encode progress. Otherwise it shows „Töötlemisel…".
- **R26. Hüpikaken (C4)** keeps the app's three-way choice (Kampaania / Uudiskiri / Väljas) and both popup editors.
  - It gets the site-editor template: autosave and drafts, LangSwitch, SaveStatus, and each popup's preview following LangSwitch.
  - The phone mock's single popup and its new fields („Soodustus (%)", „Kood kehtib") are not built. The README wins, and there are no new features.
  - The route stays `/admin/kampaania`.
- **R27. Testimine (C7)** keeps the test plan's working parts: the „Muudetud" filter, „Jäta vahele", and the „Uuesti testida" / „Sõnastus muutus" / „Uus" marks the deploy stamps. Its filters are regrouped into the labelled rows „Olek" / „Kes". The test-page spec D1 ("not in the main menu") is amended per Q5.
- **R28. After an action in Tagasiside, focus stays on the row** (the README). The UndoBar does not move it.
- **R29. Undo (B5)** covers Maria's own removals: a lesson file, a manual review, and list rows in the editors.
  - A list row comes back on the client and is saved again.
  - A student who withdraws her review permission still deletes it for good (reviews D6).
  - „Seda ei saa tagasi võtta" goes from every question whose action can now be undone.
- **R30. The new page-level switch keeps the name `LangSwitch`.** The per-field one exported from `I18nInput.tsx` is renamed.

### 4.4 Words

- **R31. Which text wins:**
  - the README's text;
  - where it is silent, the desktop mock;
  - a phone short form only where one is drawn.

  `analysis/strings.md` §4–5 lists the 28 disagreements and the 21 double wordings. The builder settles each by this rule, with these exceptions:
  - The saved chip may show a ✓ before the README text, hidden from screen readers.
  - A page whose record is missing keeps today's „… ei leitud." text. The README's „Seda {asja} enam ei ole. Tekst on selles seadmes alles." is for an autosave whose record has gone.
  - The verb is „Ava registreerimine" everywhere, matching the menu's „Registreerimised".
- **R32. Words changed by this pass,** amending the specs that recorded the old ones:
  - „Lukusta ja saada kõik" → „Saada kõigile ({n})" (protocols);
  - „Uudiskiri → Kampaaniad" → „Uudiskiri → Kirjad" (newsletter);
  - „Peida" / „Näita õpilastele" → the switch „Õpilastele nähtav" (lessons).

### 4.5 Sign-in

- **R33. The rate-limit message reveals nothing** (B20, my call). The sign-in page never tells which addresses exist (`server/login.ts`).
  - Requests are counted per typed address, allowed or not: 3 in 10 minutes, as today's cap.
  - „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti." shows the same for any address.
  - The sent text stays hedged („Kui see aadress on lubatud, saatsime lingi …", Draft), because the design's „Saatsime lingi aadressile {email}" is false for an address outside the list.
  - „saada uuesti 1 minuti pärast" is used only if a 1-minute rule is built. The builder chooses whether to build it or drop the clause.
- **R34. `?tagasi=` (B19) rides on the verify link's address.** No migration is needed. It is accepted only as a same-origin `/admin…` path.

### 4.6 Other

- **R35. B21:** invoice numbers restart per year with no manual step. Certificate numbers stay as they are: they already restart each year (certificate D2), so the README's sentence about them means "unchanged". It must ship before 1 December 2026: today a December invoice silently erases a next-year number preset.
- **R36. B6:** the Hindamine count updates after „Ava test uuesti" (the path is revalidated). This amends the note in `server/actions/admin-assessment.ts`.

## 5. Behaviour changes

All of B1–B22 are in the README §5, with the rulings above. Each is its own commit, as the README asks.

## 6. Data

**Migrations: three, all additive.**
- **A drafts table** for B2, B18, the legal texts (R4) and B15: `content_drafts (entity, entity_id, part, value jsonb, base_version, version, updated_at, updated_by)`, unique on (entity, entity_id, part).
  - B15's test-review marks also go here, as entity `test_review`. They are not in `test_attempts.review`, which the student sees.
- **`removed_at`** on `lesson_files` and `reviews` (B5), with a lazy purge after 10 s plus the daily sweep.
- **On `payments`:** status `replaced` (B22), plus `check_reason` and `checked_at` (R20, R21).

**How they are numbered and applied:**
- They take the next free numbers when built (my call). The instalments spec reserved 0017, but that work waits on Montonio. Whichever piece ships second renumbers its migration and amends its spec.
- They are applied on Railway before the push, as `docs/deploy.md` says.

**Avoided on purpose:**
- version columns: per-part content hashes (`lib/version.ts`) do the job;
- a return-path column: R34;
- `unaccent`: search is plain `ILIKE`;
- a manual-payment ledger: R15.

## 7. Delivery

The pass is too big for one plan. It is five pieces, built in this order (my call). Each piece gets:
- its own plan;
- the subagent build with per-task review;
- a final review;
- a deploy to mslab.ee, which stays behind the gate.

**Pieces 3 and 4 may swap.** B22 (piece 4) changes how a Montonio order starts and is settled. Instalments, if it ships first, follows it.

**1. Frame and quick wins.** No migration.
- **Components:**
  - ConfirmPanel, UndoBar (client), SaveStatus, ListToolbar and the list-table changes;
  - the new LangSwitch and the changed I18nInput (R30);
  - `loading.tsx` / `error.tsx`, and the glossary words.
- **Shell and menu:** Shell in the layout (R2), the sidebar groups, the 900 px breakpoint and the footer.
- **Behaviour:** B6 (minus the Maksed clearing), B7, B8 + B16, B9, B10, B12, B14, B17, B19, B20 (R33), **B21 (deadline 1.12)**.
- **Screens:**
  - A1 Ülevaade, A7 Päringud, B1 Koolitused list, C8 Sisselogimine;
  - the list pages' toolbars.

**2. Autosave.** Migration: the drafts table, first used by B15.
- **The machinery:** `useAutosave` and the routes (R1), `useLeaveGuard` with the Drawer change, B1, B3, B13 (R10).
- **Editors without publishing:**
  - the Kalender drawer (B3 screen), and the registration drawer's status and note (part of A2);
  - Testimine (C7, R27);
  - Uudiskiri (B5 screen, R11);
  - the non-legal parts of Seaded (B4 screen, R9).
- **The protocol screen** moves onto the shared code (A3).
- **Hindamine** (A4, B15, R22).

**3. Drafts and publishing.**
- B2 with PublishBar and preview (R3, R6–R8).
- C1 Avaleht, C2 Koolitaja, C3 Uudised, C4 Hüpikaken (R26) and C5 Praktika.
- The course editor and the lesson drawer (B2 screen, B18, R5).
- The legal texts in Seaded (R4).
- Lesson-file undo, with the `removed_at` migration.

**4. Money.** Migration: `payments`.
- The A2 drawer order and the Raha card: B4 (R14–R17), B10 already done.
- B11 (R19).
- A6 Maksed ja arved, with search and CSV.
- B22 (R20), and the Maksed badge clearing (R21).

**5. Finish.**
- A5 Õpilased with its drawer.
- C6 Tagasiside: review undo (R28, R29).
- The remaining UndoBar wiring.
- Phone layouts checked against Part 4.
- A last pass over every string against `analysis/strings.md`.

**In every piece:**
- **The test plan follows the code** (standing rule). Each behaviour change updates `src/data/testplan.json` with `redo`, `reworded` or `new` marks, `markedAt "deploy"`. Run the stamp before each push, then re-run the test-plan tests.
- **Docs follow the code:** `docs/deploy.md` for migrations and routes, and `docs/launch-checklist.md` for items closed or opened.
- **Amended specs,** each in the commit that changes the rule:
  - contracts (R4);
  - payments and invoices (R15, R19);
  - protocols (R10, R32);
  - e-course completion (R22);
  - test page (R27);
  - newsletter-simple (R32);
  - vercel-move (R8);
  - instalments (migration number, R20).

## 8. Out of scope

- New features, including:
  - the e-course contract copy button;
  - „Võta number paberile";
  - a side-by-side language view.
- The student and public side: the account, the e-mails (including the mail logo in dark mode), and the public pages, except draft-mode preview (R6).
- Shared-tablet attribution: Maria is the only course-day user.
- The test plan's own content, Telegram capping, and `TestPlan.tsx`'s size.

## 9. Left to the builder

- How the components are split into files.
- The CSS beyond the hand-off's numbers.
- One generic autosave route or one per editor (R1).
- How each editor's parts map to draft parts.
- The Draft wordings named in R3, R14, R15, R17, R21 and R33.
- Settling each listed string disagreement by R31.
