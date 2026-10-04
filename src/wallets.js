/**
 * Wallet discovery for the buyer's browser. Desktop browsers expose wallets
 * as injected providers. Mobile browsers never do, except inside the wallet's
 * own in-app browser, so there the useful action is to reopen the current
 * page in Phantom or Solflare ("browse" deeplinks), where the provider exists.
 */

/** A phone or tablet browser. iPadOS 13+ reports a Mac user agent with touch. */
export function isMobileBrowser(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  return nav.platform === "MacIntel" && nav.maxTouchPoints > 1;
}

/** Reopen `href` inside Phantom's in-app browser. Both parts are URL-encoded. */
export function phantomBrowseUrl(href) {
  const { origin } = new URL(href);
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}

/** Solflare's equivalent; its path has an extra /v1/ segment. */
export function solflareBrowseUrl(href) {
  const { origin } = new URL(href);
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}

const WALLETS = [
  {
    id: "phantom",
    name: "Phantom",
    downloadUrl: "https://phantom.app/",
    // window.phantom.solana, or window.solana when Phantom is the only wallet.
    getProvider: (win) =>
      (win?.phantom?.solana?.isPhantom && win.phantom.solana) || (win?.solana?.isPhantom && win.solana) || null,
    browseUrl: phantomBrowseUrl,
  },
  {
    id: "solflare",
    name: "Solflare",
    downloadUrl: "https://solflare.com/",
    getProvider: (win) => (win?.solflare?.isSolflare && win.solflare) || null,
    browseUrl: solflareBrowseUrl,
  },
];

/**
 * The supported wallets for this browser.
 *
 * - `installed`: the provider is here; connect it and pay.
 * - `openInAppUrl`: on a mobile browser without the provider, a link that
 *   reopens `href` (default: this page) inside the wallet. Navigate to it.
 * - otherwise offer `downloadUrl`.
 *
 * @param {{ href?: string, window?: any, navigator?: any }} [options]
 */
export function listWallets({ href, window: win = globalThis.window, navigator: nav = globalThis.navigator } = {}) {
  const page = href || win?.location?.href;
  const mobile = isMobileBrowser(nav);
  return WALLETS.map((wallet) => {
    const provider = wallet.getProvider(win);
    return {
      id: wallet.id,
      name: wallet.name,
      provider,
      installed: Boolean(provider),
      openInAppUrl: !provider && mobile && page ? wallet.browseUrl(page) : null,
      downloadUrl: wallet.downloadUrl,
    };
  });
}

/**
 * Connect a provider and return it with a public key, ready for `pay`.
 * @param {{ connect: () => Promise<any>, publicKey?: any }} provider
 */
export async function connectWallet(provider) {
  if (!provider || typeof provider.connect !== "function") {
    throw Object.assign(new Error("That wallet isn't available in this browser."), { code: "WALLET_NOT_CONNECTED" });
  }
  const response = provider.publicKey ? null : await provider.connect();
  const publicKey = provider.publicKey || response?.publicKey;
  if (!publicKey) {
    throw Object.assign(new Error("The wallet didn't share an account."), { code: "WALLET_NOT_CONNECTED" });
  }
  // Call through the provider itself: wallets keep internal state on `this`.
  return { publicKey, signTransaction: (transaction) => provider.signTransaction(transaction) };
}
