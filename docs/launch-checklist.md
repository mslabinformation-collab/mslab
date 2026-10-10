# MS LAB — from prototype to public launch

The site is live on **https://mslab.ee** since 08.10.2026, on Maria's accounts (Vercel team `ms-lab`, project `mslab`, Hobby; how it is set up and deployed: `docs/deploy.md`), still as a **prototype** for Dim and Maria only. This list collects everything that must happen before real visitors arrive. Sources: the final whole-branch review and the build ledger of phase 1, and the clean-up after the move from Cloudflare Workers to Vercel (03.10.2026).

The switches below are **Vercel environment variables** (Project → Settings → Environment Variables, or `vercel env add`), not wrangler settings. A change reaches the site with the next deployment, so redeploy after changing one.

## 1. Accounts and switches
- [x] Done 08.10.2026: Vercel (team `ms-lab`, project `mslab`, its Git integration with `mslabinformation-collab/mslab`, the domains and the variables), Cloudflare (the R2 bucket `mslab-media`), Railway (project `mslab`), Resend (`send.mslab.ee`) and Bunny (library 773592) are Maria's; the data was copied (a Postgres dump; the old bucket was empty). The review comments live in Postgres (`kv_entries`).
- [x] Done 08.10.2026: `SITE_URL` is https://mslab.ee, and `mslab.ee` and `www.mslab.ee` are on the Vercel project (`docs/deploy.md` section 4).
- [ ] Public launch: delete `SITE_GATE` in Production of Maria's Vercel project and redeploy (the coming-soon page goes; `PREVIEW_SECRET` may stay).
- [ ] Before the public launch (phase 2c), still open from the final review of the branch:
  - the password inputs of Minu andmed (`PasswordSection`) and the login page are controlled React inputs; make them uncontrolled (read at submit) as defence in depth, so a password never sits in React state;
  - asking a fresh e-mail code before a password is set or changed (design idea, the owner decides; today the session alone is enough, and the change is mailed to her);
  - the Russian texts of the newsletter popup row (Hüpikaken → Uudiskiri: kicker, title, text; they are database content, not the dictionary) go to the native-speaker check in §9.
  - the campaign popup (Hüpikaken → Kampaania) still opens 6 s after the newsletter's landings (`/?uudiskiri=loobutud` of the unsubscribe link; `/?uudiskiri=kinnitatud` of an old confirmation link), over their notice: skip it on those landings as the newsletter popup does (`CampaignPopup`, one line);
  - the newsletter's own mail counter is 25 a day (25 sign-ups: since 09.10 a sign-up sends one welcome mail and nothing else); raise it (e.g. 35) if sign-ups outgrow it, within Resend's 100 a day (§7).
- [ ] `MARIA_EMAIL` (Vercel env var) and the Telegram chat (`TELEGRAM_CHAT_ID`, or the `tg:chat` row in `kv_entries`) → Maria's address (today: Dim's).
- [ ] **Rotate the Telegram bot token** (BotFather `/revoke` gives a new one) and update `TELEGRAM_BOT_TOKEN` on Vercel; redeploy. The current token was copied to Vercel while the site moved.
- [ ] `NEXT_PUBLIC_REVIEW_TOOLS` → "0" in `app/next.config.ts` (removes the review comment widget and its anonymous Telegram ping).
- [ ] Remove noindex: the `X-Robots-Tag` rule in the `headers()` of `app/next.config.ts` (keep `frame-ancestors` and `Referrer-Policy`), `ROBOTS` in `app/src/middleware.ts` (its redirects set their own header), `public/robots.txt`, the `robots` metadata of the pages; check the headers on the deployment afterwards.
- [ ] New OG image for the final home page (`public/og.jpg`; strip metadata with `tools/strip_provenance.py`).
- [ ] Cloudflare clean-up: done 08.10.2026 for the Workers `mslab-web` and `mslab-guide`, the Hyperdrive config, the D1 database `mslab-next-tags`, Dim's R2 bucket `mslab-media` and the KV namespace (checked against `kv_entries` first). Left: delete the R2 bucket `mslab-next-cache` once its one-day expiry has emptied it.
- [ ] After a few weeks: remove Dim's old Vercel project (the mslab.diipsolutions.eu redirect) and the `mslab` CNAME in the Cloudflare zone `diipsolutions.eu`.

## 1b. Domain, e-mail and Google (mslab.ee is at Elkdata today: DNS, MX, old site)
- [ ] Confirm with Maria: does a mailbox on mslab.ee exist (e.g. info@mslab.ee — MX points to Elkdata, but the mail service may not be ordered) and who can log in to Elkdata.
- [ ] Business Google account with the mslab.ee address as login (owned by Maria, Dim added as user/owner) for Search Console, Business Profile, Analytics if used.
- [ ] Search Console **now** on the current mslab.ee (Domain property, DNS TXT at Elkdata): collect the old site's indexed URLs and traffic → 301 redirect map from old WordPress URLs to the new pages at launch.
- [x] Done 08.10.2026: mslab.ee and www point at Vercel; the DNS stays at veebimajutus (Elkdata), the old WordPress site is gone and the mail records were kept.
- [x] Done 08.10.2026: the site's e-mail is on `send.mslab.ee` in Maria's Resend (DKIM/SPF/return-path records). Do not use Resend as Maria's personal SMTP (shared 100/day free quota).
- [ ] Optional: mailbox in Gmail via forwarding + "Send mail as" through the mailbox host's SMTP.
- [ ] Analytics: prefer a cookieless one (Vercel Web Analytics on Hobby, or Cloudflare Web Analytics' script, which works without proxying the site) over GA4. Check the Hobby quota first.

## 2. Stay inside the free plans (owner rules out paid plans)
Vercel Hobby limits that matter here: **1 million function invocations a month**, **100 GB of transfer a month**, **4.5 MB request body** (the image upload limit in the app is 4 MB), **cron jobs once a day at most** (the one cron, `/api/cron/sweep`, is daily). Railway and Resend have their own quotas (Resend Free: 100 mails a day).
- [ ] **Check Vercel's terms for the launch**: the Hobby plan is meant for personal, non-commercial use. A public business site that sells courses may fall outside it; read the current terms (and ask Vercel if unsure) before real visitors arrive. If Pro turns out to be required, that is a decision for Dim: the owner has ruled out paid plans so far.
- [ ] After the first weeks of traffic read Vercel → Usage (invocations, transfer, ISR writes) against the limits. The home page prefetches about 30 internal links per first visit; pages served from the ISR cache are cheap, the admin and the API routes are invocations. A scanner asking for made-up slugs under `koolitused/`, `uudised/` or `ostukorv/` costs one invocation and one ISR write per address (each gets its own cached 404), and so does one under `konto/kursus/` (each gets its own cached account shell); other unknown paths are rewritten to `/leidmata` and do not.
- [ ] Abuse/quota hardening: Turnstile (free) on public forms; a global daily cap on outgoing mail (Resend Free: 100/day); the rate limits now live in Postgres (`kv_entries`, Railway), so a flood of form posts costs invocations and database writes: a Vercel Firewall rule (or Attack Challenge Mode) for scanners.
- [ ] Every Next.js upgrade (the version is pinned): run the unit tests, in particular the canary in `app/tests/unit/r2.test.ts` (it fails with a message when Next changes the fetch behaviour the R2 workaround depends on), and the production-build e2e (`E2E_PROD_BUILD=1`, which tests the freshness contract: the next public request after an admin save shows the change). That run depends on `app/tests/e2e/page-cache.cjs`, which wraps Next's own file cache through an internal module (`next/dist/…/file-system-cache.js`) and has no unit test of its own: if Next moves those internals the production e2e fails loudly, so fix the wrapper there. The R2 canary builds Next's fetch by hand and cannot see how a new version wires it, so also check once the upgrade is live: a missing `/media` key answers 404 within a second (`docs/deploy.md` section 3).

## 3. Decisions for Maria
- [ ] Do unpaid (awaiting prepayment) registrations hold a seat? Then: capacity warning when confirming, and re-enable or keep off the public seat revalidation.
- [ ] CTA wording: hero "Leia **oma** koolitus" vs popup "Leia **enda** koolitus".
- [ ] Step/module numbers in JetBrains Mono — keep or switch to Jost.
- [ ] Newsletter CSV: comma or semicolon (Excel in Estonian locale).
- [ ] Video hosting for e-courses (est. 500 h): R2 + own HLS encoding (~$8–32/mo storage, free egress) vs Bunny Stream (~$11–20/mo + delivery) vs Cloudflare Stream (~$150/mo). Vercel Hobby's 100 GB transfer rules out serving video from Vercel itself. Decide when the prototype is ready for testing; test with one real video.

## 4. Content
- [ ] Native-speaker review of all Russian texts (UI dictionary and the drafted sample content); RU city names.
- [ ] Real photos and texts from Maria (originals, not Telegram-compressed); trainer works gallery with her own work.
- [ ] Three dark hero slides on the current DB: phone focal point ≈ 90% in /admin/avaleht.
- [ ] ET copy pass ("1 kuud" for accessMonths = 1, etc.).

## 5. Polish and robustness (accepted for the prototype)
- [ ] Unsaved-changes warning on in-admin navigation (beforeunload only today).
- [ ] Slide/FAQ field errors keyed by index (wrong row after reorder).
- [ ] Newsletter confirm via GET (mail scanners) → interstitial with a POST button; rotate/hash the token. This is the old confirm link (`/api/newsletter/confirm`, only in mailboxes from before 09.10), which still confirms on a plain GET. The unsubscribe link of the welcome mail (`/api/newsletter/loobu`) is done: opening it only shows a confirm page, and its button (a POST) is what unsubscribes, so mail gateways that open links (Mimecast, Proofpoint, Defender) unsubscribe no one.
- [ ] Static guard: `"use server"` only under `server/actions`.
- [ ] Scroll-lock layout shift on Windows (`scrollbar-gutter: stable`).
- [ ] Accessibility: explainer card focus; FavouriteButton double announce; "Eemalda lemmikutest" only in `title`.
- [ ] `keepNamesTogether` joins 3+ Title-case words (join pairs only); RU waitlist pill 1 px past the row border at ≥1000 px.
- [ ] Check in the Vercel runtime logs that the work scheduled with `after()` (the sign-in e-mail, the form notifications) completes when many requests arrive together: no mail missing from a burst.
- [ ] `global-setup` cannot see a reused dev server's env → make `sendMail`/`sendTelegram` skip in development builds before `MARIA_EMAIL` points to Maria. The same blind spot covers uploads: a reused dev server that was started with `R2_*` in its shell writes the e2e's uploads to the real bucket.
- [ ] Render race after an admin save: a page that is requested between the database write and the revalidation can be cached stale until the next revalidation (accepted: no cheap fix in Next 16.3.8). Option: shorten the layout's safety-net revalidation after checking the Hobby ISR write quota.

## 6. Phase 2 (engineering)
- [ ] Extract `usePublicForm` + `<Honeypot/>` before payment forms (six forms repeat the pattern).
- [ ] Delete the unused Task 5 write helpers in `src/db/queries/admin.ts` and `registrationSchema`.
- [ ] Migration with FK / token indexes; lowercase e-mails on write.
- [ ] e2e: guard Playwright `request`/`page.request` against non-GET on remote targets.
- [ ] `frame-ancestors 'none'` for admin if no same-origin framing is needed any more.
- [ ] CI drift check: `drizzle-kit generate` must produce no diff.
- [ ] R2 media deletion (uploads are never deleted today) — remember Vercel's CDN copies of `/media` images are immutable for a year (a deleted image can stay visible there until the copy expires).

## 7. Phase 2a (client accounts)
From the final review of phase 2a (04.10.2026); the merge-blocking items were fixed on the branch.
- [ ] One counter for every mail the site sends (logins, confirmations, Maria's notifications, deletion and change-request mails, admin logins, newsletter welcome mails): a hard cap of about 95 a day with a share per kind, and the 3 000 a month. Until then the visitors' mail is counted on **two** `mail_quota` counters (since phase 2c), and a full one never stops the other (M1):
  - the shared one (row `<day>`): a login mail or a confirmation that carries a code stops at 60 a day, a registration or request confirmation without a code at 30 (the prepayment details are in it);
  - the newsletter's own (row `<day>:nl`): 25 a day, for the welcome mail. A sign-up (one step since 09.10: it subscribes at once and sends only the welcome mail) uses one place, so 25 sign-ups a day get their welcome; the rest are subscribed all the same but get no welcome mail (the footer's answer is the same).
  - The two counters allow at most 85 counted mails a day of Resend Free's 100. Maria's notifications (one per form sent) and the admin logins are not counted, so a very busy day (dozens of registrations plus a full newsletter day) can still pass 100: Resend then refuses the rest. Watch the logs for `daily mail cap reached` (no address in it).
- [ ] Check live that the login and confirmation mails arrive and render (big code, one button) in Gmail, Outlook.com and an Estonian ISP mailbox (the newsletter's welcome mail too: the unsubscribe line is the last before the signature, its link opens the confirm page, and the button unsubscribes), and whether a mail scanner's plain GET uses up the login link and code (and, one device only, ends the student's session). If it does, the link opens a "Logi sisse" page that POSTs, like the newsletter interstitial in §5 (M2).
- [ ] iPhone Safari deletes localStorage after 7 days without a visit while the cookies stay: a signed-in student's "Ava minu konto" then shows the login form instead of her account (safe fallback). Fix: with the hint set and nothing remembered, forward to `/konto#email=…` and let the dashboard compare with `client.email`.
- [ ] Shared device: the remembered address is the last one a code was asked for, not the signed-in one (B asks for a code and leaves; B's "Ava minu konto" then opens A's account). Keep the signed-in address in its own key, written only from account answers.
- [ ] Watch Vercel Usage for made-up slugs under `konto/kursus/` (each renders and caches its own shell; §2's scanner note) (M3).
- [ ] Decide Maria's reply address and set `replyTo` on the visitor mails; replies go to the unread sending address today (M5).
- [ ] Native-speaker pass on the Russian account texts and mails: «лист ожидания» vs «списке ожидания», "оплатите предоплату" → "внесите предоплату", the request mail's "Запрос отправлен. Мария скоро ответит." (M6).
- [ ] `admin-auth.spec` under `E2E_PROD_BUILD=1`: skip its devLink tests there, and delete leftover admin tokens in `global-setup` (they block the admin sign-in for 15 minutes) (M9).
- [ ] `clients.email` lower-case enforced by the database (a CHECK or a unique `lower()` index), with §6's migration (triage row 4).
- [ ] Partial unique index `client_sessions(client_id) where ended_at is null`: the one-device rule in the schema too (row 8).
- [ ] `set local lock_timeout` at `lockAddress`, so a stuck lock cannot hold a request for its whole 30 s (row 10).
- [ ] Accessibility: the account banner (`role=status`) is inserted with its text and may not be announced; add it to §5's list (row 29).
- [ ] Probe live whether a cached 404 page keeps an unknown address's query (task-11 probe 5); if it does, strip queries on unknown addresses with a 303 (row 40).
- [ ] Õpilased list turns into cards below about 1360 px, Maria's laptop width; check on her screen (row 45).
- [ ] Admin copy: "(mustand) (avatud kuni …)" has two pairs of brackets in the grant select (row 49).
- [ ] Maria fills "Ettemaksu juhised" in Seaded (until then every unpaid card and mail says "Maria saadab sulle arve …").
- [ ] Maria saves the real "E-koolituse tingimused" text in Seaded before the first real "Ava ligipääs" (the seeded one ends "(Näidistekst — Maria täiendab.)").
- [ ] Before renaming `middleware` to `proxy` (a Next 16 build warning): the 303 shell defence lives there; rerun the task-11 probes after any rename.
- [ ] Watch the logs for `[account] login request rate limited`: the per-IP login limits (10 and 20 per 10 minutes) may bite students behind a mobile carrier's shared address (CGNAT).

## 8. Phase 3a (lessons and video)
- [ ] The library is Maria's (`mslab`, id 773592, 08.10.2026). Check that `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` and `BUNNY_WEBHOOK_SECRET` are set in Production of Maria's Vercel project (`vercel env ls production` lists the names); without them the admin says "Video seadistamata" and students "Video lisandub peagi".
- [ ] First live uploads: the four first-use checks of `docs/deploy.md` section 10 (the browser console during the first upload, R2 keeping the file name on a signed download, the player address answering without a redirect, the shape of an upright phone clip).
- [x] Done 08.10.2026: the library's allowed domains are `mslab.ee` and `www.mslab.ee`, and the webhook URL's host is mslab.ee (`docs/deploy.md` section 10).
- [ ] Bunny library → allowed domains: replace the stale `mslab-five.vercel.app` with the project's current `*.vercel.app` address (or remove it).
- [x] Done: the library is on Maria's Bunny account from the start (08.10.2026).
- [ ] After the first month read Bunny's bill (the estimate is about €5–15 a month at 500 hours watched) and Vercel's function invocations (a watching student makes about 240 progress calls an hour).
- [ ] Migration 0007 (drops `courses.modules`) only after 3a has run for a few days with no rollback planned: the code first, then the migration (plan 2026-10-05-phase3a, Task 12 step 11).
- [ ] Accepted limit: the iPhone's own full-screen video player shows no watermark (the page's "Täisekraan" keeps it).
- [ ] Accepted limit, narrowed in phase 2c: the player takes back a forward jump past what she has watched, and the server keeps at most twice the real time since the lesson was opened plus 30 s, so a video lesson cannot be completed in less than about half its length. A script can still report steadily at 2× without watching: "done" means "the time was spent with the lesson open", not "watched".
- [ ] Accepted limit: the player's height is capped to leave room for the buttons below it (about 400 px reserved, 240 to 540 px high), so on a small laptop screen, with a 4:3 video or a lesson title that runs to two lines, "Täisekraan" can sit below the fold.
- [ ] Bunny's embed host is `player.mediadelivery.net` (the old `iframe.mediadelivery.net` player goes in early 2027): nothing to do, noted.

## 9. Phase 2c (Maria's feedback of 06.10.2026)
- [ ] Native-speaker check of the Russian texts phase 2c added: `account.lesson.seekLocked`, the `account.dashboard` resume texts (`resumeTag` … `finished`), `newsletter.sentTitle`, `newsletter.sentText`, `newsletter.popupSent` (the answers after "Подписаться"), `newsletter.unsubscribedTitle`, `newsletter.unsubscribedText` (the notice after the unsubscribe link), `newsletter.codeLine`, `mail.welcome.*` (`unsubscribe` is the new last line of the welcome mail), `newsletter.unsubscribePage.*` (the page the unsubscribe link opens: heading, lead, button), `forms.newsletterConsent`, `account.passwordMail.*`, `account.details.password.*` (`removeFailed` is the line after a failed removal; `none` is the sentence the owner chose), and the login page's password texts (`account.login.toPassword` … `passwordLocked`).
- [ ] Native-speaker check of the newsletter popup's Russian texts (Hüpikaken → Uudiskiri, the Russian kicker, title and text): they live in the database (the `campaign` row of kind newsletter; the seeded ones are drafts), not in the dictionary, so Maria or the checker edits them in the admin.
- [ ] Maria fills Seaded → "Tervituskood" (empty: the welcome mail still goes out, without the code lines; the old confirmation link then shows no code and sends no mail) and applies the code on her invoice.
- [ ] Every newsletter Maria sends needs a way out. The welcome mail has one; her own mailings, sent from a mailing tool with the CSV of Uudiskiri, do not get one from the site: the CSV has no token column. Either the tool's own unsubscribe link (and Maria deleting that address in Uudiskiri by hand), or add a column with each subscriber's `/api/newsletter/loobu?t=<token>` link to the CSV (it opens the confirm page).
- [ ] Maria chooses in Hüpikaken what the home page shows (Kampaania / Uudiskiri / Väljas); the newsletter popup's picture is a sample one until she uploads her own.
- [ ] Bunny's speed menu must stop at 2×: the server's progress clock assumes it (`TOP_SPEED` in `app/src/domain/lessons.ts`). If Bunny ever offers more, raise the factor to the top speed.
- [ ] Accepted: a password is optional and per address; there is no "forgot password" link (the code login is the way back); admins have no passwords.

## 10. Phase 2b (online payments with Montonio)
- [ ] Go-live with the **sandbox** keys behind the coming-soon gate (plan 2026-10-09-phase2b, Task 12): migration 0006 on Railway first, then `MONTONIO_ENV=sandbox` and the sandbox keys in Production (plain variables, never in the repo), then the deploy and the live checks with sample addresses. Afterwards write into `docs/deploy.md` section 11 (6) what the sandbox's bank page offered and whether it took the test card.
- [ ] Before the public launch: Maria's Montonio store is approved (the live keys appear only once it is activated); Dim enters the **live** keys and `MONTONIO_ENV=live` in Production and redeploys (`docs/deploy.md` section 11).
- [ ] Maria turns on in her store the methods she wants: bank links; cards, Apple Pay and Google Pay cost more per payment (her choice).
- [ ] One real purchase at about €1 (a 1 € test e-course or test session, unpublished afterwards) with an immediate manual refund in Montonio's Partner System (Orders → the order → Refund). Montonio has that button for card payments and, for bank links, only with its "Refundable bank payments" service: pay by card if the store has it on, or ask Montonio whether the service is on. Maksed then shows the payment "Tagastatud", which proves that Montonio's refund notice arrives; a refund Maria makes by her own bank transfer is never seen by the app (it stays "Makstud").
- [ ] The privacy text (Seaded → Privaatsus) gets Maria's line about payments through Montonio: a payment row keeps the payer's name, e-mail and amount for the books, also after the account is deleted.
- [ ] Native-speaker check of the Russian texts phase 2b added, all in `payment.*` of `src/i18n/dict/ru.ts`: `pay`, `payRest`, `transfer`, `starting`, `cartDown` (the e-course cart when Montonio did not open the payment), `alreadyPaid`, `page.*` (the page behind the mail's "Maksa" link), `result.*` (where the bank sends the payer back: `paidEcourse` and `paidEcourseText`, the login line of an e-course purchase, and `openCourse` included) and `mail.*` (the subjects `subjectConfirmed`, `subjectReceived`, `subjectEcourse`, and `leadConfirmed`, `leadReceived`, `leadEcourse`, `paid`, `rest`, `allPaid`, `full`, `notConfirmed`, `access`; the e-course mail is `subjectEcourse`, `leadEcourse` and `access`).
- [ ] Maria's "Ettemaksu juhised" in Seaded: the bank transfer stays the second way under "Maksa" (D6) once receiver and IBAN are filled in (the pay page and the cards show it then); she records those payments by hand as before.
- [ ] Accepted: a cached calendar or course page can show "Täis" for a few minutes after an unpaid hold ends (these pages re-render at most every 300 s; the registration form checks live; a payment, a registration or the daily check re-renders them at once).
- [ ] Accepted: "Proovi uuesti" is offered on "pooleli" too, because Montonio answers a cancel at the bank with PENDING. The retry sends the same order again (the same reference) while it is open, and Montonio replaces the unpaid one, so the first cannot be paid as well; only after its 30 minutes is a retry a new order. Watch Maksed for a registration with two paid prepayments in the first weeks all the same, and for "Topeltmakse" mails (the app counts the first payment only; Maria refunds the other in Montonio).
- [ ] Watch Maksed → "Ootel kontrollil" and "Tühistatud pangas", and the "Kontrolli Montonios" mails, for the first weeks.
- [ ] A payment Montonio reports as paid but that the app cannot settle stays pending and is counted in the cron's `paymentsErrors`. Watch Vercel's log for `[cron] sweep: payments … N errors` with N > 0 in the first weeks.
- [ ] e2e: a dev server started by hand is reused by Playwright, and with the sandbox keys of `app/.env.local` it would create real orders at Montonio instead of using the fake. The e2e global setup now asks the app under test, before any test, whether it holds the e2e run's own made-up keys (one probe token to `/api/payments/notify`; nothing is stored and the real Montonio is not involved) and stops the run with a message when it does not: stop that dev server and run again.
