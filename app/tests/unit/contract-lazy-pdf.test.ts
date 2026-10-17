import { expect, test, vi } from "vitest";

// The PDF stack is not loaded with server/contracts.ts (the contracts' Global Constraints, as invoices.ts and certificates.ts): that module comes with the
// registration form's submit, settle and the account's routes, while contract-pdf.ts and certificate-pdf.ts (pdf-lib and its fontkit, and the fonts'
// loader) are needed only when a contract is rendered: contractPdf imports them then. Maria's side (contracts Task 5) draws PDFs too — Seaded's sample —
// and loads the stack only when it does.

const loaded = vi.hoisted(() => ({ contract: false, certificate: false }));
vi.mock("@/server/contract-pdf", async (importOriginal) => {
  loaded.contract = true;
  return importOriginal();
});
vi.mock("@/server/certificate-pdf", async (importOriginal) => {
  loaded.certificate = true;
  return importOriginal();
});

test("importing server/contracts.ts loads no PDF code", async () => {
  const contracts = await import("@/server/contracts");
  expect(typeof contracts.contractPdf).toBe("function");
  expect(loaded).toEqual({ contract: false, certificate: false });
});

test("importing server/contract-sample.ts loads no PDF code", async () => {
  const sample = await import("@/server/contract-sample");
  expect(typeof sample.sampleContractPdf).toBe("function");
  expect(loaded).toEqual({ contract: false, certificate: false });
});
