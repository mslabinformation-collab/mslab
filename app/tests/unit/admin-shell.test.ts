import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { menuOf } from "@/components/admin/menu";
import { Shell } from "@/components/admin/Shell";
import { emptyCounts } from "@/db/queries/admin";

// The admin shell's first paint (final review, I1): the menu's badge counts are one database read in the layout above every admin page, and a
// layout's error is not caught by the (panel)'s error.tsx. A count that cannot be read must cost the badges only: the failure is logged
// (logFailure: the class and code, never the message), the menu is painted with every badge at zero, and the page below it still renders.

const mocks = vi.hoisted(() => ({ getAdminCounts: vi.fn() }));
vi.mock("@/components/admin/data", () => ({ getAdminCounts: mocks.getAdminCounts }));
// the sidebar reads the address and the shell the signed-in admin's first name (the environment); neither is the point here
vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
vi.mock("@/server/auth", () => ({ adminName: () => "Maria" }));

const EMAIL = "maria@example.test";

/** The shell as the layout renders it, round a one-line page. */
async function paint(): Promise<string> {
  const tree = await Shell({ email: EMAIL, children: createElement("p", { id: "page" }, "Lehe sisu") });
  return renderToStaticMarkup(tree);
}

/** The menu keys that carry a badge (the sidebar draws its list twice, in the column and in the phone's drawer). */
const badges = (html: string) => [...new Set(html.match(/data-badge="[a-z]+"/g) ?? [])];

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.getAdminCounts.mockReset();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Shell", () => {
  it("paints the badges it was given (the control: without a failure the numbers are there)", async () => {
    mocks.getAdminCounts.mockResolvedValue({ ...emptyCounts(), awaitingPrepayment: 3, ownFaults: 2 });
    const html = await paint();
    expect(badges(html)).toEqual(['data-badge="registrations"', 'data-badge="testing"']);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a count that cannot be read costs the badges only: the menu and the page render, every badge is at zero", async () => {
    mocks.getAdminCounts.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const html = await paint();
    expect(html).toContain('data-admin-menu=""'); // the sidebar is there
    expect(html).toContain('<p id="page">Lehe sisu</p>'); // and so is the page
    expect(badges(html)).toEqual([]);
    expect(html).not.toContain("data-admin-today"); // no „Täna“ card either
  });

  it("a read that throws before it returns a promise (no database configured) is handled the same way", async () => {
    mocks.getAdminCounts.mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });
    const html = await paint();
    expect(html).toContain('<p id="page">Lehe sisu</p>');
    expect(badges(html)).toEqual([]);
  });

  it("logs the failure through logFailure: the place and the error class, never the message or the signed-in e-mail", async () => {
    const e = Object.assign(new Error(`select … where email = '${EMAIL}' failed: password authentication failed for user "mslab"`), { code: "28P01" });
    mocks.getAdminCounts.mockRejectedValue(e);
    await paint();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("admin shell: menu counts unavailable: Error (code 28P01)");
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain("mslab");
  });
});

describe("emptyCounts", () => {
  it("is the menu with nothing waiting, and a fresh object every time (nothing shared to be changed by accident)", () => {
    expect(menuOf(emptyCounts())).toEqual({ badges: {}, hrefs: {}, total: 0, today: null });
    const a = emptyCounts();
    a.openRequests.contact = 5;
    a.todaySessions.push({ id: 1, startsAt: new Date(), course: "K" });
    expect(emptyCounts().openRequests.contact).toBe(0);
    expect(emptyCounts().todaySessions).toEqual([]);
  });
});
