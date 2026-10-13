import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { ProtocolPage } from "@/components/account/ProtocolPage";
import { protocolTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.protocol.title} — ${d.common.siteName}` };
}

/**
 * A student's protocol (phase protocols, spec §5): /konto/protokoll#id=<registration id>. A static shell, the same for every visitor (no
 * cookies, headers or query read here; the id is in the fragment, which no server or cache sees). The browser loads the protocol from
 * GET /api/konto/protokoll?id= (ProtocolPage): only the copy Maria sent, only for the signed-in student's own registration.
 */
export default async function ProtocolShellPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <ProtocolPage locale={locale} t={protocolTexts(d)} />
    </AccountShell>
  );
}
