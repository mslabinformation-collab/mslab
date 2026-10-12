# MS LAB — Protocols and the Course Feedback Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the course day Maria writes one protocol per student on her tablet (notes under her own stage headings, then general notes), autosaved so that no word is lost on flaky Wi-Fi or between two devices; at the end of the day she locks and sends them in two taps, which creates the student's account when she has none and mails a login link; the student reads her protocol in her account and may fill in Maria's paper feedback form online, which Maria reads per course on a new admin page "Tagasiside".

**Architecture:**
- **Data.** One additive migration `0007_protocols.sql`: `courses.protocol_stages` (Maria's headings), `protocols` (one per registration: the draft, its `version`, and the frozen `sent` copy with `sent_at` / `sent_version`) and `course_feedback` (one per registration). The status (none / Mustand / Saadetud / Muudetud) and the open rule of the form are computed in `src/domain/protocols.ts`, never stored. The planned drop of `courses.modules` becomes `0008`.
- **Saving.** A protocol row is created by its first save, with the course's headings as they are then. Every save carries the version the screen has; the server refuses an older one and answers with what is stored (409), and a save that changes nothing raises nothing. The autosave goes through a JSON route `POST /api/admin/protokoll` (`withAdmin`), so a request can time out and be retried without queueing behind anything; the browser keeps every unsaved text in `localStorage`, keyed by registration, until the server confirms it, and resumes it on reconnect and on reload (`src/components/admin/protocol-autosave.ts`).
- **Sending.** One transaction per student (`src/server/protocols.ts sendProtocol`): the address lock, the registration, the protocol row; freeze `sent` / `sent_at` / `sent_version`; create the account and link the registration when needed. The mail (a login link that opens the protocol, the feedback line on the first send) goes out after the commit. "Lukusta ja saada kõik" runs each student separately and names any failure. The sends are server actions behind `adminAction`.
- **Student side.** `/konto/protokoll#id=<registrationId>` and `/konto/tagasiside#id=<registrationId>` are static shells like every account page; their data comes from `GET /api/konto/protokoll`, `GET|POST /api/konto/tagasiside` and `POST /api/konto/tagasiside/peida` (`private, no-store`, the dashboard's ownership rule). The dashboard card gets "Vaata protokolli"; a feedback card with "Ei soovi" appears once the form opens.
- **Admin.** `/admin/protokollid?sessioon=<id>` / `?registreering=<id>` (from Kalender, Registreerimised and the overview's "Täna" card), "Protokolli punktid" in the course editor, the "Tagasiside" page after "Maksed", and the answers in the Õpilased and Registreerimised drawers. Estonian only.

**Tech Stack:**
- Next.js 16.3.8 (pinned exactly — do not upgrade), React 19, TypeScript.
- Drizzle 0.45 + postgres.js 3.4 (Railway); PGlite for DB tests.
- Vitest (+ happy-dom for DOM tests), Playwright (dev, `E2E_PROD_BUILD=1`, and `playwright.gate.config.ts`).
- Resend for mail, Telegram for Maria's ping. No new dependency.
- Hosting: Vercel project `mslab` in Maria's team `ms-lab`, Hobby plan, region `fra1` (`docs/deploy.md`).

**Spec:** `docs/superpowers/specs/2026-10-12-protocols-design.md` (decisions D1–D6, assumptions 1–3). Read all of it before starting; the section your task names is binding. Where the code forces a different shape than the spec names, this plan says so in the task and in the Self-review's "Spec against the code" table.

## Global Constraints

### Platform limits

- **Vercel Hobby only** (no paid plans). The limits that bind this phase:
  - **1M function invocations a month.** The autosave sends one request 1.5 s after typing stops (and on blur and on switching student), never on a timer while nothing changes; a failed save is retried after 2, 5, 10, 20, then every 30 s. No polling, no new cron.
  - **4.5 MB request body**: a save of 31 boxes at their 10 000-character limit is under 2 MB (`MAX_SAVE_CHARS`).
  - **`maxDuration`**: the autosave route sets `maxDuration = 30`.
- **Never call the real Resend or Telegram from a test.** Unit and DB tests stub `fetch` (`tests/fakes.ts stubFetch`); the e2e servers have no `RESEND_API_KEY`.

### Protocols (spec §3, §4, §8)

- **One protocol per registration** (D1), contact courses only (assumption 1): a registration of an e-course has none (404 everywhere).
- **The headings are copied when a protocol is created** (its first save); a course's later changes reach only protocols not yet created (spec §9).
- **Limits** (`PROTOCOL_LIMITS` in `src/domain/protocols.ts`): at most 30 headings of at most 120 characters, trimmed, no empty ones; every note and the general notes at most 10 000 characters. Nothing is ever cut: a box over its limit says by how much, and nothing is sent until it is shortened.
- **The version check:** every save carries the version the screen has; an older one is refused with what is stored (409) and the screen reloads that protocol with a notice, showing the text it could not save. A save that changes nothing raises nothing, so "Muuda" alone never makes a protocol "Muudetud".
- **The lock order of a send:** the address lock (`client-auth.ts lockAddress`) → the registration (`seats.ts lockRegistration`) → the protocol row (`FOR UPDATE`), never the other way (the logins, `addClient` and `deleteClient` take the address lock and then write registrations). A save locks only its protocol row; a protocol's first save, whose INSERT checks its foreign key, also takes FOR KEY SHARE on the registration, so it waits behind a send that holds the registration. That cannot deadlock: a send never inserts a protocol (an empty one is refused) and waits for nothing the save holds. `tests/e2e/protocols-race.spec.ts` pins the order (a held address lock leaves the registration free).
- **Only the sent copy is ever served to the student**, never the draft. No mail contains the notes, only the link.
- **A mail never undoes a send:** it goes out after the commit (`later`), its failure is logged by the registration's id.

### Static shells, caches and the account API

- **The account pages (`/konto…`) are static.** They read only `params`. No `cookies()`, `headers()`, `connection()` or `searchParams`. Per-user data comes only from `/api/konto/*` JSON with `Cache-Control: private, no-store`. **An account page never has a query** (the middleware answers one with a 303; `tests/unit/account-guards.test.ts` refuses any code that builds one): the registration's id travels in the fragment, `#id=<n>`.
- Every `/api/konto/*` endpoint behind a session starts with `requireClient(request, deps)` and answers through `clientResponse(session, …)`; `tests/unit/account-guards.test.ts` lists them all. A non-GET request is same-origin only.
- **Ownership is the dashboard's rule:** a registration is hers when `registrations.client_id` is her account's id. Any other id answers 404.
- **The coming-soon gate:** every new account route stays gated (404 JSON for a script without the preview cookie). The admin and `/api/admin/*` pass it as today.

### Simplicity and design

- **Each screen has one plain next-step sentence and at most one primary button** (phase 2a spec 2.1 rule 5). The protocol screen's primary button is "Lukusta ja saada kõik" (one student's screen: "Saada"); the rest are secondary or text buttons.
- **Design rules (Dim): simple in steps and words, not a new look.** Use the site's components, fonts (Jost/Manrope), colour tokens (`src/styles/tokens.css` only), `ui.btn`, `ui.btnOutline`, `Icon`, `Notice`. The admin uses its `ui.module.css`, `StatusPill`, `Pager`, `Drawer`.
- **Touch targets ≥ 44 px. Widths 390 / 834 / 1194 / 1440 without horizontal overflow. Respect `prefers-reduced-motion`** (this phase adds no animation). Every new CSS file goes into `tests/unit/colour-tokens.test.ts`'s list.
- **Old iPads and phones:** iOS Safari before 16.4 cannot parse a regular expression with a lookbehind, and one such literal stops the whole script. The phase's browser code has none and never imports `src/lib/storable.ts` (its `LONE_SURROGATE` has one; it is older code, left as it is): the browser's text cleaning is `src/lib/to-storable.ts`. Every new browser file goes into `tests/unit/old-safari.test.ts`'s list.

### Admin and text rules

- **The admin is Estonian only**: its strings are in `src/i18n/dict/admin.ts`; Maria's mail and Telegram texts are Estonian in `src/server/messages.ts`.
- **Dictionaries.** Every student string goes in `src/i18n/dict/et.ts` **and** `ru.ts` (the parity, placeholder and Cyrillic tests stay green).
- **Russian typography: a no-break space (U+00A0) after the one-letter prepositions в, с, к, о, у**, as everywhere. The Russian texts are drafts for the native-speaker check (`docs/launch-checklist.md` §11, Task 12).
- **The spec's texts are used verbatim** (Russian with the no-break space rule applied): "Mustand", "Saadetud", "Muudetud pärast saatmist" / "Muudetud", "ootab ettemaksu", "Üldised märkused", "Salvestatud HH:MM", "Salvestamata — proovin uuesti", "Saada", "Lukusta ja saada kõik", "Muuda", "Saada uuesti", "Protokollid", "Ava protokoll", "Täna", "Protokolli punktid", "Vaata protokolli" / "Посмотреть протокол", "Sinu koolituse protokoll on valmis" / "Протокол вашего обучения готов", "Sinu koolituse protokolli on uuendatud" / "Протокол вашего обучения обновлён", "Soovi korral jäta meile tagasisidet" / "По желанию оставьте нам отзыв", "Kuidas koolitus läks?" + "Jäta tagasiside" / "Как прошло обучение?" + "Оставьте отзыв", "Ei soovi" / "Не хочу", "Uus tagasiside: {nimi}, {koolitus}, {score}/10", "Tagasiside", the ten questions and their options of spec §7, and the closing line "Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!" / "Спасибо, что вы часть начала и роста учебного центра MS LAB. Ваш отзыв помогает нам становиться ещё лучше!". Every other new text is listed in the Wording appendix for Dim's approval.

### The repository is PUBLIC

- **No real address in any tracked file.** `tests/unit/test-addresses.test.ts` scans `app/`, `tools/` and `docs/`, this plan included. Tests use `@example.test`, or `@example.com` where a mail must really be built and "sent" to a stubbed Resend.
- **Sample addresses (`@example.test`) are never mailed**: the protocol mail skips `isSampleAddress`. Maria's own feedback notice does go out for a sample student (her live check needs it); the live check's sample student is named "Proov (näidis)", as Maria's demo students are, so the notice says so.
- **No secrets anywhere**: no key, token, database URL or address in code, docs, tests or commit messages.
- **Logs carry ids only**: `[protocols] registration N: …`, `[feedback] registration N: …`. Never protocol text, an answer, a name or an address.
- **Never commit `.env*`**, and never read, print or use `app/.env.local`.

### The database

- **Migration `0007_protocols.sql` is additive only.** The drop of `courses.modules`, planned as 0007, becomes **0008** and stays "code first, then the migration" (Task 1 updates the texts that say 0007).
- **No Railway writes, no deploys and no push before Task 13** (the controller). Migration 0007 is applied **locally only** in Task 1 (`npm run db:migrate` against `localhost`); the e2e run refuses non-local databases (`tests/e2e/local-db.ts`). Merging into `main` deploys production, so this phase stays on `feat/protocols`, local and unpushed, until Task 13.
- **Clean-up on Railway is by exact address only.** Never `like '%naidis@example.test'`: Maria's 11 demo registrations use that pattern.

### The accounts (since 08.10.2026)

| Part | Where |
|---|---|
| Site | **https://mslab.ee** behind the coming-soon gate (`SITE_GATE=1`). |
| Hosting | Vercel team `ms-lab`, project `mslab` (Hobby, Root Directory `app`, `fra1`). |
| Deploy | A push to `main` of GitHub `mslabinformation-collab/mslab`. |
| Database | Maria's Railway project `mslab` (Postgres 18, EU West); 7 migrations today. |
| Mail | Maria's Resend, domain `send.mslab.ee`; `MARIA_EMAIL` is Maria's own inbox since 12.10, Telegram still goes to Dim. |

### Commits and dependencies

- **Commits:** Conventional Commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The repo-local `git user.email` stays the GitHub noreply address.
- **No new dependency.**

### Commands (from `app/`)

- Unit and DB tests: `npx vitest run <file>`; all: `npx vitest run`.
- Types and lint: `npx tsc --noEmit`, then `npx eslint .`.
- E2E against `next dev`: `npx playwright test <spec>`; the production build: `E2E_PROD_BUILD=1 npx playwright test <spec>`; the coming-soon gate: `npx playwright test -c playwright.gate.config.ts`.
  - A dev server you started yourself is reused by the e2e run (`reuseExistingServer`); stop it first.
- **Each task ends green on its own:** the whole `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, the e2e specs the task names (dev, and `E2E_PROD_BUILD=1` where it says so), and the gate run when the gate changes.

## Review Focus

1. **A long day on flaky Wi-Fi** (requests that fail, answers that never come, a tablet that sleeps, a tab reloaded): every word typed is kept, and a save whose answer was lost is never taken for another device's change. Tests: Task 5 `tests/unit/protocol-autosave.test.ts` "Review Focus 1" (a lost answer, then more typing; a lost answer, then six more failed saves; a reload after a lost answer) and its storage-full test, Task 11 `protocols.spec.ts` "Review Focus 1".
2. **Two devices or two tabs on one protocol:** the older screen never overwrites the newer text; it shows the stored text with a notice and keeps its own unsaved words visible in that notice. Tests: Task 2 `tests/db/protocols-save.test.ts` "Review Focus 2", Task 5 `protocol-autosave.test.ts` "two devices (Review Focus 2)" (the notice's words outlive a reload too).
3. **A registration cancelled or moved while the screen is open:** what Maria types still saves (nothing lost), "Saada" refuses with "Registreering on tühistatud: protokolli ei saadeta." instead of sending, and a moved registration's protocol shows under its new session. Tests: Task 2 "Review Focus 3" (the save), Task 3 (the send refused), Task 6 `protocol-send-dom.test.ts` "Review Focus 3" (the line), Task 10 (moved).
4. **Huge pasted text** (more than 10 000 characters into one box, or invisible control characters from a pasted document): nothing is cut and nothing is lost; the box says "Liiga pikk: {n} / 10000 märki", nothing is sent until it is shortened, the text stays in the browser's copy; control characters are dropped, the words kept. Tests: Task 2 "Review Focus 4" (the server refuses, with the box), Task 5 `protocol-autosave.test.ts` and `protocol-screen-dom.test.ts` "Review Focus 4".
5. **A Russian-speaking student:** the mails, the protocol page's frame, the dashboard card and the feedback form are Russian (the registration's or the page's language), Maria's text is shown as written, and Maria's notice of a Russian answer is in her Estonian wording. Tests: Task 3 `protocols-send.test.ts` "Review Focus 5", Task 7 `account-protocol-dom.test.ts` "Review Focus 5", Task 8 `feedback.test.ts` and `feedback-form-dom.test.ts` "Review Focus 5".

---

## File Structure

```
app/
  drizzle/0007_protocols.sql                     generated: courses.protocol_stages, protocols, course_feedback (Task 1)
  src/db/schema.ts                               protocolStages, ProtocolStage, SentProtocol, protocols, courseFeedback (Task 1)
  src/domain/protocols.ts                        pure: status, headings, limits, the open rule, the questions, the answers' check (Task 1)
  src/lib/to-storable.ts                         toStorable: pasted text without what Postgres cannot store, browser-safe (Task 1)
  src/db/queries/protocols.ts                    draftOf, protocolScreen (Task 2); todaySessions (Task 5); studentProtocol (Task 7);
                                                 the admin's feedback lists and stats (Task 9)
  src/server/protocols.ts                        saveProtocol, handleSave (Task 2); sendProtocol, sendProtocols, the mail (Task 3)
  src/app/api/admin/protokoll/route.ts           the autosave, withAdmin (Task 2)
  src/server/actions/admin-protocols.ts          sendProtocolAction, sendProtocolsAction (Task 3)
  src/server/account-mail.ts                     protocolMail, protocolUrl, feedbackUrl, verifyLink's protocol target (Task 3)
  src/server/account-api.ts                      verify → the protocol (Task 3); GET /protokoll (Task 7); GET|POST /tagasiside, POST /tagasiside/peida (Task 8)
  src/components/account/useAccount.ts           the login mark keeps #id (Task 3)
  src/domain/course-editor.ts, server/admin-content.ts, components/admin/CourseEditor.tsx
                                                 "Protokolli punktid" (Task 4)
  src/components/admin/ProtocolStagesEditor.tsx  the headings' list (Task 4)
  src/app/admin/(panel)/protokollid/page.tsx     the course day's screen (Task 5)
  src/components/admin/ProtocolScreen.tsx (+css) the student list, the editor, the save status (Task 5); the send parts placed (Task 6)
  src/components/admin/protocol-autosave.ts      the autosave: debounce, retries, the browser's copy, conflicts (Task 5)
  src/components/admin/GrowingText.tsx           a box that grows with its text (Task 5)
  src/components/admin/ProtocolSend.tsx          "Saada", "Muuda", "Saada uuesti", "Lukusta ja saada kõik" (Task 6)
  src/app/admin/(panel)/kalender/page.tsx, registreerimised/page.tsx, page.tsx (+overview.module.css)
                                                 the entry points (Task 5); the registration drawer's answers (Task 9)
  src/domain/account-cards.ts                    ContactCard / IndividualCard protocolSent (Task 7); FeedbackPrompt (Task 8)
  src/server/client-data.ts                      loadDashboard: protocolSent (Task 7), feedback prompts (Task 8); deleteClient (Task 10)
  src/components/account/AccountCourseCard.tsx   "Vaata protokolli" (Task 7)
  src/components/account/useHashId.ts            the fragment's #id (Task 7)
  src/components/account/ProtocolPage.tsx (+css) the student's protocol (Task 7)
  src/components/account/AccountPage.module.css, AccountNotFound.tsx   the page and the not-found notice the protocol and the form share (Task 7)
  src/app/[locale]/(site)/konto/protokoll/page.tsx    the static shell (Task 7)
  src/server/course-feedback.ts                  feedbackState, submitFeedback, hideFeedback, notifyFeedback (Task 8)
  src/server/messages.ts                         feedbackSummary (Task 8)
  src/components/account/FeedbackCard.tsx        the dashboard's card with "Ei soovi" (Task 8)
  src/components/account/FeedbackForm.tsx (+css) the form (Task 8)
  src/app/[locale]/(site)/konto/tagasiside/page.tsx   the static shell (Task 8)
  src/app/admin/(panel)/tagasiside/page.tsx (+css)    "Tagasiside" (Task 9)
  src/components/admin/FeedbackAnswers.tsx (+css)     the answers in Maria's wording (Task 9)
  src/components/admin/sections.ts, AdminIcon.tsx, ClientDrawer.tsx, server/admin-clients.ts   the menu and the drawers (Task 9)
  src/lib/site-routing.ts                        the two new shells, #id (Task 7, 8)
  src/i18n/dict/et.ts, ru.ts, admin.ts           the texts of each task
  tests/unit/old-safari.test.ts                  no lookbehind in the phase's browser files (Task 1; each task adds its files)
  tests/e2e/protocols.ts                         the e2e fixtures (Task 11)
  tests/e2e/protocols.spec.ts, protocols-race.spec.ts   every flow end to end; two sends at once on real Postgres (Task 11)
docs/deploy.md, docs/launch-checklist.md         0008 (Task 1); the runbook and the go-live list (Task 12)
```

---

### Task 1: Migration 0007 — `courses.protocol_stages`, `protocols`, `course_feedback`; the pure rules

Spec sections 3, 7 and 10 (unit). Columns, two tables and the rules every later task uses; nothing writes a protocol or an answer yet. The drop of `courses.modules` becomes 0008.

**Where the JSON shapes live.** `ProtocolStage` and `SentProtocol` are the columns' shapes: in `src/db/schema.ts`, next to `BadgeLabel`. `FeedbackAnswers` is defined by the questions' keys: in `src/domain/protocols.ts`. The two files import each other's types only (`import type`, erased), as `schema.ts` already imports `I18n`.

**Files:**
- Modify: `app/src/db/schema.ts` (the imports, lines 1–3; `courses`, lines 34 and 45; after `payments`, line 279; the type list, lines 389–413)
- Create: `app/drizzle/0007_protocols.sql` (+ `app/drizzle/meta/0007_snapshot.json` and the `_journal.json` entry, from drizzle-kit)
- Create: `app/src/domain/protocols.ts`
- Create: `app/src/lib/to-storable.ts`; Modify: `app/src/lib/storable.ts` (its control-character class from there: one line)
- Modify (the 0008 texts): `app/drizzle/0003_lessons.sql:55` (comment only), `app/tests/db/migration-0003.test.ts:14` (comment), `docs/launch-checklist.md:107`, `docs/deploy.md` §6, `docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md` (lines 82, 192, 307, 461, 4500, 5204, 5221, 5227, 5300, 5301, 5310), `docs/superpowers/plans/2026-10-09-phase2b-montonio-payments.md:7797`
- Test: `app/tests/db/migration-0007.test.ts`, `app/tests/unit/protocols.test.ts`, `app/tests/unit/old-safari.test.ts` (new)

**Interfaces:**
- Produces, from `src/db/schema.ts`:
  - `courses.protocolStages: string[]` (jsonb, not null, default `[]`);
  - `type ProtocolStage = { title: string; note: string }`; `type SentProtocol = { stages: ProtocolStage[]; generalNote: string }`;
  - the table `protocols` (`id, registrationId, stages, generalNote, version, sent, sentAt, sentVersion, createdAt, updatedAt`; unique index `protocols_registration`) and `type Protocol = typeof protocols.$inferSelect`;
  - the table `courseFeedback` (`course_feedback`: `id, registrationId, answers, locale, submittedAt, dismissedAt, createdAt`; unique index `course_feedback_registration`, index `course_feedback_submitted`) and `type CourseFeedback = typeof courseFeedback.$inferSelect`.
- Produces, from `src/domain/protocols.ts`:
  - `PROTOCOL_LIMITS = { stages: 30, title: 120, note: 10_000 }`;
  - `type ProtocolStatus = "none" | "draft" | "sent" | "changed"`; `protocolStatus(row: { sentAt: Date | string | null; version: number; sentVersion: number | null } | null): ProtocolStatus`;
  - `readStages(value: unknown): string[]`; `checkStages(list: readonly string[]): { ok: true; stages: string[] } | { ok: false; error: "tooMany" | "tooLong" }`; `stagesFrom(headings: readonly string[]): ProtocolStage[]`;
  - `hasText(p: { stages: readonly ProtocolStage[]; generalNote: string }): boolean`; `type NotePlace = number | "general"`; `overLimit(notes: readonly string[], generalNote: string): NotePlace[]`; `newToSend(status: ProtocolStatus, written: boolean): boolean`;
  - `feedbackOpen(r: { status: RegStatus; kind: "group" | "individual"; session: { startsAt: Date; cancelled: boolean } | null; protocolSentAt: Date | null }, now: Date): boolean`;
  - `FEEDBACK_CHOICES` (the seven choice questions and their option keys), `FEEDBACK_TEXTS = ["recommend", "message"]`, `FEEDBACK_ORDER` (the ten keys in the paper form's order), `type ChoiceKey`, `type TextKey`, `type FeedbackKey`, `FEEDBACK_TEXT_MAX = 2000`, `type FeedbackAnswers`;
  - `isChoice(key: string): key is ChoiceKey`; `type FeedbackCheck = { ok: true; answers: FeedbackAnswers } | { ok: false; error: string }`; `checkFeedback(value: unknown): FeedbackCheck`;
  - `feedbackOpenFor(row: { status; kind; startsAt: Date | null; sessionStatus: string | null; protocolSentAt: Date | null }, now): boolean` (the open rule from a joined row);
  - `type OptionCounts`; `type FeedbackSummary = { count: number; scored: number; average: number | null; options: OptionCounts }`; `summarizeFeedback(list: readonly FeedbackAnswers[]): FeedbackSummary`;
  - `type FeedbackQuestionTexts = { [K in FeedbackKey]: { label: string; options?: Record<string, string> } }`; `feedbackQuestions(questions: object): FeedbackQuestionTexts` (the one cast of a dictionary's questions); `answerText(key: FeedbackKey, value: string | number, q: FeedbackQuestionTexts): string`.
- Produces, from `src/lib/to-storable.ts` (browser-safe: no lookbehind): `CONTROL_CLASS` (the control characters' class, which `storable.ts` builds its `CONTROL` from), `toStorable(s: string): string`.
- Produces: `tests/unit/old-safari.test.ts` with its `BROWSER_FILES` list (later tasks add their browser files).

- [ ] **Step 1: Write the failing migration test** `tests/db/migration-0007.test.ts`:

```ts
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseFeedback, courses, protocols, registrations } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0007 (protocols) as the Railway database goes through it: 0000–0006 applied, a contact course and a registration written by the
// live code (which knows no protocol_stages), then 0007. The course gets no headings ([]), and the two new tables are there, empty, with their
// rules: one protocol and one feedback row per registration, both deleted with their registration. Additive: nothing else changes.

test("0007 gives every course an empty protocol_stages and adds protocols and course_feedback, one per registration, deleted with it", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0006_phase2b_payments");
  // the live code's inserts (raw SQL: drizzle would name the new column)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  const [{ id: courseId }] = await db.select({ id: courses.id }).from(courses);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${courseId}, 'individual', 'Kati', 'kati@example.test', 'full')`);

  await through("0007_protocols");

  const [course] = await db.select().from(courses);
  expect(course.protocolStages).toEqual([]);
  expect(await db.select().from(protocols)).toEqual([]);
  expect(await db.select().from(courseFeedback)).toEqual([]);
  const [reg] = await db.select({ id: registrations.id }).from(registrations);

  const [p] = await db.insert(protocols).values({ registrationId: reg.id, stages: [{ title: "Ettevalmistus", note: "" }] }).returning();
  expect(p).toMatchObject({ generalNote: "", version: 1, sent: null, sentAt: null, sentVersion: null });
  expect(p.createdAt).toBeInstanceOf(Date);
  await expect(db.insert(protocols).values({ registrationId: reg.id, stages: [] })).rejects.toThrow(); // one per registration
  const [f] = await db.insert(courseFeedback).values({ registrationId: reg.id }).returning();
  expect(f).toMatchObject({ answers: null, locale: null, submittedAt: null, dismissedAt: null });
  await expect(db.insert(courseFeedback).values({ registrationId: reg.id })).rejects.toThrow();

  await db.delete(registrations).where(eq(registrations.id, reg.id));
  expect(await db.select().from(protocols)).toEqual([]);
  expect(await db.select().from(courseFeedback)).toEqual([]);
});
```

- [ ] **Step 2: Run it — expect FAIL.** `cd app && npx vitest run tests/db/migration-0007.test.ts` fails: `protocols`, `courseFeedback` and `protocolStages` do not exist (a failed transform), or `migrationsThrough("0007_protocols")` fails its own `expect(at).toBeGreaterThanOrEqual(0)`.

- [ ] **Step 3: Change the schema** (`src/db/schema.ts`).
  1. After `import type { I18n } from "@/i18n/field";` add:

```ts
import type { FeedbackAnswers } from "@/domain/protocols";
```

  2. The comment above `courses.modules` becomes:

```ts
  // Legacy (phase 3a): module titles live in course_modules; nothing reads or writes this column. Migration 0008 drops it after the 3a deploy (code first).
```

  3. In `courses`, after `recommendationIds: …,` add:

```ts
  /**
   * Maria's stage headings for a contact course's protocols (phase protocols, spec §3): plain strings in the language she writes in, not
   * translated; at most 30, each at most 120 characters, trimmed, no empty ones (domain/protocols.ts checkStages). A protocol copies them when
   * it is created (its first save); a change here reaches only protocols not created yet.
   */
  protocolStages: jsonb("protocol_stages").$type<string[]>().notNull().default([]),
```

  4. After the `payments` table (after its closing `);`), add:

```ts
// ---------- protocols and the course feedback form ----------

/** One stage of a protocol: Maria's heading (copied from the course) and her note under it. */
export type ProtocolStage = { title: string; note: string };
/** What the student sees: the copy "Saada" froze (server/protocols.ts sendProtocol). */
export type SentProtocol = { stages: ProtocolStage[]; generalNote: string };

/**
 * A registration's protocol (spec §3, D1): the practice part (`stages`) and the training part (`generalNote`), written by Maria on the course
 * day. `version` rises with every saved change (server/protocols.ts saveProtocol refuses a save made from an older one). "Saada" freezes the
 * draft into `sent` with `sentAt` and `sentVersion`; the student is only ever served `sent`. The status is computed (domain/protocols.ts
 * protocolStatus): none without a row, a draft until sent, sent while version = sentVersion, changed after. Deleted with the registration, and
 * with the account (server/client-data.ts deleteClient).
 */
export const protocols = pgTable(
  "protocols",
  {
    id: serial("id").primaryKey(),
    registrationId: integer("registration_id").notNull().references(() => registrations.id, { onDelete: "cascade" }),
    stages: jsonb("stages").$type<ProtocolStage[]>().notNull(),
    generalNote: text("general_note").notNull().default(""),
    version: integer("version").notNull().default(1),
    sent: jsonb("sent").$type<SentProtocol>(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentVersion: integer("sent_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("protocols_registration").on(t.registrationId)],
);

/**
 * The end-of-course feedback form of one registration (spec §7): Maria's paper form "Sinu kogemus MS LAB koolitusel", answered online.
 * `answers` holds keys (domain/protocols.ts FEEDBACK_ORDER), never texts, so a wording fix never breaks an old answer. A row is made by
 * the submit (`submittedAt`) or by "Ei soovi" (`dismissedAt`, `answers` null); one per registration. Deleted with the registration, and with
 * the account.
 */
export const courseFeedback = pgTable(
  "course_feedback",
  {
    id: serial("id").primaryKey(),
    registrationId: integer("registration_id").notNull().references(() => registrations.id, { onDelete: "cascade" }),
    answers: jsonb("answers").$type<FeedbackAnswers>(),
    locale: text("locale").$type<"et" | "ru">(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("course_feedback_registration").on(t.registrationId), index("course_feedback_submitted").on(t.submittedAt)],
);
```

  5. At the end of the type list, add:

```ts
export type Protocol = typeof protocols.$inferSelect;
export type CourseFeedback = typeof courseFeedback.$inferSelect;
```

- [ ] **Step 4: Generate the migration.** Run `cd app && npx drizzle-kit generate --name protocols`. Open `drizzle/0007_protocols.sql`. It must hold these statements (in drizzle-kit's order and formatting) and **nothing** that drops or rewrites:
  - `CREATE TABLE "course_feedback" (…)` with the seven columns of step 3.4 (`"id" serial PRIMARY KEY NOT NULL`, `"registration_id" integer NOT NULL`, `"answers" jsonb`, `"locale" text`, `"submitted_at" timestamp with time zone`, `"dismissed_at" timestamp with time zone`, `"created_at" timestamp with time zone DEFAULT now() NOT NULL`);
  - `CREATE TABLE "protocols" (…)` with the ten columns (`"stages" jsonb NOT NULL`, `"general_note" text DEFAULT '' NOT NULL`, `"version" integer DEFAULT 1 NOT NULL`, `"sent" jsonb`, `"sent_at" timestamp with time zone`, `"sent_version" integer`, `created_at` and `updated_at` with `DEFAULT now() NOT NULL`);
  - `ALTER TABLE "courses" ADD COLUMN "protocol_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;`
  - the two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;` lines (course_feedback, protocols);
  - `CREATE UNIQUE INDEX "course_feedback_registration" …`, `CREATE INDEX "course_feedback_submitted" …`, `CREATE UNIQUE INDEX "protocols_registration" ON "protocols" USING btree ("registration_id");`.
  - No data step: the column's default fills every existing course.

- [ ] **Step 5: Run** `npx vitest run tests/db/migration-0007.test.ts` — expect PASS.

- [ ] **Step 6: Write the failing rule tests** `tests/unit/protocols.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  checkFeedback, checkStages, FEEDBACK_CHOICES, FEEDBACK_ORDER, FEEDBACK_TEXT_MAX, feedbackOpen, feedbackOpenFor, hasText, isChoice, newToSend, overLimit, PROTOCOL_LIMITS,
  protocolStatus, readStages, stagesFrom, summarizeFeedback,
} from "@/domain/protocols";
import { storable } from "@/lib/storable";
import { toStorable } from "@/lib/to-storable";

// The protocols' and the feedback form's pure rules (spec §3, §7, §10 unit): the status table, the headings and their limits, what a save
// may hold, the open rule at the Tallinn date's edges, and the answers' check.

describe("a protocol's status (spec §3)", () => {
  test("none without a row; a draft until it is sent; sent while the version is the sent one; changed after a saved edit", () => {
    expect(protocolStatus(null)).toBe("none");
    expect(protocolStatus({ sentAt: null, version: 3, sentVersion: null })).toBe("draft");
    expect(protocolStatus({ sentAt: new Date("2026-10-12T15:00:00Z"), version: 3, sentVersion: 3 })).toBe("sent");
    expect(protocolStatus({ sentAt: "2026-10-12T15:00:00.000Z", version: 4, sentVersion: 3 })).toBe("changed");
  });
});

describe("the stage headings (spec §3)", () => {
  test("the course editor's list: trimmed, blank rows dropped; more than 30, or one over 120 characters, refused", () => {
    expect(checkStages([" Ettevalmistus ", "", "  ", "Värvimine"])).toEqual({ ok: true, stages: ["Ettevalmistus", "Värvimine"] });
    expect(checkStages(Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`))).toMatchObject({ ok: true });
    expect(checkStages(Array.from({ length: 31 }, (_, i) => `Punkt ${i + 1}`))).toEqual({ ok: false, error: "tooMany" });
    expect(checkStages(["x".repeat(120)])).toMatchObject({ ok: true });
    expect(checkStages(["x".repeat(121)])).toEqual({ ok: false, error: "tooLong" });
    expect(checkStages([`  ${"x".repeat(120)}  `])).toMatchObject({ ok: true }); // trimmed before it is measured
    expect(checkStages([])).toEqual({ ok: true, stages: [] });
  });

  test("as stored (jsonb: anything): strings only, trimmed, no blanks, at most 30 of at most 120 characters", () => {
    expect(readStages(["  Ettevalmistus ", 7, "", null, "Kulmude analüüs"])).toEqual(["Ettevalmistus", "Kulmude analüüs"]);
    expect(readStages(null)).toEqual([]);
    expect(readStages({ et: "x" })).toEqual([]);
    expect(readStages(Array.from({ length: 40 }, (_, i) => `P${i}`))).toHaveLength(PROTOCOL_LIMITS.stages);
    expect(readStages(["y".repeat(200)])).toEqual(["y".repeat(PROTOCOL_LIMITS.title)]);
  });

  test("a new protocol copies them, each with an empty note", () => {
    expect(stagesFrom(["Ettevalmistus", "Värvimine"])).toEqual([
      { title: "Ettevalmistus", note: "" },
      { title: "Värvimine", note: "" },
    ]);
  });
});

describe("what a protocol holds", () => {
  test("hasText: a note or the general notes, blank text does not count", () => {
    expect(hasText({ stages: [{ title: "A", note: "  \n " }], generalNote: " " })).toBe(false);
    expect(hasText({ stages: [{ title: "A", note: "hea" }], generalNote: "" })).toBe(true);
    expect(hasText({ stages: [], generalNote: "Üldiselt hästi" })).toBe(true);
  });

  test("overLimit names each box over 10 000 characters, the general notes as 'general'", () => {
    const long = "ä".repeat(PROTOCOL_LIMITS.note + 1);
    expect(overLimit(["ok", "x".repeat(PROTOCOL_LIMITS.note)], "")).toEqual([]);
    expect(overLimit(["ok", long, long], long)).toEqual([1, 2, "general"]);
  });

  test("'Lukusta ja saada kõik' takes what has text and is not sent as it is", () => {
    expect(newToSend("draft", true)).toBe(true);
    expect(newToSend("none", true)).toBe(true); // typed, its first save not answered yet
    expect(newToSend("changed", true)).toBe(true);
    expect(newToSend("sent", true)).toBe(false);
    for (const status of ["none", "draft", "changed", "sent"] as const) expect(newToSend(status, false)).toBe(false);
  });
});

describe("when the feedback form opens (spec §3), at the Tallinn date's edges", () => {
  const group = (startsAt: string, over: Partial<Parameters<typeof feedbackOpen>[0]> = {}) => ({
    status: "confirmed" as const,
    kind: "group" as const,
    session: { startsAt: new Date(startsAt), cancelled: false },
    protocolSentAt: null,
    ...over,
  });

  test("a group session that started before today (Tallinn) opens it; one that starts today does not, whatever the hour", () => {
    // 11.10.2026 23:30 in Tallinn (summer time, UTC+3)
    const late = "2026-10-11T20:30:00Z";
    expect(feedbackOpen(group(late), new Date("2026-10-11T20:50:00Z"))).toBe(false); // 23:50 the same evening
    expect(feedbackOpen(group(late), new Date("2026-10-11T21:10:00Z"))).toBe(true); // 00:10 on 12.10
    expect(feedbackOpen(group("2026-10-12T07:00:00Z"), new Date("2026-10-12T20:59:00Z"))).toBe(false); // the course day itself
    // winter time (UTC+2): 14.11 10:00, asked at 00:30 on 15.11
    expect(feedbackOpen(group("2026-11-14T08:00:00Z"), new Date("2026-11-14T22:30:00Z"))).toBe(true);
  });

  test("a sent protocol opens it at once, for an individual course too; a cancelled registration never; a called-off session not by its date", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    expect(feedbackOpen({ status: "confirmed", kind: "individual", session: null, protocolSentAt: new Date("2026-10-12T11:00:00Z") }, now)).toBe(true);
    expect(feedbackOpen({ status: "awaiting_prepayment", kind: "individual", session: null, protocolSentAt: null }, now)).toBe(false);
    expect(feedbackOpen(group("2026-10-12T07:00:00Z", { protocolSentAt: new Date("2026-10-12T11:00:00Z") }), now)).toBe(true);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { status: "cancelled" }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { status: "cancelled", protocolSentAt: new Date() }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { session: { startsAt: new Date("2026-10-01T07:00:00Z"), cancelled: true } }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { kind: "individual" }), now)).toBe(false); // only a group opens by its date
  });

  test("feedbackOpenFor: the same rule from a row read with its session and protocol", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    const row = { status: "confirmed" as const, kind: "group" as const, startsAt: new Date("2026-10-01T07:00:00Z"), sessionStatus: "scheduled", protocolSentAt: null };
    expect(feedbackOpenFor(row, now)).toBe(true);
    expect(feedbackOpenFor({ ...row, sessionStatus: "cancelled" }, now)).toBe(false);
    expect(feedbackOpenFor({ ...row, kind: "individual", startsAt: null, sessionStatus: null }, now)).toBe(false);
    expect(feedbackOpenFor({ ...row, kind: "individual", startsAt: null, sessionStatus: null, protocolSentAt: now }, now)).toBe(true);
  });
});

describe("the feedback answers (spec §7)", () => {
  test("the known keys, each of the right kind; null is not answered", () => {
    expect(checkFeedback({ score: 8, expectations: "met", message: "  Aitäh!  " })).toEqual({ ok: true, answers: { score: 8, expectations: "met", message: "Aitäh!" } });
    expect(checkFeedback({ score: null, clarity: "very_clear" })).toEqual({ ok: true, answers: { clarity: "very_clear" } });
    const all = { score: 10, expectations: "exceeded", clarity: "fairly_clear", balance: "more_practice", ready: "mostly", trainer: "excellent", safe: "very", materials: "rather_yes", recommend: "Jah", message: "Väga hea" };
    expect(checkFeedback(all)).toEqual({ ok: true, answers: all });
  });

  test("an unknown key, an out-of-range score, an unknown option, a text too long or not storable: the key that is wrong", () => {
    expect(checkFeedback({ score: 8, extra: "x" })).toEqual({ ok: false, error: "answers" });
    for (const score of [0, 11, 7.5, "8", true]) expect(checkFeedback({ score })).toEqual({ ok: false, error: "score" });
    expect(checkFeedback({ expectations: "met", clarity: "nope" })).toEqual({ ok: false, error: "clarity" });
    expect(checkFeedback({ ready: 3 })).toEqual({ ok: false, error: "ready" });
    expect(checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX) })).toMatchObject({ ok: true });
    expect(checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX + 1) })).toEqual({ ok: false, error: "message" });
    expect(checkFeedback({ recommend: "nul\u0000" })).toEqual({ ok: false, error: "recommend" });
    expect(checkFeedback({ recommend: 5 })).toEqual({ ok: false, error: "recommend" });
  });

  test("nothing answered is an empty submit; anything that is not an object is no answers", () => {
    for (const empty of [{}, { message: "   " }, { score: null, recommend: "" }]) expect(checkFeedback(empty)).toEqual({ ok: false, error: "empty" });
    for (const bad of [null, undefined, [], "x", 8]) expect(checkFeedback(bad)).toEqual({ ok: false, error: "answers" });
  });

  test("the paper form's order and options; isChoice names the seven choice questions only", () => {
    expect(FEEDBACK_ORDER.filter(isChoice)).toEqual(["expectations", "clarity", "balance", "ready", "trainer", "safe", "materials"]);
    expect(["constructor", "__proto__", "score", "message"].some(isChoice)).toBe(false);
    expect(FEEDBACK_ORDER).toEqual(["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"]);
    expect(FEEDBACK_CHOICES).toEqual({
      expectations: ["exceeded", "met", "not_met"],
      clarity: ["very_clear", "fairly_clear", "needs_work"],
      balance: ["ideal", "more_practice", "more_theory"],
      ready: ["fully", "mostly", "rather_not", "no"],
      trainer: ["excellent", "good", "satisfactory", "needs_growth"],
      safe: ["very", "rather_yes", "rather_not"],
      materials: ["yes", "rather_yes", "rather_not", "no"],
    });
  });

  test("summarizeFeedback: how many, the average score of those that gave one (one decimal), and every option's count", () => {
    const s = summarizeFeedback([{ score: 9, expectations: "exceeded" }, { score: 8, expectations: "met", safe: "very" }, { message: "hea" }]);
    expect([s.count, s.scored, s.average]).toEqual([3, 2, 8.5]);
    expect(s.options.expectations).toEqual({ exceeded: 1, met: 1, not_met: 0 });
    expect(s.options.safe).toEqual({ very: 1, rather_yes: 0, rather_not: 0 });
    expect(summarizeFeedback([{ message: "x" }]).average).toBeNull();
    expect(summarizeFeedback([{ score: 7 }, { score: 8 }, { score: 8 }]).average).toBe(7.7);
  });
});

describe("toStorable", () => {
  test("drops the control characters and lone surrogates Postgres refuses, keeps the words, tabs and line breaks", () => {
    const pasted = "Kulmud\u000bhästi\u0000\tjah\r\nlõpp\ud800";
    expect(storable(pasted)).toBe(false);
    expect(toStorable(pasted)).toBe("Kulmudhästi\tjah\r\nlõpp");
    expect(storable(toStorable(pasted))).toBe(true);
    expect(toStorable("Привет 👋")).toBe("Привет 👋");
  });

  test("storable.ts's rule, character by character: what storable refuses toStorable drops, and nothing else", () => {
    for (let c = 0; c <= 0x7f; c++) {
      const s = `a${String.fromCharCode(c)}b`;
      expect(toStorable(s) === s, `U+${c.toString(16)}`).toBe(storable(s));
    }
    for (const s of ["\ud83d\udc4b", "\ud800", "\udc00", "\udc00\ud800", "a\ud800b\udc00c", "\ud83d\ud83d\udc4b"]) expect(toStorable(s) === s, JSON.stringify(s)).toBe(storable(s));
    expect(toStorable("\ud83d\ud83d\udc4b")).toBe("\ud83d\udc4b"); // a lone high surrogate before a pair: only it goes
  });
});
```

  And `tests/unit/old-safari.test.ts` (new):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The course day's screen runs on Maria's tablet and the account's pages on the students' phones: iOS Safari before 16.4 cannot parse a
// regular expression with a lookbehind, and one such literal stops the whole script. The phase's browser files have none, and they never
// import src/lib/storable.ts, whose LONE_SURROGATE has one (older code, left as it is): lib/to-storable.ts is the browser's text cleaning.
// Each task adds its browser files here.

const BROWSER_FILES = [
  // phase protocols, Task 1
  "src/lib/to-storable.ts",
  "src/domain/protocols.ts",
];
const LOOKBEHIND = new RegExp(["\\(\\?<", "="].join("") + "|" + ["\\(\\?<", "!"].join(""));
const STORABLE_IMPORT = /from "(@\/lib\/storable|(\.\.?\/)+(lib\/)?storable)"/;

test("no lookbehind in the phase's browser files, and none of them imports lib/storable", () => {
  for (const f of BROWSER_FILES) {
    const source = readFileSync(join(process.cwd(), f), "utf8");
    expect(source, f).not.toMatch(LOOKBEHIND);
    expect(source, f).not.toMatch(STORABLE_IMPORT);
  }
});

test("the check sees a lookbehind", () => {
  expect("/(?" + "<!x)y/").toMatch(LOOKBEHIND);
  expect('import { storable } from "@/lib/storable";').toMatch(STORABLE_IMPORT);
});
```

(`answerText` is tested with the questions' texts in Task 8, which adds them to the dictionaries.)

- [ ] **Step 7: Run it — expect FAIL**: `npx vitest run tests/unit/protocols.test.ts tests/unit/old-safari.test.ts` (`@/domain/protocols` and `@/lib/to-storable` do not exist).

- [ ] **Step 8: Write `src/domain/protocols.ts`:**

```ts
// The protocols' and the course feedback form's pure rules (phase protocols, spec §3, §4, §7): a protocol's status, the stage headings a
// course copies into a new protocol and their limits, what a save may hold, the feedback form's fixed questions and their stored keys, the
// answers' check, and when the form opens. No database, no React: the admin's screen, the account's pages and the server share them.

import type { ProtocolStage } from "@/db/schema";
import { toStorable } from "@/lib/to-storable"; // (never lib/storable here: this file runs in the browser too, tests/unit/old-safari.test.ts)
import { tallinnFormParts } from "./calendar";
import type { RegStatus } from "./registration";

/** At most 30 headings of at most 120 characters; every note and the general notes at most 10 000 characters (spec §3). */
export const PROTOCOL_LIMITS = { stages: 30, title: 120, note: 10_000 } as const;

/** none: no protocol yet; draft (Mustand): not sent; sent (Saadetud): the sent version; changed (Muudetud pärast saatmist): edited since. */
export type ProtocolStatus = "none" | "draft" | "sent" | "changed";

/** The status of a protocol row (spec §3's table), or "none" without one. Never stored. */
export function protocolStatus(row: { sentAt: Date | string | null; version: number; sentVersion: number | null } | null): ProtocolStatus {
  if (row === null) return "none";
  if (row.sentAt === null || row.sentVersion === null) return "draft";
  return row.version > row.sentVersion ? "changed" : "sent";
}

/** A course's headings as stored (jsonb: anything): its strings, trimmed, the blank ones left out, at most 30 of at most 120 characters. */
export function readStages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim().slice(0, PROTOCOL_LIMITS.title)] : []))
    .slice(0, PROTOCOL_LIMITS.stages);
}

/** The course editor's "Protokolli punktid" as typed: trimmed, the blank rows dropped; more than 30, or one longer than 120, refused. */
export function checkStages(list: readonly string[]): { ok: true; stages: string[] } | { ok: false; error: "tooMany" | "tooLong" } {
  const stages = list.map((s) => s.trim()).filter(Boolean);
  if (stages.some((s) => s.length > PROTOCOL_LIMITS.title)) return { ok: false, error: "tooLong" };
  if (stages.length > PROTOCOL_LIMITS.stages) return { ok: false, error: "tooMany" };
  return { ok: true, stages };
}

/** A new protocol's practice part: the course's headings, each with an empty note (spec §3: copied when the protocol is created). */
export const stagesFrom = (headings: readonly string[]): ProtocolStage[] => headings.map((title) => ({ title, note: "" }));

/** Is anything written: a note under a stage, or the general notes? Blank text does not count. */
export const hasText = (p: { stages: readonly ProtocolStage[]; generalNote: string }): boolean =>
  p.generalNote.trim() !== "" || p.stages.some((s) => s.note.trim() !== "");

/** A note box: its stage's index, or the general notes. */
export type NotePlace = number | "general";

/** The boxes longer than PROTOCOL_LIMITS.note: the screen says so under each, and nothing is sent until they are shortened. */
export function overLimit(notes: readonly string[], generalNote: string): NotePlace[] {
  const out: NotePlace[] = notes.flatMap((n, i) => (n.length > PROTOCOL_LIMITS.note ? [i] : []));
  if (generalNote.length > PROTOCOL_LIMITS.note) out.push("general");
  return out;
}

/**
 * "Lukusta ja saada kõik" sends a protocol that has something new (spec §4): one with text that is not sent as it is — a draft (or one whose
 * first save is still on its way: "none" with text), or one changed after it was sent. One without text is skipped and named.
 */
export const newToSend = (status: ProtocolStatus, written: boolean): boolean => written && status !== "sent";

/** The date of an instant in Estonian time, "2026-10-12": it compares as text. */
const tallinnDate = (d: Date): string => tallinnFormParts(d).date;

/**
 * Does the feedback form open for a registration (spec §3, §9)? Never when it is cancelled. Then when its protocol has been sent, or when it is
 * a group registration whose session started before today in Tallinn and was not called off.
 */
export function feedbackOpen(
  r: { status: RegStatus; kind: "group" | "individual"; session: { startsAt: Date; cancelled: boolean } | null; protocolSentAt: Date | null },
  now: Date,
): boolean {
  if (r.status === "cancelled") return false;
  if (r.protocolSentAt !== null) return true;
  return r.kind === "group" && r.session !== null && !r.session.cancelled && tallinnDate(r.session.startsAt) < tallinnDate(now);
}

// ---------- the feedback form (spec §7: Maria's paper form, fixed, not editable in the admin) ----------

/** The seven choice questions and their options, as stored. The texts are the dictionaries' (account.feedback.questions). */
export const FEEDBACK_CHOICES = {
  expectations: ["exceeded", "met", "not_met"],
  clarity: ["very_clear", "fairly_clear", "needs_work"],
  balance: ["ideal", "more_practice", "more_theory"],
  ready: ["fully", "mostly", "rather_not", "no"],
  trainer: ["excellent", "good", "satisfactory", "needs_growth"],
  safe: ["very", "rather_yes", "rather_not"],
  materials: ["yes", "rather_yes", "rather_not", "no"],
} as const;
export type ChoiceKey = keyof typeof FEEDBACK_CHOICES;

/** The two free texts: "Kas soovitaksid … Miks?" and the message. */
export const FEEDBACK_TEXTS = ["recommend", "message"] as const;
export type TextKey = (typeof FEEDBACK_TEXTS)[number];

/** The paper form's order: the score, the seven choices, the two free texts. */
export const FEEDBACK_ORDER = ["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"] as const;
export type FeedbackKey = (typeof FEEDBACK_ORDER)[number];

/** A free text's longest answer. */
export const FEEDBACK_TEXT_MAX = 2000;

/** The stored answers: keys only (a wording fix never breaks an old answer); a question not answered is absent. */
export type FeedbackAnswers = { score?: number } & { [K in ChoiceKey]?: (typeof FEEDBACK_CHOICES)[K][number] } & { [K in TextKey]?: string };

export type FeedbackCheck = { ok: true; answers: FeedbackAnswers } | { ok: false; error: string };

const KNOWN: ReadonlySet<string> = new Set(FEEDBACK_ORDER);
/** Is `key` one of the seven choice questions? (Own keys only: "constructor" or "__proto__" are no question.) */
export const isChoice = (key: string): key is ChoiceKey => Object.hasOwn(FEEDBACK_CHOICES, key);

/**
 * The answers as the form sends them (spec §7): an object of the known keys only (any other key: "answers"); the score a whole number 1–10; a
 * choice one of its options; a free text a string of at most 2000 characters that Postgres can store, trimmed (blank: not answered). A key that
 * is null is not answered. Nothing is required, but at least one answer is ("empty"). The first wrong key is the error.
 */
export function checkFeedback(value: unknown): FeedbackCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "answers" };
  const answers: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!KNOWN.has(key)) return { ok: false, error: "answers" };
    if (raw === null || raw === undefined) continue;
    if (key === "score") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) return { ok: false, error: "score" };
      answers.score = raw;
    } else if (isChoice(key)) {
      if (typeof raw !== "string" || !(FEEDBACK_CHOICES[key] as readonly string[]).includes(raw)) return { ok: false, error: key };
      answers[key] = raw;
    } else {
      if (typeof raw !== "string") return { ok: false, error: key };
      const text = raw.trim();
      if (text.length > FEEDBACK_TEXT_MAX || toStorable(text) !== text) return { ok: false, error: key }; // (toStorable leaves alone exactly what Postgres stores)
      if (text) answers[key] = text;
    }
  }
  return Object.keys(answers).length === 0 ? { ok: false, error: "empty" } : { ok: true, answers: answers as FeedbackAnswers };
}

/** Every option of every choice question with how many chose it. */
export type OptionCounts = { [K in ChoiceKey]: Record<(typeof FEEDBACK_CHOICES)[K][number], number> };

/** A course's feedback in numbers (the admin's "Tagasiside"): how many answered, how many gave a score, its average (one decimal), the counts. */
export type FeedbackSummary = { count: number; scored: number; average: number | null; options: OptionCounts };

export function summarizeFeedback(list: readonly FeedbackAnswers[]): FeedbackSummary {
  const keys = Object.keys(FEEDBACK_CHOICES) as ChoiceKey[];
  const options = Object.fromEntries(keys.map((key) => [key, Object.fromEntries(FEEDBACK_CHOICES[key].map((o) => [o, 0]))])) as OptionCounts;
  let sum = 0;
  let scored = 0;
  for (const answers of list) {
    if (typeof answers.score === "number") {
      sum += answers.score;
      scored++;
    }
    for (const key of keys) {
      const counts = options[key] as Record<string, number>;
      const value = answers[key];
      if (value !== undefined && Object.hasOwn(counts, value)) counts[value] += 1;
    }
  }
  return { count: list.length, scored, average: scored ? Math.round((sum / scored) * 10) / 10 : null, options };
}

/** The questions' texts in one language (account.feedback.questions of a dictionary). */
export type FeedbackQuestionTexts = { [K in FeedbackKey]: { label: string; options?: Record<string, string> } };

/** A dictionary's questions (`account.feedback.questions` of et.ts or ru.ts) as answerText reads them: the one cast, the keys checked by tests. */
export const feedbackQuestions = (questions: object): FeedbackQuestionTexts => questions as FeedbackQuestionTexts;

/** An answer in words: the score as "9/10", an option as the dictionary words it, a free text as written. */
export function answerText(key: FeedbackKey, value: string | number, q: FeedbackQuestionTexts): string {
  if (key === "score") return `${value}/10`;
  return q[key].options?.[String(value)] ?? String(value);
}

/**
 * The open rule (feedbackOpen) for a registration read with its session and protocol: the form's server side (server/course-feedback.ts)
 * and the dashboard's card (server/client-data.ts loadDashboard) read the same columns. No session: an individual course.
 */
export function feedbackOpenFor(
  r: { status: RegStatus; kind: "group" | "individual"; startsAt: Date | null; sessionStatus: string | null; protocolSentAt: Date | null },
  now: Date,
): boolean {
  const session = r.startsAt === null ? null : { startsAt: r.startsAt, cancelled: r.sessionStatus === "cancelled" };
  return feedbackOpen({ status: r.status, kind: r.kind, session, protocolSentAt: r.protocolSentAt }, now);
}
```

  Create `src/lib/to-storable.ts` (the browser's half of storable.ts, without a lookbehind):

```ts
// Text Postgres can store, made from any pasted text (phase protocols: the autosave cleans what Maria pastes before it saves it, and the
// feedback's check uses it). It runs in the browser, on iOS Safari before 16.4 too, so it has no lookbehind; storable.ts (whose lone-surrogate
// rule has one, and which the browser never imports here) builds its control-character rule from CONTROL_CLASS below: one definition.

/** The control characters Postgres refuses in text, or that a pasted document brings: all but tab, line feed and carriage return. */
export const CONTROL_CLASS = "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";

const CONTROLS = new RegExp(CONTROL_CLASS, "g");
/** A surrogate pair (kept), or a surrogate on its own (dropped): the pair is tried first, so no lookbehind is needed. */
const SURROGATES = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;

/** `s` without what Postgres cannot store: the words, tabs and line breaks stay; control characters and broken surrogates go. */
export const toStorable = (s: string): string => s.replace(CONTROLS, "").replace(SURROGATES, (m) => (m.length === 2 ? m : ""));
```

  And in `src/lib/storable.ts` (the rest of it stays as it is, its lookbehind too: older code the server and lib/favourites.ts use): add `import { CONTROL_CLASS } from "./to-storable";` at the top, and `const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;` becomes `const CONTROL = new RegExp(CONTROL_CLASS);`.

- [ ] **Step 9: Run** `npx vitest run tests/unit/protocols.test.ts tests/unit/old-safari.test.ts tests/unit/account-input.test.ts tests/db/migration-0007.test.ts tests/db/schema.test.ts` — expect PASS (`account-input.test.ts`: storable.ts's own rule, unchanged).

- [ ] **Step 10: Migration 0008 everywhere the texts said 0007** (the drop of `courses.modules`). The texts that describe what an earlier phase did when it renumbered (the phase-2b plan's Global Constraints, Task 1 and Self-review, and the phase-2b spec's line 105) are history and stay as written.
  - **`app/drizzle/0003_lessons.sql:55`.** In the data step's comment, `(migration 0007 drops it after the 3a deploy)` → `(migration 0008 drops it after the 3a deploy)`. The comment only: drizzle's migrator compares the journal's time stamps, not the file's text.
  - **`app/tests/db/migration-0003.test.ts:14`.** `migration 0007 drops the column` → `migration 0008 drops the column`.
  - **`docs/launch-checklist.md:107`.** "Migration 0007 (drops `courses.modules`) …" → "Migration 0008 (drops `courses.modules`) …"; the rest of the line stays.
  - **`docs/deploy.md:112` (§6).** "(`select count(*) from drizzle.__drizzle_migrations`; 7 after phase 2b's 0006)." becomes "(`select count(*) from drizzle.__drizzle_migrations`; 7 after phase 2b's 0006, 8 after the protocols' 0007)."
  - **`docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md`.** Every `0007` in it is the drop (lines 82, 192, 307, 461, 4500, 5204, 5221, 5227, 5300, 5310): replace each with `0008`. Line 5301 `  - (Phase 2c took 0005 and phase 2b 0006 for their own additive migrations; the drop is 0007.)` becomes `  - (Phase 2c took 0005, phase 2b 0006 and the protocols 0007 for their own additive migrations; the drop is 0008.)`. In step 11.5 (line 5310), "the migrations count is 8" → "the migrations count is 9".
  - **`docs/superpowers/plans/2026-10-09-phase2b-montonio-payments.md:7797`.** "Migration 0007 (the drop of `courses.modules`) stays as planned in phase 3a: code first, then the migration; the migrations count afterwards is 8." → "Migration 0008 (the drop of `courses.modules`; the protocols phase took 0007) stays as planned in phase 3a: code first, then the migration; the migrations count afterwards is 9."
  - Check: `grep -rn "0007" app/src app/drizzle/0003_lessons.sql app/tests/db/migration-0003.test.ts docs/launch-checklist.md docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md` lists nothing about `courses.modules` (the `\u0007` escapes in two unrelated tests are no migration).

- [ ] **Step 11: Run everything.**
  - `npx vitest run` — all green.
  - `npx tsc --noEmit`, then `npx eslint .`.
  - Apply locally only: `npm run db:migrate` (the local URL). Then `psql postgres://postgres:postgres@localhost:5432/mslab -c "select count(*) filter (where protocol_stages <> '[]'::jsonb) as with_headings, count(*) from courses"` shows `0 | <the seed's courses>`, and `\d protocols` lists the unique index `protocols_registration`.
  - `npx playwright test catalogue course admin-edit` (the courses read and write their new column; nothing shows it yet).

- [ ] **Step 12: Commit.**

```bash
git add app/src/db/schema.ts app/drizzle app/src/domain/protocols.ts app/src/lib/storable.ts app/src/lib/to-storable.ts app/tests docs/launch-checklist.md docs/deploy.md docs/superpowers/plans/2026-10-05-phase3a-lessons-video.md docs/superpowers/plans/2026-10-09-phase2b-montonio-payments.md
git commit -m "feat(db): migration 0007 — protocols, course_feedback and the courses' protocol headings; the pure rules; the drop of courses.modules becomes 0008

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: The screen's reads and the autosave — `protocolScreen`, `saveProtocol` with the version check, `POST /api/admin/protokoll`

Spec sections 3, 4 (autosave), 8 and 10 (DB). Nothing on screen yet: Task 5 uses these.

**Why a route and not a server action for the autosave.** Spec §8 names server actions for the screen. Next.js runs a page's server actions one at a time and gives the caller no timeout or abort: on flaky Wi-Fi a save that hangs would hold every later save and the send behind it. The autosave is therefore a JSON route under `/api/admin` wrapped in `withAdmin` (signed-in admin, cross-site POST refused, as the image upload), which the screen calls with a 10 s timeout and retries; the deliberate taps (the sends, Task 3) stay server actions behind `adminAction`.

**"Create on first open" is the first save.** A GET render must not write, and the status "none" (spec §4's list marks) means "nothing saved yet": the screen shows the course's headings with empty boxes, and the first save creates the row with those headings. The save carries the headings it showed (`titles`): when the course's headings changed in between, the save is refused with the headings now (the notice of Task 5), so a note never lands under another heading.

**Files:**
- Create: `app/src/db/queries/protocols.ts`, `app/src/server/protocols.ts`, `app/src/app/api/admin/protokoll/route.ts`
- Modify: `app/tests/unit/admin-guards.test.ts`
- Test: `app/tests/db/protocols-fixtures.ts`, `app/tests/db/protocols-screen.test.ts`, `app/tests/db/protocols-save.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `protocols`, `Protocol`, `ProtocolStage`; `readStages`, `stagesFrom`, `protocolStatus`, `ProtocolStatus`, `overLimit`, `PROTOCOL_LIMITS`.
- Produces, from `src/db/queries/protocols.ts`:
  - `type ProtocolDraft = { version: number; stages: ProtocolStage[]; generalNote: string; sentVersion: number | null; sentAt: Date | null; updatedAt: Date | null }` (version 0: none yet);
  - `draftOf(row: Protocol | null, headings: readonly string[]): ProtocolDraft`;
  - `type ScreenStudent = { registrationId: number; name: string; status: RegStatus; protocol: ProtocolDraft; state: ProtocolStatus }`;
  - `type ScreenData = { kind: "session" | "registration"; course: { id: number; title: I18n }; session: { id: number; startsAt: Date; city: string; venue: string; cancelled: boolean } | null; students: ScreenStudent[]; hidden: number }`;
  - `protocolScreen(db: Db, target: { sessionId: number } | { registrationId: number }): Promise<ScreenData | null>`.
- Produces, from `src/server/protocols.ts`:
  - `saveBody` (zod), `type SaveInput = { registrationId: number; version: number; titles: string[]; notes: string[]; generalNote: string }`;
  - `type SaveResult = { kind: "saved"; version: number; savedAt: Date } | { kind: "conflict"; protocol: ProtocolDraft } | { kind: "notFound" }`;
  - `saveProtocol(db: Db, input: SaveInput, now: Date): Promise<SaveResult>`;
  - `MAX_SAVE_CHARS`; `draftJson(d: ProtocolDraft)` (a draft as JSON: dates as ISO strings);
  - `handleSave(db: Db, request: Request, now: Date): Promise<Response>`: 200 `{ ok: true, version, savedAt }`; 409 `{ ok: false, error: "conflict", protocol: { version, stages, generalNote, sentVersion, sentAt, updatedAt } }`; 404 `{ ok: false, error: "notFound" }`; 400 `{ ok: false, error: "body" | "text" }` or `{ ok: false, error: "tooLong", places }`; 413 `{ ok: false, error: "size" }`; 500 `{ ok: false, error: "server" }`; always `Cache-Control: no-store`.
- Produces: the route `POST /api/admin/protokoll` (`withAdmin`).

- [ ] **Step 1: The test fixtures** — create `tests/db/protocols-fixtures.ts`:

```ts
import type { Db } from "@/db/client";
import { courses, courseSessions, registrations, type Course, type CourseSession, type Registration } from "@/db/schema";

// The protocol DB tests' common parts (phase protocols): a contact course with Maria's headings, its session on the course day, and the
// students' registrations on it. The addresses are @example.com: a protocol mail is really built and "sent" to the stubbed Resend.

export const HEADINGS = ["Ettevalmistus", "Kulmude analüüs", "Vormi määramine", "Värvimine"];
/** The course day: 12.10.2026 10:00 in Tallinn (summer time). */
export const COURSE_DAY = new Date("2026-10-12T07:00:00Z");

/** A published contact course with the headings (`over` replaces fields) and its one session on the course day. */
export async function protocolCourse(db: Db, over: Partial<typeof courses.$inferInsert> = {}): Promise<{ course: Course; session: CourseSession }> {
  const [course] = await db
    .insert(courses)
    .values({
      slug: "kulmude-lami",
      type: "contact",
      level: "basic",
      title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" },
      summary: { et: "" },
      body: { et: "" },
      priceGroup: 35000,
      priceIndividual: 45000,
      published: true,
      protocolStages: HEADINGS,
      ...over,
    })
    .returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: COURSE_DAY, city: "Pärnu", venue: "MS LAB stuudio", capacity: 6 }).returning();
  return { course, session };
}

/**
 * A student's registration: on `session` a group one (null: an individual one), confirmed, without an account, her address made of her name
 * (`Mari Maasikas` → `marimaasikas@example.com`); `over` replaces fields.
 */
export async function student(db: Db, course: Course, session: CourseSession | null, name: string, over: Partial<typeof registrations.$inferInsert> = {}): Promise<Registration> {
  const local = name.toLowerCase().replace(/[^a-z]+/g, "");
  const [r] = await db
    .insert(registrations)
    .values({ courseId: course.id, courseSessionId: session?.id ?? null, kind: session ? "group" : "individual", name, email: `${local}@example.com`, paymentChoice: "full", status: "confirmed", ...over })
    .returning();
  return r;
}
```

- [ ] **Step 2: Write the failing screen tests** `tests/db/protocols-screen.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { protocolScreen } from "@/db/queries/protocols";
import { courses, courseSessions, protocols } from "@/db/schema";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// What the course day's screen reads (spec §4): one session's students, or one registration; each protocol's status; the course's headings
// for a protocol not created yet, its own copy for one that is (spec §9).

test("a session: its confirmed and awaiting students by name with their status; the cancelled ones hidden and counted; headings for none yet", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await student(db, course, session, "Anu Aas", { status: "awaiting_prepayment" });
  await student(db, course, session, "Tiina Tamm", { status: "cancelled" });
  await db.insert(protocols).values({ registrationId: mari.id, stages: [{ title: "Vana pealkiri", note: "Hea algus" }], version: 2 });

  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen).toMatchObject({
    kind: "session",
    course: { id: course.id, title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
    session: { id: session.id, startsAt: session.startsAt, city: "Pärnu", venue: "MS LAB stuudio", cancelled: false },
    hidden: 1,
  });
  expect(screen.students.map((s) => [s.name, s.status, s.state, s.protocol.version])).toEqual([
    ["Anu Aas", "awaiting_prepayment", "none", 0],
    ["Mari Maasikas", "confirmed", "draft", 2],
  ]);
  expect(screen.students[0].protocol).toEqual({ version: 0, stages: HEADINGS.map((title) => ({ title, note: "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: null });
  // a created protocol keeps its own copy of the headings
  expect(screen.students[1].protocol.stages).toEqual([{ title: "Vana pealkiri", note: "Hea algus" }]);
});

test("each protocol's status: a draft, sent, changed after it was sent", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const [a, b, c] = [await student(db, course, session, "Aili"), await student(db, course, session, "Berit"), await student(db, course, session, "Carmen")];
  const sentAt = new Date("2026-10-12T15:00:00Z");
  const sent = { stages: [], generalNote: "Tubli" };
  await db.insert(protocols).values([
    { registrationId: a.id, stages: [], generalNote: "x", version: 1 },
    { registrationId: b.id, stages: [], generalNote: "Tubli", version: 3, sent, sentAt, sentVersion: 3 },
    { registrationId: c.id, stages: [], generalNote: "Tubli!", version: 4, sent, sentAt, sentVersion: 3 },
  ]);
  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen.students.map((s) => [s.name, s.state])).toEqual([["Aili", "draft"], ["Berit", "sent"], ["Carmen", "changed"]]);
  expect(screen.students[2].protocol).toMatchObject({ version: 4, sentVersion: 3, sentAt });
});

test("one registration (an individual course): that student alone; a cancelled one is hidden; an e-course's, or an unknown one, is no screen", async () => {
  const db = await makeTestDb();
  const { course } = await protocolCourse(db);
  const kati = await student(db, course, null, "Kati Kask");
  const one = (await protocolScreen(db, { registrationId: kati.id }))!;
  expect(one).toMatchObject({ kind: "registration", session: null, hidden: 0 });
  expect(one.students.map((s) => [s.registrationId, s.name, s.state])).toEqual([[kati.id, "Kati Kask", "none"]]);

  const gone = await student(db, course, null, "Liis Lepp", { status: "cancelled" });
  expect(await protocolScreen(db, { registrationId: gone.id })).toMatchObject({ students: [], hidden: 1 });

  const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
  const buyer = await student(db, ecourse, null, "Eva");
  expect(await protocolScreen(db, { registrationId: buyer.id })).toBeNull();
  expect(await protocolScreen(db, { registrationId: 999_999 })).toBeNull();
  expect(await protocolScreen(db, { sessionId: 999_999 })).toBeNull();
});

test("a session called off: its protocols stay reachable for the record (spec §9)", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  await student(db, course, session, "Mari");
  await db.update(courseSessions).set({ status: "cancelled" }).where(eq(courseSessions.id, session.id));
  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen.session?.cancelled).toBe(true);
  expect(screen.students.map((s) => s.name)).toEqual(["Mari"]);
});
```

- [ ] **Step 3: Run it — expect FAIL**: `npx vitest run tests/db/protocols-screen.test.ts` (`@/db/queries/protocols` does not exist).

- [ ] **Step 4: Write `src/db/queries/protocols.ts`:**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { courses, courseSessions, protocols, registrations, type CourseSession, type Protocol, type ProtocolStage, type Registration } from "../schema";
import { protocolStatus, readStages, stagesFrom, type ProtocolStatus } from "@/domain/protocols";
import type { RegStatus } from "@/domain/registration";
import type { I18n } from "@/i18n/field";

// The protocols' reads (phase protocols, spec §8): the course day's screen (Task 2), today's sessions (Task 5), the student's page (Task 7) and
// the admin's feedback page (Task 9). Callers have checked the session (admin or client); nothing here does authorization.

/** A protocol as the screen edits it. `version` 0: none yet — the course's headings with empty notes. */
export type ProtocolDraft = {
  version: number;
  stages: ProtocolStage[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: Date | null;
  /** The last saved change; null before the first. */
  updatedAt: Date | null;
};

/** The draft of a stored protocol, or of none yet with the course's `headings`. */
export function draftOf(row: Protocol | null, headings: readonly string[]): ProtocolDraft {
  if (!row) return { version: 0, stages: stagesFrom(headings), generalNote: "", sentVersion: null, sentAt: null, updatedAt: null };
  return { version: row.version, stages: row.stages, generalNote: row.generalNote, sentVersion: row.sentVersion, sentAt: row.sentAt, updatedAt: row.updatedAt };
}

export type ScreenStudent = { registrationId: number; name: string; status: RegStatus; protocol: ProtocolDraft; state: ProtocolStatus };

/**
 * The course day's screen (spec §4): "session" lists every registration of one session that is not cancelled (confirmed, and awaiting the
 * prepayment), "registration" one registration (an individual course). `hidden`: the cancelled ones left out.
 */
export type ScreenData = {
  kind: "session" | "registration";
  course: { id: number; title: I18n };
  session: { id: number; startsAt: Date; city: string; venue: string; cancelled: boolean } | null;
  students: ScreenStudent[];
  hidden: number;
};

const courseFields = { id: courses.id, title: courses.title, type: courses.type, protocolStages: courses.protocolStages };
const sessionOf = (s: CourseSession) => ({ id: s.id, startsAt: s.startsAt, city: s.city, venue: s.venue, cancelled: s.status === "cancelled" });

function screenOf(
  kind: ScreenData["kind"],
  course: { id: number; title: I18n; protocolStages: string[] },
  session: ScreenData["session"],
  rows: { registration: Registration; protocol: Protocol | null }[],
): ScreenData {
  const headings = readStages(course.protocolStages);
  const listed = rows.filter((r) => r.registration.status !== "cancelled");
  const students = listed
    .map((r) => ({ registrationId: r.registration.id, name: r.registration.name, status: r.registration.status, protocol: draftOf(r.protocol, headings), state: protocolStatus(r.protocol) }))
    .sort((a, b) => a.name.localeCompare(b.name, "et") || a.registrationId - b.registrationId);
  return { kind, course: { id: course.id, title: course.title }, session, students, hidden: rows.length - listed.length };
}

/**
 * The screen of one session (`sessionId`: its students, a called-off session's too, for the record) or of one registration; null when there
 * is no such session or registration, or it is not of a contact course (protocols are for contact courses only: spec assumption 1).
 */
export async function protocolScreen(db: Db, target: { sessionId: number } | { registrationId: number }): Promise<ScreenData | null> {
  if ("sessionId" in target) {
    const [s] = await db
      .select({ session: courseSessions, course: courseFields })
      .from(courseSessions)
      .innerJoin(courses, eq(courseSessions.courseId, courses.id))
      .where(eq(courseSessions.id, target.sessionId))
      .limit(1);
    if (!s || s.course.type !== "contact") return null;
    const rows = await db
      .select({ registration: registrations, protocol: protocols })
      .from(registrations)
      .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
      .where(eq(registrations.courseSessionId, target.sessionId));
    return screenOf("session", s.course, sessionOf(s.session), rows);
  }
  const [r] = await db
    .select({ registration: registrations, protocol: protocols, course: courseFields, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .where(eq(registrations.id, target.registrationId))
    .limit(1);
  if (!r || r.course.type !== "contact") return null;
  return screenOf("registration", r.course, r.session ? sessionOf(r.session) : null, [{ registration: r.registration, protocol: r.protocol }]);
}
```

- [ ] **Step 5: Run** `npx vitest run tests/db/protocols-screen.test.ts` — expect PASS.

- [ ] **Step 6: Write the failing save tests** `tests/db/protocols-save.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, protocols, registrations } from "@/db/schema";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { handleSave, MAX_SAVE_CHARS, saveProtocol, type SaveInput } from "@/server/protocols";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The autosave (spec §3, §4, §10 DB): the first save creates the protocol with the course's headings; every saved change raises the version;
// a save from an older version is refused with what is stored, so newer text is never overwritten; a save that changes nothing raises
// nothing. And the route's answers (app/api/admin/protokoll: withAdmin around handleSave).

const NOW = new Date("2026-10-12T08:00:00Z");
const LATER = new Date("2026-10-12T08:05:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The notes under the four headings: the given ones first, the rest empty. */
const notes = (...given: string[]) => [...given, ...Array<string>(HEADINGS.length - given.length).fill("")];
const save = (registrationId: number, version: number, over: Partial<SaveInput> = {}, at = NOW) =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes: notes(), generalNote: "", ...over }, at);
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];

async function setup() {
  const { course, session } = await protocolCourse(db);
  return { course, session, mari: await student(db, course, session, "Mari Maasikas") };
}

describe("saveProtocol", () => {
  test("the first save creates the protocol with the course's headings as they are now, version 1", async () => {
    const { mari } = await setup();
    expect(await save(mari.id, 0, { notes: notes("Kulmud ühtlased") })).toEqual({ kind: "saved", version: 1, savedAt: NOW });
    expect(await stored(mari.id)).toMatchObject({
      version: 1,
      stages: [{ title: "Ettevalmistus", note: "Kulmud ühtlased" }, { title: "Kulmude analüüs", note: "" }, { title: "Vormi määramine", note: "" }, { title: "Värvimine", note: "" }],
      generalNote: "",
      sent: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("each saved change raises the version; a save that changes nothing raises nothing (a look, a 'Muuda' without an edit)", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("A") });
    expect(await save(mari.id, 1, { notes: notes("AB") }, LATER)).toEqual({ kind: "saved", version: 2, savedAt: LATER });
    expect(await save(mari.id, 2, { notes: notes("AB"), generalNote: "Üldiselt hästi" })).toMatchObject({ kind: "saved", version: 3 });
    expect(await save(mari.id, 3, { notes: notes("AB"), generalNote: "Üldiselt hästi" }, new Date("2026-10-12T09:00:00Z"))).toEqual({ kind: "saved", version: 3, savedAt: NOW });
    expect((await stored(mari.id)).version).toBe(3);
  });

  test("Review Focus 2: a save from an older version is refused with what is stored; nothing is overwritten", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("tahvel") }); // the tablet
    await save(mari.id, 1, { notes: notes("tahvel, uuem") }, LATER); // the tablet again
    const phone = await save(mari.id, 1, { notes: notes("telefon") }); // the phone still has version 1
    expect(phone).toMatchObject({ kind: "conflict", protocol: { version: 2, generalNote: "", sentVersion: null, sentAt: null, updatedAt: LATER } });
    expect(phone.kind === "conflict" && phone.protocol.stages[0]).toEqual({ title: "Ettevalmistus", note: "tahvel, uuem" });
    expect((await stored(mari.id)).stages[0].note).toBe("tahvel, uuem");
    // a second first save (the phone did not see the tablet create it) is refused the same way
    expect(await save(mari.id, 0, { notes: notes("telefon") })).toMatchObject({ kind: "conflict", protocol: { version: 2 } });
  });

  test("Review Focus 1: a save whose answer was lost, sent again as it was, is answered with the version that holds it (no conflict)", async () => {
    const { course, mari } = await setup();
    await save(mari.id, 0, { notes: notes("A") });
    await save(mari.id, 1, { notes: notes("AB") }, LATER); // stored as 2, but the answer never reached the tablet
    expect(await save(mari.id, 1, { notes: notes("AB") })).toEqual({ kind: "saved", version: 2, savedAt: LATER });
    // the same for a first save whose answer was lost
    const anu = await student(db, course, null, "Anu Aas");
    await save(anu.id, 0, { notes: notes("Esimene") });
    expect(await save(anu.id, 0, { notes: notes("Esimene") })).toEqual({ kind: "saved", version: 1, savedAt: NOW });
  });

  test("a first save made for headings the course no longer has is refused with the headings now; a created protocol keeps its own (spec §9)", async () => {
    const { course, session, mari } = await setup();
    await save(mari.id, 0, { notes: notes("Mari") });
    await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, course.id));
    const anu = await student(db, course, session, "Anu Aas");
    expect(await save(anu.id, 0, { notes: notes("Anu") })).toEqual({
      kind: "conflict",
      protocol: { version: 0, stages: [{ title: "Uus punkt", note: "" }], generalNote: "", sentVersion: null, sentAt: null, updatedAt: null },
    });
    expect(await stored(anu.id)).toBeUndefined();
    expect(await save(anu.id, 0, { titles: ["Uus punkt"], notes: ["Anu"] })).toMatchObject({ kind: "saved", version: 1 });
    // Mari's protocol keeps its four headings and is saved with them
    expect(await save(mari.id, 1, { notes: notes("Mari, edasi") })).toMatchObject({ kind: "saved", version: 2 });
    expect((await stored(mari.id)).stages.map((s) => s.title)).toEqual(HEADINGS);
    // headings that are not the protocol's own: refused
    expect(await save(mari.id, 2, { titles: ["Uus punkt"], notes: ["x"] })).toMatchObject({ kind: "conflict", protocol: { version: 2 } });
  });

  test("Review Focus 3: a registration cancelled while the screen is open still saves: nothing typed is lost", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("Hommikul") });
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect(await save(mari.id, 1, { notes: notes("Hommikul. Lõunal") })).toMatchObject({ kind: "saved", version: 2 });
  });

  test("an e-course's registration, or none: notFound", async () => {
    const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
    const buyer = await student(db, ecourse, null, "Eva");
    expect(await save(buyer.id, 0, { titles: [], notes: [] })).toEqual({ kind: "notFound" });
    expect(await save(999_999, 0)).toEqual({ kind: "notFound" });
  });
});

describe("POST /api/admin/protokoll (handleSave)", () => {
  const post = (body: unknown) =>
    handleSave(db, new Request("https://mslab.example/api/admin/protokoll", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), NOW);
  const answer = async (res: Response) => [res.status, await res.json(), res.headers.get("cache-control")];
  const body = (registrationId: number, version: number, over: Record<string, unknown> = {}) => ({ registrationId, version, titles: HEADINGS, notes: notes("Hea"), generalNote: "", ...over });

  test("200 with the new version and when it was saved; never kept by a cache", async () => {
    const { mari } = await setup();
    expect(await answer(await post(body(mari.id, 0)))).toEqual([200, { ok: true, version: 1, savedAt: NOW.toISOString() }, "no-store"]);
  });

  test("409 with the stored protocol, its dates as text; 404 for a registration that is not there", async () => {
    const { mari } = await setup();
    await post(body(mari.id, 0));
    const [status, json] = await answer(await post(body(mari.id, 0, { notes: notes("teine seade") })));
    expect([status, json]).toEqual([
      409,
      { ok: false, error: "conflict", protocol: { version: 1, stages: HEADINGS.map((title, i) => ({ title, note: i === 0 ? "Hea" : "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: NOW.toISOString() } },
    ]);
    expect(await answer(await post(body(999_999, 0)))).toEqual([404, { ok: false, error: "notFound" }, "no-store"]);
  });

  test("Review Focus 4: a box over 10 000 characters is refused with its place, so is text Postgres cannot store; nothing is stored", async () => {
    const { mari } = await setup();
    const long = "ä".repeat(PROTOCOL_LIMITS.note + 1);
    expect(await answer(await post(body(mari.id, 0, { notes: notes("ok", long), generalNote: long })))).toEqual([400, { ok: false, error: "tooLong", places: [1, "general"] }, "no-store"]);
    expect(await answer(await post(body(mari.id, 0, { generalNote: "nul\u0000" })))).toEqual([400, { ok: false, error: "text" }, "no-store"]);
    expect(await stored(mari.id)).toBeUndefined();
    expect((await post(body(mari.id, 0, { notes: notes("x".repeat(PROTOCOL_LIMITS.note)) }))).status).toBe(200); // at the limit: fine
  });

  test("a body that is not a save is 400; one longer than any save can be is 413", async () => {
    const { mari } = await setup();
    for (const bad of ["{", "[]", { registrationId: mari.id }, body(mari.id, -1), body(mari.id, 0, { notes: ["only one"] }), body(0, 0), body(mari.id, 0, { titles: ["x".repeat(121)], notes: [""] })])
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect(await answer(await post("x".repeat(MAX_SAVE_CHARS + 1)))).toEqual([413, { ok: false, error: "size" }, "no-store"]);
  });
});
```

- [ ] **Step 7: Run it — expect FAIL**: `npx vitest run tests/db/protocols-save.test.ts` (`@/server/protocols` does not exist).

- [ ] **Step 8: Write `src/server/protocols.ts`:**

```ts
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { draftOf, type ProtocolDraft } from "@/db/queries/protocols";
import { courses, protocols, registrations, type Protocol, type ProtocolStage } from "@/db/schema";
import { overLimit, PROTOCOL_LIMITS, readStages } from "@/domain/protocols";
import { storable } from "@/lib/storable";
import { logFailure } from "./log";

// Maria's protocols on the course day (phase protocols, spec §3, §4, §8), without Next.js: the autosave (saveProtocol, and handleSave behind
// app/api/admin/protokoll) and the sending (sendProtocol, Task 3). The admin session is checked by the callers (withAdmin, adminAction).
// Logs carry the registration's id only: never a note, a name or an address.
//
// A protocol is created by its first save, with the course's headings as they are then (spec §3); until then the screen shows those headings
// with empty boxes and the status is "none". Every save carries the version the screen has, and the headings it shows: a save from another
// version, or for other headings, is refused with what is stored, so newer text is never overwritten and a note never lands under another
// heading (spec §4, §9). A save that changes nothing raises nothing: a look at a protocol, or the repeat of a save whose answer was lost, is
// answered with the version that holds that text.

/** What a save sends: the registration, the version the screen has (0: none yet), the headings it shows and the notes under them. */
export const saveBody = z.object({
  registrationId: z.number().int().positive().max(2_147_483_647),
  version: z.number().int().min(0).max(2_147_483_647),
  titles: z.array(z.string().max(PROTOCOL_LIMITS.title)).max(PROTOCOL_LIMITS.stages),
  notes: z.array(z.string()).max(PROTOCOL_LIMITS.stages),
  generalNote: z.string(),
});
export type SaveInput = z.infer<typeof saveBody>;

export type SaveResult = { kind: "saved"; version: number; savedAt: Date } | { kind: "conflict"; protocol: ProtocolDraft } | { kind: "notFound" };

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const titlesOf = (stages: readonly ProtocolStage[]): string[] => stages.map((s) => s.title);
/** Does the stored protocol hold exactly this text, under these headings? */
const holds = (p: Protocol, input: SaveInput): boolean =>
  sameList(titlesOf(p.stages), input.titles) && sameList(p.stages.map((s) => s.note), input.notes) && p.generalNote === input.generalNote;

/** A registration's course headings and its protocol; null when there is no such registration of a contact course. */
async function current(db: Db, registrationId: number): Promise<{ headings: string[]; stored: Protocol | null } | null> {
  const [row] = await db
    .select({ type: courses.type, headings: courses.protocolStages, protocol: protocols })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row && row.type === "contact" ? { headings: readStages(row.headings), stored: row.protocol } : null;
}

/**
 * One save of the screen. A registration that is cancelled meanwhile still saves (spec §9: hidden and never sent, but nothing typed is lost).
 * The insert and the update are each one conditional statement; one that meets another save at the same moment reads again and decides on
 * what is stored then (twice at most, then the answer is a conflict with the protocol as it is).
 */
export async function saveProtocol(db: Db, input: SaveInput, now: Date): Promise<SaveResult> {
  for (let attempt = 0; ; attempt++) {
    const found = await current(db, input.registrationId);
    if (!found) return { kind: "notFound" };
    const { headings, stored } = found;
    if (stored === null) {
      if (input.version !== 0 || !sameList(headings, input.titles)) return { kind: "conflict", protocol: draftOf(null, headings) };
      const [created] = await db
        .insert(protocols)
        .values({
          registrationId: input.registrationId,
          stages: input.titles.map((title, i) => ({ title, note: input.notes[i] })),
          generalNote: input.generalNote,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: protocols.registrationId })
        .returning();
      if (created) return { kind: "saved", version: created.version, savedAt: now };
    } else {
      if (holds(stored, input)) return { kind: "saved", version: stored.version, savedAt: stored.updatedAt };
      if (input.version !== stored.version || !sameList(titlesOf(stored.stages), input.titles)) return { kind: "conflict", protocol: draftOf(stored, headings) };
      const [updated] = await db
        .update(protocols)
        .set({ stages: stored.stages.map((s, i) => ({ title: s.title, note: input.notes[i] })), generalNote: input.generalNote, version: sql`${protocols.version} + 1`, updatedAt: now })
        .where(and(eq(protocols.registrationId, input.registrationId), eq(protocols.version, input.version)))
        .returning();
      if (updated) return { kind: "saved", version: updated.version, savedAt: now };
    }
    if (attempt >= 1) {
      const last = await current(db, input.registrationId);
      return last ? { kind: "conflict", protocol: draftOf(last.stored, last.headings) } : { kind: "notFound" };
    }
  }
}

/**
 * The longest body a save can be: every note and the general notes at their limit, JSON-escaped (twice the characters at most), the headings
 * likewise, and the rest. Far under Vercel's 4.5 MB for a body.
 */
export const MAX_SAVE_CHARS = (PROTOCOL_LIMITS.stages + 1) * PROTOCOL_LIMITS.note * 2 + PROTOCOL_LIMITS.stages * PROTOCOL_LIMITS.title * 2 + 4096;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** A draft as JSON: its dates as ISO strings. */
export const draftJson = (d: ProtocolDraft) => ({
  version: d.version,
  stages: d.stages,
  generalNote: d.generalNote,
  sentVersion: d.sentVersion,
  sentAt: d.sentAt?.toISOString() ?? null,
  updatedAt: d.updatedAt?.toISOString() ?? null,
});

/**
 * POST /api/admin/protokoll — one autosave (the route wraps this in withAdmin). The body is a SaveInput as JSON. 200 `{ ok: true, version,
 * savedAt }`; 409 `{ ok: false, error: "conflict", protocol }` (what is stored: the screen shows it); 404 `{ ok: false, error: "notFound" }`;
 * 400 `{ error: "body" }` (not a save), `{ error: "text" }` (text Postgres cannot store: the screen cleans pasted text first) or
 * `{ error: "tooLong", places }` (a box over 10 000 characters: nothing is cut, the screen says so first); 413 `{ error: "size" }`; 500
 * `{ error: "server" }`, logged by the registration's id. Never cached.
 */
export async function handleSave(db: Db, request: Request, now: Date): Promise<Response> {
  let value: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_SAVE_CHARS) return json({ ok: false, error: "size" }, 413);
    value = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  const parsed = saveBody.safeParse(value);
  if (!parsed.success || parsed.data.notes.length !== parsed.data.titles.length) return json({ ok: false, error: "body" }, 400);
  const input = parsed.data;
  if (![...input.notes, input.generalNote].every(storable)) return json({ ok: false, error: "text" }, 400);
  const places = overLimit(input.notes, input.generalNote);
  if (places.length > 0) return json({ ok: false, error: "tooLong", places }, 400);
  try {
    const result = await saveProtocol(db, input, now);
    if (result.kind === "saved") return json({ ok: true, version: result.version, savedAt: result.savedAt.toISOString() });
    if (result.kind === "conflict") return json({ ok: false, error: "conflict", protocol: draftJson(result.protocol) }, 409);
    return json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure(`[protocols] registration ${input.registrationId}: the save failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
}
```

- [ ] **Step 9: The route** — create `src/app/api/admin/protokoll/route.ts`:

```ts
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { handleSave } from "@/server/protocols";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * POST /api/admin/protokoll — the protocol screen's autosave (phase protocols, spec §4): signed-in admins only, a cross-site POST is 403
 * (withAdmin). The body and the answers are server/protocols.ts handleSave's. /api/admin passes the coming-soon gate.
 */
export const POST = withAdmin(async (request) => handleSave(getDb(), request, new Date()));
```

  And in `tests/unit/admin-guards.test.ts`:
  1. in the first test's second `arrayContaining` list, after `"server/actions/admin-lessons.ts",` add `// protocols: the autosave` and `"app/api/admin/protokoll/route.ts",`;
  2. in "every route under app/api/admin and app/admin is wrapped …", add `"app/api/admin/protokoll/route.ts"` to the `arrayContaining` list.

- [ ] **Step 10: Run** `npx vitest run tests/db/protocols-save.test.ts tests/db/protocols-screen.test.ts tests/unit/admin-guards.test.ts` — expect PASS.

- [ ] **Step 11: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — green.

- [ ] **Step 12: Commit.**

```bash
git add app/src/db/queries/protocols.ts app/src/server/protocols.ts "app/src/app/api/admin/protokoll/route.ts" app/tests
git commit -m "feat(protocols): the course day's reads and the autosave — created by the first save, the version check, POST /api/admin/protokoll

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sending — `sendProtocol` in one transaction per student, the account and the link, the two mails, the login that opens the protocol

Spec sections 4 (sending), 6 (mails), 8 ("Sending happens in one transaction per student"), D3, D4 and 10 (DB). The screen's buttons come in Task 6; the race on real Postgres in Task 11.

**The lock order differs from the spec's list, on purpose.** Spec §8 says "1. Lock the registration row". The logins (`client-auth.ts`: `redeemClientLink`, `redeemClientCode` → `linkClientRecords`) and `addClient` take the address lock and then write the address's registrations; a send that locked the registration first and then asked `addClient` for the address lock would deadlock with a login at the same moment. So a send takes the address lock first (the registration's address never changes: no admin form edits it), then `lockRegistration`, then the protocol row `FOR UPDATE` (a save that arrives meanwhile waits for the freeze, so `sent` is exactly the version the screen showed).

**The login is made with the mail, after the commit**, as `settle.ts mailEcourseOpen` does (spec §6 names `ecourseOpenMail` as the model): its 30 minutes start when the mail goes, a mail that fails leaves no login behind in the send's transaction, and an address with 3 live logins gets the mail with a button that opens the page instead.

**The six-digit code under the button** (an owner default, easy to drop: the four lines marked in `protocolMail` and its test): with a login the mail also shows the code and the small "Kui nupp ei tööta, sisesta kood siin:" link to the login page's code step, as `ecourseOpenMail` does, so a student whose mail app opens links in another browser still gets in.

**The button opens the protocol.** `verifyLink` gains an optional target: `&p=<registration>` makes `GET /api/konto/verify` open `/konto/protokoll#sisse&id=<n>` after the login instead of `/konto#sisse`; `useAccount`'s login mark is taken and the id stays in the fragment. The page itself is Task 7's.

**Files:**
- Modify: `app/src/server/protocols.ts` (the imports; the send appended)
- Modify: `app/src/server/account-mail.ts` (`verifyLink`, lines 20–26; `protocolUrl`, `feedbackUrl`, `protocolMail` appended)
- Modify: `app/src/server/account-api.ts` (`verify`, lines 325–346)
- Modify: `app/src/components/account/useAccount.ts` (`takeLoginMark`, lines 83–92)
- Modify: `app/src/i18n/dict/et.ts`, `app/src/i18n/dict/ru.ts` (`account.protocolMail`)
- Create: `app/src/server/actions/admin-protocols.ts`
- Modify: `app/tests/unit/admin-guards.test.ts`, `app/tests/unit/use-account.test.ts`
- Test: `app/tests/unit/protocol-mail.test.ts`, `app/tests/db/protocols-send.test.ts`, `app/tests/db/verify-protocol.test.ts` (new)

**Interfaces:**
- Consumes: `saveProtocol` (Task 2, in the tests); `hasText` (Task 1); `lockRegistration` (`db/queries/seats.ts`), `lockAddress`, `issueClientLogin` (`server/client-auth.ts`), `addClient` (`server/admin-clients.ts`), `sendMail`, `mailConfigured`, `Env` (`server/notify.ts`), `isSampleAddress`, `normalizeEmail` (`domain/email.ts`).
- Produces, from `src/server/protocols.ts`:
  - `type SendDeps = { db: Db; env: Env; siteUrl: string; now: Date; later: (task: () => Promise<unknown>) => void }`;
  - `type SendResult = { kind: "sent"; again: boolean; version: number; sentAt: string } | { kind: "already"; version: number; sentAt: string } | { kind: "empty" } | { kind: "stale"; version: number } | { kind: "cancelled" } | { kind: "notFound" }`; `type SendOutcome = SendResult | { kind: "failed" }`;
  - `sendProtocol(deps: SendDeps, input: { registrationId: number; version: number }): Promise<SendResult>`;
  - `type BulkResult = { registrationId: number; result: SendOutcome }`; `sendProtocols(deps: SendDeps, items: readonly { registrationId: number; version: number }[]): Promise<BulkResult[]>`.
- Produces, from `src/server/account-mail.ts`: `verifyLink(siteUrl, token, pageLocale = "et", protocolId?: number)`; `protocolUrl(siteUrl: string, locale: Locale, registrationId: number): string`; `feedbackUrl(siteUrl: string, locale: Locale, registrationId: number): string`; `type ProtocolMailInput`; `protocolMail(input: ProtocolMailInput): Mail`.
- Produces, from `src/server/actions/admin-protocols.ts`: `sendProtocolAction(input: { registrationId: number; version: number }): Promise<SendOutcome>`; `sendProtocolsAction(input: { registrationId: number; version: number }[]): Promise<BulkResult[]>`.
- Produces: `GET /api/konto/verify?t=…&p=<n>` → 303 to `/konto/protokoll#sisse&id=<n>` (`/ru/…` for a Russian account); `et.account.protocolMail` / `ru.account.protocolMail`.

- [ ] **Step 1: The texts** — in `src/i18n/dict/et.ts`, inside `account`, after the `passwordMail` block (it ends with `notYouAt: "Kui see polnud sina, kirjuta kohe Mariale: {email}",` and `},`), add:

```ts
    // The protocol's mails (server/account-mail.ts protocolMail, phase protocols): "Saada" sends the first, "Saada uuesti" the second. The
    // button opens the protocol (with a live login it signs her in first); the first mail adds the feedback line, a link to the form.
    protocolMail: {
      subjectFirst: "Sinu koolituse protokoll on valmis",
      subjectAgain: "Sinu koolituse protokolli on uuendatud",
      leadFirst: "Sinu koolituse protokoll on valmis.",
      leadAgain: "Sinu koolituse protokolli on uuendatud.",
      button: "Vaata protokolli",
      valid: "Kood ja nupp kehtivad 30 minutit. Hiljem leiad protokolli Minu koolituste lehelt.",
      feedback: "Soovi korral jäta meile tagasisidet",
    },
```

  and in `src/i18n/dict/ru.ts`, at the same place (after its `passwordMail` block):

```ts
    protocolMail: {
      subjectFirst: "Протокол вашего обучения готов",
      subjectAgain: "Протокол вашего обучения обновлён",
      leadFirst: "Протокол вашего обучения готов.",
      leadAgain: "Протокол вашего обучения обновлён.",
      button: "Посмотреть протокол",
      valid: "Код и кнопка действуют 30 минут. Позже протокол можно найти на странице «Мои курсы».",
      feedback: "По желанию оставьте нам отзыв",
    },
```

- [ ] **Step 2: Write the failing mail tests** `tests/unit/protocol-mail.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { feedbackUrl, protocolMail, protocolUrl, verifyLink, type ProtocolMailInput } from "@/server/account-mail";

// The protocol's mails (spec §6): the first send's and the re-send's, in the registration's language, with a live login in the button or
// without one, and never a note of the protocol (the function is not even given one: the mail carries the link only).

const BASE = "https://mslab.example";
const TOKEN = "tok-en_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const input = (over: Partial<ProtocolMailInput> = {}): ProtocolMailInput => ({
  siteUrl: BASE,
  email: "kati@example.com",
  name: "Kati Tamm",
  locale: "et",
  registrationId: 42,
  course: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" },
  session: { startsAt: new Date("2026-10-12T07:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" },
  again: false,
  login: { token: TOKEN, code: "864209" }, // (a code the token does not hold)
  ...over,
});

describe("protocolMail", () => {
  test("the first send: the subject, the course with its day and place, 'Vaata protokolli' with the login that opens it, the feedback line", () => {
    const m = protocolMail(input());
    const login = verifyLink(BASE, TOKEN, "et", 42);
    expect(login).toBe(`${BASE}/api/konto/verify?t=${TOKEN}&p=42`);
    expect([m.to, m.subject]).toEqual(["kati@example.com", "Sinu koolituse protokoll on valmis"]);
    expect(m.text).toBe(
      [
        "Tere, Kati!", "",
        "Sinu koolituse protokoll on valmis.", "",
        "Kulmude lamineerimine", "12.10.2026 · 10:00", "Pärnu, MS LAB stuudio", "",
        "Vaata protokolli:", login, "",
        "Sinu sisselogimiskood:", "", "864209", "",
        "Kood ja nupp kehtivad 30 minutit. Hiljem leiad protokolli Minu koolituste lehelt.", "",
        "Kui nupp ei tööta, sisesta kood siin:", `${BASE}/konto/sisene#email=kati%40example.com&kood=1`, "",
        "Soovi korral jäta meile tagasisidet:", `${BASE}/konto/tagasiside#id=42`, "",
        "MS LAB Koolituskeskus",
      ].join("\n"),
    );
    expect(m.html).toContain(`href="${login.replace(/&/g, "&amp;")}"`);
    expect(m.html).toContain(">Vaata protokolli</a>");
    expect(m.html).toContain(`href="${BASE}/konto/tagasiside#id=42"`);
    expect(m.html).toContain(">Soovi korral jäta meile tagasisidet</a>");
    // the code under the button, as ecourseOpenMail has it (an owner default), with the way to type it on the login page
    expect(m.html).toContain("864209");
    expect(m.html).toContain(`href="${BASE}/konto/sisene#email=kati%40example.com&amp;kood=1"`);
    expect(m.html.indexOf(">Vaata protokolli</a>")).toBeLessThan(m.html.indexOf("864209"));
  });

  test("the re-send says 'uuendatud' and has no feedback line", () => {
    const m = protocolMail(input({ again: true }));
    expect(m.subject).toBe("Sinu koolituse protokolli on uuendatud");
    expect(m.text).toContain("Sinu koolituse protokolli on uuendatud.");
    expect(m.text).not.toContain("tagasiside");
    expect(m.html).not.toContain("tagasiside");
  });

  test("without a login (she has 3 live ones): the button opens the page, which asks her to sign in; no 30-minute line", () => {
    const m = protocolMail(input({ login: null }));
    expect(protocolUrl(BASE, "et", 42)).toBe(`${BASE}/konto/protokoll#id=42`);
    expect(m.text).toContain(`Vaata protokolli:\n${BASE}/konto/protokoll#id=42`);
    expect(m.text).not.toContain("30 minutit");
    expect(m.text).not.toContain("sisselogimiskood");
  });

  test("Review Focus 5: Russian for a Russian registration: the texts, the course's Russian title and the Russian pages", () => {
    const m = protocolMail(input({ locale: "ru" }));
    expect(m.subject).toBe("Протокол вашего обучения готов");
    expect(m.text).toContain("Ламинирование бровей");
    expect(m.text).toContain(`${BASE}/api/konto/verify?t=${TOKEN}&l=ru&p=42`);
    expect(m.text).toContain(`По желанию оставьте нам отзыв:\n${feedbackUrl(BASE, "ru", 42)}`);
    expect(feedbackUrl(BASE, "ru", 42)).toBe(`${BASE}/ru/konto/tagasiside#id=42`);
    expect(m.html).toContain('<html lang="ru">');
    expect(protocolMail(input({ locale: "ru", again: true })).subject).toBe("Протокол вашего обучения обновлён");
  });

  test("an individual course has no day in the box; every value is escaped", () => {
    const m = protocolMail(input({ session: null, course: { et: "<b>Kulmud</b> & ripsmed" }, name: "" }));
    expect(m.text).toContain("Tere!\n\nSinu koolituse protokoll on valmis.\n\n<b>Kulmud</b> & ripsmed\n\nVaata protokolli:");
    expect(m.html).toContain("&lt;b&gt;Kulmud&lt;/b&gt; &amp; ripsmed");
    expect(m.html).not.toContain("<b>Kulmud");
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**: `npx vitest run tests/unit/protocol-mail.test.ts` (`protocolMail` does not exist).

- [ ] **Step 4: The mail** (`src/server/account-mail.ts`).
  1. Replace `verifyLink` and its comment (lines 20–26) with:

```ts
/**
 * The link in the login e-mail: it signs in the device that opens it (api/konto verify). `pageLocale` is the language of
 * the login page: "ru" adds `&l=ru` (a new account is Russian, a failed link opens the Russian login page); Estonian adds
 * nothing, as before. `protocolId` (the protocol mail, phase protocols) adds `&p=<registration>`: after the login the link
 * opens that protocol instead of Minu koolitused.
 */
export const verifyLink = (siteUrl: string, token: string, pageLocale: Locale = "et", protocolId?: number): string =>
  `${siteUrl.replace(/\/+$/, "")}/api/konto/verify?t=${encodeURIComponent(token)}${pageLocale === "ru" ? "&l=ru" : ""}${protocolId === undefined ? "" : `&p=${protocolId}`}`;
```

  2. Append at the end of the file:

```ts
// ---------- the protocol's mails (phase protocols, spec §6) ----------

/** The student's protocol page: /konto/protokoll#id=<registration> (the id in the fragment: an account page never has a query). */
export const protocolUrl = (siteUrl: string, locale: Locale, registrationId: number): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto/protokoll")}#id=${registrationId}`;

/** A registration's feedback form: /konto/tagasiside#id=<registration>. */
export const feedbackUrl = (siteUrl: string, locale: Locale, registrationId: number): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto/tagasiside")}#id=${registrationId}`;

export type ProtocolMailInput = {
  siteUrl: string;
  email: string;
  name: string;
  /** The registration's language (spec §6). */
  locale: Locale;
  registrationId: number;
  course: I18n;
  session: SessionInfo | null;
  /** Sent before ("Saada uuesti"): "… on uuendatud", and no feedback line. */
  again: boolean;
  /**
   * A live login (client-auth.ts issueClientLogin): the button signs her in on the device that opens it and shows the protocol. null (she has
   * 3 live ones already): the button opens the page, which asks her to sign in.
   */
  login: LoginCode | null;
};

/**
 * "Sinu koolituse protokoll on valmis" / "… on uuendatud" (spec §6): the greeting, one line, the course with its date and place, one button
 * "Vaata protokolli" (with a login: verifyLink with the protocol as its target, written out under the button, then the six-digit code, how long
 * both work, and the small link to type the code on the login page, as ecourseOpenMail has them), and on the first send the line "Soovi korral
 * jäta meile tagasisidet", a text link to the form. No note of the protocol is in it: only the link.
 * Plain text and HTML. The caller (server/protocols.ts) never sends it to a sample address.
 */
export function protocolMail(input: ProtocolMailInput): Mail {
  const dict = getDict(input.locale);
  const m = dict.account.protocolMail;
  const mail = dict.account.mail;
  const title = pick(input.course, input.locale);
  const subject = input.again ? m.subjectAgain : m.subjectFirst;
  const lead = input.again ? m.leadAgain : m.leadFirst;
  const greeting = hello(dict.account.dashboard, input.name);
  const link = input.login ? verifyLink(input.siteUrl, input.login.token, input.locale, input.registrationId) : protocolUrl(input.siteUrl, input.locale, input.registrationId);
  const lines = input.session ? sessionLines(input.session, input.locale) : [];
  const form = input.again ? null : feedbackUrl(input.siteUrl, input.locale, input.registrationId);
  // the code under the button (an owner default): its link opens the login page at the code step
  const codeLink = accountLink(input.siteUrl, input.email, input.locale, true);
  const text = [
    greeting, "",
    lead, "",
    title, ...lines, "",
    `${m.button}:`, link,
    ...(input.login ? ["", mail.codeIntro, "", input.login.code, "", m.valid, "", mail.confirm.codeHere, codeLink] : []),
    ...(form ? ["", `${m.feedback}:`, form] : []),
    "", mail.signature,
  ].join("\n");
  const html = mailCard(subject, input.locale, [
    greetingRow(greeting),
    paragraphRow(lead),
    boxRow(`<div style="font:600 18px/1.4 ${FONT};color:${INK};">${esc(title)}</div>` + lines.map((line) => `<div>${esc(line)}</div>`).join(""), 12),
    buttonRow(link, m.button),
    linkRow(link),
    ...(input.login
      ? [
          paragraphRow(mail.codeIntro, 24),
          codeRow(input.login.code),
          row(`padding:16px 28px 0;${textStyle(14)}`, esc(m.valid)),
          row(`padding:12px 28px 0;${textStyle(14)}`, `${esc(mail.confirm.codeHere)} <a href="${esc(codeLink)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.codeLink)}</a>`),
        ]
      : []),
    ...(form ? [row(`padding:20px 28px 0;${textStyle(14)}`, `<a href="${esc(form)}" style="color:${INK};text-decoration:underline;">${esc(m.feedback)}</a>`)] : []),
    signatureRow(mail),
  ]);
  return { to: input.email, subject, text, html };
}
```

- [ ] **Step 5: Run** `npx vitest run tests/unit/protocol-mail.test.ts tests/unit/account-mail.test.ts tests/unit/i18n.test.ts` — expect PASS (the login mail's links are unchanged: `protocolId` is optional).

- [ ] **Step 6: Write the failing send tests** `tests/db/protocols-send.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clientLoginTokens, clients, courses, protocols, registrations } from "@/db/schema";
import type { Env } from "@/server/notify";
import { saveProtocol, sendProtocol, sendProtocols, type SendDeps } from "@/server/protocols";
import { fakeKv, stubFetch } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// "Saada" (spec §4, §6, §8, D3, D4; §10 DB): the send freezes the snapshot and a later edit leaves it; it creates the account and links the
// registration; the mail goes after the commit with a login that opens the protocol; re-send; and every refusal. The race of two sends at
// once runs on real Postgres (tests/e2e/protocols-race.spec.ts).

const SITE = "https://mslab.example";
const DAY_END = new Date("2026-10-12T15:00:00Z");
let db: Db;
let resend: ReturnType<typeof stubFetch>;
beforeEach(async () => {
  db = await makeTestDb();
  resend = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" });
function deps(now = DAY_END) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: SendDeps = { db, env: env(), siteUrl: SITE, now, later: (task) => void tasks.push(task) };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
type SentMail = { to: string; subject: string; text: string; html: string };
const mails = () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const write = (registrationId: number, version: number, note: string, generalNote = "Tubli töö") =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes: [note, "", "", ""], generalNote }, new Date("2026-10-12T09:00:00Z"));
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];
const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];

async function setup() {
  const { course, session } = await protocolCourse(db);
  return { course, session, mari: await student(db, course, session, "Mari Maasikas") };
}

describe("sendProtocol", () => {
  test("the first send freezes the text, creates her account and links the registration; the mail goes after the commit, with a login that opens it", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "Kulmud said ühtlased");
    const { d, queued, flush } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "sent", again: false, version: 1, sentAt: DAY_END.toISOString() });
    expect(await stored(mari.id)).toMatchObject({
      version: 1,
      sentAt: DAY_END,
      sentVersion: 1,
      sent: { stages: HEADINGS.map((title, i) => ({ title, note: i === 0 ? "Kulmud said ühtlased" : "" })), generalNote: "Tubli töö" },
    });
    const [account] = await db.select().from(clients);
    expect(account).toMatchObject({ email: "marimaasikas@example.com", locale: "et" });
    expect((await registration(mari.id)).clientId).toBe(account.id);
    // nothing is mailed inside the transaction: the mail is queued, and goes when the work after the answer runs
    expect(mails()).toEqual([]);
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect([mail.to, mail.subject]).toEqual(["marimaasikas@example.com", "Sinu koolituse protokoll on valmis"]);
    expect(mail.text).toContain(`${SITE}/api/konto/verify?t=`);
    expect(mail.text).toContain(`&p=${mari.id}`);
    expect(mail.text).toContain(`${SITE}/konto/tagasiside#id=${mari.id}`);
    // the notes are never in a mail
    for (const body of [mail.text, mail.html]) for (const note of ["Kulmud said ühtlased", "Tubli töö"]) expect(body).not.toContain(note);
    expect(await db.select({ email: clientLoginTokens.email }).from(clientLoginTokens)).toEqual([{ email: "marimaasikas@example.com" }]);
  });

  test("the same version sent again (a second tap, another device) does nothing: already, no second mail", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    const again = deps(new Date("2026-10-12T15:01:00Z"));
    expect(await sendProtocol(again.d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "already", version: 1, sentAt: DAY_END.toISOString() });
    expect(again.queued()).toBe(0);
    expect((await stored(mari.id)).sentAt).toEqual(DAY_END);
  });

  test("an edit after the send leaves the sent copy; 'Saada uuesti' freezes the new text and mails 'uuendatud' without the feedback line (D4)", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "Esimene");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    await write(mari.id, 1, "Esimene. Teine");
    expect(await stored(mari.id)).toMatchObject({ version: 2, sentVersion: 1, sent: { stages: expect.arrayContaining([{ title: "Ettevalmistus", note: "Esimene" }]) } });
    const later = new Date("2026-10-12T16:00:00Z");
    const { d, flush } = deps(later);
    expect(await sendProtocol(d, { registrationId: mari.id, version: 2 })).toEqual({ kind: "sent", again: true, version: 2, sentAt: later.toISOString() });
    expect(await stored(mari.id)).toMatchObject({ sentVersion: 2, sentAt: later, sent: { stages: expect.arrayContaining([{ title: "Ettevalmistus", note: "Esimene. Teine" }]) } });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Sinu koolituse protokolli on uuendatud");
    expect(mail.text).not.toContain("tagasiside");
    expect(await db.select().from(clients)).toHaveLength(1); // the account made by the first send
  });

  test("the version the screen showed must be the stored one: stale, nothing changes", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await write(mari.id, 1, "AB"); // another device saved meanwhile
    const { d, queued } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "stale", version: 2 });
    expect([(await stored(mari.id)).sentAt, queued(), (await db.select().from(clients)).length]).toEqual([null, 0, 0]);
  });

  test("nothing written is empty and never sent: no protocol yet, or only blank text", async () => {
    const { course, session, mari } = await setup();
    expect(await sendProtocol(deps().d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "empty" });
    const anu = await student(db, course, session, "Anu Aas");
    await write(anu.id, 0, "   ", " \n ");
    expect(await sendProtocol(deps().d, { registrationId: anu.id, version: 1 })).toEqual({ kind: "empty" });
    expect(await db.select().from(clients)).toEqual([]);
  });

  test("Review Focus 3: a registration cancelled before the send is never sent: no account, no mail", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    const { d, queued } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "cancelled" });
    expect([(await stored(mari.id)).sentAt, queued(), (await db.select().from(clients)).length]).toEqual([null, 0, 0]);
  });

  test("she has an account already: the registration is linked to it, no second one; a linked registration stays as it is", async () => {
    const { course, session, mari } = await setup();
    const [own] = await db.insert(clients).values({ email: "marimaasikas@example.com", locale: "ru" }).returning();
    await write(mari.id, 0, "A");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    expect(await db.select({ id: clients.id }).from(clients)).toEqual([{ id: own.id }]);
    expect((await registration(mari.id)).clientId).toBe(own.id);
    const [other] = await db.insert(clients).values({ email: "teine@example.com" }).returning();
    const linked = await student(db, course, session, "Liis Lepp", { clientId: other.id });
    await write(linked.id, 0, "B");
    await sendProtocol(deps().d, { registrationId: linked.id, version: 1 });
    expect((await registration(linked.id)).clientId).toBe(other.id);
    expect(await db.select().from(clients)).toHaveLength(2);
  });

  test("a sample address is never mailed; the protocol is sent all the same", async () => {
    const { course, session } = await setup();
    const sample = await student(db, course, session, "Proov Naidis", { email: "proov.naidis@example.test" });
    await write(sample.id, 0, "A");
    const { d, flush } = deps();
    expect(await sendProtocol(d, { registrationId: sample.id, version: 1 })).toMatchObject({ kind: "sent" });
    await flush();
    expect(mails()).toEqual([]);
    expect(await db.select().from(clientLoginTokens)).toEqual([]);
  });

  test("a mail that fails never undoes the send", async () => {
    const { mari } = await setup();
    resend = stubFetch(() => new Response("down", { status: 500 }));
    await write(mari.id, 0, "A");
    const { d, flush } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toMatchObject({ kind: "sent" });
    await expect(flush()).resolves.toBeDefined();
    expect((await stored(mari.id)).sentVersion).toBe(1);
  });

  test("Review Focus 5: a Russian registration gets the Russian mail and the Russian pages", async () => {
    const { course, session } = await setup();
    const olga = await student(db, course, session, "Olga Ivanova", { locale: "ru" });
    await write(olga.id, 0, "Хорошо");
    const { d, flush } = deps();
    await sendProtocol(d, { registrationId: olga.id, version: 1 });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Протокол вашего обучения готов");
    expect(mail.text).toContain("&l=ru");
    expect(mail.text).toContain(`${SITE}/ru/konto/tagasiside#id=${olga.id}`);
  });

  test("an e-course's registration, or none: notFound", async () => {
    const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
    const buyer = await student(db, ecourse, null, "Eva");
    expect(await sendProtocol(deps().d, { registrationId: buyer.id, version: 1 })).toEqual({ kind: "notFound" });
    expect(await sendProtocol(deps().d, { registrationId: 999_999, version: 1 })).toEqual({ kind: "notFound" });
  });
});

describe("sendProtocols ('Lukusta ja saada kõik')", () => {
  test("each one in its own transaction, in order; a refusal or a failure does not stop the others, and is reported by its id", async () => {
    const { course, session, mari } = await setup();
    const anu = await student(db, course, session, "Anu Aas");
    const eve = await student(db, course, session, "Eve Kask");
    await write(mari.id, 0, "Mari");
    await write(anu.id, 0, "Anu");
    await write(eve.id, 0, "Eve");
    const { d, queued } = deps();
    // the second student's transaction fails (a dropped connection, say)
    const target = db as unknown as { transaction: (fn: unknown) => Promise<unknown> };
    const real = target.transaction.bind(db);
    let n = 0;
    vi.spyOn(target, "transaction").mockImplementation((fn) => (++n === 2 ? Promise.reject(new Error("connection lost")) : real(fn)));
    const results = await sendProtocols(d, [
      { registrationId: mari.id, version: 1 },
      { registrationId: anu.id, version: 1 },
      { registrationId: 999_999, version: 1 },
      { registrationId: eve.id, version: 1 },
    ]);
    expect(results.map((r) => [r.registrationId, r.result.kind])).toEqual([[mari.id, "sent"], [anu.id, "failed"], [999_999, "notFound"], [eve.id, "sent"]]);
    expect(queued()).toBe(2);
    expect((await stored(anu.id)).sentAt).toBeNull();
  });
});
```

  The failing transaction is the second call of `db.transaction`: the first student's send uses one, the second student's is the one refused (its `addClient` would have opened a savepoint inside it, never a call of `db.transaction` itself).

- [ ] **Step 7: Run it — expect FAIL**: `npx vitest run tests/db/protocols-send.test.ts` (`sendProtocol` does not exist).

- [ ] **Step 8: The send** (`src/server/protocols.ts`).
  1. Replace the import block at the top with:

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { draftOf, type ProtocolDraft } from "@/db/queries/protocols";
import { lockRegistration } from "@/db/queries/seats";
import { courses, courseSessions, protocols, registrations, type Protocol, type ProtocolStage } from "@/db/schema";
import { isSampleAddress, normalizeEmail } from "@/domain/email";
import { hasText, overLimit, PROTOCOL_LIMITS, readStages } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { storable } from "@/lib/storable";
import { protocolMail, type SessionInfo } from "./account-mail";
import { addClient } from "./admin-clients";
import { issueClientLogin, lockAddress } from "./client-auth";
import { logFailure } from "./log";
import { mailConfigured, sendMail, type Env } from "./notify";
```

  2. Append at the end of the file:

```ts
// ---------- sending (spec §4 "Saada", §6, §8) ----------

export type SendDeps = {
  db: Db;
  /** The mail's settings (Resend). */
  env: Env;
  /** The base of the mail's links: the address Maria works on (mslab.ee), or SITE_URL. */
  siteUrl: string;
  now: Date;
  /** Runs work after the answer: the mail (next/server after(); collected and awaited in the tests). */
  later: (task: () => Promise<unknown>) => void;
};

/**
 * What a send did. sent: frozen now (`again`: it had been sent before, so the mail says "uuendatud"); already: this version was sent before
 * (a second tap, another device), nothing done; empty: nothing written, never sent; stale: the stored version is not the one the screen
 * showed (`version`: the stored one); cancelled: the registration is cancelled, never sent; notFound: no registration of a contact course.
 */
export type SendResult =
  | { kind: "sent"; again: boolean; version: number; sentAt: string }
  | { kind: "already"; version: number; sentAt: string }
  | { kind: "empty" }
  | { kind: "stale"; version: number }
  | { kind: "cancelled" }
  | { kind: "notFound" };

/** A send as the screen's actions answer it: failed when it threw (logged by the registration's id). */
export type SendOutcome = SendResult | { kind: "failed" };

/** The mail of a sent protocol, made after the commit: to whom, in which language, about which course. */
type ProtocolMailJob = { registrationId: number; email: string; name: string; locale: "et" | "ru"; course: I18n; session: SessionInfo | null; again: boolean };

/**
 * "Saada" (spec §4, §8, D3): one student's protocol, at the `version` the screen showed, in one transaction:
 * 1. the locks, in the order every writer of these rows takes them: the address (client-auth.ts lockAddress — the logins and addClient take
 *    it and then write registrations, so taking the registration first would deadlock with a login at the same moment), then the
 *    registration (db/queries/seats.ts lockRegistration), then the protocol row (FOR UPDATE: a save that comes meanwhile waits for the freeze);
 * 2. the checks: a cancelled registration is never sent; nothing written is "empty"; another version than the screen's is "stale"; the
 *    version sent already is "already" (two sends at once: the first sends, the second finds it sent);
 * 3. the account: when the registration has none, the address's account is found or created as "Lisa õpilane" does it (admin-clients.ts
 *    addClient, in a savepoint of this transaction) and the registration is linked to it;
 * 4. the freeze: `sent` = the draft as it is, `sent_at`, `sent_version`.
 * The mail goes out after the commit (`later`): a live login in its button, the feedback line on the first send. A mail that fails never
 * undoes the send. A sample address is never mailed.
 */
export async function sendProtocol(deps: SendDeps, input: { registrationId: number; version: number }): Promise<SendResult> {
  const [peek] = await deps.db.select({ email: registrations.email }).from(registrations).where(eq(registrations.id, input.registrationId)).limit(1);
  if (!peek) return { kind: "notFound" };
  const done = await deps.db.transaction(async (tx): Promise<{ result: SendResult; mail: ProtocolMailJob | null }> => {
    const t = tx as unknown as Db;
    const none = (result: SendResult) => ({ result, mail: null });
    await lockAddress(t, normalizeEmail(peek.email));
    await lockRegistration(tx, input.registrationId);
    const [r] = await tx
      .select({ registration: registrations, course: { type: courses.type, title: courses.title }, session: courseSessions })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .where(eq(registrations.id, input.registrationId))
      .limit(1);
    if (!r || r.course.type !== "contact") return none({ kind: "notFound" });
    if (r.registration.status === "cancelled") return none({ kind: "cancelled" });
    const [p] = await tx.select().from(protocols).where(eq(protocols.registrationId, input.registrationId)).for("update");
    if (!p || !hasText(p)) return none({ kind: "empty" });
    if (p.version !== input.version) return none({ kind: "stale", version: p.version });
    if (p.sentAt !== null && p.sentVersion === p.version) return none({ kind: "already", version: p.version, sentAt: p.sentAt.toISOString() });
    if (r.registration.clientId === null) {
      const client = await addClient(t, r.registration.email);
      if (client.ok)
        await tx.update(registrations).set({ clientId: client.id }).where(and(eq(registrations.id, input.registrationId), isNull(registrations.clientId)));
    }
    await tx
      .update(protocols)
      .set({ sent: sql`jsonb_build_object('stages', ${protocols.stages}, 'generalNote', ${protocols.generalNote})`, sentAt: deps.now, sentVersion: p.version })
      .where(eq(protocols.registrationId, input.registrationId));
    const s = r.session;
    const again = p.sentAt !== null;
    return {
      result: { kind: "sent", again, version: p.version, sentAt: deps.now.toISOString() },
      mail: {
        registrationId: input.registrationId,
        email: r.registration.email,
        name: r.registration.name,
        locale: r.registration.locale === "ru" ? "ru" : "et",
        course: r.course.title,
        session: s ? { startsAt: s.startsAt, city: s.city, venue: s.venue } : null,
        again,
      },
    };
  });
  if (done.result.kind === "sent") console.info(`[protocols] registration ${input.registrationId}: sent${done.result.again ? " again" : ""}`);
  const job = done.mail;
  if (job) deps.later(() => mailProtocol(deps, job));
  return done.result;
}

/**
 * The protocol's mail, after the commit: never to a sample address, not counted in the daily caps (it follows Maria's own send, a handful a
 * course day). The login is a normal client login made only now (client-auth.ts issueClientLogin), so its 30 minutes start with the mail; an
 * address that has its 3 already gets the mail without one. A failure is logged by the registration's id and never undoes the send.
 */
async function mailProtocol(deps: SendDeps, job: ProtocolMailJob): Promise<void> {
  if (isSampleAddress(job.email) || !mailConfigured(deps.env)) return;
  try {
    const login = await issueClientLogin(deps.db, job.email, deps.now);
    const sent = await sendMail(deps.env, protocolMail({ siteUrl: deps.siteUrl, ...job, login }));
    console.info(`[protocols] registration ${job.registrationId}: the mail sent: ${sent}`);
  } catch (e) {
    logFailure(`[protocols] registration ${job.registrationId}: the mail failed`, e);
  }
}

/** One student's outcome of "Lukusta ja saada kõik". */
export type BulkResult = { registrationId: number; result: SendOutcome };

/**
 * "Lukusta ja saada kõik" (spec §4, §8): the protocols the confirmation listed, one after another, each in its own transaction (sendProtocol),
 * so one that fails does not stop the others; a throw is "failed", logged by the registration's id.
 */
export async function sendProtocols(deps: SendDeps, items: readonly { registrationId: number; version: number }[]): Promise<BulkResult[]> {
  const out: BulkResult[] = [];
  for (const item of items) {
    try {
      out.push({ registrationId: item.registrationId, result: await sendProtocol(deps, item) });
    } catch (e) {
      logFailure(`[protocols] registration ${item.registrationId}: the send failed`, e);
      out.push({ registrationId: item.registrationId, result: { kind: "failed" } });
    }
  }
  return out;
}
```

- [ ] **Step 9: Run** `npx vitest run tests/db/protocols-send.test.ts tests/db/protocols-save.test.ts` — expect PASS.

- [ ] **Step 10: The login that opens the protocol — write the failing tests.**
  1. `tests/db/verify-protocol.test.ts` (new):

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { verifyLink } from "@/server/account-mail";
import { issueClientLogin } from "@/server/client-auth";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";

// The protocol mail's button (phase protocols): the login link with `p=<registration>` signs her in and opens that protocol, in her account's
// language, the id after the login mark in the fragment. Without one (or with a p that is no id) the login opens Minu koolitused as before.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const deps = (): AccountDeps => ({
  db,
  env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
});
const open = async (link: string) => (await handleAccountApi(new Request(link), deps()))!;
const login = async () => (await issueClientLogin(db, "kati@example.test", NOW))!.token;

test("the link with the protocol signs her in and opens it; a Russian account opens the Russian page", async () => {
  const res = await open(verifyLink(SITE, await login(), "et", 42));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${SITE}/konto/protokoll#sisse&id=42`);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-mslab_client=") && !c.includes("Max-Age=0"))).toBe(true);
  await db.update(clients).set({ locale: "ru" });
  expect((await open(verifyLink(SITE, await login(), "ru", 42))).headers.get("location")).toBe(`${SITE}/ru/konto/protokoll#sisse&id=42`);
});

test("without a protocol, or with a p that is no id, it opens Minu koolitused; a used link opens the login page, never the protocol", async () => {
  const token = await login();
  expect((await open(`${verifyLink(SITE, token)}&p=abc`)).headers.get("location")).toBe(`${SITE}/konto#sisse`);
  expect((await open(verifyLink(SITE, token, "et", 42))).headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
  expect((await open(verifyLink(SITE, await login(), "et", 0))).headers.get("location")).toBe(`${SITE}/konto#sisse`);
});
```

  2. `tests/unit/use-account.test.ts`: after the test "opened by the login link (#sisse): …", add:

```ts
  test("opened by the protocol mail's login (#sisse&id=42): the copy is forgotten and the mark leaves, the protocol's id stays (phase protocols)", async () => {
    window.history.replaceState(null, "", "/konto/protokoll#sisse&id=42");
    localStorage.setItem("mslab-account-fav", '["someone-elses"]');
    fetchMock.mockImplementation(async () => json(500, { ok: false }));
    await mount();
    expect(localStorage.getItem("mslab-account-fav")).toBeNull();
    expect(window.location.pathname).toBe("/konto/protokoll");
    expect(window.location.hash).toBe("#id=42");
  });
```

  3. Run `npx vitest run tests/db/verify-protocol.test.ts tests/unit/use-account.test.ts` — expect FAIL (the target is ignored: `/konto#sisse`; the hash `#sisse&id=42` is left as it is).

- [ ] **Step 11: The login that opens the protocol.**
  1. **`src/server/account-api.ts` `verify`.** In its comment, after "goes to the client's own page (/konto#sisse, /ru/konto#sisse, by the client's language: …)", add the sentence "With `p=<registration id>` (the protocol mail's button, phase protocols) it goes to that protocol instead: /konto/protokoll#sisse&id=<id> (the mark first, the id after it, both in the fragment)." and replace the line

```ts
    return redirect(url, `${session.locale === "ru" ? "/ru/konto" : "/konto"}#${LOGIN_MARK}`, sessionCookies(session.sessionRaw));
```

     with

```ts
    const home = session.locale === "ru" ? "/ru/konto" : "/konto";
    // the protocol mail's button: its protocol, the id after the login mark (components/account/useAccount.ts takes the mark and keeps the id)
    const protocolId = parseRowId(url.searchParams.get("p") ?? "");
    return redirect(url, protocolId === null ? `${home}#${LOGIN_MARK}` : `${home}/protokoll#${LOGIN_MARK}&id=${protocolId}`, sessionCookies(session.sessionRaw));
```

  2. **`src/components/account/useAccount.ts`.** Replace `takeLoginMark` and its comment with:

```ts
/**
 * An account page opened by the login link (/konto#sisse, server/account-api.ts verify; the protocol mail's /konto/protokoll#sisse&id=<n>):
 * this browser forgets the copy of the favourites a previous session left here before the new account's own list is loaded, and the mark
 * leaves the address (a reload must not repeat it); what follows it in the fragment (the protocol's id) stays. A login with the code does the
 * same in the login form.
 */
function takeLoginMark(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has(LOGIN_MARK)) return;
  forgetAccountFavourites();
  params.delete(LOGIN_MARK);
  const rest = params.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
}
```

  3. Run `npx vitest run tests/db/verify-protocol.test.ts tests/unit/use-account.test.ts tests/db/account-api.test.ts tests/unit/account-guards.test.ts` — expect PASS.

- [ ] **Step 12: The server actions** — create `src/server/actions/admin-protocols.ts`:

```ts
"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { serverEnv } from "../env";
import { serverKv } from "../kv";
import { logFailure } from "../log";
import { sendProtocol, sendProtocols, type BulkResult, type SendDeps, type SendOutcome } from "../protocols";
import { linkBase, requestOrigin } from "../site";

// The protocol screen's sends (phase protocols, spec §4, §8): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../protocols.ts. The screen keeps its own state (the autosave's), so nothing is refreshed here, and no public page shows a protocol.

const item = z.object({ registrationId: z.number().int().positive().max(2_147_483_647), version: z.number().int().positive().max(2_147_483_647) });
const items = z.array(item).min(1).max(100);

async function deps(): Promise<SendDeps> {
  const env = { ...serverEnv(), KV: serverKv() };
  return {
    db: getDb(),
    env,
    // the mail's links: the address Maria works on (mslab.ee), or SITE_URL
    siteUrl: linkBase(requestOrigin(await headers()), env.SITE_URL),
    now: new Date(),
    later: (task) => after(() => task().catch((e) => logFailure("[protocols] a mail failed", e))),
  };
}

/** "Saada" / "Saada uuesti": one student's protocol, at the version the screen showed (after its last save was confirmed). */
export const sendProtocolAction = adminAction(async (_admin, input: { registrationId: number; version: number }): Promise<SendOutcome> => {
  const parsed = item.safeParse(input);
  if (!parsed.success) return { kind: "notFound" };
  try {
    return await sendProtocol(await deps(), parsed.data);
  } catch (e) {
    logFailure(`[protocols] registration ${parsed.data.registrationId}: the send failed`, e);
    return { kind: "failed" };
  }
});

/** "Lukusta ja saada kõik": the protocols the confirmation listed, each in a transaction of its own; a failure is reported by its id. */
export const sendProtocolsAction = adminAction(async (_admin, input: { registrationId: number; version: number }[]): Promise<BulkResult[]> => {
  const parsed = items.safeParse(input);
  if (!parsed.success) return [];
  return sendProtocols(await deps(), parsed.data);
});
```

  And in `tests/unit/admin-guards.test.ts`: in the first test's second `arrayContaining` list, after `"app/api/admin/protokoll/route.ts",` add `"server/actions/admin-protocols.ts",`; and in "every admin page calls requireAdmin() itself and every admin action is wrapped", before its closing comment, add:

```ts
    const protocolActions = files().find((f) => f.path === "server/actions/admin-protocols.ts")!;
    const protocolExports = [...strip(protocolActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(protocolExports).toEqual(["sendProtocolAction", "sendProtocolsAction"]);
    expect(violations(protocolActions.path, protocolActions.source)).toEqual([]);
    expect([...strip(protocolActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(protocolExports);
```

- [ ] **Step 13: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — green. `npx playwright test account-login account-dashboard` (the login link still lands on `/konto`).

- [ ] **Step 14: Commit.**

```bash
git add app/src/server/protocols.ts app/src/server/account-mail.ts app/src/server/account-api.ts app/src/components/account/useAccount.ts app/src/i18n/dict/et.ts app/src/i18n/dict/ru.ts app/src/server/actions/admin-protocols.ts app/tests
git commit -m "feat(protocols): sending — one transaction per student, the account and the link, the two mails, a login that opens the protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The course editor's "Protokolli punktid"

Spec section 3 (`courses.protocol_stages`, the limits). A contact course's headings are part of the course draft and saved with "Salvesta", as "Koolitus sisaldab" is; an e-course keeps none (its type's fields only, as today). The headings are plain strings in the language Maria writes in: one field each, no ET / RU switch, so `ListEditor` (two languages) is not used.

**Files:**
- Modify: `app/src/domain/course-editor.ts` (`CourseDraft`, `newCourseDraft`, `StoredCourse`, `draftFromCourse`)
- Modify: `app/src/server/admin-content.ts` (`draftSchema`, `saveCourseForm`)
- Create: `app/src/components/admin/ProtocolStagesEditor.tsx`
- Modify: `app/src/components/admin/CourseEditor.tsx` (after the "Koolitus sisaldab" section)
- Modify: `app/src/i18n/dict/admin.ts` (`courseEditor.sections`, `courseEditor.fields`)
- Modify: `app/tests/e2e/fixtures.ts` (`JSON_COLUMNS`: a snapshotted course is restored with its headings)
- Test: `app/tests/unit/admin-content.test.ts`, `app/tests/db/admin-content.test.ts` (extend); `app/tests/unit/protocol-stages-dom.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `checkStages`, `readStages`, `PROTOCOL_LIMITS`.
- Produces: `CourseDraft.protocolStages: string[]`; `ProtocolStagesEditor({ items, onChange, error }: { items: string[]; onChange(items: string[]): void; error?: string })` (`[data-protocol-stages]`, each field `[data-protocol-stage=<i>]`, "Lisa punkt" `[data-add-stage]`); the field error key `protocolStages` (`tooMany` | `tooLong`).

- [ ] **Step 1: Write the failing tests.**
  1. **`tests/unit/admin-content.test.ts`**, in "a stored course becomes a draft …": add `protocolStages: ["Ettevalmistus", "  ", "Värvimine"],` to `stored` (after `includes`), `protocolStages: ["Ettevalmistus", "Värvimine"],` to the `toMatchObject` of `d` (the blank one is not a heading), and `protocolStages: []` to the last line's `toMatchObject` of `newCourseDraft()`.
  2. **`tests/db/admin-content.test.ts`**, at the end:

```ts
describe("saveCourseForm: 'Protokolli punktid' (phase protocols, spec §3)", () => {
  test("a contact course keeps its headings trimmed, without blank rows, in their order; an e-course keeps none", async () => {
    const draft = await load(contact.id);
    expect(draft.protocolStages).toEqual([]);
    expect(await save({ ...draft, protocolStages: [" Ettevalmistus ", "", "Kulmude analüüs", "Värvimine"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    expect((await load(contact.id)).protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    const e = await load(online.id);
    expect(await save({ ...e, protocolStages: ["Ei kuulu siia"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, online.id))!.protocolStages).toEqual([]);
  });

  test("more than 30 headings, or one over 120 characters, is refused on its field and nothing is saved", async () => {
    const draft = await load(contact.id);
    expect(fieldsOf(await save({ ...draft, protocolStages: Array.from({ length: 31 }, (_, i) => `Punkt ${i + 1}`) }))).toEqual({ protocolStages: "tooMany" });
    expect(fieldsOf(await save({ ...draft, protocolStages: ["x".repeat(121)] }))).toEqual({ protocolStages: "tooLong" });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual([]);
    expect(await save({ ...draft, protocolStages: Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`) })).toMatchObject({ ok: true });
  });

  test("a draft without the headings (an editor page opened before the deploy) still saves, with none", async () => {
    const older: Partial<CourseDraft> = { ...(await load(contact.id)) };
    delete older.protocolStages;
    expect(await saveCourseForm(db, form({ data: JSON.stringify(older) }))).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual([]);
  });
});
```

  3. **`tests/unit/protocol-stages-dom.test.ts`** (new):

```ts
// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ProtocolStagesEditor } from "@/components/admin/ProtocolStagesEditor";

// "Protokolli punktid" in the course editor (phase protocols, spec §3): one plain field per heading, in order, with ↑ / ↓ / ×, "Lisa punkt",
// at most 30 (the button says so then), each field at most 120 characters.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let current: string[] = [];
function Harness({ initial }: { initial: string[] }) {
  const [items, setItems] = useState(initial);
  current = items;
  return createElement(ProtocolStagesEditor, { items, onChange: setItems });
}
// a new key for each list: a new editor, as the course editor's reload gives one
const render = async (initial: string[]) => act(async () => root.render(createElement(Harness, { key: initial.join("|"), initial })));
const fields = () => [...container.querySelectorAll<HTMLInputElement>("[data-protocol-stage]")];
const click = async (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("add, type, move and remove; the new field takes the focus; each field is labelled and takes at most 120 characters", async () => {
  await render(["Ettevalmistus"]);
  await click(container.querySelector("[data-add-stage]"));
  expect(fields()).toHaveLength(2);
  expect(document.activeElement).toBe(fields()[1]);
  await type(fields()[1], "Värvimine");
  expect(current).toEqual(["Ettevalmistus", "Värvimine"]);
  expect(fields()[1].maxLength).toBe(120);
  expect(container.querySelector(`label[for="${fields()[1].id}"]`)?.textContent).toBe("Punkt 2");
  await click(container.querySelector('[aria-label="Liiguta rida 2 üles"]'));
  expect(current).toEqual(["Värvimine", "Ettevalmistus"]);
  await click(container.querySelector('[aria-label="Eemalda rida 1"]'));
  expect(current).toEqual(["Ettevalmistus"]);
});

test("none yet says what the protocol has then; at 30 'Lisa punkt' adds nothing and says so", async () => {
  await render([]);
  expect(container.textContent).toContain("Punkte veel pole");
  await render(Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`));
  const add = container.querySelector("[data-add-stage]")!;
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await click(add);
  expect(current).toHaveLength(30);
  expect(container.textContent).toContain("Rohkem kui 30 punkti ei saa lisada.");
});
```

  4. Run `npx vitest run tests/unit/admin-content.test.ts tests/db/admin-content.test.ts tests/unit/protocol-stages-dom.test.ts` — FAIL (`protocolStages` is not in the draft; the component does not exist).

- [ ] **Step 2: The draft** (`src/domain/course-editor.ts`).
  1. Add `import { readStages } from "./protocols";` after `import { centsToInput } from "./money";`.
  2. In `CourseDraft`, after `includes: I18n[];`, add:

```ts
  /** "Protokolli punktid" (phase protocols, spec §3): a contact course's stage headings, plain strings as typed; an e-course has none. */
  protocolStages: string[];
```

  3. In `newCourseDraft()`, after `includes: [],` add `protocolStages: [],`.
  4. In `StoredCourse`, after `includes: I18n[];`, add `protocolStages: string[];`.
  5. In `draftFromCourse`, after `includes: c.includes.map(copy),` add `protocolStages: readStages(c.protocolStages),`.

- [ ] **Step 3: The save** (`src/server/admin-content.ts`).
  1. Add `import { checkStages } from "@/domain/protocols";` after the `@/domain/course-editor` import.
  2. In `draftSchema`, after `includes: z.array(i18n).max(200),` add `protocolStages: z.array(z.string().max(2000)).max(200).default([]),` (loose: the real limits are checkStages', with a field error; the default: an editor page loaded before the deploy posts no headings, and its save must not fail on them).
  3. In `saveCourseForm`, after `const includes = online ? [] : c.list("includes", d.includes);` add:

```ts
  // "Protokolli punktid" (phase protocols): a contact course's headings, trimmed, no blank rows, at most 30 of at most 120 characters
  const stages: ReturnType<typeof checkStages> = online ? { ok: true, stages: [] } : checkStages(d.protocolStages);
  if (!stages.ok) c.fail("protocolStages", stages.error);
```

  4. In the `fields: CourseFields = { … }` literal, after `includes,` add `protocolStages: stages.ok ? stages.stages : [],`.

- [ ] **Step 4: The words** (`src/i18n/dict/admin.ts`, `courseEditor`).
  1. In `sections`, after `includes: "Koolitus sisaldab",` add `protocolStages: "Protokolli punktid",`.
  2. In `fields`, after `includesHint: "Lehel plokis „Koolitus sisaldab“.",` add:

```ts
      // "Protokolli punktid" (phase protocols): the headings of the course day's protocol, in the language Maria writes in
      protocolStage: "Punkt",
      protocolStagesHint: "Koolituspäeva protokolli etapid selles järjekorras, nt Ettevalmistus, Kulmude analüüs. Kirjuta need keeles, milles protokolli kirjutad. Muudatus kehtib protokollidele, mida pole veel alustatud.",
      protocolStagesEmpty: "Punkte veel pole: protokollis on siis ainult üldised märkused.",
      protocolStagesAdd: "Lisa punkt",
      protocolStagesFull: "Rohkem kui 30 punkti ei saa lisada.",
```

- [ ] **Step 5: The editor** — create `src/components/admin/ProtocolStagesEditor.tsx`:

```tsx
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

let rowCount = 0;
const newKey = () => `stage-${++rowCount}`;

/**
 * "Protokolli punktid" (phase protocols, spec §3): this contact course's stage headings for the course day's protocols, in the language Maria
 * writes in (one plain field each, no translation), in order: add, remove, ↑ / ↓; at most 30, each at most 120 characters. Saved with the
 * course ("Salvesta"); blank rows are dropped then. A change reaches only protocols not created yet (the hint says so). As ListEditor: the
 * arrows are aria-disabled at the ends, after adding a row its field gets the focus, after removing one the next row's field (or "Lisa punkt").
 */
export function ProtocolStagesEditor({ items, onChange, error }: { items: string[]; onChange: (items: string[]) => void; error?: string }) {
  const t = adminEt.courseEditor;
  const l = adminEt.list;
  const uid = useId();
  const [keys, setKeys] = useState<string[]>(() => items.map(newKey));
  // the list was replaced from outside (the editor reloads the saved course): new rows, new keys
  if (keys.length !== items.length) setKeys(items.map(newKey));
  const focus = useRef<number | "add" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === "add") addBtn.current?.focus();
    else root.current?.querySelector<HTMLInputElement>(`[data-row="${target}"] input`)?.focus();
  });

  const set = (list: string[], k: string[]) => {
    setKeys(k);
    onChange(list);
  };
  const full = items.length >= PROTOCOL_LIMITS.stages;
  const add = () => {
    if (full) return;
    set([...items, ""], [...keys, newKey()]);
    focus.current = items.length;
  };
  const remove = (i: number) => {
    set(items.filter((_, j) => j !== i), keys.filter((_, j) => j !== i));
    focus.current = items.length > 1 ? Math.min(i, items.length - 2) : "add";
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    set(moveItem(items, i, j), moveItem(keys, i, j));
  };

  return (
    <div
      ref={root}
      className={styles.list}
      data-protocol-stages=""
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={error ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <div className={styles.listHead}>
        <h3 id={`${uid}-title`} className={ui.h3}>
          {t.sections.protocolStages}
        </h3>
      </div>
      <p id={`${uid}-hint`} className={ui.hint}>
        {t.fields.protocolStagesHint}
      </p>
      {items.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.fields.protocolStagesEmpty}</p>
      ) : (
        <ol className={styles.rows}>
          {items.map((item, i) => {
            const n = i + 1;
            const id = `${uid}-${i}`;
            return (
              <li key={keys[i] ?? i} className={styles.item} data-row={i}>
                <span className={styles.num} aria-hidden="true">
                  {String(n).padStart(2, "0")}
                </span>
                <div>
                  <label htmlFor={id} className={ui.sr}>
                    {`${t.fields.protocolStage} ${n}`}
                  </label>
                  <input
                    id={id}
                    className={ui.input}
                    type="text"
                    value={item}
                    maxLength={PROTOCOL_LIMITS.title}
                    autoComplete="off"
                    onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                    data-protocol-stage={i}
                  />
                </div>
                <span className={styles.tools}>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.down, { n })} aria-disabled={i === items.length - 1 || undefined} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={fill(l.remove, { n })} onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && (
        <p id={`${uid}-error`} className={ui.error}>
          {error}
        </p>
      )}
      <button ref={addBtn} type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addBtn}`} aria-disabled={full || undefined} onClick={add} data-add-stage="">
        + {t.fields.protocolStagesAdd}
      </button>
      {full && <p className={ui.hint}>{t.fields.protocolStagesFull}</p>}
    </div>
  );
}
```

- [ ] **Step 6: The course editor uses it** (`src/components/admin/CourseEditor.tsx`).
  1. Add `import { ProtocolStagesEditor } from "./ProtocolStagesEditor";` after `import { ListEditor } from "./ListEditor";`.
  2. After the `{!online && ( <section … aria-label={t.sections.includes}> … </section> )}` block, add:

```tsx
          {/* "Protokolli punktid" (phase protocols): the headings of the course day's protocols, a contact course's only */}
          {!online && (
            <section className={ui.card} aria-label={t.sections.protocolStages}>
              <ProtocolStagesEditor items={draft.protocolStages} onChange={(v) => set("protocolStages", v)} error={err("protocolStages")} />
            </section>
          )}
```

  3. In `tests/e2e/fixtures.ts`, `JSON_COLUMNS` gains `"protocol_stages"` after `"recommendation_ids"` (a content test's snapshot of a seed course restores its headings too).
  4. In `tests/unit/old-safari.test.ts`, `BROWSER_FILES` gains `// Task 4` and `"src/components/admin/ProtocolStagesEditor.tsx"`.

- [ ] **Step 7: Run** `npx vitest run tests/unit/admin-content.test.ts tests/db/admin-content.test.ts tests/unit/protocol-stages-dom.test.ts tests/unit/old-safari.test.ts` — expect PASS.

- [ ] **Step 8: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`; `npx playwright test admin-edit` (the course editor's own tests: a contact course now shows the card; e-courses do not).

- [ ] **Step 9: Commit.**

```bash
git add app/src/domain/course-editor.ts app/src/server/admin-content.ts app/src/components/admin/ProtocolStagesEditor.tsx app/src/components/admin/CourseEditor.tsx app/src/i18n/dict/admin.ts app/tests
git commit -m "feat(admin): the course editor's Protokolli punktid — Maria's stage headings for the course day's protocols

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Maria's screen on the course day — `/admin/protokollid`, the autosave in the browser, and the entry points

Spec section 4 (the route, the entry points, the layout, the autosave), D6 (one-tap entry points, autosave). The send buttons are Task 6's.

**The autosave lives outside React** (`src/components/admin/protocol-autosave.ts`, a small class the screen subscribes to with `useSyncExternalStore`), so its rules are tested without a DOM: debounce, one save of a protocol at a time, the browser's copy, the retries, the 409 and the lost answer. The screen only renders what it holds and tells it what Maria types.

**A lost answer is not a conflict.** On flaky Wi-Fi a save can reach the server while its answer never comes back. The next save then carries the old version and is refused; the 409 brings the stored text, and when that text is one this screen sent and never heard back about, it was ours: the newer text is saved on top of it, with no notice. Only a stored text this screen never sent is another device's, and only then is the notice shown (with this screen's unsaved words in it). The browser's copy keeps the texts sent without an answer too, so a reload after a lost answer resumes the same way. Those texts are kept once each (a retry of the same text adds nothing) and up to 200 000 characters together (`SENT_MAX_CHARS`, the oldest left out first, never the newest), so a long stretch of failed saves never pushes out the one the server holds.

**A real conflict's words outlive the tab.** The notice's text (this screen's words that could not be saved) is kept in the browser under its own key, `mslab-protocol-conflict:<registration>`, until "Selge": a reload, or a tab the tablet discarded, shows the notice again.

**A browser that cannot keep the text** (its storage full or blocked) says so on that protocol while the text is not confirmed ("Seda teksti ei saa selles seadmes hoida …"), beside the chip's "Salvestamata", instead of failing silently.

**While a send is on its way** (Task 6) the protocol takes no edits (`setSending`): its boxes are read-only, so Maria's own typing cannot make the send stale.

**"Avaleht" is the overview.** The spec's "Avaleht: a new 'Täna' card" is the admin's front page, `/admin` ("Ülevaade" in the menu): the menu's "Avaleht" (`/admin/avaleht`) is the site's home page editor.

**Files:**
- Create: `app/src/components/admin/protocol-autosave.ts`, `app/src/components/admin/GrowingText.tsx`, `app/src/components/admin/ProtocolScreen.tsx`, `app/src/components/admin/ProtocolScreen.module.css`
- Create: `app/src/app/admin/(panel)/protokollid/page.tsx`
- Modify: `app/src/db/queries/protocols.ts` (`todaySessions`)
- Modify: `app/src/app/admin/(panel)/kalender/page.tsx` (the session drawer), `app/src/app/admin/(panel)/registreerimised/page.tsx` (`RegistrationDetail`), `app/src/app/admin/(panel)/page.tsx` + `overview.module.css` ("Täna")
- Modify: `app/src/i18n/dict/admin.ts` (`protocols`, `overview.today`)
- Modify: `app/tests/unit/admin-guards.test.ts` (the pages list), `app/tests/e2e/admin-load.spec.ts` (`ADMIN_PAGES`), `app/tests/unit/colour-tokens.test.ts`
- Test: `app/tests/unit/protocol-autosave.test.ts`, `app/tests/unit/protocol-screen-dom.test.ts`, `app/tests/db/protocols-today.test.ts` (new)

**Interfaces:**
- Consumes: `ScreenData`, `protocolScreen` (Task 2), the route `POST /api/admin/protokoll` and its answers (Task 2); `overLimit`, `hasText`, `protocolStatus`, `PROTOCOL_LIMITS`, `NotePlace`, `ProtocolStatus` (Task 1); `toStorable` (Task 1).
- Produces, from `src/components/admin/protocol-autosave.ts`:
  - `type Content = { notes: string[]; generalNote: string }`; `type SaveStatus` (`saved { at }` | `pending` | `saving` | `retrying` | `tooLong { places }` | `signedOut` | `gone`);
  - `type ServerDraft = { registrationId: number; version: number; titles: string[]; content: Content; sentVersion: number | null; sentAt: string | null; savedAt: number | null }`;
  - `type Conflict = { titles: string[]; lost: Content | null }`; `type Entry` (`registrationId, version, titles, confirmed, content, sentVersion, sentAt, savedAt, status, conflict, sending, kept`);
  - `type LocalCopy = { version: number; titles: string[]; content: Content; sent: Content[] }`; `localKey(id)`, `readLocal(storage, id)`, `type Resume`, `resumeLocal(server, local)`; `conflictKey(id)`, `readConflict(storage, id)`;
  - `DEBOUNCE_MS = 1500`, `SAVE_TIMEOUT_MS = 10_000`, `RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000]`, `SENT_MAX_CHARS = 200_000`; `remember(sent, text): Content[]`;
  - `sameContent(a, b)`, `statusOf(e): ProtocolStatus`, `written(e): boolean`, `unsavedEntry(e): boolean`, `readDraft(registrationId, value): ServerDraft | null`;
  - `type SaveBody`, `type Answer = { status: number; body: unknown } | null`, `type Send = (body: SaveBody) => Promise<Answer>`, `postSave(body): Promise<Answer>`;
  - `class ProtocolAutosave(drafts: readonly ServerDraft[], send?: Send)` with `subscribe`, `snapshot`, `ids()`, `get(id)`, `unsaved()`, `start(storage)`, `stop()`, `edit(id, content)`, `editNote(id, index, value)`, `editGeneral(id, value)`, `save(id): Promise<boolean>` (true: the screen's text is confirmed), `saveAll(): Promise<boolean>`, `markSent(id, version, sentAt)`, `setSending(id, on)`, `dismissConflict(id)`.
- Produces, from `src/components/admin/ProtocolScreen.tsx`: `type ScreenStudentView`, `type ScreenView = { single: boolean; students: ScreenStudentView[] }`, `statusLine(s, t)`, `ProtocolScreen({ view })` (`[data-protocol-screen]`, the chips `[data-student=<id>][data-status]`, the editor `[data-editor=<id>]`, the boxes `[data-note=<i>]` and `[data-general]`, `[data-save-status]`, `[data-note-long]`, `[data-conflict]`, `[data-not-kept]`, `[data-locked]`).
- Produces, from `src/db/queries/protocols.ts`: `type TodaySession = { id: number; startsAt: Date; city: string; venue: string; title: I18n; students: number }`; `todaySessions(db: Db, now: Date): Promise<TodaySession[]>`.
- Produces: the page `/admin/protokollid?sessioon=<id>` | `?registreering=<id>`; `adminEt.protocols`, `adminEt.overview.today`.

- [ ] **Step 1: Write the failing autosave tests** `tests/unit/protocol-autosave.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  conflictKey, DEBOUNCE_MS, localKey, ProtocolAutosave, readLocal, remember, resumeLocal, SENT_MAX_CHARS, statusOf, type Answer, type Content, type SaveBody,
  type ServerDraft,
} from "@/components/admin/protocol-autosave";
import { PROTOCOL_LIMITS } from "@/domain/protocols";

// The protocol screen's autosave (spec §4): when a box saves, what a save sends, the browser's copy until the server confirms it, the
// retries, the version check's refusal, and the lost answer that is ours. The server is answered by hand: every save waits for the test.

const TITLES = ["Ettevalmistus", "Värvimine"];
const draft = (over: Partial<ServerDraft> = {}): ServerDraft => ({
  registrationId: 7,
  version: 0,
  titles: TITLES,
  content: { notes: ["", ""], generalNote: "" },
  sentVersion: null,
  sentAt: null,
  savedAt: null,
  ...over,
});
const ok = (version: number, savedAt = "2026-10-12T08:00:00.000Z"): Answer => ({ status: 200, body: { ok: true, version, savedAt } });
const refused = (version: number, notes: string[], generalNote = ""): Answer => ({
  status: 409,
  body: { ok: false, error: "conflict", protocol: { version, stages: TITLES.map((title, i) => ({ title, note: notes[i] })), generalNote, sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" } },
});

/** A server answered by hand: each save waits until the test calls `answer`. */
function server() {
  const calls: { body: SaveBody; answer: (a: Answer) => void }[] = [];
  const send = (body: SaveBody) => new Promise<Answer>((resolve) => calls.push({ body, answer: resolve }));
  return { calls, send };
}

let engine: ProtocolAutosave | null = null;
const start = (drafts: ServerDraft[], send: (b: SaveBody) => Promise<Answer>) => {
  engine = new ProtocolAutosave(drafts, send);
  engine.start(localStorage);
  return engine;
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  engine?.stop();
  engine = null;
  vi.useRealTimers();
});

describe("when a box saves, and what a save sends", () => {
  test("1.5 s after typing stops: one save with the version and the headings; saved, and the browser's copy is gone", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "K");
    await tick(1000);
    e.editNote(7, 0, "Ku");
    await tick(DEBOUNCE_MS - 1);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status).toEqual({ kind: "pending" });
    expect(readLocal(localStorage, 7)?.content.notes).toEqual(["Ku", ""]); // kept until the server confirms it
    await tick(1);
    expect(s.calls.map((c) => c.body)).toEqual([{ registrationId: 7, version: 0, titles: TITLES, notes: ["Ku", ""], generalNote: "" }]);
    expect(e.get(7)!.status).toEqual({ kind: "saving" });
    s.calls[0].answer(ok(1));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 1, status: { kind: "saved", at: Date.parse("2026-10-12T08:00:00.000Z") }, confirmed: { notes: ["Ku", ""], generalNote: "" } });
    expect(localStorage.getItem(localKey(7))).toBeNull();
    expect(e.unsaved()).toBe(false);
  });

  test("on blur and on switching student (save) it goes at once, without the 1.5 s", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editGeneral(7, "Üldiselt hästi");
    void e.save(7);
    await tick();
    expect(s.calls.map((c) => c.body.generalNote)).toEqual(["Üldiselt hästi"]);
  });

  test("one save of a protocol at a time: what is typed during it goes next, with the version the first one got", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(1);
    s.calls[0].answer(ok(1));
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[0, "A"], [1, "AB"]]);
    s.calls[1].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, status: { kind: "saved" } });
  });

  test("typing back to the saved text needs no save: saved, the copy dropped, nothing sent", async () => {
    const s = server();
    const e = start([draft({ version: 3, content: { notes: ["Hea", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "Hea!");
    e.editNote(7, 0, "Hea");
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status.kind).toBe("saved");
    expect(localStorage.getItem(localKey(7))).toBeNull();
  });

  test("saveAll is true only when every protocol is confirmed", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "A");
    e.editNote(8, 0, "B");
    const all = e.saveAll();
    await tick();
    s.calls[0].answer(ok(1));
    s.calls[1].answer({ status: 500, body: { ok: false, error: "server" } });
    expect(await all).toBe(false);
  });
});

describe("a long day on flaky Wi-Fi (Review Focus 1)", () => {
  test("a failed save keeps the text in the browser and is tried again after 2 and 5 s; back online, at once", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null);
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "retrying" });
    expect(readLocal(localStorage, 7)).toMatchObject({ version: 0, content: { notes: ["A", ""] } });
    await tick(1999);
    expect(s.calls).toHaveLength(1);
    await tick(1);
    expect(s.calls).toHaveLength(2);
    s.calls[1].answer(null);
    await tick(4999);
    expect(s.calls).toHaveLength(2);
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls).toHaveLength(3);
    s.calls[2].answer(ok(1));
    await tick();
    expect(e.get(7)!.status.kind).toBe("saved");
  });

  test("the tab shown again tries a waiting save at once", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null);
    await tick();
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(s.calls).toHaveLength(2);
  });

  test("Review Focus 1: a save whose answer was lost, then more typing: refused with that very text stored — ours — and the newer text goes on top, no notice", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // the server stored "A" as version 1; the answer never came
    await tick();
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toMatchObject({ version: 0, notes: ["AB", ""] });
    s.calls[1].answer(refused(1, ["A", ""]));
    await tick();
    expect(s.calls[2].body).toMatchObject({ version: 1, notes: ["AB", ""] });
    s.calls[2].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, content: { notes: ["AB", ""] }, status: { kind: "saved" } });
  });

  test("Review Focus 1: a lost answer, then six more failed saves of newer text and a retry: back online it is still ours, the newest text goes on top", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // the server stored "A" as version 1; the answer never came
    await tick();
    for (let i = 1; i <= 6; i++) {
      e.editNote(7, 0, `A${i}`);
      await tick(DEBOUNCE_MS);
      s.calls[i].answer(null); // none of these reached the server
      await tick();
    }
    await tick(30_000); // a retry of the same text adds nothing to what is kept
    expect(s.calls.map((c) => c.body.notes[0])).toEqual(["A", "A1", "A2", "A3", "A4", "A5", "A6", "A6"]);
    s.calls[7].answer(null);
    await tick();
    expect(readLocal(localStorage, 7)!.sent.map((c) => c.notes[0])).toEqual(["A", "A1", "A2", "A3", "A4", "A5", "A6"]);
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls[8].body).toMatchObject({ version: 0, notes: ["A6", ""] });
    s.calls[8].answer(refused(1, ["A", ""])); // the first text, kept all along: ours
    await tick();
    expect(s.calls[9].body).toMatchObject({ version: 1, notes: ["A6", ""] });
    s.calls[9].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, content: { notes: ["A6", ""] }, status: { kind: "saved" } });
  });

  test("remember: each text once, the newest always, the oldest left out past SENT_MAX_CHARS", () => {
    const c = (note: string): Content => ({ notes: [note], generalNote: "" });
    expect(remember([c("A")], c("A"))).toEqual([c("A")]);
    expect(remember([c("A"), c("B")], c("A"))).toEqual([c("A"), c("B")]);
    const half = "x".repeat(SENT_MAX_CHARS / 2);
    expect(remember([c(`1${half}`), c(`2${half}`)], c("3")).map((x) => x.notes[0][0])).toEqual(["2", "3"]);
    expect(remember([], c("y".repeat(SENT_MAX_CHARS + 1)))).toHaveLength(1);
  });

  test("Review Focus 1: a reload after a lost answer resumes the newer text on top of the stored one", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["AB", ""], generalNote: "" }, sent: [{ notes: ["A", ""], generalNote: "" }] }));
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["A", ""], generalNote: "" } })], s.send);
    expect(e.get(7)!.content.notes).toEqual(["AB", ""]);
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ registrationId: 7, version: 1, titles: TITLES, notes: ["AB", ""], generalNote: "" }]);
    expect(e.get(7)!.conflict).toBeNull();
  });

  test("a reload resumes a copy of the same version and saves it at once; a copy the server already has is dropped", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 2, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
    localStorage.setItem(localKey(8), JSON.stringify({ version: 2, titles: TITLES, content: { notes: ["sama", ""], generalNote: "" }, sent: [] }));
    const s = server();
    start([draft({ version: 2 }), draft({ registrationId: 8, version: 2, content: { notes: ["sama", ""], generalNote: "" } })], s.send);
    await tick();
    expect(s.calls.map((c) => [c.body.registrationId, c.body.notes[0]])).toEqual([[7, "jäi alles"]]);
    expect(localStorage.getItem(localKey(8))).toBeNull();
  });
});

describe("two devices (Review Focus 2)", () => {
  test("another device saved first: its text is shown with a notice that keeps this screen's words; nothing is overwritten or sent again", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(1);
    expect(e.get(7)).toMatchObject({
      version: 2,
      content: { notes: ["telefon", ""] },
      confirmed: { notes: ["telefon", ""] },
      conflict: { titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } },
      status: { kind: "saved", at: Date.parse("2026-10-12T08:01:00.000Z") },
    });
    expect(localStorage.getItem(localKey(7))).toBeNull();
    e.dismissConflict(7);
    expect(e.get(7)!.conflict).toBeNull();
  });

  test("a reload that finds the server moved on by another device: the kept text goes into the notice", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["minu", ""], generalNote: "" }, sent: [] }));
    const e = start([draft({ version: 2, content: { notes: ["teine", ""], generalNote: "" } })], server().send);
    expect(e.get(7)).toMatchObject({ content: { notes: ["teine", ""] }, conflict: { titles: TITLES, lost: { notes: ["minu", ""] } } });
  });

  test("the notice's words outlive a reload or a discarded tab, until 'Selge'", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    e.stop(); // the page is reloaded, or the tablet discards the tab
    const stored = draft({ version: 2, content: { notes: ["telefon", ""], generalNote: "" } });
    const again = start([stored], server().send);
    expect(again.get(7)!.conflict).toEqual({ titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } });
    again.dismissConflict(7);
    expect(localStorage.getItem(conflictKey(7))).toBeNull();
    again.stop();
    expect(start([stored], server().send).get(7)!.conflict).toBeNull();
  });
});

describe("huge pasted text (Review Focus 4)", () => {
  test("a box over 10 000 characters: nothing is sent, the status says so, the whole text stays on screen and in the browser; shortened, it saves", async () => {
    const s = server();
    const e = start([draft()], s.send);
    const long = "ü".repeat(PROTOCOL_LIMITS.note + 1);
    e.editNote(7, 1, long);
    await tick(DEBOUNCE_MS * 2);
    expect(await e.save(7)).toBe(false);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status).toEqual({ kind: "tooLong", places: [1] });
    expect(e.get(7)!.content.notes[1]).toHaveLength(PROTOCOL_LIMITS.note + 1);
    expect(readLocal(localStorage, 7)?.content.notes[1]).toHaveLength(PROTOCOL_LIMITS.note + 1);
    e.editNote(7, 1, long.slice(0, PROTOCOL_LIMITS.note));
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(1);
  });

  test("pasted control characters are dropped, the words, tabs and line breaks kept", () => {
    const e = start([draft()], server().send);
    e.editNote(7, 0, "Kulmud\u000bhästi\u0000\tjah\r\nlõpp");
    expect(e.get(7)!.content.notes[0]).toBe("Kulmudhästi\tjah\r\nlõpp");
  });
});

describe("the other answers and the parts", () => {
  test("signed out: said so and tried again later; the registration gone: said so, not tried again; the text stays", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "A");
    e.editNote(8, 0, "B");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 401, body: { ok: false, error: "unauthorized" } });
    s.calls[1].answer({ status: 404, body: { ok: false, error: "notFound" } });
    await tick();
    expect([e.get(7)!.status.kind, e.get(8)!.status.kind]).toEqual(["signedOut", "gone"]);
    await tick(2000);
    expect(s.calls.map((c) => c.body.registrationId)).toEqual([7, 8, 7]);
    expect(readLocal(localStorage, 8)?.content.notes[0]).toBe("B");
  });

  test("statusOf: none before the first save, a draft, sent, changed; markSent", async () => {
    const s = server();
    const e = start([draft()], s.send);
    expect(statusOf(e.get(7)!)).toBe("none");
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(1));
    await tick();
    expect(statusOf(e.get(7)!)).toBe("draft");
    e.markSent(7, 1, "2026-10-12T15:00:00.000Z");
    expect(statusOf(e.get(7)!)).toBe("sent");
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer(ok(2));
    await tick();
    expect(statusOf(e.get(7)!)).toBe("changed");
  });

  test("a browser that cannot keep the text (storage full): the entry says so until the server has it; a full storage never stops the save", async () => {
    const full = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} } as unknown as Storage;
    const s = server();
    const e = (engine = new ProtocolAutosave([draft()], s.send));
    e.start(full);
    e.editNote(7, 0, "A");
    expect(e.get(7)).toMatchObject({ kept: false, status: { kind: "pending" } });
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(1));
    await tick();
    expect(e.get(7)).toMatchObject({ kept: true, status: { kind: "saved" } });
  });

  test("while a send is on its way the protocol takes no edits: what is sent is what is on the screen", () => {
    const e = start([draft({ version: 1, content: { notes: ["Valmis", ""], generalNote: "" } })], server().send);
    e.setSending(7, true);
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)).toMatchObject({ sending: true, content: { notes: ["Valmis", ""] } });
    e.setSending(7, false);
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)!.content.notes[0]).toBe("Valmis!");
  });

  test("readLocal reads only a copy it wrote; resumeLocal's three outcomes", () => {
    localStorage.setItem(localKey(1), "{");
    localStorage.setItem(localKey(2), JSON.stringify({ version: "1", titles: [], content: { notes: [], generalNote: "" }, sent: [] }));
    localStorage.setItem(localKey(3), JSON.stringify({ version: 1, titles: ["a"], content: { notes: [1], generalNote: "" }, sent: [] }));
    for (const id of [1, 2, 3, 4]) expect(readLocal(localStorage, id), String(id)).toBeNull();
    expect(readLocal(null, 1)).toBeNull();
    const server = { version: 2, titles: TITLES, content: { notes: ["x", ""], generalNote: "" } };
    const local = (version: number, notes: string[], sent: string[][] = [], titles = TITLES) => ({ version, titles, content: { notes, generalNote: "" }, sent: sent.map((n) => ({ notes: n, generalNote: "" })) });
    expect(resumeLocal(server, null)).toEqual({ kind: "none" });
    expect(resumeLocal(server, local(1, ["x", ""]))).toEqual({ kind: "none" });
    expect(resumeLocal(server, local(2, ["y", ""]))).toEqual({ kind: "resume", content: { notes: ["y", ""], generalNote: "" } });
    expect(resumeLocal(server, local(1, ["xy", ""], [["x", ""]]))).toEqual({ kind: "resume", content: { notes: ["xy", ""], generalNote: "" } });
    expect(resumeLocal(server, local(1, ["y", ""]))).toEqual({ kind: "lost", titles: TITLES, content: { notes: ["y", ""], generalNote: "" } });
    expect(resumeLocal(server, local(2, ["y"], [], ["Vana"]))).toEqual({ kind: "lost", titles: ["Vana"], content: { notes: ["y"], generalNote: "" } });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**: `npx vitest run tests/unit/protocol-autosave.test.ts` (the module does not exist).

- [ ] **Step 3: Write `src/components/admin/protocol-autosave.ts`:**

```ts
import { hasText, overLimit, protocolStatus, type NotePlace, type ProtocolStatus } from "@/domain/protocols";
import { toStorable } from "@/lib/storable";

// The protocol screen's autosave (phase protocols, spec §4), without React: ProtocolScreen.tsx renders what it holds and tells it what Maria
// types. Nothing typed is lost:
// - a box saves 1.5 s after typing stops, on blur and on switching student (save); one save of a protocol at a time, the next one waits;
// - until the server confirms a text, this browser keeps it (localStorage `mslab-protocol:<registration>`), and a reload or a new tab resumes
//   it (start); a browser that cannot keep it (storage full or blocked) says so (Entry.kept);
// - a save that fails is tried again after 2, 5, 10, 20, then every 30 s, and at once when the browser is back online or the tab is shown
//   again; the status says "Salvestamata — proovin uuesti";
// - a save carries the version the server confirmed last. A refusal (409) brings what is stored: when that text is one this screen sent and
//   never heard back about (the answer was lost on the way), it was ours, and the newer text is saved on top of it with no notice; otherwise
//   another device or tab saved first, its text is shown, and this screen's unsaved words go into the notice: newer text is never overwritten.
//   The texts sent without an answer are kept once each, up to SENT_MAX_CHARS; the notice's words are kept (`mslab-protocol-conflict:<id>`)
//   until "Selge", across a reload;
// - while a send is on its way (setSending) the protocol takes no edits;
// - a box over 10 000 characters is never cut: nothing is sent until it is shortened, the status and the box say so;
// - pasted control characters that Postgres cannot store are dropped (toStorable), the words kept.
// The server's side is server/protocols.ts saveProtocol behind POST /api/admin/protokoll.

/** What the screen edits of a protocol: the notes under its headings, in order, and the general notes. */
export type Content = { notes: string[]; generalNote: string };

/** A protocol's save, as its status line says it. `at`: when the server saved it last (ms), null before the first save. */
export type SaveStatus =
  | { kind: "saved"; at: number | null }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "retrying" }
  | { kind: "tooLong"; places: NotePlace[] }
  | { kind: "signedOut" }
  | { kind: "gone" };

/** A protocol as the server holds it (the page's, or a 409's). `version` 0: none yet. */
export type ServerDraft = {
  registrationId: number;
  version: number;
  titles: string[];
  content: Content;
  sentVersion: number | null;
  sentAt: string | null;
  /** When the server last saved it (ms); null before the first save. */
  savedAt: number | null;
};

/** Another device saved first: the headings this screen had, and its text that could not be saved (null: it had nothing new). */
export type Conflict = { titles: string[]; lost: Content | null };

/** One protocol on the screen: what the server confirmed (`confirmed` at `version`), what the screen shows (`content`), its save. */
export type Entry = {
  registrationId: number;
  version: number;
  titles: string[];
  confirmed: Content;
  content: Content;
  sentVersion: number | null;
  sentAt: string | null;
  savedAt: number | null;
  status: SaveStatus;
  conflict: Conflict | null;
  /** "Saada" is on its way (Task 6): the boxes are read-only and edits are not taken. */
  sending: boolean;
  /** This browser holds the screen's unsaved text; false: its storage is full or blocked, and a reload would lose the text. */
  kept: boolean;
};

/** What this browser keeps of a protocol until the server confirms it: the version it builds on, and the texts sent without an answer. */
export type LocalCopy = { version: number; titles: string[]; content: Content; sent: Content[] };

export const DEBOUNCE_MS = 1500;
/** A save that has not been answered in 10 s is given up (and kept, and tried again). */
export const SAVE_TIMEOUT_MS = 10_000;
/** The waits before trying a failed save again; the last one repeats. */
export const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;

/** The most text this browser keeps of the saves sent without an answer, in characters (one protocol at its limits holds 310 000). */
export const SENT_MAX_CHARS = 200_000;

export const localKey = (registrationId: number): string => `mslab-protocol:${registrationId}`;
/** A conflict's notice text, kept until "Selge". */
export const conflictKey = (registrationId: number): string => `mslab-protocol-conflict:${registrationId}`;

const copy = (c: Content): Content => ({ notes: [...c.notes], generalNote: c.generalNote });

export const sameContent = (a: Content, b: Content): boolean =>
  a.generalNote === b.generalNote && a.notes.length === b.notes.length && a.notes.every((n, i) => n === b.notes[i]);

const sameTitles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isContent = (v: unknown): v is Content =>
  typeof v === "object" && v !== null && isStrings((v as Content).notes) && typeof (v as Content).generalNote === "string";
const size = (c: Content): number => c.notes.reduce((n, note) => n + note.length, c.generalNote.length);

/**
 * The texts sent since the last confirmed version, with `text` added (an answer lost: any of them may be what the server holds). Each text
 * once: a retry of the same text adds nothing. At most SENT_MAX_CHARS together: the oldest go first, never the newest (after a day offline
 * that long a refusal shows the notice with the screen's words in it, instead of saving on top: nothing is lost either way).
 */
export function remember(sent: readonly Content[], text: Content): Content[] {
  const out = sent.some((c) => sameContent(c, text)) ? [...sent] : [...sent, copy(text)];
  let total = out.reduce((n, c) => n + size(c), 0);
  while (out.length > 1 && total > SENT_MAX_CHARS) total -= size(out.shift()!);
  return out;
}

/** The copy this browser kept of a protocol, or null: none, storage blocked, or anything that is not a copy this code wrote. */
export function readLocal(storage: Storage | null, registrationId: number): LocalCopy | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(localKey(registrationId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const c = value as Record<string, unknown>;
    if (typeof c.version !== "number" || !isStrings(c.titles) || !isContent(c.content) || !Array.isArray(c.sent) || !c.sent.every(isContent)) return null;
    return { version: c.version, titles: c.titles, content: c.content, sent: c.sent };
  } catch {
    return null;
  }
}

/** Writes one key; false when this browser cannot keep it (no storage, or full or blocked): the screen then says so (Entry.kept). */
function writeKey(storage: Storage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(storage: Storage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // blocked storage: nothing was kept
  }
}

/** The conflict this browser kept (its notice's words, until "Selge"), or null: none, or anything this code did not write. */
export function readConflict(storage: Storage | null, registrationId: number): Conflict | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(conflictKey(registrationId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const c = value as Record<string, unknown>;
    return isStrings(c.titles) && isContent(c.lost) ? { titles: c.titles, lost: c.lost } : null;
  } catch {
    return null;
  }
}

/** What a reload does with a kept copy: nothing (none, or the server holds it), resume it (and save it), or show it as not saved. */
export type Resume = { kind: "none" } | { kind: "resume"; content: Content } | { kind: "lost"; titles: string[]; content: Content };

/**
 * A kept copy against what the server holds now: the same text is nothing to do; other headings, or a server that moved on by another
 * device, make it "lost" (the notice shows it); the same version, or a server that moved on by a save of this browser whose answer was lost
 * (its stored text is one this browser sent), resume it.
 */
export function resumeLocal(server: { version: number; titles: string[]; content: Content }, local: LocalCopy | null): Resume {
  if (!local || sameContent(local.content, server.content)) return { kind: "none" };
  if (!sameTitles(local.titles, server.titles)) return { kind: "lost", titles: local.titles, content: local.content };
  if (local.version === server.version) return { kind: "resume", content: local.content };
  if (server.version > local.version && local.sent.some((c) => sameContent(c, server.content))) return { kind: "resume", content: local.content };
  return { kind: "lost", titles: local.titles, content: local.content };
}

/** A protocol's status mark (domain/protocols.ts protocolStatus): version 0 is none yet. */
export const statusOf = (e: Pick<Entry, "version" | "sentAt" | "sentVersion">): ProtocolStatus => protocolStatus(e.version === 0 ? null : e);

/** Is anything written on the screen? */
export const written = (e: Pick<Entry, "content">): boolean =>
  hasText({ stages: e.content.notes.map((note) => ({ title: "", note })), generalNote: e.content.generalNote });

/** Does the screen show text the server has not confirmed? */
export const unsavedEntry = (e: Pick<Entry, "content" | "confirmed">): boolean => !sameContent(e.content, e.confirmed);

/** A 409's protocol (server/protocols.ts draftJson) as a ServerDraft; null for anything else. */
export function readDraft(registrationId: number, value: unknown): ServerDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.version !== "number" || !Array.isArray(p.stages) || typeof p.generalNote !== "string") return null;
  const stages = p.stages as unknown[];
  if (!stages.every((s) => typeof s === "object" && s !== null && typeof (s as { title?: unknown }).title === "string" && typeof (s as { note?: unknown }).note === "string")) return null;
  const typed = stages as { title: string; note: string }[];
  return {
    registrationId,
    version: p.version,
    titles: typed.map((s) => s.title),
    content: { notes: typed.map((s) => s.note), generalNote: p.generalNote },
    sentVersion: typeof p.sentVersion === "number" ? p.sentVersion : null,
    sentAt: typeof p.sentAt === "string" ? p.sentAt : null,
    savedAt: typeof p.updatedAt === "string" ? Date.parse(p.updatedAt) : null,
  };
}

/** What a save sends (server/protocols.ts SaveInput). */
export type SaveBody = { registrationId: number; version: number; titles: string[]; notes: string[]; generalNote: string };
/** The server's answer to a save; null when none came (no connection, the 10 s ran out). */
export type Answer = { status: number; body: unknown } | null;
export type Send = (body: SaveBody) => Promise<Answer>;

/** POST /api/admin/protokoll with the admin's cookie, given up after 10 s. Never throws. */
export async function postSave(body: SaveBody): Promise<Answer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/admin/protokoll", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The autosave of one screen's protocols (see the top of the file). */
export class ProtocolAutosave {
  private readonly entries = new Map<number, Entry>();
  private readonly order: number[];
  private readonly send: Send;
  private readonly debounce = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retry = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<number, number>();
  private readonly chains = new Map<number, Promise<boolean>>();
  /** Texts sent without an answer since the last confirmed one: any of them may be stored (a lost answer). */
  private readonly unanswered = new Map<number, Content[]>();
  /** The text of the save on its way. */
  private readonly flying = new Map<number, Content>();
  private readonly listeners = new Set<() => void>();
  private storage: Storage | null = null;
  private running = false;
  private resumed = false;
  private revision = 0;

  constructor(drafts: readonly ServerDraft[], send: Send = postSave) {
    this.send = send;
    this.order = drafts.map((d) => d.registrationId);
    for (const d of drafts)
      this.entries.set(d.registrationId, {
        registrationId: d.registrationId,
        version: d.version,
        titles: [...d.titles],
        confirmed: copy(d.content),
        content: copy(d.content),
        sentVersion: d.sentVersion,
        sentAt: d.sentAt,
        savedAt: d.savedAt,
        status: { kind: "saved", at: d.savedAt },
        conflict: null,
        sending: false,
        kept: true,
      });
  }

  /** For useSyncExternalStore: told after every change. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** For useSyncExternalStore: a number that moves with every change. */
  readonly snapshot = (): number => this.revision;

  ids(): number[] {
    return [...this.order];
  }

  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }

  /** Does the screen show any text the server has not confirmed? */
  unsaved(): boolean {
    return [...this.entries.values()].some(unsavedEntry);
  }

  /**
   * Starts saving, after the page has loaded (its server render shows the server's text): the copies this browser kept are resumed once, and
   * the online and visibility events are heard. React may stop and start it again (strict mode): a second start resumes nothing twice.
   */
  start(storage: Storage | null): void {
    this.storage = storage;
    this.running = true;
    window.addEventListener("online", this.onBack);
    document.addEventListener("visibilitychange", this.onVisible);
    if (!this.resumed) {
      this.resumed = true;
      for (const e of this.entries.values()) this.resume(e);
    } else {
      for (const e of this.entries.values()) if (unsavedEntry(e)) this.schedule(e.registrationId, 0);
    }
    this.changed();
  }

  /** Stops: no timer runs on, an answer still on its way is not applied (the text stays in this browser). */
  stop(): void {
    this.running = false;
    window.removeEventListener("online", this.onBack);
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const timer of [...this.debounce.values(), ...this.retry.values()]) clearTimeout(timer);
    this.debounce.clear();
    this.retry.clear();
  }

  editNote(id: number, index: number, value: string): void {
    const e = this.entries.get(id);
    if (e) this.edit(id, { notes: e.content.notes.map((n, i) => (i === index ? value : n)), generalNote: e.content.generalNote });
  }

  editGeneral(id: number, value: string): void {
    const e = this.entries.get(id);
    if (e) this.edit(id, { notes: e.content.notes, generalNote: value });
  }

  /** What the screen shows now: kept in this browser at once, saved 1.5 s after the last change (never while a box is over its limit). */
  edit(id: number, content: Content): void {
    const e = this.entries.get(id);
    if (!e || e.sending) return;
    e.content = { notes: content.notes.map(toStorable), generalNote: toStorable(content.generalNote) };
    if (sameContent(e.content, e.confirmed)) {
      this.clearTimer(this.debounce, id);
      this.settle(e);
      return;
    }
    this.keep(e);
    const places = overLimit(e.content.notes, e.content.generalNote);
    if (places.length > 0) {
      this.clearTimer(this.debounce, id);
      this.set(e, { kind: "tooLong", places });
      return;
    }
    this.set(e, { kind: "pending" });
    this.schedule(id, DEBOUNCE_MS);
  }

  /** Saves now (blur, switching student, before a send), after the save on its way; true when the screen's text is confirmed. */
  save(id: number): Promise<boolean> {
    this.clearTimer(this.debounce, id);
    const before = this.chains.get(id) ?? Promise.resolve(true);
    const next = before.then(
      () => this.sendIfNeeded(id),
      () => this.sendIfNeeded(id),
    );
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  /** Saves every protocol now; true when every one is confirmed. */
  async saveAll(): Promise<boolean> {
    const results = await Promise.all(this.order.map((id) => this.save(id)));
    return results.every(Boolean);
  }

  /** "Saada" went through: `version` is the one the student sees now. */
  markSent(id: number, version: number, sentAt: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sentVersion = version;
    e.sentAt = sentAt;
    this.changed();
  }

  /** "Saada" is on its way (on) or answered (off): meanwhile the protocol takes no edits, so the version sent is the one on the screen. */
  setSending(id: number, on: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sending = on;
    this.changed();
  }

  /** "Selge": the notice goes, and with it the words this browser kept for it. */
  dismissConflict(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.conflict = null;
    removeKey(this.storage, conflictKey(id));
    this.changed();
  }

  private readonly onBack = (): void => {
    for (const e of this.entries.values())
      if (e.status.kind === "retrying" || e.status.kind === "signedOut") {
        this.attempts.delete(e.registrationId);
        void this.save(e.registrationId);
      }
  };

  private readonly onVisible = (): void => {
    if (document.visibilityState === "visible") this.onBack();
  };

  private resume(e: Entry): void {
    // a notice not closed yet ("Selge") comes back with its words
    e.conflict = readConflict(this.storage, e.registrationId);
    const plan = resumeLocal({ version: e.version, titles: e.titles, content: e.confirmed }, readLocal(this.storage, e.registrationId));
    if (plan.kind === "none") {
      removeKey(this.storage, localKey(e.registrationId));
      return;
    }
    if (plan.kind === "lost") {
      this.showConflict(e, { titles: plan.titles, lost: plan.content });
      removeKey(this.storage, localKey(e.registrationId));
      return;
    }
    const local = readLocal(this.storage, e.registrationId);
    if (local && local.sent.length > 0) this.unanswered.set(e.registrationId, local.sent);
    e.content = copy(plan.content);
    const places = overLimit(e.content.notes, e.content.generalNote);
    e.status = places.length > 0 ? { kind: "tooLong", places } : { kind: "pending" };
    if (places.length === 0) this.schedule(e.registrationId, 0);
  }

  private async sendIfNeeded(id: number): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || !this.running || e.status.kind === "gone") return false;
    if (sameContent(e.content, e.confirmed)) {
      this.settle(e);
      return true;
    }
    const places = overLimit(e.content.notes, e.content.generalNote);
    if (places.length > 0) {
      this.set(e, { kind: "tooLong", places });
      return false;
    }
    this.clearTimer(this.retry, id);
    const payload = copy(e.content);
    const version = e.version;
    this.flying.set(id, payload);
    this.keep(e);
    this.set(e, { kind: "saving" });
    const answer = await this.send({ registrationId: id, version, titles: [...e.titles], notes: payload.notes, generalNote: payload.generalNote });
    this.flying.delete(id);
    if (!this.running) return false;
    const body = (answer?.body ?? null) as Record<string, unknown> | null;
    if (answer && answer.status === 200 && body?.ok === true && typeof body.version === "number") {
      this.unanswered.delete(id);
      this.attempts.delete(id);
      e.version = body.version;
      e.confirmed = payload;
      e.savedAt = typeof body.savedAt === "string" ? Date.parse(body.savedAt) : Date.now();
      if (sameContent(e.content, payload)) {
        this.settle(e);
        return true;
      }
      return this.sendIfNeeded(id); // typed on while it was saving: the rest goes at once
    }
    if (answer && answer.status === 409 && body?.error === "conflict") {
      const stored = readDraft(id, body.protocol);
      if (stored) return this.conflict(e, stored, version);
    }
    if (answer && (answer.status === 401 || answer.status === 403)) return this.failed(e, { kind: "signedOut" });
    if (answer && answer.status === 404) {
      this.set(e, { kind: "gone" });
      return false;
    }
    // no answer, or a server error: the text may be stored all the same (the next refusal tells); kept here, and tried again
    if (!answer || answer.status >= 500) this.unanswered.set(id, remember(this.unanswered.get(id) ?? [], payload));
    return this.failed(e, { kind: "retrying" });
  }

  private conflict(e: Entry, stored: ServerDraft, sentFrom: number): Promise<boolean> | false {
    const mine = this.unanswered.get(e.registrationId) ?? [];
    this.unanswered.delete(e.registrationId);
    this.attempts.delete(e.registrationId);
    if (stored.version > sentFrom && sameTitles(stored.titles, e.titles) && mine.some((c) => sameContent(c, stored.content))) {
      // our own earlier save, whose answer was lost: it is stored as that version, and the screen's newer text goes on from there
      e.version = stored.version;
      e.confirmed = copy(stored.content);
      e.sentVersion = stored.sentVersion;
      e.sentAt = stored.sentAt;
      e.savedAt = stored.savedAt;
      return this.sendIfNeeded(e.registrationId);
    }
    // another device or tab saved first: its text is shown, and this screen's goes into the notice (newer text is never overwritten)
    this.showConflict(e, { titles: e.titles, lost: sameContent(e.content, stored.content) ? null : copy(e.content) });
    e.version = stored.version;
    e.titles = [...stored.titles];
    e.confirmed = copy(stored.content);
    e.content = copy(stored.content);
    e.sentVersion = stored.sentVersion;
    e.sentAt = stored.sentAt;
    e.savedAt = stored.savedAt;
    this.settle(e);
    return false;
  }

  /** The notice, and its words kept in this browser until "Selge" (a reload, or a discarded tab, shows them again). */
  private showConflict(e: Entry, conflict: Conflict): void {
    e.conflict = conflict;
    if (conflict.lost) writeKey(this.storage, conflictKey(e.registrationId), conflict);
  }

  private failed(e: Entry, status: SaveStatus): false {
    this.set(e, status);
    const n = this.attempts.get(e.registrationId) ?? 0;
    this.attempts.set(e.registrationId, n + 1);
    this.clearTimer(this.retry, e.registrationId);
    this.retry.set(
      e.registrationId,
      setTimeout(() => {
        this.retry.delete(e.registrationId);
        void this.save(e.registrationId);
      }, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]),
    );
    return false;
  }

  /** Confirmed: "Salvestatud HH:MM", and this browser's copy is no longer needed. */
  private settle(e: Entry): void {
    removeKey(this.storage, localKey(e.registrationId));
    e.kept = true; // nothing is left to keep
    this.set(e, { kind: "saved", at: e.savedAt });
  }

  /**
   * Keeps the screen's text in this browser, with the texts that may be stored already (sent without an answer, or on their way); `kept` says
   * whether that worked. The caller sets the status next, which tells the screen.
   */
  private keep(e: Entry): void {
    const flying = this.flying.get(e.registrationId);
    const unanswered = this.unanswered.get(e.registrationId) ?? [];
    const sent = flying ? remember(unanswered, flying) : unanswered;
    const copyOf: LocalCopy = { version: e.version, titles: e.titles, content: e.content, sent };
    e.kept = writeKey(this.storage, localKey(e.registrationId), copyOf);
  }

  private schedule(id: number, ms: number): void {
    this.clearTimer(this.debounce, id);
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        void this.save(id);
      }, ms),
    );
  }

  private clearTimer(timers: Map<number, ReturnType<typeof setTimeout>>, id: number): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  private set(e: Entry, status: SaveStatus): void {
    e.status = status;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/unit/protocol-autosave.test.ts` — expect PASS.

- [ ] **Step 5: Today's sessions — the failing test** `tests/db/protocols-today.test.ts`:

```ts
import { expect, test } from "vitest";
import { todaySessions } from "@/db/queries/protocols";
import { courses, courseSessions } from "@/db/schema";
import { protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The overview's "Täna" (spec §4): the contact courses' sessions of today's Tallinn date, scheduled ones, with how many students are listed.

test("today in Tallinn: from midnight to midnight there, the called-off ones left out; each with its listed students", async () => {
  const db = await makeTestDb();
  const { course, session: morning } = await protocolCourse(db); // 12.10 10:00 in Tallinn
  const at = async (startsAt: string, status: "scheduled" | "cancelled" = "scheduled") =>
    (await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date(startsAt), city: "Tartu", status }).returning())[0];
  const late = await at("2026-10-12T20:30:00Z"); // 23:30 on 12.10
  await at("2026-10-11T20:30:00Z"); // 23:30 on 11.10
  await at("2026-10-12T21:30:00Z"); // 00:30 on 13.10
  await at("2026-10-12T09:00:00Z", "cancelled");
  await student(db, course, morning, "Mari");
  await student(db, course, morning, "Anu", { status: "awaiting_prepayment" });
  await student(db, course, morning, "Tiina", { status: "cancelled" });
  const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" } }).returning();
  await db.insert(courseSessions).values({ courseId: ecourse.id, startsAt: new Date("2026-10-12T08:00:00Z"), city: "Pärnu" });

  const today = await todaySessions(db, new Date("2026-10-12T09:00:00Z"));
  expect(today.map((s) => [s.id, s.students])).toEqual([[morning.id, 2], [late.id, 0]]);
  expect(today[0]).toMatchObject({ city: "Pärnu", venue: "MS LAB stuudio", title: { et: "Kulmude lamineerimine" }, startsAt: morning.startsAt });
  // just after midnight in Tallinn (21:10 UTC) it is the 13th there: only the 00:30 session
  expect((await todaySessions(db, new Date("2026-10-12T21:10:00Z"))).map((s) => s.startsAt.toISOString())).toEqual(["2026-10-12T21:30:00.000Z"]);
});
```

  Run `npx vitest run tests/db/protocols-today.test.ts` — FAIL (`todaySessions` does not exist).

- [ ] **Step 6: The query** — in `src/db/queries/protocols.ts`:
  1. The `drizzle-orm` import becomes `import { and, asc, eq, gte, lt, sql } from "drizzle-orm";` and add `import { tallinnFormParts } from "@/domain/calendar";`.
  2. Append:

```ts
// ---------- the overview's "Täna" (Task 5) ----------

/** One of today's sessions: its course, when and where, and how many students are listed on its screen (not cancelled). */
export type TodaySession = { id: number; startsAt: Date; city: string; venue: string; title: I18n; students: number };

/**
 * Today's sessions in Tallinn (spec §4: the overview's "Täna" card), scheduled ones of contact courses, earliest first. A window of two days
 * either side is read and each session's Tallinn date compared with today's: the same on the two days the clocks change.
 */
export async function todaySessions(db: Db, now: Date): Promise<TodaySession[]> {
  const DAY = 86_400_000;
  const rows = await db
    .select({
      id: courseSessions.id,
      startsAt: courseSessions.startsAt,
      city: courseSessions.city,
      venue: courseSessions.venue,
      title: courses.title,
      students: sql<number>`(select count(*) from registrations r where r.course_session_id = ${courseSessions.id} and r.status <> 'cancelled')`.mapWith(Number),
    })
    .from(courseSessions)
    .innerJoin(courses, eq(courseSessions.courseId, courses.id))
    .where(
      and(
        eq(courseSessions.status, "scheduled"),
        eq(courses.type, "contact"),
        gte(courseSessions.startsAt, new Date(now.getTime() - 2 * DAY)),
        lt(courseSessions.startsAt, new Date(now.getTime() + 2 * DAY)),
      ),
    )
    .orderBy(asc(courseSessions.startsAt), asc(courseSessions.id));
  const today = tallinnFormParts(now).date;
  return rows.filter((r) => tallinnFormParts(r.startsAt).date === today);
}
```

  Run `npx vitest run tests/db/protocols-today.test.ts` — PASS.

- [ ] **Step 7: The admin's words** (`src/i18n/dict/admin.ts`).
  1. After the `payments` section, add:

```ts
  // The course day's protocols (phase protocols, spec §4): /admin/protokollid?sessioon=<id> | ?registreering=<id> (ProtocolScreen.tsx and its
  // autosave). The status marks are spec §3's. {time} is "HH:MM" in Tallinn, {n} a count, {max} the box's limit, {date} a day and a time.
  protocols: {
    eyebrow: "Koolituspäev",
    title: "Protokollid",
    // the entry points: the Kalender session drawer and the overview's "Täna" (open), the Registreerimised drawer (openOne)
    open: "Protokollid",
    openOne: "Ava protokoll",
    notFound: "Seda toimumist või registreeringut ei leitud, või pole see kontaktkoolitus.",
    toCalendar: "Kalendrisse",
    toRegistration: "Registreeringu juurde",
    individual: "Individuaalkoolitus",
    sessionCancelled: "Toimumine on tühistatud",
    hidden: "Tühistatud registreeringuid peidetud: {n}",
    empty: "Sellel toimumisel pole õpilasi.",
    cancelledOne: "Registreering on tühistatud: protokolli ei näidata ega saadeta.",
    students: "Õpilased",
    awaiting: "ootab ettemaksu",
    mark: { draft: "Mustand", sent: "Saadetud", changed: "Muudetud" },
    // on a student's chip while her text is not confirmed by the server (it is in this browser all the same)
    unsavedMark: "Salvestamata",
    practice: "Praktiline osa",
    general: "Üldised märkused",
    noStages: "Koolitusel pole protokolli punkte. Lisa need koolituse juures („Protokolli punktid“); seni on siin ainult üldised märkused.",
    saved: "Salvestatud {time}",
    pending: "Salvestamata muudatused",
    saving: "Salvestan…",
    retrying: "Salvestamata — proovin uuesti",
    tooLongStatus: "Salvestamata — üks tekst on liiga pikk",
    signedOut: "Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles.",
    gone: "Seda registreeringut enam ei ole. Tekst on selles seadmes alles.",
    // the browser could not keep the unsaved text (its storage full or blocked): shown on that protocol until the server has the text
    notKept: "Seda teksti ei saa selles seadmes hoida (brauseri mälu on täis või suletud). Ära sulge lehte enne, kui see on salvestatud.",
    tooLong: "Liiga pikk: {n} / {max} märki. Lühenda, siis salvestan.",
    conflict: "Seda protokolli muudeti vahepeal teises seadmes või aknas. Näed nüüd salvestatud teksti; selle ekraani salvestamata tekst on allpool.",
    conflictLost: "Selle ekraani salvestamata tekst",
    dismiss: "Selge",
    locked: "Saadetud {date}. Õpilane näeb seda versiooni.",
  },
```

  2. In `overview`, after the `upcoming` block, add:

```ts
    // today's sessions in Tallinn, each with "Protokollid" (phase protocols, spec §4); the card is hidden on a day with none
    today: {
      title: "Täna",
      students: "Õpilasi: {n}",
    },
```

- [ ] **Step 8: The growing box** — create `src/components/admin/GrowingText.tsx`:

```tsx
"use client";

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/**
 * A text box that grows with its text (spec §4: "a growing note box"), so a long note is read and edited without a scrollbar of its own; it
 * fits again when the window turns (a tablet rotated). Every other attribute goes to the textarea.
 */
export function GrowingText({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);
  return <textarea ref={ref} rows={3} value={value} {...props} />;
}
```

- [ ] **Step 9: Write the failing screen tests** `tests/unit/protocol-screen-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey } from "@/components/admin/protocol-autosave";
import { ProtocolScreen, type ScreenStudentView, type ScreenView } from "@/components/admin/ProtocolScreen";

// The course day's screen (spec §4): the students with their marks, the selected one's boxes under her headings, the autosave's status,
// switching without waiting, the too-long box, a sent protocol read-only, the conflict's notice, and a text kept in the browser coming back.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TITLES = ["Ettevalmistus", "Värvimine"];
const student = (registrationId: number, name: string, over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId,
  name,
  awaiting: false,
  version: 0,
  titles: TITLES,
  notes: ["", ""],
  generalNote: "",
  sentVersion: null,
  sentAt: null,
  savedAt: null,
  ...over,
});
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const saved = () => json(200, { ok: true, version: 1, savedAt: "2026-10-12T08:00:00.000Z" });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const render = async (view: ScreenView) => act(async () => root.render(createElement(ProtocolScreen, { view })));
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { registrationId: number; version: number; notes: string[] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => saved());
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("the students with their marks; the first is open; a note saves 1.5 s after typing stops and says when", async () => {
  await render({ single: false, students: [student(1, "Anu Aas", { awaiting: true }), student(2, "Mari", { version: 2, notes: ["x", ""] })] });
  expect($$("[data-student]").map((b) => [b.getAttribute("data-student"), b.getAttribute("aria-pressed"), b.getAttribute("data-status")])).toEqual([["1", "true", "none"], ["2", "false", "draft"]]);
  expect($("[data-student='1']")!.textContent).toContain("ootab ettemaksu");
  expect($("[data-student='2'] [data-mark]")!.textContent).toBe("Mustand");
  expect($$("[data-editor='1'] label").map((l) => l.textContent)).toEqual(["Ettevalmistus", "Värvimine", "Üldised märkused"]);
  await type("[data-note='0']", "Kulmud ühtlased");
  await wait(1499);
  expect(fetchMock).not.toHaveBeenCalled();
  await wait(1);
  expect(bodies()).toEqual([{ registrationId: 1, version: 0, titles: TITLES, notes: ["Kulmud ühtlased", ""], generalNote: "" }]);
  await wait(0);
  expect($("[data-save-status]")!.textContent).toBe("Salvestatud 11:00");
});

test("switching student is one tap: the one left saves at once, the next is shown without waiting for it", async () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // a save that hangs
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await type("[data-note='0']", "Anu märkus");
  await click("[data-student='2']");
  expect(bodies().map((b) => b.registrationId)).toEqual([1]);
  expect($("[data-editor='2']")).not.toBeNull();
  expect($("[data-student='1'] [data-unsaved]")!.textContent).toBe("Salvestamata");
  await click("[data-student='1']");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Anu märkus");
});

test("Review Focus 4: a paste over 10 000 characters is kept whole, the box says by how much, nothing is sent", async () => {
  await render({ single: true, students: [student(1, "Anu")] });
  await type("[data-note='1']", "ü".repeat(10_001));
  await wait(3000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect($("[data-note-long]")!.textContent).toBe("Liiga pikk: 10001 / 10000 märki. Lühenda, siis salvestan.");
  expect($("[data-note='1']")!.getAttribute("aria-invalid")).toBe("true");
  expect($("[data-save-status]")!.textContent).toBe("Salvestamata — üks tekst on liiga pikk");
  expect(($("[data-note='1']") as HTMLTextAreaElement).value).toHaveLength(10_001);
});

test("a sent protocol is shown read-only, with when it was sent; one student has no list", async () => {
  await render({ single: true, students: [student(3, "Kati", { version: 2, sentVersion: 2, sentAt: "2026-10-12T15:00:00.000Z", notes: ["Valmis", ""] })] });
  expect($("[data-students]")).toBeNull();
  expect($$("textarea").every((t) => (t as HTMLTextAreaElement).readOnly)).toBe(true);
  expect($("[data-locked]")!.textContent).toBe("Saadetud 12.10.2026 18:00. Õpilane näeb seda versiooni.");
});

test("another device saved first: the stored text is shown and this screen's words are in the notice; 'Selge' closes it", async () => {
  fetchMock.mockImplementation(async () =>
    json(409, { ok: false, error: "conflict", protocol: { version: 3, stages: TITLES.map((title, i) => ({ title, note: i === 0 ? "teine seade" : "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" } }),
  );
  await render({ single: true, students: [student(1, "Anu", { version: 2, notes: ["vana", ""] })] });
  await type("[data-note='0']", "minu tekst");
  await wait(1500);
  await wait(0);
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("teine seade");
  expect($("[data-conflict]")!.textContent).toContain("minu tekst");
  await click("[data-conflict-dismiss]");
  expect($("[data-conflict]")).toBeNull();
});

test("a browser that cannot keep the text (storage full): 'Salvestamata' and a short notice until the server has it", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // the save hangs
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await type("[data-note='0']", "Anu märkus");
  expect($("[data-not-kept]")!.textContent).toBe("Seda teksti ei saa selles seadmes hoida (brauseri mälu on täis või suletud). Ära sulge lehte enne, kui see on salvestatud.");
  expect($("[data-student='1'] [data-unsaved]")!.textContent).toBe("Salvestamata");
  setItem.mockRestore();
});

test("a text kept in this browser comes back after a reload and is saved at once", async () => {
  localStorage.setItem(localKey(1), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
  await render({ single: true, students: [student(1, "Anu")] });
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("jäi alles");
  await wait(0);
  expect(bodies().map((b) => b.notes[0])).toEqual(["jäi alles"]);
});
```

  Run `npx vitest run tests/unit/protocol-screen-dom.test.ts` — FAIL (`ProtocolScreen` does not exist).

- [ ] **Step 10: The screen's styles** — create `src/components/admin/ProtocolScreen.module.css`:

```css
/* The course day's protocols (phase protocols, spec §4): the students in a column on the left on a wide screen and a row of chips across the
   top on a narrow one (a container query: the 834 and 1194 px tablets get the column, a phone the chips), the selected student's protocol
   with boxes that grow with their text, and the save status. Tokens only; every target 44 px. */

.head {
  display: grid;
  justify-items: start;
  gap: 6px;
}

.screen {
  container-type: inline-size;
}

.layout {
  display: grid;
  align-items: start;
  gap: 20px;
}

.students {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@container (min-width: 720px) {
  .withList {
    grid-template-columns: 230px minmax(0, 1fr);
  }

  .withList .students {
    position: sticky;
    top: 16px;
    flex-direction: column;
    flex-wrap: nowrap;
  }
}

.student {
  display: grid;
  justify-items: start;
  gap: 4px;
  min-width: 0;
  min-height: 44px;
  padding: 10px 14px;
  border: 1px solid var(--heather);
  border-radius: 14px;
  background: var(--paper);
  color: var(--ink);
  font: 600 14px/1.3 var(--font-body);
  text-align: left;
  cursor: pointer;
}

.student:hover {
  border-color: var(--ink);
}

.student[aria-pressed="true"] {
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.student:focus-visible {
  outline: 2px solid var(--rose);
  outline-offset: 2px;
}

.studentName {
  overflow-wrap: anywhere;
}

.marks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.awaiting {
  color: var(--muted-2);
  font: 500 12px/1.3 var(--font-body);
}

.unsaved {
  color: var(--bad);
  font: 600 12px/1.3 var(--font-body);
}

.editor {
  display: grid;
  gap: 22px;
  min-width: 0;
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: var(--paper);
}

.editorHead {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 16px;
}

.editorHead p {
  margin: 0;
}

.part {
  display: grid;
  gap: 16px;
}

/* the box grows with its text (GrowingText): no scrollbar or handle of its own */
.note {
  min-height: 96px;
  overflow: hidden;
  resize: none;
}

/* "Üldised märkused": a heading of its own, as the practice part's */
.part .generalLabel {
  font: 500 18px/1.3 var(--font-display);
}

.conflict {
  display: grid;
  justify-items: start;
  gap: 10px;
}

.conflict p {
  margin: 0;
}

.lost {
  display: grid;
  gap: 8px;
}

.lost summary {
  padding: 12px 0;
  font-weight: 600;
  cursor: pointer;
}

.lostPart {
  display: grid;
  gap: 2px;
}

.lostText {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .editor {
    padding: 20px 16px;
  }
}
```

- [ ] **Step 11: The screen** — create `src/components/admin/ProtocolScreen.tsx`:

```tsx
"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { PROTOCOL_LIMITS, type ProtocolStatus } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { GrowingText } from "./GrowingText";
import { ProtocolAutosave, statusOf, unsavedEntry, type Conflict, type Entry, type SaveStatus, type ServerDraft } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

/** One student as the page hands her over: her protocol's draft, every date as text. */
export type ScreenStudentView = {
  registrationId: number;
  name: string;
  /** Her registration waits for its prepayment: "ootab ettemaksu". */
  awaiting: boolean;
  version: number;
  titles: string[];
  notes: string[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: string | null;
  savedAt: string | null;
};

/** The screen's students. `single`: one registration's screen (an individual course): its "Saada" is the primary button (Task 6). */
export type ScreenView = { single: boolean; students: ScreenStudentView[] };

type T = typeof adminEt.protocols;

const TONE: Record<Exclude<ProtocolStatus, "none">, string> = { draft: ui.warn, sent: ui.ok, changed: ui.bad };

const serverDraft = (s: ScreenStudentView): ServerDraft => ({
  registrationId: s.registrationId,
  version: s.version,
  titles: s.titles,
  content: { notes: s.notes, generalNote: s.generalNote },
  sentVersion: s.sentVersion,
  sentAt: s.sentAt,
  savedAt: s.savedAt === null ? null : Date.parse(s.savedAt),
});

/** The save's status line: "Salvestatud HH:MM" (Tallinn), the waiting states, and the failing ones (in the error colour). */
export function statusLine(s: SaveStatus, t: T): { text: string; failing: boolean } {
  switch (s.kind) {
    case "saved":
      return { text: s.at === null ? "" : fill(t.saved, { time: formatTime(new Date(s.at), "et") }), failing: false };
    case "pending":
      return { text: t.pending, failing: false };
    case "saving":
      return { text: t.saving, failing: false };
    case "retrying":
      return { text: t.retrying, failing: true };
    case "tooLong":
      return { text: t.tooLongStatus, failing: true };
    case "signedOut":
      return { text: t.signedOut, failing: true };
    case "gone":
      return { text: t.gone, failing: true };
  }
}

/**
 * The course day's protocols (spec §4): the students — a column on the left on a wide screen, a row of chips across the top on a narrow one
 * (a container query: the 834 and 1194 px tablets get the column, a phone the chips) — each with her status mark (Mustand, Saadetud,
 * Muudetud; none before the first save), "ootab ettemaksu" while her prepayment is not in, and "Salvestamata" while her text is not
 * confirmed; and the selected student's protocol: the practice part (each heading with a box that grows with its text), then "Üldised
 * märkused". Switching student is one tap: the one left saves in the background at once, never waited for. The autosave is
 * protocol-autosave.ts; a sent protocol shows read-only. Leaving the page while a text is not confirmed asks first (it is in this browser
 * all the same). One student (an individual course, or a session with one): no list.
 */
export function ProtocolScreen({ view }: { view: ScreenView }) {
  const t = adminEt.protocols;
  const [engine] = useState(() => new ProtocolAutosave(view.students.map(serverDraft)));
  useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const [selected, setSelected] = useState(view.students[0]?.registrationId ?? 0);

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null; // blocked storage: the autosave still works; only a reload could not resume a text not saved yet
    }
    engine.start(storage);
    const warn = (e: BeforeUnloadEvent) => {
      if (engine.unsaved()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      engine.stop();
    };
  }, [engine]);

  const choose = (id: number) => {
    if (id === selected) return;
    void engine.save(selected); // in the background: switching never waits for it
    setSelected(id);
  };
  const entry = engine.get(selected);
  const student = view.students.find((s) => s.registrationId === selected);
  const list = view.students.length > 1;

  return (
    <div className={styles.screen} data-protocol-screen="">
      <div className={list ? `${styles.layout} ${styles.withList}` : styles.layout}>
        {list && (
          <nav className={styles.students} aria-label={t.students} data-students="">
            {view.students.map((s) => {
              const e = engine.get(s.registrationId)!;
              const status = statusOf(e);
              return (
                <button
                  key={s.registrationId}
                  type="button"
                  className={styles.student}
                  aria-pressed={s.registrationId === selected}
                  onClick={() => choose(s.registrationId)}
                  data-student={s.registrationId}
                  data-status={status}
                >
                  <span className={styles.studentName}>{s.name}</span>
                  <span className={styles.marks}>
                    {status !== "none" && (
                      <span className={`${ui.tag} ${TONE[status]}`} data-mark="">
                        {t.mark[status]}
                      </span>
                    )}
                    {s.awaiting && <span className={styles.awaiting}>{t.awaiting}</span>}
                    {unsavedEntry(e) && (
                      <span className={styles.unsaved} data-unsaved="">
                        {t.unsavedMark}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        {entry && student && <StudentEditor key={entry.registrationId} engine={engine} entry={entry} name={student.name} />}
      </div>
    </div>
  );
}

/** One student's protocol: her name and the save's status, a conflict's notice, the practice part's boxes, the general notes. */
function StudentEditor({ engine, entry, name }: { engine: ProtocolAutosave; entry: Entry; name: string }) {
  const t = adminEt.protocols;
  const uid = useId();
  const id = entry.registrationId;
  const locked = statusOf(entry) === "sent";
  // read-only while it is sent, and while a send is on its way (its text must stay the one sent)
  const frozen = locked || entry.sending;
  const line = statusLine(entry.status, t);
  const sentAt = entry.sentAt ? new Date(entry.sentAt) : null;

  return (
    <section className={styles.editor} aria-labelledby={`${uid}-name`} data-editor={id}>
      <div className={styles.editorHead}>
        <h2 id={`${uid}-name`} className={ui.h2}>
          {name}
        </h2>
        <p role="status" className={line.failing ? ui.error : ui.hint} data-save-status={entry.status.kind}>
          {line.text}
        </p>
      </div>
      {entry.conflict && <ConflictNotice conflict={entry.conflict} onDismiss={() => engine.dismissConflict(id)} />}
      {!entry.kept && unsavedEntry(entry) && (
        <p className={ui.error} role="alert" data-not-kept="">
          {t.notKept}
        </p>
      )}
      {locked && sentAt && (
        <p className={ui.notice} data-locked="">
          {fill(t.locked, { date: `${formatDate(sentAt, "et")} ${formatTime(sentAt, "et")}` })}
        </p>
      )}
      <div className={styles.part}>
        <h3 className={ui.h3}>{t.practice}</h3>
        {entry.titles.length === 0 && <p className={ui.hint}>{t.noStages}</p>}
        {entry.titles.map((title, i) => (
          <NoteBox
            key={i}
            id={`${uid}-note-${i}`}
            label={title}
            value={entry.content.notes[i] ?? ""}
            readOnly={frozen}
            note={i}
            onChange={(v) => engine.editNote(id, i, v)}
            onBlur={() => void engine.save(id)}
          />
        ))}
      </div>
      <div className={styles.part}>
        <NoteBox id={`${uid}-general`} label={t.general} heading value={entry.content.generalNote} readOnly={frozen} onChange={(v) => engine.editGeneral(id, v)} onBlur={() => void engine.save(id)} />
      </div>
    </section>
  );
}

/**
 * One box with its label (a stage's heading, or "Üldised märkused" as a heading of its own). Over 10 000 characters the box keeps every
 * character and says how many it has, and nothing is sent until it is shorter (the autosave's rule).
 */
function NoteBox({
  id,
  label,
  value,
  readOnly,
  onChange,
  onBlur,
  note,
  heading = false,
}: {
  id: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
  onBlur(): void;
  /** The stage's index (data-note); none: the general notes (data-general). */
  note?: number;
  heading?: boolean;
}) {
  const t = adminEt.protocols;
  const over = value.length > PROTOCOL_LIMITS.note;
  return (
    <div className={ui.field}>
      <label htmlFor={id} className={heading ? styles.generalLabel : undefined}>
        {label}
      </label>
      <GrowingText
        id={id}
        className={`${ui.textarea} ${styles.note}`}
        value={value}
        readOnly={readOnly}
        aria-invalid={over || undefined}
        aria-describedby={over ? `${id}-long` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        data-note={note}
        data-general={note === undefined ? "" : undefined}
      />
      {over && (
        <p id={`${id}-long`} className={ui.error} data-note-long="">
          {fill(t.tooLong, { n: value.length, max: PROTOCOL_LIMITS.note })}
        </p>
      )}
    </div>
  );
}

/** Another device saved first (spec §4): the short notice, and this screen's text that could not be saved, to copy what is still wanted. */
function ConflictNotice({ conflict, onDismiss }: { conflict: Conflict; onDismiss(): void }) {
  const t = adminEt.protocols;
  const lost = conflict.lost;
  return (
    <div className={`${ui.notice} ${styles.conflict}`} role="alert" data-conflict="">
      <p>{t.conflict}</p>
      {lost && (
        <details open className={styles.lost}>
          <summary>{t.conflictLost}</summary>
          {conflict.titles.map((title, i) =>
            (lost.notes[i] ?? "").trim() ? (
              <div key={i} className={styles.lostPart}>
                <strong>{title}</strong>
                <p className={styles.lostText}>{lost.notes[i]}</p>
              </div>
            ) : null,
          )}
          {lost.generalNote.trim() && (
            <div className={styles.lostPart}>
              <strong>{t.general}</strong>
              <p className={styles.lostText}>{lost.generalNote}</p>
            </div>
          )}
        </details>
      )}
      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={onDismiss} data-conflict-dismiss="">
        {t.dismiss}
      </button>
    </div>
  );
}
```

- [ ] **Step 12: The page** — create `src/app/admin/(panel)/protokollid/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ProtocolScreen, type ScreenView } from "@/components/admin/ProtocolScreen";
import styles from "@/components/admin/ProtocolScreen.module.css";
import { adminTitle, type Section } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { protocolScreen, type ScreenData } from "@/db/queries/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime, formatWeekday } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.protocols.title) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** The screen's data for the browser: every date as text. */
function viewOf(screen: ScreenData): ScreenView {
  return {
    single: screen.kind === "registration",
    students: screen.students.map((s) => ({
      registrationId: s.registrationId,
      name: s.name,
      awaiting: s.status === "awaiting_prepayment",
      version: s.protocol.version,
      titles: s.protocol.stages.map((x) => x.title),
      notes: s.protocol.stages.map((x) => x.note),
      generalNote: s.protocol.generalNote,
      sentVersion: s.protocol.sentVersion,
      sentAt: s.protocol.sentAt?.toISOString() ?? null,
      savedAt: s.protocol.updatedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Protokollid (phase protocols, spec §4): the course day's screen. ?sessioon=<id>: every listed registration of one session (from Kalender
 * and the overview's "Täna"); ?registreering=<id>: one registration (from Registreerimised: an individual course, or one group student). The
 * header names the course, the day and the place, with the way back; the screen is ProtocolScreen (its autosave runs in the browser). Behind
 * requireAdmin like every admin page; nothing is written by opening it (a protocol is created by its first save).
 */
export default async function ProtocolsPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const sp = await searchParams;
  const sessionId = parseRowId(one(sp.sessioon) ?? "");
  const registrationId = sessionId === null ? parseRowId(one(sp.registreering) ?? "") : null;
  const t = adminEt.protocols;
  const db = getDb();
  const screen = sessionId !== null ? await protocolScreen(db, { sessionId }) : registrationId !== null ? await protocolScreen(db, { registrationId }) : null;
  const active: Section = registrationId !== null ? "registrations" : "calendar";

  if (!screen) {
    return (
      <Shell email={email} active={active}>
        <div className={ui.page}>
          <div className={ui.heading}>
            <div>
              <p className={ui.eyebrow}>{t.eyebrow}</p>
              <h1 className={ui.h1}>{t.title}</h1>
            </div>
          </div>
          <section className={ui.card}>
            <p className={ui.empty}>{t.notFound}</p>
            <Link className={ui.link} href="/admin/kalender">
              {t.toCalendar}
            </Link>
          </section>
        </div>
      </Shell>
    );
  }

  const s = screen.session;
  const back = screen.kind === "session" && s ? { href: `/admin/kalender?id=${s.id}`, label: t.toCalendar } : { href: `/admin/registreerimised?id=${registrationId}`, label: t.toRegistration };
  const when = s ? `${formatWeekday(s.startsAt, "et")}, ${formatDate(s.startsAt, "et")} · ${formatTime(s.startsAt, "et")}` : t.individual;
  const place = s ? [s.city, s.venue].filter(Boolean).join(", ") : "";

  return (
    <Shell email={email} active={active}>
      <div className={ui.page}>
        <div className={ui.heading}>
          <div className={styles.head}>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1} data-protocol-course="">
              {pick(screen.course.title, "et")}
            </h1>
            <p className={ui.lead} data-protocol-when="">
              {place ? `${when} · ${place}` : when}
            </p>
            {s?.cancelled && <span className={`${ui.tag} ${ui.bad}`}>{t.sessionCancelled}</span>}
          </div>
          <Link className={ui.link} href={back.href}>
            {back.label}
          </Link>
        </div>
        {screen.hidden > 0 && (
          <p className={`${ui.muted} ${ui.small}`} data-hidden-cancelled="">
            {fill(t.hidden, { n: screen.hidden })}
          </p>
        )}
        {screen.students.length === 0 ? (
          <section className={ui.card}>
            <p className={ui.empty}>{screen.kind === "registration" ? t.cancelledOne : t.empty}</p>
          </section>
        ) : (
          <ProtocolScreen view={viewOf(screen)} />
        )}
      </div>
    </Shell>
  );
}
```

- [ ] **Step 13: The entry points.**
  1. **Kalender** (`src/app/admin/(panel)/kalender/page.tsx`). In the edit drawer, after `<h2 className={ui.h2}>{name}</h2>`, add:

```tsx
              {/* the session's protocols (phase protocols, spec §4): one tap to the course day's screen */}
              <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?sessioon=${open.id}`} data-session-protocols="">
                {adminEt.protocols.open}
              </Link>
```

  2. **Registreerimised** (`src/app/admin/(panel)/registreerimised/page.tsx`). In `RegistrationDetail`, after `<p className={ui.muted}>{pick(r.course.title, "et")}</p>`, add:

```tsx
        {/* the protocol of a contact course's registration (phase protocols, spec §4): one tap to its screen */}
        {r.course.type === "contact" && r.status !== "cancelled" && (
          <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?registreering=${r.id}`} data-registration-protocol="">
            {adminEt.protocols.openOne}
          </Link>
        )}
```

  3. **The overview** (`src/app/admin/(panel)/page.tsx`).
     - Add `import { todaySessions } from "@/db/queries/protocols";`; the format import becomes `import { fill, formatDate, formatLongDate, formatTime } from "@/i18n/format";`.
     - `const [counts, sessions] = await Promise.all([getAdminCounts(), listUpcomingSessions(getDb(), startOfDayTallinn(now))]);` becomes:

```tsx
  const db = getDb();
  const [counts, sessions, today] = await Promise.all([getAdminCounts(), listUpcomingSessions(db, startOfDayTallinn(now)), todaySessions(db, now)]);
```

     - Before `<div className={ui.columns}>`, add:

```tsx
        {/* "Täna" (phase protocols, spec §4): today's sessions, each with one tap to its protocols; hidden on a day with none */}
        {today.length > 0 && (
          <section className={`${ui.card} ${styles.today}`} aria-labelledby="today-title" data-today="">
            <h2 id="today-title" className={ui.h2}>
              {t.today.title}
            </h2>
            <ul className={ui.rows}>
              {today.map((s) => (
                <li key={s.id} className={styles.todayRow} data-today-session={s.id}>
                  <span className={styles.todayWhat}>
                    <strong>{pick(s.title, "et")}</strong>
                    <span className={ui.muted}>
                      {formatTime(s.startsAt, "et")} · {[s.city, s.venue].filter(Boolean).join(", ")} · {fill(t.today.students, { n: s.students })}
                    </span>
                  </span>
                  <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/admin/protokollid?sessioon=${s.id}`}>
                    {adminEt.protocols.open}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
```

     - In `overview.module.css`, append:

```css
/* "Täna" (phase protocols): today's sessions, each with its "Protokollid" */
.today {
  margin-bottom: 25px;
}

.todayRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  min-height: 44px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}

.todayRow:last-child {
  border-bottom: 0;
}

.todayWhat {
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
```

  4. **The lists.**
     - `tests/unit/admin-guards.test.ts`: in the first test's page list, add `"protokollid"` after `"maksed"`.
     - `tests/e2e/admin-load.spec.ts`: in `ADMIN_PAGES`, add `"/admin/protokollid",` after `"/admin/praktika",` (without a query it is the "not found" card in the shell: still a signed-in admin page).
     - `tests/unit/colour-tokens.test.ts`: after `"src/app/admin/(panel)/maksed/payments.module.css",` add `// the course day's protocols (phase protocols)`, `"src/components/admin/ProtocolScreen.module.css",` and `"src/app/admin/(panel)/overview.module.css",` (both use the tokens only).
     - `tests/unit/old-safari.test.ts`: `BROWSER_FILES` gains `// Task 5`, `"src/components/admin/protocol-autosave.ts"`, `"src/components/admin/ProtocolScreen.tsx"`, `"src/components/admin/GrowingText.tsx"`.

- [ ] **Step 14: Run** `npx vitest run tests/unit/protocol-autosave.test.ts tests/unit/protocol-screen-dom.test.ts tests/db/protocols-today.test.ts tests/unit/admin-guards.test.ts tests/unit/colour-tokens.test.ts tests/unit/old-safari.test.ts tests/unit/admin.test.ts` — expect PASS.

- [ ] **Step 15: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`; `npx playwright test admin-inbox admin-clients` (the drawers with their new button); `E2E_PROD_BUILD=1 npx playwright test admin-load`.

- [ ] **Step 16: Commit.**

```bash
git add "app/src/app/admin/(panel)" app/src/components/admin/protocol-autosave.ts app/src/components/admin/GrowingText.tsx app/src/components/admin/ProtocolScreen.tsx app/src/components/admin/ProtocolScreen.module.css app/src/db/queries/protocols.ts app/src/i18n/dict/admin.ts app/tests
git commit -m "feat(admin): the course day's protocol screen — the students, growing boxes, autosave that keeps every word, Täna and the entry points

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The sends on the screen — "Saada", "Muuda", "Saada uuesti", "Lukusta ja saada kõik"

Spec section 4 (sending, after sending), §9 (an empty protocol), D4. Every send saves first: a send carries the version the server confirmed for exactly what is on the screen, so the student gets what Maria sees; when the save cannot get through, nothing is sent and the screen says so.

**"Muuda" writes nothing.** It only unlocks the screen (spec §3); the first saved edit raises the version and the mark becomes "Muudetud", which offers "Saada uuesti". Spec §8 lists a "reopen" for `server/protocols.ts`: there is none, by §3.

**The confirmation names three groups**: who will get a protocol, who is skipped because hers is empty (spec §4), and who has hers already with nothing new ("Juba saadetud") — the third so that no student on the screen is left unexplained.

**One student's failure never stops the others** (spec §8). "Saada" there saves each listed protocol on its own; those whose save the server confirmed are sent, each in its own transaction, and a protocol that could not be saved is left out and named. The summary groups the names by why they were not sent, in the words of a single "Saada" (`sendMessage`: cancelled, stale, empty, not found, failed, or not saved).

**A send never comes back "stale" from Maria's own typing.** While a send is on its way its protocol is read-only (`engine.setSending`, Task 5): the version saved first is the version sent.

**Files:**
- Create: `app/src/components/admin/ProtocolSend.tsx`
- Modify: `app/src/components/admin/ProtocolScreen.tsx` (the imports, `ProtocolScreen`, `StudentEditor`), `app/src/components/admin/ProtocolScreen.module.css`
- Modify: `app/src/i18n/dict/admin.ts` (`protocols`)
- Modify: `app/tests/unit/protocol-screen-dom.test.ts` (the actions mocked), `app/tests/unit/old-safari.test.ts`
- Test: `app/tests/unit/protocol-send-dom.test.ts` (new)

**Interfaces:**
- Consumes: `sendProtocolAction`, `sendProtocolsAction`, `SendOutcome`, `BulkResult` (Task 3); `ProtocolAutosave` (with `setSending`), `statusOf`, `written`, `unsavedEntry`, `localKey` (Task 5); `newToSend` (Task 1).
- Produces, from `src/components/admin/ProtocolSend.tsx`: `sendMessage(result: SendOutcome, t): string | null`; `planSendAll(engine): { will: number[]; skipped: number[]; already: number[] }`; `StudentSend({ engine, id, primary, unlocked, onUnlock })` (`[data-send-bar]`: `[data-send="first"|"again"]`, `[data-edit]`, `[data-editing]`, `[data-send-error]`); `SendAll({ engine, names, onSent })` (`[data-send-all-open]`, `[data-send-confirm]` with `[data-confirm-will]`, `[data-confirm-skipped]`, `[data-confirm-already]`, `[data-confirm-send]`; `[data-send-summary]` with `[data-summary-sent]` and one `[data-summary-failed]` per reason).

- [ ] **Step 1: Write the failing tests** `tests/unit/protocol-send-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey } from "@/components/admin/protocol-autosave";
import { ProtocolScreen, type ScreenStudentView, type ScreenView } from "@/components/admin/ProtocolScreen";
import type { SendOutcome } from "@/server/protocols";

// The sends on the course day's screen (spec §4, §8, D4): "Saada" saves first and sends the version the server confirmed, the boxes read-only
// meanwhile; a sent protocol is read-only with "Muuda"; the first edit after it makes it "Muudetud" with "Saada uuesti"; "Lukusta ja saada
// kõik" asks once, naming who gets one and who is skipped, then sends; one student's failure never stops the others; every refusal says why.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));
vi.mock("@/server/actions/admin-protocols", () => actions);

const TITLES = ["Ettevalmistus", "Värvimine"];
const SENT_AT = "2026-10-12T15:00:00.000Z";
const student = (registrationId: number, name: string, over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId,
  name,
  awaiting: false,
  version: 1,
  titles: TITLES,
  notes: ["Valmis", ""],
  generalNote: "",
  sentVersion: null,
  sentAt: null,
  savedAt: "2026-10-12T08:00:00.000Z",
  ...over,
});
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
// a new key for each list of students: a new screen (and engine), as a new page load gives one
const render = async (view: ScreenView) =>
  act(async () => root.render(createElement(ProtocolScreen, { view, key: view.students.map((s) => s.registrationId).join("-") })));
const click = async (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  actions.sendProtocolAction.mockReset();
  actions.sendProtocolsAction.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("'Saada' sends the confirmed version; sent, it is read-only with 'Muuda'; an edit after it makes it 'Muudetud' and 'Saada uuesti' sends again", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 1, sentAt: SENT_AT });
  await render({ single: true, students: [student(1, "Kati")] });
  expect($("[data-send='first']")!.textContent).toBe("Saada");
  expect($("[data-send='first']")!.className).not.toContain("smallBtn"); // one student's screen: its primary button
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 1 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  expect($("[data-locked]")!.textContent).toBe("Saadetud 12.10.2026 18:00. Õpilane näeb seda versiooni.");
  await click("[data-edit]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-editing]")).not.toBeNull();
  await type("[data-note='0']", "Valmis. Lisaks värv.");
  await wait(1500);
  await wait(0);
  expect($("[data-send='again']")!.textContent).toBe("Saada uuesti");
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: true, version: 2, sentAt: "2026-10-12T15:06:00.000Z" });
  await click("[data-send='again']");
  expect(actions.sendProtocolAction).toHaveBeenLastCalledWith({ registrationId: 1, version: 2 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
});

test("an empty protocol is refused at once, nothing sent; Review Focus 3: each refusal says why", async () => {
  await render({ single: true, students: [student(1, "Kati", { version: 0, notes: ["", ""], savedAt: null })] });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Protokoll on tühi. Kirjuta midagi enne saatmist.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  await render({ single: true, students: [student(2, "Mari")] });
  for (const [answer, line] of [
    [{ kind: "cancelled" }, "Registreering on tühistatud: protokolli ei saadeta."],
    [{ kind: "stale", version: 4 }, "Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle."],
    [{ kind: "failed" }, "Saatmine ei õnnestunud. Proovi uuesti."],
  ] as const) {
    actions.sendProtocolAction.mockResolvedValueOnce(answer);
    await click("[data-send='first']");
    expect($("[data-send-error]")!.textContent).toBe(line);
  }
  actions.sendProtocolAction.mockRejectedValueOnce(new Error("offline"));
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
});

test("while 'Saada' is on its way the boxes are read-only: Maria's typing cannot make the send stale", async () => {
  let answer!: (r: SendOutcome) => void;
  actions.sendProtocolAction.mockImplementation(() => new Promise<SendOutcome>((resolve) => (answer = resolve)));
  await render({ single: true, students: [student(1, "Kati")] });
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 1 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await type("[data-note='0']", "Valmis, ja veel üks lause."); // (a box that is read-only takes nothing)
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Valmis");
  await act(async () => answer({ kind: "failed" }));
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
});

test("a text that cannot be saved is not sent: the screen says so", async () => {
  fetchMock.mockImplementation(async () => {
    throw new TypeError("Failed to fetch");
  });
  await render({ single: true, students: [student(1, "Kati")] });
  await type("[data-note='0']", "Valmis!");
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
});

test("'Lukusta ja saada kõik': one confirmation names who gets one, who is skipped as empty and who has it already; one more tap sends; a failure is named", async () => {
  const view: ScreenView = {
    single: false,
    students: [student(1, "Anu"), student(2, "Berit", { version: 0, notes: ["", ""], savedAt: null }), student(3, "Carmen", { sentVersion: 1, sentAt: SENT_AT })],
  };
  await render(view);
  expect($("[data-send-all-open]")!.textContent).toBe("Lukusta ja saada kõik");
  expect($("[data-send='first']")!.className).toContain("smallBtn"); // a student's own "Saada" is secondary here
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  expect($("[data-confirm-skipped]")!.textContent).toBe("Jäävad vahele, sest protokoll on tühi: Berit");
  expect($("[data-confirm-already]")!.textContent).toBe("Juba saadetud, uut pole: Carmen");
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled();
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 1, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu.");
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-send-confirm]")).toBeNull();

  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve")] });
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 5, result: { kind: "failed" } },
  ]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($("[data-summary-failed]")!.textContent).toBe("Ei saadetud: Eve. Saatmine ei õnnestunud. Proovi uuesti.");
});

test("'Lukusta ja saada kõik' when one student's text cannot be saved: the others are sent, she is named with why; one line per reason", async () => {
  // Eve's newer text waits in this browser (typed offline before a reload), and her save does not get through
  localStorage.setItem(localKey(5), JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["Valmis", "lisa"], generalNote: "" }, sent: [] }));
  fetchMock.mockImplementation(async (_url, init) => {
    if ((JSON.parse(String(init?.body)) as { registrationId: number }).registrationId === 5) throw new TypeError("Failed to fetch");
    return json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" });
  });
  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve"), student(6, "Fia")] });
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 6, result: { kind: "cancelled" } },
  ]);
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Dora, Eve, Fia");
  await click("[data-confirm-send]");
  await wait(0);
  await wait(0);
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([
    { registrationId: 4, version: 1 },
    { registrationId: 6, version: 1 },
  ]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([
    "Ei saadetud: Eve. Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.",
    "Ei saadetud: Fia. Registreering on tühistatud: protokolli ei saadeta.",
  ]);
  expect($("[data-student='4']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-student='5']")!.getAttribute("data-status")).toBe("draft");
});

test("with nothing new to send the confirmation says so and offers no 'Saada'", async () => {
  await render({ single: false, students: [student(1, "Anu", { sentVersion: 1, sentAt: SENT_AT }), student(2, "Berit", { version: 0, notes: ["", ""], savedAt: null })] });
  await click("[data-send-all-open]");
  expect($("[data-send-confirm]")!.textContent).toContain("Pole midagi uut saata.");
  expect($("[data-confirm-send]")).toBeNull();
});
```

  Run `npx vitest run tests/unit/protocol-send-dom.test.ts` — FAIL (no send buttons).

- [ ] **Step 2: The words** — in `src/i18n/dict/admin.ts`, in `protocols`, after `locked: …,` add:

```ts
    send: "Saada",
    sending: "Saadan…",
    edit: "Muuda",
    resend: "Saada uuesti",
    sendAll: "Lukusta ja saada kõik",
    // a sent protocol opened with "Muuda": the first saved edit makes it "Muudetud", which offers "Saada uuesti"
    editing: "Muuda teksti — salvestan ise. Siis saad selle uuesti saata.",
    // the confirmation of "Lukusta ja saada kõik" (spec §4): who gets a protocol, who is skipped because hers is empty, who has hers already
    confirm: {
      title: "Lukustan ja saadan protokollid",
      will: "Saavad protokolli: {names}",
      skipped: "Jäävad vahele, sest protokoll on tühi: {names}",
      already: "Juba saadetud, uut pole: {names}",
      nothing: "Pole midagi uut saata.",
      yes: "Saada",
      no: "Tagasi",
    },
    // the summary after "Saada": who got one, and per reason (sendErrors' words) who did not
    result: { sent: "Saadetud: {names}.", notSent: "Ei saadetud: {names}. {reason}" },
    sendErrors: {
      empty: "Protokoll on tühi. Kirjuta midagi enne saatmist.",
      unsaved: "Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.",
      stale: "Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle.",
      cancelled: "Registreering on tühistatud: protokolli ei saadeta.",
      notFound: "Seda registreeringut ei leitud.",
      failed: "Saatmine ei õnnestunud. Proovi uuesti.",
    },
```

- [ ] **Step 3: The send parts** — create `src/components/admin/ProtocolSend.tsx`:

```tsx
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { newToSend } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { sendProtocolAction, sendProtocolsAction } from "@/server/actions/admin-protocols";
import type { BulkResult, SendOutcome } from "@/server/protocols";
import { statusOf, unsavedEntry, written, type ProtocolAutosave } from "./protocol-autosave";
import ui from "./ui.module.css";
import styles from "./ProtocolScreen.module.css";

type T = typeof adminEt.protocols;

/** The line a send leaves under its button: null when it went through (sent now, or already). */
export function sendMessage(result: SendOutcome, t: T): string | null {
  switch (result.kind) {
    case "sent":
    case "already":
      return null;
    case "empty":
      return t.sendErrors.empty;
    case "stale":
      return t.sendErrors.stale;
    case "cancelled":
      return t.sendErrors.cancelled;
    case "notFound":
      return t.sendErrors.notFound;
    case "failed":
      return t.sendErrors.failed;
  }
}

/**
 * What "Lukusta ja saada kõik" would do now (spec §4): `will` — the protocols with something new (a draft with text, one changed after it was
 * sent, or a sent one whose new text is still on its way); `skipped` — those without text; `already` — the sent ones with nothing new.
 */
export function planSendAll(engine: ProtocolAutosave): { will: number[]; skipped: number[]; already: number[] } {
  const out = { will: [] as number[], skipped: [] as number[], already: [] as number[] };
  for (const id of engine.ids()) {
    const e = engine.get(id)!;
    const status = statusOf(e);
    const effective = status === "sent" && unsavedEntry(e) ? "changed" : status;
    if (effective === "sent") out.already.push(id);
    else if (newToSend(effective, written(e))) out.will.push(id);
    else out.skipped.push(id);
  }
  return out;
}

/**
 * One student's sends, under her protocol (spec §4, D4): "Saada" (a draft) and "Saada uuesti" (changed after it was sent) — each saves first and
 * sends the version the server confirmed, and an empty protocol is refused at once; "Muuda" on a sent protocol, which only unlocks the screen
 * (the first saved edit raises the version). `primary`: the screen of one registration, where "Saada" is the one primary button.
 */
export function StudentSend({ engine, id, primary, unlocked, onUnlock }: { engine: ProtocolAutosave; id: number; primary: boolean; unlocked: boolean; onUnlock(on: boolean): void }) {
  const t = adminEt.protocols;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const e = engine.get(id);
  if (!e) return null;
  const status = statusOf(e);
  const button = primary ? ui.btn : `${ui.btn} ${ui.secondary} ${ui.smallBtn}`;

  async function send() {
    if (busy) return;
    setMessage(null);
    if (!written(engine.get(id)!)) {
      setMessage(t.sendErrors.empty);
      return;
    }
    setBusy(true);
    // read-only until the answer: the version saved now is the version sent, whatever Maria types meanwhile
    engine.setSending(id, true);
    try {
      if (!(await engine.save(id))) {
        setMessage(t.sendErrors.unsaved);
        return;
      }
      const result = await sendProtocolAction({ registrationId: id, version: engine.get(id)!.version }).catch((): SendOutcome => ({ kind: "failed" }));
      if (result.kind === "sent" || result.kind === "already") {
        engine.markSent(id, result.version, result.sentAt);
        onUnlock(false);
      }
      setMessage(sendMessage(result, t));
    } finally {
      engine.setSending(id, false);
      setBusy(false);
    }
  }

  return (
    <div className={styles.sendBar} data-send-bar="">
      {status === "sent" && !unlocked ? (
        <button
          type="button"
          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
          onClick={() => {
            setMessage(null);
            onUnlock(true);
          }}
          data-edit=""
        >
          {t.edit}
        </button>
      ) : status === "sent" ? (
        <p className={ui.hint} data-editing="">
          {t.editing}
        </p>
      ) : (
        <button type="button" className={button} aria-disabled={busy || undefined} onClick={() => void send()} data-send={status === "changed" ? "again" : "first"}>
          {busy ? t.sending : status === "changed" ? t.resend : t.send}
        </button>
      )}
      {message && (
        <p role="alert" className={ui.error} data-send-error="">
          {message}
        </p>
      )}
    </div>
  );
}

/** The summary of a "Saada kõik": who got one, and per reason (in a single "Saada"'s words) who did not. */
type Summary = { sent: string[]; notSent: { reason: string; names: string[] }[] };

/**
 * "Lukusta ja saada kõik" (spec §4, §8): the session screen's primary button. The first tap opens one confirmation that names who will get a
 * protocol, who is skipped because hers is empty, and who has hers already. "Saada" there saves each of those protocols on its own (read-only
 * meanwhile), sends the ones whose save the server confirmed, each in its own transaction (sendProtocolsAction), and leaves out and names one
 * that could not be saved: one student's failure never stops the others. The summary says who got one and, per reason, who did not.
 */
export function SendAll({ engine, names, onSent }: { engine: ProtocolAutosave; names: ReadonlyMap<number, string>; onSent(id: number): void }) {
  const t = adminEt.protocols;
  const uid = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const plan = planSendAll(engine);
  const nameOf = (id: number) => names.get(id) ?? String(id);
  const list = (ids: number[]) => ids.map(nameOf).join(", ");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const will = planSendAll(engine).will;
    for (const id of will) engine.setSending(id, true);
    try {
      // each protocol saves on its own: one that cannot be saved is left out and named, the others go on (spec §8)
      const saved = await Promise.all(will.map((id) => engine.save(id)));
      const items = will.filter((_, i) => saved[i]).map((id) => ({ registrationId: id, version: engine.get(id)!.version }));
      const results: BulkResult[] =
        items.length === 0 ? [] : await sendProtocolsAction(items).catch(() => items.map((i) => ({ registrationId: i.registrationId, result: { kind: "failed" } as const })));
      const sent: string[] = [];
      const notSent = new Map<string, string[]>();
      const leftOut = (reason: string, id: number) => notSent.set(reason, [...(notSent.get(reason) ?? []), nameOf(id)]);
      for (const id of will.filter((_, i) => !saved[i])) leftOut(t.sendErrors.unsaved, id);
      for (const r of results) {
        if (r.result.kind === "sent" || r.result.kind === "already") {
          engine.markSent(r.registrationId, r.result.version, r.result.sentAt);
          onSent(r.registrationId);
          sent.push(nameOf(r.registrationId));
        } else leftOut(sendMessage(r.result, t) ?? t.sendErrors.failed, r.registrationId);
      }
      setSummary({ sent, notSent: [...notSent].map(([reason, who]) => ({ reason, names: who })) });
      setAsking(false);
    } finally {
      for (const id of will) engine.setSending(id, false);
      setBusy(false);
    }
  }

  return (
    <div className={styles.sendAll} data-send-all="">
      <button
        type="button"
        className={ui.btn}
        aria-expanded={asking}
        onClick={() => {
          setSummary(null);
          setAsking(true);
        }}
        data-send-all-open=""
      >
        {t.sendAll}
      </button>
      {asking && (
        <div className={`${ui.notice} ${styles.confirm}`} role="group" aria-labelledby={`${uid}-ask`} data-send-confirm="">
          <p id={`${uid}-ask`} ref={question} tabIndex={-1}>
            <strong>{t.confirm.title}</strong>
          </p>
          {plan.will.length > 0 ? <p data-confirm-will="">{fill(t.confirm.will, { names: list(plan.will) })}</p> : <p>{t.confirm.nothing}</p>}
          {plan.skipped.length > 0 && <p data-confirm-skipped="">{fill(t.confirm.skipped, { names: list(plan.skipped) })}</p>}
          {plan.already.length > 0 && <p data-confirm-already="">{fill(t.confirm.already, { names: list(plan.already) })}</p>}
          <div className={styles.answers}>
            {plan.will.length > 0 && (
              <button type="button" className={ui.btn} aria-disabled={busy || undefined} onClick={() => void confirm()} data-confirm-send="">
                {busy ? t.sending : t.confirm.yes}
              </button>
            )}
            <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => setAsking(false)} data-confirm-cancel="">
              {t.confirm.no}
            </button>
          </div>
        </div>
      )}
      {summary && (
        <div role="status" data-send-summary="">
          {summary.sent.length > 0 && (
            <p className={ui.success} data-summary-sent="">
              {fill(t.result.sent, { names: summary.sent.join(", ") })}
            </p>
          )}
          {summary.notSent.map((group) => (
            <p key={group.reason} className={ui.error} data-summary-failed="">
              {fill(t.result.notSent, { names: group.names.join(", "), reason: group.reason })}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Place them on the screen** (`src/components/admin/ProtocolScreen.tsx`).
  1. After `import { GrowingText } from "./GrowingText";` add `import { SendAll, StudentSend } from "./ProtocolSend";`.
  2. Replace

```tsx
  const [selected, setSelected] = useState(view.students[0]?.registrationId ?? 0);
```

     with

```tsx
  const [selected, setSelected] = useState(view.students[0]?.registrationId ?? 0);
  // "Muuda" pressed: these sent protocols are open on this screen (spec §3: only the screen unlocks; the first saved edit raises the version)
  const [unlocked, setUnlocked] = useState<ReadonlySet<number>>(() => new Set());
  const unlock = (id: number, on: boolean) =>
    setUnlocked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const names = new Map(view.students.map((s) => [s.registrationId, s.name]));
```

  3. Replace

```tsx
    <div className={styles.screen} data-protocol-screen="">
      <div className={list ? `${styles.layout} ${styles.withList}` : styles.layout}>
```

     with

```tsx
    <div className={styles.screen} data-protocol-screen="">
      {!view.single && <SendAll engine={engine} names={names} onSent={(id) => unlock(id, false)} />}
      <div className={list ? `${styles.layout} ${styles.withList}` : styles.layout}>
```

  4. Replace

```tsx
        {entry && student && <StudentEditor key={entry.registrationId} engine={engine} entry={entry} name={student.name} />}
```

     with

```tsx
        {entry && student && (
          <StudentEditor
            key={entry.registrationId}
            engine={engine}
            entry={entry}
            name={student.name}
            primary={view.single}
            unlocked={unlocked.has(entry.registrationId)}
            onUnlock={(on) => unlock(entry.registrationId, on)}
          />
        )}
```

  5. Replace

```tsx
function StudentEditor({ engine, entry, name }: { engine: ProtocolAutosave; entry: Entry; name: string }) {
  const t = adminEt.protocols;
  const uid = useId();
  const id = entry.registrationId;
  const locked = statusOf(entry) === "sent";
```

     with

```tsx
function StudentEditor({
  engine,
  entry,
  name,
  primary,
  unlocked,
  onUnlock,
}: {
  engine: ProtocolAutosave;
  entry: Entry;
  name: string;
  primary: boolean;
  unlocked: boolean;
  onUnlock(on: boolean): void;
}) {
  const t = adminEt.protocols;
  const uid = useId();
  const id = entry.registrationId;
  // a sent protocol is read-only until "Muuda"
  const locked = statusOf(entry) === "sent" && !unlocked;
```

  6. Replace the end of `StudentEditor`

```tsx
        <NoteBox id={`${uid}-general`} label={t.general} heading value={entry.content.generalNote} readOnly={frozen} onChange={(v) => engine.editGeneral(id, v)} onBlur={() => void engine.save(id)} />
      </div>
    </section>
```

     with

```tsx
        <NoteBox id={`${uid}-general`} label={t.general} heading value={entry.content.generalNote} readOnly={frozen} onChange={(v) => engine.editGeneral(id, v)} onBlur={() => void engine.save(id)} />
      </div>
      <StudentSend engine={engine} id={id} primary={primary} unlocked={unlocked} onUnlock={onUnlock} />
    </section>
```

  7. In the comment above `ProtocolScreen`, after "a sent protocol shows read-only.", add "The sends are ProtocolSend.tsx: 'Lukusta ja saada kõik' above the students (the session's primary button), each student's 'Saada' / 'Muuda' / 'Saada uuesti' under her protocol."
  8. **`tests/unit/protocol-screen-dom.test.ts`** (Task 5's) now renders a screen that imports the server actions (through ProtocolSend.tsx, whose module reads `next/headers`): after `globalThis.IS_REACT_ACT_ENVIRONMENT = true;` add, as `tests/unit/admin-unlock-dom.test.ts:18` and `tests/unit/newsletter-form-dom.test.ts:18` mock theirs,

```ts
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() })); // the screen's own tests never send
```

     and in `tests/unit/old-safari.test.ts`, `BROWSER_FILES` gains `// Task 6` and `"src/components/admin/ProtocolSend.tsx"`.
  9. Append to `ProtocolScreen.module.css`:

```css
/* the sends (ProtocolSend.tsx): "Lukusta ja saada kõik" above the screen with its confirmation; a student's buttons under her protocol */
.sendAll {
  display: grid;
  justify-items: start;
  gap: 12px;
  margin-bottom: 20px;
}

.sendAll p {
  margin: 0;
}

.confirm {
  display: grid;
  justify-items: start;
  gap: 8px;
  margin: 0;
}

.confirm p:focus {
  outline: none;
}

.answers {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sendBar {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.sendBar p {
  margin: 0;
}
```

- [ ] **Step 5: Run** `npx vitest run tests/unit/protocol-send-dom.test.ts tests/unit/protocol-screen-dom.test.ts tests/unit/protocol-autosave.test.ts tests/unit/old-safari.test.ts tests/unit/admin.test.ts` — expect PASS.

- [ ] **Step 6: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`.

- [ ] **Step 7: Commit.**

```bash
git add app/src/components/admin/ProtocolSend.tsx app/src/components/admin/ProtocolScreen.tsx app/src/components/admin/ProtocolScreen.module.css app/src/i18n/dict/admin.ts app/tests/unit/protocol-send-dom.test.ts
git commit -m "feat(admin): the protocol sends — Saada, Muuda, Saada uuesti, and Lukusta ja saada kõik with one confirmation that names everyone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The student's side — `GET /api/konto/protokoll`, "Vaata protokolli" on her card, the static `/konto/protokoll` shell

Spec section 5 (the card, the page, ownership, the gate) and §10 (DB: ownership; gate). Only the sent copy is ever served.

**The id is in the fragment, not a query.** The spec names `/konto/protokoll?id=<registrationId>`. Every account page is a static shell, and the middleware answers any query on one with a 303 that keeps only the parameters it knows (`lib/site-routing.ts accountShellTarget`), because Next.js would store the query in the cached shell; `tests/unit/account-guards.test.ts` refuses code that builds such an address. So the page is `/konto/protokoll#id=<n>` (as `/makse#…` carries its result), `id` joins the parameters the middleware moves into the fragment (a `?id=` link still lands right), and the API keeps its query (`GET /api/konto/protokoll?id=`: an API answer is never a cached page).

**Ownership is the dashboard's own rule.** The spec says "the account's client id, or its address for registrations made without one". The dashboard (`client-data.ts loadDashboard`) reads `registrations.client_id = <her id>` only: records made without an account are linked to it at her login (`client-auth.ts linkClientRecords`) or by `addClient` — and a send links the registration (Task 3). The protocol endpoint uses exactly that rule, so she sees a protocol exactly when she sees its card.

**Files:**
- Modify: `app/src/db/queries/protocols.ts` (`studentProtocol`)
- Modify: `app/src/server/account-api.ts` (`queryId`; the handler `protocol`; the router; the header comment)
- Modify: `app/src/domain/account-cards.ts` (`ContactCard.protocolSent`, `IndividualCard.protocolSent`)
- Modify: `app/src/server/client-data.ts` (`loadDashboard`)
- Modify: `app/src/components/account/AccountCourseCard.tsx`
- Create: `app/src/components/account/useHashId.ts`, `app/src/components/account/ProtocolPage.tsx`, `app/src/components/account/ProtocolPage.module.css`, `app/src/components/account/AccountPage.module.css` and `app/src/components/account/AccountNotFound.tsx` (the parts the feedback form shares, Task 8)
- Create: `app/src/app/[locale]/(site)/konto/protokoll/page.tsx`
- Modify: `app/src/components/account/texts.ts`, `app/src/i18n/dict/et.ts`, `app/src/i18n/dict/ru.ts`
- Modify: `app/src/lib/site-routing.ts` (`STATIC_PAGES`, `FRAGMENT_PARAMS`)
- Modify: `app/tests/unit/account-guards.test.ts`, `app/tests/unit/site-routing.test.ts`, `app/tests/unit/site-gate.test.ts`, `app/tests/unit/colour-tokens.test.ts`, `app/tests/e2e/cache.spec.ts`, `app/tests/e2e/gate.spec.ts`
- Test: `app/tests/db/protocols-student.test.ts`, `app/tests/unit/account-protocol-dom.test.ts` (new)

**Interfaces:**
- Consumes: `saveProtocol`, `sendProtocol` (Tasks 2, 3, in the tests); `protocols` (Task 1); `requireClient`, `clientResponse` (`account-api.ts`); `AccountLoader`, `GreetingSkeleton`, `Notice`.
- Produces, from `src/db/queries/protocols.ts`: `type StudentProtocol = { course: { slug: string; title: I18n }; session: { startsAt: string; city: string; venue: string } | null; sentAt: string; stages: ProtocolStage[]; generalNote: string }`; `studentProtocol(db: Db, clientId: number, registrationId: number): Promise<StudentProtocol | null>`.
- Produces: `GET /api/konto/protokoll?id=<n>` → 200 `{ ok: true, ...StudentProtocol }` | 404 `{ ok: false }` | 401; `ContactCard.protocolSent?: boolean`, `IndividualCard.protocolSent?: boolean` (present and true once sent); the card's `[data-card-protocol]` link to `/konto/protokoll#id=<n>`.
- Produces, from `src/components/account/useHashId.ts`: `hashId(): number | null`; `useHashId(): number | null | undefined` (undefined while not known).
- Produces: `ProtocolPage({ locale, t })` (`[data-protocol-page]`), `type ProtocolTexts`, `protocolTexts(d)`; `et.account.protocol`, `ru.account.protocol`, `account.dashboard.viewProtocol`.

- [ ] **Step 1: Write the failing API tests** `tests/db/protocols-student.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import { saveProtocol, sendProtocol } from "@/server/protocols";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The student's protocol (spec §5, §10): GET /api/konto/protokoll?id= answers her own registration's protocol as Maria last sent it — never a
// draft, never another's — and her dashboard card says it is there.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE };
const deps = (): AccountDeps => ({ db, env, now: NOW, siteUrl: SITE, later: () => {}, dev: false });

/** A session cookie of `clientId`. */
async function cookieOf(clientId: number): Promise<string> {
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return `__Host-mslab_client=${raw}`;
}
const get = async (cookie: string | null, query: string) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto/protokoll${query}`, { headers: cookie ? { cookie } : {} }), deps()))!;
const write = (registrationId: number, version: number, notes: string[], generalNote: string) =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes, generalNote }, NOW);
const send = (registrationId: number, version: number) => sendProtocol({ db, env, siteUrl: SITE, now: NOW, later: () => {} }, { registrationId, version });

/** Mari's registration with a sent protocol (the send made her account and linked the registration), and her session. */
async function sent() {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await write(mari.id, 0, ["Kulmud said ühtlased", "", "", "Värv sobis"], "Tubli töö!\nJätka harjutamist.");
  await send(mari.id, 1);
  const [account] = await db.select().from(clients).where(eq(clients.email, "marimaasikas@example.com"));
  return { course, session, mari, account, cookie: await cookieOf(account.id) };
}

test("her own sent protocol: the course, its day and place, the stages and the general notes as sent; private and never cached", async () => {
  const { session, mari, cookie } = await sent();
  const res = await get(cookie, `?id=${mari.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual({
    ok: true,
    course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
    session: { startsAt: session.startsAt.toISOString(), city: "Pärnu", venue: "MS LAB stuudio" },
    sentAt: NOW.toISOString(),
    stages: [
      { title: "Ettevalmistus", note: "Kulmud said ühtlased" },
      { title: "Kulmude analüüs", note: "" },
      { title: "Vormi määramine", note: "" },
      { title: "Värvimine", note: "Värv sobis" },
    ],
    generalNote: "Tubli töö!\nJätka harjutamist.",
  });
});

test("only the sent copy: an edit after the send is not shown until it is sent again", async () => {
  const { mari, cookie } = await sent();
  await write(mari.id, 1, ["Uus tekst", "", "", ""], "Mustand");
  const body = await (await get(cookie, `?id=${mari.id}`)).json();
  expect([body.stages[0].note, body.generalNote]).toEqual(["Kulmud said ühtlased", "Tubli töö!\nJätka harjutamist."]);
  await send(mari.id, 2);
  expect((await (await get(cookie, `?id=${mari.id}`)).json()).generalNote).toBe("Mustand");
});

test("another's protocol, a draft, a registration under another address, an id that is no id: 404, and nothing of it in the answer", async () => {
  const { course, session, mari, cookie } = await sent();
  const anu = await student(db, course, session, "Anu Aas");
  await write(anu.id, 0, ["Anu", "", "", ""], "");
  await send(anu.id, 1); // sent: Anu's account, not Mari's
  const kati = await student(db, course, session, "Kati Kask");
  await write(kati.id, 0, ["mustand", "", "", ""], ""); // a draft
  for (const query of [`?id=${anu.id}`, `?id=${kati.id}`, "?id=abc", "?id=0", "", "?id=999999"]) {
    const res = await get(cookie, query);
    expect(res.status, query).toBe(404);
    expect(await res.json(), query).toEqual({ ok: false });
  }
  // Mari signed in under another address: her registration is not linked to that account (spec §9), so not hers there
  const [other] = await db.insert(clients).values({ email: "mari.teine@example.com" }).returning();
  expect((await get(await cookieOf(other.id), `?id=${mari.id}`)).status).toBe(404);
});

test("without a session: 401", async () => {
  const { mari } = await sent();
  expect((await get(null, `?id=${mari.id}`)).status).toBe(401);
});

test("the dashboard's card says the protocol is sent, and says nothing before", async () => {
  const { course, session, mari, account } = await sent();
  const later = await student(db, course, session, "Mari Maasikas", { clientId: account.id, email: "marimaasikas@example.com" });
  await write(later.id, 0, ["x", "", "", ""], ""); // a draft only
  const cards = (await loadDashboard(db, account.id, NOW))!.cards;
  const byId = new Map(cards.flatMap((c) => (c.kind === "contact" ? [[c.registrationId, c] as const] : [])));
  expect(byId.get(mari.id)?.protocolSent).toBe(true);
  expect(byId.get(later.id)).not.toHaveProperty("protocolSent");
});
```

  Run `npx vitest run tests/db/protocols-student.test.ts` — FAIL (the endpoint answers 404 for the unknown path; `protocolSent` is not on the card).

- [ ] **Step 2: The read** — append to `src/db/queries/protocols.ts` (add `isNotNull` to the `drizzle-orm` import):

```ts
// ---------- the student's protocol (Task 7) ----------

/** What the student's page shows (spec §5): the course, its session, when it was sent, and the copy Maria sent. Dates as ISO strings (JSON). */
export type StudentProtocol = {
  course: { slug: string; title: I18n };
  session: { startsAt: string; city: string; venue: string } | null;
  sentAt: string;
  stages: ProtocolStage[];
  generalNote: string;
};

/**
 * The sent protocol of one of the client's own registrations (the dashboard's rule: registrations.client_id is hers), or null: not hers,
 * no protocol, or none sent yet. Only `sent`, the frozen copy, is read: never the draft.
 */
export async function studentProtocol(db: Db, clientId: number, registrationId: number): Promise<StudentProtocol | null> {
  const [r] = await db
    .select({ slug: courses.slug, title: courses.title, startsAt: courseSessions.startsAt, city: courseSessions.city, venue: courseSessions.venue, sent: protocols.sent, sentAt: protocols.sentAt })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .innerJoin(protocols, eq(protocols.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId), isNotNull(protocols.sentAt)))
    .limit(1);
  if (!r || !r.sent || !r.sentAt) return null;
  return {
    course: { slug: r.slug, title: r.title },
    session: r.startsAt ? { startsAt: r.startsAt.toISOString(), city: r.city ?? "", venue: r.venue ?? "" } : null,
    sentAt: r.sentAt.toISOString(),
    stages: r.sent.stages,
    generalNote: r.sent.generalNote,
  };
}
```

- [ ] **Step 3: The endpoint** (`src/server/account-api.ts`).
  1. Add `import { studentProtocol } from "@/db/queries/protocols";` after `import { readSetting } from "@/db/queries/public";`.
  2. After `lessonRef` (it ends with `return slug === null || lessonId === null ? null : { slug, lessonId };` and `};`), add:

```ts
/** The registration id of a request's `?id=` (lib/row-id.ts), or null: the protocol's and the feedback form's endpoints read it so. */
const queryId = (request: Request): number | null => parseRowId(new URL(request.url).searchParams.get("id") ?? "");
```

  3. After `payRegistration` (before the comment of `terms`), add:

```ts
/**
 * GET /protokoll?id=<registration id> (phase protocols, spec §5): the protocol Maria sent for one of the client's own registrations (the
 * dashboard's rule: linked to her account) — the course, its date and place, the stages with their notes and the general notes, as last sent,
 * never the draft. 200 `{ ok: true, course, session, sentAt, stages, generalNote }`; 404 `{ ok: false }` for any other id, and for one with
 * no sent protocol.
 */
async function protocol(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = queryId(request);
  const view = id === null ? null : await studentProtocol(deps.db, session.clientId, id);
  return view ? clientResponse(session, { ok: true, ...view }) : clientResponse(session, { ok: false }, 404);
}
```

  4. In `dataRoute`, after `case "POST /maksa": return payRegistration(request, deps);` add `case "GET /protokoll": return protocol(request, deps);`.
  5. In the file's header comment, after "POST /maksa an online payment of one of her registrations (phase 2b: the prepayment due, or the rest)," add "GET /protokoll?id= the protocol Maria sent for one of her registrations (phase protocols),".
  6. **`tests/unit/account-guards.test.ts`**: in both handler lists add `"protocol"` after `"payRegistration"`; in the router's expected cases add `"GET /protokoll protocol"` after `"POST /maksa payRegistration"`.

- [ ] **Step 4: The card's flag.**
  1. **`src/domain/account-cards.ts`.** In `ContactCard`, after `createdAt: string;`, and in `IndividualCard`, after `createdAt: string;`, add:

```ts
  /** Maria has sent this registration's protocol (phase protocols, spec §5): the card offers "Vaata protokolli". Absent until then. */
  protocolSent?: boolean;
```

  2. **`src/server/client-data.ts`.** Add `protocols` to the `@/db/schema` import. In `loadDashboard`'s registrations query, after `sessionStatus: courseSessions.status,` add `protocolSentAt: protocols.sentAt,`, and after `.leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))` add `.leftJoin(protocols, eq(protocols.registrationId, registrations.id))`. In the loop that builds the registration cards, both pushes (the individual one and the contact one) end their object with `...(r.protocolSentAt ? { protocolSent: true } : {}),` after `createdAt: iso(r.createdAt),` (a card without a sent protocol has no such key: the cards are the JSON the endpoint sends).

  Run `npx vitest run tests/db/protocols-student.test.ts tests/db/client-data.test.ts tests/db/account-api.test.ts tests/unit/account-guards.test.ts` — PASS.

- [ ] **Step 5: The texts.**
  1. **`src/i18n/dict/et.ts`**, in `account.dashboard`, after `open: "Ava koolitus",` add `// a contact course's card once Maria has sent its protocol (phase protocols)` and `viewProtocol: "Vaata protokolli",`; in `account`, after the `lesson` block (it ends with `seekLocked: …,` and `},`), add:

```ts
    // The student's protocol /konto/protokoll#id=<registration> (components/account/ProtocolPage.tsx, phase protocols): the page's frame in
    // her language; Maria's headings and notes are shown as she wrote them. {date} is the day it was sent.
    protocol: {
      title: "Koolituse protokoll",
      practice: "Praktiline osa",
      general: "Üldised märkused",
      sent: "Saadetud {date}",
      notFound: "Seda protokolli ei leitud.",
      loading: "Laadin protokolli…",
    },
```

  2. **`src/i18n/dict/ru.ts`**, in `account.dashboard`, after `open: "Открыть курс",` add `viewProtocol: "Посмотреть протокол",`; after its `lesson` block:

```ts
    protocol: {
      title: "Протокол обучения",
      practice: "Практическая часть",
      general: "Общие замечания",
      sent: "Отправлен {date}",
      notFound: "Этот протокол не найден.",
      loading: "Загружаем протокол…",
    },
```

  3. **`src/components/account/texts.ts`**, at the end:

```ts
/** The student's protocol page (phase protocols): account.protocol, the way back (Minu koolitused) and AccountLoader's. */
export type ProtocolTexts = Dict["account"]["protocol"] & { back: string; loader: LoaderTexts };

export const protocolTexts = (d: Dict): ProtocolTexts => ({ ...d.account.protocol, back: d.account.shell.courses, loader: loaderTexts(d) });
```

- [ ] **Step 6: Write the failing page and card tests** `tests/unit/account-protocol-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { ProtocolPage } from "@/components/account/ProtocolPage";
import { coursesTexts, protocolTexts } from "@/components/account/texts";
import type { ContactCard, IndividualCard } from "@/domain/account-cards";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The student's protocol (spec §5): the page reads its registration from the fragment and loads the sent copy; the frame is in her language,
// Maria's text as written; a stage without a note is not shown; a protocol that is not hers is "not found". And the card's "Vaata protokolli".

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const page = async (locale: Locale, hash: string) => {
  window.history.replaceState(null, "", `${locale === "ru" ? "/ru" : ""}/konto/protokoll${hash}`);
  await act(async () => root.render(createElement(ProtocolPage, { locale, t: protocolTexts(getDict(locale)) })));
  await settle();
};
const ANSWER = {
  ok: true,
  course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
  session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "MS LAB stuudio" },
  sentAt: "2026-10-12T15:00:00.000Z",
  stages: [
    { title: "Ettevalmistus", note: "Kulmud said ühtlased" },
    { title: "Kulmude analüüs", note: "" },
    { title: "Värvimine", note: "Värv sobis" },
  ],
  generalNote: "Tubli töö!\nJätka harjutamist.",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the protocol page", () => {
  test("loads her registration's protocol from the fragment's id; the stages with a note, the general notes as written, when it was sent", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("et", "#id=42");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/protokoll?id=42");
    expect($("h1")!.textContent).toBe("Kulmude lamineerimine");
    expect($("[data-protocol-when]")!.textContent).toBe("12.10.2026 · 10:00 · Pärnu, MS LAB stuudio");
    expect($$("[data-protocol-stage] h3").map((h) => h.textContent)).toEqual(["Ettevalmistus", "Värvimine"]);
    expect($("[data-protocol-general]")!.textContent).toBe("Tubli töö!\nJätka harjutamist.");
    expect(container.textContent).toContain("Praktiline osa");
    expect(container.textContent).toContain("Üldised märkused");
    expect(container.textContent).toContain("Saadetud 12.10.2026");
    expect($("[data-protocol-back]")!.getAttribute("href")).toBe("/konto");
  });

  test("opened by the mail's login (#sisse&id=42): the mark leaves the address, the id stays and is read", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("et", "#sisse&id=42");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/protokoll?id=42");
    expect(window.location.hash).toBe("#id=42"); // useAccount's takeLoginMark (Task 3): the mark taken, the rest kept
  });

  test("not hers, or none sent: 'Seda protokolli ei leitud.' with the way back; an address without an id asks nothing", async () => {
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await page("et", "#id=42");
    expect($("[data-account-state='noProtocol']")!.textContent).toContain("Seda protokolli ei leitud.");
    fetchMock.mockReset();
    await page("et", "");
    expect(fetchMock).not.toHaveBeenCalled();
    expect($("[data-account-state='noProtocol']")).not.toBeNull();
  });

  test("Review Focus 5: Russian: the frame and the course in Russian, Maria's text as she wrote it", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("ru", "#id=42");
    expect($("h1")!.textContent).toBe("Ламинирование бровей");
    for (const text of ["Практическая часть", "Общие замечания", "Отправлен 12.10.2026", "Kulmud said ühtlased", "Ettevalmistus"]) expect(container.textContent).toContain(text);
    expect($("[data-protocol-back]")!.getAttribute("href")).toBe("/ru/konto");
  });
});

describe("the card's 'Vaata protokolli'", () => {
  const NOW = "2026-10-13T10:00:00.000Z";
  const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
    kind: "contact",
    registrationId,
    course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } },
    session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "", cancelled: false },
    status: "confirmed",
    paymentChoice: "full",
    priceCents: 35000,
    paidCents: 35000,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
  });
  const dashboard = (cards: Dashboard["cards"]): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards,
    favourites: [],
    prepayment: null,
    resume: null,
  });
  const render = async (data: Dashboard, readOnly = false) =>
    act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), data, readOnly, now: NOW })));

  test("a course that has been, its protocol sent: 'Vaata protokolli' is its one button; none before it is sent", async () => {
    await render(dashboard([contact(7, { protocolSent: true }), contact(8)]));
    const link = $("[data-card='registration-7'] [data-card-protocol]")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Vaata protokolli", "/konto/protokoll#id=7"]);
    expect(link.className).toMatch(/btnOutline/);
    expect($("[data-card='registration-8'] [data-card-protocol]")).toBeNull();
  });

  test("a card with a button of its own gets the link under it; an individual course's card too; read-only it does nothing", async () => {
    const ahead = contact(9, { session: { startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu", venue: "", cancelled: false }, protocolSent: true });
    const individual: IndividualCard = { kind: "individual", registrationId: 10, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } }, status: "confirmed", preferredPeriod: "", createdAt: "2026-09-01T10:00:00.000Z", protocolSent: true };
    await render(dashboard([ahead, individual]));
    expect($("[data-card='registration-9'] [data-card-action]")!.textContent).toBe("Tühista või muuda aega");
    expect($("[data-card='registration-9'] [data-card-protocol]")!.className).not.toMatch(/btnOutline/);
    expect($("[data-card='registration-10'] [data-card-protocol]")!.getAttribute("href")).toBe("/konto/protokoll#id=10");
    await render(dashboard([contact(7, { protocolSent: true })]), true);
    expect($("[data-card-protocol]")!.getAttribute("aria-disabled")).toBe("true");
    expect($("[data-card-protocol]")!.getAttribute("href")).toBeNull();
  });
});
```

  Run `npx vitest run tests/unit/account-protocol-dom.test.ts` — FAIL (`ProtocolPage` does not exist; no `[data-card-protocol]`).

- [ ] **Step 7: The card** (`src/components/account/AccountCourseCard.tsx`). Before the component's `return (` (the line before `<article`), add:

```tsx
  // "Vaata protokolli" (phase protocols, spec §5): once Maria has sent it. The card's one button when it has none (a course that has been),
  // else a text link under its button. Its registration in the fragment: an account page never has a query.
  const protocolHref = (card.kind === "contact" || card.kind === "individual") && card.protocolSent ? `${href(locale, "/konto/protokoll")}#id=${card.registrationId}` : null;
  if (protocolHref) {
    const main = button === null;
    const cls = main ? `${ui.btnOutline} ${styles.action}` : styles.second;
    const link = readOnly ? (
      <a className={cls} role="link" aria-disabled="true" data-card-protocol="">
        {t.viewProtocol}
      </a>
    ) : (
      <Link className={cls} href={protocolHref} data-card-protocol="">
        {t.viewProtocol}
      </Link>
    );
    if (main) button = link;
    else
      second = (
        <>
          {second}
          {link}
        </>
      );
  }
```

  and in the component's comment, after "- openCourse → "Ava koolitus" → /konto/kursus/{slug}.", add "- a sent protocol (phase protocols) → "Vaata protokolli" → /konto/protokoll#id={registration}: the main button of a card that has none, else a text link under it."

- [ ] **Step 8: The page.**
  1. Create `src/components/account/useHashId.ts`:

```ts
"use client";

import { useSyncExternalStore } from "react";
import { parseRowId } from "@/lib/row-id";

// The registration an account page is about, from the address's fragment (phase protocols): an account page never has a query (the
// middleware moves ?id= into the fragment), so the protocol's and the feedback form's pages are /konto/protokoll#id=<n>, /konto/tagasiside#id=<n>.

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The fragment's id (#id=<n>; the login mark may come first: #sisse&id=<n>), or null without one that can be a row id. */
export const hashId = (): number | null => parseRowId(new URLSearchParams(window.location.hash.slice(1)).get("id") ?? "");

/** The page's registration: undefined while it is not known (the static shell's server render, and its hydration), null without one. */
export function useHashId(): number | null | undefined {
  return useSyncExternalStore(subscribe, hashId, () => undefined);
}
```

  2. Create `src/components/account/ProtocolPage.module.css`:

```css
/* The student's protocol (phase protocols, spec §5): the day and place, the practice part's headings with Maria's notes as she wrote them
   (line breaks kept), the general notes, when it was sent. The page, its column and its title are AccountPage.module.css's. Tokens only. */

.eyebrow {
  margin: 0;
  color: var(--muted);
  font: 500 13px/1.4 var(--font-body);
}

.when {
  margin: 0;
  color: var(--muted-2);
  font: 400 15px/1.55 var(--font-body);
}

.part {
  display: grid;
  gap: 14px;
  justify-self: stretch;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.partTitle {
  margin: 0;
  font: 400 24px/1.25 var(--font-display);
}

.stage {
  display: grid;
  gap: 4px;
}

.stageTitle {
  margin: 0;
  font: 600 16px/1.4 var(--font-body);
  overflow-wrap: anywhere;
}

.note {
  margin: 0;
  color: var(--ink-soft);
  font: 400 16px/1.6 var(--font-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.sent {
  margin: 0;
  color: var(--muted-2);
  font: 400 13px/1.5 var(--font-body);
}
```

     And `src/components/account/AccountPage.module.css`, the reading page the protocol and the feedback form share:

```css
/* An account page about one registration (phase protocols: the protocol, the feedback form): a reading column under the shell's tabs, the
   course or the form as its title in Jost (as the e-course page), and the empty block that holds the place while the page reads its
   fragment. Tokens only. */

.page {
  padding-top: clamp(28px, 4vw, 52px);
  padding-bottom: clamp(48px, 6vw, 96px);
}

.column {
  display: grid;
  justify-items: start;
  gap: 18px;
  max-width: 760px;
}

.title {
  margin: 0;
  font: 400 clamp(32px, 4vw, 46px) / 1.1 var(--font-display);
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.wait {
  min-height: 52vh;
  padding-top: clamp(28px, 4vw, 52px);
}
```

     And `src/components/account/AccountNotFound.tsx`:

```tsx
"use client";

import Link from "next/link";
import { Icon } from "@/components/site/Icon";
import { Notice } from "@/components/site/Notice";
import ui from "@/components/site/ui.module.css";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";

/**
 * An account page about a registration that is not hers, or not there (phase protocols: the protocol's page, the feedback form): the one
 * sentence and the one way back, to Minu koolitused. `state` names the case for the tests (data-account-state).
 */
export function AccountNotFound({ state, title, back, locale }: { state: string; title: string; back: string; locale: Locale }) {
  return (
    <div data-account-state={state}>
      <Notice title={title}>
        <Link className={ui.btn} href={href(locale, "/konto")}>
          {back}
          <Icon name="arrow" />
        </Link>
      </Notice>
    </div>
  );
}
```

  3. Create `src/components/account/ProtocolPage.tsx`:

```tsx
"use client";

import Link from "next/link";
import ui from "@/components/site/ui.module.css";
import type { StudentProtocol } from "@/db/queries/protocols";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { AccountLoader } from "./AccountLoader";
import { AccountNotFound } from "./AccountNotFound";
import { GreetingSkeleton } from "./CardSkeleton";
import type { ProtocolTexts } from "./texts";
import { useHashId } from "./useHashId";
import page from "./AccountPage.module.css";
import styles from "./ProtocolPage.module.css";

/** GET /api/konto/protokoll's answer: the sent copy. */
type ProtocolAnswer = StudentProtocol & { ok: true };

/**
 * The personal part of /konto/protokoll#id=<registration> (phase protocols, spec §5; the page is a static shell, the same for every visitor):
 * the registration from the fragment, its protocol from GET /api/konto/protokoll?id= (AccountLoader: signed out → the login page, another
 * device, error + retry). Not hers, or none sent: "Seda protokolli ei leitud." with the way back to Minu koolitused, as an address without an id.
 */
export function ProtocolPage({ locale, t }: { locale: Locale; t: ProtocolTexts }) {
  const id = useHashId();
  const notFound = <AccountNotFound state="noProtocol" title={t.notFound} back={t.back} locale={locale} />;
  if (id === undefined) return <div className={`${ui.wrap} ${page.wait}`} aria-busy="true" />;
  if (id === null) return notFound;
  return (
    <AccountLoader<ProtocolAnswer>
      key={id}
      path={`/api/konto/protokoll?id=${id}`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      skeleton={
        <div className={`${ui.wrap} ${page.wait}`}>
          <GreetingSkeleton />
        </div>
      }
      notFound={notFound}
      render={(data) => <ProtocolView data={data} locale={locale} t={t} />}
    />
  );
}

/** The sent protocol: the course and its day, the stages that have a note, the general notes, when it was sent. Maria's text as she wrote it. */
function ProtocolView({ data, locale, t }: { data: ProtocolAnswer; locale: Locale; t: ProtocolTexts }) {
  const stages = data.stages.filter((s) => s.note.trim() !== "");
  const start = data.session ? new Date(data.session.startsAt) : null;
  const place = data.session ? [data.session.city, data.session.venue].filter(Boolean).join(", ") : "";
  return (
    <article className={`${ui.wrap} ${page.page}`} data-protocol-page="">
      <div className={page.column}>
        <p className={styles.eyebrow}>{t.title}</p>
        <h1 className={page.title}>{pick(data.course.title, locale)}</h1>
        {start && (
          <p className={styles.when} data-protocol-when="">
            {[`${formatDate(start, locale)} · ${formatTime(start, locale)}`, place].filter(Boolean).join(" · ")}
          </p>
        )}
        {stages.length > 0 && (
          <section className={styles.part} aria-labelledby="protocol-practice">
            <h2 id="protocol-practice" className={styles.partTitle}>
              {t.practice}
            </h2>
            {stages.map((s, i) => (
              <div key={i} className={styles.stage} data-protocol-stage={i}>
                <h3 className={styles.stageTitle}>{s.title}</h3>
                <p className={styles.note}>{s.note}</p>
              </div>
            ))}
          </section>
        )}
        {data.generalNote.trim() !== "" && (
          <section className={styles.part} aria-labelledby="protocol-general">
            <h2 id="protocol-general" className={styles.partTitle}>
              {t.general}
            </h2>
            <p className={styles.note} data-protocol-general="">
              {data.generalNote}
            </p>
          </section>
        )}
        <p className={styles.sent}>{fill(t.sent, { date: formatDate(new Date(data.sentAt), locale) })}</p>
        <Link className={ui.btnOutline} href={href(locale, "/konto")} data-protocol-back="">
          {t.back}
        </Link>
      </div>
    </article>
  );
}
```

  4. Create `src/app/[locale]/(site)/konto/protokoll/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { ProtocolPage } from "@/components/account/ProtocolPage";
import { protocolTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.protocol.title} — ${d.common.siteName}` };
}

/**
 * A student's protocol (phase protocols, spec §5): /konto/protokoll#id=<registration id>. A static shell, the same for every visitor (no
 * cookies, headers or query read here; the id is in the fragment, which no server or cache sees). The browser loads the protocol from
 * GET /api/konto/protokoll?id= (ProtocolPage): only the copy Maria sent, only for the signed-in student's own registration.
 */
export default async function ProtocolShellPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <ProtocolPage locale={locale} t={protocolTexts(d)} />
    </AccountShell>
  );
}
```

  5. **`src/lib/site-routing.ts`.** In `STATIC_PAGES` add `"/konto/protokoll"` after `"/konto/lemmikud"`; in its comment, after "(/konto…, phase 2a: the login page, favourites and my details)", add "and (phase protocols) a student's protocol". `FRAGMENT_PARAMS` becomes `["viga", "korda", "email", "kood", "id"] as const;` and its comment gains "and `id`, the registration of the protocol's and the feedback form's pages (phase protocols)".

- [ ] **Step 9: The routing, the gate and the caches — the tests.**
  1. **`tests/unit/site-routing.test.ts`.** In "the known pages are exactly the pages of app/[locale]/(site)", add `"/konto/protokoll"` to the expected list (after `"/konto/lemmikud"`). In "the client account's pages are known …", add `"/konto/protokoll"` to the first list and `"/et/konto/protokoll/5"` to the second. In "accountShellTarget: …", add:

```ts
    // the protocol's page (phase protocols): its registration moves into the fragment, after the others
    expect(target("/konto/protokoll", "id=42")).toBe("/konto/protokoll#id=42");
    expect(target("/ru/konto/protokoll", "utm=1&id=42")).toBe("/ru/konto/protokoll#id=42");
    expect(route("/konto/protokoll?id=42")).toEqual({ kind: "shellRedirect", location: "/konto/protokoll#id=42" });
```

  2. **`tests/unit/site-gate.test.ts`.** In `GATED`, after `"/konto/kursus/x/12",` add `"/konto/protokoll",` and after `"/api/konto/kursus/x/1/fail/2",` add `"/api/konto/protokoll",`.
  3. **`tests/unit/colour-tokens.test.ts`.** After `"src/components/account/ResumeCard.module.css",` add `// the student's protocol (phase protocols)`, `"src/components/account/AccountPage.module.css",` and `"src/components/account/ProtocolPage.module.css",`. And **`tests/unit/old-safari.test.ts`**: `BROWSER_FILES` gains `// Task 7`, `"src/components/account/useHashId.ts"`, `"src/components/account/AccountNotFound.tsx"`, `"src/components/account/ProtocolPage.tsx"`.
  4. **`tests/e2e/cache.spec.ts`.** `ACCOUNT_SHELLS` gains `"/konto/protokoll", "/ru/konto/protokoll",` after `"/ru/konto/andmed",`; the test "an account shell asked for with a query …" sets `test.setTimeout(420_000); // fourteen shells`. After that test, add:

```ts
test("the protocol's address with its id in a query (a typed or an old link) is answered with a 303 to the fragment, the id kept (phase protocols)", async ({ request }) => {
  for (const path of ["/konto/protokoll", "/ru/konto/protokoll"]) {
    const res = await request.get(`${path}?id=42`, { maxRedirects: 0, failOnStatusCode: false });
    expect(res.status(), path).toBe(303);
    expect(res.headers()["location"], path).toBe(`${path}#id=42`);
    expect(res.headers()["cache-control"], path).toBe("no-store");
  }
  const api = await request.get("/api/konto/protokoll?id=42", { failOnStatusCode: false });
  expect([api.status(), api.headers()["cache-control"], api.headers()["x-nextjs-cache"]]).toEqual([401, "private, no-store", undefined]);
});
```

  5. **`tests/e2e/gate.spec.ts`.** In "every address of the site is the coming-soon page …", add `"/konto/protokoll"` after `"/konto/sisene?viga=link"`; in "the account's API and the review comments answer 404 without the page …", the loop becomes `for (const path of ["/api/konto/me", "/api/konto/protokoll?id=1", "/api/feedback"])`.

- [ ] **Step 10: Run** `npx vitest run tests/unit/account-protocol-dom.test.ts tests/db/protocols-student.test.ts tests/unit/site-routing.test.ts tests/unit/site-gate.test.ts tests/unit/middleware.test.ts tests/unit/colour-tokens.test.ts tests/unit/old-safari.test.ts tests/unit/i18n.test.ts tests/unit/account-guards.test.ts` — expect PASS.

- [ ] **Step 11: Run everything.**
  - `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`.
  - `next build` (`npm run build`): `/[locale]/konto/protokoll` is prerendered (● or ○), never ƒ.
  - `E2E_PROD_BUILD=1 npx playwright test cache account-dashboard`; `npx playwright test -c playwright.gate.config.ts`.

- [ ] **Step 12: Commit.**

```bash
git add app/src/db/queries/protocols.ts app/src/server/account-api.ts app/src/domain/account-cards.ts app/src/server/client-data.ts app/src/components/account "app/src/app/[locale]/(site)/konto/protokoll" app/src/i18n/dict/et.ts app/src/i18n/dict/ru.ts app/src/lib/site-routing.ts app/tests
git commit -m "feat(account): the student's protocol — GET /api/konto/protokoll, Vaata protokolli on her card, the static /konto/protokoll shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The course feedback form — its card with "Ei soovi", `/konto/tagasiside`, the API, Maria's notice

Spec sections 3 (when it opens), 6 (Maria's notice), 7 (the form, the card, the answers, the closing line) and 10. Optional, with no reminders.

**One addition the code needs: `GET /api/konto/tagasiside?id=`.** The spec lists `POST /tagasiside` and `POST /tagasiside/peida`. The form is a static shell like every account page, so it learns which course it is about, and whether she has answered already, only from an API: the GET answers `{ course, sent }`, owner only and by the open rule (404 otherwise), so the form never shows a course that is not hers.

**"Ei soovi" hides the card, not the form.** The first protocol mail carries a link to the form (spec §6); a student who pressed "Ei soovi" and later opens that link may still answer (her row's `answers` are null until then). The card never comes back.

**A submit and an account deletion at the same moment.** The submit reads the registration `FOR SHARE` in its transaction, so a deletion (Task 10: it locks her registrations `FOR UPDATE` before it removes her feedback) either finishes first — the registration is no longer hers and the submit is a 404 — or waits until the answer is stored and then deletes it with the account.

**Files:**
- Modify: `app/src/i18n/dict/et.ts`, `app/src/i18n/dict/ru.ts` (`account.feedback`, `account.dashboard.feedbackCard`)
- Create: `app/src/server/course-feedback.ts`
- Modify: `app/src/server/messages.ts` (`feedbackSummary`, `FeedbackNotice`)
- Modify: `app/src/server/account-input.ts` (`parseFeedbackPost`, `parseFeedbackHide`)
- Modify: `app/src/server/account-api.ts` (`feedbackForm`, `sendFeedback`, `dismissFeedback`; the router; the header comment)
- Modify: `app/src/domain/account-cards.ts` (`FeedbackPrompt`), `app/src/server/client-data.ts` (`Dashboard.feedback`, `loadDashboard`)
- Create: `app/src/components/account/FeedbackCard.tsx`, `app/src/components/account/FeedbackForm.tsx`, `app/src/components/account/FeedbackForm.module.css` (the page's column, title and not-found notice: Task 7's `AccountPage.module.css` and `AccountNotFound`)
- Modify: `app/src/components/account/CoursesTab.tsx`, `CoursesTab.module.css`, `texts.ts`
- Create: `app/src/app/[locale]/(site)/konto/tagasiside/page.tsx`
- Modify: `app/src/lib/site-routing.ts` (`STATIC_PAGES`)
- Modify: `app/tests/unit/protocols.test.ts`, `account-guards.test.ts`, `site-routing.test.ts`, `site-gate.test.ts`, `colour-tokens.test.ts`, `app/tests/e2e/cache.spec.ts`, `app/tests/e2e/gate.spec.ts`
- Test: `app/tests/db/feedback.test.ts`, `app/tests/unit/feedback-messages.test.ts`, `app/tests/unit/feedback-form-dom.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `feedbackOpenFor`, `checkFeedback`, `isChoice`, `feedbackQuestions`, `FEEDBACK_ORDER`, `FEEDBACK_CHOICES`, `FEEDBACK_TEXT_MAX`, `answerText`, `FeedbackAnswers`, `FeedbackKey`; (Task 7) `AccountNotFound`, `AccountPage.module.css`; `courseFeedback`, `protocols` (Task 1); `queryId` (Task 7); `useHashId` (Task 7); `saveProtocol`, `sendProtocol` (tests).
- Produces, from `src/server/course-feedback.ts`: `type FeedbackFormState = { course: { slug: string; title: I18n }; sent: boolean }`; `feedbackState(db, clientId, registrationId, now): Promise<FeedbackFormState | null>`; `type SubmitResult = { kind: "submitted"; notice: FeedbackNotice } | { kind: "sent" } | { kind: "notFound" }`; `submitFeedback(db, input: { clientId; registrationId; answers; locale }, now): Promise<SubmitResult>`; `hideFeedback(db, input: { clientId; registrationId }, now): Promise<boolean>`; `notifyFeedback(env: Env, siteUrl: string, notice: FeedbackNotice): Promise<void>`.
- Produces, from `src/server/messages.ts`: `type FeedbackNotice = { registrationId: number; name: string; email: string; course: string; startsAt: Date | null; answers: FeedbackAnswers }`; `feedbackSummary(f: FeedbackNotice, adminUrl: string): Summary`.
- Produces: `GET /api/konto/tagasiside?id=` → 200 `{ ok: true, course, sent }` | 404; `POST /api/konto/tagasiside` `{ registrationId, locale, answers }` → 200 | 400 `{ error }` | 404 `{ error: "registration" }` | 409 `{ error: "sent" }` | 429; `POST /api/konto/tagasiside/peida` `{ registrationId }` → 200 | 404 | 429.
- Produces: `type FeedbackPrompt = { registrationId: number; course: CourseRef }` (`domain/account-cards.ts`); `Dashboard.feedback?: FeedbackPrompt[]` (present only when there is one); `FeedbackCard({ prompt, locale, t, readOnly, onDismissed })` (`[data-feedback-card=<id>]`, `[data-feedback-open]`, `[data-feedback-dismiss]`); `FeedbackForm({ locale, t })` (`[data-feedback-form]`, `[data-question=<key>]`, `[data-feedback-submit]`, `[data-feedback-error]`, `[data-feedback-done]`); `type FeedbackTexts`, `feedbackTexts(d)`.

- [ ] **Step 1: The texts — their test first.**
  1. **`tests/unit/protocols.test.ts`** first: add `answerText`, `feedbackQuestions` to its `@/domain/protocols` import, `import { et } from "@/i18n/dict/et";` and `import { ru } from "@/i18n/dict/ru";`, and append:

```ts
describe("the questions' texts (Task 8)", () => {
  test("every question and every option has its words in both languages; nothing more", () => {
    for (const dict of [et, ru]) {
      const q = feedbackQuestions(dict.account.feedback.questions);
      expect(Object.keys(q)).toEqual([...FEEDBACK_ORDER]);
      for (const [key, options] of Object.entries(FEEDBACK_CHOICES)) expect(Object.keys(q[key as keyof typeof FEEDBACK_CHOICES].options ?? {}), key).toEqual([...options]);
      for (const key of ["score", "recommend", "message"] as const) expect(q[key].options, key).toBeUndefined();
    }
  });

  test("answerText: the score as n/10, an option in the given wording, a free text as written", () => {
    const q = feedbackQuestions(et.account.feedback.questions);
    expect(answerText("score", 9, q)).toBe("9/10");
    expect(answerText("expectations", "met", q)).toBe("Vastas ootustele");
    expect(answerText("ready", "mostly", feedbackQuestions(ru.account.feedback.questions))).toBe("Скорее да, нужно немного практики");
    expect(answerText("message", "Väga hea!", q)).toBe("Väga hea!");
  });
});
```

  Run `npx vitest run tests/unit/protocols.test.ts` — FAIL (`account.feedback` is in neither dictionary yet: reading its `questions` throws).

  2. **`src/i18n/dict/et.ts`**, in `account.dashboard`, after `viewProtocol: "Vaata protokolli",` add:

```ts
      // the feedback form's card (components/account/FeedbackCard.tsx, phase protocols, spec §7): once the form opens; "Ei soovi" hides it for good
      feedbackCard: { question: "Kuidas koolitus läks?", open: "Jäta tagasiside", dismiss: "Ei soovi", dismissFailed: "Ei õnnestunud. Proovi uuesti." },
```

     and in `account`, after the `protocol` block:

```ts
    // The feedback form /konto/tagasiside#id=<registration> (components/account/FeedbackForm.tsx, phase protocols, spec §7): Maria's paper form
    // "Sinu kogemus MS LAB koolitusel", its questions and options as she wrote them (the keys: domain/protocols.ts FEEDBACK_ORDER). Nothing is
    // required, at least one answer is. `thanks` is the line after sending. {n} and {max}: a free text's length and its limit.
    feedback: {
      title: "Sinu kogemus MS LAB koolitusel",
      lead: "Vasta neile küsimustele, millele soovid.",
      questions: {
        score: { label: "Kuidas hindad koolitust tervikuna skaalal 1–10?" },
        expectations: { label: "Kas koolitus vastas sinu ootustele?", options: { exceeded: "Ületas ootusi", met: "Vastas ootustele", not_met: "Ei vastanud ootustele" } },
        clarity: { label: "Kas koolituse sisu oli arusaadav ja loogiliselt üles ehitatud?", options: { very_clear: "Väga selge", fairly_clear: "Pigem selge", needs_work: "Vajaks parandamist" } },
        balance: { label: "Kas teooria ja praktika tasakaal oli sinu jaoks sobiv?", options: { ideal: "Jah, ideaalne", more_practice: "Sooviksin rohkem praktikat", more_theory: "Sooviksin rohkem teooriat" } },
        ready: {
          label: "Kas tunned, et oled valmis peale koolitust iseseisvalt teenust pakkuma?",
          options: { fully: "Jah, täiesti", mostly: "Pigem jah, natuke harjutamist vajab", rather_not: "Pigem ei", no: "Ei" },
        },
        trainer: {
          label: "Kuidas hindad koolitaja juhendamisoskust ja selgitusi?",
          options: { excellent: "Väga professionaalne ja toetav", good: "Hea", satisfactory: "Rahuldav", needs_growth: "Vajaks arengut" },
        },
        safe: { label: "Kas tundsid end koolitusel turvaliselt ja toetatuna?", options: { very: "Jah, väga", rather_yes: "Pigem jah", rather_not: "Pigem ei" } },
        materials: { label: "Kas õppematerjalid olid piisavad ja arusaadavad?", options: { yes: "Jah", rather_yes: "Pigem jah", rather_not: "Pigem ei", no: "Ei" } },
        recommend: { label: "Kas soovitaksid seda koolitust ka teistele? Miks?" },
        message: { label: "Soovi korral jäta meile väike tagasiside või sõnum:" },
      },
      count: "{n} / {max}",
      submit: "Saada tagasiside",
      sending: "Saadan…",
      empty: "Vasta vähemalt ühele küsimusele.",
      thanks: "Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!",
      sent: "Tagasiside on juba saadetud. Aitäh!",
      notOpen: "Sellele koolitusele ei saa praegu tagasisidet anda.",
      loading: "Laadin…",
    },
```

  3. **`src/i18n/dict/ru.ts`**, in `account.dashboard`, after `viewProtocol: "Посмотреть протокол",`:

```ts
      feedbackCard: { question: "Как прошло обучение?", open: "Оставьте отзыв", dismiss: "Не хочу", dismissFailed: "Не получилось. Попробуйте ещё раз." },
```

     and after its `protocol` block:

```ts
    feedback: {
      title: "Ваш опыт обучения в MS LAB",
      lead: "Ответьте на те вопросы, на которые хотите.",
      questions: {
        score: { label: "Как вы оцениваете обучение в целом по шкале от 1 до 10?" },
        expectations: { label: "Оправдало ли обучение ваши ожидания?", options: { exceeded: "Превзошло ожидания", met: "Оправдало ожидания", not_met: "Не оправдало ожиданий" } },
        clarity: { label: "Было ли содержание обучения понятным и логично выстроенным?", options: { very_clear: "Очень понятно", fairly_clear: "Скорее понятно", needs_work: "Нуждается в доработке" } },
        balance: { label: "Подходил ли вам баланс теории и практики?", options: { ideal: "Да, идеально", more_practice: "Хотелось бы больше практики", more_theory: "Хотелось бы больше теории" } },
        ready: {
          label: "Чувствуете ли вы, что после обучения готовы самостоятельно оказывать услугу?",
          options: { fully: "Да, полностью", mostly: "Скорее да, нужно немного практики", rather_not: "Скорее нет", no: "Нет" },
        },
        trainer: {
          label: "Как вы оцениваете умение преподавателя направлять и объяснять?",
          options: { excellent: "Очень профессионально и с поддержкой", good: "Хорошо", satisfactory: "Удовлетворительно", needs_growth: "Есть куда расти" },
        },
        safe: { label: "Чувствовали ли вы себя на обучении в безопасности и при поддержке?", options: { very: "Да, очень", rather_yes: "Скорее да", rather_not: "Скорее нет" } },
        materials: { label: "Были ли учебные материалы достаточными и понятными?", options: { yes: "Да", rather_yes: "Скорее да", rather_not: "Скорее нет", no: "Нет" } },
        recommend: { label: "Порекомендовали бы вы это обучение другим? Почему?" },
        message: { label: "По желанию оставьте нам короткий отзыв или сообщение:" },
      },
      count: "{n} / {max}",
      submit: "Отправить отзыв",
      sending: "Отправляю…",
      empty: "Ответьте хотя бы на один вопрос.",
      thanks: "Спасибо, что вы часть начала и роста учебного центра MS LAB. Ваш отзыв помогает нам становиться ещё лучше!",
      sent: "Отзыв уже отправлен. Спасибо!",
      notOpen: "Для этого обучения сейчас нельзя оставить отзыв.",
      loading: "Загрузка…",
    },
```

  Run `npx vitest run tests/unit/protocols.test.ts tests/unit/i18n.test.ts` — PASS (the texts are in; the parity, placeholder and Cyrillic checks hold).

- [ ] **Step 2: Write the failing notice test** `tests/unit/feedback-messages.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { feedbackSummary } from "@/server/messages";

// Maria's notice of a new answer (spec §6): "Uus tagasiside: {nimi}, {koolitus}, {score}/10" (without the score part when none was given),
// and the answers in her own wording, whatever language the student answered in.

const ADMIN = "https://mslab.example/admin";
const base = { registrationId: 7, name: "Mari Maasikas", email: "mari@example.test", course: "Kulmude lamineerimine", startsAt: new Date("2026-10-12T07:00:00Z") };

describe("feedbackSummary", () => {
  test("the subject with the score; who, the course and its day; every answered question in Maria's wording; the admin's page", () => {
    const s = feedbackSummary({ ...base, answers: { score: 9, expectations: "met", ready: "mostly", message: "Aitäh!\nVäga hea päev." } }, ADMIN);
    expect(s.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10");
    expect(s.short).toBe(s.subject);
    expect(s.text).toBe(
      [
        "Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10", "",
        "Õpilane: Mari Maasikas", "E-post: mari@example.test", "Koolitus: Kulmude lamineerimine, 12.10.2026", "",
        "Kuidas hindad koolitust tervikuna skaalal 1–10?", "9/10", "",
        "Kas koolitus vastas sinu ootustele?", "Vastas ootustele", "",
        "Kas tunned, et oled valmis peale koolitust iseseisvalt teenust pakkuma?", "Pigem jah, natuke harjutamist vajab", "",
        "Soovi korral jäta meile väike tagasiside või sõnum:", "Aitäh!\nVäga hea päev.", "",
        "Admin: https://mslab.example/admin/tagasiside", "",
      ].join("\n"),
    );
  });

  test("without a score the subject has no score part; an individual course has no day", () => {
    const s = feedbackSummary({ ...base, startsAt: null, answers: { recommend: "Jah" } }, ADMIN);
    expect(s.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine");
    expect(s.text).toContain("Koolitus: Kulmude lamineerimine\n");
  });
});
```

  Run `npx vitest run tests/unit/feedback-messages.test.ts` — FAIL.

- [ ] **Step 3: Maria's notice** — in `src/server/messages.ts`:
  1. After `import { formatDate } from "@/i18n/format";` add:

```ts
import { answerText, FEEDBACK_ORDER, feedbackQuestions, type FeedbackAnswers } from "@/domain/protocols";
import { et } from "@/i18n/dict/et";
```

  2. Append at the end:

```ts
// ---------- the course feedback form (phase protocols, spec §6, §7) ----------

/** A student's answers, for Maria's notice. `course` is the course's Estonian title; `startsAt` its session's start (null: an individual course). */
export type FeedbackNotice = { registrationId: number; name: string; email: string; course: string; startsAt: Date | null; answers: FeedbackAnswers };

/**
 * "Uus tagasiside: {nimi}, {koolitus}, {score}/10" (spec §6; without the score part when none was given): who answered, the course and its
 * day, then every answered question with its answer in Maria's own wording (the form's Estonian texts, et.ts account.feedback, the one place
 * they are written), whatever language the student answered in; the free texts as she wrote them.
 */
export function feedbackSummary(f: FeedbackNotice, adminUrl: string): Summary {
  const q = feedbackQuestions(et.account.feedback.questions);
  const subject = `Uus tagasiside: ${f.name}, ${f.course}${f.answers.score !== undefined ? `, ${f.answers.score}/10` : ""}`;
  const answered = FEEDBACK_ORDER.flatMap((key) => {
    const value = f.answers[key];
    return value === undefined ? [] : [q[key].label, answerText(key, value, q), ""];
  });
  const text = [
    subject, "",
    `Õpilane: ${f.name}`, `E-post: ${f.email}`, `Koolitus: ${f.startsAt ? `${f.course}, ${formatDate(f.startsAt, "et")}` : f.course}`, "",
    ...answered,
    `Admin: ${adminUrl}/tagasiside`, "",
  ].join("\n");
  return { subject, text, short: subject };
}
```

  Run `npx vitest run tests/unit/feedback-messages.test.ts tests/unit/messages.test.ts` — PASS.

- [ ] **Step 4: Write the failing API tests** `tests/db/feedback.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseFeedback, courseSessions, registrations } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import type { Env } from "@/server/notify";
import { saveProtocol, sendProtocol } from "@/server/protocols";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The course feedback form (spec §3, §7, §10): when it opens, the dashboard's card and "Ei soovi", the one submit per registration with its
// checks, and Maria's notice after the response.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
let net: ReturnType<typeof stubFetch>;
/** Resend and Telegram "on" (the stubbed fetch answers them); a fresh rate-limit store each test (every test's client is id 1). */
let env: Env;
beforeEach(async () => {
  db = await makeTestDb();
  env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };
  net = stubFetch((url) => (url.includes("telegram") ? Response.json({ ok: true }) : Response.json({ id: "email_1" })));
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(now = NOW) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: AccountDeps = { db, env, now, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
async function cookieOf(clientId: number): Promise<string> {
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return `__Host-mslab_client=${raw}`;
}
const call = async (d: AccountDeps, cookie: string, path: string, body?: unknown) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) }),
    d,
  ))!;
const answer = async (res: Response) => [res.status, await res.json()];
const rows = () => db.select().from(courseFeedback);
const mails = () => net.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string });

/** Mari's registration with a sent protocol (the form opens with it), her account and session. */
async function opened(locale: "et" | "ru" = "et") {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas", { locale });
  await saveProtocol(db, { registrationId: mari.id, version: 0, titles: HEADINGS, notes: ["Hea", "", "", ""], generalNote: "" }, NOW);
  await sendProtocol({ db, env, siteUrl: SITE, now: NOW, later: () => {} }, { registrationId: mari.id, version: 1 });
  const [account] = await db.select().from(clients).where(eq(clients.email, "marimaasikas@example.com"));
  return { course, session, mari, account, cookie: await cookieOf(account.id) };
}

describe("the form opens", () => {
  test("with the sent protocol: GET names the course and says nothing is sent; the dashboard has its card", async () => {
    const { mari, account, cookie } = await opened();
    expect(await answer(await call(deps().d, cookie, `/tagasiside?id=${mari.id}`))).toEqual([200, { ok: true, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } }, sent: false }]);
    expect((await loadDashboard(db, account.id, NOW))!.feedback).toEqual([{ registrationId: mari.id, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } } }]);
  });

  test("a group session that started before today opens it without a protocol (spec §3); one called off does not; one that starts today does not", async () => {
    const { course, session } = await protocolCourse(db);
    const [account] = await db.insert(clients).values({ email: "anu@example.com" }).returning();
    const anu = await student(db, course, session, "Anu", { clientId: account.id, email: "anu@example.com" });
    const cookie = await cookieOf(account.id);
    // the course day 12.10, asked at 16:00 the same day: not yet
    expect((await call(deps().d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(404);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
    const nextDay = new Date("2026-10-13T08:00:00Z");
    expect((await call(deps(nextDay).d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(200);
    await db.update(courseSessions).set({ status: "cancelled" }).where(eq(courseSessions.id, session.id));
    expect((await call(deps(nextDay).d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(404);
  });

  test("not hers, cancelled, or an id that is no id: 404", async () => {
    const { course, session, mari, cookie } = await opened();
    const other = await student(db, course, session, "Teine");
    for (const id of [String(other.id), "abc", "0"]) expect((await call(deps().d, cookie, `/tagasiside?id=${id}`)).status, id).toBe(404);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect((await call(deps().d, cookie, `/tagasiside?id=${mari.id}`)).status).toBe(404);
    expect((await call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } })).status).toBe(404);
  });
});

describe("the submit", () => {
  test("stores the answers as keys with the page's language, answers 200 and tells Maria after the response; a second one is 409; the card is gone", async () => {
    const { mari, account, cookie } = await opened();
    const { d, queued, flush } = deps();
    const answers = { score: 9, expectations: "met", ready: "mostly", message: "  Aitäh!  " };
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers }))).toEqual([200, { ok: true }]);
    const [row] = await rows();
    expect(row).toMatchObject({ registrationId: mari.id, answers: { score: 9, expectations: "met", ready: "mostly", message: "Aitäh!" }, locale: "et", submittedAt: NOW, dismissedAt: null });
    expect(mails()).toEqual([]);
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect([mail.to, mail.subject]).toEqual(["maria@example.test", "Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10"]);
    expect(mail.text).toContain("Kas koolitus vastas sinu ootustele?\nVastas ootustele");
    expect(net.calls.some((c) => c.url.includes("telegram") && String((c.body as { text: string }).text).startsWith("Uus tagasiside: Mari Maasikas"))).toBe(true);
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 3 } }))).toEqual([409, { ok: false, error: "sent" }]);
    expect((await rows())[0].answers).toEqual({ score: 9, expectations: "met", ready: "mostly", message: "Aitäh!" });
    expect(await answer(await call(d, cookie, `/tagasiside?id=${mari.id}`))).toEqual([200, expect.objectContaining({ sent: true })]);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
  });

  test("the answers are checked: none is 'empty', an unknown key, a score of 11 or a text over 2000 names the key; nothing is stored", async () => {
    const { mari, cookie } = await opened();
    const post = (answers: unknown) => call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers });
    expect(await answer(await post({}))).toEqual([400, { ok: false, error: "empty" }]);
    expect(await answer(await post({ score: 9, extra: 1 }))).toEqual([400, { ok: false, error: "answers" }]);
    expect(await answer(await post({ score: 11 }))).toEqual([400, { ok: false, error: "score" }]);
    expect(await answer(await post({ message: "x".repeat(2001) }))).toEqual([400, { ok: false, error: "message" }]);
    expect(await answer(await call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "en", answers: { score: 9 } }))).toEqual([400, { ok: false, error: "locale" }]);
    expect(await rows()).toEqual([]);
  });

  test("Review Focus 5: a Russian answer is stored with its language, and Maria's notice is in her Estonian wording", async () => {
    const { mari, cookie } = await opened("ru");
    const { d, flush } = deps();
    await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "ru", answers: { trainer: "excellent", recommend: "Да, всем советую" } });
    expect((await rows())[0]).toMatchObject({ locale: "ru", answers: { trainer: "excellent", recommend: "Да, всем советую" } });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine");
    expect(mail.text).toContain("Kuidas hindad koolitaja juhendamisoskust ja selgitusi?\nVäga professionaalne ja toetav");
    expect(mail.text).toContain("Kas soovitaksid seda koolitust ka teistele? Miks?\nДа, всем советую");
  });

  test("ten a client an hour, the submits and the 'Ei soovi's together (a body that fails its check is not counted); then 429", async () => {
    const { mari, cookie } = await opened();
    const { d } = deps();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } })).status);
    expect(statuses).toEqual([200, ...Array(9).fill(409)]);
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([429, { ok: false, error: "rate" }]);
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } }))).toEqual([429, { ok: false, error: "rate" }]);
  });
});

describe("'Ei soovi'", () => {
  test("the card is gone for good, nothing is answered or told; the form still takes her answers later (the mail's link)", async () => {
    const { mari, account, cookie } = await opened();
    const { d, queued } = deps();
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([200, { ok: true }]);
    expect((await rows())[0]).toMatchObject({ answers: null, submittedAt: null, dismissedAt: NOW });
    expect(queued()).toBe(0);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([200, { ok: true }]); // twice: the same
    expect((await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 8 } })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ answers: { score: 8 }, submittedAt: NOW, dismissedAt: NOW });
  });

  test("not hers, or not open: 404, nothing stored", async () => {
    const { course, session, cookie } = await opened();
    const other = await student(db, course, session, "Teine");
    expect(await answer(await call(deps().d, cookie, "/tagasiside/peida", { registrationId: other.id }))).toEqual([404, { ok: false, error: "registration" }]);
    expect(await rows()).toEqual([]);
  });
});
```

  Run `npx vitest run tests/db/feedback.test.ts` — FAIL (the paths are unknown: 404 for every call).

- [ ] **Step 5: The server side** — create `src/server/course-feedback.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { courseFeedback, courses, courseSessions, protocols, registrations } from "@/db/schema";
import { feedbackOpenFor, type FeedbackAnswers } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { feedbackSummary, type FeedbackNotice } from "./messages";
import { adminUrl, notifyMaria, type Env } from "./notify";

// The course feedback form (phase protocols, spec §3, §7) for the signed-in client, without Next.js: account-api.ts takes the client from the
// session and calls these. A registration is hers by the dashboard's rule (registrations.client_id), and the form opens by domain/protocols.ts
// feedbackOpen. One row per registration: the submit (answers, submitted_at) or "Ei soovi" (dismissed_at). Logs carry the registration's id only.

type Own = {
  registrationId: number;
  name: string;
  email: string;
  course: { slug: string; title: I18n };
  startsAt: Date | null;
  open: boolean;
  feedback: { submittedAt: Date | null; dismissedAt: Date | null } | null;
};

/**
 * One of the client's own registrations of a contact course, with whether the form is open and her feedback row; null when it is not hers.
 * `lock`: FOR SHARE of the registration until the caller's transaction ends (an account deletion that is unlinking it waits, or is waited for).
 */
async function own(q: Q, clientId: number, registrationId: number, now: Date, lock: boolean): Promise<Own | null> {
  const query = q
    .select({
      id: registrations.id,
      name: registrations.name,
      email: registrations.email,
      status: registrations.status,
      kind: registrations.kind,
      type: courses.type,
      slug: courses.slug,
      title: courses.title,
      startsAt: courseSessions.startsAt,
      sessionStatus: courseSessions.status,
      protocolSentAt: protocols.sentAt,
      feedbackId: courseFeedback.id,
      submittedAt: courseFeedback.submittedAt,
      dismissedAt: courseFeedback.dismissedAt,
    })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .leftJoin(courseFeedback, eq(courseFeedback.registrationId, registrations.id))
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId)));
  const [r] = await (lock ? query.for("share", { of: registrations }) : query);
  if (!r || r.type !== "contact") return null;
  const open = feedbackOpenFor(r, now);
  return {
    registrationId: r.id,
    name: r.name,
    email: r.email,
    course: { slug: r.slug, title: r.title },
    startsAt: r.startsAt,
    open,
    feedback: r.feedbackId === null ? null : { submittedAt: r.submittedAt, dismissedAt: r.dismissedAt },
  };
}

/** What the form needs: its course, and whether she has answered already. */
export type FeedbackFormState = { course: { slug: string; title: I18n }; sent: boolean };

/** The form of one of her registrations; null when it is not hers, or the form is not open and she has sent nothing. */
export async function feedbackState(db: Db, clientId: number, registrationId: number, now: Date): Promise<FeedbackFormState | null> {
  const r = await own(db, clientId, registrationId, now, false);
  if (!r) return null;
  const sent = r.feedback?.submittedAt != null;
  return sent || r.open ? { course: r.course, sent } : null;
}

export type SubmitResult = { kind: "submitted"; notice: FeedbackNotice } | { kind: "sent" } | { kind: "notFound" };

/**
 * Her answers (spec §7), checked already (account-input.ts parseFeedbackPost): once per registration. A row "Ei soovi" made is answered now
 * (the mail's link still opens the form); a second submit, or two at the same moment, finds it answered: "sent". notFound: not hers, or the
 * form is not open. One transaction, the registration read FOR SHARE.
 */
export async function submitFeedback(
  db: Db,
  input: { clientId: number; registrationId: number; answers: FeedbackAnswers; locale: "et" | "ru" },
  now: Date,
): Promise<SubmitResult> {
  return db.transaction(async (tx): Promise<SubmitResult> => {
    const r = await own(tx, input.clientId, input.registrationId, now, true);
    if (!r) return { kind: "notFound" };
    if (r.feedback?.submittedAt) return { kind: "sent" };
    if (!r.open) return { kind: "notFound" };
    await tx.insert(courseFeedback).values({ registrationId: input.registrationId, createdAt: now }).onConflictDoNothing({ target: courseFeedback.registrationId });
    const [row] = await tx
      .update(courseFeedback)
      .set({ answers: input.answers, locale: input.locale, submittedAt: now })
      .where(and(eq(courseFeedback.registrationId, input.registrationId), isNull(courseFeedback.submittedAt)))
      .returning();
    if (!row) return { kind: "sent" };
    console.info(`[feedback] registration ${input.registrationId}: submitted`);
    return { kind: "submitted", notice: { registrationId: r.registrationId, name: r.name, email: r.email, course: r.course.title.et, startsAt: r.startsAt, answers: input.answers } };
  });
}

/** "Ei soovi" (spec §7): the dashboard's card is gone for good. false: not hers, or the form is not open (and nothing of hers is there). */
export async function hideFeedback(db: Db, input: { clientId: number; registrationId: number }, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await own(tx, input.clientId, input.registrationId, now, true);
    if (!r || (!r.open && !r.feedback)) return false;
    await tx.insert(courseFeedback).values({ registrationId: input.registrationId, dismissedAt: now, createdAt: now }).onConflictDoNothing({ target: courseFeedback.registrationId });
    return true;
  });
}

/** Maria's "Uus tagasiside: …" by mail and Telegram (spec §6), after the response; never fails the answer. */
export async function notifyFeedback(env: Env, siteUrl: string, notice: FeedbackNotice): Promise<void> {
  const s = feedbackSummary(notice, adminUrl(siteUrl));
  const r = await notifyMaria(env, s.subject, s.text, { short: s.short, replyTo: notice.email, siteUrl });
  console.info(`[feedback] registration ${notice.registrationId}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}
```

- [ ] **Step 6: The bodies** — in `src/server/account-input.ts`:
  1. Add `import { checkFeedback, type FeedbackAnswers } from "@/domain/protocols";` after the `zod` import.
  2. After `const payStart = …;` add:

```ts
/** The feedback form (phase protocols): the registration, the page's language, the answers (domain/protocols.ts checkFeedback). */
const feedbackPost = z.object({ registrationId: rowId, locale: z.enum(["et", "ru"]), answers: z.unknown() });
const feedbackHide = z.object({ registrationId: rowId });
```

  3. After `export const parsePayStart = …;` add:

```ts
/** POST /tagasiside's body; the error is the first wrong field, or the answers' own (checkFeedback: a key, "answers" or "empty"). */
export function parseFeedbackPost(body: unknown): Input<{ registrationId: number; locale: "et" | "ru"; answers: FeedbackAnswers }> {
  const base = parse(feedbackPost, body);
  if (!base.ok) return base;
  const answers = checkFeedback(base.data.answers);
  return answers.ok ? { ok: true, data: { registrationId: base.data.registrationId, locale: base.data.locale, answers: answers.answers } } : { ok: false, error: answers.error };
}
export const parseFeedbackHide = (body: unknown) => parse(feedbackHide, body);
```

- [ ] **Step 7: The endpoints** (`src/server/account-api.ts`).
  1. Imports: add `parseFeedbackHide, parseFeedbackPost` to the `./account-input` import; add `import { feedbackState, hideFeedback, notifyFeedback, submitFeedback } from "./course-feedback";` and `import { FEEDBACK_TEXT_MAX } from "@/domain/protocols";`.
  2. After `const PASSWORD_CHANGES_PER_HOUR = 5;` add (`ClientSession` is the module's own type, requireClient's answer):

```ts
/** Feedback submits and "Ei soovi"s a client may send per hour, together: each submit mails Maria. */
const FEEDBACK_PER_HOUR = 10;
/** A feedback body: two free texts at their limit, JSON-escaped, and the rest. */
const FEEDBACK_BODY_CHARS = 2 * FEEDBACK_TEXT_MAX * 2 + 2048;

/** The feedback's own limit, the submits and the "Ei soovi"s together: null within it, else the 429 to answer. */
async function feedbackLimited(deps: AccountDeps, session: ClientSession): Promise<Response | null> {
  if (await withinClientLimit(deps, session.clientId, "client-feedback", FEEDBACK_PER_HOUR, 60 * 60)) return null;
  logNote("[account] feedback rate limited");
  return clientResponse(session, { ok: false, error: "rate" }, 429);
}
```

  3. After the `protocol` handler (Task 7), add:

```ts
/**
 * GET /tagasiside?id=<registration id> (phase protocols, spec §7): the feedback form of one of her registrations — its course, and whether she
 * has answered already (`sent`). 404 `{ ok: false }` when it is not hers, or the form is not open (spec §3) and she has sent nothing.
 */
async function feedbackForm(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const id = queryId(request);
  const state = id === null ? null : await feedbackState(deps.db, session.clientId, id, deps.now);
  return state ? clientResponse(session, { ok: true, ...state }) : clientResponse(session, { ok: false }, 404);
}

/**
 * POST /tagasiside `{ registrationId, locale, answers }` (spec §7): her answers, once per registration; Maria is told after the response ("Uus
 * tagasiside: …", mail and Telegram). 200 `{ ok: true }`; 400 `{ error }` (a field, a question's key, "answers" or "empty"); 404 `{ error:
 * "registration" }` (not hers, or not open); 409 `{ error: "sent" }` (answered already); 429 `{ error: "rate" }` after 10 in an hour.
 */
async function sendFeedback(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseFeedbackPost(await readObject(request, FEEDBACK_BODY_CHARS));
  if (!input.ok) return badInput(session, input.error);
  const limited = await feedbackLimited(deps, session);
  if (limited) return limited;
  const result = await submitFeedback(deps.db, { clientId: session.clientId, ...input.data }, deps.now);
  if (result.kind === "notFound") return clientResponse(session, { ok: false, error: "registration" }, 404);
  if (result.kind === "sent") return clientResponse(session, { ok: false, error: "sent" }, 409);
  const notice = result.notice;
  deps.later(() => notifyFeedback(deps.env, deps.siteUrl, notice));
  return clientResponse(session, { ok: true });
}

/**
 * POST /tagasiside/peida `{ registrationId }` ("Ei soovi", spec §7): the dashboard's card is gone for good; the form itself still takes her
 * answers later. 200 `{ ok: true }`; 404 `{ error: "registration" }` (not hers, or not open); 429 (with the submits, 10 an hour).
 */
async function dismissFeedback(request: Request, deps: AccountDeps): Promise<Response> {
  const session = await requireClient(request, deps);
  if (session instanceof Response) return session;
  const input = parseFeedbackHide(await readObject(request));
  if (!input.ok) return badInput(session, input.error);
  const limited = await feedbackLimited(deps, session);
  if (limited) return limited;
  const hidden = await hideFeedback(deps.db, { clientId: session.clientId, registrationId: input.data.registrationId }, deps.now);
  return hidden ? clientResponse(session, { ok: true }) : clientResponse(session, { ok: false, error: "registration" }, 404);
}
```

  4. In `dataRoute`, after `case "GET /protokoll": return protocol(request, deps);` add:

```ts
    case "GET /tagasiside": return feedbackForm(request, deps);
    case "POST /tagasiside": return sendFeedback(request, deps);
    case "POST /tagasiside/peida": return dismissFeedback(request, deps);
```

  5. The header comment gains, after the GET /protokoll part: "GET /tagasiside?id=, POST /tagasiside and POST /tagasiside/peida the course feedback form of one of her registrations (its state, her answers once, 'Ei soovi'),".
  6. **`tests/unit/account-guards.test.ts`**: both handler lists become `[…, "payRegistration", "protocol", "feedbackForm", "sendFeedback", "dismissFeedback", "terms", "deleteAccount"]`; the router's cases gain `"GET /tagasiside feedbackForm", "POST /tagasiside sendFeedback", "POST /tagasiside/peida dismissFeedback"` after `"GET /protokoll protocol"`.

- [ ] **Step 8: The dashboard's cards** (the server).
  1. **`src/domain/account-cards.ts`**, after `export type AccountCard = …;` add:

```ts
/** A feedback form that is open and has no answer (phase protocols, spec §7): the dashboard's "Kuidas koolitus läks?" card. */
export type FeedbackPrompt = { registrationId: number; course: CourseRef };
```

  2. **`src/server/client-data.ts`.**
     - Imports: add `courseFeedback` to the `@/db/schema` import; `FeedbackPrompt` to the `@/domain/account-cards` import; `import { feedbackOpenFor } from "@/domain/protocols";` (the form's own rule, from the same columns as `server/course-feedback.ts`).
     - In `Dashboard`, after `payOnline?: boolean;`, add:

```ts
  /** The feedback forms open for her and not answered or dismissed (phase protocols, spec §7), the latest first; absent when there is none. */
  feedback?: FeedbackPrompt[];
```

     - In `loadDashboard`'s registrations query, after `protocolSentAt: protocols.sentAt,` add `feedbackId: courseFeedback.id,`, and after `.leftJoin(protocols, …)` add `.leftJoin(courseFeedback, eq(courseFeedback.registrationId, registrations.id))`.
     - After the loop that builds the registration cards, add:

```ts
  // the feedback forms' cards (phase protocols, spec §7): a contact course's registration whose form is open and has no row yet
  const feedback: FeedbackPrompt[] = regRows
    .filter(
      (r) =>
        r.course.type === "contact" &&
        r.feedbackId === null &&
        feedbackOpenFor(r, now),
    )
    .sort((a, b) => (b.startsAt ?? b.createdAt).getTime() - (a.startsAt ?? a.createdAt).getTime() || b.id - a.id)
    .map((r) => ({ registrationId: r.id, course: { slug: r.course.slug, title: r.course.title } }));
```

     - In the returned object, after `resume: resumeSlug(sorted, lastAt, now),` add `...(feedback.length ? { feedback } : {}),`.

  Run `npx vitest run tests/db/feedback.test.ts tests/db/client-data.test.ts tests/db/account-api.test.ts tests/unit/account-guards.test.ts` — PASS.

- [ ] **Step 9: Write the failing form and card tests** `tests/unit/feedback-form-dom.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { FeedbackForm } from "@/components/account/FeedbackForm";
import { coursesTexts, feedbackTexts } from "@/components/account/texts";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The feedback form (spec §7): Maria's ten questions in the paper form's order, nothing required but one answer needed, the free texts with
// their count, the closing line; and the dashboard's card with "Ei soovi".

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const COURSE = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const form = async (locale: Locale = "et") => {
  window.history.replaceState(null, "", `${locale === "ru" ? "/ru" : ""}/konto/tagasiside#id=42`);
  await act(async () => root.render(createElement(FeedbackForm, { locale, t: feedbackTexts(getDict(locale)) })));
  await settle();
};
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the form", () => {
  test("the questions in the paper form's order; one answer at least; the answers as keys; the closing line", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: COURSE, sent: false })));
    await form();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/tagasiside?id=42");
    expect($("h1")!.textContent).toBe("Sinu kogemus MS LAB koolitusel");
    expect($$("[data-question]").map((q) => q.getAttribute("data-question"))).toEqual(["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"]);
    expect($$("[data-question='score'] input")).toHaveLength(10);
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-error]")!.textContent).toBe("Vasta vähemalt ühele küsimusele.");
    expect(posts()).toEqual([]);
    await click($("[data-question='score'] input[value='9']"));
    await click($("[data-question='expectations'] input[value='met']"));
    await act(async () => {
      const box = $("[data-question='message'] textarea") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Aitäh!");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($("[data-question='message']")!.textContent).toContain("6 / 2000");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { registrationId: 42, locale: "et", answers: { score: 9, expectations: "met", message: "Aitäh!" } }]]);
    expect($("[data-feedback-done='done']")!.textContent).toContain("Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!");
  });

  test("answered already (on load, or a second tab's submit): it says so; not open: it says so with the way back", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, course: COURSE, sent: true }));
    await form();
    expect($("[data-feedback-done='sent']")!.textContent).toContain("Tagasiside on juba saadetud. Aitäh!");
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(409, { ok: false, error: "sent" }) : json(200, { ok: true, course: COURSE, sent: false })));
    await act(async () => root.unmount());
    root = createRoot(container);
    await form();
    await click($("[data-question='score'] input[value='7']"));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-done='sent']")).not.toBeNull();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await form();
    expect($("[data-account-state='feedbackClosed']")!.textContent).toContain("Sellele koolitusele ei saa praegu tagasisidet anda.");
  });

  test("Review Focus 5: Russian: the questions, the options and the closing line in Russian", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: COURSE, sent: false })));
    await form("ru");
    expect($("h1")!.textContent).toBe("Ваш опыт обучения в MS LAB");
    expect($("[data-question='ready']")!.textContent).toContain("Скорее да, нужно немного практики");
    await click($("[data-question='safe'] input[value='very']"));
    await click($("[data-feedback-submit]"));
    expect(posts()[0][1]).toEqual({ registrationId: 42, locale: "ru", answers: { safe: "very" } });
    expect($("[data-feedback-done='done']")!.textContent).toContain("Спасибо, что вы часть начала и роста учебного центра MS LAB.");
  });
});

describe("the dashboard's card", () => {
  const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards: [
      {
        kind: "contact",
        registrationId: 7,
        course: COURSE,
        session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "", cancelled: false },
        status: "confirmed",
        paymentChoice: "full",
        priceCents: 35000,
        paidCents: 35000,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ],
    favourites: [],
    prepayment: null,
    resume: null,
    feedback: [{ registrationId: 7, course: COURSE }],
    ...over,
  });
  const render = async (data: Dashboard, readOnly = false) =>
    act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), data, readOnly, now: "2026-10-13T10:00:00.000Z" })));

  test("'Kuidas koolitus läks?' with 'Jäta tagasiside' to the form; 'Ei soovi' takes it away for good; a failure says so", async () => {
    await render(dashboard());
    const card = $("[data-feedback-card='7']")!;
    expect(card.textContent).toContain("Kuidas koolitus läks?");
    expect($("[data-feedback-open]")!.getAttribute("href")).toBe("/konto/tagasiside#id=7");
    fetchMock.mockResolvedValueOnce(json(500, { ok: false }));
    await click($("[data-feedback-dismiss]"));
    expect($("[data-feedback-card='7'] [role='alert']")!.textContent).toBe("Ei õnnestunud. Proovi uuesti.");
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click($("[data-feedback-dismiss]"));
    expect(posts().at(-1)).toEqual(["/api/konto/tagasiside/peida", { registrationId: 7 }]);
    expect($("[data-feedback-card='7']")).toBeNull();
  });

  test("none: no card; read-only (the admin's view): the buttons do nothing", async () => {
    await render(dashboard({ feedback: undefined }));
    expect($("[data-feedback-card]")).toBeNull();
    await render(dashboard(), true);
    expect($("[data-feedback-open]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-feedback-dismiss]"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

  Run `npx vitest run tests/unit/feedback-form-dom.test.ts` — FAIL (the components do not exist).

- [ ] **Step 10: The card** — create `src/components/account/FeedbackCard.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useId, useState } from "react";
import ui from "@/components/site/ui.module.css";
import type { FeedbackPrompt } from "@/domain/account-cards";
import { pick } from "@/i18n/field";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { CoursesTexts } from "./texts";
import styles from "./AccountCourseCard.module.css";

/**
 * The feedback form's card on Minu koolitused (phase protocols, spec §7), once the form opens for a registration: the course, "Kuidas koolitus
 * läks?", the one button "Jäta tagasiside" (the form, /konto/tagasiside#id=<registration>) and the text button "Ei soovi", which posts
 * /api/konto/tagasiside/peida and takes the card away for good. No reminder is ever sent. The course cards' own box and buttons. `readOnly`
 * (the admin's view): the buttons are aria-disabled and do nothing.
 */
export function FeedbackCard({ prompt, locale, t, readOnly, onDismissed }: { prompt: FeedbackPrompt; locale: Locale; t: CoursesTexts; readOnly: boolean; onDismissed(registrationId: number): void }) {
  const f = t.feedbackCard;
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function dismiss() {
    if (readOnly || busy) return;
    setBusy(true);
    setFailed(false);
    const answer = await sendJson("/api/konto/tagasiside/peida", { registrationId: prompt.registrationId });
    if (isDone(answer)) return onDismissed(prompt.registrationId);
    setFailed(true);
    setBusy(false);
  }

  return (
    <article className={styles.card} aria-labelledby={titleId} data-feedback-card={prompt.registrationId}>
      <span className={styles.tag}>{t.tag.contact}</span>
      <h2 id={titleId} className={styles.title}>
        {pick(prompt.course.title, locale)}
      </h2>
      <p className={styles.next}>{f.question}</p>
      <div className={styles.foot}>
        {readOnly ? (
          <a className={`${ui.btn} ${styles.action}`} role="link" aria-disabled="true" data-feedback-open="">
            {f.open}
          </a>
        ) : (
          <Link className={`${ui.btn} ${styles.action}`} href={`${href(locale, "/konto/tagasiside")}#id=${prompt.registrationId}`} data-feedback-open="">
            {f.open}
          </Link>
        )}
      </div>
      <div className={styles.secondRow}>
        <button type="button" className={styles.second} aria-disabled={readOnly || busy || undefined} onClick={() => void dismiss()} data-feedback-dismiss="">
          {f.dismiss}
        </button>
      </div>
      {failed && (
        <p className={styles.payError} role="alert">
          {f.dismissFailed}
        </p>
      )}
    </article>
  );
}
```

- [ ] **Step 11: On the dashboard** (`src/components/account/CoursesTab.tsx`).
  1. Add `import { FeedbackCard } from "./FeedbackCard";` after `import { ChangeRequestDialog, type ChangeRequestEnd } from "./ChangeRequestDialog";`.
  2. In `CoursesView`, after `const heading = useRef<HTMLHeadingElement>(null);` add:

```tsx
  // the feedback forms' cards (phase protocols): one dismissed here ("Ei soovi") is gone at once
  const [dismissed, setDismissed] = useState<number[]>([]);
  const prompts = (data.feedback ?? []).filter((p) => !dismissed.includes(p.registrationId));
```

  3. After `{resume && <ResumeCard … />}` add:

```tsx
          {prompts.length > 0 && (
            <ul className={styles.prompts} aria-label={t.feedbackCard.question} data-feedback-prompts="">
              {prompts.map((p) => (
                <li key={p.registrationId}>
                  <FeedbackCard prompt={p} locale={locale} t={t} readOnly={readOnly} onDismissed={(id) => setDismissed((list) => [...list, id])} />
                </li>
              ))}
            </ul>
          )}
```

  4. In `CoursesTab.module.css`, after `.chips { … }`, add:

```css
/* the feedback forms' cards (phase protocols): above the course cards, as wide as one of them */
.prompts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 16px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}
```

- [ ] **Step 12: The form.**
  1. **`src/components/account/texts.ts`**, at the end:

```ts
/** The feedback form (phase protocols): account.feedback, the way back, the two failure lines and AccountLoader's. */
export type FeedbackTexts = Dict["account"]["feedback"] & { back: string; rate: string; failed: string; loader: LoaderTexts };

export const feedbackTexts = (d: Dict): FeedbackTexts => ({
  ...d.account.feedback,
  back: d.account.shell.courses,
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
  loader: loaderTexts(d),
});
```

  2. Create `src/components/account/FeedbackForm.module.css`:

```css
/* The feedback form (phase protocols, spec §7): Maria's paper form as one column — the score as a row of number buttons, each choice as a row
   of pills (a real radio inside each, so the keyboard and a screen reader work as with any form), the free texts with their count. The
   page, its column and its title are AccountPage.module.css's (as the protocol's page). Tokens only; every target 44 px. */

.course {
  margin: -12px 0 0;
  font: 600 16px/1.4 var(--font-body);
}

.lead {
  margin: 0;
  color: var(--muted);
  font: 400 15px/1.55 var(--font-body);
}

.question {
  display: grid;
  gap: 10px;
  justify-self: stretch;
  min-width: 0;
  margin: 0;
  padding: 18px 0 0;
  border: 0;
  border-top: 1px solid var(--line);
}

.label {
  padding: 0;
  font: 600 16px/1.45 var(--font-body);
}

.scores,
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.score,
.option {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border: 1px solid var(--heather);
  background: var(--paper);
  color: var(--ink);
  cursor: pointer;
}

.score {
  width: 44px;
  border-radius: 50%;
  font: 600 15px/1 var(--font-body);
}

.option {
  padding: 10px 16px;
  border-radius: 99px;
  font: 500 14px/1.3 var(--font-body);
}

/* the radio covers its pill: a tap anywhere on it chooses it, and the focus ring is the pill's */
.score input,
.option input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.score:has(input:checked),
.option:has(input:checked) {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--paper);
}

.score:has(input:focus-visible),
.option:has(input:focus-visible) {
  outline: 2px solid var(--rose);
  outline-offset: 2px;
}

.text {
  width: 100%;
  min-height: 110px;
  padding: 12px 15px;
  border: 1px solid var(--heather);
  border-radius: 12px;
  background: var(--paper);
  color: var(--ink);
  font: 400 16px/1.5 var(--font-body);
  resize: vertical;
}

.text:focus-visible {
  outline: 2px solid var(--rose);
  outline-offset: 2px;
}

.count {
  margin: 0;
  justify-self: end;
  color: var(--muted-2);
  font: 400 12px/1.4 var(--font-body);
}

.error {
  margin: 0;
  color: var(--bad);
  font: 500 14px/1.45 var(--font-body);
}

.thanks {
  margin: 0;
  font: 400 18px/1.55 var(--font-body);
}
```

  3. Create `src/components/account/FeedbackForm.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import ui from "@/components/site/ui.module.css";
import { FEEDBACK_CHOICES, FEEDBACK_ORDER, FEEDBACK_TEXT_MAX, feedbackQuestions, isChoice, type FeedbackKey } from "@/domain/protocols";
import { pick, type I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { AccountLoader } from "./AccountLoader";
import { AccountNotFound } from "./AccountNotFound";
import type { FeedbackTexts } from "./texts";
import { useHashId } from "./useHashId";
import page from "./AccountPage.module.css";
import styles from "./FeedbackForm.module.css";

/** GET /api/konto/tagasiside's answer. */
type FormAnswer = { ok: true; course: { slug: string; title: I18n }; sent: boolean };

/**
 * The personal part of /konto/tagasiside#id=<registration> (phase protocols, spec §7; the page is a static shell): the registration from the
 * fragment, its form's state from GET /api/konto/tagasiside?id= (AccountLoader). Not hers or not open: "Sellele koolitusele ei saa praegu
 * tagasisidet anda." with the way back, as an address without an id.
 */
export function FeedbackForm({ locale, t }: { locale: Locale; t: FeedbackTexts }) {
  const id = useHashId();
  const notOpen = <AccountNotFound state="feedbackClosed" title={t.notOpen} back={t.back} locale={locale} />;
  if (id === undefined) return <div className={`${ui.wrap} ${page.wait}`} aria-busy="true" />;
  if (id === null) return notOpen;
  return (
    <AccountLoader<FormAnswer>
      key={id}
      path={`/api/konto/tagasiside?id=${id}`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      notFound={notOpen}
      render={(data) => <FeedbackBody registrationId={id} data={data} locale={locale} t={t} />}
    />
  );
}

type Answers = Partial<Record<FeedbackKey, string | number>>;

/**
 * Maria's paper form "Sinu kogemus MS LAB koolitusel" (spec §7), its ten questions in its order: the score (1–10, a row of number buttons), the
 * seven choices (a row of pills each), the two free texts (at most 2000 characters, the count under each). Nothing is required; "Saada
 * tagasiside" needs one answer. Sent: the closing line. Answered already (on load, or another tab's submit): it says so.
 */
function FeedbackBody({ registrationId, data, locale, t }: { registrationId: number; data: FormAnswer; locale: Locale; t: FeedbackTexts }) {
  const uid = useId();
  const q = feedbackQuestions(t.questions);
  const [answers, setAnswers] = useState<Answers>({});
  const [state, setState] = useState<"form" | "sending" | "done" | "sent" | "closed">(data.sent ? "sent" : "form");
  const [error, setError] = useState<string | null>(null);
  const set = (key: FeedbackKey, value: string | number) => setAnswers((a) => ({ ...a, [key]: value }));
  const given = Object.fromEntries(Object.entries(answers).filter(([, v]) => typeof v === "number" || (typeof v === "string" && v.trim() !== "")));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    if (Object.keys(given).length === 0) {
      setError(t.empty);
      return;
    }
    setState("sending");
    setError(null);
    const answer = await sendJson("/api/konto/tagasiside", { registrationId, locale, answers: given });
    if (isDone(answer)) return setState("done");
    if (answer.status === 409) return setState("sent");
    if (answer.status === 404) return setState("closed");
    setError(answer.status === 429 ? t.rate : t.failed);
    setState("form");
  }

  if (state === "done" || state === "sent" || state === "closed")
    return (
      <div className={`${ui.wrap} ${page.page}`} data-feedback-done={state}>
        <div className={page.column}>
          <h1 className={page.title}>{t.title}</h1>
          <p className={styles.thanks} role="status">
            {state === "done" ? t.thanks : state === "sent" ? t.sent : t.notOpen}
          </p>
          <Link className={ui.btnOutline} href={href(locale, "/konto")}>
            {t.back}
          </Link>
        </div>
      </div>
    );

  return (
    <form className={`${ui.wrap} ${page.page}`} onSubmit={submit} noValidate data-feedback-form="">
      <div className={page.column}>
        <h1 className={page.title}>{t.title}</h1>
        <p className={styles.course}>{pick(data.course.title, locale)}</p>
        <p className={styles.lead}>{t.lead}</p>
        {FEEDBACK_ORDER.map((key) => {
          if (key === "score")
            return (
              <fieldset key={key} className={styles.question} data-question={key}>
                <legend className={styles.label}>{q.score.label}</legend>
                <div className={styles.scores}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <label key={n} className={styles.score}>
                      <input type="radio" name={`${uid}-score`} value={n} checked={answers.score === n} onChange={() => set("score", n)} />
                      <span>{n}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          if (isChoice(key))
            return (
              <fieldset key={key} className={styles.question} data-question={key}>
                <legend className={styles.label}>{q[key].label}</legend>
                <div className={styles.options}>
                  {FEEDBACK_CHOICES[key].map((option) => (
                    <label key={option} className={styles.option}>
                      <input type="radio" name={`${uid}-${key}`} value={option} checked={answers[key] === option} onChange={() => set(key, option)} />
                      <span>{q[key].options?.[option]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          const value = typeof answers[key] === "string" ? (answers[key] as string) : "";
          return (
            <div key={key} className={styles.question} data-question={key}>
              <label htmlFor={`${uid}-${key}`} className={styles.label}>
                {q[key].label}
              </label>
              <textarea
                id={`${uid}-${key}`}
                className={styles.text}
                rows={4}
                maxLength={FEEDBACK_TEXT_MAX}
                value={value}
                onChange={(e) => set(key, e.target.value)}
                aria-describedby={`${uid}-${key}-count`}
              />
              <p id={`${uid}-${key}-count`} className={styles.count}>
                {fill(t.count, { n: value.length, max: FEEDBACK_TEXT_MAX })}
              </p>
            </div>
          );
        })}
        {error && (
          <p className={styles.error} role="alert" data-feedback-error="">
            {error}
          </p>
        )}
        <button type="submit" className={ui.btn} aria-disabled={state === "sending" || undefined} data-feedback-submit="">
          {state === "sending" ? t.sending : t.submit}
        </button>
      </div>
    </form>
  );
}
```

  4. Create `src/app/[locale]/(site)/konto/tagasiside/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { FeedbackForm } from "@/components/account/FeedbackForm";
import { feedbackTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.feedback.title} — ${d.common.siteName}` };
}

/**
 * The course feedback form (phase protocols, spec §7): /konto/tagasiside#id=<registration id>. A static shell, the same for every visitor (no
 * cookies, headers or query read here; the id is in the fragment). The browser loads the form's state from GET /api/konto/tagasiside?id= and
 * posts the answers to POST /api/konto/tagasiside (FeedbackForm).
 */
export default async function FeedbackShellPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <FeedbackForm locale={locale} t={feedbackTexts(d)} />
    </AccountShell>
  );
}
```

  5. **`src/lib/site-routing.ts`**: `STATIC_PAGES` gains `"/konto/tagasiside"` after `"/konto/protokoll"`.

- [ ] **Step 13: The routing, the gate and the caches.**
  1. **`tests/unit/site-routing.test.ts`**: add `"/konto/tagasiside"` to the pages list (after `"/konto/protokoll"`) and to the known account pages; in "accountShellTarget …" add `expect(target("/konto/tagasiside", "id=42")).toBe("/konto/tagasiside#id=42");`.
  2. **`tests/unit/site-gate.test.ts`**: `GATED` gains `"/konto/tagasiside",` after `"/konto/protokoll",` and `"/api/konto/tagasiside", "/api/konto/tagasiside/peida",` after `"/api/konto/protokoll",`.
  3. **`tests/unit/colour-tokens.test.ts`**: after `"src/components/account/ProtocolPage.module.css",` add `"src/components/account/FeedbackForm.module.css",`. **`tests/unit/old-safari.test.ts`**: `BROWSER_FILES` gains `// Task 8`, `"src/components/account/FeedbackCard.tsx"`, `"src/components/account/FeedbackForm.tsx"`.
  4. **`tests/e2e/cache.spec.ts`**: `ACCOUNT_SHELLS` gains `"/konto/tagasiside", "/ru/konto/tagasiside",` after the protocol's two; the query test's timeout becomes `test.setTimeout(480_000); // sixteen shells`; the protocol's 303 test (Task 7) loops over `["/konto/protokoll", "/ru/konto/protokoll", "/konto/tagasiside", "/ru/konto/tagasiside"]`, and its API check runs for `/api/konto/protokoll?id=42` and `/api/konto/tagasiside?id=42` alike (401, `private, no-store`, never cached).
  5. **`tests/e2e/gate.spec.ts`**: add `"/konto/tagasiside"` after `"/konto/protokoll"` in the coming-soon list, and the API loop becomes `for (const path of ["/api/konto/me", "/api/konto/protokoll?id=1", "/api/konto/tagasiside?id=1", "/api/feedback"])`.

- [ ] **Step 14: Run** `npx vitest run tests/unit/feedback-form-dom.test.ts tests/db/feedback.test.ts tests/unit/feedback-messages.test.ts tests/unit/protocols.test.ts tests/unit/site-routing.test.ts tests/unit/site-gate.test.ts tests/unit/colour-tokens.test.ts tests/unit/old-safari.test.ts tests/unit/account-dashboard-dom.test.ts tests/unit/account-readonly.test.ts` — expect PASS.

- [ ] **Step 15: Run everything.**
  - `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`.
  - `npm run build`: `/[locale]/konto/tagasiside` prerendered (● / ○), never ƒ.
  - `E2E_PROD_BUILD=1 npx playwright test cache account-dashboard`; `npx playwright test -c playwright.gate.config.ts`.

- [ ] **Step 16: Commit.**

```bash
git add app/src/i18n/dict/et.ts app/src/i18n/dict/ru.ts app/src/server/course-feedback.ts app/src/server/messages.ts app/src/server/account-input.ts app/src/server/account-api.ts app/src/domain/account-cards.ts app/src/server/client-data.ts app/src/components/account "app/src/app/[locale]/(site)/konto/tagasiside" app/src/lib/site-routing.ts app/tests
git commit -m "feat(account): the course feedback form — Maria's paper form online, its card with Ei soovi, one answer per registration, Maria told

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Maria's "Tagasiside" — the page after "Maksed", the numbers per course, the answers in both drawers

Spec section 7 ("Maria's view"). Read-only: Maria reads the answers; nothing here changes them.

**What the spec leaves open, and the plan's choice.** "Per course: the average score, and the count for each option of each choice question" is shown in two steps, so the page stays one screen long: without a filter a small table names every course that has answers, with its count and average (each a link to the filter); with a course chosen (`?koolitus=<id>`), its card shows the average, the number of scores and every option of the seven choice questions with its count, in Maria's wording. The list of answers (newest first, 50 a page) is under it in both cases; a row's name opens its answers in the drawer (`?id=<feedback id>`), as on Registreerimised. "Ei soovi" is not an answer: those rows are never listed or counted.

**The stats read every answered row** (`feedbackStats`): a few hundred a year at most, so one query and a sum in TypeScript, not SQL aggregates per option.

**Files:**
- Modify: `app/src/db/queries/protocols.ts` (`FeedbackRow`, `pageFeedback`, `feedbackById`, `feedbackOf`, `CourseFeedbackStats`, `feedbackStats`)
- Create: `app/src/app/admin/(panel)/tagasiside/page.tsx`, `app/src/app/admin/(panel)/tagasiside/feedback.module.css`
- Create: `app/src/components/admin/FeedbackAnswers.tsx`, `app/src/components/admin/FeedbackAnswers.module.css`
- Modify: `app/src/components/admin/sections.ts`, `app/src/components/admin/AdminIcon.tsx` (`chat`), `app/src/i18n/dict/admin.ts` (`nav.feedback`, `feedback`)
- Modify: `app/src/server/admin-clients.ts` (`ClientDetail.feedback`), `app/src/components/admin/ClientDrawer.tsx`
- Modify: `app/src/app/admin/(panel)/registreerimised/page.tsx` (+ `registrations.module.css`)
- Modify: `app/tests/unit/admin.test.ts`, `app/tests/unit/admin-guards.test.ts`, `app/tests/unit/colour-tokens.test.ts`, `app/tests/e2e/admin-inbox.spec.ts`, `app/tests/e2e/admin-load.spec.ts`
- Test: `app/tests/db/feedback-admin.test.ts`, `app/tests/db/feedback-admin-pages.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `courseFeedback`, `FEEDBACK_CHOICES`, `FEEDBACK_ORDER`, `answerText`, `feedbackQuestions`, `summarizeFeedback`, `FeedbackSummary`, `FeedbackAnswers`, `ChoiceKey`; (Task 8) `et.account.feedback.questions`; `paged`, `Paged` (`db/queries/admin.ts`), `PAGE_SIZE`, `parsePage`, `parseRowId`, `Pager`, `Drawer`, `Shell`.
- Produces, from `src/db/queries/protocols.ts`: `type FeedbackRow = { id: number; registrationId: number; clientId: number | null; name: string; email: string; course: { id: number; title: I18n }; startsAt: Date | null; answers: FeedbackAnswers; locale: "et" | "ru"; submittedAt: Date }`; `pageFeedback(db: Db, courseId: number | null, page: number, size?: number): Promise<Paged<FeedbackRow>>`; `feedbackById(db: Db, id: number): Promise<FeedbackRow | null>`; `feedbackOf(db: Db, of: { registrationId: number } | { clientId: number }): Promise<FeedbackRow[]>`; `type CourseFeedbackStats = { course: { id: number; title: I18n }; summary: FeedbackSummary }`; `feedbackStats(db: Db): Promise<CourseFeedbackStats[]>` (by the course's Estonian title).
- Produces: `FeedbackAnswers({ answers, locale, submittedAt })` (`[data-feedback-answers]`, `[data-answer=<key>]`), `formatScore(n: number): string` ("7,5"); `Section` gains `"feedback"` (`/admin/tagasiside`, icon `chat`); `ClientDetail.feedback: FeedbackRow[]`; the page's `[data-feedback-row=<id>]`, `[data-feedback-courses]`, `[data-feedback-course=<id>]`, `[data-feedback-summary=<course id>]`, `[data-feedback-counts=<key>]`, `[data-feedback-average]`, `[data-feedback-detail=<id>]`; the drawers' `[data-registration-feedback]`, `[data-client-feedback]`.

- [ ] **Step 1: Write the failing query tests** `tests/db/feedback-admin.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { feedbackById, feedbackOf, feedbackStats, pageFeedback } from "@/db/queries/protocols";
import { clients, courseFeedback, registrations } from "@/db/schema";
import type { FeedbackAnswers } from "@/domain/protocols";
import { clientDetail } from "@/server/admin-clients";
import { COURSE_DAY, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// Maria's "Tagasiside" (spec §7): the answers newest first with the course filter, the numbers per course, one answer by its id, and the
// answers of one registration or one student for the drawers. "Ei soovi" is never an answer.

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
});

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
async function answered(registrationId: number, answers: FeedbackAnswers, day: number, locale: "et" | "ru" = "et") {
  const [row] = await db.insert(courseFeedback).values({ registrationId, answers, locale, submittedAt: at(day), createdAt: at(day) }).returning();
  return row;
}

/** Two courses; Mari and Anu answered the first (Anu in Russian), Tiina the second; Liis pressed "Ei soovi". */
async function setup() {
  const { course, session } = await protocolCourse(db);
  const { course: other, session: otherSession } = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
  const mari = await student(db, course, session, "Mari Maasikas");
  const anu = await student(db, course, session, "Anu Aas");
  const tiina = await student(db, other, otherSession, "Tiina Tamm");
  const liis = await student(db, course, session, "Liis Lepp");
  const a = await answered(mari.id, { score: 9, expectations: "met", message: "Aitäh!" }, 13);
  const b = await answered(anu.id, { score: 6, expectations: "exceeded", ready: "mostly" }, 14, "ru");
  const c = await answered(tiina.id, { clarity: "very_clear" }, 15);
  const [dismissed] = await db.insert(courseFeedback).values({ registrationId: liis.id, dismissedAt: at(13), createdAt: at(13) }).returning();
  return { course, other, mari, anu, tiina, liis, a, b, c, dismissed };
}

describe("the Tagasiside page's reads", () => {
  test("the answers newest first, a page at a time (here 2); 'Ei soovi' is no answer; the course filter", async () => {
    const { course, a, b, c } = await setup();
    const all = await pageFeedback(db, null, 1, 2);
    expect([all.total, all.pages, all.rows.map((r) => r.id)]).toEqual([3, 2, [c.id, b.id]]);
    expect((await pageFeedback(db, null, 2, 2)).rows.map((r) => r.id)).toEqual([a.id]);
    const one = await pageFeedback(db, course.id, 1);
    expect(one.rows.map((r) => [r.name, r.answers.score, r.locale])).toEqual([
      ["Anu Aas", 6, "ru"],
      ["Mari Maasikas", 9, "et"],
    ]);
    expect(one.rows[1]).toEqual({
      id: a.id,
      registrationId: a.registrationId,
      clientId: null,
      name: "Mari Maasikas",
      email: "marimaasikas@example.com",
      course: { id: course.id, title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
      startsAt: COURSE_DAY,
      answers: { score: 9, expectations: "met", message: "Aitäh!" },
      locale: "et",
      submittedAt: at(13),
    });
  });

  test("per course, by its title: the answers, the scores, the average to one decimal, every option of every choice question counted", async () => {
    const { course, other } = await setup();
    const stats = await feedbackStats(db);
    expect(stats.map((s) => [s.course.id, s.summary.count, s.summary.scored, s.summary.average])).toEqual([
      [course.id, 2, 2, 7.5],
      [other.id, 1, 0, null],
    ]);
    expect(stats[0].summary.options.expectations).toEqual({ exceeded: 1, met: 1, not_met: 0 });
    expect(stats[0].summary.options.ready).toEqual({ fully: 0, mostly: 1, rather_not: 0, no: 0 });
    expect(stats[1].summary.options.clarity).toEqual({ very_clear: 1, fairly_clear: 0, needs_work: 0 });
    expect(await feedbackStats(await makeTestDb())).toEqual([]);
  });

  test("one answer by its id; a dismissed row or an unknown id is none", async () => {
    const { a, dismissed } = await setup();
    expect(await feedbackById(db, a.id)).toMatchObject({ id: a.id, name: "Mari Maasikas" });
    expect(await feedbackById(db, dismissed.id)).toBeNull();
    expect(await feedbackById(db, 999)).toBeNull();
  });

  test("the drawers: a registration's answer; a student's, through her registrations, newest first", async () => {
    const { mari, anu, liis, a, b } = await setup();
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
    for (const r of [mari, anu]) await db.update(registrations).set({ clientId: kati.id }).where(eq(registrations.id, r.id));
    expect((await feedbackOf(db, { registrationId: mari.id })).map((f) => f.id)).toEqual([a.id]);
    expect(await feedbackOf(db, { registrationId: liis.id })).toEqual([]);
    expect((await feedbackOf(db, { clientId: kati.id })).map((f) => [f.id, f.clientId])).toEqual([
      [b.id, kati.id],
      [a.id, kati.id],
    ]);
    expect((await clientDetail(db, kati.id))!.feedback.map((f) => f.id)).toEqual([b.id, a.id]);
  });
});
```

  Run `npx vitest run tests/db/feedback-admin.test.ts` — FAIL (the reads do not exist).

- [ ] **Step 2: The reads** — in `src/db/queries/protocols.ts`:
  1. The `drizzle-orm` import becomes `import { and, asc, count, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";` (Tasks 5 and 7 left it at `and, asc, eq, gte, isNotNull, lt, sql`); the schema import gains `courseFeedback`; the domain import gains `summarizeFeedback`, `type FeedbackAnswers`, `type FeedbackSummary`; add `import { PAGE_SIZE } from "@/domain/paging";` and `import { paged, type Paged } from "./admin";`.
  2. Append:

```ts
// ---------- the admin's Tagasiside and the drawers (Task 9) ----------

/** One answered feedback form, for Maria (spec §7): who, which course and day, the answers as keys, the language she answered in, when. */
export type FeedbackRow = {
  id: number;
  registrationId: number;
  clientId: number | null;
  name: string;
  email: string;
  course: { id: number; title: I18n };
  startsAt: Date | null;
  answers: FeedbackAnswers;
  locale: "et" | "ru";
  submittedAt: Date;
};

/** An answer, not an "Ei soovi" (that row has no submitted_at). */
const ANSWERED = isNotNull(courseFeedback.submittedAt);

function feedbackRows(db: Db) {
  return db
    .select({
      id: courseFeedback.id,
      registrationId: courseFeedback.registrationId,
      clientId: registrations.clientId,
      name: registrations.name,
      email: registrations.email,
      courseId: courses.id,
      courseTitle: courses.title,
      startsAt: courseSessions.startsAt,
      answers: courseFeedback.answers,
      locale: courseFeedback.locale,
      submittedAt: courseFeedback.submittedAt,
    })
    .from(courseFeedback)
    .innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id));
}

type FeedbackSelect = Awaited<ReturnType<typeof feedbackRows>>[number];

// (answers, locale and submitted_at are set together by the submit, server/course-feedback.ts; every read here has ANSWERED)
const toFeedbackRow = (r: FeedbackSelect): FeedbackRow => ({
  id: r.id,
  registrationId: r.registrationId,
  clientId: r.clientId,
  name: r.name,
  email: r.email,
  course: { id: r.courseId, title: r.courseTitle },
  startsAt: r.startsAt,
  answers: r.answers ?? {},
  locale: r.locale === "ru" ? "ru" : "et",
  submittedAt: r.submittedAt!,
});

const NEWEST = [desc(courseFeedback.submittedAt), desc(courseFeedback.id)] as const;

/** Tagasiside's list: the answers, newest first, `size` a page; `courseId` keeps one course's. */
export async function pageFeedback(db: Db, courseId: number | null, page: number, size: number = PAGE_SIZE): Promise<Paged<FeedbackRow>> {
  const where = courseId === null ? ANSWERED : and(ANSWERED, eq(registrations.courseId, courseId));
  return paged(
    page,
    size,
    async () => Number((await db.select({ n: count() }).from(courseFeedback).innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id)).where(where))[0].n),
    async (range) => (await feedbackRows(db).where(where).orderBy(...NEWEST).limit(range.limit).offset(range.offset)).map(toFeedbackRow),
  );
}

/** One answer (the page's drawer, ?id=); null when there is none, or it is an "Ei soovi". */
export async function feedbackById(db: Db, id: number): Promise<FeedbackRow | null> {
  const [row] = await feedbackRows(db).where(and(ANSWERED, eq(courseFeedback.id, id))).limit(1);
  return row ? toFeedbackRow(row) : null;
}

/** The answers in a registration's drawer (at most one), or in a student's (those of her registrations), newest first. */
export async function feedbackOf(db: Db, of: { registrationId: number } | { clientId: number }): Promise<FeedbackRow[]> {
  const whose = "registrationId" in of ? eq(courseFeedback.registrationId, of.registrationId) : eq(registrations.clientId, of.clientId);
  return (await feedbackRows(db).where(and(ANSWERED, whose)).orderBy(...NEWEST)).map(toFeedbackRow);
}

/** A course's answers in numbers (domain/protocols.ts summarizeFeedback). */
export type CourseFeedbackStats = { course: { id: number; title: I18n }; summary: FeedbackSummary };

/**
 * Every course that has answers, by its Estonian title, with its numbers: the average score and the count of every option of every choice
 * question (spec §7). All the answered rows are read (a few hundred a year) and summed here.
 */
export async function feedbackStats(db: Db): Promise<CourseFeedbackStats[]> {
  const rows = await db
    .select({ courseId: courses.id, title: courses.title, answers: courseFeedback.answers })
    .from(courseFeedback)
    .innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .where(ANSWERED);
  const byCourse = new Map<number, { title: I18n; answers: FeedbackAnswers[] }>();
  for (const r of rows) {
    const entry = byCourse.get(r.courseId) ?? { title: r.title, answers: [] };
    entry.answers.push(r.answers ?? {});
    byCourse.set(r.courseId, entry);
  }
  return [...byCourse]
    .map(([id, { title, answers }]) => ({ course: { id, title }, summary: summarizeFeedback(answers) }))
    .sort((x, y) => x.course.title.et.localeCompare(y.course.title.et, "et") || x.course.id - y.course.id);
}
```

  3. **`src/server/admin-clients.ts`.** Add `import { feedbackOf, type FeedbackRow } from "@/db/queries/protocols";` after the `@/db/queries/payments` import. In `ClientDetail`, after `payments: PaymentRow[];`, add:

```ts
  /** Her answers to the course feedback form (phase protocols, spec §7), newest first. */
  feedback: FeedbackRow[];
```

     In `clientDetail`, the `Promise.all` gains `feedbackOf(db, { clientId: id })` after `listPaymentsOf(db, { clientId: id })` (its destructuring: `const [[client], regs, reqs, access, terms, payments, feedback] = …`), and the returned object gains `feedback,` after `payments,`.

  Run `npx vitest run tests/db/feedback-admin.test.ts tests/db/admin-clients.test.ts` — PASS.

- [ ] **Step 3: The admin's words** (`src/i18n/dict/admin.ts`).
  1. In `nav`, after `payments: "Maksed",` add `feedback: "Tagasiside",`.
  2. After the `protocols` section (Task 5), add:

```ts
  // Tagasiside (phase protocols, spec §7): the answers to the course feedback form. /admin/tagasiside, ?koolitus=<course id> (the filter),
  // ?leht=<n>, ?id=<answer> (the drawer). The questions and options are the form's own words (et.ts account.feedback), never written here.
  // {n} a count, {score} an average ("7,5"), {date} a day and a time.
  feedback: {
    eyebrow: "Õpilased",
    title: "Tagasiside",
    lead: "Õpilaste vastused koolituse tagasiside vormile, uuemad eespool. Vali koolitus, et näha selle keskmist hinnet ja iga vastusevariandi arvu.",
    filterLabel: "Koolitus",
    all: "Kõik koolitused",
    byCourse: "Koolituste kaupa",
    count: "Vastuseid: {n}",
    scored: "Hindeid: {n}",
    average: "Keskmine hinne: {score} / 10",
    noScore: "Hinnet pole antud",
    empty: "Tagasisidet pole veel antud.",
    emptyFiltered: "Selle koolituse kohta pole tagasisidet.",
    col: { date: "Kuupäev", student: "Õpilane", course: "Koolitus", score: "Hinne", answers: "Vastuseid", average: "Keskmine hinne" },
    drawer: { label: "Tagasiside: {name}", close: "Sulge", notFound: "Seda tagasisidet ei leitud." },
    submitted: "Saadetud {date}",
    inRussian: "Vastas vene keeles",
    toStudent: "Õpilase juurde",
    toRegistration: "Registreeringu juurde",
    // the Õpilased and Registreerimised drawers
    section: "Tagasiside",
    none: "Tagasisidet pole antud.",
  },
```

- [ ] **Step 4: The menu.**
  1. **`src/components/admin/AdminIcon.tsx`**: in `PATHS`, after `card: […],` add:

```ts
  chat: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M8 9.5h8M8 12.5h5"],
```

  2. **`src/components/admin/sections.ts`**: the `Section` union gains `| "feedback"` after `| "payments"`; in `SECTIONS`, after the `payments` entry, add `{ key: "feedback", href: "/admin/tagasiside", icon: "chat" },`. The comment above `Section` gains "; Tagasiside: phase protocols, after Maksed".
  3. **`tests/unit/admin.test.ts`**: in "the sections in Maria's order", `"Tagasiside",` after `"Maksed",`.
  4. **`tests/e2e/admin-inbox.spec.ts`**: `MENU` gains `"Tagasiside"` after `"Maksed"`.
  5. **`tests/unit/admin-guards.test.ts`**: in the first test's page list, `"tagasiside"` after `"protokollid"` (Task 5).
  6. **`tests/e2e/admin-load.spec.ts`**: `ADMIN_PAGES` gains `"/admin/tagasiside",` after `"/admin/seaded",`.

  Run `npx vitest run tests/unit/admin.test.ts tests/unit/admin-guards.test.ts` — FAIL only on the missing page (`app/admin/(panel)/tagasiside/page.tsx`); the menu order passes.

- [ ] **Step 5: Write the failing page tests** `tests/db/feedback-admin-pages.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseFeedback, registrations, type Course, type CourseFeedback, type Registration } from "@/db/schema";
import { makeTestDb } from "./helpers";
import { protocolCourse, student } from "./protocols-fixtures";

// Maria's Tagasiside page and the answers in the registration's and the student's drawers, rendered from a real (PGlite) database to HTML:
// the questions and options in her own wording whatever language the student answered in, the average with a decimal comma, the counts per
// option. The shell, the drawer's dialog and the server actions are stand-ins (they need a browser or a request), as on Maksed's test.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/data", () => ({ getAdminCounts: async () => ({}) }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children), useUnsavedInDrawer: () => {} };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), saveRegistrationPayment: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-clients", () => ({ addStudent: vi.fn(), grantCourseAccess: vi.fn(), revokeCourseAccess: vi.fn(), unlockNextLesson: vi.fn() }));

import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";
import FeedbackPage from "@/app/admin/(panel)/tagasiside/page";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { clientDetail } from "@/server/admin-clients";

const render = async (page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }));
const rowIds = (html: string) => [...html.matchAll(/data-feedback-row="(\d+)"/g)].map((m) => Number(m[1]));
/** The HTML from `marker` to the next element carrying the same attribute (or the end). */
const part = (html: string, attribute: string, value: string | number) => {
  const from = html.indexOf(`${attribute}="${value}"`);
  expect(from, `${attribute}=${value}`).toBeGreaterThan(-1);
  const next = html.indexOf(`${attribute}="`, from + 1);
  return html.slice(from, next === -1 ? undefined : next);
};
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

let db: Db;
let course: Course;
let mari: Registration, anu: Registration, liis: Registration;
let a: CourseFeedback, b: CourseFeedback, c: CourseFeedback;
let kati: number;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
  const first = await protocolCourse(db);
  course = first.course;
  const second = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
  const [client] = await db.insert(clients).values({ email: "marimaasikas@example.com", name: "Mari Maasikas" }).returning();
  kati = client.id;
  mari = await student(db, course, first.session, "Mari Maasikas", { clientId: kati });
  anu = await student(db, course, first.session, "Anu Aas");
  liis = await student(db, course, first.session, "Liis Lepp");
  const tiina = await student(db, second.course, second.session, "Tiina Tamm");
  const answer = async (registrationId: number, answers: CourseFeedback["answers"], day: number, locale: "et" | "ru" = "et") =>
    (await db.insert(courseFeedback).values({ registrationId, answers, locale, submittedAt: at(day), createdAt: at(day) }).returning())[0];
  a = await answer(mari.id, { score: 9, expectations: "met", message: "Aitäh!\nVäga hea päev." }, 13);
  b = await answer(anu.id, { score: 6, expectations: "exceeded", ready: "mostly", recommend: "Да, всем советую" }, 14, "ru");
  c = await answer(tiina.id, { clarity: "very_clear" }, 15);
  await db.insert(courseFeedback).values({ registrationId: liis.id, dismissedAt: at(13), createdAt: at(13) });
});

test("the list: newest first with each score; every course with its answers and average (a decimal comma); a name opens the answers", async () => {
  const html = await render(FeedbackPage);
  expect(html).toContain('data-shell-active="feedback"');
  expect(rowIds(html)).toEqual([c.id, b.id, a.id]);
  expect(html).toContain("Vastuseid: 3");
  expect(part(html, "data-feedback-row", a.id)).toContain(`href="/admin/tagasiside?id=${a.id}"`);
  expect(part(html, "data-feedback-row", a.id)).toContain("9/10");
  expect(part(html, "data-feedback-course", course.id)).toContain("7,5 / 10");
  expect(html).toContain(`href="/admin/tagasiside?koolitus=${course.id}"`);
  expect(html).not.toContain("data-feedback-summary");
});

test("a course: its average and scores, every option counted in Maria's wording; only its answers listed", async () => {
  const html = await render(FeedbackPage, { koolitus: String(course.id) });
  expect(html).toContain(`data-feedback-summary="${course.id}"`);
  expect(html).toContain("Keskmine hinne: 7,5 / 10");
  expect(html).toContain("Hindeid: 2");
  const expectations = part(html, "data-feedback-counts", "expectations");
  expect(expectations).toContain("Kas koolitus vastas sinu ootustele?");
  for (const [label, n] of [["Ületas ootusi", 1], ["Vastas ootustele", 1], ["Ei vastanud ootustele", 0]] as const) expect(expectations).toMatch(new RegExp(`${label}</span><strong>${n}</strong>`));
  expect(rowIds(html)).toEqual([b.id, a.id]);
  expect(html).toMatch(new RegExp(`href="/admin/tagasiside\\?koolitus=${course.id}"[^>]*aria-current="true"`));
  expect(await render(FeedbackPage, { koolitus: "999" })).toContain("Selle koolituse kohta pole tagasisidet.");
});

test("?id=: a Russian answer in Maria's wording with its language said, the free text as written; the way to the registration", async () => {
  const html = await render(FeedbackPage, { id: String(b.id) });
  const detail = part(html, "data-feedback-detail", b.id);
  for (const text of ["Anu Aas", "Kas koolitus vastas sinu ootustele?", "Ületas ootusi", "Pigem jah, natuke harjutamist vajab", "Да, всем советую", "Vastas vene keeles", "Saadetud 14.10.2026"])
    expect(detail, text).toContain(text);
  expect(detail).toContain(`href="/admin/registreerimised?id=${anu.id}"`);
  expect(detail).not.toContain("/admin/opilased"); // Anu has no account
  expect(part(await render(FeedbackPage, { id: String(a.id) }), "data-feedback-detail", a.id)).toContain(`href="/admin/opilased?id=${kati}"`);
  expect(await render(FeedbackPage, { id: "999" })).toContain("Seda tagasisidet ei leitud.");
});

test("the drawers: the registration's answers (none for 'Ei soovi'); the student's, with the course", async () => {
  const reg = await render(RegistrationsPage, { id: String(mari.id) });
  expect(part(reg, "data-registration-detail", mari.id)).toContain("data-registration-feedback");
  expect(reg).toContain("Aitäh!\nVäga hea päev.");
  expect(await render(RegistrationsPage, { id: String(liis.id) })).not.toContain("data-registration-feedback");
  const html = renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }));
  const section = html.slice(html.indexOf("data-client-feedback"));
  for (const text of ["Tagasiside", "Kulmude lamineerimine", "Vastas ootustele", "9/10"]) expect(section, text).toContain(text);
  await db.update(registrations).set({ clientId: null }).where(eq(registrations.id, mari.id));
  expect(renderToStaticMarkup(ClientDetailView({ detail: (await clientDetail(db, kati))!, ecourses: [], now: at(20) }))).toContain("Tagasisidet pole antud.");
});
```

  Run `npx vitest run tests/db/feedback-admin-pages.test.ts` — FAIL (the page does not exist).

- [ ] **Step 6: The answers' component.**
  1. Create `src/components/admin/FeedbackAnswers.module.css`:

```css
/* One student's feedback (phase protocols): each answered question in Maria's wording with the answer under it, then when it was sent.
   Tokens only. */

.answers {
  display: grid;
  gap: 12px;
}

.list {
  display: grid;
  gap: 14px;
  margin: 0;
}

.list > div {
  display: grid;
  gap: 3px;
}

.list dt {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.4;
}

.list dd {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

/* the two free texts: as she wrote them, with her line breaks */
.list dd.text {
  font-weight: 400;
  white-space: pre-wrap;
}

.meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
```

  2. Create `src/components/admin/FeedbackAnswers.tsx`:

```tsx
import { answerText, FEEDBACK_ORDER, FEEDBACK_TEXTS, feedbackQuestions, type FeedbackAnswers as Answers } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { fill, formatDate, formatTime } from "@/i18n/format";
import styles from "./FeedbackAnswers.module.css";

// The form's questions in Maria's own wording: its Estonian texts, the one place they are written (et.ts account.feedback).
const QUESTIONS = feedbackQuestions(et.account.feedback.questions);
const FREE: ReadonlySet<string> = new Set(FEEDBACK_TEXTS);

/** An average score as Maria reads it: one decimal, a comma ("7,5"). */
export const formatScore = (n: number): string => new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);

/**
 * One student's answers (phase protocols, spec §7) in the paper form's order and Maria's wording, whatever language she answered in; a
 * question she left out is not shown; a free text as she wrote it. Under them, when it was sent and "Vastas vene keeles" for a Russian answer.
 * The Tagasiside page's drawer and the Õpilased and Registreerimised drawers.
 */
export function FeedbackAnswers({ answers, locale, submittedAt }: { answers: Answers; locale: "et" | "ru"; submittedAt: Date }) {
  const t = adminEt.feedback;
  return (
    <div className={styles.answers} data-feedback-answers="">
      <dl className={styles.list}>
        {FEEDBACK_ORDER.map((key) => {
          const value = answers[key];
          if (value === undefined) return null;
          return (
            <div key={key} data-answer={key}>
              <dt>{QUESTIONS[key].label}</dt>
              <dd className={FREE.has(key) ? styles.text : undefined}>{answerText(key, value, QUESTIONS)}</dd>
            </div>
          );
        })}
      </dl>
      <p className={styles.meta}>
        {fill(t.submitted, { date: `${formatDate(submittedAt, "et")} ${formatTime(submittedAt, "et")}` })}
        {locale === "ru" && ` · ${t.inRussian}`}
      </p>
    </div>
  );
}
```

- [ ] **Step 7: The page.**
  1. Create `src/app/admin/(panel)/tagasiside/feedback.module.css`:

```css
/* Tagasiside (phase protocols): a course's numbers, the courses' small table and the answers' list (the shared admin list,
   components/admin/list-table.module.css), and the drawer's head. Tokens only. */

.block {
  margin-bottom: 25px;
}

.count {
  margin-bottom: 6px;
}

.sub {
  display: block;
  font-size: 12px;
}

.numbers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 8px 0 20px;
  font-size: 14px;
}

.questions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  gap: 20px 28px;
}

.question {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.counts {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.counts li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}

.counts li:last-child {
  border-bottom: 0;
}

.detail {
  display: grid;
  gap: 22px;
}

/* room for the drawer's close button at the top right */
.detailHead {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding-right: 56px;
}

.detailHead h2 {
  overflow-wrap: anywhere;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 0;
}

/* the course's day next to its title once the row is a block (the shared list's narrow card) */
@container (max-width: 980px) {
  .sub {
    display: inline;
    margin-left: 6px;
  }
}
```

  2. Create `src/app/admin/(panel)/tagasiside/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { Drawer } from "@/components/admin/Drawer";
import { FeedbackAnswers, formatScore } from "@/components/admin/FeedbackAnswers";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { feedbackById, feedbackStats, pageFeedback, type CourseFeedbackStats, type FeedbackRow } from "@/db/queries/protocols";
import { parsePage } from "@/domain/paging";
import { FEEDBACK_CHOICES, feedbackQuestions, type ChoiceKey } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import styles from "./feedback.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.feedback) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses: ?koolitus=<course id> (the filter), ?leht=<n> (50 a page), ?id=<answer> (the drawer). A new filter starts at page 1; the drawer
// keeps the page it was opened from.
type View = { koolitus: number | null; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function parse(sp: Search): View & { id: number | null } {
  return { koolitus: parseRowId(one(sp.koolitus)), leht: parsePage(sp.leht), id: parseRowId(one(sp.id)) };
}

function href(view: View, id?: number): string {
  const q = new URLSearchParams();
  if (view.koolitus) q.set("koolitus", String(view.koolitus));
  if (view.leht > 1) q.set("leht", String(view.leht));
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/tagasiside${s ? `?${s}` : ""}`;
}

// The form's questions in Maria's wording (et.ts account.feedback): the counts are labelled with them.
const QUESTIONS = feedbackQuestions(et.account.feedback.questions);
const CHOICE_KEYS = Object.keys(FEEDBACK_CHOICES) as ChoiceKey[];

/**
 * Tagasiside (phase protocols, spec §7): the students' answers to the course feedback form, newest first, 50 a page, with the course filter.
 * Without a filter, every course that has answers with its count and average (a link to the filter); with one, its numbers: the average
 * score and every option of the seven choice questions with its count. A row's name opens its answers (the drawer, ?id=). Read-only.
 */
export default async function FeedbackPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list, stats, open] = await Promise.all([pageFeedback(db, view.koolitus, view.leht), feedbackStats(db), view.id ? feedbackById(db, view.id) : null, getAdminCounts()]);
  const t = adminEt.feedback;
  const chosen = view.koolitus === null ? null : (stats.find((s) => s.course.id === view.koolitus) ?? null);
  const filters: { key: number | null; label: string }[] = [{ key: null, label: t.all }, ...stats.map((s) => ({ key: s.course.id, label: pick(s.course.title, "et") }))];

  return (
    <Shell email={email} active="feedback">
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
        </div>

        {stats.length > 0 && (
          <nav className={ui.filters} aria-label={t.filterLabel} data-feedback-filter="">
            {filters.map((f) => (
              <Link key={f.key ?? 0} className={ui.pill} href={href({ koolitus: f.key, leht: 1 })} aria-current={view.koolitus === f.key ? "true" : undefined}>
                {f.label}
              </Link>
            ))}
          </nav>
        )}

        {view.koolitus === null && stats.length > 0 && <CourseTable stats={stats} />}
        {chosen && <CourseNumbers stats={chosen} />}

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {list.rows.length === 0 ? (
            <p className={ui.empty}>{view.koolitus ? t.emptyFiltered : t.empty}</p>
          ) : (
            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.date}</th>
                  <th scope="col">{t.col.student}</th>
                  <th scope="col">{t.col.course}</th>
                  <th scope="col">{t.col.score}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((f) => (
                  <tr key={f.id} data-feedback-row={f.id}>
                    <td data-label={t.col.date} className={ui.nowrap}>
                      {formatDate(f.submittedAt, "et")}
                    </td>
                    <td data-label={t.col.student}>
                      <div className={listTable.who}>
                        <Link id={`feedback-${f.id}`} className={listTable.name} href={href(view, f.id)}>
                          {f.name}
                        </Link>
                      </div>
                    </td>
                    <td data-label={t.col.course}>
                      {pick(f.course.title, "et")}
                      {f.startsAt && <span className={`${ui.muted} ${styles.sub}`}>{formatDate(f.startsAt, "et")}</span>}
                    </td>
                    <td data-label={t.col.score} className={ui.nowrap}>
                      {f.answers.score === undefined ? adminEt.common.none : `${f.answers.score}/10`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>

      {view.id !== null && (
        <Drawer label={open ? fill(t.drawer.label, { name: open.name }) : t.drawer.notFound} closeHref={href(view)} closeLabel={t.drawer.close} returnFocus={open ? `feedback-${open.id}` : undefined}>
          {open ? <FeedbackDetail f={open} /> : <p className={ui.empty}>{t.drawer.notFound}</p>}
        </Drawer>
      )}
    </Shell>
  );
}

const averageText = (average: number | null) => (average === null ? adminEt.feedback.noScore : `${formatScore(average)} / 10`);

/** Every course with answers: how many, and the average score; the course's name filters the page to it. */
function CourseTable({ stats }: { stats: CourseFeedbackStats[] }) {
  const t = adminEt.feedback;
  return (
    <section className={`${ui.card} ${listTable.card} ${styles.block}`} aria-labelledby="feedback-courses" data-feedback-courses="">
      <h2 id="feedback-courses" className={ui.h2}>
        {t.byCourse}
      </h2>
      <table className={`${ui.table} ${listTable.table}`}>
        <thead>
          <tr>
            <th scope="col">{t.col.course}</th>
            <th scope="col">{t.col.answers}</th>
            <th scope="col">{t.col.average}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.course.id} data-feedback-course={s.course.id}>
              <td data-label={t.col.course}>
                <Link className={ui.link} href={href({ koolitus: s.course.id, leht: 1 })}>
                  {pick(s.course.title, "et")}
                </Link>
              </td>
              <td data-label={t.col.answers}>{s.summary.count}</td>
              <td data-label={t.col.average} className={ui.nowrap}>
                {averageText(s.summary.average)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One course's numbers (spec §7): the answers, the scores and their average, and every option of every choice question with its count. */
function CourseNumbers({ stats }: { stats: CourseFeedbackStats }) {
  const t = adminEt.feedback;
  const s = stats.summary;
  return (
    <section className={`${ui.card} ${styles.block}`} aria-labelledby="feedback-summary" data-feedback-summary={stats.course.id}>
      <h2 id="feedback-summary" className={ui.h2}>
        {pick(stats.course.title, "et")}
      </h2>
      <p className={styles.numbers}>
        <span>{fill(t.count, { n: s.count })}</span>
        <span>{fill(t.scored, { n: s.scored })}</span>
        <strong data-feedback-average="">{s.average === null ? t.noScore : fill(t.average, { score: formatScore(s.average) })}</strong>
      </p>
      <div className={styles.questions}>
        {CHOICE_KEYS.map((key) => {
          const counts = s.options[key] as Record<string, number>;
          return (
            <div key={key} className={styles.question} data-feedback-counts={key}>
              <h3 className={ui.h3}>{QUESTIONS[key].label}</h3>
              <ul className={styles.counts}>
                {(FEEDBACK_CHOICES[key] as readonly string[]).map((option) => (
                  <li key={option} data-option={option}>
                    <span>{QUESTIONS[key].options?.[option]}</span>
                    <strong>{counts[option]}</strong>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The drawer: who, the course and its day, the ways to the student and the registration, and the answers. */
function FeedbackDetail({ f }: { f: FeedbackRow }) {
  const t = adminEt.feedback;
  return (
    <div className={styles.detail} data-feedback-detail={f.id}>
      <div className={styles.detailHead}>
        <h2 className={ui.h2}>{f.name}</h2>
        <a className={ui.contactLink} href={`mailto:${f.email}`}>
          {f.email}
        </a>
        <p className={ui.muted}>{f.startsAt ? `${pick(f.course.title, "et")}, ${formatDate(f.startsAt, "et")}` : pick(f.course.title, "et")}</p>
        <p className={styles.links}>
          {f.clientId !== null && (
            <Link className={ui.link} href={`/admin/opilased?id=${f.clientId}`}>
              {t.toStudent}
            </Link>
          )}
          <Link className={ui.link} href={`/admin/registreerimised?id=${f.registrationId}`}>
            {t.toRegistration}
          </Link>
        </p>
      </div>
      <FeedbackAnswers answers={f.answers} locale={f.locale} submittedAt={f.submittedAt} />
    </div>
  );
}
```

- [ ] **Step 8: The drawers.**
  1. **Registreerimised** (`src/app/admin/(panel)/registreerimised/page.tsx`).
     - Imports: add `import { FeedbackAnswers } from "@/components/admin/FeedbackAnswers";` after the `Drawer` import, and `import { feedbackOf, type FeedbackRow } from "@/db/queries/protocols";` after the `@/db/queries/payments` import.
     - The `Promise.all` becomes:

```tsx
  const [list, open, online, answers] = await Promise.all([
    pageRegistrations(db, filter, view.leht),
    view.id ? getRegistration(db, view.id) : null,
    view.id ? listPaymentsOf(db, { registrationId: view.id }) : [],
    view.id ? feedbackOf(db, { registrationId: view.id }) : [],
    getAdminCounts(),
  ]);
```

     - `<RegistrationDetail r={open} payments={online} />` becomes `<RegistrationDetail r={open} payments={online} feedback={answers[0] ?? null} />`, and the function's signature `function RegistrationDetail({ r, payments, feedback }: { r: RegistrationRow; payments: PaymentRow[]; feedback: FeedbackRow | null })`.
     - After the closing `</section>` of the money section (before `<RegistrationForms`), add:

```tsx
      {/* her answers to the course feedback form (phase protocols, spec §7): none, or the one */}
      {feedback && (
        <section className={styles.feedback} aria-label={adminEt.feedback.section} data-registration-feedback="">
          <h3 className={ui.h3}>{adminEt.feedback.section}</h3>
          <FeedbackAnswers answers={feedback.answers} locale={feedback.locale} submittedAt={feedback.submittedAt} />
        </section>
      )}
```

     - In `registrations.module.css`, after `.online { … }`, add:

```css
/* the feedback form's answers (phase protocols) */
.feedback {
  display: grid;
  gap: 10px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
```

  2. **Õpilased** (`src/components/admin/ClientDrawer.tsx`). Add `import { FeedbackAnswers } from "./FeedbackAnswers";` after the `./ClientForms` import. After the payments' `</section>`, add:

```tsx
      {/* her answers to the course feedback form (phase protocols, spec §7), newest first */}
      <section className={styles.section} aria-labelledby={`client-${c.id}-feedback`} data-client-feedback="">
        <h3 id={`client-${c.id}-feedback`} className={ui.h3}>
          {adminEt.feedback.section}
        </h3>
        {detail.feedback.length === 0 ? (
          <p className={styles.none}>{adminEt.feedback.none}</p>
        ) : (
          <ul className={styles.rows}>
            {detail.feedback.map((f) => (
              <li key={f.id} className={styles.row} data-client-feedback-row={f.id}>
                <div className={styles.rowHead}>
                  <strong>{pick(f.course.title, "et")}</strong>
                </div>
                {f.startsAt && <p className={styles.meta}>{formatDate(f.startsAt, "et")}</p>}
                <FeedbackAnswers answers={f.answers} locale={f.locale} submittedAt={f.submittedAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
```

  3. **`tests/unit/colour-tokens.test.ts`**: after `"src/components/admin/ProtocolScreen.module.css",` (Task 5) add `"src/components/admin/FeedbackAnswers.module.css",` and `"src/app/admin/(panel)/tagasiside/feedback.module.css",`.

- [ ] **Step 9: Run** `npx vitest run tests/db/feedback-admin.test.ts tests/db/feedback-admin-pages.test.ts tests/db/payments-admin-pages.test.ts tests/db/admin-clients.test.ts tests/unit/admin.test.ts tests/unit/admin-guards.test.ts tests/unit/colour-tokens.test.ts` — expect PASS.

- [ ] **Step 10: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`; `npx playwright test admin-inbox admin-clients` (the menu with "Tagasiside", the drawers); `E2E_PROD_BUILD=1 npx playwright test admin-load`.

- [ ] **Step 11: Commit.**

```bash
git add "app/src/app/admin/(panel)" app/src/components/admin app/src/db/queries/protocols.ts app/src/server/admin-clients.ts app/src/i18n/dict/admin.ts app/tests
git commit -m "feat(admin): Tagasiside — the answers per course with the average and every option's count, and in the student's and the registration's drawers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The account's deletion takes its protocols and feedback; the edge cases of spec §9

Spec sections 3 ("Account deletion") and 9.

**`deleteClient` locks her registrations first.** It already takes the address lock; it now selects her registrations `FOR UPDATE` before it deletes their protocols and feedback, then deletes the client as today (the registrations stay, unlinked by `ON DELETE SET NULL`). That is the send's order (the address, then the registration, then the protocol: Task 3), and a feedback answer reads its registration `FOR SHARE` (Task 8), so a send or an answer in flight on one of her registrations either finishes first and is deleted with the rest, or comes after and finds the registration no longer hers. A registration payment (`seats.ts`: the session, then the registration, then the payment) never waits for the address lock, so it cannot close a cycle with this either; `deleteClient` already wrote those registration rows (the `SET NULL`) and now only locks them a statement earlier.

**Where each case of §9 is tested.** Most cases belong to the task that owns the rule; this task adds the ones no other task covers, and the account's deletion.

| §9 case | Test |
|---|---|
| Registration cancelled after notes were written: hidden, never sent | Task 2 `protocols-screen.test.ts` (hidden, counted), Task 3 `protocols-send.test.ts` "Review Focus 3"; **here**: never sent by "Saada kõik" either, and back with every word when reinstated |
| Registration moved to another session | **here** |
| Course headings changed | Task 2 `protocols-save.test.ts` ("a first save made for headings the course no longer has…"); **here**: a sent protocol keeps its headings in the student's copy |
| Session cancelled: reachable, no feedback by date | Task 2 ("a session called off…"), Task 8 `feedback.test.ts` ("one called off does not") |
| Two devices | Task 2 and Task 5 "Review Focus 2" |
| Empty protocol | Task 3 ("nothing written is empty…"), Task 6 `protocol-send-dom.test.ts` (skipped and named) |
| Account deleted | **here** |
| Signed in under another address | Task 7 (another account's id: 404); **here**: the same person under her other address sees nothing until Maria links them |

**Files:**
- Modify: `app/src/server/client-data.ts` (`deleteClient`)
- Test: `app/tests/db/protocols-edges.test.ts` (new); `app/tests/db/client-data.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: `protocols`, `courseFeedback` (Task 1); `saveProtocol`, `sendProtocol`, `sendProtocols` (Tasks 2–3); `protocolScreen` (Task 2); `studentProtocol` (Task 7); `submitFeedback` (Task 8); `loadDashboard` (Tasks 7–8).
- Produces: `deleteClient(db, clientId)` — same signature and answer; it also deletes the `protocols` and `course_feedback` rows of the registrations linked to the client.

- [ ] **Step 1: Write the failing tests** `tests/db/protocols-edges.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { protocolScreen, studentProtocol } from "@/db/queries/protocols";
import { clients, courseFeedback, courses, courseSessions, protocols, registrations, type Registration } from "@/db/schema";
import { deleteClient, loadDashboard } from "@/server/client-data";
import { submitFeedback } from "@/server/course-feedback";
import { saveProtocol, sendProtocol, sendProtocols, type SendDeps } from "@/server/protocols";
import { fakeKv } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// Spec §9, the cases no other task's tests own (the table in the plan's Task 10 says where the others are), and the account's deletion
// (spec §3): her protocols and feedback go, her registrations stay with Maria.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// no RESEND_API_KEY: nothing is mailed (the mails are Task 3's)
const deps = (): SendDeps => ({ db, env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE }, siteUrl: SITE, now: NOW, later: () => {} });
const write = (registrationId: number, version: number, note: string, titles: readonly string[] = HEADINGS) =>
  saveProtocol(db, { registrationId, version, titles: [...titles], notes: [note, ...Array<string>(titles.length - 1).fill("")], generalNote: "Tubli töö" }, NOW);
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];
const accountOf = async (r: Registration) => (await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].clientId!;
const names = async (sessionId: number) => (await protocolScreen(db, { sessionId }))!.students.map((s) => [s.name, s.state]);

describe("a registration cancelled, or moved, while it has a protocol", () => {
  test("cancelled: off the screen and never sent, alone or with the others; reinstated, it is back with every word", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    await write(mari.id, 0, "Hea algus");
    await write(anu.id, 0, "Ühtlane joon");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([["Anu Aas", "draft"]]);
    const results = await sendProtocols(deps(), [
      { registrationId: mari.id, version: 1 },
      { registrationId: anu.id, version: 1 },
    ]);
    expect(results.map((r) => [r.registrationId, r.result.kind])).toEqual([
      [mari.id, "cancelled"],
      [anu.id, "sent"],
    ]);
    expect((await stored(mari.id)).sentAt).toBeNull();
    await db.update(registrations).set({ status: "confirmed" }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([
      ["Anu Aas", "sent"],
      ["Mari Maasikas", "draft"],
    ]);
    expect((await protocolScreen(db, { registrationId: mari.id }))!.students[0].protocol.stages[0]).toEqual({ title: HEADINGS[0], note: "Hea algus" });
  });

  test("moved to another session: the protocol follows her, a sent one too, and she still reads it on her card", async () => {
    const { course, session } = await protocolCourse(db);
    const [later] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-10-19T07:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", capacity: 6 }).returning();
    const mari = await student(db, course, session, "Mari Maasikas");
    await write(mari.id, 0, "Hea algus");
    await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
    await db.update(registrations).set({ courseSessionId: later.id }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([]);
    expect(await names(later.id)).toEqual([["Mari Maasikas", "sent"]]);
    const account = await accountOf(mari);
    expect(await studentProtocol(db, account, mari.id)).toMatchObject({ session: { startsAt: "2026-10-19T07:00:00.000Z" }, stages: [{ title: HEADINGS[0], note: "Hea algus" }, ...HEADINGS.slice(1).map((title) => ({ title, note: "" }))] });
    const card = (await loadDashboard(db, account, NOW))!.cards.find((c) => c.kind === "contact" && c.registrationId === mari.id);
    expect(card).toMatchObject({ session: { startsAt: "2026-10-19T07:00:00.000Z" }, protocolSent: true });
  });

  test("the course's headings changed after a send: the student's copy keeps the headings it was written under", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    await write(mari.id, 0, "Hea algus");
    await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
    await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, course.id));
    expect((await studentProtocol(db, await accountOf(mari), mari.id))!.stages.map((s) => s.title)).toEqual(HEADINGS);
    const anu = await student(db, course, session, "Anu Aas");
    expect((await protocolScreen(db, { registrationId: anu.id }))!.students[0].protocol.stages).toEqual([{ title: "Uus punkt", note: "" }]);
  });
});

describe("the account deleted (spec §3)", () => {
  async function twoSent() {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    for (const r of [mari, anu]) {
      await write(r.id, 0, `Märkus: ${r.name}`);
      await sendProtocol(deps(), { registrationId: r.id, version: 1 });
      expect(await submitFeedback(db, { clientId: await accountOf(r), registrationId: r.id, answers: { score: 9 }, locale: "et" }, NOW)).toMatchObject({ kind: "submitted" });
    }
    return { course, session, mari, anu };
  }

  test("her protocols and feedback go; her registrations stay with Maria, unlinked; another student's stay; Maria's screen shows her with nothing written", async () => {
    const { session, mari, anu } = await twoSent();
    const account = await accountOf(mari);
    const before = (await db.select().from(registrations).where(eq(registrations.id, mari.id)))[0];
    expect(await deleteClient(db, account)).toEqual({ email: "marimaasikas@example.com", locale: "et" });
    expect((await db.select().from(protocols)).map((p) => p.registrationId)).toEqual([anu.id]);
    expect((await db.select().from(courseFeedback)).map((f) => f.registrationId)).toEqual([anu.id]);
    expect((await db.select().from(registrations).where(eq(registrations.id, mari.id)))[0]).toEqual({ ...before, clientId: null });
    expect((await db.select().from(clients)).map((c) => c.email)).toEqual(["anuaas@example.com"]);
    expect(await names(session.id)).toEqual([
      ["Anu Aas", "sent"],
      ["Mari Maasikas", "none"],
    ]);
  });

  test("a feedback answer and the deletion, one after the other in either order: nothing of hers is left", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    for (const r of [mari, anu]) {
      await write(r.id, 0, "Hea algus");
      await sendProtocol(deps(), { registrationId: r.id, version: 1 });
    }
    // the answer first, then the deletion: the answer goes with the account
    const first = await accountOf(mari);
    expect(await submitFeedback(db, { clientId: first, registrationId: mari.id, answers: { score: 9 }, locale: "et" }, NOW)).toMatchObject({ kind: "submitted" });
    await deleteClient(db, first);
    expect(await db.select().from(courseFeedback)).toEqual([]);
    // the deletion first, then the answer: the registration is no longer hers, and the answer finds nothing
    const second = await accountOf(anu);
    await deleteClient(db, second);
    expect(await submitFeedback(db, { clientId: second, registrationId: anu.id, answers: { score: 9 }, locale: "et" }, NOW)).toEqual({ kind: "notFound" });
    expect(await db.select().from(courseFeedback)).toEqual([]);
    expect(await db.select().from(protocols)).toEqual([]);
  });
});

test("signed in under another address: none of her registration's protocol or feedback is hers until Maria links them", async () => {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await write(mari.id, 0, "Hea algus");
  await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
  const [other] = await db.insert(clients).values({ email: "mari.teine@example.com", name: "Mari" }).returning();
  expect(await studentProtocol(db, other.id, mari.id)).toBeNull();
  const dashboard = (await loadDashboard(db, other.id, NOW))!;
  expect(dashboard.cards).toEqual([]);
  expect(dashboard).not.toHaveProperty("feedback");
  expect(await submitFeedback(db, { clientId: other.id, registrationId: mari.id, answers: { score: 9 }, locale: "et" }, NOW)).toEqual({ kind: "notFound" });
});
```

  Run `npx vitest run tests/db/protocols-edges.test.ts` — FAIL on "the account deleted" (the protocols and feedback are still there; deleting the client trips no foreign key, since both reference the registration), the rest PASS (the rules of Tasks 2–8 hold them).

- [ ] **Step 2: The deletion** (`src/server/client-data.ts`).
  1. The schema import has `protocols` (Task 7) and `courseFeedback` (Task 8) already, and the `drizzle-orm` import `inArray`: nothing to add.
  2. `deleteClient`'s comment: after "the newsletter subscription of the address." add "Her protocols and her course feedback go too (phase protocols, spec §3): those of the registrations linked to her."; after "Takes the address lock the logins take, …" add "Then her registrations, FOR UPDATE, before their protocols and feedback: the order a send takes (the address, the registration, the protocol), so a send or a feedback answer on one of them finishes first, or finds it no longer hers after."
  3. In the transaction, after `await lockAddress(tx as unknown as Db, address);`, add:

```ts
    // her protocols and feedback (phase protocols): the registrations themselves stay with Maria, unlinked below (ON DELETE SET NULL)
    const mine = (await tx.select({ id: registrations.id }).from(registrations).where(eq(registrations.clientId, clientId)).for("update")).map((r) => r.id);
    if (mine.length > 0) {
      await tx.delete(protocols).where(inArray(protocols.registrationId, mine));
      await tx.delete(courseFeedback).where(inArray(courseFeedback.registrationId, mine));
    }
```

  Run `npx vitest run tests/db/protocols-edges.test.ts tests/db/client-data.test.ts tests/db/account-api.test.ts` — PASS.

- [ ] **Step 3: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`; `npx playwright test account-details` ("Kustuta konto" end to end, unchanged).

- [ ] **Step 4: Commit.**

```bash
git add app/src/server/client-data.ts app/tests/db/protocols-edges.test.ts
git commit -m "feat(account): deleting the account deletes its protocols and course feedback; the edge cases of a cancelled, moved or re-addressed registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End to end — the course day, the sends, the student's page, the feedback, the widths; two sends at once on real Postgres

Spec section 10 ("End to end", "Real Postgres", "Gate"). Every flow runs under `next dev` and the production build; the gate's own run checks the new account routes stay gated (its list grew in Tasks 7 and 8).

**The fixtures.** Each test makes its own contact course (not published: no public page shows it) with one session and its students, written straight to the local database (`tests/e2e/protocols.ts`). Every student is a sample address `e2e-client-proto-<label>-<project>@example.test` (never mailed), and the course's slug is `accountCourseSlug(<the first student's address>)` (`e2e-konto-proto-…`), so `fixtures.ts removeClientRows` — after each test, and in global setup and teardown by pattern — removes the registrations, the course with its session, the accounts the sends made, and with the registrations their protocols and feedback (`on delete cascade`). The session starts at 10:00 Tallinn time `day` days from today (0: today, for "Täna"; -1: yesterday, for the feedback by date).

**The race test needs no browser.** `protocols-race.spec.ts` runs the real `sendProtocol` in the test process on a pool of the local Postgres (`fixtures.ts localDatabaseUrl()`, new: the address the other helpers use, checked to be local), as `payments.spec.ts` proves its locks: two sends at the same moment on two connections, and two tests that never miss — another connection holds the registration's row lock and a send must wait for it; and the lock order: another connection holds her address lock, the send waits for it with the registration still free (a `FOR UPDATE NOWAIT` from a third connection gets it at once), so a send can never hold the registration while waiting for the address, as the logins, `addClient` and `deleteClient` take them the other way round. The desktop project runs it once.

**Files:**
- Create: `app/tests/e2e/protocols.ts`, `app/tests/e2e/protocols.spec.ts`, `app/tests/e2e/protocols-race.spec.ts`
- Modify: `app/tests/e2e/fixtures.ts` (`localDatabaseUrl`)

**Interfaces:**
- Consumes: every selector the earlier tasks produce (Tasks 4–9: `[data-protocol-stages]`, `[data-add-stage]`, `[data-protocol-stage=<i>]`, `[data-session-protocols]`, `[data-registration-protocol]`, `[data-today-session=<id>]`, `[data-protocol-screen]`, `[data-student=<id>][data-status]`, `[data-editor=<id>]`, `[data-note=<i>]`, `[data-general]`, `[data-save-status]`, `[data-locked]`, `[data-conflict]`, `[data-send]`, `[data-edit]`, `[data-editing]`, `[data-send-all-open]`, `[data-send-confirm]`, `[data-confirm-will]`, `[data-confirm-skipped]`, `[data-confirm-send]`, `[data-summary-sent]`, `[data-card=registration-<id>] [data-card-protocol]`, `[data-protocol-page]`, `[data-feedback-card=<id>]`, `[data-feedback-open]`, `[data-feedback-dismiss]`, `[data-feedback-form]`, `[data-question=<key>]`, `[data-feedback-submit]`, `[data-feedback-error]`, `[data-feedback-done]`, `[data-feedback-row=<id>]`, `[data-feedback-detail=<id>]`); `saveProtocol`, `sendProtocol`, `SendDeps` (Tasks 2–3).
- Produces, from `tests/e2e/protocols.ts`: `E2E_HEADINGS`; `type ProtocolFixtures = { course: { id: number; slug: string }; session: { id: number }; students: { id: number; name: string; email: string }[] }`; `insertProtocolFixtures(label, project, names, opts?: { headings?: string[]; day?: number })`; `insertSentProtocol(registrationId, notes, generalNote)`; `insertFeedbackAnswer(registrationId, answers)`; `storedProtocol(registrationId)`; `storedFeedback(registrationId)`; `studentPage(browser, email, ip)`. From `tests/e2e/fixtures.ts`: `localDatabaseUrl(): string`.

- [ ] **Step 1: The local database's address** — in `tests/e2e/fixtures.ts`, after `const connect = …;` add:

```ts
/**
 * The local test database's address, checked to be local (local-db.ts), for a test that needs connections of its own: protocols-race.spec.ts
 * runs the app's own sendProtocol on a pool of it (two connections at once, which onLocalDb's single one cannot be).
 */
export function localDatabaseUrl(): string {
  if (!isLocalDbUrl(DB_URL)) assertLocalDatabases([{ source: "E2E_DATABASE_URL", url: DB_URL }]);
  return DB_URL;
}
```

- [ ] **Step 2: The helpers** — create `tests/e2e/protocols.ts`:

```ts
import type { Browser, Page } from "@playwright/test";
import { clientEmail, signInAsClient } from "./account";
import { accountCourseSlug, onLocalDb, removeClientRows } from "./fixtures";
import { LOCAL_URL, TARGET } from "./target";
import { expect } from "./test";

// The protocols' e2e rows (phase protocols): a contact course of the test's own, not published, with Maria's headings and one session; its
// students' confirmed group registrations, without an account (a send, or her first login, makes it). Every address is
// `e2e-client-proto-<label>[-n]-<project>@example.test`: a sample address (never mailed) that fixtures.ts removeClientRows removes with
// everything it made, and the course's slug is the first student's (accountCourseSlug), so it goes too. Nothing here is on a public page.

const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

export const E2E_HEADINGS = ["Ettevalmistus", "Kulmude analüüs", "Värvimine"];

export type ProtocolFixtures = { course: { id: number; slug: string }; session: { id: number }; students: { id: number; name: string; email: string }[] };

/**
 * The course "E2E protokollikoolitus" with `headings` (default E2E_HEADINGS) and its session, which starts at 10:00 Tallinn time `day` days
 * from today (default 0: today), and one confirmed group registration per name, the first name's address naming the course. Leftovers of the
 * same addresses are removed first.
 */
export async function insertProtocolFixtures(label: string, project: string, names: string[], opts: { headings?: string[]; day?: number } = {}): Promise<ProtocolFixtures> {
  const emails = names.map((_, i) => clientEmail(i === 0 ? `proto-${label}` : `proto-${label}-${i + 1}`, project));
  for (const email of emails) await removeClientRows(email);
  const slug = accountCourseSlug(emails[0]);
  return localDb(async (sql) => {
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published, protocol_stages)
      values (${slug}, 'contact', 'basic', ${sql.json({ et: "E2E protokollikoolitus", ru: "E2E обучение с протоколом" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })},
              35000, 45000, false, ${sql.json(opts.headings ?? E2E_HEADINGS)})
      returning id`;
    const [session] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, (date_trunc('day', now() at time zone 'Europe/Tallinn') + make_interval(days => ${opts.day ?? 0}::int, hours => 10)) at time zone 'Europe/Tallinn',
              'Pärnu', 'MS LAB stuudio', 6)
      returning id`;
    const students: ProtocolFixtures["students"] = [];
    for (const [i, name] of names.entries()) {
      const [r] = await sql<{ id: number }[]>`
        insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status, paid_cents)
        values (${course.id}, ${session.id}, 'group', ${name}, ${emails[i]}, '+372 5555 0101', 'full', 'confirmed', 35000)
        returning id`;
      students.push({ id: r.id, name, email: emails[i] });
    }
    return { course: { id: course.id, slug }, session: { id: session.id }, students };
  });
}

type Stage = { title: string; note: string };

/** A protocol Maria has sent (version 1, its frozen copy the same): the student's page shows it, and her feedback form opens. */
export async function insertSentProtocol(registrationId: number, notes: string[], generalNote: string): Promise<void> {
  const stages: Stage[] = E2E_HEADINGS.map((title, i) => ({ title, note: notes[i] ?? "" }));
  await localDb(
    (sql) => sql`
      insert into protocols (registration_id, stages, general_note, version, sent, sent_at, sent_version)
      values (${registrationId}, ${sql.json(stages)}, ${generalNote}, 1, ${sql.json({ stages, generalNote })}, now(), 1)`,
  );
}

/** An answered feedback form (for a page that lists one). */
export async function insertFeedbackAnswer(registrationId: number, answers: Record<string, string | number>): Promise<void> {
  await localDb((sql) => sql`insert into course_feedback (registration_id, answers, locale, submitted_at) values (${registrationId}, ${sql.json(answers)}, 'et', now())`);
}

export type StoredProtocol = { version: number; stages: Stage[]; generalNote: string; sent: { stages: Stage[]; generalNote: string } | null; sentAt: Date | null; sentVersion: number | null };

/** The registration's protocol as stored, or null when there is none. */
export async function storedProtocol(registrationId: number): Promise<StoredProtocol | null> {
  const [row] = await localDb(
    (sql) => sql<StoredProtocol[]>`
      select version, stages, general_note as "generalNote", sent, sent_at as "sentAt", sent_version as "sentVersion" from protocols where registration_id = ${registrationId}`,
  );
  return row ?? null;
}

export type StoredFeedback = { id: number; answers: Record<string, unknown> | null; locale: string | null; submitted: boolean; dismissed: boolean };

/** The registration's feedback row, or null when there is none. */
export async function storedFeedback(registrationId: number): Promise<StoredFeedback | null> {
  const [row] = await localDb(
    (sql) => sql<StoredFeedback[]>`
      select id, answers, locale, submitted_at is not null as submitted, dismissed_at is not null as dismissed from course_feedback where registration_id = ${registrationId}`,
  );
  return row ?? null;
}

/** The student's own browser (another context, as she would have), signed in, on her dashboard. */
export async function studentPage(browser: Browser, email: string, ip: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: TARGET || LOCAL_URL, extraHTTPHeaders: { "x-forwarded-for": `${ip}-student` } });
  const page = await context.newPage();
  await signInAsClient(page, email);
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  return { page, close: () => context.close() };
}
```

- [ ] **Step 3: The flows** — create `tests/e2e/protocols.spec.ts`:

```ts
import type { Page } from "@playwright/test";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows, removeClientRows } from "./fixtures";
import { E2E_HEADINGS, insertFeedbackAnswer, insertProtocolFixtures, insertSentProtocol, storedFeedback, storedProtocol, studentPage } from "./protocols";
import { smallTargets } from "./targets";
import { submitsForms, test, expect } from "./test";

// Phase protocols (spec §10 "End to end"): Maria's course day — the headings in the course editor, two students written while switching between
// them, a dropped connection and a reload that lose nothing, "Lukusta ja saada kõik", the student reading hers, "Muuda" and "Saada uuesti" — and
// the feedback form from its card to Maria's Tagasiside, "Ei soovi", and the pages at 390, 834, 1194 and 1440 px. Every student is a sample
// address (`e2e-client-proto-…@example.test`, never mailed) on a course of the test's own; all of it is removed after each test. Under
// `next dev` and the production build (E2E_PROD_BUILD=1); the admin signs in as Dim (admin-login.ts).

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const SAVE = "**/api/admin/protokoll";

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(180_000); // (the first view of each page under `next dev` compiles it; the retries wait seconds)
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

async function fixtures(...args: Parameters<typeof insertProtocolFixtures>) {
  const fx = await insertProtocolFixtures(...args);
  for (const s of fx.students) made.add(s.email);
  return fx;
}

const editor = (page: Page, id: number) => page.locator(`[data-editor="${id}"]`);
const chip = (page: Page, id: number) => page.locator(`[data-student="${id}"]`);
const note = (page: Page, id: number, i: number) => editor(page, id).locator(`[data-note="${i}"]`);
const general = (page: Page, id: number) => editor(page, id).locator("[data-general]");
const saveStatus = (page: Page, id: number) => editor(page, id).locator("[data-save-status]");
/** The autosave has confirmed this student's text (the debounce is 1.5 s; a retry can be 20 s away). */
const saved = (page: Page, id: number) => expect(saveStatus(page, id)).toHaveAttribute("data-save-status", "saved", { timeout: 40_000 });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const emptyNotes = (n: number) => Array.from({ length: n }, () => expect.objectContaining({ note: "" }));

test("the headings in the course editor; Kalender's 'Protokollid'; two students written while switching between them, every word stored (§10 e2e 1)", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("two", info.project.name, ["Mari Maasikas", "Anu Aas"], { headings: [] });
  const [mari, anu] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  // Protokolli punktid: three headings, saved with the course
  await page.goto(`/admin/koolitused/${fx.course.id}`);
  await adminReady(page);
  const stages = page.locator("[data-protocol-stages]");
  for (const [i, title] of E2E_HEADINGS.entries()) {
    await stages.locator("[data-add-stage]").click();
    await stages.locator(`[data-protocol-stage="${i}"]`).fill(title);
  }
  await page.getByRole("button", { name: "Salvesta", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
  // the session's drawer in Kalender: one tap to the course day's screen
  await page.goto(`/admin/kalender?id=${fx.session.id}`);
  await adminReady(page);
  await page.locator("[data-session-protocols]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await expect(page.locator("[data-students] [data-student]")).toHaveCount(2);
  // Mari: her headings with a box each, then the general notes
  await chip(page, mari.id).click();
  await expect(editor(page, mari.id).locator("label")).toHaveText([...E2E_HEADINGS, "Üldised märkused"]);
  await note(page, mari.id, 0).fill("Mari: ühtlane joon.");
  // switching is one tap and never waits: Mari's text saves in the background
  await chip(page, anu.id).click();
  await note(page, anu.id, 1).fill("Anu: kulmud analüüsitud.");
  await general(page, anu.id).fill("Anu: tubli töö!\nHarjuta värvimist.");
  await saved(page, anu.id);
  await expect(chip(page, mari.id)).toHaveAttribute("data-status", "draft");
  await expect(chip(page, mari.id).locator("[data-unsaved]")).toHaveCount(0);
  await expect(chip(page, anu.id)).toHaveAttribute("data-status", "draft");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, stages: [{ title: "Ettevalmistus", note: "Mari: ühtlane joon." }, ...emptyNotes(2)], generalNote: "", sentAt: null });
  expect(await storedProtocol(anu.id)).toMatchObject({ stages: [{ note: "" }, { title: "Kulmude analüüs", note: "Anu: kulmud analüüsitud." }, { note: "" }], generalNote: "Anu: tubli töö!\nHarjuta värvimist." });
  // a reload shows what is stored
  await page.reload();
  await adminReady(page);
  await chip(page, mari.id).click();
  await expect(note(page, mari.id, 0)).toHaveValue("Mari: ühtlane joon.");
});

test("Review Focus 1: answers lost on the way, then no network and a reload: nothing is lost, no conflict, stored once the network is back (§10 e2e 2)", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("wifi", info.project.name, ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  page.on("dialog", (dialog) => void dialog.accept()); // "leave the page?" while a text is not confirmed: yes (the reload below)
  await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
  await adminReady(page);
  // 1. each save reaches the server, but its answer never comes back to the tablet
  await page.route(SAVE, async (route) => {
    await route.fetch({ headers: await route.request().allHeaders() }).catch(() => null); // (the admin's cookie with it)
    await route.abort("connectionreset");
  });
  await note(page, mari.id, 0).fill("Esimene lause.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "retrying", { timeout: 20_000 });
  await expect(saveStatus(page, mari.id)).toHaveText("Salvestamata — proovin uuesti");
  await expect.poll(async () => (await storedProtocol(mari.id))?.stages[0].note).toBe("Esimene lause."); // stored, unknown to the tablet
  await note(page, mari.id, 0).fill("Esimene lause. Teine lause.");
  // 2. no network at all, and the tablet reloads the page: the text comes back from this browser
  await page.unroute(SAVE);
  await page.route(SAVE, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await adminReady(page);
  await expect(note(page, mari.id, 0)).toHaveValue("Esimene lause. Teine lause.");
  // 3. the network is back (the "online" event: the autosave tries at once)
  await page.unroute(SAVE);
  await context.setOffline(true);
  await context.setOffline(false);
  await saved(page, mari.id);
  await expect(editor(page, mari.id).locator("[data-conflict]")).toHaveCount(0);
  expect(await storedProtocol(mari.id)).toMatchObject({ stages: [{ note: "Esimene lause. Teine lause." }, ...emptyNotes(2)], sentAt: null });
  expect(await page.evaluate((id) => localStorage.getItem(`mslab-protocol:${id}`), mari.id)).toBeNull(); // the browser's copy is gone once confirmed
});

test("'Täna' opens the day's screen; 'Lukusta ja saada kõik' names who gets one and who is skipped, sends, and the student reads hers (§10 e2e 3)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("send", info.project.name, ["Mari Maasikas", "Anu Aas"]);
  const [mari, anu] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created); // lands on the overview
  await adminReady(page);
  const today = page.locator(`[data-today-session="${fx.session.id}"]`);
  await expect(today).toContainText("E2E protokollikoolitus");
  await expect(today).toContainText("Õpilasi: 2");
  await today.getByRole("link", { name: "Protokollid" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await chip(page, mari.id).click();
  await note(page, mari.id, 0).fill("Ühtlane joon, hea kuju.");
  await general(page, mari.id).fill("Tubli töö!\nHarjuta veel värvimist.");
  await saved(page, mari.id);
  // Anu's is empty: skipped, and named
  await page.locator("[data-send-all-open]").click();
  const confirm = page.locator("[data-send-confirm]");
  await expect(confirm.locator("[data-confirm-will]")).toContainText("Mari Maasikas");
  await expect(confirm.locator("[data-confirm-skipped]")).toContainText("Anu Aas");
  await confirm.locator("[data-confirm-send]").click();
  await expect(page.locator("[data-summary-sent]")).toContainText("Mari Maasikas");
  await expect(chip(page, mari.id)).toHaveAttribute("data-status", "sent");
  await expect(chip(page, anu.id)).toHaveAttribute("data-status", "none");
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  await expect(note(page, mari.id, 0)).toHaveAttribute("readonly", "");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1, sent: { generalNote: "Tubli töö!\nHarjuta veel värvimist." } });
  expect(await storedProtocol(anu.id)).toBeNull();
  // the send made her account and linked her registration: she signs in and opens it from her card
  const student = await studentPage(browser, mari.email, visitorIp);
  await student.page.locator(`[data-card="registration-${mari.id}"] [data-card-protocol]`).click();
  await expect(student.page).toHaveURL(new RegExp(`/konto/protokoll#id=${mari.id}$`));
  const protocol = student.page.locator("[data-protocol-page]");
  await expect(protocol.locator("h1")).toHaveText("E2E protokollikoolitus");
  for (const text of ["Ettevalmistus", "Ühtlane joon, hea kuju.", "Üldised märkused", "Harjuta veel värvimist."]) await expect(protocol).toContainText(text);
  await student.close();
});

test("from the registration's drawer: 'Saada', 'Muuda', an edit, 'Saada uuesti'; the student reads the new text (§10 e2e 4)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("resend", info.project.name, ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/registreerimised?id=${mari.id}`);
  await adminReady(page);
  await page.locator("[data-registration-protocol]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?registreering=${mari.id}$`));
  await adminReady(page);
  await note(page, mari.id, 0).fill("Esimene versioon.");
  await saved(page, mari.id);
  await editor(page, mari.id).locator('[data-send="first"]').click(); // one registration's screen: "Saada" is its primary button
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  // "Muuda" only unlocks the screen: nothing changes until an edit is saved
  await editor(page, mari.id).locator("[data-edit]").click();
  await expect(editor(page, mari.id).locator("[data-editing]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1 });
  await note(page, mari.id, 0).fill("Teine versioon.");
  await saved(page, mari.id);
  const again = editor(page, mari.id).locator('[data-send="again"]');
  await expect(again).toHaveText("Saada uuesti");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 1, sent: { stages: [{ note: "Esimene versioon." }, ...emptyNotes(2)] } });
  // the student still reads the first version until it is sent again
  const student = await studentPage(browser, mari.email, visitorIp);
  await student.page.goto(`/konto/protokoll#id=${mari.id}`);
  await expect(student.page.locator("[data-protocol-page]")).toContainText("Esimene versioon.");
  await again.click();
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 2, sent: { stages: [{ note: "Teine versioon." }, ...emptyNotes(2)] } });
  await student.page.reload();
  await expect(student.page.locator("[data-protocol-page]")).toContainText("Teine versioon.");
  await expect(student.page.locator("[data-protocol-page]")).not.toContainText("Esimene versioon.");
  await student.close();
});

test("the feedback card, the form sent, the card gone; Maria reads the answer on Tagasiside (§10 e2e 5)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("feedback", info.project.name, ["Mari Maasikas"]);
  const [mari] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon."], "Tubli töö!");
  // her first login makes her account and links the registration (phase 2a)
  const student = await studentPage(browser, mari.email, visitorIp);
  const s = student.page;
  const card = s.locator(`[data-feedback-card="${mari.id}"]`);
  await expect(card).toContainText("Kuidas koolitus läks?");
  await card.locator("[data-feedback-open]").click();
  await expect(s).toHaveURL(new RegExp(`/konto/tagasiside#id=${mari.id}$`));
  const form = s.locator("[data-feedback-form]");
  await expect(form.locator("h1")).toHaveText("Sinu kogemus MS LAB koolitusel");
  await form.locator("[data-feedback-submit]").click();
  await expect(form.locator("[data-feedback-error]")).toHaveText("Vasta vähemalt ühele küsimusele.");
  await form.locator('[data-question="score"] input[value="9"]').check();
  await form.locator('[data-question="expectations"] input[value="met"]').check();
  await form.locator('[data-question="message"] textarea').fill("Aitäh, väga hea päev!");
  await form.locator("[data-feedback-submit]").click();
  const done = s.locator('[data-feedback-done="done"]');
  await expect(done).toContainText("Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!");
  const stored = (await storedFeedback(mari.id))!;
  expect(stored).toMatchObject({ answers: { score: 9, expectations: "met", message: "Aitäh, väga hea päev!" }, locale: "et", submitted: true, dismissed: false });
  await done.getByRole("link", { name: "Minu koolitused" }).click();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator("[data-feedback-card]")).toHaveCount(0);
  await student.close();
  // Maria's Tagasiside: the answer listed with its score, its words in the drawer
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/tagasiside");
  await adminReady(page);
  const row = page.locator(`[data-feedback-row="${stored.id}"]`);
  await expect(row).toContainText("9/10");
  await row.getByRole("link", { name: "Mari Maasikas" }).click();
  const detail = page.locator(`[data-feedback-detail="${stored.id}"]`);
  await expect(detail).toContainText("Kas koolitus vastas sinu ootustele?");
  await expect(detail).toContainText("Vastas ootustele");
  await expect(detail).toContainText("Aitäh, väga hea päev!");
});

test("'Ei soovi': a course that was yesterday offers the form by its date; the card goes for good (§10 e2e 6)", async ({ browser, visitorIp }, info) => {
  const fx = await fixtures("dismiss", info.project.name, ["Mari Maasikas"], { day: -1 });
  const [mari] = fx.students;
  const student = await studentPage(browser, mari.email, visitorIp);
  const s = student.page;
  const card = s.locator(`[data-feedback-card="${mari.id}"]`);
  await expect(card).toBeVisible();
  await card.locator("[data-feedback-dismiss]").click();
  await expect(card).toHaveCount(0);
  expect(await storedFeedback(mari.id)).toMatchObject({ answers: null, submitted: false, dismissed: true });
  await s.reload();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator("[data-feedback-card]")).toHaveCount(0);
  await student.close();
});

test("the screens at 390, 834, 1194 and 1440 px: no sideways scroll, every target 44 px (§10 e2e 7)", async ({ page, context, visitorIp, browser, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  const fx = await fixtures("look", info.project.name, ["Mari Maasikas", "Anu Aas"]);
  const [mari, anu] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon, hea kuju. ".repeat(20)], "Tubli töö!");
  await insertFeedbackAnswer(anu.id, { score: 8, expectations: "exceeded", recommend: "Jah, kindlasti." });
  await signInAsAdmin(page, context, visitorIp, created);
  const student = await studentPage(browser, mari.email, visitorIp);
  const screens = [
    { page, url: `/admin/protokollid?sessioon=${fx.session.id}`, scope: "[data-protocol-screen]", admin: true },
    { page, url: "/admin/tagasiside", scope: "main", admin: true },
    { page: student.page, url: `/konto/protokoll#id=${mari.id}`, scope: "[data-protocol-page]", admin: false },
    { page: student.page, url: `/konto/tagasiside#id=${mari.id}`, scope: "[data-feedback-form]", admin: false },
  ];
  for (const width of [390, 834, 1194, 1440]) {
    for (const v of screens) {
      await v.page.setViewportSize({ width, height: 900 });
      await v.page.goto(v.url);
      if (v.admin) await adminReady(v.page);
      const scope = v.page.locator(v.scope);
      await expect(scope).toBeVisible();
      expect(await noOverflow(v.page), `${v.url} at ${width} px`).toBe(true);
      expect(await smallTargets(scope), `${v.url} at ${width} px`).toEqual([]);
    }
  }
  await student.close();
});
```

- [ ] **Step 4: Two sends at once** — create `tests/e2e/protocols-race.spec.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { saveProtocol, sendProtocol, type SendDeps } from "../../src/server/protocols";
import { localDatabaseUrl, onLocalDb, removeClientRows } from "./fixtures";
import { E2E_HEADINGS, insertProtocolFixtures, storedProtocol } from "./protocols";
import { submitsForms, test, expect } from "./test";

// Spec §10 "Real Postgres": what the unit tests' single-connection PGlite cannot show. The app's own sendProtocol, in this process, on a pool of
// the local Postgres: two sends of one protocol at the same moment (two taps, two devices) give one frozen copy and one mail — the other finds
// it sent. The race alone may not overlap every run, so the locks have tests that never miss (as payments.spec.ts): another connection holds
// the registration's row lock, and a send waits for it; and the order — another connection holds the address lock, the send waits for it
// and has not touched the registration (which the logins, addClient and deleteClient lock after the address). No browser: the desktop
// project runs these once.

test.skip(({ isMobile }) => isMobile, "no browser in these tests: the desktop project runs them once");

const made = new Set<string>();
let pool: postgres.Sql | null = null;
let db: Db;

test.beforeAll(() => {
  pool = postgres(localDatabaseUrl(), { max: 4, onnotice: () => {} });
  db = drizzle(pool, { schema }) as unknown as Db;
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000);
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

/** The send's dependencies; its mail job (only a send that froze the copy queues one) is collected, never run: nothing is mailed. */
function deps(jobs: (() => Promise<unknown>)[]): SendDeps {
  const site = "http://localhost:3000";
  return {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: site },
    siteUrl: site,
    now: new Date(),
    later: (task) => void jobs.push(task),
  };
}

/** Mari with a written protocol, version 1. */
async function written(label: string, project: string) {
  const fx = await insertProtocolFixtures(label, project, ["Mari Maasikas"]);
  for (const s of fx.students) made.add(s.email);
  const [mari] = fx.students;
  expect(await saveProtocol(db, { registrationId: mari.id, version: 0, titles: E2E_HEADINGS, notes: ["Hea algus", "", ""], generalNote: "" }, new Date())).toMatchObject({ kind: "saved", version: 1 });
  return mari;
}

test("two sends of one protocol at the same moment: one frozen copy and one mail; the other finds it sent", async ({}, info) => {
  const mari = await written("race", info.project.name);
  const jobs: (() => Promise<unknown>)[] = [];
  const results = await Promise.all([sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 }), sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 })]);
  expect(results.map((r) => r.kind).sort()).toEqual(["already", "sent"]);
  expect(jobs).toHaveLength(1);
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1, sent: { stages: [{ title: "Ettevalmistus", note: "Hea algus" }, { note: "" }, { note: "" }] } });
  // one account for her, linked once
  const accounts = await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from clients where email = ${mari.email}`, { marksPages: false });
  expect(accounts[0].n).toBe(1);
});

test("a send waits while another transaction holds the registration's row lock, and goes on when it is let go", async ({}, info) => {
  const mari = await written("held", info.project.name);
  const jobs: (() => Promise<unknown>)[] = [];
  let sending!: ReturnType<typeof sendProtocol>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        await tx`select 1 from registrations where id = ${mari.id} for update`;
        sending = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        void sending.then(
          () => (finished = true),
          () => (finished = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(finished, "the send went past the registration's lock while it was held").toBe(false);
        expect((await storedProtocol(mari.id))!.sentAt).toBeNull();
      }),
    { marksPages: false },
  );
  expect(await sending).toMatchObject({ kind: "sent", again: false, version: 1 });
  expect(jobs).toHaveLength(1);
});

test("the lock order: while another transaction holds her address lock the send waits, with the registration still free; let go, it goes on", async ({}, info) => {
  const mari = await written("order", info.project.name);
  const jobs: (() => Promise<unknown>)[] = [];
  let sending!: ReturnType<typeof sendProtocol>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        // client-auth.ts lockAddress: the logins', addClient's and deleteClient's lock, taken first by every path that writes for an address
        await tx`select pg_advisory_xact_lock(hashtext(${`client-login:${mari.email}`}))`;
        sending = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        void sending.then(
          () => (finished = true),
          () => (finished = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(finished, "the send went past the address lock while it was held").toBe(false);
        // the send waits on the address and holds nothing of the registration: another connection locks it at once (NOWAIT fails otherwise)
        await onLocalDb((other) => other.begin((t) => t`select 1 from registrations where id = ${mari.id} for update nowait`), { marksPages: false });
      }),
    { marksPages: false },
  );
  expect(await sending).toMatchObject({ kind: "sent", version: 1 });
  expect(jobs).toHaveLength(1);
});
```

- [ ] **Step 5: Run** under `next dev`: `npx playwright test protocols protocols-race cache gate account-dashboard admin-inbox admin-clients admin-load` — expect PASS (both projects; the race spec and the widths on the desktop one).

- [ ] **Step 6: Run** the production build: `E2E_PROD_BUILD=1 npx playwright test protocols protocols-race cache account-dashboard admin-load` — expect PASS; then the gate: `npx playwright test -c playwright.gate.config.ts` — expect PASS (the new account routes are 404 JSON without the preview cookie, the shells the coming-soon page).

- [ ] **Step 7: Run everything.** `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, and the whole `npx playwright test` once (the specs of the earlier phases share the database: nothing of this phase may leave a row they count).

- [ ] **Step 8: Commit.**

```bash
git add app/tests/e2e/protocols.ts app/tests/e2e/protocols.spec.ts app/tests/e2e/protocols-race.spec.ts app/tests/e2e/fixtures.ts
git commit -m "test(e2e): the course day end to end — switching students, a dropped connection, the sends, the student's page, the feedback, the widths; two sends at once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The docs — the protocols' runbook, the Hobby limits, the rollback, and the launch checklist

Spec sections 10 and 11. Docs only: no code. (Task 1 already changed the texts that said the drop of `courses.modules` is 0007.)

**Files:**
- Modify: `docs/deploy.md` (§8, §9, new §12)
- Modify: `docs/launch-checklist.md` (new §11)

**Interfaces:** none (the docs name what Tasks 1–11 produce: the route, the pages, the logs, the locks).

- [ ] **Step 1: The Hobby limits** — in `docs/deploy.md` §9, after the bullet "A student watching a lesson posts her progress…", add:

```markdown
- The protocol screen (phase protocols, section 12) saves 1.5 s after Maria stops typing, when she leaves a box and when she switches student, never on a timer while nothing changes; a failed save is tried again after 2, 5, 10, 20 and then every 30 s, and at once when the tablet is back online. A course day of six students is a few hundred calls. `POST /api/admin/protokoll` sets `maxDuration = 30`, and a save the browser gets no answer to within 10 s is tried again.
```

- [ ] **Step 2: The rollback** — in `docs/deploy.md` §8, at the end of item 1, add:

```markdown
Before rolling back past the protocols phase: see section 12, item 8.
```

- [ ] **Step 3: The runbook** — append to `docs/deploy.md`:

```markdown
## 12. Protocols and the feedback form

Maria writes one protocol per student on the course day and sends it at the end; the student reads it in her account and may answer Maria's feedback form there (phase protocols, spec `docs/superpowers/specs/2026-10-12-protocols-design.md`).

1. **What runs where.** The screen is `/admin/protokollid?sessioon=<id>` (from Kalender, a session's drawer, and the overview's "Täna") or `?registreering=<id>` (from a registration's drawer); its autosave posts to `POST /api/admin/protokoll` (`withAdmin`), and the sends are server actions (`adminAction`). The student's pages are the static shells `/konto/protokoll#id=<registration>` and `/konto/tagasiside#id=<registration>`; their data is `GET /api/konto/protokoll?id=`, `GET|POST /api/konto/tagasiside` and `POST /api/konto/tagasiside/peida` (`private, no-store`; behind the coming-soon gate until the launch, like every account route). Maria reads the answers on `/admin/tagasiside` and in the Õpilased and Registreerimised drawers. No new variable, no cron.
2. **The data.** Migration `0007_protocols` (additive): `courses.protocol_stages` (the course's headings, edited in the course editor's "Protokolli punktid"), `protocols` and `course_feedback` (one row each per registration, deleted with it). A protocol is created by its first save, with the course's headings as they are then; a later change of the headings reaches only protocols not created yet. The status (Mustand, Saadetud, Muudetud) is computed from `version`, `sent_at` and `sent_version`, never stored. The student is only ever served `sent`, the copy frozen at the send.
3. **The autosave and the tablet.** Every save carries the version the screen has; an older one is refused (409) with what is stored, and the screen shows that with a notice and keeps its own unsaved text visible in it. Until the server confirms a text, the browser keeps it in `localStorage` (`mslab-protocol:<registration id>`) and resumes it on reconnect and on reload; the student's chip says "Salvestamata" meanwhile. So on the tablet: never clear the browser's site data, and never use a private window, while a chip says "Salvestamata"; a browser that cannot keep the text (its storage full or blocked) says so under that protocol. A conflict notice's words are kept the same way (`mslab-protocol-conflict:<registration id>`) until "Selge". While a send is on its way its protocol is read-only. A box over 10 000 characters is never cut: it says so, and nothing of that student is saved until it is shorter.
4. **A send.** One transaction per student, the locks in one order: the address (`client-auth.ts lockAddress`), then the registration (`seats.ts lockRegistration`), then the protocol row. It freezes `sent`, `sent_at` and `sent_version`, makes her account when she has none (`addClient`) and links the registration. A cancelled registration is never sent; an empty protocol is refused ("Lukusta ja saada kõik" skips it and names it; one protocol that cannot be saved or sent never stops the others, and the summary names each by why). Two taps or two devices sending the same version at once send it once, with one mail (`tests/e2e/protocols-race.spec.ts`, which also pins the lock order). The account's deletion (`client-data.ts deleteClient`) takes the address and then her registrations before it deletes their protocols and feedback, the same order, so it never deadlocks with a send.
5. **The mails.** After the commit: "Sinu koolituse protokoll on valmis" (the first send, with the feedback form's link) or "Sinu koolituse protokolli on uuendatud" (a send again, without it), in the registration's language. The button carries a normal client login made with the mail, and the six-digit code is shown under it, as in the e-course mail (30 minutes; an address that has its 3 live logins already gets the mail without one, and the button then opens the page, which asks her to sign in). No mail holds a note. These mails are not counted in the daily login-mail cap (they follow Maria's own sends, a handful a course day), and a sample address (`@example.test`) is never mailed. A failed mail never undoes the send: the student sees the protocol on her dashboard all the same.
6. **The feedback form.** It opens when the protocol has been sent, or for a group registration whose session started before today (Tallinn time) and was not called off; never for a cancelled registration. One answer per registration (a second is "Tagasiside on juba saadetud"); "Ei soovi" hides the dashboard's card for good, but the mail's link still opens the form. At most 10 answers and "Ei soovi"s a client an hour. Each answer sends Maria "Uus tagasiside: {nimi}, {koolitus}, {score}/10" by mail (to `MARIA_EMAIL`, reply to the student) and Telegram, after the response; its questions and options are in her Estonian wording whatever language the student answered in.
7. **The logs.** `[protocols] registration N: sent` (or `sent again`), `[protocols] registration N: the mail sent: true|false`, `[protocols] registration N: the mail failed: <error class>`, `[protocols] registration N: the send failed: <error class>`, `[protocols] registration N: the save failed: <error class>`, `[protocols] a mail failed: <error class>` (a mail job that threw outside its own catch); `[feedback] registration N: submitted`, `[feedback] registration N: Maria notified by e-mail: true|false, Telegram: true|false`, `[account] feedback rate limited`. Never a note, an answer, a name or an address.
8. **Rollback.** A rollback of the code past this phase (section 8) leaves the three additions of 0007 in place; the older code ignores them. It has no protocol screen and no `/konto/protokoll` or `/konto/tagasiside`: the button of a mail sent before then opens a 404 until the code is back. Its account deletion does not know the two tables, so an account deleted meanwhile keeps its protocols and feedback: delete them by hand afterwards, by the registration ids that the deletion unlinked (Railway, read the rows first).
```


- [ ] **Step 4: The launch checklist** — append to `docs/launch-checklist.md`:

```markdown
## 11. Protocols and the course feedback form
- [ ] Go-live behind the coming-soon gate (plan 2026-10-12-protocols, Task 13): migration 0007 on Railway first, then the deploy, then the live check with one exact sample address, cleaned up by that address only (never `like '%naidis@example.test'`: Maria's 11 demo registrations use that pattern).
- [ ] Maria's answers to the spec's assumptions (asked 12.10): (1) protocols for contact courses only, none for the MINI/MAXI practice packages; (2) individual courses get protocols too (if group only, hide "Ava protokoll" on an individual registration's drawer); (3) the certificate trigger is decided in phase 3d.
- [ ] Maria fills "Protokolli punktid" of each contact course (Koolitused → the course) before its first course day; without them the screen has only "Üldised märkused".
- [ ] Dim approves the wording sheet (the plan's Wording appendix): the mails, the screen's and the drawers' texts, the student's page, the feedback card and form, Maria's notice.
- [ ] Maria confirms option 2b of the feedback form: the paper says "Vastasin ootustele", the site "Vastas ootustele" (a typo fix). The answers are stored as keys, so a later change of the words changes nothing stored.
- [ ] Native-speaker check of the Russian texts this phase added, all in `src/i18n/dict/ru.ts`: `account.protocolMail.*` (the two mails), `account.dashboard.viewProtocol`, `account.protocol.*` (the protocol page), `account.dashboard.feedbackCard.*`, `account.feedback.*` (the form: `title`, `lead`, the ten `questions` with their `options`, `count`, `submit`, `sending`, `empty`, `thanks`, `sent`, `notOpen`, `loading`).
- [ ] The privacy text (Seaded → Privaatsus) gets Maria's line about protocols and feedback: the protocol and the answers are kept with the registration, shown only to the student and to Maria, and deleted with the account.
- [ ] Before the first course day: Maria opens a session's screen once on her tablet, in the browser she will use on the day (not a private window): nothing is written by opening it, and that browser is where unsaved text waits for the network (`docs/deploy.md` section 12, item 3).
- [ ] Migration 0008 (drops `courses.modules`) stays as planned in phase 3a: the code first, then the migration (section 8); the migrations count afterwards is 9.
- [ ] Accepted: a student signed in under another address than her registration's sees neither the protocol nor the feedback card until Maria links them (as the dashboard today).
- [ ] Accepted: after a student deletes her account, her registration stays on Maria's screen with nothing written; a new send to it makes a new account (Maria decides whether to send).
- [ ] Accepted: the protocol mails are not counted in the daily login-mail cap; a course day sends a handful.
```

- [ ] **Step 5: Check** `npx vitest run tests/unit/test-addresses.test.ts` (no real address in the docs) — expect PASS.

- [ ] **Step 6: Commit.**

```bash
git add docs/deploy.md docs/launch-checklist.md
git commit -m "docs: the protocols' runbook, the autosave in the Hobby limits, the rollback, and the launch checklist's protocols section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Migration 0007 on Railway, the deploy and the live check (controller)

Spec section 11. This task is run by the controller, not a subagent. It is the first that writes to Railway, pushes or deploys.

The order is "the additive migration first, then the deploy": the live code never names `protocol_stages`, `protocols` or `course_feedback`, and the new column has a default, so 0007 cannot disturb it; the new routes are behind the coming-soon gate, where only admins with the preview cookie reach the account pages.

The ledger is `.superpowers/sdd/2026-10-12-protocols/progress.md` (git-ignored). Record each step's outcome there: counts and statuses only, never a URL, a key, a token or an address.

**The sample student.** One exact address, chosen now and written into the ledger by its label only: `protokoll-proov-1012.naidis@example.test`, named **"Proov (näidis)"** as Maria's demo students are, so Maria's one notice of the check says so. A sample address is never mailed (the protocol mail skips it); Maria's own notice of its answer does reach her inbox, and Telegram goes to Dim. Tell Maria beforehand that one "Uus tagasiside: Proov (näidis), …" mail is coming.

**Files:** none (the database, the deployment and the ledger).

- [ ] **Step 1 (read-only): Railway before.** Take the public TCP proxy URL of Maria's Railway project `mslab` (Postgres → Connect → Public Network) and put it in the shell only (`docs/deploy.md` section 6), with `?sslmode=require`. Read, printing counts only:
  - `select count(*) from drizzle.__drizzle_migrations` → 7 (0000–0006);
  - `select to_regclass('public.protocols') is null and to_regclass('public.course_feedback') is null` → `t`;
  - `select count(*) from information_schema.columns where table_name = 'courses' and column_name = 'protocol_stages'` → 0;
  - `select count(*) from registrations where email = 'protokoll-proov-1012.naidis@example.test'` → 0 (the address is unused).
- [ ] **Step 2: Branch checks.**
  - The whole `npx vitest run`, `npx tsc --noEmit` and `npx eslint .`.
  - `npm run build`: every `/[locale]/konto…` route, `/konto/protokoll` and `/konto/tagasiside` with them, is prerendered (● / ○), never ƒ.
  - The e2e under `next dev` and with `E2E_PROD_BUILD=1` (the whole run), and `npx playwright test -c playwright.gate.config.ts`.
  - `git status` is clean on `feat/protocols` (this plan committed by the controller after its review).
- [ ] **Step 3: Migration 0007 on Railway.**
  1. From `app/`: `DATABASE_URL='…?sslmode=require' npm run db:migrate`.
  2. Check:
     - `select count(*) from drizzle.__drizzle_migrations` → 8;
     - `select count(*) from protocols` → 0, `select count(*) from course_feedback` → 0;
     - `select count(*) from courses where protocol_stages <> '[]'::jsonb` → 0 (every course has the empty default).
  3. Open https://mslab.ee once (as an admin with the preview cookie): the live site still answers, and a course's editor saves (the old code ignores the new column).
- [ ] **Step 4: Deploy.** Merge `feat/protocols` into `main` and push `main` to `origin` (`mslabinformation-collab/mslab`): that push is the production deployment. Do not push the feature branch itself.
- [ ] **Step 5: READY.** `vercel --global-config ~/.vercel-mslabinformation ls mslab` (and `inspect <url>`): the deployment is READY and holds the alias `mslab.ee`.
- [ ] **Step 6: Read-only acceptance on https://mslab.ee.**
  - `node tools/cache-smoke.mjs https://mslab.ee` passes parts A, B and C.
  - The remote read-only e2e with 1–2 workers: `E2E_BASE_URL=https://mslab.ee E2E_ALLOW_REMOTE=1 npx playwright test --workers=2` (the specs that submit or need the local database skip themselves; a difference that comes only from Maria's live content goes to the ledger).
  - `curl -s -w ' %{http_code}' 'https://mslab.ee/api/konto/protokoll?id=1'` → a 404 JSON (the gate, for a script without the preview cookie); the same for `https://mslab.ee/api/konto/tagasiside?id=1`.
  - `curl -s -w ' %{http_code}' -X POST https://mslab.ee/api/admin/protokoll -H 'content-type: application/json' -d '{}'` → `{"ok":false,"error":"unauthorized"} 401` (the route passes the gate and is behind `withAdmin`).
- [ ] **Step 7: The sample registration (Railway, one insert).** On a scheduled session of one of Maria's published contact courses (read its id, read-only: `select s.id from course_sessions s join courses c on c.id = s.course_id where c.type = 'contact' and c.published and s.status = 'scheduled' and s.starts_at > now() order by s.starts_at limit 1`):

```sql
insert into registrations (course_id, course_session_id, kind, name, email, payment_choice, status)
select course_id, id, 'group', 'Proov (näidis)', 'protokoll-proov-1012.naidis@example.test', 'full', 'awaiting_prepayment'
from course_sessions where id = <that session> returning id;
```

  It waits for its prepayment and has no seat hold, so it takes no seat on the public calendar (`seats.ts takesSeat`); the screen lists it with "ootab ettemaksu" (the admin's Registreerimised badge counts it until the clean-up). Note its id (R) in the ledger. The course's headings are not touched: if the course has none, the screen shows only "Üldised märkused", which is enough for the check (the headings are proven by the e2e run).
- [ ] **Step 8: Live check behind the gate**, as an admin with the preview cookie (Dim's browser):
  1. **The screen.** Kalender → that session's drawer → "Protokollid": the course, its day and city in the header; "Proov (näidis)" with "ootab ettemaksu" among the session's students (Maria's own students are listed too: open none of them). Select her; type a line in "Üldised märkused"; "Salvestatud HH:MM" appears. Railway: `select version, sent_at is null from protocols where registration_id = R` → `1 | t`.
  2. **Two tabs.** Open the same screen in a second tab, type there, wait for "Salvestatud"; type in the first tab: it shows "Seda protokolli muudeti vahepeal …" with its own unsaved line, and the stored text is the second tab's. Close the second tab.
  3. **The send.** Registreerimised → R's drawer → "Ava protokoll" → "Saada" (the single student's primary button): the protocol locks ("Saadetud …"). Railway: `select sent_version = version, sent_at is not null from protocols where registration_id = R` → `t | t`; `select client_id is not null from registrations where id = R` → `t` (the send made her account); no mail went out (the address is a sample one; Vercel's log has `[protocols] registration R: sent` and no `the mail sent` line).
  4. **Her side.** Sign her in as phase 2a Task 11 step 7 does: insert one `client_login_tokens` row for the exact address in Railway (`hash` = SHA-256 hex of a random 32-byte base64url token, `code_hash` = SHA-256 hex of `${hash}:<six digits>`, `expires_at` = now + 30 min), then open `https://mslab.ee/api/konto/verify?t=<token>&p=R` in the same browser (it has the preview cookie the gate needs; her session is a cookie of its own beside the admin's): it lands on `/konto/protokoll#id=R` with the course, the day and the line Maria wrote. Back on Minu koolitused: the card has "Vaata protokolli" and the feedback card "Kuidas koolitus läks?".
  5. **"Muuda" and "Saada uuesti".** In the admin: "Muuda", change the line, "Salvestatud", "Saada uuesti". Her page (reload) shows the new line.
  6. **The feedback.** On her dashboard: "Jäta tagasiside" → answer the score, two choices and the message → "Aitäh, et oled osa …". Railway: `select answers ? 'score', locale, submitted_at is not null from course_feedback where registration_id = R` → `t | et | t`. Maria's "Uus tagasiside: Proov (näidis), …" reaches her inbox (ask her) and Dim's Telegram; Vercel's log has `[feedback] registration R: Maria notified by e-mail: true, Telegram: true`. The card is gone from the dashboard.
  7. **Maria's view.** `/admin/tagasiside`: the answer at the top, its course with its average; the row opens the answers in Maria's wording; Õpilased → the sample student's drawer and R's registration drawer show them too. The menu has "Tagasiside" after "Maksed"; the overview's "Täna" card is hidden unless a session is today.
- [ ] **Step 9: Clean-up, by SQL on Railway, of that exact address only.** Never `like '%naidis@example.test'`: Maria's 11 demo registrations use that pattern. Read before deleting (`select id from registrations where email = '…'` → R alone), then:

```sql
delete from registrations where email = 'protokoll-proov-1012.naidis@example.test';      -- with it its protocol and feedback (on delete cascade)
delete from client_login_tokens where email = 'protokoll-proov-1012.naidis@example.test';
delete from clients where email = 'protokoll-proov-1012.naidis@example.test';            -- with it her sessions, favourites, access, terms
delete from subscribers where lower(email) = 'protokoll-proov-1012.naidis@example.test';
```

  Check: each of `registrations`, `client_login_tokens`, `clients`, `subscribers` and `payments` has 0 rows of that address; `select count(*) from protocols` and `select count(*) from course_feedback` are what they were before Step 7 (0, unless Maria has begun using them meanwhile: then her rows are untouched); the 11 demo registrations are still there (`select count(*) from registrations where email like '%.naidis@example.test'` → 11, read-only).
- [ ] **Step 10: Durations.** From the runtime logs, note the max and median of `POST /api/admin/protokoll` and of the send action's request (`POST /admin/protokollid`).
- [ ] **Step 11: What stays for the launch** is `docs/launch-checklist.md` §11 (Maria's answers to the assumptions, the course headings, the wording sheet, "Vastas ootustele", the Russian texts, the privacy line). Migration 0008 (the drop of `courses.modules`) stays as planned in phase 3a: code first, then the migration; the migrations count afterwards is 9.

---

## Wording appendix (for Dim's approval)

Every text this phase adds, by its key. **Spec** marks a text the spec gives (used verbatim; the Russian with a no-break space, U+00A0, after a one-letter preposition: a literal character in this plan's dictionary lines, as in many lines of `ru.ts` already). **Draft** marks a text this plan proposes: Dim approves or changes it before Task 13 (a change is the dictionary line only; every test that names a text reads it from the dictionary or is updated with it). The Russian is a draft for the native-speaker check in every case (`docs/launch-checklist.md` §11). The admin and Maria's own mail and Telegram are Estonian only.

### The student's mails (`account.protocolMail`, Task 3)

| Key | ET | RU | |
|---|---|---|---|
| `subjectFirst` | Sinu koolituse protokoll on valmis | Протокол вашего обучения готов | Spec |
| `subjectAgain` | Sinu koolituse protokolli on uuendatud | Протокол вашего обучения обновлён | Spec |
| `leadFirst` | Sinu koolituse protokoll on valmis. | Протокол вашего обучения готов. | Draft (the subject as a sentence) |
| `leadAgain` | Sinu koolituse protokolli on uuendatud. | Протокол вашего обучения обновлён. | Draft |
| `button` | Vaata protokolli | Посмотреть протокол | Spec |
| `valid` | Kood ja nupp kehtivad 30 minutit. Hiljem leiad protokolli Minu koolituste lehelt. | Код и кнопка действуют 30 минут. Позже протокол можно найти на странице «Мои курсы». | Draft (with the code under the button: an owner default) |
| `feedback` | Soovi korral jäta meile tagasisidet | По желанию оставьте нам отзыв | Spec (first send only) |

The mail's greeting, the course box (title, day, place), the code's lines (`account.mail.codeIntro` "Sinu sisselogimiskood:", `account.mail.confirm.codeHere` and `codeLink`) and the signature are the existing mail parts.

### The student's account (`account.*`, Tasks 7–8)

| Key | ET | RU | |
|---|---|---|---|
| `dashboard.viewProtocol` | Vaata protokolli | Посмотреть протокол | Spec |
| `protocol.title` | Koolituse protokoll | Протокол обучения | Draft (the page's title) |
| `protocol.practice` | Praktiline osa | Практическая часть | Draft |
| `protocol.general` | Üldised märkused | Общие замечания | ET spec, RU draft |
| `protocol.sent` | Saadetud {date} | Отправлен {date} | Draft |
| `protocol.notFound` | Seda protokolli ei leitud. | Этот протокол не найден. | Draft |
| `protocol.loading` | Laadin protokolli… | Загружаем протокол… | Draft |
| `dashboard.feedbackCard.question` | Kuidas koolitus läks? | Как прошло обучение? | Spec |
| `dashboard.feedbackCard.open` | Jäta tagasiside | Оставьте отзыв | Spec |
| `dashboard.feedbackCard.dismiss` | Ei soovi | Не хочу | Spec |
| `dashboard.feedbackCard.dismissFailed` | Ei õnnestunud. Proovi uuesti. | Не получилось. Попробуйте ещё раз. | Draft |
| `feedback.title` | Sinu kogemus MS LAB koolitusel | Ваш опыт обучения в MS LAB | ET Maria's paper form; RU draft |
| `feedback.lead` | Vasta neile küsimustele, millele soovid. | Ответьте на те вопросы, на которые хотите. | Draft |
| `feedback.questions.*` | the ten questions and their options of spec §7, as there | as there (with the no-break space after в and с) | Spec (ET owner-approved; option 2b "Vastas ootustele": Maria to confirm) |
| `feedback.count` | {n} / {max} | {n} / {max} | Draft |
| `feedback.submit` | Saada tagasiside | Отправить отзыв | Draft |
| `feedback.sending` | Saadan… | Отправляю… | Draft |
| `feedback.empty` | Vasta vähemalt ühele küsimusele. | Ответьте хотя бы на один вопрос. | Draft |
| `feedback.thanks` | Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks! | Спасибо, что вы часть начала и роста учебного центра MS LAB. Ваш отзыв помогает нам становиться ещё лучше! | Spec |
| `feedback.sent` | Tagasiside on juba saadetud. Aitäh! | Отзыв уже отправлен. Спасибо! | Draft (spec §7 "already sent") |
| `feedback.notOpen` | Sellele koolitusele ei saa praegu tagasisidet anda. | Для этого обучения сейчас нельзя оставить отзыв. | Draft |
| `feedback.loading` | Laadin… | Загрузка… | Draft |

The form's failure lines are the site's own (`forms.errorTooMany`, `forms.errorGeneric`); its way back is "Minu koolitused" (`account.shell.courses`).

### Maria's notice (`server/messages.ts feedbackSummary`, Task 8)

| Part | ET | |
|---|---|---|
| Subject, Telegram | Uus tagasiside: {nimi}, {koolitus}, {score}/10 (without ", {score}/10" when no score was given) | Spec |
| Body | the subject; "Õpilane: {nimi}", "E-post: {aadress}", "Koolitus: {koolitus}, {päev}"; then each answered question and its answer in the form's Estonian words; "Admin: …/admin/tagasiside" | Draft (the lines as Maria's other notices have them) |

### The admin (`src/i18n/dict/admin.ts`, Estonian only)

**The course editor** (`courseEditor`, Task 4)

| Key | Text | |
|---|---|---|
| `sections.protocolStages` | Protokolli punktid | Spec |
| `fields.protocolStage` | Punkt | Draft (the field's hidden label: "Punkt 1") |
| `fields.protocolStagesHint` | Koolituspäeva protokolli etapid selles järjekorras, nt Ettevalmistus, Kulmude analüüs. Kirjuta need keeles, milles protokolli kirjutad. Muudatus kehtib protokollidele, mida pole veel alustatud. | Draft |
| `fields.protocolStagesEmpty` | Punkte veel pole: protokollis on siis ainult üldised märkused. | Draft |
| `fields.protocolStagesAdd` | Lisa punkt | Draft |
| `fields.protocolStagesFull` | Rohkem kui 30 punkti ei saa lisada. | Draft |

**The course day's screen** (`protocols`, Tasks 5–6)

| Key | Text | |
|---|---|---|
| `eyebrow` | Koolituspäev | Draft |
| `title`, `open` | Protokollid | Spec |
| `openOne` | Ava protokoll | Spec |
| `notFound` | Seda toimumist või registreeringut ei leitud, või pole see kontaktkoolitus. | Draft |
| `toCalendar` | Kalendrisse | Draft |
| `toRegistration` | Registreeringu juurde | Draft |
| `individual` | Individuaalkoolitus | Draft |
| `sessionCancelled` | Toimumine on tühistatud | Draft |
| `hidden` | Tühistatud registreeringuid peidetud: {n} | Draft |
| `empty` | Sellel toimumisel pole õpilasi. | Draft |
| `cancelledOne` | Registreering on tühistatud: protokolli ei näidata ega saadeta. | Draft |
| `students` | Õpilased | Draft (the list's label) |
| `awaiting` | ootab ettemaksu | Spec |
| `mark.draft` / `mark.sent` / `mark.changed` | Mustand / Saadetud / Muudetud | Spec |
| `unsavedMark` | Salvestamata | Draft (a chip whose text the server has not confirmed) |
| `practice` | Praktiline osa | Draft |
| `general` | Üldised märkused | Spec |
| `noStages` | Koolitusel pole protokolli punkte. Lisa need koolituse juures („Protokolli punktid“); seni on siin ainult üldised märkused. | Draft |
| `saved` | Salvestatud {time} | Spec ("Salvestatud HH:MM") |
| `pending` | Salvestamata muudatused | Draft (the editor's existing words) |
| `saving` | Salvestan… | Draft |
| `retrying` | Salvestamata — proovin uuesti | Spec |
| `tooLongStatus` | Salvestamata — üks tekst on liiga pikk | Draft |
| `signedOut` | Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles. | Draft |
| `gone` | Seda registreeringut enam ei ole. Tekst on selles seadmes alles. | Draft |
| `notKept` | Seda teksti ei saa selles seadmes hoida (brauseri mälu on täis või suletud). Ära sulge lehte enne, kui see on salvestatud. | Draft (the browser could not keep an unsaved text) |
| `tooLong` | Liiga pikk: {n} / {max} märki. Lühenda, siis salvestan. | Draft |
| `conflict` | Seda protokolli muudeti vahepeal teises seadmes või aknas. Näed nüüd salvestatud teksti; selle ekraani salvestamata tekst on allpool. | Draft (spec "a short notice") |
| `conflictLost` | Selle ekraani salvestamata tekst | Draft |
| `dismiss` | Selge | Draft |
| `locked` | Saadetud {date}. Õpilane näeb seda versiooni. | Draft |
| `send` | Saada | Spec |
| `sending` | Saadan… | Draft |
| `edit` | Muuda | Spec |
| `resend` | Saada uuesti | Spec |
| `sendAll` | Lukusta ja saada kõik | Spec |
| `editing` | Muuda teksti — salvestan ise. Siis saad selle uuesti saata. | Draft |
| `confirm.title` | Lukustan ja saadan protokollid | Draft |
| `confirm.will` | Saavad protokolli: {names} | Draft |
| `confirm.skipped` | Jäävad vahele, sest protokoll on tühi: {names} | Draft |
| `confirm.already` | Juba saadetud, uut pole: {names} | Draft (a line the spec does not name; owner decision 5) |
| `confirm.nothing` | Pole midagi uut saata. | Draft |
| `confirm.yes` / `confirm.no` | Saada / Tagasi | Draft |
| `result.sent` | Saadetud: {names}. | Draft |
| `result.notSent` | Ei saadetud: {names}. {reason} | Draft (one line per reason; {reason} is a `sendErrors` text) |
| `sendErrors.empty` | Protokoll on tühi. Kirjuta midagi enne saatmist. | Draft (spec "a short notice") |
| `sendErrors.unsaved` | Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi. | Draft |
| `sendErrors.stale` | Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle. | Draft |
| `sendErrors.cancelled` | Registreering on tühistatud: protokolli ei saadeta. | Draft |
| `sendErrors.notFound` | Seda registreeringut ei leitud. | Draft |
| `sendErrors.failed` | Saatmine ei õnnestunud. Proovi uuesti. | Draft |

**The overview** (`overview.today`, Task 5)

| Key | Text | |
|---|---|---|
| `title` | Täna | Spec |
| `students` | Õpilasi: {n} | Draft |

**Tagasiside** (`nav.feedback`, `feedback`, Task 9)

| Key | Text | |
|---|---|---|
| `nav.feedback`, `feedback.title`, `feedback.section` | Tagasiside | Spec |
| `feedback.eyebrow` | Õpilased | Draft |
| `feedback.lead` | Õpilaste vastused koolituse tagasiside vormile, uuemad eespool. Vali koolitus, et näha selle keskmist hinnet ja iga vastusevariandi arvu. | Draft |
| `feedback.filterLabel` | Koolitus | Draft |
| `feedback.all` | Kõik koolitused | Draft |
| `feedback.byCourse` | Koolituste kaupa | Draft |
| `feedback.count` | Vastuseid: {n} | Draft |
| `feedback.scored` | Hindeid: {n} | Draft |
| `feedback.average` | Keskmine hinne: {score} / 10 | Draft |
| `feedback.noScore` | Hinnet pole antud | Draft |
| `feedback.empty` | Tagasisidet pole veel antud. | Draft |
| `feedback.emptyFiltered` | Selle koolituse kohta pole tagasisidet. | Draft |
| `feedback.col.*` | Kuupäev · Õpilane · Koolitus · Hinne · Vastuseid · Keskmine hinne | Draft |
| `feedback.drawer.label` / `close` / `notFound` | Tagasiside: {name} / Sulge / Seda tagasisidet ei leitud. | Draft |
| `feedback.submitted` | Saadetud {date} | Draft |
| `feedback.inRussian` | Vastas vene keeles | Draft |
| `feedback.toStudent` / `toRegistration` | Õpilase juurde / Registreeringu juurde | Draft |
| `feedback.none` | Tagasisidet pole antud. | Draft (the drawers) |

---

## Self-review

### Spec coverage

| Spec section | Task |
|---|---|
| 1 Goal (the protocol on the course day, the send, the student's page, the feedback form, Maria's page) | 2–3, 5–9 |
| 2 D1 one protocol per registration, a practice part and a training part, sent together | 1 (the table, `stagesFrom`), 2 (the save), 5 (the screen), 3 (the frozen copy holds both) |
| 2 D2 text only | 1 (no file column), 12 (out of scope stays out) |
| 2 D3 the send makes the account and mails a login link; everyone reads it on the dashboard | 3 (`addClient`, the link, `issueClientLogin` with the mail), 7 (the card, the page) |
| 2 D4 a sent protocol locked; "Muuda"; the last sent version until "Saada uuesti", which mails "uuendatud" | 3 (`sent` frozen, `again`, the mail), 6 (the buttons), 7 (only `sent` served), 11 (e2e 4) |
| 2 D5 fixed questions from Maria's paper form, ET and RU, not editable | 1 (`FEEDBACK_*`), 8 (the texts, the form) |
| 2 D6 autosave and one-tap entry points | 5 |
| 2 Assumptions 1–3 | 2 (contact courses only: an e-course's registration has no screen and no protocol), 5 (individual registrations get "Ava protokoll"), 12 (the launch checklist asks Maria) |
| 3 Data: `protocol_stages`, `protocols`, `course_feedback`, the limits, the status table, the open rule | 1 |
| 3 Account deletion | 10 |
| 3 0008 for the drop of `courses.modules` | 1 (the texts), 12, 13 (the count stays 9 after it) |
| 4 Route and its two ways in | 5 (the page), 2 (`protocolScreen`) |
| 4 Entry points: Kalender, Registreerimised, "Täna" | 5 (and 11: e2e 1, 3, 4) |
| 4 Layout: header, the list or the chips, the marks, "ootab ettemaksu", cancelled hidden, the growing boxes, one-tap switching | 5 |
| 4 Autosave: when, the version, the status line, the browser's copy, a refused save | 2 (the server), 5 (the browser), 11 (e2e 2) |
| 4 Sending: "Saada", "Lukusta ja saada kõik" with its confirmation, only what is new | 3 (`sendProtocol`, `sendProtocols`), 6 (`planSendAll`, the parts) |
| 4 After sending: read-only, "Muuda", "Saada uuesti" | 6 |
| 5 The card's "Vaata protokolli"; the static page; the student's language; only the sent copy; ownership; the gate | 7 |
| 6 The two mails, no notes, the registration's language, after the commit; Maria's notice | 3, 8 |
| 7 The form's route, rate limit, `private, no-store`, owner only, the open rule, one per registration | 8 |
| 7 The card with "Ei soovi", no reminders | 8 |
| 7 The answers: nothing required, one needed, 2000 characters, keys | 1 (`checkFeedback`), 8 |
| 7 The ten questions; option 2b; the closing line | 8 (the texts), 12 (Maria confirms 2b) |
| 7 Maria's view: `/admin/tagasiside` after "Maksed", newest first, 50 a page, the course filter, the average and the counts, a row's answers; the drawers | 9 |
| 8 Building blocks | 1 (`domain/protocols.ts`), 2/5/7/9 (`db/queries/protocols.ts`), 2–3 (`server/protocols.ts`), 3 (`server/actions/admin-protocols.ts`), 7–8 (`account-api.ts`), 3 (`account-mail.ts`), 8 (`messages.ts`, and `server/course-feedback.ts`), 4–6 and 9 (admin components), 7–8 (account components) |
| 8 Sending in one transaction; the mail after the commit; "Saada kõik" each separately with failures named | 3, 6 |
| 8 Logs carry ids only | 2, 3, 8 (and the runbook, 12) |
| 9 Edge cases | 10 (the table there says where each is tested) |
| 10 Unit | 1 (the status, the stage limits, the open rule at Tallinn's date edges, the answers' check), 5, 6, 7, 8 (the DOM tests) |
| 10 Database (PGlite) | 2 (first save copies the headings; an old version refused), 3 (the frozen copy; a later edit leaves `sent`; the account, the login and the link; resend), 7–8 (ownership 404), 10 (deletion), 9 (the averages and counts) |
| 10 Real Postgres: two sends at once, one copy and one mail | 11 (`protocols-race.spec.ts`) |
| 10 End to end 1–7 | 11 (`protocols.spec.ts`: one test each) |
| 10 Gate | 7, 8 (`gate.spec.ts`, `site-gate.test.ts`), 11 (the gate run) |
| 11 Go-live: 0007 first, the deploy, the live check with a sample student, the clean-up of the exact address | 13 |
| 12 Out of scope (photos, printing and PDF, practice packages, …) | nothing built for them |

### Spec against the code

| # | The spec says | The code | The plan |
|---|---|---|---|
| 1 | `/konto/protokoll?id=<registrationId>` and `/konto/tagasiside?id=<registrationId>` | An account page is a static shell that never takes a query: the middleware answers one with a 303 (`site-routing.ts accountShellTarget`), and `account-guards.test.ts` refuses code that builds one | The id travels in the fragment, `#id=<n>` (Task 7 `useHashId`); `id` joins `FRAGMENT_PARAMS`, so a typed or old `?id=` lands on `#id=` (Tasks 7–8, `cache.spec.ts`). The API keeps `?id=`. |
| 2 | Ownership: "the account's client id, or its address for registrations made without one" | The dashboard reads `registrations.client_id` only; records made without an account are linked at her login (`linkClientRecords`) or by `addClient` | The same rule as the dashboard (`client_id`), so she sees a protocol exactly when she sees its card; the send links the registration (Tasks 3, 7, 8). |
| 3 | Sending: "1. Lock the registration row (`lockRegistration`)", then freeze, then create the account and link | The logins, `addClient` and `deleteClient` take the address lock (`lockAddress`) and then write registrations; locking the registration first and then calling `addClient` would close a cycle with them | The send takes the address lock first, then the registration, then the protocol row (Task 3); `deleteClient` takes the address and then her registrations (Task 10). A registration payment (session → registration → payment) never waits for the address lock. |
| 4 | "Create the account and the login if needed" inside the send | A login's 30 minutes should start with its mail; `ecourseOpenMail`'s login is issued with the mail after its commit | The account and the link are in the transaction; the login is issued with the mail, after the commit (Task 3), for every protocol mail while the address has fewer than 3 live logins. |
| 5 | §8 lists "reopen" in `server/protocols.ts`; §3 says "Muuda" only unlocks the screen | — | No server reopen: "Muuda" is screen state, and the first saved edit raises `version` (Tasks 2, 6). |
| 6 | The "Täna" card on "Avaleht" | `/admin/avaleht` is the site's home page editor; the admin's own front page is the overview `/admin` ("Ülevaade") | "Täna" is a card on the overview (Task 5). |
| 7 | "Create on first open" | A page render (GET) that writes is a side effect on every look, and "none" (no row) is a status of its own | A protocol is created by its first save, with the course's headings then; the save carries the headings, and a first save for headings the course no longer has is refused with the new ones (Task 2). |
| 8 | The admin side through "server actions behind `requireAdmin`" | A server action cannot be aborted or given a timeout from the browser, and Next.js runs a page's actions one after another, so a hung save would hold every later one | The autosave posts to a JSON route, `POST /api/admin/protokoll` (`withAdmin`, `maxDuration = 30`; a 10 s timeout and retries in the browser); the sends stay server actions (`adminAction`) (Tasks 2, 3). |
| 9 | The mail's button carries a live login and opens the protocol | `GET /api/konto/verify` always went to `/konto#sisse` | `verifyLink` gets an optional protocol id (`&p=<n>`), and verify lands on `/konto/protokoll#sisse&id=<n>`; `useAccount`'s login mark keeps the id (Task 3). |
| 10 | The account API's new routes: `GET /protokoll`, `POST /tagasiside`, `POST /tagasiside/peida` | The form's static shell can learn its course, and whether it was answered, only from an API | `GET /api/konto/tagasiside?id=` is added (owner only, by the open rule) (Task 8). |
| 11 | The open rule: not cancelled, and a sent protocol or a group session started before today | §9: "Session cancelled: no feedback opens for its registrations by date" | The date path also needs the session not called off (Task 1 `feedbackOpen`). |
| 12 | "Saada kõik" sends draft-with-text and changed | A sent protocol whose new text is still on its way to the server reads "sent" until its save lands | `planSendAll` counts it as changed, saves everything first, and sends the versions the server confirmed (Task 6). |
| 13 | The suggested task list (12 tasks) | The send, its locks and its mails are a unit of their own, apart from the save | 13 tasks: the save (2) and the send (3) are separate; the feedback form (8) and Maria's page (9) too; the deletion and §9 (10); the e2e (11); the docs (12); the go-live (13). |
| 14 | §11: the live check with "a sample student `*.naidis@example.test`" | A sample address is never mailed, so no login reaches it; a confirmed sample registration would take a seat of Maria's public calendar | One exact address (`protokoll-proov-1012.naidis@example.test`, "Proov (näidis)"), its registration waiting for its prepayment (no seat taken), signed in through a token row in Railway as phase 2a did, cleaned up by that address only (Task 13). |
| 15 | §8: "Saada kõik" runs each student separately; one failure doesn't stop the others | Saving everything first and stopping when one save failed would stop them all | Each listed protocol saves on its own; the confirmed ones are sent, an unsaved one is left out and named, and the summary gives each name with its reason (Task 6). |

Exact names: everything the spec names exists (`lockRegistration`, `lockForPayment`, `addClient`, `issueClientLogin`, `deleteClient`, `ecourseOpenMail`, `requireAdmin`, `notifyMaria`) or is new in this plan (`domain/protocols.ts`, `db/queries/protocols.ts`, `server/protocols.ts`, `server/actions/admin-protocols.ts`). The one new file the spec does not name is `server/course-feedback.ts` (the form's server side, beside `account-api.ts` as `client-data.ts` is).

### Placeholder scan

No "TBD", "TODO", "implement later", "similar to Task N" or "add error handling" in the plan; every code step has its code, every test its assertions, every command its expected result. The texts marked Draft in the Wording appendix are real texts awaiting approval, not placeholders.

### Type and name consistency

- Task 1 → all: `ProtocolStage`, `SentProtocol`, `Protocol`, `CourseFeedback`, `ProtocolStatus`, `protocolStatus`, `readStages`, `checkStages`, `stagesFrom`, `hasText`, `overLimit`, `newToSend`, `feedbackOpen`, `feedbackOpenFor` (Task 8's two callers), `FEEDBACK_CHOICES`, `FEEDBACK_TEXTS`, `FEEDBACK_ORDER`, `FEEDBACK_TEXT_MAX`, `FeedbackAnswers`, `isChoice` (Task 8's form), `checkFeedback`, `summarizeFeedback`, `FeedbackSummary`, `FeedbackQuestionTexts`, `feedbackQuestions` (the one cast: Tasks 8 and 9), `answerText`; `toStorable` and `CONTROL_CLASS` from `lib/to-storable.ts` (storable.ts builds its control rule from it).
- Tasks 2–3 → 5, 6, 10, 11: `ProtocolDraft`, `draftOf`, `protocolScreen`, `ScreenData`, `ScreenStudent`, `saveProtocol(db, SaveInput, now)`, `SaveResult`, `handleSave`, `MAX_SAVE_CHARS`; `sendProtocol(SendDeps, { registrationId, version })`, `SendResult`, `SendOutcome`, `sendProtocols`, `BulkResult`, `sendProtocolAction`, `sendProtocolsAction`; `verifyLink(siteUrl, token, pageLocale, protocolId?)`, `protocolUrl`, `feedbackUrl`, `protocolMail`.
- Task 5 → 6, 11: `ProtocolAutosave` (`get`, `ids`, `save`, `saveAll`, `markSent`, `setSending`, `unsaved`), `Entry.sending`, `Entry.kept`, `statusOf`, `written`, `unsavedEntry`, `remember`, `SENT_MAX_CHARS`, `localKey` (`mslab-protocol:<id>`), `conflictKey` (`mslab-protocol-conflict:<id>`), `ScreenView`, `ScreenStudentView`, `todaySessions`; the selectors listed in Task 11's Interfaces.
- Task 7 → 8, 10: `queryId`, `studentProtocol`, `StudentProtocol`, `protocolSent` on the cards, `useHashId`, `hashId`, `ProtocolTexts`, `AccountNotFound`, `AccountPage.module.css` (`page`, `column`, `title`, `wait`).
- Task 8 → 9, 10, 11: `feedbackState`, `submitFeedback`, `hideFeedback`, `notifyFeedback`, `FeedbackNotice`, `feedbackSummary`, `FeedbackPrompt`, `Dashboard.feedback`, `FeedbackTexts`.
- Task 9 → 11: `FeedbackRow`, `pageFeedback`, `feedbackById`, `feedbackOf`, `feedbackStats`, `CourseFeedbackStats`, `FeedbackAnswers`, `formatScore`, `ClientDetail.feedback`, `Section` `"feedback"`.
- The account-guards lists, in order, after Task 8: handlers `…, "payRegistration", "protocol", "feedbackForm", "sendFeedback", "dismissFeedback", "terms", "deleteAccount"`; the router `…, "GET /protokoll protocol", "GET /tagasiside feedbackForm", "POST /tagasiside sendFeedback", "POST /tagasiside/peida dismissFeedback", …`.
- The menu after Task 9: Ülevaade, Koolitused, Kalender, Registreerimised, Maksed, Tagasiside, Õpilased, … (`admin.test.ts`, `admin-inbox.spec.ts`); `admin-guards.test.ts` pages gain `protokollid` (Task 5) and `tagasiside` (Task 9); `admin-load.spec.ts` gains `/admin/protokollid` and `/admin/tagasiside`.
- `old-safari.test.ts`'s `BROWSER_FILES`: `to-storable.ts`, `domain/protocols.ts` (Task 1), `ProtocolStagesEditor.tsx` (Task 4), `protocol-autosave.ts`, `ProtocolScreen.tsx`, `GrowingText.tsx` (Task 5), `ProtocolSend.tsx` (Task 6), `useHashId.ts`, `AccountNotFound.tsx`, `ProtocolPage.tsx` (Task 7), `FeedbackCard.tsx`, `FeedbackForm.tsx` (Task 8).
- `colour-tokens.test.ts` gains every new or changed stylesheet: `ProtocolScreen.module.css` and `overview.module.css` (Task 5), `AccountPage.module.css` and `ProtocolPage.module.css` (Task 7), `FeedbackForm.module.css` (Task 8; `CoursesTab.module.css` is listed already), `FeedbackAnswers.module.css` and `tagasiside/feedback.module.css` (Task 9; `registrations.module.css` is listed already). Task 4 adds no stylesheet: the headings' list uses the course editor's own classes.

### Review Focus check

| Line | Its tests (each in the task that owns the rule) |
|---|---|
| 1 Flaky Wi-Fi | Task 2 `protocols-save.test.ts` "Review Focus 1" (a lost answer's save again is no conflict); Task 5 `protocol-autosave.test.ts` describe "a long day on flaky Wi-Fi (Review Focus 1)" (with six more failed saves after the lost answer, and `remember`), its storage-full test and `protocol-screen-dom.test.ts`'s; Task 11 `protocols.spec.ts` "Review Focus 1" |
| 2 Two devices | Task 2 "Review Focus 2"; Task 5 describe "two devices (Review Focus 2)" (the notice's words outlive a reload until "Selge") and `protocol-screen-dom.test.ts` (the notice); Task 6 (a send never comes back stale from Maria's own typing) |
| 3 Cancelled or moved mid-day | Task 2 "Review Focus 3" (the save), Task 3 "Review Focus 3" (the send refused), Task 6 `protocol-send-dom.test.ts` "… Review Focus 3: each refusal says why" and "… one line per reason" (a cancelled one in "Saada kõik" named with why, the others sent), Task 10 `protocols-edges.test.ts` (moved; cancelled in "Saada kõik"; reinstated) |
| 4 Huge pasted text | Task 2 "Review Focus 4" (the server), Task 5 describe "huge pasted text (Review Focus 4)" and `protocol-screen-dom.test.ts` "Review Focus 4" |
| 5 A Russian-speaking student | Task 3 `protocol-mail.test.ts` and `protocols-send.test.ts` "Review Focus 5", Task 7 `account-protocol-dom.test.ts` "Review Focus 5", Task 8 `feedback.test.ts` and `feedback-form-dom.test.ts` "Review Focus 5" |

### For the owner (Dim, and Maria where named)

1. **Option 2b** (Maria): the paper says "Vastasin ootustele", the site "Vastas ootustele".
2. **The spec's assumptions 1–3** (Maria): contact courses only; individual courses included; the certificate in phase 3d.
3. **The Draft texts** of the Wording appendix (Dim), and the Russian native-speaker check of every new key.
4. **The student's page shows only the stages Maria wrote something under** (and the general notes); Maria's screen always shows every heading. A default while Dim has not answered; easy to change (one filter line in `ProtocolPage.tsx` and its test).
5. **The confirmation's third line** "Juba saadetud, uut pole: {names}" (the spec names only "will get" and "skipped").
6. **"Ei soovi" hides the card only:** the first mail's link still opens the form and takes an answer.
7. **The protocol mails are not counted in the daily login-mail cap**, and every protocol mail carries a login while the address has fewer than 3 live ones (the spec names it for a new account).
8. **The six-digit code under the mail's button**, with "Kui nupp ei tööta, sisesta kood siin:", as the e-course mail has it. A default while Dim has not answered; easy to drop (the code lines in `protocolMail` and its test).
9. **"Salvestamata" on a student's chip** while her text is not confirmed by the server.
10. **Maria's Tagasiside in two steps:** without a filter, each course's count and average; with a course chosen, its counts per option.
11. **After a student deletes her account,** her registration stays on Maria's screen with nothing written, and a new send would make a new account.
12. **The live check** (Task 13) adds one temporary registration, waiting for its prepayment, to the earliest upcoming session of one of Maria's published contact courses (the admin's badge counts it for the length of the check; no public seat), changes no course's headings, and Maria gets one "Uus tagasiside: Proov (näidis), …" mail.
13. **Found on the way, outside this phase:** `src/lib/storable.ts` (`LONE_SURROGATE`) and `src/lib/typography.ts` have a lookbehind, which iOS Safari before 16.4 cannot parse. This phase's browser code avoids both files (`lib/to-storable.ts`), but the site's favourites (`lib/favourites.ts` imports storable.ts) and whatever uses typography.ts would fail on such an iPad or iPhone. A small fix of its own if old devices matter.
