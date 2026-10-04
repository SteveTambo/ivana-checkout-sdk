/**
 * Browser checkout client. Everything here is safe to ship to buyers: the
 * only credential it uses is the intentId your backend created.
 *
 * Payment is non-custodial. IVANA builds the transaction (merchant, VAT,
 * platform fee and supplier legs), the buyer's own wallet signs and
 * broadcasts it, and IVANA verifies the confirmed on-chain balance changes.
 * Neither IVANA nor this SDK can move the buyer's funds.
 */

import { base58Encode } from "./base58.js";
import { IvanaError, normalizeBaseUrl, request } from "./http.js";
import { solanaPayReference, solanaPayUrl } from "./solanaPay.js";

export { IvanaError } from "./http.js";
export { createPayFlow } from "./payFlow.js";
export { solanaPayReference, solanaPayUrl } from "./solanaPay.js";
export { createPendingPaymentStore } from "./pending.js";
export { connectWallet, isMobileBrowser, listWallets, phantomBrowseUrl, solflareBrowseUrl } from "./wallets.js";

const MAX_BLOCKHASH_RETRIES = 2;
const STATUS_POLL_ATTEMPTS = 3;
const STATUS_POLL_DELAY_MS = 800;
const RPC_CONFIRMATION_TIMEOUT_MS = 8000;
const VERIFY_RETRY_DELAYS_MS = [400, 800, 1600];
const LEGACY_PENDING_EXPIRY_MS = 5 * 60_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBlockhashExpired(error) {
  return /blockhash not found|block height exceeded|failed to simulate|simulation failed/i.test(
    error?.message || "",
  );
}

/**
 * The node answered the broadcast with an error, so it refused the
 * transaction and nothing was sent. web3.js throws SendTransactionError for
 * every JSON-RPC error reply and a plain Error for a transport failure (a
 * dropped connection, a timeout), which says nothing about whether the node
 * got the bytes. Matched by shape, not instanceof: an app can bundle a second
 * copy of web3.js, and a refusal's `name` is just "Error".
 * @param {unknown} error
 */
function isNodeRefusal(error) {
  return typeof /** @type {any} */ (error)?.getLogs === "function";
}

function onChainFailure(err) {
  return new IvanaError("The Solana transaction failed on chain. No payment was made.", {
    code: "SOLANA_TRANSACTION_FAILED",
    details: err,
  });
}

async function getBlockhash(connection) {
  try {
    return await connection.getLatestBlockhash("confirmed");
  } catch (error) {
    throw new IvanaError(`Could not reach the Solana RPC, so nothing was sent: ${error?.message || error}`, {
      code: "RPC_UNAVAILABLE",
      cause: error,
    });
  }
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
     * Save `signature` (onSignature fires after the signed attempt is registered
     * and BEFORE the transaction is broadcast, so the service can recover a
     * payment that lands just after checkout expiry). If the page closes
     * before verification, call verifyPayment with it later instead of paying
     * again. If the node then refuses the transaction, onRejected fires:
     * nothing was sent, so drop what you saved and let the buyer retry.
     *
     * @param {{ intentId: string, wallet: { publicKey: unknown, signTransaction: (tx: any) => Promise<any> }, paymentMethod?: "USDC"|"USDT"|"HBX", onSignature?: (signature: string, blockhash: { blockhash: string, lastValidBlockHeight: number }) => void|Promise<void>, onRejected?: () => void, onRetry?: () => void }} input
     * @returns {Promise<{ signature: string, verification: Record<string, unknown> }>}
     */
    async pay({ intentId, wallet, paymentMethod = "USDC", onSignature, onRejected, onRetry }) {
      if (!intentId) throw new IvanaError("pay needs the intentId from your backend.");
      if (typeof wallet?.signTransaction !== "function") {
        throw new IvanaError("The wallet must support signTransaction.", { code: "WALLET_NOT_CONNECTED" });
      }
      const walletAddress = walletAddressOf(wallet);

      // Building uses up the intent, so reach the RPC first: if it is down,
      // fail while the buyer can still retry the same intent.
      let preflightBlockhash = await getBlockhash(connection);

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
        let latestBlockhash;
        try {
          latestBlockhash = await getBlockhash(connection);
        } catch (error) {
          // The intent is built now, so sign with the preflight blockhash
          // rather than strand it. If that is stale, the send is refused as
          // expired and the next attempt refreshes again.
          if (!preflightBlockhash) throw error;
          latestBlockhash = preflightBlockhash;
        }
        preflightBlockhash = undefined;
        transaction.recentBlockhash = latestBlockhash.blockhash;

        // A signed transaction already carries its own signature, so it is
        // known before anything is broadcast.
        let raw;
        let signature;
        try {
          const signed = await wallet.signTransaction(transaction);
          // serialize() also checks the signatures are valid.
          raw = signed.serialize();
          if (!signed.signature) {
            throw new Error("The wallet returned no transaction signature, so nothing was sent.");
          }
          signature = base58Encode(signed.signature);
        } catch (error) {
          if (isBlockhashExpired(error) && attempt < MAX_BLOCKHASH_RETRIES) {
            onRetry?.();
            continue;
          }
          if (error?.code === 4001) {
            throw new IvanaError("The buyer cancelled the transaction.", { code: "USER_REJECTED", cause: error });
          }
          throw new IvanaError(error?.message || "Could not sign the transaction.", {
            code: isBlockhashExpired(error) ? "BLOCKHASH_EXPIRED" : "SEND_FAILED",
            cause: error,
          });
        }

        // Register the exact signed attempt before broadcast. This binds a
        // possible post-checkout-expiry confirmation to a blockhash lease the
        // service saw while the checkout was still open.
        await request(client, "POST", "/webthree/register-payment-attempt", {
          intentId,
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          walletAddress,
          paymentMethod,
        });
        await onSignature?.(signature, latestBlockhash);

        // True when the broadcast's outcome can't be told from here.
        let sendUncertain = false;
        try {
          const returned = await connection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          // Only the signed transaction's own signature is ever reconciled.
          if (returned !== signature) sendUncertain = true;
        } catch (error) {
          if (!isNodeRefusal(error) && !isBlockhashExpired(error)) {
            // A transport failure doesn't prove the node missed the bytes.
            sendUncertain = true;
          } else {
            onRejected?.();
            if (isBlockhashExpired(error) && attempt < MAX_BLOCKHASH_RETRIES) {
              onRetry?.();
              continue;
            }
            throw new IvanaError(error?.message || "The transaction was refused.", {
              code: isBlockhashExpired(error) ? "BLOCKHASH_EXPIRED" : "SEND_FAILED",
              cause: error,
            });
          }
        }

        await confirmSignature(connection, signature, latestBlockhash);
        try {
          const verification = await verifyPayment({ intentId, signature, walletAddress, paymentMethod });
          return { signature, verification };
        } catch (error) {
          // The payment may have been broadcast, so it may still settle. Carry
          // the signature so the caller can retry verification, never re-pay.
          const notVisible = error?.code === "TRANSACTION_NOT_FOUND";
          const pending = new IvanaError(
            notVisible
              ? sendUncertain
                ? "The connection dropped while sending, so the payment may or may not have been sent. Verify it again shortly, and do not pay again until the transaction's last valid block height has passed."
                : "The payment was sent but is not visible on chain yet. Verify it again shortly; do not pay again."
              : error?.message || "The payment was sent but could not be verified yet.",
            { status: error?.status, code: error?.code || "VERIFY_FAILED", details: error?.details, cause: error },
          );
          pending.signature = signature;
          // Once the chain passes this height an unconfirmed transaction can
          // never land, and only then is it safe to let the buyer pay again.
          pending.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
          throw pending;
        }
      }
    },

    /**
     * Settle a payment whose signature you saved, e.g. after the buyer
     * closed the tab mid-checkout. Safe to call more than once.
     */
    verifyPayment,

    /**
     * The `solana:` URL for a QR code that pays this intent with any Solana
     * Pay wallet (see waitForSolanaPayment).
     * @param {string} intentId
     * @param {"USDC"|"USDT"|"HBX"} [paymentMethod]
     */
    solanaPayUrl(intentId, paymentMethod = "USDC") {
      return solanaPayUrl({ intentId, paymentMethod, baseUrl: client.baseUrl });
    },

    /**
     * Wait for the buyer to pay a Solana Pay QR, then verify it with IVANA.
     * Watches the intent's reference key on chain, so it resolves seconds
     * after the wallet's transaction confirms.
     *
     * @param {{ intentId: string, paymentMethod?: "USDC"|"USDT"|"HBX", intervalMs?: number, timeoutMs?: number, signal?: AbortSignal }} options
     * @returns {Promise<{ signature: string, walletAddress: string, verification: Record<string, unknown> }>}
     */
    async waitForSolanaPayment({ intentId, paymentMethod = "USDC", intervalMs = 1500, timeoutMs = 15 * 60_000, signal }) {
      if (!intentId) throw new IvanaError("waitForSolanaPayment needs an intentId.");
      const { PublicKey } = await import("@solana/web3.js");
      const reference = new PublicKey(await solanaPayReference(intentId));
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) throw new IvanaError("Stopped waiting for the payment.", { code: "ABORTED" });
        let found;
        try {
          [found] = await connection.getSignaturesForAddress(reference, { limit: 1 }, "confirmed");
        } catch {
          // A flaky RPC read just means "not yet"; keep watching.
        }
        if (found?.err) {
          throw new IvanaError("The Solana transaction failed on chain. No payment was made.", {
            code: "SOLANA_TRANSACTION_FAILED",
            details: found.err,
          });
        }
        if (found) {
          const transaction = await connection.getTransaction(found.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const message = transaction?.transaction?.message;
          const feePayer = (message?.staticAccountKeys || message?.accountKeys)?.[0];
          if (feePayer) {
            const walletAddress = typeof feePayer === "string" ? feePayer : feePayer.toBase58();
            let verification;
            try {
              verification = await verifyPayment({ intentId, signature: found.signature, walletAddress, paymentMethod });
            } catch (error) {
              // IVANA's reconciler may have settled it first; verify then refuses.
              const intent = await request(client, "GET", `/webthree/payment-intents/${encodeURIComponent(intentId)}`).catch(() => null);
              if (intent?.status !== "completed") throw error;
              verification = { success: true, settledBy: "ivana" };
            }
            return { signature: found.signature, walletAddress, verification };
          }
        }
        if (Date.now() >= deadline) {
          throw new IvanaError("No payment arrived for this QR code in time.", { code: "TIMEOUT" });
        }
        await delay(intervalMs);
      }
    },

    /**
     * Resolve a saved, signed payment before offering "pay" again (after a
     * reload, a closed tab or a dropped connection). Never says a payment
     * failed just because the RPC can't see it yet: it answers "expired" only
     * when the intent is still unpaid, the blockhash has passed its last valid
     * height, and the signature is still absent from transaction history.
     *
     * - "completed": paid and verified; fulfil, and drop the saved record.
     * - "pending": may still land; tell the buyer not to pay again, ask later.
     * - "failed": failed on chain, nothing was paid; drop the record.
     * - "expired": can never land; drop the record and allow a new payment.
     * - "unavailable": IVANA or the RPC couldn't answer; treat as pending.
     *
     * @param {{ intentId: string, signature: string, walletAddress?: string, paymentMethod?: "USDC"|"USDT"|"HBX", lastValidBlockHeight?: number, savedAt?: number }} pending
     * @returns {Promise<"completed"|"pending"|"failed"|"expired"|"unavailable">}
     */
    async recoverPayment(pending) {
      if (!pending?.intentId || !pending?.signature) {
        throw new IvanaError("recoverPayment needs the saved intentId and signature.");
      }
      const intentStatus = async () => {
        try {
          return (await request(client, "GET", `/webthree/payment-intents/${encodeURIComponent(pending.intentId)}`))?.status;
        } catch (error) {
          // IVANA hides an expired unpaid intent with 404; the chain still decides.
          if (error?.status === 404) return "not-found";
          throw error;
        }
      };
      const unpaid = (status) => status === "created" || status === "expired" || status === "not-found";
      try {
        const status = await intentStatus();
        if (status === "completed") return "completed";
        if (!unpaid(status)) return "pending";

        const lookup = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
        const onChain = lookup?.value?.[0];
        if (onChain?.err) return "failed";
        if (onChain?.confirmationStatus === "confirmed" || onChain?.confirmationStatus === "finalized") {
          if (!pending.walletAddress || !pending.paymentMethod) return "pending";
          const verification = await verifyPayment({
            intentId: pending.intentId,
            signature: pending.signature,
            walletAddress: pending.walletAddress,
            paymentMethod: pending.paymentMethod,
          });
          return verification?.success === true ? "completed" : "pending";
        }
        if (onChain) return "pending";

        const lastValid = Number(pending.lastValidBlockHeight);
        const expired = Number.isSafeInteger(lastValid) && lastValid > 0
          ? (await connection.getBlockHeight("finalized")) > lastValid
          // Without a height, wait well past a blockhash's ~60-90 s lifetime.
          : Date.now() - Number(pending.savedAt) >= LEGACY_PENDING_EXPIRY_MS;
        if (!expired) return "pending";

        // Recheck everything after observing expiry before releasing the buyer.
        const transaction = await connection.getTransaction(pending.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (transaction) return "pending";
        const recheck = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
        if (recheck?.value?.[0]) return "pending";
        const finalStatus = await intentStatus();
        if (finalStatus === "completed") return "completed";
        return finalStatus === "created" || finalStatus === "not-found" ? "expired" : "pending";
      } catch {
        // Any failure keeps the buyer protected from paying twice.
        return "unavailable";
      }
    },
  };
}
