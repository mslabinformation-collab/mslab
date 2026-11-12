import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import { AccountLink } from "./AccountLink";
import { HeaderFrame } from "./HeaderFrame";
import { LangSwitch } from "./LangSwitch";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { NavLink } from "./NavLink";
import styles from "./Header.module.css";

/**
 * B header (G3): logo left, six menu links („Kontakt“ the last: UX pass 11.11 P9, Dim's call 3), then ET / RU and "Logi sisse" ("Minu konto"
 * once signed in: AccountLink); burger below 1200px. No cart icon (UX pass 11.11 P2, Dim's call 1): „Osta kohe“ is the checkout.
 * Menu, login and language switch use Manrope 500 15px (G4). `overHero` defaults to "on the home page":
 * there the header is transparent, follows the hero tone (G5) and turns white after scrolling.
 */
export function Header({ locale, overHero }: { locale: Locale; overHero?: boolean }) {
  const d = getDict(locale);
  const home = href(locale, "/");
  const links: [string, string][] = [
    [href(locale, "/koolitused"), d.nav.courses],
    [href(locale, "/koolituskalender"), d.nav.calendar],
    [href(locale, "/praktika"), d.nav.practice],
    [href(locale, "/koolitaja"), d.nav.trainer],
    [href(locale, "/uudised"), d.nav.news],
    [href(locale, "/kontakt"), d.nav.contact],
  ];

  return (
    <>
      <a className={styles.skip} href="#main">
        {d.nav.skip}
      </a>
      <HeaderFrame homePath={home} overHero={overHero}>
        <Logo href={home} label={d.nav.home} className={styles.logo} eager />
        <nav className={styles.nav} aria-label={d.nav.mainLabel}>
          {links.map(([to, label]) => (
            <NavLink key={to} href={to} className={styles.navLink} activeClassName={styles.active}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.actions}>
          <LangSwitch locale={locale} label={d.nav.langSwitch} className={styles.lang} />
          <AccountLink className={styles.login} locale={locale} login={d.nav.login} account={d.nav.account} />
          <MobileMenu openLabel={d.nav.openMenu} closeLabel={d.nav.closeMenu} dialogLabel={d.nav.menu}>
            <Logo href={home} label={d.nav.home} className={styles.menuLogo} />
            <nav className={styles.menuNav} aria-label={d.nav.mainLabel}>
              {links.map(([to, label]) => (
                <NavLink key={to} href={to} className={styles.menuLink}>
                  {label}
                </NavLink>
              ))}
              <LangSwitch locale={locale} label={d.nav.langSwitch} className={styles.menuLang} />
              <AccountLink className={styles.menuLogin} locale={locale} login={d.nav.login} account={d.nav.account} />
            </nav>
          </MobileMenu>
        </div>
      </HeaderFrame>
    </>
  );
}
