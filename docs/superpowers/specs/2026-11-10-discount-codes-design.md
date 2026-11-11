# Discount codes („Sooduskoodid“) — design

This design covers Maria's request F1 of 10.11.2026 (`.superpowers/feedback/2026-11-10-maria-requests.md`) and her answers the same day.

Our reply (`2026-11-10-maria-reply.txt`) already promised her five things:
- a code field on the contact-course registration and on the e-course purchase;
- the code checked at once;
- the price recomputed for every payment option, including the prepayment, 50 % + 50 % and järelmaks;
- the discount shown on the invoice;
- codes she creates in the admin.

Every decision not attributed to Maria or to that reply is my call and says so. Texts marked Draft go to Dim's wording sheet.

**Maria's answers (10.11.2026) are the requirements:**
1. She wants her own campaign codes too, not only the welcome code.
2. A discount is in percent or in euros, her choice per code.
3. The welcome code works once per person, and only on the person's first training.
4. The welcome code applies to all trainings. Later she might want a code for one or several chosen courses, e.g. „e-esmaspäev“: all e-courses −X %.

## 1. Why

Today no code reaches the money path:
- **The welcome code is only text.**
  - Seaded → „Uudiskiri“ → „Tervituskood“ (`settings.newsletter.welcomeCode`, `domain/welcome-code.ts`) goes out in the welcome mail (`server/newsletter.ts sendWelcome`, `server/account-mail.ts welcomeMail`) and on the confirmed page (`newsletter.codeLine`).
  - Both tell her „Lisa kood registreerimisel lahtrisse „Sõnum““, and the mail adds „Maria arvestab soodustuse sinu arvelt maha.“
- **Its numbers live in Hüpikaken, and nothing enforces them.**
  - „Soodustus (%)“ (`discountPercent`) is the footer's „10% tervitussoodustus sinu esimesele koolitusele“.
  - „Kood kehtib (päeva)“ (`codeDays`) is the mail's „Kood kehtib 30 päeva.“.
- **Maria cannot apply a code by hand either.**
  - A registration stores no price: every money path reads the course's live price through `domain/registration.ts registrationPrice` (about 20 callers).
  - The e-course cart has no message field.
  - Bank and Inbank payments go through at the full price.
- **`courses.next_discount` is display text only.** It is the e-course page's fact „Soodustus: −10% järgmiselt koolituselt“ (`koolitused/[slug]/page.tsx`; the course editor's „Soodustus järgmiselt koolituselt“). Nothing applies it.

**Success:**
- A student types a code on the registration form or in the cart, sees the new price at once, and pays exactly that through every option.
- The discount is on the invoice and in the contract.
- Maria creates, pauses and watches her codes in the admin, the welcome code among them. She never computes a discount by hand.

**Anti-goals:**
- **A student charged more than the price she saw.**
- **A code used beyond its rules because two orders raced.**
- **Two sources for the welcome discount,** such as a footer saying 10 % while the code gives 15 %.
- **A live check or a submit that tells strangers whether an address has studied at MS LAB or subscribes** (the submit: my call, §4.6).

## 2. Decisions

- **D1. One table of codes; the welcome code is one row of it** (Maria 1; the reply).
  - `discount_codes` holds every code. The welcome code is the row with `welcome = true`; there is at most one.
  - The migration makes that row from today's setting (§3).
  - From then on Seaded does not hold the code and Hüpikaken does not hold its numbers (D12).
- **D2. Percent or euros, per code** (Maria 2).
  - **Percent** is a whole number 1–99, the limits Hüpikaken uses today. The discount is `Math.round(list × p / 100)` cents, so half a cent rounds up (my call).
  - **Euros** are to the cent (`parseEuroCents`).
  - **The total never drops below 1,00 € (`MIN_TOTAL_CENTS`)** (my call).
    - A larger euro discount is capped, and the form shows the capped amount.
    - Free bookings are out of scope, and `payments_amount_positive` and `invoices_amount_positive` need a sum above zero.
  - The discount comes off the list price before any split: the group price of a contact course, or an e-course's price.
- **D3. Scope: all courses, all e-courses, all contact courses, or chosen courses** (Maria 4; building „chosen“ now is my call).
  - The welcome code defaults to „Kõigile koolitustele“.
  - **Why all four now:**
    - Her named example, „e-esmaspäev“, is already a scope (all e-courses), so the first version has a scope check anyway.
    - „Valitud koolitustele“ adds only one join table and a checklist in the drawer.
    - Adding it later would reopen the migration, the admin screen and the tests a second time.
  - **It is the piece to cut** if Dim wants a smaller first version (§10).
- **D4. Validity dates, a usage limit and a switch** (my call; „e-esmaspäev“ needs dates).
  - **Dates.** `starts_on` and `ends_on` are optional dates on Tallinn's calendar (`tallinnToday`), both days included. A one-day campaign has the same day in both.
  - **Limit.** `max_uses` is optional: the number of uses that count (D7), across everyone.
  - **Switch.** `active` is Maria's switch „Aktiivne“. It acts at once and offers the UndoBar.
- **D5. Who may use a code** (Maria 3 for the welcome code; the rest is my call).
  - **„Kellele“ (`audience`).** Every code has one of three values:
    - `all`;
    - `first`: „Ainult esimesel koolitusel“;
    - `returning`: „Ainult varasematele õpilastele“. This is how `next_discount` can be honoured (D9).
  - **„Üks kord inimese kohta“ (`once_per_person`)** is on by default for every code.
  - **The welcome code** is fixed to `first` and once per person. It adds two rules (my call; Maria question 1):
    - **Subscribed.** The address must be a newsletter subscriber (a `subscribers` row with `confirmed_at`), or the newsletter box in this very form or cart must be ticked: she subscribes with this order.
    - **Days.** While „Kehtib pärast liitumist (päeva)“ (`days_after_signup`, today's „Kood kehtib (päeva)“) is set, the code is valid until that many days after her `consent_at`, on Tallinn's calendar.
  - **Why these rules:**
    - The welcome code is the reward for subscribing, and the popup's rules line already promises „üks kasutus tellija kohta“.
    - The mail promises „Kood kehtib 30 päeva.“, and a promise the site prints should be true.
    - Without the rule, a code shared in a group would give every first-timer the discount without subscribing.
- **D6. A person is her normalised e-mail** (my call).
  - The rule is `domain/email.ts normalizeEmail`: trimmed and in lower case. Registrations and payments already store e-mails that way, and an account's e-mail is the same address.
  - Gmail's dots and `+tags` are not folded, because that would merge real, different addresses at other providers.
  - Phones are not matched, because the cart asks for none.
- **D7. When a use counts** (my call).
  - **The rule.** A use (a `discount_redemptions` row) counts while the thing it paid for stands, or may still be paid. An abandoned, unpaid order does not burn a use (my call). This is decided when the row is read, never stored. The limit and once per person read it in two ways.
  - **Towards the limit** (`max_uses`, the admin's „Kasutatud“) (my call):
    - **A registration's use** counts while the registration is not `cancelled` and any of these holds: it is `confirmed`, it has `paid_cents > 0`, or it was made within the last 24 hours. The 24 hours leave her time to pay a prepayment invoice by bank transfer the next day.
      - An older booking with nothing paid stops counting without anyone cancelling it.
      - Cancelling the registration gives the code back at once.
      - A late payment on an old booking, or Maria restoring a cancelled one, makes the use count again, even over the limit (§6).
    - **An e-course purchase's use** counts while its payment is `paid` or `held`, or `pending` inside its attempt window. The window is `db/queries/payments.ts attemptEnds`: 30 minutes, or 60 for a järelmaks, like a seat hold.
      - A failed, abandoned or refunded payment gives the code back.
  - **Once per person** (my call). Her earlier uses count while the registration is not `cancelled`, or the e-course payment is `paid` or `held`. Two kinds are left out, like the order being made (`personFacts`' `except`, §4.2):
    - a use on a registration of the **same course** that has nothing paid and is not `confirmed`, whatever its age;
    - a use on an e-course payment of the **same course** that is not `paid` or `held`, the pending window included.
    - A `pending` payment of **another** course counts inside its window (`attemptEnds`), so two tabs on two e-courses cannot both use a once-per-person code; after its window, or once it fails, it gives the use back.
    - So her re-send is the same order again: a booking sent twice, or a cart paid again after Back or a failed payment, gets the code again.
    - **A re-sent e-course order** (the open attempt of the same code, total and method, inside its window) is not a new use: its own use is left out of the count, so the last use under a limit is not refused to the person who holds it. Her other live pending attempts of the same course, of either method, are left out too when she starts a new one, so switching between the bank and järelmaks is not `usedUp` against her own open attempt.
    - An unpaid booking of **another** course still holds her use until it is cancelled (§6).
  - **Nothing else changes.** Settle, `failPayment`, `setRegistrationStatus` and the refund path need no change for codes.
  - **An earlier training** decides `first` and `returning`. It is any of these, for the same e-mail, leaving out the order being made:
    - a registration that is not cancelled and is either `confirmed` or has `paid_cents > 0` (an abandoned, unpaid booking is not a training);
    - a `paid` e-course payment;
    - a `course_access`, not revoked, of the account with that e-mail. This covers Maria's grants, such as an e-course bought by bank transfer.
- **D8. Races** (my call).
  - Every use is written under the code's row lock (`select … for no key update` on `discount_codes`), in the transaction that makes the booking or starts the payment. `no key update` rather than `update`: the foreign-key check of another transaction's insert into `discount_redemptions` (D11's, say) takes a key-share lock on the code row, which `for update` would block and `for no key update` does not.
  - So two orders by one person, and the last use under a limit, are decided one after the other. **What this guarantees** (my call): no two uses that both count at the moment of booking break the limit or once per person.
    - **A re-sent e-course order** takes the code's lock too and checks its rules again (paused, ended, not yet, scope, limit with its own use left out) before it is sent again; a refusal sends nothing and leaves the open attempt as it was. The person's rules are not run again: it is the same order of the same person.
    - **What it does not.** A use that has stopped counting can count again when it is paid late: a booking older than 24 hours, a re-sent order, a pending e-course payment. Its order then keeps its price, even over the rule (§6).
  - **The lock order:**
    - a registration: `course_sessions` → `discount_codes` → the `registrations` insert → the contract;
    - an e-course start: the purchase's advisory lock → `discount_codes` → `payments`.
  - **No cycle:**
    - Nothing that holds a code's lock waits for a session, registration or purchase lock.
    - Settle and cancelling never take a code's lock. The admin's „Lisa sooduskood“ (D11) takes only the key-share lock of its insert, after its own session and registration locks, in the same order as the booking. An admin save of a code takes only the code's lock.
  - This goes into the lock-order note in `db/queries/seats.ts`, and `tests/e2e/discount-race.spec.ts` proves it on real Postgres (§7).
- **D9. One code per order, nothing stacks, and `next_discount` stays text** (my call).
  - The popup's rules line already promises „ei liitu teiste soodustustega“.
  - **There is nothing to stack with.** No other discount is applied automatically, so there is no "best of" to choose. The group and individual prices are prices, not discounts, and `next_discount` applies nothing.
  - **Honouring „−10% järgmiselt koolituselt“**
    - Maria creates a code with „Ainult varasematele õpilastele“ and gives it to buyers, or names it in that text.
    - The course editor's hint says so (§5).
    - An automatic personal code is out of scope.
- **D10. The discount is frozen in euros on the booking** (my call).
  - **What is frozen.** `registrations.discount_cents`, and `payments.discount_cents` for an e-course, are set when the booking or purchase starts. `discount_code` beside them holds the code's text, which never changes once used (§4.10).
  - **The price owed** is `registrationTotal(course, r)` = the live list price − `discount_cents`, never below 1,00 €. So the list price follows the course exactly as it does today.
  - **The catch.** A percent code's euros do not follow a later price change. Freezing the whole price instead would change today's behaviour for every registration, so that is a question for Dim (§10).
- **D11. Maria can put a code on a registration herself** (my call). Without this she has no way to correct a price at all.
  - **The actions.** The registration drawer's Raha card gets „Lisa sooduskood“ and „Eemalda sooduskood“.
  - **When.** Both work only while:
    - „Laekunud summa“ is 0;
    - the registration is not cancelled;
    - it has no unpaid invoice („Tühista enne maksmata arve.“).
  - **Any existing code applies,** whatever its dates, limit, scope or person rules. This is her deliberate decision, for example honouring a welcome code someone wrote in „Sõnum“ during the switch-over. The use is recorded with `via = 'admin'`.
  - **An open Montonio order for the old sum** is handled as today. If it is paid, it is „Ülemakse“. The next start has a new amount, so it is a new attempt, and B22 replaces the old order.
  - **The contract keeps the price it froze.** Maria may ask again with „Saada leping kinnitamiseks“ (contracts D4).
  - **E-course purchases have no such action.** Maria refunds the difference in Montonio.
- **D12. The welcome code's texts follow its row** (my call; texts Draft, §5).
  - **The footer.** Its `{discount}` is the welcome code's value („10%“ or „15 €“) while an active welcome code is valid today. Otherwise the footer shows a sentence without a discount.
  - **Hüpikaken** loses „Soodustus (%)“ and „Kood kehtib (päeva)“. Their checks move to the code drawer, with the same messages.
  - **Seaded** loses its „Uudiskiri“ section. The old anchor `#uudiskiri` leads to `/admin/sooduskoodid`.
  - **The mail, the page and the popup.** The welcome mail, the confirmed page's line and the popup's „Saa kood“ button carry the code only while it is active and valid today.
  - **Caching.** Saving the welcome code revalidates the public pages (`server/cache-targets.ts`), as Hüpikaken's publish does today.
- **D13. Newsletter campaigns** (my call). A campaign's „Kood“ (`newsletter_campaigns.code`) stays free text. The editor warns, without blocking the send, when it is not an active code (§5).

## 3. Data (migration 0023, additive)

0023 is the next free number today (0022 is `course_certificate_title`). The build takes whatever number is free then.

**`discount_codes`:**
- `id`;
- `code`: text in the welcome code's shape, upper case, unique. The shape is A–Z, 0–9 and „-“, at most 30 characters (the `SHAPE` of `domain/welcome-code.ts`, which moves to the new domain file);
- `welcome`: boolean, with a partial unique index where it is true;
- `percent` (smallint, 1–99) or `amount_cents` (integer above 0): a check makes sure exactly one is set;
- `scope`: `all | ecourse | contact | courses`;
- `starts_on`, `ends_on`: nullable dates, with a check that the end is not before the start;
- `max_uses`: nullable integer above 0;
- `audience`: `all | first | returning`;
- `once_per_person`: boolean, default true;
- `days_after_signup`: nullable smallint, 1–365, allowed only on the welcome row;
- `note`: text. Maria's own label („Märkus“), seen only in the admin;
- `active`: boolean, default true;
- `created_at`, `updated_at`.

A check also requires the welcome row to have `audience = 'first'` and `once_per_person`.

**`discount_code_courses`** (`code_id`, `course_id`) holds the chosen courses of scope `courses`. Both columns form the primary key, and both cascade on delete.

**`discount_redemptions`** (one use):
- `id`;
- `code_id`: no cascade, so a code that has been used cannot be deleted;
- `email`: normalised;
- `client_id`, `course_id`, `registration_id`, `payment_id`: each set null on delete;
- `list_cents`, `discount_cents` (above 0);
- `via`: `form | cart | admin`;
- `created_at`.

Indexes:
- on `code_id`;
- on (`code_id`, `email`);
- partial unique indexes on `registration_id` and on `payment_id`, so an order has at most one code.

When an account is deleted, its uses stay with Maria, as its registrations and payments do. `server/client-data.ts deleteClient` does not change.

**`registrations` and `payments`** each get two columns:
- `discount_cents`: integer, not null, default 0, never negative;
- `discount_code`: text, not null, default ''.

On `payments` they are set only for kind `ecourse`. A registration's payments are charged from the registration's total, so they need none.

**The welcome row is made from today's setting.** The same migration inserts it from `settings.newsletter`, but only when `welcomeCode` has the shape:
- **Percent.** It is read as `discountPercentOf` reads it today: `discountPercent` when it is 1–99, else the number in the old `discountLabel`, else 10.
- **Days.** `days_after_signup` comes from `codeDays` when it is 1–365.
- **The rest.** Scope `all`, active.

An empty code makes no row; the page then offers „Lisa tervituskood“. The old keys stay in the setting, unread, in case of a rollback, and are removed later. `tests/db/migration-0023.test.ts` covers each case.

## 4. Flows

**4.1 The rules** live in `domain/discount-codes.ts`. It is pure and runs in the browser, like `domain/financing.ts`: no lookbehind (`tests/unit/old-safari.test.ts`).
- `normalizeCode(typed)`: trimmed and in capitals.
- `discountCents(code, listCents)`: the amount, as D2 says.
- `registrationTotal(course, r)`: the price owed, as D10 says.
- `codeRefusal(code, { courseId, courseType, today, uses })`: returns `paused`, `notYet`, `ended`, `usedUp`, `scope` or null.
- `personRefusal(code, facts)`: returns `used`, `first`, `returning`, `subscriber`, `expired` or null. Only the tests read the reason; the submit answers each one with `person` (§4.6).
- `codeValueText(code)`: „10%“ or „15 €“.
- `codeState(code, today, uses)` for the admin list: `active`, `paused`, `upcoming`, `ended` or `full`.

**4.2 The server** is `server/discount-codes.ts`:
- `findCode`.
- `usesOf(q, codeId, now)`: D7's limit rule as one SQL expression, shared by the limit and the admin's „Kasutatud“. A registration's use counts when it is `confirmed`, has `paid_cents > 0`, or is under 24 hours old; an e-course use when its payment is `paid`, `held`, or `pending` inside its window.
- `personFacts(q, email, { courseId, except })`: earlier uses under D7's once-per-person rule, earlier trainings, the subscription and its `consent_at`. `except` leaves out the order being made, and also her uses on unpaid, unconfirmed registrations of `courseId` and on e-course payments that are not `paid` or `held` (my call).
- `lockCode(tx, id)` and `redeem(tx, …)`: the checks and the insert, under the lock.
- The admin's actions.
- `welcomeCode(q, now)`. It replaces every reader of `welcomeCodeOf(setting)`:
  - `newsletter.ts`: `sendWelcome` and `confirmNewsletter`;
  - the home page's popup button;
  - `/admin/kampaania`;
  - the footer, through `components/site/settings.ts shellSettings`.

Logs name a code by its id only, never by its text, and never name an e-mail.

**4.3 The live check** (the reply: the code is checked at once):
- **The action.** `checkDiscountCode(formData)` in `server/actions/public.ts` takes the course slug and the code.
- **The answer.** Either `{ ok, code, discountCents, totalCents, value, audience, welcome }`, or `{ ok: false, error }` with D3's and D4's refusals or `unknown`.
- **No e-mail.** It never takes the e-mail (an anti-goal), so the person rules (D5) are checked only at submit.
- **Its own rate bucket:** 20 checks per 10 minutes per IP (my call; the forms' 5 is too few for typos). Over the limit it answers with `forms.errorTooMany`.
- It only reads and is never cached.

**4.4 The registration form** (`components/site/ContactRegister.tsx`, group courses only):
- **The field.**
  - Under „Sõnum“, above „Tasumine“, there is a quiet button „Mul on sooduskood“.
  - It opens the field „Sooduskood“ with „Rakenda“. Enter applies too.
- **When applied.**
  - The form shows „Sooduskood {code}: −{amount}“ with „Eemalda“, and a summary „Kokku {total}“.
  - A code with person rules adds its hint, e.g. for the welcome code „Kehtib uudiskirjaga liitunud aadressil ja ainult esimesel koolitusel.“. The hint stays visible under a `person` refusal too (§4.6).
  - Applying another code replaces the first one.
  - The inline contract („Loe lepingut“) is filled with the total.
- **Järelmaks.**
  - The course page passes the toggle and payments-on state instead of today's ready-made `financing` flag.
  - The form decides `financingOffered` on the current total. So a code can take the choice away, or add it when the list price is over 5 000 €.
  - If järelmaks is chosen and the total leaves 100–5 000 €, the choice becomes „100% kohe“, and `forms.payFinancingRange` shows under the choices.
  - The code is never capped to keep järelmaks (my call). A code worth less for one payment choice would read as a trick, and the bank stays open.
- **The code is remembered.**
  - It is kept per course in `sessionStorage` (inside try/catch) and checked again when the page loads.
  - So Back from Montonio, and the result page's „Proovi uuesti“ and „Maksa pangalingiga“, keep it.
- **On submit** (my call):
  - A code typed but not applied is applied first: the same press runs the check. When it passes, the form shows the code's line and the new total and sends with them. When it is refused, the error shows at the field and nothing is sent.
  - So the submit always carries `discountCode` together with the `discountCents` she saw, or no code at all.

**4.5 The cart** (`ostukorv/cart.tsx`, `components/site/EcoursePurchase.tsx`):
- The same field sits above the name.
- The cart's „Kokku“ moves into `EcoursePurchase`, so that it can follow the code.
- The button reads „Maksa {total}“, and järelmaks is decided on the total, as in §4.4.
- „Maksa“ with a typed code applies it first, as the registration form's submit does (§4.4).
- The page stays one cached page per course: nothing about a code is rendered on the server.

**4.6 Submit and start** (`server/submit.ts`, `server/payments/start.ts`). This is the check that decides, under D8's locks.
- **A registration** (`handleRegistration`'s transaction, after `lockSession` and the seat check):
  1. `lockCode`;
  2. `codeRefusal` and `personRefusal` (the form's newsletter box counts as subscribing, D5);
  3. the discount;
  4. `createRegistration` with `discount_cents` and `discount_code`;
  5. the redemption;
  6. the contract, filled with the total.
- **An e-course purchase** (`startEcoursePayment`, which takes `discount: { typed, shownCents } | null`). It does the same after `lockEcoursePurchase`:
  - `amountCents` is the total;
  - `financingRefusedNow` is asked about the total;
  - `liveAttempt` also matches the code;
  - the redemption is inserted together with the payment row.
  - `handleEcoursePurchase` fills the contract snapshot with the list price − the discount the cart showed. The start refuses any other discount (`changed`, below), so the snapshot's `{hind}` is always the amount charged.
- **A refusal** answers `discountCode: <reason>`.
  - Nothing is stored or started, and the error shows at the field.
  - She can press „Eemalda“ and send again.
- **One answer for every person rule** (my call). `used`, `first`, `returning`, `subscriber` and `expired` all answer `discountCode: person`, with one text (§5).
  - A different answer per reason would tell anyone who types an address whether it studied at MS LAB or subscribes.
  - The code's hint stays visible under the error (§4.4), so she still sees the rule.
  - D3's and D4's refusals (`paused`, `notYet`, `ended`, `usedUp`, `scope`) keep their own texts: they say nothing about the address.
- **The price charged is the price shown** (my call).
  - The refusal is `changed` whenever the server's discount differs from the shown `discountCents`, smaller or larger, e.g. because Maria edited the code meanwhile.
  - The form then checks again and shows the new price, and she sends again.
  - A submit with a code but no `discountCents` (an old page, a script) is refused `changed` too. The form never sends one (§4.4).
- **An individual-course request** has no code field, because it has no price or payment. The code goes in „Sõnum“, and Maria applies it with D11 once there is a registration.

**4.7 Every money path reads the total** (the reply).
- **How the callers are found.** `registrationPrice` is renamed `listPrice`, so the compiler finds every direct caller. Each one that measures money calls `registrationTotal` instead:
  - `domain/payments.ts payableDue`, through every `priceCents` it is given;
  - `server/payments/start.ts`;
  - `server/payments/settle.ts`: "paid in full", „Ülemakse“ and the late-loan hold;
  - `db/queries/admin.ts addRegistrationPayment`: the place is confirmed from 50 % of the total;
  - `server/registration-money.ts`: `overRemainder`;
  - `server/invoices.ts`: `createInvoice`, `issueReceiptInTx`, `issueForPayment` and `receiptTakeBacks`;
  - `server/pay-page.ts`;
  - `server/client-data.ts` and `domain/account-cards.ts`: the account card;
  - `server/contracts.ts registrationContractFields`;
  - `server/submit.ts handleRegistration`: the `priceCents` and `prepayment` it passes to `registrationConfirmationMail` (the mail's amount and bank-transfer rows);
  - `admin/(panel)/registreerimised/page.tsx`.
- **What the rename does not flag** (my call: listed so that none is missed):
  - `components/admin/MoneyCard.tsx` takes the price as its `priceCents` prop (`amountOffers(paidCents, priceCents)`). Its callers pass the total.
  - `server/account-mail.ts` names `registrationPrice` only in a comment. It gets its amounts from `server/submit.ts`.
  - **The e-course path reads `course.price` directly:**
    - `server/submit.ts handleEcoursePurchase`: the price check (~584), the contract snapshot `filledContract(… priceCents: course.price …)` (~591) and the start's `amountCents: course.price` (~596). The snapshot and the amount become the list price − the cart's discount (§4.6); the check stays on the list price.
    - `ostukorv/cart.tsx`: the shown price and „Kokku“, which move into `EcoursePurchase` (§4.5).
- **What each choice charges,** with total T:
  - „100% kohe“ charges T;
  - „50% + 50%“ charges `ceil(T/2)` now and the rest on the training day;
  - järelmaks sends T to Inbank, when T is within 100–5 000 €;
  - the bank-transfer rows and Maria's „Maksmiseks“ amounts (`openAmounts`, `partOf`) are measured against T.
- **Montonio** gets `grandTotal` = the payment row's amount, as now. There are no line items, so `montonio.ts` does not change.
- **A guard** (`tests/unit/price-callers.test.ts`):
  - `listPrice` is allowed only in the course page, the cart, `demo-data.ts` and `registrationTotal` itself;
  - a direct `course.price` read is allowed only in `domain/registration.ts`, the course page, the cart's list-price line and `handleEcoursePurchase`'s price check (my call). Today these four files are the only readers, so a new money path cannot skip the discount.

**4.8 The invoice and the contract** (the reply; the contract price is in Maria's request F1).
- **The invoice line.** `InvoiceLine` gains `discount?: { code, listCents, cents }`, frozen at issue from the registration or the e-course payment. Old invoices have none.
- **The rows.**
  - A whole-sum or e-course invoice prints three rows: the course at the list price, „Sooduskood {code}“ with its −cents, and „Kokku“ with the amount.
  - A prepayment or rest invoice prints one small line under its part: „Hind {list} − sooduskood {code} {cents} = {total}“ (Draft).
  - VAT is split on the amount, as today.
- **The CSV.** The accountant's CSV (`invoicesCsv`) gains the columns „Sooduskood“ and „Soodustus“.
- **The contract.**
  - `{hind}` is the total, and `{ettemaks}` is its first part.
  - `ContractFields` gains `discount`, e.g. „−35,00 € (TERE10)“. It is empty when there is no code, and for old rows.
  - The PDF's „Koolitus“ block prints it as a row „Soodustus“ after „Hind“.
  - The placeholder hint says „{hind} — hind pärast sooduskoodi“ (Draft).

**4.9 Mails, notices and the account.** An order with a code shows the line „Sooduskood {code}: −{amount}“ (in Maria's notices, the row of §5):
- in the registration confirmation, after the price;
- in Maria's notice „Uus makse: …“ (`server/messages.ts paymentSummary`), after „Summa“;
- in Maria's notice „Registreerimine: …“ (`server/messages.ts registrationSummary`). It prints no price today, so the code row is added there after „Tasumine“, together with a row „Kokku“ with the total (my call);
- on the account card, after the price.

**4.10 The admin page „Sooduskoodid“** (`/admin/sooduskoodid`; the reply: Maria creates codes in the admin).
- **The menu.**
  - It is the section `codes` in the group „Koolitused“, after „Praktika“ (`components/admin/sections.ts`).
  - It sits beside the prices, and that group does not fold, so Maria sees it.
  - Its icon is a new `percent` in `AdminIcon`.
- **The list.** The welcome code comes first, tagged „Tervituskood“; the others follow, newest first. The columns:
  - „Kood“;
  - „Soodustus“: „−10%“ or „−20 €“;
  - „Kehtib“: the scope in words, or the number of chosen courses;
  - „Aeg“: e.g. „01.12.2026–07.12.2026“, or „Tähtajatu“;
  - „Kasutatud“: e.g. „3 / 20“, or „3“ without a limit;
  - „Olek“: „Aktiivne“, „Peatatud“, „Tulekul“, „Lõppenud“ or „Täis“.
- **Opening and creating.**
  - A row opens the drawer `?kood=<id>`.
  - „Uus sooduskood +“ opens `?kood=uus`, which needs an explicit „Lisa sooduskood“.
  - Once the code is created, the drawer autosaves (`components/admin/autosave/useAutosave.ts`, admin UX pass README §1.3), as a new session's drawer does.
- **The drawer's fields** (texts in §5):
  - Kood;
  - Soodustus: Protsent or Eurod, then the number;
  - Kehtib, with a checklist of courses for „Valitud koolitustele“;
  - Algab and Lõpeb;
  - Kasutuskordi kokku;
  - Kellele;
  - Üks kord inimese kohta;
  - „Kehtib pärast liitumist (päeva)“, on the welcome row only, with its fixed rules shown as text;
  - Märkus;
  - the switch „Aktiivne“, which acts at once and shows the UndoBar „Sooduskood peatatud.“.
- **Editing a used code.**
  - Its text cannot change.
  - A changed value applies to new bookings only, and a hint says so.
- **Deleting.** „Kustuta sooduskood“ is offered only for a code with no uses at all, behind a ConfirmPanel. Otherwise the drawer says „Koodi on kasutatud — kustutada ei saa. Peata see.“.
- **„Kasutused ({n})“** lists every use, newest first: the date, the name, the course and the −amount.
  - Each use links to the registration's drawer or to Maksed.
  - A use that no longer counts towards the limit is marked „tühistatud“, „maksmata“ (a booking over 24 hours old with nothing paid, my call), „makse pooleli“, „makse ebaõnnestus“ or „tagastatud“.
  - Maria's own uses are marked „lisas haldus“.

## 5. Texts (all Draft)

**On the site, Estonian and Russian:**

| Where | ET | RU |
|---|---|---|
| The opener | Mul on sooduskood | У меня есть промокод |
| The field, the button | Sooduskood · Rakenda | Промокод · Применить |
| Applied | Sooduskood {code}: −{amount} · Eemalda | Промокод {code}: −{amount} · Удалить |
| The summary | Kokku {total} (`cart.total`) | Итого {total} |
| Hint: welcome code | Kehtib uudiskirjaga liitunud aadressil ja ainult esimesel koolitusel. | Действует для адреса, подписанного на рассылку, и только на первый курс. |
| Hint: `first` | Kehtib ainult esimesel koolitusel. | Действует только на первый курс. |
| Hint: `returning` | Kehtib MS LABi varasematele õpilastele. | Действует для тех, кто уже учился в MS LAB. |
| Empty | Kirjuta sooduskood. | Введите промокод. |
| `unknown` | Sellist sooduskoodi ei ole. | Такого промокода нет. |
| `paused`, `ended` | See sooduskood ei kehti enam. | Этот промокод больше не действует. |
| `notYet` | See sooduskood kehtib alates {date}. | Этот промокод действует с {date}. |
| `usedUp` | Selle sooduskoodi kasutuskorrad on otsas. | Этот промокод уже исчерпан. |
| `scope` | See sooduskood ei kehti sellele koolitusele. | Этот промокод не действует для этого курса. |
| `person` (every person rule) | Seda sooduskoodi ei saa selle e-posti aadressiga kasutada. | Этот промокод нельзя использовать с этим адресом e-mail. |
| `changed` | Sooduskood muutus vahepeal. Vaata uus hind üle ja proovi uuesti. | Промокод за это время изменился. Проверьте новую цену и попробуйте снова. |

`person` is one text for `used`, `first`, `returning`, `subscriber` and `expired` (my call, §4.6). The code's hint stays under it and names the rule.

**The welcome code's texts, Estonian and Russian:**

| Key | Today | ET (new) | RU (new) |
|---|---|---|---|
| `mail.welcome.use` | Lisa kood registreerimisel lahtrisse „Sõnum“. | Kirjuta kood registreerimisel või ostukorvis lahtrisse „Sooduskood“. | Введите код при регистрации или в корзине в поле «Промокод». |
| `mail.welcome.invoice` → `value` | Maria arvestab soodustuse sinu arvelt maha. | Kood annab {soodustus} soodustust sinu esimeselt koolituselt. | Код даёт скидку {soodustus} на ваш первый курс. |
| `mail.welcome.days` | Kood kehtib {n} päeva. | Unchanged. {n} now comes from the row, and the rule is enforced. | Unchanged. |
| `newsletter.codeLine` | … Lisa kood registreerimisel lahtrisse „Sõnum“. | Sinu tervituskood: {code}. Kirjuta see registreerimisel või ostukorvis lahtrisse „Sooduskood“. | Ваш приветственный код: {code}. Введите его при регистрации или в корзине в поле «Промокод». |
| `newsletter.body` | … {discount} tervitussoodustus … | Unchanged. `{discount}` is the welcome code's value („10%“, „15 €“). | Unchanged. |
| `newsletter.bodyNoCode` (new) | — | Uued koolitused ja kasulikud mõtted. | Новые курсы и полезные идеи. |

**In the admin (Estonian only, like all of Maria's screens):**
- **The page.**
  - The menu entry and the title are „Sooduskoodid“, under the eyebrow „Koolitused“.
  - The lead: „Koodid, mida õpilane saab sisestada registreerimisel ja ostukorvis. Soodustus arvestatakse hinnast kohe maha.“
  - The buttons: „Uus sooduskood +“ and „Lisa sooduskood“.
  - With no codes: „Sooduskoode pole veel.“
- **The fields and their hints:**
  - **„Kood“.** Hint: „Tähed A–Z, numbrid ja sidekriips, kuni 30 märki. Õpilane võib kirjutada ka väikeste tähtedega.“
    - Once the code is used: „Kasutatud koodi ei saa muuta: loo uus kood.“
    - On the welcome row: „Juba saadetud tervituskirjades on vana kood.“
  - **„Soodustus“.** The choices „Protsent“ and „Eurod“ set the field „Soodustus (%)“ or „Soodustus (€)“.
    - The € hint: „Tasuda jääb alati vähemalt 1 €.“
    - After a change: „Muudatus kehtib uutele registreeringutele ja ostudele.“
  - **„Kehtib“.** The choices: „Kõigile koolitustele“, „Kõigile e-koolitustele“, „Kõigile kontaktkoolitustele“ and „Valitud koolitustele“.
  - **„Algab“ and „Lõpeb“.** Hint: „Tühjaks jättes kehtib kohe ja tähtajatult. Lõpu päev on kaasa arvatud.“
  - **„Kasutuskordi kokku“.** Hint: „Tühjaks jättes piiranguta. Kasutuseks ei loe tühistatud registreeringut ega üle ööpäeva vana maksmata registreeringut.“ (my call, D7)
  - **„Kellele“.** The choices: „Kõigile“, „Ainult esimesel koolitusel“ and „Ainult varasematele õpilastele“.
  - **„Üks kord inimese kohta“.** Hint: „Inimene on tema e-posti aadress.“
  - **The welcome row only:**
    - the field „Kehtib pärast liitumist (päeva)“, with the hint „Tervituskiri ütleb selle õpilasele. Tühjaks jättes tähtajatu.“;
    - the fixed text „Tervituskood kehtib uudiskirjaga liitunud aadressil, esimesel koolitusel ja üks kord.“.
  - **„Märkus“.** Hint: „Näeb ainult haldus.“
- **The messages.**
  - New: „Kirjuta kood.“, „Selline kood on juba olemas.“, „Sisesta summa eurodes.“, „Lõpp ei saa olla enne algust.“ and „Vali vähemalt üks koolitus.“.
  - Kept from today's Seaded and Hüpikaken checks: the code-shape message, „Soodustus peab olema 1–99%.“, „Sisesta täisarv.“ and „Kood saab kehtida 1–365 päeva.“.
- **Deleting.** „Kustuta sooduskood“ asks „Kas kustutan sooduskoodi {code}?“, with „Jah, kustuta“ and „Katkesta“.
- **The registration drawer.**
  - The row „Sooduskood“ shows „{code} · −{amount}“.
  - „Lisa sooduskood“ opens the field „Sooduskood“ with „Lisa“.
  - „Eemalda sooduskood“ asks „Kas eemaldan sooduskoodi? Hind on jälle {price}.“, with „Jah, eemalda“ and „Katkesta“.
  - Its refusals:
    - „Sooduskoodi saab lisada, kui midagi pole veel laekunud.“;
    - „Tühista enne maksmata arve.“;
    - „Sellist sooduskoodi ei ole.“.
- **Elsewhere:**
  - **Hüpikaken.** `codeWhere` becomes „Tervituskoodi ja soodustust saad muuta lehel „Sooduskoodid“.“
  - **The course editor's `nextDiscountHint`** gains: „Koodiga andes loo lehel „Sooduskoodid“ kood „Ainult varasematele õpilastele“.“
  - **The campaign editor's warning:** „Sellist aktiivset sooduskoodi pole. Lisa see lehel „Sooduskoodid“, muidu kood ei tööta.“
  - **Maria's notices** gain the row „Sooduskood: {code} (−{amount})“; „Registreerimine: …“ also gains „Kokku: {total}“ (§4.9).

## 6. Edge cases

- **The code changes between the check and the submit** (paused, ended, used up, or worth more or less): the submit refuses with the reason, or with `changed` (§4.6). Nothing is stored.
- **A late payment** keeps its price, and its use counts again even if the limit was reached meanwhile (my call: a paid order is never undone because of a code). Examples:
  - a järelmaks signed after 60 minutes;
  - a prepayment invoice paid by bank transfer more than 24 hours after the booking, which nobody cancelled.
  - „Kasutatud“ may then show 21 / 20.
- **Two unpaid orders by one person** (my call, D7):
  - A re-sent booking of the same course, or a new e-course payment while the last one is unpaid, gets a once-per-person code again. If both are paid later, she has used the code twice. Accepted: it needs two payments on purpose.
  - An unpaid booking of another course still holds her use, and the form answers `person`. She can pay that booking, or ask Maria to cancel it.
- **Midnight.** A code that ends today is valid until 23:59 Tallinn time. An order started at 23:58 keeps its discount when it is paid after midnight.
- **The course price changes after a booking:** D10 applies. The admin's drawer shows the list price, the code and the total.
- **A chosen course is deleted:** its join row goes with it. A code whose courses are all gone applies to nothing, and the list says „Valitud koolitustele: 0“.
- **A booking moves** to another session (a change request): the discount stays.
- **A registration on a cancelled session** counts as a training until Maria cancels the registration as well.
- **Maria renames the welcome code before anyone uses it:** the welcome mails already sent carry the old code, which is now unknown. The drawer's hint says so (§5).
- **Maria pauses the welcome code:** the footer drops the discount, the popup's button becomes „Liitu“, and welcome mails go out without a code.
- **The switch-over.**
  - Welcome mails and confirmed pages from before say „Sõnum“, so for a while a student may write the code there. Maria applies it with D11.
  - A Hüpikaken draft that still holds the old numbers is read without them, and a publish writes none. The builder checks that `server/site-drafts.ts` tolerates the extra keys.
- **Refunds.**
  - **A refunded e-course** gives its use back. Her access usually stays, so `first` still finds an earlier training.
  - **A partial refund** is a refund too (status `refunded`).
- **Unchanged.** The e-course `alreadyPaid` window and the 30-minute re-send rule stay as they are. A re-send with another code is a new attempt.
- **Languages.** Every public text has its Russian counterpart. The admin is Estonian only.

## 7. Tests

**Unit tests** (`tests/unit`):
- **`discount-codes-rules.test.ts`:**
  - the rounding: 10 % of 199,99 € is 20,00 €, and 15 % of 333,00 € is 49,95 €;
  - the 1 € floor;
  - `registrationTotal`;
  - every refusal, including the dates at Tallinn's midnight and the last day included;
  - the person rules, each with its own reason;
  - `codeValueText` and `codeState`.
- **`price-callers.test.ts`** (§4.7): the `listPrice` callers and the direct `course.price` reads.
- **The rule files** of contracts and financing gain the total, the discount row, and the järelmaks range taken on the total.
- **DOM tests:**
  - `ContactRegister`: apply, remove, the järelmaks choice under 100 €, the contract filled with the total, the remembered code, a typed code applied by the submit (sent with its discount, or refused at the field and not sent), the hint kept under a `person` error, `changed` checking again;
  - `EcoursePurchase`: „Kokku“, „Maksa {total}“ and a typed code applied by „Maksa“;
  - the admin drawer, in the style of `settings-editor-dom.test.ts`;
  - the Raha card;
  - the campaign editor's warning.
- **`old-safari.test.ts`** covers the new domain file.

**Database tests** (`tests/db`, PGlite):
- **`migration-0023.test.ts`:**
  - a code with a percent and days;
  - only the old `discountLabel`;
  - an empty code;
  - a code of the wrong shape.
- **`discount-codes.test.ts`:**
  - once per person, `first` and `returning`, with D7's training sources (paid, confirmed, unpaid, cancelled, an access, a paid e-course);
  - once per person's `except`: an unpaid, unconfirmed booking of the same course is left out (the re-send gets the code), whatever its age; a confirmed or part-paid one, or one of another course, is not; a pending, failed or abandoned e-course payment of the same course is left out, a paid or held one is not; a pending payment of another course counts inside its window and not after, nor once failed;
  - the subscriber rule with its days;
  - the limit under D7's counting: an unpaid booking counts for 24 hours and then stops; a confirmed or part-paid one keeps counting; a late payment on an old booking counts again, over the limit; a cancellation gives back; a failed payment gives back; a pending payment counts inside its window and not after;
  - the admin's create, edit, pause and delete;
  - a used code's text is refused.
- **The submit and start tests:**
  - a registration with a code stores the discount, the use and the contract in one transaction;
  - a refusal stores nothing;
  - every person reason answers `person`, and the responses are identical whatever the reason;
  - `changed` when the shown discount is smaller or larger than the server's, and when a code comes without `discountCents`;
  - an e-course start stores the amount, the code and the snapshot.
- **The money tests:** the settle invoice's discount line, `createInvoice`, `issueReceiptInTx`, `addManualPayment` against the total, the account card and the `/maksa` amounts.
- **The welcome code's tests:** the welcome mail and confirmed-page texts, and the footer value.
- **The existing welcome-code tests** move off `settings.newsletter.welcomeCode`:
  - `admin-site.test.ts`;
  - `seaded-route.test.ts`;
  - `popup-drafts.test.ts`;
  - `newsletter-welcome.test.ts`;
  - `actions.test.ts`;
  - the e2e specs `admin-site.spec.ts`, `campaign.spec.ts` and `gate.spec.ts`.

**E2E tests** (Playwright, with `tests/e2e/fake-montonio.ts`):
- **`discount-race.spec.ts`,** on real Postgres like `contracts-race.spec.ts`:
  - two registrations of one address for two different courses with the welcome code at the same moment: one gets it, the other is refused `person` (for the same course both would get it, D7);
  - limit 1 with two addresses: one gets it.
  - Run it with `--workers=1` and `--no-deps`.
- **`discount-codes.spec.ts`:**
  - a registration with a code: Montonio's amount is the discounted prepayment;
  - a cart with a code: the amount and the invoice line;
  - Maria creates a code, it is used, and the count shows the use;
  - the järelmaks threshold.

## 8. The test plan (standing rule)

The new and redone items get `"markedAt": "deploy"`. The area note „Enne alustamist“ names Proov 16–18:
- Proov 16 registers with a code;
- Proov 17 tests the welcome code;
- Proov 18 buys an e-course with a code.

The note „Koristamine“ adds two steps: pause each Proov code and write it in the check's note. Dim then deletes them, with their uses, by the exact code.

**New items** (`"new"`; each line is at most 20 words and ends with a full stop):
- `haldus-sooduskoodid-uus` (haldus, maria, arvuti) „Sooduskoodid: uus kood“
  - „Uus sooduskood +“ avab akna, mille all on nupp „Lisa sooduskood“.
  - Kood PROOV-16 on loendis olekuga „Aktiivne“ ja kasutusi on 0.
  - Sama kood uuesti annab teate „Selline kood on juba olemas.“.
  - „Soodustus (%)“: 100 annab teate „Soodustus peab olema 1–99%.“.
- `haldus-sooduskoodid-tervituskood` (haldus, maria, tahvel) „Sooduskoodid: tervituskood“
  - Esimene rida on märgiga „Tervituskood“, sama koodi ja protsendiga nagu enne.
  - Seadetes pole jaotist „Uudiskiri“ ja Hüpikaknas pole välja „Soodustus (%)“.
  - Tervituskoodil on alati „Ainult esimesel koolitusel“ ja „Üks kord inimese kohta“.
- `registreerimine-sooduskood` (registreerimine, maria, telefon) „Registreerimine sooduskoodiga“
  - Pärast „Rakenda“ on rida „Sooduskood PROOV-16: −… €“ ja väiksem „Kokku“.
  - „Loe lepingut“ näitab hinnana soodushinda.
  - Valikuga „50% registreerimisel + 50% koolituspäeval“ on testpanga summa pool soodushinnast.
  - Halduses on kaardil „Raha“ rida „Sooduskood“ ja soodushind.
- `registreerimine-sooduskood-vead` (registreerimine, dim, arvuti) „Sooduskoodi vead“
  - Tundmatu kood annab teate „Sellist sooduskoodi ei ole.“.
  - Peatatud või lõppenud kood annab teate „See sooduskood ei kehti enam.“.
  - Homme algav kood annab teate „See sooduskood kehtib alates …“.
  - Ainult e-koolituste kood annab siin teate „See sooduskood ei kehti sellele koolitusele.“.
  - Väikeste tähtedega kirjutatud kood rakendub samamoodi.
  - Rakendamata koodiga saatmisel rakendub kood ise ja Montonio summa on soodushind.
  - Pärast „Rakenda“ muudetud soodustusega annab saatmine teate „Sooduskood muutus vahepeal. …“ ja uue hinna.
- `registreerimine-tervituskood` (registreerimine, dim, arvuti) „Tervituskood: esimene koolitus, üks kord“
  - Proov 17 esimene registreerimine tervituskoodiga õnnestub soodushinnaga.
  - Proov 17 sama koolituse uus saatmine enne maksmist saab tervituskoodi uuesti.
  - Proov 17 registreerimine teisele koolitusele annab teate „Seda sooduskoodi ei saa selle e-posti aadressiga kasutada.“.
  - Proov 1 aadressiga on sama teade ja tervituskoodi vihje jääb selle alla näha.
  - Liitumata aadress ilma uudiste kastita saab sama teate.
- `registreerimine-sooduskood-tuhistamine` (registreerimine, maria, arvuti) „Tühistamine annab koodi tagasi“
  - Samal päeval: pärast „Tühista registreerimine“ väheneb koodi „Kasutatud“ ühe võrra.
  - Sama aadress saab tervituskoodi kasutada ka teisel koolitusel.
- `registreerimine-sooduskood-jarelmaks` (registreerimine, dim, arvuti) „Sooduskood ja järelmaks“
  - Kui soodushind jääb alla 100 €, kaob valik „Järelmaks (Inbank)“ ja näed piiri rida.
  - Inbanki testis on taotluse summa soodushind.
- `ekursus-sooduskood` (ekursus, maria, telefon) „E-koolituse ost sooduskoodiga“
  - Pärast „Rakenda“ on „Kokku“ soodushind ja nupul „Maksa …“ sama summa.
  - Montonio testpangas on sama summa.
  - Arvel on rida „Sooduskood …“ miinusmärgiga ja „Kokku“ on soodushind.
- `haldus-sooduskoodid-kasutused` (haldus, maria, arvuti) „Sooduskoodid: kasutused ja piir“
  - Koodi aknas on „Kasutused“ all Proov 16 registreering ja Proov 18 ost.
  - Kui „Kasutuskordi kokku“ on täis, saab järgmine teate „Selle sooduskoodi kasutuskorrad on otsas.“.
  - „Aktiivne“ välja lülitades tuleb riba „Sooduskood peatatud.“ ja nupp „Võta tagasi“.
  - Kasutatud koodil on tekst „Koodi on kasutatud — kustutada ei saa. Peata see.“.
- `haldus-sooduskood-registreeringule` (haldus, maria, arvuti) „Sooduskood registreeringule“
  - „Lisa sooduskood“ muudab hinna ja summa õpilase konto nupul „Maksa“.
  - Laekunud rahaga on teade „Sooduskoodi saab lisada, kui midagi pole veel laekunud.“.
- `avalik-jalus-tervituskood` (avalik, maria, any) „Jaluse tervitussoodustus“
  - Jaluses on tervituskoodi soodustus, näiteks „10% tervitussoodustus“.
  - Peatatud tervituskoodiga on jaluses „Uued koolitused ja kasulikud mõtted.“ ja hüpikakna nupp „Liitu“.
- `haldus-uudiskiri-kood-hoiatus` (haldus, maria, arvuti) „Uudiskirja kood ja sooduskoodid“
  - Tundmatu koodiga on välja all hoiatus „Sellist aktiivset sooduskoodi pole. …“.

**Redo or reworded:**
- `avalik-uudiskiri` (reworded): „Saa kood“ shows while an active welcome code exists.
- `kirjad-tervituskiri` (reworded): the new code lines, with the days from the welcome code.
- `haldus-hupikaken` (redo): no discount field, and the hint points to „Sooduskoodid“.
- `registreerimine-grupp`, `registreerimine-vorm-vead`, `ekursus-ost`, `ekursus-ostukorv-leping` (redo): the forms gained „Mul on sooduskood“.
- `registreerimine-arve-maksmiseks` (redo): Maria's amounts follow the total.

**Removed:**
- `haldus-seaded-uudiskiri`, replaced by `haldus-sooduskoodid-tervituskood`;
- `haldus-hupikaken-numbrid`, whose checks move to `haldus-sooduskoodid-uus`.

## 9. Out of scope

- **Personal single-use codes,** and codes generated for a student, such as an automatic "next training" code.
- **Gift vouchers with a balance, and free (0 €) bookings.**
- **Stacking codes,** and automatic discounts without a code (early bird, `next_discount` applied automatically).
- **Codes on individual-course requests, practice packages and products.**
- **Entering or changing a code after booking** from the student's side (the account, `/maksa`). Maria has D11 instead.
- **Applying a code retroactively** to registrations already paid. Maria refunds the difference in Montonio.
- **Matching a person** by phone or by Gmail aliases.
- **Reports on code use** beyond the drawer's list and the invoice CSV columns.

## 10. Open questions

Only questions whose answers change what gets built. Until an answer comes, the recommendation in each one stands.

**For Dim — answered 11.11 (all four as this document already describes):**
1. **Chosen courses now?** Yes: build „Valitud koolitustele“ now (D3).
2. **Maria's own codes.** „Lisa sooduskood“ in the drawer (D11) ignores the code's rules; the use still counts.
3. **„Ainult varasematele õpilastele“.** Yes: build it now, all three audiences (`all`, `first`, `returning`), before Maria answers her question 3.
4. **What is frozen.** Only the discount in euros (D10); the price keeps following the course as today.

**Migration number:** the areas filter and the certificate designs (specs of 11.11) are built first, so this takes the next free number then (likely 0025); every `0023` in this document means that number.

**For Maria (Estonian):**
1. „Kas tervituskood peab kehtima ainult uudiskirjaga liitunud e-posti aadressil? Minu ettepanek: jah, ja ka siis, kui inimene liitub uudiskirjaga samas registreerimisvormis.“
2. „Tervituskirjas on rida „Kood kehtib 30 päeva.“. Kas kood peab päriselt aeguma 30 päeva pärast liitumist? Kui ei, võtame selle rea kirjast ära.“
3. „E-koolituse lehel lubad „−10% järgmiselt koolituselt“. Kas selle jaoks on vaja koodi, mis kehtib ainult sinu varasematele õpilastele, või annad selle soodustuse ise?“

## 11. Left to the builder

- **Layout:** the field, the summary and the drawer, within §4.4–§4.10, the admin UX pass's conventions and the glossary.
- **The PDF rows** of the invoice and the contract, within §4.8.
- **Code structure:** whether `domain/welcome-code.ts` is folded into `domain/discount-codes.ts`.
- **Texts:** the Estonian and Russian beyond those quoted. They are Draft and go to Dim's wording sheet.

## 12. Additions after comparing Rempire's promo codes (11.11)

Dim asked to look at the discount codes of his other project, Rempire (an e-shop), for ideas. The plan's R14–R20 (`docs/superpowers/plans/2026-11-11-discount-codes.md`, "Amendments") carry them; all are my calls, the texts Draft:
- **Looser normalising:** spaces, non-breaking and zero-width characters inside a code are removed and dash variants folded to "-", so „tere 10“ copied from a phone works; a code needs at least one letter or digit.
- **A refund that leaves the access keeps the use:** a refunded e-course payment counts while the student keeps the course access (a partial refund is how Maria corrects a price).
- **Admin safety:** every save is checked over the whole stored code, not the changed field alone; switching between % and € empties the value; a euro amount above the highest list price in scope is refused („Soodustus on suurem kui koolituse hind.“); a delete racing a booking answers "used"; a code used only on cancelled or abandoned bookings explains why it cannot be deleted.
- **Small aids:** „Ava see kood“ next to "code already exists"; „Soodustust kokku“ (discount given in total) in the drawer.
- **Not taken:** Rempire never lets a code's text change; here it stays editable until first use, because the welcome code's text must stay changeable as today. Generated one-person codes and audit rows stay out of scope (§9).
