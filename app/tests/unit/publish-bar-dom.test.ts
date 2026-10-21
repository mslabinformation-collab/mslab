// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishBar } from "@/components/admin/PublishBar";
import { adminEt } from "@/i18n/dict/admin";

// PublishBar (admin UX pass, README §1.8; strings.md W9): the bar under the H1 of a published thing with unpublished changes. It counts them and names
// the changed fields, opens the preview, discards the changes behind a ConfirmPanel, and publishes them on an explicit press. Below 900px it is the
// phone's bar at the bottom of the screen, „Avaldamata {n} · Eelvaade“ + „Avalda“: both forms are in the page, and the CSS shows one (checked below on
// the stylesheet's text, which happy-dom does not apply).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type Props = Parameters<typeof PublishBar>[0];
const CHANGED = ["Lühikirjeldus", "Hind", "Moodul 03"];
const PREVIEW = "/api/admin/eelvaade?tee=%2Fkoolitused%2Fkulmud";
const props = (over: Partial<Props> = {}): Props => ({
  changed: CHANGED,
  previewHref: PREVIEW,
  onDiscard: async () => {},
  onPublish: async () => {},
  ...over,
});
const show = (over?: Partial<Props>) => act(async () => root.render(createElement(PublishBar, props(over))));

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const text = (selector: string) => $(selector)?.textContent ?? null;
const discard = () => $<HTMLButtonElement>("[data-publish-discard]");
const publish = () => $<HTMLButtonElement>("[data-publish-go]")!;
const panel = () => $("[data-confirm-panel]");
const panelButtons = () => Array.from(panel()?.querySelectorAll("button") ?? []);
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

/** A promise the test settles by hand: the publish or the discard on its way. */
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("PublishBar", () => {
  it("„Avaldamata muudatused: 3“ + the changed labels, „Eelvaade ↗“, „Loobu muudatustest“, „Avalda muudatused“", async () => {
    expect(adminEt.publish).toMatchObject({
      count: "Avaldamata muudatused: {n}",
      preview: "Eelvaade ↗",
      discard: "Loobu muudatustest",
      publish: "Avalda muudatused",
      phoneCount: "Avaldamata {n}",
      phonePreview: "Eelvaade",
      phonePublish: "Avalda",
    });
    await show();
    const bar = $("[data-publish-bar]")!;
    expect(bar.getAttribute("role")).toBe("region");
    expect(text("[data-publish-count]")).toBe("Avaldamata muudatused: 3");
    expect(text("[data-publish-fields]")).toBe(" · Lühikirjeldus, Hind, Moodul 03");
    const preview = $<HTMLAnchorElement>("[data-publish-preview]")!;
    expect(preview.textContent).toBe("Eelvaade ↗");
    expect(preview.getAttribute("href")).toBe(PREVIEW);
    expect([preview.target, preview.rel]).toEqual(["_blank", "noopener"]);
    expect(discard()!.textContent).toBe("Loobu muudatustest");
    expect($("[data-publish-go] [data-wide]")!.textContent).toBe("Avalda muudatused");
    // the buttons are buttons of their own (the bar may stand inside a form)
    expect([discard()!.type, publish().type]).toEqual(["button", "button"]);
    // one change: the count follows
    await show({ changed: ["Slaid 2 pealkiri"] });
    expect(text("[data-publish-count]")).toBe("Avaldamata muudatused: 1");
    expect(text("[data-publish-fields]")).toBe(" · Slaid 2 pealkiri");
  });

  it("the phone's form (W9): „Avaldamata 3 · Eelvaade“ with the preview as its link, and „Avalda“; no „Loobu muudatustest“ there", async () => {
    await show();
    expect(text("[data-publish-phone]")).toBe("Avaldamata 3 · Eelvaade");
    const link = $<HTMLAnchorElement>("[data-publish-phone] a")!;
    expect([link.textContent, link.getAttribute("href"), link.target]).toEqual(["Eelvaade", PREVIEW, "_blank"]);
    expect($("[data-publish-go] [data-phone]")!.textContent).toBe("Avalda");
    // the stylesheet: below 900px (the admin's phone width) the wide words, the field list and „Loobu muudatustest“ go, the phone's words come,
    // and the bar sits at the bottom of the screen; from 900px the phone's words are hidden
    const css = readFileSync(join(process.cwd(), "src/components/admin/PublishBar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const phone = /@media \(max-width: 899\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/\.bar \{[^}]*position: fixed;[^}]*bottom: 0;/);
    expect(phone).toMatch(/\.bar \.wide,\s*\.bar \.fields,\s*\.actions \.discard \{\s*display: none;/);
    expect(phone).toMatch(/\.bar \.phone \{\s*display: (inline|flex|inline-flex|block);/);
    expect(css).toMatch(/^\.phone \{\s*display: none;/m);
    expect($("[data-publish-phone]")!.className).toMatch(/phone/);
    expect($("[data-publish-go] [data-phone]")!.className).toMatch(/phone/);
    expect($("[data-publish-go] [data-wide]")!.className).toMatch(/wide/);
    expect(discard()!.className).toMatch(/discard/);
  });

  it("„Loobu muudatustest“ asks first: „Kas loobun 3 muudatusest? Avalikul lehel jääb praegune versioon.“ / „Jah, loobu“", async () => {
    expect(adminEt.publish.confirm).toBe("Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.");
    expect(adminEt.publish.confirmYes).toBe("Jah, loobu");
    const onDiscard = vi.fn(async () => {});
    await show({ onDiscard });
    await click(discard()!);
    // the panel takes the trigger's place and the focus; nothing is discarded yet
    expect(discard()).toBeNull();
    expect(onDiscard).not.toHaveBeenCalled();
    const question = document.getElementById(panel()!.getAttribute("aria-labelledby")!);
    expect(question?.textContent).toBe("Kas loobun 3 muudatusest? Avalikul lehel jääb praegune versioon.");
    expect(panelButtons().map((b) => b.textContent)).toEqual(["Jah, loobu", "Katkesta"]);
    expect(panelButtons()[0].className).toMatch(/dangerYes/);
    expect(document.activeElement).toBe(panel());

    // „Katkesta“: the trigger is back and has the focus, nothing was discarded
    await click(panelButtons()[1]);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(discard());
    expect(onDiscard).not.toHaveBeenCalled();

    // „Jah, loobu“: discarded once
    await click(discard()!);
    await click(panelButtons()[0]);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("while the discard is on its way, „Jah, loobu“ and „Avalda muudatused“ are aria-disabled and do nothing; then the panel closes", async () => {
    const run = pending();
    const onDiscard = vi.fn(() => run.promise);
    const onPublish = vi.fn(async () => {});
    await show({ onDiscard, onPublish });
    await click(discard()!);
    await click(panelButtons()[0]);
    expect(panelButtons()[0].getAttribute("aria-disabled")).toBe("true");
    expect(publish().getAttribute("aria-disabled")).toBe("true");
    await click(panelButtons()[0]);
    await click(publish());
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
    await act(async () => run.resolve());
    expect(panel()).toBeNull();
    expect(publish().hasAttribute("aria-disabled")).toBe(false);
  });

  it("„Avalda muudatused“ publishes on its press, once: busy (aria-disabled, aria-busy) until the screen's answer, then pressable again", async () => {
    const run = pending();
    const onPublish = vi.fn(() => run.promise);
    const onDiscard = vi.fn(async () => {});
    await show({ onPublish, onDiscard });
    expect(onPublish).not.toHaveBeenCalled();
    expect(publish().hasAttribute("aria-disabled")).toBe(false);
    await click(publish());
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(publish().getAttribute("aria-disabled")).toBe("true");
    expect($("[data-publish-bar]")!.getAttribute("aria-busy")).toBe("true");
    expect(publish().disabled).toBe(false); // aria-disabled keeps the focus where it was
    // a second press and „Loobu muudatustest“ do nothing meanwhile
    await click(publish());
    expect(discard()!.getAttribute("aria-disabled")).toBe("true");
    await click(discard()!);
    expect(panel()).toBeNull();
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    await act(async () => run.resolve());
    expect(publish().hasAttribute("aria-disabled")).toBe(false);
    expect($("[data-publish-bar]")!.hasAttribute("aria-busy")).toBe(false);
  });

  it("a callback that fails ends the busy state (the screen tells what went wrong)", async () => {
    const onPublish = vi.fn(async () => {
      throw new Error("offline");
    });
    await show({ onPublish });
    await click(publish());
    expect(publish().hasAttribute("aria-disabled")).toBe(false);
    await click(publish());
    expect(onPublish).toHaveBeenCalledTimes(2);
  });

  it("blocked fields are listed after publish", async () => {
    await show();
    expect($("[data-publish-blocked]")).toBeNull();
    await show({ changed: ["Hind"], blocked: ["Hind"] });
    const list = $("[data-publish-blocked]")!;
    expect(list.tagName).toBe("UL");
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Hind"]);
    // the labels only: no sentence of the bar's own round them (the design gives none)
    expect(list.textContent).toBe("Hind");
    await show({ changed: ["Hind", "Moodul 03"], blocked: ["Hind", "Moodul 03"] });
    expect(Array.from($("[data-publish-blocked]")!.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Hind", "Moodul 03"]);
    await show({ blocked: [] });
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("no unpublished change: no bar", async () => {
    await show({ changed: [] });
    expect(container.innerHTML).toBe("");
  });
});
