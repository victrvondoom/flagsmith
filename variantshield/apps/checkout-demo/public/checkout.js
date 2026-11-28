(() => {
  const form = document.getElementById("checkout");
  const pay = document.getElementById("pay");
  const status = document.getElementById("status");
  const errorBox = document.getElementById("error");
  const idleLabel = pay.textContent;
  let attemptKey = null;
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  const showError = (msg) => { errorBox.textContent = msg; errorBox.hidden = false; };
  const clearError = () => { errorBox.hidden = true; errorBox.textContent = ""; };
  // Fault injection can switch the duplicate-submit guard off to show an operationally unsafe variant.
  const guarded = document.body.dataset.noGuard !== "true";
  const setBusy = (busy) => {
    pay.setAttribute("aria-busy", String(busy));
    pay.disabled = busy && guarded;
    pay.textContent = busy ? "Processing…" : idleLabel;
    status.textContent = busy ? "Processing your payment" : status.textContent;
  };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (guarded && pay.getAttribute("aria-busy") === "true") return;
    clearError();
    // A retry after a failure or timeout reuses the same key so the server can recognise it.
    // Without the guard every click is a fresh attempt, which is exactly the unsafe behaviour being demonstrated.
    attemptKey = guarded ? attemptKey || newKey() : newKey();
    setBusy(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(form.dataset.timeoutMs) || 8000);
    try {
      const res = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: attemptKey }), signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === "ok") {
        status.textContent = "Payment complete. Order " + body.orderId;
        form.dataset.state = "complete";
        pay.hidden = true;
        setBusy(false);
        pay.hidden = true;
        return;
      }
      showError(body.status === "declined" ? "Your payment was declined. You can try again." : "Something went wrong on our side. You can try again.");
      form.dataset.state = "error";
    } catch (e) {
      showError(e && e.name === "AbortError" ? "The payment is taking longer than expected. Try again; you will not be charged twice." : "We could not reach the payment service. Try again.");
      form.dataset.state = "error";
    } finally {
      clearTimeout(timer);
      if (form.dataset.state !== "complete") { setBusy(false); status.textContent = ""; }
    }
  });
})();
