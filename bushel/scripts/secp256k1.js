#!/usr/bin/env node
'use strict';

/**
 * secp256k1 — pure BigInt, zero dependencies.
 *
 * Node's crypto can sign with secp256k1, but only emits DER signatures with no recovery
 * id. `ecrecover` needs (v, r, s). So the curve is here in full: keygen, address
 * derivation, RFC 6979 deterministic signing with recovery id and low-s normalisation,
 * and public-key recovery — the exact operation the contract's `ecrecover` performs.
 *
 * Affine arithmetic with a modular inverse per point op. That is the slow way to do this
 * and completely fine: a hunt signs a handful of digests, not a mempool's worth.
 *
 * Deterministic signing (RFC 6979) rather than a random nonce, for two reasons: nonce
 * reuse leaks the private key outright — the failure that emptied the PS3 and several
 * early Bitcoin wallets — and determinism makes the test suite reproducible.
 */

const crypto = require('node:crypto');
const { keccak256 } = require('./keccak');

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
const HALF_N = N >> 1n;

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const mod = (a, m) => { const r = a % m; return r >= 0n ? r : r + m; };

function invMod(a, m) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('not invertible');
  return mod(s0, m);
}

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Curve arithmetic. `null` is the point at infinity.
// ---------------------------------------------------------------------------

function double(Pt) {
  if (!Pt || Pt.y === 0n) return null;
  const lam = mod(3n * Pt.x * Pt.x * invMod(2n * Pt.y, P), P);
  const x = mod(lam * lam - 2n * Pt.x, P);
  return { x, y: mod(lam * (Pt.x - x) - Pt.y, P) };
}

function add(A, B) {
  if (!A) return B;
  if (!B) return A;
  if (A.x === B.x) {
    if (mod(A.y + B.y, P) === 0n) return null;
    return double(A);
  }
  const lam = mod((B.y - A.y) * invMod(B.x - A.x, P), P);
  const x = mod(lam * lam - A.x - B.x, P);
  return { x, y: mod(lam * (A.x - x) - A.y, P) };
}

function mul(k, Pt) {
  let acc = null;
  let cur = Pt;
  let e = mod(k, N);
  while (e > 0n) {
    if (e & 1n) acc = add(acc, cur);
    cur = double(cur);
    e >>= 1n;
  }
  return acc;
}

function onCurve(Pt) {
  return mod(Pt.y * Pt.y, P) === mod(Pt.x * Pt.x * Pt.x + 7n, P);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const stripHex = (h) => String(h).replace(/^0x/i, '');
const toBig = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'));
const hexToBuf = (h) => Buffer.from(stripHex(h), 'hex');
const big32 = (v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
const hex32 = (v) => '0x' + v.toString(16).padStart(64, '0');

// ---------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------

/** Fresh puzzle key from the OS CSPRNG. This is what a real hunt must use. */
function newPrivateKey() {
  for (;;) {
    const d = toBig(crypto.randomBytes(32));
    if (d > 0n && d < N) return hex32(d);
  }
}

function publicKey(privHex) {
  const d = toBig(hexToBuf(privHex));
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  return mul(d, G);
}

/** Ethereum address: last 20 bytes of keccak256(uncompressed pubkey, x||y). */
function pointToAddress(Pt) {
  const digest = keccak256(Buffer.concat([big32(Pt.x), big32(Pt.y)]));
  return toChecksumAddress('0x' + digest.subarray(12).toString('hex'));
}

const addressOf = (privHex) => pointToAddress(publicKey(privHex));

/** EIP-55 mixed-case checksum. Cosmetic, but it is how every explorer prints an address. */
function toChecksumAddress(addr) {
  const lower = stripHex(addr).toLowerCase();
  const hash = keccak256(Buffer.from(lower, 'utf8')).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

const sameAddress = (a, b) => stripHex(a).toLowerCase() === stripHex(b).toLowerCase();

// ---------------------------------------------------------------------------
// RFC 6979 deterministic nonce
// ---------------------------------------------------------------------------

const hmac = (key, ...data) =>
  crypto.createHmac('sha256', key).update(Buffer.concat(data)).digest();

function deterministicNonce(d, digest, extra = 0) {
  const x = big32(d);
  const z = toBig(digest);
  const h1 = big32(z >= N ? z - N : z);

  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  const bump = Buffer.alloc(extra); // varies the stream if a candidate is rejected

  k = hmac(k, v, Buffer.from([0]), x, h1, bump);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([1]), x, h1, bump);
  v = hmac(k, v);

  for (;;) {
    v = hmac(k, v);
    const candidate = toBig(v);
    if (candidate >= 1n && candidate < N) return candidate;
    k = hmac(k, v, Buffer.from([0]));
    v = hmac(k, v);
  }
}

// ---------------------------------------------------------------------------
// Sign / recover
// ---------------------------------------------------------------------------

/**
 * Sign a 32-byte digest. Returns {v, r, s} in the exact shape the contract's `claim`
 * takes: v is 27/28, and s is always in the lower half of the curve order so the
 * contract's malleability guard accepts it.
 */
function sign(privHex, digest) {
  const d = toBig(hexToBuf(privHex));
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const z = toBig(digest);

  for (let attempt = 0; attempt < 16; attempt++) {
    const k = deterministicNonce(d, digest, attempt);
    const R = mul(k, G);
    const r = mod(R.x, N);
    if (r === 0n) continue;

    let s = mod(invMod(k, N) * (z + r * d), N);
    if (s === 0n) continue;

    let recid = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
    if (s > HALF_N) {
      s = N - s;
      recid ^= 1; // flipping s mirrors R over the x-axis
    }
    return { v: recid + 27, r: hex32(r), s: hex32(s) };
  }
  throw new Error('failed to produce a signature');
}

/**
 * Recover the signer address from a digest and signature — byte for byte what the EVM's
 * `ecrecover` precompile does, including its rejection cases. Returns null on failure,
 * matching the precompile's address(0).
 */
function recover(digest, v, rHex, sHex) {
  const recid = Number(v) - 27;
  if (recid < 0 || recid > 3) return null;

  const r = toBig(hexToBuf(rHex));
  const s = toBig(hexToBuf(sHex));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;

  const x = r + (recid >= 2 ? N : 0n);
  if (x >= P) return null;

  const ySq = mod(x * x * x + 7n, P);
  let y = powMod(ySq, (P + 1n) / 4n, P); // p = 3 mod 4, so this is the square root
  if (mod(y * y, P) !== ySq) return null; // x was not on the curve
  if ((y & 1n) !== BigInt(recid & 1)) y = P - y;

  const R = { x, y };
  if (!onCurve(R)) return null;

  const z = toBig(digest);
  const rInv = invMod(r, N);
  const Q = add(mul(mod(-z * rInv, N), G), mul(mod(s * rInv, N), R));
  if (!Q) return null;
  return pointToAddress(Q);
}

/** True iff a signature is one the contract would accept from `expectedSigner`. */
function verify(digest, sig, expectedSigner) {
  if (toBig(hexToBuf(sig.s)) > HALF_N) return false; // contract rejects malleable upper-half s
  if (sig.v !== 27 && sig.v !== 28) return false;
  const got = recover(digest, sig.v, sig.r, sig.s);
  return got !== null && sameAddress(got, expectedSigner);
}

module.exports = {
  N, P, G, HALF_N,
  newPrivateKey, publicKey, addressOf, pointToAddress, toChecksumAddress, sameAddress,
  sign, recover, verify,
  mod, invMod, powMod, add, double, mul, onCurve,
  toBig, hexToBuf, big32, hex32, stripHex,
};

if (require.main === module) {
  const key = newPrivateKey();
  console.log('private key :', key);
  console.log('address     :', addressOf(key));
  console.log('\nThis key is the prize. Whoever reconstructs it can claim.');
}
