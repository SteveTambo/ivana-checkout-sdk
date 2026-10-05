import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createIvanaCheckout, solanaPayReference, solanaPayUrl } from "../src/checkout.js";
import { SolanaPayQR } from "../src/react.js";
import { BUYER, fakeConnection, fakeFetch } from "./helpers.js";

test("the reference matches IVANA's derivation: sha256 of the versioned domain and intent id", async () => {
  const expected = new PublicKey(createHash("sha256").update("ivana:solana-pay:v1:intent-1").digest()).toBase58();
  assert.equal(await solanaPayReference("intent-1"), expected);
  assert.notEqual(await solanaPayReference("intent-2"), expected);
});

test("the QR URL is a URL-encoded transaction request on IVANA", () => {
  const url = solanaPayUrl({ intentId: "intent 1", paymentMethod: "HBX", baseUrl: "https://ivana.example/api/" });
  assert.equal(url, `solana:${encodeURIComponent("https://ivana.example/api/webthree/solana-pay/intent%201?method=HBX")}`);
  const { fetch } = fakeFetch({});
  const checkout = createIvanaCheckout({ connection: fakeConnection(), fetch, Transaction });
  assert.match(
    checkout.solanaPayUrl("intent-1"),
    /^solana:https%3A%2F%2Fivanaservertenant\.onrender\.com%2Fapi%2Fwebthree%2Fsolana-pay%2Fintent-1%3Fmethod%3DUSDC$/,
  );
});

const landed = (overrides = {}) =>
  fakeConnection({
    getSignaturesForAddress: async () => [{ signature: "qr-sig", err: null }],
    getTransaction: async () => ({ transaction: { message: { staticAccountKeys: [BUYER] } } }),
    ...overrides,
  });

test("waits for the wallet's transaction on the reference, then verifies it as the paying wallet", async () => {
  let watched;
  const { fetch, calls } = fakeFetch({ "POST /webthree/verify-payment": [200, { success: true }] });
  let polls = 0;
  const connection = landed({
    getSignaturesForAddress: async (address) => {
      watched = address.toBase58();
      polls += 1;
      return polls < 3 ? [] : [{ signature: "qr-sig", err: null }];
    },
  });
  const checkout = createIvanaCheckout({ connection, fetch, Transaction });

  const result = await checkout.waitForSolanaPayment({ intentId: "intent-1", paymentMethod: "HBX", intervalMs: 1 });

  assert.equal(watched, await solanaPayReference("intent-1"));
  assert.equal(result.signature, "qr-sig");
  assert.equal(result.walletAddress, BUYER.toBase58());
  assert.deepEqual(calls[0].body, { intentId: "intent-1", signature: "qr-sig", walletAddress: BUYER.toBase58(), paymentMethod: "HBX" });
});

test("a payment IVANA's reconciler settled first still resolves as paid", async () => {
  const { fetch } = fakeFetch({
    "POST /webthree/verify-payment": [400, { error: { message: "This payment intent has already been completed." } }],
    "GET /webthree/payment-intents/intent-1": [200, { status: "completed" }],
  });
  const checkout = createIvanaCheckout({ connection: landed(), fetch, Transaction });
  const result = await checkout.waitForSolanaPayment({ intentId: "intent-1", intervalMs: 1 });
  assert.equal(result.verification.success, true);
});

test("a verification refusal on an unpaid intent is reported", async () => {
  const { fetch } = fakeFetch({
    "POST /webthree/verify-payment": [400, { error: { message: "The USDC transfer does not match this intent." } }],
    "GET /webthree/payment-intents/intent-1": [200, { status: "created" }],
  });
  const checkout = createIvanaCheckout({ connection: landed(), fetch, Transaction });
  await assert.rejects(checkout.waitForSolanaPayment({ intentId: "intent-1", intervalMs: 1 }), /does not match/);
});

test("a failed transaction, a timeout and an abort each end the wait", async () => {
  const { fetch } = fakeFetch({});
  const failed = createIvanaCheckout({
    connection: landed({ getSignaturesForAddress: async () => [{ signature: "x", err: { InstructionError: [0, "x"] } }] }),
    fetch,
    Transaction,
  });
  await assert.rejects(failed.waitForSolanaPayment({ intentId: "i", intervalMs: 1 }), { code: "SOLANA_TRANSACTION_FAILED" });

  const quiet = createIvanaCheckout({ connection: landed({ getSignaturesForAddress: async () => [] }), fetch, Transaction });
  await assert.rejects(quiet.waitForSolanaPayment({ intentId: "i", intervalMs: 1, timeoutMs: 5 }), { code: "TIMEOUT" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(quiet.waitForSolanaPayment({ intentId: "i", signal: controller.signal }), { code: "ABORTED" });
});

test("an RPC that errors while watching is treated as 'not yet'", async () => {
  const { fetch } = fakeFetch({ "POST /webthree/verify-payment": [200, { success: true }] });
  let polls = 0;
  const connection = landed({
    getSignaturesForAddress: async () => {
      polls += 1;
      if (polls === 1) throw new Error("429");
      return [{ signature: "qr-sig", err: null }];
    },
  });
  const checkout = createIvanaCheckout({ connection, fetch, Transaction });
  assert.equal((await checkout.waitForSolanaPayment({ intentId: "i", intervalMs: 1 })).signature, "qr-sig");
});

test("SolanaPayQR renders the QR through renderQr, with a tappable link", () => {
  const checkout = { solanaPayUrl: (id) => `solana:https%3A%2F%2Fx%2F${id}`, waitForSolanaPayment: () => new Promise(() => {}) };
  const html = renderToString(
    createElement(SolanaPayQR, { intentId: "intent-1", checkout, renderQr: (url) => createElement("svg", { "data-url": url }) }),
  );
  assert.match(html, /<svg data-url="solana:https%3A%2F%2Fx%2Fintent-1">/);
  assert.match(html, /<a href="solana:https%3A%2F%2Fx%2Fintent-1" class="ivana-pay__link">Pay with a Solana wallet<\/a>/);
});

test("a QR wait checks often while a payment is likely, then backs off to spare the RPC", async () => {
  const { solanaPayPollDelay } = await import("../src/checkout.js");
  assert.equal(solanaPayPollDelay(0), 2_000);
  assert.equal(solanaPayPollDelay(59_999), 2_000);
  assert.equal(solanaPayPollDelay(60_000), 5_000);
  assert.equal(solanaPayPollDelay(5 * 60_000), 10_000);
  // The whole 15-minute default wait, one RPC request per check.
  let checks = 0;
  for (let t = 0; t < 15 * 60_000; t += solanaPayPollDelay(t)) checks += 1;
  assert.ok(checks <= 150, `${checks} checks`);
});
