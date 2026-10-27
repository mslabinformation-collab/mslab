import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogCarousel } from "@/components/site/BlogCarousel";
import { ContactBlock } from "@/components/site/ContactBlock";
import { CourseCard } from "@/components/site/CourseCard";
import { courseCardData } from "@/components/site/course-card-data";
import { Faq } from "@/components/site/Faq";
import { FlashNotice, type FlashMessage } from "@/components/site/FlashNotice";
import { FormatsBlock, type FormatTab } from "@/components/site/FormatsBlock";
import { Hero, type HeroSlideView } from "@/components/site/Hero";
import { Icon } from "@/components/site/Icon";
import { NewsletterPopup } from "@/components/site/NewsletterPopup";
import { popupFormTexts } from "@/components/site/NewsletterPopupCard";
import { PracticeBlock } from "@/components/site/PracticeBlock";
import { PreviewBar } from "@/components/site/PreviewBar";
import { ReviewList } from "@/components/site/ReviewList";
import { trainerSettings } from "@/components/site/settings";
import { Statement } from "@/components/site/Statement";
import { TrainerTeaser } from "@/components/site/TrainerTeaser";
import { UpcomingStrip } from "@/components/site/UpcomingStrip";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { getHomeData, listUpcomingSessions } from "@/db/queries/public";
import { NEWSLETTER_LANDING_PARAM, newsletterPopupView } from "@/domain/campaign";
import { firstParagraph, nextSessionByCourse, nextSessions, pickHomeCourses } from "@/domain/home";
import { linkFor } from "@/domain/site-editor";
import { formatEUR } from "@/domain/money";
import { welcomeCodeOf } from "@/domain/welcome-code";
import { pick, pickList } from "@/i18n/field";
import { fill, formatDate, formatDayMonth, formatWeekday } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import { DELETED_MARK } from "@/lib/account-marks";
import { mediaUrl } from "@/lib/media";
import { previewActive } from "@/server/preview";
import { homeReviews } from "@/server/reviews";
import { shareMetadata } from "@/server/share-meta";
import styles from "./home.module.css";
import { upcomingFrom } from "@/domain/calendar";

type Props = { params: Promise<{ locale: string }> };

/**
 * This page lists course dates, and a date is listed only until its session begins. So it is rendered again when it is
 * older than 5 minutes (the first visit after that still gets the cached copy and starts the new render), and a session
 * that has begun drops off without anyone saving. Saves revalidate it at once (server/public-cache.ts).
 */
export const revalidate = 300;

/** The link preview of / and /ru: the home page's own address (og:url), title, description and picture. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return shareMetadata(locale, { path: "/", title: d.meta.title, description: d.meta.description });
}

/**
 * Home page (Task 7). Section order from the brief: hero → upcoming strip → course cards → "Kuidas soovid õppida?"
 * → statement → trainer → students' experiences (student reviews; only while one is featured) → practice → blog → FAQ
 * → contact. The newsletter lives in the footer (layout).
 * The layout provides <main> and the transparent header that the hero slides under.
 */
export default async function Home({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const db = getDb();
  // the signed-in admin's draft preview (api/admin/eelvaade; piece 4a, R-f) shows the drafts of the home page, the trainer, the packages, the posts and
  // the popup (piece 4b): previewActive()
  // is false, with no cookie read, for every visitor and for the static render, so the page stays the one cached by revalidation
  const drafts = await previewActive();
  const [home, sessions, reviews] = await Promise.all([getHomeData(db, { drafts }), listUpcomingSessions(db, upcomingFrom(new Date())), homeReviews(db)]);

  const slides: HeroSlideView[] = home.slides.map((s) => ({
    id: s.id,
    image: mediaUrl(s.imageKey),
    pos: s.imagePos,
    posMobile: s.imagePosMobile,
    tone: s.tone === "dark" ? "dark" : "light",
    kicker: pick(s.kicker, locale),
    title: pick(s.title, locale),
    text: pick(s.text, locale),
    ctaLabel: pick(s.ctaLabel, locale) || d.hero.primaryCta,
    // A site path gets the locale prefix, an https address stays; anything else (the admin refuses it) → the catalogue.
    ctaHref: linkFor(s.ctaHref, to, "/koolitused"),
  }));

  const nextByCourse = nextSessionByCourse(sessions);
  const cards = pickHomeCourses(home.courses).map((c) => courseCardData(c, nextByCourse.get(c.id), locale, d, to));

  const f = d.formats;
  const formatTabs: FormatTab[] = [
    { key: "e", name: f.elearning.name, question: f.elearning.question, definition: f.elearning.definition, facts: f.elearning.facts, steps: f.elearning.steps, link: { label: f.elearning.link, href: to("/koolitused?vorm=e") } },
    { key: "k", name: f.contact.name, question: f.contact.question, definition: f.contact.definition, facts: f.contact.facts, steps: f.contact.steps, link: { label: f.contact.link, href: to("/koolitused?vorm=k") } },
    // Hybrid is an explanation only: no steps, no facts, no link (Maria C16, K8; controller ruling).
    { key: "h", name: f.hybrid.name, question: f.hybrid.question, definition: f.hybrid.definition },
  ];

  // The home page's popup (phase 2c; admin UX pass piece 4b, D3, R-d): the newsletter sign-up, while Hüpikaken's „Lehel näidatakse“ is on; none when
  // off. This page is / and /ru, the only pages that show it (R-e). Its button follows Seaded's welcome code (S4-Q4): „Saa kood“ while there is one.
  const newsletterPopup = newsletterPopupView(home.popup, locale);
  const welcomeCode = welcomeCodeOf(home.settings.newsletter) !== "";

  const statement = home.pages.statement;
  const bio = home.pages.trainer_bio;
  const teaser = home.pages.trainer_teaser; // the card's own text (Avaleht editor), else the bio's first paragraph
  const trainer = trainerSettings(home.settings, locale);
  const trainerName = trainer.name || pick(bio?.title, locale);

  // The newsletter's links land here with ?uudiskiri=loobutud (the unsubscribe link of the welcome mail), kinnitatud | vigane (the confirmation
  // link of the old double opt-in) or viga (either one, when the database could not be reached).
  // The page is cached for every visitor, so the notice picks its text in the browser (FlashNotice); the first old-style confirmation carries
  // the welcome code in the fragment (#kood=…), which the notice shows (phase 2c): the page's HTML never holds the code.
  const nl = d.newsletter;
  const newsletterNotices: Record<string, FlashMessage> = {
    loobutud: { tone: "ok", title: nl.unsubscribedTitle, text: nl.unsubscribedText },
    kinnitatud: { tone: "ok", title: nl.confirmedTitle, text: nl.confirmedText, codeLine: nl.codeLine },
    vigane: { tone: "warn", title: nl.linkInvalid },
    viga: { tone: "warn", title: d.forms.errorGeneric },
  };
  // "Minu andmed" lands here with #konto-kustutatud after deleting the account (a fragment: the server never sees it).
  const accountNotices: Record<string, FlashMessage> = { [DELETED_MARK]: { tone: "ok", title: d.account.details.deleted } };

  // The admin's draft preview only (R-f): the home page's bar (its changes, „Loobu muudatustest“ of its drafts, the way out). For a visitor, and for the
  // page Next keeps, there is none: nothing of the draft layer is loaded unless the request is the preview.
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { sitePreviewBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewBar {...await sitePreviewBarProps(db, "home", to("/"))} />;
  }

  return (
    <>
      <Hero
        slides={slides}
        t={{
          caption: d.hero.caption,
          carousel: d.hero.carousel,
          carouselLabel: d.hero.carouselLabel,
          slide: d.hero.slide,
          prevSlide: d.hero.prevSlide,
          nextSlide: d.hero.nextSlide,
          pauseSlides: d.hero.pauseSlides,
          calendarLabel: d.hero.secondaryCta,
          calendarHref: to("/koolituskalender"),
        }}
      />

      <UpcomingStrip
        label={d.home.upcomingLabel}
        items={nextSessions(sessions, 3).map((s) => ({
          id: s.id,
          // The course page (Task 8) can preselect the session, as the calendar does (?sessioon=id).
          href: to(`/koolitused/${s.course.slug}?sessioon=${s.id}`),
          day: formatDayMonth(s.startsAt, locale),
          weekday: formatWeekday(s.startsAt, locale),
          title: pick(s.course.title, locale),
          city: s.city,
          format: f.contact.name,
          language: s.language,
        }))}
      />

      {cards.length > 0 && (
        <section className={styles.courses} aria-labelledby="home-courses-title">
          <div className={ui.wrap}>
            <div className={styles.heading}>
              <div>
                <p className={`${ui.eyebrow} ${styles.eyebrow}`}>{d.home.coursesEyebrow}</p>
                <h2 id="home-courses-title" className={ui.h2}>
                  {d.home.coursesTitle}
                </h2>
              </div>
              <Link className={ui.link} href={to("/koolitused")}>
                {d.home.allCourses}
                <Icon name="up" />
              </Link>
            </div>
            <div className={styles.grid}>
              {cards.map((c) => (
                <CourseCard key={c.id} c={c} />
              ))}
            </div>
          </div>
        </section>
      )}

      <FormatsBlock t={{ eyebrow: f.eyebrow, title: f.title, lead: f.lead, tabsLabel: f.tabsLabel, stepsLabel: f.eyebrow }} tabs={formatTabs} />

      {statement && <Statement eyebrow={d.home.statementEyebrow} text={pick(statement.body, locale)} />}

      <TrainerTeaser
        d={{
          eyebrow: d.trainer.eyebrow,
          name: trainerName,
          text: pick(teaser?.body, locale).trim() || firstParagraph(pick(bio?.body, locale)) || pick(trainer.role, locale),
          portrait: mediaUrl(trainer.portraitKey),
          portraitPos: trainer.portraitPos,
          portraitZoom: trainer.portraitZoom,
          portraitAlt: fill(d.trainer.portraitAlt, { name: trainerName }),
          stats: trainer.stats.map((s) => ({ value: s.value, label: pick(s.label, locale) })),
          link: { label: d.trainer.readMore, href: to("/koolitaja") },
        }}
      />

      <ReviewList reviews={reviews} locale={locale} variant="home" />

      {home.practice.length > 0 && (
        <PracticeBlock
          t={{
            eyebrow: d.practice.eyebrowParnu,
            title: d.practice.title,
            slogan: d.practice.slogan,
            text: d.practice.panelText,
            protocolTitle: d.practice.protocolTitle,
            protocolText: d.practice.protocolText,
            packageLabel: d.practice.package,
            durationLabel: d.practice.duration,
            register: d.practice.register,
          }}
          packages={home.practice.map((p) => ({
            code: p.code,
            name: pick(p.name, locale),
            tagline: pick(p.tagline, locale),
            items: pickList(p.items, locale),
            duration: pick(p.durationLabel, locale),
            price: formatEUR(p.price, locale),
            // The practice page (Task 9) preselects the package from ?pakett and scrolls to the form (#taotlus).
            href: `${to("/praktika")}?pakett=${encodeURIComponent(p.code)}#taotlus`,
          }))}
        />
      )}

      <BlogCarousel
        t={{ eyebrow: d.news.eyebrow, title: d.news.title, lead: d.news.lead, all: d.news.all, carouselLabel: d.news.carouselLabel, prev: d.common.previous, next: d.common.next }}
        allHref={to("/uudised")}
        posts={home.posts.map((p) => ({
          slug: p.slug,
          href: to(`/uudised/${p.slug}`),
          title: pick(p.title, locale),
          excerpt: pick(p.excerpt, locale),
          date: formatDate(p.publishedAt, locale),
          category: pick(p.category, locale),
          cover: mediaUrl(p.coverKey),
        }))}
      />

      <Faq eyebrow={d.home.faqEyebrow} title={d.home.faqTitle} items={home.faq.map((x) => ({ q: pick(x.q, locale), a: pick(x.a, locale) }))} />

      <ContactBlock
        locale={locale}
        person={{ name: trainerName, photo: mediaUrl(trainer.contactPhotoKey) }}
        t={{
          eyebrow: d.home.contactEyebrow,
          title: d.home.contactTitle,
          lead: d.home.contactLead,
          reply: d.home.contactReply,
          name: d.forms.name,
          email: d.forms.email,
          message: d.forms.message,
          messagePlaceholder: d.forms.messagePlaceholder,
          submit: d.forms.submit,
          sending: d.forms.sending,
          sent: d.forms.contactSent,
          errorRequired: d.forms.errorRequired,
          errorEmail: d.forms.errorEmail,
          errorTooMany: d.forms.errorTooMany,
          errorGeneric: d.forms.errorGeneric,
        }}
      />

      <FlashNotice param={NEWSLETTER_LANDING_PARAM} notices={newsletterNotices} fragments={accountNotices} closeLabel={d.common.close} />

      {/* (the admin's draft preview opens it at once and leaves the 30-day stamp alone, R-e) */}
      {newsletterPopup && <NewsletterPopup n={newsletterPopup} locale={locale} preview={drafts} t={{ close: d.common.close, form: popupFormTexts(d, welcomeCode) }} />}
      {previewBar}
    </>
  );
}
