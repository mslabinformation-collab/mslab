import type { Metadata } from "next";
import Link from "next/link";
import { Drawer } from "@/components/admin/Drawer";
import { DiscountCodeDrawer, NewDiscountCode } from "@/components/admin/DiscountCodeDrawer";
import { DiscountCodeList } from "@/components/admin/DiscountCodeList";
import listTable from "@/components/admin/list-table.module.css";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import { codeUses, listCodeCourses, listCodes, readCode } from "@/server/discount-code-admin";
import styles from "./codes.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.codes) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const LIST = "/admin/sooduskoodid";
const hrefOf = (id: number | "uus" | "tervituskood") => `${LIST}?kood=${id}`;

/**
 * Sooduskoodid (F1 Task 13, spec §4.10; the address /admin/sooduskoodid is where Hüpikaken's and Seaded's old welcome-code places lead): the discount codes
 * of the site, the welcome code first (components/admin/DiscountCodeList.tsx), under „Uus sooduskood +“. Addresses: ?kood=<id> (the drawer of that code over
 * the list), ?kood=uus (a new code: its „Lisa sooduskood“ creates it and the drawer goes on at ?kood=<n>&lisatud=<n>), ?kood=tervituskood (the welcome code
 * made from the empty page, R11: with a welcome code already, its own drawer opens instead; only one can exist). With no welcome row (the seed has none)
 * a notice offers „Lisa tervituskood“ over the list. The drawer reads the code with its version and uses at one `now` (server/discount-code-admin.ts).
 */
export default async function DiscountCodesPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const db = getDb();
  const now = new Date();
  const [rows, courses] = await Promise.all([listCodes(db, now), listCodeCourses(db)]);
  const welcome = rows.find((r) => r.welcome) ?? null;
  const raw = one(sp.kood);
  const asked = raw === "uus" || raw === "tervituskood" ? raw : raw === undefined ? null : parseRowId(raw);
  // ?kood=tervituskood with a welcome code already is that code's own drawer
  const openId = asked === "tervituskood" && welcome ? welcome.id : typeof asked === "number" ? asked : null;
  const added = one(sp.lisatud) !== undefined ? parseRowId(one(sp.lisatud)!) : null;
  const [stored, uses] = openId !== null ? await Promise.all([readCode(db, openId), codeUses(db, openId, now)]) : [null, []];
  const t = adminEt.discounts;

  let drawer: React.ReactNode = null;
  if (asked === "uus" || (asked === "tervituskood" && !welcome)) {
    const isWelcome = asked === "tervituskood";
    drawer = (
      <Drawer label={isWelcome ? t.drawer.newWelcomeLabel : t.drawer.newLabel} closeHref={LIST} closeLabel={adminEt.common.close} returnFocus={isWelcome ? "add-welcome" : "add-code"}>
        <NewDiscountCode welcome={isWelcome} courses={courses} />
      </Drawer>
    );
  } else if (openId !== null) {
    drawer = (
      <Drawer label={stored ? fill(t.drawer.editLabel, { code: stored.value.code }) : t.drawer.notFound} closeHref={LIST} closeLabel={adminEt.common.close} returnFocus={`code-${openId}`}>
        {stored ? (
          <DiscountCodeDrawer key={openId} id={openId} version={stored.version} value={stored.value} courses={courses} uses={uses} listHref={LIST} added={added === openId} />
        ) : (
          <p className={ui.empty}>{t.drawer.notFound}</p>
        )}
      </Drawer>
    );
  }

  return (
    <>
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.lead}</p>
          </div>
          {/* the 44 px add button (UX audit 2 A27, as every „Lisa … +“) */}
          <Link id="add-code" className={`${ui.btn} ${ui.smallBtn}`} href={hrefOf("uus")} scroll={false} data-add-code="">
            {t.add} +
          </Link>
        </div>

        {/* (a code just created from its drawer says it in the drawer: the page behind a modal drawer cannot be read) */}
        {added !== null && added !== openId && (
          <p className={ui.notice} role="status" data-flash="added">
            {t.added}
          </p>
        )}
        {one(sp.kustutatud) === "1" && (
          <p className={ui.notice} role="status" data-flash="deleted">
            {t.deleted}
          </p>
        )}
        {welcome === null && (
          <div className={`${ui.notice} ${styles.offer}`} data-welcome-missing="">
            <p>{t.welcomeMissing}</p>
            <Link id="add-welcome" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href={hrefOf("tervituskood")} scroll={false} data-add-welcome="">
              {t.addWelcome}
            </Link>
          </div>
        )}

        <section className={`${ui.card} ${listTable.card}`} aria-label={t.title}>
          {rows.length === 0 ? (
            <p className={ui.empty} data-codes-empty="">
              {t.empty}
            </p>
          ) : (
            <DiscountCodeList rows={rows} openId={openId} hrefOf={hrefOf} />
          )}
        </section>
      </div>
      {drawer}
    </>
  );
}
