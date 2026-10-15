import { beforeEach, expect, test, vi } from "vitest";

// Seaded's "Salvesta tunnistuse andmed" (server/actions/admin-certificates.ts, phase 3d, spec §6, §4): the card's fields go on as they came
// (server/certificates.ts saveCertificateSettings checks them; tests/db/certificates.test.ts); saved, the browser gets the settings as stored
// and the saved year's last number; a refusal's field errors as they came; a throw is { ok: false, error: "server" }. And the drawer's
// "Paranda nimi" (reissueCertificateAction): the certificate and the name go on as typed, a re-issue refreshes the page.

const work = vi.hoisted(() => ({ saveCertificateSettings: vi.fn(), lastIssued: vi.fn(), reissueCertificate: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/server/certificates", () => work);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

const { reissueCertificateAction, saveCertificateSettingsAction } = await import("@/server/actions/admin-certificates");

const RAW = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: "2026", nextSeq: "15" };
const STORED = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 15 };

beforeEach(() => {
  work.saveCertificateSettings.mockReset();
  work.lastIssued.mockReset();
  work.reissueCertificate.mockReset();
  cache.refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("the card's fields go on as they came; saved: the settings as stored, and the saved year's last number", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: true, settings: STORED });
  work.lastIssued.mockResolvedValue("MS LAB 2026-14");
  const result = await saveCertificateSettingsAction(RAW);
  expect(result).toEqual({ ok: true, settings: STORED, last: "MS LAB 2026-14" });
  expect(work.saveCertificateSettings.mock.calls[0][1]).toBe(RAW);
  expect(work.saveCertificateSettings.mock.calls[0][2]).toBeInstanceOf(Date); // now: the save checks the year against it (M-5)
  expect(work.lastIssued.mock.calls[0][1]).toBe(2026);
  expect(cache.refresh).not.toHaveBeenCalled(); // the card keeps its own state
});

test("refused: the field errors as they came (a trainer's name in Cyrillic is 'letters'), nothing else read", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: false, fields: { nextSeq: "taken", place: "required", trainerName: "letters" } });
  expect(await saveCertificateSettingsAction({ ...RAW, trainerName: "Мария Соснина" })).toEqual({ ok: false, fields: { nextSeq: "taken", place: "required", trainerName: "letters" } });
  expect(work.lastIssued).not.toHaveBeenCalled();
});

test("a throw is { ok: false, error: 'server' }, logged by its label only", async () => {
  work.saveCertificateSettings.mockRejectedValue(new TypeError("boom: Tallinn"));
  expect(await saveCertificateSettingsAction(RAW)).toEqual({ ok: false, error: "server" });
  const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(logged).toContain("[certificate] the settings save failed: TypeError");
  expect(logged).not.toContain("Tallinn");
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
