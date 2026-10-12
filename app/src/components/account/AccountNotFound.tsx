"use client";

import Link from "next/link";
import { Icon } from "@/components/site/Icon";
import { Notice } from "@/components/site/Notice";
import ui from "@/components/site/ui.module.css";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";

/**
 * An account page about a registration that is not hers, or not there (phase protocols: the protocol's page, the feedback form): the one
 * sentence and the one way back, to Minu koolitused. `state` names the case for the tests (data-account-state).
 */
export function AccountNotFound({ state, title, back, locale }: { state: string; title: string; back: string; locale: Locale }) {
  return (
    <div data-account-state={state}>
      <Notice title={title}>
        <Link className={ui.btn} href={href(locale, "/konto")}>
          {back}
          <Icon name="arrow" />
        </Link>
      </Notice>
    </div>
  );
}
