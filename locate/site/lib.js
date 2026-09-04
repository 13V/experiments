'use strict';
/**
 * Locate browser library. No dependencies.
 *
 * keccak256, a minimal static-ABI encoder/decoder, JSON-RPC over fetch, revert-reason
 * decoding, and number formatting. Same pattern as site/lib.js in this repo: every call
 * Locate makes (Morpho, the IRM, the oracles, the router, the vaults, ERC-20) takes and
 * returns only statically-sized words, so the encoder never needs offsets or dynamic
 * decoding — except for revert reasons, which arrive as `Error(string)`.
 */
(function (global) {
  // ---------------------------------------------------------------------------
  // keccak256 (BigInt lanes; fine for hashing signatures and a handful of words)
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
  const isHexish = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]*$/.test(v);
  const hexToBytes = (h) => {
    const s = strip(h);
    const out = new Uint8Array(Math.ceil(s.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2) || '0', 16);
    return out;
  };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  /** 32-byte big-endian word from a bigint, number, boolean, hex/address string, or bytes. */
  function word(v) {
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'bigint' || typeof v === 'number') {
      let b = BigInt(v);
      if (b < 0n) b = (1n << 256n) + b; // two's complement, not that we ever send a negative
      return hexToBytes(b.toString(16).padStart(64, '0'));
    }
    const b = v instanceof Uint8Array ? v : hexToBytes(v);
    if (b.length > 32) throw new Error('word overflow: ' + v);
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  }
  const toBig = (w) => BigInt(bytesToHex(w));
  const toAddrRaw = (w) => bytesToHex(w.subarray(12));
  /** EIP-55 checksum casing, purely cosmetic (comparisons in this file are always lower-case). */
  function toChecksum(addr) {
    const a = strip(addr).toLowerCase();
    const h = bytesToHex(keccak256(a)).slice(2);
    let out = '0x';
    for (let i = 0; i < a.length; i++) {
      out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
    }
    return out;
  }
  const toAddr = (w) => toChecksum(toAddrRaw(w));
  const sameAddr = (a, b) => !!a && !!b && strip(a).toLowerCase() === strip(b).toLowerCase();
  const words = (data) => {
    const b = typeof data === 'string' ? hexToBytes(data) : data;
    const out = [];
    for (let i = 0; i + 32 <= b.length; i += 32) out.push(b.subarray(i, i + 32));
    return out;
  };

  // ---------------------------------------------------------------------------
  // ABI — every function Locate calls takes and returns only statically-sized
  // values, so an argument is either one word, or (for MarketParams / Market
  // structs) a flat array of words spliced in place. No offsets, ever.
  // ---------------------------------------------------------------------------
  const selector = (sig) => keccak256(sig).subarray(0, 4);
  function flatten(args, out = []) {
    for (const a of args) {
      if (Array.isArray(a)) flatten(a, out);
      else out.push(a);
    }
    return out;
  }
  /** encodeCall('openShort((address,address,address,address,uint256),uint256,uint256,address)', mp, coll, borrow, receiver) */
  const encodeCall = (sig, ...args) => bytesToHex(concat(selector(sig), ...flatten(args).map(word)));
  /** Read back N static words starting at `data` (0x-prefixed hex from eth_call). */
  const decodeWords = (data) => words(data);

  /** MarketParams as the flat tuple Morpho and the router expect. */
  const marketParamsTuple = (mp) => [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv];
  /** keccak256(abi.encode(MarketParams)) — the Morpho market Id. */
  function marketId(mp) {
    const enc = concat(word(mp.loanToken), word(mp.collateralToken), word(mp.oracle), word(mp.irm), word(mp.lltv));
    return bytesToHex(keccak256(enc));
  }

  // ---------------------------------------------------------------------------
  // Revert decoding: LocateRouter/LocateVault's parameterless custom errors, Solidity's
  // Error(string) and Panic(uint256) — Morpho Blue's own reverts are plain require(string)
  // (e.g. "not authorized", "insufficient liquidity"), which arrive as Error(string) too.
  // ---------------------------------------------------------------------------
  const ERROR_STRING_SEL = bytesToHex(selector('Error(string)'));
  const PANIC_SEL = bytesToHex(selector('Panic(uint256)'));
  // The full parameterless-error surface of LocateRouter.sol and LocateVault.sol (both take no
  // args, so each is just its own 4-byte selector with no payload to decode).
  const CUSTOM_ERRORS = [
    'Reentrancy()', 'TransferFailed()', 'ZeroAmount()', // LocateRouter
    'NotOwner()', 'ZeroAddress()', 'ZeroAssets()', 'ZeroShares()', 'FeeTooHigh()',
    'InsufficientBalance()', 'InsufficientAllowance()', 'InsufficientLiquidity()',
    'LoanTokenMismatch()', 'MarketNotOnMorpho()', 'UnknownMarket()', 'MarketInUse()', 'CapExceeded()', // LocateVault
  ];
  const customErrorSelectors = new Map(CUSTOM_ERRORS.map((sig) => [bytesToHex(selector(sig)), sig.slice(0, -2)]));
  const PANIC_CODES = {
    0x01: 'assertion failed', 0x11: 'arithmetic overflow', 0x12: 'division by zero',
    0x21: 'invalid enum value', 0x22: 'invalid storage byte array', 0x31: 'pop on empty array',
    0x32: 'out-of-bounds array access', 0x41: 'out of memory', 0x51: 'call to uninitialized function',
  };
  function decodeABIString(dataAfterSelector) {
    try {
      const w = words(dataAfterSelector);
      const len = Number(toBig(w[1]));
      const bytes = hexToBytes(dataAfterSelector).subarray(64, 64 + len);
      return new TextDecoder().decode(bytes);
    } catch { return null; }
  }
  /** hex revert data -> human string, or null if `data` is empty/unrecognised. */
  function decodeRevert(data) {
    if (!data || data === '0x') return null;
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === ERROR_STRING_SEL) return decodeABIString('0x' + data.slice(10)) || 'reverted';
    if (sel === PANIC_SEL) {
      const code = Number(toBig(words('0x' + data.slice(10))[0]));
      return `panic: ${PANIC_CODES[code] || '0x' + code.toString(16)}`;
    }
    if (customErrorSelectors.has(sel)) return customErrorSelectors.get(sel);
    return `reverted (selector ${sel})`;
  }
  /** Wallets (MetaMask, WalletConnect, etc.) nest revert data differently. Try the common shapes. */
  function extractRevertData(err) {
    const tryPaths = [
      (e) => e?.data,
      (e) => e?.data?.data,
      (e) => e?.data?.originalError?.data,
      (e) => e?.error?.data,
      (e) => e?.cause?.data,
      (e) => e?.info?.error?.data,
    ];
    for (const get of tryPaths) {
      try {
        const v = get(err);
        if (typeof v === 'string' && isHexish(v) && v.length > 2) return v;
      } catch { /* keep trying */ }
    }
    return null;
  }
  /** Best-effort human message for anything thrown by a wallet or an RPC call. */
  function describeError(err) {
    const data = extractRevertData(err);
    const decoded = data ? decodeRevert(data) : null;
    if (decoded) return decoded;
    if (err?.code === 4001) return 'rejected in wallet';
    const msg = err?.shortMessage || err?.reason || err?.message || String(err);
    return msg.length > 180 ? msg.slice(0, 180) + '…' : msg;
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC over fetch (reads), the injected wallet (writes)
  // ---------------------------------------------------------------------------
  let rpcId = 1;
  async function rpc(url, method, params = []) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  }
  const ethCall = (rpcUrl, to, data) => rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest']);

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  /** raw token units (bigint/number/hex) -> trimmed decimal string. */
  function fmtToken(raw, decimals, maxFrac = 6) {
    let b = typeof raw === 'bigint' ? raw : BigInt(raw);
    const neg = b < 0n;
    if (neg) b = -b;
    const s = b.toString().padStart(decimals + 1, '0');
    const int = s.slice(0, s.length - decimals) || '0';
    let frac = s.slice(s.length - decimals).replace(/0+$/, '');
    if (frac.length > maxFrac) frac = frac.slice(0, maxFrac);
    const intGrouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + (frac ? `${intGrouped}.${frac}` : intGrouped);
  }
  /** human decimal string -> raw bigint at `decimals`, or null if unparsable. */
  function parseAmount(str, decimals) {
    if (typeof str !== 'string') return null;
    const s = str.trim();
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > decimals) {
      // truncate rather than round — never send more than the user typed
      return BigInt((intPart || '0') + fracPart.slice(0, decimals));
    }
    return BigInt((intPart || '0') + fracPart.padEnd(decimals, '0'));
  }
  const fmtUsd = (n, dp = 2) => {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };
  const fmtPct = (n, dp = 2) => (n === null || n === undefined || !isFinite(n)) ? '—' : (n * 100).toFixed(dp) + '%';
  const fmtNum = (n, dp = 2) => (n === null || n === undefined || !isFinite(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  /** WAD (1e18-scaled) health factor bigint -> "1.42" or "∞" when there is no borrow. */
  function fmtHf(hfWad) {
    if (hfWad === null || hfWad === undefined) return '—';
    const b = typeof hfWad === 'bigint' ? hfWad : BigInt(hfWad);
    if (b > (1n << 200n)) return '∞'; // router returns a sentinel-large value when borrowAssets == 0
    return (Number(b) / 1e18).toFixed(3);
  }

  global.LOC = {
    keccak256, hexToBytes, bytesToHex, concat, word, toBig, toAddr, toAddrRaw, toChecksum, sameAddr, words,
    selector, encodeCall, decodeWords, marketParamsTuple, marketId,
    decodeRevert, extractRevertData, describeError,
    rpc, ethCall,
    fmtToken, parseAmount, fmtUsd, fmtPct, fmtNum, shortAddr, fmtHf,
  };
})(window);
