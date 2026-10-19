// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CONTACTS_WARN_AT, RESEND_FREE_CONTACTS } from "@/domain/newsletter-campaign";
import type { FullSyncReport } from "@/server/resend-marketing";

// The sync part above Maria's „Uudiskiri“ list (newsletter campaigns, Task 3; spec D2, D8, §5; rulings on the keys and on the real count) in a
// browser-like document (happy-dom), with the server action answered here: without the newsletter's key only the not-set-up text (no button, no
// count); with it the button, Resend's own count beside the site's (the site's alone when Resend does not answer), the warning from 900 contacts and
// the limit line, both on the larger of the two counts; the press (busy, one press at a time), and the answer shown until the page is left: the
// report's one line with a line each for what needs saying, or the refusal in words (the key that can only send is told apart from Resend being down).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ fullSyncAction: vi.fn() }));
vi.mock("@/server/actions/admin-newsletter", () => actions);

import { NewsletterSync } from "@/components/admin/NewsletterSync";
import type { SyncState } from "@/server/newsletter-admin";

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const text = (selector: string) => $(selector)?.textContent ?? null;
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (state: SyncState) => {
  await act(async () => root.render(createElement(NewsletterSync, { state })));
  await settle();
};
const press = async () => {
  await act(async () => {
    $<HTMLButtonElement>("[data-sync-run]")!.click();
  });
  await settle();
};

const ON = (over: Partial<Extract<SyncState, { configured: true }>> = {}): SyncState => ({ configured: true, resend: 12, site: 10, missing: 0, ...over });
const REPORT: FullSyncReport = { contacts: 12, added: 2, updated: 1, removed: 1, unsubscribedPulled: 3, suppressed: 0, unsynced: 0, failed: 0, limitReached: false, finished: true };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  actions.fullSyncAction.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("without the newsletter's key", () => {
  test("only the not-set-up text: no button, no count, no warning", async () => {
    await show({ configured: false });
    expect(text("[data-sync-off]")).toBe("Resendi uudiskirja saatmine pole veel seadistatud.");
    expect($("button")).toBeNull();
    for (const hook of ["[data-sync-run]", "[data-sync-resend]", "[data-sync-site]", "[data-sync-warning]", "[data-sync-limit]", "[data-sync-status]"]) expect($(hook), hook).toBeNull();
    expect(container.textContent).not.toContain("Sünkrooni Resendiga");
  });
});

describe("the counts", () => {
  test("Resend's own count against the free plan's 1000, and the site's synced count beside it", async () => {
    await show(ON({ resend: 14, site: 12 }));
    expect(text("[data-sync-resend]")).toBe("Resendis 14 kontakti (tasuta pakett: 1000)");
    expect(text("[data-sync-site]")).toBe("Sünkroonitud tellijaid: 12");
    expect(RESEND_FREE_CONTACTS).toBe(1000);
  });

  test("Resend not answering (no count): the site's count alone, with the plan's limit", async () => {
    await show(ON({ resend: null, site: 12 }));
    expect($("[data-sync-resend]")).toBeNull();
    expect(text("[data-sync-site]")).toBe("Sünkroonitud tellijaid: 12 (tasuta pakett: 1000)");
  });

  test("zero is a count: 0 contacts in Resend is said, not left out", async () => {
    await show(ON({ resend: 0, site: 0 }));
    expect(text("[data-sync-resend]")).toBe("Resendis 0 kontakti (tasuta pakett: 1000)");
  });
});

describe("the warning from 900 contacts (spec D8) and the limit line (spec §5)", () => {
  const WARNING = "Resendi tasuta paketis on 1000 kontakti. Üle selle on vaja tasulist paketti.";

  test("no warning at 899; the spec's words at 900", async () => {
    expect(CONTACTS_WARN_AT).toBe(900);
    await show(ON({ resend: 899, site: 899 }));
    expect($("[data-sync-warning]")).toBeNull();
    await show(ON({ resend: 900, site: 10 }));
    expect(text("[data-sync-warning]")).toBe(WARNING);
  });

  test.each([
    ["Resend's count is the larger", { resend: 950, site: 100 }],
    ["the site's count is the larger", { resend: 100, site: 950 }],
    ["Resend does not answer: the site's count", { resend: null, site: 950 }],
  ])("the warning goes by the larger of the two counts: %s", async (_name, counts) => {
    await show(ON(counts));
    expect(text("[data-sync-warning]")).toBe(WARNING);
  });

  test("no warning when neither count reaches 900, whatever is missing", async () => {
    await show(ON({ resend: 899, site: 100, missing: 5 }));
    expect($("[data-sync-warning]")).toBeNull();
    expect($("[data-sync-limit]")).toBeNull();
  });

  test("the limit line when the plan is full and subscribers wait for a place: their number, in the spec's words", async () => {
    await show(ON({ resend: 1000, site: 990, missing: 4 }));
    expect(text("[data-sync-limit]")).toBe("4 tellijat ei ole Resendis — kontaktide piir on täis.");
    // by the larger of the two: Resend's count is short of the plan here, the site's is not
    await show(ON({ resend: 700, site: 1000, missing: 2 }));
    expect(text("[data-sync-limit]")).toBe("2 tellijat ei ole Resendis — kontaktide piir on täis.");
  });

  test("no limit line at 999, nor when the plan is full and nobody waits", async () => {
    await show(ON({ resend: 999, site: 999, missing: 3 }));
    expect($("[data-sync-limit]")).toBeNull();
    await show(ON({ resend: 1000, site: 1000, missing: 0 }));
    expect($("[data-sync-limit]")).toBeNull();
  });
});

describe("the press", () => {
  test("the button is „Sünkrooni Resendiga“; a press asks the action once and shows that it works until the answer", async () => {
    let answer!: (r: FullSyncReport) => void;
    actions.fullSyncAction.mockReturnValue(new Promise<FullSyncReport>((resolve) => (answer = resolve)));
    await show(ON());
    const button = $<HTMLButtonElement>("[data-sync-run]")!;
    expect(button.textContent).toBe("Sünkrooni Resendiga");
    expect(button.type).toBe("button");
    await press();
    expect(actions.fullSyncAction).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("Sünkroonin…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(text("[data-sync-status]")).toBe("Sünkroonin…");
    // a second press while it works does nothing
    await press();
    expect(actions.fullSyncAction).toHaveBeenCalledTimes(1);
    await act(async () => answer(REPORT));
    await settle();
    expect(button.textContent).toBe("Sünkrooni Resendiga");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(text("[data-sync-status]")).not.toContain("Sünkroonin…");
  });

  test("the report: one line with what was added, taken out and pulled back from Resend; nothing else when nothing else happened", async () => {
    actions.fullSyncAction.mockResolvedValue(REPORT);
    await show(ON());
    expect($("[data-sync-status]")?.textContent).toBe("");
    await press();
    expect(text("[data-sync-report]")).toBe("2 lisatud, 1 eemaldatud, 3 loobus Resendis");
    for (const hook of ["[data-sync-report-suppressed]", "[data-sync-report-failed]", "[data-sync-unfinished]", "[data-sync-error]", "[data-sync-limit]"]) expect($(hook), hook).toBeNull();
    expect($("[data-sync-status]")?.getAttribute("role")).toBe("status");
  });

  test("blocked addresses and failed contacts get a line of their own when there are some", async () => {
    actions.fullSyncAction.mockResolvedValue({ ...REPORT, suppressed: 2, failed: 3 });
    await show(ON());
    await press();
    expect(text("[data-sync-report-suppressed]")).toBe("Resend ei saada kirju 2 tellija aadressile (tagastus või rämpspostiks märgitud).");
    expect(text("[data-sync-report-failed]")).toBe("3 kontakti sünkroonimine ebaõnnestus, järgmine sünkroonimine proovib uuesti.");
  });

  test("a sync that did not finish says it goes on next time; a finished one does not", async () => {
    actions.fullSyncAction.mockResolvedValue({ ...REPORT, finished: false, unsynced: 4 });
    await show(ON());
    await press();
    expect(text("[data-sync-unfinished]")).toBe("Sünkroonimine jätkub järgmisel korral.");
    expect(text("[data-sync-report]")).toBe("2 lisatud, 1 eemaldatud, 3 loobus Resendis");
    actions.fullSyncAction.mockResolvedValue(REPORT);
    await press();
    expect($("[data-sync-unfinished]")).toBeNull();
  });

  test("a sync that hit the plan's limit shows the limit line with the rows it left out, even though the page's own counts are short of it", async () => {
    actions.fullSyncAction.mockResolvedValue({ ...REPORT, limitReached: true, unsynced: 7, contacts: 1000 });
    await show(ON({ resend: 300, site: 300, missing: 0 }));
    expect($("[data-sync-limit]")).toBeNull();
    await press();
    expect(text("[data-sync-limit]")).toBe("7 tellijat ei ole Resendis — kontaktide piir on täis.");
    expect(container.querySelectorAll("[data-sync-limit]")).toHaveLength(1);
  });

  test("the refresh after a sync brings new counts to the same component: the report stays until the page is left", async () => {
    actions.fullSyncAction.mockResolvedValue(REPORT);
    await show(ON({ resend: 10, site: 10 }));
    await press();
    await show(ON({ resend: 12, site: 12 })); // (the page re-rendered by the action's refresh)
    expect(text("[data-sync-resend]")).toBe("Resendis 12 kontakti (tasuta pakett: 1000)");
    expect(text("[data-sync-report]")).toBe("2 lisatud, 1 eemaldatud, 3 loobus Resendis");
  });

  test("the next press clears the last answer first", async () => {
    actions.fullSyncAction.mockResolvedValueOnce({ ...REPORT, failed: 1 });
    await show(ON());
    await press();
    expect($("[data-sync-report-failed]")).not.toBeNull();
    let answer!: (r: FullSyncReport) => void;
    actions.fullSyncAction.mockReturnValueOnce(new Promise<FullSyncReport>((resolve) => (answer = resolve)));
    await press();
    expect($("[data-sync-report]")).toBeNull();
    expect($("[data-sync-report-failed]")).toBeNull();
    await act(async () => answer(REPORT));
    await settle();
    expect($("[data-sync-report-failed]")).toBeNull();
  });
});

describe("a refusal", () => {
  test.each([
    ["unavailable", "Resendiga ei saanud ühendust — proovi hiljem uuesti."],
    ["notConfigured", "Resendi uudiskirja saatmine pole veel seadistatud."],
    ["permission", "Resendi võtmel pole õigusi kontakte hallata — vaja on täisõigustega võtit."],
    ["server", "Sünkroonimine ei õnnestunud. Proovi uuesti."],
  ])("%s is answered in words, and no report is shown with it", async (error, words) => {
    actions.fullSyncAction.mockResolvedValue({ error });
    await show(ON());
    await press();
    expect(text(`[data-sync-error="${error}"]`)).toBe(words);
    expect(text("[data-sync-status]")).toBe(words);
    expect($("[data-sync-report]")).toBeNull();
    expect($("[data-sync-unfinished]")).toBeNull();
    // the button is ready again
    expect($<HTMLButtonElement>("[data-sync-run]")!.getAttribute("aria-disabled")).toBeNull();
  });

  test("the key that can only send is never told as Resend being down", async () => {
    actions.fullSyncAction.mockResolvedValue({ error: "permission" });
    await show(ON());
    await press();
    expect(container.textContent).not.toContain("Resendiga ei saanud ühendust");
    expect(container.textContent).toContain("vaja on täisõigustega võtit");
  });

  test("an action that cannot be reached at all (the network) is the `server` text, not a crash", async () => {
    actions.fullSyncAction.mockRejectedValue(new Error("Failed to fetch"));
    await show(ON());
    await press();
    expect(text('[data-sync-error="server"]')).toBe("Sünkroonimine ei õnnestunud. Proovi uuesti.");
    expect($<HTMLButtonElement>("[data-sync-run]")!.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("rendered on the server", () => {
  test("the same markup without a browser: not set up, and set up with its counts", () => {
    const off = renderToStaticMarkup(createElement(NewsletterSync, { state: { configured: false } }));
    expect(off).toContain("data-sync-off");
    expect(off).not.toContain("<button");
    const on = renderToStaticMarkup(createElement(NewsletterSync, { state: ON({ resend: 950, site: 900, missing: 1 }) }));
    expect(on).toContain("data-sync-run");
    expect(on).toContain("data-sync-warning");
    expect(on).not.toContain("data-sync-limit");
  });
});
