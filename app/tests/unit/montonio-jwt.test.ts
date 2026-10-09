import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { JwtError, signHs256, verifyHs256 } from "@/server/payments/jwt";

// HS256 on node:crypto (phase 2b, spec 7.1): what Montonio signs every request and every answer with. Only HS256 is accepted, the signature is
// compared in constant time, and an expired token is reported (spec 7.4 confirms it with Montonio) rather than refused.

const SECRET = "test-secret-key-0123456789abcdef";
const NOW = 1_791_500_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signed = (header: unknown, payload: unknown, secret = SECRET) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
};
/** A token with a real, matching HMAC under `hash`: only its header gives it away. */
const signedWith = (alg: string, hash: "sha256" | "sha384" | "sha512", payload: unknown, secret = SECRET) => {
  const input = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac(hash, secret).update(input).digest("base64url")}`;
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof JwtError ? e.code : "other";
  }
  return "none";
};

describe("signHs256 and verifyHs256", () => {
  test("a round trip keeps the claims and stamps iat (and exp when asked)", () => {
    const token = signHs256({ merchantReference: "MSLAB-M1", grandTotal: 175.5 }, SECRET, { expiresInSeconds: 600, nowSec: NOW });
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(verifyHs256(token, SECRET, { nowSec: NOW })).toEqual({ claims: { merchantReference: "MSLAB-M1", grandTotal: 175.5, iat: NOW, exp: NOW + 600 }, expired: false });
    expect(verifyHs256(signHs256({ a: 1 }, SECRET, { nowSec: NOW }), SECRET).claims).toEqual({ a: 1, iat: NOW });
  });

  test("another secret, a changed payload or a cut signature: 'signature'", () => {
    const token = signHs256({ grandTotal: 175 }, SECRET, { nowSec: NOW });
    expect(code(() => verifyHs256(token, "another-secret-0123456789abcdef"))).toBe("signature");
    const [h, , s] = token.split(".");
    expect(code(() => verifyHs256(`${h}.${b64({ grandTotal: 1 })}.${s}`, SECRET))).toBe("signature");
    expect(code(() => verifyHs256(`${h}.${token.split(".")[1]}.${s.slice(1)}`, SECRET))).toBe("signature");
    expect(code(() => signHs256({}, ""))).toBe("signature");
    expect(code(() => verifyHs256(token, ""))).toBe("signature");
  });

  test("a changed payload with the old signature, and a payload that keeps its length, are caught", () => {
    const token = signHs256({ paymentStatus: "ABANDONED", grandTotal: 175 }, SECRET, { nowSec: NOW });
    const [h, , s] = token.split(".");
    // the tampered claims say PAID: the signature was made over the other ones
    expect(code(() => verifyHs256(`${h}.${b64({ paymentStatus: "PAID", grandTotal: 175, iat: NOW })}.${s}`, SECRET))).toBe("signature");
    // one flipped character anywhere in the signature
    const flipped = `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    expect(code(() => verifyHs256(`${h}.${token.split(".")[1]}.${flipped}`, SECRET))).toBe("signature");
    // an empty signature
    expect(code(() => verifyHs256(`${h}.${token.split(".")[1]}.`, SECRET))).toBe("signature");
  });

  test("alg 'none' or any other algorithm is refused before the signature is looked at: 'alg'", () => {
    expect(code(() => verifyHs256(`${b64({ alg: "none", typ: "JWT" })}.${b64({ paymentStatus: "PAID" })}.`, SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signed({ alg: "RS256", typ: "JWT" }, { paymentStatus: "PAID" }), SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signed(null, { paymentStatus: "PAID" }), SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signed("HS256", { paymentStatus: "PAID" }), SECRET))).toBe("alg"); // a header that is no object
    expect(code(() => verifyHs256(signed({ typ: "JWT" }, { paymentStatus: "PAID" }), SECRET))).toBe("alg"); // no alg at all
    expect(code(() => verifyHs256(signed({ alg: "hs256", typ: "JWT" }, { paymentStatus: "PAID" }), SECRET))).toBe("alg"); // the name is exact
  });

  test("HS384 and HS512 are refused even when their HMAC under this very secret is right: 'alg'", () => {
    expect(code(() => verifyHs256(signedWith("HS512", "sha512", { paymentStatus: "PAID" }), SECRET))).toBe("alg");
    expect(code(() => verifyHs256(signedWith("HS384", "sha384", { paymentStatus: "PAID" }), SECRET))).toBe("alg");
    // and the same HMAC under the right name is what passes, so the test above fails for the header only
    expect(verifyHs256(signedWith("HS256", "sha256", { paymentStatus: "PAID" }), SECRET).claims).toEqual({ paymentStatus: "PAID" });
  });

  test("not three parts, a header or a payload that is no JSON: 'malformed'; a payload that is no object: 'payload'", () => {
    for (const bad of ["", "a.b", "a.b.c.d", "!!.e30.x"]) expect(code(() => verifyHs256(bad, SECRET)), bad).toBe("malformed");
    expect(code(() => verifyHs256(123 as unknown as string, SECRET))).toBe("malformed");
    expect(code(() => verifyHs256(undefined as unknown as string, SECRET))).toBe("malformed");
    const head = b64({ alg: "HS256", typ: "JWT" });
    const notJson = Buffer.from("{not json").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`${head}.${notJson}`).digest("base64url");
    expect(code(() => verifyHs256(`${head}.${notJson}.${sig}`, SECRET))).toBe("malformed");
    expect(code(() => verifyHs256(signed({ alg: "HS256", typ: "JWT" }, [1, 2]), SECRET))).toBe("payload");
    expect(code(() => verifyHs256(signed({ alg: "HS256", typ: "JWT" }, "PAID"), SECRET))).toBe("payload");
    expect(code(() => verifyHs256(signed({ alg: "HS256", typ: "JWT" }, null), SECRET))).toBe("payload");
  });

  test("a JwtError carries its code and never the token", () => {
    const token = signHs256({ secretClaim: "do-not-leak" }, SECRET, { nowSec: NOW });
    let error: unknown;
    try {
      verifyHs256(token, "another-secret-0123456789abcdef");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JwtError);
    expect(error).toBeInstanceOf(Error);
    expect((error as JwtError).name).toBe("JwtError");
    expect((error as JwtError).message).toBe("jwt signature");
    expect(String((error as Error).stack)).not.toContain(token.split(".")[2]);
  });

  test("expired: only past exp plus the 60 s tolerance, and reported, not thrown; no exp never expires", () => {
    const token = signHs256({ paymentStatus: "PAID" }, SECRET, { expiresInSeconds: 600, nowSec: NOW });
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 60 }).expired).toBe(false);
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 61 }).expired).toBe(true);
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 600 + 61 }).claims.paymentStatus).toBe("PAID");
    expect(verifyHs256(token, SECRET, { nowSec: NOW + 700, toleranceSec: 120 }).expired).toBe(false);
    expect(verifyHs256(signHs256({ a: 1 }, SECRET, { nowSec: 0 }), SECRET).expired).toBe(false);
  });

  test("an old token is still checked: expired does not skip the signature or the algorithm", () => {
    const old = { nowSec: NOW + 10_000 };
    const token = signHs256({ paymentStatus: "PAID" }, SECRET, { expiresInSeconds: 600, nowSec: NOW });
    expect(code(() => verifyHs256(token, "another-secret-0123456789abcdef", old))).toBe("signature");
    const withExp = (alg: string, hash: "sha256" | "sha512") => signedWith(alg, hash, { paymentStatus: "PAID", exp: NOW }, SECRET);
    expect(code(() => verifyHs256(withExp("HS512", "sha512"), SECRET, old))).toBe("alg");
    expect(verifyHs256(withExp("HS256", "sha256"), SECRET, old).expired).toBe(true);
  });
});
