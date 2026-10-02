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
    throw new IvanaError(`baseUrl must be an http(s) URL, got "${baseUrl}".`);
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
  const timer = setTimeout(() => controller.abort(), client.timeoutMs ?? 20000);
  let response;
  try {
    response = await client.fetch(`${client.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...client.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new IvanaError(
      controller.signal.aborted ? "IVANA did not respond in time." : "Could not reach IVANA.",
      { code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", cause },
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
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
  return data;
}
