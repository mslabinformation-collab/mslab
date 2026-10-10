import { signHs256 } from "../../src/server/payments/jwt";
import { E2E_MONTONIO } from "./montonio-values";

// Keeps an e2e run away from the real Montonio sandbox (phase 2b Task 10, Task 2's hand-off). app/.env.local holds the owner's real sandbox keys
// for trying payments by hand; the servers Playwright starts get the fake Montonio's made-up keys instead (tests/local-secrets.ts LOCAL_ENV,
// PAYMENT_PROVIDER=mock, MONTONIO_FAKE_URL). But a dev server that was started by hand is REUSED as it is (reuseExistingServer), and it would
// create real sandbox orders from the tests. So global setup asks the app under test, before any test or fixture, whether it holds the e2e
// run's keys: a webhook token signed with them (for a reference no payment has) is accepted — 200, nothing stored, nothing settled — only by an
// app configured with them, and refused with a 400 by an app with any other keys. Only that one request is made; the real Montonio is not
// involved, and no key of the owner's is read or printed. (The bank page itself is checked by every test too: payments.spec.ts atBank.)

/** The merchantReference of the probe's token: no payment has it. */
export const PROBE_REFERENCE = "E2E-PROBE-NO-SUCH-PAYMENT";

/** A webhook token as Montonio would sign it with the e2e run's keys: PENDING, for a payment that does not exist. */
export function probeOrderToken(): string {
  return signHs256(
    { accessKey: E2E_MONTONIO.accessKey, uuid: "e2e-probe", merchantReference: PROBE_REFERENCE, paymentStatus: "PENDING", paymentMethod: "paymentInitiation", grandTotal: 1, currency: "EUR" },
    E2E_MONTONIO.secretKey,
    { expiresInSeconds: 120 },
  );
}

/**
 * Throws, with what to do about it, unless the app at `appUrl` answers the probe's token with a 200: the app holds the e2e run's Montonio
 * keys, which cannot sign in to the real Montonio. The message names settings and never a value.
 */
export async function assertAppOnFakeMontonio(appUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const app = appUrl.replace(/\/+$/, "");
  const stop = "if that is a dev server you started yourself, stop it (Playwright starts its own with the e2e settings), then run again";
  let status: number;
  try {
    const res = await fetchImpl(`${app}/api/payments/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderToken: probeOrderToken() }),
      redirect: "manual",
      signal: AbortSignal.timeout(90_000), // (a dev server compiles the route on its first request)
    });
    status = res.status;
  } catch {
    throw new Error(`e2e: the app under test (${app}) did not answer the Montonio check: is the server up?`);
  }
  if (status === 200) return;
  if (status === 400)
    throw new Error(
      `e2e: the app under test (${app}) refused a webhook token signed with the e2e run's Montonio keys: it holds other keys — likely the sandbox keys of .env.local — ` +
        `and a test could create orders in the REAL Montonio sandbox. The e2e run needs PAYMENT_PROVIDER=mock and MONTONIO_FAKE_URL=${E2E_MONTONIO.url} (tests/local-secrets.ts); ${stop}`,
    );
  if (status === 404)
    throw new Error(
      `e2e: the app under test (${app}) answered 404 to the Montonio check: online payments are off there (no Montonio keys, PAYMENT_PROVIDER is not "mock", ` +
        `or a production build without PAYMENT_MOCK_IN_PRODUCTION=1); ${stop}`,
    );
  throw new Error(`e2e: the app under test (${app}) answered ${status} to the Montonio check: the payments cannot be tested against it; ${stop}`);
}
