import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { IvanaPayButton } from "../src/react.js";

const checkout = { pay: async () => ({}), recoverPayment: async () => "pending" };

test("IvanaPayButton renders an accessible pay button with no wallet code running on the server", () => {
  const html = renderToString(createElement(IvanaPayButton, { intentId: "intent-1", checkout, paymentMethod: "HBX", className: "mine" }));
  assert.match(html, /class="ivana-pay mine"/);
  assert.match(html, /<button type="button" class="ivana-pay__button">Pay with HBX<\/button>/);
});

test("a custom label replaces the default text", () => {
  const html = renderToString(createElement(IvanaPayButton, { intentId: "intent-1", checkout, label: "Buy ticket" }));
  assert.match(html, />Buy ticket</);
});
