# Admin UX pass — design

This is the step after phase 4's six pieces and before the public launch. Dim's direction for the admin was: "very simple and usable … as simple as it gets", "fewest clicks, autosave".

The design was made in a design tool from the package of 20.10 (`.superpowers/ux-pass-package.zip`). Dim answered its questions Q1–Q5 and accepted all its behaviour changes B1–B22 there.

**Dim (21.10.2026): "The spec needs to be as it was designed and according to the design."** So the design is built as it is. This document adds only three things:
- which file wins where the design's own files disagree (§4);
- defaults where the design is silent, none of which adds anything to a screen (§5);
- how the code does it (§6).

Every rule from an earlier spec that the design changes is amended (§9).

## 1. Why

**The problems today:**
- The admin has eight ways to save.
- Closing a drawer or clicking the menu can drop typed text without a word.
- The daily work is spread over a flat menu of 16, and several pages have no menu entry.
- Maria works away from the desk a lot, on a phone or tablet on the course day.

**What the design does:**
- **One way to save:** autosave plus one status chip per screen.
- **Nothing typed is lost silently.**
- **Fewer clicks** for the weekly tasks.
- **A grouped menu with daily work first.**
- **A course day that works on a phone and an iPad.**

## 2. Sources

- **The design** is in `docs/superpowers/specs/admin-ux-pass/handoff/`.
  - `README.md` is the design's own build guide.
  - The `.dc.html` files are its prototypes, in four parts plus a deck and the sidebar. Open them in a browser from that folder. The stock photos are left out of the repo.
- **The analysis against the code** (21.10) is in `docs/superpowers/specs/admin-ux-pass/analysis/`. It has file:line maps:
  - `behaviours.md`: each B item against the code;
  - `strings.md`: every changed and new Estonian string, and where the design's files disagree;
  - `screens.md`: layout details the README leaves out, the Q&A, the parked list, and a screen → files map.
- **Dim's decisions in the design:**
  - **Q1:** published content saves to a draft and goes live with „Avalda muudatused".
  - **Q2:** money is recorded with an explicit „Lisa laekumine".
  - **Q3:** below 900 px the phone top bar is used.
  - **Q4:** the language switch has two modes, ET and RU.
  - **Q5:** „Testimine" is in the menu for every admin.
  - **B1–B22** are accepted.

## 3. What gets built

Everything in the design, in the README's order:
- §1 the global components;
- §2 the A screens;
- §3 the B screens;
- §4 the C screens;
- §5 the behaviour changes B1–B22 (B11–B22 each as its own commit, as the README asks);
- §6 the parked items as resolved there;
- §7 the tokens.

**Strings** are quoted exactly as the design writes them.

## 4. Where the design's own files disagree

- **D1. Which source wins:**
  1. the README;
  2. where it is silent, the desktop prototype;
  3. the phone prototype, for what only the phone shows (the top bar's page name, the badge sum on ≡, phone short forms);
  4. the notes in the prototypes last.

  `analysis/strings.md` §4–5 lists the 28 disagreements and the 21 double wordings. The outcome of each, by this order, is written in its „Outcome" column. Two examples:
  - The saved chip shows the ✓ the desktop mock draws.
  - „Saada hinnang · {k} kinnitatud" drops „, 0 paranda" when nothing is to fix, as the mocks draw it.

  Where the order cannot decide, the row says so, and Dim answers before the piece that needs it.
- **D2. B11–B22 are accepted.** The README's first page says B11–B20 are "still to decide". Its §5, parts 3 and 4, and the deck all say B1–B22 are accepted.
- **D3. Hüpikaken (C4). Dim (21.10): "As Part 4 draws it."** One popup, the newsletter sign-up with its discount code, with the two-state switch, the 8 s / once in 30 days line, and the „Reeglid" text Part 4 prints. The campaign-offer popup and the three-way choice go. The analysis that led to the question:
  - **The README:** "„Lehel näidatakse" choice is instant with UndoBar; one preview that follows LangSwitch; the „Reeglid" text stays".
  - **The Part 4 desktop mock** (the next source where the README is silent) draws:
    - one popup, the newsletter sign-up with a discount code („Pakkumine": Pealkiri, Tekst, „Soodustus (%)", „Kood kehtib (päeva)");
    - a two-state switch with „Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul";
    - the UndoBar „Hüpikaken peidetud.".
  - **Today** there are two popups (the campaign offer and the newsletter sign-up), a three-way choice, and 6 s once per visit.
  - **The conflict:** building the mock drops the campaign-offer popup and changes the public timing. Only a Part 3 note keeps the choice.
  - The route stays `/admin/kampaania` ("Routes don't change"). Part 4 prints `/admin/hupikaken`.
- **D4. The menu entry for the assessment screen.** The README highlights „Protokollid" for every `/admin/protokollid…` address. But the README's own A4 heading lists `?ligipaas=` (the practical-work screen) under Hindamine, and Part 2's practical-work frame draws the menu with „Hindamine" active. So that address highlights „Hindamine", and `?sessioon=` and `?registreering=` highlight „Protokollid".
- **D5. Focus in Tagasiside** stays on the row after an action, as the README says; Part 4 says it moves to the next card.
- **D6. Certificate numbers. Dim (21.10): "Keep the yearly restart."** Certificates are unchanged. The analysis that led to the question:
  - **The design (B21):** "Certificates keep their running number (no yearly reset) unless Maria asks."
  - **Today** they do restart each year: „MS LAB {year}-{nn}" (certificate D2).
  - **The conflict:** the sentence reads as if it describes today. Read literally, it asks to stop the yearly reset.
- **D7. The loading rows appear after 400 ms, not 300 ms** (built in piece 1, measured on the production build). The README (§1.10) says the grey rows of `(panel)/loading.tsx` show "after 300 ms". React 19 holds a replaced Suspense fallback for 300 ms before it shows the content that took its place, and a delay of exactly 300 ms made the rows flash grey for an instant on pages that answered in about that time (0 of 10 flashes at 400 ms; the new page was on screen after 328–395 ms). 400 ms still satisfies "shown after 300 ms" (later, never earlier): the rows do not appear for a page that answers inside the first 300 ms. Under `prefers-reduced-motion` the delay stays, and the rows appear in one step. A consequence Dim should know: because of the same hold, every menu click shows the new page at about 330–390 ms, where before it came as soon as the server answered. Removing `(panel)/loading.tsx` brings the speed back and takes the grey rows away.
- **D8. Registreerimised and Maksed keep the 980 px card switch until their screens in piece 2.** The shared list table now becomes cards below 760 px of its card, as the design draws it. Registreerimised (9 columns) and Maksed (8 columns) do not fit a card of 761 to 979 px and have no scrollbar to fall back on, so the two keep the old switch at 980 px (`stackAt980` in `list-table.module.css` and their own stylesheets) until their screens (A2 and A6), which drop columns, are built in piece 2; then the modifier and the two page rules go. Until then those two lists turn into cards about 220 px earlier than the design draws.

## 5. Where the design is silent

These are defaults for the builder. None of them adds a control, a field, a text or a screen.

- **S2. Draft rows for new modules and lessons.**
  - On a published course, a new module or lesson needs a real row, because videos and files hang on it. That row is kept out of the public page and the students' outline until „Avalda muudatused" (a flag, §7).
  - Everything else is drafted, as B18 and §1.3/§1.8 say. That includes a lesson's file and video references: the upload goes to storage at once, and the reference waits in the draft.
- **S3. Text the design leaves unwritten** is asked from Dim before the piece that needs it. Nothing is invented. The places:
  - the „Lisa laekumine" result when the payment stays under 50 %, when no receipt is made, and when the seller data is missing;
  - the screen-reader labels of the new badges;
  - an access that ran out by date;
  - the facts line of the Individuaal, Praktika, Ootenimekiri and Muutmine request cards;
  - the „Kustuta mustand" question (B17);
  - UndoBar texts the design doesn't draw (a lesson file's „Eemalda", list-row removals);
  - the fallback for S6.
- **S4. „Saatsid juba 3 linki…" (B20)** is counted per typed address, allowed or not, so the message reveals nothing about which addresses are admins. „saada uuesti 1 minuti pärast" is shown as the design's advice. No rule is built behind it.
- **S5. „Saada protokoll {eesnimi}le".** The ending follows the name: +„le" after a vowel, +„ile" after a consonant, for Latin and Cyrillic names alike.
- **S6. „Töötlemisel {n}%"** uses Bunny's encode progress. The text for when Bunny gives none is in S3.
- **S7. The Maksed ja arved badge** counts exactly what the design lists: unbilled paid payments, `kontroll` payments, and voided-after-paid ones.
- **S8. A new post** („Lisa postitus +") gets a unique placeholder slug, so two new posts don't collide. The slug follows the title until the post is first published.

## 6. How the code does it

The README names three mechanisms that the code does differently, with the same outcome:
- its `save{Thing}Part` actions become route handlers (C1);
- its `draft_json` becomes the `content_drafts` table (§7), because the home, trainer and popup parts span several tables, and a draft on `courses` would travel with the public course row;
- its "preview cookie + `?mustand=1`" becomes `draftMode()` (C3).

- **C1. Autosave goes through route handlers** under `/api/admin/…`.
  - Server actions can't send with `keepalive` on `pagehide`, and they redirect when the session has ended. A route answers 401, and the chip shows the design's signed-out state.
  - `useAutosave` generalises `protocol-autosave.ts`, whose constants already match the design.
- **C2. `Shell` moves into `app/admin/(panel)/layout.tsx`,** so that:
  - the design's `loading.tsx` and `error.tsx` keep the sidebar;
  - `useLeaveGuard` watches every page;
  - the badges are read once per navigation.
- **C3. Preview uses Next's `draftMode()`** through an admin-only route. The `mslab_preview` cookie only passes the coming-soon gate, and cached pages ignore `?mustand=1`.
  - Public pages read drafts only in draft mode.
  - The phone's „Loobu muudatustest" on the preview page (Part 4) is shown only in draft mode.
- **C4. The newsletter editor flushes before „Saada kõigile".** A save that changes nothing does not move `updatedAt`, so the send guard keeps working.
- **C5. Naming.** The new page-level switch is `LangSwitch`. The per-field one exported from `I18nInput.tsx` is renamed.
- **C6. Legal texts (the design's contract texts).** These are Privaatsus, Õppetingimused, E-koolituse leping and Kontaktkoolituse leping. Publishing one makes a new contract version, exactly as a save does today. Students who must accept again are counted as the contracts spec counts them.

## 7. Data

**Four migrations, all additive:**
- **A drafts table** for B2, B18, the contract texts and B15: `content_drafts (entity, entity_id, part, value jsonb, base_version, version, updated_at, updated_by)`, unique on (entity, entity_id, part).
- **A "not yet published" flag** on `course_modules` and `lessons`, for S2.
- **`removed_at`** on the tables whose rows get an UndoBar removal (B5): lesson files and manual reviews. Rows are purged after 10 s, plus the daily sweep. Each table gets its column in the piece that adds its UndoBar.
- **On `payments`:** status `replaced` (B22) and `check_reason`, which holds „Topeltmakse — tagasta".

**Numbering:** they take the next free numbers when built. The instalments spec reserved 0017, but that work waits on Montonio, so whichever ships second renumbers. Each migration is applied on Railway before the push (`docs/deploy.md`).

## 8. Delivery

The design's order is global components first, then the A screens, then B, then C. That makes four pieces. Each piece gets its own plan, the subagent build, a final review, and a deploy to mslab.ee, still behind the gate.

1. **Global components (README §1):**
   - the sidebar with its groups and badges (B6), and Shell (C2). The menu's „Protokollid" row opens the new index, so the index and its one-session shortcut (B8, B16, from A3) come here too;
   - `useAutosave`, SaveStatus, `useLeaveGuard` with the Drawer change;
   - ConfirmPanel and UndoBar;
   - the draft layer with PublishBar (C3);
   - LangSwitch with I18nInput, ListToolbar and the list tables;
   - the glossary.

   Migration: the drafts table.
2. **The A screens (§2):** A1–A7, with B4, B7, B10, B11, B12, B14, B15 and B22. Migration: `payments`.
3. **The B screens (§3):** B1–B5, with B9, B17, B18 and B21. Migrations: the module and lesson flag, and `removed_at` on lesson files.
4. **The C screens (§4):** C1–C8, with B19 and B20. Migration: `removed_at` on reviews.

**B21 goes first. Dim (21.10): "Yes, first."** Invoice numbers per year belong to the Seaded screen in piece 3. But the server part must be live before 1 December 2026, because today a December invoice silently erases a next-year number preset. So B21 is the opening commit of piece 1, and the rest of the Seaded screen comes with piece 3.

**In every piece:**
- The test plan follows the code (standing rule). Each behaviour change updates `src/data/testplan.json` with `redo`, `reworded` or `new` and `markedAt "deploy"`. Run the stamp before each push, then the test-plan tests again.
- `docs/deploy.md` and `docs/launch-checklist.md` follow the code.

## 9. Earlier specs the design changes

Each is amended in the commit that changes its rule:
- **contracts:** the contract texts are drafts and go live with „Avalda uus leping" (B4 screen).
- **payments and invoices:**
  - the typed „Laekunud summa" is removed (B4);
  - undoing a receipt's payment („Võta tasumine tagasi") lowers „Laekunud summa", because the design undoes a wrong entry that way. This replaces invoices ruling R10.
  - batch invoices (B11) replace "No bulk button".
- **protocols:** „Lukusta ja saada kõik" becomes „Saada kõigile ({n})", and „Taasta minu tekst" writes the local copy back (B13). This replaces "newer text is never overwritten".
- **e-course completion:** „Saada hinnang" is the informed button, with no panel, plus „Kinnita kõik".
- **test page:** „Testimine" is in the menu (Q5). Its filters are „Olek" (Kõik / Avatud / Viga / Läbitud) and „Kes" (Mina / Kõik). A check is „Läbitud" / „Viga".
- **newsletter-simple:** „Kampaaniad" becomes „Kirjad", and the send's ConfirmPanel changes.
- **reviews:** undo and focus (C6 screen).
- **the sign-in:** the new sent text and rate-limit message (C8, S4).
- **vercel-move:** the freshness rule becomes "the next public request after „Avalda muudatused" shows the change".
- **instalments:** its migration number, and B22's „Asendatud" covers a järelmaks attempt too.

## 10. What changes for Maria and Dim by following the design

These are listed so nobody is surprised on the test page. They are not changed:
- A cancelled registration can't be put back from the drawer. The status pills are „Ootab ettemaksu" / „Kinnitatud" only.
- A payment added with „Lisa laekumine" and no receipt has no undo. The design undoes money through the receipt.
- „Lisa laekumine" with the receipt ticked makes a new „Juba tasutud" invoice even when a payment request („Maksmiseks") is open. Part 2 draws exactly this case. The request stays „Tasumata", and the student's „Maksa" still offers it until Maria cancels it with „Tühista arve".
- „Saada hinnang" with every point approved completes the course, issues the certificate and mails the student, with one press.
- An unpublished e-course that already has students saves straight to the record. Those students see an edit at once.
- **Hüpikaken (D3):**
  - There is one popup, the newsletter sign-up with a discount code. The campaign-offer popup is gone.
  - On the public site it opens after 8 s, once in 30 days. Today it opens after 6 s, once per visit.
- **On „Testimine":**
  - The „Muudetud" filter and „Jäta vahele" are gone.
  - „Kes" is „Mina" / „Kõik" instead of Kõik / Maria / Dim / Koos.
  - The check rows draw no „Uuesti testida" / „Sõnastus muutus" / „Uus" tag. A check the deploy marks for re-testing simply shows as „Avatud" again.
- The sign-in's sent text reads „Saatsime lingi aadressile {email}. See kehtib 15 minutit." for any address.

## 11. Out of scope

What the design leaves out, as its §6 lists:
- shared-tablet attribution;
- the e-course contract copy button;
- „Võta number paberile";
- the test plan's content;
- the mail logo in dark mode;
- `TestPlan.tsx`'s size, Telegram capping and stale plan text;
- the student and public side.

## 12. Left to the builder

- How the components are split into files, and CSS beyond the design's numbers.
- One generic autosave route or one per editor (C1).
- How each editor's fields map to draft parts.
- Nothing else. The texts of S3 go to Dim before the piece that needs them. Piece 1's eight texts were approved on 21.10: four badge labels and four reasons for the leave guard.
