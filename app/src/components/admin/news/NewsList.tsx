"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeSearch } from "@/domain/catalogue";
import { parseSearch } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { useLeaveGuard } from "../LeaveGuard";
import { listHref } from "../list-params";
import { ListEmpty } from "../ListStates";
import { ListToolbar } from "../ListToolbar";
import { postTo, pressFailedLine } from "../useEditorRestarts";
import ui from "../ui.module.css";
import { dayMonth, newsHref } from "./news-view";
import styles from "./NewsList.module.css";

// C3 Uudised, the list (admin UX pass piece 4b, Task 2; README §4 C3 "list with ListToolbar search, whole-row link and the status incl. „Avaldamata
// muudatused“"; the Part 4 C3 frame; piece4-texts S4-18, S4-19; ruling R-f). The uudised layout renders it from every post (server-side, with the
// drafts lookup for the status: db/queries/admin.ts listAllPosts) and it stays while a post is open: from 1180 px the 320 px list at the left of the
// editor, below that two screens — the list, and the editor with its „← Uudised“ (S4-21). With no post open the list is the page (eyebrow „Blogi“,
// the H1 „Uudised“, the lead); beside an editor its heading is the frame's smaller one, and the editor has the H1.
// - The search „Otsi pealkirja järgi“ is the ListToolbar's `?otsi=`, filtered here on the titles (a layout gets no searchParams, R-f); the rows'
//   links and the editor's way back keep it. No hit: „„{q}“ järgi postitusi ei leitud.“ with „Tühjenda otsing ja filtrid“ (S4-18, the lists' frame).
// - A row is one link as a whole: the cover's thumbnail (64 × 52), the title and `{staatus} · {dd.mm}` — „Avaldatud“ (#2f5d46), „Mustand“ (#5e5559,
//   never published), „Avaldamata muudatused“ (#6b4f5c, a published post with a draft) — `—` without a date. The open post's row is white with a 1 px
//   #222 border (aria-current).
// - „Lisa postitus +“ makes the post at once (POST /api/admin/uudised/uus, S4-19) after the leave guard has the open editor's text saved, and opens it
//   at /admin/uudised/<id>?loodud=1 (the editor says ADM:2273's line and puts the cursor in „Pealkiri“); the page is read again, so the row is here.
// - After „Kustuta postitus“ the list says „Postitus kustutatud.“ (`?kustutatud=1`, S4-23).

export type NewsStatus = "published" | "draft" | "changes";
/** A post's row as the layout reads it: its Estonian title, its cover's key, its status, its day (Tallinn, YYYY-MM-DD; "" for none). */
export type NewsRow = { id: number; title: string; coverKey: string; status: NewsStatus; day: string };

const STATUS: Record<NewsStatus, string> = { published: adminEt.news.published, draft: adminEt.news.draft, changes: adminEt.news.changes };

/** The Uudised screen of the layout (R-f): the list, and the open post's editor (the layout's children) beside it from 1180 px. */
export function NewsScreen({ rows, children }: { rows: NewsRow[]; children: ReactNode }) {
  const params = useParams<{ id?: string }>();
  const open = typeof params?.id === "string" ? params.id : null;
  return (
    <div className={styles.screen} data-news-screen="" data-open={open !== null ? "" : undefined}>
      <NewsList rows={rows} open={open} />
      {open !== null ? (
        <div className={styles.editor} data-news-editor="">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** The list: its heading with „Lisa postitus +“, the search, the rows (`open`: the id of the post open beside it, as in its address). */
export function NewsList({ rows, open }: { rows: NewsRow[]; open: string | null }) {
  const t = adminEt.news;
  const sp = useSearchParams();
  const pathname = usePathname();
  const q = parseSearch(sp.get("otsi") ?? undefined);
  const needle = normalizeSearch(q);
  const shown = needle ? rows.filter((r) => normalizeSearch(r.title).includes(needle)) : rows;
  const alone = open === null;
  const Heading = alone ? "h1" : "h2";
  return (
    <section className={styles.list} aria-labelledby="uudised-list" data-news-list="">
      {/* (alone: the page's own heading, as every list page has it; beside an editor: the frame's smaller one) */}
      <div className={alone ? `${ui.heading} ${styles.pageHead}` : styles.head}>
        <div>
          {alone && <p className={ui.eyebrow}>{t.eyebrow}</p>}
          <Heading id="uudised-list" className={alone ? ui.h1 : styles.title}>
            {t.title}
          </Heading>
          {alone && <p className={ui.lead}>{t.lead}</p>}
        </div>
        <AddPost />
      </div>
      <ListToolbar placeholder={t.search} />
      {alone && sp.get("kustutatud") === "1" && (
        <p className={ui.notice} role="status" data-post-deleted="">
          {t.deleted}
        </p>
      )}
      {/* alone, the rows (or the empty state) are in a white card, as every other list's are (admin polish F17); beside an editor they stand on the
          page, as the C3 frame draws them */}
      <ListBox alone={alone}>
        {shown.length === 0 ? (
          <ListEmpty things={t.things} filtered={q !== ""} search={q || undefined} clearHref={listHref(pathname, sp, { otsi: null })} />
        ) : (
          <ul className={styles.rows}>
            {shown.map((r) => (
              <li key={r.id}>
                <Link className={styles.row} href={newsHref(`/admin/uudised/${r.id}`, q)} aria-current={String(r.id) === open ? "page" : undefined} data-post-row={r.id}>
                  {r.coverKey ? <Image className={styles.thumb} src={mediaUrl(r.coverKey)} alt="" width={64} height={52} unoptimized /> : <span className={styles.thumb} aria-hidden="true" />}
                  <span className={styles.text}>
                    <span className={styles.name}>{r.title}</span>{" "}
                    {/* (the space: the link's name reads „{title} {staatus} · {dd.mm}“; a flex column draws none) */}
                    <span className={styles.line} data-status={r.status} data-post-state="">
                      {fill(t.rowLine, { status: STATUS[r.status], date: dayMonth(r.day) })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ListBox>
    </section>
  );
}

/** The rows' white card while the list is the page; beside an editor, none. */
function ListBox({ alone, children }: { alone: boolean; children: ReactNode }) {
  return alone ? (
    <div className={`${ui.card} ${styles.card}`} data-news-card="">
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}

/**
 * „Lisa postitus +“ (S4-19): once the leave guard has the open editor's text saved (or she has said to go), the post is made at once and opened; the
 * page is read again with the new address, so the list has its row. A failure says so under the button; the button does nothing while it is on its way.
 */
function AddPost() {
  const t = adminEt.news;
  const router = useRouter();
  const { requestLeave } = useLeaveGuard();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const going = useRef(false);
  // (the list stays on the screen when the new post opens: the button takes a press again once the address is the new post's)
  const pathname = usePathname();
  const [at, setAt] = useState(pathname);
  if (at !== pathname) {
    setAt(pathname);
    setBusy(false);
  }
  useEffect(() => {
    going.current = false;
  }, [pathname]);
  const create = async () => {
    const answer = await postTo("/api/admin/uudised/uus");
    const id = answer.ok && typeof answer.body === "object" && answer.body !== null && "id" in answer.body ? (answer.body as { id: unknown }).id : null;
    if (typeof id === "number") {
      startTransition(() => {
        router.push(`/admin/uudised/${id}?loodud=1`);
        router.refresh();
      });
      return;
    }
    setFailed(pressFailedLine(!answer.ok && answer.signedOut));
    going.current = false;
    setBusy(false);
  };
  // (the guard may ask first: „Jää siia“ runs nothing, so the button is busy only once the post is being made)
  const press = () => {
    if (going.current) return;
    requestLeave(() => {
      if (going.current) return;
      going.current = true;
      setBusy(true);
      setFailed(null);
      void create();
    }, "page");
  };
  return (
    <div className={styles.add}>
      <button type="button" className={ui.btn} aria-disabled={busy || undefined} onClick={press} data-add-post="">
        {t.add} +
      </button>
      {failed && (
        <p role="alert" className={ui.error}>
          {failed}
        </p>
      )}
    </div>
  );
}
