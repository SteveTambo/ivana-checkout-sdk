// The pending-payment record must never break checkout: disabled, full or
// corrupt storage reads as "nothing pending" and writes are dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingPaymentStore } from "../src/pending.js";

const payment = { intentId: "i-1", signature: "sig-1", walletAddress: "w", paymentMethod: "USDC" };
const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };

test("broken storage reads as nothing pending and never throws", () => {
  const store = createPendingPaymentStore({ storage: throwing });
  assert.doesNotThrow(() => store.save(payment));
  assert.equal(store.get("i-1"), null);
  assert.doesNotThrow(() => store.clear("i-1"));
  assert.equal(createPendingPaymentStore({ storage: { getItem: () => "{not json" } }).get("i-1"), null);
  const none = createPendingPaymentStore({ storage: null });
  none.save(payment);
  assert.equal(none.get("i-1"), null);
});

test("clearing with a signature keeps a newer payment's record", () => {
  const map = new Map();
  const store = createPendingPaymentStore({ storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }, prefix: "t:" });
  store.save(payment);
  assert.ok(store.get("i-1").savedAt);
  store.clear("i-1", "older-sig");
  assert.equal(store.get("i-1").signature, "sig-1");
  store.clear("i-1", "sig-1");
  assert.equal(store.get("i-1"), null);
});

test("without an explicit storage it uses sessionStorage, and survives a browser that throws on access", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  try {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    const store = createPendingPaymentStore();
    store.save(payment);
    assert.equal(store.get("i-1"), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else delete globalThis.sessionStorage;
  }
});
