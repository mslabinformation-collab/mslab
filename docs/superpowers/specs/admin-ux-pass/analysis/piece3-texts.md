# Admin UX pass, piece 3 — texts the design leaves unwritten (APPROVED)

**Dim approved all drafts below on 23.10.2026 ("Ok"), with the recommended options:**
- S3-P3-a: the line „Avalikul lehel on näha eelmine versioon.“ shows on **every** PublishBar, after the list of labels (desktop bar).
- S3-P3-g: the header shows „Täida kohustuslikud väljad“, then „Vajuta „{nupp}“.“ once every required field is valid; leaving with typed text and nothing created asks with the leave notice and the reason „{Asja} pole veel lisatud.“.
- S3-P3-h: „Uus kiri +“ creates a draft named „Uus kiri“ at once and puts the cursor in „Nimi“.
- S3-P3-k: Privaatsus and Õppetingimused use the button „Avalda uus tekst“ with their own questions.
- §2 P-9: the six texts that name „Seaded → Arve andmed“ / „Ettemaksu juhised“ are renamed to „Seaded → Maksmine“ (the cards merge, README B4), including S3-c of piece 2.
- Section 2 (pattern-derived) and section 4 (builder defaults) stand as written.

The builder uses these texts verbatim. Section 5 lists texts for piece 4: still to be asked.


Piece 3 = the B screens: B1 Koolitused, B2 course editor and lesson drawer, B3 Kalender, B4 Seaded, B5 Uudiskiri, with B9, B17, B18 and the Seaded side of B21. Nothing here is approved yet. Section 1 is for Dim; the builder uses sections 2–4 unless Dim objects. Nothing is invented (SPEC S3).

Admin text is Estonian only. No text of piece 3 leaves the admin (no mail, no student page), so no RU is proposed.

Short names for the references (as in piece2-texts.md):
- ADM = `app/src/i18n/dict/admin.ts` (line numbers as of main c258a52, i.e. after pieces 1 and 2)
- README = `docs/superpowers/specs/admin-ux-pass/handoff/README.md`
- P1 / P3 / P4 = `handoff/MS LAB Admin UX Pass.dc.html` / `… - Part 3.dc.html` / `… - Part 4.dc.html` (line numbers of the file)
- SPEC = `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`; STR / BEH / SCR = `analysis/strings.md` / `behaviours.md` / `screens.md`
- LEDGER = `docs/superpowers/plans/2026-10-21-admin-ux-global-ledger.md`; P2T = `analysis/piece2-texts.md`

House style (as in P2T): result lines end with a full stop, labels and buttons do not; „…“ quotes for names of buttons, fields and titles; sentence case; parts joined with " · "; the long dash " — " with spaces; ConfirmPanel = question → plain lines → „Jah, {tegusõna}“ / „Katkesta“; informal "sa/sinu"; a refusal that says "changed meanwhile" ends „Vaata see üle.“ (P2T W6, W7).

## Counts

- **13 items to put to Dim** (S3-P3-a … S3-P3-m).
  - 4 are places SPEC S3 names: c (a lesson file's „Eemalda“, plus the lesson switch), d (list-row removals), e (S6 fallback), f („Kustuta mustand“).
  - 3 were left open earlier: a and b (PublishBar, LEDGER T11), g (`?id=uus`, P2T §5). j (the contract-publish ConfirmPanel) is on the P2T §5 list too, but only its contact variant lacks text.
  - 5 are gaps found by going through README §3, §5 and the Part 3/4 frames: h, i, k, l, m.
- **13 more are pattern-derived** (section 2, P-1 … P-13): each rests on a drawn text or an existing string.
- STR's Outcome column marks no B screen "ASK DIM" (its three ASK DIM rows are D8 A6, answered in P2T; D19 C4, ruled by SPEC D3; D25 C2, piece 4). Where a B row's outcome is only a fragment, it is item j (D13).
- Already settled and NOT asked again: the 8 piece-1 texts (badges, leave reasons), the PublishBar words (ADM:215-224), the A-screen texts of P2T, and Dim's 22.10 ruling that the lesson drawer has no ET | RU switch (LEDGER, last line).

---

## 1. Ask Dim (piece 3)

### S3-P3-a — PublishBar: the line „Avalikul lehel on näha eelmine versioon.“  [left open, LEDGER T11]
- Screen: every PublishBar; the first one is the course editor (B2), when a published course has unpublished changes.
- Drawn once: P3:94 only ("Avaldamata muudatused: 3 · Lühikirjeldus, Hind, Moodul 03. Avalikul lehel on näha eelmine versioon."). The deck's bar and the other desktop bars (P3:276, P4:161, 243, 305) leave it out, README §1.8 says only "count + a list of the changed field labels".
- Question: show the line or not, and where.
- Draft: after the list of labels, on the desktop bar only (the phone bar stays one line):
  `Avaldamata muudatused: 3 · Lühikirjeldus, Hind, Moodul 03. Avalikul lehel on näha eelmine versioon.`
  - Recommendation: on every PublishBar. It is true for all of them, there is one component, and it tells her that nothing has changed on the site yet.
  - Alternatives: only on the course editor, or never (then the one drawn sentence is dropped).
- Reference strings: P3:94; ADM:215-216 `publish.count`, `publish.preview`; ADM:219 `publish.confirm` ("… Avalikul lehel jääb praegune versioon.", the same idea in the discard question).

### S3-P3-b — PublishBar: the list of fields „Avalda muudatused“ could not publish  [left open, LEDGER T11]
- Screen: under the bar, after a press of „Avalda muudatused“ (README §1.8 "blocked fields are listed"). Piece 1 prints the labels only.
- When: a part is blocked for one of two reasons.
  1. A required field is missing at publish. The shape is drawn once for a post, `Puudub: kaanepilt` (P4:227, C3). For a course the check made only at publish is the price (ADM:12 `priceRequired` "Avaldatud koolitusel peab olema hind."; a blank title never reaches a draft, it is held back as invalid).
  2. The live part changed meanwhile (`publishDrafts` blocks it, never overwrites: `server/drafts.ts:108-129`).
- Placeholders: {väljad} the labels, in lowercase, joined with ", " (the labels of the bar's list).
- Draft:
  - missing: `Puudub: {väljad}` — e.g. `Puudub: hind`; the field also shows its own error (ADM:12).
  - changed meanwhile: `Neid välju ei avaldatud, sest neid muudeti vahepeal teises aknas. Vaata need üle.` and below it the labels as a list (as piece 1 prints them).
  - a lesson Maria deleted in the draft got student progress meanwhile (rare; the rule is "hidden, never deleted", BEH B18): `Õppetund „{title}“ jäi alles: õpilastel on selles edenemist. Seda saab ainult peita.`
- The rest of the parts are published; only the blocked ones stay in the bar.
- Reference strings: P4:227; ADM:190 `autosave.conflict` "Muudeti teises aknas — vaata üle"; ADM:1172 `requests.stale` "Päringut muudeti vahepeal. Vaata see üle."; ADM:1723 `lessons.drawer.inUse` "Õppetunnil on õpilaste edenemist: seda saab ainult peita."
- Piece 4's editors (home, trainer, news, popup, practice) reuse these words; only their own required-field labels (e.g. „kaanepilt“) are asked then.

### S3-P3-c — UndoBar in the lesson drawer: a file removed, a lesson hidden  [named in S3]
- Screen: B2 lesson drawer (README §3 B2).
- When:
  - she presses „Eemalda“ on a file in „Failid“ (README: "instant with UndoBar"; soft delete, B5);
  - she switches „Õpilastele nähtav“ off. The design's click table says "Hide a lesson 1 → 1 (+ undo)" (P3:343); the README does not mention the bar.
  - Turning the switch on again has no bar (it is its own reverse, as P2T P-14 for „Märgi tegemata“).
- Placeholders: none (the drawn sample has no name: „Pilt eemaldatud.“).
- Draft:
  - file: `Fail eemaldatud.`
  - lesson hidden: `Õppetund peidetud.`
- If the undo fails the bar says `Salvestamine ei õnnestunud. Proovi uuesti.` (ADM:162, the bar's own fallback; the server keeps the file 10 s, the bar 8 s).
- Reference strings: P1:356 „Pilt eemaldatud.“ + „Võta tagasi“; ADM:1733 `lessons.files.removeLabel` "Eemalda fail: {name}"; ADM:1720 `lessons.drawer.hiddenNote` "Peidetud: õpilased seda ei näe …"; ADM:1170 `requests.markedDone` „Märgitud tehtuks.“

### S3-P3-d — UndoBar for a removed list row in the course editor  [named in S3]
- Screen: B2 list editors (README §3 B2: outcomes, protocol points, gallery, test questions; the same editor components also serve „Koolitus sisaldab“ and the certificate lines).
- When: she removes a row; a client-side restore puts it back at its place (BEH B5). Question ids of a test question come back unchanged.
- Draft (the noun says what went; no name, as drawn):
  - outcomes, includes, protocol points, certificate lines: `Rida eemaldatud.`
  - a test question: `Küsimus eemaldatud.`
  - an answer option of a question: `Vastusevariant eemaldatud.`
  - a gallery picture: `Pilt eemaldatud.` (drawn, P1:356)
- Piece 4 reuses these for slides, FAQ rows, practice points and the trainer gallery (SPEC S3 names "list-row removals" once); asking only the C-specific nouns then.
- Reference strings: P1:356; ADM:1461 `list.remove` "Eemalda rida {n}"; ADM:1622 `testRemove` "Eemalda küsimus {n}"; ADM:1617 `testOptionRemove`; ADM:1641 `imageRemove` "Eemalda pilt {n}".

### S3-P3-e — „Töötlemisel {n}%“ when Bunny gives no encode progress  [S6]
- Screen: B2 lesson rows (the video tag) and the lesson drawer's video row.
- When: the video is `processing` and the progress is unknown or still 0. Bunny's video record has an encode progress; the code does not read it today (`server/bunny.ts`; SCR §5 F13). So the percent shows only when a real figure exists.
- Placeholders: {n} 0–100.
- Draft:
  - row tag: `Töötlemisel` (the same tag without the number)
  - drawer: the existing `Töötlemisel…` and a bar that only moves (indeterminate); the phone line „Võid lehelt lahkuda — töötlemine jätkub.“ (drawn, P4:76) shows in both cases.
- Reference strings: P3:345 "Töötlemisel 72%"; P4:76 "Töötlemisel 75%"; ADM:1750 `lessons.video.processing` "Töötlemisel…"; ADM:1690 `videoTag.processing`.

### S3-P3-f — „Kustuta mustand“ (a newsletter draft)  [named in S3, B17]
- Screen: B5 Kirjad, the editor, a letter whose status is „Mustand“ (README §3 B5; a sent or sending letter has no such button).
- When: she presses „Kustuta mustand“ (a danger button under the fields, P3:248). A ConfirmPanel opens in its place.
- Placeholders: {nimi} the letter's name („Jõulupakkumine“).
- Draft:
  - question: `Kas kustutan mustandi „{nimi}“?`
  - line: `Seda ei saa tagasi võtta.`
  - buttons: `Jah, kustuta` / `Katkesta`
  - result, in the list after the draft is gone (on the phone: back on the list screen): `Mustand kustutatud.`
  - refused because the letter was sent meanwhile (another tab): the existing sentence, reworded to „kiri“: `See kiri on juba saadetud.`
- Reference strings: P1:342 "Kas saadan kirja „Jõulupakkumine“?" (the name in quotes); ADM:2152 `post.remove.confirm` "Kas kustutan selle postituse? Seda ei saa tagasi võtta."; ADM:2122 `news.deleted` "Postitus kustutatud."; ADM:1722 `lessons.drawer.deleteConfirm` „Kas kustutan õppetunni „{title}“ …?“

### S3-P3-g — A new record before it exists (Kalender `?id=uus`, the new-course page)  [P2T §5]
- Screen: B3 drawer `?id=uus` ("Lisa toimumine") and `/admin/koolitused/uus` ("Lisa koolitus"). Both stay explicit creates (README §3 B3, P1 §3.1); after the create the item autosaves.
- Written: until the record exists the header shows „Täida kohustuslikud väljad“ instead of a save status (P1:248).
- Unwritten: (1) what the header says once every required field is filled but nothing is created yet; (2) what happens when she closes the drawer or leaves the page with text typed and nothing created. The leave guard watches only autosaving fields, so as built from the design the typed text is lost without a word (today's behaviour).
- Placeholders: {nupp} the create button's label („Lisa toimumine“, „Lisa koolitus“); {asja} the thing in the partitive („toimumist“, „koolitust“).
- Draft:
  1. empty required field: `Täida kohustuslikud väljad` (as written)
  2. all required fields valid: `Vajuta „{nupp}“.` — e.g. `Vajuta „Lisa toimumine“.` (Or keep the written line until the create; then this line is dropped.)
  3. leaving with typed text: the leave notice of piece 1 (ADM:199-201, „Jää siia“ / „Sulge, tekst jääb seadmesse“) with the reason `{Asja} pole veel lisatud.` — `Toimumist pole veel lisatud.` / `Koolitust pole veel lisatud.` (If Dim does not want a guard here, line 3 is dropped and nothing else changes.)
- Required fields: Kalender: Koolitus, Kuupäev, Linn (Algus 10:00, Kohti 4 and Keel ET come pre-filled; the existing field errors, ADM:17-18, 1800). Course: Koolituse nimi (ET).
- Reference strings: P1:248; ADM:199-208 `leave.*`; ADM:1790 `calendar.drawer.newLabel` "Uus toimumine"; ADM:1807 `calendar.form.create` "Lisa toimumine"; ADM:1519 `courses.add` "Lisa koolitus".

### S3-P3-h — „Uus kiri +“: does it make the draft at once?  [gap]
- Screen: B5 Kirjad, the list's button „Uus kiri +“ (README §3 B5; the rename of „Uus kampaania“, ADM:1857).
- The design lists „Lisa toimumine“, „Lisa õpilane“, „Lisa koolitus +“, „Lisa postitus +“ as explicit creates (P1 §3.1) but not „Uus kiri +“. For a post it draws creation at once with the title „Uus postitus“ (P4, C3 note). A letter needs a name (the field „Nimi“, internal; ADM:1865-1866), and „Kustuta mustand“ (B17) exists for stray empty drafts.
- Recommendation (cheapest, one tap): the button makes a draft named **`Uus kiri`**, opens it and puts the cursor in „Nimi“. The list shows `Uus kiri` over `Mustand · muudetud {dd.mm hh:mm}`.
- Alternative: a blank form with an explicit button `Lisa kiri` and the header of S3-P3-g (`Täida kohustuslikud väljad`).
- Reference strings: ADM:1862 `newTitle` "Uus kampaania" (becomes „Uus kiri“, P-12); ADM:2129 `post.newTitle` "Uus postitus"; P3:239 "Mustand · muudetud 20.10 20:35".

### S3-P3-i — Kalender: the „Koolitus“ select is disabled once someone is booked  [gap]
- Screen: B3 drawer, field „Koolitus“ (README §3 B3: "„Koolitus“ is disabled once anyone is booked").
- The design draws no reason. Its own rule (P1 §3.3 "Refuse early") puts the reason where the control would be.
- Draft (under the select): `Toimumisel on registreeringuid, seega koolitust muuta ei saa.`
- Reference strings: ADM:21 `typeLocked` "Sellel koolitusel on toimumisi või registreerimisi, seega õppevormi muuta ei saa. …"; ADM:1659 `typeLockedOnline`; P3:168 (the refuse-early text under the status).

### S3-P3-j — Kontaktkoolituse leping: the „Avalda uus leping“ ConfirmPanel  [partly written, D13]
- Screen: B4 Seaded → Lepingud ja tingimused → Kontaktkoolituse leping, after „Avalda uus leping“. The e-course panel is drawn (P3:207); for the contact contract the README gives only the note „kehtib uutele registreeringutele“ (README §3 B4). The spec also asks a "tighter" spacing for this panel (LEDGER); that is style, no text.
- Why the e-course lines do not fit: "Vana leping jääb alles ja märgitakse asendatuks." is true for an e-course (everyone re-accepts) but not here; a contact contract is replaced only when Maria sends „Saada leping kinnitamiseks“ (ADM:720).
- Draft:
  - question: `Kas avaldan uue kontaktkoolituse lepingu?`
  - lines: `Uus tekst kehtib uutele registreeringutele.` · `Varem kinnitatud lepingud jäävad selliseks, nagu need kinnitati.`
  - buttons: `Jah, avalda` / `Katkesta`
- For comparison, the e-course panel as drawn: `Kas avaldan uue e-koolituse lepingu?` · `{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.` · `Vana leping jääb alles ja märgitakse asendatuks.` · `Jah, avalda` / `Katkesta` (n = 1 and n = 0: P-8).
- Reference strings: P3:207; ADM:756 `contracts.settings.lead` "Kinnitatud leping jääb selliseks, nagu see kinnitati: hilisem muudatus puudutab ainult uusi lepinguid."; ADM:720 `block.requestHint`.

### S3-P3-k — Privaatsus and Õppetingimused: how they are published  [gap]
- Screen: B4 Seaded → Lepingud ja tingimused. README §3 B4 puts all four texts on the draft layer with the tag „Avaldamata muudatus“ and the button „Avalda uus leping“. Privaatsus is not a contract, and Õppetingimused is the public study-terms page that acts as the contact contract while „Kontaktkoolituse leping“ is empty (BEH, Contract texts; ADM:756). No student is asked to accept either again.
- Draft:
  - button: `Avalda uus tekst` (tag as drawn: `Avaldamata muudatus`)
  - Privaatsus: question `Kas avaldan lehe „Privaatsus“ uue teksti?` · line `Uus tekst on avalikul lehel kohe näha.`
  - Õppetingimused: question `Kas avaldan lehe „Õppetingimused“ uue teksti?` · lines `Uus tekst on avalikul lehel kohe näha.` · `Kuni „Kontaktkoolituse leping“ on tühi, kehtib see tekst uutele registreeringutele lepinguna.` (the second line only while the contract text is empty)
  - buttons: `Jah, avalda` / `Katkesta`
- If Dim would rather keep „Avalda uus leping“ for all four, the Privaatsus question changes to „Kas avaldan uue privaatsuspoliitika?“ — say so.
- Reference strings: P3:204-207; ADM:2222-2223 `settings.privacy`, `settings.terms`; ADM:756.

### S3-P3-l — Uudiskiri: sending while the letter has text that is not saved yet  [gap]
- Screen: B5 Saatmine, "Saada proov" and "Saada kõigile ({n})". The design says "Sends use the last saved version" (P3, B5 note) and C4 (SPEC §6) flushes before the press. When the flush cannot go through (offline, signed out, a held invalid field), the press would send an older text than the screen shows.
- Rule (refuse early): the two buttons are not offered and the reason stands where they would be.
- Placeholders: none.
- Draft: `Saatmiseks peab kiri olema salvestatud.` + the leave guard's reason sentence for the case (ADM:203-207): `Ühendus puudub. Proovin uuesti, kuni jääd siia.` · `Üks väli vajab parandamist.` · `Logi uuesti sisse.` · `Salvestamine ei õnnestunud.`
- Reference strings: ADM:202-208 `leave.reasons`; ADM:1892 `saveFirst` "Salvesta muudatused enne saatmist." (the old rule this replaces); ADM:1952 `errorsOf.empty` (another refuse-early reason in the same card).

### S3-P3-m — Drag handles and the announcement after a move (screen readers)  [gap]
- Screen: B1 rows, B2 module rows and list-editor rows, B1 phone move menu. README gives `aria-roledescription="lohistatav"` and the phone menu items, nothing for the handle's name or for what is announced after a drop or an ↑/↓.
- Placeholders: {nimi} the course or module name; {n} a row's number; {k} the new place.
- Draft:
  - handle name: `Lohista: {nimi}` (rows of a list: `Lohista rida {n}`)
  - after a move by drag, ↑/↓ or the phone menu: `„{nimi}“ on nüüd {k}. kohal.` (rows: `Rida {n} on nüüd {k}. kohal.`)
- Reference strings: ADM:1531 `courses.moveUp` "Liiguta üles: {name}"; ADM:1462 `list.up` "Liiguta rida {n} üles"; README §3 B1 (`lohistatav`); P4:46 (the „↕“ button).

### Dim 24.10 — answers while 3a was being built

- **D-1 Preview exit.** The public preview bar's exit link reads `Lõpeta eelvaade` (it turns draft mode off and shows the same page as visitors see it). The admin shell's own `Vaata kodulehte` stays.
- **D-2 Failure lines, per action.** A failed „Avalda muudatused“: `Avaldamine ei õnnestunud. Proovi uuesti.` A failed „Loobu muudatustest“: `Muudatustest loobumine ei õnnestunud. Proovi uuesti.` On the editor's PublishBar and on the preview bar. An expired session still says `Logi uuesti sisse.`
- **D-3 Switch label.** The „Avaldamine“ card's switches are `Avalikul lehel` and `Näidissisu`, as drawn (Part 3, Part 4), with no hints.
- **D-4 Catalogue in the preview.** `/koolitused` gets a slim bar in the admin's preview only: `Eelvaade` · `Lõpeta eelvaade`, no discard (discarding stays per course). Visitors keep the static page.

---

## 2. P — pattern-derived (builder uses these unless Dim objects)

Each rests on a drawn text or an existing string; no new choice of words.

- **P-1 B1 Koolitused list.**
  - Empty list `Koolitusi veel pole.` (ADM:1534 = the shared frame `lists.empty`, ADM:1470); a filter with no hit uses the shared `Selle valikuga koolitusi pole.` + „Tühjenda otsing ja filtrid“ (ADM:1471-1474), replacing „Selle õppevormiga koolitusi pole.“ (ADM:1535). Count line `Koolitusi: {n}` (ADM:1536).
  - The phone „↕“ button's name: `Liiguta: {nimi}` (cf. ADM:1531). The menu items are drawn („Üles“, „Alla“, „Esimeseks“, „Viimaseks“, P4 note); the first row's „Üles“/„Esimeseks“ and the last row's „Alla“/„Viimaseks“ are aria-disabled, no text.
  - A drop that fails: the list snaps back and says the existing `Järjekorra muutmine ei õnnestunud. Proovi uuesti.` (ADM:1533).
- **P-2 SaveStatus „gone“ words** (as P2T P-10; `{thing}` in „Seda {thing} enam ei ole. Tekst on selles seadmes alles.“, ADM:191): course editor `koolitust` (ADM:1547 "Seda koolitust ei leitud."); lesson drawer `õppetundi`; Kalender drawer `toimumist` (ADM:1792); a letter `kirja` (ADM:1861). Seaded has no „gone“ state. Cf. ADM:833 `registreeringut`, ADM:913 `ligipääsu`, ADM:1013 `katset`.
- **P-3 PublishBar labels of a course** (README: "the changed field labels"; drawn: „Lühikirjeldus, Hind, Moodul 03“).
  - A field: its visible label without a unit in brackets — „Hind (€)“ (ADM:1575) shows as `Hind`, „Ligipääs (kuud)“ as `Ligipääs`, „Grupikoolituse hind (€)“ as `Grupikoolituse hind`; a list or a card: its card title (ADM:1549-1560).
  - A change inside a module (its name, its lessons, a new or removed lesson, the lessons' order): `Moodul {nn}` (drawn). Moving modules: `Moodulite järjekord` (the one new phrase). A contact course's programme: `Programm` (ADM:1553).
  - A new lesson row on a published course carries the tag `avaldamata`, as the drawn module 03 does (P3:345; SPEC S2).
- **P-4 Video tags on lesson rows** (drawn: „Valmis“, „Töötlemisel {n}%“, „Video puudub“, „Tekst“). The two states the mock does not draw keep their words: uploading `Video üleslaadimisel`, failed `Video viga` (ADM:1690). The module's summary: `{n} moodulit · {m} õppetundi` (drawn); with one: `1 moodul`, `1 õppetund` (P-8); none: the existing `Mooduleid veel pole.` (ADM:1670) in place of the summary.
- **P-5 Hints that name the removed Save button** (autosave and the draft layer make them untrue; B screens only):
  - ADM:1574 `typeHint`: "… Teise õppevormi väljad eemaldatakse salvestamisel." → `… Õppevormi vahetamisel eemaldatakse teise õppevormi väljad.` (the type changes at once, README B2)
  - ADM:1501 `badge.lead`: "… pärast salvestamist on muudatus kohe näha koolituste lehel." → `… muudatus on koolituste lehel näha pärast avaldamist.`
  - ADM:2226 `courseTermsLead`: "Kui salvestad muudetud teksti, peab iga õpilane uuesti nõustuma." → `Kui avaldad muudetud teksti, peab iga õpilane uuesti nõustuma.`
  - ADM:776 `contracts.settings.sampleHint`: → `Näidis tehakse kaardi praegustest väärtustest, ka avaldamata. Midagi ei avaldata.`; ADM:673 `invoices.settings.sampleHint`: → `Näidis tehakse kaardi praegustest väärtustest. Midagi ei salvestata.`
  - ADM:1669 `lessons.saveFirst` "Salvesta koolitus, et lisada mooduleid." (shown on the new-course page, before the course exists) → `Vajuta „Lisa koolitus“, et lisada mooduleid.`
  - The home and practice leads (ADM:2000, 2064) are piece 4.
- **P-6 New-course page** (`/admin/koolitused/uus`): H1 `Uus koolitus` (ADM:1544); the create button `Lisa koolitus` (ADM:1519; the label of the list button without its „+“); after the create the existing `Koolitus loodud. Lisa pildid ja avalda, kui kõik on valmis.` (ADM:1545). The header text is S3-P3-g.
- **P-7 Kalender.**
  - List: the course select's „all“ option `Kõik koolitused` (ADM:1060; the Registreerimised one is longer, ADM:280) and the city select's `Kõik linnad`; the selects' names `Koolitus` / `Linn` (ADM:1795, 1799); the phone shows the pill `Linn ▾` (drawn). Count `Toimumisi: {n}`; empty `Tulevasi toimumisi pole.` / `Möödunud toimumisi pole.` (ADM:1784-1785); with a course or city chosen the shared `Selle valikuga toimumisi pole.` + „Tühjenda otsing ja filtrid“. Button `Lisa toimumine +` (ADM:1770).
  - Phone card (P4:91, P4:401): the day over the month from the same Intl names the app uses (drawn „dets“, „veebr“); second line `{linn} · {koht}`, for a cancelled session `{linn} · tühistatud` (drawn); the seat figure `{k}/{cap}`.
  - Drawer header `{dd.mm.yyyy} · {linn} · {k}/{cap} kinnitatud · ootenimekirjas {n}`: the last part is left out at 0 (as the list does, `kalender/page.tsx:207`); the phone's short form is drawn (`… · 4/4 · ootel 2`).
  - Deleting a session without registrations keeps its confirmation, split as in P2T P-13: `Kas kustutan selle toimumise?` · `Seda ei saa tagasi võtta.` · `Jah, kustuta` / `Katkesta` (ADM:1814-1816).
- **P-8 n = 1 and n = 0 forms** (the design writes only the plural; Estonian takes the nominative after 1, as P2T S3-l did for „1 arve“):
  - B3 notice: `{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.` → n = 1: `1 õpilane on registreerunud. Muudatusest talle kirja ei saadeta.`
  - B3 hint `Muudetud — teavita {n} õpilast ise.` — the same for n = 1.
  - B3 cancel panel: `Kas tühistan toimumise? {n} registreeringut jäävad alles; teavita õpilasi ise.` → n = 1: `Kas tühistan toimumise? 1 registreering jääb alles; teavita õpilast ise.`
  - B4 e-course panel: `{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.` → n = 1: `1 aktiivne õpilane peab selle järgmisel sisselogimisel uuesti kinnitama.`; n = 0: the line is left out (each ConfirmPanel line shows only when true).
  - B5 send panel: `{n} kinnitatud tellijat` → n = 1: `1 kinnitatud tellija`; `Jah, saada {n} tellijale` is right for any n.
  - B5 stop panel: `Veel saatmata {n} kirja ei lähe välja.` → n = 1: `Veel saatmata 1 kiri ei lähe välja.`
- **P-9 Seaded: the cards are renamed, so texts that point at them follow** (six existing or approved texts change one name; Dim approved S3-c of P2T with „Arve andmed“ on 22.10, so this edits approved text):
  - ADM:351 `needSellerLink`, ADM:461 and ADM:605 `needSeller`: `Seaded → Arve andmed` → `Seaded → Maksmine`
  - ADM:565 `sellerMissing`: `Täida enne Seaded → „Arve andmed“.` → `Täida enne Seaded → „Maksmine“.`
  - ADM:566 `bankMissing`: `Täida enne Seaded → „Ettemaksu juhised“ (saaja ja IBAN).` → `Täida enne Seaded → „Maksmine“ (saaja ja IBAN).`
  - ADM:666 `settings.bankMissing`: `Ettemaksu juhised on täitmata (saaja ja IBAN): pangaülekande arvet ei saa koostada.` → `Saaja ja IBAN on täitmata: pangaülekande arvet ei saa koostada.`
  - The merged card „Maksmine“: lead as drawn, `Ühed pangaandmed ettemaksu juhistes ja arvetel.`, then the existing ADM:640 sentence `Väljastatud arve jääb selliseks, nagu see väljastati: hilisem muudatus puudutab ainult uusi arveid.` (it also says the frozen IBAN, BEH "Server-side changes" 4) and the existing ADM:2216 hint under Saaja and IBAN. `bankLead` and `bankLink` (ADM:664-665) go; the old card titles „Arve andmed“ (ADM:639) and „Ettemaksu juhised“ (ADM:2214) go.
- **P-10 Seaded number lines.**
  - Label in the Maksmine card: `Arve järgmine number` (drawn); the Tunnistus card keeps `Järgmine number` (ADM:1352; D6: certificates unchanged, its „Aasta“ field stays).
  - Preview under the field: `Järgmine arve: {prefix}{year}-{nnn}` (drawn: „Järgmine arve: MSL2026-007“); `Järgmine tunnistus: MS LAB {year}-{nn}` (the number is printed with two digits, as in P3 note "MS LAB 2026-93").
  - From 1 December the phone mock joins the two: `Järgmine arve: MSL2026-007 · 1. jaanuarist: MSL2027-001`; the second part is the existing ADM:655 `fromJanuary`, so desktop reads the same.
- **P-11 Contract texts: the words around the panels** (tag, button and e-course panel are drawn; S3-P3-j and -k give the other panels).
  - Section map status: `{n} avaldamata` (drawn: „1 avaldamata“); the card tag `Avaldamata muudatus`, the phone's `Avaldamata` (drawn).
  - After „Jah, avalda“: `Uus e-koolituse leping on avaldatud.` / `Uus kontaktkoolituse leping on avaldatud.` / `Uus tekst on avaldatud.` (cf. ADM:1788 `calendar.deleted`).
  - Refused because the live text changed meanwhile: `Seda teksti muudeti vahepeal teises aknas. Vaata see üle.` (P2T W7 shape).
  - The card for the e-course contract is named `E-koolituse leping` (STR W19, not „… (tingimused)“, ADM:2224).
- **P-12 B5 „kampaania“ → „kiri“** (STR B5-7: no wording given; the word „kampaania“ stays for the popup only, README §1.11). Before → after:
  - ADM:1845 `views.campaigns`, ADM:1854 `title`, ADM:1856 `list`: `Kampaaniad` → `Kirjad`; ADM:1857 `new` → `Uus kiri` (the „+“ is the component's); ADM:1862 `newTitle` → `Uus kiri`; ADM:1864 `form` → `Kiri`
  - ADM:1858 `empty`: `Kampaaniaid veel pole.` → `Kirju veel pole.`
  - ADM:1861 and ADM:1947 `notFound`: `Seda kampaaniat enam pole.` → `Seda kirja enam pole.`
  - ADM:1915 `done`: `Kampaania on saadetud.` → `Kiri on saadetud.`
  - ADM:1936 `readOnly`: `Saadetud kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.`; ADM:1937: `Pooleli kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.`
  - ADM:1948 `sent`: `See kiri on juba saadetud.`; ADM:1953 `notSending`: `Selle kirja saatmine ei ole pooleli.`
  - ADM:1950 `busy` is written: `Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.`
  - ADM:1951 `changed`: `Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“.`
  - ADM:1910 `all.confirm` is replaced by the panel of P-13; ADM:1892 `saveFirst` goes.
- **P-13 B5: list rows, the send panel, Tellijad.**
  - List row, second line: draft `Mustand · muudetud {dd.mm hh:mm}`, sent `Saadetud {dd.mm} · {n} tellijale` (both drawn); a letter that is going out `Saatmine pooleli · {sent} / {n}` (ADM:1859, ADM:1922).
  - Send-all panel (STR D16 ruled the P1 mock): question `Kas saadan kirja „{nimi}“?` · `{n} kinnitatud tellijat: {a} eesti, {b} vene keeles.` · `Näidisaadressidele (@example.test) ei saadeta.` · `Saadetud kirja ei saa tagasi võtta ega muuta.` · `Jah, saada {n} tellijale` / `Katkesta`. Variants: only one language: `{a} eesti keeles.` / `{b} vene keeles.`; the sample line only when a sample address is among the confirmed; when n is more than the day's room (70) one more line, the existing sentence of ADM:1907 `Päevas läheb välja nii palju kirju, kui mahub; ülejäänud lähevad järgmisel päeval.`; the existing gate notice (ADM:1919) stays under the panel while the site gate is on. At n = 0 the button is replaced by the existing `Kinnitatud tellijaid pole: kirja pole kellelegi saata.` (ADM:1952).
  - The hint under the buttons: `{a} eesti, {b} vene keeles · näidisaadressidele ei saadeta` (drawn), a zero part and the sample part left out when empty.
  - „Peata saatmine“, split as P2T P-13: `Kas peatan saatmise?` · `Veel saatmata {n} kirja ei lähe välja.` · `Seda ei saa tagasi võtta.` · `Jah, peata` / `Katkesta` (ADM:1928-1930).
  - Tellijad: search placeholder `Otsi e-posti järgi` (README: "address search"; the column is „E-post“, ADM:1828; same family as `Otsi nime, e-posti või telefoni järgi`, ADM:279); empty `Tellijaid veel pole.` (ADM:1830) and the shared `Selle valikuga tellijaid pole.`; „Laadi alla (CSV)“ names its file after the filter: `mslab-uudiskiri` (all), `mslab-uudiskiri-kinnitatud`, `mslab-uudiskiri-ootab-kinnitust` (ADM:1834-1835).

## 3. Reuse as-is (no text to add)

Written in the design, used verbatim:
- **B1:** the note „Järjekord on sama mis avalikul lehel. Lohista ⋮⋮ või kasuta nooli.“ and, in a filtered view, the hint „Järjekorda saab muuta vaates „Kõik“.“; `lohistatav`; the status „Avaldamata muudatused“; price lines „Grupp 350 €“ / „Individuaal 450 €“; the phone's „Kontakt“ (STR W15).
- **B2:** „← Koolitused“; „Jaotised ▾“ (phone „Jaotised · Põhiinfo ▾“); the section-map values (a count, „RU puudub“, „Kontrolli“); „+ Lisa moodul“; „Kas kustutan punkti „{title}“?“; „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“; „Kas kustutan õppetunni „{nimi}“ koos video ja failidega?“ / „Jah, kustuta“ / „Katkesta“; „Moodul {nn} · Õppetund {n.n}“; „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“; phone „Vali fail“; „Õpilastele nähtav“ with the existing hint (ADM:1723); „Võid lehelt lahkuda — töötlemine jätkub.“; the publish bar (ADM:215-224).
- **B3:** all of README §3 B3 and P3:161-168: the notice, „Muudetud — teavita {n} õpilast ise.“, „Kinnitatud on {n} — kohti ei saa olla vähem.“, „Kas tühistan toimumise? …“, „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ (STR D12), „Algus (Eesti aeg)“, „Protokollid“.
- **B4:** the section names, „Ühed pangaandmed …“, „Avaldamata muudatus“, „Avalda uus leping“, the e-course panel (STR D13), the chips „+ nimi“ … „+ ettemaks“, phone „Pikk tekst avaneb täisekraanil.“ / „Muuda teksti“, „1. jaanuarist: {number}“ (built in piece 1, ADM:655).
- **B5:** „Tellijad“ | „Kirjad“, „Uus kiri +“, „Saada proov“, „Saada kõigile ({n})“, the select line „{aadress} · {eesti|vene keeles}“ (phone „Saada proov · maria@… · ET“), „Laadi alla (CSV)“, the pills „Kinnitatud 14“ / „Ootab kinnitust 5“.
Existing and unchanged:
- `courseEditor.created` (ADM:1545), `calendar.added` / `deleted` / `drawer.notFound` (ADM:1787-1792), `calendar.form.statusHint` (ADM:1806), `lessons.errors.*` (ADM:1691-1697), `lessons.files.*` and `lessons.video.*` states (ADM:1725-1762), the placeholder meanings that become the chips' titles (ADM:761-768), `newsletter.campaigns.test.sent`, `progress`, `failedLine`, `unknownLine`, `gateNotice`, `errorsOf.limited` / `mail` / `address` / `refused` (ADM:1903, 1919-1925, 1954-1957), `campaigns.preview*` (ADM:1884-1889), the Tellijad lead (ADM:1824).
- Page eyebrows: B1 „Kontaktõpe ja e-õpe“, B3 „Kontaktõpe“, B4 „Seaded“, B5 „Uudiskiri“ (ADM:1516, 1767, 2196, 1822). The Tellijad view keeps its title „Uudiskirja tellijad“ (ADM:1823); only the Kirjad view is drawn with H1 „Kirjad“.

## 4. Builder defaults that add no text (confirm in passing; not S3)

- **B1:** the „Muudetud“ column goes (README lists no such column); the „Näidis“ tag of prototype content stays beside the status pill (ADM:1527, not drawn); the lead (ADM:1518) is replaced by the drawn note.
- **Section map counts (B2):** a count shows on the cards that hold a list (outcomes, modules, gallery, recommendations, test questions); the mock's „1“ on „Õppevorm ja hind“ and „Moodulid“ is read as sample data (the modules card itself says 6).
- **New module, lesson, programme point:** the existing name field above „Lisa moodul“ / „Lisa õppetund“ / „Lisa punkt“ stays (ADM:1672-1675, 1684-1685); no placeholder title like „Uus moodul“ is invented, and an empty name is `Puudub: …` at publish (S3-P3-b).
- **Publish and discard (B2):** no result line. After „Avalda muudatused“ the bar disappears and the chip changes from „Mustand salvestatud“ to „Salvestatud {time}“; after „Loobu muudatustest“ the fields show the live text.
- **Kalender:** the date and time hint only on those two fields, as drawn (Linn and Toimumiskoht do not get it); „Kohti“ commits on blur (BEH item 1); the notice shows only when registrations exist.
- **Seaded:** the Järelmaks (Inbank) card, built after the design (ADM:1416), sits in „Maksmine“ with its own title; its switch autosaves and loses „Salvesta“ (ADM:1421); the page lead (ADM:2198) is dropped, the design draws none; the number fields commit on blur (BEH item 5). The Maksmine number field keeps „Viimati väljastatud …“ (ADM:656-658) and drops the long hint ADM:653, which the preview line replaces.
- **Contract texts:** no discard control (none is drawn): typing the live text back removes the tag; the phone's full-screen editor is the shared Drawer (✕ „Sulge“). The panel's tighter spacing (P3:207 against the shared ConfirmPanel) is a per-screen style (LEDGER).
- **Tellijad:** the two pills are drawn without „Kõik“: everyone is listed until a pill is pressed, a pressed pill toggles off. If Dim wants „Kõik 19“ as on every other list, it is one word.
- **B5 editor:** the page's LangSwitch (README §1.9) sits in the editor's header although the mock omits it; the fields „Nimi“ and „Pilt“, which the mock omits, stay; the preview follows the switch (LEDGER, T12).
- **Lessons:** the drawer has no ET | RU switch (Dim 22.10); a lesson file's undo failing falls back to ADM:162.

## 5. Later pieces (do not ask now)

Piece 4 (C screens):
- C2 trainer gallery counter „4 / 12“ against the limit 24 (STR D25, "ASK DIM"); the shared gallery component is touched in piece 3, but it keeps its existing hint (ADM:1635) and shows no counter until Dim answers.
- UndoBar nouns for slides and FAQ rows (the generic `Rida eemaldatud.` and `Pilt eemaldatud.` come from S3-P3-d), and the review bars of C6 („Arvustus avaldatud.“ is drawn; the „Peida“ one is not).
- C3: the post-specific required-field labels for `Puudub: …` (the shape is S3-P3-b), „Uus postitus“ with its slug (SPEC S8), `post.remove.confirm` re-skin.
- PublishBar field labels of the home, trainer, news, popup and practice editors (the rules are P-3).
- C4 popup texts (SPEC D3) and the rules line that names „Seaded → Tervituskood“ (ADM:2168); C8 sign-in (written; S4); the C-screen leads that mention saving (ADM:2000, 2064).
- C6 „Lisa arvustus +“ drawer, a new-record drawer: it uses the header of S3-P3-g.
