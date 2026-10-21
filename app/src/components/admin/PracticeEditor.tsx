"use client";

import { useId, useRef } from "react";
import { SITE_LIMITS, type PackageDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { savePractice } from "@/server/actions/admin-site";
import { LangSwitch } from "./EditLang";
import { I18nInput } from "./I18nInput";
import { ListEditor } from "./ListEditor";
import { SaveBar } from "./SaveBar";
import { TextField } from "./TextField";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

/**
 * Praktika (A8, R3, C07): the MINI and MAXI packages side by side — name, tagline, models, duration ("≈ 8 ak" on the
 * card), price and the item list, each in ET / RU. The codes are fixed: packages are not added or removed here.
 */
export function PracticeEditor({ initial, codes }: { initial: Loaded<Record<string, PackageDraft>>; codes: string[] }) {
  const t = adminEt.practice;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, savePractice, form);

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-practice-editor="">
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href="/praktika" target="_blank" rel="noopener">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        </div>
      </div>

      {codes.length === 0 ? (
        <section className={ui.card}>
          <p className={ui.empty}>{t.empty}</p>
        </section>
      ) : (
        <div className={styles.packages}>
          {codes.map((code) => {
            const p = d.draft[code];
            const set = (patch: Partial<PackageDraft>) => d.set(code, { ...p, ...patch });
            const err = (f: string) => d.err(`${code}.${f}`);
            return (
              <section key={code} className={ui.card} aria-labelledby={`${uid}-${code}`} data-package={code}>
                <h2 id={`${uid}-${code}`} className={`${ui.h2} ${styles.cardTitle}`}>
                  {fill(t.package, { code })}
                </h2>
                <div className={ed.grid}>
                  <div className={ed.wide}>
                    <I18nInput label={t.name} value={p.name} onChange={(name) => set({ name })} maxLength={SITE_LIMITS.packageName} error={err("name")} name={`${code}.name`} />
                  </div>
                  <div className={ed.wide}>
                    <I18nInput label={t.tagline} value={p.tagline} onChange={(tagline) => set({ tagline })} maxLength={SITE_LIMITS.tagline} error={err("tagline")} name={`${code}.tagline`} />
                  </div>
                  <TextField label={t.models} value={p.models} onChange={(models) => set({ models })} inputMode="numeric" maxLength={2} hint={t.modelsHint} error={err("models")} name={`${code}.models`} />
                  <TextField label={t.price} value={p.price} onChange={(price) => set({ price })} inputMode="decimal" maxLength={12} error={err("price")} name={`${code}.price`} />
                  <div className={ed.wide}>
                    <I18nInput label={t.duration} value={p.durationLabel} onChange={(durationLabel) => set({ durationLabel })} maxLength={SITE_LIMITS.duration} hint={t.durationHint} error={err("durationLabel")} name={`${code}.durationLabel`} />
                  </div>
                  <div className={ed.wide}>
                    <ListEditor title={t.items} itemLabel={t.item} hint={t.itemsHint} items={p.items} onChange={(items) => set({ items })} error={err("items")} maxLength={SITE_LIMITS.item} name={`${code}.items`} />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <SaveBar status={d.status} pending={d.pending} reloadHref="/admin/praktika" />
    </form>
  );
}
