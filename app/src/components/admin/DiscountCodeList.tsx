import Link from "next/link";
import type { CodeState } from "@/domain/discount-codes";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { CodeListRow } from "@/server/discount-code-admin";
import { ListRows } from "./ListRows";
import listTable from "./list-table.module.css";
import ui from "./ui.module.css";
import styles from "./DiscountCodeList.module.css";

// The Sooduskoodid list (F1 Task 13, spec §4.10; Dim's approved canvas „Haldus-loend“): the welcome code first, tagged „Tervituskood“ and tinted, the others
// newest first. Columns „Kood“, „Soodustus“ („−10%“ / „−20 €“), „Kehtib“ (the scope in words, or „Valitud koolitustele: {n}“), „Aeg“ („01.12.2026–24.12.2026“,
// else „Tähtajatu“), „Kasutatud“ („3 / 20“, or „3“ without a limit) and „Olek“ (the state as a tag). The table is the shared list table and each row is a link as
// a whole (ListRows): the code is the real Link to its drawer (?kood=<id>), a click anywhere else on the row is forwarded to it. Below 760 px of the card the
// rows become label + value blocks (list-table.module.css). No hook here: the page (a server component) renders it, the click handler is ListRows'.

const t = adminEt.discounts;

/** "2026-12-01" → "01.12.2026" (a day of the Tallinn calendar as written, no clock). */
const dayText = (day: string): string => day.split("-").reverse().join(".");

/** „01.12.2026–07.12.2026“, one day alone as „alates …“ / „kuni …“, no day „Tähtajatu“. */
export function timeText(startsOn: string | null, endsOn: string | null): string {
  if (startsOn && endsOn) return `${dayText(startsOn)}–${dayText(endsOn)}`;
  if (startsOn) return fill(t.from, { date: dayText(startsOn) });
  if (endsOn) return fill(t.until, { date: dayText(endsOn) });
  return t.unlimited;
}

const stateTone = (s: CodeState): string => (s === "active" ? ui.ok : s === "upcoming" ? ui.warn : styles.neutral);

export function DiscountCodeList({ rows, openId, hrefOf }: { rows: readonly CodeListRow[]; openId: number | null; hrefOf: (id: number) => string }) {
  return (
    <ListRows>
      <table className={`${ui.table} ${listTable.table} ${styles.list}`} data-code-list="">
        <thead>
          <tr>
            <th scope="col">{t.col.code}</th>
            <th scope="col">{t.col.value}</th>
            <th scope="col">{t.col.scope}</th>
            <th scope="col">{t.col.time}</th>
            <th scope="col">{t.col.used}</th>
            <th scope="col">{t.col.state}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.welcome ? styles.welcome : r.id === openId ? styles.selected : undefined} data-code-row={r.id} data-welcome={r.welcome ? "" : undefined}>
              <td data-label={t.col.code} className={styles.codeCell}>
                <span className={styles.codeLine}>
                  <Link id={`code-${r.id}`} className={listTable.name} href={hrefOf(r.id)} scroll={false} aria-label={fill(t.edit, { code: r.code })}>
                    {r.code}
                  </Link>
                  {r.welcome && (
                    <span className={`${ui.tag} ${styles.neutral} ${styles.welcomeTag}`} data-welcome-tag="">
                      {t.welcomeTag}
                    </span>
                  )}
                </span>
              </td>
              <td data-label={t.col.value} className={styles.valueCell}>
                −{r.value}
              </td>
              <td data-label={t.col.scope} className={styles.scopeCell}>
                {r.scope === "courses" ? fill(t.scopeCourses, { n: r.courses }) : t.scope[r.scope]}
              </td>
              <td data-label={t.col.time} className={styles.timeCell}>
                {timeText(r.startsOn, r.endsOn)}
              </td>
              <td data-label={t.col.used} className={styles.usedCell}>
                {r.maxUses !== null ? `${r.uses} / ${r.maxUses}` : r.uses}
              </td>
              <td data-label={t.col.state}>
                <span className={`${ui.tag} ${stateTone(r.state)}`} data-code-state={r.state}>
                  {t.state[r.state]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListRows>
  );
}
