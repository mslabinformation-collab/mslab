"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { createCode, deleteCode, setCodeActive, type CreateCodeResult } from "../discount-code-admin";
import { logFailure } from "../log";

// The discount codes' server actions (F1 Task 13; the Sooduskoodid page): every export is wrapped in adminAction (signed-in admin or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise). The work is in ../discount-code-admin.ts, which revalidates the public pages for the
// welcome row; refresh() updates the open admin page (the list behind the drawer).

const id = z.number().int().positive().max(ROW_ID_MAX);

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
    const result = await setCodeActive(getDb(), request.data.id, request.data.active, request.data.version);
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
