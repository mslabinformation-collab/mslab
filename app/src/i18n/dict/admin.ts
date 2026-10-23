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
  priceRequired: "Avaldatud koolitusel peab olema hind.",
  listEt: "Igal real peab olema eestikeelne tekst.",
  tooMany: "Liiga palju ridu.",
  image: "Seda pilti ei saa kasutada. Lae pilt uuesti üles.",
  badge: "Vali märgisele üks värvidest.",
  course: "Vali koolitus.",
  date: "Sisesta kuupäev.",
  time: "Sisesta kellaaeg, näiteks 10:00.",
  capacity: "Kohtade arv peab olema 1–99.",
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
    lead: "Sisesta oma e-posti aadress, saadame sulle sisselogimislingi. Parooli pole vaja.",
    emailLabel: "E-post",
    submit: "Saada sisselogimislink",
    sending: "Saadan…",
    // The same text for an allowed and a not allowed address: the page never tells which addresses exist.
    sentTitle: "Kontrolli oma postkasti",
    sent: "Kui see aadress on lubatud, saatsime sisselogimislingi.",
    sentHint: "Link kehtib 15 minutit ja töötab ainult ühe korra.",
    again: "Sisesta aadress uuesti",
    errorEmail: "Sisesta korrektne e-posti aadress.",
    errorTooMany: "Liiga palju katseid. Proovi mõne minuti pärast.",
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
        needSellerLink: "Seaded → Arve andmed",
        submit: "Lisa {x}",
        submitSeat: "Lisa {x} · koht kinnitub",
        submitAlone: "Lisa {x} · registreering kinnitub",
        // S3-e: {x} is what is left, without the euro sign
        overRemainder: "Summa on suurem kui tasumata osa ({x} €).",
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

  // „Arved“ (invoices, phase 4 piece 2, Task 5): the registration drawer's block, the list (/admin/arved) and Seaded → „Arve andmed“. The words
  // of the spec (§2, §5) are verbatim: „Arved“, „Arve andmed“, „Arveta maksed“, „Koosta arve“, „Maksmiseks“, „Juba tasutud“, „Saada õpilasele“,
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
      needSeller: "Täida Seaded → Arve andmed",
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
      // a request Maria marked paid keeps its words as they were (ruling R10), said as the panel's first line
      undoPanel: {
        receiptQuestion: "Kas võtan kviitungi {number} tasumise tagasi?",
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
      sellerMissing: "Täida enne Seaded → „Arve andmed“.",
      bankMissing: "Täida enne Seaded → „Ettemaksu juhised“ (saaja ja IBAN).",
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
      needSeller: "Täida Seaded → Arve andmed",
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
        // some of them were invoices already made: no range
        manyLinked: "Koostatud {n} arvet.",
        // some had an invoice by now ({n})
        already: "Juba arvega: {n}.",
        // {names}: the payers whose invoice was not made
        failed: "Ei õnnestunud: {names}. Proovi uuesti.",
      },
      col: { date: "Kuupäev", payer: "Maksja", what: "Eest", amount: "Summa", invoice: "Arve" },
    },
    // Seaded → „Arve andmed“ (components/admin/InvoiceSettings.tsx)
    settings: {
      title: "Arve andmed",
      lead: "Need andmed lähevad igale uuele arvele. Väljastatud arve jääb selliseks, nagu see väljastati: hilisem muudatus puudutab ainult uusi arveid.",
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
      nextNumber: "Järgmine number",
      nextSeq: "Number",
      nextHint: "Arve number on eesliide, aasta ja number, näiteks MSL2026-001. Uue aasta esimene arve saab numbri 1.",
      // admin UX pass B21: from 1 December the next year's first number; {number}: e.g. MSL2027-001
      fromJanuary: "1. jaanuarist: {number}",
      last: "Viimati väljastatud: {number}",
      // {year}: the year the card is about
      lastNone: "{year}. aastal pole veel arveid väljastatud.",
      termDays: "Tasumise tähtaeg (päeva)",
      termDaysHint: "Mitu päeva pärast koostamist tuleb arve tasuda.",
      footer: "Arve alumine rida",
      footerHint: "Valikuline. Trükitakse arve jalusesse.",
      bank: "Pangaandmed",
      bankLead: "Arvele tulevad „Ettemaksu juhised“ andmed, nii et need on ühes kohas.",
      bankLink: "Muuda: Ettemaksu juhised",
      bankMissing: "Ettemaksu juhised on täitmata (saaja ja IBAN): pangaülekande arvet ei saa koostada.",
      save: "Salvesta arve andmed",
      saving: "Salvestan…",
      saved: "Arve andmed on salvestatud.",
      invalid: "Kontrolli märgitud välju.",
      error: "Salvestamine ei õnnestunud. Proovi uuesti.",
      sample: "Näidisarve (PDF)",
      sampleHint: "Näidis tehakse kaardi praegustest väärtustest, ka salvestamata. Midagi ei salvestata.",
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
  // (ClientDrawer.tsx), Seaded → „Lepingud“ (components/admin/ContractTexts.tsx) and the sample PDF (server/contract-sample.ts). Verbatim from the
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
    // Seaded → „Lepingud“ (components/admin/ContractTexts.tsx)
    settings: {
      title: "Lepingud",
      lead: "Õpilane kinnitab registreerimisel selle lepingu teksti. Kinnitatud leping jääb selliseks, nagu see kinnitati: hilisem muudatus puudutab ainult uusi lepinguid. Kuni siia teksti pole kirjutatud, näeb õpilane lepinguna lehe „Õppetingimused“ teksti.",
      contact: "Kontaktkoolituse leping",
      paragraphHint: "Tühi rida alustab uut lõiku.",
      // the placeholders (domain/contract.ts PLACEHOLDERS), each with what fills it
      placeholders: "Tekstis võid kasutada kohahoidjaid, mis täituvad lepingu kinnitamisel. Tundmatu sõna looksulgudes jääb tekstis alles.",
      placeholderMeaning: {
        nimi: "õpilase nimi",
        "e-post": "õpilase e-posti aadress",
        koolitus: "koolituse nimi",
        toimumine: "kuupäev ja koht",
        hind: "koolituse hind",
        ettemaks: "summa, mille õpilane maksab registreerimisel",
      },
      save: "Salvesta lepingud",
      saving: "Salvestan…",
      saved: "Lepingud on salvestatud.",
      invalid: "Kontrolli märgitud välju.",
      error: "Salvestamine ei õnnestunud. Proovi uuesti.",
      sample: "Näidisleping (PDF)",
      sampleRu: "Näidisleping vene keeles (PDF)",
      sampleHint: "Näidis tehakse kaardi praegustest väärtustest, ka salvestamata. Midagi ei salvestata.",
      // the e-course contract's title (Seaded → „E-koolituse leping (tingimused)“): the page title is the contract's, as Maria writes it (ruling R3)
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
      done: "Test on uuesti avatud: katseid jäänud {n}.",
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
    emptyFiltered: "Selle koolituse kohta pole tagasisidet.",
    col: { date: "Kuupäev", student: "Õpilane", course: "Koolitus", score: "Hinne", answers: "Vastuseid", average: "Keskmine hinne" },
    drawer: { label: "Tagasiside: {name}", notFound: "Seda tagasisidet ei leitud." },
    submitted: "Saadetud {date}",
    inRussian: "Vastas vene keeles",
    toStudent: "Õpilase juurde",
    toRegistration: "Registreeringu juurde",
    // an e-course's answer has no course day: the day her access was completed stands in its place (student reviews, Task 4; the spec's words)
    completed: "Lõpetatud {date}",
    // the page's two views (Draft): the answers, and the reviews (below, `reviews`); ?vaade=arvustused
    viewsLabel: "Vaade",
    views: { answers: "Vastused", reviews: "Arvustused" },
    // the heading's count of the reviews waiting for Maria (Draft); it opens the reviews waiting
    pendingReviews: "Arvustusi ootab kinnitust: {n}",
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
  reviews: {
    title: "Arvustused",
    lead: "Õpilaste sõnad, mida nad lubasid avaldada, ja arvustused, mille oled ise lisanud. Õpilase teksti ei saa muuta: saad selle avaldada või peita.",
    filterLabel: "Olek",
    all: "Kõik",
    status: { pending: "Ootab kinnitust", published: "Avaldatud", hidden: "Peidetud" },
    empty: "Arvustusi pole veel.",
    emptyFiltered: "Selles vaates arvustusi pole.",
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
    deleteConfirm: "Kas kustutan selle arvustuse? Seda ei saa tagasi võtta.",
    deleteYes: "Jah, kustuta",
    deleteNo: "Ei",
    working: "Salvestan…",
    deleted: "Arvustus on kustutatud.",
    // the drawer of a student (Õpilased): whether she allowed publishing and what became of it
    drawer: { allowed: "Lubab avaldada: {status}", allowedFeatured: "Lubab avaldada: {status}, avalehel", notAllowed: "Avaldamise luba pole antud.", open: "Ava arvustused" },
    form: {
      add: "Lisa arvustus",
      editTitle: "Muuda arvustust",
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
      save: "Salvesta",
      cancel: "Tühista",
      errors: { required: "Täida see väli.", tooLong: "Tekst on liiga pikk.", invalid: "Kontrolli seda välja." },
    },
    // what an action answers when it did not go through
    errors: {
      gone: "Seda arvustust enam pole — õpilane võttis loa tagasi.",
      notPublished: "Avalehel saab olla ainult avaldatud arvustus.",
      manualGone: "Seda arvustust enam pole.",
      notManual: "Õpilase sõnu ei saa muuta ega kustutada. Kui ei taha neid näidata, peida arvustus.",
      server: "Salvestamine ei õnnestunud. Proovi uuesti.",
    },
  },

  requests: {
    eyebrow: "Postkast",
    title: "Päringud",
    lead: "Kontaktivormi sõnumid, individuaalõppe soovid, praktikataotlused, ootenimekiri ja õpilaste tühistamise või ajamuutmise soovid. Tehtud päringud jäävad nimekirja lõppu.",
    tabsLabel: "Päringu liik",
    tabs: { kontakt: "Kontakt", individuaal: "Individuaal", praktika: "Praktika", ootenimekiri: "Ootenimekiri", muutmine: "Muutmine" },
    tabCount: "{n} tegemata",
    interest: "E-õppe huvi",
    handled: "Tehtud",
    open: "Uus",
    markDone: "Märgi tehtuks",
    markOpen: "Märgi tegemata",
    received: "Saabunud {date}",
    reply: "Vasta e-kirjaga",
    empty: "Selles vaates päringuid pole.",
    fields: {
      name: "Nimi",
      email: "E-post",
      phone: "Telefon",
      message: "Sõnum",
      course: "Koolitus",
      completedCourse: "Läbitud koolitus",
      package: "Pakett",
      times: "Sobivad ajad",
      period: "Soovitud periood",
      session: "Toimumine",
      locale: "Keel",
      modelHelp: "Vajab abi modelli leidmisel",
      account: "Soovib kontot",
    },
    unknownSession: "toimumine #{id}",
    // Muutmine: a student's wish from her account (the card's "Tühista või muuda aega"); the heading is the course and its date
    wishLabel: "Soov",
    wish: { cancel: "Soovib tühistada", change: "Soovib muuta aega" },
    openRegistration: "Ava registreerimine",
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
      save: "Salvesta tunnistuse andmed",
      saving: "Salvestan…",
      saved: "Tunnistuse andmed on salvestatud.",
      invalid: "Kontrolli märgitud välju.",
      error: "Salvestamine ei õnnestunud. Proovi uuesti.",
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
      save: "Salvesta",
      saving: "Salvestan…",
      saved: "Järelmaksu seade on salvestatud.",
      error: "Salvestamine ei õnnestunud. Proovi uuesti.",
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
  // (README §1.9); `switch` is the name of a preview's own switch (PreviewLangSwitch).
  i18n: {
    lang: { et: "ET", ru: "RU" },
    langName: { et: "eesti keeles", ru: "vene keeles" },
    switch: "Keel: {label}",
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

  list: {
    add: "Lisa rida",
    remove: "Eemalda rida {n}",
    up: "Liiguta rida {n} üles",
    down: "Liiguta rida {n} alla",
    empty: "Ridu veel pole.",
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
    lead: "Lisa koolituse kaardile silt, nt „Uus“ või „Populaarne“. Vali tekst ja värv — pärast salvestamist on muudatus kohe näha koolituste lehel.",
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

  courses: {
    eyebrow: "Kontaktõpe ja e-õpe",
    title: "Koolitused",
    lead: "Kõik koolitused, ka mustandid. Järjekord on sama mis avalikul lehel: muuda seda nooltega.",
    add: "Lisa koolitus",
    typeLabel: "Õppevorm",
    filter: { all: "Kõik", e: "E-õpe", k: "Kontaktõpe" },
    type: { e_learning: "E-õpe", contact: "Kontaktõpe" },
    level: { basic: "Baaskoolitus", advanced: "Täiendkoolitus" },
    col: { order: "Järjekord", course: "Koolitus", type: "Õppevorm", price: "Hind", badge: "Märgis", status: "Staatus", updated: "Muudetud" },
    published: "Avaldatud",
    draft: "Mustand",
    sample: "Näidis",
    sampleTitle: "Prototüübi näidissisu: asenda päris tekstide ja fotodega.",
    noBadge: "—",
    edit: "Muuda: {name}",
    moveUp: "Liiguta üles: {name}",
    moveDown: "Liiguta alla: {name}",
    moveError: "Järjekorra muutmine ei õnnestunud. Proovi uuesti.",
    empty: "Koolitusi veel pole.",
    emptyFiltered: "Selle õppevormiga koolitusi pole.",
    count: "Koolitusi: {n}",
    noPrice: "—",
  },

  courseEditor: {
    crumb: "Koolitused",
    editCrumb: "Muuda koolitust",
    newCrumb: "Uus koolitus",
    newTitle: "Uus koolitus",
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
      typeHint: "Koolitus on kas e-õpe või kontaktõpe. Teise õppevormi väljad eemaldatakse salvestamisel.",
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
      testUp: "Liiguta küsimus {n} üles",
      testDown: "Liiguta küsimus {n} alla",
      testRemove: "Eemalda küsimus {n}",
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
      galleryHint: "Esimene pilt on põhipilt (kaardil ja galerii alguses). Muuda järjekorda nooltega või lohista pilti.",
      main: "Põhipilt",
      image: "Pilt {n}",
      alt: "Pildi kirjeldus",
      imageUp: "Liiguta pilt {n} ettepoole",
      imageDown: "Liiguta pilt {n} tahapoole",
      imageRemove: "Eemalda pilt {n}",
      noImages: "Pilte veel pole.",
      recommendationsHint: "Vali kuni 3 koolitust, mida näidata selle koolituse lehe lõpus. Ülejäänud kohad täidetakse sarnaste koolitustega.",
      recommendationsCount: "Valitud {n} / 3",
      recommendationsMax: "Valida saab kuni 3 koolitust. Eemalda enne üks valik.",
      published: "Avaldatud",
      publishedHint: "Avaldatud koolitus on avalikul lehel nähtav. Mustandit näed ainult siin.",
      sample: "Näidissisu",
      sampleHint: "Prototüübi näidis. Eemalda märge, kui tekstid ja fotod on päris.",
    },
    save: "Salvesta",
    saving: "Salvestan…",
    saved: "Salvestatud.",
    dirty: "Salvestamata muudatused",
    invalid: "Kontrolli märgitud välju.",
    stale: "Seda koolitust salvestati vahepeal mujal (nt teises aknas). Laadi leht uuesti, et näha kehtivat seisu; sinu siinsed muudatused jäävad siis salvestamata.",
    reload: "Laadi uuesti",
    // an e-course with lessons or students keeps its type (errors.typeLocked says it for a contact course)
    typeLockedOnline: "Sellel e-koolitusel on õppetunde või õpilasi, seega õppevormi muuta ei saa. Vajadusel loo uus koolitus.",
    errors: fieldErrors,
  },

  // Koolitused → one course: "Moodulid ja õppetunnid" (an e-course) or "Programm" (a contact course: module titles only), in
  // components/admin/LessonsEditor.tsx; one lesson in the drawer (LessonDrawer.tsx) with its files (LessonFiles.tsx) and video
  // (LessonVideoField.tsx: `video`, added in Task 6).
  lessons: {
    title: "Moodulid ja õppetunnid",
    hint: "Õpilane avab õppetunnid järjekorras: järgmine avaneb, kui eelmine on tehtud.",
    saveFirst: "Salvesta koolitus, et lisada mooduleid.",
    empty: "Mooduleid veel pole.",
    moduleName: "Mooduli nimi",
    newModule: "Uue mooduli nimi",
    newItem: "Uus programmi punkt",
    addModule: "Lisa moodul",
    addItem: "Lisa punkt",
    save: "Salvesta",
    moveUp: "Liiguta üles: {title}",
    moveDown: "Liiguta alla: {title}",
    deleteModule: "Kustuta moodul",
    deleteModuleConfirm: "Kas kustutan mooduli „{title}“?",
    deleteYes: "Jah, kustuta",
    deleteNo: "Ei",
    noLessons: "Selles moodulis pole veel õppetunde.",
    newLesson: "Uue õppetunni nimi",
    addLesson: "Lisa õppetund",
    edit: "Muuda",
    editLabel: "Muuda õppetundi: {title}",
    hiddenTag: "Peidetud",
    textTag: "Tekst",
    videoTag: { none: "Video puudub", uploading: "Video üleslaadimisel", processing: "Video töötlemisel", ready: "Video {duration}", failed: "Video viga" },
    errors: {
      required: "Kirjuta nimi.",
      tooLong: "Liiga pikk.",
      inUse: "Moodulis on õppetunnid. Kustuta või tõsta need enne ära.",
      notFound: "Seda ei leitud. Laadi leht uuesti.",
      server: "Salvestamine ei õnnestunud. Proovi uuesti.",
    },
    drawer: {
      label: "Õppetund: {title}",
      name: "Õppetunni nimi",
      body: "Lühike tekst",
      bodyHint: "Näidatakse õppetunni lehel. Tühi rida alustab uut lõiku.",
      saved: "Salvestatud.",
      // closing (Esc, "Sulge", a click beside the drawer) while the name or the text is not saved: asked first
      closeQuestion: "Salvestamata muudatused lähevad kaotsi. Sulgen?",
      closeYes: "Jah, sulge",
      closeNo: "Ei",
      // "Õppetunni liik": a video lesson is done at 90 % of its video; a text lesson with "Märgi tehtuks"
      kind: {
        label: "Õppetunni liik",
        video: "Video",
        text: "Tekst",
        confirm: "Video kustutatakse. Jätkan?",
        yes: "Jah, jätka",
        no: "Ei",
      },
      visibility: "Nähtavus",
      hide: "Peida",
      show: "Näita õpilastele",
      hiddenNote: "Peidetud: õpilased seda ei näe ja see ei loe edenemises.",
      delete: "Kustuta õppetund",
      deleteConfirm: "Kas kustutan õppetunni „{title}“ koos video ja failidega?",
      inUse: "Õppetunnil on õpilaste edenemist: seda saab ainult peita.",
    },
    files: {
      title: "Failid",
      none: "Faile pole.",
      add: "Lisa fail",
      hint: "PDF, Word (.docx) või pilt (JPEG, PNG, WebP), kuni 4 MB.",
      uploading: "Laen faili üles…",
      added: "Fail lisatud.",
      remove: "Eemalda",
      removeLabel: "Eemalda fail: {name}",
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
      processing: "Töötlemisel…",
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
    col: { date: "Kuupäev", course: "Koolitus", place: "Koht", language: "Keel", seats: "Kohad", status: "Staatus" },
    seats: "{confirmed} / {capacity} kinnitatud",
    left: "Vabu kohti {n}",
    awaiting: "{n} ootab ettemaksu",
    waitlist: "Ootenimekirjas {n}",
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
    drawer: {
      newLabel: "Uus toimumine",
      editLabel: "Toimumine: {name}",
      notFound: "Seda toimumist ei leitud.",
    },
    form: {
      course: "Koolitus",
      date: "Kuupäev",
      time: "Algus",
      timeHint: "Eesti aeg.",
      city: "Linn",
      cityRequired: "Sisesta linn.",
      venue: "Toimumiskoht",
      venueHint: "nt MS LAB stuudio, Rüütli 12",
      language: "Keel",
      capacity: "Kohti",
      status: "Staatus",
      statusHint: "Tühistatud toimumine jääb avalikku kalendrisse märkega „Tühistatud“.",
      create: "Lisa toimumine",
      save: "Salvesta toimumine",
      saved: "Toimumine salvestatud.",
      registrations: "Registreerimisi: {confirmed} kinnitatud, {awaiting} ootab ettemaksu.",
    },
    remove: {
      button: "Kustuta toimumine",
      confirm: "Kas kustutan selle toimumise? Seda ei saa tagasi võtta.",
      yes: "Jah, kustuta",
      no: "Ei",
      inUse: "Sellel toimumisel on registreerimisi, seda ei saa kustutada. Märgi see hoopis „Tühistatud“: avalik leht näitab siis, et see jääb ära.",
    },
  },

  newsletter: {
    eyebrow: "Uudiskiri",
    title: "Uudiskirja tellijad",
    lead: "Tellijad liituvad ise, aadressi sisestades: kinnituskirja enam ei saadeta. Tervituskirjas on loobumislink. „Ootab kinnitust“ on aadress, mis liitus vanal viisil ega ole kinnituslinki avanud.",
    csvConfirmed: "Lae alla kinnitatud (CSV)",
    csvAll: "Lae alla kõik (CSV)",
    count: "Tellijaid: {n}, neist kinnitatud {confirmed}",
    col: { email: "E-post", locale: "Keel", consent: "Nõusolek", confirmed: "Kinnitatud" },
    pending: "Ootab kinnitust",
    empty: "Tellijaid veel pole.",
    // CSV export: header row and the yes/no column (the file is for Maria and mailing tools).
    csv: {
      filename: "mslab-uudiskiri",
      filenameConfirmed: "mslab-uudiskiri-kinnitatud",
      header: ["E-post", "Keel", "Nõusolek", "Kinnitatud", "Kinnitamise aeg"],
      yes: "jah",
      no: "ei",
    },
    // Maria's campaign editor (newsletter campaigns Task 4, `campaigns` below): the text under a field that domain/newsletter-campaign.ts
    // checkCampaignDraft refuses with `ruLabel` (a button and a Russian text, but no Russian label). Draft for Dim's wording sheet.
    campaignErrors: { ruLabel: "Lisa nupu tekst ka vene keeles." },
    // The page's two views (newsletter campaigns Task 4): the subscribers, and the campaigns (?vaade=kampaaniad). „Kampaaniad“ is the spec's (D4);
    // the rest is Draft.
    viewsLabel: "Vaade",
    views: { subscribers: "Tellijad", campaigns: "Kampaaniad" },
    // „Kampaaniad“ (newsletter campaigns Task 4; spec D4, D5; components/admin/CampaignsPanel.tsx, NewsletterCampaignEditor.tsx).
    // Quoted from the spec as they are: „Kampaaniad“, „Saada proov“, „Saada kõigile“, the confirmation „Saadad kampaania {n} tellijale (eesti keeles {a},
    // vene keeles {b}). Kas saadame?“, „Saadetud {date} · {n} tellijale“, „Kopeeri“, „Vene keeles tellijad saavad eestikeelse kirja.“ The spec marks
    // as Draft „Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval.“, „Peata saatmine“ and the two lines of `errorsOf` (`refused`, `busy`).
    // „Tühi rida alustab uut lõiku.“ is the site editors' own. Every other text here is a Draft for Dim's wording sheet.
    // {n} a count, {max} a limit, {date} a time, {a} / {b} the Estonian and the Russian counts, {sent} / {left} the mails that went and those waiting,
    // {email} an address.
    campaigns: {
      title: "Kampaaniad",
      lead: "Kiri kõigile uudiskirja tellijatele: eesti keeles ja soovi korral vene keeles. Vaata eelvaadet, saada endale proov ja siis kõigile. Mis päevas ei mahu välja, läheb järgmisel päeval.",
      list: "Kampaaniad",
      new: "Uus kampaania",
      empty: "Kampaaniaid veel pole.",
      status: { draft: "Mustand", sending: "Saatmine pooleli", sent: "Saadetud" },
      changed: "Muudetud {date}",
      notFound: "Seda kampaaniat enam pole.",
      newTitle: "Uus kampaania",
      // the editor's fields
      form: "Kampaania",
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
      // the field errors of domain/newsletter-campaign.ts checkCampaignDraft (its `ruLabel` is `campaignErrors.ruLabel` above)
      errors: { required: "Täida see väli.", tooLong: "Tekst on liiga pikk.", invalid: "Kontrolli seda välja." },
      // the live preview (the real mail, from the preview route)
      preview: "Eelvaade",
      previewSubject: "Teema",
      previewFallback: "Vene keeles tellijad saavad eestikeelse kirja.",
      previewFrame: "Kirja eelvaade: {lang}",
      previewWorking: "Uuendan eelvaadet…",
      previewError: "Eelvaadet ei saanud näidata. Proovi uuesti.",
      // the sends of a draft (spec §3): „Saada proov“ and „Saada kõigile“ with its confirmation
      send: "Saatmine",
      saveFirst: "Salvesta muudatused enne saatmist.",
      test: {
        title: "Saada proov",
        lead: "Proov on täpselt see kiri, mille tellijad saavad, teemas „[Proov]“. Selle loobumislink ei loobu kellegi uudiskirjast.",
        to: "Kellele",
        toMaria: "Maria: {email}",
        toMe: "Mina: {email}",
        language: "Keel",
        languages: { et: "Eesti keeles", ru: "Vene keeles" },
        button: "Saada proov",
        working: "Saadan proovi…",
        sent: "Proov läks aadressile {email}. Kiri jõuab mõne minuti jooksul.",
      },
      all: {
        title: "Saada kõigile",
        lead: "Enne kinnitust näed, mitmele tellijale kiri läheb. Päevas läheb välja nii palju kirju, kui mahub; ülejäänud lähevad järgmisel päeval.",
        button: "Saada kõigile",
        checking: "Vaatan tellijaid…",
        confirm: "Saadad kampaania {n} tellijale (eesti keeles {a}, vene keeles {b}). Kas saadame?",
        fallback: "Vene keeles tellijad saavad eestikeelse kirja.",
        yes: "Saada",
        no: "Tühista",
        working: "Saadan…",
        done: "Kampaania on saadetud.",
      },
      // while the coming-soon gate is on (SITE_GATE, lib/site-gate.ts) the mail's links and button open the „Tulekul“ page: a notice under the
      // confirmation of „Saada kõigile“ and under the result of „Saada proov“, never a block (final review I1, ruling R9; Draft)
      gateNotice: "Koduleht pole veel avatud — kirja lingid ja nupp viivad „Tulekul“ lehele.",
      // a campaign that is going out (status `sending`): the progress, and „Peata saatmine“ (spec §3, Draft). {sent} the mails that went, {n} every
      // subscriber it was written for, {left} those still waiting (they go the next day, or when the day has room)
      progress: "Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval.",
      // the counts that are worth a line only when they are not 0 (spec §3: a failure count is added to the sent line if there were any)
      failedLine: "Kiri ei läinud {n} aadressile: aadress ei sobinud.",
      unknownLine: "{n} kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.",
      stop: {
        button: "Peata saatmine",
        confirm: "Kas peatan saatmise? Veel saatmata {n} kirja ei lähe välja. Seda ei saa tagasi võtta.",
        yes: "Jah, peata",
        no: "Ei",
        working: "Peatan…",
        done: "Saatmine peatatud.",
      },
      // a sent campaign (read-only), and one going out
      sentLine: "Saadetud {date} · {n} tellijale",
      readOnly: "Saadetud kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.",
      readOnlySending: "Pooleli kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.",
      copy: "Kopeeri",
      copying: "Kopeerin…",
      // the copy's name: the campaign's own with this after it (cut to the name's limit)
      copySuffix: " (koopia)",
      // the page behind a test mail's unsubscribe link (/api/newsletter/loobu?proov=1, ruling R4): it changes nothing
      testPage: "Proovikiri — päris kirjas viib see link loobumisele.",
      // what an action answers when it did not go through (actions/admin-newsletter.ts); `busy` and `refused` are the spec's own (Draft), `refused`
      // is also the line of a batch that stopped because Resend refused (startSendAction's `stopped`, the page's `refused`: sendRefused)
      errorsOf: {
        notFound: "Seda kampaaniat enam pole.",
        sent: "See kampaania on juba saadetud.",
        server: "Ei õnnestunud. Proovi uuesti.",
        busy: "Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.",
        changed: "Kampaaniat või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kampaania üle ja vajuta uuesti „Saada kõigile“.",
        empty: "Kinnitatud tellijaid pole: kirja pole kellelegi saata.",
        notSending: "Selle kampaania saatmine ei ole pooleli.",
        refused: "Saatmine peatus: Resend keeldus. Kirjuta Dimile.",
        limited: "Selle tunni 10 proovi on saadetud. Proovi tunni pärast uuesti.",
        mail: "Proovi ei saanud saata. Proovi uuesti.",
        address: "Sellele aadressile ei saa proovi saata.",
      },
    },
  },
  // ---------- Task 13B: the site content editors ----------

  // The save bar and the shared pieces of the site editors (home page, practice, trainer, news, campaign, settings).
  editor: {
    save: "Salvesta",
    saving: "Salvestan…",
    saved: "Salvestatud.",
    dirty: "Salvestamata muudatused",
    clean: "Muudatusi pole.",
    invalid: "Kontrolli märgitud välju.",
    stale: "Seda osa salvestati vahepeal mujal (nt teises aknas). Laadi leht uuesti, et näha kehtivat seisu; sinu siinsed muudatused jäävad siis salvestamata.",
    reload: "Laadi uuesti",
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

  home: {
    eyebrow: "Avaleht",
    title: "Avaleht",
    lead: "Avalehe slaidid, MS LABi lause ja korduma kippuvad küsimused. Pärast salvestamist on muudatus avalehel kohe näha.",
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
      text: "Tekst",
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
      title: "Koolitaja kaart avalehel",
      lead: "Lühike tekst avalehe koolitaja kaardil nime all. Nimi, foto ja numbrid tulevad lehelt Koolitaja.",
      field: "Tekst",
      hint: "Tühjaks jättes näidatakse koolitaja tutvustuse esimest lõiku.",
    },
    faq: {
      title: "Korduma kippuvad küsimused",
      lead: "Küsimused ja vastused avalehe lõpus, selles järjekorras. Esimene on lahti.",
      item: "Küsimus {n}",
      question: "Küsimus",
      answer: "Vastus",
      add: "Lisa küsimus",
      up: "Liiguta küsimus {n} üles",
      down: "Liiguta küsimus {n} alla",
      remove: "Eemalda küsimus {n}",
      empty: "Küsimusi pole. Ilma küsimusteta plokki avalehel ei näidata.",
    },
    trainer: {
      title: "Koolitaja plokk",
      text: "Avalehe koolitaja plokk näitab koolitaja portreed, nime, tutvustuse esimest lõiku ja numbreid. Neid muudad lehel Koolitaja.",
      link: "Ava Koolitaja",
    },
  },

  practice: {
    eyebrow: "Praktika",
    title: "Praktikapaketid",
    lead: "MINI ja MAXI pakett: nimi, lühitekst, modellide arv, kestus, hind ja punktid. Salvestades uuenevad praktikaleht ja avalehe praktikaplokk.",
    package: "Pakett {code}",
    name: "Nimi",
    tagline: "Lühitekst",
    models: "Modelle",
    modelsHint: "Mitmel modellil praktika toimub.",
    duration: "Kestus",
    durationHint: "nt 8 ak. Kaardil: „≈ 8 ak“.",
    price: "Hind (€)",
    items: "Paketi punktid",
    item: "Punkt",
    itemsHint: "Iga rida on üks punkt paketi kaardil.",
    empty: "Praktikapakette pole.",
  },

  trainer: {
    eyebrow: "Koolitaja",
    title: "Koolitaja",
    lead: "Koolitaja leht: portree, nimi, tutvustus, numbrid, tööde galerii ja kaks lugu. Avalehe koolitaja plokk kasutab samu andmeid.",
    card: "Koolitaja",
    portrait: "Portree",
    portraitHint: "Püstine foto sobib kõige paremini. Fookuspunkt jääb alati nähtavale.",
    portraitWide: "Arvutis (4:5)",
    portraitNarrow: "Telefonis (4:3)",
    name: "Nimi",
    role: "Amet",
    roleHint: "Näidatakse koolitaja lehel, kui tutvustus on tühi.",
    stats: "Numbrid",
    statsHint: "Kuni 3 numbrit, nt „8+“ ja „aastat“.",
    statValue: "Number",
    statLabel: "Selgitus",
    stat: "Number {n}",
    addStat: "Lisa number",
    removeStat: "Eemalda number {n}",
    statsMax: "Numbreid saab olla kuni 3.",
    bio: "Tutvustus",
    bioHint: "Tühi rida alustab uut lõiku. Esimene lõik on ka avalehe koolitaja plokis.",
    works: "Koolitaja tööd",
    worksHint: "Pildid koolitaja lehel portree all, selles järjekorras. Muuda järjekorda nooltega või lohista pilti.",
    story: "Koolituskeskuse lugu",
    journey: "Koolitaja teekond",
    storyTitle: "Pealkiri",
    storyTitleHint: "Tühjaks jättes: „{title}“.",
    storyBody: "Tekst",
    storyHint: "Tühi rida alustab uut lõiku. Tühjaks jättes osa lehel ei näidata.",
  },

  news: {
    eyebrow: "Blogi",
    title: "Uudised",
    lead: "Kõik postitused, ka mustandid, uuemad eespool. Blogis ja avalehel on näha avaldatud postitused.",
    add: "Lisa postitus",
    col: { post: "Postitus", category: "Kategooria", date: "Kuupäev", status: "Staatus" },
    published: "Avaldatud",
    draft: "Mustand",
    edit: "Muuda: {name}",
    empty: "Postitusi veel pole.",
    count: "Postitusi: {n}",
    deleted: "Postitus kustutatud.",
  },

  post: {
    crumb: "Uudised",
    editCrumb: "Muuda postitust",
    newCrumb: "Uus postitus",
    newTitle: "Uus postitus",
    created: "Postitus loodud. Lisa kaanepilt ja avalda, kui kõik on valmis.",
    notFound: "Seda postitust ei leitud.",
    back: "Tagasi uudiste juurde",
    sections: { text: "Tekst", cover: "Kaanepilt", publish: "Avaldamine" },
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
      confirm: "Kas kustutan selle postituse? Seda ei saa tagasi võtta.",
      yes: "Jah, kustuta",
      no: "Ei",
    },
  },

  // Hüpikaken (prototype D adminCamp, Maria C38/C42 ("Meeldib, jätame.") + C43 (image upload), M3, M4; phase 2c: what the home page shows, and the
  // newsletter popup's texts and picture). Owner wording 08.10: "Avalehel", and no "nõusolek" in the newsletter lead.
  campaign: {
    eyebrow: "Turundus",
    title: "Hüpikaken",
    lead: "Avalehel kord külastuse jooksul kuvatav aken: kampaania pakkumine või uudiskirjaga liitumine. Korraga on näha üks või mitte ükski.",
    shown: "Lehel näidatakse",
    shownOptions: { campaign: "Kampaania", newsletter: "Uudiskiri", off: "Väljas" },
    form: "Kampaania",
    newsletterForm: "Uudiskiri",
    newsletterLead: "Hüpikaknas on e-posti väli ja „Liitu“. Tervituskood saadetakse alles pärast kinnitamist (Seaded → Tervituskood), aknas seda ei näidata.",
    kicker: "Silt",
    titleField: "Pealkiri",
    text: "Tekst",
    code: "Sooduskood",
    codeHint: "Tühjaks jättes koodi ei näidata.",
    ctaLabel: "Nupu tekst",
    ctaLabelHint: "Tühjaks jättes: „Leia enda koolitus“.",
    ctaHref: "Nupp viib",
    ctaHrefHint: "Koolituse või lehe aadress, nt /koolitused/lash-lift-botox, või täielik https://-aadress.",
    image: "Pilt",
    preview: "Eelvaade",
    previewNote: "Nii näeb hüpikaken välja avalehel. Laiemal ekraanil on pilt teksti kõrval.",
    off: "Seda akent avalehel praegu ei näidata.",
    copy: "Kopeeri",
    close: "Sulge",
    rules: "Reeglid",
    rulesList: [
      "Kuvatakse avalehel 6 sekundi pärast",
      "Kord külastuse jooksul",
      "Korraga üks aken: kampaania või uudiskiri",
      "Uudiskirja akent ei näidata enam brauseris, kust sellega liituti",
      "Mitte ostukorvis, tundides ega testides",
      "Sulgub Esc, ✕ või taustale vajutades, telefonis ka alla libistades",
    ],
  },

  settings: {
    eyebrow: "Seaded",
    title: "Seaded",
    lead: "Kontaktandmed, sotsiaalmeedia lingid, uudiskirja soodustus ja tervituskood, ettemaksu juhised, õigustekstid ja e-koolituse tingimused.",
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
    discount: "Tervitussoodustus",
    discountHint: "Jaluse uudiskirja plokis: „… {discount} tervitussoodustus sinu esimesele koolitusele.“ Näiteks 10%.",
    welcomeCode: "Tervituskood",
    welcomeCodeHint: "Saadetakse tervituskirjas pärast uudiskirja kinnitamist ja näidatakse avalehel kinnitusteates; hüpikaknas seda ei näidata. Tühjaks jättes koodi ei saadeta. Tähed A–Z, numbrid ja sidekriips, kuni 30 märki.",
    // where students pay the prepayment: on the unpaid contact-course cards of their account (never on a public page)
    prepayment: "Ettemaksu juhised",
    prepaymentLead: "Õpilase kontol, kontaktkoolituse kaardil, mis ootab ettemaksu.",
    prepaymentHint: "Juhised on õpilasele näha ainult siis, kui saaja ja IBAN on täidetud. Muidu ütleb kaart: „Maria saadab sulle arve“.",
    receiver: "Saaja",
    iban: "IBAN",
    bank: "Pank",
    referencePrefix: "Selgituse algus",
    referenceHint: "Makse selgitus on see algus ja registreerimise number, nt MSLAB-42. Tühjaks jättes ainult number.",
    privacy: "Privaatsus",
    terms: "Õppetingimused",
    courseTerms: "E-koolituse leping (tingimused)",
    // Draft (contracts Task 5): the text is the e-course contract, read in the cart before buying and at the terms gate of a course opened without a purchase
    courseTermsLead: "See on e-koolituse leping. Õpilane loeb seda ostukorvis enne ostmist ja nõustub sellega; ilma ostuta avatud koolituse puhul nõustub ta enne esimest avamist. Kui salvestad muudetud teksti, peab iga õpilane uuesti nõustuma.",
    pageTitle: "Pealkiri",
    pageBody: "Tekst",
    pageHint: "Tühi rida alustab uut lõiku.",
    admins: "Halduse ligipääs",
    adminsLead: "Need aadressid saavad haldusesse sisse logida. Nimekirja muudab arendaja.",
  },
  // The test page (phase 4, piece 1): /admin/testimine, the checks Maria and Dim answer. `tg` is the Telegram text of a Viga and of its first note
  // (server/testplan.ts pingText); since Dim 22.10 the first note of any answer (an OK's and a Jäta vahele's too) is a `tg.note`, which shows the answer
  // ({status}, in the button's words). `last` is "{name} · dd.mm HH:MM · {status}" (Tallinn time, the status in the button's words).
  testplan: {
    title: "Testimine",
    progress: "{done} / {total} tehtud · {bad} viga · {redo} uuesti testida",
    filter: { all: "Kõik", open: "Avatud", bad: "Vead", changed: "Muudetud" },
    who: { label: "Kes", all: "Kõik", maria: "Maria", dim: "Dim", koos: "Koos" },
    you: "Sina: {name}",
    refresh: "Värskenda",
    open: "Ava",
    expect: "Mida näed",
    why: "Miks",
    writes: "Loob andmeid",
    device: { telefon: "Telefon", tahvel: "Tahvel", arvuti: "Arvuti" },
    mark: { redo: "Uuesti testida", reworded: "Sõnastus muutus", new: "Uus" },
    ok: "OK",
    bad: "Viga",
    skip: "Jäta vahele",
    note: "Märkus",
    notePrompt: "Mis läks valesti?",
    last: "{name} · {when} · {status}",
    overtaken: "Varasem vastus (enne muudatust): {status}",
    saving: "Salvestan…",
    saved: "Salvestatud",
    retrying: "Salvestamata — proovin uuesti",
    offline: "Vastuseid ei saa praegu salvestada; need on selles seadmes alles.",
    areaCount: "{done} / {total}",
    card: "Testimine: {open} avatud, {bad} viga",
    tg: {
      bad: "Testimine — Viga: {title} ({name})\n{note}\n{url}",
      noNote: "(märkust veel pole)",
      note: "Testimine — Märkus: {title} ({name}) · {status}\n{note}\n{url}",
    },
  },
};

export type AdminDict = typeof adminEt;
