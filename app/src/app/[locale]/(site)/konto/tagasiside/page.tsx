import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { FeedbackForm } from "@/components/account/FeedbackForm";
import { feedbackTexts, shellTexts } from "@/components/account/texts";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.account.feedback.title} — ${d.common.siteName}` };
}

/**
 * The course feedback form (phase protocols, spec §7): /konto/tagasiside#id=<registration id>. A static shell, the same for every visitor (no
 * cookies, headers or query read here; the id is in the fragment). The browser loads the form's state from GET /api/konto/tagasiside?id= and
 * posts the answers to POST /api/konto/tagasiside (FeedbackForm).
 */
export default async function FeedbackShellPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <AccountShell tab="courses" locale={locale} t={shellTexts(d)}>
      <FeedbackForm locale={locale} t={feedbackTexts(d)} />
    </AccountShell>
  );
}
