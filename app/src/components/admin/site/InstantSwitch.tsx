"use client";

import { useId, useState } from "react";
import { Switch } from "../Switch";
import ui from "../ui.module.css";
import type { SitePage } from "./SiteEditorPage";

/**
 * A site editor's instant switch (admin UX pass piece 4b: a post's „Avaldatud“, news/PublishedCard.tsx; Hüpikaken's „Lehel näidatakse“,
 * CampaignEditor.tsx): the `Switch`, its hint under it, and what the last press said (`said`, `role="alert"`, `data-switch-error`), all of them its
 * description. A press is taken only while no press of the page waits (`page.waitingNow()`) and none of its own is on its way; the switch shows what
 * was asked from the press until `press(on)` answers: true keeps it (the press went through, or its outcome is unknown past the bound — either way the
 * cards start over from the page's read, this switch with them), false shows `checked` again (refused, failed). The press itself (the route, the
 * answer's reading, the words) is the caller's, through `page.instant`. Any `data-*` attribute goes on the switch's input.
 */
export function InstantSwitch({
  page,
  label,
  checked,
  hint,
  said,
  press,
  ...data
}: {
  page: SitePage;
  label: string;
  checked: boolean;
  hint: string;
  said: string | null;
  press: (on: boolean) => Promise<boolean>;
} & { [attribute: `data-${string}`]: string | undefined }) {
  const uid = useId();
  const [asked, setAsked] = useState<boolean | null>(null);
  const change = async (on: boolean) => {
    if (asked !== null || page.waitingNow()) return;
    setAsked(on);
    if (!(await press(on))) setAsked(null);
  };
  return (
    <>
      <Switch {...data} label={label} checked={asked ?? checked} onChange={(on) => void change(on)} describedBy={said ? `${uid}-hint ${uid}-said` : `${uid}-hint`} />
      <p id={`${uid}-hint`} className={ui.hint}>
        {hint}
      </p>
      {said && (
        <p id={`${uid}-said`} role="alert" className={ui.error} data-switch-error="">
          {said}
        </p>
      )}
    </>
  );
}
