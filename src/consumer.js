/**
 * Settlement consumer: the fulfilment loop every merchant backend needs, done
 * once. It reads the tenant's settlement feed in order, hands each event to
 * your `apply`, acknowledges it, then saves the cursor, so a crash at any
 * point replays the event instead of losing it. `apply` must therefore be
 * idempotent: key your order on `event.intentId`.
 *
 * One event that can never apply would otherwise hold back every later
 * payment. Throw `PermanentEventError` from `apply` for those (the payment
 * conflicts with your records, the product is gone); after `parkAfter`
 * consecutive permanent failures the consumer moves past the event WITHOUT
 * acknowledging it, so it stays unacknowledged in IVANA for a person to
 * resolve, and calls `onParked`. Any other error (your database is down, the
 * network failed) stops the round and the event is retried next time.
 */

import { IvanaError } from "./http.js";

/** Throw from `apply` when retrying can never make this event apply. */
export class PermanentEventError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "PermanentEventError";
  }
}

const DEFAULTS = {
  parkAfter: 3,
  pageSize: 100,
  maxPages: 5,
  activeIntervalMs: 60_000,
  idleIntervalMs: 15 * 60_000,
};

/**
 * @param {{
 *   server: { listSettlementEvents: Function, acknowledgeSettlementEvent: Function },
 *   apply: (event: Record<string, any>) => unknown | Promise<unknown>,
 *   loadCursor: () => string | null | undefined | Promise<string | null | undefined>,
 *   saveCursor: (cursor: string) => unknown | Promise<unknown>,
 *   isPermanent?: (error: unknown) => boolean,
 *   onParked?: (event: Record<string, any>, error: unknown) => unknown,
 *   parkAfter?: number,
 *   pageSize?: number,
 *   maxPages?: number,
 * }} options
 */
export function createSettlementConsumer({
  server,
  apply,
  loadCursor,
  saveCursor,
  isPermanent = (error) => error instanceof PermanentEventError,
  onParked,
  parkAfter = DEFAULTS.parkAfter,
  pageSize = DEFAULTS.pageSize,
  maxPages = DEFAULTS.maxPages,
}) {
  if (typeof server?.listSettlementEvents !== "function") {
    throw new IvanaError("createSettlementConsumer needs the client from createIvanaServer as `server`.");
  }
  for (const [name, fn] of Object.entries({ apply, loadCursor, saveCursor })) {
    if (typeof fn !== "function") throw new IvanaError(`createSettlementConsumer needs a ${name} function.`);
  }
  if (!(Number.isInteger(parkAfter) && parkAfter >= 1)) {
    throw new IvanaError("parkAfter must be a whole number of at least 1.");
  }

  /** Consecutive permanent failures per event id, for parking. */
  const failures = new Map();
  let running = false;

  /**
   * One pass over everything new in the feed.
   * @returns {Promise<{ applied: number, parked: number, hasMore: boolean }>}
   */
  async function pollOnce() {
    if (running) return { applied: 0, parked: 0, hasMore: false };
    running = true;
    try {
      let cursor = (await loadCursor()) || undefined;
      let applied = 0;
      let parked = 0;
      let hasMore = false;
      for (let page = 0; page < maxPages; page += 1) {
        const body = await server.listSettlementEvents({ after: cursor, limit: pageSize });
        const events = Array.isArray(body?.events) ? body.events : [];
        for (const event of events) {
          if (typeof event?.cursor !== "string" || !event.id) {
            throw new IvanaError("A settlement event arrived without an id or cursor.");
          }
          try {
            await apply(event);
            failures.delete(event.id);
          } catch (error) {
            if (!isPermanent(error)) throw error;
            const attempts = (failures.get(event.id) || 0) + 1;
            if (attempts < parkAfter) {
              failures.set(event.id, attempts);
              throw error;
            }
            failures.delete(event.id);
            await saveCursor(event.cursor);
            cursor = event.cursor;
            parked += 1;
            await onParked?.(event, error);
            continue;
          }
          await server.acknowledgeSettlementEvent(event.id);
          await saveCursor(event.cursor);
          cursor = event.cursor;
          applied += 1;
        }
        hasMore = Boolean(body?.hasMore) && events.length > 0;
        if (!hasMore) break;
      }
      return { applied, parked, hasMore };
    } finally {
      running = false;
    }
  }

  /**
   * Poll on a timer: quickly while payments are arriving, slowly when the
   * feed is quiet, and with growing delays after failures.
   *
   * @param {{ activeIntervalMs?: number, idleIntervalMs?: number, onError?: (error: unknown) => unknown }} [options]
   * @returns {() => void} Call to stop.
   */
  function start({
    activeIntervalMs = DEFAULTS.activeIntervalMs,
    idleIntervalMs = DEFAULTS.idleIntervalMs,
    onError,
  } = {}) {
    let stopped = false;
    let timer;
    let consecutiveErrors = 0;
    const schedule = (delay) => {
      if (stopped) return;
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };
    const tick = async () => {
      let delay = idleIntervalMs;
      try {
        const result = await pollOnce();
        consecutiveErrors = 0;
        if (result.hasMore) delay = 0;
        else if (result.applied || result.parked) delay = activeIntervalMs;
      } catch (error) {
        consecutiveErrors += 1;
        delay = Math.min(idleIntervalMs, activeIntervalMs * 2 ** consecutiveErrors);
        await onError?.(error);
      }
      schedule(delay);
    };
    schedule(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  return { pollOnce, start };
}
