import { describe, expect, it } from "vitest";
import { menuOf } from "@/components/admin/menu";
import { readMenuState } from "@/components/admin/menu-state";
import type { AdminCounts } from "@/db/queries/admin";

// The menu's badges as one pure function (admin UX pass, B6; README §1.1): what the shell paints first and /api/admin/margid answers for the
// sidebar. A badge shows only above 0, counts what Maria acts on, and a badged row opens its filtered page.

const none: AdminCounts = {
  awaitingPrepayment: 0,
  openRequests: { contact: 0, individual: 0, practice: 0, waitlist: 0, change_request: 0 },
  subscribers: 0,
  confirmedSubscribers: 0,
  assessment: 0,
  todaySessions: [],
  waitingReviews: 0,
  paymentsAttention: 0,
  ownFaults: 0,
};
const counts = (over: Partial<AdminCounts>): AdminCounts => ({ ...none, ...over });

describe("menuOf", () => {
  it("shows nothing when nothing waits", () => {
    expect(menuOf(none)).toEqual({ badges: {}, hrefs: {}, total: 0, today: null });
  });

  it("every badge counts what it should, and says it in the approved words", () => {
    const menu = menuOf(
      counts({
        awaitingPrepayment: 3,
        assessment: 2,
        // every kind counts, „Muutmine“ too
        openRequests: { contact: 2, individual: 1, practice: 1, waitlist: 1, change_request: 2 },
        waitingReviews: 1,
        paymentsAttention: 6,
        ownFaults: 4,
        todaySessions: [{ id: 7, startsAt: new Date("2026-12-01T08:00:00Z"), course: "Kulmumeistri baaskoolitus" }],
      }),
    );
    expect(menu.badges).toEqual({
      registrations: { n: 3, label: "3 ootab ettemaksu" },
      protocols: { text: "Täna", label: "Täna on koolituspäev" },
      assessment: { n: 2, label: "2 ootab hindamist" },
      requests: { n: 7, label: "7 tegemata" },
      feedback: { n: 1, label: "1 arvustust ootab" },
      payments: { n: 6, label: "6 vajab kontrolli" },
      testing: { n: 4, label: "4 viga" },
    });
  });

  it("the phone's sum adds the numeric badges up; „Täna“ adds nothing", () => {
    const today = [{ id: 7, startsAt: new Date("2026-12-01T08:00:00Z"), course: "K" }];
    expect(menuOf(counts({ awaitingPrepayment: 3, assessment: 2, openRequests: { ...none.openRequests, contact: 7 }, waitingReviews: 1, paymentsAttention: 6, ownFaults: 4, todaySessions: today })).total).toBe(23);
    expect(menuOf(counts({ todaySessions: today })).total).toBe(0);
  });

  it("a badged row opens the page already filtered, and only while it carries a badge", () => {
    expect(menuOf(counts({ awaitingPrepayment: 1, waitingReviews: 1 })).hrefs).toEqual({
      registrations: "/admin/registreerimised?staatus=ootab",
      feedback: "/admin/tagasiside?vaade=arvustused&olek=ootel",
    });
    expect(menuOf(counts({ paymentsAttention: 2, ownFaults: 1, assessment: 1 })).hrefs).toEqual({});
    expect(menuOf(none).hrefs).toEqual({});
  });

  it("B16: „Protokollid“ opens the one session when exactly one is on today; with none, or two or more, it opens the index", () => {
    const one = { id: 7, startsAt: new Date("2026-12-01T08:00:00Z"), course: "Kulmumeistri baaskoolitus" };
    const two = { id: 9, startsAt: new Date("2026-12-01T13:00:00Z"), course: "Teine" };
    expect(menuOf(counts({ todaySessions: [one] })).hrefs).toEqual({ protocols: "/admin/protokollid?sessioon=7" });
    expect(menuOf(counts({ todaySessions: [one, two] })).hrefs).toEqual({});
    expect(menuOf(none).hrefs).toEqual({});
    // next to the filtered rows, and the sidebar keeps it (a „Täna“ badge is there whenever the address is)
    const menu = menuOf(counts({ awaitingPrepayment: 2, todaySessions: [two] }));
    expect(menu.hrefs).toEqual({ registrations: "/admin/registreerimised?staatus=ootab", protocols: "/admin/protokollid?sessioon=9" });
    expect(readMenuState({ ok: true, ...JSON.parse(JSON.stringify(menu)) })?.hrefs.protocols).toBe("/admin/protokollid?sessioon=9");
  });

  it("the card of today is the first session, with its time in Tallinn and its course", () => {
    const menu = menuOf(
      counts({
        todaySessions: [
          { id: 7, startsAt: new Date("2026-12-01T08:00:00Z"), course: "Kulmumeistri baaskoolitus" }, // 10:00 in Tallinn (winter time)
          { id: 9, startsAt: new Date("2026-12-01T13:00:00Z"), course: "Teine" },
        ],
      }),
    );
    expect(menu.today).toEqual({ href: "/admin/protokollid?sessioon=7", time: "10:00", course: "Kulmumeistri baaskoolitus" });
    // summer time: 07:00 UTC is 10:00 as well
    expect(menuOf(counts({ todaySessions: [{ id: 3, startsAt: new Date("2027-06-05T07:00:00Z"), course: "K" }] })).today?.time).toBe("10:00");
  });

  it("is plain data: it survives JSON, which is how /api/admin/margid sends it", () => {
    const menu = menuOf(counts({ awaitingPrepayment: 3, todaySessions: [{ id: 7, startsAt: new Date("2026-12-01T08:00:00Z"), course: "K" }] }));
    expect(readMenuState({ ok: true, ...JSON.parse(JSON.stringify(menu)) })).toEqual(menu);
  });
});

describe("readMenuState: the sidebar reads /api/admin/margid", () => {
  const good = {
    ok: true,
    badges: { requests: { n: 4, label: "4 tegemata" }, protocols: { text: "Täna", label: "Täna on koolituspäev" } },
    hrefs: {},
    total: 4,
    today: { href: "/admin/protokollid?sessioon=7", time: "10:00", course: "K" },
  };

  it("reads a good answer", () => {
    expect(readMenuState(good)).toEqual({ badges: good.badges, hrefs: {}, total: 4, today: good.today });
  });

  it("is null for anything that is not the menu: an error body, a page, a list, a missing part", () => {
    for (const bad of [null, undefined, "html", 4, [], {}, { ok: false, error: "server" }, { ...good, ok: undefined }, { ...good, total: "4" }, { ...good, badges: undefined }, { ...good, hrefs: [] }])
      expect(readMenuState(bad), JSON.stringify(bad)).toBeNull();
  });

  it("leaves out what it does not know or cannot read, and an address that leaves the admin", () => {
    const state = readMenuState({
      ...good,
      badges: { requests: { n: 4, label: "4 tegemata" }, nonsense: { n: 1, label: "x" }, payments: { n: "many", label: "x" }, testing: { label: "no number" }, feedback: { n: 1, label: "1 arvustust ootab" } },
      hrefs: { requests: "https://elsewhere.example/", feedback: "/admin/tagasiside?vaade=arvustused&olek=ootel", payments: "/admin/maksed" },
      today: { href: "https://elsewhere.example/", time: "10:00", course: "K" },
    });
    expect(state).toEqual({
      badges: { requests: { n: 4, label: "4 tegemata" }, feedback: { n: 1, label: "1 arvustust ootab" } },
      hrefs: { feedback: "/admin/tagasiside?vaade=arvustused&olek=ootel" },
      total: 4,
      today: null,
    });
  });
});
