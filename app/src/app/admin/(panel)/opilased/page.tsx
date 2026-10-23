import type { Metadata } from "next";
import Link from "next/link";
import { ClientDetailView } from "@/components/admin/ClientDrawer";
import { AddStudentForm } from "@/components/admin/ClientForms";
import { Drawer } from "@/components/admin/Drawer";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill } from "@/components/admin/ListToolbar";
import { Pager } from "@/components/admin/Pager";
import { ListRows } from "@/components/admin/ListRows";
import listTable from "@/components/admin/list-table.module.css";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { parsePage, parseSearch } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { clientCounts, clientDetail, listClients, listEcourses, type ClientFilter } from "@/server/admin-clients";
import { requireAdmin } from "@/server/auth";
import styles from "./clients.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.clients) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (as the inboxes): ?vorm=e|k (E-õpe: any e-course access; Kontaktõpe: a registration on a contact course),
// ?otsi=<part of the name, the e-mail or the phone> (as she types, B7), ?leht=<n> (50 a page), ?id=<student> (drawer). A new filter or search starts again at
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

/** The list's own query (no drawer): the form, the search and the page, in the order the address holds them. */
function query(view: View): string {
  const q = new URLSearchParams();
  if (view.vorm) q.set("vorm", view.vorm);
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.leht > 1) q.set("leht", String(view.leht));
  return q.toString();
}

function href(view: View, id?: number): string {
  const q = new URLSearchParams(query(view));
  if (id) q.set("id", String(id));
  const s = q.toString();
  return `/admin/opilased${s ? `?${s}` : ""}`;
}

/**
 * Õpilased (A5): "Lisa õpilane +" in the header (a small form), the toolbar (the search as she types over name, e-mail and phone; the form pills Kõik / E-õpe /
 * Kontaktõpe with their counts), the list (name and e-mail, when the account was made, how many courses: the column header says what "Koolitusi" counts) and a
 * drawer per student, where her courses are listed with their own actions, e-course access is opened, extended and ended and her own account page can be looked
 * at, read-only (ClientDetailView).
 */
export default async function ClientsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const now = new Date();
  const filter: ClientFilter = view.vorm ?? "all";
  const [list, counts, open, ecourses] = await Promise.all([
    listClients(db, { filter, q: view.otsi, page: view.leht }),
    clientCounts(db, view.otsi),
    view.id ? clientDetail(db, view.id, now) : null,
    view.id ? listEcourses(db, now) : [],
  ]);
  const t = adminEt.clients;
  const filtered = view.vorm !== null || view.otsi !== "";

  // each pill goes to the list with that form chosen and the search kept, from page 1; its count is what it then lists (the search's, whichever form is chosen)
  const typePills: ListPill[] = [
    { key: null, label: t.type.all, count: counts.all },
    { key: "e" as const, label: t.type.e, count: counts.e },
    { key: "k" as const, label: t.type.k, count: counts.k },
  ].map((p) => ({ href: href({ ...view, vorm: p.key, leht: 1 }), label: p.label, count: p.count, current: view.vorm === p.key }));

  return (
    <>
      <div className={ui.page}>
        <div className={`${ui.heading} ${styles.heading}`}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          {/* a new key after the drawer opened: the form starts closed and empty again */}
          <AddStudentForm key={view.id ?? 0} back={query(view)} t={{ ...t.add, saving: adminEt.common.saving, error: adminEt.common.saveError }} />
        </div>

        <ListToolbar placeholder={t.searchPlaceholder} pillRows={[{ label: t.typeLabel, pills: typePills }]} />

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.total })}</p>
          {list.rows.length === 0 ? (
            <ListEmpty things={t.things} filtered={filtered} search={view.otsi} clearHref="/admin/opilased" />
          ) : (
            <>
              {/* what "Koolitusi" counts: the column header's title, and its description for a screen reader */}
              <span id="clients-courses-hint" className={ui.sr} data-courses-hint="">
                {t.coursesHint}
              </span>
              <ListRows>
                <table className={`${ui.table} ${listTable.table}`}>
                  <thead>
                    <tr>
                      <th scope="col">{t.col.name}</th>
                      <th scope="col">{t.col.created}</th>
                      <th scope="col" title={t.coursesHint} aria-describedby="clients-courses-hint" data-courses-head="">
                        {t.col.courses}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((c) => (
                      <tr key={c.id} data-client={c.id} className={c.id === view.id ? styles.selected : undefined}>
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
              </ListRows>
            </>
          )}
          <Pager info={list} href={(n) => href({ ...view, leht: n })} />
        </section>
      </div>

      {view.id !== null && (
        <Drawer
          label={open ? fill(t.drawer.label, { name: open.client.name || open.client.email }) : t.drawer.notFound}
          closeHref={href(view)}
          closeLabel={adminEt.common.close}
          returnFocus={open ? `client-${open.client.id}` : undefined}
        >
          {open ? <ClientDetailView key={open.client.id} detail={open} ecourses={ecourses} now={now} /> : <p className={ui.empty}>{t.drawer.notFound}</p>}
        </Drawer>
      )}
    </>
  );
}
