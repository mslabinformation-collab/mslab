import Link from "next/link";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import styles from "./ListToolbar.module.css";

/** „registreerimisi“ → „Registreerimisi“ (a sentence's first word). */
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The two empty states of an admin list (admin UX pass, README §1.10), in the list's card where its table would be. `things` is the page's word
 * for what is listed, as it stands in a sentence („registreerimisi“, „õpilasi“, „makseid“).
 *
 * - Nothing exists: „{Asju} veel pole.“ and nothing else (say so, offer nothing).
 * - `filtered` (a search or a filter is on): „Selle valikuga {asju} pole.“ and, with a `clearHref` (the list without ?otsi= and its filters),
 *   the button „Tühjenda otsing ja filtrid“.
 */
export function ListEmpty({ things, filtered, clearHref }: { things: string; filtered: boolean; clearHref?: string }) {
  const t = adminEt.lists;
  const text = fill(filtered ? t.emptyFiltered : t.empty, { Asju: capitalise(things), asju: things });
  return (
    <div className={styles.empty} data-list-empty="">
      <p className={styles.emptyText}>{text}</p>
      {filtered && clearHref !== undefined && (
        <Link className={styles.clearAll} href={clearHref}>
          {t.clearAll}
        </Link>
      )}
    </div>
  );
}
