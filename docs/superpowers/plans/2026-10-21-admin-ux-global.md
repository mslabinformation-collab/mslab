# Admin UX pass, piece 1: global components — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the design hand-off's §1 global components — the grouped sidebar in a shared layout with its badges, the Protokollid index it links to, and the shared building blocks every later screen uses: autosave with one status chip, the leave guard, ConfirmPanel, UndoBar, the draft layer with PublishBar, the page-level ET/RU switch and the list toolbar. B21, invoice numbers per year, goes first because of its 1 December deadline.

**Architecture:** `Shell` moves from every page into `app/admin/(panel)/layout.tsx`, and the sidebar works out the active entry from the address. New client building blocks live in `components/admin/` with their providers mounted once in the layout. Autosave is a framework-free engine (`components/admin/autosave/engine.ts`, generalised from `protocol-autosave.ts`, which stays untouched until piece 2) wrapped by a `useAutosave` hook, talking to route handlers through one HTTP contract. Drafts live in a new `content_drafts` table, behind `server/drafts.ts`, with `draftMode()` for previews. Screens adopt these blocks in pieces 2–4; this piece only places what the menu and the existing editors need now.

**Tech Stack:** Next.js 16.3.8 App Router, React 19.2, CSS modules, Drizzle 0.45 + postgres.js (PGlite in tests), vitest 5 + happy-dom, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md` (the design is built as designed). Its source is the design's own build guide `docs/superpowers/specs/admin-ux-pass/handoff/README.md` §1, and the prototypes next to it. `docs/superpowers/specs/admin-ux-pass/analysis/` holds the code map (`screens.md` §2–3.0), each B item checked against the code (`behaviours.md`), and every string with its „Outcome" (`strings.md`).

## Global Constraints

- **Built as designed.** Layout, behaviour and strings follow the README, then the desktop prototype, then the phone prototype, then the notes (spec D1). Quote every string exactly: from the README, from the „Outcome" column of `analysis/strings.md`, or from this plan, where Dim approved the texts on 21.10. Do not invent text.
- **Strings.** Every admin string lives in `adminEt` (`src/i18n/dict/admin.ts`) and is filled with `fill()` from `src/i18n/format.ts`. Admin text is Estonian only. Group labels are stored in sentence case and shown in capitals by CSS (`text-transform: uppercase; letter-spacing: .16em`).
- **Look.** Use the existing tokens (`styles/tokens.css`, G11) and the admin colours. The only new colour is `#faf6f8`. Tap targets are at least 44 px. Keep the focus ring (`2px solid var(--rose)`, offset 2). No motion under `prefers-reduced-motion`.
- **Old iPads.**
  - No regex lookbehind, and no `crypto.randomUUID`.
  - Every new browser module that is not `"use client"` gets a line in `BROWSER_FILES` in `tests/unit/old-safari.test.ts`.
- **Admin guards** (`tests/unit/admin-guards.test.ts`):
  - every admin route is `export const METHOD = withAdmin(…)`;
  - every admin page still calls `requireAdmin()`;
  - every `server/actions/admin*.ts` export is `adminAction(…)`.
- **Test plan** (standing rule):
  - Each behaviour change adds or marks checks in `src/data/testplan.json`, with `"mark": "new" | "redo" | "reworded"` and `"markedAt": "deploy"`.
  - Lines follow `checkPlan`: 1–8 `steps` and `expect`, each line at most 20 words ending in a full stop, and titles with no full stop.
  - Never change the `id` of a check that has answers.
  - Run `npx vitest run tests/unit/testplan-file.test.ts` after every change to the file.
- **E-mail addresses.** No real e-mail address in any tracked file; use `@example.test`.
- **Commands** (run from `app/`):
  - unit and db tests: `npx vitest run <file>`;
  - types: `npx tsc --noEmit --incremental false`;
  - lint: `npm run lint`;
  - build: `npm run build`;
  - e2e: `npx playwright test <spec> --project=chromium --project=mobile`.

  E2E needs the local Docker database: `docker start mslab-pg`. If it fails with CONNECT_TIMEOUT, run `docker desktop restart` first.
- **Migration.** This piece adds `0017_content_drafts`; the instalments spec's 0017 moves to the next free number (spec §7). Write the migration with `npm run db:generate`, then check the SQL by hand.
- **Strings that leave or change.** When a dict value changes, sweep `tests/` and `src/data/testplan.json` for the old text in the same task.

## Review Focus

1. **The sidebar after a client-side navigation.** Shell now lives in the layout, so the active entry, the fold, the badges and `html[data-admin-ready]` must follow the new address without a full reload. Expected: active and badges are right after clicking another menu entry and after Back. (Task 2 and Task 4 tests.)
2. **A tablet between 641 and 899 px wide.** It now gets the phone top bar. Expected: no narrow 190 px sidebar, the menu opens, and nothing overflows sideways at 768 px. (Task 3 e2e at 768×1024.)
3. **Autosave across a lost answer and two tabs.** A save whose answer is lost and is then retried must not report a conflict with itself. A real change from another tab must report `conflict` and keep the local text. (Task 9 engine tests.)
4. **Leaving with unsaved text.** A menu click, Back, and a drawer's ✕/Esc/backdrop while a save is in flight wait up to 3 s. When it can't save, the guard asks instead of dropping the text. (Task 10 tests.)
5. **Midnight and the year edge in Tallinn.** „Täna", the 14-day index, B16 and B21's „1. jaanuarist" line use the Tallinn date, not UTC. Expected: at 23:30 UTC on 30 November it is already 1 December in Tallinn, so the line shows. (Task 1, Task 4 and Task 5 tests.)

---

### Task 1: B21 — invoice numbers per year

**Files:**
- Modify: `src/components/admin/InvoiceSettings.tsx` (the „Järgmine number" fieldset, l.219-239; `Draft`/`draftOf` l.36-64; save l.152-168)
- Modify: `src/server/invoices.ts` (`invoiceCard` l.754-760, `saveInvoiceSettings` l.785-827)
- Modify: `src/i18n/dict/admin.ts` (`invoices.settings`, l.427-476)
- Modify: `src/data/testplan.json` (check `haldus-seaded-arve`)
- Modify: `docs/superpowers/specs/2026-10-16-invoices-design.md` (D7: the year is never typed)
- Test: `tests/db/invoices.test.ts`, `tests/unit/invoice-settings-dom.test.ts`, `tests/db/seaded-invoice-page.test.ts`, `tests/unit/admin-invoices-action.test.ts`, `tests/e2e/admin-invoices.spec.ts` (if it types the year)

**Interfaces:**
- Consumes: `tallinnYear(d: Date): number` and `tallinnDateText` (`domain/certificate.ts`), `formatInvoiceNumber(prefix, year, seq)` and `invoiceSeq` (`domain/invoice.ts`).
- Produces: `saveInvoiceSettings(db, raw, now)` no longer reads `nextYear`. It stores `nextYear = tallinnYear(now)`, and „Järgmine number" is this year's counter.

- [ ] **Step 1: Write the failing tests**

In `tests/db/invoices.test.ts`, inside the "Seaded → Arve andmed" describe:
```ts
it("B21: the year is never typed — a sent nextYear is ignored and this Tallinn year is stored", async () => {
  const now = new Date("2026-11-30T12:00:00Z");
  const r = await saveInvoiceSettings(db, { ...validRaw, nextYear: "2027", nextSeq: "5" }, now);
  expect(r.ok).toBe(true);
  expect(await getSetting(db, "invoice")).toMatchObject({ nextYear: 2026, nextSeq: 5 });
});
it("B21: the card always shows this year's counter, even over an old next-year preset", async () => {
  await setSetting(db, "invoice", { ...stored, nextYear: 2027, nextSeq: 1 });
  const card = await invoiceCard(db, new Date("2026-11-10T12:00:00Z"));
  expect(card.nextYear).toBe(2026);
});
```
In `tests/unit/invoice-settings-dom.test.ts`:
```ts
it("B21: no „Aasta" field; from 1 December (Tallinn) the line „1. jaanuarist: MSL2027-001" shows", async () => {
  await show({ ...initial, prefix: "MSL", nextYear: 2026 }, bank, { now: new Date("2026-11-30T23:30:00Z") }); // 1.12 01:30 in Tallinn
  expect(document.querySelector('[data-invoice-field="nextYear"]')).toBeNull();
  expect(document.querySelector("[data-invoice-january]")?.textContent).toBe("1. jaanuarist: MSL2027-001");
});
it("B21: before December there is no January line", async () => {
  await show({ ...initial, prefix: "MSL", nextYear: 2026 }, bank, { now: new Date("2026-11-30T21:30:00Z") }); // 23:30 in Tallinn, still 30.11
  expect(document.querySelector("[data-invoice-january]")).toBeNull();
});
```
Fit `show`'s third argument to the file's helper (`now` reaches the component as a prop, see Step 3).

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/db/invoices.test.ts tests/unit/invoice-settings-dom.test.ts`
Expected: FAIL. `nextYear` is stored as 2027, the year field still exists, and there is no `[data-invoice-january]`.

- [ ] **Step 3: Implement**

- **`saveInvoiceSettings`:** drop the `nextYear` input and its `year` refusal (l.811-813), and use `const nextYear = tallinnYear(now)`. The `taken` check and the prefix reset stay, against that year.
- **`invoiceCard`:** always show this year's counter: `invoiceSeq(settings, tallinnYear(now), highest)`.
- **`InvoiceSettings`:**
  - Remove the „Aasta" input and `nextYear` from `Draft`. The fieldset keeps its legend „Järgmine number" and the `nextSeq` input.
  - Add an optional prop `now?: Date`, defaulting to `new Date()`.
  - When the Tallinn date of `now` is 1–31 December, render `<p className={ui.hint} data-invoice-january>{fill(t.fromJanuary, { number: formatInvoiceNumber(draft.prefix || initial.prefix, year + 1, 1) })}</p>`.
- **Dict `invoices.settings`:**
  - add `fromJanuary: "1. jaanuarist: {number}"` (design README B21: „1. jaanuarist: {prefix}{year+1}-001");
  - delete `nextYear` and `errors.year`.

  Sweep `tests/` for „Aasta peab olema" and for `data-invoice-field="nextYear"`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/db/invoices.test.ts tests/unit/invoice-settings-dom.test.ts tests/db/seaded-invoice-page.test.ts tests/unit/admin-invoices-action.test.ts tests/unit/invoice-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Mark the test plan and amend the spec**

- `haldus-seaded-arve` gets `"mark": "redo"` and `"markedAt": "deploy"`. Its steps say the year is no longer typed and that the line „1. jaanuarist: …" shows from 1 December.
- Invoices spec D7 gets one line: "Since the admin UX pass (B21) the year is not typed; „Järgmine number" is this year's counter."
- Run `npx vitest run tests/unit/testplan-file.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(invoices): B21 — invoice numbers per year, no year field; „1. jaanuarist" line from December"
```

### Task 2: Shell in the panel layout, active entry from the address, loading and error

**Files:**
- Modify: `src/app/admin/(panel)/layout.tsx`, `src/components/admin/Shell.tsx`, `src/components/admin/Sidebar.tsx`, `src/components/admin/sections.ts`
- Modify: every file that renders `<Shell …>`: the 27 pages and not-found files listed in `analysis/screens.md` §6. Remove the `<Shell>` wrapper, but keep `requireAdmin()` in each page.
- Create: `src/app/admin/(panel)/loading.tsx`, `src/app/admin/(panel)/error.tsx`, `src/components/admin/PanelStates.module.css`
- Modify: `src/i18n/dict/admin.ts` (`panel` group: the error texts)
- Test: `tests/unit/admin-sections.test.ts` (create), `tests/unit/admin-guards.test.ts` (keep passing), `tests/e2e/admin-load.spec.ts`

**Interfaces:**
- Produces:
  - `type Section` gains `"protocols"` and `"testing"`.
  - `activeSection(pathname: string, search: URLSearchParams): Section` in `sections.ts`.
  - `Shell({ email, children })` loses `active`, and `Sidebar` reads the address itself (`usePathname`, `useSearchParams`).
  - Pages no longer import `Shell`.

- [ ] **Step 1: Write the failing test** `tests/unit/admin-sections.test.ts`
```ts
const at = (path: string) => { const u = new URL(path, "https://x.test"); return activeSection(u.pathname, u.searchParams); };
it.each([
  ["/admin", "overview"], ["/admin/koolitused/12?oppetund=3", "courses"], ["/admin/kalender?id=uus", "calendar"],
  ["/admin/registreerimised?id=4", "registrations"], ["/admin/protokollid", "protocols"], ["/admin/protokollid?sessioon=7", "protocols"],
  ["/admin/protokollid?registreering=9", "protocols"], ["/admin/protokollid?ligipaas=5", "assessment"], ["/admin/hindamine/test?id=2", "assessment"],
  ["/admin/tunnistused", "assessment"], ["/admin/arved", "payments"], ["/admin/maksed", "payments"], ["/admin/tagasiside?vaade=arvustused", "feedback"],
  ["/admin/opilased/3/vaade/kulmud", "clients"], ["/admin/paringud", "requests"], ["/admin/praktika", "practice"], ["/admin/avaleht", "home"],
  ["/admin/koolitaja", "trainer"], ["/admin/uudised/4", "news"], ["/admin/kampaania", "campaign"], ["/admin/uudiskiri?vaade=kampaaniad", "newsletter"],
  ["/admin/seaded", "settings"], ["/admin/testimine", "testing"],
])("%s → %s", (path, section) => expect(at(path)).toBe(section));
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/admin-sections.test.ts`
Expected: FAIL, "activeSection is not exported".

- [ ] **Step 3: Implement**

- `activeSection` implements the README §1.1 mapping, with spec D4: `?ligipaas=` goes to assessment.
- The `(panel)` layout:
  - `const email = await requireAdmin()`;
  - `return <Shell email={email}>{children}</Shell>`.
- Shell is still a server component and still reads `getAdminCounts()`.
- The Sidebar's `active` comes from `activeSection(usePathname(), useSearchParams())`. Wrap Sidebar in `<Suspense>` in Shell, as `useSearchParams` requires.
- Every page drops its `<Shell>` wrapper and the `email` it only used for Shell. Each page still calls `await requireAdmin()`.
- `loading.tsx`: static grey rows, no shimmer, made visible only after 300 ms by a CSS `animation-delay` on an opacity step. It keeps no page header, because the layout's Shell stays on screen. Under reduced motion it is shown at once.
- `error.tsx` (`"use client"`, `{ error, reset }`) uses the design's texts, quoted exactly:
  - `panel.errorTitle`: „Seda lehte ei saanud praegu laadida.“
  - `panel.errorBody`: „Sinu salvestatud andmed on alles. Proovi mõne hetke pärast uuesti.“
  - `panel.errorRetry`: „Proovi uuesti“, a `ui.btn` that calls `reset()`.
- `ReadyMark` stays in Shell. Check that `html[data-admin-ready]` is still set after a client-side navigation; e2e `adminReady()` relies on it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/admin-sections.test.ts tests/unit/admin-guards.test.ts && npx tsc --noEmit --incremental false`
Expected: PASS, and no type errors.

- [ ] **Step 5: E2E smoke**

Add to `tests/e2e/admin-load.spec.ts`: sign in, open `/admin/maksed`, click the menu entry for `/admin/registreerimised`, expect `[aria-current="page"]` in the sidebar on that entry, then go back and expect it on the payments entry.

Run: `npx playwright test tests/e2e/admin-load.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(admin): Shell in the panel layout; active entry from the address; loading and error states"
```

### Task 3: The grouped sidebar, phone bar and top line

**Files:**
- Modify: `src/components/admin/sections.ts`, `Sidebar.tsx`, `Sidebar.module.css`, `Shell.tsx`, `Shell.module.css`, `src/styles/globals.css` (`html { scrollbar-gutter: stable }`), `src/i18n/dict/admin.ts` (`shell`, `nav`)
- Test: `tests/unit/sidebar-dom.test.ts` (create, happy-dom), e2e `tests/e2e/admin-load.spec.ts`; sweep e2e for `data-admin-view-site`

**Interfaces:**
- Consumes: `activeSection` (Task 2).
- Produces:
  - `GROUPS: readonly { id: "daily" | "courses" | "site" | "admin" | null; fold?: true; items: Section[] }[]` in `sections.ts`;
  - `SECTIONS` gains `protocols → /admin/protokollid` (icon `clipboard`) and `testing → /admin/testimine` (icon `check`);
  - `Sidebar` props become `{ items: NavItem[]; t: SidebarTexts; total: number; email: string; today: TodayCard | null }`, where `type TodayCard = { href: string; time: string; course: string }` (it is filled by Task 4).

- [ ] **Step 1: Write the failing tests** `tests/unit/sidebar-dom.test.ts`

Render `Sidebar` with `usePathname` and `useSearchParams` mocked (`vi.mock("next/navigation")`). Then:
```ts
it("groups in the design's order", () => {
  // labels via [data-nav-group]; entries via [data-nav-item]
  expect(groupLabels()).toEqual(["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"]);
  expect(itemsOf("daily")).toEqual(["registrations", "protocols", "assessment", "requests", "clients", "feedback", "payments"]);
  expect(itemsOf("courses")).toEqual(["courses", "calendar", "practice"]);
  expect(itemsOf("site")).toEqual(["home", "trainer", "news", "campaign", "newsletter"]);
  expect(itemsOf("admin")).toEqual(["settings", "testing"]);
});
it("„Koduleht ja uudiskiri" folds; open when the page is inside; the choice is kept in mslab-nav-fold", ...);
it("the footer: „Sisse logitud", the e-mail, „Logi välja" — and no „Vaata lehte"", ...);
it("labels: „Maksed ja arved", „Protokollid", „Testimine"", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/sidebar-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.1 and §1.2, with the measurements in `analysis/screens.md` §2.2 and §3.0

- **Group labels** (dict `nav.groups`), in sentence case and shown in capitals by CSS: „Igapäevane töö“, „Koolitused“, „Koduleht ja uudiskiri“, „Haldus“.
- **Group label style:** 600 10 px, letter-spacing .16em, `#a99ba4`, 22 px tall, 8 px gap above.
- **The fold:**
  - its header is a 44 px `<button aria-expanded>` with ▸/▾;
  - it is open whenever the active page is inside it;
  - otherwise it follows `localStorage["mslab-nav-fold"]` (`"open" | "closed"`), and reads and writes are wrapped in try/catch.
- **Labels** (dict `nav`): `payments` „Maksed ja arved“, and the new `protocols` „Protokollid“ and `testing` „Testimine“.
- **Footer:** „Sisse logitud“ (11 px `#a99ba4`), the e-mail (12 px), then „Logi välja“. Remove the footer „Vaata lehte ↗“, and the `aside` scrolls on its own (`overflow-y: auto; min-height: 0`).
- **Breakpoint:**
  - `WIDE = "(min-width: 900px)"`;
  - the phone top bar is used below 900 px in both CSS files;
  - the 190 px narrow sidebar rules are deleted.
- **Phone bar:**
  - The current page's name sits on the left (500 14 px `#ccc0c8`); the overview shows the logo instead.
  - The ≡ button is 44×44 with a 1 px `#51434c` ring and carries the badge sum. It shows ✕ while the menu is open.
- **Phone menu:**
  - The same groups, all expanded, with no fold.
  - At the top, when `today` is set, a card „TÄNA {time}“ + „Protokollid · {course}“ linking to `today.href`.
  - The footer adds „Vaata kodulehte ↗“ (`/api/admin/preview`, new tab).
- **Top line:**
  - „Vaata kodulehte ↗“ appears once.
  - Remove the avatar's `title` tooltip and the dict key `shell.signedInAs`.
  - Add the dict key `shell.signedIn` „Sisse logitud“.
- **Scroll:** `html { scrollbar-gutter: stable }`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/sidebar-dom.test.ts && npx tsc --noEmit --incremental false`
Expected: PASS.

- [ ] **Step 5: E2E at three widths**

- Sweep `tests/` for `data-admin-view-site` and for the footer link text, and point them at the top line (`data-admin-preview`).
- Add to `admin-load.spec.ts`:
  - at 768×1024, the phone bar is visible, the menu opens, and `document.documentElement.scrollWidth <= innerWidth`;
  - at 1440×900, the sidebar is visible and the fold opens on a tap.

Run: `npx playwright test tests/e2e/admin-load.spec.ts tests/e2e/admin-auth.spec.ts --project=chromium --project=mobile`
Expected: PASS.

- [ ] **Step 6: Test plan, then commit**

Add the checks below to `src/data/testplan.json`, each with `new` and `deploy`:
- `haldus-menuu-grupid` (arvuti): the groups, the fold, the footer;
- `haldus-menuu-telefon` (telefon): the top bar, the page name, ≡ with the sum, the menu and the TÄNA card;
- `haldus-menuu-tahvel` (tahvel): at 768 px the phone bar shows.

Run `npx vitest run tests/unit/testplan-file.test.ts`.
```bash
git add -A && git commit -m "feat(admin): grouped sidebar with folding site group, phone bar below 900 px, one site link"
```

### Task 4: Badges (B6) and the today card

**Files:**
- Modify: `src/db/queries/admin.ts` (`adminCounts` l.476-497, `AdminCounts` l.462-473), `src/components/admin/data.ts`, `Shell.tsx`, `src/server/actions/admin-assessment.ts` (revalidate after „Ava test uuesti“), `src/i18n/dict/admin.ts` (`shell.badge*`)
- Test: `tests/db/admin-counts.test.ts` (create), `tests/unit/sidebar-dom.test.ts`

**Interfaces:**
- Consumes: `testplan` answers (`server/testplan.ts` `readAnswers`), the reviews status, the payments status, and the invoices' unbilled list. The "unbilled paid payments" count is the same set `InvoiceCatchUp` lists; reuse its query.
- Produces: `adminCounts(db, email, now)`, which returns `AdminCounts` plus:
  - `todaySessions: { id: number; startsAt: Date; course: string }[]`: scheduled sessions on the Tallinn date of `now`;
  - `waitingReviews: number`;
  - `paymentsAttention: number`: unbilled paid + `held` + voided-after-paid, as the design lists (spec S7);
  - `ownFaults: number`: the signed-in admin's „Viga“ answers.

  `getAdminCounts` becomes `cache((email: string) => adminCounts(getDb(), email, new Date()))`.

- [ ] **Step 1: Write the failing tests** `tests/db/admin-counts.test.ts` (PGlite, `makeTestDb()`)

```ts
it("todaySessions uses the Tallinn date (23:30 UTC on 30.11 is 1.12 in Tallinn)", ...);       // a session at 1.12 10:00 counts, one at 30.11 counts not
it("waitingReviews counts reviews waiting for „Avalda"", ...);
it("paymentsAttention = unbilled paid + held + paid-then-voided", ...);                        // seed one of each plus one billed paid → 3
it("ownFaults counts only the signed-in admin's „Viga" answers", ...);
it("openRequests still counts every kind, „Muutmine" included", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/db/admin-counts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Queries:** keep each count to one query inside the same `Promise.all`.
- **Badges in Shell (README §1.1):**

  | Entry | Badge | Link |
  |---|---|---|
  | Registreerimised | `awaitingPrepayment` | `/admin/registreerimised?staatus=ootab` |
  | Protokollid | the text „Täna“ when `todaySessions.length > 0` | see Task 5 |
  | Hindamine | as today | |
  | Päringud | the sum of `openRequests` | |
  | Tagasiside | `waitingReviews` | `/admin/tagasiside?vaade=arvustused&olek=ootel` |
  | Maksed ja arved | `paymentsAttention` | |
  | Testimine | `ownFaults` | |

  - A badge shows only when it is above 0.
  - The phone sum is the numeric badges added up.
- **Screen-reader labels** (Dim, 21.10): `shell.badgeFeedback` „{n} arvustust ootab“, `shell.badgePayments` „{n} vajab kontrolli“, `shell.badgeTesting` „{n} viga“, `shell.badgeToday` „Täna on koolituspäev“.
- **`today` for Sidebar:** the first of `todaySessions` as `{ href: "/admin/protokollid?sessioon=<id>", time: formatTime(startsAt), course }`, or null.
- **`reopenTestAction`:** after success, call `revalidatePath("/admin", "layout")` so the Hindamine badge and the overview update.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/db/admin-counts.test.ts tests/unit/sidebar-dom.test.ts`
Expected: PASS.

- [ ] **Step 5: Test plan, then commit**

Add the check `haldus-menuu-margid` (new, deploy): each badge counts what it should and opens the filtered page. Run the test-plan test.
```bash
git add -A && git commit -m "feat(admin): B6 badges — Tagasiside, Maksed ja arved, Testimine, „Täna"; links open filtered"
```

### Task 5: Protokollid index (B8) and the one-session shortcut (B16)

**Files:**
- Modify: `src/app/admin/(panel)/protokollid/page.tsx` (no parameter → the index), `src/db/queries/protocols.ts` (`protocolIndex`), `src/components/admin/ProtocolScreen.module.css` or a new `ProtocolIndex.module.css`, `Shell.tsx` (B16 href), `src/i18n/dict/admin.ts` (`protocols.index`)
- Test: `tests/db/protocol-index.test.ts` (create), e2e `tests/e2e/protocols.spec.ts`

**Interfaces:**
- Consumes: `todaySessions` (Task 4).
- Produces: `protocolIndex(db, now): Promise<{ sessions: { id; startsAt: Date; course: string; place: string; students: number; sent: number; drafts: number }[]; individual: { registrationId: number; name: string; course: string }[] }>`.

- [ ] **Step 1: Write the failing test** `tests/db/protocol-index.test.ts`

```ts
it("lists sessions from today back 14 Tallinn days, newest first, today on top", ...);   // 15 days ago left out; a future one left out
it("counts students, sent and draft protocols per session", ...);                          // 3 students, 1 sent, 1 draft
it("lists open individual registrations under „INDIVIDUAALKOOLITUSED"", ...);              // individual, not cancelled, protocol not sent
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/db/protocol-index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README A3 (index part) and B16

- **A row:**
  - the date (Jost 22, „Täna“ for today) and the weekday;
  - the course and "{time} · {city, venue}";
  - the counts: "{n} õpilast · {a} saadetud · {b} mustand", or "✓ Kõik {n} saadetud" in `#2f5d46`;
  - „Ava“ (`ui.btn` when today, `ui.secondary` otherwise), linking to `?sessioon=`.
- **The individual section:** headed „Individuaalkoolitused“, shown in capitals by CSS. Its rows link to `?registreering=`.
- **Empty:** „Viimase 14 päeva jooksul koolituspäevi polnud.“ + the link „← Kalender“.
- **The note line** under the heading: „Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.“ (`strings.md` D4).
- **B16:** in Shell, when `todaySessions.length === 1`, the „Protokollid“ entry's href is `/admin/protokollid?sessioon=<id>`.
- **Unchanged:** the screen for `?sessioon=`, `?registreering=` and `?ligipaas=`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/db/protocol-index.test.ts && npx playwright test tests/e2e/protocols.spec.ts --project=chromium --project=mobile`
Expected: PASS. Add one e2e step: the menu's „Protokollid“ opens the index, and its „Ava“ opens the session screen.

- [ ] **Step 5: Test plan, then commit**

Add the checks `kontakt-protokollid-nimekiri` (telefon) and `kontakt-protokollid-tana-otse`, both new. Run the test-plan test.
```bash
git add -A && git commit -m "feat(protocols): B8 index of the last 14 days, B16 one-session shortcut from the menu"
```

### Task 6: ConfirmPanel

**Files:**
- Create: `src/components/admin/ConfirmPanel.tsx`, `ConfirmPanel.module.css`
- Modify: `src/i18n/dict/admin.ts` (`common.cancel` „Katkesta“, `common.close` „Sulge“, `common.undo` „Võta tagasi“; the glossary words, README §1.11)
- Test: `tests/unit/confirm-panel-dom.test.ts` (create)

**Interfaces:**
- Produces: `ConfirmPanel({ question: string; lines?: string[]; yesLabel: string; tone: "danger" | "send"; busy?: boolean; onYes: () => void; onCancel: () => void }): JSX.Element`.
  - It renders `<div role="group" aria-labelledby={qid} data-confirm-panel tabIndex={-1}>` and focuses itself on mount.
  - „Katkesta“ calls `onCancel`. The parent shows its trigger again and focuses it.

- [ ] **Step 1: Write the failing test**

```ts
it("shows the question, every line and „Jah, …"; takes focus", ...);
it("„Katkesta" calls onCancel; Esc does the same", ...);
it("yes calls onYes once; while busy it is aria-disabled and does nothing", ...);
it("danger tone: outline #c9a3a3, bg #f5ebeb, text #8a3b3b; send tone: the ink pill", ...);  // assert the class names
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/confirm-panel-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.6

- The style is `ui.notice`: bg `#f0ebed`, a 2 px left border `#9e8993`, radius `0 14 14 0`.
- The "no" button is always „Katkesta“.

- [ ] **Step 4: Run it and see it pass**, then commit

Run: `npx vitest run tests/unit/confirm-panel-dom.test.ts`
Expected: PASS.
```bash
git add -A && git commit -m "feat(admin): ConfirmPanel — one confirmation pattern; glossary words in common"
```

### Task 7: UndoBar

**Files:**
- Create: `src/components/admin/UndoBar.tsx` (provider + bar + `useUndo`), `UndoBar.module.css`
- Modify: `src/app/admin/(panel)/layout.tsx` (mount `UndoProvider` inside Shell's main)
- Test: `tests/unit/undo-bar-dom.test.ts` (create)

**Interfaces:**
- Produces: `UndoProvider`, and `useUndo(): { show(o: { text: string; undo: () => Promise<boolean> }): void }`.
  - One bar at a time; a new `show` replaces the old.
  - When `undo()` resolves false, the bar shows `adminEt.common.saveError`.

- [ ] **Step 1: Write the failing test** (fake timers)

```ts
it("shows „{text}" + „Võta tagasi"; gone after 8 s", ...);
it("Esc dismisses it; a second show replaces the first", ...);
it("„Võta tagasi" calls undo once and closes the bar", ...);
it("does not take focus", ...);  // document.activeElement unchanged after show
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/undo-bar-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.7

- The bar sits bottom-left, full width on a phone.
- Style: bg `#222`, radius 14, min-height 52, `role="status"`.
- The button uses `#3a3338` and is 44 px.

- [ ] **Step 4: Run it and see it pass**, then commit

Run: `npx vitest run tests/unit/undo-bar-dom.test.ts`
Expected: PASS.
```bash
git add -A && git commit -m "feat(admin): UndoBar — 8 s „Võta tagasi", one at a time"
```

### Task 8: SaveStatus and the autosave status type

**Files:**
- Create: `src/domain/autosave.ts` (types and the HTTP contract), `src/components/admin/SaveStatus.tsx`, `SaveStatus.module.css`
- Modify: `src/i18n/dict/admin.ts` (`autosave` group)
- Test: `tests/unit/save-status-dom.test.ts` (create)

**Interfaces:**
- Produces, in `domain/autosave.ts`:
  ```ts
  export type AutosaveStatus =
    | { kind: "saved"; at: Date | null } | { kind: "dirty" } | { kind: "saving" } | { kind: "checking" } | { kind: "retry" }
    | { kind: "invalid"; fields: string[] } | { kind: "signedOut" } | { kind: "conflict" } | { kind: "gone" };
  export type SaveAnswer =
    | { ok: true; version: string; savedAt: string }
    | { ok: false; error: "conflict"; version: string; value: unknown }
    | { ok: false; error: "invalid"; fields: Record<string, string> };
  ```
- Produces, in `SaveStatus.tsx`: `SaveStatus({ status, draft?, compact?, thing?, onShowInvalid? })`.
  - `compact` is the phone page chip from `strings.md` D1: „✓ Mustand {HH:MM}“ / „✓ {HH:MM}“. Drawers keep the full form.
  - `thing` is the partitive noun for „gone“, for example "registreerimist".
  - `onShowInvalid` focuses the first invalid field.

- [ ] **Step 1: Write the failing test**

Each state's text and colour classes come from README §1.4:

```ts
it.each([
  [{ kind: "saved", at: new Date("2026-10-21T09:04:00Z") }, "Salvestatud 12:04"],
  [{ kind: "dirty" }, "Salvestamata muudatused"], [{ kind: "saving" }, "Salvestan…"], [{ kind: "checking" }, "Kontrollin salvestatud teksti…"],
  [{ kind: "retry" }, "Salvestamata — proovin uuesti"], [{ kind: "invalid", fields: ["Hind"] }, "Salvestamata — kontrolli märgitud välja"],
  [{ kind: "signedOut" }, "Salvestamata — logi uuesti sisse"], [{ kind: "conflict" }, "Muudeti teises aknas — vaata üle"],
])("%o → %s", ...);
it("draft: „Mustand salvestatud {HH:MM}"", ...);
it("gone: „Seda registreerimist enam ei ole. Tekst on selles seadmes alles."", ...);
it("the ✓ is aria-hidden; the live region speaks only when the kind changes", ...);
it("invalid: „Näita" calls onShowInvalid", ...);
```

The time is Tallinn (`formatTime`).

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/save-status-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.4, with the ✓ per `strings.md` D1

- The chip is 32 px tall, radius 99, 600 12 px.
- Colours:
  - saved: `#eaf0eb` / `#2f5d46`;
  - neutral: `#ebe8e9` / `#5e5559`;
  - error: `#f3e6e6` / `#8a3b3b`.

- [ ] **Step 4: Run it and see it pass**, then commit

Run: `npx vitest run tests/unit/save-status-dom.test.ts`
Expected: PASS.
```bash
git add -A && git commit -m "feat(admin): SaveStatus chip and the autosave status contract"
```

### Task 9: The autosave engine, `useAutosave`, and the route helper

**Files:**
- Create: `src/components/admin/autosave/engine.ts` (no React; add it to `BROWSER_FILES`), `src/components/admin/autosave/useAutosave.ts` (`"use client"`), `src/server/autosave-route.ts`
- Test: `tests/unit/autosave-engine.test.ts` (create, fake timers and `stubFetch` from `tests/fakes.ts`), `tests/unit/autosave-route.test.ts` (create)
- Read first: `src/components/admin/protocol-autosave.ts`. Copy its behaviour, not its protocol shapes. Do not edit it; the protocol screen moves onto the engine in piece 2.

**Interfaces:**
- Consumes: `AutosaveStatus` and `SaveAnswer` (Task 8).
- Produces:
  ```ts
  // engine.ts
  export type Fields = Record<string, unknown>;
  export type SendPatch = (body: { version: string; patch: Fields }, opts?: { keepalive?: boolean }) => Promise<{ status: number; body: unknown } | null>;
  export class AutosaveEngine {
    constructor(o: { owner: string; key: string; version: string; fields: Fields; send: SendPatch; validate?: (f: Fields) => Record<string, string>; tab?: string });
    start(storage: Storage | null): void; stop(): void;
    setField(name: string, value: unknown): void;   // debounced save, 1500 ms
    flush(): Promise<boolean>;                       // save now; true when confirmed
    restore(): Promise<boolean>;                     // conflict: write the local copy back over the server's version and save
    subscribe(fn: () => void): () => void; snapshot(): { status: AutosaveStatus; fields: Fields; conflict: { version: string; value: unknown } | null };
    unconfirmed(): { field: string | null; reason: "offline" | "error" | "invalid" | "signedOut" } | null;
  }
  // useAutosave.ts
  export function useAutosave(o: { owner: string; key: string; version: string; fields: Fields; save: SendPatch; validate?: …; label: (field: string) => string }):
    { status: AutosaveStatus; fields: Fields; setField; flush; conflict; restore };   // also registers with the leave guard (Task 10)
  // server/autosave-route.ts
  export function autosaveHandler<P>(o: { schema: ZodType<P>; read: (id: number) => Promise<{ version: string; value: unknown } | null>;
    write: (id: number, patch: P, version: string, admin: { email: string }) => Promise<SaveAnswer> }): (request: Request, id: number, admin: { email: string }) => Promise<Response>;
  ```
- **The HTTP contract:**
  - The request is a POST of `{ version, patch }`.
  - 200: `{ ok:true, version, savedAt }`.
  - 409: `{ ok:false, error:"conflict", version, value }`.
  - 400: `{ ok:false, error:"invalid", fields }`.
  - 404: gone.
  - 413: too big.
  - 401 and 403 come from `withAdmin`.
  - Every answer has `cache-control: no-store`.

- [ ] **Step 1: Write the failing tests**

```ts
// engine
it("saves 1500 ms after the last setField, and on flush()", ...);
it("keeps a local copy at mslab-draft:{owner}:{key}:{tab} until the server confirms", ...);
it("retries after 2, 5, 10, 20, 30 s, and at once on online / focus", ...);
it("pagehide sends with keepalive only when the body is ≤ 64 000 bytes", ...);
it("an invalid field is left out of the patch; the others still save; status invalid lists it", ...);
it("409 → status conflict, the local text kept; restore() saves it over the server's version", ...);
it("a lost answer, retried, is not a conflict with itself", ...);   // remember what was sent (protocol-autosave.ts:1134-1138)
it("401 → signedOut, text kept; 404 → gone", ...);
it("one save in flight at a time", ...);
// route
it("200 with the new version; 409 with the stored value; 400 with field codes; 413 over the size limit", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/autosave-engine.test.ts tests/unit/autosave-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.3

- Constants come from `protocol-autosave.ts`: `DEBOUNCE_MS`, `RETRY_MS`, `KEEPALIVE_MAX_BYTES`, `SAVE_TIMEOUT_MS`. Import them; don't copy their values.
- The tab name follows the protocol engine's way (no `crypto.randomUUID`).

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/unit/autosave-engine.test.ts tests/unit/autosave-route.test.ts tests/unit/old-safari.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(admin): autosave engine, useAutosave and the route helper (one contract for every editor)"
```

### Task 10: `useLeaveGuard` and the Drawer change

**Files:**
- Create: `src/components/admin/LeaveGuard.tsx` (provider, `useLeaveGuard`, `useGuardSource`, the notice), `LeaveGuard.module.css`
- Modify: `src/app/admin/(panel)/layout.tsx` (mount the provider), `src/components/admin/Drawer.tsx`, `src/components/admin/autosave/useAutosave.ts` (register as a source), `src/i18n/dict/admin.ts` (`leave` group), every Drawer call site's `closeLabel` (→ `adminEt.common.close`)
- Test: `tests/unit/leave-guard-dom.test.ts` (create), `tests/unit/drawer-dom.test.ts` (if present, else create)

**Interfaces:**
- Consumes: `AutosaveEngine.flush()` and `unconfirmed()` (Task 9).
- Produces:
  - `useGuardSource(source: { id: string; label: () => string | null; flush: () => Promise<boolean>; unconfirmed: () => { reason } | null; focus: () => void })`;
  - `useLeaveGuard(): { requestLeave(go: () => void, where: "page" | "drawer"): void }`.
  - `Drawer` asks `requestLeave` before closing.
  - `confirmClose` stays only until the lesson drawer moves to autosave in piece 3. Mark it `/** @deprecated piece 3 */`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a menu link click with a save in flight waits for it (≤ 3 s), then navigates", ...);
it("when the save can't go through: the notice „Muudatust „{välja nimi}" ei saanud veel salvestada." + reason; „Jää siia" focuses the field", ...);
it("„Sulge, tekst jääb seadmesse" leaves; the local copy stays for next time", ...);
it("Back (popstate) is held the same way", ...);
it("Drawer ✕, Esc and the backdrop all go through requestLeave; the close label is „Sulge"", ...);
it("beforeunload is set only while something is unconfirmed", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/leave-guard-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.5, with `analysis/screens.md` §2.4

- **Interception:** a capturing `click` listener on `document` for same-origin `a[href^="/admin"]` without a modifier key or `target`.
- **Back:** `popstate`. When it is held, push the current URL back and show the notice.
- **Reasons:**
  - offline: „Ühendus puudub. Proovin uuesti, kuni jääd siia.“ (Part 1 prototype);
  - the other four (Dim, 21.10): error „Salvestamine ei õnnestunud.“, invalid „Üks väli vajab parandamist.“, signedOut „Logi uuesti sisse.“, upload „Üleslaadimine käib.“.
- **Buttons:** „Jää siia“ (primary) and „Sulge, tekst jääb seadmesse“.

- [ ] **Step 4: Run them and see them pass**, plus the drawer e2e

Run: `npx vitest run tests/unit/leave-guard-dom.test.ts && npx playwright test tests/e2e/admin-inbox.spec.ts tests/e2e/admin-lessons.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 5: Test plan, then commit**

Add the check `haldus-lahkumine-salvestamata` (new): the menu click and the drawer close keep unsaved text. Run the test-plan test.
```bash
git add -A && git commit -m "feat(admin): leave guard for menu, Back and drawers; one „Sulge""
```

### Task 11: The draft layer — `content_drafts`, publish/discard, preview, PublishBar

**Files:**
- Modify: `src/db/schema.ts` (table `contentDrafts`)
- Create: `drizzle/0017_content_drafts.sql` (+ journal and snapshot via `npm run db:generate`), `src/server/drafts.ts`, `src/app/api/admin/eelvaade/route.ts`, `src/components/admin/PublishBar.tsx`, `PublishBar.module.css`
- Modify: `src/i18n/dict/admin.ts` (`publish` group), `docs/deploy.md` (migration 0017, the preview route), `docs/superpowers/specs/2026-10-20-instalments-design.md` (its migration takes the next free number)
- Test: `tests/db/migration-0017.test.ts`, `tests/db/drafts.test.ts`, `tests/unit/publish-bar-dom.test.ts` (create)

**Interfaces:**
- Consumes: ConfirmPanel (Task 6), `contentVersion` (`lib/version.ts`).
- Produces:
  ```ts
  // schema: content_drafts(id serial pk, entity text, entity_id integer, part text, value jsonb, base_version text, version integer default 1,
  //         updated_at timestamptz default now(), updated_by text) — unique (entity, entity_id, part)
  export type DraftPart = { part: string; value: unknown; baseVersion: string; version: number; updatedAt: Date };
  export function readDrafts(q: Db | Tx, entity: string, entityId: number): Promise<DraftPart[]>;
  export function saveDraftPart(db: Db, d: { entity: string; entityId: number; part: string; value: unknown; baseVersion: string; version: number | null; by: string }):
    Promise<{ ok: true; version: number } | { ok: false; error: "conflict"; version: number; value: unknown }>;
  export function discardDrafts(db: Db, entity: string, entityId: number): Promise<number>;
  export type Publisher = { liveVersion(tx: Tx, part: string): Promise<string>; write(tx: Tx, part: string, value: unknown): Promise<void>; revalidate(): void };
  export function publishDrafts(db: Db, entity: string, entityId: number, p: Publisher): Promise<{ published: string[]; blocked: string[] }>;
  // PublishBar
  export function PublishBar(p: { changed: string[]; previewHref: string; blocked?: string[]; onDiscard(): Promise<void>; onPublish(): Promise<void> }): JSX.Element;
  ```
- **The preview route:** `GET /api/admin/eelvaade?tee=<same-origin path>` = `withAdmin`. It enables `draftMode()`, sets the existing preview cookie, and redirects 303 to the path. Any `tee` that is not a same-origin `/…` path redirects to `/`.

- [ ] **Step 1: Write the failing tests**

```ts
// migration-0017 (pattern of migration-0016.test.ts): table exists; unique (entity, entity_id, part) refuses a duplicate
// drafts
it("saveDraftPart creates version 1, then bumps; a stale version answers conflict with the stored value", ...);
it("publishDrafts copies parts whose base_version still matches live, deletes them, lists the rest as blocked", ...);
it("publishDrafts runs in one transaction: a write that throws leaves every draft in place", ...);
it("discardDrafts deletes only that entity's drafts", ...);
// publish bar
it("„Avaldamata muudatused: 3" + the changed labels, „Eelvaade ↗", „Loobu muudatustest", „Avalda muudatused"", ...);
it("„Loobu muudatustest" asks first: „Kas loobun 3 muudatusest? Avalikul lehel jääb praegune versioon." / „Jah, loobu"", ...);
it("blocked fields are listed after publish", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/db/migration-0017.test.ts tests/db/drafts.test.ts tests/unit/publish-bar-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.8, with spec C3 and §7

- The phone form follows `strings.md` W9's „Outcome“.
- No entity uses the layer yet: publishers are added with their screens in pieces 3–4.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/db/migration-0017.test.ts tests/db/drafts.test.ts tests/unit/publish-bar-dom.test.ts tests/db/schema.test.ts tests/unit/admin-guards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(admin): draft layer — content_drafts (0017), publish/discard, draftMode preview, PublishBar"
```

### Task 12: The page-level LangSwitch and I18nInput

**Files:**
- Create: `src/components/admin/EditLang.tsx` (context provider + the page `LangSwitch` + `useEditLang`), `EditLang.module.css`
- Modify:
  - `src/components/admin/I18nInput.tsx`: drop its own pills, read the context, and rename the old export to `PreviewLangSwitch`, kept only for the two previews;
  - `ListEditor.tsx` and `FaqEditor.tsx`: follow the context and remove their switches;
  - `CampaignEditor.tsx` and `NewsletterCampaignEditor.tsx`: use `PreviewLangSwitch` for their previews only;
  - `src/app/admin/(panel)/layout.tsx`: mount the provider;
  - the pages with bilingual fields, which get `<LangSwitch />` at the right of the page heading: `koolitused/[id]`, `avaleht`, `koolitaja`, `uudised/[id]`, `kampaania`, `praktika`, `seaded`, `uudiskiri` (the campaign view);
  - `src/i18n/dict/admin.ts` (`i18n` group).
- Test: `tests/unit/edit-lang-dom.test.ts` (create). Update every unit and e2e test that clicks a per-field `[data-lang-switch]` (sweep `tests/` for `data-lang`).

**Interfaces:**
- Produces:
  - `EditLangProvider`, `useEditLang(): { lang: "et" | "ru"; setLang(l): void; register(id: string, missingRu: boolean, focus: () => void): () => void }`;
  - `LangSwitch()` (page-level, no props);
  - `I18nInput` keeps its props, but `lang` and `onLangChange` are ignored.

- [ ] **Step 1: Write the failing test**

```ts
it("one switch „ET" | „RU" sets every field on the page; the choice is kept in mslab-edit-lang", ...);
it("RU mode: the ET text shows above the input with an „ET" tag; „tõlge tulekul" stays on empty RU", ...);
it("an empty RU field offers „Kopeeri eesti keelest", which copies the ET text", ...);
it("„RU puudub 2 väljal" + „Järgmine →" focuses the next empty RU field", ...);
it("validation is unchanged: RU filled with ET empty → „Täida see väli (eesti keeles)."", ...);
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/edit-lang-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.9

- The segments are 38 px inside a 44 px track.
- The ET reference is 13 px `#716a6d`.
- The copy link is 44 px tall.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/edit-lang-dom.test.ts && npx vitest run && npx playwright test tests/e2e/admin-edit.spec.ts tests/e2e/admin-site.spec.ts --project=chromium-edit`
Expected: PASS.

- [ ] **Step 5: Test plan, then commit**

Mark the checks that switch languages per field as `reworded` (sweep `testplan.json` for „RU“ steps), and add `haldus-keel-lehel` (new). Run the test-plan test.
```bash
git add -A && git commit -m "feat(admin): one ET | RU switch per page; RU mode shows the Estonian, copies it, counts what's missing"
```

### Task 13: ListToolbar, list tables and list states

**Files:**
- Create: `src/components/admin/ListToolbar.tsx`, `ListToolbar.module.css`, `src/components/admin/ListStates.tsx`
- Modify:
  - `src/components/admin/list-table.module.css`: the whole row is the link (the name `Link` stretched with `::after`; controls inside a row get `position: relative; z-index: 1`), and the container query 980 → **760 px**;
  - the pages using it (registreerimised, opilased, maksed, tagasiside, tunnistused): check that inner buttons still work.
- Test: `tests/unit/list-toolbar-dom.test.ts` (create), e2e `tests/e2e/admin-clients.spec.ts`

**Interfaces:**
- Produces:
  - `ListToolbar({ placeholder: string; pills?: { href: string; label: string; count?: number; current: boolean }[]; scope?: { label: string; name: string; options: { value: string; label: string }[]; value: string }; countLine?: string })`.
    - Search writes `?otsi=` with `router.replace` 300 ms after typing stops.
    - The scope applies on change.
    - Paging (`leht`) resets.
  - `ListEmpty({ things: string; filtered: boolean; clearHref?: string })` gives:
    - „{Asju} veel pole.“;
    - or „Selle valikuga {asju} pole.“ + „Tühjenda otsing ja filtrid“.
  - `withListParams(href: string, sp: URLSearchParams): string` keeps the filters and the search in drawer close links and back links.

- [ ] **Step 1: Write the failing test**

```ts
it("typing waits 300 ms, then router.replace(?otsi=…) with leht dropped", ...);
it("the scope select applies on change", ...);
it("pills show their count bubble; the current one has aria-current", ...);
it("empty and filtered-empty texts", ...);
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/list-toolbar-dom.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** README §1.10

The search pill is 48 px tall.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/list-toolbar-dom.test.ts && npx playwright test tests/e2e/admin-clients.spec.ts tests/e2e/admin-inbox.spec.ts --project=chromium --project=mobile`
Expected: PASS. Add one e2e check: at 1360 px, Õpilased stays a table, and a click anywhere on a row opens the drawer.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(admin): ListToolbar, whole-row links, tables down to 760 px, list states"
```

### Task 14: Docs, test plan and the whole run

**Files:**
- Modify:
  - `docs/deploy.md`: a new section for the UX pass piece 1, covering the migration 0017 apply-before-push, `/api/admin/eelvaade`, and the Shell move;
  - `docs/launch-checklist.md`: close the parked items this piece settles: in-admin unsaved warning, scroll-lock shift, list cards at 1360 px, and the review badge gap;
  - `docs/superpowers/specs/2026-10-16-test-page-design.md`: D1 now says „Testimine“ is in the menu (Q5).
- Test: everything.

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit --incremental false && npm run lint && npm run build`
Expected: all pass, and the build is clean.

- [ ] **Step 2: Run the whole e2e suite**

Run: `npx playwright test` (desktop, mobile and the edit projects)
Expected: PASS.

- [ ] **Step 3: Check the test plan**

Run: `npx vitest run tests/unit/testplan-file.test.ts tests/unit/testplan-rules.test.ts`. Then confirm that every new check has `"markedAt": "deploy"`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: UX pass piece 1 — deploy notes, closed parked items, test page in the menu"
```
