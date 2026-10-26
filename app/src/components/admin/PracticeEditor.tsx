"use client";

import { useId } from "react";
import { SITE_LIMITS, type PackageDraft } from "@/domain/site-editor";
import type { SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { PlainField } from "./course/PlainField";
import { I18nInput } from "./I18nInput";
import { ListEditor } from "./ListEditor";
import { sectionCard } from "./SectionMap";
import { SiteEditorPage, type SiteApis } from "./site/SiteEditorPage";
import type { SitePartApi } from "./site/useSitePart";
import ui from "./ui.module.css";
import styles from "./PracticeEditor.module.css";

// C5 Praktika (admin UX pass piece 4a, Task 4 — the pilot of the site editors on the draft layer; README §4 C5 "the template; points get drag +
// undo", the Part 4 C5 frame; piece4-texts S4-31…S4-34, S4-3; builder notes §5; ruling R-h). The pattern Koolitaja and Avaleht follow:
//   page.tsx (server: requireAdmin, readSiteEditor) → this client wrapper → SiteEditorPage (header, one chip, the PublishBar, the parts' autosave,
//   publish and discard) → `render` → the cards, one component each, with their hooks (a part's api: site/useSitePart.ts).
// Each package code is a part of the entity "practice" (ruling R-a): MINI and MAXI side by side, each card titled by its code (S4-33), with „Nimi“
// and „Lühitekst“ (kept, builder notes §5), the row of three short fields „Hind (€)“, „Modelle“ and „Kestus“ (each checked on its own: the server's
// loose check names the field it refuses, domain/site-checks.ts loosePackage, and the engine holds back that one alone), then „Sisaldab“: the points
// with drag, ↑ / ↓, × with the UndoBar „Rida eemaldatud.“ and its undo (ListEditor), and Enter in the last point adds the next one (R-h). Every field
// autosaves into its package's draft, and the page's ONE bar publishes both packages (S4-34: „MAXI hind“, „MAXI punktid“). A field that differs from
// live says „· avaldamata“ with its border in --rose (#9e8993), the frame's MAXI price; the others keep ui.input's #d9d2d5 (README §1.8).
// The fields' names follow the shell's convention (site/useSitePart.ts): `MAXI.price` (data-field), `MAXI.name` (data-i18n), a point `MAXI.items.3`.

/** Praktika's parts by package code (SiteEditorPage's values). */
type Practice = Record<string, PackageDraft>;

/** The editor of the practice packages, from the page's read (readSiteEditor's `parts` and `stamp`, as they came). */
export function PracticeEditor({ parts, stamp }: { parts: Record<string, SitePartState>; stamp: number }) {
  const t = adminEt.practice;
  return (
    <SiteEditorPage<Practice>
      entity="practice"
      eyebrow={t.eyebrow}
      title={t.title}
      lead={t.lead}
      viewHref="/praktika"
      previewPath="/praktika"
      parts={parts}
      stamp={stamp}
      render={(apis) => <PackageCards apis={apis} />}
    />
  );
}

/** The packages' cards in the table's order (the parts' order); none: the empty line. */
function PackageCards({ apis }: { apis: SiteApis<Practice> }) {
  const codes = Object.keys(apis);
  if (codes.length === 0)
    return (
      <section className={ui.card}>
        <p className={ui.empty}>{adminEt.practice.empty}</p>
      </section>
    );
  return (
    <div className={styles.packages}>
      {codes.map((code) => (
        <PackageCard key={code} code={code} api={apis[code]} />
      ))}
    </div>
  );
}

/** One package's card: its fields, saved when the focus leaves one (its part's flush, README §1.3 "on blur"). */
function PackageCard({ code, api }: { code: string; api: SitePartApi<PackageDraft> }) {
  const t = adminEt.practice;
  const uid = useId();
  const v = api.fields;
  const named = (field: keyof PackageDraft & string) => `${code}.${field}`;
  return (
    <section
      id={`pakett-${code}`}
      className={`${ui.card} ${sectionCard} ${styles.card}`}
      aria-labelledby={`${uid}-title`}
      data-package={code}
      onBlur={() => void api.flush()}
    >
      <h2 id={`${uid}-title`} className={styles.name}>
        {fill(t.package, { code })}
      </h2>
      <I18nInput
        label={t.name}
        value={v.name}
        onChange={(x) => api.set("name", x)}
        maxLength={SITE_LIMITS.packageName}
        error={api.error("name")}
        name={named("name")}
        unpublished={api.unpublished("name")}
      />
      <I18nInput
        label={t.tagline}
        value={v.tagline}
        onChange={(x) => api.set("tagline", x)}
        maxLength={SITE_LIMITS.tagline}
        error={api.error("tagline")}
        name={named("tagline")}
        unpublished={api.unpublished("tagline")}
      />
      <div className={styles.short} data-package-short="">
        <PlainField
          name={named("price")}
          label={t.price}
          value={v.price}
          onChange={(x) => api.set("price", x)}
          inputMode="decimal"
          maxLength={12}
          error={api.error("price")}
          unpublished={api.unpublished("price")}
        />
        <PlainField
          name={named("models")}
          label={t.models}
          value={v.models}
          onChange={(x) => api.set("models", x)}
          inputMode="numeric"
          maxLength={2}
          hint={t.modelsHint}
          error={api.error("models")}
          unpublished={api.unpublished("models")}
        />
        <I18nInput
          label={t.duration}
          value={v.durationLabel}
          onChange={(x) => api.set("durationLabel", x)}
          maxLength={SITE_LIMITS.duration}
          hint={t.durationHint}
          error={api.error("durationLabel")}
          name={named("durationLabel")}
          unpublished={api.unpublished("durationLabel")}
        />
      </div>
      <ListEditor
        title={t.items}
        itemLabel={t.item}
        hint={t.itemsHint}
        items={v.items}
        // a point typed in waits for the debounce; a point added, moved, removed or brought back saves at once (useSitePart's update)
        onChange={(items) => api.set("items", items)}
        onUpdate={(fn) => api.update("items", fn)}
        error={api.error("items")}
        maxLength={SITE_LIMITS.item}
        name={named("items")}
        unpublished={api.unpublished("items")}
        enterAdds
        addLabel={t.addItem}
        rowNames
      />
      {api.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={api.restore} data-part-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </section>
  );
}
