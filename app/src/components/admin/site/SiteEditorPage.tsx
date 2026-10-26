"use client";

import { useState, type ReactNode } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { siteChangeLabels } from "@/domain/site-changes";
import { SITE_ENTITY_ID, type SiteEntity, type SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { combineStatus } from "../course/course-view";
import { usePhoneChip } from "../course/usePhoneChip";
import { LangSwitch } from "../EditLang";
import { PublishBar } from "../PublishBar";
import { SaveStatus } from "../SaveStatus";
import { SectionMap, type SectionEntry } from "../SectionMap";
import { blockedOf, failedLine, LATE, orLate, post, stampOf, useEditorRestarts, useFormOnScreen, type Change, type HeldPart, type Waits } from "../useEditorRestarts";
import ui from "../ui.module.css";
import styles from "./SiteEditorPage.module.css";
import { focusSiteField, useSitePart, type SitePartApi } from "./useSitePart";

// The site editors' page (admin UX pass piece 4a, Task 2; README §4 "These share the site-editor template: header with H1, LangSwitch, SaveStatus and
// „Vaata lehel ↗“; PublishBar; a section map when there are 4 or more cards", §1.8; the Part 4 frames C1, C2, C5): Avaleht, Koolitaja and Praktika
// (Tasks 4–6) hand it their parts as the page read them (server/site-drafts.ts readSiteEditor) and draw their cards with `render`.
// - Every part autosaves into its draft (site/useSitePart.ts); the header's ONE SaveStatus is made of every part's (combineStatus), with the draft's
//   words („Mustand salvestatud {HH:MM}“) while something waits for „Avalda muudatused“.
// - The PublishBar names the drafts' changes row by row (domain/site-changes.ts siteChangeLabels, S4-1: „Avaldamata muudatused: 2 · MAXI hind,
//   MAXI punkt 4“); „Eelvaade ↗“ is the public page in draft mode; under it, after a publish, what it could not publish („Puudub: slaid 3 pilt“).
// - „Avalda muudatused“: every part's waiting save is sent and waited for, within one bound (SAVE_TIMEOUT_MS from the press); a save that did not go
//   through (no connection, a server error, a field held back, another tab's text) publishes nothing — the chip says why. Then POST …/avalda, and
//   the page is read again: the parts start over from a read at or past the answer's stamp (the published ones leave the bar, a held one stays on
//   it with its „Puudub: …“ until its next save). Nothing published and something held: the cards take typing again, nothing is read.
// - „Loobu muudatustest“ (behind the bar's question): the waiting saves first, then POST …/loobu (R-e: every draft of the entity), every part's copy
//   in this browser goes, and the parts start over from the read (at the bound: from the live values the discard left).
// - The cards wait (inert, aria-busy, nothing typed taken) from the press until then; a picture whose upload ends meanwhile goes in afterwards. The
//   waits, the restart and the focus kept over it are the course editor's own (../useEditorRestarts.ts, moved out of course/SavedCourse.tsx).

/** The parts the last publish could not publish, with each part's count of saves then (`generation`: the form they were counted in). */
type Held = { parts: HeldPart[]; generation: number; saves: Partial<Record<string, number>> };
/** What the bar says; it stays when the form starts over (a publish that held some parts lists them after the read). */
type Said = { held: Held | null; barError: string | null; publishedAt: Date | null };
const QUIET: Said = { held: null, barError: null, publishedAt: null };

type Parts = Record<string, SitePartState>;
export type SiteEditorProps = {
  entity: SiteEntity;
  /** The line over the H1 („Koduleht“, „Koolitused“). */
  eyebrow: string;
  title: string;
  lead?: string;
  /** „Vaata lehel ↗“: the public page (a new tab). */
  viewHref: string;
  /** The public page's path, for „Eelvaade ↗“ (`/api/admin/eelvaade?tee=<path>`). */
  previewPath: string;
  /** The section map's entries (the cards' ids and names), or how the parts' state makes them (a count, „Kontrolli“); a map only from 4 entries. */
  sections?: SectionEntry[] | ((apis: Record<string, SitePartApi>) => SectionEntry[]);
  /** Every part as the page read it, in the screen's order: its version, its value (the draft over live), live's value. */
  parts: Parts;
  /** The read's stamp (server/read-stamp.ts; readSiteEditor's): which read reflects a press. */
  stamp: number;
  /** The cards, from every part's api (a card may show the fields of several parts). */
  render: (apis: Record<string, SitePartApi>) => ReactNode;
};

type Form = Omit<SiteEditorProps, "parts" | "stamp"> & {
  seeds: Parts;
  generation: number;
  waiting: boolean;
  waits: Waits<Parts>;
  refocus: () => void;
  said: Said;
  setSaid: (update: (s: Said) => Said) => void;
};

export function SiteEditorPage(props: SiteEditorProps) {
  const { parts, stamp, ...rest } = props;
  const [said, setSaid] = useState<Said>(QUIET);
  const { seeds, generation, waiting, waits, refocus } = useEditorRestarts<Parts>({ read: parts, stamp, parts, root: "[data-site-editor]", title: "[data-site-title]" });
  const form: Form = { ...rest, seeds, generation, waiting, waits, refocus, said, setSaid };
  const names = Object.keys(seeds);
  // (every part's hook in a component of its own, one after another, so their number may follow the parts read; the last one draws the page)
  return names.length > 0 ? <PartHooks key={generation} {...form} names={names} index={0} apis={{}} /> : <SiteForm key={generation} {...form} apis={{}} />;
}

/** One part's autosave, then the next part's, and the page once every part has its api. */
function PartHooks({ names, index, apis, ...form }: Form & { names: string[]; index: number; apis: Record<string, SitePartApi> }) {
  const part = names[index];
  const api = useSitePart({ entity: form.entity, part, seed: form.seeds[part] });
  const all = { ...apis, [part]: api };
  return index + 1 < names.length ? <PartHooks {...form} names={names} index={index + 1} apis={all} /> : <SiteForm {...form} apis={all} />;
}

function SiteForm({ entity, eyebrow, title, lead, viewHref, previewPath, sections, render, seeds, generation, waiting, waits, refocus, said, setSaid, apis }: Form & { apis: Record<string, SitePartApi> }) {
  const { hold, waitingNow, release, reload, route } = waits;
  const names = Object.keys(apis);
  const frozen = waiting;
  // a part's list change (an upload that ends) goes in now, or once the cards take typing again; the focus back where it was after a wait
  useFormOnScreen({ frozen, generation, waits, refocus, apply: (change: Change) => apis[change.part]?.update(change.name, change.fn) });

  // the parts the publish held, until each one's next save
  const held = (said.held?.parts ?? []).filter((b) => {
    const before = said.held?.generation === generation ? (said.held.saves[b.part] ?? 0) : 0;
    return !apis[b.part] || apis[b.part].saves <= before;
  });
  const heldNames = held.map((b) => b.part);
  const savesNow = () => Object.fromEntries(names.map((part) => [part, apis[part].saves]));

  // what the cards get: nothing typed is taken while they wait; a list change goes in once they take typing again (`route`)
  const shown = Object.fromEntries(
    names.map((part) => {
      const api = apis[part];
      const update: SitePartApi["update"] = (name, fn) => route({ part, name, fn: fn as (current: unknown) => unknown });
      const attention = api.attention || heldNames.includes(part);
      return [part, frozen ? { ...api, set: () => {}, commit: () => {}, update, attention } : { ...api, update, attention }];
    }),
  ) as Record<string, SitePartApi>;

  const changed = siteChangeLabels(
    entity,
    names.map((part) => ({ part, live: seeds[part].live, draft: apis[part].fields })),
  );
  const combined = combineStatus(names.map((part) => apis[part].status));
  // after a publish the parts start over with no save of their own yet: the chip keeps the publish's time
  const status: AutosaveStatus = combined.kind === "saved" && combined.at === null && said.publishedAt ? { kind: "saved", at: said.publishedAt } : combined;
  const phone = usePhoneChip();
  /** SaveStatus's „Näita“: the first field held back, in screen order. */
  const showInvalid = () => {
    for (const part of names) {
      const why = apis[part].unconfirmed();
      if (why?.reason === "invalid" && why.field) return focusSiteField(part, why.field);
    }
  };

  const url = (press: "avalda" | "loobu") => `/api/admin/sisu/${entity}/${SITE_ENTITY_ID}/${press}`;
  /** Every part's waiting save, sent now and waited for: a publish and a discard work on what is saved. True for each part the server holds. */
  const flushAll = () => Promise.all(names.map((part) => apis[part].flush()));

  // „Avalda muudatused“ and „Loobu muudatustest“ never join a wait of the cards: while one is on its way the PublishBar is busy (`waiting`), and a
  // press that comes in the same turn does nothing here
  const publish = async () => {
    if (waitingNow()) return;
    setSaid((s) => ({ ...s, barError: null }));
    const signal = hold();
    const saved = await orLate(flushAll(), signal);
    if (saved === LATE) return; // (the bound: the cards take typing, the page is read)
    // a save that did not go through: nothing is published, the chip says why (and the text stays, in this browser too)
    if (saved.some((ok) => !ok)) return release();
    const answer = await post(url("avalda"), signal);
    if ("late" in answer) return;
    if (!answer.ok) {
      release();
      return setSaid((s) => ({ ...s, barError: failedLine("publish", answer.signedOut) }));
    }
    const result = answer.body as { published?: unknown; blocked?: unknown } | null;
    const blocked = Array.isArray(result?.blocked) && result.blocked.length > 0 ? (result.blocked as HeldPart[]) : null;
    const done = Array.isArray(result?.published) && result.published.length > 0;
    setSaid((s) => ({ ...s, held: blocked ? { parts: blocked, generation, saves: savesNow() } : null, publishedAt: done ? new Date() : s.publishedAt }));
    // something went live, or nothing was there to go (another tab published or threw it away meanwhile, or an answer that cannot be read): the
    // page is read again, and the parts start over from a read at or past the answer's stamp
    if (done || !blocked) reload(undefined, stampOf(answer.body));
    else release();
  };

  const discard = async () => {
    if (waitingNow()) throw new Error("the cards wait"); // (the question stays open)
    setSaid((s) => ({ ...s, barError: null }));
    const signal = hold();
    if ((await orLate(flushAll(), signal)) === LATE) return;
    const answer = await post(url("loobu"), signal);
    if ("late" in answer) return;
    if (!answer.ok) {
      release();
      setSaid((s) => ({ ...s, barError: failedLine("discard", answer.signedOut) }));
      throw new Error("discard failed"); // (the question stays open)
    }
    // what was thrown away must not come back: every part's copy in this browser goes before the parts start over; muted, they start over from the
    // read, or at the bound from the live values the discard left
    for (const part of names) apis[part].discardCopy();
    setSaid((s) => ({ ...s, held: null }));
    reload(seeds, stampOf(answer.body));
  };

  const entries = typeof sections === "function" ? sections(shown) : (sections ?? []);
  const map = entries.length >= 4;

  return (
    <div className={ui.page} data-site-editor="">
      <div className={ui.heading}>
        <div className={styles.headText}>
          <p className={ui.eyebrow} data-site-eyebrow="">
            {eyebrow}
          </p>
          <h1 className={`${ui.h1} ${styles.title}`} tabIndex={-1} data-site-title="">
            {title}
          </h1>
          {lead && (
            <p className={ui.lead} data-site-lead="">
              {lead}
            </p>
          )}
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          <span className={styles.statusSlot}>
            <SaveStatus status={status} draft={changed.length > 0} compact={phone} onShowInvalid={showInvalid} />
          </span>
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={viewHref} target="_blank" rel="noopener" data-site-view="">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        </div>
      </div>
      <PublishBar
        changed={changed}
        previewHref={`/api/admin/eelvaade?tee=${encodeURIComponent(previewPath)}`}
        // (nothing left to publish: no bar, never „Avaldamata muudatused: 0“)
        blocked={changed.length > 0 ? blockedOf(held) : undefined}
        error={said.barError}
        // the cards wait (a publish or a discard, or its read): the bar's buttons do nothing meanwhile
        waiting={frozen}
        onDiscard={discard}
        onPublish={publish}
      />
      <div
        className={map ? `${styles.layout} ${styles.withMap}` : styles.layout}
        inert={frozen || undefined}
        aria-busy={frozen || undefined}
        data-cards-waiting={frozen ? "" : undefined}
      >
        {map && <SectionMap sections={entries} width={170} />}
        <div className={styles.main}>{render(shown)}</div>
      </div>
    </div>
  );
}
