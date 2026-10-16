import type { I18n } from "@/i18n/field";
import { slugify } from "@/lib/slug";
import type { Badge } from "./schema";
import type { CampaignInput, CourseInput, HeroSlideInput, PostInput, PracticePackageInput, SessionInput } from "./queries/admin";
import { seedSessionStart } from "./seed-dates";
import { DARK_MOBILE_FOCAL } from "@/domain/site-editor";
import { TERMS_PAGE_KEY, TERMS_PAGE_TITLE } from "@/domain/course-terms";

/**
 * Prototype content that fills the site on day one (spec section 7). Texts come from prototype B (ET + RU)
 * and prototype D (ET). The Russian texts that prototype B did not have were added in round 2 (item 1a) as drafts for
 * a native speaker's check (task-16-report.md, "Fix round 2"). All courses are sample data.
 * Pure data: no database access, no Cloudflare bindings.
 */

const t = (et: string, ru?: string): I18n => (ru === undefined ? { et } : { et, ru });

/** Static image paths under app/public/seed (see mediaUrl). */
const img = (name: string) => `/seed/${name}`;

export { slugify }; // moved to src/lib/slug.ts (the admin editors use it too)

// ---------- shared texts (prototype B, ET + RU) ----------

const detailLead = t(
  "Teooriast esimese iseseisva tulemuseni. Õpi samm-sammult, harjuta teadlikult ja leia kindlus oma kätes.",
  "От теории до первого самостоятельного результата. Учитесь шаг за шагом и обретайте уверенность в своих руках.",
);
const onlineLead = t(
  "Õpi veebis seal, kus sulle sobib. Selged moodulid ja järjekindel areng.",
  "Учитесь онлайн там, где вам удобно. Понятные модули и последовательное развитие.",
);
const outcomes: I18n[] = [
  t("Analüüsida kliendi eripärasid ja valida sobiva tehnika.", "Анализировать особенности клиента и выбирать технику."),
  t("Planeerida tööetappe ja kasutada töövahendeid teadlikult.", "Планировать этапы работы и осознанно применять инструменты."),
  t("Rakendada õpitut juhendatud praktikas.", "Применять знания на практике под руководством."),
  t("Selgitada kliendile järelhooldust.", "Объяснять клиенту последующий уход."),
];
const programme: I18n[] = [
  t("Vundament: anatoomia ja hügieen", "Основа: анатомия и гигиена"),
  t("Analüüs ja tehnika valik", "Анализ и выбор техники"),
  t("Töövahendid ja protseduur", "Инструменты и процедура"),
  t("Praktika, test ja tagasiside", "Практика, тест и обратная связь"),
];
// "Koolitus sisaldab" (checklist P10), Maria's wording from docs/feedback/2026-10-01-maria-overview.md (first letter capitalised).
const contactIncludes: I18n[] = [
  t("Teooriaosa", "Теоретическая часть"),
  t("Praktiline osa, nt töö kahel modellil", "Практическая часть, например работа на двух моделях"),
  t("Õppematerjal, mis jääb peale koolitust õpilasele", "Учебные материалы, которые остаются у ученика после курса"),
  t("Koolitaja juhendamine ja personaalne tugi koolituse ajal", "Руководство преподавателя и личная поддержка во время курса"),
  t("Teadmiste test", "Тест знаний"),
  t("Praktilise töö hindamine", "Оценка практической работы"),
  t("Kõik vajalikud töövahendid koolituskeskuse poolt", "Все необходимые инструменты предоставляет учебный центр"),
  t("Eduka koolituse läbimise korral tunnistus", "Сертификат при успешном завершении курса"),
];

const badgePopular: Badge = { label: { et: "Populaarne", ru: "Популярное" }, bg: "#222222", fg: "#ffffff" };
const badgeNew: Badge = { label: { et: "Uus", ru: "Новинка" }, bg: "#DDD4DC", fg: "#222222" };

// ---------- courses ----------

export type SeedImage = { key: string; alt: I18n };
export type SeedSession = Omit<SessionInput, "id" | "courseId">;
/** `modules`: the course's module titles in order, written as course_modules rows (seed-apply.ts); courses has no column of its own for them. */
export type SeedCourse = Omit<CourseInput, "id" | "published" | "isSample" | "sort"> & { images: SeedImage[]; sessions?: SeedSession[]; modules?: I18n[] };

// Prototype D SESS (8 rows), mapped onto the three contact courses. D's dates were 14.11.2026 … 23.01.2027; they are
// kept as days after the first one (a Saturday about six weeks ahead, seed-dates.ts), so a seed made on any day gets an
// upcoming calendar with the same weekdays and spacing. Made on 1.10.2026 the dates are exactly D's.
export const SEEDED_AT = new Date();
const day = (offset: number): Date => seedSessionStart(SEEDED_AT, offset);
const studio = "MS LAB stuudio, Rüütli 12";

const manualImage: SeedImage = { key: img("course-manual.jpg"), alt: t("MS LAB õppematerjal", "Учебные материалы MS LAB") };
const certWhite: SeedImage = { key: img("certificate-white.jpg"), alt: t("MS LAB tunnistus valges raamis", "Сертификат MS LAB в белой рамке") };
const certBlack: SeedImage = { key: img("certificate-black.jpg"), alt: t("MS LAB tunnistus mustas raamis", "Сертификат MS LAB в чёрной рамке") };
const certEasel: SeedImage = { key: img("certificate-easel.jpg"), alt: t("MS LAB tunnistus laual", "Сертификат MS LAB на столе") };
const giftImage: SeedImage = { key: img("gift-bag-serum.jpg"), alt: t("MS LAB kingikott ja seerum", "Подарочный пакет MS LAB и сыворотка") };

export const courseSeeds: SeedCourse[] = [
  {
    slug: "kulmumeistri-baaskoolitus",
    type: "contact",
    level: "basic",
    title: t("Kulmumeistri baaskoolitus", "Базовый курс бровиста"),
    summary: t("Tugev vundament sinu teekonnale kulmumeistrina.", "Уверенное начало вашего пути в профессии бровиста."),
    body: t(
      `Põhjalik baaskoolitus neile, kes alustavad kulmutehnikutena: kuju, värvimine, hooldus ja klienditöö. Praktika toimub modellil.\n\n${detailLead.et}`,
      `Подробный базовый курс для тех, кто начинает работать мастером бровей: форма, окрашивание, уход и работа с клиентом. Практика проходит на модели.\n\n${detailLead.ru}`,
    ),
    outcomes,
    includes: contactIncludes,
    modules: programme,
    language: "ET / RU",
    priceGroup: 35000,
    priceIndividual: 45000,
    durationLabel: t("2 päeva · 16 ak", "2 дня · 16 ак. ч."),
    badge: badgePopular,
    images: [{ key: img("brow-editorial.jpg"), alt: t("Kulmumeistri baaskoolitus", "Базовый курс бровиста") }, manualImage, certWhite, giftImage],
    sessions: [
      { startsAt: day(0), city: "Pärnu", venue: studio, language: "ET", capacity: 4 },
      { startsAt: day(21), city: "Pärnu", venue: studio, language: "ET", capacity: 4 },
      { startsAt: day(28), city: "Tallinn", venue: "Stuudio Kalamaja", language: "RU", capacity: 6 },
    ],
  },
  {
    slug: "lash-lift-botox",
    type: "contact",
    level: "basic",
    title: t("Lash Lift BOTOX baaskoolitus", "Базовый курс Lash Lift BOTOX"),
    summary: t("Loomulik kaar. Täpne tehnika. Kaunis tulemus.", "Естественный изгиб. Точная техника. Красивый результат."),
    body: t(
      `Ripsmete tõste ja toitev BOTOX-hooldus samm-sammult, koos praktikaga modellil.\n\n${detailLead.et}`,
      `Лифтинг ресниц и питательный уход BOTOX шаг за шагом, с практикой на модели.\n\n${detailLead.ru}`,
    ),
    outcomes,
    includes: contactIncludes,
    modules: programme,
    language: "ET",
    priceGroup: 29000,
    priceIndividual: 39000,
    durationLabel: t("8 ak", "8 ак. ч."),
    badge: badgeNew,
    images: [{ key: img("lash-editorial.jpg"), alt: t("Lash Lift BOTOX baaskoolitus", "Базовый курс Lash Lift BOTOX") }, manualImage, certWhite, giftImage],
    sessions: [
      { startsAt: day(7), city: "Tallinn", venue: "Stuudio Kalamaja", language: "ET", capacity: 4 },
      { startsAt: day(25), city: "Viljandi", venue: "Salong Lossi", language: "ET", capacity: 4 },
      { startsAt: day(63), city: "Tartu", venue: "Ilusalong Emajõe", language: "ET", capacity: 4, status: "cancelled" },
    ],
  },
  {
    slug: "kulmude-lami",
    type: "contact",
    level: "advanced",
    title: t("Kulmude LAMI", "Ламинирование бровей"),
    summary: t("Kulmude laminatsioon juba töötavale meistrile: tooted, ajastus ja kuju püsivus.", "Ламинирование бровей для практикующих мастеров: средства, время выдержки и стойкость формы."),
    body: detailLead,
    outcomes,
    includes: contactIncludes,
    modules: programme,
    language: "ET / RU",
    priceGroup: 22000,
    priceIndividual: 30000,
    durationLabel: t("6 ak", "6 ак. ч."),
    badge: null,
    images: [{ key: img("brow-closeup.jpg"), alt: t("Kulmude LAMI", "Ламинирование бровей") }, manualImage, certWhite, giftImage],
    sessions: [
      { startsAt: day(14), city: "Tartu", venue: "Ilusalong Emajõe", language: "ET / RU", capacity: 6 },
      { startsAt: day(70), city: "Pärnu", venue: studio, language: "ET / RU", capacity: 6 },
    ],
  },
  {
    slug: "kulmumeistri-e-koolitus",
    type: "e_learning",
    level: "basic",
    title: t("Kulmumeistri e-koolitus", "Онлайн-курс бровиста"),
    summary: t("Tugev vundament sinu teekonnale kulmumeistrina.", "Уверенное начало вашего пути в профессии бровиста."),
    body: t(
      `${onlineLead.et}\n\nPõhjalik baaskoolitus neile, kes alustavad kulmutehnikutena: kuju, värvimine, hooldus ja klienditöö.`,
      `${onlineLead.ru}\n\nПодробный базовый курс для тех, кто начинает работать мастером бровей: форма, окрашивание, уход и работа с клиентом.`,
    ),
    outcomes,
    includes: [],
    modules: [
      programme[0],
      programme[1],
      t("Kulmude arhitektuur", "Архитектура бровей"),
      t("Värvid ja segamine", "Красители и смешивание"),
      programme[2],
      programme[3],
    ],
    language: "ET / RU",
    price: 19000,
    accessMonths: 6,
    videoCount: 24,
    nextDiscount: t("−10% järgmiselt koolituselt", "−10% на следующий курс"),
    badge: null,
    images: [{ key: img("brow-editorial.jpg"), alt: t("Kulmumeistri e-koolitus", "Онлайн-курс бровиста") }, manualImage, certBlack, certEasel],
  },
  {
    slug: "kulmukuju-ja-summeetria",
    type: "e_learning",
    level: "advanced",
    title: t("Kulmukuju ja sümmeetria", "Форма и симметрия бровей"),
    summary: t("Lühike täiendkoolitus kuju kaardistamise ja sümmeetria kohta.", "Короткий курс повышения квалификации о разметке формы и симметрии."),
    body: onlineLead,
    outcomes,
    includes: [],
    modules: [t("Sissejuhatus ja töövahendid", "Введение и инструменты"), t("Kulmukuju analüüs", "Анализ формы бровей"), t("Sümmeetria ja korrigeerimine", "Симметрия и коррекция")],
    language: "ET / RU",
    price: 9500,
    accessMonths: 6,
    videoCount: 8,
    badge: null,
    images: [{ key: img("lash-tweezers-detail.jpg"), alt: t("Kulmukuju ja sümmeetria", "Форма и симметрия бровей") }, manualImage, certEasel, certBlack],
  },
  {
    slug: "ripsmete-laminatsiooni-alused",
    type: "e_learning",
    level: "basic",
    title: t("Ripsmete laminatsiooni alused", "Основы ламинирования ресниц"),
    summary: t("Teooria ja tehnika videotena, enne kui lähed esimese kliendi juurde.", "Теория и техника в видео — до того, как вы примете первого клиента."),
    body: onlineLead,
    outcomes,
    includes: [],
    modules: [
      t("Ripsmete anatoomia ja hügieen", "Анатомия ресниц и гигиена"),
      t("Töövahendid ja tooted", "Инструменты и средства"),
      t("Laminatsiooni tehnika samm-sammult", "Техника ламинирования шаг за шагом"),
      t("Test ja tunnistus", "Тест и сертификат"),
    ],
    language: "ET / RU",
    price: 15000,
    accessMonths: 6,
    videoCount: 12,
    badge: null,
    images: [{ key: img("eye-closeup.jpg"), alt: t("Ripsmete laminatsiooni alused", "Основы ламинирования ресниц") }, manualImage, certWhite, certBlack],
  },
];

// ---------- practice (prototype B practicePanel) ----------

const practiceCommon: I18n[] = [
  t("Personaalne juhendamine", "Индивидуальная поддержка"),
  t("Kõik töövahendid kohapeal", "Все материалы на месте"),
];

export const practiceSeeds: PracticePackageInput[] = [
  {
    code: "MINI",
    name: t("MINI"),
    tagline: t("Keskendu sellele, mis vajab tuge.", "Сосредоточьтесь на том, что важно."),
    models: 2,
    durationLabel: t("4 ak", "4 ак. ч."),
    price: 10000,
    items: [t("Töö kahel modellil", "Работа на двух моделях"), ...practiceCommon],
    sort: 1,
  },
  {
    code: "MAXI",
    name: t("MAXI"),
    tagline: t("Rohkem harjutamist. Veel kindlam käekiri.", "Больше практики. Больше уверенности."),
    models: 4,
    durationLabel: t("8 ak", "8 ак. ч."),
    price: 15000,
    items: [t("Töö neljal modellil", "Работа на четырёх моделях"), ...practiceCommon],
    sort: 2,
  },
];

// ---------- hero slides (prototype B hero(); a line break in a title is "\n") ----------

export const heroSeeds: HeroSlideInput[] = [
  {
    imageKey: img("flower-hero.png"),
    imagePos: "50% 50%",
    imagePosMobile: "73% 50%",
    tone: "light",
    kicker: t("Maria Sosnina · Koolituskeskus", "Мария Соснина · Учебный центр"),
    title: t("Õpilase edu on\nmeie eesmärk.", "Успех ученика —\nнаша цель."),
    text: t(
      "Kulmu- ja ripsmekoolitused, mis annavad sulle oskused, enesekindluse ja kindla alguse.",
      "Курсы бровей и ресниц, которые дают навыки, уверенность и прочную основу.",
    ),
    ctaLabel: t("Leia oma koolitus", "Выбрать курс"),
    ctaHref: "/koolitused",
    sort: 1,
  },
  {
    imageKey: img("brow-editorial.jpg"),
    imagePosMobile: DARK_MOBILE_FOCAL,
    tone: "dark",
    kicker: t("Kulmumeistri baaskoolitus", "Базовый курс бровиста"),
    title: t("Täpsusest sünnib\nenesekindlus.", "Уверенность\nначинается с точности."),
    text: t(
      "Kulmumeistri baaskoolitus. Õpi nägema detaile ja looma loomulikult kaunist tulemust.",
      "Базовый курс бровиста. Научитесь замечать детали и создавать естественную красоту.",
    ),
    ctaLabel: t("Tutvu koolitusega", "О курсе"),
    ctaHref: "/koolitused/kulmumeistri-baaskoolitus",
    sort: 2,
  },
  {
    imageKey: img("lash-editorial.jpg"),
    imagePosMobile: DARK_MOBILE_FOCAL,
    tone: "dark",
    kicker: t("Lash Lift BOTOX", "Lash Lift BOTOX"),
    title: t("Väike detail.\nSuur muutus.", "Маленькая деталь.\nБольшая перемена."),
    text: t(
      "Lash Lift BOTOX. Teadmised ja tehnika loomulikult kaunite ripsmete loomiseks.",
      "Lash Lift BOTOX. Знания и техника для естественно красивых ресниц.",
    ),
    ctaLabel: t("Vaata koolitust", "Посмотреть курс"),
    ctaHref: "/koolitused/lash-lift-botox",
    sort: 3,
  },
  {
    imageKey: img("flower-hero.png"),
    imagePos: "50% 50%",
    imagePosMobile: "73% 50%",
    tone: "light",
    kicker: t("Praktika MS LABis", "Практика в MS LAB"),
    title: t("Sinu käekiri.\nMinu toetus.", "Ваш почерк.\nМоя поддержка."),
    text: t(
      "Individuaalpraktika MINI ja MAXI. Lihvi oma oskusi minu kõrval.",
      "Индивидуальная практика MINI и MAXI. Оттачивайте навыки рядом со мной.",
    ),
    ctaLabel: t("Leia praktikapakett", "Выбрать практику"),
    ctaHref: "/praktika",
    sort: 4,
  },
  {
    imageKey: img("brow-editorial.jpg"),
    imagePosMobile: DARK_MOBILE_FOCAL,
    tone: "dark",
    kicker: t("E-õpe", "Онлайн-обучение"),
    title: t("Sinu tempo.\nSinu järgmine samm.", "Ваш темп.\nВаш следующий шаг."),
    text: onlineLead,
    ctaLabel: t("Vaata e-koolitusi", "Онлайн-курсы"),
    ctaHref: "/koolitused",
    sort: 5,
  },
];

// ---------- FAQ (prototype D FAQ; answers about hybrid courses reworded: hybrid is only an explanation, K1/K2) ----------

export const faqSeeds: { q: I18n; a: I18n }[] = [
  {
    q: t("Kas vajan eelnevaid kogemusi?", "Нужен ли предварительный опыт?"),
    a: t("Ei. Baaskoolitused on mõeldud alustajatele ja on mahukamad. Täiendkoolitused sobivad neile, kes juba töötavad ja soovivad õppida konkreetset tehnikat.", "Нет. Базовые курсы рассчитаны на начинающих и более объёмны. Курсы повышения квалификации подходят тем, кто уже работает и хочет освоить конкретную технику."),
  },
  {
    q: t("Mis juhtub pärast e-koolituse ostu?", "Что происходит после покупки онлайн-курса?"),
    a: t("Sulle luuakse automaatselt õpilase konto ja saad kinnituse e-postiga. Logi sisse ja alusta kohe — videod ja materjalid on avatud kogu ligipääsu aja.", "Для вас автоматически создаётся учётная запись ученика, а подтверждение приходит по электронной почте. Войдите и начните сразу — видео и материалы открыты весь срок доступа."),
  },
  {
    q: t("Mis vahe on e-õppel ja kontaktõppel?", "Чем онлайн-обучение отличается от очного?"),
    a: t("E-õpe toimub veebis videotena sinu enda tempos. Kontaktõpe toimub kohapeal koolitaja juhendamisel, grupis või individuaalselt. Soovi korral saad kahte õppevormi ka kombineerida, valides sobiva e-koolituse ja kontaktkoolituse.", "Онлайн-обучение проходит в формате видео в вашем собственном темпе. Очное обучение проходит на месте под руководством преподавателя, в группе или индивидуально. При желании оба формата можно совместить, выбрав подходящий онлайн-курс и очный курс."),
  },
  {
    q: t("Kas modellid tuleb ise leida?", "Нужно ли самой искать моделей?"),
    a: t("Ei pea. Võid tulla oma modellidega, kuid vajadusel leiab modellid koolituskeskus ning kõik töövahendid on kohapeal olemas.", "Не обязательно. Можно прийти со своими моделями, но при необходимости моделей найдёт учебный центр, а все инструменты есть на месте."),
  },
  {
    q: t("Kas saan maksta osade kaupa?", "Можно ли оплатить частями?"),
    a: t("Kontaktkoolituse eest saad tasuda kohe 100% või 50% registreerimisel ja ülejäänud 50% koolituspäeval. Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist. E-koolituse eest tasud kohe pangalingiga; järelmaks lisandub hiljem.", "Очный курс можно оплатить сразу на 100% или 50% при регистрации и остальные 50% в день обучения. Место подтверждается после поступления предоплаты не менее 50%. Онлайн-курс оплачивается сразу через банковскую ссылку; рассрочка появится позже."),
  },
  {
    q: t("Millal saan tunnistuse?", "Когда я получу сертификат?"),
    a: t("Pärast koolituse edukat lõpetamist: e-koolituses pärast teadmiste testi ja praktilise töö hindamist, kontaktkoolituses pärast testi ja praktilise töö hindamist.", "После успешного завершения курса: на онлайн-курсе — после теста знаний и оценки практической работы, на очном курсе — после теста и оценки практической работы."),
  },
];

// ---------- posts (prototype D NEWS) ----------

const postBody = (excerpt: I18n) =>
  t(
    [
      `${excerpt.et} See on näidispostitus, mis näitab, kuidas täismahus artikkel lehel välja näeb: pealkiri, kaanepilt, loetav tekstilaius ja lõpus soovitused.`,
      "Mõtle, kas soovid alustada täiesti uue teenusega või täiendada seda, mida juba teed. Baaskoolitused on mahukamad ja põhjalikumad, täiendkoolitused keskenduvad ühele tehnikale või teemale.",
      "E-õpe sobib, kui soovid õppida omas tempos. Kontaktõpe annab kohese praktika koolitaja kõrval. E-õpet ja kontaktõpet saab omavahel kombineerida, valides endale sobivad koolitused.",
    ].join("\n\n"),
    [
      `${excerpt.ru} Это пример публикации: так на странице выглядит полная статья — заголовок, обложка, удобная для чтения ширина текста и рекомендации в конце.`,
      "Подумайте, хотите ли вы начать совершенно новую услугу или усовершенствовать то, что уже делаете. Базовые курсы объёмнее и подробнее, курсы повышения квалификации посвящены одной технике или теме.",
      "Онлайн-обучение подходит, если вы хотите учиться в своём темпе. Очное обучение даёт практику сразу рядом с преподавателем. Онлайн- и очное обучение можно сочетать, выбрав подходящие курсы.",
    ].join("\n\n"),
  );

/** `title` and `excerpt`: [et, ru]; the slug comes from the Estonian title. */
const post = (date: string, category: I18n, title: [string, string], cover: string, excerpt: [string, string]): PostInput => ({
  slug: slugify(title[0]),
  title: t(...title),
  excerpt: t(...excerpt),
  body: postBody(t(...excerpt)),
  category,
  coverKey: img(cover),
  publishedAt: new Date(`${date}T09:00:00+03:00`),
  published: true,
});

const advice = t("Nõuanne", "Совет");
const news = t("Uudis", "Новость");

export const postSeeds: PostInput[] = [
  post(
    "2026-09-22",
    advice,
    ["Kuidas valida endale sobiv kulmukoolitus?", "Как выбрать подходящий курс по бровям?"],
    "brow-editorial.jpg",
    ["Baas- või täiendkoolitus, e-õpe või kontaktpäev — lühike juhend, kust alustada.", "Базовый курс или повышение квалификации, онлайн или очный день — короткое руководство, с чего начать."],
  ),
  post(
    "2026-09-15",
    news,
    ["Uus koolitus: Lash Lift BOTOX", "Новый курс: Lash Lift BOTOX"],
    "lash-editorial.jpg",
    ["Novembrist lisandub kalendrisse ripsmete tõste ja BOTOX-hoolduse koolitus.", "С ноября в расписании появится курс по лифтингу ресниц и уходу BOTOX."],
  ),
  post(
    "2026-09-02",
    t("Praktika", "Практика"),
    ["Praktika modellidega — mida oodata?", "Практика на моделях — чего ожидать?"],
    "certificate-easel.jpg",
    ["Kuidas praktikapäev käib ja miks praktikaprotokoll on sinu parim tagasiside.", "Как проходит день практики и почему протокол практики — ваша лучшая обратная связь."],
  ),
  post(
    "2026-08-20",
    advice,
    ["Kulmude hooldus pärast laminatsiooni", "Уход за бровями после ламинирования"],
    "brow-closeup.jpg",
    ["Viis asja, mida kliendile pärast protseduuri alati meelde tuletada.", "Пять вещей, о которых стоит всегда напоминать клиенту после процедуры."],
  ),
  post(
    "2026-08-05",
    news,
    ["MS LAB koolitused nüüd ka Tartus ja Viljandis", "Курсы MS LAB теперь и в Тарту и Вильянди"],
    "flower-petal.jpg",
    ["Kontaktkoolitused jõuavad sügisest rohkemate linnadeni.", "С осени очные курсы проходят в большем числе городов."],
  ),
  post(
    "2026-07-18",
    t("Õpilase lugu", "История ученицы"),
    ["Esimesest koolitusest oma salongini", "От первого курса до собственного салона"],
    "course-manual.jpg",
    ["Kuidas üks baaskoolitus muutis karjääri — õpilase kogemus.", "Как один базовый курс изменил карьеру — опыт ученицы."],
  ),
];

// ---------- pages ----------

const legalPlaceholder = t(
  "Lõplikud müügi-, õppe- ja privaatsustingimused lisatakse enne päristeenuse avaldamist. (Näidistekst — Maria täiendab.)",
  "Окончательные условия продажи, обучения и конфиденциальности будут добавлены перед запуском.",
);

export const pageSeeds: { key: string; title: I18n; body: I18n }[] = [
  {
    key: "statement",
    title: t("MS LAB Koolituskeskus", "Учебный центр MS LAB"),
    body: t(
      "Õpetame kulmu- ja ripsmetehnikaid nii, nagu oleksime ise tahtnud õppida — väikestes gruppides, päris modellidel ja toega ka pärast koolitust.",
      "Мы учим техникам бровей и ресниц так, как хотели бы учиться сами, — в небольших группах, на настоящих моделях и с поддержкой после курса.",
    ),
  },
  {
    key: "trainer_bio",
    title: t("Maria Sosnina", "Мария Соснина"),
    body: t(
      "Kulmu- ja ripsmetehnikate meister ja koolitaja. Töötan Pärnus ilukliinikus ja koolitan üle Eesti.\n\nMinu eesmärk on lihtne: et iga õpilane lahkuks koolituselt oskuste ja kindlusega alustada. Seepärast on grupid väikesed, praktika päris modellidel ja tagasiside kirjalik.",
      "Мастер и преподаватель техник бровей и ресниц. Работаю в клинике красоты в Пярну и провожу обучение по всей Эстонии.\n\nМоя цель проста: чтобы каждый ученик уходил с курса с навыками и уверенностью, чтобы начать. Поэтому группы небольшие, практика — на настоящих моделях, а обратная связь — письменная.",
    ),
  },
  {
    // The home page's trainer card text (round 2 item 5, Maria C26: D's own line), edited under Avaleht
    key: "trainer_teaser",
    title: t("Sinu koolitaja", "Ваш преподаватель"),
    body: t(
      "Kulmu- ja ripsmetehnikate meister ja koolitaja. Õpetan nii, nagu oleksin ise tahtnud õppida: selgelt, praktiliselt ja iga õpilase tempos.",
      "Мастер и преподаватель техник бровей и ресниц. Я учу так, как хотела бы учиться сама: понятно, практично и в темпе каждого ученика.",
    ),
  },
  {
    key: "center_story",
    title: t("Koolituskeskuse lugu", "История учебного центра"),
    body: t(
      "MS LAB ühendab teooria ja praktika. Õppimine jätkub ka pärast esimest koolituspäeva: saad oma tehnikat kinnistada individuaalpraktikas ning veebimaterjalide abil.",
      "MS LAB объединяет теорию и практику. Обучение продолжается после первого дня: закрепляйте технику на индивидуальной практике и с помощью онлайн-материалов.",
    ),
  },
  {
    key: "trainer_journey",
    title: t("Koolitaja teekond", "Путь преподавателя"),
    body: t(
      "Siia tuleb Maria lugu: kuidas kulmu- ja ripsmemeistrist sai koolitaja ja mis teda iga päev edasi viib. Maria täiendab.",
      "Здесь будет история Марии: как мастер бровей и ресниц стала преподавателем и что вдохновляет её каждый день. Мария дополнит.",
    ),
  },
  { key: "privacy", title: t("Privaatsus", "Конфиденциальность"), body: legalPlaceholder },
  { key: "terms", title: t("Õppetingimused", "Условия обучения"), body: legalPlaceholder },
  {
    // What a student accepts before opening an e-course for the first time (account-only: no public page shows it); the admin
    // edits it under Seaded. The version is not in the body: it is the settings key courseTermsVersion, set when the admin saves.
    key: TERMS_PAGE_KEY,
    title: TERMS_PAGE_TITLE,
    body: t(
      "Ligipääs sellele e-koolitusele on isiklik: see kehtib ainult sulle ja sinu e-posti aadressiga seotud kontole.\n\nPalun ära jaga oma kontot ega koolituse materjale teistega. Ära edasta, kopeeri ega avalda videoid, tekste ega muud sisu.\n\nLigipääs kehtib kuni kuupäevani, mis on sinu koolituse juures näha. Pärast seda sisu enam avada ei saa.\n\n(Näidistekst — Maria täiendab.)",
      "Доступ к этому онлайн-курсу личный: он действует только для вас и для кабинета, связанного с вашим адресом электронной почты.\n\nПожалуйста, не передавайте свой кабинет и материалы курса другим людям. Не пересылайте, не копируйте и не публикуйте видео, тексты и другие материалы.\n\nДоступ действует до даты, указанной у вашего курса. После этого материалы больше не откроются.\n\n(Образец текста — Мария дополнит.)",
    ),
  },
];

// ---------- gallery "koolitaja tööd" (Maria's own photos; portraits last) ----------

export const trainerWorks: SeedImage[] = [
  certWhite,
  certBlack,
  certEasel,
  manualImage,
  giftImage,
  { key: img("maria-seated.jpg"), alt: t("Koolitaja Maria Sosnina", "Преподаватель Мария Соснина") },
  { key: img("maria-standing.jpg"), alt: t("Koolitaja Maria Sosnina", "Преподаватель Мария Соснина") },
];

// ---------- campaign popup (prototype D CAMP_DEFAULT; CTA wording M4) ----------

export const campaignSeed: CampaignInput = {
  active: true,
  kicker: t("Talvine pakkumine", "Зимнее предложение"),
  title: t("−15% Lash Lift BOTOX koolitusele", "−15% на курс Lash Lift BOTOX"),
  text: t("Kehtib registreerumisel kuni 30.11. Sisesta kood ostukorvis.", "Действует при регистрации до 30.11. Введите код в корзине."),
  code: "TALV15",
  ctaLabel: t("Leia enda koolitus", "Найти свой курс"),
  ctaHref: "/koolitused/lash-lift-botox",
  imageKey: img("lash-editorial.jpg"),
};

/** The newsletter popup (phase 2c): switched off; the same row the migration adds, for a database the seed resets. */
export const newsletterPopupSeed: CampaignInput = {
  active: false,
  kicker: t("MS LABi kirjad", "Письма MS LAB"),
  title: t("Hea järgmine samm. Otse sinu postkasti.", "Ваш следующий шаг. В вашем почтовом ящике."),
  text: t("Uued koolitused, kasulikud mõtted ja tervitussoodustus sinu esimesele koolitusele.", "Новые курсы, полезные идеи и приветственная скидка на первый курс."),
  code: "",
  ctaLabel: t(""),
  ctaHref: "",
  imageKey: img("gift-bag-serum.jpg"),
};

// ---------- settings ----------

export const settingSeeds: Record<string, unknown> = {
  contact: { email: "info@mslab.ee", phone: "", address: "Pärnu", instagram: "", facebook: "" },
  newsletter: { discountLabel: "10%", welcomeCode: "" },
  trainer: {
    portraitKey: img("maria-standing.jpg"),
    contactPhotoKey: img("maria-seated.jpg"),
    name: t("Maria Sosnina", "Мария Соснина"),
    role: t("Kulmu- ja ripsmetehnikate meister ja koolitaja", "Мастер и преподаватель техник бровей и ресниц"),
    // D's labels (Maria C26)
    stats: [
      { value: "8+", label: t("aastat kogemust", "лет опыта") },
      { value: "4", label: t("linna", "города") },
      { value: "1:4", label: t("väikesed grupid", "малые группы") },
    ],
  },
};
