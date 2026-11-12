"use client";

import Link from "next/link";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./CourseBuy.module.css";

export type ELearningBuyTexts = { priceLabel: string; payLine: string; payLineFinancing: string; buyNow: string };

/**
 * E-learning purchase (Maria's overview, P8 / P9; UX pass 11.11 P3): one price, one quiet line on how it is paid, and "Osta kohe", which goes to the
 * cart, where the way to pay is chosen. No radio: a single option is not a choice, and the cart has the real one. While Järelmaks (Inbank) is offered
 * (`financing`: the course page reads the toggle, the payments and the price, instalments D4) the line names both ways, „Maksmine: pangalink või Inbanki
 * järelmaks (vali ostukorvis)“, and carries `data-financing-line`; otherwise it says „Maksmine: pangalink“.
 */
export function ELearningBuy({ price, href, financing, t }: { price: string; href: string; financing: boolean; t: ELearningBuyTexts }) {
  return (
    <div className={styles.buy} data-buy="">
      <p className={styles.priceRow}>
        <span className={styles.priceLabel}>{t.priceLabel}</span>
        <span className={styles.price}>{price}</span>
      </p>
      <p className={styles.financingLine} data-pay-line="" data-financing-line={financing ? "" : undefined}>
        {financing ? t.payLineFinancing : t.payLine}
      </p>
      <Link className={`${ui.btn} ${ui.btnFull}`} href={href}>
        {t.buyNow}
        <Icon name="bag" />
      </Link>
    </div>
  );
}
