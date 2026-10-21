import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAllPosts } from "@/db/queries/admin";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { requireAdmin } from "@/server/auth";
import styles from "./news.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.news) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Uudised: every post, drafts included, newest first; "Lisa postitus" opens an empty editor (Task 13B). */
export default async function NewsListPage({ searchParams }: Props) {
  await requireAdmin();
  const [sp, list] = await Promise.all([searchParams, listAllPosts(getDb())]);
  const t = adminEt.news;

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <Link className={ui.btn} href="/admin/uudised/uus" data-add-post="">
          {t.add} +
        </Link>
      </div>

      {sp.kustutatud === "1" && (
        <p className={ui.notice} role="status">
          {t.deleted}
        </p>
      )}

      <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.length })}</p>
        {list.length === 0 ? (
          <p className={ui.empty}>{t.empty}</p>
        ) : (
          <table className={`${ui.table} ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col">{t.col.post}</th>
                <th scope="col">{t.col.category}</th>
                <th scope="col">{t.col.date}</th>
                <th scope="col">{t.col.status}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const name = pick(p.title, "et");
                return (
                  <tr key={p.id} data-post-row={p.slug}>
                    <td data-label={t.col.post}>
                      <div className={styles.post}>
                        {p.coverKey ? <Image className={styles.thumb} src={mediaUrl(p.coverKey)} alt="" width={56} height={56} unoptimized /> : <span className={styles.thumb} aria-hidden="true" />}
                        <span className={styles.postText}>
                          <Link className={styles.name} href={`/admin/uudised/${p.id}`} aria-label={fill(t.edit, { name })}>
                            {name}
                          </Link>
                          <span className={`${ui.muted} ${styles.sub}`}>/uudised/{p.slug}</span>
                        </span>
                      </div>
                    </td>
                    <td data-label={t.col.category}>{pick(p.category, "et")}</td>
                    <td data-label={t.col.date} className={ui.nowrap}>
                      {formatDate(p.publishedAt, "et")}
                    </td>
                    <td data-label={t.col.status}>
                      <span className={`${ui.tag} ${p.published ? ui.ok : ui.warn}`} data-post-state="">
                        {p.published ? t.published : t.draft}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
