import Image from "next/image";
import Link from "next/link";
import type { ShownBadge } from "@/domain/badge";
import { keepNameTogether } from "@/domain/title-breaks";
import { Icon } from "./Icon";
import styles from "./CourseCard.module.css";

export type CourseCardData = {
  id: number;
  type: "e_learning" | "contact";
  href: string;
  title: string;
  summary: string;
  image: string;
  imageAlt: string;
  /** In the page's language (domain/badge.ts). */
  badge: ShownBadge;
  /** Format and level chips on the photo. */
  tags: string[];
  /** Contact: next date and city; e-learning: "Veebis · alusta kohe". */
  meta: { lead?: string; text: string };
  price: string;
};

/**
 * Prototype B `courseCard` (journey.js badge top right, chips bottom left) with D's type-specific meta line (K12).
 * `square`: the catalogue and recommendation grids use D's 1:1 photo instead of B's fixed photo height.
 */
export function CourseCard({ c, square, sizes = "(max-width: 640px) 100vw, (max-width: 1180px) 50vw, 25vw" }: { c: CourseCardData; square?: boolean; sizes?: string }) {
  return (
    <Link className={styles.card} href={c.href} data-course-card="" data-type={c.type}>
      <div className={square ? `${styles.photo} ${styles.square}` : styles.photo} data-card-photo="">
        {c.image && <Image className={styles.image} src={c.image} alt={c.imageAlt} fill unoptimized sizes={sizes} />}
        {c.badge?.label && (
          <span className={styles.badge} style={{ background: c.badge.bg, color: c.badge.fg }}>
            {c.badge.label}
          </span>
        )}
        <span className={styles.tags}>
          {c.tags.map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </span>
        <span className={styles.arrow} aria-hidden="true">
          <Icon name="up" />
        </span>
      </div>
      <h3 className={styles.title}>{keepNameTogether(c.title)}</h3>
      <p className={styles.summary}>{c.summary}</p>
      <div className={styles.meta}>
        {c.meta.lead ? (
          <span>
            {c.meta.lead} · <span className={styles.place}>{c.meta.text}</span>
          </span>
        ) : (
          <span>{c.meta.text}</span>
        )}
        <span className={styles.price}>{c.price}</span>
      </div>
    </Link>
  );
}
