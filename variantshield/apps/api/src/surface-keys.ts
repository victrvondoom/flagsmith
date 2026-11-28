import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-surface reporting keys.
 *
 * A key is bound to exactly one (contract, surface) pair, so a compromised surface can only report as itself. It is derived
 * from the server's ingest key, so nothing is stored; rotating the ingest key rotates every surface key. The ingest key itself
 * is never handed to a surface and cannot write contract observations.
 */
const PART = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const mac = (ingestKey: string, contractId: string, surfaceId: string): string =>
  createHmac("sha256", ingestKey).update(`vs-surface:v1:${contractId}:${surfaceId}`).digest("base64url");

export function deriveSurfaceKey(ingestKey: string, contractId: string, surfaceId: string): string {
  if (!PART.test(contractId) || !PART.test(surfaceId)) throw new RangeError("contract and surface ids must be lowercase slugs");
  return `vss1.${contractId}.${surfaceId}.${mac(ingestKey, contractId, surfaceId)}`;
}

export interface SurfaceBinding { contractId: string; surfaceId: string }

/** Returns the binding when the key's MAC verifies, otherwise null. Constant-time on the MAC. */
export function verifySurfaceKey(ingestKey: string, header: unknown): SurfaceBinding | null {
  if (typeof header !== "string" || header.length > 300) return null;
  const parts = header.split(".");
  if (parts.length !== 4 || parts[0] !== "vss1") return null;
  const [, contractId, surfaceId, given] = parts as [string, string, string, string];
  if (!PART.test(contractId) || !PART.test(surfaceId)) return null;
  const expected = Buffer.from(mac(ingestKey, contractId, surfaceId));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { contractId, surfaceId };
}
