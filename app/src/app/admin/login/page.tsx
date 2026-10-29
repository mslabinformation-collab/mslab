import { redirect } from "next/navigation";
import { Logo } from "@/components/site/Logo";
import { adminEt } from "@/i18n/dict/admin";
import { PATH_ORIGIN, adminReturnPath } from "@/lib/admin-return";
import { currentAdminEmail } from "@/server/auth";
import { LoginForm } from "./LoginForm";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /admin/login: asks for an e-mail address and sends the login link. ?viga=link / =server: the link did not work. ?tagasi=<admin page>: the page
 * she opened signed out (B19, requireAdmin and SaveStatus send her here with it), sent with the request so the link lands her back there.
 */
export default async function LoginPage({ searchParams }: Props) {
  const { viga, tagasi } = await searchParams;
  // the way back, checked here too: a bad one is dropped without a word (the server checks what the form sends again)
  const back = adminReturnPath(typeof tagasi === "string" ? tagasi : null, PATH_ORIGIN) ?? undefined;
  // Already signed in: straight to the panel (or the page she was on). A failing database must not hide the login page.
  if (await currentAdminEmail().catch(() => null)) redirect(back ?? "/admin");
  const t = adminEt.login;
  const notice = viga === "link" ? t.errorLink : viga === "server" ? t.errorServer : undefined;
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Logo href="/" label={t.back} className={styles.logo} eager />
        <h1 className={styles.title}>{t.title}</h1>
        <p className={styles.lead}>{t.lead}</p>
        <LoginForm
          notice={notice}
          tagasi={back}
          t={{
            emailLabel: t.emailLabel,
            submit: t.submit,
            sending: t.sending,
            sentTitle: t.sentTitle,
            sent: t.sent,
            sentHint: t.sentHint,
            other: t.other,
            errorEmail: t.errorEmail,
            errorTooMany: t.errorTooMany,
            errorAddress: t.errorAddress,
            errorGeneric: t.errorGeneric,
          }}
        />
      </div>
    </main>
  );
}
