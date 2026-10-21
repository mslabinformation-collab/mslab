# Admin UX hand-off: behaviour changes checked against the code

Read-only analysis, 21.10.2026, `main` at 6832ccf. Nothing in the repo was edited, built or run.

**How to read the references**
- Paths are relative to `C:/Users/Dmitri.MARKIT/source/repos/MSLab/app/src/`.
- Exceptions: `docs/…` is relative to the repo root, and `app/drizzle/…` and `app/vercel.json` are relative to the repo root too.
- "HO §x" is the hand-off README (`…/scratchpad/visual-studies/design_handoff_admin_ux/README.md`). "HO Part 1/2/3" are its `.dc.html` files.
- Sizes: **S** is up to a day, **M** is a few days, **L** is a week or more, each including tests and the `testplan.json` update.

## Headline findings

1. **The legal texts must not autosave.** Every changed save of the e-course terms or the contact contract publishes a new contract version (rulings R6 and R11). Wired to autosave, every pause in typing would:
   - ask every active e-course student to accept again;
   - make every open registration form and cart refuse.

   The hand-off already puts contract texts on the draft layer (HO §B4). But Seaded's "every card autosaves" also covers `privacy`, `terms` and `course_terms`, which sit in the same `SettingsEditor` form as Kontakt.
2. **B4 changes rules that were written down on purpose.**
   - The specs say Maria's typed „Laekunud summa“ stays (payments spec §8; invoices spec D5).
   - Maria's manual confirmations take no seat check, and that is a documented choice (`db/queries/seats.ts:42-47`).
   - A receipt's „Võta tasumine tagasi“ does not take money back (ruling R10, `server/invoices.ts:308-312`). The hand-off's "a wrong entry is undone through the receipt's Võta tasumine tagasi" (HO Part 2) is therefore false today.
   - There is no ledger of manual payments: `registrations.paid_cents` is one total (`db/schema.ts:99`).
3. **"Unpublished items save straight to the row" (HO §1.8) is unsafe for e-courses.**
   - Students read lessons, tests and points of unpublished courses (`docs/…/2026-10-05-phase3a-lessons-video-design.md:69`; `server/admin-clients.ts:290`).
   - Points and test questions get frozen into protocols and attempts.
   - The rule has to be "has live readers", not "published".
4. **There is no draft or preview layer today.**
   - `server/preview.ts` and the `mslab_preview` cookie only pass the coming-soon gate (`lib/preview-cookie.ts:1-6`).
   - Public pages are cached for 300 s (ISR), so `?mustand=1` cannot work as drawn. Next's `draftMode()` or an admin-only preview route is needed.
   - Home, Koolitaja, Praktika and Hüpikaken have no published flag at all.
5. **The autosave transport cannot be server actions.**
   - A server action cannot be sent with `keepalive`.
   - `adminAction` redirects to the login page when the session has ended (`server/auth.ts:174-178, 244-247`).
   - Every action ends with `refresh()` and `revalidatePath`.
   - The protocol screen already uses a `withAdmin` route handler, which answers 401 JSON instead (`app/api/admin/protokoll/route.ts:13`).
6. **B11 contradicts a recorded ruling:** „No bulk button (my call: each one is a real number).“ (`docs/…/2026-10-16-invoices-design.md:72`). **B20 contradicts the no-enumeration rule** (`server/login.ts:14`).
7. **Most of B21 already exists.** Invoice numbers already restart at 001 each year (`domain/certificate.ts:127-143`). What is left:
   - a real bug: any December issue erases a next-year preset (`server/invoices.ts:125`; certificates too, `server/certificates.ts:130`);
   - the UI.

   The hand-off's "certificates keep their running number (no yearly reset)" is wrong: certificates reset yearly too (certificate spec D2).
8. **Migrations:** 5 new ones are required (0018–0022), because 0017 is already claimed by the instalments spec (`docs/…/2026-10-20-instalments-design.md:62`). Up to 3 more are optional (see "Migrations needed").

---

## Autosave and save mechanisms today

The hand-off says "five save models side by side" (HO Part 1 §3.1, G4). The code has **eight**, plus guards that differ from page to page.

| # | Mechanism | Where | Version / stale check | Local copy |
|---|---|---|---|---|
| M1 | `useSiteDraft` + `SaveBar`, explicit „Salvesta“ | HomeEditor:106 (with SlidesEditor and FaqEditor as children), TrainerEditor:201, PracticeEditor:77, CampaignEditor:195 (the popup), SettingsEditor:179, PostEditor:176 | SHA-256 hash per part, `contentVersion` (`lib/version.ts:19-22`); `saveParts` (`server/admin-site.ts:130-156`) locks the tables `IN EXCLUSIVE MODE` (`db/queries/admin-site.ts:21-24`); all parts or none | none |
| M1b | `SaveBar` with its own state | NewsletterCampaignEditor:383 → `saveCampaign` (`server/newsletter-campaigns.ts:98-121`) | no version; a `status='draft'` guard only; every save bumps `updatedAt` (:116) | none |
| M2 | CourseEditor's whole draft as JSON, with its own inline bar (CourseEditor.tsx:430-445) | CourseEditor with children TestEditor, ProtocolStagesEditor, GalleryEditor, ListEditor, BadgeEditor → `saveCourse` (`server/actions/admin-content.ts:33-37`) → `saveCourseForm` (`server/admin-content.ts:86-232`) → `saveCourseWithImages` (`db/queries/admin.ts:133-170`) | one `courses.updatedAt` for the whole course (`db/queries/admin.ts:147-152`) | none. **After a save the whole draft is replaced** (CourseEditor.tsx:76-81), so keystrokes typed during the save are lost. |
| M3 | Plain explicit forms with no version | CertificateSettings (:234), InvoiceSettings (:277), ContractTexts (:129), SessionForm (:229), RegistrationForms (three forms :92, :121, :161), LessonDrawer text (:104-108), the per-module „Salvesta“ (LessonsEditor.tsx:185-189), ManualReviewForm (:236), InvoiceRow „Muuda saajat“ | none. Exceptions: the registration status form sends `expected` (`server/admin.ts:41-55`); certificate and invoice numbers are refused as `taken` under a lock | none |
| M4 | Instant commands | LessonsEditor add/move/delete (`server/actions/admin-lessons.ts:60-81`), LessonDrawer kind/hide/delete, LessonFiles, LessonVideoField (tus upload to Bunny), CourseOrder ↑/↓ (`FOR UPDATE`), RequestToggle, ReviewsPanel, ClientForms, the InvoiceRow actions | the state of the row | none |
| M5 | `protocol-autosave.ts` (`ProtocolAutosave`) | ProtocolScreen; AssessmentScreen's notes → `POST /api/admin/protokoll` (a `withAdmin` route) | integer `protocols.version` (`db/schema.ts:411`) | yes, per tab: `mslab-protocol:<id>:<tab>`, `-sent:`, `-conflict:` (protocol-autosave.ts:143-150) |
| M6 | `verdict-taps.ts` | AssessmentScreen „Kinnitatud“ / „Paranda“ → `POST /api/admin/hinnang`; kept out of the notes' autosave on purpose (ruling R2, verdict-taps.ts:4-12) | the student's round; a 409 drops the tap | memory only |
| M7 | `testplan-outbox.ts` | TestPlan → `PUT /api/admin/testplan` | merged by `at` on the server | yes, `mslab-testplan-outbox`, shared across tabs |
| M8 | Local draft, explicit send | TestReview → `reviewAttemptAction` (`server/actions/admin-assessment.ts:55-61`) | the attempt's `submittedAt` | yes, `mslab-review:<attemptId>`, local by design (TestReview.tsx:12-18) |

**M5's details** (the hook to generalise):
- debounce 1500 ms (:110);
- save timeout 10 s (:114);
- retries 2/5/10/20/30 s (:116);
- keepalive budget 64 000 bytes (:123);
- 400/401/403/404/409/413 mean "not stored" (:126);
- `pagehide` sends with keepalive (:911-920);
- the tab going hidden flushes; the tab shown again or `online` retries (:892-904);
- one save per protocol at a time, through a promise chain (:985-1003);
- conflict merge (:1121-1147);
- old-iPad rules: no `crypto.randomUUID` (:453-454), no regex lookbehind (line 2; `tests/unit/old-safari.test.ts`).

**Guards today**
- `beforeunload` in useSiteDraft (:50-55), CourseEditor (:85-91), NewsletterCampaignEditor (:255-260) and LessonVideoField (:150-157).
- Drawer `confirmClose` is passed **only** by the lesson drawer (`app/admin/(panel)/koolitused/[id]/page.tsx:102`; `Drawer.tsx:43-163`).
- **Nothing guards in-app navigation** (a sidebar `Link`). Every M1 and M2 page can lose unsaved edits silently today.
- The three Seaded cards, SessionForm, ManualReviewForm and the module rename have no guard at all.

**What `useAutosave` must replace, and what it must not absorb**
- **Replace:** M1, M1b, M2 and most of M3. The hand-off's "What replaces what" table (HO Part 1 §3.1) matches the SaveBar users exactly.
- **Not M3's money form.** It becomes B4's explicit „Lisa laekumine“.
- **Not the invoice buyer** („Salvesta saaja“). The hand-off removes that button, but the invoice PDF "is drawn from this row on every download" (`db/schema.ts:707-716`), so a half-typed buyer could be downloaded. Commit it on blur or keep the button.
- **Not the number fields** of CertificateSettings and InvoiceSettings: see the conflicts list, item 13.
- **M4 stays instant** and gains an UndoBar where B5 says so.
- **M5 is ported onto the generic hook, not rewritten.** Keep the conflict-merge semantics, the per-tab keys and the iPad rules.
- **M6 and M7 keep their own engines.** M6 must stay outside the notes' version check (R2).
- **M8 changes only through B15.**

---

## B1 Autosave endpoints (`save{Thing}Part(id, part, version, patch)`)

**Today**
- There are no patch-style saves.
- M1's `saveParts` (`server/admin-site.ts:130-156`) is already "changed parts with their versions" and is the closest model. A stale answer carries no stored value (:154).
- The course has one version for everything (`domain/course-editor.ts:196`). Its stale answer carries nothing either (`server/admin-content.ts:230`).
- No version exists for lessons, modules, sessions, the registration note, the three Seaded cards or manual reviews.

**Requires**
- **Transport: route handlers, not server actions.** For example `POST /api/admin/salvesta/{thing}` wrapped in `withAdmin` (`server/auth.ts:228-237`). Reasons:
  - keepalive (HO §1.3 asks for `pagehide` saves);
  - 401 instead of a redirect, so the `signedOut` state can show;
  - no `refresh()` or `revalidatePath` re-rendering the page into every autosave's answer (`server/public-cache.ts:11-13`).
- **One endpoint per editor**, with its part map:
  - home (slides / statement / teaser / faq);
  - trainer (5 parts);
  - practice (one part per package);
  - popup (campaign / newsletter);
  - Seaded (contact / newsletter / prepayment / privacy / terms / course_terms, plus certificate, invoice and contract cards);
  - post;
  - course (needs a part split: today it is one `CourseDraft`);
  - lesson text;
  - module title;
  - session;
  - registration note;
  - newsletter campaign;
  - test plan (exists).
- **Versions where none exist.** Either a content hash (`lib/version.ts`, no migration) or `version integer` columns (a migration, optional).
- **A 409 that returns the stored value and its version.** B13 needs it.
- **Revalidation cadence.** A live autosave of contact, newsletter or trainer revalidates every public page (`server/cache-targets.ts:73, 82`). Either revalidate only on publish (B2), or debounce revalidation separately.
- **A creation step before autosave.** A new course redirects to `?loodud=1` (`server/actions/admin-content.ts:35`), a new session to `?lisatud=`, and a new post likewise. HO §1.3 keeps „Lisa …“ as an explicit create; after it, the local-storage key must move from "new" to the id.

**Conflicts**
- Freshness contract: „next request after "Salvesta" shows the change“ (`docs/…/2026-10-02-vercel-move-design.md:18`). Restate it as "after a save" for unpublished items and "after „Avalda muudatused“" for published ones.
- `app/src/data/testplan.json` mentions „Salvesta“ 56 times, and about 15 e2e specs depend on `data-save-bar` / `data-save-status` (for example `tests/e2e/admin-edit.spec.ts`, `admin-site.spec.ts`, `newsletter-campaigns.spec.ts`).

**Risks**
- **Size limits:**
  - a legal text may be 30 000 characters per language (`domain/site-editor.ts:53`), a post body 20 000 (:41), a course body 10 000 (`domain/course-editor.ts:61`);
  - Estonian and Cyrillic letters are 2 bytes in UTF-8, so one field can exceed the 64 KiB keepalive budget, and the local copy is then the only safety net;
  - localStorage is shared with the protocol copies (up to 200 000 characters each), `mslab-review:*` and the test-plan outbox.
- **Locks:** `saveParts` locks the whole `settings` and `pages` tables. At autosave cadence that collides with the number series, which live in `settings` (`db/schema.ts:828-831`).
- **Two tabs:** hash versions refuse each other in turn. The client must remember what it sent (M5 does, :1134-1138), or its own lost answer looks like a conflict.
- **Ambiguity:** whether the generic hook replaces `ProtocolAutosave` or only copies its pattern. Recommendation: extract the engine and keep the protocol screen's behaviour byte for byte.

**Size L.** The infrastructure is M, and each editor is S–M. **Dependencies:** none; B1 is the base of B2, B3, B13 and B18.

## B2 Draft layer + PublishBar

**Today**
- Only `courses.published` (`db/schema.ts:61`) and `posts.published` (:165) exist.
- Hero slides have `active` (:155). The popup has `active`, with a unique index allowing one active row (:186, :193).
- FAQ, `pages`, `settings`, `gallery_items` and `practice_packages` are always live.
- No draft copy exists anywhere: no `draft_json`, no `mustand`, no `draftMode`.
- Public readers filter `published` / `active` (`db/queries/public.ts:37, 63, 100, 105, 132, 139`). Pages use ISR (the course page has `revalidate = 300`, `app/[locale]/(site)/koolitused/[slug]/page.tsx:50`) and `revalidatePath` per route (`server/public-cache.ts:22-31`).

**Requires**
- **A draft table** (migration), for example `content_drafts(entity, entity_id, part, value jsonb, base_version, version int, updated_at, updated_by)`. Not `draft_json` columns, because:
  - the home, trainer, practice and popup parts span hero_slides, faq, pages, settings, gallery_items, campaign and practice_packages (`server/admin-site.ts:215-407`), so there is no single row to hold a draft;
  - a `courses.draft_json` would travel on public course objects (`db/queries/public.ts:62-71` returns whole rows) and would carry the draft test's answer key. Ruling R1 moved tests to `course_tests` precisely to avoid that (`db/schema.ts:606-608`).
- **Publish per entity, in one transaction:**
  - compare each live part's version with the draft's `base_version`;
  - write through the existing writers (`server/admin-site.ts:84-98`, `saveCourseWithImages`);
  - delete the draft;
  - `revalidatePublic`.
- **„Loobu muudatustest“:** delete the draft.
- **The changed-field list:** a field-to-label map per part.
- **Preview:** `draftMode()` turned on by an `/api/admin/…` route, plus readers that lay the draft over live data. Reading cookies or `searchParams` in an ISR page makes it dynamic for every visitor.

**Conflicts**
- **Live readers.** HO §1.8 says unpublished items save straight to the row. But e-course students read lessons, tests and points of unpublished courses:
  - "unpublished courses still work" (phase3a spec:69);
  - access is granted to "drafts too" (`server/admin-clients.ts:290`);
  - the lesson reader filters only `hidden` (`server/lesson-data.ts:78`).

  **Reconcile:** "draft when the item has live readers" means published, or a course with any `course_access` or registration row.
- **Frozen copies.**
  - Protocol points are copied when a protocol is created (`docs/…/2026-10-13-ecourse-completion-design.md:78`).
  - Test submissions are refused when the questions changed (:120; `server/test-attempts.ts:21`).
  - „A set `completed_at` is never cleared“ (:146).
  - So a half-typed points list or test that autosaves live is frozen into protocols, refuses submissions, or lets a student complete while the list is empty for a moment.
- **„Mustand“ would get a third meaning:** an unpublished course or post (dict `i18n/dict/admin.ts:1194, 1315`), a draft protocol (:597), and now an unpublished change. The hand-off's own words („Avaldamata muudatused“) avoid it in the bar. Keep „Mustand“ out of the draft layer's texts.

**Ambiguities**
- **Home, trainer, practice and popup** have no published state. Do they always draft? HO §1.8 lists them, so yes, but then "Avalda" is needed for every edit there.
- **The switches „Avaldatud“ and „Lehel näidatakse“:** are they draft fields or instant? (HO C4 makes the popup choice instant.)
- **Unpublishing while a draft is pending.**
- **A slug changed in a draft:** check uniqueness at publish (`db/schema.ts:65`), and decide which address the preview uses.
- **The post cover check** moves from save (`server/admin-site.ts:552`) to publish (HO C3 says so).
- **Image uploads** go to R2 at once. After „Loobu“ they stay as orphans; this is harmless, because public images are never deleted.

**Size L. Dependencies:** B1, and B3 for "blocked fields are listed".

## B3 Partial saves (per-field validation)

**Today:** one bad field rejects the whole form everywhere:
- course (`server/admin-content.ts:95-96, 201`);
- site parts (`server/admin-site.ts:138-139, 143, 149`);
- post (:556);
- lesson (`server/admin-lessons.ts:185`);
- session (`server/admin-content.ts:282`);
- certificate (`server/certificates.ts:214-216`);
- invoice settings (`server/invoices.ts:784`);
- contracts (`server/contracts.ts:452`);
- newsletter (`server/newsletter-campaigns.ts:104-105`).

The checks are zod plus `Check` (`server/edit-check.ts:75-176`).

**Requires:** the server checks per field and writes the valid fields of a patch, answering per-field errors for the rest. The client leaves invalid fields out (HO §1.3).

**Conflicts and difficulties: rules that tie fields together**
- **Course:**
  - a published course needs a price (`server/admin-content.ts:172-173`);
  - the type is locked once used (:105-108), and the other type's fields are cleared (:122-129);
  - the slug comes from the title and must be unique (:116-119);
  - the pass mark and the number of tries are checked together (:152-158).
- **Popup:** title and picture are required when active (`server/admin-site.ts:377-402`); one active only (:390-391).
- **Home slides:** picture, title and link are all required (:227-235). **FAQ:** question and answer (:253-256). **E-course terms:** title and body (:490-492).
- **Lists are replaced wholesale** (slides :239, gallery :354, course images `db/queries/admin.ts:154, 162-167`), and works and course images have no item id (`server/admin-site.ts:347`; `server/admin-content.ts:72`). So a "field" in a list is the whole list.

**Ambiguities**
- **May the stored state be incomplete?** For example, a FAQ question with no answer. Recommendation: yes in a draft or on an unpublished item; refuse at publish (that is HO §1.8's "blocked fields are listed").
- **How cross-field errors are attributed** to a field.

**Size M–L. Dependencies:** B1; B2 for published items.

## B4 One money path („Lisa laekumine“, `addRegistrationPayment`)

**Today**
- **One total, no ledger.** `registrations.paid_cents` is a single integer (`db/schema.ts:99`). There is no ledger of manual money: no date, method or who.
- **The typed form overwrites the total.** It is `saveRegistrationPayment` (`server/actions/admin.ts:30-33`) → `savePayment` (`server/admin.ts:32-39`) → `recordRegistrationPayment` (`db/queries/admin.ts:371-388`):
  - an absolute value;
  - the registration's row lock only;
  - no seat check.
- **The additive path already exists.** `addRegistrationPayment(tx, id, cents, now)` is at `db/queries/admin.ts:403-429`:
  - it adds the amount and recomputes the status;
  - it checks the seat through `hasFreeSeat` (:418) and returns `full` when there is none;
  - it never takes a confirmed place back.

  Callers must take `lockForPayment` first (`db/queries/seats.ts:79-82`). It is used by settle (`server/payments/settle.ts:220`) and „Märgi tasutuks“ (`server/invoices.ts:292`).
- **The 50 % rule:** `registrationStatusAfterPayment`, `paid*2 >= total` (`domain/registration.ts:7-11`); "pool" is `prepaymentDue` = `ceil(total/2)` (:3-5).
- **Receipts:** `createInvoice(db, regId, {mode:"receipt", paidAt, method})` (`server/invoices.ts:190-243`):
  - it opens its own transaction (:201);
  - it offers only `openAmounts().receipt` (`domain/invoice.ts:218-237`);
  - **it does not touch `paid_cents`.**
- **Seller check:** `sellerReady` (`domain/invoice.ts:102`). **Date check:** `paidByToday` (`server/invoices.ts:149-153`).
- **The stale-status guard:** `setRegistrationStatus(..., {expected})` (`db/queries/admin.ts:307-320`). The status is saved **together with the note** (`server/admin.ts:41-55`), and the note has no version.
- **What „R19“ means here.** The hand-off's „R19: typed Laekunud summa overcharge“ is the hand-off's own review item (HO Part 2 "parked2", Part 3 "resolved"). It is not a repo ruling: the repo's R19 is the contracts ruling about the name at the terms gate (`docs/…/2026-10-17-contracts-design.md:38`).

**Requires**
- **A ledger table (migration),** for example `manual_payments(id, registration_id, amount_cents, paid_on date, method, invoice_id null, created_at, created_by, request_key unique)`.
- **`addRegistrationPaymentAction`, in one transaction:**
  1. `lockForPayment`;
  2. insert the ledger row;
  3. `addRegistrationPayment`;
  4. optionally the receipt.

  The receipt part needs `createInvoice`'s body refactored to take a `tx` (`issue()` already does, `server/invoices.ts:88`), keeping the recorded lock order (`server/invoices.ts:25-36`).
- **Remove** `saveRegistrationPayment`, `savePayment` and their texts (dict `i18n/dict/admin.ts:241-245`).
- **Split status and note:**
  - a radio action that saves the status at once, with `expected` (an instant field);
  - a note autosave (B1) with its own version, a hash or a column.
- **The Raha card** reads free seats through `seatsTaken` (`db/queries/seats.ts:19-33`).
- **An undo for a ledger row.** It takes the amount back (`takeBackRegistrationPayment` exists) and cancels its receipt.

**Conflicts (quote, then how to reconcile)**
- **Payments spec §8:** „Maria's manual "amount received" form stays.“ (`docs/…/2026-10-09-phase2b-montonio-payments-design.md:322-323`).
- **Invoices spec:** „Typing „Laekunud summa“ by hand still works as before for anything without an invoice.“ (`docs/…/2026-10-16-invoices-design.md:30`; also `docs/deploy.md:379`).

  → B4 serves the invoices anti-goal better („Maria entering the same payment twice“, :13). Amend both specs.
- **Seats:** „Maria's own changes in the admin take no session lock and count no seats … That is accepted“ (`db/queries/seats.ts:42-47`).

  → B4 reverses this for an added payment, with „Märgi tasutuks“ as precedent. Keep the radio override seatless (HO: "manual override") and update the comment.
- **Ruling R10:** a receipt's „Võta tasumine tagasi“ cancels it, „and Laekunud summa stays“ (`server/invoices.ts:308-312`).

  → The hand-off's "a wrong entry is undone through the receipt's Võta tasumine tagasi" does not hold, and it is impossible when the receipt checkbox is off. Reconcile:
  - give a B4 receipt `paid_adds = true`;
  - add an undo branch "born paid (`due_at` null) and `paid_adds`" that cancels the receipt and takes the amount back;
  - or undo through the ledger row.
- **Refunds and corrections used the typed field:** „Maria cancels or adjusts in the admin“ (payments spec:290-291; `docs/deploy.md:199`).

  → An add-only path has no way down except undo. Decide whether a negative „Muu summa“ (a refund) is allowed.
- **„Paid is a floor“** (`server/payments/settle.ts:49-50`; payments spec:284-287) is about Montonio statuses only. Not affected.

**Risks**
- **Lost idempotency.** The typed absolute value was idempotent; an added amount pressed twice (a double tap, two tabs) adds twice. Use a request key per opened panel, or an `expectedPaid` guard like `expected`.
- **A double charge through an open request.**
  - An unpaid „Maksmiseks“ invoice stays payable (`payableDue` checks only the invoice, `domain/payments.ts:122-127`).
  - If Maria adds 175 € for the transfer that paid that request, the receipt becomes a second prepayment (`openAmounts` counts the unpaid request as covered, `domain/invoice.ts:224`), and the student's „Maksa“ still charges the request.
  - → When a matching unpaid invoice exists, „Lisa laekumine“ must go through `markInvoicePaid` instead of a receipt.
- **The receipt amount is capped** by `price − covered`, so „kviitung {nr}“ can be for less than „{x} € lisatud“.
- **Overpayment:** only settle warns about an amount over the price (`server/payments/settle.ts:260-271`). „Muu summa“ needs a cap or a warning.
- **Webhook racing the admin:** safe if `lockForPayment` comes first.

**Ambiguities**
- A registration with no price (`noPrice`, `db/queries/admin.ts:239`).
- **Does an add flip Maria's manual „Ootab ettemaksu“ to confirmed?** Today `addRegistrationPayment` would.
- **A cancelled registration:** can the radio un-cancel? The radio has only two values.
- **Järelmaks registrations:**
  - D3 says always the full price (`docs/…/2026-10-20-instalments-design.md:32`);
  - the 50 % marker and the preselected "missing up to 50 %" may not apply;
  - recording part of it by hand removes the järelmaks offer (:73).
- **„Unbilled“:** does a ledger row without a receipt count as unbilled (B6 badge, A1 queue)? Today "unbilled" means only online payments (`server/invoices.ts:681-687`).

**Size L. Dependencies:** ConfirmPanel is not needed. It must be done before B6's money badge is final.

## B5 Undo for removals (UndoBar; soft delete purged after 10 s; `undo{Thing}(id)`)

**Today**
- **No soft deletes:** no `deleted_at` or `removed_at` anywhere in `db/schema.ts`.
- **The only undo** is `undoInvoicePaid`, and it has a confirmation (`components/admin/InvoiceRow.tsx:93`).
- **Hard deletes in admin paths:**
  - module (`server/admin-lessons.ts:142`);
  - lesson, cascading to files, refused with progress (:274-277), with Bunny and R2 cleanup in `after()` (`server/actions/admin-lessons.ts:46-54, 116`);
  - lesson file (`server/admin-lessons.ts:287`), with the R2 delete in `after()` (`server/actions/admin-lessons.ts:130`) and **no confirmation** (`components/admin/LessonFiles.tsx:95-104`);
  - manual review (`server/reviews.ts:179`);
  - unused session (`db/queries/admin.ts:262-273`);
  - post (`db/queries/admin-site.ts:135`);
  - slides and FAQ rows dropped on save (:89-113);
  - course images and gallery re-inserted on every save (`db/queries/admin.ts:52, 154, 573`).
- **Where the targets live.** The list-editor targets are **JSON inside a parent**, written only on save:
  - outcomes and includes (`db/schema.ts:36-37`);
  - protocol points (:53);
  - test questions (:612);
  - practice items (:143).

  Slides and gallery are rows, but they are rewritten wholesale.

**Requires**
- **List editors** (outcomes, points, gallery, questions, slides, practice): undo is a **client state restore** (the item back at its index with its `id`), then autosave of the parent part. No server undo and no purge. Test question ids must come back unchanged: they are "never reused: attempts refer to questions and options by them" (`db/schema.ts:592-594`).
- **Lesson file „Eemalda“:**
  - `lesson_files.removed_at` (a migration);
  - every reader filters on it (`server/lesson-data.ts`, `server/lesson-files.ts`, `server/admin-lessons.ts`);
  - `undoRemoveLessonFile(id)`;
  - the R2 delete moves to the purge.
- **„Märgi tehtuks“:** undo is `setRequestHandled(id, false)` (`db/queries/admin.ts:456-459`). Add an `expected` guard.
- **Review „Avalda“ / „Peida“:** `decideReview` overwrites `status` and `decided_at` (`server/reviews.ts:95-106`). Add `undoDecideReview(id, prev)`, compare-and-set (otherwise `stale`), then `revalidatePublic`.
- **Popup „Lehel näidatakse“:** today it is part of the draft (`components/admin/CampaignEditor.tsx:41-45`). An instant action changes the `campaign` / `newsletter` part hashes, so an open draft's next save is refused as stale. Make `active` its own part, or leave it out of the hash.
- **„Pikenda“:** see B12.
- **The purge.** Vercel Hobby cron runs once a day (`app/vercel.json:3-6`), and there is no Railway worker. Use:
  - a lazy purge at the start of admin actions and pages, with precedent in the KV TTL sweep (`server/kv.ts:29-39`);
  - the daily sweep (`app/api/cron/sweep/route.ts`) as a backstop.

  Readers filter `removed_at is null`, so the 10 s is a minimum, not an exact time.

**Conflicts**
- **Reviews D6:** taking permission back "deletes the review at once, whatever its status" (`docs/…/2026-10-18-reviews-design.md:81`). The student's withdrawal stays a hard delete, and Maria's undo then answers `gone`.
- **The texts „Seda ei saa tagasi võtta“** (dict `i18n/dict/admin.ts:859, 1484, 1822`) need rewording wherever undo replaces a confirmation.

**Risks**
- **An undone publish** may be served for a moment (revalidation is immediate).
- **Two tabs:** an undo after another tab changed the row must be refused.
- **After the purge,** the UndoBar's 8 s must not outlive the server's window, so the server's window must be at least 8 s plus latency. HO says 10 s; keep it at least that.

**Ambiguity:** do the deletes that already confirm (lesson, session, post) move to undo? HO keeps ConfirmPanel for those.

**Size:** M overall for the server parts (lesson file M; reviews, requests and popup S each); L including all client UndoBar wiring. **Dependencies:** UndoBar (client); B1 for the list-editor parent autosave.

## B6 New badges / `adminCounts`

**Today**
- **What `adminCounts` holds** (`db/queries/admin.ts:462-497`): `awaitingPrepayment`, `openRequests` per kind (`change_request` included), `openPurchaseInterest`, `subscribers`, `confirmedSubscribers`, `assessment`.
- **Shell badges** exist only for registrations, assessment and requests (`components/admin/Shell.tsx:15-23`).
- **Missing menu entries.** The menu (`components/admin/sections.ts:25-43`) has no Protokollid, Arved, Tunnistused or Testimine. Those pages borrow `active` (for example `app/admin/(panel)/protokollid/page.tsx:63`).
- **Cost.** Every admin page renders Shell, which runs the counts (React `cache` per request, `components/admin/data.ts:6`; `staleTimes.dynamic: 0`, `app/next.config.ts`). It runs **5 parallel queries, plus 3 inside `assessmentCount`** (`db/queries/assessment.ts:93-99`), against a pool of `max: 5` (`db/client.ts:28`).

**What each badge needs**

| Badge | State today | What it needs |
|---|---|---|
| Registreerimised | done (`db/queries/admin.ts:478`) | – |
| Protokollid „Täna“ | `todaySessions` exists (`db/queries/protocols.ts:215-239`), used only by the overview | a new menu row, decided by the Tallinn date |
| Hindamine | badge exists | „Revalidate after ReopenTest“: see Conflicts |
| Päringud | already counts every kind | only the overview inbox leaves „Muutmine“ out (`app/admin/(panel)/page.tsx`, inbox array) |
| Tagasiside | `pendingReviewCount` exists (`server/reviews.ts:271-274`) | – |
| Maksed ja arved | – | unbilled: a count version of `uninvoicedPayments` (`server/invoices.ts:681-687`; index `invoices_payment`); kontroll: `status='held'`; voided-after-paid: `status='failed' and paid_at is not null` (`db/schema.ts:333-335`) |
| Testimine | – | `testplanCard(db, email, ADMIN_NAMES)` returns `{open, bad}` (`server/testplan.ts:136-143`); it parses the whole answers JSON and the plan on every page |

**Requires:** fold all counts into **one** SQL round trip (`select (subquery) as a, (subquery) as b, …`), plus the test-plan read.

**Conflicts**
- **Hindamine refresh:** „The open page is NOT refreshed: the row would leave Hindamine's "Katsed otsas" and ReopenTest … would unmount.“ (`server/actions/admin-assessment.ts:72-76`; `components/admin/ReopenTest.tsx:16-19`).

  → Use `refresh()` and keep the "done" line in page-level state (an UndoBar or toast). Or lower the badge on the client.
- **Testimine in the menu:** „It is not in the main menu, because it is a temporary tool until the launch.“ (`docs/…/2026-10-16-test-page-design.md:21`; `docs/deploy.md:326`). Q5 overrides this: amend the spec.
- **The Maksed badge never clears.** `held` and voided rows have no "handled" state, and Maksed is read-only (`app/admin/(panel)/maksed/page.tsx:55`). Add `payments.checked_at` and „Märgi kontrollituks“, or the badge counts forever.

**Ambiguities**
- **Testimine:** "the signed-in admin's Viga checks" means either Vead she reported (`by === email`) or Vead on checks assigned to her (`testerOf`, `domain/testplan.ts:315-331`). There is one answer per check, not one per admin (`domain/testplan.ts:31`). A third admin maps to no tester.
- **„Täna“:** sessions, or unsent protocols?
- **The menu button's total:** does it add the new badges?
- **Past sessions:** does `awaiting_prepayment` for a past session still count?

**Size M. Dependencies:** B14 (the kontroll definition), B4 (the "unbilled" definition), B8 (the Protokollid row). Add `payments.checked_at` together with B22's migration.

## B7 Search (`?otsi=`)

**Today**
- **Only Õpilased searches.** It is a GET form with „Otsi“ (`app/admin/(panel)/opilased/page.tsx:107-131`):
  - `parseSearch` caps the text at 100 characters and `containsPattern` makes an escaped ILIKE pattern (`domain/paging.ts:26-36`);
  - the query is `email ilike or name ilike` (`server/admin-clients.ts:50-53`).
- **The other lists have filters only:**
  - registrations `?vorm` / `?staatus` (`db/queries/admin.ts:322-328`);
  - payments `?staatus` (`db/queries/payments.ts:293-301`);
  - invoices `?kuu` / `?staatus` (`server/invoices.ts:667-675`);
  - requests per kind (`db/queries/admin.ts:432-449`);
  - subscribers: nothing (`db/queries/admin.ts:598-611`);
  - posts: nothing, and no paging (`db/queries/admin.ts:546-548`).
- **Indexes:** only `registrations_email_lower` (`db/schema.ts:123`). There is no `pg_trgm` or `unaccent` extension (no `create extension` in `app/drizzle/0000–0016`).

**Requires:** reuse `parseSearch` and `containsPattern` per list:
- registrations: name, email, phone;
- payments: name, email, `provider_uuid`, `reference`;
- invoices: `number`, `buyer->>'name'`, `buyer->>'email'`;
- requests: `payload->>'name' / 'email' / 'phone' / 'message'`; change requests have only email and message, so the name needs a join (`app/admin/(panel)/paringud/page.tsx:51`);
- subscribers: the address;
- posts: `title->>'et' / 'ru'`.

Then a 300 ms debounce with `router.replace` (HO §1.10). Sequential scans are fine at these volumes.

**Risks and ambiguities**
- **Case folding** for õäöü and Cyrillic depends on the database's ctype locale. Check it on Railway.
- **"oun" finding "õun"** needs `unaccent`, which is a migration (optional).
- **Phones are stored as typed** (`server/submit.ts:294`). Normalise both sides (`regexp_replace(phone,'[^0-9+]','','g')`, including `+372`).
- **Päringud across tabs:** one result list, or match counts per tab?
- **Paging and drawers:** does search reset `?leht`? Keep `?id` for the drawer.

**Size M** (six lists, each S). **Dependencies:** ListToolbar.

## B8 Protokollid index (no parameter)

**Today**
- With no parameter, the page shows a "not found" card with a link to Kalender (`app/admin/(panel)/protokollid/page.tsx:55-84`). The parameters are `?sessioon`, `?registreering` and `?ligipaas`, and the first one wins (:49-51).
- **The protocol status is computed, not stored:** `protocolStatus` gives none / draft / sent / changed (`domain/protocols.ts:18-22`; `db/schema.ts:409-414`).
- **Tallinn helpers:** `startOfDayTallinn` (`domain/calendar.ts:57`), `tallinnToday` and `endOfDayTallinn` (`domain/client-access.ts:35, 56`).

**Requires**
- **`recentSessions(db, now)`:** contact sessions from the start of the day 14 days ago to the end of today, with `count(*) filter` per state over registrations left-joined to protocols.
- **A section of open individual registrations.**
- **The entry points the spec records** are `docs/…/2026-10-12-protocols-design.md:80-87`. The index adds one.

**Ambiguities**
- **Individual registrations** have no date, only a free-text `preferredPeriod`. Which ones are "open"?
- **Cancelled sessions:** `todaySessions` keeps only `scheduled` (`db/queries/protocols.ts:230`), but the screen shows a cancelled session's students "for the record" (:122).
- **"changed"** (edited after sending): does it count as sent or as a draft?

**Size M. Dependencies:** none (the Protokollid menu row comes with B6).

## B9 Matching counts on the send buttons

**Newsletter**
- **The confirmation is already correct.** `prepareSend` counts recipients through `recipientsNow`, which drops `@example.test` addresses and case duplicates (`server/newsletter-campaigns.ts:336-351, 386-397`; `domain/email.ts:7`). The confirmation text says „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?“ (dict `i18n/dict/admin.ts:1579`; newsletter-simple spec:36).
- **The count line is not.** The Uudiskiri page uses `counts.confirmedSubscribers` (`app/admin/(panel)/uudiskiri/page.tsx:103`), which includes sample addresses and duplicates.
- **Requires:** a lock-free `countRecipients(db)` for the label „Saada kõigile ({n})“. The press still refuses `changed` when the counts moved (:413-414).
- **Ambiguity:** is n the total, or today's share? The daily room is 70 (`domain/newsletter-campaign.ts:20`), and the confirmation does not say that the rest goes the next day.

**Protocols**
- n = `planSendAll(...).will.length`, computed in the browser (`components/admin/ProtocolSend.tsx:122-141, 296`). The engine is a mutable object, so the label needs a subscription to its changes.
- **Conflict:** the button's words „Lukusta ja saada kõik“ are recorded in the spec (`docs/…/2026-10-12-protocols-design.md:107`). Renaming it to „Saada kõigile ({n})“ amends the spec.

**Size S–M. Dependencies:** ConfirmPanel.

## B10 Confirm before „Tühista registreerimine“

**Today**
- **One press, no confirmation** (`components/admin/RegistrationForms.tsx:161-177`). It calls `cancelRegistration` (`server/actions/admin.ts:40-43`) → `cancel` (`server/admin.ts:57-62`) → `setRegistrationStatus(id,'cancelled')`, **with no `expected` guard**.
- **What happens:**
  - the seat is freed at once (`takesSeat`);
  - `paid_cents` and the invoices stay („whose unpaid invoice stays until Maria cancels it“, `docs/deploy.md:374`);
  - no mail is sent;
  - an open Montonio order can still be paid inside its window. Settle then adds the money, the status stays cancelled, and Maria gets „Uus makse“.

**Requires:** ConfirmPanel. Add an `expected` guard (two tabs).

**Ambiguities**
- Should it also cancel the unpaid invoices in the same transaction (lock order `lockForPayment`, then the invoice row)?
- HO's line „Laekunud {x} € ja arved jäävad alles“ is true today.

**Size S** (M if it cancels invoices). **Dependencies:** ConfirmPanel.

## B11 Batch invoices („Koosta {n} arvet“, `createInvoicesForUnbilled()`)

**Today:** one at a time.
- `InvoiceCatchUp.tsx` → `catchUpInvoiceAction` (`server/actions/admin-invoices.ts:170-187`) → `catchUpInvoice` (`server/invoices.ts:521-539`).
- Lock order: `lockForPayment` → the payment row `FOR UPDATE` → the number lock `pg_advisory_xact_lock(hashtext('invoice-number'))` (:39, :64).
- "Unbilled" is `uninvoicedPayments`: paid, and named by no invoice (ruling R13; :681-687).

**Requires**
- Loop `catchUpInvoice` with **one transaction per payment**, oldest first. One transaction over several registrations would take session locks in an arbitrary order and could deadlock with settle.
- Report made, already and failed.
- Refuse all when the seller is missing.
- Mail nothing (catch-up already mails nothing).
- The ConfirmPanel's "{first}–{last}" needs a preview of the next number (`seqToIssue` with `highestSeq`). A number taken by a webhook in between shifts the range: say „alates {first}“, or report the real range afterwards.

**Conflict:** „No bulk button (my call: each one is a real number).“ (`docs/…/2026-10-16-invoices-design.md:72`; `docs/deploy.md:390`; `components/admin/InvoiceCatchUp.tsx:16`). Dim must rule, and the spec gets an amendment.

**Size S–M. Dependencies:** ConfirmPanel.

## B12 Extend access (`extendAccess(id, until)` with UndoBar)

**Today**
- **The table:** `course_access(expires_at, revoked_at, granted_by, granted_at, extra_tries, completed_at)`, one row per student and course (`db/schema.ts:296-311`).
- **Extending means „Ava ligipääs“ again.** `grantAccess` is an upsert that moves the expiry, clears `revoked_at` and overwrites `granted_by` / `granted_at` (`server/admin-clients.ts:356-379`):
  - **it takes no lock**, while the test code serialises on `lockAccess` (`server/completion.ts:47-50`);
  - the date must be today or later, so it can also shorten an access (`domain/client-access.ts:65-69`).
- **The payment path reuses it** (`server/payments/grant.ts:48`).

**Requires:** a new action by access id that:
- takes `lockAccess`;
- only lengthens (or explicitly allows shortening);
- keeps `granted_by`;
- returns the previous `expires_at` and `revoked_at` for the undo.

And `undoExtendAccess(id, prev)` as a compare-and-set. No migration.

**Recorded rules (no conflict, but they constrain it)**
- „After the access expires: the results stay readable … Maria extends the access in Õpilased“ (`docs/…/2026-10-13-ecourse-completion-design.md:103`).
- „A set `completed_at` is never cleared … also when the access later ends“ (`db/schema.ts:307-309`).
- A reopen on an expired access sends no mail (`server/test-attempts.ts:324-327`). After an extension, no "reopened" or "testFix" mail follows by itself.

**Ambiguities**
- **The base of „+1 kuu“:** the current expiry, or today when it has expired?
- **A revoked access:** does „Pikenda“ lift the revocation?
- **Mail:** is the student told?
- **A „Paranda“ round** needs the access running (spec:252). Should the drawer suggest „Pikenda“?

**Size M. Dependencies:** UndoBar.

## B13 Conflict restore („Taasta minu tekst“)

**Today**
- **Protocols:** a 409 shows the server's text and keeps the screen's words in a notice until „Selge“ (`components/admin/protocol-autosave.ts:879-890, 1121-1147`). Sending is held with `review` until „Selge“ (`components/admin/ProtocolSend.tsx:46, 324`; dict `i18n/dict/admin.ts:656-657`).
- **Site parts and courses:** a stale answer carries no stored text (`server/admin-site.ts:154`; `server/admin-content.ts:230`). `SaveBar`'s „Laadi uuesti“ throws the edits away (dict :1641).

**Requires**
- A 409 returns the stored value and version (B1).
- „Taasta“ writes the local copy back into the fields and saves it against the new version.
- For protocols it also clears the conflict notice and the send `review` hold.

**Conflict:** „A refused save (another device saved first) reloads that protocol with a short notice, so newer text is never overwritten.“ (`docs/…/2026-10-12-protocols-design.md:104`).

→ „Taasta“ is a deliberate overwrite, made by an explicit press after the newer text is shown. Amend the spec, and keep the overwritten text in the notice so the restore is itself reversible.

**Ambiguity:** the granularity. Restoring a whole part overwrites the other window's edits to other fields of the same part. Restore per field, or per part?

**Size S** after B1 (M including the protocol engine's notice and hold logic). **Dependencies:** B1.

## B14 „Tühistatud pangas“ under „Ootel kontrollil“

**Today**
- The status enum is `pending|paid|failed|refunded|held` (`db/schema.ts:19`).
- A voided payment is stored as `failed` and keeps `paid_at` (`db/schema.ts:333-336`; `server/payments/settle.ts:414-418`).
- `?staatus=kontroll` maps to `held` only (`app/admin/(panel)/maksed/page.tsx:29-30`), and the filter is `eq(status)` (`db/queries/payments.ts:270, 294`). So voided rows appear under „Ebaõnnestunud“.
- The label is `statusVoided` (`components/admin/PaymentLines.tsx:18-21`). `needsCheck` is in-memory only (`domain/payments.ts:170-171`).
- The pills have no counts.

**Requires:** a pseudo-filter, with no migration:
- `kontroll` = `held OR (failed AND paid_at IS NOT NULL)`;
- „Ebaõnnestunud“ = `failed AND paid_at IS NULL`;
- plus count queries for the pill counts.

**Size S. Dependencies:** none. Feeds B6.

## B15 Test-review marks saved on the server

**Today**
- Marks live in client state and in localStorage `mslab-review:<attemptId>`, tied to `submittedAt` (`components/admin/TestReview.tsx:12-18, 31, 45-80`). This is local by design.
- „Saada“ runs `reviewAttempt` under the access lock, with `submittedAt` as the version (`server/test-attempts.ts:289-317`).
- **The student is sent `review` exactly as it is stored** (`server/test-attempts.ts:114`). So a draft must never be written into `review`.

**Requires**
- **A migration:** `test_attempts.review_draft jsonb` and `review_draft_for timestamptz` (= `submitted_at`), never included in `attemptView`. Alternatively, put it in B2's generic drafts table.
- **A route** like `/api/admin/hinnang`, saving per tap.
- **A student rewrite drops the draft.**

**Conflict:** the code comment's "kept in this browser … until it is sent" (TestReview.tsx:15-16) is a design decision, not a spec rule. Changing it needs only the comment and the tests updated.

**Risk:** two devices. Last write per question wins, or a version check.

**Size M. Dependencies:** none (B1 infrastructure helps).

## B16 Single-session shortcut

**Requires:** Shell reads `todaySessions` (one more query per page, so fold it into B6's single round trip). When exactly one session is today, the Protokollid row links to `?sessioon=<id>`. The phone menu's „TÄNA“ card uses the same data.

**Ambiguity:** with two sessions today the row goes to the index. Does the badge then read „Täna“ or „2“?

**Size S. Dependencies:** B8, B6.

## B17 Delete a newsletter draft

**Today:**
- There is no delete action. The actions are save, copy, prepare, start, stop and test (`server/actions/admin-newsletter.ts:45-139`).
- The statuses are `draft`, `sending` and `sent` (`db/schema.ts:227`).
- Deliveries cascade when a campaign is deleted (:248, :252).

**Requires:**
- Delete only while `status='draft'`, under `PRESS_LOCK` plus `FOR UPDATE` (`server/newsletter-campaigns.ts:359-381`), so a press in another tab cannot race it.
- Leave the image in R2, because `copyCampaign` copies `imageKey` (:56, :124).

**Size S. Dependencies:** ConfirmPanel.

## B18 Modules and lessons in the course draft

**Today**
- Modules and lessons are their own tables (`db/schema.ts:515-554`). Videos, files and progress hang off the lesson rows:
  - `lessons.videoId` is unique (:546, :554);
  - `lesson_files` cascades from the lesson (:559);
  - `lesson_progress` (:571-583).
- The structure is changed by instant small forms (`components/admin/LessonsEditor.tsx:19-21`). Lessons are read live by students, whatever `published` says (`server/lesson-data.ts:78`).
- `startLessonVideo` writes the row (`server/lesson-videos.ts:59-77`), and the Bunny webhook finds the lesson by `videoId` (:129). A replacement keeps the old video playing until the new one is ready (dict `i18n/dict/admin.ts:1422`; `db/schema.ts:532-537`).

**Requires**
- **Real rows for new lessons, created hidden.** A draft lesson cannot live only in JSON: its video and files need the row. Create new lessons with `hidden = true`, which already means „õpilased seda ei näe ja see ei loe edenemises“ (dict :1389; phase3a spec:34), and unhide them at „Avalda“.
- **Text in the draft.** Put lesson and module text edits (title, short text) into `content_drafts`.
- **Re-check deletes at publish.** A lesson deleted in the draft is checked again then („A lesson with progress is hidden, never deleted“, phase3a spec:41, 73; `server/admin-lessons.ts:263-275`), and its Bunny and R2 cleanup waits until then (`server/actions/admin-lessons.ts:105-119`).
- **Reorder** (↑/↓ and drag): either into the draft (the order applies at publish) or kept instant. Decide.

**Conflicts**
- „lessons are only in the account (its JSON is never cached)“ (`server/actions/admin-lessons.ts:23-24`) and „Every change is saved at once by its own small form“ (`components/admin/LessonsEditor.tsx:19-21`). B18 replaces both. The reconciliation above keeps the media model.
- **„Õpilastele nähtav“** (HO B2) is not the current wording, which is „Peida“ / „Näita õpilastele“ (dict :1387-1388). It is a rename, so mark it `reworded` in the test plan.

**Ambiguities**
- **What happens to a video uploaded to a draft lesson of a live course?** It is invisible while the lesson is hidden, so this is fine.
- **Replacing a video on a visible lesson:** draft or instant? Recommendation: instant. The old one keeps playing until the new one is ready, and that already protects students.
- **The card follows the draft's „Õppevorm“** (HO B2). But the type is locked once in use (`server/admin-content.ts:105-108`).

**Size L. Dependencies:** B2, B1.

## B19 Deep link after sign-in (`?tagasi=`)

**Today**
- `requireAdmin` redirects to a bare `/admin/login` (`server/auth.ts:174-178`). Server components don't know the path, and the middleware passes `/admin` untouched (`middleware.ts:122-123`).
- The login page reads only `viga` (`app/admin/login/page.tsx:16-18`).
- `POST /api/auth/request` accepts `{email}` only (zod strips the rest, `server/login.ts:39`).
- Verify always sends a successful sign-in to `"/admin"` (`app/api/auth/verify/route.ts:25, 31`).
- `auth_tokens(hash, email, expires_at, used_at)` has no column for a return path (`db/schema.ts:833`).
- There is no `mslab-admin-email` prefill; the student side has `mslab-email` (`components/account/useAccount.ts:21, 47-61`).

**Requires**
1. **Capture the path:** the middleware sets a header for `/admin/*`, or the client captures `location` (needed for `#…` fragments such as Telegram's `/admin/testimine#<id>`, `server/testplan.ts:132`).
2. **Thread it through:** login page → form → request body → either `auth_tokens.return_to` (a migration, optional) or a second parameter on the verify URL.
3. **Validate again in verify:**
   - parse it with `new URL(v, origin)`;
   - require the same origin and a `pathname` of `/admin` or `/admin/...`, but not `/admin/login`;
   - reject what `UNCLEAN` rejects (`lib/site-gate.ts:75`);
   - rebuild it from pathname plus search, with a length cap.

**Risks**
- **Open redirects:** `//evil`, `/\evil`, `%2F%2Fevil` (decoded once) and tab or newline characters all resolve to another origin.
- **The prefill** should be written only after a confirmed sign-in, and cleared on logout.
- **Local copies are per browser.** HO's lead „Ava link selles seadmes“ matters, because the restore works only in that browser.

**Size M. Dependencies:** pairs with B1's `signedOut` state: route handlers answer 401, the chip links to the login with `?tagasi=`, and the local copy is restored on return.

## B20 An honest rate-limit message

**Today**
- **Per IP:** 5 requests per 600 s (`server/ratelimit.ts:21-22`), with the key `rl:login:<ip>` in `kv_entries`. The window restarts on every accepted request (`server/ratelimit.ts:28`). It fails open, and a request with no IP is not limited (`server/login.ts:44-53`). The answer over the limit is 429.
- **Per address:** at most 3 unused links in 10 minutes (`server/auth.ts:24-26, 80-91`). Over that cap **nothing is sent, and the answer is the same 200** (`server/login.ts:70-74`).
- **Today's texts:** the 429 says „Liiga palju katseid. Proovi mõne minuti pärast.“ (dict `i18n/dict/admin.ts:54`). The token lifetime is `TOKEN_TTL_MS` = 15 min (`server/auth.ts:22`), so „kehtib 15 minutit“ is true.

**Conflict:** „The answer never tells whether an address is allowed“ (`server/login.ts:14`); „the page never tells which addresses exist“ (dict :48); the phase-1 plan says "no account enumeration" (`docs/superpowers/plans/2026-10-01-main-site-phase1.md:875`). „Saatsid juba 3 linki“ is the per-address cap, and only allowed addresses ever get links, so showing it reveals an admin address.

**Ways to reconcile**
- **(a)** Count sends in the browser (sessionStorage, 3 in 10 minutes). It is honest to the person typing and reveals nothing. **S.**
- **(b)** Count per normalised address for **every** address in KV, and answer 429 for all of them alike. **M**, with tests proving there is no enumeration.
- **(c)** Reword the IP 429 and add `Retry-After`. **S.**

„10 minuti pärast“ is an upper bound for both limits.

**Size S–M.**

## B21 Invoice numbers per year

**Today**
- **The year already restarts the series.** `invoiceSeq` → `seqToIssue` → `nextNumber` gives a new year 1 by itself, and never at or below the highest + 1 (`domain/certificate.ts:127-143`; `server/invoices.ts:99-101`). The year is the Tallinn year of the **issue date**.
- **The December preset:** the „Aasta“ field accepts this year or next (`server/invoices.ts:811-813`; `components/admin/InvoiceSettings.tsx:219-239`; dict :472).
- **Bug:** any December issue writes `{nextYear: Y, nextSeq}` (`server/invoices.ts:125`), which silently erases a preset made for Y+1. Certificates have the same bug (`server/certificates.ts:130`).
- **Certificates are per year too:** „MS LAB {year}-{nn}“, „the series starts again each year“ (`docs/…/2026-10-15-certificate-design.md:20, 62-66`; `domain/certificate.ts:101-106`). The number is padded to 2 digits, so HO's „MS LAB {year}-{n}“ should read `{nn}`.

**Requires**
- Drop the year input and save `nextYear = tallinnYear(now)`.
- Add the hint „1. jaanuarist: {prefix}{year+1}-001“ from 1 December.
- Add the preview „Järgmine arve: …“. A changed prefix resets the number, or continues an old series (ruling R3, `server/invoices.ts:778-780`), so the preview needs the server's highest number or the wording „alates 001, kui seeria on uus“.
- Update the dict lines :443 and :472.

**Conflicts**
- **Invoices D7:** „the sequence restarting at 1 each year unless Maria sets „Järgmine number“ higher“; „unique and gapless within a series“ (`docs/…/2026-10-16-invoices-design.md:36`). B21 is consistent with this.
- **Certificates:** HO's „Certificates keep their running number (no yearly reset)“ contradicts certificate D2. Read it as "certificates unchanged".

**Ambiguity:** "the invoice date's year". Today the issue date decides, so a receipt dated 30.12 and issued 02.01 gets the new year. Keep the issue date: it is the legal invoice date.

**Size S.** Ship before **1 December 2026**: the preset bug bites in December.

## B22 One open Montonio order per registration

**Today**
- „Pooleli“ is `pending` (`app/admin/(panel)/maksed/page.tsx:29`).
- **The re-send rule** (`liveAttempt`, `server/payments/start.ts:73-100`; used at :184): the same registration, kind, invoice and amount within 30 minutes re-sends the same reference, and Montonio overwrites its unpaid order. Anything else inserts a new row (:203-208), and the old row stays `pending` until ABANDONED or the daily check.
- **Double payments today:**
  - two paid orders of the same row raise „Topeltmakse“ and the money is not counted (`server/payments/settle.ts:176-185, 441-500`);
  - two different rows paid beyond the price are recorded, with an „Ülemakse“ alert (:255-271).
- `paid()` accepts `pending|failed → paid` (:217).
- `held` means only an amount or currency mismatch (:389-398).
- The Montonio client has no cancel-order call (`server/payments/montonio.ts:234-242`).

**Requires**
- **A migration:** `ALTER TYPE payment_status ADD VALUE 'replaced'` (precedent `app/drizzle/0001_client_accounts.sql:1`), plus `payments.check_reason text` and, for B6, `payments.checked_at`.
- **`startRegistrationPayment`:** after `lockForPayment`, mark this registration's other `pending` rows `replaced`.
- **`paid()`:** accept `replaced`. Under the lock, `paid_cents ≥ price` → `held` with the reason „Topeltmakse — tagasta“; otherwise count it.
- **`listPaymentsOf`:** hide `replaced` on the Raha card. Give it a label or filter in Maksed.
- **`pendingToCheck` and `expireStalePending`** select only `pending` (`db/queries/payments.ts:179-193, 208-224`). They must also ask about `replaced` rows, or a replaced order that was paid while its webhook failed is never found.
- **`failPayment`** fails only `pending` (:116). A later ABANDONED must also be able to close a `replaced` row.

**Conflicts**
- **Instalments.**
  - A järelmaks attempt holds the seat for 60 minutes, and „The start records the attempt's method“ (`docs/…/2026-10-20-instalments-design.md:52-53`).
  - The account offers järelmaks *and* a bank payment of the full price (:72).
  - So B22 marks a running Inbank application `replaced` when she tries the bank. A loan signed later becomes „Topeltmakse — tagasta“, and that refund goes through Montonio and Inbank (D7). That is correct, but say it in both specs.
  - Decide whether a newer bank order may replace an open järelmaks order inside its 60 minutes.
- **Migration numbering:** both pieces touch `start.ts` and `settle.ts`, and instalments claims **0017**. Build B22 after instalments.
- **Rollback:** an additive enum value is safe for the schema. But rows written with `replaced` make older code see an unknown status (a label lookup). `docs/deploy.md:115` assumes additive means safe, so note this in the deploy section.

**Risks**
- „Asendatud“ is local only: the old order stays payable at Montonio until its window ends.

**Size L. Dependencies:** instalments (0017) first, then B14 (the kontroll definition), then B6 (the badge).

---

## Contract texts on the draft layer (Seaded → „Lepingud ja tingimused“, „Avalda uus leping“)

**Today: four texts, two save paths**
- **Privaatsus and Õppetingimused:** `pagePart("privacy")` and `pagePart("terms")` (`server/admin-site.ts:476-477`). No version, and nobody accepts them.
- **E-koolituse leping:** the `course_terms` part (`server/admin-site.ts:484-501`), in the **same** `SettingsEditor` form and „Salvesta“ as Kontakt (`components/admin/SettingsEditor.tsx:136-164, 179`).
- **Kontaktkoolituse leping:** its own form `ContractTexts.tsx:54-155` with „Salvesta lepingud“ (:129) → `saveContractTextsAction` (`server/actions/admin-contracts.ts:39-52`) → `saveContractTexts` (`server/contracts.ts:446-461`), under an advisory lock.
- **Storage:**
  - texts are `pages` rows (`db/schema.ts:168`);
  - versions are the settings `courseTermsVersion` (`domain/course-terms.ts:8`) and `contractContactVersion` (`domain/contract.ts:44`);
  - frozen copies are `contracts` rows (`db/schema.ts:783-812`);
  - e-course acceptances are `terms_acceptances` (`db/schema.ts:313-318`).
- **Every changed save publishes a new version:** contact `server/contracts.ts:457-458`; e-course `server/admin-site.ts:496-499`, with `nextTermsVersion` (`domain/course-terms.ts:17-24`: "a save always asks the students who accepted the old text again").
- **Re-acceptance:**
  - **E-course:** the gate on the next opening (`termsState`, `server/client-data.ts:447-462, 521-530`). No mail.
  - **Contact:** no automatic re-ask. Maria presses „Saada leping kinnitamiseks“ (`server/contracts.ts:332-343`).
  - **Forms and carts** send the version they showed; a mismatch is refused (`shownVersionHolds`, `server/contracts.ts:138-141`).
- **Fallback:** until `contract_contact` is written, the contact contract **is the Õppetingimused text**, with the version `terms:<hash>` (`server/contracts.ts:100-104`). Editing Õppetingimused is therefore already a contract change.
- **Placeholders:** `nimi, e-post, koolitus, toimumine, hind, ettemaks` (`domain/contract.ts:47`), matched exactly on one line (:50, :57-59). Today they are a static list (`ContractTexts.tsx:29-43`).

**Recorded rules**
- R6: „a student must never accept a text she did not see“ (`docs/…/2026-10-17-contracts-design.md:29`).
- R11: „a changed title is a changed contract, and every student is asked once more at the gate“ (:44).
- D3: „Later edits of the template … never change an accepted contract“ (:59).
- D4: „E-course students re-accept through the existing version bump when Maria changes the text“ (:65).
- The card's own words: „Kui salvestad muudetud teksti, peab iga õpilane uuesti nõustuma.“ (dict `i18n/dict/admin.ts:1896`).

**Conflict.** Autosave wired to today's save gives one published version per pause in typing:
- every active e-course student is gated again;
- superseded contracts and acceptances pile up;
- open forms and carts refuse;
- course pages and carts are revalidated on every tick (`server/cache-targets.ts:83-93`).

**Reconcile**
- Autosave writes **only to a draft store**: B2's table, or a `settings` key such as `legalDrafts`, which needs no migration. Do not use `pages` rows: `getHomeData` loads every `pages` row (`db/queries/public.ts:137`).
- „Avalda uus leping“ calls the existing save functions unchanged, so the version bump, lock and revalidation stay in one place.
- This must cover **`course_terms` and `terms`**, not only the contact text. `terms` feeds the contact contract while `contract_contact` is empty.

**Requires**
- **Count for the ConfirmPanel:** active accesses across e-courses, `revoked_at is null and expires_at > now` (as `activeAccess`, `server/client-data.ts:417-423`). They are asked at their next opening, not at once.
- **Contact:** „kehtib uutele registreeringutele“ is true. Optionally also count open asks (`contract_requested_at` not null), whose „Kinnitan“ will show the new text.
- **Privaatsus** has no consequence, so it does not need „Avalda uus leping“. Decide whether it still drafts.
- **Chips that insert at the cursor:** `I18nInput` exposes no ref or selection (`components/admin/I18nInput.tsx:34-113`). Add a ref or callback, and insert in the language being shown.
- **The sample PDF** (`ContractTexts.tsx:136-150`) already posts unsaved text. Point it at the draft.

**Ambiguities**
- **Count accesses or distinct students?** Include completed courses?
- **Two admins on the same draft:** use the part version.
- **„Loobu“ for a legal draft.**

**Size L. Dependencies:** B1, B2 (or its own store), ConfirmPanel.

---

## Server-side changes the hand-off implies but does not number

These change server behaviour, and HO Part 1 says such changes go on the B list. They should be ruled on too.

1. **Kalender drawer (HO B3).** `saveSessionForm` today (`server/admin-content.ts:243-296`):
   - allows capacity below the confirmed count;
   - allows changing the course after bookings (registrations keep their own `course_id`, `db/schema.ts:88-89`, so the two can diverge);
   - has no stale check;
   - flips cancellation with no effect on registrations.

   The hand-off adds two server refusals: capacity < confirmed, and the course locked once booked. It also adds autosave, which a capacity being typed ("1" before "12") would hit. Commit capacity on blur. **M.**
2. **„Saada hinnang“ without confirmation (HO A4).** The completion spec says „One confirmation, then the snapshot and the mail.“ (`docs/…/2026-10-13-ecourse-completion-design.md:176`; `components/admin/AssessmentSend.tsx:3`). „Kinnita kõik“ approves every unset point, including photos Maria has not opened. Rule on both. **S.**
3. **Popup „Lehel näidatakse“ instant** (HO C4): a separate action and part. See B5. **M.**
4. **„Maksmine“ merge (HO B4).**
   - This is a UI merge only: invoices already read the bank details from `prepayment` (`server/invoices.ts:96-98`; invoices D2, spec:20).
   - The two parts save differently: `saveParts` versus the invoice action with its number lock.
   - Say on the card that issued invoices keep their frozen IBAN.

   **S–M.**
5. **The number fields of InvoiceSettings and CertificateSettings autosaving.** A half-typed prefix or number could apply to an invoice issued in between (D7, `server/invoices.ts:778-785`; `server/certificates.ts:210-217`). Commit on blur. **S.**
6. **The invoice buyer („Salvesta saaja“ removed, HO Part 1 §3.1).** See the save-mechanisms section: commit on blur. **S.**
7. **`moveCourseTo(id, index)`.** Today `moveCourse` swaps neighbours under `FOR UPDATE` and renumbers (`db/queries/admin.ts:173-183`). Add the splice in the same transaction, and keep ↑/↓ as the keyboard path. **M.**
8. **Maksed:**
   - **CSV „Laadi alla (CSV) · {kuu aasta}“:** Maksed has no month filter; add `?kuu=` (`parseMonth`, `domain/invoice.ts:300`). Choose the separator: `;` like the invoice CSV (`domain/invoice.ts:315-361`), not `toCsv`'s commas (`server/csv.ts:13-22`).
   - **„Montonios ↗“:** no merchant URL pattern exists in code or docs (`docs/deploy.md:199` gives only the menu path), and sandbox and production differ. Confirm the URL with Montonio.

   **M.**
9. **Subscribers CSV of the current filter:** today it exports all (`server/admin.ts:73-80`). **S.**
10. **Päringud: „Kontakt“ includes e-learning interest.** That is `contact` with `payload.intent='purchase'` (`db/queries/admin.ts:483-486`). A filter change only. **S.**
11. **„Lisa arvustus“ as a drawer with an explicit create.** A manual review is published as soon as it is created (`server/reviews.ts:133-134, 156-161`; reviews spec:63). Keep the create explicit: never autosave a new review. **S.**
12. **The newsletter editor's autosave.** Every save bumps `updatedAt` (`server/newsletter-campaigns.ts:116`), and the send confirmation refuses `changed` when it moved (:414; campaigns spec:107). A blur-save fired by pressing „Saada kõigile“ would make the send refuse.
    - Flush before `prepareSend`.
    - Don't bump `updatedAt` when nothing changed.

    **S.**
13. **The newsletter wording.**
    - The busy text recorded in the spec, „Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.“ (newsletter-simple spec:59; dict :1620), promises a queue. The code refuses (`busy`, `server/newsletter-campaigns.ts:378`). The hand-off's text matches the code; amend the spec.
    - „Kampaaniad“ → „Kirjad“ amends newsletter-simple D4 (:9).

    **S.**
14. **Sidebar breakpoint 640 → 900 px.** JS uses `WIDE = "(min-width: 641px)"` (`components/admin/Sidebar.tsx:25`), and CSS sets 190 px at 900 (`components/admin/Shell.module.css:111-114`). The comment at dict :84 already says 900. **S.**

---

## Conflicts to rule on (most important first)

1. **Legal and contract texts must be draft-only, with explicit publishing.**
   - Rule: contracts R6 (`docs/…/2026-10-17-contracts-design.md:29`), R11 (:44), D4 (:65); `domain/course-terms.ts:17-18`.
   - HO says contract texts use the draft layer, but „every card autosaves“ also covers `course_terms` and `terms` in SettingsEditor. Rule: `privacy`, `terms`, `course_terms` and `contract_contact` all draft-only, published with „Avalda uus leping“.
2. **B4 rewrites four money rules.**
   - „Maria's manual "amount received" form stays.“ (payments spec:322-323).
   - „Typing „Laekunud summa“ by hand still works“ (invoices spec:30).
   - Manual confirmations take no seat check, „That is accepted“ (`db/queries/seats.ts:42-47`).
   - R10: a receipt's undo keeps Laekunud summa (`server/invoices.ts:308-312`), so the hand-off's undo story fails.

   Also decide refunds or negative amounts, idempotency, and the unpaid-request double charge.
3. **"Unpublished saves straight to the row" versus live readers.**
   - Rule: phase3a spec:69 „unpublished courses still work“; frozen points (ecourse spec:78), test copies (:120), completion never cleared (:146).
   - Proposal: draft whenever the item has live readers.
4. **B18 versus live lesson rows and media.**
   - Rule: `server/actions/admin-lessons.ts:23-24`; `components/admin/LessonsEditor.tsx:19-21`; videos keyed by row (`db/schema.ts:532-554`).
   - Proposal: new lessons are real rows created `hidden`; only text goes in the draft; deletes are re-checked at publish.
5. **B11 versus „No bulk button (my call: each one is a real number).“** (invoices spec:72). This needs Dim's yes and a spec amendment.
6. **B20 versus no account enumeration** (`server/login.ts:14`; dict :48). Choose client-side counting (a) or a uniform per-address limit (b).
7. **A4 drops the „Saada hinnang“ confirmation and adds „Kinnita kõik“,** versus completion spec:176 „One confirmation, then the snapshot and the mail.“
8. **B13 versus „newer text is never overwritten“** (protocols spec:104). Allow overwriting only by explicit press, keeping the overwritten text in the notice.
9. **B22 versus instalments.** Both use migration 0017 and touch `start.ts` / `settle.ts`. An Inbank application can be marked replaced by a bank attempt (instalments spec:52-53, :72). Order: instalments first.
10. **The freshness contract** „next request after "Salvesta" shows the change“ (vercel-move spec:18). Restate it for drafts and „Avalda“.
11. **The preview assumption.** The `mslab_preview` cookie only passes the gate (`lib/preview-cookie.ts:1-6`), and ISR pages ignore `?mustand=1`. Use `draftMode()` or an admin-only preview route.
12. **B6's Hindamine refresh** versus „The open page is NOT refreshed“ (`server/actions/admin-assessment.ts:72-76`).
13. **The number series under autosave** (invoices D7 spec:36; `taken` checks). Commit on blur, and B21's December logic.
14. **Testimine in the menu** versus test-page D1 „It is not in the main menu“ (spec:21; `docs/deploy.md:326`). Q5 decides it: amend the docs.
15. **The newsletter's send guard** (`updatedAt`, campaigns spec:107) versus autosave. Flush first, and don't bump on no-op saves.
16. **B5 versus reviews D6** (a student's withdrawal is a hard delete, reviews spec:81), and the „Seda ei saa tagasi võtta“ texts.
17. **Wording recorded in specs:**
    - „Lukusta ja saada kõik“ (protocols spec:107);
    - „Uudiskiri → Kampaaniad“ (newsletter-simple D4:9);
    - the newsletter busy text (spec:59), where the hand-off is the more accurate;
    - „Õpilastele nähtav“ versus „Peida“ / „Näita õpilastele“.
18. **B21's sentence about certificates** contradicts certificate D2 (they already restart yearly). Read it as "unchanged".
19. **B15 changes a local-by-design decision** (TestReview.tsx:15-16; a code comment, not a spec rule). It also needs a separate column, because `review` is what the student sees (`server/test-attempts.ts:114`).
20. **B10's money and order loose ends.** After a cancel, unpaid invoices and open Montonio orders stay live (`docs/deploy.md:374`; settle). Decide whether B10 cancels the invoices too.
21. **The B4 radio "manual override"** must not get the seat check (keep `seats.ts`'s accepted rule for status changes). And can it un-cancel?
22. **The Kalender server refusals** (capacity below confirmed, course locked once booked) are new rules not on the B list.

---

## Migrations needed

**0017 is taken.** The instalments spec claims it (`docs/…/2026-10-20-instalments-design.md:62`: `payment_choice` gains `financing`, plus the `financing` setting). The UX pass therefore starts at **0018**. Per `docs/deploy.md:103-115`: apply on Railway by hand before the deploy, keep everything additive, and update the migration count in deploy.md.

**Required: 5**

| # | For | Change |
|---|---|---|
| 0018 | B2, B18, and the contract texts (unless those use a `settings` key) | new table `content_drafts(entity text, entity_id int, part text, value jsonb, base_version text, version int, updated_at, updated_by)`, unique (entity, entity_id, part) |
| 0019 | B4 | new table `manual_payments(id, registration_id fk, amount_cents, paid_on, method, invoice_id fk null, request_key unique, created_at, created_by)` |
| 0020 | B5 | `lesson_files.removed_at timestamptz null` (plus an index if wanted) |
| 0021 | B15 | `test_attempts.review_draft jsonb null`, `review_draft_for timestamptz null`. Skip it if B15 stores its draft in 0018's table, which brings the count to 4. |
| 0022 | B22, plus B6's badge clearing | `ALTER TYPE payment_status ADD VALUE 'replaced'`; `payments.check_reason text not null default ''`; `payments.checked_at timestamptz null` |

**Optional: up to 3, each avoidable**
- **B19:** `auth_tokens.return_to text`. Avoidable by putting the path on the verify URL.
- **B1:** `version integer` columns on `lessons`, `course_modules`, `course_sessions`, and on `registrations` for the note. Avoidable with content hashes (`lib/version.ts`).
- **B7:** `create extension unaccent` for diacritic-insensitive search. Avoidable: plain ILIKE.

**No migration:** B3, B6 (apart from `checked_at` in 0022), B8, B9, B10, B11, B12, B13, B14, B16, B17, B20 (KV), B21 (the settings JSON). Also B4's receipt-undo fix: `paid_adds` and `due_at` already exist (`db/schema.ts:745, 749`).

---

## Suggested build order

**Phase 0: rulings first.** Items 1–9 of the conflicts list, before any code. Then amend the specs in the same commit as the code they change (the house rule, and `docs/deploy.md` sections).

**Phase 1: shared components and small server changes** (no migrations; each its own commit with `testplan.json` marks `"markedAt": "deploy"`):
1. The client components ConfirmPanel, UndoBar, SaveStatus, ListToolbar and list-table changes, and the glossary texts.
2. Sidebar and Shell: groups, the 900 px breakpoint, the footer.
3. B14, then B6 as a single-query `adminCounts` with Tagasiside, Testimine and Protokollid (the Maksed badge waits for 0022 or ships without "voided" clearing).
4. B8, then B16.
5. B10, B9, B17.
6. **B21, before 1 December 2026.**
7. B20, B12, the Päringud toggle, review undo.

**Phase 2: autosave base (B1, B13, B3)**
- Route-handler transport, `useAutosave` extracted from `protocol-autosave.ts`, and `useLeaveGuard` replacing `confirmClose`.
- Migrate first the editors with no publish semantics: the Kalender drawer, the registration note, Testimine, the newsletter editor (with the `updatedAt` fix), and the non-legal Seaded parts (number fields on blur).
- Then port the protocol screen to the shared engine, with B13's „Taasta minu tekst“.
- Then B3 per editor as each one moves.

**Phase 3: draft layer (0018)**
1. B2 infrastructure: the table, publish/discard, `draftMode` preview, PublishBar.
2. Popup, home, trainer and practice.
3. Posts.
4. Courses: split the course into parts, apply the "live readers" rule.
5. B18: hidden new lessons, text drafts.
6. Contract texts with „Avalda uus leping“.

**Phase 4: money (after the instalments piece ships with 0017)**
1. B4 (0019), including R10's receipt-undo branch and the unpaid-request check.
2. B11.
3. Maksed search and CSV.
4. B22 (0022), with the daily check covering `replaced`.
5. Finish B6's Maksed badge with `checked_at`.

**Phase 5: the rest**
- B5's server parts (0020, lazy purge plus the daily sweep), then UndoBar wiring for list editors (client restore) and the popup's own part.
- B15 (0021).
- B7 search on all lists.
- B19 (pairs with the `signedOut` state).

**Dependencies at a glance**
- B1 → B3, B13, B2 → B18, contract texts.
- B8 → B16.
- B14 and B4 → B6's Maksed badge; B22 → `checked_at` → the badge clears.
- Instalments (0017) → B22.
- ConfirmPanel → B9, B10, B11, B17, contract texts.
- UndoBar → B5, B12.
- B1's 401 state ↔ B19.
- B21 has none, but a date deadline.

**Rough sizes**
- **S:** B9, B10, B13 (after B1), B14, B16, B17, B21.
- **S–M:** B11, B20.
- **M:** B3 (M–L), B6, B7, B8, B12, B15, B19, B5's server parts.
- **L:** B1, B2, B4, B18, B22, the contract-texts draft, and B5 with all its UndoBar wiring.
