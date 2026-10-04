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
