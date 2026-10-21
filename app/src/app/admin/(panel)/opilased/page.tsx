import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { getAdminCounts } from "@/components/admin/data";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { AddStudentForm } from "@/components/admin/ClientForms";
import { Drawer } from "@/components/admin/Drawer";
import { Pager } from "@/components/admin/Pager";
import listTable from "@/components/admin/list-table.module.css";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { parsePage, parseSearch } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { clientDetail, listClients, listEcourses, type ClientFilter } from "@/server/admin-clients";
import { requireAdmin } from "@/server/auth";
import styles from "./clients.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.clients) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (as the inboxes): ?vorm=e|k (E-õpe: any e-course access; Kontaktõpe: a registration on a contact course),
// ?otsi=<part of the name or e-mail>, ?leht=<n> (50 a page), ?id=<student> (drawer). A new filter or search starts again at
// page 1; the drawer keeps the list it was opened from.

type View = { vorm: "e" | "k" | null; otsi: string; leht: number };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View & { id: number | null } {
  const vorm = one(sp.vorm);
  const id = Number(one(sp.id));
  return {
    vorm: vorm === "e" || vorm === "k" ? vorm : null,
    otsi: parseSearch(sp.otsi),
    leht: parsePage(sp.leht),
    id: Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null,
  };
}

function href(view: View, id?: number): string {
  const q = new URLSearchParams();
  if (view.vorm) q.set("vorm", view.vorm);
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.leht > 1) q.set("leht", String(view.leht));
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/opilased${s ? `?${s}` : ""}`;
}

/**
 * Õpilased (A4, phase 2a): "Lisa õpilane", the filter Kõik / E-õpe / Kontaktõpe, a search by name or e-mail, the list
 * (name and e-mail, when the account was made, how many courses) and a drawer per student, where e-course access is
 * opened and ended and her own account page can be looked at, read-only.
 */
export default async function ClientsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const now = new Date();
  const filter: ClientFilter = view.vorm ?? "all";
  // the shell's counts are read here too (memoised), so the page does not wait for the list before asking for them
  const [list, open, ecourses] = await Promise.all([
    listClients(db, { filter, q: view.otsi, page: view.leht }),
    view.id ? clientDetail(db, view.id, now) : null,
    view.id ? listEcourses(db, now) : [],
    getAdminCounts(),
  ]);
  const t = adminEt.clients;
  const filtered = view.vorm !== null || view.otsi !== "";

  const typeLinks: { key: View["vorm"]; label: string }[] = [
    { key: null, label: t.type.all },
    { key: "e", label: t.type.e },
    { key: "k", label: t.type.k },
  ];

  return (
    <>
      <div className={ui.page}>
        <div className={`${ui.heading} ${styles.heading}`}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          {/* a new key after the drawer opened: the field starts empty again */}
          <AddStudentForm
            key={view.id ?? 0}
            t={{ ...t.add, saving: adminEt.common.saving, error: adminEt.common.saveError }}
          />
        </div>

        <div className={styles.tools}>
          <nav className={ui.filters} aria-label={t.typeLabel} data-type-filter="">
            {typeLinks.map((l) => (
              <Link key={l.label} className={ui.pill} href={href({ ...view, vorm: l.key, leht: 1 })} aria-current={view.vorm === l.key ? "true" : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <Form action="/admin/opilased" className={styles.search} role="search" data-client-search="">
            {view.vorm && <input type="hidden" name="vorm" value={view.vorm} />}
            <label className={ui.sr} htmlFor="client-search">
              {t.searchLabel}
            </label>
            <input
              id="client-search"
              className={`${ui.input} ${styles.searchInput}`}
              type="search"
              name="otsi"
              defaultValue={view.otsi}
              placeholder={t.searchLabel}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className={`${ui.btn} ${ui.smallBtn}`}>
              {t.search}
            </button>
            {view.otsi && (
              <Link className={ui.link} href={href({ ...view, otsi: "", leht: 1 })}>
                {t.clearSearch}
              </Link>
            )}
          </Form>
        </div>

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {list.rows.length > 0 && (
            <p className={`${ui.muted} ${ui.small} ${styles.count}`} data-courses-hint="">
              {t.coursesHint}
            </p>
          )}
          {list.rows.length === 0 ? (
            <p className={ui.empty}>{filtered ? t.emptyFiltered : t.empty}</p>
          ) : (
            <table className={`${ui.table} ${listTable.table}`}>
              <thead>
                <tr>
                  <th scope="col">{t.col.name}</th>
                  <th scope="col">{t.col.created}</th>
                  <th scope="col">{t.col.courses}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((c) => (
                  <tr key={c.id} data-client={c.id}>
                    <td data-label={t.col.name}>
                      <div className={listTable.who}>
                        <Link id={`client-${c.id}`} className={listTable.name} href={href(view, c.id)} scroll={false} aria-label={fill(t.open, { name: c.name || c.email })}>
                          {c.name || c.email}
                        </Link>
                        {c.name && <span className={styles.email}>{c.email}</span>}
                      </div>
                    </td>
                    <td data-label={t.col.created} className={ui.nowrap}>
                      {formatDate(c.createdAt, "et")}
                    </td>
                    <td data-label={t.col.courses} data-client-courses="">
                      {c.courses}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>

      {view.id !== null && (
        <Drawer
          label={open ? fill(t.drawer.label, { name: open.client.name || open.client.email }) : t.drawer.notFound}
          closeHref={href(view)}
          closeLabel={t.drawer.close}
          returnFocus={open ? `client-${open.client.id}` : undefined}
        >
          {open ? <ClientDetailView key={open.client.id} detail={open} ecourses={ecourses} now={now} /> : <p className={ui.empty}>{t.drawer.notFound}</p>}
        </Drawer>
      )}
    </>
  );
}
