/**
 * Base58 (Bitcoin alphabet), the encoding Solana uses for signatures and
 * addresses. The SDK needs it to name a signed transaction's own signature
 * before the transaction is broadcast, and a dependency-free encoder keeps the
 * browser bundle small. Encoding only; the SDK never decodes.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** @param {Uint8Array} bytes */
export function base58Encode(bytes) {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;

  // Base-256 to base-58 by repeated division, no BigInt needed.
  const digits = [];
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}
