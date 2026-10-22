// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DIRS } from "@/server/feedback";

// public/feedback.js, the review comment bubble, run in a browser-like document: which `dir` a comment carries (the prototype's letter, "hub",
// "site" for the main site and, since Dim 22.10, "admin" for the admin's pages), and what it sends with it. The script is a plain browser file
// (not a module), so it is run here as the browser runs it: a classic script, once per page.

const SCRIPT = readFileSync(join(process.cwd(), "public", "feedback.js"), "utf8");

type Payload = { dir: string; route?: string; title?: string; text: string };

let sent: Payload[];

/** Opens `path` (with `html` attributes) as a page and runs the widget on it. */
function openPage(path: string, htmlAttributes: Record<string, string> = {}) {
  history.pushState({}, "", path);
  for (const [name, value] of Object.entries(htmlAttributes)) document.documentElement.setAttribute(name, value);
  document.title = "Koolitused — MS LAB Koolituskeskus";
  (0, eval)(SCRIPT); // (indirect eval: the script's own global scope, like a <script> tag)
}

/** Writes `text` in the bubble's panel and presses „Saada“; the payload that went to /api/feedback. */
async function comment(text: string): Promise<Payload> {
  document.querySelector<HTMLButtonElement>("#mslab-fb .fb-fab")!.click();
  const area = document.querySelector<HTMLTextAreaElement>("#mslab-fb textarea")!;
  area.value = text;
  document.querySelector<HTMLButtonElement>("#mslab-fb .fb-send")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Payload);
      return new Response(JSON.stringify({ ok: true, id: "abc123def456gh" }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  delete (window as unknown as { __mslabFeedback?: boolean }).__mslabFeedback;
  document.getElementById("mslab-fb")?.remove();
  for (const style of [...document.head.querySelectorAll("style")]) style.remove();
  document.documentElement.removeAttribute("data-fb-dir");
  document.documentElement.removeAttribute("data-admin");
  localStorage.clear();
  history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("the comment bubble's direction (dir)", () => {
  test("an admin page (the root layout says so with data-fb-dir) sends dir admin and its path", async () => {
    openPage("/admin/koolitused", { "data-admin": "", "data-fb-dir": "admin" });
    expect(await comment("Nupp võiks olla suurem")).toMatchObject({ dir: "admin", route: "/admin/koolitused", text: "Nupp võiks olla suurem" });
  });

  test("the admin's login page too (same root layout)", async () => {
    openPage("/admin/login", { "data-admin": "", "data-fb-dir": "admin" });
    expect(await comment("Sisselogimise leht")).toMatchObject({ dir: "admin", route: "/admin/login" });
  });

  test("a main-site page still sends dir site and its path (nothing marks it)", async () => {
    openPage("/koolitused");
    expect(await comment("Pealkiri")).toMatchObject({ dir: "site", route: "/koolitused" });
  });

  test("a prototype keeps its letter and its hash route, and the hub stays the hub", async () => {
    openPage("/p/d/#/koolitused");
    expect(await comment("Prototüüp")).toMatchObject({ dir: "d", route: "#/koolitused" });
  });

  test("the hub", async () => {
    openPage("/guide/");
    expect((await comment("Juhend")).dir).toBe("hub");
  });

  test("the bubble is the same button on every page: 'Kommentaar'", () => {
    openPage("/admin", { "data-fb-dir": "admin" });
    expect(document.querySelector("#mslab-fb .fb-fab")!.textContent).toBe("Kommentaar");
    expect(document.querySelector("#mslab-fb .fb-fab")!.getAttribute("aria-label")).toBe("Jäta kommentaar");
  });
});

describe("the comment list page (/guide/tagasiside/)", () => {
  test("names every direction the server knows, 'admin' included (no raw key on a comment's card)", () => {
    const html = readFileSync(join(process.cwd(), "public", "guide", "tagasiside", "index.html"), "utf8");
    const map = /var DIRS = \{([^}]*)\}/.exec(html)![1];
    const listed = Object.fromEntries([...map.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(listed).sort()).toEqual(Object.keys(DIRS).sort());
    expect(listed.admin).toBe(DIRS.admin);
  });
});
