import { Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { base58Encode } from "../src/base58.js";

/** What a wallet's signed transaction carries, and the id the SDK derives from it. */
export const SIGNATURE_BYTES = new Uint8Array(64).fill(7);
export const SIGNATURE = base58Encode(SIGNATURE_BYTES);

export const BUYER = Keypair.generate().publicKey;

/** A real unsigned transaction, serialized the way IVANA's builder returns it. */
export function builtTransactionBase64() {
  const tx = new Transaction({
    feePayer: BUYER,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: Buffer.from("ivana:v2:intent-1", "utf8"),
    }),
  );
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/**
 * Fake fetch keyed by "METHOD /path". Each handler returns [status, body]
 * or a function of the parsed request.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init.method || "GET"} ${path.split("?")[0]}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, path, body, headers: init.headers });
    let handler = routes[key];
    if (Array.isArray(handler) && typeof handler[0] === "function") handler = handler.shift();
    if (!handler) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
    const [status, payload] = typeof handler === "function" ? handler(body, path) : handler;
    return new Response(JSON.stringify(payload), { status });
  };
  return { fetch, calls };
}

export function fakeConnection(overrides = {}) {
  return {
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: 100 }),
    sendRawTransaction: async () => SIGNATURE,
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
    ...overrides,
  };
}

export function fakeWallet(overrides = {}) {
  const signed = [];
  return {
    publicKey: BUYER,
    signed,
    signTransaction: async (tx) => {
      signed.push(tx);
      return { signature: SIGNATURE_BYTES, serialize: () => new Uint8Array([1, 2, 3]) };
    },
    ...overrides,
  };
}
