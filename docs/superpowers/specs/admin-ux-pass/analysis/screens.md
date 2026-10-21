# MS LAB admin UX pass — screens, behaviour details and file map

Read-only analysis of `design_handoff_admin_ux/` (README + the prototypes) against the app in `C:/Users/Dmitri.MARKIT/source/repos/MSLab/app` (main `6832ccf`). Nothing in the repo was changed. Strings are in the companion file `ux-handoff-strings.md`; this file holds layout, behaviour, states, counts, notes and the file map.

## 0. Reading guide

- **Sources:** README (R), `MS LAB Admin UX Pass.dc.html` (P1, nav and patterns), `… - Part 2` (P2, A screens), `… - Part 3` (P3, B screens, C template, final lists), `… - Part 4` (P4, B on phone, every C screen), the deck, `AdminSidebar.dc.html`. Body text and the `x-dc` script data were both read; sizes below come from the inline styles of the mock-ups (so they are "as drawn", not specified in words).
- **What each screen section holds:** (1) details the README does not state, (2) the design's change note, verbatim (English, as written), (3) the click counts before → after, (4) the files that implement the screen today and what has to change.
- **Frames in the mock-ups:** desktop 1440 wide with a 235 px sidebar (grid `235px minmax(0,1fr)`; main padding 30/45); phone 390 × 844; drawers 560 px wide (full screen on a phone); every tap target 44 px (buttons 44–49 px, pills 44 px, inputs ≥ 44 px, radius 10; cards radius 22; chips radius 99).
- **Colour tokens seen in the mocks** (all existing G11 tokens except the row highlight): ink `#222`, dark sidebar `#242124`, active item `#51434c`, badge `#e6dce2`, ok `#eaf0eb/#2f5d46`, neutral `#ebe8e9/#5e5559`, attention `#e9e1e5/#6b4f5c`, error `#f3e6e6/#8a3b3b`, muted `#716a6d`, line `#e6e1e3`, input border `#d9d2d5`, pill border `#b9b1b5`/`#cfc6ca`, accent border `#9e8993`, new row highlight `#faf6f8`. Fonts: Jost 300/400 for headings and figures, Manrope for UI, JetBrains Mono only for prototype labels.

---

## 1. Questions Q1–Q5 and the owner's answers

Text from P1 ("Questions that change the design"; "I'm continuing with the default shown for each one"). All five are marked **Decided**.

| Q | Question and why it matters | Owner's answer |
|---|---|---|
| Q1 | **Do autosaved edits on published content go live at once?** Today a course or home-page edit goes public when she presses „Salvesta“. With autosave, the text would appear on the site about 1.5 s after she stops typing. The alternative is a draft layer with an „Avalda muudatused“ button, which is a second save model. | **Decided: draft layer.** On published content, autosave writes a draft; the header shows „Avaldamata muudatused: {n}“ with „Eelvaade ↗“ and the explicit „Avalda muudatused“. Unpublished items save straight to the record. |
| Q2 | **Is money received autosaved or explicit?** The figure in „Laekunud summa“ can confirm or un-confirm a place (obs. 4). Saving it as she types could flip a status halfway through a number. | **Decided: explicit.** Money is recorded as a payment with one button („Lisa laekumine“), which adds to the total and checks seats. This merges the two money paths and is listed as a behaviour change (B4). |
| Q3 | **Which tablet is used on the course day, and how is it held?** At 641–900 px the current layout uses a narrow 190 px sidebar, which leaves little room for the protocol on an iPad held upright (834 px). | **Decided:** below 900 px the phone top bar is used. The sidebar starts at 900 px. (Deck: "Tablet: below 900 px uses the phone layout. Maria only.") |
| Q4 | **Who writes the Russian, and when?** If it happens in a separate pass, possibly by someone else, the design should favour a side-by-side view. If Maria writes both languages as she goes, an inline switch is enough. | **Decided:** Maria writes both as she goes. One page switch with ET and RU; no side-by-side mode. |
| Q5 | **Should „Testimine“ appear in Maria's menu?** Today the overview card is its only entry point, and the card disappears once nothing is open (obs. 7). | **Decided: yes**, last in the „Haldus“ group for every admin. Its badge counts only the signed-in person's open checks. |

Status of the behaviour changes: P1 listed B1–B10; P2 added B11–B16 ("B1–B10 are accepted"); P3 added B17–B22 and marks **B1–B22 all accepted**; P4 and the deck ("22 / 22 behaviour changes accepted") agree. The README's first page still says "B11–B20 are still to decide" — stale (see § 5).

---

## 2. Part 1 — global patterns: what the README leaves out

### 2.1 Playback (P1 § 1, "What I understood")

- The admin works and the business rules stay. The job is fewer clicks, one way to save, and no lost input.
- Maria is the main user. At a 1360 px laptop she handles money, courses, content and newsletters. On a phone or tablet she handles the course day, registrations, students and assessing practical photos; the phone matters for daily work, not for the site editors.
- Today there are **five save models** side by side (obs. 1, G4). Only the protocol screen works the way the whole admin should (obs. 14); its autosave engine (`protocol-autosave.ts`) becomes the base for every form.
- **Explicit buttons remain only** for actions that leave the admin (mail, protocol, assessment, invoice, contract, newsletter) and for anything that cannot be undone.
- The work has to fit the existing app: server-rendered pages, CSS modules, drawers opened by a URL parameter, 44 px targets, old Safari. The look is refined, not rebranded.
- Wherever a better flow needs the server to behave differently, it goes on the behaviour-change list.
- Deck numbers: 5 save models, 4 pages with no menu entry, drawers that can lose typed text, money typed over in 2 ways, 12 ET/RU taps for one course.

### 2.2 Navigation (P1 § 2)

- "Five groups in place of a flat list of 16". Groups follow how often Maria visits (daily work, courses, site, setup). The four pages that had no menu entry (obs. 7): **Protokollid** (own row in „Igapäevane töö“; badge „Täna“), **Arved** (tab beside „Maksed“ under one row „Maksed ja arved“), **Tunnistused** (tab on „Hindamine“: „Ootab hindamist“ | „Tunnistused“), **Testimine** (own row in „Haldus“, overview card stays). The menu grows by two rows only (16 → 18; `AdminSidebar` lists 18 `active` options).
- Tabs are the existing pill links (`ui.filters`, same as „Tellijad | Kampaaniad“), each with its own URL; routes don't change.
- „Koduleht ja uudiskiri“ folds into a single row so the menu fits a 768 px tall laptop; it stays open when the current page is inside it. Icons are the existing `AdminIcon` set (not drawn in the mock). The „Protokollid“ page: with no parameter it opens a session list for today and the past 14 days (student and draft counts, today on top); "the five existing entry points stay".
- **Badge rule:** a badge counts things Maria has to act on, never totals; a badged row opens the page already filtered; pale pill `#e6dce2`; on the phone the menu button shows the sum.

| Menu row | Badge counts | Opens / status | Mock value |
|---|---|---|---|
| Registreerimised | awaiting prepayment | `?staatus=ootab`, as today | 3 |
| Protokollid | the word „Täna“ on a day with a session | new | „Täna“ |
| Hindamine | practical work + open answers + out of tries | as today; refreshes after „Ava test uuesti“ | 2 |
| Päringud | every request not done, including „Muutmine“; the overview tile uses the same number (obs. 12) | as today | 7 |
| Tagasiside | reviews waiting for „Avalda“ | new; badge opens Arvustused filtered to „Ootab kinnitust“ | 1 |
| Maksed ja arved | payments without an invoice + payments held „Ootel kontrollil“ | new | 6 |
| Testimine | the signed-in admin's checks marked „Viga“ | new | – |

- **Top line:** „Vaata kodulehte ↗“ appears once, in the top line. The copy in the sidebar footer and the overview's „Kiirlingid“ link are removed (obs. 11). The signed-in e-mail is shown as text above „Logi välja“, because a hover tooltip isn't available on touch screens.
- **Page eyebrow / H1 pairs in the P1 mock** (the `PAGES` array), with the note each carries:

| Menu | Eyebrow / H1 | Mock note |
|---|---|---|
| Ülevaade | date / „Tere, Maria.“ | landing page; redesigned in P2; „Kiirlingid“ loses its duplicate site link |
| Registreerimised | Kontaktõpe ja e-õpe / Registreerimised | badge opens `?staatus=ootab`; ListToolbar with search and a course/session scope |
| Protokollid | Koolituspäev / Protokollid | new: session list for today and the last 14 days; today on top, with student, draft and sent counts; one tap into the existing protocol screen |
| Hindamine | E-õpe / Hindamine (tabs Ootab hindamist, Tunnistused) | „Tunnistused“ is now a tab; header button „Väljastatud tunnistused“ removed |
| Päringud | Postkast / Päringud | badge = every request not done, same number as the overview tile; ListToolbar search added |
| Õpilased | Kontaktõpe ja e-õpe / Õpilased | table stays a table at 1360 px (container query at 760 px) |
| Tagasiside | Õpilased / Tagasiside (tabs Vastused, Arvustused) | new badge for reviews waiting for „Avalda“; badge opens Arvustused filtered to „Ootab kinnitust“ |
| Maksed ja arved | Montonio / Maksed ja arved (tabs Maksed, Arved) | „Arved“ is a tab; badge = paid without an invoice + held „Ootel kontrollil“ |
| Koolitused | Kontaktõpe ja e-õpe / Koolitused | course editor reworked in P3 (obs. 9) |
| Kalender | Kontaktõpe / Kalender | the drawer autosaves |
| Praktika | Praktika / Praktikapaketid | SaveBar replaced by SaveStatus |
| Avaleht, Koolitaja | Koduleht / Avaleht, Koduleht / Koolitaja | inside the folded group, which stays open; SaveStatus and LangSwitch in the header |
| Uudised | Blogi / Uudised | „Lisa postitus +“ creates; the post then autosaves |
| Hüpikaken | Turundus / Hüpikaken | name kept; the only „kampaania“ now; the newsletter tab is renamed „Kirjad“ |
| Uudiskiri | Uudiskiri / Uudiskiri (tabs Tellijad, Kirjad) | tab „Kampaaniad“ → „Kirjad“; sends stay explicit with ConfirmPanel |
| Seaded | Seaded / Seaded | one page, one SaveStatus, four save buttons gone; split into anchored sections in P3 |
| Testimine | Haldus / Testimine | new entry, reachable when nothing is open; badge = own „Viga“ checks |

- **Sidebar as drawn** (`AdminSidebar.dc.html`): 235 px wide, `#242124`, padding 22/14/16, gap 2; logo cropped to 132 × 52 (inverted); under it „Koolituskeskuse haldus“ 11 px `#a99ba4`; group label row 22 px (fold header 44 px with a 12 px chevron ▸/▾), group top padding 8 px (P1 prototype uses 10 px); items 44 px, radius 9, 500 13 px, text `#ccc0c8`, active `#51434c` + white; badge min 22 × 22, padding 0 7, 600 11 px; footer pinned with `margin-top:auto`, 1 px `#3a3338` top rule, „Sisse logitud“ 11 px, e-mail 12 px, „Logi välja“ row 40 px.

### 2.3 Saving (P1 § 3.1)

- Rule: "Everything saves itself, and one status line per screen says so." A field saves 1.5 s after typing stops, on blur, when the tab is hidden and before leaving the page; choices, toggles, reordering and uploads save at the moment of the tap; a local copy is kept until the server confirms; edits from two devices are caught by the same version check the protocols use.
- **What replaces what** (P1 table):

| Today | Becomes |
|---|---|
| SaveBar „Salvesta“ (Avaleht, Praktika, Koolitaja, Hüpikaken, Seaded, Uudised, Uudiskiri, course editor) | removed → SaveStatus in the page header |
| „Salvesta tunnistuse andmed“, „Salvesta arve andmed“, „Salvesta lepingud“ | removed; the cards autosave like the rest of the page |
| „Salvesta toimumine“, „Salvesta staatus“, the per-module „Salvesta“, the lesson drawer's „Salvesta“, **„Salvesta saaja“** | removed; the drawer header shows SaveStatus |
| „Salvesta summa“ | replaced by the explicit „Lisa laekumine“ (Q2) |
| „Lisa toimumine“, „Lisa õpilane“, „Lisa koolitus +“, „Lisa postitus +“ | stay as the single explicit create; after that the item autosaves |
| „Saada…“, „Koosta arve“, „Märgi tasutuks“, „Ava ligipääs“, „Kopeeri“ | stay explicit: they leave the admin or create a record |

- **SaveStatus, all states** (P1 text; the README table has the same states and colours): at rest = the time of the last confirmed save · during the 1.5 s wait after typing · request in flight · "re-reading after Back, a hidden tab or a reconnect" · offline or server error, retries 2/5/10/20/30 s · one field fails validation, the other fields still save · 401, the text is kept on this device · version conflict, opens the protocols' notice with a new „Taasta minu tekst“.
- **Placement:** right end of the page-heading row, aligned with the H1 and beside „Vaata lehel ↗“; in a drawer beside ✕; on a phone under the H1; on the protocol screen in the card corner. One per screen, `role=status`, announces only changes of state.
- **Prototype ("Try it")**: a course form with „Koolituse nimi“ (clearing it shows „Täida see väli (eesti keeles).“ and the status „Salvestamata — kontrolli märgitud välja“), „Grupikoolituse hind (€)“, an „Õppevorm“ choice (E-õpe / Kontaktõpe) that saves at once ("A tap saves at once, with no wait"), and a "Simuleeri: võrk kadus / võrk tagasi" switch that is prototype only.
- **Rules (P1):** a field that fails validation is held back, marked and listed in the status; valid fields keep saving ("one bad price never blocks a description"). New records are created by their one explicit button; before that the drawer shows „Täida kohustuslikud väljad“, not a save status. Removing a list row, image or file is instant and offers „Võta tagasi“ for 8 s. Published items (course, home page, post, popup, practice): autosave writes a draft; the header adds „Avaldamata muudatused: {n}“, „Eelvaade ↗“, „Avalda muudatused“ (explicit, it changes the public site) and „Loobu muudatustest“ (ConfirmPanel). Changing „Õppevorm“ updates the modules card below immediately (fixes the stale-card friction, appendix 02).

### 2.4 Drawers and unsaved input (P1 § 3.2)

- Drawers stay `Drawer.tsx`, opened by a URL parameter, 560 px wide, full screen on a phone. Because they autosave, closing with ✕, Esc or the backdrop is safe; closing waits only when something isn't confirmed yet.

| State when she closes | Behaviour |
|---|---|
| Everything saved | closes at once; focus returns to the row, as today |
| Save in flight or waiting | the pending save is sent first and the drawer closes when it is confirmed, usually under a second; nothing is asked |
| Can't save (offline, error, invalid field) | in-place question at the top of the drawer: what isn't saved and why; „Jää siia“ is the primary button and returns focus to the field; „Sulge, tekst jääb seadmesse“ keeps the local copy and restores it the next time the drawer opens |
| An upload is still running | same question; the upload carries on while she stays |

- Prototype: the Kalender drawer (`?id=12`) with three states (Kõik salvestatud / Salvestamine käib / Võrk puudub); in the failing state ✕ shows „Muudatust „Kohti“ ei saanud veel salvestada.“ + „Ühendus puudub. Proovin uuesti, kuni jääd siia.“ + „Jää siia“ / „Sulge, tekst jääb seadmesse“; after closing it prints "The drawer closed and focus went back to the row."
- Navigation within the admin (sidebar, links, Back) uses the same guard through one `useLeaveGuard` in Shell ("covers the parked 'unsaved warning on in-admin navigation' item"); `beforeunload` stays only for closing a tab while text is unconfirmed. Drawers that only show information (feedback answers) have no status line. The scroll lock gets `scrollbar-gutter: stable` (closes the parked layout-shift item on Windows).

### 2.5 Confirmations (P1 § 3.3)

One ConfirmPanel (replaces G8 A/B/C); opens in place of its trigger, takes focus, states the question and lists the consequences in plain lines (who gets mail, what changes in public, what can't be undone); the "yes" button repeats the action and its count; „Katkesta“ returns focus to the trigger. A send uses the ink primary button; a destructive action uses the danger outline. The count matches the tile on the overview (obs. 12).

**§ 3.3 — when a confirmation is needed (the list the README points to):**

| Pattern | When | Examples (verbatim from P1) |
|---|---|---|
| ConfirmPanel | the action can't be undone, or it mails more than one person, or it changes what a student has right away (access, seat, test) | „Kustuta …“, „Lukusta ja saada kõik“, „Saada kõigile“, „Tühista registreerimine“, „Tühista arve“, „Võta tasumine tagasi“, „Lõpeta ligipääs“, „Peata saatmine“, and saving a changed e-course contract that makes students re-accept |
| Informed button | a send to one person, with the summary written on the button itself: one tap, nothing hidden | „Saada protokoll Eliisele“, „Saada hinnang · 3 kinnitatud, 1 paranda“, „Saada test tagasi · 1 vale“ — the protocol send and the test-review send now behave the same way (obs. 5, 13) |
| UndoBar | a reversible one-tap action: remove an image, file or list row, hide or publish a review, mark a request done | shows „{Mis juhtus}. Võta tagasi“ for 8 s |
| Refuse early | an action that isn't possible isn't offered; the reason is shown where the button would be | a booked session shows „Toimumisel on registreeringuid — märgi see „Tühistatud“.“ in place of „Kustuta toimumine“, "so she doesn't need three taps to find out (appendix 03)" |

Other ConfirmPanels the design adds elsewhere (not in that list): „Loobu muudatustest“ (A/B/C draft bar), „Koosta {n} arvet“ (A6), „Ava test uuesti“ and „Ava järgmine õppetund“ (existing, re-skinned), „Kas tühistan toimumise?“ (B3), „Kustuta mustand“ (B5), „Avalda uus leping“ (B4), „Kas vahetan liigi?“ and „Kustuta õppetund“ / „Kustuta punkt“ (B2), „Kustuta postitus“ (C3), the protocol „Saada kõigile ({n})“ (A3), the newsletter „Saada kõigile ({n})“ (B5).

**Mock-ups (P1):**
- Destructive: button „Tühista registreerimine“ → „Kas tühistan Kati Kase registreerimise?“ / • „Koht 05.12 Pärnu koolitusel vabaneb kohe avalikus kalendris.“ / • „Laekunud 175 € ja arve MSL2026-004 jäävad alles.“ / • „Õpilasele kirja ei saadeta.“ / „Jah, tühista“ + „Katkesta“ → result „Registreerimine on tühistatud.“ (+ "reset demo").
- Bulk send: „Kas saadan kirja „Jõulupakkumine“?“ / • „4 kinnitatud tellijat: 3 eesti, 1 vene keeles.“ / • „Näidisaadressidele (@example.test) ei saadeta.“ / • „Saadetud kirja ei saa tagasi võtta ega muuta.“ / „Jah, saada 4 tellijale“ + „Katkesta“.
- Informed button + UndoBar: „Saada hinnang · 3 kinnitatud, 1 paranda“ ("One tap. The counts update as she taps verdicts"); „Eemalda pilt“ → „Pilt eemaldatud.“ + „Võta tagasi“. UndoBar sits bottom-left (bottom, full width on a phone), isn't stacked (a new action replaces the previous bar), `role=status`, Esc dismisses it.

### 2.6 ET/RU editing (P1 § 3.4)

- The ET/RU pills on each field are removed; one LangSwitch in the page header sets the content language for every I18nInput on the page through context; ET is the default; the choice is remembered per device. In RU mode each field shows its Estonian text in grey above the input; an empty RU field keeps the „tõlge tulekul“ tag and offers „Kopeeri eesti keelest“ (a 44 px link); the switch counts untranslated fields („RU puudub 3 väljal“) with „Järgmine →“; rules unchanged (ET is required when RU is filled, error text unchanged); admin labels stay Estonian, only content switches.
- Clicks for a Russian pass over a course with 12 bilingual fields: **12 → 1** (one tap on RU) plus one tap per „Järgmine“ if used.
- Prototype: „Sisu keel“ + „ET“ | „RU“ (ink-filled active), sample fields „Koolituse nimi“ and „Lühikirjeldus“; the P1 component table still mentions a „Kõrvuti“ mode that Q4 removed.

### 2.7 Lists (P1 § 3.5)

- ListToolbar combines search, the existing filter pills (now with counts), one optional scope select and the count line; **all of it lives in the URL**, so a drawer's back link and „Tagasi“ return to the same filtered view (appendix 07–10). The pager stays as it is (50 rows).
- Search: name, e-mail or phone; invoice number on Arved; Montonio id on Maksed; filters as she types (300 ms), `?otsi=`. Added to Registreerimised, Päringud, Maksed, Arved, Tagasiside, Tunnistused and Uudiskiri. Scope select: „Koolitus / toimumine“ on Registreerimised; „Kuu“ on Arved, applied on change, so „Näita“ goes and the CSV always matches what's on screen. Pill counts: the existing `pillCount` bubble on every status row. Rows: the whole row opens the drawer; the table switches to label/value cards below a 760 px card width (today 980) so it stays a table on a 1360 px laptop.
- Prototype (Registreerimised, type „kas“ or „+372 5000 0007“): search box with ⌕ and ✕, select „Kõik koolitused ja toimumised ▾“, pills with counts, count line „Registreerimisi: n“ + sort note „Uuemad eespool“, columns „Kuupäev | Nimi ja kontakt | Koolitus ja toimumine | Laekunud | Makse | Staatus“ (the mock still has a „Makse“ column that the P2 screen drops), search-empty text „„{q}“ järgi registreerimisi ei leitud.“ + „Tühjenda otsing ja filtrid“. Note under the table: „Laekunud“ shows the money actually received; „Makse“ is her 100 % / 50 % choice (obs. 6).
- **Empty:** two kinds: nothing exists („Registreerimisi veel pole.“ — "say so, offer nothing"); filtered („Selle valikuga registreerimisi pole.“ + „Tühjenda otsing ja filtrid“). **Loading:** new `loading.tsx`, static grey rows with no shimmer (reduced motion), shown only after 300 ms; the page header and toolbar stay in place. **Error:** new `error.tsx` for the panel layout — "so the sidebar stays. Today a failed read takes down the whole page."

### 2.8 Glossary (P1 § 3.6) — "one word per action"

| Action | The one word | Replaces |
|---|---|---|
| Leave a form / say no | „Katkesta“ | „Ei“, „Tagasi“ (in confirmations), „Tühista“ (review form, campaign confirm) |
| Say yes | „Jah, {tegusõna}“ | „Saada“ inside confirmations → „Jah, saada {n} …“ |
| Cancel a business record | „Tühista {asi}“ | unchanged („Tühista registreerimine“, „Tühista arve“) |
| Download a file | „Laadi alla ({vorming})“ | „Laada alla“ (certificates), „Lae alla … (CSV)“ (newsletter, overview) |
| Open the public site | „Vaata kodulehte ↗“ | „Vaata lehte ↗“ (sidebar, Kiirlingid), shown once in the top line |
| Open this item on the site | „Vaata lehel ↗“ | already used in editors; keep |
| Close a drawer or viewer | „Sulge“ | mixed aria labels per page; one label |
| Back to a parent page | „← {Lehe nimi}“ | „Tagasi“, „Hindamisse“, „Kalendrisse“, „Registreeringu juurde“ |
| Send / send again | „Saada …“ / „Saada uuesti“ | unchanged; adds the recipient or summary (3.3) |
| Undo the last tap | „Võta tagasi“ | new (UndoBar); matches the existing „Võta tasumine tagasi“ |
| Popup vs newsletter | „Hüpikaken“ / „Kirjad“ | „Uudiskiri → Kampaaniad“ becomes „Kirjad“, so „kampaania“ only ever means the popup offer |

Main rule: „Tühista“ is only ever a business action (cancelling a registration, an invoice or a session); stepping out of a form or question is always „Katkesta“.

### 2.9 Components, new and changed (P1 table)

| Component | Kind | Description (P1) |
|---|---|---|
| SaveStatus | NEW | one status chip per screen; replaces SaveBar and every status line |
| useAutosave | NEW (from protocol-autosave.ts) | debounce, blur, hide, retry, local copy, version check; one owner per form part |
| useLeaveGuard | NEW | in Shell; guards sidebar links, Back and drawer close while anything is unconfirmed |
| ConfirmPanel | NEW | replaces G8 A/B/C: question, consequence lines, „Jah, …“, „Katkesta“ |
| UndoBar | NEW | 8 s „Võta tagasi“ after a reversible one-tap action |
| LangSwitch | NEW | page-level ET / RU / Kõrvuti (sic); context read by I18nInput; missing count + „Järgmine →“ |
| ListToolbar | NEW | search, filter pills with counts, scope select, count line; all in the URL |
| Sidebar | CHANGED | groups, folding group, new entries, e-mail in footer, one site link |
| Drawer | CHANGED | SaveStatus in header, close guard via useLeaveGuard, scrollbar-gutter |
| I18nInput | CHANGED | no own pills; ET reference, side-by-side and copy-from-ET modes (sic) |
| list-table.module.css | CHANGED | whole row is the link; card breakpoint 980 → 760 px |
| SaveBar | REMOVED | along with the course editor's copy and the three Seaded card buttons |

Only in the README (not in this table): PublishBar and the draft layer, `error.tsx` / `loading.tsx`, `LangSwitch` replacing today's exported `LangSwitch` in `I18nInput.tsx` (same name, different component).

### 2.10 P1 behaviour list B1–B10 (as worded in P1) and parked items closed by P1

B1 Autosave everywhere (per-part save endpoints for every editor and drawer, the protocols' versioned POST pattern) · B2 Draft layer on published content (supersedes "live on save") · B3 Partial saves (today a single error refuses the whole save) · B4 One money path („Lisa laekumine“ adds a payment with a seat check, the same as „Märgi tasutuks“) · B5 Undo for removals (instant, 8 s restore window; needs soft delete or a delayed purge for files) · B6 New counts (badges for Tagasiside, Maksed ja arved, Testimine; the Hindamine badge refreshes after „Ava test uuesti“) · B7 Search on all people/money lists (`?otsi=` on Registreerimised, Päringud, Maksed, Arved, Tagasiside, Tunnistused, Uudiskiri, plus a course/session filter on Registreerimised) · B8 Protokollid index · B9 Overview counts agree ("The newsletter tile counts only sendable confirmed subscribers, matching „Saada kõigile“") · B10 Confirm on cancel registration (+ "The single-student protocol send gets an informed button with no confirm").

Parked items closed by P1: in-admin unsaved warning, scroll-lock shift, sticky save line (Testimine), Seaded card guards, overview → Arved link, list cards at 1360 px, Arved month/CSV mismatch, review-badge gap.

---

## 3. Screens

Paths are relative to `app/src`. "Today" = what the code does now; "Change" = what the design needs beyond the README's bullet list.

### 3.0 Sidebar, shell, phone menu (cross-screen)

**Beyond the README**
- The sidebar, group, fold and badge measurements are in § 2.2. Fold header: the whole 44 px row is the button; chevron ▸ closed / ▾ open; in the P1 prototype the fold starts closed, opens on click and is forced open while the active page is inside it. The deck draws "KODULEHT JA UUDISKIRI ▸" as one row.
- Top line (mock): left „MS LAB · Halduskeskkond“, right „Vaata kodulehte ↗“ and the name with an avatar initial („Maria“, „M“). The avatar keeps no tooltip.
- Phone (below 900 px), as drawn: a 64 px bar `#242124` (padding 0 12 0 16) with the **current page name** at the left (500 14 px `#ccc0c8`; the overview bar shows the logo instead) and a 44 × 44 round `≡` button at the right (1 px `#51434c` ring) that carries the badge sum (mock "13"; the glyph turns into ✕ while the menu is open). Today's bar shows the logo, not the page name. The menu lists all groups expanded (no fold): group labels at 8 px top spacing, the same 44 px rows and badges; at the very top, on a course day, a card „TÄNA 10:00“ + „Protokollid · Kulmumeistri baaskoolitus“ that opens the session; footer: e-mail line, „Vaata kodulehte ↗“, „Logi välja“. The overview on a phone starts with the same course card (shorter text, see A1).
- Phone page body: background `#f6f4f5`, padding 16, gap 12; H1 in Jost 300 30 px with the page's one explicit action beside it (e.g. "Lisa +"); pills and buttons 44 px; cards radius 18; SaveStatus under the H1.
- Menu "active" state: README maps `/admin/arved` → „Maksed ja arved“, `/admin/tunnistused` and `/admin/hindamine/test` → „Hindamine“, `/admin/protokollid*` → „Protokollid“.

**Click counts:** ET/RU pass over 12 bilingual fields 12 → 1 (P1); see each screen for the rest.

**Today (files)**
- `components/admin/Shell.tsx` (server component, **rendered by every page**, not by a layout; reads `getAdminCounts()` for the badges: registrations, assessment, requests only; builds `items` from `SECTIONS`; avatar `title` = `shell.signedInAs`), `components/admin/Sidebar.tsx` (client; flat `NavContent` with a footer "Vaata lehte ↗" link and "Logi välja"; `WIDE = "(min-width: 641px)"`; the menu `<dialog>` is the phone drawer), `components/admin/sections.ts` (the `Section` union and `SECTIONS`, 16 entries, hrefs), `components/admin/Shell.module.css` (breakpoints 1180 / 900 → `grid-template-columns: 190px` / 640), `components/admin/Sidebar.module.css` (900 / 640), `components/admin/data.ts` (`getAdminCounts = cache(adminCounts)`), `db/queries/admin.ts` `adminCounts` (L476: awaiting, requests by kind, purchase interest, subscribers, assessment), `components/admin/AdminIcon.tsx`, `components/admin/ReadyMark.tsx`, `app/admin/(panel)/layout.tsx` (only `requireAdmin()`), `app/admin/layout.tsx`.
- Shared: `components/admin/Drawer.tsx` (+`Drawer.module.css`; `confirmClose` prop used only by the lesson drawer; `closeLabel` passed per page, all "Sulge" in the dictionary), `ui.module.css` (pills, `pillCount`, notice, rows), `list-table.module.css` (used by Registreerimised, Õpilased, Maksed, Tagasiside, Tunnistused; container query at 980), `Pager.tsx`, `SaveBar.tsx` + `useSiteDraft.ts` + `site-draft.ts` (site editors' draft/versions), `protocol-autosave.ts` (1441 lines; the engine to generalise), `I18nInput.tsx` (exports today's `LangSwitch`), `ListEditor.tsx` (shared-language rows), `lib/modal` (`lockPageScroll`).
- **Change:** add `Section` entries for protocols and testing; group the menu; extend `adminCounts` (unbilled paid payments, `kontroll` payments, voided-after-paid, waiting reviews, own „Viga“ checks, today's sessions) and `Shell` badges; replace `viewSite` footer link; move the 900 px breakpoint into `WIDE` and both CSS files; add `scrollbar-gutter: stable`; `(panel)/loading.tsx` and `error.tsx` (see § 5: Shell is inside every page, so the sidebar would disappear on an error).

---

### A1 Ülevaade — `/admin`

**Beyond the README**
- **Desktop layout (P2):** the Täna card full width on top (when a session is today), then a two-column grid `1.15fr | 1fr` (gap 22): „Sinu järjekord“ left, „Tulevased koolitused“ right. Heading: eyebrow "— Teisipäev, 20. oktoober", H1 "Tere, Maria." (Jost 300 42/1.08).
- **Täna card (P2):** dark `#222`, white text, radius 22, padding 26 × 30, text left / button right, gap 24; eyebrow „TÄNA 10:00 · PÄRNU, MS LAB STUUDIO“ (600 11 px, spacing .14em, `#c0b7bb`); course in Jost 400 28/1.15; counts 14 px `#d5d0d3` („3 õpilast · protokollid: 1 saadetud, 1 mustand, 1 alustamata“); button a white pill, 49 px, padding 0 24, „Ava protokollid →“. Phone: eyebrow „TÄNA 10:00 · PÄRNU“, line „3 õpilast · 1 saadetud“, button „Ava protokollid“ (no arrow).
- **Sinu järjekord:** a white card (radius 22, padding 24 × 28) with the title in Jost 300 27 px; each row is a grid `56px | 1fr | 24px`, min-height 64, padding 8 0, 1 px `#e6e1e3` top rule (none on the first); count Jost 300 30 px; label 600 14 px; hint 13 px muted; „→“ at the right. Mock rows and hints: 3 „Ootab ettemaksu“ — „Vanim 15.10 · Мария Кузнецова“; 2 „Ootab hindamist“ — „1 praktiline töö · 1 testi vastus“; 7 „Päringut tegemata“ — „2 kontakt · 2 individuaal · 1 praktika · 2 ootenimekiri“; 6 „Arveta makset“ — „Koosta arved ühe nupuga“; 1 „Arvustus ootab avaldamist“ — „Kristel M. · Lash Lift BOTOX“; 1 „Makse ootel kontrollil“ — „Анна Иванова · 170 € · kontrolli Montonios“. Only the first hint is specified in the README.
- **Empty queue:** a separate white card (padding 20, radius 22) with „Järjekord on tühi.“ in Jost 300 22 px and the hint line „Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.“; "The upcoming courses stay below it."
- **Tulevased koolitused:** card padding 24 × 28, title Jost 300 27 px; at the right of the title the note „järgmise 30 päeva jooksul: 4“ (13 px muted); columns `90px | 1fr | 70px` „Kuupäev | Koolitus ja linn | Vabu kohti“ (11 px/500 header; rows min-height 52; the course in bold with the city under it in 12 px muted; the seat value "free / capacity" right-aligned, 600, red `#8a3b3b` only when 0); link „Kalender →“. Five rows (today's `UPCOMING_ROWS`). Rows are links to `/admin/kalender?id=` (today they don't respond to a click).
- Phone: Täna card → queue → upcoming list stacked. The phone top bar on the overview carries the logo (99 × 39 crop) beside `≡`; other pages print the page name there (§ 3.0).
- The Testimine card "stays the same and is shown only to the admin with open checks" (that is today's behaviour).
- Removed: „Vaata registreerimisi →“ button, the four tiles incl. „Kinnitatud uudiskirja tellijad“ ("the number moves to Uudiskiri"), the „Ootab hindamist“ card, the „Päringud“ card, „Kiirlingid“ ("duplicate site link; the CSV moves to Uudiskiri → Tellijad", obs. 11, 12).

**Change note (P2):** "• The four tiles, the „Ootab hindamist“ card and the „Päringud“ card become one list, „Sinu järjekord“. Each row is something to act on, with a one-line hint and a link to the filtered view. Rows at 0 disappear. • „Täna“ moves to the top on a course day and shows protocol progress. • Removed: the „Vaata registreerimisi →“ button (the menu does this), the „Kinnitatud uudiskirja tellijad“ tile (the number moves to Uudiskiri) and „Kiirlingid“ (duplicate site link; the CSV moves to Uudiskiri → Tellijad). Obs. 11, 12. • Upcoming-course rows now open that session's Kalender drawer. Today they don't respond to a click. • The Päringud row counts „Muutmine“ too, so it matches the badge (obs. 12). • The Testimine card stays the same and is shown only to the admin with open checks."

**Clicks (P2):** today's protocols 1 → 1 · who owes prepayment 1 → 1 · open requests (incl. Muutmine) 1 → 1 · invoices (Arved) 2 → 1 · a session's details from the upcoming list 2 → 1 · subscriber CSV 1 → 2 (moved to Uudiskiri).

**Today (files):** `app/admin/(panel)/page.tsx` (257 lines: greeting + primary button, `stats` list, "Ootab hindamist" card with `waitingGroups`, `TestplanCard`, `today` card, upcoming table (`UPCOMING_ROWS = 5`), `inbox` rows by request kind, "Kiirlingid" card), `overview.module.css`, `components/admin/TestplanCard.tsx`, `data.ts`, `db/queries/protocols.ts` (`todaySessions`), `db/queries/public.ts` (`listUpcomingSessions`), `db/queries/assessment.ts` (`assessmentQueue`), `server/testplan.ts` (`testplanCard`).
**Change:** delete the stats/assessment/inbox/links blocks; add the queue (needs counts the page does not have: oldest awaiting registration with name, unbilled paid payments, `kontroll` payments, waiting reviews via `server/reviews.ts` `pendingReviewCount`, per-session protocol counts for the Täna card); make upcoming rows links; drop `overview.lead`.

---

### A2 Registreerimised — `/admin/registreerimised` (+ drawer `?id=`)

**Beyond the README**
- **List (desktop, 1440):** under the H1 stays the line „Koht on kinnitatud, kui laekunud on vähemalt 50% koolituse hinnast.“. Toolbar order: search („Otsi nime, e-posti või telefoni järgi“), select „Kõik koolitused ja toimumised ▾“, status pills with counts („Kõik 17“, „Ootab ettemaksu 3“, „Kinnitatud 13“, „Tühistatud 1“), a second pill row for the form („Kõik vormid“, „E-õpe“, „Kontaktõpe“), count line „Registreerimisi: 17“. Columns `90px | 1.3fr | 1.3fr | 110px | 130px`: Kuupäev | Nimi ja kontakt (name over phone) | Koolitus ja toimumine (course over „12.12 · Tallinn“) | Laekunud („0 / 290 €“, „220 / 220 €“) | Staatus pill (Ootab ettemaksu `#e9e1e5/#6b4f5c`, Kinnitatud `#eaf0eb/#2f5d46`, Tühistatud `#f3e6e6/#8a3b3b`). The row whose drawer is open is highlighted `#faf6f8`.
- **Phone list:** cards; pills only „Kõik 17 | Ootab ettemaksu 3 | Kinnitatud 13“ (no Tühistatud); each card name + status pill, course, then „{session} · laekunud {x}“.
- **Drawer head:** status pill left, SaveStatus („✓ Salvestatud 12:04“) and ✕ right; name (Jost 30); subtitle „Lash Lift BOTOX baaskoolitus · 12.12.2026 10:00 · Tallinn, Stuudio Kalamaja · Grupp“ (phone: „Lash Lift BOTOX · 12.12 Tallinn · Grupp“); phone and e-mail links. „Ava protokoll“ is not drawn (README: contact courses only).
- **Raha card** (bg `#f6f4f5`, radius 18): header „Raha“ (Jost 400 20) with „Valitud: ettemaks 50%“ right-aligned (13 px muted); figure „0 €“ (Jost 300 34) + „/ 290 € laekunud“; an 8 px bar with a 2 px ink marker at 50 % that overshoots the bar by 5 px above and below; „Koht kinnitub 145 € juures · vabu kohti 2 / 4“; online payment line „Veebimakse 17.10 20:35 · 145 € · Pooleli“; button „Lisa laekumine“.
- **„Lisa laekumine“ panel** — the desktop mock draws it already open (title „Lisa laekumine“; white box, left border 2 px `#9e8993`, radius 0 14 14 0, padding 16); the phone mock draws the closed state, only the button „Lisa laekumine“. Panel contents: amount pills 44 px — „145 € · ettemaks“ (selected: `#ebe8e9`, 1 px `#222`), „290 € · kogu summa“, „Muu summa“; date field (150 px label column; 44 px input, radius 10, border `#d9d2d5`; mock „20.10.2026“); method pills (44 px, 12 px/600): Pangaülekanne (selected) · Sularaha · Kaart; checked box „Koosta kviitung (arve „Juba tasutud“)“; submit (ink) „Lisa 145 € · koht kinnitub“ and „Katkesta“. The "kogu summa" pill is the full price in the mock (290 €) though 0 € was paid; README says "the full remainder".
- **Results:** seat check fails → „145 € lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.“ ("Same server text as „Märgi tasutuks“ today. Payment and receipt are kept; Maria decides on the waitlist."). Success → „145 € lisatud · kviitung MSL2026-005 · koht kinnitatud.“ and the status pill turns „Kinnitatud“. "No undo bar here: undoing money goes through the receipt's „Võta tasumine tagasi“ (ConfirmPanel)."
- **Staatus ja märkus:** heading; two radio pills, 44 px (Ootab ettemaksu | Kinnitatud; selected = 1 px ink border on `#ebe8e9` with a filled 12 px dot, unselected = ring dot); then a 64 px high note box whose label text „Märkus — näeb ainult haldus“ (phone: „Märkus“) sits inside the box.
- **Arved block:** row „MSL2026-001 Tasumata 145,00 €“ / „Ettemaks 50% · Maksta kuni 27.10.2026“ / buttons „Saada õpilasele“, „Laadi alla (PDF)“, „Veel ▾“.
- **Folded rows** (52 px, summary right, ▸): „Leping — Sellele registreeringule pole lepingut“ · „Tagasiside — pole antud“ · „Registreerimise andmed — 11 rida“ · the mock draws a fourth row „Tühista registreerimine — ConfirmPanel ▸“ (README: a danger button after the folds).
- **Phone drawer:** first screen = header (status pill, SaveStatus, ✕), name, subtitle, phone, Raha (only „Lisa laekumine“), „Staatus ja märkus“; then folded rows „Arved — 1 tasumata ▸“ and „Leping — puudub ▸“. "Today it takes three screens."
- **Drawer not found:** card with „Seda registreerimist ei leitud.“ and link „← Registreerimised“.

**Change note (P2):** "• List: ListToolbar with search (name, e-mail, phone), a course/session scope and status pills with counts (obs. 6). „Laekunud“ shows money received as „0 / 290 €“. „Liik“, „Modelli abi“ and „Konto“ move into the drawer. The whole row opens the drawer. • Drawer order follows Maria's daily inputs (obs. 3): head with contact → Raha with „Lisa laekumine“ → status and note → invoices → folded Leping, Tagasiside and details → „Tühista registreerimine“. • One money path (B4, obs. 4): „Lisa laekumine“ adds a payment. The amount still owed up to 50 % is preselected and a receipt is ticked by default, so one action records the money, confirms the place (with a seat check) and makes the receipt. „Laekunud summa“ is no longer typed over. A wrong entry is undone through the receipt's „Võta tasumine tagasi“. • Status and „Märkus“ autosave. The status pills are a manual override with two choices; cancelling happens only through „Tühista registreerimine“ and its ConfirmPanel (B10). • Invoices: only one „Koosta arve“ button appears, never two (obs. 3). Rarely used invoice actions sit under „Veel ▾“. • The phone drawer shows head, money and status on the first screen. Today it takes three screens."

**Clicks (P2):** record a bank prepayment + receipt 5–7 → 3 · record a prepayment, no receipt 2 + typing → 3, no typing · change status / add a note 3 + typing → 2 + typing · cancel a registration 2 → 3 (confirm added) · find one person paging → typing · mark an invoice paid 3 → 3 · open the protocol 2 → 2.

**Today (files):** `app/admin/(panel)/registreerimised/page.tsx` (416 lines; params `?vorm=e|k`, `?staatus=ootab|kinnitatud|tuhistatud`, `?leht`, `?id`), `components/admin/RegistrationForms.tsx` (three `useActionState` forms: `saveRegistrationPayment` typed amount, `saveRegistrationStatus` with the `expected` stale guard and **three** radios incl. „Tühistatud“, `cancelRegistration`), `PaymentLines.tsx` (online payments), `PaidFields.tsx` (date + method choice Pangaülekanne / Sularaha / Kaardimakse kohapeal, reusable for the new panel), `InvoiceBlock.tsx` + `InvoiceRow.tsx` (+`InvoiceBlock.module.css`; both a generic and a per-payment „Koosta arve“ today), `ContractBlock.tsx`, `FeedbackAnswers.tsx`, `StatusPill.tsx`, `Pager.tsx`, `registrations.module.css`, `RegistrationForms.module.css`, `list-table.module.css`; server: `server/actions/admin.ts` (L31 `saveRegistrationPayment`, `saveRegistrationStatus`, `cancelRegistration`), `server/admin.ts`, `db/queries/admin.ts` (`pageRegistrations`, `getRegistration`, `recordRegistrationPayment`, `addRegistrationPayment` L403 — already adds + seat check under lock), `server/invoices.ts` (`createInvoice`).
**Change:** new `addRegistrationPayment`-based action (add + receipt in one transaction), delete `saveRegistrationPayment`; move the three forms to autosave/instant save; two-pill status (see § 5: today's third option is how a cancelled registration is reinstated); `ListToolbar` with search/scope/counts; columns; folded rows; ConfirmPanel for cancel.

---

### A3 Protokollid — `/admin/protokollid`

**Beyond the README**
- **Index (P2 mock, desktop):** white card (radius 22, padding 8 × 28); under the H1 a note „Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.“; rows grid `150px | 1fr | 300px | 150px`, gap 18, min-height 84, 1 px `#e6e1e3` rules: date in Jost 400 22 px („Täna“ / „29.09“) over a 13 px weekday („teisipäev, 20.10“) | course over „10:00 · Pärnu, MS LAB stuudio“ | counts text 13 px/600 — `#6b4f5c` while incomplete („3 õpilast · 1 saadetud · 1 mustand“), `#2f5d46` when done („✓ Kõik 3 saadetud“) | „Ava“ pill 44 px, ink for today, outline `#b9b1b5` for past days. Section label „INDIVIDUAALKOOLITUSED“ (11 px/600, spacing .14em, `#716a6d`) with rows „Aeg kokkuleppel“ | student („Piret Kalda (näidis)“) + course | „Alustamata“ | „Ava“.
- **Phone protocol screen:** top bar `≡`, „← Protokollid“, course title, „Täna 10:00 · Pärnu, MS LAB stuudio“, button „Saada kõigile (2)“ at the top, student chips (initial + state: „Eliise T.“, „Kadri L. Saadetud“, „Маргарита О. Mustand“), the open student card „Eliise Tamm (näidis)“ with the corner chip „✓ 12:41“, stage headings („Praktiline osa“, „Ettevalmistus“ with sample text, „Kulmude analüüs“, „Värvimine“) and at the bottom „Saada protokoll Eliisele“.
- The mock's Täna row and a 29.09 row (the latter is 21 days before the mock's 20.10, outside the stated 14 days).

**Change note (P2):** "• New index (B8): today's sessions and the last 14 days, with per-session counts. Individual courses are listed below. On a day with exactly one session, the menu goes straight to that session's protocol screen. • The protocol screen (obs. 14) stays as it is: chips, one card, autosave in the corner. Only the words change. The status chip is now SaveStatus; the back link is „← Protokollid“; the per-student send is an informed button („Saada protokoll Eliisele“), still with no second step; „Lukusta ja saada kõik“ becomes „Saada kõigile (2)“ with ConfirmPanel words („Jah, saada 2 protokolli“ / „Katkesta“). There is no separate "lock" step, so the word is dropped. • The conflict notice gets „Taasta minu tekst“, which puts this screen's lost words back into the boxes. Today they have to be copied by hand."

**Clicks (P2):** open today's protocols from the menu 2 → 1 · find a past session's protocols 3 → 2 · send one student 1 → 1 · send everyone at day's end 2 → 2 · recover lost words after a conflict copy by hand → 1.

**Today (files):** `app/admin/(panel)/protokollid/page.tsx` (153 lines; `?sessioon=`, `?registreering=`, `?ligipaas=` — the last one is the **practical-work assessment screen** of A4; with no parameter it shows a "not found" card with „Kalendrisse“; `maxDuration = 300` for the send-all; `active` is `calendar` / `registrations` / `assessment` by parameter), `components/admin/ProtocolScreen.tsx` (+`ProtocolScreen.module.css`), `ProtocolSend.tsx` (per-student „Saada“, „Lukusta ja saada kõik“ with `protocols.confirm.*` summary lines), `protocol-autosave.ts`, `db/queries/protocols.ts` (`protocolScreen`, `screenStudents`, `todaySessions`), `server/protocols.ts`, `server/actions/admin-protocols.ts`, `app/api/admin/protokoll/route.ts` (autosave POST).
**Change:** index branch for the no-parameter case (+ `Section` "protocols", B16 shortcut in the menu); labels; SaveStatus; conflict restore (B13); the active-state rule must keep `?ligipaas=` under Hindamine.

---

### A4 Hindamine — `/admin/hindamine`, `?ligipaas=` (on `/admin/protokollid`), `/admin/hindamine/test`

**Beyond the README**
- **Queue (P2 mock):** pill tabs „Ootab hindamist 2“ (ink) | „Tunnistused“; one white card, rows with name + type („Merilin Kuusk · praktiline töö“ / „Светлана Петрова · testi vastus“), a meta line („1. kord · 20.10 18:35“ / „katse 2/3 · 20.10 19:35“) and one button — „Hinda“ (ink) for practical work, „Vaata“ (outline) for a test answer. Oldest first ("One list, oldest first, instead of three cards").
- **Practical-work screen (desktop):** header „← Hindamine“, H1 „Merilin Kuusk (näidis)“, meta line „Kulmumeistri e-koolitus · Praktiline töö, 1. kord · saadetud 20.10.2026 18:35“, SaveStatus „✓ Salvestatud 20:41“ at the right. Action bar: left „3 punkti · 3 hinnatud“, right „Kinnita kõik“ (outline, 49 px) and „Saada hinnang · 2 kinnitatud, 1 paranda“ (ink, 49 px). Point card: white, radius 22, padding 18, gap 12; photo 260 px high (radius 14); title Jost 400 19 px; verdict control = 2-column segmented pill (radius 99, padding 3, border `#d5d0d3`, each segment 42 px, 600 13 px): selected „Kinnitatud“ `#2f5d46` fill/white, selected „Paranda“ `#8a3b3b`; comment box min-height 80, radius 10, border `#d9d2d5` (open on Paranda, text sample „Joon on liiga terav sabas — pehmenda üleminekut.“); otherwise a 44 px underlined link „Lisa märkus“. Below: „Üldised märkused“. Grid is 3 columns.
- **Phone:** top bar, „← Hindamine“, name, `✓ 20:41`, button „Kinnita kõik“, one card per point with a full-width photo, hint „Puuduta pilti, et avada täissuuruses.“ (12 px muted), and the send bar fixed at the bottom with „Saada hinnang · 2 kinnitatud, 1 paranda“.
- Deck: "260px photos instead of 88, full width on a phone" and "8 → 2 to approve a practical work: „Kinnita kõik“, then „Saada hinnang · 5 kinnitatud“."
- When no point needs fixing the label drops the "paranda" part („Saada hinnang · 3 kinnitatud“); README only gives the two-count form.

**Change note (P2):** "• Tabs „Ootab hindamist“ | „Tunnistused“. The register moves here from a header button (obs. 7). • Practical work (obs. 13): „Kinnita kõik“ marks every point that has no verdict yet; she then switches only the ones that need „Paranda“. The verdict is one segmented control per point and still saves on the tap. A comment box opens automatically for „Paranda“ and is one tap away for „Kinnitatud“. • Photos are 260 px instead of 88 px, and a tap opens the existing PhotoViewer with swipe. On a phone they are full width. • The send is an informed button: „Saada hinnang · 3 kinnitatud“. It needs no second step, because the summary is already on the button. The test review works the same way („Saada · 1 õige, 1 vale“), so both screens match (obs. 5, 13). • Test review: a pressed verdict can be cleared by tapping it again, as on the practical screen. Marks autosave to the server, no longer only to localStorage."

**Clicks (P2):** approve 5 points and send 8 → 2 · approve 4, fix 1 and send 7 → 3 + typing · send a test review 1 → 1 (now informed) · open the certificate register 2 → 1 (tab).

**Today (files):** `app/admin/(panel)/hindamine/page.tsx` (131; three groups practicals / tests / triesUsed, `ReopenTest.tsx`), `hindamine/assessment.module.css`, `hindamine/test/page.tsx` + `components/admin/TestReview.tsx` (289; marks in localStorage until „Saada“) + `TestReview.module.css`, `AssessmentScreen.tsx` (138) + `AssessmentStage.tsx` (107) + `AssessmentSend.tsx` (356; the confirmation panel) + `Assessment.module.css`, `PhotoViewer.tsx`, `verdict-taps.ts` (per-tap POST), `app/admin/(panel)/tunnistused/page.tsx` + `register.module.css` (the register that becomes a tab), `ReissueCertificate.tsx`; `db/queries/assessment.ts`, `server/assessment.ts`, `server/test-attempts.ts`, `server/actions/admin-assessment.ts`, `app/api/admin/hinnang/route.ts`, `app/api/admin/tunnistus/[id]/route.ts`.
**Change:** tabs; one queue list; „Kinnita kõik“ as a bulk action that still goes through `verdict-taps`; drop the confirm panel in `AssessmentSend` (its summary lines `confirmPassed` / `confirmNotes` have no home in the design); server-side marks for TestReview (B15).

---

### A5 Õpilased — `/admin/opilased` (+ drawer `?id=`)

**Beyond the README**
- **List:** header button „Lisa õpilane +“ (explicit create; opens an inline form: e-mail field + „Lisa õpilane“, typo guard as today); search under it; table rows name over e-mail, created date („20.10.2026“), course count; the „Koolitusi“ explainer is the column header's `title` (+ `aria-describedby`).
- **Drawer (560):** head = name, ✕, phone and e-mail links, line „Konto loodud 20.10.2026 · Keel ET · Uudiskiri: ei“; section title „Koolitused“. Course card: kicker („E-ÕPE“ or „KONTAKTÕPE · 20.10.2026 PÄRNU“), title, state pill, progress line „Õppetunnid 3/3 · Test läbitud (100 %) · Praktiline töö ootab hindamist“, buttons „Hinda“ (when work waits) · „Pikenda ▾“ · „Veel ▾“; contact card shows „Kinnitatud“ and the buttons „Ava registreering“, „Ava protokoll“. Extend menu: title „Pikenda ligipääsu (praegu kuni 17.03.2027)“, four 44 px choices „+1 kuu“, „+3 kuud“, „+6 kuud“, „Kuupäev…“ (the last asks for a date). After a pick an UndoBar „Ligipääs pikendatud kuni 17.06.2027.“ + „Võta tagasi“ (that is +3 months from 17.03.2027).
- Folded rows with summary: „Ava ligipääs e-koolitusele — vali koolitus“ · „Maksed — 1 · 190 €“ · „Lepingud — 0“ · „Päringud — 0“ · „Tagasiside — 0“.
- **Phone drawer:** compact card header — kicker carries the state („E-ÕPE · AVATUD KUNI 17.03.2027“, „KONTAKTÕPE · 20.10 PÄRNU · KINNITATUD“), progress „3/3 · test läbitud · praktiline ootab“, buttons „Hinda“ and „Pikenda ▾“ (no „Veel“ drawn), contact buttons „Registreering“ and „Protokoll“; the UndoBar is a full-width bar at the bottom.
- State labels cover „Avatud kuni“ / „Läbitud“ / „Ligipääs lõpetatud“; the existing „Lõppes {date}“ (access ran out) has no design wording.

**Change note (P2):** "• List: ListToolbar (search filters as she types, so the „Otsi“ button is removed). The table stays a table at 1360 px (parked item). The „Koolitusi“ explainer line becomes a tooltip on the column header. „Lisa õpilane“ moves to a header button that opens a small inline form, as an explicit create. • Drawer: e-courses and contact registrations become one list, „Koolitused“, newest first. Each row has its state and its own actions: „Hinda“, „Pikenda“, „Ava registreering“, „Ava protokoll“. Rarer actions sit under „Veel ▾“: „Ava järgmine õppetund“, „Testi katsed“, „Vaata tema vaadet“, „Lõpeta ligipääs“. • „Pikenda“ (new, explicit) offers +1 kuu, +3 kuud, +6 kuud or a date, with UndoBar afterwards. Today she has to re-pick the course in „Ava ligipääs“ (appendix 07–10). The two meanings of „Lõpetatud“ are split into „Läbitud {date}“ (completed) and „Ligipääs lõpetatud {date}“ (ended by an admin). • „Ava ligipääs e-koolitusele“ folds into a row at the end. Maksed, Lepingud, Päringud and Tagasiside become folded rows with counts. • The (mustand) (avatud kuni …) double brackets in the course select become „{koolitus} · mustand · avatud kuni {date}“ (parked)."

**Clicks (P2):** extend an e-course access 4–5 → 2 · find a student 2 + typing → typing · assess her practical work 2 → 2 · end an access 2 → 3 (Veel ▾) · add a student 2 → 3 (button, then form). Deck: "2 taps to extend an e-course with „Pikenda“ (was 4–5)".

**Today (files):** `opilased/page.tsx` (190; server-rendered search form with „Otsi“ button, `?otsi=`, `?vorm=`, `?leht`, `?id`), `components/admin/ClientDrawer.tsx` (352; `ClientDetailView`: e-course accesses, registrations, payments, requests, contracts, feedback/reviews, „Ava ligipääs“ form), `ClientForms.tsx` (411; `AddStudentForm`, `GrantAccessForm`, `RevokeAccess`, `UnlockNextLesson` with their own confirms), `ClientDrawer.module.css`, `clients.module.css`, `list-table.module.css`, `ReissueCertificate.tsx`, `opilased/[id]/vaade/**` (read-only view-as); `server/admin-clients.ts` (`clientDetail`, `listClients`, `grantAccess` L361, `revokeAccess`, `unlockNextForm`), `server/actions/admin-clients.ts`, `domain/client-access.ts`.
**Change:** `extendAccess(id, until)` + UndoBar (not present; the nearest is re-granting, which "moves the day"); unified course list; state wording; folds with counts; live search.

---

### A6 Maksed ja arved — `/admin/maksed`, `/admin/arved`

**Beyond the README**
- **Header (P2):** eyebrow „Montonio ja raamatupidamine“ (P1 page list says „Montonio“), H1 „Maksed ja arved“, button „Laadi alla (CSV) · oktoober 2026“ at the right of the heading row; under it pill tabs „Maksed“ | „Arved“ (ink active).
- **Arved:** the strip is a white card (radius 22, padding 18 × 24, left border 3 px `#9e8993`): „Arveta maksed: 6“, summary „Tasutud, aga arve puudub · 1 325,00 € · Merilin Kuusk, Kati Kask, Mari Tamm ja 3 teist“, buttons „Näita ▸“ (outline 44 px) and „Koosta 6 arvet“ (ink 44 px). Toolbar: search „Otsi nime, e-posti või arve numbri järgi“, month select „Oktoober 2026 ▾“, pills „Kõik 3“, „Tasumata 1“, „Tasutud 2“, „Tühistatud 0“. Rows: number („MSL2026-003“) + state tag (Tasutud `#eaf0eb/#2f5d46`, Tasumata `#e9e1e5/#6b4f5c`) | „Мария Кузнецова · Kulmude LAMI“ with meta („Osamakse · koostatud 20.10 · tasutud 15.10 · sularaha“, „Kogu summa · tasutud 19.10 · pangaülekanne“, „Ettemaks 50% · maksta kuni 27.10“) | amount („50,00 €“) | actions: first button „Saada õpilasele“ for paid, „Märgi tasutuks“ for unpaid, then „Laadi alla (PDF)“ and „Veel ▾“.
- **Maksed (phone):** search „Otsi nime või Montonio id järgi“; rows with payer + amount, meta („19.10 · Lash Lift BOTOX · pangalink“, „… · kaart“, „… · Apple Pay“, „… · LHV“), status pill (Ootel kontrollil `#e9e1e5/#6b4f5c`, Pooleli `#ebe8e9/#5e5559`, Makstud `#eaf0eb/#2f5d46`) and the link „Ava registreering →“; held rows carry the tint and the 3 px `#9e8993` left border. The P2 mock shows the payment list only in this phone frame.

**Change note (P2):** "• One menu entry with two tabs, „Maksed“ and „Arved“, each with its own URL. • Maksed: the rows are no longer dead ends (appendix 05–06). A row opens the registration drawer or the e-course student. The Montonio id becomes a link, „Montonios ↗“. „Tühistatud pangas“ moves out of „Ebaõnnestunud“ into „Ootel kontrollil“ (parked). Search covers name, e-mail and Montonio id. • Arved: „Arveta maksed“ becomes a folded strip at the top with one informed button, „Koosta 6 arvet“, and a ConfirmPanel (B11). The per-row „Koosta arve“ stays inside the strip. • „Kuu“ applies as soon as it changes, and the CSV button names the month („Laadi alla (CSV) · oktoober 2026“), so it can't download another month (appendix). • Row actions: „Saada õpilasele“ and „Laadi alla (PDF)“ are visible; the rest are under „Veel ▾“. A „Tagastatud“ invoice no longer offers „Saada õpilasele“ (parked)."

**Clicks (P2):** invoice 6 unbilled payments 6 → 2 · monthly CSV for the accountant 3 + reload → 2 · from a payment to its registration none → 1 · check a payment in Montonio copy id → 1.

**Today (files):** `maksed/page.tsx` (173; `?staatus=makstud|pooleli|ebaonnestunud|tagastatud|kontroll`, `?leht`) + `payments.module.css` + `PaymentLines.tsx` (`PAYMENT_TONE`, `paymentStatusLabel`, `paymentMethodText`), `arved/page.tsx` (175; `?kuu=YYYY-MM`, `?staatus=unpaid|paid|cancelled`, `#arveta` list) + `arved.module.css`, `InvoiceCatchUp.tsx` (one payment → one invoice; its comment: "No bulk button: each one is a real number"), `InvoiceRow.tsx` (332; all row actions inline), `invoice-view.ts`, `Pager.tsx`; `server/invoices.ts` (`listInvoices`, `uninvoicedPaymentRows`, `createInvoice`), `server/actions/admin-invoices.ts` (`catchUpInvoiceAction`), `db/queries/payments.ts` (`pagePayments`), `domain/payments.ts` (`needsCheck`), `domain/invoice.ts` (state/method texts), `app/api/admin/arved/route.ts` (CSV).
**Change:** tabs inside one page head; `createInvoicesForUnbilled()` (B11, reverses R13's "no bulk"); month auto-apply; row-as-link; `kontroll` counting of "Tühistatud pangas" (B14); `ListToolbar` search incl. Montonio id and number.

---

### A7 Päringud — `/admin/paringud`

**Beyond the README**
- **Desktop:** search „Otsi nime, e-posti või telefoni järgi“; tab pills with counts (ink active): „Kontakt 2“, „Individuaal 2“, „Praktika 1“, „Ootenimekiri 2“, „Muutmine 0“; cards in a 2-column grid. Card: name Jost 400 20 px + type tag (22 px high pill, 10 px/600: „Kontakt“ `#ebe8e9/#222`, „E-õppe huvi“ `#222/#fff`) on the first line, then „19.10.2026 07:24 · RU · julia.sokolova.naidis@example.test“ (12 px muted), the message (14 px), one muted facts line („Vastus vene keeles“; „Ostu ei lõpetanud · ostukorvist“), then „Märgi tehtuks“ (ink 44 px) and „Vasta e-kirjaga ↗“ (outline). At the bottom a 52 px fold row „Tehtud (1) ▸“.
- **Phone:** tabs only „Kontakt 2 | Individuaal 2 | Praktika 1“; cards with name + „19.10 · RU“, message, buttons „Märgi tehtuks“ and „Vasta ↗“; UndoBar full width at the bottom („Märgitud tehtuks.“ + „Võta tagasi“).
- The facts line is condensed from today's 9-line label/value table; the mock shows two examples only (not specified for Individuaal, Praktika, Ootenimekiri, Muutmine).

**Change note (P2):** "• ListToolbar search across every tab. The tab pills keep their counts. „Kontakt“ and „E-õppe huvi“ were one view on the overview and are now one tab, with an „E-õppe huvi“ tag on the card (appendix 01). • Cards go from a 9-line label/value table to a header (name, kind, date), the message, and one line of facts. Two cards fit side by side on desktop, so about three times as many requests fit on screen. • „Märgi tehtuks“ is instant and shows UndoBar. Done requests fold into „Tehtud (n) ▸“ at the bottom instead of sitting in the list. • A waitlist card links to its session, „Ava toimumine →“ (Kalender drawer). A „Muutmine“ card links to the registration. • „Vaata päringutes“ from other screens now opens the card itself (#p-{id}, highlighted), not just the tab (appendix 07–10)."

**Clicks (P2):** mark a request done 1 → 1 (+ undo) · find one person's request tab + scroll → typing · from a waitlist entry to its session none → 1.

**Today (files):** `paringud/page.tsx` (268; `?liik=`, pager), `components/admin/RequestToggle.tsx` (41; `toggleRequestHandled`), `requests.module.css`, `domain/registration-card.ts` (`registrationHeading`), `db/queries/admin.ts` (`pageRequests`, `listRegistrations`, `listSessionsByIds`), `server/actions/admin.ts` (`toggleRequestHandled`); `clients.drawer.openRequests` („Vaata päringutes“) in `ClientDrawer.tsx` is the deep-link source.
**Change:** `?otsi=` over every tab with the tab tag; condensed card; `#p-{id}` anchors + highlight (`#faf6f8` for 2 s, none under reduced motion); done fold; UndoBar.

---

### B1 Koolitused — `/admin/koolitused`

**Beyond the README**
- **Desktop row** (white card per row, grid `40px | 96px | 64px | 1fr | 120px | 170px | 120px | 180px`): ⋮⋮ handle · ↑ ↓ buttons (↑ at 30 % opacity on the first row, ↓ on the last) · 56 × 56 thumbnail (radius 12) · title (600 14 px) over „Baaskoolitus · /kulmumeistri-baaskoolitus“ (12 px muted) · Õppevorm tag (E-õpe: ink fill, white text; Kontaktõpe: white with outline) · two price lines („Grupp 350 €“ over „Individuaal 450 €“; an e-course has one line, e.g. „190 €“) · Märgis (badge text such as „Populaarne“, „Uus“, or „—“) · Staatus pill (Avaldatud `#eaf0eb/#2f5d46`, Mustand `#ebe8e9/#5e5559`, Avaldamata muudatused `#e9e1e5/#6b4f5c`). Column header strip: „Järjekord | Koolitus | Õppevorm | Hind | Märgis | Staatus“. A row with unpublished edits is highlighted `#faf6f8`.
- Header: note under the H1 „Järjekord on sama mis avalikul lehel. Lohista ⋮⋮ või kasuta nooli.“, an ink button „Lisa koolitus +“, pills „Kõik 6 | E-õpe 3 | Kontaktõpe 3“.
- **Phone (P4):** cards `28px | 52px | 1fr | 44px` — ⋮⋮ (long-press drag) · 52 px thumb · title with second line „{vorm} · {staatus}“ (e.g. „Kontakt · Avaldamata muudatused“) · a „↕“ button that opens a small menu „Üles“, „Alla“, „Esimeseks“, „Viimaseks“ "for anyone who can't drag"; header „Koolitused“ with an ink „Lisa +“; pills „Kõik 6 | E-õpe 3 | Kontakt 3“.

**Change note (P3):** "• Reordering: a drag handle ⋮⋮ moves a course in one step, with a single server call when it's dropped. The ↑/↓ buttons stay for keyboard and touch users. Today every one-step move is a round trip (appendix 02). • The whole row opens the editor. „Staatus“ shows „Avaldatud“, „Mustand“ or „Avaldamata muudatused“ (from the draft layer, Q1), so she can see at a glance which courses have edits that aren't live yet. • The pills „Kõik / E-õpe / Kontaktõpe“ get counts. Reordering is still only possible in „Kõik“; the handle is hidden in a filtered view, with a hint saying why. • The price column becomes two lines, „Grupp 350 €“ and „Individuaal 450 €“, so it doesn't wrap mid-word."

**Clicks (P3):** move a course 3 places up 3 round trips → 1 drag · open a course 1 (name) → 1 (row) · see which courses have unpublished edits open each → 0.

**Today (files):** `koolitused/page.tsx` (153), `components/admin/CourseOrder.tsx` (50; one `moveCourseInList` form per ↑/↓), `courses.module.css`; `server/actions/admin-content.ts` L40 `moveCourseInList`, `server/admin-content.ts` L235 `moveCourseForm`, `db/queries/admin.ts` L173 `moveCourse(db, id, dir ±1)`, `listAllCourses`, `domain/badge.ts` (`shownBadge`).
**Change:** `moveCourseTo(id, index)`; drag (pointer + touch, `aria-roledescription="lohistatav"`); "Avaldamata muudatused" status needs the draft layer to know whether a draft exists.

---

### B2 Course editor and lesson drawer — `/admin/koolitused/[id]` (+ `?oppetund=`)

**Beyond the README**
- **Grid from 1180 px:** `190px | 1fr | 300px`, gap 22, `align-items:start`. Section-map item: min-height 40, padding 0 12, radius 9, 500 13 px, active item white; status on the right 11 px/600 (`#716a6d`, or `#6b4f5c` for „RU puudub“ / „Kontrolli“). Mock entries: Põhiinfo · Õppevorm ja hind (1) · Õpiväljundid (4) · Moodulid ja õppetunnid (1) · Teadmiste test (RU puudub) · Tunnistus · Galerii (4) · Soovitused (2). "The page is not split into tabs, so a search with Ctrl+F still finds everything."
- **Header:** „← Koolitused“, H1 „Kulmumeistri e-koolitus“, tags „Avaldatud“ „E-õpe“, the ET|RU switch, SaveStatus „✓ Mustand salvestatud 14:02“; then the draft bar: „Avaldamata muudatused: 3 · Lühikirjeldus, Hind, Moodul 03. Avalikul lehel on näha eelmine versioon.“ with „Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“.
- **Cards:** „Põhiinfo“ (fields „Koolituse nimi“, „Lühikirjeldus · avaldamata“ with accent border, „Tase“ Baaskoolitus | Täiendkoolitus, „Koolituse keel“ select „ET / RU ▾“); „Moodulid ja õppetunnid“ with summary „6 moodulit · 3 õppetundi“; each module a bordered box (1 px `#e6e1e3`, radius 14, padding 12 × 14): ⋮⋮ · number „01“ (mono) · title · „avaldamata“ tag for unpublished; each lesson row: title + status tag (22 px, 10 px/600: Tekst `#ebe8e9/#5e5559`, Valmis `#eaf0eb/#2f5d46`, Töötlemisel 72% `#e9e1e5/#6b4f5c`, Video puudub `#f3e6e6/#8a3b3b`) + ›; button „+ Lisa moodul“ (outline 44 px).
- **Side column (300, sticky):** „Avaldamine“ (switch „Avalikul lehel“, „Näidissisu“), „Koolituse märgis“ (chips Populaarne | Uus | Puudub, selected chip `#ebe8e9` with 1 px `#222`) and the card preview with the course name.
- **Lesson drawer (560):** head „Moodul 01 · Õppetund 1.1“ over the lesson title, SaveStatus „✓ Mustand salvestatud 14:03“, ✕; fields „Õppetunni nimi“, „Lühike tekst“, „Õppetunni liik“ (Video | Tekst chips), „Failid“ (row 52 px, radius 12: „Töövahendite nimekiri.pdf · 220 kB“ + „Eemalda“; drop zone „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“), switch „Õpilastele nähtav“ with the hint „Õppetunnil on õpilaste edenemist — seda saab ainult peita.“; at the bottom (lesson without progress) a danger „Kustuta õppetund“ → ConfirmPanel „Kas kustutan õppetunni „{nimi}“ koos video ja failidega?“ / „Jah, kustuta“ / „Katkesta“.
- **Phone (P4):** H1 + `✓ Mustand 14:02`, a select row „Jaotised · Põhiinfo ▾“, „Avaldamine“ card right after the header, then the open section card (e.g. Põhiinfo with „Koolituse nimi“, „Lühikirjeldus · avaldamata“); the **publish bar is fixed at the bottom**: „Avaldamata 3 · Eelvaade“ and an ink „Avalda“; „Loobu muudatustest“ sits "behind „Eelvaade“ on the preview page". Lesson drawer full screen: head „Moodul 01 · Õppetund 1.1“ + ✕, title, SaveStatus, „Õppetunni nimi“, "Õppetunni liik" as a segmented control (Video | Tekst), the video row „intro.mp4“ with „Töötlemisel 75%“ and the line „Võid lehelt lahkuda — töötlemine jätkub.“, „Failid“ with „Vali fail“ ("the file picker replaces drag and drop"), the switch „Õpilastele nähtav“. Upload progress is announced only at 25 % steps.

**Change note (P3):** "• Section map (obs. 9): a sticky left column lists the cards that exist for this course type, each with a small status: „3“ (count), „RU puudub“ or „Kontrolli“. A tap scrolls to the card. The page is not split into tabs, so a search with Ctrl+F still finds everything. • The draft bar (Q1, B2) sits under the H1: „Avaldamata muudatused: 3“, „Eelvaade ↗“, „Loobu muudatustest“ (ConfirmPanel) and „Avalda muudatused“. An unpublished course has no draft bar, only SaveStatus. • The side column („Avaldamine“, „Koolituse märgis“, card preview) is sticky. Below 1180 px it moves under the header, not to the very bottom (appendix 02). • „Moodulid ja õppetunnid“ / „Programm“ joins the same autosave and draft (B18). It follows the draft „Õppevorm“ immediately. The per-module „Salvesta“ is removed. A programme point is called „punkt“ in its delete text, not „moodul“. • Each list row (Õpiväljundid, Protokolli punktid, Galerii, test questions) gets a drag handle as well as ↑/↓. Removing a row is instant, with UndoBar. • Lesson drawer: name, text and kind autosave. Files upload at once. The kind switch Video → Tekst on a lesson with a video still asks („Video kustutatakse. Jätkan?“ becomes ConfirmPanel words). „Peida“ becomes a two-state switch, „Õpilastele nähtav / Peidetud“. Removing a file shows UndoBar (B5). The drawer header has SaveStatus, and the close guard is the shared one."

**Clicks (P3):** save course edits 1 → 0 · publish edits on a live course 1 (Salvesta) → 1 (Avalda) · jump to modules on an e-course long scroll → 1 · rename a module typing + 1 → typing · save lesson name/text typing + 1 → typing · hide a lesson 1 → 1 (+ undo).

**Today (files):** `koolitused/[id]/page.tsx` (109; lesson drawer via `?oppetund=`, `confirmClose` on the lesson drawer), `components/admin/CourseEditor.tsx` (448; its own save bar at L430–443, `useActionState` whole-course save with a version → `courseEditor.stale`), `LessonsEditor.tsx` (469; per-module rename form with its own „Salvesta“, add/move/delete actions, `saveFirst` notice), `LessonDrawer.tsx` (332; `useUnsavedInDrawer`, own save), `LessonFiles.tsx` (148), `LessonVideoField.tsx` (299; upload progress; `useUnsavedInDrawer(busy…)`), `ListEditor.tsx` (147), `GalleryEditor.tsx` (184), `ProtocolStagesEditor.tsx` (191), `TestEditor.tsx` (311), `BadgeEditor.tsx` (133), `I18nInput.tsx`, `CourseEditor.module.css`, `LessonsEditor.module.css`, `TestEditor.module.css`, `editor.module.css`; `server/actions/admin-content.ts` (`saveCourse`), `server/actions/admin-lessons.ts` + `server/admin-lessons.ts` + `lesson-videos.ts` + `lesson-files.ts` + `bunny.ts`, `domain/course-editor.ts` (`LIMITS.images = 20`), `db/queries/admin.ts` (`getCourseForEdit`, `courseUsage`, `typeLocked`).
**Change:** the whole editor to per-part autosave on a draft row (B1–B3, B18); section map; side column; list-editor drag/undo (B5); video tags and the `Töötlemisel {n}%` value need Bunny's encode progress, which `BunnyVideo` (`{ status, length, width, height }`) and `AdminVideo` do not carry.

---

### B3 Kalender — `/admin/kalender` (+ drawer `?id=`, `?id=uus`)

**Beyond the README**
- **List (desktop):** white rows with date (and weekday under it: „teisipäev 10:00“, „laupäev 10:00“) | course | place („Pärnu · MS LAB stuudio“, „Tallinn · Stuudio Kalamaja“) | seats „3 / 4“ with a small bar | status tag (Toimub `#eaf0eb/#2f5d46`, Täis `#e9e1e5/#6b4f5c`, Tühistatud `#f3e6e6/#8a3b3b`); mock rows: 20.10.2026 (today, 3 / 4, Toimub), 05.12 (4 / 4, Täis), 12.12 (2 / 4), 19.12 (1 / 6), 26.12 (0 / 4), 06.02.2027 (0 / 4, Tühistatud). Today's Kalender already has `?aeg=moodunud` pills „Tulevased / Möödunud“ and `?id=uus`; the design adds counts, course and city scopes.
- **Drawer (560) top to bottom:** SaveStatus „✓ Salvestatud 09:12“ + ✕; course (Jost 28); line „05.12.2026 · Pärnu · 4/4 kinnitatud · ootenimekirjas 2“ with the first button „Protokollid“; notice „4 õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“; fields „Kuupäev“ (with the hint „Muudetud — teavita 4 õpilast ise.“ in `#6b4f5c` when changed), „Algus“ (desktop mock; phone „Algus (Eesti aeg)“), „Linn“, „Kohti“ (value 3 with the error „Kinnitatud on 4 — kohti ei saa olla vähem.“), „Toimumiskoht“, „Staatus“ (Toimub | Tühistatud); then the refusal text where „Kustuta toimumine“ would be.
- **Phone:** date-led cards with a seat bar that turns `#6b4f5c` when the session is full; pills „Tulevased 5 | Möödunud 3 | Linn ▾“ (the city filter is a select inside the pill row); an ink „Lisa +“; drawer full screen, "On the course day, „Protokollid“ is the first thing under the title, before any field", native date and time pickers, fields stack one per row, header line „05.12.2026 · Pärnu · 4/4 · ootel 2“.

**Change note (P3):** "• The list gets course and city scopes plus the pills „Tulevased / Möödunud“ with counts. The whole row opens the drawer, and the „Kohad“ column shows a small seat bar. • The drawer autosaves. „Salvesta toimumine“ is removed; „Lisa toimumine“ stays as the explicit create. • A booked session (appendix 03): a line at the top says „3 õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ Changing the date or time shows that line in the warning colour next to the field. • Setting „Tühistatud“ on a booked session opens a ConfirmPanel: „Kas tühistan toimumise? 3 registreeringut jäävad alles; teavita õpilasi ise.“ • Capacity below the confirmed count is refused in the field: „Kinnitatud on 3 — kohti ei saa olla vähem.“ Changing the course is disabled once anyone is booked. • „Kustuta toimumine“ is shown only when there are no registrations. Otherwise the early-refusal text appears in its place (3.3). • „Protokollid“ is the first button in the drawer and goes to that session's protocols."

**Clicks (P3):** change capacity 2 + typing + 1 → 1 + typing · cancel a session 3 → 3 (with consequences) · learn that a booked session can't be deleted 3 → 0 (said up front) · open a session's protocols 2 → 2 · add a session ≈5 + typing → ≈5 + typing.

**Today (files):** `kalender/page.tsx` (231), `components/admin/SessionForm.tsx` (268; explicit „Salvesta toimumine“, delete confirm), `calendar.module.css`; `server/actions/admin-content.ts` (`saveSession` L45, `deleteSession` L52), `server/admin-content.ts`, `db/queries/admin.ts` (`listAdminSessions`, `listContactCourses`, `upsertSession`, `deleteUnusedSession`).
**Change:** per-field autosave of an existing session, create stays explicit; field-level refusals; counts; `typeLocked`-style disabling of „Koolitus“.

---

### B4 Seaded — `/admin/seaded`

**Beyond the README**
- Section map (190 px column, same look as B2) entries: Kontakt · Uudiskiri · Maksmine · Tunnistus · Lepingud ja tingimused (status „1 avaldamata“) · Halduse ligipääs. The P3 note says "grouped into five sections" and lists six.
- „Maksmine“ card (mock): lead „Ühed pangaandmed ettemaksu juhistes ja arvetel.“, fields „Saaja“ (MS LAB OÜ), „IBAN“ (EE38 2200 2210 2014 5685), „Registrikood“, „Arve järgmine number“ (7) with the preview „Järgmine arve: MSL2026-007“.
- Contract card: title „E-koolituse leping“ with the tag „Avaldamata muudatus“ (accent), a long text box, placeholder chips under it (`+ nimi`, `+ e-post`, `+ koolitus`, `+ toimumine`, `+ hind`, `+ ettemaks`; the mock text shows `[nimi]` in square brackets, the app's placeholders are `{nimi}`), and a ConfirmPanel "Kas avaldan uue e-koolituse lepingu?" with two bullets and „Jah, avalda“ / „Katkesta“.
- **Phone:** `✓ 11:20`, a select row „Jaotised · Maksmine ▾“, fields stacked; number line „Järgmine arve: MSL2026-007 · 1. jaanuarist: MSL2027-001“ ("The new-year number line comes from B21"); contract card shows the tag „Avaldamata“, the text "Pikk tekst avaneb täisekraanil." and a button „Muuda teksti"; "Long contract texts open in a full-screen editor with the placeholder chips above the keyboard."

**Change note (P3):** "• The page stays a single page (the anchors #ettemaks #tunnistus #arve #lepingud keep working), with the same section map as the course editor. The cards are grouped into five sections: Kontakt, Uudiskiri, Maksmine (Ettemaksu juhised + Arve andmed; their shared bank fields are now edited in one place), Tunnistus, Lepingud ja tingimused (Privaatsus, Õppetingimused, E-koolituse leping, Kontaktkoolituse leping) and Halduse ligipääs. • One SaveStatus covers every card, so the „Tunnistus“, „Arve andmed“ and „Lepingud“ cards are guarded too (parked). • Contract texts use the draft layer: changes are kept as a draft, and „Avalda uus leping“ opens a ConfirmPanel, „Kas avaldan uue e-koolituse lepingu? 7 aktiivset õpilast peavad selle uuesti kinnitama.“ (appendix 11–16). Placeholders are chips that insert at the cursor. • „Järgmine number“ (certificate and invoice) shows what the next number will look like: „Järgmine: MS LAB 2026-93“ / „MSL2026-007“."

**Clicks (P3):** edit invoice data typing + 1 → typing · edit certificate data typing + 1 → typing · change the e-course contract typing + 1 (no warning) → typing + 2 (with consequences) · find the „Arve andmed“ card scroll → 1.

**Today (files):** `seaded/page.tsx` (67), `SettingsEditor.tsx` (182; `useSiteDraft` + `SaveBar`: contact, newsletter discount, prepayment, privacy/terms pages, e-course terms, admins), `CertificateSettings.tsx` (241; own form/save, year + number fields), `InvoiceSettings.tsx` (284; own form/save, year + number, bank link to Ettemaksu juhised), `ContractTexts.tsx` (155; own form/save, placeholder help text), `CertificateSettings.module.css`, `InvoiceSettings.module.css`, `ContractTexts.module.css`, `site-editor.module.css`; `server/admin-site.ts` (`loadSettings`), `server/certificates.ts` (`certificateCard`), `server/invoices.ts` (`invoiceCard`), `server/contracts.ts` (`contractCard`), `domain/account-cards.ts` (`PREPAYMENT_KEY`).
**Change:** one page-level autosave; merge the two bank sources (B4 "one source"); draft layer for the four contract texts (needs a place for the draft text and a publish action that bumps the terms version); B21 yearly invoice sequence (changes `nextYear`/`nextSeq` semantics); preview lines.

---

### B5 Uudiskiri — `/admin/uudiskiri` (Tellijad | Kirjad)

**Beyond the README**
- **Kirjad (desktop):** grid `300px | 1fr | 380px`, gap 18. List card (white, radius 22, padding 16): ink button „Uus kiri +“ (44 px), rows with name over state line — „Jõulupakkumine (näidis)“ / „Mustand · muudetud 20.10 20:35“ (the open one on `#f0ebed`, radius 12), „Oktoobri uudised (näidis)“ / „Saadetud 12.10 · 10 tellijale“. Editor column: SaveStatus „✓ Salvestatud 20:35“; „Teema“ with counter „46 / 150“ („Jõulukingitus sulle: −15% kõigilt koolitustelt“), „Eelvaate rida“, „Tekst“ (two paragraphs), „Kood“ („JOULUD15“), „Nupu tekst“, „Nupu aadress“, a „Kustuta mustand“ link. Right column: „Eelvaade“ (a small mail: MS LAB, text, code, button „Vaata koolitusi“) and „Saatmine“: select row „maria@example.test · eesti keeles ▾“ (48 px, radius 10), outline „Saada proov“ (44 px), ink „Saada kõigile (4)“ (49 px) and the hint „3 eesti, 1 vene keeles · näidisaadressidele ei saadeta“.
- **Phone (P4):** the list is its own screen; in a letter: „← Kirjad“, H1 „Jõulupakkumine“, `✓ 20:35`, a „Muuda | Eelvaade“ switch instead of the three columns, „Teema 46/150“ field, text; send buttons fixed at the bottom: „Saada proov · maria@… · ET“ and ink „Saada kõigile (4)“.
- Tellijad: search (address), pills „Kinnitatud 14“ / „Ootab kinnitust 5“, „Laadi alla (CSV)“ for the current filter ("This is where the overview's subscriber CSV moved").

**Change note (P3):** "• „Kampaaniad“ becomes „Kirjad“ (approved). The list sits on the left and the editor on the right, so opening a letter no longer pushes the editor below the list. • The draft autosaves, so the rule „Salvesta muudatused enne saatmist.“ is gone. Sends use the last saved version. • „Saada proov“ is an informed button with the recipient and language: „Saada proov · maria@… · eesti keeles“. The two radio groups become one select. • „Saada kõigile“ opens a ConfirmPanel with the real sendable count (B9). „Peata saatmine“ keeps its ConfirmPanel. • A draft can be deleted: „Kustuta mustand“ with a ConfirmPanel (B17). Sent letters still can't be deleted, and „Kopeeri“ still makes a new draft. • The vague promise „… see läheb välja, kui eelmine on saadetud.“ is replaced by „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“ (appendix 11–16). • Tellijad: ListToolbar (search an address) with pills „Kinnitatud 14 / Ootab kinnitust 5“. The CSV buttons become „Laadi alla (CSV)“ for the current filter. This is where the overview's subscriber CSV moved."

**Clicks (P3):** send a test after editing 2 (Salvesta, Saada proov) → 1 · send to everyone 2 → 2 · delete an unused draft impossible → 2 · open an existing letter 1 + scroll → 1.

**Today (files):** `uudiskiri/page.tsx` (187; `?vaade=kampaaniad`, `?kampaania=<id|uus>`; two server branches `subscribersPage` / `campaignsPage`), `components/admin/CampaignsPanel.tsx` (142) + `CampaignsPanel.module.css` (list + editor stacked), `NewsletterCampaignEditor.tsx` (712; explicit „Salvesta“, test/all send panels, stop, copy, counters), `newsletter.module.css`, `Pager.tsx`; `server/newsletter-campaigns.ts` (`getCampaign`, `listCampaigns`, `progressOf`, `sendRefused`), `server/actions/admin-newsletter.ts`, `db/queries/admin.ts` (`pageSubscribers`), `app/api/admin/subscribers.csv/route.ts`, `app/api/admin/kampaania-eelvaade/route.ts` (live preview).
**Change:** autosave of the draft (new per-part save + version); two-column/three-column layout; send panel (one select, informed phone button); delete-draft action (B17); `Laadi alla (CSV)` honouring the filter; reword every "kampaania" string.

---

### C. Site-content screens — shared template (P3) and per-screen detail (P4)

**Template (P3 note):** "• Header: H1, LangSwitch, SaveStatus and „Vaata lehel ↗“. Under it is the draft bar („Avaldamata muudatused“, „Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“), which replaces SaveBar. • The section map appears only when there are 4 or more cards (Avaleht and Koolitaja). • List rows (slides, FAQ, gallery, package points) get drag and ↑/↓, removal with UndoBar, and errors keyed by row id, not by index (parked: errors showing on the wrong row after a reorder). • Images: the focal point and upload work as today, and the reference is now saved immediately (B1)."

Mock details common to C (P3/P4): the section map is a 170 px column on the C screens (`170px minmax(0,1fr)`, gap 22) against 190 px on the course editor/Seaded; the draft bar is a white card (radius 18, padding 12–14 × 20) with a 3 px `#9e8993` left border; C1 shows all three of „Eelvaade ↗ · Loobu muudatustest · Avalda muudatused“, C3 shows „Eelvaade ↗ · Avalda muudatused“, C5 shows only „Avalda muudatused“ (README gives all three for every site editor).

### C1 Avaleht — `/admin/avaleht`

**Beyond the README**
- Header (P4): eyebrow „Koduleht“, H1 „Avaleht“, ET|RU, `✓ Mustand salvestatud 10:05`, „Vaata lehel ↗“; bar „Avaldamata muudatused: 1 · Slaid 2 pealkiri“. P3 template: „ETRU RU puudub 2 väljal · Järgmine →“ beside the status, bar „Avaldamata muudatused: 2 · Slaid 2 pealkiri (RU), KKK küsimus 4“.
- Section map (170): Slaidid (5) · MS LABi lause · Koolitaja kaart · KKK (6, „RU puudub“) · Koolitaja plokk (→). "Card order follows the public page: Slaidid → MS LABi lause → Koolitaja kaart → KKK."
- Slide list row (P3 template): `24px | 72px | 1fr | 80px | 96px` = ⋮⋮ · 72 × 48 thumbnail · ET title over the "RU: …" line („RU: RU puudub“ when empty) · tone tag (Hele white / Tume ink) · ↑ ↓. "A slide opens inline (one at a time)": the open slide is a 1 px `#222` box (radius 16, padding 14) `24px | 300px | 1fr`: left a 190 px image with the focal dot and the hint „Puuduta pilti, et valida fookus · Vaheta pilt“; right „Pealkiri · avaldamata“, „Alapealkiri“, the tone choice „Hele“ | „Tume“, button „Eemalda slaid“; header button „+ Lisa slaid“.
- FAQ ("KKK"): question visible, answer collapsed (▸); each row shows `ET · RU` in green or `RU puudub` in `#6b4f5c`; drag, ↑/↓, removal with undo.
- Phone: `Jaotised · Slaidid ▾`, one slide's „Pealkiri“ and „Hele | Tume“, bar „Avaldamata 1 · Eelvaade“ + „Avalda“.

**Change note (P4):** "• Card order follows the public page: Slaidid → MS LABi lause → Koolitaja kaart → KKK. „Koolitaja plokk“ becomes a link row. • A slide opens inline (one at a time). The image takes the left half with its focal point; the texts and the „Hele / Tume“ tone go on the right. • FAQ rows: question visible, answer collapsed; drag, ↑/↓ and removal with undo. • The RU pass: switch to RU, then „Järgmine →“ walks through the empty fields." P3 notes: "Template above; 5 cards in the section map · „Koolitaja plokk“ card becomes a link row „Muuda lehel Koolitaja →“ · Slide tone „Hele/Tume“ stays per slide (it drives the header colour)".
**Clicks:** edit a slide headline and publish 2 → 1 · RU pass over 12 fields 12 → 1 · remove a FAQ by mistake and restore impossible → 1.
**Today (files):** `avaleht/page.tsx` (24), `HomeEditor.tsx` (109; `useSiteDraft(saveHome)` + `SaveBar`), `SlidesEditor.tsx` (189), `FaqEditor.tsx` (102), `TextField.tsx`, `SingleImage.tsx`, `ImageUpload.tsx`, `FocalPoint.tsx`, `ListEditor.tsx`, `useSiteDraft.ts`, `site-draft.ts`, `SaveBar.tsx`, `site-editor.module.css`; `server/admin-site.ts` (`loadHome`), `server/actions/admin-site.ts` (`saveHome`), `server/site-links.ts` (link suggestions). Tables behind it: hero slides, faq, settings (no draft columns today).

### C2 Koolitaja — `/admin/koolitaja`

**Beyond the README**
- Header: eyebrow „Koduleht“, H1 „Koolitaja“, ET|RU, `✓ Salvestatud 09:40`, „Vaata lehel ↗“ (no draft bar drawn in the mock).
- Section map (170): Portree ja tutvustus · Numbrid (3) · Galerii (4) · Koolituskeskuse lugu · Koolitaja teekond („tühi“).
- „Portree ja tutvustus“ card: image column 240 px (300 px tall, radius 16) beside „Nimi“ („Maria Sosnina“) and „Tutvustus“. „Numbrid“: three inline pairs (value `8+` / label „aastat kogemust“; `600+` „koolitatud õpilast“; `3` „linna Eestis“). „Galerii“: header "Lohista järjekorra muutmiseks · 4 / 12", a 5-column grid of 120 px tiles (radius 12) each with a 32 px round ✕ at its corner, a „+ Lisa“ tile. „Koolituskeskuse lugu“ / „Koolitaja teekond“ fold when empty: one row „tühi · Lisa tekst ▸“.
- The gallery counter shows a limit of 12; the editor's limit is 24 (`LIMITS.works`).

**Change note (P4):** "• „Portree ja tutvustus“ comes first, as on the public page. The image sits beside its text. • „Numbrid“ becomes three inline pairs (number + label) rather than a list editor. • „Koolituskeskuse lugu“ and „Koolitaja teekond“ fold when empty, showing „Lisa tekst“. • The gallery is a drag grid, the same component as the course gallery. Removing an image shows UndoBar." P3: "Template; portrait + focal point first, numbers second · Gallery rows drag + undo; same component as the course gallery · „Koolituskeskuse lugu“ and „Koolitaja teekond“ fold when empty".
**Clicks:** change portrait + publish 2 → 2 · reorder gallery n taps → 1 drag (P4: "Reorder 4 gallery images up to 12 taps → 1 drag").
**Today (files):** `koolitaja/page.tsx` (24), `TrainerEditor.tsx` (204; portrait + focal, name/role, stats list editor `addStat`, bio, works list, story, journey), `GalleryEditor.tsx` (184; the course editor's gallery, shared), `SingleImage.tsx`, `FocalPoint.tsx`, `ListEditor.tsx`, `SaveBar.tsx`; `server/admin-site.ts` (`loadTrainer`), `domain/site-editor.ts` (`LIMITS`: stats 3, works 24).

### C3 Uudised — `/admin/uudised`, `/admin/uudised/[id]`

**Beyond the README**
- P4 frame: from 1180 px a 320 px list stays on the left while a post is open (`320px minmax(0,1fr)`); list header "Uudised" + ink „Lisa postitus +“; search pill „Otsi pealkirja järgi“ (44 px, radius 99); post rows with thumbnail, title and "{status} · {date}" (Avaldamata muudatused `#6b4f5c`, Avaldatud `#2f5d46`, Mustand `#5e5559`; „—“ for a draft without date); the open row has a 1 px `#222` border. Editor: ET|RU, `✓ Mustand salvestatud 16:20`, „Vaata lehel ↗“, bar „Avaldamata muudatused: 1 · Tekst“ + „Eelvaade ↗“ + „Avalda muudatused“; „Pealkiri“; „Tekst · avaldamata“ with the accent-bordered 150 px textarea; footer line „Avaldatud 02.10.2026 · /uudised/uued-koolituskuupaevad-tartus“ and the danger „Kustuta postitus“.
- „Avalda muudatused“ checks cover image, title and text in both required languages and lists anything missing („Puudub: kaanepilt“). A new post: „Lisa postitus +“ creates a draft titled „Uus postitus“ and focuses the title field.

**Change note (P4):** "• From 1180 px the list stays on the left (320 px) while a post is open, so moving between posts is one tap. Below that it is two screens, as today. • Status: „Avaldatud“, „Mustand“, „Avaldamata muudatused“. Search covers the title. • „Avalda muudatused“ checks the cover image, title and text in both required languages, and lists anything missing („Puudub: kaanepilt“). • A new post: „Lisa postitus +“ creates a draft with the title „Uus postitus“ and focuses the title field." P3: "List: whole row clickable, status incl. „Avaldamata muudatused“, search · Editor: template; cover image required to publish is checked by „Avalda“, not by save · „Kustuta postitus“ keeps its ConfirmPanel".
**Clicks:** publish a new post 1 → 1 · fix a typo in a live post 2 → 1 (Avalda) (P3 and P4 agree) · open the next post 2 → 1.
**Today (files):** `uudised/page.tsx` (96; table) + `news.module.css`, `uudised/[id]/page.tsx` (62; `id` or `uus`), `PostEditor.tsx` (179; `useSiteDraft(savePost, { always: isNew })` — the first save creates the post; own delete form with confirm), `SaveBar.tsx`, `SingleImage.tsx`; `server/admin-site.ts` (`loadPost`), `domain/site-editor.ts` (`newPostDraft`), `db/queries/admin.ts` (`listAllPosts`). The slug is unique and is derived from the title ("Uus postitus" would collide).

### C4 Hüpikaken — `/admin/kampaania` (P4 prints `/admin/hupikaken`)

**Beyond the README**
- Frame (P4): eyebrow „Turundus“, H1 „Hüpikaken“, ET|RU, `✓ Salvestatud 12:10`. Top bar card (white, radius 18, padding 14 × 20): „Lehel näidatakse“ with the sub-line „Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul“ and a switch (the P4 note says "a two-state switch"). Below, `minmax(0,1fr) 440px`: the left card „Pakkumine“ with „Pealkiri · RU“ (the value „ET −10% esimeselt koolituselt“ over the Russian „−10% на первый курс“), „Tekst“ (ET + RU), the tag „tõlge tulekul“, „Kopeeri eesti keelest“, two inline fields „Soodustus (%)“ (10) and „Kood kehtib (päeva)“ (30); the right column the live preview (a Russian popup: „MS LAB“, „−10% на первый курс“, „Подпишитесь на рассылку и получите код на почту.“, an e-mail field, „Получить код“) and under it the line „Reeglid: kood saadetakse pärast e-posti kinnitamist; üks kasutus tellija kohta; ei liitu teiste soodustustega.“.
- Today's page has three choices (Kampaania | Uudiskiri | Väljas), two popup editors (campaign offer: kicker, title, text, code, button text/link, picture; newsletter sign-up: kicker, title, text, picture), each with its own ET/RU preview, and a „Reeglid“ card with six lines (6 s, once per visit, one window at a time …). The mock's fields „Soodustus (%)“ / „Kood kehtib (päeva)“ and the "8 s / 30 days" facts have no counterpart.

**Change note (P4):** "• „Lehel näidatakse“ is a two-state switch at the top. Switching it is instant and shows UndoBar „Hüpikaken peidetud.“ • Fields on the left, the preview on the right. The preview follows the page language switch, so the separate ET/RU preview pills are gone. • „Reeglid“ (when the popup shows, the discount code) stays read-only text under the preview. • This is the only screen that uses the word „kampaania“." P3: "„Lehel näidatakse“ choice stays; one preview that follows the page LangSwitch (no separate preview pills) · „Reeglid“ card stays as read-only text · The only place the word „kampaania“ is used".
**Clicks:** switch popup on/off 2 → 1 (instant + undo).
**Today (files):** `kampaania/page.tsx` (24), `CampaignEditor.tsx` (198; `useSiteDraft(saveCampaign)` + `SaveBar`; `Choice` radios; two local `LangSwitch` previews), `Choice.tsx`, `SingleImage.tsx`, `I18nInput.tsx`, `components/site/CampaignCard.tsx`, `NewsletterPopupCard.tsx`, `NewsletterForm.tsx`, `domain/campaign.ts` (`popupShown`, `popupFlags`), `server/admin-site.ts` (`loadCampaign`).

### C5 Praktika — `/admin/praktika`

**Beyond the README**
- Frame (P4): eyebrow „Koolitused“ (P1 page list: „Praktika“), H1 „Praktikapaketid“, ET|RU, `✓ Mustand salvestatud 13:15`, „Vaata lehel ↗“; bar (white, 3 px `#9e8993` left border) „Avaldamata muudatused: 2 · MAXI hind, MAXI punkt 4“ with only „Avalda muudatused“.
- Two cards side by side (grid 1fr 1fr, gap 18, radius 22, padding 22; package name Jost 300 30 px; MINI border `#d9d2d5`, MAXI `#9e8993`): a row of three fields „Hind (€)“, „Modelle“, „Kestus“ (values 120 / 2 / „1 päev“; 210 / 4 / „2 päeva“), then „Sisaldab“ with rows ⋮⋮ + text + ✕ and „+ Lisa punkt (või Enter viimasel real)“. The mock does not show today's „Nimi“ and „Lühitekst“ fields.

**Change note (P4):** "• Two package cards share the template. Price, model count and duration are a row of three short fields, each validated on its own. • The points list gets drag, ↑/↓ and removal with undo. A new point is added with Enter in the last field. • The publish bar carries both packages, so one „Avalda muudatused“ publishes MINI and MAXI together." P3: "Template; MINI and MAXI side by side as today · Points rows drag + undo · Price/models validate per field".
**Clicks:** change a price typing + 1 → typing + 1 (Avalda) · add a point 2 → Enter.
**Today (files):** `praktika/page.tsx` (22), `PracticeEditor.tsx` (80; `useSiteDraft(savePractice)` + `SaveBar`), `ListEditor.tsx`, `TextField.tsx`; `server/admin-site.ts` (`loadPractice`), `domain/site-editor.ts` (`packageItems: 20`).

### C6 Tagasiside — `/admin/tagasiside` (`?vaade=arvustused`, `?olek=ootel`)

**Beyond the README**
- Frame (P4): eyebrow „Õpilased“, H1 „Tagasiside“, ink „Lisa arvustus +“, tabs „Vastused | Arvustused“, status pills „Ootab kinnitust 1 | Avaldatud 5 | Peidetud 1“. Review cards in a 2-column grid (white, radius 22, padding 22; the waiting one has a 1 px `#222` border): stars „★★★★★“ + state pill, quote „„Maria selgitab nii rahulikult, et julgesin kohe modelliga proovida.““, who „Kristel M. · Lash Lift BOTOX baaskoolitus · 19.10.2026“, buttons „Avalda“ (ink) + „Peida“ for waiting; „Peida“ + „Muuda“ for published, plus the „Avalehel“ switch (48 × 28 track, green when on).
- Phone: tab label „Arvustused · Ootab 1“; card with „Avalda“ and „Peida“; UndoBar „Arvustus avaldatud.“ + „Võta tagasi“.
- Answers ("Vastused"): a list with search; its drawer links to the matching review „Vaata arvustust →“ (no information-only status line).

**Change note (P4):** "• The menu badge lands on „Arvustused · Ootab kinnitust“. • Each review card: stars, text, the student and course, then „Avalda“ (instant, with UndoBar) and „Peida“. „Avalehel“ is a switch on published reviews. • „Lisa arvustus +“ opens a drawer (an explicit create); its cancel button is „Katkesta“. • „Vastused“ (the questionnaire answers) is a list with search. Its drawer links to the matching review („Vaata arvustust →“). • After „Avalda“, focus moves to the next waiting card." P3: "Tabs „Vastused | Arvustused“; badge for waiting reviews · „Avalda“/„Peida“ instant + UndoBar; „Avalehel“ is a switch · „Lisa arvustus“ opens a drawer (explicit create), cancel = „Katkesta“; answer drawer links to its review".
**Clicks:** approve a waiting review from the menu — P3 2 → 2 (badge lands on Arvustused·Ootab), P4 3 → 2 · add a review ≈6 → ≈6.
**Today (files):** `tagasiside/page.tsx` (335; answers view and reviews view, `Drawer` for answers), `ReviewsPanel.tsx` (306; Avalda/Peida/Avalehel/Muuda/Kustuta, add form, delete confirm) + `ReviewsPanel.module.css`, `ManualReviewForm.tsx` (251; „Lisa arvustus“ form, cancel „Tühista“), `FeedbackAnswers.tsx`, `review-view.ts`, `feedback.module.css`, `list-table.module.css`; `server/reviews.ts` (`adminReviews`, `pendingReviewCount`, `reviewCourses`), `server/actions/admin-reviews.ts`, `db/queries/protocols.ts` (`pageFeedback`, `feedbackById`, `feedbackStats`).

### C7 Testimine — `/admin/testimine`

**Beyond the README**
- Frame (P4): eyebrow „Haldus“, H3 header "UX-pass · 42 kontrolli · 31 läbitud · 2 viga" (Jost 300 42), SaveStatus „✓ Salvestatud 17:02“ and a „Värskenda“ pill. Filter rows: label „OLEK“ + pills „Kõik | Avatud 9 | Viga 2 | Läbitud 31“, label „KES“ + pills „Mina | Kõik“ (40 px pills, border `#cfc6ca`). Area cards (white, radius 22, padding 18 × 22): title (Jost 400 20), progress „7 / 9“ with a bar (78 %), ▾ to collapse together with the area's notes. Check rows (min-height 56, grid `1fr | 110px | 240px`): title, „Sammud ▸“, a 2-segment control „Läbitud“ (`#2f5d46` when set) | „Viga“ (`#8a3b3b`); „Viga“ opens a note field. Sample checks: „„Lisa laekumine“ kinnitab koha ja koostab kviitungi“ (Läbitud), „Täis koolitusel jääb koht kinnitamata, raha alles“ (Viga), „Otsing leiab telefoninumbri tühikutega“ (open), „„Taasta minu tekst“ paneb kadunud teksti tagasi“.
- The design's states: today's filters are Kõik | Avatud | Vead | Muudetud and `who` Kõik | Maria | Dim | Koos; the design's "Läbitud", "Mina" and the removal of „Muudetud“ and „Jäta vahele“ are not explained.

**Change note (P4):** "• The menu entry is under „Haldus“. Its badge counts your own „Viga“ checks. • One filter row with two labelled groups: „Olek“ (Kõik / Avatud / Viga / Läbitud) and „Kes“ (Mina / Kõik). The duplicate „Kõik“ is gone. • Each area shows a progress bar and collapses together with its notes. • A check row: the title, steps behind „Sammud ▸“, then „Läbitud“ and „Viga“ as a segmented control. „Viga“ opens a note field. • SaveStatus replaces the outbox line. A 401 shows „Salvestamata — logi uuesti sisse“." P3: "Menu entry under „Haldus“; badge = own „Viga“ · SaveStatus replaces the outbox line; 401 shows „logi uuesti sisse“ (parked) · Area notes collapse with the area; one filter row with labelled groups; empty filter shows „Selle valikuga kontrolle pole.“".
**Clicks:** reach the page when nothing is open type URL → 1 · pass a check 1 → 1.
**Today (files):** `testimine/page.tsx` (44), `TestPlan.tsx` (483; filters `FILTERS`/`WHOS`, per-device view in localStorage, areas, checks, marks), `TestPlan.module.css`, `testplan-outbox.ts` (310; the outbox line / retries), `TestplanCard.tsx`; `server/testplan.ts` (`testPlan`, `readAnswers`, `testplanYou`, `testplanBuildAt`, `testplanCard`), `app/api/admin/testplan/route.ts`, `src/data/testplan.json`.

### C8 Sisselogimine — `/admin/login`

**Beyond the README**
- Frame (P3): the desktop frame is 640 px wide, the phone 390. Heading „Halduse sisselogimine“, lead „Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.“, a row "E-post" with the prefilled address („maria@example.test“) and the link „Muu aadress“, ink button „Saada sisselogimislink“. Sent state: „Link on teel“ / „Saatsime lingi aadressile maria@example.test. See kehtib 15 minutit.“ / „Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.“ / „Muu aadress“.
- A 4th request within 10 minutes shows „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ instead of "claiming it was sent" (B20). The link "signs in whichever device opens it" — the lead says so.

**Change note (P3):** "• The last address is prefilled on this device, and „Muu aadress“ clears it. • A deep link opened while signed out is kept as ?tagasi=, and after sign-in she lands on it (B19). • The sent state says where the mail went and what to do if it doesn't arrive. A 4th request within 10 minutes shows „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ instead of claiming it was sent (B20). • The link signs in whichever device opens it, and the text says so: „Ava link selles seadmes, kus soovid sisse logida.“ • Field style: radius 10, border #d9d2d5, the same as all admin inputs (appendix 00)."
**Clicks:** sign in again on a known device typing + 1 → 1.
**Today (files):** `login/page.tsx` (43; `?viga=link|server` notice), `login/LoginForm.tsx` (130; one POST to `/api/auth/request`, 429 → `errorTooMany`), `login/login.module.css`; `server/login.ts` (`handleLoginRequest`: IP rate limit 5 per 10 min via `ratelimit.ts`; allowed address check; per-address cap `LOGIN_TOKEN_CAP = 3` per 10 min in `server/auth.ts` `issueLoginToken` returns `null` → answered 200 "ok"), `server/auth.ts` (`requireAdmin` redirects to `/admin/login` without a return path), `app/api/auth/request`, `app/api/auth/verify/route.ts` (always redirects to `/admin`), `app/api/auth/logout`.
**Change:** `?tagasi=` through request → token → verify (same-origin `/admin` path only); a distinct "rate" answer.

---

## 4. Part 3 "Final lists" (text changes, behaviour changes, parked items)

P3 section "6 · Final lists (parts 1–3)": "The text changes from parts 1 and 2 are listed in those files; this file adds part 3's. The behaviour-change and parked-item lists below are complete. All of it is repeated in the hand-off README." The three lists below are copied from the P3 script data.

#### 4.1 Text changes — part 3 (the third table; verbatim, 25 rows)

| # | Old | New |
|---|---|---|
| 1 | „Salvesta“ (course editor, site editors, Praktika, Seaded) | „Avalda muudatused“ (published items) / none (drafts) |
| 2 | — | „Avaldamata muudatused: {n}“ · „Eelvaade ↗“ · „Loobu muudatustest“ |
| 3 | Per-module „Salvesta“ | removed |
| 4 | „Kas kustutan mooduli „{title}“?“ (programme) | „Kas kustutan punkti „{title}“?“ |
| 5 | Lesson „Peida“ / „Näita õpilastele“ | switch „Õpilastele nähtav“ |
| 6 | „Video kustutatakse. Jätkan?“ / „Jah, jätka“ / „Ei“ | „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“ |
| 7 | „Salvesta toimumine“ | removed |
| 8 | — | „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ |
| 9 | — | „Kinnitatud on {n} — kohti ei saa olla vähem.“ |
| 10 | „Kustuta toimumine“ on booked sessions | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ |
| 11 | „Eesti aeg.“ hint | label „Algus (Eesti aeg)“ |
| 12 | „Salvesta tunnistuse andmed“ / „Salvesta arve andmed“ / „Salvesta lepingud“ | removed |
| 13 | — | „Avalda uus leping“ + „Kas avaldan uue e-koolituse lepingu? {n} aktiivset õpilast …“ |
| 14 | — | „Järgmine arve: {nr}“ / „Järgmine tunnistus: {nr}“ |
| 15 | „Kampaaniad“ / „Uus kampaania“ | „Kirjad“ / „Uus kiri +“ |
| 16 | „Salvesta muudatused enne saatmist.“ | removed |
| 17 | „Saada proov“ + radios „Kellele“, „Keel“ | select „{aadress} · {keel}“ + „Saada proov“ |
| 18 | „Saada kõigile“ | „Saada kõigile ({n})“ |
| 19 | — | „Kustuta mustand“ |
| 20 | „… see läheb välja, kui eelmine on saadetud.“ | „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“ |
| 21 | „Lae alla kinnitatud (CSV)“ / „Lae alla kõik (CSV)“ | „Laadi alla (CSV)“ (current filter) |
| 22 | Login lead „Sisesta oma e-posti aadress, saadame sulle sisselogimislingi. Parooli pole vaja.“ | „Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.“ |
| 23 | — | „Muu aadress“, „Link on teel“, „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ |
| 24 | Popup preview ET/RU pills | follows the page LangSwitch |
| 25 | Testimine filter rows (two „Kõik“) | one row: „Olek“ / „Kes“ labelled groups |

Parts 1 and 2 have their own text-change tables (25 and 26 rows); P3 says "The text changes from parts 1 and 2 are listed in those files; this file adds part 3's." All three are merged, with admin.ts locations, in `ux-handoff-strings.md` § 2.

#### 4.2 Behaviour changes B1–B22 (verbatim names and descriptions; status as printed)

| ID | Change | Description | Status |
|---|---|---|---|
| B1 | Autosave endpoints. | Per-part versioned saves for every editor and drawer. | accepted |
| B2 | Draft layer. | Published content saves to a draft; „Avalda muudatused“ copies it live (Q1). | accepted |
| B3 | Partial saves. | Valid fields save while an invalid one is held. | accepted |
| B4 | One money path. | „Lisa laekumine“ adds a payment with a seat check. | accepted |
| B5 | Undo for removals. | Soft delete / delayed purge for 8 s. | accepted |
| B6 | New badge counts. | Tagasiside, Maksed ja arved, Testimine. | accepted |
| B7 | Search on all lists. | ?otsi= and scopes. | accepted |
| B8 | Protokollid index. | List without a parameter. | accepted |
| B9 | Overview counts agree. | Sendable subscribers only. | accepted |
| B10 | Confirm cancel registration. | ConfirmPanel. | accepted |
| B11 | Batch invoices. | „Koosta {n} arvet“. | accepted |
| B12 | Extend access. | New end date on an existing access, with undo. | accepted |
| B13 | Protocol conflict restore. | „Taasta minu tekst“. | accepted |
| B14 | „Tühistatud pangas“ under „Ootel kontrollil“. | Filter/badge mapping. | accepted |
| B15 | Test-review marks on the server. | No longer localStorage-only. | accepted |
| B16 | Single-session shortcut. | Menu → session screen on a one-session day. | accepted |
| B17 | Delete a newsletter draft. | Sent letters stay undeletable. | accepted |
| B18 | Modules in the course draft. | Modules/lessons join the course autosave + draft; type follows the draft. | accepted |
| B19 | Return to the deep link after sign-in. | ?tagasi= kept through the magic link. | accepted |
| B20 | Honest rate-limit message. | Say the limit instead of "sent". | accepted |
| B21 | Invoice numbers per year. | The sequence is keyed by invoice year, so January starts at {year}-001 by itself. In December Seaded shows „1. jaanuarist: MSL{year+1}-001“. Replaces the manual December preset (m5). | accepted |
| B22 | One open Montonio order per registration. | Starting a new online payment marks the older open order „Asendatud“. If both get paid, the second lands in „Ootel kontrollil“ as „Topeltmakse — tagasta“ (m7). | accepted |

#### 4.3 Parked UX items (status as printed)

| # | Item | Status |
|---|---|---|
| 1 | Unsaved warning on in-admin navigation | ✓ |
| 2 | Scroll-lock shift (scrollbar-gutter) | ✓ |
| 3 | a11y names + focus ring (Testimine, wider) | ✓ |
| 4 | Sticky save line on Testimine | ✓ |
| 5 | 401 sign-in hint | ✓ |
| 6 | Overview → Arved link | ✓ |
| 7 | Badge refresh after „Ava test uuesti“ | ✓ |
| 8 | Slide/FAQ errors keyed by index | ✓ |
| 9 | Lesson drawer: stale confirm, false unsaved, no Back warning | ✓ |
| 10 | Video field: focus lost, % announced per step | ✓ |
| 11 | R19 typed amount overcharge | ✓ |
| 12 | Two open Montonio orders (m7) | ✓ (B22) |
| 13 | „Tagastatud“ invoice still sendable | ✓ |
| 14 | December number preset (m5) | ✓ (B21) |
| 15 | „Tühistatud pangas“ under „Ebaõnnestunud“ | ✓ (B14) |
| 16 | Protocol status line staying after re-check | ✓ |
| 17 | Shared-tablet attribution | left: Maria only, not needed |
| 18 | Wording drafts „voor“/„kord“, „Ava täissuuruses“ | ✓ („kord“, keep) |
| 19 | Õpilased cards at 1360 px | ✓ |
| 20 | „(mustand) (avatud kuni …)“ | ✓ |
| 21 | Stale-tab notFound generic error | ✓ (SaveStatus „Seda enam ei ole“) |
| 22 | „Laada alla“ vs „Laadi alla“ | ✓ |
| 23 | No copy button for e-course contracts | left: new feature |
| 24 | ReviewsPanel stale focus / focus after delete | ✓ (UndoBar keeps focus) |
| 25 | Test-plan checks for reviews | left: testplan.json content |
| 26 | „Märgi saadetuks“ for a stuck send | left: moot |
| 27 | Campaign confirm updatedAt | ✓ (autosaved draft) |
| 28 | Mail logo in dark mode | left: e-mails out of scope |
| 29 | Seaded cards without guard | ✓ |
| 30 | „Võta number paberile“ button | left: new feature |
| 31 | Contract hint lists all placeholders | ✓ (chips) |
| 32 | TestPlan.tsx size, Telegram capping, stale plan text | left: code / Dim |
| 33 | Student & public side items (11) | left: out of scope |

Total 33: **25 resolved** (✓), **8 left**.

Other parked-item lists in the design:
- **Resolved in P2** (10): overview link to „Arved“ · reopen-test badge refresh · R19 typed „Laekunud summa“ overcharge (one money path) · Õpilased list cards at 1360 px · „(mustand) (avatud kuni …)“ double brackets · „Tagastatud“ invoice still sendable · „Tühistatud pangas“ under „Ebaõnnestunud“ · protocol status line staying after re-check (SaveStatus) · „Laada alla“ vs „Laadi alla“ · waiting reviews without a badge.
- **Closed by P1** (8): see § 2.10.
- **README § 6** "Resolved: everything in Part 3 → Final lists marked ✓, including m5 (B21) and m7 (B22). Left: shared-tablet attribution (not needed — Maria is the only course-day user), e-course contract copy button and „Võta number paberile“ (new features), testplan.json content, mail dark-mode logo (e-mails out of scope), TestPlan.tsx size / Telegram capping / stale plan text (code / Dim), all student and public-side items (out of scope)." → it leaves out the 26th row „Märgi saadetuks“ for a stuck send — left: moot.

---

## 5. Findings: contradictions, gaps and items that look infeasible as drawn

Evidence is the file and line; "README" = the hand-off README.

**Contradictions between README and the HTML (or inside the README)**

| # | Finding |
|---|---|
| F1 | README first page: "Behaviour changes B1–B10 are accepted; B11–B20 are still to decide (see §5)". README § 5 heading, P3 final list, P4 intro and the deck all say B1–B22 are accepted. Treat the first-page sentence as stale; § 5 also asks for B11–B22 "as separate commits". |
| F2 | **C4 Hüpikaken.** README: "the „Lehel näidatakse“ choice is instant with UndoBar; one preview that follows LangSwitch". P3: "choice stays". P4: "a two-state switch", UndoBar „Hüpikaken peidetud.“, one popup with fields „Soodustus (%)“, „Kood kehtib (päeva)“, facts „8 s pärast · üks kord 30 päeva jooksul“ and a „Reeglid“ line about the e-mail code. The app: `CampaignEditor.tsx` has **three** choices (Kampaania / Uudiskiri / Väljas, `popupFlags`), **two** popup editors with two ET/RU previews, a fixed „Reeglid“ list (6 s, once per visit, `campaign.rulesList`), and no discount-percent / code-validity fields (those words belong to Seaded's newsletter „Tervitussoodustus“ / „Tervituskood“). Building the design as drawn would drop the newsletter popup editor or invent fields; the owner has to say which. The P4 route `/admin/hupikaken` does not exist (`/admin/kampaania`, `sections.ts`). |
| F3 | **C6 focus.** README: "focus stays on the row after an action" (and the parked list: "UndoBar keeps focus"); P4: "After „Avalda“, focus moves to the next waiting card". The click claim for "approve a waiting review from the menu" is 2 → 2 in P3 and 3 → 2 in P4. |
| F4 | **Active menu item.** README: `/admin/protokollid*` highlights „Protokollid“. But `/admin/protokollid?ligipaas=<id>` is the practical-work assessment screen (A4, back link „← Hindamine“), and today `page.tsx` picks `active` by parameter (`ligipaas` → assessment, `registreering` → registrations, `sessioon` → calendar). `?ligipaas=` must stay under „Hindamine“; `?registreering=` / `?sessioon=` need a decision (design: Protokollid). |
| F5 | **Test-plan screen (C7) vs the test-plan system.** Design filters: Olek (Kõik / Avatud / Viga / Läbitud), Kes (Mina / Kõik); check buttons „Läbitud“ / „Viga“. Today: Kõik / Avatud / Vead / Muudetud, who Kõik / Maria / Dim / Koos, buttons OK / Viga / Jäta vahele, and the marks „Uuesti testida“ / „Sõnastus muutus“ / „Uus“ (`item.mark`) that `src/data/testplan.json` stamps per deploy and „Muudetud“ filters. The design drops all of that without saying so. |
| F6 | README B2 puts "Õppetunni liik (instant)", the visibility switch and file removal on the lesson drawer while B18 puts modules and lessons into the course draft; for a published e-course it is not stated which of these write live and which write the draft (same question for the popup on/off switch, slide „Näidatakse avalehel“, and review „Avalda“ / „Peida“ / „Avalehel“, which are not in the draft layer). |
| F7 | P1 § 3.1 lists „Salvesta saaja“ (invoice buyer panel) among the buttons that become autosave; the README keeps „Muuda saajat“ under „Veel ▾“ and says nothing about its save. Editing the buyer of an issued invoice is a record change; decide explicit or autosave. |

**Items that look infeasible or risky as drawn**

| # | Finding |
|---|---|
| F8 | **Error / loading boundaries keep the sidebar only if Shell moves.** `Shell` is rendered inside every page (`<Shell email active>` in each `page.tsx`), `(panel)/layout.tsx` only calls `requireAdmin()`. A `(panel)/error.tsx` replaces the page, so the sidebar goes with it, and a `(panel)/loading.tsx` has no sidebar either. README: "One error.tsx for the panel layout, so the sidebar stays." Shell (with `active` read from the path in the client Sidebar) has to be hoisted into the layout first; `useLeaveGuard` "in Shell" wants the same place. |
| F9 | **Login (B20).** The per-address cap (`LOGIN_TOKEN_CAP = 3` in 10 min, `server/auth.ts`) applies only to allow-listed addresses; `handleLoginRequest` answers 200 for an address outside the list and for a capped one, and `admin.ts` L48 says the page "never tells which addresses exist". Showing „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ only for the capped, allowed address would reveal who is an admin. Either count attempts for every typed address, or show the message for the IP limit only (5 per 10 min, `ratelimit.ts`). The sent text „Saatsime lingi aadressile {email}“ states a fact that is false for a non-admin address (today's text is hedged: „Kui see aadress on lubatud …“), and „saada uuesti 1 minuti pärast“ has no 1-minute rule behind it. |
| F10 | **A4 loses the consequence check.** The informed „Saada hinnang · …“ has no confirmation, but a send with every point approved completes the course, issues the certificate and mails the student (`assessment.screen.sentCompleted` „Hinnang saadetud. Koolitus on lõpetatud.“). README § 1.6 says to use the panel when an action "changes a student's access … right away"; P1 § 3.3 explicitly lists it under "informed button". The old panel's lines `confirmPassed` („Kõik punktid on kinnitatud: praktiline töö on sooritatud.“) and `confirmNotes` have no counterpart. |
| F11 | **A3 „Saada protokoll {eesnimi}le“.** The Estonian "-le" form of an arbitrary first name cannot be generated reliably (names ending in a consonant take „-ile“; the sample data has Cyrillic names such as „Маргарита О.“). Needs a rule table, a neutral wording („Saada protokoll: {eesnimi}“) or an owner decision. |
| F12 | **Draft layer plumbing.** There is no draft storage today (`useSiteDraft` is only client state + per-part version hashes; the only `draftJson` in the code is the protocol helper). B2 needs per-part draft rows for courses (incl. modules/lessons), hero slides, FAQ, trainer, posts, popup, practice and the contract texts; public pages must render a draft for an admin (`?mustand=1` + the preview cookie) without breaking `server/public-cache.ts`; and P4's phone note puts „Loobu muudatustest“ "behind „Eelvaade“ on the preview page", i.e. an admin control on a public page, which the README never mentions. |
| F13 | **„Töötlemisel {n}%“** (B2 lesson rows and the phone drawer) needs Bunny's encode progress. `BunnyVideo` is `{ status, length, width, height }` and `AdminVideo`/`VideoStatus` carry no progress; today's text is „Töötlemisel…“. |
| F14 | **A2 status control** shows two choices (Ootab ettemaksu / Kinnitatud); today `RegistrationForms.tsx` has three radios, and the third (Tühistatud) is also how a cancelled registration is put back. The design has no path for un-cancelling. The amount pill „290 € · kogu summa“ is the full price in the mock, README says "the full remainder"; the method pill „Kaart“ vs `paidMethodText("card")` = „Kaardimakse kohapeal“; the result messages when the receipt box is unticked, when the payment stays under 50 %, or when seller data is missing (box hidden) are not worded. |
| F15 | **Missing wording:** an access that ran out by date (today `clients.drawer.state.expired` „Lõppes {date}“); the facts line of the Individuaal / Praktika / Ootenimekiri / Muutmine request cards; the delete-draft ConfirmPanel (B5); the screen-reader labels of the four new badges (`shell.badge*`); the empty / error states of the Protokollid index beyond the README line. |
| F16 | **Name clashes and reuse.** README's new `LangSwitch` (page-level, context) vs the exported `LangSwitch` in `I18nInput.tsx`, which `I18nInput`, `ListEditor`, `FaqEditor`, `CampaignEditor` (two previews) and `NewsletterCampaignEditor` (preview) use; a `SaveStatus` type already exists in both `protocol-autosave.ts` and `useSiteDraft.ts`. The README's numbers are already constants in `protocol-autosave.ts`: `DEBOUNCE_MS = 1500`, `RETRY_MS = [2000, 5000, 10000, 20000, 30000]`, `KEEPALIVE_MAX_BYTES = 64_000`. |
| F17 | **New-record flows:** C3 „Lisa postitus +“ creates a draft titled „Uus postitus“ at once; the slug is derived from the title and is unique (`post.slugTaken`), so repeated clicks collide. `PostEditor` today creates on the first save (`always: isNew`), `lessons.saveFirst` („Salvesta koolitus, et lisada mooduleid.“) and `courseEditor.created` / `post.created` assume that flow. |

**Sample-data inconsistencies in the mock-ups (not wording)**

| # | Finding |
|---|---|
| F18 | A3 index lists a 29.09 session in a list of "today and the last 14 days" (mock date 20.10). The menu badge „Maksed ja arved 6“ vs the A1 queue (6 unbilled + 1 held = 7). Phone menu sum 13 vs the drawn badges (3+2+7+1+6 = 19). C2 gallery counter „4 / 12“ vs limit 24. P4 phone B4 prints the „1. jaanuarist …“ line on 20.10 (README: from 1 December). P3 "five sections" lists six. C3/C5 draft bars show fewer buttons than the README's three. |
| F19 | B9 ("overview counts agree") was written for the newsletter tile that A1 removes; what is left is "n excludes sample addresses" in the B5 send confirm. |
| F20 | R13 / `InvoiceCatchUp.tsx` documents "No bulk button: each one is a real number"; B11 (accepted) reverses it with one `createInvoicesForUnbilled()`. `addRegistrationPayment` (`db/queries/admin.ts` L403) and `PaidFields.tsx` already exist and fit the new „Lisa laekumine“ panel. |

---

## 6. Compact map: screen → route → files

| Screen | Route | `page.tsx` | Components | Styles | Server / data |
|---|---|---|---|---|---|
| Shell, sidebar, phone menu | all | – | `Shell.tsx`, `Sidebar.tsx`, `sections.ts`, `data.ts`, `Drawer.tsx`, `AdminIcon.tsx`, `ReadyMark.tsx` | `Shell.module.css`, `Sidebar.module.css`, `Drawer.module.css`, `ui.module.css` | `db/queries/admin.ts` `adminCounts`; `(panel)/layout.tsx` |
| A1 Ülevaade | `/admin` | `(panel)/page.tsx` | `TestplanCard.tsx` | `overview.module.css` | `db/queries/protocols.ts`, `public.ts`, `assessment.ts`; `server/testplan.ts` |
| A2 Registreerimised | `/admin/registreerimised` | `registreerimised/page.tsx` | `RegistrationForms.tsx`, `PaymentLines.tsx`, `PaidFields.tsx`, `InvoiceBlock.tsx`, `InvoiceRow.tsx`, `ContractBlock.tsx`, `FeedbackAnswers.tsx`, `StatusPill.tsx`, `Pager.tsx` | `registrations.module.css`, `RegistrationForms.module.css`, `InvoiceBlock.module.css`, `list-table.module.css` | `server/actions/admin.ts`, `server/admin.ts`, `db/queries/admin.ts`, `server/invoices.ts` |
| A3 Protokollid | `/admin/protokollid` | `protokollid/page.tsx` | `ProtocolScreen.tsx`, `ProtocolSend.tsx`, `protocol-autosave.ts` | `ProtocolScreen.module.css` | `db/queries/protocols.ts`, `server/protocols.ts`, `server/actions/admin-protocols.ts`, `app/api/admin/protokoll/route.ts` |
| A4 Hindamine | `/admin/hindamine`, `/admin/hindamine/test`, `/admin/tunnistused`, `/admin/protokollid?ligipaas=` | `hindamine/page.tsx`, `hindamine/test/page.tsx`, `tunnistused/page.tsx`, `protokollid/page.tsx` | `ReopenTest.tsx`, `AssessmentScreen.tsx`, `AssessmentStage.tsx`, `AssessmentSend.tsx`, `PhotoViewer.tsx`, `verdict-taps.ts`, `TestReview.tsx`, `ReissueCertificate.tsx` | `hindamine/assessment.module.css`, `Assessment.module.css`, `TestReview.module.css`, `tunnistused/register.module.css` | `db/queries/assessment.ts`, `server/assessment.ts`, `server/test-attempts.ts`, `server/certificates.ts`, `server/actions/admin-assessment.ts`, `app/api/admin/hinnang/route.ts` |
| A5 Õpilased | `/admin/opilased` | `opilased/page.tsx` | `ClientDrawer.tsx`, `ClientForms.tsx` | `opilased/clients.module.css`, `ClientDrawer.module.css`, `list-table.module.css` | `server/admin-clients.ts`, `server/actions/admin-clients.ts`, `domain/client-access.ts` |
| A6 Maksed ja arved | `/admin/maksed`, `/admin/arved` | `maksed/page.tsx`, `arved/page.tsx` | `PaymentLines.tsx`, `InvoiceCatchUp.tsx`, `InvoiceRow.tsx`, `invoice-view.ts`, `Pager.tsx` | `maksed/payments.module.css`, `arved/arved.module.css`, `list-table.module.css` | `db/queries/payments.ts`, `server/invoices.ts`, `server/actions/admin-invoices.ts`, `domain/invoice.ts`, `domain/payments.ts`, `app/api/admin/arved/route.ts` |
| A7 Päringud | `/admin/paringud` | `paringud/page.tsx` | `RequestToggle.tsx`, `Pager.tsx` | `paringud/requests.module.css` | `db/queries/admin.ts` (`pageRequests`), `domain/registration-card.ts`, `server/actions/admin.ts` |
| B1 Koolitused | `/admin/koolitused` | `koolitused/page.tsx` | `CourseOrder.tsx` | `koolitused/courses.module.css` | `server/actions/admin-content.ts`, `server/admin-content.ts`, `db/queries/admin.ts` (`moveCourse`) |
| B2 Course editor, lesson drawer | `/admin/koolitused/[id]` | `koolitused/[id]/page.tsx` | `CourseEditor.tsx`, `LessonsEditor.tsx`, `LessonDrawer.tsx`, `LessonFiles.tsx`, `LessonVideoField.tsx`, `ListEditor.tsx`, `GalleryEditor.tsx`, `ProtocolStagesEditor.tsx`, `TestEditor.tsx`, `BadgeEditor.tsx`, `I18nInput.tsx` | `CourseEditor.module.css`, `LessonsEditor.module.css`, `TestEditor.module.css`, `editor.module.css` | `server/actions/admin-content.ts`, `admin-lessons.ts`, `server/admin-lessons.ts`, `lesson-videos.ts`, `lesson-files.ts`, `bunny.ts`, `domain/course-editor.ts` |
| B3 Kalender | `/admin/kalender` | `kalender/page.tsx` | `SessionForm.tsx` | `kalender/calendar.module.css` | `server/actions/admin-content.ts` (`saveSession`, `deleteSession`), `db/queries/admin.ts` |
| B4 Seaded | `/admin/seaded` | `seaded/page.tsx` | `SettingsEditor.tsx`, `CertificateSettings.tsx`, `InvoiceSettings.tsx`, `ContractTexts.tsx` | `CertificateSettings.module.css`, `InvoiceSettings.module.css`, `ContractTexts.module.css`, `site-editor.module.css` | `server/admin-site.ts`, `server/certificates.ts`, `server/invoices.ts`, `server/contracts.ts` |
| B5 Uudiskiri | `/admin/uudiskiri` | `uudiskiri/page.tsx` | `CampaignsPanel.tsx`, `NewsletterCampaignEditor.tsx`, `Pager.tsx` | `uudiskiri/newsletter.module.css`, `CampaignsPanel.module.css` | `server/newsletter-campaigns.ts`, `server/actions/admin-newsletter.ts`, `db/queries/admin.ts` (`pageSubscribers`), `app/api/admin/subscribers.csv/route.ts` |
| C1 Avaleht | `/admin/avaleht` | `avaleht/page.tsx` | `HomeEditor.tsx`, `SlidesEditor.tsx`, `FaqEditor.tsx`, `SingleImage.tsx`, `ListEditor.tsx`, `SaveBar.tsx`, `useSiteDraft.ts` | `site-editor.module.css`, `editor.module.css` | `server/admin-site.ts` (`loadHome`), `server/actions/admin-site.ts` |
| C2 Koolitaja | `/admin/koolitaja` | `koolitaja/page.tsx` | `TrainerEditor.tsx`, `GalleryEditor.tsx` | same | `server/admin-site.ts` (`loadTrainer`) |
| C3 Uudised | `/admin/uudised`, `/admin/uudised/[id]` | `uudised/page.tsx`, `uudised/[id]/page.tsx` | `PostEditor.tsx` | `uudised/news.module.css` | `server/admin-site.ts` (`loadPost`), `db/queries/admin.ts` (`listAllPosts`) |
| C4 Hüpikaken | `/admin/kampaania` | `kampaania/page.tsx` | `CampaignEditor.tsx`, `Choice.tsx`, `I18nInput.tsx` | `site-editor.module.css` | `server/admin-site.ts` (`loadCampaign`), `domain/campaign.ts` |
| C5 Praktika | `/admin/praktika` | `praktika/page.tsx` | `PracticeEditor.tsx` | same | `server/admin-site.ts` (`loadPractice`) |
| C6 Tagasiside | `/admin/tagasiside` | `tagasiside/page.tsx` | `ReviewsPanel.tsx`, `ManualReviewForm.tsx`, `FeedbackAnswers.tsx`, `review-view.ts`, `Drawer.tsx` | `tagasiside/feedback.module.css`, `ReviewsPanel.module.css` | `server/reviews.ts`, `server/actions/admin-reviews.ts`, `db/queries/protocols.ts` |
| C7 Testimine | `/admin/testimine` | `testimine/page.tsx` | `TestPlan.tsx`, `testplan-outbox.ts`, `TestplanCard.tsx` | `TestPlan.module.css` | `server/testplan.ts`, `app/api/admin/testplan/route.ts`, `src/data/testplan.json` |
| C8 Sisselogimine | `/admin/login` | `login/page.tsx` | `login/LoginForm.tsx` | `login/login.module.css` | `server/login.ts`, `server/auth.ts`, `server/ratelimit.ts`, `app/api/auth/request`, `verify`, `logout` |
