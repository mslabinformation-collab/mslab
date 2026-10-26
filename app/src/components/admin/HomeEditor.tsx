"use client";

import Link from "next/link";
import { useMemo } from "react";
import { sameSiteValue } from "@/domain/site-changes";
import { looseFaq, looseSlides } from "@/domain/site-checks";
import { SITE_LIMITS, type FaqDraft, type SlideDraft } from "@/domain/site-editor";
import type { HomePartValues, SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { FaqEditor } from "./FaqEditor";
import { I18nInput, lacksRu } from "./I18nInput";
import type { SectionEntry } from "./SectionMap";
import { SlidesEditor } from "./SlidesEditor";
import { SiteCard } from "./site/SiteCard";
import { SiteEditorPage, type SiteApis } from "./site/SiteEditorPage";
import { refusalText, rowRefusals, type SitePartApi } from "./site/useSitePart";
import ui from "./ui.module.css";
import styles from "./HomeEditor.module.css";

// C1 Avaleht on the draft layer (admin UX pass piece 4a, Task 6; README §4 C1, the Part 3 template and the Part 4 C1 frame; piece4-texts S4-5…S4-12,
// S4-3; builder notes §5; rulings R-a, R-d, R-i). The pattern of Praktika and Koolitaja (PracticeEditor.tsx, TrainerEditor.tsx): page.tsx
// (requireAdmin, readSiteEditor) → this wrapper → SiteEditorPage (header, one chip, the PublishBar, the parts' autosave, publish and discard, the
// 170 px section map of the five entries) → `render` → the cards, one component each, every one a SiteCard (site/SiteCard.tsx), in the screen's
// marker `data-home-editor` (admin-inbox.spec.ts opens every content section from the menu by it). In the public page's order:
// - „Slaidid“ (the part `slides`): the rows and the one slide open inline (SlidesEditor.tsx), „+ Lisa slaid“ at the right of the title;
// - „MS LABi lause“ (`statement`) and „Koolitaja kaart“ (`teaser`, S4-7): their text;
// - „KKK“ (`faq`, S4-7): the questions, each answer folded (FaqEditor.tsx);
// - then the link row „Koolitaja plokk“ with „Muuda lehel Koolitaja →“ (S4-8): the home page's trainer block shows the trainer page's fields.
// Every field autosaves into its part's draft — a new slide without its picture or title too (R-d: the draft's check is loose) — and the page's ONE
// bar publishes them all (S4-12: „Slaid 2 pealkiri“, „Slaidid“, „MS LABi lause“, „Koolitaja kaart“, „KKK küsimus 4“, „KKK“); what the publish holds
// back is said under it („Puudub: slaid 3 pilt“). A refused row's words are placed by the row's key (rowRefusals, README §4 "errors keyed by row id"):
// on that slide or question wherever it is now. Field names follow the shell's convention (site/useSitePart.ts): `slides.2.title`, `faq.0.a`,
// `statement.body`.

type Home = HomePartValues;

/** The cards' ids (the section map's links), in the public page's order. */
const CARD = { slides: "slaidid", statement: "lause", teaser: "koolitaja-kaart", faq: "kkk", trainer: "koolitaja-plokk" } as const;

/** Each row's refused fields' codes (rowRefusals) in words. */
const inWords = (placed: Map<string, Record<string, string>>): Map<string, Record<string, string>> =>
  new Map([...placed].map(([key, codes]) => [key, Object.fromEntries(Object.entries(codes).map(([field, code]) => [field, refusalText(code)]))]));

/** The rows' keys in their order differ from live's: a row was added, removed or moved (the card's title says „· avaldamata“). */
const rowsMoved = (draft: readonly { uid: string }[], live: readonly { uid: string }[] | undefined) =>
  !sameSiteValue(
    draft.map((r) => r.uid),
    (live ?? []).map((r) => r.uid),
  );

/** The editor of the home page, from the page's read (readSiteEditor's `parts` and `stamp`, as they came) and the button's link suggestions. */
export function HomeEditor({ parts, stamp, links }: { parts: Record<string, SitePartState>; stamp: number; links: string[] }) {
  const t = adminEt.home;
  return (
    <SiteEditorPage<Home>
      entity="home"
      eyebrow={t.eyebrow}
      title={t.title}
      lead={t.lead}
      viewHref="/"
      previewPath="/"
      parts={parts}
      stamp={stamp}
      sections={sectionsOf}
      render={(apis) => <HomeCards apis={apis} links={links} />}
    />
  );
}

/**
 * The section map's five entries (the P4 frame): „Slaidid“ with its slides, „MS LABi lause“, „Koolitaja kaart“, „KKK“ with its questions, and the
 * link row's „→“ (S4-7); „Kontrolli“ on a card whose part needs a look (a field held back, a conflict, held by the publish), else „RU puudub“ when one
 * of its texts has Estonian and no Russian.
 */
function sectionsOf(apis: SiteApis<Home>): SectionEntry[] {
  const t = adminEt.home;
  const { slides, statement, teaser, faq } = apis;
  const flag = (check: boolean, ru: boolean): Pick<SectionEntry, "flag"> => (check ? { flag: "check" } : ru ? { flag: "ru" } : {});
  const list = slides.fields.slides;
  const items = faq.fields.faq;
  const body = (api: SitePartApi<{ body: I18n }>) => flag(api.attention || api.error("body") !== undefined, lacksRu(api.fields.body));
  return [
    {
      id: CARD.slides,
      label: t.slides.title,
      count: list.length,
      ...flag(
        slides.attention || slides.error("slides") !== undefined,
        list.some((s) => [s.title, s.text, s.kicker, s.ctaLabel].some(lacksRu)),
      ),
    },
    { id: CARD.statement, label: t.statement.title, ...body(statement) },
    { id: CARD.teaser, label: t.teaser.title, ...body(teaser) },
    { id: CARD.faq, label: t.faq.title, count: items.length, ...flag(faq.attention || faq.error("faq") !== undefined, items.some((x) => lacksRu(x.q) || lacksRu(x.a))) },
    { id: CARD.trainer, label: t.trainer.title, note: t.trainer.mapValue },
  ];
}

/** The cards in the public page's order, then the link row, in the screen's marker. */
function HomeCards({ apis, links }: { apis: SiteApis<Home>; links: string[] }) {
  const t = adminEt.home;
  return (
    <div className={styles.cards} data-home-editor="">
      <SlidesCard slides={apis.slides} links={links} />
      <BodyCard id={CARD.statement} part="statement" api={apis.statement} texts={t.statement} max={SITE_LIMITS.statement} />
      <BodyCard id={CARD.teaser} part="teaser" api={apis.teaser} texts={t.teaser} max={SITE_LIMITS.teaser} teaser />
      <FaqCard faq={apis.faq} />
      <TrainerRow />
    </div>
  );
}

/**
 * „Slaidid“: the rows and the open slide (SlidesEditor.tsx). A slide added, moved, removed or brought back saves at once, as does a choice (the tone,
 * „Näidatakse avalehel“) and a picture; a text typed when the field is left. A refused slide's words are placed on that slide by its key.
 */
function SlidesCard({ slides, links }: { slides: SitePartApi<{ slides: SlideDraft[] }>; links: string[] }) {
  const t = adminEt.home.slides;
  const list = slides.fields.slides;
  const live = slides.live.slides;
  // the list the refused save sent (a new object for each refusal): the server's own loose check over it, its problems by each slide's key
  const sent = slides.refusedValue("slides");
  const errors = useMemo(() => inWords(rowRefusals<SlideDraft>(sent, looseSlides, (s) => s.uid, (j) => `slides.${j}`)), [sent]);
  return (
    <SiteCard
      id={CARD.slides}
      title={t.title}
      parts={[slides]}
      unpublished={rowsMoved(list, live)}
      className={`${styles.card} ${styles.slidesCard}`}
      titleClassName={styles.title}
    >
      <p className={styles.lead}>{t.lead}</p>
      <SlidesEditor
        slides={list}
        live={live}
        onUpdate={(fn, now) => {
          slides.update("slides", fn);
          if (now) void slides.flush();
        }}
        errors={errors}
        error={errors.size === 0 ? slides.error("slides") : undefined}
        links={links}
      />
    </SiteCard>
  );
}

/** „MS LABi lause“ or „Koolitaja kaart“: the part's one text, saved when it is left. */
function BodyCard({
  id,
  part,
  api,
  texts,
  max,
  teaser = false,
}: {
  id: string;
  part: "statement" | "teaser";
  api: SitePartApi<{ body: I18n }>;
  texts: { title: string; lead: string; field: string; hint: string };
  max: number;
  /** The trainer card's text (its e2e marker). */
  teaser?: boolean;
}) {
  return (
    <SiteCard id={id} title={texts.title} parts={[api]} className={styles.card} titleClassName={styles.title} data-teaser-editor={teaser ? "" : undefined}>
      <p className={styles.lead}>{texts.lead}</p>
      <I18nInput
        label={texts.field}
        value={api.fields.body}
        onChange={(body) => api.set("body", body)}
        multiline
        rows={3}
        maxLength={max}
        hint={texts.hint}
        error={api.error("body")}
        name={`${part}.body`}
        unpublished={api.unpublished("body")}
      />
    </SiteCard>
  );
}

/** „KKK“: the questions with their answers folded (FaqEditor.tsx). A refused row's words are placed on that row by its key. */
function FaqCard({ faq }: { faq: SitePartApi<{ faq: FaqDraft[] }> }) {
  const t = adminEt.home.faq;
  const items = faq.fields.faq;
  const live = faq.live.faq;
  const sent = faq.refusedValue("faq");
  const errors = useMemo(() => inWords(rowRefusals<FaqDraft>(sent, looseFaq, (x) => x.uid, (j) => `faq.${j}`)), [sent]);
  return (
    <SiteCard id={CARD.faq} title={t.title} parts={[faq]} unpublished={rowsMoved(items, live)} className={styles.card} titleClassName={styles.title}>
      <p className={styles.lead}>{t.lead}</p>
      <FaqEditor items={items} live={live} onUpdate={(fn) => faq.update("faq", fn)} errors={errors} error={errors.size === 0 ? faq.error("faq") : undefined} />
    </SiteCard>
  );
}

/** „Koolitaja plokk“: one row with the way to Koolitaja, whose fields the home page's trainer block shows (S4-8). */
function TrainerRow() {
  const t = adminEt.home.trainer;
  return (
    <SiteCard id={CARD.trainer} title={t.title} parts={[]} className={styles.linkRow} titleClassName={styles.linkTitle} data-trainer-note="">
      <Link className={`${ui.link} ${styles.link}`} href="/admin/koolitaja">
        {t.link}
      </Link>
    </SiteCard>
  );
}
