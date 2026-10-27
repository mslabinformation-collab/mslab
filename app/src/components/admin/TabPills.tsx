import Link from "next/link";
import ui from "./ui.module.css";
import styles from "./TabPills.module.css";

/** `short`: the label on a phone (up to 640 px) when it differs, as Part 4 draws Tagasiside's „Arvustused · Ootab {n}“ (piece 4c, S4-35). */
export type TabPill = { href: string; label: string; count?: number; current: boolean; short?: string };

/**
 * Tabs as pill links (the A screens, Task 1; the prototype's „Maksed“ | „Arved“ and the Päringud tabs): a `nav` named by `label`, one link to each
 * tab's own address (every tab is a page of its own: Back, a bookmark and a deep link all work), the current one marked aria-current="page" (the
 * shared pill style, ui.pill, turns it dark). A count follows the label in the shared count bubble (ui.pillCount) when the tab has one; 0 is shown.
 * A tab with a `short` label shows it on a phone instead (one of the two is drawn, so one is in the accessibility tree).
 *
 * The page builds the addresses (they carry the search and what else belongs to every tab). No state and no "use client" line: a server page
 * draws it as it is (tests/unit/old-safari.test.ts lists it). Not the ListToolbar's pills: those filter one list, these switch between lists.
 */
export function TabPills({ label, tabs }: { label: string; tabs: TabPill[] }) {
  return (
    <nav className={styles.tabs} aria-label={label} data-tab-pills="">
      {tabs.map((tab) => (
        <Link key={tab.href} className={ui.pill} href={tab.href} aria-current={tab.current ? "page" : undefined}>
          {tab.short === undefined ? (
            tab.label
          ) : (
            <>
              <span className={styles.wide}>{tab.label}</span>
              <span className={styles.short}>{tab.short}</span>
            </>
          )}
          {tab.count !== undefined && <span className={ui.pillCount}>{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
