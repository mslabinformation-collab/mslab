import { createHmac, timingSafeEqual } from "node:crypto";

// HS256 JSON Web Tokens on node:crypto (phase 2b, spec 7.1). Montonio signs every request with the store's secret key and every answer the
// same way; its own examples reach for a package for two functions, and these are those two (ported from Rempire's integration). HS256 only:
// a token whose header names any other algorithm ("none", RS256 with the HMAC key as its public key) is refused before its signature is even
// looked at. The signature is compared in constant time. An expired token is reported, not refused: the caller confirms it with Montonio
// (server/payments/settle.ts). Nothing here logs: a token is never logged.

export type JwtErrorCode = "malformed" | "alg" | "signature" | "payload";

/** A token that cannot be trusted, and so never a paid order. `code` may be logged; the token never is. */
export class JwtError extends Error {
  constructor(readonly code: JwtErrorCode) {
    super(`jwt ${code}`);
    this.name = "JwtError";
  }
}

type Claims = Record<string, unknown>;

const json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const parse = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const sign = (input: string, secret: string): string => createHmac("sha256", secret).update(input).digest("base64url");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Signs `payload` with `secret`: `iat` is stamped, and `exp` = iat + `expiresInSeconds` when asked and not given. */
export function signHs256(payload: Claims, secret: string, opts: { expiresInSeconds?: number; nowSec?: number } = {}): string {
  if (!secret) throw new JwtError("signature");
  const now = opts.nowSec ?? nowSeconds();
  const body: Claims = { ...payload, iat: now };
  if (opts.expiresInSeconds !== undefined && body.exp === undefined) body.exp = now + opts.expiresInSeconds;
  const input = `${json({ alg: "HS256", typ: "JWT" })}.${json(body)}`;
  return `${input}.${sign(input, secret)}`;
}

/**
 * The claims of a token signed with `secret`, and whether it is past its `exp` by more than `toleranceSec` (default 60). Throws a JwtError
 * for anything that cannot be trusted: not three parts, a header or payload that is no JSON ("malformed"), an algorithm other than HS256
 * ("alg"), a signature that does not match ("signature"), a payload that is not an object ("payload").
 */
export function verifyHs256<T extends Claims = Claims>(token: string, secret: string, opts: { toleranceSec?: number; nowSec?: number } = {}): { claims: T; expired: boolean } {
  if (!secret) throw new JwtError("signature");
  if (typeof token !== "string") throw new JwtError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed");
  const [head, body, signature] = parts;
  let header: unknown;
  try {
    header = parse(head);
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof header !== "object" || header === null || (header as Claims).alg !== "HS256") throw new JwtError("alg");
  const expected = Buffer.from(sign(`${head}.${body}`, secret));
  const given = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which is a mismatch too
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError("signature");
  let claims: unknown;
  try {
    claims = parse(body);
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new JwtError("payload");
  const exp = (claims as Claims).exp;
  const expired = typeof exp === "number" && (opts.nowSec ?? nowSeconds()) > exp + (opts.toleranceSec ?? 60);
  return { claims: claims as T, expired };
}
