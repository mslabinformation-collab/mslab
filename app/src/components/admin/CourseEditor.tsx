"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { courseCardData } from "@/components/site/course-card-data";
import type { CourseCardData } from "@/components/site/CourseCard";
import type { CourseWithImages } from "@/db/queries/public";
import { CERT_LIMITS } from "@/domain/certificate";
import { COURSE_LANGUAGES, LIMITS, type CourseDraft, type CourseLanguage, type CourseLevel, type CourseType } from "@/domain/course-editor";
import { parseEuroCents } from "@/domain/money";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { fill } from "@/i18n/format";
import type { EditResult, FieldError } from "@/server/admin-content";
import { saveCourse } from "@/server/actions/admin-content";
import { BadgeEditor } from "./BadgeEditor";
import { Choice } from "./Choice";
import { GalleryEditor } from "./GalleryEditor";
import { I18nInput } from "./I18nInput";
import { ListEditor } from "./ListEditor";
import { ProtocolStagesEditor } from "./ProtocolStagesEditor";
import { TestEditor } from "./TestEditor";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./CourseEditor.module.css";

export type OtherCourse = { id: number; title: string; type: CourseType; published: boolean };

const cents = (s: string) => (s.trim() ? parseEuroCents(s) : null);

/** The course card of the draft as the catalogue would show it (the real card's data, from the draft's values). */
function previewCard(d: CourseDraft, next: { startsAt: string; city: string } | null): CourseCardData {
  const online = d.type === "e_learning";
  const course = {
    id: d.id ?? 0,
    slug: d.slug || "uus",
    type: d.type,
    level: d.level,
    title: d.title.et.trim() ? d.title : { et: adminEt.courseEditor.newTitle },
    summary: d.summary,
    price: online ? cents(d.price) : null,
    priceGroup: online ? null : cents(d.priceGroup),
    priceIndividual: online ? null : cents(d.priceIndividual),
    badge: d.badge,
    images: d.images.map((img, i) => ({ id: i, courseId: d.id ?? 0, key: img.key, alt: img.alt, sort: i })),
  } as unknown as CourseWithImages;
  return courseCardData(course, next ? { startsAt: new Date(next.startsAt), city: next.city } : undefined, "et", et, (p) => p);
}

type Props = {
  initial: CourseDraft;
  /** The other courses (recommendations). */
  others: OtherCourse[];
  /** The next session of the saved course (the card's meta line). */
  next: { startsAt: string; city: string } | null;
  /** The saved course's public address while it is published ("Vaata lehel"). */
  publicHref: string | null;
  /** Just created (?loodud=1). */
  created: boolean;
  /** The course has sessions or registrations: its type cannot change. */
  typeLocked: boolean;
};

/**
 * The course editor (prototype B editor layout; D badge block): every field of the course, its gallery, badge and
 * recommendations in one draft, saved together with "Salvesta". The type switch shows only that type's fields
 * (e-learning: price, access, videos, next-course discount; contact: group and individual price, duration,
 * "Koolitus sisaldab"). After a save the page reloads the stored course and the draft follows it.
 */
export function CourseEditor({ initial, others, next, publicHref, created, typeLocked }: Props) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initial);
  // the stored course changed (our save, reloaded by the server): the draft becomes the saved version
  if (initial.version !== base.version || initial.id !== base.id) {
    setBase(initial);
    setDraft(initial);
  }
  const [state, action, pending] = useActionState<EditResult | null, FormData>(saveCourse, null);
  const [recNote, setRecNote] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(base), [draft, base]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // a refused save: the first marked field gets the focus
  useEffect(() => {
    if (!state || state.ok || state.error !== "invalid") return;
    const el = form.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]');
    el?.focus();
  }, [state]);

  const fields = state && !state.ok ? (state.fields ?? {}) : {};
  const err = (name: string): string | undefined => {
    const code = fields[name] as FieldError | undefined;
    return code ? t.errors[code] : undefined;
  };
  const set = <K extends keyof CourseDraft>(key: K, value: CourseDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const online = draft.type === "e_learning";
  const card = useMemo(() => previewCard(draft, next), [draft, next]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData();
    fd.set("data", JSON.stringify(draft));
    startTransition(() => action(fd));
  };

  const toggleRecommendation = (id: number) => {
    const has = draft.recommendationIds.includes(id);
    if (!has && draft.recommendationIds.length >= LIMITS.recommendations) return setRecNote(true);
    setRecNote(false);
    set("recommendationIds", has ? draft.recommendationIds.filter((x) => x !== id) : [...draft.recommendationIds, id]);
  };

  /** A plain (one-language) text field with its label, hint and error. */
  const plain = (name: keyof CourseDraft & string, label: string, opts: { hint?: string; inputMode?: "decimal" | "numeric"; maxLength?: number; prefix?: string } = {}) => {
    const id = `${uid}-${name}`;
    const error = err(name);
    const describedBy = [opts.hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
    return (
      <div className={ui.field}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className={ui.input}
          type="text"
          inputMode={opts.inputMode}
          autoComplete="off"
          maxLength={opts.maxLength ?? 40}
          value={draft[name] as string}
          onChange={(e) => set(name, e.target.value as never)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          data-field={name}
        />
        {opts.hint && (
          <p id={`${id}-hint`} className={ui.hint}>
            {opts.hint}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className={ui.error}>
            {error}
          </p>
        )}
      </div>
    );
  };

  const titleText = draft.title.et.trim() || t.newTitle;
  const status: { text: string; tone: "error" | "success" | "hint" } = pending
    ? { text: t.saving, tone: "hint" }
    : state && !state.ok
      ? { text: state.error === "invalid" ? t.invalid : state.error === "stale" ? t.stale : state.error === "notFound" ? t.notFound : adminEt.common.saveError, tone: "error" }
      : dirty
        ? { text: t.dirty, tone: "hint" }
        : state?.ok
          ? { text: t.saved, tone: "success" }
          : { text: "", tone: "hint" };

  return (
    <form ref={form} className={ui.page} onSubmit={submit} noValidate data-course-editor="">
      <div className={ui.heading}>
        <div className={styles.headText}>
          <nav className={styles.crumb} aria-label={t.crumb}>
            <Link href="/admin/koolitused">{t.crumb}</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{draft.id ? t.editCrumb : t.newCrumb}</span>
          </nav>
          <h1 className={`${ui.h1} ${styles.title}`}>{titleText}</h1>
          <div className={styles.tags}>
            <span className={`${ui.tag} ${base.published ? ui.ok : ui.warn}`} data-course-state="">
              {base.published ? adminEt.courses.published : adminEt.courses.draft}
            </span>
            <span className={`${ui.tag} ${online ? ui.dark : ""}`}>{adminEt.courses.type[draft.type]}</span>
            {base.isSample && (
              <span className={`${ui.tag} ${styles.sample}`} title={adminEt.courses.sampleTitle} data-sample="">
                {adminEt.courses.sample}
              </span>
            )}
          </div>
        </div>
        {publicHref && (
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={publicHref} target="_blank" rel="noopener">
            {t.viewSite} ↗
          </a>
        )}
      </div>

      {created && (
        <p className={ui.notice} role="status">
          {t.created}
        </p>
      )}

      <div className={styles.grid}>
        <div className={styles.main}>
          <section className={ui.card} aria-labelledby={`${uid}-basics`}>
            <h2 id={`${uid}-basics`} className={`${ui.h2} ${styles.cardTitle}`}>
              {t.sections.basics}
            </h2>
            <div className={ed.grid}>
              <div className={ed.wide}>
                <I18nInput label={f.title} value={draft.title} onChange={(v) => set("title", v)} maxLength={LIMITS.title} error={err("title")} name="title" />
              </div>
              <div className={ed.wide}>
                {plain("slug", f.slug, { hint: fill(f.slugHint, { slug: draft.slug || "…" }) + (base.id && base.published && draft.slug !== base.slug ? ` ${f.slugChanged}` : ""), maxLength: 80 })}
              </div>
              <fieldset className={ed.fieldset}>
                <legend className={ui.legend}>{f.level}</legend>
                <div className={ed.choices}>
                  {(["basic", "advanced"] as CourseLevel[]).map((l) => (
                    <Choice key={l} className={ed.choice} label={adminEt.courses.level[l]} type="radio" name={`${uid}-level`} value={l} checked={draft.level === l} onChange={() => set("level", l)} />
                  ))}
                </div>
              </fieldset>
              <div className={ui.field}>
                <label htmlFor={`${uid}-language`}>{f.language}</label>
                <select id={`${uid}-language`} className={`${ui.input} ${ed.select}`} value={draft.language} onChange={(e) => set("language", e.target.value as CourseLanguage)}>
                  {COURSE_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className={ed.wide}>
                <I18nInput label={f.summary} value={draft.summary} onChange={(v) => set("summary", v)} multiline rows={2} maxLength={LIMITS.summary} hint={f.summaryHint} error={err("summary")} name="summary" />
              </div>
              <div className={ed.wide}>
                <I18nInput label={f.body} value={draft.body} onChange={(v) => set("body", v)} multiline rows={8} maxLength={LIMITS.body} hint={f.bodyHint} error={err("body")} name="body" />
              </div>
            </div>
          </section>

          <section className={ui.card} aria-labelledby={`${uid}-type`} data-type-section={draft.type}>
            <h2 id={`${uid}-type`} className={`${ui.h2} ${styles.cardTitle}`}>
              {t.sections.type}
            </h2>
            <fieldset
              className={`${ed.fieldset} ${styles.typeSwitch}`}
              aria-describedby={err("type") ? `${uid}-type-hint ${uid}-type-error` : `${uid}-type-hint`}
              data-invalid={err("type") ? "" : undefined}
              tabIndex={err("type") ? -1 : undefined}
            >
              <legend className={ui.legend}>{f.type}</legend>
              <div className={ed.choices} data-type-switch="">
                {(["e_learning", "contact"] as CourseType[]).map((ty) => (
                  <Choice
                    key={ty}
                    className={ed.choice}
                    label={adminEt.courses.type[ty]}
                    type="radio"
                    name={`${uid}-type`}
                    value={ty}
                    checked={draft.type === ty}
                    // a course with sessions, registrations, lessons or access keeps its type (the server refuses the change too)
                    disabled={typeLocked && base.type !== ty}
                    onChange={() => set("type", ty)}
                  />
                ))}
              </div>
              <p id={`${uid}-type-hint`} className={ui.hint} data-type-hint="">
                {typeLocked ? (base.type === "e_learning" ? t.typeLockedOnline : t.errors.typeLocked) : f.typeHint}
              </p>
              {err("type") && (
                <p id={`${uid}-type-error`} className={ui.error}>
                  {fields.type === "typeLocked" && base.type === "e_learning" ? t.typeLockedOnline : err("type")}
                </p>
              )}
            </fieldset>
            {online ? (
              <div className={ed.grid} data-fields="e_learning">
                {plain("price", f.price, { inputMode: "decimal" })}
                {plain("accessMonths", f.accessMonths, { inputMode: "numeric", maxLength: 4 })}
                {plain("videoCount", f.videoCount, { inputMode: "numeric", maxLength: 4 })}
                <div className={ed.wide}>
                  <I18nInput label={f.nextDiscount} value={draft.nextDiscount} onChange={(v) => set("nextDiscount", v)} maxLength={LIMITS.discount} hint={f.nextDiscountHint} error={err("nextDiscount")} name="nextDiscount" />
                </div>
              </div>
            ) : (
              <div className={ed.grid} data-fields="contact">
                {plain("priceGroup", f.priceGroup, { inputMode: "decimal", hint: f.priceGroupHint })}
                {plain("priceIndividual", f.priceIndividual, { inputMode: "decimal", hint: f.priceIndividualHint })}
                <div className={ed.wide}>
                  <I18nInput label={f.durationLabel} value={draft.durationLabel} onChange={(v) => set("durationLabel", v)} maxLength={LIMITS.duration} hint={f.durationHint} error={err("durationLabel")} name="durationLabel" />
                </div>
              </div>
            )}
          </section>

          <section className={ui.card} aria-label={t.sections.outcomes}>
            <ListEditor title={t.sections.outcomes} itemLabel={f.outcomes} hint={f.outcomesHint} items={draft.outcomes} onChange={(v) => set("outcomes", v)} error={err("outcomes")} maxLength={LIMITS.item} multiline name="outcomes" />
          </section>

          {!online && (
            <section className={ui.card} aria-label={t.sections.includes}>
              <ListEditor title={t.sections.includes} itemLabel={f.includes} hint={f.includesHint} items={draft.includes} onChange={(v) => set("includes", v)} error={err("includes")} maxLength={LIMITS.item} multiline name="includes" />
            </section>
          )}

          {/* "Protokolli punktid": a contact course's protocol headings (phase protocols); an e-course's practical points with their own texts (e-course completion, spec §5.1) */}
          <section className={ui.card} aria-label={t.sections.protocolStages}>
            <ProtocolStagesEditor
              items={draft.protocolStages}
              onChange={(v) => set("protocolStages", v)}
              error={err("protocolStages")}
              hint={online ? f.protocolStagesHintOnline : undefined}
              empty={online ? f.protocolStagesEmptyOnline : undefined}
            />
          </section>

          {/* "Teadmiste test" (e-course completion, spec §5.1, R1): an e-course's questions, pass mark and tries, saved with the course */}
          {online && (
            <section className={ui.card} aria-label={t.sections.test}>
              <TestEditor
                value={draft.test}
                onChange={(v) => set("test", v)}
                errors={{ test: err("test"), testPassPercent: err("testPassPercent"), testTries: err("testTries"), at: state && !state.ok ? state.at : undefined }}
              />
            </section>
          )}

          {/* "Tunnistus" (phase 3d, spec §6): an e-course certificate's lines (none: its "Õpiväljundid" are printed) and its volume, saved with the course */}
          {online && (
            <section className={ui.card} aria-labelledby={`${uid}-certificate`} data-certificate-card="">
              <h2 id={`${uid}-certificate`} className={`${ui.h2} ${styles.cardTitle}`}>
                {t.sections.certificate}
              </h2>
              <div className={styles.certificate}>
                <p className={ui.muted}>{f.certificateLead}</p>
                <ProtocolStagesEditor
                  kind="skills"
                  items={draft.certificateSkills}
                  onChange={(v) => set("certificateSkills", v)}
                  error={err("certificateSkills")}
                  hint={f.certificateSkillsHint}
                  empty={f.certificateSkillsEmpty}
                />
                {plain("certificateVolume", f.certificateVolume, { hint: f.certificateVolumeHint, maxLength: CERT_LIMITS.volume })}
              </div>
            </section>
          )}

          <section className={ui.card} aria-labelledby={`${uid}-gallery`}>
            <h2 id={`${uid}-gallery`} className={`${ui.h2} ${styles.cardTitle}`}>
              {t.sections.gallery}
            </h2>
            <GalleryEditor images={draft.images} onChange={(update) => setDraft((d) => ({ ...d, images: update(d.images) }))} error={err("images")} hint={f.galleryHint} />
          </section>

          <section className={ui.card} aria-labelledby={`${uid}-recs`}>
            <h2 id={`${uid}-recs`} className={`${ui.h2} ${styles.cardTitle}`}>
              {t.sections.recommendations}
            </h2>
            <fieldset className={ed.fieldset} data-recommendations="" data-invalid={err("recommendationIds") ? "" : undefined} tabIndex={err("recommendationIds") ? -1 : undefined}>
              <legend className={ui.sr}>{t.sections.recommendations}</legend>
              <p className={ui.hint}>{f.recommendationsHint}</p>
              <ul className={ed.picks}>
                {others.map((c) => (
                  <li key={c.id}>
                    <Choice
                      className={ed.pick}
                      label={c.title}
                      labelClassName={ed.pickName}
                      type="checkbox"
                      value={c.id}
                      checked={draft.recommendationIds.includes(c.id)}
                      onChange={() => toggleRecommendation(c.id)}
                      data-recommend={c.id}
                    >
                      <span className={ed.pickTags}>
                        <span className={`${ui.tag} ${c.type === "e_learning" ? ui.dark : ""}`}>{adminEt.courses.type[c.type]}</span>
                        {!c.published && <span className={`${ui.tag} ${ui.warn}`}>{adminEt.courses.draft}</span>}
                      </span>
                    </Choice>
                  </li>
                ))}
              </ul>
              <p role="status" className={recNote || err("recommendationIds") ? ui.error : ui.hint}>
                {recNote || err("recommendationIds") ? f.recommendationsMax : fill(f.recommendationsCount, { n: draft.recommendationIds.length })}
              </p>
            </fieldset>
          </section>
        </div>

        <aside className={styles.side}>
          <section className={ui.card} aria-labelledby={`${uid}-publish`}>
            <h2 id={`${uid}-publish`} className={`${ui.h3} ${styles.cardTitle}`}>
              {t.sections.publish}
            </h2>
            <Choice
              className={ed.check}
              label={f.published}
              hint={f.publishedHint}
              hintClassName={`${ui.muted} ${ui.small}`}
              type="checkbox"
              value="1"
              checked={draft.published}
              onChange={(e) => set("published", e.target.checked)}
              data-field="published"
            />
            <Choice
              className={ed.check}
              label={f.sample}
              hint={f.sampleHint}
              hintClassName={`${ui.muted} ${ui.small}`}
              type="checkbox"
              value="1"
              checked={draft.isSample}
              onChange={(e) => set("isSample", e.target.checked)}
              data-field="isSample"
            />
          </section>

          <section className={ui.card} aria-label={adminEt.badge.title}>
            <BadgeEditor value={draft.badge} onChange={(b) => set("badge", b)} card={card} error={err("badge")} />
          </section>
        </aside>
      </div>

      <div className={styles.saveBar} data-save-bar="">
        <p role="status" className={status.tone === "error" ? ui.error : status.tone === "success" ? ui.success : ui.hint} data-save-status="">
          {status.text}
          {state && !state.ok && state.error === "stale" && (
            <>
              {" "}
              <a className={ui.link} href={draft.id ? `/admin/koolitused/${draft.id}` : "/admin/koolitused"}>
                {t.reload}
              </a>
            </>
          )}
        </p>
        <button type="submit" className={ui.btn} aria-disabled={pending || undefined}>
          {pending ? t.saving : t.save}
        </button>
      </div>
    </form>
  );
}
