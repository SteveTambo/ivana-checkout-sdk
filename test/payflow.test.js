import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectWallet,
  createPayFlow,
  createPendingPaymentStore,
  isMobileBrowser,
  listWallets,
  phantomBrowseUrl,
  solflareBrowseUrl,
} from "../src/checkout.js";
import { BUYER } from "./helpers.js";

const PAGE = "https://shop.example/checkout?cart=1";
const desktop = { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 };
const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 };

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), map };
}

test("wallet discovery: installed providers on desktop, browse deeplinks on mobile", () => {
  const phantom = { isPhantom: true };
  const desktopList = listWallets({ href: PAGE, window: { phantom: { solana: phantom } }, navigator: desktop });
  assert.equal(desktopList[0].installed, true);
  assert.equal(desktopList[0].provider, phantom);
  assert.equal(desktopList[1].installed, false);
  assert.equal(desktopList[1].openInAppUrl, null, "desktop gets a download link, not a deeplink");

  const mobileList = listWallets({ href: PAGE, window: {}, navigator: iphone });
  assert.equal(mobileList[0].openInAppUrl, phantomBrowseUrl(PAGE));
  assert.equal(mobileList[1].openInAppUrl, solflareBrowseUrl(PAGE));
  assert.equal(
    phantomBrowseUrl(PAGE),
    `https://phantom.app/ul/browse/${encodeURIComponent(PAGE)}?ref=${encodeURIComponent("https://shop.example")}`,
  );
  assert.match(solflareBrowseUrl(PAGE), /^https:\/\/solflare\.com\/ul\/v1\/browse\//);
});

test("iPadOS counts as mobile even with a Mac user agent", () => {
  assert.equal(isMobileBrowser({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowser({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 }), false);
});

test("connectWallet connects once and signs through the provider itself", async () => {
  const provider = {
    publicKey: null,
    connected: 0,
    async connect() { this.connected += 1; this.publicKey = BUYER; return { publicKey: BUYER }; },
    async signTransaction(tx) { assert.equal(this, provider, "called on the provider"); return tx; },
  };
  const wallet = await connectWallet(provider);
  assert.equal(wallet.publicKey, BUYER);
  assert.equal(await wallet.signTransaction("tx"), "tx");
  await connectWallet(provider);
  assert.equal(provider.connected, 1);
  await assert.rejects(connectWallet(null), { code: "WALLET_NOT_CONNECTED" });
});

test("the pending store keeps one record per intent and clears only the matching signature", () => {
  const store = createPendingPaymentStore({ storage: memoryStorage() });
  store.save({ intentId: "i1", signature: "s1", walletAddress: "w", paymentMethod: "USDC" });
  assert.equal(store.get("i1").signature, "s1");
  assert.ok(store.get("i1").savedAt);
  store.clear("i1", "other");
  assert.equal(store.get("i1").signature, "s1");
  store.clear("i1", "s1");
  assert.equal(store.get("i1"), null);
  const disabled = createPendingPaymentStore({ storage: null });
  disabled.save({ intentId: "i1", signature: "s1" });
  assert.equal(disabled.get("i1"), null);
});

// A checkout stub for the flow: `pay` calls back like the real one.
function fakeCheckout({ pay, recover } = {}) {
  const calls = [];
  return {
    calls,
    async pay(input) {
      calls.push(input);
      return pay ? pay(input) : (await input.onSignature("sig-1", { blockhash: "b", lastValidBlockHeight: 99 }), { signature: "sig-1", verification: { success: true } });
    },
    async recoverPayment(saved) {
      calls.push({ recover: saved });
      return recover ? recover(saved) : "pending";
    },
  };
}
const phantomProvider = () => ({ publicKey: BUYER, async connect() {}, async signTransaction(tx) { return tx; } });
const wallets = () => [{ id: "phantom", name: "Phantom", provider: phantomProvider(), installed: true, openInAppUrl: null, downloadUrl: "" }];

test("pay: choose a wallet, save the signature before broadcast, then clear it when paid", async () => {
  const storage = memoryStorage();
  const store = createPendingPaymentStore({ storage });
  let savedDuringPay;
  const checkout = fakeCheckout({
    pay: async (input) => {
      await input.onSignature("sig-1", { blockhash: "b", lastValidBlockHeight: 99 });
      savedDuringPay = store.get("intent-1");
      return { signature: "sig-1", verification: { success: true } };
    },
  });
  const paid = [];
  const flow = createPayFlow({ checkout, intentId: "intent-1", paymentMethod: "HBX", store, listWallets: wallets, onPaid: (r) => paid.push(r) });
  const seen = [];
  flow.subscribe((s) => seen.push(s.status));

  flow.choose();
  assert.equal(flow.getState().wallets[0].id, "phantom");
  await flow.pay("phantom");

  assert.deepEqual(savedDuringPay, { intentId: "intent-1", signature: "sig-1", walletAddress: BUYER.toBase58(), paymentMethod: "HBX", lastValidBlockHeight: 99, savedAt: savedDuringPay.savedAt });
  assert.equal(flow.getState().status, "paid");
  assert.equal(store.get("intent-1"), null);
  assert.equal(paid.length, 1);
  assert.deepEqual(seen.filter((s, i) => s !== seen[i - 1]), ["choosing", "paying", "paid"]);
});

test("a payment that may have been broadcast stays pending and can't be paid again", async () => {
  const checkout = fakeCheckout({
    pay: async (input) => {
      await input.onSignature("sig-2", { lastValidBlockHeight: 5 });
      throw Object.assign(new Error("not visible yet"), { code: "TRANSACTION_NOT_FOUND", signature: "sig-2" });
    },
  });
  const store = createPendingPaymentStore({ storage: memoryStorage() });
  const flow = createPayFlow({ checkout, intentId: "intent-2", store, listWallets: wallets });
  await flow.pay("phantom");
  assert.equal(flow.getState().status, "pending");
  assert.equal(store.get("intent-2").signature, "sig-2");
  await flow.pay("phantom");
  assert.equal(checkout.calls.length, 1, "no second payment while pending");
  assert.equal(flow.choose().status, "pending");
});

test("a cancelled wallet prompt is an error the buyer can retry, and nothing is saved", async () => {
  const checkout = fakeCheckout({ pay: async () => { throw Object.assign(new Error("User rejected"), { code: "USER_REJECTED" }); } });
  const store = createPendingPaymentStore({ storage: memoryStorage() });
  const flow = createPayFlow({ checkout, intentId: "intent-3", store, listWallets: wallets });
  await flow.pay("phantom");
  assert.equal(flow.getState().status, "error");
  assert.equal(flow.getState().error.code, "USER_REJECTED");
  assert.match(flow.getState().error.message, /Nothing was paid/);
  assert.equal(store.get("intent-3"), null);
  assert.equal(flow.cancel().status, "idle");
});

test("a node refusal drops the saved signature through onRejected", async () => {
  const store = createPendingPaymentStore({ storage: memoryStorage() });
  const checkout = fakeCheckout({
    pay: async (input) => {
      await input.onSignature("sig-4", { lastValidBlockHeight: 1 });
      input.onRejected();
      throw Object.assign(new Error("refused"), { code: "SEND_FAILED" });
    },
  });
  const flow = createPayFlow({ checkout, intentId: "intent-4", store, listWallets: wallets });
  await flow.pay("phantom");
  assert.equal(store.get("intent-4"), null);
  assert.equal(flow.getState().status, "error");
});

test("recover: a completed earlier payment is paid; an expired one frees the buyer to pay again", async () => {
  const storage = memoryStorage();
  const store = createPendingPaymentStore({ storage });
  store.save({ intentId: "i5", signature: "old", walletAddress: "w", paymentMethod: "USDC" });
  const paid = [];
  const done = createPayFlow({ checkout: fakeCheckout({ recover: () => "completed" }), intentId: "i5", store, onPaid: (r) => paid.push(r) });
  assert.equal((await done.recover()).status, "paid");
  assert.equal(paid[0].signature, "old");
  assert.equal(store.get("i5"), null);

  store.save({ intentId: "i6", signature: "old", walletAddress: "w", paymentMethod: "USDC" });
  const expired = createPayFlow({ checkout: fakeCheckout({ recover: () => "expired" }), intentId: "i6", store });
  assert.equal((await expired.recover()).status, "idle");
  assert.equal(store.get("i6"), null);

  store.save({ intentId: "i7", signature: "old", walletAddress: "w", paymentMethod: "USDC" });
  const unknown = createPayFlow({ checkout: fakeCheckout({ recover: () => "unavailable" }), intentId: "i7", store });
  assert.equal((await unknown.recover()).status, "pending");
  assert.equal(store.get("i7").signature, "old", "kept until the outcome is known");

  const none = createPayFlow({ checkout: fakeCheckout(), intentId: "i8", store });
  assert.equal((await none.recover()).status, "idle");
});
