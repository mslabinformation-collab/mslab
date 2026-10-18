"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isSampleAddress } from "@/domain/email";
import { adminEt } from "@/i18n/dict/admin";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { contractCard, contractForAdmin, contractOwner, contractPdf, mailContract, mailContractRequest, requestContract, saveContractTexts } from "../contracts";
import { logFailure } from "../log";
import { mailConfigured } from "../notify";
import { revalidatePublic } from "../public-cache";
import { adminSendDeps } from "../send-deps";

// Maria's contract actions (contracts Task 5, spec §4, D2, D4, D7; rulings R1, R9): every export is wrapped in adminAction (a signed-in admin, or a
// redirect to /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// in ../contracts.ts (the rules, the writes and the mails). Each action answers in plain data: `{ ok: true, … }`, or `{ ok: false, error, text }`
// with the refusal's code and its Estonian words (adminEt.contracts.errors; the codes of the work's own result, and `server` for a throw, logged by
// the row's id and the error's class only, never a name or an address). A success refreshes the page it was made on, so the block and the card show the
// new state.

type ErrorCode = keyof typeof adminEt.contracts.errors;
type Failure<C extends ErrorCode = ErrorCode> = { ok: false; error: C; text: string };

const fail = <C extends ErrorCode>(error: C): Failure<C> => ({ ok: false, error, text: adminEt.contracts.errors[error] });

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const registrationOnly = z.object({ registrationId: rowId });
const idOnly = z.object({ id: rowId });

/**
 * Seaded → Lepingud → „Salvesta lepingud“: `{ title: { et, ru? }, body: { et, ru? } }` as typed, checked by saveContractTexts (the Estonian text
 * required, the legal texts' limits). Saved: `{ ok: true, card }` with the texts as now stored (trimmed), and the course pages are revalidated: the
 * registration form shows this text inline and refuses a version it did not show, so a page kept in the cache would make the student read the refusal
 * again (server/cache-targets.ts "contract_contact"). A refused field comes back by name in `fields` (`title`, `body`; or `form`). A throw is
 * `{ ok: false, error: "server" }`, logged by its label and the error's class only.
 */
export const saveContractTextsAction = adminAction(async (_admin, raw: unknown) => {
  try {
    const db = getDb();
    const result = await saveContractTexts(db, raw, new Date());
    if (!result.ok) return { ok: false as const, fields: result.fields };
    const card = await contractCard(db);
    revalidatePublic({ kind: "settings", parts: ["contract_contact"] });
    refresh();
    return { ok: true as const, card };
  } catch (e) {
    logFailure("[contracts] the texts' save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});

/**
 * „Saada leping kinnitamiseks“ (D4, ruling R9): `{ registrationId }` — records that Maria asked (requestContract) and mails the student a plain link to her
 * account, where the card shows „Kinnita leping“. Asked: `{ ok: true, mailed }`; `mailed` is false when the mail did not go (it is not set up here, the
 * address is a sample, or Resend refused it): the mail is best effort and never fails the action, the account shows the ask without it. The work
 * refuses the rest: `notFound` (also an individual registration), `noAccount`, `cancelled`.
 */
export const requestContractAction = adminAction(async (_admin, input: { registrationId: number }) => {
  const parsed = registrationOnly.safeParse(input);
  if (!parsed.success) return fail("notFound");
  const { registrationId } = parsed.data;
  try {
    const result = await requestContract(getDb(), registrationId, new Date());
    if (!result.ok) return fail(result.error);
  } catch (e) {
    logFailure(`[contracts] registration ${registrationId}: the ask failed`, e);
    return fail("server");
  }
  let mailed = false;
  try {
    mailed = await mailContractRequest(await adminSendDeps("[contracts]"), registrationId);
  } catch (e) {
    logFailure(`[contracts] registration ${registrationId}: the ask's mail failed`, e);
  }
  refresh();
  return { ok: true as const, mailed };
});

/**
 * „Saada koopia õpilasele“ (D7, rulings R1, R14, R15): `{ id }` — the contract's PDF, rendered now from its frozen row, goes to the address it froze, in
 * its language (mailContract), which records `sent_at`. A copy that can never go is refused before anything is drawn, in words that do not ask
 * her to try again: `sampleAddress` for a sample address (`@example.test`, never mailed: staging's demo rows), `mailOff` with no mail service here
 * (no Resend: local development). The PDF is drawn next: when it cannot be drawn nothing is sent (`pdfFailed`), because the copy exists to deliver
 * the PDF, and only a mail that carried it is answered `{ ok: true }`. The mail has „Ava minu konto“ when the contract has an owner now
 * (contracts.ts CONTRACT_OWNER: the registration's live link first, so a student whose account came after her form still has the button).
 * `mailFailed` when it did not go all the same (Resend refused it), `contractNotFound` for an unknown id.
 */
export const sendContractCopyAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("contractNotFound");
  const { id } = parsed.data;
  try {
    const db = getDb();
    const contract = await contractForAdmin(db, id);
    if (!contract) return fail("contractNotFound");
    // (a copy that can never go: refused before the PDF is drawn for nothing)
    if (isSampleAddress(contract.fields.student.email)) return fail("sampleAddress");
    const deps = await adminSendDeps("[contracts]");
    if (!mailConfigured(deps.env)) return fail("mailOff");
    let pdf: Uint8Array;
    try {
      pdf = await contractPdf(contract);
    } catch (e) {
      logFailure(`[contracts] contract ${id}: the copy's PDF could not be drawn`, e);
      return fail("pdfFailed");
    }
    // (a student with no account here gets the copy without „Ava minu konto“)
    const noAccount = (await contractOwner(db, id)) === null;
    const sent = await mailContract(deps, contract, { noAccount, pdf });
    if (!sent) return fail("mailFailed");
    refresh();
    return { ok: true as const };
  } catch (e) {
    logFailure(`[contracts] contract ${id}: the copy failed`, e);
    return fail("server");
  }
});
