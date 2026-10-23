import { describe, expect, test } from "vitest";
import { unbilledSummary } from "@/components/admin/uninvoiced-summary";

// The strip's summary line (README A6, the Part 2 prototype: „Tasutud, aga arve puudub · 1 325,00 € · Merilin Kuusk, Kati Kask, Mari Tamm ja 3 teist“):
// what they are, their total, and the first payers — all of them up to four, else three and „ja {n} teist“ (no „ja 1 teist“: the prototype draws
// no form for one other).

const NBSP = " ";
const pay = (name: string, amountCents: number) => ({ name, amountCents });

describe("unbilledSummary", () => {
  test("the prototype's: six payments, three names and „ja 3 teist“, the total with its thousands grouped", () => {
    const six = [pay("Merilin Kuusk", 17500), pay("Kati Kask", 17500), pay("Mari Tamm", 22000), pay("A B", 35000), pay("C D", 35000), pay("E F", 5500)];
    expect(unbilledSummary(six)).toBe(`Tasutud, aga arve puudub · 1${NBSP}325,00${NBSP}€ · Merilin Kuusk, Kati Kask, Mari Tamm ja 3 teist`);
  });

  test("one to four payers are all named, in the order given", () => {
    expect(unbilledSummary([pay("Kati Tamm", 17500)])).toBe(`Tasutud, aga arve puudub · 175,00${NBSP}€ · Kati Tamm`);
    expect(unbilledSummary([pay("Kati Tamm", 17500), pay("Mari Kask", 17500)])).toBe(`Tasutud, aga arve puudub · 350,00${NBSP}€ · Kati Tamm, Mari Kask`);
    const four = ["A", "B", "C", "D"].map((n) => pay(n, 100));
    expect(unbilledSummary(four)).toBe(`Tasutud, aga arve puudub · 4,00${NBSP}€ · A, B, C, D`);
  });

  test("five payers: three names and „ja 2 teist“", () => {
    const five = ["A", "B", "C", "D", "E"].map((n) => pay(n, 100));
    expect(unbilledSummary(five)).toBe(`Tasutud, aga arve puudub · 5,00${NBSP}€ · A, B, C ja 2 teist`);
  });

  test("a payer with two payments is named once, and counted once among the others", () => {
    const twice = [pay("Kati Tamm", 17500), pay("Kati Tamm", 17500), pay("Mari Kask", 17500)];
    expect(unbilledSummary(twice)).toBe(`Tasutud, aga arve puudub · 525,00${NBSP}€ · Kati Tamm, Mari Kask`);
    const many = [...["A", "B", "C", "D", "E"].map((n) => pay(n, 100)), pay("A", 100)];
    expect(unbilledSummary(many)).toBe(`Tasutud, aga arve puudub · 6,00${NBSP}€ · A, B, C ja 2 teist`);
  });
});
