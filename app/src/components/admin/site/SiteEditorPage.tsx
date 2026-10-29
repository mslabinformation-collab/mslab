"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { siteChangeLabels } from "@/domain/site-changes";
import { siteRowOf, type SitePartState, type SiteTarget } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { dropSiteCopies } from "@/lib/site-copies";
import { combineStatus } from "../course/course-view";
import { usePhoneChip } from "../course/usePhoneChip";
import { LangSwitch } from "../EditLang";
import { PublishBar } from "../PublishBar";
import { SaveStatus } from "../SaveStatus";
import { SectionMap, type SectionEntry } from "../SectionMap";
import {
  blockedOf,
  heldErrors,
  LATE,
  orLate,
  post,
  pressFailedLine,
  usePublishPresses,
  useEditorRestarts,
  useFormOnScreen,
  type Change,
  type HeldPart,
  type Pressed,
  type Waits,
} from "../useEditorRestarts";
import ui from "../ui.module.css";
import styles from "./SiteEditorPage.module.css";
import { focusSiteField, refusalText, useSitePart, type SitePartApi, type SitePartOptions } from "./useSitePart";

// The site editors' page (admin UX pass piece 4a, Task 2; README §4 "These share the site-editor template: header with H1, LangSwitch, SaveStatus and
// „Vaata lehel ↗“; PublishBar; a section map when there are 4 or more cards", §1.8; the Part 4 frames C1, C2, C5): Avaleht, Koolitaja and Praktika
// (Tasks 4–6) hand it their parts as the page read them (server/site-drafts.ts readSiteEditor) and draw their cards with `render`.
// - Every part autosaves into its draft (site/useSitePart.ts); the header's ONE SaveStatus is made of every part's (combineStatus), with the draft's
//   words („Mustand salvestatud {HH:MM}“) while something waits for „Avalda muudatused“.
// - The PublishBar names the drafts' changes row by row (domain/site-changes.ts siteChangeLabels, S4-1: „Avaldamata muudatused: 2 · MAXI hind,
//   MAXI punkt 4“); „Eelvaade ↗“ is the public page in draft mode; under it, after a publish, what it could not publish („Puudub: slaid 3 pilt“).
// - „Avalda muudatused“: every part's waiting save is sent and waited for, within one bound (SAVE_TIMEOUT_MS from the press); a save that did not go
//   through (no connection, a server error, a field held back, another tab's text) publishes nothing — the chip says why, and the page brings it
//   into view with the focus on its „Näita“ when it has one (piece 4a final review M-1: on a phone she presses at the foot of the screen). Then POST
//   …/avalda with every part's version as the screen holds it (`{ versions }`, review I-1: a draft another window saved after this screen's read is
//   held back as changed, never published from a bar that did not show it), and the page is read again: the parts start over from a read at or past
//   the answer's stamp (the published ones leave the bar, a held one stays on it with its „Puudub: …“ until its next save). Nothing published and
//   something held as missing: the cards take typing again, nothing is read.
// - „Loobu muudatustest“ (behind the bar's question): the waiting saves first, then POST …/loobu (R-e: every draft of the entity), every part's copy
//   in this browser goes, and the parts start over from the read (at the bound: from the live values the discard left).
// - The cards wait (inert, aria-busy, nothing typed taken) from the press until then; a picture whose upload ends meanwhile goes in afterwards. The
//   waits, the restart, the focus kept over it and the two presses are the course editor's own (../useEditorRestarts.ts).
//
// A screen (Tasks 4–6) is a small client component round it, which its server page.tsx renders with readSiteEditor's answer as it came:
//   <SiteEditorPage<HomePartValues> entity="home" parts={data.parts} stamp={data.stamp} render={(apis) => <HomeCards apis={apis} />} … />
//
// Piece 4b (Uudised, Task 2): the target may be a post (`entity={{ entity: "post", id }}`), and a post that is not published saves straight to its row
// (R-a): `drafted={false}` — the same header with no bar, no „· avaldamata“ and the chip's plain words. A screen's own instant press (a post's
// „Avaldatud“, R-b) goes as „Avalda muudatused“ does through `render`'s second argument (SitePage.instant). A part the last press held as "invalid" (a post's
// address another post has, ADM:2281) is said at its field — the part's `error(name)`, in its partOptions' `errorText` — and the focus goes there;
// the bar lists only what is missing or changed meanwhile.

/** The editor values of an entity's parts by name (domain/site-entities.ts HomePartValues, TrainerPartValues; Praktika `Record<string, PackageDraft>`). */
export type SiteValues = Record<string, Record<string, unknown>>;
/** Every part's api, typed by its value. */
export type SiteApis<A extends SiteValues = SiteValues> = { [K in keyof A & string]: SitePartApi<A[K]> };

/**
 * How a screen's instant press reads its route's answer (SitePage.instant): done, with the answer's stamp (the read that shows it; null: the next
 * read); refused, with the parts it held (said as a publish's are); null for an answer it cannot read (the press failed).
 */
export type InstantOutcome = { done: true; stamp: number | null } | { held: HeldPart[] } | null;
/** An instant press's end: done (the cards wait for the read), held, stopped by a save that did not go through, past the bound, refused at once
 * because the cards wait already (`busy`), or failed with its line. */
export type InstantResult = { kind: "done" | "held" | "unsaved" | "late" | "busy" } | { kind: "failed"; line: string };

/**
 * What a screen's own press gets of the page (`render`'s second argument).
 * - `instant(url, body, outcome, { flush })`: an instant press (a post's „Avaldatud“, piece 4b R-b; Hüpikaken's „Lehel näidatakse“), as „Avalda
 *   muudatused“ goes (../useEditorRestarts.ts usePublishPresses): the cards wait from the press within one bound (SAVE_TIMEOUT_MS); every part's
 *   waiting save is sent first and one that did not go through stops it — the chip says why and is brought into view with the focus on its „Näita“
 *   (`flush: false`: nothing is sent or waited for; `flush: "settle"`: every save is sent and waited for, but one that did not go through stops nothing —
 *   a press on the live row only, which no draft can block, still never lands between a save on its way and its answer); then POST `url` with `body`; the answer, read by `outcome`, is done (the page read again from its stamp, the cards
 *   starting over), held (said as a publish's: missing and changed on the bar, "invalid" at its field — read again when a part was changed meanwhile,
 *   else the cards take typing), or failed (its line: signed out, else the save line). What the last press held is cleared at the press.
 * - `held`: the parts the last press held (a publish's or the screen's own), until each one's next save.
 * - `waitingNow()`: the cards wait now (a press is on its way, or its read); `whenFree()`: resolves once they take typing again (the same wait for every
 *   generation of the cards, so a press made after they started over — an UndoBar's undo — can wait for it).
 */
export type SitePage = {
  instant: (url: string, body: unknown, outcome: (answer: Record<string, unknown>) => InstantOutcome, o?: { flush?: boolean | "settle" }) => Promise<InstantResult>;
  held: HeldPart[];
  waitingNow: () => boolean;
  whenFree: () => Promise<void>;
};

/** What the bar says; it stays when the form starts over (a publish that held some parts lists them after the read). */
type Said = Pressed;
const QUIET: Said = { blocked: null, barError: null, publishedAt: null };

type Parts = Record<string, SitePartState>;
export type SiteEditorProps<A extends SiteValues = SiteValues> = {
  /** What is edited: Avaleht, Koolitaja or Praktika by name, or a post `{ entity: "post", id }` (piece 4b). */
  entity: SiteTarget;
  /** The line over the H1 („Koduleht“, „Koolitused“); none: no line. */
  eyebrow?: string;
  /** The H1, or how the parts make it (a post's title as typed). */
  title: string | ((apis: SiteApis<A>) => string);
  lead?: string;
  /** Over the eyebrow and the H1: a way back („← Uudised“, the screen's own element). */
  back?: ReactNode;
  /** Under the header and the bar, before the cards: a line of the screen's own („Postitus loodud. …“). */
  notice?: ReactNode;
  /** „Vaata lehel ↗“: the public page (a new tab); null: none (a post that is not public). */
  viewHref: string | null;
  /** The public page's path, for „Eelvaade ↗“ (`/api/admin/eelvaade?tee=<path>`). */
  previewPath: string;
  /** The section map's entries (the cards' ids and names), or how the parts' state makes them (a count, „Kontrolli“); a map only from 4 entries. */
  sections?: SectionEntry[] | ((apis: SiteApis<A>) => SectionEntry[]);
  /**
   * Every part as the page read it, in the screen's order: its version, its value (the draft over live), live's value. Pass the read's own object, as
   * it came (readSiteEditor's `parts`, through the page's props): a new object is a new read, and a read starts the parts over while a press waits for
   * one — so memoise one that is derived (reordered, filtered, mapped), or every render of the wrapper would count as a read (review M-2).
   */
  parts: Parts;
  /** The read's stamp (server/read-stamp.ts; readSiteEditor's): which read reflects a press. */
  stamp: number;
  /**
   * The cards, from every part's api (a card may show the fields of several parts), and what a press of the screen's own gets of the page (SitePage).
   * It returns elements and is called while the page renders, so it calls no hook itself: a card's hooks belong in the card's own component
   * (`render={(apis) => <Cards apis={apis} />}`; review M-5).
   */
  render: (apis: SiteApis<A>, page: SitePage) => ReactNode;
  /** A part's own leave-guard label, check before a save or field focus (useSitePart's options), by part name. */
  partOptions?: { [K in keyof A & string]?: SitePartOptions };
  /**
   * The parts save into drafts that wait for „Avalda muudatused“ (the default). False: straight to the row (a post that is not published, piece 4b
   * R-a) — no PublishBar, no field „· avaldamata“, and the chip's plain „Salvestatud {HH:MM}“.
   */
  drafted?: boolean;
  /** SaveStatus's „gone“ word, the partitive of the thing („postitust“: „Seda postitust enam ei ole. …“); none for a single record (S4-4). */
  thing?: string;
  /**
   * After a save the server took (what it sent, the part's version after it): true has the page read again, starting nothing over — for what only the
   * server says (Uudised: the list's row beside the editor, the address a post's new title made, piece 4b R-f, R-g). Nothing is read while the cards
   * wait for a press: its own read follows (as the course's read for the modules' labels).
   */
  readAfterSave?: (part: string, patch: Record<string, unknown>, version: string) => boolean;
};

type Form = Omit<SiteEditorProps, "parts" | "stamp"> & {
  seeds: Parts;
  generation: number;
  waiting: boolean;
  waits: Waits<Parts>;
  refocus: () => void;
  said: Said;
  setSaid: (update: (s: Said) => Said) => void;
  /** A save's word on reading the page again (readAfterSave), and the read. */
  heard: (part: string, patch: Record<string, unknown>, version: string) => void;
};

export function SiteEditorPage<A extends SiteValues = SiteValues>(props: SiteEditorProps<A>) {
  // (the parts' types are the screen's; the page itself works on any part)
  const { parts, stamp, ...rest } = props as unknown as SiteEditorProps;
  const router = useRouter();
  const [said, setSaid] = useState<Said>(QUIET);
  const { seeds, generation, waiting, waits, refocus } = useEditorRestarts<Parts>({ read: parts, stamp, parts, root: "[data-site-editor]", title: "[data-site-title]" });
  const heard = (part: string, patch: Record<string, unknown>, version: string) => {
    if (rest.readAfterSave?.(part, patch, version) && !waits.waitingNow()) startTransition(() => router.refresh());
  };
  const form: Form = { ...rest, seeds, generation, waiting, waits, refocus, said, setSaid, heard };
  const names = Object.keys(seeds);
  // (every part's hook in a component of its own, one after another, so their number may follow the parts read; the last one draws the page)
  return names.length > 0 ? <PartHooks key={generation} {...form} names={names} index={0} apis={{}} /> : <SiteForm key={generation} {...form} apis={{}} />;
}

/** One part's autosave, then the next part's, and the page once every part has its api. */
function PartHooks({ names, index, apis, ...form }: Form & { names: string[]; index: number; apis: SiteApis }) {
  const part = names[index];
  const own = form.partOptions?.[part];
  const api = useSitePart({
    ...own,
    target: form.entity,
    part,
    seed: form.seeds[part],
    saved: (patch, version) => {
      own?.saved?.(patch, version);
      form.heard(part, patch, version);
    },
  });
  const all = { ...apis, [part]: api };
  return index + 1 < names.length ? <PartHooks {...form} names={names} index={index + 1} apis={all} /> : <SiteForm {...form} apis={all} />;
}

function SiteForm(props: Form & { apis: SiteApis }) {
  const { entity, eyebrow, title, lead, back, notice, viewHref, previewPath, sections, render, partOptions, drafted = true, thing } = props;
  const { seeds, generation, waiting, waits, refocus, said, setSaid, apis } = props;
  const { route } = waits;
  const { entity: row, id } = siteRowOf(entity);
  const names = Object.keys(apis);
  const frozen = waiting;
  // a part's list change (an upload that ends) goes in now, or once the cards take typing again; the focus back where it was after a wait
  useFormOnScreen({ frozen, generation, waits, refocus, apply: (change: Change) => apis[change.part]?.update(change.name, change.fn) });

  /** Every part's waiting save, sent now and waited for: a publish and a discard work on what is saved. True for each part the server holds. */
  const flushAll = () => Promise.all(names.map((part) => apis[part].flush()));
  // a press that a save stopped: once the chip shows why, it is brought into view and the focus goes to its „Näita“ (the invalid state's link; the
  // other states have none, and the focus stays on her press) — after the render, so the chip has its state
  const chipSlot = useRef<HTMLSpanElement>(null);
  const [pointed, setPointed] = useState(0);
  useEffect(() => {
    if (pointed === 0) return;
    const chip = chipSlot.current?.querySelector<HTMLElement>("[data-save-status]");
    chip?.scrollIntoView?.({ block: "center" });
    chip?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [pointed]);
  // „Avalda muudatused“ and „Loobu muudatustest“ (../useEditorRestarts.ts usePublishPresses, shared with the course editor): a save that did not go
  // through publishes nothing (`requireSaved`); the publish carries every part's version as the screen holds it after the flush (`versions`);
  // `held`, the parts the publish held, until each one's next save
  const { held, savesNow, publish, discard } = usePublishPresses({
    said,
    setSaid,
    generation,
    waits,
    parts: apis,
    flushAll,
    urls: { publish: `/api/admin/sisu/${row}/${id}/avalda`, discard: `/api/admin/sisu/${row}/${id}/loobu` },
    requireSaved: true,
    onUnsaved: () => setPointed((n) => n + 1),
    versions: () => Object.fromEntries(names.map((part) => [part, apis[part].versionNow()])),
    // what was thrown away must not come back: every part's copy in this browser, and every other copy of the entity (a part the screen no longer
    // has), by the rule the public preview bar's „Loobu muudatustest“ drops them by (lib/site-copies.ts), as the course editor does
    dropCopies: () => {
      for (const part of names) apis[part].discardCopy();
      dropSiteCopies(entity);
    },
    seeds,
  });
  const heldNames = held.map((b) => b.part);
  // a press that held a part as "invalid" (a post's address another post has): the focus goes to the field it is said at, once the cards take typing
  const lastHold = useRef(said.blocked);
  useEffect(() => {
    if (said.blocked === lastHold.current) return;
    lastHold.current = said.blocked;
    const first = (said.blocked?.parts ?? []).find((b) => b.reason === "invalid" && Object.keys(b.errors ?? {}).length > 0);
    if (first) focusSiteField(first.part, Object.keys(first.errors ?? {})[0]);
  }, [said.blocked]);

  // what the cards get: nothing typed is taken while they wait; a list change goes in once they take typing again (`route`); the words of a field
  // the last press held as "invalid", until the part's next save
  const shown = Object.fromEntries(
    names.map((part) => {
      const api = apis[part];
      const update: SitePartApi["update"] = (name, fn) => route({ part, name, fn: fn as (current: unknown) => unknown });
      const attention = api.attention || heldNames.includes(part);
      const refused = heldErrors(held, part);
      const words = partOptions?.[part]?.errorText ?? refusalText;
      const error = (name: string) => api.error(name) ?? (refused[name] ? words(refused[name]) : undefined);
      const unpublished = drafted ? api.unpublished : () => false;
      const own = { ...api, update, attention, error, unpublished };
      return [part, frozen ? { ...own, set: () => {}, commit: () => {} } : own];
    }),
  ) as SiteApis;
  /** A screen's instant press (SitePage.instant, above). */
  const instant: SitePage["instant"] = async (url, body, outcome, o = {}) => {
    if (waits.waitingNow()) return { kind: "busy" };
    setSaid((s) => ({ ...s, blocked: null }));
    const signal = waits.hold();
    if (o.flush !== false) {
      const saved = await orLate(flushAll(), signal);
      if (saved === LATE) return { kind: "late" };
      if (o.flush !== "settle" && saved.some((ok) => !ok)) {
        waits.release();
        setPointed((n) => n + 1);
        return { kind: "unsaved" };
      }
    }
    const answer = await post(url, signal, body);
    if ("late" in answer) return { kind: "late" };
    if (!answer.ok) {
      waits.release();
      return { kind: "failed", line: pressFailedLine(answer.signedOut) };
    }
    const read = typeof answer.body === "object" && answer.body !== null && !Array.isArray(answer.body) ? outcome(answer.body as Record<string, unknown>) : null;
    if (read && "done" in read) {
      waits.reload(undefined, read.stamp);
      return { kind: "done" };
    }
    if (read && "held" in read) {
      const saves = savesNow();
      setSaid((s) => ({ ...s, blocked: read.held.length > 0 ? { parts: read.held, generation, saves } : null }));
      // a part held as changed (another window's draft after this screen's read): the page is read again, so the bar shows what it lists
      if (read.held.some((b) => b.reason === "changed")) waits.reload(undefined, null);
      else waits.release();
      return { kind: "held" };
    }
    waits.release();
    return { kind: "failed", line: adminEt.common.saveError };
  };
  const page: SitePage = { instant, held, waitingNow: waits.waitingNow, whenFree: waits.whenFree };

  // (straight to the row: nothing waits for „Avalda muudatused“, so there is no bar and nothing is „· avaldamata“)
  const changed = drafted
    ? siteChangeLabels(
        row,
        names.map((part) => ({ part, live: seeds[part].live, draft: apis[part].fields })),
      )
    : [];
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

  const entries = typeof sections === "function" ? sections(shown) : (sections ?? []);
  const map = entries.length >= 4;

  return (
    <div className={ui.page} data-site-editor="">
      <div className={`${ui.heading} ${styles.heading}`} data-site-heading="">
        <div className={styles.headText}>
          {back}
          {eyebrow && (
            <p className={ui.eyebrow} data-site-eyebrow="">
              {eyebrow}
            </p>
          )}
          <h1 className={`${ui.h1} ${styles.title}`} tabIndex={-1} data-site-title="">
            {typeof title === "function" ? title(shown) : title}
          </h1>
          {lead && (
            <p className={ui.lead} data-site-lead="">
              {lead}
            </p>
          )}
        </div>
        <div className={`${ui.headAside} ${styles.aside}`}>
          <LangSwitch />
          <span ref={chipSlot} className={styles.statusSlot} data-site-chip="">
            <SaveStatus status={status} draft={changed.length > 0} compact={phone} thing={thing} onShowInvalid={showInvalid} />
          </span>
          {viewHref !== null && (
            <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={viewHref} target="_blank" rel="noopener" data-site-view="">
              {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
            </a>
          )}
        </div>
      </div>
      {drafted && (
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
      )}
      {notice}
      <div
        className={map ? `${styles.layout} ${styles.withMap}` : styles.layout}
        inert={frozen || undefined}
        aria-busy={frozen || undefined}
        data-cards-waiting={frozen ? "" : undefined}
      >
        {map && <SectionMap sections={entries} width={170} />}
        <div className={styles.main}>{render(shown, page)}</div>
      </div>
    </div>
  );
}
