import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

// The review tools in the admin (Dim 22.10): while NEXT_PUBLIC_REVIEW_TOOLS is "1" (next.config.ts), the signed-in admin's layout (app/admin/(panel))
// loads the comment bubble (public/feedback.js) on every signed-in admin page, and the admin's root layout says "admin" for the bubble's `dir`;
// switched off ("0", the launch), the admin carries nothing of it. NOT on /admin/login or any other signed-out admin page (fix round 1): while the
// gate is on a signed-out visitor has no preview cookie, so a comment sent there could never arrive. The site's layout loads the same script under
// the same switch (e2e/feedback.spec.ts checks the pages themselves).

vi.mock("@/app/fonts", () => ({ fontVariables: "font-vars" }));
// the panel layout asks for the session first; the shell is a server component of its own (it reads the menu's counts), and is not needed here
const requireAdmin = vi.hoisted(() => vi.fn(async () => "maria@example.test"));
vi.mock("@/server/auth", () => ({ requireAdmin }));
vi.mock("@/components/admin/Shell", () => ({ Shell: () => null }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  requireAdmin.mockReset();
  requireAdmin.mockImplementation(async () => "maria@example.test");
});

type Tree = ReactElement<{ children?: ReactNode } & Record<string, unknown>>;

/** The admin root layout as it is with NEXT_PUBLIC_REVIEW_TOOLS set to `switchValue` (read when the module loads, as the build inlines it). */
async function rootLayoutWith(switchValue: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_REVIEW_TOOLS", switchValue as string);
  vi.resetModules();
  const { default: AdminRootLayout } = await import("@/app/admin/layout");
  return AdminRootLayout({ children: null }) as Tree;
}

/** The signed-in panel layout, likewise. */
async function panelLayoutWith(switchValue: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_REVIEW_TOOLS", switchValue as string);
  vi.resetModules();
  const { default: PanelLayout } = await import("@/app/admin/(panel)/layout");
  return PanelLayout({ children: null }) as Promise<Tree>;
}

/** Every element of a React tree (the tree a layout returns: elements of host and function components, not rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node as ReactElement<Record<string, unknown>>, ...elements(props.children)];
}

const scripts = (root: ReactElement) => elements(root).filter((e) => typeof e.props.src === "string" && String(e.props.src).includes("feedback.js"));

describe("the signed-in admin layout and the comment bubble", () => {
  test("switch on: the script is loaded once, after the shell, with the address the site's layout uses", async () => {
    const tree = await panelLayoutWith("1");
    const found = scripts(tree);
    expect(found).toHaveLength(1);
    expect(found[0].props.src).toBe("/feedback.js?v=7");
    expect(found[0].props.strategy).toBe("afterInteractive");
    // after the page and its shell (the page is there before the bubble)
    expect([tree.props.children].flat().at(-1)).toBe(found[0]);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  test.each([["0"], [""], [undefined], ["true"]])("switch %j: no script", async (value) => {
    expect(scripts(await panelLayoutWith(value))).toHaveLength(0);
  });

  test("a signed-out visitor never gets the layout, so never the script (requireAdmin sends them to /admin/login)", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(panelLayoutWith("1")).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("the admin's root layout (the login page's too) and the comment bubble", () => {
  test.each([["1"], ["0"], [undefined]])("switch %j: carries no script: /admin/login and the other signed-out pages have no bubble", async (value) => {
    expect(scripts(await rootLayoutWith(value))).toHaveLength(0);
  });

  test("switch on: <html> says the comments are the admin's (data-fb-dir), and is still the admin's html (lang, data-admin)", async () => {
    const html = await rootLayoutWith("1");
    expect(html.type).toBe("html");
    expect(html.props["data-fb-dir"]).toBe("admin");
    expect(html.props["data-admin"]).toBe("");
    expect(html.props.lang).toBe("et");
  });

  test.each([["0"], [""], [undefined], ["true"]])("switch %j: no data-fb-dir", async (value) => {
    const html = await rootLayoutWith(value);
    expect(html.props["data-fb-dir"]).toBeUndefined();
    expect(html.props["data-admin"]).toBe(""); // (everything else of the admin's html stays)
  });

  test("the login page itself does not load it either", () => {
    expect(readFileSync(join(process.cwd(), "src", "app", "admin", "login", "page.tsx"), "utf8")).not.toContain("feedback.js");
  });
});

describe("one place for the script's address and the switch", () => {
  test("the site's layout and the admin's panel layout load the script from lib/review-tools.ts under the same switch", () => {
    const site = readFileSync(join(process.cwd(), "src", "app", "[locale]", "(site)", "layout.tsx"), "utf8");
    const panel = readFileSync(join(process.cwd(), "src", "app", "admin", "(panel)", "layout.tsx"), "utf8");
    for (const source of [site, panel]) {
      expect(source).toContain("REVIEW_TOOLS");
      expect(source).toContain("FEEDBACK_SCRIPT");
      expect(source).not.toContain("feedback.js?v="); // the address is written once
    }
    // the root layout of the admin only labels the comments; the script is not there
    const root = readFileSync(join(process.cwd(), "src", "app", "admin", "layout.tsx"), "utf8");
    expect(root).not.toContain("FEEDBACK_SCRIPT");
    expect(root).not.toContain("next/script");
  });
});
