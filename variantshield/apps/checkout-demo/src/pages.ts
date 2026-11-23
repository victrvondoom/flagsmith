const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FIELDS: Record<string, string> = {
  control: `
    <fieldset><legend>Card details</legend>
      <label for="card">Card number</label><input id="card" name="card" inputmode="numeric" autocomplete="cc-number" required value="4242 4242 4242 4242">
      <div class="row"><div><label for="exp">Expiry</label><input id="exp" name="exp" autocomplete="cc-exp" required value="12/30"></div>
      <div><label for="cvc">CVC</label><input id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" required value="123"></div></div>
    </fieldset>`,
  upi_first: `
    <fieldset><legend>Pay with UPI</legend>
      <label for="upi">UPI ID</label><input id="upi" name="upi" autocomplete="off" required value="demo@upi" aria-describedby="upi-hint">
      <p id="upi-hint" class="hint">You will get a collect request in your UPI app.</p>
    </fieldset>
    <details><summary>Use a card instead</summary><p class="hint">Card payments are available after UPI.</p></details>`,
  one_tap: `
    <fieldset><legend>Saved payment method</legend>
      <p class="saved" id="saved-method">Visa ending 4242</p>
      <p class="hint">One tap completes the purchase with your saved method.</p>
    </fieldset>`,
};

export function renderCheckout(variant: string, banner: string | null, noGuard = false, timeoutMs = 8000): string {
  const v = FIELDS[variant] ? variant : "control";
  const label = v === "one_tap" ? "Pay ₹1,499 with one tap" : "Pay ₹1,499";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout · VariantShield demo</title><link rel="stylesheet" href="/checkout.css"></head>
<body data-variant="${esc(v)}"${noGuard ? ' data-no-guard="true"' : ""}>
<main>
  <p class="demo-banner" role="note">Demo store for VariantShield. No real payments are made.</p>
  ${banner ? `<p class="assignment-banner" role="note" data-testid="assignment-banner">${esc(banner)}</p>` : ""}
  <h1>Checkout</h1>
  <p class="summary">Order total <strong>₹1,499</strong> · 1 item</p>
  <form id="checkout" data-testid="checkout-form" data-variant="${esc(v)}" data-timeout-ms="${timeoutMs}" aria-label="Checkout form" novalidate>
    ${FIELDS[v]}
    <div id="error" class="error" role="alert" hidden></div>
    <button type="submit" id="pay" data-testid="pay">${label}</button>
    <p id="status" role="status" aria-live="polite" data-testid="status"></p>
  </form>
</main>
<script src="/checkout.js" defer></script></body></html>`;
}
