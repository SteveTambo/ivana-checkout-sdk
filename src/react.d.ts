import type { Connection } from "@solana/web3.js";
import type { IvanaCheckout, PaymentMethod, PayFlow, PayFlowState } from "./index.js";

export interface IvanaPaymentOptions {
  intentId: string;
  /** Used to create a checkout client when `checkout` isn't given. */
  connection?: Connection;
  checkout?: IvanaCheckout;
  baseUrl?: string;
  paymentMethod?: PaymentMethod;
  onPaid?: (result: { signature: string; verification: Record<string, unknown> }) => unknown;
  /** The page to reopen inside a mobile wallet; defaults to the current URL. */
  href?: string;
}

export declare function useIvanaPayment(
  options: IvanaPaymentOptions,
): PayFlowState & Pick<PayFlow, "choose" | "cancel" | "pay" | "recover">;

/** Drop-in pay button with wallet picker and payment recovery. Unstyled: target the `ivana-pay*` classes. */
export declare function IvanaPayButton(
  props: IvanaPaymentOptions & { label?: string; className?: string },
): ReturnType<typeof import("react").createElement>;

export interface SolanaPaymentState {
  url: string;
  status: "waiting" | "paid" | "error";
  signature: string | null;
  error: { code: string; message?: string } | null;
}

export declare function useSolanaPayment(
  options: Omit<IvanaPaymentOptions, "href"> & { timeoutMs?: number },
): SolanaPaymentState;

/** Solana Pay QR for in-person payment. Draw the code with `renderQr`, e.g. `(url) => <QRCodeSVG value={url} />`. */
export declare function SolanaPayQR(
  props: Omit<IvanaPaymentOptions, "href"> & { timeoutMs?: number; renderQr?: (url: string) => unknown; className?: string },
): ReturnType<typeof import("react").createElement>;

