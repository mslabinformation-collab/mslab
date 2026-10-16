# Invoices ("Arved") — design

Phase 4, piece 2 of 6 (order agreed by Dim 16.10.2026: test page → invoices → contracts → reviews → newsletter campaigns → instalments; admin UX pass after). Dim chose to skip the questions for phase 4 and have the designs proposed; every decision below not attributed to Dim or Maria is my call and says so.

## 1. Why

Maria (01.10.2026, comment C53): contact courses should have "arve koostamise võimalus. 100% või 50% koolitusele registreerudes … ülejäänud 50% saab tasuda koolitusepäeval. Arve arvutisse salvestamise võimalus ja võimalus õpilasele töölauale see saata ja vajadusel ka eraldi meilile."

Today a student pays online through Montonio (prepayment, the rest, an e-course) or by bank transfer to the account in Seaded → „Ettemaksu juhised“; Maria then types the received sum on the registration („Laekunud summa“). Nothing produces a document: the student has no invoice to keep or pass to her own company, and Maria's accountant has nothing to book.

**Success:** every euro a student pays has an invoice with a number, the student finds it in her account and in her mailbox, Maria can make an invoice for a bank transfer in two taps from the registration, and at the end of the month she downloads one file for her accountant.

**Anti-goals:** an invoice missing what an Estonian invoice must carry; two invoices for one payment; a number used twice or skipped silently; a student able to open someone else's invoice; Maria entering the same payment twice (once as an invoice, once as „Laekunud summa“).

## 2. Decisions

Dim, 16.10.2026: it is not settled whether Maria opens a separate company for the academy, nor whether it is VAT-registered; she uses no accounting software (probably).

- **D1. The site makes the invoices itself** (Dim: no accounting software). The PDF is rendered like the certificate (pdf-lib, Jost; §7). A monthly CSV export serves the accountant (§6.4).
- **D2. The seller is a setting, frozen on each invoice** (Dim: the company may change). Seaded gets a card „Arve andmed": company name, registry code, address, VAT number (optional), VAT on/off and its rate, the invoice number prefix and the next number, the payment term in days, an optional footer line. The bank account (receiver, IBAN, bank) is read from the existing „Ettemaksu juhised" so it lives in one place. Each invoice copies all of it at creation; a later change of company, VAT or IBAN never alters an issued invoice.
- **D3. No invoice before the seller is filled in** (my call). Until „Arve andmed" has a company name, registry code and address, no invoice is made — online payments still work, and the „Arved" page lists them under „Arveta maksed" with „Koosta arved" once the card is filled.
- **D4. One invoice per amount due** (my call). The amounts are the ones the site already knows: a contact course's „Ettemaks 50%", „Kogu summa (100%)" or „Jääk 50%", and an e-course's price. An invoice has one line (the course, its session date for a contact course, and what part of the price it is) and one amount.
- **D5. Two ways an invoice is born** (my call):
  - **Online payments make their own, already paid.** When a Montonio payment becomes paid, the site creates its invoice (status „Tasutud", paid on the payment's time, method "Montonio"), and the existing paid mail carries it as a PDF attachment. A payment refunded or voided later keeps its invoice; the invoice shows „Tagastatud" next to it and Maria handles the accounting (credit notes are §10, out of scope).
  - **Maria makes one on a registration.** On a registration (Registreerimised → the registration) a new block „Arved" shows its invoices and a button „Koosta arve". She picks the amount from those still open — 50% / 100% / the rest, whichever apply, where "open" means *not yet covered by an invoice* (price − the sum of the registration's unpaid and paid invoices) — and one of two kinds:
    - **„Maksmiseks" (a request to pay):** an unpaid invoice („Tasumata", due date = today + the payment term) with the bank details and the payment reference. It shows in the student's account at once, and „Saada õpilasele" mails it with the PDF attached. When the money arrives, Maria presses „Märgi tasutuks" (the date, default today, and the method): **that also adds the amount to the registration's „Laekunud summa"**, so the registration confirms at 50% as today, and she does not type the sum separately.
    - **„Juba tasutud" (a receipt for money already received)** (my call, from the builder check: a transfer Maria already typed into „Laekunud summa", or the rest paid at the venue): born paid with the date and the method she gives, and it does **not** touch „Laekunud summa", which already holds the money.
    
    Typing „Laekunud summa" by hand still works as before for anything without an invoice.
  - **An unpaid invoice paid online** (my call): while a registration has an unpaid invoice, its „Maksa" (the pay page and the account's button) charges exactly that invoice's amount, and the Montonio payment is linked to the invoice when it starts. When it is paid, *that* invoice becomes „Tasutud" (method Montonio) — no second invoice is made. Without an unpaid invoice „Maksa" charges the amount it charges today (`amountDue`), and its invoice is born paid as above.
- **D6. States:** „Tasumata" → „Tasutud" (with the date and how: „Montonio", „Pangaülekanne", „Sularaha" or „Kaardimakse kohapeal" — my call: Maria's rest is paid on the course day, often at the venue), or „Tühistatud" (an unpaid invoice Maria cancels; it keeps its number, never deleted). A Montonio-paid invoice is never changed by the site. A paid mark Maria made by hand can be undone the same way it was made — „Võta tasumine tagasi" — which sets it back to unpaid and takes the amount back off „Laekunud summa" when the mark had added it (my call, from the builder check: a wrong tap must not be permanent); it asks for confirmation.
- **D7. Numbers** (my call): `{prefix}{year}-{nnn}` (e.g. `MSL2026-001`), the year being the Tallinn year of issue, the sequence restarting at 1 each year unless Maria sets „Järgmine number" higher (as the certificate's series, phase 3d: same lock pattern, never below the highest + 1 of that prefix and year). **A series is per prefix** (from the builder check): a new company sets a new prefix, and its series starts at 001; the old prefix's invoices keep theirs. The prefix may be changed at any time; the uniqueness is `(prefix, year, seq)`. Default prefix `MSL`. Numbers are given at creation, under a database lock, so they are unique and gapless within a series; a cancelled invoice keeps its number.
- **D8. VAT** (Dim: unknown). Course prices are the prices the student pays (VAT included when VAT is on).
  - VAT off (default): no VAT lines; the invoice carries the footer „Arve ei sisalda käibemaksu (müüja ei ole käibemaksukohustuslane)." (my wording; the accountant should confirm it once).
  - VAT on: the line shows the price with VAT, and the totals show „Summa käibemaksuta", „Käibemaks {rate}%", „Kokku"; the seller's VAT number (KMKR) is required to turn VAT on. The rate is a setting (default 24, Estonia's standard rate since 1.7.2025), frozen on the invoice.
- **D9. The buyer** is the registration's or the payment's name and e-mail. Maria may edit the buyer of an **unpaid** invoice („Muuda saajat"): the name, an optional address (needed on a VAT invoice), and optionally a company name, its registry code and address, for a student whose company pays (my call: many students are FIE or small salons). The PDF of an unpaid invoice always shows its current buyer; once paid, the buyer is frozen.
- **D11. Sending** (Maria, C53: "töölauale … ja vajadusel ka eraldi meilile"). Every invoice is on the student's dashboard as soon as it exists; the mail is the optional extra. „Saada õpilasele" goes to the registration's e-mail, and the send form has an optional second address („Saada ka aadressile", e.g. her company's accountant), used for that send only and not stored except as the invoice's last-sent note. Both are counted on the site's mail quota like every other mail.
- **D10. Languages.** The invoice PDF is Estonian (as the certificate). The student's account and the mail use her language (et/ru) around it.

## 3. Data (migration 0011, additive)

`invoices`: `id`, `number` (unique), `prefix`, `year`, `seq` (`(prefix, year, seq)` unique), `kind` (`prepayment` | `full` | `balance` | `ecourse`), `registration_id` (set null on delete), `payment_id` (unique when set; set null on delete), `course_id` (set null), `client_id` (set null), `status` (`unpaid` | `paid` | `cancelled`), `amount_cents` (> 0), `vat_rate` (null when VAT off), `line` (jsonb: the course title, the session date text, the part — frozen), `seller` (jsonb: name, registry code, address, VAT number, receiver, IBAN, bank — frozen), `buyer` (jsonb: name, e-mail, company, company registry code, address), `reference` (the payment reference for a bank transfer), `issued_at`, `due_at` (null for one born paid), `paid_at`, `paid_method` (`montonio` | `bank` | `cash` | `card`), `paid_adds` (true when the paid mark added the amount to „Laekunud summa", so an undo takes it back), `sent_at` (last mail), `cancelled_at`, `created_at`.

`payments` gets `invoice_id` (nullable, set null on delete): the unpaid invoice a Montonio payment was started to pay (D5).

Rules the database enforces: one born-paid invoice per payment (`invoices.payment_id` unique); `number` and `(prefix, year, seq)` unique; amount positive. A student's or registration's deletion keeps the invoice (accounting records outlive the account; the buyer is frozen on it).

Settings key `invoice` = `{ company, registryCode, address, vatNumber, vatOn, vatRate, prefix, nextYear, nextSeq, termDays, footer }`, defaults empty except `prefix: "MSL"`, `vatOn: false`, `vatRate: 24`, `termDays: 7`.

## 4. The student's side

- **Where:** on each course card of „Minu koolitused" (the registration's or the e-course's), a quiet line per invoice: „Arve MSL2026-001 · 175,00 € · Tasutud" (or „Tasumata · maksa {date}"), with „Laadi alla (PDF)". An unpaid invoice also shows the bank details and the reference, and the existing „Maksa" button when online payment is on (Montonio pays the same amount; the invoice then becomes paid by D5's online rule, and no second invoice is made).
- **Download:** `GET /api/konto/arve/<id>` — her own invoices only (by her client id, or the registration's e-mail matching her account), `private, no-store`, `attachment; filename="MS-LAB-arve-MSL2026-001.pdf"`, 404 otherwise; behind the coming-soon gate like every account route.
- **Mails:** the online paid mail carries the PDF attached and the line „Arve on lisatud."; Maria's „Saada õpilasele" sends a mail „MS LAB arve {number}" with the amount, the due date, the bank details, the reference, the PDF attached, and a button to her account.

## 5. Maria's side

- **The registration** (Registreerimised → a registration): block „Arved" — its invoices (number, amount, state, „Laadi alla"), and „Koosta arve" with the open amounts as choices. On an unpaid invoice: „Saada õpilasele", „Muuda saajat" (D9), „Märgi tasutuks" (asks the date, default today), „Tühista arve".
- **„Arved"** (a new admin page, linked from „Maksed" and the overview): all invoices, newest first, 50 a page; filters by month and state; a line per invoice with the same actions; „Arveta maksed" (D3) on top when there are any; „Laadi alla (CSV)" for the chosen month (§6.4).
- **Seaded → „Arve andmed"** (D2), with a preview link "Näidisarve (PDF)" that renders a sample invoice from the card's current values without storing anything.

## 6. Rules

1. **Creation under lock.** Making an invoice takes, in one transaction: the registration's or payment's row lock, then an advisory lock `invoice-number`, then the `invoice` setting read and its number advanced (the certificate's pattern, phase 3d `seqToIssue`). A payment's invoice is made in the same transaction that marks the payment paid, so a paid payment always has its invoice once the seller is filled in; if the seller is missing, the payment is marked paid and listed as „Arveta maksed".
2. **No double invoices.** A payment pays at most one invoice: its own born-paid one (unique index) or the unpaid one it was started for (`payments.invoice_id`), never both. „Koosta arve" offers only amounts not yet covered by an unpaid or paid invoice of that registration (price − invoiced); a prepayment and a full invoice exclude each other.
3. **„Arveta maksed" (catch-up).** A paid payment without an invoice (the seller card was empty, D3) gets one by its own „Koosta arve" on the „Arved" page: issued today, paid on the payment's time, method Montonio, not mailed (Maria may press „Saada õpilasele"). No bulk button (my call: each one is a real number).
4. **„Märgi tasutuks"** adds the invoice's amount to the registration's „Laekunud summa" in the same transaction (and the registration confirms at 50% as the existing rule says). Cancelling an unpaid invoice changes nothing else.
5. **The CSV** (`;`-separated for Estonian Excel, UTF-8 with BOM): number, issue date, due date, buyer, buyer's company and registry code, description, sum without VAT, VAT, total, state, paid date, method; one row per invoice issued in the chosen month, cancelled ones included (marked).
6. **Logs:** ids and numbers only, never names, e-mails or amounts with names.

## 7. The PDF

A4 portrait, white, black text (printable), the MS LAB logo drawn as vector shapes (the certificate's logo code), Jost (already committed; no new font). Blocks: the seller (from the frozen copy), „ARVE" with the number, the issue date and (unpaid) the due date; the buyer; one line table (description, sum); totals (with VAT lines when VAT on); payment details (receiver, IBAN, bank, reference) on an unpaid invoice, or „Tasutud {date} ({method})" on a paid one; the footer (D8 VAT note, the optional footer line). Rendered on every download from the frozen row; under 100 KB.

## 8. The test plan (standing rule)

New checks with `mark: "new"` and `"markedAt": "deploy"` in `testplan.json`: filling „Arve andmed" and the sample PDF; an online prepayment's invoice in the account and the mail; „Koosta arve" for a bank transfer, „Saada õpilasele", „Märgi tasutuks" confirming the registration; cancelling; the month's CSV; VAT on vs off (koos/dim). Existing checks whose behaviour changes (the paid mail, the registration drawer, Seaded) get `redo`.

## 9. Edge cases

- A course renamed or its price changed after an invoice: the invoice keeps its frozen line and amount.
- An e-course bought twice: two payments, two invoices.
- A registration cancelled with an unpaid invoice: the invoice stays unpaid until Maria cancels it (the registration's drawer shows it).
- The year turns: numbering restarts (D7); an unpaid invoice of December is paid in January under its own number.
- A student deletes her account: her invoices remain (frozen buyer), visible to Maria, no longer to anyone else.
- „Arve andmed" changed while invoices exist: only new invoices see the change.
- **Test invoices on staging.** Testing (the test page) makes invoices on mslab.ee with Montonio's sandbox. Before the public launch Dim deletes them by the exact test addresses (the same clean-up as the other test rows, `docs/launch-checklist.md`), and Maria sets the series' „Järgmine number" for her first real invoice. Until then the series may hold test numbers; that is expected.

## 10. Out of scope

Credit notes (kreeditarve) and partial refunds' documents; e-invoices to companies (e-arve operator); an accounting-software integration; automatic reminders for unpaid invoices; free-form invoices for other items (practice packages, products); a student editing her own buyer details; instalments (piece 6).

## 11. Left to the builder

The visual layout of the PDF within §7; the exact Estonian/Russian wording of the account and mail texts beyond those quoted (marked Draft for Dim's wording sheet); whether „Arved" sits in the admin menu or only under „Maksed".
