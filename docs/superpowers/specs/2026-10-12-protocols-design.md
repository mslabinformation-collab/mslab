# Protocols and the course feedback form — design

Status: approved in conversation section by section on 12.10.2026 (Dim). This spec covers the old phase 3c "practical-work review", now rethought around Maria's protocols, and the end-of-course feedback form. The admin UX pass is deferred to the end of the project.

## 1. Goal

On the course day, Maria writes on a tablet a protocol for each student: notes under her own stage headings (the practice part) and general notes (the training part). Her answers of 08.10.2026:
- the protocol is per student;
- with several students she moves between them during the day, and nothing she wrote is lost;
- at the end of the day she locks the protocols and sends them;
- only then does each student see hers on the dashboard.

At the end of the course the student may fill in Maria's paper form "Sinu kogemus MS LAB koolitusel" online. It is optional, with no reminders.

Success:
- Maria can write four students' protocols during one day without a lost word, a page reload or a menu hunt.
- Sending them all takes two taps.
- The student reads hers in her account.
- Maria sees the feedback per course.

## 2. Decisions (Dim, 12.10.2026)

| # | Decision |
|---|---|
| D1 | Approach A. A registration has one protocol, in two parts: the practice part (stages with notes) and the training part (general notes). Both are sent together. |
| D2 | Text only. Photos may come later; R2 already exists. |
| D3 | Sending creates the student's account if she has none, and mails a login link. Everyone reads the protocol on the dashboard. |
| D4 | A sent protocol is locked. "Muuda" reopens it as a draft. The student keeps the last sent version until "Saada uuesti", which mails "uuendatud". |
| D5 | The feedback form's questions are fixed and copied from Maria's paper form (§7), in ET and RU. They are not editable in the admin. |
| D6 | The admin UX pass (fewer clicks across the admin) comes at the end of the project. This phase already follows its principles: autosave, one-tap entry points. |

### Assumptions, pending Maria's answers (asked 12.10)

Each assumption can only be extended, never reversed:
1. **Contact courses only.** Protocols belong to group and individual contact-course registrations. The MINI/MAXI practice packages are requests, not registrations, and get none in this phase. If Maria wants them, a later phase adds them.
2. **Individual courses get protocols too.** If Maria says group only, the individual entry point is hidden.
3. **The certificate trigger is decided in phase 3d.**

## 3. Data (migration `0007_protocols`, additive)

The planned drop of `courses.modules` becomes `0008`: code first, then the migration.

- **`courses.protocol_stages`**: `jsonb text[]`, not null, default `[]`.
  - Maria's stage headings for the course, e.g. "Ettevalmistus", "Kulmude analüüs", "Vormi määramine", "Värvimine".
  - Plain strings in the language she writes in, not translated.
  - Limits: at most 30 headings, each at most 120 characters, trimmed, no empty ones.
- **`protocols`**:
  - `id` serial;
  - `registration_id` integer, unique, not null, referencing `registrations`, on delete cascade;
  - `stages` jsonb, not null: the draft, `[{ title, note }]`, copied from the course's `protocol_stages` when the protocol is first created;
  - `general_note` text, not null, default `''`;
  - `version` integer, not null, default 1, raised by every saved change;
  - `sent` jsonb, null: the frozen copy `{ stages, generalNote }` the student sees;
  - `sent_at` timestamptz, null;
  - `sent_version` integer, null;
  - `created_at` and `updated_at`.
  - Limits: each note and the general note at most 10 000 characters.
- **`course_feedback`**:
  - `id` serial;
  - `registration_id` integer, unique, not null, referencing `registrations`, on delete cascade;
  - `answers` jsonb, null (§7);
  - `locale` text;
  - `submitted_at`, `dismissed_at` and `created_at`, all timestamptz.
  - A row is created when the student submits or presses "Ei soovi".
- **Status**, computed in `domain/protocols.ts`, never stored:

  | Status | Condition |
  |---|---|
  | none | no row |
  | `draft` (Mustand) | `sent_at` is null |
  | `sent` (Saadetud) | `version = sent_version` |
  | `changed` (Muudetud pärast saatmist) | `version > sent_version` |

  A sent protocol shows locked until Maria presses "Muuda". "Muuda" only unlocks the screen; the first saved edit raises `version`.
- **When the feedback opens:** the registration is not cancelled AND (its protocol has `sent_at`, OR the registration is a group one whose session started before today, Tallinn time).
- **Account deletion:** `server/client-data.ts deleteClient` also deletes the `protocols` and `course_feedback` of that account's registrations. The registrations and payments stay, as today.

## 4. Maria's screen on the course day

Route `/admin/protokollid`, behind `requireAdmin`. It opens one of two ways:
- `?sessioon=<id>`: every listed registration of that session;
- `?registreering=<id>`: one registration, for individual courses.

**Entry points**, each one tap:
- **Kalender:** a session's drawer gets a "Protokollid" button.
- **Registreerimised:** a registration's drawer gets "Ava protokoll".
- **Avaleht:** a new "Täna" card lists today's sessions (Tallinn date), each with a "Protokollid" button. The card is hidden on days with no session.

**Layout** (works at 390, 834 and 1194 px wide; 44 px targets):
- **Header:** the course title, date and city.
- **Student list:**
  - left on wide screens, a row of chips across the top when narrow;
  - one entry per student: name and status mark (none, Mustand, Saadetud, Muudetud);
  - confirmed registrations are listed, plus `awaiting_prepayment` ones marked "ootab ettemaksu"; cancelled ones are hidden.
- **The selected student:**
  - the practice part: each stage heading with a growing note box;
  - then "Üldised märkused" (general notes), one growing box;
  - switching student is one tap and never waits for a save.
- **Autosave:**
  - **When:** a box saves 1.5 s after typing stops, on blur, and on switching student.
  - **What a save sends:** the protocol's `version`; the server refuses a save made from an older version.
  - **Status mark:** "Salvestatud HH:MM" or "Salvestamata — proovin uuesti". *(Admin UX pass, 23.10.2026: the mark is the admin's SaveStatus chip, README A3.)*
  - **Unsaved text** is kept in the browser's storage, keyed by registration, until the server confirms it, and is retried on reconnect and on reload.
  - **A refused save** (another device saved first) reloads that protocol with a short notice, so newer text is never overwritten by a save. *(Admin UX pass B13, spec 2026-10-21 §9: the notice holds this screen's words and „Taasta minu tekst“, which writes them back into their boxes and saves them over the newer text when Maria presses it. A box she had no words in keeps what it shows; words typed since the notice opened stay, after hers; words under a heading the protocol no longer has stay in the notice. The save goes from the version the refusal brought, so it is taken unless another device saved again, which opens the notice again.)*
- **Sending:**
  - "Saada" sends one student. *(Admin UX pass, README A3: the informed „Saada protokoll {eesnimi}le“, no confirmation.)*
  - "Lukusta ja saada kõik" opens one confirmation that lists who will get a protocol and who is skipped because theirs is empty. One more tap sends them. *(Admin UX pass, README A3 and spec 2026-10-21 §9: the button is „Saada kõigile ({n})“, n the protocols it would send; its ConfirmPanel asks „Kas saadan {n} protokolli?“ with the same lines and „Jah, saada {n} protokolli“ / „Katkesta“. With nothing to send it asks nothing and says „Pole midagi uut saata.“ with the lines.)*
  - "Saada kõik" sends only protocols with something new to send: status `draft` with text, or `changed`.
- **After sending:** a sent protocol shows read-only with "Muuda". "Muuda" unlocks it, and "Saada uuesti" sends again. *(Admin UX pass: „Saada protokoll {eesnimi}le uuesti“.)*

## 5. The student's side

- **Dashboard card:** a contact course's card in "Minu koolitused" gets "Vaata protokolli" once its protocol has `sent_at`.
- **Protocol page:** `/konto/protokoll?id=<registrationId>`.
  - A static shell, like every account page; the data comes from `GET /api/konto/protokoll?id=` (`private, no-store`).
  - It shows the course, the date, the sent stages with their notes, and the general notes.
  - The page frame is in the student's language; Maria's text is shown as written.
  - Only the sent copy is ever served, never the draft.
- **Ownership:** the same rule the dashboard's registration cards use (the account's client id, or its address for registrations made without one). Any other id answers 404.
- **Gate:** the account pages stay behind the coming-soon gate until launch, as today.

## 6. Mails (texts are drafts; Dim approves them in the plan's wording sheet)

- **First send:**
  - subject: ET "Sinu koolituse protokoll on valmis" / RU "Протокол вашего обучения готов";
  - body: the course and date, then a "Vaata protokolli" / "Посмотреть протокол" button;
  - one line: ET "Soovi korral jäta meile tagasisidet" / RU "По желанию оставьте нам отзыв", linking to the form;
  - with no account yet, the account is created now (`admin-clients.ts addClient`), and the button carries a live login (`client-auth.ts issueClientLogin`), as `ecourseOpenMail` does.
- **Re-send:** ET "Sinu koolituse protokolli on uuendatud" / RU "Протокол вашего обучения обновлён", with the same button and no feedback line.
- **Privacy:** no mail contains the notes, only the link.
- **Language:** the registration's locale.
- **Timing:** each mail goes out after the send's transaction commits. A mail failure never undoes a send; the protocol is sent and visible.
- **Maria's notice** on new feedback, by mail and Telegram (Telegram still goes to Dim until launch):
  - subject "Uus tagasiside: {nimi}, {koolitus}, {score}/10" (without the score part when no score was given);
  - body: the answers in her wording.

## 7. The feedback form

Route `/konto/tagasiside?id=<registrationId>`, a static shell, posting to `POST /api/konto/tagasiside`. Rate-limited, `private, no-store`, owner only, open only by the rule in §3, one per registration (a second submit answers "already sent").

**The card:** "Kuidas koolitus läks? Jäta tagasiside" (RU "Как прошло обучение? Оставьте отзыв") appears on the dashboard once the form opens. "Ei soovi" (RU "Не хочу") posts `POST /api/konto/tagasiside/peida` and hides the card for good. No reminder mails.

**Answers:** nothing is required, but at least one answer is needed to submit. The free texts take at most 2000 characters each. Answers are stored as keys, so a wording fix never breaks old answers.

| # | ET (Maria's wording; the RU is a draft for the native check) | Key and options |
|---|---|---|
| 1 | Kuidas hindad koolitust tervikuna skaalal 1–10? / Как вы оцениваете обучение в целом по шкале от 1 до 10? | `score`: 1–10, a row of number buttons |
| 2 | Kas koolitus vastas sinu ootustele? / Оправдало ли обучение ваши ожидания? | `expectations`: `exceeded` Ületas ootusi / Превзошло ожидания · `met` Vastas ootustele / Оправдало ожидания · `not_met` Ei vastanud ootustele / Не оправдало ожиданий |
| 3 | Kas koolituse sisu oli arusaadav ja loogiliselt üles ehitatud? / Было ли содержание обучения понятным и логично выстроенным? | `clarity`: `very_clear` Väga selge / Очень понятно · `fairly_clear` Pigem selge / Скорее понятно · `needs_work` Vajaks parandamist / Нуждается в доработке |
| 4 | Kas teooria ja praktika tasakaal oli sinu jaoks sobiv? / Подходил ли вам баланс теории и практики? | `balance`: `ideal` Jah, ideaalne / Да, идеально · `more_practice` Sooviksin rohkem praktikat / Хотелось бы больше практики · `more_theory` Sooviksin rohkem teooriat / Хотелось бы больше теории |
| 5 | Kas tunned, et oled valmis peale koolitust iseseisvalt teenust pakkuma? / Чувствуете ли вы, что после обучения готовы самостоятельно оказывать услугу? | `ready`: `fully` Jah, täiesti / Да, полностью · `mostly` Pigem jah, natuke harjutamist vajab / Скорее да, нужно немного практики · `rather_not` Pigem ei / Скорее нет · `no` Ei / Нет |
| 6 | Kuidas hindad koolitaja juhendamisoskust ja selgitusi? / Как вы оцениваете умение преподавателя направлять и объяснять? | `trainer`: `excellent` Väga professionaalne ja toetav / Очень профессионально и с поддержкой · `good` Hea / Хорошо · `satisfactory` Rahuldav / Удовлетворительно · `needs_growth` Vajaks arengut / Есть куда расти |
| 7 | Kas tundsid end koolitusel turvaliselt ja toetatuna? / Чувствовали ли вы себя на обучении в безопасности и при поддержке? | `safe`: `very` Jah, väga / Да, очень · `rather_yes` Pigem jah / Скорее да · `rather_not` Pigem ei / Скорее нет |
| 8 | Kas õppematerjalid olid piisavad ja arusaadavad? / Были ли учебные материалы достаточными и понятными? | `materials`: `yes` Jah / Да · `rather_yes` Pigem jah / Скорее да · `rather_not` Pigem ei / Скорее нет · `no` Ei / Нет |
| 9 | Kas soovitaksid seda koolitust ka teistele? Miks? / Порекомендовали бы вы это обучение другим? Почему? | `recommend`: free text |
| 10 | Soovi korral jäta meile väike tagasiside või sõnum: / По желанию оставьте нам короткий отзыв или сообщение: | `message`: free text |

- **Option 2b:** the paper says "Vastasin ootustele"; this spec uses "Vastas ootustele" (a typo fix, to be confirmed with Maria).
- **After submitting:** ET "Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!" / RU "Спасибо, что вы часть начала и роста учебного центра MS LAB. Ваш отзыв помогает нам становиться ещё лучше!"

**Maria's view:**
- **The "Tagasiside" page:** a new admin page at `/admin/tagasiside`, in the menu after "Maksed":
  - newest first, 50 a page, with a course filter;
  - per course: the average score, and the count for each option of each choice question;
  - a row opens the full answers.
- **In the drawers:** each answer also shows in the student's Õpilased drawer and in the registration's drawer.

## 8. Building blocks

| Unit | Responsibility |
|---|---|
| `src/domain/protocols.ts` | Pure: the status, copying the stages, the limits, the feedback questions and keys, answer validation, the open rule. |
| `src/db/queries/protocols.ts` | Reads for the screen, the dashboard, the student page and the admin feedback page. |
| `src/server/protocols.ts` | Create on first open; save with the version check; send (see below); reopen. |
| `src/server/actions/admin-protocols.ts` | Server actions behind `requireAdmin`, same-origin only. |
| `src/server/account-api.ts` | New routes: `GET /protokoll`, `POST /tagasiside`, `POST /tagasiside/peida`. |
| `src/server/account-mail.ts` | The two protocol mails. |
| `src/server/messages.ts` | Maria's feedback notice. |
| Admin components | The protocol screen (student list, editor, autosave), the "Täna" card, the "Tagasiside" page, the drawer additions, the course editor's "Protokolli punktid". |
| Account components | The card's "Vaata protokolli", the feedback card, the protocol page, the feedback form. |

**Sending** happens in one transaction per student:
1. Lock the registration row (`lockRegistration`).
2. Freeze `sent`, `sent_at` and `sent_version`.
3. Create the account and the login if needed, and link `registrations.client_id`.

The mail goes out after the commit. "Saada kõik" runs each student separately, so one failure doesn't stop the others; the confirmation reports any failure by name.

**Logs** carry ids only, never protocol text, answers or addresses.

## 9. Edge cases

- **Registration cancelled after notes were written:** hidden from the screen and never sent. It reappears if reinstated.
- **Registration moved to another session:** its protocol follows it.
- **Course headings changed:** existing protocols keep their copy; only protocols not yet created get the new headings.
- **Session cancelled:** its protocols stay reachable through `?sessioon=` from the calendar for the record. No feedback opens for its registrations by date.
- **Two devices:** the version check reloads the older screen. *(Admin UX pass B13: its words wait in the notice, and „Taasta minu tekst“ puts them back over the newer text, §4.)*
- **Empty protocol:** skipped by "Saada kõik" and named in the confirmation. A single "Saada" on an empty protocol is refused with a short notice.
- **Account deleted:** its protocols and feedback are deleted (§3).
- **A student signed in under a different address** than her registration: same as the dashboard today; not visible until Maria links them (out of scope).

## 10. Testing

- **Unit:**
  - the status table;
  - the stage-copy limits;
  - the open rule, at Tallinn date edges;
  - answer validation: unknown keys, out-of-range score, empty submit, length limits.
- **Database (PGlite):**
  - create on first open copies the course's headings;
  - a save from an old version is refused;
  - send freezes the snapshot, and a later edit leaves `sent` unchanged;
  - send creates the account and the login and links the registration;
  - reopen and resend;
  - ownership: another account's id gives 404;
  - account deletion removes protocols and feedback;
  - the feedback averages and counts.
- **Real Postgres (e2e):** two simultaneous sends of one protocol give one snapshot and one mail.
- **End to end:**
  1. Maria fills two students while switching between them.
  2. A dropped connection (aborted requests) recovers with no lost text.
  3. "Lukusta ja saada kõik" sends; the student signs in and reads her protocol.
  4. "Muuda", edit, "Saada uuesti"; the student sees the new text.
  5. The feedback card, the form submitted, the card gone; the admin "Tagasiside" page shows the answer.
  6. "Ei soovi" hides the card.
  7. Viewports 390, 834, 1194 and 1440 with no overflow and 44 px targets, in dev and in the production build.
- **Gate:** the new account routes stay gated (404 JSON for a script without the preview cookie).

## 11. Go-live

1. Migration `0007` on Railway first.
2. Deploy (push `main`).
3. Live checks behind the gate as an admin with a sample student `*.naidis@example.test`: write, send, sign in as her, read, feedback, the admin page. Maria's notices now reach her inbox, labelled "Naidis".
4. Clean-up of the exact sample address only. Never `%naidis@example.test`, which would also delete Maria's demo registrations.

## 12. Out of scope

- photos;
- printing and PDF;
- protocols for the MINI/MAXI practice packages;
- adding a stage to a single protocol;
- the certificate (phase 3d);
- the knowledge test (phase 3b);
- the admin-wide UX pass (end of the project);
- linking a registration made under another address to an account.
