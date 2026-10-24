import { describe, expect, it } from "vitest";
import { expectKeys, followKeys, insertAt, removeAt, startKeys } from "@/components/admin/row-keys";

// The list editors' row keys (admin UX pass piece 3a, Task 8; README B2 "errors keyed by row id", BEH B5): a JSON row has no id, so the editor gives
// each one a key and follows the rows through every change of the list — its own (told as it makes it) and any other (worked out from the rows'
// contents) — and a row that comes back after its removal gets its old key.

const counter = () => {
  let n = 0;
  return () => `k${++n}`;
};
const start = (items: string[]) => startKeys(items, counter());

describe("followKeys", () => {
  it("the editor's own change: the keys it said", () => {
    const s = start(["a", "b", "c"]);
    const next = ["c", "a", "b"];
    expect(followKeys(expectKeys(s, next, ["k3", "k1", "k2"]), next).keys).toEqual(["k3", "k1", "k2"]);
  });

  it("an own change that lands on another list (the card's update met a list that changed meanwhile): followed from the contents", () => {
    const s = expectKeys(start(["a", "b", "c"]), ["a", "c"], ["k1", "k3"]);
    // what came was not that: a row typed in at its place instead
    expect(followKeys(s, ["a", "B", "c"]).keys).toEqual(["k1", "k2", "k3"]);
  });

  it("a row typed in at its place keeps its key, and so does every other row", () => {
    expect(followKeys(start(["a", "b", "c"]), ["a", "bb", "c"]).keys).toEqual(["k1", "k2", "k3"]);
  });

  it("the same rows in another order: each keeps its key", () => {
    expect(followKeys(start(["a", "b", "c"]), ["b", "c", "a"]).keys).toEqual(["k2", "k3", "k1"]);
  });

  it("rows in at one place get new keys; rows out at one place take theirs away", () => {
    let n = 10;
    const make = () => `n${++n}`;
    expect(followKeys(start(["a", "b"]), ["a", "x", "y", "b"], make).keys).toEqual(["k1", "n11", "n12", "k2"]);
    expect(followKeys(start(["a", "b", "c", "d"]), ["a", "d"]).keys).toEqual(["k1", "k4"]);
  });

  it("a row removed and then put back (an undo) gets its old key, wherever it goes in again", () => {
    const s = start(["a", "b", "c"]);
    const out = followKeys(expectKeys(s, ["a", "c"], ["k1", "k3"]), ["a", "c"]);
    expect(out.gone).toEqual([{ key: "k2", sig: '"b"' }]);
    expect(followKeys(out, ["a", "b", "c"]).keys).toEqual(["k1", "k2", "k3"]);
    // also into a list that changed meanwhile (moved, another row added)
    const moved = followKeys(out, ["c", "a"]);
    expect(followKeys(moved, ["b", "c", "a", "z"], () => "new").keys).toEqual(["k2", "k3", "k1", "new"]);
  });

  it("anything else: rows matched by content, their own place first; rows not seen before, new keys", () => {
    const keys = followKeys(start(["a", "b", "a"]), ["a", "x", "a", "b"], () => "new").keys;
    expect(keys).toEqual(["k1", "new", "k3", "k2"]);
  });

  it("the keys of a list are never twice the same", () => {
    const s = start(["a", "a", "a"]);
    const keys = followKeys(s, ["a", "a", "b", "a"]).keys;
    expect(new Set(keys).size).toBe(4);
  });
});

describe("insertAt and removeAt", () => {
  it("insertAt puts the row at its place, or at the end of a shorter list", () => {
    expect(insertAt(["a", "c"], 1, "b")).toEqual(["a", "b", "c"]);
    expect(insertAt(["a"], 5, "b")).toEqual(["a", "b"]);
    expect(insertAt([], 0, "a")).toEqual(["a"]);
  });

  it("removeAt takes out the row at its place, or the same row nearest to it, else nothing", () => {
    expect(removeAt(["a", "b", "c"], 1, "b")).toEqual(["a", "c"]);
    // the list moved under the click: the same row where it is now
    expect(removeAt(["b", "a", "c"], 1, "b")).toEqual(["a", "c"]);
    expect(removeAt(["x", "b", "y", "b"], 3, "b")).toEqual(["x", "b", "y"]);
    expect(removeAt(["a", "c"], 1, "b")).toEqual(["a", "c"]);
  });
});
