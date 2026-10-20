# Newsletter campaigns, simplified — design

This replaces the sending half of `2026-10-18-newsletter-campaigns-design.md`, which is deployed but switched off (main 56f38dc). Dim (20.10.2026): "Everything in this project needs to be very simple and usable … It seems to me that we're overcomplicated this." He pointed to Rempire's approach: the usual daily limit of 100 e-mails on Resend's free account, and a counter of how many were sent. A newsletter mail that does not fit today goes out the next day.

Every decision not attributed to Dim is my call and says so.

## 1. What stays from the 18.10 design

- D4: Maria writes a campaign in „Uudiskiri → Kampaaniad": subject, preview line, picture, paragraphs, code and button, in ET and RU. The live preview shows both languages.
- D5: the mail's look and footer.
- D7: who receives it. Only confirmed `subscribers` rows get it; nobody else.
- D9: the welcome mail.
- „Kopeeri", and a sent campaign is read-only.
- The editor, the preview route, `campaign-mail.ts` and the rules in `domain/newsletter-campaign.ts`.

## 2. What goes

Everything that kept a list in Resend:
- the contacts and the ET/RU segments;
- the full sync, its lease, the cron's sync, and „Sünkrooni Resendiga";
- the Resend contact counts and the 1,000-contact warning;
- the webhook `/api/resend/webhook` and its secret;
- the suppression list and its marks („Resend ei saada …");
- the test segment;
- the `sending` / interrupted states, „Märgi saatmata" and „Saada puuduv keel";
- the key `RESEND_MARKETING_KEY`.

Nothing in Resend needs setting up. The existing `RESEND_API_KEY` sends everything.

## 3. How a campaign is sent (my call, from Dim's Rempire description)

- **One mail per subscriber.** It is an ordinary mail through the same sender as the site's other mails, in her language. When the RU text is empty, she gets the ET mail with her own RU footer. This is the same rule as before.
- **Unsubscribe.** The link is the site's own, the same one the welcome mail carries (`/api/newsletter/loobu?t=<her token>`). Each mail also carries the `List-Unsubscribe` and `List-Unsubscribe-Post` headers for the mail program's own unsubscribe button. They point to the same address, whose POST already unsubscribes.
- **The day's counter.** One counter counts every mail the site sends in a Tallinn day: logins, confirmations, protocols, invoices, contracts, Maria's notices, welcome mails and campaigns. A campaign sends only while that counter is below **70** of Resend's 100. It stops there and leaves 30 for the rest of the day's site mails. The existing per-kind caps stay as they are.
- **Pressing „Saada kõigile".**
  - Maria confirms: „Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?"
  - The site then writes the list of recipients as it is at that moment, one row per subscriber.
  - It starts sending at once, up to the day's room.
- **Later batches.** The rest goes out on the following days, through a daily job, until every row is sent.
- **On the way.**
  - A subscriber who unsubscribes before her turn is skipped.
  - Someone who subscribes after the press is not added; she gets the next campaign.
- **Failures.** A mail Resend refuses for that address is marked failed and skipped. Any other failure leaves the row waiting, and the next batch tries it again. Each row is sent at most once: it is marked sent right after Resend accepts it.
- **What Maria sees.**
  - While the campaign is going out: „Saadetud {sent} / {n} — ülejäänud {left} lähevad homme." (Draft).
  - When it is done: „Saadetud {date} · {n} tellijale". A failure count is added if there were any.
- **„Saada proov"** sends one ordinary mail, now, to Maria's address or the signed-in admin's. It is counted like every mail. Its subject starts with „[Proov]", and its unsubscribe link points to the test notice („Proovikiri — …").
- **One campaign at a time** (my call). While one is going out, „Saada kõigile" on another one says „Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud." (Draft). Maria can still write and test.

## 4. Data (migration 0016)

- **`newsletter_deliveries`** has one row per recipient of a campaign: `campaign_id`, `email`, `locale`, `token` (her unsubscribe token at the press), `status` (`waiting`, `sent`, `failed` or `skipped`), `sent_at`. It is unique on (`campaign_id`, `email`).
- **`newsletter_campaigns.status`** is `draft`, `sending` or `sent`, where `sending` means "going out over the coming days".
- **Dropped:** the empty, never-used Resend columns and table, `subscribers.resend_contact_id`, `subscribers.synced_at` and `mail_suppressions`, plus the `resend_segments` and `newsletter_sync_lease` settings rows. On Railway they hold nothing (checked 20.10: 0 rows, no contacts ever made).
- **The day counter** is a `mail_quota` row (`<day>:all`). Every successful send through `sendMail` adds to it, best effort.

## 5. Edge cases

- **A busy day.** If the site's own mails pass 70, the campaign sends nothing that day, which is fine. The site's mails are never stopped by the campaign's counter.
- **Resend refuses for the day** (its own 100 reached). The batch stops and continues the next day.
- **A row's address bounces.** Resend suppresses it. That row is failed and counted, and the subscriber row stays.
- **The 3,000 a month.** 70 a day for campaigns at most, plus the site's own mails, stays within it. With today's 13 subscribers, a campaign takes one day.

## 6. The test plan (standing rule)

- The newsletter checks of the 18.10 build change. The sync, the counts, the blocked marks, „Märgi saatmata" and „Saada puuduv keel" checks are rewritten for the simple flow, keeping their ids. The send check becomes "the first batch and the progress line"; it is marked `redo`, or reworded where only the words change.
- **New check:** a campaign larger than the day's room continues the next day. It is Dim's check, using a test campaign and a temporarily lowered room. The builder says how.

## 7. Out of scope

Scheduling, automated series, topics, open/click tracking, Resend Broadcasts, and a paid Resend plan.
