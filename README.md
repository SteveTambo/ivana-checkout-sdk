# IVANA Checkout SDK

Non-custodial Solana checkout for any storefront, on the IVANA payments engine.

One transaction, signed by the buyer's own wallet, pays everyone at once:
the merchant, VAT to the tax authority's wallet, the platform fee and any
consignment suppliers. IVANA builds that transaction, screens the paying
wallet against a sanctions blocklist, and verifies the confirmed on-chain
balance change for every leg before it reports the payment as settled.
Neither IVANA nor this SDK ever holds funds or keys.

IVANA powers checkout on [WRHSE](https://www.wrhse.top). The engine itself
is a hosted service; this SDK is the open, Apache-2.0 client for it.

- Payments in USDC, USDT or HBX (SPL tokens on Solana mainnet)
- Works with any wallet that supports `signTransaction` (Phantom, Solflare,
  Mobile Wallet Adapter)
- Zero runtime dependencies beyond `@solana/web3.js`

## How it works

```
merchant backend                  buyer's browser                     IVANA
----------------                  ---------------                     -----
createPaymentIntent ─────────────────────────────────────────────▶ price order,
(tenant API key)                                                      VAT + fee split
      │ intentId
      └──────────────────────▶ checkout.pay({ intentId, wallet })
                                  build ────────────────────────────▶ build tx, AML screen
                                  wallet signs + broadcasts ─────────▶ Solana
                                  verify ───────────────────────────▶ check every leg on chain
listSettlementEvents ◀─────────────────────────────────────────────── payment.completed
```

The tenant API key stays on your server. The browser only ever sees the
`intentId`, which can pay that one order and nothing else.

## Install

```bash
npm install @habix/ivana-checkout @solana/web3.js
```

You need an IVANA tenant account and API key. Register at
[ivanabeta.habixgroup.top](https://ivanabeta.habixgroup.top) and configure
your merchant wallet there.

## 1. Create a payment intent (server)

```js
import { createIvanaServer } from "@habix/ivana-checkout/server";

const ivana = createIvanaServer({ apiKey: process.env.IVANA_API_KEY });

const intent = await ivana.createPaymentIntent({
  customer: { name: "Ada", email: "ada@example.com" },
  // Prices from your own catalogue, never from the buyer's request.
  lineItems: [{ title: "Iced coffee", unitPriceUsdc: 3.5, quantity: 2 }],
  merchantReference: "order-1042",
  idempotencyKey: "order-1042", // retries return the same intent
});

// Send only intent.intentId (and intent.breakdown for display) to the browser.
```

`breakdown` contains the net amount, VAT, platform fee and total that the
buyer will pay. Consignment lines (`isConsignment: true, supplierWallet`)
pay the supplier their share in the same transaction.

## 2. Pay (browser)

```js
import { Connection } from "@solana/web3.js";
import { createIvanaCheckout } from "@habix/ivana-checkout";

const checkout = createIvanaCheckout({
  connection: new Connection("https://your-rpc.example", "confirmed"),
});

const wallet = window.phantom.solana;
await wallet.connect();

const { signature } = await checkout.pay({
  intentId,
  wallet,
  paymentMethod: "USDC",
  onSignature: (sig) => localStorage.setItem(`ivana:${intentId}`, sig),
  onRejected: () => localStorage.removeItem(`ivana:${intentId}`),
});
```

`pay` builds the transaction, refreshes its blockhash from your RPC just
before approval, asks the wallet to sign, broadcasts, confirms, and verifies
with IVANA. Expired blockhashes are re-signed automatically; the payment legs
never change.

### Never charge twice

Save the signature as soon as `onSignature` fires. It fires after the wallet
signs and **before** the transaction is broadcast, so even a connection that
drops mid-send leaves you holding the signature. If the node then refuses the
transaction, nothing was sent and `onRejected` fires: drop what you saved and
let the buyer try again.

If `pay` throws an error with `error.signature` set, the payment may have been
broadcast and may still settle. Show "don't pay again" and later call:

```js
await checkout.verifyPayment({ intentId, signature, walletAddress, paymentMethod: "USDC" });
```

When a send's outcome is unknown (the connection dropped), `error.lastValidBlockHeight`
is the chain height after which that transaction can never land. Until
`await connection.getBlockHeight()` passes it, keep telling the buyer not to
pay again; after it, and if `verifyPayment` still finds nothing, a new payment
is safe.

### Drop-in pay button (React)

```jsx
import { Connection } from "@solana/web3.js";
import { IvanaPayButton } from "@habix/ivana-checkout/react";

const connection = new Connection("https://your-rpc.example", "confirmed");

<IvanaPayButton
  intentId={intentId}
  connection={connection}
  paymentMethod="USDC"
  onPaid={({ signature }) => showReceipt(signature)}
/>;
```

The button does everything above for you:

- **Wallet picker.** Phantom and Solflare when installed. On a phone's
  browser, where wallets aren't injected, it offers "Open in Phantom" or
  "Open in Solflare", which reopens your checkout page inside the wallet's
  own browser. Otherwise it links to the wallet's download page.
- **Never charges twice.** It saves the signature before broadcast, and on
  the next page load resolves that payment before offering "pay" again. A
  payment that may have been sent shows "Don't pay again" until IVANA or the
  chain gives a definite answer.
- **Unstyled.** Target the `ivana-pay`, `ivana-pay__button`,
  `ivana-pay__wallets`, `ivana-pay__link` and `ivana-pay__message` classes.

React 18 or newer is an optional peer dependency, needed only for
`@habix/ivana-checkout/react`. For your own UI, use the `useIvanaPayment`
hook. Without React, `createPayFlow` (from the main entry) is the same logic
as a small state machine with `choose`, `pay`, `recover` and `subscribe`, and
`listWallets()`, `createPendingPaymentStore()` and
`checkout.recoverPayment(saved)` are available on their own.

### In person: Solana Pay QR

For a stall, a pop-up or an event door, show a QR code the buyer scans with
Phantom or any [Solana Pay](https://docs.solanapay.com) wallet:

```jsx
import { QRCodeSVG } from "qrcode.react"; // or any QR library
import { SolanaPayQR } from "@habix/ivana-checkout/react";

<SolanaPayQR
  intentId={intentId}
  connection={connection}
  paymentMethod="USDC"
  renderQr={(url) => <QRCodeSVG value={url} size={256} />}
  onPaid={({ signature }) => markPaid(signature)}
/>;
```

The QR is a Solana Pay *transaction request* on IVANA. The wallet fetches the
same buyer-paid transaction as browser checkout (every leg, the AML screen,
the intent memo), shows the merchant's name, and the buyer signs and sends it
from their phone. The transaction carries a reference key derived from the
intent; the component watches for it and verifies the payment with IVANA a
few seconds after it confirms. If no screen is watching, IVANA settles the
payment on its own and your settlement consumer still receives it.

Without React:

```js
const url = checkout.solanaPayUrl(intentId, "USDC"); // put this in a QR code
const { signature } = await checkout.waitForSolanaPayment({ intentId, paymentMethod: "USDC" });
```

Each check while waiting is one Solana RPC request. The wait checks every 2 seconds for the first minute, every 5 seconds until 5 minutes, then every 10 seconds, about 140 requests if a QR is left open for the full 15 minutes. Pass `intervalMs` for a fixed interval, and `signal` to stop waiting when the QR is closed.

On a phone, the same `url` works as a link that opens the wallet. Each intent
can be paid once: if the buyer declines in the wallet, create a new intent
and show its QR.

### Optional AML pre-check

```js
const { eligible } = await checkout.checkEligibility({ intentId, walletAddress });
```

IVANA screens the wallet again when building and verifying, so this is only
for a friendlier message before the wallet prompt.

## 3. Fulfil from settlement events (server)

Every paid intent produces a durable, ordered `payment.completed` event, even
when the buyer closes the tab mid-checkout. Fulfil orders from these events
and an order is never lost:

```js
import { createIvanaServer, createSettlementConsumer, PermanentEventError } from "@habix/ivana-checkout/server";

const ivana = createIvanaServer({ apiKey: process.env.IVANA_API_KEY });

const consumer = createSettlementConsumer({
  server: ivana,
  loadCursor: () => db.getSetting("ivana-cursor"),
  saveCursor: (cursor) => db.setSetting("ivana-cursor", cursor),
  // Must be idempotent: the same event can arrive again after a crash.
  async apply(event) {
    const order = await db.findOrderByReference(event.merchantReference);
    if (!order) throw new PermanentEventError(`No order for ${event.merchantReference}`);
    if (order.paidIntentId === event.intentId) return; // already fulfilled
    await db.markPaid(order.id, { intentId: event.intentId, signature: event.signature });
  },
  onParked: (event, error) => alertOps(`Payment ${event.intentId} needs attention: ${error.message}`),
});

const stop = consumer.start(); // every minute while payments arrive, every 15 minutes when quiet
```

The consumer applies each event, acknowledges it, then saves the cursor, so
a crash at any point replays the event rather than losing it. If `apply`
throws an ordinary error (your database is down), the round stops and the
event is retried with growing delays. If it throws `PermanentEventError`
three times in a row, the event is **parked**: the consumer moves on so later
payments keep settling, and leaves that event unacknowledged in IVANA for a
person to resolve. Run one round yourself with `await consumer.pollOnce()`,
for example from a cron job.

The building blocks are available directly: `listSettlementEvents({ after })`
and `acknowledgeSettlementEvent(id)`. `settlementHealth()` reports events or
intents that have been stuck for over ten minutes, including parked ones.

### Confirm one payment

```js
const receipt = await ivana.getPaymentSettlement(intentId);
if (receipt.status === "completed") fulfil(receipt.merchantReference, receipt);
```

Use this when your backend records an order the buyer's browser reported.
The buyer's wallet and the transaction signature are only returned once the
payment has completed.

### Check payment setup

```js
const { paymentSetup } = await ivana.getTenant({ includePaymentSetup: true });
if (!paymentSetup.ready) console.warn("Missing:", paymentSetup.missing);
```

## Errors

Every failure is an `IvanaError` with `message`, optional HTTP `status`, and
a `code` where one applies:

| code | meaning |
| --- | --- |
| `USER_REJECTED` | The buyer cancelled the wallet prompt. Nothing was sent. |
| `SOLANA_TRANSACTION_FAILED` | The transaction failed on chain. No payment was made. |
| `TRANSACTION_NOT_FOUND` | Broadcast but not indexed yet. Verify again shortly. |
| `VERIFY_FAILED` | Broadcast, but verification rejected it. `error.signature` is set. |
| `SEND_FAILED` | The wallet didn't sign, or the node refused the transaction. Nothing was sent. |
| `BLOCKHASH_EXPIRED` | The buyer took too long to approve, after automatic retries. |
| `RPC_UNAVAILABLE` | The Solana RPC could not be reached (public RPCs often 403 browsers; use your own). Nothing was sent. Before the payment is built, the same intent can be paid again. |
| `WALLET_NOT_CONNECTED` | No wallet, or one without `signTransaction`. |
| `TIMEOUT` / `NETWORK_ERROR` | IVANA could not be reached. |

## Fees

IVANA adds the platform fee configured for your tenant to the buyer's total
(1.6% on WRHSE), shown in `breakdown.transactionFee`. The buyer also pays the
Solana network fee from their wallet, so they need a little SOL.

## License

Apache-2.0. The SDK is open source; the IVANA engine it calls is a hosted
service operated by Habix Group.
