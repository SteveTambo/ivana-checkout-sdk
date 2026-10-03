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

### Optional AML pre-check

```js
const { eligible } = await checkout.checkEligibility({ intentId, walletAddress });
```

IVANA screens the wallet again when building and verifying, so this is only
for a friendlier message before the wallet prompt.

## 3. Fulfil from settlement events (server)

```js
let cursor = await loadCursor();
const page = await ivana.listSettlementEvents({ after: cursor });
for (const event of page.events) {
  await fulfil(event.merchantReference, event); // persist event.id first
  await ivana.acknowledgeSettlementEvent(event.id);
  cursor = event.cursor;
}
await saveCursor(cursor);
```

Events are durable and ordered. Unacknowledged events replay after a crash,
so persist `event.id` before acting on it. `settlementHealth()` reports
events or intents that have been stuck for over ten minutes.

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
| `WALLET_NOT_CONNECTED` | No wallet, or one without `signTransaction`. |
| `TIMEOUT` / `NETWORK_ERROR` | IVANA could not be reached. |

## Fees

IVANA adds the platform fee configured for your tenant to the buyer's total
(1.6% on WRHSE), shown in `breakdown.transactionFee`. The buyer also pays the
Solana network fee from their wallet, so they need a little SOL.

## License

Apache-2.0. The SDK is open source; the IVANA engine it calls is a hosted
service operated by Habix Group.
