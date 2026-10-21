# Instalments („Järelmaks") — design

Phase 4, piece 6 of 6. Dim (20.10.2026): "Maria will not be responsible for Installments and managing them if somebody paid or not, those probably need to run through a bank." He also asked whether it can be done through Montonio, or whether Inbank, ESTO and Holm must be added. Dim chose to skip the questions for phase 4, so every decision not attributed to Dim is my call and says so.

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
  - **When Inbank declines, or she abandons the application:** the order is not paid, exactly like an abandoned bank payment today. The registration stays and waits for payment, and her confirmation mail and account offer „Maksa" as today.
    - She can then pay by bank in full.
    - Maria can also mark a bank transfer.
    - Nobody is asked to do anything about the declined järelmaks.
  - **The order's time limit** for järelmaks is longer than a bank payment's, 60 minutes (my call), so an application in progress is not cut off. The builder checks Montonio's limits.
  - **The seat hold matches the time limit** (my call, from the builder check). A contact course's unpaid registration holds its seat for 30 minutes today, and a järelmaks attempt holds it for 60 instead. The re-send window and the late-check age follow the same 60 minutes. The start records the attempt's method on the payment row, so these rules can tell a järelmaks attempt from a bank one.
  - **A loan signed after the seat is gone** gets today's handling for any payment that arrives after the hold: the payment is recorded, Maria gets the „Täis" notice, and she refunds it in Montonio. The 60-minute hold makes this rare.
  - **The first build step is a sandbox trial** (my call). In Montonio's sandbox, one approved and one declined `hirePurchase` order are watched end to end: the statuses, the return, the webhook, the method name Montonio reports, and whether Inbank needs her phone. The code and its test stand-in (`tests/e2e/fake-montonio.ts`) follow what is observed. Montonio's public docs do not describe financing's status flow.
- **D6. What the records say.**
  - The payment row, the registration and the admin's „Maksed" show the payment method „Järelmaks (Inbank)" (Draft), as they show the bank today.
  - The contract's payment text says „Koolituse hind tasutakse täies ulatuses: järelmaksuga (Inbank) või pangamaksega." (Draft, my call, from the builder check). It stays true if a declined järelmaks is paid by bank afterwards, so the frozen contract is never wrong and nothing needs accepting again. `{ettemaks}` is the full price.
  - The receipt invoice is the normal paid invoice for the full price, with „Tasutud: järelmaks (Inbank)" (Draft).
- **D7. Refunds and cancellations** work as for any Montonio payment today, through Maria's existing actions. Montonio and Inbank handle the student's side. The site adds nothing.

## 3. Data (the next free migration number when built, additive)

0017 is taken by the admin UX pass (`0017_content_drafts`, its spec §7), so this migration takes the next free number when it is built.

- **The payment choice** `payment_choice` gains the value `financing`. It is an enum, so add it with `ALTER TYPE … ADD VALUE`.
- **The settings key** `financing` holds `{ enabled: boolean }` and defaults to off.
- **Nothing else.** The payment's method is already stored from Montonio's answer (`paymentMethodType`).

## 4. Edge cases

- **The price moves out of 100–5,000 €** (Maria edits the course) after the student chose järelmaks but before she paid. The press checks the amount again, and if it is out of range she is told to pick another choice: „Järelmaks on võimalik 100–5000 € hinnaga koolitusele." (Draft).
- **Maria switches järelmaks off** while a student has an open järelmaks order. That order finishes as it is, paid or not. No new järelmaks orders start.
- **The account's „Maksa"** for a registration whose choice is järelmaks, unpaid: it offers järelmaks again (while switched on) and a bank payment of the full price.
- **Which amount may go to Inbank** (my call, from the builder check). Järelmaks is offered only when nothing has been paid and the amount due is the full price, within 100–5,000 €. If Maria has recorded part of it by hand, or an invoice asks for a part, only the bank payment is offered. A registration booked with „100% kohe" or „50%" never gets järelmaks later; the choice is made at booking.
- **The 50% rest payment** is unaffected. A järelmaks registration has no rest.
- **Russian.** Every text has its RU counterpart (Draft).

## 5. The test plan (standing rule)

- **New checks** (`"new"`, `"markedAt": "deploy"`):
  - Seaded's toggle;
  - the course-page line;
  - the choice in the form and in the cart;
  - an approved järelmaks in Montonio's sandbox;
  - a declined or abandoned one;
  - the records (Maksed, invoice, contract).
- The payment checks get `redo` where the choices list changed.
- The paying checks are Dim's, done in Montonio's sandbox: his sandbox account must have financing switched on.

## 6. Out of scope

- ESTO, Holm, or a direct Inbank integration.
- BNPL (pay in 2–3 parts).
- A monthly payment calculator on the site.
- Järelmaks for the 50% rest.
- Individual courses (they have no online payment).
- Products and practice packages.

## 7. Before it can go live (Maria and Dim)

- Maria's live Montonio contract must include Inbank financing; she asks Montonio. Until then the toggle stays off.
- Maria confirms the fees with Montonio. Sources differ: financing may cost the merchant nothing, while pay-later costs about 2.4%.
- Dim's sandbox account has financing on, for the test checks.
