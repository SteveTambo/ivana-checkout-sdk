// Browser side, bundled with your storefront (Vite, webpack, etc.). Uses the
// buyer's Phantom wallet; any wallet with signTransaction works.

import { Connection } from "@solana/web3.js";
import { createIvanaCheckout } from "@habix/ivana-checkout";

const checkout = createIvanaCheckout({
  // Your own RPC endpoint is recommended for production.
  connection: new Connection("https://api.mainnet-beta.solana.com", "confirmed"),
});

export async function buy(productId, quantity, customer) {
  const wallet = window.phantom?.solana;
  if (!wallet) throw new Error("Install Phantom to pay.");
  await wallet.connect();

  // 1. Your backend prices the order and creates the intent.
  const response = await fetch("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, quantity, ...customer }),
  });
  const { intentId } = await response.json();

  // 2. Optional AML pre-check, for a friendlier message before signing.
  const { eligible } = await checkout.checkEligibility({
    intentId,
    walletAddress: wallet.publicKey.toBase58(),
  });
  if (!eligible) throw new Error("This wallet can't be used for payment.");

  // 3. One signature pays the merchant, VAT, the platform fee and any
  //    supplier, straight from the buyer's wallet.
  try {
    const { signature } = await checkout.pay({
      intentId,
      wallet,
      paymentMethod: "USDC",
      onSignature: (sig) => localStorage.setItem(`ivana:${intentId}`, sig),
      onRejected: () => localStorage.removeItem(`ivana:${intentId}`),
    });
    localStorage.removeItem(`ivana:${intentId}`);
    return signature;
  } catch (error) {
    if (error.signature) {
      // May have been broadcast: tell the buyer not to pay again, and retry
      // checkout.verifyPayment later with the saved signature.
    }
    throw error;
  }
}
