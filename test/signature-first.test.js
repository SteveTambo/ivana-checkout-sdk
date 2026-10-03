// The signed transaction's own signature is known before it is broadcast, so a
// connection that drops mid-send can't leave a payment the caller can't trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Keypair, SendTransactionError, Transaction } from "@solana/web3.js";
import { createIvanaCheckout } from "../src/checkout.js";
import { SIGNATURE, builtTransactionBase64, fakeConnection, fakeFetch, fakeWallet } from "./helpers.js";

const verified = [200, { success: true, message: "Payment verified.", paymentMethod: "USDC" }];
const built = () => [200, { orderId: "intent-1", transaction: builtTransactionBase64(), feeMode: "buyer" }];
const notFound = () => [400, { error: { message: "Transaction not found on-chain yet.", code: "TRANSACTION_NOT_FOUND" } }];
// What web3.js's SendTransactionError looks like to the SDK: it has getLogs().
const refusal = (message) => Object.assign(new Error(message), { getLogs: async () => [] });

function checkout(routes, connection = fakeConnection()) {
  const { fetch, calls } = fakeFetch({
    "POST /webthree/register-payment-attempt": [200, { registered: true }],
    ...routes,
  });
  return { calls, client: createIvanaCheckout({ connection, fetch, Transaction }) };
}

test("onSignature fires after signing and before the broadcast, with the blockhash window", async () => {
  const order = [];
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({ sendRawTransaction: async () => { order.push("sent"); return SIGNATURE; } }),
  );
  let window;
  await client.pay({
    intentId: "intent-1",
    wallet: fakeWallet(),
    onSignature: (sig, blockhash) => { order.push("saved"); window = blockhash; },
  });
  assert.deepEqual(order, ["saved", "sent"]);
  assert.equal(window.lastValidBlockHeight, 100);
});

test("a connection that drops while sending is verified by the signed signature, not reported as a failure", async () => {
  let verifyBody;
  const { client } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/verify-payment": (body) => { verifyBody = body; return verified; },
    },
    fakeConnection({ sendRawTransaction: async () => { throw new TypeError("fetch failed"); } }),
  );
  const seen = [];

  const result = await client.pay({ intentId: "intent-1", wallet: fakeWallet(), onSignature: (s) => seen.push(s) });

  // It had landed after all: the buyer is not asked to pay again.
  assert.equal(result.signature, SIGNATURE);
  assert.deepEqual(seen, [SIGNATURE]);
  assert.equal(verifyBody.signature, SIGNATURE);
});

test("a lost send that never lands says to hold off, with the height after which paying again is safe", async () => {
  const { client } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/verify-payment": [notFound, notFound, notFound, notFound],
    },
    fakeConnection({ sendRawTransaction: async () => { throw new TypeError("fetch failed"); } }),
  );

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), (error) => {
    assert.equal(error.signature, SIGNATURE);
    assert.equal(error.lastValidBlockHeight, 100);
    assert.equal(error.code, "TRANSACTION_NOT_FOUND");
    assert.match(error.message, /may or may not have been sent/);
    assert.match(error.message, /do not pay again until/);
    return true;
  });
});

test("a refusal from the node is definitive: onRejected fires, nothing is verified, no signature is claimed", async () => {
  let sends = 0;
  const { client, calls } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({ sendRawTransaction: async () => { sends += 1; throw refusal("Insufficient lamports for fee"); } }),
  );
  const order = [];

  await assert.rejects(
    client.pay({
      intentId: "intent-1",
      wallet: fakeWallet(),
      onSignature: () => order.push("saved"),
      onRejected: () => order.push("rejected"),
    }),
    (error) => {
      assert.equal(error.code, "SEND_FAILED");
      assert.equal(error.signature, undefined);
      return true;
    },
  );
  assert.deepEqual(order, ["saved", "rejected"]);
  assert.equal(sends, 1);
  assert.equal(calls.some((c) => c.key === "POST /webthree/verify-payment"), false);
});

test("web3.js's own SendTransactionError counts as a refusal", async () => {
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({
      sendRawTransaction: async () => {
        throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "custom program error: 0x1", logs: [] });
      },
    }),
  );
  let rejected = 0;
  await assert.rejects(
    client.pay({ intentId: "intent-1", wallet: fakeWallet(), onRejected: () => { rejected += 1; } }),
    { code: "SEND_FAILED" },
  );
  assert.equal(rejected, 1);
});

test("a refused expired blockhash clears the saved signature each time and re-signs", async () => {
  let sends = 0;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({
      sendRawTransaction: async () => {
        sends += 1;
        if (sends === 1) throw refusal("Transaction simulation failed: Blockhash not found");
        return SIGNATURE;
      },
    }),
  );
  const order = [];
  await client.pay({
    intentId: "intent-1",
    wallet: fakeWallet(),
    onSignature: () => order.push("saved"),
    onRejected: () => order.push("rejected"),
  });
  assert.deepEqual(order, ["saved", "rejected", "saved"]);
});

test("an RPC answer naming a different signature never replaces the signed transaction's own", async () => {
  let verifyBody;
  const { client } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/verify-payment": (body) => { verifyBody = body; return verified; },
    },
    fakeConnection({ sendRawTransaction: async () => "SomeOtherSignature" }),
  );
  const result = await client.pay({ intentId: "intent-1", wallet: fakeWallet() });
  assert.equal(result.signature, SIGNATURE);
  assert.equal(verifyBody.signature, SIGNATURE);
});

test("a wallet that returns no signature is refused before anything is sent", async () => {
  let sent = false;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({ sendRawTransaction: async () => { sent = true; return SIGNATURE; } }),
  );
  const wallet = fakeWallet({ signTransaction: async () => ({ serialize: () => new Uint8Array([1]) }) });
  await assert.rejects(client.pay({ intentId: "intent-1", wallet }), {
    code: "SEND_FAILED",
    message: /no transaction signature/,
  });
  assert.equal(sent, false);
});

test("the derived signature is the one Solana assigns to a really signed transaction", async () => {
  const payer = Keypair.generate();
  const real = Transaction.from(Buffer.from(builtTransactionBase64(), "base64"));
  real.feePayer = payer.publicKey;
  real.recentBlockhash = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";
  real.sign(payer);
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({ sendRawTransaction: async () => "irrelevant" }),
  );
  const seen = [];
  await client.pay({
    intentId: "intent-1",
    wallet: { publicKey: payer.publicKey, signTransaction: async () => real },
    onSignature: (s) => seen.push(s),
  });
  // bs58 is the reference encoder behind web3.js's own signatures.
  const bs58 = createRequire(import.meta.url)("bs58");
  assert.equal(seen[0], (bs58.encode || bs58.default.encode)(real.signature));
});
