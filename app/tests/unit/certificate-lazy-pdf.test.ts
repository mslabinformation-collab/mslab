import { expect, test, vi } from "vitest";

// The PDF stack is not loaded with server/certificates.ts (final review M-1): that module comes with every account API request
// (client-data.ts), the payment routes (admin-clients.ts) and the admin pages, while certificate-pdf.ts (pdf-lib and its fontkit, about
// 2 MB) is needed only when a certificate is rendered: certificatePdf imports it then.

const loaded = vi.hoisted(() => ({ pdf: false }));
vi.mock("@/server/certificate-pdf", async (importOriginal) => {
  loaded.pdf = true;
  return importOriginal();
});

test("importing server/certificates.ts loads no PDF code", async () => {
  const certificates = await import("@/server/certificates");
  expect(typeof certificates.certificatePdf).toBe("function");
  expect(loaded.pdf).toBe(false);
});
