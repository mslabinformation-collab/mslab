import { and, eq } from "drizzle-orm";
import { courses } from "@/db/schema";
import { tallinnToday } from "@/domain/client-access";
import { codeRefusal, codeValueText, discountCents, listCentsOf, normalizeCode, totalWith, type CheckAnswer } from "@/domain/discount-codes";
import { findCode, ruleOf, usesOf } from "./discount-codes";
import { allowed, type Deps } from "./submit";

// Discount codes (F1): the live check behind the „Rakenda“ button of the registration form and the cart. It answers what the typed code would
// take off the course's list price now; it reads no e-mail (the person's own rules are checked at submit, `redeem`), so anyone can ask it, and
// it has its own, wider rate bucket than the forms' five per ten minutes.

export const DISCOUNT_CHECK_LIMIT = 20;
export const DISCOUNT_CHECK_WINDOW_SEC = 600;

const field = (formData: FormData, name: string): string => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

/** Order: empty code, rate limit (no visitor address: let through, like the forms), a published course with a list price, the code, its refusal. */
export async function checkDiscount(deps: Pick<Deps, "db" | "env" | "ip" | "now">, formData: FormData): Promise<CheckAnswer> {
  const typed = field(formData, "code");
  if (normalizeCode(typed) === "") return { ok: false, error: "empty" };
  if (deps.ip !== null && !(await allowed(deps.env, `rl:discount-check:${deps.ip}`, DISCOUNT_CHECK_LIMIT, DISCOUNT_CHECK_WINDOW_SEC))) {
    return { ok: false, error: "rate" };
  }
  const [course] = await deps.db
    .select()
    .from(courses)
    .where(and(eq(courses.slug, field(formData, "course")), eq(courses.published, true)))
    .limit(1);
  const list = course ? listCentsOf(course) : null;
  if (!course || list === null) return { ok: false, error: "unknown" };
  const code = await findCode(deps.db, typed);
  if (!code) return { ok: false, error: "unknown" };
  const refusal = codeRefusal(ruleOf(code), {
    courseId: course.id,
    courseType: course.type,
    listCents: list,
    today: tallinnToday(deps.now),
    // Every counting use, hers too: the check has no e-mail by design, so S4's "her own pending attempts do not count" cannot apply here.
    // Known limit (the final review's M3, ruling F-M3, spec D8): the person holding the LAST use of an e-course code is answered `usedUp` here
    // while her own attempt is pending, e.g. when the cart's remembered code is checked again on a real reload (useDiscountCode). She is never
    // overcharged (she sees the list price), and a submit that carries the code still gets A7/S3/S4's re-send at the server (redeem, start).
    uses: await usesOf(deps.db, code.id, deps.now),
  });
  if (refusal === "notYet") return { ok: false, error: refusal, startsOn: code.startsOn ?? undefined };
  if (refusal) return { ok: false, error: refusal };
  const off = discountCents(code, list);
  return { ok: true, code: code.code, discountCents: off, totalCents: totalWith(list, off), value: codeValueText(code), audience: code.audience, welcome: code.welcome };
}
