"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useId, useMemo, useRef, useState } from "react";
import { postSlug, slugFollowsTitle } from "@/domain/site-checks";
import { SITE_LIMITS } from "@/domain/site-editor";
import { POST_PART, type PostPartValue, type SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { dropSiteCopies } from "@/lib/site-copies";
import { ConfirmPanel } from "./ConfirmPanel";
import { I18nInput } from "./I18nInput";
import { SingleImage } from "./SingleImage";
import { Switch } from "./Switch";
import { TextField } from "./TextField";
import { SiteCard } from "./site/SiteCard";
import { SiteEditorPage, type SitePage } from "./site/SiteEditorPage";
import { refusalText, type SitePartApi } from "./site/useSitePart";
import { LATE, orLate, post, stampOf, type HeldPart } from "./useEditorRestarts";
import ui from "./ui.module.css";
import styles from "./PostEditor.module.css";

// C3 Uudised, the post (admin UX pass piece 4b, Task 2; README §4 C3 "the editor uses the template; the cover image is checked by „Avalda“, not by save.
// „Kustuta postitus“ keeps its ConfirmPanel (with the new words)"; the Part 4 C3 frame; piece4-texts S4-19…S4-24, S4-4; rulings R-a, R-b, R-g, R-h).
// page.tsx (requireAdmin, readSiteEditor of the post) → this wrapper → SiteEditorPage (the header, one chip, the post's one part `post` on the draft
// layer) → the cards, beside the list from 1180 px (the uudised layout; below it „← Uudised“, S4-21).
// - A published post saves into its draft: the bar „Avaldamata muudatused: {n} · Tekst“ (S4-24's labels), „Eelvaade ↗“ the public page at its LIVE
//   address in draft mode, „Avalda muudatused“ the publish with S4-Q1 A's check (cover, title and text in ET and RU; S4-22 `Puudub: …` under the bar).
// - A post that is not published saves straight to its row (R-a): the same header with no bar, no „· avaldamata“, no „Vaata lehel ↗“.
// - The card, as drawn: the cover (220 px), „Pealkiri“, „Tekst“ (the 150 px text box, its border the accent when it waits for the publish), then the
//   fields the frame leaves out and that stay — „Aadress“, „Kategooria“, „Lühitekst“, „Kuupäev“ — and the footer line `Avaldatud {dd.mm.yyyy} ·
//   /uudised/{slug}` / `Mustand · /uudised/{slug}` (S4-20) with „Kustuta postitus“, which asks in a ConfirmPanel (S4-23) and goes back to the list,
//   which says „Postitus kustutatud.“.
// - „Avaldamine“: the switch „Avaldatud“ (R-b), instant. On, for a post that is not published: its publish (the cards wait from the press until the
//   page's read; refused, `Puudub: kaanepilt, …` under it, S4-22). Off, on a published post: its drafts are published first, then it is hidden (a
//   draft changed meanwhile refuses it, listed on the bar). Either way what is typed is saved first.
// - The address follows the title until the post is first published, unless Maria typed one (R-g; the server makes it, Task 1's hand-off): a title
//   saved while it follows goes without the address, the field shows the address the new title makes, and the page read after the save brings the
//   stored one (numbered when taken: `kevad-2`), taken as saved (adopt). An address another post has is refused with ADM:2281 at the field, at a save
//   and at the publish or the switch (the bar's "invalid" hold).
// - What a row of the list shows (the title, the cover, the day; a published post's „Avaldamata muudatused“) is read again after a save that changes it.

/** The post editor's values (SiteEditorPage's): the one part. */
type Post = { post: PostPartValue };

/**
 * The fields of a post that is not published that its row in the list shows (and the title, the address the server makes from it, R-g): a save of one
 * has the page read again.
 */
const ROW_FIELDS = ["title", "coverKey", "publishedAt"];

/** A day "YYYY-MM-DD" as the footer says it, "dd.mm.yyyy" (S4-20); anything else as it is. */
const fullDay = (day: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
};

/** A post's refusals at its fields: the editors' words, and ADM:2281 for an address another post has. */
const errorText = (code: string): string => (code === "slugTaken" ? adminEt.post.slugTaken : refusalText(code));

/** The editor of post `id`, from the page's read (readSiteEditor's `parts` and `stamp`, as they came) and whether the post is published. */
export function PostEditor({
  id,
  published,
  parts,
  stamp,
  created,
  listHref,
}: {
  id: number;
  published: boolean;
  parts: Record<string, SitePartState>;
  stamp: number;
  /** „Lisa postitus +“ opened it (`?loodud=1`): ADM:2273's line, and the cursor in „Pealkiri“ (S4-19). */
  created: boolean;
  /** The list's address with its search: „← Uudised“, and after a delete. */
  listHref: string;
}) {
  const t = adminEt.post;
  const target = useMemo(() => ({ entity: "post" as const, id }), [id]);
  const state = parts[POST_PART];
  const live = state.live as PostPartValue;
  const read = state.value as PostPartValue;
  // the part's version as the page last read it, then as each save left it: a published post's first draft, or its last one gone, changes its row
  const version = useRef(state.version);
  useEffect(() => {
    version.current = state.version;
  }, [state]);
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
          <Link className={ui.link} href={listHref}>
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
      partOptions={{ post: { errorText } }}
      readAfterSave={(_part, patch, after) => {
        const before = version.current;
        version.current = after;
        return published ? before.startsWith("d:") !== after.startsWith("d:") : ROW_FIELDS.some((f) => Object.hasOwn(patch, f));
      }}
      render={(apis, page) => <PostCards api={apis.post} page={page} id={id} published={published} live={live} read={read} listHref={listHref} />}
    />
  );
}

/** The post's cards: „Avaldamine“ beside (from a wide editor column; else first) and the post's own card. */
function PostCards({
  api,
  page,
  id,
  published,
  live,
  read,
  listHref,
}: {
  api: SitePartApi<PostPartValue>;
  page: SitePage;
  id: number;
  published: boolean;
  live: PostPartValue;
  read: PostPartValue;
  listHref: string;
}) {
  const t = adminEt.post;
  const v = api.fields;
  // R-g: Maria typed in „Aadress“ (on this mount): from then on it is hers
  const [typed, setTyped] = useState(false);
  const following = !published && !typed && slugFollowsTitle(read.slug, read.title.et);
  // while it follows and the title has changed since the page's read, the address the new title makes (the server may number it: the next read says)
  const slug = following && v.title.et !== read.title.et ? postSlug("", v.title.et) : v.slug;
  // the page read again holds the address the server made from the saved title: taken as saved, nothing sent
  useEffect(() => {
    if (following) api.adopt("slug", read.slug);
  }, [following, read.slug, api]);

  return (
    <div className={styles.cards} data-post-editor="">
      <PublishedCard page={page} id={id} published={published} />
      <SiteCard id="postitus" label={t.sections.text} parts={[api]} className={styles.post}>
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
          onChange={(x) => {
            setTyped(true);
            api.set("slug", x);
          }}
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
        <PostFoot api={api} id={id} published={published} line={published ? fill(t.foot.published, { date: fullDay(live.publishedAt), slug: live.slug }) : fill(t.foot.draft, { slug })} listHref={listHref} />
      </SiteCard>
    </div>
  );
}

/**
 * „Avaldamine“ with the instant switch „Avaldatud“ (R-b, the course's switch as piece 3a built it): what is typed is saved first (a save that does not
 * go through switches nothing: the chip says why), then POST /api/admin/uudised/<id>/avaldatud `{ on }`. The cards wait from the press; done, the page
 * is read again from the answer's stamp and the editor starts over from it (a published post with its bar, or a hidden one without). Refused: on,
 * `Puudub: …` under the switch (S4-22) or the address at its field ("invalid"); off, a draft changed meanwhile, on the bar after the page's read.
 */
function PublishedCard({ page, id, published }: { page: SitePage; id: number; published: boolean }) {
  const t = adminEt.post;
  const uid = useId();
  /** The switch shows what was asked until the read that starts the editor over (or a refusal). */
  const [asked, setAsked] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const missing = published ? [] : page.held.filter((b) => b.reason === "missing").flatMap((b) => b.fields);
  const said = failed ?? (missing.length > 0 ? fill(adminEt.publish.missing, { fields: missing.join(", ") }) : null);

  const switchTo = async (on: boolean) => {
    if (asked !== null || page.waitingNow()) return;
    setAsked(on);
    setFailed(null);
    page.setHeld(null);
    const signal = page.hold();
    const saved = await orLate(page.flushAll(), signal);
    if (saved === LATE) return;
    if (saved.some((ok) => !ok)) {
      page.release();
      return setAsked(null);
    }
    const answer = await post(`/api/admin/uudised/${id}/avaldatud`, signal, { on });
    if ("late" in answer) return;
    const body = answer.ok && typeof answer.body === "object" && answer.body !== null ? (answer.body as Record<string, unknown>) : null;
    if (body?.ok === true) return page.reload(stampOf(body));
    setAsked(null);
    if (Array.isArray(body?.missing)) {
      page.release();
      return page.setHeld([{ part: POST_PART, reason: "missing", fields: body.missing as string[] }]);
    }
    if (Array.isArray(body?.blocked)) {
      const blocked = body.blocked as HeldPart[];
      page.setHeld(blocked);
      // a draft another window saved after this screen's read: the page is read again, so the bar shows what it lists
      return blocked.some((b) => b.reason === "changed") ? page.reload(null) : page.release();
    }
    page.release();
    setFailed(!answer.ok && "signedOut" in answer && answer.signedOut ? adminEt.leave.reasons.signedOut : adminEt.common.saveError);
  };

  return (
    <section className={`${ui.card} ${styles.publish}`} aria-labelledby={`${uid}-title`} data-post-publish="">
      <h2 id={`${uid}-title`} className={`${ui.h3} ${styles.cardTitle}`}>
        {t.sections.publish}
      </h2>
      <Switch label={t.published} checked={asked ?? published} onChange={(on) => void switchTo(on)} describedBy={said ? `${uid}-hint ${uid}-said` : `${uid}-hint`} data-field="post.published" />
      <p id={`${uid}-hint`} className={ui.hint}>
        {t.publishedHint}
      </p>
      {said && (
        <p id={`${uid}-said`} role="alert" className={ui.error} data-switch-error="">
          {said}
        </p>
      )}
    </section>
  );
}

/**
 * The card's footer (S4-20): where the post is (`line`) and „Kustuta postitus“, which asks in its place (S4-23: „Kas kustutan selle postituse?“, for a
 * published post „Postitus kaob blogist ja avalehelt.“, „Seda ei saa tagasi võtta.“, „Jah, kustuta“ / „Katkesta“). Yes: the post goes with its drafts
 * (POST …/kustuta, R-h), this browser's copies of it go, and the list opens with „Postitus kustutatud.“.
 */
function PostFoot({ api, id, published, line, listHref }: { api: SitePartApi<PostPartValue>; id: number; published: boolean; line: string; listHref: string }) {
  const t = adminEt.post;
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  // the question closed: the focus back on „Kustuta postitus“ (ConfirmPanel's rule)
  useEffect(() => {
    if (asking || !back.current) return;
    back.current = false;
    trigger.current?.focus();
  }, [asking]);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/admin/uudised/${id}/kustuta`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.ok) {
        // nothing of it is sent or kept any more, in this tab or another's copy
        api.discardCopy();
        dropSiteCopies({ entity: "post", id });
        startTransition(() => {
          router.push(`${listHref}${listHref.includes("?") ? "&" : "?"}kustutatud=1`);
          router.refresh();
        });
        return;
      }
      setFailed(res.status === 404 ? t.notFound : res.status === 401 ? adminEt.leave.reasons.signedOut : adminEt.common.saveError);
    } catch {
      setFailed(adminEt.common.saveError);
    }
    setBusy(false);
  };

  return (
    <div className={styles.foot} data-post-foot="">
      <div className={styles.footRow}>
        <span className={styles.where} data-post-where="">
          {line}
        </span>
        {!asking && (
          <button ref={trigger} type="button" className={styles.remove} onClick={() => setAsking(true)} data-post-delete="">
            {t.remove.button}
          </button>
        )}
      </div>
      {asking && (
        <ConfirmPanel
          question={t.remove.question}
          lines={published ? [t.remove.public, t.remove.final] : [t.remove.final]}
          yesLabel={t.remove.yes}
          tone="danger"
          busy={busy}
          onYes={() => void remove()}
          onCancel={() => {
            back.current = true;
            setAsking(false);
            setFailed(null);
          }}
        />
      )}
      {failed && (
        <p role="alert" className={ui.error}>
          {failed}
        </p>
      )}
    </div>
  );
}
