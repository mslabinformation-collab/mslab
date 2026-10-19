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
- **D3. Unsubscribing** (my call, from the builder check).
  - **The visible link is the site's own.** The campaign's footer link is the site's existing page, `/api/newsletter/loobu?t=<her token>`, in Estonian or Russian. Resend's hosted page is one English page per account and carries Resend's footer on the free plan.
    - The token reaches the mail as a contact property, which the sync stores on her contact. Broadcasts fill contact properties into the mail.
    - Pressing the site's link deletes the row and the Resend contact, as below.
  - **Resend's one-click unsubscribe also counts.** It covers the mail program's own unsubscribe button and any unsubscribe made inside Resend, and Resend marks the contact unsubscribed for every broadcast. The site brings that back two ways:
    - A Resend webhook (`contact.updated`, signed) deletes the subscriber's row at once. Builder: confirm that Resend fires it on that unsubscribe. If it does not, the full sync is the route.
    - Every full sync reads the unsubscribed contacts and deletes their rows before anything is sent. A send therefore never goes to someone who unsubscribed through Resend, even if a webhook was lost.
  - **The site's own unsubscribe** (the welcome mail's link, the „Minu andmed" switch) deletes the row, as today, and deletes the Resend contact.
  - **Signing up again.** A person who unsubscribed through Resend and later signs up again on the site is a new consent. The site sets her contact back to subscribed.
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
  - **„Saada kõigile".** It first runs the full sync (D2), then shows the confirmation: „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?"
    - On „Saada" the site creates one broadcast per segment that has subscribers and sends it at once.
    - It records the broadcast ids, the counts and the time.
    - Two presses, or two tabs, send once: the campaign row is locked and its status checked.
  - **After sending.**
    - The campaign is read-only, with „Saadetud {date} · {n} tellijale".
    - A link opens it in Resend's dashboard, where the delivery, bounce and unsubscribe numbers are (tracking is off, D1).
    - „Kopeeri" makes a new draft from it.
- **D7. Who receives** (my call). Every row of `subscribers` that is confirmed.
  - Rows still unconfirmed from the old two-step sign-up (before 09.10) are not sent to.
  - Students and buyers who never signed up get nothing. Estonian law's "similar products" exception would need an opt-out offered at the purchase, and the forms never offered one.
- **D8. The plan's limits** (my call). The „Uudiskiri" page shows the number of Resend contacts against the free 1,000. At 900 it warns: „Resendi tasuta paketis on 1000 kontakti. Üle selle on vaja tasulist paketti." (Draft). Nothing is upgraded automatically.
- **D10. Blocked addresses are shown** (from Dim's "Same account").
  - **How the site learns.** It records an address that Resend has suppressed (a bounce or a spam mark) from the webhook `suppression.added` and clears it on `suppression.removed`. The full sync also reads the suppression list if Resend's API offers it. Builder: check.
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

## 4. Configuration (Dim)

- **A full-access API key.** Contacts, segments and broadcasts need a Resend API key with full access, and today's key may be a sending-only key.
  - Dim creates a full-access key in Maria's Resend account and puts it in Vercel as `RESEND_API_KEY`, replacing the old one, or as a second variable `RESEND_MARKETING_KEY`.
  - Builder: support the second variable, falling back to the first.
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
- **Before the public launch.**
  - Links in a campaign that point to the site land on the coming-soon page.
  - Images must load through the gate. Builder: confirm that `/media/…` is public.
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
