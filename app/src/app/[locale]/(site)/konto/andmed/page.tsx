import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { DetailsTab } from "@/components/account/DetailsTab";
import { detailsTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.shell.details} — ${d.common.siteName}`, robots: { index: false, follow: false } };
}

/**
 * "Minu andmed": a static shell, the same for every visitor (no cookies, headers or query read here; the CDN serves it without a
 * render). The browser loads the signed-in client's profile from GET /api/konto (DetailsTab); the saves go to /api/konto/andmed,
 * /uudiskiri and /kustuta. A language change opens this page in the other language with #salvestatud (a fragment, never a query).
 */
export default async function DetailsPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="details" locale={locale} t={shellTexts(d)}>
      <DetailsTab locale={locale} t={detailsTexts(d)} />
    </AccountShell>
  );
}
