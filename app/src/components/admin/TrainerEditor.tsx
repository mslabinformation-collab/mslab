"use client";

import { useEffect, useRef, useState } from "react";
import { isBlankStat, portraitFraming, SITE_LIMITS, type PageDraft, type StatDraft, type TrainerDraft, type WorkDraft } from "@/domain/site-editor";
import type { SitePartState, TrainerPartValues } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { FocalPoint } from "./FocalPoint";
import { GalleryEditor } from "./GalleryEditor";
import { I18nInput, lacksRu } from "./I18nInput";
import type { SectionEntry } from "./SectionMap";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { SiteCard } from "./site/SiteCard";
import { SiteEditorPage, type SiteApis } from "./site/SiteEditorPage";
import type { SitePartApi } from "./site/useSitePart";
import ui from "./ui.module.css";
import styles from "./TrainerEditor.module.css";

// C2 Koolitaja on the draft layer (admin UX pass piece 4a, Task 5; README §4 C2 "the template; the gallery is shared with the course editor (drag +
// undo); empty story cards fold", the Part 4 C2 frame; piece4-texts S4-13…S4-17, S4-3; builder notes §5; rulings R-a, R-g). The pattern of Praktika
// (PracticeEditor.tsx): page.tsx (requireAdmin, readSiteEditor) → this wrapper → SiteEditorPage (header, one chip, the PublishBar, the parts' autosave,
// publish and discard, the 170 px section map of the five cards) → `render` → the cards, one component each, every one a SiteCard (site/SiteCard.tsx),
// in the screen's marker `data-trainer-editor` (admin-inbox.spec.ts opens every content section from the menu by it). In the public page's order:
// - „Portree ja tutvustus“ (S4-14) over the parts `trainer` and `bio` (R-a: no part is split): the portrait in a 240 px column with its focal point
//   (the picture on top, 300 px tall for a portrait photo, radius 16, drawn), beside „Nimi“, „Amet“ (kept, builder notes §5) and „Tutvustus“;
// - „Numbrid“: `trainer.stats` as three fixed pairs, a number and its label (builder notes §5); a pair left empty is no pair — the draft keeps none at
//   its end, and the publish leaves out any (domain/site-editor.ts isBlankStat), so the public page never shows one;
// - „Galerii“ (S4-14): the works as GalleryEditor's grid of tiles (R-g: drag both ways, ↑ / ↓, ✕ with the UndoBar „Pilt eemaldatud.“ and its undo, the
//   tile „+ Lisa“), with the counter „Lohista järjekorra muutmiseks · {n} / 24“ on the title's row (S4-15, drawn there; on this gallery only);
// - „Koolituskeskuse lugu“ and „Koolitaja teekond“: a story that is empty when the page opens is one row „tühi · Lisa tekst ▸“ (S4-16); „Lisa tekst“
//   opens it with the cursor in its title. The section map says „tühi“ for it too.
// Every field autosaves into its part's draft, and the page's ONE bar publishes them all (S4-17: „Portree“, „Nimi“, „Amet“, „Tutvustus“, „Numbrid“,
// „Galerii“, „Koolituskeskuse lugu“, „Koolitaja teekond“). Field names follow the shell's convention (site/useSitePart.ts): `trainer.name`, `bio.body`,
// a pair's `trainer.stats.2.label`, a story's `center_story.title`.

type Trainer = TrainerPartValues;
type StoryPart = "center_story" | "trainer_journey";
/** A story's heading on the site when its title is left empty (the public dictionary's; the title field's hint and placeholder). */
export type StoryTitles = Record<StoryPart, string>;

/** The cards' ids (the section map's links), in the public page's order. */
const CARD = { portrait: "portree", stats: "numbrid", works: "galerii", center_story: "lugu", trainer_journey: "teekond" } as const;
/** The trainer card's fields that „Portree ja tutvustus“ shows (the rest, `stats`, is „Numbrid“). */
const PORTRAIT_FIELDS = ["portraitKey", "portraitPos", "name", "role"];

const blank = (f: I18n) => !f.et.trim() && !(f.ru ?? "").trim();
/** A story with neither a title nor a text, in either language: its card folds. */
const blankPage = (p: PageDraft) => blank(p.title) && blank(p.body);

/** The three pairs as „Numbrid“ shows them: the draft's, then empty ones (keyed `t<i>`, as the page's read keys the stored ones). */
const pairsOf = (stats: StatDraft[]): StatDraft[] => Array.from({ length: Math.max(SITE_LIMITS.stats, stats.length) }, (_, i) => stats[i] ?? { uid: `t${i}`, value: "", label: { et: "" } });

/** `stats` with pair `i` changed, and no empty pair left at its end (typed and emptied again, a pair is live's again: nothing waits for a publish). */
function withPair(stats: StatDraft[], i: number, patch: Partial<StatDraft>): StatDraft[] {
  const next = pairsOf(stats).map((s, j) => (j === i ? { ...s, ...patch } : s));
  while (next.length > 0 && isBlankStat(next[next.length - 1])) next.pop();
  return next;
}

/** The editor of the trainer's page, from the page's read (readSiteEditor's `parts` and `stamp`, as they came). */
export function TrainerEditor({ parts, stamp, storyTitles }: { parts: Record<string, SitePartState>; stamp: number; storyTitles: StoryTitles }) {
  const t = adminEt.trainer;
  return (
    <SiteEditorPage<Trainer>
      entity="trainer"
      eyebrow={t.eyebrow}
      title={t.title}
      lead={t.lead}
      viewHref="/koolitaja"
      previewPath="/koolitaja"
      parts={parts}
      stamp={stamp}
      sections={sectionsOf}
      render={(apis) => <TrainerCards apis={apis} storyTitles={storyTitles} />}
    />
  );
}

/**
 * The section map's five entries: „Numbrid“ with its pairs filled, „Galerii“ with its pictures, an empty story's „tühi“ (S4-16); „Kontrolli“ on a card
 * whose field is held back or whose part is in conflict or was held by the publish (both of the trainer card's cards, unless a field says which),
 * else „RU puudub“ when one of its texts has Estonian and no Russian.
 */
function sectionsOf(apis: SiteApis<Trainer>): SectionEntry[] {
  const t = adminEt.trainer;
  const { trainer, bio, works } = apis;
  const tr = trainer.fields;
  const refused = (fields: readonly string[]) => fields.some((f) => trainer.error(f) !== undefined);
  const whole = trainer.attention && !refused([...PORTRAIT_FIELDS, "stats"]);
  const flag = (check: boolean, ru: boolean): Pick<SectionEntry, "flag"> => (check ? { flag: "check" } : ru ? { flag: "ru" } : {});
  const pairs = tr.stats.filter((s) => !isBlankStat(s));
  const story = (part: StoryPart, label: string): SectionEntry => {
    const { fields: page, attention } = apis[part];
    return { id: CARD[part], label, ...(blankPage(page) ? { note: t.empty } : {}), ...flag(attention, [page.title, page.body].some(lacksRu)) };
  };
  return [
    { id: CARD.portrait, label: t.card, ...flag(bio.attention || refused(PORTRAIT_FIELDS) || whole, [tr.name, tr.role, bio.fields.body].some(lacksRu)) },
    { id: CARD.stats, label: t.stats, count: pairs.length, ...flag(refused(["stats"]) || whole, pairs.some((s) => lacksRu(s.label))) },
    { id: CARD.works, label: t.works, count: works.fields.works.length, ...flag(works.attention, false) },
    story("center_story", t.story),
    story("trainer_journey", t.journey),
  ];
}

/** The five cards in the public page's order, in the screen's marker. */
function TrainerCards({ apis, storyTitles }: { apis: SiteApis<Trainer>; storyTitles: StoryTitles }) {
  const t = adminEt.trainer;
  return (
    <div className={styles.cards} data-trainer-editor="">
      <PortraitCard trainer={apis.trainer} bio={apis.bio} />
      <StatsCard trainer={apis.trainer} />
      <WorksCard works={apis.works} />
      <StoryCard part="center_story" api={apis.center_story} title={t.story} fallback={storyTitles.center_story} />
      <StoryCard part="trainer_journey" api={apis.trainer_journey} title={t.journey} fallback={storyTitles.trainer_journey} />
    </div>
  );
}

/** „Portree ja tutvustus“: the portrait with its focal point in its column (an upload saves at once), beside the name, the role and the bio. */
function PortraitCard({ trainer, bio }: { trainer: SitePartApi<TrainerDraft>; bio: SitePartApi<{ body: I18n }> }) {
  const t = adminEt.trainer;
  const v = trainer.fields;
  const framing = portraitFraming(v.portraitKey, v.portraitPos);
  return (
    <SiteCard id={CARD.portrait} title={t.card} parts={[trainer, bio]} className={`${styles.card} ${styles.portraitCard}`} titleClassName={styles.title}>
      <div className={styles.picture} data-portrait-column="">
        {v.portraitKey && (
          <FocalPoint
            src={mediaUrl(v.portraitKey)}
            zoom={framing.zoom}
            error={trainer.error("portraitPos")}
            targets={[
              {
                label: t.portrait,
                value: v.portraitPos,
                onChange: (portraitPos) => trainer.set("portraitPos", portraitPos),
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
        <SingleImage
          label={t.portrait}
          labelHidden
          value={v.portraitKey}
          onChange={(portraitKey) => trainer.commit("portraitKey", portraitKey)}
          hint={t.portraitHint}
          error={trainer.error("portraitKey")}
          ratio="4 / 5"
          preview={false}
          name="portrait"
        />
      </div>
      <div className={styles.text} data-portrait-text="">
        <I18nInput label={t.name} value={v.name} onChange={(name) => trainer.set("name", name)} maxLength={SITE_LIMITS.trainerName} error={trainer.error("name")} name="trainer.name" unpublished={trainer.unpublished("name")} />
        <I18nInput
          label={t.role}
          value={v.role}
          onChange={(role) => trainer.set("role", role)}
          maxLength={SITE_LIMITS.role}
          hint={t.roleHint}
          error={trainer.error("role")}
          name="trainer.role"
          unpublished={trainer.unpublished("role")}
        />
        <I18nInput
          label={t.bio}
          value={bio.fields.body}
          onChange={(body) => bio.set("body", body)}
          multiline
          rows={8}
          maxLength={SITE_LIMITS.bio}
          hint={t.bioHint}
          error={bio.error("body")}
          name="bio.body"
          unpublished={bio.unpublished("body")}
        />
      </div>
    </SiteCard>
  );
}

/** „Numbrid“: three pairs in a row, each a number and its label (their names „Number {n}“, „Selgitus {n}“; the card's title names them on screen). */
function StatsCard({ trainer }: { trainer: SitePartApi<TrainerDraft> }) {
  const t = adminEt.trainer;
  const stats = trainer.fields.stats;
  const set = (i: number, patch: Partial<StatDraft>) => trainer.set("stats", withPair(stats, i, patch));
  const error = trainer.error("stats");
  return (
    <SiteCard id={CARD.stats} title={t.stats} parts={[trainer]} unpublished={trainer.unpublished("stats")} className={styles.card} titleClassName={styles.title}>
      <div className={styles.pairs}>
        {pairsOf(stats).map((s, i) => (
          // (a pair is its place: the three are fixed)
          <div key={i} className={styles.pair} data-stat-pair="">
            <TextField
              label={`${t.statValue} ${i + 1}`}
              labelHidden
              value={s.value}
              onChange={(value) => set(i, { value })}
              maxLength={SITE_LIMITS.statValue}
              name={`trainer.stats.${i}.value`}
              className={styles.value}
            />
            <I18nInput label={`${t.statLabel} ${i + 1}`} labelHidden value={s.label} onChange={(label) => set(i, { label })} maxLength={SITE_LIMITS.statLabel} name={`trainer.stats.${i}.label`} />
          </div>
        ))}
      </div>
      {error && <p className={ui.error}>{error}</p>}
    </SiteCard>
  );
}

/** „Galerii“: the works as tiles (GalleryEditor layout="grid"); a picture added, moved, removed or brought back saves at once (useSitePart's update). */
function WorksCard({ works }: { works: SitePartApi<{ works: WorkDraft[] }> }) {
  const t = adminEt.trainer;
  const images = works.fields.works;
  return (
    <SiteCard id={CARD.works} title={t.works} parts={[works]} unpublished={works.unpublished("works")} className={`${styles.card} ${styles.worksCard}`} titleClassName={styles.title}>
      <p className={styles.count} data-gallery-count="">
        {fill(t.worksHint, { n: images.length })}
      </p>
      <GalleryEditor layout="grid" images={images} onChange={(update) => works.update("works", update)} error={works.error("works")} addLabel={t.addWork} />
    </SiteCard>
  );
}

/** A story's card: its title and text; empty when the page opened, one folded row whose „Lisa tekst“ opens it with the cursor in the title. */
function StoryCard({ part, api, title, fallback }: { part: StoryPart; api: SitePartApi<PageDraft>; title: string; fallback: string }) {
  const t = adminEt.trainer;
  const v = api.fields;
  const [open, setOpen] = useState(() => !blankPage(v));
  const fields = useRef<HTMLDivElement>(null);
  /** „Lisa tekst“ was pressed: the cursor goes into the title once the fields are there. */
  const opened = useRef(false);
  useEffect(() => {
    if (!open || !opened.current) return;
    opened.current = false;
    fields.current?.querySelector<HTMLElement>("[data-lang-field]")?.focus();
  }, [open]);

  if (!open)
    return (
      <SiteCard id={CARD[part]} title={title} parts={[api]} className={styles.folded} titleClassName={styles.foldTitle} data-story-editor={part}>
        <span className={styles.foldAside} data-story-fold="">
          {t.empty} ·{" "}
          <button
            type="button"
            className={styles.addText}
            onClick={() => {
              opened.current = true;
              setOpen(true);
            }}
          >
            {t.addText} <span aria-hidden="true">▸</span>
          </button>
        </span>
      </SiteCard>
    );
  return (
    <SiteCard id={CARD[part]} title={title} parts={[api]} className={styles.card} titleClassName={styles.title} data-story-editor={part}>
      <div ref={fields} className={styles.storyFields}>
        <I18nInput
          label={t.storyTitle}
          value={v.title}
          onChange={(x) => api.set("title", x)}
          maxLength={SITE_LIMITS.storyTitle}
          hint={fill(t.storyTitleHint, { title: fallback })}
          placeholder={fallback}
          error={api.error("title")}
          name={`${part}.title`}
          unpublished={api.unpublished("title")}
        />
        <I18nInput
          label={t.storyBody}
          value={v.body}
          onChange={(x) => api.set("body", x)}
          multiline
          rows={8}
          maxLength={SITE_LIMITS.story}
          hint={t.storyHint}
          error={api.error("body")}
          name={`${part}.body`}
          unpublished={api.unpublished("body")}
        />
      </div>
    </SiteCard>
  );
}
