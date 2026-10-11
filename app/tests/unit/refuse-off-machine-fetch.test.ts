import { expect, test } from "vitest";
import { refuseOffMachineFetch } from "../fakes";

// The guard of the unit tests that stand in for servers (tests/fakes.ts refuseOffMachineFetch): no request can leave this machine through the
// global fetch, so that not even the RED run of a missing guard can send one (Task 10 fix round 1).

test("an address off this machine is refused and recorded and the real fetch is never asked; this machine's addresses go through", async () => {
  const reached: string[] = [];
  // a plain function stands in for the network (a vi.fn would be the very mock the guard then wraps)
  const network = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => (reached.push(String(input instanceof Request ? input.url : input)), new Response("answered"))) as typeof fetch;
  const guard = refuseOffMachineFetch();
  const off = ["https://shop.example/api/payments/notify", "http://localhost.evil.example/n", "http://127.0.0.1.evil.example/n", "http://localhost@evil.example/n", "ftp://localhost/x", "not a url", ""];
  const local = ["http://localhost:3000/api/payments/notify", "http://127.0.0.1:3997/pay/x", "http://[::1]:3100/x", "https://localhost/x"];
  try {
    for (const url of off) await expect(fetch(url), url).rejects.toThrow(/refused by the test/);
    await expect(fetch(new URL("https://shop.example/u"))).rejects.toThrow(/refused by the test/);
    await expect(fetch(new Request("https://shop.example/r", { method: "POST", body: "{}" }))).rejects.toThrow(/refused by the test/);
    for (const url of local) expect(await (await fetch(url)).text(), url).toBe("answered");
    expect(guard.refused).toEqual([...off, "https://shop.example/u", "https://shop.example/r"]);
    expect(reached).toEqual(local); // not one off-machine address reached the real fetch
  } finally {
    guard.restore();
    globalThis.fetch = network;
  }
});
