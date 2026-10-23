import type { Metadata } from "next";
import { FoldRow } from "@/components/admin/FoldRow";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill } from "@/components/admin/ListToolbar";
import { Pager } from "@/components/admin/Pager";
import { RequestCard } from "@/components/admin/RequestCard";
import { RequestTarget } from "@/components/admin/RequestTarget";
import { changedRegistration, requestView, waitedSession, type RequestLookup } from "@/components/admin/request-view";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listCourseNames, listRegistrations, listSessionsByIds, pageRequests, requestCounts } from "@/db/queries/admin";
import type { Request as RequestRow } from "@/db/schema";
import { parsePage, parseSearch } from "@/domain/paging";
import { REQUEST_TABS, TAB_KIND, type TabKey } from "@/domain/requests";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";
import styles from "./requests.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.requests) };

type Search = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Search> };

// Addresses (README A7, §1.10): ?liik=kontakt|individuaal|praktika|ootenimekiri|muutmine (the tab; Kontakt by default), ?otsi=<text> (the search, across
// every tab: with it ?liik= is only where „Tühjenda otsing“ returns to), ?leht=<n> (the open requests, 50 a page) and ?tehtud=<n> (the done ones in the
// fold „Tehtud ({n})“, 50 a page; the parameter being there at all keeps the fold open). A new search or tab starts at page 1 of both.
// (Muutmine: a student's wish to cancel or move a registration, sent from the account page.)
type View = { tab: TabKey; otsi: string; leht: number; tehtud: number; fold: boolean };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function parse(sp: Search): View {
  const tab = REQUEST_TABS.find((x) => x === one(sp.liik)) ?? "kontakt";
  return { tab, otsi: parseSearch(sp.otsi), leht: parsePage(sp.leht), tehtud: parsePage(sp.tehtud), fold: one(sp.tehtud) !== undefined };
}

/** The address of a view: the tab always (a link into the page names it), the rest only when it is not the start. */
function href(view: { tab: TabKey; otsi?: string; leht?: number; tehtud?: number }): string {
  const q = new URLSearchParams({ liik: view.tab });
  if (view.otsi) q.set("otsi", view.otsi);
  if (view.leht && view.leht > 1) q.set("leht", String(view.leht));
  if (view.tehtud !== undefined) q.set("tehtud", String(view.tehtud));
  return `/admin/paringud?${q.toString()}`;
}

const unique = (ids: (number | null)[]): number[] => [...new Set(ids.filter((n): n is number => n !== null))];

/**
 * Päringud (README A7, the Part 2 prototype): the requests Maria has to answer, as compact cards in two columns (one on a phone), the done ones folded
 * away at the bottom. The toolbar's search looks in every tab and a result carries its tab's tag; the tabs are its pills, each with the number of requests
 * still open (the menu badge's numbers). Open requests newest first, 50 a page; the fold „Tehtud ({n})“ holds the done ones, 50 a page of its own.
 */
export default async function RequestsPage({ searchParams }: Props) {
  await requireAdmin();
  const view = parse(await searchParams);
  const db = getDb();
  const filter = { kind: TAB_KIND[view.tab], search: view.otsi };
  const [open, done, counts, courses] = await Promise.all([
    pageRequests(db, { ...filter, handled: false, page: view.leht }),
    pageRequests(db, { ...filter, handled: true, page: view.tehtud }),
    requestCounts(db),
    listCourseNames(db),
  ]);
  const rows: RequestRow[] = [...open.rows, ...done.rows];
  const sessionIds = unique(rows.map(waitedSession));
  const registrationIds = unique(rows.map(changedRegistration));
  const [sessions, registrations] = await Promise.all([
    listSessionsByIds(db, sessionIds),
    registrationIds.length ? listRegistrations(db, { ids: registrationIds }) : [],
  ]);
  const lookup: RequestLookup = {
    courses: new Map(courses.map((c) => [c.slug, c.title])),
    sessions: new Map(sessions.map((s) => [s.id, s])),
    registrations: new Map(registrations.map((reg) => [reg.id, reg])),
  };
  const t = adminEt.requests;

  // The tabs go to their own address, which has no search (a search looks in all of them, so no tab is the current one while it is on).
  const pills: ListPill[] = REQUEST_TABS.map((tab) => ({ href: href({ tab }), label: t.tabs[tab], count: counts[tab], current: view.otsi === "" && tab === view.tab }));
  const list = (cards: RequestRow[]) => (
    <ul className={styles.grid}>
      {cards.map((r) => (
        <li key={r.id}>
          <RequestCard view={requestView(r, lookup)} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
      </div>

      <ListToolbar placeholder={t.searchPlaceholder} pillRows={[{ label: t.tabsLabel, pills }]} />

      <h2 className={ui.sr}>{view.otsi ? t.title : t.tabs[view.tab]}</h2>
      {open.total === 0 && done.total === 0 ? (
        <section className={ui.card}>
          <ListEmpty things={t.things} filtered search={view.otsi || undefined} clearHref={view.otsi ? href({ tab: view.tab }) : undefined} />
        </section>
      ) : (
        <>
          {open.rows.length > 0 && list(open.rows)}
          <Pager info={open} href={(n) => href({ ...view, leht: n, tehtud: view.fold ? view.tehtud : undefined })} />
          {done.total > 0 && (
            <div className={styles.done}>
              <FoldRow title={t.doneFold} count={done.total} summary="" defaultOpen={view.fold}>
                {list(done.rows)}
                <Pager info={done} href={(n) => href({ ...view, tehtud: n })} />
              </FoldRow>
            </div>
          )}
        </>
      )}
      <RequestTarget />
    </div>
  );
}
