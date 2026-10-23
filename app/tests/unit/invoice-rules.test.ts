import { describe, expect, test } from "vitest";
import type { Invoice } from "@/db/schema";
import { seqToIssue } from "@/domain/certificate";
import {
  INVOICE_DEFAULTS, INVOICE_KEY, INVOICE_LIMITS, euro, formatInvoiceNumber, invoiceCsv, invoiceDownloadHeaders, invoiceFileName, invoiceKindOfPayment,
  invoiceSeq, invoiceStatusText, openAmounts, coveringInvoices, paidDay, paidMethodText, parseMonth, partOf, partText, readInvoiceSettings, sellerReady,
  receiptKind, receiptTakeBack, registrationStatusAfterTakeBack, takeBackCents, uninvoicedOf, vatSplit,
  type InvoiceKind, type InvoiceStatus,
} from "@/domain/invoice";
import { prepaymentDue, registrationStatusAfterPayment } from "@/domain/registration";

// The invoice's pure rules (invoices, Task 1; spec §2 D2–D8, §6): the number and its series, the VAT split, the euro text, the amounts still
// open on a registration, the kind of an online payment's invoice, the stored setting read defensively, the download headers and the CSV.

const NBSP = "\u00a0";

describe("the key, the limits and the defaults (spec §3)", () => {
  test("as the spec and the plan name them", () => {
    expect(INVOICE_KEY).toBe("invoice");
    expect(INVOICE_LIMITS).toEqual({ company: 120, registryCode: 20, address: 200, vatNumber: 20, prefix: 10, footer: 300, termDays: 90, vatRate: 50, name: 120, buyerAddress: 200, note: 200 });
    expect(INVOICE_DEFAULTS).toEqual({ company: "", registryCode: "", address: "", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", termDays: 7, footer: "" });
  });
});

describe("formatInvoiceNumber: {prefix}{year}-{nnn} (D7)", () => {
  test.each([
    ["MSL", 2026, 1, "MSL2026-001"],
    ["MSL", 2026, 12, "MSL2026-012"],
    ["MSL", 2026, 999, "MSL2026-999"],
    ["MSL", 2026, 1000, "MSL2026-1000"], // grows past 999, never cut
    ["AB", 2027, 42, "AB2027-042"],
  ])("%s %i #%i is %s", (prefix, year, seq, number) => {
    expect(formatInvoiceNumber(prefix, year, seq)).toBe(number);
  });
});

describe("invoiceSeq: the certificate's seqToIssue, for the invoice series (D7)", () => {
  // (setting, the Tallinn year of the issue, the highest seq already issued under the prefix in that year, 0 for none) → the seq taken
  const CASES: { name: string; setting: { nextYear: number; nextSeq: number }; year: number; top: number; takes: number }[] = [
    { name: "this year, nothing issued: the setting's number", setting: { nextYear: 2026, nextSeq: 3 }, year: 2026, top: 0, takes: 3 },
    { name: "this year, the setting is just past the highest: kept", setting: { nextYear: 2026, nextSeq: 15 }, year: 2026, top: 14, takes: 15 },
    { name: "this year, ahead of the highest (Maria's jump): kept", setting: { nextYear: 2026, nextSeq: 20 }, year: 2026, top: 14, takes: 20 },
    { name: "this year, behind the highest: the highest + 1", setting: { nextYear: 2026, nextSeq: 1 }, year: 2026, top: 14, takes: 15 },
    { name: "this year, equal to the highest: the highest + 1", setting: { nextYear: 2026, nextSeq: 14 }, year: 2026, top: 14, takes: 15 },
    { name: "the previous year's setting, nothing issued this year yet (January): the new year starts at 1", setting: { nextYear: 2026, nextSeq: 15 }, year: 2027, top: 0, takes: 1 },
    { name: "the previous year's setting, this year's numbers already begun: the highest + 1", setting: { nextYear: 2026, nextSeq: 15 }, year: 2027, top: 3, takes: 4 },
    { name: "a setting for next year is not used before that year: this year's highest + 1", setting: { nextYear: 2027, nextSeq: 20 }, year: 2026, top: 14, takes: 15 },
    { name: "a setting for next year, once that year has come: its number", setting: { nextYear: 2027, nextSeq: 20 }, year: 2027, top: 0, takes: 20 },
    { name: "a setting for next year, once that year has come and passed it: the highest + 1", setting: { nextYear: 2027, nextSeq: 20 }, year: 2027, top: 25, takes: 26 },
    // a new prefix has no invoices yet (top is per prefix and year): Maria sets „Järgmine number“ 1 and its series starts at 001 beside the old one's
    { name: "a different prefix, nothing issued under it: starts at 1", setting: { nextYear: 2026, nextSeq: 1 }, year: 2026, top: 0, takes: 1 },
  ];
  test.each(CASES)("$name", ({ setting, year, top, takes }) => {
    expect(invoiceSeq(setting, year, top)).toEqual({ seq: takes, next: { nextYear: year, nextSeq: takes + 1 } });
    // the same rule as the certificate's, not a copy of it
    const cert = seqToIssue(setting, year, top);
    expect(invoiceSeq(setting, year, top)).toEqual({ seq: cert.seq, next: cert.next });
  });
});

describe("vatSplit: vat = round(gross × rate / (100 + rate)), net = gross − vat (D8)", () => {
  test.each([
    [17500, 24, { net: 14113, vat: 3387, gross: 17500 }],
    [17500, null, { net: 17500, vat: 0, gross: 17500 }],
    [35000, 24, { net: 28226, vat: 6774, gross: 35000 }],
    [12400, 24, { net: 10000, vat: 2400, gross: 12400 }],
    [10500, 5, { net: 10000, vat: 500, gross: 10500 }],
    [1, 24, { net: 1, vat: 0, gross: 1 }], // rounds to the cent
    [17500, 0, { net: 17500, vat: 0, gross: 17500 }],
  ])("%i at %s", (gross, rate, want) => {
    expect(vatSplit(gross, rate)).toEqual(want);
  });

  test("net + vat is always the gross, to the cent", () => {
    for (const rate of [5, 9, 22, 24])
      for (let gross = 1; gross <= 2000; gross++) {
        const s = vatSplit(gross, rate);
        expect(s.net + s.vat, `${gross} at ${rate}`).toBe(gross);
        expect(Number.isInteger(s.vat) && s.vat >= 0, `${gross} at ${rate}`).toBe(true);
      }
  });
});

describe("euro: 175,00 € with a comma and a no-break space before the sign", () => {
  test.each([
    [17550, `175,50${NBSP}€`],
    [17500, `175,00${NBSP}€`],
    [5, `0,05${NBSP}€`],
    [0, `0,00${NBSP}€`],
    [99, `0,99${NBSP}€`],
    [100000, `1${NBSP}000,00${NBSP}€`], // thousands grouped by a no-break space, as the site's amounts are
    [123456, `1${NBSP}234,56${NBSP}€`],
  ])("%i", (cents, text) => {
    expect(euro(cents)).toBe(text);
  });
});

describe("openAmounts: what is still to invoice on a registration (D5, the final review's I1 and m4)", () => {
  const inv = (kind: InvoiceKind, status: InvoiceStatus, amountCents: number) => ({ kind, status, amountCents });
  const half = { priceCents: 35000, paymentChoice: "half", paidCents: 0 } as const;
  const full = { priceCents: 35000, paymentChoice: "full", paidCents: 0 } as const;
  const prepayment = { kind: "prepayment", cents: 17500, part: "Ettemaks 50%" } as const;
  const wholeSum = { kind: "full", cents: 35000, part: "Kogu summa (100%)" } as const;
  const balance = { kind: "balance", cents: 17500, part: "Jääk 50%" } as const;
  /** Nothing recorded beyond what the paid invoices cover: „Maksmiseks“ is offered these amounts, „Juba tasutud“ nothing (admin UX pass B4: a receipt only documents recorded money). */
  const requestsOnly = (amounts: readonly unknown[]) => ({ request: amounts, receipt: [] });

  test("half, nothing invoiced: the prepayment or the whole sum", () => {
    expect(openAmounts(half, [])).toEqual(requestsOnly([prepayment, wholeSum]));
  });
  test("half, a paid or an unpaid prepayment: the rest", () => {
    expect(openAmounts({ ...half, paidCents: 17500 }, [inv("prepayment", "paid", 17500)])).toEqual(requestsOnly([balance]));
    expect(openAmounts(half, [inv("prepayment", "unpaid", 17500)])).toEqual(requestsOnly([balance]));
  });
  test("half, a cancelled prepayment only: as nothing invoiced", () => {
    expect(openAmounts(half, [inv("prepayment", "cancelled", 17500)])).toEqual(requestsOnly([prepayment, wholeSum]));
  });
  test("half, a cancelled prepayment and a live one: the live one counts", () => {
    expect(openAmounts(half, [inv("prepayment", "cancelled", 17500), inv("prepayment", "unpaid", 17500)])).toEqual(requestsOnly([balance]));
  });
  test("half, the prepayment and the rest both invoiced, or the whole sum: nothing", () => {
    expect(openAmounts({ ...half, paidCents: 17500 }, [inv("prepayment", "paid", 17500), inv("balance", "unpaid", 17500)])).toEqual(requestsOnly([]));
    expect(openAmounts({ ...half, paidCents: 35000 }, [inv("full", "paid", 35000)])).toEqual(requestsOnly([]));
  });
  test("half, the rest cancelled: offered again", () => {
    expect(openAmounts({ ...half, paidCents: 17500 }, [inv("prepayment", "paid", 17500), inv("balance", "cancelled", 17500)])).toEqual(requestsOnly([balance]));
  });
  test("full: the whole sum, then nothing", () => {
    expect(openAmounts(full, [])).toEqual(requestsOnly([wholeSum]));
    expect(openAmounts(full, [inv("full", "unpaid", 35000)])).toEqual(requestsOnly([]));
    expect(openAmounts({ ...full, paidCents: 35000 }, [inv("full", "paid", 35000)])).toEqual(requestsOnly([]));
    expect(openAmounts(full, [inv("full", "cancelled", 35000)])).toEqual(requestsOnly([wholeSum]));
  });
  test("financing (Järelmaks (Inbank)) is the whole sum like „full“, never a prepayment: the whole sum, then nothing; a receipt for money in is the whole sum", () => {
    const financing = { priceCents: 35000, paymentChoice: "financing", paidCents: 0 } as const;
    expect(openAmounts(financing, [])).toEqual(requestsOnly([wholeSum]));
    expect(openAmounts(financing, [inv("full", "unpaid", 35000)])).toEqual(requestsOnly([]));
    expect(openAmounts({ ...financing, paidCents: 35000 }, [inv("full", "paid", 35000)])).toEqual(requestsOnly([]));
    expect(openAmounts(financing, [inv("full", "cancelled", 35000)])).toEqual(requestsOnly([wholeSum]));
    // 100 € typed by hand on it: a receipt for that money, a first one that is not all of the price: the whole choice's whole sum, in the words „Osamakse“
    expect(openAmounts({ ...financing, paidCents: 10000 }, []).receipt).toEqual([{ kind: "full", cents: 10000, part: "Osamakse" }]);
  });
  test("R11, an odd price: the prepayment is the site's own (prepaymentDue: half rounded up to the cent, so a paid one makes 50 %), the rest is what is left", () => {
    const odd = { priceCents: 35001, paymentChoice: "half", paidCents: 0 } as const;
    expect(openAmounts(odd, []).request).toEqual([
      { kind: "prepayment", cents: 17501, part: "Ettemaks 50%" },
      { kind: "full", cents: 35001, part: "Kogu summa (100%)" },
    ]);
    expect(openAmounts(odd, []).request[0].cents).toBe(prepaymentDue(35001, "half"));
    expect(openAmounts({ ...odd, paidCents: 17501 }, [inv("prepayment", "paid", 17501)])).toEqual(requestsOnly([{ kind: "balance", cents: 17500, part: "Jääk 50%" }]));
    // a paid prepayment is 50 % by the registration's own rule
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: openAmounts(odd, []).request[0].cents }, 35001)).toBe("confirmed");
  });
  test("a one-cent price: its half rounds up to the whole cent, so no rest is left; no price, nothing", () => {
    expect(openAmounts({ priceCents: 1, paymentChoice: "half", paidCents: 0 }, []).request).toEqual([
      { kind: "prepayment", cents: 1, part: "Ettemaks 50%" },
      { kind: "full", cents: 1, part: "Kogu summa (100%)" },
    ]);
    expect(openAmounts({ priceCents: 1, paymentChoice: "half", paidCents: 0 }, [inv("prepayment", "unpaid", 1)])).toEqual(requestsOnly([]));
    expect(openAmounts({ priceCents: 0, paymentChoice: "half", paidCents: 0 }, [])).toEqual(requestsOnly([]));
  });

  // I1: a paid online payment with no invoice yet counts as paid (coveringInvoices puts it in): „Koosta arve“ never offers its money again
  test("I1: a paid online prepayment without an invoice (coveringInvoices: a paid prepayment) leaves only the rest to request, and no receipt (its money is covered)", () => {
    expect(openAmounts({ ...half, paidCents: 17500 }, coveringInvoices(half, [], [{ id: 5, kind: "prepayment", amountCents: 17500, invoiceId: null }]))).toEqual(requestsOnly([balance]));
  });

  // m4/m10: money typed by hand into „Laekunud summa“ that no paid invoice covers
  test.each([
    // [what, the registration, Laekunud summa, its invoices, the requests offered, the receipts offered]
    ["half, the prepayment typed by hand, nothing invoiced: no request asks for it again; the receipt is that prepayment", half, 17500, [], [balance], [prepayment]],
    ["half, the whole sum typed, nothing invoiced: nothing to request; the receipt is the whole sum", half, 35000, [], [], [wholeSum]],
    ["half, an odd 100 € typed: the request is the rest of 250 €; the receipt the 100 €, an „Osamakse“ of the prepayment", half, 10000, [],
      [{ kind: "balance", cents: 25000, part: "Osamakse" }], [{ kind: "prepayment", cents: 10000, part: "Osamakse" }]],
    ["half, the prepayment invoiced and paid, the rest typed too: nothing to request; the receipt is the rest", half, 35000, [inv("prepayment", "paid", 17500)],
      [], [balance]],
    ["half, the prepayment invoiced and paid, 50 € more typed: the request is the 125 € left; the receipt the 50 €", half, 22500, [inv("prepayment", "paid", 17500)],
      [{ kind: "balance", cents: 12500, part: "Osamakse" }], [{ kind: "balance", cents: 5000, part: "Osamakse" }]],
    ["a receipt cancelled while its money stays recorded: the right receipt again, the prepayment", half, 17500, [inv("prepayment", "cancelled", 17500)],
      [balance], [prepayment]],
    ["an unpaid request and the same money typed by hand (not marked): nothing more is requested; the typed money is the prepayment's receipt", half, 17500,
      [inv("prepayment", "unpaid", 17500)], [], [prepayment]],
    ["m10, full: 100 € typed: the request is the rest; the receipt an „Osamakse“ of the whole sum", full, 10000, [],
      [{ kind: "balance", cents: 25000, part: "Osamakse" }], [{ kind: "full", cents: 10000, part: "Osamakse" }]],
    ["m10, full: the rest paid online („Kogu summa“ of 250 €) after 100 € typed: the hand-typed part gets its receipt", full, 35000, [inv("full", "paid", 25000)],
      [], [{ kind: "balance", cents: 10000, part: "Osamakse" }]],
    ["more typed than the price: the receipt is what the price leaves open, never more", half, 50000, [inv("prepayment", "paid", 17500)], [], [balance]],
    ["paid invoices cover more than is recorded (a receipt from before B4 for cash never typed): the rest to request, no receipt", half, 0, [inv("prepayment", "paid", 17500)], [balance], []],
    ["B4: nothing recorded at all: requests only, „Juba tasutud“ offers nothing", half, 0, [], [prepayment, wholeSum], []],
  ] as const)("m4: %s", (_, r, paidCents, invoiced, request, receipt) => {
    expect(openAmounts({ ...r, paidCents }, invoiced)).toEqual({ request, receipt });
  });
});

describe("receiptKind: the kind of a receipt for money received (m4; admin UX pass B4 and its review's m2)", () => {
  const half = { priceCents: 29000, paymentChoice: "half" } as const;
  const paid = (kind: InvoiceKind, amountCents: number) => ({ kind, status: "paid" as const, amountCents });

  test("the first money in: the whole sum when it is all of the price, else the half choice's prepayment or the whole choice's whole sum", () => {
    expect(receiptKind(half, [], 29000)).toBe("full");
    expect(receiptKind(half, [], 14500)).toBe("prepayment");
    expect(receiptKind({ ...half, paymentChoice: "full" }, [], 14500)).toBe("full");
    expect(receiptKind({ ...half, paymentChoice: "financing" }, [], 14500)).toBe("full");
    // an unpaid or cancelled invoice is no money in
    expect(receiptKind(half, [{ kind: "prepayment", status: "unpaid", amountCents: 14500 }, { kind: "full", status: "cancelled", amountCents: 29000 }], 14500)).toBe("prepayment");
  });

  test("later money is the rest: after a paid prepayment or whole sum, or after money recorded earlier that no paid invoice covers", () => {
    expect(receiptKind(half, [paid("prepayment", 14500)], 14500)).toBe("balance");
    expect(receiptKind(half, [paid("full", 29000)], 100)).toBe("balance");
    // „Lisa laekumine“: 145 € recorded without a receipt, then the next 145 € with one — the rest, „Jääk 50%“, not a second „Ettemaks 50%“
    expect(receiptKind(half, [], 14500, 14500)).toBe("balance");
    expect(partOf(receiptKind(half, [], 14500, 14500), 14500, 29000)).toBe("Jääk 50%");
    // a paid rest alone is no first money: the first money is still the prepayment
    expect(receiptKind(half, [paid("balance", 14500)], 14500)).toBe("prepayment");
    expect(receiptKind(half, [], 14500, 0)).toBe("prepayment");
  });
});

describe("coveringInvoices: what covers a registration's price, its paid online payments without an invoice too (I1)", () => {
  const r = { paymentChoice: "half" } as const;
  const inv = (id: number, kind: InvoiceKind, status: InvoiceStatus, amountCents: number) => ({ id, kind, status, amountCents });
  const pay = (id: number, kind: "prepayment" | "balance" | "ecourse", amountCents: number, invoiceId: number | null = null) => ({ id, kind, amountCents, invoiceId });

  test("its invoices as they are, and none without payments", () => {
    expect(coveringInvoices(r, [inv(1, "prepayment", "unpaid", 17500), inv(2, "balance", "cancelled", 17500)], [])).toEqual([
      { kind: "prepayment", status: "unpaid", amountCents: 17500 },
      { kind: "balance", status: "cancelled", amountCents: 17500 },
    ]);
  });
  test("a paid payment with no invoice counts as paid, of the kind its catch-up will give it (invoiceKindOfPayment)", () => {
    expect(coveringInvoices(r, [], [pay(5, "prepayment", 17500)])).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
    expect(coveringInvoices({ paymentChoice: "full" }, [], [pay(5, "prepayment", 35000)])).toEqual([{ kind: "full", status: "paid", amountCents: 35000 }]);
    expect(coveringInvoices({ paymentChoice: "financing" }, [], [pay(5, "prepayment", 35000)])).toEqual([{ kind: "full", status: "paid", amountCents: 35000 }]);
    expect(coveringInvoices(r, [], [pay(5, "balance", 17500)])).toEqual([{ kind: "balance", status: "paid", amountCents: 17500 }]);
  });
  test("R14: one started for an unpaid invoice of its sum: its catch-up pays THAT invoice, so the invoice counts as paid and the payment not again", () => {
    expect(coveringInvoices(r, [inv(1, "full", "unpaid", 35000)], [pay(5, "prepayment", 35000, 1)])).toEqual([{ kind: "full", status: "paid", amountCents: 35000 }]);
  });
  test("R7: one started for an invoice no longer unpaid (marked, cancelled): a paid entry of its own, of that invoice's kind", () => {
    expect(coveringInvoices(r, [inv(1, "full", "cancelled", 35000)], [pay(5, "prepayment", 35000, 1)])).toEqual([
      { kind: "full", status: "cancelled", amountCents: 35000 },
      { kind: "full", status: "paid", amountCents: 35000 },
    ]);
    expect(coveringInvoices(r, [inv(1, "prepayment", "paid", 17500)], [pay(5, "prepayment", 17500, 1)])).toEqual([
      { kind: "prepayment", status: "paid", amountCents: 17500 },
      { kind: "prepayment", status: "paid", amountCents: 17500 },
    ]);
  });
  test("two payments started for one unpaid invoice: the first catch-up pays it, the second has its own", () => {
    expect(coveringInvoices(r, [inv(1, "prepayment", "unpaid", 17500)], [pay(5, "prepayment", 17500, 1), pay(6, "prepayment", 17500, 1)])).toEqual([
      { kind: "prepayment", status: "paid", amountCents: 17500 },
      { kind: "prepayment", status: "paid", amountCents: 17500 },
    ]);
  });
  test("an invoice of another sum, or not among the registration's, is no link: the payment's own kind", () => {
    expect(coveringInvoices(r, [inv(1, "full", "unpaid", 35000)], [pay(5, "prepayment", 17500, 1), pay(6, "balance", 17500, 99)])).toEqual([
      { kind: "full", status: "unpaid", amountCents: 35000 },
      { kind: "prepayment", status: "paid", amountCents: 17500 },
      { kind: "balance", status: "paid", amountCents: 17500 },
    ]);
  });
});

describe("receiptTakeBack: what „Võta tasumine tagasi“ of a receipt takes off Laekunud summa and does to the status (S3-f; B4 review I1, m4)", () => {
  const inv = (id: number, kind: InvoiceKind, status: InvoiceStatus, amountCents: number) => ({ id, kind, status, amountCents });
  const reg = (over: Partial<Parameters<typeof receiptTakeBack>[0]> = {}) => ({ status: "confirmed" as const, paidCents: 14500, paymentChoice: "half" as const, ...over });
  const receipt = { id: 1, amountCents: 14500 };

  test("takeBackCents: the receipt's amount, but never more than what no other paid invoice covers, and never below 0", () => {
    expect(takeBackCents(14500, 14500, 0)).toBe(14500);
    expect(takeBackCents(29000, 14500, 14500)).toBe(14500);
    // an old receipt for venue money that was never recorded: the online payment's 145 € is not its to take back
    expect(takeBackCents(14500, 14500, 14500)).toBe(0);
    expect(takeBackCents(20000, 14500, 14500)).toBe(5500);
    expect(takeBackCents(0, 14500, 0)).toBe(0);
    expect(takeBackCents(5000, 14500, 9000)).toBe(0); // (never negative)
  });

  test("the receipt alone covers the money: all of it comes off, and a confirmed registration under 50 % goes back to „Ootab ettemaksu“", () => {
    expect(receiptTakeBack(reg(), 29000, receipt, [inv(1, "prepayment", "paid", 14500)], [])).toEqual({ cents: 14500, backToAwaiting: true });
  });

  test("the rest still makes 50 %: the place stays", () => {
    expect(receiptTakeBack(reg({ paidCents: 29000 }), 29000, { id: 2, amountCents: 14500 }, [inv(1, "prepayment", "paid", 14500), inv(2, "balance", "paid", 14500)], [])).toEqual({
      cents: 14500,
      backToAwaiting: false,
    });
  });

  test("another paid invoice, or a paid online payment waiting for its invoice, covers its part: the cap", () => {
    // 145 € paid online (no invoice yet) and a 145 € receipt for venue money never recorded: the receipt takes nothing off
    expect(receiptTakeBack(reg(), 29000, receipt, [inv(1, "balance", "paid", 14500)], [{ id: 9, kind: "prepayment", invoiceId: null, amountCents: 14500 }])).toEqual({ cents: 0, backToAwaiting: false });
    // an unpaid or cancelled invoice covers nothing
    expect(receiptTakeBack(reg(), 29000, receipt, [inv(1, "prepayment", "paid", 14500), inv(2, "balance", "unpaid", 14500), inv(3, "balance", "cancelled", 14500)], [])).toEqual({ cents: 14500, backToAwaiting: true });
  });

  test("only a confirmed registration goes back: an awaiting one stays, a cancelled one stays, a course with no price keeps its status", () => {
    expect(receiptTakeBack(reg({ status: "awaiting_prepayment" }), 29000, receipt, [inv(1, "prepayment", "paid", 14500)], []).backToAwaiting).toBe(false);
    expect(receiptTakeBack(reg({ status: "cancelled" }), 29000, receipt, [inv(1, "prepayment", "paid", 14500)], []).backToAwaiting).toBe(false);
    expect(receiptTakeBack(reg(), null, receipt, [inv(1, "prepayment", "paid", 14500)], [])).toEqual({ cents: 14500, backToAwaiting: false });
  });

  test("the status after: it only stays or steps down, never confirms (registrationStatusAfterTakeBack)", () => {
    expect(registrationStatusAfterTakeBack({ status: "confirmed", paidCents: 14500 }, 29000)).toBe("confirmed");
    expect(registrationStatusAfterTakeBack({ status: "confirmed", paidCents: 14499 }, 29000)).toBe("awaiting_prepayment");
    // awaiting with 50 % paid (its session was full): taking money back never confirms it
    expect(registrationStatusAfterTakeBack({ status: "awaiting_prepayment", paidCents: 20000 }, 29000)).toBe("awaiting_prepayment");
    expect(registrationStatusAfterTakeBack({ status: "cancelled", paidCents: 0 }, 29000)).toBe("cancelled");
    expect(registrationStatusAfterTakeBack({ status: "confirmed", paidCents: 0 }, null)).toBe("confirmed");
  });
});

describe("uninvoicedOf: a registration's paid payments that no invoice names (I1, the drawer's „Arved“)", () => {
  test("paid and named by no invoice; a pending, failed, held or refunded one, or one an invoice names, is not", () => {
    const p = (id: number, status: string) => ({ id, status });
    const list = [p(1, "paid"), p(2, "paid"), p(3, "pending"), p(4, "failed"), p(5, "held"), p(6, "refunded"), p(7, "paid")];
    expect(uninvoicedOf(list, [{ paymentId: 2 }, { paymentId: null }]).map((x) => x.id)).toEqual([1, 7]);
  });
});

describe("partOf: the part an amount is of the price, in words (m4, m10)", () => {
  test.each([
    ["prepayment", 17500, 35000, "Ettemaks 50%"],
    ["prepayment", 17501, 35001, "Ettemaks 50%"],
    ["prepayment", 10000, 35000, "Osamakse"],
    ["full", 35000, 35000, "Kogu summa (100%)"],
    ["full", 25000, 35000, "Osamakse"],
    ["balance", 17500, 35000, "Jääk 50%"],
    ["balance", 17500, 35001, "Jääk 50%"],
    ["balance", 15000, 35000, "Osamakse"],
    ["ecourse", 9500, 9500, "E-koolitus"],
    ["ecourse", 4000, 9500, "E-koolitus"],
    ["prepayment", 17500, null, "Ettemaks 50%"], // no price to measure against: the kind's own words
  ] as const)("%s of %i cents at a price of %s: %s", (kind, cents, price, text) => {
    expect(partOf(kind, cents, price)).toBe(text);
  });
});

describe("invoiceKindOfPayment: the kind of the invoice an online payment makes", () => {
  test.each([
    [{ kind: "prepayment" }, { paymentChoice: "half" }, "prepayment"],
    [{ kind: "prepayment" }, { paymentChoice: "full" }, "full"],
    [{ kind: "prepayment" }, { paymentChoice: "financing" }, "full"], // Järelmaks (Inbank) is the whole sum: never „Ettemaks 50%“
    [{ kind: "balance" }, { paymentChoice: "financing" }, "balance"],
    [{ kind: "prepayment" }, null, "prepayment"], // the registration is gone: the payment's own kind
    [{ kind: "balance" }, { paymentChoice: "half" }, "balance"],
    [{ kind: "balance" }, { paymentChoice: "full" }, "balance"],
    [{ kind: "ecourse" }, null, "ecourse"],
  ] as const)("%j with %j is %s", (payment, registration, kind) => {
    expect(invoiceKindOfPayment(payment, registration)).toBe(kind);
  });
});

describe("partText, the state and method texts (D4, D6)", () => {
  test("the part of the price an invoice is for", () => {
    expect(partText("prepayment")).toBe("Ettemaks 50%");
    expect(partText("full")).toBe("Kogu summa (100%)");
    expect(partText("balance")).toBe("Jääk 50%");
    expect(partText("ecourse")).toBe("E-koolitus");
  });
  test("the states and the ways of paying, as the spec words them", () => {
    expect(invoiceStatusText("unpaid")).toBe("Tasumata");
    expect(invoiceStatusText("paid")).toBe("Tasutud");
    expect(invoiceStatusText("cancelled")).toBe("Tühistatud");
    expect(paidMethodText("montonio")).toBe("Montonio");
    expect(paidMethodText("bank")).toBe("Pangaülekanne");
    expect(paidMethodText("cash")).toBe("Sularaha");
    expect(paidMethodText("card")).toBe("Kaardimakse kohapeal");
    expect(paidMethodText("financing")).toBe("Järelmaks (Inbank)");
  });
});

describe("the download: file name and headers (spec §4)", () => {
  test("the file name by the number", () => {
    expect(invoiceFileName("MSL2026-001")).toBe("MS-LAB-arve-MSL2026-001.pdf");
    expect(invoiceFileName("AB2027-1000")).toBe("MS-LAB-arve-AB2027-1000.pdf");
  });
  test("a prefix with a sign a header cannot carry never reaches the header", () => {
    expect(invoiceFileName('X"Y\r\nZ 2026-001')).toBe("MS-LAB-arve-X-Y-Z-2026-001.pdf");
    expect(invoiceFileName("Õ2026-001")).toBe("MS-LAB-arve--2026-001.pdf");
  });
  test("the type, the file name and nosniff (the caller adds private, no-store)", () => {
    expect(invoiceDownloadHeaders("MSL2026-001")).toEqual({
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="MS-LAB-arve-MSL2026-001.pdf"',
      "x-content-type-options": "nosniff",
    });
  });
});

describe("readInvoiceSettings: the stored setting read defensively (D2)", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const defaults = { ...INVOICE_DEFAULTS, nextYear: 2026, nextSeq: 1 };
  const stored = {
    company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1, Tallinn", vatNumber: "EE123456789", vatOn: true, vatRate: 22,
    prefix: "ML", nextYear: 2026, nextSeq: 14, termDays: 14, footer: "Täname!",
  };

  test("nothing stored, or not an object: the defaults, this Tallinn year and 1", () => {
    for (const value of [null, undefined, "x", 5, [], true]) expect(readInvoiceSettings(value, now)).toEqual(defaults);
    expect(readInvoiceSettings({ garbage: 1, company: 5, vatOn: "yes" }, now)).toEqual(defaults);
    expect(readInvoiceSettings(null, new Date("2026-12-31T22:30:00Z"))).toMatchObject({ nextYear: 2027, nextSeq: 1 });
  });

  test("a well-formed setting as it is, its texts trimmed", () => {
    expect(readInvoiceSettings(stored, now)).toEqual(stored);
    expect(readInvoiceSettings({ ...stored, company: "  MS LAB OÜ ", prefix: " ML " }, now)).toEqual(stored);
  });

  test("each malformed text is its default: not a string, blank, or over its limit", () => {
    expect(readInvoiceSettings({ company: "x".repeat(121), registryCode: "1".repeat(21), address: "a".repeat(201), vatNumber: "v".repeat(21), prefix: "P".repeat(11), footer: "f".repeat(301) }, now)).toEqual(defaults);
    expect(readInvoiceSettings({ prefix: "   ", company: "   " }, now)).toEqual(defaults);
    expect(readInvoiceSettings({ company: "x".repeat(120), registryCode: "1".repeat(20), address: "a".repeat(200), vatNumber: "v".repeat(20), prefix: "P".repeat(10), footer: "f".repeat(300) }, now)).toMatchObject({
      company: "x".repeat(120), registryCode: "1".repeat(20), address: "a".repeat(200), vatNumber: "v".repeat(20), prefix: "P".repeat(10), footer: "f".repeat(300),
    });
  });

  test("VAT is on only with a VAT number: vatOn true and an empty (or bad) number reads false", () => {
    expect(readInvoiceSettings({ ...stored, vatNumber: "" }, now).vatOn).toBe(false);
    expect(readInvoiceSettings({ ...stored, vatNumber: "   " }, now).vatOn).toBe(false);
    expect(readInvoiceSettings({ ...stored, vatNumber: "v".repeat(21) }, now).vatOn).toBe(false);
    expect(readInvoiceSettings({ vatOn: true }, now).vatOn).toBe(false);
    expect(readInvoiceSettings({ ...stored, vatOn: false }, now).vatOn).toBe(false);
    expect(readInvoiceSettings({ ...stored, vatOn: "true" }, now).vatOn).toBe(false);
    expect(readInvoiceSettings(stored, now).vatOn).toBe(true);
  });

  test("the rate is a whole 1–50, else 24; the term a whole 0–90, else 7", () => {
    for (const vatRate of [0, 51, 24.5, "24", null, -1]) expect(readInvoiceSettings({ vatRate }, now).vatRate, String(vatRate)).toBe(24);
    expect(readInvoiceSettings({ vatRate: 1 }, now).vatRate).toBe(1);
    expect(readInvoiceSettings({ vatRate: 50 }, now).vatRate).toBe(50);
    for (const termDays of [-1, 91, 3.5, "7", null]) expect(readInvoiceSettings({ termDays }, now).termDays, String(termDays)).toBe(7);
    expect(readInvoiceSettings({ termDays: 0 }, now).termDays).toBe(0);
    expect(readInvoiceSettings({ termDays: 90 }, now).termDays).toBe(90);
  });

  test("the next number is a pair: a whole year 2000–9999 and a whole number from 1 to the largest an integer column holds, else both are the default", () => {
    const INT4_MAX = 2_147_483_647; // invoices.seq is an integer column: a larger next number would fail the insert inside the payment-settle transaction
    for (const [nextYear, nextSeq] of [[2026, 0], [2026, 1.5], [2026, "3"], [26, 3], [10_000, 3], [1999, 3], [2026.5, 3], [null, 3], [2026, null], [2026, INT4_MAX + 1], [2026, Number.MAX_SAFE_INTEGER], [2026, Infinity], [2026, NaN]])
      expect(readInvoiceSettings({ nextYear, nextSeq }, now), `${nextYear} ${nextSeq}`).toMatchObject({ nextYear: 2026, nextSeq: 1 });
    for (const [nextYear, nextSeq] of [[2025, 31], [2000, 1], [9999, 7], [2026, INT4_MAX]])
      expect(readInvoiceSettings({ nextYear, nextSeq }, now), `${nextYear} ${nextSeq}`).toMatchObject({ nextYear, nextSeq });
  });
});

describe("sellerReady: company, registry code and address (D3)", () => {
  const ready = { ...INVOICE_DEFAULTS, nextYear: 2026, nextSeq: 1, company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1" };
  test("all three filled", () => {
    expect(sellerReady(ready)).toBe(true);
  });
  test.each(["company", "registryCode", "address"] as const)("false without the %s", (field) => {
    expect(sellerReady({ ...ready, [field]: "" })).toBe(false);
  });
  test("the defaults are not ready", () => {
    expect(sellerReady({ ...INVOICE_DEFAULTS, nextYear: 2026, nextSeq: 1 })).toBe(false);
  });
});

describe("parseMonth: the „Arved“ page's ?kuu= and the CSV's (Task 5)", () => {
  test("a Tallinn month as YYYY-MM, January to December", () => {
    for (const month of ["2026-01", "2026-10", "2026-12", "2030-06"]) expect(parseMonth(month), month).toBe(month);
  });
  test("anything else is null: another month, a day, a space, a list, a number, nothing", () => {
    for (const bad of ["2026-00", "2026-13", "2026-1", "26-10", "2026-10-01", " 2026-10", "2026-10 ", "2026/10", "oktoober", "", ["2026-10"], 202610, null, undefined])
      expect(parseMonth(bad), String(bad)).toBeNull();
  });
});

describe("paidDay: the date Maria gives for money received (Task 5)", () => {
  const now = new Date("2026-10-16T21:30:00Z"); // 17.10.2026 00:30 in Tallinn (summer time, UTC+3)
  test("today in Tallinn is now itself (the day's own time, not a noon still to come)", () => {
    expect(paidDay("2026-10-17", now)).toBe(now);
  });
  test("another day is noon of it in Tallinn, summer or winter time", () => {
    expect(paidDay("2026-10-15", now)?.toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(paidDay("2026-11-02", now)?.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });
  test("a day after today is still an instant: refusing it is the server's rule (a receipt cannot be dated ahead)", () => {
    expect(paidDay("2026-10-20", now)?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });
  test("a date that is no date is null", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "17.10.2026", "2026-10-17T10:00", "", " 2026-10-17", null, undefined, 20261017, new Date(now)])
      expect(paidDay(bad, now), String(bad)).toBeNull();
  });
});

describe("invoiceCsv: for the accountant (§6.5)", () => {
  const seller = { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1", vatNumber: "", receiver: "MS LAB OÜ", iban: "EE000000000000000000", bank: "Pank" };
  const buyer = { name: "Kati Kask", email: "kati@example.test", address: "", company: "", companyCode: "", companyAddress: "" };
  const base: Invoice = {
    id: 1, number: "MSL2026-001", prefix: "MSL", year: 2026, seq: 1, kind: "prepayment", registrationId: 5, paymentId: null, courseId: 2, clientId: 3,
    status: "paid", amountCents: 17500, vatRate: null, line: { course: "Kulmumeistri baaskoolitus", session: "14.11.2026 Tallinn", part: "Ettemaks 50%" },
    seller, buyer, reference: "MSL2026-001", issuedAt: new Date("2026-10-15T09:00:00Z"), dueAt: new Date("2026-10-22T09:00:00Z"),
    paidAt: new Date("2026-10-16T21:30:00Z"), paidMethod: "bank", paidAdds: true, sentAt: null, sentNote: "", cancelledAt: null, createdAt: new Date("2026-10-15T09:00:00Z"),
    footer: "",
  };
  const HEADER = "Arve nr;Kuupäev;Tasumise tähtaeg;Ostja;Ostja ettevõte;Registrikood;Kirjeldus;Summa käibemaksuta;Käibemaks;Kokku;Olek;Tasumise kuupäev;Makseviis";
  /** The rows after the header, each without its CRLF (a text field may hold a line break of its own, so not a split on it). */
  const rowsOf = (list: (Invoice & { refunded?: boolean })[]): string[] => {
    const csv = invoiceCsv(list);
    const head = `\uFEFF${HEADER}\r\n`;
    expect(csv.startsWith(head)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const body = csv.slice(head.length, -2);
    return body === "" ? [] : body.split("\r\n");
  };
  // the fixed cells around the buyer's name in `base`
  const BEFORE_NAME = '"MSL2026-001";15.10.2026;22.10.2026;';
  const AFTER_NAME = ';"";"";"Kulmumeistri baaskoolitus — Ettemaks 50%";175,00;0,00;175,00;Tasutud;17.10.2026;Pangaülekanne';

  test("the BOM, the exact header, one CRLF-ended line per invoice, the text fields quoted and the amounts bare with comma decimals", () => {
    const csv = invoiceCsv([base]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe(`\uFEFF${HEADER}\r\n"MSL2026-001";15.10.2026;22.10.2026;"Kati Kask";"";"";"Kulmumeistri baaskoolitus — Ettemaks 50%";175,00;0,00;175,00;Tasutud;17.10.2026;Pangaülekanne\r\n`);
  });

  test("a VAT invoice splits the sum; an unpaid one has no paid date and no method; a company buyer fills its columns", () => {
    const vat: Invoice = {
      ...base, id: 2, number: "MSL2026-002", seq: 2, status: "unpaid", vatRate: 24, paidAt: null, paidMethod: null,
      buyer: { ...buyer, company: "Salong OÜ", companyCode: "87654321" },
    };
    expect(rowsOf([vat])).toEqual(['"MSL2026-002";15.10.2026;22.10.2026;"Kati Kask";"Salong OÜ";"87654321";"Kulmumeistri baaskoolitus — Ettemaks 50%";141,13;33,87;175,00;Tasumata;;']);
  });

  test("a cancelled row is marked and has zero sums, whatever the amount was", () => {
    const cancelled: Invoice = { ...base, id: 3, number: "MSL2026-003", seq: 3, status: "cancelled", vatRate: 24, paidAt: null, paidMethod: null, cancelledAt: new Date("2026-10-18T09:00:00Z") };
    expect(rowsOf([cancelled])).toEqual(['"MSL2026-003";15.10.2026;22.10.2026;"Kati Kask";"";"";"Kulmumeistri baaskoolitus — Ettemaks 50%";0,00;0,00;0,00;Tühistatud;;']);
  });

  test("I3: a paid invoice whose payment was refunded or voided reads „Tagastatud“ (stored paid); its sums, its paid date and its way stay as issued", () => {
    const refunded = { ...base, id: 5, number: "MSL2026-005", seq: 5, paidMethod: "montonio" as const, refunded: true };
    expect(rowsOf([refunded, { ...base, refunded: false }])).toEqual([
      '"MSL2026-005";15.10.2026;22.10.2026;"Kati Kask";"";"";"Kulmumeistri baaskoolitus — Ettemaks 50%";175,00;0,00;175,00;Tagastatud;17.10.2026;Montonio',
      `${BEFORE_NAME}"Kati Kask"${AFTER_NAME}`,
    ]);
  });

  test("two invoices, one cancelled: in the order given, the dates in Tallinn time (a born-paid invoice has no due date)", () => {
    const born: Invoice = { ...base, id: 4, number: "MSL2026-004", seq: 4, dueAt: null, issuedAt: new Date("2026-12-31T22:30:00Z"), paidAt: new Date("2026-12-31T22:30:00Z"), paidMethod: "montonio" };
    const cancelled: Invoice = { ...base, id: 3, number: "MSL2026-003", seq: 3, status: "cancelled", paidAt: null, paidMethod: null };
    const rows = rowsOf([born, cancelled]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('"MSL2026-004";01.01.2027;;"Kati Kask";"";"";"Kulmumeistri baaskoolitus — Ettemaks 50%";175,00;0,00;175,00;Tasutud;01.01.2027;Montonio');
    expect(rows[1]).toContain(";0,00;0,00;0,00;Tühistatud;;");
  });

  test("no invoices: the BOM and the header only", () => {
    expect(invoiceCsv([])).toBe(`\uFEFF${HEADER}\r\n`);
    expect(rowsOf([])).toEqual([]);
  });

  test.each([
    // [what the buyer typed, the exact cell]: every text field is quoted, a quote doubled, so no `;` or `,` splits it
    ["Kati Kask", '"Kati Kask"'],
    ['Kask, Kati; "Õun"', '"Kask, Kati; ""Õun"""'],
    ["", '""'],
    ["Kati -Kask", '"Kati -Kask"'], // a sign inside the text is not a formula
    ["1\n2", '"1\n2"'], // a line break stays inside its quotes
    // what a spreadsheet would read as a formula gets a leading apostrophe, after any white space as well
    ["=1+1", `"'=1+1"`],
    ["  =cmd", `"'  =cmd"`],
    ["\t=x", `"'\t=x"`],
    ["\r=x", `"'\r=x"`],
    ["\n=x", `"'\n=x"`],
    ["+1", `"'+1"`],
    ["-2", `"'-2"`],
    ["@a", `"'@a"`],
    [" @SUM(A1)", `"' @SUM(A1)"`],
    ['=HYPERLINK("http://x";"y")', `"'=HYPERLINK(""http://x"";""y"")"`],
    ["\t", `"'\t"`], // a tab alone: the guard covers it
  ])("the buyer's name %j is the cell %s", (name, cell) => {
    const [row] = rowsOf([{ ...base, buyer: { ...buyer, name } }]);
    expect(row).toBe(`${BEFORE_NAME}${cell}${AFTER_NAME}`);
  });

  test("every text column is guarded alike: the number, the buyer's company and registry code, the description", () => {
    const odd: Invoice = {
      ...base, number: "-X2026-001", buyer: { ...buyer, company: "@Salong; OÜ", companyCode: "=1" },
      line: { course: "+Kursus", session: "", part: "Ettemaks 50%" },
    };
    expect(rowsOf([odd])).toEqual([
      `"'-X2026-001";15.10.2026;22.10.2026;"Kati Kask";"'@Salong; OÜ";"'=1";"'+Kursus — Ettemaks 50%";175,00;0,00;175,00;Tasutud;17.10.2026;Pangaülekanne`,
    ]);
  });
});
