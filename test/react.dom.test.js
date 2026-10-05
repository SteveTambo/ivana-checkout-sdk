// The React bindings rendered in a DOM: every pay-button state, recovery of a
// payment interrupted by a reload, and the Solana Pay QR's outcomes.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IvanaPayButton, SolanaPayQR } from "../src/react.js";

let dom;
let root;
let container;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

beforeEach(() => {
  dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://shop.example/checkout" });
  define("window", dom.window);
  define("document", dom.window.document);
  define("navigator", dom.window.navigator);
  define("sessionStorage", dom.window.sessionStorage);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.getElementById("root");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
});

const render = (element) => act(async () => root.render(element));
const text = () => container.textContent;
const click = (label) => act(async () => {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  assert.ok(el, `no "${label}" button in: ${text()}`);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});
const SIG = "5igNaTuRe1111111111111111111111111111111111111111";

function phantom() {
  return { isPhantom: true, publicKey: { toBase58: () => "Buyer111" }, connect: async () => ({}), signTransaction: async (tx) => tx };
}

test("pay with an installed wallet: choose, confirm, paid", async () => {
  dom.window.phantom = { solana: phantom() };
  let finish;
  const paid = [];
  const checkout = {
    recoverPayment: async () => "pending",
    pay: ({ onSignature }) => new Promise((resolve) => { finish = () => { onSignature(SIG, { lastValidBlockHeight: 9 }); resolve({ signature: SIG, verification: { success: true } }); }; }),
  };
  await render(createElement(IvanaPayButton, { intentId: "i-1", checkout, onPaid: (r) => paid.push(r) }));
  await click("Pay with USDC");
  assert.match(text(), /Solflare/);
  assert.ok(container.querySelector('a[target="_blank"]'), "an uninstalled wallet offers a download on desktop");
  await click("Phantom");
  assert.match(text(), /Confirm in your wallet/);
  await act(async () => finish());
  assert.match(text(), /^Paid\. Transaction 5igNaT…111111\.$/);
  assert.equal(paid[0].signature, SIG);
});

test("cancelling the wallet picker returns to the pay button", async () => {
  await render(createElement(IvanaPayButton, { intentId: "i-1", checkout: { recoverPayment: async () => "pending", pay: async () => ({}) } }));
  await click("Pay with USDC");
  await click("Cancel");
  assert.match(text(), /Pay with USDC/);
});

test("a refused payment shows why and offers to pay again", async () => {
  dom.window.phantom = { solana: phantom() };
  const checkout = { recoverPayment: async () => "pending", pay: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } };
  await render(createElement(IvanaPayButton, { intentId: "i-1", checkout }));
  await click("Pay with USDC");
  await click("Phantom");
  assert.ok(container.querySelector('[role="alert"]'));
  assert.match(text(), /Pay with USDC/);
});

test("after a reload, a payment still confirming blocks paying again until it resolves", async () => {
  sessionStorage.setItem("ivana:pending:i-1", JSON.stringify({ intentId: "i-1", signature: SIG, walletAddress: "Buyer111", paymentMethod: "USDC" }));
  const outcomes = ["pending", "completed"];
  const checkout = { recoverPayment: async () => outcomes.shift(), pay: async () => assert.fail("must not pay twice") };
  await render(createElement(IvanaPayButton, { intentId: "i-1", checkout }));
  assert.match(text(), /was sent and is still confirming\. Don't pay again\./);
  await click("Check again");
  assert.match(text(), /^Paid\./);
  assert.equal(sessionStorage.getItem("ivana:pending:i-1"), null);
});

test("on a phone without a wallet installed, the picker offers 'Open in' links", async () => {
  define("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 });
  await render(createElement(IvanaPayButton, { intentId: "i-1", checkout: { recoverPayment: async () => "pending", pay: async () => ({}) }, href: "https://shop.example/checkout" }));
  await click("Pay with USDC");
  const links = [...container.querySelectorAll("a")].map((a) => a.textContent);
  assert.deepEqual(links, ["Open in Phantom", "Open in Solflare"]);
});

test("the Solana Pay QR shows the link, then the payment", async () => {
  let finish;
  const checkout = {
    solanaPayUrl: (intentId, method) => `solana:https://ivana.example/pay/${intentId}?m=${method}`,
    waitForSolanaPayment: () => new Promise((resolve) => { finish = resolve; }),
  };
  await render(createElement(SolanaPayQR, { intentId: "i-2", checkout, renderQr: (url) => createElement("img", { alt: url }) }));
  assert.equal(container.querySelector("img").alt, "solana:https://ivana.example/pay/i-2?m=USDC");
  assert.match(text(), /Waiting for payment/);
  await act(async () => finish({ signature: SIG }));
  assert.match(text(), /^Paid\. Transaction/);
});

test("the Solana Pay QR reports a timeout, and works without a QR renderer", async () => {
  const checkout = {
    solanaPayUrl: () => "solana:x",
    waitForSolanaPayment: async () => { throw Object.assign(new Error("No payment arrived in time."), { code: "TIMEOUT" }); },
  };
  await render(createElement(SolanaPayQR, { intentId: "i-3", checkout }));
  assert.equal(container.querySelector('[role="alert"]').textContent, "No payment arrived in time.");

  const silent = { solanaPayUrl: () => "solana:x", waitForSolanaPayment: async () => { throw {}; } };
  await render(createElement(SolanaPayQR, { intentId: "i-4", checkout: silent }));
  assert.equal(container.querySelector('[role="alert"]').textContent, "The payment didn't go through.");
});
