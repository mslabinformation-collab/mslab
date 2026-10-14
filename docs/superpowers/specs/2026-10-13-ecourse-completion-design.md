# E-course completion: knowledge test and practical work — design

Status: approach A and sections 1–2 approved in conversation on 13.10.2026 (Dim). Sections 3–5 follow the recommended defaults Dim approved as a whole ("Yes, do all recommended"). This phase is the old 3b (knowledge test) widened by Maria's answers of 12.10.2026. The certificate is the next phase (3d); the admin UX pass stays at the end of the project.

## 1. Goal

Maria's answers of 12.10.2026, for e-courses:
- the whole path happens on the platform: the lessons, then the knowledge test, then the practical work;
- for the practical work, the student uploads a photo for each stage; Maria looks at it, assesses it and gives feedback;
- only when the required stages are passed does the course count as completed, and only a completed course will get a certificate (3d).

For every course, the protocol is ONE universal form whose points Maria sets per course. She opens it from the student's profile ("Lisa protokoll"), and the student sees it only when Maria sends it. For contact courses, nothing else changes: the test is on paper, the practical work is assessed live and the certificate is handed out on the day.

Her main concern: submitting and assessing the practical work must be smooth for both sides.

Success:
- **The student:** on a phone, she takes the test and sends the practical work: photos per point, one button. When a point needs fixing, she redoes only that point.
- **Maria:** on her tablet, she sees what waits for her in one place, assesses a submission point by point with the photos beside each point, and sends the verdict with one tap.
- **The completion:** a passed course is marked "Lõpetatud", with a date that phase 3d builds on.

## 2. Decisions (Dim, 13.10.2026)

| # | Decision |
|---|---|
| D1 | One phase: the knowledge test, the practical work, the completed status, and "Lisa protokoll" from the student's profile. The certificate is phase 3d. |
| D2 | The test has choice questions, graded automatically, and optional open questions that Maria reads and accepts. |
| D3 | A pass mark and a limited number of tries per course. With no tries left, Maria reopens the test. |
| D4 | The practical work is sent all at once: 1–3 photos per point and one "Saada hindamiseks". Maria marks each point "Kinnitatud" or "Paranda" with a comment. The student redoes only the "Paranda" points; the work passes when every point is approved. |
| D5 | Strict order: the test opens when every lesson is done, the practical work opens when the test is passed, and "Lõpetatud" comes when the practical work is approved. A course with no questions skips the test; a course with no points skips the practical work. |
| D6 | Approach A: the practical work IS the protocol. The course's "Protokolli punktid" are the practical points of an e-course, Maria's assessment is written in the protocol screen she already uses, and the protocol's version check, autosave and "Saada" snapshot carry over. |
| D7 | The student's browser shrinks every photo before upload (the request limit on Vercel is 4.5 MB); the server checks it again. |
| D8 | Mails to students get Maria's inbox as Reply-To, so a student's reply reaches her instead of the sending-only `send.mslab.ee`. |

## 3. Data (migration `0008_ecourse_completion`, additive)

The planned drop of `courses.modules` moves to `0009`: code first, then the migration.

### 3.1 The course
- **`courses.test_questions`**: jsonb, not null, default `[]`. The list, in order:
  ```ts
  type TestQuestion =
    | { id: string; kind: "choice"; text: string; options: { id: string; text: string; correct: boolean }[] }
    | { id: string; kind: "open"; text: string };
  ```
  - `id`: 8 random base36 characters, made when the question or option is added, never reused. Attempts refer to questions by id.
  - Limits: at most 50 questions; a question's text at most 500 characters; a choice question has 2–6 options, each at most 200 characters, with at least one correct. Everything is trimmed and nothing is empty.
  - The text is plain, in the course language, and not translated (the rule of `protocol_stages`).
- **`courses.test_pass_percent`**: integer, not null, default 80, from 1 to 100.
- **`courses.test_tries`**: integer, not null, default 3, from 1 to 10.
- **`courses.protocol_stages`** (exists): for an e-course, the practical points. The limits are unchanged: at most 30, each at most 120 characters.

### 3.2 The e-course access
- **`course_access.extra_tries`**: integer, not null, default 0. "Ava test uuesti" adds `test_tries` to it.
- **`course_access.completed_at`**: timestamptz, null. Set once, when the last required step passes (§4.4), and never cleared.

### 3.3 Test attempts: new table `test_attempts`
- `id` serial;
- `client_id`, referencing `clients`, on delete cascade; `course_id`, referencing `courses`, on delete cascade;
- `number` integer: 1, 2, …; unique together with (`client_id`, `course_id`);
- `questions` jsonb: the frozen copy of the course's questions at submit time;
- `answers` jsonb: `{ [questionId]: string[] }` for choice questions (the option ids picked) and `{ [questionId]: string }` for open ones (at most 2000 characters);
- `correct` and `total` integers: the choice questions answered exactly right, out of all choice questions;
- `status` text: `failed` | `review` (open answers wait for Maria) | `fix` (Maria asked to rewrite some) | `passed`;
- `review` jsonb, null: `{ [questionId]: { verdict: "ok" | "fix"; comment: string } }`, Maria's last review of the open answers;
- `submitted_at`, `reviewed_at` timestamptz; `reviewed_by` text (the admin's address).

**Grading** (pure, in `domain/completion.ts`):
- A choice question is right when the picked set equals the set of correct options exactly.
- The choice part passes when `correct × 100 ≥ test_pass_percent × total`, or when `total` is 0. The percentage shown is rounded down.
- Choice part failed → `failed`. Passed with no open questions → `passed`. Passed with open questions → `review`.

**Tries:** every submitted attempt is one try. Rewriting "Paranda" answers updates the same attempt and uses no try. Tries allowed = `test_tries + extra_tries`. A new attempt is possible when no attempt is `review`, `fix` or `passed`, and the attempts made are fewer than the tries allowed.

### 3.4 The protocol of an e-course access (`protocols`, extended)
- **`registration_id`** becomes nullable; new **`access_id`**, referencing `course_access`, on delete cascade, unique. The check `(registration_id is null) <> (access_id is null)`: a protocol belongs to exactly one of the two.
- **`ProtocolStage`** gains an optional `verdict: "ok" | "fix"`; absent means "not marked". The `sent` snapshot keeps the verdicts.
- **New columns:** `round` integer, not null, default 0 (the student's submissions so far); `submitted_at` timestamptz, null (the last one); `sent_round` integer, null (the round Maria's last send assessed).
- **Created** by the student's first photo upload, or by Maria's first save ("Lisa protokoll"), whichever comes first. Either way it copies the course's points then. Later changes to the points reach only protocols not created yet.
- **Practical status** (computed, never stored):

  | Status | Condition |
  |---|---|
  | `open` | no row, or `round` = 0 |
  | `review` (Ootab hindamist) | `round` > 0 and (`sent_round` is null or `sent_round` < `round`) |
  | `fix` (Paranda) | `sent_round` = `round` and some sent verdict is `fix` |
  | `passed` (Kinnitatud) | `sent_round` = `round` and every sent verdict is `ok` |

  For a contact registration, `round` stays 0 and the protocol statuses of the protocols phase apply unchanged.

### 3.5 Photos: new table `practical_photos`
- `id` serial; `protocol_id`, referencing `protocols`, on delete cascade; `stage` integer (the point's position, 0-based); `round` integer (the submission it belongs to, `protocols.round + 1` while being prepared);
- `key` and `thumb_key` text: private R2 objects `practical/<uuid>.jpg` and `practical/<uuid>-t.jpg`;
- `size`, `width`, `height` integers; `created_at`.
- Index on (`protocol_id`, `stage`, `round`).
- **History stays:** photos of earlier rounds are kept, so Maria can compare after a "Paranda".

**Account deletion** (`server/client-data.ts deleteClient`): the access rows, attempts, protocols and photo rows go by cascade. The R2 keys are read before the delete and removed after the commit; a failed R2 removal is logged by protocol id and does not undo the deletion.

## 4. The student's side

All pages are static shells, like every account page, and are behind the coming-soon gate until launch. The page frame is in the student's language (ET and RU). Maria's questions, points and comments are shown as written. Data comes from `/api/konto/...` with `private, no-store`, and only to the owner of an active access. A revoked access answers 404.

**After the access expires:** the results stay readable (read-only), but nothing new can be submitted. Maria extends the access in Õpilased, as now.

### 4.1 The e-course page: "Lõpetamine"
Below the lessons comes a block of four steps: Õppetunnid → Teadmiste test → Praktiline töö → Lõpetatud.
- **Each step's state:** locked, with the reason (e.g. "Avaneb, kui kõik õppetunnid on tehtud"), open, waiting for Maria, needs fixing, or done.
- **Skipped steps:** a step the course doesn't have is not shown.
- **The course card** in "Minu koolitused" shows "Lõpetatud" with the date once `completed_at` is set.

### 4.2 The test: `/konto/kursus/<slug>/test`
- **Layout:** all questions on one page, numbered. A choice question with one correct option shows radio buttons; with more than one, checkboxes and "Vali kõik õiged".
- **Draft:** the answers are kept in the browser's storage per course until the attempt is accepted, so a reload loses nothing.
- **Submitting:** "Esita test" asks to confirm and shows the try number, e.g. "Katse 1/3".
- **Choice part failed:** "Said 70 %, vaja 80 %. Valesti vastatud: 3, 7." Then "Proovi uuesti (2 katset jäänud)". The correct answers are never shown.
- **No tries left:** "Katsed on otsas. Maria sai teate ja avab testi sulle uuesti."
- **Waiting for Maria** (open answers): "Ootab Maria hinnangut".
- **After Maria's review:** answers marked "Paranda" show her comment and open for editing; accepted answers are locked. "Saada uuesti" uses no try.
- **Passed:** "Test on sooritatud", and the practical work opens.
- **Questions changed under her:** a submission whose question ids no longer match the course is refused with "Test on vahepeal muutunud, laadi leht uuesti" and uses no try.

### 4.3 The practical work: `/konto/kursus/<slug>/praktiline`
- **Layout:** Maria's points in order, each with up to 3 photo slots. "Lisa foto" opens the phone's camera or gallery (`accept="image/*"`).
- **Upload:** each photo uploads as soon as it is picked and shows its progress. A photo of the round being prepared can be removed.
- **Sending:** "Saada hindamiseks" is enabled once every point has at least one photo. It asks to confirm; after that the page is locked: "Ootab hindamist".
- **After Maria's assessment:** each point shows ✓ "Kinnitatud", or "Paranda" with her comment. "Üldised märkused" shows below the points.
  - Only the "Paranda" points take new photos; earlier photos show smaller under "Varasemad fotod".
  - "Saada uuesti" is enabled once every "Paranda" point has a new photo.
- **All approved:** "Lõpetatud", with the date.
- **An e-course without points** has no practical page. If Maria sends it a notes-only protocol, the e-course page shows "Vaata protokolli", which opens this page with her notes only.

**Photos on the phone:**
- **Shrinking:** `shrinkImage` moves from `components/admin/ImageUpload.tsx` to `src/lib/shrink-image.ts`, with the size, type and quality as parameters. The admin keeps its 2400 px setting.
  - The student's photo: JPEG, at most 2048 px on the long side, quality 0.85, plus a 480 px thumbnail. If the full image is still over 2 MB, it is encoded again at quality 0.7.
- **Privacy:** the canvas re-encode removes all metadata, including the GPS position. `imageOrientation: "from-image"` keeps portrait photos upright.
- **Old Safari:** where `createImageBitmap` is missing (Safari < 15), it decodes through an `<img>` element instead. The new student modules join the `old-safari.test.ts` import graph.
- **A file the browser can't open** (e.g. HEIC in Chrome): "Seda pilti ei saa avada. Vali JPG või PNG pilt."
- **Weak signal:** only the failed photo shows "Proovi uuesti"; the others stay.

### 4.4 Completion
`course_access.completed_at` is set in the transaction that passes the last required step:
- the last lesson marked done (a course with no test and no points);
- the test passed (a course with no points);
- Maria's send that approves every point.

**A passed step stays passed:** a lesson or question Maria adds later never locks the test or the practical work again, and a set `completed_at` is never cleared.

## 5. Maria's side

### 5.1 The course editor (e-courses)
- **"Teadmiste test"** (a new card):
  - the pass mark (%) and the number of tries;
  - the questions: add, remove and move up or down; the kind (choice or open); the options with a "Õige" checkbox.
  - It saves with the course, like every other field. The checks (§3.1) give errors in place.
  - Hint: "Muudatused kehtivad uutele katsetele; tehtud katsed jäävad nii, nagu need esitati."
- **"Protokolli punktid"** now shows for e-courses too, with the hint: "E-kursusel on need praktilise töö punktid: õpilane lisab iga punkti juurde 1–3 fotot."

### 5.2 "Hindamine": `/admin/hindamine`
- **In the menu** after "Registreerimised", with a count badge of the items waiting.
- **Avaleht** gets an "Ootab hindamist: N" card, hidden at 0.
- **The page** has three groups, oldest first; when all are empty: "Kõik on hinnatud".
  1. **Praktilised tööd:** name, course, "1. kord" / "2. kord", sent at. Opens the protocol screen (§5.3).
  2. **Testi vastused:** name, course, try, sent at. Opens the test review (§5.4).
  3. **Katsed otsas:** name, course, best score. "Ava test uuesti" with a confirmation; it adds the course's number of tries and mails the student.

### 5.3 The protocol screen for an e-course access: `/admin/protokollid?ligipaas=<accessId>`
This is the existing screen in its single mode, with these additions:
- **Header:** the course, the student's name and "Praktiline töö, 2. kord".
- **Under each point:**
  - the photos of the latest round as thumbnails; a tap opens a full-screen viewer with swipe between photos and pinch zoom;
  - "Varasemad fotod", folded, for earlier rounds;
  - the verdict buttons "Kinnitatud" and "Paranda" (44 px);
  - the note box, as today.
- **"Üldised märkused"** as today.
- **Autosave:** the verdict saves with the same autosave, version check and conflict notice as the notes. The save body carries a verdict per stage.
- **"Saada hinnang"** (instead of "Saada") is enabled when the student has submitted, every point has a verdict, and every "Paranda" point has a note. One confirmation, then the snapshot and the mail.
- **Before the student submits,** Maria may write notes (e.g. "Lisa protokoll" early), but the verdict buttons and "Saada hinnang" stay disabled.
- **The student's resubmission** clears the verdicts of the "Paranda" points in the draft and raises `version`. A screen Maria has open gets the usual conflict notice and reloads with the new photos.
- **"Lukusta ja saada kõik"** is not shown here.
- **An e-course without points:** the screen is the plain notes protocol, sent with "Saada" as for a contact course.

### 5.4 The test review: `/admin/hindamine/test?id=<attemptId>`
- **The choice part:** read-only, with the score and each question showing the student's answer marked right or wrong.
- **The open answers:** each with "Kinnitatud" / "Paranda" and a comment box. A comment is required for "Paranda".
- **"Saada"** sends the review: every answer accepted makes the attempt `passed`; otherwise it becomes `fix`. The student gets a mail.
- **Draft:** a plain form; unsent text is kept in the browser's storage until it's sent.
- **Every attempt of a student** is listed at `/admin/hindamine/test?ligipaas=<accessId>`, newest first.

### 5.5 The student's profile (Õpilased drawer)
- **Each e-course access** gets:
  - a step line, e.g. "Õppetunnid 8/8 · Test: läbitud (85 %) · Praktiline töö: ootab hindamist", or "Lõpetatud 14.11.2026";
  - "Lisa protokoll" or "Ava protokoll" (→ `?ligipaas=`);
  - "Testi katsed" (→ the attempts list);
  - "Ava test uuesti" when the tries are used up.
- **Each contact registration** gets "Lisa protokoll" or "Ava protokoll" (→ the existing `?registreering=`). This is the entry point Maria asked for.

## 6. Mails and notices
Texts are drafts. Dim approves them in the plan's wording sheet, and the RU gets the native check. No mail carries notes, answers or photos, only links. Mails go out after the commit, and a failed mail never undoes what was saved.

**To the student**, in the account's locale:

| When | ET subject / RU subject | Button |
|---|---|---|
| Maria sends an assessment with "Paranda" points | "Sinu praktiline töö on hinnatud" / "Ваша практическая работа оценена" | "Vaata hinnangut" / "Посмотреть оценку" |
| The course is completed (any path) | "Palju õnne! Koolitus „{kursus}" on lõpetatud" / "Поздравляем! Обучение «{курс}» завершено" | "Vaata koolitust" / "Открыть обучение" |
| Maria reviews open answers: passed, practical work next | "Test on sooritatud" / "Тест сдан", with the line "Praktiline töö on nüüd avatud" / "Практическая работа теперь открыта" | "Ava praktiline töö" / "Открыть практическую работу" |
| Maria reviews open answers: some "Paranda" | "Vaata üle oma testi vastused" / "Проверьте свои ответы в тесте" | "Ava test" / "Открыть тест" |
| Maria reopens the test | "Test on sinu jaoks uuesti avatud" / "Тест снова открыт для вас" | "Ava test" / "Открыть тест" |

An automatic result (a fail, or a pass with no open questions) sends no mail, because the student is on the page. The one exception is completion: when that pass completes the course, she gets the completion mail.

**To Maria** (`notifyMaria`: mail and Telegram, Reply-To the student; Telegram still goes to Dim until launch), each with a link to its item in "Hindamine":
- "Praktiline töö hindamiseks: {nimi}, {kursus}" ("(2. kord)" on a resubmission);
- "Test ootab hindamist: {nimi}, {kursus}";
- "Testi katsed otsas: {nimi}, {kursus}".

**Reply-To (D8):** `sendMail` gives every mail without its own Reply-To the address `MARIA_EMAIL`, unless that is also the recipient. This covers all student mails, including login codes, payment confirmations and protocols.

## 7. Building blocks

| Unit | Responsibility |
|---|---|
| `src/domain/completion.ts` | Pure: question and settings checks, grading, tries, the practical status, the step states, the completion rule. |
| `src/domain/protocols.ts` | The stage verdict type, and the send rule for an access protocol. |
| `src/db/queries/completion.ts` | Reads: the student's steps, the test and practical pages, the Hindamine lists and count, the drawer lines. |
| `src/server/test-attempts.ts` | Submit an attempt, rewrite "Paranda" answers, Maria's review, reopen. Each in one transaction that locks the access row. |
| `src/server/practical.ts` | Photo upload and removal, submit, and the completion write. Lock order: access → protocol. |
| `src/server/protocols.ts` | Saves with verdicts; "Saada hinnang" (verdict checks, `sent_round`, completion, the mail); access protocols beside registration ones. |
| `src/server/account-api.ts` | New routes: `GET /kursus/:slug/test`, `POST …/test`, `POST …/test/uuesti`; `GET /kursus/:slug/praktiline`, `POST …/praktiline/foto`, `DELETE …/praktiline/foto/:id`, `POST …/praktiline/saada`; `GET /praktiline/foto/:id` (a 302 to a 5-minute signed R2 address; `?v=thumb` for the thumbnail). |
| `src/app/api/admin/foto/[id]` | The same 302 for Maria, behind `requireAdmin`. |
| `src/lib/shrink-image.ts` | The shared browser shrink (§4.3). |
| `src/server/account-mail.ts`, `src/server/messages.ts` | The student mails and Maria's notices (§6). |
| `src/server/notify.ts` | The Reply-To default. |
| Admin components | The course editor's test card; the Hindamine page and its Avaleht card; the protocol screen's photos, viewer and verdicts; the test review; the drawer lines. |
| Account components | The "Lõpetamine" block, the test page, the practical page, the card's "Lõpetatud". |

**The upload request:** multipart with the point's position, `full` (a JPEG of at most 2 MB) and `thumb` (a JPEG of at most 200 KB). That stays under Vercel's 4.5 MB.
- **Server checks:** the JPEG signature (`FF D8 FF`), the sizes, that the practical is open for her and the point may take photos in this round, and at most 3 photos per point per round, counted under the lock.
- **Order:** both objects are stored in R2 first, then the row is written. If the row is refused, the objects are removed.

**Rate limits**, per client and fail-open (as `account-api.ts`): photo uploads 120 per hour, practical submits 20 per hour, test submits 10 per hour.

**Logs:** ids only, never answers, notes, names or addresses.

## 8. Edge cases
- **Two devices of the student:** the per-point photo cap and the submit are checked under the access lock. A second submit of the same round answers "already sent".
- **Two devices of Maria:** the protocol version check, as today.
- **Maria corrects a sent assessment of the same round** ("Muuda", then "Saada hinnang" again): the new snapshot replaces the old one, and the status follows the new verdicts. The mail follows the §6 table. Once every point is approved and the course is completed, the verdicts are locked; Maria can still edit and re-send her notes, and that sends the "uuendatud" protocol mail.
- **Maria changes questions while a student has the test open:** the submit is refused with the reload notice and uses no try (§4.2).
- **Maria changes the points after a protocol exists:** the protocol keeps its copy (§3.4).
- **Maria adds a lesson after the test is passed:** nothing locks again (§4.4).
- **The access expires during review:** Maria can still assess; the student reads the result read-only; a "Paranda" round needs the access extended.
- **The access is revoked:** her pages answer 404, her data stays, and her items leave "Hindamine".
- **An e-course with no questions and no points:** it completes when the last lesson is done.
- **A huge or odd photo:** over 60 MB is refused before decoding (as the admin's); a decode failure gives the "Vali JPG või PNG" message; the server refuses anything that isn't a JPEG within the limits.
- **Photos uploaded but never sent:** they stay with the draft round until removed, or deleted with the account.

## 9. Testing
- **Unit:**
  - grading: one correct option, several correct options (exact set), zero choice questions, the pass-mark edges;
  - tries with `extra_tries`;
  - question and settings checks;
  - the practical status table;
  - the step states and the completion rule;
  - the shrink size maths;
  - the Reply-To default.
- **Database (PGlite):**
  - an attempt keeps its question copy after the course changes;
  - the tries limit is enforced server-side;
  - a "Paranda" rewrite uses no try;
  - a submit from changed questions is refused;
  - the first photo creates the protocol with the course's points;
  - the 3-per-point cap; photos refused on approved points and on locked steps;
  - a resubmit clears the fix verdicts and raises `version`;
  - "Saada hinnang" refused without every verdict, or with a "Paranda" without a note;
  - `completed_at` set once by each path;
  - ownership answers 404; account deletion removes rows and lists the R2 keys;
  - the access protocol's check constraint (exactly one of `registration_id` and `access_id`).
- **Real Postgres (e2e):** two simultaneous submits of one round give one round and one notice.
- **End to end:**
  1. A student finishes the lessons; the test opens; she fails once, retries and passes.
  2. She uploads photos, including a 6000×4000 JPEG fixture with GPS EXIF. The upload stays under 2 MB and the stored file has no EXIF.
  3. Maria sees the item in "Hindamine", marks one "Paranda" with a note and sends.
  4. The student re-uploads only that point and sends again; Maria approves; "Lõpetatud" shows on the page and on the card.
  5. Open answers: Maria asks for one fix, the student rewrites it, Maria accepts.
  6. Out of tries, Maria reopens the test.
  7. "Lisa protokoll" from the drawer, for a contact registration and for an e-course access.
  8. Viewports 390, 834, 1194 and 1440 with no overflow and 44 px targets, in dev and in the production build.
- **Gate:** the new `/api/konto` routes stay gated (404 JSON for a script without the preview cookie).

## 10. Go-live
1. Migration `0008` on Railway first.
2. Deploy (push `main`).
3. **Live check behind the gate:**
   - as an admin, with a temporary unpublished sample e-course "Proov (näidis)" (one short text lesson, two questions, two points);
   - and a sample student on an exact `*.naidis@example.test` address;
   - the whole path once. Maria's notices reach her inbox labelled "Proov (näidis)", so keep it to one run.
4. **Clean-up:** the exact sample address, the sample course and its R2 photo objects only. Never `%naidis@example.test`, which would also delete Maria's demo registrations.

## 11. Out of scope
- the certificate (phase 3d);
- a test or practical work for contact courses (paper and live, per Maria);
- question banks, random order, time limits, or showing the correct answers;
- photo annotation or drawing on photos;
- video submissions;
- the admin-wide UX pass (end of the project).
