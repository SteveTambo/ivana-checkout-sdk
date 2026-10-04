/**
 * React bindings: `useIvanaPayment` for your own UI, and `IvanaPayButton`,
 * a drop-in pay button with wallet picker, mobile "Open in Phantom/Solflare"
 * links and recovery of a payment interrupted by a reload. Unstyled: style the
 * `ivana-pay*` class names, or build your own UI on the hook.
 *
 * Written with createElement so the package needs no build step. React 18 or
 * newer is an optional peer dependency, needed only for this entry point.
 */

import { createElement as h, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createIvanaCheckout } from "./checkout.js";
import { createPayFlow } from "./payFlow.js";

/**
 * @param {{
 *   intentId: string,
 *   connection?: import("@solana/web3.js").Connection,
 *   checkout?: ReturnType<typeof createIvanaCheckout>,
 *   baseUrl?: string,
 *   paymentMethod?: "USDC"|"USDT"|"HBX",
 *   onPaid?: (result: { signature: string, verification: Record<string, unknown> }) => unknown,
 *   href?: string,
 * }} options
 */
export function useIvanaPayment({ intentId, connection, checkout, baseUrl, paymentMethod = "USDC", onPaid, href }) {
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  const client = useMemo(
    () => checkout || createIvanaCheckout({ connection, baseUrl }),
    [checkout, connection, baseUrl],
  );
  const flow = useMemo(
    () => createPayFlow({ checkout: client, intentId, paymentMethod, href, onPaid: (result) => onPaidRef.current?.(result) }),
    [client, intentId, paymentMethod, href],
  );
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);

  // Resolve a payment this tab signed earlier before offering "pay" again.
  useEffect(() => {
    void flow.recover();
  }, [flow]);

  return { ...state, choose: flow.choose, cancel: flow.cancel, pay: flow.pay, recover: flow.recover };
}

const shortSignature = (signature) => (signature ? `${signature.slice(0, 6)}…${signature.slice(-6)}` : "");

/**
 * Drop-in pay button. Takes the same options as `useIvanaPayment`, plus
 * `label` and `className`.
 *
 * @param {Parameters<typeof useIvanaPayment>[0] & { label?: string, className?: string }} props
 */
export function IvanaPayButton({ label, className, ...options }) {
  const payment = useIvanaPayment(options);
  const method = options.paymentMethod || "USDC";
  const root = (children) => h("div", { className: ["ivana-pay", className].filter(Boolean).join(" ") }, ...children);
  const button = (text, onClick, extra = {}) =>
    h("button", { type: "button", className: "ivana-pay__button", onClick, ...extra }, text);
  const message = (text, role = "status") => h("p", { className: "ivana-pay__message", role }, text);

  switch (payment.status) {
    case "checking":
      return root([message("Checking a payment you already started…")]);
    case "paying":
      return root([button("Confirm in your wallet…", undefined, { disabled: true, "aria-busy": true })]);
    case "pending":
      return root([
        message(
          `Your payment (${shortSignature(payment.signature)}) was sent and is still confirming. Don't pay again.`,
        ),
        button("Check again", () => payment.recover()),
      ]);
    case "paid":
      return root([message(`Paid. Transaction ${shortSignature(payment.signature)}.`)]);
    case "choosing":
      return root([
        h(
          "ul",
          { className: "ivana-pay__wallets", "aria-label": "Choose a wallet" },
          ...payment.wallets.map((wallet) =>
            h(
              "li",
              { key: wallet.id, className: "ivana-pay__wallet" },
              wallet.installed
                ? button(wallet.name, () => payment.pay(wallet.id))
                : wallet.openInAppUrl
                  ? h("a", { href: wallet.openInAppUrl, className: "ivana-pay__link" }, `Open in ${wallet.name}`)
                  : h(
                      "a",
                      { href: wallet.downloadUrl, target: "_blank", rel: "noopener noreferrer", className: "ivana-pay__link" },
                      `Get ${wallet.name}`,
                    ),
            ),
          ),
        ),
        button("Cancel", () => payment.cancel(), { className: "ivana-pay__cancel" }),
      ]);
    default:
      return root([
        payment.error ? message(payment.error.message, "alert") : null,
        button(label || `Pay with ${method}`, () => payment.choose()),
      ]);
  }
}
