// Minimal merchant backend: prices the order from its own catalogue,
// creates an IVANA payment intent, and returns only the intentId to the
// browser. Run with: IVANA_API_KEY=... node examples/server.mjs

import http from "node:http";
import { createIvanaServer } from "@habix/ivana-checkout/server";

const ivana = createIvanaServer({ apiKey: process.env.IVANA_API_KEY });

// Prices come from your catalogue, never from the buyer's request.
const CATALOGUE = { coffee: { title: "Iced coffee", unitPriceUsdc: 3.5 } };

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/checkout") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { productId, quantity, name, email } = JSON.parse(body || "{}");
    const product = CATALOGUE[productId];
    if (!product) {
      res.writeHead(400).end(JSON.stringify({ error: "Unknown product" }));
      return;
    }

    try {
      const intent = await ivana.createPaymentIntent({
        customer: { name, email },
        lineItems: [{ ...product, quantity: Number(quantity) || 1 }],
        merchantReference: `demo:${Date.now()}`,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ intentId: intent.intentId, total: intent.breakdown.total }));
    } catch (error) {
      res.writeHead(error.status || 500).end(JSON.stringify({ error: error.message }));
    }
  })
  .listen(3000, () => console.log("Merchant backend on http://localhost:3000"));

// Fulfil from the settlement feed: persist each event id before acting on
// it, then acknowledge. Unacknowledged events replay after a crash.
async function fulfilSettledPayments(cursor) {
  const page = await ivana.listSettlementEvents({ after: cursor });
  for (const event of page.events) {
    console.log("Settled:", event.merchantReference, event.signature);
    await ivana.acknowledgeSettlementEvent(event.id);
  }
  return page.nextCursor;
}
void fulfilSettledPayments;
