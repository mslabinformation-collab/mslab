# Discount codes („Sooduskoodid“) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Students type a code on the group registration form or in the e-course cart and pay exactly the discounted total through every payment option. The discount shows on the invoice, the contract, the mails and the account. Maria creates, pauses and watches her codes (the welcome code among them) on `/admin/sooduskoodid`.

**Architecture:** The pure rules live in `src/domain/discount-codes.ts`, which is browser-safe, and the frozen discount sits on the booking (`registrations.discount_cents` / `payments.discount_cents`). Every money path reads `registrationTotal` = the live list price − the frozen discount, never below 1,00 €. The check that decides runs under the code row's `for no key update` lock, inside the booking's or the start's transaction (`src/server/discount-codes.ts`). A separate rate-limited live check serves the forms. The welcome code becomes the `welcome = true` row, and Seaded and Hüpikaken stop holding it.

**Tech Stack:** Next.js App Router (server actions, route handlers, ISR), Drizzle + Postgres (PGlite in db tests), Vitest (unit, DOM, db), Playwright e2e with `tests/e2e/fake-montonio.ts`.

**Spec:** `docs/superpowers/specs/2026-11-10-discount-codes-design.md`. It is binding, and its §10 answers (11.11) are final:
- chosen courses are built now;
- the drawer's „Lisa sooduskood“ ignores the code's rules, and the use still counts;
- all three audiences are built now;
- only the discount in euros is frozen.

Read the spec section a task names before starting that task.

## Global Constraints

**Build order and setup**
- The plan runs **after** the course-areas (migration 0023) and certificate-designs (0024) features are merged. This feature's migration takes **the next free number (expected 0025)**, and every `0023` in the spec means that number. Its test is `tests/db/migration-<number>.test.ts` (expected `migration-0025.test.ts`). After the merges, re-read `src/components/admin/sections.ts`, `src/db/schema.ts`, `src/components/admin/SettingsEditor.tsx` and `src/server/seaded.ts`: both earlier features touch them.
- The worktree setup, once: `cmd /c mklink /J app\node_modules C:\Users\Dmitri.MARKIT\source\repos\MSLab\app\node_modules`.
- **Never run `npm install`/`npm ci`, and never add a dependency.** Run every command from `app/`.

**Verification**
- Unit and db tests: `npx vitest run <files>`.
- At the end of each task, run the whole suite with `npx vitest run > ../vitest.log 2>&1` and read the summary in the log. `npx tsc --noEmit` and `npm run lint` must be clean.
- **Do not run Playwright e2e**: write the specs, and the controller runs them after the merge with `--workers=1 --no-deps`.
- Do not run drizzle-kit migrate against any database.
- Migrations: change `src/db/schema.ts`, then run `npx drizzle-kit generate --name discount_codes`. Append the hand-written data SQL to the generated file, as 0016 does, and keep it self-contained.
- TDD: write the failing test, watch it fail, then write the code.

**Code and texts**
- Mirror the codebase's patterns and its long explanatory doc comments.
- Admin texts go in `src/i18n/dict/admin.ts` (Estonian only). Public texts go in `src/i18n/dict/et.ts` and `ru.ts`, with every key mirrored. Every new text is Draft and uses the spec's §5 wording exactly.
- Test plan: every behaviour change updates `src/data/testplan.json` (`new` / `redo` / `reworded`, with `"markedAt": "deploy"`). Lines have at most 20 words and end with a full stop; a check has at most 8 steps and 8 expect lines. Do **not** run `tools/testplan-stamp.mjs`. Task 17 does the whole §8 at once, so other tasks leave `testplan.json` alone.

**Hard limits**
- Never read `app/.env.local`, and never print or commit secrets.
- Test e-mail addresses use `@example.test`.
- No AI tool names in client-facing text.
- No subagents, push, merge or rebase.
- Stage explicit paths only (`git add <paths>`). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Exact values (spec)**
- Percent: a whole number 1–99. Discount = `Math.round(listCents * p / 100)`.
- Euros: to the cent, via `parseEuroCents`.
- `MIN_TOTAL_CENTS = 100`. The total never drops below it, and the discount is capped to keep it there.
- Code shape: `/^[A-Z0-9-]{1,30}$/` after `normalizeCode` (trim + upper case).
- Days after sign-up: 1–365.
- Live check: 20 per 600 s per IP, under the key `rateKey("discount", ip)`.
- A registration use counts while not `cancelled` and any of: `confirmed`, `paid_cents > 0`, or `created_at` within 24 h. An e-course use counts while its payment is `paid`/`held`, or `pending` with `attemptEnds > now` (30 min, 60 for järelmaks).
- Lock order, registration: `course_sessions` → `discount_codes` → `registrations` insert → contract. Lock order, e-course: `lockEcoursePurchase` → `discount_codes` → `payments`. The code lock is `select … for no key update`.
- Logs name a code by its id only, never by its text, and never name an e-mail.

## Review Focus

Each line below has its test in the task that owns the code.

1. **A second „Rakenda“/Enter, or a different code typed, while a check is in flight.** Only the latest answer may show, so an older reply never overwrites a newer one (Task 9: `ignores a stale check answer`).
2. **A list price of 1,00 € or less, or a euro code at least the list price.** The discount is capped to `list − 100`. When the cap leaves 0, the code is refused `scope`, and no 0-cent redemption is ever inserted (Task 1: `a course at 1 € or less gets no discount`; Task 6: `a code worth nothing here is refused scope and stores nothing`).
3. **The remembered code is paused or gone when the page loads again, or `sessionStorage` throws.** The form shows the list price and the field's error, and with storage blocked it still applies codes (Task 9: `a remembered code refused on load shows the list price` and `works with sessionStorage throwing`).
4. **Maria changes the course's list price between the check and the submit.** A percent code's euros change, so the submit answers `changed` and the form re-checks and shows the new total. A euro code is unaffected (Task 6: `a list price changed after the check answers changed for a percent code`).
5. **The registration form switched to „Individuaalne“.** It shows no code field, and the request carries no `discountCode` (Task 9: `the individual request has no code field and sends no code`).

## Decisions this plan adds (spec gaps, ruled)

- **R1, the e-course amount.** `startEcoursePayment`'s `amountCents` stays the **list** price, so existing callers and tests keep it. The new `discount` input (`{ typed, shownCents } | null`) makes the row's `amount_cents` = `totalWith(list, discount)`. The spec's "amountCents is the total" is read as the stored row's amount: deriving the list from total + shown breaks under the 1 € cap.
- **R2, `codeRefusal` order.** paused → ended → notYet → scope → usedUp. Scope comes before usedUp, so a code that does not apply here never says "used up". A discount that caps to 0 is `scope`.
- **R3, `personFacts(q, email, { codeId, courseId })` has no `except` argument.** No caller has the order's row before the check, and the spec's two exclusions are built into the SQL. `personRefusal` order: used → first → returning → subscriber → expired.
- **R4, the subscriber rule.** An unconfirmed `subscribers` row is "not subscribed". When she is subscribed, the days count from her `consent_at` even if she ticks the box again. Ticking the box with no subscription never expires.
- **R5, the account card and the confirmation mail print no price today.** Their line „Sooduskood {code}: −{amount}“ goes just before the next-step sentence.
- **R6, admin use marks.** These come from the pure `useMark`. Payment `replaced` → „makse pooleli“. A redemption whose order was deleted → no mark text, „—“.
- **R7, the e-course re-send.** When `liveAttempt` reuses a pending row (same amount, method and code), no second redemption is inserted. The payment's partial unique index allows one.
- **R8, a fragment the server never sees.** `/admin/seaded#uudiskiri` → `/admin/sooduskoodid` is a client-side redirect in SettingsEditor's hash effect.
- **R9, caching.** A new `PublicChange` `{ kind: "welcomeCode" }` → `[EVERY_PAGE]`. Only the welcome row's create, save, switch or delete sends it.
- **R10, the footer's cache.** The footer is ISR-cached (`(site)/layout.tsx`, revalidate 86400). A welcome code that starts or ends **by date** shows stale until the daily refresh or the next save. This is accepted and documented in the doc comment of `welcomeCode`.
- **R11, the welcome row.** It is created from the empty page via „Lisa tervituskood“ (`?kood=tervituskood`). Only one can exist (the unique partial index).
- **R12, D11 („Lisa sooduskood“ on the Raha card).** Its refusals: `paid`, `unpaidInvoice`, `cancelled`, `unknown`, `stale` (the registration already has a code, or none to remove), and `worthless` (the list price is 1,00 € or less). `worthless` uses the Draft text „Sellele hinnale sooduskood ei mõju.“ (my call).
- **R13, the seed.** It keeps `settings.newsletter` with an empty code, so no welcome row exists. The migration's data SQL makes the row only from a code of the right shape.

### Amendments after comparing Rempire's promo codes (controller, 11.11; binding)

- **R14, looser normalising (Task 1).** `normalizeCode` = NFKC, remove every whitespace character inside and around (spaces, NBSP U+00A0, U+202F, zero-width U+200B–U+200D, U+FEFF), fold dash variants (U+2010–U+2015, U+2212) to "-", upper case. `isCode` additionally requires at least one letter or digit ("---" is not a code). The admin save normalises the same way, so Maria's „tere 10“ is stored as `TERE10`. Reason: the welcome code is copied from a mail on a phone.
- **R15, a refund that leaves the access (Tasks 1 and 3).** A `refunded` e-course payment's use **keeps counting** (for `usesOf`/`countingUse`, `personFacts.uses` and `useMark` → "counts") while a `course_access` with `revoked_at is null` exists for the payment's client and course. Only a refund whose access is revoked (or never existed) gives the use back. Reason: `montonio.ts` maps PARTIALLY_REFUNDED to `refunded`, and the spec's own fix for a wrong e-course price is a partial refund; without this a limited code gets a slot back and a once-per-person code becomes reusable while she keeps the course.
- **R16, one validator for every write (Task 13).** `writeCode` checks `codeFieldProblems` over the **stored row merged with the patch**, never the patch alone (a patch `{ scope: "courses" }` with no courses, or `{ kind: "euro" }` with no amount, is refused with the field error, never a DB check error).
- **R17, switching Protsent ↔ Eurod (Task 13).** Switching empties the value field; the kind is saved only together with a valid value (clicking the choice alone sends nothing). Rempire shipped 150 € → 150 % twice.
- **R18, a euro ceiling (Task 13).** A euro amount above the highest current list price among the courses in the code's scope is refused: field error `amountTooHigh` „Soodustus on suurem kui koolituse hind.“ (Draft). Checked on every write over the merged row (R16), so narrowing the scope re-checks it. The 1 € floor still covers later price drops.
- **R19, delete (Task 13).**
  - A code with redemption rows but none that count: the line „Koodi on kasutatud tühistatud või pooleli jäänud tellimustel, seega ei saa seda kustutada. Peata see.“ (Draft) instead of the plain used line, so „Kasutatud 0“ never contradicts it.
  - `deleteCode` maps a foreign-key violation (Postgres `23503`, a booking committed first) to `{ ok: false, error: "used" }`, never a 500.
- **R20, small admin aids (Task 13).** `codeTaken` carries the existing code's id and the field error shows a link „Ava see kood“ (Draft) to its drawer. The drawer shows „Soodustust kokku: {amount}“ (Draft): the sum of `discount_cents` over the uses that count.
- **Kept as the spec says (Rempire differs):** the code text stays editable until its first use (`codeUsed` after), because the welcome code's text must stay changeable as it is today.

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/discount-codes.ts` (new, browser) | The rules: shape, normalising, discount, total, refusals, value text, state, use marks, the live check's answer types |
| `src/domain/discount-code-fields.ts` (new, browser) | The drawer's typed fields and their checks (like `domain/session-fields.ts`) |
| `src/domain/welcome-code.ts` | Keeps only `welcomeFragment` / `WELCOME_FRAGMENT` once Task 12 ends |
| `src/db/schema.ts`, `drizzle/00xx_discount_codes.sql` | The three tables and four columns, plus the welcome row from the setting |
| `src/server/discount-codes.ts` (new) | The money path: `findCode`, `lockCode`, `usesOf`, `countingUse`, `personFacts`, `redeem`, `insertRedemption`, `welcomeCode` |
| `src/server/discount-check.ts` (new) | The live check (rate bucket, course lookup, answer) |
| `src/server/discount-code-admin.ts` (new) | The admin: list, read/write/create, switch, delete, uses; D11 add/remove |
| `src/server/actions/admin-discounts.ts` (new) | `adminAction` wrappers with refresh and revalidation |
| `src/app/api/admin/sooduskood/[id]/route.ts` (new) | The drawer's autosave route |
| `src/app/admin/(panel)/sooduskoodid/page.tsx` (new) | The list and the drawer |
| `src/components/admin/DiscountCodeList.tsx`, `DiscountCodeDrawer.tsx`, `RegistrationDiscount.tsx` (new) | The admin UI |
| `src/components/site/useDiscountCode.ts`, `DiscountField.tsx` (new) | The public field and its state |

---

### Task 1: Domain rules

**Files:**
- Create: `src/domain/discount-codes.ts`.
- Modify:
  - `src/domain/welcome-code.ts`: `SHAPE`, `WELCOME_CODE_MAX`, `DISCOUNT_MIN/MAX` and `CODE_DAYS_MIN/MAX` become re-exports of the new constants. The rest stays until Task 12.
  - `tests/unit/old-safari.test.ts`: add `src/domain/discount-codes.ts` to `BROWSER_FILES`.
- Test: `tests/unit/discount-codes-rules.test.ts`.

**Interfaces — Produces** (every later task uses these names):
```ts
export const CODE_MAX = 30;
export const CODE_SHAPE = /^[A-Z0-9-]{1,30}$/;
export const MIN_TOTAL_CENTS = 100;
export const PERCENT_MIN = 1, PERCENT_MAX = 99, DAYS_MIN = 1, DAYS_MAX = 365;
export const REGISTRATION_USE_MS = 24 * 60 * 60 * 1000;
export type CodeScope = "all" | "ecourse" | "contact" | "courses";
export type Audience = "all" | "first" | "returning";
export type CodeRule = {
  code: string; welcome: boolean; percent: number | null; amountCents: number | null; scope: CodeScope; courseIds: readonly number[];
  startsOn: string | null; endsOn: string | null; maxUses: number | null; audience: Audience; oncePerPerson: boolean;
  daysAfterSignup: number | null; active: boolean;
};                                        // dates "YYYY-MM-DD", Tallinn's calendar
export function normalizeCode(typed: string): string;          // trim + toUpperCase
export const isCode: (s: string) => boolean;                   // CODE_SHAPE.test
export function discountCents(code: Pick<CodeRule, "percent" | "amountCents">, listCents: number): number;
export function totalWith(listCents: number, discountCents: number): number;
type PriceCourse = Parameters<typeof registrationPrice>[0];   // Task 4 renames registrationPrice → listPrice
export function registrationTotal(course: PriceCourse, r: { kind: "group" | "individual"; discountCents: number }): number | null;
export function registrationDiscount(course: PriceCourse, r: { kind: "group" | "individual"; discountCents: number; discountCode: string }): { code: string; listCents: number; cents: number } | null;
export type CodeRefusal = "paused" | "ended" | "notYet" | "scope" | "usedUp";
export function codeRefusal(code: CodeRule, at: { courseId: number; courseType: "e_learning" | "contact"; listCents: number; today: string; uses: number }): CodeRefusal | null;
export type PersonFacts = { uses: number; trained: boolean; subscribedOn: string | null };
export type PersonRefusal = "used" | "first" | "returning" | "subscriber" | "expired";
export function personRefusal(code: CodeRule, facts: PersonFacts, at: { subscribing: boolean; today: string }): PersonRefusal | null;
export function addDays(day: string, n: number): string;       // "2026-11-30" + 2 → "2026-12-02"
export function validOn(code: Pick<CodeRule, "active" | "startsOn" | "endsOn">, today: string): boolean;   // active and inside its dates (both days included)
export function codeValueText(code: Pick<CodeRule, "percent" | "amountCents">): string;   // "10%", "15 €", "15,50 €"
export type CodeState = "active" | "paused" | "upcoming" | "ended" | "full";
export function codeState(code: CodeRule, today: string, uses: number): CodeState;
export type UseMark = "counts" | "cancelled" | "unpaid" | "pending" | "failed" | "refunded" | "gone";
export function useMark(use: { registration: { status: RegStatus; paidCents: number; createdAt: Date } | null; payment: { status: "pending" | "paid" | "failed" | "refunded" | "held" | "replaced"; inWindow: boolean } | null }, now: Date): UseMark;
export function codeHint(c: { welcome: boolean; audience: Audience }): "welcome" | "first" | "returning" | null;
export type CheckError = "empty" | "unknown" | CodeRefusal | "rate" | "server";
export type CheckAnswer =
  | { ok: true; code: string; discountCents: number; totalCents: number; value: string; audience: Audience; welcome: boolean }
  | { ok: false; error: CheckError; startsOn?: string };
export type SubmitCodeError = "unknown" | CodeRefusal | "person" | "changed";
```

**The rules the signatures leave open:**
- **`discountCents`:** the raw amount is `percent !== null ? Math.round(listCents * percent / 100) : amountCents`. It returns `Math.min(raw, Math.max(listCents - MIN_TOTAL_CENTS, 0))`.
- **`totalWith(list, d)`:** `list - Math.min(d, Math.max(list - MIN_TOTAL_CENTS, 0))`. A list of 1 € or less is never raised.
- **`registrationTotal`:** `null` when there is no list price. Otherwise `totalWith(list, r.discountCents)`.
- **`registrationDiscount`:** `null` when `discountCode === ""`, the discount is 0, or there is no list. `cents = list - total`, so that list − cents = total always.
- **`codeRefusal`:**
  - `!active` → `paused`;
  - `endsOn < today` → `ended`;
  - `startsOn > today` → `notYet`;
  - scope mismatch (`ecourse` ↔ `e_learning`, `contact` ↔ `contact`, `courses` → `courseIds.includes`), or `discountCents(code, listCents) === 0` → `scope`;
  - `maxUses !== null && uses >= maxUses` → `usedUp`.
- **`personRefusal`:**
  - `oncePerPerson && uses > 0` → `used`;
  - `first` && trained → `first`;
  - `returning` && !trained → `returning`;
  - `welcome && subscribedOn === null && !subscribing` → `subscriber`;
  - `welcome && daysAfterSignup !== null && subscribedOn !== null && addDays(subscribedOn, daysAfterSignup) < today` → `expired`.
- **`codeState`:** paused → ended → upcoming → full → active.
- **`useMark`:**
  - With a registration: `cancelled` if cancelled; `counts` if confirmed, `paidCents > 0` or under 24 h; else `unpaid`.
  - With a payment: `paid`/`held` → `counts`; `pending` && inWindow → `counts`; `pending`/`replaced` → `pending`; `failed` → `failed`; `refunded` → `refunded`.
  - **R15:** the payment input also has `accessKept: boolean` (a `course_access` not revoked for the payment's client and course); `refunded` with `accessKept` → `counts`. Add `useMark(pay("refunded", false, true), now)` → `"counts"` to the test table (the `pay` helper gains the third argument, default false).
  - With neither → `gone`.
- **`codeValueText`:** percent → `${p}%`. Euros → `formatEUR(amountCents, "et")`.

- [ ] **Step 1: Write the failing tests** (`tests/unit/discount-codes-rules.test.ts`)

```ts
const rule = (over: Partial<CodeRule> = {}): CodeRule => ({ code: "TERE10", welcome: false, percent: 10, amountCents: null, scope: "all", courseIds: [], startsOn: null, endsOn: null, maxUses: null, audience: "all", oncePerPerson: true, daysAfterSignup: null, active: true, ...over });
const at = { courseId: 7, courseType: "contact" as const, listCents: 35000, today: "2026-12-01", uses: 0 };

test("the rounding: 10 % of 199,99 € is 20,00 € and 15 % of 333,00 € is 49,95 €", () => {
  expect(discountCents(rule(), 19999)).toBe(2000);
  expect(discountCents(rule({ percent: 15 }), 33300)).toBe(4995);
});
test("half a cent rounds up", () => expect(discountCents(rule({ percent: 5 }), 1010)).toBe(51)); // 50.5 → 51
test("the 1 € floor caps a euro code", () => {
  expect(discountCents(rule({ percent: null, amountCents: 50000 }), 35000)).toBe(34900);
  expect(totalWith(35000, 50000)).toBe(100);
});
test("a course at 1 € or less gets no discount and keeps its price", () => {
  expect(discountCents(rule({ percent: null, amountCents: 500 }), 100)).toBe(0);
  expect(totalWith(80, 0)).toBe(80);
  expect(codeRefusal(rule(), { ...at, listCents: 100 })).toBe("scope");
});
test("registrationTotal follows the live list price minus the frozen euros", () => {
  const c = { type: "contact" as const, price: null, priceGroup: 40000, priceIndividual: 60000 };
  expect(registrationTotal(c, { kind: "group", discountCents: 3500 })).toBe(36500);
  expect(registrationTotal(c, { kind: "individual", discountCents: 0 })).toBe(60000);
  expect(registrationTotal({ ...c, priceGroup: null }, { kind: "group", discountCents: 3500 })).toBeNull();
  expect(registrationDiscount(c, { kind: "group", discountCents: 3500, discountCode: "TERE10" })).toEqual({ code: "TERE10", listCents: 40000, cents: 3500 });
  expect(registrationDiscount(c, { kind: "group", discountCents: 0, discountCode: "" })).toBeNull();
});
test.each([
  [{ active: false }, "paused"],
  [{ endsOn: "2026-11-30" }, "ended"],
  [{ startsOn: "2026-12-02" }, "notYet"],
  [{ scope: "ecourse" as const }, "scope"],
  [{ scope: "courses" as const, courseIds: [8] }, "scope"],
  [{ maxUses: 3 }, null],
])("codeRefusal %o → %s", (over, want) => expect(codeRefusal(rule(over), at)).toBe(want));
test("the last day is included and the first day starts at Tallinn's midnight", () => {
  expect(codeRefusal(rule({ startsOn: "2026-12-01", endsOn: "2026-12-01" }), at)).toBeNull();
  expect(codeRefusal(rule({ maxUses: 3 }), { ...at, uses: 3 })).toBe("usedUp");
});
test("scope is told before usedUp", () => expect(codeRefusal(rule({ scope: "ecourse", maxUses: 1 }), { ...at, uses: 1 })).toBe("scope"));
test.each([
  [rule(), { uses: 1, trained: false, subscribedOn: null }, false, "used"],
  [rule({ audience: "first" }), { uses: 0, trained: true, subscribedOn: null }, false, "first"],
  [rule({ audience: "returning" }), { uses: 0, trained: false, subscribedOn: null }, false, "returning"],
  [rule({ welcome: true, audience: "first" }), { uses: 0, trained: false, subscribedOn: null }, false, "subscriber"],
  [rule({ welcome: true, audience: "first" }), { uses: 0, trained: false, subscribedOn: null }, true, null],
  [rule({ welcome: true, audience: "first", daysAfterSignup: 30 }), { uses: 0, trained: false, subscribedOn: "2026-11-01" }, false, null],
  [rule({ welcome: true, audience: "first", daysAfterSignup: 29 }), { uses: 0, trained: false, subscribedOn: "2026-11-01" }, false, "expired"],
])("personRefusal %#", (code, facts, subscribing, want) => expect(personRefusal(code, facts, { subscribing, today: "2026-12-01" })).toBe(want));
test("codeValueText", () => {
  expect(codeValueText(rule())).toBe("10%");
  expect(codeValueText(rule({ percent: null, amountCents: 1500 }))).toBe("15 €");
  expect(codeValueText(rule({ percent: null, amountCents: 1550 }))).toBe("15,50 €");
});
test("codeState", () => {
  expect(codeState(rule({ active: false, endsOn: "2026-11-01" }), "2026-12-01", 0)).toBe("paused");
  expect(codeState(rule({ endsOn: "2026-11-30" }), "2026-12-01", 0)).toBe("ended");
  expect(codeState(rule({ startsOn: "2026-12-02" }), "2026-12-01", 0)).toBe("upcoming");
  expect(codeState(rule({ maxUses: 2 }), "2026-12-01", 2)).toBe("full");
  expect(codeState(rule(), "2026-12-01", 5)).toBe("active");
});
test("useMark mirrors D7's limit rule", () => {
  const now = new Date("2026-12-01T12:00:00Z"), h = (n: number) => new Date(now.getTime() - n * 3_600_000);
  const reg = (status: RegStatus, paidCents: number, createdAt: Date) => ({ registration: { status, paidCents, createdAt }, payment: null });
  const pay = (status: "pending" | "paid" | "failed" | "refunded" | "held" | "replaced", inWindow = false) => ({ registration: null, payment: { status, inWindow } });
  expect(useMark(reg("awaiting_prepayment", 0, h(23)), now)).toBe("counts");
  expect(useMark(reg("awaiting_prepayment", 0, h(25)), now)).toBe("unpaid");
  expect(useMark(reg("awaiting_prepayment", 5000, h(99)), now)).toBe("counts");
  expect(useMark(reg("confirmed", 0, h(99)), now)).toBe("counts");
  expect(useMark(reg("cancelled", 5000, h(1)), now)).toBe("cancelled");
  expect([useMark(pay("paid"), now), useMark(pay("held"), now), useMark(pay("pending", true), now)]).toEqual(["counts", "counts", "counts"]);
  expect([useMark(pay("pending"), now), useMark(pay("replaced"), now), useMark(pay("failed"), now), useMark(pay("refunded"), now)]).toEqual(["pending", "pending", "failed", "refunded"]);
  expect(useMark({ registration: null, payment: null }, now)).toBe("gone");
});
test("validOn includes both days", () => {
  expect(validOn(rule({ startsOn: "2026-12-01", endsOn: "2026-12-01" }), "2026-12-01")).toBe(true);
  expect(validOn(rule({ endsOn: "2026-11-30" }), "2026-12-01")).toBe(false);
  expect(validOn(rule({ active: false }), "2026-12-01")).toBe(false);
});
test("normalizeCode and isCode", () => {
  expect(normalizeCode("  tere10 ")).toBe("TERE10");
  // R14: spaces inside, NBSP, zero-width and dash variants
  expect(normalizeCode("suvi 10")).toBe("SUVI10");
  expect(normalizeCode("tere 10​")).toBe("TERE10");
  expect(normalizeCode("tere–10")).toBe("TERE-10");
  expect(isCode("TERE-10")).toBe(true);
  expect(isCode("TERE 10")).toBe(false);
  expect(isCode("---")).toBe(false);
  expect(isCode("A".repeat(31))).toBe(false);
});
test("addDays crosses the month and the year", () => expect(addDays("2026-12-31", 1)).toBe("2027-01-01"));
```

- [ ] **Step 2: Run and see it fail.** Run `npx vitest run tests/unit/discount-codes-rules.test.ts`. Expected: FAIL (cannot resolve `@/domain/discount-codes`).
- [ ] **Step 3: Implement `src/domain/discount-codes.ts`** with the signatures above.
  - Import `registrationPrice` and `RegStatus` from `./registration` and `formatEUR` from `./money`.
  - No lookbehind and no `node:` imports.
  - `addDays` uses `Date.UTC` arithmetic on the parts.
  - Point the constants in `welcome-code.ts` at the new ones (`WELCOME_CODE_MAX = CODE_MAX`; its private `SHAPE` uses `CODE_SHAPE`).
- [ ] **Step 4: Run** `npx vitest run tests/unit/discount-codes-rules.test.ts tests/unit/old-safari.test.ts tests/unit/welcome-code.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/domain/discount-codes.ts src/domain/welcome-code.ts tests/unit/discount-codes-rules.test.ts tests/unit/old-safari.test.ts && git commit -m "feat(discounts): the pure rules of discount codes"`.

---

### Task 2: Schema and migration (next free number, expected 0025)

**Files:**
- Modify: `src/db/schema.ts`:
  - add the new tables after `courseAccess`, and the columns on `registrations` (lines ~98–137) and `payments` (~350–402);
  - extend the `settings` comment (line ~871): `newsletter`'s keys are no longer read after this migration (kept for a rollback).
- Create: `drizzle/00xx_discount_codes.sql` (generated, plus the appended data SQL), and the generated meta snapshot and journal entry.
- Test: `tests/db/migration-0025.test.ts`. Use the generated number; through the previous tag, read from `drizzle/meta/_journal.json`.

**Interfaces — Produces:**
```ts
export const discountScope = pgEnum("discount_scope", ["all", "ecourse", "contact", "courses"]);
export const discountAudience = pgEnum("discount_audience", ["all", "first", "returning"]);
export const redemptionVia = pgEnum("redemption_via", ["form", "cart", "admin"]);
export const discountCodes = pgTable("discount_codes", {
  id: serial, code: text notNull, welcome: boolean notNull default false, percent: smallint, amountCents: integer("amount_cents"),
  scope: discountScope notNull default "all", startsOn: date("starts_on", { mode: "string" }), endsOn: date("ends_on", { mode: "string" }),
  maxUses: integer("max_uses"), audience: discountAudience notNull default "all", oncePerPerson: boolean("once_per_person") notNull default true,
  daysAfterSignup: smallint("days_after_signup"), note: text notNull default "", active: boolean notNull default true, createdAt, updatedAt,
});
export const discountCodeCourses = pgTable("discount_code_courses", { codeId → discountCodes.id cascade, courseId → courses.id cascade }, pk(codeId, courseId));
export const discountRedemptions = pgTable("discount_redemptions", {
  id, codeId → discountCodes.id (no onDelete), email text notNull, clientId/courseId/registrationId/paymentId (set null),
  listCents: integer notNull, discountCents: integer notNull, via: redemptionVia notNull, createdAt,
});
registrations.discountCents: integer("discount_cents").notNull().default(0); registrations.discountCode: text("discount_code").notNull().default("");
payments.discountCents / payments.discountCode: the same.
export type DiscountCode = typeof discountCodes.$inferSelect; export type DiscountRedemption = typeof discountRedemptions.$inferSelect;
```

**Constraints and indexes (exact names):**
- **`discount_codes`:**
  - `discount_codes_code` unique;
  - `discount_codes_one_welcome` unique on `(welcome)` where `welcome`;
  - `discount_codes_code_shape` `code ~ '^[A-Z0-9-]{1,30}$'`;
  - `discount_codes_one_value` `(percent is null) <> (amount_cents is null)`;
  - `discount_codes_percent_range` `percent between 1 and 99`;
  - `discount_codes_amount_positive` `amount_cents > 0`;
  - `discount_codes_dates_order` `ends_on >= starts_on`;
  - `discount_codes_max_uses_positive` `max_uses > 0`;
  - `discount_codes_days` `days_after_signup is null or (welcome and days_after_signup between 1 and 365)`;
  - `discount_codes_welcome_rules` `not welcome or (audience = 'first' and once_per_person)`.
- **`discount_redemptions`:**
  - `discount_redemptions_code` on `code_id`;
  - `discount_redemptions_code_email` on `(code_id, email)`;
  - `discount_redemptions_registration` unique where `registration_id is not null`;
  - `discount_redemptions_payment` unique where `payment_id is not null`;
  - `discount_redemptions_cents_positive` `list_cents > 0 and discount_cents > 0`.
- **Not negative:** `registrations_discount_not_negative` and `payments_discount_not_negative` (`discount_cents >= 0`).

**The data SQL** (appended after the generated DDL; percent read as `discountPercentOf` does, days as `codeDaysOf`):
```sql
INSERT INTO "discount_codes" ("code", "welcome", "percent", "scope", "audience", "once_per_person", "days_after_signup", "active")
SELECT v->>'welcomeCode', true,
  CASE WHEN jsonb_typeof(v->'discountPercent') = 'number' AND (v->>'discountPercent') ~ '^[0-9]{1,2}$' AND (v->>'discountPercent')::int BETWEEN 1 AND 99 THEN (v->>'discountPercent')::int
       WHEN substring(v->>'discountLabel' from '[0-9]+') ~ '^[0-9]{1,2}$' AND substring(v->>'discountLabel' from '[0-9]+')::int BETWEEN 1 AND 99 THEN substring(v->>'discountLabel' from '[0-9]+')::int
       ELSE 10 END,
  'all', 'first', true,
  CASE WHEN jsonb_typeof(v->'codeDays') = 'number' AND (v->>'codeDays') ~ '^[0-9]{1,3}$' AND (v->>'codeDays')::int BETWEEN 1 AND 365 THEN (v->>'codeDays')::int END,
  true
FROM (SELECT "value" AS v FROM "settings" WHERE "key" = 'newsletter') s
WHERE (v->>'welcomeCode') ~ '^[A-Z0-9-]{1,30}$';
```

- [ ] **Step 1: Write the failing test** in the house pattern of `tests/db/migration-0022.test.ts`. The `through(<previous tag>)` helper inserts `settings.newsletter` with raw SQL, then `through(<this tag>)`.
  - `"00xx adds the discount tables and columns and nothing else"`:
    - the new tables are exactly `discount_codes`, `discount_code_courses` and `discount_redemptions`;
    - the new columns are exactly the four (`integer` NOT NULL default 0, `text` NOT NULL default `''::text`);
    - the new indexes and constraints are exactly the names above;
    - everything else is equal before and after;
    - an insert through the schema with each new column works.
  - `"a code with a percent and days becomes the welcome row"`: `{welcomeCode:"TERE10", discountPercent:15, codeDays:30}` → one row `{code:"TERE10", welcome:true, percent:15, amount_cents:null, scope:"all", audience:"first", once_per_person:true, days_after_signup:30, active:true}`. The setting is unchanged.
  - `"only the old discountLabel gives its number"`: `{welcomeCode:"TERE", discountLabel:"-15%"}` → percent 15, days null. And `{welcomeCode:"TERE", discountLabel:"tervitus"}` → percent 10.
  - `"an empty code makes no row"`: `{welcomeCode:"", discountPercent:10}` → 0 rows.
  - `"a code of the wrong shape makes no row"`: `{welcomeCode:"tere 10"}` → 0 rows.
  - `"the checks refuse what the rules forbid"`, through the schema after the migration:
    - percent 100;
    - both percent and amount;
    - neither;
    - `ends_on < starts_on`;
    - two welcome rows;
    - welcome with audience `all`;
    - days on a non-welcome row;
    - a redemption with `discount_cents` 0;
    - a second redemption on one registration;
    - deleting a code that has a redemption.

    Each rejects.
- [ ] **Step 2: Run** `npx vitest run tests/db/migration-0025.test.ts`. Expected: FAIL (no such tag).
- [ ] **Step 3: Change `schema.ts`.** Run `npx drizzle-kit generate --name discount_codes` and append the data SQL with a `--> statement-breakpoint` before it.
- [ ] **Step 4: Run** `npx vitest run tests/db/migration-0025.test.ts tests/db/seed.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** the schema, the drizzle files and the test: `feat(db): discount codes, their courses and uses, and the frozen discount`.

---

### Task 3: Server core — find, lock, count, person facts, redeem, welcome

**Files:**
- Create: `src/server/discount-codes.ts`.
- Modify:
  - `src/db/queries/payments.ts`: `export const attemptEnds` (line ~141), unchanged otherwise.
  - `src/db/queries/seats.ts`: the lock-order comment block gains `discount_codes` per D8 (both orders, and the "no cycle" paragraph).
- Test: `tests/db/discount-codes.test.ts`.

**Interfaces:**
- Consumes: Task 1's `CodeRule`, `codeRefusal`, `personRefusal`, `discountCents`, `normalizeCode`, `isCode`, `codeValueText`, `SubmitCodeError` and `REGISTRATION_USE_MS`; Task 2's tables.
- Produces:
```ts
export type StoredCode = DiscountCode & { courseIds: number[] };
export const ruleOf: (c: StoredCode) => CodeRule;
export async function findCode(q: Q, typed: string): Promise<StoredCode | null>;            // normalizeCode; isCode else null
export async function lockCode(tx: Tx, id: number): Promise<StoredCode | null>;              // select … for no key update, then its courses
export function countingUse(now: Date): SQL;      // the D7 limit condition over `d` (discount_redemptions) left-joined `r` (registrations) and `p` (payments)
export async function usesOf(q: Q, codeId: number, now: Date): Promise<number>;
export async function personFacts(q: Q, email: string, at: { codeId: number; courseId: number }): Promise<PersonFacts>;
export type RedeemInput = { typed: string; shownCents: number | null; email: string; courseId: number; courseType: "e_learning" | "contact"; listCents: number; subscribing: boolean };
export type Redeemed = { ok: true; codeId: number; code: string; discountCents: number } | { ok: false; error: SubmitCodeError };
export async function redeem(tx: Tx, input: RedeemInput, now: Date): Promise<Redeemed>;
export async function insertRedemption(tx: Q, row: { codeId: number; email: string; clientId: number | null; courseId: number; registrationId?: number; paymentId?: number; listCents: number; discountCents: number; via: "form" | "cart" | "admin" }, now: Date): Promise<void>;
export type WelcomeCode = { code: string; value: string; days: number | null };
export async function welcomeCode(q: Q, now: Date): Promise<WelcomeCode | null>;
```

**The rules the signatures leave open:**
- **`countingUse(now)`:**
  ```
  (d.registration_id is not null and r.status <> 'cancelled' and (r.status = 'confirmed' or r.paid_cents > 0 or r.created_at > now - 24 h))
  or (d.payment_id is not null and (p.status in ('paid','held') or (p.status = 'pending' and attemptEnds > now)))
  ```
  Raw SQL with the aliases `d`/`r`/`p`, because `attemptEnds` reads `p.updated_at` / `p.method`.
  - **R15:** the payment branch also counts `p.status = 'refunded'` while a `course_access` with `revoked_at is null` exists for the payment's client and course; `personFacts.uses` likewise; `useMark`'s payment input gains `accessKept: boolean` and a refunded payment with `accessKept` is "counts". Tests: `"usesOf: a refund that leaves the access keeps counting; a refund with the access revoked gives back"` and the matching once-per-person case, and the `useMark` table in Task 1 gains `pay("refunded", false, true)` → "counts".
- **`personFacts.uses`:** the uses of `(codeId, email)` that count for once per person. These are:
  - a registration not cancelled, **except** one of `courseId` with `paid_cents = 0` and status ≠ `confirmed`;
  - or a payment `paid`/`held`.
- **`personFacts.trained`:** any of these exists for the email:
  - a registration not cancelled and (`confirmed` or `paid_cents > 0`);
  - or a `kind = 'ecourse'` payment with status `paid`;
  - or a `course_access` with `revoked_at is null`, joined to `clients` with that email.
- **`personFacts.subscribedOn`:** `tallinnToday(consentAt)` of a `subscribers` row with `confirmed_at is not null`, else null.
- **`redeem` order:**
  1. `findCode` → null → `unknown`;
  2. `lockCode` → null → `unknown`;
  3. `codeRefusal(ruleOf(c), { …, today: tallinnToday(now), uses: await usesOf(tx, c.id, now) })`;
  4. `personRefusal(…)` → any → `person`;
  5. `d = discountCents`; `shownCents === null || shownCents !== d` → `changed`;
  6. `{ ok: true, codeId, code: c.code, discountCents: d }`.
- **E-mails:** every caller passes `normalizeEmail(email)` (D6). The redemption stores it so.
- **`welcomeCode`:** the `welcome` row with `validOn(rule, tallinnToday(now))`. Its scope, course and uses are not checked. It returns `{ code, value: codeValueText(c), days: c.daysAfterSignup }` or null. The doc comment carries R10.

- [ ] **Step 1: Write the failing tests** (`tests/db/discount-codes.test.ts`, with `makeTestDb()`, `contactCourse`/`registrationOn` from `tests/db/payments-fixtures.ts`, and the e-course payments via `insertPayment`):
  - `"once per person: a cancelled booking gives the use back; a confirmed, part-paid or other-course booking keeps it"`;
  - `"once per person leaves out an unpaid, unconfirmed booking of the same course, whatever its age"`: created 3 days ago → `uses` 0;
  - `"once per person: pending, failed and replaced e-course payments are left out; paid and held are not"`;
  - `"trained: paid, confirmed and an access count; unpaid, cancelled and a revoked access do not; a paid e-course counts"` (asserts `trained` for each source);
  - `"subscribedOn is the Tallinn day of consent_at of a confirmed subscriber only"`: a consent at 2026-11-30T22:30Z → `"2026-12-01"`; unconfirmed → null;
  - `"usesOf: an unpaid booking counts for 24 hours and then stops"` (`now` +23 h → 1, +25 h → 0);
  - `"usesOf: confirmed or part-paid keeps counting; a late payment on an old booking counts again, over the limit"` (`maxUses` 1, two counting → `usesOf` 2);
  - `"usesOf: a cancellation and a failed payment give back; a pending payment counts inside its window and not after"` (31 min → 0, a järelmaks row at 31 min → 1, at 61 min → 0);
  - `"usesOf equals the number of useMark 'counts' over the same rows"`: build each fixture, read `{registration, payment, inWindow}` and compare;
  - `"redeem: unknown, each code refusal, person for every person reason, changed for a smaller, a larger and a missing shownCents, ok"`. Assert `error` values, and that `redeem` with `"  tere10 "` finds `TERE10`;
  - `"welcomeCode: the active welcome row valid today; null when paused, ended, not yet started or absent"`.
- [ ] **Step 2: Run** `npx vitest run tests/db/discount-codes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/server/discount-codes.ts`**, export `attemptEnds`, and extend the `seats.ts` note.
- [ ] **Step 4: Run** `npx vitest run tests/db/discount-codes.test.ts tests/db/payments-start.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): find, lock, count and redeem a code`.

---

### Task 4: Every money path reads the total

**Files:**
- Modify:
  - `src/domain/registration.ts`: rename `registrationPrice` → `listPrice`.
  - `src/domain/discount-codes.ts`: its import.
  - Callers (each to `registrationTotal(course, r)` with `r` carrying `kind` and `discountCents`):
    - `src/db/queries/admin.ts:569` (`addRegistrationPayment`);
    - `src/server/client-data.ts:331` (also select `registrations.discountCents`/`discountCode`);
    - `src/server/contracts.ts:178` (`registrationContractFields`: the price is the total; `discount` is Task 8);
    - `src/server/invoices.ts` lines 235, 297, 342, 533 and 928;
    - `src/server/pay-page.ts:64`;
    - `src/server/payments/settle.ts` lines 294 (`paidAlready`: add `discountCents: registrations.discountCents` to its select), 375, 500 and 781;
    - `src/server/payments/start.ts:241`;
    - `src/server/registration-money.ts:87`;
    - `src/server/submit.ts:479` (confirmation `priceCents`);
    - `src/app/admin/(panel)/registreerimised/page.tsx` lines 129 and 371 (`total` → MoneyCard's `priceCents`, `openAmounts`, `receiptTakeBack`).
  - Allowed to keep `listPrice`: the course page `src/app/[locale]/(site)/koolitused/[slug]/page.tsx` (149, 271) and `src/db/demo-data.ts:237`.
  - `src/domain/account-cards.ts`: `ContactCard` gains `discount?: { code: string; cents: number }`, from `registrationDiscount`.
  - `src/components/account/AccountCourseCard.tsx`: prints `fill(d.discount.line, { code, amount: formatEUR(cents, locale) })` before the next-step sentence (R5).
  - `src/i18n/dict/et.ts`/`ru.ts`: a new section `discount: { line: "Sooduskood {code}: −{amount}" / "Промокод {code}: −{amount}" }` (Task 5 extends it).
  - `src/server/account-mail.ts`: its comment naming `registrationPrice`.
  - Tests that call the old name: `tests/unit/admin.test.ts:37-46` (describe → "listPrice + Maria's 50% rule"), `tests/db/demo-data.test.ts`, `tests/db/invoices.test.ts:1216`.
- Create: `tests/unit/price-callers.test.ts`.
- Test (extend):
  - `tests/db/admin.test.ts`, `tests/db/registration-money.test.ts`, `tests/db/payments-start.test.ts`;
  - `tests/db/payments-settle-guards.test.ts`, `tests/db/invoices.test.ts`, `tests/db/pay-page.test.ts`;
  - `tests/db/client-data.test.ts`, `tests/db/admin-registrations-page.test.ts`;
  - `tests/unit/account-cards.test.ts`.

- [ ] **Step 1: Write the guard** (`tests/unit/price-callers.test.ts`), in the scan style of `tests/unit/mail-count-callers.test.ts` (comments stripped first):
```ts
const LIST_PRICE_ALLOWED = ["src/app/[locale]/(site)/koolitused/[slug]/page.tsx", "src/app/[locale]/(site)/ostukorv/cart.tsx", "src/db/demo-data.ts", "src/domain/discount-codes.ts", "src/domain/registration.ts"];
const COURSE_PRICE_ALLOWED = ["src/domain/registration.ts", "src/app/[locale]/(site)/koolitused/[slug]/page.tsx", "src/app/[locale]/(site)/ostukorv/cart.tsx", "src/server/submit.ts"];
test("listPrice is called only where a list price is shown or the total is made", ...);          // \blistPrice\(
test("registrationPrice is gone", ...);                                                            // \bregistrationPrice\b nowhere in src
test("course.price is read directly only in the four files", ...);                                 // \bcourse\.price\b
test("in submit.ts, course.price is read only inside handleEcoursePurchase", ...);                 // every match index lies between "export function handleEcoursePurchase" and the next "export function"
```
- [ ] **Step 2: Write the money tests:**
  - `admin.test.ts`: `"addRegistrationPayment confirms the place from 50 % of the total"` (list 40000, discount 4000 → 18000 confirms, 17999 does not).
  - `registration-money.test.ts`: `"overRemainder measures against the total"`.
  - `payments-start.test.ts`: `"a registration with a discount starts ceil(T/2) for 50 % + 50 % and T for 100 %"` (T = 36501 → 18251).
  - `payments-settle-guards.test.ts`: `"paid in full and „Ülemakse“ are measured against the total"`.
  - `invoices.test.ts`: `"createInvoice and issueReceiptInTx measure the open amounts against the total"`.
  - `pay-page.test.ts`: `"/maksa offers the amounts of the total"`.
  - `client-data.test.ts`: `"the account card's priceCents is the total and its discount is the code and the cents"`.
  - `admin-registrations-page.test.ts`: `"the Raha card gets the total as priceCents"`.
- [ ] **Step 3: Run** these files. Expected: the guard fails on the name, and the money tests fail on the amounts.
- [ ] **Step 4: Rename and replace** every caller listed, and render the account line.
- [ ] **Step 5: Run** all of the files above plus `npx tsc --noEmit`. Expected: PASS, and tsc clean.
- [ ] **Step 6: Commit**: `refactor(money): every money path reads the registration's total (list − frozen discount)`.

---

### Task 5: The live check, its rate bucket and the public texts

**Files:**
- Create: `src/server/discount-check.ts`.
- Modify:
  - `src/server/actions/public.ts`: extract the `Deps` builder of `run` into `async function publicDeps(form: string): Promise<Deps>`, and add `checkDiscountCode`;
  - `src/server/submit.ts`: export `allowed` (the fail-open rate limit);
  - `src/i18n/dict/et.ts`, `ru.ts`: the `discount` section.
- Test: `tests/db/discount-check.test.ts`; `tests/unit/i18n.test.ts` (the et/ru key mirror) passes with the new section.

**Interfaces:**
- Consumes: Task 3's `findCode`, `usesOf`, `ruleOf`; Task 1's `codeRefusal`, `discountCents`, `totalWith`, `codeValueText` and `CheckAnswer`.
- Produces:
```ts
export const DISCOUNT_CHECK_LIMIT = 20, DISCOUNT_CHECK_WINDOW_SEC = 600;
export async function checkDiscount(deps: Pick<Deps, "db" | "env" | "ip" | "now">, formData: FormData): Promise<CheckAnswer>;  // fields: course (slug), code
export async function checkDiscountCode(formData: FormData): Promise<CheckAnswer>;   // in actions/public.ts; any throw → { ok: false, error: "server" } (logged without the code's text)
```
- **The rules:**
  - Order: the code is empty after `normalizeCode` → `empty`; then the rate check (`ip === null` passes) fails → `rate`; then a published course for the slug.
  - The list price: e-learning → `course.price`; contact → `listPrice(course, "group")`.
  - No course or no list price → `unknown`, and so does `findCode` null.
  - Then `codeRefusal` (with `startsOn` returned for `notYet`).
  - Then `{ ok: true, code, discountCents, totalCents: totalWith(list, d), value, audience, welcome }`.
  - It never reads an e-mail.
- **Dict `discount`** (ET / RU from spec §5): `open`, `label`, `apply`, `applied` („Sooduskood {code}: −{amount}“), `remove`, `total` („Kokku {total}“ / „Итого {total}“), `hintWelcome`, `hintFirst`, `hintReturning`, and `errors: { empty, unknown, paused, ended, notYet, usedUp, scope, person, changed }`. `paused` and `ended` have the same text; `notYet` keeps `{date}`. `rate` and `server` reuse `forms.errorTooMany` / the form's generic error.

- [ ] **Step 1: Write the failing tests** (`tests/db/discount-check.test.ts`, with deps `{ db, env: { KV: memoryKv() }, ip: "203.0.113.5", now }`; use the KV fake the existing rate tests use):
  - `"an applied code answers the discount, the total, the value, the audience and welcome"` (contact list 35000, 10 % → `{discountCents:3500, totalCents:31500, value:"10%"}`);
  - `"lower case and spaces are applied"`;
  - `"each refusal answers its own error, notYet with startsOn"`;
  - `"an unknown course or code answers unknown"`;
  - `"the 21st check in 10 minutes answers rate"` (20 pass, the 21st `{ok:false, error:"rate"}`);
  - `"it takes no e-mail"`: a FormData with `email` gives the same answer as without it.
- [ ] **Step 2: Run** `npx vitest run tests/db/discount-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `checkDiscount`, `publicDeps`, `checkDiscountCode` and the dict section.
- [ ] **Step 4: Run** `npx vitest run tests/db/discount-check.test.ts tests/unit/i18n.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): the live code check with its own rate bucket`.

---

### Task 6: The registration submit with a code

**Files:**
- Modify:
  - `src/server/forms.ts`:
    - `groupRegistrationFormSchema` gains `discountCode: z.string().max(60).optional()` and `discountCents: z.string().regex(/^\d{1,7}$/).optional()`;
    - `parseGroupRegistration` maps them (`discountCode: "discountCode", discountCents: "discountCents"`), with placement `discountCode: ["discountCode", "unknown"]` and `discountCents: ["discountCode", "changed"]`;
    - the handler reads `typed = normalizeCode(discountCode ?? "")` (empty → no code) and `shownCents = discountCents === undefined ? null : Number(discountCents)`;
    - the `message` comment no longer says the welcome code goes there.
  - `src/server/submit.ts`:
    - `createRegistration`'s `NewRegistration` gains `discountCents?`, `discountCode?`;
    - in `handleRegistration`'s transaction, after the seat check: if a code was sent, `redeem(tx, { typed, shownCents, email: data.email, courseId, courseType: "contact", listCents: listPrice(course,"group")!, subscribing: wantsNewsletter }, now)`. A refusal returns `{ status: "refused", result: fail({ discountCode: error }) }`. Then `createRegistration` with the discount, `insertRedemption(…, { registrationId, via: "form" })`, and the contract (its price already comes from the total, via Task 4);
    - the confirmation mail gets `discount`;
    - `registrationSummary` gets `discount`.
  - `src/server/account-mail.ts`: `RegistrationConfirmationInput` gains `discount?: { code: string; cents: number } | null`. The line `fill(t.discount.line, …)` goes before the next-step sentence (R5).
  - `src/server/messages.ts registrationSummary`: the input gains `discount?: { code: string; cents: number; totalCents: number } | null`. Rows after „Tasumine“: `["Sooduskood", `${code} (−${euro(cents)})`]` and `["Kokku", euro(totalCents)]`.
- Test: `tests/db/discount-submit.test.ts`; `tests/unit/messages.test.ts`; `tests/unit/account-mail.test.ts`.

**Interfaces:**
- Consumes: Task 3's `redeem`/`insertRedemption`; Task 4's `listPrice`/`registrationTotal`.
- Produces: `ActionResult` errors `{ discountCode: SubmitCodeError }`. This is the UI contract for Task 9.

- [ ] **Step 1: Write the failing tests** (`tests/db/discount-submit.test.ts`; `handleRegistration` with the deps style of `tests/db/actions.test.ts`, the contract version from `shownContractVersion`):
  - `"a registration with a code stores the discount, the use and the contract with the total in one transaction"`:
    - registration `discount_cents` 3500 and `discount_code` "PROOV-16";
    - one redemption `{via:"form", list_cents:35000, discount_cents:3500, registration_id}`;
    - the contract's `fields.price` "315,00 €".
  - `"a refusal stores nothing"`: a paused code → `{ok:false, errors:{discountCode:"paused"}}`, and no registration, redemption or contract row.
  - `"every person reason answers person, and the answers are identical"`: used, first, returning, subscriber and expired each → a deep-equal `{ok:false, errors:{discountCode:"person"}}`.
  - `"changed when the shown discount is smaller, larger, or missing"`.
  - `"a list price changed after the check answers changed for a percent code"` (Review Focus 4): check at 35000, set `priceGroup` 40000, submit with `discountCents` 3500 → `changed`. A euro code with the same flow passes.
  - `"a code worth nothing here is refused scope and stores nothing"` (Review Focus 2): `priceGroup` 100.
  - `"the newsletter box counts as subscribing for the welcome code"`.
  - `"the welcome code twice for the same course before paying: both get it"` / `"for another course: person"`.
  - `messages.test.ts`: `"registrationSummary prints Sooduskood and Kokku after Tasumine when a code was used"`.
  - `account-mail.test.ts`: `"the confirmation mail carries the code line before the next step"`.
- [ ] **Step 2: Run** `npx vitest run tests/db/discount-submit.test.ts tests/unit/messages.test.ts tests/unit/account-mail.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run** those files, plus `tests/db/actions.test.ts` and `tests/db/contracts-flows.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): a registration redeems its code under the code's lock`.

---

### Task 7: The e-course start with a code

**Files:**
- Modify:
  - `src/server/forms.ts`: `ecoursePurchaseSchema` and `parseEcoursePurchase` gain the same two fields and placement as Task 6.
  - `src/server/payments/start.ts`:
    - `startEcoursePayment` input gains `discount?: { typed: string; shownCents: number | null } | null`;
    - `EcourseStartResult` gains `{ kind: "discount"; error: SubmitCodeError }`;
    - `liveAttempt`'s e-course branch gains `eq(payments.discountCode, code)`.
  - `src/db/queries/payments.ts`: `NewPayment` gains `discountCents?: number; discountCode?: string`.
  - `src/server/submit.ts handleEcoursePurchase`:
    - the snapshot's `priceCents` = `totalWith(course.price, shownCents ?? 0)` when a code was sent;
    - it passes `discount` and the list price as `amountCents`;
    - `started.kind === "discount"` → `fail({ discountCode: started.error })`.
  - `src/server/messages.ts paymentSummary`: `PaymentNotice` gains `discount?: { code: string; cents: number } | null`. A row after „Summa“: `["Sooduskood", `${code} (−${euro(cents)})`]`. It is filled in `settle.ts:715` from the payment row.
  - `src/server/contracts.ts accessContractFields`: the payment's `discountCode`/`discountCents` feed `discount` (the field lands in Task 8; here only pass the data through `ContractInput.discount`).
- Test: `tests/db/discount-submit.test.ts` (extend); `tests/unit/payment-messages.test.ts`.

**The start's order under the lock** (R1, R7):
1. `lockEcoursePurchase`;
2. `paidRecently`;
3. if `discount`: `redeem(tx, { …, listCents: input.amountCents, courseType: "e_learning", subscribing: input.newsletter }, now)`, refusing → `{ discount: error }`;
4. `total = totalWith(input.amountCents, d)`;
5. `financingRefusedNow` on `total`;
6. `liveAttempt(…, total, method, code)`;
7. reuse it with **no** new redemption, or `insertPayment({ amountCents: total, discountCents: d, discountCode: code })` then `insertRedemption({ paymentId, via: "cart", listCents: input.amountCents })`.

- [ ] **Step 1: Write the failing tests:**
  - `"an e-course start with a code stores the total, the code and the snapshot"`: the row `amount_cents` 17100 for list 19000 at 10 %, `discount_cents` 1900, `discount_code`, `contract_snapshot.fields.price` "171,00 €", and one redemption `{via:"cart", payment_id}`.
  - `"a re-send inside the window with the same code reuses the order and inserts no second use"`.
  - `"a re-send with another code is a new attempt"`.
  - `"järelmaks is decided on the total"`: list 11000 at 10 % → total 9900 → `{kind:"financing"}`.
  - `"a refused code starts nothing"` → `{ok:false, errors:{discountCode:"usedUp"}}`, and no payment row.
  - `"existing callers without discount are unchanged"`: `payments-ecourse.test.ts` passes untouched.
  - `payment-messages.test.ts`: `"Uus makse prints Sooduskood after Summa"`.
- [ ] **Step 2: Run** `npx vitest run tests/db/discount-submit.test.ts tests/unit/payment-messages.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run** them, plus `tests/db/payments-ecourse.test.ts` and `tests/db/payments-start.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): an e-course start redeems its code with the payment`.

---

### Task 8: The invoice line, its PDF and CSV, and the contract's discount

**Files:**
- Modify:
  - `src/domain/invoice.ts`:
    - `InvoiceLine` gains `discount?: { code: string; listCents: number; cents: number }`;
    - `CSV_HEADER` (line ~423) appends „Sooduskood“, „Soodustus“ **at the end** (my call: the accountant's columns keep their places);
    - `invoiceCsv` writes `discount.code` and the cents in the CSV's own money format, empty without one.
  - `src/server/invoices.ts`:
    - `createInvoice`, `issueReceiptInTx` and `issueForPayment` freeze `discount`;
    - for a registration: `registrationDiscount(course, r) ?? undefined`;
    - for an e-course payment: `p.discountCode ? { code, listCents: p.amountCents + p.discountCents, cents: p.discountCents } : undefined`.
  - `src/server/invoice-pdf.ts renderInvoice` (163–185): when `line.discount` is set and the invoice's amount equals `listCents − cents`, it prints three rows: the course at `listCents`, „Sooduskood {code}“ at −cents, then „Kokku“. Otherwise it prints one small line under the part: „Hind {list} − sooduskood {code} {cents} = {total}“ (Draft; the total is `listCents − cents`). VAT is unchanged (it is split on the amount).
  - `src/domain/contract.ts`: `ContractFields` gains `discount?: string`, and `ContractInput` gains `discount?: { code: string; cents: number } | null`. `contractParts` sets `discount: input.discount ? `−${euro(cents)} (${code})` : ""`.
  - `src/server/contracts.ts`: `registrationContractFields` and `accessContractFields` pass `discount`.
  - `src/server/contract-pdf.ts:212`: a row „Soodustus“ after „Hind“ when `fields.discount` is not empty.
  - `src/i18n/dict/admin.ts:866`: `hind: "hind pärast sooduskoodi"`.
- Test:
  - `tests/unit/invoice-rules.test.ts`: `"the CSV ends with Sooduskood and Soodustus, empty for an old line"`;
  - `tests/unit/invoice-pdf.test.ts`: `"a whole-sum invoice prints the list, the code row and Kokku"` and `"a prepayment invoice prints one Hind − sooduskood = line"`;
  - `tests/unit/contract-rules.test.ts`: `"contractParts writes −35,00 € (TERE10) and an empty discount without a code"` and `"{hind} is the total and {ettemaks} its first part"` (T = 31500 half → "157,50 €");
  - `tests/unit/contract-pdf.test.ts`: `"the Koolitus block prints Soodustus after Hind"`;
  - `tests/db/invoices.test.ts`: `"settle's invoice of a discounted registration freezes the discount line"` and `"an e-course invoice's line carries the payment's code"`.
- [ ] **Step 1: Write the failing tests above.**
- [ ] **Step 2: Run** `npx vitest run tests/unit/invoice-rules.test.ts tests/unit/invoice-pdf.test.ts tests/unit/contract-rules.test.ts tests/unit/contract-pdf.test.ts tests/db/invoices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): the discount on the invoice, its CSV and the contract`.

---

### Task 9: The registration form's code field

**Files:**
- Create:
  - `src/components/site/useDiscountCode.ts`;
  - `src/components/site/DiscountField.tsx` (+ `DiscountField.module.css`).
- Modify:
  - `src/components/site/ContactRegister.tsx`:
    - the field goes under „Sõnum“, above „Tasumine“, in the group kind only;
    - the prop `financing: boolean` becomes `financingSwitch: { enabled: boolean; paymentsOn: boolean }`, and `financingOffered({ ...financingSwitch, priceCents: total })` is decided in the form;
    - a chosen järelmaks out of range falls to `"full"`, and `forms.payFinancingRange` shows under the choices;
    - the contract preview is filled with the total;
    - `onSubmit` awaits `discount.beforeSubmit()` and sets `discountCode`/`discountCents` on the FormData;
    - the action's error mapping passes `discountCode` to `discount.serverRefused(code)`.
  - `src/app/[locale]/(site)/koolitused/[slug]/page.tsx`: pass `financingSwitch` (from `readFinancingSettings` + payments on) and `t.discount`. The `contract.priceCents` stays the list price, and the form recomputes it.
  - `src/server/site-data.ts`: export what the page needs for `financingSwitch`, if `financingShown` hides it.
- Test: `tests/unit/contact-register-discount-dom.test.ts` (new; mocks `checkDiscountCode` beside `registerContact` in `vi.mock("@/server/actions/public")`); `tests/unit/contact-register-pay-dom.test.ts` (the new prop); `tests/unit/financing-rules.test.ts`: `"financingOffered on a discounted total under 100 € is false"` (spec §7's rule files).

**Interfaces:**
- Consumes: Task 5's `checkDiscountCode`, `CheckAnswer` and dict `discount`; Task 6's `discountCode` errors.
- Produces (Task 10 reuses both):
```ts
export type DiscountState = { typed: string; applied: Extract<CheckAnswer, { ok: true }> | null; error: { code: CheckError | SubmitCodeError; startsOn?: string } | null; checking: boolean };
export function useDiscountCode(o: { course: string; listCents: number }): DiscountState & {
  setTyped(v: string): void; apply(): Promise<void>; remove(): void;
  beforeSubmit(): Promise<{ send: true; code: string | null; discountCents: number | null } | { send: false }>;
  serverRefused(code: SubmitCodeError): Promise<void>;
  totalCents: number;
};
export function DiscountField(p: { state: ReturnType<typeof useDiscountCode>; t: DiscountTexts; locale: Locale; idPrefix: string }): JSX.Element;
export type DiscountTexts = /* the dict's `discount` section */;
```

**The hook's rules:**
- **Each `apply` carries a sequence number,** and only the latest answer is kept (Review Focus 1).
- **Enter in the field applies the code,** and does not submit the form.
- **Remembering:**
  - `sessionStorage` key `mslab-discount:<course>`, holding the applied code's text;
  - it is written on apply and cleared on remove;
  - on mount, a stored code is checked again: ok → applied, refused → the error and the list price;
  - every storage access is inside try/catch.
- **`beforeSubmit`:**
  - nothing typed and nothing applied → `{send:true, code:null, discountCents:null}`;
  - typed and not applied → `await apply()`, then ok → send with it, refused → `{send:false}`;
  - applied → send with it.
- **`serverRefused`:**
  - `person`: keep the code applied and show the error with the hint;
  - `changed`: re-check, re-apply on ok, and show `changed`;
  - the others: drop the code, re-check, and show what the check says (falling back to the submit's code).
- **The hint:** `codeHint(applied)` → `t.hintWelcome` / `hintFirst` / `hintReturning`. It stays visible under `person`.

- [ ] **Step 1: Write the failing DOM tests:**
  - `"Mul on sooduskood opens the field; Rakenda shows the line and Kokku"`;
  - `"Enter applies and does not submit"`;
  - `"Eemalda brings back the list price and clears the memory"`;
  - `"a second code replaces the first"`;
  - `"ignores a stale check answer"`: the first check resolves after the second, and the second's line shows;
  - `"järelmaks disappears under 100 € and the range line shows"` (list 11000, 10 % → the choice falls to „100% kohe“ and `payFinancingRange` is visible);
  - `"a code can add järelmaks when the list is over 5 000 €"`;
  - `"the inline contract shows the total"`;
  - `"a remembered code is applied again on load"` / `"a remembered code refused on load shows the list price"`;
  - `"works with sessionStorage throwing"` (a `getItem`/`setItem` that throws);
  - `"a typed code is applied by the submit and sent with its discount"` (the FormData has `discountCode` "PROOV-16" and `discountCents` "3500");
  - `"a typed code refused by the submit's check is not sent"`;
  - `"a person error keeps the hint visible"`;
  - `"changed checks again and shows the new total"`;
  - `"the individual request has no code field and sends no code"` (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run tests/unit/contact-register-discount-dom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook, the field, the form and the course page.
- [ ] **Step 4: Run** that file, plus `tests/unit/contact-register-pay-dom.test.ts`, `tests/unit/financing-rules.test.ts` and `tests/unit/old-safari.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): the code field on the group registration form`.

---

### Task 10: The cart's code field

**Files:**
- Modify:
  - `src/components/site/EcoursePurchase.tsx`:
    - `DiscountField` above the name;
    - „Kokku {total}“ is rendered here;
    - the submit text is built from a template `t.pay` („Maksa {amount}“) with the total, replacing the pre-filled `t.submit`;
    - `financingSwitch` replaces `financing`, with järelmaks decided on the total as in Task 9;
    - „Maksa“ awaits `beforeSubmit()`;
    - the `discountCode` errors are mapped.
  - `src/app/[locale]/(site)/ostukorv/cart.tsx`:
    - drop the `<p className={styles.total}>`, and pass `listCents: course.price`, `financingSwitch` and `t.pay = d.payment.pay`;
    - `contract.priceCents` stays the list price, and the purchase recomputes it.
- Test: `tests/unit/ecourse-purchase-dom.test.ts` (extend; add `checkDiscountCode` to its mock).

- [ ] **Step 1: Write the failing tests:**
  - `"Kokku and Maksa follow the applied code"` („Kokku 171 €“ and „Maksa 171 €“ for 190 € at 10 %);
  - `"Maksa with a typed code applies it first and sends discountCode and discountCents"`;
  - `"a refused typed code is not sent"`;
  - `"järelmaks is decided on the total"`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/ecourse-purchase-dom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above. Nothing about a code is rendered on the server (spec §4.5).
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): the code field and the total in the e-course cart`.

---

### Task 11: The welcome code's texts follow its row

**Files:**
- Modify:
  - `src/components/site/settings.ts`:
    - `NewsletterSettings = { discount: string | null }`;
    - `shellSettings(settings, locale, welcome: WelcomeCode | null)`.
  - `src/app/[locale]/(site)/layout.tsx`: `loadShellSettings` reads `welcomeCode(db, new Date())`.
  - `src/components/site/Footer.tsx`: `d.newsletter.body` with `{discount}`, or `d.newsletter.bodyNoCode` when it is null.
  - `src/server/newsletter.ts`: `sendWelcome` (lines ~74, 95) and `confirmNewsletter` (~171) read `welcomeCode(q, now)`.
  - `src/server/account-mail.ts`: `welcomeMail(email, welcome: { code: string; value: string; days: number | null } | null, locale, unsubscribeLink)`, with the lines `codeIntro`, `use`, `value` (`{soodustus}`) and `days`.
  - `src/app/[locale]/(site)/page.tsx:105`: `welcomeCode` → `(await welcomeCode(db, now)) !== null`.
  - `src/app/admin/(panel)/kampaania/page.tsx`: `code={(await welcomeCode(db, now)) !== null}`.
  - `src/server/cache-targets.ts`: `PublicChange` gains `{ kind: "welcomeCode" }` → `[EVERY_PAGE]`.
  - `src/i18n/dict/et.ts`/`ru.ts`: `mail.welcome.use` (new text), `mail.welcome.invoice` → renamed `value`, `newsletter.codeLine` (new text), and the new `newsletter.bodyNoCode`. The comments say the lines come from the welcome code's row.
- Test:
  - `tests/unit/shell-settings.test.ts`: `"the footer value is the welcome code's value, null without one"`;
  - `tests/unit/footer-texts.test.ts`: `"bodyNoCode without a welcome code"`;
  - `tests/db/newsletter-welcome.test.ts`: move off `settings.newsletter.welcomeCode` and insert the welcome row instead. Cases: `"the mail carries the code, the value and the days"`, `"no code lines while the welcome code is paused or ended"`, `"the confirmed page's fragment carries the code only while valid"`;
  - `tests/unit/newsletter-texts.test.ts`: the new ET/RU texts verbatim;
  - `tests/unit/cache-targets.test.ts`: `"welcomeCode revalidates every page"`;
  - `tests/db/queries.test.ts` and `tests/db/site-preview.test.ts`: their welcome-code reads move to the row.
- [ ] **Step 1: Write and move the tests above.**
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(discounts): the welcome mail, the confirmed page, the popup and the footer follow the welcome code`.

---

### Task 12: Hüpikaken and Seaded stop holding the welcome code

**Files:**
- Modify:
  - **Hüpikaken:**
    - `src/domain/site-entities.ts:74`: `PopupOfferValue` drops `discountPercent` and `codeDays`;
    - `src/domain/site-checks.ts:205-208`: drop the two `c.whole` checks;
    - `src/domain/site-changes.ts:58-59`: drop the two labels;
    - `src/server/admin-site.ts` (435–465, popupOfferPart): read and publish no `settings.newsletter`;
    - `src/components/admin/CampaignEditor.tsx`: drop the two fields;
    - `src/i18n/dict/admin.ts`: `campaign.codeDays` and the `popup` labels (~320) go, and `codeWhere` becomes „Tervituskoodi ja soodustust saad muuta lehel „Sooduskoodid“.“.
  - **Seaded:**
    - `SETTINGS_PARTS` → `["contact", "prepayment"]`, and `PATCHES.newsletter` and `FIELD_RULES.newsletter` go (`src/server/admin-site.ts` / `src/server/seaded.ts`, wherever they live);
    - `src/components/admin/SettingsEditor.tsx`: the `<Section id="uudiskiri">` and `NewsletterCard` go, `"uudiskiri"` leaves `SectionId`, and the hash effect (lines ~177–186) does `window.location.replace("/admin/sooduskoodid")` for `#uudiskiri` (R8).
  - `src/domain/welcome-code.ts`: delete `welcomeCodeOf`, `discountPercentOf`, `codeDaysOf` and `DEFAULT_DISCOUNT_PERCENT` once no reader remains (`grep -rn` proves it).
  - `src/components/admin/NewsletterCampaignEditor.tsx` / `SettingsEditor.tsx`: their `WELCOME_CODE_MAX` imports become `CODE_MAX`.
- Test (move off the setting):
  - `tests/db/admin-site.test.ts`, `tests/db/seaded-route.test.ts`, `tests/db/popup-drafts.test.ts`, `tests/db/actions.test.ts`, `tests/db/migration-0016.test.ts` (reads the old keys raw: keep as it is if it uses raw SQL);
  - `tests/unit/campaign-editor-page-dom.test.ts`, `settings-editor-dom.test.ts`, `site-changes.test.ts`, `site-checks.test.ts`, `welcome-code.test.ts` (only the fragment cases stay).
  - New in `popup-drafts.test.ts`: `"a stored draft with discountPercent and codeDays reads without them and its publish writes nothing to settings.newsletter"`.
  - New in `settings-editor-dom.test.ts`: `"#uudiskiri leads to /admin/sooduskoodid"`.
- [ ] **Step 1: Write and move the tests above.**
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run them,** plus `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `refactor(admin): Hüpikaken and Seaded no longer hold the welcome code`.

---

### Task 13: The admin page „Sooduskoodid“

**Files:**
- Create:
  - `src/domain/discount-code-fields.ts` (browser; add it to `BROWSER_FILES`);
  - `src/server/discount-code-admin.ts`;
  - `src/server/actions/admin-discounts.ts`;
  - `src/app/api/admin/sooduskood/[id]/route.ts`;
  - `src/app/admin/(panel)/sooduskoodid/page.tsx`;
  - `src/components/admin/DiscountCodeList.tsx`, `DiscountCodeDrawer.tsx` (+ `.module.css`).
- Modify:
  - `src/components/admin/sections.ts`: the `Section` gains `"codes"`; `SECTIONS` gets `{ key: "codes", href: "/admin/sooduskoodid", icon: "percent" }` after practice; `GROUPS.courses` gets `["courses", "calendar", "practice", "codes"]`; `BY_SEGMENT` gets `["sooduskoodid", "codes"]`.
  - `src/components/admin/AdminIcon.tsx`: `percent: ["M19 5 5 19", "M7.5 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z", "M16.5 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"]`.
  - `src/i18n/dict/admin.ts`: `nav.codes: "Sooduskoodid"`; a `discounts` section with every admin text of spec §5 (the page, fields, hints, choices, states, use marks, delete, UndoBar „Sooduskood peatatud.“); `fieldErrors` gains `codeRequired` „Kirjuta kood.“, `codeTaken` „Selline kood on juba olemas.“, `amountEuro` „Sisesta summa eurodes.“, `endBeforeStart` „Lõpp ei saa olla enne algust.“, `coursesRequired` „Vali vähemalt üks koolitus.“ and `codeUsed` „Kasutatud koodi ei saa muuta: loo uus kood.“, keeping `codeFormat`, `discountRange`, `whole` and `codeDaysRange`.
- Test: `tests/unit/discount-code-fields.test.ts`, `tests/db/discount-code-admin.test.ts`, `tests/unit/discount-code-drawer-dom.test.ts` (in the style of `settings-editor-dom.test.ts` / `session-form-dom.test.ts`), `tests/unit/admin-shell.test.ts` (the menu).

**Interfaces — Produces:**
```ts
// domain/discount-code-fields.ts
export const CODE_FIELDS = ["code", "kind", "percent", "amount", "scope", "courseIds", "startsOn", "endsOn", "maxUses", "audience", "oncePerPerson", "daysAfterSignup", "note"] as const;
export type CodeFields = { code: string; kind: "percent" | "euro"; percent: string; amount: string; scope: CodeScope; courseIds: number[]; startsOn: string; endsOn: string; maxUses: string; audience: Audience; oncePerPerson: boolean; daysAfterSignup: string; note: string };
export type CodeFieldError = "codeRequired" | "codeFormat" | "codeTaken" | "codeUsed" | "discountRange" | "whole" | "amountEuro" | "endBeforeStart" | "coursesRequired" | "codeDaysRange";
export function codeFieldProblems(v: CodeFields, at: { welcome: boolean }): Partial<Record<keyof CodeFields, CodeFieldError>>;   // codeTaken/codeUsed are decided by the server
// server/discount-code-admin.ts
export type CodeListRow = { id: number; code: string; welcome: boolean; value: string; scope: CodeScope; courses: number; startsOn: string | null; endsOn: string | null; uses: number; maxUses: number | null; state: CodeState };
export async function listCodes(q: Q, now: Date): Promise<CodeListRow[]>;                 // welcome first, then newest first; uses via countingUse grouped by code
export const CODE_PATCH: z.ZodType;                                                         // strict partial of CodeFields
export async function readCode(q: Q, id: number): Promise<{ version: string; value: CodeFields & { welcome: boolean; active: boolean; used: boolean } } | null>;  // version "k:<contentVersion hash>"
export async function writeCode(db: Db, id: number, patch: Record<string, unknown>, version: string, now: Date): Promise<SaveAnswer>;   // under lockCode; the welcome row's audience/oncePerPerson are not patchable
export async function createCode(db: Db, input: unknown, at: { welcome: boolean }, now: Date): Promise<{ ok: true; id: number; version: string } | { ok: false; error: "invalid"; fields: Record<string, string> }>;
export async function setCodeActive(db: Db, id: number, active: boolean, version: string): Promise<{ ok: true; version: string } | { ok: false; error: "stale" | "notFound" }>;
export async function deleteCode(db: Db, id: number): Promise<{ ok: true } | { ok: false; error: "used" | "notFound" }>;
export type CodeUse = { id: number; at: Date; name: string; course: string; cents: number; via: "form" | "cart" | "admin"; mark: UseMark; href: string | null };  // registration → /admin/registreerimised?id=<id>; payment → /admin/maksed?otsi=<reference>
export async function codeUses(q: Q, codeId: number, now: Date): Promise<CodeUse[]>;        // newest first
// server/actions/admin-discounts.ts — adminAction wrappers: createCodeAction, setCodeActiveAction, deleteCodeAction (+ Task 14's two)
```
- Every successful change refreshes `/admin/sooduskoodid`, and a welcome row's change also calls `revalidatePublic({ kind: "welcomeCode" })` (R9).
- The list's columns and their words follow spec §4.10 („Aeg“ „01.12.2026–07.12.2026“ or „Tähtajatu“; „Kasutatud“ „3 / 20“ or „3“; „Kehtib“ „Valitud koolitustele: {n}“). Every drawer text is spec §5's, the welcome row's hint „Juba saadetud tervituskirjades on vana kood.“ included.
- The route mirrors `src/app/api/admin/toimumine/[id]/route.ts` exactly (`withAdmin`, `parseRowId`, `autosaveHandler({ schema: CODE_PATCH, read, write })`, `maxDuration = 30`).
- The drawer:
  - mirrors `SessionForm.tsx`: `useNewRecord` for `?kood=uus` and `?kood=tervituskood` (R11), with an explicit „Lisa sooduskood“, then autosave;
  - the switch „Aktiivne“ acts at once with the UndoBar (pattern: `CampaignEditor.tsx pressSwitch`);
  - „Kustuta sooduskood“ behind a `ConfirmPanel` only when `used` is false, else the line „Koodi on kasutatud — kustutada ei saa. Peata see.“;
  - „Kasutused ({n})“ lists `codeUses`.

- [ ] **Step 1: Write the failing tests:**
  - **`discount-code-fields.test.ts`:**
    - `"each field error"`: percent 100 → `discountRange`; 7,5 → `whole`; amount "abc" → `amountEuro`; end before start → `endBeforeStart`; scope courses with none → `coursesRequired`; days 366 on the welcome row → `codeDaysRange`; "---" → `codeFormat` ("tere 10" is valid after R14's normalising); "" → `codeRequired`.
  - **Amendment tests (R16–R20), in the files below:**
    - admin: `"a one-field patch is checked over the stored row: scope courses with none chosen and euro with no amount are field errors"`; `"a one-field patch leaves the dates, scope and chosen courses alone"`; `"a euro amount above the highest list price in scope is amountTooHigh, re-checked when the scope narrows"`; `"deleteCode answers used when a booking committed first (23503)"`; `"a code whose only uses are cancelled or abandoned refuses delete with its own line"`; `"codeTaken carries the existing code's id"`; `"Soodustust kokku sums the counting uses only"`.
    - drawer DOM: `"switching Protsent to Eurod empties the value and sends nothing until a valid amount"`; `"a refused value (95 %) shows the error and sends no request"`; `"Aktiivne flips at once and rolls back when the server refuses"`; `"codeTaken shows Ava see kood linking to the existing code"`.
  - **`discount-code-admin.test.ts`:**
    - `"create, edit, pause and delete a code"`;
    - `"a second code of the same text is codeTaken"`;
    - `"a used code's text is refused codeUsed; its other values change for new bookings"`;
    - `"a used code cannot be deleted"`;
    - `"a stale version is 409"`;
    - `"listCodes puts the welcome code first, then the newest, with uses and state"`;
    - `"codeUses marks tühistatud, maksmata, makse pooleli, makse ebaõnnestus, tagastatud and lisas haldus"` (via `useMark`);
    - `"the welcome row's audience and once per person cannot be patched"`;
    - `"saving the welcome row revalidates every page; another code does not"` (a stub `changed`).
  - **`discount-code-drawer-dom.test.ts`:**
    - `"Uus sooduskood + opens a drawer with Lisa sooduskood"`;
    - `"Protsent and Eurod switch the field"`;
    - `"Valitud koolitustele shows the course checklist"`;
    - `"the welcome row shows its days field and the fixed rules text"`;
    - `"Aktiivne off shows Sooduskood peatatud. with Võta tagasi"`;
    - `"a used code shows no delete and the pause line"`.
  - **`admin-shell.test.ts`:** `"Sooduskoodid sits after Praktika in Koolitused"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run them,** plus `tests/unit/old-safari.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(admin): the Sooduskoodid page with its list, drawer and uses`.

---

### Task 14: „Lisa sooduskood“ on the Raha card (D11)

**Files:**
- Modify:
  - `src/server/discount-code-admin.ts`: add the two functions below.
  - `src/server/actions/admin-discounts.ts`: `addRegistrationDiscountAction` and `removeRegistrationDiscountAction`; on success, refresh the registrations page.
  - `src/components/admin/MoneyCard.tsx`: an optional `discountRow?: ReactNode` slot under the price.
  - `src/app/admin/(panel)/registreerimised/page.tsx`: render `<RegistrationDiscount …/>` into it, with the list price, the code and the total (spec §6 „The course price changes“).
  - `src/i18n/dict/admin.ts` `discounts.registration`: the §5 texts and R12's `worthless`.
- Create: `src/components/admin/RegistrationDiscount.tsx`.
- Test: `tests/db/discount-registration-admin.test.ts`, `tests/unit/registration-discount-dom.test.ts`, `tests/unit/money-card-dom.test.ts` (the slot).

**Interfaces — Produces:**
```ts
export type RegistrationDiscountError = "paid" | "unpaidInvoice" | "cancelled" | "unknown" | "stale" | "worthless";
export async function addRegistrationDiscount(db: Db, registrationId: number, typed: string, now: Date): Promise<{ ok: true } | { ok: false; error: RegistrationDiscountError }>;
export async function removeRegistrationDiscount(db: Db, registrationId: number): Promise<{ ok: true } | { ok: false; error: RegistrationDiscountError }>;
```
- **In one transaction:**
  1. `lockForPayment(tx, registrationId)` (its session and registration locks, then the redemption insert's key-share lock: D8's order);
  2. refuse `cancelled`, `paid` (`paid_cents > 0`) and `unpaidInvoice` (any unpaid invoice of the registration);
  3. add: `findCode` → `unknown`; a code already set → `stale`; `discountCents(code, list) === 0` → `worthless`;
  4. set `discount_cents`/`discount_code` and `insertRedemption({ via: "admin", registrationId, clientId: r.clientId })`.

  **No rules are checked** (§10 answer 2). Remove deletes the registration's redemption and zeroes both columns. No code set → `stale`.

- [ ] **Step 1: Write the failing tests:**
  - **`discount-registration-admin.test.ts`:**
    - `"Lisa sooduskood ignores the code's dates, limit, scope and person rules and counts the use"` (a paused, ended, used-up e-course-only code applies; `usesOf` +1);
    - `"refuses paid, unpaid invoice, cancelled and unknown"`;
    - `"Eemalda deletes the use and restores the list price"`;
    - `"the pay page and the next start charge the new total"` (`/maksa` amount = ceil(T/2) for „50%“).
  - **`registration-discount-dom.test.ts`:**
    - `"the row shows code · −amount"`;
    - `"Lisa sooduskood opens the field with Lisa"`;
    - `"Eemalda asks Kas eemaldan sooduskoodi? Hind on jälle {price}."`;
    - `"each refusal shows its text"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions, actions and component.
- [ ] **Step 4: Run them,** plus `tests/unit/money-card-dom.test.ts` and `tests/db/admin-registrations-page.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(admin): Maria adds or removes a code on an unpaid registration`.

---

### Task 15: The campaign editor's warning (D13) and the course editor's hint

**Files:**
- Modify:
  - `src/components/admin/NewsletterCampaignEditor.tsx`: a prop `activeCodes: readonly string[]`. Under „Kood“, while its normalised value is not empty and not in `activeCodes`, it shows „Sellist aktiivset sooduskoodi pole. Lisa see lehel „Sooduskoodid“, muidu kood ei tööta.“. The send is never blocked.
  - `src/components/admin/CampaignsPanel.tsx` and the `/admin/uudiskiri` page: pass the active codes (a small `activeCodeTexts(q, now)` in `discount-code-admin.ts`: active and valid today).
  - `src/i18n/dict/admin.ts`: `courseEditor.nextDiscountHint` (line ~1732) gains the sentence „Koodiga andes loo lehel „Sooduskoodid“ kood „Ainult varasematele õpilastele“.“, plus the warning text.
- Test: `tests/unit/campaign-editor-dom.test.ts`: `"an unknown code shows the warning and the send stays enabled"` and `"an active code shows none"`.
- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** `npx vitest run tests/unit/campaign-editor-dom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(admin): the campaign editor warns about a code that is not active`.

---

### Task 16: E2E specs (written, not run)

**Files:**
- Create: `tests/e2e/discount-race.spec.ts`, in the pattern of `tests/e2e/contracts-race.spec.ts` (`racePool`, `inFlight` from `tests/e2e/race.ts`; `handleRegistration` in-process on the pool; its own codes, deleted by exact code in `afterAll`, redemptions first).
  - `"two registrations of one address for two courses with the welcome code at the same moment: one gets it, the other is person"`.
  - `"the same address, same course, at the same moment: both get it"` (D7).
  - `"limit 1 with two addresses: one gets it, the other usedUp"`.
- Create: `tests/e2e/discount-codes.spec.ts` (with `fake-montonio.ts`; codes inserted via `onLocalDb`, `@example.test` addresses, exact cleanup; it does not touch the welcome row):
  - `"a registration with a code: Montonio's amount is the discounted prepayment"`;
  - `"a cart with a code: the amount and the invoice line"`;
  - `"Maria creates a code, it is used, and the count shows the use"`;
  - `"the järelmaks threshold follows the total"`.
- Modify: `tests/e2e/admin-site.spec.ts` (its welcome-code steps and the alias loop at ~1163 drop `#uudiskiri`, or assert it redirects), `tests/e2e/campaign.spec.ts` and `tests/e2e/gate.spec.ts`. They set the welcome code through a `discount_codes` welcome row (insert, then restore or delete exactly) instead of `settings.newsletter.welcomeCode`.
- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Type-check them** with `npx tsc --noEmit`. Expected: clean. Do not run Playwright.
- [ ] **Step 3: Commit**: `test(e2e): discount races, code flows, and the welcome row in the site specs`.

---

### Task 17: The test plan (spec §8)

**Files:**
- Modify: `src/data/testplan.json`.
- Test: `tests/unit/testplan-file.test.ts`. Also move its welcome-setting reference if it has one.

- [ ] **Step 1: Make the changes:**
  - **Add the 12 new items of §8** with `"mark": "new"` and `"markedAt": "deploy"`. Use the spec's ids, area, who, device, title and expect lines verbatim. Write the `steps`, `href`, `why`, `risk` and `writes` in the house style of the existing items (≤ 8 steps and ≤ 8 expect lines, each ≤ 20 words ending with a full stop).
  - **Redo or reword:**
    - `avalik-uudiskiri` and `kirjad-tervituskiri` → `reworded`;
    - `haldus-hupikaken`, `registreerimine-grupp`, `registreerimine-vorm-vead`, `ekursus-ost`, `ekursus-ostukorv-leping` and `registreerimine-arve-maksmiseks` → `redo`.

    Update their lines to the new behaviour.
  - **Remove** `haldus-seaded-uudiskiri` and `haldus-hupikaken-numbrid`.
  - **The „Enne alustamist“ note** names Proov 16–18 (16 registers with a code, 17 tests the welcome code, 18 buys an e-course with a code).
  - **The „Koristamine“ note** adds the two steps: pause each Proov code and write it in the check's note; Dim then deletes them, with their uses, by the exact code.
- [ ] **Step 2: Run** `npx vitest run tests/unit/testplan-file.test.ts`. Expected: PASS (`checkPlan` clean).
- [ ] **Step 3: Run the whole suite** (`npx vitest run > ../vitest.log 2>&1`), plus `npx tsc --noEmit` and `npm run lint`. Expected: all green.
- [ ] **Step 4: Commit**: `docs(testplan): discount codes checks, Proov 16–18 and their clean-up`.
