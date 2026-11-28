// Tiny DOM helpers. Everything goes through textContent / setAttribute, never innerHTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const chip = (status, label) => h("span", { class: `chip s-${status}` }, label ?? String(status).replaceAll("_", " "));

export function toast(msg) {
  document.querySelectorAll(".toast").forEach((old) => old.remove());
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3800);
}

export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "n/a");
export const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(2)}%`);
export const fmtMetric = (metric, v) => (v === null || v === undefined ? "n/a" : metric === "checkout_p95_latency_ms" ? `${Math.round(v)} ms` : pct(v));

export function table(headers, rows, opts = {}) {
  return h("div", { class: "scroll" }, h("table", { class: opts.class || "" },
    h("thead", {}, h("tr", {}, headers.map((x) => h("th", { class: x.num ? "num" : "" }, x.label ?? x)))),
    h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: headers.length, class: "muted" }, opts.empty || "Nothing to show yet."))])));
}

export const field = (label, control, id) => [h("label", { for: id }, label), control];
