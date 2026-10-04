import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@solana/web3.js";
import { createIvanaCheckout } from "../src/checkout.js";
import { BUYER, SIGNATURE, builtTransactionBase64, fakeConnection, fakeFetch, fakeWallet } from "./helpers.js";

const verified = [200, { success: true, message: "Payment verified.", paymentMethod: "USDC" }];
const built = () => [200, { orderId: "intent-1", transaction: builtTransactionBase64(), feeMode: "buyer" }];

function checkout(routes, connection = fakeConnection()) {
  const { fetch, calls } = fakeFetch({
    "POST /webthree/register-payment-attempt": [200, { registered: true }],
    ...routes,
  });
  return { calls, client: createIvanaCheckout({ connection, fetch, Transaction }) };
}

test("pay builds buyer-paid, refreshes the blockhash, signs, sends and verifies", async () => {
  const { client, calls } = checkout({
    "POST /webthree/build-payment-transaction": built,
    "POST /webthree/verify-payment": verified,
  });
  const wallet = fakeWallet();
  const seen = [];

  const result = await client.pay({ intentId: "intent-1", wallet, onSignature: (s) => seen.push(s) });

  assert.equal(result.signature, SIGNATURE);
  assert.equal(result.verification.success, true);
  assert.deepEqual(seen, [SIGNATURE]);
  assert.deepEqual(calls[0].body, {
    intentId: "intent-1",
    walletAddress: BUYER.toBase58(),
    paymentMethod: "USDC",
    feeMode: "buyer",
  });
  assert.equal(wallet.signed[0].recentBlockhash, "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W");
  assert.equal(calls[1].key, "POST /webthree/register-payment-attempt");
  assert.deepEqual(calls[1].body, {
    intentId: "intent-1",
    signature: SIGNATURE,
    blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W",
    lastValidBlockHeight: 100,
    walletAddress: BUYER.toBase58(),
    paymentMethod: "USDC",
  });
  assert.deepEqual(calls[2].body, {
    intentId: "intent-1",
    signature: SIGNATURE,
    walletAddress: BUYER.toBase58(),
    paymentMethod: "USDC",
  });
});

test("verification retries only while the transaction is not indexed yet", async () => {
  const notFound = () => [400, { error: { message: "Transaction not found on-chain yet.", code: "TRANSACTION_NOT_FOUND" } }];
  const { client, calls } = checkout({
    "POST /webthree/build-payment-transaction": built,
    "POST /webthree/verify-payment": [notFound, () => verified],
  });

  const result = await client.pay({ intentId: "intent-1", wallet: fakeWallet() });

  assert.equal(result.verification.success, true);
  assert.equal(calls.filter((c) => c.key === "POST /webthree/verify-payment").length, 2);
});

test("a verification failure after broadcast carries the signature, so nobody pays twice", async () => {
  const { client } = checkout({
    "POST /webthree/build-payment-transaction": built,
    "POST /webthree/verify-payment": [400, { error: { message: "Wallet does not match this payment intent." } }],
  });

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), (error) => {
    assert.equal(error.signature, SIGNATURE);
    assert.equal(error.code, "VERIFY_FAILED");
    assert.equal(error.status, 400);
    return true;
  });
});

test("does not broadcast when signed-attempt registration fails", async () => {
  let sent = false;
  const { client } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/register-payment-attempt": [503, { error: { message: "unavailable" } }],
    },
    fakeConnection({ sendRawTransaction: async () => { sent = true; return SIGNATURE; } }),
  );

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }));
  assert.equal(sent, false);
});

test("a cancelled wallet prompt is reported as USER_REJECTED and nothing is sent", async () => {
  let sent = false;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({ sendRawTransaction: async () => { sent = true; return "x"; } }),
  );
  const wallet = fakeWallet({
    signTransaction: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); },
  });

  await assert.rejects(client.pay({ intentId: "intent-1", wallet }), { code: "USER_REJECTED" });
  assert.equal(sent, false);
});

test("an expired blockhash is refreshed and re-signed without rebuilding the payment", async () => {
  let sends = 0;
  const { client, calls } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/verify-payment": verified,
    },
    fakeConnection({
      sendRawTransaction: async () => {
        sends += 1;
        if (sends === 1) throw new Error("Blockhash not found");
        return SIGNATURE;
      },
    }),
  );
  let retried = 0;

  const result = await client.pay({ intentId: "intent-1", wallet: fakeWallet(), onRetry: () => { retried += 1; } });

  assert.equal(result.signature, SIGNATURE);
  assert.equal(retried, 1);
  assert.equal(calls.filter((c) => c.key === "POST /webthree/build-payment-transaction").length, 1);
});

test("an unreachable RPC fails before IVANA builds, so the intent is not used up", async () => {
  const { client, calls } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({ getLatestBlockhash: async () => { throw new Error("403 : Access forbidden"); } }),
  );

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), { code: "RPC_UNAVAILABLE" });
  assert.equal(calls.some((c) => c.key === "POST /webthree/build-payment-transaction"), false);
});

test("a blockhash refresh that fails after the build signs with the preflight blockhash", async () => {
  let lookups = 0;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({
      getLatestBlockhash: async () => {
        lookups += 1;
        if (lookups > 1) throw new Error("fetch failed");
        return { blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: 100 };
      },
    }),
  );
  const wallet = fakeWallet();

  const result = await client.pay({ intentId: "intent-1", wallet });

  assert.equal(lookups, 2, "the refresh after the build was attempted and failed");
  assert.equal(result.signature, SIGNATURE);
  assert.equal(wallet.signed[0].recentBlockhash, "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W");
});

test("an on-chain failure is reported and never verified", async () => {
  const { client, calls } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({ confirmTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] } } }) }),
  );

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), { code: "SOLANA_TRANSACTION_FAILED" });
  assert.equal(calls.some((c) => c.key === "POST /webthree/verify-payment"), false);
});

test("an RPC timeout falls back to the signature status before verifying", async () => {
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({
      confirmTransaction: async () => { throw new Error("timeout"); },
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
    }),
  );

  const result = await client.pay({ intentId: "intent-1", wallet: fakeWallet() });
  assert.equal(result.verification.success, true);
});

test("a build error from IVANA surfaces its message and status", async () => {
  const { client } = checkout({
    "POST /webthree/build-payment-transaction": [400, { error: { message: "This payment intent has already been used or is invalid." } }],
  });

  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), {
    status: 400,
    message: "This payment intent has already been used or is invalid.",
  });
});

test("checkEligibility and getPaymentIntent encode their parameters", async () => {
  const { client, calls } = checkout({
    "GET /webthree/check-aml-eligibility": [200, { eligible: true, unavailable: false }],
    "GET /webthree/payment-intents/a%2Fb": [200, { intentId: "a/b", status: "created" }],
  });

  assert.deepEqual(await client.checkEligibility({ intentId: "i 1", walletAddress: "W" }), { eligible: true, unavailable: false });
  assert.equal(calls[0].path, "/webthree/check-aml-eligibility?intentId=i+1&wallet=W");
  assert.equal((await client.getPaymentIntent("a/b")).status, "created");
});

test("pay refuses a wallet that is not connected", async () => {
  const { client } = checkout({});
  await assert.rejects(
    client.pay({ intentId: "intent-1", wallet: { publicKey: null, signTransaction: async () => {} } }),
    { code: "WALLET_NOT_CONNECTED" },
  );
});
