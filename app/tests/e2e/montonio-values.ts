/**
 * The port of the e2e run's fake Montonio: 3997, or E2E_MONTONIO_PORT when that one is taken on this machine (a whole number from 1024 to
 * 65535). Playwright, the app's server and the fake itself all read it from here, so they always agree.
 */
function fakePort(value: string | undefined): number {
  if (!value?.trim()) return 3997;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("e2e: E2E_MONTONIO_PORT must be a port number from 1024 to 65535");
  return port;
}

const port = fakePort(process.env.E2E_MONTONIO_PORT);

/** The e2e run's Montonio: a fake on this machine (fake-montonio.ts) with made-up keys; the app's server is started with these. Not secrets. */
export const E2E_MONTONIO = {
  port,
  url: `http://localhost:${port}`,
  accessKey: "e2e-montonio-access-key",
  secretKey: "e2e-montonio-secret-key-not-a-real-one-0123456789",
} as const;
