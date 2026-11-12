import type { Locator } from "@playwright/test";

/**
 * The controls in `scope` less than 44 px tall (the touch target rule): the start of each one's HTML, for the failure message. An input's starts with
 * its type, so LABELLED can tell a file field from the rest: React writes `type` after an input's other attributes, past the 120 characters kept, and
 * ImageField's file input is visually hidden (1 px, its label the target) rather than display: none (UX audit 2 A30).
 */
export const smallTargets = (scope: Locator): Promise<string[]> =>
  scope
    .locator("a:visible, button:visible, input:visible, select:visible")
    .evaluateAll((els) =>
      els
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => (e instanceof HTMLInputElement ? `<input type="${e.type}"${e.outerHTML.slice(6)}` : e.outerHTML).slice(0, 120)),
    );

/** A radio's or a file field's touch target is its label (the pill around the radio), not the input: smallTargets lists the inputs, this tells them apart. */
export const LABELLED = /^<input[^>]*\stype="(radio|file)"/;

/**
 * The rows of the switches in `scope` (components/admin/Switch.tsx: a switch's touch target is its row, not its 48×28 checkbox) less than 44 px tall:
 * the start of each one's HTML.
 */
export const smallSwitchRows = (scope: Locator): Promise<string[]> =>
  scope
    .locator("label[data-switch-row]:visible")
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 120)));

/** The pills of the radios in `scope` (a radio's label is its touch target) less than 44 px tall: the start of each one's HTML. */
export const smallPills = (scope: Locator): Promise<string[]> =>
  scope
    .locator("label:has(input[type=radio]):visible")
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 120)));
