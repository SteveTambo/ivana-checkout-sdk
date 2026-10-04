export { IvanaError, PaymentMethod } from "./index.js";
import type { PaymentMethod } from "./index.js";

export interface LineItem {
  title: string;
  /** Net price per unit, before VAT and the platform fee. */
  unitPriceUsdc: number | string;
  quantity: number;
  /** Donations always settle to the merchant in full. */
  type?: "donation";
  isConsignment?: boolean;
  supplierWallet?: string;
}

export interface PaymentIntent {
  /** Hand this to the buyer's browser; it is the only credential checkout needs. */
  intentId: string;
  contractVersion: number;
  expiresAt: string;
  lineItems: LineItem[];
  merchantReference: string | null;
  breakdown: {
    netAmount: number;
    vatAmount: number;
    transactionFee: number;
    total: number;
    currency: "USDC";
    supplierAmounts: Array<{ supplierWallet: string; amount: number }>;
  };
}

export interface SettlementEvent {
  id: string;
  cursor: string;
  createdAt: string;
  type: "payment.completed";
  version: number;
  intentId: string;
  merchantReference: string | null;
  signature: string;
  walletAddress: string;
  paymentMethod: PaymentMethod;
  netAmount: number;
  vatAmount: number;
  transactionFee: number;
  totalAmount: number;
  contractVersion: number;
}

export interface PaymentSettlement {
  intentId: string;
  status: string;
  merchantReference: string | null;
  netAmount: number | null;
  paymentMethod: PaymentMethod | null;
  /** Null until the payment completed. */
  walletAddress: string | null;
  /** Null until the payment completed. */
  signature: string | null;
  hbxRate: number | null;
}

export interface PaymentSetup {
  ready: boolean;
  tenantConfigExists: boolean;
  treasuryWalletConfigured: boolean;
  missing: Array<"wallet_mints_configuration" | "valid_treasury_wallet">;
}

export interface IvanaServer {
  createPaymentIntent(input: {
    customer: { name: string; email: string; [field: string]: unknown };
    lineItems: LineItem[];
    merchantReference?: string;
    idempotencyKey?: string;
    walletAddress?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<PaymentIntent>;
  listSettlementEvents(options?: { after?: string; limit?: number }): Promise<{
    events: SettlementEvent[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  acknowledgeSettlementEvent(eventId: string): Promise<{ acknowledged: true }>;
  settlementHealth(): Promise<{
    contractVersion: number;
    unacknowledgedSettlements: number;
    unresolvedBuiltIntents: number;
    healthy: boolean;
  }>;
  getPaymentSettlement(intentId: string): Promise<PaymentSettlement>;
  getTenant(options?: { includePaymentSetup?: boolean }): Promise<{
    tenant: { id: number | string; slug: string; name?: string };
    paymentSetup?: PaymentSetup;
  }>;
}

export declare function createIvanaServer(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Only for trusted server-side runtimes that define window/document. */
  allowBrowser?: boolean;
}): IvanaServer;

/** Throw from a consumer's `apply` when retrying can never make the event apply. */
export declare class PermanentEventError extends Error {
  name: "PermanentEventError";
  constructor(message: string, options?: { cause?: unknown });
}

export interface SettlementConsumer {
  /** One pass over everything new in the feed. */
  pollOnce(): Promise<{ applied: number; parked: number; hasMore: boolean }>;
  /** Poll on a timer; returns a function that stops it. */
  start(options?: {
    /** Delay after a round that applied events (default 60 s). */
    activeIntervalMs?: number;
    /** Delay after a quiet round, and the cap on failure backoff (default 15 min). */
    idleIntervalMs?: number;
    onError?: (error: unknown) => unknown;
  }): () => void;
}

/**
 * The fulfilment loop: apply each settlement event in order, acknowledge it,
 * then save the cursor. `apply` must be idempotent (key orders on intentId).
 * After `parkAfter` consecutive permanent failures an event is skipped
 * without being acknowledged, so it stays in IVANA for a person to resolve.
 */
export declare function createSettlementConsumer(options: {
  server: Pick<IvanaServer, "listSettlementEvents" | "acknowledgeSettlementEvent">;
  apply: (event: SettlementEvent) => unknown | Promise<unknown>;
  loadCursor: () => string | null | undefined | Promise<string | null | undefined>;
  saveCursor: (cursor: string) => unknown | Promise<unknown>;
  /** Defaults to `error instanceof PermanentEventError`. */
  isPermanent?: (error: unknown) => boolean;
  onParked?: (event: SettlementEvent, error: unknown) => unknown;
  /** Consecutive permanent failures before an event is parked (default 3). */
  parkAfter?: number;
  pageSize?: number;
  maxPages?: number;
}): SettlementConsumer;

