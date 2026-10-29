// The admin area is Estonian only (Maria and Dim), so its strings are one dictionary here instead of et.ts + ru.ts.
// {name}, {link} are filled with fill() from "@/i18n/format".

// The texts under a refused field, shared by every content editor (server/edit-check.ts FieldError).
const fieldErrors = {
  required: "Täida see väli (eesti keeles).",
  tooLong: "Tekst on liiga pikk.",
  slugFormat: "Kasuta ainult väikesi tähti (a–z), numbreid ja sidekriipse.",
  slugTaken: "See aadress on juba teisel koolitusel.",
  amount: "Sisesta summa eurodes, näiteks 290 või 290,50.",
  whole: "Sisesta täisarv.",
  // Hüpikaken's „Soodustus (%)“ (1–99) and „Kood kehtib (päeva)“ (1–365) as a whole number outside the range (Dim 29.10); no whole number: `whole`
  discountRange: "Soodustus peab olema 1–99%.",
  codeDaysRange: "Kood saab kehtida 1–365 päeva.",
  priceRequired: "Avaldatud koolitusel peab olema hind.",
  listEt: "Igal real peab olema eestikeelne tekst.",
  tooMany: "Liiga palju ridu.",
  image: "Seda pilti ei saa kasutada. Lae pilt uuesti üles.",
  badge: "Vali märgisele üks värvidest.",
  course: "Vali koolitus.",
  date: "Sisesta kuupäev.",
  time: "Sisesta kellaaeg, näiteks 10:00.",
  capacity: "Kohtade arv peab olema 1–99.",
  // a calendar session's rules (piece 3b, R-c and R-b): README B3, {n} the confirmed registrations; piece3-texts S3-P3-i
  capacityBelow: "Kinnitatud on {n} — kohti ei saa olla vähem.",
  courseLocked: "Toimumisel on registreeringuid, seega koolitust muuta ei saa.",
  typeLocked: "Sellel koolitusel on toimumisi või registreerimisi, seega õppevormi muuta ei saa. Vajadusel loo uus koolitus.",
  href: "Sisesta lehe aadress, mis algab kaldkriipsuga (nt /koolitused), või täielik aadress, mis algab https://.",
  url: "Sisesta täielik aadress, mis algab https://.",
  email: "Sisesta korrektne e-posti aadress.",
  phone: "Sisesta telefoninumber, nt +372 5555 0101.",
  focal: "Vali pildil fookuspunkt.",
  codeFormat: "Kasuta ainult tähti (A–Z), numbreid ja sidekriipsu.",
  imageRequired: "Lisa pilt.",
  localeHref: "Kirjuta lehe aadress ilma keeleta, nt /koolitused: vene lehel lisatakse /ru ise.",
  iban: "Kontrolli IBANi: kaks tähte, kaks numbrit ja konto number, nt EE38 2200 2210 2014 5685.",
  // "Teadmiste test" (e-course completion): shown in the card of the question the save names
  testTooMany: "Testis saab olla kuni 50 küsimust.",
  testEmpty: "Täida küsimuse tekst ja iga vastusevariant.",
  testTooLong: "Küsimuse tekst võib olla kuni 500 ja vastusevariant kuni 200 märki.",
  testOptions: "Valikvastustega küsimusel peab olema 2–6 vastusevarianti.",
  testNoCorrect: "Märgi vähemalt üks vastus õigeks.",
};

export const adminEt = {
  meta: { title: "Haldus — MS LAB" },

  login: {
    title: "Halduse sisselogimine",
    lead: "Saadame sulle sisselogimislingi. Ava link selles seadmes, kus soovid sisse logida.",
    emailLabel: "E-post",
    submit: "Saada sisselogimislink",
    sending: "Saadan…",
    // The sent state (piece 4c, S4-47c) names the address typed, and is the same for an allowed and a not allowed one: the server's answer is the same
    // for both, so the page never tells which addresses exist. {email} is the address as typed.
    sentTitle: "Link on teel",
    sent: "Saatsime lingi aadressile {email}. See kehtib 15 minutit.",
    sentHint: "Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.",
    // beside the remembered address (it empties the field) and under the sent state (back to the form): S4-47b, S4-47c
    other: "Muu aadress",
    errorEmail: "Sisesta korrektne e-posti aadress.",
    // the per-IP limit (5 requests in 10 minutes from one connection, any addresses)
    errorTooMany: "Liiga palju katseid. Proovi mõne minuti pärast.",
    // B20, S4-47d: the 4th request for the same typed address within 10 minutes, allowed or not (server/login.ts)
    errorAddress: "Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.",
    errorGeneric: "Midagi läks valesti. Proovi uuesti.",
    // /admin/login?viga=link / =server after a login link was opened.
    errorLink: "See sisselogimislink on aegunud või juba kasutatud. Telli uus link.",
    errorServer: "Sisselogimine ei õnnestunud. Proovi uuesti.",
    back: "MS LAB Koolituskeskuse avalehele",
  },

  // E-mail with the login link (plain text). {link} is the verification URL.
  mail: {
    subject: "MS LAB — sisselogimislink",
    text: [
      "Tere!",
      "",
      "MS LABi halduse sisselogimiseks ava see link:",
      "{link}",
      "",
      "Link kehtib 15 minutit ja töötab ainult ühe korra. Kui sa ei soovinud sisse logida, jäta see kiri tähelepanuta.",
      "",
      "MS LAB Koolituskeskus",
    ].join("\n"),
  },

  panel: {
    hello: "Tere, {name}.",
    /** an admin without a greeting name in ADMIN_NAMES */
    helloNoName: "Tere.",
    logout: "Logi välja",
    // error.tsx of the (panel) group (README §1.10): a page that could not be loaded; the menu stays. The same words are on app/admin/error.tsx,
    // the net for a layout that failed (no menu then)
    errorTitle: "Seda lehte ei saanud praegu laadida.",
    errorBody: "Sinu salvestatud andmed on alles. Proovi mõne hetke pärast uuesti.",
    errorRetry: "Proovi uuesti",
  },

  // Prototype B admin shell: dark left sidebar, top line, main column. Below 900px a top bar with a menu drawer.
  shell: {
    label: "Koolituskeskuse haldus",
    top: "MS LAB · Halduskeskkond",
    skip: "Liigu sisu juurde",
    nav: "Halduse menüü",
    home: "Halduse ülevaade",
    openMenu: "Ava menüü",
    closeMenu: "Sulge menüü",
    newWindow: "avaneb uues aknas",
    // the top line's link through the coming-soon gate (api/admin/preview: the preview cookie, then the home page); the phone menu's footer has it too
    preview: "Vaata kodulehte",
    logout: "Logi välja",
    // the sidebar's footer (README §1.1): above the e-mail; there is no tooltip on a touch screen
    signedIn: "Sisse logitud",
    // the phone menu's card on a day with a session (README §1.1): the time, then the course; it opens the session's protocols
    today: "TÄNA {time}",
    todayLine: "Protokollid · {course}",
    badgeRegistrations: "{n} ootab ettemaksu",
    badgeRequests: "{n} tegemata",
    // Hindamine's badge (e-course completion, spec §5.2): practical work, open answers and students out of tries, together
    badgeAssessment: "{n} ootab hindamist",
    // the badges of the admin UX pass (B6), as a screen reader says them (Dim, 21.10): reviews waiting for „Avalda“, payments to look at (unbilled,
    // „kontroll“, voided after paid), the signed-in admin's own „Viga“ checks, and a course day (the badge itself shows „Täna“)
    badgeFeedback: "{n} arvustust ootab",
    badgePayments: "{n} vajab kontrolli",
    badgeTesting: "{n} viga",
    badgeToday: "Täna on koolituspäev",
    badgeTodayText: "Täna",
  },

  nav: {
    overview: "Ülevaade",
    courses: "Koolitused",
    calendar: "Kalender",
    registrations: "Registreerimised",
    assessment: "Hindamine",
    payments: "Maksed ja arved",
    feedback: "Tagasiside",
    clients: "Õpilased",
    requests: "Päringud",
    practice: "Praktika",
    home: "Avaleht",
    trainer: "Koolitaja",
    news: "Uudised",
    campaign: "Hüpikaken",
    newsletter: "Uudiskiri",
    settings: "Seaded",
    // admin UX pass (README §1.1): the rows of Protokollid and Testimine
    protocols: "Protokollid",
    testing: "Testimine",
    // the menu's group headings, in sentence case: the sidebar shows them in capitals (CSS)
    groups: {
      daily: "Igapäevane töö",
      courses: "Koolitused",
      site: "Koduleht ja uudiskiri",
      admin: "Haldus",
    },
  },

  // Long lists (registrations, requests, subscribers) come 50 rows a page: ?leht=<n>.
  pager: {
    label: "Lehekülgede valik",
    prev: "Eelmine",
    next: "Järgmine",
    page: "Lehekülg {page} / {pages}",
  },

  common: {
    yes: "Jah",
    no: "Ei",
    none: "—",
    saving: "Salvestan…",
    saveError: "Salvestamine ei õnnestunud. Proovi uuesti.",
    locale: { et: "ET", ru: "RU" },
    // the glossary's words (admin UX pass, README §1.11): „Katkesta“ steps back out of a form or a question („Tühista“ cancels a business record
    // and never means "never mind"), „Sulge“ closes a drawer, „Võta tagasi“ undoes the last action
    cancel: "Katkesta",
    close: "Sulge",
    undo: "Võta tagasi",
    // the button of a row's menu of rarer actions: „Veel ▾“ (MoreMenu; the ▾ is the component's, not the text's)
    more: "Veel",
  },

  // SaveStatus (admin UX pass, README §1.4; strings.md D1, D2): the one status chip of a screen. {time} is "HH:MM" in Tallinn; {thing} is the partitive
  // of what the screen edits („registreerimist“). The saved chip shows a ✓ in front (the component's, not the text's).
  autosave: {
    saved: "Salvestatud {time}",
    savedNoTime: "Salvestatud",
    draft: "Mustand salvestatud {time}",
    draftNoTime: "Mustand salvestatud",
    // the phone page's short form of the draft chip (the plain one is just the time); drawers keep the full form
    draftShort: "Mustand {time}",
    draftShortNoTime: "Mustand",
    dirty: "Salvestamata muudatused",
    saving: "Salvestan…",
    checking: "Kontrollin salvestatud teksti…",
    retry: "Salvestamata — proovin uuesti",
    invalid: "Salvestamata — kontrolli märgitud välja",
    show: "Näita",
    signedOut: "Salvestamata — logi uuesti sisse",
    // the words of `signedOut` that link to the login page and back here (B19); never shown on their own
    signedOutLink: "logi uuesti sisse",
    conflict: "Muudeti teises aknas — vaata üle",
    gone: "Seda {thing} enam ei ole. Tekst on selles seadmes alles.",
    // README's „{asja}“, for a screen that does not name its thing
    goneThing: "asja",
  },

  // The leave guard (admin UX pass, README §1.5, screens §2.4): leaving a page or closing a drawer while a change cannot be saved yet. {field} is the
  // visible name of the field concerned. The offline reason is the Part 1 prototype's; the other four Dim approved on 21.10.
  leave: {
    notice: "Muudatust „{field}“ ei saanud veel salvestada.",
    stay: "Jää siia",
    go: "Sulge, tekst jääb seadmesse",
    reasons: {
      offline: "Ühendus puudub. Proovin uuesti, kuni jääd siia.",
      error: "Salvestamine ei õnnestunud.",
      invalid: "Üks väli vajab parandamist.",
      signedOut: "Logi uuesti sisse.",
      upload: "Üleslaadimine käib.",
      // a record made by its one explicit button, typed into and not created yet (piece3-texts S3-P3-g): {thing} is the thing in the partitive,
      // capitalised („Koolitust“, „Toimumist“); the source names it
      notCreated: "{thing} pole veel lisatud.",
    },
  },

  // PublishBar (admin UX pass, README §1.8; strings.md W9): the bar of a published thing with unpublished changes. {n} is how many parts changed.
  // The desktop words are README's; the phone's bar (below 900px) is the phone mock's „Avaldamata {n} · Eelvaade“ + „Avalda“, its two parts kept
  // apart because „Eelvaade“ is the link. „Mustand“ stays out of the draft layer's words (behaviours.md B2).
  publish: {
    count: "Avaldamata muudatused: {n}",
    preview: "Eelvaade ↗",
    discard: "Loobu muudatustest",
    publish: "Avalda muudatused",
    confirm: "Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.",
    confirmYes: "Jah, loobu",
    phoneCount: "Avaldamata {n}",
    phonePreview: "Eelvaade",
    phonePublish: "Avalda",
    // piece3-texts S3-P3-a (Dim 23.10): on every bar, after the list of labels (the desktop bar; the phone's stays one line)
    previous: "Avalikul lehel on näha eelmine versioon.",
    // S3-P3-b: what „Avalda muudatused“ could not publish, under the bar. {fields}: the missing fields' labels in lowercase, joined with ", "
    // („Puudub: hind“); the parts changed meanwhile in another tab are listed by their labels under the sentence
    missing: "Puudub: {fields}",
    changedMeanwhile: "Neid välju ei avaldatud, sest neid muudeti vahepeal teises aknas. Vaata need üle.",
    // README §1.8 (B2 drawn „Lühikirjeldus · avaldamata“; strings.md 3.1): the label of a field whose text waits for „Avalda muudatused“
    fieldTag: "avaldamata",
    // Dim 24.10 (D-2): a publish or a discard that failed (a server error, no connection), on the PublishBar and the public preview bar; an ended
    // session says „Logi uuesti sisse.“ (leave.reasons.signedOut)
    publishFailed: "Avaldamine ei õnnestunud. Proovi uuesti.",
    discardFailed: "Muudatustest loobumine ei õnnestunud. Proovi uuesti.",
    // Dim 24.10 (D-1, D-4): the way out of the public preview, on the course page's bar and the catalogue's (server/preview-bar.ts; the catalogue's
    // bar is named with phonePreview, „Eelvaade“)
    previewExit: "Lõpeta eelvaade",
  },

  // The site editors' field labels on the PublishBar and in „Puudub: …“ (admin UX pass piece 4a; piece4-texts S4-1, S4-12, S4-17, S4-34, Dim
  // 26.10; domain/site-changes.ts siteFieldLabel): a field is its visible label, a field of a list row `{rida} {n} {väli}`, a list as a whole its
  // card's title. „Puudub:“ writes them with the first letter in lower case except KKK, MINI and MAXI (S4-2, domain/site-changes.ts missingCase)
  siteChanges: {
    home: {
      // {n}: the slide's place in the draft, from 1; {field}: one of slideFields
      slide: "Slaid {n} {field}",
      // a slide's focal points count as its picture (S4-10 note)
      slideFields: { image: "pilt", kicker: "väike pealkiri", title: "pealkiri", text: "alapealkiri", ctaLabel: "nupu tekst", ctaHref: "nupp viib", tone: "toon", active: "näidatakse avalehel" },
      slides: "Slaidid",
      statement: "MS LABi lause",
      teaser: "Koolitaja kaart",
      question: "KKK küsimus {n}",
      answer: "KKK vastus {n}",
      faq: "KKK",
    },
    trainer: {
      // the picture and its focal point
      portrait: "Portree",
      name: "Nimi",
      role: "Amet",
      bio: "Tutvustus",
      stats: "Numbrid",
      works: "Galerii",
      // a story's title or text
      center_story: "Koolituskeskuse lugu",
      trainer_journey: "Koolitaja teekond",
    },
    // {code}: the package's code (MINI, MAXI); {n}: the point's place in the draft, from 1
    practice: {
      name: "{code} nimi",
      tagline: "{code} lühitekst",
      models: "{code} modelle",
      durationLabel: "{code} kestus",
      price: "{code} hind",
      item: "{code} punkt {n}",
      items: "{code} punktid",
    },
    // a post's fields (S4-24); `Puudub: …` lists them in lower case (S4-22: `kaanepilt`, `tekst`, `pealkiri (RU)`, `tekst (RU)`)
    post: {
      title: "Pealkiri",
      slug: "Aadress",
      category: "Kategooria",
      excerpt: "Lühitekst",
      body: "Tekst",
      publishedAt: "Kuupäev",
      coverKey: "Kaanepilt",
      // a path the post's labels do not know is named by the part itself, as S4-1 names any part's (the word of ADM:2259, news.col.post)
      post: "Postitus",
    },
    // Hüpikaken's offer (S4-30: a field's label without the unit in brackets, „Soodustus (%)“ → „Soodustus“); `Puudub: pilt` (S4-26) in lower case
    popup: {
      kicker: "Silt",
      title: "Pealkiri",
      text: "Tekst",
      imageKey: "Pilt",
      discountPercent: "Soodustus",
      codeDays: "Kood kehtib",
      // a path the offer's labels do not know is named by its card (S4-27 „Pakkumine“)
      offer: "Pakkumine",
    },
    // S4-1: a label whose only change is the Russian text ({label}: any of the above, e.g. „Slaid 2 pealkiri (RU)“)
    ru: "{label} (RU)",
  },

  // The overview (admin UX pass piece 2, A1; README A1, Part 2 prototype, P-1): „Täna“ cards, „Sinu järjekord“, „Tulevased koolitused“
  overview: {
    // a session today: the line over its course (shown in capitals: CSS), the numbers under it ({n} the listed students, {a} the sent protocols,
    // {b} the drafts, {c} the students with none yet: zero parts are said, as the Protokollid index does) and the way to its protocols
    today: {
      when: "Täna {time} · {place}",
      counts: "{n} õpilast · protokollid: {a} saadetud, {b} mustand, {c} alustamata",
      open: "Ava protokollid →",
    },
    // each row is something to act on: a count, the label, a hint line under it; a row with 0 is not drawn
    queue: {
      title: "Sinu järjekord",
      empty: "Järjekord on tühi.",
      emptyHint: "Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.",
      label: {
        awaiting: "Ootab ettemaksu",
        assessment: "Ootab hindamist",
        requests: "Päringut tegemata",
        unbilled: "Arveta makset",
        reviews: "Arvustus ootab avaldamist",
        check: "Makse ootel kontrollil",
      },
      // „Ootab ettemaksu“, „Arveta makset“, „Arvustus ootab avaldamist“ and „Makse ootel kontrollil“: the oldest one that waits ({date} dd.mm, {name} whose)
      oldest: "Vanim {date} · {name}",
      // „Makse ootel kontrollil“ ends with what to do about the oldest one: its check reason's words when it has one (adminEt.payments.reason), else this
      checkAt: "kontrolli Montonios",
      // „Ootab hindamist“: the parts of the hint, zero ones left out ({n} each)
      assessmentParts: { practical: "{n} praktiline töö", test: "{n} testi vastus", triesUsed: "{n} katsed otsas" },
      // „Päringut tegemata“: the parts of the hint, in this order, zero ones left out ({n} each)
      requestParts: { contact: "{n} kontakt", individual: "{n} individuaal", practice: "{n} praktika", waitlist: "{n} ootenimekiri", change_request: "{n} muutmine" },
    },
    upcoming: {
      title: "Tulevased koolitused",
      // the number of sessions in the next 30 days ({n}); the rows are the next five
      window: "järgmise 30 päeva jooksul: {n}",
      date: "Kuupäev",
      course: "Koolitus ja linn",
      seats: "Vabu kohti",
      calendar: "Kalender →",
    },
  },

  registrations: {
    eyebrow: "Kontaktõpe ja e-õpe",
    title: "Registreerimised",
    lead: "Koht on kinnitatud, kui laekunud on vähemalt 50% koolituse hinnast.",
    typeLabel: "Õppevorm",
    // the form pills (A2: „Kõik vormid“ / „E-õpe“ / „Kontaktõpe“) and the status pills („Kõik“ first), each with its count
    type: { all: "Kõik vormid", e: "E-õpe", k: "Kontaktõpe" },
    statusLabel: "Staatus",
    statusAll: "Kõik",
    status: { awaiting_prepayment: "Ootab ettemaksu", confirmed: "Kinnitatud", cancelled: "Tühistatud" },
    // the toolbar (README A2, B7): the search across name, e-mail and phone, and the scope select's „all“ option
    searchPlaceholder: "Otsi nime, e-posti või telefoni järgi",
    scopeAll: "Kõik koolitused ja toimumised",
    // what the list is of, in a sentence (ListEmpty: „Registreerimisi veel pole.“, „Selle valikuga registreerimisi pole.“, P-9)
    things: "registreerimisi",
    count: "Registreerimisi: {n}",
    // the five columns (A2); „Liik“, „Modelli abi“ and „Konto“ are in the drawer's details
    col: {
      date: "Kuupäev",
      name: "Nimi ja kontakt",
      course: "Koolitus ja toimumine",
      paid: "Laekunud",
      status: "Staatus",
    },
    // „Laekunud“ column: „{paid} / {price} €“; the phone card says the same after the session: „{session} · laekunud {paid} / {price} €“
    paidOf: "{paid} / {price}",
    paidWord: "laekunud",
    individual: "Individuaal",
    group: "Grupp",
    // An individual contact course has no session: Maria agrees the time with the student.
    agreed: "Aeg kokkuleppel",
    open: "Ava {name}",
    drawer: {
      label: "Registreerimine: {name}",
      notFound: "Seda registreerimist ei leitud.",
      details: "Registreerimise andmed",
      // the details' folded row summary (P-3): {n} the rows inside
      rows: "{n} rida",
      email: "E-post",
      phone: "Telefon",
      course: "Koolitus",
      session: "Toimumine",
      type: "Õppevorm",
      kind: "Osalemine",
      group: "Grupp",
      individual: "Individuaal",
      created: "Registreeritud",
      locale: "Keel",
      payment: "Makseviis",
      paymentFull: "Kogu summa (100%)",
      paymentHalf: "Ettemaks 50%",
      paymentFinancing: "Järelmaks (Inbank)",
      modelHelp: "Vajab abi modelli leidmisel",
      account: "Soovib kontot",
      period: "Soovitud periood",
      message: "Sõnum",
      noPrice: "Koolitusel pole hinda, staatust ei arvutata. Muuda staatust käsitsi.",
      // „Lisa laekumine“ → „Muu summa“ that is no euro amount (piece2-texts S3-e reuses it; the typed „Laekunud summa“ field is gone, B4)
      paidInvalid: "Sisesta summa eurodes, näiteks 175 või 175,50.",
      // the Raha card (admin UX pass, piece 2, Task 5; README A2 drawer 2, piece2-texts P-2, S3-a…e; the words of README and the Part 2 mock are
      // verbatim). {paid}, {price}, {pool} and {x} are euros like "145 €" („Koht kinnitub {pool} juures“: {pool} is half the price, from which the
      // place is confirmed); {free} / {cap} the session's free seats and its capacity; {nr} a receipt's number; {link} the link to Seaded.
      // „…Alone“: a registration with no session (individual or e-learning, S3-d): no seats to show
      money: {
        title: "Raha",
        // P-2: the payment choice she made on the form
        chosen: { half: "Valitud: ettemaks 50%", full: "Valitud: kogu summa (100%)", financing: "Valitud: järelmaks (Inbank)" },
        // „{laekunud} / {hind} laekunud“: the money (large) and the rest of the line
        of: "/ {price} laekunud",
        seat: "Koht kinnitub {pool} juures · vabu kohti {free} / {cap}",
        seatAlone: "Registreering kinnitub {pool} juures",
        add: "Lisa laekumine",
        // the panel: the amount pills (P-2), the day, the way, the receipt (S3-c in its place without a seller), the submit and its refusals
        amount: "Summa",
        half: "{x} · ettemaks",
        full: "{x} · kogu summa",
        rest: "{x} · ülejäänud summa",
        other: "Muu summa",
        date: "Tasumise kuupäev",
        method: "Makseviis",
        methods: { bank: "Pangaülekanne", cash: "Sularaha", card: "Kaart" },
        receipt: "Koosta kviitung (arve „Juba tasutud“)",
        needSeller: "Kviitungit ei saa koostada: täida {link}.",
        needSellerLink: "Seaded → Maksmine",
        submit: "Lisa {x}",
        submitSeat: "Lisa {x} · koht kinnitub",
        submitAlone: "Lisa {x} · registreering kinnitub",
        // S3-e: {x} is what is left, without the euro sign
        overRemainder: "Summa on suurem kui tasumata osa ({x} €).",
        // the press was built on an old total (a second tab, a Montonio payment landing meanwhile): refused, the page refreshes (piece2-texts W1; the
        // status pills keep `drawer.stale`)
        stale: "Laekunud summa muutus vahepeal. Vaata summa üle ja lisa uuesti.",
        // the results (README, S3-a, S3-b, S3-d): „Receipt“ with the receipt's number; „confirmed“ the press confirmed the place, „under“ it is
        // still under 50 %, „plain“ it was confirmed before (or the course has no price), „full“ 50 % reached in a full session
        done: {
          confirmed: "{x} lisatud · koht kinnitatud.",
          confirmedReceipt: "{x} lisatud · kviitung {nr} · koht kinnitatud.",
          confirmedAlone: "{x} lisatud · registreering kinnitatud.",
          confirmedAloneReceipt: "{x} lisatud · kviitung {nr} · registreering kinnitatud.",
          under: "{x} lisatud. Koht kinnitub {pool} juures.",
          underReceipt: "{x} lisatud · kviitung {nr}. Koht kinnitub {pool} juures.",
          underAlone: "{x} lisatud. Registreering kinnitub {pool} juures.",
          underAloneReceipt: "{x} lisatud · kviitung {nr}. Registreering kinnitub {pool} juures.",
          plain: "{x} lisatud.",
          plainReceipt: "{x} lisatud · kviitung {nr}.",
          full: "{x} lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.",
          fullReceipt: "{x} lisatud · kviitung {nr}. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.",
        },
      },
      // „Staatus ja märkus“ (README A2 drawer 3): the status pills (saved at once) and the autosaved note; `noteThing` is SaveStatus's „gone“ word
      // (P-10: „Seda registreerimist enam ei ole. …“); `restore` the conflict's „Taasta minu tekst“ (README §1.3)
      statusTitle: "Staatus ja märkus",
      statusLabel: "Staatus",
      noteLabel: "Märkus",
      noteHint: "Näeb ainult haldus.",
      noteTooLong: "Märkus on liiga pikk (kuni 2000 märki).",
      noteThing: "registreerimist",
      restore: "Taasta minu tekst",
      stale: "Staatus muutus vahepeal (näed nüüd kehtivat). Vaata üle ja salvesta uuesti.",
      cancel: "Tühista registreerimine",
      cancelled: "Registreerimine on tühistatud.",
      // „Tühista registreerimine“ asks with a ConfirmPanel (B10; README A2 drawer 6, piece2-texts S3-g). {name} is the student's as written (a surname's
      // case is not guessed), {place} the session's day and city ("12.12 Tallinn"), {x} the money received, as euros without the sign; each line shows
      // only when true, `noMail` always
      cancelPanel: {
        question: "Kas tühistan registreerimise: {name}?",
        seat: "Koht {place} koolitusel vabaneb kohe avalikus kalendris.",
        moneyAndInvoices: "Laekunud {x} € ja arved jäävad alles.",
        moneyOnly: "Laekunud {x} € jääb alles.",
        invoicesOnly: "Arved jäävad alles.",
        noMail: "Õpilasele kirja ei saadeta.",
        yes: "Jah, tühista",
      },
    },
  },

  // "Maksed" (phase 2b, spec 8): the online payments through Montonio. Bank transfers stay Maria's own entries on the registration.
  payments: {
    // the heading both tabs (Maksed, Arved) share: the eyebrow of W21 and the H1 of the Part 2 mock
    eyebrow: "Montonio ja raamatupidamine",
    heading: "Maksed ja arved",
    title: "Maksed",
    lead: "Veebimaksed Montonio kaudu, uuemad eespool. Tagastused tehakse Montonio halduses; pangaülekanded märgid registreerimise juures nagu varem.",
    // the tabs „Maksed“ | „Arved“ (README A6; each its own page)
    tabs: { payments: "Maksed", invoices: "Arved" },
    // the toolbar's search (piece 2 texts S3-m): name, e-mail and Montonio id
    searchPlaceholder: "Otsi nime, e-posti või Montonio id järgi",
    // what the list is of, in a sentence (ListEmpty: „Makseid veel pole.“, „Selle valikuga makseid pole.“, „„{q}“ järgi makseid ei leitud.“)
    things: "makseid",
    filterLabel: "Staatus",
    filter: { all: "Kõik", paid: "Makstud", pending: "Pooleli", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil" },
    // replaced (B22, README §5): an older open order a newer attempt of the same registration took the place of; shown under „Kõik“ only
    status: { pending: "Pooleli", paid: "Makstud", failed: "Ebaõnnestunud", refunded: "Tagastatud", held: "Ootel kontrollil", replaced: "Asendatud" },
    // a payment the bank took back after it was paid (stored as failed, with its paid_at): the owner's word for a bank reversal
    statusVoided: "Tühistatud pangas",
    kind: { prepayment: "Ettemaks", balance: "Ülejäänud", ecourse: "E-koolitus" },
    // a held payment, or one the bank voided after it was paid
    check: "Kontrolli Montonios",
    // a held payment's check reason (payments.check_reason, domain/payments.ts CheckReason), said in place of `check` (B22, README §5; P-8)
    reason: { double: "Topeltmakse — tagasta" },
    count: "Makseid: {n}",
    // the columns (A6; the Part 2 prototype draws no desktop Maksed frame, so: the list's own, with „Liik“ under „Eest“ and „Makseviis“ under „Summa“)
    col: { date: "Kuupäev", payer: "Maksja", what: "Eest", amount: "Summa", status: "Staatus", provider: "Montonio id" },
    // the name's link (the whole row opens what it leads to): „Ava {name}“, as the other lists say it
    open: "Ava {name}",
    // where a row leads, as the phone card says it (the Part 2 phone frame „Ava registreering →“; P-8 „Ava õpilane →“ for an e-course payment)
    openRegistration: "Ava registreering →",
    openStudent: "Ava õpilane →",
    // the Montonio id as a link (Dim 22.10): „Montonios ↗“ (the arrow is the component's) opens the Partner System and copies the order id; the line says the copy was made
    montonio: "Montonios",
    montonioCopied: "Montonio id kopeeritud.",
    // the link's name for a screen reader: its visible words and the payer's, so the fifty links of a page tell one from another ({name} the payer)
    montonioFor: "Montonios ↗ — {name}",
    courseGone: "Koolitus on kustutatud",
    // under "Laekunud" in a registration's drawer
    online: "Veebimaksed",
    // the Õpilased drawer
    noneForClient: "Makseid pole.",
  },

  // „Arved“ (invoices, phase 4 piece 2, Task 5): the registration drawer's block, the list (/admin/arved) and Seaded → „Maksmine“. The words
  // of the spec (§2, §5) are verbatim: „Arved“, „Arveta maksed“, „Koosta arve“, „Maksmiseks“, „Juba tasutud“, „Saada õpilasele“,
  // „Saada ka aadressile“, „Muuda saajat“, „Märgi tasutuks“, „Võta tasumine tagasi“, „Tühista arve“, „Laadi alla (PDF)“, „Laadi alla (CSV)“,
  // „Näidisarve (PDF)“ (the states and the paid methods are domain/invoice.ts invoiceStatusText and paidMethodText). Every other text is Draft for
  // Dim's wording sheet (the controller's rulings R3, R10 and the two refusals `bankMissing`, `paidOnline` gave their words). {number} is an
  // invoice's number, {date} dd.mm.yyyy, {amount} euros like "175,00 €", {email} an address.
  invoices: {
    title: "Arved",
    // the registration drawer's block (components/admin/InvoiceBlock.tsx)
    block: {
      none: "Sellele registreeringule pole arveid koostatud.",
      create: "Koosta arve",
      // no seller yet (D3): in place of „Koosta arve“, a link to Seaded
      needSeller: "Täida Seaded → Maksmine",
      allCovered: "Kõik summad on juba arvega kaetud.",
      // a paid online payment of the registration with no invoice yet (the final review's I1; Draft): {amount} its sum, {date} the day it was paid
      uninvoiced: "Veebimakse {amount} ({date}) on veel arveta.",
      amount: "Summa",
      kind: "Arve liik",
      forPayment: "Maksmiseks",
      forPaymentHint: "Arve on tasumata ja õpilane näeb seda oma kontol. „Märgi tasutuks“ lisab summa hiljem „Laekunud summa“ juurde.",
      alreadyPaid: "Juba tasutud",
      alreadyPaidHint: "Raha on juba kätte saadud. „Laekunud summa“ ei muutu.",
      paidDate: "Tasumise kuupäev",
      paidMethod: "Makseviis",
      submit: "Koosta arve",
      cancel: "Katkesta",
      working: "Koostan…",
      done: "Arve {number} on koostatud.",
      // the block's folded row on a phone (piece2-texts P-3; the Part 2 phone frame „Arved … 1 tasumata ▸“): {n} the invoices still unpaid
      fold: { unpaid: "{n} tasumata", paid: "kõik tasutud", none: "arveid pole" },
    },
    // one invoice with its actions (components/admin/InvoiceRow.tsx), in the drawer and on the list
    row: {
      issued: "Koostatud {date}",
      due: "Maksta kuni {date}",
      paid: "Tasutud {date} · {method}",
      // the list's meta line (the Part 2 prototype's Arved frame: „Osamakse · koostatud 20.10 · tasutud 15.10 · sularaha“, „Ettemaks 50% · maksta kuni 27.10“): {date} dd.mm
      listIssued: "koostatud {date}",
      listDue: "maksta kuni {date}",
      listPaid: "tasutud {date}",
      sent: "Saadetud {date}",
      sentAlso: "Saadetud {date} · ka aadressile {address}",
      buyer: "Saaja: {name}",
      send: "Saada õpilasele",
      editBuyer: "Muuda saajat",
      markPaid: "Märgi tasutuks",
      undoPaid: "Võta tasumine tagasi",
      cancelInvoice: "Tühista arve",
      download: "Laadi alla (PDF)",
      downloadLabel: "Laadi alla (PDF): arve {number}",
      openRegistration: "Ava registreering",
      // an unpaid invoice whose online payment is paid and waits for its catch-up (R14, the final review's m2; Draft)
      paidOnline: "Veebis tasutud — ootab „Arveta maksed“ alt arvet.",
      actionsLabel: "Arve {number} tegevused",
      close: "Katkesta",
      sendPanel: {
        to: "Kiri läheb aadressile {email}.",
        also: "Saada ka aadressile",
        alsoHint: "Valikuline, näiteks õpilase raamatupidaja. Seda aadressi ei salvestata.",
        submit: "Saada",
        sending: "Saadan…",
        sent: "Arve on saadetud.",
        secondFailed: "Õpilasele saadetud, teisele aadressile mitte.",
      },
      paidPanel: {
        date: "Tasumise kuupäev",
        method: "Makseviis",
        hint: "Summa lisatakse registreeringu „Laekunud summa“ juurde ja koht kinnitub, kui laekunud on vähemalt 50%.",
        submit: "Salvesta tasumine",
        saving: "Salvestan…",
        done: "Arve on märgitud tasutuks.",
        full: "Koolitus on vahepeal täis, nii et koht jäi kinnitamata.",
      },
      // „Veel ▾“ names itself from the number on screen, as a list has one on every row ({number}); admin UX pass, piece 2, Task 6
      moreLabel: "Veel: {number}",
      // „Võta tasumine tagasi“ as a ConfirmPanel (piece2-texts S3-f): a receipt asks the question and lists its three lines ({number} the receipt's,
      // {x} what comes off „Laekunud summa“, as euros without the sign: "175" or "50,50"; the third line only when the sum then falls under 50 %);
      // a request Maria marked paid keeps its words as they were (ruling R10), now the panel's first line under its own question (piece2-texts W2)
      undoPanel: {
        receiptQuestion: "Kas võtan kviitungi {number} tasumise tagasi?",
        requestQuestion: "Kas võtan arve {number} tasumise tagasi?",
        receiptCancelled: "Kviitung tühistatakse (number jääb alles).",
        receiptSum: "Laekunud summa väheneb {x} €.",
        receiptBack: "Registreering läheb tagasi olekusse „Ootab ettemaksu“.",
        request: "Arve muutub uuesti tasumata ja summa võetakse „Laekunud summa“ alt maha.",
        confirm: "Jah, võta tasumine tagasi",
        doneReceipt: "Kviitung on tühistatud.",
        doneRequest: "Arve on jälle tasumata.",
      },
      // „Tühista arve“ as a ConfirmPanel (piece2-texts P-11)
      cancelPanel: {
        question: "Kas tühistan arve {number}?",
        text: "Number jääb alles ja summa on uue arve jaoks jälle vaba.",
        confirm: "Jah, tühista arve",
        done: "Arve on tühistatud.",
      },
      buyerPanel: {
        name: "Nimi",
        address: "Aadress",
        company: "Ettevõtte nimi",
        companyCode: "Ettevõtte registrikood",
        companyAddress: "Ettevõtte aadress",
        hint: "Ettevõtte andmed ainult siis, kui arve tasub ettevõte. Aadress on vajalik käibemaksuarvel.",
        submit: "Salvesta saaja",
        saving: "Salvestan…",
        done: "Saaja on salvestatud.",
        errors: { required: "Täida see väli.", tooLong: "Tekst on liiga pikk.", other: "Kontrolli seda välja." },
      },
    },
    // what an action refuses with, in words (server/actions/admin-invoices.ts); `bankMissing` and `paidOnline` are the controller's
    errors: {
      notFound: "Seda arvet ei leitud. Laadi leht uuesti.",
      notUnpaid: "See arve pole enam tasumata. Laadi leht uuesti.",
      notPaid: "See arve pole tasutud. Laadi leht uuesti.",
      notManual: "Veebis tasutud arvet ei saa tagasi võtta.",
      notOpen: "See summa on vahepeal arvega kaetud. Laadi leht uuesti.",
      sellerMissing: "Täida enne Seaded → „Maksmine“.",
      bankMissing: "Täida enne Seaded → „Maksmine“ (saaja ja IBAN).",
      paidOnline: "See arve on juba veebis tasutud — koosta arve „Arveta maksed“ alt.",
      invalid: "Kontrolli andmeid. Kuupäev ei tohi olla tulevikus.",
      already: "Sellel maksel on arve juba olemas. Laadi leht uuesti.",
      notPayment: "Seda makset ei leitud. Laadi leht uuesti.",
      paymentNotPaid: "See makse pole makstud. Laadi leht uuesti.",
      cancelled: "Tühistatud arvet ei saada.",
      email: "Sisesta korrektne e-posti aadress.",
      mailFailed: "Kirja ei saadetud. Proovi uuesti.",
      server: "Midagi läks valesti. Proovi uuesti.",
    },
    // the list (/admin/arved); its heading is the one it shares with Maksed (payments.eyebrow, payments.heading) and its tab is payments.tabs.invoices
    page: {
      title: "Arved",
      lead: "Kõik arved, uuemad eespool. Veebimaksete arved tekivad ise; pangaülekannete arved koostad registreeringu juures.",
      filterLabel: "Staatus",
      all: "Kõik",
      // the month select applies on change (A6: „Näita“ is gone): its name, and the choice of every month (the address `?kuu=koik`)
      month: "Kuu",
      monthAll: "Kõik kuud",
      // S3-m (Arved); the nouns of the empty lines, P-9
      searchPlaceholder: "Otsi nime, e-posti või arve numbri järgi",
      things: "arveid",
      count: "Arveid: {n}",
      // README A6: the button names the month it will download; {month}: "oktoober 2026"
      csv: "Laadi alla (CSV) · {month}",
      list: "Arvete loend",
    },
    // „Arveta maksed“ at the top of the list: a strip (README A6, the Part 2 prototype's Arved frame; B11): paid online, no invoice yet (D3, §6.3, R13)
    uninvoiced: {
      // {n} the payments waiting
      title: "Arveta maksed: {n}",
      // the strip's summary (the prototype's „Tasutud, aga arve puudub · 1 325,00 € · Merilin Kuusk, Kati Kask, Mari Tamm ja 3 teist“): {sum} their total,
      // {names} the first payers (all of them up to four, else three and „ja {n} teist“)
      summary: "Tasutud, aga arve puudub · {sum} · {names}",
      others: "ja {n} teist",
      // P-8: the toggle of the per-row list
      show: "Näita ▸",
      hide: "Peida ▾",
      needSeller: "Täida Seaded → Maksmine",
      paidOn: "Makstud {date}",
      pays: "Tasub arve {number}",
      makes: "Koostab uue arve",
      create: "Koosta arve",
      working: "Koostan…",
      done: "Arve {number} on valmis.",
      // „Koosta {n} arvet“ (B11) and its ConfirmPanel (README A6; the n = 1 forms and the results are piece2-texts S3-l)
      bulk: { one: "Koosta 1 arve", many: "Koosta {n} arvet" },
      // the question and, after its „?“, the consequence as one line (piece2-texts P-13); {first}, {last}: the numbers the first and the last will take
      panel: {
        questionOne: "Kas koostan 1 arve?",
        questionMany: "Kas koostan {n} arvet?",
        lineOne: "Arve saab numbri {first}. Õpilasele seda ei saadeta.",
        lineMany: "Iga arve saab oma numbri ({first}–{last}). Õpilastele neid ei saadeta.",
        // a payment pays an invoice already made (its number is no part of a range): the sentence without the parenthesis
        lineManyLinked: "Iga arve saab oma numbri. Õpilastele neid ei saadeta.",
        yesOne: "Jah, koosta 1 arve",
        yesMany: "Jah, koosta {n} arvet",
      },
      result: {
        // n ≥ 2 made ({n}, {first}–{last}); one made says `done` above
        many: "Koostatud {n} arvet: {first}–{last}.",
        // some of them were invoices already made, or the numbers made are no run (an online payment took one meanwhile): no range
        manyLinked: "Koostatud {n} arvet.",
        // some had an invoice by now ({n})
        already: "Juba arvega: {n}.",
        // {names}: the payers whose invoice was not made
        failed: "Ei õnnestunud: {names}. Proovi uuesti.",
      },
      col: { date: "Kuupäev", payer: "Maksja", what: "Eest", amount: "Summa", invoice: "Arve" },
    },
    // Seaded → „Maksmine“ (components/admin/InvoiceSettings.tsx; admin UX pass piece 3b, Task 4: README B4, ruling R-f, piece3-texts P-9 and P-10): one
    // card for the bank details of the prepayment instructions and the invoice settings, its title the section's (settings.sections.payment). The lead
    // is the drawn line, then the sentence about issued invoices (they keep their frozen IBAN too); the bank fields are settings.receiver … with the
    // hint settings.prepaymentHint under Saaja and IBAN. „Arve järgmine number“ shows the preview; from 1 December the new year's first number joins it
    // on one line (P-10, the Part 4 frame: „Järgmine arve: MSL2026-007 · 1. jaanuarist: MSL2027-001“).
    settings: {
      lead: "Ühed pangaandmed ettemaksu juhistes ja arvetel. Väljastatud arve jääb selliseks, nagu see väljastati: hilisem muudatus puudutab ainult uusi arveid.",
      company: "Ettevõtte nimi",
      registryCode: "Registrikood",
      address: "Aadress",
      vatNumber: "KMKR number",
      vatNumberHint: "Täida, kui ettevõte on käibemaksukohustuslane.",
      vatOn: "Arvel on käibemaks",
      vatOnHint: "Koolituse hinnad sisaldavad käibemaksu. Arvel on siis summa käibemaksuta, käibemaks ja kokku. Vajab KMKR numbrit.",
      vatRate: "Käibemaksumäär (%)",
      prefix: "Arve numbri eesliide",
      prefixHint: "Uus eesliide alustab oma numbrit 001-st.",
      nextNumber: "Arve järgmine number",
      // P-10: {number} e.g. MSL2026-007 (001 while the typed prefix is not the stored one, R3)
      preview: "Järgmine arve: {number}",
      // admin UX pass B21: from 1 December the next year's first number; {number}: e.g. MSL2027-001
      fromJanuary: "1. jaanuarist: {number}",
      // P-10: the preview and the January line on one line
      previewLine: "{preview} · {january}",
      last: "Viimati väljastatud: {number}",
      // {year}: the year the card is about
      lastNone: "{year}. aastal pole veel arveid väljastatud.",
      termDays: "Tasumise tähtaeg (päeva)",
      termDaysHint: "Mitu päeva pärast koostamist tuleb arve tasuda.",
      footer: "Arve alumine rida",
      footerHint: "Valikuline. Trükitakse arve jalusesse.",
      bankMissing: "Saaja ja IBAN on täitmata: pangaülekande arvet ei saa koostada.",
      sample: "Näidisarve (PDF)",
      sampleHint: "Näidis tehakse kaardi praegustest väärtustest. Midagi ei salvestata.",
      // server/invoices.ts InvoiceFieldError, by field (`vatNumber` "required" is VAT on without a number; `prefix` "invalid" a character outside
      // A–Z and 0–9); `other` for a code this list does not know
      errors: {
        required: "Täida see väli.",
        tooLong: "Tekst on liiga pikk.",
        vatNumber: "Käibemaksuga arve vajab KMKR numbrit.",
        prefix: "Kasuta ainult tähti (A–Z) ja numbreid, kuni 10 märki.",
        vatRate: "Käibemaksumäär peab olema 1–50.",
        termDays: "Päevi peab olema 0–90.",
        nextSeq: "Kontrolli numbrit (1–2 147 483 647).",
        taken: "See number on juba väljastatud. Vali suurem number kui viimati väljastatud.",
        other: "Kontrolli seda välja.",
      },
    },
    // the sample PDF's stand-ins for what the card leaves empty, and its made-up course and buyer (server/invoice-sample.ts); Draft
    sample: {
      company: "(ettevõtte nimi)",
      registryCode: "(registrikood)",
      address: "(aadress)",
      receiver: "(saaja)",
      iban: "(IBAN)",
      bank: "(pank)",
      course: "Näidiskoolitus",
      session: "14.11.2026 Pärnu",
      buyer: "Näidis Ostja",
      buyerEmail: "naidis@example.test",
    },
  },

  // Contracts (contracts Task 5, spec §4): the registration drawer's block „Leping“ (components/admin/ContractBlock.tsx), the client drawer's list
  // (ClientDrawer.tsx), Seaded → „Kontaktkoolituse leping“ (components/admin/ContractTexts.tsx) and the sample PDF (server/contract-sample.ts). Verbatim from the
  // spec: „Leping“, „Lepingud“, „Kontaktkoolituse leping“, „Näidisleping (PDF)“, „Saada leping kinnitamiseks“, „Saada koopia õpilasele“,
  // „Õpilasel pole kontot — lisa ta Õpilased lehel.“, „Asendatud {date}“, „Laadi alla (PDF)“, „Tühi rida alustab uut lõiku.“ and „Kinnitamist ootab
  // (saadetud {date})“ (the brief's, Draft). Every other text below is Draft for Dim's wording sheet.
  contracts: {
    title: "Leping",
    // the registration drawer's block
    block: {
      none: "Sellele registreeringule pole lepingut.",
      // {date}: the day it was accepted; {way}: how (`via`)
      accepted: "Kinnitatud {date} · {way}",
      superseded: "Asendatud {date}",
      sent: "Saadetud õpilasele {date}",
      pending: "Kinnitamist ootab (saadetud {date})",
      noAccount: "Õpilasel pole kontot — lisa ta Õpilased lehel.",
      request: "Saada leping kinnitamiseks",
      requestHint: "Õpilane saab kirja lingiga oma kontole ja kinnitab seal praeguse lepingu teksti. Vana leping jääb alles ja märgitakse asendatuks.",
      requestDone: "Palve on õpilasele saadetud.",
      // the request is recorded, the mail was not sent (the mail is not set up here, or the address is a sample)
      requestDoneNoMail: "Palve on märgitud, aga kirja ei saadetud. Õpilane näeb seda oma kontol ka ilma kirjata.",
      sendCopy: "Saada koopia õpilasele",
      sendCopyDone: "Koopia on õpilasele saadetud.",
      download: "Laadi alla (PDF)",
      downloadLabel: "Laadi alla (PDF): leping {id}",
      working: "Saadan…",
    },
    // the drawer's folded row (admin UX pass, piece 2, Task 6; P-3, the Part 2 frames): {date} the day it was accepted; `nonePhone` is the phone frame's word
    fold: { accepted: "Kinnitatud {date}", none: "Sellele registreeringule pole lepingut", nonePhone: "puudub" },
    // how a contract was accepted (domain/contract.ts AcceptedVia), as the drawers say it
    via: {
      form: "Registreerimisvorm",
      purchase: "E-koolituse ost",
      account: "Õpilase konto",
      terms: "E-koolituse tingimuste kinnitus",
    },
    // what an action refuses with, in words (server/actions/admin-contracts.ts)
    errors: {
      notFound: "Seda registreeringut ei leitud. Laadi leht uuesti.",
      contractNotFound: "Seda lepingut ei leitud. Laadi leht uuesti.",
      noAccount: "Õpilasel pole kontot — lisa ta Õpilased lehel.",
      cancelled: "Tühistatud registreeringu lepingut ei saa kinnitamiseks saata.",
      mailFailed: "Kirja ei saadetud. Proovi uuesti.",
      // the copy can never go: a sample address (@example.test, never mailed), or no mail service here (no Resend); Draft for Dim's wording sheet
      sampleAddress: "Sellele aadressile kirja ei saadeta.",
      mailOff: "Kirjade saatmine pole siin seadistatud.",
      // the copy draws the PDF first and sends nothing without it (ruling R15; Draft)
      pdfFailed: "Lepingu PDF-i ei õnnestunud koostada — proovi uuesti.",
      server: "Midagi läks valesti. Proovi uuesti.",
    },
    // Seaded → „Lepingud ja tingimused“ → „Kontaktkoolituse leping“ (components/admin/ContractTexts.tsx; admin UX pass piece 3b, Task 5)
    settings: {
      lead: "Õpilane kinnitab registreerimisel selle lepingu teksti. Kinnitatud leping jääb selliseks, nagu see kinnitati: hilisem muudatus puudutab ainult uusi lepinguid. Kuni siia teksti pole kirjutatud, näeb õpilane lepinguna lehe „Õppetingimused“ teksti.",
      contact: "Kontaktkoolituse leping",
      // the placeholders (domain/contract.ts PLACEHOLDERS): the chips' lead, and what fills each (the chip's title; piece3-texts §3, ADM:761-768)
      placeholders: "Tekstis võid kasutada kohahoidjaid, mis täituvad lepingu kinnitamisel. Tundmatu sõna looksulgudes jääb tekstis alles.",
      placeholderMeaning: {
        nimi: "õpilase nimi",
        "e-post": "õpilase e-posti aadress",
        koolitus: "koolituse nimi",
        toimumine: "kuupäev ja koht",
        hind: "koolituse hind",
        ettemaks: "summa, mille õpilane maksab registreerimisel",
      },
      sample: "Näidisleping (PDF)",
      sampleRu: "Näidisleping vene keeles (PDF)",
      // piece3-texts P-5: the card's texts are its draft now
      sampleHint: "Näidis tehakse kaardi praegustest väärtustest, ka avaldamata. Midagi ei avaldata.",
      // the e-course contract's title (Seaded → „E-koolituse leping“): the page title is the contract's, as Maria writes it (ruling R3)
      ecourseTitleHint: "See on lepingu pealkiri õpilase kontol ja PDF-is. Soovitus: „E-koolituse leping“.",
    },
    // the sample PDF's stand-ins (server/contract-sample.ts): the student, the course and the session are made up; a text the card leaves empty is in brackets
    sample: {
      student: "Proov (näidis)",
      email: "naidis@example.test",
      course: "Näidiskoolitus",
      courseRu: "Пример курса",
      city: "Pärnu",
      title: "(lepingu pealkiri)",
      body: "(lepingu tekst)",
    },
  },

  // The course day's protocols (phase protocols, spec §4): /admin/protokollid?sessioon=<id> | ?registreering=<id> (ProtocolScreen.tsx and its
  // autosave). The status marks are spec §3's. {time} is "HH:MM" in Tallinn, {n} a count, {max} the box's limit, {date} a day and a time. The save's
  // chip is SaveStatus (admin UX pass, README A3), in `autosave`'s words.
  protocols: {
    eyebrow: "Koolituspäev",
    title: "Protokollid",
    // the entry points: the Kalender session drawer and the overview's "Täna" (open), the Registreerimised drawer (openOne)
    open: "Protokollid",
    openOne: "Ava protokoll",
    notFound: "Seda toimumist või registreeringut ei leitud, või pole see kontaktkoolitus.",
    // the way back from a session's or a registration's screen, and from its not-found card: the index (README A3, strings.md D3)
    back: "← Protokollid",
    // the index (no address parameter; admin UX pass B8): today and the 14 days before it, then the open individual registrations
    index: {
      note: "Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.",
      empty: "Viimase 14 päeva jooksul koolituspäevi polnud.",
      toCalendar: "← Kalender",
      today: "Täna",
      // {n} the listed students, {a} the sent protocols, {b} the drafts; when all are sent: allSent
      counts: "{n} õpilast · {a} saadetud · {b} mustand",
      allSent: "✓ Kõik {n} saadetud",
      open: "Ava",
      // the section's heading, in sentence case: shown in capitals (CSS)
      individual: "Individuaalkoolitused",
      // an individual registration with no protocol yet (one with a draft says `mark.draft`; its time is `registrations.agreed`)
      notStarted: "Alustamata",
    },
    individual: "Individuaalkoolitus",
    sessionCancelled: "Toimumine on tühistatud",
    hidden: "Tühistatud registreeringuid peidetud: {n}",
    empty: "Sellel toimumisel pole õpilasi.",
    cancelledOne: "Registreering on tühistatud: protokolli ei näidata ega saadeta.",
    students: "Õpilased",
    awaiting: "ootab ettemaksu",
    mark: { draft: "Mustand", sent: "Saadetud", changed: "Muudetud" },
    // on a student's chip while her text is not confirmed by the server (it is in this browser all the same)
    unsavedMark: "Salvestamata",
    practice: "Praktiline osa",
    general: "Üldised märkused",
    noStages: "Koolitusel pole protokolli punkte. Lisa need koolituse juures („Protokolli punktid“); seni on siin ainult üldised märkused.",
    // the chip's „Seda {asja} enam ei ole …“ of a registration cancelled or moved meanwhile (piece2-texts P-10)
    goneThing: "registreeringut",
    // why a send did not go: a box over its limit, signed out (the chip says these in SaveStatus' words; the line under the send button in these)
    tooLongStatus: "Salvestamata — üks tekst on liiga pikk",
    signedOut: "Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles.",
    // the browser could not keep the unsaved text (its storage full or blocked): shown on that protocol until the server has the text
    notKept: "Seda teksti ei saa selles seadmes hoida (brauseri mälu on täis või suletud). Ära sulge lehte enne, kui see on salvestatud.",
    tooLong: "Liiga pikk: {n} / {max} märki. Lühenda, siis salvestan.",
    conflict: "Seda protokolli muudeti vahepeal teises seadmes või aknas. Näed nüüd salvestatud teksti; selle ekraani salvestamata tekst on allpool.",
    conflictLost: "Selle ekraani salvestamata tekst",
    // B13 (README A3, strings.md A3-4): puts this screen's words back into their boxes and saves them over the other device's text
    restore: "Taasta minu tekst",
    dismiss: "Selge",
    locked: "Saadetud {date}. Õpilane näeb seda versiooni.",
    // the informed send, with no confirmation (README A3, strings.md A3-2): {name} is the student's first name with its ending, „Katile“,
    // „Kristjanile“ (domain/names.ts allative, S5); after a sent protocol was changed, the same with „uuesti“ (piece2-texts P-5)
    send: "Saada protokoll {name}",
    sending: "Saadan…",
    edit: "Muuda",
    resend: "Saada protokoll {name} uuesti",
    // the session screen's send of everyone with something new (README A3, strings.md A3-1): {n} is how many will get one
    sendAll: "Saada kõigile ({n})",
    // a sent protocol opened with "Muuda": the first saved edit makes it "Muudetud", which offers the send again
    editing: "Muuda teksti — salvestan ise. Siis saad selle uuesti saata.",
    // the ConfirmPanel of „Saada kõigile“ (spec §4; README A3): the question and its yes for {n} protocols, then the lines — who gets a protocol, who
    // is skipped because hers is empty, who has hers already (its „Katkesta“ is common.cancel). With none to send there is no question: `nothing`
    // and the other lines stand in the summary's place.
    confirm: {
      question: "Kas saadan {n} protokolli?",
      will: "Saavad protokolli: {names}",
      skipped: "Jäävad vahele, sest protokoll on tühi: {names}",
      already: "Juba saadetud, uut pole: {names}",
      // a student whose own "Saada" is on its way: this send leaves her alone (wording approved by Dim 13.10.2026)
      onItsWay: "Saatmine juba käib: {names}",
      // a student whose text is another device's, with its notice still open: left out until Maria has looked at it and pressed „Selge“ (wording approved by Dim 13.10.2026)
      review: "Vaata enne üle ja vajuta „Selge“: {names}",
      nothing: "Pole midagi uut saata.",
      yes: "Jah, saada {n} protokolli",
    },
    // the summary after "Saada": who got one, and per reason (sendErrors' words) who did not
    result: {
      sent: "Saadetud: {names}.",
      notSent: "Ei saadetud: {names}. {reason}",
      // the server never answered the send (a hung request, given up after SEND_TIMEOUT_MS): it may have gone through, so the screen reads the
      // server again (the marks follow), and a send again is safe — the server answers "already" for a version sent before; no button is named,
      // as a draft's reads "Saada" and a changed one's "Saada uuesti" (wording approved by Dim 13.10.2026)
      unknown: "Vastust ei tulnud: {names}. Kontrollin, kas protokollid saadeti. Juba saadetud protokolli teist korda ei saadeta.",
    },
    sendErrors: {
      empty: "Protokoll on tühi. Kirjuta midagi enne saatmist.",
      unsaved: "Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.",
      stale: "Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle.",
      cancelled: "Registreering on tühistatud: protokolli ei saadeta.",
      notFound: "Seda registreeringut ei leitud.",
      failed: "Saatmine ei õnnestunud. Proovi uuesti.",
      // a send stopped by the notice of a refusal (another device saved first): only "Selge" lets it go on (wording approved by Dim 13.10.2026)
      review: "Vaata enne saatmist üle teises seadmes tehtud muudatus ja vajuta „Selge“.",
      // the screen was an older page and the server's text is newer: it is on the screen now, and was not sent unseen (wording approved by Dim 13.10.2026)
      refreshed: "Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.",
      // the server never answered the send (given up after SEND_TIMEOUT_MS): it may have gone through, so the screen reads the server again; a send
      // again is safe; no button is named (wording approved by Dim 13.10.2026)
      timeout: "Vastust ei tulnud: kontrollin, kas protokoll saadeti. Juba saadetud protokolli teist korda ei saadeta.",
    },
  },

  // Maria's assessment of an e-course's practical work (phase e-course completion, spec §5.3; admin UX pass README A4):
  // /admin/protokollid?ligipaas=<access id>, the protocol screen with a card for each point (AssessmentScreen.tsx and its parts); the Hindamine
  // page's texts follow `screen`.
  // `screen`: {n} a count or a round, {k} the points with a verdict, {ok} / {fix} the points approved / to fix, {point} a point's number
  // (1-based), {points} a list of them, {title} a point's title, {date} a day.
  assessment: {
    screen: {
      // the header's meta line, after the course (AssessmentScreen: the round follows the screen's reads); with the day the work was sent
      // („saadetud {date}“ is `assessment.sentAt`)
      round: "Praktiline töö, {n}. kord",
      notSubmitted: "Praktiline töö: õpilane ei ole veel saatnud",
      notesOnly: "Protokoll",
      // the way back from the screen and from its not-found card (README A4, glossary „← {Lehe nimi}“)
      back: "← Hindamine",
      notFound: "Sellist e-kursuse ligipääsu ei leitud, või see on tühistatud.",
      // the protocol chip's „Seda {asja} enam ei ole …“ on an access's screen (piece2-texts P-10)
      goneThing: "ligipääsu",
      // the access has ended: Maria can still assess (spec §8); a "Paranda" round needs it extended
      expired: "Ligipääs lõppes {date}. Hinnata ja saata saad ikka; kui midagi tuleb parandada, pikenda enne ligipääsu (Õpilased).",
      status: { open: "Ootab õpilase tööd", review: "Ootab hindamist", fix: "Paranda", passed: "Kinnitatud" },
      ok: "Kinnitatud",
      fix: "Paranda",
      verdictOf: "Punkti {point} hinnang",
      photosOf: "Punkti {point} fotod",
      photoAlt: "Punkt {point}, {round}. kord, foto {n}",
      noPhotos: "Selle punkti juures fotot ei ole.",
      earlier: "Varasemad fotod",
      roundOf: "{n}. kord",
      // the full-screen photo: its name, the photo's text, where it is
      viewer: "Punkt {point}: {title}",
      viewerAlt: "{label}, foto {n}",
      viewerCount: "{n} / {of}",
      // the photo in a tab of its own, where the tablet's own viewer zooms and pans it (a draft, not on the wording sheet)
      viewerFull: "Ava täissuuruses",
      previous: "Eelmine foto",
      next: "Järgmine foto",
      close: "Sulge",
      waiting: "Hinnangu nupud avanevad, kui õpilane on töö hindamiseks saatnud. Märkusi võid kirjutada juba enne.",
      lockedPassed: "Kõik punktid on kinnitatud: hinnangud on lukus. Märkusi saad muuta ja uuesti saata.",
      // the action bar (README A4): how many points there are and how many have a verdict, „Kinnita kõik“ (every point without a verdict goes to
      // „Kinnitatud“, each as a tap), and the informed send, which has no confirmation: the summary is on the button; nothing to fix leaves out
      // „, 0 paranda“ (strings.md W4); k = 0 stays literal
      progress: "{n} punkti · {k} hinnatud",
      approveAll: "Kinnita kõik",
      send: "Saada hinnang · {ok} kinnitatud, {fix} paranda",
      sendOk: "Saada hinnang · {ok} kinnitatud",
      // the notes-only protocol's send, and a send again (of changed notes, or of a locked assessment's notes): this screen's own words (the
      // course day's protocol says „Saada protokoll {eesnimi}le“ since README A3)
      sendNotes: "Saada",
      sendAgain: "Saada uuesti",
      // a point's card: the comment box opens by itself on „Paranda“, „Lisa märkus“ opens it otherwise; the box's name is „Märkus: {title}“
      // (piece2-texts P-12); on a phone the photo opens full size by a tap (the phone prototype's hint)
      addNote: "Lisa märkus",
      pointNote: "Märkus: {title}",
      openHint: "Puuduta pilti, et avada täissuuruses.",
      // after the send
      sentFix: "Hinnang saadetud. Paranda-punktid: {points}.",
      sentPassed: "Hinnang saadetud. Kõik punktid on kinnitatud.",
      sentCompleted: "Hinnang saadetud. Koolitus on lõpetatud.",
      sentNotes: "Märkused saadetud.",
      already: "See hinnang on juba saadetud.",
      errors: {
        notSubmitted: "Õpilane ei ole tööd veel hindamiseks saatnud.",
        verdicts: "Vali hinnang ka punktidele: {points}.",
        comments: "Lisa märkus Paranda-punktidele: {points}.",
        unsavedVerdicts: "Kõik hinnangud ei ole veel salvestatud. Proovi uuesti, kui ühendus on tagasi.",
        verdictRefused: "Hinnangut ei salvestatud: töö seis muutus vahepeal. Vaata punktid üle.",
        // a tap or "Saada hinnang" named an older round than the server's: the screen reads the new round and shows it, nothing was stored or sent
        newRound: "Õpilane saatis vahepeal uue korra. Vaata see üle.",
        notFound: "Seda ligipääsu enam ei ole (see on tühistatud).",
      },
    },
    // "Hindamine" (spec §5.2, admin UX pass A4): /admin/hindamine, what waits for Maria as one list, oldest first. {n} a count or a number, {max}
    // the tries she has, {date} a day and a time ("20.10 18:35"), {best} a percent, {attempts} a count. The row's first line is
    // "{name} · {kind}" (README A4, A4-5), its second line `meta` (the prototype's, P-6 for the third kind). `tabs`: the tab pills of Hindamine and
    // Tunnistused; the first one carries the count of the list as the pill's count bubble.
    eyebrow: "E-õpe",
    title: "Hindamine",
    lead: "Mis ootab sinu hinnangut, vanemad eespool: praktilised tööd, testide avatud vastused ja õpilased, kelle testikatsed on otsas.",
    empty: "Hindamist ootavaid töid pole.",
    tabs: { waiting: "Ootab hindamist", certificates: "Tunnistused" },
    row: "{name} · {kind}",
    kinds: { practical: "praktiline töö", test: "testi vastus", triesUsed: "katsed otsas" },
    meta: { practical: "{n}. kord · {date}", test: "katse {n}/{max} · {date}", triesUsed: "parim tulemus {best} % · katseid {attempts}" },
    // the test review's pages (Hindamine/test): the try and the day, as they were
    sentAt: "saadetud {date}",
    tryOf: "Katse {n}/{max}",
    assess: "Hinda",
    attempts: "Testi katsed",
    // the test review (spec §5.4): /admin/hindamine/test?id=<attempt>, and every attempt of a student, ?ligipaas=<access>. {percent} and
    // {pass} percentages, {text} Maria's earlier comment
    review: {
      back: "Hindamine",
      notFound: "Seda katset ei leitud.",
      notFoundAccess: "Selle õpilase teste ei leitud.",
      score: "Valikküsimused: {percent} % (vaja {pass} %)",
      right: "Õige",
      wrong: "Vale",
      pickedRight: "valis, õige",
      pickedWrong: "valis, vale",
      missed: "õige, jäi valimata",
      noAnswer: "Vastust pole.",
      verdictLabel: "Hinnang vastusele {n}",
      ok: "Kinnitatud",
      fix: "Paranda",
      comment: "Kommentaar",
      commentHint: "„Paranda“ vajab kommentaari: õpilane näeb seda oma vastuse juures.",
      previous: "Eelmine kommentaar: {text}",
      notReviewed: "Hindamata",
      // the informed send, with the summary on the button (README A4, strings.md W3): {ok} the answers marked „Kinnitatud“, {fix} the ones marked
      // „Paranda“; „, 0 vale“ is dropped when nothing is to fix (piece2-texts P-6; the practical work's send does the same), õ = 0 stays literal
      send: "Saada · {ok} õige, {fix} vale",
      sendOk: "Saada · {ok} õige",
      sending: "Saadan…",
      // the marks autosave to the server (B15): the chip's „Seda {asja} enam ei ole …“ when the attempt is gone (piece2-texts P-10), and the
      // conflict's „Taasta minu tekst“ (README §1.3, B13), which saves this screen's marks over the other device's
      goneThing: "katset",
      restore: "Taasta minu tekst",
      sent: {
        passed: "Saadetud: test on sooritatud. Õpilane saab kirja.",
        fix: "Saadetud: õpilane parandab „Paranda“ vastused. Ta saab kirja.",
        completed: "Saadetud: test on sooritatud ja koolitus lõpetatud. Õpilane saab kirja.",
      },
      // under one answer, before anything is sent
      problems: { verdict: "Vali „Kinnitatud“ või „Paranda“.", comment: "Kirjuta, mida parandada.", tooLong: "Liiga pikk: {n} / {max} märki." },
      // above "Saada": the form's own check, then the server's answers
      errors: {
        incomplete: "Hinda iga vastus ja kirjuta igale „Paranda“ vastusele kommentaar.",
        comment: "Kirjuta igale „Paranda“ vastusele kommentaar.",
        tooLong: "Üks kommentaar on liiga pikk.",
        // stale: reviewed meanwhile (on her other device), or the student rewrote her "Paranda" answers after this page was read; nothing was
        // stored, and the reload shows the answers as they are now
        stale: "Seda katset on vahepeal hinnatud või õpilane muutis pärast selle lehe avamist vastuseid. Laadi leht uuesti, et näha praeguseid vastuseid.",
        notFound: "Seda katset ei leitud. Laadi leht uuesti.",
        failed: "Saatmine ei õnnestunud. Proovi uuesti.",
      },
      status: { failed: "Läbimata", review: "Ootab hindamist", fix: "Parandamisel", passed: "Sooritatud" },
      list: "Testi katsed",
      view: "Vaata",
      noAttempts: "Katseid pole veel.",
      percent: "{n} %",
    },
    // "Ava test uuesti" (spec §5.2, §5.5): the course's tries once more, asked with a ConfirmPanel (piece 1; P-13: the old question split at the
    // "?" into the question and the one line of what follows, "Jah, ava" as it was, „Katkesta“ is the panel's own)
    reopen: {
      button: "Ava test uuesti",
      question: "Kas avan testi „{course}“ uuesti?",
      line: "Õpilane saab sama palju katseid juurde ja kirja.",
      yes: "Jah, ava",
      // the status line, said with the student's name (piece2-texts W3): {name} as written, {n} the tries she has now
      done: "Test uuesti avatud: {name}, katseid jäänud {n}.",
      notNeeded: "Test on juba avatud.",
    },
  },

  // Tagasiside (phase protocols, spec §7): the answers to the course feedback form. /admin/tagasiside, ?koolitus=<course id> (the filter),
  // ?leht=<n>, ?id=<answer> (the drawer). The questions and options are the form's own words (et.ts account.feedback), never written here.
  // {n} a count, {score} an average ("7,5"), {date} a day and a time.
  feedback: {
    eyebrow: "Õpilased",
    title: "Tagasiside",
    lead: "Õpilaste vastused koolituse tagasiside vormile, uuemad eespool. Vali koolitus, et näha selle keskmist hinnet ja iga vastusevariandi arvu.",
    filterLabel: "Koolitus",
    all: "Kõik koolitused",
    byCourse: "Koolituste kaupa",
    count: "Vastuseid: {n}",
    scored: "Hindeid: {n}",
    average: "Keskmine hinne: {score} / 10",
    noScore: "Hinnet pole antud",
    empty: "Tagasisidet pole veel antud.",
    // the answers' search (admin UX pass piece 4c, S4-40): it stays beside the course select. A selection with no answer is the list frame
    // (lists.emptyFiltered „Selle valikuga vastuseid pole.“, lists.emptySearch „„{q}“ järgi vastuseid ei leitud.“) with „Tühjenda otsing ja filtrid“; `things` is its word
    searchPlaceholder: "Otsi nime või e-posti järgi",
    things: "vastuseid",
    col: { date: "Kuupäev", student: "Õpilane", course: "Koolitus", score: "Hinne", answers: "Vastuseid", average: "Keskmine hinne" },
    drawer: { label: "Tagasiside: {name}", notFound: "Seda tagasisidet ei leitud." },
    submitted: "Saadetud {date}",
    inRussian: "Vastas vene keeles",
    // the drawer's ways on (S4-41): the review of this answer (only when it has one; Arvustused, at its card) beside the student and the registration
    toReview: "Vaata arvustust →",
    toStudent: "Ava õpilane →",
    toRegistration: "Ava registreering →",
    // an e-course's answer has no course day: the day her access was completed stands in its place (student reviews, Task 4; the spec's words)
    completed: "Lõpetatud {date}",
    // the page's two views (Draft): the answers, and the reviews (below, `reviews`); ?vaade=arvustused. The phone's reviews tab carries the count of
    // the reviews waiting for Maria (admin UX pass piece 4c, S4-35; at 0 it is `reviews`): the pills with counts replaced the heading's count
    viewsLabel: "Vaade",
    views: { answers: "Vastused", reviews: "Arvustused", reviewsWaiting: "Arvustused · Ootab {n}" },
    // the Õpilased and Registreerimised drawers
    section: "Tagasiside",
    none: "Tagasisidet pole antud.",
    // the registration drawer's folded row when she has given none (P-3, the Part 2 frame); given: `submitted`
    foldNone: "pole antud",
  },

  // Arvustused (student reviews, Task 4; spec D2, D4, §4, §5): the second view of Tagasiside, /admin/tagasiside?vaade=arvustused, ?olek=ootel|avaldatud|peidetud
  // (the status filter). Maria decides each review: „Avalda“, „Peida“ and the „Avalehel“ toggle; a student's words are never edited; „Lisa arvustus“ adds one
  // she received elsewhere, which she can edit and delete. Quoted from the spec as they are: „Arvustused“, the three statuses („Ootab kinnitust“,
  // „Avaldatud“, „Peidetud“), „Avalda“, „Peida“, „Avalehel“, „Lisa arvustus“, „Kust see pärit on?“, „Lisa ainult päris õpilase sõnad tema loal.“,
  // „Nimi, mida näidatakse“ and the `gone` answer. Every other text here is a Draft for Dim's wording sheet.
  // {n} a count, {max} a limit, {date} a day, {name} a name, {status} a status, {protocol} a protocol line, {note} her note.
  // Admin UX pass piece 4c (C6; piece4-texts S4-35 … S4-39): review cards, the pills with counts and no „Kõik“, the instant „Avalda“ / „Peida“ and the
  // soft „Kustuta“ with their UndoBars (no confirming step), „Lisa arvustus +“ in the page header opening a drawer, „Muuda“ an autosave drawer.
  reviews: {
    title: "Arvustused",
    lead: "Õpilaste sõnad, mida nad lubasid avaldada, ja arvustused, mille oled ise lisanud. Õpilase teksti ei saa muuta: saad selle avaldada või peita.",
    // the page header's ink button (S4-35); the drawer's create button is `form.create`, without the „+“ (P3T P-6)
    add: "Lisa arvustus +",
    // the status pills' row (S4-36: each status with its count, no „Kõik“)
    filterLabel: "Olek",
    status: { pending: "Ootab kinnitust", published: "Avaldatud", hidden: "Peidetud" },
    empty: "Arvustusi pole veel.",
    // the list frame's word (lists.emptyFiltered: S4-36 „Selle valikuga arvustusi pole.“ + „Tühjenda otsing ja filtrid“)
    things: "arvustusi",
    language: "Keel: {locale}",
    // the proof of a student's review (D2): what Maria judges by whether the writer took part
    proof: { registration: "Registreering: {status} · {protocol}", protocolSent: "Protokoll saadetud", protocolNotSent: "Protokolli pole saadetud" },
    manual: "Lisatud käsitsi",
    source: "Allikas: {note}",
    publish: "Avalda",
    hide: "Peida",
    featured: "Avalehel",
    // (the final review's M3) Draft: the quiet hint near the toggles ({n} is HOME_REVIEWS_MAX), and the tag of a hidden review whose „Avalehel“ is still set (its title)
    homeHint: "Avalehel näidatakse kuni {n} uusimat.",
    featuredKept: "Peidetud, aga avalehe valik jääb: „Avalda“ toob selle avalehele tagasi.",
    edit: "Muuda",
    delete: "Kustuta",
    // the buttons' names for a screen reader: the button's own words first, then whose review it is
    label: "{action}: {name}",
    working: "Salvestan…",
    // the UndoBars (S4-38); „Avalehel“ has none. A refused „Võta tagasi“ says `errors.changed`
    bar: { published: "Arvustus avaldatud.", hidden: "Arvustus peidetud.", removed: "Arvustus kustutatud." },
    // the drawer of a student (Õpilased): whether she allowed publishing and what became of it
    drawer: { allowed: "Lubab avaldada: {status}", allowedFeatured: "Lubab avaldada: {status}, avalehel", notAllowed: "Avaldamise luba pole antud.", open: "Ava arvustused" },
    // the „Lisa arvustus +“ drawer (S4-39: its header is courseEditor.newRequired / newReady, the cancel common.cancel „Katkesta“, the leave guard's reason
    // „{newThing} pole veel lisatud.“) and the „Muuda“ drawer (ADM:1138 `editTitle`; its SaveStatus' gone word, S4-4, says `thing`)
    form: {
      newTitle: "Uus arvustus",
      create: "Lisa arvustus",
      newThing: "Arvustust",
      editTitle: "Muuda arvustust",
      thing: "arvustust",
      warning: "Lisa ainult päris õpilase sõnad tema loal.",
      course: "Koolitus",
      chooseCourse: "Vali koolitus",
      name: "Nimi, mida näidatakse",
      text: "Arvustuse tekst",
      writtenAt: "Kirjutamise kuupäev",
      locale: "Arvustuse keel",
      localeOptions: { et: "Eesti keel", ru: "Vene keel" },
      note: "Kust see pärit on?",
      noteHint: "Ainult sinule: avalikul lehel seda ei näidata.",
      count: "{n} / {max}",
      errors: { required: "Täida see väli.", tooLong: "Tekst on liiga pikk.", invalid: "Kontrolli seda välja." },
    },
    // what an action answers when it did not go through
    errors: {
      gone: "Seda arvustust enam pole — õpilane võttis loa tagasi.",
      notPublished: "Avalehel saab olla ainult avaldatud arvustus.",
      manualGone: "Seda arvustust enam pole.",
      notManual: "Õpilase sõnu ei saa muuta ega kustutada. Kui ei taha neid näidata, peida arvustus.",
      // (piece 4c, S4-38) „Võta tagasi“ of „Avalda“ / „Peida“ refused: the review moved since the press (another tab, „Avalehel“, an edit)
      changed: "Arvustust muudeti vahepeal. Vaata see üle.",
      server: "Salvestamine ei õnnestunud. Proovi uuesti.",
    },
  },

  requests: {
    eyebrow: "Postkast",
    title: "Päringud",
    lead: "Kontaktivormi sõnumid, individuaalõppe soovid, praktikataotlused, ootenimekiri ja õpilaste tühistamise või ajamuutmise soovid. Tehtud päringud jäävad nimekirja lõppu.",
    // the toolbar (README A7, B7): the search runs across every tab, so a result carries its tab's tag; the tabs are the toolbar's pill row, each
    // with the number of requests still open (the same numbers as the menu badge)
    searchPlaceholder: "Otsi nime, e-posti või telefoni järgi",
    tabsLabel: "Päringu liik",
    tabs: { kontakt: "Kontakt", individuaal: "Individuaal", praktika: "Praktika", ootenimekiri: "Ootenimekiri", muutmine: "Muutmine" },
    // what the list is of, in a sentence (ListEmpty: „Selle valikuga päringuid pole.“, „„{q}“ järgi päringuid ei leitud.“, piece2-texts P-9)
    things: "päringuid",
    interest: "E-õppe huvi",
    // the state words of the Õpilased drawer's „Päringud“ fold (the cards show their state by where they stand: in the list or in the fold)
    handled: "Tehtud",
    open: "Uus",
    markDone: "Märgi tehtuks",
    markOpen: "Märgi tegemata",
    // the UndoBar after „Märgi tehtuks“ (the fold's „Märgi tegemata“ is its own reverse: no bar, piece2-texts P-14)
    markedDone: "Märgitud tehtuks.",
    // „Märgi tehtuks“ / „Märgi tegemata“ or its undo refused because another device changed the request meanwhile; the page has refreshed (piece2-texts W7)
    stale: "Päringut muudeti vahepeal. Vaata see üle.",
    // the fold at the bottom: „Tehtud ({n}) ▸“
    doneFold: "Tehtud",
    received: "Saabunud {date}",
    // „Vasta e-kirjaga ↗“ opens her mail with the subject filled in (account.mail.reply, an outgoing text); the phone card has the short words
    reply: "Vasta e-kirjaga ↗",
    replyShort: "Vasta ↗",
    openSession: "Ava toimumine →",
    openRegistration: "Ava registreering →",
    // the card's message, for the cart's „let me know“ (a request with no message of its own): the course she looked at (Part 2 prototype)
    interestMessage: "Huvi: {course}",
    // the muted facts line under the message (piece2-texts S3-j): parts joined with " · "; a labelled part is „{label}: {value}“
    fact: "{label}: {value}",
    facts: { russian: "Vastus vene keeles", cart: "Ostu ei lõpetanud · ostukorvist" },
    // the labels of the facts line
    fields: {
      completedCourse: "Läbitud koolitus",
      package: "Pakett",
      times: "Sobivad ajad",
      period: "Soovitud periood",
      session: "Toimumine",
      modelHelp: "Vajab abi modelli leidmisel",
      account: "Soovib kontot",
    },
    unknownSession: "toimumine #{id}",
    // Muutmine: a student's wish from her account (the card's "Tühista või muuda aega"), the first part of the card's facts line
    wish: { cancel: "Soovib tühistada", change: "Soovib muuta aega" },
    unknownRegistration: "Registreerimine #{id} (ei leitud)",
  },

  // Õpilased (phase 2a): everybody with an account, their courses, e-course access and a read-only look at their account page.
  clients: {
    eyebrow: "Kontaktõpe ja e-õpe",
    title: "Õpilased",
    lead: "Kõik, kellel on konto. Ava õpilane, et näha tema koolitusi ja avada talle e-koolitus.",
    typeLabel: "Õppevorm",
    // the form pills, each with its count (README A5)
    type: { all: "Kõik", e: "E-õpe", k: "Kontaktõpe" },
    // the toolbar (README A5, B7): the search as she types, over the name, the e-mail and the phone; there is no „Otsi“ button
    searchPlaceholder: "Otsi nime, e-posti või telefoni järgi",
    count: "Õpilasi: {n}",
    // what the list is of, in a sentence (ListEmpty: „Õpilasi veel pole.“, „Selle valikuga õpilasi pole.“, P-9)
    things: "õpilasi",
    col: { name: "Nimi ja e-post", created: "Lisatud", courses: "Koolitusi" },
    // what "Koolitusi" counts: the column header's title and its description (README A5)
    coursesHint: "Koolitusi: tema registreerimised (tühistatuid arvestamata) ja e-koolitused (lõpetatud ligipääse arvestamata, aegunuid arvestatakse).",
    open: "Ava {name}",
    add: {
      // the header button that opens the small form (README A5)
      toggle: "Lisa õpilane +",
      label: "Lisa õpilane e-posti järgi",
      button: "Lisa õpilane",
      hint: "Nt e-koolituse ostja, kes pole veel sisse loginud. Kui õpilane on juba olemas, avaneb tema kaart.",
      invalid: "Sisesta korrektne e-posti aadress.",
      // an obvious typo in a common domain asks first (the login page's words)
      typo: "Kas mõtlesid {fixed}?",
      typoYes: "Jah, paranda",
      typoNo: "Ei, lisa nii",
    },
    drawer: {
      label: "Õpilane: {name}",
      notFound: "Seda õpilast ei leitud.",
      noName: "Nimi puudub",
      created: "Konto loodud {date}",
      // her address's newsletter (phase 2c)
      newsletter: "Uudiskiri: {state}",
      newsletterStates: { yes: "jah", pending: "ootab kinnitust", no: "ei" },
      phone: "Telefon",
      locale: "Keel",
      viewAs: "Vaata tema vaadet",
      // one list: her e-course accesses and her registrations, newest first (README A5); the empty list reads as the lists do („Koolitusi veel pole.“)
      courses: "Koolitused",
      coursesThing: "Koolitusi",
      // a card's pill: „Läbitud“ (completed, also when the access ran out since), „Ligipääs lõppes“ (ran out by date, S3-h), „Ligipääs lõpetatud“ (ended by an admin)
      state: { active: "Avatud kuni {date}", completed: "Läbitud {date}", expired: "Ligipääs lõppes {date}", revoked: "Ligipääs lõpetatud {date}" },
      grantedBy: "Avas {who}, {date}",
      // an access a paid e-course purchase opened (granted_by "payment", phase 2b)
      byPayment: "veebimakse",
      // the card of a registration: its action (the phone's shorter words are drawn: „Registreering“, „Protokoll“)
      openRegistration: "Ava registreering",
      openRegistrationShort: "Registreering",
      openProtocolShort: "Protokoll",
      // the trigger of an access card's „Veel ▾“ is named by the course (the drawn text is „Veel“)
      moreLabel: "Veel: {course}",
      requests: "Päringud",
      noRequests: "Päringuid pole.",
      openRequests: "Vaata päringutes",
      // her contracts, the contact course's and the e-course's (contracts Task 5; it replaces the list of the e-course terms she accepted, which a
      // purchaser is not on): Draft but „Lepingud“
      contracts: "Lepingud",
      noContracts: "Lepinguid veel pole.",
    },
    grant: {
      // the folded row at the end of the drawer (README A5, Part 2 prototype): „Ava ligipääs e-koolitusele“ and its one-line summary
      fold: "Ava ligipääs e-koolitusele",
      foldSummary: "vali koolitus",
      title: "Ava ligipääs",
      course: "E-koolitus",
      // the course select's lines: „{course} · mustand · avatud kuni {date}“ (README A5)
      draft: "mustand",
      // a course she can open now (granting it again moves the day)
      openUntil: "avatud kuni {date}",
      until: "Ligipääs kuni",
      untilHint: "Täidetud koolituse ligipääsu kestusega tänasest. Võid muuta.",
      untilHintDefault: "Koolitusel pole kestust määratud — täidetud {n} kuuga. Võid muuta.",
      button: "Ava ligipääs",
      done: "Ligipääs on avatud.",
      noCourses: "E-koolitusi pole. Lisa esmalt koolitus õppevormiga „E-õpe“.",
      courseError: "Vali e-koolitus.",
      date: "Vali tänane või hilisem kuupäev.",
      notFound: "Seda õpilast ei leitud. Laadi leht uuesti.",
    },
    // „Pikenda ▾“ on an e-course access (README A5, B12; piece 2 texts S3-h, S3-i): +1 kuu / +3 kuud / +6 kuud from the later of the current end and today, or
    // „Kuupäev…“ (a field, „Ligipääs kuni“ + „Pikenda“ + „Katkesta“). It applies at once; the UndoBar says `done`. The menu's title names the end: „praegu kuni“
    // while it is open, „lõppes“ once it ran out (S3-h). `buttonLabel` names the trigger by the course, as „Veel: …“ does.
    extend: {
      button: "Pikenda",
      buttonLabel: "Pikenda: {course}",
      titleOpen: "Pikenda ligipääsu (praegu kuni {date})",
      titleExpired: "Pikenda ligipääsu (lõppes {date})",
      plus1: "+1 kuu",
      plus3: "+3 kuud",
      plus6: "+6 kuud",
      pickDate: "Kuupäev…",
      until: "Ligipääs kuni",
      submit: "Pikenda",
      date: "Vali kuupäev, mis on hilisem kui praegune lõpp.",
      done: "Ligipääs pikendatud kuni {date}.",
      // a pick or its undo refused because the end moved meanwhile; the page has refreshed (piece2-texts W6)
      stale: "Ligipääsu lõpp muutus vahepeal. Vaata kuupäev üle.",
    },
    // „Lõpeta ligipääs“ under „Veel ▾“ asks with a ConfirmPanel (P-13): the question, the consequence, „Jah, lõpeta“ and „Katkesta“
    revoke: {
      button: "Lõpeta ligipääs",
      question: "Kas lõpetan ligipääsu koolitusele „{course}“?",
      line: "Õpilane ei saa seda enam avada.",
      yes: "Jah, lõpeta",
    },
    // "Ava järgmine õppetund" under „Veel ▾“: the student's first lesson she cannot open yet, opened for her (a ConfirmPanel, P-13)
    unlock: {
      button: "Ava järgmine õppetund",
      question: "Kas avan õpilasele õppetunni „{lesson}“?",
      line: "Ta saab selle kohe vaadata.",
      yes: "Jah, ava",
      done: "Õppetund „{lesson}“ on avatud.",
    },
    // the card's line about each e-course access (e-course completion, spec §5.5; P-7: the prototype's, no colons): {done}/{total} her lessons, {state} a
    // step's state in the words below, {percent} her newest test score. The phone's line is shorter („3/3 · test läbitud · praktiline ootab“): the same
    // steps, ' hindamist' dropped from the states. A completed course has no line (its pill says „Läbitud {date}“)
    steps: {
      lessons: "Õppetunnid {done}/{total}",
      test: "Test {state}",
      testScore: "Test {state} ({percent} %)",
      practical: "Praktiline töö {state}",
      lessonsShort: "{done}/{total}",
      testShort: "test {state}",
      practicalShort: "praktiline {state}",
      testStates: { locked: "lukus", open: "avatud", review: "ootab hindamist", fix: "parandamisel", done: "läbitud", used: "katsed otsas" },
      practicalStates: { locked: "lukus", open: "avatud", review: "ootab hindamist", fix: "parandamisel", done: "kinnitatud" },
    },
    // the protocol of an e-course access (?ligipaas=) or of a contact registration (?registreering=): "Lisa" before its first save, then "Ava"
    addProtocol: "Lisa protokoll",
    openProtocol: "Ava protokoll",
    // her test attempts (/admin/hindamine/test?ligipaas=), once she has one
    attempts: "Testi katsed",
  },

  // The e-course certificate (phase 3d, spec §6): Seaded → "Tunnistus" (components/admin/CertificateSettings.tsx), the Õpilased drawer's line,
  // "Paranda nimi" and the register /admin/tunnistused.
  certificates: {
    settings: {
      title: "Tunnistus",
      lead: "Need andmed lähevad igale uuele e-kursuse tunnistusele. Väljastatud tunnistus jääb selliseks, nagu see väljastati; ainult koolitaja nimi, mis on tunnistusel allkirjaks, on igal allalaadimisel praegune.",
      place: "Koht",
      placeHint: "Kuupäeva ees, nt Pärnu linn.",
      registryCode: "Registrikood",
      practicalLine: "Praktilise töö rida",
      practicalLineHint: "Tunnistuse allservas vasakul, suurtähtedega.",
      trainerName: "Koolitaja nimi",
      trainerNameHint: "Allkiri tunnistusel: see nimi kirjutatakse käekirjas alla paremale. Ladina tähtedega.",
      nextNumber: "Järgmine number",
      nextYear: "Aasta",
      nextSeq: "Number",
      nextHint: "Jätka oma paberil tunnistuste numbreid. Uue aasta esimene tunnistus saab numbri 1.",
      last: "Viimati väljastatud: {number}",
      // {year}: the year the card is about (the next number's year: this year, or the later year of Maria's preset)
      lastNone: "{year}. aastal pole veel tunnistusi väljastatud.",
      // admin UX pass piece 3b, P-10: {number} e.g. MS LAB 2026-93 (formatCertificateNumber: two digits at least)
      preview: "Järgmine tunnistus: {number}",
      // server/certificates.ts CertificateFieldError (`letters` and `length` are the name rules' refusals of the trainer's name); `other` for a
      // code this list does not know. "invalid" on the year (not this Tallinn year or the next) has its own words, `year`; on the number, `invalid`
      errors: {
        required: "Täida see väli.",
        tooLong: "Tekst on liiga pikk.",
        invalid: "Kontrolli numbrit (1–99 999).",
        year: "Aasta peab olema käesolev või järgmine.",
        taken: "See number on juba väljastatud. Vali suurem number kui viimati väljastatud.",
        letters: "Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).",
        length: "Nimi on liiga lühike.",
        other: "Kontrolli seda välja.",
      },
    },
    // the Õpilased drawer's line about an access's certificate (components/admin/ClientDrawer.tsx); {date}: dd.mm.yyyy in Tallinn
    drawer: {
      line: "Tunnistus {number} · {date}",
      reissued: "nimi parandatud {date}",
      name: "Nimi tunnistusel: {name}",
      download: "Laada alla",
      downloadLabel: "Laada alla tunnistus {number}",
      notYet: "Tunnistus: õpilane pole veel nime kinnitanud",
      revoked: "ligipääs tühistatud",
    },
    // "Paranda nimi" (components/admin/ReissueCertificate.tsx): the student's rules, the same number, no mail
    reissue: {
      button: "Paranda nimi",
      label: "Nimi tunnistusel",
      hint: "Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta.",
      save: "Väljasta uuesti",
      cancel: "Katkesta",
      done: "Tunnistus {number} on uuesti väljastatud nimega {name}.",
      errors: {
        length: "Nimi peab olema 2–80 tähemärki pikk.",
        letters: "Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).",
        notFound: "Seda tunnistust ei leitud. Laadi leht uuesti.",
      },
    },
    // /admin/tunnistused, the second tab of Hindamine (assessment.tabs; the tab pills are on both pages, A4)
    register: {
      eyebrow: "Hindamine",
      title: "Tunnistused",
      lead: "Kõik väljastatud e-kursuse tunnistused, uusimad eespool.",
      count: "Tunnistusi: {n}",
      empty: "Tunnistusi pole veel väljastatud.",
      col: { number: "Number", name: "Nimi", course: "Koolitus", issued: "Väljastatud", file: "Tunnistus" },
      // the re-issue note, the "ligipääs tühistatud" mark and the download link are the drawer's (certificates.drawer.reissued, .revoked, .download, .downloadLabel)
      openStudent: "Ava õpilane {name}",
    },
  },

  // Järelmaks (Inbank) (instalments, spec D4): Seaded → „Järelmaks (Inbank)“ (components/admin/FinancingSettings.tsx), Maria's toggle, off by default.
  // Every text is a Draft (Dim sees them on the test page).
  financing: {
    settings: {
      title: "Järelmaks (Inbank)",
      enabled: "Paku järelmaksu (Inbank)",
      lead: "Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.",
    },
  },

  // /admin/opilased/<id>/vaade: the student's own "Minu koolitused", read-only
  viewAs: {
    title: "Õpilase vaade",
    courseTitle: "Õpilase vaade: e-koolitus",
    banner: "Vaatad kliendi {nimi} vaadet — muuta ei saa",
    back: "Tagasi",
    backLabel: "Tagasi õpilase juurde",
    notFound: "Seda õpilast ei leitud.",
    // one e-course's view: the student may exist, but have no open access to that course (ended, run out, never given)
    courseNotFound: "Seda vaadet ei leitud.",
    toList: "Õpilaste juurde",
  },

  // Content fields in two languages (I18nInput, ListEditor). RU may stay empty: the public site then shows the ET text,
  // and only the admin sees "tõlge tulekul". One page-level switch („Sisu keel“, EditLang.tsx LangSwitch) sets the language of every field
  // (README §1.9); the previews follow it (piece 4b: the last preview's own switch went with the old Hüpikaken).
  i18n: {
    lang: { et: "ET", ru: "RU" },
    langName: { et: "eesti keeles", ru: "vene keeles" },
    contentLang: "Sisu keel",
    // beside the switch in RU mode, while fields have Estonian text and no Russian: „RU puudub 3 väljal“ and the jump to the next of them
    ruMissing: "RU puudub {n} väljal",
    next: "Järgmine →",
    // in RU mode, above a field: the Estonian text with this tag; an empty RU field offers the copy
    etTag: "ET",
    copyFromEt: "Kopeeri eesti keelest",
    missing: "tõlge tulekul",
    missingHint: "Venekeelne tekst puudub: vene lehel on seni näha eestikeelne.",
  },

  // ListEditor and ProtocolStagesEditor (outcomes, „Koolitus sisaldab“, protocol points, certificate lines, Praktika's items): the row's ↑ / ↓ are
  // DragList's (drag.upRow, drag.downRow); `removed` is the UndoBar's line after × (piece 3 texts S3-P3-d)
  list: {
    add: "Lisa rida",
    remove: "Eemalda rida {n}",
    removed: "Rida eemaldatud.",
    empty: "Ridu veel pole.",
  },

  // DragList (the B screens, piece 3 texts S3-P3-m; README B1 `aria-roledescription="lohistatav"`): the handle's name and what a screen reader hears after
  // a move, by name (`name`: the course or module) or, for a row with no name of its own, by number (`n`: the row's number, `k`: the new place).
  // The arrows' names are `up`, `down` (by name: the course list, the module rows) and `upRow`, `downRow` (by number: the list editors' „Liiguta rida {n} üles“).
  drag: {
    roleDescription: "lohistatav",
    handle: "Lohista: {name}",
    handleRow: "Lohista rida {n}",
    up: "Liiguta üles: {name}",
    down: "Liiguta alla: {name}",
    upRow: "Liiguta rida {n} üles",
    downRow: "Liiguta rida {n} alla",
    moved: "„{name}“ on nüüd {k}. kohal.",
    movedRow: "Rida {n} on nüüd {k}. kohal.",
  },

  // SectionMap (the B screens, README B2; the Part 3 and 4 prototypes): the list of links beside a long editor page and, below 1180 px, the select
  // „Jaotised ▾“ in its place, which shows „Jaotised · Põhiinfo“. `join` is what stands between those two and between a count and a flag („6 · RU puudub“).
  sectionMap: {
    label: "Jaotised",
    join: " · ",
    ru: "RU puudub",
    check: "Kontrolli",
    // Seaded's „Lepingud ja tingimused“ (piece3-texts P-11, drawn „1 avaldamata“): how many of its texts have an unpublished change
    unpublished: "{n} avaldamata",
  },

  // The admin's lists (admin UX pass, README §1.10; components/admin/ListToolbar.tsx and ListStates.tsx): the sentence frames the pages fill with
  // their own word for the things in the list: {Asju} capitalised („Registreerimisi“), {asju} as it stands in a sentence („registreerimisi“).
  lists: {
    empty: "{Asju} veel pole.",
    emptyFiltered: "Selle valikuga {asju} pole.",
    // a search with no hit (the typed text in the quotes; piece 2 texts P-9, drawn for registreerimisi in the prototype)
    emptySearch: "„{q}“ järgi {asju} ei leitud.",
    clearAll: "Tühjenda otsing ja filtrid",
    // the ✕ in the search field
    clearSearch: "Tühjenda otsing",
    count: "{Asju}: {n}",
  },

  // ImageUpload: the browser makes the image smaller (≤ 2400 px) and saves it anew, which drops the camera data.
  upload: {
    choose: "Lisa pilte",
    chooseOne: "Vali pilt",
    hint: "JPEG, PNG või WebP. Enne üleslaadimist vähendatakse pilt kuni 2400 pikslini ja kaamera andmed (asukoht jm) eemaldatakse.",
    preparing: "Valmistan pilti ette…",
    uploading: "Laen üles… ({n}/{total})",
    queued: "Lisasin järjekorda {n} pilti (kokku {total}).",
    doneOne: "Pilt lisatud.",
    doneMany: "Lisatud {n} pilti.",
    type: "Seda faili ei saa kasutada. Vali JPEG-, PNG- või WebP-pilt.",
    size: "Pilt on liiga suur (kuni 4 MB).",
    decode: "Pilti ei õnnestunud avada. Proovi teist faili.",
    session: "Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti.",
    storage: "Piltide salvestamine pole seadistatud — anna arendajale teada.",
    server: "Üleslaadimine ei õnnestunud. Proovi uuesti.",
  },

  // Prototype D adminBadges ("Koolituse märgis"), Maria C36: "Väga meeldib see blokk. Jätame."
  badge: {
    title: "Koolituse märgis",
    // (piece3-texts P-5: the card autosaves and a published course's change waits for „Avalda muudatused“)
    lead: "Lisa koolituse kaardile silt, nt „Uus“ või „Populaarne“. Vali tekst ja värv — muudatus on koolituste lehel näha pärast avaldamist.",
    presets: "Kiirvalik",
    none: "Puudub",
    own: "Oma tekst (kuni 18 märki)",
    placeholder: "nt. Sügise hitt",
    ownRu: "Tekst vene keeles (kuni 18 märki)",
    placeholderRu: "nt. Хит осени",
    ruNote: "Vene lehel näidatakse seda teksti, tühjana eestikeelset. Kiirvalikul on vene tekst juba olemas.",
    colour: "Värv",
    swatch: { tint: "Tint", orchid: "Orhidee", rose: "Tuhkroos", plum: "Ploom", light: "Hele" },
    preview: "Eelvaade",
    previewNote: "Nii näeb kaart välja koolituste lehel.",
  },

  // Koolitused, the list (README B1; piece 3 texts P-1, S3-P3-m): the lead is the design's (strings B1-1), the empty states are the shared list frames
  // (`lists.empty`, `lists.emptyFiltered` with `things`), the arrows' and the handle's names are `drag.*`. `moveMenu` is the phone's „↕“ (Part 4).
  courses: {
    eyebrow: "Kontaktõpe ja e-õpe",
    title: "Koolitused",
    lead: "Järjekord on sama mis avalikul lehel. Lohista ⋮⋮ või kasuta nooli.",
    add: "Lisa koolitus",
    typeLabel: "Õppevorm",
    filter: { all: "Kõik", e: "E-õpe", k: "Kontaktõpe" },
    type: { e_learning: "E-õpe", contact: "Kontaktõpe" },
    level: { basic: "Baaskoolitus", advanced: "Täiendkoolitus" },
    col: { order: "Järjekord", course: "Koolitus", type: "Õppevorm", price: "Hind", badge: "Märgis", status: "Staatus" },
    published: "Avaldatud",
    draft: "Mustand",
    // a published course with changes in the draft layer (never „Mustand“: that word is for a course that is not published)
    changes: "Avaldamata muudatused",
    sample: "Näidis",
    sampleTitle: "Prototüübi näidissisu: asenda päris tekstide ja fotodega.",
    noBadge: "—",
    edit: "Muuda: {name}",
    moveMenu: { button: "Liiguta: {name}", up: "Üles", down: "Alla", first: "Esimeseks", last: "Viimaseks" },
    moveError: "Järjekorra muutmine ei õnnestunud. Proovi uuesti.",
    // in a filtered view, where the handles and arrows are not drawn
    orderHint: "Järjekorda saab muuta vaates „Kõik“.",
    things: "koolitusi",
    count: "Koolitusi: {n}",
    noPrice: "—",
  },

  // The course editor (admin UX pass piece 3a, Task 7; README B2, §1.8; piece3-texts S3-P3-g, P-2…P-6): the way back „← Koolitused“ (glossary
  // „← {Lehe nimi}“), SaveStatus's „gone“ word (P-2), the new-course page's header line before the create (S3-P3-g: {button} is the create's label,
  // courses.add) and the leave guard's thing (S3-P3-g's {Asja}), the conflict's „Taasta minu tekst“ (README §1.3, B13)
  courseEditor: {
    backLink: "← Koolitused",
    editCrumb: "Muuda koolitust",
    newTitle: "Uus koolitus",
    thing: "koolitust",
    newRequired: "Täida kohustuslikud väljad",
    newReady: "Vajuta „{button}“.",
    newThing: "Koolitust",
    restore: "Taasta minu tekst",
    created: "Koolitus loodud. Lisa pildid ja avalda, kui kõik on valmis.",
    viewSite: "Vaata lehel",
    notFound: "Seda koolitust ei leitud.",
    back: "Tagasi koolituste juurde",
    sections: {
      basics: "Põhiinfo",
      type: "Õppevorm ja hind",
      outcomes: "Õpiväljundid",
      modulesC: "Programm",
      includes: "Koolitus sisaldab",
      protocolStages: "Protokolli punktid",
      test: "Teadmiste test",
      certificate: "Tunnistus",
      gallery: "Galerii",
      recommendations: "Soovitused",
      publish: "Avaldamine",
    },
    fields: {
      title: "Koolituse nimi",
      slug: "Aadress",
      slugHint: "Lehe aadress: /koolitused/{slug}. Väikesed tähed, numbrid ja sidekriipsud. Tühjaks jättes tehakse see nimest.",
      slugChanged: "Aadressi muutmisel ei avane vana link enam.",
      level: "Tase",
      language: "Koolituse keel",
      summary: "Lühikirjeldus",
      summaryHint: "Kaardil ja koolituse lehe päises.",
      body: "Pikk kirjeldus",
      bodyHint: "Tühi rida alustab uut lõiku.",
      type: "Õppevorm",
      // (piece3-texts P-5: the type changes at once, README B2)
      typeHint: "Koolitus on kas e-õpe või kontaktõpe. Õppevormi vahetamisel eemaldatakse teise õppevormi väljad.",
      price: "Hind (€)",
      accessMonths: "Ligipääs (kuud)",
      videoCount: "Videotunde",
      nextDiscount: "Soodustus järgmiselt koolituselt",
      nextDiscountHint: "nt −10% järgmiselt koolituselt. Tühjaks jättes ei näidata.",
      priceGroup: "Grupikoolituse hind (€)",
      priceGroupHint: "Tühi: grupis ei pakuta.",
      priceIndividual: "Individuaalkoolituse hind (€)",
      priceIndividualHint: "Tühi: individuaalselt ei pakuta.",
      durationLabel: "Kestus",
      durationHint: "nt 8 ak või 2 päeva · 16 ak",
      outcomes: "Õpiväljund",
      outcomesHint: "Mida õpilane pärast koolitust oskab.",
      modulesC: "Programmi punkt",
      modulesCHint: "Koolituse sisu järjekorras.",
      includes: "Punkt",
      includesHint: "Lehel plokis „Koolitus sisaldab“.",
      // "Protokolli punktid" (phase protocols): the headings of the course day's protocol, in the language Maria writes in
      protocolStage: "Punkt",
      protocolStagesHint: "Koolituspäeva protokolli etapid selles järjekorras, nt Ettevalmistus, Kulmude analüüs. Kirjuta need keeles, milles protokolli kirjutad. Muudatus kehtib protokollidele, mida pole veel alustatud.",
      protocolStagesEmpty: "Punkte veel pole: protokollis on siis ainult üldised märkused.",
      protocolStagesAdd: "Lisa punkt",
      protocolStagesFull: "Rohkem kui 30 punkti ei saa lisada.",
      // an e-course's "Protokolli punktid" are its practical points (e-course completion, spec §5.1)
      protocolStagesHintOnline: "E-kursusel on need praktilise töö punktid: õpilane lisab iga punkti juurde 1–3 fotot.",
      protocolStagesEmptyOnline: "Punkte veel pole: siis praktilist tööd ei ole.",
      // "Teadmiste test" (e-course completion, spec §5.1): {n} is the question's number, {q} and {n} in an option's label the question's and the option's
      testHint: "Muudatused kehtivad uutele katsetele; tehtud katsed jäävad nii, nagu need esitati.",
      testPass: "Läbimise piir (%)",
      testPassHint: "1–100. Nii mitu protsenti valikvastustega küsimustest peab olema õigesti vastatud.",
      testTries: "Katseid",
      testTriesHint: "1–10. Kui katsed saavad otsa, saad testi lehel „Hindamine“ uuesti avada.",
      testEmpty: "Küsimusi veel pole: siis testi ei ole ja õpilane jätkab õppetundidelt otse praktilise tööga.",
      testQuestion: "Küsimus {n}",
      testKind: "Küsimuse {n} liik",
      testKindChoice: "Valikvastustega",
      testKindOpen: "Vaba vastusega",
      testOption: "Küsimuse {q} vastusevariant {n}",
      testCorrect: "Õige",
      testChoiceHint: "Märgi õigeks üks või mitu vastust. Kui õigeid on mitu, peab õpilane valima kõik õiged.",
      testOpenHint: "Õpilane kirjutab vastuse ise. Sina loed selle läbi ja kinnitad lehel „Hindamine“.",
      testOptionAdd: "Lisa vastusevariant",
      testOptionRemove: "Eemalda küsimuse {q} vastusevariant {n}",
      testAdd: "Lisa küsimus",
      testFull: "Rohkem kui 50 küsimust ei saa lisada.",
      // the questions' ↑ / ↓ (DragList's arrowNames: the handle and the announcement are DragList's row forms, S3-P3-m)
      testUp: "Liiguta küsimus {n} üles",
      testDown: "Liiguta küsimus {n} alla",
      testRemove: "Eemalda küsimus {n}",
      // the UndoBar's line after × on a question or an answer option (S3-P3-d)
      testRemoved: "Küsimus eemaldatud.",
      testOptionRemoved: "Vastusevariant eemaldatud.",
      // "Tunnistus" (phase 3d, spec §6): an e-course certificate's lines and volume (the list is ProtocolStagesEditor's kind "skills")
      certificateLead: "E-kursuse tunnistuse tekst. Juba väljastatud tunnistused jäävad selliseks, nagu need väljastati.",
      certificateSkills: "Oskused tunnistusel",
      certificateSkill: "Rida",
      certificateSkillsHint: "Tühjana kasutatakse „Õpiväljundid“ ridu",
      certificateSkillsEmpty: "Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read.",
      // no line of its own, and an outcome the certificate would print is over 120 characters (domain/certificate.ts outcomesTooLong)
      certificateSkillsLong: "Tunnistusele lähevad õpiväljundid. Mõni neist on üle 120 tähemärgi ega mahu tunnistusele: lisa siia lühemad read.",
      certificateSkillsAdd: "Lisa rida",
      certificateSkillsFull: "Rohkem kui 16 rida ei saa lisada.",
      certificateVolume: "Maht",
      certificateVolumeHint: "nt 10 akadeemilist tundi. Tühjaks jättes tunnistusel ei näidata.",
      galleryHint: "Esimene pilt on põhipilt (kaardil ja galerii alguses). Muuda järjekorda nooltega.",
      main: "Põhipilt",
      image: "Pilt {n}",
      alt: "Pildi kirjeldus",
      // the pictures' ↑ / ↓ (DragList's arrowNames; the handle and the announcement are DragList's row forms, S3-P3-m)
      imageUp: "Liiguta pilt {n} ettepoole",
      imageDown: "Liiguta pilt {n} tahapoole",
      imageRemove: "Eemalda pilt {n}",
      // the UndoBar's line after × on a picture (drawn, P1:356; S3-P3-d)
      imageRemoved: "Pilt eemaldatud.",
      noImages: "Pilte veel pole.",
      recommendationsHint: "Vali kuni 3 koolitust, mida näidata selle koolituse lehe lõpus. Ülejäänud kohad täidetakse sarnaste koolitustega.",
      recommendationsCount: "Valitud {n} / 3",
      recommendationsMax: "Valida saab kuni 3 koolitust. Eemalda enne üks valik.",
      // „Avaldamine“'s two switches, as drawn (the Part 3 frame "B2 Course editor" L111, Part 4 L61; strings.md B2): no hints under them
      published: "Avalikul lehel",
      sample: "Näidissisu",
    },
    // a refused create (the new-course page) and the calendar drawer's save
    invalid: "Kontrolli märgitud välju.",
    // an e-course with lessons or students keeps its type (errors.typeLocked says it for a contact course)
    typeLockedOnline: "Sellel e-koolitusel on õppetunde või õpilasi, seega õppevormi muuta ei saa. Vajadusel loo uus koolitus.",
    // the PublishBar's names of the modules' and lessons' changes (piece 3 texts P-3; drawn „Lühikirjeldus, Hind, Moodul 03“): a change inside a
    // module (its name, its lessons, a new lesson, the lessons' order) by the module's place {nn} (01, 02, …); the modules moved; a contact course's
    // programme is named by its card title (sections.modulesC)
    outlineChanges: { module: "Moodul {nn}", moduleOrder: "Moodulite järjekord" },
    errors: fieldErrors,
  },

  // Koolitused → one course: "Moodulid ja õppetunnid" (an e-course) or "Programm" (a contact course: module titles only), in
  // components/admin/LessonsEditor.tsx; one lesson in the drawer (LessonDrawer.tsx) with its files (LessonFiles.tsx) and video
  // (LessonVideoField.tsx: `video`, added in Task 6).
  lessons: {
    title: "Moodulid ja õppetunnid",
    hint: "Õpilane avab õppetunnid järjekorras: järgmine avaneb, kui eelmine on tehtud.",
    // (piece3-texts P-5: shown on the new-course page, before the course exists)
    saveFirst: "Vajuta „Lisa koolitus“, et lisada mooduleid.",
    empty: "Mooduleid veel pole.",
    moduleName: "Mooduli nimi",
    newModule: "Uue mooduli nimi",
    newItem: "Uus programmi punkt",
    addModule: "Lisa moodul",
    addItem: "Lisa punkt",
    moveUp: "Liiguta üles: {title}",
    moveDown: "Liiguta alla: {title}",
    deleteModule: "Kustuta moodul",
    deleteModuleConfirm: "Kas kustutan mooduli „{title}“?",
    // a contact course's programme point is a „punkt“ in its delete (README B2, strings.md B2-3: the question; Dim 24.10 D-5: the button)
    deletePoint: "Kustuta punkt",
    deletePointConfirm: "Kas kustutan punkti „{title}“?",
    // in place of the button where a module cannot go: lessons in it, live or placed there by the draft (Dim 24.10 D-7)
    deleteModuleBlocked: "Moodulit saab kustutada, kui selles pole õppetunde.",
    deleteYes: "Jah, kustuta",
    // the card's summary beside its title (piece3-texts P-4, drawn „6 moodulit · 3 õppetundi“; P-8 the forms of 1; a programme's: Dim 24.10 D-6);
    // none: `empty` in its place
    summary: "{modules} · {lessons}",
    modulesN: "{n} moodulit",
    modulesOne: "1 moodul",
    lessonsN: "{n} õppetundi",
    lessonsOne: "1 õppetund",
    pointsN: "{n} punkti",
    pointsOne: "1 punkt",
    noLessons: "Selles moodulis pole veel õppetunde.",
    newLesson: "Uue õppetunni nimi",
    addLesson: "Lisa õppetund",
    editLabel: "Muuda õppetundi: {title}",
    hiddenTag: "Peidetud",
    textTag: "Tekst",
    // a lesson row's video (README B2, P-4: drawn „Valmis“, „Töötlemisel {n}%“, „Video puudub“; the two undrawn keep their words); processing with no
    // figure from Bunny, or 0: „Töötlemisel“ (S3-P3-e), with one: `videoProgress`
    videoTag: { none: "Video puudub", uploading: "Video üleslaadimisel", processing: "Töötlemisel", ready: "Valmis", failed: "Video viga" },
    videoProgress: "Töötlemisel {n}%",
    errors: {
      required: "Kirjuta nimi.",
      tooLong: "Liiga pikk.",
      inUse: "Moodulis on õppetunnid. Kustuta või tõsta need enne ära.",
      notFound: "Seda ei leitud. Laadi leht uuesti.",
      server: "Salvestamine ei õnnestunud. Proovi uuesti.",
    },
    // the lesson drawer (admin UX pass piece 3a, Task 10; README B2): its name and short text autosave (api/admin/oppetund/<id>), closing asks only
    // through the leave guard (leave.*), „Eemalda“ and the switch off have the UndoBar (piece3-texts S3-P3-c)
    drawer: {
      label: "Õppetund: {title}",
      // the header's first line (README B2 „Moodul {nn} · Õppetund {n.n}“, drawn „Moodul 01 · Õppetund 1.1“): {nn} the module's place in two digits,
      // {m} the same without them, {n} the lesson's place in its module
      place: "Moodul {nn} · Õppetund {m}.{n}",
      // SaveStatus „gone“ (piece3-texts P-2): „Seda õppetundi enam ei ole. Tekst on selles seadmes alles.“
      thing: "õppetundi",
      name: "Õppetunni nimi",
      body: "Lühike tekst",
      bodyHint: "Näidatakse õppetunni lehel. Tühi rida alustab uut lõiku.",
      // "Õppetunni liik": a video lesson is done at 90 % of its video; a text lesson with "Märgi tehtuks". Video → Tekst with a video asks in a
      // ConfirmPanel (README B2 „Kas vahetan liigi? Video kustutatakse.“ / „Jah, vaheta“ / „Katkesta“: the question, then its line, as the
      // panel's house style splits them; „Katkesta“ is the panel's own)
      kind: {
        label: "Õppetunni liik",
        video: "Video",
        text: "Tekst",
        confirm: "Kas vahetan liigi?",
        confirmLine: "Video kustutatakse.",
        yes: "Jah, vaheta",
      },
      // the switch (README B2; the Part 3 frame „Õpilastele nähtav / Peidetud“), its hint for a lesson with progress is `inUse`; off, the UndoBar
      // says `hidden` (S3-P3-c); on again, no bar
      visible: "Õpilastele nähtav",
      hidden: "Õppetund peidetud.",
      hiddenNote: "Peidetud: õpilased seda ei näe ja see ei loe edenemises.",
      delete: "Kustuta õppetund",
      deleteConfirm: "Kas kustutan õppetunni „{title}“ koos video ja failidega?",
      inUse: "Õppetunnil on õpilaste edenemist: seda saab ainult peita.",
    },
    files: {
      title: "Failid",
      // the drop zone (README B2, the Part 3 frame: „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“, {pick} the underlined picker's
      // words); a phone's „Vali fail“ (the Part 4 frame: the file picker replaces drag and drop)
      drop: "Lohista fail siia või {pick} · PDF, Word, pilt, kuni 4 MB",
      pick: "vali fail",
      pickPhone: "Vali fail",
      uploading: "Laen faili üles…",
      added: "Fail lisatud.",
      remove: "Eemalda",
      removeLabel: "Eemalda fail: {name}",
      // the UndoBar after „Eemalda“ (piece3-texts S3-P3-c); a refused undo says the bar's own common.saveError (ADM:162)
      removed: "Fail eemaldatud.",
      type: "Seda faili ei saa kasutada. Vali PDF, Word (.docx) või pilt.",
      size: "Fail on liiga suur (kuni 4 MB).",
      empty: "Fail on tühi.",
      content: "Faili sisu ei vasta selle tüübile.",
      storage: "Failide salvestamine pole seadistatud — anna arendajale teada.",
      session: "Sessioon on aegunud. Logi uuesti sisse ja proovi siis uuesti.",
      server: "Üleslaadimine ei õnnestunud. Proovi uuesti.",
    },
    // the drawer's video field (LessonVideoField.tsx), for a video lesson: the upload goes from the browser straight to Bunny Stream
    video: {
      title: "Video",
      hint: "Video laaditakse otse videoteenusesse. Hoia leht lahti, kuni üleslaadimine on lõppenud.",
      choose: "Vali video",
      // shown while a video lesson has no video students can watch (none, uploading, processing, failed, and no old one playing)
      waitingHint: "Õpilased näevad „Video lisandub peagi“ ja järgmine õppetund jääb lukku, kuni video on valmis.",
      uploading: "Laen üles… {percent} %",
      // with no figure from Bunny (S3-P3-e); with one, lessons.videoProgress „Töötlemisel {n}%“
      processing: "Töötlemisel…",
      // under the bar while Bunny encodes (the Part 4 frame P4:76; S3-P3-e: with a figure or without)
      leave: "Võid lehelt lahkuda — töötlemine jätkub.",
      ready: "Valmis · {duration}",
      replace: "Asenda video",
      replaceHint: "Vana video jääb õpilastele nähtavaks, kuni uus on valmis.",
      interrupted: "Üleslaadimine katkes",
      retry: "Proovi uuesti",
      failed: "Töötlemine ebaõnnestus",
      reupload: "Lae uuesti üles",
      notSetUp: "Video seadistamata",
      notSetUpHint: "Videoteenuse seaded puuduvad — anna arendajale teada.",
      type: "Vali videofail.",
      error: "Video üleslaadimine ei õnnestunud. Proovi uuesti.",
    },
  },

  // The admin calendar: the sessions of the contact courses (B adminOther "calendar").
  calendar: {
    eyebrow: "Kontaktõpe",
    title: "Kalender",
    lead: "Kontaktkoolituste toimumised. Avalikus kalendris ja koolituse lehel on näha avaldatud koolituste tulevased toimumised.",
    add: "Lisa toimumine",
    whenLabel: "Aeg",
    upcoming: "Tulevased",
    past: "Möödunud",
    // The list (B3, piece 3b Task 1; piece3-texts P-7): the two selects are named „Koolitus“ and „Linn“ (form.course, form.city; on a phone the
    // city select is the pill „Linn ▾“), their first options are „Kõik koolitused“ / „Kõik linnad“; the count line is „Toimumisi: {n}“; the phone
    // card says „{linn} · tühistatud“ of a cancelled session. The place is drawn under the course (Part 3), so the table has four columns.
    allCourses: "Kõik koolitused",
    allCities: "Kõik linnad",
    count: "Toimumisi: {n}",
    things: "toimumisi",
    cancelledShort: "tühistatud",
    col: { date: "Kuupäev", course: "Koolitus", seats: "Kohad", status: "Staatus" },
    status: { scheduled: "Toimub", cancelled: "Tühistatud" },
    full: "Täis",
    draft: "Mustand",
    draftTitle: "Koolitus on mustand: toimumine pole avalikul lehel näha.",
    edit: "Muuda toimumist: {name}",
    empty: "Tulevasi toimumisi pole.",
    emptyPast: "Möödunud toimumisi pole.",
    noCourses: "Kontaktkoolitusi pole. Lisa esmalt koolitus õppevormiga „Kontaktõpe“.",
    added: "Toimumine lisatud.",
    deleted: "Toimumine kustutatud.",
    // The drawer (B3, piece 3b Task 3; README B3, P-7, P-8, P-2, S3-P3-g). Its fields autosave: „Salvesta toimumine“ is gone, „Lisa toimumine“ stays the
    // explicit create of a new one (form.create).
    drawer: {
      newLabel: "Uus toimumine",
      editLabel: "Toimumine: {name}",
      notFound: "Seda toimumist ei leitud.",
      // the header line „{dd.mm.yyyy} · {linn} · {k}/{cap} kinnitatud · ootab ettemaksu {a} · ootenimekirjas {n}“, its parts joined with " · ", the awaiting
      // registrations' and the waitlist's left out at 0 (P-7, Dim 25.10); the phone's short form (Part 4) „… · {k}/{cap} · ootab ettemaksu {a} · ootel {n}“. {k}: the
      // confirmed registrations.
      seats: "{k}/{cap} kinnitatud",
      // Dim 25.10 (count: the controller's ruling): the registrations with the status „Ootab ettemaksu“, a seat hold live or ended — the number Registreerimised'
      // filter shows — between the seats and the waitlist, only
      // when there is one; the status's own words („Ootab ettemaksu“) in lower case; the phone's short line has it too (it fits: „… · 4/4 · ootab ettemaksu
      // 1 · ootel 2“).
      awaiting: "ootab ettemaksu {n}",
      waitlist: "ootenimekirjas {n}",
      seatsShort: "{k}/{cap}",
      waitlistShort: "ootel {n}",
      // the notice of a booked session; {n}: the registrations that are not cancelled (R-b); one is the nominative (P-8)
      booked: "{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.",
      bookedOne: "1 õpilane on registreerunud. Muudatusest talle kirja ei saadeta.",
      // SaveStatus „gone“ („Seda toimumist enam ei ole. …“, P-2) and the leave reason of a new one („Toimumist pole veel lisatud.“, S3-P3-g)
      thing: "toimumist",
      newThing: "Toimumist",
    },
    form: {
      course: "Koolitus",
      date: "Kuupäev",
      // README B3: „Eesti aeg.“ moved into the label
      time: "Algus (Eesti aeg)",
      city: "Linn",
      cityRequired: "Sisesta linn.",
      venue: "Toimumiskoht",
      venueHint: "nt MS LAB stuudio, Rüütli 12",
      language: "Keel",
      capacity: "Kohti",
      status: "Staatus",
      statusHint: "Tühistatud toimumine jääb avalikku kalendrisse märkega „Tühistatud“.",
      create: "Lisa toimumine",
      // the hint under „Kuupäev“ or „Algus“ changed on a booked session (README B3; the same words for n = 1, P-8); {n} as `drawer.booked`
      changed: "Muudetud — teavita {n} õpilast ise.",
    },
    // „Tühistatud“ on a booked session (README B3; P-8): the ConfirmPanel's question and its line ({n} as `drawer.booked`)
    cancel: {
      question: "Kas tühistan toimumise?",
      line: "{n} registreeringut jäävad alles; teavita õpilasi ise.",
      lineOne: "1 registreering jääb alles; teavita õpilast ise.",
      yes: "Jah, tühista",
    },
    remove: {
      button: "Kustuta toimumine",
      // P-7: the question and its line apart (P2T P-13), „Jah, kustuta“ / „Katkesta“
      question: "Kas kustutan selle toimumise?",
      line: "Seda ei saa tagasi võtta.",
      yes: "Jah, kustuta",
      // README B3 (strings.md D12, W2): in place of the button once the session has registrations (cancelled ones too, R-b)
      inUse: "Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.",
    },
  },

  newsletter: {
    eyebrow: "Uudiskiri",
    title: "Uudiskirja tellijad",
    lead: "Tellijad liituvad ise, aadressi sisestades: kinnituskirja enam ei saadeta. Tervituskirjas on loobumislink. „Ootab kinnitust“ on aadress, mis liitus vanal viisil ega ole kinnituslinki avanud.",
    // Tellijad (admin UX pass, piece 3b Task 7; README B5, piece3-texts P-13): the one „Laadi alla (CSV)“ of the current filter in place of „Lae alla
    // kinnitatud (CSV)“ and „Lae alla kõik (CSV)“, the search field's placeholder, the word of the empty lines („Tellijaid veel pole.“, „Selle valikuga
    // tellijaid pole.“: components/admin/ListStates.tsx fills `things`), and the two pills „Kinnitatud“ (col.confirmed) / „Ootab kinnitust“ (pending)
    // with their counts; the pill row's name is the lists' word „Staatus“ (registrations.statusLabel). {n} the rows shown, {confirmed} those of them confirmed.
    csvDownload: "Laadi alla (CSV)",
    searchPlaceholder: "Otsi e-posti järgi",
    things: "tellijaid",
    statusLabel: "Staatus",
    count: "Tellijaid: {n}, neist kinnitatud {confirmed}",
    col: { email: "E-post", locale: "Keel", consent: "Nõusolek", confirmed: "Kinnitatud" },
    pending: "Ootab kinnitust",
    // CSV export: header row and the yes/no column (the file is for Maria and mailing tools); the file is named after the state it holds (P-13)
    csv: {
      filename: "mslab-uudiskiri",
      filenameConfirmed: "mslab-uudiskiri-kinnitatud",
      filenamePending: "mslab-uudiskiri-ootab-kinnitust",
      header: ["E-post", "Keel", "Nõusolek", "Kinnitatud", "Kinnitamise aeg"],
      yes: "jah",
      no: "ei",
    },
    // Maria's campaign editor (newsletter campaigns Task 4, `campaigns` below): the text under a field that domain/newsletter-campaign.ts
    // checkCampaignDraft refuses with `ruLabel` (a button and a Russian text, but no Russian label). Draft for Dim's wording sheet.
    campaignErrors: { ruLabel: "Lisa nupu tekst ka vene keeles." },
    // The page's two views (newsletter campaigns Task 4): the subscribers, and the letters (?vaade=kampaaniad, the address kept). „Kirjad“ is the
    // design's rename of the spec's „Kampaaniad“ (piece3-texts P-12; README B5, §1.11 „Uudiskiri → Kirjad“: „kampaania“ stays for the popup only).
    viewsLabel: "Vaade",
    views: { subscribers: "Tellijad", campaigns: "Kirjad" },
    // „Kirjad“ (newsletter campaigns Task 4; spec D4, D5; admin UX pass piece 3b Task 6: README B5, B9, B17, the Part 3 frame „B5 Uudiskiri“ and the Part 4
    // „B5 Kirjad“; components/admin/CampaignsPanel.tsx, NewsletterCampaignEditor.tsx). The words are piece3-texts' (P-12 the renames, P-13 the list rows,
    // the send panel and the stop's split, S3-P3-f „Kustuta mustand“, S3-P3-h „Uus kiri +“, S3-P3-l the sends while the letter is not saved) and the
    // design's (README B5, Part 3 and Part 4: „Saada kõigile ({n})“, the select „{aadress} · {eesti|vene keeles}“, the hint under the buttons, „Muuda |
    // Eelvaade“, „← Kirjad“, „Saada proov · maria@… · ET“); the rest are the spec's and the earlier Drafts, unchanged.
    // {n} a count, {max} a limit, {date} a time, {a} / {b} the Estonian and the Russian counts, {sent} / {left} the mails that went and those waiting,
    // {email} an address, {name} the letter's name.
    campaigns: {
      title: "Kirjad",
      list: "Kirjad",
      // „Uus kiri +“ (the „+“ is the component's): a draft of this name at once (S3-P3-h, ruling R-g: `newTitle` is its name)
      new: "Uus kiri",
      empty: "Kirju veel pole.",
      // a row's line under its name (P-13; the first two drawn, P3:239-240): {date} „dd.mm hh:mm“ for a draft, „dd.mm“ for a sent letter
      row: {
        draft: "Mustand · muudetud {date}",
        sent: "Saadetud {date} · {n} tellijale",
        sending: "Saatmine pooleli · {sent} / {n}",
      },
      notFound: "Seda kirja enam pole.",
      newTitle: "Uus kiri",
      // README §1.4's {asja} of SaveStatus' gone state: „Seda kirja enam ei ole. …“ (P-12's „kirja“)
      thing: "kirja",
      // the phone (Part 4 „B5 Kirjad“): the list is its own screen, „← Kirjad“ back to it, and a letter's „Muuda | Eelvaade“
      back: "← Kirjad",
      panes: { edit: "Muuda", preview: "Eelvaade" },
      // the editor's fields
      form: "Kiri",
      name: "Nimi",
      nameHint: "Ainult sulle: tellijad seda ei näe.",
      subject: "Teema",
      preheader: "Eelvaate rida",
      preheaderHint: "Hall rida teema järel enamikus postkastides. Võib jääda tühjaks.",
      image: "Pilt",
      imageHint: "Näiteks sinu flaier: kirjas on see kaardi täies laiuses.",
      body: "Tekst",
      bodyHint: "Tühi rida alustab uut lõiku.",
      code: "Kood",
      codeHint: "Näidatakse kastis nagu tervituskoodi. Ainult tähed, numbrid ja sidekriips.",
      buttonLabel: "Nupu tekst",
      buttonHref: "Nupu aadress",
      buttonHrefHint: "Saidi leht (nt /koolitused) või https:// aadress. Nupp on kirjas siis, kui tekst ja aadress on mõlemad olemas.",
      count: "{n} / {max}",
      countI18n: "ET {et} / {max} · RU {ru} / {max}",
      // the field errors of domain/newsletter-campaign.ts (its `ruLabel` is `campaignErrors.ruLabel` above): a save's, and the sends' required fields
      errors: { required: "Täida see väli.", tooLong: "Tekst on liiga pikk.", invalid: "Kontrolli seda välja." },
      // „Kustuta mustand“ (B17, S3-P3-f): a draft's only; its ConfirmPanel, and the line in the list once the draft is gone
      remove: {
        button: "Kustuta mustand",
        question: "Kas kustutan mustandi „{name}“?",
        line: "Seda ei saa tagasi võtta.",
        yes: "Jah, kustuta",
        done: "Mustand kustutatud.",
      },
      // the live preview (the real mail, from the preview route), in the language of the page's ET | RU switch
      preview: "Eelvaade",
      previewSubject: "Teema",
      previewFallback: "Vene keeles tellijad saavad eestikeelse kirja.",
      previewFrame: "Kirja eelvaade: {lang}",
      previewWorking: "Uuendan eelvaadet…",
      previewError: "Eelvaadet ei saanud näidata. Proovi uuesti.",
      // the sends of a draft (spec §3; README B5): „Saada proov“ and „Saada kõigile ({n})“ with its ConfirmPanel
      send: "Saatmine",
      // S3-P3-l: what stands in the two buttons' place while the letter's text cannot be saved (with the leave guard's reason, adminEt.leave.reasons)
      blocked: "Saatmiseks peab kiri olema salvestatud.",
      test: {
        // the select's name (for a screen reader: the design draws the select without a label)
        to: "Kellele",
        // the select's line: „maria@example.test · eesti keeles“ (README B5)
        option: "{email} · {lang}",
        optionLang: { et: "eesti keeles", ru: "vene keeles" },
        button: "Saada proov",
        // the phone's button (Part 4): „Saada proov · maria@… · ET“; {email} the address's name part and „@…“, {lang} ET or RU
        phoneButton: "Saada proov · {email} · {lang}",
        phoneEmail: "{name}@…",
        working: "Saadan proovi…",
        sent: "Proov läks aadressile {email}. Kiri jõuab mõne minuti jooksul.",
      },
      all: {
        button: "Saada kõigile ({n})",
        checking: "Vaatan tellijaid…",
        // the ConfirmPanel (P-13): the question, the counts (one language: its own part only), the sample line (only when a sample address is among the
        // confirmed), the day's room (only when n is more than CAMPAIGN_DAILY_ROOM: the existing sentence), what cannot be undone
        question: "Kas saadan kirja „{name}“?",
        counts: "{n} kinnitatud tellijat: {a} eesti, {b} vene keeles.",
        countsEt: "{n} kinnitatud tellijat: {a} eesti keeles.",
        countsRu: "{n} kinnitatud tellijat: {b} vene keeles.",
        samples: "Näidisaadressidele (@example.test) ei saadeta.",
        room: "Päevas läheb välja nii palju kirju, kui mahub; ülejäänud lähevad järgmisel päeval.",
        final: "Saadetud kirja ei saa tagasi võtta ega muuta.",
        yes: "Jah, saada {n} tellijale",
        // the hint under the buttons (drawn: „3 eesti, 1 vene keeles · näidisaadressidele ei saadeta“): a zero part and the sample part left out when empty
        hint: { both: "{a} eesti, {b} vene keeles", et: "{a} eesti keeles", ru: "{b} vene keeles", samples: "näidisaadressidele ei saadeta" },
        fallback: "Vene keeles tellijad saavad eestikeelse kirja.",
        working: "Saadan…",
        done: "Kiri on saadetud.",
      },
      // while the coming-soon gate is on (SITE_GATE, lib/site-gate.ts) the mail's links and button open the „Tulekul“ page: a notice under the
      // confirmation of „Saada kõigile“ and under the result of „Saada proov“, never a block (final review I1, ruling R9; Draft)
      gateNotice: "Koduleht pole veel avatud — kirja lingid ja nupp viivad „Tulekul“ lehele.",
      // a letter that is going out (status `sending`): the progress, and „Peata saatmine“ (spec §3, Draft). {sent} the mails that went, {n} every
      // subscriber it was written for, {left} those still waiting (they go the next day, or when the day has room)
      progress: "Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval.",
      // the counts that are worth a line only when they are not 0 (spec §3: a failure count is added to the sent line if there were any)
      failedLine: "Kiri ei läinud {n} aadressile: aadress ei sobinud.",
      unknownLine: "{n} kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.",
      // „Peata saatmine“'s ConfirmPanel, split as P2T P-13 (piece3-texts P-13)
      stop: {
        button: "Peata saatmine",
        question: "Kas peatan saatmise?",
        left: "Veel saatmata {n} kirja ei lähe välja.",
        final: "Seda ei saa tagasi võtta.",
        yes: "Jah, peata",
        working: "Peatan…",
        done: "Saatmine peatatud.",
      },
      // a sent letter (read-only), and one going out
      sentLine: "Saadetud {date} · {n} tellijale",
      readOnly: "Saadetud kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.",
      readOnlySending: "Pooleli kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.",
      copy: "Kopeeri",
      copying: "Kopeerin…",
      // the copy's name: the letter's own with this after it (cut to the name's limit)
      copySuffix: " (koopia)",
      // the page behind a test mail's unsubscribe link (/api/newsletter/loobu?proov=1, ruling R4): it changes nothing
      testPage: "Proovikiri — päris kirjas viib see link loobumisele.",
      // what an action answers when it did not go through (actions/admin-newsletter.ts); `busy` is the design's (README B5), `refused` the spec's (Draft);
      // is also the line of a batch that stopped because Resend refused (startSendAction's `stopped`, the page's `refused`: sendRefused)
      errorsOf: {
        notFound: "Seda kirja enam pole.",
        sent: "See kiri on juba saadetud.",
        server: "Ei õnnestunud. Proovi uuesti.",
        busy: "Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.",
        changed: "Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“.",
        // „Saada proov“ on a letter saved elsewhere since (ruling R-j; Dim 29.10): a test is never refused over the subscribers, so it has its own words; the editor says
        // them for the test only, and also for a test sent with no version (an outdated page script), which is `changed` too
        testChanged: "Kirja muudeti vahepeal teises aknas. Proovi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada proov“.",
        empty: "Kinnitatud tellijaid pole: kirja pole kellelegi saata.",
        notSending: "Selle kirja saatmine ei ole pooleli.",
        refused: "Saatmine peatus: Resend keeldus. Kirjuta Dimile.",
        limited: "Selle tunni 10 proovi on saadetud. Proovi tunni pärast uuesti.",
        mail: "Proovi ei saanud saata. Proovi uuesti.",
        address: "Sellele aadressile ei saa proovi saata.",
      },
    },
  },
  // ---------- Task 13B: the site content editors ----------

  // The shared pieces of the site editors (home page, practice, trainer, news, the popup, settings). The save bar's words went with it (piece4-texts
  // §4, piece 4b): `invalid` stays, other screens say it for a refused field.
  editor: {
    invalid: "Kontrolli märgitud välju.",
    viewSite: "Vaata lehel",
    newWindow: "avaneb uues aknas",
    open: "Muuda",
    close: "Sulge",
    image: {
      none: "Pilti pole veel valitud.",
      choose: "Vali pilt",
      replace: "Vaheta pilt",
      remove: "Eemalda pilt",
      current: "Praegune pilt",
    },
    focal: {
      title: "Fookuspunkt",
      hint: "Vajuta pildil kohale, mis peab alati nähtavaks jääma. Pilt lõigatakse ekraanile sobivaks selle punkti ümber.",
      pick: "Fookuspunkti valik: {label}",
      x: "Vasakult (%)",
      y: "Ülevalt (%)",
      desktop: "Arvutis",
      mobile: "Telefonis",
      which: "Kumba vaadet muudad",
      preview: "Eelvaade: {label}",
    },
  },

  // C1 Avaleht (admin UX pass piece 4a, Task 6; piece4-texts S4-5 eyebrow, S4-6 lead, S4-7 card and map names, S4-8 the link row, S4-9 a slide row's
  // Russian line, S4-10 the open slide, S4-11 a FAQ row's state, S4-3 the slide's UndoBar line; the FAQ's is courseEditor.fields.testRemoved)
  home: {
    eyebrow: "Koduleht",
    title: "Avaleht",
    lead: "Avalehe slaidid, MS LABi lause ja korduma kippuvad küsimused. Muudatus on avalehel näha pärast avaldamist.",
    slides: {
      title: "Slaidid",
      lead: "Slaidid on avalehel selles järjekorras. Tumedal slaidil on päis, tekst ja nupud valged, heledal tumedad.",
      slide: "Slaid {n}",
      untitled: "Pealkirjata slaid",
      add: "Lisa slaid",
      open: "Muuda slaidi {n}",
      up: "Liiguta slaid {n} ettepoole",
      down: "Liiguta slaid {n} tahapoole",
      remove: "Eemalda slaid {n}",
      // S4-10: the open slide's remove button, as it is seen (its name for a screen reader is `remove`, with the slide's number)
      removeText: "Eemalda slaid",
      // S4-3: the UndoBar's line after „Eemalda slaid“
      removed: "Slaid eemaldatud.",
      // S4-9: a row's second line, the slide's Russian title; with none, „RU: RU puudub“ (sectionMap.ru in its place)
      ru: "RU: {title}",
      // S4-10: under the open slide's picture, before „Vaheta pilt“ (the other pictures keep editor.focal.hint)
      focalHint: "Puuduta pilti, et valida fookus",
      max: "Slaide saab olla kuni 8.",
      empty: "Slaide pole. Ilma slaidita algab avaleht kohe koolitustega.",
      hidden: "Peidetud",
      tone: "Toon",
      light: "Hele",
      dark: "Tume",
      toneHint: "Tume: valge päis ja tekst tumedal pildil. Hele: tume päis ja tekst heledal pildil.",
      active: "Näidatakse avalehel",
      activeHint: "Märke eemaldamisel jääb slaid alles, kuid avalehel seda ei näidata.",
      image: "Pilt",
      kicker: "Väike pealkiri",
      titleField: "Pealkiri",
      titleHint: "Uus rida pealkirjas: vajuta Enter.",
      // S4-10 (was „Tekst“): the slide's text, printed under its title
      text: "Alapealkiri",
      ctaLabel: "Nupu tekst",
      ctaLabelHint: "Tühjaks jättes: „Leia oma koolitus“.",
      ctaHref: "Nupp viib",
      ctaHrefHint: "Lehe aadress, nt /koolitused või /praktika, või täielik https://-aadress. Teine nupp viib alati koolituskalendrisse.",
    },
    statement: {
      title: "MS LABi lause",
      lead: "Lühike lause avalehe keskel. Esimese komani on tekst tumedam.",
      field: "Lause",
      hint: "Tühjaks jättes lõiku avalehel ei näidata.",
    },
    teaser: {
      // S4-7
      title: "Koolitaja kaart",
      lead: "Lühike tekst avalehe koolitaja kaardil nime all. Nimi, foto ja numbrid tulevad lehelt Koolitaja.",
      field: "Tekst",
      hint: "Tühjaks jättes näidatakse koolitaja tutvustuse esimest lõiku.",
    },
    faq: {
      // S4-7
      title: "KKK",
      lead: "Küsimused ja vastused avalehe lõpus, selles järjekorras. Esimene on lahti.",
      item: "Küsimus {n}",
      question: "Küsimus",
      answer: "Vastus",
      add: "Lisa küsimus",
      up: "Liiguta küsimus {n} üles",
      down: "Liiguta küsimus {n} alla",
      remove: "Eemalda küsimus {n}",
      empty: "Küsimusi pole. Ilma küsimusteta plokki avalehel ei näidata.",
      // S4-11: a row's state when its question and its answer both have their Russian text; else „RU puudub“ (sectionMap.ru)
      both: "ET · RU",
    },
    trainer: {
      title: "Koolitaja plokk",
      // S4-8: the link row under the title (its fields are Koolitaja's)
      link: "Muuda lehel Koolitaja →",
      // S4-7: the section map's value for the link row
      mapValue: "→",
    },
  },

  // C5 Praktika (admin UX pass piece 4a, Task 4; piece4-texts S4-31 eyebrow, S4-32 lead, S4-33 card title, points list and its add button)
  practice: {
    eyebrow: "Koolitused",
    title: "Praktikapaketid",
    lead: "MINI ja MAXI pakett: nimi, lühitekst, modellide arv, kestus, hind ja punktid. Avaldades uuenevad praktikaleht ja avalehe praktikaplokk.",
    // a package's card is titled by its code alone („MINI“, „MAXI“)
    package: "{code}",
    name: "Nimi",
    tagline: "Lühitekst",
    models: "Modelle",
    modelsHint: "Mitmel modellil praktika toimub.",
    duration: "Kestus",
    durationHint: "nt 8 ak. Kaardil: „≈ 8 ak“.",
    price: "Hind (€)",
    items: "Sisaldab",
    item: "Punkt",
    itemsHint: "Iga rida on üks punkt paketi kaardil.",
    // the points' add button, after its „+“ (ListEditor; R-h: Enter in the last point adds one too)
    addItem: "Lisa punkt (või Enter viimasel real)",
    empty: "Praktikapakette pole.",
  },

  // Koolitaja (C2; admin UX pass piece 4a, Task 5: piece4-texts S4-13…S4-16, the rest unchanged, §3; the numbers' list editor's words went with it, §4)
  trainer: {
    eyebrow: "Koduleht",
    title: "Koolitaja",
    lead: "Koolitaja leht: portree, nimi, tutvustus, numbrid, tööde galerii ja kaks lugu. Avalehe koolitaja plokk kasutab samu andmeid.",
    // the first card: the portrait beside the name, the role and the bio (S4-14)
    card: "Portree ja tutvustus",
    portrait: "Portree",
    portraitHint: "Püstine foto sobib kõige paremini. Fookuspunkt jääb alati nähtavale.",
    portraitWide: "Arvutis (4:5)",
    portraitNarrow: "Telefonis (4:3)",
    name: "Nimi",
    role: "Amet",
    roleHint: "Näidatakse koolitaja lehel, kui tutvustus on tühi.",
    // three fixed pairs, each a number and its label (their fields' names: „Number {n}“, „Selgitus {n}“)
    stats: "Numbrid",
    statValue: "Number",
    statLabel: "Selgitus",
    stat: "Number {n}",
    bio: "Tutvustus",
    bioHint: "Tühi rida alustab uut lõiku. Esimene lõik on ka avalehe koolitaja plokis.",
    // the gallery's card (S4-14), its counter (S4-15; {n}: the pictures, at most 24 — Dim 26.10, D25) and its last tile, after its „+“ (S4-15)
    works: "Galerii",
    worksHint: "Lohista järjekorra muutmiseks · {n} / 24",
    addWork: "Lisa",
    story: "Koolituskeskuse lugu",
    journey: "Koolitaja teekond",
    storyTitle: "Pealkiri",
    storyTitleHint: "Tühjaks jättes: „{title}“.",
    storyBody: "Tekst",
    storyHint: "Tühi rida alustab uut lõiku. Tühjaks jättes osa lehel ei näidata.",
    // an empty story's card, folded (S4-16: „tühi · Lisa tekst ▸“, the ▸ the fold's own), and the section map's word for it
    empty: "tühi",
    addText: "Lisa tekst",
  },

  // C3 Uudised (admin UX pass piece 4b, Task 2; piece4-texts S4-18…S4-24): the list's rows (the table and its columns go, S4-18) with the title search,
  // „Lisa postitus +“ (the button's text and the „+“), the row line `{staatus} · {dd.mm}` (`—` without a date), and the lists' empty frames
  // (lists.empty / emptySearch with `things`). The status words: „Avaldatud“, „Mustand“ (never published) and „Avaldamata muudatused“ (a published
  // post with a draft, as courses.changes; never „Mustand“, behaviours B2).
  news: {
    eyebrow: "Blogi",
    title: "Uudised",
    lead: "Kõik postitused, ka mustandid, uuemad eespool. Blogis ja avalehel on näha avaldatud postitused.",
    add: "Lisa postitus",
    search: "Otsi pealkirja järgi",
    things: "postitusi",
    published: "Avaldatud",
    draft: "Mustand",
    changes: "Avaldamata muudatused",
    rowLine: "{status} · {date}",
    noDate: "—",
    deleted: "Postitus kustutatud.",
  },

  // The post editor (S4-19…S4-24; every field and hint as before): „← Uudised“ below 1180 px (S4-21; from 1180 px the list is beside it), the footer
  // line (S4-20), „Kustuta postitus“'s ConfirmPanel (S4-23: the public line only for a published post), SaveStatus's „gone“ word (S4-4).
  post: {
    editCrumb: "Muuda postitust",
    newTitle: "Uus postitus",
    created: "Postitus loodud. Lisa kaanepilt ja avalda, kui kõik on valmis.",
    notFound: "Seda postitust ei leitud.",
    back: "← Uudised",
    thing: "postitust",
    // {date}: dd.mm.yyyy; {slug}: the address
    foot: { published: "Avaldatud {date} · /uudised/{slug}", draft: "Mustand · /uudised/{slug}" },
    sections: { cover: "Kaanepilt", publish: "Avaldamine" },
    title: "Pealkiri",
    slug: "Aadress",
    slugHint: "Lehe aadress: /uudised/{slug}. Väikesed tähed, numbrid ja sidekriipsud. Tühjaks jättes tehakse see pealkirjast.",
    slugChanged: "Aadressi muutmisel ei avane vana link enam.",
    slugTaken: "See aadress on juba teisel postitusel.",
    excerpt: "Lühitekst",
    excerptHint: "Postituse kaardil blogis ja avalehel.",
    body: "Tekst",
    bodyHint: "Tühi rida alustab uut lõiku.",
    category: "Kategooria",
    categoryHint: "nt Uudis, Nõuanne või Praktika.",
    date: "Kuupäev",
    dateHint: "Näidatakse postituse juures; uuemad postitused on eespool.",
    coverHint: "Kaardil lõigatakse pilt 4:3, postituse lehel 16:9. Avaldatud postitusel peab kaanepilt olemas olema.",
    published: "Avaldatud",
    publishedHint: "Avaldatud postitus on blogis ja avalehel nähtav. Mustandit näed ainult siin.",
    remove: {
      button: "Kustuta postitus",
      question: "Kas kustutan selle postituse?",
      // only for a published post: what changes in public (P1 §3.3)
      public: "Postitus kaob blogist ja avalehelt.",
      final: "Seda ei saa tagasi võtta.",
      yes: "Jah, kustuta",
    },
  },

  // C4 Hüpikaken (admin UX pass piece 4b, Task 4; README §4 C4, the Part 4 C4 frame; piece4-texts S4-25…S4-29, D3: one popup, the newsletter sign-up,
  // with the instant „Lehel näidatakse“ and its offer on the draft layer). Kept from before (§3): the eyebrow, the H1, „Lehel näidatakse“, „Silt“,
  // „Pealkiri“, „Tekst“, „Pilt“, „Eelvaade“ and its note. The card's name „Pakkumine“ (S4-27) is siteChanges.popup.offer, the bar's labels S4-30.
  // The three-way choice, the campaign offer's fields, the old lead and the rules list went with the campaign popup (§4).
  campaign: {
    eyebrow: "Turundus",
    title: "Hüpikaken",
    shown: "Lehel näidatakse",
    // S4-25: under the switch, in place of the old lead
    shownHint: "Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul",
    // S4-26: switched off, the UndoBar (on again: no bar); a press or its undo refused because another tab changed the popup (W7's shape). A switch on
    // refused because the live popup lacks a field says publish.missing under it („Puudub: pilt“)
    hidden: "Hüpikaken peidetud.",
    changed: "Hüpikakent muudeti vahepeal. Vaata see üle.",
    kicker: "Silt",
    titleField: "Pealkiri",
    text: "Tekst",
    image: "Pilt",
    // S4-27 (S4-Q2 A, S4-Q3 A): the two numbers side by side, S4-28 under them
    discount: "Soodustus (%)",
    codeDays: "Kood kehtib (päeva)",
    codeWhere: "Koodi saad muuta: Seaded → „Tervituskood“.",
    preview: "Eelvaade",
    previewNote: "Nii näeb hüpikaken välja avalehel. Laiemal ekraanil on pilt teksti kõrval.",
    // S4-29 (Dim 26.10: reworded, the sign-up has no confirmation step since 09.10): under the preview
    rulesLine: "Reeglid: kood saadetakse e-postiga kohe pärast liitumist; üks kasutus tellija kohta; ei liitu teiste soodustustega.",
  },

  // Seaded (admin UX pass piece 3b, Task 4; README B4): one page with a section map; its sections, as the map names them. The page lead is gone (the
  // design draws none, piece3-texts §4).
  settings: {
    eyebrow: "Seaded",
    title: "Seaded",
    sections: { contact: "Kontakt", newsletter: "Uudiskiri", payment: "Maksmine", certificate: "Tunnistus", legal: "Lepingud ja tingimused", admins: "Halduse ligipääs" },
    contact: "Kontaktandmed",
    contactLead: "Jaluses ja kontaktilehel. Tühja välja ei näidata.",
    email: "E-post",
    phone: "Telefon",
    address: "Aadress",
    addressHint: "Kontaktilehel.",
    instagram: "Instagram",
    facebook: "Facebook",
    socialHint: "Täielik aadress, nt https://www.instagram.com/mslab",
    newsletter: "Uudiskiri",
    // the welcome discount moved to Hüpikaken (piece 4b S4-Q2 A: „Soodustus (%)“); the code's hint drops „pärast … kinnitamist“ (S4-29 ruling)
    welcomeCode: "Tervituskood",
    welcomeCodeHint: "Saadetakse tervituskirjas ja näidatakse avalehel kinnitusteates; hüpikaknas seda ei näidata. Tühjaks jättes koodi ei saadeta. Tähed A–Z, numbrid ja sidekriips, kuni 30 märki.",
    // where students pay the prepayment: on the unpaid contact-course cards of their account (never on a public page); the „Maksmine“ card's bank fields
    prepaymentHint: "Juhised on õpilasele näha ainult siis, kui saaja ja IBAN on täidetud. Muidu ütleb kaart: „Maria saadab sulle arve“.",
    receiver: "Saaja",
    iban: "IBAN",
    bank: "Pank",
    referencePrefix: "Selgituse algus",
    referenceHint: "Makse selgitus on see algus ja registreerimise number, nt MSLAB-42. Tühjaks jättes ainult number.",
    privacy: "Privaatsus",
    terms: "Õppetingimused",
    // piece3-texts P-11 (strings.md W19): the card is named as drawn, not „… (tingimused)“
    courseTerms: "E-koolituse leping",
    // Draft (contracts Task 5): the text is the e-course contract, read in the cart before buying and at the terms gate of a course opened without a
    // purchase; its last sentence as piece3-texts P-5 rewords it (the text is published, not saved)
    courseTermsLead: "See on e-koolituse leping. Õpilane loeb seda ostukorvis enne ostmist ja nõustub sellega; ilma ostuta avatud koolituse puhul nõustub ta enne esimest avamist. Kui avaldad muudetud teksti, peab iga õpilane uuesti nõustuma.",
    pageTitle: "Pealkiri",
    pageBody: "Tekst",
    pageHint: "Tühi rida alustab uut lõiku.",
    // the four legal texts on the draft layer (piece 3b, Task 5; components/admin/ContractTexts.tsx): README B4 (the tag, „Avalda uus leping“, the
    // e-course panel, drawn), piece3-texts S3-P3-j (the contact panel), S3-P3-k (the pages' button and panels), P-8 (n = 1; at n = 0 the count line is
    // left out), P-11 (the lines after „Jah, avalda“, the refusal); the Part 4 phone frame (the short tag, the full-screen editor's hint and button)
    legal: {
      tag: "Avaldamata muudatus",
      tagShort: "Avaldamata",
      publishContract: "Avalda uus leping",
      publishText: "Avalda uus tekst",
      yes: "Jah, avalda",
      ecourse: {
        question: "Kas avaldan uue e-koolituse lepingu?",
        many: "{n} aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.",
        one: "1 aktiivne õpilane peab selle järgmisel sisselogimisel uuesti kinnitama.",
        kept: "Vana leping jääb alles ja märgitakse asendatuks.",
      },
      contact: {
        question: "Kas avaldan uue kontaktkoolituse lepingu?",
        newOnly: "Uus tekst kehtib uutele registreeringutele.",
        kept: "Varem kinnitatud lepingud jäävad selliseks, nagu need kinnitati.",
      },
      privacy: { question: "Kas avaldan lehe „Privaatsus“ uue teksti?" },
      terms: {
        question: "Kas avaldan lehe „Õppetingimused“ uue teksti?",
        // only while „Kontaktkoolituse leping“ is empty (the terms text is the contact contract until then)
        asContract: "Kuni „Kontaktkoolituse leping“ on tühi, kehtib see tekst uutele registreeringutele lepinguna.",
      },
      shownAtOnce: "Uus tekst on avalikul lehel kohe näha.",
      published: { course_terms: "Uus e-koolituse leping on avaldatud.", contract_contact: "Uus kontaktkoolituse leping on avaldatud.", text: "Uus tekst on avaldatud." },
      changed: "Seda teksti muudeti vahepeal teises aknas. Vaata see üle.",
      phoneHint: "Pikk tekst avaneb täisekraanil.",
      phoneOpen: "Muuda teksti",
    },
    admins: "Halduse ligipääs",
    adminsLead: "Need aadressid saavad haldusesse sisse logida. Nimekirja muudab arendaja.",
  },
  // The test page (phase 4, piece 1): /admin/testimine, the checks Maria and Dim answer. `tg` is the Telegram text of a Viga and of its first note
  // (server/testplan.ts pingText); since Dim 22.10 the first note of any answer is a `tg.note`, which shows the answer ({status}, in the button's
  // words). `last` is "{name} · dd.mm HH:MM · {status}" (Tallinn time, the status in the button's words).
  // `who.auto` (Dim 25.10) is the automatic tester whose answers stay apart: the „Kes“ choice, and the name of the quiet line under a check,
  // "Automaattest: {status} · dd.mm HH:MM" (TestPlan.tsx puts it together from these words and `overtaken`; no other text of its own).
  // Admin UX pass piece 4c (C7, piece4-texts S4-42…S4-46): the eyebrow, the line under the H1, the two labelled filter groups, „Sammud ▸“, the
  // answers „Läbitud“ | „Viga“ (`ok` reworded: the last-answer line, Automaattest's line and Telegram say it too, R-i) and the empty selection.
  // SaveStatus (`autosave.*`) replaced the page's own save words; the marks' chips, „Muudetud“ and „Sina: …“ went (§4).
  testplan: {
    title: "Testimine",
    eyebrow: "Haldus",
    // S4-43: under the H1, over the checks of the „Kes“ choice
    progress: { one: "1 kontroll · {done} läbitud · {bad} viga", many: "{n} kontrolli · {done} läbitud · {bad} viga" },
    // in its place while the answers cannot be read (Dim 29.10, the review's Q1): the page shows no numbers then; {refresh} is `refresh`
    unread: "Vastuseid ei saanud praegu lugeda. Need on alles; vajuta hiljem „{refresh}“.",
    // S4-44 („Olek“, „Kes“ are capitals in CSS); {n} the checks of that state under the „Kes“ choice
    filter: { label: "Olek", all: "Kõik", open: "Avatud {n}", bad: "Viga {n}", done: "Läbitud {n}" },
    // the „Kes“ choices (`mina`, `all`, `auto`); `maria`, `dim`, `koos` are the who chip of a check
    who: { label: "Kes", mina: "Mina", all: "Kõik", auto: "Automaattest", maria: "Maria", dim: "Dim", koos: "Koos" },
    refresh: "Värskenda",
    open: "Ava",
    // S4-45 „Sammud ▸“ (the ▸ is the component's: it turns when the steps are open)
    steps: "Sammud",
    expect: "Mida näed",
    why: "Miks",
    writes: "Loob andmeid",
    device: { telefon: "Telefon", tahvel: "Tahvel", arvuti: "Arvuti" },
    ok: "Läbitud",
    bad: "Viga",
    // no button any more (spec §10); the word of an answer stored before it went (the data stays): its last-answer line, Automaattest's line, Telegram
    skip: "Jäta vahele",
    note: "Märkus",
    notePrompt: "Mis läks valesti?",
    last: "{name} · {when} · {status}",
    overtaken: "Varasem vastus (enne muudatust): {status}",
    areaCount: "{done} / {total}",
    // S4-46 „Selle valikuga kontrolle pole.“ (the shared empty line, lists.emptyFiltered)
    things: "kontrolle",
    card: "Testimine: {open} avatud, {bad} viga",
    tg: {
      bad: "Testimine — Viga: {title} ({name})\n{note}\n{url}",
      noNote: "(märkust veel pole)",
      note: "Testimine — Märkus: {title} ({name}) · {status}\n{note}\n{url}",
    },
  },
};

export type AdminDict = typeof adminEt;
