#!/usr/bin/env node
'use strict';

/**
 * keccak256 — pure JavaScript, zero dependencies.
 *
 * Node's crypto has SHA3-256 but NOT keccak256. They are the same permutation with
 * different padding (0x06 vs 0x01), so SHA3-256 is not a substitute: it produces a
 * completely different digest. Ethereum addresses are keccak256, so we need the real
 * thing to derive the `puzzleSigner` address the contract stores.
 *
 * Correctness is anchored on published vectors in scripts/test.js:
 *   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
 *   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
 * and, end to end, on privkey 0x..01 deriving 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
 *
 * BigInt lanes: slower than a typed-array implementation, and irrelevant here — we hash
 * a few dozen values, not a blockchain.
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed [x][y].
const R = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

/** Keccak-f[1600] on a 5x5 array of 64-bit lanes, in place. */
function permute(A) {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];

    // rho + pi
    const B = [new Array(5), new Array(5), new Array(5), new Array(5), new Array(5)];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], R[x][y]);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & MASK) & B[(x + 2) % 5][y]);
      }
    }

    // iota
    A[0][0] ^= RC[round];
  }
}

/**
 * keccak256 of a Buffer. Rate 136 bytes, capacity 64, original Keccak padding (0x01 .. 0x80).
 * @param {Buffer|Uint8Array|string} input
 * @returns {Buffer} 32 bytes
 */
function keccak256(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input, typeof input === 'string' ? 'utf8' : undefined);
  const RATE = 136;

  // Pad: 0x01, zeros, final byte |= 0x80. When one byte remains, both land on it.
  const padLen = RATE - (msg.length % RATE);
  const padded = Buffer.concat([msg, Buffer.alloc(padLen)]);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = [
    [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n],
    [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n],
  ];

  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      const lane = padded.readBigUInt64LE(off + i * 8);
      A[i % 5][Math.floor(i / 5)] ^= lane;
    }
    permute(A);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(A[i % 5][Math.floor(i / 5)], i * 8);
  }
  return out;
}

const keccak256Hex = (input) => '0x' + keccak256(input).toString('hex');

module.exports = { keccak256, keccak256Hex };

if (require.main === module) {
  const arg = process.argv.slice(2).join(' ');
  console.log(keccak256Hex(arg));
}
