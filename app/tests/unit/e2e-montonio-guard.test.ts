import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { verifyHs256 } from "@/server/payments/jwt";
import { assertAppOnFakeMontonio } from "../e2e/montonio-guard";
import { E2E_MONTONIO } from "../e2e/montonio-values";

// The e2e run's guard against the real Montonio sandbox (Task 10, Task 2's hand-off): app/.env.local holds the owner's real sandbox keys, so a
// dev server that was started by hand and is reused by Playwright would create REAL sandbox orders. Global setup therefore asks the app under
// test, before any test, whether it holds the e2e run's made-up keys (the fake Montonio's): a webhook token signed with them is accepted (200)
// only by an app configured with them, and refused (400) by one with any other keys; no other request is made, nothing is written, and the
// real Montonio is not involved at all.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A stand-in for the app under test: answers /api/payments/notify with `status`, and keeps what it was sent. */
async function appAnswering(status: number): Promise<{ url: string; seen: { method: string; path: string; body: string }[] }> {
  const seen: { method: string; path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("an app that accepts the probe's token is on the e2e keys: the run goes on, and the probe is one POST to the webhook, nothing else", async () => {
  const app = await appAnswering(200);
  await assertAppOnFakeMontonio(app.url);
  expect(app.seen).toHaveLength(1);
  expect(app.seen[0]).toMatchObject({ method: "POST", path: "/api/payments/notify" });
  const { orderToken } = JSON.parse(app.seen[0].body) as { orderToken: string };
  // signed with the made-up keys of the fake, for a reference no payment has: the app settles nothing
  const { claims } = verifyHs256<Record<string, unknown>>(orderToken, E2E_MONTONIO.secretKey);
  expect(claims).toMatchObject({ accessKey: E2E_MONTONIO.accessKey, merchantReference: "E2E-PROBE-NO-SUCH-PAYMENT", paymentStatus: "PENDING" });
});

test("an app that refuses the token (400) holds other keys — a dev server of your own with the sandbox keys of .env.local: the run stops, naming the setting and no value", async () => {
  const app = await appAnswering(400);
  const error = await assertAppOnFakeMontonio(app.url).then(
    () => null,
    (e: Error) => e,
  );
  expect(error?.message).toContain("PAYMENT_PROVIDER=mock");
  expect(error?.message).toContain("MONTONIO_FAKE_URL");
  expect(error?.message).toMatch(/stop it/i);
  expect(error?.message).not.toContain(E2E_MONTONIO.secretKey);
});

test("an app with payments off (404), one that fails (503) and one that is not there all stop the run", async () => {
  const off = await appAnswering(404);
  await expect(assertAppOnFakeMontonio(off.url)).rejects.toThrow(/payments are off/);
  const failing = await appAnswering(503);
  await expect(assertAppOnFakeMontonio(failing.url)).rejects.toThrow(/503/);
  const gone = await appAnswering(200);
  const url = gone.url;
  await new Promise((r) => servers.pop()!.close(r));
  await expect(assertAppOnFakeMontonio(url)).rejects.toThrow(/did not answer|reach/i);
});
