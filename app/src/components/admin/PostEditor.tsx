"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { SITE_LIMITS, type PostDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { deletePost, savePost } from "@/server/actions/admin-site";
import type { EditResult } from "@/server/edit-check";
import { Choice } from "./Choice";
import { LangSwitch } from "./EditLang";
import { I18nInput } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import layout from "./CourseEditor.module.css";
import styles from "./site-editor.module.css";

/**
 * A blog post (D pArticle's fields): ET / RU title, short text, body (paragraphs) and category, the address (made from
 * the title when left empty, as for courses), the date, the cover picture and "Avaldatud". Laid out as the course editor
 * (B editor: main column, side column, save bar). "Kustuta postitus" asks first.
 */
export function PostEditor({ initial, created }: { initial: Loaded<{ post: PostDraft }>; created: boolean }) {
  const t = adminEt.post;
  const uid = useId();
  const isNew = initial.values.post.id == null;
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, savePost, form, { always: isNew });
  const p = d.draft.post;
  const saved = d.base.values.post;
  const set = (patch: Partial<PostDraft>) => d.update("post", (x) => ({ ...x, ...patch }));
  const err = (f: string) => {
    const e = d.err(`post.${f}`);
    return f === "slug" && e === adminEt.courseEditor.errors.slugTaken ? t.slugTaken : e;
  };

  const [confirming, setConfirming] = useState(false);
  const [delState, del, delPending] = useActionState<EditResult | null, FormData>(deletePost, null);
  const confirmText = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (confirming) confirmText.current?.focus();
  }, [confirming]);
  const remove = () => {
    if (delPending || p.id == null) return;
    const fd = new FormData();
    fd.set("id", String(p.id));
    startTransition(() => del(fd));
  };

  const title = p.title.et.trim() || t.newTitle;

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-post-editor="">
      <div className={ui.heading}>
        <div className={layout.headText}>
          <nav className={layout.crumb} aria-label={t.crumb}>
            <Link href="/admin/uudised">{t.crumb}</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{isNew ? t.newCrumb : t.editCrumb}</span>
          </nav>
          <h1 className={`${ui.h1} ${layout.title}`}>{title}</h1>
          <div className={layout.tags}>
            <span className={`${ui.tag} ${saved.published && !isNew ? ui.ok : ui.warn}`} data-post-state="">
              {saved.published && !isNew ? adminEt.news.published : adminEt.news.draft}
            </span>
          </div>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          {!isNew && saved.published && (
            <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={`/uudised/${saved.slug}`} target="_blank" rel="noopener">
              {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
            </a>
          )}
        </div>
      </div>

      {created && (
        <p className={ui.notice} role="status">
          {t.created}
        </p>
      )}

      <div className={layout.grid}>
        <div className={layout.main}>
          <section className={ui.card} aria-labelledby={`${uid}-text`}>
            <h2 id={`${uid}-text`} className={`${ui.h2} ${layout.cardTitle}`}>
              {t.sections.text}
            </h2>
            <div className={ed.grid}>
              <div className={ed.wide}>
                <I18nInput label={t.title} value={p.title} onChange={(v) => set({ title: v })} maxLength={SITE_LIMITS.postTitle} error={err("title")} name="post.title" />
              </div>
              <TextField
                className={ed.wide}
                label={t.slug}
                value={p.slug}
                onChange={(slug) => set({ slug })}
                maxLength={80}
                hint={fill(t.slugHint, { slug: p.slug || "…" }) + (!isNew && saved.published && p.slug !== saved.slug ? ` ${t.slugChanged}` : "")}
                error={err("slug")}
                name="post.slug"
              />
              <div className={ed.wide}>
                <I18nInput label={t.category} value={p.category} onChange={(v) => set({ category: v })} maxLength={SITE_LIMITS.category} hint={t.categoryHint} error={err("category")} name="post.category" />
              </div>
              <div className={ed.wide}>
                <I18nInput label={t.excerpt} value={p.excerpt} onChange={(v) => set({ excerpt: v })} multiline rows={2} maxLength={SITE_LIMITS.excerpt} hint={t.excerptHint} error={err("excerpt")} name="post.excerpt" />
              </div>
              <div className={ed.wide}>
                <I18nInput label={t.body} value={p.body} onChange={(v) => set({ body: v })} multiline rows={14} maxLength={SITE_LIMITS.postBody} hint={t.bodyHint} error={err("body")} name="post.body" />
              </div>
            </div>
          </section>
        </div>

        <aside className={layout.side}>
          <section className={ui.card} aria-labelledby={`${uid}-publish`}>
            <h2 id={`${uid}-publish`} className={`${ui.h3} ${layout.cardTitle}`}>
              {t.sections.publish}
            </h2>
            <div className={styles.fields}>
              <Choice
                className={ed.check}
                label={t.published}
                hint={t.publishedHint}
                hintClassName={`${ui.muted} ${ui.small}`}
                type="checkbox"
                value="1"
                checked={p.published}
                onChange={(e) => set({ published: e.target.checked })}
                data-field="post.published"
              />
              <TextField label={t.date} type="date" value={p.publishedAt} onChange={(publishedAt) => set({ publishedAt })} hint={t.dateHint} error={err("publishedAt")} name="post.publishedAt" />
            </div>
          </section>

          <section className={ui.card} aria-labelledby={`${uid}-cover`}>
            <h2 id={`${uid}-cover`} className={`${ui.h3} ${layout.cardTitle}`}>
              {t.sections.cover}
            </h2>
            <SingleImage label={t.sections.cover} value={p.coverKey} onChange={(coverKey) => set({ coverKey })} hint={t.coverHint} error={err("coverKey")} ratio="4 / 3" removable={!p.published} labelHidden name="cover" />
          </section>

          {!isNew && (
            <section className={`${ui.card} ${styles.danger}`} aria-label={t.remove.button} data-post-delete="">
              {confirming ? (
                <>
                  <p ref={confirmText} tabIndex={-1} className={ui.notice}>
                    {t.remove.confirm}
                  </p>
                  <span className={styles.dangerTools}>
                    <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={delPending || undefined} onClick={remove}>
                      {delPending ? adminEt.common.saving : t.remove.yes}
                    </button>
                    <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => setConfirming(false)}>
                      {t.remove.no}
                    </button>
                  </span>
                </>
              ) : (
                <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn} ${styles.start}`} onClick={() => setConfirming(true)}>
                  {t.remove.button}
                </button>
              )}
              {delState && !delState.ok && (
                <p role="alert" className={ui.error}>
                  {delState.error === "notFound" ? t.notFound : adminEt.common.saveError}
                </p>
              )}
            </section>
          )}
        </aside>
      </div>

      <SaveBar status={d.status} pending={d.pending} reloadHref={p.id ? `/admin/uudised/${p.id}` : "/admin/uudised/uus"} />
    </form>
  );
}
