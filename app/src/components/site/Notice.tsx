import Link from "next/link";
import { Icon } from "./Icon";
import styles from "./Notice.module.css";

/**
 * A short full-width message page inside the site shell ("Sinu konto avati teises seadmes", "Ei õnnestunud laadida.", 404, the payment's
 * result, the account's "not yours" and "not open yet"). On a screen wider than 900 px its heading and what is under it stand in the middle of
 * the page, as the login page's (LoginForm.module.css), so the heading stays where it was when one leads to the other. `align="start"` keeps
 * it at the left edge at every width: the cart's empty state, which stands where the cart's own page starts.
 * `children`: a button of its own before the links (the account's one action).
 */
export function Notice({
  title,
  text,
  links = [],
  align = "center",
  children,
}: {
  title: string;
  text?: string;
  links?: { href: string; label: string }[];
  align?: "center" | "start";
  children?: React.ReactNode;
}) {
  return (
    <section className={align === "center" ? `${styles.notice} ${styles.centered}` : styles.notice} data-notice-align={align}>
      <h1 className={styles.title}>{title}</h1>
      {text && <p className={styles.text}>{text}</p>}
      <div className={styles.links}>
        {children}
        {links.map((l) => (
          <Link key={l.href} className={styles.link} href={l.href}>
            {l.label}
            <Icon name="arrow" />
          </Link>
        ))}
      </div>
    </section>
  );
}
