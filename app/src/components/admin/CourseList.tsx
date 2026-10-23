"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useOptimistic, useState } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { moveCourseToAction } from "@/server/actions/admin-content";
import type { CourseRowData } from "./course-rows";
import { DragList } from "./DragList";
import { ListRows } from "./ListRows";
import { MoreMenu } from "./MoreMenu";
import { reorder } from "./reorder";
import listTable from "./list-table.module.css";
import ui from "./ui.module.css";
import styles from "./CourseList.module.css";

/** The „↕“ of the phone's menu, as text (U+FE0E): without it some systems draw this arrow as a colour emoji. */
const MOVE_GLYPH = String.fromCodePoint(0x2195, 0xfe0e);

/**
 * The Koolitused list (README B1; the Part 3 desktop frame and the Part 4 phone frame): the courses in the public order, each row a DragList row with
 * the handle ⋮⋮, the arrows ↑ / ↓ (on a phone the „↕“ menu: Üles, Alla, Esimeseks, Viimaseks), the thumbnail, the title with „{tase} · /{slug}“, the type, the price on its
 * lines, the badge and the status. The whole row opens the editor (ListRows; the title is its one link).
 *
 * A move shows at once: the list is reordered in the same tick as the drop or the press (`useOptimistic`, in a transition), so a row never snaps back and
 * then jumps; the server gets one `moveCourseToAction({ id, index })`, and its answer refreshes the page with the stored order. When it fails the
 * optimistic order goes with the transition: the list is the stored one again, and the failure is said. Server actions run one after another, so a second move made
 * before the first is answered is sent with its place in the list as it is drawn. In a filtered view (`ordered` false) the neighbours are not all in sight:
 * no handles, no arrows and no menus, and the columns close up (the page says why: „Järjekorda saab muuta vaates „Kõik“.“).
 *
 * A list of rows (`ol > li`) with the columns drawn by a grid, not a table: DragList moves rows with a transform and a lifted shadow, which a table row does not
 * take in every browser. The grid keeps the README's columns on a wide card, two lines per row on a narrower one, and the phone card from 760 px down.
 */
export function CourseList({ courses, ordered }: { courses: CourseRowData[]; ordered: boolean }) {
  const t = adminEt.courses;
  const [items, moveOptimistic] = useOptimistic(courses, (list: CourseRowData[], m: { from: number; to: number }) => reorder(list, m.from, m.to));
  const [failed, setFailed] = useState(false);

  const onMove = (from: number, to: number) => {
    const id = items[from].id;
    setFailed(false);
    startTransition(async () => {
      moveOptimistic({ from, to });
      let ok = false;
      try {
        ok = (await moveCourseToAction({ id, index: to })).ok;
      } catch {
        ok = false;
      }
      if (!ok) setFailed(true);
    });
  };

  return (
    <ListRows>
      <div data-course-list="" data-ordered={ordered ? "true" : "false"}>
        {failed && (
          <p role="alert" className={`${ui.error} ${ui.small}`} data-course-move-error="">
            {t.moveError}
          </p>
        )}
        <div className={`${styles.head} ${ordered ? "" : styles.plain}`} data-course-head="" aria-hidden="true">
          {ordered && (
            <>
              <span />
              <span>{t.col.order}</span>
            </>
          )}
          <span />
          <span>{t.col.course}</span>
          <span>{t.col.type}</span>
          <span>{t.col.price}</span>
          <span>{t.col.badge}</span>
          <span>{t.col.status}</span>
        </div>
        <DragList<CourseRowData>
          items={items}
          keyOf={(c) => String(c.id)}
          label={(c) => c.name}
          onMove={onMove}
          disabled={!ordered}
          rowClassName={styles.row}
          renderRow={(c, i, handle, arrows, tools) => {
            const last = items.length - 1;
            return (
              <div className={`${styles.grid} ${ordered ? "" : styles.plain}`} data-course-row={c.slug} data-status={c.status}>
                {handle && <div className={styles.handleCell}>{handle}</div>}
                {arrows && <div className={styles.arrowsCell}>{arrows}</div>}
                {c.image ? (
                  <Image className={styles.thumb} src={c.image} alt="" width={56} height={56} unoptimized data-course-thumb="" />
                ) : (
                  <span className={styles.thumb} aria-hidden="true" data-course-thumb="" />
                )}
                <div className={styles.titleCell}>
                  <Link className={`${listTable.name} ${styles.name}`} href={`/admin/koolitused/${c.id}`} aria-label={fill(t.edit, { name: c.name })}>
                    {c.name}
                  </Link>
                  <span className={`${ui.muted} ${styles.sub}`} data-course-sub="">
                    {c.sub}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span className={`${ui.tag} ${c.type === "e_learning" ? ui.dark : ""} ${styles.type}`} data-course-type="">
                    {c.typeLabel}
                  </span>
                  <span className={styles.price} data-course-price="">
                    {c.price.map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                  <span className={styles.badgeCell} data-course-badge="">
                    <span className={ui.sr}>{t.col.badge}: </span>
                    {c.badge ? (
                      <span className={styles.badge} style={{ background: c.badge.bg, color: c.badge.fg }} data-badge="">
                        {c.badge.label}
                      </span>
                    ) : (
                      t.noBadge
                    )}
                  </span>
                </div>
                <div className={styles.statusCell}>
                  <span className={`${ui.tag} ${c.status === "published" ? ui.ok : c.status === "changes" ? ui.warn : styles.draftTag}`} data-course-state="" data-status={c.status}>
                    {c.statusLabel}
                  </span>
                  {c.sample && (
                    <span className={`${ui.tag} ${styles.sample}`} title={t.sampleTitle} data-sample="">
                      {t.sample}
                    </span>
                  )}
                </div>
                <span className={styles.phoneLine} data-course-line="">
                  {[c.typeLabel, c.statusLabel, ...(c.sample ? [t.sample] : [])].join(" · ")}
                </span>
                {ordered && (
                  <div className={styles.menuCell} data-drag-tool="menu">
                    <MoreMenu
                      label={MOVE_GLYPH}
                      variant="icon"
                      buttonLabel={fill(t.moveMenu.button, { name: c.name })}
                      items={[
                        { label: t.moveMenu.up, disabled: i === 0, onSelect: () => tools.moveTo(i - 1) },
                        { label: t.moveMenu.down, disabled: i === last, onSelect: () => tools.moveTo(i + 1) },
                        { label: t.moveMenu.first, disabled: i === 0, onSelect: () => tools.moveTo(0) },
                        { label: t.moveMenu.last, disabled: i === last, onSelect: () => tools.moveTo(last) },
                      ]}
                    />
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>
    </ListRows>
  );
}
