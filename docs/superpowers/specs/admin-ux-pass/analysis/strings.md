# MS LAB admin UX pass — Estonian string inventory

Read-only analysis of the design hand-off `design_handoff_admin_ux/` against `app/src/i18n/dict/admin.ts` (main `6832ccf`, dictionary 1939 lines). Nothing in the repo was changed.

## 0. How this file was made and how to read it

- **Sources read in full:** `README.md`; the four `MS LAB Admin UX Pass` prototypes (P1 = `MS LAB Admin UX Pass.dc.html`, P2 = `… - Part 2`, P3 = `… - Part 3`, P4 = `… - Part 4`), `MS LAB Admin UX Deck.dc.html` (deck) and `AdminSidebar.dc.html`. Tags were stripped and the `<script type="text/x-dc">` data arrays were parsed too. The three text-change tables are the arrays `TEXT` (P1, 25 rows), `text2` (P2, 26 rows) and `text3` (P3, 25 rows); P4 has no table. P3 says the three final lists are "repeated in the hand-off README"; the README repeats the behaviour list (short form, § 5) and a summary of the parked items (§ 6) but not the text-change tables, which it only points to ("quote new strings exactly as written in the design files' text-change tables").
- **76 raw table rows → 70 merged rows** (6 rows were the same change written twice: Väljastatud tunnistused, Salvesta summa, Kuu + Näita, Laada alla/CSV, the publish-bar words, Kampaaniad → Kirjad). Of the 70, **55 are old → new** and **15 are new-only** (their "old" is "—").
- On top of the tables the README and the mock-ups imply **30 more changes** (an existing string is changed or becomes dead but no table row names it, type IMP) and introduce **6 groups of new strings** that are in no table (type DNEW). Section 3 lists every new string exactly as written.
- **Type column:** `CHG` old → new in a design table · `NEW` table row whose old is "—" · `DNEW` new strings from README/mock-ups only · `IMP` implied change.
- **"admin.ts today":** `L<line> <key.path>` of the string in `admin.ts` (computed from the file, comment lines skipped). **None of the 55 old → new rows is "not found"**: every quoted old string exists (7 "old" cells are descriptions of UI, not strings: the flat list of 16, the overview tiles, the per-field pills, the popup preview pills, the Testimine filter rows, the done requests in the list, and the plain-text Montonio id; they point to the keys behind them). Where a row says `none (no old string)` it is a new string, and `cf:` lists the nearest existing string. A few old strings live outside `admin.ts`: payment method names and invoice states in `domain/invoice.ts` (`paidMethodText`, `invoiceStatusText`, `ODD_PART`), and the hard-coded ↗ / → / ▸ / ✕ glyphs in the components.
- **Source column:** `P1#7` = row 7 of the Part 1 table (counted in array order), `R1.6` = README § 1.6, `R A3` = README screen A3, `P2 mock` = text read from the mock-up body, `P3 note` = a change-note paragraph.
- Estonian is quoted exactly as in the files, including the long dash „—“ and non-breaking spaces. `{…}` are placeholders, written as in the design (`{välja nimi}` in README, `{väli}` in the table).

## 1. Counts

| | Rows |
|---|---|
| Raw table rows (P1 25 + P2 26 + P3 25) | 76 |
| Merged rows | 70 = 55 CHG + 15 NEW |
| Implied changes (IMP, in no table) | 30 |
| New-string groups in README/mock-ups only (DNEW) | 6 rows (A2-7, A7-3, B1-2, B3-6, C3-1, C4-2) |
| Distinct quoted fragments listed in § 3 that are not in `admin.ts`/`domain/` | ≈ 345 (≈ 250 are longer than 12 characters; a few are sample data) |
| README-vs-HTML disagreements (§ 4) | 28 |
| Strings in two or more wordings (§ 5) | 21 |

## 2. Merged text-change tables, by screen

#### Shell and sidebar

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| SH1 | CHG | Sidebar: flat list of 16 entries | Group labels „Igapäevane töö“, „Koolitused“, „Koduleht ja uudiskiri“, „Haldus“ (README and the mock draw them in capitals: „IGAPÄEVANE TÖÖ“, „KOOLITUSED“, „KODULEHT JA UUDISKIRI“, „HALDUS“; the first group, „Ülevaade“, has no label) | nav.* L105–122 = exactly 16 keys (overview … settings); no group labels exist | P1#1; R1.1 |
| SH2 | CHG | „Maksed“ (menu) | „Maksed ja arved“ | L111 nav.payments | P1#2 |
| SH3 | NEW | — (no menu entry) | Menu rows „Protokollid“, „Testimine“; tabs „Arved“, „Tunnistused“, „Ootab hindamist“ | no nav keys; the words exist elsewhere: protocols.title L583, testplan.title L1906, invoices.title L289, certificates.register.title L1106, assessment.review.status.review L779 | P1#3 |
| SH4 | CHG | „Väljastatud tunnistused“ (button on Hindamine) | removed; tab „Tunnistused“ beside tab „Ootab hindamist“ | L1104 certificates.register.fromAssessment | P1#4; P2#13 |
| SH5 | CHG | „Vaata lehte ↗“ (sidebar footer, overview „Kiirlingid“) | removed there; „Vaata kodulehte ↗“ appears once, in the top line (phone menu footer adds it again, README 1.1) | L93 shell.viewSite; L177 overview.links.site; L96 shell.preview · the ↗ is hard-coded in Sidebar.tsx / Shell.tsx / overview page.tsx | P1#5 |
| SH6 | CHG | Avatar tooltip „Sisse logitud: {email}“ | „Sisse logitud“ + the e-mail as text above „Logi välja“ | L98 shell.signedInAs | P1#6 |

#### Global patterns (saving, confirming, undo, drafts, language, lists, glossary)

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| G1 | CHG | „Salvesta“ and all „Salvesta …“ buttons | removed → SaveStatus (instances with their own table rows: A2-3, A2-1, B2-1, B2-2, B3-1, B4-1) | L880 reviews.form.save; L1319 courseEditor.save; L1344 lessons.save; L1635 editor.save; L250 registrations.drawer.statusSave; L243 registrations.drawer.paidSave; L1478 calendar.form.save; L455 invoices.settings.save; L1060 certificates.settings.save; L556 contracts.settings.save; L371 invoices.row.buyerPanel.submit; L347 invoices.row.paidPanel.submit · not named by the design and kept explicit unless told otherwise: reviews.form.save L880 (explicit create form), invoices.row.paidPanel.submit L347 („Märgi tasutuks“ panel); „Salvesta saaja“ L371 is in P1 §3.1 only, not in README | P1#7 |
| G2 | CHG | „Salvestatud.“ | „Salvestatud {HH:MM}“ (draft: „Mustand salvestatud {HH:MM}“; the mocks print „✓ Salvestatud 12:04“) | L1321 courseEditor.saved; L1372 lessons.drawer.saved; L1637 editor.saved; L603 protocols.saved | P1#8 |
| G3 | CHG | „Muudatusi pole.“ | removed | L1639 editor.clean | P1#9 |
| G4 | CHG | „Kontrolli märgitud välju.“ | „Salvestamata — kontrolli märgitud välja“ + link „Näita“ | L458 invoices.settings.invalid; L559 contracts.settings.invalid; L1063 certificates.settings.invalid; L1323 courseEditor.invalid; L1640 editor.invalid | P1#10 |
| G5 | CHG | Stale: „Seda osa salvestati vahepeal mujal …“ + „Laadi uuesti“ | „Muudeti teises aknas — vaata üle“ + the protocols' notice + „Taasta minu tekst“ | L1641 editor.stale; L1324 courseEditor.stale; L1325 courseEditor.reload; L1642 editor.reload; L252 registrations.drawer.stale | P1#11 |
| G6 | CHG | „Salvestamata muudatused lähevad kaotsi. Sulgen?“ / „Jah, sulge“ / „Ei“ | „Muudatust „{väli}“ ei saanud veel salvestada.“ / „Jää siia“ / „Sulge, tekst jääb seadmesse“ (README: {välja nimi}) | L1374 lessons.drawer.closeQuestion; L1375 lessons.drawer.closeYes · closeNo L1376 = „Ei“ | P1#12 |
| G7 | CHG | Confirm "no": „Ei“, „Tagasi“, „Tühista“ | „Katkesta“ | L134 common.no; L790 assessment.reopen.no; L861 reviews.deleteNo; L1012 clients.revoke.no; L1019 clients.unlock.no; L1350 lessons.deleteNo; L1376 lessons.drawer.closeNo; L1384 lessons.drawer.kind.no; L1486 calendar.remove.no; L1600 newsletter.campaigns.stop.no; L1824 post.remove.no; L638 protocols.confirm.no; L706 assessment.screen.confirmNo; L881 reviews.form.cancel; L1583 newsletter.campaigns.all.no | P1#14; R1.6; R1.11 |
| G8 | CHG | Confirm "yes" in panels: „Saada“ | „Jah, saada {n} …“ (always „Jah, {tegusõna}[ {n} …]“) | L637 protocols.confirm.yes; L1582 newsletter.campaigns.all.yes; L705 assessment.screen.confirmYes | P1#15; R1.6 |
| G9 | CHG | „Laada alla“, „Lae alla … (CSV)“ (certificates, newsletter, overview) | „Laadi alla (PDF)“ / „Laadi alla (CSV)“ ({PDF\|CSV}); for the newsletter the CSV is one button for the current filter (replaces „Lae alla kinnitatud (CSV)“ + „Lae alla kõik (CSV)“) | L1083 certificates.drawer.download; L1084 certificates.drawer.downloadLabel; L178 overview.links.csv; L1495 newsletter.csvConfirmed; L1496 newsletter.csvAll | P1#16; P3#21; R1.11 |
| G10 | CHG | „Hindamisse“, „Kalendrisse“, „Registreeringu juurde“, „Tagasi“ (back links) | „← {Lehe nimi}“ | L675 assessment.screen.back; L1108 certificates.register.back; L588 protocols.toCalendar; L589 protocols.toRegistration; L817 feedback.toRegistration; L1216 courseEditor.back; L1802 post.back; L1123 viewAs.backLabel; L1122 viewAs.back · feedback.toRegistration L817 is a forward link in the answer drawer, not a back link | P1#17; R1.11 |
| G11 | NEW | — | „Avaldamata muudatused: {n}“ · „Eelvaade ↗“ · „Avalda muudatused“ · „Loobu muudatustest“ | none (no old string) · cf: L1179 badge.preview; L1554 newsletter.campaigns.preview; L1849 campaign.preview | P1#18; P3#2; R1.8 |
| G12 | CHG | Per-field „ET“/„RU“ pills | Page „Sisu keel: ET · RU“ (README: LangSwitch „ET“ \| „RU“); „Kopeeri eesti keelest“; „RU puudub {n} väljal“ + „Järgmine →“ | L1133 i18n.lang; L1135 i18n.switch; L1136 i18n.missing | P1#19; R1.9 |
| G13 | CHG | „Otsi nime või e-posti järgi“ | „Otsi nime, e-posti või telefoni järgi“ (all people lists; varies per page) | L939 clients.searchLabel | P1#20 |
| G14 | CHG | „Selle valikuga … pole.“ | same text + button „Tühjenda otsing ja filtrid“ (README pattern: „Selle valikuga {asju} pole.“) | L193 registrations.emptyFiltered; L273 payments.emptyFiltered; L408 invoices.page.emptyFiltered; L944 clients.emptyFiltered; L941 clients.clearSearch | P1#21; R1.10 |
| G15 | NEW | — | UndoBar „{Mis juhtus}. Võta tagasi“ (text „{Mis juhtus}.“ + button „Võta tagasi“) | none (no old string) · cf: L325 invoices.row.undoPaid | P1#22; R1.7 |
| G16 | NEW | — | error.tsx: „Seda lehte ei saanud praegu laadida.“ / „Sinu salvestatud andmed on alles. Proovi mõne hetke pärast uuesti.“ / „Proovi uuesti“ | none (no old string) | P1#23; R1.10 |

#### A1 Ülevaade

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A1-1 | CHG | Overview tiles + „Ootab hindamist: {n}“ + „Päringud“ cards | „Sinu järjekord“ (one list) | L146 overview.stats.awaiting; L147 overview.stats.requests; L148 overview.stats.sessions; L149 overview.stats.subscribers; L167 overview.assessment.title; L168 overview.assessment.open; L172 overview.inbox.open; L173 overview.inbox.done | P2#1 |
| A1-2 | CHG | „Vaata registreerimisi →“, „Kiirlingid“ | removed | L143 overview.primary; L144 overview.more; L176 overview.links.title; L179 overview.links.newsletter; L178 overview.links.csv | P2#2 |
| A1-3 | CHG | „Protokollid“ (button on the „Täna“ card) | „Ava protokollid →“ | L585 protocols.open | P2#3 |
| A1-4 | NEW | — | „Järjekord on tühi.“ / „Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.“ | none (no old string) · cf: L173 overview.inbox.done | P2#4; R A1 |
| A1-5 | IMP | „Õpilasi: {n}“ (Täna card) | „{n} õpilast · protokollid: {a} saadetud, {b} mustand, {c} alustamata“ | L163 overview.today.students | R A1; P2 note |
| A1-6 | IMP | lead „Sinu koolituskeskuse järgmised sammud.“ | dropped (heading is the date eyebrow + „Tere, {name}.“ only) | L142 overview.lead | R A1 (heading) |

#### A2 Registreerimised

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A2-1 | CHG | „Laekunud summa (€)“ + „Salvesta summa“ | „Raha“ card + „Lisa laekumine“ / „Lisa {summa} · koht kinnitub“ (suffix only when the payment reaches 50 %) | L241 registrations.drawer.paidLabel; L243 registrations.drawer.paidSave; L244 registrations.drawer.paidSaved; L245 registrations.drawer.paidInvalid; L242 registrations.drawer.paidHint; L234 registrations.drawer.priceTitle | P1#13; P2#5 |
| A2-2 | CHG | Money box „Hind / 50% hinnast / Valitud makse / Laekunud“ | „{laekunud} / {hind} laekunud“ + „Koht kinnitub {pool} juures“ | L235 registrations.drawer.price; L236 registrations.drawer.half; L237 registrations.drawer.due; L238 registrations.drawer.paid | P2#6 |
| A2-3 | CHG | „Salvesta staatus“ | removed (autosave); heading „Staatus ja märkus“ | L250 registrations.drawer.statusSave; L251 registrations.drawer.statusSaved; L246 registrations.drawer.statusLabel | P2#7 |
| A2-4 | CHG | Registreerimised column „Makse“ | „Laekunud“ (values like „0 / 290 €“); „Koolitus“ + „Toimumine“ merge into „Koolitus ja toimumine“; „Liik“, „Modelli abi“, „Konto“ move to the drawer | L201 registrations.col.payment; L198 registrations.col.kind; L200 registrations.col.session | P2#8 |
| A2-5 | IMP | noteHint „Märkust näeb ainult haldus.“ | hint „Näeb ainult haldus.“ (README) / label „Märkus — näeb ainult haldus“ (desktop mock) | L248 registrations.drawer.noteHint | R A2 item 3; P2 note |
| A2-6 | IMP | invoice action row in the drawer | visible: „Saada õpilasele“, „Laadi alla (PDF)“; under „Veel ▾“: Muuda saajat, Märgi tasutuks, Tühista arve, Võta tasumine tagasi (existing words unchanged) | L322 invoices.row.send; L327 invoices.row.download; L323 invoices.row.editBuyer; L324 invoices.row.markPaid; L326 invoices.row.cancelInvoice; L325 invoices.row.undoPaid | R A2 item 4 |
| A2-7 | DNEW | — (button „Tühista registreerimine“ had no confirmation) | ConfirmPanel „Kas tühistan {name} registreerimise?“ / „Koht {date city} koolitusel vabaneb kohe avalikus kalendris.“ / „Laekunud {x} € ja arved jäävad alles.“ / „Õpilasele kirja ei saadeta.“ / „Jah, tühista“ / „Katkesta“ | none (no old string) · cf: L253 registrations.drawer.cancel | R A2 item 6; P1 §3.3 |

#### A3 Protokollid

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A3-1 | CHG | „Lukusta ja saada kõik“ / „Lukustan ja saadan protokollid“ | „Saada kõigile ({n})“ / „Kas saadan {n} protokolli?“; yes „Jah, saada {n} protokolli“ (old „Saada“); no „Katkesta“ (old „Tagasi“) | L623 protocols.sendAll; L628 protocols.confirm.title; L637 protocols.confirm.yes; L638 protocols.confirm.no | P2#9; R A3 |
| A3-2 | CHG | Per-student „Saada“ | „Saada protokoll {eesnimi}le“ (informed button, no confirmation) | L619 protocols.send | P2#10; R A3 |
| A3-3 | CHG | „Kalendrisse“, „Registreeringu juurde“ (protocol back links) | „← Protokollid“ (README) / „← Protokollid“ or „← {kust tuli}“ (P2 table) | L588 protocols.toCalendar; L589 protocols.toRegistration | P2#11; R A3 |
| A3-4 | NEW | — | „Taasta minu tekst“ (conflict notice) | none (no old string) · cf: L615 protocols.conflict | P2#12; R A3 |

#### A4 Hindamine

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A4-1 | NEW | — | „Kinnita kõik“ | none (no old string) | P2#14; R A4 |
| A4-2 | CHG | „Saada hinnang“ → panel → „Saada“ | „Saada hinnang · {k} kinnitatud, {p} paranda“ (no confirmation; the panel is removed) | L699 assessment.screen.send; L701 assessment.screen.confirmTitle; L702 assessment.screen.confirmCounts; L705 assessment.screen.confirmYes; L704 assessment.screen.confirmNotes; L706 assessment.screen.confirmNo; L703 assessment.screen.confirmPassed | P2#15; R A4 |
| A4-3 | CHG | Test review „Saada“ | „Saada · {õ} õige, {v} vale“ | L759 assessment.review.send | P2#16; R A4 |
| A4-4 | IMP | „Kõik on hinnatud.“ (empty queue) | „Hindamist ootavaid töid pole.“ | L729 assessment.empty | R A4; P2 note |
| A4-5 | IMP | three groups „Praktilised tööd“ / „Testi vastused“ / „Katsed otsas“ (cards) | one list; row text "{name} · praktiline töö \| testi vastus \| katsed otsas" | L730 assessment.groups | R A4 |

#### A5 Õpilased

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A5-1 | NEW | — | „Pikenda“ / „Pikenda ▾“ / „+1 kuu“ / „+3 kuud“ / „+6 kuud“ / „Kuupäev…“ / „Ligipääs pikendatud kuni {date}.“ | none (no old string) · cf: L998 clients.grant.until | P2#17; R A5 |
| A5-2 | CHG | „Lõpetatud {date}“ (two meanings) | „Läbitud {date}“ (course completed) / „Ligipääs lõpetatud {date}“ (access ended by an admin) | L819 feedback.completed; L977 clients.drawer.state.revoked; L1029 clients.steps.completed; L977 clients.drawer.state.expired | P2#18; R A5 |
| A5-3 | CHG | „(mustand) (avatud kuni …)“ | „{koolitus} · mustand · avatud kuni {date}“ | L995 clients.grant.draft; L997 clients.grant.openUntil | P2#19; R A5 |
| A5-4 | CHG | „Otsi“ button (Õpilased) | removed (search as you type) | L940 clients.search | P2#20; R A5 |
| A5-5 | IMP | step lines „Test: {state}“, „Test: {state} ({percent} %)“, „Praktiline töö: {state}“ | mock prints „Õppetunnid 3/3 · Test läbitud (100 %) · Praktiline töö ootab hindamist“ (no colons); phone „3/3 · test läbitud · praktiline ootab“ | L1026 clients.steps.test; L1027 clients.steps.testScore; L1028 clients.steps.practical | R A5; P2 mock |
| A5-6 | IMP | „Koolitusi“ explainer line (clients.coursesHint) | becomes the column header's title / aria-describedby | L947 clients.coursesHint | R A5 |
| A5-7 | IMP | „Ava ligipääs“ card (form); „Ava registreerimine“ link | folded row „Ava ligipääs e-koolitusele“ (summary „vali koolitus“); registration action „Ava registreering“ (phone: „Registreering“, „Protokoll“) | L993 clients.grant.title; L928 requests.openRegistration; L983 clients.drawer.openRegistration | R A5; P2 mock |

#### A6 Maksed ja arved

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A6-1 | CHG | „Arveta maksed“ card + per-row „Koosta arve“ | „Arveta maksed: {n}“ + summary line + „Näita ▸“ + „Koosta {n} arvet“; ConfirmPanel „Kas koostan {n} arvet? Iga arve saab oma numbri ({first}–{last}). Õpilastele neid ei saadeta.“ / „Jah, koosta {n} arvet“ | L415 invoices.uninvoiced.title; L295 invoices.block.create; L421 invoices.uninvoiced.create | P2#21; R A6 |
| A6-2 | CHG | „Kuu“ + „Näita“ + „Laadi alla (CSV)“ | „Kuu“ applies on change („Näita“ removed); button „Laadi alla (CSV) · {kuu aasta}“ | L403 invoices.page.month; L404 invoices.page.monthShow; L409 invoices.page.csv | P1#25; P2#22; R A6 |
| A6-3 | CHG | Montonio id (plain text) | „Montonios ↗“ (link to the merchant URL) | L274 payments.col.provider | P2#23; R A6 |
| A6-4 | NEW | — | „Ava registreering →“ on payment rows (and on „Muutmine“ cards); „Ava toimumine →“ on waitlist cards | none (no old string) · cf: L329 invoices.row.openRegistration; L928 requests.openRegistration; L983 clients.drawer.openRegistration | P2#24; R A6/A7 |
| A6-5 | IMP | „Tühistatud pangas“ counted under „Ebaõnnestunud“ | label unchanged, counted under „Ootel kontrollil“ (filter/badge mapping) | L267 payments.statusVoided; L264 payments.filter; L265 payments.status | R A6 (B14) |
| A6-6 | IMP | eyebrow „Montonio“ (payments.eyebrow); on Arved „Maksed“ (invoices.page.eyebrow) | eyebrow „Montonio“ (P1 page list) or „Montonio ja raamatupidamine“ (P2 mock) over the H1 „Maksed ja arved“ | L260 payments.eyebrow; L398 invoices.page.eyebrow | P1 PAGES; P2 mock |

#### A7 Päringud

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| A7-1 | CHG | Päringud done items in the list | fold „Tehtud ({n})“ at the bottom (with „Märgi tegemata“ inside) | L902 requests.handled; L905 requests.markOpen; L897 requests.lead | P2#25; R A7 |
| A7-2 | CHG | „Vasta e-kirjaga“ | „Vasta e-kirjaga ↗“ (phone card: „Vasta ↗“) | L907 requests.reply | P2#26; R A7 |
| A7-3 | DNEW | — | UndoBar „Märgitud tehtuks.“ + „Võta tagasi“; tags/facts such as „Vastus vene keeles“, „Ostu ei lõpetanud · ostukorvist“ | none (no old string) · cf: L901 requests.interest | P2 mock; R A7 |

#### B1 Koolitused (list)

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| B1-1 | IMP | lead „Kõik koolitused, ka mustandid. Järjekord on sama mis avalikul lehel: muuda seda nooltega.“ | note under H1: „Järjekord on sama mis avalikul lehel. Lohista ⋮⋮ või kasuta nooli.“ | L1186 courses.lead | R B1; P3 mock |
| B1-2 | DNEW | — | Staatus value „Avaldamata muudatused“ (beside „Avaldatud“, „Mustand“); price lines „Grupp 350 €“ / „Individuaal 450 €“; hint „Järjekorda saab muuta vaates „Kõik“.“ | none (no old string) · cf: courses.published L1193, courses.draft L1194, registrations.group L207, registrations.individual L206 | R B1; P3 mock |

#### B2 Course editor and lesson drawer

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| B2-1 | CHG | „Salvesta“ (course editor; site editors; Praktika; Seaded) | „Avalda muudatused“ (published items) / none (drafts) | L1319 courseEditor.save; L1635 editor.save | P3#1 (+ C screens) |
| B2-2 | CHG | Per-module „Salvesta“ (and the lesson drawer's „Salvesta“) | removed | L1344 lessons.save | P3#3 |
| B2-3 | CHG | „Kas kustutan mooduli „{title}“?“ (programme) | „Kas kustutan punkti „{title}“?“ | L1348 lessons.deleteModuleConfirm; L1347 lessons.deleteModule | P3#4 |
| B2-4 | CHG | Lesson „Peida“ / „Näita õpilastele“ | switch „Õpilastele nähtav“ (P3 note: „Õpilastele nähtav / Peidetud“) | L1387 lessons.drawer.hide; L1388 lessons.drawer.show; L1386 lessons.drawer.visibility; L1389 lessons.drawer.hiddenNote | P3#5 |
| B2-5 | CHG | „Video kustutatakse. Jätkan?“ / „Jah, jätka“ / „Ei“ | „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“ | L1382 lessons.drawer.kind.confirm; L1383 lessons.drawer.kind.yes; L1384 lessons.drawer.kind.no | P3#6 |
| B2-6 | IMP | video tags „Video {duration}“, „Video töötlemisel“, „Video üleslaadimisel“, „Video viga“ | „Valmis“ / „Töötlemisel {n}%“ / „Video puudub“ / „Tekst“ | L1358 lessons.videoTag | R B2; P3 mock |
| B2-7 | IMP | lesson-drawer upload hint „PDF, Word (.docx) või pilt (JPEG, PNG, WebP), kuni 4 MB.“; video hint „Hoia leht lahti, kuni üleslaadimine on lõppenud.“ | „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“; phone video row „Võid lehelt lahkuda — töötlemine jätkub.“ / „Vali fail“ | L1398 lessons.files.hint; L1403 lessons.files.type; L1414 lessons.video.hint | R B2; P4 mock |
| B2-8 | IMP | lesson delete confirm: „Kas kustutan õppetunni „{title}“ koos video ja failidega?“ / „Jah, kustuta“ / „Ei“ | same question and „Jah, kustuta“; „Ei“ → „Katkesta“ (the question text is not new) | L1391 lessons.drawer.deleteConfirm; L1349 lessons.deleteYes | R B2 |
| B2-9 | IMP | „Salvesta koolitus, et lisada mooduleid.“ | no longer true if modules join the autosave/draft (not mentioned by the design) | L1337 lessons.saveFirst | R B2/B18 |

#### B3 Kalender

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| B3-1 | CHG | „Salvesta toimumine“ | removed („Lisa toimumine“ stays as the explicit create) | L1478 calendar.form.save; L1479 calendar.form.saved | P3#7 |
| B3-2 | NEW | — | „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ | none (no old string) · cf: L1480 calendar.form.registrations | P3#8; R B3 |
| B3-3 | NEW | — | „Kinnitatud on {n} — kohti ei saa olla vähem.“ | none (no old string) · cf: L20 capacity | P3#9; R B3 |
| B3-4 | CHG | „Kustuta toimumine“ on a booked session (button, then the refusal) | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ shown in place of the button (P1 §3.3 prints the shorter „Toimumisel on registreeringuid — märgi see „Tühistatud“.“) | L1483 calendar.remove.button; L1487 calendar.remove.inUse | P3#10; R B3 |
| B3-5 | CHG | „Eesti aeg.“ hint | label „Algus (Eesti aeg)“ | L1468 calendar.form.timeHint; L1467 calendar.form.time | P3#11; R B3 |
| B3-6 | DNEW | — | „Muudetud — teavita {n} õpilast ise.“; ConfirmPanel „Kas tühistan toimumise? {n} registreeringut jäävad alles; teavita õpilasi ise.“ / „Jah, tühista“ | none (no old string) · cf: L1476 calendar.form.statusHint | R B3; P3 mock |

#### B4 Seaded

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| B4-1 | CHG | „Salvesta tunnistuse andmed“ / „Salvesta arve andmed“ / „Salvesta lepingud“ | removed | L1060 certificates.settings.save; L455 invoices.settings.save; L556 contracts.settings.save | P3#12 |
| B4-2 | NEW | — | „Avalda uus leping“ + ConfirmPanel „Kas avaldan uue e-koolituse lepingu? {n} aktiivset õpilast …“ (mock: „… peavad selle järgmisel sisselogimisel uuesti kinnitama.“ / „Vana leping jääb alles ja märgitakse asendatuks.“ / „Jah, avalda“ / „Katkesta“); tag „Avaldamata muudatus“ | none (no old string) · cf: L1896 settings.courseTermsLead | P3#13; R B4 |
| B4-3 | NEW | — | „Järgmine arve: {nr}“ / „Järgmine tunnistus: {nr}“ (README: „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“) | none (no old string) · cf: L440 invoices.settings.nextNumber; L1053 certificates.settings.nextNumber | P3#14; R B4 |
| B4-4 | IMP | card titles „Kontaktandmed“, „Ettemaksu juhised“, „Arve andmed“, „Tunnistus“, „Lepingud“, „Privaatsus“, „Õppetingimused“, „E-koolituse leping (tingimused)“, „Kontaktkoolituse leping“, „Halduse ligipääs“ | section map: „Kontakt“, „Uudiskiri“, „Maksmine“ (merges Ettemaksu juhised + Arve andmed bank fields), „Tunnistus“, „Lepingud ja tingimused“, „Halduse ligipääs“; contract card name „E-koolituse leping“ | L1869 settings.contact; L1884 settings.prepayment; L1894 settings.courseTerms; L1900 settings.admins; L451 invoices.settings.bank | R B4 |
| B4-5 | IMP | number card: „Järgmine number“ + year field „Aasta“ + number „Number“ | „Järgmine number“ edits the current year's counter; from 1 December the line „1. jaanuarist: {prefix}{year+1}-001“ | L441 invoices.settings.nextYear; L1054 certificates.settings.nextYear; L442 invoices.settings.nextSeq; L1055 certificates.settings.nextSeq; L443 invoices.settings.nextHint; L1056 certificates.settings.nextHint | R B21 |

#### B5 Uudiskiri

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| B5-1 | CHG | „Uudiskiri → Kampaaniad“ (tab), „Uus kampaania“ | Tab „Kirjad“ (route keeps ?vaade=kampaaniad); „Uus kiri“ (P1) / „Uus kiri +“ (P3, README B5 list header) | L1515 newsletter.views.campaigns; L1524 newsletter.campaigns.title; L1526 newsletter.campaigns.list; L1527 newsletter.campaigns.new; L1532 newsletter.campaigns.newTitle | P1#24; P3#15; R1.11 |
| B5-2 | CHG | „Salvesta muudatused enne saatmist.“ | removed (sends use the last autosaved version) | L1562 newsletter.campaigns.saveFirst | P3#16 |
| B5-3 | CHG | „Saada proov“ + radio groups „Kellele“, „Keel“ | one select „{aadress} · {eesti\|vene keeles}“ + „Saada proov“ (P3 note and phone mock: informed button „Saada proov · maria@… · eesti keeles“ / „… · ET“) | L1564 newsletter.campaigns.test.title; L1566 newsletter.campaigns.test.to; L1569 newsletter.campaigns.test.language; L1570 newsletter.campaigns.test.languages | P3#17; R B5 |
| B5-4 | CHG | „Saada kõigile“ | „Saada kõigile ({n})“; ConfirmPanel with the existing count text and „Jah, saada {n} tellijale“ / „Katkesta“ (n excludes sample addresses, B9) | L1576 newsletter.campaigns.all.title; L1578 newsletter.campaigns.all.button; L1580 newsletter.campaigns.all.confirm; L1583 newsletter.campaigns.all.no | P3#18; R B5 |
| B5-5 | NEW | — | „Kustuta mustand“ (drafts only; ConfirmPanel, B17 — no wording given beyond the button) | none (no old string) | P3#19; R B5 |
| B5-6 | CHG | „… see läheb välja, kui eelmine on saadetud.“ (full text: „Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.“) | „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“ | L1620 newsletter.campaigns.errorsOf.busy | P3#20; R B5 |
| B5-7 | IMP | every other „kampaania“ word in newsletter.campaigns.* (the glossary: „kampaania“ only means the popup offer) | reword to „kiri“ (no new wording is given) | L1528 newsletter.campaigns.empty; L1531 newsletter.campaigns.notFound; L1617 newsletter.campaigns.errorsOf.notFound; L1534 newsletter.campaigns.form; L1585 newsletter.campaigns.all.done; L1606 newsletter.campaigns.readOnly; L1607 newsletter.campaigns.readOnlySending; L1618 newsletter.campaigns.errorsOf.sent; L1621 newsletter.campaigns.errorsOf.changed; L1623 newsletter.campaigns.errorsOf.notSending | P1 §3.6 (glossary) |
| B5-8 | IMP | Tellijad pills / count | pills „Kinnitatud 14“ / „Ootab kinnitust 5“ with counts; address search | L1499 newsletter.pending; L1497 newsletter.count | R B5 |

#### C1 Avaleht

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C1-1 | IMP | „Koolitaja plokk“ card (text + „Ava Koolitaja“) | link row „Muuda lehel Koolitaja →“ | L1725 home.trainer.title; L1727 home.trainer.link; L1726 home.trainer.text | R C1; P3 note |
| C1-2 | IMP | card title „Korduma kippuvad küsimused“; slide field „Väike pealkiri“; „Tekst“ | section/card name „KKK“; slide fields shown as „Pealkiri · avaldamata“, „Alapealkiri“, „Hele / Tume“, „Eemalda slaid“, „+ Lisa slaid“ | L1713 home.faq.title; L1691 home.slides.kicker | P3/P4 mock |
| C1-3 | IMP | eyebrow „Avaleht“ (home.eyebrow) | eyebrow „Koduleht“ over the H1 „Avaleht“ | L1668 home.eyebrow | P1 PAGES; P4 mock |

#### C2 Koolitaja

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C2-1 | IMP | cards „Portree“ + „Tutvustus“, „Numbrid“ list editor, „Koolitaja tööd“ | „Portree ja tutvustus“, „Numbrid“ as three inline pairs, „Galerii“ (hint „Lohista järjekorra muutmiseks · 4 / 12“), „Koolituskeskuse lugu“ / „Koolitaja teekond“ fold when empty (summary „tühi · Lisa tekst ▸“, button „Lisa tekst“) | L1754 trainer.portrait; L1771 trainer.works; L1766 trainer.addStat; L1773 trainer.story; L1774 trainer.journey | P4 note |
| C2-2 | IMP | eyebrow „Koolitaja“ (trainer.eyebrow) | eyebrow „Koduleht“ over the H1 „Koolitaja“ | L1750 trainer.eyebrow | P1 PAGES; P4 mock |

#### C3 Uudised

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C3-1 | DNEW | — | search „Otsi pealkirja järgi“; status „Avaldamata muudatused“; „Puudub: kaanepilt“ (Avalda check); „Lisa postitus +“ creates a draft titled „Uus postitus“ | none (no old string) · cf: L1785 news.add; L1799 post.newTitle | P4 note; R C3 |

#### C4 Hüpikaken

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C4-1 | CHG | Popup preview ET/RU pills | follows the page LangSwitch | L1133 i18n.lang | P3#24; R C4 |
| C4-2 | DNEW | — | UndoBar „Hüpikaken peidetud.“; mock facts „Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul“, fields „Soodustus (%)“, „Kood kehtib (päeva)“, rules line „Reeglid: kood saadetakse pärast e-posti kinnitamist; üks kasutus tellija kohta; ei liitu teiste soodustustega.“ | none (no old string) · cf: L1834 campaign.shown; L1856 campaign.rulesList[…]; L1857 campaign.rulesList[…] | P4 mock; R C4 |

#### C5 Praktika

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C5-1 | IMP | „Paketi punktid“ / „Punkt“ / „Lisa rida“ | „Sisaldab“; „+ Lisa punkt (või Enter viimasel real)“ | L1743 practice.items | P4 mock |
| C5-2 | IMP | eyebrow „Praktika“ (practice.eyebrow) | P1 page list: eyebrow „Praktika“ (unchanged); P4 mock: „Koolitused“ over the H1 „Praktikapaketid“ | L1732 practice.eyebrow | P1 PAGES; P4 mock |

#### C6 Tagasiside

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C6-1 | IMP | „Lisa arvustus“ (button); form cancel „Tühista“; delete „Ei“ | „Lisa arvustus +“; cancel „Katkesta“; „Arvustus avaldatud.“ + „Võta tagasi“; answer drawer link „Vaata arvustust →“ | L867 reviews.form.add; L881 reviews.form.cancel; L861 reviews.deleteNo | R C6; P4 mock |

#### C7 Testimine

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C7-1 | CHG | Testimine filter rows (two „Kõik“) | one row: labelled groups „Olek“ (Kõik / Avatud / Viga / Läbitud) and „Kes“ (Mina / Kõik); „Selle valikuga kontrolle pole.“ | L1908 testplan.filter; L1909 testplan.who | P3#25; R C7 |
| C7-2 | IMP | testplan.ok „OK“; testplan.skip „Jäta vahele“; progress „{done} / {total} tehtud · {bad} viga · {redo} uuesti testida“; saving/saved/retrying/offline | check buttons „Läbitud“ \| „Viga“ (no „Jäta vahele“); header „UX-pass · 42 kontrolli · 31 läbitud · 2 viga“; „Sammud ▸“; SaveStatus replaces the outbox line (README: 401 → signed-out state) | L1918 testplan.ok; L1920 testplan.skip; L1907 testplan.progress; L1928 testplan.offline | P4 mock |
| C7-3 | IMP | no eyebrow today (testplan.* has none) | eyebrow „Haldus“ over the H1 „Testimine“ | none (testplan.* has no eyebrow key) | P1 PAGES; P4 mock |

#### C8 Sisselogimine

| ID | Type | Old (today) | New (design) | admin.ts today | Source |
|---|---|---|---|---|---|
| C8-1 | CHG | Login lead „Sisesta oma e-posti aadress, saadame sulle sisselogimislingi. Parooli pole vaja.“ | „Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.“ | L44 login.lead | P3#22; R C8 |
| C8-2 | NEW | — | „Muu aadress“, „Link on teel“, „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“; sent body „Saatsime lingi aadressile {email}. See kehtib 15 minutit.“ + „Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.“ | none (no old string) · cf: L49 login.sentTitle; L50 login.sent; L51 login.sentHint; L52 login.again; L54 login.errorTooMany | P3#23; R C8 |

---

## 3. New Estonian strings with no "old" (exactly as written)

Tag after a string: **R** = README only, **H** = HTML only (a mock-up or a note), **R+H** = both. `{…}` placeholders are the design's own. Strings that already exist word for word in `admin.ts` are marked **(exists: key)** so the builder does not add them twice. Sample data in the mocks (names, dates, prices) is not listed unless the sentence around it is new.

### 3.0 Shell, sidebar, phone menu

- Group labels: „IGAPÄEVANE TÖÖ“, „KOOLITUSED“, „KODULEHT JA UUDISKIRI“ (folding header, ▸ / ▾), „HALDUS“ (R+H; Part 3 table prints them in sentence case)
- Menu rows: „Maksed ja arved“, „Protokollid“, „Testimine“ (R+H)
- Badge text on „Protokollid“: „Täna“ (R+H)
- Footer: „Sisse logitud“, the e-mail, „Logi välja“ (exists: panel.logout) (R+H)
- Phone menu top card: „TÄNA {time}“ + „Protokollid · {course}“ (R; H prints „TÄNA 10:00“ / „Protokollid · Kulmumeistri baaskoolitus“); phone footer „Vaata kodulehte ↗“ (R)
- Top line: „Vaata kodulehte ↗“ (exists: shell.preview, the ↗ is in code)

### 3.1 Saving, leaving, confirming, undo, publishing, language, lists (global)

SaveStatus (R+H): „Salvestatud {HH:MM}“ (mock: „✓ Salvestatud 12:04“) · „Mustand salvestatud {HH:MM}“ (mock: „✓ Mustand salvestatud 14:02“) · „Salvestamata muudatused“ (exists: protocols.pending) · „Salvestan…“ (exists: common.saving) · „Kontrollin salvestatud teksti…“ (exists: protocols.checking) · „Salvestamata — proovin uuesti“ (exists: protocols.retrying) · „Salvestamata — kontrolli märgitud välja“ + link „Näita“ · „Salvestamata — logi uuesti sisse“ (protocols.signedOut is the same plus „ Tekst on selles seadmes alles.“) · „Muudeti teises aknas — vaata üle“ · „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ (R; the mock for a missing registration prints the existing „Seda registreerimist ei leitud.“ + „← Registreerimised“, H) · phone abbreviations (H): „✓ Mustand 14:02“, „✓ 20:35“, „✓ 11:20“

Leave guard (R+H): „Muudatust „{välja nimi}“ ei saanud veel salvestada.“ (H: „Muudatust „Kohti“ ei saanud veel salvestada.“) · reason line, mock: „Ühendus puudub. Proovin uuesti, kuni jääd siia.“ · „Jää siia“ · „Sulge, tekst jääb seadmesse“ · new-record drawer before create: „Täida kohustuslikud väljad“ (H)

ConfirmPanel (R+H): „Jah, {tegusõna}[ {n} …]“ · „Katkesta“ · bulk-send mock (H, P1 §3.3): „Kas saadan kirja „Jõulupakkumine“?“ / „4 kinnitatud tellijat: 3 eesti, 1 vene keeles.“ / „Näidisaadressidele (@example.test) ei saadeta.“ / „Saadetud kirja ei saa tagasi võtta ega muuta.“ / „Jah, saada 4 tellijale“ / „Katkesta“

UndoBar (R+H): „{Mis juhtus}.“ + „Võta tagasi“ · instances: „Pilt eemaldatud.“ (H) · „Märgitud tehtuks.“ (H) · „Ligipääs pikendatud kuni {date}.“ (R+H) · „Arvustus avaldatud.“ (H) · „Hüpikaken peidetud.“ (H)

Publish bar (R+H): „Avaldamata muudatused: {n}“ + field list, e.g. „Avaldamata muudatused: 3 · Lühikirjeldus, Hind, Moodul 03. Avalikul lehel on näha eelmine versioon.“ (H; the second sentence is H only) · „Eelvaade ↗“ · „Loobu muudatustest“ · „Avalda muudatused“ · „Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.“ / „Jah, loobu“ (R only) · field-label suffix „· avaldamata“ (R+H: „Lühikirjeldus · avaldamata“, „Pealkiri · avaldamata“, „Tekst · avaldamata“) · phone bar: „Avaldamata 3 · Eelvaade“ + „Avalda“ (P4) or „Avaldamata 3 · Avalda“ (P3 note)

Language (R+H): „Sisu keel“ (H) · segments „ET“ | „RU“ · „RU puudub {n} väljal“ · „Järgmine →“ · „Kopeeri eesti keelest“ · the "ET" tag above the Estonian reference text (R+H) · kept: „tõlge tulekul“ (exists: i18n.missing)

Lists (R+H): „Otsi nime, e-posti või telefoni järgi“ · page variants (H): „Otsi nime, e-posti või arve numbri järgi“ (Arved), „Otsi nime või Montonio id järgi“ (Maksed, phone), „Otsi pealkirja järgi“ (Uudised) · „Kõik koolitused ja toimumised“ (select, Registreerimised) · count line „{Asju}: {n}“ (exists as per-list `count`) · „Uuemad eespool“ (H, sort note beside the count line) · „{Asju} veel pole.“ (exists per list) · „Selle valikuga {asju} pole.“ (exists for 4 lists) · „Tühjenda otsing ja filtrid“ · search-empty mock (H): „„{q}“ järgi registreerimisi ei leitud.“ + „Tühjenda otsing ja filtrid“

Error page (R+H): „Seda lehte ei saanud praegu laadida.“ · „Sinu salvestatud andmed on alles. Proovi mõne hetke pärast uuesti.“ · „Proovi uuesti“ · loading.tsx has no text

Glossary forms (R+H): „Laadi alla ({PDF|CSV})“ · „Vaata lehel ↗“ (exists: editor.viewSite / courseEditor.viewSite „Vaata lehel“) · „← {Lehe nimi}“ · „Võta tagasi“ · „Katkesta“ · „Sulge“

### 3.A Daily-work screens

**A1 Ülevaade** — „TÄNA {HH:MM} · {city, venue}“ (R; H: „TÄNA 10:00 · PÄRNU, MS LAB STUUDIO“, phone „TÄNA 10:00 · PÄRNU“) · „{n} õpilast · protokollid: {a} saadetud, {b} mustand, {c} alustamata“ (R+H; phone H: „3 õpilast · 1 saadetud“) · „Ava protokollid →“ (phone H: „Ava protokollid“) · „Sinu järjekord“ · row labels „Ootab ettemaksu“, „Ootab hindamist“, „Päringut tegemata“, „Arveta makset“, „Arvustus ootab avaldamist“, „Makse ootel kontrollil“ · hints: „Vanim {date} · {name}“ (R), mock-only (H) „1 praktiline töö · 1 testi vastus“, „2 kontakt · 2 individuaal · 1 praktika · 2 ootenimekiri“, „Koosta arved ühe nupuga“, „Kristel M. · Lash Lift BOTOX“, „Анна Иванова · 170 € · kontrolli Montonios“ · „Järjekord on tühi.“ / „Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.“ · „järgmise 30 päeva jooksul: {n}“ · headers „Kuupäev“, „Koolitus ja linn“, „Vabu kohti“ (H) · „Kalender →“ (H)

**A2 Registreerimised** — column „Laekunud“ with „{paid} / {price} €“ · status pills with counts, filter pills „Kõik vormid“ / „E-õpe“ / „Kontaktõpe“ (H) · Drawer: „Raha“ · „Valitud: ettemaks 50%“ (H) · „{laekunud} / {hind} laekunud“ (H: „0 € / 290 € laekunud“) · „Koht kinnitub {pool} juures · vabu kohti {x} / {cap}“ · „Lisa laekumine“ · amount pills (H) „145 € · ettemaks“, „290 € · kogu summa“, „Muu summa“ · method pills (H) „Pangaülekanne“, „Sularaha“, „Kaart“ · „Koosta kviitung (arve „Juba tasutud“)“ · „Lisa {summa} · koht kinnitub“ (H: „Lisa 145 € · koht kinnitub“) · „Katkesta“ · results „{x} € lisatud · kviitung {nr} · koht kinnitatud.“ (H: „145 € lisatud · kviitung MSL2026-005 · koht kinnitatud.“) and „… Koolitus on vahepeal täis, nii et koht jäi kinnitamata.“ (H full: „145 € lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.“; second half exists: invoices.row.paidPanel.full) · „Staatus ja märkus“ · „Märkus“ + hint (see §4/§5) · „Veel ▾“ · folds „Leping“ (exists: contracts.title) + summary „Sellele registreeringule pole lepingut“ (exists: contracts.block.none, without the full stop in the mock), „Tagasiside“ + „pole antud“, „Registreerimise andmed“ (exists: registrations.drawer.details) + „11 rida“ (H); phone (H): „Arved“ + „1 tasumata ▸“, „Leping“ + „puudub ▸“ · ConfirmPanel for „Tühista registreerimine“ (R, P1 §3.3): „Kas tühistan {name} registreerimise?“ / „Koht {date city} koolitusel vabaneb kohe avalikus kalendris.“ / „Laekunud {x} € ja arved jäävad alles.“ / „Õpilasele kirja ei saadeta.“ / „Jah, tühista“ / „Katkesta“ (P1 sample: „Kas tühistan Kati Kase registreerimise?“, „Laekunud 175 € ja arve MSL2026-004 jäävad alles.“) · missing registration (H): „Seda registreerimist ei leitud.“ + „← Registreerimised“

**A3 Protokollid** — index (H): „Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.“ · row: „Täna“ / weekday „teisipäev, 20.10“ / „10:00 · Pärnu, MS LAB stuudio“ / „3 õpilast · 1 saadetud · 1 mustand“ / „✓ Kõik 3 saadetud“ / „Ava“ · section „INDIVIDUAALKOOLITUSED“ (H) with „Aeg kokkuleppel“ (exists: registrations.agreed) + „Alustamata“ + „Ava“ · empty (R only): „Viimase 14 päeva jooksul koolituspäevi polnud.“ + „← Kalender“ · screen: „← Protokollid“ · „Saada kõigile ({n})“ (H: „Saada kõigile (2)“) · „Kas saadan {n} protokolli?“ + „Jah, saada {n} protokolli“ (H: „Jah, saada 2 protokolli“) / „Katkesta“ · „Saada protokoll {eesnimi}le“ (H: „Saada protokoll Eliisele“) · „Taasta minu tekst“ · corner chip in the mock: „✓ 12:41“

**A4 Hindamine** — tabs „Ootab hindamist {n}“ (R+H) and „Tunnistused“ · queue rows (H): „{name} · praktiline töö“ + „1. kord · 20.10 18:35“; „{name} · testi vastus“ + „katse 2/3 · 20.10 19:35“; README also „katsed otsas“ · buttons „Hinda“, „Vaata“ (exist: assessment.assess, assessment.review.view), „Ava test uuesti“ (exists) · empty „Hindamist ootavaid töid pole.“ · screen: „← Hindamine“, „{n} punkti · {k} hinnatud“ (H: „3 punkti · 3 hinnatud“), „Kinnita kõik“, „Saada hinnang · {k} kinnitatud, {p} paranda“ (H also „Saada hinnang · 3 kinnitatud“ when none to fix), point verdicts „Kinnitatud“ / „Paranda“ (exist), „Lisa märkus“ (H), „Üldised märkused“ (exists: protocols.general), phone hint (H) „Puuduta pilti, et avada täissuuruses.“ · header line (H): „Kulmumeistri e-koolitus · Praktiline töö, 1. kord · saadetud 20.10.2026 18:35“ · test review: „Saada · {õ} õige, {v} vale“ (R+H) / „Saada test tagasi · 1 vale“ (P1 §3.3)

**A5 Õpilased** — header button „Lisa õpilane +“ · header line (exists in pieces): „Konto loodud 20.10.2026 · Keel ET · Uudiskiri: ei“ · list title „Koolitused“ · kickers „E-ÕPE“, „KONTAKTÕPE · {date} {city}“ (H) · pills „Avatud kuni {date}“ (exists: clients.drawer.state.active), „Läbitud {date}“, „Ligipääs lõpetatud {date}“ · progress line (H) „Õppetunnid 3/3 · Test läbitud (100 %) · Praktiline töö ootab hindamist“ · buttons „Hinda“, „Pikenda ▾“, „Veel ▾“, „Ava registreering“, „Ava protokoll“ (phone H: „Registreering“, „Protokoll“) · menu title (H) „Pikenda ligipääsu (praegu kuni 17.03.2027)“ · options „+1 kuu“, „+3 kuud“, „+6 kuud“, „Kuupäev…“ · UndoBar „Ligipääs pikendatud kuni {date}.“ · „Veel ▾“ holds (exist) „Ava järgmine õppetund“, „Testi katsed“, „Vaata tema vaadet“, „Lõpeta ligipääs“ · folds (H): „Ava ligipääs e-koolitusele“ + „vali koolitus“; „Maksed“ + „1 · 190 €“; „Lepingud“ + „0“; „Päringud“ + „0“; „Tagasiside“ + „0“

**A6 Maksed ja arved** — page eyebrow (H) „Montonio ja raamatupidamine“ · tabs „Maksed“ | „Arved“ · „Laadi alla (CSV) · {kuu aasta}“ (H: „Laadi alla (CSV) · oktoober 2026“) · strip „Arveta maksed: {n}“ + (H) „Tasutud, aga arve puudub · 1 325,00 € · Merilin Kuusk, Kati Kask, Mari Tamm ja 3 teist“ · „Näita ▸“ · „Koosta {n} arvet“ (H: „Koosta 6 arvet“) · ConfirmPanel (R) „Kas koostan {n} arvet? Iga arve saab oma numbri ({first}–{last}). Õpilastele neid ei saadeta.“ / „Jah, koosta {n} arvet“ · pills with counts (H) „Kõik 3“, „Tasumata 1“, „Tasutud 2“, „Tühistatud 0“ · invoice meta lines (H): „Osamakse · koostatud 20.10 · tasutud 15.10 · sularaha“, „Kogu summa · tasutud 19.10 · pangaülekanne“, „Ettemaks 50% · maksta kuni 27.10“ · payment rows: „Montonios ↗“ (R), „Ava registreering →“ (R+H), meta (H) „19.10 · Lash Lift BOTOX · pangalink“

**A7 Päringud** — tabs with counts „Kontakt 2“, „Individuaal 2“, „Praktika 1“, „Ootenimekiri 2“, „Muutmine 0“ (H) · tag „E-õppe huvi“ (exists: requests.interest) · facts lines (H) „Vastus vene keeles“, „Ostu ei lõpetanud · ostukorvist“ · card header (H) „{date time} · {lang} · {email}“; phone „{date} · {lang}“ · buttons „Märgi tehtuks“ (exists), „Vasta e-kirjaga ↗“ / phone „Vasta ↗“ · „Ava toimumine →“ · „Ava registreering →“ · fold „Tehtud ({n}) ▸“ (H) / „Tehtud ({n})“ (R) with „Märgi tegemata“ inside · UndoBar „Märgitud tehtuks.“ · deep link `#p-{id}`

### 3.B Course and setup screens

**B1 Koolitused** — note (H) „Järjekord on sama mis avalikul lehel. Lohista ⋮⋮ või kasuta nooli.“ · „Lisa koolitus +“ (phone „Lisa +“; exists: courses.add without the "+") · pills with counts „Kõik 6“, „E-õpe 3“, „Kontaktõpe 3“ (phone H: „Kontakt 3“) · price lines „Grupp 350 €“ / „Individuaal 450 €“ · status „Avaldamata muudatused“ · hint (R) „Järjekorda saab muuta vaates „Kõik“.“ · `aria-roledescription` (R) „lohistatav“ · phone move menu (H): „↕“, „Üles“, „Alla“, „Esimeseks“, „Viimaseks“ · phone second line „{vorm} · {staatus}“

**B2 Course editor, lesson drawer** — „← Koolitused“ · LangSwitch · publish bar (see 3.1) · section-map entries: „Põhiinfo“, „Õppevorm ja hind“, „Õpiväljundid“, „Moodulid ja õppetunnid“, „Teadmiste test“, „Tunnistus“, „Galerii“, „Soovitused“ (all exist as card titles) with status values „{count}“, „RU puudub“, „Kontrolli“ · phone „Jaotised · Põhiinfo ▾“ / README „Jaotised ▾“ · „Moodulid ja õppetunnid“ summary (H) „6 moodulit · 3 õppetundi“ · module tag „avaldamata“ · video tags „Valmis“, „Töötlemisel {n}%“, „Video puudub“, „Tekst“ · side column „Avaldamine“, „Avalikul lehel“, „Näidissisu“, „Koolituse märgis“ (exist) · lesson drawer: header „Moodul {nn} · Õppetund {n.n}“ · „Õppetunni nimi“, „Lühike tekst“, „Õppetunni liik“ + „Video“ | „Tekst“ (exist) · „Failid“ · „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“ · „Õpilastele nähtav“ (P3 note: „Õpilastele nähtav / Peidetud“) + hint (H) „Õppetunnil on õpilaste edenemist — seda saab ainult peita.“ · ConfirmPanel „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“ · ConfirmPanel „Kas kustutan õppetunni „{nimi}“ koos video ja failidega?“ / „Jah, kustuta“ / „Katkesta“ (question exists: lessons.drawer.deleteConfirm with {title}) · ConfirmPanel (programme point) „Kas kustutan punkti „{title}“?“ · phone drawer (H): „intro.mp4“ / „Töötlemisel 75%“ / „Võid lehelt lahkuda — töötlemine jätkub.“ / „Vali fail“

**B3 Kalender** — pills „Tulevased“ / „Möödunud“ with counts (H phone: „Tulevased 5“, „Möödunud 3“, „Linn ▾“) · „Protokollid“ (first button; exists: protocols.open) · header line „{date} · {city} · {confirmed}/{cap} kinnitatud · ootenimekirjas {n}“ (R; H desktop „05.12.2026 · Pärnu · 4/4 kinnitatud · ootenimekirjas 2“; phone „… · 4/4 · ootel 2“) · „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ · „Muudetud — teavita {n} õpilast ise.“ · „Kinnitatud on {n} — kohti ei saa olla vähem.“ · „Algus (Eesti aeg)“ · ConfirmPanel „Kas tühistan toimumise? {n} registreeringut jäävad alles; teavita õpilasi ise.“ / „Jah, tühista“ · „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ · `?id=uus`: explicit „Lisa toimumine“ (exists: calendar.add / calendar.form.create)

**B4 Seaded** — section map „Kontakt“, „Uudiskiri“, „Maksmine“, „Tunnistus“, „Lepingud ja tingimused“, „Halduse ligipääs“ (+ status „1 avaldamata“ on Lepingud) · „Maksmine“ lead (H) „Ühed pangaandmed ettemaksu juhistes ja arvetel.“ · „Saaja“, „IBAN“, „Registrikood“ (exist) · number field (H) „Arve järgmine number“ · preview „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“ (R; H „Järgmine arve: MSL2026-007“; P3 note „Järgmine: MS LAB 2026-93“ / „MSL2026-007“) · B21 line „1. jaanuarist: {prefix}{year+1}-001“ (H phone: „Järgmine arve: MSL2026-007 · 1. jaanuarist: MSL2027-001“) · contracts: tag „Avaldamata muudatus“ · „Avalda uus leping“ · placeholder chips „+ nimi“, „+ e-post“, „+ koolitus“, „+ toimumine“, „+ hind“, „+ ettemaks“ (H) · ConfirmPanel „Kas avaldan uue e-koolituse lepingu?“ (H mock) / „7 aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.“ / „Vana leping jääb alles ja märgitakse asendatuks.“ / „Jah, avalda“ / „Katkesta“ (R: the count of students who must re-accept, or „kehtib uutele registreeringutele“ for the contact contract; P3 note: „Kas avaldan uue e-koolituse lepingu? 7 aktiivset õpilast peavad selle uuesti kinnitama.“) · phone (H): „Pikk tekst avaneb täisekraanil.“ + „Muuda teksti“

**B5 Uudiskiri** — tabs „Tellijad“ | „Kirjad“ · „Uus kiri +“ · list lines (H) „Mustand · muudetud 20.10 20:35“, „Saadetud 12.10 · 10 tellijale“ · select „{address} · {eesti|vene keeles}“ (H: „maria@example.test · eesti keeles“) · „Saada proov“ · „Saada kõigile ({n})“ + hint (H) „3 eesti, 1 vene keeles · näidisaadressidele ei saadeta“ · ConfirmPanel „Jah, saada {n} tellijale“ / „Katkesta“ (+ Part 1 mock lines, 3.1) · „Kustuta mustand“ (ConfirmPanel, wording not given) · busy text „Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.“ · phone (H): „← Kirjad“, „Muuda“ | „Eelvaade“, „Saada proov · maria@… · ET“, „Saada kõigile (4)“ · Tellijad pills „Kinnitatud 14“ / „Ootab kinnitust 5“ (H), „Laadi alla (CSV)“

### 3.C Site-content screens

**C1 Avaleht** — link row „Muuda lehel Koolitaja →“ · section map „Slaidid“, „MS LABi lause“, „Koolitaja kaart“, „KKK“, „Koolitaja plokk“ (+ counts „5“, „6 · RU puudub“) · slide card (H): „Puuduta pilti, et valida fookus · Vaheta pilt“, „Pealkiri · avaldamata“, „Alapealkiri“, „Hele“ | „Tume“, „Eemalda slaid“, „+ Lisa slaid“ · FAQ rows (H): question + „ET · RU“ / „RU puudub“

**C2 Koolitaja** — „Portree ja tutvustus“ · „Nimi“, „Tutvustus“ · „Numbrid“ (3 inline number + label pairs, e.g. „8+“ „aastat kogemust“) · „Galerii“ + „Lohista järjekorra muutmiseks · 4 / 12“ · „+ Lisa“ · „Koolituskeskuse lugu“ / „Koolitaja teekond“ folded: „tühi · Lisa tekst ▸“, „Lisa tekst“

**C3 Uudised** — „Otsi pealkirja järgi“ · status „Avaldamata muudatused“ · bar (H) „Avaldamata muudatused: 1 · Tekst“ · „Puudub: kaanepilt“ · new post title „Uus postitus“ · footer line (H) „Avaldatud 02.10.2026 · /uudised/{slug}“ + „Kustuta postitus“ (exists: post.remove.button)

**C4 Hüpikaken** — UndoBar „Hüpikaken peidetud.“ · „Lehel näidatakse“ + (H) „Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul“ · fields (H) „Pakkumine“, „Pealkiri · RU“, „Tekst“, „Soodustus (%)“, „Kood kehtib (päeva)“, „tõlge tulekul“, „Kopeeri eesti keelest“ · rules line (H) „Reeglid: kood saadetakse pärast e-posti kinnitamist; üks kasutus tellija kohta; ei liitu teiste soodustustega.“ · the preview itself shows Russian site text (not admin text)

**C5 Praktika** — „Praktikapaketid“ (exists) · per package: „Hind (€)“, „Modelle“, „Kestus“, „Sisaldab“ · „+ Lisa punkt (või Enter viimasel real)“ · bar (H) „Avaldamata muudatused: 2 · MAXI hind, MAXI punkt 4“

**C6 Tagasiside** — tabs „Vastused“ | „Arvustused · Ootab 1“ (phone) · pills „Ootab kinnitust 1“, „Avaldatud 5“, „Peidetud 1“ (counts new; labels exist) · „Lisa arvustus +“ · card buttons „Avalda“, „Peida“, „Muuda“, switch „Avalehel“ (exist) · UndoBar „Arvustus avaldatud.“ · answer drawer link „Vaata arvustust →“

**C7 Testimine** — header (H) „UX-pass · 42 kontrolli · 31 läbitud · 2 viga“ · „Värskenda“ (exists) · group labels „OLEK“ / „KES“ (R: „Olek“ / „Kes“) · pills „Kõik“, „Avatud 9“, „Viga 2“, „Läbitud 31“; „Mina“, „Kõik“ · area line „7 / 9“ + progress bar · check row: „Sammud ▸“, segmented „Läbitud“ | „Viga“ · empty „Selle valikuga kontrolle pole.“ (R) · SaveStatus „checking“ while „Värskenda“ is busy; 401 → „Salvestamata — logi uuesti sisse“

**C8 Sisselogimine** — lead „Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.“ · „Muu aadress“ · sent state „Link on teel“ / „Saatsime lingi aadressile {email}. See kehtib 15 minutit.“ / „Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.“ · rate limit „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“ · page title (exists) „Halduse sisselogimine“ · submit (H) „Saada sisselogimislink“ (exists: login.submit) · label (H) „E-post“ (exists)

---

## 4. README vs HTML disagreements about strings (and other README-internal conflicts)

| # | Where | README says | HTML says | Outcome |
|---|---|---|---|---|
| D1 | SaveStatus „saved“ | „Salvestatud {HH:MM}“, draft „Mustand salvestatud {HH:MM}“ | prints a check mark: „✓ Salvestatud 12:04“, „✓ Mustand salvestatud 14:02“; phone shortens to „✓ Mustand 14:02“, „✓ 20:35“, „✓ 11:20“ | Desktop „✓ Salvestatud {HH:MM}“, „✓ Mustand salvestatud {HH:MM}“ (README text, desktop mock ✓). Phone page chip „✓ Mustand 14:02“, „✓ 11:20“ (phone mock); phone drawers keep the full form. |
| D2 | „gone“ state | „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ | A2 mock for a missing registration: „Seda registreerimist ei leitud.“ + „← Registreerimised“ (this is the existing string, admin.ts L215); the parked list says the stale-tab error became „Seda enam ei ole“ (no {asi}, no second sentence) | Chip: „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ (README). Drawer opened on a missing registration: „Seda registreerimist ei leitud.“ + „← Registreerimised“ (desktop mock; README silent). |
| D3 | A3 protocol back link | „← Protokollid“ | A3 note: „← Protokollid“; P2 table: „← Protokollid“ / „← {kust tuli}“ | „← Protokollid“ (README); „← {kust tuli}“ drops out. |
| D4 | A3 empty index | „Viimase 14 päeva jooksul koolituspäevi polnud.“ + „← Kalender“ | not drawn; the index shows a note „Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.“ that README never mentions | Empty state „Viimase 14 päeva jooksul koolituspäevi polnud.“ + „← Kalender“ (README); index note „Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.“ (desktop mock; README silent). |
| D5 | Registreerimine drawer note hint | hint „Näeb ainult haldus.“ (label „Märkus“) | desktop label „Märkus — näeb ainult haldus“, phone label „Märkus“ with no hint; today's text is „Märkust näeb ainult haldus.“ (admin.ts L248) | Label „Märkus“ with hint „Näeb ainult haldus.“ (README, no phone exception); the mock's „Märkus — näeb ainult haldus“ and the hint-less phone label lose. |
| D6 | „Tühista registreerimine“ | danger button at the bottom → ConfirmPanel (item 6) | A2 mock draws it as a fourth folded row („Tühista registreerimine“ … „ConfirmPanel ▸“) | Danger button „Tühista registreerimine“ at the bottom of the drawer, opening the ConfirmPanel (README); not a fourth folded row. |
| D7 | A2 ConfirmPanel line 2 | „Laekunud {x} € ja arved jäävad alles.“ | P1 §3.3 sample: „Laekunud 175 € ja arve MSL2026-004 jäävad alles.“ (singular, with the number) | „Laekunud {x} € ja arved jäävad alles.“ (README); the P1 sample with an invoice number is example data. |
| D8 | A6 search scope | Maksed: name, e-mail and Montonio id; Arved: number and name | Maksed phone placeholder „Otsi nime või Montonio id järgi“ (no e-mail); Arved placeholder „Otsi nime, e-posti või arve numbri järgi“ (adds e-mail) | ASK DIM — the mocks' placeholders promise another search scope than the README (Arved placeholder adds e-mail; Maksed phone placeholder omits the e-mail the README requires). |
| D9 | B2 lesson visibility | switch „Õpilastele nähtav“ with the existing hint | P3 note: switch „Õpilastele nähtav / Peidetud“; hint in HTML „Õppetunnil on õpilaste edenemist — seda saab ainult peita.“ (existing: „… edenemist: seda saab ainult peita.“, admin.ts L1392) | Switch „Õpilastele nähtav“, no „/ Peidetud“ (README); hint „Õppetunnil on õpilaste edenemist — seda saab ainult peita.“ (desktop mock; README says only "the existing hint"). |
| D10 | B3 date/time hint | hint „Muudetud — teavita {n} õpilast ise.“ | P3 note: the line „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ is shown in the warning colour next to the field; the mock prints „Muudetud — teavita 4 õpilast ise.“ | Both lines (README): drawer-top notice „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“ and, after a date or time change, field hint „Muudetud — teavita {n} õpilast ise.“ |
| D11 | B3 start label | „Algus (Eesti aeg)“ | desktop mock prints „Algus“; only the phone mock prints „Algus (Eesti aeg)“ | „Algus (Eesti aeg)“ on desktop and phone (README); the desktop mock's bare „Algus“ loses. |
| D12 | B3 refusal to delete | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ | P1 §3.3: „Toimumisel on registreeringuid — märgi see „Tühistatud“.“ | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ (README, P3 mock); the shorter P1 §3.3 form loses. |
| D13 | B4 contract ConfirmPanel | question + the count (or „kehtib uutele registreeringutele“) | mock has two bullets and „Jah, avalda“; P3 note shows a single sentence „… 7 aktiivset õpilast peavad selle uuesti kinnitama.“ | „Kas avaldan uue e-koolituse lepingu?“ + „{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.“ + „Vana leping jääb alles ja märgitakse asendatuks.“ (desktop mock); contact contract: „kehtib uutele registreeringutele“ (README). |
| D14 | B4 next-number preview | „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“ | P3 note: „Järgmine: MS LAB 2026-93“ / „MSL2026-007“; P3 table: „Järgmine arve: {nr}“ / „Järgmine tunnistus: {nr}“ | „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“ (README); the mock's MSL2026-007 is an instance of it. |
| D15 | B4 sections | six: Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs | P3 note says "grouped into five sections" then lists six | Six sections: Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs (README); the note's "five" is a slip. |
| D16 | B5 send-all ConfirmPanel | "existing count text" + „Jah, saada {n} tellijale“ | P1 §3.3 bulk-send mock: question „Kas saadan kirja „Jõulupakkumine“?“ + three consequence lines (the existing „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?“ is a different sentence) | Question „Kas saadan kirja „{nimi}“?“ + the three consequence lines of the P1 mock (§3.1 above); yes „Jah, saada {n} tellijale“, no „Katkesta“ (README yes label, P1 mock). |
| D17 | B5 test send | select „{address} · {eesti / vene keeles}“ + button „Saada proov“ | P3 note: informed button „Saada proov · maria@… · eesti keeles“; phone mock: „Saada proov · maria@… · ET“; desktop mock: select + plain „Saada proov“ | Desktop: select „{aadress} · {eesti\|vene keeles}“ + button „Saada proov“ (README, desktop mock). Phone: informed button „Saada proov · maria@… · ET“ (phone mock). |
| D18 | A4 test-review send | „Saada · {õ} õige, {v} vale“ | P1 §3.3: „Saada test tagasi · 1 vale“ | „Saada · {õ} õige, {v} vale“ (README, P2 mock); „Saada test tagasi · 1 vale“ loses. |
| D19 | C4 | "one preview that follows LangSwitch"; „Lehel näidatakse“ choice | P3: choice stays; P4: "a two-state switch at the top" with UndoBar „Hüpikaken peidetud.“; the editor today has three options (Kampaania / Uudiskiri / Väljas) and two popups with two previews | ASK DIM — see spec D3 |
| D20 | C6 focus | "focus stays on the row after an action" | P4: "After „Avalda“, focus moves to the next waiting card" | Focus stays on the row after an action (README); the P4 note "moves to the next waiting card" loses. |
| D21 | C6 click claim | – | P3: "Approve a waiting review from the menu 2 → 2"; P4: "Publish a waiting review from the menu 3 → 2" | Nothing to build: a click-count remark only. Build the README's badge link `?vaade=arvustused&olek=ootel` and instant „Avalda“. |
| D22 | Q-status of B11–B20 | line 7: "B11–B20 are still to decide (see §5)" | §5 heading "all accepted (B1–B22)"; P3 final list, P4 intro ("All of B1–B22 are now accepted") and the deck ("22 / 22") agree with §5 | B1–B22 all accepted (README §5). |
| D23 | LangSwitch modes | two modes ET, RU (Q4) | P1 component table still says „ET / RU / Kõrvuti“ and "side-by-side and copy-from-ET modes" (the prototype code has a `both` state but no UI for it) | Two modes only, „ET“ \| „RU“; no „Kõrvuti“ (README, Q4). |
| D24 | C4 route | "Routes don't change" | P4 prints `/admin/hupikaken`; the real route is `/admin/kampaania` (sections.ts) | Route stays `/admin/kampaania` — "Routes don't change" (README); `/admin/hupikaken` is only the Part 4 label. |
| D25 | Trainer gallery limit | – | C2 mock „4 / 12“; the editor's limit is 24 (`LIMITS.works` in domain/site-editor.ts); course galleries 20 | ASK DIM — mock counter „4 / 12“ implies a limit of 12, the code allows 24, and the design never says the limit changes. |
| D26 | Sidebar group gap | 8 px gap above a label | P1 prototype uses 10 px (`pt:i?10:0`), AdminSidebar.dc.html and the phone menu use 8 px | 8 px above a group label (README; AdminSidebar and phone menu agree); the P1 prototype's 10 px loses. |
| D27 | Parked „left“ list | lists 7 left items | P3 final list has 8: it also lists „Märgi saadetuks“ for a stuck send — left (moot); README omits it | README's seven left items; „Märgi saadetuks“ is left too (moot), so nothing extra is built. |
| D28 | Menu badge sum (mock) | "On the phone, the menu button shows the sum" (P1) | P1 mock shows „13“ = 3+2+7+1; the badges drawn also include „Maksed ja arved 6“ (sum 19); A1 queue shows 6 unbilled + 1 held (badge rule would give 7, mock badge says 6) | ≡ shows the sum of the numeric menu badges (phone mock; README silent); the Maksed ja arved badge follows README's rule; the mock's 13 and 6 are sample figures. |

---

## 5. Strings that appear in two (or more) wordings

| # | Meaning | Wordings | Outcome |
|---|---|---|---|
| W1 | Registration note hint | „Näeb ainult haldus.“ (R) · „Märkus — näeb ainult haldus“ (H) · „Märkust näeb ainult haldus.“ (today) | „Näeb ainult haldus.“ as the hint under the label „Märkus“ (README). |
| W2 | Refusal to delete a booked session | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ (R, P3) · „Toimumisel on registreeringuid — märgi see „Tühistatud“.“ (P1 §3.3) · today „Sellel toimumisel on registreerimisi, seda ei saa kustutada. Märgi see hoopis „Tühistatud“: …“ | „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ (README, P3 mock). |
| W3 | Test-review send button | „Saada · {õ} õige, {v} vale“ (R, P2) · „Saada test tagasi · 1 vale“ (P1 §3.3) | „Saada · {õ} õige, {v} vale“ (README, P2 mock). |
| W4 | Practical-work send | „Saada hinnang · {k} kinnitatud, {p} paranda“ (R) · „Saada hinnang · 3 kinnitatud“ (P2 note, deck „Saada hinnang · 5 kinnitatud“; the ", 0 paranda" part is dropped when nothing is to fix, not stated in README) | „Saada hinnang · {k} kinnitatud, {p} paranda“ (README); „Saada hinnang · {k} kinnitatud“ when nothing is to fix, „, 0 paranda“ dropped (mocks). |
| W5 | Sample send in Uudiskiri | select + „Saada proov“ (R, P3 table) · „Saada proov · maria@… · eesti keeles“ (P3 note) · „Saada proov · maria@… · ET“ (P4 phone) | Desktop: select + button „Saada proov“ (README, desktop mock). Phone: „Saada proov · maria@… · ET“ (phone mock). The P3 note form loses. |
| W6 | Language names in the sample select | „eesti keeles“ / „vene keeles“ (R) · „ET“ (phone) · today „Eesti keeles“ / „Vene keeles“ (newsletter.campaigns.test.languages) | Desktop: „eesti keeles“ / „vene keeles“ (README). Phone: „ET“ (phone mock). |
| W7 | „not found“ / gone | „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ (R) · „Seda enam ei ole“ (P3 parked) · „Seda registreerimist ei leitud.“ (A2 mock, today's) | Chip: „Seda {asja} enam ei ole. Tekst on selles seadmes alles.“ (README). Missing drawer: „Seda registreerimist ei leitud.“ (desktop mock). Same as D2. |
| W8 | Back from a protocol | „← Protokollid“ · „← {kust tuli}“ (P2) | „← Protokollid“ (README). |
| W9 | Publish bar, phone | „Avaldamata 3 · Eelvaade“ + „Avalda“ (P4) · „Avaldamata 3 · Avalda“ (P3 note) · desktop „Avaldamata muudatused: 3 …“ + „Avalda muudatused“ | Desktop: „Avaldamata muudatused: {n}“ + „Avalda muudatused“ (README). Phone: „Avaldamata {n} · Eelvaade“ + „Avalda“ (phone mock); the P3 note form loses. |
| W10 | Contract re-accept ConfirmPanel | „… 7 aktiivset õpilast peavad selle uuesti kinnitama.“ (P3 note) · „… peavad selle järgmisel sisselogimisel uuesti kinnitama.“ (mock) | „{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.“ (desktop mock); same as D13. |
| W11 | Next number preview | see D14 (three forms) | „Järgmine arve: {prefix}{year}-{nnn}“ / „Järgmine tunnistus: MS LAB {year}-{n}“ (README); same as D14. |
| W12 | Lesson visibility switch | „Õpilastele nähtav“ (R) · „Õpilastele nähtav / Peidetud“ (P3 note) | „Õpilastele nähtav“ (README); same as D9. |
| W13 | Open a registration | „Ava registreering“ (R, mocks, invoices.row.openRegistration) · „Ava registreerimine“ (today in requests.openRegistration L928 and clients.drawer.openRegistration L983) · phone short forms „Registreering“ | Desktop: „Ava registreering“ (README, mocks). Phone: „Registreering“ (phone mock). Today's „Ava registreerimine“ is replaced. |
| W14 | Mark-a-letter buttons | „Vasta e-kirjaga ↗“ (desktop) · „Vasta ↗“ (phone) | Desktop: „Vasta e-kirjaga ↗“ (README, desktop mock). Phone: „Vasta ↗“ (phone mock). |
| W15 | Course form pill | „Kontaktõpe“ (desktop pills) · „Kontakt“ (phone pills) — „Kontakt“ is also the request tab name | Desktop: „Kontaktõpe“ (desktop mock). Phone: „Kontakt“ (phone mock). The request tab „Kontakt“ is a separate thing. |
| W16 | Waitlist | „ootenimekirjas {n}“ (desktop, today „Ootenimekirjas {n}“ calendar.waitlist) · „ootel {n}“ (phone) | Desktop: „ootenimekirjas {n}“ (README, desktop mock). Phone: „ootel {n}“ (phone mock). |
| W17 | Card payment method | pill „Kaart“ (A2 mock) · today `paidMethodText("card")` = „Kaardimakse kohapeal“ (domain/invoice.ts) | Pill „Kaart“ (README, A2 mock). The design words no receipt method text, so today's „Kaardimakse kohapeal“ stays there. |
| W18 | Faq card | „Korduma kippuvad küsimused“ (today home.faq.title) · „KKK“ (design map and heading) | „KKK“ (desktop mock: section map and card heading; README silent). |
| W19 | E-course contract | „E-koolituse leping“ (design) · „E-koolituse leping (tingimused)“ (today settings.courseTerms) | „E-koolituse leping“ (README, mocks). |
| W20 | Contact settings card | „Kontakt“ (design) · „Kontaktandmed“ (today) | „Kontakt“ (README section map). |
| W21 | Page eyebrow over the H1 | A6: „Montonio“ (P1 page list, today payments.eyebrow) · „Montonio ja raamatupidamine“ (P2 mock) · C5: „Praktika“ (P1, today) · „Koolitused“ (P4 mock) | A6: „Montonio ja raamatupidamine“; C5: „Koolitused“ (the screens' own desktop mocks P2 / P4; P1's page list gives „Montonio“ / „Praktika“). |

---

## 6. `admin.ts` keys the design makes dead (delete or reuse when the screen is built)

Derived from the tables above; line numbers are today's. "Reuse" means the same words are still wanted by the new component.

| Group | Keys |
|---|---|
| SaveBar family (SaveBar.tsx, `useSiteDraft` status texts) | `editor.save` L1635 · `saving` L1636 (reuse: SaveStatus „Salvestan…“) · `saved` L1637 · `dirty` L1638 (reuse: „Salvestamata muudatused“) · `clean` L1639 · `invalid` L1640 · `stale` L1641 · `reload` L1642 |
| Course editor save line | `courseEditor.save` L1319 · `saving` L1320 · `saved` L1321 · `dirty` L1322 · `invalid` L1323 · `stale` L1324 · `reload` L1325 |
| Lessons | `lessons.save` L1344 · `lessons.drawer.saved` L1372 · `closeQuestion` L1374 · `closeYes` L1375 · `closeNo` L1376 · `hide` L1387 · `show` L1388 · `hiddenNote` L1389 (check) · `lessons.saveFirst` L1337 (not named by the design) |
| Registration drawer money/status | `registrations.drawer.paidLabel` L241 · `paidHint` L242 · `paidSave` L243 · `paidSaved` L244 · `paidInvalid` L245 (reuse for „Muu summa“) · `statusSave` L250 · `statusSaved` L251 · `stale` L252 (becomes the SaveStatus conflict) |
| Kalender | `calendar.form.save` L1478 · `saved` L1479 · `timeHint` L1468 · `registrations` L1480 (replaced by the „{n} õpilast on registreerunud …“ notice) |
| Seaded cards | `invoices.settings.save/saving/saved/invalid/error` L455–459 · `certificates.settings.save/saving/saved/invalid/error` L1060–1064 · `contracts.settings.save/saving/saved/invalid/error` L556–560 |
| Overview | `overview.lead` L142 · `primary` L143 · `more` L144 · `stats.*` L145–150 · `assessment.*` L166–169 · `inbox.*` L170–174 · `links.*` L175–180 |
| Hindamine | `certificates.register.fromAssessment` L1104 · `assessment.screen.confirmTitle … confirmNo` L701–706 (the panel goes) · `assessment.empty` L729 (reworded) · `assessment.groups` L730 (becomes row words) |
| Protocols | `protocols.sendAll` L623, `confirm.title` L628, `confirm.yes` L637, `confirm.no` L638 (reworded); `protocols.toCalendar` L588, `toRegistration` L589 (replaced by „← Protokollid“ / „← {kust tuli}“) |
| Õpilased | `clients.search` L940 (the „Otsi“ button) · `clearSearch` L941 · `searchLabel` L939 (reworded) · `grant.draft` L995 + `openUntil` L997 (merge into one select line) |
| Uudiskiri | `newsletter.campaigns.saveFirst` L1562 · `test.to` L1566, `test.language` L1569, `test.toMaria/toMe` L1567–1568 (one select) · `newsletter.csvConfirmed` L1495 + `csvAll` L1496 (one button) · every „kampaania“ string (B5-7) |
| Shell | `shell.viewSite` L93 (sidebar footer link; phone menu footer keeps the idea with `shell.preview` L96) · `shell.signedInAs` L98 (tooltip → text line) |
| Login | `login.lead` L44 · `sentTitle` L49 · `sent` L50 · `sentHint` L51 · `again` L52 · `errorTooMany` L54 (inferred pairs for the new sent state and rate-limit message; the design gives new text, not the old keys) |
