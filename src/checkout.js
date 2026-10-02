/**
 * Browser checkout client. Everything here is safe to ship to buyers: the
 * only credential it uses is the intentId your backend created.
 *
 * Payment is non-custodial. IVANA builds the transaction (merchant, VAT,
 * platform fee and supplier legs), the buyer's own wallet signs and
 * broadcasts it, and IVANA verifies the confirmed on-chain balance changes.
 * Neither IVANA nor this SDK can move the buyer's funds.
 */

import { IvanaError, normalizeBaseUrl, request } from "./http.js";

export { IvanaError } from "./http.js";

const MAX_BLOCKHASH_RETRIES = 2;
const STATUS_POLL_ATTEMPTS = 3;
const STATUS_POLL_DELAY_MS = 800;
const RPC_CONFIRMATION_TIMEOUT_MS = 8000;
const VERIFY_RETRY_DELAYS_MS = [400, 800, 1600];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBlockhashExpired(error) {
  return /blockhash not found|block height exceeded|failed to simulate|simulation failed/i.test(
    error?.message || "",
  );
}

function onChainFailure(err) {
  return new IvanaError("The Solana transaction failed on chain. No payment was made.", {
    code: "SOLANA_TRANSACTION_FAILED",
    details: err,
  });
}

/** @param {string} base64 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {{ publicKey?: unknown }} wallet */
function walletAddressOf(wallet) {
  const key = wallet?.publicKey;
  const address = typeof key === "string" ? key : key?.toBase58?.() ?? key?.toString?.();
  if (!address) throw new IvanaError("Connect a wallet before paying.", { code: "WALLET_NOT_CONNECTED" });
  return address;
}

// A confirmation timeout is ambiguous: the payment may still land. Check the
// signature status before reporting anything, and hand unknown outcomes to
// IVANA's verification instead of inviting the buyer to pay twice.
async function confirmSignature(connection, signature, latestBlockhash) {
  let timeoutId;
  try {
    const confirmation = await Promise.race([
      connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed"),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(Object.assign(new Error("RPC confirmation timed out."), { code: "RPC_TIMEOUT" })),
          RPC_CONFIRMATION_TIMEOUT_MS,
        );
      }),
    ]);
    if (!confirmation?.value) throw new Error("The RPC returned no confirmation status.");
    if (confirmation.value.err) throw onChainFailure(confirmation.value.err);
    return true;
  } catch (error) {
    if (error?.code === "SOLANA_TRANSACTION_FAILED") throw error;
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
      try {
        const status = (await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        }))?.value?.[0];
        if (status?.err) throw onChainFailure(status.err);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          return true;
        }
      } catch (statusError) {
        if (statusError?.code === "SOLANA_TRANSACTION_FAILED") throw statusError;
      }
      if (attempt + 1 < STATUS_POLL_ATTEMPTS) await delay(STATUS_POLL_DELAY_MS);
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {{ connection: import("@solana/web3.js").Connection, baseUrl?: string, fetch?: typeof fetch, timeoutMs?: number, Transaction?: typeof import("@solana/web3.js").Transaction }} options
 */
export function createIvanaCheckout({ connection, baseUrl, fetch: fetchImpl, timeoutMs, Transaction }) {
  if (!connection) {
    throw new IvanaError("createIvanaCheckout needs a @solana/web3.js Connection to broadcast with.");
  }
  const client = {
    baseUrl: normalizeBaseUrl(baseUrl),
    fetch: fetchImpl || globalThis.fetch?.bind(globalThis),
    timeoutMs,
  };
  if (typeof client.fetch !== "function") {
    throw new IvanaError("No fetch implementation found. Pass one as options.fetch.");
  }
  const loadTransaction = async () => Transaction || (await import("@solana/web3.js")).Transaction;

  /** @param {{ intentId: string, signature: string, walletAddress: string, paymentMethod: string }} payload */
  async function verifyPayment(payload) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(client, "POST", "/webthree/verify-payment", payload);
      } catch (error) {
        // Only RPC indexing lag is retried; every other verification answer is final.
        const wait = VERIFY_RETRY_DELAYS_MS[attempt];
        if (error?.code !== "TRANSACTION_NOT_FOUND" || wait === undefined) throw error;
        await delay(wait);
      }
    }
  }

  return {
    /**
     * Buyer-safe view of an intent, for showing the amount before payment.
     * @param {string} intentId
     */
    getPaymentIntent(intentId) {
      return request(client, "GET", `/webthree/payment-intents/${encodeURIComponent(intentId)}`);
    },

    /**
     * Optional pre-check before asking the buyer to sign. IVANA screens the
     * wallet again when building and verifying, so this is for UX only.
     * @param {{ intentId: string, walletAddress: string }} input
     * @returns {Promise<{ eligible: boolean, unavailable: boolean }>}
     */
    checkEligibility({ intentId, walletAddress }) {
      const query = new URLSearchParams({ intentId, wallet: walletAddress });
      return request(client, "GET", `/webthree/check-aml-eligibility?${query}`);
    },

    /**
     * Run the whole buyer-paid checkout for one intent: build, sign with the
     * buyer's wallet, broadcast, confirm and verify.
     *
     * Save `signature` (onSignature fires as soon as it exists). If the page
     * closes before verification, call verifyPayment with it later instead of
     * paying again.
     *
     * @param {{ intentId: string, wallet: { publicKey: unknown, signTransaction: (tx: any) => Promise<any> }, paymentMethod?: "USDC"|"USDT"|"HBX", onSignature?: (signature: string) => void, onRetry?: () => void }} input
     * @returns {Promise<{ signature: string, verification: Record<string, unknown> }>}
     */
    async pay({ intentId, wallet, paymentMethod = "USDC", onSignature, onRetry }) {
      if (!intentId) throw new IvanaError("pay needs the intentId from your backend.");
      if (typeof wallet?.signTransaction !== "function") {
        throw new IvanaError("The wallet must support signTransaction.", { code: "WALLET_NOT_CONNECTED" });
      }
      const walletAddress = walletAddressOf(wallet);

      const built = await request(client, "POST", "/webthree/build-payment-transaction", {
        intentId,
        walletAddress,
        paymentMethod,
        feeMode: "buyer",
      });
      const TransactionClass = await loadTransaction();

      for (let attempt = 0; ; attempt += 1) {
        const transaction = TransactionClass.from(base64ToBytes(built.transaction));
        // Refresh from the broadcasting RPC just before approval, so preflight
        // sees the same recent blockhash. The payment legs never change.
        const latestBlockhash = await connection.getLatestBlockhash("confirmed");
        transaction.recentBlockhash = latestBlockhash.blockhash;

        let signature;
        try {
          const signed = await wallet.signTransaction(transaction);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } catch (error) {
          if (isBlockhashExpired(error) && attempt < MAX_BLOCKHASH_RETRIES) {
            onRetry?.();
            continue;
          }
          if (error?.code === 4001) {
            throw new IvanaError("The buyer cancelled the transaction.", { code: "USER_REJECTED", cause: error });
          }
          throw new IvanaError(error?.message || "Could not sign or send the transaction.", {
            code: isBlockhashExpired(error) ? "BLOCKHASH_EXPIRED" : "SEND_FAILED",
            cause: error,
          });
        }

        onSignature?.(signature);
        await confirmSignature(connection, signature, latestBlockhash);
        try {
          const verification = await verifyPayment({ intentId, signature, walletAddress, paymentMethod });
          return { signature, verification };
        } catch (error) {
          // The payment was broadcast, so it may still settle. Carry the
          // signature so the caller can retry verification, never re-pay.
          const pending = new IvanaError(
            error?.code === "TRANSACTION_NOT_FOUND"
              ? "The payment was sent but is not visible on chain yet. Verify it again shortly; do not pay again."
              : error?.message || "The payment was sent but could not be verified yet.",
            { status: error?.status, code: error?.code || "VERIFY_FAILED", details: error?.details, cause: error },
          );
          pending.signature = signature;
          throw pending;
        }
      }
    },

    /**
     * Settle a payment whose signature you saved, e.g. after the buyer
     * closed the tab mid-checkout. Safe to call more than once.
     */
    verifyPayment,
  };
}
