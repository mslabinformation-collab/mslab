# Student reviews ("Õpilaste tagasiside") — design

Phase 4, piece 4 of 6. Dim agreed the order on 16.10.2026. Dim chose to skip the questions for phase 4, so every decision not attributed to Dim or Maria is my call and says so.

## 1. Why

Maria (01.10.2026, C47, on the course page prototype): "Tulevikus võiks iga koolituse alla tekkida läbinud koolituse õpilaste tagasiside. (Vajab minu kinnitamist)." C48 asked for an end-of-course form („Iga koolituse lõpus õpilane võiks saada tagasisidevormi…"). That form was built in the protocols phase, but for contact courses only.

What exists today:
- **The feedback form.** „Sinu kogemus MS LAB koolitusel“ is private. It holds a score, seven choice questions and two free texts, and lives in table `course_feedback`.
- **What Maria sees.** Its answers appear on her admin page „Tagasiside“ and in the student's drawer.
- **What the public site lacks.** It shows no reviews, and nothing asks a student whether her words may be shown.

**Success:**
- Under each course page, real graduates' words, shown only with the student's permission and Maria's approval.
- A few of them on the home page.
- Maria approves with one press. A student can take her permission back at any time.
- E-course graduates can leave feedback too (C48 says every course).

**Anti-goals:**
- **Words the student did not write.** Maria never edits a student's text.
- **Anything published without the student's explicit opt-in**, including every answer given before this piece.
- **Fake or invented reviews.** Prototype D's sample quotes never reach the live site.
- **Nagging.** Maria (08.10): the form is optional, "no nagging". There is no reminder mail.
- **Star averages or ratings that look like a verified rating service.**

## 2. Decisions

- **D1. The review is the student's answer to „Kas soovitaksid seda koolitust ka teistele? Miks?“** (my call). It is the one question already written for other people to read.
  - Every other answer stays private, as today, including the score, the choices and the message.
  - Under that question the form gains:
    - a tick: „Luban seda vastust avaldada MS LAB kodulehel — selle koolituse lehel ja avalehel.“ (Draft). One permission covers both places a review can show (D5), and the tick says so (my call, from the builder check);
    - a field: „Nimi, mida näidatakse“ (Draft), prefilled with her first name and the initial of her last name (for example „Kati K.“). It is required when the tick is set, and capped at 40 characters.
  - The tick can be set only when the answer has text.
  - On submit, the review is created in the same transaction as the feedback, as a copy of that answer, with status „Ootab kinnitust“.
  - Answers given before this piece have no permission, so they are never published.
- **D2. Maria decides each review** (C47: "Vajab minu kinnitamist").
  - On her „Tagasiside“ page, a new part „Arvustused“ lists the reviews by status:
    - „Ootab kinnitust“ (pending) first;
    - „Avaldatud“ (published);
    - „Peidetud“ (hidden).
  - Each pending review has „Avalda“ and „Peida“. A published review can be hidden, and a hidden one published again.
  - **Undo and focus (4c, 29.10); the admin UX pass, spec 2026-10-21 §9, C6.** „Avalda“ and „Peida“ act at once, and the bar „Arvustus avaldatud.“ / „Arvustus peidetud.“ offers „Võta tagasi“ for 8 s. It puts back the status and `decided_at` of the moment before the press, but only while the review is as the press left it (its status and `updated_at`): a review that moved since (published again in another tab, „Avalehel“, an edit) is not written over, and the bar says „Arvustust muudeti vahepeal. Vaata see üle.“. The focus stays on the card acted on, or goes to its neighbour when the card leaves a filtered list. The list is cards, with the stars of the student's „Hinne“ (Maria's screen only, S4-Q5: 9–10 five … 0–2 one, none without a score; a screen reader hears „Hinne {n}/10“), and the status filter is the pills „Ootab kinnitust {n}“ · „Avaldatud {n}“ · „Peidetud {n}“ with no „Kõik“: every review is listed until a pill is pressed, and a pressed pill toggles off. The heading's count of pending reviews is gone (the menu badge and the pill have it).
  - „Arvustused“ is a tab of the „Tagasiside“ page, `?vaade=arvustused`, with `?olek=ootel|avaldatud|peidetud` for one status, and it has no paging for now: tens of rows are expected, and the status filter is enough until the list passes about 100 (R6). (amended 18.10 during the build)
  - The „Kõik“ view lists by status (waiting, published, hidden) and then newest written first (R7). (amended 18.10 during the build)
  - **Who may offer one.** The form opens as it does today (a contact registration after its course day, not cancelled; an e-course once „Lõpetatud“), and Maria's approval is the check. So she can judge whether the writer really took part, each student review in „Arvustused“ shows the registration's status (for example „Ootab ettemaksu“) and whether a protocol was sent; an e-course review shows „Lõpetatud {date}“ (my call, from the builder check).
  - She never edits a student's review (my call, from the anti-goals). She can only publish or hide it.
  - „Avalehel“ is a toggle on a published review that also shows it on the home page.
  - Maria's existing „Uus tagasiside“ mail and Telegram notice gain the line „Lubab avaldada — vaata „Tagasiside“ lehel.“ (Draft) when the student allowed publishing.
- **D3. E-course graduates get the same feedback form** (my call, from C48's "iga koolituse lõpus").
  - When to offer it: after the access is „Lõpetatud“ (`course_access.completed_at` set). Her account shows the same open feedback card a contact course gets, where today's feedback cards are, with today's „Ei soovi“.
  - The form opens once the access is „Lõpetatud“ and not revoked. An access that has ended by its date still counts: she finished the course. (amended 18.10 during the build)
  - The form: Maria's paper form unchanged, all questions, because each one reads sensibly for an e-course too.
  - Admin: the „Tagasiside“ page's course filter and averages include e-courses.
- **D4. Maria can add a review she received elsewhere** (my call, so the site does not launch with empty blocks). This covers past students' paper forms and messages.
  - „Lisa arvustus“ takes:
    - the course;
    - the shown name;
    - the text;
    - the date written;
    - its language;
    - a required internal note, „Kust see pärit on?“ (Draft), never shown publicly.
  - The form tells her: „Lisa ainult päris õpilase sõnad tema loal.“ (Draft).
  - **Soft delete (4c, 29.10).** „Lisa arvustus +“ opens a drawer, and the review is made only with „Lisa arvustus“. „Muuda“ opens a drawer that saves each field by itself, guarded by the review's version. „Kustuta“ asks nothing and only marks the review (`reviews.removed_at`, migration 0021, §3): every reader leaves a marked review out at once (the public pages, the student's account, Maria's list and counts, the menu badge, Avaleht's queue), „Võta tagasi“ clears the mark within the bar's 8 s, and the row is purged once the mark is 10 s old (by her next „Kustuta“, else by the daily sweep). Only a review Maria added is ever marked or purged; a student's withdrawal (D6) stays a hard delete.
  - She may edit or delete these, and only these. A new one is published when she first adds it, because she adds it herself (my call); an edit keeps its status (below). (amended 18.10 during the build)
  - Her internal note is capped at 500 characters (R3), and the date written is from the year 2000 on (a typo like 0026 is refused; a date ahead is not). (amended 18.10 during the build)
  - Editing a manual review keeps its status and its „Avalehel“ setting, so a hidden one stays hidden. Moving it to another course refreshes the pages of both courses and the home page (R4). (amended 18.10 during the build)
  - The student's permission for these is Maria's responsibility. The site cannot check it.
- **D5. Where reviews show** (my call):
  - **The course page.** A block „Õpilaste tagasiside“ after the course content, with the course's published reviews, newest first: six, then „Näita kõiki“ for the rest (up to 50).
  - **The home page.** A section „Õpilaste kogemused“, after the trainer section, with up to six published reviews marked „Avalehel“, newest first. Each names its course, linked to the course page.
  - **Empty state.** A block or section with nothing to show is not rendered.
  - **What each review shows:**
    - the text;
    - the shown name;
    - the course;
    - the month and year written (for example „okt 2026“).
  - **What it does not show:** no score, no stars and no average. (4c, 29.10: this is the public pages'. Maria's cards in the admin show stars from the score, S4-Q5.)
  - **The notice.** Under each block and section: „Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.“ (Draft).
    - Consumer law asks a trader who shows reviews to say whether and how it checks that they come from real customers.
    - This line is the site's statement. It is not legal advice.
- **D6. Taking permission back** (my call, from consent law).
  - **From her account.** Today's feedback card disappears once she answers, so the permission lives on the course card itself (the contact course's card, the e-course's card, and an individual course's card (amended 18.10 during the build)): a quiet line „Lubasid oma soovitust avaldada“ with „Võta luba tagasi“ (Draft), shown while her review exists (my call, from the builder check). Pressing it deletes the review at once, whatever its status, and the public pages refresh.
  - **Deleting her account.** Today this already deletes her feedback, and that now deletes the review with it.
  - **What she is not shown.** She does not see whether Maria published or hid it (my call: Maria's choices stay Maria's).
- **D7. Languages.** A review is shown as written, on both the ET and the RU page. The headings, the notice and the dates follow the page's language.
- **D8. No structured data** (my call). The site is noindex until launch. Search engines ignore a business's markup of reviews about itself. It can be added later without changing the data.

## 3. Data (migration 0014, additive)

**`course_feedback` gains an e-course path:**
- `registration_id` becomes nullable.
- A new `access_id` references `course_access` (cascade on delete) and is unique.
- A check requires exactly one of `registration_id` and `access_id`.

**A new table, `reviews`:**
- `id`;
- `course_id` (cascade on delete);
- `feedback_id`: unique and nullable, references `course_feedback` (cascade on delete), so a review goes with its feedback; null for one Maria added;
- `kind`: `student` or `manual`;
- `text`: up to 2000 characters, the same limit as the form;
- `name`: up to 40 characters;
- `locale`;
- `written_at`: the feedback's submit time, or the date Maria gives;
- `status`: `pending`, `published` or `hidden`;
- `featured`: boolean, default false, the „Avalehel“ toggle;
- `decided_at`;
- `note`: Maria's internal source note, for `manual` only;
- `removed_at` (4c, 29.10), migration 0021: when Maria deleted a review she added („Kustuta“); null otherwise. A marked row is read by nothing and purged once the mark is 10 s old (D4);
- `created_at` and `updated_at`.

The index is (`course_id`, `status`, `written_at` desc). The text and the name are copies made at consent: later changes to her account name do not touch them.

## 4. Flows

- **The feedback form (contact and e-course).**
  - The tick and the name field come under the recommend question (D1).
  - The server refuses each of these with a field error:
    - a tick with no recommend text;
    - a tick with an empty name;
    - a name over 40 characters.
  - The feedback and the review are written in one transaction.
  - The feedback POSTs (`/api/konto/tagasiside` and `/api/konto/tagasiside/peida`) address a course by `id` (a contact course's registration) or by `kursus` (an e-course's slug), exactly one of the two. The older `registrationId` field is no longer accepted: a form left open across the deploy shows its failure line on every send (the server answers 400), and the form does not reload: the student reloads the page herself (R5). (amended 18.10 during the build)
- **Her account.** The course card shows the permission line and „Võta luba tagasi“ while her review exists (D6); the dashboard's data gives each contact, individual-course and e-course card `review: { id } | null` (an individual-course registration has no session, and its student is offered the form once Maria has sent the protocol, so she takes her permission back from her card too: ruling R10). (amended 18.10 during the build) An e-course gets the same open feedback card as a contact course once it is „Lõpetatud“ (D3), placed where today's feedback cards are.
- **The admin.**
  - The „Tagasiside“ page gains „Arvustused“ (D2) and „Lisa arvustus“ (D4).
  - The page heading counts the pending reviews. (4c, 29.10: replaced by the pills' counts and, on a phone, the tab „Arvustused · Ootab {n}“; D2.)
  - The student's drawer shows whether she allowed publishing, and the review's status.
- **The cache.** Any review change refreshes that course's page and the home page (`cache-targets.ts`).

## 5. Edge cases

- **The course is unpublished.** Its reviews are not shown anywhere, the home page included. They come back when it is published again.
- **The course is deleted.** Its reviews go with it.
- **A featured review is hidden.** It also leaves the home page. Its `featured` value stays, so publishing it again brings it back.
- **She changes her name in „Minu andmed“.** The shown name stays as she typed it at consent.
- **Taking permission back while Maria has the page open.** Maria's press on a review that is gone answers „Seda arvustust enam pole — õpilane võttis loa tagasi.“ (Draft).
- **Two tabs with Maria's page.** Publishing twice is harmless. A press on a hidden review publishes it, as the button says.
- **An old feedback without a review.** It shows in the admin as today, with no „Arvustused“ entry.

## 6. The test plan (standing rule)

New checks (`"mark": "new"`, `"markedAt": "deploy"`):
- the tick and the name field, and Maria's mail line;
- „Avalda“ → the course page block;
- „Avalehel“ → the home section;
- „Peida“;
- „Võta luba tagasi“;
- an e-course graduate's feedback;
- „Lisa arvustus“;
- the Russian page.

The feedback-form checks get `redo`. The plan's file order must hold, per the guard test.

## 7. Out of scope

- Star ratings, averages or a score shown publicly.
- Importing or syncing Google, Facebook or Instagram reviews.
- Structured data for reviews (D8).
- Maria replying publicly to a review.
- Photos in reviews.
- Editing a student's words.
- Reminder mails asking for feedback.
- Reviews of practice packages or products.

## 8. Left to the builder

- The layout of the course block and the home section within the site's existing style, with prototype D's carousel as a reference and nothing copied.
- The Estonian and Russian texts beyond those quoted. They are marked Draft for Dim's wording sheet.
- Where „Arvustused“ sits on the „Tagasiside“ page: a tab or a second part. It is a tab (see D2). (amended 18.10 during the build)
