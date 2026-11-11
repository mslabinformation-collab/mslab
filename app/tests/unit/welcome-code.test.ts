import { describe, expect, test } from "vitest";
import { WELCOME_FRAGMENT, welcomeFragment } from "@/domain/welcome-code";

// F1 Task 12: the welcome code itself is the `welcome` row of discount_codes (domain/discount-codes.ts holds its shape and numbers); what is left
// here is the fragment the confirmation link's redirect carries to the home page.
describe("the welcome code's fragment (phase 2c)", () => {
  test("the confirmed page's fragment: kood=<CODE>, read back only in that shape", () => {
    expect(welcomeFragment("TERE10")).toBe("kood=TERE10");
    expect(WELCOME_FRAGMENT.exec("kood=TERE-10")?.[1]).toBe("TERE-10");
    expect(WELCOME_FRAGMENT.exec("kood=<script>")).toBeNull();
    expect(WELCOME_FRAGMENT.exec("kood=")).toBeNull();
  });
});
