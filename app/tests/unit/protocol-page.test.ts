import { expect, test, vi } from "vitest";
import { MAIL_GAP_MS } from "@/server/protocols";

// The page that hosts "Lukusta ja saada kõik" (spec §4, §8). The bulk send answers once its transactions are done, and its mails go out
// afterwards as ONE task of after(), one after another MAIL_GAP_MS apart (server/protocols.ts mailProtocols); that task runs under the host
// page's time limit (maxDuration), which the page must set itself: a task cut short loses the mails of the students it did not reach, and a
// mail cannot be sent again for its version. The action takes at most 100 protocols (actions/admin-protocols.ts), so the limit must hold 100
// mails with a request's time each; 300 s is the longest a function may run on Vercel Hobby.

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/Shell", () => ({ Shell: () => null }));
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));

import * as page from "@/app/admin/(panel)/protokollid/page";

test("the protocol screen's page lets the bulk send's mail task run for the longest bulk: 300 s", () => {
  expect(page.maxDuration).toBe(300);
  const longestBulkSeconds = (100 * (MAIL_GAP_MS + 200)) / 1000; // a gap and about 200 ms for each mail's own request
  expect(page.maxDuration).toBeGreaterThan(longestBulkSeconds);
});
