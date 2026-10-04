import type { Connection, Transaction } from "@solana/web3.js";

export type PaymentMethod = "USDC" | "USDT" | "HBX";

export declare class IvanaError extends Error {
  name: "IvanaError";
  /** HTTP status, when the error came from the API. */
  status?: number;
  /** e.g. TRANSACTION_NOT_FOUND, SOLANA_TRANSACTION_FAILED, USER_REJECTED, VERIFY_FAILED, SEND_FAILED, RPC_UNAVAILABLE. */
  code?: string;
  details?: unknown;
  /**
   * Set when the payment may have been broadcast: verify it again, never
   * re-pay while the transaction can still land.
   */
  signature?: string;
  /**
   * With `signature`: the chain height after which that transaction can never
   * land. Until `connection.getBlockHeight()` passes it, don't let the buyer
   * pay again.
   */
  lastValidBlockHeight?: number;
}

export interface CheckoutWallet {
  publicKey: { toBase58(): string } | string | null;
  signTransaction(transaction: Transaction): Promise<Transaction | { serialize(): Uint8Array }>;
}

export interface PublicPaymentIntent {
  intentId: string;
  contractVersion: number;
  status: string;
  lineItems: unknown[];
  netAmount: number;
  vatAmount: number;
  transactionFee: number;
  total: number;
  merchantReference: string | null;
  expiresAt: string;
}

export interface VerifyPaymentInput {
  intentId: string;
  signature: string;
  walletAddress: string;
  paymentMethod: PaymentMethod;
}

export interface IvanaCheckout {
  getPaymentIntent(intentId: string): Promise<PublicPaymentIntent>;
  checkEligibility(input: { intentId: string; walletAddress: string }): Promise<{ eligible: boolean; unavailable: boolean }>;
  pay(input: {
    intentId: string;
    wallet: CheckoutWallet;
    paymentMethod?: PaymentMethod;
    /** Fires after the wallet signs and BEFORE the transaction is broadcast. */
    onSignature?: (signature: string, blockhash: { blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
    /** The node refused the transaction, so nothing was sent: drop the saved signature. */
    onRejected?: () => void;
    onRetry?: () => void;
  }): Promise<{ signature: string; verification: Record<string, unknown> }>;
  verifyPayment(input: VerifyPaymentInput): Promise<Record<string, unknown>>;
}

export declare function createIvanaCheckout(options: {
  connection: Connection;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  Transaction?: typeof Transaction;
}): IvanaCheckout;
