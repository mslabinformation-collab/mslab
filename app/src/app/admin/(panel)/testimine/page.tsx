import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/sections";
import { TestPlan } from "@/components/admin/TestPlan";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { logFailure } from "@/server/log";
import { pageView, readAnswers, testPlan, testplanBuildAt, testplanYou } from "@/server/testplan";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.testplan.title) };

/**
 * Testimine (phase 4, piece 1, spec §4): the plan's checks for Maria and Dim to answer, with both admins' answers together. Not in the menu:
 * it is a tool until the launch, reached from the card on Avaleht (the shell marks Avaleht). The plan is the bundle's own file, so the page has
 * it when the database does not; the answers are read here too, and when they cannot be (`initial: null`) the page says so and keeps the
 * tester's answers on the device until they can be sent (TestPlan.tsx). Whose session it is comes from ADMIN_NAMES (testplanYou). Dim 25.10:
 * Automaattest's answers come apart (`auto`); for Automaattest's own session they are its answers (server/testplan.ts pageView).
 */
export default async function TestimiPage() {
  const email = await requireAdmin();
  const names = serverEnv().ADMIN_NAMES;
  const you = testplanYou(email, names);
  let view: ReturnType<typeof pageView> | null = null;
  try {
    view = pageView(await readAnswers(getDb()), testPlan, names, you.tester);
  } catch (e) {
    logFailure("[testplan] the answers could not be read for the page", e);
  }

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <h1 className={ui.h1}>{adminEt.testplan.title}</h1>
        </div>
      </div>
      <TestPlan plan={testPlan} initial={view?.answers ?? null} auto={view?.auto} you={you} buildAt={testplanBuildAt()} />
    </div>
  );
}
