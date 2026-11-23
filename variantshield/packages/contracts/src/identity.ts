import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Canonical subject identity.
 *
 * - A trusted backend (the authentication layer) knows the customer's internal id. It calls the VariantShield identity issuer
 *   once; the result is a pseudonymous subject reference derived with a server-side HMAC key, plus a short-lived signed token.
 * - Every surface uses the SAME subject reference as the Flagsmith identity, so Flagsmith's deterministic bucketing gives the
 *   same assignment in the same environment. No surface invents its own identifier.
 * - Surfaces pass the token server-to-server. Receivers verify the signature; a bare client-supplied id or header is never trusted.
 * - Browsers on different origins do not share storage, so the token must travel with the request (header, signed redirect
 *   parameter or server-side session), never be assumed to be in a shared cookie.
 */
const b64 = (b: Buffer): string => b.toString("base64url");
const RAW_SUBJECT = /^[A-Za-z0-9_\-:.]{1,128}$/;

export function validateRawSubject(raw: unknown): { ok: true; subject: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw === "") return { ok: false, reason: "subject is required" };
  if (raw.includes("@")) return { ok: false, reason: "subject looks like an email address; send an internal opaque id, never an email" };
  if (!RAW_SUBJECT.test(raw)) return { ok: false, reason: "subject must be 1-128 characters from [A-Za-z0-9_-:.]" };
  return { ok: true, subject: raw };
}

/** Pseudonymous, stable reference for a customer (or a shared anonymous id). 32 base64url chars of an HMAC. */
export function deriveSubjectRef(secret: string, kind: "authenticated" | "anonymous", rawSubject: string): string {
  const mac = createHmac("sha256", secret).update(`vs-subject:v1:${kind}:${rawSubject}`).digest();
  return `${kind === "anonymous" ? "anon" : "sub"}_${b64(mac).slice(0, 32)}`;
}

export interface IdentityTokenPayload { sub: string; kind: "authenticated" | "anonymous"; iat: number; exp: number; jti?: string; aud?: string }

/**
 * Tokens carry a random `jti` and may be scoped to one contract with `audience`; a token minted for one contract is not
 * accepted by another. They remain bearer credentials until `exp`, so keep the TTL short and send them only server-to-server.
 */
export function issueIdentityToken(secret: string, sub: string, kind: IdentityTokenPayload["kind"], nowMs: number, ttlSeconds = 900, audience?: string): string {
  const payload: IdentityTokenPayload = { sub, kind, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + ttlSeconds, jti: b64(randomBytes(12)), ...(audience ? { aud: audience } : {}) };
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `vsid1.${body}.${b64(createHmac("sha256", secret).update(`vsid1.${body}`).digest())}`;
}

export type TokenResult = { ok: true; sub: string; kind: IdentityTokenPayload["kind"]; expiresAtMs: number } | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "wrong_audience" };

/** `secrets` may list the current key first and older keys after it, so signing keys can be rotated without invalidating live tokens. */
export function verifyIdentityToken(secrets: string | readonly string[], token: unknown, nowMs: number, skewSeconds = 30, expectedAudience?: string): TokenResult {
  if (typeof token !== "string" || token === "") return { ok: false, reason: "missing" };
  if (token.length > 1024) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "vsid1") return { ok: false, reason: "malformed" };
  const given = Buffer.from(parts[2]!, "base64url");
  let signed = false;
  for (const secret of typeof secrets === "string" ? [secrets] : secrets) {
    const expected = createHmac("sha256", secret).update(`vsid1.${parts[1]}`).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) signed = true;
  }
  if (!signed) return { ok: false, reason: "bad_signature" };
  let p: IdentityTokenPayload;
  try { p = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (typeof p.sub !== "string" || !/^(sub|anon)_[A-Za-z0-9_-]{32}$/.test(p.sub) || typeof p.exp !== "number" || typeof p.iat !== "number") return { ok: false, reason: "malformed" };
  if (expectedAudience !== undefined && p.aud !== undefined && p.aud !== expectedAudience) return { ok: false, reason: "wrong_audience" };
  const now = nowMs / 1000;
  if (now > p.exp) return { ok: false, reason: "expired" };
  if (now + skewSeconds < p.iat) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, sub: p.sub, kind: p.kind === "anonymous" ? "anonymous" : "authenticated", expiresAtMs: p.exp * 1000 };
}

/** Short non-secret identifier of a Flagsmith environment, derived from its client-side key, used to detect environment mix-ups. */
export function environmentFingerprint(clientKey: string): string {
  return createHash("sha256").update(`vs-env:v1:${clientKey}`).digest("hex").slice(0, 16);
}
