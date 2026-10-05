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
  /**
   * Resolve a saved, signed payment before offering "pay" again. "expired"
   * only when the intent is unpaid, the blockhash has passed its last valid
   * height and the signature is absent from history; "unavailable" when IVANA
   * or the RPC couldn't answer (treat as pending).
   */
  recoverPayment(pending: PendingPayment): Promise<"completed" | "pending" | "failed" | "expired" | "unavailable">;
  /** The `solana:` URL for a QR code that pays this intent with any Solana Pay wallet. */
  solanaPayUrl(intentId: string, paymentMethod?: PaymentMethod): string;
  /**
   * Wait for the buyer's wallet to pay the intent's Solana Pay QR, then verify
   * it with IVANA. Rejects with code TIMEOUT, ABORTED or SOLANA_TRANSACTION_FAILED.
   */
  waitForSolanaPayment(options: {
    intentId: string;
    paymentMethod?: PaymentMethod;
    /** Fixed wait between RPC checks. Default: 2 s for the first minute, 5 s until 5 minutes, then 10 s. */
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ signature: string; walletAddress: string; verification: Record<string, unknown> }>;
}

export declare function createIvanaCheckout(options: {
  connection: Connection;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  Transaction?: typeof Transaction;
}): IvanaCheckout;

export interface PendingPayment {
  intentId: string;
  signature: string;
  walletAddress?: string;
  paymentMethod?: PaymentMethod;
  /** After this block height the transaction can never land. */
  lastValidBlockHeight?: number;
  savedAt?: number;
}

export interface PendingPaymentStore {
  get(intentId: string): PendingPayment | null;
  save(payment: PendingPayment): void;
  /** With `signature`, clears only if the saved record is still that one. */
  clear(intentId: string, signature?: string): void;
}

/** Per-tab by default (sessionStorage). Pass `storage: null` to disable. */
export declare function createPendingPaymentStore(options?: {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  prefix?: string;
}): PendingPaymentStore;

export interface WalletOption {
  id: "phantom" | "solflare";
  name: string;
  /** The injected provider, when installed in this browser. */
  provider: unknown;
  installed: boolean;
  /** On a mobile browser without the wallet: reopens the page inside it. */
  openInAppUrl: string | null;
  downloadUrl: string;
}

export declare function listWallets(options?: { href?: string; window?: unknown; navigator?: unknown }): WalletOption[];
export declare function connectWallet(provider: unknown): Promise<CheckoutWallet>;
export declare function isMobileBrowser(navigator?: unknown): boolean;
export declare function phantomBrowseUrl(href: string): string;
export declare function solflareBrowseUrl(href: string): string;

export type PayFlowStatus = "checking" | "idle" | "choosing" | "paying" | "pending" | "paid" | "error";

export interface PayFlowState {
  status: PayFlowStatus;
  wallets: WalletOption[];
  /** Set in "error" (nothing was paid) and sometimes in "pending". */
  error: { code: string; message: string } | null;
  result: { signature: string; verification: Record<string, unknown> } | null;
  signature: string | null;
}

export interface PayFlow {
  getState(): PayFlowState;
  subscribe(listener: (state: PayFlowState) => void): () => void;
  /** Resolve a payment this browser signed earlier; call on page load. */
  recover(): Promise<PayFlowState>;
  choose(): PayFlowState;
  cancel(): PayFlowState;
  /** A wallet id from `wallets`, or any provider object. */
  pay(walletOrProvider: string | unknown): Promise<PayFlowState>;
}

/** The buyer-side checkout as a state machine, for any UI. */
export declare function createPayFlow(options: {
  checkout: IvanaCheckout;
  intentId: string;
  paymentMethod?: PaymentMethod;
  store?: PendingPaymentStore;
  /** The page to reopen inside a mobile wallet; defaults to the current URL. */
  href?: string;
  onPaid?: (result: { signature: string; verification: Record<string, unknown> }) => unknown;
}): PayFlow;

/** The read-only reference key IVANA adds to a Solana Pay payment for this intent (base58). */
export declare function solanaPayReference(intentId: string): Promise<string>;
/** The `solana:` transaction-request URL for an intent. */
export declare function solanaPayUrl(options: { intentId: string; paymentMethod?: PaymentMethod; baseUrl?: string }): string;

/** Milliseconds a Solana Pay wait sleeps between RPC checks after waiting `elapsedMs`: 2 s, then 5 s after a minute, then 10 s after five. */
export function solanaPayPollDelay(elapsedMs: number): number;
