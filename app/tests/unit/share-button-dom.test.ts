// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ShareButton } from "@/components/site/ShareButton";

// „Jaga koolitust“ in a browser-like document (happy-dom): a computer copies the course link and says so; a touch device opens the system
// share sheet; a share the browser refuses (Maria 10.11: on a computer nothing happened, Chrome on Windows answers NotAllowedError) falls
// back to the copy; closing the sheet (AbortError) does nothing.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T = { label: "Jaga koolitust", copied: "Koolituse link kopeeritud." };
const URL_NOW = "/koolitused/lash-lift-botox";

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn<(text: string) => Promise<void>>();
const share = vi.fn<(data: ShareData) => Promise<void>>();

/** The device: `touch` makes `(pointer: coarse)` match, as on a phone or a tablet. */
function device(touch: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
}

const toast = () => document.querySelector("[role='status']")?.textContent ?? "";
const press = async () => {
  await act(async () => {
    (document.querySelector("button") as HTMLButtonElement).click();
  });
  // the share's and the copy's promises settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(async () => {
  window.history.replaceState(null, "", `${URL_NOW}?fb=abc`);
  writeText.mockReset().mockResolvedValue(undefined);
  share.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ShareButton, { title: "Lash Lift BOTOX baaskoolitus", t: T })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("on a computer", () => {
  test("copies the course link without the query and says so, even where the browser has a share sheet", async () => {
    device(false);
    await press();
    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${URL_NOW}`);
    expect(toast()).toBe("Koolituse link kopeeritud.");
  });

  test("shows the link itself when the clipboard refuses", async () => {
    device(false);
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await press();
    expect(toast()).toBe(`${window.location.origin}${URL_NOW}`);
  });
});

describe("on a touch device", () => {
  test("opens the share sheet with the course's title and link, and copies nothing", async () => {
    device(true);
    await press();
    expect(share).toHaveBeenCalledWith({ title: "Lash Lift BOTOX baaskoolitus", url: `${window.location.origin}${URL_NOW}` });
    expect(writeText).not.toHaveBeenCalled();
    expect(toast()).toBe("");
  });

  test("a share the browser refuses copies the link instead and says so", async () => {
    device(true);
    share.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    await press();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${URL_NOW}`);
    expect(toast()).toBe("Koolituse link kopeeritud.");
  });

  test("closing the share sheet does nothing", async () => {
    device(true);
    share.mockRejectedValue(new DOMException("Share canceled", "AbortError"));
    await press();
    expect(writeText).not.toHaveBeenCalled();
    expect(toast()).toBe("");
  });

  test("without a share sheet copies the link", async () => {
    device(true);
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    await press();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${URL_NOW}`);
    expect(toast()).toBe("Koolituse link kopeeritud.");
  });
});
