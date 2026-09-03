'use strict';
/**
 * Stonk Packs browser library. No dependencies.
 * keccak256, minimal ABI helpers, JSON-RPC, and a byte-exact mirror of the contract's
 * randomness so a pack can be verified in the browser.
 */
(function (global) {
  // ---------------------------------------------------------------------------
  // keccak256 (BigInt lanes; we hash a handful of values, not a chain)
  // ---------------------------------------------------------------------------
  const MASK = (1n << 64n) - 1n;
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const R = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
  function permute(A) {
    for (let round = 0; round < 24; round++) {
      const C = new Array(5);
      for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
      const D = new Array(5);
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B = [new Array(5), new Array(5), new Array(5), new Array(5), new Array(5)];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], R[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & MASK) & B[(x + 2) % 5][y]);
      A[0][0] ^= RC[round];
    }
  }
  /** @param {Uint8Array|string} input bytes, or a utf8 string */
  function keccak256(input) {
    const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const RATE = 136;
    const padLen = RATE - (msg.length % RATE);
    const padded = new Uint8Array(msg.length + padLen);
    padded.set(msg);
    padded[msg.length] = 0x01;
    padded[padded.length - 1] |= 0x80;
    const A = [[0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]];
    const dv = new DataView(padded.buffer);
    for (let off = 0; off < padded.length; off += RATE) {
      for (let i = 0; i < RATE / 8; i++) A[i % 5][Math.floor(i / 5)] ^= dv.getBigUint64(off + i * 8, true);
      permute(A);
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) odv.setBigUint64(i * 8, A[i % 5][Math.floor(i / 5)], true);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Bytes and words
  // ---------------------------------------------------------------------------
  const strip = (h) => String(h).replace(/^0x/i, '');
  const hexToBytes = (h) => {
    const s = strip(h);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  /** 32-byte big-endian word from a bigint, number, boolean, hex string or bytes. */
  function word(v) {
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'bigint' || typeof v === 'number') {
      let b = BigInt(v);
      if (b < 0n) b = (1n << 256n) + b;
      return hexToBytes(b.toString(16).padStart(64, '0'));
    }
    const b = v instanceof Uint8Array ? v : hexToBytes(v);
    if (b.length > 32) throw new Error('word overflow');
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  }
  const toBig = (w) => BigInt(bytesToHex(w));
  const toAddr = (w) => bytesToHex(w.subarray(12));
  const words = (data) => {
    const b = typeof data === 'string' ? hexToBytes(data) : data;
    const out = [];
    for (let i = 0; i + 32 <= b.length; i += 32) out.push(b.subarray(i, i + 32));
    return out;
  };
  const randomBytes32 = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return bytesToHex(b); };

  // ---------------------------------------------------------------------------
  // ABI (static arguments only; that is all the contract surface we call)
  // ---------------------------------------------------------------------------
  const selector = (sig) => keccak256(sig).subarray(0, 4);
  const topic = (sig) => bytesToHex(keccak256(sig));
  const encodeCall = (sig, ...args) => bytesToHex(concat(selector(sig), ...args.map(word)));
  /** Decode `tier(uint8)`: (uint32 weight, uint64 usdCents, address[] tokens). */
  function decodeTier(data) {
    const w = words(data);
    const weight = Number(toBig(w[0]));
    const usdCents = Number(toBig(w[1]));
    const off = Number(toBig(w[2])) / 32;
    const n = Number(toBig(w[off]));
    const tokens = [];
    for (let i = 0; i < n; i++) tokens.push(toAddr(w[off + 1 + i]));
    return { weight, usdCents, tokens };
  }

  const EVENTS = {
    Bought: topic('Bought(uint256,address,bytes32,uint256)'),
    Opened: topic('Opened(uint256,address,bytes32,bytes32,bool)'),
    Pull: topic('Pull(uint256,uint8,uint8,address,uint256,uint64,bool)'),
    Refunded: topic('Refunded(uint256,address,uint256)'),
    Owed: topic('Owed(uint256,address,uint256)'),
  };
  const topicWord = (v) => bytesToHex(word(v));
  function decodeLog(log) {
    const t0 = log.topics[0];
    const d = words(log.data);
    if (t0 === EVENTS.Bought) return { name: 'Bought', packId: toBig(hexToBytes(log.topics[1])), buyer: toAddr(hexToBytes(log.topics[2])), buyerSeed: bytesToHex(d[0]), price: toBig(d[1]) };
    if (t0 === EVENTS.Opened) return { name: 'Opened', packId: toBig(hexToBytes(log.topics[1])), to: toAddr(hexToBytes(log.topics[2])), randomness: bytesToHex(d[0]), blockHash: bytesToHex(d[1]), late: toBig(d[2]) === 1n };
    if (t0 === EVENTS.Pull) return { name: 'Pull', packId: toBig(hexToBytes(log.topics[1])), index: Number(toBig(d[0])), tier: Number(toBig(d[1])), token: toAddr(d[2]), amount: toBig(d[3]), usdCents: Number(toBig(d[4])), cash: toBig(d[5]) === 1n };
    if (t0 === EVENTS.Refunded) return { name: 'Refunded', packId: toBig(hexToBytes(log.topics[1])), holder: toAddr(hexToBytes(log.topics[2])), amount: toBig(d[0]) };
    if (t0 === EVENTS.Owed) return { name: 'Owed', packId: toBig(hexToBytes(log.topics[1])), who: toAddr(hexToBytes(log.topics[2])), amount: toBig(d[0]) };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Randomness mirror: keccak(abi.encode(seed, buyerSeed, packId, blockHash)), then per pull
  // keccak(abi.encode(randomness, i)), tier by weight, token by keccak(abi.encode(rand, "token")).
  // ---------------------------------------------------------------------------
  const packRandomness = (seed, buyerSeed, packId, blockHash) => keccak256(concat(word(seed), word(buyerSeed), word(BigInt(packId)), word(blockHash)));
  function pickTier(rand, tiers) {
    const total = tiers.reduce((s, t) => s + t.weight, 0);
    const roll = Number(toBig(rand) % BigInt(total));
    let acc = 0;
    for (let i = 0; i < tiers.length; i++) { acc += tiers[i].weight; if (roll < acc) return i; }
    return tiers.length - 1;
  }
  function pickToken(rand, tier) {
    const enc = concat(word(rand), word(0x40), word(5), concat(new TextEncoder().encode('token'), new Uint8Array(27)));
    return Number(toBig(keccak256(enc)) % BigInt(tier.tokens.length));
  }
  /** @returns [{index, tier, tokenIndex}] */
  function pullsFrom(randomness, pulls, tiers) {
    const out = [];
    for (let i = 0; i < pulls; i++) {
      const r = keccak256(concat(word(randomness), word(i)));
      const t = pickTier(r, tiers);
      out.push({ index: i, tier: t, tokenIndex: pickToken(r, tiers[t]) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC over fetch (reads) and the injected wallet (writes)
  // ---------------------------------------------------------------------------
  let rpcId = 1;
  async function rpc(url, method, params = []) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const fmtUsd = (cents) => '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtAmount(raw, decimals, maxFrac = 4) {
    const s = BigInt(raw).toString().padStart(decimals + 1, '0');
    const int = s.slice(0, s.length - decimals);
    let frac = s.slice(s.length - decimals).replace(/0+$/, '');
    if (frac.length > maxFrac) frac = frac.slice(0, maxFrac);
    return frac ? `${int}.${frac}` : int;
  }
  const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

  global.SP = { keccak256, hexToBytes, bytesToHex, concat, word, toBig, toAddr, words, randomBytes32, selector, topic, topicWord, encodeCall, decodeTier, EVENTS, decodeLog, packRandomness, pickTier, pickToken, pullsFrom, rpc, fmtUsd, fmtAmount, shortAddr };
})(window);
