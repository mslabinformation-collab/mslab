import type { Locator } from "@playwright/test";

/** The controls in `scope` less than 44 px tall (the touch target rule): the start of each one's HTML, for the failure message. */
export const smallTargets = (scope: Locator): Promise<string[]> =>
  scope
    .locator("a:visible, button:visible, input:visible, select:visible")
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 120)));

/** A radio's or a file field's touch target is its label (the pill around the radio), not the input: smallTargets lists the inputs, this tells them apart. */
export const LABELLED = /^<input[^>]*\stype="(radio|file)"/;

/** The pills of the radios in `scope` (a radio's label is its touch target) less than 44 px tall: the start of each one's HTML. */
export const smallPills = (scope: Locator): Promise<string[]> =>
  scope
    .locator("label:has(input[type=radio]):visible")
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 120)));
