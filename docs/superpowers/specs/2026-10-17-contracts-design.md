# Contracts ("Lepingud") — design

Phase 4, piece 3 of 6 (order agreed by Dim 16.10.2026). Dim chose to skip the questions for phase 4; every decision not attributed to Dim or Maria is my call and says so.

## 1. Why

Maria (01.10.2026, C52): "Adminnipaneelis võiks lepingu sõlmimise võimalus olla. Koolituskeskuse ja õpilase vahel. Võimalusel digiallkirjaga kinnitamine." Dim (16.10): Maria has no contract text yet, "maybe this should be possible to manage from somewhere".

Today a student ticks a box and nothing proves what she agreed to:
- **Contact course.** The registration form's „Olen tutvunud tingimustega ja nõustun nendega." links to the public „Õppetingimused" page, and the tick is not stored.
- **E-course.** The terms gate stores only a version number, so the text she accepted is lost the next time Maria edits it.

**Success:**
- For every registration and every e-course access there is one contract.
- The contract holds the exact text the student agreed to, who she is, what she bought, and when she agreed.
- Both sides keep it as a PDF: the student in her account and her mail, Maria in the admin.
- Maria writes and edits the contract text herself.

**Anti-goals:**
- A contract whose text changes after it was accepted.
- A student asked to accept twice for one booking.
- An extra step that slows registration.
- Collecting her personal ID code without a reason.

## 2. Decisions

- **D1. Accepting is the tick she already gives, before she pays** (my call; the builder check pointed out that terms must be readable before the order). No new step:
  - **Contact course (group).** The registration form's box becomes „Olen tutvunud lepingu tingimustega ja nõustun nendega." and its link opens the contract **inline** („Loe lepingut"), with the placeholders filled live from the form: the course, the chosen session, the price and the payment choice. The same fill function runs on the server. Submitting with the box ticked is the acceptance.
    - **The form sends the version of the text it showed** (amended 17.10 during the build, ruling R6): a hidden field on the registration form, the cart's purchase input, the terms gate's version and „Kinnitan"'s version. The server compares it with the current version, and refuses a different one, or a missing one, with „Lepingu tekst on vahepeal muutunud — loe see uuesti ja kinnita." (Draft, ET and RU). Nothing is stored; the form shows the new text and clears the box. Why: Maria may save a new text between the page and the submit, and a student must never accept a text she did not see. The version is read before the text and again after it, so a save in between is refused too.
    - **Only the version is compared** (amended 17.10 during the build, ruling R17): the session and the price are the server's facts, filled at the moment of acceptance and printed in the PDF's „Koolitus" block. If the session moves in the seconds between reading and „Kinnitan", the contract freezes the current facts. This holds for the form, the gate and „Kinnitan" alike.
  - **E-course purchase.** The cart's box does the same with the e-course contract text, which therefore becomes readable before buying. The contract is frozen when the payment is **paid** (in settle's transaction, beside the access grant), with the acceptance time = the order's start and the price = the paid amount. The terms gate is then already satisfied for that version, so she is not asked twice.
    - **A purchase always freezes its own contract** (amended 17.10 during the build, ruling R4). It never takes the shortcut the gate takes: whatever contract the access has (a free grant's, a gate's, an earlier purchase's, even of the same version) is superseded by the purchase's, which carries the paid price. One access row serves a free grant followed by a purchase and a renewal, and each paid purchase is a contract of its own.
    - **The acceptance time is the press of „Maksa", not the order's start** (amended 17.10 during the build, ruling R7). The snapshot on the payment carries its own `acceptedAt`, the moment it was filled (a re-send refills it); settle uses it as `accepted_at`, so the acceptance never predates its text, and falls back to the payment's start only for a snapshot kept before it carried one. The access's earlier contract is superseded at the settle's time, so `superseded_at` is never before the replacement exists.
    - **The parties are the payment's** (amended 17.10 during the build, ruling R8): the contract's student is the name and e-mail the payment carries, the ones the snapshot was filled with, so the text's `{nimi}` and the PDF's „Pooled" agree. The account's own name may differ and is not used.
    - **The cart sends the version it showed** (amended 17.10 during the build, ruling R6, above): „Maksa" is refused with the same words when the e-course text changed since the cart was loaded, and the cart asks for the box again.
  - **E-course access Maria grants for free** („Ava ligipääs"), and any student whose accepted version is older than the current text: the existing terms gate („Olen tutvunud ja nõustun tingimustega" + „Alusta koolitust") is the acceptance and freezes the contract (no price).
    - **The gate shows what it freezes** (amended 18.10 during the build, ruling R18): the contract's title above its text, both filled with the placeholders exactly as the acceptance freezes them, in the page's language (the Estonian contract on a Russian page when no Russian text exists). Why: the gate showed the raw text with `{nimi}` and `{koolitus}` and no title, while the contract froze the filled text with its title, so a student could agree to words she never saw, and a change of the title alone (R11) looked like no change.
    - **A student with no name gives hers at the gate** (amended 18.10 during the build, ruling R19): when her account's name is empty (Maria added her by address only, „Lisa õpilane", as for an e-course bought by bank transfer), the gate has one required field „Nimi" (Draft; Russian „Имя"), and `{nimi}` in the text fills as she types. The acceptance takes the name on one line and within the account form's limit (120 characters), refuses a missing one with „Kirjuta oma nimi." (Draft; Russian „Напишите своё имя.") and stores nothing, freezes it as the contract's student (`{nimi}` and „Pooled"), and saves it as her account's name in the same transaction, under the access's lock, only while that is still empty: a name she saved in „Minu andmed" meanwhile is never overwritten. An account with a name sees no field, and a name sent anyway is ignored. Why: a frozen contract cannot be corrected afterwards, and D3 names the student by her name and e-mail.
  - **The shared dictionary text.** The registration form and the cart share `forms.terms` today. Each gets its own contract wording, so the public „Õppetingimused" page and footer link stay as they are for everything else.
  - **Individual courses are out of scope** for now. Their form stores a request with no session, price or payment choice, and no admin action turns one into a registration. Their form keeps today's box and link. They get contracts once individual bookings exist.
- **D2. Two contract texts, both Maria's, edited in Seaded** (Dim: manageable from somewhere):
  - „Kontaktkoolituse leping": new, page key `contract_contact`.
  - „E-koolituse leping": the existing „E-koolituse tingimused" text (`course_terms`), renamed in the admin to say it is the e-course contract. Its editor and version bump stay as they are.
  - **The e-course text has a title of its own** (amended 17.10 during the build, ruling R11). The text is frozen with a title (§3), so the e-course editor gains an optional title field (the hint suggests „E-koolituse leping"), and the contract's title is the page title as Maria writes it. A change of the title alone bumps `courseTermsVersion`: the title is part of the frozen text, so a changed title is a changed contract, and every student is asked once more at the gate. This replaces "its editor and version bump stay as they are" for the title.
  - Both are plain paragraphs, ET + RU, in the existing legal-text editor („Tühi rida alustab uut lõiku.").
  - Placeholders Maria may use in the text: `{nimi}`, `{e-post}`, `{koolitus}`, `{toimumine}` (date and place), `{hind}`, `{ettemaks}`. They are filled at acceptance.
  - **The place is the city and the venue** (amended 17.10 during the build, ruling R2). `{toimumine}`, the PDF's „Toimumine" row and the registration drawer (not the registrations list) name a session as its date, its city and its venue when it has one: "14.11.2026, Tallinn, Pärnu mnt 1". The date is on Tallinn's calendar. A session without a venue reads "14.11.2026, Tallinn".
  - A text without placeholders is fine: the PDF's header carries all of this anyway (§5).
  - Until Maria writes the contact text, the form shows the current public „Õppetingimused" text as the contract text (my call: never block registration).
- **D3. A contract is a frozen copy, made at acceptance** (my call). The row holds, as accepted:
  - the text she was shown (title and paragraphs, in her language), with the placeholders filled;
  - the template version;
  - the parties:
    - the school: from Seaded → „Arve andmed": company, registry code, address;
    - the student: name, e-mail;
  - the course, the session (date and place), the price and the payment choice;
  - the acceptance time and the way: the form, the account, or the terms gate.

  Later edits of the template, the course, the price or Seaded never change an accepted contract.
- **D4. Asking again when needed** (my call). Maria can press „Saada leping kinnitamiseks" on a group registration that has none, or whose session or terms changed after acceptance.
  - **Recording the ask.** The press sets `registrations.contract_requested_at` (cleared when she accepts) and mails her a link to her account. There the card shows „Kinnita leping" with the current text filled in, and „Kinnitan" makes a new contract. The old one stays, marked „Asendatud".
    - **The ask mail** (amended 17.10 during the build, ruling R9): „MS LAB leping kinnitamiseks" (ET and RU, Draft). A short greeting, one line saying Maria asks her to confirm the contract for the course, and one button to her account's page in her language (/konto, /ru/konto). It is a plain link: no login token, no code, no address in it. It goes to the registration's address after the ask is recorded, best effort: never to a sample address, nothing without Resend, and a failure only logged. The press is offered on any linked, not cancelled group registration, with or without a current contract (the session or the terms may have changed since the acceptance).
    - **The press and „Kinnitan" in either order** (amended 17.10 during the build): both take the registration's row lock first, so the ask and the acceptance at the same moment leave one current contract, and the ask flag says who came last (set when the ask did, cleared when „Kinnitan" did). A second „Kinnitan" finds the ask answered, writes nothing and answers 409. Proved on real Postgres by `tests/e2e/contracts-race.spec.ts`.
  - **A student with no account.** The button is only offered when the registration is linked to an account. Otherwise the drawer says „Õpilasel pole kontot — lisa ta Õpilased lehel." (Draft). The mail carries a plain link, not a login.
  - **Existing data is forward-only.** The site is not public yet, so there is no backfill. E-course students re-accept through the existing version bump when Maria changes the text.
- **D7. The copy reaches her** (my call, from the builder check). Every acceptance mails her the contract PDF, attached, with „Leping on lisatud." (Draft):
  - the registration confirmation;
  - the e-course paid mail;
  - the gate;
  - the D4 „Kinnitan".
  
  Mails are best-effort, so Maria's drawer has „Saada koopia õpilasele", which resends the PDF. Each send records `contracts.sent_at`. A student without an account still has the mailed copy, and Maria keeps hers in the admin.
  - **A copy never goes without its PDF** (amended 17.10 during the build, ruling R15). „Saada koopia õpilasele" draws the PDF first and sends nothing when it cannot: the screen says „Lepingu PDF-i ei õnnestunud koostada — proovi uuesti." (Draft; Estonian only, as Maria's screens) and no mail goes out and no `sent_at` is recorded. The automatic mails (the registration confirmation, the paid mail, the gate, „Kinnitan") may still go without the PDF and without „Leping on lisatud." when it fails to draw: they are best effort and Maria's copy is the repair.
- **D5. No digital signature, no personal ID code** (my call, from C52's "võimalusel"). A qualified e-signature (Smart-ID, Mobile-ID, ID card) costs per signature through a provider, and Dim keeps costs minimal. The contract is concluded in a form reproducible in writing: an explicit tick by the signed-in or registering student, logged with its time, and a PDF copy sent to her. A provider-based signature can be added later without changing the stored contracts.

  The personal ID code is not collected. The student is identified by name, e-mail and her booking.

  This is not legal advice. Maria's text and her accountant or lawyer decide what the contract says.
- **D6. Languages.** The contract is stored and printed in the language the student read: RU when the RU text exists and she registered in RU, else ET. The admin always shows it in the stored language.

## 3. Data (migration 0013, additive)

`contracts` columns:
- `id`;
- `kind`: `contact` or `ecourse`;
- `registration_id`, `access_id`, `course_id`, `client_id`: each set null on delete;
- `version`: the template's;
- `locale`;
- `title`, `body`: the filled, frozen text;
- `fields`: jsonb, holding the school, the student, the course, the session text, the price text and the payment choice text;
- `payment_id`: set null on delete; for an e-course bought online;
- `accepted_at`;
- `accepted_via`: `form`, `purchase`, `account` or `terms`;
- `sent_at`: the last time the PDF was mailed;
- `superseded_at`, set when a newer contract replaces it;
- `created_at`.

Indexes: on `registration_id`, `access_id` and `client_id`.

At most one current (not superseded) contract per registration and per access, enforced by a partial unique index where `superseded_at` is null.

**Whose contract it is is read, never written** (amended 17.10 during the build, ruling R14). A form contract is frozen before the student has an account (`client_id` null), and linking her registrations at sign-in changes no stored contract. So the owner is worked out when a contract is read: `coalesce(the registration's client_id, the access's client_id, the contract's own client_id)`, the live link first. A registration Maria re-links to another client takes its contracts to that client and shows them to one client only. Maria's client drawer and the student's card, download and „Kinnitan" all use this one rule (`contractsOfClient`, `contractForStudent`), and so does the copy's „no account" check. No stored contract is changed by it: frozen rows stay frozen.

The settings key `contractContactVersion` mirrors `courseTermsVersion`. `registrations` gets `contract_requested_at` (nullable; D4). `payments` gets `contract_snapshot` (jsonb, nullable: an e-course purchase's shown contract, §4).

## 4. Flows

- **Registration form (contact, group).**
  - The box text and the inline contract change (D1). The form sends the version of the text it showed; a different or missing version stores nothing and is answered with the words of D1 (amended 17.10 during the build, ruling R6).
  - On a successful submit, the contract is inserted in the same transaction as the registration. The waiting list and individual requests get none.
  - The confirmation mail attaches the contract PDF, „MS-LAB-leping-{id}.pdf", with the line „Leping on lisatud." (Draft).
- **E-course purchase.** The cart shows the contract inline (D1). Settle's paid transaction inserts the contract next to the grant, from what the cart showed: the purchase's start stores the filled title, text, version and locale on the payment row (`payments.contract_snapshot`), and settle copies it into the contract. A text Maria edits between the cart and the payment does not change what is frozen. The snapshot also carries the moment it was filled (`acceptedAt`), which settle records as the acceptance, and the contract names the payment's student; a purchase supersedes the access's current contract whatever its version (amended 17.10 during the build, rulings R4, R7, R8: D1).
- **E-course terms gate** (free grants and re-acceptance). `acceptTerms` also inserts the access's contract in the same transaction. A repeat acceptance of the same version makes no second contract. The gate's text is the contract as it will be frozen, title and all, in both page languages (amended 18.10 during the build, ruling R18: D1), and an account with no name gives hers there, which the contract freezes and the account keeps (amended 18.10 during the build, ruling R19: D1).
- **Account.**
  - The course card shows a quiet line „Leping · kinnitatud {date}" with „Laadi alla (PDF)".
  - If Maria asked again (D4) and the current text is not accepted, the card instead shows „Kinnita leping" as an action that opens the text with „Kinnitan".
  - The card finds its contract by the owner rule of §3 (amended 17.10 during the build, ruling R14): a contract frozen at the registration form, before she had an account, is on her card once the registration is linked to her. „Kinnitan" sends the version of the text the card showed (ruling R6): if Maria saved a new text meanwhile, the card reads the new text and shows the words of D1 before the next press.
- **Admin.**
  - **The registration drawer:** a block „Leping". It shows the current contract (accepted date, way, „Laadi alla (PDF)"), any superseded ones, and „Saada leping kinnitamiseks".
  - **The client drawer (Õpilased)** lists the student's contracts, newest first, each with its PDF and, for a contact contract, a link to its registration. It replaces the drawer's earlier list of e-course terms acceptances, so an acceptance made before contracts existed no longer shows there (amended 17.10 during the build, ruling R13; the site is not public yet and existing data is forward-only, D4). The contracts it lists are the client's by the owner rule of §3 (ruling R14).
  - **Seaded:** a card „Lepingud" with the contact text (title + body, ET/RU), a placeholders hint and „Näidisleping (PDF)". The e-course text keeps its card, titled „E-koolituse leping (tingimused)", now with a title field of its own (amended 17.10 during the build, ruling R11: D2). It has the contact card's placeholders hint too, since the cart and the gate fill the same placeholders (amended 18.10 during the build, ruling R18).
    - **The sample is a form POST** (amended 17.10 during the build, ruling R12): „Näidisleping (PDF)" posts the texts on the screen, saved or not, to `/api/admin/naidisleping` and opens the answer in a new tab. A contract text may be up to 40 000 characters, which would overflow a URL, so it is not a link with the text in its query. The PDF is drawn from the posted values and nothing is stored; a Russian sample button appears once a Russian text is written.

## 5. The PDF

A4 portrait, white, Jost, the MS LAB logo (reusing `pdf-logo.ts`). Multi-page, with paragraphs wrapped and pages broken as needed. A shared text helper is extracted from `invoice-pdf.ts`.

Blocks, in order:
1. The title.
2. "Pooled": the school (company, registry code, address) and the student (name, e-mail).
3. "Koolitus": the course, the session, the price and the payment choice.
4. The text's paragraphs.
5. The closing line: „Kinnitatud elektrooniliselt {date time}, {name} ({e-mail})", plus the way.

The PDF is rendered on every download from the frozen row, like invoices, and is deterministic.

## 6. Edge cases

- **Text changes.** Maria edits the text after acceptance: the stored contract is unchanged, and new registrations get the new version.
- **Session moves.** A change request moves the session: the current contract stays. Maria may ask again (D4), and the new one supersedes the old. The new one names the session as it is at the moment she presses „Kinnitan" (amended 17.10 during the build, ruling R17: only the text's version is compared, D1).
- **Lost registration or access.** The registration is cancelled or deleted, or the account is deleted: the contract stays, with set-null links and frozen parties. Maria still sees it in the „Lepingud" list on the client or registration while those exist, and only through those.
- **Seller missing.** „Arve andmed" is empty at acceptance: the school block shows "MS LAB", and the PDF says nothing false. A registry code or an address Maria has typed there is still printed under "MS LAB" when the company name is empty (amended 17.10 during the build, ruling R2): the block prints what she wrote and invents nothing.
- **Gate.** The coming-soon gate stays as it is for every account route.

## 7. The test plan (standing rule)

New checks (`"mark": "new"`, `"markedAt": "deploy"`):
- the registration's box and the mailed contract PDF;
- the e-course gate's contract;
- the card line and the download;
- „Saada leping kinnitamiseks" → „Kinnita leping" → superseded;
- Seaded's „Lepingud" card and „Näidisleping".

The registration-form and terms-gate checks get `redo`.

## 8. Out of scope

- Qualified e-signatures.
- Collecting the personal ID code.
- Contracts for practice packages or products.
- A contract per instalment plan (piece 6 may add one).
- Rich text: headings and lists in the contract. Paragraphs only, as all legal texts today.
- A public archive page.

## 9. Left to the builder

- The PDF's layout within §5.
- The Estonian and Russian texts beyond those quoted. They are marked Draft for Dim's wording sheet.
- Whether the client drawer's list links to the registration drawer.
