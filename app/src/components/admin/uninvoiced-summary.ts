import { euro } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";

/** The most payers the summary names when there are more than this many: the rest are „ja {n} teist“. */
const NAMED = 3;

/**
 * The summary line of the strip „Arveta maksed: {n}“ (README A6; the Part 2 prototype: „Tasutud, aga arve puudub · 1 325,00 € · Merilin Kuusk, Kati Kask,
 * Mari Tamm ja 3 teist“): their total, and the payers in the order given (the oldest payment first). Up to four payers are all named; more than
 * four: the first three and „ja {n} teist“ — never „ja 1 teist“, for which the prototype draws no form. A payer with two payments is named once and
 * counts once among the others.
 */
export function unbilledSummary(payments: { name: string; amountCents: number }[]): string {
  const t = adminEt.invoices.uninvoiced;
  const names = [...new Set(payments.map((p) => p.name))];
  const shown = names.length <= NAMED + 1 ? names : names.slice(0, NAMED);
  const rest = names.length - shown.length;
  const who = rest > 0 ? `${shown.join(", ")} ${fill(t.others, { n: rest })}` : shown.join(", ");
  return fill(t.summary, { sum: euro(payments.reduce((sum, p) => sum + p.amountCents, 0)), names: who });
}
