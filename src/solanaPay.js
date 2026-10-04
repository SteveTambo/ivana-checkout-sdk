/**
 * Solana Pay: let a buyer pay an intent by scanning a QR code with Phantom
 * or any Solana Pay wallet, for in-person sales (a stall, an event door).
 *
 * The QR encodes a transaction request on IVANA. The wallet fetches the
 * buyer-paid transaction (the same legs, memo and AML screening as browser
 * checkout), signs and broadcasts it itself. The transaction carries a
 * reference key derived from the intent, which `checkout.waitForSolanaPayment`
 * watches for, then verifies with IVANA. If no screen is watching, IVANA's
 * reconciler settles the payment anyway.
 *
 * One QR per intent: IVANA builds a payment for an intent once, so a buyer
 * who declines in the wallet needs a fresh intent and QR.
 */

import { base58Encode } from "./base58.js";
import { DEFAULT_BASE_URL } from "./http.js";

const REFERENCE_DOMAIN = "ivana:solana-pay:v1:";

/**
 * The reference key IVANA puts on the merchant transfer for this intent
 * (sha256 of a fixed domain and the intent id), as a base58 address.
 * @param {string} intentId
 * @returns {Promise<string>}
 */
export async function solanaPayReference(intentId) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("solanaPayReference needs Web Crypto (crypto.subtle).");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`${REFERENCE_DOMAIN}${intentId}`));
  return base58Encode(new Uint8Array(digest));
}

/**
 * The `solana:` URL to put in the QR code (or behind a link on mobile).
 * @param {{ intentId: string, paymentMethod?: "USDC"|"USDT"|"HBX", baseUrl?: string }} options
 */
export function solanaPayUrl({ intentId, paymentMethod = "USDC", baseUrl = DEFAULT_BASE_URL }) {
  if (!intentId) throw new Error("solanaPayUrl needs an intentId.");
  const link = `${baseUrl.replace(/\/+$/, "")}/webthree/solana-pay/${encodeURIComponent(intentId)}?method=${encodeURIComponent(paymentMethod)}`;
  // The spec requires a link with a query string to be URL-encoded.
  return `solana:${encodeURIComponent(link)}`;
}
