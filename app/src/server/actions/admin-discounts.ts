"use server";

import { refresh, revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { addRegistrationDiscount, createCode, deleteCode, removeRegistrationDiscount, setCodeActive, type CreateCodeResult, type RegistrationDiscountResult } from "../discount-code-admin";
import { logFailure } from "../log";

// The discount codes' server actions (F1 Task 13; the Sooduskoodid page): every export is wrapped in adminAction (signed-in admin or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise). The work is in ../discount-code-admin.ts, which revalidates the public pages for the
// welcome row; refresh() updates the open admin page (the list behind the drawer).

const id = z.number().int().positive().max(ROW_ID_MAX);

/** The refusals that say the drawer shows an old state (the money, an invoice, the status or the code changed meanwhile): the page is refreshed to show it. */
const SHOWS_OLD: readonly string[] = ["stale", "paid", "unpaidInvoice", "cancelled"];

/** The registrations page behind the drawer, and the Sooduskoodid page (a use came or went: its uses and counts change). The welcome row changes no public text. */
function refreshDiscountPages(): void {
  revalidatePath("/admin/sooduskoodid");
  refresh();
}

/**
 * The Sooduskoodid drawer's „Lisa sooduskood“ (the one explicit create): `{ fields, welcome }`, the new drawer's every field and whether it is the welcome
 * code (`?kood=tervituskood`). Answers the new code's id and version, so the drawer stays open, goes on at `?kood=<id>` and autosaves
 * (api/admin/sooduskood/<id>).
 */
export const createCodeAction = adminAction(async (_admin, input: unknown): Promise<CreateCodeResult | { ok: false; error: "server" }> => {
  const request = z.strictObject({ fields: z.unknown(), welcome: z.boolean() }).safeParse(input);
  if (!request.success) return { ok: false, error: "invalid", fields: {} };
  try {
    const result = await createCode(getDb(), request.data.fields, { welcome: request.data.welcome }, new Date());
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure("[admin] discount code create failed", e);
    return { ok: false, error: "server" };
  }
});

/**
 * The switch „Aktiivne“, instant: `{ id, active, version }`, the version the drawer holds. Stale when the code was saved elsewhere meanwhile (the drawer
 * reads the page again); setCodeActive revalidates the public pages for the welcome row; the open page is refreshed.
 */
export const setCodeActiveAction = adminAction(async (_admin, input: unknown): Promise<Awaited<ReturnType<typeof setCodeActive>> | { ok: false; error: "invalid" | "server" }> => {
  const request = z.strictObject({ id, active: z.boolean(), version: z.string().max(100) }).safeParse(input);
  if (!request.success) return { ok: false, error: "invalid" };
  try {
    const result = await setCodeActive(getDb(), request.data.id, request.data.active, request.data.version, new Date());
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure("[admin] discount code switch failed", e);
    return { ok: false, error: "server" };
  }
});

/** „Kustuta sooduskood“, only for a code with no use: `{ id }`. `used` when it has one (also a booking that committed meanwhile); the open page is refreshed. */
export const deleteCodeAction = adminAction(async (_admin, input: unknown): Promise<Awaited<ReturnType<typeof deleteCode>> | { ok: false; error: "invalid" | "server" }> => {
  const request = z.strictObject({ id }).safeParse(input);
  if (!request.success) return { ok: false, error: "invalid" };
  try {
    const result = await deleteCode(getDb(), request.data.id);
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure("[admin] discount code delete failed", e);
    return { ok: false, error: "server" };
  }
});

/**
 * „Lisa sooduskood“ on the registration's Raha card (D11): `{ registrationId, code }`. No rule of the code is checked (addRegistrationDiscount); the
 * registrations page and the Sooduskoodid page (its uses and counts change) are refreshed on success. The welcome row needs no public revalidation:
 * no public text changes.
 */
export const addRegistrationDiscountAction = adminAction(async (_admin, input: unknown): Promise<RegistrationDiscountResult | { ok: false; error: "invalid" | "server" }> => {
  const request = z.strictObject({ registrationId: id, code: z.string().max(200) }).safeParse(input);
  if (!request.success) return { ok: false, error: "invalid" };
  try {
    const result = await addRegistrationDiscount(getDb(), request.data.registrationId, request.data.code, new Date());
    if (result.ok || SHOWS_OLD.includes(result.error)) refreshDiscountPages();
    return result;
  } catch (e) {
    logFailure("[admin] registration discount add failed", e);
    return { ok: false, error: "server" };
  }
});

/** „Eemalda sooduskood“ (D11): `{ registrationId }`. Refreshes the same pages on success. */
export const removeRegistrationDiscountAction = adminAction(async (_admin, input: unknown): Promise<RegistrationDiscountResult | { ok: false; error: "invalid" | "server" }> => {
  const request = z.strictObject({ registrationId: id }).safeParse(input);
  if (!request.success) return { ok: false, error: "invalid" };
  try {
    const result = await removeRegistrationDiscount(getDb(), request.data.registrationId);
    if (result.ok || SHOWS_OLD.includes(result.error)) refreshDiscountPages();
    return result;
  } catch (e) {
    logFailure("[admin] registration discount remove failed", e);
    return { ok: false, error: "server" };
  }
});
