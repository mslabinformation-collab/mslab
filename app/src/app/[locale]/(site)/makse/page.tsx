import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaymentResult } from "@/components/site/PaymentResult";
import { getDict, isLocale } from "@/i18n/locales";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.payment.result.title} — ${d.common.siteName}` };
}

/**
 * /makse (phase 2b, spec 6.5): where the bank sends the payer back (api/payments/return). A static page like every public page, the same for
 * everyone and cached: it reads only `params`, no cookies, headers or query. The result is in the address's fragment, which no server or
 * cache sees, read in the browser (components/site/PaymentResult.tsx).
 */
export default async function PaymentResultPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return <PaymentResult locale={locale} t={{ ...d.payment.result, payBank: d.payment.payBank, account: d.account.shell.courses }} />;
}
