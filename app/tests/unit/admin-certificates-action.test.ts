import { beforeEach, expect, test, vi } from "vitest";

// The certificate's admin action (server/actions/admin-certificates.ts, phase 3d, spec §6): the drawer's "Paranda nimi" (reissueCertificateAction):
// the certificate and the name go on as typed, a re-issue refreshes the page. (Seaded's "Tunnistus" card autosaves on api/admin/seaded/certificate since
// admin UX pass piece 3b, Task 4: tests/db/seaded-route.test.ts.)

const work = vi.hoisted(() => ({ reissueCertificate: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/server/certificates", () => work);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

const { reissueCertificateAction } = await import("@/server/actions/admin-certificates");

beforeEach(() => {
  work.reissueCertificate.mockReset();
  cache.refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("'Paranda nimi' passes on the certificate and the name as typed; re-issued, the page is refreshed; invalid and notFound as they came without a refresh; bad input is notFound; a throw is 'failed', logged by the certificate's id", async () => {
  const view = { id: 7, number: "MS LAB 2026-03", name: "Kätlin Kask", issuedAt: "2026-10-19T10:00:00.000Z", reissuedAt: "2026-10-20T09:00:00.000Z" };
  work.reissueCertificate.mockResolvedValueOnce({ kind: "reissued", certificate: view });
  expect(await reissueCertificateAction({ certificateId: 7, name: " Kätlin  Kask " })).toEqual({ kind: "reissued", certificate: view });
  expect(work.reissueCertificate.mock.calls[0].slice(1, 3)).toEqual([7, " Kätlin  Kask "]);
  expect(work.reissueCertificate.mock.calls[0][3]).toBeInstanceOf(Date);
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  work.reissueCertificate.mockResolvedValueOnce({ kind: "invalid", error: "letters" });
  expect(await reissueCertificateAction({ certificateId: 7, name: "Kati 😀" })).toEqual({ kind: "invalid", error: "letters" });
  work.reissueCertificate.mockResolvedValueOnce({ kind: "notFound" });
  expect(await reissueCertificateAction({ certificateId: 8, name: "Kati Kask" })).toEqual({ kind: "notFound" });
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  for (const bad of [{ certificateId: 0, name: "Kati" }, { certificateId: 1.5, name: "Kati" }, { certificateId: 7 }, { certificateId: 7, name: "x".repeat(1025) }, { name: "Kati" }])
    expect(await reissueCertificateAction(bad as never), JSON.stringify(bad).slice(0, 60)).toEqual({ kind: "notFound" });
  expect(work.reissueCertificate).toHaveBeenCalledTimes(3);
  work.reissueCertificate.mockRejectedValueOnce(new TypeError("boom: Kätlin"));
  expect(await reissueCertificateAction({ certificateId: 7, name: "Kätlin Kask" })).toEqual({ kind: "failed" });
  const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(logged).toContain("[certificate] 7: the re-issue failed: TypeError");
  expect(logged).not.toContain("Kätlin");
});
