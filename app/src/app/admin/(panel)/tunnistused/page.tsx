import type { Metadata } from "next";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import listTable from "@/components/admin/list-table.module.css";
import { Pager } from "@/components/admin/Pager";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { parsePage } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import { listCertificates } from "@/server/certificates";
import styles from "./register.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.certificates.register.title) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Tunnistused (phase 3d, spec §6): every issued e-course certificate, newest first, 50 a page (?leht=) — its number, the name printed (a link
 * to her drawer in Õpilased), the course's title as printed, the issue day (and the re-issue day; "ligipääs tühistatud" for an access an admin
 * ended: Maria's download works all the same, Review Focus 5) and "Laada alla". Reached from Hindamine, not from the menu: the shell marks
 * Hindamine.
 */
export default async function CertificateRegisterPage({ searchParams }: Props) {
  await requireAdmin();
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list] = await Promise.all([listCertificates(getDb(), parsePage((await searchParams).leht)), getAdminCounts()]);
  const t = adminEt.certificates.register;
  // the register says "nimi parandatud", "ligipääs tühistatud" and "Laada alla" in the drawer's words: one set of texts
  const d = adminEt.certificates.drawer;

  return (
    <div className={ui.page} data-certificate-register="">
      <p className={styles.back}>
        <Link className={ui.link} href="/admin/hindamine">
          <span aria-hidden="true">←</span> {t.back}
        </Link>
      </p>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
      </div>

      <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
        <p className={`${ui.muted} ${ui.small}`} data-register-count="">
          {fill(t.count, { n: list.total })}
        </p>
        {list.rows.length === 0 ? (
          <p className={ui.empty}>{t.empty}</p>
        ) : (
          <table className={`${ui.table} ${listTable.table}`}>
            <thead>
              <tr>
                <th scope="col">{t.col.number}</th>
                <th scope="col">{t.col.name}</th>
                <th scope="col">{t.col.course}</th>
                <th scope="col">{t.col.issued}</th>
                <th scope="col">{t.col.file}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} data-register-row={r.id}>
                  <td data-label={t.col.number} className={ui.nowrap}>
                    <strong>{r.number}</strong>
                  </td>
                  <td data-label={t.col.name}>
                    <Link className={listTable.name} href={`/admin/opilased?id=${r.clientId}`} aria-label={fill(t.openStudent, { name: r.name })}>
                      {r.name}
                    </Link>
                  </td>
                  <td data-label={t.col.course}>{r.course}</td>
                  <td data-label={t.col.issued}>
                    <span className={styles.issued}>
                      <span className={ui.nowrap}>{formatDate(r.issuedAt, "et")}</span>
                      {r.reissuedAt && <span className={styles.note}>{fill(d.reissued, { date: formatDate(r.reissuedAt, "et") })}</span>}
                      {r.revoked && (
                        <span className={`${ui.tag} ${ui.bad}`} data-register-revoked="">
                          {d.revoked}
                        </span>
                      )}
                    </span>
                  </td>
                  <td data-label={t.col.file}>
                    <a className={ui.link} href={`/api/admin/tunnistus/${r.id}`} aria-label={fill(d.downloadLabel, { number: r.number })} data-register-download="">
                      {d.download}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager info={list} href={(n) => `/admin/tunnistused${n > 1 ? `?leht=${n}` : ""}`} />
      </section>
    </div>
  );
}
