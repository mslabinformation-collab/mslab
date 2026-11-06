import { describe, expect, test } from "vitest";
import { isIban, normalizeIban } from "@/domain/site-editor";

describe("isIban (Seaded → Maksmine, 05.11 test run)", () => {
  test("real IBANs pass, typed with spaces and in lower case", () => {
    for (const typed of ["EE38 2200 2210 2014 5685", "ee382200221020145685", "LT12 1000 0111 0100 1000", "FI21 1234 5600 0007 85", "LV80 BANK 0000 4351 9500 1", "DE89 3704 0044 0532 0130 00"])
      expect(isIban(normalizeIban(typed)), typed).toBe(true);
  });

  test("a typo in a digit, swapped digits, a wrong check pair or a wrong length for the country fail", () => {
    for (const typed of ["EE38 2200 2210 2014 5686", "EE38 2200 2210 2014 6585", "EE00 2200 2210 2014 5685", "EE38 2200 2210 2014 5685 1", "EE38 2200 2210 2014 568"])
      expect(isIban(normalizeIban(typed)), typed).toBe(false);
  });

  test("the shape still decides first: no country letters, too short, other characters", () => {
    for (const typed of ["38EE2200221020145685", "EE38", "EE38 2200-2210", "ЕЕ382200221020145685"]) expect(isIban(normalizeIban(typed)), typed).toBe(false);
  });

  test("a country the list does not know is checked by the checksum alone", () => {
    expect(isIban("CH9300762011623852957")).toBe(true);
    expect(isIban("CH9300762011623852958")).toBe(false);
  });
});
