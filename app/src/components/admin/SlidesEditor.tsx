"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { moveItem } from "@/domain/course-editor";
import { sameSiteValue } from "@/domain/site-changes";
import { mobileFocalForTone, newSlideDraft, SITE_LIMITS, type SlideDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { Choice } from "./Choice";
import { DragList } from "./DragList";
import { useEditLang } from "./EditLang";
import { FocalPoint } from "./FocalPoint";
import { focusFell } from "./focus-fell";
import { I18nInput, lacksRu } from "./I18nInput";
import { UploadNotes, UploadPicker, useImageUpload } from "./ImageUpload";
import { insertAt } from "./row-keys";
import { TextField } from "./TextField";
import { useListRows } from "./useListRows";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./HomeEditor.module.css";

// Avaleht's „Slaidid“ (admin UX pass piece 4a, Task 6; README §4 C1 "the slide row is drag | thumbnail 72×48 | ET title + RU line | Hele/Tume tag |
// ↑/↓. Errors are keyed by row id", the Part 3 template's row `24px | 72px | 1fr | 80px | 96px`, the Part 4 C1 frame's open slide; piece4-texts S4-9,
// S4-10, S4-3; builder notes §5 "a slide opens inline, one at a time" and the fields the mocks leave out stay). Each slide is a row (DragList: the
// handle, ↑ / ↓, a drag with a finger or the mouse); its button opens it inline, one at a time (the open one closes): a 1 px ink box with the handle,
// the picture with its focal dot and „Puuduta pilti, et valida fookus · Vaheta pilt“ (both views' focal points kept), and the fields — „Pealkiri“,
// „Alapealkiri“, the kicker, the button's text and link, „Näidatakse avalehel“, the tone „Hele“ | „Tume“ — and „Eemalda slaid“, which takes it out at
// once with the UndoBar „Slaid eemaldatud.“ (its „Võta tagasi“ puts it back at its place). „+ Lisa slaid“ opens a new slide at the end, up to 8.

let added = 0;

/** The slide's texts in two languages, in the order they stand in its box. */
const RU_FIELDS = ["title", "text", "kicker", "ctaLabel"] as const;
type RuField = (typeof RU_FIELDS)[number];

const firstLine = (s: string) => s.split("\n").join(" ").trim();

/**
 * A closed slide's fields are not on the page (the box mounts when the slide is opened), so the ones that have Estonian text and no Russian tell the
 * page themselves: „RU puudub {n} väljal“ counts them and „Järgmine →“ opens the slide and puts the cursor in the field. An open slide's fields
 * register for themselves (I18nInput), so this stands only for the closed ones. It renders nothing.
 */
function CollapsedRu({ slide, anchor, reveal }: { slide: SlideDraft; anchor: string; reveal: (key: string, field: RuField) => void }) {
  const { register } = useEditLang();
  const missing = RU_FIELDS.filter((f) => lacksRu(slide[f])).join(",");
  const key = slide.uid;
  useEffect(() => {
    const off = (missing ? missing.split(",") : []).map((f) => register(`${anchor}-${f}`, true, () => reveal(key, f as RuField), anchor));
    return () => off.forEach((undo) => undo());
  }, [register, anchor, missing, reveal, key]);
  return null;
}

export type SlidesEditorProps = {
  slides: SlideDraft[];
  /** Live's slides: a field of a slide that is live too says „· avaldamata“ where it differs from it (README §1.8). */
  live?: readonly SlideDraft[];
  /**
   * A change of the slides, worked out from the list as it is when it lands (an upload that ends after a move still finds its slide by its key).
   * `now`: saved at once (a choice, a picture); rows added, moved or removed save at once anyway (the part's update), a text typed waits.
   */
  onUpdate: (fn: (slides: SlideDraft[]) => SlideDraft[], now?: boolean) => void;
  /** Each slide's refused fields, in words, by the slide's key (`uid`): placed on that slide wherever it is now (README B2, §4 C1). */
  errors?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** A refusal of the list as a whole (more than 8), under the rows. */
  error?: string;
  /** Link suggestions for the button (site pages and courses). */
  links: string[];
};

/** Where the focus goes after the next render: a slide's box, one of its fields, its row's button (after an undo), or „+ Lisa slaid“. */
type Focus = { uid: string; what: "box" | "opener" | RuField } | "add" | null;

/**
 * The slides' rows and the one open slide, with „+ Lisa slaid“ first (the card draws it at the right of its title, as the frame does). It renders no
 * wrapper of its own around the button: the card lays it out (HomeEditor.module.css).
 */
export function SlidesEditor({ slides, live, onUpdate, errors, error, links }: SlidesEditorProps) {
  const t = adminEt.home.slides;
  const uid = useId();
  /** The open slide's key: one at a time, none at first. */
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const focus = useRef<Focus>(null);
  const { change, offer } = useListRows<SlideDraft>({ owner: "slides", items: slides, onUpdate: (fn) => onUpdate(fn) });

  // a refused save opens the first slide it refused (once per refusal: she may open another one meanwhile)
  const [seenErrors, setSeenErrors] = useState(errors);
  if (errors !== seenErrors) {
    setSeenErrors(errors);
    const refused = slides.find((s) => errors?.has(s.uid));
    if (refused) setOpen(refused.uid);
  }

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target === "add") return addBtn.current?.focus();
    const row = root.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(target.uid)}"]`);
    if (!row) return;
    if (target.what === "box") return row.querySelector<HTMLElement>("[data-slide-box]")?.focus();
    // (after an undo: only when the focus has nowhere else to be)
    if (target.what === "opener") return void (focusFell() && row.querySelector<HTMLElement>("[data-slide-open]")?.focus());
    // a field (a new slide's title; „Järgmine →“'s Russian text): the cursor in it, the field in the middle of the screen
    const i = slides.findIndex((s) => s.uid === target.uid);
    const field = row.querySelector<HTMLElement>(`[data-i18n="slides.${i}.${target.what}"]`);
    field?.focus({ preventScroll: true });
    field?.scrollIntoView?.({ block: "center" });
  });

  /** Opens a slide (the open one closes) and puts the focus in its box. */
  const openSlide = (key: string) => {
    focus.current = { uid: key, what: "box" };
    setOpen(key);
  };
  /** „Järgmine →“ at a closed slide's field: the slide opens, the cursor goes into the field's Russian text. */
  const reveal = useCallback((key: string, field: RuField) => {
    focus.current = { uid: key, what: field };
    setOpen(key);
  }, []);
  /** A slide's fields, found by its key; `now`: saved at once. */
  const edit = (key: string, patch: Partial<SlideDraft>, now = false) => onUpdate((list) => list.map((s) => (s.uid === key ? { ...s, ...patch } : s)), now);
  const move = (from: number, to: number) => change((list) => moveItem(list, from, to));
  const remove = (i: number) => {
    const slide = slides[i];
    const next = slides[i + 1] ?? slides[i - 1];
    focus.current = next ? { uid: next.uid, what: "opener" } : "add";
    if (open === slide.uid) setOpen(null);
    change((list) => list.filter((s) => s.uid !== slide.uid));
    // back at its place with its key, unless it is in the list again already
    offer(
      t.removed,
      (list) => (list.some((s) => s.uid === slide.uid) ? list : insertAt(list, i, slide)),
      () => void (focus.current = { uid: slide.uid, what: "opener" }),
    );
  };
  const full = slides.length >= SITE_LIMITS.slides;
  const add = () => {
    if (full) return;
    const slide = newSlideDraft(`new-${Date.now().toString(36)}-${++added}`);
    focus.current = { uid: slide.uid, what: "title" };
    setOpen(slide.uid);
    change((list) => [...list, slide]);
  };

  return (
    <>
      <button
        ref={addBtn}
        type="button"
        className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.addSlide}`}
        onClick={add}
        aria-disabled={full || undefined}
        aria-describedby={full ? `${uid}-max` : undefined}
        data-add-slide=""
      >
        + {t.add}
      </button>
      <div ref={root} className={styles.slides} data-slides-editor="">
        {slides.length === 0 ? (
          <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
        ) : (
          <DragList
            items={slides}
            keyOf={(s) => s.uid}
            label={() => ""}
            arrowNames={(n) => ({ up: fill(t.up, { n }), down: fill(t.down, { n }) })}
            onMove={move}
            className={styles.slideList}
            renderRow={(s, i, handle, arrows) => {
              const n = i + 1;
              const anchor = `${uid}-${s.uid}`;
              if (open !== s.uid)
                return (
                  <div id={anchor} className={styles.slideRow} data-slide={s.uid} data-tone={s.tone}>
                    <CollapsedRu slide={s} anchor={anchor} reveal={reveal} />
                    <span className={styles.grip}>{handle}</span>
                    <button type="button" className={styles.opener} onClick={() => openSlide(s.uid)} data-slide-open="">
                      <span className={ui.sr}>{fill(t.slide, { n })}: </span>
                      {s.imageKey ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a thumbnail of an upload
                        <img className={styles.thumb} src={mediaUrl(s.imageKey)} alt="" style={{ objectPosition: s.imagePos }} data-slide-thumb="" />
                      ) : (
                        <span className={styles.thumb} aria-hidden="true" data-slide-thumb="" />
                      )}
                      <span className={styles.rowText}>
                        <b className={styles.rowTitle} data-slide-title="">
                          {firstLine(s.title.et) || t.untitled}
                        </b>
                        <span className={styles.ruLine} data-slide-ru="">
                          {fill(t.ru, { title: firstLine(s.title.ru ?? "") || adminEt.sectionMap.ru })}
                        </span>
                      </span>
                      <span className={styles.tags}>
                        <span className={styles.tone} data-dark={s.tone === "dark" || undefined} data-slide-tone="">
                          {s.tone === "dark" ? t.dark : t.light}
                        </span>
                        {!s.active && <span className={`${ui.tag} ${ui.warn}`}>{t.hidden}</span>}
                      </span>
                    </button>
                    <span className={styles.rowTools}>{arrows}</span>
                  </div>
                );
              return (
                <OpenSlide
                  anchor={anchor}
                  slide={s}
                  live={live?.find((x) => x.uid === s.uid)}
                  n={n}
                  handle={handle}
                  errors={errors?.get(s.uid)}
                  links={links}
                  onEdit={(patch, now) => edit(s.uid, patch, now)}
                  onRemove={() => remove(i)}
                />
              );
            }}
          />
        )}
      </div>
      {error && <p className={ui.error}>{error}</p>}
      {full && (
        <p id={`${uid}-max`} className={`${ui.muted} ${ui.small}`}>
          {t.max}
        </p>
      )}
    </>
  );
}

/**
 * The open slide (the Part 4 C1 frame): a box of three columns, the handle, the picture and the fields (one under another on a phone). Its fields'
 * names are the slide's place in the list (`slides.2.title`: the shell's convention, which „Jää siia“ and „Näita“ find). A field of a slide that is
 * live too is „· avaldamata“ where it differs from its live slide; a new slide's are not (the card's title says the list changed).
 */
function OpenSlide({
  anchor,
  slide: s,
  live,
  n,
  handle,
  errors,
  links,
  onEdit,
  onRemove,
}: {
  anchor: string;
  slide: SlideDraft;
  live: SlideDraft | undefined;
  n: number;
  handle: ReactNode;
  errors: Readonly<Record<string, string>> | undefined;
  links: string[];
  onEdit: (patch: Partial<SlideDraft>, now?: boolean) => void;
  onRemove: () => void;
}) {
  const t = adminEt.home.slides;
  const p = `slides.${n - 1}.`;
  const changed = (f: keyof SlideDraft) => live !== undefined && !sameSiteValue(s[f], live[f]);
  const err = (f: keyof SlideDraft) => errors?.[f];
  return (
    <div id={anchor} className={styles.openSlide} data-slide={s.uid} data-tone={s.tone} data-open="">
      <div className={styles.box} role="group" aria-label={fill(t.slide, { n })} tabIndex={-1} data-slide-box="">
        <span className={styles.grip}>{handle}</span>
        <SlideMedia slide={s} n={n} error={err("imageKey")} focalError={err("imagePos") ?? err("imagePosMobile")} onEdit={onEdit} />
        <div className={styles.fields} data-slide-fields="">
          <I18nInput
            label={t.titleField}
            value={s.title}
            onChange={(title) => onEdit({ title })}
            multiline
            rows={2}
            maxLength={SITE_LIMITS.slideTitle}
            hint={t.titleHint}
            error={err("title")}
            name={`${p}title`}
            unpublished={changed("title")}
          />
          <I18nInput
            label={t.text}
            value={s.text}
            onChange={(text) => onEdit({ text })}
            multiline
            rows={3}
            maxLength={SITE_LIMITS.slideText}
            error={err("text")}
            name={`${p}text`}
            unpublished={changed("text")}
          />
          <I18nInput
            label={t.kicker}
            value={s.kicker}
            onChange={(kicker) => onEdit({ kicker })}
            maxLength={SITE_LIMITS.slideKicker}
            error={err("kicker")}
            name={`${p}kicker`}
            unpublished={changed("kicker")}
          />
          <I18nInput
            label={t.ctaLabel}
            value={s.ctaLabel}
            onChange={(ctaLabel) => onEdit({ ctaLabel })}
            maxLength={SITE_LIMITS.ctaLabel}
            hint={t.ctaLabelHint}
            error={err("ctaLabel")}
            name={`${p}ctaLabel`}
            unpublished={changed("ctaLabel")}
          />
          <TextField
            label={t.ctaHref}
            value={s.ctaHref}
            onChange={(ctaHref) => onEdit({ ctaHref })}
            maxLength={SITE_LIMITS.href}
            hint={t.ctaHrefHint}
            error={err("ctaHref")}
            inputMode="url"
            suggestions={links}
            name={`${p}ctaHref`}
            unpublished={changed("ctaHref")}
          />
          <Choice
            className={ed.check}
            label={t.active}
            hint={t.activeHint}
            hintClassName={`${ui.muted} ${ui.small}`}
            type="checkbox"
            value="1"
            checked={s.active}
            onChange={(e) => onEdit({ active: e.target.checked }, true)}
          />
          <div className={styles.toneLine}>
            <fieldset className={styles.toneSet} data-tone-switch="">
              <legend className={ui.sr}>{t.tone}</legend>
              <span className={styles.pills}>
                {(["light", "dark"] as const).map((tone) => (
                  <label key={tone} className={styles.pill}>
                    <input
                      type="radio"
                      name={`${anchor}-tone`}
                      value={tone}
                      checked={s.tone === tone}
                      onChange={() => onEdit({ tone, imagePosMobile: mobileFocalForTone(s.imagePosMobile, tone) }, true)}
                    />
                    <span>{tone === "dark" ? t.dark : t.light}</span>
                  </label>
                ))}
              </span>
            </fieldset>
            <button type="button" className={styles.removeSlide} aria-label={fill(t.remove, { n })} onClick={onRemove} data-tool="remove">
              {t.removeText}
            </button>
          </div>
          <p className={ui.hint}>{t.toneHint}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The open slide's picture column (the frame: the picture with its focal dot, then „Puuduta pilti, et valida fookus · Vaheta pilt“): FocalPoint with
 * both views (Arvutis 16:9, Telefonis 9:16) and their crop previews, the upload's „Vaheta pilt“ in its hint line (S4-10), the upload's notes under it.
 * An upload saves at once (the slide is found by its key when it lands). No picture yet: „Pilti pole veel valitud.“ and „Vali pilt“.
 */
function SlideMedia({ slide: s, n, error, focalError, onEdit }: { slide: SlideDraft; n: number; error?: string; focalError?: string; onEdit: (patch: Partial<SlideDraft>, now?: boolean) => void }) {
  const t = adminEt.home.slides;
  const im = adminEt.editor.image;
  const id = useId();
  const upload = useImageUpload((keys) => {
    if (keys.length > 0) onEdit({ imageKey: keys[keys.length - 1] }, true);
  });
  const picker = (
    <UploadPicker upload={upload} className={styles.change}>
      {s.imageKey ? im.replace : im.choose}
    </UploadPicker>
  );
  return (
    <div
      className={styles.media}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={error ? `${id}-error` : undefined}
      data-slide-media=""
      data-single-image={`slide-${n}`}
      data-invalid={error ? "" : undefined}
      tabIndex={error ? -1 : undefined}
    >
      <p id={`${id}-label`} className={ui.sr}>
        {t.image}
      </p>
      {s.imageKey ? (
        <FocalPoint
          src={mediaUrl(s.imageKey)}
          titleHidden
          hint={
            <>
              {t.focalHint} · {picker}
            </>
          }
          error={focalError}
          targets={[
            { label: adminEt.editor.focal.desktop, value: s.imagePos, onChange: (imagePos) => onEdit({ imagePos }), ratio: "16 / 9", name: "desktop" },
            { label: adminEt.editor.focal.mobile, value: s.imagePosMobile, onChange: (imagePosMobile) => onEdit({ imagePosMobile }), ratio: "9 / 16", name: "mobile" },
          ]}
        />
      ) : (
        <>
          <p className={styles.noImage}>{im.none}</p>
          <p className={styles.mediaLine}>{picker}</p>
        </>
      )}
      <UploadNotes upload={upload} />
      {error && (
        <p id={`${id}-error`} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
}
