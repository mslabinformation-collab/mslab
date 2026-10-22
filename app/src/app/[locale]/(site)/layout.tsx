import { notFound } from "next/navigation";
import Script from "next/script";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { SiteReady } from "@/components/site/SiteReady";
import { shellSettings, type ShellSettings } from "@/components/site/settings";
import { FEEDBACK_SCRIPT, REVIEW_TOOLS } from "@/lib/review-tools";
import { logFailure } from "@/server/log";
import { getSiteSettings } from "@/server/site-data";
import { isLocale, type Locale } from "@/i18n/locales";

/**
 * Every public page is cached once rendered (incremental static regeneration) and rendered again when an admin save, a
 * registration or a waitlist entry makes it stale (server/public-cache.ts); the pages that list course dates also every
 * 5 minutes (their own `revalidate`). This is the safety net on top of that: a page older than a day is refreshed on its
 * next visit (that visit still gets the old copy, the following ones the new one), so a change made around the site
 * (directly in the database) shows after a day and a visit. Nothing here may depend on the request: no headers,
 * cookies, query strings or connection().
 */
export const revalidate = 86400;

// Footer contact and newsletter discount come from the settings (a settings save revalidates every page). A failing
// read is not replaced by defaults: the page is cached once rendered, and a footer without the contact details would
// stay for a day. Failing, the render stores nothing: in the daily refresh the previous copy stays in use; for a page a
// change has marked stale (or one never rendered), visitors get the error page until a render succeeds.
async function loadShellSettings(locale: Locale): Promise<ShellSettings> {
  try {
    return shellSettings(await getSiteSettings(), locale);
  } catch (err) {
    logFailure("site shell: settings unavailable", err); // never the message (server/log.ts): it can name the database host
    throw err;
  }
}

// Review tools until launch: Maria's comment widget (public/feedback.js → /api/feedback) on every public page; the admin's own root layout
// (app/admin) loads it too (Dim 22.10), as dir "admin". NEXT_PUBLIC_REVIEW_TOOLS is set in next.config.ts and switched off at the mslab.ee launch
// (lib/review-tools.ts).

// Site shell: B header, page content (<main id="main">, pages must not render their own <main>), footer with newsletter.
export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const settings = await loadShellSettings(locale);
  return (
    <>
      <Header locale={locale} />
      <main id="main">{children}</main>
      <Footer locale={locale} newsletter={settings.newsletter} contact={settings.contact} trainerName={settings.trainerName} />
      {REVIEW_TOOLS && <Script src={FEEDBACK_SCRIPT} strategy="afterInteractive" />}
      <SiteReady />
    </>
  );
}
