import { describe, expect, it } from "vitest";
import { activeSection, SECTIONS } from "@/components/admin/sections";

// The sidebar's active entry comes from the address (admin UX pass, README §1.1, spec D4): Shell lives in the (panel) layout now and
// does not re-render per page, so no page passes `active` any more.
const at = (path: string) => {
  const u = new URL(path, "https://x.test");
  return activeSection(u.pathname, u.searchParams);
};

describe("activeSection: the menu entry an admin address highlights", () => {
  it.each([
    ["/admin", "overview"],
    ["/admin/koolitused/12?oppetund=3", "courses"],
    ["/admin/kalender?id=uus", "calendar"],
    ["/admin/registreerimised?id=4", "registrations"],
    ["/admin/protokollid", "protocols"],
    ["/admin/protokollid?sessioon=7", "protocols"],
    ["/admin/protokollid?registreering=9", "protocols"],
    // spec D4: the practical-work screen of an e-course access is Hindamine's
    ["/admin/protokollid?ligipaas=5", "assessment"],
    ["/admin/hindamine/test?id=2", "assessment"],
    ["/admin/tunnistused", "assessment"],
    ["/admin/arved", "payments"],
    ["/admin/maksed", "payments"],
    ["/admin/tagasiside?vaade=arvustused", "feedback"],
    ["/admin/opilased/3/vaade/kulmud", "clients"],
    ["/admin/paringud", "requests"],
    ["/admin/praktika", "practice"],
    ["/admin/avaleht", "home"],
    ["/admin/koolitaja", "trainer"],
    ["/admin/uudised/4", "news"],
    ["/admin/kampaania", "campaign"],
    ["/admin/uudiskiri?vaade=kampaaniad", "newsletter"],
    ["/admin/seaded", "settings"],
    ["/admin/testimine", "testing"],
  ])("%s → %s", (path, section) => expect(at(path)).toBe(section));

  it("matches whole path segments, with or without a trailing slash", () => {
    expect(at("/admin/koolitused/")).toBe("courses");
    expect(at("/admin/hindamine")).toBe("assessment");
    expect(at("/admin/hindamine/")).toBe("assessment");
    expect(at("/admin/opilased")).toBe("clients");
    // a longer name that only starts like a section is not that section
    expect(at("/admin/koolitusedx")).toBe("overview");
  });

  it("every menu row's own address highlights that row", () => {
    for (const s of SECTIONS) expect(at(s.href), s.href).toBe(s.key);
  });

  it("protocols: the page takes the first of sessioon, registreering, ligipaas that is an id, and the entry follows it", () => {
    expect(at("/admin/protokollid?sessioon=7&ligipaas=5")).toBe("protocols");
    expect(at("/admin/protokollid?registreering=9&ligipaas=5")).toBe("protocols");
    expect(at("/admin/protokollid?sessioon=abc&ligipaas=5")).toBe("assessment");
    expect(at("/admin/protokollid?ligipaas=abc")).toBe("protocols");
    expect(at("/admin/protokollid?ligipaas=")).toBe("protocols");
    // ligipaas means Hindamine only on the protocols address
    expect(at("/admin/kalender?ligipaas=5")).toBe("calendar");
  });

  it("an address the menu does not know highlights the overview", () => {
    expect(at("/admin/ei-ole-olemas")).toBe("overview");
  });
});
