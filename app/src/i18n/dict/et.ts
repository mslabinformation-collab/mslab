// Estonian is the authoritative dictionary: ru.ts must have exactly the same keys (enforced by tests/unit/i18n.test.ts).
// Strings with {name} placeholders are filled with fill() from "@/i18n/format".
// Content that Maria edits (course texts, FAQ, news, hero slides, trainer text) lives in the database, not here.

export const et = {
  meta: {
    title: "MS LAB Koolituskeskus — Brow & Lash Academy",
    description: "Kulmu- ja ripsmekoolitused, mis annavad sulle oskused, enesekindluse ja kindla alguse.",
    ogAlt: "MS LAB Koolituskeskuse avaleht arvutis ja telefonis",
  },

  nav: {
    courses: "Koolitused",
    calendar: "Koolituskalender",
    practice: "Praktika",
    trainer: "Koolitaja",
    news: "Uudised",
    login: "Logi sisse",
    // the same header button once this browser is signed in (the `mslab_in` hint cookie, components/site/AccountLink.tsx)
    account: "Minu konto",
    cart: "Ostukorv",
    menu: "Menüü",
    langSwitch: "Vaheta keelt",
    mainLabel: "Põhimenüü",
    openMenu: "Ava menüü",
    closeMenu: "Sulge menüü",
    home: "MS LAB Koolituskeskus — avaleht",
    skip: "Liigu sisuni",
  },

  hero: {
    primaryCta: "Leia oma koolitus",
    secondaryCta: "Vaata koolituskalendrit",
    caption: "BROW & LASH ACADEMY",
    carouselLabel: "Esiletõstetud koolitused",
    carousel: "karussell",
    slide: "Slaid",
    prevSlide: "Eelmine slaid",
    nextSlide: "Järgmine slaid",
    // the pause toggle (WCAG 2.2.2): aria-pressed says whether the slides are paused
    pauseSlides: "Peata slaidide vahetumine",
  },

  // Section headings that only appear on the home page.
  home: {
    upcomingLabel: "Tulevased koolitused",
    coursesEyebrow: "Koolitused",
    coursesTitle: "Vali oma koolitus.",
    allCourses: "Kõik koolitused",
    statementEyebrow: "MS LAB Koolituskeskus",
    faqEyebrow: "KKK",
    faqTitle: "Korduma kippuvad küsimused",
    contactEyebrow: "Kontakt",
    contactTitle: "Ei tea, milline koolitus sobib?",
    contactLead: "Kirjuta Mariale — soovitan sulle sobiva koolituse ja õppevormi.",
    contactReply: "vastab tavaliselt ühe tööpäeva jooksul",
  },

  // "Kuidas soovid õppida?" block (home) and the format explainer (catalogue). Hybrid has no steps (K8).
  formats: {
    eyebrow: "Sinu õppeteekond",
    title: "Kuidas soovid õppida?",
    lead: "Enne ostu näed täpselt, kuidas õppimine käib ja mis sind lõpuks ees ootab.",
    tabsLabel: "Õppevorm",
    overviewTitle: "Õppevormid",
    howItWorks: "Kuidas see käib",
    elearning: {
      name: "E-õpe",
      short: "Veebis, omas tempos",
      question: "Mis on e-õpe?",
      definition:
        "E-õpe tähendab eelsalvestatud videokoolitust, mida saad vaadata endale sobival ajal ja kohas. Ostuga luuakse sulle automaatselt õpilase konto, kus on videod, õppematerjalid ja test.",
      facts: ["Videod ja õppematerjalid", "Test ja tunnistus", "Õpid omas tempos"],
      steps: [
        { title: "Vali sobiv koolitus", text: "Baas- või täiendkoolitus" },
        { title: "Lisa koolitus ostukorvi", text: "Näed kohe lõpphinda" },
        { title: "Vormista ost", text: "Maksa pangalingiga" },
        { title: "Sulle luuakse automaatselt õpilase konto", text: "Kinnitus tuleb e-postiga" },
        { title: "Logi sisse ja alusta õppimist", text: "Kohe, omas tempos" },
      ],
      link: "Vaata e-õppe koolitusi",
    },
    contact: {
      name: "Kontaktõpe",
      short: "Kohapeal koolitajaga",
      question: "Mis on kontaktõpe?",
      definition:
        "Kontaktõpe on füüsiline, kohapeal toimuv koolitus koolitaja juhendamisel. Valida saab individuaalkoolituse või väikese grupikoolituse vahel. Praktika toimub päris modellidel ja kõik töövahendid on kohapeal olemas.",
      facts: ["Individuaal- või grupikoolitus", "Praktika modellidel", "Vahendid kohapeal"],
      steps: [
        { title: "Vali koolitus ja kuupäev", text: "Kalendrist näed linna ja vabu kohti" },
        { title: "Registreeru ja tasu", text: "100% või 50% ettemaks" },
        { title: "Saad juhised e-postiga", text: "Aeg, koht ja ettevalmistus" },
        { title: "Koolituspäev kohapeal", text: "Teooria ja praktika modellil" },
        { title: "Tunnistus", text: "Pärast edukat lõpetamist" },
      ],
      link: "Vaata kontaktõppe koolitusi",
    },
    // Hybrid is only an explanation: a student combines an e-learning and a contact course (K1, K8). No steps, no filter.
    hybrid: {
      name: "Hübriidõpe",
      short: "E-õpe + kontaktõpe",
      question: "Mis on hübriidõpe?",
      definition:
        "Hübriidõpe tähendab, et saad e-õpet ja kontaktõpet omavahel kombineerida — näiteks läbid ühe koolituse e-õppes ja tuled teisele kontaktõppesse. Hübriidõpe ei ole eraldi valik: koostad selle ise, valides sobivad e-õppe ja kontaktõppe koolitused.",
      facts: ["E-õppe koolitus", "Kontaktõppe koolitus"],
      link: "Vaata kõiki koolitusi",
    },
  },

  catalogue: {
    title: "Leia oma koolitus.",
    intro: "Vali õppevorm ja tase. Iga õppevormi juures näed, kuidas õppimine samm-sammult käib.",
    search: "Otsi koolitust",
    formatLabel: "Õppevorm",
    levelLabel: "Tase",
    filterAll: "Kõik",
    allLevels: "Kõik tasemed",
    levelBasic: "Baaskoolitused",
    levelAdvanced: "Täiendkoolitused",
    emptyTitle: "Sobivat koolitust ei leitud",
    emptyText: "Muuda otsingut või vaata kõiki koolitusi.",
    resetFilters: "Lähtesta filtrid",
    onlineStart: "Veebis · alusta kohe",
    from: "alates",
    cardCta: "Vaata õppekava",
    // Format explainer: the hybrid card and note only explain (K1, K8); they never filter.
    readMore: "Loe lähemalt",
    hybridNote: "Soovid e-õpet ja kontaktõpet omavahel kombineerida?",
    results: "Leitud koolitusi: {n}",
  },

  course: {
    levelBasic: "Baaskoolitus",
    levelAdvanced: "Täiendkoolitus",
    modulesLabel: "Moodulid",
    videosLabel: "Õppevideod", // not "Videotunnid": "tund" reads as an hour or a lesson (Maria asked "mitu õppevideot")
    accessLabel: "Ligipääs",
    monthsUnit: "kuud",
    languageLabel: "Õppekeel",
    durationLabel: "Kestus",
    trainerLabel: "Koolitaja",
    citiesLabel: "Linnad",
    discountLabel: "Soodustus",
    priceLabel: "Hind",
    // E-learning purchase (P8, P9)
    payNow: "Maksa kohe — 100% pangalingiga",
    instalmentSoon: "Vormista järelmaks — tulekul",
    // Under the disabled instalment option; says "later" without repeating the option name.
    instalmentNote: "See võimalus lisandub hiljem.",
    buyNow: "Osta kohe",
    checkoutSoon:
      "Makse lisandub peagi — saad koolituse osta niipea, kui makse on avatud. Jäta oma e-post, anname teada.",
    includesTitle: "Koolitus sisaldab",
    // E-learning "Koolitus sisaldab" (P8): the video count line comes first, then these.
    includesVideos: "{n} õppevideot",
    includesElearning: [
      "Õppematerjalid",
      "Teadmiste test",
      "Praktilise töö hindamine",
      "Tunnistus pärast edukat lõpetamist",
    ],
    descriptionTitle: "Koolitusest",
    programmeTitle: "Õppekava",
    outcomesTitle: "Pärast koolitust oskad",
    locked: "Lukustatud",
    breadcrumb: "Lehe asukoht",
    thumbsLabel: "Kõik pildid",
    prevThumbs: "Eelmised pildid",
    nextThumbs: "Järgmised pildid",
    individualNote: "Individuaalkoolituse aja ja tasumise lepime kokku. Märgi soovitud periood — Maria võtab sinuga ühendust.",
    // No group date can be picked (none, all full or cancelled): offer the individual course instead.
    switchIndividual: "Vali individuaalkoolitus",
    sessionRequired: "Vali sobiv kuupäev.",
    // The picked date filled up or was cancelled while the form was open (checked again when the form is sent).
    sessionFull: "See kuupäev on vahepeal täitunud. Vali teine kuupäev.",
    sessionUnavailable: "Sellele kuupäevale ei saa enam registreeruda. Vali teine kuupäev.",
    // Contact course registration (P10 - P15)
    participationLabel: "Osalemisviis",
    group: "Grupikoolitus",
    individual: "Individuaalkoolitus",
    pickSession: "Vali kuupäev ja linn",
    noSessions: "Uued kuupäevad avaldatakse peagi.",
    modelsNote: "Võid tulla oma modellidega; vajadusel aitame leida.",
    confirmAfterPrepayment: "Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.",
    registerSuccess:
      "Registreerimine on vastu võetud. Saadame sulle e-postiga makse juhised; koht kinnitub pärast ettemaksu.",
    // Both types
    share: "Jaga koolitust",
    shareCopied: "Koolituse link kopeeritud.",
    // ♡ toggle (P6): "favourite" until pressed, then "favourited"; "unfavourite" is the pressed button's hint
    favourite: "Lisa lemmikutesse",
    favourited: "Lemmikutes",
    unfavourite: "Eemalda lemmikutest",
    // under the ♡ when a signed-in press could not be saved (the heart is put back)
    favouriteFailed: "Ei õnnestunud. Proovi uuesti.",
    recommendations: "Sulle võiksid huvi pakkuda",
    galleryLabel: "Koolituse pildid",
  },

  calendar: {
    title: "Koolituskalender",
    lead: "Iga koolituse juures on kohe näha linn, õppevorm, keel ja vabade kohtade arv.",
    cityLabel: "Linn",
    allCities: "Kõik linnad",
    seatsLabel: "Vabu kohti",
    stateOpen: "Vabu kohti",
    stateFew: "Viimased kohad",
    stateFull: "Kohad täis", // prototype B's wording (checklist, Task 2 ruling)
    stateCancelled: "Tühistatud",
    register: "Registreeru",
    // Row buttons (prototype A): full → waitlist form, cancelled → the course page with its other dates.
    waitlist: "Liitu ootenimekirjaga", // prototype B's wording (C49)
    others: "Vaata teisi",
    empty: "Selles linnas hetkel koolitusi pole.",
    results: "Kuupäevi: {n}",
  },

  practice: {
    title: "Praktika",
    eyebrow: "Individuaalpraktika",
    onlyParnuShort: "Ainult Pärnus",
    // Home practice block eyebrow above the big "Praktika" heading (H11, C22).
    eyebrowParnu: "Individuaalpraktika · ainult Pärnus",
    onlyParnu: "Praktika toimub ainult Pärnus, MS LAB stuudios.",
    slogan: "Teadmised muutuvad oskusteks.",
    lead: "Harjuta, küsi ja katseta. Üks-ühele juhendamine aitab leida sinu käekirja ja järgmise arengusammu.",
    intro:
      "Praktikapäev on mõeldud kõigile, kes on koolituse läbinud ja soovivad enne iseseisvat tööd rohkem kogemust — päris modellidel, koolitaja kõrval.",
    panelText:
      "Praktika toimub koolitaja juhendamisel. Õpilasele leiab koolituskeskus vajalikud modellid ning tagab kõik tööks vajalikud vahendid. Koolitaja jälgib kogu tööprotsessi, annab jooksvalt juhiseid, näpunäiteid ja tagasisidet.",
    protocolTitle: "Praktikaprotokoll",
    protocolText:
      "Kogu praktika vältel täidab koolitaja praktikaprotokolli, mis annab kokkuvõtte kogu praktikapäevast. Pärast praktikat saad protokolli endale — see on sinu personaalne tagasiside.",
    protocolPoints: ["Mis õnnestus hästi", "Millele pöörata tähelepanu", "Mida veel arendada"],
    packagesEyebrow: "Praktikapaketid",
    packagesTitle: "Vali praktikapakett.",
    package: "Praktikapakett",
    duration: "Umbkaudne kestus",
    register: "Registreeru",
    requestTitle: "Registreeru praktikale",
    selectedPackage: "Valitud pakett: {name}",
    completedCourse: "Läbitud koolitus või kogemus",
    preferredTimes: "Millised ajad sulle sobivad?",
    preferredTimesPlaceholder: "Näiteks tööpäeva õhtud Pärnus",
    requestNote: "See on aja kokkuleppimise taotlus. Kohtumine kinnitatakse pärast Maria vastust.",
    requestSubmit: "Saada taotlus",
    requestSent: "Taotlus on saadetud.",
    requestSentText: "Maria võtab sinuga ühendust ja pakub sobiva aja.",
    packageRequired: "Vali praktikapakett.",
  },

  trainer: {
    eyebrow: "Sinu koolitaja",
    pageEyebrow: "Koolitaja",
    readMore: "Loe koolitajast",
    portraitAlt: "Koolitaja {name}",
    worksTitle: "Koolitaja tööd",
    storyTitle: "Koolituskeskuse lugu",
    journeyTitle: "Koolitaja teekond",
    viewCourses: "Vaata koolitusi",
  },

  news: {
    eyebrow: "Blogi",
    title: "Uudised ja nõuanded",
    lead: "Nõuanded, uued koolitused ja õpilaste lood. Iga kaart viib täismahus postitusele.",
    all: "Kõik postitused",
    readMore: "Loe edasi",
    more: "Loe veel",
    carouselLabel: "Postituste karussell",
    // /uudised (prototype D pNewsList: eyebrow "Uudised ja nõuanded", heading "Blogi.").
    pageTitle: "Blogi.",
    coursesCta: "Vaata koolitusi",
  },

  forms: {
    name: "Nimi",
    email: "E-post",
    phone: "Telefon",
    message: "Sõnum",
    messagePlaceholder: "Nt. olen algaja ja huvitun kulmudest…",
    submit: "Saada",
    sending: "Saadan…",
    register: "Registreeru",
    terms: "Olen tutvunud tingimustega ja nõustun nendega.",
    // Contact-course registration extras (P11, P14, P16)
    modelHelp: "Soovin koolituskeskuse abi modellide leidmisel",
    createAccount: "Loo mulle kohe konto MS LAB keskkonda",
    // the registration forms' newsletter consent (phase 2c): unticked; ticked, the newsletter's own sign-up follows
    newsletterConsent: "Soovin MS LABi uudiseid ja pakkumisi",
    paymentLabel: "Tasumine",
    payFull: "100% kohe",
    payHalf: "50% registreerimisel + 50% koolituspäeval",
    // P14: shown on contact courses, disabled (as the e-course's instalment) until the instalment partner arrives
    payInstalment: "Järelmaks — tulekul",
    payInstalmentNote: "See võimalus lisandub hiljem.",
    // Individual request, waitlist, cart interest
    preferredPeriod: "Soovitud periood või kuupäev",
    preferredPeriodPlaceholder: "Nt detsembri teine pool või 12.12",
    optional: "valikuline",
    requestSubmit: "Saada päring",
    interestSubmit: "Anna mulle teada",
    waitlistTitle: "Liitu ootenimekirjaga",
    waitlistLead: "Jäta oma e-post ja anname teada, kui koht vabaneb või lisandub uus kuupäev.",
    waitlistSubmit: "Liitu ootenimekirjaga",
    // Contact page
    contactPageTitle: "Alustame vestlusest.",
    contactPageLead: "Küsimus koolituse, praktika või koostöö kohta? Jäta oma mõte siia.",
    contactDetails: "Kontaktandmed",
    address: "Asukoht",
    // Results and errors
    contactSent: "Aitäh! Sinu sõnum on saadetud.",
    individualSent: "Aitäh! Sinu päring on saadetud.",
    waitlistSent: "Aitäh! Oled ootenimekirjas.",
    interestSent: "Aitäh! Anname teada, kui makse on avatud.",
    errorRequired: "See väli on kohustuslik.",
    errorEmail: "Sisesta korrektne e-posti aadress.",
    errorGeneric: "Midagi läks valesti. Proovi uuesti.",
    errorTooMany: "Liiga palju katseid. Proovi mõne minuti pärast.",
  },

  footer: {
    tagline: "Õpilase edu on meie eesmärk. Õpi. Arene. Loo.",
    learnTitle: "Sinu õpiteekond",
    allCourses: "Kõik koolitused",
    orgTitle: "MS LAB",
    news: "Uudised ja inspiratsioon",
    contact: "Kontakt ja koostöö",
    meetTitle: "Kohtume sinu järgmisel sammul.",
    cities: "Pärnu · Tallinn · Tartu",
    online: "Veebis kõikjal sinuga.",
    contactCta: "Võta ühendust",
    copyright: "© {year} MS LAB Koolituskeskus",
    privacy: "Privaatsus",
    terms: "Õppetingimused",
  },

  // Newsletter block, placed inside the footer (H13). {discount} comes from the newsletter setting, e.g. "10%".
  newsletter: {
    eyebrow: "MS LABi kirjad",
    titleFirst: "Hea järgmine samm.",
    titleSecond: "Otse sinu postkasti.",
    body: "Uued koolitused, kasulikud mõtted ja {discount} tervitussoodustus sinu esimesele koolitusele.",
    emailLabel: "Sinu e-post",
    emailPlaceholder: "nimi@e-post.ee",
    submit: "Liitu",
    // The line under "Liitu", before the link "Privaatsus" (footer.privacy): the form's only purpose is the newsletter, so sending it is the consent.
    notice: "Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda.",
    // The answer after "Liitu" (the footer, the coming-soon page): one step since 09.10, the address is subscribed and the welcome mail is on its way.
    sentTitle: "Aitäh, oled liitunud!",
    sentText: "Saatsime sulle tervituskirja.",
    // the newsletter popup's answer after a sign-up (components/site/NewsletterPopup.tsx, phase 2c): title and line in one
    popupSent: "Aitäh, oled liitunud! Saatsime sulle tervituskirja.",
    // Home page notice after the unsubscribe link of the welcome mail (/?uudiskiri=loobutud).
    unsubscribedTitle: "Oled uudiskirjast loobunud.",
    unsubscribedText: "Me ei saada sulle enam MS LABi uudiskirja.",
    // The page behind the unsubscribe link (GET /api/newsletter/loobu?t=…, server/unsubscribe-page.ts): the link only opens it, the button unsubscribes.
    unsubscribePage: {
      heading: "Uudiskirjast loobumine",
      lead: "Vajuta nuppu, et MS LABi uudiskirjast loobuda.",
      button: "Loobu uudiskirjast",
    },
    // The notices after a confirmation link of the old flow, still in some mailboxes (/?uudiskiri=kinnitatud or =vigane).
    confirmedTitle: "Tere tulemast MS LABi!",
    confirmedText: "Sinu liitumine on kinnitatud.",
    // the confirmed notice's line when Seaded has a welcome code (the confirmation link's #kood=…, phase 2c)
    codeLine: "Sinu tervituskood: {code}. Lisa kood registreerimisel lahtrisse „Sõnum“.",
    linkInvalid: "See kinnituslink ei kehti. Liitu uudiskirjaga uuesti lehe allosas.",
  },

  // E-mails to visitors. The newsletter's only mail is the welcome mail (server/account-mail.ts welcomeMail), sent as soon as the address is
  // subscribed (one step, 09.10).
  mail: {
    welcome: {
      subject: "Tere tulemast MS LABi!",
      intro: "Aitäh, et liitusid MS LABi uudiskirjaga.",
      // the next three lines only when Seaded has a "Tervituskood"
      codeIntro: "Sinu tervituskood:",
      use: "Lisa kood registreerimisel lahtrisse „Sõnum“.",
      invoice: "Maria arvestab soodustuse sinu arvelt maha.",
      // the last line before the signature; {link} is the unsubscribe URL (/api/newsletter/loobu?t=<the subscriber's token>)
      unsubscribe: "Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: {link}",
    },
  },

  // /ostukorv: e-learning purchase placeholder until bank-link payment arrives (P9).
  cart: {
    title: "Ostukorv",
    emptyTitle: "Ostukorv on tühi",
    emptyText: "Vali endale sobiv e-koolitus — selle saad osta kohe, kui makse avaneb.",
    total: "Kokku",
  },

  // Online payments (phase 2b, spec 9). {amount} is euros ("175 €"), {title} the course, {date} the last day of an e-course's access. The
  // buttons are the card's (components/account/AccountCourseCard.tsx), the mail's, the /maksa page's (server/pay-page.ts) and the cart's.
  payment: {
    pay: "Maksa {amount}",
    payRest: "Maksa ülejäänud {amount}",
    transfer: "või tasu pangaülekandega",
    // the button while the payment page is being opened
    starting: "Avan makse…",
    // the e-course cart when Montonio did not open the payment: the line above the purchase-interest form (owner's wording, 09.10)
    cartDown: "Makse ei avanenud. Jäta oma e-post, anname teada.",
    // the page behind the mail's "Maksa" link (/maksa/<token>)
    page: {
      heading: "Koolituse eest tasumine",
      nothing: "Selle registreeringu eest pole praegu midagi tasuda.",
      full: "See koolitus on täis. Võta ühendust Mariaga.",
    },
    // the page the bank sends the payer back to (/makse#tulemus=…, components/site/PaymentResult.tsx)
    result: {
      title: "Makse",
      paid: "Makse õnnestus. Saatsime sulle kinnituse e-postiga.",
      // an e-course's purchase (owner's wording, 09.10): a buyer who is not signed in learns where her login is
      paidEcourse: "Makse õnnestus.",
      paidEcourseText: "Saatsime sulle e-postiga sisselogimislingi.",
      pending: "Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.",
      cancelled: "Makse jäi tegemata.",
      retry: "Proovi uuesti",
      openCourse: "Ava e-koolitus",
    },
    // the mails after a payment (server/account-mail.ts registrationPaidMail, ecourseOpenMail)
    mail: {
      subjectConfirmed: "Koht on kinnitatud — {title}",
      subjectReceived: "Makse on kätte saadud — {title}",
      subjectEcourse: "E-koolitus on avatud — {title}",
      leadConfirmed: "Makse on kätte saadud. Sinu koht on kinnitatud.",
      leadReceived: "Makse on kätte saadud. Aitäh!",
      leadEcourse: "Makse on kätte saadud. E-koolitus on sinu jaoks avatud.",
      paid: "Tasutud",
      rest: "Ülejäänud {amount} tasud koolituspäeval või Minu koolitused lehel.",
      allPaid: "Kogu summa on tasutud.",
      full: "Koolitus on vahepeal täitunud, nii et koht jäi kinnitamata. Maria võtab sinuga ühendust.",
      notConfirmed: "Maria võtab sinuga ühendust.",
      access: "Ligipääs kuni {date}.",
    },
  },

  // Campaign popup. No "Mitte praegu" button (M3); the CTA label is editable in admin, this is the default (M4).
  campaign: {
    cta: "Leia enda koolitus",
    codeLabel: "Sooduskood",
    copy: "Kopeeri",
    copied: "Kopeeritud",
    // when the browser gives no clipboard: the code is selected for the visitor to copy
    selected: "Kood on märgitud.",
  },

  common: {
    siteName: "MS LAB Koolituskeskus",
    home: "Avaleht",
    close: "Sulge",
    previous: "Eelmine",
    next: "Järgmine",
    imageViewer: "Pildivaatur",
    openImage: "Ava pilt suuremalt",
  },

  // The client account (server/account-mail.ts). The login e-mail has a plain-text and an HTML body, both put together
  // from these parts: the greeting, the code intro, the 6-digit code, `useCode`, `orLink`, the sign-in link (the button
  // in HTML), `valid`, `ignore` and the signature. {code} in the subject is the code.
  account: {
    mail: {
      subject: "{code} — MS LAB sisselogimiskood",
      greeting: "Tere!",
      codeIntro: "Sinu sisselogimiskood:",
      useCode: "Sisesta see kood lehel, kus alustasid sisselogimist.",
      orLink: "Või ava see link, et logida sisse:",
      button: "Logi sisse",
      valid: "Kood ja link kehtivad 30 minutit.",
      ignore: "Kui sa ei palunud sisselogimist, võid selle kirja kustutada.",
      signature: "MS LAB Koolituskeskus",
      // The e-mail to a visitor who registered or sent a request (account-mail.ts registrationConfirmationMail,
      // requestConfirmationMail). {title} is the course or the practice package. The next-step sentence, the payment
      // rows and "Koht kinnitatakse …" are the account's own (`next`, `dashboard.payment`, `course.confirmAfterPrepayment`),
      // so the e-mail and the dashboard say the same (a request says `next.requestNew`, a waitlist entry `next.waitlist`). With a
      // login code the e-mail has the code and "Logi sisse" (`button`) instead of `open`: one button only; under the 30 minutes
      // a small text link (`codeHere` + `codeLink`) opens the login page at its code step, for typing the code there.
      confirm: {
        subjectRegistration: "Registreering on vastu võetud — {title}",
        subjectRequest: "Päring on vastu võetud — {title}",
        subjectWaitlist: "Oled ootenimekirjas — {title}",
        registration: "Registreering on vastu võetud.",
        open: "Ava minu konto",
        codeHere: "Kui nupp ei tööta, sisesta kood siin:",
        codeLink: "Ava sisselogimine",
      },
    },
    // The e-mail that confirms an account deletion (account-mail.ts deletionMail): the greeting and signature are `mail`'s.
    deleted: {
      subject: "MS LAB konto on kustutatud",
      line: "Sinu MS LAB konto on kustutatud.",
      kept: "Sinu registreeringud jäävad Mariale alles.",
    },
    // The mail after the password was set, changed or removed (account-mail.ts passwordChangedMail, phase 2c): {email} is Maria's
    // address from Seaded (the contact), `notYou` the line without one.
    passwordMail: {
      subject: "MS LABi konto parool on muudetud",
      line: "Sinu MS LABi konto parool on muudetud.",
      notYou: "Kui see polnud sina, kirjuta kohe Mariale.",
      notYouAt: "Kui see polnud sina, kirjuta kohe Mariale: {email}",
    },
    // The one sentence on each course card (domain/account-cards.ts nextStep): `{amount}` and `{rest}` are euros ("175 €"),
    // `{date}` the last day of an e-course access ("22.03.2027"). A session's date, time and place are on the card's own
    // line, so the sentences do not repeat them.
    next: {
      cancelled: "Registreering on tühistatud.",
      done: "Koolitus on toimunud. Aitäh!",
      pay: "Koha kinnitamiseks tasu ettemaks {amount}.",
      invoice: "Maria saadab sulle arve ettemaksu tasumiseks.",
      confirming: "Makse on laekunud. Maria kinnitab su koha.",
      confirmedRest: "Koht on kinnitatud. Ülejäänud {rest} tasud koolituspäeval.",
      confirmed: "Koht on kinnitatud.",
      individualPending: "Maria võtab sinuga ühendust, et aeg kokku leppida.",
      requestNew: "Päring on saadetud. Maria vastab peagi.",
      requestDone: "Maria on päringule vastanud.",
      waitlist: "Oled ootenimekirjas. Anname teada, kui koht vabaneb.",
      accessEnded: "Ligipääs on lõppenud.",
      openCourse: "Ligipääs kuni {date}.",
    },
    // The account pages' frame (components/account/AccountShell.tsx): the three tabs (top on a computer, a bar at the
    // bottom on a phone) and the round menu button with "Logi välja".
    shell: {
      label: "Minu konto",
      courses: "Minu koolitused",
      favourites: "Lemmikud",
      details: "Minu andmed",
      menu: "Konto menüü",
      logout: "Logi välja",
      logoutFailed: "Väljalogimine ei õnnestunud. Proovi uuesti.",
    },
    // "Minu koolitused" /konto (components/account/CoursesTab.tsx and the card parts). {name} is the first name.
    dashboard: {
      hello: "Tere, {name}!",
      helloNoName: "Tere!",
      lead: "Siin on sinu koolitused.",
      filterLabel: "Näita",
      all: "Kõik",
      upcoming: "Tulevased",
      past: "Möödunud",
      listLabel: "Sinu koolitused",
      tag: { contact: "Kontaktõpe", ecourse: "E-õpe", request: "Päring", waitlist: "Ootenimekiri" },
      // a card whose course or practice package is gone
      untitled: { individual: "Individuaalkoolitus", practice: "Praktika", course: "Koolitus" },
      // the card's one button
      pay: "Vaata juhiseid",
      payHide: "Peida juhised",
      change: "Tühista või muuda aega",
      open: "Ava koolitus",
      empty: "Sul ei ole veel koolitusi.",
      browse: "Vaata koolitusi",
      // The dark "Pooleli" card at the top (components/account/ResumeCard.tsx) and the e-course cards' lessons (phase 2c): {module} and
      // {lesson} are the next lesson's module and title, {done} and {total} count the lessons. "Jätka" ("Alusta" before the first one is
      // done) opens the next lesson; a finished course says "Läbitud ✓".
      resumeTag: "Pooleli",
      resumeWhere: "{module} · {lesson}",
      resumeProgress: "{done} / {total} õppetundi tehtud",
      resumeContinue: "Jätka",
      resumeBegin: "Alusta",
      lessonCount: "{done} / {total}",
      finished: "Läbitud ✓",
      loading: "Laadin koolitusi…",
      // where to pay the prepayment (components/account/PrepaymentInfo.tsx); "Selgitus" is the bank transfer's explanation field
      payment: {
        receiver: "Saaja",
        iban: "IBAN",
        bank: "Pank",
        amount: "Summa",
        reference: "Selgitus",
        after: "Pärast makset kinnitab Maria su koha.",
        copy: "Kopeeri",
        copied: "Kopeeritud",
        // when the browser gives no clipboard: the text is selected for the student to copy
        selected: "Tekst on märgitud. Kopeeri see.",
      },
      // "Tühista või muuda aega" (components/account/ChangeRequestDialog.tsx)
      request: {
        question: "Mida soovid?",
        cancel: "Soovin tühistada",
        change: "Soovin muuta aega",
        message: "Sõnum Mariale (kui soovid)",
        send: "Saada",
        close: "Sulge",
        pick: "Vali üks neist.",
        sent: "Saadetud. Maria võtab sinuga ühendust.",
        // the registration was cancelled or has begun meanwhile
        notAllowed: "Seda registreeringut ei saa enam muuta. Võta Mariaga ühendust.",
        rate: "Oled saatnud juba mitu soovi. Proovi tunni aja pärast uuesti.",
        failed: "Saatmine ei õnnestunud. Proovi uuesti.",
      },
    },
    // The login page /konto/sisene (components/account/LoginForm.tsx): the e-mail, then the 6-digit code from the e-mail.
    // {fixed} is the address with its domain corrected, {email} the address the code went to, {s} the seconds left.
    login: {
      email: "E-post",
      send: "Saada kood",
      typo: "Kas mõtlesid {fixed}?",
      typoYes: "Jah, paranda",
      typoNo: "Ei, saada nii",
      sent: "Saatsime 6-kohalise koodi aadressile {email}.",
      code: "Kood",
      submit: "Logi sisse",
      // Enter (a phone's "Go") before the sixth digit
      allDigits: "Sisesta kõik 6 numbrit.",
      spam: "Ei leia kirja? Vaata ka rämpsposti kausta.",
      resend: "Saada uus kood",
      // instead of "Saada uus kood" during the first 60 s after a code was sent
      resendIn: "Uue koodi saad saata {s} s pärast.",
      resent: "Saatsime uue koodi.",
      // under "Saada uus kood" once a new code was asked for: the server answers the same whether or not a mail went out (no
      // account enumeration), and an address with 3 logins in 30 minutes gets none for a while (server/client-auth.ts CLIENT_LOGIN_CAP)
      noMail: "Kui kirja ei tule, proovi poole tunni pärast uuesti.",
      changeEmail: "Muuda e-posti",
      // the password (phase 2c): a quiet link under the e-mail step, its own step (#parool), and the way back to the code
      toPassword: "Sisene parooliga",
      password: "Parool",
      toCode: "Saada mulle hoopis kood",
      passwordWrong: "E-post või parool ei sobi.",
      passwordLocked: "Liiga palju katseid. Proovi 15 minuti pärast uuesti või sisene koodiga.",
      wrongCode: "Kood ei sobi. Proovi uuesti.",
      expired: "Kood on aegunud. Saada uus kood.",
      // #viga=link: the e-mail's button was used already, or is older than 30 minutes
      linkExpired: "Link on aegunud või juba kasutatud. Saada uus kood.",
      rate: "Liiga palju katseid. Proovi mõne minuti pärast uuesti.",
      server: "Midagi läks valesti. Proovi uuesti.",
    },
    // Every account page while its data loads (components/account/AccountLoader.tsx): another device signed in (one
    // device only), or the data could not be loaded.
    loader: {
      replaced: "Sinu konto avati teises seadmes",
      sendCode: "Saada uus kood",
      loading: "Laadin…",
      loadError: "Ei õnnestunud laadida.",
      retry: "Proovi uuesti",
    },
    // The e-course page /konto/kursus/<slug> (components/account/EcoursePage.tsx, TermsGate.tsx, EcourseView.tsx). {date} is the last
    // day of access. The terms text itself is the admin's (Seaded, "E-koolituse tingimused"). A locked lesson's label is `course.locked`.
    // The course's one button is "Jätka" ("Alusta" before the first lesson), to the next open lesson that is not done; {done} and
    // {total} count the lessons (`moduleProgress`: one module's, for screen readers, where the page shows "1/2"). Each lesson's
    // state is an icon (✓ done, ▶ open, lock) with these words for screen readers, and the lock sentence stands under the first
    // locked lesson (and on a locked lesson's page, with "Jätka").
    ecourse: {
      noAccess: "Sul ei ole sellele koolitusele ligipääsu.",
      viewCourse: "Vaata koolitust",
      termsTitle: "Enne alustamist",
      termsAccept: "Olen tutvunud ja nõustun tingimustega",
      start: "Alusta koolitust",
      // the acceptance could not be stored (the checkbox stays ticked)
      termsFailed: "Ei õnnestunud salvestada. Proovi uuesti.",
      access: "Ligipääs kuni {date}",
      soon: "Sisu lisandub peagi.",
      resume: "Jätka",
      lockedHint: "Avaneb, kui eelmine õppetund on tehtud.",
      begin: "Alusta",
      progress: "{done} / {total} õppetundi tehtud",
      stateDone: "Tehtud",
      stateCurrent: "Avatud",
      moduleProgress: "{done} / {total} tehtud",
    },
    // one lesson /konto/kursus/<slug>/<lesson> (components/account/LessonPage.tsx, LessonPlayer.tsx): one button, "Järgmine õppetund"
    // (or "Märgi tehtuks" in its place while a text lesson is not done), and a quiet way back. {name} is a file's name, {title} the lesson's.
    // `seekLocked`: the line under the player after a jump forward was taken back (phase 2c).
    lesson: {
      back: "Tagasi koolitusele",
      next: "Järgmine õppetund",
      files: "Failid",
      download: "Lae alla",
      downloadFile: "Lae alla: {name}",
      soon: "Video lisandub peagi",
      videoError: "Video ei lae. Proovi hiljem uuesti.",
      done: "Õppetund tehtud ✓",
      markDone: "Märgi tehtuks",
      saving: "Salvestan…",
      failed: "Ei õnnestunud salvestada. Proovi uuesti.",
      notFound: "Seda õppetundi ei leitud.",
      fullscreen: "Täisekraan",
      exitFullscreen: "Välju täisekraanist",
      video: "Video: {title}",
      seekLocked: "Edasi saab kerida kuni kohani, kuhu oled jõudnud.",
    },
    // "Lemmikud" /konto/lemmikud (components/account/FavouritesTab.tsx): the hearted courses as the catalogue's cards, each with ♡ to
    // take it off. {title} is a course's title (the button's name for a screen reader, and what was taken off).
    favourites: {
      title: "Sinu lemmikud",
      remove: "Eemalda lemmikutest",
      removeCourse: "Eemalda lemmikutest: {title}",
      removed: "Eemaldatud lemmikutest: {title}",
      removeFailed: "Ei õnnestunud eemaldada. Proovi uuesti.",
      empty: "Lisa koolitus lemmikuks ♡ koolituse lehel.",
      browse: "Vaata koolitusi",
      loading: "Laadin lemmikuid…",
    },
    // "Minu andmed" /konto/andmed (components/account/DetailsTab.tsx): name, phone and language with one "Salvesta"; the newsletter
    // switch saves at once; the optional password; "Kustuta konto" at the very bottom with one confirmation step. Each language's name is in that language.
    details: {
      title: "Sinu andmed",
      email: "E-post",
      name: "Nimi",
      phone: "Telefon",
      language: "Keel",
      languages: { et: "Eesti keel", ru: "Русский язык" },
      save: "Salvesta",
      saved: "Salvestatud.",
      saveFailed: "Ei õnnestunud salvestada. Proovi uuesti.",
      newsletter: "Saada mulle uudiskirja",
      delete: "Kustuta konto",
      deleteQuestion: "Kas kustutame su konto? Sinu registreeringud jäävad Mariale alles.",
      deleteYes: "Jah, kustuta",
      deleteNo: "Tühista",
      deleteFailed: "Kustutamine ei õnnestunud. Proovi uuesti.",
      // the home page's notice after the deletion (/#konto-kustutatud)
      deleted: "Konto on kustutatud.",
      // "Parool" (components/account/PasswordSection.tsx, phase 2c): optional, next to the e-mail code. {date} is the last change.
      password: {
        title: "Parool",
        none: "Saad soovi korral määrata parooli ja siseneda edaspidi e-posti ja parooliga. Kood töötab alati edasi.",
        isSet: "Parool on määratud (muudetud {date}).",
        set: "Määra parool",
        change: "Muuda parooli",
        remove: "Eemalda parool",
        newPassword: "Uus parool",
        repeat: "Korda parooli",
        save: "Salvesta parool",
        cancel: "Tühista",
        short: "Parool peab olema vähemalt 10 märki.",
        long: "Parool võib olla kuni 200 märki.",
        email: "Parool ei tohi olla sinu e-posti aadress.",
        mismatch: "Paroolid ei ühti.",
        saved: "Parool on salvestatud.",
        removed: "Parool on eemaldatud.",
        removeQuestion: "Kas eemaldame parooli? Saad edasi siseneda koodiga.",
        removeYes: "Jah, eemalda",
        failed: "Ei õnnestunud salvestada. Proovi uuesti.",
        removeFailed: "Ei õnnestunud eemaldada. Proovi uuesti.",
        rate: "Oled parooli juba mitu korda muutnud. Proovi tunni aja pärast uuesti.",
      },
      loading: "Laadin andmeid…",
    },
  },

  // Localized 404 inside the site shell.
  notFound: {
    title: "Lehte ei leitud",
    text: "Seda lehte ei ole olemas või on see teisaldatud.",
    home: "Avalehele",
  },

  // The coming-soon page (app/tulekul/[locale]): all a visitor sees until the launch (SITE_GATE, lib/site-gate.ts).
  // Its <title> is common.siteName; the sign-up is the newsletter's own (newsletter, forms).
  gate: {
    title: "Uus koduleht on peagi valmis.",
    lead: "Liitu uudiskirjaga — anname teada, kui avame.",
    logo: "MS LAB",
    // the notice after a confirmation link that does not work (the form is right below the heading here)
    linkInvalid: "See kinnituslink ei kehti. Liitu uudiskirjaga uuesti.",
  },
};

export type Dict = typeof et;
