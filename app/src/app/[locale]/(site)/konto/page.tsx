import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.nav.account} — ${d.common.siteName}`, robots: { index: false, follow: false } };
}

/**
 * "Minu koolitused": a static shell, the same for every visitor (no cookies, headers or query read here; the CDN serves it
 * without a render). The browser loads the signed-in client's dashboard from GET /api/konto (CoursesTab): nobody signed
 * in → the login page; another device signed in since → the message with "Saada uus kood".
 */
export default async function AccountPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <CoursesTab locale={locale} t={coursesTexts(d)} />
    </AccountShell>
  );
}
