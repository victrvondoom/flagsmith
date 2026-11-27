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

/**
 * Live updates from GET /api/stream. EventSource cannot send the bearer token, so this reads the stream with fetch().
 * Calls onEvent(name, data) per server-sent event and onState("live" | "reconnecting" | "closed"). Returns a stop function.
 */
export function stream(path, onEvent, onState = () => {}) {
  const ctl = new AbortController();
  let stopped = false, backoff = 1000;
  const run = async () => {
    while (!stopped) {
      try {
        const res = await fetch(path, { headers: { authorization: `Bearer ${session.token}` }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new ApiError(res.status, null);
        onState("live"); backoff = 1000;
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            let name = "message", data = "";
            for (const line of block.split("\n")) { if (line.startsWith("event: ")) name = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
            if (data) { try { onEvent(name, JSON.parse(data)); } catch { /* ignore a malformed event */ } }
          }
        }
      } catch (e) {
        if (stopped) break;
        if (e instanceof ApiError && e.status === 401) { onState("closed"); return; }
      }
      if (stopped) break;
      onState("reconnecting");
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 15000);
    }
    onState("closed");
  };
  void run();
  return () => { stopped = true; ctl.abort(); };
}
