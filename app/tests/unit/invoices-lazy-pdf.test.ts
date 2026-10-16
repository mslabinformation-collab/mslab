import { expect, test, vi } from "vitest";

// The PDF stack is not loaded with server/invoices.ts (the plan's Global Constraints, as certificates.ts): that module comes with the account
// API, the payment routes (settle.ts makes a paid payment's invoice) and the admin pages, while invoice-pdf.ts and certificate-pdf.ts (pdf-lib
// and its fontkit, and the fonts' loader) are needed only when an invoice is rendered: invoicePdf imports them then.

const loaded = vi.hoisted(() => ({ invoice: false, certificate: false }));
vi.mock("@/server/invoice-pdf", async (importOriginal) => {
  loaded.invoice = true;
  return importOriginal();
});
vi.mock("@/server/certificate-pdf", async (importOriginal) => {
  loaded.certificate = true;
  return importOriginal();
});

test("importing server/invoices.ts loads no PDF code", async () => {
  const invoices = await import("@/server/invoices");
  expect(typeof invoices.invoicePdf).toBe("function");
  expect(loaded).toEqual({ invoice: false, certificate: false });
});

// Maria's side (invoices Task 5): the mail of „Saada õpilasele“ and Seaded's sample draw a PDF too, and load the stack only when they do.
test("importing server/invoice-send.ts and server/invoice-sample.ts loads no PDF code", async () => {
  const send = await import("@/server/invoice-send");
  const sample = await import("@/server/invoice-sample");
  expect([typeof send.sendInvoice, typeof sample.sampleInvoicePdf]).toEqual(["function", "function"]);
  expect(loaded).toEqual({ invoice: false, certificate: false });
});
