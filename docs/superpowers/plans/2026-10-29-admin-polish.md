# Admin polish before Maria's testing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every admin screen line up and fit at desktop and phone width (Part B), and make Testimine say plainly what is done and what is left (Part A), before Maria starts testing.

**Architecture:** Part B is CSS and small markup fixes in the shared admin components, from the audit of 29.10 (findings F1–F22); one fix per shared rule, no per-screen patches where a shared rule is the cause. Part A changes the Testimine page and lets a save remove an answer (Dim 29.10).

**Tech Stack:** Next.js 16 App Router, React 19, CSS modules, Drizzle + postgres.js, vitest + happy-dom, PGlite db tests, Playwright.

**Spec:** Dim's request of 29.10 (in chat): "Give admin a UI/UX pass, make sure buttons and everything is inline and nice … Make sure mobile works as well." Testimine: automatic results not visibly Läbitud/Viga; accidental Läbitud cannot be undone; steps hidden behind a toggle; a passed check disappears from the list; "needs to be simple and understandable — clear which tests are done and which need doing". The audit: `C:/Users/DMITRI~1.MAR/AppData/Local/Temp/claude/C--Users-Dmitri-MARKIT-source-repos-MSLab/4d4b1714-8042-48bf-9255-8160f9b36e85/scratchpad/admin-audit/report.md` (F1–F22, with file:line causes, screenshots and re-usable capture scripts in the same folder). Part A: Dim's answers of 29.10 (AskUserQuestion): undo = press the pressed half again + „Võta vastus tagasi“; an answered row stays until the filter changes, „Värskenda“ or reload; steps open on open checks; **Automaattest's result counts for us** — a check the automatic test passed is „Läbitud“ for Maria and Dim unless they answer it themselves (Tasks 4–5).

## Global Constraints

- Public site untouched: only admin styles/components (`app/src/components/admin/**`, `app/src/app/admin/**`), never `components/site/ui.module.css` or public pages.
- No new client-facing text in Part B. Part A's only new text: „Võta vastus tagasi“ (byte-exact, in `adminEt`).
- Phone = 390×844 and 375 px: no horizontal page scroll; every tappable control ≥ 40 px (44 px where it is today); desktop = 1440×900 and 1280×800.
- A hand-off design is built as designed (`docs/superpowers/specs/admin-ux-pass/handoff/README.md`): a fix that changes what a frame explicitly draws (a placement, an order) is not made silently — keep the drawn layout and list it in the report for Dim; alignment/overflow bugs the frames don't draw are fixed.
- Every behaviour change updates `app/src/data/testplan.json` per its rules (`redo`/`reworded`/`new`, `markedAt: "deploy"`); pure visual fixes need no test-plan change.
- Old iPads/iPhones: no regex lookbehind, no `crypto.randomUUID` in browser modules (`tests/unit/old-safari.test.ts`); CSS that old Safari lacks (`field-sizing`) must degrade to today's look.
- Local only: local Docker Postgres `mslab-pg`; never the Railway DB; never `db:seed --target railway`; never read `app/.env.local`; kill only your own processes.

## Review Focus

1. RU content mode on the list rows after F1 (the field head has real content there): the field must still line up.
2. A long real text in a list row and in a gallery caption (F2): the box grows, nothing is cut.
3. The desktop sidebar at 1280×800 with „Koduleht ja uudiskiri“ open (F6): every item and „Logi välja“ reachable, the footer whole.
4. Testimine at 390 px with a long check title and the steps open: the row stacks, the two answer halves stay full width.
5. Testimine with the „Olek“ filter on „Avatud“: a press keeps the row in place; changing the filter or „Värskenda“ then drops it. And a check Automaattest passed whose person's answer is taken back is „Läbitud“ again (Automaattest's), not „Avatud“.

---

### Task 1: List rows and add rows (F1, F2, F9, F10, F16, F19)

**Files:** `app/src/components/admin/course-editor/editor.module.css` (and wherever `.i18n`, `.dragRow`, `.num`, `.tools` live), `I18nInput.tsx`, `ListEditor.tsx`, `LessonsEditor.module.css`, `GrowingText.tsx` if reused; DOM tests next to the touched components.

- [ ] F1: the field lines up with its number, handle and buttons in every `ListEditor` row (Praktika „Sisaldab“, course „Õpiväljundid“, „Koolitus sisaldab“, „Oskused tunnistusel“), also in RU mode. DOM test: with `labelHidden` no empty head element precedes the field.
- [ ] F2 + F9: one compact row layout (`"handle num . tools" / "main main main main"`) for the phone media query and for the course-cards container query, its threshold ≈ 640 px; list textareas grow with their text (min 72 px); gallery row ↑ ↓ × on the „Pilt n“ line; one number style for ListEditor and LessonsEditor.
- [ ] F10: a button beside an input has the input's height (48 px) in add rows („Uus programmi punkt“, „Lisa õppetund“, „Lisa moodul“, Õpilased add form).
- [ ] F16: „Kustuta moodul“ indented with the module's content (or on its head line).
- [ ] F19: phone „Soovitused“ tags wrap under the course name ≤ 640 px.
- [ ] Re-shoot Praktika, course editor (kontakt + e-course + uus) at 1440 and 390 with the audit scripts; measure F1's centres (field centre = button centre ± 2 px).
- [ ] Run the touched unit tests and the e2e specs of these editors (course editor, praktika, lessons) on chromium.
- [ ] Commit: `fix(admin): list rows line up and fit — one compact row, growing text, one control height (polish F1 F2 F9 F10 F16 F19)`

### Task 2: Links, list tables and toolbars (F3, F4, F5, F13, F21)

**Files:** `app/src/components/admin/ui.module.css`, `list-table.module.css`, `registreerimised/registrations.module.css`, `maksed/payments.module.css`, `ListToolbar.module.css`, `RequestCard.module.css`.

- [ ] F3: `ui.link` keeps its 44 px target, the underline is drawn on the text; in table cells the link is level with its neighbours.
- [ ] F4: no blank line between name and contact on desktop pointers; on phone cards the name lines up with its tag/amount.
- [ ] F5: phone cards (Tagasiside, Tunnistused) — the specificity tie resolved, labels at one indent, values in column 2.
- [ ] F13: the toolbar's scope select is full width ≤ 640 px.
- [ ] F21: an address as a card title breaks at a sensible point.
- [ ] Re-shoot Registreerimised, Maksed, Õpilased, Tagasiside, Tunnistused, Päringud, Kalender, Arved and the drawers with links at both widths; run the production build once and check F5 there (the tie depends on bundle order).
- [ ] Commit: `fix(admin): links underline their words, list rows and phone cards line up (polish F3 F4 F5 F13 F21)`

### Task 3: Page frame and the rest (F6, F7, F8, F11, F12, F14, F15, F17, F18, F20, F22)

**Files:** `Sidebar.module.css`, `site/SiteEditorPage.module.css`, `CourseEditor.module.css`, `opilased/page.tsx`, `uudiskiri/page.tsx` + `newsletter.module.css`, `CertificateSettings.tsx`, `ClientDrawer.module.css`, `news/NewsList.tsx` + `NewsList.module.css`, the dashboard cards' CSS, the new-review drawer, and the admin's handling of `public/feedback.js`'s bubble.

- [ ] F6: desktop sidebar — footer whole, only the nav scrolls, everything reachable at 1440×900 and 1280×800 with the group open.
- [ ] F7: the status slot no longer pushes „Vaata lehel ↗“ to a second line; Uudised editor actions on one line at 1440.
- [ ] F8: the course editor's right column scrolls with the page; only „Avaldamine“ stays sticky.
- [ ] F11: „Lisa õpilane +“ opens its form under the heading; the title does not jump.
- [ ] F12: „Tellijad | Kirjad“ in one place in both views (check the hand-off first).
- [ ] F14, F15, F17, F20, F22 as the audit says.
- [ ] F18: the „Kommentaar“ bubble covers no control (bottom padding on admin pages while the review tool is on, or its position) — without touching the public site's behaviour.
- [ ] Re-shoot every changed screen at both widths; run the e2e specs of the touched screens.
- [ ] Commit: `fix(admin): page frame fits — sidebar, header slot, sticky column, form and tab placement (polish F6–F22)`

### Task 4: Testimine — a save can take an answer back (server, Part A)

**Files:** `app/src/domain/testplan.ts`, `app/src/server/testplan.ts`, `app/src/app/api/admin/testplan/route.ts`, `app/src/components/admin/testplan-outbox.ts`; tests `tests/unit/testplan-rules.test.ts`, `tests/unit/testplan-outbox.test.ts`, `tests/db/testplan*.test.ts`.

- [ ] An incoming answer may be `{ status: "clear" }` (no note): the merge removes that check's stored answer from the tester's own map (`answers`, or `auto` for Automaattest's session); no Telegram ping; a clear of a check with no answer is a no-op; the PUT's 200 body is the merged answers as today. `Status` (stored) stays `ok | bad | skip`.
- [ ] The outbox carries a clear like any press (latest press of a check wins; a clear after an unsent press replaces it).
- [ ] Commit: `feat(testplan): a save can take an answer back`

### Task 5: Testimine page (Part A)

**Files:** `app/src/components/admin/TestPlan.tsx`, `TestplanCheck.tsx`, `TestPlan.module.css`, `app/src/i18n/dict/admin.ts`; tests `testplan-dom.test.ts`, e2e `testplan.spec.ts`; `testplan.json` (the Testimine checks).

- [ ] Each check shows its state before the title: open = empty ring, done = green ✓, failed = red ✕ (state word for screen readers: „Avatud“ / „Läbitud“ / „Viga“); a done row is muted, a failed row tinted.
- [ ] A check answered on the page stays in the list (in place, with its new state) until the „Olek“ or „Kes“ choice changes, „Värskenda“ is pressed or the page reloads; counts and area bars update at once.
- [ ] Pressing the pressed half again takes the answer back (Task 4's clear); the last-answer line ends with „Võta vastus tagasi“, which does the same. The check is „Avatud“ again (or Automaattest's state, if it has one); its note goes with the answer.
- [ ] Steps, „Mida näed“ and „Miks“ are open on an open check; a done or failed check shows them folded; „Sammud ▸“ toggles either way.
- [ ] Automaattest counts for us (Dim 29.10, reverses D10's "never counts" of 25.10): a check with no valid answer of Maria's or Dim's takes Automaattest's valid answer as its state (ok → „Läbitud“, bad → „Viga“, a skip → open; one a redo has overtaken does not count) — in the marker, the line, the „Olek“ pills, the area bars and Avaleht's card (`planCounts`, `checkState`'s caller). A person's answer always wins over it. The two halves show only a person's answer (an Automaattest-only pass has no half pressed); a press by a person over it is an ordinary answer. Its result is a chip in the row's meta line (green „Automaattest: Läbitud“, red „Automaattest: Viga“, grey „Automaattest: Jäta vahele“), not a quiet line; its note stays under the row. The menu badge (`ownFaults`) is unchanged. „Kes → Automaattest“ keeps listing the checks it answered.
- [ ] Phone (390/375): the row stacks (marker + title, meta, steps, the two halves full width).
- [ ] Test plan: reword/redo the Testimine checks this changes.
- [ ] Commit: `feat(testplan): Testimine says what is done — state markers, rows stay, steps open, take an answer back, Automaattest's own view`

### Task 6: Sweep, re-audit and the full run

- [ ] Re-shoot all 29 routes + states at 1440×900, 1280×800 and 390×844 with the audit scripts; compare against `shots\`; list anything left.
- [ ] `docs/deploy.md` section 28 (what changed per screen, no migration, rollback = promote), launch-checklist line for Part A's texts.
- [ ] `node tools/testplan-stamp.mjs` happens at deploy, not here.
- [ ] Full vitest, `npm run build`, full Playwright (+ gate config).
- [ ] Commit: `docs(admin): polish pass — deploy notes, test plan sweep`
