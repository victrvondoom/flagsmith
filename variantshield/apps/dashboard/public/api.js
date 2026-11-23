// Thin client for the VariantShield API. The admin token lives only in sessionStorage for this tab.
const KEY = "vs.token";
const ACTOR = "vs.actor";
export const session = {
  get token() { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } },
  set token(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } },
  get actor() { try { return sessionStorage.getItem(ACTOR) || ""; } catch { return ""; } },
  set actor(v) { try { sessionStorage.setItem(ACTOR, v); } catch { /* storage unavailable */ } },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status; this.code = body?.error?.code || "error"; this.detail = body?.error?.detail;
  }
}

export async function api(method, path, body) {
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  if (session.actor) headers["x-variantshield-actor"] = session.actor;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/** Screenshots need the bearer token, so they are fetched and shown as object URLs. */
export async function imageUrl(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) throw new ApiError(res.status, null);
  return URL.createObjectURL(await res.blob());
}
