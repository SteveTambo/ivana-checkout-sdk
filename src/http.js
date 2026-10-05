/**
 * Shared HTTP plumbing for both entry points. IVANA returns errors as
 * `{ error: { message, code?, ... } }`; this turns them into IvanaError.
 */

export const DEFAULT_BASE_URL = "https://ivanaservertenant.onrender.com/api";

export class IvanaError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, details?: unknown, cause?: unknown }} [info]
   */
  constructor(message, { status, code, details, cause } = {}) {
    super(message);
    this.name = "IvanaError";
    /** HTTP status, when the error came from the API. */
    this.status = status;
    /** Machine-readable code, e.g. TRANSACTION_NOT_FOUND or SOLANA_TRANSACTION_FAILED. */
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

/** @param {string|undefined} baseUrl */
export function normalizeBaseUrl(baseUrl) {
  const url = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new IvanaError(`baseUrl must be an http(s) URL, got "${baseUrl}".`, { code: "INVALID_CONFIG" });
  }
  return url;
}

/**
 * @param {{ baseUrl: string, fetch: typeof fetch, headers?: Record<string, string>, timeoutMs?: number }} client
 * @param {"GET"|"POST"} method
 * @param {string} path
 * @param {unknown} [body]
 */
export async function request(client, method, path, body) {
  const controller = new AbortController();
  // One deadline for the whole exchange, body included: a server that sends
  // headers and then stalls must time out too.
  const timer = setTimeout(() => controller.abort(), client.timeoutMs ?? 20000);
  const timedOut = (cause) =>
    new IvanaError("IVANA did not respond in time.", { code: "TIMEOUT", cause });
  // Each wait is raced against the abort, because a fetch (or a stand-in for
  // one) that ignores the signal would otherwise leave this waiting forever.
  const guarded = (promise) => {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(timedOut());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() =>
      controller.signal.removeEventListener("abort", onAbort),
    );
  };
  let response;
  let text;
  try {
    try {
      response = await guarded(
        client.fetch(`${client.baseUrl}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...client.headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        }),
      );
    } catch (cause) {
      if (cause instanceof IvanaError) throw cause;
      if (controller.signal.aborted) throw timedOut(cause);
      throw new IvanaError("Could not reach IVANA.", { code: "NETWORK_ERROR", cause });
    }
    try {
      text = await guarded(response.text());
    } catch (cause) {
      if (cause instanceof IvanaError) throw cause;
      if (controller.signal.aborted) throw timedOut(cause);
      throw new IvanaError("The response from IVANA was cut off.", { code: "NETWORK_ERROR", cause });
    }
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  let unparseable = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      unparseable = true;
    }
  }

  if (!response.ok) {
    const error = data?.error;
    throw new IvanaError(
      error?.message || `IVANA request failed with HTTP ${response.status}.`,
      {
        status: response.status,
        code: error?.code || error?.details?.code,
        details: error,
      },
    );
  }
  // A success that isn't JSON is a proxy or gateway page, not an answer:
  // returning null would let callers read it as "nothing to report".
  if (unparseable) {
    throw new IvanaError("IVANA returned a response that is not JSON.", {
      status: response.status,
      code: "INVALID_RESPONSE",
    });
  }
  return data;
}
