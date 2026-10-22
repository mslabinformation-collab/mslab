"use client";

import Link from "next/link";
import { useId } from "react";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./CourseBuy.module.css";

export type ELearningBuyTexts = { priceLabel: string; paymentLabel: string; payNow: string; financingLine: string; buyNow: string };

/**
 * E-learning purchase (Maria's overview, P8 / P9): one price and "Maksa kohe" (100% bank link). "Osta kohe" goes to the cart, where the way to pay is
 * chosen. While Järelmaks (Inbank) is offered (`financing`: the course page reads the toggle, the payments and the price, instalments D4) a quiet line
 * under the price says so: „Võimalik tasuda ka järelmaksuga (Inbank).“ The choice itself is in the cart, not here, and the old disabled placeholder
 * („Vormista järelmaks — tulekul“) is gone.
 */
export function ELearningBuy({ price, href, financing, t }: { price: string; href: string; financing: boolean; t: ELearningBuyTexts }) {
  const id = useId();
  return (
    <div className={styles.buy} data-buy="">
      <p className={styles.priceRow}>
        <span className={styles.priceLabel}>{t.priceLabel}</span>
        <span className={styles.price}>{price}</span>
      </p>
      {financing && (
        <p className={styles.financingLine} data-financing-line="">
          {t.financingLine}
        </p>
      )}
      <fieldset className={styles.options}>
        <legend className={styles.legend}>{t.paymentLabel}</legend>
        <label className={styles.option}>
          <input type="radio" name={`${id}-pay`} value="now" defaultChecked />
          <span className={styles.optionName}>{t.payNow}</span>
        </label>
      </fieldset>
      <Link className={`${ui.btn} ${ui.btnFull}`} href={href}>
        {t.buyNow}
        <Icon name="bag" />
      </Link>
    </div>
  );
}
