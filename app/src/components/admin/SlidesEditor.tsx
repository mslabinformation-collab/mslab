"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { moveItem } from "@/domain/course-editor";
import { mobileFocalForTone, newSlideDraft, SITE_LIMITS, type SlideDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { Choice } from "./Choice";
import { useEditLang } from "./EditLang";
import { FocalPoint } from "./FocalPoint";
import { I18nInput, lacksRu } from "./I18nInput";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

let added = 0;

/** The slide's texts in two languages, in the order they stand in its body. */
const RU_FIELDS = ["kicker", "title", "text", "ctaLabel"] as const;
type RuField = (typeof RU_FIELDS)[number];

/**
 * A collapsed slide's fields are not on the page (the body mounts when the slide is opened), so the ones that have Estonian text and no
 * Russian tell the page themselves: „RU puudub {n} väljal“ counts them and „Järgmine →“ opens the slide and puts the cursor in the field. An open
 * slide's fields register for themselves (I18nInput), so this stands only for the closed ones. It renders nothing.
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

type Props = {
  slides: SlideDraft[];
  update: (fn: (slides: SlideDraft[]) => SlideDraft[]) => void;
  err: (name: string) => string | undefined;
  hasErrors: (prefix: string) => boolean;
  /** Link suggestions for the button (site pages and courses). */
  links: string[];
};

/**
 * The home page's hero slides (A9): each slide folds open from its row (thumbnail, number, title, tone); ↑ / ↓ order
 * them, × removes one, "Lisa slaid" adds one at the end (at most 8). Inside: the picture and its focal point for
 * desktop and phone, the tone (light / dark: the header and texts follow it), on / off, kicker, title, text and the
 * button. A slide with a refused field opens by itself.
 */
export function SlidesEditor({ slides, update, err, hasErrors, links }: Props) {
  const t = adminEt.home.slides;
  const uid = useId();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  // the element that gets the focus after the next render: a slide's control, or "Lisa slaid"
  const focus = useRef<{ uid: string; tool: string; field?: RuField } | "add" | null>(null);

  // the slides a refused save marked open by themselves (once per refusal; she may fold them again)
  const erroring = slides.filter((_, i) => hasErrors(`slides.${i}.`)).map((s) => s.uid);
  const errorKey = erroring.join(",");
  const [seenErrors, setSeenErrors] = useState("");
  if (errorKey !== seenErrors) {
    setSeenErrors(errorKey);
    if (erroring.length) setOpen((o) => new Set([...o, ...erroring]));
  }

  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target === "add") root.current?.querySelector<HTMLElement>("[data-add-slide]")?.focus();
    else if (target.field) {
      // „Järgmine →“ opened the slide: the cursor goes into the field's Russian text, and the field to the middle of the screen
      const i = slides.findIndex((s) => s.uid === target.uid);
      const field = root.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(target.uid)}"] [data-i18n="slides.${i}.${target.field}"]`);
      field?.focus({ preventScroll: true });
      field?.scrollIntoView?.({ block: "center" });
    } else root.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(target.uid)}"] [data-tool="${target.tool}"]`)?.focus();
  });

  /** „Järgmine →“ at a collapsed slide's field: open the slide (a new Set even when it is open, so the page renders and the cursor follows). */
  const reveal = useCallback((key: string, field: RuField) => {
    focus.current = { uid: key, tool: "toggle", field };
    setOpen((o) => new Set([...o, key]));
  }, []);
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // by the slide's key, not its place: an upload that finishes after a reorder still lands on its own slide
  const edit = (key: string, patch: Partial<SlideDraft>) => update((list) => list.map((s) => (s.uid === key ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= slides.length) return;
    focus.current = { uid: slides[i].uid, tool: dir < 0 ? "up" : "down" };
    update((list) => moveItem(list, i, j));
  };
  const remove = (i: number) => {
    const next = slides[i + 1] ?? slides[i - 1];
    focus.current = next ? { uid: next.uid, tool: "toggle" } : "add";
    update((list) => list.filter((_, j) => j !== i));
  };
  const full = slides.length >= SITE_LIMITS.slides;
  const add = () => {
    if (full) return;
    const slide = newSlideDraft(`new-${Date.now().toString(36)}-${++added}`);
    setOpen((o) => new Set([...o, slide.uid]));
    focus.current = { uid: slide.uid, tool: "toggle" };
    update((list) => [...list, slide]);
  };

  return (
    <div ref={root} className={styles.slides} data-slides-editor="" data-invalid={err("slides") ? "" : undefined} tabIndex={err("slides") ? -1 : undefined}>
      {slides.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.empty}</p>
      ) : (
        <ol className={styles.slideList}>
          {slides.map((s, i) => {
            const n = i + 1;
            const p = `slides.${i}.`;
            const expanded = open.has(s.uid);
            const bodyId = `${uid}-${s.uid}`;
            const firstLine = s.title.et.split("\n").join(" ").trim();
            return (
              <li key={s.uid} id={`${bodyId}-slide`} className={styles.slide} data-slide={s.uid} data-tone={s.tone}>
                {!expanded && <CollapsedRu slide={s} anchor={`${bodyId}-slide`} reveal={reveal} />}
                <div className={styles.slideHead}>
                  <button type="button" className={styles.slideToggle} aria-expanded={expanded} aria-controls={bodyId} onClick={() => toggle(s.uid)} data-tool="toggle">
                    {s.imageKey ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a thumbnail of an upload
                      <img className={styles.slideThumb} src={mediaUrl(s.imageKey)} alt="" style={{ objectPosition: s.imagePos }} />
                    ) : (
                      <span className={styles.slideThumb} aria-hidden="true" />
                    )}
                    <span className={styles.slideName}>
                      <strong>{fill(t.slide, { n })}</strong>
                      <span>{firstLine || t.untitled}</span>
                    </span>
                    <span className={styles.slideTags}>
                      <span className={`${ui.tag} ${s.tone === "dark" ? ui.dark : ""}`} data-slide-tone="">
                        {s.tone === "dark" ? t.dark : t.light}
                      </span>
                      {!s.active && <span className={`${ui.tag} ${ui.warn}`}>{t.hidden}</span>}
                    </span>
                    <span className={styles.chevron} aria-hidden="true">
                      {expanded ? "−" : "+"}
                    </span>
                  </button>
                  <span className={ed.tools}>
                    <button type="button" className={ed.iconBtn} data-tool="up" aria-label={fill(t.up, { n })} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button type="button" className={ed.iconBtn} data-tool="down" aria-label={fill(t.down, { n })} aria-disabled={i === slides.length - 1 || undefined} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button type="button" className={ed.iconBtn} data-tool="remove" aria-label={fill(t.remove, { n })} onClick={() => remove(i)}>
                      ×
                    </button>
                  </span>
                </div>

                {expanded && (
                  <div id={bodyId} className={styles.slideBody}>
                    <div className={styles.slideMedia}>
                      <SingleImage label={t.image} value={s.imageKey} onChange={(imageKey) => edit(s.uid, { imageKey })} error={err(`${p}imageKey`)} ratio="16 / 9" preview={false} name={`slide-${n}`}>
                        {s.imageKey && (
                          <FocalPoint
                            src={mediaUrl(s.imageKey)}
                            error={err(`${p}imagePos`) ?? err(`${p}imagePosMobile`)}
                            targets={[
                              { label: adminEt.editor.focal.desktop, value: s.imagePos, onChange: (imagePos) => edit(s.uid, { imagePos }), ratio: "16 / 9", name: "desktop" },
                              { label: adminEt.editor.focal.mobile, value: s.imagePosMobile, onChange: (imagePosMobile) => edit(s.uid, { imagePosMobile }), ratio: "9 / 16", name: "mobile" },
                            ]}
                          />
                        )}
                      </SingleImage>
                    </div>
                    <div className={styles.slideFields}>
                      <fieldset className={ed.fieldset}>
                        <legend className={ui.legend}>{t.tone}</legend>
                        <div className={ed.choices} data-tone-switch="">
                          {(["light", "dark"] as const).map((tone) => (
                            <Choice key={tone} className={ed.choice} label={tone === "dark" ? t.dark : t.light} type="radio" name={`${bodyId}-tone`} value={tone} checked={s.tone === tone} onChange={() => edit(s.uid, { tone, imagePosMobile: mobileFocalForTone(s.imagePosMobile, tone) })} />
                          ))}
                        </div>
                        <p className={ui.hint}>{t.toneHint}</p>
                      </fieldset>
                      <Choice className={ed.check} label={t.active} hint={t.activeHint} hintClassName={`${ui.muted} ${ui.small}`} type="checkbox" value="1" checked={s.active} onChange={(e) => edit(s.uid, { active: e.target.checked })} />
                      <I18nInput label={t.kicker} value={s.kicker} onChange={(kicker) => edit(s.uid, { kicker })} maxLength={SITE_LIMITS.slideKicker} error={err(`${p}kicker`)} name={`${p}kicker`} />
                      <I18nInput label={t.titleField} value={s.title} onChange={(title) => edit(s.uid, { title })} multiline rows={2} maxLength={SITE_LIMITS.slideTitle} hint={t.titleHint} error={err(`${p}title`)} name={`${p}title`} />
                      <I18nInput label={t.text} value={s.text} onChange={(text) => edit(s.uid, { text })} multiline rows={3} maxLength={SITE_LIMITS.slideText} error={err(`${p}text`)} name={`${p}text`} />
                      <I18nInput label={t.ctaLabel} value={s.ctaLabel} onChange={(ctaLabel) => edit(s.uid, { ctaLabel })} maxLength={SITE_LIMITS.ctaLabel} hint={t.ctaLabelHint} error={err(`${p}ctaLabel`)} name={`${p}ctaLabel`} />
                      <TextField label={t.ctaHref} value={s.ctaHref} onChange={(ctaHref) => edit(s.uid, { ctaHref })} maxLength={SITE_LIMITS.href} hint={t.ctaHrefHint} error={err(`${p}ctaHref`)} inputMode="url" suggestions={links} name={`${p}ctaHref`} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {err("slides") && <p className={ui.error}>{err("slides")}</p>}
      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`} onClick={add} aria-disabled={full || undefined} aria-describedby={full ? `${uid}-max` : undefined} data-add-slide="">
        + {t.add}
      </button>
      {full && (
        <p id={`${uid}-max`} className={`${ui.muted} ${ui.small}`}>
          {t.max}
        </p>
      )}
    </div>
  );
}
