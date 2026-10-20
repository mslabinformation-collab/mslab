# Newsletter campaigns („Uudiskirjad") — design

Phase 4, piece 5 of 6. Dim agreed the order on 16.10.2026. Dim (18.10.2026): "We will use resend for everything." Dim chose to skip the questions for phase 4, so every decision not attributed to Dim or Maria is my call and says so.

## 1. Why

On 06.10 Maria asked to send newsletters and campaigns: codes, offers, and flyers she designs (Dim's notes of her Telegram message, `.superpowers/feedback/2026-10-08-maria.md` row 2).

What exists today:
- Sign-up is one step (09.10). Each subscriber is one `subscribers` row, holding the address, the language, the consent time and a permanent unsubscribe token.
- Visitors sign up from the footer form, the popup, the registration form's checkbox and the „Minu andmed" switch.
- Subscribers get a welcome mail with Maria's welcome code. The unsubscribe link `/api/newsletter/loobu?t=…` deletes the row.
- The admin page „Uudiskiri" lists the subscribers and exports a CSV.
- Nothing sends to the list.

**Success:**
- Maria writes a campaign in the admin, in Estonian and optionally Russian. It can hold a picture (her flyer), a few paragraphs, a code and a button.
- She sees exactly what the mail looks like, sends herself a test, and sends it to every subscriber.
- Each subscriber gets it in her language, with a working unsubscribe link.
- The mail never competes with the site's own mails: login codes, confirmations, protocols, invoices, contracts.
- It costs nothing at today's size.

**Anti-goals:**
- **Sending without consent.** Only subscribers get campaigns. Buyers and students are not added without their own sign-up.
- **An unsubscribe that doesn't stick.** Anyone who unsubscribes, by any route, gets no further campaign.
- **A campaign that eats the daily mail quota** so a student cannot get her login code.
- **A send Maria cannot undo by accident.** Every send is confirmed with the exact count. A sent campaign is never changed afterwards.
- **A paid plan by surprise.**

## 2. Decisions

- **D1. Campaigns go out as Resend Broadcasts** (Dim: Resend for everything; the mechanism is my call).
  - Resend's marketing side holds contacts in segments and sends one broadcast to a segment.
  - The free marketing plan allows 1,000 contacts with no cap on the number of mails, and it is billed apart from the transactional quota (free: 100 a day, 3,000 a month). That quota stays for the site's own mails.
  - Sending one mail per subscriber through `/emails` would spend that quota, so it is not used for campaigns.
  - The only exception is „Saada proov" (D6), which sends one transactional mail.
    - (amended 19.10 during the build, R4) There is no exception any more: „Saada proov" is a broadcast to a one-contact test segment too (D6). No campaign and no test goes through `/emails`.
  - **One Resend account for everything** (Dim, 19.10: "Same account"). Campaigns go out from Maria's existing Resend account and the sending domain `send.mslab.ee` (`MAIL_FROM`), with Maria as the reply-to.
    - Dim accepted the cost: Resend's suppression list covers the whole account, so an address that bounces, or that marks a campaign as spam, also stops getting the site's own mails (login codes, confirmations, protocols, invoices, contracts).
    - D10 makes that visible.
  - **Open and click tracking stay off** (my call, from the builder check). Turning them on for `send.mslab.ee` would rewrite the links in every transactional mail and add a tracking pixel to them. Maria sees deliveries, bounces and unsubscribes in Resend's dashboard.
- **D2. The site's database stays the record of consent** (my call).
  - **The segments.** The site keeps a Resend contact for every subscriber, in one of two segments:
    - „MS LAB uudiskiri (ET)"
    - „MS LAB uudiskiri (RU)"

    The segment follows the subscriber's `locale`.
  - **Who creates them.** The site creates both segments on first use and stores their ids in settings. Nobody types an id.
  - **When the site syncs.** It syncs after every change to `subscribers`:
    - a sign-up from any of the four places;
    - the site's own unsubscribe link;
    - the „Minu andmed" switch;
    - a language change;
    - an account's deletion.
  - **What a failure does.** A sync failure never fails the visitor's action. The row keeps a "not synced" mark, and the next sync retries.
  - **Full sync.** One "full sync" compares every subscriber with Resend and fixes the differences. It runs:
    - right before every send;
    - from a button „Sünkrooni Resendiga" on the „Uudiskiri" page;
    - in the daily cron (`/api/cron/sweep`).
  - **One at a time** (amended 19.10 during the build, R9 and R11). A full sync holds a lease: the setting `newsletter_sync_lease`, `{ holder, until }`, taken by one conditional write and given back by its holder at the end; if the holder dies it ends by itself at `until` (the sync's time budget and 30 seconds). The daily cron, the button, a send (its sync and its broadcasts) and „Saada proov“ all run under it. A second caller does nothing and answers „Sünkroonimine juba käib — proovi hetke pärast uuesti.“ (Draft). A holder whose lease ran out and was taken over leaves the new holder's row alone.
    - (amended 19.10 during the build, the final review) **What the lease covers, exactly.** The first set-up of the segments runs under the lease when a full sync, a send or a test does it; a sign-up's own sync (one address, no lease) makes them under a transaction lock (`pg_advisory_xact_lock`) instead, and either way they are made only once, because both re-read the setting under that lock before making anything. A send's `until` is longer than a sync's: the sync's budget, 30 seconds, and the two broadcasts' own time (`SEND_LEASE_MS`, about 35 seconds), some 90 seconds in all for the button's 25-second budget.
  - **What the sync touches** (amended 19.10 during the build, R6). Sample addresses (`@example.test`) are never synced and never counted as unsynced, and a contact of theirs in the site's segments is removed. Only the two segments are the site's: a contact there without a subscriber row is taken out of them, and deleted only when it is in no other segment of Maria's account; a contact in neither segment is never touched.
- **D3. Unsubscribing** (my call, from the builder check).
  - **The visible link is the site's own.** The campaign's footer link is the site's existing page, `/api/newsletter/loobu?t=<her token>`, in Estonian or Russian. Resend's hosted page is one English page per account and carries Resend's footer on the free plan.
    - The token reaches the mail as a contact property, which the sync stores on her contact. Broadcasts fill contact properties into the mail.
    - Pressing the site's link deletes the row and the Resend contact, as below.
  - **Resend's one-click unsubscribe also counts.** It covers the mail program's own unsubscribe button and any unsubscribe made inside Resend, and Resend marks the contact unsubscribed for every broadcast. The site brings that back two ways:
    - A Resend webhook (`contact.updated`, signed) deletes the subscriber's row at once. Builder: confirm that Resend fires it on that unsubscribe. If it does not, the full sync is the route.
    - Every full sync reads the unsubscribed contacts and deletes their rows before anything is sent. A send therefore never goes to someone who unsubscribed through Resend, even if a webhook was lost.
  - **The site's own unsubscribe** (the welcome mail's link, the „Minu andmed" switch) deletes the row, as today, and deletes the Resend contact.
  - **Signing up again.** A person who unsubscribed through Resend and later signs up again on the site is a new consent. The site sets her contact back to subscribed.
    - (amended 19.10 during the build, R1) **A fresh consent wins.** The full sync deletes the row of a contact that unsubscribed in Resend only when the row has been synced (`synced_at` is set) and its `consent_at` is before the sync began; a row not yet synced is a fresh consent, so its contact is pushed subscribed instead. The webhook deletes the row only when its `consent_at` is before the event's `created_at`, and only `contact.updated` with `unsubscribed: true` acts (the site's own updates fire it too). The cost, if wrong: one more mail to someone who signed up again and unsubscribed in the same minute. Whether Resend fires `contact.updated` on its one-click unsubscribe was not confirmed in the build (no live Resend): Dim's first live check shows it (`docs/deploy.md` section 19), and the full sync is the route if it does not.
- **D4. Maria writes campaigns in the admin** (my call; see §8 for the cheaper alternative).
  - **The tab.** A new tab „Kampaaniad" on the „Uudiskiri" page. Each campaign has:
    - an internal name;
    - the subject, ET and RU;
    - a preview line, ET and RU (the grey line after the subject in most inboxes);
    - an optional picture from an upload: her flyer, kept like the site's other images;
    - the text in paragraphs, ET and RU, in the same editor as the site's other texts („Tühi rida alustab uut lõiku.");
    - an optional code, shown in a box like the welcome code;
    - an optional button, with its label (ET and RU) and an address.
  - **Russian.** The Russian fields are optional. When the Russian subject or text is empty, Russian subscribers get the Estonian version, and the admin says so before sending: „Vene keeles tellijad saavad eestikeelse kirja." (Draft).
    - (amended 19.10 during the build, R2) A Russian text with a button needs its own Russian button label: without it the field says „Lisa nupu tekst ka vene keeles." (Draft), so nothing is mixed and nothing is dropped silently. An empty Russian preview line means none (it is optional).
  - **The preview.** A live preview beside the fields shows the mail as it will look, in both languages.
- **D5. The mail's look** (my call). It follows the site's account mails: the white card on the pale background, with Jost-like system fonts in mail. It also adds:
  - **A header:** the MS LAB logo at the top, as an image from the site.
  - **The body:** the picture, full width of the card; then the paragraphs; then the code; then the button.
  - **A footer:**
    - „Said selle kirja, sest liitusid MS LAB-i uudiskirjaga." (Draft);
    - the unsubscribe link „Loobu uudiskirjast" (Draft);
    - the school's name and address from Seaded → „Arve andmed", or "MS LAB" when it is empty.
  - **The plain-text version** is generated from the same content.
- **D6. Sending** (my call).
  - **„Saada proov".** It sends the current draft to one address: Maria's (`MARIA_EMAIL`) or the signed-in admin's.
    - It is one transactional mail, at most 10 an hour.
    - Its subject starts with „[Proov]".
    - In the test, the unsubscribe link points to the site's page and says it is a test.
    - (amended 19.10 during the build, R4 and R7) **It is a broadcast, not a transactional mail** (of the lines above the choice of address, Maria's or the signed-in admin's, the „[Proov]“ subject and the limit of 10 an hour stand; amended again 19.10, the final review, which found the address choice left out). It goes to a segment of one contact, „MS LAB uudiskiri (proov)" (made on first use, its id kept under the setting `resend_test_segment`), that holds the address chosen and no one else, so the test is exactly what a subscriber gets: Resend's placeholder for the unsubscribe link, its own rendering and all. The test contact's `unsubscribe_url` is the site's test page, `/api/newsletter/loobu?proov=1`, which says it is a test and changes nothing, **only when the address is not a subscriber's**. When it is, her own real link stays, and the admin says „Proov läheb tellija-aadressile — selle loobumislink on päris." (Draft), so Maria cannot unsubscribe herself by pressing her own test link. The cost: one extra contact in Resend's count, and a test to an address that is already a Resend contact sets that contact `unsubscribed: false`, account-wide.
    - (amended 19.10 during the build, the final review's M7) **A test to a subscriber who unsubscribed in Resend is not sent.** Her contact keeps its `unsubscribed: true` (R7), so Resend would deliver nothing: the site sends no broadcast, does not count it against the hour, and says „Proovi ei saadetud: see aadress on Resendis uudiskirjast loobunud, nii et kampaania sinna ei jõuaks.“ (Draft) instead of „Proov läks …“.
  - **„Saada kõigile".** It first runs the full sync (D2), then shows the confirmation: „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?"
    - On „Saada" the site creates one broadcast per segment that has subscribers and sends it at once.
    - It records the broadcast ids, the counts and the time.
    - Two presses, or two tabs, send once: the campaign row is locked and its status checked.
    - (amended 19.10 during the build, R14) **The confirmed counts are compared at send time.** „Saada“ runs the full sync again, and when the counts after it differ from the ones Maria confirmed, nothing is sent: „Tellijate arv muutus vahepeal — vaata üle ja kinnita uuesti.“ (Draft), with the new counts to confirm.
    - (amended 19.10 during the build, the final review's M3) **So is the campaign itself.** The confirmation carries the campaign's last change (`updatedAt`); when it moved (another admin saved the draft in another tab), nothing is sent: the answer is `changed` too, checked again under the row lock, and the editor says „Kampaaniat muudeti vahepeal mujal (nt teises aknas), seega ei saadetud midagi. Laadi leht uuesti ja vaata kampaania üle.“ (Draft).
    - (amended 19.10 during the build, R13) **Interrupted means never resent.** A third status, `sending`, is written (with the counts) in the same short transaction that locks the campaign row and checks it is still a draft, before the first broadcast; no row lock is held across a Resend call. A broadcast Resend refused (a 4xx) was not made: with nothing gone the campaign is as it was; with one language gone it is `sent` with that language. A broadcast that got no answer (a timeout, a 5xx) may have gone: the campaign stays `sending`, and nothing offers it again by itself. Maria sees what is recorded, a link to Resend's list of broadcasts and „Ära kopeeri enne, kui oled Resendis kontrollinud.“ (Draft), because „Kopeeri“ would mail everyone again.
      - (amended 19.10 during the build, the final review's M2) **Refused means stated.** Only a 400, 401, 403, 404, 422 or 429 (after its second try), or an error Resend names as a validation or key error, counts as „the broadcast was refused, nothing sent“. Every other answer (a 5xx whatever its name, a 405, 408, 409, 413, 451, a gateway's 499) or none is `interrupted`.
      - (amended 19.10 during the build, R16) **A half-sent campaign says what went, and never sends Maria to „Kopeeri“.** The `sending` view and the list row show each language with its state: sent (its time, its count, its Resend link) or unknown (no answer was recorded). The words say that a copy would mail those who already got it; „Ära kopeeri enne, kui oled Resendis kontrollinud.“ is gone. For the first language of the send without a recorded broadcast (a send goes Estonian first and stops at the first broadcast without an answer, so a language after it was never tried) it offers „Märgi saatmata“ (Draft) behind „Kas kontrollisid Resendis, et {keel} kirja seal pole?“ (Draft). Under the row lock that records the language as not sent: with the other language recorded the campaign is `sent` with this one missing, so „Saada puuduv keel“ (R12) can send it; with nothing recorded it is a draft again. A language with a recorded broadcast can never be marked not sent. The cost, if Maria misreads Resend: that language gets the campaign twice.
      - (amended 19.10 during the build, R18) **Never while a send runs.** „Märgi saatmata“ takes the newsletter's lease for its own short write: while a sync or a send holds it, the mark answers „Sünkroonimine juba käib — proovi hetke pärast uuesti.“ and changes nothing (a send seen from another tab or after a reload may still be on its way, and Resend's list may not show it yet), and no send can start while it writes. A send records a broadcast, and its end, only on the `sending` row it wrote itself; a row changed under it gets nothing written, so no broadcast is ever recorded on a draft.
      - (amended 19.10 during the build, the re-review's N2) A language after the one without an answer was never tried: it reads „Ei saadetud ({lang}) — eelmine keel jäi vastuseta.“ (Draft), not „Pole teada“. When the first language did go though its answer never came, the campaign stays `sending` and nothing on the page can say so: Dim records that broadcast in the database (`docs/deploy.md` section 19, item 4), after which „Märgi saatmata“ applies to the second.
  - **After sending.**
    - The campaign is read-only, with „Saadetud {date} · {n} tellijale".
    - A link opens it in Resend's dashboard, where the delivery, bounce and unsubscribe numbers are (tracking is off, D1).
    - „Kopeeri" makes a new draft from it.
    - (amended 19.10 during the build, R12) **„Saada puuduv keel"** (Draft). A campaign sent in one language only (Resend refused the other) offers this button, which sends only the missing language's segment, under the same lease, sync, count and row-lock rules. „Kopeeri“ stays for new campaigns: on such a campaign it would mail the language that already went twice. (amended 19.10 during the build, R16) A language Maria has marked „Märgi saatmata“ after a send without an answer is missing the same way, and is sent the same way.
- **D7. Who receives** (my call). Every row of `subscribers` that is confirmed.
  - Rows still unconfirmed from the old two-step sign-up (before 09.10) are not sent to.
  - Students and buyers who never signed up get nothing. Estonian law's "similar products" exception would need an opt-out offered at the purchase, and the forms never offered one.
- **D8. The plan's limits** (my call). The „Uudiskiri" page shows the number of Resend contacts against the free 1,000. At 900 it warns: „Resendi tasuta paketis on 1000 kontakti. Üle selle on vaja tasulist paketti." (Draft). Nothing is upgraded automatically.
- **D10. Blocked addresses are shown** (from Dim's "Same account").
  - **How the site learns.** It records an address that Resend has suppressed (a bounce or a spam mark) from the webhook `suppression.added` and clears it on `suppression.removed`. The full sync also reads the suppression list if Resend's API offers it. (amended 19.10 during the build) Checked: it does, and the full sync reads `suppressions.list` (resend 6.31) every run; an address no longer on it is cleared.
  - **Where Maria sees it.** „Uudiskiri" marks such a subscriber, and the student's drawer (Õpilased) marks her account: „Resend ei saada sellele aadressile kirju (tagastus või rämpspostiks märgitud). Seda saab muuta ainult Resendis." (Draft).
  - **What the site does not do.** It never removes a suppression itself.
- **D9. The welcome mail stays as it is** (transactional, with the site's own unsubscribe link). D2 adds the new subscriber to Resend.

## 3. Data (migration 0015, additive)

- **`campaigns`:**
  - `id`
  - `name`
  - `subject` (I18n)
  - `preheader` (I18n)
  - `image_key`, nullable
  - `body` (I18n, paragraphs)
  - `code`, nullable
  - `button_label` (I18n), nullable
  - `button_href`, nullable
  - `status`: `draft` or `sent`
  - `sent_at`
  - `recipients`: jsonb `{ et, ru }`
  - `broadcasts`: jsonb `{ et?: id, ru?: id }`
  - `created_at`, `updated_at`
- **`subscribers`** gains:
  - `resend_contact_id`, nullable;
  - `synced_at`, nullable. It is null when the row has changed since the last successful sync.
- **Settings key `resend_segments`:** `{ et, ru }`, the segment ids.
- **`mail_suppressions`** (D10): `email` (unique, lower-case), `reason` (`bounce`, `complaint` or `other`), `since`, `cleared_at`. One row per address. It is kept separate from `subscribers`, because a student who never subscribed can be suppressed too.
- (amended 19.10 during the build) The table is `newsletter_campaigns` (the home page's popup owns `campaign`), and its `status` is `draft`, `sending` or `sent` (R13). The settings keys are `resend_segments` `{ et, ru, property }` (the segments and the contact property `unsubscribe_url`), `resend_test_segment` `{ id }` (R4) and `newsletter_sync_lease` `{ holder, until }` (R9 and R11).

## 4. Configuration (Dim)

- **A full-access API key.** Contacts, segments and broadcasts need a Resend API key with full access, and today's key may be a sending-only key.
  - Dim creates a full-access key in Maria's Resend account and puts it in Vercel as `RESEND_API_KEY`, replacing the old one, or as a second variable `RESEND_MARKETING_KEY`.
  - Builder: support the second variable, falling back to the first.
  - (amended 19.10 during the build: no fallback; the marketing key is the switch, R15) The newsletter is configured **only** by `RESEND_MARKETING_KEY`, a full-access key Dim sets in Vercel after his first live check; blank or unset, the newsletter is off, whatever `RESEND_API_KEY` is. `RESEND_API_KEY` stays the key of the site's own mails only, so a full-access `RESEND_API_KEY` never switches the newsletter on at a deploy.
- **The webhook.** Dim adds a webhook in Resend to `https://mslab.ee/api/resend/webhook` for `contact.updated`, `suppression.added` and `suppression.removed`, and puts its signing secret in Vercel as `RESEND_WEBHOOK_SECRET`.
- **Without the marketing key,** the „Kampaaniad" tab says sending is not set up yet, and nothing else changes.

## 5. Edge cases

- **Sync and Resend outages.**
  - **Resend down at sign-up:** the row is stored unsynced, and the next sync adds it.
  - **Resend down at „Saada kõigile":** the full sync fails, and nothing is sent. Maria sees „Resendiga ei saanud ühendust — proovi hiljem uuesti." (Draft).
- **Who is in the list.**
  - **A subscriber who changes her language in „Minu andmed":** her contact moves segment.
  - **An address that bounced or complained:** Resend suppresses it for every mail of the account (D1). The site does not delete the row; it marks it (D10), and the full sync reports the count.
  - **Over 1,000 contacts:** the sync stops adding new contacts. Maria sees the warning, and the send goes to those already in Resend. The rows without a contact are counted, never silently dropped: „{n} tellijat ei ole Resendis — kontaktide piir on täis." (Draft).
    - (amended 19.10 during the build, R5) Resend does not refuse a contact over the plan's limit: it blocks the broadcasts. So the site itself stops adding contacts at 1,000 (the full sync and each sign-up's sync), and „Saada kõigile" goes to those already in Resend. It refuses (`unsynced`) only for rows left unsynced for another reason (a failure, the time budget); the rows left out by the limit are counted in the confirmation. The site counts its own rows, so the page also shows Resend's own count, which includes Maria's other contacts and the test contact.
  - (amended 19.10 during the build, R17) **An address Resend refuses never blocks a send.** When Resend refuses a new contact (its creation) with a 400 or 422 validation error about its address, the row is `rejected`: not a failure, not part of the run of three failures that stops a sync, and never a reason to refuse „Saada kõigile“. The row is marked on „Uudiskiri“: „Resend ei võtnud seda aadressi vastu.“ (Draft), the sync's report counts it, and the confirmation says how many are left out. The cost, if wrong: one subscriber silently left out, but visible on her row. (amended again, the re-review's N3) A refused update of an existing contact stays a failure and stops the send: her contact stays in its old segment or with its old link.
- **Before the public launch.**
  - Links in a campaign that point to the site land on the coming-soon page.
  - Images must load through the gate. Builder: confirm that `/media/…` is public.
    - (amended 19.10 during the build) Confirmed: `/media/…` and `/brand/…` (the logo) go through the coming-soon gate, as do the unsubscribe link (`/api/newsletter/loobu`) and Resend's webhook (`/api/resend/webhook`).
- **Two admins at once.** A send is refused if the campaign was already sent. Editing a sent campaign is refused.

## 6. The test plan (standing rule)

New checks (`"mark": "new"`, `"markedAt": "deploy"`):
- „Sünkrooni Resendiga" and the contact count;
- writing a campaign with a picture, a code and a button, and the preview in both languages;
- „Saada proov" to Maria;
- „Saada kõigile" with the count, to a test list (Dim's `+proov` addresses only, see below);
- the unsubscribe in the received campaign removes the subscriber from „Uudiskiri";
- „Kopeeri".

The checks that send run only with Dim. Until the launch, the subscriber list holds only test addresses, or the check uses a Resend test segment. Builder: say which.

(amended 19.10 during the build) The checks that send use Dim's `+proov` addresses on the real list, and „Saada proov" goes through its own test segment; no Resend test environment is used. The check „Saada kõigile" starts by reading the list and stops if any other address is on it (`app/src/data/testplan.json`; the live order is `docs/deploy.md` section 19, item 11).

## 7. Out of scope

- Scheduling a send for later.
- Automated series, for example a mail after a purchase.
- Topics (subscribe to some campaigns only).
- Analytics inside the admin; Resend's dashboard has them.
- Rich text beyond paragraphs, a picture, a code and a button.
- Importing old lists.
- A/B tests.
- Sending to students who did not subscribe.

## 8. Left to the builder

- The exact Resend API calls (contacts, segments, broadcasts, webhook verification), checked against Resend's current documentation at build time. Resend renamed audiences to segments.
- The admin layout within the existing „Uudiskiri" page.
- The texts beyond those quoted. They are marked Draft for Dim's wording sheet.
- **The cheaper alternative,** should Dim prefer it: keep D1–D3 and D7–D9, drop D4–D6, and let Maria write and send broadcasts in Resend's own dashboard editor, which is in English. The site still keeps the contacts and segments in sync.
