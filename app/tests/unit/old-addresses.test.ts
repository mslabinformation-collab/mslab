import { describe, expect, test } from "vitest";
import map from "@/data/old-addresses.json";
import { oldAddressTarget } from "@/lib/old-addresses";
import { isKnownPage } from "@/lib/site-routing";

// SEO G6: the old WordPress addresses and where each leads (src/data/old-addresses.json).

describe("oldAddressTarget", () => {
  test("every exact address maps to its listed page", () => {
    const entries = Object.entries(map.exact);
    expect(entries.length).toBe(40);
    for (const [old, to] of entries) expect(oldAddressTarget(old), old).toBe(to);
    expect(oldAddressTarget("/meist")).toBe("/koolitaja");
    expect(oldAddressTarget("/product/kulmud-baaskoolitus")).toBe("/koolitused/kulmumeistri-baaskoolitus");
    expect(oldAddressTarget("/lash-lift-koolitus")).toBe("/koolitused/lash-lift-botox");
  });

  test("a product, course or lesson of the old shop leads to the catalogue", () => {
    expect(oldAddressTarget("/product/taiendkoolitus-9-horeda-kulmu-kujundamine")).toBe("/koolitused");
    expect(oldAddressTarget("/kursused/kulmud-baaskoolitus/lessons/x")).toBe("/koolitused");
    expect(oldAddressTarget("/product-category/x")).toBe("/koolitused");
    expect(oldAddressTarget("/courses/x")).toBe("/koolitused");
    expect(oldAddressTarget("/topics/x")).toBe("/koolitused");
  });

  test("an address of the new site, or an unknown one, is not an old address", () => {
    for (const p of ["/wp-admin", "/koolitused", "/praktika", "/koolitaja", "/koolituskalender", "/", "/constructor", "/toString", "/__proto__"]) expect(oldAddressTarget(p), p).toBeNull();
  });

  test("no old address is a page of the site, and every target is", () => {
    for (const key of Object.keys(map.exact)) expect(isKnownPage("/et" + key), key).toBe(false);
    for (const { prefix } of map.prefixes) expect(isKnownPage("/et" + prefix.replace(/\/$/, "")), prefix).toBe(false);
    const targets = [...Object.values(map.exact), ...map.prefixes.map((p) => p.to)];
    for (const to of targets) expect(isKnownPage("/et" + to), to).toBe(true);
  });
});
