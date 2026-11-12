import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { FavouritesTab } from "@/components/account/FavouritesTab";
import { favouritesTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.shell.favourites} — ${d.common.siteName}`, robots: { index: false, follow: false } };
}

/**
 * "Lemmikud": a static shell, the same for every visitor (no cookies, headers or query read here; the CDN serves it without a
 * render). The browser loads the signed-in client's favourites as course cards from GET /api/konto/lemmikud (FavouritesTab):
 * nobody signed in → the login page; another device signed in since → the message with "Saada uus kood".
 */
export default async function FavouritesPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="favourites" locale={locale} t={shellTexts(d)}>
      <FavouritesTab locale={locale} t={favouritesTexts(d)} />
    </AccountShell>
  );
}
