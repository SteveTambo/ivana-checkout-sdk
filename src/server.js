/**
 * Server-side client. Holds the tenant API key, so it must only run on the
 * merchant's backend: the key authorises creating payment intents and
 * reading the tenant's settlement events.
 */

import { IvanaError, normalizeBaseUrl, request } from "./http.js";

export { IvanaError } from "./http.js";

/**
 * @typedef {object} LineItem
 * @property {string} title
 * @property {number|string} unitPriceUsdc Net price per unit, before VAT and the platform fee.
 * @property {number} quantity
 * @property {"donation"} [type] Donations always settle to the merchant in full.
 * @property {boolean} [isConsignment] Pay part of this line to a supplier.
 * @property {string} [supplierWallet] The supplier's Solana address, for consignment lines.
 */

/**
 * @typedef {object} PaymentIntent
 * @property {string} intentId Hand this to the buyer's browser; it is the only credential checkout needs.
 * @property {number} contractVersion
 * @property {string} expiresAt
 * @property {LineItem[]} lineItems
 * @property {string|null} merchantReference
 * @property {{ netAmount: number, vatAmount: number, transactionFee: number, total: number, currency: "USDC", supplierAmounts: Array<{ supplierWallet: string, amount: number }> }} breakdown
 */

/**
 * @param {{ apiKey: string, baseUrl?: string, fetch?: typeof fetch, timeoutMs?: number, allowBrowser?: boolean }} options
 */
export function createIvanaServer({ apiKey, baseUrl, fetch: fetchImpl, timeoutMs, allowBrowser = false }) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new IvanaError("createIvanaServer needs your tenant apiKey.");
  }
  if (!allowBrowser && typeof window !== "undefined" && typeof document !== "undefined") {
    throw new IvanaError(
      "createIvanaServer runs on your backend only. Shipping the tenant API key to a browser exposes it; use createIvanaCheckout in the browser.",
    );
  }
  const client = {
    baseUrl: normalizeBaseUrl(baseUrl),
    fetch: fetchImpl || globalThis.fetch,
    headers: { "x-tenant-api-key": apiKey },
    timeoutMs,
  };
  if (typeof client.fetch !== "function") {
    throw new IvanaError("No fetch implementation found. Pass one as options.fetch.");
  }

  return {
    /**
     * Price an order and open a payment intent. IVANA computes VAT, the
     * platform fee and any supplier split from these line items, so send
     * prices from your own catalogue, never from the buyer's browser.
     *
     * @param {{ customer: { name: string, email: string } & Record<string, unknown>, lineItems: LineItem[], merchantReference?: string, idempotencyKey?: string, walletAddress?: string, paymentMethod?: "USDC"|"USDT"|"HBX" }} input
     * @returns {Promise<PaymentIntent>}
     */
    createPaymentIntent(input) {
      if (!input?.customer?.name || !input?.customer?.email) {
        return Promise.reject(new IvanaError("customer.name and customer.email are required."));
      }
      if (!Array.isArray(input.lineItems) || input.lineItems.length === 0) {
        return Promise.reject(new IvanaError("lineItems must be a non-empty array."));
      }
      return request(client, "POST", "/webthree/payment-intents", input);
    },

    /**
     * Read settled payments in order, for fulfilment. Persist each event id
     * before acting on it, then acknowledge it; the feed replays anything
     * not yet acknowledged, so a crash never loses a payment.
     *
     * @param {{ after?: string, limit?: number }} [options]
     * @returns {Promise<{ events: Array<{ id: string, cursor: string, createdAt: string } & Record<string, unknown>>, nextCursor: string|null, hasMore: boolean }>}
     */
    listSettlementEvents({ after, limit } = {}) {
      const params = new URLSearchParams();
      if (after) params.set("after", after);
      if (limit) params.set("limit", String(limit));
      const query = params.toString();
      return request(client, "GET", `/webthree/settlement-events${query ? `?${query}` : ""}`);
    },

    /** @param {string} eventId @returns {Promise<{ acknowledged: true }>} */
    acknowledgeSettlementEvent(eventId) {
      return request(client, "POST", `/webthree/settlement-events/${encodeURIComponent(eventId)}/ack`);
    },

    /** Unacknowledged settlements and stuck intents older than ten minutes. */
    settlementHealth() {
      return request(client, "GET", "/webthree/settlement-health");
    },
  };
}
