# Admin UX pass, piece 4 — texts of the C screens (DRAFT for Dim)

**Not approved yet.** Dim answers §1 and approves §2 in one sitting. After that the builder uses §2 verbatim, §3 as listed, §4 as the keys that go, and §5 as defaults.

Piece 4 = the C screens (SPEC §8 item 4), with B19 and B20:
- C1 Avaleht `/admin/avaleht`
- C2 Koolitaja `/admin/koolitaja`
- C3 Uudised `/admin/uudised`, `/admin/uudised/[id]`
- C4 Hüpikaken `/admin/kampaania`
- C5 Praktika `/admin/praktika`
- C6 Tagasiside `/admin/tagasiside`
- C7 Testimine `/admin/testimine`
- C8 Sisselogimine `/admin/login`

---

## 0. How to read

**Short names** (as in P3T):
- ADM = `app/src/i18n/dict/admin.ts`. Line numbers are as of main `714c684` (after piece 3b). P3T's numbers were of `c258a52`; where P3T named a line, both are given ("ADM:2311, P3T's ADM:2168").
- ET / RU = `app/src/i18n/dict/et.ts` / `ru.ts` (the public site).
- README = `docs/superpowers/specs/admin-ux-pass/handoff/README.md` (line numbers of the file).
- P1 / P3 / P4 = `handoff/MS LAB Admin UX Pass.dc.html` / `… - Part 3.dc.html` / `… - Part 4.dc.html` (line numbers of the file).
- SPEC = `docs/superpowers/specs/2026-10-21-admin-ux-pass-design.md`.
- STR / BEH / SCR = `analysis/strings.md` / `behaviours.md` / `screens.md`.
- P2T / P3T = `analysis/piece2-texts.md` / `analysis/piece3-texts.md` (both approved).
- "SPEC S4" is the sign-in rule. This sheet's own items are S4-1 … S4-47 (texts) and S4-Q1 … S4-Q5 (decisions).

**Source order** (SPEC D1): the README → the desktop mock → the phone mock (only for what only the phone shows) → the notes in the prototypes.

**Kind of each text:**
- **drawn**: the design prints it. It is copied verbatim; approving it confirms the copy.
- **pattern**: built from a drawn or approved text by an approved rule, which is named. No new choice of words.
- **new**: the design is silent. It is drafted here, and the reason is given.

**House style** (P2T, P3T):
- Result lines end with a full stop; labels and buttons do not.
- „…“ quotes for the names of buttons, fields and titles; sentence case.
- Parts are joined with " · "; the long dash " — " has spaces.
- ConfirmPanel: question → plain lines → „Jah, {tegusõna}“ / „Katkesta“.
- Informal „sina“; a refusal that says "changed meanwhile" ends „Vaata see üle.“
- Public Russian uses the site's „вы“ form (ru.ts).

Admin text is Estonian only. Two texts leave the admin, so they also get Russian: the popup's button (S4-Q4, on the public home page) and one welcome-mail line (S4-Q3).

## Counts

- **5 decisions for Dim** (§1, S4-Q1 … S4-Q5): 2 come from silences (Q2, Q3), 3 from conflicts (Q1, Q4, Q5).
- **47 text items to approve** (§2, S4-1 … S4-47):
  - 9 hold **new** wording: S4-1 and S4-34 (the one phrase „{MINI|MAXI} punktid“), S4-3, S4-19, S4-20, S4-23, S4-28, S4-38, S4-40;
  - the rest are **drawn** or **pattern**, and each says which;
  - the two public texts (RU + ET) are in §1, not here.
- **Covers everything in P3T §5:**
  - UndoBar nouns: S4-3;
  - the C6 review bars: S4-38;
  - C3's `Puudub: …` labels, „Uus postitus“ with its slug, and the `post.remove.confirm` re-skin: S4-22, S4-19, S4-23;
  - the PublishBar labels: S4-1, S4-12, S4-17, S4-24, S4-30, S4-34;
  - the C4 popup and its pointer to „Seaded → Tervituskood“: S4-25 … S4-30 and Q2–Q4;
  - C8: S4-47, which is fully specified;
  - the leads that mention saving: S4-6, S4-32;
  - the „Lisa arvustus +“ drawer: S4-39;
  - D25 (the gallery counter): S4-15.
- **Not asked again:**
  - D3, D5 and D25 (decided);
  - the test-page rulings of 22.10 (the note box under every answer, the Telegram ping, the comment bubble);
  - Automaattest (Dim 25.10);
  - every older „(Draft)“ text (Dim 26.10);
  - all texts approved in pieces 1–3 (§3).

---

## 1. Decisions only Dim can make

### S4-Q1 — Uudised: what „Avalda“ checks on a post  [conflict: P4 note vs the app's language rule]

**Dim 26.10: A** (cover + title and text in ET and RU).

- **Where:** C3. The check runs on „Avalda muudatused“ for a published post, and on the „Avaldatud“ switch for a post never published.
- **Sources:**
  - README:292 says only "the cover image is checked by „Avalda“, not by save".
  - The P4 note (P4:227) adds: "checks the cover image, title and text in both required languages, and lists anything missing („Puudub: kaanepilt“)".
  - The app requires Estonian only, everywhere: ADM:6 „Täida see väli (eesti keeles).“ An empty Russian field shows the Estonian on the RU page (ADM:1461). A post's „Tekst“ is optional today (`server/admin-site.ts:613-626`).
  - So "both required languages" asks for something the app never asks.
- **Recommended — A, as the note reads.** The check needs the cover, plus the title and text in both Estonian and Russian. The bar lists only what is missing, e.g. `Puudub: kaanepilt, tekst (RU)`. The Estonian title never reaches the check, because an empty one is held at the field (B3).
- **B.** The check needs the cover, the title and the text in Estonian; Russian stays optional. E.g. `Puudub: kaanepilt, tekst`.
- **C.** Today's rule with the cover moved to „Avalda“: the cover and the Estonian title. E.g. `Puudub: kaanepilt`.
- **For Maria:**
  - A: a post goes live only once its Russian title and text are written.
  - B: a post can no longer go live without its text.
  - C: nothing new except the moment of the cover check.

### S4-Q2 — Hüpikaken: „Soodustus (%)“ and Seaded's „Tervitussoodustus“  [silent]

**Dim 26.10: A** (one value, on Hüpikaken only).

- **Today:** the discount is one setting, Seaded → Uudiskiri → „Tervitussoodustus“ (ADM:2354). It is a text such as „10%“. The footer's sign-up block shows it („… {discount} tervitussoodustus …“, ET:367; RU:336).
- **The design:** it draws the field „Soodustus (%)“ on Hüpikaken (P4:278). It never draws what is inside Seaded's „Uudiskiri“ section.
- **Recommended — A: one value, edited on Hüpikaken only.**
  - „Soodustus (%)“ is a whole number. The footer shows it as „10%“, as now.
  - Seaded → Uudiskiri keeps „Tervituskood“. Its „Tervitussoodustus“ field and hint (ADM:2354-2355) go.
  - Like every field in the „Pakkumine“ card, it waits for „Avalda muudatused“, and the footer changes with it.
- **B: the same value in both places.** Either field changes it, but each place saves its own way: a draft here, straight away in Seaded.
- **C: two values.** The popup has its own figure, which nothing outside the editor shows; the footer keeps Seaded's.
- **For Maria:** with A she sets the discount on Hüpikaken and publishes it there, and Seaded no longer shows it.

### S4-Q3 — Hüpikaken: what „Kood kehtib (päeva)“ does  [silent]

**Dim 26.10: A** (the welcome mail says how long the code is valid).

- **Today:** nothing like it exists.
  - The code is the one shared Seaded → „Tervituskood“.
  - It goes out in the welcome mail right after sign-up (`server/newsletter.ts` `sendWelcome`; ET:398-407).
  - Maria takes the discount off the invoice by hand (ET:404).
  - D3 keeps the field ("as Part 4 draws it", P4:278).
- **Recommended — A: the welcome mail says it.** One line after the code's lines, which show only when a code is set. If the field is empty, there is no line. Maria checks the date herself when she applies the discount.
  - ET: `Kood kehtib {n} päeva.`; for n = 1: `Kood kehtib 1 päev.`
  - RU: `Код действует {n} дней.`, with the number forms:
    - `{n} день` for 1, 21, 31 …;
    - `{n} дня` for 2–4, 22–24 …;
    - `{n} дней` for all others, including 11–14.
  - (The code is valid for {n} days.)
- **B:** the figure is for Maria only, and the mail says nothing.
- **C:** the field is left out. That goes against D3.
- **For Maria:** with A, new subscribers read how long their code is valid, and she checks it by the subscription date.

### S4-Q4 — The popup's button  [conflict: drawn in Russian only; a public text; SPEC §11 keeps the public side out]

**Dim 26.10: A** (the popup button follows the code).

- **Today:** the popup uses the footer's form, with the button „Liitu“ / „Подписаться“ (ET:370, RU:339).
- **The design:** the Part 4 preview draws `Получить код` (P4:281), "Get the code", and no Estonian.
- **The catch:** Seaded's code may be empty, and then no code is mailed (ADM:2357).
- **Recommended — A: the button follows the code.**
  - While Seaded has a „Tervituskood“, the popup's button reads ET `Saa kood`, RU `Получить код` (drawn).
  - With no code, it keeps `Liitu` / `Подписаться`.
  - The footer's form keeps „Liitu“ in every case.
- **B:** `Saa kood` / `Получить код` always.
- **C:** `Liitu` / `Подписаться` always, as today.
- **For Maria:** nothing changes in the admin. With A, visitors see the button promise the code only when one will come.

### S4-Q5 — Tagasiside: the stars on a review card  [conflict: drawn, no data]

**Dim 26.10: B** — stars from the linked feedback answer's „Hinne“ (0–10): 9–10 ★★★★★, 7–8 ★★★★, 5–6 ★★★, 3–4 ★★, 0–2 ★ (the controller's split of „9–10 = 5, 7–8 = 4 …“); no stars on a review Maria added (no score).

- **The design:** the P4 card draws „★★★★★“ (P4:357, 410).
- **The data:** a review has no rating (reviews spec; nor does a review Maria adds). Only the feedback answer has a score, „Hinne“ 0–10 (ADM:1076).
- **Recommended — A: no stars.** The card starts with its state pill.
- **B:** stars from the linked answer's score (9–10 = 5 stars, 7–8 = 4 …), and none on a review Maria added.
- **For Maria:** with A the card shows what it shows today; with B she also sees the student's score.

---

## 2. Texts to approve, per screen

**Dim 26.10: all texts S4-1…S4-47 approved as drafted** (with S4-29 reworded and the S4-Q1…Q5 answers applied).

Column "Replaces" names the key whose words change or go; "—" means a new key.

### Shared by the C editors

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-1 | **PublishBar labels** (rules; per screen in S4-12, -17, -24, -30, -34): a field: its visible label without a unit in brackets („Soodustus (%)“ → `Soodustus`) · a field in a list row: `{rida} {n} {väli}`, e.g. `Slaid 2 pealkiri`, `KKK küsimus 4`, `MAXI hind`, `MAXI punkt 4` · only the Russian text changed: `{silt} (RU)`, e.g. `Slaid 2 pealkiri (RU)` · rows added, removed or moved: the list's card title, `Slaidid`, `KKK`, `Galerii`, `Numbrid`, and for a package's points `{MINI\|MAXI} punktid` | (field labels of the "unpublished changes" bar) | pattern P3T P-3; drawn P4:161, P3:276, P4:305; **new**: „… punktid“ (the card title „Sisaldab“ does not read after the package name) | — |
| S4-2 | **`Puudub: {väljad}`** with the S4-1 labels, the first letter in lower case except KKK, MINI, MAXI: `Puudub: kaanepilt`, `Puudub: slaid 3 pilt`, `Puudub: KKK vastus 6` | (Missing: …) | drawn P4:227; pattern S3-P3-b (ADM:234) | — |
| S4-3 | **UndoBar nouns:** a slide `Slaid eemaldatud.` · a FAQ row `Küsimus eemaldatud.` · a package point `Rida eemaldatud.` · a trainer gallery picture `Pilt eemaldatud.` | (Slide removed. / Question removed. / Row removed. / Picture removed.) | **new** noun for slides (S3-P3-d shape); FAQ = S3-P3-d's test-question words; points and pictures = S3-P3-d (ADM:1469, 1693; drawn P1:356) | — |
| S4-4 | **SaveStatus „gone“ words:** a post `Seda postitust enam ei ole. Tekst on selles seadmes alles.` · a review Maria added (its edit drawer) `Seda arvustust enam ei ole. Tekst on selles seadmes alles.` | (This post / review no longer exists. The text is still on this device.) | pattern P3T P-2 (ADM:194); cf. ADM:2274, 1158 | — |

Notes:
- S4-1: the same labels name the field in the leave notice, e.g. „Muudatust „Slaid 2 pealkiri“ ei saanud veel salvestada.“ (README:75; P2T P-12).
- S4-2: under B3 an invalid field is held at the field (ADM:190), so the bar lists only what is checked at publish. Mostly that is a post's cover and text (S4-Q1). It also covers an incomplete row, wherever an editor keeps one in the draft (BEH "May the stored state be incomplete").
- S4-4: Avaleht, Koolitaja, Praktika and Hüpikaken are single records, so like Seaded they have no „gone“ state (P3T P-2).

### C1 Avaleht

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-5 | `Koduleht` (eyebrow) | (Website) | drawn P4:160, P1 PAGES; STR C1-3 | ADM:2141 `home.eyebrow` „Avaleht“ |
| S4-6 | `Avalehe slaidid, MS LABi lause ja korduma kippuvad küsimused. Muudatus on avalehel näha pärast avaldamist.` | (… The change shows on the home page after publishing.) | pattern P3T P-5 (as `badge.lead`, ADM:1534) | ADM:2143 `home.lead` (P3T's ADM:2000) „… Pärast salvestamist on muudatus avalehel kohe näha.“ |
| S4-7 | Card and section-map names: `Koolitaja kaart` · `KKK`; the map's value for the link entry `→` | (Trainer card · FAQ) | drawn P4:402-403, P3:352; STR W18 | ADM:2180 `teaser.title` „Koolitaja kaart avalehel“; ADM:2186 `faq.title` „Korduma kippuvad küsimused“ |
| S4-8 | `Muuda lehel Koolitaja →` (the link row under the title „Koolitaja plokk“) | (Edit on the Trainer page →) | drawn README:290, P3 note | ADM:2199-2200 `home.trainer.text`, `link` „Ava Koolitaja“ |
| S4-9 | Slide row, second line: `RU: {pealkiri}`; with no Russian title `RU: RU puudub` | (RU: {title} / RU: RU missing) | drawn P3:353 (`'RU: '+…`), README:290 "ET title + RU line"; the doubled „RU“ is the mock's | — |
| S4-10 | In the open slide: the hint `Puuduta pilti, et valida fookus` before the button „Vaheta pilt“ · the field `Alapealkiri` · the button `Eemalda slaid` | (Tap the picture to choose the focus · Subtitle · Remove slide) | drawn P4:169-170 | the slide card's focal hint ADM:2129 (kept by other images); ADM:2167 `slides.text` „Tekst“; visible text for ADM:2153 (its name stays „Eemalda slaid {n}“) |
| S4-11 | FAQ row state: `ET · RU` when both texts exist; `RU puudub` when the Russian question or answer is empty | (ET · RU / RU missing) | drawn P4:404; `RU puudub` = ADM:1493 | — |
| S4-12 | PublishBar labels: `Slaid {n} pilt`, `… väike pealkiri`, `… pealkiri`, `… alapealkiri`, `… nupu tekst`, `… nupp viib`, `… toon`, `… näidatakse avalehel` · `Slaidid` · `MS LABi lause` · `Koolitaja kaart` · `KKK küsimus {n}`, `KKK vastus {n}` · `KKK` | (bar labels) | drawn `Slaid 2 pealkiri` (P4:161), `KKK küsimus 4` (P3:276); rest pattern S4-1 | — |

Notes:
- S4-10: „Alapealkiri“ is read as the slide's text, because the mock puts it under the title, which is where the public slide prints its text. The kicker („Väike pealkiri“, ADM:2164) prints above the title and keeps its label. A slide's focal points count as „pilt“.

### C2 Koolitaja

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-13 | `Koduleht` (eyebrow) | (Website) | drawn P4:205; STR C2-2 | ADM:2223 `trainer.eyebrow` „Koolitaja“ |
| S4-14 | Cards: `Portree ja tutvustus` (picture, Nimi, Amet, Tutvustus) · `Galerii` | (Portrait and introduction · Gallery) | drawn P4:209-211, 405 | ADM:2226 `trainer.card` „Koolitaja“; ADM:2244 `works` „Koolitaja tööd“ |
| S4-15 | Gallery hint `Lohista järjekorra muutmiseks · {n} / 24` · the add tile `+ Lisa` | (Drag to reorder · {n} / 24 · + Add) | drawn P4:211; the 24 is Dim 26.10 (D25) | ADM:2245 `worksHint` |
| S4-16 | An empty story card, folded: `tühi` + the button `Lisa tekst` · the section map's value `tühi` | (empty · Add text) | drawn P4:212 („tühi · Lisa tekst ▸“, the ▸ is the component's), P4:405 | — |
| S4-17 | PublishBar labels: `Portree` (picture and focal points) · `Nimi` · `Amet` · `Tutvustus` · `Numbrid` · `Galerii` · `Koolituskeskuse lugu` · `Koolitaja teekond` (a story's title or text) | (bar labels) | pattern S4-1 (ADM:2227-2247) | — |

Notes:
- S4-15: the tile's name for a screen reader is „Lisa pilte“ (ADM:1514).
- S4-15: the picture's ✕ and ↑/↓ keep the shared gallery's names (ADM:1689-1691).

### C3 Uudised

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-18 | List: search `Otsi pealkirja järgi` · button `Lisa postitus +` · row line `{staatus} · {dd.mm}`, with `—` for a post with no date · no search hit `„{q}“ järgi postitusi ei leitud.` + „Tühjenda otsing ja filtrid“ | (Search by title · Add post + · {status} · {date} · No posts found for „{q}“.) | drawn P4:237-238, 408; status words ADM:2260, 2261, 1563; pattern P2T P-9 (ADM:1505-1506) | ADM:2259 `news.col` (the table goes) |
| S4-19 | „Lisa postitus +“ makes the post at once: title `Uus postitus`, slug `uus-postitus`, or `uus-postitus-2`, `uus-postitus-3` … when taken; the cursor goes to „Pealkiri“ | (New post; new-post, new-post-2 …) | drawn P4:228; **new**: the slug form. SPEC S8 asks only for a unique placeholder, so it is the title's own slug plus a number, which the slug rule already allows (ADM:8) | ADM:2272 `newTitle` (kept) |
| S4-20 | Editor footer line: `Avaldatud {dd.mm.yyyy} · /uudised/{slug}`; a post never published: `Mustand · /uudised/{slug}` | (Published {date} · address / Draft · address) | drawn P4:248; **new**: the draft form (the same shape with the status word, ADM:2261) | — |
| S4-21 | Back link below 1180 px: `← Uudised` | (← News) | pattern README:119 („← {Lehe nimi}“), as „← Koolitused“ in 3a | ADM:2275 `post.back` „Tagasi uudiste juurde“ and the crumb (ADM:2269) |
| S4-22 | Under the bar (a published post) or under „Avaldatud“ (a new one): `Puudub: kaanepilt`; with S4-Q1 A also `tekst`, `pealkiri (RU)`, `tekst (RU)`; with B `kaanepilt`, `tekst` | (Missing: cover picture, text …) | drawn P4:227; pattern S4-2 | — |
| S4-23 | „Kustuta postitus“ ConfirmPanel: `Kas kustutan selle postituse?` · `Postitus kaob blogist ja avalehelt.` (only for a published post) · `Seda ei saa tagasi võtta.` · `Jah, kustuta` / `Katkesta` · result in the list `Postitus kustutatud.` | (Shall I delete this post? · It disappears from the blog and the home page. · This cannot be undone.) | README:292 ("keeps its ConfirmPanel (with the new words)"); split as P2T P-13, P3T P-7; **new**: the public line, because P1 §3.3 asks the panel to say what changes in public (words of ADM:2292) | ADM:2295 `post.remove.confirm`; ADM:2297 `no` „Ei“; ADM:2265 kept |
| S4-24 | PublishBar labels: `Pealkiri` · `Aadress` · `Kategooria` · `Lühitekst` · `Tekst` · `Kuupäev` · `Kaanepilt` | (bar labels) | drawn `Tekst` (P4:243); rest pattern S4-1 (ADM:2276-2288) | — |

Notes:
- S4-19: the existing line `Postitus loodud. Lisa kaanepilt ja avalda, kui kõik on valmis.` (ADM:2273) shows after the tap.
- S4-19: the slug follows the title until the post is first published (SPEC S8).
- S4-23: if Dim wants the post's name in the question, as P3T S3-P3-f did for a letter, the question becomes `Kas kustutan postituse „{pealkiri}“?`.

### C4 Hüpikaken

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-25 | Under the switch „Lehel näidatakse“: `Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul` | (Opens for a new visitor after 8 s · once in 30 days) | drawn P4:272; D3 | ADM:2306 `campaign.lead` (drawn line in its place, as B1's note replaced its lead, P3T §4) |
| S4-26 | Switch off: UndoBar `Hüpikaken peidetud.` + „Võta tagasi“ · switch on: no bar · refused because the published popup lacks a required field: the switch stays off and says `Puudub: {väljad}` under it, e.g. `Puudub: pilt` · refused because another tab changed it: `Hüpikakent muudeti vahepeal. Vaata see üle.` | (Popup hidden. / Missing: picture / The popup was changed meanwhile. Check it.) | drawn P4:261; pattern P2T P-14 and S3-P3-c (no bar for a switch's own reverse), S4-2, P2T W7 | ADM:2307 `shown` (kept, now the switch's label); ADM:2308 `shownOptions` |
| S4-27 | Card `Pakkumine` with `Pealkiri` · `Tekst` · `Soodustus (%)` · `Kood kehtib (päeva)` | (Offer · Title · Text · Discount (%) · Code valid (days)) | drawn P4:275-278; D3. What the two numbers do: S4-Q2, S4-Q3 | ADM:2309-2310 `form` „Kampaania“, `newsletterForm` „Uudiskiri“; ADM:2313-2314 kept |
| S4-28 | Under the two numbers: `Koodi saad muuta: Seaded → „Tervituskood“.` | (You can change the code in Settings → Welcome code.) | **new**: rewords the pointer of ADM:2311 (P3T's ADM:2168). The rest of that sentence („Liitu“, „pärast kinnitamist“, the window) no longer fits the screen. If Dim wants the card exactly as drawn, it goes | ADM:2311 `campaign.newsletterLead` |
| S4-29 | Under the preview: `Reeglid: kood saadetakse e-postiga kohe pärast liitumist; üks kasutus tellija kohta; ei liitu teiste soodustustega.` (**Dim 26.10:** the first part reworded — there is no confirmation step since 09.10; the drawn text said „kood saadetakse pärast e-posti kinnitamist“) | (Rules: the code is sent after the e-mail is confirmed; one use per subscriber; not combined with other discounts.) | drawn P4:282; D3 | ADM:2327 `rules` + ADM:2328-2335 `rulesList` (six lines) |
| S4-30 | PublishBar labels: `Silt` · `Pealkiri` · `Tekst` · `Pilt` · `Soodustus` · `Kood kehtib` (the switch acts at once, never on the bar) | (bar labels) | pattern S4-1 (ADM:2312-2321) | — |

Notes:
- **S4-29 (answered 26.10, reworded as above):** since 09.10 the sign-up has no confirmation step. The address is stored as confirmed, and the welcome mail with the code goes out at once (`server/submit.ts:676-700`). So „pärast e-posti kinnitamist“ describes the old flow. It is built as drawn (D3) unless Dim rewords it.
- S4-29: the same old phrase is in Seaded's hint ADM:2357 (piece 3b's screen) and in ADM:2311, which S4-28 replaces. Ruling (controller, following Dim's S4-29 answer): Seaded's hint drops „pärast e-posti kinnitamist“ the same way in piece 4.

### C5 Praktika

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-31 | `Koolitused` (eyebrow) | (Courses) | drawn P4:304; STR W21 | ADM:2205 `practice.eyebrow` „Praktika“ |
| S4-32 | `MINI ja MAXI pakett: nimi, lühitekst, modellide arv, kestus, hind ja punktid. Avaldades uuenevad praktikaleht ja avalehe praktikaplokk.` | (… Publishing updates the practice page and the home page's practice block.) | pattern P3T P-5 (one word: „Salvestades“ → „Avaldades“) | ADM:2207 `practice.lead` (P3T's ADM:2064) |
| S4-33 | Card title `MINI` / `MAXI` · points list `Sisaldab` · add `+ Lisa punkt (või Enter viimasel real)` | (MINI / MAXI · Includes · + Add a point (or Enter on the last row)) | drawn P4:293, 311, 313, 409 | ADM:2208 `package` „Pakett {code}“; ADM:2216 `items` „Paketi punktid“; ADM:1467 `list.add` „Lisa rida“ on this list only |
| S4-34 | PublishBar labels: `{MINI\|MAXI} nimi` · `… lühitekst` · `… modelle` · `… kestus` · `… hind` · `… punkt {n}` · `… punktid` | (bar labels) | drawn `MAXI hind`, `MAXI punkt 4` (P4:305); **new** `… punktid` (S4-1) | — |

### C6 Tagasiside

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-35 | Page-header button `Lisa arvustus +` · the phone's tab `Arvustused · Ootab {n}` (at 0: `Arvustused`) | (Add review + · Reviews · Waiting {n}) | drawn P4:338, 356 | ADM:1137 `form.add` (+ „+“, now in the page header) |
| S4-36 | Pills `Ootab kinnitust {n}` · `Avaldatud {n}` · `Peidetud {n}` · filtered empty `Selle valikuga arvustusi pole.` + „Tühjenda otsing ja filtrid“ | (Waiting / Published / Hidden {n} · No reviews in this selection.) | drawn P4:340 (labels ADM:1111); shared frame ADM:1503, as P2T P-9 did for Päringud | ADM:1113 `reviews.emptyFiltered` „Selles vaates arvustusi pole.“ |
| S4-37 | Card: the review's text in „…“, then `{nimi} · {koolitus} · {dd.mm.yyyy}` | (name · course · date) | drawn P4:345-346, 410 | — |
| S4-38 | UndoBars: after „Avalda“ `Arvustus avaldatud.` · after „Peida“ `Arvustus peidetud.` · after „Kustuta“ on a review Maria added `Arvustus kustutatud.` · „Avalehel“: no bar · an undo refused because the review changed meanwhile: `Arvustust muudeti vahepeal. Vaata see üle.` | (Review published. / hidden. / deleted. / The review was changed meanwhile. Check it.) | drawn P4:359; **new** „peidetud“ (shape of „Hüpikaken peidetud.“), „kustutatud“ (SPEC §7 gives manual reviews `removed_at` for undo, so the ConfirmPanel goes; shape of ADM:2265); refusal pattern P2T W7; switch pattern P2T P-14 | ADM:1129-1131 `deleteConfirm`, `deleteYes`, `deleteNo`; ADM:1133 `deleted` „Arvustus on kustutatud.“ |
| S4-39 | „Lisa arvustus“ drawer: title `Uus arvustus` · header `Täida kohustuslikud väljad`, then `Vajuta „Lisa arvustus“.` · create button `Lisa arvustus` · `Katkesta` · leaving with typed text: the leave notice with `Arvustust pole veel lisatud.` | (New review · Fill the required fields · Press „Add review“. · Add review · Cancel · The review has not been added yet.) | README:298 (explicit create; cancel „Katkesta“); pattern S3-P3-g (ADM:213), P3T P-6 (button = list button without „+“), „Uus …“ as ADM:1583, 1873 | ADM:1150 `form.save` „Salvesta“; ADM:1151 `form.cancel` „Tühista“ |
| S4-40 | Vastused: search `Otsi nime või e-posti järgi` · `Selle valikuga vastuseid pole.` + „Tühjenda otsing ja filtrid“ · `„{q}“ järgi vastuseid ei leitud.` + „Tühjenda otsing ja filtrid“ | (Search by name or e-mail · No answers in this selection. · No answers found for „{q}“.) | **new** placeholder: the P4 note (P4:330) asks for a list with search and draws no placeholder; an answer carries the student's name and e-mail, and an e-course answer has no phone. Shared frames ADM:1503, 1505 | ADM:1079 `feedback.emptyFiltered` „Selle koolituse kohta pole tagasisidet.“ |
| S4-41 | Answer drawer: `Vaata arvustust →` (when the answer has a review; it opens Arvustused at that card) · beside it `Ava õpilane →` · `Ava registreering →` | (See the review → · Open student → · Open registration →) | drawn in the P4 note (P4:330; README:299 gives the link, not its words); the other two pattern P2T P-8, W13 | ADM:1084-1085 `toStudent` „Õpilase juurde“, `toRegistration` „Registreeringu juurde“ |

Notes:
- S4-39: „Muuda“ on a review Maria added opens the same drawer, titled „Muuda arvustust“ (ADM:1138). It autosaves with SaveStatus in its header; its „gone“ word is in S4-4.
- S4-39: the required fields are today's (ADM:1140-1147).

### C7 Testimine

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-42 | `Haldus` (eyebrow) | (Administration) | drawn P4:380, P1 PAGES | — (testplan has no eyebrow) |
| S4-43 | Line under the H1: `{n} kontrolli · {k} läbitud · {v} viga`; n = 1: `1 kontroll` | ({n} checks · {k} passed · {v} faulty) | drawn P4:380 without the mock's „UX-pass ·“ (the plan has no name, `src/data/testplan.json`); n = 1 as P3T P-8 | ADM:2417 `testplan.progress` |
| S4-44 | Group labels `Olek` · `Kes` · Olek pills `Kõik` · `Avatud {n}` · `Viga {n}` · `Läbitud {n}` · Kes pills `Mina` · `Kõik` · `Automaattest` | (Status · Who · All · Open · Fault · Passed · Me · All · Automatic test) | drawn README:303, P4:381 (capitals are CSS); „Automaattest“ kept (Dim 25.10, ADM:2419) | ADM:2418 `filter` („Vead“ → „Viga“; „Muudetud“ goes); ADM:2419 `who` „Maria“, „Dim“, „Koos“ as choices |
| S4-45 | Check row: `Sammud ▸` (the steps, „Miks“ and „Mida näed“ fold behind it) · answers `Läbitud` \| `Viga` | (Steps ▸ · Passed \| Fault) | drawn P4:385; SPEC §9, §10 | ADM:2428 `ok` „OK“; ADM:2430 `skip` „Jäta vahele“ goes |
| S4-46 | Empty filter: `Selle valikuga kontrolle pole.` | (No checks in this selection.) | drawn README:305 (shared frame ADM:1503) | — |

Notes:
- S4-45: the answer word also changes in the last-answer line (ADM:2433), in Automaattest's line, and in the Telegram note (ADM:2444, `{status}`): „Läbitud“.

### C8 Sisselogimine (written; SPEC S4)

| # | Estonian, as it ships | English | Kind and source | Replaces |
|---|---|---|---|---|
| S4-47a | Lead `Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.` | (We send you a sign-in link. Open it on the device you want to sign in on.) | drawn README:308, P3:313 | ADM:47 `login.lead` |
| S4-47b | Beside the remembered address: `Muu aadress` | (Another address) | drawn README:309, P3:313 | — |
| S4-47c | Sent: `Link on teel` · `Saatsime lingi aadressile {email}. See kehtib 15 minutit.` · `Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.` · `Muu aadress` | (The link is on its way · We sent the link to {email}. It is valid for 15 minutes. · No mail? Check spam or send again in 1 minute.) | drawn README:311, P3:316; SPEC S4, §10 (the same for any address) | ADM:52 `sentTitle`, 53 `sent`, 54 `sentHint`, 55 `again` „Sisesta aadress uuesti“ |
| S4-47d | The 4th request for the same typed address within 10 minutes: `Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.` | (You have already sent 3 links. Try again in 10 minutes.) | drawn README:312, P3:306; B20, SPEC S4 (counted per typed address, allowed or not) | — |

**Is C8 fully specified? Yes.** The README writes every state, and SPEC S4 settles the counting. One case is silent: the per-connection limit of 5 requests in 10 minutes across any addresses (`server/ratelimit.ts`). It keeps today's text (§5). Every other C8 text is unchanged (§3).

---

## 3. Reused approved texts (not asked again)

**Piece 1 (approved 21.10, built):**
- SaveStatus words (ADM:178-197).
- The leave guard and its reasons (ADM:201-215).
- PublishBar words (ADM:220-245): „Avaldamata muudatused: {n}“, „Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“, the discard panel, the phone forms, „· avaldamata“ (ADM:237).
- „Katkesta“, „Sulge“, „Võta tagasi“ (ADM:169-171).
- LangSwitch: „RU puudub {n} väljal“, „Järgmine →“, „Kopeeri eesti keelest“, „tõlge tulekul“ (ADM:1449-1461).
- The list frames (ADM:1501-1510) and the error page (ADM:87-89).
- The badge labels „{n} arvustust ootab“ and „{n} viga“ (ADM:116, 118).

**Piece 2 (P2T, approved 22.10):**
- P-9: a search with no hit.
- P-12: leave-notice names.
- P-13: a ConfirmPanel split at the „?“.
- P-14: no bar for a switch's own reverse.
- W7: the "changed meanwhile" shape.
- P-8 / W13: forward links „Ava … →“.

**Piece 3 (P3T, approved 23.10; Dim 24.10):**
- S3-P3-a: „Avalikul lehel on näha eelmine versioon.“ on every bar (ADM:231).
- S3-P3-b: the `Puudub:` and "changed meanwhile" texts (ADM:234-235), and the rule that piece 4 asks only its own labels.
- S3-P3-d: „Rida eemaldatud.“, „Pilt eemaldatud.“, and „Küsimus eemaldatud.“ as words (ADM:1469, 1693).
- S3-P3-g: the new-record header and `notCreated` (ADM:213).
- S3-P3-m: the drag handle and the move announcement. Slides, FAQ, points and gallery rows use the row forms „Lohista rida {n}“ / „Rida {n} on nüüd {k}. kohal.“ (ADM:1479, 1485). Their arrows keep their own names: slides ADM:2151-2152, FAQ ADM:2192-2193, pictures ADM:1689-1690.
- P-2: the „gone“ shape. P-3: the label rule. P-5: rewording a hint that names saving.
- D-1 „Lõpeta eelvaade“; D-2 the publish and discard failure lines (ADM:240-244).

**Dim's rulings:**
- D3 (S4-25 … S4-29).
- D5: focus stays on the row in Tagasiside.
- D25: „{n} / 24“ (S4-15).
- Test page, 22.10: the note box under every answer, with „Mis läks valesti?“ under „Viga“ and „Märkus“ under the others (ADM:2431-2432). The first note on any answer pings Telegram (ADM:2441-2445).
- Automaattest, 25.10: the Kes choice and the quiet line under a check (ADM:2419, 2434; `TestPlan.tsx`).

**Drawn and already in the dictionary, unchanged:**
- Shell and template:
  - H1s: „Avaleht“, „Koolitaja“, „Uudised“, „Hüpikaken“, „Praktikapaketid“, „Tagasiside“, „Testimine“, „Halduse sisselogimine“;
  - eyebrows „Blogi“, „Turundus“, „Õpilased“ (ADM:2255, 2304, 1068);
  - „Vaata lehel ↗“ (ADM:2116);
  - the phone bar „Avaldamata {n} · Eelvaade“ + „Avalda“ (P4:185).
- C1: „Slaidid“, „MS LABi lause“, „Koolitaja plokk“, „Hele“ / „Tume“, „+ Lisa slaid“ (ADM:2149), „Vaheta pilt“ (ADM:2123), „Pealkiri“ (ADM:2165). The other slide fields, FAQ „Küsimus“ / „Vastus“, and the statement and teaser fields and hints.
- C2: „Nimi“, „Tutvustus“, „Numbrid“, „Koolituskeskuse lugu“, „Koolitaja teekond“. The numbers' inputs keep the names „Number {n}“ / „Selgitus“ (ADM:2236-2238).
- C3: every post field and hint (ADM:2277-2292), and „Kustuta postitus“ (ADM:2294).
- C4: „Turundus“, „Hüpikaken“, „Lehel näidatakse“, „Pealkiri“, „Tekst“, „Silt“, „Pilt“, „Eelvaade“ and its note (ADM:2304-2323), plus the public popup's answer „Aitäh, oled liitunud! …“ (ET:377, RU:346).
- C5: „Praktikapaketid“, „Hind (€)“, „Modelle“, „Kestus“, „Nimi“, „Lühitekst“ and their hints (ADM:2206-2219).
- C6:
  - „Vastused“ | „Arvustused“ (ADM:1090);
  - „Avalda“, „Peida“, „Muuda“, „Kustuta“, „Avalehel“, the status words, „Lisatud käsitsi“, the proof line, „Keel: {locale}“, „Allikas: {note}“, the home hint, the form's fields and warning (ADM:1107-1153);
  - the errors (ADM:1155-1161);
  - the answers' columns, count, empty line and drawer (ADM:1067-1087).
- C7: „Värskenda“, „Ava“, „Mida näed“, „Miks“, „Loob andmeid“, the device and who chips, „{done} / {total}“, the overview card (ADM:2419-2446).
- C8: „Halduse sisselogimine“, „E-post“, „Saada sisselogimislink“, „Saadan…“, the errors „Sisesta korrektne e-posti aadress.“, „Midagi läks valesti. Proovi uuesti.“, `errorLink`, `errorServer`, the logo's label, and the login mail (ADM:46-78).

---

## 4. Dead keys piece 4 removes

Keys only reworded are in §2's "Replaces" column. These go:

| Screen | Keys | Why |
|---|---|---|
| C1–C5 | `editor.save`, `saving`, `saved`, `dirty`, `clean`, `invalid`, `stale`, `reload` (ADM:2108-2115) | SaveBar.tsx and `useSiteDraft` go with their last users (README §1.4). `editor.viewSite`, `newWindow`, `open`, `close`, `image.*` and `focal.*` stay |
| C1 | `home.trainer.text`, `home.trainer.link` (ADM:2199-2200) | the link row S4-8 |
| C2 | `trainer.card` (ADM:2226), `statsHint`, `addStat`, `removeStat`, `statsMax` (ADM:2235, 2239-2241) | one card „Portree ja tutvustus“; „Numbrid“ is three fixed pairs |
| C3 | `news.col` (ADM:2259); `post.crumb` (ADM:2269) with the crumb | the list is rows (P4:408); back link S4-21 |
| C4 | `campaign.lead`, `shownOptions`, `form`, `newsletterForm`, `newsletterLead`, `code`, `codeHint`, `ctaLabel`, `ctaLabelHint`, `ctaHref`, `ctaHrefHint`, `off`, `copy`, `close`, `rules`, `rulesList` (ADM:2306-2311, 2315-2320, 2324-2335) | D3: one popup, one switch, the drawn rules line. `close` is unused already |
| C4, public | ET `campaign.*` (ET:485-492) and RU `campaign.*` (RU:429-435) | the campaign-offer popup goes (D3, SPEC §10). The shared timing in `PopupDialog.tsx` / `domain/campaign.ts` changes, it does not go (§5) |
| C4 → Seaded | with S4-Q2 A: `settings.discount`, `settings.discountHint` (ADM:2354-2355) | the discount moves to Hüpikaken |
| C6 | `reviews.all` (ADM:1110); `deleteConfirm`, `deleteYes`, `deleteNo` (ADM:1129-1131); `feedback.pendingReviews` (ADM:1092) | no „Kõik“ pill (§5); undo replaces the panel; the pills with counts replace the heading's count |
| C7 | `testplan.filter.changed`, `you`, `mark.*`, `skip`, `saving`, `saved`, `retrying`, `offline` (ADM:2418, 2420, 2427, 2430, 2435-2438) | SPEC §10 („Muudetud“, „Jäta vahele“, the tags go); SaveStatus replaces the outbox line; „Sina: …“ is not drawn |
| C8 | (none; `errorTooMany` ADM:57 stays for the per-connection limit) | — |

The comment at ADM:51 („the page never tells which addresses exist“) is rewritten to SPEC S4's rule.

---

## 5. Builder notes (settled by the source order; not questions)

**All C editors**
- **The bar's buttons.** C3 and C5 draw fewer buttons on the bar (P4:243, 305). README §1.8 gives all three („Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“) on every bar, and the README wins.
- **Always drafted.** Avaleht, Koolitaja, Praktika and Hüpikaken have no unpublished state, so every edit waits for „Avalda muudatused“ (README §1.8; BEH B2).
- **Instant controls:** only those the README names act at once: the popup switch, the review „Avalda“ / „Peida“ / „Avalehel“, and a post's „Avaldatud“ (it is the post's „Avalda“, README:292). A slide's „Näidatakse avalehel“ is a drafted field.
- **Fields the mocks leave out stay** (as P3T §4 kept B5's „Nimi“ and „Pilt“):
  - C1: the slide kicker, button text and link, „Näidatakse avalehel“, both focal views;
  - C2: „Amet“;
  - C3: slug, category, excerpt, date, cover, „Avaldatud“;
  - C4: „Silt“ and „Pilt“ (the preview then shows the picture);
  - C5: „Nimi“, „Lühitekst“ and the hints.
- **Leads.** Page leads that are still true stay (ADM:2225 trainer, 2257 news, 1070 feedback, 1108 reviews), as the B list pages kept theirs. Only the two that name saving are reworded (S4-6, S4-32), and C4's lead is replaced (S4-25).
- **C4's „Vaata lehel ↗“** is on its header too (the template, README:288), and it opens the home page.

**C1, C2**
- C1: a slide opens inline, one at a time; a FAQ answer is folded (P4 note).
- C2: „Numbrid“ is three fixed pairs. An empty pair is not shown on the page.
- C2: the counter is on the trainer gallery only. The course gallery stays as 3a built it.

**C3**
- From 1180 px the list stays on the left (320 px).
- A slug that Maria types stops following the title. The slug hint (ADM:2279) is unchanged.
- At publish a slug already taken refuses with the existing ADM:2281.

**C4**
- The switch is its own part and acts on the live row (BEH B5).
- The public popup opens on the home page only:
  - 8 s after the page appears;
  - once in 30 days per browser (localStorage);
  - never again in a browser that signed up (`NEWSLETTER_SIGNED_KEY`, as now).
  - This replaces today's 6 s, once per visit (`PopupDialog.tsx`, `domain/campaign.ts`; SPEC §10).
- The consent line under the popup's button stays (ET:372, RU:340): the sign-up's consent rests on it, though the preview draws none.
- The word „kampaania“ is left on no admin screen; the route `/admin/kampaania` stays (README "Routes don't change").

**C6**
- No „Kõik“ pill, as with Tellijad (P3T §4): everything is listed until a pill is pressed, and a pressed pill toggles off. The menu badge still lands on `olek=ootel`.
- **„Muuda“ and „Kustuta“ only on reviews Maria added.** The reviews spec's rule that a student's words are never edited stands; SPEC §9 amends only undo and focus. The mock's „Muuda“ on a published card is read as such a review. „Kustuta“, not drawn, stays.
- After „Lisa arvustus“ the drawer closes with no result line, and focus returns to „Lisa arvustus +“, as today. The new review is published at once.
- Focus stays on the row (D5).
- The course select of „Vastused“ stays beside the search.

**C7**
- **Chips:** the who, device and „Loob andmeid“ chips stay. The re-test tags go (SPEC §10).
- „Ava ↗“ stays. „Sina: {name}“ goes; the sidebar footer already names who is signed in.
- „Mina“ for an admin who is not a tester (no `tester`) shows every check, as today's view does.
- **Status chip:** SaveStatus replaces the outbox line. A 401 shows „Salvestamata — logi uuesti sisse“ (ADM:192). While „Värskenda“ runs it shows „Kontrollin salvestatud teksti…“ (ADM:188).
- The empty-filter line has no clear button: there is no search, and „Kõik“ resets.

**C8**
- The per-connection limit keeps „Liiga palju katseid. Proovi mõne minuti pärast.“ (ADM:57).
- „Muu aadress“ empties the field and puts the cursor there (README:309 "to clear it"). In the sent state it returns to that form.
- The address is remembered after a request that answered „sent“.
- A `?tagasi=` that is not a same-origin `/admin` path lands on `/admin` without a word (B19).
- The `?viga=` notices and the login mail are unchanged.
