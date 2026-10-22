# Instalments („Järelmaks") — design

Phase 4, piece 6 of 6. Dim (20.10.2026): "Maria will not be responsible for Installments and managing them if somebody paid or not, those probably need to run through a bank." He also asked whether it can be done through Montonio, or whether Inbank, ESTO and Holm must be added. Dim chose to skip the questions for phase 4, so every decision not attributed to Dim is my call and says so.

**Montonio's answers (Harri Holm, 22.10.2026)** settle the open points. They change D5 and add D8; §3, §5 and §7 follow.
- **The sandbox** has järelmaks and „maksa hiljem“ switched on in test mode already. Inbank's demo decides by amount:
  - an Estonian järelmaks is approved at 0–500 €, so 100–500 € within Montonio's limits;
  - the Latvian table, possibly the same here, declines 901–1000 € and sends 501–700 € to manual review with proof of income.
  - The SMS code is always 0000, and the demo person is 10101010005. The phone must be an Estonian number for an Estonian shop.
- **Timing and statuses:**
  - Inbank answers in about a minute. Montonio's figures for finishing a järelmaks are a median of 4 minutes, a mean of 44 minutes, and 0.49% taking more than a day.
  - The order is PENDING, then PAID. PAID means the contract is signed.
  - **On a decline or abandonment the status does not change.** The student is sent back to the shop, and a järelmaks order stays PENDING and becomes ABANDONED only **after 7 days**, even if the payment initiation itself was cancelled.
  - An `expiresIn` of 60 minutes covers 99% of them; 90 is possible.
- **The hosted page:** an order made as `paymentInitiation` with no bank chosen shows **only banks**, never järelmaks. `method` decides the page. So our own choice „Järelmaks (Inbank)“ is needed, as D2 designs.
- **Customer data:** nothing is asked by the shop. The student identifies herself and gives her income in Inbank's flow. Montonio passes the amount and the merchant. If sent, the name, e-mail and phone fill in Inbank's form; Montonio recommends `billingAddress` with name, e-mail, `phoneNumber` and `phoneCountry`.
- **Money:**
  - After PAID, Inbank pays Montonio and Montonio pays the full amount to the merchant as a separate financing payout. The payout's description carries the order numbers.
  - It takes up to 8 working days. Montonio support can speed it up, usually to the same evening.
  - Järelmaks is free for the merchant; the interest (11.9%) and the fee are the student's. „Maksa hiljem“ costs 2.9% on Starter.
- **Refunds** through the Partner System or the API change the loan automatically: a partial refund lowers it, a full refund cancels it, and there is no cancellation fee.
- **Live:** nothing is real until Maria's company is verified. Järelmaks is then switched on automatically for a new company.

## 1. Why

A course costs hundreds of euros. Some students would book if they could pay over months.

Today the site offers two ways to pay, both through the Montonio checkout: „100% kohe" and „50% registreerimisel + 50% koolituspäeval".

**Success:**
- A student can choose to pay in instalments when she books a contact course or buys an e-course.
- A lender decides, signs the agreement with her and collects the instalments.
- Maria gets the full price at once and never tracks who paid what.

**Anti-goals:**
- **Maria as a creditor.** No instalment plan the site or Maria keeps track of, and no reminders to chase.
- **A new provider and contract for every lender.**
- **An option shown before Maria's Montonio account can actually take it.**
- **Advertising credit terms the site cannot state correctly.** Monthly amounts and APR come from the lender.

## 2. Decisions

- **D1. Through Montonio, with Inbank** (answering Dim's question).
  - Montonio's checkout already offers Inbank's financing as payment methods of the same API the site uses. Inbank decides on the credit, signs the agreement with the student and collects the instalments. Montonio pays the merchant in full.
  - So no separate Inbank, ESTO or Holm integration is needed. ESTO and Holm would each need their own contract and integration, and are out of scope.
  - Sources: [Montonio financing docs](https://docs.montonio.com/api/stargate/guides/financing), [Montonio pay later](https://www.montonio.com/pay-later), [Inbank × Montonio](https://inbank.eu/news/montonio-and-inbank-join-forces-to-offer-flexible-financing-solutions).
- **D2. One choice, „Järelmaks (Inbank)"** (my call, for simplicity).
  - It is Montonio's `hirePurchase` method: 100–5,000 € in Estonia, 3 to 72 months. The student picks the period in Inbank's own application.
  - The payment choices become: „100% kohe", „50% registreerimisel + 50% koolituspäeval" and „Järelmaks (Inbank)".
  - The interest-free "pay in 2 or 3 parts" (`bnpl`, 75–2,500 €) is left out for now. It can be added as a fourth choice later.
- **D3. Always the full price.** A student choosing järelmaks pays the whole course price through Inbank, and Maria receives it in full. There is no 50% variant with järelmaks.
- **D4. Where it shows.**
  - **Where the choice appears:** on the registration form of a group contact course, and in the e-course cart.
  - **Only when all of these hold:**
    - Maria has switched it on in Seaded → „Järelmaks (Inbank)": a toggle, off by default. She switches it on once her Montonio contract includes financing.
    - The price is within 100–5,000 €.
    - Montonio payments are on.
  - **On the course page,** next to the price, a quiet line „Võimalik tasuda ka järelmaksuga (Inbank)." (Draft) shows when the choice is offered.
  - **No monthly amounts or interest rates** are shown on the site (my call). Credit advertising rules require complete terms whenever a monthly figure is shown, and Inbank shows its own in its application.
- **D5. The flow is the existing Montonio flow** (my call).
  - Choosing järelmaks creates the same Montonio order as today, with `payment.method = "hirePurchase"` and the full price. The student goes to Inbank's application through Montonio and returns to the site.
  - **When Inbank approves and she signs:** Montonio reports the order paid through the same return and webhook the site already handles. From there everything is as for any paid order:
    - the registration is paid;
    - Maria's notice and the student's confirmation go out;
    - the receipt invoice is made;
    - the e-course opens.
  - **When Inbank declines, or she abandons the application** (Montonio, 22.10):
    - Montonio sends her back to the shop and the order **stays PENDING** for up to 7 days before it turns ABANDONED. There is no immediate "failed" to react to.
    - So the site treats her return like a bank payment that came back unpaid. The return page shows today's "not paid yet" state with „Maksa“, and from there she can pay by bank in full. The registration waits for payment, and her confirmation mail and account offer „Maksa“ as today.
    - Maria can also mark a bank transfer.
    - Nobody is asked to do anything about the declined järelmaks.
  - **The order's time limit** for järelmaks is 60 minutes (my call; Montonio: this covers 99%), so an application in progress is not cut off. Montonio itself keeps a järelmaks order PENDING for 7 days whatever `expiresIn` says, so the site does not count on an early ABANDONED.
  - **The seat hold matches the time limit** (my call, from the builder check). A contact course's unpaid registration holds its seat for 30 minutes today, and a järelmaks attempt holds it for 60 instead. The re-send window and the late-check age follow the same 60 minutes. The start records the attempt's method on the payment row, so these rules can tell a järelmaks attempt from a bank one.
  - **A loan signed after the seat is gone** gets today's handling for any payment that arrives after the hold: the payment is recorded, Maria gets the „Täis“ notice, and she refunds it in Montonio, which cancels the loan with no fee. With Montonio's 4-minute median this is rare.
  - **A declined järelmaks, then a bank payment** (my call). The järelmaks order may still be PENDING when she pays by bank; the bank press starts a new attempt (a new payment row and order), as §4 says. If Inbank later approves the old application after all and both are paid, today's double-payment rule applies: the second is recorded and goes under „Ootel kontrollil“ as „Topeltmakse“, and Maria refunds it in Montonio. A full refund of the loan cancels it.
  - **No separate sandbox trial before building** (my call, changed after Montonio's answers). The status flow is now known, so the code and its test stand-in (`tests/e2e/fake-montonio.ts`) follow Montonio's description. Dim's sandbox checks in the test plan (§5) confirm it: an approved and a declined application, the method name Montonio reports, and the return.
- **D6. What the records say.**
  - The payment row, the registration and the admin's „Maksed" show the payment method „Järelmaks (Inbank)" (Draft), as they show the bank today.
  - The contract's payment text says „Koolituse hind tasutakse täies ulatuses: järelmaksuga (Inbank) või pangamaksega." (Draft, my call, from the builder check). It stays true if a declined järelmaks is paid by bank afterwards, so the frozen contract is never wrong and nothing needs accepting again. `{ettemaks}` is the full price.
  - The receipt invoice is the normal paid invoice for the full price, with „Tasutud <kuupäev> · Järelmaks (Inbank)“ (Draft; no nested brackets).
- **D7. Refunds and cancellations** work as for any Montonio payment today, through Maria's existing actions. Montonio and Inbank handle the student's side: a partial refund lowers the loan and a full refund cancels it, with no fee (Montonio, 22.10). The site adds nothing.
- **D8. The order carries the student's details** (my call, from Montonio's recommendation). For a järelmaks order the site sends `billingAddress` with her first and last name and e-mail, so Inbank's form is filled in for her.
  - Her phone is sent as `phoneNumber` + `phoneCountry: "372"` (Montonio's orders guide gives the calling code, e.g. "372") only when it is an Estonian number (+372, or eight digits starting 5 or other Estonian mobile prefixes as the form stores them). Inbank needs a number of the shop's country, so a foreign number is left out and she types one in Inbank's form.
  - Nothing else is sent. Personal ID codes are never collected (Inbank asks for them).
  - Bank orders stay as they are.

## 3. Data (the next free migration number when built, additive)

0017 is taken by the admin UX pass (`0017_content_drafts`, its spec §7), so this migration takes the next free number when it is built.

- **The payment choice** `payment_choice` gains the value `financing`. It is an enum, so add it with `ALTER TYPE … ADD VALUE`.
- **The settings key** `financing` holds `{ enabled: boolean }` and defaults to off.
- **Nothing else.** The payment's method is already stored from Montonio's answer (`paymentMethodType`).

## 4. Edge cases

- **The price moves out of 100–5,000 €** (Maria edits the course) after the student chose järelmaks but before she paid. The press checks the amount again, and if it is out of range she is told to pick another choice: „Järelmaks on võimalik 100–5000 € hinnaga koolitusele." (Draft). **Dim 22.10:** when the price is in range but the choice was switched off since the page loaded, the student sees its own sentence instead: „Järelmaks pole praegu saadaval. Saad maksta pangalingiga.“ (RU „Рассрочка сейчас недоступна. Можно оплатить через интернет-банк.“); the range sentence stays for a price outside 100–5000 €.
- **Maria switches järelmaks off** while a student has an open järelmaks order. That order finishes as it is, paid or not. No new järelmaks orders start.
- **The account's „Maksa"** for a registration whose choice is järelmaks, unpaid: it offers järelmaks again (while switched on) and a bank payment of the full price.
- **Which amount may go to Inbank** (my call, from the builder check). Järelmaks is offered only when nothing has been paid and the amount due is the full price, within 100–5,000 €. If Maria has recorded part of it by hand, or an invoice asks for a part, only the bank payment is offered. A registration booked with „100% kohe" or „50%" never gets järelmaks later; the choice is made at booking.
- **The 50% rest payment** is unaffected. A järelmaks registration has no rest.
- **Russian.** Every text has its RU counterpart (Draft). **Dim 22.10:** paying by bank is „Интернет-банк“ in Russian everywhere: the cart choice „Интернет-банк“, the buttons „Оплатить через интернет-банк“ (today „Банковская ссылка“ and „Оплатить через банк“); the course page's „через интернет-банк“ stays.
- **A late järelmaks after a paid bank payment** (my call, from the code check 22.10). A declined application stays PENDING for 7 days, so she may pay by bank and Inbank may still approve the old one.
  - A järelmaks order that turns PAID while its registration (or her e-course access from the same e-mail) is already paid in full is held, not counted: status `held` („Ootel kontrollil“).
  - Maria gets the „Topeltmakse“ notice and refunds it in Montonio, which cancels the loan.
  - For an e-course this is the only backstop, since a second payment there has none today.
  - **The same the other way round for an e-course** (built in Task 4, the controller's ruling from D5's "the second … Topeltmakse"): a bank payment that turns PAID while a järelmaks of the same course and e-mail was paid at or after that bank payment started is held and told the same way. A registration's bank payment after a paid loan keeps today's „Ülemakse“ rule. A purchase paid before the second one started is a deliberate renewal and counts as today.
  - **Maria's note** in the „Topeltmakse“ mail (Draft; the subject is „Topeltmakse: {nimi}, {mis}, {summa}“ and the line after it is the note, `paymentAlertSummary` in `server/messages.ts`):
    - a registration's late loan: „Järelmaks (Inbank) laekus, kui koolitus oli juba täies ulatuses tasutud. Seda ei pandud kirja: makse on lehel Maksed "Ootel kontrollil". Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu.“
    - an e-course's late loan: „Järelmaks (Inbank) laekus, kui e-koolitus oli juba tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: makse on lehel Maksed "Ootel kontrollil". Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu.“
    - an e-course's bank payment after a paid loan: „Pangamakse laekus, kui e-koolitus oli juba järelmaksuga (Inbank) tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: makse on lehel Maksed "Ootel kontrollil". Tagasta see Montonio halduses.“
  - **The refund note after she refunds a held row** (final review, Draft). Every late payment ends with Maria refunding a row that was never counted (`paid_at` empty), and the usual refund note („Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.“) would invite her to lower a correct sum. A refunded row that was never counted gets, after „Montonio teatab tagastusest (tagastatud).“: „Seda makset ei pandud kirja: adminis pole vaja midagi muuta.“ A counted row's note is unchanged. Maria's alerts are Estonian only.
- **Starting another payment while one is open** (my call). The re-send of an open attempt (the same row and order) only happens for the same method. A bank press while a järelmaks attempt is open, or the other way round, starts a new attempt. So a bank payment never overwrites a pending loan application.
- **The return page** for a järelmaks order that is still PENDING (Draft). It says „Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.“ and offers „Maksa pangalingiga“ next to „Proovi uuesti“. The bank text („Kui pank selle kinnitab …“) stays for bank orders.
- **„Maksa“ for a järelmaks registration** (the account, the confirmation mail's link and the pay page, Draft). While järelmaks may be offered (above), there are two buttons: „Maksa järelmaksuga (Inbank)“ and „Maksa pangalingiga“. Otherwise there is one, as today.
- **The e-course cart** shows a choice only while järelmaks is offered for that price (Draft): „Pangalink“ (default) and „Järelmaks (Inbank)“. Otherwise it is as today.
- **The old placeholders go.** These were „Järelmaks — tulekul“ on the contact form, „Vormista järelmaks — tulekul“ on the e-course page, and the seed FAQ line „… järelmaks lisandub hiljem.“.
  - The live FAQ is Maria's content and is not touched.
  - The disabled radios are replaced by the real choice when it is offered, and removed when it is not.
- **The name and phone in `billingAddress`** (D8, my call).
  - `firstName` is everything before the last word of her name, and `lastName` is the last word. A one-word name goes in both.
  - The phone counts as Estonian when, after spaces, dashes and brackets are removed, it starts with +372 or 372 followed by 7–8 digits, or is 7–8 digits starting with 5 (mobile) or 3–8 (landline). It is sent without the country code, with `phoneCountry: "372"`.

## 5. The test plan (standing rule)

- **New checks** (`"new"`, `"markedAt": "deploy"`):
  - Seaded's toggle;
  - the course-page line;
  - the choice in the form and in the cart;
  - an approved järelmaks in Montonio's sandbox;
  - a declined or abandoned one;
  - the records (Maksed, invoice, contract).
- The payment checks get `redo` where the choices list changed.
- The paying checks are Dim's, done in Montonio's sandbox, where financing is already on (Montonio, 22.10). Each uses Inbank's demo person 10101010005 with SMS code 0000 and an Estonian phone:
  - an approved application at a price of 100–500 €;
  - a declined one at 901–1000 €, to be confirmed for Estonia;
  - a manual review at 501–700 €: it stays PENDING, and the site shows „not paid yet“.
- Maria's courses cost more than 500 €? Then one sample course priced within 100–500 € is used for the approved check.

## 6. Out of scope

- ESTO, Holm, or a direct Inbank integration.
- BNPL (pay in 2–3 parts).
- A monthly payment calculator on the site.
- Järelmaks for the 50% rest.
- Individual courses (they have no online payment).
- Products and practice packages.

## 7. Before it can go live (Maria and Dim)

- Maria verifies her company in Montonio (signatory confirmation). Järelmaks is then switched on automatically for the live store (Montonio, 22.10). Until then the toggle stays off and only test payments work.
- **Fees** (confirmed 22.10): järelmaks is free for the merchant. „Maksa hiljem“, which is not built, would be 2.9% on Starter.
- **Payouts** (Maria's accounting): a järelmaks arrives as a separate payout from Montonio, up to 8 working days after PAID, with the order numbers in its description. Support can speed one up on request.
- The sandbox already has financing on, for the test checks.
