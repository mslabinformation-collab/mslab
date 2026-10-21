import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CourseOrder } from "@/components/admin/CourseOrder";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAllCourses, type AdminCourse } from "@/db/queries/admin";
import { shownBadge } from "@/domain/badge";
import { formatEUR } from "@/domain/money";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { requireAdmin } from "@/server/auth";
import styles from "./courses.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.courses) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const FORMS = { e: "e_learning", k: "contact" } as const;

/** "190 €" for e-learning; "Grupp 350 € · Individuaal 450 €" for contact (only the offered ones). */
function priceText(c: AdminCourse): string {
  const r = adminEt.registrations;
  if (c.type === "e_learning") return c.price != null ? formatEUR(c.price, "et") : adminEt.courses.noPrice;
  const parts = [c.priceGroup != null ? `${r.group} ${formatEUR(c.priceGroup, "et")}` : "", c.priceIndividual != null ? `${r.individual} ${formatEUR(c.priceIndividual, "et")}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : adminEt.courses.noPrice;
}

/**
 * Koolitused (B adminOther "courses"): every course, drafts included, in the public order, with its type, price,
 * badge (D: shown as on the card), published / draft and the "Näidis" mark of prototype content. "Lisa koolitus"
 * opens an empty editor. The order is changed with ↑ / ↓ (in the unfiltered list, where the neighbours are visible).
 */
export default async function CoursesPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const vorm = sp.vorm === "e" || sp.vorm === "k" ? sp.vorm : null;
  const all = await listAllCourses(getDb());
  const list = vorm ? all.filter((c) => c.type === FORMS[vorm]) : all;
  const t = adminEt.courses;
  const filters: { key: "e" | "k" | null; label: string }[] = [
    { key: null, label: t.filter.all },
    { key: "e", label: t.filter.e },
    { key: "k", label: t.filter.k },
  ];

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <Link className={ui.btn} href="/admin/koolitused/uus" data-add-course="">
          {t.add} +
        </Link>
      </div>

      <nav className={ui.filters} aria-label={t.typeLabel} data-type-filter="">
        {filters.map((f) => (
          <Link key={f.label} className={ui.pill} href={f.key ? `/admin/koolitused?vorm=${f.key}` : "/admin/koolitused"} aria-current={vorm === f.key ? "true" : undefined}>
            {f.label}
          </Link>
        ))}
      </nav>

      <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.length })}</p>
        {list.length === 0 ? (
          <p className={ui.empty}>{vorm ? t.emptyFiltered : t.empty}</p>
        ) : (
          <table className={`${ui.table} ${styles.table}`}>
            <thead>
              <tr>
                {!vorm && <th scope="col">{t.col.order}</th>}
                <th scope="col">{t.col.course}</th>
                <th scope="col">{t.col.type}</th>
                <th scope="col">{t.col.price}</th>
                <th scope="col">{t.col.badge}</th>
                <th scope="col">{t.col.status}</th>
                <th scope="col">{t.col.updated}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => {
                const name = pick(c.title, "et");
                const image = c.images[0];
                return (
                  <tr key={c.id} data-course-row={c.slug}>
                    {!vorm && (
                      <td data-label={t.col.order}>
                        <CourseOrder id={c.id} name={name} first={i === 0} last={i === list.length - 1} />
                      </td>
                    )}
                    <td data-label={t.col.course}>
                      <div className={styles.course}>
                        {image ? <Image className={styles.thumb} src={mediaUrl(image.key)} alt="" width={56} height={56} unoptimized /> : <span className={styles.thumb} aria-hidden="true" />}
                        <span className={styles.courseText}>
                          <Link className={styles.name} href={`/admin/koolitused/${c.id}`} aria-label={fill(t.edit, { name })}>
                            {name}
                          </Link>
                          <span className={`${ui.muted} ${styles.sub}`}>
                            {t.level[c.level]} · /{c.slug}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td data-label={t.col.type}>
                      <span className={`${ui.tag} ${c.type === "e_learning" ? ui.dark : ""}`}>{t.type[c.type]}</span>
                    </td>
                    <td data-label={t.col.price}>{priceText(c)}</td>
                    <td data-label={t.col.badge}>
                      {shownBadge(c.badge, "et") ? (
                        <span className={styles.badge} style={{ background: c.badge!.bg, color: c.badge!.fg }} data-badge="">
                          {shownBadge(c.badge, "et")!.label}
                        </span>
                      ) : (
                        t.noBadge
                      )}
                    </td>
                    <td data-label={t.col.status}>
                      <span className={styles.states}>
                        <span className={`${ui.tag} ${c.published ? ui.ok : ui.warn}`} data-course-state="">
                          {c.published ? t.published : t.draft}
                        </span>
                        {c.isSample && (
                          <span className={`${ui.tag} ${styles.sample}`} title={t.sampleTitle} data-sample="">
                            {t.sample}
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label={t.col.updated} className={ui.nowrap}>
                      {formatDate(c.updatedAt, "et")}
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
