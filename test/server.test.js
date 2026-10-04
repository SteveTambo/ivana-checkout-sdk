import { test } from "node:test";
import assert from "node:assert/strict";
import { createIvanaServer } from "../src/server.js";
import { fakeFetch } from "./helpers.js";

const intent = {
  intentId: "intent-1",
  contractVersion: 2,
  breakdown: { netAmount: 10, vatAmount: 1.6, transactionFee: 0.16, total: 11.76, currency: "USDC", supplierAmounts: [] },
};

test("createPaymentIntent sends the tenant key server-to-server and returns the intent", async () => {
  const { fetch, calls } = fakeFetch({ "POST /webthree/payment-intents": [201, intent] });
  const ivana = createIvanaServer({ apiKey: "tenant-key", fetch });
  const input = {
    customer: { name: "Ada", email: "ada@example.com" },
    lineItems: [{ title: "Coffee", unitPriceUsdc: 5, quantity: 2 }],
    merchantReference: "order-42",
    idempotencyKey: "order-42-attempt-1",
  };

  const result = await ivana.createPaymentIntent(input);

  assert.equal(result.intentId, "intent-1");
  assert.equal(calls[0].headers["x-tenant-api-key"], "tenant-key");
  assert.deepEqual(calls[0].body, input);
});

test("createPaymentIntent rejects incomplete input before calling IVANA", async () => {
  const { fetch, calls } = fakeFetch({});
  const ivana = createIvanaServer({ apiKey: "k", fetch });
  await assert.rejects(ivana.createPaymentIntent({ customer: { name: "A" }, lineItems: [{}] }), /customer.name and customer.email/);
  await assert.rejects(ivana.createPaymentIntent({ customer: { name: "A", email: "a@b.c" }, lineItems: [] }), /lineItems/);
  assert.equal(calls.length, 0);
});

test("IVANA errors become IvanaError with status and message", async () => {
  const { fetch } = fakeFetch({ "POST /webthree/payment-intents": [400, { error: { message: "Every line item needs a title." } }] });
  const ivana = createIvanaServer({ apiKey: "k", fetch });
  await assert.rejects(
    ivana.createPaymentIntent({ customer: { name: "A", email: "a@b.c" }, lineItems: [{ unitPriceUsdc: 1, quantity: 1 }] }),
    { name: "IvanaError", status: 400, message: "Every line item needs a title." },
  );
});

test("settlement events page with a cursor and acknowledge by id", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /webthree/settlement-events": [200, { events: [{ id: "e1", cursor: "c1" }], nextCursor: "c1", hasMore: false }],
    "POST /webthree/settlement-events/e1/ack": [200, { acknowledged: true }],
  });
  const ivana = createIvanaServer({ apiKey: "k", fetch });

  const page = await ivana.listSettlementEvents({ after: "c0", limit: 50 });
  await ivana.acknowledgeSettlementEvent("e1");

  assert.equal(page.events[0].id, "e1");
  assert.equal(calls[0].path, "/webthree/settlement-events?after=c0&limit=50");
  assert.equal(calls[1].key, "POST /webthree/settlement-events/e1/ack");
});

test("the server client refuses to run in a browser, where the key would leak", () => {
  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.throws(() => createIvanaServer({ apiKey: "k", fetch: async () => {} }), /backend only/);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("a missing API key fails fast", () => {
  assert.throws(() => createIvanaServer({ fetch: async () => {} }), /apiKey/);
});

test("getPaymentSettlement reads the tenant-authenticated receipt", async () => {
  const receipt = { intentId: "intent 1", status: "completed", walletAddress: "w", signature: "s" };
  const { fetch, calls } = fakeFetch({ "GET /webthree/payment-intents/intent%201/settlement": [200, receipt] });
  const ivana = createIvanaServer({ apiKey: "tenant-key", fetch });
  assert.deepEqual(await ivana.getPaymentSettlement("intent 1"), receipt);
  assert.equal(calls[0].headers["x-tenant-api-key"], "tenant-key");
  await assert.rejects(ivana.getPaymentSettlement(""), /intentId is required/);
});

test("getTenant asks for payment setup only when requested", async () => {
  const { fetch, calls } = fakeFetch({ "GET /tenants/me": [200, { tenant: { id: 1, slug: "shop" } }] });
  const ivana = createIvanaServer({ apiKey: "k", fetch });
  await ivana.getTenant();
  await ivana.getTenant({ includePaymentSetup: true });
  assert.equal(calls[0].path, "/tenants/me");
  assert.equal(calls[1].path, "/tenants/me?include=paymentSetup");
});
