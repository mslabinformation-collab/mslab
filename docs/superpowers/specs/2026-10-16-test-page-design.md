# The test page ("Testimine") — design

Phase 4, piece 1 of 6. Dim, 16.10.2026: "At some point we will need to start testing the solution as well (in same manner as we had a /test page with Rempire)." The order agreed the same day: the test page first, then invoices, contracts, reviews, newsletter campaigns and instalments; the admin UX pass after phase 4.

## 1. Why

Everything built so far has automated tests, but nobody has walked the site the way Maria and her students will: on her tablet and phone, with a real mailbox, Montonio's test bank and a real course day in mind. The test page is that walk, written down. Each check is a short list of steps and what to see. Maria and Dim tick each one OK, Viga or Jäta vahele, with a note, and the answers are kept on the server so both see one result.

Every phase after this one changes behaviour that some checks describe. So the plan follows the code: a change that alters what a check describes updates that check in the same round and marks it for a re-test (§6). This is a standing rule, not a one-off, as on Rempire (lesson learned there: about 200 behaviour changes landed and one commit touched the plan, so the owner's 170 answers could no longer be trusted).

**Success:** Maria opens one page on her tablet, works through it section by section over a few sessions, and every "Viga" reaches Dim the same day with enough words to find it. When a fix lands, the check comes back as "uuesti testida" for whoever answered it, and nothing else does.

**Anti-goals:**
- a long, formal QA document nobody finishes;
- checks that say "kontrolli, et kõik töötab";
- answers that silently go stale after a change;
- test data that is hard to tell apart from real students or registrations.

## 2. Decisions

- **D1. Where.** A page of the admin, `/admin/testimine`, titled "Testimine". It is for the two admins only (the admin session): reading and answering both need it. It is not in the main menu, because it is a temporary tool until the launch. It is linked from Avaleht as a card "Testimine: N avatud, M viga", visible to both admins.
- **D2. Language** (my call). The plan and the page are in **Estonian only**. Maria tests in Estonian; Dim reads Estonian, because he approves the site's Estonian texts. The Russian side of the site is tested by checks that open a `/ru/` page and ask for what is visible. The Russian wording itself stays with the native-speaker check in the launch checklist.
- **D3. The plan is a committed file**, `app/src/data/testplan.json`. It is replaced as a whole when the plan changes, and nothing in the code hard-codes an item id or a count.
- **D4. The answers are one `settings` row**, key `testplan_answers`: `{ v: 1, answers: { <itemId>: { status, note, at, by } } }`. No migration.
  - A save **merges by item id**, and the newer `at` wins. Maria's tablet holds the copy it loaded, so without the merge her save would erase Dim's answers given in the meantime.
  - The save takes the row's lock (`select … for update` on the settings row, inserting it first if missing) so that two saves at once cannot lose one.
- **D5. Who answers what.** Each check names `who`:
  - `maria`: what she does every day and what a student sees;
  - `dim`: payments, mails, the gate, technical bits;
  - `koos`: done together, such as the first real-money or real-mail runs.
  
  Either admin may answer any check. `who` only sorts and filters.
- **D6. A "Viga" pings Dim** (the timing is my call). The server sends Telegram messages through the existing chat (`sendTelegram`, the same chat the review tools use).
  - **The first message** goes out when a check becomes `bad`. It holds the check's title, who answered, the note if there is one, or "(märkust veel pole)", and a link to the check.
  - **A second message** goes out, once, when that `bad` answer gets its first non-empty note: "Märkus: …", the first 300 characters.
  - **No further messages** for that failure. Later edits to the note send nothing.
  - **A "Viga" on a check that was reopened by a `redo`** is a new failure: the answer before it was given before the check's `markedAt`. It sends its own messages. This tells Dim that a fix did not work.
  - The answer records `pinged` (the instant of the first message) and `notePinged` (true after the second), so the server knows what it has sent.
  - A failed send never fails the save.
- **D7. Test data is labelled** (Dim, 16.10: as recommended). Every check that creates something (`writes: true`) tells the tester exactly what to type:
  - the name "Proov" plus a number;
  - for a student, an e-mail with `+proov` added to the tester's own address (for example `nimi+proov1@…`), which Gmail delivers to the tester's own inbox.
  
  "Enne alustamist" says this once. The test rows stay in the database, labelled, while testing goes on. The admin can cancel a registration and end an access, but cannot delete a student or a Montonio test payment. **Right before the public launch, Dim removes them by exact address** (the address list is kept on the page's "Koristamine" section as the tester types them; never by pattern). That step goes into `docs/launch-checklist.md`. "Koristamine" also says:
  - cancel each test registration in the admin;
  - end each test access in the admin;
  - after the last certificate check, delete each test student's account ("Kustuta konto" in her Minu andmed; it takes her test certificate and photos with it), then set Seaded → Tunnistus → „Järgmine number“ back (Seaded refuses a number at or below one still issued; amended 16.10 after Task 4) to the number after Maria's last paper certificate, because a test certificate takes a real number from her series.
- **D9. The checks run on Maria's real courses** (Dim, 16.10: as recommended). There is no hidden sample course.
  - **E-course checks.** Area 3 starts by having Maria set up one of her real e-courses for testing. She needs to do this for the launch anyway. Steps, in order:
    - one module with a text lesson and a video lesson;
    - „Teadmiste test“ with two questions, one with choices and one free answer;
    - „Protokolli punktid“ with two points;
    - the course's „Tunnistus“ card;
    - published.
    
    Areas 4–7 use that course.
  - **Contact-course checks.** They register on a real future session with free seats, and the last check of area 4 cancels the registration.
  - **Side effects.** While a test registration stands it takes a seat. Each one sends Maria's real inbox its notice. That is expected and is itself checked.
- **D10. Who is who** (my call). The session's admin is matched to `maria` or `dim` by the first word of their name in `ADMIN_NAMES` (case-insensitive), which already names Dim and Maria. An admin whose name matches neither sees and counts every check as "Kõik", with no "Sina: …" line.
- **D8. Before the launch, the coming-soon gate is up.** "Enne alustamist" says: sign in to the admin on the same device and press "Vaata kodulehte". That device then sees the site and the account pages. The checks never ask the tester to work around the gate any other way.

## 3. The plan file

```jsonc
{
  "version": 1,
  "marked": "2026-10-16T00:00:00.000Z",   // fallback instant for marks without their own markedAt
  "areas": [ { "id": "avalik", "name": "Avalik leht", "note": "Ei loo midagi. Alusta siit." } ],
  "items": [
    {
      "id": "avalik-avaleht-telefon",      // kebab-case, unique, stable forever (answers hang on it)
      "area": "avalik",
      "who": "maria",                      // "maria" | "dim" | "koos"
      "device": "telefon",                 // "telefon" | "tahvel" | "arvuti" | "any"
      "title": "Avaleht telefonis",
      "href": "/",                         // optional: where "Ava" takes the tester (a path on mslab.ee or /admin/…)
      "steps": ["Ava mslab.ee telefonis.", "Keri avaleht ülevalt alla."],
      "expect": ["Üleval suur pilt ja nupp.", "Midagi ei ulatu ekraani servast välja."],
      "why": "Avaleht on esimene, mida tulevane õpilane näeb.",
      "risk": "high",                      // "high" | "med" | "low"
      "writes": false,                     // true: running it creates data (a registration, a student, a mail, a payment)
      "mark": "redo",                      // optional: "redo" | "reworded" | "new"
      "markedAt": "2026-10-20T09:00:00.000Z" // optional, set with a mark: when this check last changed meaning
    }
  ]
}
```

**House style**, enforced by a unit test (§8):
- at most 8 steps and 8 expect lines per check;
- at most 20 words a line;
- every line is a full sentence ending with a full stop;
- `expect` is a list of separate things to look at, never one long sentence;
- the buttons and labels a step names are written exactly as the screen shows them, in quotes „…“.

**Areas, in this order** (each uses what the one before created). This is my call, and the builder may split or merge areas if a section grows past about 25 checks.
1. **Enne alustamist.** Notes, no checks: the gate (D8), the test e-mail (D7), the login code limit (3 student codes in 30 minutes; 3 admin links in 10 minutes), Montonio's test bank, and "update the page if something looks old".
2. **Avalik leht.** Home, catalogue, a course page (contact and e-course), trainer, news, gallery, FAQ, the popups, the footer and newsletter sign-up, `/ru/` pages, phone and tablet widths.
3. **Haldus: sisu.** Maria edits:
   - a course (texts, prices, badges, pictures, "Protokolli punktid", "Teadmiste test", "Tunnistus");
   - Kalender (a session);
   - Uudised, the pages, gallery, FAQ, Hüpikaken, Koolitaja and Seaded.
   
   Each change shows on the public page.
4. **Registreerimine ja maksmine** (writes):
   - register for a contact course with a test address;
   - pay the prepayment and the rest in Montonio's test bank;
   - the bank-transfer path;
   - the registration in "Registreerimised" and "Maksed";
   - the seat count.
5. **Õpilase konto:** login by code and by link, Minu koolitused, Lemmikud, Minu andmed, the password, change requests in "Päringud".
6. **E-kursus** (writes):
   - buy or grant access;
   - the terms notice, lessons and video, progress, "Märgi tehtuks";
   - the knowledge test, the practical work with photos, Maria's assessment in "Hindamine";
   - "Lõpetatud", the certificate (name, PDF), "Paranda nimi", the register.
7. **Kontaktkoolitus:** a session's protocols (autosave, "Lukusta ja saada kõik"), the student's protocol view, the feedback form, "Tagasiside", "Lisa protokoll".
8. **Kirjad** (`dim` or `koos`): every mail the site sends, opened in Gmail on a phone and on a computer. Covers the subject, the sender, the buttons, and that the reply goes to Maria.
9. **Koristamine.** Notes, no checks: removing the test students and registrations.

The first plan covers everything live on mslab.ee on the day it is written. Expect about 100–140 checks; the builder decides the exact set.

## 4. The page

Phone-first, in the admin's look. Top to bottom:
- **The header.** "Testimine", one line of progress ("82 / 130 tehtud · 3 viga · 5 uuesti testida") and the filters:
  - Kõik / Avatud / Vead / Muudetud;
  - Kes: Kõik / Maria / Dim / Koos;
  - the choice is remembered on the device.
- **Areas.** Each is a collapsible section with its name, its note and a count ("12 / 18"). The first area with an open check starts open; the others start closed.
- **A check.** Each shows:
  - the title;
  - chips for who, the device and "Loob andmeid" (a warning colour when `writes` is true);
  - a mark if any: "Uuesti testida" (`redo`), "Sõnastus muutus" (`reworded`), "Uus" (`new`);
  - "Ava" when there is an `href`, opening it in a new tab;
  - the steps as a numbered list, then "Mida näed" with the expect lines as a list;
  - "Miks" folded under the steps;
  - three buttons: „OK“, „Viga“, „Jäta vahele“;
  - a note field "Märkus", which opens by itself when "Viga" is pressed;
  - under the buttons, the last answer: "Maria · 16.10 14:05 · Viga".
- **States of a check:**
  - **open:** no answer, or a `redo` answered before its `markedAt` (fallback `marked`). The old answer stays visible under it as "Varasem vastus (enne muudatust): OK", so nothing is thrown away;
  - **done:** OK or Jäta vahele, still valid;
  - **failed:** Viga. It stays failed until someone answers it again. When a fix lands, the check is marked `redo` (§6), so it shows as open again with its old Viga under it.
- **Saving.**
  - Pressing a button saves at once.
  - The note saves 1 s after typing stops, and when the field loses focus.
  - A save in flight shows "Salvestan…", a saved one "Salvestatud", a failed one "Salvestamata — proovin uuesti".
  - Unsaved answers are kept in the device's storage and sent again on the next load or when the connection is back. That follows the protocols' pattern: it survives flaky Wi-Fi, two tabs and the Back button, and handles full storage gracefully.
- **Reading.** The page loads the plan and the answers in one request. The two admins' answers show together. On every load and on "Värskenda" the page reads the server's answers again, so a tester sees the other's answers without a full reload.

## 5. Server

- **`GET /api/admin/testplan`** answers `{ ok, plan, answers }` with no-store, behind the admin session (401 JSON otherwise).
- **`PUT /api/admin/testplan`**:
  - takes `{ answers: { <id>: { status, note, at } } }`;
  - checks the session;
  - drops ids that are not in the plan;
  - caps the note at 1 000 characters and the body at 128 KB;
  - sets `by` from the session's e-mail, never from the body;
  - merges under the row lock (D4);
  - then sends the Telegram pings for transitions to `bad` (D6), after the commit.
  
  It returns the merged answers.
- **`at` is the server's clock** (my call). The server stamps `at` when it receives the save, never trusting the device. A tablet whose clock is behind could otherwise keep a re-tested `redo` open, and one ahead could win every merge.
  - An offline answer that arrives late is stamped with its arrival time. That only makes it newer, which is right: the tester's latest press is what they meant.
  - The body may carry `clientAt`. It is used only to order several unsent answers of the same check from one device: the latest press wins before the save is sent.
- **The Avaleht card counts.** It reads the same row: open and failed counts for the admin's own `who` (Maria `maria` + `koos`, Dim `dim` + `koos`). It is shown only while the plan has open or failed checks.
- **Logs.** The log line for a save carries counts only, never notes or e-mail addresses.

## 6. The plan follows the code (standing rule)

- **Every later plan says so.** Each later phase's plan (phase 4 pieces 2–6, the admin UX pass and every fix after them) has, in each task that changes behaviour a check describes, a step: "update `testplan.json`".
  - `redo` with `markedAt` = now when the site behaves differently;
  - `reworded` when only the words move;
  - a new item with `mark: "new"` for new behaviour.
- **A fix for a "Viga" marks that check `redo`** in the same commit.
- **`markedAt` is the deploy instant, not the moment of editing** (my call). A branch can sit for days before it reaches mslab.ee, and an answer given in between was about the old site.
  - On the branch, a marked check carries `"markedAt": "deploy"`.
  - Right before the push to `main`, a small tool `tools/testplan-stamp.mjs` replaces every `"deploy"` with the current instant and commits that with the merge. A deploy follows within minutes. The deploy steps in `docs/deploy.md` name the tool.
  - **The safety net if the tool was skipped.** The server reads a `"deploy"` it still finds as the running deployment's build time: `next.config.ts` puts the build instant into the server's environment. So the checks reopen at that deploy, as they should. The cost is that they reopen again at the next deploy, until the tool stamps them. That asks too much rather than too little, and never hides a change.
- **Never move the plan-wide `marked`** to cover one check: it would stale other answers.
- **A `redo` alone is not coverage.** A behaviour that only shows on particular data gets a new check naming that data.
- **The rule lives in three places:**
  - this spec;
  - `docs/deploy.md` (a short section "Testimine");
  - the implementer rules future plans carry. The controller adds it to each plan's Global Constraints.

## 7. Edge cases

- **The plan file changes while answers exist.**
  - Answers to ids no longer in the plan are kept in the row and never shown.
  - A new id has no answer.
  - Renaming an id loses its answer, so ids never change; the test in §8 cannot catch that, so it is a rule in the file's header comment.
- **Two admins answer the same check at once.** The newer `at` wins, and the page shows that one after the next read.
- **A note with only white space** counts as no note.
- **"Viga" with no note** is allowed. The note field opens and asks "Mis läks valesti?", but the save does not wait for it.
- **Both admins on one device.** The page always shows whose session it is ("Sina: Maria"), and `by` is the session's.
- **The database is down.** The page still shows the plan from its own bundle and keeps answers locally. It says "Vastuseid ei saa praegu salvestada; need on selles seadmes alles" and sends them later — only when this device can keep them (its storage works); on a device that cannot, the page shows the ordinary "Salvestan…" / "Salvestamata — proovin uuesti" states instead (amended 16.10 in the final review).

## 8. Testing

- **Unit:**
  - the plan's shape and house style (unique ids; areas exist; enums; non-empty steps and expect; line caps; `markedAt` valid when a mark is set; `href` starts with `/`);
  - the merge (newer server `at` wins, `clientAt` orders one device's unsent presses, unknown ids dropped, `by` from the session);
  - the open/done/failed rules (redo before and after `markedAt`, fallback to `marked`, `"deploy"` read as the build time);
  - `tools/testplan-stamp.mjs` replaces every `"deploy"` and nothing else;
  - the session-to-tester match by `ADMIN_NAMES` (D10);
  - the Telegram messages (D6): the first on a new failure, the second on its first note, none after, and a new failure after a `redo`.
- **DB:**
  - two concurrent saves of different checks both survive;
  - the same check twice: the newer `at` wins;
  - the Avaleht counts.
- **DOM:** a check's buttons, the note opening on "Viga", the states and the old answer under a redo, the filters.
- **e2e:**
  - an admin answers three checks, reloads and sees them;
  - a second admin session answers one more and the first sees both after "Värskenda";
  - an offline save is kept and sent when back;
  - widths 390, 834 and 1194 have no sideways scroll and controls of at least 44 px.

## 9. Rollout

No migration, no new variable. Deploy as usual (mslab.ee is staging). Then:
- Dim opens the page and checks the counts.
- Maria gets a short Estonian note with the link: what the page is, the "Enne alustamist" section and "write a note with every Viga".

## 10. Out of scope

- An English or Russian version of the plan.
- Public access to the page.
- A history of every answer; only the latest per check is kept, plus the overtaken one shown under a redo.
- Screenshots attached to an answer (the note is text only).
- Automated tests generated from the plan.

## 11. Left to the builder

- The exact checks and their words, within the house style and the areas above.
- The visual details, in the admin's existing look.
- Whether the Avaleht card shows both counts or only the open one when there are no failures.
- Montonio's test bank. What its sandbox bank page shows was never written down (`docs/deploy.md` §11.6). If the steps are still unknown when the checks of area 4 are written, the builder first makes one sandbox payment on mslab.ee with a "Proov" registration, records the screens, then writes the steps.
