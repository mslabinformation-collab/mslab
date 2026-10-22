# Admin UX pass, piece 2 — texts the design leaves unwritten (APPROVED)

**Dim approved all drafts below on 22.10.2026 ("OK"), with these answers:**
- S3-e „Muu summa“ above what is left: **refuse** (field error, nothing added).
- „Pikenda“ +1 kuu / +3 kuud / +6 kuud counts from **the later of the current end and today**; „Pikenda“ is hidden on an access an admin ended (the „Ava ligipääs e-koolitusele“ fold re-opens it).
- Section 2 (pattern-derived lines) and section 4 (builder defaults) stand as written.
- Maksed „Montonios ↗“: Montonio has no page for one order, so the link opens the Partner System and copies the order id; the confirm line is **„Montonio id kopeeritud.“** (Dim 22.10).

The builder uses these texts verbatim. Section 5 lists texts for later pieces: they are still to be asked.


Admin text is Estonian only (README.md:3, "Admin text stays Estonian"; no admin RU dictionary: `adminEt` only). RU is proposed for one item (S3-k), because that text leaves the admin in a mail to the requester.

Short names for the references:
- ADM = `app/src/i18n/dict/admin.ts`; ET/RU = `app/src/i18n/dict/et.ts` / `ru.ts`
- README = `docs/superpowers/specs/admin-ux-pass/handoff/README.md`
- P1 / P2 = `docs/superpowers/specs/admin-ux-pass/handoff/MS LAB Admin UX Pass.dc.html` / `… - Part 2.dc.html`
- SPEC = `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`; STR / BEH = `…/admin-ux-pass/analysis/strings.md` / `behaviours.md`

House style read from nearby strings: result lines end with a full stop, labels and buttons do not; „…“ quotes for names of buttons, fields and titles; sentence case; parts joined by " · "; the long dash " — " with spaces; "145 €"; dates `dd.mm.yyyy`; informal "sa/sinu"; question → plain consequence lines → „Jah, {tegusõna}“ / „Katkesta“.

## Counts

- **13 items to put to Dim for piece 2** (S3-a … S3-m).
  - Of these, 5 are places the spec's S3 names: S3-a, S3-b, S3-c („Lisa laekumine“ results), S3-h (access that ran out), S3-j (facts lines).
  - 1 is an item STR marks "ASK DIM" for A6 (S3-m, STR D8). The other 7 are gaps found while checking the screens against the code.
- 14 more lines are pattern-derived (section P): the builder uses them unless Dim objects.
- Already approved in piece 1 and excluded: the 4 badge labels (`shell.badgeFeedback` "{n} arvustust ootab", `badgePayments` "{n} vajab kontrolli", `badgeTesting` "{n} viga", `badgeToday` "Täna on koolituspäev", ADM:111-116) and the 4 leave-guard reasons (`leave.reasons.error`, `invalid`, `signedOut`, `upload`, ADM:195-206; SPEC:217). So S3's "screen-reader labels of the new badges" is NOT a piece-2 item.

---

## 1. Ask Dim (piece 2)

### S3-a — „Lisa laekumine“: result when the payment stays under 50 %  [named in S3]
- Screen: A2 Registreerimised drawer → Raha → panel „Lisa laekumine“ (README.md:156-162).
- When: right after submit, if the received total after this payment is still below half the price (the status stays „Ootab ettemaksu“). The submit button then has no suffix („Lisa {summa}“, README.md:161).
- Placeholders: {x} the added amount ("100 €"), {nr} the receipt number, {pool} the 50 % amount ("145 €").
- Draft (receipt made): `{x} lisatud · kviitung {nr}. Koht kinnitub {pool} juures.`
  - e.g. "100 € lisatud · kviitung MSL2026-005. Koht kinnitub 145 € juures."
  - If the registration was already „Kinnitatud“ before this payment (Maria's override, or earlier money), the ending is dropped: `{x} lisatud · kviitung {nr}.`
- Reference strings:
  - P2:215 "145 € lisatud · kviitung MSL2026-005 · koht kinnitatud." (the ≥ 50 % line)
  - P2:154 / README.md:154 "Koht kinnitub 145 € juures · vabu kohti 2 / 4" (the ending reuses the Raha card's own words)
  - ADM:269 "Koht on kinnitatud, kui laekunud on vähemalt 50% koolituse hinnast."

### S3-b — „Lisa laekumine“: result when no receipt is made  [named in S3]
- Screen/when: same panel, checkbox „Koosta kviitung“ unticked. Same placeholders, no {nr}.
- Draft:
  - reaches 50 %, seat taken: `{x} lisatud · koht kinnitatud.`
  - stays under 50 %: `{x} lisatud. Koht kinnitub {pool} juures.`
  - already confirmed before: `{x} lisatud.`
  - seat full: the drawn line, unchanged: `{x} lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.`
  - seat full with a receipt (the drawn line has no receipt part): `{x} lisatud · kviitung {nr}. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.`
- Reference strings:
  - P2:214 "145 € lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata."
  - ADM:433 `invoices.row.paidPanel.full` "Koolitus on vahepeal täis, nii et koht jäi kinnitamata."
  - README.md:162 "Messages: „{x} € lisatud · kviitung {nr} · koht kinnitatud.“ or „… Koolitus on vahepeal täis …“"

### S3-c — „Lisa laekumine“: seller data missing  [named in S3]
- Screen: same panel.
- When: Seaded → Arve andmed has no seller (`sellerReady` false). It shows in place of the checkbox „Koosta kviitung (arve „Juba tasutud“)“, which is off by default only when seller data exists (README.md:160). A receipt needs the seller only, not the bank details.
- Draft (link on „Seaded → Arve andmed“): `Kviitungit ei saa koostada: täida Seaded → Arve andmed.`
  - The money is added with no receipt, so the result is one of the S3-b lines.
  - If the seller data goes missing between opening the panel and pressing submit, reuse the refusal `Täida enne Seaded → „Arve andmed“.` (nothing recorded).
- Reference strings:
  - ADM:380 `invoices.block.needSeller` "Täida Seaded → Arve andmed"
  - ADM:467 `invoices.errors.sellerMissing` "Täida enne Seaded → „Arve andmed“."
  - ADM:538 `invoices.settings.bankMissing` "… pangaülekande arvet ei saa koostada."

### S3-d — „Lisa laekumine“ on a registration without a session  [gap]
- Screen/when: A2 Raha card of an individual contact registration („Aeg kokkuleppel“, ADM:292) or an e-learning registration: no seats to show, so "Koht kinnitub … · vabu kohti x / cap" cannot be drawn as is.
- Draft: Raha line `Registreering kinnitub {pool} juures`; submit suffix ` · registreering kinnitub`; result ending ` · registreering kinnitatud.` There is no seat-full variant.
- Reference strings: README.md:154; ADM:292 "Aeg kokkuleppel"; ADM:269.

### S3-e — „Muu summa“ above what is left  [gap]
- Screen/when: same panel, the typed amount is more than price − received. The design says R19 (typed overcharge) is "resolved" but draws no text. BEH:283: "„Muu summa“ needs a cap or a warning".
- Draft (field error, refuses): `Summa on suurem kui tasumata osa ({x} €).`
  - {x} = what is left. A bad number and a future date reuse existing texts (ADM:328, ADM:470).
- If Dim wants a warning that still lets her add it, the text changes to a notice. Say so when asking.
- Reference strings: ADM:328 `paidInvalid` "Sisesta summa eurodes, näiteks 175 või 175,50."; ADM:470 `invoices.errors.invalid` "Kontrolli andmeid. Kuupäev ei tohi olla tulevikus."

### S3-f — „Võta tasumine tagasi“ on a receipt that „Lisa laekumine“ made  [gap, B4]
- Screen: A2 drawer Arved block, and the A6 Arved row (Veel ▾ → „Võta tasumine tagasi“); a ConfirmPanel (P1 §3.3 list; P2:215 "undoing money goes through the receipt's „Võta tasumine tagasi“ (ConfirmPanel)"). The design writes no question or lines.
- When: she presses it. SPEC:173 says it now lowers „Laekunud summa“. The code recomputes the status and can send the registration back to „Ootab ettemaksu“ (`server/invoices.ts` `takeBackRegistrationPayment`, ~line 248).
- Draft:
  - question: `Kas võtan kviitungi {nr} tasumise tagasi?`
  - lines: `Kviitung tühistatakse (number jääb alles).` · `Laekunud summa väheneb {x} €.` · only if it drops under 50 %: `Registreering läheb tagasi olekusse „Ootab ettemaksu“.`
  - buttons: `Jah, võta tasumine tagasi` / `Katkesta`
  - Receipts that did not add money keep the existing lines (no money change).
- Reference strings: ADM:435-441 `undoPanel` ("Kviitung tühistatakse (number jääb alles)." · "… summa võetakse „Laekunud summa“ alt maha." · "Jah, võta tasumine tagasi"); SPEC:173; BEH:265-270.

### S3-g — „Tühista registreerimine“ ConfirmPanel: how the name is written, and which lines show  [gap, B10]
- Screen: A2 drawer, the danger button at the bottom (README.md:166).
- Problem: README writes "Kas tühistan {name} registreerimise?". Only the P1 sample is hand-inflected ("Kati Kase", P1:330). A surname's genitive cannot be built by rule (Kask→Kase, Lepp→Lepa), and Cyrillic names do not inflect. S5 covers only "+le/+ile" for first names.
- Draft: question `Kas tühistan registreerimise: {name}?`
- Lines, each only when true (README.md:166 gives the three):
  - `Koht {dd.mm linn} koolitusel vabaneb kohe avalikus kalendris.` (only if it has a session and takes a seat now)
  - `Laekunud {x} € ja arved jäävad alles.` (if only money: `Laekunud {x} € jääb alles.`; if only invoices: `Arved jäävad alles.`; if neither: no line)
  - `Õpilasele kirja ei saadeta.` (always)
- Buttons `Jah, tühista` / `Katkesta` as drawn.
- Reference strings: README.md:166; STR:338 (D7); ADM:337 "Registreerimine on tühistatud."; ADM:1107 "Kas lõpetan ligipääsu koolitusele „{course}“? Õpilane ei saa seda enam avada."

### S3-h — Access that ran out by date  [named in S3]
- Screen: A5 Õpilased drawer → Koolitused → e-course card; the state pill, and the title of the „Pikenda ▾“ menu.
- When: end date passed, not ended by an admin and not completed (`accessState` = "expired", `app/src/domain/client-access.ts:71-77`). The design words only „Avatud kuni“, „Läbitud“, „Ligipääs lõpetatud“ (README.md:202; STR:108).
- Draft: pill `Ligipääs lõppes {date}`. Menu title `Pikenda ligipääsu (lõppes {date})` (an open one: "praegu kuni {date}", as drawn).
- {date} is `dd.mm.yyyy`. A completed course keeps „Läbitud {date}“ even if its access also ran out.
- Reference strings:
  - ADM:776 `assessment.screen.expired` "Ligipääs lõppes {date}. …" (same verb, already live)
  - ADM:1074 `clients.drawer.state` { expired: "Lõppes {date}", revoked: "Lõpetatud {date}" }
  - P2:373 "Pikenda ligipääsu (praegu kuni 17.03.2027)"

### S3-i — „Pikenda ▾“ → „Kuupäev…“: the date entry  [gap, B12]
- Screen/when: A5 card, she picks „Kuupäev…“ (README.md:205; analysis/screens.md:300 "the last asks for a date"). The design draws the four choices, not the entry.
- Draft: field label `Ligipääs kuni`; submit `Pikenda`; cancel `Katkesta`; error when the date is not later than the current end: `Vali kuupäev, mis on hilisem kui praegune lõpp.`
- Reference strings: ADM:1095 `clients.grant.until` "Ligipääs kuni"; ADM:1102 `clients.grant.date` "Vali tänane või hilisem kuupäev."; BEH:512-516 (ambiguities: base of +1 kuu; a revoked access).
- The UndoBar after any pick stays the drawn `Ligipääs pikendatud kuni {date}.`

### S3-j — Facts line of the Individuaal, Praktika, Ootenimekiri and Muutmine request cards  [named in S3]
- Screen: A7 Päringud, card under the message (README.md:223 "one muted facts line"). Drawn only for Kontakt „Vastus vene keeles“ and E-õppe huvi „Ostu ei lõpetanud · ostukorvist“ (P2:553).
- The header already shows name, "{date} · {lang} · {email}" and the type tag, so the line carries the rest. Parts are joined with " · "; empty parts are dropped; a Russian request starts with the drawn `Vastus vene keeles`.
- Labels are the existing request field labels (ADM:1007-1021); a yes/no field shows its label only when ticked.
- Draft:
  - Individuaal: `{telefon} · {koolitus} · Soovitud periood: {periood} · Vajab abi modelli leidmisel · Soovib kontot`
  - Praktika: `{telefon} · Pakett: {pakett} · Läbitud koolitus: {koolitus} · Sobivad ajad: {ajad}`
  - Ootenimekiri: `{koolitus} · Toimumine: {dd.mm.yyyy hh:mm}, {linn}` (button „Ava toimumine →“ is drawn)
  - Muutmine: `{Soovib tühistada | Soovib muuta aega} · {koolitus}, {dd.mm.yyyy} {linn}` (name in the header is the registration's name; button „Ava registreering →“)
- The phone number goes in the line because the header shows only the e-mail, while the search placeholder promises phones (P2:471 "Otsi nime, e-posti või telefoni järgi").
- Reference strings: ADM:1007-1021 `requests.fields`; ADM:1024-1025 `wish`; `paringud/page.tsx` FIELDS (lines 34-53) lists what each kind stores.

### S3-k — „Vasta e-kirjaga ↗“: the mail subject  [gap, outgoing text, ET + RU]
- Screen: A7 card button (README.md:223 "mailto with the subject prefilled"; today the link has no subject). The text is the first thing the requester sees.
- Language: the request's own `locale` (the Russian requests are marked RU).
- Draft:
  - ET: `Vastus sinu päringule — {title}`
  - RU: `Ответ на ваш запрос — {title}`
  - {title} = the course or practice package; if the request names none (plain contact message) the word `MS LAB`.
- Reference strings: ET:524 `confirm.subjectRequest` "Päring on vastu võetud — {title}"; RU:459 "Запрос принят — {title}"; ET:561 "MS LAB arve {number}".

### S3-l — „Koosta {n} arvet“: result and the n = 1 forms  [gap, B11]
- Screen: A6 Arved, strip `#arveta` (README.md:217). The strip, panel and button are drawn for n ≥ 2 only. BEH:484 says report made / already / failed.
- When: after „Jah, koosta {n} arvet“ (results); and whenever exactly one payment is unbilled (the n = 1 forms).
- Draft:
  - success (n ≥ 2): `Koostatud {n} arvet: {first}–{last}.`
  - n = 1 result: the existing `Arve {number} on valmis.`
  - some already had an invoice: `Juba arvega: {n}.`
  - failures: `Ei õnnestunud: {names}. Proovi uuesti.`
  - n = 1 button `Koosta 1 arve`; panel `Kas koostan 1 arve?` + line `Arve saab numbri {first}. Õpilasele seda ei saadeta.`; yes `Jah, koosta 1 arve`
  - seller missing: reuse `Täida Seaded → Arve andmed` in place of the button.
- Reference strings: ADM:506 `invoices.uninvoiced.done` "Arve {number} on valmis."; ADM:741 `protocols.result.notSent` "Ei saadetud: {names}. {reason}" (the same shape); ADM:500; P2:423 "Koosta 6 arvet".

### S3-m — Search placeholder of Maksed (and Arved)  [STR D8 "ASK DIM"]
- Screen: A6 ListToolbar, both tabs (B7).
- Conflict: README.md:212 says Maksed searches name, e-mail and Montonio id; the phone mock's placeholder omits the e-mail (P2:442 "Otsi nime või Montonio id järgi"). README.md:218 says Arved: number and name; the desktop mock adds the e-mail (P2:424 "Otsi nime, e-posti või arve numbri järgi"). P1:418 says "Name, e-mail or phone; invoice number on Arved; Montonio id on Maksed".
- Draft by D1 (SPEC:60-71): README wins on scope, the desktop mock on Arved's wording:
  - Maksed: `Otsi nime, e-posti või Montonio id järgi` (a new combination of drawn words)
  - Arved: `Otsi nime, e-posti või arve numbri järgi` (as drawn; its scope also covers the e-mail, as P1 says)
- Reference strings: STR:339 (D8); P1:418; P2:424, P2:442; README.md:212, README.md:218.

---

## 2. P — pattern-derived (builder uses these unless Dim objects)

Each rests on a drawn text or an existing string; no new choice of words.

- **P-1 A1 queue hints** (README.md:130-135 gives only the first hint; the rest are mock samples, P2:534).
  - Ootab hindamist: `{a} praktiline töö · {b} testi vastus · {c} katsed otsas`, zero parts dropped (ADM:828 groups).
  - Päringut tegemata: `{a} kontakt · {b} individuaal · {c} praktika · {d} ootenimekiri · {e} muutmine`, zero parts dropped (the drawn row has four parts for 7).
  - Arvustus / Makse with more than one waiting: `Vanim {dd.mm} · {name}`, as row 1 (README.md:130).
  - Makse ootel kontrollil: the check reason replaces the drawn "kontrolli Montonios" when there is one, i.e. `Topeltmakse — tagasta` (SPEC §7).
  - The Täna card shows zero parts literally, as the live index does (ADM:680).
- **P-2 A2 Raha amount pills.**
  - Labels `{x} € · ettemaks` and `{x} € · kogu summa` are drawn for 0 paid (P2:158).
  - Once something is paid the second pill is the remainder, so its label is `{x} € · ülejäänud summa` (cf. ADM:351 `kind.balance` "Ülejäänud").
  - Once ≥ 50 % is paid the first pill is omitted and the remainder is preselected.
  - Header right of Raha: `Valitud: ettemaks 50%` is drawn; the others are `Valitud: kogu summa (100%)` and `Valitud: järelmaks (Inbank)` (ADM:310-312).
- **P-3 A2 folded-row summaries when the row is not empty.** Drawn: Leping "Sellele registreeringule pole lepingut" / phone "puudub", Tagasiside "pole antud", Arved (phone) "1 tasumata", "Registreerimise andmed" "11 rida".
  - Leping: the contract block's own state line, `Kinnitatud {date}` / `Kinnitamist ootab (saadetud {date})` / `Asendatud {date}` (ADM:586-589).
  - Tagasiside given: `Saadetud {date}` (ADM:912).
  - Arved: `{n} tasumata` / `kõik tasutud` / `arveid pole`.
  - Details: `{n} rida`.
- **P-4 A2 header line without a session:** `{koolitus} · Aeg kokkuleppel · Individuaal` (ADM:292); e-learning: `{koolitus} · E-õpe` (ADM:271).
- **P-5 A3 resend label** (design draws only the first send): a changed, already-sent protocol: `Saada protokoll {eesnimi}le uuesti` (today "Saada uuesti", ADM:720; the name ending follows S5).
- **P-6 A4 queue rows.** The third type („katsed otsas“) has no drawn meta: `parim tulemus {n} % · katseid {n}` (ADM:832-833), actions „Testi katsed“ link + „Ava test uuesti“.
  - Send labels: `, 0 paranda` is dropped (STR:370 W4); k = 0 stays literal; the test review does the same with `, 0 vale`.
- **P-7 A5 progress line:** the colons go: `Õppetunnid 3/3 · Test läbitud (100 %) · Praktiline töö ootab hindamist` from ADM:1121-1128; phone drops " hindamist" ("praktiline ootab", drawn). The kicker of an individual contact registration reads `KONTAKTÕPE · AEG KOKKULEPPEL` (ADM:292).
- **P-8 A6 small ones.**
  - The opened strip's toggle: `Peida ▾` (drawn closed: `Näita ▸`).
  - An e-course payment's row link: `Ava õpilane →` (cf. drawn `Ava registreering →`, `Ava toimumine →`, STR:122).
  - A replaced order shows the tag „Asendatud“ (written in README.md:323), only under „Kõik“; no new pill.
  - A held row shows its reason (`Topeltmakse — tagasta`) in place of „Kontrolli Montonios“ (ADM:353).
- **P-9 Empty/search lines of the lists.**
  - Päringud: `Selle valikuga päringuid pole.` (today "Selles vaates päringuid pole.", ADM:1006); a search with no hit: `„{q}“ järgi {asju} ei leitud.` + „Tühjenda otsing ja filtrid“ (drawn for registreerimisi, P1).
  - Nouns: õpilasi, makseid, arveid, päringuid, as in ADM:1042, 356, 491.
- **P-10 SaveStatus "gone" words** (`thing`, ledger T8 "Dim may want other words"): A2 `registreerimist` (ADM:297), A3 `registreeringut` (ADM:709), A4 praktiline töö `ligipääsu` (ADM:819), A4 test `katset` (ADM:841).
- **P-11 „Tühista arve“ ConfirmPanel** (design lists it, writes no question): `Kas tühistan arve {number}?` + line `Number jääb alles ja summa on uue arve jaoks jälle vaba.` (ADM:443), `Jah, tühista arve`.
- **P-12 Leave-guard field names:** the visible labels „Märkus“, „Staatus“, „Üldised märkused“; the A4 point comment has no label, so `Märkus: {punkti pealkiri}`.
- **P-13 Existing ConfirmPanel texts are re-skinned, not rewritten:**
  - „Lõpeta ligipääs“ (ADM:1107), „Ava järgmine õppetund“ (ADM:1114), „Ava test uuesti“ (ADM:886): question and consequence split at the "?", yes stays, "Ei" becomes „Katkesta“.
- **P-14 UndoBar:** none after „Märgi tegemata“ in the Tehtud fold (it is its own reverse). „Märgitud tehtuks.“ and „Ligipääs pikendatud kuni {date}.“ are drawn.

## 3. Reuse as-is (no text to add)

- Cancelled registration in the drawer: `Registreerimine on tühistatud.` (ADM:337); no price: `Koolitusel pole hinda, staatust ei arvutata. …` (ADM:322); missing drawer: `Seda registreerimist ei leitud.` + „← Registreerimised“ (ADM:297, STR D2).
- „Asendatud“ and „Topeltmakse — tagasta“ are written (README.md:323; SPEC §7). B14: the labels „Tühistatud pangas“ / „Ootel kontrollil“ stay (ADM:350, 347).
- B15 (test-review marks): SaveStatus plus the drawn label „Saada · {õ} õige, {v} vale“; stale text exists (ADM:873).
- Queue sentence for A4 rows: `{name} · praktiline töö | testi vastus | katsed otsas` (README.md:185).

## 4. Builder defaults that add no text (confirm in passing; not S3)

- „Pikenda“ is hidden on an access an admin ended (the „Ava ligipääs e-koolitusele“ fold re-opens it); the base of „+1 kuu / +3 kuud / +6 kuud“ is the later of the current end and today. (BEH:512-516 lists both as open.)
- The Raha card hides a `replaced` order; „Lisa laekumine“ is hidden on a cancelled registration.

## 5. Later pieces (do not ask now)

Piece 3 (B screens):
- „Kustuta mustand“ question (B17, B5 Uudiskiri; STR:184).
- UndoBar texts the design does not draw: a lesson file's „Eemalda“ and list-row removals (B2 lesson drawer, list editors; B5).
- The S6 fallback when Bunny gives no progress (B2 lesson video tags; `Töötlemisel {n}%`).
- Left open at the end of piece 1, both belong to PublishBar's first screens (course editor, piece 3) and C: the line „Avalikul lehel on näha eelmine versioon.“ and a sentence for the blocked-fields list (ledger T11).
- B3 Kalender, B4 Seaded and the contract-publish ConfirmPanel's tighter spec, B1 move menu texts.
- „Täida kohustuslikud väljad“ on `?id=uus` drawers.

Piece 4 (C screens):
- C2 trainer gallery counter "4 / 12" against the limit 24 (STR D25, "ASK DIM").
- List-row removal and review UndoBars (C6), C4 popup texts (settled by SPEC D3), C8 sign-in (written; S4).
- PublishBar words for the home, trainer, news, popup and practice editors.

Already done in piece 1: the 8 texts above, SaveStatus/ConfirmPanel/UndoBar fallbacks (ledger T8 ruling), the Protokollid index.
