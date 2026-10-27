"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { postSlug, slugFollowsTitle } from "@/domain/site-checks";
import { SITE_LIMITS } from "@/domain/site-editor";
import { POST_PART, type PostPartValue, type SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { I18nInput } from "./I18nInput";
import { fullDay, newsHref } from "./news/news-view";
import { PostFoot } from "./news/PostFoot";
import { PublishedCard } from "./news/PublishedCard";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { SiteCard } from "./site/SiteCard";
import { SiteEditorPage, type SitePage } from "./site/SiteEditorPage";
import { refusalText, type SitePartApi } from "./site/useSitePart";
import ui from "./ui.module.css";
import styles from "./PostEditor.module.css";

// C3 Uudised, the post (admin UX pass piece 4b, Task 2; README §4 C3 "the editor uses the template; the cover image is checked by „Avalda“, not by save.
// „Kustuta postitus“ keeps its ConfirmPanel (with the new words)"; the Part 4 C3 frame; piece4-texts S4-19…S4-24, S4-4; rulings R-a, R-b, R-g, R-h).
// page.tsx (requireAdmin, readSiteEditor of the post) → this wrapper → SiteEditorPage (the header, one chip, the post's one part `post` on the draft
// layer) → the cards, beside the list from 1180 px (the uudised layout; below it „← Uudised“, S4-21).
// - A published post saves into its draft: the bar „Avaldamata muudatused: {n} · Tekst“ (S4-24's labels), „Eelvaade ↗“ the public page at its LIVE
//   address in draft mode, „Avalda muudatused“ the publish with S4-Q1 A's check (cover, title and text in ET and RU; S4-22 `Puudub: …` under the bar).
// - A post that is not published saves straight to its row (R-a): the same header with no bar, no „· avaldamata“, no „Vaata lehel ↗“.
// - The card „Postitus“, as drawn: the cover (220 px across the card, also while there is none), „Pealkiri“, „Tekst“ (the 150 px text box, its border
//   the accent when it waits for the publish), then the fields the frame leaves out and that stay — „Aadress“, „Kategooria“, „Lühitekst“, „Kuupäev“ —
//   and the footer (news/PostFoot.tsx: S4-20's line and „Kustuta postitus“, S4-23).
// - „Avaldamine“ (news/PublishedCard.tsx): the instant switch „Avaldatud“ (R-b), the page's instant press (SitePage.instant).
// - The address follows the title until the post is first published, unless Maria typed one (R-g; the server makes it, Task 1's hand-off):
//   - a title saved while it follows goes without the address (the engine sends only what was typed), and the field shows the address the new title
//     makes until the page's read after the save brings the stored one (numbered when taken: `kevad-2`), taken as saved (adopt, nothing sent) — only
//     a NEW read, and only when no save has landed since it was read (its version is the part's own): an older read's address may be an older title's
//     (review I-1; the engine itself waits for a save on its way before it takes one);
//   - an address she typed, or a copy of one restored and not yet saved, or one saved as hers, is hers: it never follows and no read moves it;
//   - an emptied address is the title's again (the server makes it from the title): the field, its hint and the footer say the title's (review m6).
//   An address another post has is refused with ADM:2281 at the field, at a save and at the publish or the switch (the bar's "invalid" hold).
// - What a row of the list shows (the title, the cover, the day; a published post's „Avaldamata muudatused“) is read again after a save that changes it.

/** The post editor's values (SiteEditorPage's): the one part. */
type Post = { post: PostPartValue };

/**
 * The fields of a post that is not published that its row in the list shows (and the title, the address the server makes from it, R-g): a save of one
 * has the page read again.
 */
const ROW_FIELDS = ["title", "coverKey", "publishedAt"];

/** A post's refusals at its fields: the editors' words, and ADM:2281 for an address another post has. */
const errorText = (code: string): string => (code === "slugTaken" ? adminEt.post.slugTaken : refusalText(code));

/** The editor of post `id`, from the page's read (readSiteEditor's `parts` and `stamp`, as they came) and whether the post is published. */
export function PostEditor({
  id,
  published,
  parts,
  stamp,
  created,
  search,
}: {
  id: number;
  published: boolean;
  parts: Record<string, SitePartState>;
  stamp: number;
  /** „Lisa postitus +“ opened it (`?loodud=1`): ADM:2273's line (until it is published), and the cursor in „Pealkiri“ (S4-19). */
  created: boolean;
  /** The list's search (`?otsi=`): „← Uudised“ and the list after a delete keep it. */
  search: string;
}) {
  const t = adminEt.post;
  const target = useMemo(() => ({ entity: "post" as const, id }), [id]);
  const state = parts[POST_PART];
  const live = state.live as PostPartValue;
  // the part's version as the page last read it, then as each save left it: a published post's first draft, or its last one gone, changes its row
  const version = useRef(state.version);
  useEffect(() => {
    version.current = state.version;
  }, [state]);
  // R-g: the server holds an address she typed (a save that sent one; an emptied one is the title's again)
  const [ownSaved, setOwnSaved] = useState(false);
  // (once per post: its own mount)
  useEffect(() => {
    if (created) document.querySelector<HTMLElement>('[data-site-editor] [data-i18n="post.title"]')?.focus();
  }, [created]);
  return (
    <SiteEditorPage<Post>
      entity={target}
      title={(apis) => apis.post.fields.title.et.trim() || t.newTitle}
      back={
        <p className={styles.back} data-post-back="">
          <Link className={ui.link} href={newsHref("/admin/uudised", search)}>
            {t.back}
          </Link>
        </p>
      }
      // (ADM:2273 asks for the cover and the publish: once published, it has nothing more to say, though `?loodud=1` stays in the address)
      notice={
        created && !published ? (
          <p className={ui.notice} role="status" data-post-created="">
            {t.created}
          </p>
        ) : undefined
      }
      viewHref={published ? `/uudised/${live.slug}` : null}
      previewPath={`/uudised/${live.slug}`}
      drafted={published}
      thing={t.thing}
      parts={parts}
      stamp={stamp}
      partOptions={{
        post: {
          errorText,
          saved: (patch) => {
            if (typeof patch.slug === "string") setOwnSaved(patch.slug.trim() !== "");
          },
        },
      }}
      readAfterSave={(_part, patch, after) => {
        const before = version.current;
        version.current = after;
        return published ? before.startsWith("d:") !== after.startsWith("d:") : ROW_FIELDS.some((f) => Object.hasOwn(patch, f));
      }}
      render={(apis, page) => <PostCards api={apis.post} page={page} id={id} published={published} live={live} read={state} ownSaved={ownSaved} search={search} />}
    />
  );
}

/** The post's cards: „Avaldamine“ beside (from a wide editor column; else first) and the post's own card „Postitus“. */
function PostCards({
  api,
  page,
  id,
  published,
  live,
  read,
  ownSaved,
  search,
}: {
  api: SitePartApi<PostPartValue>;
  page: SitePage;
  id: number;
  published: boolean;
  live: PostPartValue;
  /** The page's latest read of the part: its version and value. */
  read: SitePartState;
  ownSaved: boolean;
  search: string;
}) {
  const t = adminEt.post;
  const v = api.fields;
  const stored = read.value as PostPartValue;
  // R-g: whose the address is (see the top of the file)
  const typed = v.slug.trim() !== "";
  const hers = typed && (ownSaved || v.slug !== api.stored("slug"));
  const following = !published && !hers && slugFollowsTitle(stored.slug, stored.title.et);
  const fromTitle = postSlug("", v.title.et);
  // the address: emptied, the title's; while it follows, the server's when it is the title's (numbered or not), else the one the title makes
  const slug = !typed || (following && !slugFollowsTitle(v.slug, v.title.et)) ? fromTitle : v.slug;
  // a new read of the page: its address taken as saved while it follows, unless a save has landed since it was read (review I-1)
  const lastRead = useRef(read);
  useEffect(() => {
    if (lastRead.current === read) return;
    lastRead.current = read;
    if (following && stored.slug !== v.slug && read.version === api.versionNow()) api.adopt("slug", stored.slug);
  });

  return (
    <div className={styles.cards} data-post-editor="">
      <PublishedCard page={page} id={id} published={published} className={styles.publish} />
      <SiteCard id="postitus" label={adminEt.siteChanges.post.post} parts={[api]} className={styles.post}>
        <div className={styles.cover}>
          <SingleImage
            label={t.sections.cover}
            labelHidden
            value={v.coverKey}
            onChange={(coverKey) => api.commit("coverKey", coverKey)}
            hint={t.coverHint}
            error={api.error("coverKey")}
            ratio="16 / 9"
            removable={!published}
            name="cover"
            field="post.coverKey"
          />
        </div>
        <I18nInput label={t.title} value={v.title} onChange={(x) => api.set("title", x)} maxLength={SITE_LIMITS.postTitle} error={api.error("title")} name="post.title" unpublished={api.unpublished("title")} />
        <div className={styles.body}>
          <I18nInput
            label={t.body}
            value={v.body}
            onChange={(x) => api.set("body", x)}
            multiline
            rows={6}
            maxLength={SITE_LIMITS.postBody}
            hint={t.bodyHint}
            error={api.error("body")}
            name="post.body"
            unpublished={api.unpublished("body")}
          />
        </div>
        <TextField
          label={t.slug}
          value={slug}
          onChange={(x) => api.set("slug", x)}
          maxLength={80}
          hint={fill(t.slugHint, { slug: slug || "…" }) + (published && v.slug !== live.slug ? ` ${t.slugChanged}` : "")}
          error={api.error("slug")}
          name="post.slug"
          unpublished={api.unpublished("slug")}
        />
        <I18nInput label={t.category} value={v.category} onChange={(x) => api.set("category", x)} maxLength={SITE_LIMITS.category} hint={t.categoryHint} error={api.error("category")} name="post.category" unpublished={api.unpublished("category")} />
        <I18nInput
          label={t.excerpt}
          value={v.excerpt}
          onChange={(x) => api.set("excerpt", x)}
          multiline
          rows={2}
          maxLength={SITE_LIMITS.excerpt}
          hint={t.excerptHint}
          error={api.error("excerpt")}
          name="post.excerpt"
          unpublished={api.unpublished("excerpt")}
        />
        <TextField label={t.date} type="date" value={v.publishedAt} onChange={(x) => api.set("publishedAt", x)} hint={t.dateHint} error={api.error("publishedAt")} name="post.publishedAt" unpublished={api.unpublished("publishedAt")} />
        <PostFoot
          id={id}
          published={published}
          line={published ? fill(t.foot.published, { date: fullDay(live.publishedAt), slug: live.slug }) : fill(t.foot.draft, { slug })}
          search={search}
          discardCopy={api.discardCopy}
        />
      </SiteCard>
    </div>
  );
}
