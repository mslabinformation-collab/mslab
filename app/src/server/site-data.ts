import { cache } from "react";
import { getDb } from "@/db/client";
import { getSettings } from "@/db/queries/public";
import { FINANCING_KEY, financingOffered, readFinancingSettings } from "@/domain/financing";
import { paymentsConfigured } from "./payments/montonio";

/** The settings table, read once per request: the site layout (footer) and several pages need it. */
export const getSiteSettings = cache((): Promise<Record<string, unknown>> => getSettings(getDb()));

/**
 * Is Järelmaks (Inbank) a choice for this price (instalments D4)? Maria has switched it on in Seaded (`settings`, as getSiteSettings read them), Montonio
 * payments are on, and the price is 100–5000 € (none: no choice). The course page's line and the registration form's radio, and the cart's choice, show on
 * this; the payment start asks the same rules again (server/payments/start.ts) when she presses, so a page a few minutes old can only be refused there.
 */
export function financingShown(settings: Record<string, unknown>, priceCents: number | null): boolean {
  return financingOffered({ enabled: readFinancingSettings(settings[FINANCING_KEY]).enabled, paymentsOn: paymentsConfigured(), priceCents });
}

/**
 * Maria's Järelmaks (Inbank) toggle and Montonio's payments, as the registration form wants them (F1): the form decides whether the choice is
 * offered on its own total, which a code changes (domain/financing.ts financingChoice), so the page passes the two switches and not the answer.
 */
export function financingSwitch(settings: Record<string, unknown>): { enabled: boolean; paymentsOn: boolean } {
  return { enabled: readFinancingSettings(settings[FINANCING_KEY]).enabled, paymentsOn: paymentsConfigured() };
}
