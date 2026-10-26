"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { patchSender, type Fields, type SendPatch, type Unconfirmed } from "@/components/admin/autosave/engine";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import type { AutosaveStatus } from "@/domain/autosave";
import { sameSiteValue, siteChangeLabels, siteFieldLabel } from "@/domain/site-changes";
import { SITE_ENTITY_ID, type SiteEntity, type SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { listChange } from "../course/course-view";

// One part's autosave on a site editor (admin UX pass piece 4a, Task 2; README §1.3, B2; rulings R-a, R-b, R-d): the shared engine (autosave/
// useAutosave.ts, used as it is) on POST /api/admin/sisu/<entity>/0/osa/<part> (server/site-drafts.ts writeSitePart: every save goes to the part's
// draft, under the loose check), from the part's version the page read. As useCoursePart does for a course's card: a 400's field codes are kept
// with the value each refused field was sent with (the engine holds those fields back and saves the rest), so a card can say at the field what was
// refused and a list can place it on the row it is about (by the row's key in what was sent); a field typed in again or saved loses its words.
// The copy in this browser is `mslab-draft:site:<entity>:<part>:<tab>`.
//
// A field the leave guard names („Muudatust „Slaid 2 pealkiri“ ei saanud veel salvestada.“, piece4-texts S4-1 note) is named row by row, as the
// PublishBar names it: the first change of that field since its last save the server took (else since live), by domain/site-changes.ts.
//
// Where the fields are on the page (the leave guard's „Jää siia“, SaveStatus's „Näita“): a part's field is the control named `<part>.<field>` (a
// record part's: `MAXI.price`, `trainer.name`) or `<field>` (a list part's rows: `slides.2.title`), as `data-i18n` (I18nInput) or `data-field`
// (TextField); else the field's first control held back (`aria-invalid`).

/** The engine's owner of a site entity's copies in this browser (`mslab-draft:site:<entity>:<part>:<tab>`). */
export const siteCopyOwner = (entity: SiteEntity): string => `site:${entity}`;

/** The autosave route of an entity's part. */
export const sitePartUrl = (entity: SiteEntity, part: string): string => `/api/admin/sisu/${entity}/${SITE_ENTITY_ID}/osa/${encodeURIComponent(part)}`;

/** A part's way for its cards: what they show and how they change it (as course/types.ts PartApi, for a part that is always drafted). */
export type SitePartApi<V extends Record<string, unknown> = Record<string, unknown>> = {
  fields: V;
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
  /** Null when the server holds the part's text; else the first field concerned and why (SaveStatus's „Näita“). */
  unconfirmed(): Unconfirmed | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errors = adminEt.courseEditor.errors as Record<string, string>;

/** The words of a refusal's code: the editors' field errors (domain/field-check.ts codes); anything else, the generic line. */
const refusalText = (code: string): string => errors[code] ?? adminEt.courseEditor.invalid;

/**
 * The control of a part's field on the page (see the top of the file), focused: `row` given (a list field's row, by its place in the draft), that
 * row's; else the field's own, its first row held back, its first row; else the page's first control held back.
 */
export function focusSiteField(part: string, field: string, row: number | null = null): void {
  const page = document.querySelector("[data-site-editor]") ?? document;
  const names = [`${part}.${field}`, field];
  const named = (n: string, more = "") => page.querySelector<HTMLElement>(`[data-i18n="${n}"]${more}, [data-field="${n}"]${more}`);
  const under = (n: string, more = "") => page.querySelector<HTMLElement>(`[data-i18n^="${n}."]${more}, [data-field^="${n}."]${more}`);
  const target =
    (row === null ? null : names.map((n) => named(`${n}.${row}`) ?? under(`${n}.${row}`)).find(Boolean)) ??
    names.map((n) => named(n)).find(Boolean) ??
    names.map((n) => under(n, '[aria-invalid="true"]')).find(Boolean) ??
    names.map((n) => under(n)).find(Boolean) ??
    page.querySelector<HTMLElement>('[aria-invalid="true"]');
  target?.focus();
}

/** A list field's first row that differs from `before` (a row followed by its key `uid` where it has one, else by its place), by its place now. */
function changedRow(before: unknown, now: unknown): number | null {
  if (!Array.isArray(now)) return null;
  const was = Array.isArray(before) ? before : [];
  const uid = (r: unknown) => (isRecord(r) && typeof r.uid === "string" ? r.uid : null);
  for (let i = 0; i < now.length; i++) {
    const key = uid(now[i]);
    const match = key === null ? was[i] : was.find((r) => uid(r) === key);
    if (match === undefined || !sameSiteValue(match, now[i])) return i;
  }
  return null;
}

/**
 * `entity`'s part `part` from `seed` (its version, its value, live's value as the page read them). `label`: a field's name for the leave guard (by
 * default the row-by-row label above); `validate`: a check of the form's own before a save (the engine holds back the fields it names); `focusField`:
 * where a field is (by default focusSiteField). All are read at mount, as useAutosave reads them: a new seed needs a new mount (a React `key`).
 */
export function useSitePart<V extends Record<string, unknown> = Record<string, unknown>>(o: {
  entity: SiteEntity;
  part: string;
  seed: SitePartState;
  label?: (field: string) => string;
  validate?: (fields: Fields) => Record<string, string>;
  focusField?: (name: string) => void;
}): SitePartApi<V> {
  const { entity, part, seed } = o;
  /** Each refused field's code and the value the refused save sent. */
  const [codes, setCodes] = useState<Record<string, { code: string; sent: unknown }>>({});
  const [saves, setSaves] = useState(0);
  const live = useMemo(() => (isRecord(seed.live) ? seed.live : {}), [seed.live]);
  /** The part's value as the server last took it (from the page's read, then each save it took): what the leave guard's label compares with. */
  const confirmed = useRef<Record<string, unknown>>(isRecord(seed.value) ? seed.value : {});
  const send = useMemo<SendPatch>(() => {
    const base = patchSender(sitePartUrl(entity, part));
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const named = Object.fromEntries(
          Object.entries(reply.fields)
            .filter(([name, code]) => name in body.patch && typeof code === "string")
            .map(([name, code]) => [name, { code: code as string, sent: body.patch[name] }]),
        );
        setCodes((c) => ({ ...c, ...named }));
      } else if (answer?.status === 200 && reply?.ok === true) {
        setCodes((c) => Object.fromEntries(Object.entries(c).filter(([name]) => !(name in body.patch))));
        confirmed.current = { ...confirmed.current, ...body.patch };
        setSaves((n) => n + 1);
      }
      return answer;
    };
  }, [entity, part]);
  // what the newest render holds: an upload that ends after other changes adds to the list as it is then; and the field's label as it is now
  const latest = useRef<Record<string, unknown>>(isRecord(seed.value) ? seed.value : {});
  const own = o.label;
  const label = useCallback(
    (field: string) => {
      if (own) return own(field);
      const now = { [field]: latest.current[field] };
      const first =
        siteChangeLabels(entity, [{ part, live: { [field]: confirmed.current[field] }, draft: now }])[0] ??
        siteChangeLabels(entity, [{ part, live: { [field]: live[field] }, draft: now }])[0];
      return first ?? siteFieldLabel(entity, part, field);
    },
    [own, entity, part, live],
  );
  const auto = useAutosave({
    owner: siteCopyOwner(entity),
    key: part,
    version: seed.version,
    fields: (isRecord(seed.value) ? seed.value : {}) as Fields,
    save: send,
    validate: o.validate,
    label,
    // (a list field: the row it names, as the label does)
    focusField: o.focusField ?? ((name) => focusSiteField(part, name, changedRow(confirmed.current[name], latest.current[name]) ?? changedRow(live[name], latest.current[name]))),
  });

  const fields = auto.fields as V;
  useLayoutEffect(() => {
    latest.current = fields;
  });

  const { setField, flush, restore, conflict, status, discardCopy, unconfirmed } = auto;
  return useMemo<SitePartApi<V>>(() => {
    /** A field typed in: its refusal's words go, and the engine has it. */
    const take = (name: string, value: unknown) => {
      setCodes((c) => (name in c ? Object.fromEntries(Object.entries(c).filter(([n]) => n !== name)) : c));
      setField(name, value);
    };
    return {
      fields,
      set: (name, value) => take(name, value),
      update: (name, fn) => {
        const before = latest.current[name];
        const after = (fn as (current: unknown) => unknown)(before);
        latest.current = { ...latest.current, [name]: after };
        take(name, after);
        if (Array.isArray(before) && Array.isArray(after) && listChange(before, after) === "instant") void flush();
      },
      commit: (name: string, ...value: unknown[]) => {
        if (value.length > 0) take(name, value[0]);
        void flush();
      },
      flush: () => flush(),
      error: (name) => (codes[name] ? refusalText(codes[name].code) : undefined),
      refusedValue: (name) => codes[name]?.sent,
      unpublished: (name) => !sameSiteValue((fields as Record<string, unknown>)[name], live[name]),
      conflict: conflict !== null,
      restore: () => void restore(),
      status,
      discardCopy,
      attention: status.kind === "invalid" || status.kind === "conflict" || status.kind === "gone",
      saves,
      unconfirmed,
    };
  }, [fields, setField, flush, restore, conflict, status, discardCopy, unconfirmed, codes, live, saves]);
}
