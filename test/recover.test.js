import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@solana/web3.js";
import { createIvanaCheckout } from "../src/checkout.js";
import { fakeConnection, fakeFetch } from "./helpers.js";

const pending = { intentId: "intent-1", signature: "sig", walletAddress: "W", paymentMethod: "USDC", lastValidBlockHeight: 100 };
const intent = (status) => [200, { intentId: "intent-1", status }];
const verified = [200, { success: true }];

function recover(routes, connection) {
  const { fetch } = fakeFetch(routes);
  return createIvanaCheckout({ connection, fetch, Transaction }).recoverPayment(pending);
}

test("completed at IVANA is completed", async () => {
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("completed") }, fakeConnection()), "completed");
});

test("an intent still processing is pending", async () => {
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("submitting") }, fakeConnection()), "pending");
});

test("confirmed on chain but not recorded: verifies, then completed", async () => {
  const connection = fakeConnection({ getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }) });
  assert.equal(
    await recover({ "GET /webthree/payment-intents/intent-1": intent("created"), "POST /webthree/verify-payment": verified }, connection),
    "completed",
  );
});

test("failed on chain is failed", async () => {
  const connection = fakeConnection({ getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, "x"] } }] }) });
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("created") }, connection), "failed");
});

test("unseen before its last valid height is still pending", async () => {
  const connection = fakeConnection({ getBlockHeight: async () => 100 });
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("created") }, connection), "pending");
});

test("unseen past its last valid height, rechecked, and still unpaid is expired", async () => {
  const connection = fakeConnection({ getBlockHeight: async () => 101, getTransaction: async () => null });
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("created") }, connection), "expired");
  // IVANA hides an expired unpaid intent with 404; the chain still decides.
  assert.equal(
    await recover({ "GET /webthree/payment-intents/intent-1": [404, { error: { message: "Not found" } }] }, connection),
    "expired",
  );
});

test("a transaction found on the recheck keeps it pending", async () => {
  const connection = fakeConnection({ getBlockHeight: async () => 101, getTransaction: async () => ({ slot: 1 }) });
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("created") }, connection), "pending");
});

test("an RPC or IVANA failure is unavailable, never expired", async () => {
  const connection = fakeConnection({ getSignatureStatuses: async () => { throw new Error("403"); } });
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": intent("created") }, connection), "unavailable");
  assert.equal(await recover({ "GET /webthree/payment-intents/intent-1": [503, { error: { message: "down" } }] }, fakeConnection()), "unavailable");
});
