# MS LAB — how everything works

A map of the MS LAB website for its owner: which tool does what, what each admin screen changes, what happens behind the scenes when a student pays or a visitor signs up, and where to look when something breaks.

- **Who it is for:** Dim (owner of the build) and, where it helps, Maria (the school's owner and the only person who runs the admin day to day).
- **What it is not:** the detailed runbook. That is `docs/deploy.md` (how it is hosted and deployed, section by section) and `docs/launch-checklist.md` (what must happen before the public launch). This file points to them by section number instead of copying them.
- **Facts from the repository and the accounts.** Checked against the code on 06.11.2026. Where only Dim or Maria can say, the text reads "(Dim to confirm)".
- **No secrets here.** Settings are listed by name only. Values live in the Vercel dashboard and are never written into the repository.
- **Language.** The site and the admin are in Estonian (ET) with Russian (RU) for visitors. Estonian screen labels are quoted in „…“ with a short English gloss the first time.
- **State of things (as the repository describes it):** the site is live at https://mslab.ee as a staging/prototype for Dim and Maria. While the pre-launch gate is on, visitors see only a „Tulekul“ (Coming soon) page.

Contents:

1. The pieces and what each one does
2. The public site
3. The admin („Haldus“)
4. Flows end to end
5. Automatic jobs
6. Where to look when something breaks
7. Before the public launch

---

## 1. The pieces and what each one does

### 1.1 The services

| Piece | What it does for MS LAB | What it changes or stores | Whose account | Cost tier |
|---|---|---|---|---|
| **GitHub** repo `mslabinformation-collab/mslab` | Holds all the code, the migrations and these docs. A push to the branch `main` deploys the live site. | The code only. No customer data. | Maria's organisation; Dim has push access (`docs/deploy.md` section 1) | Free. The repository is public (`docs/launch-checklist.md` section 1) |
| **Vercel** project `mslab` (team `ms-lab`) | Hosts the website and the admin; runs the two daily jobs; builds on every push. Functions run in Frankfurt (`fra1`). Serves the domain `mslab.ee` and `www.mslab.ee` and issues the certificate. | The running app, its settings (environment variables) and logs. Keeps a cache of built pages. Does **not** store customer data. | Maria's team `ms-lab` | Hobby (free). Limits: 1 million function calls a month, 100 GB transfer, 4.5 MB request body, cron jobs once a day at most (`docs/deploy.md` section 9) |
| **Railway** Postgres | The database: everything the site remembers (courses, registrations, students, payments, invoices, protocols, newsletter list, drafts, settings). | All business data. Plus a small key-value table `kv_entries` for review comments, form rate-limit counters and the Telegram chat id. | Maria's Railway project `mslab` | Started on the trial, which ended about 05.11.2026 with Dim's card on it. The plan after the trial: (Dim to confirm). The database runs in the EU (section 6, "Speed") |
| **Cloudflare R2** bucket `mslab-media` | File storage. Public images under `img/` (shown at `/media/img/…`). **Private** files under `lessons/` (lesson downloads, students' practical-work photos) handed out only as short-lived signed addresses. | Uploaded images and files. | Maria's Cloudflare account | Free tier: 10 GB stored, 1 million writes and 10 million reads a month, no transfer fees. The bucket must never be made public (`docs/deploy.md` section 10) |
| **Cloudflare** (DNS and incoming mail) | Since 28.10.2026 Cloudflare hosts the DNS of `mslab.ee`: the records that point the site at Vercel and the mail-sending records of Resend (all "DNS only", no Cloudflare proxy). **Incoming mail** to `info@mslab.ee` goes through Cloudflare Email Routing and a small Email Worker (`mslab-info-forward`) that forwards it to Maria's mailboxes. | DNS records, the mail forwarding rule. (Dim's old `diipsolutions.eu` zone still has a redirect name for the old test site; to be removed, `docs/launch-checklist.md` section 1.) | Maria's Cloudflare account | Free |
| **veebimajutus.ee (Elkdata)** | The registrar of `mslab.ee`. The domain's name servers point to Cloudflare. The old hosting package ("Standard", with the old mailbox `info@mslab.ee`) is no longer in the mail path; cancelling it is Maria's call. | The domain registration | Maria's account | The yearly domain fee; the old hosting package is billed until cancelled |
| **Bunny Stream** library `mslab` | Stores and plays the e-course lesson videos. Maria's browser uploads **directly** to Bunny; students watch in Bunny's player inside the lesson page, through an address the server signs for four hours. | The video files and their encoding status. | Maria's Bunny account | Pay as you go; estimated about €5–15 a month at about 500 viewing hours (`docs/deploy.md` section 10) |
| **Resend** (sending domain `send.mslab.ee`) | Sends **all** e-mail of the site: sign-in links and codes, registration and payment confirmations, invoices, contracts, protocols, assessments, Maria's notices, the newsletter welcome mail and newsletter campaigns. One key does everything. | Nothing about the newsletter list (the list lives only in the site's database). Resend keeps a log of sent mail. | Maria's Resend account | Free: 100 mails a day, 3 000 a month. The site never sends campaigns past 70 a day (section 5.3) |
| **Montonio** (Maria's store) | Takes online payments: bank links, cards, Apple Pay and Google Pay, and „Järelmaks (Inbank)“ (instalments). Tells the site back about a payment through a webhook. Refunds are made in Montonio's Partner System. | Orders and payment status on Montonio's side. The site keeps its own `payments` rows. | Maria's Montonio store (a sandbox and a live environment, with separate keys) | Fees: per Maria's Montonio contract (not in the repository). Järelmaks is free for the merchant (`docs/deploy.md` section 21, item 6) |
| **Telegram** bot | Pings the Telegram group „MS Lab orders and tests“ (Maria and Dim) when something needs Maria: a new registration or enquiry, a payment that needs checking, a new feedback, and a failed check on the test page. | Nothing. The chat id is read from the setting `TELEGRAM_CHAT_ID`, else from the database row `tg:chat`. | A bot token held in Vercel | Free |
| **The site gate** („Tulekul“ page) | While the setting `SITE_GATE` is on, every visitor sees only the „Tulekul“ (Coming soon) page in Estonian or Russian. Signed-in admins pass through a preview cookie, via „Vaata kodulehte“ in the admin. | Nothing stored. Decided on every request by the middleware (`app/src/middleware.ts`, `app/src/lib/site-gate.ts`). | Part of the app | Free |
| **Drizzle migrations** | The database's change history: numbered SQL files in `app/drizzle/`. They change the shape of the database (new tables, columns). **Vercel does not run them.** Dim runs them by hand against Railway **before** pushing the code that needs them (usual order; the two exceptions are in `docs/deploy.md` section 6). | The database structure, never the content. Recorded in the database's `drizzle.__drizzle_migrations` table. | Run from Dim's computer with the database address in the shell only | Free |

### 1.2 What is in the repository

| Folder | What it is |
|---|---|
| `app/` | The whole website and admin (Next.js 16 application, TypeScript). |
| `app/src/app/[locale]/(site)/` | The public pages, in two languages (`/` is Estonian, `/ru/…` is Russian). |
| `app/src/app/admin/` | The admin screens („Haldus“). |
| `app/src/app/api/` | The behind-the-scenes endpoints: payments, cron jobs, webhooks, the student account, the admin's autosave routes. |
| `app/src/server/` | The business logic that touches the database, e-mail, Montonio, Bunny, R2. |
| `app/src/db/schema.ts` and `app/drizzle/` | The database shape and the migration files. |
| `app/src/i18n/dict/` | All visible texts: `et.ts` and `ru.ts` for the site, `admin.ts` for the admin. |
| `app/src/data/testplan.json` | The checks shown on the admin's „Testimine“ page. |
| `app/vercel.json` | Region and the two daily jobs. |
| `app/.env.example` | The list of settings by name, with placeholders. |
| `docs/` | `deploy.md`, `launch-checklist.md`, and design notes under `docs/superpowers/`. |
| `tools/` and `app/tools/` | Small helper scripts, for example `tools/testplan-stamp.mjs` (stamps the test plan before each push), `tools/cache-smoke.mjs` (read-only check after a deploy) and `tools/strip_provenance.py` (strips picture metadata). |

### 1.3 Settings (environment variables) in the Vercel project — names only

Set in Vercel → Project → Settings → Environment Variables. A change takes effect only with the **next deployment**, so redeploy after changing one. Source: `app/.env.example` and `docs/deploy.md` section 2.

**Required** (without any of them every request answers 500 and the error names the variable, never its value):

| Name | What it is for |
|---|---|
| `DATABASE_URL` | The Railway database connection (secret) |
| `SITE_URL` | The site's own address, used in links inside e-mails and Telegram |
| `ADMIN_EMAILS` | The list of addresses allowed to sign in to the admin |
| `ADMIN_NAMES` | The greeting name for each admin address |
| `MARIA_EMAIL` | Where Maria's notice mails go |
| `MAIL_FROM` | The From line of outgoing mail (an address on `send.mslab.ee`) |

**Optional** (each switches a feature on):

| Name | Feature |
|---|---|
| `RESEND_API_KEY` | Sending any e-mail. Without it nothing is sent and nobody can receive an admin sign-in link |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram pings. The chat id overrides the one stored in the database |
| `ADMIN_KEY` | Access to the old design-review comment list at `/guide/tagasiside/` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Image and file storage. All four or none. Without them production refuses uploads |
| `CRON_SECRET` | Authorises the two daily jobs. Without it they answer 401 and do nothing |
| `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_KEY` | Lesson videos. All three or none. Without them the admin shows „Video seadistamata“ (Video not set up) |
| `BUNNY_WEBHOOK_SECRET` | Secret part of the address Bunny calls when a video finishes encoding |
| `SITE_GATE` | The „Tulekul“ gate. Any value except `0`/`false`/`off`/`no` turns it on. Launch = delete it and redeploy |
| `PREVIEW_SECRET` | Key of the admins' preview cookie (32+ characters). Changing it ends every admin's pass. Do it when an admin leaves |
| `MONTONIO_ENV` | `live` (exactly) means real money; anything else means Montonio's sandbox |
| `MONTONIO_ACCESS_KEY`, `MONTONIO_SECRET_KEY` | Online payments. Both or none. The keys must belong to the same environment as `MONTONIO_ENV` |
| `MONTONIO_REFERENCE_PREFIX` | Not set anywhere today. The default prefix is `MSLAB-M` on production, `MSLAB-P` on a preview |

**Never set on Vercel** (test-only): `MEDIA_LOCAL`, `BUNNY_FAKE_URL`, `PAYMENT_PROVIDER`, `MONTONIO_FAKE_URL`, `PAYMENT_MOCK_IN_PRODUCTION`, `E2E_MAIL_OUTBOX`, `E2E_MAIL_IN_PRODUCTION`.

Set by Vercel itself: `VERCEL` and the `VERCEL_*` address variables.

The `NEXT_PUBLIC_REVIEW_TOOLS` switch (the comment widget used in the design-review period) lives in `app/next.config.ts`, not in Vercel (`docs/launch-checklist.md` section 1).

**Previews.** A preview deployment (any branch other than `main`) gets no settings, so it answers 500 everywhere. That is harmless and intended. Never enable the production database for Preview (`docs/deploy.md` section 3).

### 1.4 How a change reaches the live site

1. Dim finishes a change and, from `app/`, stamps the test plan: `node tools/testplan-stamp.mjs` (then commits the changed `testplan.json`).
2. If the change needs a new migration: Dim applies it to Railway first (`docs/deploy.md` section 6).
3. Push to `main` of `mslabinformation-collab/mslab`. Vercel builds and deploys it. The build needs none of the settings.
4. Dim runs the read-only check `node tools/cache-smoke.mjs` (`docs/deploy.md` section 3).
5. Content changes made in the admin do **not** need a deploy: Maria's save or publish refreshes the affected public pages straight away (section 3.4).

---

## 2. The public site

Every public page exists in Estonian and in Russian (`/ru/…`). Pages are rendered on first visit and then served from Vercel's cache. An admin save or publish refreshes the pages it affects. Pages that list course dates also refresh themselves every 300 seconds (`docs/deploy.md` section 1). Anything without a page of its own shows a localised 404 page.

### 2.1 Pages anyone can open

| Address (ET) | What the visitor sees | Fed by (admin screen) |
|---|---|---|
| `/` | Home: hero slides, the MS LAB statement, course cards, upcoming course dates, practice block, trainer teaser, student reviews, news carousel, FAQ, contact block, and a newsletter popup | „Avaleht“ (slides, statement, FAQ), „Koolitused“ (cards), „Kalender“ (dates), „Praktika“, „Koolitaja“, „Uudised“, „Tagasiside“ (reviews), „Hüpikaken“ (popup) |
| `/koolitused` | Course catalogue (contact courses and e-courses) | „Koolitused“ |
| `/koolitused/<slug>` | One course page: description, price, dates and the registration form (contact course) or the buy button (e-course) | „Koolitused“ for the text and price; „Kalender“ for the dates and seats; „Tagasiside“ for reviews under the course |
| `/koolituskalender` | Calendar of upcoming contact-course sessions with free seats | „Kalender“ |
| `/praktika` | The practice packages (MINI and MAXI) and the request form | „Praktika“ |
| `/koolitaja` | The trainer page: portrait, bio, numbers, works gallery, two stories | „Koolitaja“ |
| `/uudised` and `/uudised/<slug>` | The blog: published posts | „Uudised“ |
| `/kontakt` | Contact details and the contact form | „Seaded“ → „Kontakt“ |
| `/privaatsus`, `/tingimused` | Privacy text and Study terms („Õppetingimused“) | „Seaded“ → „Lepingud ja tingimused“ (legal texts) |
| `/ostukorv` and `/ostukorv/<kursus>` | The e-course cart: terms, choice of bank link or instalments, then pay | „Koolitused“ (price), „Seaded“ (e-course contract text, instalments switch) |
| `/makse` | Where the bank sends the payer back; shows the result (read from the address fragment) | Nothing |
| `/tulekul` (internal) | The „Tulekul“ page shown to everyone while the gate is on. Not a page of the site proper | No admin screen. Text in the dictionaries |

### 2.2 The student account (`/konto/…`)

These pages are static shells; their data is loaded from the account API after the student signs in. Everything here is `private, no-store`. Until the launch the gate hides them too.

| Address | What the student sees |
|---|---|
| `/konto/sisene` | Sign in: by an e-mailed code or link; a password can be set later |
| `/konto` | „Minu koolitused“ (My courses): contact-course registrations with their payment status and „Maksa“ buttons, e-courses with progress, certificate links, the feedback card |
| `/konto/kursus/<slug>` | One e-course: modules and lessons, the „Lõpetamine“ (Completion) block, the terms gate on first opening |
| `/konto/kursus/<slug>/<lesson>` | A lesson: video, text, downloads. Progress is posted about every 15 seconds while the video plays |
| `/konto/kursus/<slug>/test` | The knowledge test |
| `/konto/kursus/<slug>/praktiline` | The practical work: photo upload and send |
| `/konto/protokoll` | The protocol Maria sent after a contact-course day |
| `/konto/tagasiside` | The course feedback form |
| `/konto/lemmikud` | Favourite courses |
| `/konto/andmed` | „Minu andmed“ (My details): name, password, deleting the account |

### 2.3 Addresses that are not pages

| Address | Purpose |
|---|---|
| `/maksa/<token>` | The „Maksa“ (Pay) link in a registration mail. Only shows the amount until the button is pressed, so a mail scanner opening it starts no payment |
| `/media/img/<id>.<ext>` | Public images from R2, cached by Vercel for a year |
| `/api/newsletter/loobu` | The unsubscribe page (a confirm button) |
| `/api/newsletter/confirm` | Old confirmation link (only in mailboxes from before 09.10); still works |
| `/api/payments/notify` | Montonio's webhook (section 5.2) |
| `/api/payments/return` | Where the bank sends the payer back |
| `/api/bunny/webhook` | Bunny's "video finished" ping |
| `/api/cron/sweep`, `/api/cron/uudiskiri` | The two daily jobs (section 5.1) |
| `/guide/…`, `/p/…` | The earlier design hub and prototypes: static files in `app/public`. Comment API at `/api/feedback` |

The whole host is marked "do not index" for search engines until the launch (`docs/launch-checklist.md` section 1).

---

## 3. The admin („Haldus“)

Sign in at `/admin/login` with an address on the `ADMIN_EMAILS` list: a link is e-mailed. The menu is grouped; badges show only what needs action. Menu source: `app/src/components/admin/sections.ts`.

### 3.1 How saving works on the admin

There are four different behaviours. Knowing which a screen uses tells you whether the public site has changed yet.

| Behaviour | What it looks like | When the public site / students change |
|---|---|---|
| **Autosave, live** | The status chip says „Salvestan…“ then „Salvestatud 14:32“. No save button | At once (the thing saved is live data) |
| **Autosave into a draft** | The chip says „Mustand salvestatud 14:32“ (Draft saved). The bar „Avaldamata muudatused: N“ shows with „Eelvaade ↗“, „Loobu muudatustest“ and **„Avalda muudatused“** (Publish changes) | Only when „Avalda muudatused“ is pressed |
| **Acts at once** | A switch or button that does its thing on the press, often with a confirm question | At once |
| **Sends something** | A button that e-mails someone or something external | At once, on the press |

- Autosave happens about 1.5 seconds after typing stops, or when you leave the field. Unsaved text is kept in the browser if the connection drops. Leaving a screen with unsaved text asks first (the "leave guard").
- If the same card is changed in two windows, the later save is refused with „Muudeti teises aknas — vaata üle“ and a „Taasta minu tekst“ (Restore my text) button.
- Reload the admin once after a deploy: an open window may hold the actions of the previous build.
- On a long page the status chip follows at the top right once the title row has scrolled away, so a save is always visible (06.11).
- A menu entry or list row is marked the moment it is pressed; when a page takes longer than 0.15 seconds a thin rose line runs along the top until it is in (06.11).
- A wrong admin address (for example an old bookmark) shows „Sellist lehte halduses pole.“ (No such page in the admin) inside the admin, with a button back to „Ülevaade“.

### 3.2 One row per screen

| Screen (menu name) | What Maria does there | What it changes | Saving and sending |
|---|---|---|---|
| **Ülevaade** (Overview) `/admin` | Reads the day: „Sinu järjekord“ (your queue: awaiting prepayment, awaiting assessment, open enquiries, payments without invoice, reviews awaiting publish, payments on hold), today's course day, the next five sessions, the test-page card | Nothing | Read-only |
| **Registreerimised** (Registrations) | Opens a registration drawer: sees the details, adds received money („Lisa laekumine“), sets the status, writes an internal note, cancels, prepares invoice and contract, opens the protocol | The registration's status and money; invoices; contract. Confirming a place frees or holds a seat in the public calendar | The note **autosaves live**. Status pills **act at once**. Adding a payment can create a receipt invoice. A **status change sends no mail**; „Tühista registreerimine“ says „Õpilasele kirja ei saadeta“ (the student gets no mail). The place is confirmed when at least 50% of the price has arrived |
| **Protokollid** (Protocols) | Per course day, writes one protocol per student (headings come from the course), then sends them | The `protocols` rows; on send, creates the student's account if there is none | Text **autosaves live**. „Saada“ **sends a mail** to the student („Sinu koolituse protokoll on valmis“, or „…on uuendatud“ on a resend) and opens the feedback form |
| **Hindamine** (Assessment) | Lists what waits: practical-work photos, open test answers, students out of tries. Opens the practical assessment (it is the protocol screen of an e-course access) or the test review. Second tab „Tunnistused“ (certificate register) | Marks and verdicts; can reopen a test; completes the course when everything is passed | Marks **autosave live**. „Saada hinnang“ / „Saada“ **send a mail** to the student („Sinu praktiline töö on hinnatud“, „Vaata üle oma testi vastused“, „Test on sooritatud“, „Test on sinu jaoks uuesti avatud“, and „Palju õnne! Koolitus … on lõpetatud“) |
| **Päringud** (Enquiries) | Reads contact messages, individual-course requests, practice requests, waiting-list entries and change/cancel requests; marks each „Märgi tehtuks“ (mark as done); done ones fold under „Tehtud“ | The request's handled flag only | The tick **acts at once**. No mail |
| **Õpilased** (Students) | Finds a student; opens the student's drawer with their courses; „Lisa õpilane“ (add a student); opens an e-course for them, extends or revokes access, unlocks the next lesson, reopens a test, corrects the name on a certificate. „Vaata tema vaadet“ (see their view) shows the student's view | Client accounts and course access (for e-courses) | Each button **acts at once**. **No mail** is sent by them (checked in the code), with one exception: „Ava test uuesti“ (reopen the test) mails „Test on sinu jaoks uuesti avatud“. For the rest, tell the student yourself |
| **Tagasiside** (Feedback) | Two views. „Arvustused“ (Reviews): student reviews waiting for „Avalda“ (Publish) or „Peida“ (Hide), manual reviews added by Maria („Lisa arvustus“). „Vastused“ (Answers): feedback form answers per course with averages | Which reviews show on course pages and the home page; a „Avalehel“ (on home) flag | **Acts at once.** Decisions can be undone for a few seconds. Deleting a manual review is a soft delete with „Võta tagasi“ |
| **Maksed ja arved** (Payments and invoices) `/admin/maksed`, with `/admin/arved` as the second tab | Maksed: online payments through Montonio, newest first. Arved: all invoices, month filter, CSV for the accountant („Laadi alla (CSV)“) | Read-mostly. Refunds are made in Montonio, not here | The lists are read-only. Invoice buttons act in the registration drawer (below) |
| **Koolitused** (Courses) | Lists courses; opens one in the **course editor**: title, text, price, learning outcomes, protocol headings, modules and lessons (video, text, files), the knowledge test, certificate wording; switches „Avalikul lehel“ (Public) | The course page, the catalogue, the lesson content students see | A **published** course edits into a **draft** and goes live with **„Avalda muudatused“**. An **unpublished** (or new) course saves straight to the record. A new course is created with „Lisa koolitus“. Acts at once: „Avalikul lehel“, „Näidissisu“, a lesson's video, kind and „Õpilastele nähtav“, adding or removing a lesson file, deleting an empty module or a lesson with no progress. A new module or lesson on a live course waits for „Avalda muudatused“ |
| **Kalender** (Calendar) | Adds and edits course sessions (date, time, city, venue, seats, language); cancels a session; opens the protocols for the day | The public calendar, the course page's dates and free seats | The drawer **autosaves live**. Adding a session and the cancel switch **act at once**. **Cancelling mails nobody**: the confirm question says „… registreeringut jäävad alles; teavita õpilasi ise.“ (the registrations stay; tell the students yourself) |
| **Praktika** (Practice) | Edits the MINI and MAXI packages: name, short text, number of models, duration, price, points | The practice page and the home page's practice block | **Draft + „Avalda muudatused“** |
| **Koolitaja** (Trainer) | Edits the trainer page: portrait, name, bio, numbers, works gallery, two stories | The trainer page and the home page's trainer block | **Draft + „Avalda muudatused“** |
| **Avaleht** (Home page) | Edits the hero slides, the MS LAB statement and the FAQ | The home page | **Draft + „Avalda muudatused“** |
| **Uudised** (News) | Writes blog posts, with a „Avaldatud“ (Published) switch | The blog and the home page's news carousel | A published post edits into a **draft + „Avalda muudatused“**. The „Avaldatud“ switch **acts at once** while a post has never been published |
| **Hüpikaken** (Popup) `/admin/kampaania` | Edits the one home-page popup, the newsletter sign-up, and switches it on or off; the welcome discount (percent) and how many days the code is valid | The home page popup; filling in „Kood kehtib (päeva)“ adds the line „Kood kehtib {n} päeva.“ to the welcome mail | Wording is a **draft + „Avalda muudatused“**. „Lehel näidatakse“ (Shown on the page) **acts at once** |
| **Uudiskiri** (Newsletter) | „Tellijad“ (subscribers): the list with status, CSV download. „Kirjad“ (letters): writes campaigns in ET and RU with picture, code and button; live preview; test send; send to all; stop a send; copy a letter | The subscriber list is only read here. A letter is a record; a send creates one delivery row per subscriber | The letter **autosaves live** as a draft letter. „Saada proov“ (Send a test) **mails one test** to Maria or the signed-in admin ([Proov] in the subject; at most 10 an hour). „Saada kõigile ({n})“ **mails everyone** after a confirm question with the counts. „Peata saatmine“ **stops** the rest. Nothing is sent without the explicit press |
| **Seaded** (Settings) | Cards: „Kontakt“, „Uudiskiri“ (welcome code), „Maksmine“ (the school's bank details and invoice seller fields, with a sample invoice PDF), „Järelmaks (Inbank)“ (instalments switch), „Tunnistus“ (certificate fields), „Lepingud ja tingimused“ (four legal texts), „Halduse ligipääs“ (read-only list of admin addresses; the developer changes it) | Footer and contact page; the payment instructions students see; invoice and certificate layout; the instalment choice on forms and carts | The cards **autosave live**. The instalments box saves the moment it is ticked and refreshes the course pages and carts. The four **legal texts are drafts**: they go live only with **„Avalda uus leping“** or **„Avalda uus tekst“** and a confirm question. Publishing a new e-course contract makes every active student confirm it again at their next sign-in |
| **Testimine** (Testing) | Maria and Dim answer the acceptance checks „Läbitud“ (Passed) or „Viga“ (Fault), with notes; there is a note box under every check | Records answers in the database; an automatic tester's answers are kept apart | Answers and notes **autosave live**. The first note or a „Viga“ **pings Telegram** |

The „Tunnistused“ register (`/admin/tunnistused`) and „Arved“ (`/admin/arved`) have no menu row of their own. They are tabs of Hindamine and Maksed.

### 3.3 Inside the registration drawer: invoices, contracts, certificates

Not separate screens, but important to know what they do:

| Where | Button | What happens |
|---|---|---|
| Registration drawer → „Arved“ | „Koosta arve“ (Create invoice) | Makes a numbered invoice from the school details in „Seaded“ → „Maksmine“. Needs those fields filled |
| | „Saada õpilasele“ (Send to the student) | **Sends a mail** „MS LAB arve {number}“ with the PDF attached |
| | „Laadi alla (PDF)“ | Downloads the invoice PDF. Nothing is sent |
| | „Märgi tasutuks“, „Võta tasumine tagasi“, „Tühista arve“, „Muuda saajat“ | Change the invoice record at once (under „Veel ▾“). No mail |
| Registration drawer → contract | „Saada leping kinnitamiseks“ | **Sends a mail** „MS LAB leping kinnitamiseks“. The student confirms on their course card |
| | „Saada koopia õpilasele“ | **Sends a mail** „MS LAB leping“ with the PDF |
| Student drawer → certificate | „Laada alla“, „Paranda nimi“ (Fix the name) | Downloads, or reissues the certificate with the corrected name. No mail |

An invoice also goes out **automatically** attached to the payment confirmation when an online payment is settled (section 4.1).

### 3.4 How the public site refreshes after an admin change

Pages are cached. An admin save or publish tells the site which pages to rebuild (`app/src/server/cache-targets.ts`). A **draft save revalidates nothing**; the **publish** refreshes the affected public pages once. The next visitor sees the change. A page that is requested between the database write and the refresh could be shown stale until the next refresh (accepted; `docs/launch-checklist.md` section 5).

### 3.5 The draft preview

„Eelvaade ↗“ on a publish bar opens the public page with the drafts laid over the live version. Only a signed-in admin sees that. A visitor never does. The preview exit is „Lõpeta eelvaade“.

---

## 4. Flows end to end

Mail names are the Estonian subjects the student or Maria sees. "Maria's notice" means an e-mail to `MARIA_EMAIL` plus a Telegram ping (when both are set up).

### 4.1 A contact-course registration with prepayment

1. The visitor opens a course page and fills in the registration form: name, e-mail, phone, session, a payment choice, and ticks the contract box „Olen tutvunud lepingu tingimustega ja nõustun nendega.“ The payment choices: **100% kohe** (whole amount), **ettemaks 50%** (half now) and, only when Maria has switched it on, **„Järelmaks (Inbank)“**. The contract text is frozen at that moment from „Seaded“.
2. The site stores the registration **and its contract in one transaction** (**Railway**). If the contract cannot be made, the registration is rolled back. The seat is held for **30 minutes** (60 for instalments) while a payment is open.
3. Mails go out after the answer is sent (**Resend**): the student gets „Registreering on vastu võetud — {course}“ with the prepayment details and a „Maksa“ link; **Maria's notice** says „Registreerimine: …“ and pings **Telegram**. If the session is full the visitor joins the waiting list instead („Oled ootenimekirjas“ to the visitor, „Ootenimekiri: …“ to Maria).
4. The student pays in one of three ways:
   - **Bank link or card (Montonio).** The site creates a Montonio order and sends the student to Montonio's page. The student picks a bank or card there. Montonio sends the payer back to `/api/payments/return` and, separately, calls the webhook `/api/payments/notify`. The site checks the signed token, settles the payment, adds the amount to the registration, confirms the place at 50% or more, makes a numbered invoice and attaches it. The student gets „Koht on kinnitatud — {course}“ (this payment confirmed the place) or „Makse on kätte saadud — {course}“; **Maria's notice** says „Uus makse: …“.
   - **Järelmaks (Inbank), through Montonio.** The same as above with Montonio's `hirePurchase` method for 100–5000 €. Inbank decides and signs with the student. Montonio pays Maria the whole price as a separate payout, up to 8 working days after the student signs. A pending application is not "failed": the page offers „Maksa pangalingiga“ as well. If a second payment arrives for the same thing, it is held („Ootel kontrollil“) and Maria gets „Topeltmakse: …“ (`docs/deploy.md` section 21).
   - **Bank transfer to Maria's account.** The details come from „Seaded“ → „Maksmine“ (receiver, IBAN, reference start). When the money arrives Maria opens the registration and presses **„Lisa laekumine“**, optionally with a receipt invoice. At 50% the place is confirmed.
5. Anything odd in a payment (amount differs, cancelled in the bank, refunded in Montonio) makes the payment "held" or "refunded" in Maksed and sends Maria a „Makse vajab kontrolli“ / „Kontrolli Montonios“ notice. Money is returned only in Montonio's Partner System (or by Maria's own bank transfer).
6. On the course day: Maria opens the **Protokollid** screen and writes protocols. A send creates the student's account if needed and mails „Sinu koolituse protokoll on valmis“ (see 4.4).

Touched, in order: browser → Vercel → Railway → Resend (+ Telegram) → Montonio → (webhook) Vercel → Railway → Resend (student, Maria) → Telegram.

### 4.2 An e-course purchase → lessons → test → practical work → certificate

1. **Buy.** On `/ostukorv/<kursus>` the visitor enters name and e-mail, reads and accepts the e-course contract, and chooses bank link or instalments. There is no account and no access before the payment. (If Montonio is not set up, the cart shows „Makse lisandub peagi“ and a purchase-interest form; Maria gets „E-koolituse ostusoov: …“.)
2. **Pay.** The Montonio flow of 4.1. On a paid purchase the site:
   - creates the student's account and opens the access (shown as "veebimakse" in Õpilased); buying again never shortens access;
   - freezes the e-course contract with the price paid;
   - makes the invoice and attaches it;
   - mails „E-koolitus on avatud — {course}“ with a sign-in link, and sends Maria's notice.
3. **Sign in.** At `/konto/sisene` by a code or link mailed as „{code} — MS LAB sisselogimiskood“. A password can be set in „Minu andmed“ (a change mails „MS LABi konto parool on muudetud“).
4. **Lessons.** The first opening shows the terms gate. A lesson's video comes from **Bunny** (signed address, valid four hours); files come from **R2** as short-lived signed addresses after the access check. Progress is stored in **Railway**.
5. **Knowledge test.** Maria's questions. **Choice questions are marked by the site at once**: one is right only when exactly the correct options are picked. The test passes at the course's pass mark, counted over the choice questions only (80% unless Maria sets another). **Open answers** go to Hindamine for Maria's review. Tries are limited; Maria can reopen a test („Ava test uuesti“), which mails „Test on sinu jaoks uuesti avatud“.
6. **Practical work.** The student uploads photos (stored privately in **R2**) and sends them. Maria assesses in Hindamine and presses „Saada hinnang“: the student gets „Sinu praktiline töö on hinnatud“ (or asks the student to fix some points).
7. **Completed.** When test and practical work are passed, Õpilased shows the access as „Läbitud {date}“ (passed) and the student gets „Palju õnne! Koolitus … on lõpetatud“.
8. **Certificate.** The student confirms the name once and downloads a PDF certificate from their course page (made on the fly; fonts are in the repository). The number series continues Maria's paper ones (settings in „Seaded“ → „Tunnistus“). No certificate mail was found. Contact courses stay on paper.
9. **Feedback and review.** The feedback form opens once the course is completed. If the student ticks permission, the review waits in „Tagasiside“ → „Arvustused“ for Maria's „Avalda“.

### 4.3 Newsletter subscribe → campaign send (with the daily limit)

1. **Subscribe.** The visitor enters an e-mail in the footer or popup. The site subscribes the address at once (one step, since 09.10) and mails **„Tere tulemast MS LABi!“** with an unsubscribe link and, if „Seaded“ has a „Tervituskood“, the welcome code. There is a limit of **25 welcome mails a day**; past that the address is still subscribed but gets no mail.
2. **Unsubscribe.** Her link opens a confirm page and the button unsubscribes (so mail scanners do not). The mail program's own "Unsubscribe" button also works (one-click).
3. **Write.** Maria writes a letter in „Uudiskiri“ → „Kirjad“ (autosaves), previews it, and sends a test to Maria's own address with „Saada proov“.
4. **Send.** „Saada kõigile ({n})“ asks "send to n subscribers (ET a, RU b)?". On „Saada“ the site writes one delivery row per confirmed subscriber (never `@example.test` sample addresses) and sends the **first batch at once**, each recipient getting their own mail in their language, with their own unsubscribe link and the `List-Unsubscribe` headers.
5. **The daily limit.** All mail the site sends in a UTC day is counted in one counter. A campaign only sends while that counter is **below 70** of Resend's free 100 a day. What does not fit waits for the **04:00 UTC daily job** (section 5.1), a batch a day until done. The screen shows „Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval“. Only one campaign goes out at a time.
6. **Stop / failures.** „Peata saatmine“ skips whatever has not been sent. If Resend refuses, the screen says „Saatmine peatus: Resend keeldus“ and the job retries next day. A mail with no clear answer is marked "unknown" and is never re-sent by itself (details: `docs/deploy.md` section 19, item 4).

Touched: browser → Vercel → Railway (list, deliveries, counter) → Resend; the daily job calls the same code.

### 4.4 A protocol

1. On the course day Maria opens **Kalender** → the session → „Protokollid“ (or the „Täna“ card on Ülevaade). She sees the listed students and writes a protocol for each; the headings are the course's „Protokolli punktid“.
2. Text autosaves (stored in **Railway**). A protocol has a status: Mustand (draft), Saadetud (sent), Muudetud (changed after sending).
3. A send for one student („Saada protokoll {name}“, Send the protocol to …; after a change „… uuesti“, again) or for all („Saada kõigile ({n})“, which first asks „Kas saadan {n} protokolli?“ and lists who is skipped): in one transaction the site freezes the sent text, makes the student's account if there is none, and links the registration. After the commit, mails go out one every 0.6 seconds: **„Sinu koolituse protokoll on valmis“** (first) or **„Sinu koolituse protokolli on uuendatud“** (resend). The first mail has the feedback form link and a login code.
4. The student reads it at `/konto/protokoll`; the feedback card „Kuidas koolitus läks?“ shows on the student's dashboard.

### 4.5 A review

1. A student's feedback form has the question "would you recommend this course, and why?" and an optional permission box and display name. Submitting stores the feedback; if the student ticked permission, a copy goes into `reviews` with status „Ootab kinnitust“ (pending). Maria's notice „Uus tagasiside: …“ adds „Lubab avaldada“.
2. Maria opens **Tagasiside** → „Arvustused“ and presses „Avalda“ (publish) or „Peida“ (hide). A student's text is never edited.
3. A published review shows under that course and, with „Avalehel“ on, on the home page. The pages are refreshed at the press.
4. Maria can also add a review from a paper form („Lisa arvustus“, with an internal note on where it came from).

### 4.6 An invoice

1. **Automatic:** an online payment is settled → an invoice is made and attached to the confirmation mail. **Manual:** Maria adds received money in the registration drawer with „Koosta kviitung“ ticked, or presses „Koosta arve“.
2. The invoice number comes from the series in „Seaded“ → „Maksmine“; amounts are frozen at creation, along with seller and buyer, so later setting changes do not alter old invoices.
3. The student sees invoices in their account. Maria can mail one with „Saada õpilasele“ (subject „MS LAB arve {number}“).
4. Once a month the accountant gets the CSV from **Arved** → „Laadi alla (CSV)“. A payment that is paid but still has no invoice appears in the strip „Arveta maksed“ with a catch-up button.

---

## 5. Automatic jobs

### 5.1 Daily jobs (Vercel cron, `app/vercel.json`)

Hobby allows daily jobs only; the exact minute within the hour varies. Both need the `CRON_SECRET` setting. Run one by hand: Vercel → Settings → Cron Jobs → „Run“ (production only).

| Job | When | What it does |
|---|---|---|
| `/api/cron/sweep` | 03:00 UTC (05:00 or 06:00 in Tallinn) | Deletes expired rate-limit rows (which hold visitors' addresses), old client login codes, ended client sessions older than 30 days, and mail counters older than 7 days. **Videos:** deletes stuck uploads, marks stuck "processing" videos ready or failed. **Files:** removes lesson files Maria marked for removal. **Reviews:** purges manual reviews Maria deleted 10 seconds ago or more. **Payments** (when Montonio is on): asks Montonio about every pending payment older than 45 minutes (75 for instalments) and younger than 14 days, up to 50 a run, and settles what it says; pending payments of 14 days, or never created at Montonio, become failed (their seat hold ends). Refreshes the calendar and course pages when seat holds ended. Alerts Maria once with „Makse vajab kontrolli: {nimi}“ if Montonio says a payment is paid but the site cannot settle it |
| `/api/cron/uudiskiri` | 04:00 UTC | Marks claims older than 6 minutes as "unknown", then sends one batch of the one campaign going out, while the day's counter is below 70 |

### 5.2 Webhooks (other services calling the site)

| From | Address | What the site does |
|---|---|---|
| **Montonio** | `POST /api/payments/notify` | Verifies the signed token (rejects forged or malformed ones with 400 so Montonio retries), settles the payment through the single settle routine, sends mails, pings Telegram. Montonio retries for up to 48 hours. Also receives refund notices. It works while the gate is on |
| **Montonio** (browser, not webhook) | `GET /api/payments/return` | Where the payer lands after the bank; redirects to `/makse` with the result |
| **Bunny** | `POST /api/bunny/webhook?secret=…` | A trigger only: the site reads the video's real status from Bunny's API and never trusts the body |
| **Mail programs** | `POST /api/newsletter/loobu` | One-click unsubscribe |

### 5.3 The mail budget

Resend Free is 100 mails a day and 3 000 a month (the day is the UTC day). The site keeps counters in the `mail_quota` table:

| Counter | Limit | What it stops |
|---|---|---|
| Shared | Sign-in mail or a confirmation with a code: **60** a day. A registration or request confirmation without a code: **30** a day | That kind of mail only |
| Welcome mail | **25** a day | Only the welcome mail (the person is still subscribed) |
| All mail | Campaigns send only while the day's total is below **70** | Newsletter campaigns only. The site's own mails are never stopped by the campaign counter |

Only sign-in mails, registration and request confirmations, and the welcome mail have a per-kind cap (checked in the code). Payment confirmations, protocols, invoices, contracts, assessments and Maria's notices have none: they follow something real and must not be lost. Every mail Resend accepts still adds one to the day's total. A busy day can use the 30 mails of headroom; Resend would then refuse the site's own mails, including sign-in codes, until the next UTC day (`docs/deploy.md` section 19, item 2).

### 5.4 Other limits to know

- Student video progress posts about every 15 seconds: 500 viewing hours a month is about 120 000 function calls.
- Image uploads are limited to 4 MB (the admin's browser shrinks them first).
- Rate limits on public forms and the student login are kept in the database (`kv_entries`).

---

## 6. Where to look when something breaks

| Symptom | Open | What to look for |
|---|---|---|
| Whole site shows 500 | Vercel → Project → Logs | The error names the missing required setting (never its value). Check Settings → Environment Variables, then redeploy |
| Every visitor sees „Tulekul“ | Vercel → Settings → Environment Variables | `SITE_GATE` is on (expected before launch). To see the whole site, sign in to the admin and press „Vaata kodulehte“. If that fails, `PREVIEW_SECRET` is missing or shorter than 32 characters |
| A deploy failed or the new version is wrong | Vercel → Deployments | Open the failed build. Roll back by promoting an earlier good deployment (`docs/deploy.md` section 8) |
| After a deploy a page 500s on a new field | Railway / `drizzle.__drizzle_migrations` | A migration was not applied before the push (`docs/deploy.md` section 6) |
| Admin cannot sign in; no mail arrives | Resend → Logs, and the address list in Vercel | The address is on `ADMIN_EMAILS`; `RESEND_API_KEY` is set; Resend → Domains shows `send.mslab.ee` verified; check the daily quota (section 5.3) |
| A student says no mail came | Resend → Emails, and Vercel logs (search `[notify]`) | `[notify] Resend rejected the e-mail: …` names the reason class. Quota? Wrong key? Bad address? |
| A payment is stuck, "pending" or "held" | Montonio Partner System → Orders; admin „Maksed“ | Order status; the admin's Maksed filter „Ootel kontrollil“. Vercel logs: search `[payments]` (`started`, `paid`, `failed`, `held`, `double`). The daily sweep also retries |
| Payment keys refused (401 `STORE_NOT_FOUND`) | Vercel → Environment Variables | `MONTONIO_ENV` and the two keys must belong to the same environment (sandbox or live) |
| Instalments not offered | Admin „Seaded“ → „Järelmaks (Inbank)“ | The box ticked; Montonio keys set; price between 100 and 5000 € |
| Video does not play or „Video seadistamata“ | Vercel logs; Bunny dashboard → the library | All three `BUNNY_*` settings; Bunny's Security settings (allowed domains `mslab.ee`, `www.mslab.ee`) (`docs/deploy.md` section 10) |
| Image missing or upload fails | Vercel logs; Cloudflare → R2 | The four `R2_*` settings; `/media` answers 404 for a missing key within a second |
| Notices not arriving in Telegram | Vercel logs (search `[notify] Telegram`) | `TELEGRAM_BOT_TOKEN` set; a chat is known (`TELEGRAM_CHAT_ID` or the database row `tg:chat`) |
| Newsletter stopped | Admin „Uudiskiri“; Vercel logs; Resend | The banner „Saatmine peatus: Resend keeldus“. Search logs for `[newsletter]`, `[cron] uudiskiri` and `[notify]`. Run the job by hand (section 5.1) |
| Daily job does nothing | Vercel → Settings → Cron Jobs | Both jobs listed; `CRON_SECRET` set (without it: 401) |
| Page shows old content after a publish | Vercel logs; the admin | Reload; check that the publish was pressed (draft chip); pages also refresh by themselves within 300 seconds if they list dates |
| Slow or erroring pages after traffic | Vercel → Usage | Against Hobby limits (section 1.1) |
| A test run or database tool must not touch production | `docs/deploy.md` section 7 | The tools refuse when `--target` disagrees with the database address |

### Speed: where things run

Measured on 06.11.2026 from Tallinn:

- **Vercel functions run in Frankfurt (`fra1`).** Visitors in Estonia are served by Vercel's Stockholm edge (`arn1`).
- **The database (Railway) is in the EU.** A simple admin page answers in about 0.1–0.15 seconds in total. A database in the US would add 0.3 seconds or more to every page by itself.
- **Opening a menu page takes about 0.3–0.45 seconds; a drawer about 0.35 seconds.** The server builds the list and the drawer again and streams them. That is normal for this kind of app, not a wrong location.
- **Until 06.11 every menu press also fetched about 18 other admin pages in the background** (link prefetching). That competed with the page asked for. It is now off; the press is marked at once instead (section 3.1).
- **Nothing to move.** Moving the database or the functions would not make the admin noticeably faster.

Log markers worth knowing (Vercel → Logs, search box): `[payments]`, `[newsletter]`, `[cron]`, `[notify]`, `[forms]`, `[protocols]`, `[completion]`, `[contracts]`, `[gate]`.

### Deploy and rollback pointers (`docs/deploy.md`)

| Need | Section |
|---|---|
| How a deploy works, the CLI fallback, the post-deploy checks | 3 |
| Applying migrations to Railway, and the order | 6 |
| The database tools and their guards | 7 |
| Rolling back the code | 8 (plus the rollback paragraph at the end of each feature's section, for example 11, 12, 21, 23, 24) |
| The two daily jobs | 5 (and 19 for the newsletter's) |
| Hobby limits | 9 |
| Bunny setup and first-use checks | 10 |
| Montonio setup, trust rules, refunds, logs | 11 and 21 |
| Mail logs and failure table for campaigns | 19 |

---

## 7. Before the public launch

Pointers into `docs/launch-checklist.md` (cite, do not copy). A box not yet ticked there is still open.

| Topic | Checklist section |
|---|---|
| Turn the gate off (delete `SITE_GATE`, redeploy), run the cache check, remove "do not index", new share image, Cloudflare clean-up. (The Telegram chat is already the group with Maria and the bot token stays: Dim, 06.11.2026.) | 1 |
| Domain, mailbox, Google Search Console and the old site's redirect map, analytics | 1b |
| Stay inside the free plans (Vercel stays on Hobby: Dim, 06.11.2026); Resend daily cap; abuse protection | 2 |
| Decisions still waiting for Maria (fonts, newsletter CSV, video hosting) | 3 |
| Content: Russian texts check, real photos and texts | 4 |
| Accepted robustness gaps | 5 |
| Client accounts, the mail budget | 7 |
| Lessons and video; Bunny cost check after the first month | 8 |
| Online payments: switching Montonio from sandbox to live | 10 |
| Protocols and the feedback form | 11 |
| E-course completion | 12 |
| The e-course certificate | 13 |
| The test page and its clean-up | 14 |
| Invoices; contracts; reviews; newsletter campaigns | 15, 16, 17, 18 |
| Instalments (accountant to be told before the first live loan) | 20 |
| The admin passes and the polish pass | 19, 21, 22, 24–28 |
| The test page's note box | 29 |

---

## Appendix — things worth remembering

- **Never run `npm run db:seed` against Railway.** It is meant for local databases. The tool refuses without an explicit target, and `--reset` is guarded (`docs/deploy.md` section 7).
- **Database addresses stay in the shell.** They are never written to a file in the repository.
- **Secrets are plain variables on Maria's Vercel project by the owner's choice** (08.10.2026); they are never in the repository, a log or a message (`docs/deploy.md` section 2).
- **A migration that drops things** goes after the code that no longer reads them (0010, 0016). All others are additive and go first.
- **Test data.** Addresses ending `@example.test` are treated as sample addresses: the site never mails them.
- **When an admin leaves:** take them off `ADMIN_EMAILS`, change `PREVIEW_SECRET`, redeploy.
