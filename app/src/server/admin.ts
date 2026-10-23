import { z } from "zod";
import type { Db } from "@/db/client";
import type { Subscriber } from "@/db/schema";
import { changeRequestHandled, getRegistration, setRegistrationStatus } from "@/db/queries/admin";
import { adminEt } from "@/i18n/dict/admin";
import { formatStamp } from "@/i18n/format";
import { toCsv } from "./csv";

// The admin inbox's form handling (registrations, requests) and the subscriber export. Callers have already checked
// the admin session (server/actions/admin.ts wraps each in adminAction, the CSV route is wrapped in withAdmin); these
// take a Db and run without Next.js (tests/db/admin.test.ts). Money on a registration is „Lisa laekumine“'s alone
// (server/registration-money.ts, admin UX pass B4): the typed „Laekunud summa“ form is gone. The note is autosaved by its own route
// (server/registration-note.ts, piece 2 Task 5).

/**
 * What an admin form gets back. `error`: invalid (bad id / status), notFound, stale (the status changed since the pills were drawn: nothing
 * saved, the page shows the current one), server (a throw, server/actions/admin.ts).
 */
export type AdminResult = { ok: true } | { ok: false; error: "invalid" | "notFound" | "stale" | "server" };

const OK: AdminResult = { ok: true };
const fail = (error: Exclude<AdminResult, { ok: true }>["error"]): AdminResult => ({ ok: false, error });

const id = z.coerce.number().int().positive().max(2_147_483_647);
/** The status pills' two choices (admin UX pass, README A2 drawer 3): cancelling is „Tühista registreerimine“'s alone (`cancel`). */
const pillStatus = z.enum(["awaiting_prepayment", "confirmed"]);

const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : null;
};

/**
 * The drawer's status pills „Ootab ettemaksu“ / „Kinnitatud“ (admin UX pass, piece 2, Task 5: a manual override, saved at once): fields id, status
 * (awaiting_prepayment | confirmed) and expected (the status the pills showed, one of the same two). The status alone: the note is its own
 * autosaved part (server/registration-note.ts). Refused as `stale` when the stored status is no longer `expected` (cancelled, or confirmed by a
 * payment in another tab), so it never overwrites a change she did not see. A cancelled registration is not put back from the drawer (spec §10):
 * `cancelled`, as the status or as what the pills showed, is `invalid`.
 */
export async function saveStatus(db: Db, formData: FormData): Promise<AdminResult> {
  const reg = id.safeParse(field(formData, "id"));
  const next = pillStatus.safeParse(field(formData, "status"));
  const expected = pillStatus.safeParse(field(formData, "expected"));
  if (!reg.success || !next.success || !expected.success) return fail("invalid");
  if (await setRegistrationStatus(db, reg.data, next.data, undefined, { expected: expected.data })) return OK;
  return (await getRegistration(db, reg.data)) ? fail("stale") : fail("notFound");
}

/** Field: id. "Tühista": status cancelled, the note is kept. */
export async function cancel(db: Db, formData: FormData): Promise<AdminResult> {
  const reg = id.safeParse(field(formData, "id"));
  if (!reg.success) return fail("invalid");
  return (await setRegistrationStatus(db, reg.data, "cancelled")) ? OK : fail("notFound");
}

/**
 * What „Märgi tehtuks“ / „Märgi tegemata“ gets back. `version` is the request as this write left it (db/queries/admin.ts changeRequestHandled): the UndoBar's
 * „Võta tagasi“ sends it back, so that an undo never overwrites a newer change. `error`: invalid (not a request id, not a state), notFound, stale (the request
 * is not what the card showed: nothing saved, the page is refreshed to show it), server (a throw, server/actions/admin.ts).
 */
export type HandledAnswer = { ok: true; version: string } | { ok: false; error: "invalid" | "notFound" | "stale" | "server" };

/** `handled`: the state asked for; `expected`: the state the card showed (the other one, for a press; for an undo the one the marking left); `version`: an undo's. */
const handledInput = z.object({ id, handled: z.boolean(), expected: z.boolean(), version: z.string().regex(/^\d{1,10}$/).optional() });

/**
 * Päringud's „Märgi tehtuks“ / „Märgi tegemata“ and the UndoBar's „Võta tagasi“: `{ id, handled, expected, version? }`. It is saved only while the request is
 * still as the card showed (`expected`, and for an undo `version`): a request that was changed meanwhile, elsewhere, is `stale` and keeps its newer state.
 */
export async function saveHandled(db: Db, input: unknown): Promise<HandledAnswer> {
  const parsed = handledInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { id: request, handled, expected, version } = parsed.data;
  return changeRequestHandled(db, request, handled, expected, version);
}

/** The subscriber export: e-mail, locale, consent time, confirmed yes/no, confirmation time (Estonian time). */
export function subscribersCsv(rows: Subscriber[], opts: { confirmedOnly: boolean }): string {
  const t = adminEt.newsletter.csv;
  const list = opts.confirmedOnly ? rows.filter((r) => r.confirmedAt) : rows;
  return toCsv(
    t.header,
    list.map((r) => [r.email, r.locale.toUpperCase(), formatStamp(r.consentAt), r.confirmedAt ? t.yes : t.no, r.confirmedAt ? formatStamp(r.confirmedAt) : ""]),
  );
}

/** "mslab-uudiskiri-2026-10-01.csv" / "mslab-uudiskiri-kinnitatud-2026-10-01.csv" (Estonian date). */
export function subscribersCsvName(now: Date, confirmedOnly: boolean): string {
  const t = adminEt.newsletter.csv;
  return `${confirmedOnly ? t.filenameConfirmed : t.filename}-${formatStamp(now).slice(0, 10)}.csv`;
}
