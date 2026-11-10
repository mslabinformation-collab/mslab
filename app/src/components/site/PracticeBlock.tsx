import Link from "next/link";
import { Icon } from "./Icon";
import { PackageFrame } from "./PackageFrame";
import ui from "./ui.module.css";
import styles from "./PracticeBlock.module.css";

export type PracticePackageView = {
  code: string;
  name: string;
  tagline: string;
  items: string[];
  /** Admin-editable approximate duration, e.g. "8 ak" (H10). */
  duration: string;
  price: string;
  href: string;
};

export type PracticeTexts = {
  eyebrow: string;
  title: string;
  /** B's slogan under the title; left out on the practice page, where it is the panel title. */
  slogan?: string;
  text: string;
  protocolTitle: string;
  protocolText: string;
  /** What the protocol sums up (practice page only). */
  protocolPoints?: string[];
  packageLabel: string;
  durationLabel: string;
  register: string;
};

/**
 * Prototype B `practicePanel()` (dark panel, MINI / MAXI cards) with Maria's changes: "Praktika" is the big
 * heading and comes first (C08 / H11) with "Individuaalpraktika · Pärnus ja Tallinnas" above it (C22); B's slogan and
 * text are secondary; each card shows the approximate duration (C07 / H10); the price is Jost 400 28px (C09 / H12).
 *
 * `variant="page"` is the panel on /praktika, under the page's own "Praktika" H1: B's slogan is the (smaller) panel
 * title, the protocol points are listed, and the card of the package in ?pakett is outlined as in B (`selected`).
 */
export function PracticeBlock({ t, packages, variant = "home" }: { t: PracticeTexts; packages: PracticePackageView[]; variant?: "home" | "page" }) {
  const titleId = "practice-title";
  const page = variant === "page";
  return (
    <section className={`${styles.section} ${page ? styles.onPage : ""}`} data-practice="" aria-labelledby={titleId}>
      <div className={ui.wrap}>
        <div className={styles.panel}>
          <div className={styles.intro}>
            <p className={`${ui.eyebrow} ${styles.eyebrow}`}>{t.eyebrow}</p>
            <h2 id={titleId} className={page ? styles.pageTitle : styles.title}>
              {t.title}
            </h2>
            {t.slogan && <p className={styles.slogan}>{t.slogan}</p>}
            <p className={styles.text}>{t.text}</p>
            <div className={styles.protocol}>
              <h3 className={styles.protocolTitle}>{t.protocolTitle}</h3>
              <p className={styles.text}>{t.protocolText}</p>
              {t.protocolPoints && t.protocolPoints.length > 0 && (
                <ul className={styles.points}>
                  {t.protocolPoints.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className={styles.options}>
            {packages.map((p) => (
              <PackageFrame key={p.code} code={p.code} className={styles.card} track={page}>
                <div className={styles.cardTop}>
                  <span className={`${ui.eyebrow} ${styles.cardEyebrow}`}>{t.packageLabel}</span>
                  <Icon name="flower" className={styles.flower} />
                </div>
                <h3 className={styles.name}>{p.name}</h3>
                {p.tagline && <p className={styles.tagline}>{p.tagline}</p>}
                {p.items.length > 0 && (
                  <ul className={styles.items}>
                    {p.items.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                )}
                <div className={styles.priceRow}>
                  <span className={styles.price} data-price="">
                    {p.price}
                  </span>
                  {p.duration && (
                    <span className={styles.duration}>
                      <Icon name="clock" size={15} />
                      <span>
                        <span className={ui.srOnly}>{t.durationLabel}: </span>≈ {p.duration}
                      </span>
                    </span>
                  )}
                </div>
                <Link className={`${ui.btn} ${ui.btnFull}`} href={p.href}>
                  {t.register}
                  <span className={ui.srOnly}> {p.name}</span>
                  <Icon name="arrow" />
                </Link>
              </PackageFrame>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
