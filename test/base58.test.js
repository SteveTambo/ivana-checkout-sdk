import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { base58Encode } from "../src/base58.js";

const bytes = (text) => new TextEncoder().encode(text);

test("matches the published Base58 test vectors", () => {
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.equal(base58Encode(bytes("a")), "2g");
  assert.equal(base58Encode(bytes("bbb")), "a3gV");
  assert.equal(base58Encode(bytes("ccc")), "aPEr");
  assert.equal(base58Encode(bytes("Hello World!")), "2NEpo7TZRRrLZSi2U");
  assert.equal(
    base58Encode(bytes("The quick brown fox jumps over the lazy dog.")),
    "USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z",
  );
});

test("keeps leading zero bytes as leading 1s", () => {
  assert.equal(base58Encode(new Uint8Array(32)), "1".repeat(32));
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
  assert.equal(base58Encode(new Uint8Array([0, 0x61])), "12g");
});

test("agrees with the bs58 package on random 64-byte signatures", () => {
  const bs58 = createRequire(import.meta.url)("bs58");
  const reference = bs58.encode || bs58.default.encode;
  for (let i = 0; i < 300; i += 1) {
    const signature = new Uint8Array(64).map((_, j) => (i % 7 === 0 && j < 3 ? 0 : Math.floor(Math.random() * 256)));
    assert.equal(base58Encode(signature), reference(signature));
  }
});
