"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { patchSender, type Fields, type SendPatch, type Unconfirmed } from "@/components/admin/autosave/engine";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import type { AutosaveStatus } from "@/domain/autosave";
import { sameSiteValue, siteChangeLabels, siteFieldLabel, siteRowFields } from "@/domain/site-changes";
import { siteRowOf, type SiteDraftEntity, type SitePartState, type SiteTarget } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { siteCopyOwner } from "@/lib/site-copies";
import { useFieldEdits, useFieldRefusals, useLatestFields } from "../useFieldRefusals";

// One part's autosave on a site editor (admin UX pass piece 4a, Task 2; README §1.3, B2; rulings R-a, R-b, R-d): the shared engine (autosave/
// useAutosave.ts, used as it is) on POST /api/admin/sisu/<entity>/<id>/osa/<part> (server/site-drafts.ts writeSitePart: every save goes to the part's
// draft, under the loose check; a post that is not published saves straight to its row, piece 4b R-a), from the part's version the page read. The
// target is Avaleht, Koolitaja or Praktika by name (id 0), or a post `{ entity: "post", id }` (piece 4b). As a course's card does, with the same hook (../useFieldRefusals.ts): a
// 400's field codes are kept with the value each refused field was sent with (the engine holds those fields back and saves the rest), so a card can
// say at the field what was refused and a list can place it on the row it is about (by the row's key in what was sent); a field typed in again or
// saved loses its words. The copy in this browser is `mslab-draft:site:<entity>:<part>:<tab>`, a post's `mslab-draft:site:post:<id>:<part>:<tab>` (the
// owner is lib/site-copies.ts', which the public preview bar's „Loobu muudatustest“ drops by too).
//
// A field the leave guard names („Muudatust „Slaid 2 pealkiri“ ei saanud veel salvestada.“, piece4-texts S4-1 note) is named row by row, as the
// PublishBar names it: the first change of that field since its last save the server took (else since live), by domain/site-changes.ts.
//
// Where the fields are on the page (the leave guard's „Jää siia“, SaveStatus's „Näita“): a part's field is the control named `<part>.<field>` (a
// record part's: `MAXI.price`, `trainer.name`) or `<field>` (a list part's rows: `slides.2.title`), as `data-i18n` (I18nInput) or `data-field`
// (TextField); else the field's first control held back (`aria-invalid`). A row that holds its controls out of sight (Avaleht's closed slide, a
// folded answer: piece 4a Task 6, review I-2) says so with `data-reveals` and opens itself on REVEAL_FIELD, then the focus goes into the control.

/** The autosave route of a target's part. */
export function sitePartUrl(target: SiteTarget, part: string): string {
  const { entity, id } = siteRowOf(target);
  return `/api/admin/sisu/${entity}/${id}/osa/${encodeURIComponent(part)}`;
}

/** A part's way for its cards: what they show and how they change it (as course/types.ts PartApi, for a part that is always drafted). */
export type SitePartApi<V extends Record<string, unknown> = Record<string, unknown>> = {
  fields: V;
  /** Live's value of the part, as the page read it: what the public page shows (a list's row is „· avaldamata“ where it differs from its live row). */
  live: V;
  /** A typed change: saved 1.5 s after the last one, or when the field is left (`flush`). */
  set<K extends keyof V & string>(name: K, value: V[K]): void;
  /**
   * A change worked out from the field as it is when it lands (`fn` gets it then: an upload that ends after other changes adds to the list as it is
   * by then); a list's rows added, removed or moved save now, a text typed in a row waits.
   */
  update<K extends keyof V & string>(name: K, fn: (current: V[K]) => V[K]): void;
  /** An instant change (a choice, a row added, moved or removed, a picture uploaded): `value` taken, if given, and saved now (README §1.3). */
  commit<K extends keyof V & string>(name: K, value?: V[K]): void;
  /** Saves now (a field left); true when the server holds the part's text (false: held back, failed, in conflict). */
  flush(): Promise<boolean>;
  /** The words of a field's refusal (its check), or undefined. */
  error(name: string): string | undefined;
  /** The value the field's refusal was for: what the refused save sent (undefined: no refusal). A list's refusal is placed on its rows by their keys. */
  refusedValue(name: string): unknown;
  /** The field's value waits for „Avalda muudatused“: the draft differs from live there (README §1.8, „· avaldamata“). */
  unpublished(name: string): boolean;
  /** Another tab or device saved this part meanwhile: „Taasta minu tekst“ (`restore`) saves this text over it (README §1.3, B13). */
  conflict: boolean;
  restore(): void;
  /** The part's autosave status (the page makes its one chip of every part's). */
  status: AutosaveStatus;
  /** The part's drafts were thrown away on the server: its copies in this browser go, nothing more is sent (engine.ts discardCopy). */
  discardCopy(): void;
  /** The part needs a look (a field held back, a conflict; on the page also a part the last publish held): its section map entry says „Kontrolli“. */
  attention: boolean;
  /** The saves the server took since the part started (the page lists a part the publish held until its next save). */
  saves: number;
  /** The same, this moment (a press that awaited its own flush reads its save; review I-1). */
  savedNow(): number;
  /** Null when the server holds the part's text; else the first field concerned and why (SaveStatus's „Näita“). */
  unconfirmed(): Unconfirmed | null;
  /** The part's version as the server last confirmed it (engine.ts confirmedVersion): after a flush, that of the text on the screen — the publish sends it. */
  versionNow(): string;
  /**
   * The page read again holds `value` for the field `name`, which a rule of the server set (piece 4b R-g: a post's address that follows its title, made
   * from the new title, numbered when taken): taken as the field's saved text, nothing sent, only while nothing typed in it waits (engine.ts adopt).
   */
  adopt(name: string, value: unknown): void;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errors = adminEt.courseEditor.errors as Record<string, string>;

/** The words of a refusal's code: the editors' field errors (domain/field-check.ts codes); anything else, the generic line. */
export const refusalText = (code: string): string => errors[code] ?? adminEt.courseEditor.invalid;

/**
 * A refused list placed on its rows (README B2, §4: a list's errors keyed by row id, not by its place; course/TestCard.tsx placeOf's way): the server's
 * own loose check (domain/site-checks.ts, `problemsOf`) run over the list the refused save sent (`sent`: the part's refusedValue), each row's problems
 * — its fields' codes, by the field's name in the row — by the row's key, so they land on that row wherever it is now (moved, or with rows added
 * before it while the save was on its way). `path(j)` is the row's name in the check's names (`slides.2`).
 */
export function rowRefusals<R>(sent: unknown, problemsOf: (rows: R[]) => Record<string, string>, keyOf: (row: R) => string, path: (j: number) => string): Map<string, Record<string, string>> {
  const placed = new Map<string, Record<string, string>>();
  if (!Array.isArray(sent)) return placed;
  const problems = problemsOf(sent as R[]);
  (sent as R[]).forEach((row, j) => {
    const prefix = `${path(j)}.`;
    const own = Object.fromEntries(Object.entries(problems).flatMap(([name, code]) => (name.startsWith(prefix) ? [[name.slice(prefix.length), code]] : [])));
    if (Object.keys(own).length > 0 && !placed.has(keyOf(row))) placed.set(keyOf(row), own);
  });
  return placed;
}

/**
 * The event a site editor's row hears when a field it holds out of sight is to be focused (focusSiteField): Avaleht's closed slide, a folded answer.
 * The row carries `data-reveals`, the start of the names of the controls it hides (`slides.2`, `faq.1.a`), and `data-invalid` while one of them is
 * refused; `detail.name` is the control's name (`slides.2.title`), or the row's own when the field is not known (then its first refused field). The
 * editor opens the row and puts the focus in that control once it is on the page.
 */
export const REVEAL_FIELD = "site-reveal-field";
export type RevealDetail = { name: string };

/**
 * The control of a part's field on the page (see the top of the file), focused: `row` given (a list field's row, by its place in the draft), that
 * row's control `sub` (the field in the row), or the row that holds it out of sight, opened on it (REVEAL_FIELD), or the row's first control; else
 * the field's own, its first control held back, a row out of sight that holds one (opened on it), its first control; else the page's first control
 * held back.
 */
export function focusSiteField(part: string, field: string, row: number | null = null, sub: string | null = null): void {
  const page = document.querySelector("[data-site-editor]") ?? document;
  const names = [`${part}.${field}`, field];
  const named = (n: string, more = "") => page.querySelector<HTMLElement>(`[data-i18n="${n}"]${more}, [data-field="${n}"]${more}`);
  const under = (n: string, more = "") => page.querySelector<HTMLElement>(`[data-i18n^="${n}."]${more}, [data-field^="${n}."]${more}`);
  const hidden = () => Array.from(page.querySelectorAll<HTMLElement>("[data-reveals]"));
  const reveal = (holder: HTMLElement, name: string) => void holder.dispatchEvent(new CustomEvent<RevealDetail>(REVEAL_FIELD, { bubbles: true, detail: { name } }));
  if (row !== null)
    for (const n of names) {
      const cell = `${n}.${row}`;
      const want = sub === null ? cell : `${cell}.${sub}`;
      const exact = named(want);
      if (exact) return exact.focus();
      const holder = hidden().find((el) => {
        const v = el.dataset.reveals ?? "";
        return want === v || want.startsWith(`${v}.`);
      });
      if (holder) return reveal(holder, want);
      const near = named(cell) ?? under(cell);
      if (near) return near.focus();
    }
  const target = names.map((n) => named(n)).find(Boolean) ?? names.map((n) => under(n, '[aria-invalid="true"]')).find(Boolean);
  if (target) return target.focus();
  // a refused control in a row out of sight (a closed slide): the row opens on it
  const refused = hidden().find((el) => el.hasAttribute("data-invalid") && names.some((n) => (el.dataset.reveals ?? "").startsWith(`${n}.`)));
  if (refused) return reveal(refused, refused.dataset.reveals ?? "");
  (names.map((n) => under(n)).find(Boolean) ?? page.querySelector<HTMLElement>('[aria-invalid="true"]'))?.focus();
}

/**
 * A list field's first row that differs from `before` (a row followed by its key `uid` where it has one, else by its place), by its place now, and the
 * row's first field that differs (in the order its labels are listed, domain/site-changes.ts siteRowFields; none for a new row or a plain text row).
 */
function changedCell(entity: SiteDraftEntity, part: string, before: unknown, now: unknown): { row: number; sub: string | null } | null {
  if (!Array.isArray(now)) return null;
  const was = Array.isArray(before) ? before : [];
  const uid = (r: unknown) => (isRecord(r) && typeof r.uid === "string" ? r.uid : null);
  for (let i = 0; i < now.length; i++) {
    const key = uid(now[i]);
    const match: unknown = key === null ? was[i] : was.find((r) => uid(r) === key);
    if (match !== undefined && sameSiteValue(match, now[i])) continue;
    const row: unknown = now[i];
    if (!isRecord(match) || !isRecord(row)) return { row: i, sub: null };
    const order = siteRowFields(entity, part);
    const fields = [...order, ...Object.keys(row).filter((f) => !order.includes(f) && f !== "uid" && f !== "id")];
    return { row: i, sub: fields.find((f) => !sameSiteValue(match[f], row[f])) ?? null };
  }
  return null;
}

/** What a screen may give a part besides its seed (useSitePart's options; SiteEditorPage's `partOptions`). */
export type SitePartOptions = {
  /** A field's name for the leave guard (by default the row-by-row label above). */
  label?: (field: string) => string;
  /** A check of the form's own before a save (the engine holds back the fields it names). */
  validate?: (fields: Fields) => Record<string, string>;
  /** Where a field is (by default focusSiteField). */
  focusField?: (name: string) => void;
  /** The words of a refusal's code at this part's fields (by default refusalText; a post says „See aadress on juba teisel postitusel.“ for `slugTaken`). */
  errorText?: (code: string) => string;
  /** Told after each save the server took: what it sent, and the part's version after it (Uudised reads the page again when the list's row changed). */
  saved?: (patch: Fields, version: string) => void;
};

/**
 * `target`'s part `part` from `seed` (its version, its value, live's value as the page read them), with the options above. All but `saved` are read at
 * mount, as useAutosave reads them: a new seed needs a new mount (a React `key`).
 */
export function useSitePart<V extends Record<string, unknown> = Record<string, unknown>>(o: { target: SiteTarget; part: string; seed: SitePartState } & SitePartOptions): SitePartApi<V> {
  const { target, part, seed } = o;
  const entity = siteRowOf(target).entity;
  // each refused field's code and the value the refused save sent, the saves the server took (../useFieldRefusals.ts, shared with the course cards)
  const { codes, saves, savedNow, hear, clear } = useFieldRefusals();
  const live = useMemo(() => (isRecord(seed.live) ? seed.live : {}), [seed.live]);
  /** The part's value as the server last took it (from the page's read, then each save it took): what the leave guard's label compares with. */
  const confirmed = useRef<Record<string, unknown>>(isRecord(seed.value) ? seed.value : {});
  // the screen's ear for the saves the server took, as it is now
  const heard = useRef(o.saved);
  useLayoutEffect(() => {
    heard.current = o.saved;
  });
  const url = sitePartUrl(target, part);
  const send = useMemo<SendPatch>(() => {
    const base = patchSender(url);
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      const took = answer?.status === 200 && reply?.ok === true;
      if (took) confirmed.current = { ...confirmed.current, ...body.patch };
      hear(body.patch, answer);
      if (took && typeof reply.version === "string") heard.current?.(body.patch, reply.version);
      return answer;
    };
  }, [url, hear]);
  // what the newest render holds: an upload that ends after other changes adds to the list as it is then; and the field's label as it is now
  const latest = useLatestFields(isRecord(seed.value) ? seed.value : {});
  const own = o.label;
  const label = useCallback(
    (field: string) => {
      if (own) return own(field);
      const now = { [field]: latest.now()[field] };
      const first =
        siteChangeLabels(entity, [{ part, live: { [field]: confirmed.current[field] }, draft: now }])[0] ??
        siteChangeLabels(entity, [{ part, live: { [field]: live[field] }, draft: now }])[0];
      return first ?? siteFieldLabel(entity, part, field);
    },
    [own, entity, part, live, latest],
  );
  const auto = useAutosave({
    owner: siteCopyOwner(target),
    key: part,
    version: seed.version,
    fields: (isRecord(seed.value) ? seed.value : {}) as Fields,
    save: send,
    validate: o.validate,
    label,
    // (a list field: the row and the field in it that the label names: the first change since the server's last save, else since live)
    focusField:
      o.focusField ??
      ((name) => {
        const cell = changedCell(entity, part, confirmed.current[name], latest.now()[name]) ?? changedCell(entity, part, live[name], latest.now()[name]);
        focusSiteField(part, name, cell?.row ?? null, cell?.sub ?? null);
      }),
  });

  const fields = auto.fields as V;
  useLayoutEffect(() => {
    latest.move(fields);
  });

  const { setField, flush, restore, conflict, status, discardCopy, unconfirmed, versionNow, adopt } = auto;
  const words = o.errorText ?? refusalText;
  // a field typed in (its refusal's words go, the engine has it); a change worked out from the field as it lands (../useFieldRefusals.ts)
  const { take, update } = useFieldEdits({ latest, setField, flush, clear });
  return useMemo<SitePartApi<V>>(() => {
    return {
      fields,
      live: live as V,
      set: (name, value) => take(name, value),
      update: update as SitePartApi<V>["update"],
      commit: (name: string, ...value: unknown[]) => {
        if (value.length > 0) take(name, value[0]);
        void flush();
      },
      flush: () => flush(),
      error: (name) => (codes[name] ? words(codes[name].code) : undefined),
      refusedValue: (name) => codes[name]?.sent,
      unpublished: (name) => !sameSiteValue((fields as Record<string, unknown>)[name], live[name]),
      conflict: conflict !== null,
      restore: () => void restore(),
      status,
      discardCopy,
      attention: status.kind === "invalid" || status.kind === "conflict" || status.kind === "gone",
      saves,
      savedNow,
      unconfirmed,
      versionNow,
      adopt: (name, value) => void adopt(name, value),
    };
  }, [fields, take, update, flush, restore, conflict, status, discardCopy, unconfirmed, versionNow, adopt, codes, words, live, saves, savedNow]);
}
