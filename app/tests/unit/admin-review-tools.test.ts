import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

// The review tools in the admin (Dim 22.10): while NEXT_PUBLIC_REVIEW_TOOLS is "1" (next.config.ts), the admin's root layout loads the comment bubble
// (public/feedback.js) on every admin page, the login page included, and says "admin" for the bubble's `dir`; switched off ("0", the launch), the
// admin carries nothing of it. The site's layout loads the same script under the same switch (e2e/feedback.spec.ts checks the pages themselves).

vi.mock("@/app/fonts", () => ({ fontVariables: "font-vars" }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The admin root layout as it is with NEXT_PUBLIC_REVIEW_TOOLS set to `switchValue` (read when the module loads, as the build inlines it). */
async function layoutWith(switchValue: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_REVIEW_TOOLS", switchValue as string);
  vi.resetModules();
  const { default: AdminRootLayout } = await import("@/app/admin/layout");
  return AdminRootLayout({ children: null }) as ReactElement<{ children?: ReactNode } & Record<string, unknown>>;
}

/** Every element of a React tree (the tree a layout returns: elements of host and function components, not rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node as ReactElement<Record<string, unknown>>, ...elements(props.children)];
}

const scripts = (root: ReactElement) => elements(root).filter((e) => typeof e.props.src === "string" && String(e.props.src).includes("feedback.js"));

describe("the admin's root layout and the comment bubble", () => {
  test("switch on: the script is loaded once, after the page, with the same address the site's layout uses", async () => {
    const html = await layoutWith("1");
    const found = scripts(html);
    expect(found).toHaveLength(1);
    expect(found[0].props.src).toBe("/feedback.js?v=6");
    expect(found[0].props.strategy).toBe("afterInteractive");
    // inside <body>, after the children (the page is there before the bubble)
    const body = elements(html).find((e) => e.type === "body")!;
    const kids = [body.props.children].flat() as ReactNode[];
    expect(kids.at(-1)).toBe(found[0]);
  });

  test("switch on: <html> says the comments are the admin's (data-fb-dir), and is still the admin's html (lang, data-admin)", async () => {
    const html = await layoutWith("1");
    expect(html.type).toBe("html");
    expect(html.props["data-fb-dir"]).toBe("admin");
    expect(html.props["data-admin"]).toBe("");
    expect(html.props.lang).toBe("et");
  });

  test.each([["0"], [""], [undefined], ["true"]])("switch %j: no script and no data-fb-dir", async (value) => {
    const html = await layoutWith(value);
    expect(scripts(html)).toHaveLength(0);
    expect(html.props["data-fb-dir"]).toBeUndefined();
    expect(html.props["data-admin"]).toBe(""); // (everything else of the admin's html stays)
  });

  test("the site's layout loads the script from the same place under the same switch", () => {
    const site = readFileSync(join(process.cwd(), "src", "app", "[locale]", "(site)", "layout.tsx"), "utf8");
    const admin = readFileSync(join(process.cwd(), "src", "app", "admin", "layout.tsx"), "utf8");
    for (const source of [site, admin]) {
      expect(source).toContain("REVIEW_TOOLS");
      expect(source).toContain("FEEDBACK_SCRIPT");
    }
    expect(site).not.toContain("feedback.js?v="); // the address is written once (lib/review-tools.ts)
    expect(admin).not.toContain("feedback.js?v=");
  });
});
