import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, settings } from "@/db/schema";
import { contactCourse, registrationOn, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// Maria's "Vaata tema vaadet" (app/admin/(panel)/opilased/[id]/vaade/page.tsx): the student's own "Minu koolitused" as she sees it. With online
// payments on the student's cards offer "Maksa" (Dashboard.payOnline, set by the account API); Maria's copy must show the same cards, with the
// buttons inert (readOnly), and without payments it stays what it was. The page is an async server component: it is called here and the
// element tree it returns is searched for the CoursesTab that gets the dashboard.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/auth")>()), requireAdmin: async () => "maria@example.test" }));

vi.mock("@/server/payments/montonio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/payments/montonio")>();
  return { ...actual, paymentProvider: vi.fn(actual.paymentProvider) };
});

import ViewAsPage from "@/app/admin/(panel)/opilased/[id]/vaade/page";
import { paymentProvider } from "@/server/payments/montonio";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The first element of the tree (depth first) whose props have `data`: the CoursesTab. */
function findData(node: ReactNode): { data: Record<string, unknown>; readOnly: unknown } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findData(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { data?: Record<string, unknown>; readOnly?: unknown; children?: ReactNode };
  if (props.data && "cards" in props.data) return { data: props.data, readOnly: props.readOnly };
  return findData(props.children);
}

async function viewOf(clientId: number) {
  const tree = await ViewAsPage({ params: Promise.resolve({ id: String(clientId) }) });
  const found = findData(tree);
  expect(found, "the CoursesTab with the dashboard").not.toBeNull();
  return found!;
}

describe("the admin's view of a student's cards", () => {
  async function student() {
    const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Tamm" }).returning();
    await registrationOn(db, await contactCourse(db), { clientId: client.id, email: client.email });
    return client;
  }

  test("with online payments on (the keys are set) Maria's copy of the cards says payOnline, as the student's does, and stays read-only", async () => {
    vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
    vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
    vi.stubEnv("MONTONIO_ENV", "sandbox");
    const view = await viewOf((await student()).id);
    expect(view.data.payOnline).toBe(true);
    expect(view.readOnly).toBe(true);
  });

  test("without the keys it is what it was: no payOnline", async () => {
    vi.stubEnv("MONTONIO_ACCESS_KEY", "");
    vi.stubEnv("MONTONIO_SECRET_KEY", "");
    const view = await viewOf((await student()).id);
    expect("payOnline" in view.data).toBe(false);
    expect(view.readOnly).toBe(true);
  });

  test("Järelmaks (Inbank)'s toggle reaches Maria's copy too, as the cards' two buttons need it (Dashboard.financing); the buttons stay inert", async () => {
    vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
    vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
    vi.stubEnv("MONTONIO_ENV", "sandbox");
    const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Tamm" }).returning();
    await registrationOn(db, await contactCourse(db), { clientId: client.id, email: client.email, paymentChoice: "financing" });
    expect("financing" in (await viewOf(client.id)).data).toBe(false);
    await db.insert(settings).values({ key: "financing", value: { enabled: true } });
    const view = await viewOf(client.id);
    expect([view.data.financing, view.data.payOnline, view.readOnly]).toEqual([true, true, true]);
  });

  test("the flag is the student's own: payOnline when paymentProvider() is there (the account API's deps.montonio), whatever the settings say on their own", async () => {
    const student1 = await student();
    // the provider the account API would use is none: no "Maksa" for her, so none in Maria's copy either (the keys alone do not decide)
    vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
    vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
    vi.mocked(paymentProvider).mockReturnValueOnce(null);
    expect("payOnline" in (await viewOf(student1.id)).data).toBe(false);
    // and the other way round: the provider is there, so her cards say "Maksa"
    vi.stubEnv("MONTONIO_ACCESS_KEY", "");
    vi.stubEnv("MONTONIO_SECRET_KEY", "");
    vi.mocked(paymentProvider).mockReturnValueOnce({} as NonNullable<ReturnType<typeof paymentProvider>>);
    expect((await viewOf(student1.id)).data.payOnline).toBe(true);
  });

  test("the mock bank (PAYMENT_PROVIDER=mock on this machine) is a provider like any: payOnline; a remote fake address turns payments off for her and for Maria", async () => {
    const student1 = await student();
    vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
    vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("MONTONIO_FAKE_URL", "http://127.0.0.1:4999");
    expect((await viewOf(student1.id)).data.payOnline).toBe(true);
    vi.stubEnv("MONTONIO_FAKE_URL", "https://elsewhere.example");
    expect("payOnline" in (await viewOf(student1.id)).data).toBe(false);
  });
});
