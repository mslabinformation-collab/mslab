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
- §5 the behaviour changes B1–B22, each as its own commit;
- §6 the parked items as resolved there;
- §7 the tokens.

**Strings** are quoted exactly as the design writes them.

## 4. Where the design's own files disagree

- **D1. Which source wins:**
  1. the README;
  2. where it is silent, the desktop prototype;
  3. a phone short form only where a phone prototype draws one;
  4. the notes in the prototypes last.

  `analysis/strings.md` §4–5 lists the 28 disagreements and the 21 double wordings. Each is settled by this order.
- **D2. B11–B22 are accepted.** The README's first page says B11–B20 are "still to decide". Its §5, parts 3 and 4, and the deck all say B1–B22 are accepted.
- **D3. Hüpikaken (C4) is built from the README.**
  - The „Lehel näidatakse" choice stays, is instant, and has an UndoBar.
  - Each popup has one preview, which follows LangSwitch.
  - The „Reeglid" text stays.

  Part 4 draws a single popup with the fields „Soodustus (%)" and „Kood kehtib"; the README does not, so they are not built. The route stays `/admin/kampaania`, as the README says ("Routes don't change"); Part 4 prints `/admin/hupikaken`.
- **D4. The menu entry for the assessment screen.** The README highlights „Protokollid" for every `/admin/protokollid…` address. But `/admin/protokollid?ligipaas=` is A4's practical-work screen, whose header the design gives as „← Hindamine". That address highlights „Hindamine"; `?sessioon=` and `?registreering=` highlight „Protokollid".
- **D5. Focus in Tagasiside** stays on the row after an action, as the README says; Part 4 says it moves to the next card.
- **D6. Certificate numbers stay as they are** (B21's "keep their running number"). Today they restart each year (certificate D2), and nothing changes.

## 5. Where the design is silent

These are defaults for the builder. None of them adds a control, a field or a screen.

- **S1. „Lisa laekumine" when a payment request is open.** If the registration has an unpaid request invoice („Maksmiseks"), the panel's receipt option marks that invoice paid (today's `markInvoicePaid`) instead of making a second invoice. Otherwise the student's „Maksa" would still charge it. The panel looks as designed.
- **S2. Lesson media on a published course.** A video or file belongs to its lesson row, so an upload or removal acts on the row at once. On a course in a draft:
  - a new module or lesson is a real row, kept out of the public page and the students' outline until „Avalda muudatused" (a flag, §7);
  - everything else in the course, modules and lessons is drafted, as B18 says.
- **S3. Text the design leaves unwritten.** The builder writes it in the design's style, marked Draft, and Dim sees it on the test page. The places:
  - the „Lisa laekumine" result when the payment stays under 50 %, when no receipt is made, and when the seller data is missing;
  - the screen-reader labels of the new badges;
  - an access that ran out by date;
  - the facts line of the request cards.
- **S4. „Saatsid juba 3 linki…" (B20)** is counted per typed address, allowed or not. The message then reveals nothing about which addresses are admins. The 1-minute wait in the sent text („saada uuesti 1 minuti pärast") is built as a rule.
- **S5. „Saada protokoll {eesnimi}le".** The ending follows the name: +„le" after a vowel, +„ile" after a consonant, for Latin and Cyrillic names alike.
- **S6. „Töötlemisel {n}%"** uses Bunny's encode progress. Where Bunny gives none, it shows „Töötlemisel…".
- **S7. The Maksed ja arved badge** counts what the design lists. A „Tühistatud pangas" payment counts for 14 days, the window the daily check already watches, because there is nothing that marks it handled.
- **S8. A new post** („Lisa postitus +") gets a unique placeholder slug, so two new posts don't collide. The slug follows the title until the post is first published.

## 6. How the code does it

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
- **`removed_at`** on the tables whose rows get an UndoBar removal (B5). Rows are purged after 10 s, plus the daily sweep.
- **On `payments`:** status `replaced` (B22) and `check_reason`, which holds „Topeltmakse — tagasta".

**Numbering:** they take the next free numbers when built. The instalments spec reserved 0017, but that work waits on Montonio, so whichever ships second renumbers. Each migration is applied on Railway before the push (`docs/deploy.md`).

## 8. Delivery

The design's order is global components first, then the A screens, then B, then C. That makes four pieces. Each piece gets its own plan, the subagent build, a final review, and a deploy to mslab.ee, still behind the gate.

1. **Global components (README §1):**
   - the sidebar and Shell (C2);
   - `useAutosave`, SaveStatus, `useLeaveGuard` with the Drawer change;
   - ConfirmPanel and UndoBar;
   - the draft layer with PublishBar (C3);
   - LangSwitch with I18nInput, ListToolbar and the list tables;
   - the glossary.

   Migrations: the drafts table, and `removed_at`.
2. **The A screens (§2):** A1–A7, with B4, B6, B7, B8, B10, B11, B12, B14, B15, B16 and B22. Migration: `payments`.
3. **The B screens (§3):** B1–B5, with B17, B18 and B21. Migration: the module and lesson flag.
4. **The C screens (§4):** C1–C8, with B19 and B20.

**B21 goes first, as the opening commit of piece 1.** Its server part, invoice numbers per year, must be live before 1 December 2026: today a December invoice silently erases a next-year number preset. Its Seaded line comes with B4 in piece 3.

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
- „Saada hinnang" with every point approved completes the course, issues the certificate and mails the student, with one press.
- An unpublished e-course that already has students saves straight to the record. Those students see an edit at once.
- On „Testimine", the „Muudetud" filter (the deploy's re-test marks) and „Jäta vahele" are gone.
- The sign-in's sent text reads „Saatsime lingi aadressile {email}." for any address.

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
- The Draft texts of S3.
