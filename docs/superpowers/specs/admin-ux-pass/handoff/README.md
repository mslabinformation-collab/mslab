# MS LAB admin — UX pass hand-off for Claude Code

**Package contents (this folder):** `MS LAB Admin UX Pass.dc.html` (part 1: navigation and patterns), `… - Part 2.dc.html` (A screens, desktop + phone), `… - Part 3.dc.html` (B and C screens, final lists), `… - Part 4.dc.html` (B screens on phone, every C screen drawn), `MS LAB Admin UX Deck.dc.html` (10-slide summary), `AdminSidebar.dc.html` (shared sidebar used by the screens), `support.js` + `deck-stage.js` (runtime), `assets/` (logo + sample photos). Open the .dc.html files in a browser from this folder; they are reference prototypes, not code to copy. Build everything in the existing app: Next.js server pages, CSS modules, drawers opened by a URL parameter. Admin text stays Estonian, and every string goes through `i18n/dict/admin.ts`. Quote new strings exactly as written in the design files' text-change tables.

**Order of work.** Build the global components first (§1), then the screens in the order A → B → C. Every task that changes behaviour updates `testplan.json`, as the test-page spec requires.

**Decisions already made by the owner.** Published content saves to a draft and goes live with „Avalda muudatused“ (Q1). Money is recorded with an explicit „Lisa laekumine“ (Q2). Below 900 px the admin uses the phone top bar (Q3). The language switch has two modes, ET and RU (Q4). „Testimine“ is in the menu for every admin (Q5). Behaviour changes B1–B10 are accepted; B11–B20 are still to decide (see §5).

---

## 1. Global components

### 1.1 Sidebar (`Sidebar.tsx`, `sections.ts`) — changed
- Groups, in order:
  - no label: Ülevaade
  - „IGAPÄEVANE TÖÖ“: Registreerimised, Protokollid, Hindamine, Päringud, Õpilased, Tagasiside, Maksed ja arved
  - „KOOLITUSED“: Koolitused, Kalender, Praktika
  - „KODULEHT JA UUDISKIRI“ (folding): Avaleht, Koolitaja, Uudised, Hüpikaken, Uudiskiri
  - „HALDUS“: Seaded, Testimine
- Group label style: 600 10 px, letter-spacing .16em, #a99ba4, 22 px tall, 8 px gap above.
- The folding group's header is a 44 px button with ▸/▾. It is open whenever the active page is inside it, and the open/closed choice is stored in `localStorage` key `mslab-nav-fold`.
- Routes don't change. „Maksed ja arved“ → `/admin/maksed`. „Protokollid“ → `/admin/protokollid` (the new index; see A3 and B16). „Testimine“ → `/admin/testimine`.
- Active state: `/admin/arved` highlights „Maksed ja arved“; `/admin/tunnistused` and `/admin/hindamine/test` highlight „Hindamine“; `/admin/protokollid*` highlights „Protokollid“.
- Badges (pill #e6dce2; shown only when > 0). Clicking a badged row opens the page already filtered to those items.
  - Registreerimised: awaiting prepayment → `?staatus=ootab`.
  - Protokollid: the text „Täna“ on a day with a session (Tallinn date).
  - Hindamine: as today. Revalidate the path after `ReopenTest`.
  - Päringud: every unhandled request, including „Muutmine“.
  - Tagasiside (new): reviews waiting → `?vaade=arvustused&olek=ootel`.
  - Maksed ja arved (new): unbilled paid payments + payments `kontroll` + voided-after-paid.
  - Testimine (new): the signed-in admin's „Viga“ checks.
  - Extend `adminCounts` with these; keep the work to one query per count.
- Footer: „Sisse logitud“ (11 px #a99ba4), the e-mail (12 px), „Logi välja“. Remove „Vaata lehte ↗“.
- The aside scrolls internally (`overflow-y:auto; min-height:0`).
- Breakpoint: the phone top bar is used **below 900 px** (was 640). Remove the 190 px narrow sidebar.
- Phone menu: the same groups, all expanded. At the top, when a session is on today, a card „TÄNA {time}“ + „Protokollid · {course}“ → the session. The footer adds „Vaata kodulehte ↗“.

### 1.2 Shell top line — changed
„Vaata kodulehte ↗“ appears once, in the top line. Remove the avatar tooltip. Add `scrollbar-gutter: stable` to `html` for the drawer and menu scroll lock.

### 1.3 `useAutosave` (new; generalise `protocol-autosave.ts`)
- API: `useAutosave({ owner, key, version, fields, save: (patch, version) => Promise<Result> })`, which returns `{ status, setField, flush, conflict, restore }`.
- When it saves: 1.5 s after typing stops, on blur, on `visibilitychange: hidden`, on `pagehide` (keepalive ≤ 64 KiB), and on route change through `useLeaveGuard`. Instant fields (radio, switch, reorder, upload reference) call `flush()` right away.
- Local copy in `localStorage` `mslab-draft:{owner}:{key}:{tab}` until the server confirms. Retries 2/5/10/20/30 s; immediately on `online` and focus.
- Per-field validation (B3): an invalid field is excluded from the patch, marked `aria-invalid`, and makes the status `invalid`.
- Versioning: one version per form *part*, the same as `useSiteDraft` today. A 409 shows the protocols' conflict notice plus **„Taasta minu tekst“**, which writes the local copy back into the fields and saves it.
- Server: each editor gets a PATCH-style action `save{Thing}Part(id, part, version, patch)` (B1). For published things the target is the draft row (B2, §1.8).

### 1.4 `SaveStatus` (new)
- One per screen, `role=status`, and it announces only changes of state.
- Chip: 32 px tall, radius 99, 600 12 px.

  | state | text | bg / fg |
  |---|---|---|
  | saved | „Salvestatud {HH:MM}“ (draft: „Mustand salvestatud {HH:MM}“) | #eaf0eb / #2f5d46 |
  | dirty | „Salvestamata muudatused“ | #ebe8e9 / #5e5559 |
  | saving | „Salvestan…“ | #ebe8e9 / #5e5559 |
  | checking | „Kontrollin salvestatud teksti…“ | #ebe8e9 / #5e5559 |
  | retry | „Salvestamata — proovin uuesti“ | #f3e6e6 / #8a3b3b |
  | invalid | „Salvestamata — kontrolli märgitud välja“ + link „Näita“ (focus the first invalid field) | #f3e6e6 / #8a3b3b |
  | signedOut | „Salvestamata — logi uuesti sisse“ | #f3e6e6 / #8a3b3b |
  | conflict | „Muudeti teises aknas — vaata üle“ | #f3e6e6 / #8a3b3b |
  | gone | „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ | #f3e6e6 / #8a3b3b |

- Placement:
  - page: right end of the H1 row, before „Vaata lehel ↗“;
  - drawer: the header, left of ✕;
  - phone: under the H1;
  - protocol screen: card corner (unchanged).
- Delete `SaveBar.tsx`, the CourseEditor copy, and the three Seaded card buttons.

### 1.5 `useLeaveGuard` (new, in Shell) + Drawer change
- Intercepts sidebar and `Link` navigation, Back, and drawer close while any `useAutosave` on the page is not confirmed.
- A save in flight: wait for it (≤ 3 s), then continue.
- A save that can't go through (offline, error, invalid, upload running): show an in-place notice at the top of the page or drawer: „Muudatust „{välja nimi}“ ei saanud veel salvestada.“ + reason, and the buttons **„Jää siia“** (primary, focus the field) and **„Sulge, tekst jääb seadmesse“**. The local copy is restored the next time the page or drawer opens.
- `beforeunload` is used only for closing the tab.
- `Drawer.tsx`: remove the `confirmClose` prop, use the guard, and set the ✕ aria-label to „Sulge“ everywhere.

### 1.6 `ConfirmPanel` (new; replaces G8 patterns A, B and C)
- Props: `question`, `lines[]`, `yesLabel` (always „Jah, {tegusõna}[ {n} …]“), `tone: 'danger' | 'send'`, `onYes`, `onCancel`.
- It replaces its trigger button in place and takes focus. Style: `ui.notice` (bg #f0ebed, left border 2 px #9e8993, radius 0 14 14 0).
- The "no" button is always „Katkesta“ and returns focus to the trigger.
- Danger yes: outline #c9a3a3 with bg #f5ebeb and text #8a3b3b. Send yes: ink pill.
- Use it when the action can't be undone, mails more than one person, or changes a student's access, seat or test right away. The list of triggers is in Part 1 § 3.3.

### 1.7 `UndoBar` (new)
- Bottom-left (full width on phone), bg #222, radius 14, min-height 52. Text „{Mis juhtus}.“ + button „Võta tagasi“ (#3a3338, 44 px). Lasts 8 s; Esc dismisses it; only one bar at a time.
- Server: removals are soft and purged after 10 s (B5). `undo{Thing}(id)` restores.

### 1.8 Draft layer (B2) + `PublishBar` (new)
- For published courses, home page parts, trainer page, posts, popup and practice, autosave writes `draft_json` (per part, versioned) and leaves the live row alone.
- PublishBar under the H1: „Avaldamata muudatused: {n}“ + a list of the changed field labels, then **„Eelvaade ↗“** (existing preview cookie + `?mustand=1`), **„Loobu muudatustest“** (ConfirmPanel „Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.“ / „Jah, loobu“), and **„Avalda muudatused“** (copies the draft live in one transaction; blocked fields are listed).
- Unpublished items: there is no draft and no bar, and saves go straight to the row. A changed field label gets „· avaldamata“ in #6b4f5c and a #9e8993 border.

### 1.9 `LangSwitch` (new) + `I18nInput` (changed)
- LangSwitch: a segmented control in the page header, „ET“ | „RU“, 38 px segments in a 44 px track. It is backed by React context, and the choice is stored per device (`mslab-edit-lang`).
- Beside it: „RU puudub {n} väljal“ + „Järgmine →“, which scrolls to and focuses the next empty RU field.
- I18nInput reads the context and loses its own pills. In RU mode it shows the ET text above the input (13 px #716a6d, "ET" tag) and keeps the „tõlge tulekul“ tag. An empty RU field gets the link „Kopeeri eesti keelest“ (44 px). The validation rules are unchanged.
- `ListEditor` rows follow the same context.

### 1.10 `ListToolbar` (new) + list tables
- Search input (pill, 48 px, „Otsi nime, e-posti või telefoni järgi“; varies per page) → `?otsi=`, debounced 300 ms with `router.replace`.
- Filter pills with `pillCount`; an optional scope `<select>` (applies on change); a count line „{Asju}: {n}“.
- Filters and search persist in drawer `closeHref` and in back links.
- `list-table.module.css`: the whole row is the link (keep the name `Link` as the accessible target and stretch it with `::after`). Container query 980 → **760 px**.
- Shared states:
  - empty: „{Asju} veel pole.“
  - filtered empty: „Selle valikuga {asju} pole.“ + „Tühjenda otsing ja filtrid“
  - `loading.tsx` for `(panel)`: static grey rows, shown after 300 ms
  - `error.tsx` for `(panel)`: „Seda lehte ei saanud praegu laadida.“ / „Sinu salvestatud andmed on alles. Proovi mõne hetke pärast uuesti.“ / „Proovi uuesti“

### 1.11 Glossary (apply everywhere)
- „Katkesta“ steps back out of a form or question.
- „Tühista …“ cancels a business record and is never used to mean "never mind".
- Downloads are „Laadi alla ({PDF|CSV})“.
- „Vaata kodulehte ↗“ opens the site; „Vaata lehel ↗“ opens the current item on the site.
- „Sulge“ closes a drawer.
- Back links are „← {Lehe nimi}“.
- „Võta tagasi“ undoes the last action.
- „Uudiskiri → Kirjad“.

---

## 2. A screens (daily work)

### A1 Ülevaade `/admin` — `page.tsx`, `overview.module.css`
- Heading: date eyebrow + „Tere, {name}.“. Remove the „Vaata registreerimisi →“ button.
- „Täna“ card (dark #222, radius 22) at the top when a session is on today. It shows „TÄNA {HH:MM} · {city, venue}“, the course (Jost 28) and „{n} õpilast · protokollid: {a} saadetud, {b} mustand, {c} alustamata“, with the button „Ava protokollid →“ linking to `?sessioon=`. One card per session.
- „Sinu järjekord“ card: rows with a Jost 30 count, a 600 label, a muted 13 px hint and „→“; min-height 64. A row with 0 is hidden. Rows:
  - Ootab ettemaksu → `?staatus=ootab`; hint „Vanim {date} · {name}“
  - Ootab hindamist → `/admin/hindamine`
  - Päringut tegemata (incl. Muutmine) → `/admin/paringud`
  - Arveta makset → `/admin/arved#arveta`
  - Arvustus ootab avaldamist → `/admin/tagasiside?vaade=arvustused&olek=ootel`
  - Makse ootel kontrollil → `/admin/maksed?staatus=kontroll`
  - Empty: „Järjekord on tühi.“ / „Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.“
- „Tulevased koolitused“: header note „järgmise 30 päeva jooksul: {n}“. Each row links to `/admin/kalender?id=`. The seat count is red at 0.
- Remove: the four stat tiles, the „Ootab hindamist“ card, the „Päringud“ card and „Kiirlingid“. The TestplanCard stays the same.
- Phone: Täna card → queue → upcoming list, stacked.

### A2 Registreerimised `/admin/registreerimised` — `page.tsx`, `RegistrationForms.tsx`, `InvoiceBlock.tsx`
- ListToolbar:
  - search across name, e-mail and phone (`?otsi=`, B7);
  - scope select „Kõik koolitused ja toimumised“ (`?toimumine=` / `?koolitus=`);
  - status pills with counts;
  - form pills.
- Columns: Kuupäev | Nimi ja kontakt (name + phone) | Koolitus ja toimumine | Laekunud („{paid} / {price} €“) | Staatus. „Liik“, „Modelli abi“ and „Konto“ move to the drawer details.
- Phone: cards with name + status pill, course, then „{session} · laekunud {x}“.
- **Drawer order:**
  1. Header: status pill, SaveStatus, ✕; name (Jost 30); "{course} · {date time} · {city, venue} · {Grupp|Individuaal}"; tel and mail links; „Ava protokoll“ (contact courses only).
  2. **Raha** (bg #f6f4f5, radius 18):
     - „{laekunud} / {hind} laekunud“ (Jost 34);
     - an 8 px bar with a marker at 50 %;
     - „Koht kinnitub {pool} juures · vabu kohti {x} / {cap}“;
     - online payment lines (as today);
     - the button **„Lisa laekumine“**, which opens a panel:
       - amount pills: what is missing up to 50 % (preselected), the full remainder, „Muu summa“ (number field);
       - date (today, not later than today);
       - method pills Pangaülekanne (default) / Sularaha / Kaart;
       - checkbox „Koosta kviitung (arve „Juba tasutud“)“, on by default when seller data exists;
       - submit „Lisa {summa} · koht kinnitub“ (the suffix only when this payment reaches 50 %) and „Katkesta“.
     - Server (B4): `addRegistrationPayment` adds to the paid total, runs the seat check, recomputes the status, and optionally creates the receipt (`createInvoice` kind paid) in one transaction. Messages: „{x} € lisatud · kviitung {nr} · koht kinnitatud.“ or „… Koolitus on vahepeal täis, nii et koht jäi kinnitamata.“ Remove the typed „Laekunud summa“ field and `saveRegistrationPayment`.
  3. **Staatus ja märkus:** radio pills „Ootab ettemaksu“ / „Kinnitatud“ (manual override, instant save) and the textarea „Märkus“ (autosave, max 2000, hint „Näeb ainult haldus.“). Remove „Salvesta staatus“ and keep the stale-status guard as a conflict.
  4. **Arved:** the existing rows. Show „Saada õpilasele“ and „Laadi alla (PDF)“; put the rest under „Veel ▾“ (Muuda saajat, Märgi tasutuks, Tühista arve, Võta tasumine tagasi). Only one „Koosta arve“ button: if an unbilled online payment exists, show only its row button, otherwise the generic one. Hide „Saada õpilasele“ on „Tagastatud“.
  5. Folded rows (52 px, „▸“): Leping, Tagasiside, Registreerimise andmed. Each shows a one-line summary.
  6. „Tühista registreerimine“ (danger) → ConfirmPanel. Question „Kas tühistan {name} registreerimise?“; lines „Koht {date city} koolitusel vabaneb kohe avalikus kalendris.“, „Laekunud {x} € ja arved jäävad alles.“, „Õpilasele kirja ei saadeta.“; buttons „Jah, tühista“ / „Katkesta“ (B10).
- Phone drawer: the header, Raha (with only the „Lisa laekumine“ button) and status are on the first screen. Invoices and the contract are folded rows.

### A3 Protokollid `/admin/protokollid` — new index branch in `page.tsx`; `ProtocolScreen.tsx`, `ProtocolSend.tsx`
- No parameter → the index (B8): sessions from today back 14 days, newest first, with today on top. Row: date (Jost 22, „Täna“ for today) + weekday | course + "{time} · {city, venue}" | counts ("{n} õpilast · {a} saadetud · {b} mustand", or "✓ Kõik {n} saadetud" in green) | „Ava“ (ink when today).
- Section „INDIVIDUAALKOOLITUSED“ lists open individual registrations.
- Empty state: „Viimase 14 päeva jooksul koolituspäevi polnud.“ + „← Kalender“.
- B16: when exactly one session is on today, the menu row links straight to `?sessioon=`.
- Protocol screen:
  - back link „← Protokollid“;
  - the per-student send label „Saada protokoll {eesnimi}le“ (no confirmation);
  - the send-all button „Saada kõigile ({n})“, where n = will receive; its ConfirmPanel question „Kas saadan {n} protokolli?“ uses the existing summary lines, with „Jah, saada {n} protokolli“ / „Katkesta“;
  - the status chip is `SaveStatus`;
  - the conflict notice adds „Taasta minu tekst“ (B13).

  Everything else stays unchanged.

### A4 Hindamine `/admin/hindamine`, `?ligipaas=`, `/hindamine/test`
- Tabs (pill links): „Ootab hindamist {n}“ → `/admin/hindamine`, „Tunnistused“ → `/admin/tunnistused`. Remove „Väljastatud tunnistused“.
- Queue: one list, oldest first. Rows: "{name} · {praktiline töö | testi vastus | katsed otsas}" + meta; actions „Hinda“ (ink), „Vaata“, „Ava test uuesti“ (ConfirmPanel). Empty: „Hindamist ootavaid töid pole.“
- Practical work (`AssessmentScreen`):
  - header „← Hindamine“, H1 the student, a meta line, SaveStatus;
  - action bar: „{n} punkti · {k} hinnatud“, then „Kinnita kõik“ (sets every unset point to approved; each one goes through `verdict-taps`), then the informed send „Saada hinnang · {k} kinnitatud, {p} paranda“ with no confirmation (remove the panel);
  - point cards in a 3-column grid (1 column on a phone): photo 260 px (full width on a phone; a tap opens PhotoViewer), title (Jost 19), a segmented verdict (Kinnitatud = #2f5d46 filled, Paranda = #8a3b3b filled; tapping again clears it), a comment box that opens automatically on Paranda, and „Lisa märkus“ otherwise;
  - „Üldised märkused“ below;
  - phone: the send bar sticks to the bottom.
- Test review: marks autosave to the server (B15). The send label is „Saada · {õ} õige, {v} vale“, and tapping a pressed verdict clears it.
- Wording: always „kord“, never „voor“.

### A5 Õpilased `/admin/opilased` — `ClientDrawer.tsx`, `ClientForms.tsx`
- ListToolbar (search as you type; remove „Otsi“), form pills with counts. „Lisa õpilane +“ in the header opens an inline form (e-mail field + „Lisa õpilane“; typo guard as today). The „Koolitusi“ explanation becomes the column header's `title` and `aria-describedby`.
- Drawer:
  - header: name, tel, mail, "Konto loodud … · Keel … · Uudiskiri: …".
  - **Koolitused**: one list (e-course accesses + registrations, newest first). Card per item:
    - kicker (form · date/city);
    - title;
    - state pill: „Avatud kuni {date}“ / „Läbitud {date}“ / „Ligipääs lõpetatud {date}“ / registration status;
    - progress line;
    - actions:
      - e-course: „Hinda“ when work is waiting; **„Pikenda ▾“** opens +1 kuu / +3 kuud / +6 kuud / „Kuupäev…“ and applies instantly with an UndoBar, „Ligipääs pikendatud kuni {date}.“ (B12, `extendAccess(id, until)`); „Veel ▾“ holds Ava järgmine õppetund (ConfirmPanel), Testi katsed, Vaata tema vaadet, Lõpeta ligipääs (ConfirmPanel);
      - registration: „Ava registreering“, „Ava protokoll“.
  - Folded rows: „Ava ligipääs e-koolitusele“ (the existing form, with the select text "{course} · mustand · avatud kuni {date}"), Maksed, Lepingud, Päringud, Tagasiside, each with a count.

### A6 Maksed ja arved `/admin/maksed`, `/admin/arved`
- Tabs „Maksed“ | „Arved“. Header button „Laadi alla (CSV) · {kuu aasta}“ (Arved), which always follows the visible month.
- Maksed:
  - ListToolbar searches name, e-mail and Montonio id;
  - pills with counts; „Tühistatud pangas“ is counted under „Ootel kontrollil“ (B14);
  - each row links to the registration drawer or the e-course student; the Montonio id becomes „Montonios ↗“ (merchant URL);
  - held and voided rows keep the tint and get a 3 px #9e8993 left border on the phone.
- Arved:
  - strip `#arveta`: „Arveta maksed: {n}“ + a summary, „Näita ▸“ (expands the existing per-row list), and **„Koosta {n} arvet“** → ConfirmPanel „Kas koostan {n} arvet? Iga arve saab oma numbri ({first}–{last}). Õpilastele neid ei saadeta.“ / „Jah, koosta {n} arvet“ (B11, `createInvoicesForUnbilled()`);
  - ListToolbar searches number and name; month select applies on change (remove „Näita“); pills with counts;
  - rows: number + state tag | name · course + meta | amount | actions („Saada õpilasele“ or „Märgi tasutuks“ for unpaid, „Laadi alla (PDF)“, „Veel ▾“).

### A7 Päringud `/admin/paringud`
- ListToolbar search across all tabs (results show their tab tag). Tab pills with counts. „Kontakt“ includes e-learning interest, tagged „E-õppe huvi“.
- Cards in a 2-column grid (1 on a phone): name (Jost 20) + "{date} · {lang} · {email}", a type tag, the message, one muted facts line, then „Märgi tehtuks“ (instant, with UndoBar „Märgitud tehtuks.“) and „Vasta e-kirjaga ↗“ (mailto with the subject prefilled).
- Waitlist cards add „Ava toimumine →“; Muutmine cards add „Ava registreering →“.
- Done requests: the fold „Tehtud ({n})“ at the bottom, with „Märgi tegemata“ inside.
- Deep link `#p-{id}` scrolls to the card and highlights it (bg #faf6f8 for 2 s; none under reduced motion).

---

## 3. B screens

### B1 Koolitused list — `CourseOrder.tsx`
- Columns: drag handle ⋮⋮ (pointer + touch, `aria-roledescription="lohistatav"`) | ↑/↓ | thumbnail 56 | title + "{tase} · /{slug}" | Õppevorm tag | price on two lines | Märgis | Staatus (Avaldatud / Mustand / Avaldamata muudatused).
- Dropping a course calls one `moveCourseTo(id, index)`. Handles are hidden in filtered views, with the hint „Järjekorda saab muuta vaates „Kõik“.“
- The whole row opens the editor. Pills have counts.

### B2 Course editor + lesson drawer — `CourseEditor.tsx`, `LessonsEditor.tsx`, `LessonDrawer.tsx`
- Layout from 1180 px: a 190 px section map, a content column and a 300 px sticky side column.
  - Section map entries are only the cards that exist for this course type. Each shows a count, „RU puudub“ or „Kontrolli“ in #6b4f5c. A tap scrolls to the card (`scroll-margin-top: 24px`).
  - Below 1180 px: the map becomes a „Jaotised ▾“ select under the H1, and the side column comes straight after the header.
- Header: „← Koolitused“, H1, tags, LangSwitch, SaveStatus, then the PublishBar when the course is published.
- All cards autosave per part. Modules and lessons join the course draft (B18), and the card follows the draft „Õppevorm“.
- Module rows: drag + ↑/↓; the title edits inline (autosave; remove the per-module „Salvesta“); the lesson rows show video status tags (Valmis / Töötlemisel {n}% / Video puudub / Tekst). A programme point's delete text is „Kas kustutan punkti „{title}“?“.
- List editors (outcomes, protocol points, gallery, test questions): drag + ↑/↓, removal with UndoBar, errors keyed by row id.
- Lesson drawer:
  - header: "Moodul {nn} · Õppetund {n.n}", the title, SaveStatus, ✕;
  - fields: Õppetunni nimi, Lühike tekst (autosave), Õppetunni liik (instant; Video→Tekst with a video uses ConfirmPanel „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“);
  - Failid: drop zone + list; „Eemalda“ is instant with UndoBar;
  - the switch „Õpilastele nähtav“ with the existing hint;
  - „Kustuta õppetund“ (only without progress) → ConfirmPanel.
  - Fix the focus loss when the video input unmounts (move focus to the progress line) and announce upload progress only at 25 % steps.

### B3 Kalender `/admin/kalender` — `SessionForm.tsx`
- ListToolbar: course select, city select, pills „Tulevased / Möödunud“ with counts. The whole row opens the drawer.
- Drawer:
  - header: SaveStatus, ✕, the course (Jost 28), "{date} · {city} · {confirmed}/{cap} kinnitatud · ootenimekirjas {n}", and „Protokollid“ (first button);
  - with registrations: the notice „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“;
  - fields autosave;
  - changing the date or time shows the field hint „Muudetud — teavita {n} õpilast ise.“ (#6b4f5c);
  - „Kohti“ below the confirmed count is refused in the field: „Kinnitatud on {n} — kohti ei saa olla vähem.“;
  - „Koolitus“ is disabled once anyone is booked;
  - „Tühistatud“ with registrations → ConfirmPanel „Kas tühistan toimumise? {n} registreeringut jäävad alles; teavita õpilasi ise.“ / „Jah, tühista“;
  - „Kustuta toimumine“ only when there are 0 registrations; otherwise the text „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“;
  - the label „Algus (Eesti aeg)“.
- New session: drawer `?id=uus` with the explicit „Lisa toimumine“; it autosaves after creation.

### B4 Seaded `/admin/seaded` — `SettingsEditor.tsx`, `CertificateSettings.tsx`, `InvoiceSettings.tsx`, `ContractTexts.tsx`
- One page with a section map: Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs. Keep the old anchors as aliases.
- „Maksmine“ merges the Ettemaksu juhised and Arve andmed bank fields (one source; the server keeps both settings in sync, or reads one).
- Every card autosaves under one SaveStatus. Delete the three card buttons.
- „Järgmine number“ fields show a preview: „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“.
- Contract texts (Privaatsus, Õppetingimused, E-koolituse leping, Kontaktkoolituse leping) use the draft layer. Tag „Avaldamata muudatus“; „Avalda uus leping“ opens a ConfirmPanel with the count of active students who must re-accept (e-course) or the note "kehtib uutele registreeringutele" (contact). Placeholders are chips that insert at the cursor.

### B5 Uudiskiri `/admin/uudiskiri` — `NewsletterCampaignEditor.tsx`
- Tabs „Tellijad“ | „Kirjad“ (the route keeps `?vaade=kampaaniad`; the label changes).
- Kirjad layout: a 300 px list („Uus kiri +“, rows with name + state line) | editor | 380 px column (Eelvaade, Saatmine).
- The editor autosaves and keeps its counters. „Kustuta mustand“ (drafts only) → ConfirmPanel (B17).
- Saatmine:
  - a select "{address} · {eesti|vene keeles}" + „Saada proov“;
  - „Saada kõigile ({n})“ → ConfirmPanel with the existing count text and „Jah, saada {n} tellijale“; n excludes sample addresses (B9);
  - the busy text „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“
- Tellijad: ListToolbar (address search, pills Kinnitatud / Ootab kinnitust with counts); „Laadi alla (CSV)“ exports the current filter.

---

## 4. C screens

These share the site-editor template: header with H1, LangSwitch, SaveStatus and „Vaata lehel ↗“; PublishBar; a section map when there are 4 or more cards.

- **C1 Avaleht** (`HomeEditor`, `SlidesEditor`, `FaqEditor`): the slide row is drag | thumbnail 72×48 | ET title + RU line | Hele/Tume tag | ↑/↓. Errors are keyed by row id. „Koolitaja plokk“ becomes the link row „Muuda lehel Koolitaja →“.
- **C2 Koolitaja** (`TrainerEditor`): the template; the gallery is shared with the course editor (drag + undo); empty story cards fold.
- **C3 Uudised** (`PostEditor`): list with ListToolbar search, whole-row link and the status incl. „Avaldamata muudatused“. The editor uses the template; the cover image is checked by „Avalda“, not by save. „Kustuta postitus“ keeps its ConfirmPanel (with the new words).
- **C4 Hüpikaken** (`CampaignEditor`): the „Lehel näidatakse“ choice is instant with UndoBar; one preview that follows LangSwitch; the „Reeglid“ text stays.
- **C5 Praktika** (`PracticeEditor`): the template; points get drag + undo.
- **C6 Tagasiside**:
  - tabs Vastused | Arvustused, with the menu badge landing on `olek=ootel`;
  - „Avalda“ / „Peida“ are instant with UndoBar; „Avalehel“ is a switch;
  - „Lisa arvustus“ opens a drawer (explicit create; cancel is „Katkesta“);
  - the answer drawer links to its review;
  - focus stays on the row after an action.
- **C7 Testimine** (`TestPlan`):
  - menu entry; SaveStatus replaces the outbox line, and a 401 shows the signed-out state;
  - one filter row with the labelled groups „Olek“ / „Kes“;
  - area notes collapse with the area;
  - an empty filter shows „Selle valikuga kontrolle pole.“;
  - „Värskenda“ shows SaveStatus "checking" while busy.
- **C8 Sisselogimine** (`LoginForm`):
  - lead „Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.“;
  - the address is prefilled from `localStorage` `mslab-admin-email`, with „Muu aadress“ to clear it;
  - `?tagasi=` is carried through the magic link and validated as a same-origin `/admin` path (B19);
  - sent state: „Link on teel“ / „Saatsime lingi aadressile {email}. See kehtib 15 minutit.“ / „Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.“;
  - rate limit: „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ (B20);
  - input style: radius 10, border #d9d2d5.

---

## 5. Behaviour changes — all accepted (B1–B22)

B1 autosave endpoints · B2 draft layer · B3 partial saves · B4 one money path · B5 undo for removals · B6 new badges · B7 search · B8 Protokollid index · B9 matching counts · B10 confirm cancel registration · B11 batch invoices · B12 extend access · B13 conflict restore · B14 „Tühistatud pangas“ under „Ootel kontrollil“ · B15 test-review marks on server · B16 single-session shortcut · B17 delete newsletter draft · B18 modules in course draft · B19 deep link after sign-in · B20 honest rate-limit message.

**B21 Invoice numbers per year (m5).** Key the invoice sequence by the invoice date's year: the first invoice dated in a new year is `{prefix}{year}-001` without any manual step. Seaded → Maksmine: „Järgmine number“ edits the current year's counter; from 1 December show the line „1. jaanuarist: {prefix}{year+1}-001“. Remove the need for a December preset. Certificates keep their running number (no yearly reset) unless Maria asks.

**B22 One open Montonio order per registration (m7).** When a new online payment is started for a registration that has an order „Pooleli“, mark the older order „Asendatud“ (kept for audit, hidden from the Raha card). If a webhook later reports the replaced order as paid and the registration is already paid in full, record it under „Ootel kontrollil“ with the reason „Topeltmakse — tagasta“; otherwise count it normally. The Raha card shows only the latest open order.

Build B11–B22 as separate commits.

## 6. Parked items

Resolved: everything in Part 3 → „Final lists“ marked ✓, including m5 (B21) and m7 (B22). Left: shared-tablet attribution (not needed — Maria is the only course-day user), e-course contract copy button and „Võta number paberile“ (new features), testplan.json content, mail dark-mode logo (e-mails out of scope), TestPlan.tsx size / Telegram capping / stale plan text (code / Dim), all student and public-side items (out of scope).

**Phone layouts (B screens) and full C screens:** see `MS LAB Admin UX Pass - Part 4.dc.html`.

## 7. Tokens

Use G11 unchanged. The only new admin colour is #faf6f8, a row highlight for the selected or linked row. The type scale and radii are as in G11.
