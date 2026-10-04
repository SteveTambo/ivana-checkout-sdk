import { test } from "node:test";
import assert from "node:assert/strict";
import { createSettlementConsumer, PermanentEventError } from "../src/server.js";

// A tenant feed of `events`, served after a cursor like IVANA's, that
// records acknowledgements.
function feed(events, { pageSize = 100 } = {}) {
  const acked = [];
  const server = {
    async listSettlementEvents({ after, limit = pageSize }) {
      const start = after ? events.findIndex((e) => e.cursor === after) + 1 : 0;
      const page = events.slice(start, start + Math.min(limit, pageSize));
      return { events: page, nextCursor: page.at(-1)?.cursor ?? after ?? null, hasMore: start + page.length < events.length };
    },
    async acknowledgeSettlementEvent(id) {
      acked.push(id);
      return { acknowledged: true };
    },
  };
  return { server, acked };
}

function store() {
  let cursor = null;
  return { loadCursor: () => cursor, saveCursor: (c) => { cursor = c; }, cursor: () => cursor };
}

const events = ["a", "b", "c"].map((id, i) => ({ id, cursor: `c${i + 1}`, type: "payment.completed", intentId: `intent-${id}` }));

test("applies events in order, acknowledges each, then saves its cursor", async () => {
  const { server, acked } = feed(events);
  const cursorStore = store();
  const applied = [];
  const consumer = createSettlementConsumer({ server, apply: (e) => applied.push(e.id), ...cursorStore });

  assert.deepEqual(await consumer.pollOnce(), { applied: 3, parked: 0, hasMore: false });
  assert.deepEqual(applied, ["a", "b", "c"]);
  assert.deepEqual(acked, ["a", "b", "c"]);
  assert.equal(cursorStore.cursor(), "c3");
  assert.deepEqual(await consumer.pollOnce(), { applied: 0, parked: 0, hasMore: false });
});

test("a transient failure stops the round without acknowledging, and the event is retried", async () => {
  const { server, acked } = feed(events);
  const cursorStore = store();
  let down = true;
  const consumer = createSettlementConsumer({
    server,
    ...cursorStore,
    apply: (e) => { if (e.id === "b" && down) throw new Error("database unavailable"); },
  });

  await assert.rejects(consumer.pollOnce(), /database unavailable/);
  assert.deepEqual(acked, ["a"]);
  assert.equal(cursorStore.cursor(), "c1");
  for (let i = 0; i < 5; i += 1) await assert.rejects(consumer.pollOnce());
  assert.equal(cursorStore.cursor(), "c1", "transient failures never park");

  down = false;
  await consumer.pollOnce();
  assert.deepEqual(acked, ["a", "b", "c"]);
});

test("an event that keeps failing permanently is parked unacknowledged so later payments still settle", async () => {
  const { server, acked } = feed(events);
  const cursorStore = store();
  const parkedEvents = [];
  const consumer = createSettlementConsumer({
    server,
    ...cursorStore,
    apply: (e) => { if (e.id === "b") throw new PermanentEventError("amount does not match the order"); },
    onParked: (e) => parkedEvents.push(e.id),
  });

  await assert.rejects(consumer.pollOnce(), PermanentEventError);
  await assert.rejects(consumer.pollOnce(), PermanentEventError);
  assert.equal(cursorStore.cursor(), "c1");
  assert.deepEqual(await consumer.pollOnce(), { applied: 1, parked: 1, hasMore: false });

  assert.deepEqual(parkedEvents, ["b"]);
  assert.deepEqual(acked, ["a", "c"], "the parked event stays unacknowledged in IVANA");
  assert.equal(cursorStore.cursor(), "c3");
});

test("an event that recovers before it is parked settles normally", async () => {
  const { server, acked } = feed(events);
  let failures = 1;
  const consumer = createSettlementConsumer({
    server,
    ...store(),
    apply: (e) => { if (e.id === "b" && failures-- > 0) throw new PermanentEventError("refused"); },
  });

  await assert.rejects(consumer.pollOnce());
  await consumer.pollOnce();
  assert.deepEqual(acked, ["a", "b", "c"]);
});

test("a custom isPermanent can classify your own errors", async () => {
  const { server, acked } = feed(events);
  const consumer = createSettlementConsumer({
    server,
    ...store(),
    parkAfter: 1,
    isPermanent: (error) => error?.status === 409,
    apply: (e) => { if (e.id === "a") throw Object.assign(new Error("conflict"), { status: 409 }); },
  });

  assert.deepEqual(await consumer.pollOnce(), { applied: 2, parked: 1, hasMore: false });
  assert.deepEqual(acked, ["b", "c"]);
});

test("pages through a long feed and reports when more remains", async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, cursor: `c${i}` }));
  const { server, acked } = feed(many, { pageSize: 2 });
  const consumer = createSettlementConsumer({ server, ...store(), apply: () => {}, pageSize: 2, maxPages: 3 });

  assert.deepEqual(await consumer.pollOnce(), { applied: 6, parked: 0, hasMore: true });
  assert.deepEqual(await consumer.pollOnce(), { applied: 1, parked: 0, hasMore: false });
  assert.equal(acked.length, 7);
});

test("overlapping polls don't apply an event twice", async () => {
  const { server } = feed(events);
  let calls = 0;
  const consumer = createSettlementConsumer({
    server,
    ...store(),
    apply: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); },
  });

  await Promise.all([consumer.pollOnce(), consumer.pollOnce()]);
  assert.equal(calls, 3);
});

test("start polls on a timer and stops cleanly", async () => {
  const { server, acked } = feed(events);
  const consumer = createSettlementConsumer({ server, ...store(), apply: () => {} });
  const stop = consumer.start({ activeIntervalMs: 10, idleIntervalMs: 20 });
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(acked, ["a", "b", "c"]);
});

test("rejects a missing server or callbacks up front", () => {
  assert.throws(() => createSettlementConsumer({ apply() {}, loadCursor() {}, saveCursor() {} }), /createIvanaServer/);
  assert.throws(() => createSettlementConsumer({ server: feed([]).server, loadCursor() {}, saveCursor() {} }), /apply/);
});
