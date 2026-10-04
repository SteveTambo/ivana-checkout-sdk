/**
 * The whole buyer-side checkout as a small state machine, for any UI: find a
 * wallet (or the "open in wallet" link on mobile), connect, pay, and resolve a
 * payment left unconfirmed by a reload before ever offering "pay" again.
 * `@habix/ivana-checkout/react` wraps it as a hook and a button.
 *
 * States, in `getState().status`:
 *   "checking"   resolving a saved payment for this intent (see recover)
 *   "idle"       ready to pay
 *   "choosing"   the buyer is picking a wallet (`wallets` is filled)
 *   "paying"     wallet prompt open, or the payment is confirming
 *   "pending"    sent, outcome not known yet: do NOT offer to pay again
 *   "paid"       verified (`result` holds the signature and verification)
 *   "error"      nothing was paid; `error` says why and paying again is safe
 */

import { createPendingPaymentStore } from "./pending.js";
import { connectWallet, listWallets } from "./wallets.js";

/**
 * @param {{
 *   checkout: ReturnType<typeof import("./checkout.js").createIvanaCheckout>,
 *   intentId: string,
 *   paymentMethod?: "USDC"|"USDT"|"HBX",
 *   store?: ReturnType<typeof createPendingPaymentStore>,
 *   href?: string,
 *   onPaid?: (result: { signature: string, verification: Record<string, unknown> }) => unknown,
 *   listWallets?: typeof listWallets,
 * }} options
 */
export function createPayFlow({
  checkout,
  intentId,
  paymentMethod = "USDC",
  store = createPendingPaymentStore(),
  href,
  onPaid,
  listWallets: discover = listWallets,
}) {
  if (!checkout || !intentId) throw new Error("createPayFlow needs a checkout and an intentId.");

  let state = { status: "idle", wallets: [], error: null, result: null, signature: null };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const paid = async (result) => {
    store.clear(intentId);
    set({ status: "paid", result, signature: result.signature, error: null });
    await onPaid?.(result);
  };

  /**
   * Resolve a payment this browser signed for the intent earlier. Call on
   * page load; it does nothing when there is none.
   */
  async function recover() {
    const saved = store.get(intentId);
    if (!saved) return state;
    set({ status: "checking", signature: saved.signature });
    const outcome = await checkout.recoverPayment(saved);
    if (outcome === "completed") {
      await paid({ signature: saved.signature, verification: { success: true, recovered: true } });
    } else if (outcome === "failed" || outcome === "expired") {
      store.clear(intentId, saved.signature);
      set({ status: "idle", signature: null });
    } else {
      set({ status: "pending" });
    }
    return state;
  }

  /** Show the wallet choices. */
  function choose() {
    if (state.status === "paying" || state.status === "pending" || state.status === "paid") return state;
    set({ status: "choosing", wallets: discover({ href }), error: null });
    return state;
  }

  /** Back to "idle" from choosing or an error. */
  function cancel() {
    if (state.status === "choosing" || state.status === "error") set({ status: "idle", error: null });
    return state;
  }

  /**
   * Pay with an installed wallet from `wallets` (or any provider object).
   * @param {string | { connect: Function, signTransaction: Function, publicKey?: any }} walletOrProvider
   */
  async function pay(walletOrProvider) {
    if (state.status === "paying" || state.status === "pending" || state.status === "paid") return state;
    const provider =
      typeof walletOrProvider === "string"
        ? (state.wallets.length ? state.wallets : discover({ href })).find((w) => w.id === walletOrProvider)?.provider
        : walletOrProvider;
    set({ status: "paying", error: null });
    let wallet;
    try {
      wallet = await connectWallet(provider);
    } catch (error) {
      set({ status: "error", error: friendly(error) });
      return state;
    }
    const walletAddress = typeof wallet.publicKey === "string" ? wallet.publicKey : wallet.publicKey.toBase58();
    try {
      const result = await checkout.pay({
        intentId,
        wallet,
        paymentMethod,
        onSignature: (signature, blockhash) => {
          store.save({ intentId, signature, walletAddress, paymentMethod, lastValidBlockHeight: blockhash?.lastValidBlockHeight });
          set({ signature });
        },
        onRejected: () => {
          store.clear(intentId);
          set({ signature: null });
        },
      });
      await paid(result);
    } catch (error) {
      // A signature means it may have been broadcast: never invite a second payment.
      if (error?.signature) set({ status: "pending", signature: error.signature, error: friendly(error) });
      else set({ status: "error", error: friendly(error) });
    }
    return state;
  }

  return {
    getState: () => state,
    /** @param {(state: typeof state) => void} listener @returns {() => void} */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover,
    choose,
    cancel,
    pay,
  };
}

/** A message a buyer can act on, keeping the original code. */
function friendly(error) {
  const code = error?.code === 4001 ? "USER_REJECTED" : error?.code;
  const messages = {
    USER_REJECTED: "You cancelled in your wallet. Nothing was paid.",
    WALLET_NOT_CONNECTED: "Connect a wallet to pay.",
    BLOCKHASH_EXPIRED: "The approval took too long. Nothing was paid; please try again.",
    RPC_UNAVAILABLE: "Couldn't reach the Solana network. Nothing was paid; please try again.",
    SOLANA_TRANSACTION_FAILED: "The transaction failed on chain. Nothing was paid.",
  };
  return { code: code || "PAYMENT_FAILED", message: messages[code] || error?.message || "The payment didn't go through." };
}
