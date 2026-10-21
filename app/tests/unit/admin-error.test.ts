// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminError from "@/app/admin/error";
import PanelError from "@/app/admin/(panel)/error";
import { adminEt } from "@/i18n/dict/admin";

// app/admin/error.tsx (final review, I1): a layout's error is not caught by (panel)/error.tsx, so the admin root has its own boundary. It says what
// the panel's says (adminEt.panel) and retries the same way: ask the server again (router.refresh), then reset().

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let container: HTMLDivElement;
let root: Root;
const reset = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router.refresh.mockReset();
  reset.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const draw = (component: typeof AdminError) => act(async () => root.render(createElement(component, { error: new Error("x"), reset })));

describe("app/admin/error.tsx", () => {
  it("is a client component (Next requires it) next to the admin root layout", () => {
    expect(readFileSync("src/app/admin/error.tsx", "utf8")).toMatch(/^"use client";/);
  });

  it("shows the panel's error title, body and retry, as an alert", async () => {
    await draw(AdminError);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert).not.toBeNull();
    const t = adminEt.panel;
    expect(alert.querySelectorAll("p")[0].textContent).toBe(t.errorTitle);
    expect(alert.querySelectorAll("p")[1].textContent).toBe(t.errorBody);
    expect(alert.querySelector("button")!.textContent).toBe(t.errorRetry);
    // the same words as the panel's own boundary
    await draw(PanelError as typeof AdminError);
    expect(container.textContent).toBe(`${t.errorTitle}${t.errorBody}${t.errorRetry}`);
  });

  it("the retry asks the server for the page again and then resets the boundary", async () => {
    await draw(AdminError);
    await act(async () => void container.querySelector("button")!.click());
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(router.refresh.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
  });
});
