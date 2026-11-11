import { Icon } from "./Icon";
import styles from "./CourseLists.module.css";

/**
 * "Koolitus sisaldab" (P8, P10): a check list. Contact courses use Maria's eight items from the course's `includes`. „Pärast koolitust oskad“ is the
 * same list (UX pass 11.11 P15: one tick on the page), `name` "outcomes" its data name.
 */
export function IncludesList({ items, name = "includes" }: { items: string[]; name?: "includes" | "outcomes" }) {
  return (
    <ul className={styles.includes} {...{ [`data-${name}`]: "" }}>
      {items.map((x) => (
        <li key={x}>
          <span className={styles.tick} aria-hidden="true">
            <Icon name="check" size={13} />
          </span>
          {x}
        </li>
      ))}
    </ul>
  );
}
