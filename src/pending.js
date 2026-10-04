/**
 * Remembers a payment that was signed but not yet confirmed, so a reload or a
 * closed tab can resolve it before the buyer is ever offered "pay" again.
 * Records hold an intent id, a transaction signature and the payer's public
 * address: nothing secret, but kept per tab by default (sessionStorage).
 */

/**
 * @typedef {object} PendingPayment
 * @property {string} intentId
 * @property {string} signature
 * @property {string} walletAddress
 * @property {"USDC"|"USDT"|"HBX"} paymentMethod
 * @property {number} [lastValidBlockHeight] After this height the transaction can never land.
 * @property {number} [savedAt]
 */

/**
 * @param {{ storage?: Pick<Storage, "getItem"|"setItem"|"removeItem"> | null, prefix?: string }} [options]
 */
export function createPendingPaymentStore({ storage, prefix = "ivana:pending:" } = {}) {
  const store = () => {
    if (storage !== undefined) return storage;
    try {
      return globalThis.sessionStorage ?? null;
    } catch {
      return null; // Some browsers throw when storage is disabled.
    }
  };
  const key = (intentId) => `${prefix}${intentId}`;
  return {
    /** @param {string} intentId @returns {PendingPayment|null} */
    get(intentId) {
      try {
        const raw = store()?.getItem(key(intentId));
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    /** @param {PendingPayment} payment */
    save(payment) {
      try {
        store()?.setItem(key(payment.intentId), JSON.stringify({ ...payment, savedAt: Date.now() }));
      } catch {
        // Storage may be full or disabled; the page that's open still verifies.
      }
    },
    /**
     * Forget the intent's record; with `signature`, only if it is still that one.
     * @param {string} intentId @param {string} [signature]
     */
    clear(intentId, signature) {
      try {
        if (signature && this.get(intentId)?.signature !== signature) return;
        store()?.removeItem(key(intentId));
      } catch {
        // Storage may be disabled.
      }
    },
  };
}
