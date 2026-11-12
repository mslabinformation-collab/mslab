import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalPage, legalTitle } from "@/components/site/LegalPage";
import { pageAlternates } from "@/lib/alternates";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const title = await legalTitle("privacy", locale);
  return { ...(title ? { title: `${title} — ${getDict(locale).common.siteName}` } : {}), alternates: pageAlternates(locale, "/privaatsus") };
}

/** /privaatsus: the "privacy" page text (footer and form links). */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <LegalPage pageKey="privacy" locale={locale} />;
}
