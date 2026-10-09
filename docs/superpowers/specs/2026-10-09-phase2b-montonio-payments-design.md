# Phase 2b: online payments with Montonio (design)

Date: 09.10.2026. Decisions by Dim, 09.10.2026, during the brainstorming. Status: approved design, spec for review.

## 1. Goal

Students can pay online through Montonio, Maria's payment provider: bank links, plus cards, Apple Pay and Google Pay if Maria
turns them on in her Montonio store.

- **Group registration:** the 100% or 50% prepayment is paid right after "Registreeru". A place is confirmed by itself once at
  least 50% is paid (the rule that exists today).
- **Paying later:** if she does not pay at once, a "Maksa" button in the mail and in Minu koolitused lets her pay later.
- **The rest after 50%:** she can pay the remaining 50% online too.
- **E-course:** "Osta kohe" leads to payment. A paid purchase creates or links her account, opens the course and mails her a
  login link.
- **Maria** gets a notice for every payment and an admin page "Maksed".

Phase 1 and the 2a specs promised this phase: e-course purchase with a bank link, contact-course payment of 100% or 50%, and
the booking confirmed after a prepayment of at least 50%. They placed instalments and invoice PDFs in phase 4.

## 2. Decisions (Dim, 09.10.2026)

| # | Question | Decision |
|---|---|---|
| D1 | When does she pay for a group registration? | At once after "Registreeru". If she closes the bank page, the confirmation mail and Minu koolitused keep a "Maksa" button. |
| D2 | Does an unpaid registration hold a seat? | Yes, for 30 minutes from "Registreeru" (Montonio's payment window), then it is freed. If she pays when the course is already full, the payment is recorded and Maria gets an alert. |
| D3 | What does an e-course buyer fill in? | Name, e-mail, the e-course terms box and the existing newsletter box. |
| D4 | Where is the bank or card chosen? | On Montonio's own checkout page. No bank logos on our site. |
| D5 | Can the remaining 50% be paid online? | Yes: "Maksa ülejäänud {summa}" in Minu koolitused until the training day. Paying on the day still works; Maria records that payment by hand. |
| D6 | Keep the bank transfer (IBAN + reference)? | Yes, as the second option under "Maksa". Maria records those payments by hand, as today. |
| D7 | How does Maria see payments? | Mail + Telegram for every payment, and a new admin page "Maksed". Payments also show on the registration row and in the student's drawer. |

## 3. What exists today (building blocks)

- **`registrations`:**
  - status `awaiting_prepayment | confirmed | cancelled`;
  - `paymentChoice` `full | half`;
  - `paidCents`.
  - The price always comes from the course (`registrationPrice`, `domain/registration.ts`).
  - `prepaymentDue` gives the amount: full = price, half = `ceil(price/2)`.
  - `registrationStatusAfterPayment` confirms the registration at `paid*2 >= price`.
- **`recordRegistrationPayment`** (`db/queries/admin.ts`): one transaction, `FOR UPDATE`, stores an absolute `paidCents` and
  sets the status. This is the core the webhook reuses.
- **Seats:** only `confirmed` registrations take a seat (`submit.ts`, `db/queries/public.ts`, `db/queries/admin.ts`,
  `domain/sessions.ts`). This phase changes that (D2).
- **E-course:**
  - The cart `/ostukorv` is a static, cached page per course. It says "Makse lisandub peagi" and stores a purchase-interest
    request (`handlePurchaseInterest`).
  - Access is `course_access` (`grantAccess` in `server/admin-clients.ts`, `grantedBy`, `expiresAt` = today + `accessMonths`).
  - `addClient` creates a client without mail.
- **Mails and limits:**
  - `sendMail`, `notifyMaria` (mail + Telegram), the builders in `server/account-mail.ts`;
  - `Deps.later` for work after the response;
  - the daily caps in `mail_quota`;
  - sample addresses are never mailed.
- **Gate:** `lib/site-gate.ts` `THROUGH` decides which routes pass the coming-soon page.
- **Cron:** one daily cron, `/api/cron/sweep`, with Bearer `CRON_SECRET`.
- **Reference:** Rempire's working Montonio integration (`rempire-web/src/lib/payments/*`). Its JWT, create, verify, the
  status map, "one door for every paid path" and the docs-payload tests are the pattern. This phase ports a slim version of it;
  there is no new dependency.

## 4. Montonio (facts this design relies on)

Source: docs.montonio.com, the Stargate API, checked 09.10.2026.

- **Base URLs:**
  - production `https://stargate.montonio.com/api`;
  - sandbox `https://sandbox-stargate.montonio.com/api`.
  - Keys are per store and per environment. Live keys on the sandbox URL give 401 `STORE_NOT_FOUND`.
- **Signing:**
  - Every request is a JWT, HS256, signed with the Secret Key.
  - Claims: `accessKey`, `iat`, `exp` (10 min for POST, 1 h for GET).
  - POST bodies are `{"data": "<jwt>"}`. GET requests use `Authorization: Bearer <jwt>`.
- **Order:**
  - `POST /orders` with `merchantReference`, `returnUrl`, `notificationUrl`, `grandTotal`, `currency` `EUR`,
    `locale` (`et`/`ru`), `payment: { method, amount, currency, methodOptions? }`, and optionally `expiresIn` (minutes,
    default 30) and `billingAddress`.
  - `grandTotal` and `amount` are euros as a number with up to 2 decimals (we keep cents and convert at the edge).
  - The reply is `{ uuid, paymentUrl, … }`.
- **Payment method:**
  - `payment.method` `paymentInitiation` (bank link) with **no** `preferredProvider`, so Montonio's page lists every bank and
    every method the store has turned on (D4).
  - `methodOptions.paymentDescription` = `MS LAB <viide>`.
  - We never send `paymentReference` (banks validate it strictly and payments fail on a bad one).
- **`merchantReference`:**
  - It is unique per store. Reusing it on an unpaid order overwrites that order; reusing it on a paid one is an error.
  - So **every payment gets its own new reference**, and a changed amount gets a new reference.
- **Webhook:**
  - `POST notificationUrl` with `{"orderToken": "<jwt>"}` on every status change.
  - Retried 13 times over 48 hours unless we answer 200/201.
  - Token fields: `uuid`, `accessKey`, `merchantReference`, `paymentStatus`, `paymentMethod`, `grandTotal`, `currency`,
    `paymentProviderName`.
  - Statuses: `PENDING`, `PAID`, `ABANDONED` (unpaid after the window), `VOIDED` (a rare bank reversal of a PAID),
    `PARTIALLY_REFUNDED`, `REFUNDED`.
- **Return:**
  - `returnUrl?order-token=<jwt>`, the same signed token. It also comes on cancel, with a non-PAID status.
  - Webhook and return may come in either order.
- **`GET /orders/:uuid`:** the current status. It is used to confirm a doubtful token and by the daily check.
- **Sandbox:** keys come from the Partner System (sandbox), Stores, API Keys. Test card `4111 1111 1111 1111` (03/30,
  CVC 737) per Rempire. Bank links work in the sandbox. A paid or failed bank flow cannot be simulated automatically, so it is
  a manual check at go-live.

## 5. Data (migration 0006)

The planned "0006 drops `courses.modules`" becomes 0007.

### 5.1 New table `payments`

One row per online payment attempt.

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `reference` | text, unique, not null | Montonio `merchantReference`: `MSLAB-M{id}`. Written right after the insert, in the same transaction. |
| `kind` | enum `prepayment \| balance \| ecourse` | |
| `registration_id` | int → registrations, `on delete set null` | for `prepayment` / `balance` |
| `course_id` | int → courses, `on delete set null` | always (what was bought) |
| `client_id` | int → clients, `on delete set null` | when known (e-course after payment; registration's client) |
| `email`, `name` | text not null | the payer as entered (kept for the books even if the account is deleted) |
| `locale` | `et \| ru` | |
| `amount_cents` | int not null, > 0 | |
| `status` | enum `pending \| paid \| failed \| refunded \| held` | `held` = paid at Montonio, but the amount or currency did not match (§7.4) |
| `provider_uuid` | text, unique when set | Montonio `uuid` |
| `method`, `bank` | text, default '' | from the token (`paymentMethod`, `paymentProviderName`) |
| `created_at`, `paid_at`, `updated_at` | timestamptz | |
| `newsletter` | boolean default false | e-course: the box ticked; acted on when paid |

### 5.2 New columns on `registrations`

- **`seat_hold_until timestamptz null`:** set to `now + 30 min` at "Registreeru" (D2) and when a new prepayment starts while a
  seat is free (§6.3).
- **`pay_token text unique not null`:** 32 random bytes in base64url (`newToken()`), filled for existing rows in the migration.
  The "Maksa" link in mails carries it (§6.3). It reveals nothing and is never logged.

### 5.3 Seats (D2)

A registration takes a seat when **`status = confirmed`**, or when **`status = awaiting_prepayment` and
`seat_hold_until > now()`**. One shared SQL expression or helper replaces the "confirmed only" counts in `submit.ts` (the full
check), `db/queries/public.ts` (calendar), `db/queries/admin.ts` (admin counts) and `domain/sessions.ts`. When the hold ends,
the seat counts are cached in public pages, so the daily sweep and every payment revalidate `seats`.
- **A short stale "Täis" is accepted.** A cached calendar can show "Täis" for up to 30 minutes after an unpaid hold ends. The
  registration form checks live, and the next revalidation (a payment, a registration, the daily sweep) fixes the page.

## 6. Flows

### 6.1 Group registration (D1, D2)

1. "Registreeru" runs as today (the `handleRegistration` checks: published course, upcoming scheduled session, not full),
   **plus**:
   - store `seat_hold_until = now + 30 min`;
   - create a `payments` row (`kind prepayment`, amount `prepaymentDue`);
   - call Montonio `POST /orders`;
   - return `{ ok: true, paymentUrl }`.
2. The form then sends the browser to `paymentUrl` (`location.assign`).
3. Montonio unavailable or keys missing:
   - the registration is still stored;
   - the answer is the success text of today, with "Maksa" offered later (mail, Minu koolitused) and the bank transfer
     details;
   - the payment row becomes `failed`, and nothing breaks.
4. The confirmation mail goes out as today, with:
   - a "Maksa {summa}" button (`/maksa/<pay_token>`);
   - the IBAN block under it as "või tasu pangaülekandega" (D6).

### 6.2 Paid (any kind): one door, `settlePayment`

1. The verified PAID token, with a matching amount (§7.4), moves the row `pending → paid` with a conditional UPDATE. **Only the
   winner of that update does the once-only work.** A second webhook, the return or the daily check finds it paid and does
   nothing.
2. **Prepayment or balance:**
   - add `amount_cents` to the registration's `paidCents` through the `recordRegistrationPayment` logic (absolute value =
     current + amount, in the same transaction, `FOR UPDATE`);
   - the status follows the existing rule (≥ 50% → `confirmed`);
   - **exception:** if the registration is not confirmed yet and the session has no free seat (counting holds of others,
     excluding her own expired hold), keep `awaiting_prepayment`, record the money and alert Maria ("Makse laekus, aga koolitus
     on täis") (D2);
   - revalidate `seats`.
3. **E-course:**
   - find or create the client for the e-mail (`accountOf` / `addClient`, the name stored when the client has none);
   - `grantAccess` with `grantedBy: "payment"` (a new grant, or a renewal moving `expiresAt`, as an admin grant does);
   - subscribe the e-mail if `newsletter` was ticked (the one-step newsletter path).
   - The cart's box is the purchase terms ("Õppetingimused", `/tingimused`), as on the registration form; its acceptance is
     the time of the purchase on the payment row. The e-course's own "Enne alustamist" terms step at the first opening stays
     as it is.
4. **Mail to the payer:**
   - "Koht on kinnitatud" (or "Makse on kätte saadud" when not yet confirmed or full), with the amount, what is left to pay
     and the date;
   - or "E-koolitus on avatud" with a login link (`verifyLink`, like the code login).
5. **Maria:** mail + Telegram "Uus makse: {nimi}, {mis}, {summa}".
6. **Not counted in the daily mail caps:** these mails follow real payments only. Sample addresses are never mailed.

### 6.3 Paying later (D1, D5): `/maksa/<pay_token>`

- **GET has no side effect.** It shows a small standalone page (like the newsletter unsubscribe page: `no-store`, noindex,
  same-origin POST) with:
  - the course, the date and the amount due;
  - the button "Maksa {summa}";
  - the bank-transfer details as the second option.
- **Amount due:**
  - not confirmed: `prepaymentDue − paidCents`;
  - confirmed but not fully paid: `price − paidCents` (the rest);
  - nothing due, cancelled, or past the training day: no button, a short sentence.
- **POST:**
  - re-checks the amount;
  - for an unconfirmed registration, a free seat is needed (counting holds), and it refreshes `seat_hold_until`. When the
    session is full there is no payment, and the page says so;
  - creates a `payments` row (`prepayment` or `balance`), calls Montonio, and 303s to `paymentUrl`.
  - Why a page and a button: mail scanners that open links would otherwise create orders and hold seats.
- **Minu koolitused:** the registration card's "pay" step gets the "Maksa {summa}" or "Maksa ülejäänud {summa}" button (a
  signed-in `POST /api/konto/maksa {registrationId}` with the same checks, which answers `{ paymentUrl }`). "Vaata juhiseid"
  keeps the IBAN block.

### 6.4 E-course purchase (D3)

1. The cart (static page) replaces "Makse lisandub peagi" and the purchase-interest form with a form:
   - name, e-mail (prefilled from the account if signed in, read client-side as today);
   - the e-course terms box (required, the current terms text link);
   - the newsletter box (unticked);
   - "Maksa {hind}".
2. A server action:
   - validates the input;
   - rate limits per IP as the forms do;
   - checks the course is a published e-course with a price;
   - creates a `payments` row (`ecourse`), calls Montonio, and returns `{ paymentUrl }`.
3. No account is created and nothing is opened before payment. An abandoned purchase leaves only a `pending`/`failed` row.
4. Montonio unavailable or keys missing: the cart keeps today's purchase-interest form ("Makse lisandub peagi") so nothing is
   lost.

### 6.5 Return page

- Montonio's `returnUrl` is `/api/payments/return?order-token=…`.
- The route:
  - verifies the token;
  - runs `settlePayment` (racing the webhook is safe by design);
  - 303s to the static page `/{locale}/makse#tulemus=<makstud|pooleli|katkestatud>&liik=<registreering|ekoolitus>[&maksa=<pay_token>]`.
- The fragment never reaches a server or cache.
- The page `app/[locale]/(site)/makse` is static, reads the fragment and shows:
  - **makstud:** "Makse õnnestus. Saatsime sulle kinnituse e-postiga." plus a link to Minu koolitused (or "Ava e-koolitus"
    after signing in);
  - **pooleli:** "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse." (the PENDING status);
  - **katkestatud:** "Makse jäi tegemata." plus "Proovi uuesti" (to `/maksa/<pay_token>` for a registration, to the cart for
    an e-course).
- A token that fails verification: 303 to the same page with `katkestatud` and no `maksa`. It never shows an error page.

### 6.6 Daily check

`/api/cron/sweep` (the existing daily cron) also:
- asks `GET /orders/:uuid` for every `pending` payment older than 45 minutes and younger than 14 days, at most 50 per run, and
  settles them through `settlePayment`;
- marks `pending` rows older than 14 days `failed`;
- revalidates `seats` when holds have ended since the last run.

## 7. Montonio module and settlement

### 7.1 Files

- `server/payments/jwt.ts`: HS256 sign and verify with `node:crypto`, `timingSafeEqual`, `alg` pinned, 60 s clock tolerance.
- `server/payments/montonio.ts`: `createOrder`, `fetchOrder`, `verifyOrderToken`, the status map, euro↔cent helpers, the
  env, the base URLs, a 15 s timeout, and Montonio's own error text kept.
- `server/payments/settle.ts`: `settlePayment`, the single door.

### 7.2 Configuration

- New variables:
  - `MONTONIO_ENV`: only the exact `live` means production; anything else is the sandbox;
  - `MONTONIO_ACCESS_KEY`;
  - `MONTONIO_SECRET_KEY`.
- They are optional entries in `server/env.ts`. A blank value counts as not set.
- `paymentsConfigured(env)` is true only with both keys. Without it:
  - the "Maksa" buttons are hidden;
  - the registration answer and the mail show today's texts;
  - the cart keeps the purchase-interest form;
  - `/api/payments/*` answer 404.
- **Never logged:** keys, tokens, `pay_token`. Log lines carry the payment id and status only.

### 7.3 Status map

| Montonio status | Our status |
|---|---|
| `PAID` | `paid` |
| `PENDING`, `AUTHORIZED`, unknown | `pending` (nothing changes) |
| `ABANDONED`, `VOIDED`, `CANCELLED`, `FAILED` | `failed` |
| `REFUNDED`, `PARTIALLY_REFUNDED` | `refunded` |

- **`paid` is a floor:**
  - a later `failed`/`ABANDONED` never undoes it;
  - a `VOIDED` after `paid` (a bank reversal, rare) is stored as `failed` and alerts Maria, but does not undo the
    confirmation or the access automatically (Maria decides).
- **`refunded`:**
  - only updates the row and alerts Maria;
  - it does not change `paidCents`, the registration status or access by itself;
  - Maria cancels or adjusts in the admin (refunds are done in Montonio's own dashboard, §11).

### 7.4 Settlement checks

**The token:**
- the signature (HS256, our secret);
- `accessKey` = ours;
- `merchantReference` finds our row;
- `uuid` = the row's `provider_uuid`.

**When the token can't be trusted as is:**
- a mismatch, or a token expired beyond the tolerance (late retries): confirm with `GET /orders/:uuid` and use Montonio's
  answer;
- no answer: reply 503 so Montonio retries.

**The amount:**
- `grandTotal` in cents must equal `amount_cents` exactly, and `currency` must be `EUR`;
- otherwise the row becomes `held`, nothing is confirmed or opened, and Maria gets an alert.

**Webhook replies:**
- 400 only for an unverifiable token;
- 200 for everything understood, including an unknown reference (logged);
- 503 on a database failure.

## 8. Admin

- **New page "Maksed"** (`/admin/maksed`, menu after "Registreerimised"):
  - newest first, 50 per page;
  - filter: Kõik / Makstud / Pooleli / Ebaõnnestunud / Tagastatud / Ootel kontrollil;
  - columns: date, payer (name, e-mail, link to the student), what (course + session date, or e-course), kind (Ettemaks /
    Ülejäänud / E-koolitus), amount, method/bank, status, Montonio id.
- **Registreerimised row:** under "Tasutud" the online payments (date, amount, status). Maria's manual "amount received" form
  stays.
- **Õpilased drawer:** a "Maksed" list for that client.
- **`held` and `VOIDED` rows:** a highlighted note "Kontrolli Montonios" on the row.

## 9. Mails and texts

All texts are drafts. ET is final after Dim's review; RU goes to the native-speaker check (launch checklist §9).

| Key | ET | RU |
|---|---|---|
| Pay button | Maksa {summa} | Оплатить {summa} |
| Rest button | Maksa ülejäänud {summa} | Оплатить остаток {summa} |
| Transfer label | või tasu pangaülekandega | или оплатите банковским переводом |
| Pay page heading | Koolituse eest tasumine | Оплата обучения |
| Pay page, nothing due | Selle registreeringu eest pole praegu midagi tasuda. | По этой регистрации сейчас ничего оплачивать не нужно. |
| Pay page, full | See koolitus on täis. Võta ühendust Mariaga. | Эта группа заполнена. Свяжитесь с Марией. |
| Return: paid | Makse õnnestus. Saatsime sulle kinnituse e-postiga. | Оплата прошла. Мы отправили вам подтверждение по e-mail. |
| Return: pending | Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse. | Платёж в обработке. Когда банк его подтвердит, мы пришлём подтверждение. |
| Return: cancelled | Makse jäi tegemata. | Оплата не прошла. |
| Retry | Proovi uuesti | Попробовать снова |
| Mail: confirmed (subject) | Koht on kinnitatud — {kursus} | Место подтверждено — {kursus} |
| Mail: received (subject) | Makse on kätte saadud — {kursus} | Платёж получен — {kursus} |
| Mail: e-course (subject) | E-koolitus on avatud — {kursus} | Онлайн-курс открыт — {kursus} |
| Maria | Uus makse: {nimi}, {mis}, {summa} | — |

- **Mail bodies** reuse the existing mail frame: course, date and place, paid amount, remaining amount ("Ülejäänud {summa}
  tasud koolituspäeval või Minu koolitused lehel"), and the login link for the e-course.
- **Russian:** a no-break space after one-letter prepositions, as everywhere.

## 10. Safety, gate, privacy

- **Gate:**
  - `/api/payments/notify` and `/maksa/*` (its GET page and POST) always pass the coming-soon gate.
  - `/api/payments/return` and `/makse` pass only like the rest of the site (the admin preview cookie) while the gate is on.
    Fine, because visitors cannot buy before the launch.
  - The webhook handles only POST, with a body limit of 8 KB.
- **Same-origin:**
  - `POST /maksa/*` and `POST /api/konto/maksa` refuse cross-site requests;
  - the `/maksa` page sends `Referrer-Policy: same-origin`, pinned in `next.config.ts` as for the unsubscribe page, so the POST
    keeps its Origin.
- **Rate limits:** starting a payment is limited per IP (as the forms) and per registration (at most 5 starts an hour).
- **CSP:** today's CSP has only `frame-ancestors`, so nothing to add. If a `form-action` is ever added, it must allow
  `https://*.montonio.com`.
- **Redirects:** `/api/payments/notify` must answer POST without a redirect (no trailing-slash redirect; checked in a route
  test).
- **Privacy:**
  - a payment row keeps name, e-mail and amount for the books, even after the account is deleted (`client_id` set to null);
  - the privacy text gets a line about payments through Montonio (Maria's text; launch checklist).

## 11. Not in this phase

- **Instalments (Inbank/Holm):** phase 4. The radio stays "Tulekul".
- **Invoice PDFs:** phase 4.
- **Refunds through the API:** Maria refunds in Montonio's own dashboard and adjusts the registration in the admin. The
  REFUNDED status shows on "Maksed".
- **Paying for individual courses:** Maria sets the price and sends an invoice.
- **Automatic reminders or cancellation of unpaid registrations.**
- **Bank logos on our site.**

## 12. Testing

- **Unit:**
  - JWT sign and verify (wrong secret, tampered, `alg: none`, expired beyond the tolerance);
  - the status map;
  - euro↔cent;
  - the amount-due rules;
  - the seat expression;
  - the dictionary texts (the RU preposition rule).
- **Docs payloads:** tests built from Montonio's own documented token payloads (Rempire's lesson: a fixture written to match
  the code hid a broken field).
- **DB (PGlite):**
  - `settlePayment` idempotency: the webhook twice, return + webhook, a late failed after paid;
  - the amount mismatch going to `held`;
  - prepayment → confirmed;
  - balance → fully paid;
  - a late payment on a full course staying unconfirmed with an alert;
  - an e-course grant: new client, existing client, renewal;
  - the newsletter on paid;
  - the 30-minute seat hold: holds, expires, and others can register;
  - the daily check (pending → paid via a fake `fetchOrder`, old pending → failed);
  - no keys → the old behaviour.
- **Routes:**
  - notify: 400 on a bad token, 200, 503 on a DB failure, POST without a redirect;
  - return: 303 targets;
  - `/maksa` GET with no side effect, POST same-origin only, cross-site 403;
  - `/api/konto/maksa` needs a session.
- **E2E (dev + prod build):**
  - a mock provider (`PAYMENT_PROVIDER=mock`, test-only, refused when `NODE_ENV=production` without an explicit flag) with a
    fake bank page offering paid / pending / cancelled;
  - group registration → bank → paid → confirmed card and mail;
  - cancelled → "Proovi uuesti";
  - pay later from `/maksa`;
  - the rest after 50%;
  - an e-course purchase → access + login link;
  - the admin "Maksed".
- **The gate config:** `notify` and `/maksa` pass, the return page is gated.

## 13. Go-live

1. Migration 0006 on Railway (additive) before the deploy.
2. Dim enters the **sandbox** keys and `MONTONIO_ENV=sandbox` in Vercel Production. Safe while the coming-soon gate is on:
   only admins can reach the buy flows. Then redeploy.
3. Live checks behind the gate, as an admin with the preview cookie, with sample addresses:
   - a group registration paid by a sandbox bank link, and by the test card;
   - the 50% rest;
   - an e-course purchase;
   - a cancelled payment and "Proovi uuesti";
   - `/maksa` from the mail link;
   - the "Maksed" page;
   - Maria's notice;
   - clean-up afterwards.
4. **Before the public launch** (launch checklist):
   - Maria's Montonio store is approved;
   - Dim enters the **live** keys and `MONTONIO_ENV=live`;
   - Maria turns on the methods she wants (cards cost more);
   - one real €1-level purchase with an immediate manual refund in Montonio.

## 14. Open items for the plan (not owner questions)

- Whether the plan splits the e-course purchase and the registration payment into separate tasks (yes, expected).
- The exact place of the "seats" helper so that all four counters use one expression.
- Porting Rempire's code: copy the logic, not the file layout. Rempire's comments are in Russian; MS LAB's are in English.
