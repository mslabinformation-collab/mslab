"use client";

import { useEffect, useId, useRef } from "react";
import { portraitFraming, SITE_LIMITS, type PageDraft, type StatDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { saveTrainer } from "@/server/actions/admin-site";
import type { TrainerValues } from "@/server/admin-site";
import { LangSwitch } from "./EditLang";
import { FocalPoint } from "./FocalPoint";
import { GalleryEditor } from "./GalleryEditor";
import { I18nInput } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

let added = 0;

/**
 * Koolitaja (T1–T4): the trainer card (portrait with its focal point, name, role, stats), the bio, the works gallery
 * ("Koolitaja tööd", under the portrait on the site) and the two stories, "Koolituskeskuse lugu" and "Koolitaja
 * teekond". The home page's trainer block shows the same portrait, name, first bio paragraph and stats.
 */
export function TrainerEditor({ initial, storyTitles }: { initial: Loaded<TrainerValues>; storyTitles: { center_story: string; trainer_journey: string } }) {
  const t = adminEt.trainer;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, saveTrainer, form);
  const tr = d.draft.trainer;
  const setTrainer = (patch: Partial<typeof tr>) => d.update("trainer", (x) => ({ ...x, ...patch }));
  const framing = portraitFraming(tr.portraitKey, tr.portraitPos);

  // stats: the focus follows adding (the new value field) and removing (the next row's ×, or "Lisa number")
  const statsRoot = useRef<HTMLDivElement>(null);
  const focus = useRef<{ uid: string; what: "value" | "remove" } | "add" | null>(null);
  useEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    if (target === "add") statsRoot.current?.querySelector<HTMLElement>("[data-add-stat]")?.focus();
    else statsRoot.current?.querySelector<HTMLElement>(`[data-stat-row="${CSS.escape(target.uid)}"] ${target.what === "value" ? "input" : "[data-tool=remove]"}`)?.focus();
  });
  const stats = tr.stats;
  const setStat = (i: number, patch: Partial<StatDraft>) => setTrainer({ stats: stats.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const addStat = () => {
    if (stats.length >= SITE_LIMITS.stats) return;
    const s = { uid: `new-${Date.now().toString(36)}-${++added}`, value: "", label: { et: "" } };
    focus.current = { uid: s.uid, what: "value" };
    setTrainer({ stats: [...stats, s] });
  };
  const removeStat = (i: number) => {
    const next = stats[i + 1] ?? stats[i - 1];
    focus.current = next ? { uid: next.uid, what: "remove" } : "add";
    setTrainer({ stats: stats.filter((_, j) => j !== i) });
  };

  const story = (key: "center_story" | "trainer_journey", title: string) => {
    const page: PageDraft = d.draft[key];
    return (
      <section className={ui.card} aria-labelledby={`${uid}-${key}`} data-story-editor={key}>
        <h2 id={`${uid}-${key}`} className={`${ui.h2} ${styles.cardTitle}`}>
          {title}
        </h2>
        <div className={styles.fields}>
          <I18nInput
            label={t.storyTitle}
            value={page.title}
            onChange={(v) => d.set(key, { ...page, title: v })}
            maxLength={SITE_LIMITS.storyTitle}
            hint={fill(t.storyTitleHint, { title: storyTitles[key] })}
            placeholder={storyTitles[key]}
            error={d.err(`${key}.title`)}
            name={`${key}.title`}
          />
          <I18nInput label={t.storyBody} value={page.body} onChange={(v) => d.set(key, { ...page, body: v })} multiline rows={8} maxLength={SITE_LIMITS.story} hint={t.storyHint} error={d.err(`${key}.body`)} name={`${key}.body`} />
        </div>
      </section>
    );
  };

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-trainer-editor="">
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href="/koolitaja" target="_blank" rel="noopener">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        </div>
      </div>

      <div className={styles.stack}>
        <section className={ui.card} aria-labelledby={`${uid}-card`}>
          <h2 id={`${uid}-card`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.card}
          </h2>
          <div className={styles.trainerGrid}>
            <SingleImage
              label={t.portrait}
              value={tr.portraitKey}
              onChange={(portraitKey) => setTrainer({ portraitKey })}
              hint={t.portraitHint}
              error={d.err("trainer.portraitKey")}
              ratio="4 / 5"
              preview={false}
              name="portrait"
            >
              {tr.portraitKey && (
                <FocalPoint
                  src={mediaUrl(tr.portraitKey)}
                  zoom={framing.zoom}
                  error={d.err("trainer.portraitPos")}
                  targets={[
                    {
                      label: t.portrait,
                      value: tr.portraitPos,
                      onChange: (portraitPos) => setTrainer({ portraitPos }),
                      ratio: "4 / 5",
                      frames: [
                        { label: t.portraitWide, ratio: "4 / 5" },
                        { label: t.portraitNarrow, ratio: "4 / 3" },
                      ],
                      name: "portrait",
                    },
                  ]}
                />
              )}
            </SingleImage>
            <div className={styles.fields}>
              <I18nInput label={t.name} value={tr.name} onChange={(name) => setTrainer({ name })} maxLength={SITE_LIMITS.trainerName} error={d.err("trainer.name")} name="trainer.name" />
              <I18nInput label={t.role} value={tr.role} onChange={(role) => setTrainer({ role })} maxLength={SITE_LIMITS.role} hint={t.roleHint} error={d.err("trainer.role")} name="trainer.role" />
              <div ref={statsRoot} className={ed.list} role="group" aria-labelledby={`${uid}-stats`} data-stats-editor="" data-invalid={d.err("trainer.stats") ? "" : undefined} tabIndex={d.err("trainer.stats") ? -1 : undefined}>
                <h3 id={`${uid}-stats`} className={ui.h3}>
                  {t.stats}
                </h3>
                <p className={ui.hint}>{t.statsHint}</p>
                {stats.map((s, i) => {
                  const n = i + 1;
                  return (
                    <div key={s.uid} className={styles.statRow} data-stat-row={s.uid}>
                      <TextField label={`${t.statValue} ${n}`} value={s.value} onChange={(value) => setStat(i, { value })} maxLength={SITE_LIMITS.statValue} error={d.err(`trainer.stats.${i}.value`)} name={`trainer.stats.${i}.value`} />
                      <I18nInput label={`${t.statLabel} ${n}`} value={s.label} onChange={(label) => setStat(i, { label })} maxLength={SITE_LIMITS.statLabel} error={d.err(`trainer.stats.${i}.label`)} name={`trainer.stats.${i}.label`} />
                      <button type="button" className={ed.iconBtn} data-tool="remove" aria-label={fill(t.removeStat, { n })} onClick={() => removeStat(i)}>
                        ×
                      </button>
                    </div>
                  );
                })}
                {d.err("trainer.stats") && <p className={ui.error}>{d.err("trainer.stats")}</p>}
                <button
                  type="button"
                  className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${ed.addBtn}`}
                  onClick={addStat}
                  aria-disabled={stats.length >= SITE_LIMITS.stats || undefined}
                  aria-describedby={stats.length >= SITE_LIMITS.stats ? `${uid}-stats-max` : undefined}
                  data-add-stat=""
                >
                  + {t.addStat}
                </button>
                {stats.length >= SITE_LIMITS.stats && (
                  <p id={`${uid}-stats-max`} className={`${ui.muted} ${ui.small}`}>
                    {t.statsMax}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-bio`}>
          <h2 id={`${uid}-bio`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.bio}
          </h2>
          <I18nInput label={t.bio} value={d.draft.bio.body} onChange={(body) => d.set("bio", { body })} multiline rows={8} maxLength={SITE_LIMITS.bio} hint={t.bioHint} error={d.err("bio.body")} name="bio.body" />
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-works`} data-works-editor="">
          <h2 id={`${uid}-works`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.works}
          </h2>
          <GalleryEditor
            images={d.draft.works}
            onChange={(fn) => d.update("works", fn)}
            error={d.err("works")}
            errorOf={(i) => d.err(`works.${i}.key`) ?? d.err(`works.${i}.alt`)}
            hint={t.worksHint}
            showMain={false}
          />
        </section>

        {story("center_story", t.story)}
        {story("trainer_journey", t.journey)}
      </div>

      <SaveBar status={d.status} pending={d.pending} reloadHref="/admin/koolitaja" />
    </form>
  );
}
