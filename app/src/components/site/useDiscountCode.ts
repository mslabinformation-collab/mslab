"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeCode, totalWith, type CheckAnswer, type CheckError, type SubmitCodeError } from "@/domain/discount-codes";
import { checkDiscountCode } from "@/server/actions/public";

/** What the field shows: the text in the box, the code that is applied (with its price), the last refusal, and whether a check is running. */
export type DiscountState = {
  typed: string;
  applied: Extract<CheckAnswer, { ok: true }> | null;
  error: { code: CheckError | SubmitCodeError; startsOn?: string } | null;
  checking: boolean;
};

/** What a form does with its code when the visitor presses „Registreeru“ (or the cart's pay button). */
export type DiscountSubmit = { send: true; code: string | null; discountCents: number | null } | { send: false };

type Applied = Extract<CheckAnswer, { ok: true }>;

/** The check's own refusals, which say something about the code; "rate" and "server" only say the check did not happen. */
const isRefusal = (e: CheckError | SubmitCodeError): boolean => e !== "rate" && e !== "server";

/** The browser's memory of an applied code, per course (the page may be reloaded, or left for the bank and come back). Every access is guarded: a blocked storage is no memory. */
const storageKey = (course: string) => `mslab-discount:${course}`;
function remembered(course: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(course));
  } catch {
    return null;
  }
}
function remember(course: string, code: string | null) {
  try {
    if (code === null) window.sessionStorage.removeItem(storageKey(course));
    else window.sessionStorage.setItem(storageKey(course), code);
  } catch {
    // private window or blocked site data: the code just is not remembered
  }
}

/**
 * The sooduskood of a form (F1, spec §4): the registration form's and, in Task 10, the e-course cart's. It holds what is typed, asks the server's
 * check (`checkDiscountCode`: one question, never an e-mail) and keeps the answer that says what the code takes off `listCents`.
 * - Each `apply` carries a sequence number, and only the latest answer is kept (Review Focus 1): a slow first answer never replaces a later code's.
 *   `remove` also takes a number, so an answer that comes after it is dropped.
 * - The applied code is remembered in sessionStorage (`mslab-discount:<course>`) and checked again when the form is mounted: still good → applied,
 *   refused → its error and the list price. The text is all that is stored, never a price.
 * - `beforeSubmit` is what the form awaits before it sends: a typed code that was not applied yet is applied first, and one the check refuses is not
 *   sent at all (the form stays, the field says why). `serverRefused` is the server's own answer to a submit with a code (Task 6): the person
 *   rules keep the code (the e-mail may be changed), `changed` re-checks and shows the new price, every other refusal drops the code.
 * The price shown is the check's; the server recomputes everything at submit and answers `changed` when the two disagree.
 */
export function useDiscountCode(o: { course: string; listCents: number }): DiscountState & {
  listCents: number;
  setTyped(v: string): void;
  apply(): Promise<void>;
  remove(): void;
  beforeSubmit(): Promise<DiscountSubmit>;
  serverRefused(code: SubmitCodeError): Promise<void>;
  totalCents: number;
} {
  const { course, listCents } = o;
  const [typed, setTypedState] = useState("");
  const [applied, setApplied] = useState<Applied | null>(null);
  const [error, setError] = useState<DiscountState["error"]>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  // what the callbacks read, so beforeSubmit sees the latest values without being rebuilt on every keystroke
  const latest = useRef({ typed, applied });
  useEffect(() => {
    latest.current = { typed, applied };
  });

  /** Asks the server about `code`; null when a later apply/remove has started meanwhile (this answer is stale and changes nothing). */
  const check = useCallback(
    async (code: string): Promise<CheckAnswer | null> => {
      const mine = ++seq.current;
      setChecking(true);
      setError(null);
      let answer: CheckAnswer;
      try {
        const fd = new FormData();
        fd.set("course", course);
        fd.set("code", code);
        answer = await checkDiscountCode(fd);
      } catch {
        answer = { ok: false, error: "server" };
      }
      if (mine !== seq.current) return null;
      setChecking(false);
      setTypedState(answer.ok ? answer.code : code);
      if (answer.ok) {
        setApplied(answer);
        remember(course, answer.code);
      } else {
        setApplied(null);
        setError({ code: answer.error, startsOn: answer.startsOn });
        // a code the check refused is not remembered; one it could not check (rate, server) stays, the next load tries again
        if (isRefusal(answer.error)) remember(course, null);
      }
      return answer;
    },
    [course],
  );

  // On mount: a remembered code is checked again (the browser's storage is read only here, after hydration).
  useEffect(() => {
    const stored = remembered(course);
    // (after a tick: the check's first state changes are not made inside the effect itself)
    if (stored) void Promise.resolve().then(() => check(stored));
  }, [course, check]);

  const setTyped = useCallback((v: string) => {
    setTypedState(v);
    setError(null);
  }, []);

  const apply = useCallback(async () => {
    await check(latest.current.typed);
  }, [check]);

  const remove = useCallback(() => {
    seq.current++; // an answer still on its way is for a code that is gone
    setApplied(null);
    setError(null);
    setChecking(false);
    setTypedState("");
    remember(course, null);
  }, [course]);

  const beforeSubmit = useCallback(async (): Promise<DiscountSubmit> => {
    const { typed: text, applied: a } = latest.current;
    const want = normalizeCode(text);
    if (a && (want === "" || want === a.code)) return { send: true, code: a.code, discountCents: a.discountCents };
    if (want === "") return { send: true, code: null, discountCents: null };
    const answer = await check(text);
    return answer && answer.ok ? { send: true, code: answer.code, discountCents: answer.discountCents } : { send: false };
  }, [check]);

  const serverRefused = useCallback(
    async (code: SubmitCodeError) => {
      const { typed: text, applied: a } = latest.current;
      if (code === "person") {
        // the rule is about her e-mail address: the code stays applied, the hint says who it is for, and she may change the address
        setError({ code });
        return;
      }
      const again = a ? a.code : text;
      if (code === "changed") {
        const answer = await check(again);
        if (answer && answer.ok) setError({ code: "changed" });
        return;
      }
      // refused for good (paused, ended, not yet, used up, scope, unknown): the code is dropped, and the check says what it says now
      setApplied(null);
      remember(course, null);
      const answer = await check(again);
      if (answer === null) return;
      if (answer.ok) {
        // the check disagrees with the submit (a race): do not apply what the server just refused
        setApplied(null);
        remember(course, null);
        setError({ code });
      } else if (!isRefusal(answer.error)) {
        // the check could not run (rate, server): the submit's refusal is what we know
        setError({ code });
      }
    },
    [check, course],
  );

  return { typed, applied, error, checking, listCents, setTyped, apply, remove, beforeSubmit, serverRefused, totalCents: applied ? totalWith(listCents, applied.discountCents) : listCents };
}
