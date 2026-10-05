// Failure behaviour the happy-path tests don't reach: a response body that
// stalls, a merchant hook that throws after a payment is verified, simulation
// failures that retrying can't fix, a payment attempt that can't be
// registered, and answers that aren't JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@solana/web3.js";
import { createIvanaCheckout, createPayFlow, createPendingPaymentStore, IvanaError } from "../src/checkout.js";
import { createIvanaServer } from "../src/server.js";
import { request } from "../src/http.js";
import { SIGNATURE, builtTransactionBase64, fakeConnection, fakeFetch, fakeWallet } from "./helpers.js";

const verified = [200, { success: true, message: "Payment verified.", paymentMethod: "USDC" }];
const built = () => [200, { orderId: "intent-1", transaction: builtTransactionBase64(), feeMode: "buyer" }];
const refusal = (message) => Object.assign(new Error(message), { getLogs: async () => [] });

function checkout(routes, connection = fakeConnection()) {
  const { fetch, calls } = fakeFetch({
    "POST /webthree/register-payment-attempt": [200, { registered: true }],
    ...routes,
  });
  return { calls, client: createIvanaCheckout({ connection, fetch, Transaction }) };
}

// ── A2: the timeout covers the body ─────────────────────────────────────

test("a server that sends headers and then stalls the body times out", async () => {
  // Headers arrive at once; the body never does, and this fetch ignores the
  // abort signal, as a misbehaving stand-in might.
  const fetch = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(
    request({ baseUrl: "https://ivana.test/api", fetch, timeoutMs: 100 }, "GET", "/x"),
    { name: "IvanaError", code: "TIMEOUT" },
  );
  assert.ok(Date.now() - started < 2000, "settled promptly");
});

test("a body read that fails after the headers is a network error, not a hang", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("terminated"); } });
  await assert.rejects(
    request({ baseUrl: "https://ivana.test/api", fetch, timeoutMs: 1000 }, "GET", "/x"),
    { code: "NETWORK_ERROR" },
  );
});

test("a fetch that honours the abort signal still reports TIMEOUT", async () => {
  const fetch = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(
    request({ baseUrl: "https://ivana.test/api", fetch, timeoutMs: 50 }, "GET", "/x"),
    { code: "TIMEOUT" },
  );
});

// ── A7: answers that aren't JSON, and codes on validation errors ───────

test("a 200 that isn't JSON is an error, not a silent null", async () => {
  const fetch = async () => new Response("<html>gateway</html>", { status: 200 });
  await assert.rejects(
    request({ baseUrl: "https://ivana.test/api", fetch }, "GET", "/x"),
    { code: "INVALID_RESPONSE", status: 200 },
  );
});

test("an empty success is still null, and a non-JSON error keeps its HTTP status", async () => {
  const empty = async () => new Response("", { status: 200 });
  assert.equal(await request({ baseUrl: "https://ivana.test/api", fetch: empty }, "GET", "/x"), null);
  const bad = async () => new Response("<html>bad gateway</html>", { status: 502 });
  await assert.rejects(request({ baseUrl: "https://ivana.test/api", fetch: bad }, "GET", "/x"), { status: 502 });
});

test("input and configuration errors carry a code", async () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.code;
    }
    return undefined;
  };
  assert.equal(codeOf(() => createIvanaCheckout({})), "INVALID_CONFIG");
  assert.equal(codeOf(() => createIvanaCheckout({ connection: fakeConnection(), baseUrl: "ftp://x" })), "INVALID_CONFIG");
  assert.equal(codeOf(() => createIvanaServer({})), "INVALID_CONFIG");
  assert.equal(codeOf(() => createPayFlow({})), "INVALID_INPUT");
  const { client } = checkout({});
  await assert.rejects(client.pay({ wallet: fakeWallet() }), { code: "INVALID_INPUT" });
  await assert.rejects(client.recoverPayment({}), { code: "INVALID_INPUT" });
  const server = createIvanaServer({ apiKey: "k", fetch: async () => new Response("{}") });
  await assert.rejects(server.createPaymentIntent({ customer: {}, lineItems: [] }), { code: "INVALID_INPUT" });
  assert.ok(new IvanaError("x") instanceof Error);
});

// ── A3: a throwing hook after payment doesn't undo it ───────────────────

function paidFlow(extra = {}) {
  const store = createPendingPaymentStore({ storage: null });
  const checkoutStub = {
    async pay(input) {
      await input.onSignature("sig-1", { blockhash: "b", lastValidBlockHeight: 99 });
      return { signature: "sig-1", verification: { success: true } };
    },
    async recoverPayment() {
      return "completed";
    },
  };
  const wallet = { id: "w", name: "W", installed: true, provider: { connect: async () => ({ publicKey: "Buyer111" }), publicKey: "Buyer111", signTransaction: async (t) => t } };
  return createPayFlow({ checkout: checkoutStub, intentId: "intent-1", store, listWallets: () => [wallet], ...extra });
}

test("an onPaid that throws leaves the verified payment paid, and reports the failure", async () => {
  const hookError = new Error("merchant webhook down");
  const flow = paidFlow({ onPaid: async () => { throw hookError; } });
  const state = await flow.pay("w");
  assert.equal(state.status, "paid");
  assert.equal(state.error, null);
  assert.equal(state.result.signature, "sig-1");
  assert.equal(state.onPaidError, hookError);
});

test("recover() isolates a throwing onPaid the same way", async () => {
  const map = new Map();
  const store = createPendingPaymentStore({ storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) } });
  store.save({ intentId: "intent-1", signature: "sig-9", walletAddress: "Buyer111", paymentMethod: "USDC" });
  const flow = paidFlow({ store, onPaid: () => { throw new Error("hook"); } });
  const state = await flow.recover();
  assert.equal(state.status, "paid");
  assert.equal(state.onPaidError.message, "hook");
});

test("a subscriber that throws neither fails pay() nor hides the outcome from other subscribers", async () => {
  const flow = paidFlow();
  const seen = [];
  const log = console.error;
  console.error = () => {};
  try {
    flow.subscribe(() => { throw new Error("render bug"); });
    flow.subscribe((s) => seen.push(s.status));
    const state = await flow.pay("w");
    assert.equal(state.status, "paid");
  } finally {
    console.error = log;
  }
  assert.equal(seen.at(-1), "paid");
});

// ── A4: only a stale blockhash is retried ───────────────────────────────

test("a wallet simulation failure that isn't about the blockhash is reported at once, not retried", async () => {
  let signs = 0;
  const wallet = fakeWallet({
    signTransaction: async () => {
      signs += 1;
      throw new Error("failed to simulate transaction: insufficient funds for fee");
    },
  });
  const { client } = checkout({ "POST /webthree/build-payment-transaction": built });
  let retries = 0;
  await assert.rejects(client.pay({ intentId: "intent-1", wallet, onRetry: () => { retries += 1; } }), { code: "SEND_FAILED" });
  assert.equal(signs, 1);
  assert.equal(retries, 0);
});

test("a node's simulation failure for another reason is not retried either", async () => {
  let sends = 0;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({ sendRawTransaction: async () => { sends += 1; throw refusal("Transaction simulation failed: Attempt to debit an account but found no record of a prior credit."); } }),
  );
  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), { code: "SEND_FAILED" });
  assert.equal(sends, 1);
});

test("a stale blockhash is still retried with a fresh one, then reported as expired", async () => {
  let sends = 0;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built },
    fakeConnection({ sendRawTransaction: async () => { sends += 1; throw refusal("Transaction simulation failed: Blockhash not found"); } }),
  );
  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), { code: "BLOCKHASH_EXPIRED" });
  assert.equal(sends, 3, "the first send and two retries");
});

// ── A5: a payment attempt that can't be registered ──────────────────────

test("a failed registration says nothing was sent, carries no signature, and never broadcasts", async () => {
  let sent = false;
  const { client } = checkout(
    {
      "POST /webthree/build-payment-transaction": built,
      "POST /webthree/register-payment-attempt": [503, { error: { message: "unavailable" } }],
    },
    fakeConnection({ sendRawTransaction: async () => { sent = true; return SIGNATURE; } }),
  );
  let saved = false;
  await assert.rejects(
    client.pay({ intentId: "intent-1", wallet: fakeWallet(), onSignature: () => { saved = true; } }),
    (error) => {
      assert.equal(error.code, "ATTEMPT_NOT_REGISTERED");
      assert.equal(error.status, 503);
      assert.equal(error.signature, undefined);
      assert.match(error.message, /nothing was sent/);
      return true;
    },
  );
  assert.equal(sent, false);
  assert.equal(saved, false);
});

test("a registration timeout is reported the same way", async () => {
  const fetch = async (url) => {
    if (String(url).endsWith("/register-payment-attempt")) return new Promise(() => {});
    return new Response(JSON.stringify({ orderId: "intent-1", transaction: builtTransactionBase64() }), { status: 200 });
  };
  const client = createIvanaCheckout({ connection: fakeConnection(), fetch, Transaction, timeoutMs: 50 });
  await assert.rejects(client.pay({ intentId: "intent-1", wallet: fakeWallet() }), { code: "ATTEMPT_NOT_REGISTERED" });
});

test("an onSignature that throws stops before the broadcast, with the same code", async () => {
  let sent = false;
  const { client } = checkout(
    { "POST /webthree/build-payment-transaction": built, "POST /webthree/verify-payment": verified },
    fakeConnection({ sendRawTransaction: async () => { sent = true; return SIGNATURE; } }),
  );
  await assert.rejects(
    client.pay({ intentId: "intent-1", wallet: fakeWallet(), onSignature: () => { throw new Error("storage full"); } }),
    { code: "ATTEMPT_NOT_REGISTERED" },
  );
  assert.equal(sent, false);
});

test("the pay flow shows an unregistered attempt as an error the buyer can retry", async () => {
  const checkoutStub = {
    async pay() {
      throw new IvanaError("The payment attempt could not be registered, so nothing was sent: x", { code: "ATTEMPT_NOT_REGISTERED" });
    },
    async recoverPayment() {
      return "pending";
    },
  };
  const wallet = { id: "w", name: "W", installed: true, provider: { connect: async () => ({ publicKey: "Buyer111" }), publicKey: "Buyer111", signTransaction: async (t) => t } };
  const flow = createPayFlow({ checkout: checkoutStub, intentId: "intent-1", store: createPendingPaymentStore({ storage: null }), listWallets: () => [wallet] });
  const state = await flow.pay("w");
  assert.equal(state.status, "error");
  assert.equal(state.error.code, "ATTEMPT_NOT_REGISTERED");
  assert.match(state.error.message, /nothing was sent/);
});
